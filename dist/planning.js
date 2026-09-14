export const DEFAULT_DUE_OFFSET = 2;

export const DUE_DATE_PRESETS = [
  { label: '今天', days: 0 },
  { label: '明天', days: 1 },
  { label: '2天后', days: 2 },
  { label: '1周后', days: 7 },
];

export function addCalendarDays(baseDate, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(baseDate);
  if (!match || !Number.isInteger(days)) throw new Error('计划日期无效。');
  const [, year, month, day] = match,
    date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  )
    throw new Error('计划日期无效。');
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function suggestedTaskText(opportunity, activities = [], pendingTasks = [], date = '') {
  if (
    !opportunity ||
    opportunity.stage === '已结束' ||
    opportunity.priority === '暂缓' ||
    pendingTasks.length
  )
    return '';
  if (opportunity.stage === 'Offer') return '确认 Offer 细节';
  if (opportunity.stage === '面试中') {
    const interviews = activities.filter((activity) => activity.type === '面试' && activity.date);
    if (interviews.some((activity) => activity.date > date)) return '准备面试';
    if (interviews.some((activity) => activity.date <= date)) return '跟进面试结果';
    return '确认面试安排';
  }
  if (['已发送', '对方已接收'].includes(opportunity.resumeState)) return '询问面试安排';
  if (opportunity.resumeState === '被索要') return '发送简历';
  return '跟进岗位进展';
}

export function getTaskDefaults(opportunity, activities, pendingTasks, date) {
  const text = suggestedTaskText(opportunity, activities, pendingTasks, date);
  return {
    text,
    dueAt: text ? addCalendarDays(date, DEFAULT_DUE_OFFSET) : '',
  };
}
