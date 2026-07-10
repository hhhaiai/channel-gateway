import assert from "node:assert/strict";
import test from "node:test";

import { createSelfApiSender } from "../src/self-api-sender.js";

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test("posts through the authenticated local message API without mutating the request", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(200, { ok: true, result: { messageId: "message-1" } });
  };
  const send = createSelfApiSender({
    baseUrl: "http://127.0.0.1:18789/",
    token: "secret",
    fetchImpl,
  });
  const request = {
    channel: "telegram",
    to: "-1001",
    message: "hello",
    idempotencyKey: "d1",
  };
  const snapshot = structuredClone(request);

  assert.deepEqual(await send(request), { messageId: "message-1" });
  assert.equal(calls[0].url, "http://127.0.0.1:18789/api/v1/messages");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), request);
  assert.deepEqual(request, snapshot);
});

test("throws a sanitized Gateway error with retry metadata", async () => {
  const send = createSelfApiSender({
    baseUrl: "http://127.0.0.1:18789",
    token: "secret-token",
    fetchImpl: async () =>
      response(503, {
        ok: false,
        error: {
          code: "CHANNEL_UNAVAILABLE",
          message: "provider leaked secret-token",
          retryable: true,
          retryAfterMs: 9_000,
        },
      }),
  });

  const error = await send({ channel: "telegram", to: "-1001", message: "hello", idempotencyKey: "d2" })
    .then(() => undefined, (caught) => caught);

  assert.equal(error.code, "CHANNEL_UNAVAILABLE");
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterMs, 9_000);
  assert.equal(JSON.stringify(error).includes("secret-token"), false);
  assert.equal(error.message.includes("provider leaked"), false);
});

test("converts transport failures into retryable controlled errors", async () => {
  const send = createSelfApiSender({
    baseUrl: "http://127.0.0.1:18789",
    token: "secret",
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED secret");
    },
  });

  await assert.rejects(
    () => send({ channel: "telegram", to: "-1001", message: "hello", idempotencyKey: "d3" }),
    (error) =>
      error.code === "SELF_API_UNAVAILABLE" &&
      error.retryable === true &&
      !error.message.includes("ECONNREFUSED"),
  );
});

test("rejects blank tokens before creating a sender", () => {
  assert.throws(
    () => createSelfApiSender({ baseUrl: "http://127.0.0.1:18789", token: " " }),
    /token must be a non-empty string/,
  );
});
