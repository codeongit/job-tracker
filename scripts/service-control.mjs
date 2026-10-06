import { open, mkdir, lstat, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  readServiceRuntime,
  readServiceLaunch,
  claimServiceLaunch,
  updateServiceLaunch,
  removeServiceLaunch,
} from './service-runtime.mjs';
import { WorkspaceStore, WorkspaceStoreError } from './workspace-store.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const serviceRoot = join(projectRoot, '.local', 'service');
const workspaceRoot = join(projectRoot, '.local', 'workspace');
const CONTROL_FAILURE_CODES = new Set([
  'SERVICE_ARGUMENTS_INVALID',
  'SERVICE_PORT_INVALID',
  'SERVICE_RUNTIME_INVALID',
  'SERVICE_OWNERSHIP_MISMATCH',
  'SERVICE_SPAWN_FAILED',
  'SERVICE_STOP_FAILED',
]);
export function serviceProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
const elapsed = (startedAt, now) =>
  startedAt ? Math.max(0, Math.round(now() - Date.parse(startedAt))) : null;
function startingStatus(record, now) {
  return {
    running: false,
    starting: true,
    phase: 'starting',
    code: 'SERVICE_STARTING',
    message: '正在启动',
    instanceId: record.instanceId ?? null,
    port: record.port ?? null,
    workspaceId: record.workspaceId ?? null,
    processStartedAt: record.processStartedAt ?? null,
    elapsedMs: elapsed(record.processStartedAt, now),
    progress: record.progress ?? { stage: 'launching' },
  };
}
export async function serviceStatus(
  root = serviceRoot,
  fetcher = fetch,
  { now = Date.now, isProcessAlive = serviceProcessAlive } = {},
) {
  const runtime = await readServiceRuntime(root),
    launch = await readServiceLaunch(root);
  if (launch && (launch.incomplete || launch.instanceId !== runtime?.instanceId)) {
    if (launch.incomplete) return { ...startingStatus(launch, now), blocked: true };
    if (launch.childPid !== null) {
      if (isProcessAlive(launch.childPid)) return startingStatus(launch, now);
      return {
        running: false,
        phase: 'failed',
        code: 'SERVICE_START_EXITED',
        instanceId: launch.instanceId,
        elapsedMs: elapsed(launch.processStartedAt, now),
      };
    }
    if (isProcessAlive(launch.launcherPid)) return startingStatus(launch, now);
    // A crash between spawn and publishing the child PID leaves ownership uncertain.
    // Keep the intent rather than spawn another process or signal an unknown PID.
    return {
      running: false,
      phase: 'failed',
      code: 'SERVICE_LAUNCH_UNCONFIRMED',
      blocked: true,
      instanceId: launch.instanceId,
      elapsedMs: elapsed(launch.processStartedAt, now),
    };
  }
  if (!runtime) return { running: false, code: 'SERVICE_NOT_STARTED' };
  if (runtime.version === 2) {
    const processAlive = isProcessAlive(runtime.pid);
    if (runtime.phase === 'failed')
      return {
        running: false,
        phase: 'failed',
        code: runtime.failureCode,
        instanceId: runtime.instanceId,
        processStartedAt: runtime.processStartedAt,
        elapsedMs: runtime.startupDurationMs ?? elapsed(runtime.processStartedAt, now),
        progress: runtime.progress,
        processAlive,
      };
    if (runtime.phase === 'starting')
      return processAlive
        ? startingStatus(runtime, now)
        : {
            running: false,
            phase: 'failed',
            code: 'SERVICE_START_EXITED',
            instanceId: runtime.instanceId,
            elapsedMs: elapsed(runtime.processStartedAt, now),
          };
  }
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
      phase: 'ready',
      instanceId: runtime.instanceId,
      workspaceId: runtime.workspaceId,
      port: runtime.port,
      tracking: health.tracking || 'stopped',
      protocolVersion: health.protocolVersion,
      storageVersion: health.storageVersion ?? null,
      readyAt: runtime.readyAt ?? runtime.startedAt ?? null,
      processStartedAt: runtime.processStartedAt ?? null,
      startupDurationMs: runtime.startupDurationMs ?? null,
      elapsedMs: runtime.startupDurationMs ?? null,
    };
  } catch {
    return {
      running: false,
      code: 'SERVICE_UNAVAILABLE',
      processAlive: isProcessAlive(runtime.pid),
    };
  }
}
export async function stopService(root = serviceRoot, fetcher = fetch, options = {}) {
  const status = await serviceStatus(root, fetcher, options);
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
  now = Date.now,
  isProcessAlive = serviceProcessAlive,
  waitMs = 30_000,
  pollMs = 150,
  wait = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds)),
} = {}) {
  const statusOptions = { now, isProcessAlive };
  const existing = await serviceStatus(root, fetcher, statusOptions);
  if (existing.running || existing.starting || existing.blocked || existing.processAlive)
    return existing;
  if (existing.code === 'SERVICE_OWNERSHIP_MISMATCH') throw new Error(existing.code);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error('SERVICE_PORT_INVALID');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('SERVICE_RUNTIME_INVALID');
  await chmod(root, 0o700);
  const staleLaunch = await readServiceLaunch(root);
  if (staleLaunch?.childPid && !isProcessAlive(staleLaunch.childPid))
    await removeServiceLaunch(root, staleLaunch.instanceId);
  const launch = {
    version: 1,
    instanceId: randomUUID(),
    launcherPid: process.pid,
    childPid: null,
    port,
    processStartedAt: new Date(now()).toISOString(),
  };
  if (!(await claimServiceLaunch(root, launch))) return serviceStatus(root, fetcher, statusOptions);
  const logPath = join(root, 'service.log');
  try {
    const logInfo = await lstat(logPath);
    if (!logInfo.isFile() || logInfo.isSymbolicLink()) throw new Error('SERVICE_RUNTIME_INVALID');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await removeServiceLaunch(root, launch.instanceId);
      throw error;
    }
  }
  let log,
    spawned = false;
  try {
    log = await open(logPath, 'a', 0o600);
    await log.chmod(0o600);
    const child = spawnProcess(
      process.execPath,
      [
        join(projectRoot, 'scripts/serve.mjs'),
        '--port',
        String(port),
        '--launch-id',
        launch.instanceId,
      ],
      { cwd: projectRoot, detached: true, stdio: ['ignore', log.fd, log.fd] },
    );
    await new Promise((accept, reject) => {
      child.once('spawn', accept);
      child.once('error', reject);
    });
    spawned = true;
    child.unref();
    await updateServiceLaunch(root, launch.instanceId, child.pid);
  } catch {
    if (!spawned) {
      await removeServiceLaunch(root, launch.instanceId);
      throw new Error('SERVICE_SPAWN_FAILED');
    }
    const status = await serviceStatus(root, fetcher, statusOptions);
    if (
      status.instanceId === launch.instanceId &&
      (status.running || status.starting || status.phase === 'failed')
    )
      return status;
    // Do not clear an uncertain launched child merely because recording its PID failed.
    return { ...startingStatus(launch, now), code: 'SERVICE_LAUNCH_UNCONFIRMED', blocked: true };
  } finally {
    await log?.close();
  }
  const startupDeadline = now() + waitMs;
  while (now() < startupDeadline) {
    await wait(pollMs);
    const status = await serviceStatus(root, fetcher, statusOptions);
    if (status.running || status.phase === 'failed') return status;
  }
  const status = await serviceStatus(root, fetcher, statusOptions);
  return status.starting
    ? { ...status, message: '正在启动，请稍后运行 pnpm service status。' }
    : status;
}
export async function auditWorkspace({
  root = workspaceRoot,
  createStore = (path) => new WorkspaceStore(path),
} = {}) {
  const store = createStore(root);
  try {
    await store.initialize();
    const result = await store.auditHistory();
    return {
      audited: true,
      revision: result.revision,
      commits: result.commits,
      commands: result.commands,
    };
  } finally {
    await store.close();
  }
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
            : command === 'audit'
              ? await auditWorkspace()
              : null;
    if (!result) throw new Error('SERVICE_ARGUMENTS_INVALID');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof WorkspaceStoreError
        ? error.code
        : CONTROL_FAILURE_CODES.has(error.message)
          ? error.message
          : 'SERVICE_CONTROL_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
