# Account Concurrency Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent one platform account from consuming the entire global delivery pool while preserving concurrency across independent accounts and conversations.

**Architecture:** Track active sends by `channel/accountId` inside `DeliveryWorker`. Accounts at their finite limit are passed to `EventStore.claimNextDelivery()` as exclusions. Destination exclusions remain responsible for same-conversation ordering. Destination predicates covered by an excluded account are omitted so SQLite parameter usage stays bounded.

**Tech Stack:** JavaScript bounded worker lanes, SQLite outbox claims, OpenClaw plugin schema, Node test runner.

---

### Task 1: Add account-aware outbox claims

- Write a failing `delivery-outbox` test with two due jobs for one account and one job for another account.
- Add validated `excludedAccounts` entries containing `channel` and `accountId`.
- Add SQL account exclusion predicates without changing due-time ordering or leases.
- Limit the exclusion list to 256 entries.
- Run `node --test test/delivery-outbox.test.js`.

### Task 2: Add the per-account pool bound

- Write failing worker tests proving one account does not exceed its limit while another account progresses.
- Add `maxConcurrencyPerAccount`, default `1`, hard range `1..64` at the worker boundary.
- Track active account counts and release them in `finally`.
- Exclude saturated accounts during claim.
- Omit destination exclusions already covered by a saturated account.
- Preserve global max concurrency, same-destination serialization, tick non-overlap, retry, and stop drain.
- Run `node --test test/delivery-worker.test.js`.

### Task 3: Wire one plugin setting

- Add `deliveryMaxConcurrencyPerAccount`, default `2`, schema range `1..64`.
- Pass it through plugin and bridge runtime.
- Add focused plugin/runtime tests.
- Keep resource auto-detection limited to the global pool in this block.

### Task 4: Document, verify, and commit

- Create `docs/账号级并发隔离实现.md`.
- Run `npm run check`, `npm test`, and `git diff --check`.
- Confirm no rate-per-second, 429 cooldown, health dashboard, aggregation, or AI changes are present.
- Commit only this block with Lore trailers.
