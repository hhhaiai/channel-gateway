import assert from "node:assert/strict";
import test from "node:test";

import {
  DELIVERY_CONCURRENCY_HARD_MAX,
  DELIVERY_CONCURRENCY_AUTO_MAX,
  deriveDeliveryMaxConcurrency,
  detectRuntimeResources,
  resolveDeliveryMaxConcurrency,
} from "../src/resource-limits.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

test("prefers constrained memory over host total memory", () => {
  assert.deepEqual(detectRuntimeResources({
    availableParallelism: () => 2,
    constrainedMemory: () => 512 * MIB,
    totalMemory: () => 64 * GIB,
  }), {
    cpuCount: 2,
    memoryLimitBytes: 512 * MIB,
    memorySource: "constraint",
  });
});

test("falls back to host memory when no process constraint is visible", () => {
  assert.deepEqual(detectRuntimeResources({
    availableParallelism: () => 8,
    constrainedMemory: () => 0,
    totalMemory: () => 16 * GIB,
  }), {
    cpuCount: 8,
    memoryLimitBytes: 16 * GIB,
    memorySource: "host",
  });
});

test("rejects invalid runtime resource probes", () => {
  for (const fixture of [
    { availableParallelism: () => 0, constrainedMemory: () => 0, totalMemory: () => GIB },
    { availableParallelism: () => 1.5, constrainedMemory: () => 0, totalMemory: () => GIB },
    { availableParallelism: () => 1, constrainedMemory: () => 0, totalMemory: () => 0 },
  ]) {
    assert.throws(() => detectRuntimeResources(fixture));
  }
});

test("derives conservative delivery concurrency from CPU and memory", () => {
  for (const [cpuCount, memoryLimitBytes, expected] of [
    [1, 256 * MIB, 1],
    [1, 512 * MIB, 2],
    [2, 4 * GIB, 4],
    [8, 8 * GIB, 8],
    [32, 128 * GIB, 8],
  ]) {
    assert.equal(
      deriveDeliveryMaxConcurrency({ cpuCount, memoryLimitBytes }),
      expected,
    );
  }
  assert.equal(DELIVERY_CONCURRENCY_HARD_MAX, 256);
  assert.equal(DELIVERY_CONCURRENCY_AUTO_MAX, 8);
});

test("resolves plugin config before environment and detected defaults", () => {
  const resources = { cpuCount: 2, memoryLimitBytes: 4 * GIB, memorySource: "host" };

  assert.deepEqual(resolveDeliveryMaxConcurrency({
    configured: 12,
    env: { CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY: "8" },
    resources,
  }), { value: 12, source: "config", resources });

  assert.deepEqual(resolveDeliveryMaxConcurrency({
    env: { CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY: "8" },
    resources,
  }), { value: 8, source: "environment", resources });

  assert.deepEqual(resolveDeliveryMaxConcurrency({
    env: { CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY: "   " },
    resources,
  }), { value: 4, source: "detected", resources });
});

test("rejects ambiguous or out-of-range concurrency overrides", () => {
  const resources = { cpuCount: 2, memoryLimitBytes: 4 * GIB, memorySource: "host" };
  for (const value of ["0", "-1", "+4", "1.5", "0x10", "12jobs", "257", "9007199254740992"]) {
    assert.throws(() => resolveDeliveryMaxConcurrency({
      env: { CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY: value },
      resources,
    }), /CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY/);
  }
  for (const configured of [0, 257, 1.5, "4"]) {
    assert.throws(() => resolveDeliveryMaxConcurrency({ configured, resources }), /configured/);
  }
});
