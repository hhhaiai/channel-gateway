import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { createBridgeRuntime } from "./bridge-runtime.js";
import { createConsoleAssetsHandler } from "./console-assets.js";
import { createLinksConfigService } from "./links-config-service.js";
import {
  detectRuntimeResources,
  resolveDeliveryMaxConcurrency,
} from "./resource-limits.js";
import { createSelfApiSender } from "./self-api-sender.js";

const DEFAULT_CONFIG = Object.freeze({
  databasePath: ".channel-gateway/channel-gateway.sqlite",
  links: [],
  correlationTtlMs: 30_000,
  maxCorrelationEntries: 10_000,
  ackTtlMs: 300_000,
  failedTtlMs: 86_400_000,
  deliveryPollMs: 1_000,
  deliveryMaxAttempts: 5,
  deliveryLeaseMs: 60_000,
  deliveryMaxConcurrencyPerAccount: 2,
  deliveryRatePerSecondPerAccount: 5,
  deliveryRateBurstPerAccount: 10,
  deliveryAccountRateLimits: [],
  deliveryAggregationEnabled: false,
  deliveryAggregationWindowMs: 1_000,
  deliveryAggregationMaxItems: 20,
  deliveryAggregationMaxBytes: 32_768,
  bodyLimitBytes: 1_048_576,
  sseHeartbeatMs: 15_000,
  sseMaxQueue: 1_000,
});

function loopbackPort(api, env) {
  const value = env.OPENCLAW_GATEWAY_PORT ?? api.config?.gateway?.port ?? 18_789;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("Gateway port must be an integer between 1 and 65535");
  }
  return port;
}

export function createChannelGatewayPlugin({
  dispatchGatewayMethod,
  runtimeFactory = createBridgeRuntime,
  senderFactory = createSelfApiSender,
  resourceProbe = detectRuntimeResources,
  env = process.env,
} = {}) {
  if (typeof dispatchGatewayMethod !== "function") {
    throw new TypeError("dispatchGatewayMethod must be a function");
  }

  return definePluginEntry({
    id: "channel-gateway",
    name: "Channel Gateway",
    description: "Durable cross-channel interoperability service.",
    register(api) {
      if (api.registrationMode !== "full") {
        return;
      }

      const pluginConfig = api.pluginConfig ?? {};
      const resources = resourceProbe();
      const concurrency = resolveDeliveryMaxConcurrency({
        configured: pluginConfig.deliveryMaxConcurrency,
        env,
        resources,
      });
      const config = {
        ...DEFAULT_CONFIG,
        ...pluginConfig,
        deliveryMaxConcurrency: concurrency.value,
      };
      const hasLinks = Array.isArray(config.links) && config.links.length > 0;
      const token = env.OPENCLAW_GATEWAY_TOKEN;
      if (hasLinks && (typeof token !== "string" || token.trim() === "")) {
        throw new Error("OPENCLAW_GATEWAY_TOKEN is required when links are configured");
      }
      const sender = hasLinks
        ? senderFactory({
            baseUrl: `http://127.0.0.1:${loopbackPort(api, env)}`,
            token,
          })
        : undefined;
      const configService = createLinksConfigService({
        runtime: api.runtime,
        env,
        resources,
      });
      const runtime = runtimeFactory({
        ...config,
        configService,
        logger: api.logger,
        sender,
        dispatchGatewayMethod,
      });

      api.on(
        "message_received",
        (event, context) => runtime.onMessageReceived(event, context),
        { priority: 100, timeoutMs: 5_000 },
      );
      api.on(
        "before_dispatch",
        (event, context) => runtime.onBeforeDispatch(event, context),
        { priority: 100, timeoutMs: 5_000 },
      );
      api.registerHttpRoute({
        path: "/api/v1",
        auth: "gateway",
        match: "prefix",
        gatewayRuntimeScopeSurface: "trusted-operator",
        handler: runtime.handleHttp,
      });
      api.registerHttpRoute({
        path: "/channel-gateway",
        auth: "plugin",
        match: "prefix",
        handler: createConsoleAssetsHandler(),
      });
      api.lifecycle.registerRuntimeLifecycle({
        id: "channel-gateway",
        cleanup: () => runtime.close(),
      });
      api.on("gateway_start", () => runtime.start(), { priority: 100, timeoutMs: 5_000 });
    },
  });
}
