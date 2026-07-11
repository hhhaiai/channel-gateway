import { appendBridgeMarker, stripBridgeMarker } from "./route-links.js";

const TIMEOUT = Symbol("transform timeout");

function boundedInteger(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export class DeliveryTransformBoundary {
  constructor({
    transformer,
    timeoutMs = 5_000,
    maxBytes = 32_768,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (typeof transformer !== "function") {
      throw new TypeError("transformer must be a function");
    }
    if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
      throw new TypeError("timer functions are required");
    }
    this.transformer = transformer;
    this.timeoutMs = boundedInteger("timeoutMs", timeoutMs, 50, 30_000);
    this.maxBytes = boundedInteger("maxBytes", maxBytes, 1_024, 262_144);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.counts = { attempted: 0, transformed: 0, fallback: 0, timeouts: 0 };
  }

  async transform(delivery) {
    const original = structuredClone(delivery.request);
    if (!Array.isArray(delivery.aggregateMemberIds) || delivery.aggregateMemberIds.length < 2) {
      return original;
    }
    this.counts.attempted += 1;
    let timer;
    try {
      const visible = stripBridgeMarker(original.message);
      const timeout = new Promise((resolve) => {
        timer = this.setTimer(() => resolve(TIMEOUT), this.timeoutMs);
        timer?.unref?.();
      });
      const result = await Promise.race([
        Promise.resolve().then(() => this.transformer({
          message: visible.text,
          memberCount: delivery.aggregateMemberIds.length,
          channel: delivery.destinationChannel,
          accountId: delivery.destinationAccountId,
          conversationId: delivery.destinationConversationId,
        })),
        timeout,
      ]);
      if (result === TIMEOUT) {
        this.counts.timeouts += 1;
        this.counts.fallback += 1;
        return original;
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        this.counts.fallback += 1;
        return original;
      }
      if (typeof result.message !== "string" || result.message.trim() === "") {
        this.counts.fallback += 1;
        return original;
      }
      const output = stripBridgeMarker(result.message);
      if (output.deliveryId !== null) {
        this.counts.fallback += 1;
        return original;
      }
      const message = appendBridgeMarker(result.message, delivery.id);
      if (Buffer.byteLength(message) > this.maxBytes) {
        this.counts.fallback += 1;
        return original;
      }
      this.counts.transformed += 1;
      return { ...original, message };
    } catch {
      this.counts.fallback += 1;
      return original;
    } finally {
      if (timer !== undefined) this.clearTimer(timer);
    }
  }

  snapshot() {
    return { ...this.counts };
  }
}
