import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EventStore } from "../src/event-store.js";

const EVENT = {
  id: "evt_1",
  channel: "telegram",
  accountId: "default",
  conversationId: "chat",
  messageId: "1",
  sender: { id: "u", name: null, username: null },
  text: "hello",
  threadId: null,
  replyTo: null,
  media: [],
  isGroup: false,
  metadata: {},
  receivedAt: "2026-07-10T00:00:00.000Z",
};

test("enqueues and lists one pending canonical event without mutating input", () => {
  const store = new EventStore(":memory:");
  const input = structuredClone(EVENT);
  const snapshot = structuredClone(input);

  const result = store.enqueue(input);

  assert.equal(result.status, "pending");
  assert.deepEqual(result.event, EVENT);
  assert.deepEqual(store.listPending(), {
    items: [EVENT],
    nextAfter: EVENT.id,
  });
  assert.deepEqual(input, snapshot);
  store.close();
});

test("deduplicates and enriches an event without erasing non-empty fields", () => {
  const store = new EventStore(":memory:");
  const original = structuredClone(EVENT);
  const enrichment = {
    ...structuredClone(EVENT),
    sender: { id: "different-user", name: "Alice", username: "" },
    text: "   ",
    media: [{ path: null, url: "https://cdn.example/image.png", mimeType: "image/png" }],
    metadata: { guildId: "guild-1" },
  };
  const originalSnapshot = structuredClone(original);
  const enrichmentSnapshot = structuredClone(enrichment);

  store.enqueue(original);
  const result = store.enqueue(enrichment);

  assert.equal(result.status, "pending");
  assert.deepEqual(result.event, {
    ...EVENT,
    sender: { id: "u", name: "Alice", username: null },
    media: [
      {
        path: null,
        url: "https://cdn.example/image.png",
        mimeType: "image/png",
      },
    ],
    metadata: { guildId: "guild-1" },
  });
  assert.deepEqual(store.listPending().items, [result.event]);
  assert.deepEqual(original, originalSnapshot);
  assert.deepEqual(enrichment, enrichmentSnapshot);
  store.close();
});

test("persists one pending event across reopen and ACKs idempotently", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "events.sqlite");

  const first = new EventStore(databasePath);
  first.enqueue(EVENT);
  first.enqueue({
    ...EVENT,
    sender: { ...EVENT.sender, name: "Alice" },
  });
  assert.equal(first.pendingCount(), 1);
  first.close();

  const second = new EventStore(databasePath);
  assert.equal(second.listPending().items[0].sender.name, "Alice");
  assert.equal(second.ack(EVENT.id, { ackedAtMs: 1_000 }).status, "acked");
  assert.equal(second.ack(EVENT.id, { ackedAtMs: 2_000 }).ackedAtMs, 1_000);
  assert.equal(second.pendingCount(), 0);
  assert.deepEqual(second.listPending(), { items: [], nextAfter: null });
  second.close();
});

test("uses stable sequence cursors and rejects an unknown cursor without changing rows", () => {
  const store = new EventStore(":memory:");
  const events = ["evt_1", "evt_2", "evt_3"].map((id, index) => ({
    ...structuredClone(EVENT),
    id,
    messageId: String(index + 1),
  }));
  events.forEach((event) => store.enqueue(event));

  assert.deepEqual(store.listPending({ limit: 2 }), {
    items: events.slice(0, 2),
    nextAfter: "evt_2",
  });
  assert.deepEqual(store.listPending({ after: "evt_1", limit: 2 }), {
    items: events.slice(1),
    nextAfter: "evt_3",
  });
  assert.throws(
    () => store.listPending({ after: "evt_missing", limit: 100 }),
    (error) => error?.code === "UNKNOWN_CURSOR" && /unknown cursor/.test(error.message),
  );
  assert.deepEqual(store.listPending({ limit: 10 }).items, events);
  store.close();
});

test("validates pending page limits", () => {
  const store = new EventStore(":memory:");

  for (const limit of [0, -1, 1.5, 501, "1"]) {
    assert.throws(
      () => store.listPending({ limit }),
      /limit must be an integer between 1 and 500/,
    );
  }
  assert.deepEqual(store.listPending({ limit: 1 }), { items: [], nextAfter: null });
  assert.deepEqual(store.listPending({ limit: 500 }), { items: [], nextAfter: null });
  store.close();
});

test("returns undefined when ACKing or failing an unknown event", () => {
  const store = new EventStore(":memory:");

  assert.equal(store.ack("evt_missing"), undefined);
  assert.equal(store.fail("evt_missing", { code: "DROPPED" }), undefined);
  assert.equal(store.pendingCount(), 0);
  store.close();
});

test("emits a pending event only after its transaction is visible to another connection", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-notify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "events.sqlite");
  const writer = new EventStore(databasePath);
  const observer = new EventStore(databasePath);
  const notifications = [];

  writer.on("pending", (event) => {
    notifications.push(structuredClone(event));
    assert.equal(observer.pendingCount(), 1);
  });

  writer.enqueue(EVENT);
  writer.enqueue({ ...EVENT, sender: { ...EVENT.sender, name: "Alice" } });

  assert.deepEqual(notifications, [EVENT]);
  writer.close();
  observer.close();
});

test("isolates pending listener failures after commit", () => {
  const store = new EventStore(":memory:");
  const received = [];
  store.on("pending", () => {
    throw new Error("consumer failed");
  });
  store.on("pending", (event) => received.push(event.id));

  const result = store.enqueue(EVENT);

  assert.equal(result.status, "pending");
  assert.equal(store.pendingCount(), 1);
  assert.deepEqual(received, [EVENT.id]);
  store.close();
});

test("keeps the first terminal state across ACK and failure retries", () => {
  const store = new EventStore(":memory:");
  const acked = { ...structuredClone(EVENT), id: "evt_acked_first" };
  const failed = { ...structuredClone(EVENT), id: "evt_failed_first" };
  store.enqueue(acked);
  store.enqueue(failed);

  store.ack(acked.id, { ackedAtMs: 1_000 });
  const ackedAfterFailure = store.fail(acked.id, {
    code: "LATE_FAILURE",
    failedAtMs: 2_000,
  });
  assert.equal(ackedAfterFailure.status, "acked");
  assert.equal(ackedAfterFailure.ackedAtMs, 1_000);
  assert.equal(ackedAfterFailure.failedAtMs, null);
  assert.equal(ackedAfterFailure.failureCode, null);

  store.fail(failed.id, { code: "INVALID_EVENT", failedAtMs: 3_000 });
  const failedAfterAck = store.ack(failed.id, { ackedAtMs: 4_000 });
  assert.equal(failedAfterAck.status, "failed");
  assert.equal(failedAfterAck.failedAtMs, 3_000);
  assert.equal(failedAfterAck.failureCode, "INVALID_EVENT");
  assert.equal(failedAfterAck.ackedAtMs, null);
  store.close();
});

test("prunes only expired terminal tombstones", () => {
  let now = 10_000;
  const store = new EventStore(":memory:", { now: () => now });
  const acked = { ...structuredClone(EVENT), id: "evt_acked", messageId: "acked" };
  const failed = { ...structuredClone(EVENT), id: "evt_failed", messageId: "failed" };
  const pending = { ...structuredClone(EVENT), id: "evt_pending", messageId: "pending" };

  store.enqueue(acked);
  store.enqueue(failed);
  store.enqueue(pending);
  store.ack(acked.id);
  store.fail(failed.id, { code: "INVALID_EVENT" });

  now += 999;
  assert.deepEqual(store.prune({ ackTtlMs: 1_000, failedTtlMs: 2_000 }), {
    acked: 0,
    failed: 0,
  });
  now += 1;
  assert.deepEqual(store.prune({ ackTtlMs: 1_000, failedTtlMs: 2_000 }), {
    acked: 1,
    failed: 0,
  });
  assert.equal(store.ack(acked.id), undefined);
  assert.equal(store.pendingCount(), 1);

  now += 1_000;
  assert.deepEqual(store.prune({ ackTtlMs: 1_000, failedTtlMs: 2_000 }), {
    acked: 0,
    failed: 1,
  });
  assert.equal(store.fail(failed.id, { code: "INVALID_EVENT" }), undefined);
  assert.deepEqual(store.listPending().items, [pending]);
  store.close();
});
