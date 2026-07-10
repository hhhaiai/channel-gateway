import { randomUUID } from "node:crypto";

const GATEWAY_FAILURE_CACHE_MS = 301_000;

function positiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function controlledCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : "DELIVERY_FAILED";
}

export class DeliveryWorker {
  constructor({
    store,
    sender,
    pollMs = 1_000,
    maxAttempts = 5,
    leaseMs = 60_000,
    maxBatchSize = 100,
    now = Date.now,
    leaseTokenFactory = randomUUID,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    if (!store || typeof store.claimNextDelivery !== "function") {
      throw new TypeError("store must implement the delivery outbox contract");
    }
    if (typeof sender !== "function") {
      throw new TypeError("sender must be a function");
    }
    positiveInteger("pollMs", pollMs);
    positiveInteger("maxAttempts", maxAttempts);
    positiveInteger("leaseMs", leaseMs);
    positiveInteger("maxBatchSize", maxBatchSize);

    this.store = store;
    this.sender = sender;
    this.pollMs = pollMs;
    this.maxAttempts = maxAttempts;
    this.leaseMs = leaseMs;
    this.maxBatchSize = maxBatchSize;
    this.now = now;
    this.leaseTokenFactory = leaseTokenFactory;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.started = false;
    this.timer = null;
    this.activeTick = null;
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    this.#schedule(0);
  }

  tick() {
    if (this.activeTick) {
      return this.activeTick;
    }

    const active = this.#runBatch();
    this.activeTick = active.finally(() => {
      if (this.activeTick === active || this.activeTick === wrapped) {
        this.activeTick = null;
      }
    });
    const wrapped = this.activeTick;
    return wrapped;
  }

  async stop() {
    this.started = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    await this.activeTick;
  }

  async #runOne() {
    const nowMs = this.now();
    const leaseToken = this.leaseTokenFactory();
    const delivery = this.store.claimNextDelivery({
      nowMs,
      leaseMs: this.leaseMs,
      leaseToken,
    });
    if (!delivery) {
      return undefined;
    }

    try {
      const result = await this.sender(delivery.request);
      return Boolean(
        this.store.completeDelivery(delivery.id, {
          leaseToken,
          messageId: result?.messageId ?? null,
          completedAtMs: this.now(),
        }),
      );
    } catch (error) {
      const retryable = error?.retryable !== false;
      const exponentialMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, delivery.attempts - 1));
      const requestedMs = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0;
      const delayMs = Math.max(GATEWAY_FAILURE_CACHE_MS, exponentialMs, requestedMs);
      this.store.retryDelivery(delivery.id, {
        leaseToken,
        code: controlledCode(error?.code),
        nextAttemptAtMs: this.now() + delayMs,
        maxAttempts: retryable ? this.maxAttempts : delivery.attempts,
        updatedAtMs: this.now(),
      });
      return false;
    }
  }

  async #runBatch() {
    let completed = false;
    for (let index = 0; index < this.maxBatchSize; index += 1) {
      const result = await this.#runOne();
      if (result === undefined) {
        break;
      }
      completed ||= result;
    }
    return completed;
  }

  #schedule(delay) {
    this.timer = this.setTimer(async () => {
      this.timer = null;
      try {
        await this.tick();
      } catch {
        // A later poll retries store availability; no provider or message details are logged here.
      } finally {
        if (this.started) {
          this.#schedule(this.pollMs);
        }
      }
    }, delay);
  }
}
