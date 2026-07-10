const CONTROLLED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SEND_KEYS = new Set([
  "to",
  "message",
  "mediaUrl",
  "mediaUrls",
  "buffer",
  "filename",
  "contentType",
  "asVoice",
  "gifPlayback",
  "channel",
  "accountId",
  "agentId",
  "replyToId",
  "threadId",
  "forceDocument",
  "silent",
  "parseMode",
  "sessionKey",
  "idempotencyKey",
]);
const LIFECYCLE_KEYS = new Set(["channel", "accountId"]);
const STATUS_KEYS = new Set(["probe", "timeoutMs", "channel"]);

function plainObject(name, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`unknown request key: ${key}`);
    }
  }
}

function requiredString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function optionalString(name, value) {
  if (value !== undefined) {
    requiredString(name, value);
  }
}

function optionalBoolean(name, value) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
}

function optionalStringArray(name, value) {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    throw new TypeError(`${name} must be an array of strings`);
  }
}

function validateStatus(input = {}) {
  plainObject("status params", input);
  rejectUnknownKeys(input, STATUS_KEYS);
  optionalBoolean("probe", input.probe);
  optionalString("channel", input.channel);
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0)
  ) {
    throw new TypeError("timeoutMs must be a non-negative safe integer");
  }
  return { ...input };
}

function validateLifecycle(input) {
  plainObject("lifecycle params", input);
  rejectUnknownKeys(input, LIFECYCLE_KEYS);
  requiredString("channel", input.channel);
  optionalString("accountId", input.accountId);
  return { ...input };
}

function validateSend(input) {
  plainObject("message body", input);
  rejectUnknownKeys(input, SEND_KEYS);
  requiredString("channel", input.channel);
  requiredString("to", input.to);
  requiredString("idempotencyKey", input.idempotencyKey);

  for (const name of [
    "accountId",
    "mediaUrl",
    "buffer",
    "filename",
    "contentType",
    "agentId",
    "replyToId",
    "threadId",
    "sessionKey",
  ]) {
    optionalString(name, input[name]);
  }
  if (input.message !== undefined && typeof input.message !== "string") {
    throw new TypeError("message must be a string");
  }
  optionalStringArray("mediaUrls", input.mediaUrls);
  for (const name of ["asVoice", "gifPlayback", "forceDocument", "silent"]) {
    optionalBoolean(name, input[name]);
  }
  if (input.parseMode !== undefined && input.parseMode !== "HTML") {
    throw new TypeError('parseMode must be "HTML"');
  }
  return structuredClone(input);
}

function controlledCode(value) {
  return typeof value === "string" && CONTROLLED_CODE.test(value)
    ? value
    : "GATEWAY_RPC_FAILED";
}

export class GatewayRpcError extends Error {
  constructor(error = {}) {
    const code = controlledCode(error.code);
    const message = typeof error.message === "string" && error.message.trim() !== ""
      ? error.message
      : `Gateway RPC failed (${code})`;
    super(message);
    this.name = "GatewayRpcError";
    this.code = code;
    this.details = error.details;
    this.retryable = typeof error.retryable === "boolean" ? error.retryable : false;
    if (
      Number.isSafeInteger(error.retryAfterMs) &&
      error.retryAfterMs >= 0
    ) {
      this.retryAfterMs = error.retryAfterMs;
    }
  }
}

async function invoke(dispatch, method, params, timeoutMs) {
  let response;
  let timeout;
  try {
    response = await Promise.race([
      Promise.resolve().then(() =>
        dispatch(method, params, { expectFinal: true, timeoutMs })),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new GatewayRpcError({
            code: "GATEWAY_TIMEOUT",
            message: "Gateway dispatch timed out",
            retryable: true,
          }));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof GatewayRpcError) {
      throw error;
    }
    throw new GatewayRpcError({
      code: "GATEWAY_DISPATCH_FAILED",
      message: "Gateway dispatch failed",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (response?.ok === true) {
    return response.payload;
  }
  throw new GatewayRpcError(response?.error);
}

export function createGatewayRpc(dispatch, { timeoutMs = 30_000 } = {}) {
  if (typeof dispatch !== "function") {
    throw new TypeError("dispatch must be a function");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }

  return Object.freeze({
    status: async (params) => invoke(dispatch, "channels.status", validateStatus(params), timeoutMs),
    start: async (params) => invoke(dispatch, "channels.start", validateLifecycle(params), timeoutMs),
    stop: async (params) => invoke(dispatch, "channels.stop", validateLifecycle(params), timeoutMs),
    logout: async (params) => invoke(dispatch, "channels.logout", validateLifecycle(params), timeoutMs),
    send: async (params) => invoke(dispatch, "send", validateSend(params), timeoutMs),
  });
}
