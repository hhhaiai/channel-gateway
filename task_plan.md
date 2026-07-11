# OpenClaw Channel Gateway 工作计划

## 目标

从 OpenClaw 的现行实现中识别并抽取多 Channel 通讯能力，形成一个可独立启动、可供其他系统通过统一 API 集成的服务，同时尽量保留上游适配器兼容性和后续同步能力。

## 当前阶段

- [x] Phase 0：恢复会话与确认目标
- [x] Phase 1：获取上游并建立源码、文档、许可证基线
- [x] Phase 2：追踪真实 Channel 运行链路与依赖边界
- [x] Phase 3：给出 2–3 个抽取方案及推荐设计
- [x] Phase 4：完成设计规格并根据用户“当前目录、独立服务、跨软件分发”的确认继续实施
- [x] Phase 5：测试优先实现独立服务
- [ ] Phase 6：独立启动、接口、适配器与质量验证（仅剩四端端到端 fake integration 与最终审计）

## 已确认需求

1. 目标产物是独立服务，而不是 OpenClaw 内部的另一个模块。
2. 服务需要能够单独执行。
3. 服务负责与 OpenClaw 已支持的多个软件/Channel 互通。
4. 其他业务系统应能以统一方式接入该服务，而不必理解各 Channel 的协议细节。

## 待源码验证的关键问题

- Channel 适配器是否已经具备稳定的插件接口，还是依赖 OpenClaw gateway/agent/runtime 全局状态。
- 哪些 Channel 属于核心代码，哪些来自 extensions/workspace package。
- 入站 webhook、长轮询、WebSocket 与本地客户端各自如何启动和管理生命周期。
- 出站文本、媒体、线程/引用、反应、编辑、删除等能力如何统一。
- 配置、凭据、会话映射、幂等、重试和限流依赖哪些 OpenClaw 模块。
- 上游许可证是否允许复制、修改和独立分发，以及保留声明的要求。

## 决策原则

- 先证明运行链路，再决定抽取边界。
- 优先复用现有适配器契约；避免逐个 Channel 重写。
- 独立服务不得依赖 OpenClaw agent/LLM 运行时才能启动。
- API 与 Channel 特有能力分层：公共消息模型保持稳定，特有能力通过 capability/extension 字段表达。
- 保持上游来源映射，便于后续同步安全修复。

## 错误记录

| 错误 | 尝试 | 处理 |
|---|---:|---|
| 初始工作区只有 `.omx/`，没有仓库 | 1 | 将上游克隆到独立目录后再分析，避免覆盖 OMX 状态 |
| 聚合式 `rg` 命令包含不存在的 `src/plugins/registration.ts`，被工具包装器拒绝 | 1 | 先验证路径，仅对实际目录搜索；记录于 `.learnings/ERRORS.md` |
| 再次猜测不存在的 `src/cli/program/register.gateway.ts` | 2 | 禁止在聚合读取命令中使用猜测路径；先 `find`，再单独读取 |
| 大型多 hunk 文档 patch 误报已有 context 不存在 | 1 | 已用字节级比较确认 context 存在；拆成按 section 的小 patch |
| 恢复会话后组合检查命令引用不存在的 `channel-gateway/bin`，被工具包装器判为路径失败 | 1 | 改用 `find ... 2>/dev/null` 分别确认；发现 `bin/channel-gateway.js` 与 `src/launcher/run.js` 确实缺失，需按测试契约补回 |
| `npm ci` 拒绝安装：`package.json` 与 `package-lock.json` 不同步，缺少 sharp/express 类型等传递条目；同时当前 Node 22.20.0 低于某个浮动传递包声明的 22.22.2 | 1 | 已用 `npm install` 按现有直接依赖补全 lockfile 并成功安装 330 个包；保留 Node 传递依赖 engine 风险待发布门禁处理 |
| 一次同时更新计划、进度并带空 `findings.md` hunk 的 patch 被拒绝 | 1 | 移除空 hunk，拆成有效的小 patch |
