# 本机证据核验（已退役）

按 [D055](../adr/0055-git-pr-records.md)，`pnpm task:evidence` 及其声明、捕获、运行和核验接口已退役。当前版本不再提供该命令，也不把旧快照当作新版本检查通过的依据。

后续任务直接运行适用检查，用 Git commit 固定受检和受审版本，按[证据版本与检查配置](change-workflow.md#证据版本与检查配置)判断旧结果是否适用；公开结论进入 PR，原始日志沿用原位置。

历史 `.local/tasks/` 内容保持原样，不自动删除或迁移。需解释旧快照时，可通过 `git show f1a94a379d4ef5672ce67d10a0e8ad6887350428:docs/agents/task-evidence.md` 读取当时契约；对应脚本与测试也保留在该提交中。历史记录不代表当前验收。
