import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { mergeNonEmpty } from "./event-normalizer.js";
import { GATEWAY_STORAGE_CONTRACT_VERSION } from "./storage-contract.js";
import {
  aggregateDeliveryRequests,
  isAggregationCompatible,
  validateDeliveryAggregation,
} from "./delivery-aggregation.js";

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

function requireExcludedDestinations(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("excludedDestinations must be an array");
  }
  if (value.length > 256) {
    throw new RangeError("excludedDestinations must contain at most 256 entries");
  }
  return value.map((destination, index) => {
    if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
      throw new TypeError(`excludedDestinations[${index}] must be an object`);
    }
    return {
      channel: nonEmptyString(
        `excludedDestinations[${index}].channel`,
        destination.channel,
      ),
      accountId: nonEmptyString(
        `excludedDestinations[${index}].accountId`,
        destination.accountId,
      ),
      conversationId: nonEmptyString(
        `excludedDestinations[${index}].conversationId`,
        destination.conversationId,
      ),
    };
  });
}

function requireExcludedAccounts(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("excludedAccounts must be an array");
  }
  if (value.length > 10_000) {
    throw new RangeError("excludedAccounts must contain at most 10000 entries");
  }
  return value.map((account, index) => {
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw new TypeError(`excludedAccounts[${index}] must be an object`);
    }
    return {
      channel: nonEmptyString(`excludedAccounts[${index}].channel`, account.channel),
      accountId: nonEmptyString(`excludedAccounts[${index}].accountId`, account.accountId),
    };
  });
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

function summarizeAggregate(row, members, request) {
  return {
    ...summarizeDelivery(row),
    request,
    aggregateMemberIds: members.map((member) => member.id),
    transformedRequest: row.transform_request_json
      ? JSON.parse(row.transform_request_json)
      : null,
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
        aggregate_id TEXT,
        aggregate_index INTEGER,
        transform_request_json TEXT,
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
    const deliveryColumns = new Set(
      this.database.prepare("PRAGMA table_info(deliveries)").all().map((column) => column.name),
    );
    if (!deliveryColumns.has("aggregate_id")) {
      this.database.exec("ALTER TABLE deliveries ADD COLUMN aggregate_id TEXT");
    }
    if (!deliveryColumns.has("aggregate_index")) {
      this.database.exec("ALTER TABLE deliveries ADD COLUMN aggregate_index INTEGER");
    }
    if (!deliveryColumns.has("transform_request_json")) {
      this.database.exec("ALTER TABLE deliveries ADD COLUMN transform_request_json TEXT");
    }
    this.database.exec(
      "CREATE INDEX IF NOT EXISTS deliveries_aggregate ON deliveries(aggregate_id, aggregate_index)",
    );
    this.database.exec(
      `CREATE INDEX IF NOT EXISTS deliveries_aggregation_candidates
       ON deliveries(link_id, destination_endpoint_id, status, attempts, next_attempt_at_ms, seq)
       WHERE aggregate_id IS NULL`,
    );
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

    let acked = 0;
    let failed = 0;
    this.#transaction(() => {
      this.database
        .prepare(
          `DELETE FROM deliveries
           WHERE status IN ('sent', 'failed')
             AND EXISTS (
               SELECT 1 FROM events
               WHERE events.id = deliveries.event_id
                 AND (
                   (events.status = 'acked' AND events.acked_at_ms IS NOT NULL
                     AND events.acked_at_ms <= ?)
                   OR
                   (events.status = 'failed' AND events.failed_at_ms IS NOT NULL
                     AND events.failed_at_ms <= ?)
                 )
             )`,
        )
        .run(nowMs - ackTtlMs, nowMs - failedTtlMs);

      const protectedByDelivery = `
        AND NOT EXISTS (
          SELECT 1 FROM deliveries WHERE deliveries.event_id = events.id
        )`;
      acked = this.database
        .prepare(
          `DELETE FROM events
           WHERE status = 'acked' AND acked_at_ms IS NOT NULL AND acked_at_ms <= ?
           ${protectedByDelivery}`,
        )
        .run(nowMs - ackTtlMs).changes;
      failed = this.database
        .prepare(
          `DELETE FROM events
           WHERE status = 'failed' AND failed_at_ms IS NOT NULL AND failed_at_ms <= ?
           ${protectedByDelivery}`,
        )
        .run(nowMs - failedTtlMs).changes;
    });

    return { acked: Number(acked), failed: Number(failed) };
  }

  claimNextDelivery({
    nowMs = this.now(),
    leaseMs = 30_000,
    leaseToken = randomUUID(),
    excludedDestinations = [],
    excludedAccounts = [],
    aggregation,
  } = {}) {
    finiteInteger("nowMs", nowMs);
    positiveInteger("leaseMs", leaseMs);
    nonEmptyString("leaseToken", leaseToken);
    const excluded = requireExcludedDestinations(excludedDestinations);
    const accounts = requireExcludedAccounts(excludedAccounts);
    const aggregationPolicy = validateDeliveryAggregation(aggregation);
    const exclusionSql = excluded.map(
      () => `AND NOT (
             destination_channel = ?
             AND destination_account_id = ?
             AND destination_conversation_id = ?
           )`,
    ).join("\n");
    const exclusionParams = excluded.flatMap((destination) => [
      destination.channel,
      destination.accountId,
      destination.conversationId,
    ]);
    const accountExclusionSql = accounts.length === 0
      ? ""
      : `AND NOT EXISTS (
             SELECT 1
             FROM json_each(?) AS excluded_account
             WHERE json_extract(excluded_account.value, '$.channel') = destination_channel
               AND json_extract(excluded_account.value, '$.accountId') = destination_account_id
           )`;
    const accountExclusionParams = accounts.length === 0
      ? []
      : [JSON.stringify(accounts)];
    let claimed;

    this.#transaction(() => {
      const row = this.database
        .prepare(
          `SELECT * FROM deliveries
           WHERE ((status = 'pending' AND next_attempt_at_ms <= ?)
              OR (status = 'sending' AND lease_until_ms IS NOT NULL AND lease_until_ms <= ?))
           ${exclusionSql}
           ${accountExclusionSql}
           ORDER BY
             CASE status
               WHEN 'pending' THEN next_attempt_at_ms
               ELSE lease_until_ms
             END,
             seq
           LIMIT 1`,
        )
        .get(nowMs, nowMs, ...exclusionParams, ...accountExclusionParams);
      if (!row) {
        return;
      }

      let members = [row];
      let aggregateRequest = JSON.parse(row.request_json);
      const existingAggregateId = row.aggregate_id;
      if (existingAggregateId) {
        members = this.database.prepare(
          `SELECT * FROM deliveries
           WHERE aggregate_id = ?
           ORDER BY aggregate_index, seq`,
        ).all(existingAggregateId);
        const built = aggregateDeliveryRequests(
          members.map((member) => JSON.parse(member.request_json)),
          {
            aggregateId: existingAggregateId,
            maxItems: Math.max(1, members.length),
            maxBytes: 262_144,
          },
        );
        aggregateRequest = built.request;
      } else if (
        aggregationPolicy.enabled &&
        row.status === "pending" &&
        row.attempts === 0 &&
        isAggregationCompatible(aggregateRequest) &&
        Buffer.byteLength(aggregateRequest.message) <= aggregationPolicy.maxBytes
      ) {
        const candidates = this.database.prepare(
          `SELECT * FROM deliveries
           WHERE status = 'pending' AND attempts = 0 AND next_attempt_at_ms <= ?
             AND aggregate_id IS NULL
             AND link_id = ? AND destination_endpoint_id = ?
             AND destination_channel = ? AND destination_account_id = ?
             AND destination_conversation_id = ?
           ORDER BY seq
           LIMIT ?`,
        ).all(
          nowMs,
          row.link_id,
          row.destination_endpoint_id,
          row.destination_channel,
          row.destination_account_id,
          row.destination_conversation_id,
          aggregationPolicy.maxItems,
        );
        const built = aggregateDeliveryRequests(
          candidates.map((candidate) => JSON.parse(candidate.request_json)),
          {
            aggregateId: row.id,
            maxItems: aggregationPolicy.maxItems,
            maxBytes: aggregationPolicy.maxBytes,
          },
        );
        const included = new Set(built.memberIds);
        members = candidates.filter((candidate) => included.has(candidate.id));
        aggregateRequest = built.request;
      }

      const aggregateId = existingAggregateId ?? row.id;
      const ids = members.map((member) => member.id);
      const placeholders = ids.map(() => "?").join(",");
      const updated = this.database.prepare(
        `UPDATE deliveries
         SET status = 'sending', attempts = attempts + 1,
             lease_token = ?, lease_until_ms = ?, updated_at_ms = ?,
             aggregate_id = ?,
             aggregate_index = CASE id ${ids.map((_, index) => `WHEN ? THEN ${index}`).join(" ")} END
         WHERE id IN (${placeholders})
           AND ((status = 'pending' AND next_attempt_at_ms <= ?)
             OR (status = 'sending' AND lease_until_ms IS NOT NULL AND lease_until_ms <= ?))`,
      ).run(
        leaseToken,
        nowMs + leaseMs,
        nowMs,
        aggregateId,
        ...ids,
        ...ids,
        nowMs,
        nowMs,
      );
      if (updated.changes === ids.length) {
        const currentMembers = this.#aggregateMembers(aggregateId);
        claimed = summarizeAggregate(
          currentMembers[0],
          currentMembers,
          aggregateRequest,
        );
      }
    });

    return claimed;
  }

  completeDelivery(id, { leaseToken, messageId, completedAtMs = this.now() }) {
    nonEmptyString("leaseToken", leaseToken);
    const receiptMessageId = messageId == null ? null : nonEmptyString("messageId", messageId);
    finiteInteger("completedAtMs", completedAtMs);

    let result;
    this.#transaction(() => {
      const members = this.#aggregateMembersForId(id, leaseToken);
      if (members.length === 0) return;
      const aggregateId = members[0].aggregate_id ?? id;
      const updated = this.database.prepare(
        `UPDATE deliveries
         SET status = 'sent',
             receipt_message_id = CASE WHEN id = ? THEN ? ELSE NULL END,
             error_code = NULL, lease_token = NULL, lease_until_ms = NULL, updated_at_ms = ?
         WHERE aggregate_id = ? AND status = 'sending' AND lease_token = ?`,
      ).run(id, receiptMessageId, completedAtMs, aggregateId, leaseToken);
      if (updated.changes === members.length) {
        const completed = this.#aggregateMembers(aggregateId);
        result = summarizeAggregate(completed[0], completed, JSON.parse(completed[0].request_json));
      }
    });
    return result;
  }

  saveDeliveryTransform(id, { leaseToken, request, updatedAtMs = this.now() }) {
    nonEmptyString("id", id);
    nonEmptyString("leaseToken", leaseToken);
    finiteInteger("updatedAtMs", updatedAtMs);
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new TypeError("request must be an object");
    }
    if (nonEmptyString("request.idempotencyKey", request.idempotencyKey) !== id) {
      throw new TypeError("request.idempotencyKey must equal aggregate id");
    }
    const encoded = JSON.stringify(cloneJson(request));
    const updated = this.database.prepare(
      `UPDATE deliveries
       SET transform_request_json = ?, updated_at_ms = ?
       WHERE id = ? AND aggregate_id = ? AND status = 'sending' AND lease_token = ?
         AND transform_request_json IS NULL`,
    ).run(encoded, updatedAtMs, id, id, leaseToken);
    if (updated.changes === 1) return true;
    const existing = this.database.prepare(
      `SELECT transform_request_json FROM deliveries
       WHERE id = ? AND aggregate_id = ? AND status = 'sending' AND lease_token = ?`,
    ).get(id, id, leaseToken);
    return existing?.transform_request_json === encoded;
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
      const aggregateId = current.aggregate_id ?? current.id;
      const members = this.#aggregateMembers(aggregateId);
      const updated = this.database
        .prepare(
          `UPDATE deliveries
           SET status = ?, next_attempt_at_ms = ?, error_code = ?,
               lease_token = NULL, lease_until_ms = NULL, updated_at_ms = ?
           WHERE aggregate_id = ? AND status = 'sending' AND lease_token = ?`,
        )
        .run(status, nextAttemptAtMs, code, updatedAtMs, aggregateId, leaseToken);
      if (updated.changes === members.length) {
        const retried = this.#aggregateMembers(aggregateId);
        result = summarizeAggregate(retried[0], retried, JSON.parse(retried[0].request_json));
      }
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

  storageCapabilities() {
    return {
      contractVersion: GATEWAY_STORAGE_CONTRACT_VERSION,
      backend: "sqlite",
      durable: true,
      atomicFanout: true,
      aggregateLeases: true,
      transformLeaseCas: true,
    };
  }

  deliveryAccountStats() {
    return this.database.prepare(
      `SELECT destination_channel AS channel,
              destination_account_id AS accountId,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              MIN(CASE WHEN status = 'pending' THEN next_attempt_at_ms END) AS nextRetryAtMs
       FROM deliveries
       WHERE status IN ('pending', 'sending', 'failed')
       GROUP BY destination_channel, destination_account_id
       ORDER BY destination_channel, destination_account_id`,
    ).all().map((row) => ({
      channel: row.channel,
      accountId: row.accountId,
      pending: Number(row.pending),
      sending: Number(row.sending),
      failed: Number(row.failed),
      nextRetryAtMs: row.nextRetryAtMs === null ? null : Number(row.nextRetryAtMs),
    }));
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

  #aggregateMembers(aggregateId) {
    return this.database.prepare(
      `SELECT * FROM deliveries WHERE aggregate_id = ? ORDER BY aggregate_index, seq`,
    ).all(aggregateId);
  }

  #aggregateMembersForId(id, leaseToken) {
    const row = this.database.prepare(
      `SELECT * FROM deliveries WHERE id = ? AND status = 'sending' AND lease_token = ?`,
    ).get(id, leaseToken);
    return row ? this.#aggregateMembers(row.aggregate_id ?? row.id) : [];
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
