# Resource-Aware Delivery Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve delivery concurrency from explicit plugin config, environment variables, or container/host-visible resources while enforcing one shared finite hard limit.

**Architecture:** A small pure module owns resource detection, conservative default derivation, strict environment parsing, precedence, and source metadata. The OpenClaw plugin resolves the value before constructing the runtime; `DeliveryWorker` remains the final defensive validation boundary.

**Tech Stack:** Node.js `os.availableParallelism()`, `os.totalmem()`, `process.constrainedMemory()`, OpenClaw plugin config, Node test runner.

---

### Task 1: Lock the resource-budget formula

**Files:**
- Create: `test/resource-limits.test.js`
- Create: `src/resource-limits.js`

- [ ] **Step 1: Write failing tests for runtime detection**

Cover:

- Positive constrained memory wins over host total memory.
- Zero constrained memory falls back to host total memory.
- CPU and memory values must be positive safe integers.

- [ ] **Step 2: Write failing tests for conservative defaults**

Use this exact formula:

```text
cpuBound = availableParallelism × 2
memoryBound = floor(memoryLimitBytes / 256 MiB)
autoDefault = clamp(min(cpuBound, memoryBound, 32), 1, 256)
```

Verify representative values:

```text
1 CPU / 256 MiB  → 1
1 CPU / 512 MiB  → 2
2 CPU / 4 GiB    → 4
8 CPU / 8 GiB    → 8
32 CPU / 128 GiB → 8
```

- [ ] **Step 3: Write failing precedence and parsing tests**

Precedence:

```text
plugin config > CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY > detected default
```

Reject blank-significant, signed, decimal, hexadecimal, zero, negative, unsafe, and values above 256. An absent or whitespace-only environment value means no override.

- [ ] **Step 4: Implement the pure module**

Export:

```js
DELIVERY_CONCURRENCY_HARD_MAX
detectRuntimeResources()
deriveDeliveryMaxConcurrency()
resolveDeliveryMaxConcurrency()
```

`resolveDeliveryMaxConcurrency()` returns:

```js
{
  value,
  source: "config" | "environment" | "detected",
  resources,
}
```

- [ ] **Step 5: Run focused tests**

```bash
node --test test/resource-limits.test.js
```

Expected: all resource tests pass.

### Task 2: Resolve configuration at the plugin boundary

**Files:**
- Modify: `test/plugin-registration.test.js`
- Modify: `src/plugin.js`
- Modify: `openclaw.plugin.json`

- [ ] **Step 1: Add failing plugin tests**

Verify:

- Injected 2 CPU / 4 GiB resources produce default `4`.
- Environment value overrides detected default.
- Explicit plugin config overrides environment.
- Invalid environment input fails before runtime construction.

- [ ] **Step 2: Integrate the resolver**

Remove fixed `deliveryMaxConcurrency` from `DEFAULT_CONFIG`. Resolve it using `api.pluginConfig`, the provided environment, and an injectable resource probe, then include the resolved value in runtime options.

- [ ] **Step 3: Remove the misleading schema default**

Keep schema bounds `1..256`, but remove the fixed `default: 4`; otherwise OpenClaw may materialize a value that prevents runtime detection.

- [ ] **Step 4: Run focused plugin and runtime tests**

```bash
node --test test/resource-limits.test.js test/plugin-registration.test.js test/bridge-runtime.test.js
```

Expected: all focused tests pass.

### Task 3: Document exact behavior and verify the block

**Files:**
- Create: `docs/资源感知并发配置实现.md`
- Verify: all files in this block

- [ ] **Step 1: Document formula and precedence**

Document host vs container detection, the exact formula, the environment variable, plugin configuration, hard limits, examples, failure behavior, and the boundary with later web-console work.

- [ ] **Step 2: Run all gates**

```bash
npm run check
npm test
git diff --check
```

Expected: syntax/import check passes, full tests have zero failures, and no whitespace errors exist.

- [ ] **Step 3: Commit only this resource-resolution block**

```text
Keep delivery concurrency inside the resources actually available

Resolve a conservative pool size from container or host CPU and memory while
allowing strict environment and plugin overrides within one finite hard limit.

Constraint: Docker must use container-visible resources rather than host assumptions
Constraint: Every source must remain inside 1..256
Rejected: Keep a fixed default of four | ignores both constrained and larger deployments
Rejected: Treat environment input as permissive JavaScript numbers | accepts ambiguous values
Confidence: high
Scope-risk: narrow
Reversibility: clean
Directive: Add web-console editing and provider rate limits in separate commits
Tested: Resource unit tests, plugin precedence tests, npm run check, and full npm test
Not-tested: Real cgroup variants require later Docker matrix verification
```
