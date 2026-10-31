# 独立 UML 源码浏览器

`pnpm uml` 使用 [unclebob/uml-viewer](https://github.com/unclebob/uml-viewer) 浏览公开源码的目录、模块、静态依赖及源码位置。它是可选 JVM 桌面开发工具，不参与网页部署；Archify 的独立 HTML 继续用于系统职责和流程说明。选择依据见 [D059](adr/0059-standalone-uml-viewer.md)。

## 环境与安装

需要 Node 24、Git、Java 21+ 和 [Clojure CLI](https://clojure.org/guides/install_clojure)。Java 使用 `JAVA_HOME` 或 `PATH`；可用 `UML_JAVA_HOME` 与 `UML_CLOJURE` 指向专用安装。也支持项目本机目录：Java 放在 `.local/uml-viewer/runtime/java/`（macOS 的 Java home 为其 `Contents/Home/`），Clojure 可执行文件放在 `.local/uml-viewer/runtime/clojure/bin/clojure`。安装官方归档时校验发布方 SHA-256；运行环境无需全局安装，不提交二进制。缺少依赖时命令明确失败，不自动修改系统环境。

```sh
pnpm uml setup   # 首次联网获取固定上游和 Maven 依赖；不打开窗口
pnpm uml check   # 真实上游的无 GUI 加载、下钻、源码定位和隔离检查
pnpm uml         # 生成当前图，前台打开桌面窗口；等同于 pnpm uml open
pnpm uml export  # 仅生成图，不需要 Java/Clojure
```

上游固定为 `f65dafe93b3cb1b4e6bb02dbe41503ed05bd9ebf`，Clojure 库为 `1.12.0`、Quil 为 `4.3.1563`；checkout、CLI 配置、Maven 缓存和生成物均位于 `.local/uml-viewer/`。重复 setup 复用已完成内容；上游提交不符、tracked 文件改动或出现额外文件时拒绝执行，保留旧副本后重新 setup，不自动覆盖个人修改。升级上游须同时复核启动接缝和执行 `pnpm uml check`。

## 生成图与使用

图来源是 Git 跟踪的 `dist/`、`scripts/`、`collector/` 中公开 `.js/.mjs` 工作树内容（新增文件需先 `git add`），排除测试和私有目录。统一解析静态 import、side-effect import 和 re-export，保留跨根依赖；文件不执行，符号链接、未知相对依赖和不支持的动态加载会报错。生成成功后原子替换 `diagram.edn`；失败保留旧图并返回非零状态，不能把旧图当作本次成功结果。

双击目录组件逐层进入，Esc 或左上角返回；叶模块使用原始文件名显示，详情中的长名称自动换行，点击模块名或成员的任一行打开内置只读源码窗口。修改代码后运行 `pnpm uml export`，在窗口按 `R` 重载；也可关闭后重新 `pnpm uml`。更新本项目的查看器适配代码后须关闭窗口并重新运行 `pnpm uml`，`R` 只重载图和源码成员。运行依赖与本机服务、BOSS 跟踪、工作区和 GitHub 同步无关。

独立入口禁用 Grok/tmux companion、mailbox 消费、自动改源码及 proposal 保存；相关按钮只提示使用本地命令。不要使用上游 `get-uml-viewer`、`./uml` 或 `--restart` 替代本项目入口，它们有不同的 companion 生命周期。没有指标时的红色质量标记表示缺失度量，不证明代码质量差。图表示模块静态依赖，不包含完整运行时调用、HTTP/文件交互或函数调用图；导出成员识别和行号定位沿用上游有限的解析器。

## 验证与维护

`pnpm test` 覆盖适配器合成测试，不要求 Java、不下载依赖；`pnpm uml check` 额外验证真实 JVM 连接、文件标签、离屏文字布局及换行后的源码点击，不替代桌面交互验收。首次使用或上游升级后，人工核对：总图包含三个生产目录、可逐层进入 BOSS 模块、文件名和长成员名完整可读、跨目录依赖存在、源码窗口定位正确、重新 export 后 R 可刷新，退出不影响既有服务或会话。

清理时先关闭查看器，仅移走或删除 `.local/uml-viewer/`；它不包含正式工作区、备份或采集材料，勿扩大到整个 `.local/`。上游目前未提供 LICENSE；本仓库只保存自有适配代码，不再分发上游源码，后续复用或再分发前须核对其[许可状态](https://github.com/unclebob/uml-viewer/issues/14)。
