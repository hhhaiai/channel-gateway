import assert from "node:assert/strict";
import test from "node:test";

import { DeliveryHealthProjection } from "../src/delivery-health-projection.js";

const ACCOUNT = { channel: "telegram", accountId: "bot-a" };

test("moves an account through degraded, unavailable, recovering, and healthy", () => {
  const projection = new DeliveryHealthProjection();

  projection.recordFailure(ACCOUNT, {
    code: "RATE_LIMITED",
    failedAtMs: 1_000,
    nextRetryAtMs: 2_000,
    terminal: false,
  });
  assert.equal(projection.snapshot().accounts[0].status, "degraded");

  projection.recordFailure(ACCOUNT, {
    code: "ACCOUNT_DISABLED",
    failedAtMs: 1_500,
    nextRetryAtMs: null,
    terminal: true,
  });
  assert.equal(projection.snapshot().accounts[0].status, "unavailable");

  projection.recordSuccess(ACCOUNT, 3_000);
  assert.equal(projection.snapshot().accounts[0].status, "recovering");
  projection.recordSuccess(ACCOUNT, 4_000);
  assert.equal(projection.snapshot().accounts[0].status, "healthy");
});

test("merges durable backlog and aggregates the worst channel status without secrets", () => {
  const projection = new DeliveryHealthProjection({
    deliveryStats: () => [
      { ...ACCOUNT, pending: 4, sending: 1, failed: 2, nextRetryAtMs: 5_000 },
      {
        channel: "telegram",
        accountId: "bot-b",
        pending: 1,
        sending: 0,
        failed: 0,
        nextRetryAtMs: 6_000,
      },
    ],
  });
  projection.recordFailure(ACCOUNT, {
    code: "PROVIDER_UNAVAILABLE",
    failedAtMs: 1_000,
    nextRetryAtMs: 5_000,
    terminal: true,
    providerMessage: "secret body",
  });

  const snapshot = projection.snapshot();
  assert.deepEqual(snapshot.channels, [{
    channel: "telegram",
    status: "unavailable",
    accounts: 2,
    pending: 5,
    sending: 1,
    failed: 2,
  }]);
  assert.deepEqual(snapshot.accounts[0], {
    ...ACCOUNT,
    status: "unavailable",
    errorCode: "PROVIDER_UNAVAILABLE",
    firstFailureAtMs: 1_000,
    lastFailureAtMs: 1_000,
    lastSuccessAtMs: null,
    nextRetryAtMs: 5_000,
    pending: 4,
    sending: 1,
    failed: 2,
  });
  assert.equal(JSON.stringify(snapshot).includes("secret body"), false);
});

test("keeps unavailable severity across later retryable failures", () => {
  const projection = new DeliveryHealthProjection();
  projection.recordFailure(ACCOUNT, {
    code: "ACCOUNT_DISABLED",
    failedAtMs: 1_000,
    nextRetryAtMs: null,
    terminal: true,
  });
  projection.recordFailure(ACCOUNT, {
    code: "TIMEOUT",
    failedAtMs: 2_000,
    nextRetryAtMs: 3_000,
    terminal: false,
  });

  const account = projection.snapshot().accounts[0];
  assert.equal(account.status, "unavailable");
  assert.equal(account.errorCode, "TIMEOUT");
  assert.equal(account.firstFailureAtMs, 1_000);
  assert.equal(account.lastFailureAtMs, 2_000);
});
