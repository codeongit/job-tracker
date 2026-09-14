import { clone, live, validateData, getSentResumeStatus } from './model.js';

export const SUGGESTION_DEFINITIONS = {
  resume: {
    prompt: '核实简历是否已发送',
    doneLabel: '已发送',
    taskText: '发送简历',
    activityType: '发送简历',
    activityText: '已核实：简历已发送',
  },
  leadership: {
    prompt: '核实是否已答复带人经验',
    doneLabel: '已答复',
    taskText: '答复带人经验问题',
    activityType: '对方回复',
    activityText: '已核实：已答复带人经验问题',
  },
};

function localDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function suggestionMatches(data, opportunity, kind) {
  const definition = SUGGESTION_DEFINITIONS[kind],
    pending = live(data.tasks).some(
      (task) =>
        task.status === '待办' &&
        task.opportunityId === opportunity.id &&
        task.text === definition.taskText,
    ),
    confirmed = live(data.activities).some(
      (activity) =>
        activity.opportunityId === opportunity.id &&
        activity.type === definition.activityType &&
        activity.text === definition.activityText,
    );
  if (pending || confirmed) return false;
  return kind === 'resume'
    ? opportunity.resumeState === '被索要'
    : opportunity.rawStatus?.includes('带人经验');
}

function recordVerification(result, opportunity, kind, { id, date, stamp }) {
  const definition = SUGGESTION_DEFINITIONS[kind];
  if (kind === 'resume')
    Object.assign(opportunity, getSentResumeStatus(opportunity), { updatedAt: stamp });
  const confirmed = live(result.activities).some(
    (activity) =>
      activity.opportunityId === opportunity.id &&
      activity.type === definition.activityType &&
      activity.text === definition.activityText,
  );
  if (!confirmed)
    result.activities.push({
      id,
      opportunityId: opportunity.id,
      date,
      type: definition.activityType,
      text: definition.activityText,
      createdAt: stamp,
    });
}

export function getTodayItems(data, date) {
  const active = live(data.opportunities).filter((opportunity) => opportunity.stage !== '已结束'),
    parentIds = new Set(active.map((opportunity) => opportunity.id)),
    tasks = live(data.tasks)
      .filter((task) => task.status === '待办' && parentIds.has(task.opportunityId))
      .sort((a, b) => (a.dueAt || '9999').localeCompare(b.dueAt || '9999')),
    suggestions = active.flatMap((opportunity) =>
      Object.keys(SUGGESTION_DEFINITIONS)
        .filter((kind) => suggestionMatches(data, opportunity, kind))
        .map((kind) => ({
          kind,
          opportunityId: opportunity.id,
          opportunity,
          ...SUGGESTION_DEFINITIONS[kind],
        })),
    ),
    suggestedIds = new Set(suggestions.map((item) => item.opportunityId)),
    unplanned = active
      .filter(
        (opportunity) =>
          !tasks.some((task) => task.opportunityId === opportunity.id) &&
          !suggestedIds.has(opportunity.id),
      )
      .map((opportunity) => ({
        opportunity,
        addedToday: localDate(opportunity.createdAt) === date,
      }))
      .sort(
        (a, b) =>
          Number(b.addedToday) - Number(a.addedToday) ||
          (b.opportunity.createdAt || '').localeCompare(a.opportunity.createdAt || '') ||
          (b.opportunity.appliedAt || '').localeCompare(a.opportunity.appliedAt || ''),
      );
  return {
    active,
    tasks,
    due: tasks.filter((task) => task.dueAt && task.dueAt <= date),
    upcoming: tasks.filter((task) => task.dueAt > date),
    undated: tasks.filter((task) => !task.dueAt),
    suggestions,
    unplanned,
  };
}

export function applyVerificationChoice(data, { opportunityId, kind, choice, id, date, stamp }) {
  const definition = SUGGESTION_DEFINITIONS[kind];
  if (!definition || !['done', 'pending'].includes(choice)) throw new Error('核实选择无效。');
  const result = clone(data),
    opportunity = live(result.opportunities).find((item) => item.id === opportunityId);
  if (!opportunity || opportunity.stage === '已结束') throw new Error('这个岗位已结束或不存在。');
  if (!suggestionMatches(result, opportunity, kind)) return validateData(result);
  if (choice === 'pending') {
    result.tasks.push({
      id,
      opportunityId,
      text: definition.taskText,
      dueAt: date,
      status: '待办',
      createdAt: stamp,
    });
  } else {
    recordVerification(result, opportunity, kind, { id, date, stamp });
  }
  return validateData(result);
}

export function applyTaskChoice(data, { taskId, choice, id, date, stamp }) {
  if (!['complete', 'cancel'].includes(choice)) throw new Error('行动选择无效。');
  const result = clone(data),
    task = live(result.tasks).find((item) => item.id === taskId && item.status === '待办');
  if (!task) return validateData(result);
  task.status = choice === 'complete' ? '完成' : '取消';
  task.completedAt = stamp;
  if (choice === 'complete') {
    const opportunity = live(result.opportunities).find(
        (item) => item.id === task.opportunityId && item.stage !== '已结束',
      ),
      kind = Object.keys(SUGGESTION_DEFINITIONS).find(
        (candidate) => SUGGESTION_DEFINITIONS[candidate].taskText === task.text,
      );
    if (opportunity && kind) recordVerification(result, opportunity, kind, { id, date, stamp });
  }
  return validateData(result);
}
