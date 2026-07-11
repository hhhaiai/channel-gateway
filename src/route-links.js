import { createHash } from "node:crypto";

const MARKER_PREFIX = "\u2063cg1:";
const MARKER_SUFFIX = "\u2063";
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function nonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(name, value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return nonEmptyString(name, value);
}

function optionalBoolean(name, value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

function endpointMatchKey({ channel, accountId, conversationId }) {
  return JSON.stringify([channel, accountId, conversationId]);
}

function conversationOwnerKey({ channel, conversationId }) {
  return JSON.stringify([channel, conversationId]);
}

function outboundTargetKey({ channel, accountId, to }) {
  return JSON.stringify([channel, accountId, to]);
}

function normalizeEndpoint(endpoint, linkId) {
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    throw new TypeError(`endpoint in link ${linkId} must be an object`);
  }

  return {
    id: nonEmptyString("endpoint id", endpoint.id),
    channel: nonEmptyString("endpoint channel", endpoint.channel),
    accountId: optionalString("endpoint accountId", endpoint.accountId) ?? "default",
    conversationId: nonEmptyString("endpoint conversationId", endpoint.conversationId),
    to: nonEmptyString("endpoint to", endpoint.to),
    receive: optionalBoolean("endpoint receive", endpoint.receive, true),
    send: optionalBoolean("endpoint send", endpoint.send, true),
    threadId: optionalString("endpoint threadId", endpoint.threadId),
  };
}

function deliveryIdFor(eventId, linkId, destinationEndpointId) {
  const fingerprint = `v1|${eventId}|${linkId}|${destinationEndpointId}`;
  const digest = createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  return `dlv_${digest}`;
}

function senderLabel(event) {
  return event.sender?.name || event.sender?.id || "unknown";
}

function visibleMessage(event) {
  const prefix = `[${event.channel}/${senderLabel(event)}]`;
  const text = typeof event.text === "string" ? event.text : "";
  return text.trim() === "" ? prefix : `${prefix} ${text}`;
}

function mediaUrls(event) {
  if (!Array.isArray(event.media)) {
    return [];
  }

  return event.media
    .map((media) => media?.url || media?.path)
    .filter((value) => typeof value === "string" && value !== "");
}

export function compileLinks(input) {
  if (!Array.isArray(input)) {
    throw new TypeError("links must be an array");
  }

  const linkIds = new Set();
  const sourceIndex = new Map();
  const conversationOwners = new Map();
  const outboundIndex = new Set();
  const links = input.map((link) => {
    if (!link || typeof link !== "object" || Array.isArray(link)) {
      throw new TypeError("link must be an object");
    }

    const id = nonEmptyString("link id", link.id);
    if (linkIds.has(id)) {
      throw new TypeError(`duplicate link id: ${id}`);
    }
    linkIds.add(id);

    if (!Array.isArray(link.endpoints) || link.endpoints.length < 2) {
      throw new TypeError(`link ${id} must contain at least two endpoints`);
    }

    const endpointIds = new Set();
    const endpoints = link.endpoints.map((endpoint) => {
      const normalized = normalizeEndpoint(endpoint, id);
      if (endpointIds.has(normalized.id)) {
        throw new TypeError(`duplicate endpoint id in link ${id}: ${normalized.id}`);
      }
      endpointIds.add(normalized.id);

      const matchKey = endpointMatchKey(normalized);
      if (sourceIndex.has(matchKey)) {
        throw new TypeError(`duplicate endpoint match: ${normalized.channel}/${normalized.accountId}/${normalized.conversationId}`);
      }
      const ownerKey = conversationOwnerKey(normalized);
      const existingOwner = conversationOwners.get(ownerKey);
      if (existingOwner && existingOwner !== normalized.accountId) {
        throw new TypeError(
          `conversation already owned by another bot account: ${normalized.channel}/${normalized.conversationId}`,
        );
      }
      sourceIndex.set(matchKey, { linkId: id, endpointId: normalized.id });
      conversationOwners.set(ownerKey, normalized.accountId);

      const outboundKey = outboundTargetKey(normalized);
      if (outboundIndex.has(outboundKey)) {
        throw new TypeError(`duplicate outbound target: ${normalized.channel}/${normalized.accountId}/${normalized.to}`);
      }
      outboundIndex.add(outboundKey);
      return normalized;
    });

    return { id, endpoints };
  });

  const byId = new Map(links.map((link) => [link.id, link]));
  return { links, byId, sourceIndex };
}

export function matchSourceEndpoints(event, compiledLinks) {
  if (!compiledLinks?.sourceIndex || !compiledLinks?.byId) {
    throw new TypeError("links must be compiled with compileLinks");
  }

  const key = endpointMatchKey({
    channel: event?.channel,
    accountId: event?.accountId || "default",
    conversationId: event?.conversationId,
  });
  const match = compiledLinks.sourceIndex.get(key);
  if (!match) {
    return [];
  }

  const link = compiledLinks.byId.get(match.linkId);
  const endpoint = link.endpoints.find((candidate) => candidate.id === match.endpointId);
  return endpoint.receive ? [{ link, endpoint }] : [];
}

export function appendBridgeMarker(text, deliveryId) {
  if (!DELIVERY_ID_PATTERN.test(deliveryId)) {
    throw new TypeError("deliveryId must contain only letters, numbers, underscores, or hyphens");
  }
  return `${String(text ?? "")}${MARKER_PREFIX}${deliveryId}${MARKER_SUFFIX}`;
}

export function stripBridgeMarker(text) {
  const value = String(text ?? "");
  const match = value.match(/\u2063cg1:([A-Za-z0-9_-]{1,128})\u2063$/u);
  if (!match) {
    return { text: value, deliveryId: null };
  }

  return {
    text: value.slice(0, match.index),
    deliveryId: match[1],
  };
}

export function planFanout({ event, links, replyTargets = new Map() }) {
  const matches = matchSourceEndpoints(event, links);
  const jobs = [];

  for (const { link, endpoint: source } of matches) {
    for (const destination of link.endpoints) {
      if (destination.id === source.id || !destination.send) {
        continue;
      }

      const id = deliveryIdFor(event.id, link.id, destination.id);
      const replyToId = replyTargets.get(destination.id);
      const request = {
        channel: destination.channel,
        accountId: destination.accountId,
        to: destination.to,
        message: appendBridgeMarker(visibleMessage(event), id),
        mediaUrls: mediaUrls(event),
        idempotencyKey: id,
        ...(replyToId ? { replyToId } : {}),
        ...(destination.threadId ? { threadId: destination.threadId } : {}),
      };

      jobs.push({
        id,
        eventId: event.id,
        linkId: link.id,
        sourceEndpointId: source.id,
        destinationEndpointId: destination.id,
        destinationChannel: destination.channel,
        destinationAccountId: destination.accountId,
        destinationConversationId: destination.conversationId,
        idempotencyKey: id,
        request,
      });
    }
  }

  return jobs;
}
