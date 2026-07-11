import { availableParallelism, totalmem } from "node:os";

const MIB = 1024 * 1024;
const MEMORY_BYTES_PER_AUTO_LANE = 256 * MIB;
export const DELIVERY_CONCURRENCY_AUTO_MAX = 8;

export const DELIVERY_CONCURRENCY_HARD_MAX = 256;

function positiveSafeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function boundedConcurrency(name, value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > DELIVERY_CONCURRENCY_HARD_MAX
  ) {
    throw new RangeError(
      `${name} must be an integer between 1 and ${DELIVERY_CONCURRENCY_HARD_MAX}`,
    );
  }
  return value;
}

export function detectRuntimeResources({
  availableParallelism: readAvailableParallelism = availableParallelism,
  constrainedMemory: readConstrainedMemory = () => process.constrainedMemory?.() ?? 0,
  totalMemory: readTotalMemory = totalmem,
} = {}) {
  const cpuCount = positiveSafeInteger(
    "availableParallelism",
    readAvailableParallelism(),
  );
  const constrainedBytes = readConstrainedMemory();
  if (!Number.isSafeInteger(constrainedBytes) || constrainedBytes < 0) {
    throw new RangeError("constrainedMemory must be a non-negative safe integer");
  }
  const hasConstraint = constrainedBytes > 0;
  const memoryLimitBytes = positiveSafeInteger(
    hasConstraint ? "constrainedMemory" : "totalMemory",
    hasConstraint ? constrainedBytes : readTotalMemory(),
  );

  return {
    cpuCount,
    memoryLimitBytes,
    memorySource: hasConstraint ? "constraint" : "host",
  };
}

export function deriveDeliveryMaxConcurrency({ cpuCount, memoryLimitBytes }) {
  positiveSafeInteger("cpuCount", cpuCount);
  positiveSafeInteger("memoryLimitBytes", memoryLimitBytes);
  const cpuBound = cpuCount * 2;
  const memoryBound = Math.floor(memoryLimitBytes / MEMORY_BYTES_PER_AUTO_LANE);
  return Math.max(
    1,
    Math.min(
      cpuBound,
      memoryBound,
      DELIVERY_CONCURRENCY_AUTO_MAX,
      DELIVERY_CONCURRENCY_HARD_MAX,
    ),
  );
}

function environmentConcurrency(env) {
  const raw = env?.CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY;
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return undefined;
  }
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    throw new RangeError(
      `CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY must be an integer between 1 and ${DELIVERY_CONCURRENCY_HARD_MAX}`,
    );
  }
  return boundedConcurrency(
    "CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY",
    Number(raw),
  );
}

export function resolveDeliveryMaxConcurrency({
  configured,
  env = process.env,
  resources = detectRuntimeResources(),
} = {}) {
  if (configured !== undefined) {
    return {
      value: boundedConcurrency("configured deliveryMaxConcurrency", configured),
      source: "config",
      resources,
    };
  }

  const fromEnvironment = environmentConcurrency(env);
  if (fromEnvironment !== undefined) {
    return {
      value: fromEnvironment,
      source: "environment",
      resources,
    };
  }

  return {
    value: deriveDeliveryMaxConcurrency(resources),
    source: "detected",
    resources,
  };
}
