# AI 消息转换边界与失败回退实现

## 1. 目的

未来定时总结和重点信息推送需要 AI，但模型调用不能进入 SQLite delivery 状态机，也不能让 AI 故障阻断普通消息转发。本实现提供一个可插拔发送前边界：只转换已经形成的多成员纯文本 aggregate，失败时发送原 aggregate。

当前没有绑定任何模型、SDK 或云服务。具体 AI 适配器以后通过 `deliveryTransformer` 注入。

## 2. Runtime 接口

```js
createBridgeRuntime({
  deliveryTransformer: async ({
    message,
    memberCount,
    channel,
    accountId,
    conversationId,
  }) => ({ message: "总结结果" }),
  deliveryTransformTimeoutMs: 5000,
  deliveryTransformMaxBytes: 32768,
});
```

Transformer 只能返回新的可见 `message`。Channel Gateway 保留并重新生成：

- channel
- accountId
- to
- threadId
- mediaUrls
- idempotencyKey
- bridge marker

因此 AI 不能把消息改发到另一个群或账号。

## 3. 调用条件

只有 `aggregateMemberIds.length >= 2` 才调用 transform。单条消息、媒体消息和 reply 已经在聚合层被排除，不会进入 AI 边界。

输入 message 已移除内部 bridge marker；transformer 不接触 SQLite row、token、provider credential 或完整 canonical event。

## 4. 资源边界

| 参数 | 最小 | 最大 | 默认 |
|---|---:|---:|---:|
| timeout | 50 ms | 30000 ms | 5000 ms |
| 输出 UTF-8 bytes | 1024 | 262144 | 32768 |

超时 timer 调用 `unref()`，不会单独阻止 Node.js 退出。

## 5. 失败回退

以下情况计为 fallback，并发送原始 durable aggregate：

- throw 或 Promise reject。
- 超时。
- 返回非对象。
- message 为空。
- 输出超过字节上限。
- 输出自行携带 bridge marker。

Transform 错误不是 provider 错误，因此：

- 不触发 delivery retry。
- 不消耗额外 provider attempt。
- 不把账号标记为 degraded。
- 不触发 provider cooldown。

## 6. Transform 结果持久化

AI 输出不能只缓存于内存，否则 provider 请求结果不明确或进程崩溃后，retry 可能生成不同总结但复用相同 idempotency key。

`deliveries` leader 行新增：

```sql
transform_request_json TEXT
```

发送顺序：

1. Worker 获取 aggregate lease。
2. 执行 bounded transform。
3. 使用 lease token CAS 写入 `transform_request_json`。
4. CAS 成功后才调用 provider sender。
5. Retry/restart 直接复用持久化结果，不再次调用 AI。

如果保存 transform 时 lease 已丢失，Worker 不发送，避免未持久化请求进入 provider。

原始 `request_json` 不修改，始终保留普通聚合作为审计和 fallback 基线。

## 7. Marker 安全

AI 输入不含 marker。输出如果包含 marker 会被拒绝并 fallback。合法输出由 Gateway 使用 leader delivery id 重新附加唯一 marker，防止模型伪造关联关系。

## 8. 可观测性

```js
runtime.deliveryTransform.snapshot()
```

返回：

```json
{
  "attempted": 10,
  "transformed": 8,
  "fallback": 2,
  "timeouts": 1
}
```

只记录计数，不记录 prompt、输入文本、输出文本或异常内容。

## 9. 测试覆盖

- 只替换 message，transport envelope 保持不变。
- 单成员不调用 transformer。
- reject、timeout、空输出、超限输出 fallback。
- marker 注入被拒绝。
- 统计快照不含异常文本。
- transform request 在 retry 前持久化。
- 重试领取复用相同 transform 输出。
- Worker 在 provider send 前调用边界。

## 10. 后续适配

具体 AI adapter 应作为独立模块实现，并自行处理模型选择、prompt 版本、成本预算和内容合规。它只实现当前 transformer 函数，不得直接操作 EventStore 或 DeliveryWorker。
