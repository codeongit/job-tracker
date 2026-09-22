import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData } from '../dist/model.js';
import { findCompanyMatches, getFilteredOpportunities } from '../dist/jobs.js';

process.env.TZ = 'Asia/Shanghai';

const DATE = '2026-09-12';
const opportunity = (id, more = {}) => ({
  id,
  company: `合成公司 ${id}`,
  role: '合成岗位',
  stage: '已触达',
  ...more,
});
const ids = (rows) => rows.map(({ opportunity }) => opportunity.id);

test('同公司匹配规范化全半角、空白和英文大小写，同岗位优先且不修改数据', () => {
  const data = emptyData();
  data.opportunities.push(
    opportunity('other-role', { company: 'ACME 科技', role: '产品经理' }),
    opportunity('same-role', {
      company: 'ＡＣＭＥ　科技',
      role: 'Ｐｌａｔｆｏｒｍ　Engineer',
      stage: '沟通中',
    }),
    opportunity('ended', { company: 'acme   科技', role: '测试工程师', stage: '已结束' }),
    opportunity('similar', { company: 'ACME 科技有限公司', role: '平台工程师' }),
    opportunity('deleted', {
      company: 'ACME 科技',
      role: '平台工程师',
      deletedAt: '2026-09-14T01:00:00.000Z',
    }),
  );
  const before = structuredClone(data),
    matches = findCompanyMatches(data, {
      company: '  acme 科技  ',
      role: 'platform engineer',
    });
  assert.deepEqual(ids(matches), ['same-role', 'other-role', 'ended']);
  assert.deepEqual(
    matches.map(({ sameRole }) => sameRole),
    [true, false, false],
  );
  assert.deepEqual(data, before);
});

test('同公司匹配支持排除 ID，空值和包含关系不提示，岗位为空不标重复', () => {
  const data = emptyData();
  data.opportunities.push(
    opportunity('one', { company: '示例公司', role: '工程师' }),
    opportunity('two', { company: '示例公司', role: '产品经理' }),
    opportunity('longer', { company: '示例公司上海分部', role: '工程师' }),
  );
  assert.deepEqual(findCompanyMatches(data), []);
  assert.deepEqual(findCompanyMatches(data, { company: '示例' }), []);
  const matches = findCompanyMatches(data, { company: '示例公司', excludeId: 'one' });
  assert.deepEqual(ids(matches), ['two']);
  assert.equal(matches[0].sameRole, false);
});

test('缺少添加时间的旧岗位保留相对顺序，包含已结束岗位并排除删除记录', () => {
  const data = emptyData();
  data.opportunities.push(
    opportunity('undated'),
    opportunity('ended', { stage: '已结束', appliedAt: DATE }),
    opportunity('deleted', { appliedAt: DATE, deletedAt: '2026-09-12T01:00:00.000Z' }),
    opportunity('active', { appliedAt: DATE }),
  );

  const before = structuredClone(data),
    rows = getFilteredOpportunities(data);
  assert.deepEqual(ids(rows), ['undated', 'ended', 'active']);
  assert.ok(rows.every(({ dailyRecord }) => dailyRecord === null));
  assert.deepEqual(ids(getFilteredOpportunities(data, { stage: '已结束' })), ['ended']);
  assert.deepEqual(data, before);
});

test('全部日期按实际添加时间倒序，编辑不置顶，相同或缺失时间保持稳定且不修改源数据', () => {
  const data = emptyData();
  data.opportunities.push(
    opportunity('legacy', { appliedAt: '2026-09-20' }),
    opportunity('older-edited', {
      createdAt: '2026-09-16T23:00:00.000Z',
      updatedAt: '2026-09-18T01:00:00.000Z',
    }),
    opportunity('invalid', { createdAt: 'invalid' }),
    opportunity('same-time-first', { createdAt: '2026-09-17T08:00:00+08:00' }),
    opportunity('same-time-second', { createdAt: '2026-09-17T00:00:00.000Z' }),
    opportunity('deleted-newest', {
      createdAt: '2026-09-18T03:00:00.000Z',
      deletedAt: '2026-09-18T04:00:00.000Z',
    }),
    opportunity('newest', { createdAt: '2026-09-17T01:00:00.000Z', stage: '已结束' }),
  );
  const before = structuredClone(data),
    expected = [
      'newest',
      'same-time-first',
      'same-time-second',
      'older-edited',
      'legacy',
      'invalid',
    ];
  assert.deepEqual(ids(getFilteredOpportunities(data)), expected);
  assert.deepEqual(
    ids(getFilteredOpportunities(data, { query: '合成公司', stage: '已触达' })),
    expected.slice(1),
  );
  assert.deepEqual(data, before);
});

test('新增岗位追加在数据末尾时，仍排在第一页最前面', () => {
  const data = emptyData();
  for (let day = 1; day <= 11; day++) {
    data.opportunities.push(
      opportunity(`job-${day}`, {
        createdAt: `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
  }
  const rows = getFilteredOpportunities(data);
  assert.deepEqual(
    ids(rows.slice(0, 10)),
    Array.from({ length: 10 }, (_, i) => `job-${11 - i}`),
  );
  assert.deepEqual(ids(rows.slice(10)), ['job-1']);
});

test('关键词匹配公司岗位联系人且忽略大小写，日期和当前阶段取交集', () => {
  const data = emptyData();
  data.opportunities.push(
    opportunity('company', { company: 'Synthetic Studio', appliedAt: DATE }),
    opportunity('role', { role: 'Synthetic Engineer', appliedAt: DATE, stage: '沟通中' }),
    opportunity('contact', { contact: 'Synthetic Recruiter', appliedAt: '2026-09-11' }),
    opportunity('unrelated', { contact: 'Another Recruiter', appliedAt: DATE }),
  );

  assert.deepEqual(ids(getFilteredOpportunities(data, { query: 'SYNTHETIC' })), [
    'company',
    'role',
    'contact',
  ]);
  assert.deepEqual(
    ids(getFilteredOpportunities(data, { query: 'SYNTHETIC', stage: '沟通中', date: DATE })),
    ['role'],
  );
  assert.deepEqual(ids(getFilteredOpportunities(data, { query: 'recruiter', date: DATE })), [
    'unrelated',
  ]);
  assert.deepEqual(getFilteredOpportunities(data, { query: '不存在的合成关键词' }), []);
  assert.deepEqual(getFilteredOpportunities(data, { date: '2026-01-01' }), []);
});

test('日期结果按岗位合并并保留计划优先排序，跨日结果及首次联系去重一致', () => {
  const data = emptyData();
  data.opportunities.push(
    opportunity('ended', {
      company: 'A 合成公司',
      appliedAt: DATE,
      stage: '已结束',
      createdAt: '2026-09-17T00:00:00.000Z',
    }),
    opportunity('busy', {
      company: 'Z 合成公司',
      appliedAt: DATE,
      createdAt: '2026-09-11T00:00:00.000Z',
    }),
    opportunity('undated'),
    opportunity('deleted', { deletedAt: '2026-09-12T01:00:00.000Z' }),
    opportunity('only-deleted-records'),
  );
  data.tasks.push(
    { id: 'pending', opportunityId: 'busy', text: '合成待办', dueAt: DATE, status: '待办' },
    {
      id: 'same-day',
      opportunityId: 'busy',
      text: '合成同日完成',
      dueAt: DATE,
      status: '完成',
      completedAt: '2026-09-12T05:00:00.000Z',
    },
    {
      id: 'cross-day',
      opportunityId: 'busy',
      text: '合成跨日完成',
      dueAt: '2026-09-11',
      status: '完成',
      completedAt: '2026-09-11T16:00:00.000Z',
    },
    {
      id: 'cancelled',
      opportunityId: 'busy',
      text: '合成取消',
      dueAt: '2026-09-11',
      status: '取消',
      completedAt: '2026-09-12T04:00:00.000Z',
    },
    {
      id: 'removed-task',
      opportunityId: 'only-deleted-records',
      text: '合成已删除待办',
      dueAt: DATE,
      status: '待办',
      deletedAt: '2026-09-12T01:00:00.000Z',
    },
  );
  data.activities.push(
    { id: 'communication', opportunityId: 'busy', text: '合成沟通', date: DATE, type: '沟通记录' },
    { id: 'milestone', opportunityId: 'busy', text: '合成首次联系', date: DATE, type: '首次联系' },
    {
      id: 'deleted-parent',
      opportunityId: 'deleted',
      text: '合成沟通',
      date: DATE,
      type: '沟通记录',
    },
    {
      id: 'removed-activity',
      opportunityId: 'only-deleted-records',
      text: '合成已删除沟通',
      date: DATE,
      type: '沟通记录',
      deletedAt: '2026-09-12T01:00:00.000Z',
    },
  );

  const before = structuredClone(data),
    rows = getFilteredOpportunities(data, { date: DATE }),
    busy = rows[0].dailyRecord;
  assert.deepEqual(ids(rows), ['busy', 'ended']);
  assert.equal(busy.firstContact, true);
  assert.deepEqual(
    busy.activities.map(({ id }) => id),
    ['communication'],
  );
  assert.deepEqual(
    busy.plannedTasks.map(({ task }) => task.id),
    ['pending', 'same-day'],
  );
  assert.deepEqual(
    busy.resolvedTasks.map(({ task }) => task.id),
    ['cancelled', 'cross-day'],
  );
  assert.equal(rows[1].dailyRecord.firstContact, true);
  assert.deepEqual(
    getFilteredOpportunities(data, { date: '2026-09-11' })[0]
      .dailyRecord.plannedTasks.map(({ task }) => task.id)
      .sort(),
    ['cancelled', 'cross-day'],
  );
  assert.deepEqual(data, before);
});
