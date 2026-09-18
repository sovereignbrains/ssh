// Network measurements for the «Инструменты» section: throughput, round-trip time, DNS, adapters,
// path MTU. Everything runs here rather than in the window: the renderer cannot open raw sockets,
// speak a proxy, or read adapter settings.
'use strict';
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const dns = require('dns');
const os = require('os');
const { execFile } = require('child_process');

// Fixed-size files served close to most networks; the point is comparing them, not the absolute number.
const TARGETS = [
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://speed.cloudflare.com/__down?bytes=10000000' },
  { id: 'ovh', name: 'OVH (Франция)', url: 'https://proof.ovh.net/files/10Mb.dat' },
  { id: 'cachefly', name: 'CacheFly', url: 'https://cachefly.cachefly.net/10mb.test' },
];
const RTT_TARGETS = [
  { id: 'cloudflare', name: 'Cloudflare', host: '1.1.1.1', port: 443 },
  { id: 'google', name: 'Google', host: '8.8.8.8', port: 443 },
  { id: 'github', name: 'GitHub', host: 'github.com', port: 443 },
];

function parseProxy(proxy) {
  if (!proxy) return null;
  const s = String(proxy).trim().replace(/^\w+:\/\//, '');
  if (!s) return null;
  const [host, port] = s.split(':');
  if (!host || !port || !/^\d+$/.test(port)) throw new Error('Прокси указывается как адрес:порт, например 127.0.0.1:23003');
  return { host, port: +port };
}

// CONNECT through an HTTP proxy, so a local sing-box/SSH forward can be measured like any other path.
function proxyConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    const fail = (e) => { sock.destroy(); reject(e); };
    const timer = setTimeout(() => fail(new Error('прокси ' + proxy.host + ':' + proxy.port + ' не ответил')), 10000);
    sock.once('error', (e) => { clearTimeout(timer); fail(new Error('прокси недоступен: ' + e.message)); });
    sock.once('connect', () => sock.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n\r\n'));
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      const code = +(buf.split(' ')[1] || 0);
      if (code !== 200) return fail(new Error('прокси ответил ' + (code || '?')));
      resolve(sock);
    };
    sock.on('data', onData);
  });
}

function agentFor(isHttps, proxy) {
  if (!proxy) return undefined;
  const Agent = isHttps ? https.Agent : http.Agent;
  return new Agent({
    createConnection(options, cb) {
      proxyConnect(proxy, options.host || options.hostname, +options.port)
        .then((sock) => {
          if (!isHttps) return cb(null, sock);
          const secure = tls.connect({ socket: sock, servername: options.servername || options.host }, () => cb(null, secure));
          secure.once('error', cb);
        })
        .catch(cb);
    },
  });
}

// Download until the byte budget or the time budget runs out, whichever comes first, and report the
// rate over the part that actually streamed.
function measureDownload(url, { proxy, maxBytes = 10e6, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: 'Неверный адрес' }); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    let agent;
    try { agent = agentFor(isHttps, proxy); } catch (e) { return resolve({ ok: false, error: e.message }); }

    let bytes = 0;
    let firstByteAt = 0;
    let done = false;
    const started = Date.now();
    const finish = (extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { req.destroy(); } catch {}
      const streamMs = firstByteAt ? Date.now() - firstByteAt : 0;
      const mbit = streamMs > 0 && bytes > 0 ? (bytes * 8) / 1e6 / (streamMs / 1000) : 0;
      resolve({ ok: bytes > 0, bytes, mbit: +mbit.toFixed(1), ttfbMs: firstByteAt ? firstByteAt - started : null, ...extra });
    };
    const timer = setTimeout(() => finish(bytes > 0 ? {} : { ok: false, error: 'таймаут' }), timeoutMs);

    const req = mod.get(url, { agent, headers: { 'User-Agent': 'ssh-client/nettools', 'Cache-Control': 'no-cache' } }, (res) => {
      if (res.statusCode >= 400) { res.destroy(); return finish({ ok: false, error: 'HTTP ' + res.statusCode }); }
      res.on('data', (chunk) => {
        if (!firstByteAt) firstByteAt = Date.now();
        bytes += chunk.length;
        if (bytes >= maxBytes) finish({});
      });
      res.on('end', () => finish({}));
      res.on('error', (e) => finish(bytes > 0 ? {} : { ok: false, error: e.message }));
    });
    req.on('error', (e) => finish({ ok: false, error: e.message }));
  });
}

// TCP handshake time: no raw sockets or elevation needed, and it reflects the path the app uses.
function tcpRtt(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (ms) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve(ms);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.once('connect', () => done(Number(process.hrtime.bigint() - started) / 1e6));
    sock.once('error', () => done(null));
  });
}

async function rttSeries(host, port, count = 8) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    const ms = await tcpRtt(host, port);
    samples.push(ms);
  }
  const ok = samples.filter((x) => x !== null);
  if (!ok.length) return { ok: false, loss: 100, sent: count };
  const min = Math.min(...ok);
  const max = Math.max(...ok);
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  // Mean deviation between consecutive samples — what a call or a game actually feels.
  let jitter = 0;
  for (let i = 1; i < ok.length; i++) jitter += Math.abs(ok[i] - ok[i - 1]);
  jitter = ok.length > 1 ? jitter / (ok.length - 1) : 0;
  return {
    ok: true, sent: count, received: ok.length,
    loss: Math.round(((count - ok.length) / count) * 100),
    min: +min.toFixed(1), avg: +avg.toFixed(1), max: +max.toFixed(1), jitter: +jitter.toFixed(1),
  };
}

function dnsTiming(hostname) {
  return new Promise((resolve) => {
    const started = Date.now();
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return resolve({ ok: false, error: err.code || err.message, ms: Date.now() - started });
      resolve({ ok: true, ms: Date.now() - started, addresses: (addrs || []).length });
    });
  });
}

// PowerShell gives adapter data as objects; its localized *text* is never parsed, only these fields.
function psJson(command) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
  });
}

async function interfaces() {
  const rows = await psJson(
    'Get-NetAdapter -Physical:$false | Where-Object Status -eq "Up" | ForEach-Object { ' +
    '$a=$_; $ip = Get-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
    '[pscustomobject]@{ name=$a.Name; desc=$a.InterfaceDescription; ifIndex=$a.ifIndex; ' +
    'linkSpeedBps=$a.LinkSpeed; mtu=$(if($ip){$ip.NlMtu}else{$null}) } } | ConvertTo-Json -Compress -Depth 3'
  );
  const list = rows ? (Array.isArray(rows) ? rows : [rows]) : [];
  if (list.length) {
    const addrs = os.networkInterfaces();
    for (const r of list) {
      const a = (addrs[r.name] || []).find((x) => x.family === 'IPv4');
      r.address = a ? a.address : '';
    }
    return list;
  }
  // Not Windows, or the query failed: addresses are still worth showing.
  return Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
    (addrs || []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address, mtu: null, linkSpeedBps: null, desc: '' })));
}

async function routes() {
  const rows = await psJson(
    'Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | ForEach-Object { ' +
    '[pscustomobject]@{ ifIndex=$_.ifIndex; alias=$_.InterfaceAlias; nextHop=$_.NextHop; metric=$_.RouteMetric } } | ConvertTo-Json -Compress -Depth 3'
  );
  return rows ? (Array.isArray(rows) ? rows : [rows]) : [];
}

// Largest payload that survives without fragmentation. Only the exit code of ping is read — its
// console output is localized and must not be parsed.
function pingDf(host, payload) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('ping.exe', ['-n', '1', '-w', '2000', '-f', '-l', String(payload), host],
      { windowsHide: true }, (err) => resolve(!err));
  });
}

async function pathMtu(host) {
  if (process.platform !== 'win32') return { ok: false, error: 'Доступно только на Windows' };
  if (!(await pingDf(host, 1200))) return { ok: false, error: 'Узел не отвечает на ping — замер невозможен' };
  let lo = 1200;
  let hi = 1500;
  if (await pingDf(host, hi)) return { ok: true, payload: hi, mtu: hi + 28, capped: true };
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await pingDf(host, mid)) lo = mid; else hi = mid;
  }
  return { ok: true, payload: lo, mtu: lo + 28, capped: false };
}

function registerNetTools({ ipcMain, sendToRenderer, logError }) {
  const monitors = new Map(); // id -> timer

  ipcMain.handle('net:targets', () => ({ speed: TARGETS, rtt: RTT_TARGETS }));

  ipcMain.handle('net:speed', async (event, { url, proxy, maxBytes, timeoutMs } = {}) => {
    try {
      return await measureDownload(url, { proxy: parseProxy(proxy), maxBytes, timeoutMs });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('net:rtt', async (event, { host, port, count } = {}) => {
    try {
      return await rttSeries(host, port || 443, Math.min(count || 8, 30));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('net:dns', (event, { hostname } = {}) => dnsTiming(hostname || 'github.com'));

  ipcMain.handle('net:overview', async () => ({
    interfaces: await interfaces(),
    routes: await routes(),
  }));

  ipcMain.handle('net:mtu', async (event, { host } = {}) => {
    try {
      return await pathMtu(host || '1.1.1.1');
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Repeated sampling: a single number hides the swings, and the swings are usually the problem.
  ipcMain.handle('net:monitor-start', (event, { id, url, proxy, everyMs, rttHost, rttPort, maxBytes } = {}) => {
    const key = id || 'default';
    if (monitors.has(key)) clearInterval(monitors.get(key));
    let proxyCfg = null;
    try { proxyCfg = parseProxy(proxy); } catch (e) { return { ok: false, error: e.message }; }
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const speed = await measureDownload(url, { proxy: proxyCfg, maxBytes: maxBytes || 3e6, timeoutMs: 15000 });
        const rtt = await tcpRtt(rttHost || '1.1.1.1', rttPort || 443);
        sendToRenderer('net:sample', { id: key, at: Date.now(), mbit: speed.ok ? speed.mbit : 0, ok: speed.ok, error: speed.error || '', rtt: rtt === null ? null : +rtt.toFixed(1) });
      } catch (e) {
        if (logError) logError('замеры сети', e);
      } finally {
        busy = false;
      }
    };
    monitors.set(key, setInterval(tick, Math.max(5000, everyMs || 20000)));
    tick();
    return { ok: true };
  });

  ipcMain.handle('net:monitor-stop', (event, { id } = {}) => {
    const key = id || 'default';
    if (monitors.has(key)) { clearInterval(monitors.get(key)); monitors.delete(key); }
    return { ok: true };
  });

  return {
    shutdown() {
      for (const t of monitors.values()) clearInterval(t);
      monitors.clear();
    },
  };
}

module.exports = registerNetTools;
