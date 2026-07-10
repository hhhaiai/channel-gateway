import { randomBytes as defaultRandomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

import { writePrivateFileExclusive } from "./atomic-file.js";

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeToken(value, errorMessage) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(errorMessage);
  }
  return value.trim();
}

async function readStoredToken(tokenPath) {
  let entry;
  try {
    entry = await lstat(tokenPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error("gateway token must be a regular file and must not be a symbolic link");
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let contents;
  try {
    handle = await open(tokenPath, flags);
    const openedEntry = await handle.stat();
    if (!openedEntry.isFile()) {
      throw new Error("gateway token must be a regular file and must not be a symbolic link");
    }
    if (typeof process.getuid === "function" && openedEntry.uid !== process.getuid()) {
      throw new Error("gateway token must be owned by the current user");
    }
    contents = await handle.readFile("utf8");
    await handle.chmod(0o600);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("gateway token must be a regular file and must not be a symbolic link");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }

  const token = normalizeToken(contents, "stored gateway token must not be blank");
  return token;
}

export async function ensureGatewayToken({
  env = process.env,
  credentialsDir,
  randomBytes = defaultRandomBytes,
}) {
  if (typeof credentialsDir !== "string" || !credentialsDir) {
    throw new Error("credentialsDir must be a non-empty path");
  }

  const tokenPath = path.join(credentialsDir, "gateway-token");
  if (hasOwn(env, "CHANNEL_GATEWAY_TOKEN")) {
    return {
      token: normalizeToken(
        env.CHANNEL_GATEWAY_TOKEN,
        "CHANNEL_GATEWAY_TOKEN must not be blank",
      ),
      source: "environment",
      path: tokenPath,
    };
  }

  await mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  const storedToken = await readStoredToken(tokenPath);
  if (storedToken !== undefined) {
    return { token: storedToken, source: "file", path: tokenPath };
  }

  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new Error("gateway token generator must return exactly 32 bytes");
  }
  const generatedToken = bytes.toString("hex");
  const created = await writePrivateFileExclusive(tokenPath, `${generatedToken}\n`);
  if (!created) {
    const racedToken = await readStoredToken(tokenPath);
    if (racedToken === undefined) {
      throw new Error("gateway token file disappeared during creation");
    }
    return { token: racedToken, source: "file", path: tokenPath };
  }

  return { token: generatedToken, source: "generated", path: tokenPath };
}
