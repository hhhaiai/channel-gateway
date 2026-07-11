# 高频消息 Durable 聚合实施计划

## 1. 目标

在超高频群聊中，把同一目标会话短时间内的多条纯文本 delivery 合并成一次 provider send，降低跨平台 fan-out 后的 API 请求数量。聚合必须可恢复、受资源边界约束，并且不能破坏单目标顺序。

## 2. 默认策略

聚合默认关闭，由管理员显式启用。第一版配置：

```json
{
  "deliveryAggregationEnabled": false,
  "deliveryAggregationWindowMs": 1000,
  "deliveryAggregationMaxItems": 20,
  "deliveryAggregationMaxBytes": 32768
}
```

硬上限：

- window：`100..60000 ms`
- items：`2..100`
- UTF-8 bytes：`1024..262144`

配置只影响新创建的 delivery；已形成的聚合不能因重启或配置变化重组。

## 3. 聚合键

只有以下字段完全一致才允许进入同一聚合：

```text
linkId
destinationChannel
destinationAccountId
destinationConversationId
request.to
request.threadId
```

同一目标 conversation 仍只允许一个 active aggregate，继续满足现有 destination 串行约束。

## 4. 第一版兼容范围

允许：

- 纯文本消息。
- 没有 `replyToId`。
- 没有媒体。
- 同一 link 和 destination endpoint。

不允许聚合：

- 回复消息：必须保持精确 reply relation。
- 含媒体消息：不同 provider 对多媒体批量语义不一致。
- 已经 retry 的 delivery：避免把不同退避时间重新混合。
- 非 retryable/terminal delivery。

不兼容的 delivery 继续走现有单条发送，不丢弃、不等待额外窗口。

## 5. Durable membership

不能只在 Worker 内存中维护成员列表。SQLite 在 delivery 行上新增：

```sql
aggregate_id TEXT
aggregate_index INTEGER
```

leader 使用原始 delivery id 作为 `aggregate_id`；成员共享该 id，并用 `aggregate_index` 保存稳定顺序。形成聚合、写成员关系和取得统一 lease 必须在同一 SQLite transaction 中完成，避免单独 aggregate 状态表与 member delivery 状态漂移。

进程崩溃后按成员行上的 aggregate id、index 和 lease 恢复，禁止重新选择另一批成员。

## 6. 消息格式

聚合文本保持原始 delivery 顺序，每条消息以换行分隔：

```text
[telegram/Alice] first
[telegram/Bob] second
```

整个聚合只附加一个 aggregate marker。单条 member 原有 marker 在合并前剥离，避免目标平台回流时出现多个无效 marker。

`maxBytes` 按最终 UTF-8 request message 计算，而不是 JavaScript 字符数量。

## 7. ACK、重试和失败

- provider send 成功：aggregate 与所有 member delivery 在一个 transaction 中完成。
- provider send 失败：aggregate 统一 retry，成员保持托管，不单独被 worker claim。
- 达到最大尝试：aggregate 与全部成员进入 `failed`。
- receipt 只属于 aggregate；成员保留 aggregate relation，供诊断和未来回复策略使用。

第一版聚合消息不承诺逐成员 reply 映射；回复聚合消息只映射到 aggregate，不伪造某个成员的精确父消息。

## 8. 并发和限流

一个 aggregate 只消耗：

- 一个全局 worker lane。
- 一个账号并发槽。
- 一个账号 Token Bucket token。
- 一次 provider API 请求。

因此 20 条消息合并后，发送请求数从 20 降为 1，但 SQLite 中仍保留 20 个 member delivery 的 durable 审计关系。

## 9. 实施顺序

1. 配置验证和纯文本 builder 的 RED/GREEN。
2. SQLite migration、aggregate/member 表与原子形成测试。
3. aggregate claim、lease expiry、complete/retry 测试。
4. Worker 接入，证明一次 sender 调用完成多个成员。
5. plugin/runtime/schema 配置接通。
6. 文档、focused tests、完整 gate、独立 Lore commit。

## 10. 明确不做

- 不在本块加入 AI 摘要或重点提取。
- 不跨不同 destination 合并成一次 provider 调用；普通平台 API 不支持一次请求发送多个目标。
- 不聚合媒体和 reply。
- 不用纯内存 timer 作为唯一事实源。
- 不引入 Redis 或新依赖。
