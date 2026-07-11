# Fake Provider 可复现压测实施计划

## 默认场景

- 20 个平台。
- 每个平台 10 个群 endpoint。
- 每个平台一个发送账号，一个账号服务多个群。
- 一个 N-to-N 互通房间，共 200 endpoints。
- 从一个源群注入 100 条消息，理论 fan-out 19900 deliveries。
- 聚合窗口已到期，每目标最多 20 条合并。
- Worker 全局并发 32、账号并发 2。
- Fake provider 固定延迟 1 ms，不访问网络。

## 指标

- ingress events、endpoints、fan-out deliveries。
- provider calls 与 aggregation reduction。
- elapsed、delivery throughput、provider call throughput。
- observed max global/account concurrency。
- SQLite terminal counts。
- RSS/heap delta。

## Gate

- 全部 delivery 最终 sent。
- 无 pending/sending/failed。
- observed concurrency 不超过配置。
- provider calls 不超过理论未聚合 calls。
- 相同参数可重复运行并输出单个 JSON。

## 实施

1. 小场景自动测试。
2. 无依赖 CLI benchmark。
3. 默认大场景实跑并归档结果。
4. 完整测试和独立提交。
