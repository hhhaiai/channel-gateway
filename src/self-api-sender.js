function nonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function controlledCode(value, fallback) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : fallback;
}

function controlledError(code, { retryable = false, retryAfterMs } = {}) {
  const error = new Error(`channel gateway request failed (${code})`);
  error.code = code;
  error.retryable = Boolean(retryable);
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    error.retryAfterMs = retryAfterMs;
  }
  error.controlled = true;
  return error;
}

export function createSelfApiSender({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  const endpoint = new URL("api/v1/messages", `${nonEmptyString("baseUrl", baseUrl).replace(/\/+$/, "")}/`).href;
  const bearerToken = nonEmptyString("token", token);
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  return async function send(request) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (response.ok && payload?.ok !== false) {
        return payload?.result ?? payload;
      }

      const details = payload?.error ?? {};
      const code = controlledCode(details.code, `SELF_API_HTTP_${response.status}`);
      throw controlledError(code, {
        retryable:
          details.retryable ?? (response.status === 429 || response.status >= 500),
        retryAfterMs: details.retryAfterMs,
      });
    } catch (error) {
      if (error?.controlled) {
        throw error;
      }
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw controlledError(timeout ? "SELF_API_TIMEOUT" : "SELF_API_UNAVAILABLE", {
        retryable: true,
      });
    }
  };
}
