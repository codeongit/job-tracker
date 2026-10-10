import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bossBatchDigestInput, bossEventDigestInput } from '../dist/boss-batch.js';
import {
  applyBossBatch,
  bindBossAccount,
  ignoreBossObservations,
  rejectMisattributedResumeObservation,
  verifyBossBatch,
} from '../dist/boss-integration.js';
import { emptyData, markManualFields } from '../dist/model.js';
import { BossInbox, validateBossBatch } from '../scripts/boss-inbox.mjs';
import {
  createResumeEvents,
  createResumeBatch,
  createIncrementalBatch,
  stableHash,
} from '../scripts/boss-conversion.mjs';
import { createWorkspaceInboxConsumer } from '../scripts/workspace-consumer.mjs';
import { initialWorkspace } from '../dist/workspace.js';
import { WorkspaceStore } from '../scripts/workspace-store.mjs';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const SOURCE_ID = '00000000-0000-4000-8000-000000000001';
const STAMP = '2026-10-08T01:00:00.000Z';
const JOB_ID = 'synthetic-job';
const JOB_URL = `https://www.zhipin.com/job_detail/${JOB_ID}.html`;
const SENT = { version: 1, messageType: 5, field: 'body.text', text: '附件简历请求已发送' };
const CARD = { version: 1, messageType: 4, field: 'none', text: '' };
const ATTACHMENT_SENT = {
  version: 2,
  messageType: 3,
  field: 'body.hyperLink.text',
  text: '您的附件简历 [attachment] 已发送给Boss',
  bizType: 13,
  bodyType: 12,
  templateId: 1,
  hyperLinkType: 6,
};
const VIEWED = {
  version: 2,
  messageType: 4,
  field: 'body.text',
  text: '对方已查看了您的附件简历',
  bizType: null,
  bodyType: 1,
  templateId: 3,
  hyperLinkType: null,
};

function attribution(overrides = {}) {
  return {
    version: 1,
    source: 'history',
    accountNamespace: ACCOUNT,
    conversationKey: '1'.repeat(64),
    messageId: 'resume-message',
    requestedBossId: 'boss-1',
    responseFriendId: 'friend-1',
    responseFriendSource: 'source-1',
    responseBossId: 'boss-1',
    selfId: 'self-1',
    senderId: 'boss-1',
    recipientId: 'self-1',
    messageJobId: null,
    ...overrides,
  };
}

function delivery({
  version = 5,
  ordinary = false,
  proof = SENT,
  evidence = attribution(),
  sequence = 2,
  ...overrides
} = {}) {
  const event = {
    eventId: '',
    ...(!ordinary
      ? {
          eventType: 'resume_observed',
          ...(version >= 3 ? { attribution: evidence } : {}),
          ...(version >= 5 ? { resumeEvidence: proof } : {}),
        }
      : {}),
    ...(version >= 4 ? { jobDetails: null } : {}),
    conversationKey: '1'.repeat(64),
    friendId: 'friend-1',
    friendSource: 'source-1',
    uniqueId: 'friend-1-source-1',
    externalJobId: JOB_ID,
    canonicalUrl: JOB_URL,
    jobName: '合成岗位',
    company: '合成公司',
    contact: '合成招聘者',
    summary: ordinary ? '合成普通消息' : 'resume_request_sent',
    timeLabel: '',
    messageId: ordinary ? 'seed-message' : 'resume-message',
    messageDirection: ordinary ? 'unknown' : 'inbound',
    receiptStatus: ordinary ? 'unknown' : 'not_applicable',
    receiptSource: '',
    observedAt: STAMP,
    evidenceDate: '',
    nameSource: 'loaded_jobName',
    linkConfirmation: 'unverified',
    intent: ordinary ? 'create_or_link' : 'observe_only',
    appliedAtForNew: '',
    sourceSequence: sequence,
    ...overrides,
  };
  const batch = {
    format: 'job-tracker-boss-batch',
    version,
    batchId: '',
    platform: 'boss',
    accountNamespace: ACCOUNT,
    sourceSequence: sequence,
    policy: {
      id: ordinary ? 'boss-manual-check-v1' : 'boss-resume-observation-v3',
      mode: ordinary ? 'incremental' : 'resume',
      timezone: 'Asia/Shanghai',
      appliedAtForNew: '',
      autoCreateComplete: ordinary,
    },
    source: { snapshotName: 'synthetic.json', snapshotSha256: 'c'.repeat(64), capturedAt: STAMP },
    coverage: {
      loadedRows: 1,
      loadedDataRows: 1,
      renderedRows: 1,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
    events: [event],
  };
  event.eventId = `boss-event-${stableHash(bossEventDigestInput(batch, event))}`;
  batch.batchId = `boss-batch-${stableHash(bossBatchDigestInput(batch))}`;
  return batch;
}
const options = { workspaceSourceId: SOURCE_ID, stamp: STAMP };
function seed() {
  return applyBossBatch(
    bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, STAMP),
    delivery({ ordinary: true, version: 4, sequence: 1 }),
    options,
  ).data;
}
function observations(batches) {
  return batches.flatMap((batch) =>
    batch.events.map((event) => ({
      ...event,
      accountNamespace: batch.accountNamespace,
      platform: 'boss',
    })),
  );
}
function envelope({ messageType = 5, proof, kind = 'request_sent' } = {}) {
  const key = stableHash(['boss', ACCOUNT, 'friend-1', 'source-1']);
  const identity = {
    friendId: 'friend-1',
    friendSource: 'source-1',
    uniqueId: 'friend-1-source-1',
  };
  return {
    version: proof === undefined ? 4 : 5,
    accountNamespace: ACCOUNT,
    snapshot: {
      capturedAt: STAMP,
      accountNamespace: ACCOUNT,
      coverage: {
        loadedRows: 1,
        loadedDataRows: 1,
        renderedRows: 1,
        offscreenRows: 0,
        unresolvedRows: 0,
        truncated: false,
      },
      records: [
        {
          key,
          platformIdentity: identity,
          company: '合成公司',
          contact: '合成招聘者',
          title: '',
          preview: '合成普通消息',
          latestMessageId: 'seed-message',
          timeLabel: '',
          unread: null,
          outgoingReceipt: { status: 'unknown', label: null, source: null },
          observedJobName: null,
        },
      ],
    },
    jobs: {
      associations: [
        { conversationKey: key, jobId: JOB_ID, detailUrl: JOB_URL, status: 'current' },
      ],
      evidence: [
        {
          jobId: JOB_ID,
          detailUrl: JOB_URL,
          name: '合成岗位',
          source: 'loaded_jobName',
          company: '合成公司',
          observedAt: STAMP,
        },
      ],
      confirmations: [],
    },
    resume: {
      observations: [
        {
          conversationKey: key,
          platformIdentity: identity,
          externalJobId: JOB_ID,
          kind,
          messageId: 'resume-message',
          messageType,
          direction: 'inbound',
          platformTime: STAMP,
          observedAt: STAMP,
          ...(proof === undefined ? {} : { resumeEvidence: proof }),
          attribution: { ...attribution(), conversationKey: key },
        },
      ],
    },
  };
}
function snapshot(value, suffix = 'c') {
  return { path: '/tmp/synthetic.json', sha256: suffix.repeat(64), envelope: value };
}

test('旧 request_sent 批次没有系统文案证明，完整归属也不能统计已发送', () => {
  for (const version of [1, 2, 3, 4]) {
    const result = applyBossBatch(seed(), delivery({ version }), options).data;
    assert.equal(result.opportunities[0].resumeState, '未知', `queue v${version}`);
    assert.equal(result.sourceApplications.at(-1).status, 'waiting');
    assert.equal(result.sourceApplications.at(-1).reason, 'resume_semantics_missing');
  }
});

test('岗位卡片旧枚举只存档，保留 summary 和稳定身份且不联动', async () => {
  const input = delivery({ proof: CARD });
  const old = delivery({ version: 4 });
  assert.equal(input.events[0].eventId, old.events[0].eventId);
  assert.notEqual(input.batchId, delivery().batchId);
  assert.deepEqual(await verifyBossBatch(input), input);
  const result = applyBossBatch(seed(), input, options).data;
  const application = result.sourceApplications.at(-1);
  assert.deepEqual(
    [application.status, application.reason, application.opportunityId],
    ['no_effect', 'observation_only', ''],
  );
  assert.equal(result.sourceEvents.at(-1).summary, 'resume_request_sent');
  assert.equal(result.opportunities[0].resumeState, '未知');
});

test('精确系统文案仍代表已发送；旧 waiting 获得新证明后只应用一次', () => {
  const old = delivery({ version: 4 });
  const input = delivery();
  const waiting = applyBossBatch(seed(), old, options).data;
  const result = applyBossBatch(waiting, input, options).data;
  assert.equal(result.opportunities[0].resumeState, '已发送');
  assert.equal(result.sourceApplications.at(-1).status, 'applied');
  assert.equal(result.sourceEvents.length, waiting.sourceEvents.length);
  assert.equal(result.sourceFacts.length, waiting.sourceFacts.length);
  assert.deepEqual(applyBossBatch(result, old, options).data, result);
  assert.deepEqual(applyBossBatch(result, input, options).data, result);
});

test('有证明但缺独立归属不能借用另一候选的归属字段', () => {
  const proven = delivery({ evidence: null });
  const linked = delivery({ version: 4 });
  const result = applyBossBatch(seed(), linked, {
    ...options,
    attributionObservations: observations([proven, linked]),
  }).data;
  assert.equal(result.opportunities[0].resumeState, '未知');
  assert.equal(result.sourceApplications.at(-1).status, 'waiting');
  assert.equal(result.sourceApplications.at(-1).reason, 'attribution_evidence_missing');
});

test('卡片证明不掩盖明确归属冲突，人工决定、已应用与删除保护优先', () => {
  const conflict = delivery({ proof: CARD, evidence: attribution({ responseFriendId: 'wrong' }) });
  const reviewed = applyBossBatch(seed(), conflict, options).data;
  assert.equal(reviewed.sourceApplications.at(-1).status, 'review');
  assert.equal(reviewed.sourceApplications.at(-1).reason, 'attribution_contact_conflict');
  const reduced = delivery({ proof: CARD, evidence: null });
  const preserved = applyBossBatch(reviewed, reduced, options).data;
  assert.equal(preserved.sourceApplications.at(-1).status, 'review');
  assert.equal(preserved.sourceApplications.at(-1).reason, 'attribution_contact_conflict');
  const old = delivery({ version: 4 });
  const waiting = applyBossBatch(seed(), old, options).data;
  const ignored = ignoreBossObservations(waiting, {
    ...options,
    applicationIds: [waiting.sourceApplications.at(-1).id],
  });
  assert.deepEqual(applyBossBatch(ignored, delivery(), options).data, ignored);
  const manual = seed();
  manual.opportunities[0].resumeState = '被索要';
  markManualFields(manual, manual.opportunities[0].id, ['resumeState']);
  const protectedResult = applyBossBatch(manual, delivery(), options).data;
  assert.equal(protectedResult.opportunities[0].resumeState, '被索要');
  assert.equal(protectedResult.sourceApplications.at(-1).status, 'protected');
  assert.deepEqual(
    applyBossBatch(protectedResult, delivery({ proof: CARD }), options).data,
    protectedResult,
  );
  const applied = applyBossBatch(seed(), delivery(), options).data;
  applied.sourceApplications.at(-1).ruleVersion = 'boss-application-v11';
  assert.deepEqual(applyBossBatch(applied, delivery({ proof: CARD }), options).data, applied);
  const rejected = rejectMisattributedResumeObservation(applied, {
    opportunityId: applied.opportunities[0].id,
    eventId: delivery().events[0].eventId,
    stamp: STAMP,
  });
  assert.deepEqual(applyBossBatch(rejected, delivery(), options).data, rejected);
  const deleted = structuredClone(waiting);
  deleted.sourceEvents.at(-1).deletedAt = STAMP;
  assert.throws(() => applyBossBatch(deleted, delivery(), options), {
    code: 'RESTORE_REVIEW_REQUIRED',
  });
});

test('批次证明未知版本字段、摘要矛盾均拒绝，正文不进入证明', () => {
  for (const proof of [
    { ...SENT, version: 3 },
    { ...SENT, token: 'synthetic-secret' },
    { ...SENT, text: '私人正文' },
    { ...SENT, text: '对方已查看了您的附件简历' },
  ])
    assert.throws(() => validateBossBatch(delivery({ proof })));
  assert.doesNotThrow(() => validateBossBatch(delivery({ proof: null })));
  const tampered = delivery();
  tampered.events[0].resumeEvidence = CARD;
  assert.throws(() => validateBossBatch(tampered));
  const missing = delivery();
  delete missing.events[0].resumeEvidence;
  assert.throws(() => validateBossBatch(missing));
  const legacy = delivery({ version: 4 });
  legacy.events[0].resumeEvidence = SENT;
  assert.throws(() => validateBossBatch(legacy));
  assert.throws(() => validateBossBatch({ ...delivery(), version: 7 }));
});

test('同事实候选顺序不改变结果，旧缺证明不能否定完整新证明，完整矛盾保守等待', () => {
  const old = delivery({ version: 4 });
  const valid = delivery();
  const card = delivery({ proof: CARD });
  for (const pool of [
    [old, valid],
    [valid, old],
  ]) {
    const result = applyBossBatch(seed(), old, {
      ...options,
      attributionObservations: observations(pool),
    }).data;
    assert.equal(result.opportunities[0].resumeState, '已发送');
  }
  for (const pool of [
    [card, valid],
    [valid, card],
  ]) {
    const result = applyBossBatch(seed(), pool[0], {
      ...options,
      attributionObservations: observations(pool),
    }).data;
    assert.equal(result.opportunities[0].resumeState, '未知');
    assert.equal(result.sourceApplications.at(-1).reason, 'resume_semantics_missing');
  }
  const chatText = applyBossBatch(
    seed(),
    delivery({ proof: { ...SENT, messageType: 1 } }),
    options,
  ).data;
  assert.equal(chatText.sourceApplications.at(-1).reason, 'resume_semantics_missing');
});

test('所有有业务目标的简历观察均须有可重算的语义证明，旧标签不能直接推进', () => {
  for (const summary of [
    'resume_request_sent',
    'resume_sent_confirmed',
    'resume_attachment_sent',
    'resume_viewed_confirmed',
  ]) {
    for (const version of [3, 4, 5]) {
      const result = applyBossBatch(
        seed(),
        delivery({ version, summary, proof: null }),
        options,
      ).data;
      assert.equal(result.opportunities[0].resumeState, '未知', `${summary} v${version}`);
      assert.equal(result.sourceApplications.at(-1).status, 'waiting');
      assert.equal(result.sourceApplications.at(-1).reason, 'resume_semantics_missing');
    }
  }
});

test('其它合法 v1 系统证明仍可应用，语义与独立归属不能来自不同观察', () => {
  const meanings = [
    ['resume_sent_confirmed', '对方已同意，您的附件简历已发送给对方', '已发送'],
    ['resume_attachment_sent', '您的附件简历 [attachment] 已发送给Boss', '已发送'],
    ['resume_viewed_confirmed', '对方已查看了您的附件简历', '对方已接收'],
  ];
  for (const [summary, text, expected] of meanings) {
    const proof = { version: 1, messageType: 5, field: 'body.text', text };
    const complete = delivery({ summary, proof });
    const applied = applyBossBatch(seed(), complete, options).data;
    assert.equal(applied.opportunities[0].resumeState, expected);
    assert.equal(applied.sourceApplications.at(-1).status, 'applied');

    const semanticOnly = delivery({ summary, proof, evidence: null });
    const identityOnly = delivery({ summary, version: 4 });
    for (const pool of [
      [semanticOnly, identityOnly],
      [identityOnly, semanticOnly],
    ]) {
      const result = applyBossBatch(seed(), pool[0], {
        ...options,
        attributionObservations: observations(pool),
      }).data;
      assert.equal(result.opportunities[0].resumeState, '未知', summary);
      assert.equal(result.sourceApplications.at(-1).status, 'waiting');
      assert.equal(result.sourceApplications.at(-1).reason, 'attribution_evidence_missing');
    }
  }
});

test('精确链接发送与已查看证明独立应用，旧同消息卡片及其稳定身份保持存档', () => {
  const oldCard = delivery({
    summary: 'resume_card_other',
    proof: CARD,
    messageId: 'view-message',
    evidence: attribution({ messageId: 'view-message' }),
  });
  const archived = applyBossBatch(seed(), oldCard, options).data;
  const oldEvent = structuredClone(archived.sourceEvents.at(-1));
  const oldFact = structuredClone(archived.sourceFacts.at(-1));
  const oldApplication = structuredClone(archived.sourceApplications.at(-1));
  const sent = delivery({ version: 6, summary: 'resume_attachment_sent', proof: ATTACHMENT_SENT });
  const viewed = delivery({
    version: 6,
    summary: 'resume_viewed_confirmed',
    proof: VIEWED,
    messageId: 'view-message',
    evidence: attribution({ messageId: 'view-message' }),
    sequence: 3,
  });
  const afterSent = applyBossBatch(archived, sent, options).data;
  assert.equal(afterSent.opportunities[0].resumeState, '已发送');
  const received = applyBossBatch(afterSent, viewed, options).data;
  assert.equal(received.opportunities[0].resumeState, '对方已接收');
  assert.equal(received.opportunities[0].readState, '已读');
  assert.equal(received.opportunities[0].stage, '沟通中');
  assert.deepEqual(
    received.sourceEvents.find((row) => row.id === oldEvent.id),
    oldEvent,
  );
  assert.deepEqual(
    received.sourceFacts.find((row) => row.id === oldFact.id),
    oldFact,
  );
  assert.deepEqual(
    received.sourceApplications.find((row) => row.id === oldApplication.id),
    oldApplication,
  );
  assert.equal(received.sourceApplications.at(-1).status, 'applied');
  assert.deepEqual(applyBossBatch(received, sent, options).data, received);
  assert.deepEqual(applyBossBatch(received, viewed, options).data, received);
});

test('新查看证明须在同一观察有归属，联系人冲突优先；旧 type4 文案没有新可信地位', () => {
  const semanticOnly = delivery({
    version: 6,
    summary: 'resume_viewed_confirmed',
    proof: VIEWED,
    evidence: null,
  });
  const identityOnly = delivery({ summary: 'resume_viewed_confirmed', proof: null });
  for (const pool of [
    [semanticOnly, identityOnly],
    [identityOnly, semanticOnly],
  ]) {
    const result = applyBossBatch(seed(), pool[0], {
      ...options,
      attributionObservations: observations(pool),
    }).data;
    assert.equal(result.opportunities[0].resumeState, '未知');
    assert.equal(result.sourceApplications.at(-1).reason, 'attribution_evidence_missing');
  }
  const conflict = applyBossBatch(
    seed(),
    delivery({
      version: 6,
      summary: 'resume_viewed_confirmed',
      proof: VIEWED,
      evidence: attribution({ responseFriendId: 'wrong-friend' }),
    }),
    options,
  ).data;
  assert.equal(conflict.sourceApplications.at(-1).status, 'review');
  assert.equal(conflict.sourceApplications.at(-1).reason, 'attribution_contact_conflict');
  const oldType4 = applyBossBatch(
    seed(),
    delivery({
      summary: 'resume_viewed_confirmed',
      proof: { version: 1, messageType: 4, field: 'body.text', text: VIEWED.text },
    }),
    options,
  ).data;
  assert.equal(oldType4.opportunities[0].resumeState, '未知');
  assert.equal(oldType4.sourceApplications.at(-1).reason, 'resume_semantics_missing');
});

test('新明确语义不覆盖人工字段或恢复已忽略的旧事实，会话新消息独立处理', () => {
  const viewed = delivery({ version: 6, summary: 'resume_viewed_confirmed', proof: VIEWED });
  const manual = seed();
  manual.opportunities[0].resumeState = '已发送';
  markManualFields(manual, manual.opportunities[0].id, ['resumeState']);
  const protectedResult = applyBossBatch(manual, viewed, options).data;
  assert.equal(protectedResult.opportunities[0].resumeState, '已发送');
  assert.equal(protectedResult.sourceApplications.at(-1).status, 'protected');
  assert.equal(protectedResult.sourceApplications.at(-1).reason, 'manual_resume_state');

  const waiting = applyBossBatch(
    seed(),
    delivery({
      summary: 'resume_viewed_confirmed',
      proof: null,
    }),
    options,
  ).data;
  const ignored = ignoreBossObservations(waiting, {
    ...options,
    applicationIds: [waiting.sourceApplications.at(-1).id],
  });
  assert.deepEqual(applyBossBatch(ignored, viewed, options).data, ignored);
  const newMessage = delivery({
    version: 6,
    summary: 'resume_viewed_confirmed',
    proof: VIEWED,
    messageId: 'new-view-message',
    evidence: attribution({ messageId: 'new-view-message' }),
    sequence: 3,
  });
  const result = applyBossBatch(ignored, newMessage, options).data;
  assert.equal(result.opportunities[0].resumeState, '对方已接收');
  assert.equal(result.sourceApplications.at(-1).status, 'applied');
  assert.equal(
    result.sourceApplications.find((row) => row.id === ignored.sourceApplications.at(-1).id).reason,
    'user_ignored_unresolved_observation',
  );
});

test('转换旧 type4 request_sent 为普通卡片证明；旧 type5 不合成系统文案', () => {
  const oldCard = createResumeEvents(envelope({ messageType: 4 }), { sourceSequence: 2 })[0];
  const oldSystem = createResumeEvents(envelope(), { sourceSequence: 2 })[0];
  assert.deepEqual(oldCard.resumeEvidence, CARD);
  assert.equal(oldSystem.resumeEvidence, null);
  const verified = createResumeBatch(snapshot(envelope({ proof: SENT })), 2);
  assert.equal(verified.version, 6);
  assert.deepEqual(verified.events[0].resumeEvidence, SENT);
  assert.equal(verified.events[0].eventId, oldSystem.eventId);
  const incremental = createIncrementalBatch(
    snapshot(envelope()),
    snapshot(envelope({ proof: SENT }), 'd'),
    3,
  );
  assert.ok(incremental?.events.some((event) => event.resumeEvidence?.text === SENT.text));
});

test('真实服务旧队列重评与新证明恢复使用同一关卡并保持幂等', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boss-resume-semantics-'));
  const store = new WorkspaceStore(join(root, 'workspace'), { now: () => STAMP });
  const inbox = new BossInbox(join(root, 'inbox'));
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.execute({
    commandId: 'seed',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace: { ...initialWorkspace(), data: seed() }, reason: '合成测试' },
  });
  await inbox.enqueue(delivery({ version: 4 }));
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  await consumer.run();
  const waiting = await store.read();
  assert.equal(waiting.workspace.data.opportunities[0].resumeState, '未知');
  assert.equal(waiting.workspace.data.sourceApplications.at(-1).reason, 'resume_semantics_missing');
  await inbox.enqueue(delivery());
  await consumer.run();
  const sent = await store.read();
  assert.equal(sent.workspace.data.opportunities[0].resumeState, '已发送');
  await consumer.run();
  assert.equal((await store.read()).revision, sent.revision);
});
