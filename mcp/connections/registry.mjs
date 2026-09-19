import fs from 'node:fs';
import path from 'node:path';
import { normalizeConnectionRecord } from './model.mjs';

const EMPTY_DOCUMENT = Object.freeze({ version: 1, connections: [] });

const clone = (value) => structuredClone(value);

export class ConnectionRegistry {
  constructor({ storagePath, fsImpl = fs, now = () => new Date().toISOString() } = {}) {
    if (!storagePath) throw new Error('connection_registry_storage_path_required');
    this.storagePath = storagePath;
    this.fs = fsImpl;
    this.now = now;
    this.connections = new Map();
  }

  load() {
    let document = EMPTY_DOCUMENT;
    try {
      if (this.fs.existsSync(this.storagePath)) {
        document = JSON.parse(this.fs.readFileSync(this.storagePath, 'utf8'));
      }
    } catch (error) {
      throw Object.assign(new Error('connection_registry_load_failed'), { cause: error });
    }

    if (!document || document.version !== 1 || !Array.isArray(document.connections)) {
      throw new Error('connection_registry_document_invalid');
    }

    const next = new Map();
    for (const raw of document.connections) {
      const record = normalizeConnectionRecord(raw, { now: this.now });
      if (next.has(record.alias)) throw new Error('connection_alias_duplicate');
      next.set(record.alias, record);
    }
    this.connections = next;
    return this.list();
  }

  save() {
    const document = {
      version: 1,
      connections: [...this.connections.values()].map(clone),
    };
    const directory = path.dirname(this.storagePath);
    const temporaryPath = `${this.storagePath}.tmp`;
    this.fs.mkdirSync(directory, { recursive: true });
    this.fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.fs.renameSync(temporaryPath, this.storagePath);
    try { this.fs.chmodSync(this.storagePath, 0o600); } catch {}
  }

  list() {
    return [...this.connections.values()].map(clone);
  }

  get(alias) {
    const record = this.connections.get(alias);
    return record ? clone(record) : null;
  }

  upsert(input) {
    const existing = this.connections.get(input?.alias) || null;
    const record = normalizeConnectionRecord(input, { existing, now: this.now });
    this.connections.set(record.alias, record);
    this.save();
    return clone(record);
  }

  ensure(definitions = []) {
    const ensured = [];
    let changed = false;

    for (const definition of definitions) {
      const existing = this.connections.get(definition.alias);
      if (!existing) {
        const record = normalizeConnectionRecord(definition, { now: this.now });
        this.connections.set(record.alias, record);
        ensured.push(clone(record));
        changed = true;
        continue;
      }

      const next = normalizeConnectionRecord({
        ...existing,
        ...definition,
        target: { ...(existing.target || {}), ...(definition.target || {}) },
        capabilities: [...new Set([...(existing.capabilities || []), ...(definition.capabilities || [])])],
        status: existing.status,
        lastCheckedAt: existing.lastCheckedAt,
        lastError: existing.lastError,
        auth: { ...existing.auth, ...definition.auth },
      }, { existing, now: this.now });

      const { updatedAt: _beforeUpdatedAt, ...beforeStable } = existing;
      const { updatedAt: _afterUpdatedAt, ...afterStable } = next;
      if (JSON.stringify(beforeStable) === JSON.stringify(afterStable)) {
        ensured.push(clone(existing));
        continue;
      }

      this.connections.set(next.alias, next);
      ensured.push(clone(next));
      changed = true;
    }

    if (changed) this.save();
    return ensured;
  }

  updateStatus(alias, status, { lastError = null, checkedAt = this.now() } = {}) {
    const existing = this.connections.get(alias);
    if (!existing) throw new Error('connection_not_found');
    return this.upsert({
      ...existing,
      status,
      lastCheckedAt: checkedAt,
      lastError,
    });
  }
}
