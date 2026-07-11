import assert from "node:assert/strict";
import test from "node:test";

import { DeliveryTransformBoundary } from "../src/delivery-transform-boundary.js";

const DELIVERY = {
  id: "dlv_leader",
  destinationChannel: "telegram",
  destinationAccountId: "bot-a",
  destinationConversationId: "chat-a",
  aggregateMemberIds: ["dlv_leader", "dlv_second"],
  request: {
    channel: "telegram",
    accountId: "bot-a",
    to: "chat-a",
    message: "one\ntwo⁣cg1:dlv_leader⁣",
    mediaUrls: [],
    idempotencyKey: "dlv_leader",
  },
};

test("replaces only visible aggregate text and preserves the transport envelope", async () => {
  const boundary = new DeliveryTransformBoundary({
    transformer: async (input) => {
      assert.equal(input.message, "one\ntwo");
      assert.equal(input.memberCount, 2);
      return { message: "重点：two" };
    },
  });

  const request = await boundary.transform(DELIVERY);
  assert.deepEqual({ ...request, message: undefined }, { ...DELIVERY.request, message: undefined });
  assert.equal(request.message, "重点：two⁣cg1:dlv_leader⁣");
  assert.deepEqual(boundary.snapshot(), { attempted: 1, transformed: 1, fallback: 0, timeouts: 0 });
});

test("falls back on rejection, timeout, and invalid output without exposing errors", async () => {
  const rejected = new DeliveryTransformBoundary({ transformer: async () => { throw new Error("secret"); } });
  assert.deepEqual(await rejected.transform(DELIVERY), DELIVERY.request);

  let fireTimeout;
  const timed = new DeliveryTransformBoundary({
    transformer: () => new Promise(() => {}),
    timeoutMs: 50,
    setTimer(callback) { fireTimeout = callback; return 1; },
    clearTimer() {},
  });
  const pending = timed.transform(DELIVERY);
  fireTimeout();
  assert.deepEqual(await pending, DELIVERY.request);
  assert.deepEqual(timed.snapshot(), { attempted: 1, transformed: 0, fallback: 1, timeouts: 1 });

  const invalid = new DeliveryTransformBoundary({ transformer: async () => ({ message: "" }) });
  assert.deepEqual(await invalid.transform(DELIVERY), DELIVERY.request);
  assert.equal(JSON.stringify(invalid.snapshot()).includes("secret"), false);
});

test("skips single deliveries and enforces bounded output", async () => {
  let calls = 0;
  const boundary = new DeliveryTransformBoundary({
    maxBytes: 1_024,
    transformer: async () => { calls += 1; return { message: "x".repeat(2_000) }; },
  });
  const single = { ...DELIVERY, aggregateMemberIds: [DELIVERY.id] };
  assert.deepEqual(await boundary.transform(single), DELIVERY.request);
  assert.equal(calls, 0);
  assert.deepEqual(await boundary.transform(DELIVERY), DELIVERY.request);
  assert.equal(calls, 1);
  assert.throws(() => new DeliveryTransformBoundary({ timeoutMs: 49, transformer() {} }), /timeoutMs/);
});
