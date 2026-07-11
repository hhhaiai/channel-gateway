const SEVERITY = Object.freeze({
  healthy: 0,
  recovering: 1,
  degraded: 2,
  unavailable: 3,
});

function nonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function safeTime(name, value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer${nullable ? " or null" : ""}`);
  }
  return value;
}

function accountDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("account must be an object");
  }
  return {
    channel: nonEmptyString("account.channel", value.channel),
    accountId: nonEmptyString("account.accountId", value.accountId),
  };
}

function accountKey(account) {
  return JSON.stringify([account.channel, account.accountId]);
}

function controlledCode(value) {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) {
    throw new TypeError("code must be a controlled uppercase error code");
  }
  return value;
}

function count(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function emptyState(account) {
  return {
    account,
    status: "healthy",
    errorCode: null,
    firstFailureAtMs: null,
    lastFailureAtMs: null,
    lastSuccessAtMs: null,
    nextRetryAtMs: null,
    recoverySuccesses: 0,
  };
}

export class DeliveryHealthProjection {
  constructor({ deliveryStats = () => [] } = {}) {
    if (typeof deliveryStats !== "function") {
      throw new TypeError("deliveryStats must be a function");
    }
    this.deliveryStats = deliveryStats;
    this.states = new Map();
  }

  #state(accountInput) {
    const account = accountDescriptor(accountInput);
    const key = accountKey(account);
    let state = this.states.get(key);
    if (!state) {
      state = emptyState(account);
      this.states.set(key, state);
    }
    return state;
  }

  recordFailure(account, { code, failedAtMs, nextRetryAtMs, terminal }) {
    const state = this.#state(account);
    const atMs = safeTime("failedAtMs", failedAtMs);
    state.status = terminal === true || state.status === "unavailable"
      ? "unavailable"
      : "degraded";
    state.errorCode = controlledCode(code);
    state.firstFailureAtMs ??= atMs;
    state.lastFailureAtMs = atMs;
    state.nextRetryAtMs = safeTime("nextRetryAtMs", nextRetryAtMs, { nullable: true });
    state.recoverySuccesses = 0;
  }

  recordSuccess(account, succeededAtMs) {
    const state = this.#state(account);
    state.lastSuccessAtMs = safeTime("succeededAtMs", succeededAtMs);
    state.nextRetryAtMs = null;
    if (state.status === "healthy") return;
    state.recoverySuccesses += 1;
    if (state.recoverySuccesses >= 2) {
      state.status = "healthy";
      state.errorCode = null;
      state.firstFailureAtMs = null;
      state.lastFailureAtMs = null;
      state.recoverySuccesses = 0;
    } else {
      state.status = "recovering";
    }
  }

  snapshot() {
    const statsByAccount = new Map();
    for (const raw of this.deliveryStats()) {
      const account = accountDescriptor(raw);
      statsByAccount.set(accountKey(account), {
        account,
        pending: count("pending", raw.pending),
        sending: count("sending", raw.sending),
        failed: count("failed", raw.failed),
        nextRetryAtMs: safeTime("nextRetryAtMs", raw.nextRetryAtMs, { nullable: true }),
      });
    }

    const keys = new Set([...this.states.keys(), ...statsByAccount.keys()]);
    const accounts = [...keys].map((key) => {
      const stats = statsByAccount.get(key);
      const state = this.states.get(key) ?? emptyState(stats.account);
      return {
        ...state.account,
        status: state.status,
        errorCode: state.errorCode,
        firstFailureAtMs: state.firstFailureAtMs,
        lastFailureAtMs: state.lastFailureAtMs,
        lastSuccessAtMs: state.lastSuccessAtMs,
        nextRetryAtMs: state.nextRetryAtMs ?? stats?.nextRetryAtMs ?? null,
        pending: stats?.pending ?? 0,
        sending: stats?.sending ?? 0,
        failed: stats?.failed ?? 0,
      };
    }).sort((left, right) =>
      left.channel.localeCompare(right.channel) || left.accountId.localeCompare(right.accountId));

    const channelMap = new Map();
    for (const account of accounts) {
      const current = channelMap.get(account.channel) ?? {
        channel: account.channel,
        status: "healthy",
        accounts: 0,
        pending: 0,
        sending: 0,
        failed: 0,
      };
      current.accounts += 1;
      current.pending += account.pending;
      current.sending += account.sending;
      current.failed += account.failed;
      if (SEVERITY[account.status] > SEVERITY[current.status]) {
        current.status = account.status;
      }
      channelMap.set(account.channel, current);
    }

    return {
      accounts,
      channels: [...channelMap.values()].sort((left, right) =>
        left.channel.localeCompare(right.channel)),
    };
  }
}
