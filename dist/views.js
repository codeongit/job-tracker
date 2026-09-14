import { STAGES, getOpportunityStatus, live, today } from './model.js';
import { DUE_DATE_PRESETS, addCalendarDays, getTaskDefaults } from './planning.js';
import { getTodayItems } from './today.js';
import { getDailyRecords } from './daily.js';
import { esc, safeUrl, options } from './ui.js';

function readableDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
}
function dailyEvent(kind, text, meta = '') {
  return `<div class="daily-event"><span class="daily-event-kind">${esc(kind)}</span><div class="daily-event-content"><div class="daily-event-text">${esc(text)}</div>${meta ? `<div class="daily-event-meta">${esc(meta)}</div>` : ''}</div></div>`;
}
export function dailyRecordEvents(record, date) {
  if (!record) return '';
  const { firstContact, activities, plannedTasks, resolvedTasks } = record;
  return (
    (firstContact ? dailyEvent('首次联系', '开始接触该岗位') : '') +
    activities.map((a) => dailyEvent(`沟通 · ${a.type || '记录'}`, a.text)).join('') +
    plannedTasks
      .map(({ task, resolutionDate }) => {
        const status =
            task.status === '完成' ? '已完成' : task.status === '取消' ? '已取消' : '待办',
          sameDayResult = resolutionDate === date && task.status !== '待办',
          kind = sameDayResult
            ? `计划 · 当日${task.status === '取消' ? '取消' : '完成'}`
            : `计划 · ${status}`,
          meta =
            resolutionDate && !sameDayResult
              ? `${task.status === '取消' ? '取消于' : '完成于'} ${resolutionDate}`
              : '';
        return dailyEvent(kind, task.text, meta);
      })
      .join('') +
    resolvedTasks
      .map(({ task }) =>
        dailyEvent(
          task.status === '取消' ? '取消' : '完成',
          task.text,
          `原计划：${task.dueAt || '未设日期'}`,
        ),
      )
      .join('')
  );
}
export function createViews(context, pendingTasks) {
  function jobRow(o) {
    const { selected, jobDate } = context(),
      next = jobDate ? null : pendingTasks(o.id)[0];
    return `<button class="job-row" data-job="${esc(o.id)}" aria-pressed="${selected === o.id}"><div class="row-top"><span class="company">${esc(o.company)}</span><span class="badges">${o.priority === '重点' ? '<span class="badge warn">重点</span>' : ''}<span class="badge ${o.stage === '沟通中' ? 'blue' : ''}">${jobDate ? '当前阶段：' : ''}${esc(getOpportunityStatus(o).stage)}</span></span></div><div class="job-role">${esc(o.role)}</div>${next ? `<div class="next-task">${esc(next.text)}</div>` : ''}<div class="row-bottom"><span>${esc(o.platform || '渠道未填')} · ${esc(getOpportunityStatus(o).readState)}</span><span>${next ? esc(next.dueAt || '日期待定') : esc(o.appliedAt || '日期未填')}</span></div></button>`;
  }
  function detailDateRecords() {
    const { state, selected, detailDate } = context();
    if (!detailDate || !selected) return '';
    const record = getDailyRecords(state.data, detailDate).opportunityRecords.find(
      ({ opportunity }) => opportunity.id === selected,
    );
    return `<section class="detail-date-records"><h3>查看日期：${esc(detailDate)}</h3><p class="note-summary">这里展示所选日期的记录；下方操作按各自填写或实际发生的日期保存。</p>${record ? dailyRecordEvents(record, detailDate) : '<p class="note-summary">这个岗位在所选日期没有记录。</p>'}</section>`;
  }
  function detail() {
    const { state, selected, detailSections = {} } = context(),
      o = live(state.data.opportunities).find((x) => x.id === selected);
    if (!o) return '';
    const activities = live(state.data.activities)
        .filter((a) => a.opportunityId === o.id)
        .sort(
          (a, b) =>
            (b.date || '0000').localeCompare(a.date || '0000') ||
            (b.createdAt || '').localeCompare(a.createdAt || ''),
        ),
      tasks = pendingTasks(o.id),
      resolvedTasks = live(state.data.tasks)
        .filter((t) => t.opportunityId === o.id && t.status !== '待办')
        .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')),
      currentDate = today(),
      defaults = getTaskDefaults(o, activities, tasks, currentDate),
      datePresets = DUE_DATE_PRESETS.map(({ label, days }) => {
        const date = addCalendarDays(currentDate, days);
        return `<button type="button" class="date-preset" data-due-offset="${days}" aria-pressed="${defaults.dueAt === date}" aria-label="计划日期设为${label}">${label}</button>`;
      }).join(''),
      url = safeUrl(o.url),
      expanded = (section) => (detailSections[section] ? ' open' : '');
    return `<aside class="panel detail-panel" aria-labelledby="detail-title"><div class="detail-head"><button class="text-button detail-back" data-close-detail>← 返回结果</button><h2 id="detail-title" tabindex="-1">${esc(o.company)}</h2><p class="job-role">${esc(o.role)}</p><div class="badges"><span class="badge blue">当前岗位阶段：${esc(getOpportunityStatus(o).stage)}</span><span class="badge">消息：${esc(getOpportunityStatus(o).readState)}</span><span class="badge">简历：${esc(o.resumeState || '未知')}</span></div><div class="detail-actions"><button class="primary" data-detail-section="activity">记录沟通</button><button class="secondary" data-detail-section="task">安排下一步</button><button class="text-button" data-action="edit" data-editor-focus="stage" data-id="${esc(o.id)}">更新阶段</button></div></div><div class="detail-body"><div id="detail-filter-notice" class="warning" hidden></div><div id="detail-date-records">${detailDateRecords()}</div>${o.stage === '已结束' ? `<div class="warning">已结束：${esc(o.endReason || '原因未填')}</div>` : ''}<section class="pending-actions"><h3>下一步行动 <small class="muted">${tasks.length}</small></h3>${tasks.length ? tasks.map((t) => `<div class="task-line"><div class="task-text">${esc(t.text)}<small>${esc(t.dueAt || '日期待定')}${t.dueAt && t.dueAt < currentDate ? ' · 已逾期' : ''}</small></div><button class="text-button" data-complete="${esc(t.id)}">完成</button><button class="text-button" data-cancel-task="${esc(t.id)}">取消</button></div>`).join('') : '<p class="note-summary">尚未安排下一步。</p>'}</section><details class="detail-section" data-detail-section-panel="task"${expanded('task')}><summary>安排下一步</summary><form id="task-form" class="form-stack" data-suggested-default="${!!defaults.text}"><label>新增行动<input name="text" required maxlength="500" placeholder="例如：询问面试安排" value="${esc(defaults.text)}"></label><label>计划日期<input type="date" name="dueAt" value="${esc(defaults.dueAt)}"></label><div class="date-presets" role="group" aria-label="计划日期快捷选项"><span>快捷日期</span>${datePresets}<button type="button" class="date-preset" data-due-offset="" aria-pressed="${!defaults.dueAt}">不设日期</button></div><button class="secondary" type="submit">安排下一步</button></form></details><details class="detail-section" data-detail-section-panel="activity"${expanded('activity')}><summary>记录沟通</summary><form id="activity-form" class="form-stack"><label>发生了什么<textarea name="text" required maxlength="10000" placeholder="例如：已发送简历，对方说下周安排面试"></textarea></label><div class="form-grid"><label>日期<input type="date" name="date" value="${currentDate}" required></label><label>类型<select name="type">${options(['沟通记录', '对方回复', '发送简历', '跟进', '面试', '复盘'], '沟通记录')}</select></label></div><button class="primary" type="submit">保存沟通记录</button></form></details><details class="detail-section" data-detail-section-panel="facts"${expanded('facts')}><summary>基础资料</summary><div class="detail-actions">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="text-button">打开岗位 ↗</a>` : '<span></span>'}<button class="text-button" data-action="edit" data-id="${esc(o.id)}">编辑岗位</button></div><dl class="detail-facts"><dt>首次联系</dt><dd>${esc(o.appliedAt || '未填')}</dd><dt>联系人</dt><dd>${esc(o.contact || '未填')}</dd>${o.location ? `<dt>地点</dt><dd>${esc(o.location)}</dd>` : ''}${o.salary ? `<dt>薪资</dt><dd>${esc(o.salary)}</dd>` : ''}</dl>${o.notes ? `<section class="section-gap"><h3>备注</h3><p class="long-copy">${esc(o.notes)}</p></section>` : ''}${o.description ? `<section class="section-gap"><h3>岗位描述</h3><p class="long-copy">${esc(o.description)}</p></section>` : ''}${o.rawStatus ? `<div class="raw-note">导入时的原始状态：${esc(o.rawStatus)}</div>` : ''}</details><details class="detail-section" data-detail-section-panel="history"${expanded('history')}><summary>完整历史 <span class="muted">${activities.length + resolvedTasks.length} 条</span></summary><div class="section-gap"><h3>沟通时间线</h3>${activities.length ? `<ol class="timeline">${activities.map((a) => `<li><time>${esc(a.date || '日期未记录')} · ${esc(a.type || '记录')}</time>${esc(a.text)}</li>`).join('')}</ol>` : '<p class="note-summary">还没有沟通记录。</p>'}${resolvedTasks.length ? `<h3 class="section-gap">已完成 / 已取消行动</h3>${resolvedTasks.map((t) => `<div class="task-line"><div class="task-text">${esc(t.text)}<small>${esc(t.status)} · 原计划：${esc(t.dueAt || '未设日期')}${t.completedAt ? ` · ${esc(new Date(t.completedAt).toLocaleString('zh-CN'))}` : ''}</small></div></div>`).join('')}` : ''}</div></details></div></aside>`;
  }
  function todayView() {
    const { state, actionTab = 'today' } = context(),
      currentDate = today(),
      { active, due, upcoming, undated, suggestions, unplanned } = getTodayItems(
        state.data,
        currentDate,
      ),
      addedToday = unplanned.filter((row) => row.addedToday),
      olderUnplanned = unplanned.filter((row) => !row.addedToday),
      organizeCount = undated.length + suggestions.length + unplanned.length;
    const group = (title, rows) =>
      rows.length
        ? `<section class="panel"><div class="panel-header"><h3>${esc(title)}</h3><span class="count">${rows.length} 项</span></div>${rows
            .map((t) => {
              const o = active.find((o) => o.id === t.opportunityId);
              return `<div class="action-row"><div class="action-main"><button class="company" data-job="${esc(o.id)}">${esc(o.company)}</button><div class="action-text">${esc(t.text)}</div><div class="action-meta">${esc(o.role)} · ${esc(t.dueAt || '未设日期')}${t.dueAt && t.dueAt < currentDate ? ' · 已逾期' : ''}</div></div><button class="secondary" data-complete="${esc(t.id)}">完成</button></div>`;
            })
            .join('')}</section>`
        : '';
    const unplannedGroup = (title, rows, id = '') =>
      rows.length
        ? `<section class="panel"${id ? ` id="${id}" tabindex="-1"` : ''}><div class="panel-header"><h3>${esc(title)}</h3><span class="count">${rows.length} 个岗位</span></div>${rows.map(({ opportunity: o, addedToday }) => `<div class="action-row"><div class="action-main"><button class="company" data-job="${esc(o.id)}">${esc(o.company)}</button><div class="action-text">${esc(o.role)}</div><div class="action-meta">${addedToday ? '今天新增 · ' : ''}首次联系：${esc(o.appliedAt || '日期未填')}</div></div><button class="secondary" data-plan-job="${esc(o.id)}">安排下一步</button></div>`).join('')}</section>`
        : '';
    const suggestionGroup = suggestions.length
      ? `<section class="panel"><div class="panel-header"><h3>建议核实</h3><span class="count">${suggestions.length} 项</span></div>${suggestions.map(({ opportunity: o, kind, prompt, doneLabel }) => `<div class="action-row"><div class="action-main"><button class="company" data-job="${esc(o.id)}">${esc(o.company)}</button><div class="action-text">${esc(prompt)}</div><div class="action-meta">${esc(o.role)} · 原记录：${esc(o.rawStatus || o.resumeState)}</div></div><div class="action-choices"><button class="secondary" data-suggestion-kind="${esc(kind)}" data-suggestion-choice="done" data-opportunity-id="${esc(o.id)}">${esc(doneLabel)}</button><button class="text-button" data-suggestion-kind="${esc(kind)}" data-suggestion-choice="pending" data-opportunity-id="${esc(o.id)}">加入今日行动</button></div></div>`).join('')}</section>`
      : '';
    const upcomingByDate = new Map();
    for (const task of upcoming) {
      if (!upcomingByDate.has(task.dueAt)) upcomingByDate.set(task.dueAt, []);
      upcomingByDate.get(task.dueAt).push(task);
    }
    const tabs = [
        ['today', '今天', due.length],
        ['upcoming', '接下来', upcoming.length],
        ['organize', '待整理', organizeCount],
      ],
      title = tabs.find(([value]) => value === actionTab)[1],
      empty = (text, caption) =>
        `<section class="panel empty"><h3>${text}</h3><p>${caption}</p><button class="secondary" data-view="list">查看岗位</button></section>`;
    let content;
    if (actionTab === 'upcoming')
      content =
        [...upcomingByDate].map(([date, rows]) => group(readableDate(date), rows)).join('') ||
        empty('还没有未来行动', '可以从岗位详情安排下一次跟进。');
    else if (actionTab === 'organize')
      content =
        suggestionGroup +
          group('未设日期的行动', undated) +
          unplannedGroup('今天新增 · 未设下一步', addedToday, 'new-unplanned') +
          unplannedGroup('其他未设下一步', olderUnplanned) ||
        empty('当前没有待整理事项', '核实事项、未设日期的行动和未安排的岗位会出现在这里。');
    else
      content =
        (addedToday.length
          ? `<button class="organize-new-entry" data-organize-new><span>今天新增 · 待安排</span><strong>${addedToday.length} 个岗位 →</strong></button>`
          : '') +
        (group('今天及逾期', due) ||
          empty('今天没有到期行动', '可以查看接下来的计划，或整理还没有安排的岗位。'));
    return `<div class="action-tabs" role="group" aria-label="行动分类">${tabs.map(([value, label, count]) => `<button data-action-tab="${value}" aria-pressed="${actionTab === value}">${label}<span>${count}</span></button>`).join('')}</div><div class="results-heading"><h2 id="results-title" tabindex="-1">${title}</h2><span class="muted">${active.length} 个进行中的岗位</span></div><div class="form-stack">${content}</div>`;
  }
  function jobResults() {
    const { selected, filteredRows = [], jobDate = '', page = 0 } = context(),
      title = jobDate ? `${jobDate} 的岗位记录` : '岗位机会',
      heading = `<div class="panel-header"><h2 id="results-title" tabindex="-1">${esc(title)}</h2><span class="count">${filteredRows.length} 个岗位</span></div>`,
      empty = `<div class="empty"><h3>${jobDate ? '这一天没有匹配记录' : '没有匹配的岗位'}</h3><p>可以调整关键词、阶段或日期，或清空筛选。</p><button class="secondary" data-clear-filters>清空筛选</button></div>`;
    const rows = filteredRows
      .slice(page * 10, page * 10 + 10)
      .map(({ opportunity, dailyRecord }) =>
        jobDate && dailyRecord
          ? `<section class="daily-job-card" data-selected="${opportunity.id === selected}">${jobRow(opportunity)}<div class="daily-job-events">${dailyRecordEvents(dailyRecord, jobDate)}</div></section>`
          : jobRow(opportunity),
      )
      .join('');
    return `<section class="panel" id="job-list-panel">${heading}${rows || empty}<div class="pager"><button class="text-button" data-page="-1" ${page === 0 ? 'disabled' : ''}>上一页</button><span>${filteredRows.length ? `${page + 1} / ${Math.ceil(filteredRows.length / 10)}` : '0'}</span><button class="text-button" data-page="1" ${(page + 1) * 10 >= filteredRows.length ? 'disabled' : ''}>下一页</button></div></section>`;
  }
  function jobsView() {
    const { query = '', filter = '', jobDate = '' } = context();
    return `<section class="jobs-toolbar" aria-label="岗位筛选"><div class="filters"><input id="search" aria-label="搜索公司、岗位或联系人" placeholder="搜索公司、岗位、联系人" value="${esc(query)}"><select id="stage-filter" aria-label="筛选招聘阶段"><option value="">全部阶段</option>${options(STAGES, filter)}</select><button class="text-button" data-clear-filters>清空筛选</button></div><div class="job-date-filter"><label>查看日期<input id="job-date" aria-label="查看日期" type="date" value="${esc(jobDate)}"></label><div class="job-date-actions"><button class="secondary" data-job-date-step="-1" ${jobDate ? '' : 'disabled'}>← 上一天</button><button class="secondary" data-job-date-today>今天</button><button class="secondary" data-job-date-step="1" ${jobDate ? '' : 'disabled'}>下一天 →</button><button class="text-button" data-job-date-clear>全部日期</button></div></div><p class="note-summary">选择日期后查看当天计划、完成、取消、沟通和首次联系；岗位阶段始终显示当前状态。</p></section><div id="job-results">${jobResults()}</div>`;
  }
  return { jobRow, detail, detailDateRecords, todayView, jobsView, jobResults };
}
