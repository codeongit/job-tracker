# Domain docs

This is a single-context repository. Engineering skills use `CONTEXT.md` at the repo root for domain terms and `docs/adr/` for new ADRs.

## Before exploring

- Read `docs/DECISIONS.md` first. Its numbered decisions and supersession links remain authoritative for existing project choices.
- Read relevant parts of `docs/ARCHITECTURE.md`, `docs/DATA_AND_RECOVERY.md`, and `docs/MAINTENANCE.md`.
- Read root `CONTEXT.md` and relevant ADRs in `docs/adr/` when they exist.

Do not create `CONTEXT.md` or ADRs just to fill this layout. Add them when domain terms or a new decision need recording. A new ADR must not silently replace an existing numbered decision; follow the update rules in `docs/DECISIONS.md`.

Use terms defined in `CONTEXT.md` when naming concepts in issues, proposals, and code. Surface conflicts with existing decisions rather than silently overriding them.
