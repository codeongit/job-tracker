import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initialWorkspace, createBackup, parseBackup } from '../dist/workspace.js';
import { WorkspaceStore, workspaceDigest } from '../scripts/workspace-store.mjs';
import { handleLocalApi } from '../scripts/local-api.mjs';
import { markManualFields } from '../dist/model.js';
import { bossReceiptGap } from '../dist/boss-integration.js';
import { BossInbox } from '../scripts/boss-inbox.mjs';
import { correctionFixture } from './fixtures/boss-resume-correction.mjs';

const SECRET = 'f'.repeat(64);
const STAMP = '2026-10-08T12:00:00.000Z';
const REASON = 'user_rejected_wrong_resume_semantics';

function legacyResumeOnlyCorrection(workspace, source) {
  for (const id of source.applicationIds) {
    const application = workspace.data.sourceApplications.find((row) => row.id === id);
    const opportunity = workspace.data.opportunities.find(
      (row) => row.id === application.opportunityId,
    );
    const binding = workspace.data.sourceBindings.find(
      (row) => row.kind === 'opportunity' && row.opportunityId === opportunity.id,
    );
    opportunity.resumeState = '未知';
    opportunity.updatedAt = STAMP;
    binding.lastAutoResumeState = '未知';
    binding.updatedAt = STAMP;
    Object.assign(application, {
      status: 'protected',
      reason: REASON,
      appliedAt: STAMP,
      updatedAt: STAMP,
      ruleVersion: 'boss-application-v12',
    });
  }
}

async function legacyCommittedCorrection(t) {
  const { root, store, first, source, command } = await fixture(t);
  await store.close();
  const headPath = join(store.root, 'HEAD.json');
  const previous = JSON.parse(await readFile(headPath, 'utf8'));
  const workspace = structuredClone(first.workspace);
  legacyResumeOnlyCorrection(workspace, source);
  workspace.generation++;
  const body = {
    storageVersion: 1,
    workspaceId: first.workspaceId,
    revision: first.revision + 1,
    previous: { file: previous.file, hash: previous.hash },
    createdAt: STAMP,
    command: {
      commandId: command.commandId,
      digest: workspaceDigest(command),
      type: command.type,
      result: null,
    },
    workspace,
  };
  const commit = { ...body, hash: workspaceDigest(body) };
  const file = `${String(commit.revision).padStart(12, '0')}-${commit.hash}.json`;
  await writeFile(join(store.commits, file), JSON.stringify(commit), { mode: 0o600 });
  await writeFile(
    headPath,
    JSON.stringify({
      storageVersion: 1,
      workspaceId: commit.workspaceId,
      revision: commit.revision,
      hash: commit.hash,
      file,
    }),
    { mode: 0o600 },
  );
  const reopened = new WorkspaceStore(join(root, 'workspace'), { now: () => STAMP });
  t.after(() => reopened.close());
  const oldCorrection = await reopened.read();
  return { store: reopened, first, source, command, oldCorrection };
}

async function fixture(t, { mutate = () => {}, storeOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'boss-resume-correction-service-'));
  const store = new WorkspaceStore(join(root, 'workspace'), { now: () => STAMP, ...storeOptions });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const source = correctionFixture();
  const workspace = initialWorkspace();
  workspace.data = structuredClone(source.data);
  workspace.base = structuredClone(source.data);
  mutate(workspace, source);
  await store.execute({
    commandId: 'synthetic-import',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: '合成测试' },
  });
  const first = await store.read();
  const command = {
    commandId: 'semantic-review',
    expectedRevision: first.revision,
    type: 'correct_boss_resume_semantics',
    payload: { applicationIds: source.applicationIds },
  };
  return { root, store, first, source, command };
}

async function api(command, store, headers = {}) {
  const result = {};
  const req = {
    url: '/__local/workspace/commands',
    method: 'POST',
    headers: {
      host: '127.0.0.1:4317',
      origin: 'http://127.0.0.1:4317',
      'x-job-tracker-session': SECRET,
      'x-job-tracker-protocol': '1',
      'content-type': 'application/json',
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(command));
    },
  };
  const res = {
    writeHead(status) {
      result.status = status;
    },
    end(text) {
      result.body = JSON.parse(text);
    },
  };
  await handleLocalApi(req, res, { port: 4317, secret: SECRET, workspaceStore: store });
  return result;
}

test('新简历语义纠正命令经固定 HTTP 入口交付，沿用会话、协议与同源保护', async () => {
  const command = {
    commandId: 'semantic-review',
    expectedRevision: 1,
    type: 'correct_boss_resume_semantics',
    payload: { applicationIds: ['synthetic-application'] },
  };
  const accepted = [];
  const store = {
    execute: async (input) => {
      accepted.push(input);
      return { revision: 2 };
    },
  };
  const result = await api(command, store);
  assert.equal(result.status, 200);
  assert.deepEqual(accepted, [command]);
  for (const [headers, status] of [
    [{ 'x-job-tracker-session': '' }, 403],
    [{ 'x-job-tracker-protocol': '2' }, 409],
    [{ origin: 'http://untrusted.invalid' }, 403],
  ])
    assert.equal((await api(command, store, headers)).status, status);
  assert.equal(accepted.length, 1);
});

test('HTTP 批量纠正一次原子提交，同时回退自动沟通中，原始事实及已读保留', async (t) => {
  const { store, first, source, command } = await fixture(t);
  const result = await api(command, store);
  assert.equal(result.status, 200);
  assert.equal(result.body.revision, first.revision + 1);
  assert.equal(result.body.workspace.generation, first.workspace.generation + 1);
  assert.deepEqual(result.body.workspace.base, first.workspace.base);
  assert.deepEqual(result.body.workspace.data.sourceEvents, first.workspace.data.sourceEvents);
  assert.deepEqual(result.body.workspace.data.sourceFacts, first.workspace.data.sourceFacts);
  for (const id of source.opportunityIds) {
    const previous = first.workspace.data.opportunities.find((row) => row.id === id);
    const current = result.body.workspace.data.opportunities.find((row) => row.id === id);
    assert.equal(current.resumeState, '未知');
    assert.equal(current.readState, previous.readState);
    assert.equal(current.stage, '已触达');
    const binding = result.body.workspace.data.sourceBindings.find(
      (row) => row.kind === 'opportunity' && row.opportunityId === id,
    );
    assert.equal(binding.lastAutoStage, '已触达');
  }
  for (const id of source.applicationIds) {
    const app = result.body.workspace.data.sourceApplications.find((row) => row.id === id);
    assert.equal(app.status, 'protected');
    assert.equal(app.reason, 'user_rejected_wrong_resume_semantics');
  }
  assert.equal((await readdir(store.commits)).length, 2);
  for (const batch of source.batches)
    assert.equal(bossReceiptGap(result.body.workspace.data, batch), 0);
});

test('旧版仅简历纠错提交通过新命令补偿阶段，旧 command 精确重放仍返回原结果', async (t) => {
  const { store, source, command, oldCorrection } = await legacyCommittedCorrection(t);
  assert.equal(
    oldCorrection.workspace.data.opportunities.every((row) => row.stage === '沟通中'),
    true,
  );
  const replay = await api(command, store);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.revision, oldCorrection.revision);
  assert.deepEqual(replay.body.workspace, oldCorrection.workspace);
  assert.deepEqual(await store.read(), oldCorrection);
  const compensation = await api(
    { ...command, commandId: 'stage-compensation', expectedRevision: oldCorrection.revision },
    store,
  );
  assert.equal(compensation.status, 200);
  assert.equal(compensation.body.revision, oldCorrection.revision + 1);
  assert.deepEqual(
    compensation.body.workspace.data.sourceFacts,
    oldCorrection.workspace.data.sourceFacts,
  );
  assert.deepEqual(
    compensation.body.workspace.data.sourceEvents,
    oldCorrection.workspace.data.sourceEvents,
  );
  for (const id of source.opportunityIds) {
    const before = oldCorrection.workspace.data.opportunities.find((row) => row.id === id);
    const after = compensation.body.workspace.data.opportunities.find((row) => row.id === id);
    assert.equal(after.resumeState, '未知');
    assert.equal(after.stage, '已触达');
    assert.equal(after.readState, before.readState);
  }
  const replayAfter = await api(command, store);
  assert.deepEqual(replayAfter.body.workspace, oldCorrection.workspace);
  assert.equal(replayAfter.body.revision, oldCorrection.revision);
  assert.equal((await store.read()).revision, compensation.body.revision);
  assert.equal((await readdir(store.commits)).length, 3);
});

test('已纠正且无可回退阶段时拒绝无变化新命令，不新增提交或回执', async (t) => {
  let stamp = STAMP;
  const { store, command } = await fixture(t, { storeOptions: { now: () => stamp } });
  const corrected = await api(command, store);
  assert.equal(corrected.status, 200);
  const before = await store.read();
  stamp = '2026-10-08T13:00:00.000Z';
  const noEffect = {
    ...command,
    commandId: 'nothing-to-correct',
    expectedRevision: before.revision,
  };
  const result = await api(noEffect, store);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'WORKSPACE_COMMAND_NO_EFFECT');
  assert.deepEqual(await store.read(), before);
  assert.equal(await store.commandResult(noEffect.commandId), null);
  assert.equal((await readdir(store.commits)).length, 2);
});

test('补偿旧纠错时人工阶段保持，其他可回退的自动阶段同批完成', async (t) => {
  const { store, first, source, command } = await fixture(t, {
    mutate(workspace, source) {
      legacyResumeOnlyCorrection(workspace, source);
      markManualFields(workspace.data, source.opportunityIds[0], ['stage']);
    },
  });
  const result = await api(command, store);
  assert.equal(result.status, 200);
  const previous = first.workspace.data.opportunities[0];
  const protectedJob = result.body.workspace.data.opportunities.find(
    (row) => row.id === previous.id,
  );
  assert.deepEqual(protectedJob, previous);
  const autoJob = result.body.workspace.data.opportunities.find(
    (row) => row.id === source.opportunityIds[1],
  );
  assert.equal(autoJob.resumeState, '未知');
  assert.equal(autoJob.stage, '已触达');
  assert.equal(autoJob.readState, first.workspace.data.opportunities[1].readState);
  assert.equal(
    result.body.workspace.data.sourceApplications
      .filter((row) => source.applicationIds.includes(row.id))
      .every((row) => row.status === 'protected' && row.reason === REASON),
    true,
  );
});

test('简历误判回退保留人工控制的沟通中及更高阶段，只纠正自动字段', async (t) => {
  const { store, first, source, command } = await fixture(t, {
    mutate(workspace, source) {
      markManualFields(workspace.data, source.opportunityIds[0], ['stage']);
      workspace.data.opportunities[1].stage = '面试中';
      const binding = workspace.data.sourceBindings.find(
        (row) => row.kind === 'opportunity' && row.opportunityId === source.opportunityIds[1],
      );
      binding.lastAutoStage = '面试中';
    },
  });
  const corrected = await api(command, store);
  assert.equal(corrected.status, 200);
  for (const id of source.opportunityIds) {
    const previous = first.workspace.data.opportunities.find((row) => row.id === id);
    const current = corrected.body.workspace.data.opportunities.find((row) => row.id === id);
    assert.equal(current.resumeState, '未知');
    assert.equal(current.stage, previous.stage);
    const previousBinding = first.workspace.data.sourceBindings.find(
      (row) => row.kind === 'opportunity' && row.opportunityId === id,
    );
    const currentBinding = corrected.body.workspace.data.sourceBindings.find(
      (row) => row.kind === 'opportunity' && row.opportunityId === id,
    );
    assert.equal(currentBinding.autoFields, previousBinding.autoFields);
    assert.equal(currentBinding.lastAutoStage, previousBinding.lastAutoStage);
  }
});

test('末个目标人工字段改变时整批失败，不产生部分改动或命令回执', async (t) => {
  const { store, first, command } = await fixture(t, {
    mutate(workspace) {
      workspace.data.opportunities[1].resumeState = '对方已接收';
    },
  });
  const result = await api(command, store);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'BOSS_RESUME_CORRECTION_UNSAFE');
  assert.deepEqual(await store.read(), first);
  assert.equal(await store.commandResult(command.commandId), null);
  assert.equal((await readdir(store.commits)).length, 1);
});

test('参数仅允许所选应用 ID 列表，未知字段和非法列表不会被静默忽略', async (t) => {
  const { store, first, command } = await fixture(t);
  for (const payload of [
    { ...command.payload, future: true },
    { ...command.payload, receipt: 'processed' },
    {},
    { applicationIds: [] },
    { applicationIds: [...command.payload.applicationIds, command.payload.applicationIds[0]] },
  ]) {
    const result = await api({ ...command, payload }, store);
    assert.equal([400, 409].includes(result.status), true);
    assert.deepEqual(await store.read(), first);
  }
  const future = await api({ ...command, future: true }, store);
  assert.equal(future.status, 400);
  assert.equal(future.body.code, 'WORKSPACE_INVALID');
});

test('版本变化必须重新审阅，精确 commandId 重试跨重启复用原提交', async (t) => {
  const { root, store, first, command } = await fixture(t);
  const stale = await api({ ...command, commandId: 'stale-review', expectedRevision: 0 }, store);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'WORKSPACE_REVISION_CONFLICT');
  assert.deepEqual(await store.read(), first);
  const corrected = await api(command, store);
  assert.equal(corrected.status, 200);
  const conflicting = await api(
    { ...command, payload: { applicationIds: [command.payload.applicationIds[0]] } },
    store,
  );
  assert.equal(conflicting.body.code, 'COMMAND_ID_CONFLICT');
  await store.close();
  const reopened = new WorkspaceStore(join(root, 'workspace'), { now: () => STAMP });
  t.after(() => reopened.close());
  const replay = await api(command, reopened);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.revision, corrected.body.revision);
  assert.deepEqual(replay.body.workspace, corrected.body.workspace);
  assert.equal((await readdir(reopened.commits)).length, 2);
});

test('并发精确重试经单写者串行，只提交一次', async (t) => {
  const { store, command } = await fixture(t);
  const results = await Promise.all([api(command, store), api(command, store)]);
  assert.equal(
    results.every((result) => result.status === 200 && result.body.revision === 2),
    true,
  );
  assert.deepEqual(
    results.map((result) => result.body.replayed),
    [false, true],
  );
  assert.equal((await readdir(store.commits)).length, 2);
});

test('存在同步 pending 即拒绝纠正，即使冲突列表为空', async (t) => {
  const { store, first, command } = await fixture(t, {
    mutate(workspace) {
      workspace.pending = {
        data: structuredClone(workspace.data),
        remote: structuredClone(workspace.base),
        conflicts: [],
        generation: workspace.generation,
      };
    },
  });
  const result = await api(command, store);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SYNC_CONFLICT');
  assert.deepEqual(await store.read(), first);
});

test('磁盘提交失败保留整个旧工作区，同一命令可精确重试', async (t) => {
  for (const failingStage of ['before_commit_file', 'before_head']) {
    let failOnce = true;
    const { store, first, command } = await fixture(t, {
      storeOptions: {
        beforeCommit(stage, commit) {
          if (
            commit.command.type === 'correct_boss_resume_semantics' &&
            stage === failingStage &&
            failOnce
          ) {
            failOnce = false;
            throw new Error('synthetic disk failure');
          }
        },
      },
    });
    const failure = await api(command, store);
    assert.equal(failure.status, 500);
    assert.equal(failure.body.code, 'WORKSPACE_OPERATION_FAILED');
    assert.deepEqual(await store.read(), first);
    assert.equal(await store.commandResult(command.commandId), null);
    const retried = await api(command, store);
    assert.equal(retried.status, 200);
    assert.equal(
      retried.body.workspace.data.opportunities.every((row) => row.resumeState === '未知'),
      true,
    );
  }
});

test('提交后响应丢失通过原命令返回原结果，不再修改岗位', async (t) => {
  let failOnce = true;
  const { store, command } = await fixture(t, {
    storeOptions: {
      beforeCommit(stage, commit) {
        if (
          stage === 'after_head' &&
          commit.command.type === 'correct_boss_resume_semantics' &&
          failOnce
        ) {
          failOnce = false;
          throw new Error('synthetic response lost');
        }
      },
    },
  });
  assert.equal((await api(command, store)).status, 500);
  assert.equal((await store.read()).revision, 2);
  const replay = await api(command, store);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((await readdir(store.commits)).length, 2);
});

test('纠正前与纠正后的完整备份恢复都保留同事实人工否决，恢复仍是新提交', async (t) => {
  const { store, first, source, command } = await fixture(t);
  const oldBackup = createBackup(first.workspace);
  const corrected = await api(command, store);
  assert.equal(corrected.status, 200);
  const newBackup = createBackup(corrected.body.workspace);
  assert.deepEqual(parseBackup(newBackup).data, corrected.body.workspace.data);
  for (const [index, backup] of [oldBackup, newBackup].entries()) {
    const current = await store.read();
    const restored = await api(
      {
        commandId: `restore-${index}`,
        expectedRevision: current.revision,
        type: 'restore_workspace',
        payload: { backup, mode: 'snapshot' },
      },
      store,
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.body.revision, current.revision + 1);
    assert.deepEqual(restored.body.workspace.base, current.workspace.base);
    for (const id of source.applicationIds)
      assert.equal(
        restored.body.workspace.data.sourceApplications.find((row) => row.id === id).reason,
        'user_rejected_wrong_resume_semantics',
      );
    assert.equal(
      restored.body.workspace.data.opportunities.every((row) => row.resumeState === '未知'),
      true,
    );
  }
});

test('旧备份省略事实时保留删除标记和恢复缺口，不因已有回执补活事实', async (t) => {
  const { root, store, first, source, command } = await fixture(t);
  const inbox = new BossInbox(join(root, 'inbox'));
  const batch = source.batches[0];
  await inbox.enqueue(batch);
  await inbox.acknowledge(batch.batchId, {
    format: 'job-tracker-boss-receipt',
    version: 2,
    batchId: batch.batchId,
    workspaceSourceId: first.workspaceId,
    status: 'processed',
    processedAt: STAMP,
    counts: { added: 0, linked: 0, observed: 1, reviewed: 0, skipped: 0 },
    errorCode: '',
  });
  const corrected = await api(command, store);
  assert.equal(corrected.status, 200);
  const backup = createBackup(first.workspace);
  const appId = source.applicationIds[0],
    factId = backup.workspace.data.sourceApplications.find((row) => row.id === appId).factId;
  backup.workspace.data.sourceApplications = backup.workspace.data.sourceApplications.filter(
    (row) => row.id !== appId,
  );
  backup.workspace.data.sourceFacts = backup.workspace.data.sourceFacts.filter(
    (row) => row.id !== factId,
  );
  backup.workspace.data.sourceEvents = backup.workspace.data.sourceEvents.filter(
    (row) => row.factId !== factId,
  );
  const restored = await api(
    {
      commandId: 'restore-omitted-fact',
      expectedRevision: corrected.body.revision,
      type: 'restore_workspace',
      payload: { backup, mode: 'snapshot' },
    },
    store,
  );
  assert.equal(restored.status, 200);
  const data = restored.body.workspace.data;
  assert.equal(Boolean(data.sourceFacts.find((row) => row.id === factId).deletedAt), true);
  assert.equal(Boolean(data.sourceApplications.find((row) => row.id === appId).deletedAt), true);
  assert.equal(bossReceiptGap(data, batch), 1);
  const refused = await api(
    { ...command, commandId: 'correction-with-gap', expectedRevision: restored.body.revision },
    store,
  );
  assert.equal(refused.body.code, 'BOSS_RESUME_CORRECTION_UNSAFE');
  assert.deepEqual((await store.read()).workspace.data, data);
});

test('处理回执存在也不能代替当前所选事实的存活检查', async (t) => {
  const { root, store, first, source, command } = await fixture(t, {
    mutate(workspace, source) {
      const factId = workspace.data.sourceApplications.find(
        (row) => row.id === source.applicationIds[1],
      ).factId;
      workspace.data.sourceFacts.find((row) => row.id === factId).deletedAt = STAMP;
      for (const event of workspace.data.sourceEvents.filter((row) => row.factId === factId))
        event.deletedAt = STAMP;
      workspace.data.sourceApplications.find((row) => row.factId === factId).deletedAt = STAMP;
    },
  });
  const batch = source.batches[1],
    inbox = new BossInbox(join(root, 'receipted-inbox'));
  await inbox.enqueue(batch);
  await inbox.acknowledge(batch.batchId, {
    format: 'job-tracker-boss-receipt',
    version: 2,
    batchId: batch.batchId,
    workspaceSourceId: first.workspaceId,
    status: 'processed',
    processedAt: STAMP,
    counts: { added: 0, linked: 0, observed: 1, reviewed: 0, skipped: 0 },
    errorCode: '',
  });
  assert.equal(bossReceiptGap(first.workspace.data, batch), 1);
  const result = await api(command, store);
  assert.equal(result.body.code, 'BOSS_RESUME_CORRECTION_UNSAFE');
  assert.deepEqual(await store.read(), first);
});

test('恢复含 pending 的旧备份时两侧保留纠正决定', async (t) => {
  const { store, first, source, command } = await fixture(t);
  const oldBackup = createBackup(first.workspace);
  oldBackup.workspace.pending = {
    data: structuredClone(oldBackup.workspace.data),
    remote: structuredClone(oldBackup.workspace.base),
    conflicts: [],
    generation: oldBackup.workspace.generation,
  };
  const corrected = await api(command, store);
  assert.equal(corrected.status, 200);
  const result = await api(
    {
      commandId: 'restore-old-pending',
      expectedRevision: corrected.body.revision,
      type: 'restore_workspace',
      payload: { backup: oldBackup, mode: 'snapshot' },
    },
    store,
  );
  assert.equal(result.status, 200);
  for (const data of [result.body.workspace.data, result.body.workspace.pending.data]) {
    for (const id of source.applicationIds)
      assert.equal(data.sourceApplications.find((row) => row.id === id).status, 'protected');
    assert.equal(
      data.opportunities.every((row) => row.resumeState === '未知'),
      true,
    );
  }
});

test('旧备份中的明确人工简历值保留，同时错误观察仍维持否决', async (t) => {
  const { store, first, source, command } = await fixture(t);
  const oldBackup = createBackup(first.workspace);
  const manual = oldBackup.workspace.data.opportunities.find(
    (row) => row.id === source.opportunityIds[0],
  );
  manual.resumeState = '被索要';
  markManualFields(oldBackup.workspace.data, manual.id, ['resumeState']);
  const corrected = await api(command, store);
  assert.equal(corrected.status, 200);
  const result = await api(
    {
      commandId: 'restore-explicit-manual',
      expectedRevision: corrected.body.revision,
      type: 'restore_workspace',
      payload: { backup: oldBackup, mode: 'snapshot' },
    },
    store,
  );
  assert.equal(result.status, 200);
  assert.equal(
    result.body.workspace.data.opportunities.find((row) => row.id === manual.id).resumeState,
    '被索要',
  );
  assert.equal(
    result.body.workspace.data.opportunities.find((row) => row.id === source.opportunityIds[1])
      .resumeState,
    '未知',
  );
  assert.equal(
    result.body.workspace.data.sourceApplications
      .filter((row) => source.applicationIds.includes(row.id))
      .every((row) => row.status === 'protected'),
    true,
  );
});
