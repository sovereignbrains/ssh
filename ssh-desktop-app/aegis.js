'use strict';
// Recovery from a broken update. A release that dies before its window appears (1.3.12 shipped
// without nettools.js) also kills the updater, so nothing inside the app can fix it - the only
// way back was a manual reinstall. Aegis keeps the installers of the last known-good versions
// and reinstalls one when the current version fails to start twice in a row.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { spawn } = require('child_process');

const KEEP = 2;
const STABLE_MS = 60 * 1000;
const FAILS_BEFORE_ROLLBACK = 2;

const archiveDir = () => path.join(app.getPath('userData'), 'aegis');
const stateFile = () => path.join(archiveDir(), 'state.json');
const pendingDir = () => path.join(process.env.LOCALAPPDATA || '', app.getName() + '-updater', 'pending');

let state = { launch: null, fails: {}, blocked: [], installers: [] };
let stableTimer = null;

function load() {
  try {
    state = { fails: {}, blocked: [], installers: [], launch: null, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) };
  } catch {}
}

function save() {
  try {
    fs.mkdirSync(archiveDir(), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 1));
  } catch {}
}

function log(line) {
  try {
    fs.mkdirSync(archiveDir(), { recursive: true });
    fs.appendFileSync(path.join(archiveDir(), 'aegis.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch {}
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// Only a version that has reached its window counts as a way back. An installer is archived when
// it is downloaded, before anyone knows it starts: 1.3.31 and 1.3.32 were both archived that way,
// pushed 1.3.30 out of the archive and left 1.3.32 with nothing to roll back to.
function rollbackTarget(currentVersion) {
  return state.installers
    .filter((e) => e.verified && e.version !== currentVersion && !state.blocked.includes(e.version))
    .filter((e) => fs.existsSync(path.join(archiveDir(), e.file)))
    .sort((a, b) => compareVersions(b.version, a.version))[0] || null;
}

// NSIS runs with a visible progress window on purpose: a silent reinstall would look like
// the app simply vanished.
function runInstaller(file) {
  const child = spawn(path.join(archiveDir(), file), [], { detached: true, stdio: 'ignore' });
  child.unref();
}

function rollback(currentVersion, reason) {
  // Blocked even when there is nowhere to go, so a working copy reinstalled by hand is not offered it again.
  if (!state.blocked.includes(currentVersion)) state.blocked.push(currentVersion);
  const target = rollbackTarget(currentVersion);
  if (!target) {
    save();
    log('rollback impossible from ' + currentVersion + ' (' + reason + '): no verified installer');
    return false;
  }
  state.launch = null;
  state.fails = {};
  save();
  log('rolling back ' + currentVersion + ' -> ' + target.version + ' (' + reason + ')');
  runInstaller(target.file);
  return true;
}

/** Called before anything else in the process: decides whether the previous launch died and
 *  whether this one should hand over to an older installer instead of trying again.
 *  Returns false when the app must not continue booting. */
function begin() {
  // Unpackaged runs have no installers behind them and report Electron's own version.
  if (!app.isPackaged) return true;
  load();
  const version = app.getVersion();
  const previous = state.launch;
  if (previous && previous.stage === 'starting' && previous.version === version) {
    state.fails[version] = (state.fails[version] || 0) + 1;
    log('previous launch of ' + version + ' never reached the window (fail ' + state.fails[version] + ')');
    if (state.fails[version] >= FAILS_BEFORE_ROLLBACK && rollback(version, 'never reached the window')) {
      app.exit(0);
      return false;
    }
  }
  state.launch = { version, stage: 'starting', at: Date.now() };
  save();
  return true;
}

/** The window is on screen, so this build works well enough to update and repair itself. */
function alive() {
  if (!app.isPackaged || !state.launch) return;
  state.launch.stage = 'alive';
  delete state.fails[app.getVersion()];
  const own = state.installers.find((e) => e.version === app.getVersion());
  if (own && !own.verified) {
    own.verified = true;
    log('installer for ' + own.version + ' verified');
  }
  save();
  if (stableTimer) return;
  stableTimer = setTimeout(() => {
    if (!state.launch) return;
    state.launch.stage = 'stable';
    save();
  }, STABLE_MS);
  stableTimer.unref();
}

/** The app body threw while loading - exactly the 1.3.12 case, and the one the thin loader exists for. */
function crashed(err) {
  const version = app.getVersion();
  log('startup crash in ' + version + ': ' + ((err && err.stack) || err));
  state.fails[version] = FAILS_BEFORE_ROLLBACK;
  save();
  if (!rollback(version, 'startup crash')) {
    try {
      require('electron').dialog.showErrorBox('SSH Client',
        'Версия ' + version + ' не запускается, а запасной версии для отката нет.\n\n' +
        ((err && err.message) || String(err)));
    } catch {}
  }
  app.exit(1);
}

/** Keep the installer of a version we are about to run, so the version after it has a way back.
 *  electron-updater has already downloaded it - this is a copy of a file that is on disk anyway. */
function archiveInstaller(version) {
  if (!app.isPackaged || !version) return;
  try {
    const dir = pendingDir();
    const file = fs.readdirSync(dir).find((f) => f.includes(version) && f.toLowerCase().endsWith('.exe'));
    if (!file) { log('no pending installer for ' + version); return; }
    fs.mkdirSync(archiveDir(), { recursive: true });
    fs.copyFileSync(path.join(dir, file), path.join(archiveDir(), file));
    state.installers = state.installers.filter((e) => e.version !== version);
    state.installers.push({ version, file, at: Date.now(), verified: false });
    state.installers.sort((a, b) => compareVersions(b.version, a.version));
    // Keep the KEEP newest verified installers plus the one just downloaded; an unproven
    // version must never push a proven one out of the archive.
    let verified = 0;
    const keep = state.installers.filter((e) => e.version === version || (e.verified && ++verified <= KEEP));
    for (const old of state.installers.filter((e) => !keep.includes(e))) {
      if (old.file !== file) try { fs.unlinkSync(path.join(archiveDir(), old.file)); } catch {}
    }
    state.installers = keep;
    save();
    log('archived installer for ' + version);
  } catch (e) {
    log('archiving ' + version + ' failed: ' + ((e && e.message) || e));
  }
}

const isBlocked = (version) => state.blocked.includes(version);

module.exports = { begin, alive, crashed, archiveInstaller, isBlocked };
