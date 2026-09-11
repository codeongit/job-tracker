import { live } from './model.js';

export function localDateFromTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const taskStatusOrder = { 待办: 0, 完成: 1, 取消: 2 };

function linkedRows(rows, opportunities, name) {
  return rows.flatMap((record) => {
    const opportunity = opportunities.get(record.opportunityId);
    return opportunity ? [{ [name]: record, opportunity }] : [];
  });
}

function compareTaskRows(a, b) {
  return (
    (taskStatusOrder[a.task.status] ?? 9) - (taskStatusOrder[b.task.status] ?? 9) ||
    a.opportunity.company.localeCompare(b.opportunity.company, 'zh-CN') ||
    (b.task.createdAt || '').localeCompare(a.task.createdAt || '') ||
    a.task.id.localeCompare(b.task.id)
  );
}

function resolutionDate(task) {
  return ['完成', '取消'].includes(task.status) ? localDateFromTimestamp(task.completedAt) : '';
}

export function getDailyRecords(data, date) {
  const opportunities = live(data.opportunities),
    opportunityMap = new Map(opportunities.map((opportunity) => [opportunity.id, opportunity])),
    taskRows = linkedRows(live(data.tasks), opportunityMap, 'task'),
    activityRows = linkedRows(live(data.activities), opportunityMap, 'activity');

  const plannedTasks = taskRows
      .filter(({ task }) => task.dueAt === date)
      .map((row) => ({ ...row, resolutionDate: resolutionDate(row.task) }))
      .sort(compareTaskRows),
    resolvedTasks = taskRows
      .filter(
        ({ task }) =>
          ['完成', '取消'].includes(task.status) &&
          task.dueAt !== date &&
          resolutionDate(task) === date,
      )
      .map((row) => ({ ...row, resolutionDate: date }))
      .sort(
        (a, b) =>
          (b.task.completedAt || '').localeCompare(a.task.completedAt || '') ||
          compareTaskRows(a, b),
      ),
    activities = activityRows
      .filter(
        ({ activity, opportunity }) =>
          activity.date === date &&
          !(activity.type === '首次联系' && opportunity.appliedAt === activity.date),
      )
      .sort(
        (a, b) =>
          (b.activity.createdAt || '').localeCompare(a.activity.createdAt || '') ||
          a.activity.id.localeCompare(b.activity.id),
      ),
    firstContacts = opportunities
      .filter((opportunity) => opportunity.appliedAt === date)
      .sort(
        (a, b) =>
          (b.createdAt || '').localeCompare(a.createdAt || '') ||
          a.company.localeCompare(b.company, 'zh-CN') ||
          a.id.localeCompare(b.id),
      );

  const grouped = new Map(),
    groupFor = (opportunity) => {
      if (!grouped.has(opportunity.id))
        grouped.set(opportunity.id, {
          opportunity,
          firstContact: false,
          plannedTasks: [],
          resolvedTasks: [],
          activities: [],
        });
      return grouped.get(opportunity.id);
    };
  for (const opportunity of firstContacts) groupFor(opportunity).firstContact = true;
  for (const row of activities) groupFor(row.opportunity).activities.push(row.activity);
  for (const row of plannedTasks) groupFor(row.opportunity).plannedTasks.push(row);
  for (const row of resolvedTasks) groupFor(row.opportunity).resolvedTasks.push(row);
  const opportunityRecords = [...grouped.values()].sort(
    (a, b) =>
      Number(b.plannedTasks.some(({ task }) => task.status === '待办')) -
        Number(a.plannedTasks.some(({ task }) => task.status === '待办')) ||
      a.opportunity.company.localeCompare(b.opportunity.company, 'zh-CN') ||
      a.opportunity.id.localeCompare(b.opportunity.id),
  );

  return { plannedTasks, resolvedTasks, activities, firstContacts, opportunityRecords };
}
