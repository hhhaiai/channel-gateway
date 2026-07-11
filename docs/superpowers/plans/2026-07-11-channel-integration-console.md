# Channel Integration Console Implementation Plan

**Goal:** 在网页中提供全 OpenClaw Channel 的官方集成、状态、生命周期和互通入口。

**Architecture:** 原生 JS 保持零依赖；一个 Channel metadata catalog 渲染卡片；既有受认证 API 负责 status/start/stop/logout；Provider onboarding 保持官方 CLI/文档边界。

## 行为锁定

- `test/console-assets.test.js`：静态页面和 JS 包含卡片容器、完整目录、所有 Channel docs 路由与生命周期调用路径。
- `test/api-handler.test.js`：既有 lifecycle API contract 不变。

## 实施

1. 替换 HTML 中静态链接列表为 `#channel-cards` 容器与安全说明。
2. 将 UI 重构为 metadata-driven card renderer；每张卡片有 docs、install guidance、status、生命周期和 add-endpoint 按钮。
3. 仅为 manifest-compatible Channel 显示 links 操作；Voice Call 只提供官方资料。
4. 增加 CSS card layout；不引入任何第三方前端依赖。
5. 运行静态资产、API、全量测试、check、Host patch 验证，并在本地提交。
