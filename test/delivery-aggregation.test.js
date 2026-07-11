import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateDeliveryRequests,
  validateDeliveryAggregation,
} from "../src/delivery-aggregation.js";

test("validates bounded aggregation settings", () => {
  assert.deepEqual(validateDeliveryAggregation({
    enabled: true,
    windowMs: 1_000,
    maxItems: 20,
    maxBytes: 32_768,
  }), { enabled: true, windowMs: 1_000, maxItems: 20, maxBytes: 32_768 });
  assert.throws(() => validateDeliveryAggregation({ enabled: true, windowMs: 99 }), /windowMs/);
  assert.throws(() => validateDeliveryAggregation({ enabled: true, maxItems: 101 }), /maxItems/);
  assert.throws(() => validateDeliveryAggregation({ enabled: true, maxBytes: 263_000 }), /maxBytes/);
});

test("combines compatible text requests within item and UTF-8 byte bounds", () => {
  const requests = [
    { channel: "telegram", accountId: "bot-a", to: "chat", message: "第一条⁣cg1:dlv_a⁣", mediaUrls: [], idempotencyKey: "dlv_a" },
    { channel: "telegram", accountId: "bot-a", to: "chat", message: "second⁣cg1:dlv_b⁣", mediaUrls: [], idempotencyKey: "dlv_b" },
  ];
  const result = aggregateDeliveryRequests(requests, {
    aggregateId: "dlv_a",
    maxItems: 20,
    maxBytes: 1_024,
  });

  assert.equal(result.items, 2);
  assert.equal(result.request.idempotencyKey, "dlv_a");
  assert.match(result.request.message, /^第一条\nsecond/);
  assert.equal(result.request.message.match(/cg1:/gu).length, 1);
  assert.equal(result.bytes, Buffer.byteLength(result.request.message));
});

test("stops before an incompatible reply or byte overflow", () => {
  const base = { channel: "telegram", accountId: "bot-a", to: "chat", mediaUrls: [] };
  const result = aggregateDeliveryRequests([
    { ...base, message: "one", idempotencyKey: "a" },
    { ...base, message: "two", idempotencyKey: "b", replyToId: "parent" },
    { ...base, message: "x".repeat(2_000), idempotencyKey: "c" },
  ], { aggregateId: "a", maxItems: 10, maxBytes: 1_024 });

  assert.equal(result.items, 1);
  assert.equal(result.memberIds[0], "a");
});
