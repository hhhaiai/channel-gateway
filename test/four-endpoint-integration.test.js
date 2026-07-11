import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBridgeRuntime } from "../src/bridge-runtime.js";

const LINKS = [
  {
    id: "four-channel-room",
    endpoints: [
      {
        id: "qq-room",
        channel: "qq",
        accountId: "qq-bot",
        conversationId: "qq-group-100",
        to: "qq-group-100",
      },
      {
        id: "feishu-room",
        channel: "feishu",
        accountId: "feishu-bot",
        conversationId: "feishu-chat-200",
        to: "feishu-chat-200",
      },
      {
        id: "whatsapp-room",
        channel: "whatsapp",
        accountId: "wa-bot",
        conversationId: "wa-group-300",
        to: "wa-group-300",
      },
      {
        id: "telegram-room",
        channel: "telegram",
        accountId: "tg-bot",
        conversationId: "tg-chat-400",
        to: "tg-chat-400",
      },
    ],
  },
];

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function ingress(runtime, channel, accountId, conversationId, event) {
  return runtime.onBeforeDispatch(event, { channelId: channel, accountId, conversationId });
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for delivery worker");
}

async function runDeliveryChild() {
  const input = JSON.parse(await readFile(process.env.CHANNEL_GATEWAY_CHILD_INPUT, "utf8"));
  const sends = [];
  const runtime = createBridgeRuntime({
    databasePath: input.databasePath,
    links: LINKS,
    logger: silentLogger,
    deliveryPollMs: 10,
    sender: async (request) => {
      const receiptMessageId = `${request.channel}-forward-1`;
      sends.push({ ...structuredClone(request), receiptMessageId });
      return { messageId: receiptMessageId };
    },
    now: () => 2_000,
  });

  try {
    runtime.start();
    await waitFor(() => sends.length === 3 && runtime.store.deliveryCounts().pending === 0);
    await runtime.close();
    await writeFile(
      process.env.CHANNEL_GATEWAY_CHILD_OUTPUT,
      `${JSON.stringify({ sends })}\n`,
      "utf8",
    );
  } finally {
    await runtime.close();
  }
}

async function spawnDeliveryChild(inputPath, outputPath) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      CHANNEL_GATEWAY_INTEGRATION_CHILD: "1",
      CHANNEL_GATEWAY_CHILD_INPUT: inputPath,
      CHANNEL_GATEWAY_CHILD_OUTPUT: outputPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null }, Buffer.concat(stderr).toString("utf8"));
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  return JSON.parse(await readFile(outputPath, "utf8"));
}

if (process.env.CHANNEL_GATEWAY_INTEGRATION_CHILD === "1") {
  await runDeliveryChild();
} else {
  test(
    "four linked endpoints recover fan-out, suppress echoes, and preserve reply relations across process restarts",
    runIntegration,
  );
}

async function runIntegration(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-four-endpoint-"));
  const databasePath = path.join(directory, "events.sqlite");
  const inputPath = path.join(directory, "child-input.json");
  const outputPath = path.join(directory, "child-output.json");
  const runtimes = new Set();
  const track = (runtime) => {
    runtimes.add(runtime);
    return runtime;
  };
  t.after(async () => {
    await Promise.allSettled([...runtimes].map((runtime) => runtime.close()));
    await rm(directory, { recursive: true, force: true });
  });

  const first = track(createBridgeRuntime({
    databasePath,
    links: LINKS,
    logger: silentLogger,
    now: () => 1_000,
  }));

  assert.deepEqual(
    ingress(first, "qq", "qq-bot", "qq-group-100", {
      content: "hello from QQ",
      messageId: "qq-origin-1",
      senderId: "qq-user-1",
      senderName: "Alice",
      timestamp: 1_000,
    }),
    { handled: true },
  );
  assert.equal(first.store.pendingCount(), 1);
  assert.deepEqual(first.store.deliveryCounts(), {
    pending: 3,
    sending: 0,
    sent: 0,
    failed: 0,
  });
  await first.close();

  await writeFile(inputPath, `${JSON.stringify({ databasePath })}\n`, "utf8");
  const { sends } = await spawnDeliveryChild(inputPath, outputPath);
  assert.equal(sends.length, 3);
  assert.deepEqual(sends.map(({ channel }) => channel).sort(), [
    "feishu",
    "telegram",
    "whatsapp",
  ]);
  assert.deepEqual(
    Object.fromEntries(sends.map(({ channel, receiptMessageId }) => [channel, receiptMessageId])),
    {
      feishu: "feishu-forward-1",
      whatsapp: "whatsapp-forward-1",
      telegram: "telegram-forward-1",
    },
  );

  const replySends = [];
  const sender = async (request) => {
    replySends.push(structuredClone(request));
    return { messageId: `${request.channel}-reply-forward-1` };
  };
  const second = track(createBridgeRuntime({
    databasePath,
    links: LINKS,
    logger: silentLogger,
    sender,
    now: () => 2_000,
  }));

  assert.deepEqual(second.store.deliveryCounts(), {
    pending: 0,
    sending: 0,
    sent: 3,
    failed: 0,
  });

  const initialEventCount = second.store.pendingCount();
  const initialDeliveryCounts = second.store.deliveryCounts();
  const feishuForward = sends.find(({ channel }) => channel === "feishu");
  assert.ok(feishuForward);

  assert.deepEqual(
    ingress(second, "feishu", "feishu-bot", "feishu-chat-200", {
      content: "provider echo",
      messageId: "feishu-forward-1",
      timestamp: 2_100,
    }),
    { handled: true },
  );
  assert.deepEqual(
    ingress(second, "feishu", "feishu-bot", "feishu-chat-200", {
      content: feishuForward.message,
      messageId: "feishu-marker-echo-1",
      timestamp: 2_200,
    }),
    { handled: true },
  );
  assert.equal(second.store.pendingCount(), initialEventCount);
  assert.deepEqual(second.store.deliveryCounts(), initialDeliveryCounts);

  assert.deepEqual(
    ingress(second, "feishu", "feishu-bot", "feishu-chat-200", {
      content: "reply from Feishu",
      messageId: "feishu-reply-1",
      replyToId: "feishu-forward-1",
      senderId: "feishu-user-1",
      timestamp: 3_000,
    }),
    { handled: true },
  );
  assert.deepEqual(second.store.deliveryCounts(), {
    pending: 3,
    sending: 0,
    sent: 3,
    failed: 0,
  });

  await second.worker.tick();
  assert.equal(replySends.length, 3);
  assert.deepEqual(
    Object.fromEntries(replySends.map((request) => [request.channel, request.replyToId])),
    {
      qq: "qq-origin-1",
      whatsapp: "whatsapp-forward-1",
      telegram: "telegram-forward-1",
    },
  );
  assert.equal(replySends.every(({ message }) => message.includes("reply from Feishu")), true);
  assert.deepEqual(second.store.deliveryCounts(), {
    pending: 0,
    sending: 0,
    sent: 6,
    failed: 0,
  });
  await second.close();

  const sendCountBeforeSecondRestart = replySends.length;
  const third = track(createBridgeRuntime({
    databasePath,
    links: LINKS,
    logger: silentLogger,
    sender,
    deliveryPollMs: 10,
    now: () => 4_000,
  }));
  third.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(replySends.length, sendCountBeforeSecondRestart);
  assert.deepEqual(third.store.deliveryCounts(), {
    pending: 0,
    sending: 0,
    sent: 6,
    failed: 0,
  });
  await third.close();
}
