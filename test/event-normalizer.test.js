import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildCorrelationKeys,
  mergeNonEmpty,
  normalizeInboundEvent,
} from "../src/event-normalizer.js";

function eventIdFor(fingerprint) {
  return `evt_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

test("mergeNonEmpty fills empty nested values without erasing existing values", () => {
  const result = mergeNonEmpty(
    {
      sender: { id: "user-1", name: "", roles: ["admin"] },
      text: "hello",
      enabled: false,
      attempts: 0,
      tags: [],
    },
    {
      sender: { id: "user-2", name: "Ada", username: "" },
      text: "   ",
      enabled: true,
      attempts: 3,
      tags: ["new"],
      metadata: { provider: "slack" },
    },
  );

  assert.deepEqual(result, {
    sender: { id: "user-1", name: "Ada", roles: ["admin"] },
    text: "hello",
    enabled: false,
    attempts: 0,
    tags: ["new"],
    metadata: { provider: "slack" },
  });
});

test("mergeNonEmpty does not mutate or retain nested references from its inputs", () => {
  const existing = { sender: { id: "user-1", name: "" } };
  const incoming = { sender: { name: "Ada" }, metadata: { guildId: "guild-1" } };
  const existingSnapshot = structuredClone(existing);
  const incomingSnapshot = structuredClone(incoming);

  const result = mergeNonEmpty(existing, incoming);
  result.sender.id = "changed";
  result.metadata.guildId = "changed";

  assert.deepEqual(existing, existingSnapshot);
  assert.deepEqual(incoming, incomingSnapshot);
});

test("normalizeInboundEvent emits the canonical rich inbound DTO", () => {
  const normalized = normalizeInboundEvent({
    event: {
      from: "user-1",
      content: "Hello from Discord",
      timestamp: 1_717_171_717,
      threadId: 42,
      messageId: "message-9",
      senderId: "user-1",
      replyToId: "message-8",
      replyToIdFull: "discord:message-8",
      replyToBody: "Earlier message",
      replyToSender: "Bob",
      replyToIsQuote: true,
      metadata: {
        providerMessage: { nonce: "nonce-1" },
      },
    },
    context: {
      channelId: "discord",
      accountId: "account-1",
      conversationId: "conversation-1",
      sessionKey: "agent:main:discord:conversation-1",
      senderId: "user-1",
    },
    enrichment: {
      senderName: "Ada Lovelace",
      senderUsername: "ada",
      mediaPaths: ["/tmp/image.png", null, "/tmp/audio.ogg"],
      mediaUrls: [null, "https://cdn.example/file.pdf"],
      mediaTypes: ["image/png", "application/pdf"],
      provider: "discord",
      surface: "gateway",
      guildId: "guild-1",
      channelName: "general",
      groupId: "guild-1",
      topicName: "launches",
      isGroup: true,
      metadata: {
        providerEventType: "MESSAGE_CREATE",
      },
    },
  });

  assert.deepEqual(normalized, {
    id: eventIdFor("v1|discord|account-1|message-9"),
    channel: "discord",
    accountId: "account-1",
    conversationId: "conversation-1",
    sessionKey: "agent:main:discord:conversation-1",
    messageId: "message-9",
    sender: {
      id: "user-1",
      name: "Ada Lovelace",
      username: "ada",
    },
    text: "Hello from Discord",
    threadId: "42",
    replyTo: {
      id: "message-8",
      idFull: "discord:message-8",
      body: "Earlier message",
      sender: "Bob",
      isQuote: true,
    },
    media: [
      { path: "/tmp/image.png", url: null, type: "image/png" },
      { path: null, url: "https://cdn.example/file.pdf", type: "application/pdf" },
      { path: "/tmp/audio.ogg", url: null, type: null },
    ],
    isGroup: true,
    metadata: {
      providerMessage: { nonce: "nonce-1" },
      providerEventType: "MESSAGE_CREATE",
      provider: "discord",
      surface: "gateway",
      guildId: "guild-1",
      channelName: "general",
      groupId: "guild-1",
      topicName: "launches",
    },
    receivedAt: 1_717_171_717_000,
  });
});

test("normalizeInboundEvent preserves millisecond timestamps and keeps exact IDs deterministic", () => {
  const input = {
    event: {
      content: "same message",
      timestamp: 1_717_171_717_123,
      messageId: "message-10",
      senderId: "user-1",
    },
    context: {
      channelId: "slack",
      accountId: "account-2",
      conversationId: "conversation-2",
    },
  };

  const first = normalizeInboundEvent(input);
  const second = normalizeInboundEvent({
    ...input,
    enrichment: { metadata: { retryAttempt: 2 } },
  });

  assert.equal(first.receivedAt, 1_717_171_717_123);
  assert.equal(first.id, eventIdFor("v1|slack|account-2|message-10"));
  assert.equal(second.id, first.id);
});

test("normalizeInboundEvent fingerprints message-less events with conversation context", () => {
  const text = "Message without a provider id";
  const contentHash = createHash("sha256").update(text).digest("hex");
  const normalized = normalizeInboundEvent({
    event: {
      content: text,
      timestamp: 1_717_171_718,
      senderId: "user-2",
    },
    context: {
      channelId: "whatsapp",
      accountId: "account-3",
      conversationId: "conversation-3",
    },
  });

  assert.equal(
    normalized.id,
    eventIdFor(
      `v1|whatsapp|account-3|conversation-3|user-2|1717171718000|${contentHash}`,
    ),
  );
  assert.equal(normalized.messageId, null);
});

test("buildCorrelationKeys returns exact, session, then conversation keys", () => {
  const content = "Correlate me";
  const contentHash = createHash("sha256").update(content).digest("hex");

  assert.deepEqual(
    buildCorrelationKeys({
      event: {
        content,
        timestamp: 1_717_171_719,
        messageId: "message-11",
        senderId: "user-3",
      },
      context: {
        channelId: "discord",
        accountId: "account-4",
        conversationId: "conversation-4",
        sessionKey: "session-4",
      },
    }),
    [
      "exact|discord|account-4|message-11",
      `session|session-4|1717171719000|user-3|${contentHash}`,
      `conversation|discord|account-4|conversation-4|1717171719000|${contentHash}`,
    ],
  );
});

test("buildCorrelationKeys omits meaningless exact keys", () => {
  const keys = buildCorrelationKeys({
    event: {
      content: "fallback only",
      timestamp: 1_717_171_720_000,
      messageId: "  ",
      senderId: "user-4",
    },
    context: {
      channelId: "slack",
      accountId: "account-5",
      conversationId: "conversation-5",
      sessionKey: "session-5",
    },
  });

  assert.equal(keys.some((key) => key.startsWith("exact|")), false);
  assert.equal(new Set(keys).size, keys.length);
});
