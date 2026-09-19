// Claude Code inside the SSH client.
//
// The ACP adapter (@agentclientprotocol/claude-agent-acp) runs as a child process and drives the
// user's installed Claude Code. Its built-in local tools are disabled; instead this process serves
// an MCP server on 127.0.0.1 whose tools act on the selected SSH connection. Every command and
// every file write waits for the user's approval here, independent of Claude Code's own settings.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { Readable, Writable } = require('stream');

const MCP_NAME = 'ssh';
const READ_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 30000;
const LOCAL_TOOLS_OFF = ['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS'];

const LOCAL_ID = 'local';

const SYSTEM_APPEND_LOCAL = [
  'You are running inside an SSH client, but this chat targets the local computer it runs on, not a remote server.',
  "Claude Code's own local tools are disabled. Use only the mcp__ssh__* tools: run_command, read_file, list_directory, write_file, edit_file.",
  'Paths are paths on this computer; relative paths resolve against the working directory shown above. Every run_command, write_file and edit_file call is shown to the user for approval, so keep commands focused and explain briefly why you run them.',
  'Prefer non-interactive commands. Reply in the language the user writes in.',
].join('\n');

const SYSTEM_APPEND = [
  'You are running inside an SSH client and operate on a remote server over SSH, not on the local computer.',
  'Local file and shell tools are disabled. Use only the mcp__ssh__* tools: run_command, read_file, list_directory, write_file, edit_file.',
  'Paths are paths on the remote server. Every run_command, write_file and edit_file call is shown to the user for approval, so keep commands focused and explain briefly why you run them.',
  'Prefer non-interactive commands (no pagers, no editors, add -y only when the user asked for changes). Reply in the language the user writes in.',
].join('\n');

function clip(text, limit) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.4);
  return text.slice(0, head) + '\n… [вывод сокращён: ' + (text.length - limit) + ' символов] …\n' + text.slice(text.length - (limit - head));
}
const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

/* ---------------- Claude Code detection ---------------- */
function claudeCandidates() {
  const out = [];
  if (process.env.CLAUDE_CODE_EXECUTABLE) out.push(process.env.CLAUDE_CODE_EXECUTABLE);
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const f of found) {
      if (/\.exe$/i.test(f) || process.platform !== 'win32') out.push(f);
      // npm puts a claude.cmd shim next to node_modules; the real binary lives in the package.
      out.push(path.join(path.dirname(f), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe));
    }
  } catch {}
  const home = process.env.USERPROFILE || process.env.HOME || '';
  out.push(path.join(home, '.local', 'bin', exe));
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe));
  return [...new Set(out)];
}
let detected = null;
function detectClaude(force) {
  if (detected && !force) return Promise.resolve(detected);
  const file = claudeCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!file) {
    detected = { found: false, error: 'Claude Code не найден. Установите: npm install -g @anthropic-ai/claude-code' };
    return Promise.resolve(detected);
  }
  return new Promise((resolve) => {
    execFile(file, ['--version'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      detected = err
        ? { found: false, path: file, error: 'Не удалось запустить Claude Code: ' + err.message }
        : { found: true, path: file, version: String(stdout).trim() };
      resolve(detected);
    });
  });
}

function adapterEntry() {
  return path.join(__dirname, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
}

module.exports = function registerAgent({ ipcMain, app, sendToRenderer, getConnection, sftp, logError }) {
  const chats = new Map(); // chatId -> chat state
  const tokens = new Map(); // bearer token -> chatId
  const approvals = new Map(); // approvalId -> resolve(allow, always)
  const permissions = new Map(); // requestId -> resolve(optionId|null)
  let mcpPort = 0;

  /* ---- secrets: the model never sees a value.
   * The renderer pushes what the open vault holds; the agent can only name a secret. The value is
   * substituted when the command starts and cut back out of the output, so nothing lands in the
   * conversation or in the saved transcript. */
  let secrets = [];
  ipcMain.on('secrets:sync', (event, { list }) => { secrets = Array.isArray(list) ? list : []; });

  const SECRET_RE = /\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
  const placeholder = (name) => '{{secret:' + name + '}}';
  const secretNames = () => secrets.filter((s) => s.agentAccess && (!s.expiresAt || s.expiresAt > Date.now())).map((s) => s.name);

  function secretFor(chat, name) {
    const s = secrets.find((x) => x.name === name);
    if (!s) return { error: 'секрет «' + name + '» не заведён — владелец создаёт его в разделе «Секреты»' };
    if (!s.agentAccess) return { error: 'секрет «' + name + '» недоступен — включите доступ в разделе «Секреты»' };
    if (s.expiresAt && s.expiresAt <= Date.now()) return { error: 'секрет «' + name + '»: срок доступа истёк — продлите его в разделе «Секреты»' };
    const scope = s.scope || [];
    if (scope.length && !scope.includes(chat.profileId)) return { error: 'секрет «' + name + '» не разрешён для этой сессии' };
    return { value: s.value };
  }
  // Every known value is cut out, not only the ones this call asked for: a command may print a
  // secret the agent never requested. Short values are left alone — they would shred the output.
  function redact(out) {
    let s = String(out);
    for (const item of secrets) {
      if (!item.value || item.value.length < 6) continue;
      if (s.includes(item.value)) s = s.split(item.value).join(placeholder(item.name));
    }
    return s;
  }
  // Names the call needs: asked for by env_secrets, or written into the command as {{secret:NAME}}.
  function collectSecrets(chat, command, envSecrets) {
    const inCommand = (String(command).match(SECRET_RE) || []).map((m) => m.slice(9, -2));
    const names = [...new Set([...(envSecrets || []), ...inCommand])];
    const values = new Map();
    const errors = [];
    for (const name of names) {
      const r = secretFor(chat, name);
      if (r.error) errors.push(r.error); else values.set(name, r.value);
    }
    return { names, values, errors };
  }

  /* ---- durable per-server memory: resumable ACP session id + "always allow" tool decisions.
   * Keyed by the saved session's stable profile id (not connId, which is a fresh id per connect
   * attempt), so a dropped SSH link or an app restart can pick the same Claude conversation back up. */
  const memoryFile = path.join(app.getPath('userData'), 'claude-memory.json');
  let memory = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) memory = parsed;
  } catch (_) {}
  function saveMemory() {
    try { fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2)); } catch (e) { logError('claude (память)', e); }
  }
  /* ---- durable per-server chat transcript: what the user sees in the log, so a restart or
   * update shows the past conversation instead of an empty panel. Separate from `memory` above,
   * which is what Claude itself resumes from (session id) — this is only for display. */
  const HISTORY_CAP = 200;
  const historyFile = path.join(app.getPath('userData'), 'claude-history.json');
  let history = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) history = parsed;
  } catch (_) {}
  function saveHistory() {
    try { fs.writeFileSync(historyFile, JSON.stringify(history)); } catch (e) { logError('claude (история)', e); }
  }

  function memFor(profileId) {
    if (!profileId) return null;
    const m = memory[profileId] || (memory[profileId] = {});
    if (!m.autoApprove || typeof m.autoApprove !== 'object') m.autoApprove = {};
    return m;
  }

  function workspaceDir() {
    const d = path.join(app.getPath('userData'), 'claude-workspace');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /* ---- approvals for remote actions ---- */
  function askApproval(chat, tool, summary, detail) {
    if (chat.autoApprove.has(tool)) return Promise.resolve(true);
    const approvalId = crypto.randomUUID();
    return new Promise((resolve) => {
      approvals.set(approvalId, (allow, always) => {
        chat.pendingApprovals.delete(approvalId);
        if (allow && always) {
          chat.autoApprove.add(tool);
          const m = memFor(chat.profileId);
          if (m) { m.autoApprove[tool] = true; saveMemory(); }
        }
        resolve(!!allow);
      });
      chat.pendingApprovals.add(approvalId);
      sendToRenderer('agent:approval', { chatId: chat.chatId, approvalId, tool, summary, detail });
    });
  }
  function rejectPending(chat) {
    for (const id of [...chat.pendingApprovals]) {
      const r = approvals.get(id);
      approvals.delete(id);
      if (r) r(false);
      sendToRenderer('agent:approval-closed', { chatId: chat.chatId, approvalId: id });
    }
    for (const [id, p] of [...permissions]) {
      if (p.chatId === chat.chatId) { permissions.delete(id); p.resolve(null); }
    }
  }

  // The local target runs commands through a shell on this computer instead of over SSH.
  function localShell() {
    if (process.platform !== 'win32') return { file: '/bin/sh', pre: ['-c'] };
    for (const exe of ['pwsh.exe', 'powershell.exe']) {
      try { execFileSync('where.exe', [exe], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); return { file: exe, pre: ['-NoProfile', '-NonInteractive', '-Command'] }; } catch (_) {}
    }
    return { file: 'cmd.exe', pre: ['/d', '/s', '/c'] };
  }
  function execLocal(command, cwd, timeoutMs, env) {
    return new Promise((resolve) => {
      const started = Date.now();
      const sh = localShell();
      const child = spawn(sh.file, [...sh.pre, command], { cwd: cwd || workspaceDir(), windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
      let out = '';
      let timedOut = false;
      const add = (d) => { if (out.length < OUTPUT_LIMIT * 4) out += d.toString('utf8'); };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch (_) {} }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); resolve({ output: 'Не удалось запустить оболочку: ' + e.message, code: null, signal: null, timedOut, ms: Date.now() - started }); });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ output: out, code, signal, timedOut, ms: Date.now() - started }); });
    });
  }
  function localRead(p, limit) {
    const target = localResolve(p);
    const size = fs.statSync(target).size;
    const len = Math.min(size, limit);
    const fd = fs.openSync(target, 'r');
    try {
      const data = Buffer.alloc(len);
      fs.readSync(fd, data, 0, len, 0);
      return { data, size, truncated: size > len };
    } finally { fs.closeSync(fd); }
  }
  function localList(p) {
    const target = localResolve(p || '.');
    const entries = fs.readdirSync(target, { withFileTypes: true }).map((e) => {
      let size = 0;
      let mode = 0;
      try { const st = fs.statSync(path.join(target, e.name)); size = st.size; mode = st.mode & 0o777; } catch (_) {}
      return { name: e.name, dir: e.isDirectory(), size, perms: (e.isDirectory() ? 'd' : '-') + mode.toString(8).padStart(3, '0') };
    });
    return { path: target, entries };
  }
  function localWrite(p, content) {
    const target = localResolve(p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }

  const localResolve = (p) => {
    let t = String(p);
    if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) t = path.join(app.getPath('home'), t.slice(1));
    return path.resolve(workspaceDir(), t);
  };

  // stdin carries the secret exports when there are any: the SSH server needs no AcceptEnv, and
  // the values never appear in argv, so `ps` on the server shows nothing.
  function execRemote(connId, command, timeoutMs, stdin) {
    return new Promise((resolve, reject) => {
      const entry = getConnection(connId);
      if (!entry) { reject(new Error('SSH-сессия не подключена')); return; }
      const started = Date.now();
      entry.conn.exec(command, (err, stream) => {
        if (err) { reject(err); return; }
        let out = '';
        let timedOut = false;
        const add = (d) => { if (out.length < OUTPUT_LIMIT * 4) out += d.toString('utf8'); };
        stream.on('data', add);
        stream.stderr.on('data', add);
        if (stdin != null) stream.end(stdin);
        const timer = setTimeout(() => { timedOut = true; try { stream.close(); } catch (_) {} }, timeoutMs);
        let code = null;
        let signal = null;
        stream.on('exit', (c, s) => { code = c; signal = s; });
        stream.on('close', () => {
          clearTimeout(timer);
          resolve({ output: out, code, signal, timedOut, ms: Date.now() - started });
        });
      });
    });
  }

  // Redaction sits here so every tool is covered: whatever a tool returns, no secret rides along.
  const text = (t, isError) => ({ content: [{ type: 'text', text: redact(t) }], ...(isError ? { isError: true } : {}) });

  function buildMcp(chat) {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const z = require('zod');
    const server = new McpServer({ name: 'ssh-client', version: '1.0.0' });
    const where = chat.local ? 'on this computer' : 'on the remote server';
    const secretHelp = () => {
      const names = secretNames();
      return names.length
        ? ' Secrets available to you: ' + names.join(', ') + '. Name them in env_secrets and they arrive as environment variables, or write {{secret:NAME}} inside the command. The app substitutes the value when the command starts and cuts it out of the output, so you never see it — never ask the user to paste a secret into the chat.'
        : ' No secrets are available to you right now. If a command needs an API key, ask the user to add it in the app section «Секреты» and switch on agent access — do not ask them to paste the value into the chat.';
    };
    // Values ride in over stdin, so they stay out of argv and need no AcceptEnv on the server.
    const remoteScript = (values, command) =>
      [...values].map(([name, value]) => name + '=' + shQuote(value) + '; export ' + name).join('\n') + '\n' + command + '\n';
    const conn = () => chat.connId;
    // SFTP does not expand ~, the shell does: resolve it against the SFTP home directory.
    const remotePath = async (p) => {
      if (p === '~' || p.startsWith('~/')) return (await sftp.home(conn())).replace(/\/+$/, '') + p.slice(1);
      return p;
    };
    const guard = async (fn) => {
      try { return await fn(); } catch (e) { return text('Ошибка: ' + ((e && e.message) || e), true); }
    };

    server.registerTool('run_command', {
      description: 'Run a shell command ' + where + (chat.local ? '' : ' over SSH') + ' (non-interactive). Returns combined stdout/stderr and the exit code. The user approves every call.' + secretHelp(),
      inputSchema: {
        command: z.string().describe('Shell command to run'),
        cwd: z.string().optional().describe(chat.local ? 'Working directory on this computer' : 'Remote working directory'),
        timeout_seconds: z.number().int().min(1).max(900).optional().describe('Kill the command after this many seconds (default 120)'),
        env_secrets: z.array(z.string()).optional().describe('Names of secrets to pass to the command as environment variables. The app fills in the values; they are never shown to you.'),
      },
    }, ({ command, cwd, timeout_seconds, env_secrets }) => guard(async () => {
      const sec = collectSecrets(chat, command, env_secrets);
      if (sec.errors.length) return text('Команда не выполнена: ' + sec.errors.join('; ') + '.', true);
      const cdTarget = !cwd ? '' : cwd === '~' ? '~' : cwd.startsWith('~/') ? '"$HOME"/' + shQuote(cwd.slice(2)) : shQuote(cwd);
      const full = cwd ? 'cd ' + cdTarget + ' && ' + command : command;
      // A separate tool key for secret calls: «always allow» for plain commands must not silently
      // extend to commands that carry a key.
      const ok = await askApproval(chat, sec.names.length ? 'run_command_secret' : 'run_command', command,
        [cwd ? 'в папке ' + cwd : '', sec.names.length ? 'секреты: ' + sec.names.join(', ') : ''].filter(Boolean).join(' · '));
      if (!ok) return text('Пользователь отклонил выполнение команды.', true);
      const limit = (timeout_seconds || 120) * 1000;
      const fill = (s) => s.replace(SECRET_RE, (m, name) => (sec.values.has(name) ? sec.values.get(name) : m));
      const r = chat.local
        ? await execLocal(fill(command), cwd ? localResolve(cwd) : null, limit, Object.fromEntries(sec.values))
        : sec.values.size
          ? await execRemote(conn(), 'sh -s', limit, remoteScript(sec.values, fill(full)))
          : await execRemote(conn(), full, limit);
      const status = r.timedOut ? 'timed out after ' + (timeout_seconds || 120) + 's' : 'exit code ' + (r.code === null ? '?' : r.code) + (r.signal ? ', signal ' + r.signal : '');
      sendToRenderer('agent:action', { chatId: chat.chatId, tool: 'run_command', summary: command, result: status + (sec.names.length ? ' · секреты: ' + sec.names.join(', ') : '') });
      return text('[' + status + ', ' + r.ms + ' ms]\n' + clip(r.output, OUTPUT_LIMIT), r.timedOut || (r.code !== 0 && r.code !== null));
    }));

    server.registerTool('read_file', {
      description: 'Read a text file ' + where + ' (up to 256 KB).',
      inputSchema: { path: z.string().describe(chat.local ? 'Absolute path, or relative to the working directory' : 'Absolute or home-relative remote path') },
    }, ({ path: file }) => guard(async () => {
      const r = chat.local ? localRead(file, READ_LIMIT) : await sftp.readText(conn(), await remotePath(file), READ_LIMIT);
      if (r.data.includes(0)) return text('Файл двоичный — прочитать как текст нельзя (' + r.size + ' байт).', true);
      return text((r.truncated ? '[показаны первые ' + r.data.length + ' из ' + r.size + ' байт]\n' : '') + r.data.toString('utf8'));
    }));

    server.registerTool('list_directory', {
      description: 'List a directory ' + where + '.',
      inputSchema: { path: z.string().optional().describe('Remote directory (default: home)') },
    }, ({ path: dir }) => guard(async () => {
      const r = chat.local ? localList(dir) : await sftp.listDir(conn(), dir ? await remotePath(dir) : '.');
      const lines = r.entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
        .map((e) => e.perms + ' ' + String(e.dir ? '-' : e.size).padStart(10) + ' ' + e.name + (e.dir ? '/' : ''));
      return text(r.path + '\n' + lines.join('\n'));
    }));

    server.registerTool('write_file', {
      description: 'Create or overwrite a text file ' + where + '. The user approves every call.',
      inputSchema: { path: z.string(), content: z.string() },
    }, ({ path: file, content }) => guard(async () => {
      const ok = await askApproval(chat, 'write_file', file, clip(content, 4000));
      if (!ok) return text('Пользователь отклонил запись файла.', true);
      if (chat.local) localWrite(file, content); else await sftp.writeText(conn(), await remotePath(file), content);
      sendToRenderer('agent:action', { chatId: chat.chatId, tool: 'write_file', summary: file, result: Buffer.byteLength(content) + ' байт' });
      return text('Записано ' + Buffer.byteLength(content) + ' байт в ' + file);
    }));

    server.registerTool('edit_file', {
      description: 'Replace an exact text fragment in a file ' + where + '. old_string must occur exactly once unless replace_all is true. The user approves every call.',
      inputSchema: { path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
    }, ({ path: file, old_string, new_string, replace_all }) => guard(async () => {
      const target = chat.local ? file : await remotePath(file);
      const r = chat.local ? localRead(file, 4 * 1024 * 1024) : await sftp.readText(conn(), target, 4 * 1024 * 1024);
      if (r.truncated) return text('Файл больше 4 МБ — правка не поддерживается.', true);
      const src = r.data.toString('utf8');
      const count = old_string ? src.split(old_string).length - 1 : 0;
      if (!count) return text('Фрагмент old_string не найден в файле.', true);
      if (count > 1 && !replace_all) return text('Фрагмент встречается ' + count + ' раз — уточните его или передайте replace_all: true.', true);
      const ok = await askApproval(chat, 'edit_file', file, '— ' + clip(old_string, 1800) + '\n+ ' + clip(new_string, 1800) + (count > 1 ? '\n(замен: ' + count + ')' : ''));
      if (!ok) return text('Пользователь отклонил правку файла.', true);
      const next = replace_all ? src.split(old_string).join(new_string) : src.replace(old_string, () => new_string);
      if (chat.local) localWrite(target, next); else await sftp.writeText(conn(), target, next);
      sendToRenderer('agent:action', { chatId: chat.chatId, tool: 'edit_file', summary: file, result: 'замен: ' + (replace_all ? count : 1) });
      return text('Файл ' + file + ' изменён.');
    }));
    return server;
  }

  const mcpHttp = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '');
    const chatId = tokens.get(auth.replace(/^Bearer\s+/i, ''));
    const chat = chatId && chats.get(chatId);
    if (!chat) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
      const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
      const server = buildMcp(chat);
      try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        logError('claude (mcp)', e);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal server error"},"id":null}');
      }
    });
  });
  const mcpReady = new Promise((resolve) => mcpHttp.listen(0, '127.0.0.1', () => { mcpPort = mcpHttp.address().port; resolve(); }));

  /* ---- ACP chat lifecycle ---- */
  function status(chat, state, message, resumed) {
    chat.state = state;
    sendToRenderer('agent:status', { chatId: chat.chatId, connId: chat.connId, state, message: message || '', resumed: !!resumed });
  }

  function closeChat(chat, reason) {
    if (!chats.has(chat.chatId)) return;
    rejectPending(chat);
    chats.delete(chat.chatId);
    tokens.delete(chat.token);
    if (chat.session) { try { chat.session.dispose(); } catch (_) {} }
    if (chat.finish) chat.finish();
    if (chat.proc && chat.proc.exitCode === null) { try { chat.proc.kill(); } catch (_) {} }
    status(chat, 'closed', reason);
  }

  async function startChat(chat) {
    const claude = await detectClaude();
    if (!claude.found) throw new Error(claude.error);
    await mcpReady;
    const acp = await import('@agentclientprotocol/sdk');
    const workspace = workspaceDir();

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_EXECUTABLE: claude.path };
    const proc = spawn(process.execPath, [adapterEntry()], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    chat.proc = proc;
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.on('exit', (code) => {
      if (chats.has(chat.chatId)) {
        logError('claude (адаптер)', { message: 'Процесс адаптера завершился с кодом ' + code, stack: stderr.trim().split('\n').slice(-12).join('\n') });
        closeChat(chat, 'Процесс Claude завершился (код ' + code + ')');
      }
    });

    const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
    const toolNames = new Map();
    const finished = new Promise((resolve) => { chat.finish = resolve; });

    const clientApp = acp.client({ name: 'ssh-client' })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const p = ctx.params;
        const toolName = toolNames.get(p.toolCall.toolCallId) || '';
        const pick = (kinds) => (p.options.find((o) => kinds.includes(o.kind)) || {}).optionId;
        // Our SSH tools run their own approval with the exact command/diff, so don't ask twice.
        if (toolName.startsWith('mcp__' + MCP_NAME + '__')) {
          const id = pick(['allow_once']) || pick(['allow_always']);
          if (id) return { outcome: { outcome: 'selected', optionId: id } };
        }
        const requestId = crypto.randomUUID();
        const optionId = await new Promise((resolve) => {
          permissions.set(requestId, { chatId: chat.chatId, resolve });
          sendToRenderer('agent:permission', {
            chatId: chat.chatId, requestId, toolName,
            title: p.toolCall.title || toolName,
            rawInput: p.toolCall.rawInput === undefined ? null : p.toolCall.rawInput,
            options: p.options.filter((o) => o.kind === 'allow_once' || o.kind === 'reject_once').map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
          });
        });
        return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
      });

    clientApp.connectWith(stream, async (ctx) => {
      chat.ctx = ctx;
      chat.acp = acp;
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const mcpServers = [{ type: 'http', name: MCP_NAME, url: 'http://127.0.0.1:' + mcpPort + '/mcp', headers: [{ name: 'Authorization', value: 'Bearer ' + chat.token }] }];
      const sessionMeta = { systemPrompt: { append: chat.local ? SYSTEM_APPEND_LOCAL : SYSTEM_APPEND }, claudeCode: { options: { disallowedTools: LOCAL_TOOLS_OFF } } };
      let resumed = false;
      if (chat.resumeSessionId) {
        try {
          const loadResp = await ctx.request(acp.methods.agent.session.load, {
            sessionId: chat.resumeSessionId, cwd: workspace, mcpServers, _meta: sessionMeta,
          });
          // session/load only returns capability fields, not sessionId — attachSession keys its
          // update routing off response.sessionId, so we splice the id we asked to load back in.
          // Attaching after the call means the history the agent replays during it is discarded:
          // Claude keeps the full context, the chat log starts clean instead of repeating itself.
          chat.session = ctx.attachSession({ ...loadResp, sessionId: chat.resumeSessionId });
          resumed = true;
        } catch (e) {
          logError('claude (возобновление)', e);
        }
      }
      if (!chat.session) {
        chat.session = await ctx.buildSession({ cwd: workspace, mcpServers, _meta: sessionMeta }).start();
      }
      const mem = memFor(chat.profileId);
      if (mem) { mem.sessionId = chat.session.sessionId; saveMemory(); }
      status(chat, 'ready', '', resumed);
      const configOptions = (chat.session.newSessionResponse && chat.session.newSessionResponse.configOptions) || null;
      if (configOptions) sendToRenderer('agent:update', { chatId: chat.chatId, update: { sessionUpdate: 'config_option_update', configOptions } });
      (async () => {
        while (chats.has(chat.chatId)) {
          let m;
          try { m = await chat.session.nextUpdate(); } catch { break; }
          if (m.kind === 'stop') {
            chat.busy = false;
            sendToRenderer('agent:stop', { chatId: chat.chatId, stopReason: m.stopReason });
            continue;
          }
          const u = m.update;
          if ((u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && u._meta && u._meta.claudeCode && u._meta.claudeCode.toolName) {
            toolNames.set(u.toolCallId, u._meta.claudeCode.toolName);
          }
          sendToRenderer('agent:update', { chatId: chat.chatId, update: u });
        }
      })();
      await finished;
    }).catch((e) => {
      if (!chats.has(chat.chatId)) return;
      const msg = (e && e.message) || String(e);
      const auth = /auth|login|log in|credential|unauthori/i.test(msg);
      logError('claude', { message: msg + (stderr ? '\n' + stderr.trim().split('\n').slice(-6).join('\n') : ''), stack: e && e.stack });
      closeChat(chat, auth ? 'Нужен вход в Claude Code: запустите «claude» в локальном терминале и выполните /login' : msg);
    });
  }

  ipcMain.handle('agent:detect', async (event, { force } = {}) => detectClaude(!!force));

  ipcMain.handle('agent:start', async (event, { connId, profileId, fresh }) => {
    const isLocal = connId === LOCAL_ID;
    if (!isLocal && !getConnection(connId)) return { ok: false, error: 'SSH-сессия не подключена' };
    for (const c of chats.values()) if (c.connId === connId) closeChat(c, 'Начат новый чат');
    const m = memFor(profileId);
    const chat = {
      chatId: crypto.randomUUID(), connId, profileId: profileId || null, local: isLocal,
      token: crypto.randomBytes(32).toString('hex'), state: 'starting', busy: false,
      pendingApprovals: new Set(),
      // "Always allow" decisions survive a deliberate new chat; conversation memory does not.
      autoApprove: new Set(m ? Object.keys(m.autoApprove).filter((k) => m.autoApprove[k]) : []),
      resumeSessionId: (!fresh && m && m.sessionId) || null,
    };
    chats.set(chat.chatId, chat);
    tokens.set(chat.token, chat.chatId);
    status(chat, 'starting');
    startChat(chat).catch((e) => closeChat(chat, (e && e.message) || String(e)));
    return { ok: true, chatId: chat.chatId };
  });

  ipcMain.handle('agent:forget', async (event, { profileId }) => {
    if (profileId && memory[profileId]) { delete memory[profileId]; saveMemory(); }
    if (profileId && history[profileId]) { delete history[profileId]; saveHistory(); }
    return { ok: true };
  });

  ipcMain.handle('agent:load-transcript', async (event, { profileId }) => {
    return { ok: true, items: (profileId && history[profileId]) || [] };
  });

  ipcMain.handle('agent:save-transcript', async (event, { profileId, items }) => {
    if (!profileId) return { ok: false };
    if (!Array.isArray(items) || !items.length) delete history[profileId]; else history[profileId] = items.slice(-HISTORY_CAP);
    saveHistory();
    return { ok: true };
  });

  ipcMain.handle('agent:prompt', async (event, { chatId, content }) => {
    const chat = chats.get(chatId);
    if (!chat || !chat.session) return { ok: false, error: 'Claude ещё не готов' };
    if (chat.busy) return { ok: false, error: 'Claude ещё отвечает — дождитесь или остановите' };
    chat.busy = true;
    chat.session.prompt(content).catch((e) => {
      chat.busy = false;
      sendToRenderer('agent:stop', { chatId, stopReason: 'error', error: (e && e.message) || String(e) });
    });
    return { ok: true };
  });

  ipcMain.handle('agent:set-config-option', async (event, { chatId, configId, value }) => {
    const chat = chats.get(chatId);
    if (!chat || !chat.ctx || !chat.session) return { ok: false, error: 'Claude ещё не готов' };
    try {
      const resp = await chat.ctx.request(chat.acp.methods.agent.session.setConfigOption, { sessionId: chat.session.sessionId, configId, value });
      // The adapter answers with the refreshed options and sends no config_option_update,
      // so mirror them back or the picker keeps showing the previous value.
      if (resp && resp.configOptions) sendToRenderer('agent:update', { chatId: chat.chatId, update: { sessionUpdate: 'config_option_update', configOptions: resp.configOptions } });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle('agent:cancel', async (event, { chatId }) => {
    const chat = chats.get(chatId);
    if (!chat || !chat.ctx || !chat.session) return { ok: false };
    rejectPending(chat);
    await chat.ctx.notify(chat.acp.methods.agent.session.cancel, { sessionId: chat.session.sessionId }).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('agent:close', async (event, { chatId }) => {
    const chat = chats.get(chatId);
    if (chat) closeChat(chat, 'Чат завершён');
    return { ok: true };
  });

  ipcMain.on('agent:approval-decision', (event, { approvalId, allow, always }) => {
    const r = approvals.get(approvalId);
    if (r) { approvals.delete(approvalId); r(allow, always); }
  });

  ipcMain.on('agent:permission-decision', (event, { requestId, optionId }) => {
    const p = permissions.get(requestId);
    if (p) { permissions.delete(requestId); p.resolve(optionId || null); }
  });

  return {
    closeFor(connId) {
      for (const c of [...chats.values()]) if (c.connId === connId) closeChat(c, 'SSH-сессия закрыта');
    },
    shutdown() {
      for (const c of [...chats.values()]) closeChat(c, 'Приложение закрывается');
      try { mcpHttp.close(); } catch (_) {}
    },
  };
};
