# Bounded Delivery Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace serial outbound delivery with a bounded JavaScript concurrency pool while preserving strict non-overlap for the same destination conversation.

**Architecture:** `DeliveryWorker` will run a fixed number of asynchronous lanes. Active destination keys are passed to `EventStore.claimNextDelivery()` as exclusions, so independent destinations run concurrently while the same `channel/account/conversation` remains serial. The pool size is a finite plugin setting with a conservative default; environment-derived defaults and web controls remain separate follow-up changes.

**Tech Stack:** Node.js 22 test runner, JavaScript promises, SQLite durable outbox, OpenClaw plugin config schema.

---

### Task 1: Lock destination-aware claim behavior

**Files:**
- Modify: `test/delivery-outbox.test.js`
- Modify: `src/event-store.js`

- [ ] **Step 1: Add a failing store regression test**

Add a test that enqueues two due deliveries for one destination and one delivery for another destination. Claim the first delivery, then call:

```js
store.claimNextDelivery({
  nowMs: 1_000,
  leaseMs: 10_000,
  leaseToken: "lease-independent",
  excludedDestinations: [{
    channel: first.destinationChannel,
    accountId: first.destinationAccountId,
    conversationId: first.destinationConversationId,
  }],
});
```

Assert that the second claim selects the independent destination rather than another delivery for the active destination.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/delivery-outbox.test.js
```

Expected: the new test fails because `claimNextDelivery()` ignores `excludedDestinations`.

- [ ] **Step 3: Implement validated destination exclusions**

Update `claimNextDelivery()` to accept:

```js
excludedDestinations = []
```

Validate that it is an array of at most 256 objects containing non-empty `channel`, `accountId`, and `conversationId`. Add parameterized SQL predicates of the form:

```sql
AND NOT (
  destination_channel = ?
  AND destination_account_id = ?
  AND destination_conversation_id = ?
)
```

Keep the existing due-time and insertion-order behavior unchanged.

- [ ] **Step 4: Run the store tests and verify GREEN**

Run:

```bash
node --test test/delivery-outbox.test.js
```

Expected: all delivery outbox tests pass.

### Task 2: Implement the bounded destination-aware pool

**Files:**
- Modify: `test/delivery-worker.test.js`
- Modify: `src/delivery-worker.js`

- [ ] **Step 1: Add failing concurrency tests**

Add tests proving:

1. With `maxConcurrency: 2`, two independent destinations enter `sender()` before either promise is released.
2. A third independent job starts only after one of the first two completes.
3. Two jobs for the same destination never overlap even when pool capacity is available.
4. Invalid concurrency values `0`, `257`, and non-integers are rejected.

The fake store must respect `excludedDestinations`, matching deliveries by:

```js
JSON.stringify([
  delivery.destinationChannel,
  delivery.destinationAccountId,
  delivery.destinationConversationId,
]);
```

- [ ] **Step 2: Run the worker tests and verify RED**

Run:

```bash
node --test test/delivery-worker.test.js
```

Expected: new tests fail because the worker is serial and does not accept `maxConcurrency`.

- [ ] **Step 3: Refactor one claimed delivery away from claim orchestration**

Split the current private operation into:

```js
#claimNext(excludedDestinations)
#runClaimed(delivery)
```

`#runClaimed()` preserves the existing complete/retry behavior and lease token handling.

- [ ] **Step 4: Add the bounded pool**

Add constructor option:

```js
maxConcurrency = 1
```

with a hard range of `1..256`. During one batch:

- Keep an `activeDestinations` map.
- Start at most `maxConcurrency` lane promises.
- Each lane claims while the shared claimed count is below `maxBatchSize`.
- Pass all active destination descriptors to the store exclusion option.
- Register a destination before awaiting `sender()`.
- Remove it in `finally` after complete or retry.
- Preserve `tick()` non-overlap and `stop()` drain behavior.

- [ ] **Step 5: Run the worker tests and verify GREEN**

Run:

```bash
node --test test/delivery-worker.test.js
```

Expected: independent destinations overlap only up to the configured bound; same-destination jobs remain serial; existing retry and polling tests pass.

### Task 3: Wire one finite plugin setting end-to-end

**Files:**
- Modify: `test/plugin-registration.test.js`
- Modify: `src/plugin.js`
- Modify: `src/bridge-runtime.js`
- Modify: `openclaw.plugin.json`

- [ ] **Step 1: Add a failing plugin configuration test**

Extend the registration test to assert that runtime options receive:

```js
deliveryMaxConcurrency: 4
```

by default and preserve an explicit plugin override.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/plugin-registration.test.js
```

Expected: the assertion fails because the setting does not exist.

- [ ] **Step 3: Wire the setting**

Add `deliveryMaxConcurrency: 4` to the plugin default. Accept it in `createBridgeRuntime()` and pass it to `DeliveryWorker` as `maxConcurrency`.

Add this bounded schema property:

```json
"deliveryMaxConcurrency": {
  "type": "integer",
  "minimum": 1,
  "maximum": 256,
  "default": 4
}
```

- [ ] **Step 4: Run focused integration tests**

Run:

```bash
node --test test/plugin-registration.test.js test/bridge-runtime.test.js
```

Expected: all focused tests pass.

### Task 4: Verify and commit only this scheduler block

**Files:**
- Verify all modified files above

- [ ] **Step 1: Run project gates**

Run:

```bash
npm run check
npm test
git diff --check
```

Expected: syntax/import check exits zero; all project tests pass; no whitespace errors.

- [ ] **Step 2: Review scope**

Run:

```bash
git diff --stat
git diff -- src/delivery-worker.js src/event-store.js src/plugin.js src/bridge-runtime.js openclaw.plugin.json test/delivery-worker.test.js test/delivery-outbox.test.js test/plugin-registration.test.js
```

Expected: no aggregation, AI, web-console, topology-schema, storage-migration, or notification changes are present.

- [ ] **Step 3: Commit with Lore trailers**

```text
Let independent destinations progress without sacrificing message order

The previous worker waited for every provider request before claiming the next
delivery. Use a finite pool across independent destinations while retaining one
active send per destination conversation.

Constraint: Same channel/account/conversation deliveries must not overlap
Constraint: Pool size must remain finite and validated
Rejected: Unbounded Promise.all fan-out | can exhaust resources and trigger provider limits
Rejected: Parallelize the same conversation | can reorder user-visible messages
Confidence: high
Scope-risk: moderate
Reversibility: clean
Directive: Add provider rate limits and environment-derived defaults in separate commits
Tested: Focused outbox/worker/plugin tests, npm run check, and full npm test
Not-tested: Real-provider throughput remains a later load-test task
```
