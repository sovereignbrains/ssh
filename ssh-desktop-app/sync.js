'use strict';
// Vault sync with Google Drive. The local secrets.vault stays the primary copy on each computer;
// the Drive copy is the same encrypted envelope. Remote changes are merged record by record in the renderer.
const crypto = require('crypto');
const { createDrive } = require('./google-drive');
const { readEnvelopeText } = require('./vault');

const AFTER_SAVE_MS = 3000;
const EVERY_MS = 60 * 1000;
const FOCUS_MIN_GAP_MS = 20 * 1000;
const MERGE_TIMEOUT_MS = 30 * 1000;

function humanError(e) {
  const msg = String((e && e.message) || e || '');
  if (e && e.code === 'reauth') return msg;
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network/i.test(msg)) return 'Нет связи с Google Диском';
  if (e && e.status === 403) return 'Google Диск отказал в доступе: ' + msg;
  return msg.split('\n')[0].slice(0, 240);
}

module.exports = function registerSync({ ipcMain, app, shell, safeStorage, sendToRenderer, logError, getConfig, saveConfig, getVault, getWindow }) {
  const drive = createDrive({ app, shell, safeStorage, logError });
  const cfg = () => getConfig();
  const sync = () => { const c = cfg(); if (!c.sync) c.sync = { auto: true }; return c.sync; };
  const state = { state: 'signed-out', email: '', lastSyncAt: 0, error: '', link: '', notice: '' };

  function publicState() {
    return { ...state, configured: drive.configured(), signedIn: drive.signedIn(), email: drive.email(), auto: sync().auto !== false, lastSyncAt: sync().lastSyncAt || 0, link: sync().link || '' };
  }
  function emit(patch) {
    Object.assign(state, patch || {});
    if (!drive.signedIn() && !['login', 'error'].includes(state.state)) state.state = 'signed-out';
    sendToRenderer('sync:state', publicState());
  }

  let running = null;
  let again = false;
  let timer = null;
  let lastRunAt = 0;
  let pendingEnvelope = null;
  const merges = new Map();

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => runCycle('scheduled'), ms);
  }

  // Hand remote data to the renderer; it merges, saves locally and confirms.
  function mergeInRenderer(data, device) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomBytes(6).toString('hex');
      const t = setTimeout(() => { merges.delete(id); reject(new Error('Интерфейс не ответил на слияние')); }, MERGE_TIMEOUT_MS);
      merges.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } });
      sendToRenderer('sync:remote', { id, data, device, own: device === cfg().deviceId });
    });
  }

  async function ensureFolder() {
    const s = sync();
    let folder = await drive.findFolder(s.folderId);
    if (!folder) folder = await drive.createFolder();
    if (s.folderId !== folder.id) { s.folderId = folder.id; saveConfig(); }
    return folder;
  }

  async function cycle() {
    const vault = getVault();
    if (!drive.signedIn() || !vault.isUnlocked() || !vault.exists()) return;
    emit({ state: 'syncing', error: '' });
    const s = sync();
    const folder = await ensureFolder();
    const { file, wasDeleted } = await drive.findFile(s.fileId, folder.id);
    let remote = file;
    const remoteRev = remote && remote.appProperties && remote.appProperties.rev;

    if (remote && remoteRev && remoteRev !== vault.lastRev && remoteRev !== s.mergedRev) {
      const text = await drive.download(remote.id);
      const env = readEnvelopeText(text);
      let data;
      try {
        data = vault.openEnvelope(env);
      } catch (e) {
        if (e.code !== 'needs-password') throw e;
        pendingEnvelope = { env, rev: remoteRev };
        emit({ state: 'password', error: '' });
        sendToRenderer('sync:need-password', { device: env.device || '' });
        return;
      }
      await mergeInRenderer(data, env.device || '');
      s.mergedRev = remoteRev;
      saveConfig();
    }

    if (!remote || (remote.appProperties || {}).rev !== vault.lastRev) {
      const text = vault.envelopeText();
      const rev = readEnvelopeText(text).rev || '';
      remote = await drive.upload(remote && remote.id, folder.id, text, { rev, device: cfg().deviceId || '' });
      s.mergedRev = rev;
    }
    s.fileId = remote.id;
    s.link = remote.webViewLink || s.link || '';
    s.lastSyncAt = Date.now();
    saveConfig();
    emit({ state: 'ok', error: '', notice: wasDeleted ? 'Копия на Google Диске была удалена — выгружена заново' : '' });
    state.notice = '';
  }

  function runCycle() {
    if (running) { again = true; return running; }
    lastRunAt = Date.now();
    running = cycle()
      .catch((e) => {
        if (e && e.code === 'reauth') emit({ state: 'error', error: humanError(e) });
        else {
          if (!/Нет связи/.test(humanError(e))) logError('синхронизация', e);
          emit({ state: 'error', error: humanError(e) });
        }
      })
      .finally(() => {
        running = null;
        if (again) { again = false; schedule(800); }
      });
    return running;
  }

  ipcMain.handle('sync:status', () => publicState());
  ipcMain.handle('sync:login', async () => {
    try {
      emit({ state: 'login', error: '' });
      await drive.login();
      emit({ state: 'idle', error: '' });
      runCycle();
      return { ok: true, email: drive.email() };
    } catch (e) {
      emit({ state: drive.signedIn() ? 'idle' : 'signed-out', error: e.code === 'cancelled' ? '' : humanError(e) });
      return { ok: false, error: humanError(e), cancelled: e.code === 'cancelled' };
    }
  });
  ipcMain.handle('sync:cancel-login', () => { drive.cancelLogin(); return { ok: true }; });
  ipcMain.handle('sync:logout', async (event, { deleteRemote }) => {
    try {
      const s = sync();
      if (deleteRemote && s.fileId && drive.signedIn()) await drive.remove(s.fileId);
      await drive.logout();
      cfg().sync = { auto: s.auto !== false };
      saveConfig();
      emit({ state: 'signed-out', error: '' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: humanError(e) };
    }
  });
  ipcMain.handle('sync:now', async () => { await runCycle(); return publicState(); });
  ipcMain.handle('sync:set-auto', (event, { auto }) => { sync().auto = !!auto; saveConfig(); emit(); if (auto) runCycle(); return { ok: true }; });
  ipcMain.on('sync:merged', (event, { id, ok, error }) => {
    const m = merges.get(id);
    if (!m) return;
    merges.delete(id);
    ok ? m.resolve() : m.reject(new Error(error || 'Слияние не удалось'));
  });
  ipcMain.handle('sync:password', async (event, { password }) => {
    if (!pendingEnvelope) return { ok: false, error: 'Нет копии, ожидающей пароль' };
    try {
      const { env, rev } = pendingEnvelope;
      const data = await getVault().adoptEnvelope(password || '', env);
      pendingEnvelope = null;
      await mergeInRenderer(data, env.device || '');
      sync().mergedRev = rev;
      saveConfig();
      runCycle();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: humanError(e) };
    }
  });
  ipcMain.handle('sync:skip-password', () => { pendingEnvelope = null; emit({ state: 'error', error: 'Синхронизация приостановлена: копия на Диске зашифрована другим паролем' }); return { ok: true }; });
  // New computer: sign in if needed and put the Drive copy in place of the missing local vault.
  ipcMain.handle('sync:restore', async () => {
    try {
      const vault = getVault();
      if (vault.exists()) return { ok: false, error: 'На этом компьютере уже есть сейф' };
      if (!drive.signedIn()) { emit({ state: 'login' }); await drive.login(); }
      const s = sync();
      const folder = await drive.findFolder(s.folderId);
      const { file } = await drive.findFile(s.fileId, folder && folder.id);
      if (!file) { emit({ state: 'idle' }); return { ok: false, error: 'На Google Диске (' + drive.email() + ') нет сейфа SSH Client — сначала включите синхронизацию на компьютере, где сейф уже есть' }; }
      const text = await drive.download(file.id);
      const env = vault.installEnvelope(text);
      Object.assign(s, { folderId: folder.id, fileId: file.id, link: file.webViewLink || '', mergedRev: env.rev || '', lastSyncAt: Date.now() });
      saveConfig();
      emit({ state: 'ok', error: '' });
      return { ok: true, email: drive.email(), device: env.device || '' };
    } catch (e) {
      emit({ state: drive.signedIn() ? 'idle' : 'signed-out' });
      return { ok: false, error: humanError(e), cancelled: e.code === 'cancelled' };
    }
  });
  ipcMain.handle('sync:open-drive', () => { const link = sync().link; if (link) shell.openExternal(link); return { ok: !!link }; });

  const interval = setInterval(() => { if (sync().auto !== false) runCycle(); }, EVERY_MS);
  app.on('browser-window-focus', () => { if (sync().auto !== false && Date.now() - lastRunAt > FOCUS_MIN_GAP_MS) runCycle(); });

  return {
    onUnlock() { if (sync().auto !== false) schedule(500); else emit(); },
    onLocalSave() { if (sync().auto !== false && drive.signedIn()) schedule(AFTER_SAVE_MS); },
    stop() { clearInterval(interval); clearTimeout(timer); },
    drive,
  };
};
