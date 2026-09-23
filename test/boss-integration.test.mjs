import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BossInbox, validateBossBatch, validateBossReceipt } from '../scripts/boss-inbox.mjs';
import {
  checkCommand,
  createDatedYesterdayBatch,
  createResumeEvents,
  createEvents,
  createInitialBatch,
  createResumeBatch,
  createResumeStatusEvents,
  enqueueCommand,
  enqueueDatedYesterdayCommand,
  enqueueResumeCommand,
  isFatalTrackerCode,
  main,
  previewInitialEnvelope,
  previewCommand,
  readBossConfig,
  readTrackerSnapshot,
  recoverSavedCommand,
  reserveCheckAttempt,
  resumeCommand,
  stableHash,
  validateTrackerEnvelope,
} from '../scripts/boss-integration.mjs';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const START = '2026-09-18T14:45:09.648Z';
const FIRST_NAME = '2026-09-18T14-49-59-473Z_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json';
const SECOND_NAME = '2026-09-18T15-00-00-000Z_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json';

test('legacy trackerRoot is accepted only as migration input and cannot choose executable code', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-boss-config-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      bossIntegration: {
        trackerRoot: join(root, 'untrusted-collector'),
        account: 'main',
        initialSnapshot: FIRST_NAME,
      },
    }),
    { mode: 0o600 },
  );
  const config = await readBossConfig(configPath);
  assert.notEqual(config.trackerRoot, join(root, 'untrusted-collector'));
  assert.match(config.trackerRoot, /\/collector\/boss$/);
  assert.match(config.dataRoot, /\/\.local\/boss-collector$/);
});

function fixture({
  rows = 100,
  capturedAt = START,
  summary = '摘要',
  companyConflict = false,
} = {}) {
  const records = [];
  const associations = [];
  const evidence = [];
  for (let index = 0; index < rows; index += 1) {
    const friendId = String(index + 1);
    const friendSource = '1';
    const key = stableHash(['boss', ACCOUNT, friendId, friendSource]);
    const jobId = `job_${index + 1}`;
    const detailUrl = `https://www.zhipin.com/job_detail/${jobId}.html`;
    records.push({
      key,
      platformIdentity: { friendId, friendSource, uniqueId: `${friendId}-${friendSource}` },
      contact: `联系人${index + 1}`,
      company: '测试公司',
      title: '',
      preview: summary,
      timeLabel: index < 30 ? '14:08' : index < 40 ? '昨天' : '',
      unread: null,
      latestMessageId: `message_${index + 1}`,
      outgoingReceipt: { status: 'unknown', label: null, source: null },
      jobAssociation: { jobId, detailUrl },
      observedJobName: null,
    });
    associations.push({ conversationKey: key, jobId, detailUrl, status: 'current' });
    evidence.push({
      jobId,
      detailUrl,
      name: `岗位${index + 1}`,
      source: 'loaded_jobName',
      company: companyConflict && index === 0 ? '另一家公司' : '测试公司',
      observedAt: capturedAt,
    });
  }
  return {
    version: 2,
    scope: 'loaded-chat-list',
    accountNamespace: ACCOUNT,
    createdAt: capturedAt,
    updatedAt: capturedAt,
    snapshot: {
      capturedAt,
      scope: 'loaded-chat-list',
      accountNamespace: ACCOUNT,
      records,
      coverage: {
        loadedRows: rows,
        loadedDataRows: rows,
        renderedRows: rows,
        offscreenRows: 0,
        unresolvedRows: 0,
        truncated: false,
      },
    },
    state: {},
    report: {},
    migration: {},
    jobs: { associations, evidence, candidates: [], confirmations: [] },
  };
}

function resumeObservation(envelope, overrides = {}) {
  const record = envelope.snapshot.records[0];
  return {
    id: 'e'.repeat(64),
    conversationKey: record.key,
    platformIdentity: structuredClone(record.platformIdentity),
    messageId: 'resume-message-1',
    direction: 'outbound',
    messageType: 4,
    kind: 'sent_candidate',
    platformTime: '2026-09-20T08:00:00.000Z',
    externalJobId: 'job_1',
    observedAt: '2026-09-20T08:01:00.000Z',
    source: 'geek_history_type_4',
    status: 'strong',
    ...overrides,
  };
}

function stateRecord(record, firstObservedAt, lastObservedAt) {
  return {
    key: record.key,
    platformIdentity: structuredClone(record.platformIdentity),
    contact: record.contact,
    company: record.company,
    title: record.title,
    firstObservedAt,
    lastObservedAt,
    latestObservation: {
      preview: record.preview,
      timeLabel: record.timeLabel,
      unread: record.unread,
      latestMessageId: record.latestMessageId,
      outgoingReceipt: structuredClone(record.outgoingReceipt),
    },
  };
}

function attachDurableState(envelope, records = envelope.snapshot.records) {
  envelope.state = {
    baselineCapturedAt: START,
    lastCapturedAt: envelope.snapshot.capturedAt,
    records: records.map((record) => stateRecord(record, START, envelope.snapshot.capturedAt)),
  };
  return envelope;
}

test('采集快照 v3 使用既有安全结构，旧 v2 仍可读取', () => {
  assert.equal(validateTrackerEnvelope(fixture({ rows: 1 })).version, 2);
  assert.equal(validateTrackerEnvelope({ ...fixture({ rows: 1 }), version: 3 }).version, 3);
  assert.throws(() => validateTrackerEnvelope({ ...fixture({ rows: 1 }), version: 4 }));
});

test('v3 接受经私有策略验收的 DOM 状态证据，但拒绝未知来源', () => {
  const envelope = { ...fixture({ rows: 1 }), version: 3 };
  envelope.resume = {
    observations: [
      resumeObservation(envelope, {
        direction: 'system',
        messageType: 5,
        kind: 'request_sent',
        source: 'dom_chat_status_message_v1',
      }),
    ],
    lastScanAt: null,
    lastCoverage: null,
    lastUnresolved: [],
  };
  assert.doesNotThrow(() => validateTrackerEnvelope(envelope));
  envelope.resume.observations[0].source = 'untrusted_dom_source';
  assert.throws(() => validateTrackerEnvelope(envelope), /BOSS_SNAPSHOT_RESUME_INVALID/);
});

test('v3 历史简历观察只接受 durable state 中已验证的会话身份', () => {
  const envelope = attachDurableState({ ...fixture({ rows: 2 }), version: 3 });
  const observation = resumeObservation(envelope);
  envelope.resume = {
    observations: [observation],
    lastScanAt: envelope.snapshot.capturedAt,
    lastCoverage: {
      requestedConversations: 1,
      resolvedConversations: 1,
      pagesPerConversation: 1,
      requestedPages: 1,
      completedPages: 1,
      exhaustedConversations: 1,
      truncatedConversations: 0,
      failedConversations: 0,
    },
    lastUnresolved: [],
  };
  envelope.snapshot.records = envelope.snapshot.records.slice(1);
  Object.assign(envelope.snapshot.coverage, {
    loadedRows: 1,
    loadedDataRows: 1,
    renderedRows: 1,
    offscreenRows: 0,
    unresolvedRows: 0,
  });
  assert.doesNotThrow(() => validateTrackerEnvelope(envelope));

  const missingDirectAssociation = structuredClone(envelope);
  missingDirectAssociation.snapshot.records[0].jobAssociation = {
    jobId: null,
    detailUrl: null,
  };
  assert.throws(
    () => validateTrackerEnvelope(missingDirectAssociation),
    /BOSS_SNAPSHOT_JOB_CONFLICT/,
  );

  const unknown = structuredClone(envelope);
  unknown.resume.observations[0].conversationKey = 'f'.repeat(64);
  assert.throws(() => validateTrackerEnvelope(unknown), /BOSS_SNAPSHOT_RESUME_INVALID/);

  const observationConflict = structuredClone(envelope);
  observationConflict.resume.observations[0].platformIdentity.uniqueId = 'identity-conflict';
  assert.throws(() => validateTrackerEnvelope(observationConflict), /BOSS_SNAPSHOT_RESUME_INVALID/);

  const duplicateState = structuredClone(envelope);
  duplicateState.state.records.push(structuredClone(duplicateState.state.records[0]));
  assert.throws(() => validateTrackerEnvelope(duplicateState), /BOSS_SNAPSHOT_IDENTITY_INVALID/);

  const orphanAssociation = structuredClone(envelope);
  orphanAssociation.jobs.associations[0].conversationKey = 'f'.repeat(64);
  assert.throws(() => validateTrackerEnvelope(orphanAssociation), /BOSS_SNAPSHOT_JOB_INVALID/);
});

test('v3 分页历史覆盖统计保持严格字段和交叉约束', () => {
  const envelope = { ...fixture({ rows: 1 }), version: 3 };
  envelope.resume = {
    observations: [],
    lastScanAt: envelope.snapshot.capturedAt,
    lastCoverage: {
      requestedConversations: 1,
      resolvedConversations: 1,
      pagesPerConversation: 2,
      requestedPages: 2,
      completedPages: 2,
      exhaustedConversations: 1,
      truncatedConversations: 0,
      failedConversations: 0,
    },
    lastUnresolved: [],
  };
  assert.doesNotThrow(() => validateTrackerEnvelope(envelope));
  const partial = structuredClone(envelope);
  delete partial.resume.lastCoverage.exhaustedConversations;
  delete partial.resume.lastCoverage.truncatedConversations;
  delete partial.resume.lastCoverage.failedConversations;
  assert.doesNotThrow(() => validateTrackerEnvelope(partial));
  const impossible = structuredClone(envelope);
  impossible.resume.lastCoverage.completedPages = 3;
  assert.throws(() => validateTrackerEnvelope(impossible), /BOSS_SNAPSHOT_RESUME_INVALID/);
  const unknown = structuredClone(envelope);
  unknown.resume.lastCoverage.futureCounter = 0;
  assert.throws(() => validateTrackerEnvelope(unknown), /BOSS_SNAPSHOT_RESUME_INVALID/);
});

async function tempProject(t, envelope = fixture()) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-boss-test-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const trackerRoot = join(root, 'tracker');
  const data = join(trackerRoot, 'data', 'main');
  await mkdir(data, { recursive: true });
  const bytes = `${JSON.stringify(envelope)}\n`;
  await writeFile(join(data, FIRST_NAME), bytes, { mode: 0o600 });
  const config = { trackerRoot, account: 'main', initialSnapshot: FIRST_NAME };
  const inbox = new BossInbox(join(root, 'private', 'boss-integration'));
  const expectedInitial = {
    name: FIRST_NAME,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return { root, trackerRoot, data, config, inbox, expectedInitial };
}

async function runMainQuietly(argv, options) {
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  const output = [];
  console.log = (...parts) => output.push(parts.join(' '));
  try {
    await main(argv, options);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
  return JSON.parse(output.at(-1));
}

test('initial snapshot uses fixed 2026-09-18 label selection and stable event identity', async (t) => {
  const { data } = await tempProject(t);
  const snapshot = await readTrackerSnapshot(join(data, FIRST_NAME));
  assert.deepEqual(previewInitialEnvelope(snapshot.envelope), {
    total: 100,
    included: 30,
    excludedYesterday: 10,
    unknownTime: 60,
    otherTime: 0,
    complete: 30,
    review: 0,
  });
  const batch = createInitialBatch(snapshot, 1);
  assert.equal(batch.events.length, 30);
  assert.ok(batch.events.every((item) => item.appliedAtForNew === '2026-09-18'));
  const second = structuredClone(snapshot.envelope);
  second.snapshot.capturedAt = '2026-09-19T00:01:00.000Z';
  second.snapshot.records[0].timeLabel = '昨天';
  assert.equal(
    createEvents(second, { sourceSequence: 10 })[0].eventId,
    createEvents(snapshot.envelope, { sourceSequence: 1 })[0].eventId,
  );
});

test('用户确认日期批次只纳入“昨天”，新建日期明确且岗位证据补齐后推进检查点', async (t) => {
  const { config, data, inbox, expectedInitial } = await tempProject(t);
  await enqueueCommand(config, inbox, expectedInitial);
  const first = await readTrackerSnapshot(join(data, FIRST_NAME));
  const batch = createDatedYesterdayBatch(first, 1, '2026-09-20');
  assert.equal(batch.policy.mode, 'dated');
  assert.equal(batch.policy.appliedAtForNew, '2026-09-20');
  assert.equal(batch.events.length, 10);
  assert.ok(batch.events.every((event) => event.timeLabel === '昨天'));
  assert.ok(batch.events.every((event) => event.evidenceDate === '2026-09-20'));

  const enriched = fixture();
  enriched.jobs.evidence[30].name = '补齐后的岗位';
  await writeFile(join(data, SECOND_NAME), `${JSON.stringify(enriched)}\n`, { mode: 0o600 });
  const queued = await enqueueDatedYesterdayCommand(config, inbox, '2026-09-20');
  assert.equal(queued.batch.sourceSequence, 2);
  assert.equal(queued.batch.events.length, 10);
  assert.equal(queued.counts.complete, 10);
  assert.equal((await inbox.readControl()).checkpoint.snapshotName, SECOND_NAME);
  const replay = await enqueueDatedYesterdayCommand(config, inbox, '2026-09-20');
  assert.equal(replay.queued.created, false);
});

test('简历观察独立入队、只读且重复执行不重复排队', async (t) => {
  const { config, data, inbox, expectedInitial } = await tempProject(t);
  await enqueueCommand(config, inbox, expectedInitial);
  const observed = fixture();
  observed.resume = {
    observations: [resumeObservation(observed)],
    lastScanAt: '2026-09-20T08:01:00.000Z',
    lastCoverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 1 },
    lastUnresolved: [],
  };
  observed.updatedAt = observed.resume.lastScanAt;
  await writeFile(join(data, SECOND_NAME), `${JSON.stringify(observed)}\n`, { mode: 0o600 });
  const snapshot = await readTrackerSnapshot(join(data, SECOND_NAME));
  const batch = createResumeBatch(snapshot, 2);
  assert.equal(batch.policy.mode, 'resume');
  assert.equal(batch.policy.autoCreateComplete, false);
  assert.equal(batch.events[0].eventType, 'resume_observed');
  assert.equal(batch.events[0].intent, 'observe_only');
  assert.equal(batch.events[0].summary, 'resume_sent_candidate');
  const dated = createResumeBatch(snapshot, 2, '2026-09-20');
  assert.equal(dated.policy.id, 'boss-resume-observation-date-2026-09-20-v3');
  assert.equal(dated.events[0].evidenceDate, '2026-09-20');
  assert.throws(() => createResumeBatch(snapshot, 2, '2026-09-19'), /EMPTY/);

  const queued = await enqueueResumeCommand(config, inbox);
  assert.equal(queued.queued.created, true);
  assert.equal(queued.counts.strong, 1);
  assert.equal((await inbox.readControl()).checkpoint.snapshotName, SECOND_NAME);
  const replay = await enqueueResumeCommand(config, inbox);
  assert.equal(replay.queued.created, false);
  assert.equal(replay.counts.events, 0);
});

test('同一消息的重复简历观察只生成一个事件，独立状态事实保留', () => {
  const envelope = fixture({ rows: 1 });
  const duplicate = resumeObservation(envelope, {
    direction: 'inbound',
    kind: 'resume_card_other',
    externalJobId: null,
    status: 'review',
  });
  envelope.resume = {
    observations: [
      duplicate,
      {
        ...duplicate,
        id: 'd'.repeat(64),
        platformTime: '2026-09-20T08:00:00.280Z',
      },
      resumeObservation(envelope, {
        id: 'c'.repeat(64),
        direction: 'system',
        messageType: 5,
        kind: 'request_sent',
        externalJobId: null,
        source: 'geek_history_status_message',
        status: 'review',
      }),
    ],
    lastScanAt: '2026-09-20T08:01:00.000Z',
    lastCoverage: null,
    lastUnresolved: [],
  };
  const events = createResumeEvents(envelope, { sourceSequence: 2 });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.summary).sort(), [
    'resume_card_other',
    'resume_request_sent',
  ]);
  assert.equal(
    events.find((event) => event.summary === 'resume_card_other').observedAt,
    '2026-09-20T08:00:00.000Z',
  );
});

test('平台简历状态文案只按精确规则生成可关联事件', () => {
  const envelope = fixture();
  envelope.snapshot.records[30].preview = '您的附件简历 示例文件.pdf 已发送给Boss';
  envelope.snapshot.records[31].preview = '您的附件简历 示例文件.pdf 已发送给Boss点击查看附件';
  envelope.snapshot.records[32].preview = '您的附件简历 已发送';
  const events = createResumeStatusEvents(envelope, {
    sourceSequence: 2,
    evidenceDate: '2026-09-20',
  });
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => event.summary),
    ['resume_attachment_sent', 'resume_attachment_sent'],
  );
  assert.deepEqual(
    events.map((event) => event.externalJobId),
    ['job_31', 'job_32'],
  );
});

test('历史状态缺岗位 ID 时只用会话唯一岗位补齐', () => {
  const envelope = fixture({ rows: 1 });
  envelope.resume = {
    observations: [
      {
        id: 'f'.repeat(64),
        conversationKey: envelope.snapshot.records[0].key,
        platformIdentity: structuredClone(envelope.snapshot.records[0].platformIdentity),
        messageId: 'resume-status-1',
        direction: 'system',
        messageType: 5,
        kind: 'request_sent',
        platformTime: '2026-09-20T03:00:00.000Z',
        externalJobId: null,
        observedAt: '2026-09-21T03:00:00.000Z',
        source: 'geek_history_status_message',
        status: 'review',
      },
    ],
    lastScanAt: null,
    lastCoverage: null,
    lastUnresolved: [],
  };
  const [event] = createResumeEvents(envelope, {
    sourceSequence: 2,
    evidenceDate: '2026-09-20',
  });
  assert.equal(event.summary, 'resume_request_sent');
  assert.equal(event.externalJobId, 'job_1');
});

test('initial import refuses changed bytes even when counts remain 30/10/60', async (t) => {
  const { config, data, inbox, expectedInitial } = await tempProject(t);
  const approved = await previewCommand(config, expectedInitial);
  assert.equal(approved.counts.included, 30);
  const changed = fixture({ summary: '不同摘要' });
  await writeFile(join(data, FIRST_NAME), `${JSON.stringify(changed)}\n`, { mode: 0o600 });
  await assert.rejects(previewCommand(config, expectedInitial), /BOSS_INITIAL_SNAPSHOT_CHANGED/);
  await assert.rejects(
    enqueueCommand(config, inbox, expectedInitial),
    /BOSS_INITIAL_SNAPSHOT_CHANGED/,
  );
  assert.equal((await inbox.list()).length, 0);
});

test('company-mismatched title evidence stays review-only', async (t) => {
  const { data } = await tempProject(t, fixture({ rows: 1, companyConflict: true }));
  const snapshot = await readTrackerSnapshot(join(data, FIRST_NAME));
  const [event] = createEvents(snapshot.envelope, { sourceSequence: 1 });
  assert.equal(event.intent, 'review');
  assert.equal(event.jobName, '');
});

test('inbound and unknown do not become delivered or read receipts; invalid dates fail', async (t) => {
  const { data } = await tempProject(t, fixture({ rows: 1 }));
  const snapshot = await readTrackerSnapshot(join(data, FIRST_NAME));
  const batch = createInitialBatch(snapshot, 1);
  const event = batch.events[0];
  assert.equal(event.messageDirection, 'unknown');
  assert.equal(event.receiptStatus, 'unknown');
  event.messageDirection = 'inbound';
  event.receiptStatus = 'not_applicable';
  const facts = {
    platform: 'boss',
    accountNamespace: batch.accountNamespace,
    conversationKey: event.conversationKey,
    friendId: event.friendId,
    friendSource: event.friendSource,
    uniqueId: event.uniqueId,
    externalJobId: event.externalJobId,
    canonicalUrl: event.canonicalUrl,
    jobName: event.jobName,
    company: event.company,
    contact: event.contact,
    summary: event.summary,
    messageId: event.messageId,
    messageDirection: event.messageDirection,
    receiptStatus: event.receiptStatus,
    receiptSource: event.receiptSource,
    nameSource: event.nameSource,
    linkConfirmation: event.linkConfirmation,
    intent: event.intent,
  };
  event.eventId = `boss-event-${stableHash(facts)}`;
  batch.batchId = `boss-batch-${stableHash({
    policy: batch.policy.id,
    snapshotSha256: batch.source.snapshotSha256,
    accountNamespace: batch.accountNamespace,
    eventIds: [event.eventId],
  })}`;
  assert.equal(validateBossBatch(batch).events[0].receiptStatus, 'not_applicable');
  const bad = structuredClone(batch);
  bad.events[0].receiptStatus = 'delivered';
  assert.throws(() => validateBossBatch(bad));
  bad.events[0] = structuredClone(event);
  bad.events[0].appliedAtForNew = '2026-02-30';
  assert.throws(() => validateBossBatch(bad));
});

test('inbox is immutable, private, and does not chmod a shared parent', async (t) => {
  const { root, data, inbox } = await tempProject(t, fixture({ rows: 1 }));
  await chmod(root, 0o755);
  const beforeMode = (await lstat(root)).mode & 0o777;
  const snapshot = await readTrackerSnapshot(join(data, FIRST_NAME));
  const batch = createInitialBatch(snapshot, 1);
  assert.equal(batch.version, 2);
  // A v1 batch with the same deterministic identity is the same immutable
  // input, not a conflicting second batch after the protocol upgrade.
  const first = await inbox.enqueue({ ...batch, version: 1 });
  const second = await inbox.enqueue(batch);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal((await lstat(root)).mode & 0o777, beforeMode);
  assert.equal((await lstat(inbox.root)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(inbox.inbox, `${batch.batchId}.json`))).mode & 0o777, 0o600);
  const source = randomUUID();
  const receipt = {
    format: 'job-tracker-boss-receipt',
    version: 1,
    batchId: batch.batchId,
    workspaceSourceId: source,
    status: 'processed',
    processedAt: new Date().toISOString(),
    counts: { added: 1, linked: 0, observed: 1, reviewed: 0, skipped: 0 },
    errorCode: '',
  };
  assert.throws(() =>
    validateBossReceipt({ ...receipt, status: 'blocked', errorCode: 'CONFLICT' }),
  );
  await inbox.acknowledge(batch.batchId, receipt);
  assert.equal(validateBossReceipt({ ...receipt, version: 2 }).version, 2);
  assert.equal((await inbox.status()).pending, 0);
  assert.equal((await inbox.status()).processedBatches, 1);
  assert.equal((await inbox.status({ workspaceSourceId: source })).pending, 0);
  assert.equal(
    (await readFile(join(inbox.receipts, batch.batchId, `${source}.json`), 'utf8')).includes(
      'processed',
    ),
    true,
  );
});

test('queue-before-checkpoint crash replays identical batch without duplicate', async (t) => {
  const { root, config, inbox, expectedInitial } = await tempProject(t);
  const failing = new BossInbox(join(root, 'private', 'boss-integration'), {
    beforeCommit: async (kind) => {
      if (kind === 'control') throw new Error('synthetic-crash');
    },
  });
  await assert.rejects(enqueueCommand(config, failing, expectedInitial), /synthetic-crash/);
  assert.equal((await inbox.list()).length, 1);
  assert.equal(await inbox.readControl(), null);
  const replay = await enqueueCommand(config, inbox, expectedInitial);
  assert.equal(replay.queued.created, false);
  assert.equal((await inbox.list()).length, 1);
  assert.equal((await inbox.readControl()).checkpoint.sourceSequence, 1);
});

test('saved snapshot recovers before any browser command and only merges duplicate clicks', async (t) => {
  const { config, data, inbox, expectedInitial } = await tempProject(t);
  await enqueueCommand(config, inbox, expectedInitial);
  const newer = attachDurableState({
    ...fixture({ capturedAt: '2026-09-21T08:01:00.000Z' }),
    version: 3,
  });
  newer.resume = {
    observations: [
      resumeObservation(newer, {
        direction: 'system',
        messageType: 5,
        kind: 'sent_confirmed',
        source: 'geek_history_status_message',
      }),
    ],
    lastScanAt: newer.snapshot.capturedAt,
    lastCoverage: {
      requestedConversations: 1,
      resolvedConversations: 1,
      pagesPerConversation: 1,
    },
    lastUnresolved: [],
  };
  newer.snapshot.records[1].preview = '同日新消息';
  newer.snapshot.records = newer.snapshot.records.slice(1);
  Object.assign(newer.snapshot.coverage, {
    loadedRows: 99,
    loadedDataRows: 99,
    renderedRows: 99,
    offscreenRows: 0,
    unresolvedRows: 0,
  });
  await writeFile(join(data, SECOND_NAME), `${JSON.stringify(newer)}\n`, { mode: 0o600 });
  let invoked = false;
  const recovered = await checkCommand(config, inbox, {
    runner: async () => {
      invoked = true;
      throw new Error('browser must not run');
    },
    initialIdentity: expectedInitial,
  });
  assert.equal(recovered.checked, false);
  assert.equal(invoked, false);
  assert.deepEqual(recovered.usage, {
    historyRequests: 0,
    domSwitches: 0,
    detailNavigations: 0,
  });
  assert.equal(recovered.recovered.events, 72);
  assert.equal((await inbox.list()).length, 2);
  const later = (await inbox.list()).find((item) => item.policyMode === 'incremental');
  const events = (await inbox.read(later.batchId)).events;
  assert.equal(events.filter((item) => item.appliedAtForNew === '').length, 71);
  assert.deepEqual(
    events
      .filter((item) => item.timeLabel === '14:08')
      .map((item) => ({ evidenceDate: item.evidenceDate, appliedAtForNew: item.appliedAtForNew })),
    [{ evidenceDate: '2026-09-21', appliedAtForNew: '2026-09-21' }],
  );
  const resumeEvents = events.filter((item) => item.eventType === 'resume_observed');
  assert.equal(resumeEvents.length, 1);
  assert.equal(resumeEvents[0].messageId, 'resume-message-1');
  assert.equal(resumeEvents[0].summary, 'resume_sent_confirmed');
  assert.equal((await inbox.readControl()).checkpoint.snapshotName, SECOND_NAME);
  const base = await inbox.readControl();
  const first = reserveCheckAttempt(base, new Date('2026-09-19T02:00:00.000Z'));
  assert.throws(
    () => reserveCheckAttempt(first, new Date('2026-09-19T02:00:05.000Z')),
    /BOSS_CHECK_TOO_SOON/,
  );
  let next = base;
  for (let index = 0; index < 40; index += 1) {
    next = reserveCheckAttempt(
      next,
      new Date(Date.parse('2026-09-19T00:00:00.000Z') + index * 10_000),
    );
  }
  assert.doesNotThrow(() =>
    reserveCheckAttempt({ ...next, nextAllowedAt: '' }, new Date('2026-09-19T13:00:00.000Z')),
  );
  assert.doesNotThrow(() =>
    reserveCheckAttempt(
      {
        ...base,
        lastAttemptAt: '2026-09-19T02:00:00.000Z',
        nextAllowedAt: '2026-09-19T02:45:00.000Z',
      },
      new Date('2026-09-19T02:00:11.000Z'),
    ),
  );
  assert.ok(next.nextAllowedAt);
});

test('explicit resume clears pause but preserves browser budget and checkpoint', async (t) => {
  const { config, inbox, expectedInitial } = await tempProject(t);
  await enqueueCommand(config, inbox, expectedInitial);
  const control = await inbox.readControl();
  await inbox.writeControl({ ...control, paused: true, pauseCode: 'NOT_LOGGED_IN' });
  const resumed = await resumeCommand(inbox);
  assert.equal(resumed.resumed, true);
  const after = await inbox.readControl();
  assert.equal(after.paused, false);
  assert.deepEqual(after.checkpoint, control.checkpoint);
  assert.equal(after.nextAllowedAt, control.nextAllowedAt);
});

test('纯本地恢复只清除快照类暂停且不占平台额度', async (t) => {
  const { config, data, inbox, expectedInitial } = await tempProject(t);
  await enqueueCommand(config, inbox, expectedInitial);
  const newer = fixture({ capturedAt: '2026-09-21T08:01:00.000Z', summary: '新观察' });
  await writeFile(join(data, SECOND_NAME), `${JSON.stringify(newer)}\n`, { mode: 0o600 });
  const control = await inbox.readControl();
  await inbox.writeControl({
    ...control,
    paused: true,
    pauseCode: 'BOSS_SNAPSHOT_RESUME_INVALID',
  });
  const result = await recoverSavedCommand(config, inbox, () => {}, expectedInitial);
  assert.equal(result.recovered.recovered, 1);
  assert.equal(result.pauseCleared, true);
  assert.equal(result.requiresResume, false);
  assert.deepEqual(result.usage, {
    historyRequests: 0,
    domSwitches: 0,
    detailNavigations: 0,
  });
  assert.equal(result.control.checkpoint.snapshotName, SECOND_NAME);

  await inbox.writeControl({ ...result.control, paused: true, pauseCode: 'NOT_LOGGED_IN' });
  const protectedPause = await recoverSavedCommand(config, inbox, () => {}, expectedInitial);
  assert.equal(protectedPause.recovered.recovered, 0);
  assert.equal(protectedPause.pauseCleared, false);
  assert.equal(protectedPause.requiresResume, true);
  assert.equal(protectedPause.control.pauseCode, 'NOT_LOGGED_IN');
});

test('recover-saved CLI 原子补交本地快照且不调用采集器', async (t) => {
  const { root, config, data, inbox, expectedInitial } = await tempProject(t);
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ bossIntegration: config }), { mode: 0o600 });
  await enqueueCommand(config, inbox, expectedInitial);
  const newer = fixture({ capturedAt: '2026-09-21T08:01:00.000Z', summary: '本地恢复' });
  await writeFile(join(data, SECOND_NAME), `${JSON.stringify(newer)}\n`, { mode: 0o600 });
  const control = await inbox.readControl();
  await inbox.writeControl({
    ...control,
    paused: true,
    pauseCode: 'BOSS_SNAPSHOT_STRUCTURE_INVALID',
  });
  const output = await runMainQuietly(['recover-saved'], {
    configPath,
    configReader: async () => config,
    inboxRoot: inbox.root,
    initialIdentity: expectedInitial,
  });
  assert.equal(output.ok, true);
  assert.equal(output.localRecovery, true);
  assert.equal(output.checked, false);
  assert.equal(output.counts.recoveredSnapshots, 1);
  assert.equal(output.pauseCleared, true);
  assert.equal(output.requiresResume, false);
  assert.deepEqual(output.usage, {
    historyRequests: 0,
    domSwitches: 0,
    detailNavigations: 0,
  });
  assert.equal((await inbox.readControl()).checkpoint.snapshotName, SECOND_NAME);
  assert.equal((await readdir(inbox.runs)).length, 1);
  assert.deepEqual(await readdir(inbox.incidents), []);
});

test('paused producer refuses before any tracker or snapshot recovery action', async (t) => {
  const { config, inbox, expectedInitial } = await tempProject(t);
  await enqueueCommand(config, inbox, expectedInitial);
  const control = await inbox.readControl();
  await inbox.writeControl({ ...control, paused: true, pauseCode: 'NOT_LOGGED_IN' });
  let calls = 0;
  const stages = [];
  await assert.rejects(
    checkCommand(config, inbox, {
      runner: async () => {
        calls++;
        throw new Error('must not run');
      },
      onStage: (stage) => stages.push(stage),
      initialIdentity: expectedInitial,
    }),
    (error) => error.code === 'BOSS_INTEGRATION_PAUSED',
  );
  assert.equal(calls, 0);
  assert.deepEqual(stages, ['read_control']);
  assert.deepEqual((await inbox.readControl()).checkpoint, control.checkpoint);
});

test('login, empty chat list and nonzero tracker exit are fatal and never silently succeed', async (t) => {
  for (const code of ['NOT_LOGGED_IN', 'CHAT_LIST_NOT_READY', 'CONNECTION_REQUIRED'])
    assert.equal(isFatalTrackerCode(code), true);
  const { config, inbox, trackerRoot, expectedInitial } = await tempProject(t);
  await enqueueCommand(config, inbox, expectedInitial);
  await writeFile(join(trackerRoot, 'tracker.mjs'), '', { mode: 0o600 });
  const nonzeroSuccess = async () => {
    const error = new Error('synthetic nonzero exit');
    error.stdout = JSON.stringify({ ok: true, saved: true, file: '/private/tmp/synthetic.json' });
    throw error;
  };
  await assert.rejects(
    checkCommand(config, inbox, {
      now: () => new Date('2026-09-19T00:00:00.000Z'),
      runner: nonzeroSuccess,
    }),
    (error) => error.code === 'BOSS_TRACKER_EXIT_FAILED' && error.fatal,
  );
});

test('旧脚本拒绝直接check，collect-cycle没有controller单次授权也不能采集', async (t) => {
  const { inbox } = await tempProject(t);
  await assert.rejects(main(['check'], { inboxRoot: inbox.root }), {
    code: 'BOSS_USE_UNIFIED_RUNTIME',
  });
  await assert.rejects(
    main(
      ['collect-cycle', '--history-requests', '20', '--detail-limit', '20', '--dom-limit', '1'],
      {
        inboxRoot: inbox.root,
        internalAuthorization: '',
      },
    ),
    { code: 'BOSS_INTERNAL_AUTH_REQUIRED' },
  );
  await assert.rejects(
    main(
      ['collect-cycle', '--history-requests', '20', '--detail-limit', '21', '--dom-limit', '1'],
      {
        inboxRoot: inbox.root,
        internalAuthorization: '',
      },
    ),
    { code: 'BOSS_ARGUMENTS_INVALID' },
  );
  await assert.rejects(readdir(inbox.runs), { code: 'ENOENT' });
  await assert.rejects(readdir(inbox.incidents), { code: 'ENOENT' });
});

test('CLI enqueue failure after durable batch retains exact checkpoint stage and progress', async (t) => {
  const { root, config, inbox, expectedInitial } = await tempProject(t);
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ bossIntegration: config }), { mode: 0o600 });
  const output = await runMainQuietly(['enqueue'], {
    configPath,
    configReader: async () => config,
    inboxRoot: inbox.root,
    initialIdentity: expectedInitial,
    inboxFactory: (path) =>
      new BossInbox(path, {
        beforeCommit: async (kind) => {
          if (kind === 'control') throw new Error('synthetic checkpoint interruption');
        },
      }),
  });
  assert.equal(output.ok, false);
  assert.equal(output.step, 'commit_checkpoint');
  assert.equal(output.incidentRecorded, true);
  assert.equal((await inbox.list()).length, 1);
  assert.equal(await inbox.readControl(), null);
  const incidentName = (await readdir(inbox.incidents))[0];
  const incident = JSON.parse(await readFile(join(inbox.incidents, incidentName), 'utf8'));
  assert.equal(incident.step, 'commit_checkpoint');
  assert.equal(incident.errorCode, 'BOSS_INTEGRATION_FAILED');
  assert.equal(incident.counts.queuedBatches, 1);
  assert.equal(incident.counts.checkpointCommitted, 0);
  assert.equal(incident.completedItems, 1);
  assert.equal(incident.remainingItems, 1);
  assert.equal((await readdir(inbox.runs)).length, 1);
});

test('CLI preview, resume and config failures each preserve a private run and incident', async (t) => {
  for (const command of ['preview', 'resume', 'status']) {
    const { root, config, inbox, expectedInitial } = await tempProject(t);
    const configPath = join(root, 'config.json');
    if (command === 'preview') {
      await writeFile(configPath, JSON.stringify({ bossIntegration: config }), { mode: 0o600 });
      expectedInitial.sha256 = '0'.repeat(64);
    } else if (command === 'resume') {
      await writeFile(configPath, JSON.stringify({ bossIntegration: config }), { mode: 0o600 });
    }
    const output = await runMainQuietly([command], {
      configPath,
      ...(command === 'status' ? {} : { configReader: async () => config }),
      inboxRoot: inbox.root,
      initialIdentity: expectedInitial,
    });
    assert.equal(output.ok, false);
    assert.equal(output.incidentRecorded, true);
    assert.equal((await readdir(inbox.incidents)).length, 1);
    assert.equal((await readdir(inbox.runs)).length, 1);
    const incidentName = (await readdir(inbox.incidents))[0];
    const incident = JSON.parse(await readFile(join(inbox.incidents, incidentName), 'utf8'));
    assert.equal(
      incident.step,
      command === 'preview'
        ? 'read_initial_snapshot'
        : command === 'resume'
          ? 'resume_control'
          : 'read_config',
    );
    assert.ok(/^[A-Z][A-Z0-9_]+$/.test(incident.errorCode));
    assert.equal(JSON.stringify(output).includes('摘要'), false);
  }
});
