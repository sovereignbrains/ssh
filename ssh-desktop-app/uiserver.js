'use strict';
// The UI used to load over file://, which WebAuthn rejects outright - only https, localhost and
// extension origins count as secure. Serving the same files over loopback HTTP gives the window a
// real origin (http://localhost:<port>) without changing a single path inside index.html.
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function start(root) {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]); }
    catch { res.writeHead(400); res.end(); return; }
    const file = path.join(root, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // An update replaces these files underneath us; a cached copy would mix old and new code.
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // Bound to the loopback interface, but addressed as "localhost": WebAuthn needs a hostname
    // for its relying party id, and IP literals are not allowed there.
    server.listen(0, '127.0.0.1', () => resolve({
      url: 'http://localhost:' + server.address().port + '/',
      close: () => server.close(),
    }));
  });
}

module.exports = { start };
