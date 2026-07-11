# Channel Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供可安全保存 N↔N QQ/TG 互通房间的 Channel Gateway 控制台。

**Architecture:** 独立 links config service 只调用 Host runtime mutation；API 注入该服务；plugin 注册受限静态管理页；浏览器以内存 Bearer token 调用既有受保护 API。

**Tech Stack:** Node.js 22、OpenClaw plugin SDK、node:test、原生 HTML/CSS/JS。

---

### Task 1: 链接配置服务

**Files:** `src/links-config-service.js`, `test/links-config-service.test.js`

- [ ] 写 links revision、Host mutation、冲突与仅修改 links 的失败测试。
- [ ] 运行 `node --test test/links-config-service.test.js`，确认 feature 缺失而失败。
- [ ] 使用 `compileLinks` 与 `api.runtime.config.mutateConfigFile` 实现最小服务。
- [ ] 重跑测试并提交。

### Task 2: 配置 API

**Files:** `src/api-handler.js`, `test/api-handler.test.js`

- [ ] 写 `GET/PUT /api/v1/links/config`、400、409 和脱敏 `/links` 不变的失败测试。
- [ ] 实现严格 JSON body、revision 冲突映射与 `restartRequired` 响应。
- [ ] 运行 API tests 并提交。

### Task 3: 控制台静态资产与注册

**Files:** `src/console-assets.js`, `ui/channel-gateway.{html,css,js}`, `src/plugin.js`, `test/plugin-registration.test.js`, `test/console-assets.test.js`

- [ ] 写静态路由、CSP 和控制台可编辑 endpoint 的失败测试。
- [ ] 注册只提供静态内容的 plugin-auth route；保留 API 的 gateway auth。
- [ ] 写无依赖页面：内存 token、Channel 状态、官方接入说明、N endpoint 表单和保存提示。
- [ ] 运行相关 tests 并提交。

### Task 4: 操作文档与回归

**Files:** `README.md`, `操作手册.md`, `调用结构与使用说明.md`

- [ ] 增加入口、1↔N/N↔N 示例、重启步骤及 QQ/TG 官方接入说明。
- [ ] 运行 `npm test && npm run check && npm run verify:openclaw-patch` 和 standalone smoke。
- [ ] 提交 channel-gateway，再提交根仓库 gitlink 更新。
