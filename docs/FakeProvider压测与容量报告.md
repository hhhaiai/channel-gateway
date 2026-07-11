# Fake Provider 压测与容量报告

## 1. 压测工具

运行默认场景：

```bash
npm run benchmark
```

自定义示例：

```bash
npm run benchmark -- \
  --platforms=20 \
  --groupsPerPlatform=10 \
  --events=20 \
  --maxConcurrency=8 \
  --maxConcurrencyPerAccount=2 \
  --aggregationMaxItems=20 \
  --aggregationMaxBytes=32768 \
  --providerLatencyMs=1
```

工具只使用 Node.js、SQLite 和项目代码，不访问网络、不引入依赖。输出为单个 JSON，便于 CI 或容量平台采集。

## 2. 默认拓扑

```text
20 platforms
× 10 groups/platform
= 200 endpoints
```

每个平台使用一个 bot account，因此一个 bot 服务该平台的 10 个群，不使用多个 bot 监听同一群。

从一个源群注入 100 条消息：

```text
每条 fan-out = 199
总 delivery = 100 × 199 = 19900
```

每目标最多聚合 20 条，理论 provider calls：

```text
199 destinations × 5 aggregates = 995 calls
```

## 3. 2026-07-12 本机结果

环境：macOS、Node `22.20.0`、内存 SQLite、Fake provider 固定延迟 1 ms。

### 全局并发 32

```json
{
  "fanoutDeliveries": 19900,
  "providerCalls": 995,
  "aggregationReductionRatio": 0.95,
  "elapsedMs": 79091.068,
  "deliveriesPerSecond": 251.609,
  "providerCallsPerSecond": 12.58,
  "maxObservedConcurrency": 32,
  "maxObservedConcurrencyPerAccount": 2,
  "deliveryCounts": { "pending": 0, "sending": 0, "sent": 19900, "failed": 0 },
  "rssDeltaBytes": 91021312,
  "heapUsedDeltaBytes": 6312800
}
```

### 20 条事件、并发对比

相同 200 endpoints、3980 deliveries：

| 全局并发 | 账号并发 | 耗时 | deliveries/s | provider calls/s |
|---:|---:|---:|---:|---:|
| 1 | 1 | 731 ms | 5444 | 272 |
| 8 | 2 | 1158 ms | 3437 | 172 |
| 32 | 2 | 3479 ms | 1144 | 57 |

## 4. 关键结论

### 聚合有效

19900 delivery 只产生 995 次 provider call，降低 95%。全部 delivery 最终进入 `sent`，无失败或残留 lease。

### 并发边界有效

修正 benchmark 观测器的并发计数后，实测：

```text
global observed <= configured global
account observed <= configured per-account
```

### SQLite 下并发不是越大越快

当前 SQLite claim 使用 destination/account exclusion 保证顺序和隔离。大量 lane 会增加事务串行、动态 exclusion 和 due-row 扫描成本。Fake provider 只有 1 ms 延迟时，这些存储成本比网络等待更明显，因此并发 32 反而慢于 8 或 1。

这不表示生产 provider 应固定并发 1：真实 API 延迟通常远高于 1 ms，并发能覆盖网络等待。但它证明资源探测只看 CPU/内存不足以决定 SQLite 最优并发，后续默认值还应纳入 storage backend 和实测延迟。

## 5. 新增索引

SQLite 增加聚合候选索引：

```sql
CREATE INDEX deliveries_aggregation_candidates
ON deliveries(link_id, destination_endpoint_id, status, attempts, next_attempt_at_ms, seq)
WHERE aggregate_id IS NULL
```

该索引缩小同 destination 聚合候选查询范围，不改变 delivery 语义。

## 6. 指标解释

- `fanoutDeliveries`：真实需要审计的目标 delivery 数量。
- `providerCalls`：Fake sender 实际调用次数。
- `aggregationReductionRatio`：`1 - providerCalls/fanoutDeliveries`。
- `deliveriesPerSecond`：按成员 delivery 计算。
- `maxObservedConcurrency`：Fake provider 同时 active 调用数。
- `rssDeltaBytes/heapUsedDeltaBytes`：进程级近似增量，受 GC 和 Node allocator 影响，不是精确每消息成本。

## 7. 使用限制

- 内存 SQLite 不代表磁盘 SQLite 的 fsync 性能。
- Fake provider 不模拟真实 TLS、DNS、SDK CPU、平台限流和响应大小。
- 单次结果不是生产 SLO，应在目标容器 CPU/内存限制下重复执行。
- 压测不启用 Token Bucket，因为目标是测 Worker/SQLite 上界；真实部署仍受每账号速率限制。

## 8. 推荐下一步

基于本次证据，下一独立块应把 SQLite backend 的自动并发默认值设为更保守上限，同时保留网页显式 override。之后再做最终目标审计。
