import assert from "node:assert/strict";
import test from "node:test";

import { runBenchmark } from "../scripts/benchmark-gateway.mjs";

test("benchmarks bounded N-to-N fan-out with durable aggregation", async () => {
  const result = await runBenchmark({
    platforms: 3,
    groupsPerPlatform: 2,
    events: 4,
    maxConcurrency: 3,
    maxConcurrencyPerAccount: 1,
    aggregationMaxItems: 4,
    providerLatencyMs: 0,
  });

  assert.equal(result.endpoints, 6);
  assert.equal(result.fanoutDeliveries, 20);
  assert.equal(result.providerCalls, 5);
  assert.equal(result.aggregationReductionRatio, 0.75);
  assert.equal(result.maxObservedConcurrency <= 3, true);
  assert.equal(result.maxObservedConcurrencyPerAccount <= 1, true);
  assert.deepEqual(result.deliveryCounts, { pending: 0, sending: 0, sent: 20, failed: 0 });
});
