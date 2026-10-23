---
name: grill-with-docs
description: 通过分轮追问澄清计划或设计，并在讨论过程中维护已确认的领域术语、业务规则和关键决定。
---

# 方案追问与文档整理

开始提问前，读取并应用 [grilling](../grilling/SKILL.md) 和 [domain-modeling](../domain-modeling/SKILL.md)。

- 由 `grilling` 组织本次目标范围内的分轮讨论，围绕会影响方案的决定与假设推进。
- 由 `domain-modeling` 检验概念和业务边界，并确定结论的文档落点。

每轮按任务授权记录已确认结论，具体维护规则遵循 `domain-modeling`。`grilling` 的实施前确认要求不延迟已获授权的文档维护；方案实施遵循用户的明确授权，已确认事项无需重复确认。

实际修改仓库文档的收尾遵循[文档交付规则](../../../docs/agents/change-workflow.md#文档影响与维护)，复用已完成的检查与审查；仅讨论时保留结论与未决状态。

结束时按[阶段交接规则](../../../docs/agents/change-workflow.md#阶段交接与可实施条件)汇总已确认结论及来源、范围和保留约束、实际文档变更与未决问题；仅分析的任务给出建议落点。需要整体规格时交给 [to-spec](../to-spec/SKILL.md)，需要拆分工作时使用 [to-tickets](../to-tickets/SKILL.md)，明确的小任务可在已有授权内直接进入 [implement](../implement/SKILL.md)。
