// Encrypted vault file: scrypt key derivation + AES-256-GCM.
// The derived key is kept only inside an unlocked Vault instance.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 'ssh-vault';
const VERSION = 1;
const AAD = Buffer.from(FORMAT + '-v' + VERSION);
const KDF_DEFAULTS = { N: 1 << 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 512 * 1024 * 1024;

function deriveKey(password, salt, kdf) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFC'), salt, 32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(key, envelope) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function readEnvelope(file) {
  let env;
  try {
    env = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error('Файл сейфа повреждён или не читается: ' + e.message);
  }
  if (env.format !== FORMAT || env.version !== VERSION || !env.kdf || !env.kdf.salt) {
    throw new Error('Неизвестный формат файла сейфа');
  }
  return env;
}

class Vault {
  constructor(file) {
    this.file = file;
    this.key = null;
    this.kdf = null;
  }

  exists() { return fs.existsSync(this.file); }
  isUnlocked() { return !!this.key; }

  async create(password, data) {
    if (this.exists()) throw new Error('Сейф уже существует');
    const kdf = { name: 'scrypt', ...KDF_DEFAULTS, salt: crypto.randomBytes(16).toString('base64') };
    this.key = await deriveKey(password, Buffer.from(kdf.salt, 'base64'), kdf);
    this.kdf = kdf;
    this.save(data || {});
  }

  async unlock(password) {
    const env = readEnvelope(this.file);
    const key = await deriveKey(password, Buffer.from(env.kdf.salt, 'base64'), env.kdf);
    let plaintext;
    try {
      plaintext = decrypt(key, env);
    } catch {
      key.fill(0);
      throw new Error('Неверный мастер-пароль');
    }
    this.key = key;
    this.kdf = env.kdf;
    return JSON.parse(plaintext);
  }

  save(data) {
    if (!this.key) throw new Error('Сейф заблокирован');
    const env = { format: FORMAT, version: VERSION, kdf: this.kdf, cipher: 'aes-256-gcm',
      ...encrypt(this.key, JSON.stringify(data)), savedAt: new Date().toISOString() };
    writeAtomic(this.file, JSON.stringify(env, null, 1));
  }

  async changePassword(oldPassword, newPassword) {
    const env = readEnvelope(this.file);
    const oldKey = await deriveKey(oldPassword, Buffer.from(env.kdf.salt, 'base64'), env.kdf);
    let plaintext;
    try {
      plaintext = decrypt(oldKey, env);
    } catch {
      throw new Error('Текущий мастер-пароль неверен');
    } finally {
      oldKey.fill(0);
    }
    const kdf = { name: 'scrypt', ...KDF_DEFAULTS, salt: crypto.randomBytes(16).toString('base64') };
    const newKey = await deriveKey(newPassword, Buffer.from(kdf.salt, 'base64'), kdf);
    this.lock();
    this.key = newKey;
    this.kdf = kdf;
    this.save(JSON.parse(plaintext));
  }

  lock() {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.kdf = null;
  }

  moveTo(newFile) {
    if (path.resolve(newFile) === path.resolve(this.file)) return;
    if (fs.existsSync(newFile)) {
      // No vault here yet: adopt the existing one (e.g. a portable vault on a USB drive).
      if (!this.exists()) {
        this.lock();
        this.file = newFile;
        return;
      }
      throw new Error('В выбранной папке уже есть другой secrets.vault — выберите пустую папку');
    }
    if (this.exists()) {
      fs.mkdirSync(path.dirname(newFile), { recursive: true });
      fs.copyFileSync(this.file, newFile);
      fs.unlinkSync(this.file);
    }
    this.file = newFile;
  }
}

module.exports = { Vault };
