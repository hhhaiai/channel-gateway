# 账号与渠道投递健康状态投影实施计划

## 目标

在不改变 durable delivery 重试语义的前提下，为每个 `channel + accountId` 建立可查询的健康投影，并聚合出渠道状态。该块只建立状态模型和运行时数据，不修改后台页面。

## 状态机

- `healthy`：初始状态，或异常后连续两次发送成功。
- `degraded`：出现仍可重试的投递失败。
- `unavailable`：投递进入终态失败，表示该账号当前存在明确不可交付证据。
- `recovering`：异常账号首次重新发送成功；再成功一次转回 `healthy`。

任意新失败都会清零恢复成功计数。可重试失败不会把已经 `unavailable` 的账号降级回 `degraded`。

## 投影字段

账号维度：

- `channel`、`accountId`、`status`
- `errorCode`
- `firstFailureAtMs`、`lastFailureAtMs`、`lastSuccessAtMs`
- `nextRetryAtMs`
- `pending`、`sending`、`failed` 积压数量

渠道维度按最严重账号状态聚合：

`unavailable > degraded > recovering > healthy`

渠道统计累加账号积压，但不包含消息正文、群名、用户身份或 provider 原始异常。

## 实现顺序

1. 新增纯内存 `DeliveryHealthProjection`，用单元测试锁定状态转换和输出脱敏。
2. 为 `EventStore` 增加账号级 delivery 聚合查询，SQLite 作为当前事实源。
3. `DeliveryWorker` 在 durable complete/retry 成功后更新投影；CAS 失败不更新，避免记录未落库的结果。
4. `BridgeRuntime` 创建并暴露投影，供下一块 API/后台看板读取。
5. focused tests、`npm run check`、完整 `npm test`、`git diff --check` 后独立提交。

## 明确不做

- 不在本块改控制台 UI 或新增通知接口。
- 不把全局数据库健康与 provider/account 健康混为一个 readiness 状态。
- 不持久化瞬时状态机；积压和终态失败仍由 SQLite 恢复，运行时异常轨迹从进程启动后重新积累。
- 不引入 Redis、消息队列或新依赖。
