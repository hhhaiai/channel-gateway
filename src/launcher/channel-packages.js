import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const OPENCLAW_VERSION = "2026.6.11";

const OFFICIAL_CHANNEL_PACKAGES = Object.freeze([
  { id: "discord", name: "@openclaw/discord" },
  { id: "feishu", name: "@openclaw/feishu" },
  { id: "slack", name: "@openclaw/slack" },
  { id: "whatsapp", name: "@openclaw/whatsapp" },
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
  const id = assertNonEmptyString(manifest.id, `${label} manifest id must not be blank`);

  if (expected?.name && name !== expected.name) {
    throw new Error(`${expected.name} package root contains unexpected package ${name}`);
  }
  if (expected?.name && version !== OPENCLAW_VERSION) {
    throw new Error(`${name} must be exactly ${OPENCLAW_VERSION}`);
  }
  if (!expected?.name) {
    assertCompatibleFloor(name, "openclaw.install.minHostVersion", packageJson.openclaw?.install?.minHostVersion);
    assertCompatibleFloor(name, "openclaw.compat.pluginApi", packageJson.openclaw?.compat?.pluginApi);
  }
  if (expected?.id && id !== expected.id) {
    throw new Error(`${name} expected channel id ${expected.id}, received ${id}`);
  }
  if (!Array.isArray(manifest.channels) || !manifest.channels.includes(id)) {
    throw new Error(`${name} manifest must declare channel id ${id}`);
  }

  const packageChannelId = packageJson.openclaw?.channel?.id;
  if (packageChannelId !== undefined && packageChannelId !== id) {
    throw new Error(`${name} package metadata channel id must match manifest id ${id}`);
  }

  return { id, name, version, rootDir };
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

function appendUnique(packages, byId, descriptor) {
  const existing = byId.get(descriptor.id);
  if (existing) {
    if (existing.rootDir !== descriptor.rootDir) {
      throw new Error(`channel id ${descriptor.id} is provided by multiple plugin paths`);
    }
    return;
  }
  byId.set(descriptor.id, descriptor);
  packages.push(descriptor);
}

export async function discoverChannelPackages({ serviceRoot, env = process.env }) {
  if (typeof serviceRoot !== "string" || !path.isAbsolute(serviceRoot)) {
    throw new Error("serviceRoot must be an absolute path");
  }

  const packages = [];
  const byId = new Map();
  for (const candidate of OFFICIAL_CHANNEL_PACKAGES) {
    const rootDir = path.join(serviceRoot, "node_modules", ...candidate.name.split("/"));
    if (!(await pathExists(rootDir))) {
      continue;
    }
    appendUnique(packages, byId, await inspectPackage(rootDir, candidate));
  }

  for (const rootDir of parseExplicitPluginPaths(env)) {
    if (!(await pathExists(rootDir))) {
      throw new Error(`explicit channel plugin path does not exist: ${rootDir}`);
    }
    appendUnique(packages, byId, await inspectPackage(rootDir));
  }

  return packages;
}
