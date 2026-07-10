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

function normalizeMediaList(plural, singular) {
  if (Array.isArray(plural)) {
    return plural;
  }

  return isEmpty(singular) ? [] : [singular];
}

function buildMedia(event) {
  const paths = normalizeMediaList(event.mediaPaths, event.mediaPath);
  const urls = normalizeMediaList(event.mediaUrls, event.mediaUrl);
  const types = normalizeMediaList(event.mediaTypes, event.mediaType);
  const length = Math.max(paths.length, urls.length, types.length);

  return Array.from({ length }, (_, index) => ({
    path: nullableString(paths[index]),
    url: nullableString(urls[index]),
    type: nullableString(types[index]),
  }));
}

function buildReplyTo(event, context) {
  const id = nullableString(firstNonEmpty(event.replyToId, context.replyToId));
  const idFull = nullableString(firstNonEmpty(event.replyToIdFull, context.replyToIdFull));
  const body = nullableString(firstNonEmpty(event.replyToBody, context.replyToBody));
  const sender = nullableString(firstNonEmpty(event.replyToSender, context.replyToSender));
  const isQuote = firstNonEmpty(event.replyToIsQuote, context.replyToIsQuote);

  if (id === null && idFull === null && body === null && sender === null && isQuote === undefined) {
    return null;
  }

  return {
    id,
    idFull,
    body,
    sender,
    isQuote: isQuote === undefined ? null : Boolean(isQuote),
  };
}

function buildMetadata(event) {
  let metadata = isPlainObject(event.metadata) ? cloneValue(event.metadata) : {};

  for (const field of PROVIDER_METADATA_FIELDS) {
    if (!isEmpty(event[field])) {
      metadata = mergeNonEmpty(metadata, { [field]: event[field] });
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

export function buildCorrelationKeys({ event = {}, context = {} } = {}) {
  const sourceEvent = event ?? {};
  const sourceContext = context ?? {};
  const channel = nullableString(
    firstNonEmpty(sourceEvent.channel, sourceEvent.channelId, sourceContext.channelId),
  );
  const accountId = nullableString(
    firstNonEmpty(sourceEvent.accountId, sourceContext.accountId),
  );
  const conversationId = nullableString(
    firstNonEmpty(
      sourceEvent.conversationId,
      sourceContext.conversationId,
      sourceEvent.from,
    ),
  );
  const sessionKey = nullableString(
    firstNonEmpty(sourceEvent.sessionKey, sourceContext.sessionKey),
  );
  const messageId = nullableString(
    firstNonEmpty(sourceEvent.messageId, sourceContext.messageId),
  );
  const senderId = nullableString(
    firstNonEmpty(
      sourceEvent.senderId,
      sourceEvent.sender?.id,
      sourceContext.senderId,
      sourceEvent.from,
    ),
  );
  const timestamp = normalizeTimestamp(
    firstNonEmpty(sourceEvent.timestamp, sourceEvent.receivedAt),
  );
  const content = nullableString(
    firstNonEmpty(
      sourceEvent.content,
      sourceEvent.text,
      sourceEvent.bodyForAgent,
      sourceEvent.body,
      sourceEvent.transcript,
    ),
  );
  const contentHash = content === null ? null : sha256(content);
  const keys = [];

  if (channel !== null && messageId !== null) {
    keys.push(`exact|${channel}|${accountId ?? ""}|${messageId}`);
  }

  if (
    sessionKey !== null &&
    timestamp !== null &&
    senderId !== null &&
    contentHash !== null
  ) {
    keys.push(`session|${sessionKey}|${timestamp}|${senderId}|${contentHash}`);
  }

  if (
    channel !== null &&
    conversationId !== null &&
    timestamp !== null &&
    contentHash !== null
  ) {
    keys.push(
      `conversation|${channel}|${accountId ?? ""}|${conversationId}|${timestamp}|${contentHash}`,
    );
  }

  return [...new Set(keys)];
}

export function normalizeInboundEvent({ event = {}, context = {}, enrichment = {} } = {}) {
  const enrichedEvent = mergeNonEmpty(event, enrichment);
  const channel = nullableString(
    firstNonEmpty(context.channelId, enrichedEvent.channel, enrichedEvent.channelId),
  );
  const accountId = nullableString(firstNonEmpty(context.accountId, enrichedEvent.accountId));
  const conversationId = nullableString(
    firstNonEmpty(context.conversationId, enrichedEvent.conversationId, enrichedEvent.from),
  );
  const sessionKey = nullableString(
    firstNonEmpty(context.sessionKey, enrichedEvent.sessionKey),
  );
  const messageId = nullableString(
    firstNonEmpty(enrichedEvent.messageId, context.messageId),
  );
  const senderId = nullableString(
    firstNonEmpty(enrichedEvent.senderId, context.senderId, enrichedEvent.from),
  );
  const receivedAt = normalizeTimestamp(enrichedEvent.timestamp);
  const text = nullableString(
    firstNonEmpty(
      enrichedEvent.content,
      enrichedEvent.bodyForAgent,
      enrichedEvent.body,
      enrichedEvent.transcript,
    ),
  );

  return {
    id: createEventId({
      channel,
      accountId,
      conversationId,
      messageId,
      senderId,
      text,
      receivedAt,
    }),
    channel,
    accountId,
    conversationId,
    sessionKey,
    messageId,
    sender: {
      id: senderId,
      name: nullableString(enrichedEvent.senderName),
      username: nullableString(enrichedEvent.senderUsername),
    },
    text,
    threadId: nullableString(enrichedEvent.threadId),
    replyTo: buildReplyTo(enrichedEvent, context),
    media: buildMedia(enrichedEvent),
    isGroup: Boolean(enrichedEvent.isGroup),
    metadata: buildMetadata(enrichedEvent),
    receivedAt,
  };
}
