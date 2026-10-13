# Domain docs

This is a single-context repository. `CONTEXT.md` at the repo root defines domain terms. `docs/adr/` holds the full numbered decision history; [its README](../adr/README.md) is the sole index.

## Before exploring

- Read the [ADR index](../adr/README.md) and relevant ADRs for accepted decisions, rationale, supersession, and review triggers.
- Read `CONTEXT.md` for the relevant domain language.
- Read relevant parts of `docs/ARCHITECTURE.md`, `docs/DATA_AND_RECOVERY.md`, and `docs/MAINTENANCE.md` for current behavior.
- For BOSS behavior, modules/contracts, or commands/troubleshooting, read [DESIGN](../boss/DESIGN.md), [IMPLEMENTATION](../boss/IMPLEMENTATION.md), or [OPERATIONS](../boss/OPERATIONS.md) respectively. Follow the [documentation maintenance workflow](change-workflow.md#文档影响与维护).

When a key decision changes, add the next numbered ADR with its source and supersession links, retain the old ADR, and update the index. Do not rewrite the old rationale. New user instructions take precedence over older decisions.

Use terms defined in `CONTEXT.md` when naming concepts in issues, proposals, and code. Keep implementation choices in ADRs and current behavior in the operational docs, not in the glossary. Surface conflicts with existing decisions explicitly.
