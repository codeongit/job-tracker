import { canonical, equal, live, resolveConflicts } from './model.js';
import { $, esc } from './ui.js';
import { ATTRIBUTION_REASONS } from './boss-attribution.js';
import { RESUME_RULES } from './resume-rules.js';

const GROUP_LABELS = {
  opportunities: '岗位',
  activities: '沟通记录',
  tasks: '跟进任务',
  imports: '导入记录',
  sourceBindings: '平台绑定',
  sourceEvents: '平台观察',
  sourceFacts: '来源事实',
  sourceApplications: '观察处理决定',
};
const FIELD_LABELS = {
  company: '公司',
  role: '岗位名称',
  platform: '平台',
  source: '招聘来源',
  contact: '联系人',
  url: '岗位链接',
  canonicalUrl: '规范岗位链接',
  externalId: '平台岗位身份',
  externalJobId: '平台岗位身份',
  opportunityId: '关联岗位',
  appliedAt: '首次联系日期',
  stage: '招聘阶段',
  endReason: '结束原因',
  resumeState: '简历状态',
  readState: '消息状态',
  priority: '优先级',
  location: '地点',
  salary: '薪资',
  description: '岗位说明',
  notes: '备注',
  rawStatus: '原始状态',
  platformJobState: '平台职位状态',
  platformJobStateSource: '职位状态来源',
  platformJobStateAt: '职位状态确认时间',
  date: '日期',
  type: '记录类型',
  text: '内容',
  dueAt: '计划日期',
  status: '处理状态',
  completedAt: '完成时间',
  filename: '导入文件',
  year: '导入年份',
  importedAt: '导入时间',
  rawText: '导入原文',
  kind: '绑定类型',
  accountNamespace: '平台账号',
  workspaceSourceId: '所属本机工作区',
  autoFields: '自动维护字段',
  lastAutoCompany: '上次自动维护公司',
  lastAutoRole: '上次自动维护岗位',
  lastAutoUrl: '上次自动维护链接',
  lastAutoContact: '上次自动维护联系人',
  lastAutoPlatform: '上次自动维护平台',
  lastAutoExternalId: '上次自动维护岗位身份',
  lastAutoResumeState: '上次自动维护简历状态',
  lastAutoReadState: '上次自动维护消息状态',
  lastAutoStage: '上次自动维护阶段',
  batchId: '采集批次',
  factId: '关联来源事实',
  legacyEventId: '关联旧观察',
  conversationKey: '会话身份',
  friendId: '联系人身份',
  friendSource: '联系人来源',
  uniqueId: '会话标识',
  messageId: '消息身份',
  messageDirection: '消息方向',
  receiptStatus: '消息回执',
  receiptSource: '回执来源',
  eventType: '观察类型',
  summary: '观察摘要',
  timeLabel: '平台时间',
  jobName: '平台岗位名称',
  nameSource: '岗位资料来源',
  linkConfirmation: '链接依据',
  observedAt: '观察时间',
  evidenceDate: '依据日期',
  appliedAtSource: '首次联系日期来源',
  sourceSnapshot: '采集快照',
  sourceSequence: '采集顺序',
  importPolicy: '导入策略',
  factType: '事实类型',
  evidenceSource: '依据来源',
  evidenceRef: '依据引用',
  ruleVersion: '应用规则版本',
  action: '处理动作',
  reason: '处理原因',
  resolutionSource: '人工处理来源',
  resolvedJobId: '人工确认岗位身份',
  resolvedJobUrl: '人工确认岗位链接',
};
const VALUES = {
  unknown: '未知',
  open: '开放',
  closed: '已关闭',
  manual: '人工确认',
  account: '账号绑定',
  opportunity: '岗位绑定',
  boss: 'BOSS',
  applied: '已应用',
  protected: '人工决定已保留',
  waiting: '等待资料或依据',
  review: '需要核对',
  no_effect: '已处理，无需修改岗位',
  ignored: '已忽略',
  outgoing: '本人发出',
  incoming: '对方发出',
  delivered: '已送达',
  read: '已读',
  conversation_observed: '普通消息与回执观察',
  resume_observed: '简历观察',
  message_observed: '普通消息事实',
  message_receipt_read: '消息已读事实',
  message_receipt_delivered: '消息送达事实',
  ordinary_message_observed: '普通消息观察',
  resume_sent_observed: '简历发送观察',
  resume_requested_observed: '简历请求观察',
  resume_received_observed: '简历接收观察',
  message_receipt_observed: '消息回执',
  resume_sent: '简历发送事实',
  resume_requested: '简历请求事实',
  resume_received: '简历接收事实',
  ordinary_message: '普通消息事实',
  message_delivered: '消息送达事实',
  message_read: '消息已读事实',
  user_confirmed_job_details: '已人工确认岗位资料',
  user_ignored_unresolved_observation: '已人工忽略旧观察',
  missing_job_details: '缺少岗位资料',
  identity_conflict: '岗位资料存在差异',
  attribution_message_multiple_jobs: '同一消息关联多个岗位',
  attribution_conversation_job_changed: '会话关联岗位发生变化',
  entity_sync_conflict: '关联岗位存在同步冲突',
  missing_message_identity: '缺少稳定消息身份',
  observation_recorded: '观察已处理',
  existing_job_details_available: '已采用本机岗位资料',
  ...ATTRIBUTION_REASONS,
  ...Object.fromEntries(RESUME_RULES.map((rule) => [rule.summary, rule.label])),
};
const TECHNICAL_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt']);
const ID_FIELDS = new Set([
  'externalId',
  'externalJobId',
  'accountNamespace',
  'workspaceSourceId',
  'factId',
  'legacyEventId',
  'batchId',
  'conversationKey',
  'friendId',
  'friendSource',
  'uniqueId',
  'messageId',
  'sourceSnapshot',
  'sourceSequence',
  'evidenceRef',
  'resolvedJobId',
]);
const shortIdentity = (value) =>
  String(value).length > 12
    ? `${String(value).slice(0, 4)}…${String(value).slice(-8)}`
    : String(value);
const ENUM_FIELDS = new Set([
  'platform',
  'kind',
  'status',
  'platformJobState',
  'platformJobStateSource',
  'messageDirection',
  'receiptStatus',
  'eventType',
  'factType',
  'summary',
  'reason',
  'action',
  'resolutionSource',
  'evidenceSource',
  'importPolicy',
  'nameSource',
  'linkConfirmation',
]);
const rowState = (row) => (!row ? '此版本没有这条记录' : row.deletedAt ? '已删除' : '保留记录');
const titleForJob = (row) => [row?.company, row?.role].filter(Boolean).join(' · ');
function findRow(data, group, id) {
  return (data?.[group] || []).find((row) => row.id === id);
}
function jobLabel(data, id) {
  const row = findRow(data, 'opportunities', id);
  return titleForJob(row) || (id ? `未找到岗位名称（${shortIdentity(id)}）` : '未关联岗位');
}
function opportunityForConflict(conflict, data) {
  if (conflict.group === 'opportunities') return conflict.id;
  const rows = [conflict.local, conflict.remote, conflict.base].filter(Boolean);
  const ids = new Set(rows.map((row) => row.opportunityId).filter(Boolean));
  if (conflict.group === 'sourceFacts') {
    for (const row of rows) {
      for (const application of data?.sourceApplications || []) {
        if (!application.deletedAt && application.factId === row.id && application.opportunityId)
          ids.add(application.opportunityId);
      }
      const event = findRow(data, 'sourceEvents', row.legacyEventId);
      if (event?.opportunityId) ids.add(event.opportunityId);
    }
  }
  return ids.size === 1 ? [...ids][0] : '';
}
function readableValue(field, value, data) {
  if (value === undefined || value === null) return '未提供';
  if (value === '') return '未填写';
  if (field === 'opportunityId') return jobLabel(data, value);
  if (field === 'autoFields')
    return String(value)
      .split(',')
      .map((key) => FIELD_LABELS[key] || key)
      .join('、');
  if (ID_FIELDS.has(field)) return shortIdentity(value);
  if (ENUM_FIELDS.has(field) && VALUES[value]) return VALUES[value];
  if (field === 'rawText') return `原文 ${String(value).length} 字，详见技术详情`;
  if (
    [
      'reason',
      'action',
      'resolutionSource',
      'evidenceSource',
      'importPolicy',
      'nameSource',
      'linkConfirmation',
    ].includes(field)
  )
    return '来源或处理依据不同，详见技术详情';
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、') || '空列表';
  if (typeof value === 'object') return '结构化资料，详见技术详情';
  return String(value);
}

export function describeSyncConflict(conflict, data = {}) {
  const local = conflict.local,
    remote = conflict.remote;
  const fields = [];
  if (rowState(local) !== rowState(remote))
    fields.push({
      field: '$presence',
      label: '记录是否保留',
      local: rowState(local),
      remote: rowState(remote),
    });
  const keys = [...new Set([...Object.keys(local || {}), ...Object.keys(remote || {})])];
  for (const field of keys) {
    if (TECHNICAL_FIELDS.has(field) || equal(local?.[field], remote?.[field])) continue;
    fields.push({
      field,
      label: FIELD_LABELS[field] || '其他记录字段',
      local: readableValue(field, local?.[field], data),
      remote: readableValue(field, remote?.[field], data),
    });
  }
  const opportunityId = opportunityForConflict(conflict, data);
  const title =
    conflict.group === 'opportunities'
      ? titleForJob(local) || titleForJob(remote) || titleForJob(conflict.base) || '岗位资料'
      : `${GROUP_LABELS[conflict.group] || '记录'}${opportunityId ? ` · ${jobLabel(data, opportunityId)}` : ''}`;
  const kind =
    conflict.group === 'sourceBindings' && (local?.kind || remote?.kind) === 'account'
      ? '平台账号绑定'
      : GROUP_LABELS[conflict.group] || '记录';
  const linked =
    conflict.group === 'opportunities'
      ? {
          activities: live(data.activities || []).filter((row) => row.opportunityId === conflict.id)
            .length,
          tasks: live(data.tasks || []).filter((row) => row.opportunityId === conflict.id).length,
        }
      : { activities: 0, tasks: 0 };
  return { title, kind, opportunityId, fields, relational: Boolean(conflict.relational), linked };
}

export function groupSyncConflicts(pending, data = pending?.data || {}) {
  const groups = new Map();
  for (const conflict of pending?.conflicts || []) {
    const described = describeSyncConflict(conflict, data);
    const key = described.opportunityId
      ? `job:${described.opportunityId}`
      : `record:${conflict.key}`;
    if (!groups.has(key))
      groups.set(key, {
        key,
        title: described.opportunityId ? jobLabel(data, described.opportunityId) : described.title,
        conflicts: [],
      });
    const group = groups.get(key);
    if (conflict.group === 'opportunities') group.title = described.title;
    group.conflicts.push(conflict);
  }
  return [...groups.values()];
}

export function syncConflictSignature(pending, generation) {
  return canonical({ generation, pending });
}
export function completeSyncConflictChoices(pending, choices) {
  return (
    Boolean(pending?.conflicts.length) &&
    pending.conflicts.every((conflict) => ['local', 'remote'].includes(choices[conflict.key]))
  );
}
function deletionImpact(conflict, described, side) {
  const row = conflict[side];
  if (row && !row.deletedAt) return '';
  if (conflict.group === 'opportunities')
    return `<p class="warning">选择此版本将删除岗位；当前候选中的 ${described.linked.activities} 条沟通记录、${described.linked.tasks} 项任务会一并标记删除。删除标记保留，保存后不会自动上传。</p>`;
  if (conflict.group === 'sourceBindings')
    return `<p class="warning">选择此版本将删除这项平台绑定，可能影响后续采集或观察应用；其他来源材料保留，并由服务校验关联关系。</p>`;
  return '<p class="warning">选择此版本将保留删除决定，不会自动清除来源材料或上传。</p>';
}
function renderConflict(conflict, data, choices, disabled, protectedAccountIds = new Set()) {
  const described = describeSyncConflict(conflict, data),
    chosen = choices[conflict.key];
  const fieldRows = described.fields
    .map(
      (field) =>
        `<tr><th scope="row">${esc(field.label)}</th><td>${esc(field.local)}</td><td>${esc(field.remote)}</td></tr>`,
    )
    .join('');
  const keepsAccount =
    protectedAccountIds.has(conflict.id) &&
    conflict.group === 'sourceBindings' &&
    conflict[chosen]?.kind === 'account' &&
    conflict[chosen]?.platform === 'boss' &&
    !conflict[chosen]?.deletedAt;
  const selectedValues = chosen
    ? described.fields
        .map(
          (field) =>
            `<li>${esc(field.label)}：${esc(keepsAccount && field.field === 'workspaceSourceId' ? '仍保留当前本机工作区' : field[chosen])}</li>`,
        )
        .join('')
    : '';
  const selected = chosen
    ? `<div class="sync-conflict-result" role="status"><h4>选择后的结果：保留${chosen === 'local' ? '本机' : '云端'}版本</h4>${selectedValues ? `<ul>${selectedValues}</ul>` : ''}<p>${esc(rowState(conflict[chosen]))}。无冲突的独立修改仍保留；岗位与任务的关联状态按完整候选一起保存。</p>${keepsAccount ? '<p>仍有效的 BOSS 账号继续归属当前本机服务；选择云端资料不会转移该账号。</p>' : ''}${deletionImpact(conflict, described, chosen)}</div>`
    : '<p class="muted">尚未选择。请核对两边内容，不会按更新时间自动决定。</p>';
  return `<section class="conflict-item"><h3>${esc(described.kind)}</h3><p>本机与云端对以下内容有不同修改，保存前不会覆盖任何一方。</p>${described.relational ? '<p class="warning">一边删除了岗位，另一边仍有沟通或任务。请先核对删除影响。</p>' : ''}${fieldRows ? `<div class="sync-conflict-table-wrap"><table class="sync-conflict-table"><thead><tr><th scope="col">不同内容</th><th scope="col">本机</th><th scope="col">云端</th></tr></thead><tbody>${fieldRows}</tbody></table></div>` : '<p>记录元信息不同，请展开技术详情核对。</p>'}<div class="conflict-options">${['local', 'remote'].map((side) => `<label><input type="radio" name="${esc(conflict.key)}" value="${side}" data-sync-conflict-choice="${esc(conflict.key)}" ${chosen === side ? 'checked' : ''} ${disabled ? 'disabled' : ''}>保留${side === 'local' ? '本机' : '云端'}版本</label>`).join('')}</div>${selected}<details class="section-gap" data-sync-conflict-details="${esc(conflict.key)}"><summary>技术详情：完整候选</summary><h4>本机候选</h4><pre>${esc(JSON.stringify(conflict.local ?? null, null, 2))}</pre><h4>云端候选</h4><pre>${esc(JSON.stringify(conflict.remote ?? null, null, 2))}</pre></details></section>`;
}

export function syncConflictView(pending, data, choices = {}, index = 0, options = {}) {
  const {
    review = false,
    busy = false,
    stale = false,
    error = '',
    protectedAccountIds = new Set(),
  } = options;
  const groups = groupSyncConflicts(pending, data),
    complete = completeSyncConflictChoices(pending, choices);
  const active = groups[Math.min(Math.max(index, 0), Math.max(groups.length - 1, 0))];
  const allChosen = active?.conflicts.every((conflict) =>
    ['local', 'remote'].includes(choices[conflict.key]),
  );
  let reviewError = '';
  if ((review || groups.length === 1) && complete) {
    try {
      resolveConflicts(pending.data, pending.conflicts, choices);
    } catch (failure) {
      reviewError = failure.message;
    }
  }
  const disabled = busy || stale;
  return `<form id="conflict-form"><div class="dialog-header"><div><h2>${review ? '确认全部同步选择' : '核对本机与云端差异'}</h2><p>${review ? `共 ${groups.length} 组、${pending.conflicts.length} 项冲突；全部选择一次保存。` : `第 ${index + 1} / ${groups.length} 组 · 共 ${pending.conflicts.length} 项冲突`}</p></div><button class="close" type="button" data-sync-conflict-action="close" aria-label="稍后处理" ${busy ? 'disabled' : ''}>×</button></div><div class="dialog-body">${stale ? '<div class="warning" role="status">正式记录或冲突已变化。已保留页面选择，但需要重新读取并核对最新内容后才能保存。<button class="secondary" type="button" data-sync-conflict-action="reload">重新核对最新内容</button></div>' : ''}${error || reviewError ? `<p class="error" role="alert">${esc(error || reviewError)}</p>` : ''}${review ? groups.map((group) => `<section><h3>${esc(group.title)}</h3>${group.conflicts.map((conflict) => renderConflict(conflict, data, choices, disabled, protectedAccountIds)).join('')}</section>`).join('') : `<h3 tabindex="-1">${esc(active?.title || '同步冲突')}</h3>${(active?.conflicts || []).map((conflict) => renderConflict(conflict, data, choices, disabled, protectedAccountIds)).join('')}`}</div><div class="dialog-footer"><button class="secondary" type="button" data-sync-conflict-action="close" ${busy ? 'disabled' : ''}>稍后处理</button>${review || index > 0 ? `<button class="secondary" type="button" data-sync-conflict-action="previous" ${disabled ? 'disabled' : ''}>${review ? '返回逐组核对' : '上一组'}</button>` : ''}${review || groups.length === 1 ? `<button class="primary" type="submit" data-sync-conflict-action="save" ${disabled || !complete || reviewError ? 'disabled' : ''}>${busy ? '保存中…' : '保存全部选择'}</button>` : `<button class="primary" type="button" data-sync-conflict-action="next" ${disabled || !allChosen ? 'disabled' : ''}>${index + 1 < groups.length ? '下一组' : '查看全部选择'}</button>`}</div></form>`;
}

export function createSyncConflictUI({
  readState,
  resolveSyncConflict,
  saved,
  report,
  sync,
  closed = () => {},
  isUnavailable = () => false,
  getWorkspaceId = () => '',
  getDialog = () => $('#conflict-dialog'),
  getContent = () => $('#conflict-content'),
}) {
  let session = null,
    opened = false;
  function render() {
    if (!session) return;
    const content = getContent(),
      scrollTop = getDialog().scrollTop || 0;
    session.disclosures ??= new Map();
    for (const details of content.querySelectorAll('[data-sync-conflict-details]'))
      session.disclosures.set(details.dataset.syncConflictDetails, details.open);
    content.innerHTML = session.saved
      ? '<div class="dialog-header"><h2>本机已保存，待同步</h2><button class="close" type="button" data-sync-conflict-action="close" aria-label="关闭">×</button></div><div class="dialog-body"><p>全部冲突选择已一起保存。GitHub 尚未上传，请明确执行同步。</p></div><div class="dialog-footer"><button class="secondary" type="button" data-sync-conflict-action="close">返回原问题</button><button class="primary" type="button" data-sync-conflict-action="sync">立即同步 GitHub</button></div>'
      : syncConflictView(session.pending, session.data, session.choices, session.index, session);
    for (const details of content.querySelectorAll('[data-sync-conflict-details]'))
      details.open = session.disclosures.get(details.dataset.syncConflictDetails) || false;
    getDialog().scrollTop = scrollTop;
    const form = getContent().querySelector?.('#conflict-form');
    if (form)
      form.onsubmit = (event) => {
        event.preventDefault();
        if (session.review || groupSyncConflicts(session.pending, session.data).length === 1)
          void save().catch(report);
        else getContent().querySelector('[data-sync-conflict-action="next"]')?.click();
      };
    getContent().onchange = (event) => {
      const input = event.target.closest('[data-sync-conflict-choice]');
      if (!input || session.busy || session.stale) return;
      session.choices[input.dataset.syncConflictChoice] = input.value;
      const key = input.dataset.syncConflictChoice,
        value = input.value;
      render();
      [...getContent().querySelectorAll('[data-sync-conflict-choice]')]
        .find((element) => element.dataset.syncConflictChoice === key && element.value === value)
        ?.focus();
    };
    getContent().onclick = async (event) => {
      const button = event.target.closest('[data-sync-conflict-action]');
      if (!button || button.disabled) return;
      event.preventDefault?.();
      try {
        const action = button.dataset.syncConflictAction;
        if (action === 'close') {
          if (!session.busy) getDialog().close();
        } else if (action === 'reload') await show();
        else if (action === 'sync') {
          getDialog().close();
          await sync();
        } else if (action === 'previous') {
          if (session.review) session.review = false;
          else session.index = Math.max(session.index - 1, 0);
          render();
        } else if (action === 'next') {
          const groups = groupSyncConflicts(session.pending, session.data);
          if (session.index + 1 < groups.length) session.index++;
          else session.review = true;
          render();
          getDialog().scrollTop = 0;
          getContent().querySelector('.dialog-body h3')?.focus?.();
        } else if (action === 'save') await save();
      } catch (error) {
        report(error);
      }
    };
  }
  function changed(current) {
    return (
      !current?.pending ||
      syncConflictSignature(current.pending, current.generation) !== session.signature
    );
  }
  async function show() {
    const current = await readState();
    if (isUnavailable())
      throw new Error('本机连接尚未恢复，当前可能是上次状态。请恢复连接后重新核对同步冲突。');
    if (!current.pending?.conflicts.length)
      throw new Error('当前已没有这批同步冲突，请刷新核对最新状态。');
    const signature = syncConflictSignature(current.pending, current.generation);
    if (!session || signature !== session.signature || session.stale || session.saved)
      session = {
        signature,
        pending: structuredClone(current.pending),
        data: current.pending.data,
        choices: {},
        index: 0,
        review: false,
        busy: false,
        stale: false,
        error: '',
        protectedAccountIds: new Set(
          (current.data?.sourceBindings || [])
            .filter(
              (binding) =>
                binding.kind === 'account' &&
                binding.platform === 'boss' &&
                !binding.deletedAt &&
                binding.workspaceSourceId === getWorkspaceId(),
            )
            .map((binding) => binding.id),
        ),
      };
    render();
    const dialog = getDialog();
    if (!opened) {
      dialog.addEventListener('cancel', (event) => {
        if (session?.busy) event.preventDefault();
      });
      dialog.addEventListener('close', () => closed());
      opened = true;
    }
    if (!dialog.open) dialog.showModal();
  }
  async function save() {
    if (!session || session.busy || session.stale || session.saved) return;
    if (!completeSyncConflictChoices(session.pending, session.choices))
      throw new Error('请为每项冲突选择要保留的版本。');
    session.busy = true;
    session.error = '';
    render();
    try {
      const current = await readState();
      if (isUnavailable())
        throw new Error('本机连接尚未恢复，无法保存。页面选择已保留，请恢复连接后重新核对。');
      if (changed(current)) {
        session.stale = true;
        throw new Error('正式记录或同步冲突已变化，本次未保存。请重新核对最新内容。');
      }
      resolveConflicts(session.pending.data, session.pending.conflicts, session.choices);
      const next = await resolveSyncConflict(session.pending, { ...session.choices });
      session.saved = true;
      await saved(next);
    } catch (error) {
      session.error = error.message;
      if (error.code === 'WORKSPACE_REVISION_CONFLICT' || error.status === 409)
        session.stale = true;
      report(error);
    } finally {
      session.busy = false;
      render();
    }
  }
  function invalidate(current) {
    if (session && !session.saved && !session.busy && changed(current)) {
      session.stale = true;
      if (getDialog().open) render();
    }
  }
  return { show, invalidate };
}
