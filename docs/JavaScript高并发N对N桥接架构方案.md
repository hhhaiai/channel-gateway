# JavaScript 高并发 N 对 N Channel 桥接架构方案

> 状态：讨论稿
>
> 日期：2026-07-12
> 目的：明确拓扑、账号、路由、并发、限流、持久化、容量和验证方式；本稿不代表已经开始实现。

## 1. 结论先行

纯 JavaScript/Node.js 可以实现 20 个平台、多群、多机器人参与的高并发 N 对 N 桥接。这个场景主要是网络 I/O、定时调度和状态持久化，不是典型 CPU 密集计算，因此 Node.js 单事件循环本身不是首要瓶颈。

但当前实现不能不经调整就承诺这个规模稳定运行。最明确的瓶颈是 `DeliveryWorker` 目前逐条 `await sender()`，同一时刻实际只有一条出站投递。要达到目标，需要把它升级成具备以下特性的 durable outbox 调度器：

1. 全局有界并发，而不是无限 `Promise.all()`。
2. 按平台和机器人账号限流。
3. 同一目标群保持顺序，不同目标群并行。
4. 任务先落库再发送，进程重启后继续。
5. 支持公平调度、退避、抖动、`Retry-After` 和熔断。
6. 使用确定性 delivery ID 和幂等键阻止重复投递。
7. 对队列深度、最老任务年龄、平台错误率和限流状态进行监控。

目标不应定义成“让所有群无边界地全部互发”，而应定义成“用清晰的逻辑房间和 endpoint membership 描述 N 对 N 关系”。拓扑越明确，吞吐越可计算，配置越容易维护。

---

## 2. 规模假设与不可混淆的概念

用户描述的上限规模为：

```text
20 个平台
每个平台 10 个群
每个平台 10～20 个机器人账号
```

由此可能产生：

```text
群端点数量：20 × 10 = 200
机器人账号数量：20 × 10～20 = 200～400
```

这两个数字不能直接相乘来计算路由量。机器人账号是连接和鉴权主体，群端点是消息路由主体。一个机器人可以负责多个群；一个群也可能配置主备机器人，但同一时刻应只有一个 active receiver。

### 2.1 术语

| 术语 | 定义 |
|---|---|
| Platform / Channel | Telegram、QQ、Slack、Feishu 等平台类型 |
| Account / Bot | 某个平台上的一个机器人账号或连接实例 |
| Conversation / Group | 群、频道、聊天室、线程等消息会话 |
| Endpoint | `platform + accountId + conversationId + outbound target` 的稳定组合 |
| Bridge Room | 一个逻辑互通房间，由多个 endpoint 组成 |
| Membership | endpoint 加入某个 Bridge Room 的关系 |
| Event | 从某个 endpoint 接收到并规范化后的入站消息 |
| Delivery | Event 向一个目标 endpoint 的一次持久化投递任务 |
| Receipt | Provider 返回的目标消息 ID 和回复关系 |
| Ownership | 当前由哪个 bot/account 负责接收或发送某个 endpoint |

### 2.2 唯一标识

建议所有标识都由配置显式给出，不根据数组位置生成：

```text
accountId:  telegram-bot-01
endpointId: telegram-sales-group-01
roomId:     sales-room-01
eventId:    evt_<deterministic hash>
deliveryId: dlv_<eventId + roomId + destinationEndpointId>
```

配置排序、服务重启或新增其他 endpoint 时，已有 ID 不得变化。

---

## 3. N 对 N 拓扑必须先明确

## 3.1 推荐拓扑：按业务房间对应

如果每个平台都有 10 个相互对应的群，建议建立 10 个 Bridge Room：

```text
room-01 = 平台 1 的群 1 + 平台 2 的群 1 + ... + 平台 20 的群 1
room-02 = 平台 1 的群 2 + 平台 2 的群 2 + ... + 平台 20 的群 2
...
room-10 = 平台 1 的群 10 + ... + 平台 20 的群 10
```

每个房间有 20 个 endpoint，一条消息产生最多 19 条 delivery。这是真正的 N 对 N，同时仍然容易理解和维护。

```text
入站 endpoint A
  ├─→ endpoint B
  ├─→ endpoint C
  ├─→ endpoint D
  └─→ 其余同房间 endpoint
```

## 3.2 分组拓扑：不同房间规模不同

某些业务可能只需要部分平台互通：

```text
customer-support = Telegram + WhatsApp + Slack
operations       = QQ + Feishu + Microsoft Teams
public-community = Discord + Telegram + Matrix + IRC
```

这种模型也是 N 对 N，不要求所有平台出现在每个房间。它通常比固定的全平台互通更符合真实业务，并能显著减少无效 fan-out。

## 3.3 不推荐拓扑：200 个群全部放进一个房间

如果 200 个群完全互通，每条入站消息会生成 199 次出站投递：

```text
1 条入站 → 199 条 delivery
20 条入站/秒 → 3980 条 delivery/秒
```

这类拓扑通常先触发 Provider 限流、风控和群消息噪声，而不是先耗尽 Node.js。除非有明确业务必要，否则配置校验应警告超大房间。

## 3.4 一个 endpoint 是否可以加入多个房间

当前实现把一个 `channel + accountId + conversationId` 映射到单个 link，因此同一 endpoint 只能属于一个房间。面向复杂 N 对 N，应将索引升级为：

```text
endpoint match key → membership[]
```

允许一个 endpoint 加入多个房间，但必须同时解决：

1. 同一目标 endpoint 通过多个房间产生重复 delivery。
2. 房间之间形成业务级转发环。
3. 同一入站消息被重复包装和重复计数。

建议最终 delivery 唯一键至少包含：

```text
eventId + destinationEndpointId + routePolicyId
```

如果业务语义是不管经过几个房间，同一事件对同一目标只发一次，则唯一键应去掉 `roomId`，在规划阶段合并重复目标。

---

## 4. 可维护的配置模型

当前把完整 endpoint 嵌套写在每个 link 中，规模较小时直观；达到数百 endpoint 后，应拆成账号、endpoint 和房间三层。

```json
{
  "accounts": {
    "telegram-bot-01": {
      "channel": "telegram",
      "enabled": true,
      "receiveConcurrency": 1,
      "sendConcurrency": 4,
      "ratePerSecond": 10,
      "burst": 20
    }
  },
  "endpoints": {
    "telegram-sales-01": {
      "accountId": "telegram-bot-01",
      "conversationId": "provider-conversation-id",
      "to": "provider-send-target",
      "receive": true,
      "send": true
    }
  },
  "rooms": {
    "sales-room-01": {
      "members": [
        "telegram-sales-01",
        "qq-sales-01",
        "slack-sales-01"
      ]
    }
  }
}
```

### 4.1 配置校验

保存配置前必须检查：

- account、endpoint、room ID 全局唯一。
- endpoint 引用的 account 必须存在且平台一致。
- room 至少包含两个有效 endpoint。
- 同一个 Provider outbound target 不得被两个 endpoint 重复声明。
- 每个接收 endpoint 同时只能有一个 active owner。
- endpoint 加入多个 room 时必须明确重复目标合并策略。
- 单个 room 超过可配置阈值时返回警告或拒绝。
- 配置更新使用 revision/CAS，防止多人同时覆盖。
- 新配置完整编译成功后再原子替换旧配置。

### 4.2 配置维护方式

建议提供三种视图，但底层使用同一规范化模型：

1. **账号视图**：机器人是否在线、负责哪些群、当前限流状态。
2. **Endpoint 视图**：群属于哪个平台、由哪个账号负责、加入哪些房间。
3. **房间视图**：房间包含哪些 endpoint，消息会 fan-out 到哪里。

禁止直接让运营人员编辑巨大 JSON 作为唯一维护方式。控制台需要搜索、批量加入、复制房间、冲突检查和变更预览。

---

## 5. 多机器人账号如何设计

## 5.1 推荐：静态分片

第一版不要做自动负载均衡。明确配置每个 bot 负责哪些 endpoint：

```text
telegram-bot-01 → group-01、group-02
telegram-bot-02 → group-03、group-04
telegram-bot-03 → group-05、group-06
```

静态分片的优点：

- 配置可解释。
- Provider 会话和 reply ID 不会随机漂移。
- 出现异常时容易定位具体 bot。
- 不需要分布式 leader election。

## 5.2 主备模式

需要高可用时，可以为 endpoint 配置主备账号：

```text
primary: telegram-bot-01
standby: telegram-bot-11
```

但 standby 默认不能同时接收同一个群的消息。切换过程需要 ownership lease：

```text
endpoint_owner(endpoint_id, account_id, lease_until, generation)
```

只有持有当前 generation 的账号可以接收并产生 event。

## 5.3 不推荐：多个 bot 同时监听同一个群

如果 20 个 bot 同时收到同一条群消息：

```text
1 条真实消息 → 20 条入站副本 → 每条再 fan-out N 次
```

即使存在 message ID 去重，也会增加连接、解析、日志和数据库竞争。除非 Provider 本身要求多账号协作，否则同一 endpoint 应保持单 active receiver。

## 5.4 发送账号不能随机轮换

发送账号应与 endpoint 稳定绑定。随机选择 bot 会破坏：

- reply/thread 关系。
- Provider message ID 作用域。
- 限流统计。
- 失败重试的一致性。
- 运维人员对消息来源的判断。

如果确实要做发送池，应使用一致性哈希和固定 shard，不使用每次随机选择。

---

## 6. 容量计算方法

定义：

```text
E = 活跃 endpoint 数量
R = 每个 endpoint 平均入站消息数/秒
K = 一个事件匹配房间的平均 endpoint 数
F = 平均 fan-out = K - 1
I = 总入站消息/秒 = E × R
O = 总出站 delivery/秒 = I × F
```

对于 200 个 endpoint、每个房间 20 个 endpoint：

| 每个群平均消息量 | 总入站 I | fan-out F | 计划出站 O |
|---|---:|---:|---:|
| 每分钟 1 条 | 3.33/s | 19 | 约 63/s |
| 每分钟 6 条 | 20/s | 19 | 约 380/s |
| 每秒 1 条 | 200/s | 19 | 约 3800/s |

第三档通常无法由真实 Provider 长期接受。系统应允许队列吸收短时突发，但不能把无限增长的积压误认为“运行稳定”。

需要同时计算媒体消息，因为图片、文件和语音的网络、磁盘及 Provider 上传成本远高于纯文本。

---

## 7. 纯 JavaScript 高并发 Worker 设计

## 7.1 基本原则

```text
接收消息的快路径只负责：校验 → 去重 → 规划 → 事务落库
发送消息的慢路径由独立 worker pool 异步完成
```

OpenClaw hook 不应等待 19 个或 199 个 Provider 请求完成。它只需确认 event 和 delivery 已经持久化。

## 7.2 出站流水线

```text
Event
  ↓
单事务写入 events + deliveries
  ↓
调度器批量 claim due deliveries
  ↓
按 platform/account/conversation 分区
  ↓
平台限流器 + 账号 semaphore
  ↓
Provider send
  ↓
complete / retry / terminal failure
```

## 7.3 并发层级

建议从保守默认值开始，通过压测调优，而不是写死为生产保证：

```text
globalMaxInFlight:        64
perPlatformMaxInFlight:   按平台配置
perAccountMaxInFlight:    1～5 起步
perConversationInFlight:  1
claimBatchSize:            100
```

含义：

- 全局最多同时执行 64 个 Provider 请求。
- 某个平台不能占满全部 worker。
- 单个 bot 受到独立限制。
- 同一个群严格串行，避免消息乱序。
- 不同群和不同平台可以并行。

这些数字必须由 fake Provider 和真实沙箱压测确定。

## 7.4 公平调度

不能只按数据库最早任务不断发送，否则一个热门 Telegram 群可能饿死其他平台。建议使用分层 round-robin：

```text
platform queue
  └─ account queue
      └─ conversation queue
```

调度目标：

- 到期时间优先。
- 同层账号公平轮转。
- 重试任务不能长期压住新任务。
- terminal failure 不重新进入调度。

## 7.5 限流

每个平台/account 使用 token bucket：

```text
ratePerSecond
burst
maxInFlight
cooldownUntil
```

Provider 返回 429 或 `Retry-After` 时：

1. 当前 delivery 写回下一次可用时间。
2. 更新对应 account 的 cooldown。
3. 不阻塞其他平台和账号。
4. 加入随机抖动，防止全部任务同时醒来。

## 7.6 重试

建议：

```text
delay = max(providerRetryAfter, exponentialBackoff) + jitter
```

错误分类：

| 类型 | 行为 |
|---|---|
| 网络超时、临时 5xx | retryable |
| 429 | 按 Retry-After 重试并冷却账号 |
| token 无效 | 账号熔断，等待人工修复 |
| 群不存在、无权限 | terminal failure |
| 消息格式不支持 | terminal 或降级重发 |
| 服务进程退出 | lease 到期后恢复 |

## 7.7 为什么不能无限 Promise.all

无限并发会导致：

- 文件描述符耗尽。
- Provider 集体限流。
- 内存中堆积大量 Promise 和 payload。
- SQLite 状态更新竞争。
- 热门账号挤压其他账号。
- 服务退出时无法快速收敛。

正确方式是固定容量 worker pool 和可观察的等待队列。

---

## 8. SQLite 和持久化模型

第一阶段继续使用 SQLite 是合理的。当前实现已有 WAL、事务、lease 和幂等 ID 基础，不需要因为 endpoint 数量达到数百就立刻迁移数据库。

## 8.1 建议的数据关系

```text
accounts
endpoints
bridge_rooms
room_memberships
events
deliveries
receipts
endpoint_ownership
account_health
```

## 8.2 写入边界

每条入站事件应在一个短事务中完成：

```text
INSERT OR MERGE event
INSERT OR IGNORE delivery jobs
COMMIT
```

Provider 请求绝不能放在数据库事务内部。

## 8.3 Claim 模型

worker 批量选择 due delivery，并用 lease token 做 compare-and-set：

```text
pending → sending(lease_token, lease_until)
```

只有持有 lease token 的 worker 可以 complete 或 retry。进程崩溃后，lease 到期，任务重新可 claim。

## 8.4 何时才需要 PostgreSQL

满足下列任一条件时再考虑：

- 多个 Gateway 实例共同消费同一 outbox。
- SQLite 写锁等待持续成为主要延迟。
- 单机磁盘无法满足队列和媒体元数据增长。
- 需要在线备份、跨节点容灾或复杂运营查询。

在没有压测证据前迁移 PostgreSQL，只会增加部署复杂度。

---

## 9. 去重、防循环和消息顺序

## 9.1 入站事件去重

优先使用 Provider message ID，并将作用域包含在 event key 中：

```text
channel + accountId + conversationId + providerMessageId
```

不能只使用 providerMessageId，因为不同群可能出现相同局部 ID。

## 9.2 出站幂等

```text
deliveryId = hash(eventId + destinationEndpointId + routePolicy)
```

重试必须复用同一个 idempotency key，不能生成新任务。

## 9.3 Echo suppression

每次桥接发送带不可见 marker，并记录：

```text
deliveryId
destination channel/account/conversation
provider receipt messageId
```

目标平台再次回传时，只在 channel、account 和 conversation 全部匹配时判断为 echo，避免误吞其他群里碰巧相同的 ID。

## 9.4 顺序

系统保证范围应写清：

- 同一 destination endpoint 内尽力保持出站顺序。
- 不同 endpoint 之间不承诺全局顺序。
- 某条消息重试时，是阻塞该 conversation 后续消息，还是允许越过，需要成为可配置策略。

默认建议同 conversation 不越过，保证用户看到的顺序一致。

---

## 10. 故障和背压行为

| 故障 | 预期行为 |
|---|---|
| 单个平台不可用 | 只积压该平台 delivery，其他平台继续 |
| 单个 bot token 失效 | account 熔断并报警，不持续快速重试 |
| SQLite 暂时繁忙 | hook fail-closed、readiness degraded，不假装已接收 |
| 进程崩溃 | 已提交任务在 lease 到期后恢复 |
| 配置更新失败 | 保持旧 revision 继续运行 |
| 队列快速增长 | readiness degraded、报警、限制新高风险 fan-out |
| 磁盘接近满 | 停止接受新事件并明确报错，不能静默丢消息 |
| 单个热门群流量异常 | conversation/account 限流，不能拖垮全部平台 |

### 10.1 背压指标

至少暴露：

```text
pending deliveries
oldest pending age
in-flight deliveries
delivery success/failure/retry rate
per-platform queue depth
per-account cooldown
SQLite transaction latency
event loop delay
heap used / RSS
```

“进程还活着”不等于健康。队列最老任务持续增长时，readiness 应降级。

---

## 11. 同配置或较低配置机器的可行性

目前没有给出机器的 CPU、内存、磁盘和目标消息速率，因此不能诚实地保证具体配置一定承载 200～400 个机器人连接。

需要注意：Bridge JS 代码本身可能并不重，真正的资源大头可能是：

- 200～400 个 Provider SDK/session。
- 长连接、WebSocket、心跳和重连。
- OpenClaw Channel 插件自身缓存。
- 媒体上传和临时文件。
- 高峰期 outbox 数据和 Node.js heap。

建议把下面配置当成压测档位，而不是生产承诺：

| 档位 | 用途 | 初始验证范围 |
|---|---|---|
| 2 vCPU / 4 GiB | 开发、低流量 | 验证拓扑和几十个 active session |
| 4 vCPU / 8 GiB | 第一轮规模压测 | 逐步增加到 100～200 session |
| 8 vCPU / 16 GiB | 全规模候选 | 测试 200～400 session、故障和长时间 soak |

最终容量必须由“连接数 × 入站速率 × fan-out × Provider 延迟”共同决定。即使空闲连接很多，只要消息很少，也可能在低配置上正常；反之即使只有几十个群，热门房间也可能产生巨大 fan-out。

系统层面还要检查：

- 文件描述符上限。
- TCP/WebSocket 连接数。
- DNS 和连接池。
- SQLite 所在磁盘延迟。
- 日志写入量和轮转。
- 临时媒体目录容量。

---

## 12. 稳定性目标和语义

建议明确以下目标：

1. 入站事件提交数据库后，进程重启不能丢失。
2. 对外采用 at-least-once delivery，不宣称无法证明的 exactly-once。
3. 通过幂等键和 echo suppression 尽量实现用户可见的 effectively-once。
4. 同一目标群保持顺序。
5. 单个平台故障不影响其他平台。
6. 配置修改原子生效并可回滚。
7. 队列积压和 Provider 限流必须可见。

建议第一阶段 SLO 讨论基线：

```text
事件持久化成功率：目标 99.99%
正常负载下入站持久化 p95：目标 < 100ms
无 Provider 限流时的队列最老年龄：目标 < 5s
重启后恢复：不得丢失已提交 delivery
重复入站：不得生成重复目标 delivery
```

Provider 实际送达延迟不能完全由本服务保证，应单独统计。

---

## 13. 压测与验证方案

不能直接拿真实 20 个平台做第一轮压力验证。应先构建 fake Provider，模拟延迟、失败和限流。

## 13.1 基础拓扑场景

1. 10 个 room，每个 room 20 个 endpoint。
2. 200 个 endpoint 全部低频发送。
3. 一个热点 room 持续高频，其他 room 保持低频。
4. endpoint 同时加入两个 room，验证目标去重策略。

## 13.2 机器人场景

1. 200 个账号各自负责一个 endpoint。
2. 400 个账号中一半 active、一半 standby。
3. active bot 断开，standby 接管 ownership。
4. 同一 Provider message 被两个账号重复上报，验证去重。

## 13.3 Provider 故障场景

1. 固定 200ms 网络延迟。
2. 10% 请求返回临时 5xx。
3. 账号返回 429 和不同 `Retry-After`。
4. 单个平台离线 30 分钟，其他平台继续运行。
5. token 永久失效，验证熔断而不是无限重试。

## 13.4 持久化场景

1. 写入 event 后立即强制退出进程。
2. send 成功但 complete 前退出。
3. SQLite writer contention。
4. lease 到期后的重新 claim。
5. 配置更新与消息入站同时发生。

## 13.5 长时间运行

```text
第一阶段：30 分钟 burst test
第二阶段：2 小时稳定负载
第三阶段：24 小时 soak test
```

观察：

- RSS 是否持续增长。
- event loop delay 是否恶化。
- pending queue 是否能够回落到零。
- 重试是否形成同步风暴。
- SQLite 文件和 WAL 是否可控。
- shutdown 是否能在限定时间内完成。

---

## 14. 推进阶段建议

明天讨论确认后，建议按以下顺序推进。

### Phase 0：确认业务拓扑

- 10 个群是否按照序号形成 10 个跨平台 room。
- 一个 endpoint 是否允许加入多个 room。
- 10～20 个 bot 是分片、主备，还是同时监听。
- 允许的最大 room 大小。
- 是否要求同群严格顺序。

### Phase 1：规范化配置模型

- accounts/endpoints/rooms/memberships。
- 稳定 ID。
- 配置 revision 和原子更新。
- 从现有 links 格式迁移和回滚。

### Phase 2：锁定并发行为测试

- 同群串行。
- 不同群并行。
- 全局、平台和账号上限。
- 公平调度。
- 429/Retry-After。
- shutdown drain。

### Phase 3：实现有界并发 Delivery Scheduler

- 批量 claim。
- keyed lanes。
- token bucket。
- circuit breaker。
- event-driven wakeup + fallback poll。

### Phase 4：压测工具和指标

- fake 20-platform provider。
- 200 endpoint/400 account fixture。
- burst、outage、restart、duplicate 场景。
- 输出可重复的容量报告。

### Phase 5：根据证据决定是否需要 Go

只有满足以下条件时再评估 Go 重写：

- Node event loop 或 CPU 已被证明是主要瓶颈。
- Worker Threads 无法合理隔离 CPU 工作。
- JS 版本在满足正确限流后仍无法达到目标吞吐。
- 单二进制部署价值足以覆盖迁移成本。

如果瓶颈是 Provider 限流、SQLite 或 fan-out 数量，换 Go 不会自动解决。

---

## 15. 明天需要确认的问题

1. 每个平台的 10 个群，是否是一一对应形成 10 个跨平台 Bridge Room？
2. 每个平台的 10～20 个机器人，是分担不同群，还是同一群的主备？
3. 同一个群是否需要同时加入多个互通房间？
4. 单个群里的消息是否要求严格按原顺序出现在所有目标平台？
5. 预计最热门群每分钟大约有多少条文本和媒体消息？
6. 当前目标机器的 CPU、内存、磁盘类型和网络带宽是多少？
7. 允许平台离线时积压多久，队列达到什么规模需要停止接收？

这些问题确定以后，才能把“可以高并发运行”变成可测量、可验收的工程目标。

---

## 16. 当前建议

第一选择仍然是先完善 JavaScript 架构，而不是立即重写 Go：

```text
规范化 N 对 N 拓扑
→ 明确 bot ownership
→ 将串行 worker 改为有界分区并发
→ 建立平台限流和公平调度
→ 用 200 endpoint / 400 account fake 环境压测
→ 根据结果做容量结论
```

Node.js 有能力承担这一层。项目是否稳定，主要取决于 topology、fan-out、ownership、backpressure、idempotency 和 Provider limits 是否被正确设计，而不是只取决于实现语言。
