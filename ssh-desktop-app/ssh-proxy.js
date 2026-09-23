// Independent proxy path for Claude Code's own traffic when sing-box is down.
//
// agent.js normally routes through the user's sing-box mixed-inbound (probeLocalProxy), but that
// port is exactly what disappears when sing-box-daemon is stopped for TUN testing (Sovereign
// work) - and a plain ISP connection isn't real internet for this user (DPI filtering, not just
// slower - see project_singbox notes). This module is the fallback: a plain SSH dynamic port
// forward (-D) to the packetlab server, confirmed by hand to survive that filtering (root SSH
// access already exists for the packetlab deploy), plus a tiny local HTTP CONNECT proxy in front
// of it - the ACP adapter only understands HTTP(S)_PROXY as an http:// URL, not socks5://.
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { SocksClient } = require('socks');

const SSH_HOST = '5.83.147.210';
const SSH_USER = 'root';
const SOCKS_PORT = 2091;
const BRIDGE_PORT = 2092;

let sshProc = null;
let bridgeServer = null;
let starting = null;

function probe(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: timeoutMs });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function startSshTunnel() {
  if (sshProc && sshProc.exitCode === null) return;
  sshProc = spawn('ssh', [
    '-D', String(SOCKS_PORT), '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    SSH_USER + '@' + SSH_HOST,
  ], { windowsHide: true, stdio: 'ignore' });
  sshProc.on('exit', () => { sshProc = null; });
  sshProc.on('error', () => { sshProc = null; });
}

// Plain http.Server 'connect' handling: the only request shape the ACP adapter's proxy client
// ever sends is CONNECT (Anthropic's API is https-only), so no plain-request forwarding is needed.
function startBridge() {
  if (bridgeServer) return;
  const server = http.createServer((_req, res) => { res.writeHead(405).end(); });
  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const port = Number(portStr) || 443;
    SocksClient.createConnection({
      proxy: { host: '127.0.0.1', port: SOCKS_PORT, type: 5 },
      command: 'connect',
      destination: { host, port },
    }).then(({ socket }) => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) socket.write(head);
      socket.pipe(clientSocket);
      clientSocket.pipe(socket);
      socket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => socket.destroy());
    }).catch(() => { clientSocket.destroy(); });
  });
  server.on('error', () => { bridgeServer = null; });
  server.listen(BRIDGE_PORT, '127.0.0.1');
  bridgeServer = server;
}

// Returns the local bridge port once the SOCKS5 hop through SSH is actually up, or null if it
// didn't come up within timeoutMs. Safe to call before every chat start, same as probeLocalProxy -
// cheap no-op once the tunnel is already established (single probe, no respawn).
async function ensureIndependentProxy(timeoutMs) {
  if (!starting) {
    starting = (async () => {
      startSshTunnel();
      startBridge();
      const deadline = Date.now() + (timeoutMs || 2000);
      while (Date.now() < deadline) {
        if (await probe(SOCKS_PORT, 200)) return true;
        await new Promise((r) => setTimeout(r, 150));
      }
      return false;
    })().finally(() => { starting = null; });
  }
  return (await starting) ? BRIDGE_PORT : null;
}

module.exports = { ensureIndependentProxy };
