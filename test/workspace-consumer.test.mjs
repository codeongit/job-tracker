import { bossEventDigestInput, bossBatchDigestInput } from '../dist/boss-batch.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore, workspaceDigest } from '../scripts/workspace-store.mjs';
import { BossInbox } from '../scripts/boss-inbox.mjs';
import {
  createWorkspaceInboxConsumer,
  workspaceConflictScope,
} from '../scripts/workspace-consumer.mjs';
import { initialWorkspace } from '../dist/workspace.js';
import { bindBossAccount } from '../dist/boss-integration.js';
import { bossApplicationId, bossFactId } from '../dist/source-identity.js';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`,
  STAMP = '2026-09-21T12:00:00.000Z';
function batch({
  jobId = 'synthetic-job',
  messageId = 'message-1',
  sequence = 1,
  company = '合成公司',
  contact = '合成招聘者',
} = {}) {
  const facts = {
    platform: 'boss',
    accountNamespace: ACCOUNT,
    conversationKey: '1'.repeat(64),
    friendId: 'friend-1',
    friendSource: 'source-1',
    uniqueId: 'friend-1-source-1',
    externalJobId: jobId,
    canonicalUrl: `https://www.zhipin.com/job_detail/${jobId}.html`,
    jobName: '合成岗位',
    company,
    contact,
    summary: '合成摘要',
    messageId,
    messageDirection: 'unknown',
    receiptStatus: 'unknown',
    receiptSource: '',
    nameSource: 'loaded_jobName',
    linkConfirmation: 'unverified',
    intent: 'create_or_link',
  };
  const event = {
    ...Object.fromEntries(
      Object.entries(facts).filter(([key]) => !['platform', 'accountNamespace'].includes(key)),
    ),
    eventId: `boss-event-${workspaceDigest(facts)}`,
    timeLabel: '',
    observedAt: STAMP,
    evidenceDate: '',
    appliedAtForNew: '',
    sourceSequence: sequence,
  };
  const policy = {
    id: 'boss-manual-check-v1',
    mode: 'incremental',
    timezone: 'Asia/Shanghai',
    appliedAtForNew: '',
    autoCreateComplete: true,
  };
  const source = {
    snapshotName: 'synthetic.json',
    snapshotSha256: 'c'.repeat(64),
    capturedAt: STAMP,
  };
  return {
    format: 'job-tracker-boss-batch',
    version: 1,
    batchId: `boss-batch-${workspaceDigest({ policy: policy.id, snapshotSha256: source.snapshotSha256, accountNamespace: ACCOUNT, eventIds: [event.eventId] })}`,
    platform: 'boss',
    accountNamespace: ACCOUNT,
    sourceSequence: sequence,
    policy,
    source,
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
}
async function fixture(t, { bind = true, input = batch() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-headless-import-'));
  const store = new WorkspaceStore(join(root, 'workspace'), { now: () => STAMP });
  const inbox = new BossInbox(join(root, 'inbox'));
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = initialWorkspace();
  if (bind)
    workspace.data = bindBossAccount(
      workspace.data,
      ACCOUNT,
      '00000000-0000-4000-8000-000000000001',
      STAMP,
    );
  await store.execute({
    commandId: 'import',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: '合成迁移' },
  });
  await inbox.enqueue(input);
  return { root, store, inbox, input };
}

test('来源事实冲突通过应用关系归属到岗位，不遗漏来源依赖隔离', () => {
  const factId = 'boss-fact-synthetic',
    scope = workspaceConflictScope({
      data: {
        sourceBindings: [],
        sourceEvents: [],
        sourceApplications: [{ id: 'application-1', factId, opportunityId: 'job-1' }],
      },
      pending: {
        data: { sourceBindings: [], sourceEvents: [], sourceApplications: [] },
        remote: { sourceBindings: [], sourceEvents: [], sourceApplications: [] },
        conflicts: [
          {
            key: `sourceFacts:${factId}`,
            group: 'sourceFacts',
            id: factId,
            local: { id: factId, accountNamespace: ACCOUNT },
            remote: { id: factId, accountNamespace: ACCOUNT },
          },
        ],
      },
    });
  assert.deepEqual(scope.opportunityIds, ['job-1']);
  assert.equal(scope.unscoped, false);
});
test('无需网页的队列消费在正式提交后回执，重复执行不重复建档', async (t) => {
  const { store, inbox } = await fixture(t);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  assert.equal((await consumer.run()).processed, 1);
  assert.equal((await store.read()).workspace.data.opportunities.length, 1);
  assert.equal((await consumer.run()).processed, 0);
  assert.equal((await store.read()).revision, 2);
});

test('缺少稳定消息身份的批次只保存待补证据，不创建岗位或语义事实', async (t) => {
  const { store, inbox } = await fixture(t, { input: batch({ messageId: '' }) });
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  const result = await consumer.run();
  assert.equal(result.processed, 1);
  assert.equal(result.waiting, 1);
  const data = (await store.read()).workspace.data;
  assert.equal(data.opportunities.length, 0);
  assert.equal(data.sourceEvents.length, 1);
  assert.equal(data.sourceEvents[0].factId, '');
  assert.equal(data.sourceFacts.length, 0);
  assert.equal(data.sourceApplications.length, 0);
});

test('恢复后的已回执缺口不自动重放，明确核对版本后可幂等修复', async (t) => {
  const { store, inbox, input } = await fixture(t);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  await consumer.run();
  const current = await store.read(),
    workspace = structuredClone(current.workspace);
  workspace.data.sourceEvents = [];
  workspace.data.sourceFacts = [];
  workspace.data.sourceApplications = [];
  workspace.generation++;
  await store.execute({
    commandId: 'synthetic-restore-gap',
    expectedRevision: current.revision,
    type: 'commit_workspace',
    payload: { workspace, reason: '合成恢复缺口' },
  });
  const restored = await store.read();
  const summary = await consumer.run();
  assert.equal(summary.waiting, 1);
  assert.equal(summary.restoreReview[0].missing, 1);
  assert.equal((await store.read()).revision, restored.revision);
  const review = await consumer.inspect();
  assert.equal(review.revision, restored.revision);
  await assert.rejects(
    consumer.replay(input.batchId, restored.revision - 1),
    (error) => error.code === 'WORKSPACE_REVISION_CONFLICT',
  );
  const result = await consumer.replay(input.batchId, restored.revision);
  assert.equal(result.counts.added, 0);
  assert.equal((await consumer.inspect()).restoreReview.length, 0);
  assert.equal((await store.read()).workspace.data.opportunities.length, 1);
  const repeated = await consumer.replay(input.batchId, restored.revision);
  assert.equal(repeated.replayed, true);
  assert.equal((await store.read()).revision, result.revision);
});

test('明确恢复来源证据不复活删除岗位，也不覆盖人工字段', async (t) => {
  const { store, inbox, input } = await fixture(t);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  await consumer.run();
  const current = await store.read(),
    workspace = structuredClone(current.workspace);
  workspace.data.sourceEvents[0].deletedAt = STAMP;
  workspace.data.sourceFacts[0].deletedAt = STAMP;
  workspace.data.sourceApplications[0].deletedAt = STAMP;
  workspace.data.opportunities[0].deletedAt = STAMP;
  workspace.data.opportunities[0].notes = '人工合成备注';
  workspace.generation++;
  await store.execute({
    commandId: 'synthetic-deleted-gap',
    expectedRevision: current.revision,
    type: 'commit_workspace',
    payload: { workspace, reason: '合成删除恢复' },
  });
  const restored = await store.read();
  await consumer.replay(input.batchId, restored.revision);
  const after = (await store.read()).workspace.data;
  assert.equal(after.opportunities[0].deletedAt, STAMP);
  assert.equal(after.opportunities[0].notes, '人工合成备注');
  assert.equal(after.sourceEvents[0].deletedAt, undefined);
  assert.equal((await consumer.inspect()).restoreReview.length, 0);
});
test('提交成功但回执失败后重试重发原新增计数，不重新执行事务', async (t) => {
  const { store, inbox, input } = await fixture(t);
  const realAck = inbox.acknowledge.bind(inbox);
  let failOnce = true;
  inbox.acknowledge = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('synthetic receipt failure');
    }
    return realAck(...args);
  };
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  assert.equal((await consumer.run()).isolated.length, 1);
  assert.equal((await store.read()).revision, 2);
  assert.equal((await consumer.run()).processed, 1);
  const receipt = await inbox.readReceipt(input.batchId, store.workspaceId);
  assert.equal(receipt.version, 2);
  assert.equal(receipt.counts.added, 1);
  assert.equal((await store.read()).revision, 2);
});
test('未绑定账号只保留待处理，坏批次保存隔离诊断而非使整个索引崩溃', async (t) => {
  const { store, inbox } = await fixture(t, { bind: false });
  await writeFile(join(inbox.inbox, `boss-batch-${'d'.repeat(64)}.json`), '{invalid', {
    mode: 0o600,
  });
  const result = await createWorkspaceInboxConsumer({ workspaceStore: store, inbox }).run();
  assert.equal(result.waiting, 1);
  assert.equal(result.isolated.length, 1);
  assert.equal((await store.read()).revision, 1);
});

test('同批冲突岗位等待，独立岗位提交并进入pending候选，冲突解除后自动重评', async (t) => {
  const { store, inbox } = await fixture(t);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  await consumer.run();
  const current = await store.read(),
    workspace = structuredClone(current.workspace);
  const original = structuredClone(workspace.data.opportunities[0]);
  workspace.data.opportunities[0].notes = '合成本机备注';
  workspace.generation++;
  const remote = structuredClone(workspace.data);
  remote.opportunities[0].notes = '合成远端备注';
  workspace.pending = {
    data: structuredClone(workspace.data),
    remote,
    generation: workspace.generation,
    conflicts: [
      {
        key: `opportunities:${original.id}`,
        group: 'opportunities',
        id: original.id,
        base: original,
        local: workspace.data.opportunities[0],
        remote: remote.opportunities[0],
      },
    ],
  };
  await store.execute({
    commandId: 'synthetic-sync-conflict',
    expectedRevision: current.revision,
    type: 'commit_workspace',
    payload: { workspace, reason: '合成同步冲突' },
  });
  const followup = batch({ messageId: 'message-2', sequence: 2 });
  followup.events.push(
    batch({ jobId: 'independent-job', messageId: 'other-message', sequence: 2 }).events[0],
  );
  followup.coverage.loadedRows =
    followup.coverage.loadedDataRows =
    followup.coverage.renderedRows =
      2;
  followup.batchId = `boss-batch-${workspaceDigest({ policy: followup.policy.id, snapshotSha256: followup.source.snapshotSha256, accountNamespace: ACCOUNT, eventIds: followup.events.map((row) => row.eventId).sort() })}`;
  await inbox.enqueue(followup);
  const result = await consumer.run();
  assert.equal(result.isolated.length, 0);
  const after = await store.read();
  assert.equal(after.workspace.data.opportunities.length, 2);
  assert.equal(after.workspace.pending.data.opportunities.length, 2);
  assert.equal(after.workspace.pending.conflicts.length, 1);
  const waitingId = bossApplicationId(
    bossFactId({
      ...followup.events[0],
      platform: 'boss',
      accountNamespace: followup.accountNamespace,
    }),
  );
  assert.equal(
    after.workspace.data.sourceApplications.find((row) => row.id === waitingId).status,
    'waiting',
  );
  await consumer.run();
  assert.equal((await store.read()).revision, after.revision);
  const resolved = structuredClone(after.workspace);
  resolved.pending = null;
  resolved.generation++;
  await store.execute({
    commandId: 'resolve-synthetic-conflict',
    expectedRevision: after.revision,
    type: 'commit_workspace',
    payload: { workspace: resolved, reason: '合成冲突解决' },
  });
  await consumer.run();
  assert.equal(
    (await store.read()).workspace.data.sourceApplications.find((row) => row.id === waitingId)
      .status,
    'applied',
  );
});

test('pending 重基时新发现的岗位冲突自动隔离，同批独立岗位仍正式提交', async (t) => {
  const { store, inbox } = await fixture(t);
  let failure;
  const consumer = createWorkspaceInboxConsumer({
    workspaceStore: store,
    inbox,
    now: () => STAMP,
    onError: (error) => {
      failure = error;
    },
  });
  await consumer.run();
  const current = await store.read(),
    workspace = structuredClone(current.workspace),
    manual = { id: 'manual-job', company: '人工公司', role: '人工岗位', stage: '已触达' },
    manualRemote = { ...manual, notes: '远端分歧' };
  workspace.data.opportunities.push(manual);
  const candidate = structuredClone(workspace.data);
  candidate.opportunities.find((row) => row.id !== manual.id).contact = '云端待同步招聘者';
  workspace.generation++;
  workspace.pending = {
    data: candidate,
    remote: structuredClone(candidate),
    generation: workspace.generation,
    conflicts: [
      {
        key: `opportunities:${manual.id}`,
        group: 'opportunities',
        id: manual.id,
        base: manual,
        local: manual,
        remote: manualRemote,
      },
    ],
  };
  await store.execute({
    commandId: 'synthetic-new-rebase-conflict',
    expectedRevision: current.revision,
    type: 'commit_workspace',
    payload: { workspace, reason: '合成待同步候选' },
  });
  const followup = batch({ messageId: 'message-2', sequence: 2, contact: '平台新招聘者' });
  followup.events.push(
    batch({ jobId: 'independent-job', messageId: 'other-message', sequence: 2 }).events[0],
  );
  followup.coverage.loadedRows =
    followup.coverage.loadedDataRows =
    followup.coverage.renderedRows =
      2;
  followup.batchId = `boss-batch-${workspaceDigest({ policy: followup.policy.id, snapshotSha256: followup.source.snapshotSha256, accountNamespace: ACCOUNT, eventIds: followup.events.map((row) => row.eventId).sort() })}`;
  await inbox.enqueue(followup);
  const result = await consumer.run();
  if (result.isolated.length) assert.fail(failure?.stack || failure?.message);
  assert.deepEqual(result.isolated, []);
  const after = (await store.read()).workspace;
  assert.equal(
    after.data.opportunities.some((row) => row.externalId === 'independent-job'),
    true,
  );
  assert.equal(
    after.data.opportunities.find((row) => row.externalId === 'synthetic-job').contact,
    '合成招聘者',
  );
  assert.equal(
    after.pending.data.opportunities.find((row) => row.externalId === 'synthetic-job').contact,
    '云端待同步招聘者',
  );
  const blockedId = bossApplicationId(
    bossFactId({ ...followup.events[0], platform: 'boss', accountNamespace: ACCOUNT }),
  );
  assert.equal(after.data.sourceApplications.find((row) => row.id === blockedId).status, 'waiting');
  assert.equal(after.pending.conflicts.length, 1);
});

test('旧队列消费使用正式上下文诊断，诊断失败不提交或回执，修复后幂等重评', async (t) => {
  const { store, inbox } = await fixture(t);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  await consumer.run();
  const input = batch({ jobId: 'other-job', sequence: 2 });
  const e = input.events[0];
  e.eventType = 'resume_observed';
  e.intent = 'observe_only';
  e.summary = 'resume_request_sent';
  e.receiptStatus = 'not_applicable';
  e.messageDirection = 'outbound';
  // A legacy queue has no attribution fields and still crosses the same gate.
  e.eventId = `boss-event-${workspaceDigest(bossEventDigestInput(input, e))}`;
  input.policy = {
    id: 'boss-resume-observation-v1',
    mode: 'resume',
    timezone: 'Asia/Shanghai',
    appliedAtForNew: '',
    autoCreateComplete: false,
  };
  input.batchId = `boss-batch-${workspaceDigest(bossBatchDigestInput(input))}`;
  await inbox.enqueue(input);
  const before = await store.read();
  const directory = join(inbox.root, 'attribution-diagnostics');
  await rm(directory, { recursive: true });
  await writeFile(directory, 'blocked', { mode: 0o600 });
  await consumer.run();
  assert.equal((await store.read()).revision, before.revision);
  assert.equal(await inbox.readReceipt(input.batchId, store.workspaceId), null);
  await rm(directory);
  await consumer.run();
  const after = await store.read();
  assert.deepEqual(after.workspace.data.opportunities, before.workspace.data.opportunities);
  assert.equal(
    after.workspace.data.sourceApplications.at(-1).reason,
    'attribution_message_multiple_jobs',
  );
  const names = await readdir(directory);
  const diagnostics = await Promise.all(
    names.map((name) => readFile(join(directory, name), 'utf8')),
  );
  assert.ok(
    diagnostics.some(
      (text) =>
        JSON.parse(text).stage === 'consume' &&
        JSON.parse(text).reason === 'attribution_message_multiple_jobs',
    ),
  );
  assert.doesNotMatch(diagnostics.join(''), /friend-1|message-1|other-job|合成摘要|boss-geek/);
  await consumer.run();
  assert.equal((await store.read()).revision, after.revision);
});
