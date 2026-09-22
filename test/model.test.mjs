import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyData,
  clone,
  mergeData,
  equal,
  removeOpportunity,
  resolveConflicts,
  validateData,
  parseMarkdown,
  applyImport,
  markdownExport,
} from '../dist/model.js';
const job = (id, more = {}) => ({
  id,
  company: '示例公司',
  role: '开发工程师',
  stage: '已触达',
  ...more,
});
const dataset = (...rows) => ({ ...emptyData(), opportunities: rows });

test('独立岗位修改按 ID 合并，数组顺序不影响等价性', () => {
  const b = dataset(job('a'), job('b')),
    l = clone(b),
    r = clone(b);
  l.opportunities[0].notes = '本机';
  r.opportunities[1].stage = '沟通中';
  r.opportunities.reverse();
  const m = mergeData(b, l, r);
  assert.equal(m.conflicts.length, 0);
  assert.equal(m.data.opportunities[0].notes, '本机');
  assert.equal(m.data.opportunities[1].stage, '沟通中');
  assert.ok(equal(b, dataset(job('b'), job('a'))));
});
test('同一记录并发修改需要选择，双方相同修改不冲突', () => {
  const b = dataset(job('a')),
    l = dataset(job('a', { notes: '本机' })),
    r = dataset(job('a', { notes: '云端' }));
  const m = mergeData(b, l, r);
  assert.equal(m.conflicts.length, 1);
  assert.equal(
    resolveConflicts(m.data, m.conflicts, { 'opportunities:a': 'remote' }).opportunities[0].notes,
    '云端',
  );
  assert.equal(mergeData(b, l, l).conflicts.length, 0);
});
test('同一记录的不同字段自动合并，并保留较新的更新时间', () => {
  const b = dataset(
      job('a', {
        notes: '',
        updatedAt: '2026-09-20T01:00:00.000Z',
      }),
    ),
    l = clone(b),
    r = clone(b);
  l.opportunities[0].notes = '本机备注';
  l.opportunities[0].updatedAt = '2026-09-20T02:00:00.000Z';
  r.opportunities[0].stage = '沟通中';
  r.opportunities[0].updatedAt = '2026-09-20T03:00:00.000Z';
  const m = mergeData(b, l, r);
  assert.equal(m.conflicts.length, 0);
  assert.equal(m.data.opportunities[0].notes, '本机备注');
  assert.equal(m.data.opportunities[0].stage, '沟通中');
  assert.equal(m.data.opportunities[0].updatedAt, '2026-09-20T03:00:00.000Z');
});
test('同字段分歧只核对该字段，选择任一侧都不丢独立修改', () => {
  const b = dataset(job('a', { notes: '', contact: '', updatedAt: '2026-09-20T01:00:00.000Z' })),
    l = clone(b),
    r = clone(b);
  Object.assign(l.opportunities[0], {
    notes: '本机备注',
    contact: '本机补充联系人',
    updatedAt: '2026-09-20T02:00:00.000Z',
  });
  Object.assign(r.opportunities[0], {
    notes: '云端备注',
    stage: '沟通中',
    updatedAt: '2026-09-20T03:00:00.000Z',
  });
  const m = mergeData(b, l, r);
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0].local.contact, '本机补充联系人');
  assert.equal(m.conflicts[0].local.stage, '沟通中');
  assert.equal(m.conflicts[0].remote.contact, '本机补充联系人');
  assert.equal(m.conflicts[0].remote.stage, '沟通中');
  const resolved = resolveConflicts(m.data, m.conflicts, { 'opportunities:a': 'remote' });
  assert.equal(resolved.opportunities[0].notes, '云端备注');
  assert.equal(resolved.opportunities[0].contact, '本机补充联系人');
  assert.equal(resolved.opportunities[0].stage, '沟通中');
});
test('有关联语义的字段作为原子组冲突，不拼出无效的混合状态', () => {
  const base = dataset(
      job('a', {
        platform: 'BOSS',
        url: 'https://www.zhipin.com/job_detail/base.html',
        externalId: 'base',
        resumeState: '未知',
        readState: '未读',
        endReason: '',
      }),
    ),
    local = clone(base),
    remote = clone(base);
  Object.assign(local.opportunities[0], {
    stage: '已结束',
    endReason: '不匹配/拒绝',
    platform: '内推',
  });
  Object.assign(remote.opportunities[0], {
    stage: '面试中',
    url: 'https://example.com/jobs/new',
    externalId: 'new',
  });
  const merged = mergeData(base, local, remote);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].local.stage, '已结束');
  assert.equal(merged.conflicts[0].local.endReason, '不匹配/拒绝');
  assert.equal(merged.conflicts[0].local.platform, '内推');
  assert.equal(merged.conflicts[0].local.url, base.opportunities[0].url);
  assert.equal(merged.conflicts[0].remote.stage, '面试中');
  assert.equal(merged.conflicts[0].remote.endReason, '');
  assert.equal(merged.conflicts[0].remote.platform, 'BOSS');
  assert.equal(merged.conflicts[0].remote.url, 'https://example.com/jobs/new');
});
test('任务完成状态和完成时间保持同一原子组', () => {
  const base = dataset(job('a')),
    local = clone(base),
    remote = clone(base);
  base.tasks.push({ id: 't', opportunityId: 'a', text: '跟进', status: '待办', completedAt: '' });
  local.tasks = clone(base.tasks);
  remote.tasks = clone(base.tasks);
  local.tasks[0].status = '完成';
  local.tasks[0].completedAt = '2026-09-21T08:00:00.000Z';
  remote.tasks[0].status = '取消';
  const merged = mergeData(base, local, remote);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].local.status, '完成');
  assert.equal(merged.conflicts[0].local.completedAt, '2026-09-21T08:00:00.000Z');
  assert.equal(merged.conflicts[0].remote.status, '取消');
  assert.equal(merged.conflicts[0].remote.completedAt, '');
});
test('双方各新增不同 ID 保留；同 ID 新建不同内容冲突', () => {
  const m = mergeData(emptyData(), dataset(job('a')), dataset(job('b')));
  assert.equal(m.data.opportunities.length, 2);
  assert.equal(m.conflicts.length, 0);
  assert.equal(
    mergeData(emptyData(), dataset(job('a')), dataset(job('a', { role: '另一岗位' }))).conflicts
      .length,
    1,
  );
});
test('删除标记保持；删除与编辑冲突', () => {
  const b = dataset(job('a')),
    l = clone(b);
  removeOpportunity(l, 'a');
  assert.ok(mergeData(b, l, b).data.opportunities[0].deletedAt);
  const r = dataset(job('a', { notes: '新的回复' }));
  assert.equal(mergeData(b, l, r).conflicts.length, 1);
});
test('岗位删除与远端新增任务冲突，选删除后关联任务一并留删除标记', () => {
  const b = dataset(job('a')),
    l = clone(b),
    r = clone(b);
  removeOpportunity(l, 'a');
  r.tasks.push({ id: 't', opportunityId: 'a', text: '跟进', status: '待办' });
  const m = mergeData(b, l, r);
  assert.equal(m.conflicts.length, 1);
  const resolved = resolveConflicts(m.data, m.conflicts, { 'opportunities:a': 'local' });
  assert.ok(resolved.tasks[0].deletedAt);
});
test('未知版本、重复 ID、孤立任务被拒绝；未知字段明确拒绝而非丢弃', () => {
  assert.throws(() => validateData({ schemaVersion: 3 }));
  assert.throws(() => validateData(dataset(job('a'), job('a'))));
  const d = dataset(job('a'));
  d.tasks.push({ id: 't', opportunityId: 'missing', text: '跟进', status: '待办' });
  assert.throws(() => validateData(d));
  const valid = dataset(job('a', { token: 'should not export' }));
  assert.throws(() => validateData(valid), /未知字段/);
});
const markdown =
  '| 公司 | 岗位 | 链接 | 渠道 | 日期 | 状态 |\n| --- | --- | --- | --- | --- | --- |\n| 示例<br> | 工程师 | [链接](https://example.com/job) | BOSS | 0908 | 沟通中,0908接受简历，0909问学历，0910催了一次 |\n| 另一公司 | Agent工程师 | | 内推 | 0910 | 要了简历 |';
test('Markdown 拆分事件且不推断未标注日期，不把索要当成发送', async () => {
  const p = await parseMarkdown(markdown, '2026', 'fixture.md');
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].opportunity.company, '示例');
  assert.equal(p.rows[0].opportunity.appliedAt, '2026-09-08');
  assert.equal(p.rows[0].activities.find((a) => a.text === '问学历').date, '2026-09-09');
  assert.equal(p.rows[1].opportunity.resumeState, '被索要');
  assert.equal(p.rows[1].activities.find((a) => a.text === '要了简历').date, '');
});
test('重复导入不覆盖后续编辑，疑似反填只在显式选中时交换', async () => {
  const p = await parseMarkdown(markdown);
  const ids = p.rows.map((r) => r.opportunity.id);
  let a = applyImport(emptyData(), p, ids);
  a.data.opportunities[0].notes = '新信息';
  const b = applyImport(a.data, p, ids);
  assert.equal(b.added, 0);
  assert.equal(b.data.opportunities[0].notes, '新信息');
  assert.equal(b.data.activities.length, a.data.activities.length);
  const swapped = applyImport(emptyData(), p, [ids[0]], [ids[0]]);
  assert.equal(swapped.data.opportunities[0].company, '工程师');
  assert.match(markdownExport(a.data), /2026-09-09/);
});
test('非法日期和年份不会被悄悄导入', async () => {
  await assert.rejects(() => parseMarkdown(markdown, '0'));
  await assert.rejects(() => parseMarkdown(markdown.replace('0908', '0230'), '2026'));
});
