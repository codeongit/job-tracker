import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBossBatch,
  bossReceiptGap,
  correctBossResumeSemantics,
} from '../dist/boss-integration.js';
import { clone, markManualFields } from '../dist/model.js';
import { createBackup, initialWorkspace, restoreWorkspace } from '../dist/workspace.js';
import {
  correctionBatch,
  correctionFixture,
  CORRECTION_STAMP,
} from './fixtures/boss-resume-correction.mjs';

const REASON = 'user_rejected_wrong_resume_semantics';
function restoreFixture() {
  const fixture = correctionFixture({ jobs: 1, aliases: false });
  const old = { ...initialWorkspace(), data: clone(fixture.data), base: clone(fixture.data) };
  const current = {
    ...initialWorkspace(),
    data: correctBossResumeSemantics(fixture.data, {
      applicationIds: fixture.applicationIds,
      workspaceSourceId: fixture.workspaceSourceId,
      stamp: fixture.stamp,
    }),
    base: clone(fixture.data),
    generation: 4,
    lastSync: CORRECTION_STAMP,
  };
  return { ...fixture, old, current };
}
function application(data, fixture) {
  return data.sourceApplications.find((row) => row.id === fixture.applicationIds[0]);
}
function job(data, fixture) {
  return data.opportunities.find((row) => row.id === fixture.opportunityIds[0]);
}
function binding(data, fixture) {
  return data.sourceBindings.find((row) => row.opportunityId === fixture.opportunityIds[0]);
}

test('merge与snapshot恢复旧已发送备份保留已完成的简历与自动阶段纠正', () => {
  for (const mode of ['merge', 'snapshot']) {
    const fixture = restoreFixture();
    const backup = createBackup(fixture.old);
    const before = clone(fixture.current);
    const restored = restoreWorkspace(fixture.current, backup, mode);
    assert.equal(job(restored.data, fixture).resumeState, '未知', mode);
    assert.equal(application(restored.data, fixture).status, 'protected', mode);
    assert.equal(application(restored.data, fixture).reason, REASON, mode);
    assert.equal(application(restored.data, fixture).updatedAt, fixture.stamp);
    assert.equal(binding(restored.data, fixture).lastAutoResumeState, '未知');
    assert.equal(job(restored.data, fixture).stage, '已触达', mode);
    assert.equal(binding(restored.data, fixture).lastAutoStage, '已触达', mode);
    assert.equal(job(restored.data, fixture).readState, job(fixture.old.data, fixture).readState);
    for (const field of ['autoFields', 'lastAutoReadState'])
      assert.equal(
        binding(restored.data, fixture)[field],
        binding(fixture.old.data, fixture)[field],
      );
    assert.deepEqual(restored.data.sourceFacts, fixture.old.data.sourceFacts);
    assert.deepEqual(restored.data.sourceEvents, fixture.old.data.sourceEvents);
    assert.deepEqual(restored.base, before.base);
    assert.equal(restored.generation, before.generation + 1);
    assert.equal(restored.lastSync, '');
    assert.deepEqual(fixture.current, before);
  }
});

test('旧版仅简历纠错尚未补偿阶段时，恢复不会自行扩大为阶段回退', () => {
  const fixture = restoreFixture();
  job(fixture.current.data, fixture).stage = '沟通中';
  binding(fixture.current.data, fixture).lastAutoStage = '沟通中';
  for (const mode of ['merge', 'snapshot']) {
    const restored = restoreWorkspace(fixture.current, createBackup(fixture.old), mode);
    assert.equal(job(restored.data, fixture).resumeState, '未知');
    assert.equal(application(restored.data, fixture).reason, REASON);
    assert.equal(job(restored.data, fixture).stage, '沟通中');
    assert.equal(binding(restored.data, fixture).lastAutoStage, '沟通中');
  }
});

test('含pending备份恢复的两个本机数据侧保留纠错，远端与冲突双方原样保留', () => {
  const fixture = restoreFixture();
  const old = clone(fixture.old);
  const local = clone(old.data);
  const remote = clone(old.data);
  local.opportunities[0].notes = '合成本机冲突';
  remote.opportunities[0].notes = '合成远端冲突';
  const conflicts = [
    {
      key: `opportunities:${fixture.opportunityIds[0]}`,
      group: 'opportunities',
      id: fixture.opportunityIds[0],
      base: clone(old.data.opportunities[0]),
      local: clone(local.opportunities[0]),
      remote: clone(remote.opportunities[0]),
    },
  ];
  old.pending = { data: local, remote, conflicts, generation: old.generation };
  const backup = createBackup(old);
  const restored = restoreWorkspace(fixture.current, backup, 'snapshot');
  for (const data of [restored.data, restored.pending.data]) {
    assert.equal(application(data, fixture).reason, REASON);
    assert.equal(application(data, fixture).status, 'protected');
    assert.equal(job(data, fixture).resumeState, '未知');
    assert.equal(job(data, fixture).stage, '已触达');
    assert.equal(binding(data, fixture).lastAutoStage, '已触达');
  }
  assert.deepEqual(restored.pending.remote, backup.workspace.pending.remote);
  assert.deepEqual(restored.pending.conflicts, backup.workspace.pending.conflicts);
  assert.equal(restored.pending.generation, fixture.current.generation + 1);
  assert.equal(restored.generation, restored.pending.generation);
  assert.throws(() => restoreWorkspace(fixture.current, backup, 'merge'), /冲突/);
});

test('恢复人工简历或其他字段时保留其值与所有权，否决决定仍不撤销', () => {
  for (const resumeState of ['已发送', '被索要', '对方已接收']) {
    const fixture = restoreFixture();
    const incoming = clone(fixture.old);
    Object.assign(job(incoming.data, fixture), { resumeState, readState: '未读', stage: '面试中' });
    markManualFields(incoming.data, fixture.opportunityIds[0], [
      'resumeState',
      'readState',
      'stage',
    ]);
    const expected = clone(incoming.data);
    for (const mode of ['merge', 'snapshot']) {
      const restored = restoreWorkspace(fixture.current, createBackup(incoming), mode);
      assert.equal(application(restored.data, fixture).reason, REASON);
      for (const field of ['resumeState', 'readState', 'stage'])
        assert.equal(job(restored.data, fixture)[field], job(expected, fixture)[field]);
      assert.deepEqual(binding(restored.data, fixture), binding(expected, fixture));
    }
  }
});

test('恢复人工沟通中与自动较高阶段时，不回退用户选择或后续进展', () => {
  for (const stage of ['沟通中', '面试中']) {
    const fixture = restoreFixture();
    const incoming = clone(fixture.old);
    job(incoming.data, fixture).stage = stage;
    binding(incoming.data, fixture).lastAutoStage = stage;
    if (stage === '沟通中') markManualFields(incoming.data, fixture.opportunityIds[0], ['stage']);
    const previousBinding = clone(binding(incoming.data, fixture));
    for (const mode of ['merge', 'snapshot']) {
      const restored = restoreWorkspace(fixture.current, createBackup(incoming), mode);
      assert.equal(job(restored.data, fixture).resumeState, '未知');
      assert.equal(job(restored.data, fixture).stage, stage);
      assert.equal(binding(restored.data, fixture).lastAutoStage, previousBinding.lastAutoStage);
      assert.equal(binding(restored.data, fixture).autoFields, previousBinding.autoFields);
    }
  }
});

test('恢复真正不同事实的发送支持保留已发送，同旧错误事实人工否决可同时存在', () => {
  const fixture = restoreFixture();
  const incoming = clone(fixture.old);
  const newMessage = correctionBatch(0, { messageId: 'synthetic-independent-send' });
  incoming.data = applyBossBatch(incoming.data, newMessage, {
    workspaceSourceId: fixture.workspaceSourceId,
    stamp: fixture.stamp,
  }).data;
  for (const mode of ['merge', 'snapshot']) {
    const restored = restoreWorkspace(fixture.current, createBackup(incoming), mode);
    assert.equal(application(restored.data, fixture).reason, REASON);
    assert.equal(job(restored.data, fixture).resumeState, '已发送');
    assert.equal(binding(restored.data, fixture).lastAutoResumeState, '已发送');
    assert.equal(job(restored.data, fixture).stage, '沟通中');
    assert.equal(binding(restored.data, fixture).lastAutoStage, '沟通中');
    assert.equal(bossReceiptGap(restored.data, newMessage), 0);
  }
});

test('被删除或被快照省略的来源事实不补造、不复活，恢复缺口仍然存在', () => {
  for (const removal of ['deleted', 'omitted']) {
    const fixture = restoreFixture();
    const incoming = clone(fixture.old);
    const factId = application(incoming.data, fixture).factId;
    for (const group of ['sourceEvents', 'sourceFacts', 'sourceApplications']) {
      const matches = (row) => (group === 'sourceFacts' ? row.id : row.factId) === factId;
      if (removal === 'deleted') {
        for (const row of incoming.data[group].filter(matches)) row.deletedAt = fixture.stamp;
      } else incoming.data[group] = incoming.data[group].filter((row) => !matches(row));
    }
    const restored = restoreWorkspace(fixture.current, createBackup(incoming), 'snapshot');
    assert.equal(
      restored.data.sourceFacts.filter((row) => row.id === factId && !row.deletedAt).length,
      0,
    );
    assert.equal(
      restored.data.sourceApplications.filter((row) => row.factId === factId && !row.deletedAt)
        .length,
      0,
    );
    assert.equal(
      restored.data.sourceEvents.filter((row) => row.factId === factId && !row.deletedAt).length,
      0,
    );
    assert.ok(bossReceiptGap(restored.data, fixture.batches[0]) > 0);
    assert.equal(job(restored.data, fixture).resumeState, '已发送');
  }
});

test('恢复删除目标保留删除标记，不用人工纠错恢复岗位或扩大其他字段变更', () => {
  const fixture = restoreFixture();
  const incoming = clone(fixture.old);
  job(incoming.data, fixture).deletedAt = fixture.stamp;
  const restored = restoreWorkspace(fixture.current, createBackup(incoming), 'snapshot');
  assert.ok(job(restored.data, fixture).deletedAt);
  assert.equal(job(restored.data, fixture).resumeState, '已发送');
  assert.equal(job(restored.data, fixture).stage, job(incoming.data, fixture).stage);
  assert.equal(job(restored.data, fixture).readState, job(incoming.data, fixture).readState);
});
