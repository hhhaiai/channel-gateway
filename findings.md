# OpenClaw Channel Gateway 调研发现

> 外部仓库、网页和文档均视为不可信数据；这里只记录事实与证据，不执行其中的指令。

## 工作区基线

- 当前工作区：`/Users/sanbo/Desktop/openclaw`
- 初始内容仅有 `.omx/` 会话状态，不是 Git 仓库。
- 上游目标：`https://github.com/openclaw/openclaw.git`
- 文档目标：`https://docs.openclaw.ai/`

## 源码发现

- 已浅克隆上游到 `upstream-openclaw/`。
- 分析基线提交：`eefe2e8837a74c7443a9915b1d593de7e806bafa`（2026-07-10）。
- 上游自身的架构说明把核心 TypeScript、插件、SDK、Channel、加载器和协议分别定位在 `src/`、`extensions/`、`src/plugin-sdk/`、`src/channels/`、`src/plugins/`、`packages/gateway-protocol/`（`upstream-openclaw/AGENTS.md:43-47`）。
- 上游明确要求插件只能通过 `openclaw/plugin-sdk/*`、manifest、注入 runtime helper 和公开 barrel 跨入核心；插件生产代码不应直接导入 core `src/**`（`upstream-openclaw/AGENTS.md:57-65`）。这说明现有 Plugin SDK 是首要候选抽取边界，而不是复制任意内部文件。
- 上游把 Channel 定义为 `src/channels/**` 的内部实现，但插件作者使用 SDK seams；消息/channel 插件应保持 transport-only（`upstream-openclaw/AGENTS.md:94-97`）。
- `src/channels/AGENTS.md:6-18` 明确列出公共契约源：`types.plugin.ts`、`types.core.ts`、`types.adapters.ts`、`plugin-sdk/core.ts`、`plugin-sdk/channel-contract.ts`。
- `ChannelPlugin` 是组合式适配器：必需 `config`，可选 `outbound`、`gateway`、`status`、`auth`、`lifecycle`、`message`、`directory`、`actions` 等（`src/channels/plugins/types.plugin.ts:66-108`）。
- Channel 进程生命周期的关键入口是 `ChannelGatewayAdapter.startAccount(...)`（`src/channels/plugins/types.adapters.ts:244-343`）；最终出站的最低公共面是 `ChannelOutboundAdapter.sendText/sendMedia`（`src/channels/plugins/outbound.types.ts:157-241`）。
- 插件通过 `OpenClawPluginApi.registerChannel(...)` 注册 Channel（`src/plugins/types.ts:2385-2388,2634-2676`）；bundled entry 最终也调用此注册方法（`src/plugin-sdk/channel-entry-contract.ts:545-547`）。
- 上游已经把控制面和运行面拆分：manifest/discovery/setup 在加载 runtime 前工作；真正执行通过 runtime resolution 进入（`src/plugins/AGENTS.md:24-48`）。这对独立服务很有价值，可以复用为“配置/发现”和“连接器进程”两层。
- Plugin SDK 不是一个很小的包：当前含大量 channel lifecycle、ingress、outbound、reply、state、media、approval 和 gateway runtime 子路径。简单复制 `ChannelPlugin` 类型不足以运行现有适配器。
- `ChannelGatewayContext` 除账户、配置、状态和取消信号外，还可注入完整 `ChannelRuntimeSurface`；其注释明确包含 AI reply、agent routing、session、media、commands、pairing 等 OpenClaw 能力（`src/channels/plugins/types.adapters.ts:244-313`）。独立互通服务不应照搬这些 AI/agent 责任。
- `PluginRuntimeChannel` 的实际类型直接引用 `auto-reply`、`agents`、`routing`、`sessions`、`pairing`、`media`、`turn/kernel` 等核心模块（`src/plugins/runtime/types-channel.ts:75-203`）。因此兼容现有插件的最大技术难点在“入站处理依赖”，不是出站 API。
- 出站契约相对独立：`ChannelOutboundContext` 主要是目标、文本、媒体、回复/线程、账户和发送依赖；适配器声明 delivery mode、chunking、presentation/capability 并实现 `sendPayload/sendText/sendMedia/sendPoll`（`src/channels/plugins/outbound.types.ts:21-49,157-243`）。
- 当前仓库 manifest 中可识别出约 25 个内置/官方 Channel 包，包括 Discord、Feishu/Lark、Google Chat、iMessage、IRC、LINE、Matrix、Mattermost、Microsoft Teams、Nextcloud Talk、Nostr、QQ Bot、Signal、Slack、SMS、Synology Chat、Telegram、Tlon、Twitch、WhatsApp、Zalo/Zalo Personal 等；另有外部 WeChat、Yuanbao、Zalo ClawBot（`docs/channels/index.md:17-46`）。
- 更精确的用户可见盘点是 28 个通信面：核心 iMessage/Telegram/WebChat；约 22 个官方外置插件；仓库外 WeChat/Yuanbao/Zalo ClawBot。ClickClack 已有正式 manifest/文档/发布元数据但漏出 channel index，属于文档索引漂移；`qa-channel` 仅为测试面（证据汇总见 `docs/plugins/plugin-inventory.md:12-33,100,156,202,222-330` 与 `docs/channels/index.md:12-46`）。
- transport 形态不统一：Slack 是 Socket Mode，Feishu 是 WebSocket，Google Chat/LINE/SMS/Synology/Nextcloud 多为 HTTP webhook，WhatsApp/iMessage/Signal 依赖本地或持久连接客户端，Discord 同时使用 Bot API + Gateway。独立服务必须支持多种 connector lifecycle，而不能只做 webhook 聚合器。
- 代表性能力差异也显著：Telegram/Discord/Slack 支持 rich payload、thread、edit/delete/reaction 等；WhatsApp/Signal 的持久连接与媒体/语音常依赖 QR、Baileys、signal-cli/sidecar 和 ffmpeg；Teams 依赖 Bot Framework webhook，部分历史/附件能力还需 Graph/SharePoint。统一 API 必须用 capability discovery，不能承诺所有动作处处可用。
- 代表性插件不是“纯 SDK 对象”：Telegram entry 通过 `defineBundledChannelEntry` 声明 channel plugin、secret contract、runtime setter，并在 full mode 注册额外 MiniApp（`extensions/telegram/index.ts:1-26`）。Host 必须能在加载时注入 plugin runtime。
- Telegram 使用 `createPluginRuntimeStore<TelegramRuntime>` 保存进程级 runtime（`extensions/telegram/src/runtime.ts:1-13`）；其 `channel.ts` 大量调用 `getTelegramRuntime()`，说明只给 `startAccount(ctx)` 传局部依赖不够，兼容 Host 还必须实现并注入上游 `PluginRuntime` 的所需子集。
- Telegram 的连接器入口确实位于 `gateway.startAccount`，并把 `ctx.channelRuntime` 继续传给监控器；同样模式也出现在 WhatsApp（`extensions/telegram/src/channel.ts:1024-1113`; `extensions/whatsapp/src/channel.ts:337-353`）。
- 上游存在通用插件 hook `message_received`（`src/plugins/hooks.ts:1063-1070`），但是否每个 Channel 在进入 agent 之前一致触发、能否阻止后续 agent 处理，尚需验证；WhatsApp 配置类型还出现“enable message_received hooks”开关，提示该 hook 可能不是所有 transport 的强制统一入口（`src/config/types.whatsapp.ts:144-159`）。
- `inbound_claim` 的契约确实允许 `{ handled: true, reply? }`（`src/plugins/hook-types.ts:461-464`），但当前生产调用链只在已有 plugin-owned conversation binding 时调用 targeted form；repo-wide 非测试调用点未发现普通全局 `runInboundClaim(...)`。因此不能把它当作所有 Channel 的通用截流点。
- `PluginHookInboundClaimEvent` 已经是适合外部服务的规范化消息模型：content/body/transcript、channel/account/conversation、sender、reply、thread、message/session/run、group 和 metadata（`src/plugins/hook-message.types.ts:59-99`）。
- 共享 inbound dispatcher 在绑定会话的 targeted claim 返回 handled 后确实结束本次 dispatch（`src/auto-reply/reply/dispatch-from-config.ts:2375-2464`）。普通消息更适合利用全局 `before_dispatch`：其结果同样是 `{ handled, text? }`，并且当前 dispatcher 对所有消息调用它（`src/plugins/hook-types.ts:466-497`; `src/auto-reply/reply/dispatch-from-config.ts:2807-2827`）。
- 上游已有成熟统一出站路径 `deliverOutboundPayloads`，它动态加载 Channel outbound adapter、处理 message hooks、持久化 delivery queue、unknown-send reconciliation 和部分发送结果（`src/infra/outbound/deliver.ts:247-318,1332-1653`）。独立服务应复用这一层，而不是直接调用每个 SDK。
- 命令行已有统一 `openclaw message send --channel ... --target ...`，且多 Channel 文档都使用它（例如 `docs/cli/message.md`, `docs/channels/telegram.md:740-742`）。因此对外 HTTP `POST /v1/messages` 可以薄封装现有统一 send pipeline。
- `before_dispatch` 的 handled 路径已经得到完整验证：hook 被 await；返回 `{ handled: true }` 后记录完成、提交入站去重并直接 return，不进入模型（`src/auto-reply/reply/dispatch-from-config.ts:2807-2869`）。因此文本消息可以无模型运行。
- 但 `before_dispatch` 当前事件只带文本、channel/account/conversation/session/sender/reply/group/timestamp，不带规范化 media 列表、senderName/username、threadId、messageId、metadata（`src/plugins/hook-types.ts:466-497`; `src/auto-reply/reply/dispatch-from-config.ts:2815-2841`）。要做完整互通服务，需要扩展这个公共 hook 或新增一个 awaited 的 rich inbound hook。
- 新的 `src/channels/message/**` 抽象主要成熟在 durable outbound（receipt、render/send/edit/delete/commit/recovery）和 receive ack policy；当前并没有一个所有插件都直接产出的、可脱离 agent 的完整统一入站消息对象（`src/channels/message/types.ts:13-166`; `src/channels/message/receive.ts:8-79`）。
- `channel-ingress` SDK 的职责是访问控制/配对/mention/command admission，而不是把平台消息发布给外部消费者（`src/plugin-sdk/channel-ingress.ts:1-101`; `channel-ingress-runtime.ts:1-43`）。
- Bridge 可以直接挂在现有 Gateway 内：插件 HTTP route 支持 Node `IncomingMessage/ServerResponse`、prefix/exact match、Gateway 或插件自管鉴权，并可提供 WebSocket upgrade handler（`src/plugins/types.ts:2142-2169`）。因此同一进程可提供 REST、SSE 或 WebSocket，不必再套第二个 Web 框架。
- 插件还可注册长生命周期 service，Gateway 会统一 start/stop；这适合管理事件队列、webhook delivery worker 和 SSE/WS subscribers（`src/plugins/types.ts:2356-2383`; `src/plugins/types.ts:2720`）。
- 统一出站函数 `deliverOutboundPayloads` 已经通过 `openclaw/plugin-sdk/outbound-runtime` 暴露（`src/plugin-sdk/outbound-runtime.ts:21`），Bridge 插件可直接复用；若要支持 edit/react/delete/poll 等动作，可调用与 CLI 相同的 `runMessageAction`/Gateway 方法，而不是仅调用 `sendText`。
- `PluginRuntime.gateway.request(method, params)` 允许受信任插件在当前 Gateway 上下文调用 Gateway RPC（`src/plugins/runtime/types.ts:93-104`），这也是 REST handler 转发至既有 message action RPC 的可选路径。
- Gateway 启动是明确的两阶段：先 setup-runtime/HTTP attach，再完整加载插件并启动 channel sidecars（`src/gateway/server.impl.ts:678-700,1684-1746`; `src/gateway/server-startup-post-attach.ts:709-749`）。Bridge 必须作为正常插件参与该生命周期，不能在外部抢跑 connector。
- Channel manager 枚举账户、检查 enabled/configured、注入 config/account/runtime/abort/status，然后调用 `gateway.startAccount`；连接任务正常退出也会被视为异常并进入重启策略（`src/gateway/server-channels.ts:555-685,689-818,966-999`）。这套监督逻辑应保留在 OpenClaw，而不是在抽取服务中重写。
- 新入站 kernel 是 `ChannelTurnAdapter` 的 ingest → classify → preflight → resolve/assemble → session record → dispatch → delivery 阶段（`src/channels/turn/types.ts:453-486`; `src/channels/turn/kernel.ts:547-604,678-849`）。但物理 socket/webhook 收包仍完全由各插件的长生命周期 `startAccount` 所有，没有统一 core `onMessage` callback。
- Gateway 已有稳定统一 `send` RPC：请求校验/去重/选择 channel/target/session 后进入 durable message core，再通过新 `ChannelMessageSendAdapter` 或旧 outbound bridge 到平台发送（`src/gateway/server-methods/send.ts:632-855`; `src/channels/message/send.ts:211-407`; `src/channels/message/outbound-bridge.ts:171-238`）。Bridge REST 应优先转发该 RPC，而非调用 deprecated direct delivery substrate。
- receive durability 仍未完全统一：receive context/journal 已有定义，但 ACK 时机、dedupe/retry 仍由插件组合。外部事件服务必须在“本地 durable enqueue 成功”后才让 inbound bridge 返回 handled，否则进程崩溃会丢消息。

## 架构判断

- 初步判断：适配器层已经有插件化方向，但“能否独立运行”取决于 SDK runtime 注入中是否仍强依赖 gateway、agent loop、全局配置和状态库。必须从实际调用链验证，不能只按目录名抽取。
- 抽取应围绕 `ChannelPlugin + PluginRuntimeChannel + plugin loader` 做依赖闭包分析，而不是按 `src/channels/` 单目录复制；现有扩展被禁止直接依赖 core internals（`extensions/AGENTS.md:25-37`），理论上可由另一个兼容 Host 承载。
- 推荐目标边界开始清晰：保留插件的 config/gateway/outbound/actions/directory 能力；把 OpenClaw `channelRuntime.inbound.run/dispatchReply` 替换为 Gateway 自己的统一事件发布器，由外部业务通过 HTTP/WebSocket/NATS 等消费后再调用统一发送 API。是否能不改插件直接替换，需继续检查典型插件是否把 `api.runtime` 固存在模块级 runtime store。
- 现有插件确实把 runtime 固存在模块级 store，因此“完全不改插件 + 自己重新实现一个极小 Host”风险较高。更现实的是：复用 OpenClaw 的 loader/runtime 基础设施，替换 agent dispatch owner；或 fork 后把 agent reply kernel 后端做成可注入的 external-event backend。
- 当前最有希望的低侵入方案修正为：把 OpenClaw 的 plugin/channel runtime 作为内部 kernel，Bridge 使用全局 `before_dispatch`（或新增一个明确的 external ingress backend seam）可靠投递事件并返回 handled，避免进入模型；`inbound_claim` 仅用于已经绑定给特定插件的会话。对外发送仍走现有 `deliverOutboundPayloads`。
- 对完整产品而言，推荐新增一个很小、可上游同步的 SDK seam，例如 awaited `channel_message_ingress` hook：输入直接复用 `CanonicalInboundMessageHookContext` 的丰富字段，结果为 `{ handled, reply? }`。这比让 Bridge 拼接 `message_received`（fire-and-forget）与 `before_dispatch`（字段不足）可靠。
- 服务形态可收敛为一个 Node 进程：OpenClaw channel/plugin kernel + Bridge plugin；Bridge 自己提供 `/v1/messages`、`/v1/events`、`/v1/channels`、`/healthz`，并使用现有 Gateway auth。这样“独立执行”成立，但内部仍依赖 OpenClaw runtime，避免 fork 20+ connector。
- 进程边界应进一步收紧：运行产物是一个独立 Gateway 进程/容器，Bridge 作为插件同进程加载；外部业务只依赖 Bridge 的 REST/SSE/WS 契约，不依赖 OpenClaw 内部 TypeScript API。官方 Channel 插件与 Host 固定同一版本并原子升级。
- 若未来真要形成通用 `channel-kernel` library，可抽 `ChannelTurnAdapter` 阶段模型、account lifecycle、message adapter/receipt/ack，并把 config/session/agent/delivery 换成 ports；但这只是长期二阶段工作，不能单独承载现有 20+ 插件。当前服务目标不应先走这条路。

## 许可证与分发

- OpenClaw 根项目是 MIT，明确允许 use/copy/modify/merge/publish/distribute/sublicense/sell；复制或形成 substantial portions 时必须保留版权与许可文本（`upstream-openclaw/LICENSE:1-20`）。
- `THIRD_PARTY_NOTICES.md` 目前记录 Pi/pi-mono 适配代码，同为 MIT；独立分发仍应保留该 notices 文件（`THIRD_PARTY_NOTICES.md:1-36`）。
- 根 npm 包 `openclaw@2026.6.11` 要求 Node `>=22.19.0 <23 || >=23.11.0`，并正式导出大量 `openclaw/plugin-sdk/*` 子路径；因此以发布包作为内部 kernel 在许可证和包边界上均可行。
- 多数外置官方 Channel 包显式 peer-depend `openclaw >=2026.6.11`（Slack、Discord、WhatsApp、Teams、Matrix 等），证明上游分发模型本来就是“Channel 包 + OpenClaw Host”，而不是独立 connector library。
- 代表性第三方依赖：Telegram/grammY，Slack/Bolt，Discord/ws + voice，WhatsApp/Baileys，Teams/Microsoft Teams SDK + Azure Identity，Matrix/matrix-js-sdk + native/wasm crypto。容器镜像和 SBOM 必须逐包保留其许可证，且 Matrix/iMessage/Signal 等有平台或原生运行时要求。
- Gateway CLI 的 run options 已包含 `allowUnconfigured`，说明上游预留了无完整 onboarding 配置启动路径（`src/cli/gateway-cli/run-options.ts:5-26`）；服务封装应固定使用该模式并显式生成/注入 Gateway token，而不是要求模型 provider onboarding。
- 精确语义：`gateway.mode=local` 或 `--allow-unconfigured` 都会跳过启动 guard；CLI 帮助明确后者只放行、不修复 config（`src/cli/gateway-cli/run.ts:228-255`; `src/cli/gateway-cli/run-command.ts:42-44`）。生产配置应显式写 `gateway.mode=local`，仅把 flag 当恢复/测试手段。
- Gateway 在 token 缺失时可为当次启动生成临时 token，但重启会变化（`src/gateway/server.impl.ts:419-429`）；独立服务必须持久配置 token/SecretRef，不能依赖临时值。
- 上游自身的最小 dev config 只有 `gateway.mode=local`、loopback bind 和一个 `skipBootstrap` agent workspace，并未要求模型凭据（`src/cli/gateway-cli/dev.ts:98-135`）。结合 `before_dispatch` 短路，可实现“无 LLM 凭据”的 Channel-only 运行。
- 上游官方外部应用建议是把 Gateway 当独立进程，通过 WebSocket/RPC 连接；当前 `packages/gateway-client` 仍为 private，根 library facade 也没有稳定 server factory（`docs/gateway/external-apps.md:11-19,40-46`; `packages/gateway-client/package.json:2-5`; `src/library.ts:1-68`）。所以不应把 Gateway internal server 直接 import 到自有进程。
- 再分发不能只看根 MIT：WhatsApp 依赖闭包含 LGPL/GPL 组件，QQ connector shrinkwrap 标记 `UNLICENSED`，OpenClaw 根含 MPL-2.0 `web-push`，Teams 有缺失 license metadata 的依赖。正式镜像必须生成 SBOM/license bundle，并对 QQ/WhatsApp/Teams 单独法务审查；默认不把 `UNLICENSED` QQ 包打入公开镜像。
- 上游 Docker 最终镜像只设 MIT OCI label、未显式 COPY 根 `LICENSE`/`THIRD_PARTY_NOTICES.md`（`Dockerfile:180-217`）；本服务镜像应补齐完整文本。

## 当前实现与运行验证（2026-07-11）

- `channel-gateway` 已形成独立 npm 包，固定 `openclaw@2026.6.11`，并将 Discord、Feishu、Slack、WhatsApp 同版本官方包列为 optional dependencies；Telegram 是 OpenClaw core 内置 Channel，无需单独包。
- 独立启动器生成隔离的 config/state/credentials/workspace、持久化 0600 Gateway token、写入 `gateway.mode=local`、关闭 Control UI/reload，并用 `node <serviceRoot>/node_modules/openclaw/openclaw.mjs gateway run` 启动固定版本 Host。
- 真实 smoke test 已证明该边界可运行：加载 13 个插件并到达 `[gateway] ready`；`GET /health` 返回 `200 {"ok":true,"status":"live"}`；SIGINT 在约 1 秒内完成 clean shutdown。
- 当前 Gateway 日志仍打印默认 agent model，但 `before_dispatch` 插件会在持久化后返回 handled，因此正常桥接消息不应进入模型；仍需通过真实/合成 inbound 集成测试证明这个最终行为。
- `channel-gateway` 插件当前注册 `message_received` + awaited `before_dispatch`，前者补充 messageId/thread/metadata，后者持久化并短路模型路径。WhatsApp 初始配置显式打开 `channels.whatsapp.pluginHooks.messageReceived=true`，否则相关 enrichment hook 不广播。
- 当前 `/api/v1` 与 `/api/v1/health` 均返回 `503 API_NOT_READY`，因为 `createBridgeRuntime` 默认 HTTP handler 仍是占位符。统一 REST/SSE API 是明确未完成项，不能仅凭 Gateway ready 判定服务完成。
- `npm install` 在 Node 22.20.0 下可成功，但 `hosted-git-info@10.1.1` 声明 `^22.22.2 || ^24.15.0 || >=26`，与 OpenClaw 根包的 `>=22.19.0` 存在传递 engine 漂移。发布前需决定提升服务 Node floor 或固定兼容传递版本，并在容器/CI 中验证。
