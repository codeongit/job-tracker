import { mkdir, open, readFile, lstat, chmod, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export async function readServiceRuntime(root) {
  try {
    const path = join(root, 'runtime.json'),
      info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
      throw new Error('SERVICE_RUNTIME_INVALID');
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (
      value.version !== 1 ||
      !UUID.test(value.instanceId) ||
      !UUID.test(value.workspaceId) ||
      !Number.isSafeInteger(value.port) ||
      value.port < 1024 ||
      value.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(value.controlToken) ||
      Object.hasOwn(value, 'processStartedAt') !== Object.hasOwn(value, 'startupDurationMs') ||
      (Object.hasOwn(value, 'startupDurationMs') &&
        (typeof value.processStartedAt !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.processStartedAt) ||
          !Number.isFinite(Date.parse(value.processStartedAt)) ||
          !Number.isSafeInteger(value.startupDurationMs) ||
          value.startupDurationMs < 0))
    )
      throw new Error('SERVICE_RUNTIME_INVALID');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function saveServiceRuntime(root, value) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('SERVICE_RUNTIME_INVALID');
  await chmod(root, 0o700);
  const path = join(root, 'runtime.json'),
    temporary = join(root, `.runtime-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function removeServiceRuntime(root, instanceId) {
  const current = await readServiceRuntime(root);
  if (current?.instanceId === instanceId) await unlink(join(root, 'runtime.json'));
}
