# D058：用户主动发起版本发布与关键变更摘要

- **记录日期 / 状态：** 2026-10-30 / 已确认；流程验证随本次 PR 记录，实际版本发布另行发起。
- **来源：** 用户指出 CHANGELOG 与 PR 重复、版本日期不直观，提出“CHANGELOG 可以改成人工主动打标签发布的流程。总结关键变更记录是不是更好”。了解行业惯例后，确认“日常 PR → 用户发起发布 → 汇总关键变化并准备版本 PR → 审阅合并 → 对应提交打 tag”，调用 `ask-matt` 回复“可以”授权调整约定。
- **问题与决定：** 日常 PR 承接每次变更与验证；用户决定发布时机和范围，代理整理版本 PR，统一更新应用双版本和 CHANGELOG。获准合并并核对实际提交后标记版本 tag，GitHub Release 复用同一摘要。当前操作集中在[维护手册](../MAINTENANCE.md#发布)。
- **原因与取舍：** 借鉴 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 的人工整理、分类和按版本阅读原则。本项目选择发布时汇总，日常依赖 PR 保留来源，承担发版时的筛选工作；持续维护 Unreleased 也是可行方案。GitHub 的[自动发布说明](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)可提供草稿，不能代替关键变化和风险的判断。
- **保留条件：** 应用版本与数据、协议及备份格式版本按 [D007](0007-versioned-data-migrations.md) 分开。历史条目与验收限制保留，首次范围以实际 tag／已确认 commit 核对；发布摘要不扩展验收结论。PR 的独立审查、人工验收与另行合并授权继续有效，网页部署、服务操作、平台访问及个人数据发布保留各自边界。
- **替代关系：** 细化 [D010](0010-ci-separate-deployment.md) 的版本标签发布安排，调整 R026 的应用版本和 CHANGELOG 维护时机；D010 的 CI、部署分离与纯文档不升应用版本约束保持。
- **重新评估条件：** 发布频率显著增加、PR 信息不足以形成可靠摘要，或需要多版本维护和自动发布时，再评估持续 Unreleased 或发布自动化。
