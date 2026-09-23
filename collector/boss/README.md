# BOSS 会话与岗位追踪

这是一个按需运行、仅保存在本机的 BOSS 沟通页追踪器。它读取页面已经加载的会话，不自动滚动历史，不发送消息、不投递简历。采集器不自行创建定时任务；工作台后台调度器通过有界 `run` 命令调用它。

采集器源码随求职工作台 v0.8.3 一起保存在 `collector/boss/`，由 `pnpm boss start|run|pause|resume|stop|recover-page|status|doctor` 统一调用。私有快照、浏览器 profile 和运行状态保存在仓库忽略的 `.local/boss-collector/`，不与源码混放。本机服务把确定性事件写入私有队列及正式不可变工作区；工作台网页关闭不影响队列录入。本采集器不会自行上传 GitHub 或安装登录自启任务。首批日期、去重、节奏和故障规则以工作台 [接入说明](../../docs/BOSS_AUTOMATION_DESIGN.md) 为准。

## 常用流程

进入本目录后运行：

```sh
# 显式启动／绑定。缺少任务页时最多创建或导航一次
node tracker.mjs start

# 仅核验原浏览器实例和原标签；不会创建、导航或刷新
node tracker.mjs resume

# 此后只读复用该任务标签，无需保持选中
node tracker.mjs check

# 一次工程化周期。预算由工作台传入，0 表示跳过相应阶段
node tracker.mjs run --history-requests 20 --dom-limit 0 --detail-limit 20

# 仅看本地状态，不连接浏览器
node tracker.mjs status
node tracker.mjs resume-scan --limit 3 --pages 1

# 单独补齐缺失岗位名称；每批默认且最多 20 个，相邻导航至少 10 秒
node tracker.mjs enrich --limit 1
node tracker.mjs enrich --limit 3 --time-label 昨天

# 解除任务标签绑定，不关闭、不置空、不导航标签
node tracker.mjs disconnect
```

新账号使用独立的本地标签：

```sh
node tracker.mjs connect --account another-account
node tracker.mjs check --account another-account
node tracker.mjs status --account another-account
```

`init` 仍可为没有任何旧数据的账号建立首次 v3 基线；已有 v1、v2 或 v3 数据时拒绝覆盖。当前 `main` 已有旧基线，应使用 `check` 自动迁移，不要重新初始化。

## 连接与后台读取

`start`（兼容别名 `connect`）显式启动专用 Chrome 用户目录并绑定任务页；任务页缺失时只允许创建或导航一次。绑定保存远程调试端口对应的浏览器实例指纹和真实 CDP target ID，不依赖当前选中标签。

身份核验成功后只保存最小连接元数据。账号原始 ID 只在页面内使用，磁盘只保存哈希 namespace，不读取 Cookie、令牌或浏览器存储。`resume`、`check` 和 `run` 只接受原浏览器实例和原 target；不需要标签可见或选中，也不创建、导航或刷新沟通页。

`check` 只复用这个任务专用后台目标，不重新选择、读取或操作用户原来的 BOSS 标签。读取前后都会核对：

- 专用 Chrome 实例指纹和 CDP target ID 仍是连接时记录的目标；
- 任务标签网址仍是 `https://www.zhipin.com/web/geek/chat`，页面没有漂移；
- 页面账号 ID 与 Vue 状态中的账号 ID 一致，且仍属于连接时的账号。

任务标签关闭、网址漂移、浏览器实例重启或登录失效时立即停止且不保存新的列表快照。自动轮次不会重建标签。只有用户明确运行 `recover-page` 时，程序才允许重新绑定，并在缺页时最多创建或导航一次。

`disconnect` 只删除采集器保存的 CDP 绑定；任务标签的网址和打开状态保持不变。

历史消息按单请求执行：页面内 XHR 最长 15 秒并主动超时，CDP 外层最长等待 20 秒，每次请求后保存会话与下一页检查点。若请求结果返回前调试通道断开，本轮按一次平台请求保守计数，**不会**在重连循环里重放；下一轮在旧请求已过页面超时后从持久页码继续，避免两个未知请求重叠。身份和列表等不发平台请求的 CDP 读取仍可使用持久的 2、10、30 秒有限重连。

## 会话、消息和岗位规则

会话主键由“已验证账号 namespace＋`friendId`＋`friendSource`”产生，并核对页面 `uniqueId`。姓名、公司和招聘人职务只是可变化属性；功能卡、占位项、缺失或冲突的 ID 不会退回姓名去重。

`check` 读取虚拟列表已经加载的数据源，因此可以包含未渲染在屏幕上的行；它不会自动滚动。覆盖范围会分别报告已加载数据、已渲染行、离屏行和未解析项，绝不把局部列表称作全部历史。

消息摘要带有平台 `lastMsgId`。只有前后消息 ID 相同且非空时，回执变化才记为同一条摘要的状态变化。页面明确显示的 `[已读]`、`[送达]` 仅从已渲染行的 DOM 读取；离屏行尚未完成显示规则校准，因此回执保持 `unknown`。送达不等于未读，未知也不等于 0。

岗位以 `encryptJobId` 独立标识，会话与岗位是关联关系：多个招聘者可以对应同一岗位，同一会话也可以在不同时间出现不同岗位。岗位名称只使用实际 `jobName` 或经详情页标题核验的名称；不会用招聘人职务或岗位分类代替。详情地址固定为规范 BOSS job-detail URL，不携带查询参数。

## v3 保存与旧数据迁移

每次成功检查写入新的不可变 v3 JSON，旧文件不改写。旧 v1/v2 文件仍可读取；任何后续写入会先经显式、保持原有字段语义的 v2→v3 适配。v3 将以下数据分开保存：

- 当次聊天列表观察和长期会话状态；
- 会话与岗位的当前／历史关联；
- 岗位名称证据、公司不一致候选和用户确认。

首次对现有 `main` 执行成功的 `check` 时，会在新捕获的平台 ID 基础上迁移旧 v1 数据和 `jobs-enriched.json`。只有姓名＋公司在新旧两侧都唯一、且岗位信息相容时才建立迁移关联；歧义与冲突进入 quarantine，不强行合并，也不制造“新会话”事件。

现有迁移测试核对了：40 条旧记录可唯一对应、39 个岗位名称作为正式证据、1 个公司不一致名称保持候选、1 条用户确认只作用于原会话和具体 URL。重复导入幂等。

`jobs.md` 由正式 v3 状态生成，和 `status` 使用同一个共享解析器。聊天采集时间与每条岗位证据时间分别显示；候选不会计入已命名岗位。

## 独立岗位补齐

`enrich` 不点击或切换聊天。列表、历史和详情统一使用同一 CDP 浏览器实例；详情阶段通过 CDP 创建一个带所有权令牌和 target ID 的后台标签，串行导航并要求标题连续稳定两次才接收。用户的沟通页不会被导航或刷新。使用 `--time-label 昨天` 时只处理当前快照中该原始标签的记录；每轮最多 20 个岗位，详情之间至少等待 10 秒，工作台控制器另保留滚动每小时 60 次导航总额。

同岗位证据可以复用；公司与会话公司不一致时仅保存为候选。登录页、验证码、意外网址、标签所有权异常或超时会安全停止并返回已完成部分。只关闭经 ID、窗口和当前 URL 核验仍属于本次任务的标签。

旧 `fill-jobs.mjs` 会点击聊天，保留仅用于审计旧实现；统一流程不再调用它。

## 受控 DOM 会话补采

`run` 已接入最多一个会话的 DOM 补采入口，但生产默认 `--dom-limit 0`，且账号目录没有私有验收策略时即使传入 `1` 也不会点击。当前列表快照把未读能力明确记为不可用，因此不能把“未显示角标”当作 0；只有真实浏览器验收通过并写入与账号 namespace 精确绑定的 `.dom-supplement-policy-v1.json` 后，入口才允许继续。

启用后的每次补采仍会在点击前重新核对：固定规则版本、账号、`friendId`、`friendSource`、`uniqueId`、最新消息 ID、唯一已渲染行，以及 Vue 数据源中经人工验收的 `unreadMsgCount === 0` 证据。任一项缺失或变化都保持待补采，不点击、不滚动列表、不刷新、不导航，也不发送消息。相邻切换至少 30 秒，每轮最多一次；公平游标、完成任务和“切换已发出但结果未知”的检查点均跨重启保存。未知结果不会自动重试。

DOM 仅接受带稳定 `data-message-id` 和 `data-message-time` 的白名单系统状态，来源固定保存为 `dom_chat_status_message_v1`，不会伪装成历史接口证据。该 DOM 结构仍标记为**待真实浏览器验收**；验收前不要创建启用策略。

历史接口的“附件简历请求已发送”既可能以精确系统文案返回，也可能仅以平台模板签名返回。模板识别只接受已实测的完整结构 `type=4 / bizType=317 / body.type=16 / body.style=3 / body.templateId=1`、单文章卡片及对端发送方关系；任一字段不同都继续作为普通卡片观察，不能推进简历状态。

## 文件与安全

- 快照：`.local/boss-collector/<账号标签>/*.json`，每次成功运行新增一个文件。
- 连接：`.local/boss-collector/<账号标签>/.connection.json`，包含浏览器实例指纹和任务 target ID，`disconnect` 后删除。
- 运行状态和公平游标：`.local/boss-collector/<账号标签>/.runtime-v1.json`。
- 历史请求检查点：`.local/boss-collector/<账号标签>/.resume-checkpoint-v1.json`；不保存 securityId 或聊天正文。
- DOM 验收策略、进度和检查点：`.local/boss-collector/<账号标签>/.dom-supplement-*.json`；默认没有启用策略。
- 岗位清单：`.local/boss-collector/<账号标签>/jobs.md`。
- 目录权限为 `0700`，私有文件为 `0600`；这是本机访问控制，不是加密。
- 终端只打印数量、状态和路径，不打印联系人、公司、岗位名称或聊天摘要。

异常采集不会覆盖最近有效状态。若看到 `CAPTURE_ALREADY_LOCKED`，先确认没有另一个任务在运行；程序不会自动删除无法确认是否仍在使用的锁。

## 验证

本机环境为 macOS、Node.js 24 和 Chrome CDP。运行全部纯测试：

```sh
pnpm test
```

测试不操作真实浏览器。真实小规模验收顺序是：显式执行一次 `start` 并登录，切换到其他标签或应用后执行 `resume` 与 `check`；关闭任务标签后确认自动命令只暂停、不重建，再由用户显式运行 `recover-page`，最后按需执行 `run --history-requests 2 --dom-limit 0 --detail-limit 1`。DOM 规则另行小规模验收，在验收完成前保持 `--dom-limit 0` 且不创建启用策略。
