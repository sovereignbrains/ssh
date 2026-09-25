const { app, BrowserWindow, ipcMain, dialog, Menu, session, shell, screen, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { Client: SSHClient, utils: sshUtils } = require('ssh2');
const { Vault } = require('./vault');
const registerSftp = require('./sftp');
const registerAgent = require('./agent');
const registerUpdater = require('./updater');
const registerSync = require('./sync');
const registerGithub = require('./github');
const registerNetTools = require('./nettools');
const aegis = require('./aegis');
const uiserver = require('./uiserver');
const registerHello = require('./hello');
let uiUrl = null;
let syncService = null;
let netToolsService = null;
const pty = require('node-pty');
const { execFileSync } = require('child_process');

let mainWindow;

/* ---------------- SSH keys ---------------- */
function describeKey(text, passphrase) {
  const parsed = sshUtils.parseKey(text, passphrase || undefined);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  const blob = key.getPublicSSH();
  return {
    type: key.type,
    comment: key.comment || '',
    isPrivate: key.isPrivateKey(),
    fingerprint: 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''),
    publicKey: key.type + ' ' + blob.toString('base64') + (key.comment ? ' ' + key.comment : ''),
  };
}
function keyErrorMessage(err) {
  const msg = (err && err.message) || String(err);
  if (/no passphrase given/i.test(msg)) return 'Ключ зашифрован — укажите парольную фразу';
  if (/passphrase|decrypt/i.test(msg)) return 'Неверная парольная фраза ключа';
  if (/unsupported key format/i.test(msg)) return 'Неподдерживаемый формат ключа';
  return 'Не удалось разобрать ключ: ' + msg;
}

/* ---------------- storage location & vault ---------------- */
const VAULT_NAME = 'secrets.vault';
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
let config = { store: 'std', dataDir: '' };
function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {}
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}
function dataDir() {
  return config.store === 'portable' && config.dataDir ? config.dataDir : app.getPath('userData');
}
let vault = null;
function vaultStatus() {
  const dir = dataDir();
  const dirMissing = !fs.existsSync(dir);
  return {
    exists: !dirMissing && vault.exists(),
    unlocked: vault.isUnlocked(),
    dirMissing,
    path: vault.file,
    store: config.store,
    dataDir: dir,
    defaultDir: app.getPath('userData'),
    meta: !dirMissing && vault.exists() ? vault.meta() : null,
    deviceId: config.deviceId || '',
  };
}

function registerVaultHandlers() {
  const wrap = (fn) => async (event, args) => {
    try {
      return { ok: true, ...(await fn(args || {})) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  ipcMain.handle('vault:status', wrap(async () => vaultStatus()));

  ipcMain.handle('vault:create', wrap(async ({ password }) => {
    if (!password || password.length < 8) throw new Error('Мастер-пароль: минимум 8 символов');
    if (vaultStatus().dirMissing) fs.mkdirSync(dataDir(), { recursive: true });
    await vault.create(password, {});
    if (syncService) syncService.onUnlock();
    return vaultStatus();
  }));

  ipcMain.handle('vault:unlock', wrap(async ({ password }) => {
    const data = await vault.unlock(password || '');
    if (syncService) syncService.onUnlock();
    return { data, status: vaultStatus() };
  }));

  ipcMain.handle('vault:save', wrap(async ({ data }) => {
    try {
      vault.save(data);
      if (syncService) syncService.onLocalSave();
    } catch (e) {
      logError('сейф', { message: 'Не удалось сохранить сейф: ' + e.message, stack: e.stack });
      throw e;
    }
    return {};
  }));

  ipcMain.handle('vault:lock', wrap(async () => {
    vault.lock();
    return vaultStatus();
  }));

  ipcMain.handle('vault:change-password', wrap(async ({ oldPassword, newPassword }) => {
    if (!newPassword || newPassword.length < 8) throw new Error('Новый пароль: минимум 8 символов');
    await vault.changePassword(oldPassword || '', newPassword);
    // The vault key just changed, so the copy Windows Hello wrapped opens nothing any more.
    if (config.hello) { delete config.hello; saveConfig(); }
    return {};
  }));

  ipcMain.handle('vault:backup', wrap(async () => {
    if (!vault.exists()) throw new Error('Сейф ещё не создан');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Резервная копия сейфа',
      defaultPath: path.join(app.getPath('documents'), 'secrets.vault.' + stamp + '.bak'),
    });
    if (result.canceled || !result.filePath) return { path: null };
    fs.copyFileSync(vault.file, result.filePath);
    return { path: result.filePath, size: fs.statSync(result.filePath).size };
  }));

  ipcMain.handle('app:temp-info', wrap(async () => ({ bytes: tempBytes() })));

  ipcMain.handle('app:clear-temp', wrap(async () => {
    const before = tempBytes();
    const ses = session.defaultSession;
    await ses.clearCache();
    await ses.clearCodeCaches({});
    await ses.clearStorageData({ storages: ['shadercache', 'cachestorage', 'serviceworkers'] });
    for (const dir of TEMP_DIRS) {
      const p = path.join(app.getPath('userData'), dir);
      for (const entry of safeReaddir(p)) {
        try { fs.rmSync(path.join(p, entry), { recursive: true, force: true }); } catch {}
      }
    }
    const vaultTmp = path.join(path.dirname(vault.file), '.' + path.basename(vault.file) + '.tmp');
    for (const leftover of [vaultTmp, vault.file + '.tmp', path.join(app.getPath('userData'), 'config.json.tmp')]) {
      try { fs.rmSync(leftover, { force: true }); } catch {}
    }
    const after = tempBytes();
    return { freed: Math.max(0, before - after), bytes: after };
  }));

  ipcMain.handle('vault:set-location', wrap(async ({ store, pick }) => {
    let dir = app.getPath('userData');
    if (store === 'portable') {
      if (pick || !config.dataDir) {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: 'Папка для сейфа',
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: config.dataDir || app.getPath('documents'),
        });
        if (result.canceled || !result.filePaths.length) return { canceled: true, ...vaultStatus() };
        dir = result.filePaths[0];
      } else {
        dir = config.dataDir;
      }
    }
    const oldKnownHosts = knownHostsPath();
    vault.moveTo(path.join(dir, VAULT_NAME));
    // Keep the rest of config (window, updates, device id, sync) — only the storage fields change.
    config = store === 'portable' ? { ...config, store: 'portable', dataDir: dir } : { ...config, store: 'std' };
    saveConfig();
    if (oldKnownHosts !== knownHostsPath()) saveKnownHosts();
    try { if (oldKnownHosts !== knownHostsPath()) fs.unlinkSync(oldKnownHosts); } catch {}
    return vaultStatus();
  }));
}

/* ---------------- error journal (logs/errors.log, JSON lines) ---------------- */
const ERROR_LOG_MAX = 1024 * 1024;
function errorLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'errors.log');
}
function logError(source, err, extra) {
  const entry = {
    ts: new Date().toISOString(),
    source,
    message: String((err && err.message) || err || 'неизвестная ошибка').slice(0, 2000),
    ...(err && err.stack ? { stack: String(err.stack).split('\n').slice(0, 12).join('\n') } : {}),
    ...(extra || {}),
  };
  try {
    const file = errorLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > ERROR_LOG_MAX) fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
    } catch {}
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {}
  sendToRenderer('errors:new', entry);
}
function readErrorLog() {
  const file = errorLogPath();
  const lines = [];
  for (const f of [file.replace(/\.log$/, '.old.log'), file]) {
    try { lines.push(...fs.readFileSync(f, 'utf8').split('\n')); } catch {}
  }
  return lines.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-1000);
}

process.on('uncaughtException', (err) => logError('главный процесс', err));
process.on('unhandledRejection', (reason) => logError('главный процесс (promise)', reason));
app.on('render-process-gone', (event, webContents, details) => {
  if (details.reason === 'clean-exit') return;
  logError('окно', { message: 'Процесс окна завершился: ' + details.reason + ' (код ' + details.exitCode + ')' });
  // Reload into the lock screen instead of leaving a blank window.
  if (vault) vault.lock();
  if (mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents) {
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); }, 500);
  }
});
app.on('child-process-gone', (event, details) => {
  if (details.reason === 'clean-exit' || details.reason === 'killed') return;
  logError('процесс ' + details.type, { message: (details.name || details.serviceName || details.type) + ': ' + details.reason + ' (код ' + details.exitCode + ')' });
});

function registerJournalHandlers() {
  ipcMain.handle('app:about', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));

  ipcMain.on('errors:report', (event, { source, message, stack }) => logError(source || 'окно', { message, stack }));
  ipcMain.handle('errors:list', () => readErrorLog());
  ipcMain.handle('errors:clear', () => {
    const file = errorLogPath();
    for (const f of [file, file.replace(/\.log$/, '.old.log')]) { try { fs.rmSync(f, { force: true }); } catch {} }
    return { ok: true };
  });
  ipcMain.handle('journal:export', async (event, { name, text }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Экспорт журнала',
      defaultPath: path.join(app.getPath('documents'), name),
      filters: [{ name: 'Текст', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, '﻿' + text);
    return result.filePath;
  });
}

/* ---------------- temporary files ---------------- */
// Chromium caches only — never the vault, config or known_hosts.
const TEMP_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage', 'Shared Dictionary', 'Crashpad'];
function safeReaddir(p) {
  try { return fs.readdirSync(p); } catch { return []; }
}
function dirBytes(p) {
  let total = 0;
  for (const entry of safeReaddir(p)) {
    const full = path.join(p, entry);
    try {
      const st = fs.lstatSync(full);
      total += st.isDirectory() ? dirBytes(full) : st.size;
    } catch {}
  }
  return total;
}
function tempBytes() {
  let total = TEMP_DIRS.reduce((sum, dir) => sum + dirBytes(path.join(app.getPath('userData'), dir)), 0);
  try { total += fs.statSync(vault.file + '.tmp').size; } catch {}
  return total;
}

/* ---------------- known_hosts (TOFU) ---------------- */
function knownHostsPath() {
  return path.join(dataDir(), 'known_hosts.json');
}
let knownHosts = {};
function loadKnownHosts() {
  try {
    knownHosts = JSON.parse(fs.readFileSync(knownHostsPath(), 'utf8'));
  } catch {
    knownHosts = {};
  }
}
function saveKnownHosts() {
  try {
    fs.writeFileSync(knownHostsPath(), JSON.stringify(knownHosts, null, 2));
  } catch (e) {
    console.error('Failed to save known_hosts.json:', e.message);
  }
}

/* ---------------- SSH connections ---------------- */
const connections = new Map(); // connId -> { conn, stream }

/* ---- shared console: the agent types into the same shell the user is watching.
 * The command goes into the live stream, so its echo and output land in the terminal as if typed
 * by hand; two markers fence off the part that belongs to the agent. The marker literal is split
 * across printf arguments, so the echoed command line never matches what we search for. */
const termRuns = new Map(); // connId -> run state
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -\/]*[@-~])|\r/g;

function finishTermRun(connId, result) {
  const run = termRuns.get(connId);
  if (!run) return;
  clearTimeout(run.timer);
  termRuns.delete(connId);
  sendToRenderer('ssh:agent-busy', { connId, busy: false });
  run.resolve({ ...result, ms: Date.now() - run.started });
}

function feedTermRun(connId, chunk) {
  const run = termRuns.get(connId);
  if (!run) return;
  run.buffer += chunk;
  const done = run.endRe.exec(run.buffer);
  if (!done) {
    // Runaway output must not eat all the memory: keep the tail, the end marker arrives last.
    if (run.buffer.length > 4 * 1024 * 1024) run.buffer = run.buffer.slice(-2 * 1024 * 1024);
    return;
  }
  const begin = run.buffer.indexOf(run.beginMark);
  const from = begin === -1 ? 0 : begin + run.beginMark.length;
  const output = run.buffer.slice(from, done.index).replace(ANSI_RE, '').replace(/^\n+|\n+$/g, '');
  finishTermRun(connId, { output, code: Number(done[1]), signal: null, timedOut: false });
}

// Open SSH sessions the local chat may send a command to, so one conversation covers both machines.
function listTargets() {
  return [...connections.entries()].map(([connId, e]) => ({ connId, label: e.label || connId }));
}

/* ---- who owns the terminal. The agent's command is typed into the live shell, so when a program
 * holds the foreground (an installer menu, vim, top) the command lines become that program's input,
 * and a menu that redraws itself wipes their echo, so the user never sees what was typed (25.09.2026:
 * four lines went into the packetlab menu as answers). Asked over a separate exec channel of the
 * same connection, which the pty never sees: climb to the sshd process that owns this connection,
 * take its child with a terminal (the user's shell) and compare the terminal's foreground process
 * group with the shell's own. Linux procps only; anything else answers FG_UNKNOWN and the command
 * goes through as before. */
const FG_SCRIPT = [
  'export LC_ALL=C',
  'command -v ps >/dev/null 2>&1 || { echo FG_UNKNOWN; exit 0; }',
  'p=$$',
  'while [ -n "$p" ] && [ "$p" -gt 1 ]; do',
  '  case "$(ps -o comm= -p "$p" 2>/dev/null)" in sshd*) break ;; esac',
  '  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
  'done',
  'case "$(ps -o comm= -p "${p:-0}" 2>/dev/null)" in sshd*) ;; *) echo FG_UNKNOWN; exit 0 ;; esac',
  "sh=$(ps -o pid=,tty= --ppid \"$p\" 2>/dev/null | awk '$2 != \"?\" {print $1; exit}')",
  '[ -n "$sh" ] || { echo FG_UNKNOWN; exit 0; }',
  'fg=$(ps -o tpgid= -p "$sh" 2>/dev/null | tr -d " ")',
  'pg=$(ps -o pgid= -p "$sh" 2>/dev/null | tr -d " ")',
  '[ -n "$fg" ] && [ "$fg" != "-1" ] || { echo FG_UNKNOWN; exit 0; }',
  '[ "$fg" = "$pg" ] && { echo FG_SHELL; exit 0; }',
  'echo "FG_BUSY $(ps -o args= -p "$fg" 2>/dev/null | cut -c1-120)"',
  '',
].join('\n');
// A nested shell in the foreground (su, sudo -i, bash typed by hand) is still a prompt: typing is fine.
const FG_SHELL_RE = /^(-|\S*\/)?(bash|sh|zsh|dash|ksh|mksh|fish|ash|tcsh|csh)(\s+-[a-zA-Z]+)*\s*$|^(-|\S*\/)?su(\s+(-|-l|--login|-\s*\S+))?\s*$|^(\S*\/)?sudo\s+(-[is]|su)\b/;

async function terminalForeground(conn) {
  const r = await execScript(conn, FG_SCRIPT, 4000);
  const m = /^FG_BUSY(.*)$/m.exec(r.out || '');
  if (!m) return null;                                     // shell at a prompt, or we could not tell
  const args = m[1].trim();
  return FG_SHELL_RE.test(args) ? null : (args || 'без имени');
}

async function runInTerminal(connId, command, timeoutMs) {
  const entry = connections.get(connId);
  if (entry && entry.conn && !termRuns.has(connId)) {
    const busy = await terminalForeground(entry.conn);
    if (busy) {
      throw new Error('В терминале ' + (entry.label || connId) + ' сейчас работает программа «' + busy +
        '» — команда не отправлена: её строки стали бы вводом этой программы. Выйдите из неё и повторите.');
    }
  }
  return typeIntoTerminal(connId, command, timeoutMs);
}

function typeIntoTerminal(connId, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const entry = connections.get(connId);
    if (!entry || !entry.stream || entry.stream.destroyed) { reject(new Error('SSH-сессия не подключена')); return; }
    if (termRuns.has(connId)) { reject(new Error('В этом терминале уже выполняется команда агента')); return; }
    const id = crypto.randomBytes(8).toString('hex');
    const run = {
      beginMark: '__CC_' + id + '_B__',
      endRe: new RegExp('__CC_' + id + '_E__ (\\d+)'),
      buffer: '', resolve, started: Date.now(),
    };
    run.timer = setTimeout(() => {
      try { entry.stream.write('\x03'); } catch (_) {}
      finishTermRun(connId, { output: run.buffer.replace(ANSI_RE, ''), code: null, signal: null, timedOut: true });
    }, timeoutMs);
    termRuns.set(connId, run);
    sendToRenderer('ssh:agent-busy', { connId, busy: true, command });
    entry.stream.write(
      "printf '%s%s\\n' '__CC_" + id + "' '_B__'\n" +
      // The end marker rides on the command's last line, so the shell has read everything before the
      // command starts: typed ahead on a line of its own it was swallowed by whatever read stdin
      // (apt, certbot) and the run hung until timeout. </dev/null keeps the command off the tty too.
      // The agent always sends a ( … ) subshell, so the redirect covers the whole command.
      command + ' </dev/null; ' +
      "printf '\\n%s%s %s\\n' '__CC_" + id + "' '_E__' \"$?\"\n"
    );
  });
}
let sftpService = null;
let agentService = null;
const hostKeyPrompts = new Map(); // promptId -> resolve(accept)

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function detectRemoteOs(connId, conn) {
  conn.exec('cat /etc/os-release 2>/dev/null || uname -sr', (err, stream) => {
    if (err) return;
    let out = '';
    stream.on('data', (d) => { if (out.length < 8192) out += d.toString('utf8'); });
    stream.on('close', () => {
      const field = (name) => {
        const m = out.match(new RegExp('^' + name + '="?([^"\\n]*)"?', 'm'));
        return m ? m[1].trim() : '';
      };
      const uname = out.trim().split('\n')[0] || '';
      const id = (field('ID') || uname.split(/\s+/)[0] || '').toLowerCase();
      // "Debian GNU/Linux 13 (trixie)" -> "Debian 13 trixie"; without os-release fall back to `uname -sr`.
      let name = field('PRETTY_NAME') || [field('NAME'), field('VERSION') || field('VERSION_ID')].filter(Boolean).join(' ');
      name = name ? name.replace(/\s*GNU\/Linux/i, '').replace(/\(([^)]*)\)/g, '$1').replace(/\s+/g, ' ').trim() : uname;
      sendToRenderer('ssh:os', {
        connId,
        id,
        idLike: field('ID_LIKE').toLowerCase(),
        name: name.slice(0, 60),
      });
    });
  });
}

// Server status line. The script goes over stdin to `sh -s`, so the user's login shell (bash, zsh, fish) doesn't matter.
// CPU and network are counters: rates come from the difference with the previous sample of the same connection.
const STATS_SCRIPT = [
  'export LC_ALL=C',
  '[ -r /proc/stat ] || { echo UNSUPPORTED; exit 0; }',
  'head -n 1 /proc/stat',
  "grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached):' /proc/meminfo",
  'echo DF $(df -Pk / 2>/dev/null | tail -n 1)',
  "echo UP $(cut -d ' ' -f 1 /proc/uptime)",
  "echo LA $(cut -d ' ' -f 1-3 /proc/loadavg)",
  'echo NC $(grep -c ^processor /proc/cpuinfo)',
  "awk 'NR>2 { sub(/:/, \" \"); if ($1 !~ /^(lo|veth|docker|br-|virbr|cni|flannel|cali|kube)/) { rx += $2; tx += $10 } } END { printf \"NET %.0f %.0f\\n\", rx, tx }' /proc/net/dev",
  '',
].join('\n');

function parseStats(out, prev, now) {
  if (/^UNSUPPORTED/m.test(out)) return { unsupported: true };
  const line = (tag) => { const m = out.match(new RegExp('^' + tag + '\\s+(.*)$', 'm')); return m ? m[1].trim().split(/\s+/) : null; };
  const cpu = line('cpu');
  if (!cpu) return { unsupported: true };
  const nums = cpu.slice(0, 8).map(Number);
  const cpuTotal = nums.reduce((a, b) => a + (b || 0), 0);
  const cpuIdle = (nums[3] || 0) + (nums[4] || 0);
  const kb = (name) => { const m = out.match(new RegExp('^' + name + ':\\s+(\\d+)', 'm')); return m ? +m[1] * 1024 : null; };
  const memTotal = kb('MemTotal') || 0;
  // Kernels before 3.14 have no MemAvailable; free + buffers + cache is the classic estimate.
  let memAvail = kb('MemAvailable');
  if (memAvail == null && kb('MemFree') != null) memAvail = kb('MemFree') + (kb('Buffers') || 0) + (kb('Cached') || 0);
  // df columns: filesystem (may contain spaces), size, used, avail, capacity%, mount — anchor on the % column.
  const dfLine = line('DF');
  const pctAt = dfLine ? dfLine.findIndex((x) => /^\d+%$/.test(x)) : -1;
  const df = pctAt >= 3 ? dfLine.slice(pctAt - 3, pctAt) : null;
  const up = line('UP');
  const la = line('LA');
  const nc = line('NC');
  const net = line('NET');
  const rx = net ? +net[0] : 0;
  const tx = net ? +net[1] : 0;
  const stats = {
    cpu: null,
    cores: nc ? +nc[0] || null : null,
    memTotal,
    memUsed: memTotal && memAvail != null ? Math.max(0, memTotal - memAvail) : 0,
    diskTotal: df ? +df[0] * 1024 || 0 : 0,
    diskUsed: df ? +df[1] * 1024 || 0 : 0,
    uptime: up ? Math.floor(+up[0]) : 0,
    load: la ? la.map(Number) : null,
    rxRate: null,
    txRate: null,
  };
  if (prev) {
    const dt = cpuTotal - prev.cpuTotal;
    if (dt > 0) stats.cpu = Math.max(0, Math.min(100, (1 - (cpuIdle - prev.cpuIdle) / dt) * 100));
    const secs = (now - prev.at) / 1000;
    if (secs > 0 && (rx || tx) && rx >= prev.rx && tx >= prev.tx) {
      stats.rxRate = (rx - prev.rx) / secs;
      stats.txRate = (tx - prev.tx) / secs;
    }
  }
  stats.sample = { at: now, cpuTotal, cpuIdle, rx, tx };
  return stats;
}

// Run a script through `sh -s` on the server; resolves with exit code and captured output, never rejects.
function execScript(conn, script, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => finish({ code: null, out: '', err: '', error: 'timeout' }), timeoutMs);
    try {
      conn.exec('sh -s', (err, stream) => {
        if (err) return finish({ code: null, out: '', err: '', error: err.message });
        let out = '';
        let errOut = '';
        let code = null;
        stream.on('data', (d) => { if (out.length < 16384) out += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { if (errOut.length < 16384) errOut += d.toString('utf8'); });
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

function collectStats(entry) {
  if (entry.statsRun) return entry.statsRun;
  entry.statsRun = new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); entry.statsRun = null; resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), 8000);
    try {
      entry.conn.exec('sh -s', (err, stream) => {
        if (err) return finish({ ok: false, error: err.message });
        let out = '';
        stream.on('data', (d) => { if (out.length < 16384) out += d.toString('utf8'); });
        stream.on('close', () => {
          const now = Date.now();
          const stats = parseStats(out, entry.statsPrev, now);
          if (stats.unsupported) return finish({ ok: true, unsupported: true });
          entry.statsPrev = stats.sample;
          delete stats.sample;
          finish({ ok: true, stats });
        });
        stream.on('error', (e) => finish({ ok: false, error: e.message }));
        stream.end(STATS_SCRIPT);
      });
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  });
  return entry.statsRun;
}

function registerSshHandlers() {
  ipcMain.handle('ssh:connect', (event, opts) => {
    return new Promise((resolve, reject) => {
      const { connId, host, port, username, authType, password, keyPath, privateKeyText, passphrase } = opts || {};
      if (!connId || !host || !username) {
        reject(new Error('Недостаточно данных для подключения'));
        return;
      }
      if (connections.has(connId)) {
        reject(new Error('Соединение с таким id уже существует'));
        return;
      }

      const conn = new SSHClient();
      let settled = false;
      let currentStep = 0;

      const progress = (step, status, meta) => {
        currentStep = step;
        sendToRenderer('ssh:progress', { connId, step, status, meta });
      };
      const log = (text, cls) => sendToRenderer('ssh:log', { connId, text, cls });

      const fail = (err) => {
        if (settled) return;
        settled = true;
        progress(currentStep, 'fail', err.message);
        log(err.message, 'e');
        try { conn.end(); } catch (_) {}
        connections.delete(connId);
        reject(err);
      };

      progress(0, 'active');
      log('ssh_connect: resolving "' + host + '" …');

      conn.on('banner', (msg) => {
        if (msg && msg.trim()) log(msg.trim(), 'y');
      });

      conn.on('handshake', (info) => {
        progress(0, 'done', host + ':' + port);
        log('debug1: Connection established, protocol negotiated.', 'g');
        const cipher = (info.cs && info.cs.cipher) || '?';
        const mac = (info.cs && info.cs.mac) || '(implicit, AEAD)';
        log('debug1: kex: algorithm ' + info.kex + ' · cipher ' + cipher + ' · mac ' + mac);
        progress(1, 'done', info.kex);
      });

      conn.on('ready', () => {
        progress(3, 'done', authType === 'key' ? 'publickey' : 'password');
        log('debug1: Authentication succeeded (' + (authType === 'key' ? 'publickey' : 'password') + ').', 'g');
        progress(4, 'active');
        conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
          if (err) { fail(err); return; }
          connections.set(connId, { conn, stream, label: username + '@' + host });
          const toTerminal = (data) => {
            const text = data.toString('utf8');
            sendToRenderer('ssh:data', { connId, data: text });
            feedTermRun(connId, text);
          };
          stream.on('data', toTerminal);
          stream.stderr.on('data', toTerminal);
          stream.on('close', () => {
            finishTermRun(connId, { output: '', code: null, signal: null, timedOut: false, closed: true });
            sendToRenderer('ssh:closed', { connId });
            stopTunnelsFor(connId, 'SSH-сессия закрыта');
            if (sftpService) sftpService.closeFor(connId);
            connections.delete(connId);
            try { conn.end(); } catch (_) {}
          });
          progress(4, 'done');
          settled = true;
          resolve({ ok: true });
          detectRemoteOs(connId, conn);
        });
      });

      conn.on('error', (err) => fail(err));
      conn.on('close', () => {
        if (!settled) fail(new Error('Соединение закрыто до завершения рукопожатия'));
      });

      const hostVerifier = (key, callback) => {
        const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        const hostKeyId = host + ':' + port;
        const known = knownHosts[hostKeyId];
        log('debug1: Server host key fingerprint: ' + fingerprint);
        if (known === fingerprint) {
          progress(2, 'done', 'известен');
          callback(true);
          return;
        }
        progress(2, 'active');
        const promptId = crypto.randomUUID();
        sendToRenderer('ssh:host-key-prompt', {
          connId, promptId, host, port, fingerprint, isNew: !known, previous: known || null,
        });
        hostKeyPrompts.set(promptId, (accept) => {
          if (accept) {
            knownHosts[hostKeyId] = fingerprint;
            saveKnownHosts();
            progress(2, 'done', 'принят');
          } else {
            progress(2, 'fail', 'отклонён пользователем');
          }
          callback(accept);
        });
      };

      const connectOpts = {
        host,
        port: port || 22,
        username,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
        hostVerifier,
      };

      if (authType === 'key') {
        let keyData = privateKeyText;
        if (!keyData) {
          try {
            keyData = fs.readFileSync(keyPath, 'utf8');
          } catch (e) {
            fail(new Error('Не удалось прочитать файл ключа: ' + e.message));
            return;
          }
        }
        let info;
        try {
          info = describeKey(keyData, passphrase);
        } catch (e) {
          fail(new Error(keyErrorMessage(e)));
          return;
        }
        if (!info.isPrivate) {
          fail(new Error('Выбран публичный ключ' + (/\.pub$/i.test(keyPath || '') ? ' (.pub)' : '') + ' — для входа нужен приватный ключ'));
          return;
        }
        log('debug1: Offering public key ' + info.type + ' ' + info.fingerprint);
        connectOpts.privateKey = keyData;
        if (passphrase) connectOpts.passphrase = passphrase;
      } else {
        connectOpts.password = password;
      }

      log('debug1: Connecting to ' + host + ' port ' + (port || 22) + '.');
      try {
        conn.connect(connectOpts);
      } catch (e) {
        fail(e);
      }
    });
  });

  ipcMain.on('ssh:write', (event, { connId, data }) => {
    const entry = connections.get(connId);
    if (!entry || !entry.stream || entry.stream.destroyed) return;
    // While the agent's command is running, typing would mix into its output: only Ctrl+C passes,
    // so the user can always interrupt what the agent started.
    if (termRuns.has(connId) && !String(data).includes('\x03')) return;
    entry.stream.write(data);
  });

  ipcMain.on('ssh:resize', (event, { connId, cols, rows }) => {
    const entry = connections.get(connId);
    if (entry && entry.stream && typeof entry.stream.setWindow === 'function') {
      entry.stream.setWindow(rows, cols, 0, 0);
    }
  });

  // ssh-copy-id: append a public key to ~/.ssh/authorized_keys of the connected user, unless it is already there.
  ipcMain.handle('keys:install', async (event, { connId, publicKey }) => {
    const entry = connections.get(connId);
    if (!entry) return { ok: false, error: 'Сессия не подключена' };
    const key = String(publicKey || '').trim();
    if (!/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-[\w@.-]+) [A-Za-z0-9+/=]+( [^\r\n]*)?$/.test(key) || key.includes('SSHKEY_EOF')) {
      return { ok: false, error: 'Некорректный публичный ключ' };
    }
    // The key travels inside a quoted heredoc, so its comment is never interpreted by the shell.
    const script = [
      'umask 077',
      "K=$(cat <<'SSHKEY_EOF'",
      key,
      'SSHKEY_EOF',
      ')',
      'B=$(printf %s "$K" | cut -d " " -f 1-2)',
      'D="$HOME/.ssh"; F="$D/authorized_keys"',
      'mkdir -p "$D" && chmod 700 "$D" && touch "$F" && chmod 600 "$F" || { echo KEY_FAILED; exit 1; }',
      'if grep -qF "$B" "$F"; then echo KEY_EXISTS; exit 0; fi',
      'if [ -s "$F" ] && [ -n "$(tail -c 1 "$F")" ]; then echo >> "$F"; fi',
      'printf "%s\\n" "$K" >> "$F" && echo KEY_ADDED',
      '',
    ].join('\n');
    const r = await execScript(entry.conn, script, 15000);
    if (/KEY_ADDED/.test(r.out)) return { ok: true, added: true };
    if (/KEY_EXISTS/.test(r.out)) return { ok: true, added: false };
    const detail = (r.err || r.out || r.error || '').trim().split('\n').pop();
    logError('ключ на сервер', new Error(detail || 'exit ' + r.code));
    return { ok: false, error: 'Не удалось записать ~/.ssh/authorized_keys' + (detail ? ': ' + detail.slice(0, 200) : '') };
  });

  ipcMain.handle('ssh:stats', async (event, { connId }) => {
    const entry = connections.get(connId);
    if (!entry) return { ok: false, error: 'not connected' };
    return collectStats(entry);
  });

  ipcMain.on('ssh:disconnect', (event, { connId }) => {
    stopTunnelsFor(connId, 'SSH-сессия отключена');
    if (sftpService) sftpService.closeFor(connId);
    const entry = connections.get(connId);
    if (entry) {
      try { entry.conn.end(); } catch (_) {}
      connections.delete(connId);
    }
  });

  ipcMain.on('ssh:host-key-decision', (event, { promptId, accept }) => {
    const resolver = hostKeyPrompts.get(promptId);
    if (resolver) {
      hostKeyPrompts.delete(promptId);
      resolver(accept);
    }
  });

  ipcMain.handle('net:test-tcp', (event, { host, port }) => {
    return new Promise((resolve) => {
      const started = Date.now();
      const socket = net.createConnection({ host, port: port || 22, timeout: 4000 });
      const done = (result) => { try { socket.destroy(); } catch (_) {} resolve(result); };
      socket.on('connect', () => done({ ok: true, rtt: Date.now() - started }));
      socket.on('timeout', () => done({ ok: false, error: 'Таймаут подключения (4000 мс)' }));
      socket.on('error', (err) => done({ ok: false, error: err.message }));
    });
  });

  ipcMain.handle('keys:parse', (event, { text, passphrase }) => {
    try {
      const info = describeKey(text, passphrase);
      if (!info.isPrivate) return { ok: false, error: 'Это публичный ключ — для входа нужен приватный' };
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: keyErrorMessage(e) };
    }
  });

  ipcMain.handle('keys:generate', (event, { type, passphrase, comment }) => {
    return new Promise((resolve) => {
      const opts = { comment: comment || '' };
      if (type === 'rsa') opts.bits = 4096;
      if (passphrase) { opts.passphrase = passphrase; opts.cipher = 'aes256-ctr'; }
      sshUtils.generateKeyPair(type === 'rsa' ? 'rsa' : 'ed25519', opts, (err, pair) => {
        if (err) { resolve({ ok: false, error: err.message }); return; }
        try {
          resolve({ ok: true, privateKey: pair.private, ...describeKey(pair.private, passphrase) });
        } catch (e) {
          resolve({ ok: false, error: keyErrorMessage(e) });
        }
      });
    });
  });

  ipcMain.handle('keys:open-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Импорт приватного SSH-ключа',
      properties: ['openFile'],
      defaultPath: path.join(app.getPath('home'), '.ssh'),
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    if (fs.statSync(filePath).size > 64 * 1024) return { path: filePath, error: 'Файл слишком большой для SSH-ключа' };
    return { path: filePath, text: fs.readFileSync(filePath, 'utf8') };
  });

  ipcMain.handle('keys:save-public', async (event, { name, publicKey }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Сохранить публичный ключ',
      defaultPath: path.join(app.getPath('home'), '.ssh', (name || 'id_key') + '.pub'),
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, publicKey.trim() + '\n');
    return result.filePath;
  });

  ipcMain.handle('dialog:select-key-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите приватный SSH-ключ',
      properties: ['openFile'],
      defaultPath: path.join(app.getPath('home'), '.ssh'),
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
}

/* ---------------- port forwarding (local forward over SSH) ---------------- */
const tunnels = new Map(); // tunnelId -> { server, connId, sockets:Set }

function stopTunnel(tunnelId, reason) {
  const t = tunnels.get(tunnelId);
  if (!t) return false;
  tunnels.delete(tunnelId);
  for (const sock of t.sockets) { try { sock.destroy(); } catch (_) {} }
  try { t.server.close(); } catch (_) {}
  if (reason) sendToRenderer('tunnel:stopped', { tunnelId, reason });
  return true;
}
function stopTunnelsFor(connId, reason) {
  for (const [id, t] of [...tunnels]) if (t.connId === connId) stopTunnel(id, reason);
}

function registerTunnelHandlers() {
  ipcMain.handle('tunnel:start', (event, { tunnelId, connId, lport, host, rport }) => {
    return new Promise((resolve) => {
      if (tunnels.has(tunnelId)) { resolve({ ok: true }); return; }
      if (!connections.has(connId)) { resolve({ ok: false, error: 'SSH-сессия не подключена' }); return; }
      const sockets = new Set();
      const report = () => sendToRenderer('tunnel:activity', { tunnelId, active: sockets.size });
      const server = net.createServer((sock) => {
        const entry = connections.get(connId);
        if (!entry) { sock.destroy(); return; }
        sockets.add(sock);
        report();
        sock.on('close', () => { sockets.delete(sock); report(); });
        sock.on('error', () => {});
        entry.conn.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, host, rport, (err, channel) => {
          if (err) {
            sendToRenderer('tunnel:error', { tunnelId, message: host + ':' + rport + ' — ' + err.message });
            sock.destroy();
            return;
          }
          channel.on('error', () => sock.destroy());
          sock.pipe(channel).pipe(sock);
        });
      });
      server.once('error', (err) => {
        const message = err.code === 'EADDRINUSE' ? 'Порт ' + lport + ' уже занят другой программой'
          : err.code === 'EACCES' ? 'Нет прав на порт ' + lport : err.message;
        resolve({ ok: false, error: message });
      });
      // Loopback only: forwarded services must not be exposed to the local network.
      server.listen(lport, '127.0.0.1', () => {
        tunnels.set(tunnelId, { server, connId, sockets });
        server.on('error', () => stopTunnel(tunnelId, 'ошибка локального порта'));
        resolve({ ok: true });
      });
    });
  });

  ipcMain.handle('tunnel:stop', (event, { tunnelId }) => ({ ok: stopTunnel(tunnelId) }));

  ipcMain.handle('tunnel:list', () => [...tunnels].map(([id, t]) => ({ tunnelId: id, connId: t.connId, active: t.sockets.size })));
}

/* ---------------- local shell (PTY) ---------------- */
const ptys = new Map(); // ptyId -> IPty

function whichExe(exe) {
  if (process.platform !== 'win32') return null;
  try {
    return execFileSync('where.exe', [exe], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}
function localShells() {
  if (process.platform !== 'win32') {
    const sh = process.env.SHELL || '/bin/bash';
    return { pwsh: sh, wps: sh, cmd: sh };
  }
  return {
    pwsh: whichExe('pwsh.exe'),
    wps: whichExe('powershell.exe'),
    cmd: process.env.ComSpec || whichExe('cmd.exe'),
  };
}

function registerLocalShellHandlers() {
  ipcMain.handle('local:shells', () => {
    const shells = localShells();
    return { available: Object.fromEntries(Object.entries(shells).map(([k, v]) => [k, !!v])), home: app.getPath('home') };
  });

  ipcMain.handle('local:spawn', (event, { ptyId, shell, cwd, cols, rows }) => {
    const file = localShells()[shell];
    if (!file) {
      const names = { pwsh: 'PowerShell 7', wps: 'Windows PowerShell', cmd: 'cmd' };
      return { ok: false, error: (names[shell] || shell) + ' не найден в системе' };
    }
    const dir = cwd && fs.existsSync(cwd) ? cwd : app.getPath('home');
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = shell === 'cmd' ? [] : (shell === 'wps' || shell === 'pwsh') && process.platform === 'win32' ? ['-NoLogo'] : [];
    let p;
    try {
      p = pty.spawn(file, args, { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: dir, env });
    } catch (e) {
      return { ok: false, error: 'Не удалось запустить оболочку: ' + e.message };
    }
    ptys.set(ptyId, p);
    p.onData((data) => sendToRenderer('local:data', { ptyId, data }));
    p.onExit(({ exitCode }) => {
      ptys.delete(ptyId);
      sendToRenderer('local:exit', { ptyId, exitCode });
    });
    return { ok: true, file, cwd: dir, pid: p.pid };
  });

  ipcMain.on('local:write', (event, { ptyId, data }) => {
    const p = ptys.get(ptyId);
    if (p) p.write(data);
  });

  ipcMain.on('local:resize', (event, { ptyId, cols, rows }) => {
    const p = ptys.get(ptyId);
    if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch (_) {} }
  });

  ipcMain.on('local:kill', (event, { ptyId }) => {
    const p = ptys.get(ptyId);
    if (p) { ptys.delete(ptyId); try { p.kill(); } catch (_) {} }
  });

  ipcMain.handle('local:pick-dir', async (event, { current }) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Стартовая папка локального shell',
      properties: ['openDirectory'],
      defaultPath: current && fs.existsSync(current) ? current : app.getPath('home'),
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });
}

/* ---------------- window ---------------- */
function createWindow() {
  const bounds = restoredBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#151618',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    title: 'ssh',
    // One frame only: the app's own titlebar is the window chrome (macOS keeps native traffic lights).
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 22 },
    show: false
  });

  mainWindow.loadURL(uiUrl);
  // The UI is a single local page: never navigate away or open new windows (e.g. a dropped file).
  const appPage = uiUrl;
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] !== appPage) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const sendWindowState = () => sendToRenderer('window-state', { maximized: mainWindow.isMaximized() });
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  mainWindow.webContents.on('did-finish-load', sendWindowState);

  mainWindow.once('ready-to-show', () => {
    aegis.alive();
    if (config.window && config.window.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('close', () => {
    config.window = { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() };
    try { saveConfig(); } catch {}
  });

  // Let the renderer flush pending vault writes before the window goes away.
  let allowClose = false;
  mainWindow.on('close', (e) => {
    if (allowClose || !vault || !vault.isUnlocked()) return;
    e.preventDefault();
    const done = () => {
      allowClose = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    };
    const timer = setTimeout(done, 2000);
    ipcMain.once('app:flushed', () => { clearTimeout(timer); done(); });
    mainWindow.webContents.send('app:flush');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

}

// Ask the renderer to write pending vault changes; resolves when it confirms or after 2 s.
function flushRenderer() {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed() || !vault || !vault.isUnlocked()) return resolve();
    const timer = setTimeout(resolve, 2000);
    ipcMain.once('app:flushed', () => { clearTimeout(timer); resolve(); });
    mainWindow.webContents.send('app:flush');
  });
}

// Reopen at the last size and position, unless that spot is no longer on any display.
function restoredBounds() {
  const saved = config.window;
  const fallback = { width: 1540, height: 900 };
  if (!saved || !saved.width || !saved.height) return fallback;
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x < a.x + a.width - 100 && saved.x + saved.width > a.x + 100 &&
    saved.y < a.y + a.height - 60 && saved.y >= a.y - 20);
  return visible ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: saved.width, height: saved.height };
}

ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.on('maximize-window', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

// One running copy: a second launch focuses the existing window (two copies would fight over the vault).
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  Menu.setApplicationMenu(null);
  uiUrl = (await uiserver.start(__dirname)).url;
  loadConfig();
  // Stable id of this computer: tells our own uploads apart from other computers' changes.
  if (!config.deviceId) { config.deviceId = require('crypto').randomBytes(8).toString('hex'); saveConfig(); }
  vault = new Vault(path.join(dataDir(), VAULT_NAME), config.deviceId);
  loadKnownHosts();
  // The Claude chat tunnel (ssh-proxy.js) takes the packetlab session's key from the vault and
  // trusts only the host key the user has already accepted here.
  require('./ssh-proxy').configure({
    getVaultData: () => (vault && vault.isUnlocked() ? vault.read() : null),
    knownHost: (host, port) => knownHosts[host + ':' + port] || null,
  });
  registerVaultHandlers();
  registerHello({
    ipcMain, vaultStatus, saveConfig,
    getVault: () => vault,
    getConfig: () => config,
    onUnlock: () => { if (syncService) syncService.onUnlock(); },
  });
  registerSshHandlers();
  registerTunnelHandlers();
  registerLocalShellHandlers();
  registerJournalHandlers();
  sftpService = registerSftp({
    ipcMain, dialog, shell, app, sendToRenderer, logError,
    getConnection: (connId) => connections.get(connId),
    getWindow: () => mainWindow,
  });
  agentService = registerAgent({
    ipcMain, app, sendToRenderer, logError, sftp: sftpService, runInTerminal, listTargets,
    getConnection: (connId) => connections.get(connId),
  });
  syncService = registerSync({
    ipcMain, app, shell, safeStorage, sendToRenderer, logError, saveConfig,
    getConfig: () => config,
    getVault: () => vault,
    getWindow: () => mainWindow,
  });
  registerGithub({
    ipcMain, app, shell, dialog, logError,
    getConnection: (connId) => connections.get(connId),
    getWindow: () => mainWindow,
  });
  netToolsService = registerNetTools({ ipcMain, sendToRenderer, logError });
  registerUpdater({
    ipcMain, app, sendToRenderer, logError, saveConfig,
    getConfig: () => config,
    beforeInstall: flushRenderer,
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (vault) vault.lock();
  if (agentService) agentService.shutdown();
  if (netToolsService) netToolsService.shutdown();
  for (const id of [...tunnels.keys()]) stopTunnel(id);
  for (const p of ptys.values()) { try { p.kill(); } catch (_) {} }
  ptys.clear();
  for (const { conn } of connections.values()) {
    try { conn.end(); } catch (_) {}
  }
  connections.clear();
});
