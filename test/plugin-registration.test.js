import assert from "node:assert/strict";
import test from "node:test";

import { createChannelGatewayPlugin } from "../src/plugin.js";

function createApi({ registrationMode = "full", pluginConfig = {}, runtime }) {
  const hooks = new Map();
  const routes = [];
  const lifecycles = [];
  return {
    api: {
      registrationMode,
      pluginConfig,
      config: { gateway: { port: 18789 } },
      runtime: {
        config: {
          current: () => ({ plugins: { entries: { "channel-gateway": { enabled: true, config: { links: [] } } } } }),
          async mutateConfigFile() { return { persistedHash: "test" }; },
        },
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      on(name, handler, options) {
        hooks.set(name, { handler, options });
      },
      registerHttpRoute(route) {
        routes.push(route);
      },
      lifecycle: {
        registerRuntimeLifecycle(lifecycle) {
          lifecycles.push(lifecycle);
        },
      },
    },
    hooks,
    routes,
    lifecycles,
    runtime,
  };
}

function fakeRuntime() {
  return {
    started: 0,
    closed: 0,
    onMessageReceived() {},
    onBeforeDispatch() {
      return { handled: true };
    },
    handleHttp() {},
    start() {
      this.started += 1;
    },
    close() {
      this.closed += 1;
    },
  };
}

test("registers typed hooks and starts the worker only after Gateway startup", () => {
  const runtime = fakeRuntime();
  let receivedOptions;
  const plugin = createChannelGatewayPlugin({
    dispatchGatewayMethod: async () => ({ ok: true, payload: {} }),
    runtimeFactory(options) {
      receivedOptions = options;
      return runtime;
    },
    env: { OPENCLAW_GATEWAY_TOKEN: "secret" },
  });
  const fixture = createApi({
    pluginConfig: {
      databasePath: ":memory:",
      links: [
        {
          id: "room",
          endpoints: [
            { id: "tg", channel: "telegram", conversationId: "tg", to: "tg" },
            { id: "fs", channel: "feishu", conversationId: "fs", to: "fs" },
          ],
        },
      ],
    },
  });

  const registerResult = plugin.register(fixture.api);

  assert.equal(registerResult, undefined);
  assert.deepEqual([...fixture.hooks.keys()], [
    "message_received",
    "before_dispatch",
    "gateway_start",
  ]);
  assert.equal(fixture.hooks.get("message_received").options.priority, 100);
  assert.equal(fixture.hooks.get("before_dispatch").options.timeoutMs, 5_000);
  assert.equal(fixture.routes.length, 2);
  assert.equal(fixture.routes[0].path, "/api/v1");
  assert.equal(fixture.routes[0].auth, "gateway");
  assert.equal(fixture.routes[0].match, "prefix");
  assert.equal(fixture.routes[0].gatewayRuntimeScopeSurface, "trusted-operator");
  assert.equal(fixture.routes[0].handler, runtime.handleHttp);
  assert.equal(fixture.routes[1].path, "/channel-gateway");
  assert.equal(fixture.routes[1].auth, "plugin");
  assert.equal(fixture.routes[1].match, "prefix");
  assert.equal(typeof fixture.routes[1].handler, "function");
  assert.equal(typeof receivedOptions.configService.read, "function");
  assert.equal(fixture.lifecycles[0].id, "channel-gateway");
  assert.equal(runtime.started, 0);
  fixture.hooks.get("gateway_start").handler({}, {});
  assert.equal(runtime.started, 1);
  assert.equal(receivedOptions.sender instanceof Function, true);
});

test("does not construct runtime outside full registration mode", () => {
  let constructed = 0;
  const plugin = createChannelGatewayPlugin({
    dispatchGatewayMethod: async () => ({ ok: true, payload: {} }),
    runtimeFactory() {
      constructed += 1;
      return fakeRuntime();
    },
  });
  const fixture = createApi({ registrationMode: "setup" });

  plugin.register(fixture.api);

  assert.equal(constructed, 0);
  assert.equal(fixture.hooks.size, 0);
  assert.equal(fixture.routes.length, 0);
});

test("allows event-only service without a loopback token when links are empty", () => {
  let receivedOptions;
  const plugin = createChannelGatewayPlugin({
    dispatchGatewayMethod: async () => ({ ok: true, payload: {} }),
    runtimeFactory(options) {
      receivedOptions = options;
      return fakeRuntime();
    },
    env: {},
  });
  const fixture = createApi({ pluginConfig: { databasePath: ":memory:", links: [] } });

  plugin.register(fixture.api);

  assert.equal(receivedOptions.sender, undefined);
});

test("requires a loopback token when automatic links are configured", () => {
  const plugin = createChannelGatewayPlugin({
    dispatchGatewayMethod: async () => ({ ok: true, payload: {} }),
    runtimeFactory: () => fakeRuntime(),
    env: {},
  });
  const fixture = createApi({
    pluginConfig: {
      databasePath: ":memory:",
      links: [
        {
          id: "room",
          endpoints: [
            { id: "a", channel: "telegram", conversationId: "a", to: "a" },
            { id: "b", channel: "feishu", conversationId: "b", to: "b" },
          ],
        },
      ],
    },
  });

  assert.throws(() => plugin.register(fixture.api), /OPENCLAW_GATEWAY_TOKEN/);
});
