import { createApiHandler } from "./api-handler.js";
import { CorrelationBuffer } from "./correlation-buffer.js";
import { DeliveryWorker } from "./delivery-worker.js";
import { EventStore } from "./event-store.js";
import { normalizeInboundEvent } from "./event-normalizer.js";
import { createGatewayRpc } from "./gateway-rpc.js";
import { HealthState } from "./health-state.js";
import { compileLinks, planFanout, stripBridgeMarker } from "./route-links.js";
import { SseHub } from "./sse-hub.js";

const HANDLED = Object.freeze({ handled: true });

function controlledCode(value, fallback) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : fallback;
}

function messageText(event) {
  for (const value of [event?.content, event?.text, event?.bodyForAgent, event?.body]) {
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function defaultHttpHandler(_request, response) {
  response.statusCode = 503;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ ok: false, error: { code: "API_NOT_READY" } }));
}

function isMarkerEcho(relation, event, context) {
  if (!relation) {
    return false;
  }
  const channel = context?.channelId ?? event?.channel;
  const accountId = context?.accountId ?? event?.accountId ?? "default";
  const conversationId = context?.conversationId ?? event?.conversationId;
  return Boolean(
    channel &&
      conversationId &&
      relation.destinationChannel === channel &&
      relation.destinationAccountId === accountId &&
      relation.destinationConversationId === conversationId,
  );
}

export function createBridgeRuntime({
  databasePath,
  store,
  links = [],
  logger = console,
  sender,
  now = Date.now,
  correlationTtlMs = 30_000,
  maxCorrelationEntries = 10_000,
  ackTtlMs = 300_000,
  failedTtlMs = 86_400_000,
  deliveryPollMs = 1_000,
  deliveryMaxAttempts = 5,
  deliveryLeaseMs = 60_000,
  bodyLimitBytes = 1_048_576,
  sseHeartbeatMs = 15_000,
  sseMaxQueue = 1_000,
  dispatchGatewayMethod,
  serviceVersion = "0.1.0",
  openclawVersion = "2026.6.11",
  httpHandler,
  eventPublisher,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  store ??= databasePath ? new EventStore(databasePath, { now }) : undefined;
  if (!store) {
    throw new TypeError("databasePath or store is required");
  }

  const compiledLinks = links?.sourceIndex ? links : compileLinks(links);
  const health = new HealthState({ now });
  const publisher = eventPublisher ?? (typeof store.listPending === "function"
    ? new SseHub({
        store,
        heartbeatMs: sseHeartbeatMs,
        sseMaxQueue,
      })
    : undefined);
  const rpc = dispatchGatewayMethod ? createGatewayRpc(dispatchGatewayMethod) : undefined;
  const correlation = new CorrelationBuffer({
    ttlMs: correlationTtlMs,
    maxEntries: maxCorrelationEntries,
    now,
  });
  const worker = sender && compiledLinks.links.length > 0
    ? new DeliveryWorker({
        store,
        sender,
        pollMs: deliveryPollMs,
        maxAttempts: deliveryMaxAttempts,
        leaseMs: deliveryLeaseMs,
        now,
      })
    : undefined;
  let closed = false;
  let closePromise;
  let maintenanceTimer;

  const publish = (event) => publisher?.publish?.(event);
  store.on?.("pending", publish);

  const resolvedHttpHandler = httpHandler ?? (rpc
    ? createApiHandler({
        store,
        health,
        rpc,
        sseHub: publisher,
        links: compiledLinks,
        bodyLimitBytes,
        serviceVersion,
        openclawVersion,
      })
    : defaultHttpHandler);

  function onMessageReceived(event, context) {
    try {
      correlation.capture({ event, context });
    } catch (error) {
      logger.warn?.({
        component: "channel-gateway",
        code: controlledCode(error?.code, "CORRELATION_CAPTURE_FAILED"),
      });
    }
  }

  function onBeforeDispatch(event, context) {
    let canonical;
    try {
      const enrichment = correlation.take({ event, context });
      const marker = stripBridgeMarker(messageText(event));
      const markerRelation = marker.deliveryId
        ? store.findDeliveryByMarker?.(marker.deliveryId)
        : undefined;
      if (isMarkerEcho(markerRelation, event, context)) {
        return HANDLED;
      }

      canonical = normalizeInboundEvent({ event, context, enrichment, now });
      if (
        canonical.messageId &&
        store.findEcho?.({
          channel: canonical.channel,
          accountId: canonical.accountId,
          conversationId: canonical.conversationId,
          messageId: canonical.messageId,
        })
      ) {
        return HANDLED;
      }

      const replyTargets = store.resolveReplyTargets?.(canonical) ?? new Map();
      const deliveries = planFanout({
        event: canonical,
        links: compiledLinks,
        replyTargets,
      });
      store.enqueue(canonical, { deliveries });
      health.recover();
    } catch (error) {
      const code = controlledCode(error?.code, "PERSISTENCE_FAILED");
      health.degrade(code);
      logger.error?.({
        component: "channel-gateway",
        code,
        eventId: canonical?.id ?? null,
      });
    }
    return HANDLED;
  }

  function start() {
    if (closed) {
      return false;
    }
    worker?.start();
    if (!maintenanceTimer && typeof store.prune === "function") {
      maintenanceTimer = setIntervalFn(() => {
        try {
          store.prune({ ackTtlMs, failedTtlMs });
          health.recover();
        } catch (error) {
          const code = controlledCode(error?.code, "RETENTION_FAILED");
          health.degrade(code);
          logger.error?.({ component: "channel-gateway", code });
        }
      }, 60_000);
      maintenanceTimer?.unref?.();
    }
    return Boolean(worker || maintenanceTimer);
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    closePromise = (async () => {
      await worker?.stop();
      if (maintenanceTimer) {
        clearIntervalFn(maintenanceTimer);
        maintenanceTimer = undefined;
      }
      store.off?.("pending", publish);
      await publisher?.close?.();
      store.close?.();
    })();
    return closePromise;
  }

  return {
    store,
    health,
    correlation,
    links: compiledLinks,
    worker,
    handleHttp: resolvedHttpHandler,
    onMessageReceived,
    onBeforeDispatch,
    start,
    close,
    get closed() {
      return closed;
    },
  };
}
