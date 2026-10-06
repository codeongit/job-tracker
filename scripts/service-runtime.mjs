import { mkdir, open, readFile, lstat, chmod, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PHASES = new Set(['starting', 'ready', 'failed']);
export const SERVICE_STARTUP_STAGES = new Set([
  'launching',
  'config_loading',
  'history_validation',
  'catalog_validation',
  'head_validation',
  'workspace_ready',
  'inbox_initialization',
  'controller_initialization',
  'listening',
  'ready',
]);
export const SERVICE_FAILURE_CODES = new Set([
  'SERVICE_START_FAILED',
  'SERVICE_CONFIG_INVALID',
  'SERVICE_ARGUMENTS_INVALID',
  'SERVICE_WORKSPACE_INVALID',
  'SERVICE_INBOX_INITIALIZATION_FAILED',
  'SERVICE_CONTROLLER_INITIALIZATION_FAILED',
  'SERVICE_PORT_IN_USE',
  'SERVICE_RUNTIME_SAVE_FAILED',
  'SERVICE_RUNTIME_UNCONFIRMED',
  'SERVICE_SPAWN_FAILED',
]);
const stamp = (value) =>
  typeof value === 'string' && STAMP.test(value) && Number.isFinite(Date.parse(value));
const uuid = (value) => typeof value === 'string' && UUID.test(value);
const pid = (value) => Number.isSafeInteger(value) && value > 0;
const port = (value) => Number.isSafeInteger(value) && value >= 1024 && value <= 65535;
const invalid = () => {
  throw new Error('SERVICE_RUNTIME_INVALID');
};
function fields(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    invalid();
}
function validateProgress(value) {
  fields(value, ['stage', 'completed', 'total']);
  if (!SERVICE_STARTUP_STAGES.has(value.stage)) invalid();
  for (const key of ['completed', 'total'])
    if (Object.hasOwn(value, key) && (!Number.isSafeInteger(value[key]) || value[key] < 0))
      invalid();
  if (
    Object.hasOwn(value, 'completed') &&
    Object.hasOwn(value, 'total') &&
    value.completed > value.total
  )
    invalid();
}
function validateRuntime(value) {
  if (
    !value ||
    ![1, 2].includes(value.version) ||
    !uuid(value.instanceId) ||
    !port(value.port) ||
    typeof value.controlToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.controlToken)
  )
    invalid();
  if (value.version === 1) {
    fields(value, [
      'version',
      'instanceId',
      'workspaceId',
      'pid',
      'port',
      'controlToken',
      'startedAt',
      'processStartedAt',
      'startupDurationMs',
    ]);
    if (
      !uuid(value.workspaceId) ||
      (Object.hasOwn(value, 'pid') && !pid(value.pid)) ||
      (Object.hasOwn(value, 'startedAt') && !stamp(value.startedAt)) ||
      Object.hasOwn(value, 'processStartedAt') !== Object.hasOwn(value, 'startupDurationMs') ||
      (Object.hasOwn(value, 'startupDurationMs') &&
        (!stamp(value.processStartedAt) ||
          !Number.isSafeInteger(value.startupDurationMs) ||
          value.startupDurationMs < 0))
    )
      invalid();
    return value;
  }
  fields(value, [
    'version',
    'instanceId',
    'workspaceId',
    'pid',
    'port',
    'controlToken',
    'phase',
    'processStartedAt',
    'readyAt',
    'startupDurationMs',
    'progress',
    'failureCode',
  ]);
  if (
    !pid(value.pid) ||
    !PHASES.has(value.phase) ||
    !stamp(value.processStartedAt) ||
    (value.workspaceId !== null && !uuid(value.workspaceId)) ||
    (value.readyAt !== null && !stamp(value.readyAt)) ||
    (value.startupDurationMs !== null &&
      (!Number.isSafeInteger(value.startupDurationMs) || value.startupDurationMs < 0)) ||
    (value.phase === 'ready' &&
      (!uuid(value.workspaceId) || value.readyAt === null || value.startupDurationMs === null)) ||
    (value.phase === 'starting' && (value.readyAt !== null || value.startupDurationMs !== null)) ||
    (value.phase === 'failed'
      ? !SERVICE_FAILURE_CODES.has(value.failureCode)
      : value.failureCode !== null)
  )
    invalid();
  validateProgress(value.progress);
  return value;
}
async function privateDirectory(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) invalid();
  await chmod(root, 0o700);
}
async function readPrivateJson(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) invalid();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    invalid();
  }
}
async function syncDirectory(root) {
  const handle = await open(root, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function replacePrivateJson(root, filename, value) {
  const path = join(root, filename),
    temporary = join(root, `.runtime-${randomUUID()}`);
  try {
    const info = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink())) invalid();
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(root);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function readServiceRuntime(root) {
  const value = await readPrivateJson(join(root, 'runtime.json'));
  return value === undefined ? null : validateRuntime(value);
}
export async function saveServiceRuntime(root, value) {
  validateRuntime(value);
  await privateDirectory(root);
  await replacePrivateJson(root, 'runtime.json', value);
}
export async function removeServiceRuntime(root, instanceId) {
  const current = await readServiceRuntime(root);
  if (current?.instanceId === instanceId) {
    await unlink(join(root, 'runtime.json'));
    await syncDirectory(root);
  }
}
function validateLaunch(value) {
  fields(value, ['version', 'instanceId', 'launcherPid', 'childPid', 'port', 'processStartedAt']);
  if (
    value.version !== 1 ||
    !uuid(value.instanceId) ||
    !pid(value.launcherPid) ||
    (value.childPid !== null && !pid(value.childPid)) ||
    !port(value.port) ||
    !stamp(value.processStartedAt)
  )
    invalid();
  return value;
}
export async function readServiceLaunch(root) {
  const directory = join(root, 'launch.lock');
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const value = await readPrivateJson(join(directory, 'owner.json'));
  // A competing starter may have acquired the directory but not published its intent yet.
  return value === undefined ? { incomplete: true } : validateLaunch(value);
}
export async function claimServiceLaunch(root, value) {
  validateLaunch(value);
  await privateDirectory(root);
  const directory = join(root, 'launch.lock');
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  await replacePrivateJson(directory, 'owner.json', value);
  await syncDirectory(root);
  return true;
}
export async function updateServiceLaunch(root, instanceId, childPid) {
  if (!pid(childPid)) invalid();
  const current = await readServiceLaunch(root);
  if (current?.instanceId === instanceId)
    await replacePrivateJson(join(root, 'launch.lock'), 'owner.json', { ...current, childPid });
}
export async function removeServiceLaunch(root, instanceId) {
  const current = await readServiceLaunch(root);
  if (current?.instanceId === instanceId) {
    await unlink(join(root, 'launch.lock', 'owner.json'));
    await rmdir(join(root, 'launch.lock'));
    await syncDirectory(root);
  }
}
