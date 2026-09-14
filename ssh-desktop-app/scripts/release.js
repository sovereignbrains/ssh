// Build the Windows installer and publish it as a GitHub release; installed apps pick it up as an update.
//
//   npm run release                      bump patch (1.1.0 -> 1.1.1), build, publish
//   npm run release -- minor             bump minor (1.1.0 -> 1.2.0)
//   npm run release -- 2.0.0             set an exact version
//   npm run release -- current           publish the version already in package.json
//   npm run release -- patch --notes "Что нового"
//
// Needs GH_TOKEN: a GitHub token with write access to the repository's releases
// (fine-grained token → Repository access: sovereignbrains/ssh → Contents: Read and write).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const args = process.argv.slice(2);
const notesAt = args.indexOf('--notes');
const notes = notesAt >= 0 ? args.splice(notesAt, 2)[1] || '' : '';
const bump = args[0] || 'patch';

if (!process.env.GH_TOKEN) {
  console.error('Нет GH_TOKEN. Создайте токен GitHub с правом записи в релизы репозитория и выполните:\n  setx GH_TOKEN "ghp_..."\nпотом откройте новый терминал и повторите npm run release.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version.split('.').map(Number);
let next = pkg.version;
if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
else if (bump === 'patch') next = [current[0], current[1], current[2] + 1].join('.');
else if (bump === 'minor') next = [current[0], current[1] + 1, 0].join('.');
else if (bump === 'major') next = [current[0] + 1, 0, 0].join('.');
else if (bump !== 'current') {
  console.error('Неизвестный аргумент: ' + bump + ' (patch | minor | major | current | x.y.z)');
  process.exit(1);
}

if (next !== pkg.version) {
  pkg.version = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const lockPath = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.version = next;
    if (lock.packages && lock.packages['']) lock.packages[''].version = next;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }
}
console.log('Выпуск ' + next + (notes ? ' — ' + notes : ''));

// Google sign-in for sync: the OAuth client comes from the environment, so it never lands in the public repo.
const oauthPath = path.join(root, 'google-oauth.json');
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  fs.writeFileSync(oauthPath, JSON.stringify({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }, null, 2));
}
let oauth = null;
try { oauth = JSON.parse(fs.readFileSync(oauthPath, 'utf8')); } catch {}
if (!oauth || !/\.apps\.googleusercontent\.com$/.test(oauth.clientId || '')) {
  console.warn('Внимание: нет настоящего OAuth-клиента Google (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) — в этой сборке вход через Google будет недоступен.');
  if (oauth) fs.rmSync(oauthPath, { force: true });
}

const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const builderArgs = [cli, '--win', '--publish', 'always'];
if (notes) builderArgs.push('-c.releaseInfo.releaseNotes=' + notes);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(process.execPath, builderArgs, { cwd: root, stdio: 'inherit', env });
if (r.status !== 0) {
  console.error('Сборка или публикация не удалась (код ' + r.status + '). Версия в package.json уже ' + next + ' — для повтора: npm run release -- current');
  process.exit(r.status || 1);
}
console.log('\nГотово: https://github.com/' + 'sovereignbrains/ssh/releases/tag/v' + next + '\nУстановленные копии увидят обновление при следующей проверке.');
