import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyData,
  getResumeLinkedStatus,
  getSentResumeStatus,
  validateData,
} from '../dist/model.js';
import { applyVerificationChoice, applyTaskChoice } from '../dist/today.js';

const job = (more = {}) => ({
  id: 'synthetic-job',
  company: '合成公司',
  role: '合成岗位',
  platform: 'BOSS',
  stage: '已触达',
  readState: '未读',
  resumeState: '已发送',
  ...more,
});
const operation = { id: 'synthetic-event', date: '2026-09-14', stamp: '2026-09-14T02:00:00.000Z' };

test('BOSS 已发送或已接收联动为已读和沟通中，兼容旧阶段且不修改输入', () => {
  for (const platform of ['BOSS', 'Boss直聘', ' boss 直聘 '])
    for (const resumeState of ['已发送', '对方已接收'])
      for (const stage of ['已触达', '待联系']) {
        const original = job({ platform, resumeState, stage }),
          before = structuredClone(original);
        const linked = getResumeLinkedStatus(original);
        assert.deepEqual(linked, { readState: '已读', stage: '沟通中' });
        assert.deepEqual(original, before);
        assert.deepEqual(getResumeLinkedStatus({ ...original, ...linked }), linked);
      }
});

test('联动保留沟通、面试、Offer及已结束阶段，不把已接收降为已发送', () => {
  for (const stage of ['沟通中', '面试中', 'Offer', '已结束']) {
    assert.deepEqual(getSentResumeStatus(job({ stage, resumeState: '对方已接收' })), {
      resumeState: '对方已接收',
      readState: '已读',
      stage,
    });
  }
});

test('索要简历不视为发送，其他渠道不套用BOSS规则，读取旧数据不自动修正', () => {
  for (const resumeState of ['未知', '被索要', ''])
    assert.deepEqual(getResumeLinkedStatus(job({ resumeState })), {});
  for (const platform of ['内推', '邮件', '猎头', '']) {
    assert.deepEqual(getResumeLinkedStatus(job({ platform })), {});
    assert.deepEqual(getSentResumeStatus(job({ platform, resumeState: '被索要' })), {
      resumeState: '已发送',
    });
  }
  const data = { ...emptyData(), opportunities: [job()] };
  assert.deepEqual(validateData(data), data);
});

test('核实已发送同步三个状态，加入行动和取消行动不提前标记发送', () => {
  const data = { ...emptyData(), opportunities: [job({ resumeState: '被索要' })] };
  const before = structuredClone(data);
  const confirmed = applyVerificationChoice(data, {
    ...operation,
    opportunityId: 'synthetic-job',
    kind: 'resume',
    choice: 'done',
  });
  const updated = confirmed.opportunities[0];
  assert.equal(updated.resumeState, '已发送');
  assert.equal(updated.stage, '沟通中');
  assert.equal(updated.readState, '已读');
  assert.equal(updated.updatedAt, operation.stamp);
  assert.equal(confirmed.activities.length, 1);
  const pending = applyVerificationChoice(data, {
    ...operation,
    opportunityId: 'synthetic-job',
    kind: 'resume',
    choice: 'pending',
  });
  assert.deepEqual(pending.opportunities, data.opportunities);
  const cancelled = applyTaskChoice(pending, {
    ...operation,
    taskId: operation.id,
    choice: 'cancel',
  });
  assert.deepEqual(cancelled.opportunities, data.opportunities);
  assert.deepEqual(data, before);
});

test('完成发送简历行动共用联动，重复完成不重复记录或改写较新状态', () => {
  const data = {
    ...emptyData(),
    opportunities: [job({ resumeState: '被索要' })],
    tasks: [
      { id: 'synthetic-task', opportunityId: 'synthetic-job', text: '发送简历', status: '待办' },
    ],
  };
  const result = applyTaskChoice(data, {
    ...operation,
    taskId: 'synthetic-task',
    choice: 'complete',
  });
  assert.equal(result.opportunities[0].stage, '沟通中');
  assert.equal(result.opportunities[0].readState, '已读');
  assert.equal(result.opportunities[0].resumeState, '已发送');
  assert.equal(result.tasks[0].completedAt, operation.stamp);
  result.opportunities[0].stage = '面试中';
  assert.deepEqual(
    applyTaskChoice(result, { ...operation, taskId: 'synthetic-task', choice: 'complete' }),
    result,
  );
});
