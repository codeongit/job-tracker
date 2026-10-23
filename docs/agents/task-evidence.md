# 本机证据核验

`pnpm task:evidence` 为已有任务记录保存版本与实际命令结果，帮助识别过期证据。适用范围和完成条件见[变更共用规则](change-workflow.md#证据版本与检查配置)；它不管理授权、人工验收或任务评估，不替代 `review:metrics` 的独立审查记录。

## 声明与捕获

先按[任务记录约定](change-workflow.md#任务记录试行)创建或沿用任务 UUID，在 `.local/tasks/<任务编号>/evidence-input.json` 编写声明。先完成格式化等写入操作，再捕获要检查和审查的版本。以下仅示例证据工具的定向检查，实际任务还须声明适用的 `pnpm check`、`pnpm format:check` 等检查：

```json
{
  "schema_version": 1,
  "goal": "检查后修改相关输入时，旧通过结果需补查；无关结果仍可复用。",
  "sources": ["本次用户要求及验收条件的可定位来源"],
  "rules": ["AGENTS.md", "CODING_STANDARDS.md", "docs/agents/change-workflow.md"],
  "review_inputs": ["scripts/task-evidence.mjs", "test/task-evidence.test.mjs", "docs/agents"],
  "checks": [
    {
      "id": "evidence-tests",
      "command": ["node", "--test", "test/task-evidence.test.mjs"],
      "inputs": ["scripts/task-evidence.mjs", "test/task-evidence.test.mjs"]
    }
  ]
}
```

- `goal` 保存本次目标及关键验收条件。`sources` 保存来源引用文字，工具不读取引用内容；原始材料更新后，执行者重新核对并更新目标。需要自动追踪的公开规格文件也列入 `rules`。
- `rules` 保存适用规则及公开目标材料路径；其变化使所有检查需补查。`review_inputs` 是本轮完整审查范围；其版本一致只说明材料未变，不说明已经审查通过。
- 每项 `checks` 都是必需检查，`inputs` 覆盖该命令依赖的源码、测试及配置。路径是 Git 可见的仓库相对文件或目录；目录会记录公开成员及摘要，识别新增、删除和内容变化。相关范围可能增删文件时声明目录。工具不推断依赖，遗漏输入会削弱核验。
- 命令是 argv 数组，以仓库根目录为工作目录执行，不展开 shell 语法。只声明任务已获授权且符合浏览器分工的检查；工具不是命令沙箱。普通检查应只读输入，修改文件的命令可能使本次结果过期。
- 工具同时记录默认检查配置、锁文件、忽略规则、格式配置、CI 工作流、检查器与自身版本；当前名单由[脚本](../../scripts/task-evidence.mjs)维护。捕获前已有的配置修改仍须对照任务起点审查，重新捕获不代表获准降低检查要求。

```sh
pnpm task:evidence capture --task <任务UUID> --input /绝对路径/.local/tasks/<任务UUID>/evidence-input.json
pnpm task:evidence run <任务UUID> <返回的快照UUID> --check evidence-tests
pnpm task:evidence verify <任务UUID> <快照UUID>
```

记录保存在 `.local/tasks/<任务UUID>/evidence/<快照UUID>/`。快照保留声明及文件摘要，命令结果保留时间、退出状态、执行前后版本；命令输出直接显示，不另存原始日志。需要审查的输出另保留必要的公开摘要。检查或进程中断后不得从旧成功记录推定本次通过；确认旧命令已停止，再捕获新快照继续。

## 复核与复用

审查开始和结束、实际交付前运行 `verify`。分别查看检查的 `passed / failed / missing / stale`（通过／失败／未完成／需补查）及 `review_snapshot`；任一必需检查不通过或审查材料过期，命令返回非零。`passed: true` 只表示声明检查均有当前有效的通过记录且审查输入未变，仍须补齐独立审查结论与适用的人工验收说明。

证据以返回的 `snapshot_digest` 定位固定快照；`current_digest` 是本次计算的状态摘要，二者编码对象不同，不能直接比较字符串判断是否过期。过期判断使用输出中的逐项状态。现有 `review:metrics` 报告引用快照目录、摘要及审查范围；审查过程中发现遗漏依赖时，补充声明及受影响验证。

相关输入变化后，新捕获一个快照；需要复用未受影响结果时明确指定旧快照：

```sh
pnpm task:evidence capture --task <任务UUID> --input /绝对路径/.local/tasks/<任务UUID>/evidence-input.json --reuse <旧快照UUID>
```

只有目标、来源文字、规则、检查配置以及该项命令和输入仍一致，且最近一次执行完整通过的检查才会继承，记录保留原快照与运行编号。其余检查重新执行。审查材料变化时由独立审查者核对影响，再对新版本给出结论；工具不自动继承人工或审查结论。

## 保障边界

工具拒绝声明私有路径、路径回退和符号链接，检查已声明公开输入及 Git 可见成员；这些措施防止常见误用，不能识别任意文件中的敏感内容。声明和命令只使用公开资料或合成数据。运行环境记录 Node、平台及架构；未声明的环境变量、外部命令实现、依赖内容和外部服务变化不能由文件摘要完整判断，发生相关变化时主动重跑。

执行前后采样无法发现运行中修改后又恢复的输入，因此同一检查范围保持单一写入者，执行检查时暂停对该范围的编辑。

快照与运行文件仍可被同权限写入者修改；工具不提供防篡改存储、审查身份认证、受保护的合并门禁或需求正确性证明。有效范围由独立审查核对，真实使用效果按[流程回归与迭代](change-workflow.md#流程回归与迭代)持续补证。
