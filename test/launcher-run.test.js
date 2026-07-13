import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runChannelGateway } from "../src/launcher/run.js";

const SERVICE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.execPath = process.execPath;
    this.exitCode = undefined;
    this.stderrOutput = "";
    this.stderr = { write: (chunk) => { this.stderrOutput += String(chunk); } };
  }
}

test("orchestrates isolated first-run setup before supervising the pinned Gateway", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const processRef = new FakeProcess();
  const calls = [];
  const verifiedRoots = [];
  const child = new EventEmitter();
  child.kill = () => true;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };

  const result = await runChannelGateway({
    serviceRoot: SERVICE_ROOT,
    cwd: directory,
    env: {
      CHANNEL_GATEWAY_DATA_DIR: path.join(directory, "data"),
      CHANNEL_GATEWAY_TOKEN: "fixed-token",
      CHANNEL_GATEWAY_PORT: "24567",
    },
    nodeVersion: process.versions.node,
    processRef,
    spawn,
    verifyOpenClawPatch: async (root) => verifiedRoots.push(root),
  });

  assert.deepEqual(result, { code: 0, signal: null, exitCode: 0 });
  assert.deepEqual(verifiedRoots, [path.join(SERVICE_ROOT, "node_modules", "openclaw")]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    path.join(SERVICE_ROOT, "node_modules", "openclaw", "openclaw.mjs"),
    "gateway",
    "run",
  ]);
  assert.equal(calls[0].options.env.OPENCLAW_GATEWAY_TOKEN, "fixed-token");
  assert.equal(calls[0].options.env.OPENCLAW_GATEWAY_PORT, "24567");
  assert.equal(
    calls[0].options.env.OPENCLAW_CONFIG_PATH,
    path.join(directory, "data", "config", "openclaw.json"),
  );

  const config = JSON.parse(await readFile(calls[0].options.env.OPENCLAW_CONFIG_PATH, "utf8"));
  assert.equal(config.gateway.port, 24567);
  assert.equal(config.agents.defaults.skipBootstrap, true);
  assert.equal(config.plugins.load.paths[0], SERVICE_ROOT);
  for (const pluginRoot of [
    path.join(SERVICE_ROOT, "node_modules", "@openclaw", "discord"),
    path.join(SERVICE_ROOT, "node_modules", "@openclaw", "feishu"),
    path.join(SERVICE_ROOT, "node_modules", "@openclaw", "slack"),
    path.join(SERVICE_ROOT, "node_modules", "@openclaw", "whatsapp"),
    path.join(SERVICE_ROOT, "node_modules", "@wecom", "wecom-openclaw-plugin"),
  ]) {
    assert.equal(config.plugins.load.paths.includes(pluginRoot), true);
  }
  assert.equal(new Set(config.plugins.load.paths).size, config.plugins.load.paths.length);
  assert.equal(config.plugins.entries["channel-gateway"].enabled, true);
  assert.equal(config.plugins.entries["wecom-openclaw-plugin"].enabled, true);
  assert.equal(config.plugins.entries.wecom, undefined);
  assert.equal("models" in config, false);
});

test("refuses to launch when the installed Host rich-hook patch is unverified", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-run-unpatched-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, "data");
  let spawned = false;

  await assert.rejects(
    runChannelGateway({
      serviceRoot: SERVICE_ROOT,
      cwd: directory,
      env: {
        CHANNEL_GATEWAY_DATA_DIR: dataDir,
        CHANNEL_GATEWAY_TOKEN: "fixed-token",
      },
      verifyOpenClawPatch: async () => {
        throw new Error("missing .channel-gateway-rich-hook-v2.json");
      },
      spawn() {
        spawned = true;
      },
    }),
    /missing \.channel-gateway-rich-hook-v2\.json/,
  );
  assert.equal(spawned, false);
  await assert.rejects(access(dataDir), { code: "ENOENT" });
});

test("warns without breaking an existing config that has not enabled newly pinned WeCom", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-run-wecom-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, "data");
  const env = {
    CHANNEL_GATEWAY_DATA_DIR: dataDir,
    CHANNEL_GATEWAY_TOKEN: "fixed-token",
  };
  const makeSpawn = () => {
    const child = new EventEmitter();
    child.kill = () => true;
    return () => {
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    };
  };

  await runChannelGateway({
    serviceRoot: SERVICE_ROOT,
    cwd: directory,
    env,
    nodeVersion: process.versions.node,
    processRef: new FakeProcess(),
    spawn: makeSpawn(),
    verifyOpenClawPatch: async () => {},
  });
  const configPath = path.join(dataDir, "config", "openclaw.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const wecomRoot = path.join(SERVICE_ROOT, "node_modules", "@wecom", "wecom-openclaw-plugin");
  config.plugins.load.paths = config.plugins.load.paths.filter((entry) => entry !== wecomRoot);
  delete config.plugins.entries["wecom-openclaw-plugin"];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const processRef = new FakeProcess();
  const result = await runChannelGateway({
    serviceRoot: SERVICE_ROOT,
    cwd: directory,
    env,
    nodeVersion: process.versions.node,
    processRef,
    spawn: makeSpawn(),
    verifyOpenClawPatch: async () => {},
  });

  assert.deepEqual(result, { code: 0, signal: null, exitCode: 0 });
  assert.match(processRef.stderrOutput, /wecom-openclaw-plugin.*installed but not enabled/);
});

test("CLI reports startup failures as one sanitized line", () => {
  const result = spawnSync(process.execPath, [path.join(SERVICE_ROOT, "bin", "channel-gateway.js")], {
    cwd: SERVICE_ROOT,
    env: { ...process.env, CHANNEL_GATEWAY_DATA_DIR: " " },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "channel-gateway: CHANNEL_GATEWAY_DATA_DIR must not be blank\n",
  );
});
