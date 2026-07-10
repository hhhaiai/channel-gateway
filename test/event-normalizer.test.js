import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildCorrelationKeys,
  mergeNonEmpty,
  normalizeInboundEvent,
} from "../src/event-normalizer.js";
import { CorrelationBuffer } from "../src/correlation-buffer.js";

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
    id: eventIdFor("v1|discord|account-1|conversation-1|message-9"),
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
      text: "Earlier message",
      sender: "Bob",
    },
    media: [
      { path: "/tmp/image.png", url: null, mimeType: "image/png" },
      { path: null, url: "https://cdn.example/file.pdf", mimeType: "application/pdf" },
      { path: "/tmp/audio.ogg", url: null, mimeType: null },
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
      replyToIdFull: "discord:message-8",
      replyToIsQuote: true,
    },
    receivedAt: "2024-05-31T16:08:37.000Z",
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

  assert.equal(first.receivedAt, "2024-05-31T16:08:37.123Z");
  assert.equal(typeof first.receivedAt, "string");
  assert.equal(
    first.id,
    eventIdFor("v1|slack|account-2|conversation-2|message-10"),
  );
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
  assert.equal(normalized.receivedAt, "2024-05-31T16:08:38.000Z");
});

test("normalizeInboundEvent applies defaults and metadata fallbacks without mutating inputs", () => {
  const event = {
    metadata: {
      originatingTo: "conversation-from-metadata",
      sender: {
        id: "metadata-user",
        name: "Metadata Name",
        username: "metadata-user",
      },
      threadId: 77,
      mediaPaths: ["/tmp/from-metadata.png"],
      mediaUrls: [null, "https://cdn.example/from-metadata.pdf"],
      mediaTypes: ["image/png", "application/pdf"],
      isGroup: true,
    },
  };
  const context = { channelId: "slack" };
  const eventSnapshot = structuredClone(event);
  const contextSnapshot = structuredClone(context);
  const fixedNow = 1_700_000_000_000;
  const contentHash = createHash("sha256").update("").digest("hex");

  const normalized = normalizeInboundEvent({
    event,
    context,
    now: () => fixedNow,
  });

  assert.equal(normalized.accountId, "default");
  assert.equal(normalized.conversationId, "conversation-from-metadata");
  assert.deepEqual(normalized.sender, {
    id: "metadata-user",
    name: "Metadata Name",
    username: "metadata-user",
  });
  assert.equal(normalized.text, "");
  assert.equal(normalized.threadId, "77");
  assert.deepEqual(normalized.media, [
    { path: "/tmp/from-metadata.png", url: null, mimeType: "image/png" },
    {
      path: null,
      url: "https://cdn.example/from-metadata.pdf",
      mimeType: "application/pdf",
    },
  ]);
  assert.equal(normalized.isGroup, true);
  assert.equal(normalized.receivedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(
    normalized.id,
    eventIdFor(
      `v1|slack|default|conversation-from-metadata|metadata-user|${fixedNow}|${contentHash}`,
    ),
  );
  assert.deepEqual(event, eventSnapshot);
  assert.deepEqual(context, contextSnapshot);
});

test("normalizeInboundEvent consumes a CorrelationBuffer event-context record as enrichment", () => {
  const buffer = new CorrelationBuffer({
    ttlMs: 1_000,
    maxEntries: 10,
    now: () => 1_717_171_721_000,
  });
  const captured = {
    event: {
      content: "captured content",
      timestamp: 1_717_171_721,
      messageId: "message-12",
      senderId: "user-5",
      senderName: "Captured Name",
      senderUsername: "captured-user",
      replyToId: "message-11",
      replyToIdFull: "discord:message-11",
      replyToBody: "Captured reply",
      replyToSender: "Previous Sender",
      mediaPaths: ["/tmp/captured.png"],
      mediaTypes: ["image/png"],
      isGroup: true,
      metadata: { providerEventType: "MESSAGE_CREATE" },
    },
    context: {
      channelId: "discord",
      accountId: "account-6",
      conversationId: "conversation-6",
      sessionKey: "session-6",
      senderId: "user-5",
    },
  };
  buffer.capture(captured);
  const enrichment = buffer.take({
    event: { messageId: "message-12" },
    context: {
      channelId: "discord",
      accountId: "account-6",
      conversationId: "conversation-6",
    },
  });
  const event = {
    content: "current content",
    timestamp: 1_717_171_721,
    messageId: "message-12",
  };
  const context = { channelId: "discord" };
  const eventSnapshot = structuredClone(event);
  const contextSnapshot = structuredClone(context);
  const enrichmentSnapshot = structuredClone(enrichment);

  const normalized = normalizeInboundEvent({ event, context, enrichment });

  assert.equal(normalized.accountId, "account-6");
  assert.equal(normalized.conversationId, "conversation-6");
  assert.equal(normalized.sessionKey, "session-6");
  assert.deepEqual(normalized.sender, {
    id: "user-5",
    name: "Captured Name",
    username: "captured-user",
  });
  assert.equal(normalized.text, "current content");
  assert.deepEqual(normalized.replyTo, {
    id: "message-11",
    text: "Captured reply",
    sender: "Previous Sender",
  });
  assert.deepEqual(normalized.media, [
    { path: "/tmp/captured.png", url: null, mimeType: "image/png" },
  ]);
  assert.equal(normalized.isGroup, true);
  assert.deepEqual(normalized.metadata, {
    providerEventType: "MESSAGE_CREATE",
    replyToIdFull: "discord:message-11",
  });
  assert.equal(normalized.receivedAt, "2024-05-31T16:08:41.000Z");
  assert.deepEqual(event, eventSnapshot);
  assert.deepEqual(context, contextSnapshot);
  assert.deepEqual(enrichment, enrichmentSnapshot);
});

test("normalizeInboundEvent falls back to provider-full reply IDs without widening replyTo", () => {
  const cases = [
    {
      name: "event",
      event: { replyToIdFull: "event:reply-1" },
      context: {},
      expectedId: "event:reply-1",
    },
    {
      name: "context",
      event: {},
      context: { replyToIdFull: "context:reply-2" },
      expectedId: "context:reply-2",
    },
    {
      name: "metadata",
      event: { metadata: { replyToIdFull: "metadata:reply-3" } },
      context: {},
      expectedId: "metadata:reply-3",
    },
  ];

  for (const entry of cases) {
    const normalized = normalizeInboundEvent({
      event: { timestamp: 1_717_171_722, ...entry.event },
      context: { channelId: "discord", ...entry.context },
    });

    assert.deepEqual(
      normalized.replyTo,
      { id: entry.expectedId, text: null, sender: null },
      entry.name,
    );
  }
});

test("normalizeInboundEvent infers groups from metadata without overriding explicit false", () => {
  const inferred = normalizeInboundEvent({
    event: { timestamp: 1_717_171_723, metadata: { groupId: "group-1" } },
    context: { channelId: "slack" },
  });
  const explicitDirect = normalizeInboundEvent({
    event: {
      timestamp: 1_717_171_723,
      isGroup: false,
      metadata: { groupId: "group-1" },
    },
    context: { channelId: "slack" },
  });

  assert.equal(inferred.isGroup, true);
  assert.equal(explicitDirect.isGroup, false);
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
      "exact|discord|account-4|conversation-4|message-11",
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

test("buildCorrelationKeys uses the default account when accountId is absent", () => {
  const content = "default account correlation";
  const contentHash = createHash("sha256").update(content).digest("hex");

  assert.deepEqual(
    buildCorrelationKeys({
      event: {
        channel: "discord",
        content,
        timestamp: 1_717_171_724,
        messageId: "message-13",
        senderId: "user-6",
      },
      context: {
        conversationId: "conversation-7",
        sessionKey: "session-7",
      },
    }),
    [
      "exact|discord|default|conversation-7|message-13",
      `session|session-7|1717171724000|user-6|${contentHash}`,
      `conversation|discord|default|conversation-7|1717171724000|${contentHash}`,
    ],
  );
});

test("buildCorrelationKeys correlates media-only events with the empty content hash", () => {
  const emptyContentHash = createHash("sha256").update("").digest("hex");

  assert.deepEqual(
    buildCorrelationKeys({
      event: {
        content: "   ",
        timestamp: 1_717_171_725,
        senderId: "user-7",
        mediaUrls: ["https://cdn.example/media-only.png"],
      },
      context: {
        channelId: "discord",
        accountId: "account-7",
        conversationId: "conversation-8",
        sessionKey: "session-8",
      },
    }),
    [
      `session|session-8|1717171725000|user-7|${emptyContentHash}`,
      `conversation|discord|account-7|conversation-8|1717171725000|${emptyContentHash}`,
    ],
  );
});

test("provider-local message ids remain distinct across conversations", () => {
  const base = {
    event: {
      content: "same provider id",
      timestamp: 1_717_171_730,
      messageId: "42",
      senderId: "user-42",
    },
  };
  const first = normalizeInboundEvent({
    ...base,
    context: {
      channelId: "telegram",
      accountId: "default",
      conversationId: "chat-a",
    },
  });
  const second = normalizeInboundEvent({
    ...base,
    context: {
      channelId: "telegram",
      accountId: "default",
      conversationId: "chat-b",
    },
  });

  assert.notEqual(first.id, second.id);
  assert.equal(first.id, eventIdFor("v1|telegram|default|chat-a|42"));
  assert.equal(second.id, eventIdFor("v1|telegram|default|chat-b|42"));
  assert.deepEqual(
    buildCorrelationKeys({ ...base, context: { channelId: "telegram", conversationId: "chat-a" } })[0],
    "exact|telegram|default|chat-a|42",
  );
});
