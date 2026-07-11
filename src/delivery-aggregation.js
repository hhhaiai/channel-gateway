import { appendBridgeMarker, stripBridgeMarker } from "./route-links.js";

function integer(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function validateDeliveryAggregation({
  enabled = false,
  windowMs = 1_000,
  maxItems = 20,
  maxBytes = 32_768,
} = {}) {
  if (typeof enabled !== "boolean") {
    throw new TypeError("enabled must be a boolean");
  }
  return {
    enabled,
    windowMs: integer("windowMs", windowMs, 100, 60_000),
    maxItems: integer("maxItems", maxItems, 2, 100),
    maxBytes: integer("maxBytes", maxBytes, 1_024, 262_144),
  };
}

export function isAggregationCompatible(request) {
  return Boolean(
    request &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    typeof request.message === "string" &&
    request.replyToId === undefined &&
    (!Array.isArray(request.mediaUrls) || request.mediaUrls.length === 0),
  );
}

function sameTarget(left, right) {
  return left.channel === right.channel &&
    (left.accountId ?? "default") === (right.accountId ?? "default") &&
    left.to === right.to &&
    (left.threadId ?? null) === (right.threadId ?? null);
}

export function aggregateDeliveryRequests(requests, {
  aggregateId,
  maxItems,
  maxBytes,
}) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new TypeError("requests must be a non-empty array");
  }
  integer("maxItems", maxItems, 1, 100);
  integer("maxBytes", maxBytes, 1, 262_144);
  const first = requests[0];
  if (!isAggregationCompatible(first)) {
    throw new TypeError("first request is not aggregation compatible");
  }

  const messages = [];
  const memberIds = [];
  for (const request of requests) {
    if (
      messages.length >= maxItems ||
      !isAggregationCompatible(request) ||
      !sameTarget(first, request)
    ) break;
    const message = stripBridgeMarker(request.message).text;
    const candidate = appendBridgeMarker([...messages, message].join("\n"), aggregateId);
    if (Buffer.byteLength(candidate) > maxBytes) break;
    messages.push(message);
    memberIds.push(request.idempotencyKey);
  }
  if (messages.length === 0) {
    throw new RangeError("first request exceeds aggregation maxBytes");
  }
  const message = appendBridgeMarker(messages.join("\n"), aggregateId);
  return {
    request: {
      ...first,
      message,
      idempotencyKey: aggregateId,
    },
    memberIds,
    items: memberIds.length,
    bytes: Buffer.byteLength(message),
  };
}
