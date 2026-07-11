# Channel Gateway 小型精简计划

**目标：** 在不改变消息路由、持久化、配置写入或 API 契约的前提下，删除明确冗余代码并降低近期控制台/Channel 发现路径的阅读成本。

**范围：** `src/launcher/channel-packages.js`、`src/links-config-service.js`、`ui/channel-gateway.js`，以及对应测试。明确不触碰 SQLite schema、delivery worker、Host patch、认证与 public API payload。

## 行为锁定

- `test/launcher-channel-packages.test.js`：官方/外置插件发现、版本与 manifest 校验。
- `test/links-config-service.test.js`：links revision、Host config mutation 与冲突处理。
- `test/console-assets.test.js`：控制台静态资产、CSP 与官方 Channel 目录。

## Pass 1：明确死代码/冗余表达式

1. 删除控制台字段工厂中无意义的同值条件表达式；保持 input type、value、checked 和 dataset 行为不变。
2. 合并仅用于构造官方 package descriptor 的一次性中间表达式，避免重复/不必要的状态。

## Pass 2：重复消除与命名

1. 将 links 的配置读取/规范化集中到单一私有路径，避免 `read()` 和 mutation callback 分别手写相同读取语义。
2. 不引入依赖、不改变导出名称、不改变错误码或 HTTP 结构。

## 验证与提交

每一个 pass 后运行对应目标测试；最终运行 `npm test`、`npm run check`、`npm run verify:openclaw-patch`。每个通过验证的 pass 单独进行本地 Git 提交；不 push。

## 执行记录

- 完成 Pass 1：删除 `ui/channel-gateway.js` 中同值条件元素构造与未在编辑器中展示的 `threadId:null` 默认值；服务端 `compileLinks()` 继续是该可选字段的唯一 canonical default。
- Pass 2 复核结论：`links-config-service` 的重复读取发生在两个不同信任边界（当前 runtime snapshot 与 mutation draft），不能合并而不模糊并发冲突检查；`channel-packages` 的 path/manifest 校验步骤均有独立安全目的。因此本轮不为减少行数引入抽象或改变边界。
