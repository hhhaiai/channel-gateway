# Event/Delivery Storage Contract 实施计划

## 目标

把 Runtime、Worker、API 所需能力定义为版本化 JavaScript contract。SQLite `EventStore` 保持默认实现；未来 Redis、大数据或组合后端通过 adapter 实现同一合同，不需要修改业务层。

## 能力组

- `events`：enqueue/list/ack/fail/pending/echo/reply。
- `deliveries`：claim/complete/retry/saveTransform/count/stats。
- `maintenance`：prune/close。
- `notifications`：on/off pending event，可选。

## 原子语义

合同不仅检查方法名，还明确：

- enqueue event 与 fan-out delivery 原子。
- claim/lease 是 CAS。
- aggregate membership 与 lease 原子。
- complete/retry 更新 aggregate 全体成员。
- transform save 受当前 lease CAS 保护。
- idempotency 和 destination 顺序由 adapter 保证。

## 实施

1. RED：缺方法时给出稳定、可操作错误。
2. SQLite 声明 contract version/capabilities。
3. Runtime 启动时按是否启用 delivery/API 验证能力。
4. 委托 wrapper 测试证明业务层不依赖 SQLite class。
5. 文档、完整测试、独立提交。
