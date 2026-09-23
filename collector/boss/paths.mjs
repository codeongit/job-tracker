import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const collectorRoot = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(collectorRoot, '..', '..');
const defaultDataRoot = join(projectRoot, '.local', 'boss-collector');

export function collectorDataRoot(environment = process.env) {
  const configured = environment.JOB_TRACKER_BOSS_DATA_ROOT;
  if (configured === undefined || configured === '') return defaultDataRoot;
  if (typeof configured !== 'string' || !isAbsolute(configured) || configured.includes('\0'))
    throw new Error('COLLECTOR_DATA_ROOT_INVALID');
  return resolve(configured);
}

export function accountDataDirectory(account, environment = process.env) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(account ?? '')) throw new Error('ACCOUNT_LABEL_INVALID');
  return join(collectorDataRoot(environment), account);
}

export function browserProfileDirectory(digest, environment = process.env) {
  if (!/^[a-f0-9]{16}$/.test(digest ?? '')) throw new Error('ACCOUNT_DIGEST_INVALID');
  return join(collectorDataRoot(environment), 'cdp', digest);
}
