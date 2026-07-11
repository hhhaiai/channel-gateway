# Console Delivery Concurrency Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators inspect effective delivery concurrency and its source, persist a bounded override, or clear it to restore environment/resource detection from the existing console.

**Architecture:** Extend the existing revision-protected configuration service so links and the optional concurrency override form one atomic editable document. The service resolves effective metadata from the already-tested resource module. The authenticated API remains backward compatible with clients that only submit links, while the browser sends the concurrency field explicitly.

**Tech Stack:** OpenClaw source config writer, authenticated HTTP API, dependency-free browser UI, Node test runner.

---

### Task 1: Extend the revisioned config service

**Files:**
- Modify: `test/links-config-service.test.js`
- Modify: `src/links-config-service.js`
- Modify: `src/plugin.js`

- [ ] Add failing tests for read metadata, explicit save, clearing to automatic, stale revision protection, and preservation of unrelated config.
- [ ] Include both links and nullable `deliveryMaxConcurrency` in the revision hash.
- [ ] Resolve and return effective value, source, hard maximum, CPU, memory bytes, and memory source.
- [ ] Treat `null` as delete override; treat an omitted field as preserve current override for API compatibility.
- [ ] Reuse `resolveDeliveryMaxConcurrency()` for every validation path.
- [ ] Pass one startup resource snapshot and environment into the config service from the plugin.
- [ ] Run `node --test test/links-config-service.test.js test/plugin-registration.test.js`.

### Task 2: Extend the authenticated API contract

**Files:**
- Modify: `test/api-handler.test.js`
- Modify: `src/api-handler.js`

- [ ] Add failing tests that GET returns concurrency metadata and PUT accepts nullable or integer concurrency.
- [ ] Continue requiring `links` and `revision`.
- [ ] Allow only the optional third key `deliveryMaxConcurrency`.
- [ ] Keep unknown fields and malformed values as controlled 400 errors.
- [ ] Run `node --test test/api-handler.test.js`.

### Task 3: Add the dependency-free console controls

**Files:**
- Modify: `test/console-assets.test.js`
- Modify: `ui/channel-gateway.html`
- Modify: `ui/channel-gateway.js`

- [ ] Add failing static-asset tests for the resource settings controls and save payload.
- [ ] Display effective concurrency, source, CPU, memory limit, and memory source.
- [ ] Add an automatic checkbox and bounded integer input.
- [ ] Disable the integer input in automatic mode.
- [ ] Send `null` to clear an override or an integer to persist one.
- [ ] Validate `1..hardMax` in the browser before saving.
- [ ] Preserve token-in-memory and authenticated API behavior.
- [ ] Run `node --test test/console-assets.test.js`.

### Task 4: Document, verify, and commit only this block

**Files:**
- Create: `docs/网页并发配置实现.md`
- Verify all modified files

- [ ] Document fields, precedence, revision behavior, restart semantics, browser validation, API examples, and security boundary.
- [ ] Run `npm run check`, `npm test`, and `git diff --check`.
- [ ] Confirm no Provider rate limiter, aggregation, AI, or notification logic is included.
- [ ] Commit with Lore trailers.
