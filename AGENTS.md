# Project boundaries

- Read [docs/DECISIONS.md](docs/DECISIONS.md) first for accepted decisions, their rationale, and review triggers. When changing a key decision, append a new numbered entry with its source and supersession links; retain the old rationale. New user instructions take precedence over older decisions.

- This repository contains publicly shareable interface code. Never add real job records, resume files, private repository content, or credentials to tracked files or `dist/`.
- Personal data lives in IndexedDB and a user-selected private GitHub repository. Local source configuration belongs in ignored `.local/config.json`.
- Keep GitHub writes limited to the configured JSON path. Verify the repository is private and the branch exists before first-time initialization.
- Never replace unknown/invalid remote data with empty data. Preserve pending local edits, deletion markers, and upload-time conflicts.
- Keep tokens in page memory only. Do not persist them, include them in exports, log them, or inject them at build time.
- Local SSH sync must use a fixed server-side target, a separate ignored bare cache, loopback binding, Host/Origin checks, and random session authorization. Never read or expose private key material, operate on the user's Obsidian checkout, or force-push. Verify the commit changes only the configured JSON path.
- Real-browser testing is owned by the user/manual tester (D017), including Playwright/headless browsers and browser-control tools. Unless the user explicitly delegates it later, agents must not launch or control browsers, install browser dependencies, or request browser-testing permissions. Agents run relevant non-browser tests, `pnpm check`, and `pnpm format:check`; before release, run the full `pnpm test` suite. Hand off a concise manual checklist and report browser acceptance as pending until the user confirms it.
- Do not run `pnpm verify` locally as an agent: it includes `pnpm test:browser`. Existing browser scripts and CI remain available and unchanged; CI results do not replace manual acceptance. Browser regression uses temporary profiles, a dist-only static server, and mocked external APIs; never point it at the user's running workspace or private GitHub data.
- Deploy only `dist/`. Publishing a source repository and publishing personal records are separate actions.

- Start with docs/ARCHITECTURE.md, docs/DATA_AND_RECOVERY.md, and docs/MAINTENANCE.md for module boundaries, migrations, recovery semantics, and release steps.
- Update package.json and dist/version.js together and record behavior changes in CHANGELOG.md. Use Node24 and the pinned pnpm/lockfile.
- Unknown data fields or future versions must stop writes, never silently disappear. Migrate data/base/pending together and preserve the old workspace in the same transaction.
- Restore is a new local edit: keep the current baseline and tombstone omitted records. Pending backups must preserve both sides; do not treat missing backup content as empty data.
- Snapshot creation failure must abort the paired edit. Emergency raw export must remain available even when validation fails or data exceeds the sync limit.
- Check final serialized UTF-8 bytes before all remote writes. Read SSH stdout as bytes, then decode strictly. Never log raw private Git output.
- Use pnpm format and format:check; dist contains authored source, not generated build output. Keep view rendering, persistence, and pure data rules in their corresponding modules.

- Drafts contain only explicitly allowed job/task/activity fields. Never auto-submit drafts or persist settings/PATs. Resume with a fresh ID; clear only the submitted immutable revision. A draft-cleanup failure must not turn a committed record into a failed save.
- Prepare and preflight all imported drafts before restoring the workspace; roll back prepared copies on failure. Keep both data and conflict state in full backups.
- Disk backups stay in ignored `.local/backups/`, independent of SSH and browser clearing. Keep daily first snapshots and atomic latest replacement; test only with temporary directories and synthetic data.
