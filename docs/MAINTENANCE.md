# 开发、发布与排障

## 新电脑开发

安装 Node.js 24 LTS、Git 和 package.json 指定版本的 pnpm。使用系统 Node 即可，双击启动脚本的 Codex runtime 路径只是兼容现有机器的后备方案。

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm start
```

需要本机源文件或 SSH 时，将 `config.example.json` 复制到 `.local/config.json`，按实际情况填写；不需要的字段可以删除。配置无效时服务会明确停止启动。使用系统 SSH agent，不要把私钥复制到项目。

macOS 已装 Chrome 时可直接运行 `PLAYWRIGHT_CHANNEL=chrome pnpm test:browser`。首次安装浏览器仅用于测试，不要求日常使用者安装 Playwright。

## 每次改动

```sh
pnpm format
pnpm verify
```

verify 包含模型/同步/真实临时 Git 测试、语法与公开资源检查、格式检查、隔离浏览器回归。浏览器脚本只启动 dist 静态服务器、使用临时 profile，拦截所有外部请求，不读取 `.local`。中文输入通过 Chromium CDP 触发组合事件；涉及输入体验修改时还应人工检查系统输入法候选窗口。

新增功能按模块职责修改，说明数据影响，补能复现具体故障的测试。不要重写测试只匹配实现；也不要将真实数据作为测试输入。

## 发布

1. 下载完整私有备份；确认数据格式是否变化并阅读 DATA_AND_RECOVERY.md。
2. 更新版本号与 CHANGELOG，运行 `pnpm verify`。
3. 检查 Git 差异和暂存文件，确保没有 `.local`、真实记录、备份或凭证。
4. 提交代码，正常 push main，等待此提交的 GitHub Actions CI 成功。
5. 用对应版本的 Git tag 标记验证过的提交。当前仓库只运行 CI，不自动发布网页。
6. 本机服务端代码变更后在原终端 Ctrl+C 停止，再重新启动。刷新网页，检查设置页版本和连接检查。

未来发布公开静态网页只发布 dist。不能把 `.local`、本机服务或私有仓库内容作为构建输入。

GitHub Actions 使用 contents:read，不配置真实仓库 PAT 或 SSH key。依赖更新先更新锁文件、跑同一套检查；不自动合并依赖升级。

## 回退

代码用 Git 提交/tag 保留历史，优先修复或 `git revert` 产生新提交，不强推历史。数据与代码版本分开处理。

v0.2.0 将浏览器数据库升到版本2，因此不能直接用 v0.1.0 操作已经升级的同一浏览器数据库。出现故障先导出完整或原始状态，在独立测试配置验证恢复；不要删除当前网站存储。仍兼容云端 schemaVersion1；修复版应保留对工作区v2的支持。

v0.3.0 不改变工作区v2或共享数据v1，但完整备份升为v2，旧版不识别。回退前先下载包含草稿的v2备份，保留 `.local/backups/`；不要删除浏览器 localStorage。备份测试只操作临时目录，不能把用户目录当 fixture。

## 排障

先运行 `pnpm doctor` 查看 Node、Git 和本机服务版本，再在设置页“检查连接”。连接检查只读取，不提交数据。

| 现象/代码                 | 处理                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| 页面版本与本机服务不同    | 重启本机服务，再刷新页面                                                  |
| 请关闭旧版页面            | 关闭其他工作台标签页，刷新后完成数据库升级                                |
| GIT_NOT_FOUND             | 安装 Git，重新打开终端后再启动                                            |
| SSH_AUTH_FAILED           | 检查系统 SSH agent 和 GitHub SSH keys，可手动运行 `ssh -T git@github.com` |
| SSH_HOST_VERIFICATION     | 在终端核实 GitHub 官方主机指纹，不关闭主机校验                            |
| REPOSITORY_ACCESS         | 检查账户、私有仓库名和 SSH key 对应账号                                   |
| VISIBILITY_RATE_LIMIT     | 等待 GitHub 接口限流恢复后重试                                            |
| SSH_NETWORK / SSH_TIMEOUT | 检查网络后重试；工作台会核对超时写入是否已完成                            |
| CACHE_TARGET_MISMATCH     | 核对 .local 配置；停止服务后先保留缓存副本，再为新目标使用独立缓存        |
| VERSION_CONFLICT          | 重新同步获取新版本，有冲突时逐项选择                                      |
| 超过5MB                   | 先导出独立备份，再设计历史原文归档；不要直接清空云端文件                  |
| 草稿保存失败              | 先复制当前输入；整理草稿箱并检查浏览器存储配额，不要清理全部网站数据      |
| 独立备份未完成            | 按设置页错误检查服务、目录权限、磁盘空间或50MB备份限制；记录/草稿仍保留   |
| 工作区无法打开            | 下载原始状态；保留网站存储，在副本上检查版本或损坏字段                    |

诊断不输出 Git 原始 stderr、私钥、PAT 或个人记录。报告问题时提供应用版本、错误代码、复现步骤；使用合成记录复现。
