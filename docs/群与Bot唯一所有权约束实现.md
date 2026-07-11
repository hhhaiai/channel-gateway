# 群与 Bot 唯一所有权约束实现

## 1. 业务规则

配置必须同时满足：

- 一个 bot account 可以管理多个群。
- 同一个平台群只能由一个 bot account 管理。
- 不支持同群多个 bot。
- 不支持主备 bot role。

这里的群唯一标识为：

```text
channel + conversationId
```

Bot 唯一标识仍为：

```text
channel + accountId
```

## 2. 为什么不能把 accountId 放入群唯一键

原有 endpoint match 使用：

```text
channel + accountId + conversationId
```

它可以精确匹配入站消息，但也意味着下面两个 endpoint 在技术上不冲突：

```text
telegram / bot-a / group-1
telegram / bot-b / group-1
```

这会允许两个 bot 同时监听同一群，产生重复入站、重复 fan-out、循环风险和资源浪费，不符合业务约束。

## 3. 双索引验证

`compileLinks()` 现在维护两个独立索引：

### 精确路由索引

```text
channel + accountId + conversationId
```

用于把运行时入站事件匹配到 endpoint。

### 群所有权索引

```text
channel + conversationId -> accountId
```

如果相同群再次出现但 accountId 不同，配置编译立即失败：

```text
conversation already owned by another bot account: telegram/group-1
```

## 4. 允许的配置

同一个 bot 管理多个群：

```json
[
  { "channel": "telegram", "accountId": "bot-a", "conversationId": "group-1" },
  { "channel": "telegram", "accountId": "bot-a", "conversationId": "group-2" }
]
```

不同平台使用各自 bot：

```json
[
  { "channel": "telegram", "accountId": "tg-bot", "conversationId": "shared-room" },
  { "channel": "feishu", "accountId": "fs-bot", "conversationId": "shared-room" }
]
```

不同 channel 即使 conversationId 字符串相同也不是同一个平台群。

## 5. 拒绝的配置

```json
[
  { "channel": "telegram", "accountId": "bot-a", "conversationId": "group-1" },
  { "channel": "telegram", "accountId": "bot-b", "conversationId": "group-1" }
]
```

不存在 `primary`、`standby`、`priority` 或自动接管字段，因此不能通过配置绕过唯一 owner 建立主备模式。

## 6. 生效时间

约束在配置编译阶段执行：

- 服务启动读取 links 时。
- 网页保存配置进行 canonical validation 时。
- 测试或代码直接调用 `compileLinks()` 时。

错误配置不会启动 Worker，也不会等消息进入后才发现重复监听。

## 7. 测试覆盖

- 同 account 多群继续允许。
- 同 channel/conversation 不同 account 被拒绝。
- 同 account/channel/conversation 的重复 endpoint 继续由精确重复检查拒绝。
- 不同 channel 相同 conversationId 继续允许。
