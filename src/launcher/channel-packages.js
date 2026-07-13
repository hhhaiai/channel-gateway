import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const OPENCLAW_VERSION = "2026.6.11";
export const WECOM_PLUGIN_VERSION = "2026.5.25";

const OFFICIAL_CHANNEL_PACKAGES = Object.freeze([
  "discord", "feishu", "googlechat", "irc", "line", "matrix", "mattermost", "msteams",
  "nextcloud-talk", "nostr", "qqbot", "raft", "signal", "slack", "sms", "synology-chat",
  "tlon", "twitch", "whatsapp", "zalo", "zalouser",
].map((id) => ({ id, pluginId: id, name: `@openclaw/${id}`, version: OPENCLAW_VERSION })));

const PINNED_EXTERNAL_CHANNEL_PACKAGES = Object.freeze([
  {
    id: "wecom",
    pluginId: "wecom-openclaw-plugin",
    name: "@wecom/wecom-openclaw-plugin",
    version: WECOM_PLUGIN_VERSION,
    existingConfigOptional: true,
  },
]);

async function pathExists(candidatePath) {
  try {
    await stat(candidatePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readJson(filePath, label) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} is missing ${path.basename(filePath)}`);
    }
    throw error;
  }

  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label} contains invalid JSON in ${path.basename(filePath)}`);
  }
}

function assertNonEmptyString(value, message) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value.trim();
}

function versionTuple(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

function assertCompatibleFloor(packageName, fieldName, value) {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !value.startsWith(">=")) {
    throw new Error(`${packageName} ${fieldName} must be a >= semver floor`);
  }
  const required = versionTuple(value.slice(2));
  const host = versionTuple(OPENCLAW_VERSION);
  if (!required || !host) {
    throw new Error(`${packageName} ${fieldName} must be a >= semver floor`);
  }
  for (let index = 0; index < host.length; index += 1) {
    if (required[index] < host[index]) {
      return;
    }
    if (required[index] > host[index]) {
      throw new Error(`${packageName} requires OpenClaw ${value}`);
    }
  }
}

async function inspectPackage(rootDir, expected) {
  const label = expected?.name ?? `plugin at ${rootDir}`;
  const [packageJson, manifest] = await Promise.all([
    readJson(path.join(rootDir, "package.json"), label),
    readJson(path.join(rootDir, "openclaw.plugin.json"), label),
  ]);
  const name = assertNonEmptyString(packageJson.name, `${label} package name must not be blank`);
  const version = assertNonEmptyString(
    packageJson.version,
    `${label} package version must not be blank`,
  );
  const pluginId = assertNonEmptyString(manifest.id, `${label} manifest id must not be blank`);
  if (pluginId.toLowerCase() === "channel-gateway") {
    throw new Error(`${name} plugin id ${pluginId} is reserved`);
  }

  if (expected?.name && name !== expected.name) {
    throw new Error(`${expected.name} package root contains unexpected package ${name}`);
  }
  if (expected?.name && version !== expected.version) {
    throw new Error(`${name} must be exactly ${expected.version}`);
  }
  if (expected?.pluginId && pluginId !== expected.pluginId) {
    throw new Error(`${name} expected plugin id ${expected.pluginId}, received ${pluginId}`);
  }
  if (!expected?.name) {
    assertCompatibleFloor(name, "openclaw.install.minHostVersion", packageJson.openclaw?.install?.minHostVersion);
    assertCompatibleFloor(name, "openclaw.compat.pluginApi", packageJson.openclaw?.compat?.pluginApi);
  }
  if (!Array.isArray(manifest.channels) || manifest.channels.length === 0) {
    throw new Error(`${name} manifest channels must be a non-empty array`);
  }
  const channelIds = manifest.channels.map((channelId) =>
    assertNonEmptyString(channelId, `${name} manifest channel ids must not be blank`));
  if (new Set(channelIds.map((channelId) => channelId.toLowerCase())).size !== channelIds.length) {
    throw new Error(`${name} manifest channel ids must be unique`);
  }
  if (expected?.id && !channelIds.includes(expected.id)) {
    throw new Error(`${name} expected channel id ${expected.id}`);
  }

  const packageChannelId = packageJson.openclaw?.channel?.id;
  if (packageChannelId !== undefined) {
    const normalizedPackageChannelId = assertNonEmptyString(
      packageChannelId,
      `${name} package metadata channel id must not be blank`,
    );
    if (!channelIds.includes(normalizedPackageChannelId)) {
      throw new Error(`${name} manifest must declare channel id ${normalizedPackageChannelId}`);
    }
  }

  return { pluginId, channelIds, name, version, rootDir };
}

function parseExplicitPluginPaths(env) {
  const value = env.CHANNEL_GATEWAY_PLUGIN_PATHS;
  if (value === undefined || value === "") {
    return [];
  }
  if (typeof value !== "string") {
    throw new Error("CHANNEL_GATEWAY_PLUGIN_PATHS must be a path-delimited string");
  }

  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (!path.isAbsolute(entry)) {
        throw new Error("CHANNEL_GATEWAY_PLUGIN_PATHS plugin paths must be absolute");
      }
      return path.normalize(entry);
    });
}

function appendUnique(packages, byPluginId, byChannelId, descriptor) {
  const pluginKey = descriptor.pluginId.toLowerCase();
  const existingPlugin = byPluginId.get(pluginKey);
  if (existingPlugin) {
    if (existingPlugin.rootDir !== descriptor.rootDir) {
      if (existingPlugin.pluginId !== descriptor.pluginId) {
        throw new Error(`plugin id ${descriptor.pluginId} conflicts with ${existingPlugin.pluginId}`);
      }
      throw new Error(`plugin id ${descriptor.pluginId} is provided by multiple plugin paths`);
    }
    return;
  }

  for (const channelId of descriptor.channelIds) {
    const existingChannel = byChannelId.get(channelId.toLowerCase());
    if (existingChannel && existingChannel.rootDir !== descriptor.rootDir) {
      const existingId = existingChannel.channelIds.find(
        (candidate) => candidate.toLowerCase() === channelId.toLowerCase(),
      );
      if (existingId !== channelId) {
        throw new Error(`channel id ${channelId} conflicts with ${existingId}`);
      }
      throw new Error(`channel id ${channelId} is provided by multiple plugin paths`);
    }
  }

  byPluginId.set(pluginKey, descriptor);
  for (const channelId of descriptor.channelIds) {
    byChannelId.set(channelId.toLowerCase(), descriptor);
  }
  packages.push(descriptor);
}

export async function discoverChannelPackages({ serviceRoot, env = process.env }) {
  if (typeof serviceRoot !== "string" || !path.isAbsolute(serviceRoot)) {
    throw new Error("serviceRoot must be an absolute path");
  }

  const packages = [];
  const byPluginId = new Map();
  const byChannelId = new Map();
  for (const candidate of OFFICIAL_CHANNEL_PACKAGES) {
    const rootDir = path.join(serviceRoot, "node_modules", ...candidate.name.split("/"));
    if (!(await pathExists(rootDir))) {
      continue;
    }
    appendUnique(packages, byPluginId, byChannelId, await inspectPackage(rootDir, candidate));
  }

  for (const candidate of PINNED_EXTERNAL_CHANNEL_PACKAGES) {
    const rootDir = path.join(serviceRoot, "node_modules", ...candidate.name.split("/"));
    if (!(await pathExists(rootDir))) {
      continue;
    }
    const descriptor = await inspectPackage(rootDir, candidate);
    appendUnique(packages, byPluginId, byChannelId, {
      ...descriptor,
      ...(candidate.existingConfigOptional ? { existingConfigOptional: true } : {}),
    });
  }

  for (const rootDir of parseExplicitPluginPaths(env)) {
    if (!(await pathExists(rootDir))) {
      throw new Error(`explicit channel plugin path does not exist: ${rootDir}`);
    }
    appendUnique(packages, byPluginId, byChannelId, await inspectPackage(rootDir));
  }

  return packages;
}
