// Encrypted vault file: argon2id (new vaults) or scrypt (older ones) key derivation + AES-256-GCM.
// The derived key is kept only inside an unlocked Vault instance.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 'ssh-vault';
const VERSION = 1;
const AAD = Buffer.from(FORMAT + '-v' + VERSION);
// argon2id is memory-hard in a way scrypt's parameters here are not. Vaults written before it stay
// readable — each file carries its own kdf block — and move over when the owner upgrades.
const KDF_ARGON2 = { name: 'argon2id', m: 262144, t: 3, p: 1 };
const newKdf = () => ({ ...KDF_ARGON2, salt: crypto.randomBytes(16).toString('base64') });
// Two copies share a key only when the whole derivation matches, not just the salt.
const kdfId = (k) => [k.name || 'scrypt', k.salt, k.N || '', k.r || '', k.m || '', k.t || '', k.p || ''].join(':');
const SCRYPT_MAXMEM = 512 * 1024 * 1024;

async function deriveKey(password, kdf) {
  const salt = Buffer.from(kdf.salt, 'base64');
  const pass = String(password).normalize('NFC');
  if (kdf.name === 'argon2id') {
    const { argon2id } = require('hash-wasm');
    const key = await argon2id({ password: pass, salt, parallelism: kdf.p, memorySize: kdf.m, iterations: kdf.t, hashLength: 32, outputType: 'binary' });
    return Buffer.from(key);
  }
  return new Promise((resolve, reject) => {
    crypto.scrypt(pass, salt, 32,
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
  if (env.kdf.name && env.kdf.name !== 'scrypt' && env.kdf.name !== KDF_ARGON2.name) {
    throw new Error('Сейф зашифрован новее этой версии приложения (' + env.kdf.name + ') — обновите клиент');
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

  // What the lock screen can tell about the file before anything is decrypted: which vault this is
  // (copies that open with the same password share a fingerprint) and how fresh the copy is.
  meta() {
    try {
      const env = readEnvelope(this.file);
      return {
        fingerprint: crypto.createHash('sha256').update(env.kdf.salt).digest('hex').slice(0, 8),
        kdf: env.kdf.name || 'scrypt',
        savedAt: env.savedAt || '',
        device: env.device || '',
        rev: env.rev || '',
      };
    } catch {
      return null;
    }
  }
  isUnlocked() { return !!this.key; }

  async create(password, data) {
    if (this.exists()) throw new Error('Сейф уже существует');
    const kdf = newKdf();
    this.key = await deriveKey(password, kdf);
    this.kdf = kdf;
    this.save(data || {});
  }

  async unlock(password) {
    const env = readEnvelope(this.file);
    const key = await deriveKey(password, env.kdf);
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

  // Unlock with a key produced elsewhere - Windows Hello keeps a wrapped copy of this very key.
  // The file carries no trace of how the key was obtained, so this is exactly the password path
  // minus the derivation.
  unlockWithKey(key) {
    const env = readEnvelope(this.file);
    let plaintext;
    try {
      plaintext = decrypt(key, env);
    } catch {
      throw new Error('Сохранённый ключ не подходит к этому сейфу');
    }
    this.key = Buffer.from(key);
    this.kdf = env.kdf;
    this.lastRev = env.rev || null;
    return JSON.parse(plaintext);
  }

  // A copy of the live key, so a second factor can wrap it. Only while unlocked.
  exportKey() {
    if (!this.key) throw new Error('Сейф заблокирован');
    return Buffer.from(this.key);
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
    if (!this.kdf || kdfId(env.kdf) !== kdfId(this.kdf)) {
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
    const key = await deriveKey(password, env.kdf);
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
    const oldKey = await deriveKey(oldPassword, env.kdf);
    let plaintext;
    try {
      plaintext = decrypt(oldKey, env);
    } catch {
      throw new Error('Текущий мастер-пароль неверен');
    } finally {
      oldKey.fill(0);
    }
    const kdf = newKdf();
    const newKey = await deriveKey(newPassword, kdf);
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
