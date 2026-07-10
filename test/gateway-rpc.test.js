import assert from "node:assert/strict";
import test from "node:test";

import { GatewayRpcError, createGatewayRpc } from "../src/gateway-rpc.js";

test("maps channel status and lifecycle calls to exact Gateway methods", async () => {
  const calls = [];
  const rpc = createGatewayRpc(async (method, params, options) => {
    calls.push([method, params, options]);
    return { ok: true, payload: { method } };
  });

  assert.deepEqual(await rpc.status({ probe: true }), { method: "channels.status" });
  await rpc.start({ channel: "telegram", accountId: "default" });
  await rpc.stop({ channel: "feishu", accountId: "work" });
  await rpc.logout({ channel: "whatsapp", accountId: "personal" });

  assert.deepEqual(calls, [
    ["channels.status", { probe: true }, { expectFinal: true, timeoutMs: 30_000 }],
    ["channels.start", { channel: "telegram", accountId: "default" }, { expectFinal: true, timeoutMs: 30_000 }],
    ["channels.stop", { channel: "feishu", accountId: "work" }, { expectFinal: true, timeoutMs: 30_000 }],
    ["channels.logout", { channel: "whatsapp", accountId: "personal" }, { expectFinal: true, timeoutMs: 30_000 }],
  ]);
});

test("maps outbound messages to the pinned send RPC without mutating input", async () => {
  const calls = [];
  const rpc = createGatewayRpc(async (method, params, options) => {
    calls.push([method, params, options]);
    return { ok: true, payload: { messageId: "m1" } };
  });
  const request = {
    channel: "telegram",
    accountId: "default",
    to: "123",
    message: "hello",
    mediaUrl: "https://cdn.example/one.png",
    mediaUrls: ["https://cdn.example/two.png"],
    buffer: "aGVsbG8=",
    filename: "hello.txt",
    contentType: "text/plain",
    asVoice: false,
    gifPlayback: false,
    replyToId: "41",
    threadId: "7",
    forceDocument: false,
    silent: false,
    parseMode: "HTML",
    idempotencyKey: "key-1",
  };
  const snapshot = structuredClone(request);

  assert.deepEqual(await rpc.send(request), { messageId: "m1" });
  assert.deepEqual(calls, [["send", request, { expectFinal: true, timeoutMs: 30_000 }]]);
  assert.deepEqual(request, snapshot);
});

test("requires caller supplied idempotencyKey and rejects unknown message keys", async () => {
  const rpc = createGatewayRpc(async () => ({ ok: true, payload: {} }));

  await assert.rejects(
    () => rpc.send({ channel: "telegram", to: "123", message: "hello" }),
    /idempotencyKey/,
  );
  await assert.rejects(
    () => rpc.send({
      channel: "telegram",
      to: "123",
      message: "hello",
      idempotencyKey: "key-1",
      token: "must-not-pass",
    }),
    /unknown.*token/i,
  );
});

test("validates channel, account, destination, media and scalar field types", async () => {
  const rpc = createGatewayRpc(async () => ({ ok: true, payload: {} }));

  for (const operation of [rpc.start, rpc.stop, rpc.logout]) {
    await assert.rejects(() => operation({ channel: " " }), /channel/);
    await assert.rejects(
      () => operation({ channel: "telegram", accountId: " " }),
      /accountId/,
    );
  }
  await assert.rejects(
    () => rpc.send({ channel: " ", to: "123", idempotencyKey: "k" }),
    /channel/,
  );
  await assert.rejects(
    () => rpc.send({ channel: "telegram", accountId: " ", to: "123", idempotencyKey: "k" }),
    /accountId/,
  );
  await assert.rejects(
    () => rpc.send({ channel: "telegram", to: " ", idempotencyKey: "k" }),
    /to/,
  );
  await assert.rejects(
    () => rpc.send({ channel: "telegram", to: "123", mediaUrls: [12], idempotencyKey: "k" }),
    /mediaUrls/,
  );
  await assert.rejects(
    () => rpc.send({ channel: "telegram", to: "123", silent: "no", idempotencyKey: "k" }),
    /silent/,
  );
});

test("preserves structured Gateway failures in GatewayRpcError", async () => {
  const details = { field: "channel", reason: "missing" };
  const rpc = createGatewayRpc(async () => ({
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: "gateway unavailable",
      details,
      retryable: true,
      retryAfterMs: 2_500,
    },
  }));

  const error = await rpc.status().then(() => undefined, (caught) => caught);
  assert.equal(error instanceof GatewayRpcError, true);
  assert.equal(error.code, "UNAVAILABLE");
  assert.equal(error.message, "gateway unavailable");
  assert.deepEqual(error.details, details);
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterMs, 2_500);
});

test("normalizes malformed Gateway failure envelopes", async () => {
  const rpc = createGatewayRpc(async () => ({
    ok: false,
    error: { code: "bad code", message: 123, retryable: "yes", retryAfterMs: -1 },
  }));

  await assert.rejects(
    () => rpc.status(),
    (error) =>
      error instanceof GatewayRpcError &&
      error.code === "GATEWAY_RPC_FAILED" &&
      error.retryable === false &&
      error.retryAfterMs === undefined,
  );
});

test("converts thrown dispatch failures into retryable controlled errors", async () => {
  const rpc = createGatewayRpc(async () => {
    throw new Error("secret scoped transport details");
  });

  await assert.rejects(
    () => rpc.status(),
    (error) =>
      error instanceof GatewayRpcError &&
      error.code === "GATEWAY_DISPATCH_FAILED" &&
      error.retryable === true &&
      !error.message.includes("secret scoped transport details"),
  );
});

test("times out a Gateway dispatch that never produces a response", async () => {
  const rpc = createGatewayRpc(() => new Promise(() => {}), { timeoutMs: 10 });

  await assert.rejects(
    () => rpc.send({ channel: "telegram", to: "123", idempotencyKey: "timeout-1" }),
    (error) =>
      error instanceof GatewayRpcError &&
      error.code === "GATEWAY_TIMEOUT" &&
      error.retryable === true,
  );
});
