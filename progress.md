# OpenClaw Channel Gateway 进度

## 2026-07-10

- 恢复 OMX SessionStart 状态；未发现已有实现或既有计划。
- 用户明确目标：把多 Channel 通讯部分抽成可单独执行的服务。
- 已建立持久化计划、发现记录和进度记录。
- 已克隆上游并固定分析基线 `eefe2e88`。
- 已确认上游将 Plugin SDK 作为插件进入核心的公开边界，将消息插件定位为 transport-only。
- 已并行启动三条只读调研：核心调用链、Channel 扩展盘点、许可证/部署可行性。
- 已定位注册入口 `registerChannel`、生命周期入口 `gateway.startAccount` 和最终出站入口 `sendText/sendMedia`。
- 已确认 SDK/loader 的控制面与运行面已有分层，但 runtime helper 依赖面很大。
- 已盘点主要 Channel 及 webhook/WebSocket/本地客户端等不同 transport 类型。
- 已确认出站契约比入站链路更适合直接复用；入站当前明显耦合 OpenClaw agent/session/routing kernel。
- 已验证 Telegram/WhatsApp 通过模块级 runtime store + `gateway.startAccount` 启动，不能仅复制接口类型运行。
- 已纠正一个重要假设：`inbound_claim` 当前只覆盖 plugin-owned binding，不是普通消息的全局截流点；全局 `before_dispatch` 才是当前可用的 handled 短路面。
- 已确认统一出站 send pipeline 和现成 `message send` 表面存在。
- 已证明 `before_dispatch` 返回 handled 会终止模型路径，但字段不足以承载完整媒体/线程事件。
- 已确认插件路由原生支持 REST 与 WebSocket upgrade，且可复用统一 outbound runtime。
- 已确认 MIT 允许抽取/修改/分发，并记录 notices 与第三方依赖义务。
- 已确认官方包的设计前提就是依赖 OpenClaw Host，进一步支持“瘦 Host + Bridge”而非逐插件复制。
- 已收到 Channel 盘点结果：28 个用户可见通信面，且发现 Teams/ClickClack 等文档与实际发行清单漂移。
- 已找到 `allowUnconfigured` 启动选项，正在核实精确启动语义。
- 已确认显式 `gateway.mode=local` + skipBootstrap 足以建立无模型凭据启动基线，并需持久化 Gateway token。
- 已合并许可证/部署审计：推荐独立 Gateway 进程 + 官方插件，正式分发需 SBOM 与多许可证审查。
- 已完成核心调用链审计：确认两阶段插件启动、Channel manager 监督、turn kernel 以及统一 `send` RPC。
- 下一步：给用户提交 3 个方案和推荐设计，取得实现边界确认。
- 一次只读搜索因包含不存在的可选文件路径失败；已记录并改为目录级搜索，不影响源码或结论。
- 第二次出现同类猜测路径错误；已升级规则为“先发现真实路径、后读取”，不再把猜测文件名放入聚合命令。
- 一次大型多 hunk 文档 patch 出现 context 误报；已验证原文存在并拆成小 patch 成功应用。

## 2026-07-11

- 恢复当前目录实现，确认已提交部分覆盖规范化、持久化 outbox、路由、回环防护与回复关联；未提交部分是 OpenClaw 插件接线和独立启动器。
- 发现迁回当前目录时遗漏 `src/launcher/run.js` 与 `bin/channel-gateway.js`；先以现有 `launcher-run` 测试复现 `ERR_MODULE_NOT_FOUND`，再补回最小编排与 CLI 入口。
- `npm ci` 暴露 lockfile 不同步；用 `npm install` 按现有依赖补全锁文件并安装 OpenClaw 2026.6.11 及 Discord/Feishu/Slack/WhatsApp 官方包。
- 定向 `launcher-run` + `plugin-registration` 测试现为 6/6 通过。
- 完成真实进程 smoke test：隔离数据目录下 `npm start` 启动 OpenClaw Gateway，加载 13 个插件（含 channel-gateway、Discord、Feishu、Slack、WhatsApp），`/health` 返回 200，SIGINT 可干净退出。
- 同一 smoke test 证明 `/api/v1` 仍返回 `503 API_NOT_READY`，因此统一外部 API 尚未完成，目标不能判定完成。
- 两条独立审计均确认上述 503 是当前 Critical；同时发现群聊 mention gate、remote media staging、既有配置校验、marker 目标域、数据库 retention、worker 吞吐/健康等真实运行缺口。
- 已以回归测试修复 marker 跨 channel/account/conversation 误吞：只有 marker 对应 delivery 的真实目标会被 suppress。
- 已以回归测试修复凭据目录与 token symlink 跟随漏洞；隔离目录拒绝 symlink，token 使用 `O_NOFOLLOW`/regular-file/owner 检查后再读取和 chmod。
- 已按上游兼容契约修复外部 QQ/第三方插件发现：官方包仍与 Host 精确同版本，显式外部插件改用 `openclaw.install.minHostVersion` / `openclaw.compat.pluginApi` floor，不再要求 package 自身版本等于 Host。
- 已把 delivery worker 从每 tick 仅处理 1 条改为有界顺序 drain（默认最多 100 条），并增加 backlog 回归测试。
- 已把 worker 启动从插件 register 阶段延后到 `gateway_start`，避免 HTTP/channel readiness 前抢跑恢复任务。
- 已允许重复 SIGINT/SIGTERM 继续转发给子进程，避免 OpenClaw 卡住时 wrapper 吞掉升级终止信号。
- 后续按已批准 Task 6 契约恢复为“首个终止信号只转发一次”；TTY process-group 会自行把 Ctrl-C 送到相关进程，wrapper 重复转发反而产生多次 SIGINT。
- REST/SSE/API slice 已完成并通过 spec + quality 两阶段审查；真实 Gateway smoke 现证明：未认证 `/api/v1/*` 返回 401，认证 `/api/v1/health` 返回 200，`/api/v1/channels` 返回真实 channel status，非法 send 返回受控 400 而非 `API_NOT_READY`。
- Gateway RPC 所有调用使用 `expectFinal:true` + 30 秒 SDK/本地双重 deadline；dispatch 抛错与超时均转为不泄密、可重试的受控错误。
- Launcher existing config 现在以 OpenClaw 公共 JSON5 loader 校验：隔离 database/workspace、skipBootstrap、关闭 Control UI/reload、bridge load/entry/hook、已发现 channel、WhatsApp rich hook、有效 operator port；显式 env port 才覆盖 operator port。
- 首次配置竞争失败者会重新读取并校验 winner，不能通过 race 绕过 channel 或隔离不变量。Launcher 最终复审 APPROVE，28/28 定向测试及 check 通过。
- EventStore retention 现先清理已 ACK/failed 事件下过期的 sent/failed delivery relation，再删除 tombstone；runtime 每 60 秒执行并在 shutdown 清理 timer，避免正常 ACK 流量永久增长。
- Launcher 最终以 `4d2338d` 提交；28/28 launcher 定向测试和静态检查通过，现有配置竞争失败者会重新校验 winner，凭据路径/token symlink 防护与外部插件兼容性契约均已审查通过。
- Retention 以 `876c151` 提交；补齐 ACK/failed 两条 terminal relation 清理路径、临时 prune 失败后的健康恢复，复审无剩余 Critical/Important，36/36 定向测试通过。
- Rich `before_dispatch` Host patch 以 `a3e477c` 提交；真实 `openclaw@2026.6.11` apply/verify、148/148 全量测试、静态检查及归档 tag source audit apply check 均通过；launcher 在任何 data/config/token/spawn 副作用前 fail-closed 验证 marker/hash/postcondition。
- Task 8（许可证/SBOM、Docker/Compose、README、真实 restart smoke）已交由独立 executor 按 TDD 实施；四端 fake integration 保留为后续独立任务。
- Task 8 以 `fe05669` 提交，后续 `c5397c6` 对齐 Node 22.22.2 决策并锁定 common Channel `configured=false/running=false` 回归；真实 restart smoke、许可证、validated CycloneDX SBOM、base/common clean install、Compose 均通过。
- Docker Desktop 本机后端启动崩溃后改用隔离 Colima builder；通过镜像代理取得固定 Node base image，真实 base Docker build 成功，构建内 `npm ci`、Host patch apply/verify 均通过；随后运行容器验证 `/healthz` 与认证 `/api/v1/health` 均返回 200。
- Task 8 最终规格复审 APPROVE；当前等待独立 code quality review，之后进入四端 fake integration 和最终完成审计。
- Task 8 code-quality review 曾发现 license report fail-open、Node engine 声明漂移、QQ root install 和 Docker 应用树可写等 Important，均以 `f133ccf` 修复并复审 APPROVE；真实 base image 以 Colima 构建，容器以 read-only rootfs、root-owned `/app` 和 node-owned `/data` 启动，`/healthz` 与认证 Bridge health 均为 200。
- 四端 fake integration 以 `0c79eec`、`952e702`、`72fe4ce` 提交并两阶段审查 APPROVE：独立 child Node process 使用同一 SQLite、真实 worker timer 恢复 QQ→Feishu/WhatsApp/Telegram pending fan-out；provider receipt/marker echo 均被抑制，Feishu reply 反向映射 QQ/WA/TG reply relation，sent job 再重启不重发。
- README 补充从零配置 walkthrough 后经审查修正群 sender admission、conversation ID cold-start、gateway port 与 pending recovery 验证，最终 `5be9ea7` 复审 APPROVE。
