import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { writePrivateFileExclusive } from "./atomic-file.js";

const DEFAULT_GATEWAY_PORT = 18789;
const ALLOWED_BIND_MODES = new Set(["loopback", "lan", "tailnet", "auto", "custom"]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function resolveGatewaySettings(env = process.env) {
  let bind = "loopback";
  if (hasOwn(env, "CHANNEL_GATEWAY_BIND")) {
    bind = typeof env.CHANNEL_GATEWAY_BIND === "string"
      ? env.CHANNEL_GATEWAY_BIND.trim()
      : "";
    if (!ALLOWED_BIND_MODES.has(bind)) {
      throw new Error(
        "CHANNEL_GATEWAY_BIND must be one of loopback, lan, tailnet, auto, or custom",
      );
    }
  }

  let port = DEFAULT_GATEWAY_PORT;
  if (hasOwn(env, "CHANNEL_GATEWAY_PORT")) {
    const rawPort = typeof env.CHANNEL_GATEWAY_PORT === "string"
      ? env.CHANNEL_GATEWAY_PORT.trim()
      : "";
    if (!/^\d+$/.test(rawPort)) {
      throw new Error("CHANNEL_GATEWAY_PORT must be an integer between 1 and 65535");
    }
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("CHANNEL_GATEWAY_PORT must be an integer between 1 and 65535");
    }
  }

  if (bind !== "custom") {
    return { bind, port };
  }

  const customBindHost = typeof env.CHANNEL_GATEWAY_CUSTOM_BIND_HOST === "string"
    ? env.CHANNEL_GATEWAY_CUSTOM_BIND_HOST.trim()
    : "";
  if (!customBindHost) {
    throw new Error("CHANNEL_GATEWAY_CUSTOM_BIND_HOST is required for custom bind mode");
  }
  return { bind, port, customBindHost };
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return path.normalize(value);
}

async function loadOperatorConfig(configPath) {
  const { clearConfigCache, loadConfig } = await import("openclaw/plugin-sdk/config-runtime");
  const hadConfigPath = hasOwn(process.env, "OPENCLAW_CONFIG_PATH");
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  try {
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    clearConfigCache();
    return loadConfig({
      skipPluginValidation: true,
      pin: false,
      skipShellEnvFallback: true,
    });
  } finally {
    clearConfigCache();
    if (hadConfigPath) {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    } else {
      delete process.env.OPENCLAW_CONFIG_PATH;
    }
  }
}

function normalizedLoadPaths(config) {
  const paths = Array.isArray(config.plugins?.load?.paths) ? config.plugins.load.paths : [];
  return new Set(
    paths
      .filter((value) => typeof value === "string" && path.isAbsolute(value))
      .map((value) => path.normalize(value)),
  );
}

function channelPackagePluginId(channelPackage) {
  if (typeof channelPackage?.pluginId !== "string" || !channelPackage.pluginId.trim()) {
    throw new Error("channel package pluginId must be a non-empty string");
  }
  const pluginId = channelPackage.pluginId.trim();
  if (pluginId.toLowerCase() === "channel-gateway") {
    throw new Error(`channel package pluginId ${pluginId} is reserved`);
  }
  return pluginId;
}

function channelPackageProvides(channelPackage, channelId) {
  return Array.isArray(channelPackage?.channelIds) && channelPackage.channelIds.includes(channelId);
}

function assertUniqueChannelPackagePluginIds(channelPackages) {
  const pluginIds = new Map();
  for (const channelPackage of channelPackages) {
    const pluginId = channelPackagePluginId(channelPackage);
    const key = pluginId.toLowerCase();
    const existing = pluginIds.get(key);
    if (existing) {
      throw new Error(`duplicate channel plugin id ${pluginId} conflicts with ${existing}`);
    }
    pluginIds.set(key, pluginId);
  }
}

function assertExistingConfigReady({
  config,
  serviceRoot,
  workspaceDir,
  databasePath,
  channelPackages,
}) {
  const issues = [];
  const skippedPluginIds = [];
  const loadPaths = normalizedLoadPaths(config);
  const bridge = config.plugins?.entries?.["channel-gateway"];
  if (config.gateway?.mode !== "local") issues.push("gateway.mode=local");
  if (config.gateway?.auth?.mode !== "token") issues.push("gateway.auth.mode=token");
  if (config.plugins?.enabled !== true) issues.push("plugins.enabled=true");
  if (!loadPaths.has(serviceRoot)) issues.push(`plugins.load.paths must include ${serviceRoot}`);
  if (bridge?.enabled !== true) issues.push("plugins.entries.channel-gateway.enabled=true");
  if (bridge?.hooks?.allowConversationAccess !== true) {
    issues.push("plugins.entries.channel-gateway.hooks.allowConversationAccess=true");
  }
  if (bridge?.config?.databasePath !== databasePath) {
    issues.push(`plugins.entries.channel-gateway.config.databasePath=${databasePath}`);
  }
  if (config.agents?.defaults?.skipBootstrap !== true) {
    issues.push("agents.defaults.skipBootstrap=true");
  }
  if (config.agents?.defaults?.workspace !== workspaceDir) {
    issues.push(`agents.defaults.workspace=${workspaceDir}`);
  }
  if (config.gateway?.controlUi?.enabled !== false) {
    issues.push("gateway.controlUi.enabled=false");
  }
  if (config.gateway?.reload?.mode !== "off") {
    issues.push("gateway.reload.mode=off");
  }
  if (
    !Number.isSafeInteger(config.gateway?.port) ||
    config.gateway.port < 1 ||
    config.gateway.port > 65_535
  ) {
    issues.push("gateway.port must be an integer between 1 and 65535");
  }

  for (const channelPackage of channelPackages) {
    const pluginId = channelPackagePluginId(channelPackage);
    const rootDir = path.normalize(channelPackage.rootDir);
    const entry = config.plugins?.entries?.[pluginId];
    const hasLoadPath = loadPaths.has(rootDir);
    const enabled = entry?.enabled === true;
    if (hasLoadPath && enabled) {
      continue;
    }
    if (channelPackage.existingConfigOptional === true && !hasLoadPath && entry === undefined) {
      skippedPluginIds.push(pluginId);
      continue;
    }
    if (!hasLoadPath || !enabled) {
      issues.push(
        `${pluginId} must be present in plugins.load.paths and plugins.entries.${pluginId}.enabled=true`,
      );
    }
  }
  if (
    channelPackages.some((channelPackage) => channelPackageProvides(channelPackage, "whatsapp")) &&
    config.channels?.whatsapp?.pluginHooks?.messageReceived !== true
  ) {
    issues.push("channels.whatsapp.pluginHooks.messageReceived=true");
  }

  if (issues.length > 0) {
    throw new Error(`existing config is not ready for channel-gateway: ${issues.join("; ")}`);
  }
  return skippedPluginIds;
}

async function validateExistingConfig({
  configPath,
  serviceRoot,
  workspaceDir,
  databasePath,
  channelPackages,
  env,
  gatewaySettings,
}) {
  const config = await loadOperatorConfig(configPath);
  const skippedPluginIds = assertExistingConfigReady({
    config,
    serviceRoot,
    workspaceDir,
    databasePath,
    channelPackages,
  });
  return {
    port: hasOwn(env, "CHANNEL_GATEWAY_PORT") ? gatewaySettings.port : config.gateway.port,
    skippedPluginIds,
  };
}

function buildPluginEntries(channelPackages, databasePath) {
  const entries = {
    "channel-gateway": {
      enabled: true,
      hooks: {
        allowConversationAccess: true,
        timeouts: { before_dispatch: 5000 },
      },
      config: { databasePath, links: [] },
    },
  };

  for (const channelPackage of channelPackages) {
    const pluginId = channelPackagePluginId(channelPackage);
    if (entries[pluginId]) {
      throw new Error(`duplicate channel plugin id ${pluginId}`);
    }
    entries[pluginId] = { enabled: true };
  }
  return entries;
}

function buildInitialConfig({
  serviceRoot,
  workspaceDir,
  databasePath,
  channelPackages,
  gatewaySettings,
}) {
  const loadPaths = [serviceRoot];
  for (const channelPackage of channelPackages) {
    const pluginId = channelPackagePluginId(channelPackage);
    const rootDir = requireAbsolutePath(channelPackage.rootDir, `${pluginId} rootDir`);
    if (!loadPaths.includes(rootDir)) {
      loadPaths.push(rootDir);
    }
  }

  const gateway = {
    mode: "local",
    bind: gatewaySettings.bind,
    port: gatewaySettings.port,
  };
  if (gatewaySettings.bind === "custom") {
    gateway.customBindHost = gatewaySettings.customBindHost;
  }
  gateway.auth = { mode: "token" };
  gateway.controlUi = { enabled: false };
  gateway.reload = { mode: "off" };

  const config = {
    gateway,
    agents: { defaults: { workspace: workspaceDir, skipBootstrap: true } },
    plugins: {
      enabled: true,
      load: { paths: loadPaths },
      entries: buildPluginEntries(channelPackages, databasePath),
    },
  };

  if (channelPackages.some((channelPackage) => channelPackageProvides(channelPackage, "whatsapp"))) {
    config.channels = {
      whatsapp: { pluginHooks: { messageReceived: true } },
    };
  }

  return config;
}

export async function ensureInitialConfig({
  configPath,
  serviceRoot,
  workspaceDir,
  databasePath,
  channelPackages = [],
  env = process.env,
  writeExclusive = writePrivateFileExclusive,
}) {
  const normalizedConfigPath = requireAbsolutePath(configPath, "configPath");
  const normalizedServiceRoot = requireAbsolutePath(serviceRoot, "serviceRoot");
  const normalizedWorkspaceDir = requireAbsolutePath(workspaceDir, "workspaceDir");
  const normalizedDatabasePath = requireAbsolutePath(databasePath, "databasePath");
  if (!Array.isArray(channelPackages)) {
    throw new Error("channelPackages must be an array");
  }
  assertUniqueChannelPackagePluginIds(channelPackages);

  const gatewaySettings = resolveGatewaySettings(env);
  if (await exists(normalizedConfigPath)) {
    const { port, skippedPluginIds } = await validateExistingConfig({
      configPath: normalizedConfigPath,
      serviceRoot: normalizedServiceRoot,
      workspaceDir: normalizedWorkspaceDir,
      databasePath: normalizedDatabasePath,
      channelPackages,
      env,
      gatewaySettings,
    });
    return {
      created: false,
      configPath: normalizedConfigPath,
      config: undefined,
      port,
      ...(skippedPluginIds.length > 0 ? { skippedPluginIds } : {}),
    };
  }

  const config = buildInitialConfig({
    serviceRoot: normalizedServiceRoot,
    workspaceDir: normalizedWorkspaceDir,
    databasePath: normalizedDatabasePath,
    channelPackages,
    gatewaySettings,
  });
  const configDirectory = path.dirname(normalizedConfigPath);
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  const created = await writeExclusive(
    normalizedConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
  );

  if (!created) {
    const { port, skippedPluginIds } = await validateExistingConfig({
      configPath: normalizedConfigPath,
      serviceRoot: normalizedServiceRoot,
      workspaceDir: normalizedWorkspaceDir,
      databasePath: normalizedDatabasePath,
      channelPackages,
      env,
      gatewaySettings,
    });
    return {
      created: false,
      configPath: normalizedConfigPath,
      config: undefined,
      port,
      ...(skippedPluginIds.length > 0 ? { skippedPluginIds } : {}),
    };
  }

  return {
    created,
    configPath: normalizedConfigPath,
    config,
    port: gatewaySettings.port,
  };
}
