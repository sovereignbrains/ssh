// electron-builder beforeBuild hook.
// node-pty ships N-API prebuilds and cannot be compiled here (its winpty dependency needs git),
// so rebuild every other native module for Electron here; the builder's own rebuild is off (npmRebuild: false).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const LOCAL_REQUIRE = /require\(\s*['"](\.[^'"]*)['"]\s*\)/g;
const ANY = '@@ANY@@';

// `build.files` is an allowlist, so a local module that main.js requires at startup but nobody
// listed there is dropped from app.asar silently and the app dies on launch with "Cannot find
// module" (1.3.12 shipped without nettools.js exactly that way). A crash at require time also
// kills the updater, so such a release can only be undone by a manual reinstall — catch it here.
function toRegExp(pattern) {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/\*/g, ANY)
    .replace(/\*\*/g, ANY)
    .replace(/\*/g, '[^/]*')
    .split(ANY)
    .join('.*');
  return new RegExp('^' + body + '$');
}

function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function checkPackagedFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const patterns = ((pkg.build && pkg.build.files) || [])
    .filter((p) => typeof p === 'string' && !p.startsWith('!'))
    .map(toRegExp);
  const queue = [pkg.main || 'main.js', 'preload.js'].map((f) => path.join(root, f));
  const seen = new Set();
  const missing = [];
  const unresolved = [];

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel.startsWith('..') || rel.startsWith('node_modules/')) continue;
    if (!patterns.some((rx) => rx.test(rel))) missing.push(rel);
    if (!file.endsWith('.js')) continue;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(LOCAL_REQUIRE)) {
      const target = resolveLocal(file, m[1]);
      if (target) queue.push(target);
      else unresolved.push(rel + ' -> ' + m[1]);
    }
  }

  if (unresolved.length) {
    throw new Error('Сборка остановлена: локальный модуль не найден на диске: ' + unresolved.join(', '));
  }
  if (missing.length) {
    throw new Error('Сборка остановлена: эти файлы нужны приложению при запуске, но не попадают в сборку — добавьте их в build.files в package.json: ' + missing.join(', '));
  }
}

module.exports = async function beforeBuild(context) {
  checkPackagedFiles();
  const { rebuild } = await import('@electron/rebuild');
  await rebuild({
    buildPath: context.appDir,
    electronVersion: context.electronVersion,
    arch: context.arch,
    ignoreModules: ['node-pty'],
    force: true,
  });
};
module.exports.checkPackagedFiles = checkPackagedFiles;
