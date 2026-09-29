import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { emptyHistoryState, normalizeHistoryState } from './change-history.mjs';

const runtimeName = '.runtime-v3.json';
const legacyRuntimeNames = ['.runtime-v2.json', '.runtime-v1.json'];
const checkpointName = '.resume-checkpoint-v1.json';
const changeCheckpointName = '.change-checkpoint-v1.json';
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const code = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(value);
const retryDelays = [2000, 10_000, 30_000];
const detailRetryDelays = [30 * 60_000, 2 * 60 * 60_000, 24 * 60 * 60_000];
const retryableCdpErrors = new Set([
  'CONNECTION_REQUIRED',
  'CDP_CONNECT_TIMEOUT',
  'CDP_CONNECT_FAILED',
  'CDP_CONNECTION_CLOSED',
  'CDP_SEND_FAILED',
  'CDP_COMMAND_TIMEOUT',
  'CDP_TARGET_LIST_FAILED',
]);

const emptyCdpRetry = () => ({ attempts: 0, nextRetryAt: null, lastError: null, exhausted: false });
const emptyDetailState = () => ({ blocked: false, blockCode: null, blockedAt: null, tasks: [] });

function emptyRuntime() {
  return {
    version: 3,
    cursors: { resume: null, detail: null },
    history: emptyHistoryState(),
    cdpRetry: emptyCdpRetry(),
    detail: emptyDetailState(),
    lastRun: null,
    updatedAt: null,
  };
}

function normalizeDetailState(value) {
  const detail = value ?? emptyDetailState();
  if (
    !detail ||
    typeof detail !== 'object' ||
    Array.isArray(detail) ||
    typeof detail.blocked !== 'boolean' ||
    (detail.blockCode !== null && !code(detail.blockCode)) ||
    (detail.blockedAt !== null && !iso(detail.blockedAt)) ||
    detail.blocked !== Boolean(detail.blockCode) ||
    detail.blocked !== Boolean(detail.blockedAt) ||
    !Array.isArray(detail.tasks) ||
    detail.tasks.length > 1000
  )
    throw new Error('RUNTIME_DETAIL_INVALID');
  const seen = new Set();
  const tasks = detail.tasks
    .map((task) => {
      if (
        !task ||
        typeof task !== 'object' ||
        Array.isArray(task) ||
        !/^[A-Za-z0-9_-]{1,300}$/.test(task.jobId ?? '') ||
        seen.has(task.jobId) ||
        !Number.isSafeInteger(task.attempts) ||
        task.attempts < 1 ||
        task.attempts > 4 ||
        !['backoff', 'isolated'].includes(task.status) ||
        !code(task.lastError) ||
        !['create', 'navigate', 'read', 'close'].includes(task.lastStage) ||
        !iso(task.lastAttemptAt) ||
        (task.nextRetryAt !== null && !iso(task.nextRetryAt)) ||
        (task.status === 'backoff') !== Boolean(task.nextRetryAt) ||
        (task.status === 'isolated' && task.attempts !== 4)
      )
        throw new Error('RUNTIME_DETAIL_INVALID');
      seen.add(task.jobId);
      return {
        jobId: task.jobId,
        attempts: task.attempts,
        status: task.status,
        nextRetryAt: task.nextRetryAt,
        lastError: task.lastError,
        lastStage: task.lastStage,
        lastAttemptAt: task.lastAttemptAt,
      };
    })
    .sort((left, right) => left.jobId.localeCompare(right.jobId));
  return {
    blocked: detail.blocked,
    blockCode: detail.blockCode,
    blockedAt: detail.blockedAt,
    tasks,
  };
}

function normalizeCounts(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path}_INVALID`);
  const output = {};
  for (const [key, current] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,50}$/.test(key) || !Number.isSafeInteger(current) || current < 0) {
      throw new Error(`${path}_INVALID`);
    }
    output[key] = current;
  }
  return output;
}

export function normalizeRuntimeState(value) {
  if (
    !value ||
    ![1, 2, 3].includes(value.version) ||
    !value.cursors ||
    !['resume', 'detail'].every(
      (key) =>
        value.cursors[key] === null ||
        (typeof value.cursors[key] === 'string' &&
          /^[A-Za-z0-9_-]{1,300}$/.test(value.cursors[key])),
    ) ||
    (value.updatedAt !== null && !iso(value.updatedAt))
  )
    throw new Error('RUNTIME_STATE_INVALID');
  const retry = value.cdpRetry ?? emptyCdpRetry();
  if (
    !retry ||
    !Number.isSafeInteger(retry.attempts) ||
    retry.attempts < 0 ||
    retry.attempts > 3 ||
    (retry.nextRetryAt !== null && !iso(retry.nextRetryAt)) ||
    (retry.lastError !== null && !retryableCdpErrors.has(retry.lastError)) ||
    typeof retry.exhausted !== 'boolean' ||
    (retry.exhausted && (retry.attempts !== 3 || retry.nextRetryAt !== null))
  ) {
    throw new Error('RUNTIME_STATE_INVALID');
  }
  let lastRun = null;
  if (value.lastRun !== null) {
    const run = value.lastRun;
    if (
      !run ||
      !/^[a-f0-9-]{36}$/.test(run.runId ?? '') ||
      !['ok', 'partial', 'failed'].includes(run.status) ||
      !iso(run.startedAt) ||
      !iso(run.finishedAt) ||
      Date.parse(run.finishedAt) < Date.parse(run.startedAt) ||
      (run.error !== null && !code(run.error))
    )
      throw new Error('RUNTIME_STATE_INVALID');
    lastRun = {
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error: run.error,
      counts: normalizeCounts(run.counts, 'RUNTIME_COUNTS'),
      usage: normalizeCounts(run.usage, 'RUNTIME_USAGE'),
    };
  }
  return {
    version: 3,
    cursors: { resume: value.cursors.resume, detail: value.cursors.detail },
    history: normalizeHistoryState(value.history ?? emptyHistoryState()),
    cdpRetry: {
      attempts: retry.attempts,
      nextRetryAt: retry.nextRetryAt,
      lastError: retry.lastError,
      exhausted: retry.exhausted,
    },
    detail: normalizeDetailState(value.detail),
    lastRun,
    updatedAt: value.updatedAt,
  };
}

export function detailTaskDisposition(state, jobId, now = new Date().toISOString()) {
  const current = normalizeRuntimeState(state),
    task = current.detail.tasks.find((item) => item.jobId === jobId);
  if (current.detail.blocked) return 'blocked';
  if (!task) return 'ready';
  if (task.status === 'isolated') return 'isolated';
  return Date.parse(task.nextRetryAt) <= Date.parse(now) ? 'ready' : 'backoff';
}

export function recordDetailFailure(state, { jobId, error, stage, at, block = false }) {
  const current = normalizeRuntimeState(state);
  if (
    !/^[A-Za-z0-9_-]{1,300}$/.test(jobId ?? '') ||
    !code(error) ||
    !['create', 'navigate', 'read', 'close'].includes(stage) ||
    !iso(at)
  )
    throw new Error('DETAIL_RETRY_INPUT_INVALID');
  const prior = current.detail.tasks.find((item) => item.jobId === jobId);
  const attempts = Math.min(4, (prior?.attempts ?? 0) + 1);
  const task =
    attempts === 4
      ? {
          jobId,
          attempts,
          status: 'isolated',
          nextRetryAt: null,
          lastError: error,
          lastStage: stage,
          lastAttemptAt: at,
        }
      : {
          jobId,
          attempts,
          status: 'backoff',
          nextRetryAt: new Date(Date.parse(at) + detailRetryDelays[attempts - 1]).toISOString(),
          lastError: error,
          lastStage: stage,
          lastAttemptAt: at,
        };
  const tasks = [...current.detail.tasks.filter((item) => item.jobId !== jobId), task];
  return normalizeRuntimeState({
    ...current,
    detail: {
      blocked: block || current.detail.blocked,
      blockCode: block ? error : current.detail.blockCode,
      blockedAt: block ? at : current.detail.blockedAt,
      tasks,
    },
    updatedAt: at,
  });
}

export function clearDetailFailures(state, jobIds, { updatedAt = null } = {}) {
  const current = normalizeRuntimeState(state),
    ids = new Set(jobIds);
  if ([...ids].some((id) => !/^[A-Za-z0-9_-]{1,300}$/.test(id)))
    throw new Error('DETAIL_RETRY_INPUT_INVALID');
  return normalizeRuntimeState({
    ...current,
    detail: {
      ...current.detail,
      tasks: current.detail.tasks.filter((task) => !ids.has(task.jobId)),
    },
    updatedAt: updatedAt ?? current.updatedAt,
  });
}

export function resumeDetailState(state, { updatedAt = new Date().toISOString() } = {}) {
  const current = normalizeRuntimeState(state);
  if (!iso(updatedAt)) throw new Error('DETAIL_RETRY_INPUT_INVALID');
  return normalizeRuntimeState({
    ...current,
    detail: { ...current.detail, blocked: false, blockCode: null, blockedAt: null },
    updatedAt,
  });
}

export function detailRuntimeSummary(state, { pending = 0, now = new Date().toISOString() } = {}) {
  const current = normalizeRuntimeState(state);
  if (!Number.isSafeInteger(pending) || pending < 0 || !iso(now))
    throw new Error('DETAIL_RETRY_INPUT_INVALID');
  const deferred = current.detail.tasks.filter(
    (task) => task.status === 'backoff' && Date.parse(task.nextRetryAt) > Date.parse(now),
  );
  const isolated = current.detail.tasks.filter((task) => task.status === 'isolated');
  return {
    status: current.detail.blocked ? 'blocked' : deferred.length ? 'waiting_retry' : 'active',
    pending,
    deferred: deferred.length,
    isolated: isolated.length,
    nextRetryAt: deferred.map((task) => task.nextRetryAt).sort()[0] ?? null,
    lastError:
      current.detail.blockCode ??
      [...current.detail.tasks].sort((left, right) =>
        right.lastAttemptAt.localeCompare(left.lastAttemptAt),
      )[0]?.lastError ??
      null,
  };
}

export function isRetryableCdpError(value) {
  return retryableCdpErrors.has(String(value ?? ''));
}

export function clearCdpRetry(state, { updatedAt = null } = {}) {
  const current = normalizeRuntimeState(state);
  return normalizeRuntimeState({
    ...current,
    cdpRetry: emptyCdpRetry(),
    updatedAt: updatedAt ?? current.updatedAt,
  });
}

/**
 * Retries only debug-channel transport failures. Each scheduled retry is
 * persisted before waiting, so separate command invocations share one finite
 * 2s/10s/30s allowance. Semantic browser failures are never retried.
 */
export async function runWithPersistentCdpRetry(
  state,
  {
    operation,
    errorOf = () => null,
    persist = async () => {},
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => new Date().toISOString(),
  } = {},
) {
  if (
    typeof operation !== 'function' ||
    typeof errorOf !== 'function' ||
    typeof persist !== 'function' ||
    typeof wait !== 'function' ||
    typeof now !== 'function'
  )
    throw new TypeError('CDP_RETRY_INPUT_INVALID');
  let current = normalizeRuntimeState(state),
    retries = 0;
  if (current.cdpRetry.exhausted) throw new Error('CDP_RETRY_EXHAUSTED');
  while (true) {
    if (current.cdpRetry.nextRetryAt !== null) {
      const delay = Math.max(0, Date.parse(current.cdpRetry.nextRetryAt) - Date.parse(now()));
      if (delay) await wait(delay);
      current = normalizeRuntimeState({
        ...current,
        cdpRetry: { ...current.cdpRetry, nextRetryAt: null },
        updatedAt: now(),
      });
      await persist(current);
    }
    let value,
      caught = null;
    try {
      value = await operation();
    } catch (error) {
      caught = error;
    }
    const errorCode = String(caught?.message ?? errorOf(value) ?? '');
    if (!errorCode) {
      if (current.cdpRetry.attempts) {
        current = clearCdpRetry(current, { updatedAt: now() });
        await persist(current);
      }
      return { value, state: current, retries };
    }
    if (!isRetryableCdpError(errorCode)) {
      if (current.cdpRetry.attempts) {
        current = clearCdpRetry(current, { updatedAt: now() });
        await persist(current);
      }
      if (caught) throw caught;
      return { value, state: current, retries };
    }
    if (current.cdpRetry.attempts >= retryDelays.length) {
      current = normalizeRuntimeState({
        ...current,
        cdpRetry: { attempts: 3, nextRetryAt: null, lastError: errorCode, exhausted: true },
        updatedAt: now(),
      });
      await persist(current);
      if (caught) throw caught;
      return { value, state: current, retries, exhausted: true };
    }
    const delay = retryDelays[current.cdpRetry.attempts];
    current = normalizeRuntimeState({
      ...current,
      cdpRetry: {
        attempts: current.cdpRetry.attempts + 1,
        nextRetryAt: new Date(Date.parse(now()) + delay).toISOString(),
        lastError: errorCode,
        exhausted: false,
      },
      updatedAt: now(),
    });
    await persist(current);
    retries += 1;
  }
}

async function writePrivateJson(directory, name, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('DATA_DIRECTORY_INVALID');
  const path = join(directory, name),
    temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
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

export async function loadRuntimeState(directory) {
  try {
    return normalizeRuntimeState(JSON.parse(await readFile(join(directory, runtimeName), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      for (const name of legacyRuntimeNames) {
        try {
          return normalizeRuntimeState(JSON.parse(await readFile(join(directory, name), 'utf8')));
        } catch (legacyError) {
          if (legacyError.code === 'ENOENT') continue;
          if (legacyError instanceof SyntaxError) throw new Error('RUNTIME_STATE_UNREADABLE');
          throw legacyError;
        }
      }
      return emptyRuntime();
    }
    if (error instanceof SyntaxError) throw new Error('RUNTIME_STATE_UNREADABLE');
    throw error;
  }
}

export async function saveRuntimeState(directory, value) {
  return writePrivateJson(directory, runtimeName, normalizeRuntimeState(value));
}

export function selectFair(values, { cursor = null, limit, key } = {}) {
  if (
    !Array.isArray(values) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    typeof key !== 'function'
  ) {
    throw new TypeError('FAIR_SELECTION_INVALID');
  }
  const items = values.map((item) => ({ item, id: String(key(item) ?? '') }));
  if (
    items.some((entry) => !/^[A-Za-z0-9_-]{1,300}$/.test(entry.id)) ||
    new Set(items.map((entry) => entry.id)).size !== items.length
  )
    throw new TypeError('FAIR_SELECTION_INVALID');
  if (!items.length) return { selected: [], cursor: null };
  const index = items.findIndex((entry) => entry.id === cursor);
  const rotated = index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index + 1)];
  const selected = rotated.slice(0, Math.min(limit, rotated.length));
  return { selected: selected.map((entry) => entry.item), cursor: selected.at(-1)?.id ?? cursor };
}

export function completeRun(
  state,
  { runId, startedAt, finishedAt, status, error = null, counts = {}, usage = {} },
) {
  const current = normalizeRuntimeState(state);
  return normalizeRuntimeState({
    ...current,
    lastRun: { runId, startedAt, finishedAt, status, error, counts, usage },
    updatedAt: finishedAt,
  });
}

function normalizeCheckpoint(value) {
  const keys = [
    'version',
    'capturedAt',
    'nextConversationKey',
    'nextPage',
    'observations',
    'unresolved',
    'coverage',
    'usage',
    'partial',
    'error',
    'completedConversationKey',
    'head',
    'truncated',
    'targetFingerprint',
  ];
  if (value && Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('RESUME_CHECKPOINT_INVALID');

  if (
    !value ||
    ![1, 2].includes(value.version) ||
    !iso(value.capturedAt) ||
    (value.nextConversationKey !== null &&
      !/^[a-f0-9]{64}$/.test(value.nextConversationKey ?? '')) ||
    !Number.isSafeInteger(value.nextPage) ||
    value.nextPage < 0 ||
    value.nextPage > 21 ||
    !Array.isArray(value.observations) ||
    !Array.isArray(value.unresolved) ||
    !value.coverage ||
    !value.usage ||
    !Number.isSafeInteger(value.usage.historyRequests) ||
    typeof value.partial !== 'boolean' ||
    (value.error !== null && !code(value.error)) ||
    (value.completedConversationKey !== undefined &&
      value.completedConversationKey !== null &&
      !/^[a-f0-9]{64}$/.test(value.completedConversationKey)) ||
    (value.head !== undefined &&
      value.head !== null &&
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.head)) ||
    (value.truncated !== undefined && typeof value.truncated !== 'boolean') ||
    (value.targetFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(value.targetFingerprint))
  ) {
    throw new Error('RESUME_CHECKPOINT_INVALID');
  }
  return structuredClone(value);
}

export async function saveResumeCheckpoint(directory, value) {
  return writePrivateJson(directory, checkpointName, normalizeCheckpoint(value));
}

export async function loadResumeCheckpoint(directory) {
  try {
    return normalizeCheckpoint(JSON.parse(await readFile(join(directory, checkpointName), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('RESUME_CHECKPOINT_UNREADABLE');
    throw error;
  }
}

export async function removeResumeCheckpoint(directory) {
  try {
    await unlink(join(directory, checkpointName));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function saveChangeCheckpoint(directory, value) {
  return writePrivateJson(directory, changeCheckpointName, normalizeCheckpoint(value));
}

export async function loadChangeCheckpoint(directory) {
  try {
    return normalizeCheckpoint(
      JSON.parse(await readFile(join(directory, changeCheckpointName), 'utf8')),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('RESUME_CHECKPOINT_UNREADABLE');
    throw error;
  }
}

export async function removeChangeCheckpoint(directory) {
  try {
    await unlink(join(directory, changeCheckpointName));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
