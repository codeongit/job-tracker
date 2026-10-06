import {
  groupBossObservations,
  bossObservationGroups,
  PLATFORM_JOB_LABELS,
} from './boss-observations.js';
import { bossWaitingReviewTarget, bossWaitingReviewCandidates } from './boss-integration.js';
import { ATTRIBUTION_REASONS } from './boss-attribution.js';
import { live, serialize } from './model.js';
import { esc } from './ui.js';
import { APP_VERSION } from './version.js';
import { utf8Bytes } from './limits.js';

function bossStats(entries) {
  const items = entries
    .filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `<span><strong>${Number(count)}</strong> ${label}</span>`)
    .join('');
  return items ? `<div class="integration-stats">${items}</div>` : '';
}

function bossAccountView(account, disabled = false) {
  const state = account.bound
    ? '已绑定当前工作区'
    : account.ownedElsewhere
      ? '需在原工作区处理'
      : account.restoreRequired
        ? '需确认恢复'
        : '尚未绑定';
  const action = account.restoreRequired
    ? `<button class="secondary" data-boss-restore="${esc(account.accountNamespace)}" ${disabled ? 'disabled' : ''}>核对并恢复绑定</button>`
    : !account.bound && !account.ownedElsewhere
      ? `<button class="primary" data-boss-bind="${esc(account.accountNamespace)}" ${disabled ? 'disabled' : ''}>绑定并处理</button>`
      : '';
  return `<div class="source-binding"><div><strong>${esc(account.label)}</strong><small>${state}${Number(account.pending) > 0 ? ` · ${Number(account.pending)} 个待录入批次` : ''}</small></div>${action}</div>`;
}

export function bossObservationReason(item) {
  return (
    ATTRIBUTION_REASONS[item.reason] ||
    {
      missing_job_details: '缺少岗位资料',
      identity_conflict: '岗位资料不一致：岗位 ID、链接或绑定信息需要核对',
      missing_message_identity: '缺少稳定消息身份',
      entity_sync_conflict: '岗位存在同步冲突',
      user_confirmed_job_details: '岗位资料已人工补齐',
      observation_recorded: '观察已处理',
      existing_job_details_available: '已采用本机岗位资料',
      user_ignored_unresolved_observation: '已忽略',
    }[item.reason] ||
    item.reason
  );
}

export function reconcileBossIgnoreSelection(selected, items) {
  const visible = new Set((items || []).map((item) => item.applicationId));
  return new Set([...selected].filter((id) => visible.has(id)));
}

function waitingItemDetails(item, data) {
  const application = data?.sourceApplications?.find(
    (row) => !row.deletedAt && row.id === item.applicationId,
  );
  const event =
    application &&
    data.sourceEvents?.find((row) => !row.deletedAt && row.factId === application.factId);
  if (!event) return item;
  const missing = [];
  if (!event.jobName) missing.push('岗位名称');
  if (!event.externalJobId) missing.push('岗位编号');
  if (!event.canonicalUrl) missing.push('岗位链接');
  return {
    ...item,
    contact: event.contact || '',
    observedAt: event.observedAt || '',
    observationType: event.eventType === 'resume_observed' ? '简历相关记录' : '普通聊天记录',
    missingFields: missing,
    reviewTarget: bossWaitingReviewTarget(data, item.applicationId),
    reviewCandidates: bossWaitingReviewCandidates(data, item.applicationId),
  };
}

export function bossIntegrationView(
  status,
  { selected = new Set(), pendingConflict = false, busy = false, data } = {},
) {
  if (!status?.available)
    return `<section class="panel"><div class="panel-header"><h2>BOSS 接入</h2><span class="badge">未启用</span></div><div class="panel-body"><p>本机 BOSS 接入尚未启用。</p></div></section>`;
  const tracking = status.tracking || {},
    counts = status.applicationCounts || {},
    attribution = status.attribution || {},
    accounts = status.accounts || [],
    restoreReview = status.restoreReview || [],
    server = status.server || {},
    detail = tracking.detailEnrichment,
    history = tracking.history,
    needsBinding = accounts.filter((account) => !account.bound || account.restoreRequired),
    review = Math.max(Number(counts.review || 0), Number(attribution.conflict || 0)),
    needsAttention = Boolean(
      status.error ||
      status.blocked ||
      restoreReview.length ||
      needsBinding.length ||
      review ||
      attribution.collection ||
      tracking.lifecycle === 'paused' ||
      detail?.status === 'blocked' ||
      Number(detail?.isolated) > 0 ||
      Number(history?.failed) > 0 ||
      Number(history?.isolated) > 0,
    ),
    trackingLabel = status.serverManaged
      ? { running: '跟踪中', paused: '跟踪已暂停', stopped: '跟踪已停止' }[tracking.lifecycle] ||
        '跟踪状态未知'
      : status.running
        ? '队列处理中'
        : '本机队列已连接',
    badge = needsAttention ? '需要处理' : status.connectionStale ? '状态待更新' : trackingLabel;
  const date = tracking.lastSuccessAt ? new Date(tracking.lastSuccessAt) : null;
  const lastSuccess =
    date && !Number.isNaN(date.getTime())
      ? `上次成功采集：${esc(date.toLocaleString('zh-CN'))}`
      : '尚无成功采集记录';
  const description = status.connectionStale
    ? '本轮状态刷新未成功，当前显示上次成功获取的状态；下次刷新会重试。'
    : status.serverManaged
      ? tracking.lifecycle === 'running'
        ? '本机正在采集并录入，关闭此页面后仍继续。'
        : tracking.lifecycle === 'paused'
          ? '采集已暂停，已录入的数据保留在本机。'
          : tracking.lifecycle === 'stopped'
            ? '跟踪已停止，已录入的数据保留在本机。'
            : '已录入的数据保留在本机，跟踪状态暂未确认。'
      : '此页面只消费本机队列。';
  const alerts = [
    status.blocked ? `<div class="warning section-gap">${esc(status.blocked)}</div>` : '',
    status.error ? `<div class="error section-gap">${esc(status.error)}</div>` : '',
    tracking.lifecycle === 'paused'
      ? `<div class="warning section-gap">${esc(tracking.pauseCode || '跟踪已暂停')}。处理原因后可手动恢复跟踪。</div>`
      : '',
    review > 0
      ? `<div class="warning section-gap"><strong>${review}</strong> 需要人工判断。展开详情查看观察原因，再核对相关岗位。</div>`
      : '',
    Number(attribution.collection) > 0
      ? `<div class="warning section-gap">存在采集问题。展开详情查看原因。</div>`
      : '',
    Number(detail?.isolated) > 0 || Number(history?.failed) > 0 || Number(history?.isolated) > 0
      ? '<div class="warning section-gap">部分采集因故障未完成，展开详情查看原因。</div>'
      : '',
    detail?.status === 'blocked'
      ? '<div class="warning section-gap">岗位详情补齐已暂停，其他采集阶段不受此项阻断。处理现场后执行 <code>pnpm boss resume-details</code>。</div>'
      : '',
    restoreReview.length
      ? `<div class="warning section-gap"><strong>发现恢复缺口</strong><p>本机回执对应的部分来源事件缺失，请核对后重放。</p>${restoreReview.map((gap) => `<div class="button-row"><span>批次 ${esc(gap.batchId.slice(-8))} · 缺少 ${Number(gap.missing)} 条</span><button class="secondary" data-boss-replay="${esc(gap.batchId)}" ${status.connectionStale ? 'disabled' : ''}>核对并重放</button></div>`).join('')}</div>`
      : '',
    needsBinding.length
      ? `<div class="source-bindings section-gap">${needsBinding.map((account) => bossAccountView(account, Boolean(status.connectionStale))).join('')}</div>`
      : '',
  ].join('');
  const rawItems = status.waitingItems || [];
  const extraItems = data
    ? bossObservationGroups(data)
        .flatMap((group) => group.observations)
        .filter(
          (item) =>
            item.status === 'review' &&
            !rawItems.some((row) => row.applicationId === item.applicationId),
        )
    : [];
  const messageGroups = groupBossObservations([...rawItems, ...extraItems], data);
  const waiting = data
      ? messageGroups.filter((group) => group.waitingApplicationIds.length).length
      : Number(counts.waiting || 0),
    insufficient = data
      ? messageGroups.filter(
          (group) =>
            group.waitingApplicationIds.length &&
            group.observations.some((item) => item.reason.startsWith('attribution_')),
        ).length
      : Number(attribution.insufficient || 0);
  const waitingText =
    waiting > 0
      ? `<p>等待资料或证据：<strong>${waiting}</strong>${insufficient > 0 ? `，其中 <strong>${insufficient}</strong> 条归属证据不足` : ''}。</p>`
      : insufficient > 0
        ? `<p>归属证据不足：<strong>${insufficient}</strong>。</p>`
        : '';
  const waitingItems = messageGroups.map((item) => ({
      ...waitingItemDetails(item, data),
      ...item,
    })),
    ignoreDisabled =
      !status.serverManaged ||
      status.connectionStale ||
      Boolean(status.error) ||
      pendingConflict ||
      busy ||
      !Number.isSafeInteger(status.revision),
    candidateLabel = (item) =>
      item.candidate
        ? `候选岗位：${esc(item.candidateCompany)} / ${esc(item.candidate)}`
        : `候选公司：${esc(item.candidateCompany || '未取得')} · 岗位归属未确认`;
  const selectionDisabled = !status.serverManaged || busy;
  const blockedReason = busy
    ? '正在保存，请稍候。'
    : pendingConflict
      ? '请先处理同步冲突；可以先勾选，冲突处理后再确认。'
      : status.connectionStale || status.error
        ? '状态尚未更新，可以先勾选；刷新成功后才能确认忽略。'
        : !status.serverManaged
          ? '忽略观察需要连接本机服务。'
          : !Number.isSafeInteger(status.revision)
            ? '等待本机状态加载完成，可以先勾选。'
            : '';
  const groups = [
    {
      title: '需要核对',
      matches: (item) => item.status === 'review',
      explanation: '存在矛盾，需核对后处理；同组的等待项不会掩盖冲突。',
    },
    {
      title: '缺少岗位资料',
      matches: (item) => item.status !== 'review' && item.reason === 'missing_job_details',
      explanation:
        '岗位 ID、链接与现有完整资料唯一匹配时会自动处理；仍缺资料或存在矛盾的记录留在这里。可直接核对下方候选岗位，不再处理的旧记录可以忽略。',
    },
    {
      title: '聊天归属无法确认',
      matches: (item) => item.status !== 'review' && item.reason.startsWith('attribution_'),
      explanation:
        '旧消息缺少联系人、会话或参与者的对应依据，未用于更新简历状态。可核对聊天后自行编辑岗位；忽略只结束这条旧观察的自动处理。',
    },
    {
      title: '其他等待项',
      matches: (item) =>
        item.status !== 'review' &&
        item.reason !== 'missing_job_details' &&
        !item.reason.startsWith('attribution_'),
      explanation: '下方列出阻止录入的原因。',
    },
  ];
  const observations =
    groups
      .map((group) => {
        const rows = waitingItems.filter(group.matches);
        if (!rows.length) return '';
        return `<section class="boss-waiting-group"><h4>${group.title} · ${rows.length} 条</h4><p class="muted">${group.explanation}</p><ul class="boss-observation-list">${rows
          .map((item) => {
            const date = item.observedAt ? new Date(item.observedAt) : null;
            const dateLabel =
              date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN') : '时间未取得';
            const target = item.reviewTarget;
            const review = target
              ? `<div class="boss-observation-review"><p>本机候选岗位：<strong>${esc(target.company)} / ${esc(target.role)}</strong></p><p>当前简历：${esc(target.resumeState)} · ${target.manualResumeState ? '由你设置（人工控制）' : '自动维护'}</p><div class="button-row"><button class="secondary" id="boss-waiting-view-${esc(item.applicationId)}" data-boss-review="${esc(item.applicationId)}" data-boss-review-action="view">查看候选岗位</button><button class="text-button" id="boss-waiting-edit-${esc(item.applicationId)}" data-boss-review="${esc(item.applicationId)}" data-boss-review-action="edit">编辑岗位状态</button></div><small>这是现有绑定的候选目标，观察归属未确认；编辑不会确认或忽略观察。</small></div>`
              : `<div class="boss-observation-review"><p>未找到可唯一对应的本机岗位。</p>${item.reviewCandidates?.length ? `<details data-settings-details="boss-candidates-${esc(item.applicationId)}"><summary>核对本机候选岗位 · ${item.reviewCandidates.length} 个</summary><p class="muted">候选仅供查看；同公司不代表同岗位，打开或编辑不会确认观察归属。</p>${item.reviewCandidates.map((candidate) => `<p>${esc(candidate.company)} / ${esc(candidate.role)} · ${candidate.exact ? '岗位 ID 匹配，其他信息仍需核对' : '同公司候选'} <button class="text-button" id="boss-candidate-${esc(item.applicationId)}-${esc(candidate.opportunityId)}" data-boss-review="${esc(item.applicationId)}" data-boss-candidate="${esc(candidate.opportunityId)}">打开岗位详情</button></p>`).join('')}</details>` : '<p class="muted">本机没有岗位 ID 或公司匹配的候选，请在岗位列表补建资料后再核对。</p>'}</div>`;
            return `<li class="boss-observation-card"><label class="boss-observation-choice">${item.waitingApplicationIds.length ? `<input type="checkbox" id="boss-ignore-${esc(item.applicationId)}" data-boss-ignore-item="${esc(item.waitingApplicationIds.join(','))}" ${item.waitingApplicationIds.every((id) => selected.has(id)) ? 'checked' : ''} ${selectionDisabled ? 'disabled' : ''}>` : ''}<span><strong>${candidateLabel(item)}</strong><span class="boss-observation-meta">${esc(item.contact || '联系人未取得')} · 包含 ${item.observations.length} 项观察 · ${esc(dateLabel)}</span><span class="boss-observation-reason">${esc(bossObservationReason(item))}${item.reason === 'missing_job_details' && item.missingFields?.length ? `：${esc(item.missingFields.join('、'))}未取得` : ''}</span>${item.platformJobState !== 'unknown' ? `<span class="badge">${esc(PLATFORM_JOB_LABELS[item.platformJobState] || '平台状态需核对')}</span>` : ''}</span></label><details data-settings-details="boss-message-${esc(item.applicationId)}"><summary>观察明细 · ${item.observations.length} 项</summary>${item.observations.map((observation) => `<p>${esc(observation.observationType)} · ${esc(bossObservationReason(observation))}</p>`).join('')}</details>${review}</li>`;
          })
          .join('')}</ul></section>`;
      })
      .join('') +
    (attribution.items || [])
      .filter((item) => !waitingItems.length || item.category !== 'insufficient')
      .map((item) => `<p>${esc(item.label)} · ${candidateLabel(item)}</p>`)
      .join('');
  const selectedMessages = waitingItems.filter((item) =>
    item.waitingApplicationIds.some((id) => selected.has(id)),
  ).length;
  const selectedCount = waitingItems
    .flatMap((item) => item.waitingApplicationIds)
    .filter((id) => selected.has(id)).length;
  const ignoreAction = waitingItems.some((item) => item.waitingApplicationIds.length)
    ? `<div class="boss-ignore-actions"><p>已选 <strong>${selectedMessages}</strong> 条消息 / <strong>${selectedCount}</strong> 项观察。忽略后原始记录保留，同一事实不再自动应用，新消息继续处理。</p>${blockedReason ? `<p role="status">${blockedReason}</p>` : ''}<div class="button-row"><button class="secondary" data-boss-ignore="true" ${ignoreDisabled || !selectedCount ? 'disabled' : ''}>忽略所选观察</button><button class="text-button" data-boss-refresh="true" ${busy ? 'disabled' : ''}>刷新本机状态</button></div></div>`
    : '';
  const historyStats = history
    ? bossStats([
        [history.pending, '增量待处理'],
        [history.paginating, '分页未完成'],
        [history.waitingRetry, '故障退避'],
        [history.truncated, '覆盖截断'],
        [history.failed, '历史采集失败'],
        [history.isolated, '历史技术隔离'],
        [history.completed, '已完成会话'],
      ])
    : '';
  const detailStats = detail
    ? bossStats([
        [detail.pending, '详情待处理'],
        [detail.deferred, '详情退避中'],
        [detail.isolated, '技术隔离'],
      ])
    : '';
  const budget = tracking.budget;
  const diagnostics = bossStats([
    [status.pending, '待录入批次'],
    [server.receiptCount ?? server.processed, '本机回执'],
    [server.incidentCount, '故障材料'],
  ]);
  return `<section class="panel"><div class="panel-header"><h2>BOSS 接入</h2><span class="badge ${needsAttention || status.connectionStale ? 'warn' : 'blue'}">${badge}</span></div><div class="panel-body">${needsAttention ? `<p>${status.connectionStale ? '上次状态：' : ''}${trackingLabel}</p>` : ''}<p>${status.serverManaged ? lastSuccess : '已连接本机只读队列。'}</p><p>${description} GitHub 由手动同步。</p>${status.running && !status.serverManaged ? '<p>正在处理本机队列。</p>' : ''}${alerts}<details class="section-gap" data-settings-details="boss-status"><summary id="boss-status-toggle">查看详情</summary>${status.connectionStale && status.refreshError ? `<p>最近状态刷新：${esc(status.refreshError)}</p>` : ''}${waitingText}${Number(counts.protected) > 0 ? `<p>人工决定已保留：<strong>${Number(counts.protected)}</strong>，包括人工字段保护和否决。</p>` : ''}${Number(counts.ignored) > 0 ? `<p>已忽略：<strong>${Number(counts.ignored)}</strong>。</p>` : ''}${waitingText ? '<p>新资料齐全后可重新判断；旧观察缺失证据时可能继续等待。核对聊天后也可自行编辑岗位，编辑不会确认观察归属。</p>' : ''}${observations ? `<details class="section-gap" data-settings-details="boss-observations"><summary id="boss-observations-toggle">观察原因</summary>${ignoreAction}${observations}</details>` : ''}${diagnostics}${historyStats ? `<div class="section-gap"><strong>历史采集 · ${history.mode === 'backfill' ? '最近一次手动回填' : '变化驱动'}</strong>${historyStats}</div>` : ''}${detailStats || detail?.lastError ? `<div class="section-gap"><strong>岗位详情补齐</strong>${detailStats}${detail?.nextRetryAt ? `<p>下次重试：${esc(new Date(detail.nextRetryAt).toLocaleString('zh-CN'))}</p>` : ''}${detail?.lastError ? `<p>最近错误：${esc(detail.lastError)}</p>` : ''}</div>` : ''}${
    budget
      ? `<div class="section-gap"><strong>本轮预算</strong>${bossStats([
          [budget.historyRequests, '历史请求额度'],
          [budget.detailActions, '详情额度'],
          [budget.domActions, '会话操作额度'],
          [budget.historyUsed, '已用历史请求'],
          [budget.navigationUsed, '已用导航'],
        ])}${budget.nextHistoryAt ? `<p>下次历史额度：${esc(budget.nextHistoryAt)}</p>` : ''}</div>`
      : ''
  }${
    accounts.filter((account) => account.bound && !account.restoreRequired).length
      ? `<div class="source-bindings section-gap">${accounts
          .filter((account) => account.bound && !account.restoreRequired)
          .map((account) => bossAccountView(account, Boolean(status.connectionStale)))
          .join('')}</div>`
      : ''
  }${status.sourceId ? `<small>当前浏览器来源：${esc(status.sourceId.slice(0, 8))}。</small>` : ''}</details></div></section>`;
}

export function settingsView({
  state,
  ssh,
  token,
  syncing,
  diagnostic,
  backupStatus,
  bossStatus,
  bossIgnoreSelected,
  bossIgnoreBusy,
}) {
  const c = state.config;
  return `<div class="settings">${bossIntegrationView(bossStatus, { selected: bossIgnoreSelected, pendingConflict: Boolean(state.pending), busy: bossIgnoreBusy, data: state.data })}${ssh ? `<section class="panel"><div class="panel-header"><h2>GitHub 同步</h2><span class="badge blue">手动同步 · SSH</span></div><div class="panel-body"><p>使用这台电脑已有的 SSH key，同步到 ${esc(c.owner)}/${esc(c.repo)}。</p><p>数据文件：${esc(c.path)}</p><button class="primary" data-action="sync" ${syncing ? 'disabled' : ''}>${syncing ? '同步中…' : '立即通过 SSH 同步'}</button><p class="section-gap">私钥始终留在本机。手机或公开网页可使用下面的令牌方式连接同一份数据。</p>${state.pending ? '<button class="secondary" data-action="resolve-pending">处理同步冲突</button>' : ''}</div></section><details data-settings-details="sync-other"><summary id="sync-other-toggle">其他仓库或令牌方式</summary>` : ''}<section class="panel"><div class="panel-header"><h2>GitHub 私有同步</h2></div><div class="panel-body"><p>每台设备先保存在本地，点击“立即同步”合并云端记录。专用令牌只在当前页面会话中使用，关闭或刷新页面后需要重新填写。</p><form id="settings-form" class="form-stack"><div class="form-grid"><label>GitHub 用户名<input name="owner" value="${esc(c.owner)}" required></label><label>私有仓库名<input name="repo" value="${esc(c.repo)}" required></label><label class="span-2">数据文件路径<input name="path" value="${esc(c.path)}" required></label><label class="span-2">本次会话的访问令牌<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="Fine-grained personal access token" value="${esc(token)}"></label></div><div><button class="primary" type="submit" ${syncing ? 'disabled' : ''}>保存连接设置</button> <button class="secondary" data-action="sync" type="button" ${syncing ? 'disabled' : ''}>立即同步</button></div><small>令牌选择此数据仓库，Contents 权限设置为 Read and write。只接受私有仓库，不会上传到公开仓库。</small></form><div class="button-row"><a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">创建专用令牌 ↗</a><button class="text-button" data-action="forget-token">清除当前令牌</button></div>${state.pending ? '<div class="button-row warning">存在尚未处理的冲突。<button class="text-button" data-action="resolve-pending">处理冲突</button></div>' : ''}</div></section>${ssh ? '</details>' : ''}<section class="panel"><div class="panel-header"><h2>导入、备份与导出</h2></div><div class="panel-body"><p>完整 JSON 备份包含记录、同步基线、未解决冲突及本机草稿。Markdown 适合放回 Obsidian 阅读。</p><div class="button-row"><button class="secondary" data-action="choose-file">导入 Markdown / JSON</button><button class="secondary" data-action="export-json">导出完整备份</button><button class="secondary" data-action="snapshots">本机快照</button><button class="secondary" data-action="export-md">导出 Markdown</button></div><p class="section-gap">已导入 ${live(state.data.imports).length} 个批次。原文内容保留在私有数据中。</p><small>本机自动保留最近 20 个操作快照；清理网站数据会同时清除快照。请下载完整备份并单独保存。</small></div></section>${['localhost', '127.0.0.1'].includes(location.hostname) ? `<section class="panel"><div class="panel-header"><h2>浏览器之外的自动备份</h2></div><div class="panel-body"><p>工作台打开时，保存记录或草稿后会自动写入本机私有目录 .local/backups/；每个来源保留最近30个有备份日期的首份及最新一份。</p><p id="disk-backup-status" role="status">${esc(backupStatus?.message || '正在检查…')}</p><div class="button-row"><button class="secondary" data-action="backup-now">立即备份</button><button class="secondary" data-action="disk-backups">查看独立备份</button></div><small>关闭页面前最后几秒的输入可能尚未写入磁盘，下次打开会补备份。磁盘备份仍在这台电脑上。</small></div></section>` : ''}<section class="panel"><div class="panel-header"><h2>版本与连接检查</h2><span class="badge">v${APP_VERSION}</span></div><div class="panel-body"><p>最近同步：${esc(state.lastSync ? new Date(state.lastSync).toLocaleString('zh-CN') : '尚未同步')}</p><p>数据文件：${(utf8Bytes(serialize(state.data)) / 1000).toFixed(1)} KB / 5 MB</p><button class="secondary" data-action="diagnose" ${syncing ? 'disabled' : ''}>检查连接</button><p id="diagnostic-result" class="section-gap" role="status">${esc(diagnostic || '检查只读取连接和云端文件，不上传记录。')}</p></div></section></div>`;
}
