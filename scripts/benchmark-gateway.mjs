import { pathToFileURL } from "node:url";

import { DeliveryWorker } from "../src/delivery-worker.js";
import { EventStore } from "../src/event-store.js";
import { compileLinks, planFanout } from "../src/route-links.js";

function integer(name, value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function benchmarkOptions(input = {}) {
  return {
    platforms: integer("platforms", input.platforms ?? 20, 1, 100),
    groupsPerPlatform: integer("groupsPerPlatform", input.groupsPerPlatform ?? 10, 1, 100),
    events: integer("events", input.events ?? 100, 1, 10_000),
    maxConcurrency: integer("maxConcurrency", input.maxConcurrency ?? 32, 1, 256),
    maxConcurrencyPerAccount: integer(
      "maxConcurrencyPerAccount",
      input.maxConcurrencyPerAccount ?? 2,
      1,
      64,
    ),
    aggregationMaxItems: integer("aggregationMaxItems", input.aggregationMaxItems ?? 20, 2, 100),
    aggregationMaxBytes: integer("aggregationMaxBytes", input.aggregationMaxBytes ?? 32_768, 1_024, 262_144),
    providerLatencyMs: integer("providerLatencyMs", input.providerLatencyMs ?? 1, 0, 60_000),
  };
}

function makeLinks(platforms, groupsPerPlatform) {
  const endpoints = [];
  for (let platform = 0; platform < platforms; platform += 1) {
    for (let group = 0; group < groupsPerPlatform; group += 1) {
      endpoints.push({
        id: `endpoint-${platform}-${group}`,
        channel: `platform-${platform}`,
        accountId: `bot-${platform}`,
        conversationId: `group-${platform}-${group}`,
        to: `group-${platform}-${group}`,
      });
    }
  }
  return compileLinks([{ id: "super-group", endpoints }]);
}

function eventAt(index) {
  return {
    id: `event-${index}`,
    channel: "platform-0",
    accountId: "bot-0",
    conversationId: "group-0-0",
    messageId: `message-${index}`,
    sender: { id: `user-${index % 100}`, name: `User ${index % 100}`, username: null },
    text: `benchmark message ${index}`,
    threadId: null,
    replyTo: null,
    media: [],
    isGroup: true,
    metadata: {},
    receivedAt: new Date(1_000 + index).toISOString(),
  };
}

function wait(ms) {
  return ms === 0
    ? new Promise((resolve) => setImmediate(resolve))
    : new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBenchmark(input = {}) {
  const options = benchmarkOptions(input);
  const links = makeLinks(options.platforms, options.groupsPerPlatform);
  const endpoints = options.platforms * options.groupsPerPlatform;
  const fanoutPerEvent = endpoints - 1;
  const fanoutDeliveries = fanoutPerEvent * options.events;
  const store = new EventStore(":memory:", { now: () => 1_000 });
  const memoryBefore = process.memoryUsage();

  for (let index = 0; index < options.events; index += 1) {
    const event = eventAt(index);
    const deliveries = planFanout({ event, links }).map((delivery) => ({
      ...delivery,
      nextAttemptAtMs: 2_000,
    }));
    store.enqueue(event, { deliveries });
  }

  let providerCalls = 0;
  let active = 0;
  let maxObservedConcurrency = 0;
  const activeAccounts = new Map();
  let maxObservedConcurrencyPerAccount = 0;
  let leaseSequence = 0;
  const worker = new DeliveryWorker({
    store,
    now: () => 2_000,
    maxConcurrency: options.maxConcurrency,
    maxConcurrencyPerAccount: options.maxConcurrencyPerAccount,
    maxBatchSize: Math.max(1, fanoutDeliveries),
    leaseTokenFactory: () => `benchmark-lease-${++leaseSequence}`,
    aggregation: {
      enabled: true,
      windowMs: 1_000,
      maxItems: options.aggregationMaxItems,
      maxBytes: options.aggregationMaxBytes,
    },
    async sender(request) {
      providerCalls += 1;
      active += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, active);
      const key = JSON.stringify([request.channel, request.accountId ?? "default"]);
      const accountActive = (activeAccounts.get(key) ?? 0) + 1;
      activeAccounts.set(key, accountActive);
      maxObservedConcurrencyPerAccount = Math.max(
        maxObservedConcurrencyPerAccount,
        accountActive,
      );
      await wait(options.providerLatencyMs);
      active -= 1;
      const currentAccountActive = activeAccounts.get(key);
      if (currentAccountActive === 1) activeAccounts.delete(key);
      else activeAccounts.set(key, currentAccountActive - 1);
      return { messageId: `provider-${providerCalls}` };
    },
  });

  const started = process.hrtime.bigint();
  while (true) {
    await worker.tick();
    const counts = store.deliveryCounts();
    if (counts.pending === 0 && counts.sending === 0) break;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const deliveryCounts = store.deliveryCounts();
  const memoryAfter = process.memoryUsage();
  store.close();

  return {
    ...options,
    endpoints,
    fanoutPerEvent,
    fanoutDeliveries,
    providerCalls,
    aggregationReductionRatio: Number(
      (1 - providerCalls / Math.max(1, fanoutDeliveries)).toFixed(6),
    ),
    elapsedMs: Number(elapsedMs.toFixed(3)),
    deliveriesPerSecond: Number((fanoutDeliveries / (elapsedMs / 1_000)).toFixed(3)),
    providerCallsPerSecond: Number((providerCalls / (elapsedMs / 1_000)).toFixed(3)),
    maxObservedConcurrency,
    maxObservedConcurrencyPerAccount,
    deliveryCounts,
    rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
  };
}

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    const match = argument.match(/^--([a-z][a-zA-Z]*)=(\d+)$/);
    if (!match) throw new TypeError(`invalid benchmark argument: ${argument}`);
    values[match[1]] = Number(match[2]);
  }
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runBenchmark(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
