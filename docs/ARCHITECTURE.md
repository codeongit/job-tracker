# 架构与维护边界

## 运行方式

纯静态 HTML/CSS/ES modules，`dist/` 是直接维护的公开源码，也是唯一发布目录，没有构建阶段。无第三方运行依赖；Prettier 和 Playwright 仅用于开发检查。Node 24 LTS 用于本机服务和测试，pnpm 精确版本及依赖由 `package.json`、`pnpm-lock.yaml` 固定。

## 模块职责

| 模块                                 | 职责                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| `dist/app.js`                        | 页面状态、表单保存、导航、同步生命周期与跨标签通知         |
| `dist/views.js`、`settings-view.js`  | 岗位列表详情、今日行动、看板、设置的 HTML 渲染             |
| `dist/ui.js`、`text-input.js`        | HTML 转义、下载、中文组合输入和焦点保护                    |
| `dist/backup-ui.js`                  | 备份预览、两种恢复方式、本机快照列表                       |
| `dist/model.js`                      | 岗位/任务/活动/导入模型、校验、稳定 ID、三方合并、删除标记 |
| `dist/workspace.js`                  | 工作区迁移、备份格式、恢复策略，均为纯函数                 |
| `dist/storage.js`                    | IndexedDB 事务、自动快照、原始状态紧急导出                 |
| `dist/github.js`                     | REST 传输与共用同步流程                                    |
| `dist/local-ssh.js`                  | 浏览器到同源 SSH 桥的适配器                                |
| `dist/limits.js`、`version.js`       | 统一体积限制及应用/工作区/数据/备份版本                    |
| `scripts/ssh-store.mjs`              | 独立 bare Git 缓存和限定文件的提交                         |
| `scripts/local-api.mjs`、`serve.mjs` | 同源会话校验、本机服务和静态文件                           |

新增字段、导入逻辑、任务状态等业务规则放入模型或专门纯函数模块；页面不直接操作 Git。渲染不能替换正在组合输入的控件。跨标签保存后使用 BroadcastChannel 通知，更新时保留另一页的草稿；实际保存使用数据库中最新状态。

## 数据流

用户保存 → IndexedDB 事务 → 待同步状态 → 手动同步读取远端 → 按 base/local/remote 合并 → 无冲突时写入 → 确认实际上传快照。

`base` 是最后确认过的云端数据，不是备份。上传期间的新编辑仍待同步。同记录两端同时变化由用户选择；父岗位删除与新增子记录也作为冲突保留。删除使用 `deletedAt`，不能直接移除删除标记，否则其他设备可能复活记录。

## 公开和私有内容

公开仓库只含界面代码、说明和合成测试。IndexedDB、下载备份、`.local/config.json`、`.local/ssh-cache.git` 均为私有。禁止把真实记录、源 Markdown、简历或令牌放入 `dist/` 或测试 fixture。PAT 只在页面内存，SSH key 由系统 Git/SSH 使用。

本机 SSH 固定目标、独立缓存、普通 push，只修改指定 JSON；不操作 Obsidian 工作树。网页手机访问使用 REST，不能调用本机 SSH key。

## 大小与外部接口

同步上限统一为最终 JSON 文件的 5,000,000 个 UTF-8 字节，上传前在客户端和 SSH 服务端校验。HTTP 外层请求额度允许少量封装开销；下载完整备份独立于同步限额。导入原文会计入文件体积，设置页显示当前体积。暂不自动清理原文或删除标记。

REST 小文件使用 Contents Base64；大文件使用元数据给出的 blob SHA 读取 raw，避免分支变化导致内容和 SHA 不一致。SSH 输出先拼接字节再做严格 UTF-8 解码。

官方接口依据：[Contents](https://docs.github.com/en/rest/repos/contents#get-repository-content)、[Git blobs](https://docs.github.com/en/rest/git/blobs#get-a-blob)。外部 API 有变化时先更新合成测试，再改适配器。
