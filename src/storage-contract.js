export const GATEWAY_STORAGE_CONTRACT_VERSION = 1;

const CORE_METHODS = Object.freeze([
  "enqueue",
  "findEcho",
  "findDeliveryByMarker",
  "resolveReplyTargets",
  "close",
]);

const DELIVERY_METHODS = Object.freeze([
  "claimNextDelivery",
  "completeDelivery",
  "retryDelivery",
  "saveDeliveryTransform",
]);

const API_METHODS = Object.freeze([
  "listPending",
  "ack",
  "fail",
  "pendingCount",
  "deliveryCounts",
]);

export function assertGatewayStorage(store, { deliveries = false, api = false } = {}) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new TypeError("store must be a storage adapter object");
  }
  const required = [
    ...CORE_METHODS,
    ...(deliveries ? DELIVERY_METHODS : []),
    ...(api ? API_METHODS : []),
  ];
  const missing = required.filter((method) => typeof store[method] !== "function");
  if (missing.length > 0) {
    const error = new TypeError(`storage adapter is missing methods: ${missing.join(", ")}`);
    error.code = "INVALID_STORAGE_ADAPTER";
    throw error;
  }
  const capabilities = store.storageCapabilities?.();
  if (
    capabilities !== undefined &&
    capabilities.contractVersion !== GATEWAY_STORAGE_CONTRACT_VERSION
  ) {
    const error = new RangeError(
      `storage adapter contract version must be ${GATEWAY_STORAGE_CONTRACT_VERSION}`,
    );
    error.code = "UNSUPPORTED_STORAGE_CONTRACT";
    throw error;
  }
  return store;
}
