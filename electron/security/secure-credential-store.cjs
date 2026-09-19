const fs = require('node:fs');
const path = require('node:path');

class SecureCredentialStore {
  constructor({ storagePath, safeStorage, fsImpl = fs, now = () => new Date().toISOString() } = {}) {
    if (!storagePath) throw new Error('credential_store_storage_path_required');
    if (!safeStorage) throw new Error('credential_store_safe_storage_required');
    this.storagePath = storagePath;
    this.safeStorage = safeStorage;
    this.fs = fsImpl;
    this.now = now;
  }

  assertAvailable() {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('secure_storage_unavailable');
    }
  }

  readDocument() {
    try {
      if (!this.fs.existsSync(this.storagePath)) return { version: 1, credentials: {} };
      const document = JSON.parse(this.fs.readFileSync(this.storagePath, 'utf8'));
      if (!document || document.version !== 1 || !document.credentials || typeof document.credentials !== 'object' || Array.isArray(document.credentials)) {
        throw new Error('credential_store_document_invalid');
      }
      return document;
    } catch (error) {
      if (error?.message === 'credential_store_document_invalid') throw error;
      throw Object.assign(new Error('credential_store_load_failed'), { cause: error });
    }
  }

  writeDocument(document) {
    const directory = path.dirname(this.storagePath);
    const temporaryPath = `${this.storagePath}.tmp`;
    this.fs.mkdirSync(directory, { recursive: true });
    this.fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.fs.renameSync(temporaryPath, this.storagePath);
    try { this.fs.chmodSync(this.storagePath, 0o600); } catch {}
  }

  validateRef(ref) {
    if (typeof ref !== 'string' || !/^credential:[a-z0-9][a-z0-9:-]*$/.test(ref)) {
      throw new Error('credential_ref_invalid');
    }
    return ref;
  }

  hasSecret(ref) {
    this.assertAvailable();
    this.validateRef(ref);
    const document = this.readDocument();
    return Boolean(document.credentials[ref]?.ciphertext);
  }

  setSecret(ref, value) {
    this.assertAvailable();
    this.validateRef(ref);
    if (value === undefined) throw new Error('credential_value_required');

    const document = this.readDocument();
    const existing = document.credentials[ref] || null;
    const plaintext = JSON.stringify(value);
    const encrypted = this.safeStorage.encryptString(plaintext);
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('credential_encryption_failed');

    const timestamp = this.now();
    document.credentials[ref] = {
      ciphertext: encrypted.toString('base64'),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    this.writeDocument(document);
    return true;
  }

  getSecret(ref) {
    this.assertAvailable();
    this.validateRef(ref);
    const entry = this.readDocument().credentials[ref];
    if (!entry?.ciphertext) return null;
    try {
      const plaintext = this.safeStorage.decryptString(Buffer.from(entry.ciphertext, 'base64'));
      return JSON.parse(plaintext);
    } catch (error) {
      throw Object.assign(new Error('credential_decryption_failed'), { cause: error });
    }
  }

  deleteSecret(ref) {
    this.assertAvailable();
    this.validateRef(ref);
    const document = this.readDocument();
    if (!document.credentials[ref]) return false;
    delete document.credentials[ref];
    this.writeDocument(document);
    return true;
  }
}

module.exports = { SecureCredentialStore };
