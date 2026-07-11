# AI Delivery Transform 边界实施计划

## 目标

为未来“定时总结、重点信息提取”提供发送前可插拔 transform，但不绑定具体 AI SDK。Transform 只处理已经形成的多成员纯文本 aggregate；任何异常、超时或无效输出都回退原始 durable aggregate。

## 边界

- 输入是脱敏后的 outbound aggregate message、目标标识和 member count。
- 输出只能替换可见 `message`，不能修改 channel/account/to/idempotency key。
- transform 不修改 SQLite membership 和 delivery request_json。
- timeout 默认 5000 ms，硬范围 `50..30000 ms`。
- 输出 UTF-8 默认最大 32768 bytes，硬范围 `1024..262144`。
- 单成员、媒体、reply 不调用 transform。
- transform 失败不计为 provider failure，不触发 durable retry 或账号健康降级。

## 回退

以下情况直接发送原 aggregate：

- transformer throw/reject。
- 超时。
- 返回非对象、空 message 或超出 bytes。
- 输出试图携带自己的 bridge marker。

最终发送文本由边界重新附加原 aggregate marker。

## 可观测性

内存 snapshot 统计：`attempted/transformed/fallback/timeouts`。不记录输入、输出或异常文本。

## 顺序

1. 纯模块 RED/GREEN。
2. Worker 只对多成员 aggregate 调用。
3. runtime 可选注入并暴露 snapshot。
4. focused/full tests、实现文档、独立 commit。
