import { randomUUID } from "node:crypto";

const GATEWAY_FAILURE_CACHE_MS = 301_000;

function positiveInteger(name, value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER
      ? "a positive integer"
      : `an integer between 1 and ${maximum}`;
    throw new RangeError(`${name} must be ${range}`);
  }
}

function destinationDescriptor(delivery) {
  return {
    channel: delivery.destinationChannel,
    accountId: delivery.destinationAccountId,
    conversationId: delivery.destinationConversationId,
  };
}

function destinationKey(destination) {
  return JSON.stringify([
    destination.channel,
    destination.accountId,
    destination.conversationId,
  ]);
}

function accountDescriptor(delivery) {
  return {
    channel: delivery.destinationChannel,
    accountId: delivery.destinationAccountId,
  };
}

function accountKey(account) {
  return JSON.stringify([account.channel, account.accountId]);
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
    maxConcurrency = 1,
    maxConcurrencyPerAccount = 1,
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
    positiveInteger("maxConcurrency", maxConcurrency, 256);
    positiveInteger("maxConcurrencyPerAccount", maxConcurrencyPerAccount, 64);

    this.store = store;
    this.sender = sender;
    this.pollMs = pollMs;
    this.maxAttempts = maxAttempts;
    this.leaseMs = leaseMs;
    this.maxBatchSize = maxBatchSize;
    this.maxConcurrency = maxConcurrency;
    this.maxConcurrencyPerAccount = maxConcurrencyPerAccount;
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

  #claimNext(excludedDestinations, excludedAccounts) {
    const nowMs = this.now();
    const leaseToken = this.leaseTokenFactory();
    return this.store.claimNextDelivery({
      nowMs,
      leaseMs: this.leaseMs,
      leaseToken,
      excludedDestinations,
      excludedAccounts,
    });
  }

  async #runClaimed(delivery) {
    const leaseToken = delivery.leaseToken;
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
    const activeDestinations = new Map();
    const activeAccounts = new Map();
    let claimedCount = 0;
    let completed = false;

    const runLane = async () => {
      while (claimedCount < this.maxBatchSize) {
        const saturatedAccounts = new Map(
          [...activeAccounts.entries()]
            .filter(([, state]) => state.count >= this.maxConcurrencyPerAccount)
            .map(([key, state]) => [key, state.account]),
        );
        const availableDestinationExclusions = [...activeDestinations.values()].filter(
          (destination) => !saturatedAccounts.has(accountKey(destination)),
        );
        const delivery = this.#claimNext(
          availableDestinationExclusions,
          [...saturatedAccounts.values()],
        );
        if (!delivery) {
          return;
        }
        claimedCount += 1;
        const destination = destinationDescriptor(delivery);
        const key = destinationKey(destination);
        const account = accountDescriptor(delivery);
        const activeAccountKey = accountKey(account);
        if (activeDestinations.has(key)) {
          throw new Error("store claimed an excluded destination");
        }
        const accountState = activeAccounts.get(activeAccountKey);
        if (accountState?.count >= this.maxConcurrencyPerAccount) {
          throw new Error("store claimed an excluded account");
        }
        activeDestinations.set(key, destination);
        activeAccounts.set(activeAccountKey, {
          account,
          count: (accountState?.count ?? 0) + 1,
        });
        try {
          const result = await this.#runClaimed(delivery);
          completed = result || completed;
        } finally {
          activeDestinations.delete(key);
          const currentAccount = activeAccounts.get(activeAccountKey);
          if (currentAccount.count === 1) {
            activeAccounts.delete(activeAccountKey);
          } else {
            activeAccounts.set(activeAccountKey, {
              account: currentAccount.account,
              count: currentAccount.count - 1,
            });
          }
        }
      }
    };

    const lanes = Array.from(
      { length: Math.min(this.maxConcurrency, this.maxBatchSize) },
      () => runLane(),
    );
    const results = await Promise.allSettled(lanes);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) {
      throw rejected.reason;
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
