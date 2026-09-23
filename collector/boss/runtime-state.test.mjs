import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  loadRuntimeState,
  saveRuntimeState,
  selectFair,
  completeRun,
  saveResumeCheckpoint,
  loadResumeCheckpoint,
  removeResumeCheckpoint,
  normalizeRuntimeState,
  runWithPersistentCdpRetry,
  recordDetailFailure,
  clearDetailFailures,
  detailTaskDisposition,
  detailRuntimeSummary,
  resumeDetailState,
} from './runtime-state.mjs';

test('fair selection resumes after the prior item and wraps without starvation', () => {
  const values = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const first = selectFair(values, { cursor: null, limit: 2, key: (item) => item.id });
  assert.deepEqual(
    first.selected.map((item) => item.id),
    ['a', 'b'],
  );
  const second = selectFair(values, { cursor: first.cursor, limit: 2, key: (item) => item.id });
  assert.deepEqual(
    second.selected.map((item) => item.id),
    ['c', 'd'],
  );
  const third = selectFair(values, { cursor: second.cursor, limit: 2, key: (item) => item.id });
  assert.deepEqual(
    third.selected.map((item) => item.id),
    ['a', 'b'],
  );
});

test('legacy runtime state gains an empty shared CDP retry budget', () => {
  const migrated = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  assert.deepEqual(migrated.cdpRetry, {
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    exhausted: false,
  });
  assert.deepEqual(migrated.detail, {
    blocked: false,
    blockCode: null,
    blockedAt: null,
    tasks: [],
  });
  assert.equal(migrated.version, 2);
});

test('detail retries persist 30 minute, 2 hour and 24 hour backoff before isolation', () => {
  let state = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  const attempts = [
    ['2026-09-21T10:00:00.000Z', '2026-09-21T10:30:00.000Z'],
    ['2026-09-21T10:30:00.000Z', '2026-09-21T12:30:00.000Z'],
    ['2026-09-21T12:30:00.000Z', '2026-09-22T12:30:00.000Z'],
  ];
  for (const [at, nextRetryAt] of attempts) {
    state = recordDetailFailure(state, {
      jobId: 'job_a',
      error: 'DETAIL_TAB_CHANGED',
      stage: 'navigate',
      at,
    });
    assert.equal(state.detail.tasks[0].nextRetryAt, nextRetryAt);
    assert.equal(detailTaskDisposition(state, 'job_a', at), 'backoff');
  }
  state = recordDetailFailure(state, {
    jobId: 'job_a',
    error: 'CDP_COMMAND_TIMEOUT',
    stage: 'read',
    at: '2026-09-22T12:30:00.000Z',
  });
  assert.equal(state.detail.tasks[0].status, 'isolated');
  assert.equal(detailTaskDisposition(state, 'job_a', '2026-09-23T12:30:00.000Z'), 'isolated');
  assert.equal(
    detailRuntimeSummary(state, { pending: 1, now: '2026-09-23T12:30:00.000Z' }).isolated,
    1,
  );
  state = clearDetailFailures(state, ['job_a'], { updatedAt: '2026-09-23T12:30:01.000Z' });
  assert.equal(detailTaskDisposition(state, 'job_a'), 'ready');
});

test('detail ownership block requires explicit detail resume without clearing job retry', () => {
  let state = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  state = recordDetailFailure(state, {
    jobId: 'job_a',
    error: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
    stage: 'read',
    at: '2026-09-21T10:00:00.000Z',
    block: true,
  });
  assert.equal(
    detailRuntimeSummary(state, { pending: 2, now: '2026-09-21T10:00:00.000Z' }).status,
    'blocked',
  );
  state = resumeDetailState(state, { updatedAt: '2026-09-21T10:01:00.000Z' });
  assert.equal(state.detail.blocked, false);
  assert.equal(state.detail.tasks.length, 1);
  assert.equal(detailTaskDisposition(state, 'job_a', '2026-09-21T10:01:00.000Z'), 'backoff');
});

test('CDP transport retry uses only the persisted 2s, 10s and 30s allowance', async () => {
  const waits = [],
    saved = [];
  let calls = 0;
  const initial = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  const result = await runWithPersistentCdpRetry(initial, {
    operation: async () => {
      calls += 1;
      return { ok: false, report: { error: 'CDP_CONNECTION_CLOSED' } };
    },
    errorOf: (value) => value.report.error,
    wait: async (delay) => waits.push(delay),
    persist: async (state) => saved.push(structuredClone(state)),
    now: () => '2026-09-21T10:00:00.000Z',
  });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [2000, 10_000, 30_000]);
  assert.equal(result.exhausted, true);
  assert.deepEqual(result.state.cdpRetry, {
    attempts: 3,
    nextRetryAt: null,
    lastError: 'CDP_CONNECTION_CLOSED',
    exhausted: true,
  });
  assert.equal(
    saved.some((state) => state.cdpRetry.nextRetryAt === '2026-09-21T10:00:30.000Z'),
    true,
  );
});

test('instance, target, URL and login failures never retry or wait', async () => {
  for (const error of [
    'BROWSER_INSTANCE_CHANGED',
    'TASK_TARGET_MISSING',
    'TASK_TARGET_DRIFTED',
    'LOGIN_REQUIRED',
  ]) {
    const waits = [];
    const initial = normalizeRuntimeState({
      version: 1,
      cursors: { resume: null, detail: null },
      lastRun: null,
      updatedAt: null,
    });
    const result = await runWithPersistentCdpRetry(initial, {
      operation: async () => ({ ok: false, report: { error } }),
      errorOf: (value) => value.report.error,
      wait: async (delay) => waits.push(delay),
    });
    assert.equal(result.retries, 0);
    assert.deepEqual(waits, []);
    assert.equal(result.value.report.error, error);
  }
});

test('a persisted retry deadline is shared by the next command and reset on success', async () => {
  const waits = [],
    saved = [];
  const initial = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
    cdpRetry: {
      attempts: 1,
      nextRetryAt: '2026-09-21T10:00:02.000Z',
      lastError: 'CDP_CONNECT_FAILED',
      exhausted: false,
    },
  });
  const result = await runWithPersistentCdpRetry(initial, {
    operation: async () => ({ ok: true }),
    errorOf: (value) => (value.ok ? null : 'CDP_CONNECT_FAILED'),
    wait: async (delay) => waits.push(delay),
    persist: async (state) => saved.push(structuredClone(state)),
    now: () => '2026-09-21T10:00:01.000Z',
  });
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(result.state.cdpRetry, {
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    exhausted: false,
  });
  assert.equal(saved.at(-1).cdpRetry.attempts, 0);
});

test('thrown CDP transport errors reconnect while thrown semantic errors do not', async () => {
  const initial = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  let calls = 0;
  const recovered = await runWithPersistentCdpRetry(initial, {
    operation: async () => {
      calls += 1;
      if (calls === 1) throw new Error('CDP_SEND_FAILED');
      return 'ok';
    },
    wait: async () => {},
    persist: async () => {},
    now: () => '2026-09-21T10:00:00.000Z',
  });
  assert.equal(recovered.value, 'ok');
  assert.equal(calls, 2);
  await assert.rejects(
    () =>
      runWithPersistentCdpRetry(initial, {
        operation: async () => {
          throw new Error('ACCOUNT_NAMESPACE_CHANGED');
        },
        wait: async () => {},
        persist: async () => {},
      }),
    /ACCOUNT_NAMESPACE_CHANGED/,
  );
});

test('runtime and resume checkpoints are private, atomic and reloadable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-runtime-test-'));
  try {
    let state = await loadRuntimeState(directory);
    state = { ...state, cursors: { resume: 'a', detail: 'b' } };
    state = completeRun(state, {
      runId: randomUUID(),
      status: 'partial',
      error: 'HISTORY_UNAVAILABLE',
      startedAt: '2026-09-21T10:00:00.000Z',
      finishedAt: '2026-09-21T10:00:01.000Z',
      counts: { listObserved: 10 },
      usage: { historyRequests: 2, domSwitches: 0, detailNavigations: 0 },
    });
    const runtimePath = await saveRuntimeState(directory, state);
    assert.equal((await stat(runtimePath)).mode & 0o777, 0o600);
    assert.deepEqual(await loadRuntimeState(directory), state);
    const checkpoint = {
      version: 1,
      capturedAt: '2026-09-21T10:00:01.000Z',
      nextConversationKey: 'c'.repeat(64),
      nextPage: 2,
      observations: [],
      unresolved: [],
      coverage: { requestedConversations: 1 },
      usage: { historyRequests: 2 },
      partial: false,
      error: null,
    };
    const checkpointPath = await saveResumeCheckpoint(directory, checkpoint);
    assert.equal((await stat(checkpointPath)).mode & 0o777, 0o600);
    assert.deepEqual(await loadResumeCheckpoint(directory), checkpoint);
    assert.equal(await removeResumeCheckpoint(directory), true);
    assert.equal(await loadResumeCheckpoint(directory), null);
  } finally {
    await rm(directory, { recursive: true });
  }
});
