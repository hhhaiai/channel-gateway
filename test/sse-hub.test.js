import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import { EventStore } from "../src/event-store.js";
import { SseHub } from "../src/sse-hub.js";

function event(id) {
  return {
    id,
    channel: "telegram",
    accountId: "default",
    conversationId: "chat-1",
    messageId: id,
    sender: { id: "user-1", name: "Alice", username: null },
    text: `message ${id}`,
    threadId: null,
    replyTo: null,
    media: [],
    isGroup: true,
    metadata: {},
    receivedAt: "2026-07-10T00:00:00.000Z",
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function readFrames(response, count, timeoutMs = 2_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames = [];
  const timeout = setTimeout(() => reader.cancel(new Error("SSE read timeout")), timeoutMs);
  try {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        frames.push(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frames.length === count) {
          break;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
  }
  return frames;
}

function parseMessage(frame) {
  const lines = frame.split("\n");
  return {
    event: lines.find((line) => line.startsWith("event: "))?.slice(7),
    id: lines.find((line) => line.startsWith("id: "))?.slice(4),
    data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "null"),
  };
}

test("replays every durable pending event on initial connect and reconnect", async (t) => {
  const store = new EventStore(":memory:");
  const first = event("evt_1");
  const second = event("evt_2");
  store.enqueue(first);
  store.enqueue(second);
  const hub = new SseHub({ store, heartbeatMs: 60_000 });
  store.on("pending", (pending) => hub.publish(pending));
  const server = await listen((request, response) => hub.handle(request, response));
  t.after(async () => {
    await hub.close();
    store.close();
    await server.close();
  });

  let response = await fetch(`${server.baseUrl}/api/v1/events/stream`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  let frames = (await readFrames(response, 2)).map(parseMessage);
  assert.deepEqual(frames.map((frame) => frame.id), ["evt_1", "evt_2"]);
  assert.deepEqual(frames.map((frame) => frame.data), [first, second]);

  store.ack("evt_2");
  response = await fetch(`${server.baseUrl}/api/v1/events/stream`, {
    headers: { "last-event-id": "evt_2" },
  });
  frames = (await readFrames(response, 1)).map(parseMessage);
  assert.deepEqual(frames.map((frame) => frame.id), ["evt_1"]);
});

test("delivers a snapshot/live race event exactly once", async (t) => {
  const store = new EventStore(":memory:");
  const raced = event("evt_race");
  const originalListPending = store.listPending.bind(store);
  let racedOnce = false;
  store.listPending = (options) => {
    if (!racedOnce) {
      racedOnce = true;
      store.enqueue(raced);
    }
    return originalListPending(options);
  };
  const hub = new SseHub({ store, heartbeatMs: 60_000 });
  store.on("pending", (pending) => hub.publish(pending));
  const server = await listen((request, response) => hub.handle(request, response));
  t.after(async () => {
    await hub.close();
    store.close();
    await server.close();
  });

  const response = await fetch(`${server.baseUrl}/api/v1/events/stream`);
  const frames = (await readFrames(response, 1)).map(parseMessage);
  assert.deepEqual(frames.map((frame) => frame.id), ["evt_race"]);
});

test("emits heartbeat comments on idle connections", async (t) => {
  const store = new EventStore(":memory:");
  const hub = new SseHub({ store, heartbeatMs: 10 });
  const server = await listen((request, response) => hub.handle(request, response));
  t.after(async () => {
    await hub.close();
    store.close();
    await server.close();
  });

  const response = await fetch(`${server.baseUrl}/api/v1/events/stream`);
  assert.deepEqual(await readFrames(response, 1), [": heartbeat"]);
});

class SlowResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.frames = [];
    this.destroyed = false;
    this.writableEnded = false;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  flushHeaders() {}

  write(frame) {
    this.frames.push(frame);
    return false;
  }

  destroy() {
    this.destroyed = true;
    this.writableEnded = true;
    this.emit("close");
  }

  end() {
    this.writableEnded = true;
    this.emit("close");
  }
}

class FastResponse extends SlowResponse {
  write(frame) {
    this.frames.push(frame);
    return true;
  }
}

test("releases snapshot dedupe history before long-lived live delivery", async () => {
  const store = new EventStore(":memory:");
  const hub = new SseHub({ store, heartbeatMs: 60_000 });
  const response = new FastResponse();
  const request = new EventEmitter();
  request.headers = {};

  hub.handle(request, response);
  hub.publish(event("evt_live_repeat"));
  hub.publish(event("evt_live_repeat"));

  assert.equal(response.frames.length, 2);
  await hub.close();
  store.close();
});

test("destroys a blocked response when its bounded queue overflows", async () => {
  const store = new EventStore(":memory:");
  const hub = new SseHub({ store, heartbeatMs: 60_000, sseMaxQueue: 2 });
  const response = new SlowResponse();
  const request = new EventEmitter();
  request.headers = {};

  hub.handle(request, response);
  hub.publish(event("evt_1"));
  hub.publish(event("evt_2"));
  hub.publish(event("evt_3"));
  hub.publish(event("evt_4"));

  assert.equal(response.destroyed, true);
  assert.equal(hub.clientCount, 0);
  await hub.close();
  store.close();
});
