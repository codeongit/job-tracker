# 开发、发布与排障

本文说明维护者当前如何准备环境、执行检查、发布升级、回退及处理通用故障。操作步骤、前提或故障处理变化时更新本页；研发流程与交付规则见[变更共用规则](agents/change-workflow.md)，BOSS 启停、补录、状态、排障及人工验收见[操作说明](boss/OPERATIONS.md)，数据格式、备份及恢复见[数据与恢复](DATA_AND_RECOVERY.md)。

当次变更与验证结果按[材料归属](agents/change-workflow.md#材料归属与后续反馈)进入 PR。早期执行结果及未完成验收保留在[固定 Git 历史](https://github.com/codeongit/job-tracker/blob/9012c4a10fdb25a32c816a6f6a09e35fa983d916/docs/MAINTENANCE.md#历史执行与验收记录)，关键决定见 [ADR](adr/README.md)；历史结果仅适用于原版本和范围，未确认项继续待人工验收，不构成新一轮操作授权。

## 新电脑开发

安装 Node.js 24 LTS、Git 和 package.json 指定版本的 pnpm。使用系统 Node 即可，双击启动脚本的 Codex runtime 路径只是兼容现有机器的后备方案。

```sh
pnpm install --frozen-lockfile
pnpm service start
pnpm service status
```

需要本机源文件或 SSH 时，将 `config.example.json` 复制到 `.local/config.json`，按实际情况填写；不需要的字段可以删除。配置无效时服务会明确停止启动。使用系统 SSH agent，不要把私钥复制到项目。

项目应用的真实浏览器测试由用户人工负责；Archify 生成物的已授权例外见下方分工。日常开发和启动不要求安装测试浏览器。

`pnpm start` 可在当前终端前台启动服务；`pnpm service start/status/stop` 提供带实例身份校验的管理入口。服务不登录自启，启动或重启服务不授权 BOSS 访问。首次迁移按[数据与恢复](DATA_AND_RECOVERY.md#首次迁移与版本保护)核对；BOSS 后续操作见[命令与操作](boss/OPERATIONS.md#命令与操作)。

## 本机服务操作

在实际运行服务的宿主机终端使用 `pnpm service start/status/stop`；受限环境的连接失败按[排障](#排障)核对。`start` 默认等待窗口为 30 秒，窗口结束仍为 starting 时先看 `status` 和 `.local/service/service.log`，不重复创建实例。`SERVICE_LAUNCH_UNCONFIRMED` 表示启动进程身份尚未确认，保留启动记录核对；不能据此断言进程已退出。`status` 报告 starting/ready/failed 及已有阶段时间；ready 时的 `processStartedAt`、`readyAt` 和 `startupDurationMs` 分别表示进程创建、就绪时间和初始化耗时，旧记录缺少指标时为 null，starting 时的 `elapsedMs` 不表示已完成耗时。

`stop` 返回 `stopping` 只表示受理。核对实例归属并确认原进程退出后，才启动新版或执行离线审计；监听关闭也不能单独证明进程退出。进程仍存活时保留状态和日志，不按陌生 PID 强杀或清理写者锁。活动连接等资源是否导致残留，需要现场诊断，不能把既往未定位的原因视为已修复。

### 完整历史审计

正常 ready 只确认当前提交、catalog 和服务初始化，不代表本轮完整审计了旧历史，也不代表后台 BOSS 队列已经正式录入。首次旧 HEAD 转换及完整审计可能需要读取全部历史，不保证在 30 秒内完成。旧历史异常可能在读取旧命令或显式审计时才发现，见[本机不可变提交](DATA_AND_RECOVERY.md#本机不可变提交)。

需要完整审计时，先保留整个私有工作区及故障原件，在宿主机停止服务并确认原进程已退出，再运行：

```sh
pnpm service audit
```

审计取得同一工作区写锁，只处理本机材料，不访问平台、恢复跟踪或同步 GitHub。catalog 无效、缺失、未知格式或身份不一致时停止写入；索引故障使审计无法开始也须保留原件，在副本核对后另行安排修复。不能删索引、从最新业务快照猜测历史、盲目重放命令或回退 HEAD。

## 独立 UML 源码浏览器

`pnpm uml` 使用 [unclebob/uml-viewer](https://github.com/unclebob/uml-viewer) 浏览公开源码的目录、模块、静态依赖及源码位置。它是可选 JVM 桌面开发工具，不参与网页部署；Archify 的独立 HTML 继续用于系统职责和流程说明。选择依据见 [D059](adr/0059-standalone-uml-viewer.md)。

需要 Node 24、Git、Java 21+ 和 [Clojure CLI](https://clojure.org/guides/install_clojure)。Java 使用 `JAVA_HOME` 或 `PATH`；可用 `UML_JAVA_HOME` 与 `UML_CLOJURE` 指向专用安装。也支持项目本机目录：Java 放在 `.local/uml-viewer/runtime/java/`（macOS 的 Java home 为其 `Contents/Home/`），Clojure 可执行文件放在 `.local/uml-viewer/runtime/clojure/bin/clojure`。安装官方归档时校验发布方 SHA-256；运行环境无需全局安装，不提交二进制。缺少依赖时命令明确失败，不自动修改系统环境。

```sh
pnpm uml setup   # 首次联网获取固定上游和 Maven 依赖；不打开窗口
pnpm uml check   # 真实上游的无 GUI 加载、下钻、源码定位和隔离检查
pnpm uml         # 生成当前图，前台打开桌面窗口；等同于 pnpm uml open
pnpm uml export  # 仅生成图，不需要 Java/Clojure
```

上游固定为 `f65dafe93b3cb1b4e6bb02dbe41503ed05bd9ebf`，Clojure 库为 `1.12.0`、Quil 为 `4.3.1563`；checkout、CLI 配置、Maven 缓存和生成物均位于 `.local/uml-viewer/`。重复 setup 复用已完成内容；上游提交不符、tracked 文件改动或出现额外文件时拒绝执行，保留旧副本后重新 setup，不自动覆盖个人修改。升级上游须同时复核启动接缝和执行 `pnpm uml check`。

图来源是 Git 跟踪的 `dist/`、`scripts/`、`collector/` 中公开 `.js/.mjs` 工作树内容（新增文件需先 `git add`），排除测试和私有目录。统一解析静态 import、side-effect import 和 re-export，保留跨根依赖；文件不执行，符号链接、未知相对依赖和不支持的动态加载会报错。生成成功后原子替换 `diagram.edn`；失败保留旧图并返回非零状态，不能把旧图当作本次成功结果。

双击目录组件逐层进入，Esc 或左上角返回；叶模块使用原始文件名显示，详情中的长名称自动换行，点击模块名或成员的任一行打开内置只读源码窗口。修改代码后运行 `pnpm uml export`，在窗口按 `R` 重载；也可关闭后重新 `pnpm uml`。更新本项目的查看器适配代码后须关闭窗口并重新运行 `pnpm uml`，`R` 只重载图和源码成员。运行依赖与本机服务、BOSS 跟踪、工作区和 GitHub 同步无关。

独立入口禁用 Grok/tmux companion、mailbox 消费、自动改源码及 proposal 保存；相关按钮只提示使用本地命令。不要使用上游 `get-uml-viewer`、`./uml` 或 `--restart` 替代本项目入口，它们有不同的 companion 生命周期。没有指标时的红色质量标记表示缺失度量，不证明代码质量差。图表示模块静态依赖，不包含完整运行时调用、HTTP/文件交互或函数调用图；导出成员识别和行号定位沿用上游有限的解析器。

`pnpm test` 覆盖适配器合成测试，不要求 Java、不下载依赖；`pnpm uml check` 额外验证真实 JVM 连接、文件标签、离屏文字布局及换行后的源码点击，不替代桌面交互验收。首次使用或上游升级后，人工核对：总图包含三个生产目录、可逐层进入 BOSS 模块、文件名和长成员名完整可读、跨目录依赖存在、源码窗口定位正确、重新 export 后 R 可刷新，退出不影响既有服务或会话。

清理时先关闭查看器，仅移走或删除 `.local/uml-viewer/`；它不包含正式工作区、备份或采集材料，勿扩大到整个 `.local/`。上游目前未提供 LICENSE；本仓库只保存自有适配代码，不再分发上游源码，后续复用或再分发前须核对其[许可状态](https://github.com/unclebob/uml-viewer/issues/14)。

## 每次改动

实施与独立审查分别使用 [implement](../.agents/skills/implement/SKILL.md) 和 [code-review](../.agents/skills/code-review/SKILL.md)。目标、证据版本、文档影响及交付记录统一按[变更共用规则](agents/change-workflow.md)执行；任务分支、PR 与合并按[议题约定](agents/issue-tracker.md)执行。

```sh
pnpm format
pnpm test
pnpm check
pnpm format:check
```

小改动可按影响运行定向非浏览器测试；发布前运行完整 `pnpm test`。纯文档改动运行格式、文档检查并核对差异；修改检查器还须运行对应合成测试。非浏览器测试以 `*.test.mjs` 命名，fixture/helper 使用普通 `.mjs` 后缀；收集范围以 [package.json](../package.json) 为准，通配符由 Node 解析，私有运行材料放在 `.local/`。浏览器回归保持独立入口。

`pnpm check` 检查 JavaScript 语法、公开资源、双版本、生产依赖，以及本地文档链接、标题锚点、ADR 索引和规则映射；不访问外链或执行被检查模块。依赖边界与静态检查限制见[架构约束](ARCHITECTURE.md#依赖与写入约束)，规则编号与映射维护见[规则保障表](agents/rule-assurance.md)。结构通过不能代替语义审查或人工验收。

文档检查范围为根目录 Markdown、docs、collector、`.github` 及 [owned-skills.mjs](../scripts/owned-skills.mjs) 中维护的技能；排除私有目录、依赖、名单外技能和测试材料。接管其他技能时更新该名单；`pnpm format` 与 `pnpm format:check` 也处理同一名单内的 Markdown/YAML。

按改动范围选择补充入口，测试数据使用临时目录与合成材料：

| 改动范围                              | 检查入口与边界                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文档检查器、规则映射机制              | `node --test test/docs-check.test.mjs`；检查结构，不执行映射中的验证命令                                                                                    |
| 本机客户端与服务接口                  | `node --test test/local-workspace-http.test.mjs`；真实客户端经回环 HTTP 访问真实服务和临时 WorkspaceStore，缓存与模式身份使用内存替身，不覆盖真实浏览器存储 |
| BOSS 检查点、分页、恢复或消息依据格式 | 先运行 `pnpm test:boss-contracts`，覆盖已有跨轮与旧版本门槛；影响其他调用者时扩充集合，发布仍运行完整检查                                                   |

BOSS 定点排障按[已有材料核对](boss/OPERATIONS.md#定点排障先核对已有材料)，复用[维护入口](boss/IMPLEMENTATION.md#定点维护复用入口)。流程语义变化的独立试验按[流程回归与迭代](agents/change-workflow.md#流程回归与迭代)执行。

## 真实浏览器测试分工

按用户明确要求，项目应用的真实浏览器相关测试由用户人工负责，包括页面交互、移动端布局、系统中文输入法，以及 Playwright/headless 等真实浏览器回归。代理负责实现、相关非浏览器测试、静态与格式检查，交付时提供简短的人工验收项；用户未反馈前，浏览器验收状态记为“待人工验收”。

项目应用测试除非用户后续明确委托，代理不启动、连接或控制浏览器，不安装测试浏览器，也不申请浏览器测试权限或尝试其他浏览器途径。`pnpm verify` 包含 `pnpm test:browser`，因此代理本地使用上面的非浏览器子命令。

Archify 生成物的浏览器检查、预览与导出适用 [R023](../AGENTS.md#测试与发布) 的已授权例外，隔离范围及授权来源见 [D057](adr/0057-archify-browser-exception.md)。图表的浏览器检查与项目应用验收分别记录；前者通过不替代后者。

浏览器回归与 CI 持续保留，CI 结果单独报告，不能替代人工验收。人工需要运行隔离回归脚本时，可安装 `pnpm exec playwright install chromium` 后执行 `pnpm test:browser`；macOS 已装 Chrome 时也可使用 `PLAYWRIGHT_CHANNEL=chrome pnpm test:browser`。`pnpm verify` 仍可供人工或 CI 执行完整检查。

浏览器脚本只启动 dist 静态服务器、使用临时 profile，拦截所有外部请求，不读取 `.local`，测试使用合成数据。中文输入的自动回归通过 Chromium CDP 触发组合事件，系统输入法候选窗口与实际输入体验由人工检查。

### CI 失败定位与启动检查

CI 在同一 `verify` 作业内分别运行非浏览器测试、静态检查、格式检查、启动冒烟及完整浏览器回归。先打开红色步骤的具体日志；Ubuntu runner 迁移通知与退出码摘要不能单独说明根因。启动冒烟未通过时，不继续运行完整浏览器回归。

页面根元素的 `data-app-state` 初始为 `starting`；工作区读取和首屏初始化完成后为 `ready`，失败时为 `failed` 并保留既有恢复和应急导出界面。它不代表后台 BOSS 采集、备份或 GitHub 同步结果。测试共用就绪检查，初始化失败直接报告，不等待保存提示文案；迁移后重试会先回到 `starting`。

浏览器失败附件只包含隔离合成页面的截图、测试标识及简短初始化信息，不保存完整响应、请求凭据或真实数据。CI 失败作业的附件保留 7 天；本地人工回归输出位于忽略目录 `test-results/`，不要提交。无附件时以失败步骤日志为准，不因附件写入错误隐藏原测试失败。

人工可只运行启动冒烟：`node --test --test-name-pattern='^启动冒烟：静态工作台可初始化$' test/browser-regression.mjs`。代理不执行该命令；本地非浏览器测试覆盖启动标识成功、失败及重试状态转换，CI 仍需验证真实浏览器路径。

## 发布

日常任务在 PR 中记录变更、验证与风险，应用版本和 CHANGELOG 在用户主动发起版本发布时统一维护。发布决定见 [D058](adr/0058-manual-version-releases.md)。用户主动发起版本发布后，代理可准备版本 PR，并在获准合并、满足发布条件后完成该版本的 tag 与 GitHub Release；合并仍按[议题约定](agents/issue-tracker.md#合并与验收)另行授权。

1. **确定范围。** 核对远端已有 tag 与 Release，固定上次发布 tag 的提交和本次目标，读取区间内合并的 PR、Git 差异及已有版本记录。缺少可用 tag 时先确认起始 commit；首次采用此流程时，在版本 PR 说明历史记录覆盖范围。版本标题本身不证明已经发布。
2. **准备版本 PR。** 在任务分支同步更新 `package.json` 与 `dist/version.js`，在 CHANGELOG 顶部整理本版本摘要。版本使用 `X.Y.Z`，按修复、新增功能与兼容性影响确定，并在 PR 说明选择依据；数据、协议与备份等格式版本仍按[数据与恢复](DATA_AND_RECOVERY.md#版本与两种存储模式)随格式变化维护。版本 PR 列明起点、目标范围和适用验收状态。
3. **验证与合并。** 运行完整 `pnpm test`、`pnpm check` 与 `pnpm format:check`，完成同版本独立审查、适用人工验收和 CI。核对公开差异不含真实记录、备份或凭证；取得合并授权后，按既有流程合并版本 PR。
4. **标记版本。** 固定版本 PR 的实际 merge commit，核对该提交的双版本、摘要、CI 及适用检查和验收依据；合并带来相关变化时先补查。为这个明确提交创建附注 tag `vX.Y.Z`，只推送该 tag。main 后续前进不改变本次目标；已有同名 tag 时先回读目标，匹配则沿用，冲突则停止，不移动或覆盖已发布 tag。
5. **发布摘要。** 基于已回读确认的远端 tag 创建 GitHub Release，复用 CHANGELOG 的本版本摘要与已知限制。回读 tag 的目标提交、Release URL 和正文后报告完成。响应未知时先查询再续做；tag 已成功而 Release 失败时保留已完成状态，只补后续步骤。

### 版本摘要

按版本倒序排列，标题包含版本和北京时间发布日期（`YYYY-MM-DD`）。参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 的分类，按需使用“新增、变更、弃用、移除、修复、安全”，省略空类别。条目面向使用者说明关键结果，关联 PR，并提供版本 tag 或完整比较链接；GitHub 自动生成的说明可作为整理输入，最终正文需核对取舍。

优先保留用户可感知变化、重要修复、兼容性变化、升级操作和数据恢复限制；开发细节沿用 PR。已有“未发布”材料可在发版时按实际范围归纳，未纳入本次范围的内容保留待发布状态。历史正文与验收状态保持，新的摘要不能把未验收事项写成已通过；相关验收尚未完成时，版本 PR 保持待验收。

### 本机升级与网页部署

本机升级按实际代码和数据影响执行：先保留完整私有备份，涉及格式变化时读取[数据与恢复](DATA_AND_RECOVERY.md)。v0.8 首次迁移另保留浏览器原工作区与 `.local/`，关闭旧客户端。服务代码或配置变化后按已有方式重启服务，刷新页面核对版本、模式与正式工作区 ID。日常开发提交用 Git commit 定位；相同应用版本号不能证明运行服务已加载当前代码。BOSS 跟踪仍需用户显式开始。

版本发布、网页部署与个人数据发布分别授权。当前仓库只运行 CI，不自动发布网页；公开静态网页只发布 `dist/`，不把 `.local`、本机服务或私有仓库内容作为构建输入。

GitHub Actions 使用 `contents: read`，不配置真实数据仓库 PAT 或 SSH key。依赖更新先更新锁文件、跑同一套检查；不自动合并依赖升级。

## 回退

代码用 Git 提交/tag 保留历史，优先修复或 `git revert` 产生新提交，不强推历史。数据与代码版本分开处理。

v0.2.0 将浏览器数据库升到版本2，因此不能直接用 v0.1.0 操作已经升级的同一浏览器数据库。出现故障先导出完整或原始状态，在独立测试配置验证恢复；不要删除当前网站存储。仍兼容云端 schemaVersion1；修复版应保留对工作区v2的支持。

v0.3.0 不改变工作区v2或共享数据v1，但完整备份升为v2，旧版不识别。回退前先下载包含草稿的v2备份，保留 `.local/backups/`；不要删除浏览器 localStorage。备份测试只操作临时目录，不能把用户目录当 fixture。

v0.7.0 的共享数据升为 v2，旧版工作台不认识 `sourceBindings` 与 `sourceEvents`。回退代码前先下载完整备份并保留 `.local/boss-integration/`、采集器原始快照及浏览器存储；不能让 v0.6.0 写回新格式。工作区/备份外层仍为 v2，但这不表示旧客户端可安全操作新共享数据。

v0.8.0 将共享数据、工作区升为 v3，本机正式存储改为不可变提交；备份外层仍 v2、磁盘存储和本机协议为 v1。不能用 v0.7 直接操作已迁移本机工作区，不能把浏览器缓存当唯一正式数据。先保留完整备份、`.local/workspace/`、队列和原始快照，在副本验证恢复；不手动改 HEAD 或删除活跃写者锁。旧静态客户端也应在首次 v3 云同步前关闭/升级，避免它仍基于旧远端版本工作。

v0.10.3 的 HEAD 格式升为 v2、catalog 为 v1，提交与 identity 保持 v1；服务协议仍 v1，数据 v4、工作区 v3、备份 v2 不变。旧代码不能原地写入新版 HEAD。回退前保留完整业务备份及整个私有工作区，包括 HEAD 指定 catalog、提交和迁移原件；不手工删除索引字段、替换 HEAD 或裁剪历史。业务备份恢复产生新编辑并保留所有已提交 commandId，不能用恢复旧记录来重置幂等索引。

## 排障

先运行 `pnpm doctor`、`pnpm service status` 查看 Node、Git 和服务身份。BOSS 的诊断入口、状态含义和逐项错误处理统一见[操作说明的排障](boss/OPERATIONS.md#排障)；连接文件存在或浏览器显示调试中，不等于账号、任务页、采集和正式录入均健康。

这些命令必须在运行服务的宿主机终端执行，或明确使用能够访问宿主机回环网络的执行上下文。Codex 沙箱、容器和其他受限执行环境可能能读取宿主机共享目录中的 `.local` 持久状态，却不能连接宿主机的 `127.0.0.1`；此时它们返回的 `SERVICE_UNAVAILABLE` 只表示“当前执行上下文无法访问服务”，不能据此断言宿主机服务已经停止。判断优先级为：宿主机终端的 `pnpm service status` / `pnpm boss status` 实时结果优先；`.local/boss-integration/tracking.json`、工作区 `HEAD.json` 和运行记录只用于确认最后持久化状态；沙箱内的回环连接失败不能覆盖宿主机实时结果。报告状态时必须同时说明命令执行上下文，不得把“服务不可达”“服务已停止”和“BOSS 跟踪已暂停”混为一谈。

start/status/doctor 共用运行记录端口和服务身份检查。`healthCheck` 显示 `reason`、`durationMs`、`timeoutMs`、`attempts` 及已取得的 `httpStatus`：`timeout` 是检查超时，`connection_refused` 是端口拒绝连接，`permission_denied` 是执行环境不允许连接，`invalid_response` 是响应格式无效，`http_error` 是异常 HTTP 状态，`identity_mismatch` 是服务身份不符，`transport_error` 是其他未明确的连接异常，`ok` 才表示身份核对通过。进程存活不能替代健康及身份核对；当前诊断不能追溯证明缺少现场的一次旧故障根因。

status 和 doctor 只检查一次且不写日志。只有 start 对仍存活进程的超时／连接拒绝等待 200ms 后再检查一次，每次最多 1500ms，两次预算 3200ms；首次启动原 30 秒等待窗口不因补查重置，启动耗时仍以实际指标为准。权限、格式及身份异常立即结束核对，不自动杀进程、清理运行记录或创建另一个不确定实例。doctor 只在得到已验证的明确版本差异时建议重启，缺失信息显示未知。

失败或未确认的 start 向 `.local/service/service.log` 追加 `service_start_diagnostic` 摘要，只含时间、固定原因、端口、PID、记录阶段及检查耗时等白名单字段，权限 0600，不保存凭据、响应正文或原始异常。`diagnosticSaved: false` 表示摘要未能保存，服务判断与所有权保护仍保持；不要因此盲目重复启动。CLI 诊断代码下次运行即可生效；如果已验证的服务版本不同，由用户重启服务并刷新页面，重启不恢复 BOSS 跟踪。

| 现象/代码                        | 处理                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 沙箱中 `SERVICE_UNAVAILABLE`     | 在宿主机终端重新运行 `pnpm service status`；沙箱可能无法访问宿主机回环地址，不能仅凭该结果重启或判定服务已停止 |
| 页面版本与本机服务不同           | 重启本机服务，再刷新页面                                                                                       |
| 请关闭旧版页面                   | 关闭其他工作台标签页，刷新后完成数据库升级                                                                     |
| GIT_NOT_FOUND                    | 安装 Git，重新打开终端后再启动                                                                                 |
| SSH_AUTH_FAILED                  | 检查系统 SSH agent 和 GitHub SSH keys，可手动运行 `ssh -T git@github.com`                                      |
| SSH_HOST_VERIFICATION            | 在终端核实 GitHub 官方主机指纹，不关闭主机校验                                                                 |
| REPOSITORY_ACCESS                | 检查账户、私有仓库名和 SSH key 对应账号                                                                        |
| VISIBILITY_RATE_LIMIT            | 等待 GitHub 接口限流恢复后重试                                                                                 |
| SSH_NETWORK / SSH_TIMEOUT        | 检查网络后重试；工作台会核对超时写入是否已完成                                                                 |
| CACHE_TARGET_MISMATCH            | 核对 .local 配置；停止服务后先保留缓存副本，再为新目标使用独立缓存                                             |
| VERSION_CONFLICT                 | 重新同步获取新版本，有冲突时逐项选择                                                                           |
| 超过5MB                          | 先导出独立备份，再设计历史原文归档；不要直接清空云端文件                                                       |
| 草稿保存失败                     | 先复制当前输入；整理草稿箱并检查浏览器存储配额，不要清理全部网站数据                                           |
| 独立备份未完成                   | 按设置页错误检查服务、目录权限、磁盘空间或50MB备份限制；记录/草稿仍保留                                        |
| 工作区无法打开                   | 下载原始状态；保留网站存储，在副本上检查版本或损坏字段                                                         |
| 工作区 revision 冲突             | 重新读取服务最新状态，保留草稿后核对再保存，不盲目重放用户修改                                                 |
| 浏览器本地记录尚未迁移/身份不同  | 先下载含草稿的完整迁移备份并核对数量与摘要，再明确切换到当前本机正式工作区；不要清空 IndexedDB 规避保护        |
| `SYNC_REMOTE_MISSING`            | 保留正式记录，核查远端文件、分支和路径；已有同步基线时不能按首次初始化把缺失远端重建为空文件                   |
| 协议或格式不支持                 | 升级页面/服务并保留原件；不删未知字段、不静默降级为静态写入                                                    |
| 活跃写者或 HEAD 不一致           | 保留 `.local/workspace/`，核对服务实例/外部修改；不手动删除锁或编辑 HEAD                                       |
| `WORKSPACE_DURABILITY_UNCERTAIN` | 停止继续录入并保留整个工作区目录，重启服务后读取实际 HEAD 与原命令结果；未确认前不要重提业务动作或确认队列回执 |
| 服务所有权不符                   | 核对 `pnpm service status` 与端口占用者；不要按旧 PID 直接终止进程                                             |

诊断不输出 Git 原始 stderr、私钥、PAT 或个人记录。报告问题时提供应用版本、错误代码、复现步骤；使用合成记录复现。

BOSS 合成测试与人工验收分别按[代码阅读与测试](boss/IMPLEMENTATION.md#代码阅读与测试)和[人工验收](boss/OPERATIONS.md#人工验收)执行；首次迁移、关页后台录入和手动同步往返按[恢复与迁移验收](DATA_AND_RECOVERY.md#恢复与迁移验收)核对。
