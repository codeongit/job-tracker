import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyDetailEvidenceV2,
  compareLoadedSnapshotsV2,
  conversationKeyV2,
} from '../collector/boss/materials/model-v2.mjs';
import {
  applyResumeHistoryV2,
  toResumeHistoryResult,
} from '../collector/boss/history/resume-history.mjs';
import {
  createIncrementalBatch,
  createResumeBatch,
  createResumeEvents,
  stableHash,
} from '../scripts/boss/delivery/conversion.mjs';
import {
  bossBatchDigestInput,
  validateBossBatch as validateSharedBatch,
} from '../dist/boss/rules/batch.js';
import { BossInbox, validateBossBatch } from '../scripts/boss/delivery/inbox.mjs';
import { deliverSaved, emptyControl, recoverSaved } from '../scripts/boss/delivery/saved.mjs';
import { readTrackerSnapshot } from '../scripts/boss/delivery/snapshots.mjs';
import { applyBossBatch, bindBossAccount } from '../dist/boss/application/integration.js';
import { emptyData } from '../dist/model.js';
import { initialWorkspace } from '../dist/workspace.js';
import { sourceReviewCounts } from '../dist/source-ledger.js';
import { WorkspaceStore } from '../scripts/workspace-store.mjs';
import { createWorkspaceInboxConsumer } from '../scripts/workspace-consumer.mjs';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const FIRST = '2026-10-18T08:00:00.000Z';
const STAMP = '2026-10-19T08:00:00.000Z';
const KEY = conversationKeyV2(ACCOUNT, 'friend-1', '0');
const SOURCE_ID = '00000000-0000-4000-8000-000000000001';
const url = (jobId) => `https://www.zhipin.com/job_detail/${jobId}.html`;

function snapshot(jobId, capturedAt) {
  return {
    capturedAt,
    scope: 'loaded-chat-list',
    accountNamespace: ACCOUNT,
    records: [
      {
        key: KEY,
        platformIdentity: { friendId: 'friend-1', friendSource: '0', uniqueId: 'friend-1-0' },
        contact: '合成招聘者',
        company: '合成公司',
        title: '',
        preview: '合成普通消息',
        timeLabel: '',
        unread: null,
        latestMessageId: 'ordinary-1',
        outgoingReceipt: { status: 'unknown', label: null, source: null },
        jobAssociation: { jobId, detailUrl: url(jobId) },
        observedJobName: null,
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
}

function observation(overrides = {}) {
  return {
    conversationKey: KEY,
    friendId: 'friend-1',
    friendSource: '0',
    messageId: 'card-1',
    direction: 'inbound',
    messageType: 4,
    kind: 'resume_card_other',
    platformTime: FIRST,
    externalJobId: null,
    source: 'geek_history_type_4',
    ...overrides,
  };
}

function fixture(observations = [observation()]) {
  const old = compareLoadedSnapshotsV2(null, snapshot('job_A', FIRST)).envelope;
  const changed = compareLoadedSnapshotsV2(old, snapshot('job_B', STAMP)).envelope;
  const before = applyDetailEvidenceV2(
    changed,
    {
      observations: [
        {
          conversationKey: KEY,
          jobId: 'job_B',
          detailUrl: url('job_B'),
          name: '合成岗位 B',
          company: '合成用人公司',
          title: '「合成岗位 B招聘」_合成用人公司招聘-BOSS直聘',
          source: 'detail_page_title',
          observedAt: STAMP,
        },
      ],
      candidates: [],
    },
    STAMP,
  ).envelope;
  const result = toResumeHistoryResult(
    {
      ok: true,
      url: 'https://www.zhipin.com/web/geek/chat',
      capturedAt: STAMP,
      observations,
      unresolved: [],
      coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 1 },
    },
    before,
  );
  return { before, current: applyResumeHistoryV2(before, result).envelope };
}

const reference = (envelope, digit) => ({
  path: `synthetic-${digit}.json`,
  sha256: digit.repeat(64),
  envelope,
});

test('a card without job identity does not inherit the current details of a two-job conversation', () => {
  const { before, current } = fixture();
  const raw = createResumeEvents(current, { sourceSequence: 2 });
  assert.equal(current.jobs.associations.length, 2);
  assert.equal(raw[0].externalJobId, '');
  const resume = createResumeBatch(reference(current, 'b'), 2);
  assert.equal(resume.events[0].jobDetails, null);
  const incremental = createIncrementalBatch(reference(before, 'a'), reference(current, 'b'), 2);
  assert.deepEqual(incremental.events, resume.events);
});

function attribution(messageId, messageJobId = null, overrides = {}) {
  return {
    version: 1,
    source: 'history',
    accountNamespace: ACCOUNT,
    conversationKey: KEY,
    messageId,
    requestedBossId: 'friend-1',
    responseFriendId: 'friend-1',
    responseFriendSource: '0',
    responseBossId: 'friend-1',
    selfId: 'self-1',
    senderId: 'friend-1',
    recipientId: 'self-1',
    messageJobId,
    ...overrides,
  };
}

test('historical A keeps its event identity and evidence while only current B receives B details', () => {
  const observations = ['job_A', 'job_B'].map((externalJobId, index) =>
    observation({
      messageId: `card-${index + 1}`,
      externalJobId,
      attribution: attribution(`card-${index + 1}`, externalJobId),
      resumeEvidence: { version: 1, messageType: 4, field: 'none', text: '' },
    }),
  );
  const { before, current } = fixture(observations);
  const raw = createResumeEvents(current, { sourceSequence: 2 });
  const batch = createResumeBatch(reference(current, 'b'), 2);
  assert.deepEqual(
    batch.events.map(({ jobDetails, ...event }) => event),
    raw,
  );
  assert.equal(batch.events[0].externalJobId, 'job_A');
  assert.equal(batch.events[0].canonicalUrl, url('job_A'));
  assert.equal(batch.events[0].jobDetails, null);
  assert.deepEqual(batch.events[1].jobDetails, {
    jobId: 'job_B',
    canonicalUrl: url('job_B'),
    jobName: '合成岗位 B',
    company: '合成用人公司',
    source: 'detail_page_title',
  });
  assert.deepEqual(
    createIncrementalBatch(reference(before, 'a'), reference(current, 'b'), 2).events,
    batch.events,
  );
  validateBossBatch(batch);
  validateSharedBatch(batch);
});

test('same-job contradictory details remain attached and require review', () => {
  const { before } = fixture();
  const conflicting = structuredClone(before);
  const original = conflicting.jobs.evidence.find((item) => item.source === 'detail_page_title');
  conflicting.jobs.evidence.push({
    ...original,
    name: '矛盾岗位 B',
    title: '「矛盾岗位 B招聘」_合成用人公司招聘-BOSS直聘',
  });
  const batch = createIncrementalBatch(reference(before, 'a'), reference(conflicting, 'b'), 2);
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].jobDetails.source, 'detail_page_conflict');
  const applied = applyBossBatch(bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, STAMP), batch, {
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  }).data;
  assert.equal(applied.opportunities.length, 0);
  assert.equal(applied.sourceApplications[0].status, 'review');
});

test('the shared and disk validators still reject directly supplied mismatched detail identity', () => {
  const { current } = fixture([observation({ externalJobId: 'job_B' })]);
  const valid = createResumeBatch(reference(current, 'b'), 2);
  for (const change of [
    (details) => {
      details.jobId = 'job_A';
    },
    (details) => {
      details.canonicalUrl = url('job_A');
    },
    (details) => {
      details.jobId = 'job_A';
      details.canonicalUrl = url('job_A');
    },
  ]) {
    const invalid = structuredClone(valid);
    change(invalid.events[0].jobDetails);
    invalid.batchId = `boss-batch-${stableHash(bossBatchDigestInput(invalid))}`;
    assert.throws(() => validateSharedBatch(invalid), /岗位详情/);
    assert.throws(() => validateBossBatch(invalid), /岗位详情/);
  }
});

function seed(sourceId) {
  const data = bindBossAccount(emptyData(), ACCOUNT, sourceId, STAMP);
  for (const [index, externalId] of ['job_A', 'job_B'].entries()) {
    data.opportunities.push({
      id: `manual-${index}`,
      platform: 'BOSS',
      externalId,
      url: url(externalId),
      company: '人工保留公司',
      role: `人工保留岗位 ${index}`,
      resumeState: index ? '已发送' : '未知',
      readState: '未读',
      stage: index ? '面试中' : '已触达',
      notes: '人工保留备注',
      createdAt: FIRST,
      updatedAt: FIRST,
    });
  }
  return data;
}

async function durableFixture(t, batches = []) {
  const root = await mkdtemp(join(tmpdir(), 'boss-detail-attachment-'));
  const store = new WorkspaceStore(join(root, 'workspace'), { now: () => STAMP });
  const inbox = new BossInbox(join(root, 'inbox'));
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const identity = await store.read();
  const workspace = initialWorkspace();
  workspace.data = seed(identity.workspaceId);
  await store.execute({
    commandId: 'synthetic-initial-workspace',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: '合成岗位初始资料' },
  });
  for (const batch of batches) await inbox.enqueue(batch);
  const before = await store.read();
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  return { root, store, inbox, before, consumer };
}

test('the jobless card passes the durable queue and sole writer as an archived observation', async (t) => {
  const { current } = fixture();
  const batch = createResumeBatch(reference(current, 'b'), 2);
  const { store, inbox, before, consumer } = await durableFixture(t, [batch]);
  const consumed = await consumer.run();
  assert.equal(consumed.processed, 1);
  assert.deepEqual(consumed.isolated, []);
  const after = await store.read();
  assert.deepEqual(after.workspace.data.opportunities, before.workspace.data.opportunities);
  assert.equal(after.workspace.data.sourceFacts.length, 1);
  assert.equal(after.workspace.data.sourceEvents[0].id, batch.events[0].eventId);
  assert.equal(after.workspace.data.sourceEvents[0].opportunityId, '');
  assert.deepEqual(
    after.workspace.data.sourceApplications.map(({ status, reason, opportunityId }) => [
      status,
      reason,
      opportunityId,
    ]),
    [['no_effect', 'observation_only', '']],
  );
  assert.equal(sourceReviewCounts(after.workspace.data).waiting, 0);
  assert.equal((await inbox.readReceipt(batch.batchId, after.workspaceId)).status, 'processed');
  await inbox.enqueue(batch);
  assert.equal((await consumer.run()).processed, 0);
  assert.deepEqual(await store.read(), after);
});

test('a jobless card with an explicit contact conflict remains in review after detail filtering', () => {
  const { current } = fixture([
    observation({ attribution: attribution('card-1', null, { responseFriendId: 'wrong-friend' }) }),
  ]);
  const batch = createResumeBatch(reference(current, 'b'), 2);
  assert.equal(batch.events[0].jobDetails, null);
  const initial = seed(SOURCE_ID);
  const after = applyBossBatch(initial, batch, { workspaceSourceId: SOURCE_ID, stamp: STAMP }).data;
  assert.deepEqual(after.opportunities, initial.opportunities);
  assert.equal(after.sourceApplications[0].status, 'review');
  assert.equal(after.sourceApplications[0].reason, 'attribution_contact_conflict');
});

test('saved recovery preserves enqueue-before-checkpoint ordering and replays three blocked snapshots once', async (t) => {
  const { root, store, inbox, before, consumer } = await durableFixture(t);
  const config = { dataRoot: join(root, 'collector'), account: 'synthetic' };
  const directory = join(config.dataRoot, config.account);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const envelopes = [fixture().before];
  for (let count = 1; count <= 3; count++)
    envelopes.push(
      fixture(
        Array.from({ length: count }, (_, index) =>
          observation({ messageId: `card-${index + 1}` }),
        ),
      ).current,
    );
  const names = envelopes.map(
    (_, index) =>
      `2026-10-19T08-0${index}-00-000Z_${String(index + 1).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json`,
  );
  const snapshots = [];
  for (const [index, envelope] of envelopes.entries()) {
    const path = join(directory, names[index]);
    await writeFile(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    snapshots.push(await readTrackerSnapshot(path));
  }
  const originalControl = {
    ...emptyControl(),
    accountNamespace: ACCOUNT,
    checkpoint: {
      snapshotName: names[0],
      snapshotSha256: snapshots[0].sha256,
      capturedAt: STAMP,
      sourceSequence: 2,
    },
  };
  await inbox.writeControl(originalControl);
  let failure = 'batch';
  const failing = new BossInbox(inbox.root, {
    beforeCommit: async (kind) => {
      if (kind === failure) throw new Error(`synthetic-${kind}-failure`);
    },
  });
  const request = {
    mode: 'incremental',
    inbox: failing,
    previous: snapshots[0],
    current: snapshots[1],
    control: originalControl,
  };
  await assert.rejects(deliverSaved(request), /synthetic-batch-failure/);
  assert.equal((await inbox.list()).length, 0);
  assert.deepEqual(await inbox.readControl(), originalControl);
  failure = 'control';
  await assert.rejects(deliverSaved(request), /synthetic-control-failure/);
  assert.deepEqual(await inbox.readControl(), originalControl);
  const [pending] = await inbox.list();
  const durable = await inbox.read(pending.batchId);
  assert.equal(durable.events[0].jobDetails, null);
  failure = '';
  const retried = await deliverSaved(request);
  assert.equal(retried.queued.created, false);
  assert.deepEqual(retried.batch, durable);
  assert.equal(retried.control.checkpoint.sourceSequence, 3);

  const recovered = await recoverSaved({ config, inbox, control: retried.control });
  assert.equal(recovered.recovered, 2);
  assert.equal(recovered.batches, 2);
  assert.equal(recovered.events, 2);
  assert.equal(recovered.control.checkpoint.snapshotName, names[3]);
  assert.equal((await inbox.list()).length, 3);
  assert.equal((await consumer.run()).processed, 3);
  const after = await store.read();
  assert.deepEqual(after.workspace.data.opportunities, before.workspace.data.opportunities);
  assert.equal(after.workspace.data.sourceFacts.length, 3);
  assert.equal(after.workspace.data.sourceApplications.length, 3);
  assert.ok(
    after.workspace.data.sourceApplications.every(
      (item) =>
        item.status === 'no_effect' &&
        item.reason === 'observation_only' &&
        item.opportunityId === '',
    ),
  );
  const replay = await recoverSaved({ config, inbox, control: recovered.control });
  assert.equal(replay.recovered, 0);
  assert.equal((await consumer.run()).processed, 0);
  assert.deepEqual(await store.read(), after);
  assert.equal(await readFile(snapshots[0].path, 'utf8'), `${JSON.stringify(envelopes[0])}\n`);
});
