import { main } from './boss/control/cli.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export { main };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code) ? error.code : 'BOSS_CONTROL_FAILED';
    process.stdout.write(`${JSON.stringify({ ok: false, error: code }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
