# Project boundaries

- This repository contains publicly shareable interface code. Never add real job records, resume files, private repository content, or credentials to tracked files or `dist/`.
- Personal data lives in IndexedDB and a user-selected private GitHub repository. Local source configuration belongs in ignored `.local/config.json`.
- Keep GitHub writes limited to the configured JSON path. Verify the repository is private and the branch exists before first-time initialization.
- Never replace unknown/invalid remote data with empty data. Preserve pending local edits, deletion markers, and upload-time conflicts.
- Keep tokens in page memory only. Do not persist them, include them in exports, log them, or inject them at build time.
- Local SSH sync must use a fixed server-side target, a separate ignored bare cache, loopback binding, Host/Origin checks, and random session authorization. Never read or expose private key material, operate on the user's Obsidian checkout, or force-push. Verify the commit changes only the configured JSON path.
- Run `pnpm verify` before release. Browser regression uses temporary profiles, a dist-only static server, and mocked external APIs; never point it at the user's running workspace or private GitHub data.
- Deploy only `dist/`. Publishing a source repository and publishing personal records are separate actions.

- Start with docs/ARCHITECTURE.md, docs/DATA_AND_RECOVERY.md, and docs/MAINTENANCE.md for module boundaries, migrations, recovery semantics, and release steps.
- Update package.json and dist/version.js together and record behavior changes in CHANGELOG.md. Use Node24 and the pinned pnpm/lockfile.
- Unknown data fields or future versions must stop writes, never silently disappear. Migrate data/base/pending together and preserve the old workspace in the same transaction.
- Restore is a new local edit: keep the current baseline and tombstone omitted records. Pending backups must preserve both sides; do not treat missing backup content as empty data.
- Snapshot creation failure must abort the paired edit. Emergency raw export must remain available even when validation fails or data exceeds the sync limit.
- Check final serialized UTF-8 bytes before all remote writes. Read SSH stdout as bytes, then decode strictly. Never log raw private Git output.
- Use pnpm format and format:check; dist contains authored source, not generated build output. Keep view rendering, persistence, and pure data rules in their corresponding modules.
