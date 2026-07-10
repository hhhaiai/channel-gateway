import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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

test("four linked endpoints recover fan-out, suppress echoes, and preserve reply relations across restarts", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "channel-gateway-four-endpoint-"));
  const databasePath = path.join(directory, "events.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const first = createBridgeRuntime({
    databasePath,
    links: LINKS,
    logger: silentLogger,
    now: () => 1_000,
  });

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

  const sends = [];
  const sendNumberByChannel = new Map();
  const sender = async (request) => {
    sends.push(structuredClone(request));
    const sendNumber = (sendNumberByChannel.get(request.channel) ?? 0) + 1;
    sendNumberByChannel.set(request.channel, sendNumber);
    return { messageId: `${request.channel}-forward-${sendNumber}` };
  };
  const second = createBridgeRuntime({
    databasePath,
    links: LINKS,
    logger: silentLogger,
    sender,
    now: () => 2_000,
  });

  await second.worker.tick();
  assert.deepEqual(sends.map(({ channel }) => channel), [
    "feishu",
    "whatsapp",
    "telegram",
  ]);
  assert.deepEqual(second.store.deliveryCounts(), {
    pending: 0,
    sending: 0,
    sent: 3,
    failed: 0,
  });

  const initialEventCount = second.store.pendingCount();
  const initialDeliveryCounts = second.store.deliveryCounts();
  const feishuForward = sends.find(({ channel }) => channel === "feishu");

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
  const replySends = sends.slice(3);
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

  const sendCountBeforeSecondRestart = sends.length;
  const third = createBridgeRuntime({
    databasePath,
    links: LINKS,
    logger: silentLogger,
    sender,
    now: () => 4_000,
  });
  await third.worker.tick();
  assert.equal(sends.length, sendCountBeforeSecondRestart);
  assert.deepEqual(third.store.deliveryCounts(), {
    pending: 0,
    sending: 0,
    sent: 6,
    failed: 0,
  });
  await third.close();
});
