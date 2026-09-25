// Claude's own traffic: one local HTTP CONNECT bridge that picks the way out per connection.
//
// The chat used to decide once, at start: direct, sing-box's mixed port or an SSH tunnel. When
// sing-box went away mid-conversation (stopped for Sovereign's TUN tests, crashed, switched off),
// the running CLI kept its choice - and "direct" through a TUN that no longer existed meant the
// plain ISP line, where api.anthropic.com answers every request with a country-block 403. Now the
// CLI always talks to this bridge, and every new CONNECT is routed on the state of the moment:
//   1. direct - when the API edge does not see a blocked country (sing-box TUN up, or not in RU);
//   2. sing-box's mixed inbound on 127.0.0.1:2080, if it listens;
//   3. an SSH tunnel to the packetlab server (loc=DE), which needs nothing local but a network.
// A way that fails to open falls through to the next. The SSH hop runs in-process on ssh2 with the
// key of the vault's packetlab session and the app's own known_hosts, so it works on a fresh Windows
// as soon as the vault has synced; without such a session it falls back to the system ssh.exe -D.
const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client: SSHClient } = require('ssh2');
const { SocksClient } = require('socks');

const API_HOST = 'api.anthropic.com';
const SINGBOX_PORT = 2080;
const BRIDGE_PORT = 2092;
const SOCKS_PORT = 2091;                 // ssh.exe -D, the last resort
const TUNNEL_HOSTS = ['5.83.147.210', 'server.packetlab.tech', 'packetlab.tech'];
const SSH_EXE_TARGET = 'root@5.83.147.210';

// singboxPort / localAddress are diagnostics: bound to the Wi-Fi address with a closed sing-box port,
// the bridge sees the world exactly as it is with sing-box off - without switching it off.
let deps = { getVaultData: () => null, knownHost: () => null, singboxPort: SINGBOX_PORT, localAddress: undefined };
function configure(d) { deps = { ...deps, ...d }; }

/* ---- is direct allowed? Reaching the API is not the same as being allowed to use it: from this
 * user's plain ISP line (Russia) the TLS handshake with api.anthropic.com works, and every request
 * then comes back as 403 {"type":"forbidden"} - a country block, no request_id (24.09.2026). So ask
 * the edge where it thinks we are: /cdn-cgi/trace on the API host is answered by Cloudflare itself
 * and reports loc=<country> for this exact path. A blocked country, a failed handshake (DPI) or a
 * timeout mean "not direct"; no loc line at all means the handshake worked, so direct it is. */
const BLOCKED_LOC = new Set(['RU', 'BY', 'CN', 'HK', 'MO', 'IR', 'KP', 'SY', 'CU']);
function probeDirect(timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get({ host: API_HOST, path: '/cdn-cgi/trace', timeout: timeoutMs, agent: false, localAddress: deps.localAddress }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(!BLOCKED_LOC.has(((body.match(/^loc=(\w+)$/m) || [])[1] || '').toUpperCase())));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
// The answer changes when sing-box comes or goes, so it lives for a few seconds only - the CLI
// keeps its connections alive and opens new ones rarely, the probe is ~0.3 s.
let direct = { ok: false, at: 0 };
let directPending = null;
function directAllowed() {
  if (Date.now() - direct.at < 5000) return Promise.resolve(direct.ok);
  if (!directPending) {
    directPending = probeDirect(1500).then((ok) => { direct = { ok, at: Date.now() }; directPending = null; return ok; });
  }
  return directPending;
}
function forgetDirect() { direct.at = 0; }

/* ---- the ways out; each resolves with a connected duplex stream or rejects */
function openDirect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port, timeout: 5000, localAddress: deps.localAddress });
    s.once('connect', () => { s.setTimeout(0); resolve(s); });
    s.once('timeout', () => { s.destroy(); reject(new Error('timeout')); });
    s.once('error', reject);
  });
}

function openSocks(proxyPort, host, port) {
  return SocksClient.createConnection({
    proxy: { host: '127.0.0.1', port: proxyPort, type: 5 },
    command: 'connect', destination: { host, port }, timeout: 5000,
  }).then(({ socket }) => socket);
}

// The vault's session for the packetlab server, as ssh2 options. null when the vault is locked or
// there is no usable session - the caller falls through to ssh.exe.
function tunnelTarget() {
  let data;
  try { data = deps.getVaultData(); } catch { return null; }
  if (!data) return null;
  const s = (data.sessions || []).find((x) => TUNNEL_HOSTS.includes(String(x.host || '').toLowerCase()));
  if (!s) return null;
  const opts = { host: s.host, port: Number(s.port) || 22, username: s.user, readyTimeout: 8000, keepaliveInterval: 15000, localAddress: deps.localAddress };
  if (s.auth === 'key') {
    const k = s.keyId && (data.keys || []).find((x) => x.id === s.keyId && x.privateKey);
    if (k) {
      opts.privateKey = k.privateKey;
      if (k.passphrase) opts.passphrase = k.passphrase;
    } else if (s.keyPath) {
      try { opts.privateKey = fs.readFileSync(s.keyPath); } catch { return null; }
      if (s.passphrase) opts.passphrase = s.passphrase;
    } else {
      return null;
    }
  } else if (s.password) {
    opts.password = s.password;
  } else {
    return null;
  }
  return opts;
}

let sshReady = null;   // Promise<ssh2 Client> of the live tunnel connection
function sshClient() {
  if (sshReady) return sshReady;
  const opts = tunnelTarget();
  if (!opts) return Promise.reject(new Error('в сейфе нет сессии packetlab'));
  const expected = deps.knownHost(opts.host, opts.port);
  const c = new SSHClient();
  const p = new Promise((resolve, reject) => {
    const drop = () => { if (sshReady === p) sshReady = null; };
    c.on('ready', () => resolve(c));
    c.on('error', (e) => { drop(); reject(e); });
    c.on('close', () => { drop(); reject(new Error('closed')); });
    c.connect({
      ...opts,
      // Only a host key the user has already accepted in the app: a tunnel carrying the chat must
      // not trust a first-seen or changed key on its own - there is nobody to ask here.
      hostVerifier: (key) => !!expected
        && expected === 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, ''),
    });
  });
  sshReady = p;
  p.catch(() => {});
  return p;
}
function openSsh2(host, port) {
  return sshClient().then((c) => new Promise((resolve, reject) => {
    c.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)));
  }));
}

// System ssh.exe with ~/.ssh keys: the path from before the vault session existed.
let sshProc = null;
function probePort(port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port, timeout: timeoutMs });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
async function ensureSshExe(timeoutMs) {
  if (!sshProc || sshProc.exitCode !== null) {
    sshProc = spawn('ssh', [
      '-D', String(SOCKS_PORT), '-N',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', SSH_EXE_TARGET,
    ], { windowsHide: true, stdio: 'ignore' });
    sshProc.on('exit', () => { sshProc = null; });
    sshProc.on('error', () => { sshProc = null; });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(SOCKS_PORT, 200)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

let lastVia = '';
async function openUpstream(host, port) {
  const ways = [];
  if (await directAllowed()) ways.push(['direct', () => openDirect(host, port)]);
  ways.push(['sing-box', () => openSocks(deps.singboxPort, host, port)]);
  ways.push(['ssh', () => openSsh2(host, port)]);
  ways.push(['ssh.exe', async () => {
    if (!(await ensureSshExe(3000))) throw new Error('ssh.exe: туннель не поднялся');
    return openSocks(SOCKS_PORT, host, port);
  }]);
  let last = null;
  for (const [via, open] of ways) {
    try {
      const stream = await open();
      lastVia = via;
      return stream;
    } catch (e) {
      last = e;
      if (via === 'direct') forgetDirect();
    }
  }
  throw last || new Error('нет пути наружу');
}

/* ---- the bridge: the ACP adapter only understands HTTP(S)_PROXY as an http:// URL, and the only
 * request shape it sends is CONNECT (Anthropic's API is https-only). */
let bridge = null;
function ensureBridge() {
  if (bridge) return bridge;
  bridge = new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => { res.writeHead(405).end(); });
    server.on('connect', (req, client, head) => {
      const i = req.url.lastIndexOf(':');
      const host = req.url.slice(0, i).replace(/^\[|\]$/g, '');
      const port = Number(req.url.slice(i + 1)) || 443;
      client.on('error', () => {});
      openUpstream(host, port).then((up) => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
        // A connection dying under us is the first sign the way out changed (sing-box gone).
        up.on('error', () => { forgetDirect(); client.destroy(); });
        client.on('close', () => up.destroy());
      }).catch(() => {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
    });
    server.once('error', (e) => { bridge = null; reject(e); });
    server.listen(BRIDGE_PORT, '127.0.0.1', () => resolve(BRIDGE_PORT));
  });
  return bridge;
}

module.exports = { configure, ensureBridge, probeDirect, lastRoute: () => lastVia };
