import { bossEventDigestInput, bossBatchDigestInput } from '../dist/boss/rules/batch.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceStore, workspaceDigest } from '../scripts/workspace-store.mjs';
import { BossInbox } from '../scripts/boss/delivery/inbox.mjs';
import {
  createWorkspaceInboxConsumer,
  workspaceConflictScope,
} from '../scripts/workspace-consumer.mjs';
import { initialWorkspace, createBackup, restoreWorkspace } from '../dist/workspace.js';
import { bindBossAccount } from '../dist/boss/application/integration.js';
import { bossApplicationId, bossFactId } from '../dist/source-identity.js';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`,
  STAMP = '2026-09-21T12:00:00.000Z';
function batch({
  jobId = 'synthetic-job',
  messageId = 'message-1',
  sequence = 1,
  company = '合成公司',
  contact = '合成招聘者',
  jobName = '合成岗位',
  intent = 'create_or_link',
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
    jobName,
    company,
    contact,
    summary: '合成摘要',
    messageId,
    messageDirection: 'unknown',
    receiptStatus: 'unknown',
    receiptSource: '',
    nameSource: 'loaded_jobName',
    linkConfirmation: 'unverified',
    intent,
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
async function fixture(t, { bind = true, input = batch(), workspace = initialWorkspace() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-headless-import-'));
  const store = new WorkspaceStore(join(root, 'workspace'), { now: () => STAMP });
  const inbox = new BossInbox(join(root, 'inbox'));
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
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

function reviewedOrdinaryWorkspace(input, { bound }) {
  const workspace = initialWorkspace();
  const row = input.events[0];
  const factId = bossFactId({ ...row, platform: 'boss', accountNamespace: ACCOUNT });
  const opportunityId = 'synthetic-employer-job';
  workspace.data.opportunities.push({
    id: opportunityId,
    company: '合成用人公司',
    role: '合成岗位',
    contact: '合成招聘者',
    platform: 'BOSS',
    externalId: row.externalJobId,
    url: row.canonicalUrl,
    stage: '面试中',
    resumeState: '未知',
    notes: '保留合成人工备注',
    createdAt: STAMP,
    updatedAt: STAMP,
  });
  if (bound)
    workspace.data.sourceBindings.push({
      id: `boss-job-${ACCOUNT.slice('boss-geek:'.length)}-${row.externalJobId}`,
      kind: 'opportunity',
      platform: 'boss',
      accountNamespace: ACCOUNT,
      externalJobId: row.externalJobId,
      canonicalUrl: row.canonicalUrl,
      opportunityId,
      autoFields: '',
      createdAt: STAMP,
      updatedAt: STAMP,
    });
  // Explicit old incident state: the company difference was rejected. Do not
  // ask the implementation under test to manufacture its own regression fixture.
  workspace.data.sourceEvents.push({
    id: row.eventId,
    batchId: input.batchId,
    platform: 'boss',
    accountNamespace: ACCOUNT,
    conversationKey: row.conversationKey,
    friendId: row.friendId,
    friendSource: row.friendSource,
    uniqueId: row.uniqueId,
    externalJobId: row.externalJobId,
    canonicalUrl: row.canonicalUrl,
    opportunityId: '',
    eventType: 'conversation_observed',
    factId,
    messageId: row.messageId,
    messageDirection: row.messageDirection,
    receiptStatus: row.receiptStatus,
    receiptSource: row.receiptSource,
    summary: row.summary,
    timeLabel: row.timeLabel,
    contact: row.contact,
    company: row.company,
    jobName: row.jobName,
    nameSource: row.nameSource,
    linkConfirmation: row.linkConfirmation,
    observedAt: row.observedAt,
    evidenceDate: '',
    sourceSnapshot: `${input.source.snapshotName}#sha256:${input.source.snapshotSha256}`,
    sourceSequence: String(row.sourceSequence),
    status: 'review',
    importPolicy: input.policy.id,
    appliedAtSource: '',
    createdAt: STAMP,
  });
  workspace.data.sourceFacts.push({
    id: factId,
    platform: 'boss',
    accountNamespace: ACCOUNT,
    conversationKey: row.conversationKey,
    messageId: row.messageId,
    factType: 'message_observed',
    deletedAt: '',
  });
  workspace.data.sourceApplications.push({
    id: bossApplicationId(factId),
    factId,
    opportunityId: '',
    ruleVersion: 'boss-application-v13',
    action: 'conversation_observed',
    status: 'review',
    reason: 'identity_conflict',
    appliedAt: '',
    updatedAt: STAMP,
    deletedAt: '',
  });
  return workspace;
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

function gate() {
  let resolve;
  const promise = new Promise((accept) => (resolve = accept));
  return { promise, resolve };
}

test('忙时新入队材料请求合并一次后续扫描，不返回旧轮完成', async (t) => {
  const { store, inbox } = await fixture(t);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  const entered = gate(),
    release = gate();
  const read = inbox.read.bind(inbox);
  let reads = 0,
    passes = 0;
  const record = store.recordImportDiagnostic.bind(store);
  store.recordImportDiagnostic = async (...args) => {
    passes++;
    return record(...args);
  };
  inbox.read = async (...args) => {
    if (++reads === 1) {
      entered.resolve();
      await release.promise;
    }
    return read(...args);
  };
  const first = consumer.run();
  await entered.promise;
  await inbox.enqueue(batch({ jobId: 'second-job', messageId: 'message-2', sequence: 2 }));
  const second = consumer.run();
  const sameScan = consumer.run();
  const timer = consumer.run({ rescanIfRunning: false });
  assert.equal(second, sameScan);
  assert.equal(second, timer);
  release.resolve();
  assert.equal((await first).processed, 1);
  assert.equal((await second).processed, 1);
  assert.equal(passes, 2);
  assert.equal((await store.read()).workspace.data.opportunities.length, 2);
  assert.equal(consumer.status().progress.running, false);
});

test('后台轮询不追加扫描，失败后后续显式扫描仍可完成', async (t) => {
  const { store, inbox } = await fixture(t);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  const entered = gate(),
    release = gate();
  let passes = 0;
  const record = store.recordImportDiagnostic.bind(store);
  store.recordImportDiagnostic = async (...args) => {
    if (++passes > 1) return record(...args);
    entered.resolve();
    await release.promise;
    throw new Error('synthetic diagnostic failure');
  };
  const first = consumer.run();
  await entered.promise;
  for (let i = 0; i < 5; i++) assert.equal(consumer.run({ rescanIfRunning: false }), first);
  const next = consumer.run();
  release.resolve();
  await assert.rejects(first, /synthetic diagnostic failure/);
  assert.equal((await next).processed, 0);
  assert.equal(passes, 2);
  assert.equal(consumer.status().progress.phase, 'completed');
});

test('消费提交中仍可只读检查，并显示尚未完成的批次', async (t) => {
  const { store, inbox, input } = await fixture(t);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  const entered = gate(),
    release = gate();
  const execute = store.execute.bind(store);
  store.execute = async (...args) => {
    entered.resolve();
    await release.promise;
    return execute(...args);
  };
  const running = consumer.run();
  await entered.promise;
  const progress = consumer.status().progress;
  assert.equal(progress.running, true);
  assert.equal(progress.phase, 'committing');
  assert.equal(progress.batchId, input.batchId);
  assert.equal(progress.completed, 0);
  assert.equal(progress.total, 1);
  const inspected = await Promise.race([
    consumer.inspect(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('inspection blocked')), 1000)),
  ]).finally(() => release.resolve());
  assert.equal(inspected.revision, 1);
  assert.deepEqual(inspected.restoreReview, []);
  release.resolve();
  await running;
  assert.equal(consumer.status().progress.completed, 1);
  assert.equal(consumer.status().progress.processed, 1);
});

test('只读检查跨过正式提交时重查，不把新回执误报恢复缺口', async (t) => {
  const { store, inbox } = await fixture(t);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  const list = inbox.list.bind(inbox);
  let lists = 0;
  inbox.list = async (...args) => {
    if (++lists === 1) await consumer.run();
    return list(...args);
  };
  const inspected = await consumer.inspect();
  assert.equal(lists, 2);
  assert.equal(inspected.revision, 2);
  assert.deepEqual(inspected.restoreReview, []);
});

test('只读检查连续跨过更新时明确未就绪，不返回混合版本结果', async (t) => {
  const { store, inbox } = await fixture(t);
  const consumer = createWorkspaceInboxConsumer({ workspaceStore: store, inbox, now: () => STAMP });
  const read = store.read.bind(store);
  let reads = 0;
  store.read = async () => ({ ...(await read()), revision: ++reads });
  await assert.rejects(consumer.inspect(), { code: 'LOCAL_STATUS_CHANGING' });
  assert.equal(reads, 4);
  assert.equal((await read()).revision, 1);
});

test('普通资料旧review及processed回执在本机重评，恢复后同材料消费保持稳定', async (t) => {
  for (const bound of [true, false]) {
    for (const complete of [true, false]) {
      await t.test(
        `${bound ? '已有绑定' : '未绑定'} / ${complete ? '完整标题' : '缺标题'}`,
        async (t) => {
          const input = batch({
            company: '合成招聘方',
            jobName: complete ? '合成岗位' : '',
            intent: complete ? 'create_or_link' : 'review',
            messageId: `ordinary-reviewed-${bound}-${complete}`,
          });
          const workspace = reviewedOrdinaryWorkspace(input, { bound });
          const { store, inbox } = await fixture(t, { input, workspace });
          const before = await store.read();
          const oldBackup = createBackup(before.workspace);
          const evidence = structuredClone(before.workspace.data.sourceEvents);
          const facts = structuredClone(before.workspace.data.sourceFacts);
          const opportunities = structuredClone(before.workspace.data.opportunities);
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
          const receipt = await inbox.readReceipt(input.batchId, before.workspaceId);
          const consumer = createWorkspaceInboxConsumer({
            workspaceStore: store,
            inbox,
            now: () => STAMP,
          });
          const result = await consumer.run();
          assert.deepEqual(result.isolated, []);
          assert.equal(result.processed, 1);
          assert.equal(result.waiting, 0);
          const after = await store.read();
          const application = after.workspace.data.sourceApplications[0];
          assert.equal(application.status, complete ? 'applied' : 'no_effect');
          assert.equal(application.opportunityId, 'synthetic-employer-job');
          if (!complete)
            assert.equal(
              application.reason,
              bound ? 'bound_job_details_available' : 'existing_job_details_available',
            );
          assert.deepEqual(after.workspace.data.opportunities, opportunities);
          assert.deepEqual(after.workspace.data.sourceEvents, evidence);
          assert.deepEqual(after.workspace.data.sourceFacts, facts);
          assert.deepEqual(await inbox.readReceipt(input.batchId, before.workspaceId), receipt);
          await consumer.run();
          assert.equal((await store.read()).revision, after.revision);
          assert.deepEqual((await store.read()).workspace, after.workspace);

          const restored = restoreWorkspace(after.workspace, oldBackup, 'snapshot');
          await store.execute({
            commandId: 'restore-synthetic-reviewed-material',
            expectedRevision: after.revision,
            type: 'commit_workspace',
            payload: { workspace: restored, reason: '合成恢复旧资料核对项' },
          });
          const restoredState = await store.read();
          assert.equal(restoredState.workspace.data.sourceApplications[0].status, 'review');
          const restoredRun = await consumer.run();
          assert.deepEqual(restoredRun.isolated, []);
          const replayed = await store.read();
          if (bound) {
            assert.equal(restoredRun.processed, 1);
            assert.equal(replayed.revision, restoredState.revision + 1);
            assert.deepEqual(replayed.workspace.data, after.workspace.data);
          } else {
            assert.equal(restoredRun.waiting, 1);
            assert.equal(replayed.workspace.data.sourceApplications[0].status, 'review');
            assert.equal(replayed.workspace.data.sourceApplications[0].reason, 'identity_conflict');
            assert.equal(replayed.workspace.data.sourceApplications[0].opportunityId, '');
            assert.deepEqual(
              replayed.workspace.data.sourceBindings,
              restoredState.workspace.data.sourceBindings,
            );
            assert.ok(
              replayed.workspace.data.sourceBindings.find((row) => row.kind === 'opportunity')
                .deletedAt,
            );
            assert.deepEqual(replayed.workspace.data.opportunities, opportunities);
            assert.deepEqual(replayed.workspace.data.sourceEvents, evidence);
            assert.deepEqual(replayed.workspace.data.sourceFacts, facts);
          }
          await consumer.run();
          assert.equal((await store.read()).revision, replayed.revision);
          assert.deepEqual((await store.read()).workspace, replayed.workspace);
          if (!bound) {
            const fresh = batch({
              sequence: 2,
              company: '合成招聘方',
              jobName: complete ? '合成岗位' : '',
              intent: complete ? 'create_or_link' : 'review',
              messageId: `fresh-after-deleted-binding-${complete}`,
            });
            await inbox.enqueue(fresh);
            const freshRun = await consumer.run();
            assert.deepEqual(freshRun.isolated, []);
            const blocked = await store.read();
            assert.equal(blocked.workspace.data.sourceApplications.at(-1).status, 'review');
            assert.equal(
              blocked.workspace.data.sourceApplications.at(-1).reason,
              'identity_conflict',
            );
            assert.deepEqual(blocked.workspace.data.opportunities, opportunities);
            assert.deepEqual(
              blocked.workspace.data.sourceBindings,
              replayed.workspace.data.sourceBindings,
            );
            await consumer.run();
            assert.equal((await store.read()).revision, blocked.revision);
            assert.deepEqual((await store.read()).workspace, blocked.workspace);
          }
        },
      );
    }
  }
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
