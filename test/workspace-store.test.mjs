import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialWorkspace, createBackup } from '../dist/workspace.js';
import { WorkspaceStore } from '../scripts/workspace-store.mjs';
import { bindBossAccount } from '../dist/boss-integration.js';

const STAMP = '2026-09-21T12:00:00.000Z';
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-workspace-'));
  const store = new WorkspaceStore(join(root, 'workspace'), { now: () => STAMP, ...options });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.initialize();
  return { root, store };
}
function imported(workspace = initialWorkspace()) {
  return {
    commandId: 'initial-migration',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: '合成迁移' },
  };
}
function changed(current, commandId = 'edit-1') {
  const workspace = structuredClone(current.workspace);
  workspace.generation++;
  workspace.lastSync = STAMP;
  return {
    commandId,
    expectedRevision: current.revision,
    type: 'commit_workspace',
    payload: { workspace, reason: '合成修改' },
  };
}

test('正式工作区以完整不可变提交和HEAD持久化，命令回执跨重启幂等', async (t) => {
  const { root, store } = await fixture(t);
  assert.equal((await store.read()).workspace, null);
  const first = await store.execute(imported());
  const command = changed(first);
  const result = await store.execute(command, { result: { applied: 1 } });
  assert.equal(result.revision, 2);
  assert.equal((await lstat(join(store.root, 'HEAD.json'))).mode & 0o777, 0o600);
  assert.equal((await lstat(store.root)).mode & 0o777, 0o700);
  await store.close();
  const reopened = new WorkspaceStore(join(root, 'workspace'));
  t.after(() => reopened.close());
  const replay = await reopened.execute(command);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, result.revision);
  assert.deepEqual(replay.commandResult, { applied: 1 });
  assert.equal((await readdir(reopened.commits)).length, 2);
  await reopened.close();
});

test('固定业务命令只修改白名单记录，不能借网页编辑伪造来源账本', async (t) => {
  const { store } = await fixture(t);
  const first = await store.execute(imported());
  const edited = await store.execute({
    commandId: 'business-edit-1',
    expectedRevision: first.revision,
    type: 'edit_data',
    payload: {
      changes: [
        {
          group: 'opportunities',
          record: { id: 'job-1', company: '合成公司', role: '合成岗位', stage: '已触达' },
        },
      ],
      releaseFields: [],
      reason: '合成岗位编辑',
    },
  });
  assert.equal(edited.workspace.generation, 1);
  assert.equal(edited.workspace.data.opportunities.length, 1);
  assert.equal(edited.workspace.data.sourceEvents.length, 0);
  await assert.rejects(
    store.execute({
      commandId: 'forged-source-edit',
      expectedRevision: edited.revision,
      type: 'edit_data',
      payload: {
        changes: [{ group: 'sourceEvents', record: { id: 'forged' } }],
        releaseFields: [],
        reason: '',
      },
    }),
    { code: 'WORKSPACE_COMMAND_INVALID' },
  );
  const configured = await store.execute({
    commandId: 'sync-target-1',
    expectedRevision: edited.revision,
    type: 'set_sync_config',
    payload: { config: { owner: 'example', repo: 'private-data', path: 'tracker/data.json' } },
  });
  assert.equal(configured.workspace.config.repo, 'private-data');
  assert.deepEqual(configured.workspace.base, initialWorkspace().base);
});

test('同步确认只接受服务签发且已实际上传的事务，并保留上传期间的新编辑', async (t) => {
  const { store } = await fixture(t);
  const workspace = initialWorkspace(),
    target = structuredClone(workspace.config),
    uploadedJob = {
      id: 'uploaded-job',
      company: '已上传公司',
      role: '已上传岗位',
      stage: '已触达',
    };
  workspace.data.opportunities.push(uploadedJob);
  const migrated = await store.execute(imported(workspace));
  const transaction = await store.prepareSyncTransaction(
    { data: workspace.base, sha: null, missing: true },
    target,
  );

  await assert.rejects(
    store.execute({
      commandId: 'forged-full-sync',
      expectedRevision: migrated.revision,
      type: 'acknowledge_sync',
      payload: { captured: workspace, uploaded: workspace.data },
    }),
    { code: 'WORKSPACE_INVALID' },
  );
  await assert.rejects(
    store.execute({
      commandId: 'forged-token-sync',
      expectedRevision: migrated.revision,
      type: 'acknowledge_sync',
      payload: { syncTransactionId: 'sync-00000000-0000-4000-8000-000000000000' },
    }),
    { code: 'SYNC_TRANSACTION_EXPIRED' },
  );
  await assert.rejects(
    store.execute({
      commandId: 'premature-sync',
      expectedRevision: migrated.revision,
      type: 'acknowledge_sync',
      payload: { syncTransactionId: transaction.syncTransactionId },
    }),
    { code: 'SYNC_TRANSACTION_STATE_INVALID' },
  );
  await assert.rejects(
    store.reserveSyncUpload(transaction.syncTransactionId, workspace.base, null),
    { code: 'SYNC_PLAN_MISMATCH' },
  );

  const planned = await store.reserveSyncUpload(
    transaction.syncTransactionId,
    workspace.data,
    null,
  );
  assert.deepEqual(planned, workspace.data);
  await store.completeSyncUpload(transaction.syncTransactionId);
  const edited = await store.execute({
    commandId: 'edit-during-upload',
    expectedRevision: migrated.revision,
    type: 'edit_data',
    payload: {
      changes: [
        {
          group: 'opportunities',
          record: {
            id: 'later-job',
            company: '稍后公司',
            role: '稍后岗位',
            stage: '已触达',
          },
        },
      ],
      releaseFields: [],
      reason: '上传期间新增',
    },
  });
  const command = {
    commandId: 'confirm-issued-sync',
    expectedRevision: edited.revision,
    type: 'acknowledge_sync',
    payload: { syncTransactionId: transaction.syncTransactionId },
  };
  await assert.rejects(
    store.execute({
      ...command,
      commandId: 'confirm-issued-sync-stale',
      expectedRevision: migrated.revision,
    }),
    { code: 'WORKSPACE_REVISION_CONFLICT' },
  );
  const confirmed = await store.execute(command);
  assert.deepEqual(
    confirmed.workspace.base.opportunities.map((row) => row.id),
    ['uploaded-job'],
  );
  assert.deepEqual(
    confirmed.workspace.data.opportunities.map((row) => row.id),
    ['later-job', 'uploaded-job'],
  );
  assert.equal((await store.execute(command)).replayed, true);
  await assert.rejects(
    store.execute({
      ...command,
      commandId: 'confirm-issued-sync-again',
      expectedRevision: confirmed.revision,
    }),
    { code: 'SYNC_TRANSACTION_REPLAYED' },
  );
});

test('权威服务拒绝把原有远端文件缺失解释为空数据', async (t) => {
  const { store } = await fixture(t),
    workspace = initialWorkspace(),
    job = {
      id: 'remote-missing-job',
      company: '远端保护公司',
      role: '远端保护岗位',
      stage: '已触达',
    };
  workspace.data.opportunities.push(job);
  workspace.base.opportunities.push(structuredClone(job));
  const importedWorkspace = await store.execute(imported(workspace));
  await assert.rejects(
    store.prepareSyncTransaction(
      { data: initialWorkspace().data, sha: null, missing: true },
      workspace.config,
    ),
    { code: 'SYNC_REMOTE_MISSING' },
  );
  const after = await store.read();
  assert.equal(after.revision, importedWorkspace.revision);
  assert.deepEqual(after.workspace.data, workspace.data);
  assert.deepEqual(after.workspace.base, workspace.base);
});

test('云端单方面改变本机BOSS账号归属必须形成身份冲突且不能转移绑定', async (t) => {
  const { store } = await fixture(t),
    workspace = initialWorkspace(),
    account = `boss-geek:${'c'.repeat(64)}`;
  workspace.data = bindBossAccount(workspace.data, account, store.workspaceId, STAMP);
  workspace.base = structuredClone(workspace.data);
  const migrated = await store.execute(imported(workspace)),
    remote = structuredClone(workspace.base);
  remote.sourceBindings[0].workspaceSourceId = '00000000-0000-4000-8000-000000000003';
  const transaction = await store.prepareSyncTransaction(
    { data: remote, sha: 'b'.repeat(40), missing: false },
    workspace.config,
  );
  assert.equal(transaction.conflictCount, 1);
  const staged = await store.execute({
      commandId: 'stage-remote-account-transfer',
      expectedRevision: migrated.revision,
      type: 'stage_sync_conflict',
      payload: {
        syncTransactionId: transaction.syncTransactionId,
        generation: migrated.workspace.generation,
      },
    }),
    binding = staged.workspace.data.sourceBindings[0],
    resolved = await store.execute({
      commandId: 'resolve-remote-account-transfer',
      expectedRevision: staged.revision,
      type: 'resolve_sync_conflict',
      payload: {
        choices: { [`sourceBindings:${binding.id}`]: 'remote' },
        generation: staged.workspace.generation,
      },
    });
  assert.equal(resolved.workspace.data.sourceBindings[0].workspaceSourceId, store.workspaceId);
});

test('上传前重新核对同步目标、基线和写者状态，变化后不触发远端副作用', async (t) => {
  const { store } = await fixture(t),
    workspace = initialWorkspace();
  workspace.data.opportunities.push({
    id: 'sync-context-job',
    company: '同步上下文公司',
    role: '同步上下文岗位',
    stage: '已触达',
  });
  const migrated = await store.execute(imported(workspace)),
    transaction = await store.prepareSyncTransaction(
      { data: workspace.base, sha: null, missing: true },
      workspace.config,
    );
  await store.execute({
    commandId: 'change-target-before-upload',
    expectedRevision: migrated.revision,
    type: 'set_sync_config',
    payload: { config: { owner: 'example', repo: 'other-private', path: 'tracker/data.json' } },
  });
  await assert.rejects(
    store.reserveSyncUpload(transaction.syncTransactionId, workspace.data, null),
    { code: 'SYNC_CONTEXT_CHANGED' },
  );

  // A closed writer must reject before validating or reserving any old plan.
  await store.close();
  await assert.rejects(
    store.reserveSyncUpload(transaction.syncTransactionId, workspace.data, null),
    { code: 'WORKSPACE_WRITER_CLOSED' },
  );
});

test('上传进行中冻结同步上下文但不冻结普通本机业务编辑', async (t) => {
  const { store } = await fixture(t),
    workspace = initialWorkspace();
  workspace.data.opportunities.push({
    id: 'uploading-edit-job',
    company: '上传期间公司',
    role: '上传期间岗位',
    stage: '已触达',
  });
  const migrated = await store.execute(imported(workspace)),
    transaction = await store.prepareSyncTransaction(
      { data: workspace.base, sha: null, missing: true },
      workspace.config,
    );
  await store.reserveSyncUpload(transaction.syncTransactionId, workspace.data, null);
  await assert.rejects(
    store.execute({
      commandId: 'change-target-during-upload',
      expectedRevision: migrated.revision,
      type: 'set_sync_config',
      payload: { config: { owner: 'example', repo: 'busy-target', path: 'tracker/data.json' } },
    }),
    { code: 'SYNC_TRANSACTION_BUSY' },
  );
  const edited = await store.execute({
    commandId: 'ordinary-edit-during-upload',
    expectedRevision: migrated.revision,
    type: 'edit_data',
    payload: {
      changes: [
        {
          group: 'opportunities',
          record: { ...workspace.data.opportunities[0], notes: '上传期间正常编辑' },
        },
      ],
      releaseFields: [],
      reason: '合成上传期间编辑',
    },
  });
  assert.equal(edited.workspace.data.opportunities[0].notes, '上传期间正常编辑');
  await store.completeSyncUpload(transaction.syncTransactionId);
});

test('待处理冲突只阻断相关岗位，独立人工编辑同步重基到冲突候选', async (t) => {
  const { store } = await fixture(t),
    workspace = initialWorkspace(),
    first = { id: 'conflict-job', company: '冲突公司', role: '岗位甲', stage: '已触达' },
    second = { id: 'independent-job', company: '独立公司', role: '岗位乙', stage: '已触达' };
  workspace.base.opportunities = [structuredClone(first), structuredClone(second)];
  workspace.data = structuredClone(workspace.base);
  workspace.data.opportunities[0].notes = '本机修改';
  workspace.generation = 1;
  const migrated = await store.execute(imported(workspace)),
    remote = structuredClone(workspace.base);
  remote.opportunities[0].notes = '云端修改';
  const transaction = await store.prepareSyncTransaction(
      { data: remote, sha: 'a'.repeat(40), missing: false },
      workspace.config,
    ),
    staged = await store.execute({
      commandId: 'stage-job-conflict',
      expectedRevision: migrated.revision,
      type: 'stage_sync_conflict',
      payload: {
        syncTransactionId: transaction.syncTransactionId,
        generation: migrated.workspace.generation,
      },
    }),
    independent = {
      ...staged.workspace.data.opportunities.find((row) => row.id === second.id),
      notes: '冲突期间的独立人工修改',
    },
    edited = await store.execute({
      commandId: 'edit-independent-during-conflict',
      expectedRevision: staged.revision,
      type: 'edit_data',
      payload: {
        changes: [{ group: 'opportunities', record: independent }],
        releaseFields: [],
        reason: '合成独立编辑',
      },
    });
  assert.equal(
    edited.workspace.data.opportunities.find((row) => row.id === second.id).notes,
    '冲突期间的独立人工修改',
  );
  assert.equal(
    edited.workspace.pending.data.opportunities.find((row) => row.id === second.id).notes,
    '冲突期间的独立人工修改',
  );
  assert.equal(edited.workspace.pending.conflicts[0].id, first.id);
  assert.equal(edited.workspace.pending.generation, edited.workspace.generation);

  await assert.rejects(
    store.execute({
      commandId: 'edit-conflicted-job',
      expectedRevision: edited.revision,
      type: 'edit_data',
      payload: {
        changes: [
          {
            group: 'opportunities',
            record: {
              ...edited.workspace.data.opportunities.find((row) => row.id === first.id),
              notes: '不应覆盖冲突',
            },
          },
        ],
        releaseFields: [],
        reason: '合成冲突编辑',
      },
    }),
    { code: 'SYNC_CONFLICT' },
  );
});

test('账号来源冲突不冻结无关岗位人工编辑，后续重基仍保留原冲突', async (t) => {
  const { store } = await fixture(t),
    workspace = initialWorkspace(),
    account = `boss-geek:${'b'.repeat(64)}`;
  workspace.data = bindBossAccount(
    workspace.data,
    account,
    '00000000-0000-4000-8000-000000000001',
    STAMP,
  );
  workspace.data.opportunities.push({
    id: 'unrelated-job',
    company: '无关公司',
    role: '无关岗位',
    stage: '已触达',
  });
  const importedWorkspace = await store.execute(imported(workspace)),
    conflicted = structuredClone(importedWorkspace.workspace),
    localBinding = structuredClone(conflicted.data.sourceBindings[0]),
    remoteBinding = {
      ...structuredClone(localBinding),
      workspaceSourceId: '00000000-0000-4000-8000-000000000002',
    };
  conflicted.pending = {
    data: structuredClone(conflicted.data),
    remote: structuredClone(conflicted.data),
    generation: conflicted.generation,
    conflicts: [
      {
        key: `sourceBindings:${localBinding.id}`,
        group: 'sourceBindings',
        id: localBinding.id,
        base: structuredClone(localBinding),
        local: structuredClone(localBinding),
        remote: remoteBinding,
      },
    ],
  };
  conflicted.pending.remote.sourceBindings[0] = remoteBinding;
  const staged = await store.execute({
      commandId: 'stage-account-conflict',
      expectedRevision: importedWorkspace.revision,
      type: 'commit_workspace',
      payload: { workspace: conflicted, reason: '合成账号来源冲突' },
    }),
    job = {
      ...staged.workspace.data.opportunities[0],
      notes: '冲突期间的无关岗位编辑',
    },
    edited = await store.execute({
      commandId: 'edit-unrelated-during-account-conflict',
      expectedRevision: staged.revision,
      type: 'edit_data',
      payload: {
        changes: [{ group: 'opportunities', record: job }],
        releaseFields: [],
        reason: '合成无关编辑',
      },
    });
  assert.equal(edited.workspace.data.opportunities[0].notes, job.notes);
  assert.equal(edited.workspace.pending.data.opportunities[0].notes, job.notes);
  assert.equal(edited.workspace.pending.conflicts.length, 1);
});

test('不可映射岗位的冲突实体本身仍受保护，解决冲突不会覆盖新编辑', async (t) => {
  const { store } = await fixture(t),
    workspace = initialWorkspace(),
    base = { id: 'import-conflict', filename: 'synthetic.md', year: '2026', rawText: 'base' },
    local = { ...base, rawText: 'local' },
    remote = { ...base, rawText: 'remote' };
  workspace.base.imports = [base];
  workspace.data.imports = [local];
  workspace.generation = 1;
  workspace.pending = {
    data: structuredClone(workspace.data),
    remote: { ...structuredClone(workspace.data), imports: [remote] },
    generation: workspace.generation,
    conflicts: [
      {
        key: `imports:${base.id}`,
        group: 'imports',
        id: base.id,
        base,
        local,
        remote,
      },
    ],
  };
  const staged = await store.execute(imported(workspace));
  await assert.rejects(
    store.execute({
      commandId: 'edit-direct-conflict-entity',
      expectedRevision: staged.revision,
      type: 'edit_data',
      payload: {
        changes: [{ group: 'imports', record: { ...local, rawText: 'new edit' } }],
        releaseFields: [],
        reason: '合成冲突实体编辑',
      },
    }),
    { code: 'SYNC_CONFLICT' },
  );
  assert.equal((await store.read()).workspace.data.imports[0].rawText, 'local');
});

test('已变化的同步基线不能被较早上传事务覆盖', async (t) => {
  const { store } = await fixture(t),
    workspace = initialWorkspace(),
    target = structuredClone(workspace.config);
  workspace.data.opportunities.push({
    id: 'context-job',
    company: '同步上下文公司',
    role: '同步上下文岗位',
    stage: '已触达',
  });
  const migrated = await store.execute(imported(workspace)),
    older = await store.prepareSyncTransaction(
      { data: workspace.base, sha: null, missing: true },
      target,
    );
  await store.reserveSyncUpload(older.syncTransactionId, workspace.data, null);
  await store.completeSyncUpload(older.syncTransactionId);

  const newer = await store.prepareSyncTransaction(
      { data: workspace.data, sha: 'a'.repeat(40), missing: false },
      target,
    ),
    confirmed = await store.execute({
      commandId: 'confirm-newer-sync-context',
      expectedRevision: migrated.revision,
      type: 'acknowledge_sync',
      payload: { syncTransactionId: newer.syncTransactionId },
    });
  await assert.rejects(
    store.execute({
      commandId: 'reject-older-sync-context',
      expectedRevision: confirmed.revision,
      type: 'acknowledge_sync',
      payload: { syncTransactionId: older.syncTransactionId },
    }),
    { code: 'SYNC_CONTEXT_CHANGED' },
  );
  assert.deepEqual((await store.read()).workspace.base, workspace.data);
});

test('CAS拒绝旧编辑，同ID不同请求拒绝，未知格式不能覆盖有效HEAD', async (t) => {
  const { store } = await fixture(t);
  const first = await store.execute(imported());
  await store.execute(changed(first));
  const before = await readFile(join(store.root, 'HEAD.json'));
  await assert.rejects(store.execute(changed(first, 'stale')), {
    code: 'WORKSPACE_REVISION_CONFLICT',
  });
  await assert.rejects(store.execute({ ...changed(first), expectedRevision: 2 }), {
    code: 'COMMAND_ID_CONFLICT',
  });
  const invalid = changed(await store.read(), 'future');
  invalid.payload.workspace.workspaceVersion = 999;
  await assert.rejects(store.execute(invalid), /更新版本/);
  assert.deepEqual(await readFile(join(store.root, 'HEAD.json')), before);
  await assert.rejects(
    store.execute({
      commandId: 'empty',
      expectedRevision: 2,
      type: 'commit_workspace',
      payload: { reason: '' },
    }),
    { code: 'WORKSPACE_COMMAND_INVALID' },
  );
});

test('提交文件落盘后HEAD前中断保留旧版本，重跑可复用同一完整候选提交', async (t) => {
  let failOnce = true;
  const { store } = await fixture(t, {
    beforeCommit: async (stage, commit) => {
      if (stage === 'before_head' && commit.revision === 2 && failOnce) {
        failOnce = false;
        throw new Error('synthetic crash before HEAD');
      }
    },
  });
  const first = await store.execute(imported());
  const command = changed(first);
  await assert.rejects(store.execute(command), /synthetic crash/);
  assert.equal((await store.read()).revision, 1);
  assert.equal((await store.execute(command)).revision, 2);
});

test('HEAD已提交但响应丢失时重试返回原成功结果，不产生第三版', async (t) => {
  let failOnce = true;
  const { store } = await fixture(t, {
    beforeCommit: async (stage, commit) => {
      if (stage === 'after_head' && commit.revision === 2 && failOnce) {
        failOnce = false;
        throw new Error('synthetic response lost');
      }
    },
  });
  const first = await store.execute(imported()),
    command = changed(first);
  await assert.rejects(store.execute(command, { result: { added: 1 } }), /response lost/);
  const replay = await store.execute(command);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 2);
  assert.deepEqual(replay.commandResult, { added: 1 });
});

test('HEAD原子替换后目录同步短暂报错只重试持久化屏障并返回同一提交', async (t) => {
  let syncCalls = 0;
  const { store } = await fixture(t, {
    syncHeadDirectory: async () => {
      if (++syncCalls === 2) throw new Error('synthetic directory fsync failure after rename');
    },
  });
  const first = await store.execute(imported()),
    command = changed(first, 'head-fsync-reconciled'),
    committed = await store.execute(command, { result: { saved: true } });
  assert.equal(committed.revision, 2);
  assert.equal(committed.replayed, false);
  assert.deepEqual(committed.commandResult, { saved: true });
  const replay = await store.execute(command);
  assert.equal(replay.revision, committed.revision);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.commandResult, { saved: true });
  assert.equal((await readdir(store.commits)).length, 2);
  assert.equal(syncCalls, 3);
});

test('HEAD目录持久化持续失败时隔离写者且不把可见rename报告为正式成功', async (t) => {
  let syncCalls = 0;
  const { store } = await fixture(t, {
    syncHeadDirectory: async () => {
      if (++syncCalls >= 2) throw new Error('synthetic persistent directory fsync failure');
    },
  });
  const first = await store.execute(imported()),
    command = changed(first, 'head-fsync-uncertain');
  await assert.rejects(store.execute(command), { code: 'WORKSPACE_DURABILITY_UNCERTAIN' });
  await assert.rejects(store.execute(command), { code: 'WORKSPACE_WRITER_CLOSED' });
  assert.equal((await store.read()).revision, 1);
  assert.equal(syncCalls, 4);
});

test('另一个服务实例不能取得活跃工作区写锁，关闭时只清理自己的锁', async (t) => {
  const { store } = await fixture(t);
  const competing = new WorkspaceStore(store.root);
  await assert.rejects(competing.initialize(), { code: 'WORKSPACE_WRITER_BUSY' });
  await competing.close();
  const owner = JSON.parse(await readFile(join(store.lock, 'owner.json')));
  assert.equal(owner.instanceId, store.instanceId);
});

test('迁移保存原始完整工作区并将已有授权账号归属本机工作区', async (t) => {
  const { store } = await fixture(t);
  const workspace = initialWorkspace(),
    oldSource = '00000000-0000-4000-8000-000000000001';
  workspace.data = bindBossAccount(workspace.data, `boss-geek:${'a'.repeat(64)}`, oldSource, STAMP);
  workspace.base = structuredClone(workspace.data);
  const binding = workspace.data.sourceBindings[0];
  workspace.pending = {
    data: structuredClone(workspace.data),
    remote: structuredClone(workspace.data),
    generation: 0,
    conflicts: [
      {
        key: `sourceBindings:${binding.id}`,
        group: 'sourceBindings',
        id: binding.id,
        base: structuredClone(binding),
        local: structuredClone(binding),
        remote: structuredClone(binding),
      },
    ],
  };
  const result = await store.execute(imported(workspace));
  for (const data of [result.workspace.data, result.workspace.pending.data])
    assert.equal(data.sourceBindings[0].workspaceSourceId, result.workspaceId);
  for (const data of [result.workspace.base, result.workspace.pending.remote])
    assert.equal(data.sourceBindings[0].workspaceSourceId, oldSource);
  assert.equal(result.workspace.pending.conflicts[0].local.workspaceSourceId, result.workspaceId);
  assert.equal(result.workspace.pending.conflicts[0].remote.workspaceSourceId, result.workspaceId);
  assert.equal(result.workspace.pending.conflicts[0].base.workspaceSourceId, oldSource);
  const source = (await readdir(store.root)).find((name) => name.startsWith('migration-source-'));
  assert.equal(
    JSON.parse(await readFile(join(store.root, source))).workspace.data.sourceBindings[0]
      .workspaceSourceId,
    oldSource,
  );
  const resolvedRemote = await store.execute({
    commandId: 'resolve-migrated-account-conflict-remote',
    expectedRevision: result.revision,
    type: 'resolve_sync_conflict',
    payload: {
      choices: { [`sourceBindings:${binding.id}`]: 'remote' },
      generation: result.workspace.generation,
    },
  });
  assert.equal(
    resolvedRemote.workspace.data.sourceBindings[0].workspaceSourceId,
    resolvedRemote.workspaceId,
  );
  assert.equal(resolvedRemote.workspace.base.sourceBindings[0].workspaceSourceId, oldSource);
});

test('首次同步把迁移后的服务账号身份上传，远端旧身份不会回退正式绑定', async (t) => {
  const { store } = await fixture(t),
    workspace = initialWorkspace(),
    oldSource = '00000000-0000-4000-8000-000000000001';
  workspace.data = bindBossAccount(workspace.data, `boss-geek:${'a'.repeat(64)}`, oldSource, STAMP);
  workspace.base = structuredClone(workspace.data);
  const migrated = await store.execute(imported(workspace)),
    transaction = await store.prepareSyncTransaction(
      { data: workspace.base, sha: 'a'.repeat(40), missing: false },
      workspace.config,
    );
  assert.equal(transaction.conflictCount, 0);
  assert.equal(transaction.uploadRequired, true);
  await store.reserveSyncUpload(
    transaction.syncTransactionId,
    migrated.workspace.data,
    'a'.repeat(40),
  );
  await store.completeSyncUpload(transaction.syncTransactionId);
  const confirmed = await store.execute({
    commandId: 'confirm-migrated-account-sync',
    expectedRevision: migrated.revision,
    type: 'acknowledge_sync',
    payload: { syncTransactionId: transaction.syncTransactionId },
  });
  assert.equal(confirmed.workspace.data.sourceBindings[0].workspaceSourceId, confirmed.workspaceId);
  assert.equal(confirmed.workspace.base.sourceBindings[0].workspaceSourceId, confirmed.workspaceId);
});

test('恢复是新本机提交并保持现有同步基线', async (t) => {
  const { store } = await fixture(t);
  const first = await store.execute(imported());
  const modified = await store.execute(changed(first));
  const restored = await store.execute({
    commandId: 'restore-1',
    expectedRevision: 2,
    type: 'restore_workspace',
    payload: { backup: createBackup(first.workspace), mode: 'snapshot' },
  });
  assert.equal(restored.revision, 3);
  assert.deepEqual(restored.workspace.base, modified.workspace.base);
});

test('提交文件被篡改时重新打开停止写入并保留故障文件', async (t) => {
  const { store } = await fixture(t);
  await store.execute(imported());
  const head = JSON.parse(await readFile(join(store.root, 'HEAD.json')));
  await store.close();
  const path = join(store.commits, head.file),
    commit = JSON.parse(await readFile(path));
  commit.workspace.generation = 50;
  await writeFile(path, JSON.stringify(commit));
  const reopened = new WorkspaceStore(store.root);
  await assert.rejects(reopened.initialize(), { code: 'WORKSPACE_CORRUPT' });
  assert.equal(JSON.parse(await readFile(path)).workspace.generation, 50);
});

test('运行期间外部替换HEAD时拒绝覆盖并保留最后已知正式提交', async (t) => {
  const { store } = await fixture(t);
  const first = await store.execute(imported());
  const path = join(store.root, 'HEAD.json'),
    head = JSON.parse(await readFile(path));
  head.hash = '0'.repeat(64);
  await writeFile(path, JSON.stringify(head));
  await assert.rejects(store.execute(changed(first)), { code: 'WORKSPACE_HEAD_CHANGED' });
  assert.equal(JSON.parse(await readFile(path)).hash, head.hash);
  assert.equal((await readdir(store.commits)).length, 1);
});

test('历史幂等索引不常驻完整工作区，旧命令按需校验后返回原结果', async (t) => {
  const { root, store } = await fixture(t);
  const workspace = initialWorkspace();
  workspace.data.opportunities = Array.from({ length: 24 }, (_, i) => ({
    id: 'memory-job-' + i,
    company: 'Synthetic company',
    role: 'Synthetic role',
    stage: '已触达',
    notes: 'SYNTHETIC_MEMORY_PAYLOAD'.repeat(80),
  }));
  const firstCommand = imported(workspace),
    first = await store.execute(firstCommand, { result: { applied: 24 } });
  const second = await store.execute(changed(first, 'memory-edit-1'));
  await store.execute(changed(second, 'memory-edit-2'));
  assert.ok(
    JSON.stringify([...store.commandIndex.values()]).length < 4096,
    '幂等索引应只保留小型定位信息',
  );
  await store.close();
  const reopened = new WorkspaceStore(join(root, 'workspace'));
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.ok(
    JSON.stringify([...reopened.commandIndex.values()]).length < 4096,
    '重启不应将历史快照装入索引',
  );
  const replay = await reopened.execute(firstCommand);
  assert.equal(replay.revision, 1);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.commandResult, { applied: 24 });
  assert.equal(replay.workspace.data.opportunities.length, 24);
  assert.deepEqual(await reopened.commandResult(firstCommand.commandId), {
    revision: 1,
    hash: first.hash,
    result: { applied: 24 },
  });
  const files = await readdir(reopened.commits);
  const file = files.find((f) => f.startsWith('000000000001-'));
  const path = join(reopened.commits, file),
    commit = JSON.parse(await readFile(path, 'utf8'));
  commit.workspace.data.opportunities[0].notes = 'SYNTHETIC_TAMPER';
  await writeFile(path, JSON.stringify(commit));
  await assert.rejects(reopened.execute(firstCommand), { code: 'WORKSPACE_CORRUPT' });
});
