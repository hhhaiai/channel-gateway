# Account Rate Limiter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound each `channel/accountId` by a configurable token bucket and honor account-wide `Retry-After` cooldown without blocking unrelated accounts.

**Architecture:** A pure in-memory `AccountRateLimiter` owns policy validation, lazy token refill, account overrides, and cooldown state. `DeliveryWorker` excludes unavailable known accounts before claiming, consumes a token immediately after claim, and blocks the account only for controlled rate-limit errors. SQLite remains the durable job source; polling naturally wakes accounts after refill or cooldown.

**Tech Stack:** JavaScript monotonic-style millisecond arithmetic, SQLite outbox exclusions, OpenClaw plugin schema, Node test runner.

---

### Task 1: Build and test the pure token bucket

- Create `src/account-rate-limiter.js` and `test/account-rate-limiter.test.js` with RED/GREEN coverage.
- Default policy: `ratePerSecond: 5`, `burst: 10`.
- Bounds: rate `0.01..1000`, burst `1..10000`.
- Account key: `channel/accountId`.
- Support unique per-account overrides.
- Start each account with a full burst.
- Refill lazily from elapsed milliseconds; clock rollback adds no tokens.
- Expose `tryAcquire()`, `unavailableAccounts()`, `block()`, and `snapshot()`.
- Cooldown may only move forward, never shorten an existing block.

### Task 2: Integrate the worker without claiming blocked work

- Extend queue-store test fixtures to respect limiter exclusions.
- Add RED tests proving burst exhaustion pauses one account while another progresses.
- Add RED tests proving a controlled rate-limit error blocks later jobs until `Retry-After` expires.
- Pass limiter-unavailable accounts to `claimNextDelivery()` together with concurrency-saturated accounts.
- Consume one token after claim and before provider send.
- Block only codes `RATE_LIMITED`, `TOO_MANY_REQUESTS`, or codes containing `RATE_LIMIT` when a positive retry delay exists.
- Keep the current delivery retry schedule unchanged.

### Task 3: Wire bounded policies

- Add defaults `deliveryRatePerSecondPerAccount: 5` and `deliveryRateBurstPerAccount: 10`.
- Add `deliveryAccountRateLimits[]` overrides with channel, accountId, ratePerSecond, and burst.
- Build the limiter in `createBridgeRuntime()` and expose it through `runtime.worker.rateLimiter` for later health/dashboard use.
- Add schema and focused plugin/runtime tests.

### Task 4: Document, verify, and commit

- Create `docs/账号速率限制与Cooldown实现.md`.
- Run `npm run check`, `npm test`, and `git diff --check`.
- Confirm health dashboard, notification integration, aggregation, and AI remain out of scope.
- Commit only this rate-limiter block.
