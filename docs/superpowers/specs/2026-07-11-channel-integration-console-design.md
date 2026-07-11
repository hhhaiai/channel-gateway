# 全 Channel 网页集成控制台设计

## 目标

把现有静态 Channel 链接列表升级为逐 Channel 操作卡片：每张卡片显示官方文档、接入方式、运行状态、生命周期操作，以及将该 Channel 预填进互通房间的入口。

## 安全边界

- 控制台不接收、不存储、也不回显 provider token、AppSecret、QR/session 或 OAuth credential。
- 每个平台的 credential/onboarding 继续遵循 OpenClaw 官方页面与 CLI；网页只给出准确入口和可复制的通用命令。
- 已有 Gateway Bearer token 仅在页面内存中调用 `/api/v1/channels` 与 start/stop/logout。

## 交互

1. 页面用内置官方目录渲染所有 core、官方 plugin、external plugin 和 Voice Call 卡片。
2. 连接后用 `/api/v1/channels?probe=true` 刷新状态；未知 DTO 保留原始状态摘要，不伪造“已连接”。
3. 普通 Channel 卡片可执行 start/stop/logout；外置/未安装 Channel 的错误直接显示受控 API error code。
4. “添加到互通房间”新增一个 endpoint，并预填 `channel`；用户仍需填写该平台官方定义的 `conversationId` 与 `to`。
5. Voice Call 显示为官方插件资料卡，不提供 generic links endpoint 操作，因为它不声明 Channel manifest contract。
