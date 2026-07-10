import { createHash } from "node:crypto";

import {
  EVENT_FINGERPRINT_VERSION,
  EVENT_ID_PREFIX,
  PROVIDER_METADATA_FIELDS,
} from "./constants.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmpty(value) {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim().length === 0;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (isPlainObject(value)) {
    return Object.keys(value).length === 0;
  }

  return false;
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, cloneValue(nestedValue)]),
    );
  }

  return value;
}

export function mergeNonEmpty(existing, incoming) {
  if (!isPlainObject(existing) || !isPlainObject(incoming)) {
    return isEmpty(existing) && !isEmpty(incoming)
      ? cloneValue(incoming)
      : cloneValue(existing);
  }

  const merged = cloneValue(existing);

  for (const [key, incomingValue] of Object.entries(incoming)) {
    const existingValue = merged[key];

    if (isPlainObject(existingValue) && isPlainObject(incomingValue)) {
      merged[key] = mergeNonEmpty(existingValue, incomingValue);
    } else if (isEmpty(existingValue) && !isEmpty(incomingValue)) {
      merged[key] = cloneValue(incomingValue);
    }
  }

  return merged;
}

function firstNonEmpty(...values) {
  return values.find((value) => !isEmpty(value));
}

function nullableString(value) {
  return isEmpty(value) ? null : String(value);
}

function normalizeTimestamp(value) {
  if (isEmpty(value)) {
    return null;
  }

  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeMediaList(plural, singular, metadataPlural, metadataSingular) {
  const pluralValue = firstNonEmpty(plural, metadataPlural);
  if (Array.isArray(pluralValue)) {
    return pluralValue;
  }

  const singularValue = firstNonEmpty(singular, metadataSingular);
  return isEmpty(singularValue) ? [] : [singularValue];
}

function buildMedia(event, metadata) {
  const paths = normalizeMediaList(
    event.mediaPaths,
    event.mediaPath,
    metadata.mediaPaths,
    metadata.mediaPath,
  );
  const urls = normalizeMediaList(
    event.mediaUrls,
    event.mediaUrl,
    metadata.mediaUrls,
    metadata.mediaUrl,
  );
  const types = normalizeMediaList(
    event.mediaTypes,
    event.mediaType,
    metadata.mediaTypes,
    metadata.mediaType,
  );
  const length = Math.max(paths.length, urls.length, types.length);

  return Array.from({ length }, (_, index) => ({
    path: nullableString(paths[index]),
    url: nullableString(urls[index]),
    mimeType: nullableString(types[index]),
  }));
}

function buildReplyTo(event, context, metadata) {
  const id = nullableString(
    firstNonEmpty(
      event.replyToId,
      context.replyToId,
      metadata.replyToId,
      event.replyToIdFull,
      context.replyToIdFull,
      metadata.replyToIdFull,
    ),
  );
  const text = nullableString(
    firstNonEmpty(
      event.replyToBody,
      context.replyToBody,
      metadata.replyToBody,
      metadata.replyToText,
    ),
  );
  const sender = nullableString(
    firstNonEmpty(event.replyToSender, context.replyToSender, metadata.replyToSender),
  );

  if (id === null && text === null && sender === null) {
    return null;
  }

  return { id, text, sender };
}

function buildMetadata(event, context) {
  let metadata = mergeNonEmpty(
    isPlainObject(event.metadata) ? event.metadata : {},
    isPlainObject(context.metadata) ? context.metadata : {},
  );

  for (const field of PROVIDER_METADATA_FIELDS) {
    const value = firstNonEmpty(event[field], context[field]);
    if (!isEmpty(value)) {
      metadata = mergeNonEmpty(metadata, { [field]: value });
    }
  }

  return metadata;
}

function createEventId({
  channel,
  accountId,
  conversationId,
  messageId,
  senderId,
  text,
  receivedAt,
}) {
  const fingerprint = messageId
    ? [EVENT_FINGERPRINT_VERSION, channel ?? "", accountId ?? "", messageId].join("|")
    : [
        EVENT_FINGERPRINT_VERSION,
        channel ?? "",
        accountId ?? "",
        conversationId ?? "",
        senderId ?? "",
        receivedAt ?? "",
        sha256(text ?? ""),
      ].join("|");

  return `${EVENT_ID_PREFIX}${sha256(fingerprint).slice(0, 32)}`;
}

function splitEnrichment(enrichment) {
  if (!isPlainObject(enrichment)) {
    return { event: {}, context: {} };
  }

  if (!isPlainObject(enrichment.event) && !isPlainObject(enrichment.context)) {
    return { event: enrichment, context: {} };
  }

  const { event, context, ...flatEvent } = enrichment;
  return {
    event: mergeNonEmpty(isPlainObject(event) ? event : {}, flatEvent),
    context: isPlainObject(context) ? cloneValue(context) : {},
  };
}

function readClock(clock) {
  if (typeof clock === "function") {
    return clock();
  }

  if (isPlainObject(clock) && typeof clock.now === "function") {
    return clock.now();
  }

  return clock;
}

function resolveReceivedAt(timestamp, clock) {
  const timestampMs = normalizeTimestamp(timestamp);
  const clockMs = timestampMs === null ? normalizeTimestamp(readClock(clock)) : null;
  const fallbackMs = timestampMs ?? clockMs ?? Date.now();
  const date = new Date(fallbackMs);

  if (Number.isNaN(date.getTime())) {
    const currentMs = Date.now();
    return { timestampMs: currentMs, iso: new Date(currentMs).toISOString() };
  }

  return { timestampMs: fallbackMs, iso: date.toISOString() };
}

function resolveCoreFields(event, context, metadata = {}) {
  const metadataSender = isPlainObject(metadata.sender) ? metadata.sender : {};

  return {
    channel: nullableString(
      firstNonEmpty(context.channelId, event.channel, event.channelId),
    ),
    accountId:
      nullableString(firstNonEmpty(context.accountId, event.accountId)) ?? "default",
    conversationId: nullableString(
      firstNonEmpty(
        context.conversationId,
        event.conversationId,
        metadata.originatingTo,
        event.from,
      ),
    ),
    sessionKey: nullableString(firstNonEmpty(context.sessionKey, event.sessionKey)),
    senderId: nullableString(
      firstNonEmpty(
        event.senderId,
        event.sender?.id,
        context.senderId,
        metadata.senderId,
        metadataSender.id,
        event.from,
      ),
    ),
    text:
      nullableString(
        firstNonEmpty(
          event.content,
          event.text,
          event.bodyForAgent,
          event.body,
          event.transcript,
        ),
      ) ?? "",
  };
}

export function buildCorrelationKeys({ event = {}, context = {} } = {}) {
  const sourceEvent = event ?? {};
  const sourceContext = context ?? {};
  const metadata = buildMetadata(sourceEvent, sourceContext);
  const { channel, accountId, conversationId, sessionKey, senderId, text } =
    resolveCoreFields(sourceEvent, sourceContext, metadata);
  const messageId = nullableString(
    firstNonEmpty(sourceEvent.messageId, sourceContext.messageId),
  );
  const timestamp = normalizeTimestamp(
    firstNonEmpty(sourceEvent.timestamp, sourceEvent.receivedAt),
  );
  const contentHash = sha256(text);
  const keys = [];

  if (channel !== null && messageId !== null) {
    keys.push(`exact|${channel}|${accountId}|${messageId}`);
  }

  if (sessionKey !== null && timestamp !== null && senderId !== null) {
    keys.push(`session|${sessionKey}|${timestamp}|${senderId}|${contentHash}`);
  }

  if (channel !== null && conversationId !== null && timestamp !== null) {
    keys.push(
      `conversation|${channel}|${accountId}|${conversationId}|${timestamp}|${contentHash}`,
    );
  }

  return [...new Set(keys)];
}

export function normalizeInboundEvent(options = {}) {
  const source = options ?? {};
  const {
    event = {},
    context = {},
    enrichment = {},
    now = Date.now,
    clock = now,
  } = source;
  const split = splitEnrichment(enrichment);
  const enrichedEvent = mergeNonEmpty(isPlainObject(event) ? event : {}, split.event);
  const enrichedContext = mergeNonEmpty(
    isPlainObject(context) ? context : {},
    split.context,
  );
  const metadata = buildMetadata(enrichedEvent, enrichedContext);
  const { channel, accountId, conversationId, sessionKey, senderId, text } =
    resolveCoreFields(enrichedEvent, enrichedContext, metadata);
  const messageId = nullableString(
    firstNonEmpty(enrichedEvent.messageId, enrichedContext.messageId),
  );
  const metadataSender = isPlainObject(metadata.sender) ? metadata.sender : {};
  const { timestampMs, iso: receivedAt } = resolveReceivedAt(enrichedEvent.timestamp, clock);
  const explicitIsGroup = firstNonEmpty(enrichedEvent.isGroup, metadata.isGroup);

  return {
    id: createEventId({
      channel,
      accountId,
      conversationId,
      messageId,
      senderId,
      text,
      receivedAt: timestampMs,
    }),
    channel,
    accountId,
    conversationId,
    sessionKey,
    messageId,
    sender: {
      id: senderId,
      name: nullableString(
        firstNonEmpty(enrichedEvent.senderName, metadata.senderName, metadataSender.name),
      ),
      username: nullableString(
        firstNonEmpty(
          enrichedEvent.senderUsername,
          metadata.senderUsername,
          metadataSender.username,
        ),
      ),
    },
    text,
    threadId: nullableString(firstNonEmpty(enrichedEvent.threadId, metadata.threadId)),
    replyTo: buildReplyTo(enrichedEvent, enrichedContext, metadata),
    media: buildMedia(enrichedEvent, metadata),
    isGroup:
      explicitIsGroup === undefined ? !isEmpty(metadata.groupId) : Boolean(explicitIsGroup),
    metadata,
    receivedAt,
  };
}
