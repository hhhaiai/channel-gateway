import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/event-store.js";
import {
  GATEWAY_STORAGE_CONTRACT_VERSION,
  assertGatewayStorage,
} from "../src/storage-contract.js";

test("accepts the SQLite implementation and exposes versioned capabilities", () => {
  const store = new EventStore(":memory:");
  assert.equal(assertGatewayStorage(store, { deliveries: true, api: true }), store);
  assert.deepEqual(store.storageCapabilities(), {
    contractVersion: GATEWAY_STORAGE_CONTRACT_VERSION,
    backend: "sqlite",
    durable: true,
    atomicFanout: true,
    aggregateLeases: true,
    transformLeaseCas: true,
  });
  store.close();
});

test("reports every missing method for the requested capability groups", () => {
  assert.throws(
    () => assertGatewayStorage({}, { deliveries: true, api: true }),
    (error) => {
      assert.equal(error.code, "INVALID_STORAGE_ADAPTER");
      assert.match(error.message, /enqueue/);
      assert.match(error.message, /claimNextDelivery/);
      assert.match(error.message, /listPending/);
      return true;
    },
  );
});

test("does not require delivery worker methods for an event-only adapter", () => {
  const eventOnly = {
    enqueue() {}, findEcho() {}, findDeliveryByMarker() {}, resolveReplyTargets() {},
    pendingCount() {}, deliveryCounts() {}, deliveryAccountStats() {}, prune() {}, close() {},
  };
  assert.equal(assertGatewayStorage(eventOnly, { deliveries: false, api: false }), eventOnly);
});
