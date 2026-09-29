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
import { effectiveSourceFacts } from '../dist/source-ledger.js';
import { initialWorkspace } from '../dist/workspace.js';
import {
  applyBossBatch,
  bindBossAccount,
  rejectMisattributedResumeObservation,
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
  input.events = events.map((event) => ({
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
  }));
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
    ['messageJobId', null, 'attribution_job_missing'],
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
