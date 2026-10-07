import { bossEventDigestInput, bossBatchDigestInput } from '../dist/boss-batch.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableHash } from '../scripts/boss-integration.mjs';
import { WorkspaceStore } from '../scripts/workspace-store.mjs';
import { validateBossBatch as validateQueuedBossBatch } from '../scripts/boss-inbox.mjs';
import { emptyData, live, markManualFields } from '../dist/model.js';
import { bossFactId } from '../dist/source-identity.js';
import {
  effectiveSourceFacts,
  sourceReviewCounts,
  bossWaitingItems,
} from '../dist/source-ledger.js';
import {
  initialWorkspace,
  createBackup,
  restoreWorkspace,
  migrateWorkspace,
} from '../dist/workspace.js';
import {
  applyBossBatch,
  bindBossAccount,
  rejectMisattributedResumeObservation,
  ignoreBossObservations,
  bossWaitingReviewTarget,
  bossWaitingReviewCandidates,
  createBossQueueConsumer,
  latestPlatformObservation,
  verifyBossBatch,
} from '../dist/boss-integration.js';
import { createViews } from '../dist/views.js';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const OTHER_ACCOUNT = `boss-geek:${'b'.repeat(64)}`;
const SOURCE_ID = '00000000-0000-4000-8000-000000000001';
const STAMP = '2026-09-19T01:00:00.000Z';
const OBSERVED = '2026-09-18T14:45:09.648Z';
const JOB_ID = 'syntheticJobId';
const JOB_URL = `https://www.zhipin.com/job_detail/${JOB_ID}.html`;
const SOURCE = {
  snapshotName: 'synthetic.json',
  snapshotSha256: 'c'.repeat(64),
  capturedAt: OBSERVED,
};

function event({ account = ACCOUNT, sequence = 1, initial = true, ...overrides } = {}) {
  const facts = {
    platform: 'boss',
    accountNamespace: account,
    conversationKey: '1'.repeat(64),
    friendId: 'friend-1',
    friendSource: 'source-1',
    uniqueId: 'friend-1-source-1',
    externalJobId: JOB_ID,
    canonicalUrl: JOB_URL,
    jobName: '合成岗位',
    company: '合成公司',
    contact: '合成招聘者',
    summary: '合成消息摘要',
    messageId: 'message-1',
    messageDirection: 'outbound',
    receiptStatus: 'delivered',
    receiptSource: 'list_receipt_label',
    nameSource: 'loaded_jobName',
    linkConfirmation: 'unverified',
    intent: 'create_or_link',
    ...overrides,
  };
  return {
    eventId: `boss-event-${stableHash(facts)}`,
    ...Object.fromEntries(
      Object.entries(facts).filter(([key]) => !['platform', 'accountNamespace'].includes(key)),
    ),
    timeLabel: initial ? '14:18' : '',
    observedAt: OBSERVED,
    evidenceDate: initial ? '2026-09-18' : '',
    appliedAtForNew: initial ? '2026-09-18' : '',
    sourceSequence: sequence,
  };
}

function batch(events, { account = ACCOUNT, sequence = 1, initial = true } = {}) {
  const policy = {
    id: initial ? 'boss-initial-2026-09-18-v1' : 'boss-manual-check-v1',
    mode: initial ? 'initial' : 'incremental',
    timezone: 'Asia/Shanghai',
    appliedAtForNew: initial ? '2026-09-18' : '',
    autoCreateComplete: true,
  };
  return {
    format: 'job-tracker-boss-batch',
    version: 1,
    batchId: `boss-batch-${stableHash({
      policy: policy.id,
      snapshotSha256: SOURCE.snapshotSha256,
      accountNamespace: account,
      eventIds: events.map((row) => row.eventId).sort(),
    })}`,
    platform: 'boss',
    accountNamespace: account,
    sourceSequence: sequence,
    policy,
    source: SOURCE,
    coverage: {
      loadedRows: events.length,
      loadedDataRows: events.length,
      renderedRows: events.length,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
    events,
  };
}

function resumeEvent({
  sequence = 2,
  externalJobId = JOB_ID,
  linked = false,
  workflow = 'resume-status-linked-v1',
  ...overrides
} = {}) {
  const facts = {
    platform: 'boss',
    eventType: 'resume_observed',
    accountNamespace: ACCOUNT,
    conversationKey: '1'.repeat(64),
    friendId: 'friend-1',
    friendSource: 'source-1',
    uniqueId: 'friend-1-source-1',
    externalJobId,
    canonicalUrl: externalJobId ? `https://www.zhipin.com/job_detail/${externalJobId}.html` : '',
    jobName: externalJobId ? '合成岗位' : '',
    company: externalJobId ? '合成公司' : '',
    contact: '合成招聘者',
    summary: 'resume_sent_candidate',
    messageId: 'resume-message-1',
    messageDirection: 'outbound',
    receiptStatus: 'not_applicable',
    receiptSource: '',
    nameSource: externalJobId ? 'loaded_jobName' : '',
    linkConfirmation: 'unverified',
    intent: 'observe_only',
    ...overrides,
  };
  return {
    eventId: `boss-event-${stableHash(linked ? { ...facts, workflow } : facts)}`,
    ...Object.fromEntries(
      Object.entries(facts).filter(([key]) => !['platform', 'accountNamespace'].includes(key)),
    ),
    timeLabel: '',
    observedAt: OBSERVED,
    evidenceDate: '',
    appliedAtForNew: '',
    sourceSequence: sequence,
  };
}

function resumeBatch(events, { sequence = 2, version = 1 } = {}) {
  const policy = {
    id: `boss-resume-observation-v${version}`,
    mode: 'resume',
    timezone: 'Asia/Shanghai',
    appliedAtForNew: '',
    autoCreateComplete: false,
  };
  return {
    ...batch(events, { sequence, initial: false }),
    batchId: `boss-batch-${stableHash({
      policy: policy.id,
      snapshotSha256: SOURCE.snapshotSha256,
      accountNamespace: ACCOUNT,
      eventIds: events.map((row) => row.eventId).sort(),
    })}`,
    policy,
  };
}

// Explicit synthetic contract: real collectors do not yet supply this complete identity chain.
function verifiedResumeBatch(events, options) {
  const input = resumeBatch(events, options);
  input.version = 3;
  input.events = events.map((event) =>
    event.eventType !== 'resume_observed'
      ? event
      : {
          ...event,
          attribution: {
            version: 1,
            source: 'history',
            accountNamespace: input.accountNamespace,
            conversationKey: event.conversationKey,
            messageId: event.messageId,
            requestedBossId: 'boss-1',
            responseFriendId: event.friendId,
            responseFriendSource: event.friendSource,
            responseBossId: 'boss-1',
            selfId: 'self-1',
            senderId: 'boss-1',
            recipientId: 'self-1',
            messageJobId: event.externalJobId || null,
          },
        },
  );
  for (const event of input.events)
    event.eventId = `boss-event-${stableHash(bossEventDigestInput(input, event))}`;
  input.batchId = `boss-batch-${stableHash(bossBatchDigestInput(input))}`;
  return input;
}

function boundData(account = ACCOUNT) {
  return bindBossAccount(emptyData(), account, SOURCE_ID, STAMP);
}

test('浏览器在事务写入前独立核对事件和批次摘要，并严格校验回执语义', async () => {
  const valid = batch([event()]);
  assert.deepEqual(await verifyBossBatch(valid), valid);
  await assert.rejects(
    verifyBossBatch({ ...valid, events: [{ ...valid.events[0], summary: '伪造摘要' }] }),
    /身份校验失败/,
  );
  await assert.rejects(verifyBossBatch({ ...valid, batchId: `boss-batch-${'0'.repeat(64)}` }));

  const linkedEvent = resumeEvent({
    linked: true,
    summary: 'resume_sent_confirmed',
  });
  const linkedBatch = resumeBatch([linkedEvent], { version: 2 });
  assert.deepEqual(await verifyBossBatch(linkedBatch), linkedBatch);
  const linkedV3Event = resumeEvent({
    linked: true,
    workflow: 'resume-status-linked-v2',
    summary: 'resume_viewed_confirmed',
    messageId: 'resume-message-v3',
  });
  const linkedV3Batch = resumeBatch([linkedV3Event], { version: 3 });
  assert.deepEqual(await verifyBossBatch(linkedV3Batch), linkedV3Batch);

  const incrementalResume = resumeEvent({
    linked: true,
    workflow: 'resume-status-linked-v2',
    summary: 'resume_sent_confirmed',
    messageId: 'incremental-resume-message',
  });
  const incrementalV2 = {
    ...batch([incrementalResume], { sequence: 2, initial: false }),
    version: 2,
  };
  assert.deepEqual(validateQueuedBossBatch(incrementalV2), incrementalV2);
  assert.deepEqual(await verifyBossBatch(incrementalV2), incrementalV2);
  const legacyIncremental = { ...incrementalV2, version: 1 };
  assert.throws(() => validateQueuedBossBatch(legacyIncremental), /事件.*事实不一致/);
  await assert.rejects(verifyBossBatch(legacyIncremental), /身份校验失败/);
  await assert.rejects(
    verifyBossBatch({
      ...valid,
      events: [{ ...valid.events[0], receiptSource: 'unverified_label' }],
    }),
  );
});

test('首批直接建档、明确来源日期、重复录入不新增；后续不倒填首次联系日', () => {
  const first = batch([event()]);
  const result = applyBossBatch(boundData(), first, { workspaceSourceId: SOURCE_ID, stamp: STAMP });
  assert.deepEqual(result.counts, { added: 1, linked: 0, observed: 1, reviewed: 0, skipped: 0 });
  assert.equal(result.data.opportunities[0].stage, '已触达');
  assert.equal(result.data.opportunities[0].appliedAt, '2026-09-18');
  assert.equal(result.data.opportunities[0].createdAt, STAMP);
  assert.equal(result.data.opportunities[0].readState, undefined);
  assert.equal(result.data.sourceEvents[0].appliedAtSource, 'user_confirmed_initial_contact_date');
  const second = applyBossBatch(result.data, first, {
    workspaceSourceId: SOURCE_ID,
    stamp: '2026-09-19T02:00:00.000Z',
  });
  assert.equal(second.counts.added, 0);
  assert.equal(second.counts.skipped, 1);
  assert.equal(second.data.sourceEvents.length, 1);

  // A later snapshot can return to identical platform facts. Event identity is
  // independent of the first batch's user-specified appliedAt policy.
  const sameFactsLater = batch([event({ sequence: 2, initial: false })], {
    sequence: 2,
    initial: false,
  });
  const repeatedFacts = applyBossBatch(second.data, sameFactsLater, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(repeatedFacts.counts.skipped, 1);

  const later = batch(
    [event({ sequence: 2, initial: false, summary: '合成新消息', messageId: 'message-2' })],
    {
      sequence: 2,
      initial: false,
    },
  );
  const updated = applyBossBatch(second.data, later, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(updated.counts.added, 0);
  assert.equal(updated.data.opportunities[0].appliedAt, '2026-09-18');
  assert.equal(updated.data.sourceEvents.length, 2);
});

test('增量具体时分使用快照采集日建档且来源可审计', async () => {
  const sameDayEvent = {
    ...event({ sequence: 2, initial: false }),
    timeLabel: '14:18',
    evidenceDate: '2026-09-18',
    appliedAtForNew: '2026-09-18',
  };
  const sameDayBatch = batch([sameDayEvent], { sequence: 2, initial: false });
  sameDayBatch.version = 2;
  assert.doesNotThrow(() => validateQueuedBossBatch(sameDayBatch));
  assert.deepEqual(await verifyBossBatch(sameDayBatch), sameDayBatch);
  const result = applyBossBatch(boundData(), sameDayBatch, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(result.data.opportunities[0].appliedAt, '2026-09-18');
  assert.equal(result.data.sourceEvents[0].evidenceDate, '2026-09-18');
  assert.equal(result.data.sourceEvents[0].appliedAtSource, 'platform_same_day_time_label');

  await assert.rejects(
    verifyBossBatch({
      ...sameDayBatch,
      events: [{ ...sameDayEvent, appliedAtForNew: '2026-09-19' }],
    }),
    /日期与批次策略不一致/,
  );
  for (const invalid of [
    { ...sameDayEvent, evidenceDate: '', appliedAtForNew: '' },
    { ...sameDayEvent, timeLabel: '', appliedAtForNew: '' },
  ]) {
    const invalidBatch = { ...sameDayBatch, events: [invalid] };
    assert.throws(() => validateQueuedBossBatch(invalidBatch), /日期.*策略不一致/);
    await assert.rejects(verifyBossBatch(invalidBatch), /日期与批次策略不一致/);
  }

  const legacySameDayEvent = {
    ...event({ sequence: 2, initial: false }),
    timeLabel: '14:18',
  };
  const legacySameDayBatch = batch([legacySameDayEvent], { sequence: 2, initial: false });
  assert.doesNotThrow(() => validateQueuedBossBatch(legacySameDayBatch));
  assert.deepEqual(await verifyBossBatch(legacySameDayBatch), legacySameDayBatch);
});

test('简历平台观察只关联既有岗位，不修改人工简历、已读或阶段状态', () => {
  const created = applyBossBatch(boundData(), batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const opportunity = created.data.opportunities[0];
  opportunity.stage = '面试中';
  opportunity.resumeState = '已索要';
  opportunity.readState = '未读';
  const observed = applyBossBatch(created.data, verifiedResumeBatch([resumeEvent()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: '2026-09-20T08:02:00.000Z',
  });
  assert.deepEqual(observed.counts, {
    added: 0,
    linked: 0,
    observed: 1,
    reviewed: 0,
    skipped: 0,
  });
  assert.equal(observed.data.opportunities.length, 1);
  assert.equal(observed.data.opportunities[0].stage, '面试中');
  assert.equal(observed.data.opportunities[0].resumeState, '已索要');
  assert.equal(observed.data.opportunities[0].readState, '未读');
  assert.equal(observed.data.sourceEvents.at(-1).eventType, 'resume_observed');
  assert.equal(
    latestPlatformObservation(observed.data, opportunity.id).eventType,
    'conversation_observed',
  );

  const replay = applyBossBatch(observed.data, verifiedResumeBatch([resumeEvent()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: '2026-09-20T08:03:00.000Z',
  });
  assert.equal(replay.counts.skipped, 1);

  const unresolved = applyBossBatch(
    observed.data,
    verifiedResumeBatch([resumeEvent({ externalJobId: '', messageId: 'resume-message-2' })]),
    { workspaceSourceId: SOURCE_ID, stamp: '2026-09-20T08:04:00.000Z' },
  );
  assert.equal(unresolved.counts.reviewed, 1);
  assert.equal(unresolved.data.opportunities.length, 1);
});

test('同一历史简历事实的元数据变化不重复应用或创建岗位', () => {
  const created = applyBossBatch(boundData(), batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const first = applyBossBatch(created.data, verifiedResumeBatch([resumeEvent()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: '2026-09-20T08:02:00.000Z',
  });
  const facts = first.data.sourceFacts.length;
  const applications = first.data.sourceApplications.length;
  const evidence = first.data.sourceEvents.length;
  const historical = resumeEvent({
    sequence: 3,
    jobName: '',
    company: '',
    contact: '',
    nameSource: '',
  });
  assert.notEqual(historical.eventId, resumeEvent().eventId);
  const replayed = applyBossBatch(first.data, verifiedResumeBatch([historical], { sequence: 3 }), {
    workspaceSourceId: SOURCE_ID,
    stamp: '2026-09-21T08:02:00.000Z',
  });
  assert.equal(replayed.data.opportunities.length, 1);
  assert.equal(replayed.data.sourceFacts.length, facts);
  assert.equal(replayed.data.sourceApplications.length, applications);
  assert.equal(replayed.data.sourceEvents.length, evidence + 1);
  assert.equal(replayed.data.sourceEvents.at(-1).factId, first.data.sourceEvents.at(-1).factId);
});

test('平台明确的附件简历状态单向推进，并联动 BOSS 消息已读和初始招聘阶段', () => {
  const created = applyBossBatch(boundData(), batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const opportunity = created.data.opportunities[0];
  opportunity.stage = '已触达';
  const sent = applyBossBatch(
    created.data,
    verifiedResumeBatch([resumeEvent({ summary: 'resume_attachment_sent' })]),
    { workspaceSourceId: SOURCE_ID, stamp: '2026-09-20T08:05:00.000Z' },
  );
  assert.equal(sent.data.opportunities[0].resumeState, '已发送');
  assert.equal(sent.data.opportunities[0].stage, '沟通中');
  assert.equal(sent.data.opportunities[0].readState, '已读');

  sent.data.opportunities[0].stage = '面试中';
  sent.data.opportunities[0].readState = '未读';
  const viewed = applyBossBatch(
    sent.data,
    verifiedResumeBatch([
      resumeEvent({
        eventId: `boss-event-${'c'.repeat(64)}`,
        messageId: 'resume-message-viewed',
        summary: 'resume_viewed_confirmed',
      }),
    ]),
    { workspaceSourceId: SOURCE_ID, stamp: '2026-09-20T08:06:00.000Z' },
  );
  assert.equal(viewed.data.opportunities[0].resumeState, '对方已接收');
  assert.equal(viewed.data.opportunities[0].stage, '面试中');
  assert.equal(viewed.data.opportunities[0].readState, '未读');

  viewed.data.opportunities[0].stage = '已触达';
  viewed.data.opportunities[0].readState = '未读';
  const sameState = applyBossBatch(
    viewed.data,
    verifiedResumeBatch([
      resumeEvent({
        eventId: `boss-event-${'d'.repeat(64)}`,
        messageId: 'resume-message-viewed-again',
        summary: 'resume_viewed_confirmed',
      }),
    ]),
    { workspaceSourceId: SOURCE_ID, stamp: '2026-09-20T08:07:00.000Z' },
  );
  assert.equal(sameState.data.opportunities[0].resumeState, '对方已接收');
  assert.equal(sameState.data.opportunities[0].stage, '已触达');
  assert.equal(sameState.data.opportunities[0].readState, '未读');
});

test('用户否决误归属的请求卡片只撤销目标岗位，不改变另一岗位的发送证据', async () => {
  const otherJobId = 'otherSyntheticJobId';
  const otherConversation = {
    conversationKey: '2'.repeat(64),
    friendId: 'friend-2',
    uniqueId: 'friend-2-source-1',
    contact: '另一位合成招聘者',
    externalJobId: otherJobId,
    canonicalUrl: `https://www.zhipin.com/job_detail/${otherJobId}.html`,
    messageId: 'message-2',
  };
  const created = applyBossBatch(boundData(), batch([event(), event(otherConversation)]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const observations = verifiedResumeBatch(
    [
      resumeEvent({
        linked: true,
        workflow: 'resume-status-linked-v2',
        summary: 'resume_sent_confirmed',
      }),
      resumeEvent({
        ...otherConversation,
        linked: true,
        workflow: 'resume-status-linked-v2',
        summary: 'resume_request_sent',
        messageId: 'resume-message-2',
      }),
    ],
    { version: 3 },
  );
  const observed = applyBossBatch(created.data, observations, {
    workspaceSourceId: SOURCE_ID,
    stamp: '2026-09-20T08:05:00.000Z',
  });
  const sent = observed.data.opportunities.find((row) => row.externalId === JOB_ID);
  const requested = observed.data.opportunities.find((row) => row.externalId === otherJobId);
  assert.equal(sent.resumeState, '已发送');
  assert.equal(requested.resumeState, '已发送');
  assert.equal(requested.readState, '已读');
  assert.equal(requested.stage, '沟通中');
  assert.equal(
    observed.data.sourceEvents.filter((row) => row.eventType === 'resume_observed').length,
    2,
  );

  const request = observed.data.sourceEvents.find(
    (row) => row.opportunityId === requested.id && row.summary === 'resume_request_sent',
  );
  const corrected = rejectMisattributedResumeObservation(observed.data, {
    opportunityId: requested.id,
    eventId: request.id,
    stamp: '2026-09-20T08:06:00.000Z',
  });
  assert.equal(corrected.opportunities.find((row) => row.id === requested.id).resumeState, '未知');
  assert.equal(corrected.opportunities.find((row) => row.id === requested.id).stage, '已触达');
  assert.equal(corrected.opportunities.find((row) => row.id === requested.id).readState, undefined);
  assert.equal(corrected.opportunities.find((row) => row.id === sent.id).resumeState, '已发送');
  assert.deepEqual(corrected.sourceEvents, observed.data.sourceEvents);
  assert.equal(
    corrected.sourceApplications.find((row) => row.factId === request.factId).reason,
    'user_rejected_wrong_conversation',
  );
  assert.equal(
    effectiveSourceFacts(corrected).some((row) => row.id === request.id),
    false,
  );
  const replayed = applyBossBatch(corrected, observations, {
    workspaceSourceId: SOURCE_ID,
    stamp: '2026-09-20T08:07:00.000Z',
  });
  assert.equal(
    replayed.data.opportunities.find((row) => row.id === requested.id).resumeState,
    '未知',
  );
  assert.equal(
    replayed.data.sourceApplications.find((row) => row.factId === request.factId).reason,
    'user_rejected_wrong_conversation',
  );
  assert.throws(
    () =>
      rejectMisattributedResumeObservation(corrected, {
        opportunityId: requested.id,
        eventId: request.id,
        stamp: '2026-09-20T08:07:00.000Z',
      }),
    { code: 'BOSS_RESUME_REJECTION_UNSAFE' },
  );

  const root = await mkdtemp(join(tmpdir(), 'boss-resume-correction-'));
  const store = new WorkspaceStore(join(root, 'workspace'), {
    now: () => '2026-09-20T08:06:00.000Z',
  });
  try {
    const workspace = initialWorkspace();
    workspace.data = observed.data;
    const imported = await store.execute({
      commandId: 'synthetic-import',
      expectedRevision: 0,
      type: 'import_workspace',
      payload: { workspace, reason: 'synthetic fixture' },
    });
    const command = {
      commandId: 'reject-wrong-conversation',
      expectedRevision: imported.revision,
      type: 'reject_boss_resume_observation',
      payload: { opportunityId: requested.id, eventId: request.id },
    };
    const committed = await store.execute(command);
    assert.equal(
      committed.workspace.data.opportunities.find((row) => row.id === requested.id).resumeState,
      '未知',
    );
    assert.equal((await store.execute(command)).replayed, true);
    assert.equal((await store.read()).revision, committed.revision);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('用户确认日期批次只给新岗位写入指定日期，来源策略可审计', () => {
  const datedEvent = {
    ...event(),
    evidenceDate: '2026-09-20',
    appliedAtForNew: '2026-09-20',
  };
  const dated = batch([datedEvent]);
  dated.policy = {
    ...dated.policy,
    id: 'boss-user-dated-label-2026-09-20-v1',
    mode: 'dated',
    appliedAtForNew: '2026-09-20',
  };
  dated.batchId = `boss-batch-${stableHash({
    policy: dated.policy.id,
    snapshotSha256: dated.source.snapshotSha256,
    accountNamespace: dated.accountNamespace,
    eventIds: dated.events.map((row) => row.eventId).sort(),
  })}`;
  const result = applyBossBatch(boundData(), dated, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(result.counts.added, 1);
  assert.equal(result.data.opportunities[0].appliedAt, '2026-09-20');
  assert.equal(result.data.sourceEvents[0].evidenceDate, '2026-09-20');
  assert.equal(result.data.sourceEvents[0].importPolicy, dated.policy.id);
  assert.equal(result.data.sourceEvents[0].appliedAtSource, 'user_confirmed_initial_contact_date');
});

test('同岗位多位招聘者只建一个岗位，但观察保留会话；列表不把单会话回执当岗位状态', () => {
  const first = event(),
    second = event({
      conversationKey: '2'.repeat(64),
      friendId: 'friend-2',
      uniqueId: 'friend-2-source-1',
      contact: '另一位合成招聘者',
      messageId: 'message-2',
      summary: '另一条合成消息',
      receiptStatus: 'read',
    });
  const result = applyBossBatch(boundData(), batch([first, second]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(result.counts.added, 1);
  assert.equal(result.data.opportunities.length, 1);
  assert.equal(result.data.sourceEvents.length, 2);
  const opportunity = result.data.opportunities[0];
  const views = createViews(
    () => ({ state: { data: result.data }, selected: opportunity.id }),
    () => [],
  );
  assert.match(views.jobRow(opportunity), /平台观察（多会话）/);
  assert.match(views.detail(), /平台观察 <span class="muted">2 条/);
  assert.doesNotMatch(views.detail(), /消息：未读/);
});

test('同一平台事实重复采到时详情只计一条观察', () => {
  const first = applyBossBatch(boundData(), batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const repeated = event({
    eventId: `boss-event-${'9'.repeat(64)}`,
    sourceSequence: 2,
    observedAt: '2026-09-18T13:00:00.000Z',
  });
  const after = applyBossBatch(first.data, batch([repeated]), {
    workspaceSourceId: SOURCE_ID,
    stamp: '2026-09-18T13:01:00.000Z',
  });
  assert.equal(after.data.sourceEvents.length, 2);
  const opportunity = after.data.opportunities[0];
  const views = createViews(
    () => ({ state: { data: after.data }, selected: opportunity.id }),
    () => [],
  );
  assert.match(views.detail(), /平台观察 <span class="muted">1 条/);
});

test('岗位 ID 与现有 BOSS 链接冲突时不自动关联，跨账号不复用自动建档', () => {
  const data = boundData();
  data.opportunities.push({
    id: 'manual-existing',
    company: '合成公司',
    role: '合成岗位',
    platform: 'BOSS',
    externalId: JOB_ID,
    url: 'https://www.zhipin.com/job_detail/anotherJob.html',
    stage: '面试中',
    appliedAt: '2026-09-01',
  });
  const conflict = applyBossBatch(data, batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(conflict.counts.reviewed, 1);
  assert.equal(conflict.counts.added, 0);
  assert.equal(conflict.data.opportunities[0].stage, '面试中');
  assert.equal(conflict.data.sourceBindings.filter((row) => row.kind === 'opportunity').length, 0);

  const first = applyBossBatch(boundData(), batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const withOther = bindBossAccount(first.data, OTHER_ACCOUNT, SOURCE_ID, STAMP);
  const differentAccount = applyBossBatch(
    withOther,
    batch([event({ account: OTHER_ACCOUNT })], { account: OTHER_ACCOUNT }),
    { workspaceSourceId: SOURCE_ID, stamp: STAMP },
  );
  assert.equal(differentAccount.counts.reviewed, 1);
  assert.equal(differentAccount.counts.added, 0);
});

test('人工清空自动字段受到保护，旧批次不覆盖更新观察；删除岗位不会复活', () => {
  const first = applyBossBatch(boundData(), batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  first.data.opportunities[0].url = '';
  const newer = batch([event({ sequence: 2, initial: false, summary: '合成新消息' })], {
    sequence: 2,
    initial: false,
  });
  const after = applyBossBatch(first.data, newer, { workspaceSourceId: SOURCE_ID, stamp: STAMP });
  assert.equal(after.data.opportunities[0].url, '');
  assert.ok(!after.data.sourceBindings[1].autoFields.split(',').includes('url'));
  assert.equal(
    latestPlatformObservation(after.data, after.data.opportunities[0].id)?.summary,
    '合成新消息',
  );
  const replay = applyBossBatch(after.data, batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(replay.counts.skipped, 1);
  assert.equal(replay.data.opportunities[0].url, '');
  replay.data.opportunities[0].deletedAt = STAMP;
  const afterDelete = applyBossBatch(replay.data, newer, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(afterDelete.data.opportunities[0].deletedAt, STAMP);
});

test('账号绑定墓碑必须明确恢复且仍限原工作区；事件墓碑不在普通重放中复活', () => {
  const data = boundData();
  data.sourceBindings[0].deletedAt = STAMP;
  assert.throws(() => bindBossAccount(data, ACCOUNT, SOURCE_ID, STAMP), /明确核对/);
  const restored = bindBossAccount(data, ACCOUNT, SOURCE_ID, STAMP, { allowRestore: true });
  assert.equal(restored.sourceBindings[0].deletedAt, undefined);
  assert.throws(() =>
    bindBossAccount(data, ACCOUNT, '00000000-0000-4000-8000-000000000002', STAMP, {
      allowRestore: true,
    }),
  );
  const applied = applyBossBatch(restored, batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  applied.data.sourceEvents[0].deletedAt = STAMP;
  applied.data.sourceFacts[0].deletedAt = STAMP;
  applied.data.sourceApplications[0].deletedAt = STAMP;
  assert.throws(
    () =>
      applyBossBatch(applied.data, batch([event()]), {
        workspaceSourceId: SOURCE_ID,
        stamp: STAMP,
      }),
    /明确核对/,
  );
  const explicit = applyBossBatch(applied.data, batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
    allowEventRestore: true,
  });
  assert.equal(live(explicit.data.sourceEvents).length, 1);
  assert.equal(live(explicit.data.sourceFacts).length, 1);
  assert.equal(live(explicit.data.sourceApplications).length, 1);
  assert.equal(explicit.counts.added, 0);
});

test('缺消息 ID 的不同观察分别留待补证据，不建岗位也不共享事实应用', () => {
  const first = event({ messageId: '' }),
    second = event({
      messageId: '',
      externalJobId: 'other-job',
      canonicalUrl: 'https://www.zhipin.com/job_detail/other-job.html',
      jobName: '另一岗位',
    });
  const result = applyBossBatch(boundData(), batch([first, second]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(result.counts.reviewed, 2);
  assert.equal(result.data.opportunities.length, 0);
  assert.equal(result.data.sourceEvents.length, 2);
  assert.ok(result.data.sourceEvents.every((row) => row.factId === ''));
  assert.equal(result.data.sourceFacts.length, 0);
  assert.equal(result.data.sourceApplications.length, 0);
});

function fakeQueue(inputBatch, { failFirstReceipt = false, processed = false } = {}) {
  let receipt = processed
      ? { status: 'processed', batchId: inputBatch.batchId, workspaceSourceId: SOURCE_ID }
      : null,
    failed = false,
    ackCalls = 0;
  const fetcher = async (url, options = {}) => {
    if (url === './__local/session')
      return Response.json({ bossIntegrationEnabled: true, session: 'f'.repeat(64) });
    if (url.startsWith('./__local/boss-inbox?'))
      return Response.json({
        status: { receiptCount: receipt ? 1 : 0, incidentCount: 0 },
        batches: [
          {
            batchId: inputBatch.batchId,
            accountNamespace: inputBatch.accountNamespace,
            sourceSequence: inputBatch.sourceSequence,
            receipt,
          },
        ],
      });
    if (url === `./__local/boss-inbox/${inputBatch.batchId}`) return Response.json(inputBatch);
    if (url === `./__local/boss-inbox/${inputBatch.batchId}/receipt` && options.method === 'PUT') {
      ackCalls++;
      if (failFirstReceipt && !failed) {
        failed = true;
        throw new Error('synthetic local service interruption');
      }
      receipt = JSON.parse(options.body);
      return Response.json({ created: true });
    }
    throw new Error(`unexpected synthetic URL: ${url}`);
  };
  return { fetcher, getReceipt: () => receipt, getAckCalls: () => ackCalls };
}

function consumerHarness(inputBatch, options = {}) {
  let data = options.data || boundData(),
    pending = options.pending || null,
    edits = 0;
  const api = fakeQueue(inputBatch, options);
  const storage = new Map([['job-tracker-boss-source-v1', SOURCE_ID]]);
  const consumer = createBossQueueConsumer({
    fetcher: api.fetcher,
    storage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
    readWorkspace: async () => ({ data, pending }),
    editWorkspace: async (transform) => {
      if (pending) throw new Error('synthetic pending conflict');
      data = transform(data);
      edits++;
    },
    lockManager: options.lockManager ?? {
      request: async (_name, _options, callback) => callback({}),
    },
    now: () => STAMP,
    hostname: '127.0.0.1',
  });
  return {
    consumer,
    api,
    getData: () => data,
    getEdits: () => edits,
    setPending: (value) => (pending = value),
  };
}

test('本机只读状态偶发刷新失败标注旧状态，持续失败才报连接异常，成功后恢复', async () => {
  let failed = false,
    timeout = false,
    calls = 0;
  const consumer = createBossQueueConsumer({
    fetcher: async (url) => {
      if (url === './__local/session')
        return Response.json({
          bossIntegrationEnabled: true,
          localWorkspaceEnabled: true,
          workspaceId: SOURCE_ID,
          session: 'f'.repeat(64),
        });
      calls++;
      if (failed) throw new TypeError('synthetic network interruption');
      if (timeout) throw new DOMException('synthetic timeout', 'TimeoutError');
      return Response.json({ status: {}, batches: [], tracking: { lifecycle: 'stopped' } });
    },
    storage: { getItem: () => SOURCE_ID, setItem: () => {} },
    readWorkspace: async () => ({ data: boundData(), pending: null }),
    editWorkspace: async () => {
      throw new Error('read-only refresh must not write');
    },
    lockManager: { request: async (_name, _options, callback) => callback({}) },
    hostname: '127.0.0.1',
    now: () => STAMP,
  });
  const initial = await consumer.run();
  assert.equal(initial.error, '');
  failed = true;
  const intermittent = await consumer.run();
  assert.equal(intermittent.error, '');
  assert.equal(intermittent.connectionStale, true);
  assert.equal(intermittent.refreshFailures, 1);
  assert.equal(intermittent.tracking.lifecycle, 'stopped');
  assert.equal(intermittent.lastStatusAt, STAMP);
  const persistent = await consumer.run();
  assert.match(persistent.error, /LOCAL_UNAVAILABLE/);
  assert.equal(persistent.refreshFailures, 2);
  failed = false;
  const recovered = await consumer.run();
  assert.equal(recovered.connectionStale, false);
  assert.equal(recovered.refreshFailures, 0);
  assert.equal(recovered.error, '');
  assert.equal(calls, 4);
  timeout = true;
  const timedOut = await consumer.run();
  assert.equal(timedOut.error, '');
  assert.match(timedOut.refreshError, /LOCAL_TIMEOUT/);
  assert.match(timedOut.refreshError, /30 秒/);
  assert.equal(timedOut.connectionStale, true);
  await assert.rejects(consumer.bind(ACCOUNT), (error) => error.code === 'LOCAL_STATUS_STALE');
  await assert.rejects(
    consumer.replay('synthetic'),
    (error) => error.code === 'LOCAL_STATUS_STALE',
  );
});

test('首次状态读取失败立即提示，未取得状态时不使用短时失败容忍', async () => {
  const consumer = createBossQueueConsumer({
    fetcher: async (url) => {
      if (url === './__local/session')
        return Response.json({
          bossIntegrationEnabled: true,
          localWorkspaceEnabled: true,
          workspaceId: SOURCE_ID,
          session: 'f'.repeat(64),
        });
      throw new TypeError('synthetic unavailable service');
    },
    storage: { getItem: () => SOURCE_ID, setItem: () => {} },
    readWorkspace: async () => ({ data: boundData(), pending: null }),
    editWorkspace: async () => {
      throw new Error('must not write');
    },
    lockManager: { request: async (_name, _options, callback) => callback({}) },
    hostname: '127.0.0.1',
    now: () => STAMP,
  });
  const status = await consumer.run();
  assert.equal(status.available, true);
  assert.match(status.error, /LOCAL_UNAVAILABLE/);
  assert.equal(status.lastStatusAt, undefined);
});

test('IndexedDB 已提交但回执丢失时重放零新增、零重复事件，之后才确认队列', async () => {
  const harness = consumerHarness(batch([event()]), { failFirstReceipt: true });
  const interrupted = await harness.consumer.run();
  assert.match(interrupted.error, /LOCAL_UNAVAILABLE/);
  assert.equal(harness.getData().opportunities.length, 1);
  assert.equal(harness.getData().sourceEvents.length, 1);
  assert.equal(harness.api.getReceipt(), null);
  const recovered = await harness.consumer.run();
  assert.equal(recovered.error, '');
  assert.equal(harness.getData().opportunities.length, 1);
  assert.equal(harness.getData().sourceEvents.length, 1);
  assert.equal(harness.api.getReceipt().status, 'processed');
  assert.equal(harness.api.getReceipt().counts.added, 0);
  assert.equal(harness.api.getReceipt().counts.skipped, 1);
});

test('同步冲突和 Web Locks 不可用都留下队列，不会并发写入', async () => {
  const conflicted = consumerHarness(batch([event()]), { pending: { conflicts: [] } });
  const status = await conflicted.consumer.run();
  assert.match(status.blocked, /同步冲突/);
  assert.equal(conflicted.getEdits(), 0);
  assert.equal(conflicted.api.getReceipt(), null);

  const noLocks = consumerHarness(batch([event()]), { lockManager: {} });
  const lockStatus = await noLocks.consumer.run();
  assert.match(lockStatus.error, /LOCK_UNAVAILABLE/);
  assert.equal(noLocks.getEdits(), 0);
  assert.equal(noLocks.api.getReceipt(), null);
});

test('本机服务重启导致会话 403 时重新发现一次并继续消费', async () => {
  const inputBatch = batch([event()]);
  let data = boundData(),
    sessionCalls = 0,
    rejected = false,
    receipt = null;
  const fetcher = async (url, options = {}) => {
    if (url === './__local/session') {
      sessionCalls++;
      return Response.json({
        bossIntegrationEnabled: true,
        session: (sessionCalls === 1 ? 'e' : 'f').repeat(64),
      });
    }
    if (!rejected) {
      rejected = true;
      return Response.json(
        { code: 'SESSION_INVALID', message: 'synthetic expired session' },
        { status: 403 },
      );
    }
    if (url.startsWith('./__local/boss-inbox?'))
      return Response.json({
        status: { receiptCount: receipt ? 1 : 0, incidentCount: 0 },
        batches: [
          {
            batchId: inputBatch.batchId,
            accountNamespace: inputBatch.accountNamespace,
            sourceSequence: inputBatch.sourceSequence,
            receipt,
          },
        ],
      });
    if (url === `./__local/boss-inbox/${inputBatch.batchId}`) return Response.json(inputBatch);
    if (url === `./__local/boss-inbox/${inputBatch.batchId}/receipt` && options.method === 'PUT') {
      receipt = JSON.parse(options.body);
      return Response.json({ created: true });
    }
    throw new Error(`unexpected synthetic URL: ${url}`);
  };
  const consumer = createBossQueueConsumer({
    fetcher,
    storage: {
      getItem: () => SOURCE_ID,
      setItem: () => {},
    },
    readWorkspace: async () => ({ data, pending: null }),
    editWorkspace: async (transform) => (data = transform(data)),
    lockManager: { request: async (_name, _options, callback) => callback({}) },
    now: () => STAMP,
    hostname: '127.0.0.1',
  });
  const status = await consumer.run();
  assert.equal(status.error, '');
  assert.equal(sessionCalls, 2);
  assert.equal(receipt.status, 'processed');
  assert.equal(data.opportunities.length, 1);
});

test('已回执事件的墓碑识别为恢复缺口；仅经明确 replay 才重新录入', async () => {
  const inputBatch = batch([event()]);
  const applied = applyBossBatch(boundData(), inputBatch, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  applied.data.sourceEvents[0].deletedAt = STAMP;
  const harness = consumerHarness(inputBatch, { data: applied.data, processed: true });
  const status = await harness.consumer.run();
  assert.equal(status.restoreReview.length, 1);
  assert.match(status.blocked, /缺少已回执/);
  assert.equal(harness.getEdits(), 0);
  await harness.consumer.replay(inputBatch.batchId);
  assert.equal(live(harness.getData().sourceEvents).length, 1);
  assert.equal(harness.consumer.getStatus().restoreReview.length, 0);
  assert.equal(harness.api.getAckCalls(), 0);
});

test('等待关联的事实在岗位补齐后重评，原观察不改写且重复应用幂等', () => {
  const input = verifiedResumeBatch([resumeEvent({ summary: 'resume_request_sent' })]);
  const waiting = applyBossBatch(boundData(), input, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(waiting.data.sourceApplications[0].status, 'waiting');
  const original = structuredClone(waiting.data.sourceEvents[0]);
  const linked = applyBossBatch(waiting.data, batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const applied = applyBossBatch(linked.data, input, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(applied.data.opportunities[0].resumeState, '已发送');
  assert.deepEqual(applied.data.sourceEvents[0], original);
  assert.equal(applied.data.sourceApplications[0].status, 'applied');
  const replayed = applyBossBatch(applied.data, input, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.deepEqual(replayed.data, applied.data);
});

test('人工主动清空及同值确认会释放自动所有权，来源状态不回填人工字段', () => {
  const created = applyBossBatch(boundData(), batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const opportunity = created.data.opportunities[0];
  markManualFields(created.data, opportunity.id, ['resumeState', 'readState', 'stage']);
  opportunity.resumeState = '';
  const applied = applyBossBatch(
    created.data,
    verifiedResumeBatch([resumeEvent({ summary: 'resume_viewed_confirmed' })]),
    { workspaceSourceId: SOURCE_ID, stamp: STAMP },
  );
  assert.equal(applied.data.opportunities[0].resumeState, '');
  assert.equal(applied.data.opportunities[0].stage, '已触达');
  assert.equal(applied.data.sourceApplications.at(-1).status, 'protected');
});

test('岗位级冲突只等待该岗位，其余来源继续录入', () => {
  const created = applyBossBatch(boundData(), batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const incoming = batch([
    event({ messageId: 'changed' }),
    event({
      externalJobId: 'otherJob',
      canonicalUrl: 'https://www.zhipin.com/job_detail/otherJob.html',
      messageId: 'other',
    }),
  ]);
  const result = applyBossBatch(created.data, incoming, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
    blockedOpportunityIds: [created.data.opportunities[0].id],
  });
  assert.equal(result.counts.added, 1);
  assert.equal(
    result.data.sourceApplications.find((row) => row.reason === 'entity_sync_conflict').status,
    'waiting',
  );
});

test('本机正式服务拥有消费职责时网页只观察，静态页面不重新应用事实', async () => {
  let edits = 0,
    batchReads = 0;
  const input = batch([event()]);
  const consumer = createBossQueueConsumer({
    fetcher: async (path) => {
      if (path === './__local/session')
        return Response.json({
          bossIntegrationEnabled: true,
          localWorkspaceEnabled: true,
          workspaceId: SOURCE_ID,
          session: 'f'.repeat(64),
        });
      if (path.startsWith('./__local/boss-inbox?'))
        return Response.json({
          batches: [
            { batchId: input.batchId, accountNamespace: ACCOUNT, sourceSequence: 1, receipt: null },
          ],
          status: {},
        });
      batchReads++;
      throw new Error('page must not read/apply a batch');
    },
    storage: { getItem: () => SOURCE_ID, setItem: () => {} },
    readWorkspace: async () => ({ data: boundData(), pending: null }),
    editWorkspace: async () => {
      edits++;
    },
    lockManager: { request: async (_name, _options, callback) => callback({}) },
    hostname: '127.0.0.1',
  });
  const status = await consumer.run();
  assert.equal(status.serverManaged, true);
  assert.equal(status.pending, 1);
  assert.equal(edits, 0);
  assert.equal(batchReads, 0);
});

test('本机账号旧归属显示需确认，只有明确恢复才迁移到服务工作区', async () => {
  const serviceId = '00000000-0000-4000-8000-000000000002';
  const input = batch([event()]);
  let data = boundData(),
    edits = 0;
  const consumer = createBossQueueConsumer({
    fetcher: async (path) => {
      if (path === './__local/session')
        return Response.json({
          bossIntegrationEnabled: true,
          localWorkspaceEnabled: true,
          workspaceId: serviceId,
          session: 'f'.repeat(64),
        });
      return Response.json({
        batches: [
          { batchId: input.batchId, accountNamespace: ACCOUNT, sourceSequence: 1, receipt: null },
        ],
        status: {},
        recovery: { revision: 2, restoreReview: [] },
      });
    },
    storage: { getItem: () => SOURCE_ID, setItem: () => {} },
    readWorkspace: async () => ({ data, pending: null }),
    editWorkspace: async (transform) => {
      data = transform(data);
      edits++;
    },
    bindWorkspace: async (accountNamespace, { restore }) => {
      data = bindBossAccount(data, accountNamespace, serviceId, STAMP, {
        allowRestore: restore,
        allowRebind: restore,
      });
      edits++;
    },
    lockManager: { request: async (_name, _options, callback) => callback({}) },
    now: () => STAMP,
    hostname: '127.0.0.1',
  });
  const status = await consumer.run();
  assert.equal(status.accounts[0].bound, false);
  assert.equal(status.accounts[0].ownedElsewhere, true);
  assert.equal(status.accounts[0].restoreRequired, true);
  assert.equal(edits, 0);
  await assert.rejects(
    () => consumer.bind(ACCOUNT),
    (error) => error.code === 'SOURCE_ALREADY_BOUND',
  );
  await consumer.bind(ACCOUNT, { restore: true });
  assert.equal(data.sourceBindings[0].workspaceSourceId, serviceId);
  assert.equal(consumer.getStatus().accounts[0].bound, true);
  assert.equal(edits, 1);
});

test('本机恢复缺口由服务显式重放，页面不执行业务变换', async () => {
  const input = batch([event()]);
  let replayed = false,
    commits = 0,
    edits = 0;
  const consumer = createBossQueueConsumer({
    fetcher: async (path, options = {}) => {
      if (path === './__local/session')
        return Response.json({
          bossIntegrationEnabled: true,
          localWorkspaceEnabled: true,
          workspaceId: SOURCE_ID,
          session: 'f'.repeat(64),
        });
      if (path.startsWith('./__local/boss-inbox?'))
        return Response.json({
          batches: [
            {
              batchId: input.batchId,
              accountNamespace: ACCOUNT,
              sourceSequence: 1,
              receipt: { status: 'processed' },
            },
          ],
          status: {},
          recovery: {
            revision: replayed ? 8 : 7,
            restoreReview: replayed ? [] : [{ batchId: input.batchId, missing: 1 }],
          },
        });
      assert.equal(path, `./__local/boss-inbox/${input.batchId}/replay`);
      assert.equal(options.method, 'PUT');
      assert.deepEqual(JSON.parse(options.body), { expectedRevision: 7 });
      replayed = true;
      return Response.json({ revision: 8 });
    },
    storage: { getItem: () => SOURCE_ID, setItem: () => {} },
    readWorkspace: async () => ({ data: boundData(), pending: null }),
    editWorkspace: async () => {
      edits++;
    },
    onCommitted: () => {
      commits++;
    },
    lockManager: { request: async (_name, _options, callback) => callback({}) },
    hostname: '127.0.0.1',
  });
  assert.equal((await consumer.run()).restoreReview.length, 1);
  await consumer.replay(input.batchId);
  assert.equal(edits, 0);
  assert.equal(commits, 1);
  assert.equal(consumer.getStatus().restoreReview.length, 0);
});

test('归属关卡拒绝旧队列、缺字段与同公司不同岗位，补证才允许应用', async () => {
  const created = applyBossBatch(boundData(), batch([event()]), {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const raw = resumeBatch([resumeEvent({ summary: 'resume_request_sent' })]);
  const waiting = applyBossBatch(created.data, raw, { workspaceSourceId: SOURCE_ID, stamp: STAMP });
  assert.deepEqual(waiting.data.opportunities, created.data.opportunities);
  assert.equal(waiting.data.sourceApplications.at(-1).reason, 'attribution_evidence_missing');
  assert.equal(waiting.data.sourceEvents.at(-1).opportunityId, '');
  for (const [field, value, reason] of [
    ['responseFriendId', 'other-contact', 'attribution_contact_conflict'],
    ['senderId', 'other-person', 'attribution_participant_conflict'],
    ['messageJobId', 'same-company-other-job', 'attribution_job_conflict'],
    ['responseFriendId', null, 'attribution_conversation_missing'],
    ['selfId', null, 'attribution_participants_missing'],
  ]) {
    const input = verifiedResumeBatch([resumeEvent({ summary: 'resume_request_sent' })]);
    input.events[0].attribution[field] = value;
    input.batchId = `boss-batch-${stableHash(bossBatchDigestInput(input))}`;
    validateQueuedBossBatch(input);
    await verifyBossBatch(input);
    const result = applyBossBatch(created.data, input, {
      workspaceSourceId: SOURCE_ID,
      stamp: STAMP,
    });
    assert.deepEqual(result.data.opportunities, created.data.opportunities, field);
    assert.equal(result.data.sourceApplications.at(-1).reason, reason, field);
  }
  const complete = verifiedResumeBatch([resumeEvent({ summary: 'resume_request_sent' })]);
  const applied = applyBossBatch(waiting.data, complete, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(applied.data.opportunities[0].resumeState, '已发送');
  assert.equal(applied.data.sourceApplications.at(-1).status, 'applied');
  const replay = applyBossBatch(applied.data, raw, { workspaceSourceId: SOURCE_ID, stamp: STAMP });
  assert.deepEqual(replay.data.opportunities, applied.data.opportunities);
  assert.deepEqual(replay.data.sourceApplications, applied.data.sourceApplications);
  const tampered = structuredClone(complete);
  tampered.events[0].attribution.messageJobId = 'changed';
  assert.throws(() => validateQueuedBossBatch(tampered));
  await assert.rejects(verifyBossBatch(tampered));
});

function applySynthetic(data, input, options = {}) {
  return applyBossBatch(data, input, { workspaceSourceId: SOURCE_ID, stamp: STAMP, ...options })
    .data;
}

function secondJobEvent(overrides = {}) {
  return event({
    externalJobId: 'second-job',
    canonicalUrl: 'https://www.zhipin.com/job_detail/second-job.html',
    conversationKey: '2'.repeat(64),
    friendId: 'friend-2',
    uniqueId: 'friend-2-source-1',
    messageId: 'second-list-message',
    sequence: 1,
    ...overrides,
  });
}

function twoJobs() {
  return applySynthetic(boundData(), batch([event(), secondJobEvent()]));
}

function secondResume(overrides = {}) {
  return resumeEvent({
    externalJobId: 'second-job',
    conversationKey: '2'.repeat(64),
    friendId: 'friend-2',
    uniqueId: 'friend-2-source-1',
    sequence: 2,
    ...overrides,
  });
}

test('同批跨岗位重复先扫描全部候选，事件顺序不影响拦截，无关岗位继续应用', () => {
  const ordinary = secondJobEvent({ messageId: 'resume-message-1', sequence: 2, initial: false });
  const input = verifiedResumeBatch([
    resumeEvent({ summary: 'resume_request_sent' }),
    ordinary,
    secondResume({ messageId: 'independent-message', summary: 'resume_request_sent' }),
  ]);
  for (const rows of [input.events, [...input.events].reverse()]) {
    const data = applySynthetic(twoJobs(), { ...input, events: rows });
    const one = data.sourceApplications.find(
      (a) => a.factId === bossFactId({ ...input.events[0], accountNamespace: ACCOUNT }),
    );
    assert.equal(one.status, 'review');
    assert.equal(one.reason, 'attribution_message_multiple_jobs');
    assert.equal(one.ruleVersion, 'boss-application-v10');
    assert.equal(data.opportunities.find((o) => o.externalId === JOB_ID).resumeState, '未知');
    assert.equal(
      data.opportunities.find((o) => o.externalId === 'second-job').resumeState,
      '已发送',
    );
  }
});

test('跨批重复阻止新增应用，等待项可重评，已应用与人工否决不回退', () => {
  const first = verifiedResumeBatch([resumeEvent({ summary: 'resume_request_sent' })]);
  const applied = applySynthetic(twoJobs(), first);
  const oldDecision = structuredClone(applied.sourceApplications.at(-1));
  const conflicting = verifiedResumeBatch([secondResume({ summary: 'resume_request_sent' })]);
  const blocked = applySynthetic(applied, conflicting);
  assert.deepEqual(
    blocked.sourceApplications.find((a) => a.id === oldDecision.id),
    oldDecision,
  );
  assert.equal(blocked.sourceApplications.at(-1).reason, 'attribution_message_multiple_jobs');
  assert.equal(blocked.opportunities.find((o) => o.externalId === JOB_ID).resumeState, '已发送');
  assert.deepEqual(applySynthetic(blocked, conflicting).opportunities, blocked.opportunities);
  const waitingInput = resumeBatch([resumeEvent({ summary: 'resume_request_sent' })]);
  const waiting = applySynthetic(twoJobs(), waitingInput);
  const both = applySynthetic(waiting, conflicting);
  const rechecked = applySynthetic(both, waitingInput);
  assert.equal(
    rechecked.sourceApplications.find(
      (a) => a.factId === bossFactId({ ...waitingInput.events[0], accountNamespace: ACCOUNT }),
    ).reason,
    'attribution_message_multiple_jobs',
  );
  const rejected = rejectMisattributedResumeObservation(applied, {
    opportunityId: applied.opportunities.find((o) => o.externalId === JOB_ID).id,
    eventId: first.events[0].eventId,
    stamp: STAMP,
  });
  const rejection = structuredClone(
    rejected.sourceApplications.find((a) => a.id === oldDecision.id),
  );
  const after = applySynthetic(applySynthetic(rejected, conflicting), first);
  assert.deepEqual(
    after.sourceApplications.find((a) => a.id === rejection.id),
    rejection,
  );
  assert.equal(after.sourceApplications.at(-1).reason, 'attribution_message_multiple_jobs');
});

test('会话岗位变化不替代消息岗位证据，旧队列等待，明确身份通过或冲突，人工状态受保护', () => {
  const data = applySynthetic(
    twoJobs(),
    batch([
      secondJobEvent({
        conversationKey: '1'.repeat(64),
        friendId: 'friend-1',
        uniqueId: 'friend-1-source-1',
        messageId: 'changed-list-message',
      }),
    ]),
  );
  const raw = resumeBatch([resumeEvent({ summary: 'resume_request_sent' })]);
  const waiting = applySynthetic(data, raw);
  assert.equal(waiting.sourceApplications.at(-1).reason, 'attribution_conversation_job_changed');
  const complete = verifiedResumeBatch([resumeEvent({ summary: 'resume_request_sent' })]);
  const applied = applySynthetic(waiting, complete);
  assert.equal(applied.opportunities.find((o) => o.externalId === JOB_ID).resumeState, '已发送');
  const missing = structuredClone(complete);
  missing.events[0].attribution.messageJobId = null;
  assert.equal(
    applySynthetic(data, missing).sourceApplications.at(-1).reason,
    'attribution_conversation_job_changed',
  );
  missing.events[0].attribution.responseFriendId = null;
  assert.equal(
    applySynthetic(data, missing).sourceApplications.at(-1).reason,
    'attribution_conversation_job_changed',
  );
  const mismatch = structuredClone(complete);
  mismatch.events[0].attribution.messageJobId = 'second-job';
  assert.equal(
    applySynthetic(data, mismatch).sourceApplications.at(-1).reason,
    'attribution_job_conflict',
  );
  const protectedData = structuredClone(data);
  const job = protectedData.opportunities.find((o) => o.externalId === JOB_ID);
  job.resumeState = '被索要';
  markManualFields(protectedData, job.id, ['resumeState']);
  const protectedResult = applySynthetic(protectedData, complete);
  assert.equal(protectedResult.opportunities.find((o) => o.id === job.id).resumeState, '被索要');
  assert.equal(protectedResult.sourceApplications.at(-1).status, 'protected');
});

test('恢复重放使用当前来源上下文，删除记录不作为候选线索且不自动复活', () => {
  const first = verifiedResumeBatch([resumeEvent({ summary: 'resume_request_sent' })]);
  const applied = applySynthetic(twoJobs(), first);
  const restored = applySynthetic(
    applied,
    batch([secondJobEvent({ messageId: 'resume-message-1' })]),
  );
  const removed = applied.sourceApplications.at(-1);
  restored.sourceFacts = restored.sourceFacts.filter((f) => f.id !== removed.factId);
  restored.sourceApplications = restored.sourceApplications.filter((a) => a.id !== removed.id);
  const conflict = restored;
  assert.throws(() => applySynthetic(conflict, first), { code: 'RESTORE_REVIEW_REQUIRED' });
  const replay = applySynthetic(conflict, first, { allowEventRestore: true });
  assert.equal(replay.sourceApplications.at(-1).reason, 'attribution_message_multiple_jobs');
  assert.equal(replay.sourceApplications.at(-1).status, 'review');
  const deleted = structuredClone(twoJobs());
  const other = deleted.sourceEvents.find((e) => e.externalJobId === 'second-job');
  other.messageId = 'resume-message-1';
  other.deletedAt = STAMP;
  assert.equal(applySynthetic(deleted, first).sourceApplications.at(-1).status, 'applied');
});

function conversationResumeBatch(events) {
  const input = verifiedResumeBatch(events);
  for (const event of input.events) if (event.attribution) event.attribution.messageJobId = null;
  input.batchId = `boss-batch-${stableHash(bossBatchDigestInput(input))}`;
  return input;
}

test('缺少消息岗位身份时依据会话应用新消息和历史等待项，记录依据且保留原事实身份', async () => {
  const data = applySynthetic(boundData(), batch([event()]));
  const row = resumeEvent({ summary: 'resume_request_sent' });
  const input = conversationResumeBatch([row]);
  const raw = structuredClone(input);
  raw.events[0].attribution = null;
  raw.batchId = `boss-batch-${stableHash(bossBatchDigestInput(raw))}`;
  const waiting = applySynthetic(data, raw);
  validateQueuedBossBatch(input);
  await verifyBossBatch(input);
  const applied = applySynthetic(waiting, input);
  assert.equal(applied.opportunities[0].resumeState, '已发送');
  assert.equal(applied.opportunities[0].readState, '已读');
  assert.equal(applied.opportunities[0].stage, '沟通中');
  assert.equal(applied.sourceEvents.length, waiting.sourceEvents.length);
  assert.equal(applied.sourceFacts.length, waiting.sourceFacts.length);
  assert.equal(applied.sourceApplications.at(-1).id, waiting.sourceApplications.at(-1).id);
  assert.equal(
    applied.sourceApplications.at(-1).reason,
    'resume_status_advanced_conversation_association',
  );
  assert.equal(applied.sourceApplications.at(-1).ruleVersion, 'boss-application-v10');
  assert.deepEqual(applySynthetic(applied, input), applied);
  const restored = structuredClone(waiting);
  restored.sourceFacts.pop();
  restored.sourceApplications.pop();
  const replay = applySynthetic(restored, input, { allowEventRestore: true });
  assert.equal(
    replay.sourceApplications.at(-1).reason,
    'resume_status_advanced_conversation_association',
  );
});

test('会话归属仍拒绝缺联系人、错误参与者、无岗位、跨岗位重复，人工保护和否决不变', () => {
  const data = twoJobs();
  const row = resumeEvent({ summary: 'resume_request_sent' });
  for (const [field, value, reason] of [
    ['responseFriendId', null, 'attribution_conversation_missing'],
    ['senderId', 'wrong-person', 'attribution_participant_conflict'],
    ['selfId', null, 'attribution_participants_missing'],
  ]) {
    const input = conversationResumeBatch([row]);
    input.events[0].attribution[field] = value;
    const result = applySynthetic(data, input);
    assert.deepEqual(result.opportunities, data.opportunities);
    assert.equal(result.sourceApplications.at(-1).reason, reason);
  }
  const missingJob = conversationResumeBatch([
    resumeEvent({ externalJobId: '', summary: 'resume_request_sent' }),
  ]);
  assert.equal(
    applySynthetic(data, missingJob).sourceApplications.at(-1).reason,
    'attribution_job_missing',
  );
  const conflicting = conversationResumeBatch([
    row,
    secondResume({ summary: 'resume_request_sent' }),
  ]);
  const blocked = applySynthetic(data, conflicting);
  assert.deepEqual(blocked.opportunities, data.opportunities);
  assert.ok(
    blocked.sourceApplications
      .filter((a) => a.action === 'resume_observed')
      .every((a) => a.reason === 'attribution_message_multiple_jobs'),
  );
  const input = conversationResumeBatch([row]);
  const manual = structuredClone(data);
  const job = manual.opportunities.find((o) => o.externalId === JOB_ID);
  markManualFields(manual, job.id, ['resumeState']);
  const protectedData = applySynthetic(manual, input);
  assert.equal(protectedData.sourceApplications.at(-1).status, 'protected');
  assert.deepEqual(protectedData.opportunities, manual.opportunities);
  const applied = applySynthetic(data, input);
  const rejected = rejectMisattributedResumeObservation(applied, {
    opportunityId: applied.opportunities.find((o) => o.externalId === JOB_ID).id,
    eventId: input.events[0].eventId,
    stamp: STAMP,
  });
  assert.deepEqual(applySynthetic(rejected, input), rejected);
});

test('缺标题普通观察只接受完整且唯一的现有精确绑定，不改人工字段', () => {
  const options = { workspaceSourceId: SOURCE_ID, stamp: STAMP };
  const initial = applyBossBatch(boundData(), batch([event()]), options).data;
  const binding = initial.sourceBindings.find((row) => row.kind === 'opportunity');
  binding.autoFields = '';
  const incoming = event({ jobName: '', intent: 'review', messageId: 'missing-title' });
  const result = applyBossBatch(initial, batch([incoming]), options).data;
  assert.equal(result.sourceApplications.at(-1).status, 'no_effect');
  assert.deepEqual(result.opportunities, initial.opportunities);
  assert.deepEqual(result.sourceBindings, initial.sourceBindings);
  for (const overrides of [{ company: '另一公司' }, { jobName: '另一岗位' }]) {
    const rejected = applyBossBatch(
      initial,
      batch([event({ jobName: '', intent: 'review', messageId: 'missing-title', ...overrides })]),
      options,
    ).data;
    assert.equal(rejected.sourceApplications.at(-1).status, 'review');
    assert.deepEqual(rejected.opportunities, initial.opportunities);
  }
  assert.throws(
    () =>
      applyBossBatch(
        initial,
        batch([
          event({
            jobName: '',
            intent: 'review',
            canonicalUrl: 'https://www.zhipin.com/job_detail/otherJob.html',
          }),
        ]),
        options,
      ),
    { code: 'BATCH_INVALID' },
  );
  const deleted = structuredClone(initial);
  deleted.opportunities[0].deletedAt = STAMP;
  assert.equal(
    applyBossBatch(deleted, batch([incoming]), options).data.sourceApplications.at(-1).status,
    'review',
  );
  const unbound = structuredClone(initial);
  unbound.sourceBindings = unbound.sourceBindings.filter((row) => row.kind === 'account');
  assert.equal(
    applyBossBatch(unbound, batch([incoming]), options).data.sourceApplications.at(-1).status,
    'no_effect',
  );
});

test('人工忽略保留原始观察，重复消费、补证与恢复不应用，新消息继续处理', () => {
  const options = { workspaceSourceId: SOURCE_ID, stamp: STAMP };
  const incoming = event({ jobName: '', intent: 'review' });
  const waiting = applyBossBatch(boundData(), batch([incoming]), options).data;
  const id = bossWaitingItems(waiting)[0].applicationId;
  const ignored = ignoreBossObservations(waiting, { applicationIds: [id], ...options });
  assert.deepEqual(ignored.sourceEvents, waiting.sourceEvents);
  assert.deepEqual(ignored.sourceFacts, waiting.sourceFacts);
  assert.deepEqual(ignored.opportunities, waiting.opportunities);
  assert.equal(sourceReviewCounts(ignored).waiting, 0);
  assert.equal(sourceReviewCounts(ignored).protected, 0);
  assert.equal(sourceReviewCounts(ignored).ignored, 1);
  assert.equal(effectiveSourceFacts(ignored).length, 0);
  assert.deepEqual(applyBossBatch(ignored, batch([incoming]), options).data, ignored);
  const enriched = applyBossBatch(ignored, batch([event()]), {
    ...options,
    allowEventRestore: true,
  }).data;
  assert.equal(enriched.opportunities.length, 0);
  assert.equal(enriched.sourceEvents.length, 2);
  assert.equal(
    enriched.sourceApplications.find((row) => row.id === id).reason,
    'user_ignored_unresolved_observation',
  );
  const workspace = initialWorkspace();
  workspace.data = enriched;
  const restored = migrateWorkspace(
    restoreWorkspace(workspace, createBackup(workspace), 'snapshot'),
  );
  assert.equal(sourceReviewCounts(restored.data).ignored, 1);
  const fresh = applyBossBatch(
    restored.data,
    batch([event({ messageId: 'new-message' })]),
    options,
  ).data;
  assert.equal(fresh.opportunities.length, 1);
  assert.equal(sourceReviewCounts(fresh).ignored, 1);
  for (const applicationIds of [
    [id, 'boss-application-' + 'f'.repeat(64)],
    [id, id],
  ]) {
    assert.throws(() => ignoreBossObservations(waiting, { applicationIds, ...options }));
    assert.equal(waiting.sourceApplications[0].status, 'waiting');
  }
  assert.throws(
    () =>
      ignoreBossObservations(waiting, {
        applicationIds: [id],
        ...options,
        workspaceSourceId: '00000000-0000-4000-8000-000000000002',
      }),
    { code: 'BOSS_IGNORE_UNSAFE' },
  );
});

test('固定忽略命令版本检查、原子失败和丢失回执精确重试', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boss-ignore-'));
  let failStage = '';
  const store = new WorkspaceStore(join(root, 'workspace'), {
    now: () => STAMP,
    beforeCommit: async (stage) => {
      if (stage === failStage) {
        failStage = '';
        throw new Error('synthetic interruption');
      }
    },
  });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.initialize();
  const workspaceId = (await store.read()).workspaceId;
  const options = { workspaceSourceId: workspaceId, stamp: STAMP };
  const workspace = initialWorkspace();
  workspace.data = applyBossBatch(
    bindBossAccount(emptyData(), ACCOUNT, workspaceId, STAMP),
    batch([event({ jobName: '', intent: 'review' })]),
    options,
  ).data;
  const imported = await store.execute({
    commandId: 'ignore-fixture',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: 'synthetic' },
  });
  const applicationId = bossWaitingItems(imported.workspace.data)[0].applicationId;
  const command = {
    commandId: 'ignore-selected',
    expectedRevision: imported.revision,
    type: 'ignore_boss_observations',
    payload: { applicationIds: [applicationId] },
  };
  await assert.rejects(
    store.execute({ ...command, commandId: 'stale-ignore', expectedRevision: 0 }),
    { code: 'WORKSPACE_REVISION_CONFLICT' },
  );
  await assert.rejects(
    store.execute({
      ...command,
      commandId: 'unsafe-ignore',
      payload: { applicationIds: [applicationId, 'boss-application-' + 'f'.repeat(64)] },
    }),
    { code: 'BOSS_IGNORE_UNSAFE' },
  );
  failStage = 'before_head';
  await assert.rejects(store.execute(command), /synthetic interruption/);
  assert.equal((await store.read()).revision, imported.revision);
  assert.equal((await store.read()).workspace.data.sourceApplications[0].status, 'waiting');
  failStage = 'after_head';
  await assert.rejects(store.execute(command), /synthetic interruption/);
  const retried = await store.execute(command);
  assert.equal(retried.replayed, true);
  assert.equal(sourceReviewCounts(retried.workspace.data).ignored, 1);
  assert.equal(retried.revision, imported.revision + 1);
});

test('忽略的普通观察仍提供跨岗位线索，人工决定不因同步合并消失', async () => {
  const { mergeData } = await import('../dist/model.js');
  const options = { workspaceSourceId: SOURCE_ID, stamp: STAMP };
  const waiting = applyBossBatch(
    boundData(),
    batch([event({ jobName: '', intent: 'review', messageId: 'shared-message' })]),
    options,
  ).data;
  const ignored = ignoreBossObservations(waiting, {
    ...options,
    applicationIds: bossWaitingItems(waiting).map((item) => item.applicationId),
  });
  const merged = mergeData(waiting, ignored, waiting);
  assert.equal(merged.conflicts.length, 0);
  assert.equal(sourceReviewCounts(merged.data).ignored, 1);
  const otherJob = event({
    externalJobId: 'otherJob',
    canonicalUrl: 'https://www.zhipin.com/job_detail/otherJob.html',
    messageId: 'other-intro',
  });
  const seeded = applyBossBatch(ignored, batch([otherJob]), options).data;
  const otherResume = resumeEvent({
    externalJobId: 'otherJob',
    canonicalUrl: otherJob.canonicalUrl,
    messageId: 'shared-message',
    linked: true,
    summary: 'resume_sent_confirmed',
  });
  const result = applyBossBatch(seeded, verifiedResumeBatch([otherResume]), options).data;
  assert.equal(result.sourceApplications.at(-1).reason, 'attribution_message_multiple_jobs');
  assert.equal(sourceReviewCounts(result).ignored, 1);
});

test('同步待处理状态下整批忽略拒绝且不改来源决定', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boss-ignore-pending-'));
  const store = new WorkspaceStore(join(root, 'workspace'), { now: () => STAMP });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.initialize();
  const workspaceId = (await store.read()).workspaceId;
  const workspace = initialWorkspace();
  workspace.data = applyBossBatch(
    bindBossAccount(emptyData(), ACCOUNT, workspaceId, STAMP),
    batch([event({ jobName: '', intent: 'review' })]),
    { workspaceSourceId: workspaceId, stamp: STAMP },
  ).data;
  workspace.pending = {
    data: structuredClone(workspace.data),
    remote: structuredClone(workspace.data),
    conflicts: [],
    generation: workspace.generation,
  };
  const imported = await store.execute({
    commandId: 'pending-ignore-fixture',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: 'synthetic' },
  });
  await assert.rejects(
    store.execute({
      commandId: 'ignore-pending',
      expectedRevision: imported.revision,
      type: 'ignore_boss_observations',
      payload: {
        applicationIds: bossWaitingItems(workspace.data).map((item) => item.applicationId),
      },
    }),
    { code: 'SYNC_CONFLICT' },
  );
  assert.deepEqual((await store.read()).workspace, imported.workspace);
});

test('等待项核对只读选择精确绑定目标，人工控制标识与实际所有权一致', async () => {
  const { bossIntegrationView } = await import('../dist/settings-view.js');
  const options = { workspaceSourceId: SOURCE_ID, stamp: STAMP };
  const initial = applyBossBatch(boundData(), batch([event()]), options).data;
  const waiting = applyBossBatch(
    initial,
    resumeBatch([resumeEvent({ linked: true, summary: 'resume_sent_confirmed' })]),
    options,
  ).data;
  const application = waiting.sourceApplications.at(-1);
  const original = structuredClone(waiting);
  const target = bossWaitingReviewTarget(waiting, application.id);
  assert.equal(target.opportunityId, initial.opportunities[0].id);
  assert.equal(target.company, '合成公司');
  assert.equal(target.role, '合成岗位');
  assert.equal(target.resumeState, '未知');
  assert.equal(target.manualResumeState, false);
  const html = bossIntegrationView(
    { available: true, serverManaged: true, revision: 1, waitingItems: bossWaitingItems(waiting) },
    { data: waiting },
  );
  assert.match(html, /查看候选岗位/);
  assert.match(html, /编辑岗位状态/);
  assert.match(html, /本机候选岗位/);
  assert.match(html, /当前简历：未知 · 自动维护/);
  assert.match(html, /编辑岗位不会确认消息归属或自动忽略旧消息/);
  assert.deepEqual(waiting, original);
  const manual = structuredClone(waiting);
  manual.opportunities[0].resumeState = '已发送';
  assert.equal(bossWaitingReviewTarget(manual, application.id).manualResumeState, true);
  assert.equal(bossWaitingReviewTarget(manual, application.id).resumeState, '已发送');
  const sameValueManual = structuredClone(waiting);
  markManualFields(sameValueManual, target.opportunityId, ['resumeState']);
  assert.equal(bossWaitingReviewTarget(sameValueManual, application.id).manualResumeState, true);
  const manualHtml = bossIntegrationView(
    { available: true, serverManaged: true, revision: 1, waitingItems: bossWaitingItems(manual) },
    { data: manual },
  );
  assert.match(manualHtml, /当前简历：已发送 · 由你设置（人工控制）/);
});

test('等待项直达入口拒绝跨账号、多目标、链接矛盾、删除与未绑定，不按名称猜测', async () => {
  const { bossIntegrationView } = await import('../dist/settings-view.js');
  const options = { workspaceSourceId: SOURCE_ID, stamp: STAMP };
  const initial = applyBossBatch(boundData(), batch([event()]), options).data;
  const waiting = applyBossBatch(
    initial,
    resumeBatch([resumeEvent({ linked: true, summary: 'resume_sent_confirmed' })]),
    options,
  ).data;
  const id = waiting.sourceApplications.at(-1).id;
  const variants = [
    (data) => {
      data.sourceBindings.find((row) => row.kind === 'opportunity').accountNamespace =
        OTHER_ACCOUNT;
    },
    (data) => {
      data.sourceBindings.push({
        ...data.sourceBindings.find((row) => row.kind === 'opportunity'),
        id: 'duplicate-binding',
      });
    },
    (data) => {
      data.opportunities[0].url = 'https://www.zhipin.com/job_detail/otherJob.html';
    },
    (data) => {
      data.opportunities[0].deletedAt = STAMP;
    },
    (data) => {
      data.sourceBindings = data.sourceBindings.filter((row) => row.kind === 'account');
    },
    (data) => {
      data.sourceApplications.at(-1).status = 'protected';
    },
    (data) => {
      data.sourceFacts.find((row) => row.id === data.sourceApplications.at(-1).factId).deletedAt =
        STAMP;
    },
    (data) => {
      const e = data.sourceEvents.at(-1);
      data.sourceEvents.push({
        ...e,
        id: 'another-observation',
        externalJobId: 'otherJob',
        canonicalUrl: 'https://www.zhipin.com/job_detail/otherJob.html',
      });
    },
    (data) => {
      data.opportunities[0].company = '另一公司';
    },
  ];
  for (const mutate of variants) {
    const data = structuredClone(waiting);
    mutate(data);
    assert.equal(bossWaitingReviewTarget(data, id), null);
    const html = bossIntegrationView(
      {
        available: true,
        serverManaged: true,
        revision: 1,
        waitingItems: [{ applicationId: id, reason: 'attribution_evidence_missing' }],
      },
      { data },
    );
    // A completed/manual application must not reappear from stale index rows.
    if (['waiting', 'review'].includes(data.sourceApplications.at(-1).status))
      assert.match(html, /未找到可唯一对应的本机岗位/);
    else assert.doesNotMatch(html, /data-boss-ignore-item/);
    assert.doesNotMatch(html, /data-boss-review-action=/);
  }
  const views = createViews(
    () => ({
      state: { data: waiting },
      selected: initial.opportunities[0].id,
      detailBackLabel: '返回观察列表',
    }),
    () => [],
  );
  assert.match(views.detail(), /data-close-detail>← 返回观察列表/);
});

test('缺标题精确本机资料可建立非自动字段绑定；矛盾、跨账号、多目标仍拦截', () => {
  const options = { workspaceSourceId: SOURCE_ID, stamp: STAMP };
  const seeded = applyBossBatch(boundData(), batch([event()]), options).data;
  seeded.sourceBindings = seeded.sourceBindings.filter((row) => row.kind === 'account');
  const incoming = batch([event({ jobName: '', intent: 'review', messageId: 'local-details' })]);
  const result = applyBossBatch(seeded, incoming, options).data;
  assert.equal(result.sourceApplications.at(-1).status, 'no_effect');
  assert.equal(result.sourceApplications.at(-1).reason, 'existing_job_details_available');
  assert.equal(result.sourceBindings.at(-1).autoFields, '');
  assert.deepEqual(result.opportunities, seeded.opportunities);
  assert.deepEqual(applyBossBatch(result, incoming, options).data, result);
  for (const change of [
    (data) => {
      data.opportunities[0].company = '矛盾公司';
    },
    (data) => {
      data.opportunities[0].url = 'https://www.zhipin.com/job_detail/other.html';
    },
    (data) => {
      data.opportunities[0].deletedAt = STAMP;
    },
    (data) => {
      data.opportunities.push({ ...data.opportunities[0], id: 'duplicate-job' });
    },
    (data) => {
      data.sourceBindings.push({
        ...data.sourceBindings[0],
        id: `boss-account-${OTHER_ACCOUNT.slice('boss-geek:'.length)}`,
        accountNamespace: OTHER_ACCOUNT,
      });
      data.sourceBindings.push({
        ...result.sourceBindings.at(-1),
        id: `boss-job-${OTHER_ACCOUNT.slice('boss-geek:'.length)}-${JOB_ID}`,
        accountNamespace: OTHER_ACCOUNT,
      });
    },
  ]) {
    const data = structuredClone(seeded);
    change(data);
    const rejected = applyBossBatch(data, incoming, options).data;
    assert.equal(rejected.sourceApplications.at(-1).status, 'review');
    assert.deepEqual(rejected.opportunities, data.opportunities);
    assert.deepEqual(rejected.sourceBindings, data.sourceBindings);
  }
});

test('候选在观察卡片内核对；名称建议只用于导航，不能自动完成简历归属', async () => {
  const { bossIntegrationView } = await import('../dist/settings-view.js');
  const options = { workspaceSourceId: SOURCE_ID, stamp: STAMP };
  const initial = applyBossBatch(boundData(), batch([event()]), options).data;
  initial.sourceBindings = initial.sourceBindings.filter((row) => row.kind === 'account');
  const waiting = applyBossBatch(
    initial,
    resumeBatch([resumeEvent({ linked: true })]),
    options,
  ).data;
  const application = waiting.sourceApplications.at(-1);
  const before = structuredClone(waiting);
  const candidates = bossWaitingReviewCandidates(waiting, application.id);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].exact, true);
  const html = bossIntegrationView(
    {
      available: true,
      serverManaged: true,
      revision: 1,
      waitingItems: [{ applicationId: application.id, reason: application.reason }],
    },
    { data: waiting },
  );
  assert.match(html, /核对本机候选岗位/);
  assert.match(html, /打开岗位详情/);
  assert.match(html, /data-boss-candidate=/);
  assert.doesNotMatch(html, /data-view="list"/);
  assert.deepEqual(waiting, before);
  const other = structuredClone(waiting);
  other.opportunities[0].externalId = 'other-job';
  other.opportunities[0].url = 'https://www.zhipin.com/job_detail/other-job.html';
  assert.equal(bossWaitingReviewCandidates(other, application.id)[0].exact, false);
  other.opportunities[0].deletedAt = STAMP;
  assert.deepEqual(bossWaitingReviewCandidates(other, application.id), []);
});

test('明确岗位资料矛盾展示来源公司和本机候选，不提供忽略等待项操作', async () => {
  const { bossIntegrationView } = await import('../dist/settings-view.js');
  const options = { workspaceSourceId: SOURCE_ID, stamp: STAMP };
  const initial = applyBossBatch(boundData(), batch([event()]), options).data;
  initial.sourceBindings = initial.sourceBindings.filter((row) => row.kind === 'account');
  const data = applyBossBatch(
    initial,
    batch([
      event({ jobName: '', intent: 'review', company: '来源不同公司', messageId: 'contradiction' }),
    ]),
    options,
  ).data;
  const html = bossIntegrationView({ available: true, applicationCounts: { review: 1 } }, { data });
  assert.match(html, /岗位资料不一致/);
  assert.match(html, /来源不同公司/);
  assert.match(html, /合成公司/);
  assert.match(html, /打开岗位详情/);
  assert.doesNotMatch(html, /data-boss-ignore-item=/);
});

test('详情页补资料允许招聘方与用人公司不同，原观察与身份不改，人工字段不覆盖', async () => {
  const { parseBossJobUrl } = await import('../dist/boss-job-url.js');
  assert.deepEqual(
    parseBossJobUrl('https://www.zhipin.com/job_detail/job~.html?securityId=synthetic#top'),
    { jobId: 'job~', canonicalUrl: 'https://www.zhipin.com/job_detail/job~.html' },
  );
  for (const bad of [
    'https://www.zhipin.com:443/job_detail/job~.html',
    'https://evil.example/job_detail/job~.html',
    'https://www.zhipin.com/job_detail/../job.html',
    'https://www.zhipin.com/job_detail/a%2Fb.html',
  ])
    assert.equal(parseBossJobUrl(bad), null);
  const observation = event({
    externalJobId: 'job~',
    canonicalUrl: 'https://www.zhipin.com/job_detail/job~.html',
    jobName: '',
    company: '合成猎头',
    intent: 'review',
  });
  const originalEventId = observation.eventId;
  const delivery = batch([observation]);
  delivery.version = 4;
  delivery.events[0].jobDetails = {
    jobId: 'job~',
    canonicalUrl: observation.canonicalUrl,
    company: '某匿名用人企业',
    jobName: '详情岗位',
    source: 'detail_page_title',
  };
  delivery.batchId = `boss-batch-${stableHash(bossBatchDigestInput(delivery))}`;
  await verifyBossBatch(delivery);
  const bound = bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, STAMP);
  const result = applyBossBatch(bound, delivery, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  }).data;
  assert.equal(result.opportunities[0].company, '某匿名用人企业');
  assert.equal(result.opportunities[0].role, '详情岗位');
  assert.equal(result.sourceEvents[0].company, '合成猎头');
  assert.equal(result.sourceEvents[0].jobName, '');
  assert.equal(result.sourceEvents[0].id, originalEventId);
  const conflictingDetails = structuredClone(delivery);
  Object.assign(conflictingDetails.events[0].jobDetails, {
    source: 'detail_page_conflict',
    company: '',
    jobName: '',
  });
  const conflictResult = applyBossBatch(bound, conflictingDetails, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  }).data;
  assert.equal(conflictResult.opportunities.length, 0);
  assert.equal(conflictResult.sourceApplications[0].status, 'review');
  const identityConflict = structuredClone(delivery);
  identityConflict.events[0].jobDetails.jobId = 'other';
  assert.throws(() =>
    applyBossBatch(bound, identityConflict, { workspaceSourceId: SOURCE_ID, stamp: STAMP }),
  );
  const owned = bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, STAMP);
  owned.opportunities.push({
    id: 'manual',
    company: '人工公司',
    role: '人工岗位',
    platform: 'BOSS',
    stage: '面试中',
    resumeState: '未知',
    externalId: 'job~',
    url: observation.canonicalUrl,
  });
  const protectedResult = applyBossBatch(owned, delivery, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  }).data;
  assert.equal(protectedResult.opportunities[0].company, '人工公司');
  assert.equal(protectedResult.opportunities[0].role, '人工岗位');
});

test('人工定点补齐只完成普通资料观察，持续重放保留决定、原证据和简历状态', async () => {
  const { resolveBossJobDetails, groupBossObservations } =
    await import('../dist/boss-observations.js');
  const observations = [
    event({ externalJobId: '', canonicalUrl: '', jobName: '', intent: 'review' }),
    event({
      externalJobId: '',
      canonicalUrl: '',
      jobName: '',
      intent: 'review',
      messageDirection: 'unknown',
      receiptStatus: 'unknown',
      receiptSource: '',
    }),
  ];
  const delivery = batch(observations);
  const bound = bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, STAMP);
  const data = applyBossBatch(bound, delivery, { workspaceSourceId: SOURCE_ID, stamp: STAMP }).data;
  data.opportunities.push({
    id: 'manual-target',
    company: '人工公司',
    role: '人工岗位',
    stage: '面试中',
    platform: 'BOSS',
    externalId: JOB_ID,
    url: JOB_URL,
    resumeState: '未知',
  });
  const original = structuredClone(data);
  const items = bossWaitingItems(data);
  assert.equal(items.length, 2);
  assert.equal(groupBossObservations(items, data).length, 1);
  const options = {
    applicationIds: items.map((item) => item.applicationId),
    opportunityId: 'manual-target',
    externalJobId: JOB_ID,
    canonicalUrl: JOB_URL,
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  };
  const resolved = resolveBossJobDetails(data, options);
  assert.deepEqual(data, original);
  assert.deepEqual(resolved.sourceEvents, original.sourceEvents);
  assert.equal(bossWaitingItems(resolved).length, 0);
  assert.ok(
    resolved.sourceApplications.every(
      (row) =>
        row.status === 'no_effect' &&
        row.reason === 'user_confirmed_job_details' &&
        row.resolutionSource === 'user',
    ),
  );
  assert.deepEqual(
    applyBossBatch(resolved, delivery, { workspaceSourceId: SOURCE_ID, stamp: STAMP }).data,
    resolved,
  );
  assert.equal(resolved.opportunities[0].resumeState, '未知');
  const currentWorkspace = initialWorkspace();
  currentWorkspace.data = resolved;
  const oldWorkspace = initialWorkspace();
  oldWorkspace.data = original;
  for (const mode of ['merge', 'snapshot']) {
    const restored = restoreWorkspace(currentWorkspace, createBackup(oldWorkspace), mode);
    assert.ok(
      restored.data.sourceApplications.every((row) => row.reason === 'user_confirmed_job_details'),
    );
    assert.equal(bossWaitingItems(restored.data).length, 0);
  }
  const ignored = ignoreBossObservations(data, {
    applicationIds: options.applicationIds,
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.throws(() => resolveBossJobDetails(ignored, options), /刷新/);
  const wrong = structuredClone(data);
  wrong.sourceApplications[0].reason = 'attribution_message_multiple_jobs';
  assert.throws(() => resolveBossJobDetails(wrong, options));
  const duplicate = structuredClone(data);
  duplicate.opportunities.push({
    ...duplicate.opportunities[0],
    id: 'deleted-copy',
    deletedAt: STAMP,
  });
  assert.throws(() => resolveBossJobDetails(duplicate, options));
});

test('关闭标识可保存在无岗位的观察，重放仍等待，消息分组隔离账号且冲突优先', async () => {
  const { setBossJobState, groupBossObservations, propagatePlatformJobState } =
    await import('../dist/boss-observations.js');
  const observations = [
    event({ jobName: '', intent: 'review' }),
    event({
      jobName: '',
      intent: 'review',
      messageDirection: 'unknown',
      receiptStatus: 'unknown',
      receiptSource: '',
    }),
  ];
  const delivery = batch(observations);
  const bound = bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, STAMP);
  const data = applyBossBatch(bound, delivery, { workspaceSourceId: SOURCE_ID, stamp: STAMP }).data;
  const items = bossWaitingItems(data);
  const closed = setBossJobState(data, {
    applicationIds: items.map((item) => item.applicationId),
    externalJobId: JOB_ID,
    canonicalUrl: JOB_URL,
    state: 'closed',
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(closed.opportunities.length, 0);
  assert.equal(bossWaitingItems(closed).length, 2);
  assert.ok(closed.sourceApplications.every((row) => row.platformJobState === 'closed'));
  const replay = applyBossBatch(closed, delivery, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  }).data;
  assert.deepEqual(replay, closed);
  const later = batch([event({ jobName: '', intent: 'review', messageId: 'later-message' })]);
  const newMessage = applyBossBatch(closed, later, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  }).data;
  assert.equal(newMessage.sourceApplications.at(-1).platformJobState, 'closed');
  assert.equal(newMessage.sourceApplications.at(-1).status, 'waiting');
  const rows = items.map((item) => ({ ...item, status: 'waiting' }));
  rows[0].status = 'review';
  rows[0].reason = 'attribution_message_multiple_jobs';
  const groups = groupBossObservations(rows, closed);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].status, 'review');
  assert.equal(groups[0].waitingApplicationIds.length, 1);
  const mixed = [
    { ...rows[0], reason: 'identity_conflict' },
    { ...rows[1], reason: 'attribution_evidence_missing' },
  ];
  for (const ordered of [mixed, [...mixed].reverse()]) {
    assert.equal(groupBossObservations(ordered, closed)[0].status, 'review');
    assert.equal(groupBossObservations(ordered, closed)[0].reason, 'identity_conflict');
  }
  assert.equal(groups[0].platformJobState, 'closed');
  const extra = {
    ...closed.sourceEvents[0],
    id: 'synthetic-other',
    accountNamespace: OTHER_ACCOUNT,
  };
  const otherApp = {
    ...closed.sourceApplications[0],
    id: 'synthetic-app',
    factId: 'synthetic-fact',
  };
  extra.factId = otherApp.factId;
  const separated = {
    ...closed,
    sourceEvents: [...closed.sourceEvents, extra],
    sourceApplications: [...closed.sourceApplications, otherApp],
  };
  assert.equal(
    groupBossObservations([...items, { ...items[0], applicationId: otherApp.id }], separated)
      .length,
    2,
  );
  const inconsistent = structuredClone(closed);
  inconsistent.sourceApplications[0].platformJobState = 'open';
  assert.equal(groupBossObservations(items, inconsistent)[0].platformJobState, 'conflict');
  const before = structuredClone(closed);
  before.opportunities.push({
    id: 'target',
    company: '公司',
    role: '岗位',
    stage: '面试中',
    externalId: JOB_ID,
    url: JOB_URL,
  });
  const next = structuredClone(before);
  next.opportunities[0].platformJobState = 'closed';
  propagatePlatformJobState(before, next, STAMP);
  assert.equal(next.opportunities[0].stage, '面试中');
});

test('资料补齐与关闭命令遵守版本、原子失败和精确重试；同步冲突不能部分修改', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boss-details-command-'));
  let failStage = '';
  const store = new WorkspaceStore(join(root, 'workspace'), {
    now: () => STAMP,
    beforeCommit: async (stage) => {
      if (stage === failStage) {
        failStage = '';
        throw new Error('synthetic interruption');
      }
    },
  });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.initialize();
  const workspaceId = (await store.read()).workspaceId;
  const workspace = initialWorkspace();
  workspace.data = applyBossBatch(
    bindBossAccount(emptyData(), ACCOUNT, workspaceId, STAMP),
    batch([event({ externalJobId: '', canonicalUrl: '', jobName: '', intent: 'review' })]),
    { workspaceSourceId: workspaceId, stamp: STAMP },
  ).data;
  workspace.data.opportunities.push({
    id: 'manual-target',
    company: '人工公司',
    role: '岗位',
    stage: '已触达',
    platform: 'BOSS',
    externalId: '',
    url: JOB_URL,
  });
  workspace.data.opportunities.push({
    id: 'retired-target',
    company: '人工公司',
    role: '岗位',
    stage: '已触达',
    platform: 'BOSS',
    externalId: JOB_ID,
    url: JOB_URL,
    deletedAt: STAMP,
  });
  const imported = await store.execute({
    commandId: 'details-import',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: 'synthetic' },
  });
  const id = bossWaitingItems(imported.workspace.data)[0].applicationId;
  const command = {
    commandId: 'details-resolve',
    expectedRevision: imported.revision,
    type: 'resolve_boss_job_details',
    payload: {
      applicationIds: [id],
      opportunityId: 'manual-target',
      externalJobId: JOB_ID,
      canonicalUrl: JOB_URL,
      retiredOpportunityIds: ['retired-target'],
    },
  };
  const { retiredOpportunityIds: _retired, ...unconfirmedPayload } = command.payload;
  await assert.rejects(
    store.execute({ ...command, commandId: 'retired-unconfirmed', payload: unconfirmedPayload }),
    { code: 'BOSS_DETAILS_UNSAFE' },
  );
  await assert.rejects(store.execute({ ...command, commandId: 'stale', expectedRevision: 0 }), {
    code: 'WORKSPACE_REVISION_CONFLICT',
  });
  await assert.rejects(
    store.execute({
      ...command,
      commandId: 'unsafe',
      payload: { ...command.payload, applicationIds: [id, `boss-application-${'f'.repeat(64)}`] },
    }),
    { code: 'BOSS_DETAILS_UNSAFE' },
  );
  assert.deepEqual((await store.read()).workspace, imported.workspace);
  failStage = 'before_head';
  await assert.rejects(store.execute(command), /synthetic interruption/);
  assert.equal((await store.read()).revision, imported.revision);
  assert.deepEqual((await store.read()).workspace, imported.workspace);
  const completed = await store.execute(command);
  assert.equal(completed.workspace.data.sourceApplications[0].reason, 'user_confirmed_job_details');
  assert.equal(completed.workspace.data.opportunities[0].externalId, JOB_ID);
  assert.deepEqual(
    completed.workspace.data.opportunities[1],
    imported.workspace.data.opportunities[1],
  );
  const retry = await store.execute(command);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.workspace, completed.workspace);
  assert.equal(retry.revision, completed.revision);
  const pending = structuredClone(completed.workspace);
  pending.pending = {
    data: structuredClone(pending.data),
    remote: structuredClone(pending.data),
    conflicts: [],
    generation: pending.generation,
  };
  const staged = await store.execute({
    commandId: 'details-pending',
    expectedRevision: completed.revision,
    type: 'commit_workspace',
    payload: { workspace: pending, reason: 'synthetic conflict' },
  });
  await assert.rejects(
    store.execute({ ...command, commandId: 'pending-denied', expectedRevision: staged.revision }),
    { code: 'SYNC_CONFLICT' },
  );
  assert.deepEqual((await store.read()).workspace, staged.workspace);
});

test('岗位详情按消息汇总普通观察和送达回执，底层事实仍独立保存', () => {
  const data = applyBossBatch(
    boundData(),
    batch([
      event(),
      event({ messageDirection: 'unknown', receiptStatus: 'unknown', receiptSource: '' }),
    ]),
    { workspaceSourceId: SOURCE_ID, stamp: STAMP },
  ).data;
  const views = createViews(
    () => ({ state: { data }, selected: data.opportunities[0].id }),
    () => [],
  );
  assert.match(views.detail(), /1 条消息 · 2 项观察/);
  assert.equal(data.sourceFacts.length, 2);
  assert.match(views.detail(), /包含 2 项观察/);
});
