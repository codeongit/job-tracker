# 关键决策索引

历史 D001–D028 已按原编号迁至 [`docs/adr/`](adr/)；每条原有的决定、原因、备选、约束、来源和替代关系均保留。此页继续提供总览与旧链接入口。当前行为和操作步骤分别见 [架构说明](ARCHITECTURE.md)、[数据与恢复](DATA_AND_RECOVERY.md)、[维护手册](MAINTENANCE.md)。版本改动见 [CHANGELOG](../CHANGELOG.md)。

首次整理日期：2026-09-11。迁移日期：2026-09-24。日期不代表各决策首次讨论时间；来源与历史理由以对应 ADR 原文为准。

## 如何维护

- 改动前先读相关 ADR；使用范围、公开与私有边界、持久化、同步、恢复或技术栈变化时，在同一提交中更新相关文档。
- 新决定使用下一个稳定编号，在 `docs/adr/` 新建同编号文件，并在本索引增加条目与旧标题入口。改变旧决定时新增 ADR、写明来源和替代关系，保留旧 ADR 原文。
- 新的用户明确要求优先于旧决定；日常修复不需要为决策日志另设审批。公开文档不记录真实求职经历、简历或密钥。

## 决策索引

| 编号                                                    | 决策                                       | 状态                                | 来源                                   |
| ------------------------------------------------------- | ------------------------------------------ | ----------------------------------- | -------------------------------------- |
| [D001](adr/0001-personal-web-app.md)                    | 面向个人使用的独立网页                     | 有效                                | 用户确认                               |
| [D002](adr/0002-public-code-private-data.md)            | 公开界面代码，私有 GitHub 仓库存放求职数据 | 有效                                | 用户确认；文件组织为实现选择           |
| [D003](adr/0003-local-first-manual-sync.md)             | 本机先保存，手动触发同步                   | 有效；本机存储由 D026 调整          | 实现选择                               |
| [D004](adr/0004-local-ssh-session-token.md)             | 本机复用 SSH，公开网页使用会话令牌         | 有效                                | 用户提出 SSH 偏好；连接边界为实现选择  |
| [D005](adr/0005-three-way-merge-conflicts.md)           | 三方合并、显式冲突与删除标记               | 有效；自动导入阻塞范围由 D026 调整  | 实现选择                               |
| [D006](adr/0006-snapshots-backups-restore.md)           | 自动快照与独立备份，两种恢复语义           | 有效                                | 用户同意维护基础版；细节为实现选择     |
| [D007](adr/0007-versioned-data-migrations.md)           | 区分数据与应用版本，升级失败保留原状态     | 有效                                | 用户同意维护基础版；细节为实现选择     |
| [D008](adr/0008-lightweight-static-architecture.md)     | 保留轻量静态架构与可复现的检查流程         | 有效（测试分工由 D017 调整）        | 实现选择                               |
| [D009](adr/0009-reviewed-markdown-import.md)            | 导入先核对，不推断缺失信息、不覆盖已有记录 | 有效                                | 用户确认历史年份；规则为实现选择       |
| [D010](adr/0010-ci-separate-deployment.md)              | 代码推送运行 CI，网页部署单独安排          | 有效                                | 已确认维护范围与当前发布状态           |
| [D011](adr/0011-independent-drafts.md)                  | 未提交输入保存为独立草稿                   | 有效                                | 用户同意；细节为实现选择               |
| [D012](adr/0012-local-disk-backups.md)                  | 自动把完整状态保存到本机私有磁盘           | 有效；D026 增加正式提交历史         | 用户同意；扩展 D006                    |
| [D013](adr/0013-actionable-today-view.md)               | 今日页必须把提示变成可完成的行动           | 有效（展示由 D016 调整）            | 用户指出筛选与选择问题；细节为实现选择 |
| [D014](adr/0014-editable-next-action-suggestions.md)    | 下一步表单提供可编辑的状态建议             | 有效                                | 用户要求行动和计划日期默认选项         |
| [D015](adr/0015-date-based-daily-record.md)             | 每日记录按业务日期查询，不还原历史快照     | 已替代（日期语义保留于 D016）       | 用户确认综合日记录及日期含义           |
| [D016](adr/0016-two-entries-unified-detail.md)          | 两个业务入口与统一岗位详情保留浏览上下文   | 有效（看板安排由 D018 调整）        | 用户确认导航、日期筛选与详情整理方案   |
| [D017](adr/0017-manual-browser-testing.md)              | 真实浏览器相关测试由人工负责               | 有效                                | 用户明确要求                           |
| [D018](adr/0018-simplified-status-paginated-jobs.md)    | 精简消息与招聘状态，岗位只保留分页列表     | 有效                                | 用户确认状态归并和删除看板             |
| [D019](adr/0019-boss-resume-status-link.md)             | BOSS 简历发送联动消息和招聘阶段            | 有效                                | 用户提出 BOSS 跟进规则                 |
| [D020](adr/0020-same-company-hint.md)                   | 新增岗位时非阻断提示同公司记录             | 有效                                | 用户确认匹配和提示方式                 |
| [D021](adr/0021-newest-jobs-first.md)                   | 全部日期下岗位按添加时间倒序               | 有效                                | 用户指出新增岗位未排在最前             |
| [D022](adr/0022-read-only-recruitment-automation.md)    | 招聘自动化只读、低频串行与故障现场保留     | 有效；运行方式由 D026 调整          | 用户明确要求；由 D023 落实首版接入     |
| [D023](adr/0023-boss-private-queue-integration.md)      | BOSS 私有队列接入与 2026-09-18 首批规则    | 首批规则有效；运行/存储由 D026 替代 | 用户确认完整实施计划并要求执行         |
| [D024](adr/0024-boss-date-label-import.md)              | BOSS 日期标签的用户确认补录规则            | 日期规则有效；预算由 D026 调整      | 用户指定“昨天”为 2026-09-20 并要求导入 |
| [D025](adr/0025-controlled-conversation-detail-read.md) | 允许受控读取会话详情并设计简历状态采集     | 有效；精确状态已完成首批验收        | 用户取消禁止切换聊天并要求分析         |
| [D026](adr/0026-local-authoritative-workspace.md)       | 本机权威工作区与显式持续跟踪               | 已实现；真实迁移待人工验收          | 用户确认关页录入、两种模式与手动启动   |
| [D027](adr/0027-collector-source-colocation.md)         | 采集器源码与工作台同仓、私有状态分离       | 有效                                | 用户要求继续迁移并减少外部目录依赖     |
| [D028](adr/0028-change-driven-history.md)               | 历史采集默认变化驱动、手动保留公平回填     | 已实现；真实浏览器待验收            | 用户确认新旧模式并要求实施             |

## D001：面向个人使用的独立网页

完整记录见 [ADR-0001](adr/0001-personal-web-app.md)。

## D002：公开界面代码，私有 GitHub 仓库存放求职数据

完整记录见 [ADR-0002](adr/0002-public-code-private-data.md)。

## D003：本机先保存，手动触发同步

完整记录见 [ADR-0003](adr/0003-local-first-manual-sync.md)。

## D004：本机复用 SSH，公开网页使用会话令牌

完整记录见 [ADR-0004](adr/0004-local-ssh-session-token.md)。

## D005：三方合并、显式冲突与删除标记

完整记录见 [ADR-0005](adr/0005-three-way-merge-conflicts.md)。

## D006：自动快照与独立备份，两种恢复语义

完整记录见 [ADR-0006](adr/0006-snapshots-backups-restore.md)。

## D007：区分数据与应用版本，升级失败保留原状态

完整记录见 [ADR-0007](adr/0007-versioned-data-migrations.md)。

## D008：保留轻量静态架构与可复现的检查流程

完整记录见 [ADR-0008](adr/0008-lightweight-static-architecture.md)。

## D009：导入先核对，不推断缺失信息、不覆盖已有记录

完整记录见 [ADR-0009](adr/0009-reviewed-markdown-import.md)。

## D010：代码推送运行 CI，网页部署单独安排

完整记录见 [ADR-0010](adr/0010-ci-separate-deployment.md)。

## D011：未提交输入保存为独立草稿

完整记录见 [ADR-0011](adr/0011-independent-drafts.md)。

## D012：自动把完整状态保存到本机私有磁盘

完整记录见 [ADR-0012](adr/0012-local-disk-backups.md)。

## D013：今日页必须把提示变成可完成的行动

完整记录见 [ADR-0013](adr/0013-actionable-today-view.md)。

## D014：下一步表单提供可编辑的状态建议

完整记录见 [ADR-0014](adr/0014-editable-next-action-suggestions.md)。

## D015：每日记录按业务日期查询，不还原历史快照

完整记录见 [ADR-0015](adr/0015-date-based-daily-record.md)。

## D016：两个业务入口与统一岗位详情保留浏览上下文

完整记录见 [ADR-0016](adr/0016-two-entries-unified-detail.md)。

## D017：真实浏览器相关测试由人工负责

完整记录见 [ADR-0017](adr/0017-manual-browser-testing.md)。

## D018：精简消息与招聘状态，岗位只保留分页列表

完整记录见 [ADR-0018](adr/0018-simplified-status-paginated-jobs.md)。

## D019：BOSS 简历发送联动消息和招聘阶段

完整记录见 [ADR-0019](adr/0019-boss-resume-status-link.md)。

## D020：新增岗位时非阻断提示同公司记录

完整记录见 [ADR-0020](adr/0020-same-company-hint.md)。

## D021：全部日期下岗位按添加时间倒序

完整记录见 [ADR-0021](adr/0021-newest-jobs-first.md)。

## D022：招聘自动化只读、低频串行与故障现场保留

完整记录见 [ADR-0022](adr/0022-read-only-recruitment-automation.md)。

## D023：BOSS 私有队列接入与 2026-09-18 首批规则

完整记录见 [ADR-0023](adr/0023-boss-private-queue-integration.md)。

## D024：BOSS 日期标签的用户确认补录规则

完整记录见 [ADR-0024](adr/0024-boss-date-label-import.md)。

## D025：允许受控读取会话详情并设计简历状态采集

完整记录见 [ADR-0025](adr/0025-controlled-conversation-detail-read.md)。

## D026：本机权威工作区与显式持续跟踪

完整记录见 [ADR-0026](adr/0026-local-authoritative-workspace.md)。

## D027：采集器源码与工作台同仓、私有状态分离

完整记录见 [ADR-0027](adr/0027-collector-source-colocation.md)。

## D028：历史采集默认变化驱动、手动保留公平回填

完整记录见 [ADR-0028](adr/0028-change-driven-history.md)。

## 新决策模板

```markdown
## D029：一句话说明决定

- **记录日期 / 状态：** YYYY-MM-DD / 待定或有效。
- **来源：** 用户明确要求、实现选择，或所替代的决策编号。
- **问题：** 需要解决什么实际问题？
- **决定：** 采用什么方案，适用范围是什么？
- **原因：** 哪些需求和证据支持这个选择？
- **备选与取舍：** 其他可行方案及其代价；区分实际讨论与事后比较。
- **约束：** 需要保留的边界、兼容性和已接受的限制。
- **重新评估条件：** 什么变化会使这个决定不再合适？
- **替代关系：** 如有，关联旧编号并将旧条目标为已替代。
```
