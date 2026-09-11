import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData, clone } from '../dist/model.js';
import { applyTaskChoice, applyVerificationChoice, getTodayItems } from '../dist/today.js';

process.env.TZ = 'Asia/Shanghai';

const DATE = '2026-09-11';
const STAMP = '2026-09-11T02:00:00.000Z';
const opportunity = (id, more = {}) => ({
  id,
  company: `合成公司 ${id}`,
  role: '合成岗位',
  stage: '已触达',
  resumeState: '未知',
  ...more,
});
const task = (id, opportunityId, more = {}) => ({
  id,
  opportunityId,
  text: `合成行动 ${id}`,
  dueAt: '',
  status: '待办',
  createdAt: STAMP,
  ...more,
});
const activity = (id, opportunityId, more = {}) => ({
  id,
  opportunityId,
  date: DATE,
  type: '沟通记录',
  text: `合成记录 ${id}`,
  createdAt: STAMP,
  ...more,
});
const dataset = ({ opportunities = [], tasks = [], activities = [] } = {}) => ({
  ...emptyData(),
  opportunities,
  tasks,
  activities,
});
const suggestionKey = (row) => `${row.opportunityId || row.opportunity?.id || row.id}:${row.kind}`;

test('今日行动只纳入进行中岗位的待办，并按日期分组和排序', () => {
  const data = dataset({
    opportunities: [
      opportunity('active'),
      opportunity('ended', { stage: '已结束' }),
      { ...opportunity('deleted'), deletedAt: STAMP },
    ],
    tasks: [
      task('undated', 'active'),
      task('future', 'active', { dueAt: '2026-09-12' }),
      task('today', 'active', { dueAt: DATE }),
      task('overdue', 'active', { dueAt: '2026-09-10' }),
      task('complete', 'active', { dueAt: DATE, status: '完成' }),
      task('ended-parent', 'ended', { dueAt: DATE }),
      task('deleted-parent', 'deleted', { dueAt: DATE }),
      { ...task('deleted-task', 'active', { dueAt: DATE }), deletedAt: STAMP },
    ],
  });

  const items = getTodayItems(data, DATE);

  assert.deepEqual(
    items.tasks.map((row) => row.id),
    ['overdue', 'today', 'future', 'undated'],
  );
  assert.deepEqual(
    items.due.map((row) => row.id),
    ['overdue', 'today'],
  );
  assert.deepEqual(
    items.upcoming.map((row) => row.id),
    ['future'],
  );
  assert.deepEqual(
    items.undated.map((row) => row.id),
    ['undated'],
  );
});

test('两类建议按岗位分别展开，普通待办不会误伤建议', () => {
  const data = dataset({
    opportunities: [
      opportunity('resume', { resumeState: '被索要' }),
      opportunity('leadership', { rawStatus: '已读，询问带人经验' }),
      opportunity('both', { resumeState: '被索要', rawStatus: '沟通中，问带人经验' }),
      opportunity('ended', {
        stage: '已结束',
        resumeState: '被索要',
        rawStatus: '问带人经验',
      }),
    ],
    tasks: [task('unrelated', 'resume', { text: '整理作品集' })],
  });

  const items = getTodayItems(data, DATE);

  assert.deepEqual(items.suggestions.map(suggestionKey).sort(), [
    'both:leadership',
    'both:resume',
    'leadership:leadership',
    'resume:resume',
  ]);
  assert.ok(
    !items.unplanned.some((row) => ['both', 'leadership', 'resume'].includes(row.opportunity.id)),
  );
});

test('对应的待办和确认结果只排除同类建议', () => {
  const source = dataset({
    opportunities: [opportunity('both', { resumeState: '被索要', rawStatus: '询问带人经验' })],
  });
  const resumePending = applyVerificationChoice(source, {
    opportunityId: 'both',
    kind: 'resume',
    choice: 'pending',
    id: 'resume-task',
    date: DATE,
    stamp: STAMP,
  });
  assert.deepEqual(getTodayItems(resumePending, DATE).suggestions.map(suggestionKey), [
    'both:leadership',
  ]);

  const leadershipDone = applyVerificationChoice(source, {
    opportunityId: 'both',
    kind: 'leadership',
    choice: 'done',
    id: 'leadership-confirmation',
    date: DATE,
    stamp: STAMP,
  });
  assert.deepEqual(getTodayItems(leadershipDone, DATE).suggestions.map(suggestionKey), [
    'both:resume',
  ]);
});

test('核实简历已完成会更新状态且不修改输入', () => {
  const source = dataset({
    opportunities: [opportunity('resume', { resumeState: '被索要' })],
  });
  const before = clone(source);
  const changed = applyVerificationChoice(source, {
    opportunityId: 'resume',
    kind: 'resume',
    choice: 'done',
    id: 'resume-confirmation',
    date: DATE,
    stamp: STAMP,
  });

  assert.deepEqual(source, before);
  assert.equal(changed.opportunities[0].resumeState, '已发送');
  assert.ok(
    !getTodayItems(changed, DATE).suggestions.some((row) => suggestionKey(row) === 'resume:resume'),
  );
});

test('核实带人经验已完成写确认活动，重复操作不产生副本', () => {
  const source = dataset({
    opportunities: [opportunity('leadership', { rawStatus: '询问带人经验' })],
    activities: [activity('existing', 'leadership')],
  });
  const changed = applyVerificationChoice(source, {
    opportunityId: 'leadership',
    kind: 'leadership',
    choice: 'done',
    id: 'leadership-confirmation',
    date: DATE,
    stamp: STAMP,
  });
  const repeated = applyVerificationChoice(changed, {
    opportunityId: 'leadership',
    kind: 'leadership',
    choice: 'done',
    id: 'another-confirmation-id',
    date: DATE,
    stamp: '2026-09-11T03:00:00.000Z',
  });

  assert.equal(changed.activities.length, 2);
  assert.equal(changed.activities.at(-1).id, 'leadership-confirmation');
  assert.equal(changed.activities.at(-1).opportunityId, 'leadership');
  assert.equal(changed.activities.at(-1).date, DATE);
  assert.equal(repeated.activities.length, 2);
  assert.ok(
    !getTodayItems(repeated, DATE).suggestions.some(
      (row) => suggestionKey(row) === 'leadership:leadership',
    ),
  );
});

test('稍后核实建立今日固定待办，重复操作保持幂等', () => {
  const source = dataset({
    opportunities: [opportunity('resume', { resumeState: '被索要' })],
  });
  const changed = applyVerificationChoice(source, {
    opportunityId: 'resume',
    kind: 'resume',
    choice: 'pending',
    id: 'resume-task',
    date: DATE,
    stamp: STAMP,
  });
  const repeated = applyVerificationChoice(changed, {
    opportunityId: 'resume',
    kind: 'resume',
    choice: 'pending',
    id: 'another-task-id',
    date: DATE,
    stamp: '2026-09-11T03:00:00.000Z',
  });

  assert.equal(changed.tasks.length, 1);
  assert.deepEqual(changed.tasks[0], {
    id: 'resume-task',
    opportunityId: 'resume',
    text: '发送简历',
    dueAt: DATE,
    status: '待办',
    createdAt: STAMP,
  });
  assert.equal(repeated.tasks.length, 1);
  assert.ok(
    !getTodayItems(repeated, DATE).suggestions.some(
      (row) => suggestionKey(row) === 'resume:resume',
    ),
  );
});

test('核实建议只接受第一个选择，跨页面旧按钮不会提交相反结果', () => {
  const source = dataset({
      opportunities: [opportunity('resume', { resumeState: '被索要' })],
    }),
    done = applyVerificationChoice(source, {
      opportunityId: 'resume',
      kind: 'resume',
      choice: 'done',
      id: 'confirmation',
      date: DATE,
      stamp: STAMP,
    }),
    stalePending = applyVerificationChoice(done, {
      opportunityId: 'resume',
      kind: 'resume',
      choice: 'pending',
      id: 'stale-task',
      date: DATE,
      stamp: '2026-09-11T03:00:00.000Z',
    }),
    pending = applyVerificationChoice(source, {
      opportunityId: 'resume',
      kind: 'resume',
      choice: 'pending',
      id: 'task',
      date: DATE,
      stamp: STAMP,
    }),
    staleDone = applyVerificationChoice(pending, {
      opportunityId: 'resume',
      kind: 'resume',
      choice: 'done',
      id: 'stale-confirmation',
      date: DATE,
      stamp: '2026-09-11T03:00:00.000Z',
    });

  assert.deepEqual(stalePending, done);
  assert.deepEqual(staleDone, pending);
  assert.deepEqual(
    applyVerificationChoice(done, {
      opportunityId: 'resume',
      kind: 'resume',
      choice: 'done',
      id: 'repeated',
      date: DATE,
      stamp: '2026-09-11T04:00:00.000Z',
    }),
    done,
  );
});

test('核实待办完成后保存核实结果，建议不会再次出现', () => {
  const source = dataset({
      opportunities: [
        opportunity('resume', { resumeState: '被索要' }),
        opportunity('leadership', { rawStatus: '询问带人经验' }),
      ],
    }),
    resumePending = applyVerificationChoice(source, {
      opportunityId: 'resume',
      kind: 'resume',
      choice: 'pending',
      id: 'resume-task',
      date: DATE,
      stamp: STAMP,
    }),
    resumeDone = applyTaskChoice(resumePending, {
      taskId: 'resume-task',
      choice: 'complete',
      id: 'resume-confirmation',
      date: DATE,
      stamp: '2026-09-11T03:00:00.000Z',
    }),
    leadershipPending = applyVerificationChoice(source, {
      opportunityId: 'leadership',
      kind: 'leadership',
      choice: 'pending',
      id: 'leadership-task',
      date: DATE,
      stamp: STAMP,
    }),
    leadershipDone = applyTaskChoice(leadershipPending, {
      taskId: 'leadership-task',
      choice: 'complete',
      id: 'leadership-confirmation',
      date: DATE,
      stamp: '2026-09-11T03:00:00.000Z',
    });

  assert.equal(resumeDone.opportunities[0].resumeState, '已发送');
  assert.equal(resumeDone.tasks[0].status, '完成');
  assert.equal(resumeDone.activities.at(-1).text, '已核实：简历已发送');
  assert.ok(!getTodayItems(resumeDone, DATE).suggestions.some((row) => row.kind === 'resume'));
  assert.equal(leadershipDone.tasks[0].status, '完成');
  assert.equal(leadershipDone.activities.at(-1).text, '已核实：已答复带人经验问题');
  assert.ok(
    !getTodayItems(leadershipDone, DATE).suggestions.some((row) => row.kind === 'leadership'),
  );
});

test('未设下一步排除建议和现有待办，今日新增按北京时间优先', () => {
  const data = dataset({
    opportunities: [
      opportunity('older', { createdAt: '2026-09-10T15:59:59.000Z' }),
      opportunity('today-shanghai', { createdAt: '2026-09-10T16:30:00.000Z' }),
      opportunity('suggested', {
        createdAt: STAMP,
        resumeState: '被索要',
      }),
      opportunity('has-task', { createdAt: STAMP }),
      opportunity('completed-only', { createdAt: STAMP }),
      opportunity('ended', { stage: '已结束', createdAt: STAMP }),
    ],
    tasks: [task('pending', 'has-task'), task('complete', 'completed-only', { status: '完成' })],
  });

  const items = getTodayItems(data, DATE, new Date('2026-09-11T04:00:00+08:00'));

  assert.deepEqual(
    items.unplanned.map((row) => row.opportunity.id),
    ['completed-only', 'today-shanghai', 'older'],
  );
  assert.deepEqual(
    items.unplanned.map((row) => row.addedToday),
    [true, true, false],
  );
});
