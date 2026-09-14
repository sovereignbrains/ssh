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
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp');
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function checkEnvelope(env) {
  if (!env || env.format !== FORMAT || env.version !== VERSION || !env.kdf || !env.kdf.salt) {
    throw new Error('Неизвестный формат файла сейфа');
  }
  return env;
}

function readEnvelopeText(text) {
  let env;
  try {
    env = JSON.parse(text);
  } catch (e) {
    throw new Error('Файл сейфа повреждён или не читается: ' + e.message);
  }
  return checkEnvelope(env);
}

function readEnvelope(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error('Файл сейфа повреждён или не читается: ' + e.message);
  }
  return readEnvelopeText(text);
}

class Vault {
  constructor(file, device) {
    this.file = file;
    this.device = device || '';
    this.key = null;
    this.kdf = null;
    this.lastRev = null; // revision of the file as this process last read or wrote it
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
    this.lastRev = env.rev || null;
    return JSON.parse(plaintext);
  }

  save(data) {
    if (!this.key) throw new Error('Сейф заблокирован');
    const rev = crypto.randomBytes(9).toString('hex');
    const env = { format: FORMAT, version: VERSION, kdf: this.kdf, cipher: 'aes-256-gcm',
      ...encrypt(this.key, JSON.stringify(data)), savedAt: new Date().toISOString(), rev, device: this.device };
    writeAtomic(this.file, JSON.stringify(env, null, 1));
    this.lastRev = rev;
  }

  // The encrypted file exactly as stored — this is what goes to the cloud.
  envelopeText() {
    const text = fs.readFileSync(this.file, 'utf8');
    readEnvelopeText(text);
    return text;
  }

  // Decrypt a copy of the vault from elsewhere with the current key.
  openEnvelope(env) {
    if (!this.key) throw new Error('Сейф заблокирован');
    checkEnvelope(env);
    if (!this.kdf || env.kdf.salt !== this.kdf.salt || env.kdf.N !== this.kdf.N) {
      const e = new Error('Копия сейфа зашифрована другим мастер-паролем');
      e.code = 'needs-password';
      throw e;
    }
    return JSON.parse(decrypt(this.key, env));
  }

  // The other copy uses a different password or salt: open it with its password and switch to its key,
  // so every computer ends up with the same key. The local file is re-encrypted on the next save.
  async adoptEnvelope(password, env) {
    checkEnvelope(env);
    const key = await deriveKey(password, Buffer.from(env.kdf.salt, 'base64'), env.kdf);
    let plaintext;
    try {
      plaintext = decrypt(key, env);
    } catch {
      key.fill(0);
      throw new Error('Неверный мастер-пароль облачной копии');
    }
    if (this.key) this.key.fill(0);
    this.key = key;
    this.kdf = env.kdf;
    return JSON.parse(plaintext);
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

  // Put a downloaded copy in place of a missing local vault (restoring on a new computer).
  installEnvelope(text) {
    if (this.exists()) throw new Error('Сейф на этом компьютере уже есть');
    const env = readEnvelopeText(text);
    writeAtomic(this.file, text);
    this.lastRev = env.rev || null;
    return env;
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

module.exports = { Vault, readEnvelopeText };
