# Channel Gateway Standalone Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Node.js service that runs the pinned OpenClaw Gateway as its channel kernel and exposes durable inbound events plus channel/message control through REST and SSE without requiring an LLM provider.

**Architecture:** The repository is both an OpenClaw plugin and a launcher. The plugin intercepts `message_received` and `before_dispatch`, normalizes and persists inbound events in SQLite, atomically creates delivery-outbox jobs for configured cross-channel links, serves authenticated REST/SSE routes, and forwards outbound/control calls through `openclaw/plugin-sdk/gateway-method-runtime`; a small worker sends queued fan-out jobs back through the authenticated loopback REST route so hook code never depends on privileged internal runtime APIs. The launcher creates isolated runtime paths, discovers exact-version channel packages, generates first-run config, and supervises the pinned Gateway child process. A version-checked postinstall patch enriches OpenClaw `before_dispatch` with canonical message fields while retaining the unpatched `message_received` correlation fallback.

**Tech Stack:** Node.js 22.20+ ESM, built-in `node:test`, built-in `node:sqlite`, built-in HTTP/SSE primitives, `openclaw@2026.6.11`, optional exact-version official channel packages, Docker Compose.

---

## File map

- `package.json` — executable/package/plugin metadata, exact OpenClaw dependencies, scripts, Node engine.
- `openclaw.plugin.json` — plugin activation, authenticated Gateway method dispatch contract, strict plugin config schema.
- `index.js` — default OpenClaw plugin entry.
- `bin/channel-gateway.js` — standalone launcher CLI.
- `src/constants.js` — version, package profile, API, and default limit constants.
- `src/event-normalizer.js` — canonical inbound DTO, deterministic identity, non-empty merge rules.
- `src/correlation-buffer.js` — bounded TTL correlation between fire-and-forget rich hook and awaited interception hook.
- `src/event-store.js` — SQLite schema, idempotent upsert, pending replay, ACK tombstones, pruning, notifications.
- `src/route-links.js` — validated bidirectional endpoint links, fan-out plans, hidden markers, reply mapping inputs.
- `src/delivery-worker.js` — durable outbox claim/retry/send lifecycle.
- `src/self-api-sender.js` — token-safe loopback call to the same authenticated `/api/v1/messages` route.
- `src/health-state.js` — Bridge readiness/degraded state without message-body logging.
- `src/sse-hub.js` — pending replay, live fan-out, heartbeat, bounded slow-client queue.
- `src/gateway-rpc.js` — exact REST DTO validation and Gateway RPC mapping.
- `src/http-utils.js` — bounded JSON reader and JSON/error response helpers.
- `src/api-handler.js` — `/api/v1` method/path router.
- `src/bridge-runtime.js` — hooks, store, HTTP/SSE, cleanup ownership.
- `src/plugin.js` — testable plugin definition factory and production SDK wiring.
- `src/launcher/paths.js` — deterministic config/state/credentials/workspace paths.
- `src/launcher/token.js` — environment/file/generated token precedence and secure persistence.
- `src/launcher/channel-packages.js` — exact-version installed package discovery.
- `src/launcher/config.js` — first-run OpenClaw JSON config generation without later clobbering operator edits.
- `src/launcher/process.js` — pinned OpenClaw executable resolution and signal supervision.
- `src/launcher/run.js` — launcher orchestration and startup preflight.
- `src/host-patch.js` — deterministic transform and verification for the pinned published OpenClaw runtime.
- `scripts/patch-openclaw-dist.mjs` — postinstall patch command.
- `scripts/check.mjs` — dependency-free syntax/static import check.
- `scripts/license-report.mjs` — selected dependency license inventory and release blockers.
- `patches/openclaw-v2026.6.11-rich-before-dispatch.patch` — equivalent source-level patch for audit/upstream comparison.
- `test/*.test.js` — unit/integration tests.
- `test/smoke/standalone-smoke.test.js` — real pinned Gateway process smoke and restart recovery.
- `Dockerfile`, `docker-compose.yml`, `.dockerignore` — base/common channel profiles and persistent service deployment.
- `licenses/openclaw/*` — required upstream license and notices.
- `README.md` — configuration, channel onboarding, REST/SSE examples, operational and license boundaries.

## Simplification constraints

- Keep one SQLite owner for events, delivery jobs, and receipt relations; do not introduce a queue
  broker or second database.
- Keep one generic link planner; adding QQ, Feishu, WhatsApp, Telegram, or another Channel is config,
  never a new router branch.
- Keep one sequential delivery worker and the existing authenticated message API; do not create a
  second outbound adapter layer.
- Do not add an HTTP framework, ORM, workflow DSL, template engine, or dependency-injection
  container.
- Prefer small pure functions and delete duplicate parsing/validation before adding abstractions.

### Task 1: Bootstrap the executable plugin and canonical inbound model

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `openclaw.plugin.json`
- Create: `index.js`
- Create: `src/constants.js`
- Create: `src/event-normalizer.js`
- Create: `src/correlation-buffer.js`
- Create: `scripts/check.mjs`
- Create: `test/event-normalizer.test.js`
- Create: `test/correlation-buffer.test.js`

- [ ] **Step 1: Create package and plugin metadata needed to run tests**

`package.json` must pin the host and optional official channels exactly and expose no framework dependency:

```json
{
  "name": "channel-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.19.0" },
  "bin": { "channel-gateway": "./bin/channel-gateway.js" },
  "scripts": {
    "start": "node ./bin/channel-gateway.js",
    "test": "node --test --test-concurrency=1",
    "check": "node ./scripts/check.mjs"
  },
  "dependencies": { "openclaw": "2026.6.11" },
  "optionalDependencies": {
    "@openclaw/discord": "2026.6.11",
    "@openclaw/feishu": "2026.6.11",
    "@openclaw/slack": "2026.6.11",
    "@openclaw/whatsapp": "2026.6.11"
  },
  "openclaw": { "extensions": ["./index.js"] }
}
```

`openclaw.plugin.json` must contain `id: "channel-gateway"`, `activation.onStartup: true`, `enabledByDefault: false`, the authenticated dispatch contract, and a strict schema for `databasePath`, `ackTtlMs`, `failedTtlMs`, `correlationTtlMs`, `maxCorrelationEntries`, `bodyLimitBytes`, `sseHeartbeatMs`, and `sseMaxQueue`.

Run: `npm install --omit=optional`
Expected: exit 0, exact `openclaw@2026.6.11` in `npm ls openclaw --depth=0`, and a generated `package-lock.json`.

- [ ] **Step 2: Write failing normalization tests**

Create tests that assert canonical fields, deterministic identity, timestamp normalization, media alignment, and non-empty merge:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mergeNonEmpty, normalizeInboundEvent } from "../src/event-normalizer.js";

test("normalizes a rich inbound hook into the public DTO", () => {
  const result = normalizeInboundEvent({
    event: {
      content: "hello",
      timestamp: 1_752_134_400,
      messageId: "42",
      senderId: "10001",
      senderName: "Alice",
      senderUsername: "alice",
      threadId: "7",
      mediaPaths: ["/state/a.jpg"],
      mediaTypes: ["image/jpeg"],
      metadata: { platformOnly: "kept" }
    },
    context: { channelId: "telegram", accountId: "default", conversationId: "-100123" }
  });
  assert.equal(result.id.startsWith("evt_"), true);
  assert.equal(result.channel, "telegram");
  assert.equal(result.messageId, "42");
  assert.deepEqual(result.sender, { id: "10001", name: "Alice", username: "alice" });
  assert.deepEqual(result.media, [{ path: "/state/a.jpg", url: null, mimeType: "image/jpeg" }]);
  assert.equal(result.receivedAt, "2025-07-10T13:20:00.000Z");
  assert.equal(result.metadata.platformOnly, "kept");
});

test("uses the same id for the same platform message", () => {
  const input = {
    event: { content: "hello", timestamp: 1_752_134_400_000, messageId: "42" },
    context: { channelId: "telegram", accountId: "default", conversationId: "chat" }
  };
  assert.equal(normalizeInboundEvent(input).id, normalizeInboundEvent(input).id);
});

test("mergeNonEmpty fills richer values without erasing existing values", () => {
  assert.deepEqual(
    mergeNonEmpty({ sender: { id: "1", name: "Alice" }, text: "hello" }, { sender: { id: "", username: "alice" }, text: "" }),
    { sender: { id: "1", name: "Alice", username: "alice" }, text: "hello" }
  );
});
```

Run: `node --test test/event-normalizer.test.js`
Expected: FAIL because `src/event-normalizer.js` does not exist.

- [ ] **Step 3: Implement the canonical event functions**

Implement these stable exports and keep provider-specific fields under `metadata`:

```js
import { createHash } from "node:crypto";

const clean = (value) => typeof value === "string" ? value.trim() : value == null ? "" : String(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const normalizeTimestamp = (value) => {
  if (value == null || value === "") return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
const normalizeReply = (event) => {
  const id = clean(event.replyToId ?? event.replyToIdFull);
  if (!id && !event.replyToBody && !event.replyToSender) return null;
  return { id: id || null, text: clean(event.replyToBody) || null, sender: clean(event.replyToSender) || null };
};
const normalizeMedia = (event) => {
  const metadata = isPlainObject(event.metadata) ? event.metadata : {};
  const paths = event.mediaPaths ?? metadata.mediaPaths ?? (event.mediaPath ?? metadata.mediaPath ? [event.mediaPath ?? metadata.mediaPath] : []);
  const urls = event.mediaUrls ?? metadata.mediaUrls ?? (event.mediaUrl ?? metadata.mediaUrl ? [event.mediaUrl ?? metadata.mediaUrl] : []);
  const types = event.mediaTypes ?? metadata.mediaTypes ?? (event.mediaType ?? metadata.mediaType ? [event.mediaType ?? metadata.mediaType] : []);
  return Array.from({ length: Math.max(paths.length, urls.length, types.length) }, (_, index) => ({ path: clean(paths[index]) || null, url: clean(urls[index]) || null, mimeType: clean(types[index]) || null }));
};
const sanitizeMetadata = (value) => isPlainObject(value) ? structuredClone(value) : {};

export function mergeNonEmpty(existing, incoming) {
  if (incoming == null || incoming === "" || (Array.isArray(incoming) && incoming.length === 0)) return structuredClone(existing);
  if (existing == null || existing === "" || (Array.isArray(existing) && existing.length === 0)) return structuredClone(incoming);
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    return Object.fromEntries([...new Set([...Object.keys(existing), ...Object.keys(incoming)])].map((key) => [key, mergeNonEmpty(existing[key], incoming[key])]));
  }
  return structuredClone(existing);
}

export function buildCorrelationKeys({ event, context }) {
  const channel = clean(context.channelId ?? event.channel);
  const account = clean(context.accountId ?? event.accountId) || "default";
  const messageId = clean(event.messageId ?? context.messageId);
  const contentHash = sha256(clean(event.content ?? event.body));
  const timestamp = normalizeTimestamp(event.timestamp)?.getTime() ?? 0;
  const keys = [];
  if (channel && messageId) keys.push(`message:${channel}:${account}:${messageId}`);
  if (context.sessionKey || event.sessionKey) keys.push(`session:${clean(context.sessionKey ?? event.sessionKey)}:${timestamp}:${clean(event.senderId ?? context.senderId)}:${contentHash}`);
  keys.push(`conversation:${channel}:${account}:${clean(context.conversationId ?? event.conversationId ?? event.from)}:${timestamp}:${contentHash}`);
  return [...new Set(keys)];
}

export function normalizeInboundEvent({ event, context, enrichment }) {
  const rich = mergeNonEmpty({ event, context }, enrichment ?? {});
  const channel = clean(rich.context.channelId ?? rich.event.channel);
  const accountId = clean(rich.context.accountId ?? rich.event.accountId) || "default";
  const conversationId = clean(rich.context.conversationId ?? rich.event.conversationId ?? rich.event.metadata?.originatingTo ?? rich.event.from);
  const messageId = clean(rich.event.messageId ?? rich.context.messageId) || null;
  const receivedAt = (normalizeTimestamp(rich.event.timestamp) ?? new Date()).toISOString();
  const fingerprint = messageId
    ? `v1|${channel}|${accountId}|${conversationId}|${messageId}`
    : `v1|${channel}|${accountId}|${conversationId}|${clean(rich.event.senderId ?? rich.context.senderId)}|${receivedAt}|${sha256(clean(rich.event.content ?? rich.event.body))}`;
  return {
    id: `evt_${sha256(fingerprint).slice(0, 32)}`,
    channel,
    accountId,
    conversationId,
    sessionKey: clean(rich.context.sessionKey ?? rich.event.sessionKey) || null,
    messageId,
    sender: {
      id: clean(rich.event.senderId ?? rich.context.senderId ?? rich.event.from) || null,
      name: clean(rich.event.senderName ?? rich.event.metadata?.senderName) || null,
      username: clean(rich.event.senderUsername ?? rich.event.metadata?.senderUsername) || null
    },
    text: String(rich.event.content ?? rich.event.body ?? ""),
    threadId: clean(rich.event.threadId ?? rich.event.metadata?.threadId) || null,
    replyTo: normalizeReply(rich.event),
    media: normalizeMedia(rich.event),
    isGroup: Boolean(rich.event.isGroup ?? rich.event.metadata?.groupId),
    metadata: sanitizeMetadata(rich.event.metadata),
    receivedAt
  };
}
```

Identity must be `evt_` plus the first 32 lowercase hex characters of SHA-256 over a versioned fingerprint. Prefer `channel/accountId/conversationId/messageId` because provider message ids are generally scoped to one conversation; otherwise include conversation, sender, normalized timestamp, and content hash. Media arrays must align by index and use `null` for missing path/url/MIME values.

Run: `node --test test/event-normalizer.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 4: Write failing correlation buffer tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { CorrelationBuffer } from "../src/correlation-buffer.js";

test("takes a rich message_received event exactly once", () => {
  let now = 1_000;
  const buffer = new CorrelationBuffer({ ttlMs: 5_000, maxEntries: 10, now: () => now });
  buffer.capture({ event: { content: "hello", messageId: "42", senderName: "Alice" }, context: { channelId: "telegram", accountId: "default" } });
  const first = buffer.take({ event: { content: "hello", messageId: "42" }, context: { channelId: "telegram", accountId: "default" } });
  assert.equal(first.event.senderName, "Alice");
  assert.equal(buffer.take({ event: { content: "hello", messageId: "42" }, context: { channelId: "telegram", accountId: "default" } }), undefined);
});

test("expires entries and enforces the bound", () => {
  let now = 1_000;
  const buffer = new CorrelationBuffer({ ttlMs: 10, maxEntries: 1, now: () => now });
  buffer.capture({ event: { content: "one", messageId: "1" }, context: { channelId: "telegram" } });
  buffer.capture({ event: { content: "two", messageId: "2" }, context: { channelId: "telegram" } });
  now += 20;
  assert.equal(buffer.size, 0);
});
```

Run: `node --test test/correlation-buffer.test.js`
Expected: FAIL because `CorrelationBuffer` is not implemented.

- [ ] **Step 5: Implement the bounded correlation buffer and static check script**

The `message_received` capture path must finish synchronously before returning a promise. `capture()` stores the same record under every correlation key, `take()` removes every alias for the matched record, and pruning runs on capture/take/size reads.

`scripts/check.mjs` must recursively run `node --check` for `.js` files under `bin`, `src`, `scripts`, and `test`, then import `index.js`; it exits nonzero on the first failure.

Run: `node --test test/event-normalizer.test.js test/correlation-buffer.test.js && npm run check`
Expected: PASS and exit 0.

- [ ] **Step 6: Commit the bootstrap slice**

```bash
git add .gitignore package.json package-lock.json openclaw.plugin.json index.js src scripts/check.mjs test
git commit -m "Establish a stable inbound message contract" -m "Create the dependency-light executable plugin boundary and deterministic correlation model before adding persistence or transport APIs.

Constraint: Runtime must work on Node 22 without an additional web framework or test framework
Confidence: high
Scope-risk: narrow
Tested: node --test event-normalizer and correlation-buffer; npm run check"
```

### Task 2: Add the durable SQLite event store and health state

**Files:**
- Create: `src/event-store.js`
- Create: `src/health-state.js`
- Create: `test/event-store.test.js`
- Create: `test/health-state.test.js`

- [ ] **Step 1: Write failing store tests for enqueue, dedupe, ACK, restart, cursor, and prune**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore } from "../src/event-store.js";

const EVENT = { id: "evt_1", channel: "telegram", accountId: "default", conversationId: "chat", messageId: "1", sender: { id: "u", name: null, username: null }, text: "hello", threadId: null, replyTo: null, media: [], isGroup: false, metadata: {}, receivedAt: "2026-07-10T00:00:00.000Z" };

test("persists one pending event across reopen and ACKs idempotently", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "channel-gateway-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "events.sqlite");
  const first = new EventStore(file);
  first.enqueue(EVENT);
  first.enqueue({ ...EVENT, sender: { ...EVENT.sender, name: "Alice" } });
  assert.equal(first.listPending({ limit: 100 }).items.length, 1);
  first.close();
  const second = new EventStore(file);
  assert.equal(second.listPending({ limit: 100 }).items[0].sender.name, "Alice");
  assert.equal(second.ack("evt_1").status, "acked");
  assert.equal(second.ack("evt_1").status, "acked");
  assert.equal(second.listPending({ limit: 100 }).items.length, 0);
  second.close();
});

test("rejects an unknown cursor and preserves earlier pending rows", () => {
  const store = new EventStore(":memory:");
  store.enqueue(EVENT);
  assert.throws(() => store.listPending({ after: "evt_missing", limit: 100 }), /unknown cursor/);
  store.close();
});
```

Add separate cases for missing ACK returning `undefined`, `limit` validation, `pendingCount()`, emitted `pending` notifications, and TTL pruning of `acked`/`failed` rows.

Run: `node --test test/event-store.test.js`
Expected: FAIL because `EventStore` does not exist.

- [ ] **Step 2: Implement the SQLite schema and transactional methods**

Use `DatabaseSync` and this schema shape:

```sql
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','acked','failed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  acked_at_ms INTEGER,
  failed_at_ms INTEGER,
  failure_code TEXT
);
CREATE INDEX IF NOT EXISTS events_status_seq ON events(status, seq);
```

Constructor initialization must set `journal_mode=WAL`, `busy_timeout=5000`, and `foreign_keys=ON`. `enqueue()` uses `BEGIN IMMEDIATE` and merges a duplicate payload with `mergeNonEmpty` without changing an existing terminal status. `listPending()` returns `{ items, nextAfter }` and resolves `after` through the row's internal `seq`. `ack()` retains a tombstone. `prune()` deletes only terminal rows older than their configured TTL. Emit `pending` only after commit.

Run: `node --test test/event-store.test.js`
Expected: PASS.

- [ ] **Step 3: Write and implement health state tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { HealthState } from "../src/health-state.js";

test("degrades without retaining message contents and recovers after a successful write", () => {
  const health = new HealthState({ now: () => 123 });
  health.degrade("SQLITE_FULL", new Error("secret message body"));
  assert.deepEqual(health.snapshot(), { status: "degraded", degradedAt: 123, code: "SQLITE_FULL" });
  assert.equal(JSON.stringify(health.snapshot()).includes("secret message body"), false);
  health.recover();
  assert.equal(health.snapshot().status, "ok");
});
```

`HealthState` stores only `status`, timestamp, and a controlled error code. It must not store arbitrary exception messages.

Run: `node --test test/health-state.test.js test/event-store.test.js && npm run check`
Expected: PASS.

- [ ] **Step 4: Commit the persistence slice**

```bash
git add src/event-store.js src/health-state.js test/event-store.test.js test/health-state.test.js
git commit -m "Persist inbound events before external delivery" -m "Add an idempotent SQLite journal with restart recovery, ACK tombstones, cursors, pruning, and a privacy-safe degraded state.

Constraint: A database failure must never fall through to model dispatch
Confidence: high
Scope-risk: narrow
Tested: node --test event-store and health-state; npm run check"
```

### Task 3: Add simple cross-channel links and the durable fan-out outbox

**Files:**
- Create: `src/route-links.js`
- Create: `src/delivery-worker.js`
- Create: `src/self-api-sender.js`
- Create: `test/route-links.test.js`
- Create: `test/delivery-outbox.test.js`
- Create: `test/delivery-worker.test.js`
- Create: `test/self-api-sender.test.js`
- Modify: `src/event-store.js`
- Modify: `openclaw.plugin.json`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing link validation and bidirectional fan-out tests**

Use one four-endpoint link representing QQ, Feishu, WhatsApp, and Telegram:

```js
const links = compileLinks([{
  id: "ops-room",
  endpoints: [
    { id: "qq", channel: "qqbot", conversationId: "qq-group-1", to: "qq-group-1" },
    { id: "feishu", channel: "feishu", conversationId: "oc_chat", to: "oc_chat" },
    { id: "wa", channel: "whatsapp", conversationId: "120@g.us", to: "120@g.us" },
    { id: "tg", channel: "telegram", conversationId: "-1001", to: "-1001" }
  ]
}]);

const jobs = planFanout({
  event: { ...EVENT, id: "evt_source", channel: "qqbot", accountId: "default", conversationId: "qq-group-1", sender: { id: "u1", name: "Alice", username: null }, text: "hello", media: [] },
  links,
  replyTargets: new Map()
});
assert.deepEqual(jobs.map((job) => job.destinationEndpointId), ["feishu", "wa", "tg"]);
assert.equal(jobs.every((job) => job.idempotencyKey === job.id), true);
assert.equal(jobs[0].request.message.startsWith("[qqbot/Alice] hello"), true);
```

Add cases proving:

- a Feishu inbound message fans out to QQ/WhatsApp/TG with no platform-specific branch;
- `receive: false` excludes a source and `send: false` excludes a destination;
- the source endpoint is never included;
- links require a non-empty unique id, at least two endpoints, unique endpoint ids, unique
  `channel/accountId/conversationId` matches, and non-empty `to`;
- account id defaults to `default`;
- duplicate endpoints across different links are rejected to prevent ambiguous fan-out.

Run: `node --test test/route-links.test.js`
Expected: FAIL because `src/route-links.js` does not exist.

- [ ] **Step 2: Implement the compact link compiler, marker codec, and planner**

Export exactly `compileLinks(input)`, `matchSourceEndpoints(event, links)`,
`planFanout({ event, links, replyTargets = new Map() })`,
`appendBridgeMarker(text, deliveryId)`, and `stripBridgeMarker(text)`.

The versioned marker is `\u2063cg1:<delivery-id>\u2063`. `stripBridgeMarker()` returns
`{ text, deliveryId }`, removes only a trailing valid marker, and leaves unknown/malformed text
unchanged. Delivery id is deterministic SHA-256 over
`v1|event.id|link.id|destination.endpoint.id`; the same value is the Gateway idempotency key.
The request contains channel/accountId/to/message/mediaUrls/replyToId/threadId/idempotencyKey.
`mediaUrls` uses each media item's `url` then `path`. Message formatting is fixed and simple:
`[{source channel}/{sender name or id or "unknown"}] {text}`, followed by the hidden marker.
Do not add a template language or channel switch statement.

Run: `node --test test/route-links.test.js`
Expected: PASS.

- [ ] **Step 3: Write failing durable outbox and receipt-relation tests**

Extend the store test setup and assert event + jobs are atomic:

```js
const jobs = planFanout({ event: EVENT, links, replyTargets: new Map() });
store.enqueue(EVENT, { deliveries: jobs });
assert.equal(store.deliveryCounts().pending, 3);
const claimed = store.claimNextDelivery({ nowMs: 1_000 });
assert.equal(claimed.status, "sending");
store.completeDelivery(claimed.id, { messageId: "feishu-message-1", completedAtMs: 1_001 });
assert.equal(store.findEcho({ channel: "feishu", accountId: "default", conversationId: "oc_chat", messageId: "feishu-message-1" }).eventId, EVENT.id);
```

Add cases for:

- duplicate enqueue does not duplicate jobs;
- reopening resets stale `sending` jobs to `pending`;
- `retryDelivery()` increments attempts, sets `nextAttemptAtMs`, and becomes `failed` at max attempts;
- claim order uses due time then insertion order;
- a reply to a destination receipt resolves per-endpoint reply ids: original source message id for
  the source endpoint and stored receipt ids for other destinations;
- transaction rollback leaves neither event nor jobs when a delivery row is invalid.

Run: `node --test test/delivery-outbox.test.js`
Expected: FAIL because outbox methods/schema do not exist.

- [ ] **Step 4: Add the outbox and receipt tables to the existing SQLite owner**

Use the same database and transaction owner as events:

```sql
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL,
  source_endpoint_id TEXT NOT NULL,
  destination_endpoint_id TEXT NOT NULL,
  destination_channel TEXT NOT NULL,
  destination_account_id TEXT NOT NULL,
  destination_conversation_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  marker TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  receipt_message_id TEXT,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, next_attempt_at_ms, created_at_ms);
CREATE INDEX IF NOT EXISTS deliveries_receipt ON deliveries(destination_channel, destination_account_id, destination_conversation_id, receipt_message_id);
```

`enqueue(event, { deliveries })` must commit the event and jobs together. Implement
`claimNextDelivery`, `completeDelivery`, `retryDelivery`, `deliveryCounts`, `findEcho`, and
`resolveReplyTargets`. Reset `sending` to `pending` during store initialization. Store only
controlled error codes, never raw provider/token error text.

Run: `node --test test/event-store.test.js test/delivery-outbox.test.js`
Expected: PASS.

- [ ] **Step 5: Write failing worker and loopback sender tests**

Worker tests use a fake store and sender to prove one claim/send/complete cycle, retry with bounded
exponential delays, terminal failure, no concurrent tick overlap, and clean stop. Sender tests prove:

```js
const send = createSelfApiSender({ baseUrl: "http://127.0.0.1:18789", token: "secret", fetchImpl });
await send({ channel: "telegram", to: "-1001", message: "hello", idempotencyKey: "d1" });
assert.equal(calls[0].headers.authorization, "Bearer secret");
assert.equal(JSON.stringify(await rejectedError).includes("secret"), false);
```

Run: `node --test test/delivery-worker.test.js test/self-api-sender.test.js`
Expected: FAIL because worker/sender modules do not exist.

- [ ] **Step 6: Implement sequential delivery and the authenticated self-call**

`DeliveryWorker` exposes `start()`, `tick()`, and `stop()`. It processes one job at a time, uses
`Math.min(60_000, 1_000 * 2 ** attempts)` retry delay, and accepts injected clock/timers for tests.
`createSelfApiSender()` POSTs JSON to `/api/v1/messages`, uses a 30-second AbortSignal timeout,
returns the successful payload, and throws a sanitized `{ code, retryable, retryAfterMs }` error.
It may read the token only at construction; jobs never contain it.

Run: `node --test test/delivery-worker.test.js test/self-api-sender.test.js`
Expected: PASS.

- [ ] **Step 7: Extend manifest/package configuration without bundling QQ by default**

Add exact optional `@openclaw/feishu@2026.6.11`. Do not add `@openclaw/qqbot` to default or common
dependencies. Extend the strict plugin schema with `links`, `deliveryPollMs`, and
`deliveryMaxAttempts`; endpoint schema requires id/channel/conversationId/to and permits
accountId/receive/send/threadId only.

Run: `npm install --omit=optional && npm test && npm run check`
Expected: PASS and exact lockfile entries; QQ remains absent from direct dependencies.

- [ ] **Step 8: Commit the cross-channel routing slice**

```bash
git add package.json package-lock.json openclaw.plugin.json src/event-store.js src/route-links.js src/delivery-worker.js src/self-api-sender.js test/event-store.test.js test/route-links.test.js test/delivery-outbox.test.js test/delivery-worker.test.js test/self-api-sender.test.js
git commit -m "Connect related conversations without platform-specific routing" -m "Represent QQ, Feishu, WhatsApp, Telegram, and other conversations as validated endpoints in one bidirectional link model, then persist fan-out jobs and receipt relations in the existing SQLite owner.

Constraint: Hook code cannot call authenticated Gateway methods outside an HTTP request scope
Rejected: Add a workflow engine | unnecessary for deterministic conversation fan-out
Confidence: high
Scope-risk: moderate
Directive: Keep routing generic; new channels are configuration, not router branches
Tested: route-link, delivery-outbox, delivery-worker, self-api-sender, existing store tests, npm run check"
```

### Task 4: Implement REST RPC mapping and SSE delivery

**Files:**
- Create: `src/http-utils.js`
- Create: `src/gateway-rpc.js`
- Create: `src/sse-hub.js`
- Create: `src/api-handler.js`
- Create: `test/gateway-rpc.test.js`
- Create: `test/api-handler.test.js`
- Create: `test/sse-hub.test.js`

- [ ] **Step 1: Write failing Gateway RPC mapping tests**

Assert exact methods and parameters for status, lifecycle, and send:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createGatewayRpc } from "../src/gateway-rpc.js";

test("maps outbound messages to the pinned send RPC", async () => {
  const calls = [];
  const rpc = createGatewayRpc(async (method, params) => {
    calls.push([method, params]);
    return { ok: true, payload: { messageId: "m1" } };
  });
  await rpc.send({ channel: "telegram", accountId: "default", to: "123", message: "hello", mediaUrls: [], replyToId: "41", threadId: "7", silent: false, idempotencyKey: "key-1" });
  assert.deepEqual(calls, [["send", { channel: "telegram", accountId: "default", to: "123", message: "hello", mediaUrls: [], replyToId: "41", threadId: "7", silent: false, idempotencyKey: "key-1" }]]);
});

test("requires caller supplied idempotencyKey", async () => {
  const rpc = createGatewayRpc(async () => ({ ok: true, payload: {} }));
  await assert.rejects(() => rpc.send({ channel: "telegram", to: "123", message: "hello" }), /idempotencyKey/);
});
```

Add cases for `channels.status`, `channels.start`, `channels.stop`, `channels.logout`, invalid channel/account strings, and structured Gateway error preservation.

Run: `node --test test/gateway-rpc.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement validation and Gateway response normalization**

`createGatewayRpc(dispatch)` returns `status`, `start`, `stop`, `logout`, and `send`. It rejects unknown keys in message bodies, accepts the documented media/buffer/thread/reply/silent fields, and throws a `GatewayRpcError` carrying `code`, `details`, `retryable`, and `retryAfterMs` when the SDK response has `ok: false`.

Run: `node --test test/gateway-rpc.test.js`
Expected: PASS.

- [ ] **Step 3: Write failing HTTP API tests using a real ephemeral Node HTTP server**

The test server calls `createApiHandler(...)` directly, so Gateway auth remains a separate OpenClaw integration concern:

```js
const response = await fetch(`${baseUrl}/api/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ channel: "telegram", to: "123", message: "hello", idempotencyKey: "k1" })
});
assert.equal(response.status, 200);
assert.equal(calls[0][0], "send");
```

Cover health 200/503, pending list, unknown cursor 400, ACK 200/404, lifecycle route parsing,
`GET /api/v1/links` returning sanitized endpoint/delivery summaries, method-not-allowed 405, unknown
route 404, invalid JSON 400, duplicate/conflicting `Content-Length` 400, and body overflow 413.

Run: `node --test test/api-handler.test.js`
Expected: FAIL because the API modules do not exist.

- [ ] **Step 4: Implement bounded body parsing and the REST router**

`readJsonBody()` must reject multiple `content-length` values, non-decimal lengths, declared lengths above the configured limit, streaming bodies that exceed the limit, empty bodies, arrays, and malformed JSON. `createApiHandler()` must set `Cache-Control: no-store` and `application/json; charset=utf-8`, map `GatewayRpcError` codes to 400/404/409/503/504/502, and never return credentials or exception stacks. Its injected `linkStatus()` returns only link ids, endpoint channel/account/conversation ids, and delivery counts; it must not include messages, markers, tokens, or request payloads.

Run: `node --test test/api-handler.test.js test/gateway-rpc.test.js`
Expected: PASS.

- [ ] **Step 5: Write failing SSE tests for pending replay, live events, heartbeat, and reconnect semantics**

Use an ephemeral HTTP server, pre-enqueue two pending rows, connect to the stream, and parse frames until both ids arrive. ACK only one row, reconnect with `Last-Event-ID` set to the newer id, and assert the older still-pending id is replayed. Add a fake slow response case that exceeds `sseMaxQueue` and is closed.

Run: `node --test test/sse-hub.test.js`
Expected: FAIL because `SseHub` is missing.

- [ ] **Step 6: Implement SSE delivery and wire it into the API handler**

Each event frame is:

```text
event: message
id: evt_...
data: {canonical JSON event}

```

Subscribe before taking the pending snapshot and dedupe ids per connection to close the snapshot/live race. Heartbeats are `: heartbeat\n\n`. A blocked writer queues at most `sseMaxQueue` frames; overflow destroys the response so a client recovers from the durable pending replay.

Run: `node --test test/gateway-rpc.test.js test/api-handler.test.js test/sse-hub.test.js && npm run check`
Expected: PASS.

- [ ] **Step 7: Commit the API slice**

```bash
git add src/http-utils.js src/gateway-rpc.js src/sse-hub.js src/api-handler.js test/gateway-rpc.test.js test/api-handler.test.js test/sse-hub.test.js
git commit -m "Expose durable channel control through REST and SSE" -m "Map the stable external API to authenticated Gateway methods and make unacknowledged inbound events replayable across slow or reconnecting consumers.

Constraint: Channel lifecycle calls require the trusted-operator HTTP route scope
Confidence: high
Scope-risk: moderate
Tested: node --test gateway-rpc, api-handler, and sse-hub; npm run check"
```

### Task 5: Register the Bridge hooks, link planner, and authenticated plugin route

**Files:**
- Create: `src/bridge-runtime.js`
- Create: `src/plugin.js`
- Modify: `index.js`
- Create: `test/bridge-runtime.test.js`
- Create: `test/plugin-registration.test.js`

- [ ] **Step 1: Write a failing end-to-end Bridge hook test**

Use a temporary SQLite file, one Telegram↔Feishu link, a fake self sender, and call the runtime
handlers directly:

```js
const runtime = createBridgeRuntime({ databasePath, logger: silentLogger, dispatchGatewayMethod: fakeDispatch, links, sender: fakeSender });
runtime.onMessageReceived({ content: "hello", messageId: "42", senderName: "Alice" }, { channelId: "telegram", accountId: "default", conversationId: "chat" });
const result = await runtime.onBeforeDispatch({ content: "hello", messageId: "42" }, { channelId: "telegram", accountId: "default", conversationId: "chat" });
assert.deepEqual(result, { handled: true });
assert.equal(runtime.store.listPending({ limit: 100 }).items[0].sender.name, "Alice");
assert.equal(runtime.store.deliveryCounts().pending, 1);
```

Add cases proving the worker sends the Feishu job, a Feishu reply fans back to Telegram with the
stored Telegram message id as `replyToId`, a known marker/receipt echo returns handled without
creating an event/job, and a fake store whose `enqueue()` throws still returns `{ handled: true }`,
degrades health, and logs only a controlled code/event id rather than message text.

Run: `node --test test/bridge-runtime.test.js`
Expected: FAIL because `createBridgeRuntime` is missing.

- [ ] **Step 2: Implement runtime ownership and fail-closed hooks**

`createBridgeRuntime()` owns the store, health state, correlation buffer, compiled links, delivery
worker, SSE hub, RPC facade, and API handler. `onMessageReceived()` must only capture synchronously.
`onBeforeDispatch()` strips a known bridge marker, normalizes the event, checks marker/receipt echo,
resolves reply targets, plans fan-out, and atomically enqueues event plus deliveries. Echoes are
silently handled without external event or new delivery. Normal success recovers health; persistence
failure degrades it. Every path returns `{ handled: true }`. `close()` stops the worker, clears timers,
closes SSE clients, and closes SQLite exactly once.

Run: `node --test test/bridge-runtime.test.js`
Expected: PASS.

- [ ] **Step 3: Write failing plugin registration tests**

Create a fake API that records calls and assert:

```js
assert.equal(hooks.has("message_received"), true);
assert.equal(hooks.has("before_dispatch"), true);
assert.deepEqual(route, {
  path: "/api/v1",
  auth: "gateway",
  match: "prefix",
  gatewayRuntimeScopeSurface: "trusted-operator",
  handler: route.handler
});
assert.equal(lifecycle.id, "channel-gateway");
```

Also assert no DB or route is created for `registrationMode !== "full"`.

Run: `node --test test/plugin-registration.test.js`
Expected: FAIL until plugin registration is implemented.

- [ ] **Step 4: Implement the testable plugin factory and production entry**

`createChannelGatewayPlugin({ dispatchGatewayMethod })` returns `definePluginEntry(...)`. In
`register(api)`, return immediately unless `api.registrationMode === "full"`; resolve config defaults
and compile `links` from `api.pluginConfig`; construct the loopback sender from
`api.config.gateway.port` and `OPENCLAW_GATEWAY_TOKEN`; register both hooks with high priority and a
5-second timeout; register the authenticated prefix route with
`gatewayRuntimeScopeSurface: "trusted-operator"`; start the delivery worker after registration and
register lifecycle cleanup. `index.js` imports the public SDK dispatcher and exports the production
plugin. Token absence is a startup error only when at least one link exists; a pure event/API service
may run without an internal sender.

Run: `node --test test/bridge-runtime.test.js test/plugin-registration.test.js && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit the plugin slice**

```bash
git add index.js src/bridge-runtime.js src/plugin.js test/bridge-runtime.test.js test/plugin-registration.test.js
git commit -m "Intercept and fan out channel ingress before model dispatch" -m "Register a fail-closed awaited hook, rich metadata correlation, durable link planner and worker, authenticated admin-scoped API route, and lifecycle cleanup as one OpenClaw plugin runtime.

Constraint: message_received is fire-and-forget, so enrichment capture must be synchronous
Confidence: high
Scope-risk: moderate
Directive: before_dispatch must return handled even when persistence fails or an echo is suppressed
Tested: node --test bridge-runtime and plugin-registration, including bidirectional fan-out and loop prevention; npm run check"
```

### Task 6: Build the standalone launcher and exact-version package discovery

**Files:**
- Create: `bin/channel-gateway.js`
- Create: `src/launcher/paths.js`
- Create: `src/launcher/token.js`
- Create: `src/launcher/channel-packages.js`
- Create: `src/launcher/config.js`
- Create: `src/launcher/process.js`
- Create: `src/launcher/run.js`
- Create: `test/launcher-paths.test.js`
- Create: `test/launcher-token.test.js`
- Create: `test/launcher-channel-packages.test.js`
- Create: `test/launcher-config.test.js`
- Create: `test/launcher-process.test.js`

- [ ] **Step 1: Write failing path and token tests**

Assert precedence and permissions:

```js
const paths = resolveDataPaths({ CHANNEL_GATEWAY_DATA_DIR: "/srv/gateway" }, "/cwd");
assert.equal(paths.configPath, "/srv/gateway/config/openclaw.json");
assert.equal(paths.databasePath, "/srv/gateway/state/channel-gateway.sqlite");

const first = await ensureGatewayToken({ env: {}, credentialsDir, randomBytes: () => Buffer.alloc(32, 7) });
assert.equal((await stat(first.path)).mode & 0o777, 0o600);
assert.equal((await ensureGatewayToken({ env: {}, credentialsDir })).token, first.token);
assert.equal((await ensureGatewayToken({ env: { CHANNEL_GATEWAY_TOKEN: "env-token" }, credentialsDir })).token, "env-token");
```

Run: `node --test test/launcher-paths.test.js test/launcher-token.test.js`
Expected: FAIL because launcher helpers do not exist.

- [ ] **Step 2: Implement paths, credential symlink, and token handling**

Defaults are `<cwd>/.channel-gateway/{config,state,credentials,workspace}`. Resolve all paths to absolute paths, create directories with `0700`, atomically write the generated token with `0600`, reject blank environment tokens, and create `state/credentials` as a symlink to the separate credentials directory only when the canonical path is absent. Refuse to replace an existing non-symlink credential directory.

Run: `node --test test/launcher-paths.test.js test/launcher-token.test.js`
Expected: PASS.

- [ ] **Step 3: Write failing package discovery tests**

Build fixture package roots for exact, mismatched, and absent packages. Assert exact packages return `{ id, name, version, rootDir }`, absence is skipped, mismatch throws, and extra absolute paths with a valid manifest are included.

Run: `node --test test/launcher-channel-packages.test.js`
Expected: FAIL.

- [ ] **Step 4: Implement channel package discovery**

The built-in candidate list is Discord, Feishu, Slack, and WhatsApp at `2026.6.11`. Resolve only
direct package roots under the service `node_modules`, read each `package.json` and
`openclaw.plugin.json`, and compare both package version and manifest channel id. Parse
`CHANNEL_GATEWAY_PLUGIN_PATHS` with the platform delimiter and require absolute paths with a
manifest. Do not scan arbitrary user directories. QQ is loaded only through an explicit path or an
operator-managed exact install; never auto-install it.

Run: `node --test test/launcher-channel-packages.test.js`
Expected: PASS.

- [ ] **Step 5: Write failing first-run config tests**

Assert the initial JSON contains:

```js
{
  gateway: { mode: "local", bind: "loopback", port: 18789, auth: { mode: "token" }, controlUi: { enabled: false }, reload: { mode: "off" } },
  agents: { defaults: { workspace: "/data/workspace", skipBootstrap: true } },
  plugins: {
    enabled: true,
    load: { paths: [serviceRoot, discordRoot] },
    entries: {
      "channel-gateway": { enabled: true, hooks: { allowConversationAccess: true, timeouts: { before_dispatch: 5000 } }, config: { databasePath, links: [] } },
      discord: { enabled: true }
    }
  }
}
```

When WhatsApp is installed, assert `channels.whatsapp.pluginHooks.messageReceived === true`. When the config already exists, assert the function returns `created: false` and leaves bytes unchanged.

Run: `node --test test/launcher-config.test.js`
Expected: FAIL.

- [ ] **Step 6: Implement atomic first-run config generation**

Write strict JSON to a temp file, `chmod 0600`, then rename. Read `CHANNEL_GATEWAY_BIND` only from `loopback|lan|tailnet|auto|custom`, `CHANNEL_GATEWAY_PORT` only from `1..65535`, and include `gateway.customBindHost` only for custom bind. Preserve every existing config byte on later runs so OpenClaw CLI/operator edits survive restarts.

Run: `node --test test/launcher-config.test.js`
Expected: PASS.

- [ ] **Step 7: Write and implement child-process supervision tests**

Inject `spawn` and assert the child command is:

```text
<node executable> <serviceRoot>/node_modules/openclaw/openclaw.mjs gateway run
```

The child environment must set `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, `OPENCLAW_WORKSPACE_DIR`, and `OPENCLAW_GATEWAY_TOKEN`; it must not put the token in argv. SIGINT/SIGTERM are forwarded once, and the launcher exits with the child's code/signal result.

Run: `node --test test/launcher-process.test.js`
Expected: PASS after `src/launcher/process.js` is implemented.

- [ ] **Step 8: Implement orchestration and CLI entry**

`runChannelGateway()` checks Node version, resolves paths, ensures token/symlink, discovers packages, creates initial config, verifies the host patch marker, then supervises the Gateway. `bin/channel-gateway.js` catches startup errors, prints one sanitized line, and sets `process.exitCode = 1`.

Run: `node --test test/launcher-*.test.js && npm run check`
Expected: PASS.

- [ ] **Step 9: Commit the launcher slice**

```bash
git add bin src/launcher test/launcher-*.test.js
git commit -m "Run the channel kernel as an isolated service" -m "Create secure state paths, exact-version connector discovery, non-destructive first-run config, and signal-safe supervision around the pinned OpenClaw executable.

Constraint: Existing operator config must never be overwritten on restart
Confidence: high
Scope-risk: moderate
Tested: node --test launcher suites; npm run check"
```

### Task 7: Apply and verify the pinned rich-before-dispatch Host patch

**Files:**
- Create: `src/host-patch.js`
- Create: `scripts/patch-openclaw-dist.mjs`
- Create: `patches/openclaw-v2026.6.11-rich-before-dispatch.patch`
- Create: `test/host-patch.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing deterministic transform tests**

Create a minimal fixture containing the exact published `runBeforeDispatch` event/context block and two hook declaration fixtures. Assert `applyOpenClawRichHookPatch(root)`:

- rejects any version other than `2026.6.11`;
- rejects zero or multiple runtime marker matches for both the hook-context declaration and
  `before_dispatch` call sites;
- adds account/conversation, sender name/username, thread/message, media arrays, and metadata fields to runtime event/context;
- stages `MediaRemoteHost` attachments through the published
  `stage-sandbox-media.runtime.js` before deriving the awaited hook payload, then re-derives
  `hookContext`/`inboundClaimContext` so successful staging exposes local paths;
- preserves original references and marks `metadata.mediaStagingError = true` if staging throws or
  produces no staged file;
- adds matching optional declarations to both `.d.ts` surfaces;
- writes `.channel-gateway-rich-hook-v1.json` with package version and patched file hashes;
- is idempotent when marker hashes still match;
- rejects a marker whose files were changed afterward.

Run: `node --test test/host-patch.test.js`
Expected: FAIL because the transform is missing.

- [ ] **Step 2: Implement the exact-context patcher**

Search `dist/*.js` for the unique hook-context declaration and `reply.before_dispatch_hooks`
markers, and `dist/**/*hook-types*.d.ts` for the declaration marker. Use full exact multiline
source strings, require match count one for each runtime marker and two for declarations, write
through temp files plus rename, and verify SHA-256 hashes after writing. Change the generated
`hookContext`/`inboundClaimContext` bindings from `const` to `let`; immediately before the awaited
hook, dynamically import `./stage-sandbox-media.runtime.js` only when remote media exists, call
`stageSandboxMedia({ ctx, sessionCtx: ctx, cfg, sessionKey: acpDispatchSessionKey, workspaceDir })`,
set `ctx.MediaStaged`, and rebuild both canonical hook objects on success. The enriched event/context
must then read only existing canonical fields and include a boolean staging error marker rather than
raw error text. Do not use eval or an unconstrained regex replacement over generated code.

Run: `node --test test/host-patch.test.js`
Expected: PASS.

- [ ] **Step 3: Add the postinstall command and patch the real installed Host**

Add scripts:

```json
{
  "postinstall": "node ./scripts/patch-openclaw-dist.mjs",
  "patch:openclaw": "node ./scripts/patch-openclaw-dist.mjs",
  "verify:openclaw-patch": "node ./scripts/patch-openclaw-dist.mjs --verify"
}
```

`scripts/patch-openclaw-dist.mjs` resolves the direct `node_modules/openclaw` root and supports apply/verify modes.

Run: `npm run patch:openclaw && npm run verify:openclaw-patch`
Expected: both commands exit 0 and the installed OpenClaw marker reports `2026.6.11`.

- [ ] **Step 4: Create the source-level audit patch**

The patch must update the `v2026.6.11` versions of:

- `src/plugins/hook-types.ts` with the same optional fields;
- `src/auto-reply/reply/dispatch-from-config.ts` with remote-media staging, canonical context
  re-derivation, and the enriched event/context payload;
- `src/auto-reply/reply/dispatch-from-config.test.ts` with tests proving staged rich fields are
  delivered, staging failure preserves references without leaking error text, and a handled result
  does not call the model resolver.

Validate applicability without modifying the upstream checkout:

Run: `git -C /Users/sanbo/Desktop/openclaw/upstream-openclaw worktree add /tmp/openclaw-v2026.6.11-patch-check v2026.6.11 && git -C /tmp/openclaw-v2026.6.11-patch-check apply --check "$PWD/patches/openclaw-v2026.6.11-rich-before-dispatch.patch" && git -C /Users/sanbo/Desktop/openclaw/upstream-openclaw worktree remove /tmp/openclaw-v2026.6.11-patch-check --force`
Expected: exit 0.

- [ ] **Step 5: Run the full test/static gate and commit**

Run: `npm test && npm run check && npm run verify:openclaw-patch`
Expected: all tests pass and all checks exit 0.

```bash
git add package.json package-lock.json src/host-patch.js scripts/patch-openclaw-dist.mjs patches test/host-patch.test.js
git commit -m "Preserve rich inbound fields at the awaited hook boundary" -m "Patch only the pinned published Host with exact-context verification so media, thread, sender, and message identity survive the fail-closed before_dispatch interception path.

Constraint: Published OpenClaw bundles do not expose this rich awaited hook contract directly
Rejected: Patch arbitrary OpenClaw versions | unsafe because generated bundle contexts drift
Confidence: high
Scope-risk: moderate
Directive: Upgrade the Host only by regenerating and revalidating both runtime and source-level patches
Tested: host patch unit suite, real package apply/verify, full npm test and check"
```

### Task 8: Add deployment, license evidence, documentation, and real standalone smoke

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Create: `scripts/license-report.mjs`
- Create: `test/license-report.test.js`
- Create: `test/smoke/standalone-smoke.test.js`
- Create: `licenses/openclaw/LICENSE`
- Create: `licenses/openclaw/THIRD_PARTY_NOTICES.md`
- Create: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Write failing license inventory tests**

Fixture package metadata must prove that the report:

- includes name/version/license/source path;
- marks `UNLICENSED` and missing license metadata as blockers;
- marks GPL/LGPL/MPL entries for manual review;
- exits nonzero in strict mode only for blockers;
- never scans outside the dependency roots represented by the selected package lock/install tree.

Run: `node --test test/license-report.test.js`
Expected: FAIL because the report generator is missing.

- [ ] **Step 2: Implement license and SBOM scripts**

Add scripts:

```json
{
  "licenses": "node ./scripts/license-report.mjs",
  "licenses:strict": "node ./scripts/license-report.mjs --strict",
  "sbom": "npm sbom --sbom-format cyclonedx > artifacts/sbom.cdx.json"
}
```

The report writes `artifacts/licenses.json`, creates the directory if needed, and prints only counts plus blocker/review package names. Copy the exact upstream `v2026.6.11` `LICENSE` and `THIRD_PARTY_NOTICES.md` into `licenses/openclaw/`.

Run: `node --test test/license-report.test.js && npm run licenses && npm run sbom`
Expected: PASS; artifacts are generated but ignored by Git.

- [ ] **Step 3: Create Docker base/common profiles and Compose deployment**

`Dockerfile` uses `node:22.20.0-bookworm-slim`, accepts `ARG CHANNEL_PROFILE=base`, runs `npm ci --omit=dev --omit=optional` for base and `npm ci --omit=dev` for common, verifies the Host patch, copies licenses, runs as `node`, exposes `18789`, and starts `node bin/channel-gateway.js`.

`docker-compose.yml` sets `CHANNEL_GATEWAY_DATA_DIR=/data`, `CHANNEL_GATEWAY_BIND=lan`, requires `CHANNEL_GATEWAY_TOKEN`, maps port `18789`, and persists config/state/credentials/workspace with named volumes. Its healthcheck calls unauthenticated OpenClaw `/healthz`; Bridge readiness remains the authenticated `/api/v1/health` endpoint.

Run: `docker build --build-arg CHANNEL_PROFILE=base -t channel-gateway:test .`
Expected: exit 0 and patch verification during build.

- [ ] **Step 4: Write the real process smoke test before its harness implementation**

The smoke test must:

1. allocate a free loopback port and temporary data directory;
2. create a pending event in the same SQLite file, then close it;
3. spawn `node bin/channel-gateway.js` with a fixed token and no model/provider credentials;
4. wait for `/healthz`, then call authenticated `/api/v1/health`, `/api/v1/events`,
   `/api/v1/channels`, and `/api/v1/links`;
5. assert the seeded pending event is returned;
6. stop and restart the process with the same data directory;
7. ACK the event and assert the pending list becomes empty;
8. inspect state paths and assert no model auth profile was created;
9. always terminate the child and include bounded stdout/stderr tails on failure.

Run: `node --test test/smoke/standalone-smoke.test.js`
Expected: FAIL until the real launcher/plugin integration issues are resolved; iterate on production code rather than weakening the assertions.

- [ ] **Step 5: Make the real standalone smoke pass**

Run: `node --test test/smoke/standalone-smoke.test.js`
Expected: PASS with one real `openclaw@2026.6.11` Gateway process, authenticated Bridge API, persisted event recovery, and no LLM credential.

Then install common optional channels and repeat discovery proof:

Run: `npm install --include=optional && npm run patch:openclaw && node --test test/smoke/standalone-smoke.test.js`
Expected: PASS; `/api/v1/channels` contains installed Discord, Feishu, Slack, and WhatsApp surfaces
in unconfigured/stopped states rather than crashing startup.

- [ ] **Step 6: Write operator documentation**

`README.md` must include:

- architecture and why provider adapters are not copied;
- Node and exact-version requirements;
- base versus common channel profiles;
- local and Docker startup;
- Telegram/Discord/Feishu/Slack/WhatsApp/Teams/Matrix/Signal onboarding boundary using native OpenClaw commands;
- a complete `links` example connecting a QQ group, Feishu group, WhatsApp group/private chat, and
  Telegram group, including endpoint ids, conversation ids, targets, and direction flags;
- explanation that links are bidirectional by default, delivery is durable, echoes are suppressed,
  and supported reply receipts preserve cross-platform relation;
- explicit QQ installation command and the reason QQ is not included in the default/common image;
- all REST/SSE requests with Bearer examples;
- ACK/replay semantics and fail-closed degraded behavior;
- token/admin scope warning and one-instance-per-untrusted-tenant rule;
- state/credential backup paths;
- upgrade procedure that regenerates patch evidence and reruns smoke;
- license/SBOM commands and known manual-review items;
- explicit statement that live provider proof requires real provider credentials/sidecars.

Run: `rg -n "REST|SSE|ACK|CHANNEL_GATEWAY_TOKEN|QQ|Feishu|Discord|Slack|WhatsApp|links|bidirectional|echo|upgrade|license|SBOM|tenant" README.md`
Expected: every required topic has at least one match.

- [ ] **Step 7: Run final verification and commit**

Run:

```bash
npm test
npm run check
npm run verify:openclaw-patch
npm run licenses
npm run sbom
docker build --build-arg CHANNEL_PROFILE=base -t channel-gateway:test .
git diff --check
git status --short
```

Expected: all commands exit 0; only intended source/docs and ignored artifacts are present.

```bash
git add Dockerfile docker-compose.yml .dockerignore package.json scripts/license-report.mjs test/license-report.test.js test/smoke licenses README.md
git commit -m "Make multi-channel interoperability independently deployable" -m "Package the Bridge and pinned connector kernel with reproducible deployment, license evidence, operator guidance, and a real no-model restart smoke test.

Constraint: Live provider delivery still requires each platform's credentials or local sidecar
Confidence: high
Scope-risk: broad
Directive: Do not publish profiles containing blocked licenses without explicit legal approval
Tested: full node tests/checks, patch verification, license report, SBOM, base Docker build, standalone Gateway restart smoke
Not-tested: Live third-party platform credentials unless supplied separately"
```

## Final completion audit

- [ ] Re-read every success criterion in `docs/superpowers/specs/2026-07-10-channel-gateway-design.md` and map it to fresh command output.
- [ ] Verify `git log --format=full -7` follows the Lore commit protocol.
- [ ] Verify `git status --short` is clean except intentionally ignored runtime artifacts.
- [ ] Run a fresh `npm test`, `npm run check`, `npm run verify:openclaw-patch`, `npm run licenses`, `npm run sbom`, and base Docker build.
- [ ] Run the real standalone smoke from a fresh temporary data directory.
- [ ] Run the fake-sender four-endpoint integration proving QQ→Feishu/WhatsApp/TG and reverse
  fan-out, restart-safe delivery, echo suppression, and receipt-based reply relation.
- [ ] Record live-provider testing as a separate, credential-dependent result; do not infer it from contract tests.
