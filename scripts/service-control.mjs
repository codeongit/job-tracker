import { open, mkdir, lstat, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readServiceRuntime } from './service-runtime.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const serviceRoot = join(projectRoot, '.local', 'service');
export async function serviceStatus(root = serviceRoot, fetcher = fetch) {
  const runtime = await readServiceRuntime(root);
  if (!runtime) return { running: false, code: 'SERVICE_NOT_STARTED' };
  try {
    const response = await fetcher(`http://127.0.0.1:${runtime.port}/__local/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const health = await response.json();
    if (
      !response.ok ||
      health.serviceKind !== 'job-tracker-local' ||
      health.instanceId !== runtime.instanceId ||
      health.workspaceId !== runtime.workspaceId
    )
      return { running: false, code: 'SERVICE_OWNERSHIP_MISMATCH' };
    return {
      running: true,
      instanceId: runtime.instanceId,
      workspaceId: runtime.workspaceId,
      port: runtime.port,
      tracking: health.tracking || 'stopped',
      protocolVersion: health.protocolVersion,
    };
  } catch {
    return { running: false, code: 'SERVICE_UNAVAILABLE' };
  }
}
export async function stopService(root = serviceRoot, fetcher = fetch) {
  const status = await serviceStatus(root, fetcher);
  if (!status.running) return status;
  const runtime = await readServiceRuntime(root);
  if (runtime?.instanceId !== status.instanceId) throw new Error('SERVICE_OWNERSHIP_MISMATCH');
  const origin = `http://127.0.0.1:${runtime.port}`;
  const sessionResponse = await fetcher(`${origin}/__local/session`, {
    signal: AbortSignal.timeout(1500),
  });
  const session = await sessionResponse.json();
  if (!sessionResponse.ok || session.instanceId !== runtime.instanceId)
    throw new Error('SERVICE_OWNERSHIP_MISMATCH');
  const response = await fetcher(`${origin}/__local/service/stop`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Job-Tracker-Protocol': '1',
      'X-Job-Tracker-Session': session.session,
    },
    body: JSON.stringify({ instanceId: runtime.instanceId, controlToken: runtime.controlToken }),
    signal: AbortSignal.timeout(3000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.code || 'SERVICE_STOP_FAILED');
  return { stopping: true, instanceId: runtime.instanceId };
}
export async function startService({
  root = serviceRoot,
  port = 4317,
  spawnProcess = spawn,
  fetcher = fetch,
} = {}) {
  const existing = await serviceStatus(root, fetcher);
  if (existing.running) return existing;
  if (existing.code === 'SERVICE_OWNERSHIP_MISMATCH') throw new Error(existing.code);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error('SERVICE_PORT_INVALID');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('SERVICE_RUNTIME_INVALID');
  await chmod(root, 0o700);
  const logPath = join(root, 'service.log');
  try {
    const logInfo = await lstat(logPath);
    if (!logInfo.isFile() || logInfo.isSymbolicLink()) throw new Error('SERVICE_RUNTIME_INVALID');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const log = await open(logPath, 'a', 0o600);
  await log.chmod(0o600);
  try {
    const child = spawnProcess(
      process.execPath,
      [join(projectRoot, 'scripts/serve.mjs'), '--port', String(port)],
      { cwd: projectRoot, detached: true, stdio: ['ignore', log.fd, log.fd] },
    );
    await new Promise((accept, reject) => {
      child.once('spawn', accept);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    await log.close();
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((accept) => setTimeout(accept, 150));
    const status = await serviceStatus(root, fetcher);
    if (status.running) return status;
  }
  return { running: false, code: 'SERVICE_START_NOT_CONFIRMED', log: join(root, 'service.log') };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (args.length) throw new Error('SERVICE_ARGUMENTS_INVALID');
    const result =
      command === 'start'
        ? await startService()
        : command === 'stop'
          ? await stopService()
          : command === 'status'
            ? await serviceStatus()
            : null;
    if (!result) throw new Error('SERVICE_ARGUMENTS_INVALID');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${/^[A-Z_]+$/.test(error.message) ? error.message : 'SERVICE_CONTROL_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
