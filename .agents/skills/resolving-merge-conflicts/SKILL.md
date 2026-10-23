---
name: resolving-merge-conflicts
description: 'Use when you need to resolve an in-progress git merge/rebase conflict.'
---

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages, check the PRs, check original issues/tickets.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always resolve; never `--abort`.

4. Discover the project's **automated checks** and run them, typically typecheck, then tests, then format. Fix anything the merge broke.

5. **完成合并或变基。** 核对差异与暂存范围，只暂存本次合并／变基的冲突解决及必要修复；已有无关改动保留独立，不纳入本次提交。按原任务的提交安排完成合并；变基时继续处理，直到本次变基的所有提交完成。验证和交付回到 [implement](../implement/SKILL.md)，复用已完成的步骤。
