# HTML 报告格式

本页只定义报告的展示方式。候选内容、推荐程度与交付方式以 [技能正文](SKILL.md#2-用-html-报告呈现候选) 为准；设计判断沿用 [codebase-design](../codebase-design/SKILL.md)，避免在模板中另设抽象或测试规则。

报告使用中文、内联 CSS 和内联 SVG，不加载 CDN、外部字体或脚本。正文与图示保存在同一 HTML 文件中，可以离线阅读。引用源码时展示路径和定位信息；链接只是辅助，不作为理解报告的唯一入口。

## 页面骨架

以下是排版骨架，生成报告时填入实际证据与图示。没有候选时，用扫描范围、保留现状的依据和覆盖限制替换候选区及推荐区。

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>代码库架构分析</title>
    <style>
      body {
        margin: 0;
        background: #fafaf9;
        color: #1e293b;
        font-family: system-ui, sans-serif;
        line-height: 1.65;
      }
      main {
        max-width: 72rem;
        margin: auto;
        padding: 2rem 1rem;
      }
      article {
        margin-block: 2rem;
        padding: 1.5rem;
        border: 1px solid #d6d3d1;
        border-radius: 1rem;
        background: white;
      }
      .comparison {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
        gap: 1rem;
      }
      figure {
        margin: 0;
        padding: 1rem;
        background: #f5f5f4;
      }
      svg {
        display: block;
        width: 100%;
        height: auto;
      }
      code {
        overflow-wrap: anywhere;
      }
      a {
        color: #4338ca;
      }
      .badge {
        display: inline-block;
        padding: 0.2rem 0.6rem;
        border-radius: 0.4rem;
      }
      .priority {
        background: #d1fae5;
        color: #065f46;
      }
      .explore {
        background: #fef3c7;
        color: #92400e;
      }
      .uncertain {
        background: #e2e8f0;
        color: #334155;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>代码库架构分析</h1>
        <!-- 填写仓库、日期、分析版本、扫描范围和覆盖限制。 -->
      </header>
      <section aria-label="候选方案">
        <!-- 每个候选使用一个 article，包含证据、图示和取舍。 -->
      </section>
      <section aria-label="下一步">
        <!-- 填写优先探索的方向与依据，或保留现状的结论。 -->
      </section>
    </main>
  </body>
</html>
```

## 候选卡片

每项候选使用一个 `<article>`，配唯一锚点，方便推荐区定位。标题说明实际责任及预期变化；推荐程度使用带文字的徽标，颜色只作辅助。

按“证据与问题 → 调整前后图 → 收益、保留条件与代价 → 未知项”的顺序组织正文。路径使用等宽字体，长证据或调用片段可放入原生 `<details>`；影响选择的约束、风险和 ADR 冲突保持直接可见。

图示与文字互补。允许用短段落解释调用前提、失败路径和迁移成本，不为固定句数或字数省略证据；未知项按实际不确定程度表达。

## 调整前后图

两幅图比较同一层级、同一场景，分别标为“当前结构”和“候选方向，未实施”。宽屏并排，窄屏上下排列。用文字或 `<figcaption>` 概括变化，SVG 提供 `viewBox`、可读标签及 `<title>`。

按问题选择图形：

- **调用与依赖：** 用方框和带箭头的连线显示实际调用关系，在相关位置标注泄漏的规则或重复步骤。
- **职责归属：** 用分组框显示哪些复杂度由责任模块承接，哪些内部职责和外部依赖仍然独立。
- **接口与实现：** 分别列出调用者需要知道的事实和模块封装的能力。面积仅作示意，深度判断仍由具体知识负担说明。
- **测试位置：** 标出观察行为的接口、替换依赖的接缝，以及未覆盖的生产连接；位置沿用实际分析结果。

图例随实际图形提供。用强调色标记有证据的摩擦，未知关系使用虚线并注明“待核实”。即使候选涉及合并，也应画出保留的职责和约束，不能仅凭方框变少表达收益。

## 文字与样式

- 使用留白、清晰标题和少量颜色建立层次，避免固定图高裁切标签或长路径。
- 领域名称与项目技术名称保留原义；架构角色使用共享设计术语，不强制把 API、服务或组件改名。
- 收益写成可核对的变化，例如“调用者无需重复安排校验顺序”；测试收益说明覆盖的行为及剩余限制。
- 推荐区链接候选卡片，简述为什么优先调查或推进，以及哪项未知事实可能改变排序。
