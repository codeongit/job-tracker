import {
  groupBossObservations,
  bossObservationGroups,
  PLATFORM_JOB_LABELS,
  bossJobDetailsConfirmation,
} from './boss-observations.js';
import { bossWaitingReviewTarget, bossWaitingReviewCandidates } from './boss-integration.js';
import { BOSS_OBSERVATION_REASONS } from './boss-attribution.js';
import { live, serialize, equal } from './model.js';
import {
  bossFailureGuidance,
  bossProcessingFeedback,
  bossConflictTargets,
} from './settings-guidance.js';
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

function bossBudgetView(budget, lifecycle) {
  const available = [
    [budget.historyRequests, '读取聊天历史资料', '查询联系人或读取一页消息，各计 1 次。'],
    [budget.detailActions, '打开岗位详情', '打开一个岗位详情页计 1 次。'],
    [budget.domActions, '打开聊天补查', '仅在采集策略允许时使用；有次数上限不表示此方式已开启。'],
  ]
    .filter(([count]) => Number.isSafeInteger(count) && count >= 0)
    .map(
      ([count, label, explanation]) =>
        `<dt>${label}</dt><dd>最多 <strong>${count}</strong> 次。<small>${explanation}</small></dd>`,
    )
    .join('');
  const used = [
    [budget.historyUsed, '历史资料读取'],
    [budget.navigationUsed, '打开岗位详情或聊天'],
  ]
    .filter(([count]) => Number.isSafeInteger(count) && count >= 0)
    .map(([count, label]) => `<dt>${label}</dt><dd>已占用 <strong>${count}</strong> 次。</dd>`)
    .join('');
  return `<h3>采集次数限制</h3>${available ? `<p>按当前可用次数，下一轮采集最多可执行：</p><dl class="issue-steps">${available}</dl><p>以上是上限，不是已经执行的次数。${lifecycle === 'running' ? '实际按需要采集，可能少于上限。' : '跟踪未运行时不会因此开始采集。'}</p>` : '<p>当前可用次数尚未取得。</p>'}${used ? `<h4>过去 60 分钟的次数占用</h4><dl class="issue-steps">${used}</dl><small>失败或用量未确认时，也可能保留预留次数；随时间释放，重启不清零。</small>` : ''}${budget.nextHistoryAt ? `<p>历史读取次数预计恢复：${esc(new Date(budget.nextHistoryAt).toLocaleString('zh-CN'))}</p>` : ''}`;
}

function issueCard({ title, problem, impact, next, actions = '', technical = '' }) {
  return `<section class="settings-issue"><h3>${esc(title)}</h3><dl class="issue-steps"><dt>发生了什么</dt><dd>${esc(problem)}</dd><dt>影响</dt><dd>${esc(impact)}</dd><dt>下一步</dt><dd>${esc(next)}</dd></dl>${actions ? `<div class="button-row">${actions}</div>` : ''}${technical ? `<details><summary>技术详情</summary><pre class="long-copy">${esc(technical)}</pre></details>` : ''}</section>`;
}

function failureCard(code, stage, problem) {
  const guide = bossFailureGuidance(code, stage);
  return issueCard({
    ...guide,
    problem: guide.problem || problem || guide.title,
    actions: `<details><summary>查看处理步骤</summary><p>${esc(guide.next)}</p><code>${esc(guide.command)}</code></details>`,
    technical: code,
  });
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
    BOSS_OBSERVATION_REASONS[item.reason] ||
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
  {
    selected = new Set(),
    pendingConflict = false,
    busy = false,
    data,
    feedback,
    offline = false,
  } = {},
) {
  if (offline) status = { ...status, connectionStale: true };
  if (!status?.available && !status?.error && !status?.connectionStale)
    return `<section class="panel"><div class="panel-header"><h2 id="boss-card-title" tabindex="-1">BOSS 采集</h2><span class="badge">未启用</span></div><div class="panel-body"><p>本机 BOSS 接入尚未启用。</p></div></section>`;
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
    trackingLabel = !status.available
      ? '采集状态待确认'
      : status.serverManaged
        ? { running: '跟踪中', paused: '跟踪已暂停', stopped: '跟踪已停止' }[tracking.lifecycle] ||
          '跟踪状态未知'
        : status.running
          ? '队列处理中'
          : '本机队列已连接',
    badge = needsAttention ? '需要处理' : status.connectionStale ? '状态待更新' : trackingLabel;
  const date = tracking.lastSuccessAt ? new Date(tracking.lastSuccessAt) : null;
  const lastSuccess =
    date && !Number.isNaN(date.getTime())
      ? `最近成功处理（含本机恢复）：${esc(date.toLocaleString('zh-CN'))}`
      : '尚无成功处理记录';
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
  const mutableDisabled =
    status.connectionStale ||
    offline ||
    busy ||
    !status.serverManaged ||
    !Number.isSafeInteger(status.revision);
  const refreshAction = '<button class="secondary" data-boss-refresh="true">刷新本机状态</button>';
  const alerts = [
    status.connectionStale || status.error
      ? issueCard({
          title: '本机状态暂时无法更新',
          problem: '页面尚未取得最新状态。',
          impact: '当前显示上次取得的状态，暂不能确认处理结果或提交修改。',
          next: '检查本机服务，连接恢复后刷新状态。',
          actions: refreshAction,
          technical: status.refreshError || status.error,
        })
      : '',
    tracking.lifecycle === 'paused'
      ? failureCard(tracking.pauseCode || '', '', '该账号的采集已暂停。')
      : '',
    status.blocked && !restoreReview.length
      ? issueCard({
          title: '部分本机材料尚未录入',
          problem: '存在暂时无法处理的来源批次。',
          impact: '有关材料保留，尚未用于更新岗位。',
          next: pendingConflict
            ? '先核对同步冲突，再返回查看录入结果。'
            : '查看本机故障原因，修复后核对交付结果。',
          actions: pendingConflict
            ? '<button class="secondary" data-action="resolve-pending">处理同步冲突</button>'
            : '',
          technical: status.blocked,
        })
      : '',
    Number(attribution.collection) > 0
      ? issueCard({
          title: '部分采集材料缺少消息身份',
          problem: `${Number(attribution.collection)} 项采集问题尚未完成。`,
          impact: '这些材料不能作为可靠消息录入，也不能通过忽略等待项处理。',
          next: '核对本机采集诊断并修复缺失字段；不额外自动请求平台。',
          technical: (attribution.items || [])
            .filter((item) => item.category === 'collection')
            .map((item) => item.label)
            .join('\n'),
        })
      : '',
    detail?.status === 'blocked' || Number(detail?.isolated) > 0
      ? failureCard(
          detail.lastError || (detail.status === 'blocked' ? 'DETAIL_TAB_OWNERSHIP_MISMATCH' : ''),
          'detail',
          `${Number(detail.isolated || detail.pending || 0)} 项详情未完成${detail.status === 'blocked' ? '，详情阶段已暂停' : '，失败任务需要排障'}。`,
        )
      : '',
    Number(history?.failed) > 0 || Number(history?.isolated) > 0
      ? failureCard(
          history.lastError || '',
          'history',
          `${Number(history.failed || 0)} 项历史采集失败，${Number(history.isolated || 0)} 项停止重试并保留故障材料。`,
        )
      : '',
    restoreReview.length
      ? issueCard({
          title: '恢复后缺少部分来源材料',
          problem: '本机回执对应的部分来源事件缺失。',
          impact: '回执不能证明当前岗位中仍有这些事实，相关材料尚不能继续处理。',
          next: '核对每个批次后明确重放；不会自动恢复缺失记录。',
          actions: restoreReview
            .map(
              (gap) =>
                `<div class="button-row"><span>批次 ${esc(gap.batchId.slice(-8))} · 缺少 ${Number(gap.missing)} 条来源记录</span><button class="secondary" data-boss-replay="${esc(gap.batchId)}" ${mutableDisabled ? 'disabled' : ''}>核对并重放</button></div>`,
            )
            .join(''),
        })
      : '',
    needsBinding.length
      ? issueCard({
          title: '采集账号需要确认',
          problem: '来源账号尚未绑定当前工作区，或需要核对恢复归属。',
          impact: '相关批次保留，尚不能录入当前工作区。',
          next: '核对账号及原工作区，再明确绑定或恢复。',
          actions: needsBinding
            .map((account) => bossAccountView(account, mutableDisabled))
            .join(''),
        })
      : '',
  ].join('');
  const rawItems = (status.waitingItems || [])
    .filter((item) => {
      const current = data?.sourceApplications?.find((row) => row.id === item.applicationId);
      return (
        !current ||
        (!current.deletedAt && (!current.status || ['waiting', 'review'].includes(current.status)))
      );
    })
    .map((item) => {
      const current = data?.sourceApplications?.find((row) => row.id === item.applicationId);
      return current
        ? { ...item, status: current.status || item.status, reason: current.reason || item.reason }
        : item;
    });
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
      : Number(attribution.insufficient || 0),
    semantic = data
      ? messageGroups.filter(
          (group) =>
            group.waitingApplicationIds.length &&
            group.observations.some(
              (item) => item.status === 'waiting' && item.reason === 'resume_semantics_missing',
            ),
        ).length
      : Number(attribution.semantic || 0);
  const waitingText =
    waiting > 0
      ? `<p>等待资料或证据：<strong>${waiting}</strong>${insufficient > 0 ? `，其中 <strong>${insufficient}</strong> 条归属证据不足` : ''}${semantic > 0 ? `，<strong>${semantic}</strong> 条简历状态依据不足` : ''}。</p>`
      : `${insufficient > 0 ? `<p>归属证据不足：<strong>${insufficient}</strong>。</p>` : ''}${semantic > 0 ? `<p>简历状态依据不足：<strong>${semantic}</strong>。</p>` : ''}`;
  const waitingItems = messageGroups.map((item) => ({
      ...waitingItemDetails(item, data),
      ...item,
    })),
    ignoreDisabled =
      !status.serverManaged ||
      status.connectionStale ||
      Boolean(status.error) ||
      offline ||
      pendingConflict ||
      busy ||
      !Number.isSafeInteger(status.revision),
    candidateLabel = (item) =>
      item.candidate
        ? `候选岗位：${esc(item.candidateCompany)} / ${esc(item.candidate)}`
        : `候选公司：${esc(item.candidateCompany || '未取得')} · 岗位归属未确认`;
  const selectionDisabled = !status.serverManaged || busy;
  const blockedReason = offline
    ? '本机服务尚未连接，恢复后才能确认。'
    : busy
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
      title: '简历状态依据不足',
      matches: (item) => item.status !== 'review' && item.reason === 'resume_semantics_missing',
      explanation:
        '现有观察缺少可核对的系统状态依据；不能据此认定简历已发送或已接收。核对真实聊天后可自行编辑岗位；不再采用的旧观察可单独忽略。',
    },
    {
      title: '其他等待项',
      matches: (item) =>
        item.status !== 'review' &&
        item.reason !== 'missing_job_details' &&
        item.reason !== 'resume_semantics_missing' &&
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
            const confirmation = data
              ? bossJobDetailsConfirmation(data, item.applicationIds, status.sourceId)
              : { allowed: false, reason: '尚未取得最新本机资料。' };
            const target =
              item.reviewTarget ||
              (confirmation.allowed
                ? {
                    ...confirmation.target,
                    resumeState:
                      data?.opportunities?.find(
                        (row) => row.id === confirmation.target.opportunityId,
                      )?.resumeState || '未知',
                    manualResumeState: !data?.sourceBindings?.some(
                      (row) =>
                        !row.deletedAt &&
                        row.kind === 'opportunity' &&
                        row.opportunityId === confirmation.target.opportunityId &&
                        row.autoFields?.split(',').includes('resumeState') &&
                        row.lastAutoResumeState ===
                          data?.opportunities?.find((job) => job.id === row.opportunityId)
                            ?.resumeState,
                    ),
                  }
                : null);
            const review = target
              ? `<div class="boss-observation-review"><p>本机候选岗位：<strong>${esc(target.company)} / ${esc(target.role)}</strong></p><p>当前简历：${esc(target.resumeState || data?.opportunities?.find((row) => row.id === target.opportunityId)?.resumeState || '未知')} · ${target.manualResumeState ? '由你设置（人工控制）' : '自动维护'}</p><div class="button-row"><button class="secondary" id="boss-waiting-view-${esc(item.applicationId)}" data-boss-review="${esc(item.applicationId)}" data-boss-review-action="view" ${confirmation.allowed && !item.reviewTarget ? `data-boss-confirm-target="${esc(target.opportunityId)}"` : ''}>查看候选岗位</button><button class="text-button" id="boss-waiting-edit-${esc(item.applicationId)}" data-boss-review="${esc(item.applicationId)}" data-boss-review-action="edit" ${confirmation.allowed && !item.reviewTarget ? `data-boss-confirm-target="${esc(target.opportunityId)}"` : ''}>编辑岗位状态</button></div><small>候选用于核对；编辑岗位不会确认消息归属或自动忽略旧消息。</small></div>`
              : `<div class="boss-observation-review"><p>未找到可唯一对应的本机岗位。</p>${item.reviewCandidates?.length ? `<p>核对本机候选岗位：只供查看，同公司不代表同岗位。</p>${item.reviewCandidates.map((candidate) => `<p>${esc(candidate.company)} / ${esc(candidate.role)} · ${candidate.exact ? '岗位 ID 匹配，其他信息仍需核对' : '同公司候选'} <button class="text-button" id="boss-candidate-${esc(item.applicationId)}-${esc(candidate.opportunityId)}" data-boss-review="${esc(item.applicationId)}" data-boss-candidate="${esc(candidate.opportunityId)}">打开岗位详情</button></p>`).join('')}` : '<p>本机没有可精确对应的岗位，请到岗位列表核对或补建资料。</p><button class="secondary" data-view="list">到岗位列表核对</button>'}</div>`;
            const related =
              item.status === 'review' ? bossConflictTargets(data, item.applicationIds) : [];
            const relatedView = related.length
              ? `<div class="boss-observation-review"><p>同一消息涉及的本机候选岗位（归属未确认）：</p>${related.map((row) => `<p>${esc(row.company)} / ${esc(row.role)} ${row.deleted ? '· 已删除，保留核对线索' : `<button class="text-button" id="boss-related-${esc(item.applicationId)}-${esc(row.opportunityId)}" data-boss-review="${esc(item.applicationId)}" data-boss-related-job="${esc(row.opportunityId)}">查看相关岗位</button>`}</p>`).join('')}</div>`
              : '';
            const reviewCount = item.observations.filter((row) => row.status === 'review').length;
            const confirmAction = confirmation.allowed
              ? `<div class="button-row"><button class="secondary" id="boss-confirm-${esc(item.applicationId)}" data-boss-confirm="${esc(confirmation.applicationIds.join(','))}" ${ignoreDisabled ? 'disabled' : ''}>确认资料对应此岗位</button><small>本次可完成 ${confirmation.observationCount} 项普通资料处理${confirmation.excludedApplicationIds?.length ? `，其他 ${confirmation.excludedApplicationIds.length} 项保留` : ''}。</small></div>`
              : item.observations.some((row) =>
                    ['missing_job_details', 'identity_conflict'].includes(row.reason),
                  )
                ? `<p class="boss-resolution-blocked">暂不能确认资料：${esc(confirmation.reason)}</p>`
                : '';
            const reason = bossObservationReason(item);
            const problem = reason === item.reason ? '来源材料尚需进一步核对' : reason;
            const semanticMissing = item.reason === 'resume_semantics_missing';
            const next =
              item.status === 'review'
                ? '核对具体矛盾及相关岗位，修复原因后重新检查。'
                : semanticMissing
                  ? '核对真实聊天后自行编辑岗位；编辑不会补齐平台状态依据，不再采用的旧观察可单独确认忽略。'
                  : '先核对候选岗位；普通资料可确认对应，不再采用的旧等待项可单独确认忽略。';
            return `<li class="boss-observation-card"><label class="boss-observation-choice">${item.waitingApplicationIds.length ? `<input type="checkbox" id="boss-ignore-${esc(item.applicationId)}" data-boss-ignore-item="${esc(item.waitingApplicationIds.join(','))}" ${item.waitingApplicationIds.every((id) => selected.has(id)) ? 'checked' : ''} ${selectionDisabled ? 'disabled' : ''}>` : ''}<span><strong>${candidateLabel(item)}</strong><span class="boss-observation-meta">${esc(item.contact || '联系人未取得')} · 包含 ${item.observations.length} 项观察 · ${esc(dateLabel)}</span>${item.platformJobState !== 'unknown' ? `<span class="badge">${esc(PLATFORM_JOB_LABELS[item.platformJobState] || '平台状态需核对')}</span>` : ''}</span></label><dl class="issue-steps"><dt>发生了什么</dt><dd>${esc(problem)}${item.reason === 'missing_job_details' && item.missingFields?.length ? `：${esc(item.missingFields.join('、'))}未取得` : ''}</dd><dt>影响</dt><dd>${semanticMissing ? '这项观察不能证明简历已发送或已接收，也不确认岗位归属。' : `此处尚未处理的观察未用于更新岗位${reviewCount ? '；矛盾材料继续拦截' : ''}。`}</dd><dt>下一步</dt><dd>${esc(next)}</dd></dl><p>可忽略 ${item.waitingApplicationIds.length} 项等待观察${reviewCount ? `；仍需核对 ${reviewCount} 项矛盾观察，勾选不会关闭这些矛盾` : ''}。</p>${review}${relatedView}${confirmAction}<details data-settings-details="boss-message-${esc(item.applicationId)}"><summary>技术详情 · ${item.observations.length} 项观察</summary>${item.observations.map((observation) => `<p>${esc(observation.observationType)} · ${esc(bossObservationReason(observation))}</p>`).join('')}</details></li>`;
          })
          .join('')}</ul></section>`;
      })
      .join('') +
    (attribution.items || [])
      .filter(
        (item) => !waitingItems.length || !['insufficient', 'semantic'].includes(item.category),
      )
      .map((item) => `<p>${esc(item.label)} · ${candidateLabel(item)}</p>`)
      .join('');
  const selectedMessages = waitingItems.filter((item) =>
    item.waitingApplicationIds.some((id) => selected.has(id)),
  ).length;
  const selectedCount = waitingItems
    .flatMap((item) => item.waitingApplicationIds)
    .filter((id) => selected.has(id)).length;
  const ignoreAction = waitingItems.some((item) => item.waitingApplicationIds.length)
    ? `<div class="boss-ignore-actions"><p>已选 <strong>${selectedMessages}</strong> 条消息 / <strong>${selectedCount}</strong> 项观察。忽略后原始记录保留，同一事实不再自动应用，新消息继续处理。</p>${blockedReason ? `<p role="status">${blockedReason}</p>${pendingConflict ? '<button class="text-button" data-action="resolve-pending">处理同步冲突</button>' : ''}` : ''}<div class="button-row"><button class="secondary" id="boss-ignore-selected" data-boss-ignore="true" ${ignoreDisabled || !selectedCount ? 'disabled' : ''}>忽略所选观察</button><button class="text-button" data-boss-refresh="true" ${busy ? 'disabled' : ''}>刷新本机状态</button></div></div>`
    : '';
  const historyStats = history
    ? bossStats([
        [history.pending, '个聊天待检查'],
        [history.paginating, '个聊天仍有后续页待检查'],
        [history.waitingRetry, '个聊天等待重试'],
        [history.truncated, '个聊天的检查范围不完整'],
        [history.failed, '个聊天读取失败'],
        [history.isolated, '个聊天因技术问题暂停检查'],
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
  const receiptCount = server.receipts ?? server.receiptCount ?? server.processed;
  const diagnostics = bossStats([
    [status.pending, '待录入批次'],
    [server.incidents ?? server.incidentCount, '份故障诊断记录'],
  ]);
  const receipts =
    Number(receiptCount) > 0
      ? `<p>本机保存了 <strong>${Number(receiptCount)}</strong> 份采集批次处理记录。</p><small>用于避免重复录入和恢复核对；一批可含多条消息，处理记录不代表所有消息都已用于更新岗位。</small>`
      : '';
  const historyProgress = history
    ? `<h3>历史聊天检查进度</h3>${history.mode === 'backfill' ? '<p>上次采集方式：手动补录。</p>' : history.mode === 'change' ? '<p>上次采集方式：检查有变化的聊天。</p>' : ''}${Number.isSafeInteger(history.completed) && history.completed >= 0 ? `<p>已有历史检查记录的聊天：<strong>${history.completed}</strong> 个。</p><small>这些聊天当前没有待继续的历史检查任务。</small>` : ''}${historyStats}<p>这是保存的检查进度，不是上次新增的消息或岗位数量；也不表示每个聊天的全部历史都已读完。</p>`
    : '';
  const result = bossProcessingFeedback(
    data,
    { ...status, connectionStale: status.connectionStale || offline },
    feedback,
  );
  const waitingSummary = messageGroups.length
    ? `待核对 ${messageGroups.length} 条消息 · ${messageGroups.reduce((sum, group) => sum + group.observations.length, 0)} 项观察`
    : '';
  const systemWaiting =
    Number(detail?.pending || 0) +
      Number(detail?.deferred || 0) +
      Number(history?.waitingRetry || 0) +
      Number(history?.pending || 0) >
    0;
  return `<section class="panel" id="boss-collection"><div class="panel-header"><h2 id="boss-card-title" tabindex="-1">BOSS 采集</h2><span class="badge ${needsAttention || status.connectionStale ? 'warn' : 'blue'}">${badge}</span></div><div class="panel-body"><p>${status.connectionStale ? '上次状态：' : ''}${trackingLabel} · ${status.serverManaged ? lastSuccess : status.available && !status.connectionStale ? '本机队列已连接' : '队列状态待确认'}</p><p>${description}</p>${review > 0 && !messageGroups.some((group) => group.status === 'review') ? `<p class="warning">存在 ${review} 项归属或资料矛盾，需核对相关岗位；这些材料尚未用于更新岗位。</p>` : ''}${result ? `<p class="settings-result" role="status">${esc(result)}</p>` : ''}${alerts}${observations ? `<details class="settings-problems" data-settings-details="boss-observations"><summary id="boss-observations-toggle">${waitingSummary ? esc(waitingSummary) : '查看待核对原因'}</summary>${waitingText}${ignoreAction}${observations}</details>` : waitingText ? waitingText : !needsAttention && !status.connectionStale ? '<p class="settings-healthy">暂无需要处理的问题。</p>' : ''}${
    systemWaiting
      ? `<section class="settings-waiting"><h3>系统等待</h3>${bossStats([
          [detail?.pending, '个岗位待补详情'],
          [detail?.deferred, '个岗位等待重试'],
          [history?.pending, '个会话待采集'],
          [history?.waitingRetry, '个会话等待重试'],
          [history?.paginating, '个会话分页未完成'],
        ])}${detail?.nextRetryAt ? `<p>下次详情重试时间：${esc(new Date(detail.nextRetryAt).toLocaleString('zh-CN'))}</p>` : ''}<p>${tracking.lifecycle === 'running' ? '已授权跟踪会按预算及退避继续，只使用允许的采集范围。' : '跟踪未运行，尚未采到的资料不会自动继续取得；需要采集时请明确开始或恢复跟踪。'}</p></section>`
      : ''
  }<details data-settings-details="boss-start"><summary>如何开始或恢复采集</summary><p>在本机终端明确执行采集命令；打开此页面和重启服务不会开始跟踪。</p><p><code>pnpm boss start</code> 开始跟踪；<code>pnpm boss stop</code> 停止。</p><p>已有材料的录入和检查由本机服务处理，无需反复补录或重启。</p></details><details class="section-gap" data-settings-details="boss-status"><summary id="boss-status-toggle">运行详情</summary>${diagnostics}${receipts}${historyProgress}${detailStats}${detail?.lastError ? `<p>详情错误码：${esc(detail.lastError)}</p>` : ''}${
    budget ? bossBudgetView(budget, tracking.lifecycle) : ''
  }${accounts
    .filter((account) => account.bound && !account.restoreRequired)
    .map((account) => bossAccountView(account, mutableDisabled))
    .join(
      '',
    )}${status.sourceId ? `<small>当前工作区来源：${esc(status.sourceId.slice(0, 8))}。</small>` : ''}</details>${Number(counts.protected) > 0 || Number(counts.ignored) > 0 ? `<details data-settings-details="boss-records"><summary>处理记录</summary>${Number(counts.protected) > 0 ? `<p>人工决定已保留：<strong>${Number(counts.protected)}</strong>，包括人工字段保护和否决。</p>` : ''}${Number(counts.ignored) > 0 ? `<p>已忽略：<strong>${Number(counts.ignored)}</strong>。</p>` : ''}<small>这些记录已按人工决定处理，无需再次核对。</small></details>` : ''}</div></section>`;
}

function connectionForm(c, token, syncing) {
  return `<form id="settings-form" class="form-stack"><div class="form-grid"><label>GitHub 用户名<input name="owner" value="${esc(c.owner)}" required></label><label>私有仓库名<input name="repo" value="${esc(c.repo)}" required></label><label class="span-2">数据文件路径<input name="path" value="${esc(c.path)}" required></label><label class="span-2">本次会话的访问令牌<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="Fine-grained personal access token" value="${esc(token || '')}"></label></div><button class="primary" type="submit" ${syncing ? 'disabled' : ''}>保存连接设置</button><small>令牌只在当前页面会话中使用，关闭或刷新后需要重新填写。</small></form><div class="button-row"><a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">创建专用令牌 ↗</a><button class="text-button" data-action="forget-token">清除当前令牌</button></div>`;
}

export function bossDetailsConfirmationView(preview, error = '', busy = false) {
  return `<form id="boss-details-form"><div class="dialog-header"><div><h2>确认资料对应此岗位</h2><p>仅结束下列普通岗位资料的等待。</p></div><button class="close" type="button" data-close="import-dialog" aria-label="取消" ${busy ? 'disabled' : ''}>×</button></div><div class="dialog-body"><p>本机候选岗位：<strong>${esc(preview.target.company)} / ${esc(preview.target.role)}</strong></p><p>本次处理 ${Number(preview.messageCount)} 条消息 / ${Number(preview.observationCount)} 项普通资料观察。</p><p>确认后保存人工资料对应决定；原始观察保留，不修改简历状态或招聘阶段，也不确认简历消息归属。</p>${preview.fillsJobId ? '<p>此岗位尚无平台岗位编号，确认时会同时补入经规范链接核对的岗位编号。</p>' : ''}${preview.excludedApplicationIds?.length ? `<p>同组其他 ${preview.excludedApplicationIds.length} 项观察继续按各自原因处理。</p>` : ''}<p class="error" id="boss-details-error" role="alert">${esc(error)}</p><details><summary>技术详情：规范岗位身份</summary><p>${esc(preview.externalJobId)}</p><p>${esc(preview.canonicalUrl)}</p></details></div><div class="dialog-footer"><button class="secondary" type="button" data-close="import-dialog" ${busy ? 'disabled' : ''}>取消</button><button class="primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? '保存中…' : '确认资料对应'}</button></div></form>`;
}

export function settingsView({
  state,
  ssh,
  sshTarget,
  token,
  syncing,
  diagnostic,
  backupStatus,
  bossStatus,
  bossIgnoreSelected,
  bossIgnoreBusy,
  bossFeedback,
  persistence = {},
}) {
  const c = state.config;
  const local = persistence.local || bossStatus?.serverManaged;
  const diskLocal = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname);
  const dirty = !equal(state.data, state.base);
  const syncLabel = persistence.offline
    ? '本机服务离线'
    : syncing
      ? '同步中'
      : state.pending
        ? '有同步冲突'
        : dirty
          ? '本机已保存，待同步'
          : state.lastSync
            ? '已同步'
            : '尚未同步';
  const lastSync = state.lastSync
    ? new Date(state.lastSync).toLocaleString('zh-CN')
    : '尚无成功同步记录';
  const conflict = state.pending
    ? issueCard({
        title: '本机与云端修改有分歧',
        problem: `${state.pending.conflicts.length} 项记录需要选择保留的版本。`,
        impact: '双方内容均保留；相关岗位暂不能继续处理依赖操作。',
        next: '逐组核对差异，保存全部选择后再手动同步。',
        actions: '<button class="secondary" data-action="resolve-pending">处理同步冲突</button>',
      })
    : '';
  const backupFailure =
    backupStatus?.error ||
    (backupStatus?.message?.startsWith('独立备份未完成') ? backupStatus.message : '');
  return `<div class="settings">${bossIntegrationView(bossStatus, { selected: bossIgnoreSelected, pendingConflict: Boolean(state.pending), busy: bossIgnoreBusy, data: state.data, feedback: bossFeedback, offline: persistence.offline })}<section class="panel" id="github-sync"><div class="panel-header"><h2>GitHub 同步</h2><span class="badge ${state.pending || persistence.offline ? 'warn' : 'blue'}">${syncLabel}</span></div><div class="panel-body"><p>最近成功同步：${esc(lastSync)}</p><p>${ssh ? '本机通过 SSH 手动同步，私钥始终留在本机。' : local ? '本机正式工作区需要使用服务中配置的 SSH 同步。' : '此设备先保存在浏览器，通过本次会话令牌手动同步。'}</p>${conflict}${local && !ssh ? issueCard({ title: '本机 SSH 同步尚未连接', problem: '当前服务未提供与工作区一致的同步目标。', impact: '记录保留在本机，尚不能上传 GitHub。', next: '核对本机服务配置，然后检查连接；不会改用令牌写入本机工作区。' }) : ''}<div class="button-row"><button class="primary" data-action="sync" ${syncing || persistence.offline || (local && !ssh) ? 'disabled' : ''}>${syncing ? '同步中…' : state.pending ? '核对冲突后同步' : '手动同步到 GitHub'}</button><button class="secondary" data-action="diagnose" ${syncing ? 'disabled' : ''}>检查连接</button></div><p id="diagnostic-result" role="status">${esc(diagnostic || '检查只读取连接和云端文件，不上传记录。')}</p><details data-settings-details="sync-config" ${!local && !token ? 'open' : ''}><summary id="sync-other-toggle">连接配置</summary><p>目标：${esc(c.owner)}/${esc(c.repo)} · ${esc(c.path)}</p>${local ? `<p>本机正式工作区使用服务配置的 SSH 目标。手机或公开静态网页可在各自页面使用会话令牌同步。</p>${sshTarget && !ssh ? `<p>本机服务的目标：${esc(sshTarget.owner)}/${esc(sshTarget.repo)} · ${esc(sshTarget.path)}</p><button class="secondary" data-action="use-ssh-target" ${syncing || persistence.offline || state.pending ? 'disabled' : ''}>使用本机 SSH 配置</button>` : ''}` : connectionForm(c, token, syncing)}</details></div></section><section class="panel" id="backup-files"><div class="panel-header"><h2>备份与文件</h2><span class="badge ${backupFailure ? 'warn' : ''}">${backupFailure ? '备份未完成' : diskLocal ? '本机备份' : '下载备份'}</span></div><div class="panel-body">${diskLocal ? `<p id="disk-backup-status" role="status">${esc(backupStatus?.message || '正在检查最近备份…')}</p>${backupFailure ? issueCard({ title: '独立备份尚未完成', problem: '最近一次写入磁盘备份失败。', impact: '正式记录和草稿仍保留，但最新内容尚未取得这份磁盘备份。', next: '检查服务、磁盘和目录问题；修复后重试备份，也可以先下载完整备份。', technical: backupFailure }) : ''}` : '<p>完整备份包含岗位、同步基线、未解决冲突和当前浏览器草稿。</p>'}<div class="button-row"><button class="primary" data-action="export-json">下载完整备份</button>${diskLocal ? '<button class="secondary" data-action="disk-backups">查看磁盘备份</button><button class="text-button" data-action="backup-now">立即备份</button>' : ''}</div><small>${diskLocal ? '磁盘备份仍在这台电脑上；重要备份请下载到独立位置。' : '清理网站数据会删除浏览器记录，请单独保存备份文件。'}</small><details data-settings-details="backup-files"><summary>导入、恢复与其他导出</summary><div class="button-row"><button class="secondary" data-action="choose-file">导入记录或恢复 JSON 备份</button><button class="secondary" data-action="export-md">导出 Markdown</button><button class="secondary" data-action="snapshots">${local ? '查看浏览器旧快照' : '查看浏览器操作快照'}</button></div><p>Markdown 适合阅读；JSON 完整备份用于恢复。恢复前先核对内容，恢复后不会自动上传。</p><p>${local ? '浏览器旧快照保存在此浏览器，不代表本机服务的正式提交历史。清理网站数据会删除这些旧快照。' : '浏览器操作快照保留最近 20 次关键操作前的状态，清理网站数据会删除。'}</p><small>已导入 ${live(state.data.imports).length} 个批次，原文保留在私有数据中。</small></details>${diskLocal ? '<details data-settings-details="backup-how"><summary>自动备份如何工作</summary><p>工作台和服务运行时，保存记录或草稿后自动写入本机私有目录。每个来源保留最近 30 个有备份日期的首份和最新一份。</p><p>关闭页面前最后几秒的草稿可能尚未写入磁盘，下次打开后补备份。服务正式提交历史与浏览器旧快照分别保留。</p></details>' : ''}</div></section><details class="settings-technical" data-settings-details="app-runtime"><summary>应用运行详情</summary><p>版本 v${APP_VERSION} · 数据文件 ${(utf8Bytes(serialize(state.data)) / 1000).toFixed(1)} KB / 5 MB</p></details></div>`;
}
