# Project boundaries

- This repository contains publicly shareable interface code. Never add real job records, resume files, private repository content, or credentials to tracked files or `dist/`.
- Personal data lives in IndexedDB and a user-selected private GitHub repository. Local source configuration belongs in ignored `.local/config.json`.
- Keep GitHub writes limited to the configured JSON path. Verify the repository is private and the branch exists before first-time initialization.
- Never replace unknown/invalid remote data with empty data. Preserve pending local edits, deletion markers, and upload-time conflicts.
- Keep tokens in page memory only. Do not persist them, include them in exports, log them, or inject them at build time.
- Local SSH sync must use a fixed server-side target, a separate ignored bare cache, loopback binding, Host/Origin checks, and random session authorization. Never read or expose private key material, operate on the user's Obsidian checkout, or force-push. Verify the commit changes only the configured JSON path.
- Run `npm test` and `npm run check` after changes affecting data import, storage, or sync. Tests use synthetic records and mock API requests.
- Deploy only `dist/`. Publishing a source repository and publishing personal records are separate actions.
