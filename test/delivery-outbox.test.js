import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EventStore } from "../src/event-store.js";
import { normalizeInboundEvent } from "../src/event-normalizer.js";
import { compileLinks, planFanout } from "../src/route-links.js";

const EVENT = {
  id: "evt_source",
  channel: "qqbot",
  accountId: "default",
  conversationId: "qq-group-1",
  messageId: "qq-message-1",
  sender: { id: "u1", name: "Alice", username: null },
  text: "hello",
  threadId: null,
  replyTo: null,
  media: [],
  isGroup: true,
  metadata: {},
  receivedAt: "2026-07-10T00:00:00.000Z",
};

const LINKS = compileLinks([
  {
    id: "ops-room",
    endpoints: [
      { id: "qq", channel: "qqbot", conversationId: "qq-group-1", to: "qq-group-1" },
      { id: "feishu", channel: "feishu", conversationId: "oc_chat", to: "oc_chat" },
      { id: "wa", channel: "whatsapp", conversationId: "120@g.us", to: "120@g.us" },
      { id: "tg", channel: "telegram", conversationId: "-1001", to: "-1001" },
    ],
  },
]);

function jobsFor(event = EVENT) {
  return planFanout({ event, links: LINKS });
}

test("commits an inbound event and fan-out jobs atomically, then records a receipt", () => {
  const store = new EventStore(":memory:", { now: () => 1_000 });
  const jobs = jobsFor();

  store.enqueue(EVENT, { deliveries: jobs });

  assert.deepEqual(store.deliveryCounts(), {
    pending: 3,
    sending: 0,
    sent: 0,
    failed: 0,
  });
  const claimed = store.claimNextDelivery({
    nowMs: 1_000,
    leaseMs: 30_000,
    leaseToken: "lease-1",
  });
  assert.equal(claimed.status, "sending");
  assert.equal("deliveryId" in claimed, false);
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.leaseToken, "lease-1");

  const completed = store.completeDelivery(claimed.id, {
    leaseToken: "lease-1",
    messageId: "feishu-message-1",
    completedAtMs: 1_001,
  });
  assert.equal(completed.status, "sent");
  assert.equal(completed.receiptMessageId, "feishu-message-1");
  assert.equal(
    store.findEcho({
      channel: claimed.destinationChannel,
      accountId: claimed.destinationAccountId,
      conversationId: claimed.destinationConversationId,
      messageId: "feishu-message-1",
    }).eventId,
    EVENT.id,
  );
  assert.equal(store.findDeliveryByMarker(claimed.id).deliveryId, claimed.id);
  store.close();
});

test("can complete a delivery when the provider returns no receipt id", () => {
  const store = new EventStore(":memory:", { now: () => 1_000 });
  store.enqueue(EVENT, { deliveries: [jobsFor()[0]] });
  const claimed = store.claimNextDelivery({
    nowMs: 1_000,
    leaseMs: 30_000,
    leaseToken: "lease-no-receipt",
  });

  const completed = store.completeDelivery(claimed.id, {
    leaseToken: "lease-no-receipt",
    messageId: null,
    completedAtMs: 1_001,
  });

  assert.equal(completed.status, "sent");
  assert.equal(completed.receiptMessageId, null);
  assert.equal(store.findDeliveryByMarker(claimed.id).eventId, EVENT.id);
  store.close();
});

test("does not duplicate delivery jobs when the same event is enriched", () => {
  const store = new EventStore(":memory:");
  const jobs = jobsFor();

  store.enqueue(EVENT, { deliveries: jobs.slice(0, 2) });
  store.enqueue(
    { ...EVENT, sender: { ...EVENT.sender, name: "Alice Enriched" } },
    { deliveries: jobs },
  );

  assert.equal(store.pendingCount(), 1);
  assert.equal(store.deliveryCounts().pending, 2);
  store.close();
});

test("leases prevent concurrent claims and recover only after expiry", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-leases-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "events.sqlite");
  const first = new EventStore(databasePath, { now: () => 1_000 });
  const second = new EventStore(databasePath, { now: () => 1_000 });
  first.enqueue(EVENT, { deliveries: [jobsFor()[0]] });

  const firstClaim = first.claimNextDelivery({
    nowMs: 1_000,
    leaseMs: 5_000,
    leaseToken: "lease-first",
  });
  assert.equal(
    second.claimNextDelivery({ nowMs: 5_999, leaseMs: 5_000, leaseToken: "too-early" }),
    undefined,
  );

  const recovered = second.claimNextDelivery({
    nowMs: 6_000,
    leaseMs: 5_000,
    leaseToken: "lease-recovered",
  });
  assert.equal(recovered.id, firstClaim.id);
  assert.equal(recovered.attempts, 2);
  assert.equal(
    first.completeDelivery(firstClaim.id, {
      leaseToken: "lease-first",
      messageId: "stale-result",
      completedAtMs: 6_001,
    }),
    undefined,
  );
  assert.equal(
    second.completeDelivery(recovered.id, {
      leaseToken: "lease-recovered",
      messageId: "current-result",
      completedAtMs: 6_002,
    }).receiptMessageId,
    "current-result",
  );
  first.close();
  second.close();
});

test("retries with compare-and-set leases and becomes terminal at max attempts", () => {
  const store = new EventStore(":memory:", { now: () => 1_000 });
  store.enqueue(EVENT, { deliveries: [jobsFor()[0]] });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const leaseToken = `lease-${attempt}`;
    const claimed = store.claimNextDelivery({
      nowMs: attempt * 1_000,
      leaseMs: 500,
      leaseToken,
    });
    assert.equal(claimed.attempts, attempt);
    const retried = store.retryDelivery(claimed.id, {
      leaseToken,
      code: "PROVIDER_UNAVAILABLE",
      nextAttemptAtMs: (attempt + 1) * 1_000,
      maxAttempts: 3,
      updatedAtMs: attempt * 1_000 + 1,
    });
    assert.equal(retried.status, attempt === 3 ? "failed" : "pending");
  }

  assert.deepEqual(store.deliveryCounts(), {
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 1,
  });
  store.close();
});

test("claims due jobs by due time and then insertion sequence", () => {
  const store = new EventStore(":memory:");
  const [base] = jobsFor();
  const deliveries = [
    {
      ...structuredClone(base),
      id: "dlv_first",
      marker: "dlv_first",
      destinationEndpointId: "first",
      nextAttemptAtMs: 2_000,
      request: { ...structuredClone(base.request), idempotencyKey: "dlv_first" },
    },
    {
      ...structuredClone(base),
      id: "dlv_second",
      marker: "dlv_second",
      destinationEndpointId: "second",
      nextAttemptAtMs: 1_000,
      request: { ...structuredClone(base.request), idempotencyKey: "dlv_second" },
    },
    {
      ...structuredClone(base),
      id: "dlv_third",
      marker: "dlv_third",
      destinationEndpointId: "third",
      nextAttemptAtMs: 1_000,
      request: { ...structuredClone(base.request), idempotencyKey: "dlv_third" },
    },
  ];
  store.enqueue(EVENT, { deliveries });

  assert.equal(
    store.claimNextDelivery({ nowMs: 1_000, leaseMs: 10_000, leaseToken: "l1" }).id,
    "dlv_second",
  );
  assert.equal(
    store.claimNextDelivery({ nowMs: 1_000, leaseMs: 10_000, leaseToken: "l2" }).id,
    "dlv_third",
  );
  assert.equal(
    store.claimNextDelivery({ nowMs: 1_999, leaseMs: 100, leaseToken: "l3" }),
    undefined,
  );
  assert.equal(
    store.claimNextDelivery({ nowMs: 2_000, leaseMs: 100, leaseToken: "l4" }).id,
    "dlv_first",
  );
  store.close();
});

test("can skip an active destination while claiming independent work", () => {
  const store = new EventStore(":memory:", { now: () => 1_000 });
  const [base] = jobsFor();
  const makeDelivery = ({ id, endpointId, conversationId }) => ({
    ...structuredClone(base),
    id,
    destinationEndpointId: endpointId,
    destinationConversationId: conversationId,
    request: {
      ...structuredClone(base.request),
      to: conversationId,
      idempotencyKey: id,
    },
  });
  store.enqueue(EVENT, {
    deliveries: [
      makeDelivery({ id: "dlv_active_1", endpointId: "active-1", conversationId: "shared" }),
      makeDelivery({ id: "dlv_active_2", endpointId: "active-2", conversationId: "shared" }),
      makeDelivery({ id: "dlv_independent", endpointId: "independent", conversationId: "other" }),
    ],
  });

  const active = store.claimNextDelivery({
    nowMs: 1_000,
    leaseMs: 10_000,
    leaseToken: "lease-active",
  });
  const independent = store.claimNextDelivery({
    nowMs: 1_000,
    leaseMs: 10_000,
    leaseToken: "lease-independent",
    excludedDestinations: [{
      channel: active.destinationChannel,
      accountId: active.destinationAccountId,
      conversationId: active.destinationConversationId,
    }],
  });

  assert.equal(active.id, "dlv_active_1");
  assert.equal(independent.id, "dlv_independent");
  store.close();
});

test("can skip a saturated account while claiming another account", () => {
  const store = new EventStore(":memory:", { now: () => 1_000 });
  const [base] = jobsFor();
  const makeDelivery = ({ id, accountId, conversationId }) => ({
    ...structuredClone(base),
    id,
    destinationEndpointId: id,
    destinationAccountId: accountId,
    destinationConversationId: conversationId,
    request: {
      ...structuredClone(base.request),
      accountId,
      to: conversationId,
      idempotencyKey: id,
    },
  });
  store.enqueue(EVENT, {
    deliveries: [
      makeDelivery({ id: "dlv_account_a1", accountId: "account-a", conversationId: "a1" }),
      makeDelivery({ id: "dlv_account_a2", accountId: "account-a", conversationId: "a2" }),
      makeDelivery({ id: "dlv_account_b", accountId: "account-b", conversationId: "b" }),
    ],
  });

  const active = store.claimNextDelivery({
    nowMs: 1_000,
    leaseMs: 10_000,
    leaseToken: "lease-account-a",
  });
  const independent = store.claimNextDelivery({
    nowMs: 1_000,
    leaseMs: 10_000,
    leaseToken: "lease-account-b",
    excludedAccounts: [
      ...Array.from({ length: 256 }, (_, index) => ({
        channel: "unused",
        accountId: `unused-${index}`,
      })),
      {
        channel: active.destinationChannel,
        accountId: active.destinationAccountId,
      },
    ],
  });

  assert.equal(active.id, "dlv_account_a1");
  assert.equal(independent.id, "dlv_account_b");
  store.close();
});

test("resolves reply ids for every linked endpoint from source and sent receipts", () => {
  const store = new EventStore(":memory:", { now: () => 1_000 });
  store.enqueue(EVENT, { deliveries: jobsFor() });

  const receipts = new Map([
    ["feishu", "feishu-message"],
    ["wa", "wa-message"],
    ["tg", "tg-message"],
  ]);
  for (const [endpointId, messageId] of receipts) {
    let claimed;
    do {
      claimed = store.claimNextDelivery({
        nowMs: 1_000,
        leaseMs: 1_000,
        leaseToken: `lease-${endpointId}`,
      });
    } while (claimed.destinationEndpointId !== endpointId);
    store.completeDelivery(claimed.id, {
      leaseToken: `lease-${endpointId}`,
      messageId,
      completedAtMs: 1_001,
    });
  }

  const targets = store.resolveReplyTargets({
    channel: "feishu",
    accountId: "default",
    conversationId: "oc_chat",
    replyTo: { id: "feishu-message" },
  });
  assert.deepEqual(
    Object.fromEntries(targets),
    {
      qq: "qq-message-1",
      feishu: "feishu-message",
      wa: "wa-message",
      tg: "tg-message",
    },
  );
  store.close();
});

test("rolls back the event when one delivery row is invalid", () => {
  const store = new EventStore(":memory:");
  const invalid = { ...structuredClone(jobsFor()[0]), destinationChannel: "" };

  assert.throws(
    () => store.enqueue(EVENT, { deliveries: [invalid] }),
    /destinationChannel/,
  );
  assert.equal(store.pendingCount(), 0);
  assert.deepEqual(store.deliveryCounts(), {
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 0,
  });
  store.close();
});

test("ACK pruning cannot delete an event that still owns delivery or receipt state", () => {
  let now = 10_000;
  const store = new EventStore(":memory:", { now: () => now });
  store.enqueue(EVENT, { deliveries: [jobsFor()[0]] });
  store.ack(EVENT.id);
  now += 10_000;

  assert.deepEqual(store.prune({ ackTtlMs: 1, failedTtlMs: 1 }), {
    acked: 0,
    failed: 0,
  });
  assert.equal(store.ack(EVENT.id).status, "acked");
  assert.equal(store.deliveryCounts().pending, 1);
  store.close();
});

test("prunes expired terminal delivery relations before their ACK tombstone", () => {
  let now = 10_000;
  const store = new EventStore(":memory:", { now: () => now });
  store.enqueue(EVENT, { deliveries: [jobsFor()[0]] });
  const claimed = store.claimNextDelivery({
    nowMs: now,
    leaseMs: 1_000,
    leaseToken: "retention-lease",
  });
  store.completeDelivery(claimed.id, {
    leaseToken: "retention-lease",
    messageId: "provider-retained",
    completedAtMs: now,
  });
  store.ack(EVENT.id, { ackedAtMs: now });
  now += 1_000;

  assert.deepEqual(store.prune({ ackTtlMs: 1_000, failedTtlMs: 2_000 }), {
    acked: 1,
    failed: 0,
  });
  assert.equal(store.findDeliveryByMarker(claimed.id), undefined);
  assert.deepEqual(store.deliveryCounts(), {
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 0,
  });
  store.close();
});

test("prunes expired terminal delivery relations before their failed tombstone", () => {
  let now = 10_000;
  const store = new EventStore(":memory:", { now: () => now });
  store.enqueue(EVENT, { deliveries: [jobsFor()[0]] });
  const claimed = store.claimNextDelivery({
    nowMs: now,
    leaseMs: 1_000,
    leaseToken: "failed-retention-lease",
  });
  store.retryDelivery(claimed.id, {
    leaseToken: "failed-retention-lease",
    code: "DELIVERY_FAILED",
    nextAttemptAtMs: now,
    maxAttempts: 1,
  });
  store.fail(EVENT.id, { code: "EVENT_FAILED", failedAtMs: now });
  now += 2_000;

  assert.deepEqual(store.prune({ ackTtlMs: 1_000, failedTtlMs: 2_000 }), {
    acked: 0,
    failed: 1,
  });
  assert.equal(store.findDeliveryByMarker(claimed.id), undefined);
  assert.deepEqual(store.deliveryCounts(), {
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 0,
  });
  store.close();
});

test("receipt lookup stays scoped to channel, account, and conversation", () => {
  const store = new EventStore(":memory:", { now: () => 1_000 });
  const makeDelivery = (event, conversationId, endpointId) => ({
    ...structuredClone(jobsFor()[0]),
    id: `dlv_${endpointId}`,
    marker: `dlv_${endpointId}`,
    eventId: event.id,
    destinationEndpointId: endpointId,
    destinationChannel: "telegram",
    destinationConversationId: conversationId,
    request: {
      ...structuredClone(jobsFor()[0].request),
      idempotencyKey: `dlv_${endpointId}`,
    },
  });
  const firstEvent = { ...structuredClone(EVENT), id: "evt_receipt_a" };
  const secondEvent = { ...structuredClone(EVENT), id: "evt_receipt_b" };
  store.enqueue(firstEvent, {
    deliveries: [makeDelivery(firstEvent, "chat-a", "chat-a")],
  });
  store.enqueue(secondEvent, {
    deliveries: [makeDelivery(secondEvent, "chat-b", "chat-b")],
  });

  for (const [leaseToken, messageId] of [["lease-a", "42"], ["lease-b", "42"]]) {
    const claimed = store.claimNextDelivery({ nowMs: 1_000, leaseMs: 1_000, leaseToken });
    store.completeDelivery(claimed.id, { leaseToken, messageId, completedAtMs: 1_001 });
  }

  assert.equal(
    store.findEcho({
      channel: "telegram",
      accountId: "default",
      conversationId: "chat-a",
      messageId: "42",
    }).eventId,
    firstEvent.id,
  );
  assert.equal(
    store.findEcho({
      channel: "telegram",
      accountId: "default",
      conversationId: "chat-b",
      messageId: "42",
    }).eventId,
    secondEvent.id,
  );
  store.close();
});

test("same provider message id in two conversations creates separate events and jobs", () => {
  const store = new EventStore(":memory:");
  const links = compileLinks([
    {
      id: "scoped-message-ids",
      endpoints: [
        { id: "chat-a", channel: "telegram", conversationId: "chat-a", to: "chat-a" },
        { id: "chat-b", channel: "telegram", conversationId: "chat-b", to: "chat-b" },
        { id: "feishu", channel: "feishu", conversationId: "oc_chat", to: "oc_chat" },
      ],
    },
  ]);
  const makeEvent = (conversationId) =>
    normalizeInboundEvent({
      event: { content: "same", timestamp: 1_000, messageId: "42", senderId: "user" },
      context: { channelId: "telegram", accountId: "default", conversationId },
    });
  const first = makeEvent("chat-a");
  const second = makeEvent("chat-b");

  store.enqueue(first, { deliveries: planFanout({ event: first, links }) });
  store.enqueue(second, { deliveries: planFanout({ event: second, links }) });

  assert.notEqual(first.id, second.id);
  assert.equal(store.pendingCount(), 2);
  assert.equal(store.deliveryCounts().pending, 4);
  store.close();
});
