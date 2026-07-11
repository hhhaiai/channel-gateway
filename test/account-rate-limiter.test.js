import assert from "node:assert/strict";
import test from "node:test";

import { AccountRateLimiter } from "../src/account-rate-limiter.js";

const ACCOUNT_A = { channel: "telegram", accountId: "bot-a" };
const ACCOUNT_B = { channel: "slack", accountId: "default" };

test("spends a finite burst and refills lazily", () => {
  let now = 1_000;
  const limiter = new AccountRateLimiter({
    ratePerSecond: 1,
    burst: 2,
    now: () => now,
  });

  assert.equal(limiter.tryAcquire(ACCOUNT_A), true);
  assert.equal(limiter.tryAcquire(ACCOUNT_A), true);
  assert.equal(limiter.tryAcquire(ACCOUNT_A), false);
  assert.deepEqual(limiter.unavailableAccounts(), [ACCOUNT_A]);

  now += 500;
  assert.equal(limiter.tryAcquire(ACCOUNT_A), false);
  now += 500;
  assert.equal(limiter.tryAcquire(ACCOUNT_A), true);
});

test("applies unique account overrides without affecting defaults", () => {
  const limiter = new AccountRateLimiter({
    ratePerSecond: 1,
    burst: 1,
    overrides: [{
      ...ACCOUNT_A,
      ratePerSecond: 10,
      burst: 3,
    }],
    now: () => 1_000,
  });

  assert.equal(limiter.tryAcquire(ACCOUNT_A), true);
  assert.equal(limiter.tryAcquire(ACCOUNT_A), true);
  assert.equal(limiter.tryAcquire(ACCOUNT_A), true);
  assert.equal(limiter.tryAcquire(ACCOUNT_A), false);
  assert.equal(limiter.tryAcquire(ACCOUNT_B), true);
  assert.equal(limiter.tryAcquire(ACCOUNT_B), false);
});

test("blocks one account until the longest cooldown expires", () => {
  let now = 1_000;
  const limiter = new AccountRateLimiter({ now: () => now });
  limiter.block(ACCOUNT_A, 6_000);
  limiter.block(ACCOUNT_A, 5_000);

  assert.equal(limiter.tryAcquire(ACCOUNT_A), false);
  assert.equal(limiter.tryAcquire(ACCOUNT_B), true);
  assert.deepEqual(limiter.unavailableAccounts(), [ACCOUNT_A]);

  now = 6_000;
  assert.equal(limiter.tryAcquire(ACCOUNT_A), true);
});

test("does not mint tokens when the clock moves backwards", () => {
  let now = 10_000;
  const limiter = new AccountRateLimiter({
    ratePerSecond: 1,
    burst: 1,
    now: () => now,
  });
  assert.equal(limiter.tryAcquire(ACCOUNT_A), true);

  now = 5_000;
  assert.equal(limiter.tryAcquire(ACCOUNT_A), false);
  now = 11_000;
  assert.equal(limiter.tryAcquire(ACCOUNT_A), true);
});

test("returns sanitized account policy snapshots", () => {
  const limiter = new AccountRateLimiter({
    ratePerSecond: 2,
    burst: 4,
    now: () => 1_000,
  });
  limiter.tryAcquire(ACCOUNT_A);

  assert.deepEqual(limiter.snapshot(), [{
    ...ACCOUNT_A,
    tokens: 3,
    ratePerSecond: 2,
    burst: 4,
    blockedUntilMs: null,
    available: true,
  }]);
});

test("rejects invalid policies and duplicate account overrides", () => {
  for (const options of [
    { ratePerSecond: 0 },
    { ratePerSecond: 1001 },
    { burst: 0 },
    { burst: 10001 },
    { overrides: [{ ...ACCOUNT_A, ratePerSecond: 1, burst: 1 }, { ...ACCOUNT_A, ratePerSecond: 2, burst: 2 }] },
    {
      overrides: Array.from({ length: 10_001 }, (_, index) => ({
        channel: "test",
        accountId: `account-${index}`,
        ratePerSecond: 1,
        burst: 1,
      })),
    },
  ]) {
    assert.throws(() => new AccountRateLimiter(options));
  }
});
