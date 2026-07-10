import { GatewayRpcError } from "./gateway-rpc.js";
import { HttpBodyError, readJsonBody } from "./http-utils.js";

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
const DELIVERY_STATES = ["pending", "sending", "sent", "failed"];

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) {
    response.setHeader(name, value);
  }
  response.end(JSON.stringify(payload));
}

function success(response, result, statusCode = 200) {
  sendJson(response, statusCode, { ok: true, result });
}

function failure(response, statusCode, code, metadata = {}, extraHeaders = {}) {
  sendJson(response, statusCode, {
    ok: false,
    error: {
      code,
      ...(metadata.retryable === true ? { retryable: true } : {}),
      ...(Number.isSafeInteger(metadata.retryAfterMs) && metadata.retryAfterMs >= 0
        ? { retryAfterMs: metadata.retryAfterMs }
        : {}),
    },
  }, extraHeaders);
}

function gatewayStatus(code) {
  if (code === "INVALID_REQUEST") {
    return 400;
  }
  if (code === "NOT_LINKED" || code === "NOT_PAIRED" || code.includes("CONFLICT")) {
    return 409;
  }
  if (code === "UNAVAILABLE" || code.endsWith("_UNAVAILABLE")) {
    return 503;
  }
  if (code.includes("TIMEOUT")) {
    return 504;
  }
  if (code === "NOT_FOUND" || code.endsWith("_NOT_FOUND")) {
    return 404;
  }
  return 502;
}

function positiveLimit(value) {
  if (value === null) {
    return DEFAULT_EVENT_LIMIT;
  }
  if (!/^\d+$/.test(value)) {
    throw new TypeError("limit must be an integer between 1 and 500");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
    throw new TypeError("limit must be an integer between 1 and 500");
  }
  return limit;
}

function probeValue(value) {
  if (value === null) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new TypeError("probe must be true or false");
}

function safeSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.trim() === "" || decoded.includes("/")) {
      throw new TypeError("invalid path segment");
    }
    return decoded;
  } catch {
    throw new TypeError("invalid path segment");
  }
}

function sanitizeLinks(status) {
  const input = status && typeof status === "object" ? status : {};
  const links = Array.isArray(input.links) ? input.links : [];
  const deliveryCounts = {};
  for (const state of DELIVERY_STATES) {
    const value = input.deliveryCounts?.[state];
    deliveryCounts[state] = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  return {
    links: links.map((link) => ({
      id: typeof link?.id === "string" ? link.id : "",
      endpoints: (Array.isArray(link?.endpoints) ? link.endpoints : []).map((endpoint) => ({
        id: typeof endpoint?.id === "string" ? endpoint.id : "",
        channel: typeof endpoint?.channel === "string" ? endpoint.channel : "",
        accountId: typeof endpoint?.accountId === "string" ? endpoint.accountId : "default",
        conversationId:
          typeof endpoint?.conversationId === "string" ? endpoint.conversationId : "",
      })),
    })),
    deliveryCounts,
  };
}

function derivedLinkStatus(links, store) {
  return () => ({
    links: Array.isArray(links?.links) ? links.links : Array.isArray(links) ? links : [],
    deliveryCounts: store.deliveryCounts?.() ?? {},
  });
}

function routeMethod(response, actual, expected) {
  if (actual === expected) {
    return true;
  }
  failure(response, 405, "METHOD_NOT_ALLOWED", {}, { allow: expected });
  return false;
}

export function createApiHandler({
  store,
  health,
  rpc: rpcInput,
  gatewayRpc,
  sseHub,
  eventStream,
  links,
  linkStatus,
  bodyLimitBytes = DEFAULT_BODY_LIMIT_BYTES,
  serviceVersion = "0.1.0",
  openclawVersion = "unknown",
}) {
  const rpc = rpcInput ?? gatewayRpc;
  const stream = sseHub ?? eventStream;
  if (!store || typeof store.listPending !== "function" || typeof store.ack !== "function") {
    throw new TypeError("store must implement the event API contract");
  }
  if (!health || typeof health.snapshot !== "function") {
    throw new TypeError("health must implement snapshot");
  }
  if (!rpc || typeof rpc.send !== "function") {
    throw new TypeError("rpc must implement the Gateway facade");
  }
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes < 1) {
    throw new RangeError("bodyLimitBytes must be a positive safe integer");
  }
  const getLinkStatus = typeof linkStatus === "function"
    ? linkStatus
    : derivedLinkStatus(links, store);

  return async function handleApi(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://channel-gateway.local");
      const { pathname } = url;

      if (pathname === "/api/v1/health") {
        if (!routeMethod(response, request.method, "GET")) return;
        const snapshot = health.snapshot();
        const statusCode = snapshot.status === "ok" ? 200 : 503;
        success(response, {
          ...snapshot,
          version: serviceVersion,
          openclawVersion,
          database: snapshot.status === "ok" ? "ok" : "degraded",
          pending: store.pendingCount(),
        }, statusCode);
        return;
      }

      if (pathname === "/api/v1/channels") {
        if (!routeMethod(response, request.method, "GET")) return;
        const probe = probeValue(url.searchParams.get("probe"));
        success(response, await rpc.status(probe === undefined ? {} : { probe }));
        return;
      }

      if (pathname === "/api/v1/links") {
        if (!routeMethod(response, request.method, "GET")) return;
        success(response, sanitizeLinks(await getLinkStatus()));
        return;
      }

      if (pathname === "/api/v1/messages") {
        if (!routeMethod(response, request.method, "POST")) return;
        const body = await readJsonBody(request, { limitBytes: bodyLimitBytes });
        success(response, await rpc.send(body));
        return;
      }

      if (pathname === "/api/v1/events") {
        if (!routeMethod(response, request.method, "GET")) return;
        const after = url.searchParams.get("after");
        if (after !== null && after.trim() === "") {
          throw new TypeError("after must be non-empty");
        }
        success(response, store.listPending({
          ...(after === null ? {} : { after }),
          limit: positiveLimit(url.searchParams.get("limit")),
        }));
        return;
      }

      if (pathname === "/api/v1/events/stream") {
        if (!routeMethod(response, request.method, "GET")) return;
        if (!stream || typeof stream.handle !== "function") {
          failure(response, 503, "EVENT_STREAM_UNAVAILABLE", { retryable: true });
          return;
        }
        stream.handle(request, response);
        return;
      }

      const ackMatch = pathname.match(/^\/api\/v1\/events\/([^/]+)\/ack$/);
      if (ackMatch) {
        if (!routeMethod(response, request.method, "POST")) return;
        const result = store.ack(safeSegment(ackMatch[1]));
        if (!result) {
          failure(response, 404, "EVENT_NOT_FOUND");
          return;
        }
        success(response, result);
        return;
      }

      const lifecycleMatch = pathname.match(
        /^\/api\/v1\/channels\/([^/]+)\/(start|stop|logout)$/,
      );
      if (lifecycleMatch) {
        if (!routeMethod(response, request.method, "POST")) return;
        const body = await readJsonBody(request, { limitBytes: bodyLimitBytes });
        if (Object.keys(body).some((key) => key !== "accountId")) {
          throw new TypeError("lifecycle body only accepts accountId");
        }
        const action = lifecycleMatch[2];
        success(response, await rpc[action]({
          channel: safeSegment(lifecycleMatch[1]),
          ...body,
        }));
        return;
      }

      failure(response, 404, "NOT_FOUND");
    } catch (error) {
      if (response.headersSent || response.writableEnded) {
        response.destroy?.();
        return;
      }
      if (error instanceof HttpBodyError) {
        failure(response, error.statusCode, error.code);
        return;
      }
      if (error instanceof GatewayRpcError) {
        failure(response, gatewayStatus(error.code), error.code, error);
        return;
      }
      if (error?.code === "UNKNOWN_CURSOR") {
        failure(response, 400, "UNKNOWN_CURSOR");
        return;
      }
      if (error instanceof TypeError || error instanceof RangeError) {
        failure(response, 400, "INVALID_REQUEST");
        return;
      }
      failure(response, 500, "INTERNAL_ERROR");
    }
  };
}
