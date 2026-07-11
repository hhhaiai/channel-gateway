# N 对 N 高并发改造完成审计

审计日期：2026-07-12

## 1. 一个机器人负责多个群并支持跨渠道 N 对 N

**结论：已完成。**

- Link endpoint 使用 `channel/accountId/conversationId` 精确匹配入站。
- 同一个 accountId 可以出现在多个不同 conversation。
- `planFanout()` 不包含平台分支，一个源 endpoint 向同房间所有其他可发送 endpoint fan-out。
- 已有 QQ、飞书、WhatsApp、Telegram 多端 fan-out 和重启恢复测试。

## 2. 不采用主备模式

**结论：已完成。**

- 配置模型不存在 primary、standby、priority 或自动接管字段。
- 存储迁移文档明确禁止两个 active delivery owner。
- Worker lease 用于并发安全，不代表业务主备。

## 3. 不允许多个 bot 绑定一个群

**结论：已完成。**

- 群 owner key 为 `channel + conversationId`。
- 相同群使用不同 accountId 会在 `compileLinks()` 阶段失败。
- 一个 bot 管理多个不同 conversation 继续允许。

## 4. 多平台发送账号与未来 AI 总结

**结论：发送账号隔离和 AI 接入边界已完成；具体模型适配器按未来需求接入。**

- 账号并发、速率、burst、cooldown 和健康均按 `channel + accountId` 隔离。
- AI Transform 仅处理多成员纯文本 aggregate。
- AI 超时、异常或无效输出自动回退普通聚合。
- 接受的 Transform 结果先 durable CAS，重试不重新生成不同文本。
- 当前没有绑定模型厂商，符合“未来可能需要”而非强制依赖 AI 的要求。

## 5. 保持纯 JavaScript

**结论：已完成。**

- 运行代码继续使用 Node.js。
- 没有创建 Go/Java 双实现。
- 新功能未引入额外 npm runtime 依赖。

## 6. Worker 有界并发池与高频聚合

**结论：已完成。**

- 全局并发 `1..256`。
- 每账号并发 `1..64`，默认 2。
- 同 destination conversation 始终并发 1。
- 纯文本 durable 聚合支持 window、maxItems、UTF-8 maxBytes。
- 聚合 membership、顺序、lease、retry 和 Transform 结果可跨重启恢复。
- 默认压测 19900 deliveries 合并为 995 provider calls，降低 95%。

## 7. 资源有上限、读取容器/电脑资源、网页可调

**结论：已完成。**

- CPU 使用 `os.availableParallelism()`。
- 内存优先 `process.constrainedMemory()`，无约束时使用宿主内存。
- 自动公式：`min(CPU×2, memory/256MiB, 8)`，最低 1。
- SQLite 压测驱动自动上限从 32 收紧到 8。
- Plugin config 和环境变量可显式设置 `1..256`。
- 网页显示 CPU、内存、来源、有效并发、自动上限 8、硬上限 256，并可保存或恢复自动模式。

## 8. SQLite 当前可用并为 Redis/大数据迁移留边界

**结论：已完成。**

- SQLite WAL、durable event/delivery、lease、receipt、aggregate 和 transform 状态均在使用。
- Storage contract version 1 定义 Core、Delivery、API 能力组。
- Runtime 不依赖 `instanceof EventStore`。
- 迁移文档明确 Redis/大数据组合 adapter、一致性、fencing、双写校验和单 active owner 要求。
- 当前没有提前引入 Redis 依赖。

## 9. 平台故障重试、异常标记和后台看板

**结论：已完成。**

- Delivery 有 lease CAS、指数退避、max attempts 和终态失败。
- Provider Retry-After 只对对应账号形成 cooldown。
- 账号状态：healthy、degraded、unavailable、recovering。
- 渠道状态取账号最严重状态。
- 后台看板显示错误码、积压、下一重试、速率、token、burst 和 cooldown。
- API 显式 allowlist，不暴露消息正文、异常详情或凭证。
- 负责人通知属于用户明确说明的未来社交软件集成，本次没有伪造通知通道。

## 10. 稳定性与容量证据

- 完整自动测试：217 passed，0 failed。
- `npm run check`：通过。
- `git diff --check`：通过。
- 真实 pinned Gateway smoke/restart 测试：通过。
- 默认 20 平台×10 群×100 消息 benchmark：19900 deliveries 全部 sent。
- 聚合减少 provider calls 95%。
- 实测全局和账号并发均未超过配置。

## 11. 已知边界

- 真实平台吞吐仍受各 provider API 限流、SDK 和网络延迟影响，应在目标容器重复 benchmark。
- AI 模型 adapter 尚未选择；边界和失败回退已经具备。
- Provider 若用多个别名表示同一群，需要 channel adapter 在进入 Gateway 前标准化 conversationId。
- 聚合参数目前通过 plugin config 设置，尚未加入网页编辑；用户明确要求的网页资源并发配置已经完成。
- SQLite 适合当前阶段；超出容量后按 storage contract 迁移，而不是同时启动两个 active owner。
