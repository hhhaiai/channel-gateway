# WeCom Plugin Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load the official WeCom plugin even when its plugin ID differs from its Channel ID, then expose `wecom` as a first-class links endpoint.

**Architecture:** Discovery returns a plugin descriptor with a distinct `pluginId` and `channelIds`. OpenClaw plugin activation uses `pluginId`, while Channel routing and ownership use `channelIds`; existing official packages where both values match keep the same behavior. The pinned WeCom package is optional, and the console distinguishes WeCom groups from Tencent Weixin direct messages.

**Tech Stack:** Node.js ESM, `node:test`, OpenClaw `2026.6.11`, `@wecom/wecom-openclaw-plugin@2026.5.25`.

---

### Task 1: Lock plugin/channel identity behavior

**Files:**
- Modify: `test/launcher-channel-packages.test.js`
- Modify: `test/launcher-config.test.js`

- [x] Add a discovery test whose manifest has `id: "wecom-openclaw-plugin"`, `channels: ["wecom"]`, and package metadata Channel ID `wecom`; expect `{ pluginId, channelIds }`.
- [x] Add duplicate plugin-ID and duplicate Channel-owner rejection cases.
- [x] Add initial/existing config tests proving `plugins.entries` uses `wecom-openclaw-plugin`, while the descriptor retains Channel ID `wecom`.
- [x] Run the focused tests and verify they fail because the launcher still assumes one `id`.

### Task 2: Separate plugin activation from Channel ownership

**Files:**
- Modify: `src/launcher/channel-packages.js`
- Modify: `src/launcher/config.js`

- [x] Validate a non-empty, unique `manifest.channels` list independently from `manifest.id`.
- [x] Require optional `package.json#openclaw.channel.id` to belong to `manifest.channels`.
- [x] Return `{ pluginId, channelIds, name, version, rootDir }` and reject duplicate plugin IDs or duplicate Channel ownership across different plugin roots.
- [x] Enable and validate `plugins.entries[pluginId]`; detect special Channel behavior such as WhatsApp through `channelIds`.
- [x] Run focused launcher tests until green, preserving existing matching-ID behavior.

### Task 3: Pin and surface the WeCom integration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `ui/channel-gateway.js`
- Modify: `test/console-assets.test.js`

- [x] Add `@wecom/wecom-openclaw-plugin@2026.5.25` as an exact optional dependency.
- [x] Replace the ambiguous generic WeChat catalog entry with separate `openclaw-weixin` direct-message and `wecom` group-capable entries.
- [x] Add console asset assertions for both Channel IDs.
- [x] Run package/console focused tests.

### Task 4: Document installation and links usage

**Files:**
- Modify: `README.md`
- Modify: `操作手册.md`
- Modify: `逐渠道对接操作指南.md`
- Modify: `docs/微信群接入可行性分析.md`

- [x] Document the exact pinned package, `plugins.entries["wecom-openclaw-plugin"]`, and links `channel: "wecom"` distinction.
- [x] Add a minimal WeCom-to-other-Channel links example and the `chatid`/mention/rate-limit boundaries.
- [x] Remove the statement that launcher compatibility is still missing.

### Task 5: Verify the integrated result

**Files:**
- Modify: `task_plan.md`
- Modify: `progress.md`

- [x] Run `node --test --test-concurrency=1 test/launcher-channel-packages.test.js test/launcher-config.test.js test/console-assets.test.js`.
- [x] Run `npm run check`, `npm test`, `git diff --check`, and the Markdown fence/link checker already used by this repository.
- [x] Inspect `git diff` and record remaining live-tenant gaps: credentials, real `chatid`, group `@` callback, active push, media, reconnect, and platform rate-limit verification.

Verification evidence: `npm test` completed with 230 passed and 0 failed; the installed WeCom plugin loaded as `wecom-openclaw-plugin@2026.5.25`, registered Channel `wecom`, and `openclaw plugins doctor` reported no issues.
