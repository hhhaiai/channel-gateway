import { chmod, lstat, mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

async function ensurePrivateDirectory(directoryPath) {
  try {
    await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const entry = await lstat(directoryPath);
  if (entry.isSymbolicLink()) {
    throw new Error(
      `${path.basename(directoryPath)} must be a real directory, not a symbolic link`,
    );
  }
  if (!entry.isDirectory()) {
    throw new Error(`${directoryPath} must be a directory`);
  }
  await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function resolveDataPaths(env = process.env, cwd = process.cwd()) {
  let configuredDataDir;
  if (hasOwn(env, "CHANNEL_GATEWAY_DATA_DIR")) {
    if (typeof env.CHANNEL_GATEWAY_DATA_DIR !== "string" || !env.CHANNEL_GATEWAY_DATA_DIR.trim()) {
      throw new Error("CHANNEL_GATEWAY_DATA_DIR must not be blank");
    }
    configuredDataDir = env.CHANNEL_GATEWAY_DATA_DIR.trim();
  }

  const dataDir = path.resolve(cwd, configuredDataDir ?? ".channel-gateway");
  const configDir = path.join(dataDir, "config");
  const stateDir = path.join(dataDir, "state");
  const credentialsDir = path.join(dataDir, "credentials");
  const workspaceDir = path.join(dataDir, "workspace");

  return {
    dataDir,
    homeDir: dataDir,
    configDir,
    configPath: path.join(configDir, "openclaw.json"),
    stateDir,
    credentialsDir,
    oauthDir: credentialsDir,
    workspaceDir,
    databasePath: path.join(stateDir, "channel-gateway.sqlite"),
  };
}

async function inspectCredentialLink(canonicalPath, credentialsDir) {
  const entry = await lstat(canonicalPath);
  if (!entry.isSymbolicLink()) {
    throw new Error(`${canonicalPath} must be a symlink to the isolated credentials directory`);
  }

  const [actualTarget, expectedTarget] = await Promise.all([
    realpath(canonicalPath),
    realpath(credentialsDir),
  ]);
  if (actualTarget !== expectedTarget) {
    throw new Error(`${canonicalPath} points outside the isolated credentials directory`);
  }
}

export async function ensureDataPaths(paths) {
  for (const directoryPath of [
    paths.dataDir,
    paths.configDir,
    paths.stateDir,
    paths.credentialsDir,
    paths.workspaceDir,
  ]) {
    await ensurePrivateDirectory(directoryPath);
  }

  const canonicalCredentials = path.join(paths.stateDir, "credentials");
  try {
    await inspectCredentialLink(canonicalCredentials, paths.credentialsDir);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    try {
      await symlink(
        paths.credentialsDir,
        canonicalCredentials,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (symlinkError) {
      if (symlinkError?.code !== "EEXIST") {
        throw symlinkError;
      }
    }
    await inspectCredentialLink(canonicalCredentials, paths.credentialsDir);
  }

  return paths;
}
