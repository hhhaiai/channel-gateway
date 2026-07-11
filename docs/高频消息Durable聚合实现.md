# 高频消息 Durable 聚合实现

## 1. 目标

N 对 N 桥接会放大 provider 请求数。启用本功能后，同一目标会话窗口内的兼容纯文本 delivery 会合并成一次发送；SQLite 仍保留每个成员的独立状态与审计关系。

## 2. 配置与硬边界

```json
{
  "deliveryAggregationEnabled": false,
  "deliveryAggregationWindowMs": 1000,
  "deliveryAggregationMaxItems": 20,
  "deliveryAggregationMaxBytes": 32768
}
```

| 配置 | 最小 | 最大 | 默认 |
|---|---:|---:|---:|
| window | 100 ms | 60000 ms | 1000 ms |
| items | 2 | 100 | 20 |
| UTF-8 bytes | 1024 | 262144 | 32768 |

默认关闭，避免升级后自动改变消息呈现方式。

## 3. 等待窗口

兼容 delivery 的首次可发送时间为入库时间加 `windowMs`。窗口状态保存在 SQLite 的 `next_attempt_at_ms`，不依赖内存 timer；窗口期间进程退出不会丢消息。媒体和回复消息不延迟。

## 4. 兼容条件

第一版只聚合：

- 纯文本、无 `replyToId`、无媒体。
- 首次尝试且未进入 retry。
- 相同 link、destination endpoint、channel、account、conversation、`to` 和 `threadId`。

不同目标不会合并，因为普通 provider API 无法在一次请求中向多个群发送。媒体、回复和不兼容消息继续走原单条路径。

## 5. Durable membership

`deliveries` 表增量增加：

```sql
aggregate_id TEXT
aggregate_index INTEGER
```

最早 delivery 是 leader，其 id 作为 aggregate id。成员在一个 `BEGIN IMMEDIATE` transaction 中获得相同 aggregate id、稳定 index 和统一 lease。成员行本身同时承担状态和 membership，避免维护第二套容易漂移的 aggregate 状态机。

旧数据库通过 `PRAGMA table_info(deliveries)` 检测列，再执行增量 `ALTER TABLE`，不会重建或清空原表。

## 6. 文本与字节限制

每个成员原 marker 先被移除，文本按 delivery 顺序用换行连接，最终只追加 leader marker：

```text
[telegram/Alice] first
[telegram/Bob] second
<aggregate marker>
```

限制按 `Buffer.byteLength(finalMessage)` 计算，正确覆盖中文和 emoji。若第一条本身超过 aggregate byte 上限，则退回普通单条发送，不会卡住队列。

## 7. Worker 资源语义

一个 aggregate 只占用：

- 一个全局 lane。
- 一个账号并发槽。
- 一个账号 Token Bucket token。
- 一次 sender 调用。

同 destination 仍严格串行。后台 backlog 继续按成员 delivery 计数，因此 `pending=20` 最终可能只有一次 provider send。

## 8. 成功、失败与恢复

- 成功：一个 transaction 将全部成员改为 `sent`；receipt 只写 leader，避免唯一索引冲突。
- 失败：全部成员共享错误码、重试时间和状态。
- 达到最大尝试：全部成员进入 `failed`。
- 重启或 lease 超时：按持久化 aggregate id 和 index 重建相同文本、成员和 idempotency key。
- 已形成 aggregate 即使重启后关闭聚合配置，也不会重新拆组或改组。

## 9. 回复边界

带 reply 的消息不聚合，保持精确 reply relation。目标用户回复聚合消息时只能关联 leader，系统不会假装知道用户具体回复了哪个成员。未来可由 AI 摘要加引用编号，但属于独立模块。

## 10. 测试证据

- 配置硬边界和 UTF-8 字节计算。
- marker 只保留一个。
- reply/媒体不兼容。
- 原子领取并一次完成多个成员。
- retry 后成员集合和顺序不变。
- 配置关闭后恢复既有 aggregate。
- 超大单条消息正常退回单发。
- 完整项目测试 `207 passed, 0 failed`。

## 11. 未包含

- AI 总结与重点提取。
- 媒体聚合。
- Redis 或外部队列。
- 网页端聚合参数编辑；当前通过 plugin config 配置。
