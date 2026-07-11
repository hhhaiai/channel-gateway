const MIN_RATE_PER_SECOND = 0.01;
const MAX_RATE_PER_SECOND = 1_000;
const MAX_BURST = 10_000;

function nonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function rate(name, value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < MIN_RATE_PER_SECOND ||
    value > MAX_RATE_PER_SECOND
  ) {
    throw new RangeError(`${name} must be between 0.01 and 1000`);
  }
  return value;
}

function burst(name, value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BURST) {
    throw new RangeError(`${name} must be an integer between 1 and 10000`);
  }
  return value;
}

function accountDescriptor(value, name = "account") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return {
    channel: nonEmptyString(`${name}.channel`, value.channel),
    accountId: nonEmptyString(`${name}.accountId`, value.accountId),
  };
}

function accountKey(account) {
  return JSON.stringify([account.channel, account.accountId]);
}

function policy(value, name) {
  return {
    ratePerSecond: rate(`${name}.ratePerSecond`, value.ratePerSecond),
    burst: burst(`${name}.burst`, value.burst),
  };
}

export class AccountRateLimiter {
  constructor({
    ratePerSecond = 5,
    burst: defaultBurst = 10,
    overrides = [],
    now = Date.now,
  } = {}) {
    if (typeof now !== "function") {
      throw new TypeError("now must be a function");
    }
    if (!Array.isArray(overrides)) {
      throw new TypeError("overrides must be an array");
    }
    if (overrides.length > 10_000) {
      throw new RangeError("overrides must contain at most 10000 entries");
    }
    this.defaultPolicy = policy({ ratePerSecond, burst: defaultBurst }, "default policy");
    this.overrides = new Map();
    for (const [index, value] of overrides.entries()) {
      const account = accountDescriptor(value, `overrides[${index}]`);
      const key = accountKey(account);
      if (this.overrides.has(key)) {
        throw new TypeError(`duplicate account rate limit: ${account.channel}/${account.accountId}`);
      }
      this.overrides.set(key, {
        account,
        ...policy(value, `overrides[${index}]`),
      });
    }
    this.now = now;
    this.states = new Map();
  }

  #state(accountInput, nowMs) {
    const account = accountDescriptor(accountInput);
    const key = accountKey(account);
    let state = this.states.get(key);
    if (!state) {
      const configured = this.overrides.get(key) ?? this.defaultPolicy;
      state = {
        account,
        ratePerSecond: configured.ratePerSecond,
        burst: configured.burst,
        tokens: configured.burst,
        updatedAtMs: nowMs,
        blockedUntilMs: null,
      };
      this.states.set(key, state);
    }
    this.#refill(state, nowMs);
    return state;
  }

  #refill(state, nowMs) {
    if (!Number.isSafeInteger(nowMs)) {
      throw new RangeError("now must return a safe integer");
    }
    if (nowMs > state.updatedAtMs) {
      const elapsedMs = nowMs - state.updatedAtMs;
      state.tokens = Math.min(
        state.burst,
        state.tokens + elapsedMs * state.ratePerSecond / 1_000,
      );
      state.updatedAtMs = nowMs;
    }
    if (state.blockedUntilMs !== null && nowMs >= state.blockedUntilMs) {
      state.blockedUntilMs = null;
    }
  }

  tryAcquire(account, nowMs = this.now()) {
    const state = this.#state(account, nowMs);
    if (state.blockedUntilMs !== null || state.tokens < 1) {
      return false;
    }
    state.tokens -= 1;
    return true;
  }

  unavailableAccounts(nowMs = this.now()) {
    const unavailable = [];
    for (const state of this.states.values()) {
      this.#refill(state, nowMs);
      if (state.blockedUntilMs !== null || state.tokens < 1) {
        unavailable.push({ ...state.account });
      }
    }
    return unavailable;
  }

  block(account, untilMs, nowMs = this.now()) {
    if (!Number.isSafeInteger(untilMs) || untilMs <= nowMs) {
      throw new RangeError("untilMs must be a safe integer later than now");
    }
    const state = this.#state(account, nowMs);
    state.blockedUntilMs = Math.max(state.blockedUntilMs ?? 0, untilMs);
  }

  snapshot(nowMs = this.now()) {
    return [...this.states.values()].map((state) => {
      this.#refill(state, nowMs);
      return {
        ...state.account,
        tokens: Number(state.tokens.toFixed(6)),
        ratePerSecond: state.ratePerSecond,
        burst: state.burst,
        blockedUntilMs: state.blockedUntilMs,
        available: state.blockedUntilMs === null && state.tokens >= 1,
      };
    });
  }
}
