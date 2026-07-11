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

function fixture(config = structuredClone(INITIAL)) {
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
  return { service: createLinksConfigService({ runtime }), calls, get config() { return config; } };
}

test("returns a full editable link configuration with a stable revision", () => {
  const state = fixture();
  const result = state.service.read();

  assert.equal(result.links[0].endpoints[1].to, "-1001");
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.restartRequired, true);
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
    reason: "channel-gateway links require service restart",
  });
  assert.equal(state.config.gateway.port, 18789);
  assert.equal(state.config.plugins.entries["channel-gateway"].config.databasePath, "/tmp/gateway.sqlite");
  assert.equal(state.config.plugins.entries["channel-gateway"].config.links[0].endpoints.length, 3);
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
