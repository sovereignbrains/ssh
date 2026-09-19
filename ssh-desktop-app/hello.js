'use strict';
// Unlocking without the master password. Windows Hello (WebAuthn PRF) returns 32 stable bytes for
// a fixed salt; those bytes wrap a copy of the vault key. The vault file is untouched and knows
// nothing about this - the wrapped copy lives in config.json and is useless without Hello.
const crypto = require('crypto');

const INFO = Buffer.from('ssh-client-hello-v1');

const kek = (prf, salt) =>
  Buffer.from(crypto.hkdfSync('sha256', Buffer.from(prf, 'base64'), Buffer.from(salt, 'base64'), INFO, 32));

function wrapKey(key, k) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([c.update(key), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function unwrapKey(w, k) {
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(w.iv, 'base64'));
  d.setAuthTag(Buffer.from(w.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(w.data, 'base64')), d.final()]);
}

module.exports = function registerHello({ ipcMain, getVault, getConfig, saveConfig, onUnlock, vaultStatus }) {
  const stored = () => getConfig().hello || null;
  const wrap = (fn) => async (event, args) => {
    try { return { ok: true, ...(await fn(args || {})) }; }
    catch (e) { return { ok: false, error: e.message }; }
  };

  ipcMain.handle('hello:state', wrap(async () => {
    const h = stored();
    return { configured: !!h, credentialId: (h && h.credentialId) || '', salt: (h && h.salt) || '' };
  }));

  // Only callable with the vault open: that is the one moment the key exists to be wrapped.
  ipcMain.handle('hello:enable', wrap(async ({ credentialId, prf, salt }) => {
    if (!credentialId || !prf || !salt) throw new Error('Windows Hello не вернул данные ключа');
    const key = getVault().exportKey();
    const k = kek(prf, salt);
    try {
      getConfig().hello = { credentialId, salt, wrapped: wrapKey(key, k) };
      saveConfig();
    } finally {
      key.fill(0);
      k.fill(0);
    }
    return {};
  }));

  ipcMain.handle('hello:unlock', wrap(async ({ prf }) => {
    const h = stored();
    if (!h) throw new Error('Вход по Windows Hello не настроен');
    const k = kek(prf, h.salt);
    let key;
    try {
      key = unwrapKey(h.wrapped, k);
    } catch {
      throw new Error('Windows Hello подтвердил другой ключ — войдите мастер-паролем');
    } finally {
      k.fill(0);
    }
    try {
      const data = getVault().unlockWithKey(key);
      onUnlock();
      return { data, status: vaultStatus() };
    } finally {
      key.fill(0);
    }
  }));

  ipcMain.handle('hello:disable', wrap(async () => {
    delete getConfig().hello;
    saveConfig();
    return {};
  }));
};
