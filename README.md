# Channel Gateway

Channel Gateway 是一个独立运行的多 Channel 消息互通服务。它固定使用
`openclaw@2026.6.11` 作为 connector kernel，通过官方 Channel 插件接入平台，并由本仓库的
Bridge 插件在 `before_dispatch` 阶段拦截入站消息。消息不会进入 Agent/LLM；Bridge 把事件和
fan-out outbox 先提交到 SQLite，再向相关会话投递。

本项目不复制 Telegram、Discord、Feishu、Slack、WhatsApp 等 provider adapter。登录、协议升级、
媒体处理和平台限流仍由固定版本的 OpenClaw/官方插件负责，避免维护一组很快漂移的私有 fork。

## 版本与运行 profile

- `package.json` 强制 **Node.js `>=22.22.2 <23`**。OpenClaw 本身接受 22.19+，但当前锁定树里的
  `hosted-git-info@10.1.1` 声明需要 `^22.22.2`；镜像因此固定为
  `node:22.22.2-bookworm-slim`。
- Host 必须精确为 `openclaw@2026.6.11`。launcher 会同时验证版本和
  `rich-before-dispatch` patch marker，任一不匹配都会拒绝启动。
- `base` profile：OpenClaw core 和内置 Telegram 等能力，不安装根项目的 optional Channel。
- `common` profile：在 base 之上精确安装 `@openclaw/discord`、`@openclaw/feishu`、
  `@openclaw/slack`、`@openclaw/whatsapp` 的 `2026.6.11` 版本。
- QQ、Teams、Matrix、Signal 不在默认镜像中；完成各自许可/sidecar 审查后，以绝对插件路径显式加载。

## 本地启动

```bash
# base
npm ci --omit=dev --omit=optional

# 或 common
npm ci --omit=dev --include=optional

# postinstall 会应用 patch；启动前再显式验证一次
npm run verify:openclaw-patch
export CHANNEL_GATEWAY_DATA_DIR="$PWD/.channel-gateway"
export CHANNEL_GATEWAY_TOKEN="$(openssl rand -hex 32)"
export CHANNEL_GATEWAY_BIND=loopback
npm start
```

首次启动会以私有权限创建：

```text
$CHANNEL_GATEWAY_DATA_DIR/
├── config/openclaw.json
├── state/channel-gateway.sqlite
├── credentials/gateway-token
└── workspace/
```

若没有设置 `CHANNEL_GATEWAY_TOKEN`，launcher 会生成 `0600` token；自动化部署应显式从 secret
manager 注入，不能把 token 写入镜像、Compose 文件或日志。修改生成的 `openclaw.json` 后重启；
launcher 会校验 Bridge、数据库、workspace、Channel load path、Control UI/reload 和端口隔离约束，
不会静默覆盖已有配置。

## 首次从零配置（推荐顺序）

以下顺序把已有章节串成一次可执行的首次部署；示例使用本地 `base` profile。需要 Discord、Feishu、
Slack 或 WhatsApp 时，把第 1 步改为 `common`。所有真实平台接入都需要该平台的真实凭据、网络权限和
平台侧配置；测试 fixture 不能替代 live provider 验收。**凭据、二维码 session、token 和数据目录不得
提交到 Git，也不得烘焙进镜像。**

1. 选择并安装 profile，验证固定 Host patch：

   ```bash
   # 二选一：只需 core/Telegram 用 base；需官方常用插件用 common
   npm ci --omit=dev --omit=optional       # base
   # npm ci --omit=dev --include=optional  # common
   npm run verify:openclaw-patch
   ```

2. 在仓库外或已忽略的位置创建本实例专用数据目录和 operator token；每个不可信租户必须使用不同目录与
   token：

   ```bash
   export CHANNEL_GATEWAY_DATA_DIR="$PWD/.channel-gateway"
   export CHANNEL_GATEWAY_TOKEN="$(openssl rand -hex 32)"
   export CHANNEL_GATEWAY_BIND=loopback
   ```

3. 先只启动一次，让 launcher 创建隔离配置和 SQLite；确认 ready 后立即停止，之后再做 provider
   onboarding。另开终端运行 `curl http://127.0.0.1:18789/healthz`，返回成功后回到启动终端按
   `Ctrl-C`（SIGINT）停止：

   ```bash
   npm start
   ```

4. 服务停止时，导出同一实例的 OpenClaw 环境变量，再按所选平台执行原生 onboarding。`channels add`
   是交互式入口；Feishu/WhatsApp 分别使用下面的 login 命令，其他平台的凭据和事件订阅要求见
   [Channel onboarding 边界](#channel-onboarding-边界)：

   ```bash
   export OPENCLAW_HOME="$CHANNEL_GATEWAY_DATA_DIR"
   export OPENCLAW_CONFIG_PATH="$CHANNEL_GATEWAY_DATA_DIR/config/openclaw.json"
   export OPENCLAW_STATE_DIR="$CHANNEL_GATEWAY_DATA_DIR/state"
   export OPENCLAW_WORKSPACE_DIR="$CHANNEL_GATEWAY_DATA_DIR/workspace"
   export OPENCLAW_OAUTH_DIR="$CHANNEL_GATEWAY_DATA_DIR/credentials"
   export OPENCLAW_GATEWAY_TOKEN="$CHANNEL_GATEWAY_TOKEN"

   ./node_modules/.bin/openclaw channels add
   # 按需执行：
   # ./node_modules/.bin/openclaw channels login --channel feishu
   # ./node_modules/.bin/openclaw channels login --channel whatsapp
   ./node_modules/.bin/openclaw channels status --probe
   ```

5. 从真实 `channels status` 或已收到的事件记录每个 `conversationId`。在
   `config/openclaw.json` 中先为这些精确 id 配置 Channel group allowlist/`groupPolicy` 和
   `groups.<conversationId>.requireMention=false`；Telegram 还要在 BotFather 执行 `/setprivacy` →
   **Disable**。不要先开放所有群，具体意图见[群消息接入策略](#群消息接入策略)。

6. 将[完整 links 示例](#完整-links-示例)中的示例 `conversationId` 和 `to` 全部替换为第 5 步确认的
   实际 id（两者分别核验），只保留要互通的 endpoint；然后重启 `npm start`。

7. 用同一个 token 验收控制面和一条受控发送：先按[REST 与 SSE API](#rest-与-sse-api)定义 `BASE`/
   `cgcurl`，依次请求 `/healthz`、`/api/v1/health`、`/api/v1/channels?probe=true`、
   `/api/v1/links`、`/api/v1/events?limit=100`，再对一个已批准目标 `POST /api/v1/messages`。随后从每个
   已 link 的群发一条受控消息，确认目标端 fan-out、`events` 和 delivery receipt；重启一次后再确认
   pending delivery 会恢复，而不是把 fixture 结果当作上线证明。

失败时按这个顺序排查：`npm run verify:openclaw-patch`（Host/patch）、
`$CHANNEL_GATEWAY_DATA_DIR/config/openclaw.json`（profile、插件路径、group/links）、
`$CHANNEL_GATEWAY_DATA_DIR/credentials/`（平台登录材料权限，不要打印内容）、
`$CHANNEL_GATEWAY_DATA_DIR/state/channel-gateway.sqlite`（磁盘/目录权限）和
`./node_modules/.bin/openclaw channels status --probe`（平台连通性）。若 `/api/v1/health` 为 503，按
`/api/v1/health` 的错误修复磁盘或权限并重启；不要绕过 SQLite durable store。

## Docker / Compose

```bash
# base
export CHANNEL_GATEWAY_TOKEN="$(openssl rand -hex 32)"
docker compose build --build-arg CHANNEL_PROFILE=base
docker compose up -d

# common
CHANNEL_PROFILE=common docker compose build
env CHANNEL_PROFILE=common CHANNEL_GATEWAY_TOKEN="$CHANNEL_GATEWAY_TOKEN" docker compose up -d
```

Compose 使用 `/data`、`CHANNEL_GATEWAY_BIND=lan`、四个持久 named volumes，并映射宿主
`18789`。容器以非 root `node` 用户运行，root filesystem 为 read-only；仅 `/data` 父挂载和 `/tmp`
使用受限 tmpfs，四个数据子目录由 named volumes 持久化。健康检查调用无需认证的 OpenClaw `/healthz`；Bridge/SQLite
readiness 必须另行用带 Bearer token 的 `/api/v1/health` 检查。对公网暴露时必须在前方配置 TLS
反向代理和网络 ACL。

## Channel onboarding 边界

先停止服务，再让 OpenClaw 原生命令写入同一隔离配置；不要在本项目重写登录流程：

```bash
export OPENCLAW_HOME="$CHANNEL_GATEWAY_DATA_DIR"
export OPENCLAW_CONFIG_PATH="$CHANNEL_GATEWAY_DATA_DIR/config/openclaw.json"
export OPENCLAW_STATE_DIR="$CHANNEL_GATEWAY_DATA_DIR/state"
export OPENCLAW_WORKSPACE_DIR="$CHANNEL_GATEWAY_DATA_DIR/workspace"
export OPENCLAW_OAUTH_DIR="$CHANNEL_GATEWAY_DATA_DIR/credentials"
export OPENCLAW_GATEWAY_TOKEN="$CHANNEL_GATEWAY_TOKEN"

./node_modules/.bin/openclaw channels add
./node_modules/.bin/openclaw channels status --probe
```

平台边界如下：

- **Telegram**：core 自带；在原生配置/环境中设置 BotFather token，不使用
  `channels login telegram`。若要接收群内普通消息，在 BotFather 执行 `/setprivacy` 并选择
  **Disable**。
- **Discord**：common profile 安装插件；用原生 `channels add` 配置 bot token、guild/channel
  allowlist 和 intents。
- **Feishu**：common profile；使用 `openclaw channels login --channel feishu`，并在开放平台配置
  app credential、事件订阅和权限。
- **Slack**：common profile；通过原生 `channels add` 配置 app/bot token、socket/events 和 scopes。
- **WhatsApp**：common profile；执行
  `openclaw channels login --channel whatsapp` 完成 QR/session，必要时使用独立 account id。
- **Teams**：按 OpenClaw 原生 Microsoft Teams 指南创建 Azure Bot/app；插件安装目录必须通过
  `CHANNEL_GATEWAY_PLUGIN_PATHS=/absolute/path/to/plugin` 显式传入。
- **Matrix**：使用原生 `openclaw channels add` 设置 homeserver、user/access token；外置插件同样
  通过绝对 `CHANNEL_GATEWAY_PLUGIN_PATHS` 加载。
- **Signal**：先安装并注册 `signal-cli` sidecar，再运行原生 `openclaw channels add`；将外置插件
  目录作为绝对路径加载。sidecar 的持久目录需单独备份。

多个显式插件路径使用操作系统的 `path.delimiter`（Linux/macOS 为 `:`）。launcher 检查
`openclaw.install.minHostVersion`、`openclaw.compat.pluginApi`、manifest Channel id 和路径冲突。

### QQ 显式安装

QQ 不随 base/common 镜像发布：当前 QQ connector 的依赖许可需要人工确认，并且常依赖额外 sidecar。
确认后安装到服务树之外的固定绝对目录。特权步骤只负责创建目录并把它交给专用、非登录的
`channel-gateway` 服务用户：

```bash
sudo install -d -m 0750 -o channel-gateway -g channel-gateway /opt/channel-plugins/qq
```

以下命令必须在已经切换到 `channel-gateway` 的非特权 shell/部署 runner 中执行，不能以 root 或
`sudo npm install` 执行。先只生成 lock（禁止 lifecycle scripts），审查 package-lock、license report
和来源后，才用 `npm ci` 安装锁定内容：

```bash
cd /opt/channel-plugins/qq
npm init -y
npm pkg set private=true --json
npm pkg set 'dependencies.@openclaw/qqbot=2026.6.11'
npm install --package-lock-only --ignore-scripts
# 在批准 package-lock.json、resolved/integrity 和 license 证据后：
npm ci --omit=dev
export CHANNEL_GATEWAY_PLUGIN_PATHS=/opt/channel-plugins/qq/node_modules/@openclaw/qqbot
```

Docker 应创建一个派生镜像完成同样安装，并把该绝对路径写入环境；不要在运行中的只读基础镜像临时
`npm install`。`CHANNEL_GATEWAY_PLUGIN_PATHS` 不接受相对路径。

## 群消息接入策略

Bridge 只能收到通过 OpenClaw Channel access/mention gate 的消息。对需要互通的每个群，配置
`groups.<conversationId>.requireMention=false`，同时使用该 Channel 的 group allowlist / `groupPolicy`
只允许明确批准的 conversation id；不要为了省事开放所有群。例如以下为配置意图（字段所在 Channel
节点以对应 OpenClaw 2026.6.11 schema 为准）：

```json5
{
  channels: {
    telegram: {
      groupPolicy: "allowlist",
      groups: { "-1001234567890": { requireMention: false } }
    },
    feishu: {
      groupPolicy: "allowlist",
      groups: { "oc_feishu_group_42": { requireMention: false } }
    },
    whatsapp: {
      groupPolicy: "allowlist",
      groups: { "120363012345678901@g.us": { requireMention: false } }
    },
    qqbot: {
      groupPolicy: "allowlist",
      groups: { "qq-group-10001": { requireMention: false } }
    }
  }
}
```

Telegram 还必须在 BotFather `/setprivacy` 选择 **Disable**，否则平台根本不会把未 @ 的普通群消息
发送给 bot。私聊也应设置明确的 DM/pairing policy。

## 完整 links 示例

在 `plugins.entries.channel-gateway.config.links` 中配置。`conversationId` 用于匹配真实入站事件，
`to` 是 OpenClaw `send` RPC 的目标；两者有时相同，但必须分别从该 Channel 的真实 status/event
确认。下面把 QQ 群、Feishu 群、WhatsApp 群、WhatsApp 私聊和 Telegram 群连为一个双向 link：

```json5
{
  plugins: {
    entries: {
      "channel-gateway": {
        enabled: true,
        hooks: { allowConversationAccess: true, timeouts: { before_dispatch: 5000 } },
        config: {
          databasePath: "/data/state/channel-gateway.sqlite",
          links: [
            {
              id: "support-global",
              endpoints: [
                { id: "qq-group", channel: "qqbot", accountId: "default",
                  conversationId: "qq-group-10001", to: "qq-group-10001",
                  receive: true, send: true },
                { id: "feishu-group", channel: "feishu", accountId: "default",
                  conversationId: "oc_feishu_group_42", to: "oc_feishu_group_42",
                  receive: true, send: true },
                { id: "wa-group", channel: "whatsapp", accountId: "default",
                  conversationId: "120363012345678901@g.us", to: "120363012345678901@g.us",
                  receive: true, send: true },
                { id: "wa-private", channel: "whatsapp", accountId: "default",
                  conversationId: "8613800138000@s.whatsapp.net", to: "8613800138000@s.whatsapp.net",
                  receive: true, send: true },
                { id: "telegram-group", channel: "telegram", accountId: "default",
                  conversationId: "-1001234567890", to: "-1001234567890",
                  receive: true, send: true }
              ]
            }
          ]
        }
      }
    }
  }
}
```

`receive`/`send` 默认都是 `true`，因此 links 默认 bidirectional；把某 endpoint 的 `receive:false`
或 `send:false` 可形成单向边界。每条入站事件与 fan-out delivery 在同一 SQLite transaction 中创建，
重启后继续投递。不可见 marker、delivery receipt 和 scoped message identity 用于 echo suppression；
Channel 返回 reply receipt 时，跨平台 reply relation 会尽可能保留。媒体批量发送只取得最后一个 receipt
的 Host 路径仍是 at-least-once，不能视为每个媒体子消息都有完整对账。

## REST 与 SSE API

除 `/healthz` 外，所有业务接口都要求同一个 operator/admin Bearer token：

```bash
BASE=http://127.0.0.1:18789

# Bearer header 从 stdin 配置传给 curl，避免 token 出现在 ps/argv。
cgcurl() {
  curl --config - "$@" <<EOF
header = "Authorization: Bearer ${CHANNEL_GATEWAY_TOKEN}"
EOF
}

curl "$BASE/healthz"
cgcurl "$BASE/api/v1/health"
cgcurl "$BASE/api/v1/channels?probe=true"
cgcurl "$BASE/api/v1/links"
cgcurl "$BASE/api/v1/events?limit=100"

cgcurl -X POST -H 'Content-Type: application/json' \
  -d '{"channel":"telegram","accountId":"default","to":"-1001234567890","message":"hello","mediaUrls":[],"idempotencyKey":"operator-20260711-1"}' \
  "$BASE/api/v1/messages"

cgcurl -X POST -H 'Content-Type: application/json' \
  -d '{"accountId":"default"}' "$BASE/api/v1/channels/telegram/start"
cgcurl -X POST -H 'Content-Type: application/json' \
  -d '{"accountId":"default"}' "$BASE/api/v1/channels/telegram/stop"
cgcurl -X POST -H 'Content-Type: application/json' \
  -d '{"accountId":"default"}' "$BASE/api/v1/channels/telegram/logout"

cgcurl -X POST -H 'Content-Type: application/json' -d '{}' \
  "$BASE/api/v1/events/evt_123/ack"

cgcurl -N -H 'Last-Event-ID: evt_122' \
  "$BASE/api/v1/events/stream"
```

SSE 建连时先 replay **所有仍 pending** 的事件，随后推送实时事件和 heartbeat；
`Last-Event-ID` 只是观察水位，不能跳过更早的 pending。消费者完成自己的 durable commit 后才应 ACK。
ACK 幂等，ACK tombstone 在 TTL 内保留用于去重。慢 SSE 消费者超过有界队列会被断开，客户端必须通过
REST/SSE pending replay 恢复。

如果 SQLite commit 失败，Bridge 仍把 `before_dispatch` 标为 handled，阻止消息意外进入 LLM，
同时 `/api/v1/health` 返回 503：这是 fail-closed degraded 状态，需要修复磁盘/权限并重启，而不是
绕过 durable store。Gateway RPC 使用 deadline；超时或未知结果不会伪装成成功。

## 安全、租户与运维

- Bearer token 可调用 send、Channel start/stop/logout，等价于 trusted operator/admin credential。
  只交给受信任控制面，定期轮换；轮换后同时更新 secret manager 和进程环境再滚动重启。
- 不同不可信客户/tenant 必须 **one instance per untrusted tenant**，使用不同 token、端口、数据目录、
  系统用户/容器和网络策略。links 不是多租户授权层。
- 默认本地 bind 是 loopback；Compose 的 `lan` 必须配 TLS proxy、防火墙和来源 ACL。
- 备份 `config/`、`state/`、`credentials/`、`workspace/`；最好停服务后做一致快照。热备份 SQLite 时
  必须使用 SQLite backup API 或同时处理 `channel-gateway.sqlite-wal/-shm`，不能只复制主文件。
- 恢复后检查目录 `0700`、token `0600`，运行 patch verification、`/healthz`、认证 health、channels
  probe 和 restart smoke。

## 升级

Host 和所有 Channel plugin 是一个升级单元，不能只升级其中一个：

1. 在分支中修改所有精确版本和 `OPENCLAW_VERSION`，重新生成 `package-lock.json`。
2. 基于新上游 source/dist 重新生成 `patches/openclaw-v*.patch`，不要把旧 patch 强行套到新 bundle。
3. `npm ci && npm run patch:openclaw && npm run verify:openclaw-patch`。
4. 运行 `npm test`、`npm run check`、license/SBOM、base/common image build 和真实 standalone restart smoke。
5. 使用真实 provider credential 做 channels probe 与受控收发，再滚动生产实例；保留可回滚的数据备份。

## License 与 SBOM

本仓库保存固定上游版本的 `licenses/openclaw/LICENSE` 和
`licenses/openclaw/THIRD_PARTY_NOTICES.md`。生成交付证据：

```bash
npm run licenses          # artifacts/licenses.json，blocker 只报告不使普通命令失败
npm run licenses:strict   # 仅 UNLICENSED/缺 license metadata 使退出码非零
npm run sbom              # validated/reproducible CycloneDX, artifacts/sbom.cdx.json
```

GPL/LGPL/MPL 归为 manual review，不自动当作 blocker；发布前仍需法律/合规人员判断组合与分发义务。
当前官方可选 Channel 包的 package metadata 可能缺少 license 字段，strict 会保守阻断，需结合复制的
OpenClaw notices 和供应方证据人工处置。`artifacts/` 被 Git 忽略，CI 应把结果作为构建 artifact 保存。

`npm run sbom` 固定临时执行 `@cyclonedx/cyclonedx-npm@6.0.0`，从 package-lock 生成、校验并
输出 reproducible CycloneDX；它不是项目 runtime dependency，但首次运行需要访问 npm registry，应在 CI
缓存/代理策略中明确允许该固定版本。原生 `npm sbom` 会因 OpenClaw 2026.6.11 自带
shrinkwrap/bundled tree 的 peer/exact-range 漂移返回 `ESBOMPROBLEMS`，而 `--omit=optional` 会错误得到
零组件；固定工具的 `--ignore-npm-errors` 仅忽略这类 npm tree validation error，不删除 lock 中的组件。
不得手工伪造或编辑 SBOM，发布时仍需保留 upstream drift 与 license manual-review 证据。

## 验证范围声明

自动测试证明固定 Host 能在**没有模型/provider credential**时启动，REST/SSE 鉴权与 durable event
restart/ACK 恢复正常，并能发现已安装的 common Channel surface。真正的 QQ、Feishu、WhatsApp、
Telegram、Discord、Slack、Teams、Matrix、Signal live provider proof 仍需要各平台真实 credentials、
webhook/网络权限或本地 sidecar；fixture/contract 测试不能替代这项上线验证。
