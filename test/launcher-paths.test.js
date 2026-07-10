import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDataPaths, resolveDataPaths } from "../src/launcher/paths.js";

test("resolves the default data layout relative to the launcher cwd", () => {
  const cwd = path.join(path.sep, "srv", "channel-gateway");

  assert.deepEqual(resolveDataPaths({}, cwd), {
    dataDir: path.join(cwd, ".channel-gateway"),
    homeDir: path.join(cwd, ".channel-gateway"),
    configDir: path.join(cwd, ".channel-gateway", "config"),
    configPath: path.join(cwd, ".channel-gateway", "config", "openclaw.json"),
    stateDir: path.join(cwd, ".channel-gateway", "state"),
    credentialsDir: path.join(cwd, ".channel-gateway", "credentials"),
    oauthDir: path.join(cwd, ".channel-gateway", "credentials"),
    workspaceDir: path.join(cwd, ".channel-gateway", "workspace"),
    databasePath: path.join(cwd, ".channel-gateway", "state", "channel-gateway.sqlite"),
  });
});

test("resolves an explicit data directory to isolated absolute paths", () => {
  const cwd = path.join(path.sep, "opt", "service");
  const paths = resolveDataPaths({ CHANNEL_GATEWAY_DATA_DIR: "runtime" }, cwd);

  assert.equal(paths.dataDir, path.join(cwd, "runtime"));
  assert.equal(paths.configPath, path.join(cwd, "runtime", "config", "openclaw.json"));
  assert.equal(paths.databasePath, path.join(cwd, "runtime", "state", "channel-gateway.sqlite"));
  assert.equal(paths.oauthDir, path.join(cwd, "runtime", "credentials"));
  assert.throws(
    () => resolveDataPaths({ CHANNEL_GATEWAY_DATA_DIR: "   " }, cwd),
    /CHANNEL_GATEWAY_DATA_DIR must not be blank/,
  );
});

test("creates private data directories and the canonical credential symlink", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-paths-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = resolveDataPaths({ CHANNEL_GATEWAY_DATA_DIR: path.join(directory, "data") });

  await ensureDataPaths(paths);
  await ensureDataPaths(paths);

  for (const directoryPath of [
    paths.dataDir,
    paths.configDir,
    paths.stateDir,
    paths.credentialsDir,
    paths.workspaceDir,
  ]) {
    assert.equal((await stat(directoryPath)).mode & 0o777, 0o700);
  }

  const canonicalCredentials = path.join(paths.stateDir, "credentials");
  assert.equal((await lstat(canonicalCredentials)).isSymbolicLink(), true);
  assert.equal(await realpath(canonicalCredentials), await realpath(paths.credentialsDir));
});

test("refuses to replace an existing canonical credential directory", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-paths-existing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = resolveDataPaths({ CHANNEL_GATEWAY_DATA_DIR: path.join(directory, "data") });
  await mkdir(path.join(paths.stateDir, "credentials"), { recursive: true });

  await assert.rejects(() => ensureDataPaths(paths), /state\/credentials must be a symlink/);
});

test("refuses a credentials directory symlink outside the isolated data root", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-paths-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = resolveDataPaths({ CHANNEL_GATEWAY_DATA_DIR: path.join(directory, "data") });
  const victim = path.join(directory, "victim");
  await mkdir(paths.dataDir, { recursive: true });
  await mkdir(victim);
  await symlink(victim, paths.credentialsDir, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    () => ensureDataPaths(paths),
    /credentials must be a real directory, not a symbolic link/,
  );
});
