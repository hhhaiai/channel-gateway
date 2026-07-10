import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  }
}

test("orchestrates isolated first-run setup before supervising the pinned Gateway", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const processRef = new FakeProcess();
  const calls = [];
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
  });

  assert.deepEqual(result, { code: 0, signal: null, exitCode: 0 });
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
  assert.deepEqual(config.plugins.load.paths, [
    SERVICE_ROOT,
    path.join(SERVICE_ROOT, "node_modules", "@openclaw", "discord"),
    path.join(SERVICE_ROOT, "node_modules", "@openclaw", "feishu"),
    path.join(SERVICE_ROOT, "node_modules", "@openclaw", "slack"),
    path.join(SERVICE_ROOT, "node_modules", "@openclaw", "whatsapp"),
  ]);
  assert.equal(config.plugins.entries["channel-gateway"].enabled, true);
  assert.equal("models" in config, false);
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
