import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGES,
  READ_STATES,
  getOpportunityStatus,
  emptyData,
  clone,
  mergeData,
  validateData,
  parseMarkdown,
  markdownExport,
} from '../dist/model.js';
import { getFilteredOpportunities } from '../dist/jobs.js';
import { validateDrafts } from '../dist/draft-data.js';
import { initialWorkspace, createBackup, parseBackup } from '../dist/workspace.js';
import { createViews } from '../dist/views.js';

const legacyJob = {
  id: 'synthetic-legacy-job',
  company: '合成公司',
  role: '合成工程师',
  stage: '待联系',
  readState: '未知',
  appliedAt: '2026-09-14',
};
const dataset = (job) => ({ ...emptyData(), opportunities: [job] });

test('新建默认未读和已触达，旧值映射不影响其他阶段及已读状态', () => {
  assert.deepEqual(getOpportunityStatus(), { stage: '已触达', readState: '未读' });
  assert.deepEqual(READ_STATES, ['未读', '已读']);
  assert.deepEqual(STAGES, ['已触达', '沟通中', '面试中', 'Offer', '已结束']);
  for (const stage of STAGES) {
    assert.deepEqual(getOpportunityStatus({ stage, readState: '已读' }), {
      stage,
      readState: '已读',
    });
    assert.equal(getOpportunityStatus({ stage, readState: '' }).readState, '未读');
  }
});

test('旧待联系参与已触达的组合筛选和日期查询，展示导出不改写原记录', () => {
  const data = dataset(clone(legacyJob)),
    before = clone(data);
  for (const date of ['', '2026-09-14']) {
    const rows = getFilteredOpportunities(data, { query: '工程师', stage: '已触达', date });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].opportunity.id, legacyJob.id);
    assert.deepEqual(getOpportunityStatus(rows[0].opportunity), {
      stage: '已触达',
      readState: '未读',
    });
  }
  assert.deepEqual(getFilteredOpportunities(data, { stage: '沟通中' }), []);
  assert.match(markdownExport(data), /已触达 \| 未读/);
  assert.deepEqual(validateData(data), before);
  assert.deepEqual(data, before);
});

test('含旧值的同步冲突和草稿可完整备份恢复，映射表单值不破坏原版本比较', () => {
  const base = dataset(clone(legacyJob)),
    local = clone(base),
    remote = clone(base);
  local.opportunities[0].notes = '合成本机修改';
  remote.opportunities[0].notes = '合成远端修改';
  const pending = { ...mergeData(base, local, remote), remote, generation: 0 };
  assert.equal(pending.conflicts.length, 1);
  const workspace = { ...initialWorkspace(), data: local, base, pending };
  const draft = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: '00000000-0000-4000-8000-000000000002',
    kind: 'editor',
    opportunityId: legacyJob.id,
    values: { stage: '待联系', readState: '未知', notes: '合成草稿' },
    original: clone(local.opportunities[0]),
    updatedAt: '2026-09-14T01:00:00.000Z',
  };
  const before = clone({ workspace, draft });
  assert.deepEqual(validateDrafts([draft]), [draft]);
  const restored = parseBackup(JSON.parse(JSON.stringify(createBackup(workspace, [draft]))));
  assert.deepEqual(restored.workspace, workspace);
  assert.deepEqual(restored.drafts, [draft]);
  const formValues = { ...draft.values, ...getOpportunityStatus(draft.values) };
  assert.equal(formValues.stage, '已触达');
  assert.equal(formValues.readState, '未读');
  assert.equal(formValues.notes, '合成草稿');
  assert.deepEqual({ workspace, draft }, before);
  assert.throws(() => validateData(dataset({ ...legacyJob, stage: '不支持的阶段' })), /招聘阶段/);
});

test('Markdown 导入未标明消息状态时默认未读，已读和原始状态照常保留', async () => {
  for (const [status, expected] of [
    ['沟通中', '未读'],
    ['未读', '未读'],
    ['已读,0914接受简历', '已读'],
  ]) {
    const parsed = await parseMarkdown(
      `| 合成公司 | 合成岗位 | | 内推 | 0914 | ${status} |`,
      '2026',
      'synthetic.md',
    );
    assert.equal(parsed.rows[0].opportunity.readState, expected);
    assert.equal(parsed.rows[0].opportunity.rawStatus, status);
  }
});

test('岗位列表与详情显示兼容状态，取消看板后仍按十条分页', () => {
  const data = {
    ...emptyData(),
    opportunities: Array.from({ length: 12 }, (_, i) => ({ ...legacyJob, id: `synthetic-${i}` })),
  };
  const context = {
    state: { data },
    selected: 'synthetic-0',
    page: 0,
    filteredRows: getFilteredOpportunities(data, { stage: '已触达' }),
  };
  const views = createViews(
    () => context,
    () => [],
  );
  const html = views.jobsView();
  assert.equal((html.match(/data-job=/g) || []).length, 10);
  assert.doesNotMatch(html, /看板|data-job-layout|待联系|未知/);
  assert.match(views.detail(), /当前岗位阶段：已触达/);
  assert.match(views.detail(), /消息：未读/);
  context.page = 1;
  assert.equal((views.jobResults().match(/data-job=/g) || []).length, 2);
});
