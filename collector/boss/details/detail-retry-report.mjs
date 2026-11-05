import { createHash, randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { BOSS_JOB_ID } from '../../../dist/boss/contracts/job-url.js';

const STAGES = new Set(['create', 'navigate', 'read', 'close']);
const URL_KINDS = new Set(['target', 'other_job', 'other', 'blank', 'login_or_security']);
const BOOLEAN_FIELDS = [
  'sameCanonicalJob',
  'queryPresent',
  'fragmentPresent',
  'documentReady',
  'navigationPending',
  'titlePresent',
  'titleParsed',
  'titleStable',
];
const COUNT_FIELDS = [
  'attemptedJobs',
  'accepted',
  'candidates',
  'failures',
  'skipped',
  'remaining',
];
const fail = () => {
  throw new Error('DETAIL_DIAGNOSTIC_SAVE_FAILED');
};
const code = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,100}$/.test(value);
const timestamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const safeFailure = () =>
  Object.assign(new Error('DETAIL_DIAGNOSTIC_SAVE_FAILED'), {
    code: 'DETAIL_DIAGNOSTIC_SAVE_FAILED',
  });

async function writeReport(directory, name, value) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail();
  const handle = await open(join(directory, name), 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const barrier = await open(directory, 'r');
  try {
    await barrier.sync();
  } finally {
    await barrier.close();
  }
}

function priorTasks(accountNamespace, tasks) {
  if (
    !/^boss-geek:[a-f0-9]{64}$/.test(accountNamespace ?? '') ||
    !Array.isArray(tasks) ||
    tasks.length < 1 ||
    tasks.length > 20
  )
    fail();
  const jobDigests = new Map();
  const summaries = tasks.map((task) => {
    if (
      !task ||
      typeof task.jobId !== 'string' ||
      !BOSS_JOB_ID.test(task.jobId) ||
      jobDigests.has(task.jobId) ||
      task.attempts !== 4 ||
      task.status !== 'isolated' ||
      task.nextRetryAt !== null ||
      !code(task.lastError) ||
      !STAGES.has(task.lastStage) ||
      !timestamp(task.lastAttemptAt)
    )
      fail();
    const jobDigest = createHash('sha256')
      .update(JSON.stringify([accountNamespace, task.jobId]))
      .digest('hex');
    jobDigests.set(task.jobId, jobDigest);
    return {
      jobDigest,
      attempts: task.attempts,
      status: task.status,
      lastError: task.lastError,
      lastStage: task.lastStage,
      lastAttemptAt: task.lastAttemptAt,
      nextRetryAt: task.nextRetryAt,
    };
  });
  return { jobDigests, summaries };
}

function safeResult(result, jobDigests) {
  const digest = (jobId) => {
    const value = jobDigests.get(jobId);
    if (!value) fail();
    return value;
  };
  const ids = (items) => {
    if (!Array.isArray(items)) fail();
    return [...new Set(items.map((item) => digest(item.jobId)))];
  };
  const outcome = (item) => {
    if (!item || !code(item.code) || !STAGES.has(item.stage)) fail();
    return { jobDigest: digest(item.jobId), code: item.code, stage: item.stage };
  };
  const counts = Object.fromEntries(
    COUNT_FIELDS.map((field) => {
      const value = result?.counts?.[field];
      if (!nonnegative(value)) fail();
      return [field, value];
    }),
  );
  if (!Array.isArray(result.diagnostics) || !Array.isArray(result.failures)) fail();
  const diagnostics = result.diagnostics.map((item) => {
    if (
      !item ||
      (item.code !== null && !code(item.code)) ||
      !STAGES.has(item.stage) ||
      !nonnegative(item.readCount) ||
      item.readCount > 200 ||
      (item.urlKind !== null && !URL_KINDS.has(item.urlKind))
    )
      fail();
    const booleans = Object.fromEntries(
      BOOLEAN_FIELDS.map((field) => {
        const value = item[field];
        if (value !== null && typeof value !== 'boolean') fail();
        return [field, value];
      }),
    );
    return {
      jobDigest: digest(item.jobId),
      code: item.code,
      stage: item.stage,
      readCount: item.readCount,
      urlKind: item.urlKind,
      ...booleans,
    };
  });
  return {
    targetDigests: [...jobDigests.values()],
    counts,
    halted: result.halted ? outcome(result.halted) : null,
    failures: result.failures.map(outcome),
    successful: [...new Set([...ids(result.observations), ...ids(result.candidates)])],
    remaining: ids(result.remaining),
    skipped: ids(result.skipped),
    diagnostics,
  };
}

/** Prepare immutable, redacted evidence before any detail retry accesses CDP. */
export async function createDetailRetryReport(directory, { accountNamespace, tasks } = {}) {
  try {
    const { jobDigests, summaries } = priorTasks(accountNamespace, tasks);
    const attemptId = randomUUID();
    const header = (phase) => ({
      format: 'job-tracker-detail-retry',
      version: 1,
      attemptId,
      phase,
      recordedAt: new Date().toISOString(),
    });
    await writeReport(directory, `detail-retry-${attemptId}-prepared.json`, {
      ...header('prepared'),
      tasks: summaries,
    });
    return {
      attemptId,
      async beforeCleanup(result) {
        try {
          const summary = safeResult(result, jobDigests);
          await writeReport(directory, `detail-retry-${attemptId}-before-cleanup.json`, {
            ...header('before_cleanup'),
            ...summary,
          });
        } catch {
          throw safeFailure();
        }
      },
    };
  } catch {
    throw safeFailure();
  }
}
