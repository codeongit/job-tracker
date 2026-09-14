import { createDraftManager } from './drafts.js';
import { createDiskBackup } from './disk-backup.js';
import { createBackupUI } from './backup-ui.js';
import { settingsView } from './settings-view.js';
import { createBackup } from './workspace.js';
import { APP_VERSION } from './version.js';
import { MAX_BACKUP_BYTES, utf8Bytes } from './limits.js';
import { createViews } from './views.js';
import { findCompanyMatches, getFilteredOpportunities } from './jobs.js';
import { addCalendarDays, getTaskDefaults } from './planning.js';
import { applyTaskChoice, applyVerificationChoice } from './today.js';
import {
  STAGES,
  READ_STATES,
  getOpportunityStatus,
  getResumeLinkedStatus,
  getSentResumeStatus,
  emptyData,
  uid,
  today,
  live,
  equal,
  validateData,
  parseMarkdown,
  applyImport,
  markdownExport,
  removeOpportunity,
  resolveConflicts,
} from './model.js';
import { readState, updateState, editData, saveSnapshot, readRawState } from './storage.js';
import { githubClient, syncWorkspace, validateConfig } from './github.js';
import { discoverLocalSsh, localSshClient } from './local-ssh.js';
import { bindCommittedTextInput, trackComposition } from './text-input.js';
import { $, esc, options, download } from './ui.js';
let state,
  view = 'today',
  actionTab = 'today',
  jobDate = '',
  detailDate = '',
  selected = '',
  query = '',
  filter = '',
  page = 0,
  token = '',
  syncing = false,
  importFile = null,
  parsedImport = null,
  noticeTimer,
  localSsh = null,
  diagnostic = '',
  draftSource = null;
let filteredRows = [],
  detailOrigin = null,
  renderedView = '';
const scrollPositions = new Map(),
  expandedDetails = new Map(),
  boundEvents = new WeakMap(),
  boundDraftForms = new WeakSet(),
  completedDraftForms = new WeakSet(),
  boundSearches = new WeakSet();
const drafts = createDraftManager({
  report,
  onCount: (count) => {
    const button = $('#draft-button');
    if (button) button.textContent = `草稿箱${count ? `（${count}）` : ''}`;
  },
});
const diskBackup = createDiskBackup({
  readWorkspace: readRawState,
  readDrafts: () => drafts.store.list(),
  onStatus: (status) => {
    const el = $('#disk-backup-status');
    if (el) el.textContent = status.message;
  },
});
const { detail, todayView, jobsView, jobResults, detailDateRecords } = createViews(
  () => ({
    state,
    selected,
    actionTab,
    jobDate,
    query,
    filter,
    page,
    filteredRows,
    detailDate,
    detailSections: expandedDetails.get(selected) || {},
  }),
  pendingTasksForView,
);
function pendingTasksForView(id) {
  return pendingTasks(id);
}
function datePresetValue(button) {
  return button.dataset.dueOffset === ''
    ? ''
    : addCalendarDays(today(), Number(button.dataset.dueOffset));
}
function syncDatePresets(form) {
  const value = form?.elements.namedItem('dueAt')?.value ?? '';
  form
    ?.querySelectorAll('[data-due-offset]')
    .forEach((button) =>
      button.setAttribute('aria-pressed', String(datePresetValue(button) === value)),
    );
}
const useSsh = () => !!localSsh && equal(state?.config, localSsh.target);
let deferredRender = false,
  deferredCompanyHint = false;
const composition = trackComposition(document, () => {
  if (deferredRender) {
    deferredRender = false;
    render(true);
  }
  if (deferredCompanyHint) {
    deferredCompanyHint = false;
    refreshCompanyMatchHint($('#editor-form'));
  }
});
const channel =
  typeof BroadcastChannel === 'function' ? new BroadcastChannel('job-tracker-updates') : null;
const pendingTasks = (id) =>
  live(state.data.tasks)
    .filter((t) => t.status === '待办' && (!id || t.opportunityId === id))
    .sort((a, b) => (a.dueAt || '9999').localeCompare(b.dueAt || '9999'));
function notify(message) {
  clearTimeout(noticeTimer);
  $('#notice').textContent = message;
  $('#notice').hidden = false;
  noticeTimer = setTimeout(() => ($('#notice').hidden = true), 7000);
}
function report(error) {
  notify(error.message || '操作失败，请重试。');
}
async function reload(preserveDrafts = false) {
  state = await readState();
  render(preserveDrafts);
}
async function change(transform, reason, savedDraft) {
  state = await editData(transform, { reason });
  const warning = savedDraft ? drafts.complete(savedDraft.form, savedDraft.captured) : '';
  if (savedDraft && drafts.capture(savedDraft.form)?.revision === savedDraft.captured.revision)
    completedDraftForms.add(savedDraft.form);
  channel?.postMessage('changed');
  render();
  return warning || '';
}
function statusRender() {
  const dirty = !equal(state.data, state.base);
  $('#sync-state').textContent = syncing
    ? '正在同步…'
    : state.pending
      ? '有冲突待处理'
      : dirty
        ? '本机已保存 · 待同步'
        : state.lastSync
          ? '已同步'
          : '仅本机保存';
  $('#sync-button').disabled = syncing;
  $('#sync-button').textContent = syncing ? '同步中…' : useSsh() ? 'SSH 同步' : '立即同步';
  $('#local-status').textContent = `${live(state.data.opportunities).length} 个岗位 · 本地已保存`;
  $('#last-sync').textContent = state.lastSync
    ? `上次同步 ${new Date(state.lastSync).toLocaleString('zh-CN')}`
    : '尚未同步到 GitHub';
}
function header() {
  const labels = {
    today: ['下一步', '行动', '处理今天的待办，规划接下来的跟进。'],
    list: ['机会', '岗位', '搜索岗位，按招聘阶段或日期筛选，查看记录并继续跟进。'],
    settings: ['个人数据', '数据与同步', '数据先存本机，再同步到你的 GitHub 私有仓库。'],
  };
  const [a, b, c] = labels[view];
  $('#eyebrow').textContent = a;
  $('#page-title').textContent = b;
  $('#page-caption').textContent = c;
  document
    .querySelectorAll('[data-view]')
    .forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
}
function emptyView() {
  return `<section class="panel empty"><div class="empty-symbol">＋</div><h2>从已有记录开始</h2><p>导入个人记录，核对日期和字段，接着就能安排下一步。</p><div class="empty-actions">${['127.0.0.1', 'localhost'].includes(location.hostname) ? '<button class="primary" data-action="local-import">导入现有个人记录</button>' : ''}<button class="secondary" data-action="choose-file">选择 Markdown / JSON</button><button class="secondary" data-action="new">手动新增岗位</button></div></section>`;
}
function refreshFilteredRows() {
  filteredRows = getFilteredOpportunities(state.data, { query, stage: filter, date: jobDate });
  page = Math.max(0, Math.min(page, Math.ceil(filteredRows.length / 10) - 1));
}
function updateDetailNotice() {
  const notice = $('#detail-filter-notice');
  if (!notice) return;
  const outside =
    view === 'list' && !filteredRows.some(({ opportunity }) => opportunity.id === selected);
  notice.hidden = !outside;
  notice.textContent = outside ? '此岗位不符合当前筛选条件。关闭详情后可继续查看筛选结果。' : '';
}
function updateListResults() {
  refreshFilteredRows();
  const panel = $('#job-results');
  if (panel) panel.innerHTML = jobResults();
  document.querySelectorAll('[data-job-date-step]').forEach((button) => {
    button.disabled = !jobDate;
  });
  updateDetailNotice();
}
function viewKey() {
  return view === 'today' ? `today:${actionTab}` : view;
}
function rememberScroll() {
  scrollPositions.set(viewKey(), detailOrigin?.scrollY ?? window.scrollY);
}
function captureDetailSections() {
  if (!selected) return;
  const sections = { ...expandedDetails.get(selected) };
  document.querySelectorAll('#detail-host [data-detail-section-panel]').forEach((section) => {
    sections[section.dataset.detailSectionPanel] = section.open;
  });
  expandedDetails.set(selected, sections);
}
function bindOnce(element, event, callback) {
  if (!element) return;
  let events = boundEvents.get(element);
  if (!events) boundEvents.set(element, (events = new Set()));
  if (events.has(event)) return;
  events.add(event);
  element.addEventListener(event, callback);
}
function syncDetailLayout() {
  document.body.classList.toggle('detail-open', !!selected);
  document.querySelector('.detail-layout')?.classList.toggle('has-detail', !!selected);
  document.querySelectorAll('#page-surface [data-job]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.job === selected));
    button
      .closest('.daily-job-card')
      ?.setAttribute('data-selected', String(button.dataset.job === selected));
  });
  updateDetailNotice();
}
function focusDetailSection(kind) {
  const section = document.querySelector(`#detail-host [data-detail-section-panel="${kind}"]`);
  if (section) section.open = true;
  captureDetailSections();
  document
    .querySelector(
      kind === 'task' ? '#task-form input[name="text"]' : '#activity-form textarea[name="text"]',
    )
    ?.focus();
}
function openDetail(id, { trigger = document.activeElement, section, source } = {}) {
  if (!live(state.data.opportunities).some((opportunity) => opportunity.id === id))
    throw new Error('这个岗位已删除或不存在。');
  captureDetailSections();
  const detailScroll = selected === id ? $('#detail-host').scrollTop : 0;
  if (!selected || (id !== selected && !trigger?.closest?.('#detail-host'))) {
    const attributes = ['data-job', 'data-plan-job', 'data-opportunity-id'];
    const attribute = attributes.find((name) => trigger?.hasAttribute?.(name));
    detailOrigin = {
      scrollY:
        selected && matchMedia('(max-width: 760px)').matches
          ? (detailOrigin?.scrollY ?? window.scrollY)
          : window.scrollY,
      trigger,
      selector: attribute
        ? `#page-surface [${attribute}="${CSS.escape(trigger.getAttribute(attribute))}"]`
        : '',
    };
  }
  selected = id;
  detailDate = view === 'list' ? jobDate : '';
  draftSource = source || null;
  if (section) expandedDetails.set(id, { ...expandedDetails.get(id), [section]: true });
  $('#detail-host').innerHTML = detail();
  bindForms();
  syncDetailLayout();
  $('#detail-host').scrollTop = detailScroll;
  if (matchMedia('(max-width: 760px)').matches) window.scrollTo(0, 0);
  if (section) focusDetailSection(section);
  else $('#detail-title')?.focus({ preventScroll: true });
}
function closeDetail(restore = true) {
  captureDetailSections();
  const origin = detailOrigin;
  selected = '';
  detailDate = '';
  detailOrigin = null;
  const host = $('#detail-host');
  if (host) host.innerHTML = '';
  syncDetailLayout();
  if (restore) restoreDetailOrigin(origin);
}
function restoreDetailOrigin(origin) {
  if (origin) {
    const target = origin.trigger?.isConnected
      ? origin.trigger
      : (origin.selector && document.querySelector(origin.selector)) ||
        $('#results-title') ||
        $('#page-title');
    if (target && !target.matches('button,input,select,textarea,a'))
      target.setAttribute('tabindex', '-1');
    target?.focus({ preventScroll: true });
    window.scrollTo(0, origin.scrollY);
  }
}
function navigate(nextView) {
  rememberScroll();
  closeDetail(false);
  view = nextView;
  render();
  window.scrollTo(0, scrollPositions.get(viewKey()) || 0);
}
function applyJobFilters() {
  page = 0;
  if ($('#search')) $('#search').value = query;
  if ($('#stage-filter')) $('#stage-filter').value = filter;
  if ($('#job-date')) $('#job-date').value = jobDate;
  updateListResults();
  if (selected && view === 'list') {
    detailDate = jobDate;
    if ($('#detail-date-records')) $('#detail-date-records').innerHTML = detailDateRecords();
  }
}
function render(preserveDrafts = false) {
  if (!state) return;
  if (composition.active) {
    deferredRender = true;
    return;
  }
  deferredRender = false;
  captureDetailSections();
  const deletedSelection =
    selected && !live(state.data.opportunities).some((row) => row.id === selected);
  const deletedOrigin = deletedSelection ? detailOrigin : null;
  if (deletedSelection) closeDetail(false);
  refreshFilteredRows();
  const detailScroll = $('#detail-host')?.scrollTop || 0;
  const active = document.activeElement;
  const focus = active?.matches('input,textarea,select')
    ? {
        id: active.id,
        form: active.form?.id,
        name: active.name,
        start: active.selectionStart,
        end: active.selectionEnd,
        direction: active.selectionDirection,
      }
    : null;
  const preservedForms = ['activity-form', 'task-form', 'settings-form'].flatMap((id) => {
    const form = document.getElementById(id);
    if (!form) return [];
    if (completedDraftForms.has(form)) return [];
    if (id === 'settings-form') return preserveDrafts && view === 'settings' ? [form] : [];
    if (form.dataset.opportunityId !== selected) return [];
    const currentDraft = id === 'settings-form' ? null : drafts.capture(form);
    if (id !== 'settings-form' && !Object.keys(currentDraft?.values ?? {}).length) return [];
    return [form];
  });
  header();
  statusRender();
  if (!$('#page-surface')) {
    $('#app-content').innerHTML =
      '<div class="detail-layout"><div id="page-surface"></div><div id="detail-host"></div></div>';
    renderedView = '';
  }
  if (view === 'list' && renderedView === 'list' && $('#job-results')) {
    updateListResults();
  } else
    $('#page-surface').innerHTML =
      view === 'settings'
        ? settingsView({
            state,
            ssh: useSsh(),
            token,
            syncing,
            diagnostic,
            backupStatus: diskBackup.status(),
          })
        : !live(state.data.opportunities).length && view !== 'list'
          ? emptyView()
          : view === 'today'
            ? todayView()
            : jobsView();
  renderedView = view;
  $('#detail-host').innerHTML = selected ? detail() : '';
  for (const form of preservedForms) {
    const replacement = document.getElementById(form.id);
    if (replacement && replacement !== form) replacement.replaceWith(form);
  }
  bindForms();
  syncDetailLayout();
  $('#detail-host').scrollTop = detailScroll;
  if (deletedSelection) {
    notify('这个岗位已删除，已返回原页面。');
    requestAnimationFrame(() => restoreDetailOrigin(deletedOrigin));
  }
  if (focus) {
    const field = focus.id
      ? document.getElementById(focus.id)
      : document.getElementById(focus.form)?.elements.namedItem(focus.name);
    field?.focus?.({ preventScroll: true });
    if (Number.isInteger(focus.start) && typeof field?.setSelectionRange === 'function')
      field.setSelectionRange(focus.start, focus.end, focus.direction || 'none');
  }
  refreshCompanyMatchHint($('#editor-form'));
}
function bindForms() {
  const formOpportunityId = selected;
  for (const [id, kind] of [
    ['task-form', 'task'],
    ['activity-form', 'activity'],
  ]) {
    const form = document.getElementById(id);
    if (!form) continue;
    if (!boundDraftForms.has(form)) {
      form.dataset.opportunityId = selected;
      drafts.bind(form, {
        kind,
        opportunityId: selected,
        source: draftSource?.kind === kind ? draftSource : undefined,
      });
      boundDraftForms.add(form);
    }
    if (Object.keys(drafts.capture(form)?.values ?? {}).length) {
      const section = form.closest('[data-detail-section-panel]');
      if (section) section.open = true;
    }
  }
  document
    .querySelectorAll('#detail-host [data-detail-section-panel]')
    .forEach((section) => bindOnce(section, 'toggle', captureDetailSections));
  const taskForm = $('#task-form');
  if (taskForm) {
    const dueAt = taskForm.elements.namedItem('dueAt');
    bindOnce(dueAt, 'input', () => syncDatePresets(taskForm));
    bindOnce(dueAt, 'change', () => syncDatePresets(taskForm));
    syncDatePresets(taskForm);
  }
  draftSource = null;
  const search = $('#search');
  if (search && !boundSearches.has(search)) {
    boundSearches.add(search);
    bindCommittedTextInput(search, (value) => {
      query = value;
      page = 0;
      updateListResults();
    });
  }
  bindOnce($('#stage-filter'), 'change', (e) => {
    filter = e.target.value;
    page = 0;
    updateListResults();
  });
  bindOnce($('#job-date'), 'change', (e) => {
    jobDate = e.target.value;
    applyJobFilters();
  });
  bindOnce($('#task-form'), 'submit', async (e) => {
    e.preventDefault();
    const captured = drafts.capture(e.target);
    const f = new FormData(e.target),
      id = formOpportunityId,
      input = {
        text: String(f.get('text')).trim(),
        dueAt: String(f.get('dueAt')),
      },
      untouchedDefault =
        e.target.dataset.suggestedDefault === 'true' && !Object.keys(captured?.values ?? {}).length;
    try {
      const warning = await change(
        (data) => {
          if (untouchedDefault) {
            const opportunity = live(data.opportunities).find((item) => item.id === id),
              activities = live(data.activities).filter((item) => item.opportunityId === id),
              tasks = live(data.tasks).filter(
                (item) => item.opportunityId === id && item.status === '待办',
              ),
              currentDefaults = getTaskDefaults(opportunity, activities, tasks, today());
            if (!equal(input, currentDefaults)) {
              const error = new Error('岗位状态刚发生变化，已刷新下一步建议，请重新确认。');
              error.code = 'STALE_TASK_DEFAULT';
              throw error;
            }
          }
          data.tasks.push({
            id: uid(),
            opportunityId: id,
            ...input,
            status: '待办',
            createdAt: new Date().toISOString(),
          });
          return validateData(data);
        },
        undefined,
        { form: e.target, captured },
      );
      notify('下一步已安排，本机已保存。' + warning);
    } catch (e) {
      if (e.code === 'STALE_TASK_DEFAULT') await reload();
      report(e);
    }
  });
  bindOnce($('#activity-form'), 'submit', async (e) => {
    e.preventDefault();
    const captured = drafts.capture(e.target);
    const f = new FormData(e.target),
      id = formOpportunityId;
    try {
      const warning = await change(
        (data) => {
          data.activities.push({
            id: uid(),
            opportunityId: id,
            text: String(f.get('text')).trim(),
            date: String(f.get('date')),
            type: String(f.get('type')),
            createdAt: new Date().toISOString(),
          });
          if (f.get('type') === '发送简历') {
            const o = data.opportunities.find((o) => o.id === id);
            Object.assign(o, getSentResumeStatus(o), { updatedAt: new Date().toISOString() });
          }
          return validateData(data);
        },
        undefined,
        { form: e.target, captured },
      );
      notify('沟通记录已保存。' + warning);
    } catch (e) {
      report(e);
    }
  });
  bindOnce($('#settings-form'), 'submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const config = validateConfig({
        owner: String(f.get('owner')).trim(),
        repo: String(f.get('repo')).trim(),
        path: String(f.get('path')).trim(),
      });
      const different = !equal(config, state.config);
      if (different && state.pending) throw new Error('请先处理同步冲突，再切换仓库。');
      if (different && !confirm('切换同步目标后，本机记录会保留，并与新仓库的数据合并。继续切换？'))
        return;
      token = String(f.get('token')).trim();
      state = await updateState((s) => ({
        ...s,
        config,
        base: different ? emptyData() : s.base,
        lastSync: different ? '' : s.lastSync,
        pending: different ? null : s.pending,
      }));
      render();
      notify('连接设置已保存。令牌仅在当前页面使用。');
    } catch (e) {
      report(e);
    }
  });
}
function syncEditorResumeStatus(form) {
  const linked = getResumeLinkedStatus(Object.fromEntries(new FormData(form)));
  for (const [name, value] of Object.entries(linked)) form.elements.namedItem(name).value = value;
  const note = form.querySelector('[data-resume-linked-note]');
  note.hidden = !Object.keys(linked).length;
}
function refreshCompanyMatchHint(form) {
  const hint = form?.querySelector('[data-company-match-hint]');
  if (!hint || !state) return;
  if (composition.active) {
    deferredCompanyHint = true;
    return;
  }
  const matches = findCompanyMatches(state.data, {
    company: form.elements.namedItem('company').value,
    role: form.elements.namedItem('role').value,
    excludeId: form.dataset.companyMatchExcludeId || '',
  });
  if (!matches.length) {
    hint.hidden = true;
    hint.innerHTML = '';
    return;
  }
  const sameRole = matches.some((match) => match.sameRole),
    shown = matches.slice(0, 3);
  hint.innerHTML = `<strong>${sameRole ? '可能是重复岗位' : '该公司已有其他岗位'}</strong><span>找到 ${matches.length} 个未删除岗位，仍可继续保存。</span><span class="company-match-list">${shown
    .map(
      ({ opportunity, sameRole: roleMatches }) =>
        `<span><span>${esc(opportunity.role)}</span><span class="badge ${getOpportunityStatus(opportunity).stage === '沟通中' ? 'blue' : ''}">${esc(getOpportunityStatus(opportunity).stage)}</span>${roleMatches ? '<span class="company-match-same-role">岗位名称相同</span>' : ''}</span>`,
    )
    .join(
      '',
    )}</span>${matches.length > shown.length ? `<span>另有 ${matches.length - shown.length} 个，可在岗位页搜索公司查看。</span>` : ''}`;
  hint.hidden = false;
}
function openEditor(id = '', source) {
  if (id && !live(state.data.opportunities).some((o) => o.id === id))
    throw new Error('这个草稿对应的岗位已删除，内容仍可在草稿箱查看和复制。');
  let original = state.data.opportunities.find((o) => o.id === id) || {};
  const o = {
    company: '',
    role: '',
    platform: 'BOSS',
    source: '',
    contact: '',
    url: '',
    appliedAt: today(),
    stage: '已触达',
    readState: '未读',
    resumeState: '未知',
    endReason: '',
    priority: '普通',
    location: '',
    salary: '',
    notes: '',
    description: '',
    ...original,
    ...getOpportunityStatus(original),
  };
  $('#editor-content').innerHTML =
    `<form id="editor-form"><div class="dialog-header"><div><h2>${id ? '编辑岗位' : '新增岗位'}</h2><p>公司和岗位必填，其余可以稍后补充。</p></div><button type="button" class="close" data-close="editor-dialog" aria-label="关闭">×</button></div><div class="dialog-body"><div id="editor-error" class="error form-error" role="alert"></div><div class="form-grid">${[
      ['company', '公司'],
      ['role', '岗位'],
    ]
      .map(
        ([k, label]) =>
          `<label>${label}<input name="${k}" value="${esc(o[k])}" required maxlength="300">${!id && k === 'company' ? '<span class="company-match-hint" data-company-match-hint role="status" aria-live="polite" aria-atomic="true" hidden></span>' : ''}</label>`,
      )
      .join(
        '',
      )}<label>招聘阶段<select name="stage">${options(STAGES, o.stage)}</select></label><label>关注程度<select name="priority">${options(['普通', '重点', '暂缓'], o.priority)}</select></label><label>消息状态<select name="readState">${options(READ_STATES, o.readState)}</select></label><label>简历状态<select name="resumeState">${options(['未知', '被索要', '已发送', '对方已接收'], o.resumeState)}</select></label><p class="span-2 note-summary" data-resume-linked-note hidden>BOSS 简历已发送或已接收时，消息联动为已读，已触达推进为沟通中；面试及后续阶段保留，保存后生效。</p><label>首次联系<input type="date" name="appliedAt" value="${esc(o.appliedAt)}"></label><label>结束原因<select name="endReason"><option value="">未结束 / 未填写</option>${options(['不匹配/拒绝', '职位关闭', '主动放弃', '已入职', '其他'], o.endReason)}</select></label>${[
      ['platform', '平台'],
      ['source', '来源类型（如猎头、内推）'],
      ['contact', '联系人'],
      ['location', '地点'],
      ['salary', '薪资原文'],
      ['url', '岗位链接'],
    ]
      .map(
        ([k, label]) =>
          `<label>${label}<input name="${k}" ${k === 'url' ? 'type="url"' : ''} value="${esc(o[k])}"></label>`,
      )
      .join(
        '',
      )}<label class="span-2">备注<textarea name="notes">${esc(o.notes)}</textarea></label><label class="span-2">岗位描述<textarea name="description">${esc(o.description)}</textarea></label></div></div><div class="dialog-footer">${id ? `<button class="text-button danger" type="button" data-delete="${esc(id)}">删除岗位</button>` : ''}<button class="secondary" type="button" data-close="editor-dialog">取消</button><button class="primary" type="submit">保存岗位</button></div></form>`;
  const editorForm = $('#editor-form');
  syncEditorResumeStatus(editorForm);
  // Run before draft listeners so one input captures all linked fields together.
  for (const event of ['input', 'change'])
    editorForm.addEventListener(
      event,
      (e) => {
        if (e.isComposing || (e.target.name === 'platform' && event !== 'change')) return;
        if (['resumeState', 'stage', 'readState', 'platform'].includes(e.target.name))
          syncEditorResumeStatus(editorForm);
      },
      true,
    );
  const editing = drafts.bind(editorForm, {
    kind: 'editor',
    opportunityId: id,
    original,
    source,
  });
  // A legacy draft may contain values no longer present in the select options.
  // Preserve its original record for conflict detection; only map the form controls.
  const status = getOpportunityStatus({ ...o, ...editing?.values });
  for (const [name, value] of Object.entries(status))
    $('#editor-form').elements.namedItem(name).value = value;
  syncEditorResumeStatus(editorForm);
  if (!id) {
    for (const name of ['company', 'role'])
      bindCommittedTextInput(editorForm.elements.namedItem(name), () =>
        refreshCompanyMatchHint(editorForm),
      );
    refreshCompanyMatchHint(editorForm);
  }
  if (editing?.original) original = editing.original;
  if (
    id &&
    !equal(
      original,
      state.data.opportunities.find((o) => o.id === id),
    )
  )
    $('#editor-error').textContent =
      '原岗位已有新修改。草稿保留供核对；请复制需要的内容，丢弃旧草稿后重新编辑。';
  $('#editor-dialog').showModal();
  $('#editor-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const captured = drafts.capture(e.target);
    const input = Object.fromEntries(new FormData(e.target));
    for (const k in input) input[k] = input[k].trim();
    Object.assign(input, getResumeLinkedStatus(input));
    if (input.stage === '已结束' && !input.endReason) {
      $('#editor-error').textContent = '请选择结束原因。';
      return;
    }
    if (input.stage !== '已结束') input.endReason = '';
    const stamp = new Date().toISOString(),
      jobId = id || uid();
    e.target.dataset.companyMatchExcludeId = jobId;
    try {
      const warning = await change(
        (data) => {
          const current = data.opportunities.find((x) => x.id === jobId);
          if (id && !equal(current, original))
            throw new Error('这个岗位刚在其他页面发生了修改，请重新打开后编辑。');
          if (current) {
            if (getOpportunityStatus(current).stage !== input.stage)
              data.activities.push({
                id: uid(),
                opportunityId: jobId,
                date: today(),
                type: '阶段变化',
                text: `阶段从「${getOpportunityStatus(current).stage}」调整为「${input.stage}」`,
                createdAt: stamp,
              });
            Object.assign(current, input, { updatedAt: stamp });
          } else
            data.opportunities.push({ id: jobId, ...input, createdAt: stamp, updatedAt: stamp });
          if (input.stage === '已结束')
            for (const task of data.tasks) {
              if (task.opportunityId === jobId && !task.deletedAt && task.status === '待办')
                task.status = '取消';
            }
          return validateData(data);
        },
        undefined,
        { form: e.target, captured },
      );
      $('#editor-dialog').close();
      openDetail(jobId);
      notify(
        (input.stage === '已结束' ? '岗位已结束，未完成行动已取消。' : '岗位已保存。') + warning,
      );
    } catch (e) {
      $('#editor-error').textContent = e.message;
    }
  });
}
const { showRestore, showSnapshots } = createBackupUI({
  isSyncing: () => syncing,
  prepareDrafts: (rows) => drafts.store.prepareImport(rows),
  restored: async (next) => {
    drafts.refreshCount();
    state = next;
    closeDetail(false);
    channel?.postMessage('changed');
    render();
    notify('备份已恢复到本机，操作前快照已保留；请核对后手动同步。');
  },
  report,
});
async function showDrafts() {
  const rows = drafts.store.list();
  $('#draft-content').innerHTML =
    `<div class="dialog-header"><h2>本机草稿箱</h2><button class="close" data-close="draft-dialog" aria-label="关闭">×</button></div><div class="dialog-body"><p>草稿尚未提交，不会自动变成岗位或沟通记录。关闭表单会保留草稿。</p>${
      rows.length
        ? rows
            .map((d) => {
              const job = state.data.opportunities.find((o) => o.id === d.opportunityId);
              return `<section class="section-gap"><h3>${esc(d.kind === 'editor' ? (d.opportunityId ? '编辑岗位' : '新增岗位') : d.kind === 'task' ? '下一步行动' : '沟通记录')} · ${esc(d.values.company || job?.company || '未填写公司')}</h3><small>${esc(new Date(d.updatedAt).toLocaleString('zh-CN'))}</small><details><summary>查看草稿内容</summary><pre class="long-copy">${esc(JSON.stringify(d.values, null, 2))}</pre></details><div class="button-row"><button class="primary" data-draft-restore="${d.id}">继续填写</button><button class="text-button danger" data-draft-discard="${d.id}">丢弃草稿</button></div></section>`;
            })
            .join('')
        : '<p class="section-gap">没有未提交草稿。</p>'
    }</div>`;
  $('#draft-dialog').showModal();
  $('#draft-content').onclick = async (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    const id = button.dataset.draftRestore || button.dataset.draftDiscard;
    if (!id) return;
    try {
      const record = rows.find((d) => d.id === id);
      if (button.dataset.draftDiscard) {
        if (!confirm('丢弃这份未提交草稿？')) return;
        drafts.discard(record);
        render();
        await showDrafts();
        return;
      }
      if (
        record.opportunityId &&
        !live(state.data.opportunities).some((o) => o.id === record.opportunityId)
      )
        throw new Error('所属岗位已删除，请在“查看草稿内容”中复制需要的内容。');
      $('#draft-dialog').close();
      if (record.kind === 'editor') openEditor(record.opportunityId, record);
      else {
        openDetail(record.opportunityId, { section: record.kind, source: record });
      }
    } catch (e) {
      report(e);
    }
  };
}
async function showDiskBackups() {
  const { files } = await diskBackup.list();
  $('#import-content').innerHTML =
    `<div class="dialog-header"><h2>独立磁盘备份</h2><button class="close" data-close="import-dialog" aria-label="关闭">×</button></div><div class="dialog-body"><p>保存在本机私有目录 .local/backups/。每个浏览器来源保留最近30个备份日期的首份，以及最新一份；清理浏览器后仍可在这里找回。</p>${files.length ? files.map((f, i) => `<section class="section-gap"><p>${esc(f.file === 'latest.json' ? '最近一次备份' : f.file.slice(0, 10) + ' 首份')} · ${esc(new Date(f.savedAt).toLocaleString('zh-CN'))}</p><small>来源 ${esc(f.sourceId.slice(0, 8))} · ${(f.size / 1000).toFixed(1)} KB</small><div class="button-row"><button class="secondary" data-disk-download="${i}">下载备份</button><button class="secondary" data-disk-restore="${i}">恢复预览</button></div></section>`).join('') : '<p class="section-gap">还没有独立备份。新增内容后会自动保存，也可以点击“立即备份”。</p>'}</div>`;
  $('#import-dialog').showModal();
  $('#import-content').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const index = b.dataset.diskDownload ?? b.dataset.diskRestore;
    if (index === undefined) return;
    try {
      const file = files[Number(index)],
        backup = await diskBackup.read(file.sourceId, file.file);
      if (b.dataset.diskDownload !== undefined)
        download(
          `求职独立备份-${file.sourceId.slice(0, 8)}-${file.file}`,
          JSON.stringify(backup, null, 2),
          'application/json;charset=utf-8',
        );
      else {
        $('#import-content').onclick = null;
        await showRestore(backup);
      }
    } catch (e) {
      report(e);
    }
  };
}
async function diagnose() {
  if (syncing) return;
  const button = document.querySelector('[data-action="diagnose"]');
  if (button) button.disabled = true;
  try {
    const client = useSsh() ? localSshClient(localSsh.session) : githubClient(state.config, token);
    const result = await client.read();
    diagnostic = result.missing
      ? '连接正常，云端数据文件尚未初始化。'
      : '连接正常，云端数据可以读取；未上传任何记录。';
  } catch (e) {
    diagnostic = `${e.code || `HTTP_${e.status ?? 'UNKNOWN'}`}：${e.message}`;
  } finally {
    if (button) button.disabled = false;
    const out = document.querySelector('#diagnostic-result');
    if (out) out.textContent = diagnostic;
  }
}
async function importPreview(file) {
  if (utf8Bytes(file.text) > MAX_BACKUP_BYTES)
    throw new Error('备份文件超过 50 MB，请使用原始文件进行人工恢复。');
  importFile = file;
  if (file.name.endsWith('.json')) {
    await showRestore(JSON.parse(file.text));
    return;
  }
  await renderImport(String(new Date().getFullYear()));
  $('#import-dialog').showModal();
}
async function renderImport(year) {
  parsedImport = await parseMarkdown(importFile.text, year, importFile.name);
  $('#import-content').innerHTML =
    `<div class="dialog-header"><div><h2>核对导入记录</h2><p>${esc(importFile.name)} · 识别到 ${parsedImport.rows.length} 条</p></div><button class="close" data-close="import-dialog" aria-label="关闭">×</button></div><div class="dialog-body"><label>原文日期所属年份<input id="import-year" type="number" min="1900" max="2100" value="${esc(year)}"></label><p class="note-summary section-gap">重复岗位默认跳过，不覆盖已经补记的状态。字段有疑点时，核实后再勾选导入。</p><div class="import-list">${parsedImport.rows
      .map((row) => {
        const o = row.opportunity,
          exists = state.data.opportunities.some((x) => x.id === o.id);
        return `<div class="import-row"><input type="checkbox" class="import-check" value="${esc(o.id)}" aria-label="导入 ${esc(o.company)}" ${exists ? 'disabled' : row.issue ? '' : 'checked'}><div class="import-info"><div class="company">${esc(o.company)} · ${esc(o.role)}</div><small>${esc(o.appliedAt)} · ${esc(o.rawStatus)}${exists ? ' · 已存在，将跳过' : ''}</small>${row.issue ? `<label class="swap-check"><input type="checkbox" class="swap-check-input" value="${esc(o.id)}">确认公司和岗位填反，交换后导入</label>` : ''}</div></div>`;
      })
      .join(
        '',
      )}</div></div><div class="dialog-footer"><button class="secondary" data-close="import-dialog">取消</button><button class="primary" id="confirm-import">导入选中记录</button></div>`;
  $('#import-year').addEventListener('change', (e) => renderImport(e.target.value).catch(report));
  document.querySelectorAll('.swap-check-input').forEach((c) =>
    c.addEventListener('change', () => {
      c.closest('.import-row').querySelector('.import-check').checked = c.checked;
    }),
  );
  $('#confirm-import').onclick = async () => {
    try {
      const chosen = [...document.querySelectorAll('.import-check:checked')].map((c) => c.value),
        swaps = [...document.querySelectorAll('.swap-check-input:checked')].map((c) => c.value);
      if (!chosen.length) throw new Error('请至少选择一条未导入的记录。');
      let result;
      await change((data) => {
        result = applyImport(data, parsedImport, chosen, swaps);
        return result.data;
      }, '导入 Markdown 前');
      navigate('list');
      $('#import-dialog').close();
      notify(`已新增 ${result.added} 个岗位，跳过 ${result.skipped} 个重复岗位。`);
    } catch (e) {
      report(e);
    }
  };
}
async function showConflicts(pending) {
  const label = (row) =>
    row
      ? row.deletedAt
        ? '此记录已删除'
        : row.company
          ? `${row.company} · ${row.role}\n阶段：${getOpportunityStatus(row).stage}\n简历：${row.resumeState || '未知'}\n备注：${row.notes || '无'}\n\n${JSON.stringify(row, null, 2)}`
          : JSON.stringify(row, null, 2)
      : '此版本没有这条记录';
  $('#conflict-content').innerHTML =
    `<form id="conflict-form"><div class="dialog-header"><div><h2>选择要保留的版本</h2><p>本机与云端修改了同一条记录，尚未覆盖任何一方。</p></div><button class="close" type="button" data-close="conflict-dialog" aria-label="稍后处理">×</button></div><div class="dialog-body">${pending.conflicts.map((c, i) => `<section class="conflict-item"><h3>冲突 ${i + 1}${c.relational ? ' · 岗位删除与关联记录冲突' : ''}</h3><div class="conflict-options">${['local', 'remote'].map((side) => `<label><input type="radio" name="${esc(c.key)}" value="${side}" required>${side === 'local' ? '保留本机' : '保留云端'}<pre>${esc(label(c[side]))}</pre></label>`).join('')}</div></section>`).join('')}</div><div class="dialog-footer"><button class="secondary" type="button" data-close="conflict-dialog">稍后处理</button><button class="primary" type="submit">保存选择</button></div></form>`;
  $('#conflict-dialog').showModal();
  $('#conflict-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const choices = Object.fromEntries(new FormData(e.target));
      state = await updateState((s) => {
        if (s.generation !== pending.generation)
          throw new Error('本机记录已变化，请关闭后再次同步，重新核对冲突。');
        s.data = resolveConflicts(pending.data, pending.conflicts, choices);
        if (pending.remote) s.base = pending.remote;
        s.pending = null;
        s.generation++;
        return s;
      });
      channel?.postMessage('changed');
      $('#conflict-dialog').close();
      render();
      notify('冲突选择已保存，请再次同步提交。');
    } catch (e) {
      report(e);
    }
  };
}
async function synchronize(allowCreate = false) {
  if (syncing) return;
  if (state.pending) {
    if (state.pending.generation === state.generation) {
      await showConflicts(state.pending);
      return;
    }
    state = await updateState((s) => ({ ...s, pending: null }));
  }
  if (!useSsh() && !token) {
    navigate('settings');
    notify('请在此页面配置本次会话的 GitHub 令牌。');
    return;
  }
  syncing = true;
  statusRender();
  try {
    await saveSnapshot('同步前');
    const run = async () =>
      syncWorkspace({
        client: useSsh() ? localSshClient(localSsh.session) : githubClient(state.config, token),
        readState,
        updateState,
        allowCreate,
      });
    const result = navigator.locks
      ? await navigator.locks.request('job-tracker-sync', { ifAvailable: true }, (lock) => {
          if (!lock) throw new Error('另一个页面正在同步，请稍后再试。');
          return run();
        })
      : await run();
    if (result.needsCreate) {
      syncing = false;
      statusRender();
      if (
        confirm(
          `私有仓库 ${state.config.owner}/${state.config.repo} 中没有 ${state.config.path}。创建此数据文件并上传本机记录？`,
        )
      )
        await synchronize(true);
      return;
    }
    if (result.conflicts) {
      state = await updateState((s) => {
        if (s.generation !== result.generation) throw new Error('本机记录刚发生修改，请重新同步。');
        s.pending = result;
        return s;
      });
      await showConflicts(result);
    } else {
      state = result.state;
      if (result.pending) await showConflicts(state.pending);
      else notify(result.dirty ? '本次上传完成，新修改仍待同步。' : '已与 GitHub 同步。');
    }
    channel?.postMessage('changed');
  } catch (e) {
    report(e);
  } finally {
    syncing = false;
    await reload(true);
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.close) {
      document.getElementById(b.dataset.close).close();
      return;
    }
    if (b.dataset.view) {
      navigate(b.dataset.view);
      return;
    }
    if (b.hasAttribute('data-close-detail')) {
      closeDetail();
      return;
    }
    if (b.dataset.detailSection) {
      focusDetailSection(b.dataset.detailSection);
      return;
    }
    if (b.dataset.actionTab || b.hasAttribute('data-organize-new')) {
      rememberScroll();
      closeDetail(false);
      actionTab = b.dataset.actionTab || 'organize';
      render();
      if (b.hasAttribute('data-organize-new')) {
        const target = $('#new-unplanned');
        target?.scrollIntoView({ block: 'start' });
        target?.querySelector('button')?.focus({ preventScroll: true });
      } else window.scrollTo(0, scrollPositions.get(viewKey()) || 0);
      return;
    }
    if (b.dataset.jobDateStep) {
      if (jobDate) jobDate = addCalendarDays(jobDate, Number(b.dataset.jobDateStep));
      applyJobFilters();
      return;
    }
    if (
      b.hasAttribute('data-job-date-today') ||
      b.hasAttribute('data-job-date-clear') ||
      b.hasAttribute('data-clear-filters')
    ) {
      jobDate = b.hasAttribute('data-job-date-today') ? today() : '';
      if (b.hasAttribute('data-clear-filters')) {
        query = '';
        filter = '';
      }
      applyJobFilters();
      return;
    }
    if (b.hasAttribute('data-due-offset')) {
      const form = b.closest('#task-form'),
        dueAt = form?.elements.namedItem('dueAt');
      if (dueAt) {
        dueAt.value = datePresetValue(b);
        dueAt.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (b.dataset.planJob) {
      openDetail(b.dataset.planJob, { trigger: b, section: 'task' });
      return;
    }
    if (b.dataset.suggestionKind) {
      const choice = b.dataset.suggestionChoice,
        opportunityId = b.dataset.opportunityId,
        stamp = new Date().toISOString();
      let applied = false;
      openDetail(opportunityId, { trigger: b });
      await change((data) => {
        const next = applyVerificationChoice(data, {
          opportunityId,
          kind: b.dataset.suggestionKind,
          choice,
          id: uid(),
          date: today(),
          stamp,
        });
        applied = !equal(next, data);
        return next;
      });
      notify(
        applied
          ? choice === 'done'
            ? '核实结果已保存。'
            : '已加入今天的行动。'
          : '这项建议已在其他页面处理，已刷新最新状态。',
      );
      return;
    }
    if (b.dataset.job) {
      openDetail(b.dataset.job, { trigger: b });
      return;
    }
    if (b.dataset.page) {
      page += Number(b.dataset.page);
      updateListResults();
      return;
    }
    if (b.dataset.complete || b.dataset.cancelTask) {
      const taskId = b.dataset.complete || b.dataset.cancelTask,
        stamp = new Date().toISOString();
      await change((data) =>
        applyTaskChoice(data, {
          taskId,
          choice: b.dataset.complete ? 'complete' : 'cancel',
          id: uid(),
          date: today(),
          stamp,
        }),
      );
      notify(b.dataset.complete ? '行动已完成。' : '行动已取消。');
      return;
    }
    if (b.dataset.delete) {
      if (!confirm('删除这个岗位及其关联记录？删除标记也会在下次同步时上传。')) return;
      await change((data) => {
        removeOpportunity(data, b.dataset.delete);
        return data;
      }, '删除岗位前');
      $('#editor-dialog').close();
      closeDetail();
      notify('岗位已删除。');
      return;
    }
    const action = b.dataset.action;
    if (b.id === 'draft-button') await showDrafts();
    else if (action === 'backup-now') await diskBackup.run();
    else if (action === 'disk-backups') await showDiskBackups();
    else if (action === 'new' || b.id === 'new-button') openEditor();
    else if (action === 'edit') {
      openEditor(b.dataset.id);
      if (b.dataset.editorFocus === 'stage') $('#editor-form select[name="stage"]')?.focus();
    } else if (action === 'choose-file' || b.id === 'import-button') $('#file-input').click();
    else if (action === 'local-import') {
      const res = await fetch('./__local/source');
      if (!res.ok) throw new Error('未连接本地源文档，请使用“选择 Markdown”导入。');
      await importPreview({ name: '个人记录.md', text: await res.text() });
    } else if (action === 'export-json')
      download(
        `求职备份-${today()}.json`,
        JSON.stringify(createBackup(await readState(), drafts.store.list()), null, 2),
        'application/json;charset=utf-8',
      );
    else if (action === 'snapshots') await showSnapshots();
    else if (action === 'raw-backup')
      download(
        `求职原始状态-${today()}.json`,
        JSON.stringify(
          { backupVersion: 1, appVersion: APP_VERSION, workspace: await readRawState() },
          null,
          2,
        ),
        'application/json;charset=utf-8',
      );
    else if (action === 'diagnose') await diagnose();
    else if (action === 'export-md')
      download(`求职记录-${today()}.md`, markdownExport(state.data), 'text/markdown;charset=utf-8');
    else if (action === 'sync' || b.id === 'sync-button') await synchronize();
    else if (action === 'forget-token') {
      token = '';
      render();
      notify('当前页面的令牌已清除。');
    } else if (action === 'resolve-pending') await synchronize();
  } catch (e) {
    report(e);
  }
});
document.addEventListener('keydown', (e) => {
  if (
    e.key === 'Escape' &&
    !e.isComposing &&
    !composition.active &&
    selected &&
    !document.querySelector('dialog[open]')
  ) {
    e.preventDefault();
    closeDetail();
  }
});
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) {
    try {
      await importPreview({ name: file.name, text: await file.text() });
    } catch (e) {
      report(e);
    }
  }
  e.target.value = '';
});
channel?.addEventListener('message', async () => {
  state = await readState();
  statusRender();
  refreshCompanyMatchHint($('#editor-form'));
  const active = document.activeElement,
    selectedDeleted =
      selected && !live(state.data.opportunities).some((row) => row.id === selected),
    inputFocused = ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName),
    pristineSuggestedTask =
      active?.form?.id === 'task-form' &&
      active.form.dataset.suggestedDefault === 'true' &&
      !Object.keys(drafts.capture(active.form)?.values ?? {}).length;
  if (
    selectedDeleted ||
    (!document.querySelector('dialog[open]') && (!inputFocused || pristineSuggestedTask))
  )
    render(pristineSuggestedTask || selectedDeleted);
});
window.addEventListener('offline', () => notify('当前离线，记录继续保存在本机。'));
window.addEventListener('online', () => notify('网络已恢复，可以点击“立即同步”。'));
$('#app-version').textContent = `v${APP_VERSION}`;
$('#date-label').textContent = new Date().toLocaleDateString('zh-CN', {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
});
try {
  state = await readState();
  localSsh = await discoverLocalSsh();
  selected = '';
  render();
  drafts.refreshCount();
  diskBackup.start();
} catch (e) {
  $('#app-content').innerHTML =
    `<section class="panel empty"><h2>本地记录暂时无法打开</h2><p>${esc(e.message)}</p><button class="secondary" data-action="raw-backup">导出原始本地状态</button><p>原始导出用于修复，不会改动现有记录。</p></section>`;
}
// Optional browser agent interface: opens the same visible form, without saving or syncing data.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  Promise.resolve(
    document.modelContext.registerTool(
      {
        name: 'start_job_entry',
        title: '打开新增岗位',
        description: '打开求职工作台的新增岗位表单；不会保存数据或发起云端同步。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!input || Object.keys(input).length) throw new Error('此操作不接受参数。');
          if (!state) throw new Error('本地数据尚未就绪。');
          openEditor();
          return { opened: true };
        },
      },
      { signal: lifecycle.signal },
    ),
  ).catch(() => {});
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}

window.addEventListener('storage', (e) => {
  if (e.key?.startsWith('job-tracker-draft')) drafts.refreshCount();
});
