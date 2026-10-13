import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectDetails,
  currentDetailSummary,
  detailFailureScope,
  detailInputs,
  fairDetailInputs,
} from './details/detail-phase.mjs';
import { DETAIL_NAVIGATION_DELAY_MS } from './details/detail-enrich.mjs';
import {
  applyDetailEvidenceV2,
  compareLoadedSnapshotsV2,
  conversationKeyV2,
} from './materials/model-v2.mjs';
import { normalizeRuntimeState, recordDetailFailure } from './persistence/runtime-state.mjs';
import { observeHistoryList } from './history/change-history.mjs';
import { createIncrementalBatch } from '../../scripts/boss/delivery/conversion.mjs';
import { applyBossBatch, bindBossAccount } from '../../dist/boss/application/integration.js';
import { emptyData } from '../../dist/model.js';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const OTHER_ACCOUNT = `boss-geek:${'b'.repeat(64)}`;
const CAPTURED_AT = '2026-10-07T08:00:00.000Z';
const NOW = '2026-10-08T08:00:00.000Z';
const SOURCE_ID = '00000000-0000-4000-8000-000000000001';
const url = (jobId) => `https://www.zhipin.com/job_detail/${jobId}.html`;
const title = (role = '合成岗位', company = '合成用人公司') =>
  `「${role}招聘」_${company}招聘-BOSS直聘`;

function envelopeFixture(jobs = ['job_a', 'job_b', 'job_c']) {
  // Assign requested jobs in conversation-key order so the fixture explicitly
  // specifies the existing fair-rotation order, regardless of snapshot order.
  const identities = jobs
    .map((_, index) => {
      const friendId = String(100 + index);
      return {
        key: conversationKeyV2(ACCOUNT, friendId, '0'),
        platformIdentity: { friendId, friendSource: '0', uniqueId: `${friendId}-0` },
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  const records = identities.map((identity, index) => {
    const item = typeof jobs[index] === 'string' ? { jobId: jobs[index] } : jobs[index];
    return {
      ...identity,
      contact: '合成招聘者',
      company: '合成招聘方',
      title: 'Recruiter',
      preview: '合成普通消息',
      timeLabel: item.timeLabel ?? '14:00',
      unread: null,
      latestMessageId: `message-${identity.platformIdentity.friendId}`,
      outgoingReceipt: { status: 'unknown', label: null, source: null },
      jobAssociation: { jobId: item.jobId, detailUrl: url(item.jobId) },
      observedJobName: item.jobName ?? null,
    };
  });
  return compareLoadedSnapshotsV2(null, {
    capturedAt: CAPTURED_AT,
    scope: 'loaded-chat-list',
    accountNamespace: ACCOUNT,
    records,
    coverage: {
      loadedRows: records.length,
      loadedDataRows: records.length,
      renderedRows: records.length,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  }).envelope;
}

function runtimeFixture(detailCursor = null) {
  return normalizeRuntimeState({
    version: 1,
    cursors: { resume: 'history_cursor', detail: detailCursor },
    lastRun: null,
    updatedAt: null,
  });
}

function fail(runtime, jobId, { at = NOW, block = false, code = 'DETAIL_TITLE_NOT_READY' } = {}) {
  return recordDetailFailure(runtime, { jobId, error: code, stage: 'read', at, block });
}

function adapterFixture(options = {}) {
  const calls = [];
  const reads = new Map();
  let currentUrl = null;
  const adapter = {
    async createOwnedTab({ ownerToken, initialUrl }) {
      calls.push(['create', initialUrl]);
      currentUrl = initialUrl;
      if (options.createError) throw Object.assign(new Error('synthetic'), options.createError);
      return { ownerToken, tabId: 'synthetic-detail-tab', windowId: 'synthetic-window' };
    },
    async readOwnedTab(handle) {
      calls.push(['read', currentUrl]);
      const count = (reads.get(currentUrl) ?? 0) + 1;
      reads.set(currentUrl, count);
      const patch = options.read?.(currentUrl, count) ?? {};
      return { ...handle, url: currentUrl, title: title(), documentReady: true, ...patch };
    },
    async navigateOwnedTab(handle, { ownerToken, expectedUrl, nextUrl }) {
      assert.equal(ownerToken, handle.ownerToken);
      assert.equal(expectedUrl, currentUrl);
      calls.push(['navigate', expectedUrl, nextUrl]);
      if (options.navigateError) throw Object.assign(new Error('synthetic'), options.navigateError);
      currentUrl = nextUrl;
    },
    async closeOwnedTab(handle, { ownerToken, expectedUrl }) {
      assert.equal(ownerToken, handle.ownerToken);
      assert.equal(expectedUrl, currentUrl);
      calls.push(['close', currentUrl]);
      if (options.closeError) throw Object.assign(new Error('synthetic'), options.closeError);
    },
  };
  return { adapter, calls };
}

function options(envelope, runtime, adapter, extra = {}) {
  return {
    envelope,
    runtime,
    limit: 3,
    adapter,
    now: () => NOW,
    wait: async () => {},
    maxReads: 2,
    pollMs: 0,
    ...extra,
  };
}

const forbiddenAdapter = new Proxy(
  {},
  {
    get() {
      throw new Error('empty detail phases must not access their adapter');
    },
  },
);

test('zero quota returns a readable empty phase and keeps the prior cursor without accessing the adapter', async () => {
  const envelope = envelopeFixture(['job_a', 'job_b']);
  const runtime = runtimeFixture('job_b');
  const before = structuredClone({ envelope, runtime });
  const phase = await collectDetails(options(envelope, runtime, forbiddenAdapter, { limit: 0 }));
  assert.equal(phase.skippedReason, 'DETAIL_BUDGET_ZERO');
  assert.deepEqual(phase.input.selectedIds, []);
  assert.deepEqual(phase.collected.observations, []);
  assert.equal(phase.collected.counts.attemptedJobs, 0);
  assert.equal(phase.collected.cleanup.status, 'not_needed');
  assert.equal(phase.applied.report.counts.accepted, 0);
  assert.deepEqual(phase.applied.envelope, envelope);
  assert.equal(phase.detailCursor, 'job_b');
  assert.equal(phase.detailEnrichment.pending, 2);
  assert.deepEqual({ envelope, runtime }, before);
});

test('already named and exact saved detail evidence leave no browser targets', async () => {
  let envelope = envelopeFixture([{ jobId: 'job_a', jobName: '列表岗位' }, 'job_b']);
  const association = envelope.jobs.associations.find((item) => item.jobId === 'job_b');
  envelope = applyDetailEvidenceV2(
    envelope,
    {
      observations: [
        {
          ...association,
          name: '已有岗位',
          company: '已有用人公司',
          title: title('已有岗位', '已有用人公司'),
          source: 'detail_page_title',
          observedAt: NOW,
        },
      ],
      candidates: [],
    },
    NOW,
  ).envelope;
  const runtime = fail(runtimeFixture('job_a'), 'job_b');
  const input = detailInputs(envelope);
  assert.deepEqual(input.knownEvidence, [
    {
      jobId: 'job_b',
      detailUrl: url('job_b'),
      name: '已有岗位',
      observedCompany: '已有用人公司',
      title: title('已有岗位', '已有用人公司'),
      observedAt: NOW,
      source: 'detail_page_title',
    },
  ]);
  const phase = await collectDetails(options(envelope, runtime, forbiddenAdapter));
  assert.equal(phase.skippedReason, 'DETAIL_TARGETS_EMPTY');
  assert.equal(phase.detailEnrichment.pending, 0);
  assert.equal(phase.detailEnrichment.deferred, 0);
  assert.equal(phase.detailEnrichment.lastError, null);
  assert.deepEqual(phase.detailRuntime, runtime.detail);
  assert.equal(phase.detailCursor, 'job_a');
  assert.deepEqual(phase.applied.envelope, envelope);
});

test('time-label targeting uses current snapshot labels and reads each selected job once', async () => {
  const envelope = envelopeFixture([
    { jobId: 'job_a', timeLabel: '昨天' },
    { jobId: 'job_a', timeLabel: '14:00' },
    { jobId: 'job_b', timeLabel: '昨天' },
  ]);
  const { adapter, calls } = adapterFixture();
  const waits = [];
  const phase = await collectDetails(
    options(envelope, runtimeFixture('job_b'), adapter, {
      timeLabel: '昨天',
      wait: async (duration) => waits.push(duration),
    }),
  );
  assert.deepEqual(phase.input.selectedIds, ['job_a', 'job_b']);
  assert.equal(phase.collected.counts.attemptedJobs, 2);
  assert.equal(phase.applied.report.counts.accepted, 2);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'navigate'),
    [['navigate', url('job_a'), url('job_b')]],
  );
  assert.deepEqual(waits, [0, DETAIL_NAVIGATION_DELAY_MS, 0]);
  assert.deepEqual(phase.applied.envelope.snapshot, envelope.snapshot);
  assert.deepEqual(phase.applied.envelope.state, envelope.state);
  assert.deepEqual(phase.applied.envelope.resume, envelope.resume);
  assert.equal(phase.detailCursor, 'job_b');
  assert.equal(phase.detailEnrichment.pending, 0);
  assert.equal(detailFailureScope(phase.collected, { ok: true }), 'none');
});

test('multiple conversations for one exact job share a single detail read', async () => {
  const envelope = envelopeFixture(['job_a', 'job_a']);
  const { adapter, calls } = adapterFixture();
  const phase = await collectDetails(options(envelope, runtimeFixture(), adapter, { limit: 1 }));
  assert.equal(phase.collected.counts.attemptedJobs, 1);
  assert.equal(phase.applied.report.counts.accepted, 2);
  assert.equal(calls.filter((call) => call[0] === 'create').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'navigate').length, 0);
  assert.equal(phase.detailEnrichment.pending, 0);
});

test('partial success clears only completed retries and records the failed job while retaining evidence', async () => {
  const envelope = envelopeFixture();
  let runtime = fail(runtimeFixture(), 'job_a', { at: CAPTURED_AT });
  runtime = fail(runtime, 'job_unrelated');
  const before = structuredClone({ envelope, runtime });
  const { adapter } = adapterFixture({
    read: (currentUrl) => (currentUrl === url('job_b') ? { title: '加载中' } : {}),
  });
  const phase = await collectDetails(options(envelope, runtime, adapter));
  assert.equal(phase.collected.counts.attemptedJobs, 3);
  assert.equal(phase.applied.report.counts.accepted, 2);
  assert.deepEqual(phase.applied.envelope.jobs.evidence.map((item) => item.jobId).sort(), [
    'job_a',
    'job_c',
  ]);
  assert.deepEqual(phase.collected.failures, [
    {
      jobId: 'job_b',
      detailUrl: url('job_b'),
      code: 'DETAIL_TITLE_NOT_READY',
      stage: 'read',
    },
  ]);
  assert.deepEqual(
    phase.detailRuntime.tasks.map((task) => [task.jobId, task.attempts]),
    [
      ['job_b', 1],
      ['job_unrelated', 1],
    ],
  );
  assert.equal(phase.detailRuntime.tasks[0].nextRetryAt, '2026-10-08T08:30:00.000Z');
  assert.equal(phase.detailCursor, 'job_c');
  assert.deepEqual(phase.detailEnrichment, {
    status: 'waiting_retry',
    pending: 1,
    deferred: 1,
    isolated: 0,
    nextRetryAt: '2026-10-08T08:30:00.000Z',
    lastError: 'DETAIL_TITLE_NOT_READY',
  });
  assert.equal(detailFailureScope(phase.collected, { ok: true }), 'detail');
  assert.deepEqual({ envelope, runtime }, before);
});

test('backoff and isolated jobs do not starve ready jobs and unrelated retries do not enter the summary', async () => {
  const envelope = envelopeFixture();
  let runtime = fail(runtimeFixture('job_b'), 'job_a');
  for (let attempt = 0; attempt < 4; attempt += 1) runtime = fail(runtime, 'job_b');
  runtime = fail(runtime, 'job_unrelated');
  assert.deepEqual(fairDetailInputs(envelope, { runtime, now: NOW, limit: 3 }).selectedIds, [
    'job_c',
  ]);
  const { adapter, calls } = adapterFixture();
  const phase = await collectDetails(options(envelope, runtime, adapter));
  assert.deepEqual(phase.input.selectedIds, ['job_c']);
  assert.equal(phase.collected.counts.attemptedJobs, 1);
  assert.deepEqual(calls[0], ['create', url('job_c')]);
  assert.equal(phase.detailEnrichment.pending, 2);
  assert.equal(phase.detailEnrichment.deferred, 1);
  assert.equal(phase.detailEnrichment.isolated, 1);
  assert.equal(phase.detailCursor, 'job_c');
  const subsequentRuntime = {
    ...runtime,
    detail: phase.detailRuntime,
    cursors: { ...runtime.cursors, detail: phase.detailCursor },
  };
  const empty = await collectDetails(
    options(phase.applied.envelope, subsequentRuntime, forbiddenAdapter),
  );
  assert.equal(empty.skippedReason, 'DETAIL_TARGETS_EMPTY');
  assert.equal(empty.detailEnrichment.pending, 2);
  assert.equal(empty.detailCursor, 'job_c');
});

test('blocked detail phases preserve every retry and do not access their adapter', async () => {
  const envelope = envelopeFixture();
  const runtime = fail(runtimeFixture('job_b'), 'job_a', {
    block: true,
    code: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
  });
  const phase = await collectDetails(options(envelope, runtime, forbiddenAdapter));
  assert.equal(phase.skippedReason, 'DETAIL_ENRICHMENT_BLOCKED');
  assert.deepEqual(phase.input.selectedIds, []);
  assert.equal(phase.collected.counts.attemptedJobs, 0);
  assert.equal(phase.detailEnrichment.status, 'blocked');
  assert.equal(phase.detailEnrichment.pending, 3);
  assert.deepEqual(phase.detailRuntime, runtime.detail);
  assert.equal(phase.detailCursor, 'job_b');
});

test('URL halt retains successful material and advances the cursor only through the collector attempts', async () => {
  const envelope = envelopeFixture();
  const { adapter, calls } = adapterFixture({
    read: (currentUrl) =>
      currentUrl === url('job_b')
        ? { url: 'https://www.zhipin.com/job_detail/unexpected.html' }
        : {},
  });
  const phase = await collectDetails(
    options(envelope, runtimeFixture('job_c'), adapter, { navigationDelayMs: 7 }),
  );
  assert.equal(phase.collected.counts.attemptedJobs, 2);
  assert.equal(phase.applied.report.counts.accepted, 1);
  assert.equal(phase.collected.halted.code, 'DETAIL_TAB_UNEXPECTED_URL');
  assert.equal(phase.detailCursor, 'job_b');
  assert.deepEqual(
    phase.collected.remaining.map((item) => item.jobId),
    ['job_c'],
  );
  assert.equal(
    calls.some((call) => call.includes(url('job_c'))),
    false,
  );
  assert.deepEqual(
    phase.detailRuntime.tasks.map((task) => task.jobId),
    ['job_b'],
  );
});

test('caught read halt preserves the existing reported-attempt cursor behavior', async () => {
  const envelope = envelopeFixture();
  const { adapter, calls } = adapterFixture({
    read: () => {
      throw Object.assign(new Error('synthetic'), { code: 'DETAIL_TAB_READ_TIMEOUT' });
    },
  });
  const phase = await collectDetails(options(envelope, runtimeFixture(), adapter));
  // The existing collector counts the next loop entry after a caught halt.
  // This extraction preserves that historical usage/cursor behavior.
  assert.equal(phase.collected.counts.attemptedJobs, 2);
  assert.equal(phase.detailCursor, 'job_b');
  assert.equal(phase.collected.halted.jobId, 'job_a');
  assert.equal(calls.filter((call) => call[0] === 'read').length, 1);
  assert.deepEqual(
    phase.collected.remaining.map((item) => item.jobId),
    ['job_c'],
  );
  assert.deepEqual(
    phase.detailRuntime.tasks.map((task) => task.jobId),
    ['job_a'],
  );
});

test('login verification halts are account failures and do not become job backoff', async () => {
  const envelope = envelopeFixture();
  const { adapter } = adapterFixture({
    read: () => ({ url: 'https://www.zhipin.com/web/user/', title: '登录' }),
  });
  const runtime = runtimeFixture('job_c');
  const phase = await collectDetails(options(envelope, runtime, adapter));
  assert.equal(phase.collected.counts.attemptedJobs, 1);
  assert.equal(phase.collected.halted.code, 'VERIFICATION_OR_LOGIN_REQUIRED');
  assert.equal(detailFailureScope(phase.collected, { ok: true }), 'account');
  assert.deepEqual(phase.detailRuntime, runtime.detail);
  assert.equal(phase.applied.report.counts.accepted, 0);
});

test('ownership loss during cleanup blocks details but retains evidence and clears the completed job retry', async () => {
  const envelope = envelopeFixture(['job_a']);
  const runtime = fail(runtimeFixture(), 'job_a', { at: CAPTURED_AT });
  const { adapter } = adapterFixture({ closeError: { code: 'DETAIL_TAB_OWNERSHIP_MISMATCH' } });
  const phase = await collectDetails(options(envelope, runtime, adapter));
  assert.equal(phase.applied.report.counts.accepted, 1);
  assert.equal(phase.collected.cleanup.status, 'skipped');
  assert.equal(phase.collected.halted.stage, 'close');
  assert.equal(phase.detailRuntime.blocked, true);
  assert.equal(phase.detailRuntime.blockCode, 'DETAIL_TAB_OWNERSHIP_MISMATCH');
  assert.deepEqual(phase.detailRuntime.tasks, []);
  assert.equal(phase.detailEnrichment.pending, 0);
  assert.equal(phase.detailEnrichment.status, 'blocked');
  assert.equal(detailFailureScope(phase.collected, { ok: true }), 'detail');
});

test('ordinary cleanup failure after evidence does not reintroduce a completed job backoff', async () => {
  const envelope = envelopeFixture(['job_a']);
  const runtime = fail(runtimeFixture(), 'job_a', { at: CAPTURED_AT });
  const { adapter } = adapterFixture({ closeError: { code: 'DETAIL_TAB_CHANGED' } });
  const phase = await collectDetails(options(envelope, runtime, adapter));
  assert.equal(phase.applied.report.counts.accepted, 1);
  assert.equal(phase.collected.halted.code, 'DETAIL_TAB_CHANGED');
  assert.equal(phase.detailRuntime.blocked, false);
  assert.deepEqual(phase.detailRuntime.tasks, []);
  assert.equal(detailFailureScope(phase.collected, { ok: true }), 'detail');
});

test('final identity failure takes account scope after navigation with material or concurrent detail failures', async () => {
  for (const failSecondTitle of [false, true]) {
    const envelope = envelopeFixture(['job_a', 'job_b']);
    const { adapter, calls } = adapterFixture({
      read: (currentUrl) =>
        failSecondTitle && currentUrl === url('job_b') ? { title: '加载中' } : {},
    });
    const phase = await collectDetails(options(envelope, runtimeFixture(), adapter));
    assert.equal(phase.collected.counts.attemptedJobs, 2);
    assert.equal(calls.filter((call) => call[0] === 'navigate').length, 1);
    assert.equal(phase.applied.report.counts.accepted, failSecondTitle ? 1 : 2);
    assert.equal(phase.collected.failures.length, failSecondTitle ? 1 : 0);
    const identity = { ok: false, report: { error: 'ACCOUNT_IDENTITY_MISMATCH' } };
    assert.equal(detailFailureScope(phase.collected, identity), 'account');
    assert.equal(identity.report.error, 'ACCOUNT_IDENTITY_MISMATCH');
    assert.deepEqual(
      phase.detailRuntime.tasks.map((task) => task.jobId),
      failSecondTitle ? ['job_b'] : [],
    );
  }
});

test('runtime candidates contain only detail state so callers retain newer CDP and history progress', async () => {
  const envelope = envelopeFixture(['job_a']);
  const runtime = runtimeFixture();
  const newer = structuredClone(runtime);
  newer.cdpRetry = {
    attempts: 1,
    nextRetryAt: '2026-10-08T08:00:02.000Z',
    lastError: 'CDP_CONNECT_FAILED',
    exhausted: false,
  };
  newer.cursors.resume = 'newer_history_cursor';
  newer.history = observeHistoryList(newer.history, envelope.snapshot.records, NOW);
  const { adapter } = adapterFixture();
  const phase = await collectDetails(options(envelope, runtime, adapter));
  assert.equal(Object.hasOwn(phase, 'runtime'), false);
  assert.deepEqual(
    Object.keys(phase.detailRuntime).sort(),
    ['blockCode', 'blockedAt', 'blocked', 'tasks'].sort(),
  );
  const merged = {
    ...newer,
    detail: phase.detailRuntime,
    cursors: { ...newer.cursors, detail: phase.detailCursor },
    updatedAt: phase.updatedAt,
  };
  assert.deepEqual(merged.cdpRetry, newer.cdpRetry);
  assert.deepEqual(merged.history, newer.history);
  assert.equal(merged.cursors.resume, 'newer_history_cursor');
  assert.equal(merged.cursors.detail, 'job_a');
  assert.deepEqual(normalizeRuntimeState(merged), merged);
});

test('invalid account or job identity and future envelopes stop before any adapter access', async () => {
  const changes = [
    (envelope) => {
      envelope.accountNamespace = OTHER_ACCOUNT;
    },
    (envelope) => {
      envelope.jobs.associations[0].detailUrl = url('another_job');
    },
    (envelope) => {
      envelope.version = 9;
    },
  ];
  for (const change of changes) {
    const envelope = envelopeFixture(['job_a']);
    change(envelope);
    await assert.rejects(
      collectDetails(options(envelope, runtimeFixture(), forbiddenAdapter)),
      TypeError,
    );
  }
  const summary = currentDetailSummary(null, runtimeFixture(), NOW);
  assert.equal(summary.pending, 0);
  assert.equal(summary.status, 'active');
});

test('collected detail material still passes the existing account, exact job and manual ownership judges', async () => {
  const envelope = envelopeFixture(['job_a']);
  const { adapter } = adapterFixture();
  const phase = await collectDetails(options(envelope, runtimeFixture(), adapter));
  const reference = (value, digit) => ({
    path: `synthetic-${digit}.json`,
    sha256: digit.repeat(64),
    envelope: value,
  });
  const batch = createIncrementalBatch(
    reference(envelope, 'a'),
    reference(phase.applied.envelope, 'b'),
    2,
  );
  assert.ok(batch);
  assert.equal(batch.events[0].jobDetails.jobName, '合成岗位');
  assert.equal(batch.events[0].jobDetails.company, '合成用人公司');
  const applyOptions = { workspaceSourceId: SOURCE_ID, stamp: NOW };
  const bound = bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, NOW);
  const applied = applyBossBatch(bound, batch, applyOptions).data;
  assert.equal(applied.opportunities[0].role, '合成岗位');
  assert.equal(applied.opportunities[0].company, '合成用人公司');
  assert.equal(phase.applied.envelope.state.records[0].company, '合成招聘方');

  const other = bindBossAccount(emptyData(), OTHER_ACCOUNT, SOURCE_ID, NOW);
  const otherBefore = structuredClone(other);
  assert.throws(() => applyBossBatch(other, batch, applyOptions), { code: 'SOURCE_NOT_BOUND' });
  assert.deepEqual(other, otherBefore);

  const manual = structuredClone(bound);
  manual.opportunities.push({
    id: 'manual',
    company: '人工公司',
    role: '人工岗位',
    platform: 'BOSS',
    externalId: 'job_a',
    url: url('job_a'),
    stage: '面试中',
    resumeState: '已发送',
    readState: '已读',
  });
  const protectedResult = applyBossBatch(manual, batch, applyOptions).data;
  assert.deepEqual(protectedResult.opportunities, manual.opportunities);
  assert.equal(protectedResult.sourceApplications[0].status, 'review');

  const mismatched = structuredClone(manual);
  mismatched.opportunities[0].role = '合成岗位';
  mismatched.opportunities[0].externalId = 'other_job';
  const rejected = applyBossBatch(mismatched, batch, applyOptions).data;
  assert.deepEqual(rejected.opportunities, mismatched.opportunities);
  assert.equal(rejected.sourceApplications[0].status, 'review');
});

test('an empty eligible detail phase preserves the legacy new-material upgrade', async () => {
  const envelope = { ...envelopeFixture([{ jobId: 'job_a', jobName: '已有岗位' }]), version: 7 };
  const phase = await collectDetails(options(envelope, runtimeFixture(), forbiddenAdapter));
  assert.equal(phase.skippedReason, 'DETAIL_TARGETS_EMPTY');
  assert.equal(phase.applied.envelope.version, 8);
  assert.deepEqual(phase.applied.envelope.snapshot, envelope.snapshot);
});

test('material adoption failure after a detail action preserves its actual navigation use', async () => {
  const envelope = envelopeFixture(['job_a']);
  const { adapter, calls } = adapterFixture();
  await assert.rejects(
    collectDetails(
      options(envelope, runtimeFixture(), adapter, {
        now: () =>
          calls.some(([operation]) => operation === 'close') ? '2026-10-01T08:00:00.000Z' : NOW,
      }),
    ),
    (error) => error.usage?.detailNavigations === 1,
  );
  assert.equal(calls.filter(([operation]) => operation === 'create').length, 1);
});

test('detail state capacity failure returns already adopted partial material and uncommittable state', async () => {
  const envelope = envelopeFixture(['job_a', 'job_b']);
  const runtime = runtimeFixture('job_b');
  runtime.detail.tasks = Array.from({ length: 1000 }, (_, index) => ({
    jobId: `unrelated_${String(index).padStart(4, '0')}`,
    attempts: 1,
    status: 'backoff',
    nextRetryAt: '2026-10-08T08:30:00.000Z',
    lastError: 'DETAIL_TITLE_NOT_READY',
    lastStage: 'read',
    lastAttemptAt: NOW,
  }));
  assert.deepEqual(normalizeRuntimeState(runtime), runtime);
  const before = structuredClone({ envelope, runtime });
  const { adapter, calls } = adapterFixture({
    read: (currentUrl) => (currentUrl === url('job_b') ? { title: '加载中' } : {}),
  });
  const phase = await collectDetails(options(envelope, runtime, adapter));
  assert.ok(phase.stateError instanceof Error);
  assert.equal(phase.stateError.message, 'RUNTIME_DETAIL_INVALID');
  assert.deepEqual(phase.stateError.usage, { detailNavigations: 2 });
  assert.equal(phase.collected.counts.attemptedJobs, 2);
  assert.equal(phase.applied.report.counts.accepted, 1);
  assert.deepEqual(
    phase.applied.envelope.jobs.evidence.map((item) => item.jobId),
    ['job_a'],
  );
  assert.deepEqual(phase.applied.envelope.snapshot, envelope.snapshot);
  assert.deepEqual(phase.applied.envelope.state, envelope.state);
  assert.equal(phase.updatedAt, NOW);
  assert.equal(phase.detailCursor, 'job_b');
  assert.equal(phase.detailRuntime, null);
  assert.equal(phase.detailEnrichment, null);
  assert.equal(phase.skippedReason, null);
  assert.equal(calls.filter(([operation]) => operation === 'navigate').length, 1);
  assert.deepEqual({ envelope, runtime }, before);
});

test('blocked enrichment summary retains the requested snapshot time-label scope', async () => {
  const envelope = envelopeFixture([
    { jobId: 'job_a', timeLabel: '昨天' },
    { jobId: 'job_b', timeLabel: '14:00' },
  ]);
  let runtime = fail(runtimeFixture('job_b'), 'job_a');
  runtime = fail(runtime, 'job_b', { block: true, code: 'DETAIL_TAB_OWNERSHIP_MISMATCH' });
  const phase = await collectDetails(
    options(envelope, runtime, forbiddenAdapter, { timeLabel: '昨天' }),
  );
  assert.equal(phase.skippedReason, 'DETAIL_ENRICHMENT_BLOCKED');
  assert.equal(phase.input.pendingJobs, 1);
  assert.deepEqual(phase.input.eligibleJobIds, ['job_a']);
  assert.deepEqual(phase.detailEnrichment, {
    status: 'blocked',
    pending: 1,
    deferred: 1,
    isolated: 0,
    nextRetryAt: '2026-10-08T08:30:00.000Z',
    lastError: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
  });
  assert.equal(phase.detailCursor, 'job_b');
  assert.deepEqual(phase.detailRuntime, runtime.detail);
  assert.equal(phase.stateError, null);
  assert.equal(currentDetailSummary(envelope, runtime, NOW).pending, 2);
});
