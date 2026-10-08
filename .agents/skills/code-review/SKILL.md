---
name: code-review
description: "Review a branch, pull request, or working-tree changes against the project's standards and original requirements. Independently check the existing mechanism and intended behavior before judging the implementation."
---

Review on two separate axes:

- **Standards**: does the change conform to the repo's coding standards?
- **Spec**: are the current mechanism and intended behavior understood correctly, and does the change satisfy the original requirements?

Follow [change workflow](../../../docs/agents/change-workflow.md), especially its two-stage independent review. Both axes inspect the same captured version of the change. Preserve their separate conclusions.

## Process

### 1. Capture the baseline and full review scope

Reuse the task's recorded baseline and scope. Resolve each ref to a commit once and record whether the target is a committed revision or the current working tree. For a committed comparison, pin the merge-base and target HEAD and use that fixed pair. If a necessary ref or the actual scope is missing, ask for the missing choice while inspecting known material.

For a working-tree review:

- Capture `git status --short` and the tracked difference with `git diff <resolved-base>`; this includes staged and unstaged changes. Capture the changed tracked files and their baseline contents.
- Inventory new files with `git ls-files --others --exclude-standard`; include the relevant new files' contents, not just their names. Apply project privacy boundaries and keep ignored private data out of review material.
- If the task started with local changes, use the recorded pre-change copies to distinguish existing work from this task. HEAD alone does not represent that starting state. If those copies are absent, declare the broader scope or missing attribution instead of claiming all changes belong to the task.
- Capture file contents in a temporary review snapshot, or record and verify their hashes throughout review. Freeze the baseline, diff, new-file contents, and relevant sources for both reviewers; recapture affected material if files change.

A committed diff being empty does not end a working-tree review: evaluate the tracked working-tree diff and relevant new files together. Record the commit list where applicable. **Complete when the baseline, target version, included files, and scope limitations are explicit.**

### 2. Identify the original target evidence

Use the user's original request and corrections, or the originating issue/specification, as target evidence. Find issue references through `docs/agents/issue-tracker.md`, reuse a supplied path, or inspect relevant original specs under `docs/`, `specs/`, or `.scratch/`. User intent already present in the task is sufficient; ask only for genuinely missing decisions.

Separate original requirements and existing constraints from implementer assumptions, new proposals, and new ADRs. Implementation agreement with a new document does not establish that the target is correct. Where target evidence is unavailable, report the limitation and review the verifiable mechanisms and standards; do not invent a requirement or silently mark Spec as passed.

### 3. Identify the standards sources

Read relevant repo standards such as `CODING_STANDARDS.md`, `CONTRIBUTING.md`, and project instructions. If a required configuration pointer is absent, report it and continue the review that available material supports.

The Standards axis also carries the Fowler smell baseline below. Documented repo standards override it. Smells remain labelled judgement calls, such as "possible Feature Envy"; skip rules already enforced by tooling.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Run independent Standards and Spec reviews

Give the **Standards reviewer** the captured diff, new-file contents, standards-source files and smell baseline in full. Ask for documented violations with source references and separately labelled judgement calls. It can run while the Spec reviewer establishes its independent understanding.

Start the **Spec reviewer** in a fresh context (`fork_turns: "none"` when available). Provide materials in two separate turns:

1. **Before the diff:** give the user's original requirements/corrections, the pinned baseline code, relevant pre-existing decisions/contracts, and a neutral scope description. Explicitly direct it to read baseline sources rather than modified working-tree files. Ask it to independently trace the affected mechanism, intended results, preserved constraints and consequential uncertainties, citing evidence. Withhold implementer conclusions, new proposals/ADRs, the diff and modified test expectations. Retain this response as the independent comparison.
2. **After that response:** provide the same captured change reviewed by Standards, including new files and tests. Ask for requirements missing or wrong, unintended behavior, overlooked dependencies/side effects, and mismatches between the original target, baseline mechanism and change. New documents and tests are review subjects. Each finding should cite the source and concrete impact; original specs can themselves be ambiguous or incomplete.

Scale exploration to the change's impact. Resolve factual gaps through code, tests or authorized inspection; surface intent conflicts with their source instead of converting an assumption into user confirmation. If a fresh context is unavailable, state the reduced independence and perform baseline reasoning before examining the change; do not claim the full two-stage independence was achieved.

Keep each final axis report concise (normally under 400 words), with its coverage and unresolved limitations. Recheck affected material if either reviewer finds a new dependency outside the captured scope.

### 5. Aggregate

Present the reports under `## Standards` and `## Spec`. Preserve the axes separately. A missing target or unresolved mechanism/intent issue prevents a complete Spec acceptance, even when tests pass or the change matches its newly written ADR.

End with the total findings per axis, the worst issue within each axis, and any coverage limitations. For implementation handoff, resolve blocking findings and recheck the affected content before claiming completion.

## Why two axes

Standards checks code quality and repo conventions. Spec independently checks the target understanding and implementation. Either can fail while the other passes; keeping their reports separate makes that visible.
