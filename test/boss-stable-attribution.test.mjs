import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBossAttributionContext, assessBossAttribution } from '../dist/boss-attribution.js';
import { bossBatchDigestInput, bossEventDigestInput } from '../dist/boss-batch.js';
import {
  applyBossBatch,
  bindBossAccount,
  ignoreBossObservations,
} from '../dist/boss-integration.js';
import { emptyData } from '../dist/model.js';
import { bossWaitingItems, sourceReviewCounts } from '../dist/source-ledger.js';
import { initialWorkspace } from '../dist/workspace.js';
import { BossInbox } from '../scripts/boss-inbox.mjs';
import { WorkspaceStore, workspaceDigest } from '../scripts/workspace-store.mjs';
import { createWorkspaceInboxConsumer } from '../scripts/workspace-consumer.mjs';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const OTHER_ACCOUNT = `boss-geek:${'b'.repeat(64)}`;
const SOURCE_ID = '00000000-0000-4000-8000-000000000001';
const STAMP = '2026-10-06T01:00:00.000Z';
const JOB_ID = 'synthetic-job';
const JOB_URL = `https://www.zhipin.com/job_detail/${JOB_ID}.html`;

function evidence(overrides = {}) {
  return {
    version: 1,
    source: 'history',
    accountNamespace: ACCOUNT,
    conversationKey: '1'.repeat(64),
    messageId: 'message-1',
    requestedBossId: 'boss-1',
    responseFriendId: 'friend-1',
    responseFriendSource: 'source-1',
    responseBossId: 'boss-1',
    selfId: 'self-1',
    senderId: 'self-1',
    recipientId: 'boss-1',
    messageJobId: null,
    ...overrides,
  };
}
function delivery({
  attribution = null,
  sequence = 1,
  account = ACCOUNT,
  ordinary = false,
  ...overrides
} = {}) {
  const event = {
    eventId: '',
    ...(!ordinary ? { eventType: 'resume_observed', attribution } : {}),
    conversationKey: '1'.repeat(64),
    friendId: 'friend-1',
    friendSource: 'source-1',
    uniqueId: 'friend-1-source-1',
    externalJobId: JOB_ID,
    canonicalUrl: JOB_URL,
    jobName: '合成岗位',
    company: '合成公司',
    contact: '合成招聘者',
    summary: ordinary ? '合成普通消息' : 'resume_sent_confirmed',
    timeLabel: '',
    messageId: ordinary ? 'seed-message' : 'message-1',
    messageDirection: ordinary ? 'unknown' : 'outbound',
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
    version: ordinary ? 1 : 3,
    batchId: '',
    platform: 'boss',
    accountNamespace: account,
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
  event.eventId = `boss-event-${workspaceDigest(bossEventDigestInput(batch, event))}`;
  batch.batchId = `boss-batch-${workspaceDigest(bossBatchDigestInput(batch))}`;
  return batch;
}
const observations = (batches) =>
  batches.flatMap((batch) =>
    batch.events.map((event) => ({
      ...event,
      platform: 'boss',
      accountNamespace: batch.accountNamespace,
    })),
  );
const decision = (batches, index = 0) => {
  const all = observations(batches);
  return assessBossAttribution(
    batches[index].accountNamespace,
    batches[index].events[0],
    buildBossAttributionContext(all, { observations: all }),
  );
};
function seed() {
  return applyBossBatch(
    bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, STAMP),
    delivery({ ordinary: true }),
    { workspaceSourceId: SOURCE_ID, stamp: STAMP },
  ).data;
}
async function fixture(t, batches, { data = seed(), pending = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'boss-stable-attribution-'));
  const store = new WorkspaceStore(join(root, 'workspace'), { now: () => STAMP });
  const inbox = new BossInbox(join(root, 'inbox'));
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = { ...initialWorkspace(), data, pending };
  await store.execute({
    commandId: 'synthetic-import',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: '合成初始状态' },
  });
  for (const batch of batches) await inbox.enqueue(batch);
  let clock = 0;
  const consumer = createWorkspaceInboxConsumer({
    workspaceStore: store,
    inbox,
    now: () => new Date(Date.parse(STAMP) + clock++ * 1000).toISOString(),
  });
  return { root, store, inbox, consumer };
}

function legacyCardWaiting(input) {
  const data = applyBossBatch(seed(), input, { workspaceSourceId: SOURCE_ID, stamp: STAMP }).data;
  Object.assign(data.sourceApplications.at(-1), {
    status: 'waiting',
    reason: 'attribution_evidence_missing',
    ruleVersion: 'boss-application-v10',
    opportunityId: '',
    appliedAt: '',
  });
  return data;
}

test('旧队列已回执的纯卡片等待项通过真实服务重评存档，不重复事实或提交', async (t) => {
  const input = delivery({ summary: 'resume_card_other' });
  input.version = 1;
  input.policy.id = 'boss-resume-observation-v1';
  delete input.events[0].attribution;
  input.events[0].eventId = `boss-event-${workspaceDigest(bossEventDigestInput(input, input.events[0]))}`;
  input.batchId = `boss-batch-${workspaceDigest(bossBatchDigestInput(input))}`;
  const data = legacyCardWaiting(input);
  const { store, inbox, consumer } = await fixture(t, [input], { data });
  const before = await store.read();
  await inbox.acknowledge(input.batchId, {
    format: 'job-tracker-boss-receipt',
    version: 2,
    batchId: input.batchId,
    workspaceSourceId: before.workspaceId,
    status: 'processed',
    processedAt: STAMP,
    counts: { added: 0, linked: 0, observed: 0, reviewed: 1, skipped: 0 },
    errorCode: '',
  });
  const result = await consumer.run();
  assert.equal(result.isolated.length, 0);
  const archived = await store.read();
  const application = archived.workspace.data.sourceApplications.at(-1);
  assert.equal(application.status, 'no_effect');
  assert.equal(application.reason, 'observation_only');
  assert.equal(application.opportunityId, '');
  assert.equal(application.id, before.workspace.data.sourceApplications.at(-1).id);
  assert.equal(bossWaitingItems(archived.workspace.data).length, 0);
  assert.deepEqual(archived.workspace.data.sourceEvents, before.workspace.data.sourceEvents);
  assert.deepEqual(archived.workspace.data.sourceFacts, before.workspace.data.sourceFacts);
  assert.deepEqual(archived.workspace.data.opportunities, before.workspace.data.opportunities);
  await consumer.run();
  assert.equal((await store.read()).revision, archived.revision);
});

test('真实队列中同消息卡片仅存档，发送观察仍等待，后续采集不会重复累计', async (t) => {
  const card = delivery({ summary: 'resume_card_other' });
  const sent = delivery({ summary: 'resume_request_sent', sequence: 2 });
  const { store, inbox, consumer } = await fixture(t, [card, sent]);
  await consumer.run();
  const first = await store.read();
  const applications = first.workspace.data.sourceApplications.filter(
    (row) => row.action === 'resume_observed',
  );
  assert.deepEqual(
    applications.map((row) => [row.status, row.reason]),
    [
      ['no_effect', 'observation_only'],
      ['waiting', 'resume_semantics_missing'],
    ],
  );
  assert.equal(sourceReviewCounts(first.workspace.data).waiting, 1);
  assert.equal(first.workspace.data.opportunities[0].resumeState, '未知');
  await consumer.run();
  assert.equal((await store.read()).revision, first.revision);
  const nextCapture = delivery({ summary: 'resume_card_other', sequence: 3 });
  nextCapture.source.snapshotSha256 = 'd'.repeat(64);
  nextCapture.batchId = `boss-batch-${workspaceDigest(bossBatchDigestInput(nextCapture))}`;
  await inbox.enqueue(nextCapture);
  await consumer.run();
  const repeated = await store.read();
  assert.equal(repeated.workspace.data.sourceFacts.length, first.workspace.data.sourceFacts.length);
  assert.equal(
    repeated.workspace.data.sourceApplications.length,
    first.workspace.data.sourceApplications.length,
  );
  assert.equal(sourceReviewCounts(repeated.workspace.data).waiting, 1);
  assert.deepEqual(repeated.workspace.data.opportunities, first.workspace.data.opportunities);
});

test('纯卡片重评诊断写入失败不确认进度，修复后原材料可原子存档', async (t) => {
  const input = delivery({ summary: 'resume_card_other' });
  const { root, store, inbox, consumer } = await fixture(t, [input], {
    data: legacyCardWaiting(input),
  });
  const before = await store.read();
  const diagnostics = join(root, 'inbox', 'attribution-diagnostics');
  await rm(diagnostics, { recursive: true, force: true });
  await writeFile(diagnostics, 'synthetic blocked diagnostics', { mode: 0o600 });
  const failed = await consumer.run();
  assert.equal(failed.isolated.length, 1);
  assert.equal((await store.read()).revision, before.revision);
  assert.equal(await inbox.readReceipt(input.batchId, before.workspaceId), null);
  assert.equal((await store.read()).workspace.data.sourceApplications.at(-1).status, 'waiting');
  await rm(diagnostics);
  const repaired = await consumer.run();
  assert.equal(repaired.isolated.length, 0);
  const archived = await store.read();
  assert.equal(archived.workspace.data.sourceApplications.at(-1).status, 'no_effect');
  assert.equal(archived.workspace.data.sourceApplications.at(-1).reason, 'observation_only');
  assert.equal((await inbox.readReceipt(input.batchId, before.workspaceId)).status, 'processed');
});

test('same fact uses a stable insufficient reason independently of observation order', () => {
  const none = delivery();
  const partial = delivery({
    attribution: evidence({ requestedBossId: null, responseBossId: null }),
    sequence: 2,
  });
  assert.equal(none.events[0].eventId, partial.events[0].eventId);
  assert.notEqual(none.batchId, partial.batchId);
  assert.equal(decision([none, partial]).reason, 'attribution_conversation_missing');
  assert.deepEqual(decision([none, partial]), decision([partial, none]));
  assert.equal(decision([none, partial], 1).reason, 'attribution_conversation_missing');
});

test('consecutive actual queue drains converge without creating commits from old partial batches', async (t) => {
  const { store, consumer } = await fixture(t, [
    delivery(),
    delivery({
      attribution: evidence({ requestedBossId: null, responseBossId: null }),
      sequence: 2,
    }),
  ]);
  await consumer.run();
  const first = await store.read();
  assert.equal(
    first.workspace.data.sourceApplications.at(-1).reason,
    'attribution_conversation_missing',
  );
  await consumer.run();
  const second = await store.read();
  await consumer.run();
  assert.equal(second.revision, first.revision);
  assert.equal((await store.read()).revision, first.revision);
  assert.deepEqual(second.workspace.data, first.workspace.data);
});

test('swapping queued sequence produces the same decision and consume diagnostic reason', async (t) => {
  for (const reverse of [false, true]) {
    const batches = [
      delivery({ sequence: reverse ? 2 : 1 }),
      delivery({ attribution: evidence({ responseBossId: null }), sequence: reverse ? 1 : 2 }),
    ];
    const { root, store, consumer } = await fixture(t, batches);
    await consumer.run();
    const after = await store.read();
    assert.equal(
      after.workspace.data.sourceApplications.at(-1).reason,
      'attribution_conversation_missing',
    );
    const files = await readdir(join(root, 'inbox', 'attribution-diagnostics'));
    const consume = await Promise.all(
      files.map(async (file) =>
        JSON.parse(await readFile(join(root, 'inbox', 'attribution-diagnostics', file), 'utf8')),
      ),
    );
    assert.ok(
      consume
        .filter((row) => row.stage === 'consume')
        .every((row) => row.reason === 'attribution_conversation_missing'),
    );
  }
});

test('new complete independent evidence can advance a waiting fact without repeated application', async (t) => {
  const { store, inbox, consumer } = await fixture(t, [delivery()]);
  await consumer.run();
  assert.equal((await store.read()).workspace.data.opportunities[0].resumeState, '未知');
  await inbox.enqueue(delivery({ attribution: evidence(), sequence: 2 }));
  await consumer.run();
  const result = await store.read();
  assert.equal(result.workspace.data.opportunities[0].resumeState, '已发送');
  assert.equal(result.workspace.data.sourceApplications.at(-1).status, 'applied');
  await consumer.run();
  assert.equal((await store.read()).revision, result.revision);
});

test('a verified independent sample stabilizes target-dependency reasons when the older event has no job ID', async (t) => {
  const none = delivery({
    externalJobId: '',
    canonicalUrl: '',
    jobName: '',
    company: '',
    nameSource: '',
  });
  const full = delivery({ attribution: evidence(), sequence: 2 });
  const data = bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, STAMP);
  const { store, consumer } = await fixture(t, [none, full], { data });
  await consumer.run();
  const first = await store.read();
  assert.equal(first.workspace.data.sourceApplications[0].reason, 'job_not_linked');
  await consumer.run();
  assert.equal((await store.read()).revision, first.revision);
});

test('same-fact complete proof can resolve an older job-less event without rewriting its material', async (t) => {
  const none = delivery({
    externalJobId: '',
    canonicalUrl: '',
    jobName: '',
    company: '',
    nameSource: '',
  });
  const full = delivery({ attribution: evidence(), sequence: 2 });
  const { store, consumer } = await fixture(t, [none, full]);
  await consumer.run();
  const after = await store.read();
  assert.equal(after.workspace.data.opportunities[0].resumeState, '已发送');
  assert.equal(after.workspace.data.sourceApplications.at(-1).status, 'applied');
  assert.equal(
    after.workspace.data.sourceEvents.find((row) => row.id === none.events[0].eventId)
      .externalJobId,
    '',
  );
  assert.equal(
    after.workspace.data.sourceEvents.find((row) => row.id === none.events[0].eventId).status,
    'review',
  );
  await consumer.run();
  assert.equal((await store.read()).revision, after.revision);
});

test('a complete candidate cannot override a contradictory raw contact or a blocked winner target', () => {
  const valid = delivery({ attribution: evidence() });
  const wrongRawContact = delivery({ friendId: 'wrong-friend', uniqueId: 'wrong-friend-source-1' });
  assert.equal(decision([wrongRawContact, valid]).reason, 'attribution_contact_conflict');
  const sharedOnly = observations([wrongRawContact])[0];
  delete sharedOnly.attribution;
  assert.equal(
    assessBossAttribution(
      ACCOUNT,
      valid.events[0],
      buildBossAttributionContext([sharedOnly], { observations: observations([valid]) }),
    ).reason,
    'attribution_contact_conflict',
  );
  const none = delivery({
    externalJobId: '',
    canonicalUrl: '',
    jobName: '',
    company: '',
    nameSource: '',
  });
  const data = seed();
  const result = applyBossBatch(data, none, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
    attributionObservations: observations([none, valid]),
    attributionContextEvents: observations([none, valid]),
    blockedOpportunityIds: [data.opportunities[0].id],
  }).data;
  assert.equal(result.sourceApplications.at(-1).reason, 'entity_sync_conflict');
  assert.equal(result.sourceApplications.at(-1).status, 'waiting');
  assert.equal(result.opportunities[0].resumeState, '未知');
  assert.deepEqual(result.opportunities, data.opportunities);
});

test('queued conflicting proof cannot briefly apply a valid sample before the conflict batch is consumed', async (t) => {
  const valid = delivery({ attribution: evidence() });
  const conflict = delivery({
    attribution: evidence({ responseFriendId: 'wrong-friend' }),
    sequence: 2,
  });
  const { store, consumer } = await fixture(t, [valid, conflict]);
  await consumer.run();
  const first = await store.read();
  assert.equal(first.workspace.data.opportunities[0].resumeState, '未知');
  assert.equal(first.workspace.data.sourceApplications.at(-1).status, 'review');
  assert.equal(
    first.workspace.data.sourceApplications.at(-1).reason,
    'attribution_contact_conflict',
  );
  await consumer.run();
  assert.equal((await store.read()).revision, first.revision);
});

test('isolated invalid queue material cannot supply the complete sample used for application', async (t) => {
  const none = delivery();
  const full = delivery({ attribution: evidence(), sequence: 2 });
  const { store, inbox, consumer } = await fixture(t, [none, full]);
  await writeFile(
    join(inbox.inbox, `${full.batchId}.json`),
    JSON.stringify({ ...full, unknownField: true }),
    { mode: 0o600 },
  );
  const summary = await consumer.run();
  assert.equal(summary.isolated.length, 1);
  assert.equal((await store.read()).workspace.data.opportunities[0].resumeState, '未知');
  assert.equal(
    (await store.read()).workspace.data.sourceApplications.at(-1).reason,
    'attribution_evidence_missing',
  );
});

test('deleted independent material cannot be used to revive another waiting observation', async (t) => {
  const none = delivery();
  const full = delivery({ attribution: evidence(), contact: '另一次合成招聘者显示', sequence: 2 });
  const waiting = applyBossBatch(seed(), none, { workspaceSourceId: SOURCE_ID, stamp: STAMP }).data;
  const extra = applyBossBatch(
    waiting,
    delivery({ attribution: null, contact: full.events[0].contact, sequence: 2 }),
    { workspaceSourceId: SOURCE_ID, stamp: STAMP },
  ).data;
  extra.sourceEvents.find((row) => row.id === full.events[0].eventId).deletedAt = STAMP;
  const { store, consumer } = await fixture(t, [none, full], { data: extra });
  const result = await consumer.run();
  assert.equal(result.isolated.length, 1);
  assert.equal((await store.read()).workspace.data.opportunities[0].resumeState, '未知');
  assert.equal(
    (await store.read()).workspace.data.sourceApplications.at(-1).reason,
    'attribution_evidence_missing',
  );
});

test('incomplete evidence is never combined into a complete identity chain', () => {
  const contactOnly = delivery({
    attribution: evidence({ selfId: null, senderId: null, recipientId: null }),
  });
  const participantsOnly = delivery({
    attribution: evidence({
      requestedBossId: null,
      responseFriendId: null,
      responseFriendSource: null,
      responseBossId: null,
    }),
    sequence: 2,
  });
  assert.equal(decision([contactOnly, participantsOnly]).status, 'insufficient');
  assert.equal(
    decision([contactOnly, participantsOnly]).reason,
    'attribution_participants_missing',
  );
});

test('consistent complete own-job proof is preferred without combining independent samples', () => {
  const conversation = delivery({ attribution: evidence() });
  const direct = delivery({ attribution: evidence({ messageJobId: JOB_ID }), sequence: 2 });
  assert.equal(decision([conversation, direct]).reason, 'attribution_verified');
  assert.deepEqual(decision([conversation, direct]), decision([direct, conversation]));
});

test('current deletion between batch commits prevents borrowing a stale complete proof', async (t) => {
  const full = delivery({ attribution: evidence(), contact: '合成显示C', sequence: 3 });
  const none = delivery({ contact: '合成显示A' });
  const partial = delivery({
    attribution: evidence({ requestedBossId: null, responseBossId: null }),
    contact: '合成显示B',
    sequence: 2,
  });
  const data = applyBossBatch(bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, STAMP), full, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  }).data;
  assert.equal(data.sourceApplications[0].reason, 'job_not_linked');
  const { store, inbox, consumer } = await fixture(t, [none, partial, full], { data });
  const originalRead = store.read.bind(store);
  let changed = false;
  store.read = async () => {
    let current = await originalRead();
    if (!changed && (await inbox.readReceipt(none.batchId, current.workspaceId))) {
      changed = true;
      const workspace = structuredClone(current.workspace);
      workspace.data = applyBossBatch(workspace.data, delivery({ ordinary: true }), {
        workspaceSourceId: current.workspaceId,
        stamp: STAMP,
      }).data;
      workspace.data.sourceEvents.find((row) => row.id === full.events[0].eventId).deletedAt =
        STAMP;
      workspace.generation++;
      await store.execute({
        commandId: 'synthetic-mid-drain-deletion',
        expectedRevision: current.revision,
        type: 'commit_workspace',
        payload: { workspace, reason: '合成本机核对与删除' },
      });
      current = await originalRead();
    }
    return current;
  };
  await consumer.run();
  assert.equal(changed, true);
  const result = await originalRead();
  assert.equal(result.workspace.data.opportunities[0].resumeState, '未知');
  const application = result.workspace.data.sourceApplications.find(
    (row) => row.action === 'resume_observed',
  );
  assert.equal(application.status, 'waiting');
  assert.equal(application.reason, 'attribution_conversation_missing');
  assert.equal(
    result.workspace.data.sourceEvents.find((row) => row.id === full.events[0].eventId).deletedAt,
    STAMP,
  );
});

test('explicit identity conflict dominates a complete valid sample regardless of order', () => {
  const valid = delivery({ attribution: evidence() });
  const conflict = delivery({
    attribution: evidence({ responseFriendId: 'wrong-friend' }),
    sequence: 2,
  });
  assert.equal(decision([valid, conflict]).status, 'conflict');
  assert.equal(decision([valid, conflict]).reason, 'attribution_contact_conflict');
  assert.deepEqual(decision([valid, conflict]), decision([conflict, valid]));
});

test('individually valid samples with contradictory contact or participant identities remain conflicts', () => {
  const valid = delivery({ attribution: evidence() });
  for (const changed of [
    {
      attribution: evidence({
        requestedBossId: 'boss-2',
        responseBossId: 'boss-2',
        recipientId: 'boss-2',
      }),
    },
    { attribution: evidence({ selfId: 'self-2', senderId: 'self-2' }) },
    {
      attribution: evidence({ senderId: 'boss-1', recipientId: 'self-1' }),
      messageDirection: 'inbound',
    },
    {
      attribution: evidence({ responseFriendId: 'friend-2' }),
      friendId: 'friend-2',
      uniqueId: 'friend-2-source-1',
    },
  ]) {
    const other = delivery({ ...changed, sequence: 2 });
    assert.equal(assessBossAttribution(ACCOUNT, other.events[0]).status, 'verified');
    assert.equal(decision([valid, other]).status, 'conflict');
    assert.deepEqual(decision([valid, other]), decision([other, valid]));
  }
});

test('account and fact type isolate evidence even when conversation and stable message match', () => {
  const none = delivery();
  const other = delivery({
    attribution: evidence({ accountNamespace: OTHER_ACCOUNT }),
    account: OTHER_ACCOUNT,
  });
  const differentType = delivery({ attribution: evidence(), summary: 'resume_viewed_confirmed' });
  assert.equal(decision([none, other, differentType]).reason, 'attribution_evidence_missing');
});

test('a verified candidate cannot resolve a target with a conflicting explicit job ID', () => {
  const data = seed();
  data.opportunities[0].externalId = 'conflicting-job';
  const valid = delivery({ attribution: evidence() });
  const result = applyBossBatch(data, valid, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
    attributionObservations: observations([valid]),
  }).data;
  assert.equal(result.sourceApplications.at(-1).status, 'review');
  assert.equal(result.sourceApplications.at(-1).reason, 'job_identity_conflict');
  assert.deepEqual(result.opportunities, data.opportunities);
});

test('a verified BOSS sample cannot update a target explicitly changed to another platform', () => {
  const data = seed();
  data.opportunities[0].platform = '其他平台';
  const valid = delivery({ attribution: evidence() });
  const result = applyBossBatch(data, valid, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
    attributionObservations: observations([valid]),
  }).data;
  assert.equal(result.sourceApplications.at(-1).status, 'review');
  assert.equal(result.sourceApplications.at(-1).reason, 'job_identity_conflict');
  assert.deepEqual(result.opportunities, data.opportunities);
});

test('resume ownership uses the exact verified account binding even when a foreign binding comes first', () => {
  const data = bindBossAccount(seed(), OTHER_ACCOUNT, SOURCE_ID, STAMP);
  const own = data.sourceBindings.find(
    (row) => row.kind === 'opportunity' && row.accountNamespace === ACCOUNT,
  );
  const foreign = {
    ...own,
    id: `boss-job-${OTHER_ACCOUNT.slice('boss-geek:'.length)}-${encodeURIComponent(JOB_ID)}`,
    accountNamespace: OTHER_ACCOUNT,
    autoFields: '',
  };
  data.sourceBindings.unshift(foreign);
  const valid = delivery({ attribution: evidence() });
  const result = applyBossBatch(data, valid, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
    attributionObservations: observations([valid]),
  }).data;
  assert.equal(result.opportunities[0].resumeState, '已发送');
  assert.equal(result.sourceApplications.at(-1).status, 'applied');
  assert.deepEqual(
    result.sourceBindings.find((row) => row.id === foreign.id),
    foreign,
  );
  assert.equal(
    result.sourceBindings.find((row) => row.id === own.id).lastAutoResumeState,
    '已发送',
  );
});

test('restored missing facts cannot borrow stronger material from an unapproved gap batch', async (t) => {
  const none = delivery();
  const full = delivery({ attribution: evidence(), sequence: 2 });
  const { store, inbox, consumer } = await fixture(t, [none]);
  await consumer.run();
  await inbox.enqueue(full);
  const current = await store.read();
  const workspace = structuredClone(current.workspace);
  workspace.data.sourceEvents = workspace.data.sourceEvents.filter(
    (row) => row.eventType !== 'resume_observed',
  );
  workspace.data.sourceFacts = workspace.data.sourceFacts.filter(
    (row) => row.factType !== 'resume_sent_confirmed',
  );
  workspace.data.sourceApplications = workspace.data.sourceApplications.filter(
    (row) => row.action !== 'resume_observed',
  );
  workspace.generation++;
  await store.execute({
    commandId: 'synthetic-old-backup',
    expectedRevision: current.revision,
    type: 'commit_workspace',
    payload: { workspace, reason: '合成恢复缺口' },
  });
  const restored = await store.read();
  const summary = await consumer.run();
  assert.equal(summary.restoreReview.length, 1);
  assert.equal((await store.read()).revision, restored.revision);
  assert.equal(await inbox.readReceipt(full.batchId, store.workspaceId), null);
  await consumer.replay(none.batchId, restored.revision);
  const after = await store.read();
  assert.equal(after.workspace.data.opportunities[0].resumeState, '未知');
  assert.equal(
    after.workspace.data.sourceApplications.at(-1).reason,
    'attribution_evidence_missing',
  );
});

test('manually ignored facts are not reactivated by richer independent material', async (t) => {
  const none = delivery();
  const waiting = applyBossBatch(seed(), none, { workspaceSourceId: SOURCE_ID, stamp: STAMP }).data;
  const applicationId = waiting.sourceApplications.at(-1).id;
  const data = ignoreBossObservations(waiting, {
    applicationIds: [applicationId],
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const { store, consumer } = await fixture(
    t,
    [none, delivery({ attribution: evidence(), sequence: 2 })],
    { data },
  );
  await consumer.run();
  assert.equal((await store.read()).workspace.data.opportunities[0].resumeState, '未知');
  assert.equal(
    (await store.read()).workspace.data.sourceApplications.at(-1).reason,
    'user_ignored_unresolved_observation',
  );
});

test('consume diagnostic failure excludes progress and does not create partial commits', async (t) => {
  const { root, store, consumer, inbox } = await fixture(t, [
    delivery(),
    delivery({ attribution: evidence({ responseBossId: null }), sequence: 2 }),
  ]);
  const diagnostics = join(root, 'inbox', 'attribution-diagnostics');
  await rm(diagnostics, { recursive: true, force: true });
  await writeFile(diagnostics, 'synthetic invalid directory', { mode: 0o600 });
  const before = await store.read();
  const summary = await consumer.run();
  assert.ok(summary.isolated.length);
  assert.equal((await store.read()).revision, before.revision);
  assert.equal(
    (await inbox.list({ workspaceSourceId: store.workspaceId })).filter((row) => row.receipt)
      .length,
    0,
  );
});

test('pending rebase failure is caught before any pooled evidence can alter formal data', async (t) => {
  const none = delivery();
  const full = delivery({ attribution: evidence(), sequence: 2 });
  const data = applyBossBatch(seed(), none, { workspaceSourceId: SOURCE_ID, stamp: STAMP }).data;
  const manual = {
    id: 'independent-manual',
    company: '合成人工公司',
    role: '合成人工岗位',
    stage: '已触达',
  };
  data.opportunities.push(manual);
  const candidate = structuredClone(data);
  candidate.sourceApplications.at(-1).reason = 'missing_job_details';
  const remote = structuredClone(candidate);
  remote.opportunities.at(-1).notes = '合成远端分歧';
  const pending = {
    data: candidate,
    remote,
    generation: 0,
    conflicts: [
      {
        key: `opportunities:${manual.id}`,
        group: 'opportunities',
        id: manual.id,
        base: manual,
        local: manual,
        remote: remote.opportunities.at(-1),
      },
    ],
  };
  const { store, inbox, consumer } = await fixture(t, [none, full], { data, pending });
  const before = await store.read();
  const result = await consumer.run();
  assert.ok(result.isolated.some((row) => row.code === 'WORKSPACE_PENDING_REBASE_CONFLICT'));
  const after = await store.read();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.workspace, before.workspace);
  assert.equal(
    (await inbox.list({ workspaceSourceId: store.workspaceId })).filter((row) => row.receipt)
      .length,
    0,
  );
});

test('completed private batches skip preflight but restored gaps still prevent receipt-based skipping', async (t) => {
  const input = delivery();
  const waiting = applyBossBatch(seed(), input, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  }).data;
  const data = ignoreBossObservations(waiting, {
    applicationIds: [waiting.sourceApplications.at(-1).id],
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  const { root, store, consumer } = await fixture(t, [input], { data });
  await consumer.run();
  const first = await store.read();
  const diagnostics = join(root, 'inbox', 'attribution-diagnostics');
  await rm(diagnostics, { recursive: true, force: true });
  await writeFile(diagnostics, 'synthetic unavailable diagnostics', { mode: 0o600 });
  const skipped = await consumer.run();
  assert.equal(skipped.isolated.length, 0);
  assert.equal((await store.read()).revision, first.revision);
  const workspace = structuredClone(first.workspace);
  workspace.data.sourceEvents = workspace.data.sourceEvents.filter(
    (row) => row.eventType !== 'resume_observed',
  );
  workspace.data.sourceFacts = workspace.data.sourceFacts.filter(
    (row) => row.factType !== 'resume_sent_confirmed',
  );
  workspace.data.sourceApplications = workspace.data.sourceApplications.filter(
    (row) => row.action !== 'resume_observed',
  );
  workspace.generation++;
  await store.execute({
    commandId: 'completed-fact-restore-gap',
    expectedRevision: first.revision,
    type: 'commit_workspace',
    payload: { workspace, reason: '合成旧备份缺口' },
  });
  const restored = await store.read();
  assert.equal((await consumer.run()).restoreReview.length, 1);
  assert.equal((await store.read()).revision, restored.revision);
});
