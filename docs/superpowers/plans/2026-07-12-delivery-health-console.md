# 投递健康后台看板实施计划

## 范围

新增一个只读、脱敏 API，把账号/渠道健康投影和账号 limiter snapshot 提供给现有 Channel Gateway 控制台；控制台展示状态、积压、下一次重试和 cooldown。本块不允许从网页修改健康状态或 limiter。

## 接口

`GET /api/v1/delivery/status`

返回：

- `channels`：渠道聚合状态与积压。
- `accounts`：账号状态、错误码、异常时间、积压和下一次重试。
- `rateLimits`：已活动账号的 token、速率、burst、cooldown 和 available。

继续沿用 Gateway Token 鉴权。响应设置 `cache-control: no-store`，不得包含 provider error message、消息正文和凭证。

## 页面

- 独立“投递健康”卡片。
- 渠道摘要卡片和账号表格。
- 状态使用文字和 CSS class，不只依赖颜色。
- 无异常/无活动账号时显示明确空状态。
- 每次“连接并刷新”与渠道/配置并行读取。

## 验证

1. API contract test 先失败。
2. 静态资产测试锁定页面节点与 fetch/render 入口。
3. focused API/console/runtime tests。
4. `npm run check`、完整 `npm test`、`git diff --check`。
5. 独立 Lore commit。
