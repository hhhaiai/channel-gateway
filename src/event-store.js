import { randomUUID } from "node:crypto";
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

function nonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(name, value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER
      ? "a positive integer"
      : `an integer between 1 and ${maximum}`;
    throw new RangeError(`${name} must be ${range}`);
  }
  return value;
}

function finiteInteger(name, value) {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
  return value;
}

function requireEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("event must be an object");
  }
  nonEmptyString("event.id", event.id);
}

function requireErrorCode(code) {
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    throw new TypeError("code must be a controlled uppercase error code");
  }
  return code;
}

function requireDelivery(delivery, eventId, defaultAvailableAtMs) {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new TypeError("delivery must be an object");
  }

  const normalized = {
    id: nonEmptyString("delivery.id", delivery.id),
    eventId: nonEmptyString("delivery.eventId", delivery.eventId),
    linkId: nonEmptyString("delivery.linkId", delivery.linkId),
    sourceEndpointId: nonEmptyString(
      "delivery.sourceEndpointId",
      delivery.sourceEndpointId,
    ),
    destinationEndpointId: nonEmptyString(
      "delivery.destinationEndpointId",
      delivery.destinationEndpointId,
    ),
    destinationChannel: nonEmptyString(
      "delivery.destinationChannel",
      delivery.destinationChannel,
    ),
    destinationAccountId: nonEmptyString(
      "delivery.destinationAccountId",
      delivery.destinationAccountId,
    ),
    destinationConversationId: nonEmptyString(
      "delivery.destinationConversationId",
      delivery.destinationConversationId,
    ),
    nextAttemptAtMs:
      delivery.nextAttemptAtMs === undefined
        ? defaultAvailableAtMs
        : finiteInteger("delivery.nextAttemptAtMs", delivery.nextAttemptAtMs),
  };

  if (normalized.eventId !== eventId) {
    throw new TypeError("delivery.eventId must match event.id");
  }
  if (!delivery.request || typeof delivery.request !== "object" || Array.isArray(delivery.request)) {
    throw new TypeError("delivery.request must be an object");
  }
  if (nonEmptyString("delivery.request.idempotencyKey", delivery.request.idempotencyKey) !== normalized.id) {
    throw new TypeError("delivery.request.idempotencyKey must equal delivery.id");
  }

  normalized.request = cloneJson(delivery.request);
  return normalized;
}

function summarizeEvent(row) {
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

function summarizeDelivery(row) {
  if (!row) {
    return undefined;
  }

  return {
    id: row.id,
    deliveryId: row.id,
    eventId: row.event_id,
    linkId: row.link_id,
    sourceEndpointId: row.source_endpoint_id,
    destinationEndpointId: row.destination_endpoint_id,
    destinationChannel: row.destination_channel,
    destinationAccountId: row.destination_account_id,
    destinationConversationId: row.destination_conversation_id,
    request: JSON.parse(row.request_json),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAtMs: row.next_attempt_at_ms,
    leaseToken: row.lease_token,
    leaseUntilMs: row.lease_until_ms,
    receiptMessageId: row.receipt_message_id,
    errorCode: row.error_code,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function unknownCursor(after) {
  const error = new RangeError(`unknown cursor: ${after}`);
  error.code = "UNKNOWN_CURSOR";
  return error;
}

function deliveryRelation(row) {
  if (!row) {
    return undefined;
  }
  return {
    deliveryId: row.id,
    eventId: row.event_id,
    linkId: row.link_id,
    sourceEndpointId: row.source_endpoint_id,
    destinationEndpointId: row.destination_endpoint_id,
    destinationChannel: row.destination_channel,
    destinationAccountId: row.destination_account_id,
    destinationConversationId: row.destination_conversation_id,
    receiptMessageId: row.receipt_message_id,
  };
}

export class EventStore extends EventEmitter {
  constructor(databasePath, { now = Date.now } = {}) {
    super();

    nonEmptyString("databasePath", databasePath);
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
      PRAGMA busy_timeout = 1000;
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

      CREATE TABLE IF NOT EXISTS deliveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        link_id TEXT NOT NULL,
        source_endpoint_id TEXT NOT NULL,
        destination_endpoint_id TEXT NOT NULL,
        destination_channel TEXT NOT NULL,
        destination_account_id TEXT NOT NULL,
        destination_conversation_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL,
        lease_token TEXT,
        lease_until_ms INTEGER,
        receipt_message_id TEXT,
        error_code TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(event_id, link_id, destination_endpoint_id)
      );

      CREATE INDEX IF NOT EXISTS deliveries_due
        ON deliveries(status, next_attempt_at_ms, lease_until_ms, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS deliveries_receipt
        ON deliveries(
          destination_channel,
          destination_account_id,
          destination_conversation_id,
          receipt_message_id
        ) WHERE receipt_message_id IS NOT NULL;
    `);
  }

  enqueue(event, { deliveries = [] } = {}) {
    requireEvent(event);
    if (!Array.isArray(deliveries)) {
      throw new TypeError("deliveries must be an array");
    }

    const canonical = cloneJson(event);
    const timestamp = finiteInteger("now", this.now());
    let result;
    let inserted = false;

    this.#transaction(() => {
      const existing = this.#findEvent(canonical.id);
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

      if (inserted) {
        for (const delivery of deliveries) {
          this.#insertDelivery(requireDelivery(delivery, canonical.id, timestamp), timestamp);
        }
      }
      result = summarizeEvent(this.#findEvent(canonical.id));
    });

    if (inserted) {
      this.#notifyPending(result.event);
    }
    return result;
  }

  listPending({ after, limit = DEFAULT_LIMIT } = {}) {
    positiveInteger("limit", limit, MAX_LIMIT);

    let afterSeq = 0;
    if (after !== undefined && after !== null) {
      nonEmptyString("after", after);
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
    return this.#transitionEvent(id, {
      status: "acked",
      timestampColumn: "acked_at_ms",
      timestamp: finiteInteger("ackedAtMs", ackedAtMs),
    });
  }

  fail(id, { code, failedAtMs = this.now() } = {}) {
    return this.#transitionEvent(id, {
      status: "failed",
      timestampColumn: "failed_at_ms",
      timestamp: finiteInteger("failedAtMs", failedAtMs),
      failureCode: requireErrorCode(code),
    });
  }

  prune({ ackTtlMs, failedTtlMs, nowMs = this.now() }) {
    positiveInteger("ackTtlMs", ackTtlMs);
    positiveInteger("failedTtlMs", failedTtlMs);
    finiteInteger("nowMs", nowMs);

    const protectedByDelivery = `
      AND NOT EXISTS (
        SELECT 1 FROM deliveries WHERE deliveries.event_id = events.id
      )`;
    const acked = this.database
      .prepare(
        `DELETE FROM events
         WHERE status = 'acked' AND acked_at_ms IS NOT NULL AND acked_at_ms <= ?
         ${protectedByDelivery}`,
      )
      .run(nowMs - ackTtlMs).changes;
    const failed = this.database
      .prepare(
        `DELETE FROM events
         WHERE status = 'failed' AND failed_at_ms IS NOT NULL AND failed_at_ms <= ?
         ${protectedByDelivery}`,
      )
      .run(nowMs - failedTtlMs).changes;

    return { acked: Number(acked), failed: Number(failed) };
  }

  claimNextDelivery({
    nowMs = this.now(),
    leaseMs = 30_000,
    leaseToken = randomUUID(),
  } = {}) {
    finiteInteger("nowMs", nowMs);
    positiveInteger("leaseMs", leaseMs);
    nonEmptyString("leaseToken", leaseToken);
    let claimed;

    this.#transaction(() => {
      const row = this.database
        .prepare(
          `SELECT * FROM deliveries
           WHERE (status = 'pending' AND next_attempt_at_ms <= ?)
              OR (status = 'sending' AND lease_until_ms IS NOT NULL AND lease_until_ms <= ?)
           ORDER BY
             CASE status
               WHEN 'pending' THEN next_attempt_at_ms
               ELSE lease_until_ms
             END,
             seq
           LIMIT 1`,
        )
        .get(nowMs, nowMs);
      if (!row) {
        return;
      }

      const updated = this.database
        .prepare(
          `UPDATE deliveries
           SET status = 'sending', attempts = attempts + 1,
               lease_token = ?, lease_until_ms = ?, updated_at_ms = ?
           WHERE id = ?
             AND ((status = 'pending' AND next_attempt_at_ms <= ?)
               OR (status = 'sending' AND lease_until_ms IS NOT NULL AND lease_until_ms <= ?))`,
        )
        .run(leaseToken, nowMs + leaseMs, nowMs, row.id, nowMs, nowMs);
      if (updated.changes === 1) {
        claimed = summarizeDelivery(this.#findDelivery(row.id));
      }
    });

    return claimed;
  }

  completeDelivery(id, { leaseToken, messageId, completedAtMs = this.now() }) {
    nonEmptyString("leaseToken", leaseToken);
    const receiptMessageId = messageId == null ? null : nonEmptyString("messageId", messageId);
    finiteInteger("completedAtMs", completedAtMs);

    const updated = this.database
      .prepare(
        `UPDATE deliveries
         SET status = 'sent', receipt_message_id = ?, error_code = NULL,
             lease_token = NULL, lease_until_ms = NULL, updated_at_ms = ?
         WHERE id = ? AND status = 'sending' AND lease_token = ?`,
      )
      .run(receiptMessageId, completedAtMs, id, leaseToken);
    return updated.changes === 1
      ? summarizeDelivery(this.#findDelivery(id))
      : undefined;
  }

  retryDelivery(
    id,
    {
      leaseToken,
      code,
      nextAttemptAtMs,
      maxAttempts,
      updatedAtMs = this.now(),
    },
  ) {
    nonEmptyString("leaseToken", leaseToken);
    requireErrorCode(code);
    finiteInteger("nextAttemptAtMs", nextAttemptAtMs);
    positiveInteger("maxAttempts", maxAttempts);
    finiteInteger("updatedAtMs", updatedAtMs);
    let result;

    this.#transaction(() => {
      const current = this.database
        .prepare(
          `SELECT * FROM deliveries
           WHERE id = ? AND status = 'sending' AND lease_token = ?`,
        )
        .get(id, leaseToken);
      if (!current) {
        return;
      }

      const status = current.attempts >= maxAttempts ? "failed" : "pending";
      this.database
        .prepare(
          `UPDATE deliveries
           SET status = ?, next_attempt_at_ms = ?, error_code = ?,
               lease_token = NULL, lease_until_ms = NULL, updated_at_ms = ?
           WHERE id = ? AND status = 'sending' AND lease_token = ?`,
        )
        .run(status, nextAttemptAtMs, code, updatedAtMs, id, leaseToken);
      result = summarizeDelivery(this.#findDelivery(id));
    });

    return result;
  }

  deliveryCounts() {
    const counts = { pending: 0, sending: 0, sent: 0, failed: 0 };
    for (const row of this.database
      .prepare("SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status")
      .all()) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }

  findEcho({ channel, accountId = "default", conversationId, messageId }) {
    const row = this.database
      .prepare(
        `SELECT * FROM deliveries
         WHERE status = 'sent'
           AND destination_channel = ?
           AND destination_account_id = ?
           AND destination_conversation_id = ?
           AND receipt_message_id = ?`,
      )
      .get(channel, accountId, conversationId, messageId);
    return deliveryRelation(row);
  }

  findDeliveryByMarker(deliveryId) {
    return deliveryRelation(this.#findDelivery(deliveryId));
  }

  resolveReplyTargets(event) {
    const replyMessageId = event?.replyTo?.id;
    if (!replyMessageId) {
      return new Map();
    }

    const parent = this.findEcho({
      channel: event.channel,
      accountId: event.accountId || "default",
      conversationId: event.conversationId,
      messageId: replyMessageId,
    });
    if (!parent) {
      return new Map();
    }

    const sourceEvent = this.#findEvent(parent.eventId);
    if (!sourceEvent) {
      return new Map();
    }

    const targets = new Map();
    const sourceMessageId = JSON.parse(sourceEvent.payload).messageId;
    if (sourceMessageId) {
      targets.set(parent.sourceEndpointId, sourceMessageId);
    }
    for (const row of this.database
      .prepare(
        `SELECT destination_endpoint_id, receipt_message_id
         FROM deliveries
         WHERE event_id = ? AND link_id = ?
           AND status = 'sent' AND receipt_message_id IS NOT NULL
         ORDER BY seq`,
      )
      .all(parent.eventId, parent.linkId)) {
      targets.set(row.destination_endpoint_id, row.receipt_message_id);
    }
    return targets;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
  }

  #findEvent(id) {
    return this.database.prepare("SELECT * FROM events WHERE id = ?").get(id);
  }

  #findDelivery(id) {
    return this.database.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
  }

  #insertDelivery(delivery, timestamp) {
    this.database
      .prepare(
        `INSERT INTO deliveries (
          id, event_id, link_id, source_endpoint_id, destination_endpoint_id,
          destination_channel, destination_account_id, destination_conversation_id,
          request_json, status, attempts, next_attempt_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(event_id, link_id, destination_endpoint_id) DO NOTHING`,
      )
      .run(
        delivery.id,
        delivery.eventId,
        delivery.linkId,
        delivery.sourceEndpointId,
        delivery.destinationEndpointId,
        delivery.destinationChannel,
        delivery.destinationAccountId,
        delivery.destinationConversationId,
        JSON.stringify(delivery.request),
        delivery.nextAttemptAtMs,
        timestamp,
        timestamp,
      );
  }

  #notifyPending(event) {
    for (const listener of this.rawListeners("pending")) {
      try {
        listener.call(this, cloneJson(event));
      } catch {
        // The event is durable; one synchronous consumer must not break another.
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

  #transitionEvent(id, { status, timestampColumn, timestamp, failureCode = null }) {
    let result;
    this.#transaction(() => {
      const existing = this.#findEvent(id);
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
      result = summarizeEvent(this.#findEvent(id));
    });
    return result;
  }
}
