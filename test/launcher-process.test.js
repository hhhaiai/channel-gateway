import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPinnedOpenClawInstallation,
  assertSupportedNodeVersion,
  superviseGateway,
} from "../src/launcher/process.js";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.execPath = "/runtime/node";
    this.exitCode = undefined;
  }
}

function isolatedPaths(root) {
  return {
    homeDir: root,
    configPath: path.join(root, "config", "openclaw.json"),
    stateDir: path.join(root, "state"),
    workspaceDir: path.join(root, "workspace"),
    oauthDir: path.join(root, "credentials"),
  };
}

test("spawns the pinned gateway command with isolated environment paths and no token argv", async () => {
  const serviceRoot = path.join(path.sep, "srv", "channel-gateway");
  const paths = isolatedPaths(path.join(path.sep, "data"));
  const processRef = new FakeProcess();
  const child = new EventEmitter();
  child.kill = () => true;
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };

  const result = await superviseGateway({
    serviceRoot,
    paths,
    token: "super-secret-token",
    port: 23456,
    env: {
      KEEP_ME: "yes",
      OPENCLAW_HOME: "/ambient/home",
      OPENCLAW_CONFIG_PATH: "/ambient/config",
      OPENCLAW_STATE_DIR: "/ambient/state",
      OPENCLAW_WORKSPACE_DIR: "/ambient/workspace",
      OPENCLAW_OAUTH_DIR: "/ambient/oauth",
      OPENCLAW_GATEWAY_TOKEN: "ambient-token",
      OPENCLAW_GATEWAY_PORT: "9999",
    },
    processRef,
    spawn,
  });

  assert.deepEqual(result, { code: 0, signal: null, exitCode: 0 });
  assert.equal(processRef.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, processRef.execPath);
  assert.deepEqual(calls[0].args, [
    path.join(serviceRoot, "node_modules", "openclaw", "openclaw.mjs"),
    "gateway",
    "run",
  ]);
  assert.equal(JSON.stringify([calls[0].command, calls[0].args]).includes("super-secret-token"), false);
  assert.equal(calls[0].options.cwd, serviceRoot);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.deepEqual(
    {
      KEEP_ME: calls[0].options.env.KEEP_ME,
      OPENCLAW_HOME: calls[0].options.env.OPENCLAW_HOME,
      OPENCLAW_CONFIG_PATH: calls[0].options.env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_STATE_DIR: calls[0].options.env.OPENCLAW_STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: calls[0].options.env.OPENCLAW_WORKSPACE_DIR,
      OPENCLAW_OAUTH_DIR: calls[0].options.env.OPENCLAW_OAUTH_DIR,
      OPENCLAW_GATEWAY_TOKEN: calls[0].options.env.OPENCLAW_GATEWAY_TOKEN,
      OPENCLAW_GATEWAY_PORT: calls[0].options.env.OPENCLAW_GATEWAY_PORT,
    },
    {
      KEEP_ME: "yes",
      OPENCLAW_HOME: paths.homeDir,
      OPENCLAW_CONFIG_PATH: paths.configPath,
      OPENCLAW_STATE_DIR: paths.stateDir,
      OPENCLAW_WORKSPACE_DIR: paths.workspaceDir,
      OPENCLAW_OAUTH_DIR: paths.oauthDir,
      OPENCLAW_GATEWAY_TOKEN: "super-secret-token",
      OPENCLAW_GATEWAY_PORT: "23456",
    },
  );
});

test("forwards only the first termination signal and mirrors signal exit status", async () => {
  const processRef = new FakeProcess();
  const child = new EventEmitter();
  const forwarded = [];
  child.kill = (signal) => {
    forwarded.push(signal);
    return true;
  };
  const completion = superviseGateway({
    serviceRoot: path.join(path.sep, "srv", "channel-gateway"),
    paths: isolatedPaths(path.join(path.sep, "data")),
    token: "token",
    port: 18789,
    env: {},
    processRef,
    spawn: () => child,
  });

  processRef.emit("SIGTERM");
  processRef.emit("SIGTERM");
  processRef.emit("SIGINT");
  assert.deepEqual(forwarded, ["SIGTERM"]);
  child.emit("exit", null, "SIGTERM");

  assert.deepEqual(await completion, { code: null, signal: "SIGTERM", exitCode: 143 });
  assert.equal(processRef.exitCode, 143);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
});

test("propagates child spawn failures and removes signal handlers", async () => {
  const processRef = new FakeProcess();
  const child = new EventEmitter();
  child.kill = () => true;
  const completion = superviseGateway({
    serviceRoot: path.join(path.sep, "srv", "channel-gateway"),
    paths: isolatedPaths(path.join(path.sep, "data")),
    token: "token",
    port: 18789,
    env: {},
    processRef,
    spawn: () => child,
  });
  child.emit("error", new Error("spawn failed"));

  await assert.rejects(() => completion, /spawn failed/);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
});

test("checks the Node floor and exact installed OpenClaw release", async (t) => {
  assert.doesNotThrow(() => assertSupportedNodeVersion("22.19.0"));
  assert.doesNotThrow(() => assertSupportedNodeVersion("23.0.0"));
  assert.throws(() => assertSupportedNodeVersion("22.18.9"), /Node\.js 22\.19\.0 or newer/);
  assert.throws(() => assertSupportedNodeVersion("invalid"), /unable to parse Node\.js version/);

  const serviceRoot = await mkdtemp(path.join(tmpdir(), "channel-gateway-openclaw-"));
  t.after(() => rm(serviceRoot, { recursive: true, force: true }));
  const packageRoot = path.join(serviceRoot, "node_modules", "openclaw");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "2026.6.11" })}\n`,
  );
  await writeFile(path.join(packageRoot, "openclaw.mjs"), "// fixture\n");

  assert.equal(
    await assertPinnedOpenClawInstallation({ serviceRoot }),
    path.join(packageRoot, "openclaw.mjs"),
  );

  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "2026.6.10" })}\n`,
  );
  await assert.rejects(
    () => assertPinnedOpenClawInstallation({ serviceRoot }),
    /openclaw must be exactly 2026\.6\.11/,
  );
});
