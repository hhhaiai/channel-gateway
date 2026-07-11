import { createHash } from "node:crypto";

import {
  DELIVERY_CONCURRENCY_AUTO_MAX,
  DELIVERY_CONCURRENCY_HARD_MAX,
  resolveDeliveryMaxConcurrency,
} from "./resource-limits.js";
import { compileLinks } from "./route-links.js";

const LINK_KEYS = new Set(["id", "endpoints"]);
const ENDPOINT_KEYS = new Set([
  "id", "channel", "accountId", "conversationId", "to", "receive", "send", "threadId",
]);

export class ConfigConflictError extends Error {
  constructor() {
    super("channel-gateway configuration changed; reload before saving");
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

function revision(configuration) {
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

function entryFrom(config) {
  const entry = config?.plugins?.entries?.["channel-gateway"];
  if (!entry?.enabled || !entry.config || typeof entry.config !== "object") {
    throw new TypeError("channel-gateway plugin configuration is unavailable");
  }
  return entry;
}

function editableConfiguration(config) {
  const entry = entryFrom(config);
  return {
    links: canonicalLinks(entry.config.links ?? []),
    deliveryMaxConcurrency: entry.config.deliveryMaxConcurrency ?? null,
  };
}

export function createLinksConfigService({ runtime, env = process.env, resources }) {
  if (!runtime?.config || typeof runtime.config.current !== "function" ||
    typeof runtime.config.mutateConfigFile !== "function") {
    throw new TypeError("runtime.config must provide current and mutateConfigFile");
  }

  function present(configuration) {
    const resolved = resolveDeliveryMaxConcurrency({
      configured: configuration.deliveryMaxConcurrency ?? undefined,
      env,
      resources,
    });
    return {
      ...configuration,
      effectiveDeliveryMaxConcurrency: resolved.value,
      deliveryMaxConcurrencySource: resolved.source,
      deliveryMaxConcurrencyHardMax: DELIVERY_CONCURRENCY_HARD_MAX,
      deliveryMaxConcurrencyAutoMax: DELIVERY_CONCURRENCY_AUTO_MAX,
      resources: { ...resolved.resources },
      revision: revision(configuration),
      restartRequired: true,
    };
  }

  function read() {
    return present(editableConfiguration(runtime.config.current()));
  }

  async function update(input = {}) {
    const { links, revision: expectedRevision } = input;
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      throw new TypeError("revision must be a SHA-256 hex digest");
    }
    const nextLinks = canonicalLinks(links);
    const updatesConcurrency = Object.hasOwn(input, "deliveryMaxConcurrency");
    const requestedConcurrency = input.deliveryMaxConcurrency;
    if (updatesConcurrency && requestedConcurrency !== null) {
      resolveDeliveryMaxConcurrency({
        configured: requestedConcurrency,
        env,
        resources,
      });
    }
    let nextConfiguration;
    await runtime.config.mutateConfigFile({
      base: "source",
      afterWrite: {
        mode: "none",
        reason: "channel-gateway configuration requires service restart",
      },
      mutate(draft) {
        const current = editableConfiguration(draft);
        if (revision(current) !== expectedRevision) {
          throw new ConfigConflictError();
        }
        const entry = entryFrom(draft);
        entry.config.links = nextLinks;
        if (updatesConcurrency) {
          if (requestedConcurrency === null) {
            delete entry.config.deliveryMaxConcurrency;
          } else {
            entry.config.deliveryMaxConcurrency = requestedConcurrency;
          }
        }
        nextConfiguration = editableConfiguration(draft);
      },
    });
    return present(nextConfiguration);
  }

  return { read, update };
}
