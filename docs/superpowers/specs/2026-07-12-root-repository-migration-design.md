# Channel Gateway 根仓库迁移设计

## 目标

将当前 `channel-gateway/` 独立仓库提升为 GitHub 仓库根目录的真实源码，同时完整保留其现有提交历史。`upstream-openclaw` 继续作为指向 `https://github.com/openclaw/openclaw.git` 的 Git submodule。

## 最终结构

- 当前 `channel-gateway/` 内的源码、配置和文档移动到仓库根目录。
- `channel-gateway` 当前 `main` 的全部提交成为新 `main` 的主历史。
- 旧父仓库历史通过归档分支和一次无关历史合并保留，避免丢失现有记录。
- `upstream-openclaw/` 保持为 gitlink，并在根目录 `.gitmodules` 中声明 URL。
- 原来的 `channel-gateway/` gitlink 从最终树中删除，不再使用嵌套仓库或普通目录副本。

## 迁移方法

1. 验证父仓库和 `channel-gateway` 工作区均无未提交源码修改。
2. 为迁移前的父、子仓库历史创建本地备份引用或 bundle。
3. 将 `channel-gateway/main` 导入父仓库对象库并作为新主线。
4. 使用保留双方祖先关系但不覆盖源码树的合并提交连接旧父仓库历史。
5. 在新根目录中登记 `upstream-openclaw` submodule，并保持当前锁定 commit。
6. 将当前工作区切换到新主线，移除迁移后的嵌套仓库副本。

## 历史与回滚

- `git log --all` 应能访问原 `channel-gateway` 的全部提交。
- 迁移前父仓库 HEAD 通过归档引用保留。
- 操作前生成的 bundle 可在引用误删时恢复历史。
- 在验证完成前不推送远端。

## 验证标准

- 仓库根目录存在原 `channel-gateway` 的源码，而不是 gitlink。
- `git log` 能找到 `04e594b` 及其祖先提交。
- `git ls-files --stage` 中不再存在 `channel-gateway` gitlink。
- `upstream-openclaw` 仍为 mode `160000`，URL 为 `https://github.com/openclaw/openclaw.git`。
- 项目原有 lint、typecheck 和测试入口在根目录通过。
- 工作区最终无意外的未跟踪嵌套仓库。

## 不包含范围

- 不改写 `channel-gateway` 的已有提交内容。
- 不推送 GitHub；远端发布单独执行并验证。
- 不把 OpenClaw 上游源码复制进主仓库。
