# Channel Gateway 控制台设计

## 目标

为 Channel Gateway 提供本地管理页，使一个互通房间可包含任意多个 QQ/TG 群 endpoint。任一 endpoint 收到消息后，现有 fan-out 路由会向该房间其余可发送 endpoint 投递，因此天然覆盖 1↔N 与 N↔N。

## 边界

- `link` 是一个互通房间；每个 endpoint 是一个具体群（`channel`、`accountId`、`conversationId`、`to`）。
- 浏览器只管理 `plugins.entries.channel-gateway.config.links`；绝不保存 QQ/TG token、AppSecret、二维码或 session。
- Channel 登录/凭据继续使用 OpenClaw 官方 CLI。控制台仅展示接入步骤、状态和 links 编辑器。
- 保存使用 Host 的 `api.runtime.config.mutateConfigFile({ base: "source" })`。这保留 JSON5、include、env ref、文件锁、原子写入和 Host 备份。
- 当前运行时在启动时编译 links，且 `gateway.reload.mode=off`；保存返回 `restartRequired: true`，不热更新也不自行杀进程。

## HTTP

- `GET /channel-gateway`、静态 JS/CSS：无敏感内容的 plugin-managed 静态资产，严格 CSP；打开页面后 token 只留在 JavaScript 内存。
- 现有 `/api/v1/*` 保持 Gateway token 验证。
- `GET /api/v1/links/config`：返回完整 canonical links 和 links revision，供编辑器回显。
- `PUT /api/v1/links/config`：只接受 `{ links, revision }`；先 `compileLinks()`，再在 Host mutation 回调内检查 revision，冲突返回 409。
- `/api/v1/links` 仍为脱敏 status API，不暴露 `to`。

## 验收

1. 一个 link 至少两 endpoint，且可以添加任意数量 QQ/TG endpoint。
2. 同一 link 的任意 endpoint 发言会由已有 `planFanout` 发往其余 endpoint。
3. 编辑保存不会改动 links 以外的配置字段，保存后明确要求重启。
4. 控制台给出 TG 与 QQ 官方接入命令和群策略说明。
