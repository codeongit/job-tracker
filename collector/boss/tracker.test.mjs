import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, realpath, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectResume,
  collectChangedResume,
  detailInputs,
  fairDetailInputs,
  fairResumeTargets,
  parseArguments,
  safeBrowserReport,
  saveEnvelope,
  summarizeEnvelope,
  trackerFailureReport,
} from './tracker.mjs';
import { latest } from './storage.mjs';
import { applyDetailEvidenceV2, compareLoadedSnapshotsV2, conversationKeyV2 } from './model-v2.mjs';
import {
  loadChangeCheckpoint,
  normalizeRuntimeState,
  recordDetailFailure,
  saveChangeCheckpoint,
} from './runtime-state.mjs';
import { observeHistoryList, pendingHistory } from './change-history.mjs';

// macOS exposes /var as a symlink; private-writer fixtures use its real location.
const privateTemporaryRoot = await realpath(tmpdir());

test('CLI keeps compatibility while exposing persistent connection and bounded enrichment modes', () => {
  const base = {
    help: false,
    account: 'main',
    limit: 3,
    pages: 2,
    timeLabel: null,
    jobId: null,
    historyRequests: 20,
    domLimit: 0,
    detailLimit: 20,
    historyMode: 'change',
  };
  assert.deepEqual(parseArguments([]), { ...base, mode: 'status' });
  assert.deepEqual(parseArguments(['check', '--account', 'personal']), {
    ...base,
    mode: 'check',
    account: 'personal',
  });
  assert.deepEqual(parseArguments(['enrich', '--time-label', '昨天', '--account', 'main']), {
    ...base,
    mode: 'enrich',
    limit: 20,
    timeLabel: '昨天',
  });
  assert.deepEqual(parseArguments(['enrich', '--limit', '3', '--account', 'main']), {
    ...base,
    mode: 'enrich',
    limit: 3,
  });
  assert.deepEqual(parseArguments(['resume-scan', '--limit', '8', '--pages', '3']), {
    ...base,
    mode: 'resume-scan',
    limit: 8,
    pages: 3,
  });
  assert.deepEqual(parseArguments(['resume-scan', '--pages', '20', '--job-id', 'job_1']), {
    ...base,
    mode: 'resume-scan',
    pages: 20,
    jobId: 'job_1',
  });
  assert.deepEqual(
    parseArguments(['resume-scan', '--limit', '10', '--pages', '5', '--time-label', '昨天']),
    { ...base, mode: 'resume-scan', limit: 10, pages: 5, timeLabel: '昨天' },
  );
  assert.deepEqual(
    parseArguments(['run', '--history-requests', '0', '--dom-limit', '1', '--detail-limit', '0']),
    { ...base, mode: 'run', historyRequests: 0, domLimit: 1, detailLimit: 0 },
  );
  assert.deepEqual(
    parseArguments(['run', '--history-requests', '20', '--dom-limit', '0', '--detail-limit', '20']),
    { ...base, mode: 'run' },
  );
  assert.deepEqual(parseArguments(['init']), { ...base, mode: 'init' });
  assert.deepEqual(parseArguments(['resume-details']), { ...base, mode: 'resume-details' });
  for (const args of [
    ['check', '--limit', '2'],
    ['check', '--pages', '2'],
    ['check', '--time-label', '昨天'],
    ['enrich', '--pages', '2'],
    ['check', '--job-id', 'job_1'],
    ['check', '--history-requests', '1'],
    ['check', '--dom-limit', '1'],
    ['run', '--history-requests', '-1'],
    ['run', '--history-requests', '21'],
    ['run', '--dom-limit', '-1'],
    ['run', '--dom-limit', '2'],
    ['run', '--detail-limit', '-1'],
    ['run', '--detail-limit', '21'],
    ['resume-scan', '--job-id', 'bad id'],
    ['resume-scan', '--time-label', '今天'],
    ['enrich', '--time-label', '今天'],
    ['enrich', '--limit', '0'],
    ['enrich', '--limit', '21'],
    ['resume-scan', '--pages', '21'],
    ['unknown'],
    ['connect', '--account', 'bad label'],
  ]) {
    assert.throws(() => parseArguments(args), /ARGUMENTS_INVALID/);
  }
});

test('status summary for v5 reports coverage and job counts without chat content', () => {
  const namespace = 'boss-geek:' + 'a'.repeat(64);
  const snapshot = {
    capturedAt: '2026-09-18T12:00:00.000Z',
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records: [
      {
        key: conversationKeyV2(namespace, '101', '0'),
        platformIdentity: { friendId: '101', friendSource: '0', uniqueId: '101-0' },
        contact: 'Synthetic contact',
        company: 'Synthetic company',
        title: 'Recruiter',
        preview: 'SECRET_PREVIEW',
        timeLabel: 'now',
        unread: null,
        latestMessageId: '8',
        outgoingReceipt: { status: 'unknown', label: null, source: null },
        jobAssociation: {
          jobId: 'job_a',
          detailUrl: 'https://www.zhipin.com/job_detail/job_a.html',
        },
        observedJobName: 'Synthetic role',
      },
    ],
    coverage: {
      loadedRows: 1,
      loadedDataRows: 1,
      renderedRows: 1,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  };
  const envelope = compareLoadedSnapshotsV2(null, snapshot).envelope;
  const summary = summarizeEnvelope(envelope);
  assert.equal(summary.version, 5);
  assert.equal(summary.trackedRecords, 1);
  assert.equal(summary.jobs.named, 1);
  assert.equal(summary.jobs.linked, 1);
  assert.equal(JSON.stringify(summary).includes('SECRET_PREVIEW'), false);
});

test('targeted enrichment filters by the current snapshot label rather than historical state', () => {
  const namespace = 'boss-geek:' + 'b'.repeat(64);
  const yesterdayKey = conversationKeyV2(namespace, '201', '0');
  const todayKey = conversationKeyV2(namespace, '202', '0');
  const makeRecord = (key, friendId, timeLabel, jobId) => ({
    key,
    platformIdentity: { friendId, friendSource: '0', uniqueId: `${friendId}-0` },
    contact: `Contact ${friendId}`,
    company: `Company ${friendId}`,
    title: 'Recruiter',
    preview: 'Preview',
    timeLabel,
    unread: null,
    latestMessageId: `message-${friendId}`,
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: { jobId, detailUrl: `https://www.zhipin.com/job_detail/${jobId}.html` },
    observedJobName: null,
  });
  const snapshot = {
    capturedAt: '2026-09-21T03:02:35.881Z',
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records: [
      makeRecord(yesterdayKey, '201', '昨天', 'job_yesterday'),
      makeRecord(todayKey, '202', '09:34', 'job_today'),
    ],
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
  assert.equal(
    envelope.state.records.some((record) => Object.hasOwn(record, 'timeLabel')),
    false,
  );
  assert.deepEqual(
    detailInputs(envelope, '昨天').candidates.map((record) => record.jobId),
    ['job_yesterday'],
  );
  assert.deepEqual(fairDetailInputs(envelope, { cursor: 'job_yesterday', limit: 2 }).selectedIds, [
    'job_today',
    'job_yesterday',
  ]);
});

test('detail fairness selects only unnamed jobs and cannot stall behind a full named page', () => {
  const namespace = 'boss-geek:' + 'c'.repeat(64);
  const makeRecord = (index, jobName) => ({
    key: conversationKeyV2(namespace, String(600 + index), '0'),
    platformIdentity: {
      friendId: String(600 + index),
      friendSource: '0',
      uniqueId: `${600 + index}-0`,
    },
    contact: `Contact ${index}`,
    company: `Company ${index}`,
    title: 'Recruiter',
    preview: 'Preview',
    timeLabel: 'now',
    unread: null,
    latestMessageId: `message-${index}`,
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: {
      jobId: `job_${index}`,
      detailUrl: `https://www.zhipin.com/job_detail/job_${index}.html`,
    },
    observedJobName: jobName,
  });
  const records = [
    makeRecord(0, null),
    makeRecord(1, null),
    ...Array.from({ length: 22 }, (_, offset) =>
      makeRecord(offset + 2, `Named role ${offset + 2}`),
    ),
  ];
  const { envelope } = compareLoadedSnapshotsV2(null, {
    capturedAt: '2026-09-22T10:00:00.000Z',
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records,
    coverage: {
      loadedRows: 24,
      loadedDataRows: 24,
      renderedRows: 24,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  });
  const selected = fairDetailInputs(envelope, { cursor: 'job_1', limit: 20 });
  assert.deepEqual(selected.selectedIds, ['job_0', 'job_1']);
  assert.equal(
    selected.candidates.every((item) => item.jobName === null),
    true,
  );
});

test('detail fairness skips backoff and isolated jobs without starving ready jobs', () => {
  const namespace = 'boss-geek:' + '9'.repeat(64),
    records = ['a', 'b', 'c'].map((suffix, index) => ({
      key: conversationKeyV2(namespace, String(900 + index), '0'),
      platformIdentity: {
        friendId: String(900 + index),
        friendSource: '0',
        uniqueId: `${900 + index}-0`,
      },
      contact: `Contact ${suffix}`,
      company: `Company ${suffix}`,
      title: 'Recruiter',
      preview: 'Preview',
      timeLabel: 'now',
      unread: null,
      latestMessageId: `message-${suffix}`,
      outgoingReceipt: { status: 'unknown', label: null, source: null },
      jobAssociation: {
        jobId: `job_${suffix}`,
        detailUrl: `https://www.zhipin.com/job_detail/job_${suffix}.html`,
      },
      observedJobName: null,
    }));
  const { envelope } = compareLoadedSnapshotsV2(null, {
    capturedAt: '2026-09-22T10:00:00.000Z',
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records,
    coverage: {
      loadedRows: 3,
      loadedDataRows: 3,
      renderedRows: 3,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  });
  let runtime = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  runtime = recordDetailFailure(runtime, {
    jobId: 'job_a',
    error: 'DETAIL_TAB_CHANGED',
    stage: 'read',
    at: '2026-09-22T10:00:00.000Z',
  });
  for (let attempt = 0; attempt < 4; attempt += 1)
    runtime = recordDetailFailure(runtime, {
      jobId: 'job_b',
      error: 'DETAIL_TAB_CHANGED',
      stage: 'read',
      at: `2026-09-${22 + attempt}T12:00:00.000Z`,
    });
  const selected = fairDetailInputs(envelope, {
    limit: 3,
    runtime,
    now: '2026-09-22T10:01:00.000Z',
  });
  assert.deepEqual(selected.selectedIds, ['job_c']);
  assert.equal(selected.deferredJobs, 1);
  assert.equal(selected.isolatedJobs, 1);
  assert.equal(selected.pendingJobs, 3);
});

test('company-mismatch detail candidates leave automatic rotation instead of being fetched again', () => {
  const namespace = 'boss-geek:' + 'f'.repeat(64);
  const makeRecord = (index, company) => ({
    key: conversationKeyV2(namespace, String(700 + index), '0'),
    platformIdentity: {
      friendId: String(700 + index),
      friendSource: '0',
      uniqueId: `${700 + index}-0`,
    },
    contact: `Contact ${index}`,
    company,
    title: 'Recruiter',
    preview: 'Preview',
    timeLabel: 'now',
    unread: null,
    latestMessageId: `message-${index}`,
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: {
      jobId: `job_${index}`,
      detailUrl: `https://www.zhipin.com/job_detail/job_${index}.html`,
    },
    observedJobName: null,
  });
  const first = makeRecord(0, 'Expected Company'),
    second = makeRecord(1, 'Pending Company');
  const compared = compareLoadedSnapshotsV2(null, {
    capturedAt: '2026-09-22T10:00:00.000Z',
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records: [first, second],
    coverage: {
      loadedRows: 2,
      loadedDataRows: 2,
      renderedRows: 2,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  });
  const applied = applyDetailEvidenceV2(
    compared.envelope,
    {
      observations: [],
      candidates: [
        {
          conversationKey: first.key,
          jobId: 'job_0',
          detailUrl: 'https://www.zhipin.com/job_detail/job_0.html',
          name: 'Observed role',
          observedAt: '2026-09-22T10:00:01.000Z',
          source: 'detail_page_title',
          title: '「Observed role招聘」_Different Company招聘-BOSS直聘',
          expectedCompany: 'Expected Company',
          observedCompany: 'Different Company',
          reason: 'detail_company_mismatch',
        },
      ],
    },
    '2026-09-22T10:00:02.000Z',
  );
  assert.deepEqual(fairDetailInputs(applied.envelope, { limit: 20 }).selectedIds, ['job_1']);
});

test('browser reports are projected without target URLs, ids, sessions, pages, or private payloads', () => {
  const safe = safeBrowserReport({
    error: 'CONNECTION_REQUIRED',
    connectionFailure: 'TARGET_URL_CHANGED',
    readSucceeded: false,
    originalTargetRetained: true,
    session: 'private-session',
    page: 'private-page',
    nativeTabId: '123',
    observations: [{ targets: [{ url: 'https://private.example/secret' }] }],
    payload: { preview: 'PRIVATE_CHAT_PREVIEW' },
    accountNamespace: 'boss-geek:' + 'a'.repeat(64),
  });
  assert.deepEqual(safe, {
    readSucceeded: false,
    originalTargetRetained: true,
    error: 'CONNECTION_REQUIRED',
    connectionFailure: 'TARGET_URL_CHANGED',
  });
  const serialized = JSON.stringify(safe);
  for (const secret of [
    'private-session',
    'private-page',
    '123',
    'private.example',
    'PRIVATE_CHAT_PREVIEW',
    'boss-geek:',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('resume target selection keeps the durable conversation first', () => {
  const namespace = 'boss-geek:' + 'd'.repeat(64);
  const records = ['401', '402', '403'].map((friendId) => ({
    key: conversationKeyV2(namespace, friendId, '0'),
    platformIdentity: { friendId, friendSource: '0', uniqueId: `${friendId}-0` },
    contact: `Contact ${friendId}`,
    company: 'Company',
    title: 'Recruiter',
    preview: 'Preview',
    timeLabel: 'now',
    unread: null,
    latestMessageId: `message-${friendId}`,
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: { jobId: null, detailUrl: null },
    observedJobName: null,
  }));
  const envelope = compareLoadedSnapshotsV2(null, {
    capturedAt: '2026-09-21T03:02:35.881Z',
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records,
    coverage: {
      loadedRows: 3,
      loadedDataRows: 3,
      renderedRows: 3,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  }).envelope;
  const selected = fairResumeTargets(envelope, {
    cursor: records[1].key,
    limit: 2,
    resumeFrom: records[0].key,
  });
  assert.deepEqual(
    selected.targets.map((item) => item.conversationKey),
    [records[0].key, records[2].key],
  );
});

test('unknown history request outcome is counted once and never replayed by a CDP reconnect wrapper', async () => {
  const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-history-single-attempt-'));
  try {
    const namespace = 'boss-geek:' + 'e'.repeat(64),
      friendId = '501',
      friendSource = '0';
    const record = {
      key: conversationKeyV2(namespace, friendId, friendSource),
      platformIdentity: { friendId, friendSource, uniqueId: `${friendId}-${friendSource}` },
      contact: 'Synthetic',
      company: 'Company',
      title: 'Recruiter',
      preview: 'Preview',
      timeLabel: 'now',
      unread: null,
      latestMessageId: 'message-501',
      outgoingReceipt: { status: 'unknown', label: null, source: null },
      jobAssociation: {
        jobId: 'job_501',
        detailUrl: 'https://www.zhipin.com/job_detail/job_501.html',
      },
      observedJobName: 'Role',
    };
    const envelope = compareLoadedSnapshotsV2(null, {
      capturedAt: '2026-09-21T03:02:35.881Z',
      scope: 'loaded-chat-list',
      accountNamespace: namespace,
      records: [record],
      coverage: {
        loadedRows: 1,
        loadedDataRows: 1,
        renderedRows: 1,
        offscreenRows: 0,
        unresolvedRows: 0,
        truncated: false,
      },
    }).envelope;
    let calls = 0;
    const result = await collectResume({
      directory,
      connection: {},
      envelope,
      runtime: { cursors: { resume: null, detail: null } },
      limit: 1,
      pages: 1,
      maxRequests: 2,
      reportOperation: async () => ({ ok: true, report: {} }),
      evaluate: async () => {
        calls += 1;
        throw new Error('CDP_CONNECTION_CLOSED');
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.partial, true);
    assert.equal(result.usage.historyRequests, 1);
    assert.equal(result.continuation.conversationKey, record.key);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('change-driven history saves an ordinary-message watermark and makes no repeat request', async () => {
  const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-history-change-'));
  try {
    const namespace = 'boss-geek:' + 'f'.repeat(64);
    const key = conversationKeyV2(namespace, '701', '0');
    const record = {
      key,
      platformIdentity: { friendId: '701', friendSource: '0', uniqueId: '701-0' },
      contact: 'Synthetic',
      company: 'Company',
      title: 'Recruiter',
      preview: 'ordinary',
      timeLabel: '10:00',
      unread: null,
      latestMessageId: 'm1',
      outgoingReceipt: { status: 'unknown', label: null, source: null },
      jobAssociation: { jobId: null, detailUrl: null },
      observedJobName: null,
    };
    const snapshot = {
      capturedAt: '2026-09-24T02:00:00.000Z',
      scope: 'loaded-chat-list',
      accountNamespace: namespace,
      records: [record],
      coverage: {
        loadedRows: 1,
        loadedDataRows: 1,
        renderedRows: 1,
        offscreenRows: 0,
        unresolvedRows: 0,
        truncated: false,
      },
    };
    let envelope = compareLoadedSnapshotsV2(null, snapshot).envelope;
    let history = observeHistoryList(
      normalizeRuntimeState({
        version: 2,
        cursors: { resume: null, detail: null },
        lastRun: null,
        updatedAt: null,
      }).history,
      snapshot.records,
      snapshot.capturedAt,
    );
    let requests = 0,
      commits = 0;
    const run = async () =>
      collectChangedResume({
        directory,
        connection: {},
        envelope,
        runtime: { history },
        maxRequests: 4,
        requestDelayMs: 0,
        betweenTargetsDelayMs: 0,
        reportOperation: async () => ({ ok: true, report: {} }),
        saveEvidence: async () => {
          commits += 1;
        },
        saveProgress: async (value) => {
          history = value;
        },
        evaluate: async (_connection, _expression, metadata) => {
          requests += 1;
          return metadata.kind === 'friend'
            ? {
                ok: true,
                identity: { bossId: 'boss701', securityId: 'security701' },
              }
            : {
                ok: true,
                observations: [],
                unresolved: [],
                messageIds: ['ordinary1'],
                exhausted: true,
                page: metadata.page,
              };
        },
      });
    const first = await run();
    envelope = first.envelope;
    assert.equal(first.usage.historyRequests, 2);
    assert.equal(commits, 1);
    assert.equal(history.conversations[0].watermark, 'ordinary1');
    assert.equal(pendingHistory(history).length, 0);
    const second = await run();
    assert.equal(second.usage.historyRequests, 0);
    assert.equal(requests, 2);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('completed-page checkpoint replays locally after progress write fails', async () => {
  const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-history-replay-'));
  try {
    const namespace = 'boss-geek:' + 'd'.repeat(64);
    const record = {
      key: conversationKeyV2(namespace, '801', '0'),
      platformIdentity: { friendId: '801', friendSource: '0', uniqueId: '801-0' },
      contact: 'Synthetic',
      company: 'Company',
      title: 'Recruiter',
      preview: 'ordinary',
      timeLabel: '10:00',
      unread: null,
      latestMessageId: 'm1',
      outgoingReceipt: { status: 'unknown', label: null, source: null },
      jobAssociation: { jobId: null, detailUrl: null },
      observedJobName: null,
    };
    const snapshot = {
      capturedAt: '2026-09-24T02:00:00.000Z',
      scope: 'loaded-chat-list',
      accountNamespace: namespace,
      records: [record],
      coverage: {
        loadedRows: 1,
        loadedDataRows: 1,
        renderedRows: 1,
        offscreenRows: 0,
        unresolvedRows: 0,
        truncated: false,
      },
    };
    const envelope = compareLoadedSnapshotsV2(null, snapshot).envelope;
    let history = observeHistoryList(
      normalizeRuntimeState({
        version: 2,
        cursors: { resume: null, detail: null },
        lastRun: null,
        updatedAt: null,
      }).history,
      snapshot.records,
      snapshot.capturedAt,
    );
    let requests = 0,
      commits = 0;
    const base = {
      directory,
      connection: {},
      envelope,
      maxRequests: 4,
      requestDelayMs: 0,
      betweenTargetsDelayMs: 0,
      reportOperation: async () => ({ ok: true, report: {} }),
      saveEvidence: async () => {
        commits += 1;
      },
    };
    await assert.rejects(
      collectChangedResume({
        ...base,
        runtime: { history },
        saveProgress: async () => {
          throw new Error('LOCAL_PROGRESS_FAILED');
        },
        evaluate: async (_connection, _expression, metadata) => {
          requests += 1;
          return metadata.kind === 'friend'
            ? { ok: true, identity: { bossId: 'boss801', securityId: 'security801' } }
            : {
                ok: true,
                observations: [],
                unresolved: [],
                messageIds: ['ordinary801'],
                exhausted: true,
                page: metadata.page,
              };
        },
      }),
      (error) => {
        assert.equal(error.message, 'LOCAL_PROGRESS_FAILED');
        assert.deepEqual(error.usage, { historyRequests: 2 });
        return true;
      },
    );
    assert.equal(commits, 1);
    const recovered = await collectChangedResume({
      ...base,
      runtime: { history },
      saveProgress: async (value) => {
        history = value;
      },
      evaluate: async () => {
        throw new Error('PLATFORM_SHOULD_NOT_BE_CALLED');
      },
    });
    assert.equal(recovered.usage.historyRequests, 0);
    assert.equal(requests, 2);
    assert.equal(history.conversations[0].watermark, 'ordinary801');
  } finally {
    await rm(directory, { recursive: true });
  }
});

function changedHistoryFixture(count = 1) {
  const namespace = `boss-geek:${'d'.repeat(64)}`;
  const record = {
    key: conversationKeyV2(namespace, '901', '0'),
    platformIdentity: { friendId: '901', friendSource: '0', uniqueId: '901-0' },
    contact: 'Synthetic contact',
    company: 'Synthetic company',
    title: 'Recruiter',
    preview: 'ordinary',
    timeLabel: '10:00',
    unread: null,
    latestMessageId: 'm1',
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: { jobId: null, detailUrl: null },
    observedJobName: null,
  };
  const records = Array.from({ length: count }, (_, index) => {
    const friendId = String(901 + index);
    return {
      ...record,
      key: conversationKeyV2(namespace, friendId, '0'),
      platformIdentity: { friendId, friendSource: '0', uniqueId: `${friendId}-0` },
    };
  });
  const snapshot = {
    capturedAt: '2026-09-24T02:00:00.000Z',
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records,
    coverage: {
      loadedRows: count,
      loadedDataRows: count,
      renderedRows: count,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  };
  const envelope = compareLoadedSnapshotsV2(null, snapshot).envelope;
  const history = observeHistoryList(
    normalizeRuntimeState({
      version: 2,
      cursors: { resume: null, detail: null },
      lastRun: null,
      updatedAt: null,
    }).history,
    snapshot.records,
    snapshot.capturedAt,
  );
  return { envelope, history, record };
}

test('completed checkpoint replay never bypasses the budget for later queued conversations', async (t) => {
  for (const [maxRequests, expectedRequests, expectedPending, expectedCommits] of [
    [20, 20, 1, 11],
    [0, 0, 11, 1],
    [1, 0, 11, 1],
  ]) {
    await t.test(`budget ${maxRequests}`, async (t) => {
      const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-history-replay-budget-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const { envelope, history } = changedHistoryFixture(12);
      const completed = pendingHistory(history)[0];
      await saveChangeCheckpoint(directory, {
        version: 2,
        capturedAt: envelope.snapshot.capturedAt,
        nextConversationKey: null,
        nextPage: 0,
        completedConversationKey: completed.key,
        targetFingerprint: completed.task.fingerprint,
        head: 'saved-head',
        observations: [],
        unresolved: [],
        coverage: {},
        usage: { historyRequests: 2 },
        partial: false,
        error: null,
      });
      let requests = 0;
      let commits = 0;
      const result = await collectChangedResume({
        directory,
        connection: {},
        envelope,
        runtime: { history },
        maxRequests,
        requestDelayMs: 0,
        betweenTargetsDelayMs: 0,
        reportOperation: async () => ({ ok: true, report: {} }),
        saveEvidence: async () => {
          commits += 1;
        },
        saveProgress: async () => {},
        evaluate: async (_connection, _expression, metadata) => {
          assert.notEqual(metadata.conversationKey, completed.key);
          requests += 1;
          return metadata.kind === 'friend'
            ? { ok: true, identity: { bossId: 'synthetic-boss', securityId: 'synthetic-security' } }
            : {
                ok: true,
                observations: [],
                unresolved: [],
                messageIds: [`head-${metadata.conversationKey}`],
                exhausted: true,
                page: metadata.page,
              };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.partial, false);
      assert.equal(result.usage.historyRequests, expectedRequests);
      assert.equal(requests, expectedRequests);
      assert.equal(commits, expectedCommits);
      assert.equal(pendingHistory(result.state).length, expectedPending);
      assert.equal(
        result.state.conversations.find((item) => item.key === completed.key).watermark,
        'saved-head',
      );
      assert.equal(await loadChangeCheckpoint(directory), null);
    });
  }
});

test('failed run reports the saved change-history backlog rather than leaving an old completion status', () => {
  const { history, record } = changedHistoryFixture(16);
  const savedRuntime = normalizeRuntimeState({
    version: 3,
    cursors: { resume: record.key, detail: null },
    history,
    lastRun: null,
    updatedAt: null,
  });
  const usage = { historyRequests: 20, domSwitches: 0, detailNavigations: 0, cdpReconnects: 0 };
  const report = trackerFailureReport(new Error('RESUME_SCAN_INPUT_INVALID'), {
    mode: 'run',
    historyMode: 'change',
    usage,
    savedRuntime,
  });
  assert.deepEqual(report.history, {
    mode: 'change',
    initializedDay: '2026-09-24',
    pending: 16,
    paginating: 0,
    completed: 0,
    truncated: 0,
    waitingRetry: 0,
    failed: 0,
    isolated: 0,
    backfillCursor: record.key,
  });
  assert.equal(report.error, 'RESUME_SCAN_INPUT_INVALID');
  assert.deepEqual(report.usage, usage);
  assert.equal(report.runtimeSaved, true);
  assert.equal(JSON.stringify(report).includes('Synthetic contact'), false);
  assert.equal(JSON.stringify(report).includes('ordinary'), false);

  const unavailable = trackerFailureReport(new Error('RUNTIME_STATE_UNREADABLE'), {
    mode: 'run',
    historyMode: 'change',
    usage,
  });
  assert.equal(unavailable.runtimeSaved, false);
  assert.equal(Object.hasOwn(unavailable, 'history'), false);
});

test('change history preflight preserves the identity failure and reports zero new requests', async (t) => {
  const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-history-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { envelope, history } = changedHistoryFixture();
  const result = await collectChangedResume({
    directory,
    connection: {},
    envelope,
    runtime: { history },
    maxRequests: 4,
    reportOperation: async () => ({ ok: false, report: { error: 'ACCOUNT_NAMESPACE_CHANGED' } }),
    evaluate: async () => assert.fail('platform must not be accessed after failed preflight'),
    saveEvidence: async () => assert.fail('failed preflight cannot commit evidence'),
    saveProgress: async () => assert.fail('failed preflight cannot advance progress'),
  });
  assert.equal(result.error, 'ACCOUNT_NAMESPACE_CHANGED');
  assert.equal(result.partial, true);
  assert.deepEqual(result.usage, { historyRequests: 0 });
  assert.deepEqual(result.envelope, envelope);
  assert.deepEqual(result.state, history);
});

test('evidence save failure retains issued history usage and replays without another request', async (t) => {
  const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-history-evidence-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { envelope, record, history: initialHistory } = changedHistoryFixture();
  let history = initialHistory;
  let requests = 0;
  const base = {
    directory,
    connection: {},
    envelope,
    maxRequests: 4,
    requestDelayMs: 0,
    betweenTargetsDelayMs: 0,
    reportOperation: async () => ({ ok: true, report: {} }),
    saveProgress: async (value) => {
      history = value;
    },
  };
  await assert.rejects(
    collectChangedResume({
      ...base,
      runtime: { history },
      saveEvidence: async () => {
        throw new Error('LOCAL_EVIDENCE_FAILED');
      },
      evaluate: async (_connection, _expression, metadata) => {
        requests += 1;
        return metadata.kind === 'friend'
          ? { ok: true, identity: { bossId: 'boss901', securityId: 'security901' } }
          : {
              ok: true,
              observations: [],
              unresolved: [],
              messageIds: ['ordinary901'],
              exhausted: true,
              page: metadata.page,
            };
      },
    }),
    (error) => {
      assert.equal(error.message, 'LOCAL_EVIDENCE_FAILED');
      assert.deepEqual(error.usage, { historyRequests: 2 });
      return true;
    },
  );
  const checkpoint = await loadChangeCheckpoint(directory);
  assert.equal(checkpoint.completedConversationKey, record.key);
  assert.equal(checkpoint.usage.historyRequests, 2);
  await assert.rejects(
    collectChangedResume({
      ...base,
      runtime: { history },
      saveEvidence: async () => {
        throw new Error('LOCAL_EVIDENCE_FAILED');
      },
      evaluate: async () => assert.fail('completed evidence must replay locally'),
    }),
    (error) => {
      assert.deepEqual(error.usage, { historyRequests: 0 });
      return true;
    },
  );
  const recovered = await collectChangedResume({
    ...base,
    runtime: { history },
    saveEvidence: async () => {},
    evaluate: async () => {
      throw new Error('PLATFORM_SHOULD_NOT_BE_CALLED');
    },
  });
  assert.equal(recovered.usage.historyRequests, 0);
  assert.equal(requests, 2);
  assert.equal(history.conversations[0].watermark, 'ordinary901');
});

test('checkpoint write failure retains the issued request count for both history modes', async (t) => {
  for (const [collect, checkpointName] of [
    [collectChangedResume, '.change-checkpoint-v1.json'],
    [collectResume, '.resume-checkpoint-v1.json'],
  ]) {
    await t.test(checkpointName, async (t) => {
      const directory = await mkdtemp(
        join(privateTemporaryRoot, 'boss-history-checkpoint-failure-'),
      );
      t.after(() => rm(directory, { recursive: true, force: true }));
      const { envelope, history } = changedHistoryFixture();
      let requests = 0;
      await assert.rejects(
        collect({
          directory,
          connection: {},
          envelope,
          runtime: { history, cursors: { resume: null, detail: null } },
          maxRequests: 4,
          reportOperation: async () => ({ ok: true, report: {} }),
          evaluate: async () => {
            requests += 1;
            await mkdir(join(directory, checkpointName));
            return { ok: true, identity: { bossId: 'boss901', securityId: 'security901' } };
          },
        }),
        (error) => {
          assert.deepEqual(error.usage, { historyRequests: 1 });
          return true;
        },
      );
      assert.equal(requests, 1);
    });
  }
});

test('history export failure retains issued usage and local recovery failures use zero', async (t) => {
  const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-history-export-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { envelope, history } = changedHistoryFixture();
  let requests = 0;
  const base = {
    directory,
    connection: {},
    envelope,
    runtime: { history },
    maxRequests: 4,
    requestDelayMs: 0,
    betweenTargetsDelayMs: 0,
    reportOperation: async () => ({ ok: true, report: {} }),
    saveProgress: async () => {},
    saveEvidence: (value) =>
      saveEnvelope(directory, value, {
        exportJobs: async () => {
          throw new TypeError('SYNTHETIC_PRIVATE_CHAT invalid export');
        },
      }),
  };
  const assertFailure = (used) => async (error) => {
    assert.equal(error.message, 'JOB_EXPORT_FAILED');
    assert.deepEqual(error.usage, { historyRequests: used });
    assert.equal(error.snapshotPath, (await latest(directory)).path);
    assert.equal(String(error).includes('SYNTHETIC_PRIVATE_CHAT'), false);
    return true;
  };
  for (const expectedUsage of [2, 0]) {
    let caught;
    try {
      await collectChangedResume({
        ...base,
        evaluate: async (_connection, _expression, metadata) => {
          requests += 1;
          return metadata.kind === 'friend'
            ? { ok: true, identity: { bossId: 'boss901', securityId: 'security901' } }
            : {
                ok: true,
                observations: [],
                unresolved: [],
                messageIds: ['ordinary901'],
                exhausted: true,
                page: metadata.page,
              };
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, 'export must fail after snapshot commit');
    await assertFailure(expectedUsage)(caught);
    assert.equal(requests, 2);
  }
});

test('export failure reports a safe code while keeping its committed snapshot recoverable', async (t) => {
  const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-export-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envelope = compareLoadedSnapshotsV2(null, {
    capturedAt: '2026-09-24T02:00:00.000Z',
    scope: 'loaded-chat-list',
    accountNamespace: `boss-geek:${'a'.repeat(64)}`,
    records: [],
    coverage: {
      loadedRows: 0,
      loadedDataRows: 0,
      renderedRows: 0,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  }).envelope;
  let failure;
  await assert.rejects(
    saveEnvelope(directory, envelope, {
      exportJobs: async () => {
        throw new TypeError('SYNTHETIC_PRIVATE_CHAT SYNTHETIC_PAT invalid export field');
      },
    }),
    (error) => {
      failure = error;
      assert.equal(error.message, 'JOB_EXPORT_FAILED');
      assert.equal(JSON.stringify(error).includes('SYNTHETIC_PRIVATE_CHAT'), false);
      assert.equal(String(error).includes('SYNTHETIC_PAT'), false);
      return true;
    },
  );
  const saved = await latest(directory);
  assert.equal(saved.path, failure.snapshotPath);
  assert.deepEqual(saved.envelope, envelope);
  const recovered = await saveEnvelope(directory, saved.envelope);
  assert.equal(recovered.jobsFile, join(directory, 'jobs.md'));
  assert.match(await readFile(recovered.jobsFile, 'utf8'), /BOSS/);
});

test('v5 本地状态命令仍计算详情待处理和 DOM 状态，不访问浏览器', async (t) => {
  const { mkdir } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { commit } = await import('./storage.mjs');
  const root = await mkdtemp(join(tmpdir(), 'boss-v4-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'main');
  await mkdir(directory);
  const namespace = `boss-geek:${'a'.repeat(64)}`;
  const { envelope } = compareLoadedSnapshotsV2(null, {
    capturedAt: '2026-09-29T00:00:00.000Z',
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records: [],
    coverage: {
      loadedRows: 0,
      loadedDataRows: 0,
      renderedRows: 0,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  });
  await commit(directory, envelope);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [new URL('./tracker.mjs', import.meta.url).pathname, 'status', '--account', 'main'],
    { env: { ...process.env, JOB_TRACKER_BOSS_DATA_ROOT: root } },
  );
  const status = JSON.parse(stdout);
  assert.equal(status.version, 5);
  assert.equal(status.connectionSaved, false);
  assert.equal(status.detailEnrichment.pending, 0);
  assert.notEqual(status.dom, null);
});
