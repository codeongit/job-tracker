# 关键决策索引

历史 D001–D028 已按原编号迁至 [`docs/adr/`](adr/)；新决定从 D029 起继续编号。每条原有的决定、原因、备选、约束、来源和替代关系均保留。此页继续提供总览与旧链接入口。当前行为和操作步骤分别见 [架构说明](ARCHITECTURE.md)、[数据与恢复](DATA_AND_RECOVERY.md)、[维护手册](MAINTENANCE.md)。版本改动见 [CHANGELOG](../CHANGELOG.md)。

招聘自动化的授权与操作边界统一见 [操作规约](AUTOMATION_POLICY.md)；BOSS 命令、采集链路、额度和阶段恢复统一见 [接入设计](BOSS_AUTOMATION_DESIGN.md)。业务与数据细则引用上述专门文档，ADR 保留各项决定发生时的背景和取舍。

首次整理日期：2026-09-11。迁移日期：2026-09-24。日期不代表各决策首次讨论时间；来源与历史理由以对应 ADR 原文为准。

## 如何维护

- 改动前先读相关 ADR；使用范围、公开与私有边界、持久化、同步、恢复或技术栈变化时，在同一提交中更新相关文档。
- 新决定使用下一个稳定编号，在 `docs/adr/` 新建同编号文件，并在本索引增加条目与旧标题入口。改变旧决定时新增 ADR、写明来源和替代关系，保留旧 ADR 原文。
- 新的用户明确要求优先于旧决定；日常修复不需要为决策日志另设审批。公开文档不记录真实求职经历、简历或密钥。

## 决策索引

| 编号                                                           | 决策                                               | 状态                                             | 来源                                       |
| -------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| [D001](adr/0001-personal-web-app.md)                           | 面向个人使用的独立网页                             | 有效                                             | 用户确认                                   |
| [D002](adr/0002-public-code-private-data.md)                   | 公开界面代码，私有 GitHub 仓库存放求职数据         | 有效                                             | 用户确认；文件组织为实现选择               |
| [D003](adr/0003-local-first-manual-sync.md)                    | 本机先保存，手动触发同步                           | 有效；本机存储由 D026 调整                       | 实现选择                                   |
| [D004](adr/0004-local-ssh-session-token.md)                    | 本机复用 SSH，公开网页使用会话令牌                 | 有效                                             | 用户提出 SSH 偏好；连接边界为实现选择      |
| [D005](adr/0005-three-way-merge-conflicts.md)                  | 三方合并、显式冲突与删除标记                       | 有效；自动导入阻塞范围由 D026 调整               | 实现选择                                   |
| [D006](adr/0006-snapshots-backups-restore.md)                  | 自动快照与独立备份，两种恢复语义                   | 有效                                             | 用户同意维护基础版；细节为实现选择         |
| [D007](adr/0007-versioned-data-migrations.md)                  | 区分数据与应用版本，升级失败保留原状态             | 有效                                             | 用户同意维护基础版；细节为实现选择         |
| [D008](adr/0008-lightweight-static-architecture.md)            | 保留轻量静态架构与可复现的检查流程                 | 有效（测试分工由 D017 调整）                     | 实现选择                                   |
| [D009](adr/0009-reviewed-markdown-import.md)                   | 导入先核对，不推断缺失信息、不覆盖已有记录         | 有效                                             | 用户确认历史年份；规则为实现选择           |
| [D010](adr/0010-ci-separate-deployment.md)                     | 代码推送运行 CI，网页部署单独安排                  | 有效                                             | 已确认维护范围与当前发布状态               |
| [D011](adr/0011-independent-drafts.md)                         | 未提交输入保存为独立草稿                           | 有效                                             | 用户同意；细节为实现选择                   |
| [D012](adr/0012-local-disk-backups.md)                         | 自动把完整状态保存到本机私有磁盘                   | 有效；D026 增加正式提交历史                      | 用户同意；扩展 D006                        |
| [D013](adr/0013-actionable-today-view.md)                      | 今日页必须把提示变成可完成的行动                   | 有效（展示由 D016 调整）                         | 用户指出筛选与选择问题；细节为实现选择     |
| [D014](adr/0014-editable-next-action-suggestions.md)           | 下一步表单提供可编辑的状态建议                     | 有效                                             | 用户要求行动和计划日期默认选项             |
| [D015](adr/0015-date-based-daily-record.md)                    | 每日记录按业务日期查询，不还原历史快照             | 已替代（日期语义保留于 D016）                    | 用户确认综合日记录及日期含义               |
| [D016](adr/0016-two-entries-unified-detail.md)                 | 两个业务入口与统一岗位详情保留浏览上下文           | 有效（看板安排由 D018 调整）                     | 用户确认导航、日期筛选与详情整理方案       |
| [D017](adr/0017-manual-browser-testing.md)                     | 真实浏览器相关测试由人工负责                       | 有效                                             | 用户明确要求                               |
| [D018](adr/0018-simplified-status-paginated-jobs.md)           | 精简消息与招聘状态，岗位只保留分页列表             | 有效                                             | 用户确认状态归并和删除看板                 |
| [D019](adr/0019-boss-resume-status-link.md)                    | BOSS 简历发送联动消息和招聘阶段                    | 有效                                             | 用户提出 BOSS 跟进规则                     |
| [D020](adr/0020-same-company-hint.md)                          | 新增岗位时非阻断提示同公司记录                     | 有效                                             | 用户确认匹配和提示方式                     |
| [D021](adr/0021-newest-jobs-first.md)                          | 全部日期下岗位按添加时间倒序                       | 有效                                             | 用户指出新增岗位未排在最前                 |
| [D022](adr/0022-read-only-recruitment-automation.md)           | 招聘自动化只读、低频串行与故障现场保留             | 有效；运行方式由 D026 调整                       | 用户明确要求；由 D023 落实首版接入         |
| [D023](adr/0023-boss-private-queue-integration.md)             | BOSS 私有队列接入与 2026-09-18 首批规则            | 首批规则有效；运行/存储由 D026 替代              | 用户确认完整实施计划并要求执行             |
| [D024](adr/0024-boss-date-label-import.md)                     | BOSS 日期标签的用户确认补录规则                    | 日期规则有效；预算由 D026 调整                   | 用户指定“昨天”为 2026-09-20 并要求导入     |
| [D025](adr/0025-controlled-conversation-detail-read.md)        | 允许受控读取会话详情并设计简历状态采集             | 有效；状态映射由 D030 恢复；归属前提由 D033 收紧 | 用户取消禁止切换聊天并要求分析             |
| [D026](adr/0026-local-authoritative-workspace.md)              | 本机权威工作区与显式持续跟踪                       | 已实现；启动校验范围由 D041 调整                 | 用户确认关页录入、两种模式与手动启动       |
| [D027](adr/0027-collector-source-colocation.md)                | 采集器源码与工作台同仓、私有状态分离               | 有效                                             | 用户要求继续迁移并减少外部目录依赖         |
| [D028](adr/0028-change-driven-history.md)                      | 历史采集默认变化驱动、手动保留公平回填             | 已实现；真实浏览器待验收                         | 用户确认新旧模式并要求实施                 |
| [D029](adr/0029-resume-request-is-not-sent.md)                 | 附件简历请求不等于简历已发送                       | 已由 D030 替代                                   | 曾误读平台文案                             |
| [D030](adr/0030-reject-misattributed-resume-observation.md)    | 恢复附件简历发送映射，否决误归属观察               | 有效；真实浏览器待验收                           | 用户澄清平台文案与目标聊天内容             |
| [D031](adr/0031-explicit-resume-semantics.md)                  | 简历观察、含义和应用条件显式分层                   | 有效；真实浏览器待验收                           | 用户同意通过建模与枚举减少语义误判         |
| [D032](adr/0032-attribution-review-boundaries.md)              | 归属证据不足时停止自动更新，人工状态与证据确认分开 | 设计已确认；由 D033 收敛，未实施                 | 用户确认严格关卡及 Q1–Q9 均选 A            |
| [D033](adr/0033-boss-import-convergence.md)                    | BOSS 导入统一归属判断与处理链路                    | 已实现；归属前提由 D035、存档边界由 D043 调整    | 用户确认整体收敛计划并要求实施             |
| [D034](adr/0034-boss-cross-observation-attribution.md)         | BOSS 跨观察归属防错                                | 已实现；真实浏览器待人工验收                     | 用户确认防错计划并要求实施                 |
| [D035](adr/0035-boss-conversation-association-application.md)  | 允许依据会话关联应用简历观察                       | 已实现；身份排查已收尾；业务验收待确认           | 用户明确取消消息岗位必填并确认历史处理范围 |
| [D036](adr/0036-boss-waiting-observation-ignore.md)            | 处理历史等待项并允许人工忽略观察                   | 已实现；真实界面待人工验收                       | 用户确认处理计划与持续忽略范围             |
| [D037](adr/0037-boss-existing-job-details.md)                  | 复用精确匹配的本机岗位资料与就地核对               | 已实现；资料及展示由 D038 调整                   | 用户要求自动补齐已有资料并改善跳转         |
| [D038](adr/0038-boss-job-details-and-observation-groups.md)    | 详情页补齐岗位、消息汇总与平台状态                 | 已实现；人工目标由 D039、网页入口由 D042 调整    | 用户确认完整实施计划                       |
| [D039](adr/0039-boss-manual-retired-job-resolution.md)         | 人工指定现存岗位处理旧观察                         | 已实施；真实界面待人工验收                       | 用户确认定点补齐及保留删除重复记录         |
| [D040](adr/0040-boss-repeated-work-and-stable-reevaluation.md) | 减少重复计算并稳定同事实重评                       | 已实施；完整启动审计约束由 D041 调整             | 用户同意三个保留安全校验的优化措施         |
| [D041](adr/0041-workspace-startup-catalog.md)                  | 提交索引与旧历史按需校验                           | 已实施；启动已核对，界面待人工验收               | 用户接受旧历史异常发现时机延后并确认实施   |
| [D042](adr/0042-data-sync-guided-resolution.md)                | 数据与同步按任务引导异常处理                       | 已实施代码；真实界面待人工验收                   | 用户确认页面与受限资料、同步冲突流程整理   |
| [D043](adr/0043-boss-observation-only-archive.md)              | 纯简历卡片观察只存档                               | 已实现；真实界面待用户验收                       | 用户明确批准纯存档观察不计待处理           |
| [D044](adr/0044-boss-card-semantics-evidence.md)               | 通用卡片不证明简历发送，消费核对语义依据           | 已实现；人工清单纠错由 D045 补充                 | 用户指出未发送却统计已发送；单会话授权核对 |
| [D045](adr/0045-boss-reviewed-resume-semantics-correction.md)  | 按明确核对清单纠正卡片发送误判                     | 有效；阶段回退由 D046 调整                       | 用户审阅本机清单后明确授权受限纠错         |
| [D046](adr/0046-boss-resume-correction-linked-stage.md)        | 简历误判纠错同时撤回自动联动阶段                   | 已确认；实现与验收见版本记录                     | 用户指出沟通中未随误判纠正回退             |

## D046：简历误判纠错同时撤回自动联动阶段

完整记录见 [ADR-0046](adr/0046-boss-resume-correction-linked-stage.md)。0.10.17 / 规则 v12 将明确清单中仍由自动维护且 last-auto 一致的“沟通中”回退为“已触达”，支持对已人工否决的同一事实补偿遗漏。原否决决定、已读与人工阶段保留；独立真实发送继续保护，恢复旧备份也执行阶段保护。原命令精确重试仍返回旧提交，无变化不追加提交；不新增格式、平台访问或同步。

## D045：按明确核对清单纠正卡片发送误判

完整记录见 [ADR-0045](adr/0045-boss-reviewed-resume-semantics-correction.md)。0.10.16 / 规则 v12 增加受限 `correct_boss_resume_semantics` 命令，按用户已审阅清单原子纠正自动简历已发送状态，并以来源事实为单位保留人工否决。其他发送或接收支持、人工字段、消息状态、招聘阶段、账号与删除保护继续核对；D044 不自动批量回退历史的规则保持，此次为明确清单人工纠错，无格式迁移或新增平台访问。

## D044：通用卡片不证明简历发送

完整记录见 [ADR-0044](adr/0044-boss-card-semantics-evidence.md)。0.10.15 / 规则 v12 停用模板结构单独推断发送，保留精确系统文案含义；新私有快照与批次 v5 携带最小语义依据，旧缺依据材料不自动推进。正式数据格式及稳定身份不变，已应用历史不自动批量回退；[D045](adr/0045-boss-reviewed-resume-semantics-correction.md) 补充用户明确清单的受限人工纠错。

## D043：纯简历卡片观察只存档

完整记录见 [ADR-0043](adr/0043-boss-observation-only-archive.md)。应用 0.10.12、规则 v11 对共享简历规则中 `target === null` 的两类卡片，在归属不足或已验证时记录 `no_effect / observation_only`，正式目标为空，不计待处理，也不确认归属或改变岗位。明确冲突仍 review，缺稳定消息身份仍是采集问题；真实发送接收、人工决定、同步与恢复保护保留。现有纯本机消费重评旧等待项，无新采集或命令，共享数据 v4 及各外层、私有格式不变；完整非浏览器测试与静态、格式检查通过，真实界面待用户验收。

## D042：数据与同步按任务引导异常处理

完整记录见 [ADR-0042](adr/0042-data-sync-guided-resolution.md)。应用 0.10.6 按 BOSS、手动 GitHub 同步、备份与文件组织页面，异常直接说明原因、影响及下一步。普通精确资料确认复用现有服务命令；同步差异逐组核对、全部一次保存、用户明确上传。保留约 30 秒纯本机重评与恢复确认，归属 review 不新增终结流程，规则 v10、数据 v4、工作区 v3、备份 v2 不变。

## D041：提交索引与旧历史按需校验

完整记录见 [ADR-0041](adr/0041-workspace-startup-catalog.md)。正常启动完整校验当前提交和 HEAD 绑定的 catalog，旧历史在访问或显式完整审计时严格校验；首次旧 HEAD v1 完整审计后转换。该决定明确调整 D026/D040 的启动发现范围，保留单写者、原子提交、幂等与恢复事实检查。应用 0.10.3、HEAD v2、catalog v1；完整非浏览器检查、首次转换及普通冷进程启动已核对，转换前后正式 revision 与工作区摘要相同，真实界面待人工验收。

## D040：减少重复计算并稳定同事实重评

完整记录见 [ADR-0040](adr/0040-boss-repeated-work-and-stable-reevaluation.md)。v0.10.2 保留完整历史校验，进程内复用纯身份计算，去除重复账本适配，并按全部独立候选稳定重评同一事实。每次启动完整历史审计及不引入持久索引的约束由 D041 调整；纯计算与同事实重评规则继续有效。规则 v10，数据 v4 不变。

## D039：人工指定现存岗位处理旧观察

完整记录见 [ADR-0039](adr/0039-boss-manual-retired-job-resolution.md)。允许精确补入空岗位 ID，并在明确列出已删除重复记录后指定现存目标；自动导入和删除保护继续有效。

## D038：详情页补齐岗位与消息汇总展示

完整记录见 [ADR-0038](adr/0038-boss-job-details-and-observation-groups.md)。应用 0.10.0 / 数据 v4；详情页资料优先、人工定点处理、消息汇总和独立平台状态。0.10.5 修复详情标题兼容、导航就绪及列表外交付，落实用人公司优先级，不改变本决策的身份、人工及关闭状态边界。D042 为受限普通资料确认增加网页入口，原始观察和简历归属仍独立保留。

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

## D029：附件简历请求不等于简历已发送

完整记录见 [ADR-0029](adr/0029-resume-request-is-not-sent.md)。

## D030：恢复附件简历发送映射，否决误归属观察

完整记录见 [ADR-0030](adr/0030-reject-misattributed-resume-observation.md)。

## D031：简历观察、含义和应用条件显式分层

完整记录见 [ADR-0031](adr/0031-explicit-resume-semantics.md)。

## D032：归属证据不足时停止自动更新，人工状态与证据确认分开

完整记录见 [ADR-0032](adr/0032-attribution-review-boundaries.md)。整体理解已确认；后续由 D033 收敛，D032 完整方案未实施。

## D033：BOSS 导入统一归属判断与处理链路

见 [ADR-0033](adr/0033-boss-import-convergence.md)。严格关卡保留，复杂异常交互延后。

## D034：BOSS 跨观察归属防错

见 [ADR-0034](adr/0034-boss-cross-observation-attribution.md)。补充跨观察检查，保持严格归属前提和历史保护。

## D035：允许依据会话关联应用简历观察

见 [ADR-0035](adr/0035-boss-conversation-association-application.md)。替代 D033 的消息岗位必填前提，保留 D034 拦截及人工保护。

## D036：处理历史等待项并允许人工忽略观察

见 [ADR-0036](adr/0036-boss-waiting-observation-ignore.md)。仅忽略所选等待观察，保留原始材料和归属检查。

## 新决策模板

```markdown
## D037：一句话说明决定

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

## D037：复用精确匹配的本机岗位资料

完整记录见 [ADR-0037](adr/0037-boss-existing-job-details.md)。
