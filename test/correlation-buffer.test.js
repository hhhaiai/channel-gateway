import assert from "node:assert/strict";
import test from "node:test";

import { CorrelationBuffer } from "../src/correlation-buffer.js";

test("CorrelationBuffer takes exact matches once and removes every alias", () => {
  let now = 10_000;
  const buffer = new CorrelationBuffer({
    ttlMs: 1_000,
    maxEntries: 10,
    now: () => now,
  });
  const record = {
    event: {
      channel: "discord",
      accountId: "account-1",
      conversationId: "conversation-1",
      sessionKey: "session-1",
      messageId: "message-1",
      senderId: "user-1",
      timestamp: now,
      content: "original content",
    },
    context: {},
  };

  const captureResult = buffer.capture(record);

  assert.equal(captureResult, record);
  assert.equal(buffer.size, 1);
  assert.equal(
    buffer.take({
      event: {
        channel: "discord",
        accountId: "account-1",
        messageId: "message-1",
        content: "content changed after capture",
      },
      context: {},
    }),
    record,
  );
  assert.equal(
    buffer.take({
      event: record.event,
      context: record.context,
    }),
    null,
  );
  assert.equal(buffer.size, 0);
});

test("CorrelationBuffer correlates message-less records through the session fallback", () => {
  const buffer = new CorrelationBuffer({
    ttlMs: 1_000,
    maxEntries: 10,
    now: () => 20_000,
  });
  const record = {
    event: {
      content: "fallback content",
      timestamp: 20_000,
      senderId: "user-2",
    },
    context: {
      channelId: "discord",
      accountId: "account-2",
      conversationId: "conversation-before",
      sessionKey: "session-2",
    },
  };

  buffer.capture(record);

  assert.equal(
    buffer.take({
      event: {
        content: "fallback content",
        timestamp: 20_000,
        senderId: "user-2",
      },
      context: {
        channelId: "discord",
        accountId: "account-2",
        conversationId: "conversation-after",
        sessionKey: "session-2",
      },
    }),
    record,
  );
});

test("CorrelationBuffer prunes records at their TTL boundary", () => {
  let now = 30_000;
  const buffer = new CorrelationBuffer({
    ttlMs: 1_000,
    maxEntries: 10,
    now: () => now,
  });
  const record = {
    event: {
      channel: "slack",
      accountId: "account-3",
      messageId: "message-expiring",
    },
    context: {},
  };

  buffer.capture(record);
  now += 1_000;

  assert.equal(buffer.size, 0);
  assert.equal(buffer.take(record), null);
});

test("CorrelationBuffer evicts the oldest record when the bound is exceeded", () => {
  let now = 40_000;
  const buffer = new CorrelationBuffer({
    ttlMs: 10_000,
    maxEntries: 2,
    now: () => now,
  });
  const makeRecord = (messageId) => ({
    event: {
      channel: "whatsapp",
      accountId: "account-4",
      messageId,
    },
    context: {},
  });
  const oldest = makeRecord("message-oldest");
  const middle = makeRecord("message-middle");
  const newest = makeRecord("message-newest");

  buffer.capture(oldest);
  now += 1;
  buffer.capture(middle);
  now += 1;
  buffer.capture(newest);

  assert.equal(buffer.size, 2);
  assert.equal(buffer.take(oldest), null);
  assert.equal(buffer.take(middle), middle);
  assert.equal(buffer.take(newest), newest);
});

test("CorrelationBuffer requires positive integer TTL and entry bounds", () => {
  const valid = { ttlMs: 1, maxEntries: 1, now: () => 0 };

  assert.throws(
    () => new CorrelationBuffer({ ...valid, ttlMs: 0 }),
    /ttlMs must be a positive integer/,
  );
  assert.throws(
    () => new CorrelationBuffer({ ...valid, ttlMs: 1.5 }),
    /ttlMs must be a positive integer/,
  );
  assert.throws(
    () => new CorrelationBuffer({ ...valid, maxEntries: -1 }),
    /maxEntries must be a positive integer/,
  );
  assert.throws(
    () => new CorrelationBuffer({ ...valid, maxEntries: "2" }),
    /maxEntries must be a positive integer/,
  );
});
