'use strict';
// Google sign-in (OAuth 2.0 for installed apps: loopback redirect + PKCE) and the few Drive v3 calls sync needs.
// Scope drive.file: the app only sees files it created itself — a visible «SSH Client» folder with secrets.vault.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const endpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
};
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];
const FOLDER_NAME = 'SSH Client';
const FILE_NAME = 'secrets.vault';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class DriveError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function createDrive({ app, shell, safeStorage, logError }) {
  const authFile = path.join(app.getPath('userData'), 'google-auth.bin');
  let auth = null; // { refreshToken, email }
  let access = null; // { token, exp }
  let pendingLogin = null;

  function oauthConfig() {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'google-oauth.json'), 'utf8'));
      if (c.clientId && c.clientSecret) return c;
    } catch {}
    return null;
  }

  function loadAuth() {
    try {
      if (!fs.existsSync(authFile) || !safeStorage.isEncryptionAvailable()) return null;
      auth = JSON.parse(safeStorage.decryptString(fs.readFileSync(authFile)));
    } catch (e) {
      logError('google', e);
      auth = null;
    }
    return auth;
  }
  function saveAuth() {
    if (!safeStorage.isEncryptionAvailable()) throw new DriveError('Шифрование Windows (DPAPI) недоступно — токен негде безопасно хранить');
    fs.writeFileSync(authFile, safeStorage.encryptString(JSON.stringify(auth)));
  }

  async function tokenRequest(params) {
    const cfg = oauthConfig();
    const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params });
    const r = await fetch(endpoints.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new DriveError(j.error_description || j.error || ('HTTP ' + r.status), r.status, j.error);
    return j;
  }

  function emailFromIdToken(idToken) {
    try {
      return JSON.parse(Buffer.from(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).email || '';
    } catch {
      return '';
    }
  }

  // Opens the system browser; resolves once Google redirects back to the loopback server.
  function login() {
    const cfg = oauthConfig();
    if (!cfg) return Promise.reject(new DriveError('В этой сборке синхронизация с Google не настроена'));
    if (pendingLogin) pendingLogin.cancel();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    return new Promise((resolve, reject) => {
      let settled = false;
      const server = http.createServer();
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingLogin = null;
        setTimeout(() => server.close(), 500);
        err ? reject(err) : resolve(value);
      };
      const timer = setTimeout(() => finish(new DriveError('Вход не завершён за 5 минут', 0, 'timeout')), LOGIN_TIMEOUT_MS);
      pendingLogin = { cancel: () => finish(new DriveError('Вход отменён', 0, 'cancelled')) };
      server.on('request', async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/' || (!url.searchParams.has('code') && !url.searchParams.has('error'))) { res.writeHead(404); res.end(); return; }
        const page = (title, text) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>' + title + '</title><body style="font-family:system-ui;background:#1d1e21;color:#edeff2;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>' + title + '</h2><p style="color:#a5aab3">' + text + '</p></div>');
        };
        if (url.searchParams.get('state') !== state) { page('Ошибка входа', 'Неверный ответ Google. Попробуйте ещё раз из приложения.'); finish(new DriveError('Неверный state в ответе Google')); return; }
        if (url.searchParams.has('error')) {
          page('Вход не выполнен', 'Можно закрыть эту вкладку и вернуться в SSH Client.');
          finish(new DriveError(url.searchParams.get('error') === 'access_denied' ? 'Доступ не разрешён' : 'Google: ' + url.searchParams.get('error'), 0, url.searchParams.get('error')));
          return;
        }
        try {
          const redirectUri = 'http://127.0.0.1:' + server.address().port;
          const tok = await tokenRequest({ code: url.searchParams.get('code'), code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
          if (!tok.refresh_token) throw new DriveError('Google не выдал refresh-токен — попробуйте войти ещё раз');
          auth = { refreshToken: tok.refresh_token, email: emailFromIdToken(tok.id_token || '') };
          access = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 - 60000 };
          saveAuth();
          page('Готово', 'Вход выполнен. Вкладку можно закрыть и вернуться в SSH Client.');
          finish(null, { email: auth.email });
        } catch (e) {
          page('Ошибка входа', String(e.message));
          finish(e);
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const redirectUri = 'http://127.0.0.1:' + server.address().port;
        const q = new URLSearchParams({
          client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
          code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
        });
        shell.openExternal(endpoints.auth + '?' + q.toString());
      });
      server.on('error', (e) => finish(e));
    });
  }

  function cancelLogin() { if (pendingLogin) pendingLogin.cancel(); }

  async function accessToken(force) {
    if (!auth) throw new DriveError('Не выполнен вход в Google', 401, 'signed-out');
    if (!force && access && access.exp > Date.now()) return access.token;
    try {
      const tok = await tokenRequest({ refresh_token: auth.refreshToken, grant_type: 'refresh_token' });
      access = { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 - 60000 };
      return access.token;
    } catch (e) {
      if (e.code === 'invalid_grant') {
        const err = new DriveError('Доступ к Google Диску отозван — войдите заново', 401, 'reauth');
        throw err;
      }
      throw e;
    }
  }

  async function request(url, opts, retried) {
    const token = await accessToken(false);
    const r = await fetch(url, { ...opts, headers: { ...(opts && opts.headers), Authorization: 'Bearer ' + token } });
    if (r.status === 401 && !retried) { access = null; return request(url, opts, true); }
    return r;
  }
  async function json(url, opts) {
    const r = await request(url, opts);
    if (r.status === 404) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new DriveError((j.error && j.error.message) || ('Google Диск: HTTP ' + r.status), r.status);
    return j;
  }
  const FILE_FIELDS = 'id,name,trashed,modifiedTime,webViewLink,appProperties';

  async function getById(id) {
    if (!id) return null;
    return json(endpoints.api + '/files/' + encodeURIComponent(id) + '?fields=' + FILE_FIELDS);
  }
  async function find(q) {
    const j = await json(endpoints.api + '/files?spaces=drive&pageSize=10&orderBy=modifiedTime desc&fields=files(' + FILE_FIELDS + ')&q=' + encodeURIComponent(q));
    return (j && j.files && j.files[0]) || null;
  }
  const escQ = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  async function findFolder(knownId) {
    const byId = await getById(knownId);
    if (byId && !byId.trashed) return byId;
    return find("name='" + FOLDER_NAME + "' and mimeType='" + FOLDER_MIME + "' and trashed=false");
  }
  async function createFolder() {
    return json(endpoints.api + '/files?fields=' + FILE_FIELDS, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
  }
  // Returns { file, wasDeleted }: wasDeleted when the file we knew about is gone or in the trash.
  async function findFile(knownId, folderId) {
    const byId = await getById(knownId);
    if (byId && !byId.trashed) return { file: byId, wasDeleted: false };
    const file = folderId ? await find("name='" + FILE_NAME + "' and '" + escQ(folderId) + "' in parents and trashed=false") : null;
    return { file, wasDeleted: !!knownId && !file };
  }
  async function download(id) {
    const r = await request(endpoints.api + '/files/' + encodeURIComponent(id) + '?alt=media');
    if (!r.ok) throw new DriveError('Не удалось скачать сейф с Google Диска: HTTP ' + r.status, r.status);
    return r.text();
  }
  function multipart(meta, content) {
    const boundary = 'ssh-client-' + crypto.randomBytes(8).toString('hex');
    const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
      '\r\n--' + boundary + '\r\nContent-Type: application/octet-stream\r\n\r\n' + content + '\r\n--' + boundary + '--';
    return { body, type: 'multipart/related; boundary=' + boundary };
  }
  async function upload(fileId, folderId, content, appProperties) {
    const meta = fileId ? { appProperties } : { name: FILE_NAME, parents: [folderId], mimeType: 'application/octet-stream', appProperties };
    const { body, type } = multipart(meta, content);
    const url = fileId
      ? endpoints.upload + '/files/' + encodeURIComponent(fileId) + '?uploadType=multipart&fields=' + FILE_FIELDS
      : endpoints.upload + '/files?uploadType=multipart&fields=' + FILE_FIELDS;
    const j = await json(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': type }, body });
    if (!j) throw new DriveError('Файл на Google Диске не найден', 404);
    return j;
  }
  async function remove(id) {
    const r = await request(endpoints.api + '/files/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new DriveError('Не удалось удалить копию: HTTP ' + r.status, r.status);
  }

  async function logout() {
    const token = auth && auth.refreshToken;
    auth = null;
    access = null;
    try { fs.rmSync(authFile, { force: true }); } catch {}
    if (token) {
      try { await fetch(endpoints.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }); } catch {}
    }
  }

  loadAuth();
  return {
    configured: () => !!oauthConfig(),
    signedIn: () => !!auth,
    email: () => (auth && auth.email) || '',
    login, cancelLogin, logout, findFolder, createFolder, findFile, download, upload, remove,
  };
}

module.exports = { createDrive, endpoints, DriveError, FOLDER_NAME, FILE_NAME };
