import { main } from './materials/export-jobs.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export { main };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      'EXPORT_JOBS_FAILED: no directory was exported; check the saved snapshot and output permissions.',
    );
    process.exitCode = 1;
  });
}
