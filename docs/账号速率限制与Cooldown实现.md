# 账号速率限制与 Cooldown 实现

> 状态：实施文档
>
> 范围：限制每个 `channel/accountId` 的持续发送速率、瞬时 burst，并处理 Provider 速率限制 cooldown。

## 1. 三层发送边界

```text
全局并发池
  └─ 账号并发上限
      └─ 账号 token bucket
          └─ 同一目标群串行
```

并发上限控制“同时请求多少条”；token bucket 控制“持续每秒允许多少条”。两者不能互相替代。

## 2. 默认策略

```json
{
  "deliveryRatePerSecondPerAccount": 5,
  "deliveryRateBurstPerAccount": 10
}
```

含义：

- 空闲账号最多积累 10 个 token。
- 每秒补充 5 个 token。
- 每次 Provider send 消耗 1 个 token。
- 默认值是平台未知时的保守起点，不代表所有 Provider 的官方上限。

硬边界：

```text
ratePerSecond: 0.01..1000
burst: 1..10000
```

## 3. 账号覆盖

```json
{
  "deliveryAccountRateLimits": [
    {
      "channel": "telegram",
      "accountId": "bot-a",
      "ratePerSecond": 20,
      "burst": 30
    },
    {
      "channel": "slack",
      "accountId": "default",
      "ratePerSecond": 2,
      "burst": 4
    }
  ]
}
```

覆盖项按 `channel + accountId` 精确匹配，最多允许 10000 项，避免异常配置无边界占用内存。

同一 `channel/accountId` 只能声明一次。未声明账号使用默认策略。

## 4. 调度方式

Limiter 只为已经出现过的账号维护内存状态：

1. 首次出现时获得完整 burst。
2. claim 前，Worker 查询当前无 token 或处于 cooldown 的账号。
3. SQLite 跳过这些账号，选择其他 due delivery。
4. claim 成功后同步消耗 token，再进入异步 Provider send。
5. 没有可发送任务时，本 tick 结束，由正常 poll 在 token refill 后继续。

任务不会因为等待 token 而提前获得 lease，因此不会在内存等待时发生 lease 过期。

## 5. Retry-After Cooldown

以下 controlled code 视为账号级速率限制：

```text
RATE_LIMITED
TOO_MANY_REQUESTS
包含 RATE_LIMIT 的受控错误码
```

当错误同时提供正数 `retryAfterMs` 时：

```text
blockedUntil = max(existingBlockedUntil, now + retryAfterMs)
```

在此之前，该账号的新 delivery 不会被 claim；其他账号不受影响。当前失败 delivery 仍使用既有 durable retry 规则，不改变其 attempts、lease 或 terminal 语义。

目标无权限、格式错误或单个群不存在等错误不能冻结整个账号。

## 6. 重启语义

Token 和 cooldown 是内存调度状态；durable delivery 的 `nextAttemptAtMs` 仍保存在 SQLite。进程重启后 bucket 恢复为满，但失败任务本身不会提前重试。

后续异常状态块可以将 account cooldown 和失败摘要持久化或投影到后台看板，本块不提前混入该逻辑。

## 7. Snapshot

Limiter 提供无凭据快照：

```json
{
  "channel": "telegram",
  "accountId": "bot-a",
  "tokens": 3.5,
  "ratePerSecond": 20,
  "burst": 30,
  "blockedUntilMs": null,
  "available": true
}
```

该数据将供下一块 Channel/account 健康看板使用。
