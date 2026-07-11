import assert from "node:assert/strict";
import test from "node:test";

import { ConfigConflictError, createLinksConfigService } from "../src/links-config-service.js";

const INITIAL = {
  gateway: { port: 18789 },
  plugins: {
    entries: {
      "channel-gateway": {
        enabled: true,
        config: {
          databasePath: "/tmp/gateway.sqlite",
          links: [{
            id: "main",
            endpoints: [
              { id: "qq", channel: "qqbot", conversationId: "qq-1", to: "qq-1" },
              { id: "tg", channel: "telegram", conversationId: "tg-1", to: "-1001" },
            ],
          }],
        },
      },
    },
  },
};

function fixture(
  config = structuredClone(INITIAL),
  {
    env = {},
    resources = {
      cpuCount: 2,
      memoryLimitBytes: 4 * 1024 ** 3,
      memorySource: "host",
    },
  } = {},
) {
  const calls = [];
  const runtime = {
    config: {
      current: () => config,
      async mutateConfigFile(params) {
        calls.push(params);
        const draft = structuredClone(config);
        await params.mutate(draft, { previousHash: "host-hash" });
        config = draft;
        return { persistedHash: "host-hash-next" };
      },
    },
  };
  return {
    service: createLinksConfigService({ runtime, env, resources }),
    calls,
    get config() { return config; },
  };
}

test("returns a full editable link configuration with a stable revision", () => {
  const state = fixture();
  const result = state.service.read();

  assert.equal(result.links[0].endpoints[1].to, "-1001");
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.restartRequired, true);
  assert.equal(result.deliveryMaxConcurrency, null);
  assert.equal(result.effectiveDeliveryMaxConcurrency, 4);
  assert.equal(result.deliveryMaxConcurrencySource, "detected");
  assert.equal(result.deliveryMaxConcurrencyHardMax, 256);
  assert.equal(result.deliveryMaxConcurrencyAutoMax, 8);
  assert.deepEqual(result.resources, {
    cpuCount: 2,
    memoryLimitBytes: 4 * 1024 ** 3,
    memorySource: "host",
  });
});

test("mutates only links through the Host source-config writer", async () => {
  const state = fixture();
  const before = state.service.read();
  const links = structuredClone(before.links);
  links[0].endpoints.push({
    id: "tg-2", channel: "telegram", conversationId: "tg-2", to: "-1002",
  });

  const result = await state.service.update({ links, revision: before.revision });

  assert.equal(result.links[0].endpoints.length, 3);
  assert.equal(result.revision, state.service.read().revision);
  assert.equal(result.restartRequired, true);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].base, "source");
  assert.deepEqual(state.calls[0].afterWrite, {
    mode: "none",
    reason: "channel-gateway configuration requires service restart",
  });
  assert.equal(state.config.gateway.port, 18789);
  assert.equal(state.config.plugins.entries["channel-gateway"].config.databasePath, "/tmp/gateway.sqlite");
  assert.equal(state.config.plugins.entries["channel-gateway"].config.links[0].endpoints.length, 3);
  assert.equal(
    Object.hasOwn(state.config.plugins.entries["channel-gateway"].config, "deliveryMaxConcurrency"),
    false,
  );
});

test("persists and clears a bounded delivery concurrency override", async () => {
  const state = fixture();
  const before = state.service.read();

  const configured = await state.service.update({
    links: before.links,
    revision: before.revision,
    deliveryMaxConcurrency: 12,
  });

  assert.equal(configured.deliveryMaxConcurrency, 12);
  assert.equal(configured.effectiveDeliveryMaxConcurrency, 12);
  assert.equal(configured.deliveryMaxConcurrencySource, "config");
  assert.equal(
    state.config.plugins.entries["channel-gateway"].config.deliveryMaxConcurrency,
    12,
  );

  const automatic = await state.service.update({
    links: configured.links,
    revision: configured.revision,
    deliveryMaxConcurrency: null,
  });

  assert.equal(automatic.deliveryMaxConcurrency, null);
  assert.equal(automatic.effectiveDeliveryMaxConcurrency, 4);
  assert.equal(automatic.deliveryMaxConcurrencySource, "detected");
  assert.equal(
    Object.hasOwn(state.config.plugins.entries["channel-gateway"].config, "deliveryMaxConcurrency"),
    false,
  );
});

test("reports an environment-derived value after clearing the config override", async () => {
  const config = structuredClone(INITIAL);
  config.plugins.entries["channel-gateway"].config.deliveryMaxConcurrency = 12;
  const state = fixture(config, {
    env: { CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY: "7" },
  });
  const before = state.service.read();

  const result = await state.service.update({
    links: before.links,
    revision: before.revision,
    deliveryMaxConcurrency: null,
  });

  assert.equal(result.effectiveDeliveryMaxConcurrency, 7);
  assert.equal(result.deliveryMaxConcurrencySource, "environment");
});

test("rejects a stale links revision without changing config", async () => {
  const state = fixture();
  const before = structuredClone(state.service.read().links);

  await assert.rejects(
    state.service.update({ links: before, revision: "0".repeat(64) }),
    ConfigConflictError,
  );
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.config, INITIAL);
});
