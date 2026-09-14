// SFTP over already-open SSH connections: browsing, file operations and transfers.
// Every transfer job opens its own SFTP channel, so cancelling one never disturbs the file browser
// or other transfers — ending that channel aborts its in-flight fastGet/fastPut.
const fs = require('fs');
const path = require('path');
const rpath = path.posix;

const WIN_BAD_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// Remote names become local file names: keep them inside the destination and valid on Windows.
function safeLocalName(name) {
  let n = String(name).replace(WIN_BAD_CHARS, '_').replace(/[. ]+$/, '');
  if (!n || n === '.' || n === '..') n = '_';
  if (WIN_RESERVED.test(n)) n = '_' + n;
  return n;
}
function uniqueLocalPath(dir, name, reserved) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  const taken = (p) => fs.existsSync(p) || (reserved && reserved.has(p.toLowerCase()));
  let candidate = path.join(dir, name);
  for (let i = 1; taken(candidate); i++) candidate = path.join(dir, base + ' (' + i + ')' + ext);
  if (reserved) reserved.add(candidate.toLowerCase());
  return candidate;
}
function permString(mode) {
  const type = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  const bits = ['r', 'w', 'x'];
  let s = type;
  for (let i = 8; i >= 0; i--) s += mode & (1 << i) ? bits[(8 - i) % 3] : '-';
  return s;
}
const promisify = (fn) => new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))));

function sftpErrorMessage(err) {
  const code = err && err.code;
  const msg = (err && err.message) || String(err);
  if (code === 2 || /No such file/i.test(msg)) return 'Файл или папка не найдены';
  if (code === 3 || /Permission denied/i.test(msg)) return 'Нет прав доступа';
  if (code === 4 && /not empty/i.test(msg)) return 'Папка не пуста';
  if (/Unable to start subsystem|subsystem request failed/i.test(msg)) return 'SFTP отключён на сервере';
  return msg;
}

module.exports = function registerSftp({ ipcMain, dialog, shell, app, getConnection, sendToRenderer, logError, getWindow }) {
  const browsers = new Map(); // connId -> SFTPWrapper used for listing and file operations
  const jobs = new Map(); // jobId -> { connId, sftp, canceled, currentLocal, direction }

  function openChannel(connId) {
    const entry = getConnection(connId);
    if (!entry) return Promise.reject(new Error('SSH-сессия не подключена'));
    return promisify((cb) => entry.conn.sftp(cb)).catch((e) => { throw new Error(sftpErrorMessage(e)); });
  }
  async function browser(connId) {
    let sftp = browsers.get(connId);
    if (sftp) return sftp;
    sftp = await openChannel(connId);
    browsers.set(connId, sftp);
    sftp.on('close', () => { if (browsers.get(connId) === sftp) browsers.delete(connId); });
    return sftp;
  }
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, args) => {
    try {
      return { ok: true, ...(await fn(args || {})) };
    } catch (e) {
      return { ok: false, error: sftpErrorMessage(e) };
    }
  });

  async function statFollow(sftp, full, attrs) {
    if (!attrs.isSymbolicLink()) return { dir: attrs.isDirectory(), link: false, size: attrs.size, mtime: attrs.mtime };
    try {
      const target = await promisify((cb) => sftp.stat(full, cb));
      return { dir: target.isDirectory(), link: true, size: target.size, mtime: target.mtime };
    } catch {
      return { dir: false, link: true, broken: true, size: 0, mtime: attrs.mtime };
    }
  }

  handle('sftp:home', async ({ connId }) => {
    const sftp = await browser(connId);
    return { path: await promisify((cb) => sftp.realpath('.', cb)) };
  });

  handle('sftp:list', async ({ connId, dir }) => {
    const sftp = await browser(connId);
    const real = await promisify((cb) => sftp.realpath(dir || '.', cb));
    const list = await promisify((cb) => sftp.readdir(real, cb));
    const entries = await Promise.all(list.map(async (item) => {
      const full = rpath.join(real, item.filename);
      const info = await statFollow(sftp, full, item.attrs);
      return { name: item.filename, path: full, dir: info.dir, link: info.link, broken: !!info.broken,
        size: info.dir ? 0 : info.size, mtime: info.mtime * 1000, perms: permString(item.attrs.mode) };
    }));
    return { path: real, entries };
  });

  handle('sftp:mkdir', async ({ connId, dir }) => {
    const sftp = await browser(connId);
    await promisify((cb) => sftp.mkdir(dir, cb));
    return {};
  });

  handle('sftp:rename', async ({ connId, from, to }) => {
    const sftp = await browser(connId);
    await promisify((cb) => sftp.rename(from, to, cb));
    return {};
  });

  async function removeRecursive(sftp, target) {
    const attrs = await promisify((cb) => sftp.lstat(target, cb));
    if (!attrs.isDirectory()) {
      await promisify((cb) => sftp.unlink(target, cb));
      return 1;
    }
    let count = 0;
    for (const item of await promisify((cb) => sftp.readdir(target, cb))) {
      count += await removeRecursive(sftp, rpath.join(target, item.filename));
    }
    await promisify((cb) => sftp.rmdir(target, cb));
    return count + 1;
  }
  handle('sftp:delete', async ({ connId, paths }) => {
    const sftp = await browser(connId);
    let removed = 0;
    for (const p of paths || []) {
      if (!p || p === '/' ) throw new Error('Удаление корня запрещено');
      removed += await removeRecursive(sftp, p);
    }
    return { removed };
  });

  handle('sftp:pick-upload', async ({ folders }) => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: folders ? 'Загрузить папку на сервер' : 'Загрузить файлы на сервер',
      properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    return { paths: result.canceled ? [] : result.filePaths };
  });

  handle('sftp:pick-download-dir', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Куда сохранить',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: app.getPath('downloads'),
    });
    return { dir: result.canceled || !result.filePaths.length ? null : result.filePaths[0] };
  });

  ipcMain.on('sftp:show-local', (event, { file }) => { if (file) shell.showItemInFolder(file); });

  /* ---- transfers ---- */
  function emit(job, patch) {
    Object.assign(job.state, patch);
    sendToRenderer('sftp:transfer', { ...job.state });
  }
  function progressTicker(job) {
    let lastBytes = 0;
    let lastTime = Date.now();
    let lastEmit = 0;
    return (force) => {
      const now = Date.now();
      if (!force && now - lastEmit < 250) return;
      const dt = (now - lastTime) / 1000;
      if (dt >= 0.5) {
        job.state.speed = Math.max(0, (job.state.bytes - lastBytes) / dt);
        lastBytes = job.state.bytes;
        lastTime = now;
      }
      lastEmit = now;
      emit(job, {});
    };
  }

  async function planDownload(sftp, remote, localDir, plan) {
    const attrs = await promisify((cb) => sftp.stat(remote, cb));
    const local = uniqueLocalPath(localDir, safeLocalName(rpath.basename(remote)), plan.reserved);
    if (!attrs.isDirectory()) {
      plan.files.push({ remote, local, size: attrs.size });
      plan.totalBytes += attrs.size;
      return local;
    }
    plan.dirs.push(local);
    for (const item of await promisify((cb) => sftp.readdir(remote, cb))) {
      if (item.attrs.isSymbolicLink()) {
        // Follow links to files, skip links to directories (they can loop).
        try {
          const t = await promisify((cb) => sftp.stat(rpath.join(remote, item.filename), cb));
          if (t.isDirectory()) { plan.skipped++; continue; }
        } catch { plan.skipped++; continue; }
      }
      await planDownload(sftp, rpath.join(remote, item.filename), local, plan);
    }
    return local;
  }

  function planUpload(local, remoteDir, plan, skipNames) {
    const name = path.basename(local);
    const remote = rpath.join(remoteDir, name);
    if (skipNames && skipNames.includes(name)) { plan.skipped++; return; }
    const st = fs.lstatSync(local);
    if (st.isSymbolicLink()) { plan.skipped++; return; }
    if (st.isDirectory()) {
      plan.dirs.push(remote);
      for (const child of fs.readdirSync(local)) planUpload(path.join(local, child), remote, plan, null);
      return;
    }
    plan.files.push({ local, remote, size: st.size });
    plan.totalBytes += st.size;
  }

  async function runJob(job, plan) {
    const tick = progressTicker(job);
    emit(job, { state: 'running', total: plan.files.length, totalBytes: plan.totalBytes, skipped: plan.skipped });
    for (const dir of plan.dirs) {
      if (job.canceled) break;
      if (job.direction === 'download') fs.mkdirSync(dir, { recursive: true });
      else await promisify((cb) => job.sftp.mkdir(dir, cb)).catch(() => {}); // already exists is fine
    }
    for (const f of plan.files) {
      if (job.canceled) break;
      const base = job.state.bytes;
      job.current = f;
      emit(job, { current: path.basename(f.local) });
      const step = (transferred) => { job.state.bytes = base + transferred; tick(false); };
      if (job.direction === 'download') {
        await promisify((cb) => job.sftp.fastGet(f.remote, f.local, { step, concurrency: 32, chunkSize: 65536 }, cb));
      } else {
        await promisify((cb) => job.sftp.fastPut(f.local, f.remote, { step, concurrency: 32, chunkSize: 65536 }, cb));
      }
      job.state.bytes = base + f.size;
      job.state.done++;
      tick(true);
    }
  }

  async function startJob(direction, connId, label, buildPlan) {
    const jobId = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      direction, connId, canceled: false, sftp: null, current: null,
      state: { jobId, connId, direction, label, state: 'preparing', done: 0, total: 0, bytes: 0, totalBytes: 0, speed: 0, skipped: 0, current: '', startedAt: Date.now() },
    };
    jobs.set(jobId, job);
    emit(job, {});
    (async () => {
      try {
        job.sftp = await openChannel(connId);
        const plan = { files: [], dirs: [], totalBytes: 0, skipped: 0, reserved: new Set() };
        const reveal = await buildPlan(job.sftp, plan);
        if (job.canceled) throw Object.assign(new Error('canceled'), { canceled: true });
        await runJob(job, plan);
        if (job.canceled) throw Object.assign(new Error('canceled'), { canceled: true });
        emit(job, { state: 'done', speed: 0, reveal: reveal || null, finishedAt: Date.now() });
      } catch (e) {
        if (job.canceled) {
          // Drop the half-written local file of an aborted download.
          if (direction === 'download' && job.current) { try { fs.rmSync(job.current.local, { force: true }); } catch {} }
          if (job.closedReason) emit(job, { state: 'error', speed: 0, error: job.closedReason, finishedAt: Date.now() });
          else emit(job, { state: 'canceled', speed: 0, finishedAt: Date.now() });
        } else {
          emit(job, { state: 'error', speed: 0, error: sftpErrorMessage(e), finishedAt: Date.now() });
          logError('sftp', { message: (direction === 'download' ? 'Скачивание' : 'Загрузка') + ' «' + label + '»: ' + ((e && e.message) || e) });
        }
      } finally {
        if (job.sftp) { try { job.sftp.end(); } catch {} }
        jobs.delete(jobId);
      }
    })();
    return { jobId };
  }

  handle('sftp:download', async ({ connId, paths, localDir }) => {
    if (!paths || !paths.length) throw new Error('Нечего скачивать');
    const label = paths.length === 1 ? rpath.basename(paths[0]) : paths.length + ' объектов';
    return startJob('download', connId, label, async (sftp, plan) => {
      let reveal = null;
      for (const p of paths) reveal = await planDownload(sftp, p, localDir, plan);
      return paths.length === 1 ? reveal : localDir;
    });
  });

  handle('sftp:upload', async ({ connId, localPaths, remoteDir, skipNames }) => {
    if (!localPaths || !localPaths.length) throw new Error('Нечего загружать');
    const label = localPaths.length === 1 ? path.basename(localPaths[0]) : localPaths.length + ' объектов';
    return startJob('upload', connId, label, async (sftp, plan) => {
      for (const p of localPaths) planUpload(p, remoteDir, plan, skipNames);
      return null;
    });
  });

  ipcMain.on('sftp:cancel', (event, { jobId }) => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.canceled = true;
    if (job.sftp) { try { job.sftp.end(); } catch {} }
  });

  // Small-file helpers for the Claude tools (text only, size-capped).
  async function readText(connId, file, maxBytes) {
    const sftp = await browser(connId);
    const st = await promisify((cb) => sftp.stat(file, cb));
    if (st.isDirectory()) throw new Error('Это папка, а не файл');
    const limit = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(limit);
    const handle = await promisify((cb) => sftp.open(file, 'r', cb));
    try {
      let pos = 0;
      while (pos < limit) {
        const n = await new Promise((resolve, reject) => sftp.read(handle, buf, pos, limit - pos, pos, (err, bytes) => (err ? reject(err) : resolve(bytes))));
        if (!n) break;
        pos += n;
      }
      return { data: buf.subarray(0, pos), size: st.size, truncated: st.size > limit };
    } finally {
      await promisify((cb) => sftp.close(handle, cb)).catch(() => {});
    }
  }
  async function writeText(connId, file, content) {
    const sftp = await browser(connId);
    await promisify((cb) => sftp.writeFile(file, content, cb));
  }
  async function listDir(connId, dir) {
    const sftp = await browser(connId);
    const real = await promisify((cb) => sftp.realpath(dir || '.', cb));
    const list = await promisify((cb) => sftp.readdir(real, cb));
    return { path: real, entries: list.map((i) => ({ name: i.filename, dir: i.attrs.isDirectory(), link: i.attrs.isSymbolicLink(), size: i.attrs.size, perms: permString(i.attrs.mode) })) };
  }

  async function home(connId) {
    const sftp = await browser(connId);
    return promisify((cb) => sftp.realpath('.', cb));
  }

  return {
    home,
    readText,
    writeText,
    listDir,
    closeFor(connId) {
      const b = browsers.get(connId);
      if (b) { browsers.delete(connId); try { b.end(); } catch {} }
      for (const job of jobs.values()) {
        if (job.connId === connId && !job.canceled) {
          job.canceled = true;
          job.closedReason = 'SSH-сессия закрыта';
          if (job.sftp) { try { job.sftp.end(); } catch {} }
        }
      }
    },
  };
};

module.exports.safeLocalName = safeLocalName;
module.exports.permString = permString;
