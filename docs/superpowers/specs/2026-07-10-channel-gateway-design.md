# Channel Gateway 独立服务设计

## 1. 目标

构建一个可独立启动的 Channel Gateway 服务，复用 OpenClaw 已有的 Channel 插件，与 Telegram、Discord、Slack、WhatsApp、Teams、Matrix、Signal 等软件互通。外部业务只面对稳定的 REST/SSE API，不需要理解 OpenClaw 的 Agent、Session 或 Plugin SDK 内部实现。

服务必须满足：

1. 无需配置 LLM/provider 凭据即可启动和处理 Channel 消息。
2. 一个进程可同时管理多个 Channel 和多个账户。
3. 入站消息在交给业务消费者前持久化，支持重启恢复和显式 ACK。
4. 出站消息复用 OpenClaw 的统一 `send` Gateway RPC，保留媒体、线程、回复、静默发送和幂等能力。
5. Channel 连接、配对、安全策略和重试仍由其官方插件负责。
6. OpenClaw Host 与 Channel 插件固定为同一版本并原子升级。
7. 可以把不同软件中的群聊或私聊加入同一个互通组；任一端的消息会自动、持久化地
   分发到组内其他端，并尽可能保留引用/回复关系。

## 2. 非目标

- 不重写 Telegram、Slack、Discord、WhatsApp 等平台 SDK。
- 不把 OpenClaw Gateway 当作可嵌入的稳定 Node library。
- 不在第一版重新实现 OpenClaw onboarding UI、插件市场或全部 Channel 特有管理动作。
- 不实现通用工作流编排器、任意脚本转换或复杂内容规则；第一版只提供明确 endpoint
  之间的消息互通。
- 不提供敌对多租户隔离；不互信租户必须使用独立进程、OS 用户或容器。

## 3. 方案选择

### 方案 A：直接复制 Channel 源码

不采用。现有插件通过模块级 runtime store、`gateway.startAccount`、完整 `PluginRuntime`、配置和状态数据库运行。复制插件目录仍需重写大部分 Host 行为，并会失去上游同步能力。

### 方案 B：重新实现兼容 Plugin SDK 的 Mini Host

不作为第一阶段。它需要复刻插件发现、runtime 注入、账户监督、配置、配对、媒体、状态、durable send 和新旧 adapter bridge，工作量接近重新实现 Gateway。

### 方案 C：独立 OpenClaw Gateway 进程 + Channel Bridge 插件

采用。运行边界是独立进程或容器；OpenClaw 只作为 Channel kernel。Bridge 插件提供自有 API，拦截入站消息并阻止进入模型，出站则转发现有 Gateway RPC。

```text
Business Service
    │  Bearer token
    │  REST / SSE
    ▼
Channel Bridge Plugin
    ├── durable event store (SQLite)
    ├── inbound hook bridge
    ├── route-link planner + durable delivery outbox
    └── Gateway RPC facade
             │
             ▼
OpenClaw Gateway / Channel Manager
    ├── Telegram
    ├── Discord
    ├── Slack
    ├── WhatsApp
    └── other official/external plugins
```

## 4. 进程与启动模型

发行基线固定为 `openclaw@2026.6.11`，对应上游 tag `v2026.6.11`
（commit `e085fa1a3ffd32d0ea6917e1e6fb4ecbffbb77d2`）。Bridge、Host 补丁和所有
官方外置 Channel 包均以这一版本为同一个升级单元；不得把 main 分支快照与已发布
npm 包混用。

`channel-gateway` 启动器负责：

1. 创建或读取独立 state/config/workspace 目录。
2. 从 `CHANNEL_GATEWAY_TOKEN` 读取 Gateway token；缺失时从 credentials 目录读取，仍缺失
   才生成并以 `0600` 权限持久化。token 通过 `OPENCLAW_GATEWAY_TOKEN` 传给子进程，
   不进入命令行参数，也不写入普通日志。
3. 生成最小配置：
   - `gateway.mode = "local"`
   - 默认 loopback bind
   - `gateway.auth.mode = "token"`
   - 关闭未使用的 Control UI
   - `agents.defaults.skipBootstrap = true`
   - 通过 `plugins.load.paths` 显式加载并启用 `channel-gateway` 插件
   - 将已安装且版本匹配的官方 Channel package root 加入 `plugins.load.paths`
4. 使用本项目依赖中的固定版本 `openclaw gateway run` 启动子进程。
5. 转发 SIGINT/SIGTERM，并保留 OpenClaw 的 Channel start/stop/restart supervision。

生产配置不依赖 `--allow-unconfigured`，避免隐藏损坏配置。服务没有模型配置；所有普通入站消息在 `before_dispatch` 阶段被 Bridge 标记为 handled。

## 5. 入站消息设计

### 5.1 Hook 策略

Bridge 同时注册：

- `message_received`：同步捕获 richer metadata，放入短生命周期 correlation buffer。
- `before_dispatch`：作为权威截流点，先尝试持久化并在成功时发布事件；无论成功或失败都
  返回 `{ handled: true }`，从而 fail closed 并终止 Agent/LLM 路径。

关联键优先级：

1. `channel + accountId + conversationId + messageId`（平台 message id 默认只在会话内唯一）
2. `sessionKey + timestamp + senderId + content hash`
3. `channel + accountId + conversationId + timestamp + content hash`

标准 Channel 的 `message_received` handler 在 hook runner 创建 promise 时会同步进入 handler，因此在同一 dispatch 的 `before_dispatch` 前可填充 correlation buffer。

WhatsApp 出于隐私默认不广播 `message_received`，服务生成的配置必须显式设置：

```json
{
  "channels": {
    "whatsapp": {
      "pluginHooks": {
        "messageReceived": true
      }
    }
  }
}
```

### 5.2 Rich inbound 兼容补丁

未修改的 OpenClaw `before_dispatch` 不包含 media、threadId、messageId、senderName 和 metadata。为保证独立发行版的完整事件保真度，本项目维护一个窄补丁：

1. 扩展 `PluginHookBeforeDispatchEvent/Context` 的可选字段。
2. 在调用 hook 前按需完成 hook media staging。
3. 将现有 canonical inbound context 字段传入 hook。
4. 增加测试，证明返回 handled 时不会调用模型且 media/thread/message metadata 被保留。

补丁只允许应用到上述固定 tag/commit；应用脚本必须先校验 Host 版本和目标片段，任何
版本或上下文不匹配都应失败，而不是静默跳过。Bridge 对未打补丁的兼容 Host 仍可工作，
但事件可能只有文本和基本路由字段。Docker/standalone 发行物必须使用已应用补丁的固定
Host 构建。

如果远端媒体 staging 失败，事件保留原始 media reference 并在 `metadata` 标记 staging
错误；无论持久化或媒体 staging 是否失败，Bridge 都必须 fail closed，阻止消息继续进入
Agent/LLM。

### 5.3 统一事件 DTO

```json
{
  "id": "evt_...",
  "channel": "telegram",
  "accountId": "default",
  "conversationId": "-100123",
  "sessionKey": "agent:bridge:telegram:...",
  "messageId": "42",
  "sender": {
    "id": "10001",
    "name": "Alice",
    "username": "alice"
  },
  "text": "hello",
  "threadId": "7",
  "replyTo": {
    "id": "41",
    "text": "previous message",
    "sender": "Bob"
  },
  "media": [
    {
      "path": "/state/media/inbound/file.jpg",
      "url": null,
      "mimeType": "image/jpeg"
    }
  ],
  "isGroup": true,
  "metadata": {},
  "receivedAt": "2026-07-10T09:00:00.000Z"
}
```

平台特有数据只进入 `metadata`，公共字段不使用平台专有命名。

## 6. 跨 Channel 互通组

### 6.1 精简配置模型

服务不引入独立工作流 DSL，只提供一个 `links` 数组。一个 link 表示一组相关会话，
endpoint 同时适用于群聊和私聊：

```json
{
  "id": "ops-room",
  "endpoints": [
    {
      "id": "qq-main",
      "channel": "qqbot",
      "accountId": "default",
      "conversationId": "qq-group-10001",
      "to": "qq-group-10001"
    },
    {
      "id": "feishu-main",
      "channel": "feishu",
      "accountId": "default",
      "conversationId": "oc_feishu_chat_id",
      "to": "oc_feishu_chat_id"
    },
    {
      "id": "wa-main",
      "channel": "whatsapp",
      "accountId": "default",
      "conversationId": "120363000000000000@g.us",
      "to": "120363000000000000@g.us"
    },
    {
      "id": "tg-main",
      "channel": "telegram",
      "accountId": "default",
      "conversationId": "-1001234567890",
      "to": "-1001234567890"
    }
  ]
}
```

规则：

- `conversationId` 用于匹配入站，`to` 用于出站；相同时仍显式保留两个语义。
- endpoint 默认 `receive = true`、`send = true`，可单独关闭一个方向。
- 一个 link 至少有两个 endpoint，且 endpoint id、入站匹配键均不得重复。
- 同一 endpoint 的消息绝不回发给自己；其余可写 endpoint 默认双向 fan-out。
- 消息显示格式固定为简洁前缀 `[{channel}/{sender}] {text}`；不在第一版提供模板语言。

### 6.2 Durable fan-out

入站事件与 fan-out delivery jobs 在同一个 SQLite transaction 中提交。外部事件 ACK 和
内部转发状态相互独立：消费者未 ACK 不阻塞转发，转发失败也不会删除原始 pending 事件。

delivery 状态：

- `pending`：等待发送。
- `sending`：worker 已原子 claim。
- `sent`：Gateway `send` 成功，保存平台 receipt/message id。
- `failed`：超过最大重试次数，保留可诊断的错误码。

delivery id 和 `idempotencyKey` 由 `event id + link id + destination endpoint id` 确定；
进程崩溃或重启不会产生第二条逻辑转发。

Bridge hook 本身不具备 authenticated HTTP request scope，不能直接使用
`gateway-method-runtime`。后台 worker 因而通过 loopback、Bearer-authenticated
`POST /api/v1/messages` 调用本插件自己的公开 route；token 只从进程环境读取，永不进入
任务 payload 或日志。这样所有自动转发和外部调用共用同一条已验证的 Gateway RPC 路径。

### 6.3 防回环与消息关联

- 每条自动转发追加不可见的版本化 bridge marker；入站 normalizer 会剥离已知 marker。
- 发送成功后保存 destination receipt message id。入站 message id 命中 receipt，或命中
  本实例已知 marker 时，视为 bridge echo：截断 Agent/LLM，但不再 fan-out。
- marker 只作为 receipt 缺失时的兼容 fallback；未知/伪造 marker 不获得管理权限。
- delivery receipt 记录 `origin event id`。若新消息的 `replyToId` 指向某条已转发消息，
  planner 查找同一 origin 在各 endpoint 的 receipt，并为目标端设置相应 `replyToId`。
- 某个平台不返回 receipt 或不支持 reply 时，消息仍正常分发，只降级为无引用文本。

该模型使 QQ 群、飞书群、WhatsApp 私聊/群聊、Telegram 群以及其他已安装 Channel 使用
同一套代码，不在 router 内出现按平台分支。

## 7. Durable event store

Bridge 使用自己的 `channel-gateway.sqlite`，避免依赖仅向 bundled/trusted official plugins 开放的 `api.runtime.state.openChannelIngressQueue`。

事件状态：

- `pending`：已持久化、尚未 ACK。
- `acked`：消费者已确认，保留 tombstone 用于去重。
- `failed`：无法正常投递或被管理员标记失败。

关键规则：

- SQLite transaction commit 成功后，事件才可交给 REST/SSE 消费者。
- 持久化失败时 `before_dispatch` 仍返回 handled，防止消息意外落入 Agent/LLM；同时将
  Bridge 标记为 degraded、记录不含消息正文的错误并使 `/api/v1/health` 返回 503。
  磁盘故障下无法同时保证持久化和继续处理，因此此处明确选择安全停机/人工恢复，
  而不是调用模型。OpenClaw 自身的 `/readyz` 不作为 Bridge 数据库 readiness 的替代。
- event id 唯一；重复入站执行幂等 upsert，不创建第二条事件。
- richer `message_received` 数据可以补全同一 pending 事件，但不能覆盖已存在的非空字段为空值。
- 每行同时保存公开 event id 和内部单调递增 `seq`；`after` 使用 event id 定位其 `seq`。
- SSE 每次连接都优先重放所有未 ACK 事件。`Last-Event-ID` 仅作为已观察高水位，不能跳过
  更早但仍 pending 的事件。
- ACK 产生 tombstone；定期按 TTL 清理 acked/failed rows。
- SQLite 使用 WAL、busy timeout、参数化查询和单写入队列。
- 同一数据库还保存 link delivery outbox 和 receipt relation；事件 enqueue 与 delivery
  创建必须原子提交。

## 8. HTTP API

所有业务接口注册为 `auth: "gateway"`，复用 Gateway Bearer token。Bridge manifest 声明：

```json
{
  "contracts": {
    "gatewayMethodDispatch": ["authenticated-request"]
  }
}
```

HTTP route 使用 `gatewayRuntimeScopeSurface: "trusted-operator"`，并通过公开 SDK
`openclaw/plugin-sdk/gateway-method-runtime` 的 `dispatchGatewayMethod(...)` 转发 RPC。
不得调用 `api.runtime.gateway.request(...)`：该内部入口只允许 bundled/trusted-official
插件，而且默认 synthetic client 只有 `operator.write`，无法执行需要 `operator.admin`
的 Channel 生命周期 RPC。

### `GET /api/v1/health`

返回 Bridge 版本、OpenClaw 版本、数据库状态和 pending 数量。

### `GET /api/v1/channels`

转发 `channels.status`，可选 `?probe=true`。

### `GET /api/v1/links`

返回已校验的 link/endpoint 摘要、pending/failed delivery 计数；不返回 token、credential
或完整消息正文。

### `POST /api/v1/channels/:channel/start`

转发 `channels.start`，body 可带 `accountId`。

### `POST /api/v1/channels/:channel/stop`

转发 `channels.stop`。

### `POST /api/v1/channels/:channel/logout`

转发 `channels.logout`。首次凭据设置、QR 登录和复杂 onboarding 继续使用 OpenClaw 原生命令，避免复制各 Channel setup flow。

### `POST /api/v1/messages`

请求映射至 Gateway `send` RPC：

```json
{
  "channel": "telegram",
  "accountId": "default",
  "to": "123456",
  "message": "hello",
  "mediaUrls": [],
  "replyToId": "41",
  "threadId": "7",
  "silent": false,
  "idempotencyKey": "caller-generated-key"
}
```

`idempotencyKey` 必填；API 不偷偷生成不可重放的 key。

### `GET /api/v1/events`

分页读取 pending 事件，支持 `after`、`limit`。未知 `after` 返回 400；`limit` 限制在
`1..500`，默认 100。

### `GET /api/v1/events/stream`

SSE 实时流。连接建立时先重放全部未 ACK 事件，再推送新事件；定期发送 heartbeat
comment。慢消费者超过有界发送队列时主动断开，让客户端通过 pending replay 恢复，
避免一个连接拖垮 Gateway 进程。

### `POST /api/v1/events/:id/ack`

幂等 ACK。不存在的 id 返回 404；已 ACK 返回当前 tombstone，不报冲突。

## 9. Channel 安装与版本策略

- 根依赖固定为精确 `openclaw@2026.6.11`。
- 官方外置 Channel 必须与 Host 固定同版本，例如 `@openclaw/discord@2026.6.11`、`@openclaw/slack@2026.6.11`、`@openclaw/whatsapp@2026.6.11`。
- 飞书使用精确版本 `@openclaw/feishu@2026.6.11`，属于 common profile。
- Telegram 随 core 分发，不依赖单独的 `@openclaw/telegram` npm 包。
- 提供安装命令或镜像 build arg 来选择 Channel profile；启动器只加载实际存在且版本完全
  匹配的包。缺包是“未安装”，版本不一致是启动错误，不能降级继续运行。
- 基础 profile 只使用 core 内的 Telegram/WebChat 等能力；Discord/Feishu/Slack/WhatsApp 等
  作为精确锁定的可选 profile 安装，不在基础镜像中强行携带全部原生/许可证敏感依赖。
- QQ connector 当前依赖清单存在 `UNLICENSED` 项，默认发行 profile 不包含它。
- QQ link 逻辑仍完全支持 `channel = "qqbot"`；操作者在确认许可后显式安装精确版本
  `@openclaw/qqbot@2026.6.11`，服务即可发现并加载，不需要修改路由代码。
- Host 与所有 Channel package 作为一个升级单元；升级时运行 plugin inspect、channel status probe 和契约测试。

## 10. 安全边界

- 默认 bind loopback；容器对外暴露时必须使用 token auth 和反向代理 TLS。
- `trusted-operator` route 使持有该 token 的调用方能够执行 Channel 管理操作，因此该 token
  等同实例管理员凭据，不应与普通终端用户共享。
- JSON body 有固定大小上限，拒绝重复/冲突 Content-Length。
- 外部消费者只能读取已通过 OpenClaw pairing/allowlist/mention policy 的消息。
- 不把 raw credentials 返回 API；配置和 credential/state volumes 分开挂载。
- 一个不互信租户一个实例。插件与 Gateway 同进程运行，不视为沙箱。
- 日志不输出 token、消息完整 media 路径或平台 credential。

## 11. 独立运行与部署

本地运行：

```bash
CHANNEL_GATEWAY_TOKEN=change-me npm start
```

Docker：

```bash
docker compose up --build
```

持久卷：

- `/data/config`
- `/data/state`
- `/data/credentials`
- `/data/workspace`

OpenClaw 仍把部分 Channel 凭据解析为 state 下的 canonical path；容器通过嵌套挂载把
`/data/credentials` 映射到该凭据路径，而不是修改各 Channel 的存储实现。

基础健康证明：

1. 不存在任何模型 auth profile。
2. Gateway 和 Bridge 启动成功。
3. `/healthz` 与 `/api/v1/health` 返回 200。
4. `GET /api/v1/channels` 能列出已安装插件及 unconfigured 状态。
5. 写入 pending 事件后重启，事件仍可读取并 ACK。

## 12. 验证策略

### 单元测试

- 请求解析、body limit、鉴权由 Gateway route 层覆盖。
- event id 稳定性和 correlation merge。
- SQLite enqueue/upsert/list/ack/recovery/prune。
- send RPC 参数映射和错误透传。
- Channel start/stop/logout 参数验证。
- link config 验证、双向 fan-out、单向 endpoint、idempotency key 和 marker 剥离。
- delivery claim/retry/restart recovery、receipt echo suppression 和 reply relation 映射。

### 集成测试

- 用 fake Plugin API 注册 Bridge，验证 hooks 和 routes。
- `message_received` + `before_dispatch` 产生一条 durable event。
- 持久化失败时仍返回 handled、readiness 变为 degraded，且不产生模型调用。
- before_dispatch handled 不产生模型调用。
- SSE reconnect 能重放未 ACK 事件。
- 使用 fake Gateway sender 验证 QQ → 飞书/WhatsApp/TG fan-out，以及任一目标反向消息
  能发回其他 endpoint 且不会产生 echo loop。

### Standalone smoke

- 从空 state dir 启动固定发布版 OpenClaw，并验证固定版本 rich-hook 补丁已应用。
- 加载 Bridge 和至少 Discord/Feishu/Slack/WhatsApp 官方包但不配置凭据。
- 验证健康、插件发现和 Channel status。
- 不声称完成真实平台 live proof，除非提供对应平台 credential/sidecar；代码和契约验证与 live credential 验证必须分开报告。

## 13. 许可证与发行

- 分发物保留 OpenClaw `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
- 构建生成 SBOM 和完整 dependency license report。
- WhatsApp 的 GPL/LGPL 闭包、OpenClaw 的 MPL 组件、Teams 缺失 license metadata 以及 QQ `UNLICENSED` 依赖进入发布阻断/人工审核清单。
- OCI license label 不能替代实际许可文本。

## 14. 成功标准

项目完成必须同时满足：

1. `channel-gateway` 可在空目录中单独启动。
2. 不配置模型 provider 仍能保持运行。
3. 入站 hook 能持久化并截断 Agent dispatch。
4. REST 可以通过真实 Gateway RPC 查询 Channel 和发送消息。
5. 重启后 pending 事件仍存在。
6. lint、静态检查、单元/集成测试通过。
7. Docker/本地启动文档和许可证文件齐全。
8. 一个至少包含四个 endpoint 的 link 能在测试中双向 fan-out，重启后未完成 delivery
   会继续执行，平台回显不会形成循环，reply receipt 可在支持的平台间保持关联。
