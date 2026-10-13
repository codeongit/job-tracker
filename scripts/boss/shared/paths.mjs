import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Anchor to the source checkout, never the invoking process's current directory.
export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const defaultConfigPath = join(projectRoot, '.local', 'config.json');
export const defaultInboxRoot = join(projectRoot, '.local', 'boss-integration');
export const defaultTrackerRoot = join(projectRoot, 'collector', 'boss');
export const defaultTrackerDataRoot = join(projectRoot, '.local', 'boss-collector');
export const integrationScript = join(projectRoot, 'scripts', 'boss-integration.mjs');
