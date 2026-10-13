import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOSS_ACTION40_PLATFORM_CONTRACT } from '../dist/boss/rules/resume-rules.js';
import { bindBossAccount } from '../dist/boss/application/integration.js';
import { initialWorkspace } from '../dist/workspace.js';
import { accountNamespace } from '../collector/boss/platform/extract.mjs';
import { createEnvelopeV2, conversationKeyV2 } from '../collector/boss/materials/model-v2.mjs';
import {
  createResumePageExpression,
  toResumeHistoryResult,
  applyResumeHistoryV2,
} from '../collector/boss/history/resume-history.mjs';
import { commit, latest } from '../collector/boss/persistence/storage.mjs';
import { createResumeBatch } from '../scripts/boss/delivery/conversion.mjs';
import { BossInbox } from '../scripts/boss/delivery/inbox.mjs';
import { WorkspaceStore } from '../scripts/workspace-store.mjs';
import { createWorkspaceInboxConsumer } from '../scripts/workspace-consumer.mjs';

const STAMP = '2026-10-10T00:00:00.000Z';
const ACCOUNT = accountNamespace('201');
const CONVERSATION = conversationKeyV2(ACCOUNT, '301', '0');
const JOB = 'synthetic-job-301';
const JOB_URL = `https://www.zhipin.com/job_detail/${JOB}.html`;
const OPPORTUNITY = 'synthetic-existing-opportunity';
const OPAQUE_TOKEN = 'synthetic-opaque-action-token';

function snapshot() {
  return {
    capturedAt: STAMP,
    scope: 'loaded-chat-list',
    accountNamespace: ACCOUNT,
    records: [
      {
        key: CONVERSATION,
        platformIdentity: { friendId: '301', friendSource: '0', uniqueId: '301-0' },
        contact: 'Synthetic contact',
        company: 'Synthetic company',
        title: 'Recruiter',
        preview: 'Synthetic preview',
        timeLabel: '08:00',
        unread: null,
        latestMessageId: 'synthetic-opaque-send',
        outgoingReceipt: { status: 'unknown', label: null, source: null },
        jobAssociation: { jobId: JOB, detailUrl: JOB_URL },
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
}

async function generatedHistoryPage() {
  let requests = 0;
  class FakeXHR {
    open() {}
    setRequestHeader() {}
    send() {
      requests++;
      this.status = 200;
      this.responseText = JSON.stringify({
        code: 0,
        zpData: {
          messages: [
            {
              mid: 'synthetic-opaque-send',
              type: 1,
              time: Date.parse(STAMP) / 1000,
              encryptJobId: JOB,
              from: { uid: '201' },
              to: { uid: '301' },
              body: { type: 4, templateId: 1, action: { aid: 40, extend: OPAQUE_TOKEN } },
            },
          ],
        },
      });
      queueMicrotask(() => this.onload());
    }
  }
  const listVm = {
    $options: { name: 'virtual-list' },
    $props: { dataSources: [{}] },
    $store: { state: { userInfo: { userId: '201' } } },
  };
  const expression = createResumePageExpression({
    target: { conversationKey: CONVERSATION, friendId: '301', friendSource: '0' },
    identity: {
      bossId: '301',
      securityId: 'synthetic-security',
      responseFriendId: '301',
      responseFriendSource: '0',
    },
    page: 1,
    platformContract: BOSS_ACTION40_PLATFORM_CONTRACT,
  });
  const output = await vm.runInNewContext(expression, {
    location: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat' },
    window: { _PAGE: { uid: '201' } },
    document: {
      querySelectorAll: () => [{ __vue__: listVm, parentElement: null }],
      visibilityState: 'hidden',
      hasFocus: () => false,
    },
    XMLHttpRequest: FakeXHR,
    queueMicrotask,
    Date,
    JSON,
    Number,
    String,
    Object,
    Array,
    RegExp,
    encodeURIComponent,
  });
  const page = JSON.parse(JSON.stringify(output));
  assert.equal(requests, 1);
  assert.equal(page.ok, true);
  assert.equal(page.observations.length, 1);
  assert.deepEqual(page.unresolved, []);
  assert.equal(page.observations[0].resumeEvidence.version, 4);
  assert.equal(page.observations[0].attribution.selfId, '201');
  return page;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'boss-opaque-pipeline-'));
  let failHead = false;
  const store = new WorkspaceStore(join(root, 'workspace'), {
    now: () => STAMP,
    beforeCommit: async (stage) => {
      if (stage === 'before_head' && failHead) {
        failHead = false;
        throw new Error('synthetic commit interruption');
      }
    },
  });
  const inbox = new BossInbox(join(root, 'inbox'));
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const { envelope } = createEnvelopeV2(snapshot());
  const page = await generatedHistoryPage();
  const result = toResumeHistoryResult(
    {
      ...page,
      capturedAt: STAMP,
      coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 1 },
    },
    envelope,
  );
  const collected = applyResumeHistoryV2(envelope, result).envelope;
  assert.equal(collected.version, 8);
  const collectorDirectory = join(root, 'collector');
  await mkdir(collectorDirectory, { mode: 0o700 });
  const path = await commit(collectorDirectory, collected);
  const saved = await latest(collectorDirectory);
  assert.equal(saved.path, path);
  assert.deepEqual(saved.envelope, collected);
  const bytes = await readFile(path);
  const batch = createResumeBatch(
    { ...saved, sha256: createHash('sha256').update(bytes).digest('hex') },
    1,
  );
  assert.equal(batch.version, 8);
  assert.equal(batch.policy.autoCreateComplete, false);
  assert.equal(batch.events[0].intent, 'observe_only');
  assert.equal(batch.events[0].resumeEvidence.version, 4);
  for (const value of [bytes.toString('utf8'), JSON.stringify(batch)]) {
    assert.equal(value.includes(OPAQUE_TOKEN), false);
    assert.equal(value.includes('synthetic-security'), false);
    assert.equal(value.includes('"extend"'), false);
  }
  await store.initialize();
  const identity = await store.read();
  const workspace = initialWorkspace();
  workspace.data.opportunities.push({
    id: OPPORTUNITY,
    company: 'Synthetic company',
    role: 'Synthetic role',
    contact: 'Synthetic contact',
    platform: 'BOSS',
    externalId: JOB,
    url: JOB_URL,
    stage: '已触达',
    readState: '未读',
    resumeState: '未知',
    notes: 'Synthetic retained notes',
    createdAt: STAMP,
    updatedAt: STAMP,
  });
  workspace.data.sourceBindings.push({
    id: `boss-job-${ACCOUNT.slice('boss-geek:'.length)}-${JOB}`,
    kind: 'opportunity',
    platform: 'boss',
    accountNamespace: ACCOUNT,
    externalJobId: JOB,
    canonicalUrl: JOB_URL,
    opportunityId: OPPORTUNITY,
    autoFields: 'resumeState,readState,stage',
    lastAutoResumeState: '未知',
    lastAutoReadState: '未读',
    lastAutoStage: '已触达',
    createdAt: STAMP,
    updatedAt: STAMP,
  });
  workspace.data = bindBossAccount(workspace.data, ACCOUNT, identity.workspaceId, STAMP);
  await store.execute({
    commandId: 'synthetic-existing-target',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: 'Synthetic existing target' },
  });
  const before = await store.read();
  assert.equal(
    before.workspace.data.sourceBindings.find((item) => item.kind === 'account').workspaceSourceId,
    before.workspaceId,
  );
  await inbox.enqueue(batch);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  return { store, inbox, batch, consumer, before, failNextCommit: () => (failHead = true) };
}

test('合成 HTTP 动作经完整快照、v8 批次与正式消费推进现存岗位，重复消费幂等', async (t) => {
  const { store, inbox, batch, consumer, before } = await fixture(t);
  const summary = await consumer.run();
  assert.equal(summary.processed, 1);
  assert.equal(summary.waiting, 0);
  assert.deepEqual(summary.isolated, []);
  const after = await store.read();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.workspace.data.opportunities.length, 1);
  assert.equal(after.workspace.data.opportunities[0].id, OPPORTUNITY);
  assert.equal(after.workspace.data.opportunities[0].resumeState, '已发送');
  assert.equal(after.workspace.data.opportunities[0].stage, '沟通中');
  assert.equal(after.workspace.data.opportunities[0].notes, 'Synthetic retained notes');
  assert.equal(after.workspace.data.sourceFacts.length, 1);
  assert.equal(after.workspace.data.sourceEvents.length, 1);
  assert.equal(after.workspace.data.sourceApplications[0].status, 'applied');
  assert.equal((await inbox.readReceipt(batch.batchId, after.workspaceId)).status, 'processed');
  await inbox.enqueue(batch);
  assert.equal((await consumer.run()).processed, 0);
  assert.deepEqual(await store.read(), after);
});

test('同一不透明动作的正式提交失败不确认回执或状态，重试原批次只提交一次', async (t) => {
  const { store, inbox, batch, consumer, before, failNextCommit } = await fixture(t);
  failNextCommit();
  const failed = await consumer.run();
  assert.equal(failed.processed, 0);
  assert.equal(failed.isolated.length, 1);
  assert.deepEqual(await store.read(), before);
  assert.equal(await inbox.readReceipt(batch.batchId, before.workspaceId), null);
  const recovered = await consumer.run();
  assert.equal(recovered.processed, 1);
  assert.deepEqual(recovered.isolated, []);
  const after = await store.read();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.workspace.data.opportunities[0].resumeState, '已发送');
  assert.equal(after.workspace.data.opportunities[0].stage, '沟通中');
  assert.equal(after.workspace.data.sourceFacts.length, 1);
  assert.equal((await inbox.readReceipt(batch.batchId, after.workspaceId)).status, 'processed');
  await consumer.run();
  assert.deepEqual(await store.read(), after);
});
