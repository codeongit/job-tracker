# Logic Prototype

A single, self-contained HTML file (a **shareable demo**) that lets anyone drive a state model by clicking buttons. Use this when the question is about **business logic, state transitions, or data shape**: the kind of thing that looks reasonable on paper but only feels wrong once you push it through real cases.

Because it's one file with nothing to install, you can hand it to a non-developer (a designer, a PM, a domain expert) and let them feel the model for themselves. So it speaks their language, not the code's.

## When this is the right shape

- "I'm not sure if this state machine handles the edge case where X then Y."
- "Does this data model actually let me represent the case where..."
- "I want to feel out what the API should look like before writing it."
- Anything where someone wants to **press buttons and watch state change**.

If the question is "what should this look like," this is the wrong branch. Use [UI.md](UI.md).

## Process

### 1. State the question

Before writing code, write down what state model and what question you're prototyping. One paragraph, at the top of the demo (in a visible intro, not just a comment). A logic prototype that answers the wrong question is pure waste, so make the question explicit so it can be checked later, whether the user is watching now or returning to it AFK.

### 2. Isolate the logic in a portable module

将回答问题的逻辑写成单个 `<script>` 块中的小型纯模块，与页面外壳分开。逻辑和页面都属于原型；这种隔离便于判断模型，也便于已获授权的正式实施参考其设计。

The right shape depends on the question:

- **A pure reducer**: `(state, action) => state`. Good when actions are discrete events and state is a single value.
- **A state machine**: explicit states and transitions. Good when "which actions are even legal right now" is part of the question.
- **A small set of pure functions** over a plain data type. Good when there's no implicit current state, just transformations.
- **A class or module with a clear method surface** when the logic genuinely owns ongoing internal state.

Pick whichever shape best fits the question being asked, _not_ whichever is easiest to wire to a page. Keep it pure: no DOM, no `document`, no button handlers reaching inside it. The page calls into it; nothing flows the other direction. 正式实施可以参考经核对的 reducer、状态机或函数设计，仍需按生产要求补足验证与错误处理。

### 3. Build the shareable HTML file

One file, plain HTML/CSS/JS: no framework, no bundler, no server, everything inline so it opens by double-click and survives being emailed around. Anyone should be able to run it by opening it.

Write it for a non-developer. Every label is in **domain language**, not code: buttons and state read like the business, not the reducer. Explain in plain words what's happening.

Lay it out with a clean hierarchy, top to bottom:

1. **Title and one-line explanation** of what this demo lets you explore (the question from step 1).
2. **Current state**: the full relevant state, rendered as a readable panel (labelled fields, not a raw JSON dump), re-rendered after every click so the change is visible. Where it helps a non-developer follow, call out what just changed.
3. **Free-play buttons**: one button per action, always available, so anyone can poke at the model in any order. Each click dispatches its action and re-renders the state.
4. **Guided walkthroughs**: a set of **scenarios**, one per tab. Each tab holds a short plain-language description of the scenario (the situation it sets up and what to watch for) and underneath it, the ordered **buttons to press** for that scenario. Each step is a real button: clicking it performs that action and moves to the next step. Starting a walkthrough resets to a known initial state so the scenario runs the same way every time.

Choose scenarios that demonstrate the awkward cases, the ones hard to reason about on paper: the happy path, a tricky edge case, an attempt at something that should be illegal.

Keep it beautiful but restrained: clean typography, generous spacing, one accent colour. No animations, no gimmicks: nothing that competes with the state and the buttons.

### 4. Hand it over

交付文件与简短操作说明，由用户打开并体验。本项目的真实浏览器验证遵循 [D017](../../../docs/adr/0017-manual-browser-testing.md)，已有原型授权不自动包括代理控制浏览器。用户发现“不应该发生”或“预期不同”的场景时，记录模型问题，并在原型范围内增加相应操作或引导演示。

### 5. Capture the answer and the prototype

按 [SKILL](SKILL.md) 记录模型结论、反例、用户确认和未验证项，保存完整 HTML 及运行说明。仅要求验证模型时，交付原型与结论；正式实施已获授权时，将经核对的模型设计交回原任务，通过 implement 完成生产实现、测试与审查。完整 HTML 继续作为可重跑的设计证据保存。

## Anti-patterns

- **Don't add tests.** A prototype that needs tests is no longer a prototype.
- **Don't wire it to the real database.** Use in-memory state unless the question is specifically about persistence.
- **Don't generalise.** No "what if we wanted to support X later." The prototype answers one question.
- **Don't blur the logic and the page together.** If the pure module references the DOM, `document`, or button handlers, it's no longer liftable. Keep the page as a thin shell over a pure module.
- **Don't reach for a framework, bundler, or server.** One file the recipient double-clicks; a React app or a dev server defeats "shareable".
- **Don't ship the HTML shell into production.** The page is optimised for being clicked through by hand. The logic module behind it is the bit worth keeping.
