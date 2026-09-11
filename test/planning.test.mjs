import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DUE_OFFSET,
  DUE_DATE_PRESETS,
  addCalendarDays,
  getTaskDefaults,
  suggestedTaskText,
} from '../dist/planning.js';

const opportunity = (more = {}) => ({
  id: 'synthetic-job',
  company: '合成公司',
  role: '合成岗位',
  stage: '已触达',
  priority: '普通',
  resumeState: '未知',
  ...more,
});

test('计划日期按日历日计算，正确跨月、跨年和闰日', () => {
  assert.equal(addCalendarDays('2026-09-29', 2), '2026-10-01');
  assert.equal(addCalendarDays('2026-12-30', 2), '2027-01-01');
  assert.equal(addCalendarDays('2028-02-28', 2), '2028-03-01');
  assert.equal(addCalendarDays('2027-02-28', 2), '2027-03-02');
  assert.equal(addCalendarDays('2026-09-11', 0), '2026-09-11');
  assert.equal(addCalendarDays('2026-09-11', 7), '2026-09-18');
  assert.throws(() => addCalendarDays('2026-02-30', 2), /日期无效/);
});

test('日期快捷项包含今天、明天、2天后和1周后，默认是2天后', () => {
  assert.deepEqual(DUE_DATE_PRESETS, [
    { label: '今天', days: 0 },
    { label: '明天', days: 1 },
    { label: '2天后', days: 2 },
    { label: '1周后', days: 7 },
  ]);
  assert.equal(DEFAULT_DUE_OFFSET, 2);
});

test('简历已发送或对方已接收时建议询问面试安排', () => {
  for (const resumeState of ['已发送', '对方已接收'])
    assert.equal(
      suggestedTaskText(opportunity({ resumeState }), [], [], '2026-09-11'),
      '询问面试安排',
    );
  assert.deepEqual(getTaskDefaults(opportunity({ resumeState: '已发送' }), [], [], '2026-09-11'), {
    text: '询问面试安排',
    dueAt: '2026-09-13',
  });
});

test('阶段优先于简历状态，面试记录区分准备和结果跟进', () => {
  assert.equal(
    suggestedTaskText(opportunity({ stage: 'Offer', resumeState: '被索要' }), [], [], '2026-09-11'),
    '确认 Offer 细节',
  );
  assert.equal(
    suggestedTaskText(
      opportunity({ stage: '面试中', resumeState: '已发送' }),
      [{ type: '面试', date: '2026-09-12' }],
      [],
      '2026-09-11',
    ),
    '准备面试',
  );
  assert.equal(
    suggestedTaskText(
      opportunity({ stage: '面试中' }),
      [{ type: '面试', date: '2026-09-10' }],
      [],
      '2026-09-11',
    ),
    '跟进面试结果',
  );
  assert.equal(
    suggestedTaskText(opportunity({ stage: '面试中' }), [], [], '2026-09-11'),
    '确认面试安排',
  );
});

test('简历被索要、待联系及普通跟进使用明确结构化状态', () => {
  assert.equal(
    suggestedTaskText(opportunity({ resumeState: '被索要' }), [], [], '2026-09-11'),
    '发送简历',
  );
  assert.equal(
    suggestedTaskText(opportunity({ stage: '待联系' }), [], [], '2026-09-11'),
    '联系招聘方',
  );
  assert.equal(suggestedTaskText(opportunity(), [], [], '2026-09-11'), '跟进岗位进展');
});

test('已有待办、已结束或暂缓时不自动预填', () => {
  const pending = [{ id: 'task', status: '待办', text: '合成行动' }];
  assert.deepEqual(
    getTaskDefaults(opportunity({ resumeState: '已发送' }), [], pending, '2026-09-11'),
    { text: '', dueAt: '' },
  );
  assert.equal(suggestedTaskText(opportunity({ stage: '已结束' }), [], [], '2026-09-11'), '');
  assert.equal(suggestedTaskText(opportunity({ priority: '暂缓' }), [], [], '2026-09-11'), '');
});
