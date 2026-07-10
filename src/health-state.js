function requireErrorCode(code) {
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    throw new TypeError("code must be a controlled uppercase error code");
  }
}

export class HealthState {
  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") {
      throw new TypeError("now must be a function");
    }

    this.now = now;
    this.state = { status: "ok" };
  }

  degrade(code) {
    requireErrorCode(code);
    this.state = {
      status: "degraded",
      degradedAt: this.now(),
      code,
    };
  }

  recover() {
    this.state = { status: "ok" };
  }

  snapshot() {
    return { ...this.state };
  }
}
