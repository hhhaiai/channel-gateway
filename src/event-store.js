import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { mergeNonEmpty } from "./event-normalizer.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function requirePositiveInteger(name, value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    const suffix = maximum === Number.MAX_SAFE_INTEGER ? "a positive integer" : `an integer between 1 and ${maximum}`;
    throw new RangeError(`${name} must be ${suffix}`);
  }
}

function requireEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("event must be an object");
  }
  if (typeof event.id !== "string" || event.id.trim() === "") {
    throw new TypeError("event.id must be a non-empty string");
  }
}

function requireErrorCode(code) {
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    throw new TypeError("code must be a controlled uppercase error code");
  }
}

function summarize(row) {
  if (!row) {
    return undefined;
  }

  return {
    id: row.id,
    event: JSON.parse(row.payload),
    status: row.status,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ackedAtMs: row.acked_at_ms,
    failedAtMs: row.failed_at_ms,
    failureCode: row.failure_code,
  };
}

function unknownCursor(after) {
  const error = new RangeError(`unknown cursor: ${after}`);
  error.code = "UNKNOWN_CURSOR";
  return error;
}

export class EventStore extends EventEmitter {
  constructor(databasePath, { now = Date.now } = {}) {
    super();

    if (typeof databasePath !== "string" || databasePath.trim() === "") {
      throw new TypeError("databasePath must be a non-empty string");
    }
    if (typeof now !== "function") {
      throw new TypeError("now must be a function");
    }
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    }

    this.now = now;
    this.database = new DatabaseSync(databasePath);
    this.closed = false;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','acked','failed')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        acked_at_ms INTEGER,
        failed_at_ms INTEGER,
        failure_code TEXT
      );

      CREATE INDEX IF NOT EXISTS events_status_seq ON events(status, seq);
    `);
  }

  enqueue(event) {
    requireEvent(event);
    const canonical = cloneJson(event);
    const timestamp = this.now();
    let result;
    let inserted = false;

    this.#transaction(() => {
      const existing = this.#findRow(canonical.id);

      if (existing) {
        const merged = mergeNonEmpty(JSON.parse(existing.payload), canonical);
        this.database
          .prepare("UPDATE events SET payload = ?, updated_at_ms = ? WHERE id = ?")
          .run(JSON.stringify(merged), timestamp, canonical.id);
      } else {
        this.database
          .prepare(
            `INSERT INTO events (
              id, payload, status, created_at_ms, updated_at_ms
            ) VALUES (?, ?, 'pending', ?, ?)`,
          )
          .run(canonical.id, JSON.stringify(canonical), timestamp, timestamp);
        inserted = true;
      }

      result = summarize(this.#findRow(canonical.id));
    });

    if (inserted) {
      this.#notifyPending(result.event);
    }
    return result;
  }

  listPending({ after, limit = DEFAULT_LIMIT } = {}) {
    requirePositiveInteger("limit", limit, MAX_LIMIT);

    let afterSeq = 0;
    if (after !== undefined && after !== null && after !== "") {
      const cursor = this.database.prepare("SELECT seq FROM events WHERE id = ?").get(after);
      if (!cursor) {
        throw unknownCursor(after);
      }
      afterSeq = cursor.seq;
    }

    const rows = this.database
      .prepare(
        `SELECT id, payload
         FROM events
         WHERE status = 'pending' AND seq > ?
         ORDER BY seq
         LIMIT ?`,
      )
      .all(afterSeq, limit);

    return {
      items: rows.map((row) => JSON.parse(row.payload)),
      nextAfter: rows.at(-1)?.id ?? null,
    };
  }

  pendingCount() {
    return Number(
      this.database.prepare("SELECT COUNT(*) AS count FROM events WHERE status = 'pending'").get()
        .count,
    );
  }

  ack(id, { ackedAtMs = this.now() } = {}) {
    return this.#transition(id, {
      status: "acked",
      timestampColumn: "acked_at_ms",
      timestamp: ackedAtMs,
    });
  }

  fail(id, { code, failedAtMs = this.now() } = {}) {
    requireErrorCode(code);
    return this.#transition(id, {
      status: "failed",
      timestampColumn: "failed_at_ms",
      timestamp: failedAtMs,
      failureCode: code,
    });
  }

  prune({ ackTtlMs, failedTtlMs, nowMs = this.now() }) {
    requirePositiveInteger("ackTtlMs", ackTtlMs);
    requirePositiveInteger("failedTtlMs", failedTtlMs);

    const acked = this.database
      .prepare(
        `DELETE FROM events
         WHERE status = 'acked' AND acked_at_ms IS NOT NULL AND acked_at_ms <= ?`,
      )
      .run(nowMs - ackTtlMs).changes;
    const failed = this.database
      .prepare(
        `DELETE FROM events
         WHERE status = 'failed' AND failed_at_ms IS NOT NULL AND failed_at_ms <= ?`,
      )
      .run(nowMs - failedTtlMs).changes;

    return { acked: Number(acked), failed: Number(failed) };
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.database.close();
  }

  #findRow(id) {
    return this.database.prepare("SELECT * FROM events WHERE id = ?").get(id);
  }

  #notifyPending(event) {
    for (const listener of this.rawListeners("pending")) {
      try {
        listener.call(this, cloneJson(event));
      } catch {
        // The event is already durable; one consumer must not break enqueue or other consumers.
      }
    }
  }

  #transaction(callback) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  #transition(id, { status, timestampColumn, timestamp, failureCode = null }) {
    let result;

    this.#transaction(() => {
      const existing = this.#findRow(id);
      if (!existing) {
        return;
      }

      if (existing.status === "pending") {
        this.database
          .prepare(
            `UPDATE events
             SET status = ?, ${timestampColumn} = ?, failure_code = ?, updated_at_ms = ?
             WHERE id = ?`,
          )
          .run(status, timestamp, failureCode, timestamp, id);
      }
      result = summarize(this.#findRow(id));
    });

    return result;
  }
}
