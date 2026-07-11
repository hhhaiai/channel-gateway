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
    resourceProbe: () => ({
      cpuCount: 2,
      memoryLimitBytes: 4 * 1024 ** 3,
      memorySource: "host",
    }),
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
  assert.equal(receivedOptions.deliveryMaxConcurrency, 4);
  assert.equal(receivedOptions.deliveryMaxConcurrencyPerAccount, 2);
  assert.equal(receivedOptions.configService.read().effectiveDeliveryMaxConcurrency, 4);
  assert.equal(fixture.lifecycles[0].id, "channel-gateway");
  assert.equal(runtime.started, 0);
  fixture.hooks.get("gateway_start").handler({}, {});
  assert.equal(runtime.started, 1);
  assert.equal(receivedOptions.sender instanceof Function, true);
});

test("passes an explicit per-account delivery concurrency override", () => {
  let receivedOptions;
  const plugin = createChannelGatewayPlugin({
    dispatchGatewayMethod: async () => ({ ok: true, payload: {} }),
    runtimeFactory(options) {
      receivedOptions = options;
      return fakeRuntime();
    },
    resourceProbe: () => ({
      cpuCount: 2,
      memoryLimitBytes: 4 * 1024 ** 3,
      memorySource: "host",
    }),
    env: {},
  });
  const fixture = createApi({
    pluginConfig: {
      links: [],
      deliveryMaxConcurrencyPerAccount: 5,
    },
  });

  plugin.register(fixture.api);

  assert.equal(receivedOptions.deliveryMaxConcurrencyPerAccount, 5);
});

test("derives delivery concurrency from runtime-visible resources", () => {
  let receivedOptions;
  const plugin = createChannelGatewayPlugin({
    dispatchGatewayMethod: async () => ({ ok: true, payload: {} }),
    runtimeFactory(options) {
      receivedOptions = options;
      return fakeRuntime();
    },
    resourceProbe: () => ({
      cpuCount: 8,
      memoryLimitBytes: 8 * 1024 ** 3,
      memorySource: "constraint",
    }),
    env: {},
  });

  plugin.register(createApi({ pluginConfig: { links: [] } }).api);

  assert.equal(receivedOptions.deliveryMaxConcurrency, 16);
});

test("lets the environment override detected delivery concurrency", () => {
  let receivedOptions;
  const plugin = createChannelGatewayPlugin({
    dispatchGatewayMethod: async () => ({ ok: true, payload: {} }),
    runtimeFactory(options) {
      receivedOptions = options;
      return fakeRuntime();
    },
    resourceProbe: () => ({
      cpuCount: 1,
      memoryLimitBytes: 256 * 1024 ** 2,
      memorySource: "constraint",
    }),
    env: { CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY: "9" },
  });

  plugin.register(createApi({ pluginConfig: { links: [] } }).api);

  assert.equal(receivedOptions.deliveryMaxConcurrency, 9);
});

test("passes an explicit delivery concurrency override to the runtime", () => {
  let receivedOptions;
  const plugin = createChannelGatewayPlugin({
    dispatchGatewayMethod: async () => ({ ok: true, payload: {} }),
    runtimeFactory(options) {
      receivedOptions = options;
      return fakeRuntime();
    },
    resourceProbe: () => ({
      cpuCount: 1,
      memoryLimitBytes: 256 * 1024 ** 2,
      memorySource: "constraint",
    }),
    env: { CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY: "8" },
  });
  const fixture = createApi({
    pluginConfig: {
      databasePath: ":memory:",
      links: [],
      deliveryMaxConcurrency: 12,
    },
  });

  plugin.register(fixture.api);

  assert.equal(receivedOptions.deliveryMaxConcurrency, 12);
});

test("rejects invalid environment concurrency before runtime construction", () => {
  let constructed = 0;
  const plugin = createChannelGatewayPlugin({
    dispatchGatewayMethod: async () => ({ ok: true, payload: {} }),
    runtimeFactory() {
      constructed += 1;
      return fakeRuntime();
    },
    resourceProbe: () => ({
      cpuCount: 2,
      memoryLimitBytes: 4 * 1024 ** 3,
      memorySource: "host",
    }),
    env: { CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY: "unbounded" },
  });

  assert.throws(
    () => plugin.register(createApi({ pluginConfig: { links: [] } }).api),
    /CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY/,
  );
  assert.equal(constructed, 0);
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
