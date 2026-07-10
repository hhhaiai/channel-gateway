import { buildCorrelationKeys } from "./event-normalizer.js";

function requirePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

export class CorrelationBuffer {
  constructor({ ttlMs, maxEntries, now = Date.now }) {
    requirePositiveInteger("ttlMs", ttlMs);
    requirePositiveInteger("maxEntries", maxEntries);

    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.aliases = new Map();
    this.records = new Set();
  }

  capture(record) {
    this.prune();

    const keys = buildCorrelationKeys(record);
    if (keys.length === 0) {
      return null;
    }

    for (const key of keys) {
      const existing = this.aliases.get(key);
      if (existing) {
        this.remove(existing);
      }
    }

    const entry = {
      record,
      keys,
      capturedAt: this.now(),
    };

    this.records.add(entry);
    for (const key of keys) {
      this.aliases.set(key, entry);
    }

    while (this.records.size > this.maxEntries) {
      const oldest = this.records.values().next().value;
      this.remove(oldest);
    }

    return record;
  }

  take(query) {
    this.prune();

    for (const key of buildCorrelationKeys(query)) {
      const entry = this.aliases.get(key);
      if (entry) {
        this.remove(entry);
        return entry.record;
      }
    }

    return null;
  }

  get size() {
    this.prune();
    return this.records.size;
  }

  prune() {
    const currentTime = this.now();

    for (const entry of this.records) {
      if (entry.capturedAt + this.ttlMs > currentTime) {
        break;
      }
      this.remove(entry);
    }
  }

  remove(entry) {
    this.records.delete(entry);

    for (const key of entry.keys) {
      if (this.aliases.get(key) === entry) {
        this.aliases.delete(key);
      }
    }
  }
}
