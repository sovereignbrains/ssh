'use strict';
// App updates from GitHub Releases (electron-updater). Checks on start and every few hours,
// downloads only when the user asks, installs on «Перезапустить» or on the next quit.
const { autoUpdater } = require('electron-updater');

const FIRST_CHECK_MS = 15 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

// GitHub returns release notes as HTML; the renderer only gets plain text.
function notesText(notes) {
  const raw = Array.isArray(notes) ? notes.map((n) => n && n.note).filter(Boolean).join('\n\n') : String(notes || '');
  return raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

function humanError(err) {
  const msg = String((err && err.message) || err || '');
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(msg)) return 'Нет связи с GitHub — проверьте интернет';
  if (/404|Cannot find latest|No published versions|latest\.yml/i.test(msg)) return 'На GitHub пока нет опубликованного выпуска';
  if (/rate limit|403/i.test(msg)) return 'GitHub временно ограничил запросы — попробуйте позже';
  if (/sha512 checksum mismatch/i.test(msg)) return 'Загруженный файл повреждён — попробуйте ещё раз';
  return msg.split('\n')[0].slice(0, 300);
}

module.exports = function registerUpdater({ ipcMain, app, sendToRenderer, logError, getConfig, saveConfig, beforeInstall }) {
  const state = { state: 'idle', current: app.getVersion(), version: '', notes: '', percent: 0, bytesPerSecond: 0, transferred: 0, total: 0, error: '', checkedAt: 0, manual: false };
  const settings = () => Object.assign({ autoCheck: true }, getConfig().updates || {});
  const emit = (patch) => { Object.assign(state, patch); sendToRenderer('update:state', { ...state, autoCheck: settings().autoCheck, supported: app.isPackaged }); };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => emit({ state: 'available', version: info.version, notes: notesText(info.releaseNotes), checkedAt: Date.now() }));
  autoUpdater.on('update-not-available', () => emit({ state: 'none', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: p.percent || 0, bytesPerSecond: p.bytesPerSecond || 0, transferred: p.transferred || 0, total: p.total || 0 }));
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'downloaded', version: info.version, percent: 100 }));
  autoUpdater.on('error', (err) => {
    // Background checks fail quietly (offline laptop); errors the user asked for are shown.
    if (!state.manual && state.state === 'checking') { emit({ state: 'idle', error: '' }); return; }
    logError('обновление', err);
    emit({ state: 'error', error: humanError(err) });
  });

  let checking = null;
  async function check(manual) {
    if (!app.isPackaged) {
      emit({ state: 'error', error: 'Обновления работают только в установленной версии приложения', manual });
      return { ok: false };
    }
    if (['downloading', 'downloaded'].includes(state.state)) return { ok: true };
    if (checking) return checking;
    state.manual = !!manual;
    checking = autoUpdater.checkForUpdates()
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: humanError(err) }))
      .finally(() => { checking = null; });
    return checking;
  }

  ipcMain.handle('update:get', () => ({ ...state, autoCheck: settings().autoCheck, supported: app.isPackaged }));
  ipcMain.handle('update:check', () => check(true));
  ipcMain.handle('update:download', async () => {
    if (state.state !== 'available' && state.state !== 'error') return { ok: false };
    state.manual = true;
    emit({ state: 'downloading', percent: 0, error: '' });
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      logError('обновление', err);
      emit({ state: 'error', error: humanError(err) });
      return { ok: false, error: humanError(err) };
    }
  });
  ipcMain.handle('update:install', async () => {
    if (state.state !== 'downloaded') return { ok: false };
    await beforeInstall();
    // isSilent=false shows the installer progress; isForceRunAfter=true starts the new version.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });
  ipcMain.handle('update:set-auto', (event, { autoCheck }) => {
    getConfig().updates = { ...settings(), autoCheck: !!autoCheck };
    saveConfig();
    emit({});
    return { ok: true };
  });

  const timers = [];
  if (app.isPackaged) {
    const auto = () => { if (settings().autoCheck) check(false); };
    timers.push(setTimeout(auto, FIRST_CHECK_MS), setInterval(auto, CHECK_EVERY_MS));
  }
  return { stop: () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); }) };
};
