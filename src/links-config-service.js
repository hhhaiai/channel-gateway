import { createHash } from "node:crypto";

import { compileLinks } from "./route-links.js";

const LINK_KEYS = new Set(["id", "endpoints"]);
const ENDPOINT_KEYS = new Set([
  "id", "channel", "accountId", "conversationId", "to", "receive", "send", "threadId",
]);

export class ConfigConflictError extends Error {
  constructor() {
    super("links configuration changed; reload before saving");
    this.name = "ConfigConflictError";
    this.code = "CONFIG_CONFLICT";
  }
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function noUnknownKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${name} contains an unsupported field: ${key}`);
    }
  }
}

function canonicalLinks(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("links must be an array");
  }
  for (const link of value) {
    noUnknownKeys(object(link, "link"), LINK_KEYS, "link");
    if (!Array.isArray(link.endpoints)) {
      throw new TypeError("link endpoints must be an array");
    }
    for (const endpoint of link.endpoints) {
      noUnknownKeys(object(endpoint, "endpoint"), ENDPOINT_KEYS, "endpoint");
    }
  }
  return compileLinks(value).links;
}

function revision(links) {
  return createHash("sha256").update(JSON.stringify(links)).digest("hex");
}

function linksFrom(config) {
  return config?.plugins?.entries?.["channel-gateway"]?.config?.links ?? [];
}

function entryFrom(config) {
  const entry = config?.plugins?.entries?.["channel-gateway"];
  if (!entry?.enabled || !entry.config || typeof entry.config !== "object") {
    throw new TypeError("channel-gateway plugin configuration is unavailable");
  }
  return entry;
}

export function createLinksConfigService({ runtime }) {
  if (!runtime?.config || typeof runtime.config.current !== "function" ||
    typeof runtime.config.mutateConfigFile !== "function") {
    throw new TypeError("runtime.config must provide current and mutateConfigFile");
  }

  function read() {
    const links = canonicalLinks(linksFrom(runtime.config.current()));
    return { links, revision: revision(links), restartRequired: true };
  }

  async function update({ links, revision: expectedRevision } = {}) {
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      throw new TypeError("revision must be a SHA-256 hex digest");
    }
    const nextLinks = canonicalLinks(links);
    await runtime.config.mutateConfigFile({
      base: "source",
      afterWrite: {
        mode: "none",
        reason: "channel-gateway links require service restart",
      },
      mutate(draft) {
        const currentLinks = canonicalLinks(linksFrom(draft));
        if (revision(currentLinks) !== expectedRevision) {
          throw new ConfigConflictError();
        }
        entryFrom(draft).config.links = nextLinks;
      },
    });
    return { links: nextLinks, revision: revision(nextLinks), restartRequired: true };
  }

  return { read, update };
}
