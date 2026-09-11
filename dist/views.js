import { STAGES, live, today } from './model.js';
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

export function createViews(context, pendingTasks) {
  function jobRow(o, board = false) {
    const { state, selected } = context();
    const next = pendingTasks(o.id)[0];
    return `<button class="job-row" data-job="${esc(o.id)}" aria-pressed="${selected === o.id}"><div class="row-top"><span class="company">${esc(o.company)}</span><span class="badges">${o.priority === '重点' ? '<span class="badge warn">重点</span>' : ''}<span class="badge ${o.stage === '沟通中' ? 'blue' : ''}">${esc(o.stage)}</span></span></div><div class="job-role">${esc(o.role)}</div>${next ? `<div class="next-task">${esc(next.text)}</div>` : ''}<div class="row-bottom"><span>${esc(o.platform || '渠道未填')} · ${esc(o.readState || '未知')}</span><span>${next ? `${esc(next.dueAt || '日期待定')}` : `${esc(o.appliedAt || '日期未填')}`}</span></div></button>`;
  }
  function detail() {
    const { state, selected } = context();
    const o = live(state.data.opportunities).find((x) => x.id === selected);
    if (!o)
      return '<aside class="panel empty"><h2>查看岗位详情</h2><p>选择一个岗位，查看沟通记录或安排下一步。</p></aside>';
    const activities = live(state.data.activities)
      .filter((a) => a.opportunityId === o.id)
      .sort(
        (a, b) =>
          (b.date || '0000').localeCompare(a.date || '0000') ||
          (b.createdAt || '').localeCompare(a.createdAt || ''),
      );
    const tasks = pendingTasks(o.id),
      currentDate = today(),
      defaults = getTaskDefaults(o, activities, tasks, currentDate),
      datePresets = DUE_DATE_PRESETS.map(({ label, days }) => {
        const date = addCalendarDays(currentDate, days);
        return `<button type="button" class="date-preset" data-due-offset="${days}" aria-pressed="${defaults.dueAt === date}" aria-label="计划日期设为${label}">${label}</button>`;
      }).join(''),
      url = safeUrl(o.url);
    return `<aside class="panel detail-panel"><div class="detail-head"><h2>${esc(o.company)}</h2><p class="job-role">${esc(o.role)}</p><div class="badges"><span class="badge blue">${esc(o.stage)}</span><span class="badge">消息：${esc(o.readState || '未知')}</span><span class="badge">简历：${esc(o.resumeState || '未知')}</span></div><div class="detail-actions">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="text-button">打开岗位 ↗</a>` : '<span></span>'}<button class="text-button" data-action="edit" data-id="${esc(o.id)}">编辑岗位</button></div></div><div class="detail-body">${o.stage === '已结束' ? `<div class="warning">已结束：${esc(o.endReason || '原因未填')}</div>` : ''}<dl class="detail-facts"><dt>首次联系</dt><dd>${esc(o.appliedAt || '未填')}</dd><dt>联系人</dt><dd>${esc(o.contact || '未填')}</dd>${o.location ? `<dt>地点</dt><dd>${esc(o.location)}</dd>` : ''}${o.salary ? `<dt>薪资</dt><dd>${esc(o.salary)}</dd>` : ''}</dl><h3>下一步行动</h3>${tasks.length ? tasks.map((t) => `<div class="task-line"><div class="task-text">${esc(t.text)}<small>${esc(t.dueAt || '日期待定')}${t.dueAt && t.dueAt < currentDate ? ' · 已逾期' : ''}</small></div><button class="text-button" data-complete="${esc(t.id)}">完成</button><button class="text-button" data-cancel-task="${esc(t.id)}">取消</button></div>`).join('') : '<p class="note-summary">尚未安排下一步。</p>'}<form id="task-form" class="form-stack section-gap" data-suggested-default="${!!defaults.text}"><label>新增行动<input name="text" required maxlength="500" placeholder="例如：询问面试安排" value="${esc(defaults.text)}"></label><label>计划日期<input type="date" name="dueAt" value="${esc(defaults.dueAt)}"></label><div class="date-presets" role="group" aria-label="计划日期快捷选项"><span>快捷日期</span>${datePresets}<button type="button" class="date-preset" data-due-offset="" aria-pressed="${!defaults.dueAt}">不设日期</button></div><button class="secondary" type="submit">安排下一步</button></form><section class="section-gap"><h3>补记沟通</h3><form id="activity-form" class="form-stack"><label>发生了什么<textarea name="text" required maxlength="10000" placeholder="例如：已发送简历，对方说下周安排面试"></textarea></label><div class="form-grid"><label>日期<input type="date" name="date" value="${currentDate}" required></label><label>类型<select name="type">${options(['沟通记录', '对方回复', '发送简历', '跟进', '面试', '复盘'], '沟通记录')}</select></label></div><button class="primary" type="submit">保存沟通记录</button></form></section><section class="section-gap"><h3>沟通时间线 <small class="muted">${activities.length}</small></h3>${
      activities.length
        ? `<ol class="timeline">${activities
            .slice(0, 15)
            .map(
              (a) =>
                `<li><time>${esc(a.date || '日期未记录')} · ${esc(a.type || '记录')}</time>${esc(a.text)}</li>`,
            )
            .join('')}</ol>${
            activities.length > 15
              ? `<details class="section-gap"><summary>查看其余 ${activities.length - 15} 条</summary><ol class="timeline section-gap">${activities
                  .slice(15)
                  .map((a) => `<li><time>${esc(a.date || '日期未记录')}</time>${esc(a.text)}</li>`)
                  .join('')}</ol></details>`
              : ''
          }`
        : '<p class="note-summary">还没有沟通记录。</p>'
    }</section>${o.notes ? `<section class="section-gap"><h3>备注</h3><p class="long-copy">${esc(o.notes)}</p></section>` : ''}${o.description ? `<details class="section-gap"><summary>岗位描述</summary><p class="long-copy">${esc(o.description)}</p></details>` : ''}${o.rawStatus ? `<div class="raw-note">导入时的原始状态：${esc(o.rawStatus)}</div>` : ''}</div></aside>`;
  }
  function todayView() {
    const { state, selected } = context();
    const { active, tasks, due, upcoming, undated, suggestions, unplanned } = getTodayItems(
      state.data,
      today(),
    );
    const group = (title, rows) =>
      rows.length
        ? `<section class="panel"><div class="panel-header"><h2>${title}</h2><span class="count">${rows.length} 项</span></div>${rows
            .map((t) => {
              const o = active.find((o) => o.id === t.opportunityId);
              return `<div class="action-row"><div class="action-main"><button class="company" data-job="${esc(o.id)}">${esc(o.company)}</button><div class="action-text">${esc(t.text)}</div><div class="action-meta">${esc(o.role)} · ${esc(t.dueAt || '未设日期')}${t.dueAt && t.dueAt < today() ? ' · 已逾期' : ''}</div></div><button class="secondary" data-complete="${esc(t.id)}">完成</button></div>`;
            })
            .join('')}</section>`
        : '';
    const unplannedRows = (rows) =>
        rows
          .map(
            ({ opportunity: o, addedToday }) =>
              `<div class="action-row"><div class="action-main"><button class="company" data-job="${esc(o.id)}">${esc(o.company)}</button><div class="action-text">${esc(o.role)}</div><div class="action-meta">${addedToday ? '今天新增 · ' : ''}首次联系：${esc(o.appliedAt || '日期未填')}</div></div><button class="secondary" data-plan-job="${esc(o.id)}">安排下一步</button></div>`,
          )
          .join(''),
      addedToday = unplanned.filter((row) => row.addedToday),
      olderUnplanned = unplanned.filter((row) => !row.addedToday),
      addedTodayGroup = addedToday.length
        ? `<section class="panel"><div class="panel-header"><h2>今天新增 · 未设下一步</h2><span class="count">${addedToday.length} 个岗位</span></div>${unplannedRows(addedToday)}</section>`
        : '',
      olderUnplannedGroup = olderUnplanned.length
        ? `<details class="panel action-details"><summary><span>其他未设下一步</span><span class="count">${olderUnplanned.length} 个岗位</span></summary>${unplannedRows(olderUnplanned)}</details>`
        : '';
    const suggestionGroup = suggestions.length
      ? `<section class="panel"><div class="panel-header"><h2>建议核实</h2><span class="count">${suggestions.length} 项 · 根据已有记录</span></div>${suggestions
          .map(
            ({ opportunity: o, kind, prompt, doneLabel }) =>
              `<div class="action-row"><div class="action-main"><button class="company" data-job="${esc(o.id)}">${esc(o.company)}</button><div class="action-text">${esc(prompt)}</div><div class="action-meta">${esc(o.role)} · 原记录：${esc(o.rawStatus || o.resumeState)}</div></div><div class="action-choices"><button class="secondary" data-suggestion-kind="${esc(kind)}" data-suggestion-choice="done" data-opportunity-id="${esc(o.id)}">${esc(doneLabel)}</button><button class="text-button" data-suggestion-kind="${esc(kind)}" data-suggestion-choice="pending" data-opportunity-id="${esc(o.id)}">加入今日行动</button></div></div>`,
          )
          .join('')}</section>`
      : '';
    return `<div class="stats-strip"><span><strong>${active.length}</strong>进行中</span><span><strong>${due.length}</strong>到期行动</span><span><strong>${unplanned.length}</strong>未设下一步</span></div><p class="note-summary">这里只显示进行中的岗位；待办按计划日期分组。今天新增且未安排的岗位会单独列出，其他未安排岗位折叠在底部。</p><div class="split"><div class="form-stack">${group('今天及逾期', due)}${suggestionGroup}${addedTodayGroup}${group('接下来', upcoming)}${group('日期待定', undated)}${olderUnplannedGroup}${!tasks.length && !suggestions.length && !unplanned.length ? '<section class="panel empty"><h2>还没有待办行动</h2><p>从岗位列表选择一个机会，设置下次跟进日期。</p><button class="secondary" data-view="list">查看岗位</button></section>' : ''}</div>${detail()}</div>`;
  }
  function dailyView() {
    const { state, selected, dailyDate } = context(),
      { plannedTasks, resolvedTasks, activities, firstContacts, opportunityRecords } =
        getDailyRecords(state.data, dailyDate),
      total = plannedTasks.length + resolvedTasks.length + activities.length + firstContacts.length;
    const event = (kind, text, meta = '') =>
        `<div class="daily-event"><span class="daily-event-kind">${esc(kind)}</span><div class="daily-event-content"><div class="daily-event-text">${esc(text)}</div>${meta ? `<div class="daily-event-meta">${esc(meta)}</div>` : ''}</div></div>`,
      openJobButton = (opportunity) =>
        `<button class="secondary daily-open-job" type="button" data-job="${esc(opportunity.id)}">查看岗位</button>`,
      plannedTaskEvent = ({ task, resolutionDate }) => {
        const status =
            task.status === '完成' ? '已完成' : task.status === '取消' ? '已取消' : '待办',
          sameDayResult = resolutionDate === dailyDate && task.status !== '待办',
          kind = sameDayResult
            ? `计划 · 当日${task.status === '取消' ? '取消' : '完成'}`
            : `计划 · ${status}`,
          meta =
            resolutionDate && !sameDayResult
              ? `${task.status === '取消' ? '取消于' : '完成于'} ${resolutionDate}`
              : '';
        return event(kind, task.text, meta);
      },
      resolvedTaskEvent = ({ task }) =>
        event(
          task.status === '取消' ? '取消' : '完成',
          task.text,
          `原计划：${task.dueAt || '未设日期'}`,
        ),
      cards = opportunityRecords
        .map(({ opportunity, firstContact, plannedTasks, resolvedTasks, activities }) => {
          const events =
            (firstContact ? event('首次联系', '开始接触该岗位') : '') +
            activities
              .map((activity) => event(`沟通 · ${activity.type || '记录'}`, activity.text))
              .join('') +
            plannedTasks.map(plannedTaskEvent).join('') +
            resolvedTasks.map(resolvedTaskEvent).join('');
          return `<section class="panel daily-job-card" data-selected="${opportunity.id === selected}"><div class="panel-header daily-job-header"><div><button class="company" data-job="${esc(opportunity.id)}">${esc(opportunity.company)}</button><div class="job-role">${esc(opportunity.role)}</div></div><div class="daily-job-actions"><span class="badge">当前阶段：${esc(opportunity.stage)}</span>${openJobButton(opportunity)}</div></div><div class="daily-job-events">${events}</div></section>`;
        })
        .join('');
    return `<section class="panel daily-toolbar"><div class="daily-date-title"><small>查看日期</small><strong>${esc(readableDate(dailyDate))}</strong></div><div class="daily-date-actions"><button class="secondary" type="button" data-daily-step="-1">← 上一天</button><label>选择日期<input id="daily-date" type="date" required value="${esc(dailyDate)}"></label><button class="text-button" type="button" data-daily-today>回到今天</button><button class="secondary" type="button" data-daily-step="1">下一天 →</button></div></section><div class="stats-strip daily-stats"><span><strong>${plannedTasks.length}</strong>计划</span><span><strong>${resolvedTasks.length}</strong>完成/取消</span><span><strong>${activities.length}</strong>沟通</span><span><strong>${firstContacts.length}</strong>首次联系</span></div><p class="note-summary">同一岗位的当天记录已合并；岗位阶段显示当前状态，不代表所选日期当天的历史状态。</p><div class="split"><div id="daily-records" class="form-stack">${total ? cards : `<section class="panel empty"><h2>这一天没有记录</h2><p>可以切换前后日期，或回到今天继续查看。</p></section>`}</div>${detail()}</div>`;
  }
  function boardView() {
    const { state, selected } = context();
    return `<div class="board">${STAGES.map((stage) => {
      const jobs = live(state.data.opportunities).filter((o) => o.stage === stage);
      return `<section class="lane"><h2>${stage}<span>${jobs.length}</span></h2>${jobs.map((o) => jobRow(o, true)).join('') || '<p class="lane-empty">暂无记录</p>'}</section>`;
    }).join('')}</div>`;
  }

  return { jobRow, detail, todayView, dailyView, boardView };
}
