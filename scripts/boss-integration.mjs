import { main } from './boss/delivery/integration.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export { main };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
