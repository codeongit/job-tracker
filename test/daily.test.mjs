import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData } from '../dist/model.js';
import { getDailyRecords, localDateFromTimestamp } from '../dist/daily.js';

process.env.TZ = 'Asia/Shanghai';

const DATE = '2026-09-12';
const opportunity = (id, more = {}) => ({
  id,
  company: `合成公司 ${id}`,
  role: '合成岗位',
  stage: '已触达',
  ...more,
});
const task = (id, opportunityId, more = {}) => ({
  id,
  opportunityId,
  text: `合成行动 ${id}`,
  dueAt: DATE,
  status: '待办',
  createdAt: '2026-09-10T02:00:00.000Z',
  ...more,
});

test('行动分别出现在计划日和实际完成日，同日完成时不重复', () => {
  const data = emptyData();
  data.opportunities.push(opportunity('job'));
  data.tasks.push(
    task('pending', 'job'),
    task('same-day', 'job', {
      status: '完成',
      completedAt: '2026-09-12T04:00:00.000Z',
    }),
    task('finished-later', 'job', {
      dueAt: '2026-09-10',
      status: '完成',
      completedAt: '2026-09-12T05:00:00.000Z',
    }),
    task('cancelled-later', 'job', {
      dueAt: '2026-09-11',
      status: '取消',
      completedAt: '2026-09-12T06:00:00.000Z',
    }),
  );

  const onPlanDate = getDailyRecords(data, '2026-09-10'),
    onResultDate = getDailyRecords(data, DATE);

  assert.deepEqual(
    onPlanDate.plannedTasks.map(({ task }) => task.id),
    ['finished-later'],
  );
  assert.deepEqual(
    onResultDate.plannedTasks.map(({ task }) => task.id),
    ['pending', 'same-day'],
  );
  assert.deepEqual(
    onResultDate.resolvedTasks.map(({ task }) => task.id),
    ['cancelled-later', 'finished-later'],
  );
  assert.ok(!onResultDate.resolvedTasks.some(({ task }) => task.id === 'same-day'));
  assert.equal(onResultDate.opportunityRecords.length, 1);
  assert.deepEqual(
    onResultDate.opportunityRecords[0].plannedTasks.map(({ task }) => task.id),
    ['pending', 'same-day'],
  );
  assert.deepEqual(
    onResultDate.opportunityRecords[0].resolvedTasks.map(({ task }) => task.id),
    ['cancelled-later', 'finished-later'],
  );
});

test('按沟通日和首次联系日筛选，去重导入里程碑并排除删除记录', () => {
  const data = emptyData();
  data.opportunities.push(
    opportunity('active', { appliedAt: DATE }),
    opportunity('ended', { appliedAt: DATE, stage: '已结束' }),
    opportunity('other-day', { appliedAt: '2026-09-11' }),
    { ...opportunity('deleted', { appliedAt: DATE }), deletedAt: '2026-09-12T01:00:00.000Z' },
  );
  data.activities.push(
    {
      id: 'matching-activity',
      opportunityId: 'active',
      text: '当天沟通',
      date: DATE,
      type: '沟通记录',
    },
    {
      id: 'imported-first-contact',
      opportunityId: 'active',
      text: '首次联系（原表投递日期）',
      date: DATE,
      type: '首次联系',
    },
    {
      id: 'other-activity',
      opportunityId: 'active',
      text: '其他日期沟通',
      date: '2026-09-11',
      type: '沟通记录',
    },
    {
      id: 'deleted-parent-activity',
      opportunityId: 'deleted',
      text: '已删除岗位沟通',
      date: DATE,
      type: '沟通记录',
    },
  );
  data.tasks.push({
    ...task('deleted-task', 'active'),
    deletedAt: '2026-09-12T01:00:00.000Z',
  });

  const records = getDailyRecords(data, DATE);

  assert.deepEqual(
    records.activities.map(({ activity }) => activity.id),
    ['matching-activity'],
  );
  assert.deepEqual(records.firstContacts.map(({ id }) => id).sort(), ['active', 'ended']);
  assert.deepEqual(records.plannedTasks, []);
  assert.deepEqual(records.opportunityRecords.map(({ opportunity }) => opportunity.id).sort(), [
    'active',
    'ended',
  ]);
  assert.equal(
    records.opportunityRecords.find(({ opportunity }) => opportunity.id === 'active')?.firstContact,
    true,
  );
  assert.equal(
    records.opportunityRecords.find(({ opportunity }) => opportunity.id === 'active')?.activities
      .length,
    1,
  );
});

test('完成时间按浏览器本地日期换算，非法或缺失时间不进入每日记录', () => {
  assert.equal(localDateFromTimestamp('2026-09-11T15:59:59.000Z'), '2026-09-11');
  assert.equal(localDateFromTimestamp('2026-09-11T16:00:00.000Z'), '2026-09-12');
  assert.equal(localDateFromTimestamp(''), '');
  assert.equal(localDateFromTimestamp('not-a-date'), '');
});
