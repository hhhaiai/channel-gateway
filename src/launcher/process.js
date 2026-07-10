import { spawn as defaultSpawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { OPENCLAW_VERSION } from "./channel-packages.js";

const MINIMUM_NODE_VERSION = Object.freeze([22, 19, 0]);

export function assertSupportedNodeVersion(version = process.versions.node) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
    throw new Error(`unable to parse Node.js version: ${String(version)}`);
  }
  const actual = version.split(/[+-]/, 1)[0].split(".").map(Number);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    if (actual[index] > MINIMUM_NODE_VERSION[index]) {
      return;
    }
    if (actual[index] < MINIMUM_NODE_VERSION[index]) {
      throw new Error("Channel Gateway requires Node.js 22.19.0 or newer");
    }
  }
}

function requireAbsoluteServiceRoot(serviceRoot) {
  if (typeof serviceRoot !== "string" || !path.isAbsolute(serviceRoot)) {
    throw new Error("serviceRoot must be an absolute path");
  }
  return path.normalize(serviceRoot);
}

export async function assertPinnedOpenClawInstallation({ serviceRoot }) {
  const root = requireAbsoluteServiceRoot(serviceRoot);
  const packageRoot = path.join(root, "node_modules", "openclaw");
  const packagePath = path.join(packageRoot, "package.json");
  let packageJson;

  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("installed openclaw package.json contains invalid JSON");
    }
    throw error;
  }
  if (packageJson.name !== "openclaw") {
    throw new Error("installed channel kernel package must be named openclaw");
  }
  if (packageJson.version !== OPENCLAW_VERSION) {
    throw new Error(`openclaw must be exactly ${OPENCLAW_VERSION}`);
  }

  const executablePath = path.join(packageRoot, "openclaw.mjs");
  const executable = await stat(executablePath);
  if (!executable.isFile()) {
    throw new Error("installed openclaw.mjs must be a file");
  }
  return executablePath;
}

function requirePath(paths, key) {
  const value = paths?.[key];
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path`);
  }
  return path.normalize(value);
}

function buildChildEnvironment({ env, paths, token, port }) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("gateway token must be a non-empty string");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("gateway port must be an integer between 1 and 65535");
  }

  return {
    ...env,
    OPENCLAW_HOME: requirePath(paths, "homeDir"),
    OPENCLAW_CONFIG_PATH: requirePath(paths, "configPath"),
    OPENCLAW_STATE_DIR: requirePath(paths, "stateDir"),
    OPENCLAW_WORKSPACE_DIR: requirePath(paths, "workspaceDir"),
    OPENCLAW_OAUTH_DIR: requirePath(paths, "oauthDir"),
    OPENCLAW_GATEWAY_TOKEN: token.trim(),
    OPENCLAW_GATEWAY_PORT: String(port),
  };
}

function signalExitCode(signal) {
  const signalNumber = osConstants.signals?.[signal];
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
}

export async function superviseGateway({
  serviceRoot,
  paths,
  token,
  port,
  env = process.env,
  processRef = process,
  spawn = defaultSpawn,
}) {
  const root = requireAbsoluteServiceRoot(serviceRoot);
  const executablePath = path.join(root, "node_modules", "openclaw", "openclaw.mjs");
  const child = spawn(
    processRef.execPath ?? process.execPath,
    [executablePath, "gateway", "run"],
    {
      cwd: root,
      env: buildChildEnvironment({ env, paths, token, port }),
      stdio: "inherit",
    },
  );

  return new Promise((resolve, reject) => {
    let forwarded = false;

    const cleanup = () => {
      processRef.off("SIGINT", onSigint);
      processRef.off("SIGTERM", onSigterm);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const forward = (signal) => {
      if (forwarded) {
        return;
      }
      forwarded = true;
      child.kill(signal);
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      const exitCode = Number.isInteger(code) ? code : signalExitCode(signal);
      processRef.exitCode = exitCode;
      resolve({ code, signal, exitCode });
    };

    processRef.on("SIGINT", onSigint);
    processRef.on("SIGTERM", onSigterm);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
