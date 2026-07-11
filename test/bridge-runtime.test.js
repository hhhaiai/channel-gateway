import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { appendBridgeMarker } from "../src/route-links.js";

const LINKS = [
  {
    id: "shared-room",
    endpoints: [
      {
        id: "tg",
        channel: "telegram",
        conversationId: "tg-chat",
        to: "tg-chat",
      },
      {
        id: "feishu",
        channel: "feishu",
        conversationId: "feishu-chat",
        to: "feishu-chat",
      },
    ],
  },
];

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

test("wires the authenticated HTTP facade to Gateway dispatch at request time", async (t) => {
  const calls = [];
  const runtime = createBridgeRuntime({
    databasePath: ":memory:",
    links: [],
    logger: silentLogger,
    dispatchGatewayMethod: async (method, params) => {
      calls.push([method, params]);
      return { ok: true, payload: { messageId: "provider-1" } };
    },
  });
  const server = await listen(runtime.handleHttp);
  t.after(async () => {
    await server.close();
    await runtime.close();
  });

  const response = await fetch(`${server.baseUrl}/api/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: "telegram",
      to: "123",
      message: "hello",
      idempotencyKey: "request-1",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    result: { messageId: "provider-1" },
  });
  assert.deepEqual(calls, [[
    "send",
    {
      channel: "telegram",
      to: "123",
      message: "hello",
      idempotencyKey: "request-1",
    },
  ]]);
});

test("cannot restart the delivery worker after runtime close", async () => {
  const runtime = createBridgeRuntime({
    databasePath: ":memory:",
    links: LINKS,
    logger: silentLogger,
    sender: async () => ({ messageId: "unused" }),
  });

  runtime.start();
  await runtime.close();
  assert.equal(runtime.worker.started, false);

  assert.equal(runtime.start(), false);
  assert.equal(runtime.worker.started, false);
});

test("passes bounded delivery concurrency into the worker", async () => {
  const runtime = createBridgeRuntime({
    databasePath: ":memory:",
    links: LINKS,
    logger: silentLogger,
    sender: async () => ({ messageId: "unused" }),
    deliveryMaxConcurrency: 12,
    deliveryMaxConcurrencyPerAccount: 5,
    deliveryRatePerSecondPerAccount: 7,
    deliveryRateBurstPerAccount: 11,
    deliveryAccountRateLimits: [{
      channel: "telegram",
      accountId: "bot-a",
      ratePerSecond: 20,
      burst: 30,
    }],
  });

  assert.equal(runtime.worker.maxConcurrency, 12);
  assert.equal(runtime.worker.maxConcurrencyPerAccount, 5);
  assert.deepEqual(runtime.worker.rateLimiter.defaultPolicy, {
    ratePerSecond: 7,
    burst: 11,
  });
  assert.equal(runtime.worker.rateLimiter.tryAcquire({
    channel: "telegram",
    accountId: "bot-a",
  }), true);
  await runtime.close();
});

test("runs and clears periodic terminal-state retention", async () => {
  const timers = [];
  const cleared = [];
  const runtime = createBridgeRuntime({
    databasePath: ":memory:",
    links: [],
    logger: silentLogger,
    ackTtlMs: 1_000,
    failedTtlMs: 2_000,
    setIntervalFn(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      cleared.push(timer);
    },
  });
  const calls = [];
  runtime.store.prune = (options) => calls.push(options);

  assert.equal(runtime.start(), true);
  assert.equal(timers[0].delay, 60_000);
  timers[0].callback();
  assert.deepEqual(calls, [{ ackTtlMs: 1_000, failedTtlMs: 2_000 }]);

  await runtime.close();
  assert.deepEqual(cleared, [timers[0]]);
});

test("recovers health after a transient retention failure", async () => {
  const timers = [];
  const runtime = createBridgeRuntime({
    databasePath: ":memory:",
    links: [],
    logger: silentLogger,
    setIntervalFn(callback) {
      const timer = { callback };
      timers.push(timer);
      return timer;
    },
  });
  let attempts = 0;
  runtime.store.prune = () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("temporary lock"), { code: "SQLITE_BUSY" });
    }
  };

  runtime.start();
  timers[0].callback();
  assert.deepEqual(runtime.health.snapshot().status, "degraded");
  timers[0].callback();
  assert.deepEqual(runtime.health.snapshot(), { status: "ok" });

  await runtime.close();
});

test("correlates rich ingress and atomically creates a cross-channel delivery", () => {
  const runtime = createBridgeRuntime({
    databasePath: ":memory:",
    links: LINKS,
    logger: silentLogger,
    sender: async () => ({ messageId: "unused" }),
  });

  runtime.onMessageReceived(
    { content: "hello", messageId: "42", senderName: "Alice", timestamp: 1_000 },
    { channelId: "telegram", accountId: "default", conversationId: "tg-chat" },
  );
  const result = runtime.onBeforeDispatch(
    { content: "hello", messageId: "42", timestamp: 1_000 },
    { channelId: "telegram", accountId: "default", conversationId: "tg-chat" },
  );

  assert.deepEqual(result, { handled: true });
  assert.equal(runtime.store.listPending().items[0].sender.name, "Alice");
  assert.equal(runtime.store.deliveryCounts().pending, 1);
  return runtime.close();
});

test("sends a job and maps a destination reply back to the source message", async () => {
  const sent = [];
  const runtime = createBridgeRuntime({
    databasePath: ":memory:",
    links: LINKS,
    logger: silentLogger,
    sender: async (request) => {
      sent.push(request);
      return { messageId: "feishu-forward-1" };
    },
    now: () => 1_000,
  });

  runtime.onBeforeDispatch(
    { content: "origin", messageId: "tg-origin-1", timestamp: 1_000, senderId: "tg-user" },
    { channelId: "telegram", accountId: "default", conversationId: "tg-chat" },
  );
  await runtime.worker.tick();
  assert.equal(sent[0].channel, "feishu");

  runtime.onBeforeDispatch(
    {
      content: "reply",
      messageId: "feishu-reply-1",
      replyToId: "feishu-forward-1",
      timestamp: 2_000,
      senderId: "feishu-user",
    },
    { channelId: "feishu", accountId: "default", conversationId: "feishu-chat" },
  );
  const replyJob = runtime.store.claimNextDelivery({
    nowMs: 2_000,
    leaseMs: 1_000,
    leaseToken: "reply-lease",
  });

  assert.equal(replyJob.destinationChannel, "telegram");
  assert.equal(replyJob.request.replyToId, "tg-origin-1");
  await runtime.close();
});

test("suppresses known marker and receipt echoes without creating another event", async () => {
  const runtime = createBridgeRuntime({
    databasePath: ":memory:",
    links: LINKS,
    logger: silentLogger,
    sender: async () => ({ messageId: "feishu-forward-2" }),
    now: () => 1_000,
  });
  runtime.onBeforeDispatch(
    { content: "origin", messageId: "tg-origin-2", timestamp: 1_000 },
    { channelId: "telegram", accountId: "default", conversationId: "tg-chat" },
  );
  const delivery = runtime.store.claimNextDelivery({
    nowMs: 1_000,
    leaseMs: 1_000,
    leaseToken: "echo-lease",
  });
  runtime.store.completeDelivery(delivery.id, {
    leaseToken: "echo-lease",
    messageId: "feishu-forward-2",
    completedAtMs: 1_001,
  });
  const before = runtime.store.pendingCount();

  assert.deepEqual(
    runtime.onBeforeDispatch(
      { content: appendBridgeMarker("forwarded", delivery.id), messageId: "echo-by-marker", timestamp: 2_000 },
      { channelId: "feishu", accountId: "default", conversationId: "feishu-chat" },
    ),
    { handled: true },
  );
  assert.deepEqual(
    runtime.onBeforeDispatch(
      { content: "provider echo", messageId: "feishu-forward-2", timestamp: 2_001 },
      { channelId: "feishu", accountId: "default", conversationId: "feishu-chat" },
    ),
    { handled: true },
  );
  assert.equal(runtime.store.pendingCount(), before);
  await runtime.close();
});

test("does not suppress a known marker outside its destination conversation", async () => {
  const runtime = createBridgeRuntime({
    databasePath: ":memory:",
    links: LINKS,
    logger: silentLogger,
    sender: async () => ({ messageId: "unused" }),
    now: () => 1_000,
  });
  runtime.onBeforeDispatch(
    { content: "origin", messageId: "tg-origin-domain", timestamp: 1_000 },
    { channelId: "telegram", accountId: "default", conversationId: "tg-chat" },
  );
  const delivery = runtime.store.claimNextDelivery({
    nowMs: 1_000,
    leaseMs: 1_000,
    leaseToken: "domain-lease",
  });
  const copiedText = appendBridgeMarker("copied by a user", delivery.id);

  runtime.onBeforeDispatch(
    { content: copiedText, messageId: "tg-copied-marker", timestamp: 2_000 },
    { channelId: "telegram", accountId: "default", conversationId: "tg-chat" },
  );

  assert.equal(runtime.store.listPending().items.at(-1).text, copiedText);
  await runtime.close();
});

test("keeps a syntactically valid but unknown marker in public event text", async () => {
  const runtime = createBridgeRuntime({
    databasePath: ":memory:",
    links: [],
    logger: silentLogger,
  });
  const text = appendBridgeMarker("user text", "dlv_unknown");

  runtime.onBeforeDispatch(
    { content: text, messageId: "unknown-marker", timestamp: 3_000 },
    { channelId: "telegram", accountId: "default", conversationId: "tg-chat" },
  );

  assert.equal(runtime.store.listPending().items[0].text, text);
  await runtime.close();
});

test("fails closed and degrades health without logging message contents", async () => {
  const logs = [];
  const store = {
    on() {},
    findDeliveryByMarker() {},
    findEcho() {},
    resolveReplyTargets() {
      return new Map();
    },
    enqueue() {
      const error = new Error("secret message body");
      error.code = "SQLITE_FULL";
      throw error;
    },
    close() {},
  };
  const runtime = createBridgeRuntime({
    store,
    links: [],
    logger: { ...silentLogger, error: (entry) => logs.push(entry) },
    now: () => 4_000,
  });

  const result = runtime.onBeforeDispatch(
    { content: "secret message body", messageId: "failed", timestamp: 4_000 },
    { channelId: "telegram", accountId: "default", conversationId: "tg-chat" },
  );

  assert.deepEqual(result, { handled: true });
  assert.deepEqual(runtime.health.snapshot(), {
    status: "degraded",
    degradedAt: 4_000,
    code: "SQLITE_FULL",
  });
  assert.equal(JSON.stringify(logs).includes("secret message body"), false);
  await runtime.close();
});

test("returns handled during SQLite writer contention and recovers after the lock clears", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-busy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "events.sqlite");
  const runtime = createBridgeRuntime({
    databasePath,
    links: [],
    logger: silentLogger,
  });
  const locker = new DatabaseSync(databasePath);
  locker.exec("PRAGMA busy_timeout = 100; BEGIN IMMEDIATE");

  const startedAt = Date.now();
  const result = runtime.onBeforeDispatch(
    { content: "locked", messageId: "locked-1", timestamp: 5_000 },
    { channelId: "telegram", accountId: "default", conversationId: "tg-chat" },
  );
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(result, { handled: true });
  assert.equal(runtime.health.snapshot().status, "degraded");
  assert.equal(elapsedMs < 2_500, true);

  locker.exec("ROLLBACK");
  locker.close();
  runtime.onBeforeDispatch(
    { content: "recovered", messageId: "recovered-1", timestamp: 6_000 },
    { channelId: "telegram", accountId: "default", conversationId: "tg-chat" },
  );
  assert.equal(runtime.health.snapshot().status, "ok");
  await runtime.close();
});
