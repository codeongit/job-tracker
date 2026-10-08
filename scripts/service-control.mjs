import { open, mkdir, lstat, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
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
  SERVICE_FAILURE_CODES,
  SERVICE_STARTUP_STAGES,
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
const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_RETRY_DELAY_MS = 200;
const HEALTH_START_BUDGET_MS = 2 * HEALTH_TIMEOUT_MS + HEALTH_RETRY_DELAY_MS;
const HEALTH_MESSAGES = {
  timeout: '本机服务健康检查超时，当前尚未确认服务可用。',
  connection_refused: '本机服务端口拒绝连接，当前尚未确认服务可用。',
  permission_denied: '当前执行环境不允许连接本机服务，请在宿主机终端核对。',
  invalid_response: '本机服务健康响应格式无效，当前尚未确认服务身份。',
  http_error: '本机服务健康检查返回异常 HTTP 状态，当前尚未确认服务身份。',
  identity_mismatch: '端口响应与记录的服务身份不一致，已停止本次操作。',
  transport_error: '本机服务连接失败，具体传输原因未知；请在宿主机终端核对。',
};
const TRANSIENT_HEALTH_REASONS = new Set(['timeout', 'connection_refused']);
function transportReason(error, signal) {
  if (signal.aborted || error?.name === 'TimeoutError') return 'timeout';
  const causes = Array.isArray(error?.cause?.errors) ? error.cause.errors : [];
  const codes = [error?.code, error?.cause?.code, ...causes.map((e) => e?.code)];
  if (codes.some((code) => ['EPERM', 'EACCES'].includes(code))) return 'permission_denied';
  if (codes.some((code) => ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)))
    return 'timeout';
  if (codes.includes('ECONNREFUSED')) return 'connection_refused';
  return 'transport_error';
}
async function probeHealth(runtime, fetcher, now, timeoutMs) {
  const started = now(),
    signal = AbortSignal.timeout(timeoutMs);
  let response, health;
  const result = (reason, value) => ({
    healthCheck: {
      reason,
      durationMs: Math.max(0, Math.round(now() - started)),
      timeoutMs,
      attempts: 1,
      ...(Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599
        ? { httpStatus: response.status }
        : {}),
    },
    ...(value ? { health: value } : {}),
  });
  try {
    response = await fetcher(`http://127.0.0.1:${runtime.port}/__local/health`, { signal });
  } catch (error) {
    return result(transportReason(error, signal));
  }
  if (!response || typeof response.ok !== 'boolean' || typeof response.json !== 'function')
    return result('invalid_response');
  if (!response.ok) return result('http_error');
  try {
    health = await response.json();
  } catch (error) {
    return result(
      signal.aborted || error?.name === 'TimeoutError' ? 'timeout' : 'invalid_response',
    );
  }
  if (!health || typeof health !== 'object' || Array.isArray(health))
    return result('invalid_response');
  if (
    health.serviceKind !== 'job-tracker-local' ||
    health.instanceId !== runtime.instanceId ||
    health.workspaceId !== runtime.workspaceId
  )
    return result('identity_mismatch');
  return result('ok', health);
}
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
  {
    now = Date.now,
    isProcessAlive = serviceProcessAlive,
    healthTimeoutMs = HEALTH_TIMEOUT_MS,
  } = {},
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
        port: runtime.port,
        pid: runtime.pid,
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
  if (
    !Number.isInteger(healthTimeoutMs) ||
    healthTimeoutMs < 1 ||
    healthTimeoutMs > HEALTH_TIMEOUT_MS
  )
    throw new Error('SERVICE_ARGUMENTS_INVALID');
  const { health, healthCheck } = await probeHealth(runtime, fetcher, now, healthTimeoutMs);
  const metadata = {
    instanceId: runtime.instanceId,
    workspaceId: runtime.workspaceId,
    port: runtime.port,
    pid: runtime.pid ?? null,
    recordedPhase: runtime.phase ?? null,
    processStartedAt: runtime.processStartedAt ?? null,
    readyAt: runtime.readyAt ?? runtime.startedAt ?? null,
    startupDurationMs: runtime.startupDurationMs ?? null,
    elapsedMs: runtime.startupDurationMs ?? null,
    healthCheck,
  };
  if (health)
    return {
      ...metadata,
      running: true,
      phase: 'ready',
      tracking: ['stopped', 'running', 'paused', 'disabled'].includes(health.tracking)
        ? health.tracking
        : health.tracking == null
          ? 'stopped'
          : 'unknown',
      protocolVersion: Number.isSafeInteger(health.protocolVersion) ? health.protocolVersion : null,
      storageVersion: Number.isSafeInteger(health.storageVersion) ? health.storageVersion : null,
      appVersion:
        typeof health.appVersion === 'string' &&
        /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(health.appVersion)
          ? health.appVersion
          : null,
      sshConfigured: typeof health.sshConfigured === 'boolean' ? health.sshConfigured : null,
    };
  return {
    ...metadata,
    running: false,
    code: ['http_error', 'identity_mismatch'].includes(healthCheck.reason)
      ? 'SERVICE_OWNERSHIP_MISMATCH'
      : 'SERVICE_UNAVAILABLE',
    processAlive: isProcessAlive(runtime.pid),
    message: HEALTH_MESSAGES[healthCheck.reason],
  };
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
async function recordStartDiagnostic(root, status, now) {
  let handle;
  try {
    const directory = await lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    await chmod(root, 0o700);
    const path = join(root, 'service.log');
    const info = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink())) return false;
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    if (!(await handle.stat()).isFile()) return false;
    await handle.chmod(0o600);
    const code =
      CONTROL_FAILURE_CODES.has(status.code) ||
      SERVICE_FAILURE_CODES.has(status.code) ||
      [
        'SERVICE_UNAVAILABLE',
        'SERVICE_START_EXITED',
        'SERVICE_LAUNCH_UNCONFIRMED',
        'SERVICE_STARTING',
      ].includes(status.code)
        ? status.code
        : 'SERVICE_CONTROL_FAILED';
    const check = status.healthCheck;
    const integer = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    await handle.writeFile(
      `${JSON.stringify({
        event: 'service_start_diagnostic',
        at: new Date(now()).toISOString(),
        code,
        reason: Object.hasOwn(HEALTH_MESSAGES, check?.reason ?? '') ? check.reason : null,
        port: integer(status.port),
        pid: integer(status.pid),
        processAlive: typeof status.processAlive === 'boolean' ? status.processAlive : null,
        durationMs: integer(check?.durationMs),
        attempts: integer(check?.attempts),
        httpStatus: integer(check?.httpStatus),
        recordedPhase: ['starting', 'ready', 'failed'].includes(
          status.recordedPhase ?? status.phase,
        )
          ? (status.recordedPhase ?? status.phase)
          : null,
        stage: SERVICE_STARTUP_STAGES.has(status.progress?.stage) ? status.progress.stage : null,
      })}\n`,
    );
    await handle.sync();
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function startService(options = {}) {
  const root = options.root ?? serviceRoot,
    now = options.now ?? Date.now;
  try {
    const status = await startServiceOperation(options);
    if (status.code === 'SERVICE_OWNERSHIP_MISMATCH')
      throw Object.assign(new Error(status.code), { status });
    if (!status.running && (!status.starting || status.blocked))
      return { ...status, diagnosticSaved: await recordStartDiagnostic(root, status, now) };
    return status;
  } catch (error) {
    const status = error?.status ?? { code: error?.message };
    const diagnosticSaved = await recordStartDiagnostic(root, status, now);
    if (error?.status) error.status = { ...status, diagnosticSaved };
    throw error;
  }
}

async function startServiceOperation({
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
  // Lifecycle reads do not spend a health attempt. Once a ready process fails
  // its probe, only a transient failure permits one fresh identity check.
  const checkStatus = async (deadline = Infinity) => {
    const started = now();
    const first = await serviceStatus(root, fetcher, statusOptions);
    if (
      first.running ||
      !first.processAlive ||
      !TRANSIENT_HEALTH_REASONS.has(first.healthCheck?.reason)
    )
      return first;
    const probeDeadline = Math.min(deadline, started + HEALTH_START_BUDGET_MS);
    if (probeDeadline - now() <= HEALTH_RETRY_DELAY_MS) return first;
    await wait(HEALTH_RETRY_DELAY_MS);
    const remaining = probeDeadline - now();
    if (remaining < 1) return first;
    const second = await serviceStatus(root, fetcher, {
      ...statusOptions,
      healthTimeoutMs: Math.min(HEALTH_TIMEOUT_MS, remaining),
    });
    return second.healthCheck
      ? {
          ...second,
          healthCheck: {
            ...second.healthCheck,
            attempts: 2,
            durationMs: Math.max(0, Math.round(now() - started)),
          },
        }
      : second;
  };
  const existing = await checkStatus();
  if (existing.code === 'SERVICE_OWNERSHIP_MISMATCH') return existing;
  if (existing.running || existing.starting || existing.blocked || existing.processAlive)
    return existing;
  if (existing.healthCheck && existing.healthCheck.reason !== 'connection_refused')
    return { ...existing, blocked: true };
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
  if (!(await claimServiceLaunch(root, launch))) return checkStatus();
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
    const status = await checkStatus();
    if (status.code === 'SERVICE_OWNERSHIP_MISMATCH') return status;
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
    await wait(Math.min(pollMs, startupDeadline - now()));
    const status = await checkStatus(startupDeadline);
    if (status.running || status.phase === 'failed' || status.healthCheck) return status;
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
    process.stderr.write(`${error.status?.code === code ? JSON.stringify(error.status) : code}\n`);
    process.exitCode = 1;
  }
}
