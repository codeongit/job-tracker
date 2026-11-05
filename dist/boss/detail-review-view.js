import { esc } from '../ui.js';
import { parseBossJobUrl } from './contracts/job-url.js';

const dateLabel = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : '时间未取得';
const errorLabel = (code) =>
  ({
    DETAIL_TITLE_NOT_READY: '页面标题尚不能识别为有效岗位资料',
    DETAIL_TAB_UNEXPECTED_URL: '详情页进入了非预期网址',
    DETAIL_NAVIGATION_TIMEOUT: '详情页导航等待超时',
    DETAIL_TAB_OWNERSHIP_MISMATCH: '详情标签归属需要核对',
  })[code] || '详情资料尚未取得，请核对原岗位页面';

export function bossDetailReviewView(
  state = {},
  { offline = false, pendingConflict = false } = {},
) {
  const { details, loading, busy, stale, error, feedback, pendingCommand, retryUnconfirmed } =
    state;
  const button = (action, label, row, disabled = false) =>
    `<button class="secondary" data-boss-detail-action="${action}"${row ? ` data-boss-detail-job="${esc(row.jobId)}"` : ''}${disabled ? ' disabled' : ''}>${label}</button>`;
  const refresh = button(
    'refresh',
    loading ? '正在刷新…' : '处理详情异常 / 刷新',
    null,
    Boolean(loading || busy || offline),
  );
  if (!details && !error && !loading) return `<div class="button-row">${refresh}</div>`;
  const cannotChange = Boolean(
    offline ||
    busy ||
    loading ||
    stale ||
    pendingCommand ||
    details?.lifecycle !== 'stopped' ||
    details?.cycleInProgress,
  );
  const tasks = (details?.items || []).filter(
    (row) => !['manually_stopped', 'inactive'].includes(row.status),
  );
  const records = (details?.items || []).filter(
    (row) => row.resolution && ['manually_stopped', 'inactive'].includes(row.status),
  );
  const card = (row, record = false) => {
    const parsed = parseBossJobUrl(row.canonicalUrl);
    const link =
      parsed?.jobId === row.jobId && parsed.canonicalUrl === row.canonicalUrl
        ? `<a class="text-button" href="${esc(parsed.canonicalUrl)}" target="_blank" rel="noopener noreferrer">打开原岗位链接</a>`
        : '<small>原岗位链接无法核对，请查看本机资料。</small>';
    const label =
      [row.company, row.jobName].filter(Boolean).join(' / ') || `岗位 ${row.jobId.slice(0, 12)}`;
    const stopped = row.status === 'manually_stopped';
    const result = record
      ? `<p>${stopped ? '已人工停止详情采集' : '人工处理已撤销，当前无对应采集待办'} · ${esc(dateLabel(row.resolution.at))}</p><p>${!stopped ? '原停止决定已撤销；未因此发起平台请求。' : row.resolution.reason === 'manual_details' ? '处理时已核对本机岗位资料；资料以后变化仍需单独处理。' : '已决定不再自动取得该岗位详情。'}</p>`
      : row.status === 'available'
        ? '<p>等待取得详情；尚无当前失败记录。</p>'
        : `<p>${esc(errorLabel(row.error))}</p><p>已失败 ${Number(row.attempts || 0)} 次 · 最近尝试 ${esc(dateLabel(row.lastAttemptAt))}</p>`;
    const edit =
      row.matchingOpportunityId || row.canCreateOpportunity
        ? button(
            'edit',
            row.matchingOpportunityId ? '核对 / 补齐岗位资料' : '补建岗位资料',
            row,
            Boolean(offline || busy || loading || stale || pendingConflict),
          )
        : '<button class="text-button" data-view="list">到岗位列表核对</button>';
    const actions = stopped
      ? button('reopen', '撤销人工处理', row, cannotChange)
      : record
        ? ''
        : `${edit}${button('manual_details', '资料已补齐，停止详情采集', row, cannotChange || !row.canCompleteWithDetails || pendingConflict)}${button('not_needed', '无需继续采集详情', row, cannotChange)}${button('retry', '仅重试此岗位一次', row, cannotChange || !row.canRetry || Boolean(retryUnconfirmed))}`;
    return `<li class="boss-observation-card"><strong>${esc(label)}</strong>${row.contact ? `<small>${esc(row.contact)}</small>` : ''}${result}<div class="button-row">${link}${actions}</div>${!record && !row.canCompleteWithDetails && row.completionBlockedReason ? `<small>${esc(row.completionBlockedReason)}</small>` : ''}${row.error ? `<details><summary>技术详情</summary><code>${esc(row.error)}</code></details>` : ''}</li>`;
  };
  return `<section class="section-gap" aria-label="岗位详情人工处理"><h3>岗位详情人工处理</h3><p>人工处理只结束详情采集待办，不确认消息归属、不结束岗位跟进。决定仅此电脑生效，重启保留，不随求职资料备份或同步。</p><div class="button-row">${refresh}${details && details.lifecycle !== 'stopped' ? button('stop', '先停止跟踪', null, Boolean(busy || offline)) : ''}</div>${details?.cycleInProgress ? '<p role="status">当前轮次正在收尾，请等待后刷新；不会另发平台请求。</p>' : ''}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}${feedback ? `<p role="status">${esc(feedback)}</p>` : ''}${pendingCommand ? `<p>原人工处理请求的结果尚未确认。</p>${button('reconcile', '核对原处理请求', null, Boolean(busy || offline))}` : ''}${retryUnconfirmed ? '<p>一次详情补查的结果正在核对，刷新只读取本机状态，不会重发补查。</p>' : ''}${tasks.length ? `<ul class="boss-observation-list">${tasks.map((row) => card(row)).join('')}</ul>` : details && !stale ? '<p>当前没有待人工处理的详情采集任务。</p>' : ''}${records.length ? `<details data-settings-details="boss-detail-resolutions" open><summary>人工处理记录 · ${records.length} 项</summary><ul class="boss-observation-list">${records.map((row) => card(row, true)).join('')}</ul></details>` : ''}</section>`;
}
