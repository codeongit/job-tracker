import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fairDetailInputs } from './tracker.mjs';
import { compareLoadedSnapshotsV2, conversationKeyV2 } from './model-v2.mjs';
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

test('fair selection accepts tilde job IDs alongside legacy resume keys', () => {
  const values = ['job_a', 'job~b', 'a'.repeat(64)].map((id) => ({ id }));
  const first = selectFair(values, { cursor: 'job_a', limit: 1, key: (item) => item.id });
  assert.deepEqual(first.selected, [{ id: 'job~b' }]);
  assert.equal(first.cursor, 'job~b');
  const next = selectFair(values, { cursor: first.cursor, limit: 2, key: (item) => item.id });
  assert.deepEqual(
    next.selected.map((item) => item.id),
    ['a'.repeat(64), 'job_a'],
  );
});

test('detail input fairness resumes through legal tilde job IDs', () => {
  const accountNamespace = 'boss-geek:' + 'a'.repeat(64);
  const snapshot = {
    capturedAt: '2026-09-21T03:02:35.881Z',
    scope: 'loaded-chat-list',
    accountNamespace,
    records: ['job_a', 'job~b'].map((jobId, index) => {
      const friendId = String(101 + index);
      return {
        key: conversationKeyV2(accountNamespace, friendId, '0'),
        platformIdentity: { friendId, friendSource: '0', uniqueId: `${friendId}-0` },
        contact: 'Synthetic contact',
        company: 'Synthetic company',
        title: 'Recruiter',
        preview: 'Synthetic preview',
        timeLabel: '昨天',
        unread: null,
        latestMessageId: `message-${friendId}`,
        outgoingReceipt: { status: 'unknown', label: null, source: null },
        jobAssociation: { jobId, detailUrl: `https://www.zhipin.com/job_detail/${jobId}.html` },
        observedJobName: null,
      };
    }),
    coverage: {
      loadedRows: 2,
      loadedDataRows: 2,
      renderedRows: 2,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  };
  const { envelope } = compareLoadedSnapshotsV2(null, snapshot);
  const first = fairDetailInputs(envelope, { cursor: 'job_a', limit: 1 });
  assert.deepEqual(first.selectedIds, ['job~b']);
  assert.equal(first.cursor, 'job~b');
  assert.deepEqual(fairDetailInputs(envelope, { cursor: first.cursor, limit: 1 }).selectedIds, [
    'job_a',
  ]);
  assert.throws(
    () => fairDetailInputs({ ...envelope, unknownField: true }, { limit: 1 }),
    /envelope contains unknown fields/,
  );
});

test('fair IDs and runtime cursors keep the 300 character limit and resume character range', () => {
  const resumeKey = 'A_-'.repeat(100),
    jobId = 'a'.repeat(299) + '~';
  const state = normalizeRuntimeState({
    version: 3,
    cursors: { resume: resumeKey, detail: jobId },
    lastRun: null,
    updatedAt: null,
  });
  assert.deepEqual(state.cursors, { resume: resumeKey, detail: jobId });
  assert.equal(selectFair([resumeKey, jobId], { limit: 2, key: (id) => id }).cursor, jobId);
  for (const id of ['', 'bad id', 'job/id', 'job.id', jobId + 'a']) {
    assert.throws(
      () => selectFair([id], { limit: 1, key: (item) => item }),
      /FAIR_SELECTION_INVALID/,
    );
    assert.throws(
      () => normalizeRuntimeState({ ...state, cursors: { ...state.cursors, detail: id } }),
      /RUNTIME_STATE_INVALID/,
    );
  }
  for (const resume of ['job~a', resumeKey + 'a'])
    assert.throws(
      () => normalizeRuntimeState({ ...state, cursors: { ...state.cursors, resume } }),
      /RUNTIME_STATE_INVALID/,
    );
  assert.throws(() => normalizeRuntimeState({ ...state, version: 4 }), /RUNTIME_STATE_INVALID/);
});

test('tilde detail failures, explicit resume and cursor survive private runtime reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-runtime-tilde-'));
  try {
    let state = await loadRuntimeState(directory);
    state = recordDetailFailure(state, {
      jobId: 'job~a',
      error: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
      stage: 'read',
      at: '2026-09-21T10:00:00.000Z',
      block: true,
    });
    state = { ...state, cursors: { resume: 'a'.repeat(64), detail: 'job~a' } };
    await saveRuntimeState(directory, state);
    const restored = await loadRuntimeState(directory);
    assert.deepEqual(restored, state);
    assert.equal(detailTaskDisposition(restored, 'job~a', '2026-09-21T10:01:00.000Z'), 'blocked');
    state = resumeDetailState(restored, { updatedAt: '2026-09-21T10:01:00.000Z' });
    assert.equal(state.detail.tasks.length, 1);
    assert.equal(detailTaskDisposition(state, 'job~a', '2026-09-21T10:01:00.000Z'), 'backoff');
    assert.deepEqual(
      detailRuntimeSummary(state, {
        pending: 1,
        eligibleJobIds: ['job~a'],
        now: '2026-09-21T10:01:00.000Z',
      }),
      {
        status: 'waiting_retry',
        pending: 1,
        deferred: 1,
        isolated: 0,
        nextRetryAt: '2026-09-21T10:30:00.000Z',
        lastError: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
      },
    );
    assert.equal(detailTaskDisposition(state, 'job~a', '2026-09-21T10:30:00.000Z'), 'ready');
    state = clearDetailFailures(state, ['job~a'], { updatedAt: '2026-09-21T10:30:01.000Z' });
    assert.deepEqual(state.detail.tasks, []);
    assert.equal(state.cursors.detail, 'job~a');
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('detail job IDs accept 300 characters and reject unsupported IDs at every runtime boundary', () => {
  const jobId = 'a'.repeat(299) + '~',
    at = '2026-09-21T10:00:00.000Z';
  const initial = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  const failure = { jobId, error: 'DETAIL_TAB_CHANGED', stage: 'navigate', at };
  const state = recordDetailFailure(initial, failure);
  assert.equal(state.detail.tasks[0].jobId, jobId);
  assert.equal(detailRuntimeSummary(state, { eligibleJobIds: [jobId], now: at }).deferred, 1);
  assert.equal(clearDetailFailures(state, [jobId]).detail.tasks.length, 0);
  for (const id of ['', 'bad id', 'job/id', 'job.id', jobId + 'a']) {
    assert.throws(
      () => recordDetailFailure(initial, { ...failure, jobId: id }),
      /DETAIL_RETRY_INPUT_INVALID/,
    );
    assert.throws(() => clearDetailFailures(initial, [id]), /DETAIL_RETRY_INPUT_INVALID/);
    assert.throws(
      () => detailRuntimeSummary(initial, { eligibleJobIds: [id], now: at }),
      /DETAIL_RETRY_INPUT_INVALID/,
    );
    assert.throws(
      () =>
        normalizeRuntimeState({
          ...state,
          detail: { ...state.detail, tasks: [{ ...state.detail.tasks[0], jobId: id }] },
        }),
      /RUNTIME_DETAIL_INVALID/,
    );
  }
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
  assert.equal(migrated.version, 3);
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

test('detail summary excludes completed jobs without deleting their retry history', () => {
  let state = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  for (let attempt = 0; attempt < 4; attempt += 1)
    state = recordDetailFailure(state, {
      jobId: 'completed_job',
      error: 'DETAIL_TITLE_NOT_READY',
      stage: 'read',
      at: `2026-09-${21 + attempt}T10:00:00.000Z`,
    });
  state = recordDetailFailure(state, {
    jobId: 'missing_job',
    error: 'DETAIL_TAB_CHANGED',
    stage: 'navigate',
    at: '2026-09-24T09:59:00.000Z',
  });
  const before = structuredClone(state);
  assert.deepEqual(
    detailRuntimeSummary(state, {
      pending: 1,
      eligibleJobIds: ['missing_job'],
      now: '2026-09-24T10:00:00.000Z',
    }),
    {
      status: 'waiting_retry',
      pending: 1,
      deferred: 1,
      isolated: 0,
      nextRetryAt: '2026-09-24T10:29:00.000Z',
      lastError: 'DETAIL_TAB_CHANGED',
    },
  );
  assert.equal(detailRuntimeSummary(state, { eligibleJobIds: [] }).lastError, null);
  for (const eligibleJobIds of [[123], [{}], ['']])
    assert.throws(
      () => detailRuntimeSummary(state, { eligibleJobIds }),
      /DETAIL_RETRY_INPUT_INVALID/,
    );
  assert.deepEqual(state, before);
  state = recordDetailFailure(state, {
    jobId: 'completed_job',
    error: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
    stage: 'close',
    at: '2026-09-24T10:01:00.000Z',
    block: true,
  });
  const blocked = detailRuntimeSummary(state, { eligibleJobIds: [] });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.lastError, 'DETAIL_TAB_OWNERSHIP_MISMATCH');
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
    for (const invalid of [
      { ...checkpoint, unknownField: true },
      { ...checkpoint, version: 3 },
      { ...checkpoint, head: 'message~a' },
      { ...checkpoint, nextConversationKey: 'job~a' },
    ])
      await assert.rejects(
        () => saveResumeCheckpoint(directory, invalid),
        /RESUME_CHECKPOINT_INVALID/,
      );
    assert.deepEqual(await loadResumeCheckpoint(directory), checkpoint);
    assert.equal(await removeResumeCheckpoint(directory), true);
    assert.equal(await loadResumeCheckpoint(directory), null);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('v2 runtime migrates without rewriting its file or losing the backfill cursor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-runtime-migrate-'));
  try {
    const legacy = {
      version: 2,
      cursors: { resume: 'a'.repeat(64), detail: 'job_a' },
      cdpRetry: { attempts: 0, nextRetryAt: null, lastError: null, exhausted: false },
      detail: { blocked: false, blockCode: null, blockedAt: null, tasks: [] },
      lastRun: null,
      updatedAt: null,
    };
    const path = join(directory, '.runtime-v2.json');
    await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
    const migrated = await loadRuntimeState(directory);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.cursors.resume, 'a'.repeat(64));
    assert.equal(migrated.history.initializedDay, null);
    await saveRuntimeState(directory, migrated);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), legacy);
  } finally {
    await rm(directory, { recursive: true });
  }
});
