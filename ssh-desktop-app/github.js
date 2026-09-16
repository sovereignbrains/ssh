// Projects: the GitHub REST API plus git itself, run either on a server over SSH or on this computer.
//
// The token never reaches argv: remote commands are piped to `sh -s` over the SSH channel and local
// ones get it through the environment, so it cannot be read from a process list.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const API = 'https://api.github.com';
const UA = 'ssh-client';
const CLONE_MS = 15 * 60 * 1000;
const GIT_MS = 4 * 60 * 1000;
const OUT_LIMIT = 200 * 1024;
const SEP = String.fromCharCode(31); // unit separator between git log fields

const shQuote = (s) => "'" + String(s === undefined || s === null ? '' : s).replace(/'/g, "'\\''") + "'";
// Called by git when it needs credentials for https://github.com; reads the token from the environment.
const CRED_HELPER = '!f(){ echo username=x-access-token; echo password=$GH_TOK; };f';
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
// «~/projects/x» must stay a home-relative path for the remote shell, so the tilde is left unquoted.
const shDir = (dir) => dir === '~' ? '"$HOME"' : dir.startsWith('~/') ? '"$HOME"/' + shQuote(dir.slice(2)) : shQuote(dir);

function identity(account) {
  const login = (account && account.login) || 'ssh-client';
  return [
    '-c', 'user.name=' + ((account && account.name) || login),
    '-c', 'user.email=' + ((account && account.email) || (login + '@users.noreply.github.com')),
  ];
}
function baseArgs(account) {
  return ['-c', 'credential.helper=', '-c', 'credential.helper=' + CRED_HELPER, ...identity(account)];
}
function cloneUrl(repo) {
  return 'https://github.com/' + repo + '.git';
}
// Short, human readable reason instead of git's wall of text.
function gitError(r) {
  const text = ((r.err || '') + '\n' + (r.out || '')).trim();
  if (r.error === 'timeout') return 'Команда git не ответила вовремя';
  if (r.error) return r.error;
  if (r.code === 127 || /command not found|not recognized|No such file or directory: git/i.test(text)) return 'git не установлен';
  if (/Authentication failed|403 Forbidden|401 Unauthorized/i.test(text)) return 'GitHub отказал в доступе — проверьте токен и его права';
  if (/Repository not found/i.test(text)) return 'Репозиторий не найден или токен не даёт к нему доступа';
  if (/Could not resolve host|unable to access|Connection timed out/i.test(text)) return 'Нет доступа к github.com с этой машины';
  if (/non-fast-forward|\[rejected\]/i.test(text)) return 'GitHub отклонил отправку — сначала «Обновить»';
  if (/divergent branches|Need to specify how to reconcile|Not possible to fast-forward/i.test(text)) return 'Ветки разошлись: на GitHub есть коммиты, которых нет здесь';
  if (/would be overwritten by merge|local changes/i.test(text)) return 'Локальные изменения мешают обновлению — сначала закоммитьте их';
  if (/nothing to commit/i.test(text)) return 'Нечего коммитить — изменений нет';
  const first = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^hint:/i.test(l)).pop();
  return first ? first.slice(0, 300) : 'Команда git завершилась с кодом ' + r.code;
}

/* ---------------- parsing ---------------- */
function parseStatus(out) {
  const st = { branch: '', upstream: '', ahead: 0, behind: 0, files: [], detached: false };
  for (const raw of String(out).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      if (/^HEAD \(no branch\)/.test(head)) { st.detached = true; st.branch = 'HEAD'; continue; }
      const m = /^(.+?)(?:\.\.\.(\S+))?(?:\s\[(.+)\])?$/.exec(head);
      if (m) {
        st.branch = m[1].trim();
        st.upstream = m[2] || '';
        const info = m[3] || '';
        const a = /ahead (\d+)/.exec(info);
        const b = /behind (\d+)/.exec(info);
        st.ahead = a ? +a[1] : 0;
        st.behind = b ? +b[1] : 0;
      }
      continue;
    }
    const code = line.slice(0, 2);
    let name = line.slice(3);
    if (code.includes('R')) { const parts = name.split(' -> '); name = parts[parts.length - 1]; }
    st.files.push({ code: code.trim() || '??', name: name.replace(/^"|"$/g, '') });
  }
  return st;
}
function parseLog(out) {
  return String(out).split('\n').filter(Boolean).map((line) => {
    const [hash, subject, author, when] = line.split(SEP);
    return { hash: hash || '', subject: subject || '', author: author || '', when: when || '' };
  });
}
function parseBranches(out) {
  const list = [];
  let current = '';
  for (const raw of String(out).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const name = line.slice(2).trim();
    if (!name || name.includes('HEAD ->') || name.startsWith('(')) continue;
    if (line.startsWith('* ')) current = name;
    list.push(name);
  }
  return { current, branches: [...new Set(list)] };
}

module.exports = function registerGithub({ ipcMain, app, shell, dialog, getConnection, getWindow, logError }) {
  /* ---------------- GitHub REST ---------------- */
  async function api(token, endpoint, options) {
    if (!token) return { ok: false, error: 'Токен GitHub не задан' };
    const opts = options || {};
    let res;
    try {
      res = await fetch(endpoint.startsWith('http') ? endpoint : API + endpoint, {
        method: opts.method || 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': UA,
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      return { ok: false, error: /timed out|abort/i.test(msg) ? 'GitHub не ответил за 30 секунд' : 'Нет связи с GitHub: ' + msg };
    }
    if (res.status === 401) return { ok: false, error: 'Токен GitHub недействителен — создайте новый', auth: true };
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') return { ok: false, error: 'Исчерпан лимит запросов GitHub — попробуйте позже' };
    if (res.status === 403) return { ok: false, error: 'GitHub отказал: токену не хватает прав (нужны repo и workflow)' };
    if (res.status === 404) return { ok: false, error: 'GitHub: не найдено (404)' };
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (_) {}
      return { ok: false, error: 'GitHub ответил ' + res.status + (detail ? ': ' + detail : '') };
    }
    try { return { ok: true, data: await res.json() }; } catch (e) { return { ok: false, error: 'Непонятный ответ GitHub' }; }
  }

  ipcMain.handle('github:user', async (event, { token }) => {
    const r = await api(token, '/user');
    if (!r.ok) return r;
    const u = r.data;
    return { ok: true, user: { login: u.login, name: u.name || u.login, avatar: u.avatar_url, email: u.email || '' } };
  });

  ipcMain.handle('github:repos', async (event, { token }) => {
    const r = await api(token, '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    if (!r.ok) return r;
    return {
      ok: true,
      repos: r.data.map((x) => ({
        repo: x.full_name, name: x.name, owner: x.owner && x.owner.login, private: !!x.private,
        description: x.description || '', branch: x.default_branch, url: x.html_url,
        pushed: x.pushed_at, language: x.language || '', fork: !!x.fork,
      })),
    };
  });

  ipcMain.handle('github:issues', async (event, { token, repo, state }) => {
    if (!REPO_RE.test(repo || '')) return { ok: false, error: 'Неверное имя репозитория' };
    const r = await api(token, '/repos/' + repo + '/issues?state=' + (state || 'open') + '&per_page=30');
    if (!r.ok) return r;
    return {
      ok: true,
      issues: r.data.filter((x) => !x.pull_request).map((x) => ({
        number: x.number, title: x.title, state: x.state, url: x.html_url, comments: x.comments,
        author: (x.user && x.user.login) || '', updated: x.updated_at, body: (x.body || '').slice(0, 4000),
        labels: (x.labels || []).map((l) => ({ name: l.name, color: l.color })),
      })),
    };
  });

  ipcMain.handle('github:pulls', async (event, { token, repo, state }) => {
    if (!REPO_RE.test(repo || '')) return { ok: false, error: 'Неверное имя репозитория' };
    const r = await api(token, '/repos/' + repo + '/pulls?state=' + (state || 'open') + '&per_page=30');
    if (!r.ok) return r;
    return {
      ok: true,
      pulls: r.data.map((x) => ({
        number: x.number, title: x.title, state: x.state, url: x.html_url, draft: !!x.draft,
        author: (x.user && x.user.login) || '', updated: x.updated_at,
        head: x.head && x.head.ref, base: x.base && x.base.ref,
      })),
    };
  });

  ipcMain.handle('github:runs', async (event, { token, repo }) => {
    if (!REPO_RE.test(repo || '')) return { ok: false, error: 'Неверное имя репозитория' };
    const r = await api(token, '/repos/' + repo + '/actions/runs?per_page=15');
    if (!r.ok) return r;
    return {
      ok: true,
      runs: (r.data.workflow_runs || []).map((x) => ({
        id: x.id, name: x.name || x.display_title, status: x.status, conclusion: x.conclusion,
        branch: x.head_branch, url: x.html_url, event: x.event, started: x.run_started_at || x.created_at,
        title: x.display_title || '', number: x.run_number,
      })),
    };
  });

  ipcMain.handle('github:create-issue', async (event, { token, repo, title, body }) => {
    if (!REPO_RE.test(repo || '')) return { ok: false, error: 'Неверное имя репозитория' };
    if (!String(title || '').trim()) return { ok: false, error: 'Пустой заголовок задачи' };
    const r = await api(token, '/repos/' + repo + '/issues', { method: 'POST', body: { title: title, body: body || '' } });
    if (!r.ok) return r;
    return { ok: true, number: r.data.number, url: r.data.html_url };
  });

  ipcMain.handle('github:open', (event, { url }) => {
    if (!/^https:\/\/github\.com\//i.test(url || '')) return { ok: false, error: 'Ссылка не на GitHub' };
    shell.openExternal(url);
    return { ok: true };
  });

  /* ---------------- running git ---------------- */
  // Remote: the whole script goes down the SSH channel on stdin, so no secret ends up in argv.
  function runRemote(connId, script, timeoutMs) {
    return new Promise((resolve) => {
      const entry = getConnection(connId);
      if (!entry) { resolve({ code: null, out: '', err: '', error: 'Сессия не подключена — подключитесь к серверу' }); return; }
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => finish({ code: null, out: '', err: '', error: 'timeout' }), timeoutMs);
      try {
        entry.conn.exec('sh -s', (err, stream) => {
          if (err) return finish({ code: null, out: '', err: '', error: err.message });
          let out = '';
          let errOut = '';
          let code = null;
          stream.on('data', (d) => { if (out.length < OUT_LIMIT) out += d.toString('utf8'); });
          stream.stderr.on('data', (d) => { if (errOut.length < OUT_LIMIT) errOut += d.toString('utf8'); });
          stream.on('exit', (c) => { code = c; });
          stream.on('close', () => finish({ code, out, err: errOut }));
          stream.on('error', (e) => finish({ code: null, out, err: errOut, error: e.message }));
          stream.end(script);
        });
      } catch (e) {
        finish({ code: null, out: '', err: '', error: e.message });
      }
    });
  }

  function runLocal(args, cwd, token, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let child = null;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => { try { if (child) child.kill(); } catch (_) {} finish({ code: null, out: '', err: '', error: 'timeout' }); }, timeoutMs);
      const env = { ...process.env, GH_TOK: token || '', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
      delete env.ELECTRON_RUN_AS_NODE;
      try {
        child = spawn('git', args, { cwd, env, windowsHide: true });
      } catch (e) {
        return finish({ code: 127, out: '', err: e.message, error: 'git не установлен на этом компьютере' });
      }
      let out = '';
      let errOut = '';
      child.stdout.on('data', (d) => { if (out.length < OUT_LIMIT) out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { if (errOut.length < OUT_LIMIT) errOut += d.toString('utf8'); });
      child.on('error', (e) => finish({ code: 127, out, err: errOut, error: e.code === 'ENOENT' ? 'git не установлен на этом компьютере' : e.message }));
      child.on('close', (code) => finish({ code, out, err: errOut }));
    });
  }

  // One git invocation, wherever the project lives. `dir` is the working directory, `args` the git arguments.
  async function git({ place, connId, dir, args, token, account, timeoutMs, mkdir }) {
    const full = [...baseArgs(account), ...args];
    if (place === 'local') {
      if (mkdir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { code: null, out: '', err: '', error: 'Не удалось создать папку: ' + e.message }; } }
      if (!dir || !fs.existsSync(dir)) return { code: null, out: '', err: '', error: 'Папка не найдена: ' + dir };
      return runLocal(full, dir, token, timeoutMs || GIT_MS);
    }
    const script = [
      'GH_TOK=' + shQuote(token || ''), 'export GH_TOK',
      'GIT_TERMINAL_PROMPT=0', 'export GIT_TERMINAL_PROMPT',
      'LC_ALL=C', 'export LC_ALL',
      mkdir ? 'mkdir -p ' + shDir(dir) : '',
      'cd ' + shDir(dir) + ' || exit 9',
      'command -v git >/dev/null 2>&1 || { echo "git не установлен на сервере" >&2; exit 127; }',
      'git ' + full.map(shQuote).join(' '),
    ].filter(Boolean).join('\n');
    const r = await runRemote(connId, script, timeoutMs || GIT_MS);
    if (r.code === 9) return { ...r, error: 'Папка не найдена на сервере: ' + dir };
    return r;
  }

  // A folder that exists but holds nothing is still a valid clone target.
  async function dirEmpty(p) {
    if (p.place === 'local') {
      try { return fs.readdirSync(p.dir).length === 0; } catch (e) { return false; }
    }
    const r = await runRemote(p.connId, 'cd ' + shDir(p.dir) + ' 2>/dev/null || exit 9' + String.fromCharCode(10) + 'ls -A | head -1', 30000);
    return r.code === 0 && !r.out.trim();
  }

  const fail = (r) => ({ ok: false, error: gitError(r), out: ((r.err || '') + (r.out || '')).slice(-4000) });
  const okOut = (r) => ({ ok: true, out: ((r.out || '') + (r.err || '')).slice(-4000) });
  const missingDir = (r) => /Папка не найдена|No such file|cannot change to|does not exist/i.test((r.err || '') + (r.out || '') + (r.error || ''));

  /* ---------------- project operations ---------------- */
  const OPS = {
    // Is there a git repository in this folder already, and which remote does it point at?
    async probe(p) {
      const r = await git({ ...p, args: ['rev-parse', '--show-toplevel'], timeoutMs: 45000 });
      if (r.code !== 0) {
        if (r.error === 'timeout' || (r.error && !missingDir(r))) return fail(r);
        const exists = !missingDir(r);
        return { ok: true, repo: false, exists, empty: exists ? await dirEmpty(p) : true };
      }
      const remote = await git({ ...p, args: ['remote', 'get-url', 'origin'], timeoutMs: 45000 });
      return { ok: true, repo: true, exists: true, root: r.out.trim(), remote: remote.code === 0 ? remote.out.trim() : '' };
    },
    async clone(p) {
      const clean = String(p.dir).replace(/[\\/]+$/, '');
      const sepIdx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
      let parent = sepIdx <= 0 ? (p.place === 'local' ? clean : '/') : clean.slice(0, sepIdx);
      if (/^[A-Za-z]:$/.test(parent)) parent += path.sep;
      const name = clean.slice(sepIdx + 1);
      if (!name) return { ok: false, error: 'Не указано имя папки проекта' };
      const r = await git({ ...p, dir: parent, mkdir: true, args: ['clone', cloneUrl(p.repo), name], timeoutMs: CLONE_MS });
      return r.code === 0 ? okOut(r) : fail(r);
    },
    async status(p) {
      const r = await git({ ...p, args: ['status', '--porcelain=v1', '-b', '--untracked-files=all'], timeoutMs: 90000 });
      if (r.code !== 0) return fail(r);
      return { ok: true, status: parseStatus(r.out) };
    },
    async log(p) {
      const r = await git({ ...p, args: ['log', '-n', '25', '--pretty=format:%h' + SEP + '%s' + SEP + '%an' + SEP + '%ar'], timeoutMs: 90000 });
      if (r.code !== 0) return fail(r);
      return { ok: true, commits: parseLog(r.out) };
    },
    async branches(p) {
      const r = await git({ ...p, args: ['branch', '--sort=-committerdate'], timeoutMs: 90000 });
      if (r.code !== 0) return fail(r);
      return { ok: true, ...parseBranches(r.out) };
    },
    async checkout(p) {
      if (!p.branch) return { ok: false, error: 'Не указана ветка' };
      const r = await git({ ...p, args: ['checkout', p.branch] });
      return r.code === 0 ? okOut(r) : fail(r);
    },
    async pull(p) {
      const fetched = await git({ ...p, args: ['fetch', 'origin', '--prune'] });
      if (fetched.code !== 0) return fail(fetched);
      const r = await git({ ...p, args: ['pull', '--ff-only'] });
      return r.code === 0 ? okOut(r) : fail(r);
    },
    async fetch(p) {
      const r = await git({ ...p, args: ['fetch', 'origin', '--prune'] });
      return r.code === 0 ? okOut(r) : fail(r);
    },
    async commit(p) {
      const msg = String(p.message || '').trim();
      if (!msg) return { ok: false, error: 'Пустое сообщение коммита' };
      const add = await git({ ...p, args: p.paths && p.paths.length ? ['add', '--', ...p.paths] : ['add', '-A'] });
      if (add.code !== 0) return fail(add);
      const r = await git({ ...p, args: ['commit', '-m', msg] });
      return r.code === 0 ? okOut(r) : fail(r);
    },
    async push(p) {
      const r = await git({ ...p, args: ['push'] });
      if (r.code === 0) return okOut(r);
      if (/no upstream branch|set-upstream/i.test((r.err || '') + (r.out || ''))) {
        const up = await git({ ...p, args: ['push', '--set-upstream', 'origin', p.branch || 'HEAD'] });
        return up.code === 0 ? okOut(up) : fail(up);
      }
      return fail(r);
    },
    async filediff(p) {
      if (!p.file) return { ok: false, error: 'Не указан файл' };
      const r = await git({ ...p, args: ['--no-pager', 'diff', 'HEAD', '--', p.file], timeoutMs: 90000 });
      if (r.code === 0 && r.out.trim()) return { ok: true, out: r.out.slice(0, 40000) };
      if (r.code !== 0 && !r.out.trim()) return fail(r);
      return { ok: true, out: '', untracked: true };
    },
    async discard(p) {
      if (!p.file) return { ok: false, error: 'Не указан файл' };
      const r = await git({ ...p, args: ['checkout', 'HEAD', '--', p.file] });
      if (r.code === 0) return okOut(r);
      const clean = await git({ ...p, args: ['clean', '-fd', '--', p.file] });
      return clean.code === 0 ? okOut(clean) : fail(clean);
    },
  };

  ipcMain.handle('git:op', async (event, params) => {
    const p = params || {};
    const fn = Object.prototype.hasOwnProperty.call(OPS, p.op) ? OPS[p.op] : null;
    if (!fn) return { ok: false, error: 'Неизвестная операция git: ' + p.op };
    if (p.place !== 'local' && p.place !== 'server') return { ok: false, error: 'Не указано, где лежит проект' };
    if (p.place === 'server' && !p.connId) return { ok: false, error: 'Сессия сервера не подключена' };
    if (!p.dir) return { ok: false, error: 'Не указана папка проекта' };
    if (p.repo && !REPO_RE.test(p.repo)) return { ok: false, error: 'Неверное имя репозитория' };
    try {
      return await fn(p);
    } catch (e) {
      logError('git', { message: (e && e.message) || String(e), stack: e && e.stack });
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle('git:pick-dir', async (event, { current }) => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Папка для проекта на этом компьютере',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current && fs.existsSync(current) ? current : app.getPath('home'),
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  ipcMain.handle('git:home', () => ({ home: app.getPath('home'), sep: path.sep }));

  ipcMain.handle('git:reveal', (event, { dir }) => {
    if (dir && fs.existsSync(dir)) { shell.openPath(dir); return { ok: true }; }
    return { ok: false, error: 'Папка не найдена на этом компьютере' };
  });
};
