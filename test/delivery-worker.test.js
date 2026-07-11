import assert from "node:assert/strict";
import test from "node:test";

import { AccountRateLimiter } from "../src/account-rate-limiter.js";
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
  destinationChannel: "feishu",
  destinationAccountId: "default",
  destinationConversationId: "oc_chat",
  request: {
    channel: "feishu",
    to: "oc_chat",
    message: "hello",
    idempotencyKey: "dlv_1",
  },
};

function destinationKey(delivery) {
  return JSON.stringify([
    delivery.destinationChannel,
    delivery.destinationAccountId,
    delivery.destinationConversationId,
  ]);
}

function createQueueStore(inputJobs) {
  const jobs = inputJobs.map((job) => structuredClone(job));
  const completed = [];
  const retried = [];
  return {
    completed,
    retried,
    claimNextDelivery({
      leaseToken,
      excludedDestinations = [],
      excludedAccounts = [],
    }) {
      const excluded = new Set(excludedDestinations.map((destination) => JSON.stringify([
        destination.channel,
        destination.accountId,
        destination.conversationId,
      ])));
      const accounts = new Set(excludedAccounts.map((account) => JSON.stringify([
        account.channel,
        account.accountId,
      ])));
      const index = jobs.findIndex((job) =>
        !excluded.has(destinationKey(job)) &&
        !accounts.has(JSON.stringify([job.destinationChannel, job.destinationAccountId])));
      if (index < 0) return undefined;
      const [job] = jobs.splice(index, 1);
      return { ...job, leaseToken };
    },
    completeDelivery(id) {
      completed.push(id);
      return { id, status: "sent" };
    },
    retryDelivery(id, options) {
      retried.push({ id, ...options });
      return { id, status: "pending" };
    },
  };
}

function queuedJob(id, conversationId, accountId = "default") {
  return {
    ...JOB,
    id,
    destinationAccountId: accountId,
    destinationConversationId: conversationId,
    request: {
      ...JOB.request,
      accountId,
      to: conversationId,
      idempotencyKey: id,
    },
  };
}

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

test("runs independent destinations concurrently up to the configured bound", async () => {
  const store = createQueueStore([
    queuedJob("dlv_a", "chat-a"),
    queuedJob("dlv_b", "chat-b"),
    queuedJob("dlv_c", "chat-c"),
  ]);
  const started = [];
  let active = 0;
  let maxActive = 0;
  const worker = new DeliveryWorker({
    store,
    maxConcurrency: 2,
    maxConcurrencyPerAccount: 2,
    maxBatchSize: 3,
    leaseTokenFactory: () => `lease-${started.length + 1}`,
    async sender(request) {
      started.push(request.idempotencyKey);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { messageId: `sent-${request.idempotencyKey}` };
    },
  });

  assert.equal(await worker.tick(), true);
  assert.deepEqual(started, ["dlv_a", "dlv_b", "dlv_c"]);
  assert.equal(maxActive, 2);
  assert.deepEqual(store.completed, ["dlv_a", "dlv_b", "dlv_c"]);
});

test("keeps the same destination serial while other destinations progress", async () => {
  const store = createQueueStore([
    queuedJob("dlv_a1", "shared"),
    queuedJob("dlv_a2", "shared"),
    queuedJob("dlv_b", "other"),
  ]);
  const started = [];
  const activeDestinations = new Set();
  let sameDestinationOverlap = false;
  let active = 0;
  let maxActive = 0;
  const worker = new DeliveryWorker({
    store,
    maxConcurrency: 3,
    maxConcurrencyPerAccount: 3,
    maxBatchSize: 3,
    async sender(request) {
      started.push(request.idempotencyKey);
      const conversationId = request.to;
      sameDestinationOverlap ||= activeDestinations.has(conversationId);
      activeDestinations.add(conversationId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      activeDestinations.delete(conversationId);
      return { messageId: "sent" };
    },
  });

  await worker.tick();
  assert.deepEqual(started, ["dlv_a1", "dlv_b", "dlv_a2"]);
  assert.equal(maxActive, 2);
  assert.equal(sameDestinationOverlap, false);
});

test("limits one account without blocking independent accounts", async () => {
  const store = createQueueStore([
    queuedJob("dlv_a1", "chat-a1", "account-a"),
    queuedJob("dlv_a2", "chat-a2", "account-a"),
    queuedJob("dlv_b", "chat-b", "account-b"),
  ]);
  const started = [];
  const activeByAccount = new Map();
  let maxActive = 0;
  let maxAccountA = 0;
  const worker = new DeliveryWorker({
    store,
    maxConcurrency: 3,
    maxConcurrencyPerAccount: 1,
    maxBatchSize: 3,
    async sender(request) {
      started.push(request.idempotencyKey);
      const accountId = request.accountId;
      const active = (activeByAccount.get(accountId) ?? 0) + 1;
      activeByAccount.set(accountId, active);
      maxActive = Math.max(maxActive, [...activeByAccount.values()].reduce((sum, n) => sum + n, 0));
      if (accountId === "account-a") maxAccountA = Math.max(maxAccountA, active);
      await new Promise((resolve) => setImmediate(resolve));
      activeByAccount.set(accountId, activeByAccount.get(accountId) - 1);
      return { messageId: "sent" };
    },
  });

  await worker.tick();

  assert.deepEqual(started, ["dlv_a1", "dlv_b", "dlv_a2"]);
  assert.equal(maxActive, 2);
  assert.equal(maxAccountA, 1);
});

test("requires per-account concurrency between one and 64", () => {
  for (const maxConcurrencyPerAccount of [0, 65, 1.5]) {
    assert.throws(() => new DeliveryWorker({
      store: createQueueStore([]),
      sender: async () => ({ messageId: "unused" }),
      maxConcurrencyPerAccount,
    }), /maxConcurrencyPerAccount/);
  }
});

test("pauses a burst-exhausted account while another account progresses", async () => {
  let now = 1_000;
  const rateLimiter = new AccountRateLimiter({
    ratePerSecond: 1,
    burst: 1,
    now: () => now,
  });
  const store = createQueueStore([
    queuedJob("dlv_a1", "chat-a1", "account-a"),
    queuedJob("dlv_a2", "chat-a2", "account-a"),
    queuedJob("dlv_b", "chat-b", "account-b"),
  ]);
  const worker = new DeliveryWorker({
    store,
    rateLimiter,
    maxConcurrency: 3,
    maxConcurrencyPerAccount: 2,
    maxBatchSize: 3,
    now: () => now,
    sender: async () => ({ messageId: "sent" }),
  });

  await worker.tick();
  assert.deepEqual(store.completed, ["dlv_a1", "dlv_b"]);

  now += 1_000;
  await worker.tick();
  assert.deepEqual(store.completed, ["dlv_a1", "dlv_b", "dlv_a2"]);
});

test("honors account cooldown from a controlled rate-limit error", async () => {
  let now = 1_000;
  const rateLimiter = new AccountRateLimiter({
    ratePerSecond: 100,
    burst: 100,
    now: () => now,
  });
  const store = createQueueStore([
    queuedJob("dlv_a1", "chat-a1", "account-a"),
    queuedJob("dlv_a2", "chat-a2", "account-a"),
    queuedJob("dlv_b", "chat-b", "account-b"),
  ]);
  const worker = new DeliveryWorker({
    store,
    rateLimiter,
    maxConcurrency: 3,
    maxConcurrencyPerAccount: 1,
    maxBatchSize: 3,
    now: () => now,
    async sender(request) {
      if (request.idempotencyKey === "dlv_a1") {
        throw Object.assign(new Error("rate limited"), {
          code: "RATE_LIMITED",
          retryable: true,
          retryAfterMs: 5_000,
        });
      }
      return { messageId: "sent" };
    },
  });

  await worker.tick();
  assert.deepEqual(store.completed, ["dlv_b"]);
  assert.equal(store.retried[0].id, "dlv_a1");

  now = 5_999;
  await worker.tick();
  assert.deepEqual(store.completed, ["dlv_b"]);

  now = 6_000;
  await worker.tick();
  assert.deepEqual(store.completed, ["dlv_b", "dlv_a2"]);
});

test("requires a finite delivery concurrency between one and 256", () => {
  for (const maxConcurrency of [0, 257, 1.5]) {
    assert.throws(() => new DeliveryWorker({
      store: createQueueStore([]),
      sender: async () => ({ messageId: "unused" }),
      maxConcurrency,
    }), /maxConcurrency/);
  }
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
