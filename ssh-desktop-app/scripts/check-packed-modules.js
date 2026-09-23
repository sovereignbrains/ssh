// electron-builder afterPack hook.
//
// check-packaged-files.js guards our own files; this guards node_modules. The packager copies
// whatever the build machine's node_modules holds, so a package that is missing there is dropped
// from app.asar without a word - 1.3.31 and 1.3.32 shipped without socks and smart-buffer exactly
// that way and died on launch with "Cannot find module 'socks'", taking the updater down with them.
//
// So check the archive that actually ships, not the source tree: every package our code requires
// and every package listed in dependencies must be inside, together with everything it depends on.
'use strict';
const path = require('path');
const { builtinModules } = require('module');
const asar = require('@electron/asar');

const BARE_REQUIRE = /(?:require|import)\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g;
const BUILTIN = new Set([...builtinModules, 'electron']);

const packageName = (spec) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

function checkPackedModules(asarPath) {
  // Headers use the platform separator; work in forward slashes and hand back what asar expects.
  const entries = new Set(asar.listPackage(asarPath).map((p) => p.split(path.sep).join('/').replace(/^\//, '')));
  const read = (rel) => asar.extractFile(asarPath, rel.split('/').join(path.sep)).toString('utf8');
  const pkg = JSON.parse(read('package.json'));

  // Node's lookup: the requiring package's own node_modules, then each one above it.
  function resolve(fromDir, name) {
    for (let dir = fromDir; ; dir = dir.includes('/node_modules/') ? dir.slice(0, dir.lastIndexOf('/node_modules/')) : '') {
      const candidate = (dir ? dir + '/' : '') + 'node_modules/' + name;
      if (entries.has(candidate + '/package.json')) return candidate;
      if (!dir) return null;
    }
  }

  const problems = [];
  const roots = new Map();
  for (const file of entries) {
    if (file.includes('/') || !file.endsWith('.js')) continue;
    for (const m of read(file).matchAll(BARE_REQUIRE)) {
      const name = packageName(m[1]);
      if (BUILTIN.has(name) || name.startsWith('node:')) continue;
      if (!(pkg.dependencies || {})[name]) problems.push(file + ' подключает ' + name + ', но его нет в dependencies');
      if (!roots.has(name)) roots.set(name, file);
    }
  }
  for (const name of Object.keys(pkg.dependencies || {})) if (!roots.has(name)) roots.set(name, 'package.json');

  const seen = new Set();
  const queue = [...roots].map(([name, from]) => ({ name, fromDir: '', via: from }));
  while (queue.length) {
    const { name, fromDir, via } = queue.shift();
    const dir = resolve(fromDir, name);
    if (!dir) { problems.push(name + ' (нужен для ' + via + ')'); continue; }
    if (seen.has(dir)) continue;
    seen.add(dir);
    const deps = JSON.parse(read(dir + '/package.json')).dependencies || {};
    for (const dep of Object.keys(deps)) queue.push({ name: dep, fromDir: dir, via: name });
  }
  return problems;
}

function asarOf(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  return path.join(resources, 'app.asar');
}

module.exports = async function afterPack(context) {
  const problems = checkPackedModules(asarOf(context));
  if (problems.length) {
    throw new Error('Сборка остановлена: в app.asar не хватает модулей, приложение упадёт при запуске. ' +
      'Выполните npm ci и соберите заново. Не хватает: ' + [...new Set(problems)].join(', '));
  }
};
module.exports.checkPackedModules = checkPackedModules;
