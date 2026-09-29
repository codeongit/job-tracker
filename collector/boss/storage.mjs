import { mkdir, readdir, readFile, open, rename, unlink, rmdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9-]{36}\.json$/;
export async function latest(directory) {
  let names;
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error('DATA_DIRECTORY_INVALID');
    names = (await readdir(directory)).filter((name) => pattern.test(name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!names.length) return null;
  const path = join(directory, names.at(-1));
  if (!(await lstat(path)).isFile()) throw new Error('SNAPSHOT_FILE_INVALID');
  let envelope;
  try {
    envelope = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('SAVED_SNAPSHOT_UNREADABLE');
  }
  if (
    ![1, 2, 3, 4].includes(envelope.version) ||
    !envelope.state ||
    !envelope.snapshot ||
    !envelope.report
  ) {
    throw new Error('SAVED_SNAPSHOT_INVALID');
  }
  return { path, envelope };
}

const connectionName = '.connection.json';
const connectionKeysV1 = [
  'accountNamespace',
  'connectedAt',
  'kind',
  'nativeTabId',
  'nativeWindowId',
  'page',
  'session',
  'version',
];
const connectionKeysV2 = [
  'accountNamespace',
  'browserInstanceId',
  'browserPort',
  'browserProfile',
  'connectedAt',
  'kind',
  'page',
  'session',
  'taskTargetCreatedByTask',
  'taskTargetId',
  'version',
];

function validateConnection(value) {
  if (value?.version === 2) {
    if (
      typeof value !== 'object' ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(connectionKeysV2) ||
      value.kind !== 'cdp_bound' ||
      !/^boss-tracker-cdp-[a-f0-9]{16}$/.test(value.session ?? '') ||
      !/^19\d{3}$/.test(value.browserPort ?? '') ||
      !/^boss-tracker-profile-[a-f0-9]{16}$/.test(value.browserProfile ?? '') ||
      !/^[a-f0-9]{64}$/.test(value.browserInstanceId ?? '') ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(value.taskTargetId ?? '') ||
      typeof value.taskTargetCreatedByTask !== 'boolean' ||
      value.page !== 'https://www.zhipin.com/web/geek/chat' ||
      typeof value.accountNamespace !== 'string' ||
      !/^boss-geek:[a-f0-9]{64}$/.test(value.accountNamespace) ||
      typeof value.connectedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.connectedAt))
    ) {
      throw new Error('SAVED_CONNECTION_INVALID');
    }
    return structuredClone(value);
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(connectionKeysV1) ||
    !['owned_background', 'persistent_bound', 'cdp_persistent'].includes(value.kind) ||
    typeof value.session !== 'string' ||
    !/^boss-tracker-(?:owned|cdp)-[a-f0-9]{16}$/.test(value.session) ||
    typeof value.nativeTabId !== 'string' ||
    !/^\d+$/.test(value.nativeTabId) ||
    typeof value.nativeWindowId !== 'string' ||
    !/^\d+$/.test(value.nativeWindowId) ||
    typeof value.page !== 'string' ||
    !value.page ||
    value.page.length > 500 ||
    /[\u0000-\u001f]/.test(value.page) ||
    typeof value.accountNamespace !== 'string' ||
    !/^boss-geek:[a-f0-9]{64}$/.test(value.accountNamespace) ||
    typeof value.connectedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.connectedAt))
  ) {
    throw new Error('SAVED_CONNECTION_INVALID');
  }
  return structuredClone(value);
}

export async function loadConnection(directory) {
  const path = join(directory, connectionName);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return { path, connection: validateConnection(JSON.parse(text)) };
  } catch (error) {
    if (error.message === 'SAVED_CONNECTION_INVALID') throw error;
    throw new Error('SAVED_CONNECTION_UNREADABLE');
  }
}

export async function saveConnection(directory, connection) {
  const value = validateConnection(connection);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('DATA_DIRECTORY_INVALID');
  const path = join(directory, connectionName);
  const temporary = join(directory, `.connection-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return path;
}

export async function removeConnection(directory) {
  const path = join(directory, connectionName);
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function lock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('DATA_DIRECTORY_INVALID');
  const lockPath = join(directory, '.capture-lock');
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('CAPTURE_ALREADY_LOCKED');
    throw error;
  }
  return async () => {
    await rmdir(lockPath);
  };
}

// One immutable file commits the snapshot, diff, and next state together.
export async function commit(directory, envelope) {
  const suffix = randomUUID();
  const name = new Date().toISOString().replace(/[:.]/g, '-') + '_' + suffix + '.json';
  const path = join(directory, name);
  const temporary = join(directory, '.' + suffix + '.tmp');
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(envelope, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close();
    try {
      await unlink(temporary);
    } catch {}
    throw error;
  }
  return path;
}
