import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, rm, mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { EventStore } from "../../src/event-store.js";

const serviceRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const token = "standalone-smoke-fixed-operator-token";
const event = Object.freeze({
  id: "evt_restart_smoke",
  channel: "qq",
  accountId: "default",
  conversationId: "group-10001",
  messageId: "message-1",
  sender: { id: "user-1", name: "Alice", username: null },
  text: "durable before restart",
  threadId: null,
  replyTo: null,
  media: [],
  isGroup: true,
  metadata: {},
  receivedAt: "2026-07-10T00:00:00.000Z",
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function boundedTail(chunks, maximum = 12_000) {
  const text = chunks.join("");
  return text.slice(Math.max(0, text.length - maximum));
}

function sanitizedEnvironment(dataDir, port) {
  const allowed = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "NO_PROXY"];
  const env = Object.fromEntries(allowed.flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return {
    ...env,
    CHANNEL_GATEWAY_DATA_DIR: dataDir,
    CHANNEL_GATEWAY_BIND: "loopback",
    CHANNEL_GATEWAY_PORT: String(port),
    CHANNEL_GATEWAY_TOKEN: token,
    NODE_NO_WARNINGS: "1",
  };
}

function startGateway(dataDir, port) {
  const child = spawn(process.execPath, [path.join(serviceRoot, "bin/channel-gateway.js")], {
    cwd: serviceRoot,
    env: sanitizedEnvironment(dataDir, port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  return { child, stdout, stderr };
}

async function stopGateway(processState) {
  if (!processState || processState.child.exitCode !== null) return;
  const exited = await new Promise((resolve) => {
    let timer;
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      processState.child.off("exit", onExit);
      resolve(false);
    }, 15_000);
    processState.child.once("exit", onExit);
    processState.child.kill("SIGTERM");
  });
  if (!exited) {
    processState.child.kill("SIGKILL");
    await new Promise((resolve) => processState.child.once("exit", resolve));
  }
}

async function waitForReady(baseUrl, processState) {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    if (processState.child.exitCode !== null) {
      throw new Error(
        `gateway exited ${processState.child.exitCode}\nstdout tail:\n${boundedTail(processState.stdout)}\nstderr tail:\n${boundedTail(processState.stderr)}`,
      );
    }
    try {
      const healthz = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
      const bridge = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (healthz.ok && bridge.ok) return;
      lastError = new Error(`healthz=${healthz.status} bridge=${bridge.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `gateway readiness timeout: ${lastError?.message}\nstdout tail:\n${boundedTail(processState.stdout)}\nstderr tail:\n${boundedTail(processState.stderr)}`,
  );
}

async function api(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  assert.equal(response.ok, true, `${pathname}: ${response.status} ${JSON.stringify(body)}`);
  assert.equal(body.ok, true);
  return body.result;
}

async function allFiles(root) {
  const result = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else result.push(candidate);
    }
  }
  await visit(root);
  return result;
}

function assertNoModelAuthProfiles(files) {
  assert.equal(files.some((file) => path.basename(file) === "auth-profiles.json"), false);
  for (const file of files.filter((candidate) => path.basename(candidate) === "openclaw-agent.sqlite")) {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const table = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='auth_profile_store'",
      ).get();
      if (table) {
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM auth_profile_store").get().count, 0);
      }
    } finally {
      database.close();
    }
  }
}

test("real pinned Gateway preserves pending events across restart without model credentials", { timeout: 180_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "channel-gateway-standalone-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const databasePath = path.join(dataDir, "state", "channel-gateway.sqlite");
  const store = new EventStore(databasePath);
  store.enqueue(structuredClone(event));
  store.close();

  let running;
  t.after(async () => {
    await stopGateway(running);
    await rm(dataDir, { recursive: true, force: true });
  });

  try {
    running = startGateway(dataDir, port);
    await waitForReady(baseUrl, running);
    const consolePage = await fetch(`${baseUrl}/channel-gateway`);
    assert.equal(consolePage.status, 200);
    assert.match(consolePage.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(await consolePage.text(), /id="channel-cards"/);
    const consoleApp = await fetch(`${baseUrl}/channel-gateway/app.js`);
    assert.equal(consoleApp.status, 200);
    assert.match(await consoleApp.text(), /添加到互通房间/);
    assert.equal((await api(baseUrl, "/api/v1/health")).openclawVersion, "2026.6.11");
    assert.deepEqual((await api(baseUrl, "/api/v1/events")).items, [event]);
    const firstChannels = await api(baseUrl, "/api/v1/channels");
    assert.equal(Array.isArray((await api(baseUrl, "/api/v1/links")).links), true);

    for (const channel of ["discord", "feishu", "slack", "whatsapp"]) {
      const installed = await import(`../../node_modules/@openclaw/${channel}/package.json`, {
        with: { type: "json" },
      }).then(() => true, () => false);
      if (installed) {
        assert.deepEqual(
          {
            configured: firstChannels.channels?.[channel]?.configured,
            running: firstChannels.channels?.[channel]?.running,
          },
          { configured: false, running: false },
        );
      }
    }

    await stopGateway(running);
    running = startGateway(dataDir, port);
    await waitForReady(baseUrl, running);
    assert.deepEqual((await api(baseUrl, "/api/v1/events")).items, [event]);

    await api(baseUrl, `/api/v1/events/${event.id}/ack`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.deepEqual(await api(baseUrl, "/api/v1/events"), { items: [], nextAfter: null });

    await stopGateway(running);
    running = undefined;
    assertNoModelAuthProfiles(await allFiles(dataDir));
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}` +
      `\nstdout tail:\n${boundedTail(running?.stdout ?? [])}` +
      `\nstderr tail:\n${boundedTail(running?.stderr ?? [])}`,
      { cause: error },
    );
  }
});
