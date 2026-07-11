import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import test from "node:test";

import { createApiHandler } from "../src/api-handler.js";
import { EventStore } from "../src/event-store.js";
import { createGatewayRpc } from "../src/gateway-rpc.js";
import { HealthState } from "../src/health-state.js";
import { HttpBodyError, readJsonBody } from "../src/http-utils.js";

const EVENT = Object.freeze({
  id: "evt_1",
  channel: "telegram",
  accountId: "default",
  conversationId: "chat-1",
  messageId: "message-1",
  sender: { id: "user-1", name: "Alice", username: null },
  text: "hello",
  threadId: null,
  replyTo: null,
  media: [],
  isGroup: true,
  metadata: {},
  receivedAt: "2026-07-10T00:00:00.000Z",
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fixture(options = {}) {
  const calls = [];
  const store = new EventStore(":memory:");
  const health = new HealthState({ now: () => 1_234 });
  const rpc = createGatewayRpc(async (method, params) => {
    calls.push([method, params]);
    return { ok: true, payload: method === "send" ? { messageId: "sent-1" } : { method } };
  });
  const handler = createApiHandler({
    store,
    health,
    rpc,
    bodyLimitBytes: 128,
    serviceVersion: "0.1.0-test",
    openclawVersion: "2026.6.11",
    linkStatus: () => ({
      links: [{
        id: "main",
        token: "secret-token",
        endpoints: [{
          id: "tg",
          channel: "telegram",
          accountId: "default",
          conversationId: "chat-1",
          to: "-1001",
          marker: "secret-marker",
          message: "secret-message",
        }],
      }],
      deliveryCounts: { pending: 2, sending: 1, sent: 3, failed: 4 },
      request: { authorization: "Bearer secret" },
    }),
    ...options,
  });
  return { calls, store, health, handler };
}

test("returns sanitized account health, backlog, and rate-limit status", async (t) => {
  const state = fixture({
    deliveryHealth: {
      snapshot: () => ({
        channels: [{ channel: "telegram", status: "degraded", accounts: 1, pending: 3, sending: 1, failed: 0, token: "secret" }],
        accounts: [{
          channel: "telegram",
          accountId: "bot-a",
          status: "degraded",
          errorCode: "RATE_LIMITED",
          firstFailureAtMs: 1_000,
          lastFailureAtMs: 2_000,
          lastSuccessAtMs: null,
          nextRetryAtMs: 5_000,
          pending: 3,
          sending: 1,
          failed: 0,
          providerMessage: "secret body",
        }],
      }),
    },
    rateLimiter: {
      snapshot: () => [{
        channel: "telegram",
        accountId: "bot-a",
        tokens: 0.5,
        ratePerSecond: 5,
        burst: 10,
        blockedUntilMs: 4_000,
        available: false,
        credential: "secret credential",
      }],
    },
  });
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  const response = await json(await fetch(`${server.baseUrl}/api/v1/delivery/status`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(response.body.result, {
    channels: [{ channel: "telegram", status: "degraded", accounts: 1, pending: 3, sending: 1, failed: 0 }],
    accounts: [{
      channel: "telegram",
      accountId: "bot-a",
      status: "degraded",
      errorCode: "RATE_LIMITED",
      firstFailureAtMs: 1_000,
      lastFailureAtMs: 2_000,
      lastSuccessAtMs: null,
      nextRetryAtMs: 5_000,
      pending: 3,
      sending: 1,
      failed: 0,
    }],
    rateLimits: [{
      channel: "telegram",
      accountId: "bot-a",
      tokens: 0.5,
      ratePerSecond: 5,
      burst: 10,
      blockedUntilMs: 4_000,
      available: false,
    }],
  });
});

test("requires canonical API dependency names", (t) => {
  const state = fixture();
  t.after(() => state.store.close());

  for (const alias of ["rpcInput", "gatewayRpc"]) {
    assert.throws(
      () => createApiHandler({
        store: state.store,
        health: state.health,
        [alias]: { send() {} },
      }),
      /rpc must implement the Gateway facade/,
    );
  }
});

test("does not use the legacy event stream alias", async (t) => {
  const store = new EventStore(":memory:");
  const health = new HealthState({ now: () => 1_234 });
  const handler = createApiHandler({
    store,
    health,
    rpc: { send() {} },
    eventStream: {
      handle(_request, response) {
        response.end("legacy stream");
      },
    },
  });
  t.after(() => store.close());
  const server = await listen(handler);
  t.after(server.close);

  const response = await json(await fetch(`${server.baseUrl}/api/v1/events/stream`));
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "EVENT_STREAM_UNAVAILABLE");
});

async function json(response) {
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("reports healthy and degraded readiness", async (t) => {
  const state = fixture();
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  let response = await json(await fetch(`${server.baseUrl}/api/v1/health`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(response.body, {
    ok: true,
    result: {
      status: "ok",
      version: "0.1.0-test",
      openclawVersion: "2026.6.11",
      database: "ok",
      pending: 0,
      deliveries: { pending: 0, sending: 0, sent: 0, failed: 0 },
    },
  });

  state.health.degrade("SQLITE_FULL");
  response = await json(await fetch(`${server.baseUrl}/api/v1/health`));
  assert.equal(response.status, 503);
  assert.equal(response.body.result.status, "degraded");
  assert.equal(response.body.result.code, "SQLITE_FULL");
  assert.equal(JSON.stringify(response.body).includes("stack"), false);
});

test("lists pending events and rejects unknown or invalid cursors", async (t) => {
  const state = fixture();
  state.store.enqueue(EVENT);
  state.store.enqueue({ ...structuredClone(EVENT), id: "evt_2", messageId: "message-2" });
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  let response = await json(await fetch(`${server.baseUrl}/api/v1/events?limit=1`));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.result, { items: [EVENT], nextAfter: "evt_1" });

  response = await json(await fetch(`${server.baseUrl}/api/v1/events?after=evt_missing&limit=100`));
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "UNKNOWN_CURSOR");

  response = await json(await fetch(`${server.baseUrl}/api/v1/events?limit=501`));
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "INVALID_REQUEST");
});

test("ACKs pending events idempotently and returns 404 for missing ids", async (t) => {
  const state = fixture();
  state.store.enqueue(EVENT);
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  for (let index = 0; index < 2; index += 1) {
    const response = await json(await fetch(`${server.baseUrl}/api/v1/events/evt_1/ack`, { method: "POST" }));
    assert.equal(response.status, 200);
    assert.equal(response.body.result.status, "acked");
  }
  const missing = await json(await fetch(`${server.baseUrl}/api/v1/events/evt_missing/ack`, { method: "POST" }));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "EVENT_NOT_FOUND");
});

test("maps message, status, and lifecycle routes to RPC calls", async (t) => {
  const state = fixture();
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  let response = await json(await fetch(`${server.baseUrl}/api/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "telegram", to: "123", message: "hello", idempotencyKey: "k1" }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.body.result.messageId, "sent-1");
  assert.equal((await fetch(`${server.baseUrl}/api/v1/channels?probe=true`)).status, 200);

  for (const action of ["start", "stop", "logout"]) {
    response = await json(await fetch(`${server.baseUrl}/api/v1/channels/telegram/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "default" }),
    }));
    assert.equal(response.status, 200);
  }

  assert.deepEqual(state.calls, [
    ["send", { channel: "telegram", to: "123", message: "hello", idempotencyKey: "k1" }],
    ["channels.status", { probe: true }],
    ["channels.start", { channel: "telegram", accountId: "default" }],
    ["channels.stop", { channel: "telegram", accountId: "default" }],
    ["channels.logout", { channel: "telegram", accountId: "default" }],
  ]);
});

test("does not allow a lifecycle JSON body to override the channel path", async (t) => {
  const state = fixture();
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  const response = await json(await fetch(`${server.baseUrl}/api/v1/channels/telegram/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "feishu", accountId: "default" }),
  }));

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "INVALID_REQUEST");
  assert.deepEqual(state.calls, []);
});

test("returns only sanitized link endpoint and delivery summaries", async (t) => {
  const state = fixture();
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  const response = await json(await fetch(`${server.baseUrl}/api/v1/links`));
  assert.deepEqual(response.body.result, {
    links: [{
      id: "main",
      endpoints: [{ id: "tg", channel: "telegram", accountId: "default", conversationId: "chat-1" }],
    }],
    deliveryCounts: { pending: 2, sending: 1, sent: 3, failed: 4 },
  });
  const serialized = JSON.stringify(response.body);
  for (const secret of ["secret-token", "secret-marker", "secret-message", "authorization", "-1001"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("distinguishes method-not-allowed routes from unknown routes", async (t) => {
  const state = fixture();
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  const wrongMethod = await fetch(`${server.baseUrl}/api/v1/health`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  assert.equal((await fetch(`${server.baseUrl}/api/v1/not-a-route`)).status, 404);
});

test("rejects malformed, empty, array, unknown-key, and oversized JSON", async (t) => {
  const state = fixture();
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  for (const body of ["{", "", "[]"]) {
    const response = await json(await fetch(`${server.baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_JSON_BODY");
  }

  let response = await json(await fetch(`${server.baseUrl}/api/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "telegram", to: "123", idempotencyKey: "k", token: "secret" }),
  }));
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "INVALID_REQUEST");
  assert.equal(JSON.stringify(response.body).includes("secret"), false);

  response = await json(await fetch(`${server.baseUrl}/api/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(200) }),
  }));
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, "BODY_TOO_LARGE");
});

test("readJsonBody rejects duplicate, conflicting, and non-decimal Content-Length", async () => {
  for (const rawHeaders of [
    ["Content-Length", "2", "Content-Length", "2"],
    ["Content-Length", "2", "Content-Length", "3"],
    ["Content-Length", "1e2"],
    ["Content-Length", "-1"],
  ]) {
    const request = Readable.from(["{}"]);
    request.rawHeaders = rawHeaders;
    request.headers = { "content-length": rawHeaders[1] };
    await assert.rejects(
      () => readJsonBody(request, { limitBytes: 128 }),
      (error) => error instanceof HttpBodyError && error.statusCode === 400,
    );
  }
});

test("readJsonBody rejects a chunked stream that crosses its byte limit", async () => {
  const request = Readable.from([Buffer.alloc(80, "a"), Buffer.alloc(80, "b")]);
  request.rawHeaders = ["Transfer-Encoding", "chunked"];
  request.headers = { "transfer-encoding": "chunked" };

  await assert.rejects(
    () => readJsonBody(request, { limitBytes: 128 }),
    (error) =>
      error instanceof HttpBodyError &&
      error.statusCode === 413 &&
      error.code === "BODY_TOO_LARGE",
  );
});

test("a real Node server rejects conflicting Content-Length headers", async (t) => {
  const state = fixture();
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);
  const port = Number(new URL(server.baseUrl).port);

  const statusLine = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(
      "POST /api/v1/messages HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 2\r\nContent-Length: 3\r\nConnection: close\r\n\r\n{}",
    ));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data.split("\r\n", 1)[0]));
    socket.on("error", reject);
  });
  assert.match(statusLine, /^HTTP\/1\.1 400 /);
});

test("maps controlled Gateway errors without exposing details", async () => {
  const cases = [
    ["INVALID_REQUEST", 400],
    ["MESSAGE_NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["UNAVAILABLE", 503],
    ["AGENT_TIMEOUT", 504],
    ["UNEXPECTED_PROVIDER_FAILURE", 502],
  ];
  for (const [code, expectedStatus] of cases) {
    const state = fixture({
      rpc: createGatewayRpc(async () => ({
        ok: false,
        error: {
          code,
          message: "credential secret-token failed\nstack line",
          details: { token: "secret-token" },
          retryable: code === "UNAVAILABLE",
          retryAfterMs: code === "UNAVAILABLE" ? 500 : undefined,
        },
      })),
    });
    const server = await listen(state.handler);
    const response = await json(await fetch(`${server.baseUrl}/api/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "telegram", to: "123", idempotencyKey: "k1" }),
    }));
    await server.close();
    state.store.close();

    assert.equal(response.status, expectedStatus);
    assert.equal(response.body.error.code, code);
    assert.equal(JSON.stringify(response.body).includes("secret-token"), false);
    assert.equal(JSON.stringify(response.body).includes("stack line"), false);
  }
});

test("reads and saves full link configuration without weakening the sanitized status route", async (t) => {
  const state = fixture({
    bodyLimitBytes: 1024,
    configService: {
      read() {
        return {
          links: [{
            id: "room",
            endpoints: [
              { id: "qq", channel: "qqbot", accountId: "default", conversationId: "qq-1", to: "qq-1", receive: true, send: true, threadId: null },
              { id: "tg", channel: "telegram", accountId: "default", conversationId: "tg-1", to: "-1001", receive: true, send: true, threadId: null },
            ],
          }],
          revision: "a".repeat(64),
          deliveryMaxConcurrency: null,
          effectiveDeliveryMaxConcurrency: 4,
          deliveryMaxConcurrencySource: "detected",
          deliveryMaxConcurrencyHardMax: 256,
          resources: {
            cpuCount: 2,
            memoryLimitBytes: 4 * 1024 ** 3,
            memorySource: "host",
          },
          restartRequired: true,
        };
      },
      async update(body) {
        assert.equal(body.revision, "a".repeat(64));
        assert.equal(body.links[0].endpoints[1].to, "-1001");
        assert.equal(body.deliveryMaxConcurrency, 12);
        return {
          ...this.read(),
          links: body.links,
          deliveryMaxConcurrency: 12,
          effectiveDeliveryMaxConcurrency: 12,
          deliveryMaxConcurrencySource: "config",
        };
      },
    },
  });
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  let response = await json(await fetch(`${server.baseUrl}/api/v1/links/config`));
  assert.equal(response.status, 200);
  assert.equal(response.body.result.links[0].endpoints[1].to, "-1001");
  assert.equal(response.body.result.restartRequired, true);
  assert.equal(response.body.result.effectiveDeliveryMaxConcurrency, 4);

  response = await json(await fetch(`${server.baseUrl}/api/v1/links/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      links: response.body.result.links,
      revision: response.body.result.revision,
      deliveryMaxConcurrency: 12,
    }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.body.result.revision, "a".repeat(64));
  assert.equal(response.body.result.effectiveDeliveryMaxConcurrency, 12);

  const status = await json(await fetch(`${server.baseUrl}/api/v1/links`));
  assert.equal(JSON.stringify(status.body).includes("-1001"), false);
});

test("rejects unavailable, malformed, and stale link configuration writes", async (t) => {
  const state = fixture({
    configService: {
      read() { return { links: [], revision: "a".repeat(64), restartRequired: true }; },
      async update() {
        const error = new Error("stale");
        error.code = "CONFIG_CONFLICT";
        throw error;
      },
    },
  });
  t.after(() => state.store.close());
  const server = await listen(state.handler);
  t.after(server.close);

  let response = await json(await fetch(`${server.baseUrl}/api/v1/links/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ links: [], revision: "a".repeat(64), extra: true }),
  }));
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "INVALID_REQUEST");

  response = await json(await fetch(`${server.baseUrl}/api/v1/links/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ links: [], revision: "a".repeat(64) }),
  }));
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "CONFIG_CONFLICT");
});
