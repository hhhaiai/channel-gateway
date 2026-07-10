import assert from "node:assert/strict";
import test from "node:test";

import { DeliveryWorker } from "../src/delivery-worker.js";

function createStore(job) {
  return {
    job,
    claims: [],
    completed: [],
    retried: [],
    claimNextDelivery(options) {
      this.claims.push(options);
      if (!this.job) return undefined;
      const claimed = { ...this.job, leaseToken: options.leaseToken };
      this.job = undefined;
      return claimed;
    },
    completeDelivery(id, options) {
      this.completed.push({ id, ...options });
      return { id, status: "sent" };
    },
    retryDelivery(id, options) {
      this.retried.push({ id, ...options });
      return { id, status: "pending" };
    },
  };
}

const JOB = {
  id: "dlv_1",
  attempts: 1,
  request: {
    channel: "feishu",
    to: "oc_chat",
    message: "hello",
    idempotencyKey: "dlv_1",
  },
};

test("claims, sends, and completes one delivery with the active lease", async () => {
  const store = createStore(JOB);
  const sent = [];
  const worker = new DeliveryWorker({
    store,
    sender: async (request) => {
      sent.push(request);
      return { messageId: "provider-message-1" };
    },
    now: () => 1_000,
    leaseTokenFactory: () => "lease-1",
  });

  assert.equal(await worker.tick(), true);
  assert.deepEqual(sent, [JOB.request]);
  assert.deepEqual(store.completed, [
    {
      id: JOB.id,
      leaseToken: "lease-1",
      messageId: "provider-message-1",
      completedAtMs: 1_000,
    },
  ]);
});

test("drains a bounded backlog sequentially in one tick", async () => {
  const jobs = [1, 2, 3].map((index) => ({
    ...JOB,
    id: `dlv_${index}`,
    request: { ...JOB.request, idempotencyKey: `dlv_${index}` },
  }));
  const completed = [];
  let claims = 0;
  const worker = new DeliveryWorker({
    store: {
      claimNextDelivery({ leaseToken }) {
        claims += 1;
        const job = jobs.shift();
        return job ? { ...job, leaseToken } : undefined;
      },
      completeDelivery(id) {
        completed.push(id);
        return { id, status: "sent" };
      },
      retryDelivery() {
        throw new Error("unexpected retry");
      },
    },
    sender: async () => ({ messageId: "sent" }),
    leaseTokenFactory: () => `lease-${claims + 1}`,
  });

  assert.equal(await worker.tick(), true);
  assert.deepEqual(completed, ["dlv_1", "dlv_2", "dlv_3"]);
  assert.equal(claims, 4);
});

test("treats a successful send without a receipt as sent without retrying", async () => {
  const store = createStore(JOB);
  const worker = new DeliveryWorker({
    store,
    sender: async () => ({ channel: "legacy-provider" }),
    now: () => 1_500,
    leaseTokenFactory: () => "lease-no-receipt",
  });

  assert.equal(await worker.tick(), true);
  assert.deepEqual(store.completed, [
    {
      id: JOB.id,
      leaseToken: "lease-no-receipt",
      messageId: null,
      completedAtMs: 1_500,
    },
  ]);
  assert.deepEqual(store.retried, []);
});

test("delays retry beyond the pinned Gateway failure cache", async () => {
  const store = createStore({ ...JOB, attempts: 2 });
  const error = Object.assign(new Error("hidden provider details"), {
    code: "PROVIDER_UNAVAILABLE",
    retryable: true,
    retryAfterMs: 5_000,
  });
  const worker = new DeliveryWorker({
    store,
    sender: async () => {
      throw error;
    },
    now: () => 10_000,
    maxAttempts: 5,
    leaseTokenFactory: () => "lease-2",
  });

  assert.equal(await worker.tick(), false);
  assert.equal(store.retried[0].code, "PROVIDER_UNAVAILABLE");
  assert.equal(store.retried[0].maxAttempts, 5);
  assert.equal(store.retried[0].nextAttemptAtMs >= 311_000, true);
  assert.equal(JSON.stringify(store.retried[0]).includes("hidden provider details"), false);
});

test("marks non-retryable failures terminal on the current attempt", async () => {
  const store = createStore({ ...JOB, attempts: 2 });
  const worker = new DeliveryWorker({
    store,
    sender: async () => {
      throw Object.assign(new Error("bad target"), {
        code: "INVALID_TARGET",
        retryable: false,
      });
    },
    now: () => 20_000,
    maxAttempts: 5,
    leaseTokenFactory: () => "lease-3",
  });

  await worker.tick();

  assert.equal(store.retried[0].maxAttempts, 2);
  assert.equal(store.retried[0].code, "INVALID_TARGET");
});

test("does not overlap ticks while a send is in flight", async () => {
  const store = createStore(JOB);
  let release;
  const sender = () => new Promise((resolve) => {
    release = () => resolve({ messageId: "provider-message-2" });
  });
  const worker = new DeliveryWorker({
    store,
    sender,
    now: () => 30_000,
    leaseTokenFactory: () => "lease-4",
  });

  const first = worker.tick();
  const second = worker.tick();
  assert.equal(first, second);
  assert.equal(store.claims.length, 1);
  release();
  await first;
});

test("start schedules polling and stop cancels the timer", async () => {
  const store = createStore(undefined);
  const timers = [];
  const cleared = [];
  const worker = new DeliveryWorker({
    store,
    sender: async () => ({ messageId: "unused" }),
    pollMs: 250,
    setTimer(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      cleared.push(timer);
    },
  });

  worker.start();
  assert.equal(timers[0].delay, 0);
  await timers[0].callback();
  assert.equal(timers[1].delay, 250);
  await worker.stop();
  assert.deepEqual(cleared, [timers[1]]);
});

test("scheduled polling survives a transient store exception", async () => {
  const timers = [];
  const worker = new DeliveryWorker({
    store: {
      claimNextDelivery() {
        throw new Error("database temporarily busy");
      },
    },
    sender: async () => ({ messageId: "unused" }),
    setTimer(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });

  worker.start();
  await assert.doesNotReject(() => timers[0].callback());
  assert.equal(timers[1].delay, 1_000);
  await worker.stop();
});
