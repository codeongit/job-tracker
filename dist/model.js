import { DATA_VERSION } from './version.js';
import { bossApplicationId, bossFactId, hasBossFactIdentity } from './source-identity.js';
export const GROUPS = [
  'opportunities',
  'activities',
  'tasks',
  'imports',
  'sourceBindings',
  'sourceEvents',
  'sourceFacts',
  'sourceApplications',
];
export const STAGES = ['已触达', '沟通中', '面试中', 'Offer', '已结束'];
export const READ_STATES = ['未读', '已读'];
export const SOURCE_AUTO_FIELDS = [
  'company',
  'role',
  'platform',
  'contact',
  'url',
  'externalId',
  'resumeState',
  'readState',
  'stage',
];
export const SOURCE_BINDING_FIELDS = [
  'id',
  'kind',
  'platform',
  'accountNamespace',
  'workspaceSourceId',
  'externalJobId',
  'canonicalUrl',
  'opportunityId',
  'autoFields',
  'lastAutoCompany',
  'lastAutoRole',
  'lastAutoUrl',
  'lastAutoContact',
  'lastAutoPlatform',
  'lastAutoExternalId',
  'lastAutoResumeState',
  'lastAutoReadState',
  'lastAutoStage',
  'createdAt',
  'updatedAt',
  'deletedAt',
];
export const SOURCE_EVENT_FIELDS = [
  'id',
  'batchId',
  'factId',
  'platform',
  'accountNamespace',
  'conversationKey',
  'friendId',
  'friendSource',
  'uniqueId',
  'externalJobId',
  'opportunityId',
  'eventType',
  'messageId',
  'messageDirection',
  'receiptStatus',
  'receiptSource',
  'summary',
  'timeLabel',
  'contact',
  'company',
  'jobName',
  'nameSource',
  'canonicalUrl',
  'linkConfirmation',
  'observedAt',
  'evidenceDate',
  'appliedAtSource',
  'sourceSnapshot',
  'sourceSequence',
  'status',
  'importPolicy',
  'createdAt',
  'deletedAt',
];
// Map retired UI values without rewriting sync baselines, backups, or draft originals.
export function getOpportunityStatus({ stage, readState } = {}) {
  return {
    stage: !stage || stage === '待联系' ? '已触达' : stage,
    readState: readState === '已读' ? '已读' : '未读',
  };
}
// Apply the user's BOSS workflow only during explicit edits/confirmations, not data loading.
export function getResumeLinkedStatus(opportunity) {
  if (
    !/^boss(?:直聘)?$/i.test((opportunity.platform || '').replace(/\s/g, '')) ||
    !['已发送', '对方已接收'].includes(opportunity.resumeState)
  )
    return {};
  return {
    readState: '已读',
    stage: getOpportunityStatus(opportunity).stage === '已触达' ? '沟通中' : opportunity.stage,
  };
}
export function getSentResumeStatus(opportunity) {
  const resumeState = opportunity.resumeState === '对方已接收' ? '对方已接收' : '已发送';
  return { resumeState, ...getResumeLinkedStatus({ ...opportunity, resumeState }) };
}
export const emptyData = () => ({
  schemaVersion: DATA_VERSION,
  opportunities: [],
  activities: [],
  tasks: [],
  imports: [],
  sourceBindings: [],
  sourceEvents: [],
  sourceFacts: [],
  sourceApplications: [],
});
export const clone = (value) => structuredClone(value);
export const uid = () => crypto.randomUUID();
export const live = (rows) => rows.filter((row) => !row.deletedAt);
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export function canonical(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    const rows = value.every((x) => x && typeof x === 'object' && typeof x.id === 'string')
      ? [...value].sort((a, b) => a.id.localeCompare(b.id))
      : value;
    return `[${rows.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const equal = (a, b) => canonical(a) === canonical(b);
export function serialize(data) {
  return (
    JSON.stringify(
      {
        schemaVersion: DATA_VERSION,
        ...Object.fromEntries(
          GROUPS.map((g) => [g, [...data[g]].sort((a, b) => a.id.localeCompare(b.id))]),
        ),
      },
      null,
      2,
    ) + '\n'
  );
}

const OPPORTUNITY_FIELDS = [
  'id',
  'company',
  'role',
  'platform',
  'source',
  'contact',
  'url',
  'externalId',
  'appliedAt',
  'stage',
  'readState',
  'resumeState',
  'endReason',
  'priority',
  'location',
  'salary',
  'description',
  'notes',
  'rawStatus',
  'createdAt',
  'updatedAt',
  'deletedAt',
];
const FIELDS = {
  opportunities: OPPORTUNITY_FIELDS,
  activities: ['id', 'opportunityId', 'date', 'type', 'text', 'createdAt', 'deletedAt'],
  tasks: [
    'id',
    'opportunityId',
    'text',
    'dueAt',
    'status',
    'createdAt',
    'completedAt',
    'deletedAt',
  ],
  imports: ['id', 'filename', 'year', 'importedAt', 'rawText', 'deletedAt'],
  sourceBindings: SOURCE_BINDING_FIELDS,
  sourceEvents: SOURCE_EVENT_FIELDS,
  sourceFacts: [
    'id',
    'legacyEventId',
    'platform',
    'accountNamespace',
    'conversationKey',
    'messageId',
    'factType',
    'externalJobId',
    'evidenceSource',
    'evidenceRef',
    'observedAt',
    'createdAt',
    'deletedAt',
  ],
  sourceApplications: [
    'id',
    'factId',
    'opportunityId',
    'ruleVersion',
    'action',
    'status',
    'reason',
    'appliedAt',
    'updatedAt',
    'deletedAt',
  ],
};
const REQUIRED = {
  opportunities: ['company', 'role', 'stage'],
  activities: ['opportunityId', 'text'],
  tasks: ['opportunityId', 'text', 'status'],
  imports: ['filename', 'rawText'],
};
const ACCOUNT_BINDING_FIELDS = [
  'id',
  'kind',
  'platform',
  'accountNamespace',
  'workspaceSourceId',
  'createdAt',
  'updatedAt',
  'deletedAt',
];
const OPPORTUNITY_BINDING_REQUIRED = [
  'platform',
  'accountNamespace',
  'externalJobId',
  'canonicalUrl',
  'opportunityId',
  'createdAt',
];
const SOURCE_EVENT_REQUIRED = [
  'batchId',
  'platform',
  'accountNamespace',
  'conversationKey',
  'eventType',
  'messageDirection',
  'receiptStatus',
  'observedAt',
  'sourceSnapshot',
  'sourceSequence',
  'status',
  'importPolicy',
  'createdAt',
];
const SOURCE_IDENTIFIER_FIELDS = new Set([
  'id',
  'batchId',
  'factId',
  'platform',
  'accountNamespace',
  'workspaceSourceId',
  'externalJobId',
  'opportunityId',
  'conversationKey',
  'friendId',
  'friendSource',
  'uniqueId',
  'messageId',
  'receiptSource',
  'nameSource',
  'linkConfirmation',
  'appliedAtSource',
  'sourceSnapshot',
  'sourceSequence',
  'importPolicy',
]);

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}
function validIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const BOSS_ACCOUNT_NAMESPACE = /^boss-geek:[a-f0-9]{64}$/;
const BOSS_BATCH_ID = /^boss-batch-[a-f0-9]{64}$/;
const BOSS_EVENT_ID = /^boss-event-[a-f0-9]{64}$/;
const BOSS_JOB_ID = /^[A-Za-z0-9_-]{1,300}$/;
const BOSS_CONVERSATION_KEY = /^[a-f0-9]{64}$/;
const BOSS_SNAPSHOT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.json#sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validBossJobUrl(value, jobId) {
  if (!BOSS_JOB_ID.test(jobId)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'www.zhipin.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      value === new URL(`/job_detail/${jobId}.html`, 'https://www.zhipin.com').href
    );
  } catch {
    return false;
  }
}
function validateBossSourceIdentity(item, group) {
  if (item.platform !== 'boss' || !BOSS_ACCOUNT_NAMESPACE.test(item.accountNamespace))
    throw new Error(`${group} 的平台账号身份无效。`);
}
function validateSourceText(group, field, value) {
  const limit = field === 'summary' ? 50000 : field === 'canonicalUrl' ? 4096 : 200000;
  if (value.length > limit) throw new Error(`${group}.${field} 内容过长。`);
  if (value.includes('\0')) throw new Error(`${group}.${field} 包含不支持的控制字符。`);
  if (SOURCE_IDENTIFIER_FIELDS.has(field) && value.length > 1000)
    throw new Error(`${group}.${field} 标识过长。`);
  if (SOURCE_IDENTIFIER_FIELDS.has(field) && value !== value.trim())
    throw new Error(`${group}.${field} 标识包含首尾空白。`);
}
function requireSourceFields(group, item, fields) {
  if (fields.some((field) => !hasOwn(item, field) || !item[field].trim()))
    throw new Error(`${group} 缺少必要来源字段。`);
}
function validateSourceBinding(item) {
  if (!['account', 'opportunity'].includes(item.kind))
    throw new Error('sourceBindings.kind 不支持。');
  validateBossSourceIdentity(item, 'sourceBindings');
  if (!validIso(item.createdAt)) throw new Error('sourceBindings.createdAt 无效。');
  if (item.updatedAt && !validIso(item.updatedAt))
    throw new Error('sourceBindings.updatedAt 无效。');
  if (item.deletedAt && !validIso(item.deletedAt))
    throw new Error('sourceBindings.deletedAt 无效。');
  if (item.kind === 'account') {
    requireSourceFields('sourceBindings', item, [
      'platform',
      'accountNamespace',
      'workspaceSourceId',
      'createdAt',
    ]);
    if (Object.keys(item).some((field) => !ACCOUNT_BINDING_FIELDS.includes(field)))
      throw new Error('账号来源绑定包含岗位字段。');
    if (item.id !== `boss-account-${item.accountNamespace.slice('boss-geek:'.length)}`)
      throw new Error('账号来源绑定 ID 无效。');
    if (!UUID.test(item.workspaceSourceId)) throw new Error('账号来源工作区 ID 无效。');
    return;
  }
  requireSourceFields('sourceBindings', item, OPPORTUNITY_BINDING_REQUIRED);
  if (hasOwn(item, 'workspaceSourceId')) throw new Error('岗位来源绑定包含账号工作区字段。');
  if (!validBossJobUrl(item.canonicalUrl, item.externalJobId))
    throw new Error('岗位来源绑定链接无效。');
  if (
    item.id !==
    `boss-job-${item.accountNamespace.slice('boss-geek:'.length)}-${encodeURIComponent(item.externalJobId)}`
  )
    throw new Error('岗位来源绑定 ID 无效。');
  if (item.autoFields !== undefined) {
    const fields = item.autoFields ? item.autoFields.split(',') : [];
    const canonical = SOURCE_AUTO_FIELDS.filter((field) => fields.includes(field));
    if (
      new Set(fields).size !== fields.length ||
      fields.some((field) => !SOURCE_AUTO_FIELDS.includes(field)) ||
      item.autoFields !== canonical.join(',')
    )
      throw new Error('岗位来源绑定的自动字段列表无效。');
  }
}
function validateSourceEvent(item) {
  requireSourceFields('sourceEvents', item, SOURCE_EVENT_REQUIRED);
  validateBossSourceIdentity(item, 'sourceEvents');
  const completeFactIdentity = hasBossFactIdentity(item);
  if (
    !BOSS_EVENT_ID.test(item.id) ||
    !BOSS_BATCH_ID.test(item.batchId) ||
    !hasOwn(item, 'factId') ||
    (completeFactIdentity ? item.factId !== bossFactId(item) : item.factId !== '') ||
    !BOSS_CONVERSATION_KEY.test(item.conversationKey) ||
    !BOSS_SNAPSHOT.test(item.sourceSnapshot)
  )
    throw new Error('来源事件稳定身份无效。');
  if (
    !item.friendId?.trim() ||
    !item.friendSource?.trim() ||
    item.uniqueId !== `${item.friendId}-${item.friendSource}`
  )
    throw new Error('来源事件会话身份无效。');
  if (
    ['receiptSource', 'nameSource', 'linkConfirmation', 'appliedAtSource'].some(
      (field) => !hasOwn(item, field),
    )
  )
    throw new Error('sourceEvents 缺少必要证据字段。');
  if (!['conversation_observed', 'resume_observed'].includes(item.eventType))
    throw new Error('sourceEvents.eventType 不支持。');
  if (!['inbound', 'outbound', 'unknown'].includes(item.messageDirection))
    throw new Error('sourceEvents.messageDirection 不支持。');
  if (!['read', 'delivered', 'unknown', 'not_applicable'].includes(item.receiptStatus))
    throw new Error('sourceEvents.receiptStatus 不支持。');
  if (item.eventType === 'conversation_observed') {
    if (item.messageDirection === 'inbound' && item.receiptStatus !== 'not_applicable')
      throw new Error('入站消息不能附加对方回执。');
    if (item.messageDirection === 'unknown' && item.receiptStatus !== 'unknown')
      throw new Error('方向未知的消息不能推断回执。');
  } else if (
    !['inbound', 'outbound'].includes(item.messageDirection) ||
    item.receiptStatus !== 'not_applicable' ||
    item.receiptSource ||
    ![
      'resume_sent_candidate',
      'resume_card_other',
      'resume_request_sent',
      'resume_sent_confirmed',
      'resume_attachment_sent',
      'resume_viewed_confirmed',
    ].includes(item.summary)
  ) {
    throw new Error('来源简历观察结构无效。');
  }
  if (
    (['read', 'delivered'].includes(item.receiptStatus) && !item.receiptSource.trim()) ||
    (!['read', 'delivered'].includes(item.receiptStatus) && item.receiptSource)
  )
    throw new Error('来源事件回执与证据来源不相容。');
  if (item.receiptSource && item.receiptSource !== 'list_receipt_label')
    throw new Error('来源事件回执证据来源无效。');
  if (!['', 'loaded_jobName', 'detail_page_title', 'legacy_named_job'].includes(item.nameSource))
    throw new Error('来源事件岗位名称来源无效。');
  if (!['confirmed_user', 'unverified'].includes(item.linkConfirmation))
    throw new Error('来源事件链接确认状态无效。');
  if (
    !['', 'user_confirmed_initial_contact_date', 'platform_same_day_time_label'].includes(
      item.appliedAtSource,
    )
  )
    throw new Error('来源事件首次联系日期依据无效。');
  if (item.appliedAtSource && !item.evidenceDate)
    throw new Error('来源事件首次联系日期依据缺少证据日期。');
  if (!['recorded', 'review', 'skipped'].includes(item.status))
    throw new Error('sourceEvents.status 不支持。');
  if (
    ![
      'boss-initial-2026-09-18-v1',
      'boss-manual-check-v1',
      'boss-resume-observation-v1',
      'boss-resume-observation-v2',
      'boss-resume-observation-v3',
    ].includes(item.importPolicy) &&
    !/^boss-user-dated-label-\d{4}-\d{2}-\d{2}-v1$/.test(item.importPolicy) &&
    !/^boss-resume-observation-date-\d{4}-\d{2}-\d{2}-v[123]$/.test(item.importPolicy)
  )
    throw new Error('来源事件导入策略无效。');
  if (item.status === 'recorded' && item.eventType === 'conversation_observed') {
    requireSourceFields('sourceEvents', item, [
      'externalJobId',
      'canonicalUrl',
      'opportunityId',
      'company',
      'jobName',
      'nameSource',
    ]);
  } else if (item.status === 'recorded') {
    requireSourceFields('sourceEvents', item, ['externalJobId', 'canonicalUrl', 'opportunityId']);
  }
  if (Boolean(item.canonicalUrl) !== Boolean(item.externalJobId))
    throw new Error('来源事件岗位 ID 与链接不相容。');
  if (item.canonicalUrl && !validBossJobUrl(item.canonicalUrl, item.externalJobId))
    throw new Error('来源事件岗位链接无效。');
  if (!validIso(item.observedAt) || !validIso(item.createdAt))
    throw new Error('来源事件时间无效。');
  if (item.evidenceDate && !validDate(item.evidenceDate)) throw new Error('来源事件证据日期无效。');
  if (!/^[1-9]\d*$/.test(item.sourceSequence) || !Number.isSafeInteger(Number(item.sourceSequence)))
    throw new Error('来源事件顺序无效。');
  if (item.deletedAt && !validIso(item.deletedAt)) throw new Error('sourceEvents.deletedAt 无效。');
}

function validateSourceFact(item) {
  validateBossSourceIdentity(item, 'sourceFacts');
  requireSourceFields('sourceFacts', item, ['conversationKey', 'factType']);
  const legacyFactId = item.legacyEventId
    ? item.legacyEventId.replace(/^boss-event-/, 'boss-fact-')
    : '';
  const semanticFactId = hasBossFactIdentity(item) ? bossFactId(item) : '';
  if (
    !/^boss-fact-[a-f0-9]{64}$/.test(item.id) ||
    !BOSS_CONVERSATION_KEY.test(item.conversationKey) ||
    (item.legacyEventId && !BOSS_EVENT_ID.test(item.legacyEventId)) ||
    (item.id !== semanticFactId && item.id !== legacyFactId) ||
    (item.externalJobId && !BOSS_JOB_ID.test(item.externalJobId)) ||
    (item.observedAt && !validIso(item.observedAt)) ||
    (item.createdAt && !validIso(item.createdAt)) ||
    Boolean(item.evidenceSource) !== Boolean(item.evidenceRef) ||
    (item.deletedAt && !validIso(item.deletedAt))
  )
    throw new Error('来源事实身份或时间无效。');
}

function validateSourceApplication(item) {
  requireSourceFields('sourceApplications', item, [
    'factId',
    'ruleVersion',
    'action',
    'status',
    'reason',
    'updatedAt',
  ]);
  if (
    !/^boss-application-[a-f0-9]{64}$/.test(item.id) ||
    !/^boss-fact-[a-f0-9]{64}$/.test(item.factId) ||
    item.id !== bossApplicationId(item.factId) ||
    !['applied', 'protected', 'waiting', 'review', 'no_effect'].includes(item.status) ||
    !validIso(item.updatedAt) ||
    (item.appliedAt && !validIso(item.appliedAt))
  )
    throw new Error('来源应用记录无效。');
}

export function releaseManualFieldOwnership(before, next) {
  const prior = new Map(before.opportunities.map((row) => [row.id, row]));
  for (const binding of next.sourceBindings) {
    if (binding.kind !== 'opportunity' || binding.deletedAt) continue;
    const old = prior.get(binding.opportunityId),
      current = next.opportunities.find((row) => row.id === binding.opportunityId);
    if (!old || !current) continue;
    const owned = new Set((binding.autoFields || '').split(','));
    for (const field of SOURCE_AUTO_FIELDS)
      if ((old[field] || '') !== (current[field] || '')) owned.delete(field);
    binding.autoFields = SOURCE_AUTO_FIELDS.filter((field) => owned.has(field)).join(',');
  }
  return next;
}

export function markManualFields(data, opportunityId, fields) {
  for (const binding of data.sourceBindings) {
    if (
      binding.kind !== 'opportunity' ||
      binding.opportunityId !== opportunityId ||
      binding.deletedAt
    )
      continue;
    const owned = new Set((binding.autoFields || '').split(','));
    for (const field of fields) owned.delete(field);
    binding.autoFields = SOURCE_AUTO_FIELDS.filter((field) => owned.has(field)).join(',');
  }
  return data;
}

export function validateData(input, { allowOrphans = false } = {}) {
  if (!input || input.schemaVersion !== DATA_VERSION)
    throw new Error('数据格式或版本不支持，已停止导入/同步。');
  if (Object.keys(input).some((k) => !['schemaVersion', ...GROUPS].includes(k)))
    throw new Error('数据包含未知字段，请更新工作台后重试；原数据未改动。');
  const out = emptyData();
  for (const group of GROUPS) {
    if (!Array.isArray(input[group]) || input[group].length > 50000)
      throw new Error(`数据集合 ${group} 无效。`);
    const ids = new Set();
    for (const item of input[group]) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id))
        throw new Error(`${group} 中存在无效或重复 ID。`);
      ids.add(item.id);
      const fields = FIELDS[group];
      if (Object.keys(item).some((k) => !fields.includes(k)))
        throw new Error(`${group} 包含未知字段，已停止写入，请更新工作台。`);
      const clean = {};
      for (const field of fields) {
        if (item[field] !== undefined) {
          if (typeof item[field] !== 'string') throw new Error(`${group}.${field} 应为文本。`);
          if (group.startsWith('source')) validateSourceText(group, field, item[field]);
          clean[field] = item[field];
        }
      }
      if (!clean.deletedAt) {
        const required = REQUIRED[group];
        if (required?.some((f) => !clean[f]?.trim())) throw new Error(`${group} 缺少必要字段。`);
        if (group === 'opportunities' && ![...STAGES, '待联系'].includes(clean.stage))
          throw new Error('存在不支持的招聘阶段。');
        if (group === 'tasks' && !['待办', '完成', '取消'].includes(clean.status))
          throw new Error('存在不支持的任务状态。');
        if (group === 'sourceBindings') validateSourceBinding(clean);
        if (group === 'sourceEvents') validateSourceEvent(clean);
        if (group === 'sourceFacts') validateSourceFact(clean);
        if (group === 'sourceApplications') validateSourceApplication(clean);
      }
      out[group].push(clean);
    }
  }
  const parentIds = new Set(live(out.opportunities).map((o) => o.id));
  for (const group of ['tasks', 'activities']) {
    if (!allowOrphans && live(out[group]).some((x) => !parentIds.has(x.opportunityId)))
      throw new Error('存在没有对应岗位的任务或记录。');
  }
  if (!allowOrphans) {
    const opportunityIds = new Set(out.opportunities.map((row) => row.id));
    const accountKeys = new Set(
      live(out.sourceBindings)
        .filter((row) => row.kind === 'account')
        .map((row) => `${row.platform}\0${row.accountNamespace}`),
    );
    const liveAccounts = new Set();
    const liveJobs = new Set();
    const liveUrls = new Set();
    for (const binding of live(out.sourceBindings)) {
      const accountKey = `${binding.platform}\0${binding.accountNamespace}`;
      if (binding.kind === 'account') {
        if (liveAccounts.has(accountKey)) throw new Error('同一平台账号存在重复来源绑定。');
        liveAccounts.add(accountKey);
        continue;
      }
      if (!accountKeys.has(accountKey)) throw new Error('岗位来源绑定缺少账号绑定。');
      if (!opportunityIds.has(binding.opportunityId)) throw new Error('岗位来源绑定没有对应岗位。');
      const jobKey = `${accountKey}\0${binding.externalJobId}`;
      const urlKey = `${accountKey}\0${binding.canonicalUrl}`;
      if (liveJobs.has(jobKey) || liveUrls.has(urlKey))
        throw new Error('同一来源岗位存在重复绑定。');
      liveJobs.add(jobKey);
      liveUrls.add(urlKey);
    }
    const liveFactIds = new Set(live(out.sourceFacts).map((row) => row.id));
    for (const event of live(out.sourceEvents)) {
      const accountKey = `${event.platform}\0${event.accountNamespace}`;
      if (!accountKeys.has(accountKey)) throw new Error('来源事件缺少账号绑定。');
      if (event.opportunityId && !opportunityIds.has(event.opportunityId))
        throw new Error('来源事件没有对应岗位。');
      if (event.factId && !liveFactIds.has(event.factId)) throw new Error('来源事件缺少有效事实。');
    }
    for (const fact of live(out.sourceFacts)) {
      if (!accountKeys.has(`${fact.platform}\0${fact.accountNamespace}`))
        throw new Error('来源事实缺少账号绑定。');
    }
    for (const application of live(out.sourceApplications)) {
      if (!liveFactIds.has(application.factId)) throw new Error('来源应用记录缺少有效事实。');
      if (application.opportunityId && !opportunityIds.has(application.opportunityId))
        throw new Error('来源应用记录没有对应岗位。');
    }
  }
  return out;
}

const FIELD_MERGE_GROUPS = new Set(['opportunities', 'activities', 'tasks']);
const ATOMIC_FIELD_GROUPS = Object.freeze({
  opportunities: [
    ['stage', 'endReason', 'resumeState', 'readState'],
    ['platform', 'url', 'externalId'],
  ],
  activities: [],
  tasks: [['status', 'completedAt']],
});

function assignField(target, field, value) {
  if (value === undefined) delete target[field];
  else target[field] = clone(value);
}

function mergeUnits(group, keys) {
  const remaining = new Set(keys),
    units = [];
  for (const cluster of ATOMIC_FIELD_GROUPS[group] || []) {
    const fields = cluster.filter((field) => remaining.has(field));
    if (!fields.length) continue;
    units.push(fields);
    for (const field of fields) remaining.delete(field);
  }
  for (const field of remaining) units.push([field]);
  return units;
}

function equalUnit(left, right, fields) {
  return fields.every((field) => equal(left[field], right[field]));
}

function assignUnit(target, source, fields) {
  for (const field of fields) assignField(target, field, source[field]);
}

function mergeRecordFields(group, base, local, remote) {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])];
  const changedOutsideDeletion = (value) =>
    keys.some(
      (field) => !['deletedAt', 'updatedAt'].includes(field) && !equal(value[field], base[field]),
    );
  if (
    (!equal(local.deletedAt, base.deletedAt) && changedOutsideDeletion(remote)) ||
    (!equal(remote.deletedAt, base.deletedAt) && changedOutsideDeletion(local))
  )
    return null;

  const merged = {};
  const divergent = [];
  for (const fields of mergeUnits(group, keys)) {
    if (equalUnit(local, remote, fields)) assignUnit(merged, local, fields);
    else if (equalUnit(local, base, fields)) assignUnit(merged, remote, fields);
    else if (equalUnit(remote, base, fields)) assignUnit(merged, local, fields);
    else if (fields.length === 1 && fields[0] === 'updatedAt')
      assignField(
        merged,
        'updatedAt',
        String(local.updatedAt) > String(remote.updatedAt) ? local.updatedAt : remote.updatedAt,
      );
    else divergent.push(fields);
  }
  if (!divergent.length) return { chosen: merged, conflict: null };
  const left = clone(merged),
    right = clone(merged);
  for (const fields of divergent) {
    assignUnit(left, local, fields);
    assignUnit(right, remote, fields);
  }
  return { chosen: left, conflict: { local: left, remote: right } };
}

// Independent human fields merge automatically. A divergence in the same
// field remains one entity-scoped choice; its two sides already include every
// non-conflicting field so resolving it cannot discard an independent edit.
export function mergeData(base, local, remote, choices = {}) {
  const data = emptyData(),
    conflicts = [];
  for (const group of GROUPS) {
    const maps = [base, local, remote].map((d) => new Map(d[group].map((row) => [row.id, row])));
    const ids = [...new Set(maps.flatMap((m) => [...m.keys()]))].sort();
    for (const id of ids) {
      const [b, l, r] = maps.map((m) => m.get(id));
      let chosen;
      if (equal(l, r)) chosen = l;
      else if (equal(l, b)) chosen = r;
      else if (equal(r, b)) chosen = l;
      else {
        const key = `${group}:${id}`;
        const fields =
          FIELD_MERGE_GROUPS.has(group) && b && l && r ? mergeRecordFields(group, b, l, r) : null;
        const sides = fields?.conflict ?? { local: l, remote: r };
        if (fields && !fields.conflict) chosen = fields.chosen;
        else if (choices[key] === 'remote') chosen = sides.remote;
        else if (choices[key] === 'local') chosen = sides.local;
        else {
          conflicts.push({ key, group, id, base: b, ...sides });
          chosen = sides.local;
        }
      }
      if (chosen !== undefined) data[group].push(clone(chosen));
    }
  }
  // A delete on one device and a new child record on another must never orphan the child.
  for (const group of ['activities', 'tasks']) {
    for (const child of live(data[group])) {
      const parent = data.opportunities.find((o) => o.id === child.opportunityId);
      if (!parent || parent.deletedAt) {
        const key = `opportunities:${child.opportunityId}`;
        if (!conflicts.some((c) => c.key === key))
          conflicts.push({
            key,
            group: 'opportunities',
            id: child.opportunityId,
            base: base.opportunities.find((o) => o.id === child.opportunityId),
            local: local.opportunities.find((o) => o.id === child.opportunityId),
            remote: remote.opportunities.find((o) => o.id === child.opportunityId),
            relational: true,
          });
      }
    }
  }
  return { data, conflicts };
}

export function removeOpportunity(data, id) {
  const stamp = new Date().toISOString();
  for (const group of ['opportunities', 'activities', 'tasks'])
    for (const row of data[group]) {
      if ((group === 'opportunities' ? row.id : row.opportunityId) === id) row.deletedAt = stamp;
    }
}
export function resolveConflicts(candidate, conflicts, choices) {
  const data = clone(candidate);
  for (const conflict of conflicts) {
    if (!['local', 'remote'].includes(choices[conflict.key]))
      throw new Error('请为每项冲突选择要保留的版本。');
    const value = conflict[choices[conflict.key]],
      rows = data[conflict.group];
    const index = rows.findIndex((r) => r.id === conflict.id);
    if (value) {
      if (index >= 0) rows[index] = clone(value);
      else rows.push(clone(value));
    } else if (index >= 0) rows[index].deletedAt = new Date().toISOString();
  }
  for (const o of data.opportunities.filter((o) => o.deletedAt)) removeOpportunity(data, o.id);
  return validateData(data);
}

async function digest(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
function isoDate(raw, year) {
  if (!/^\d{4}$/.test(raw)) return '';
  const value = `${year}-${raw.slice(0, 2)}-${raw.slice(2)}`;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}
export async function parseMarkdown(
  rawText,
  year = String(new Date().getFullYear()),
  filename = '个人记录.md',
) {
  if (!/^\d{4}$/.test(String(year)) || Number(year) < 1900 || Number(year) > 2100)
    throw new Error('请选择有效的年份。');
  const rows = [];
  for (const line of rawText.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((s) => s.replace(/<br\s*\/?>/gi, '').trim());
    if (cells.length !== 6 || !/^\d{4}$/.test(cells[4])) continue;
    const [company, role, link, platform, date, status] = cells;
    if (!company || !role) throw new Error('有源行缺少公司或岗位，导入已停止。');
    const appliedAt = isoDate(date, year);
    if (!appliedAt) throw new Error(`${company} 的日期 ${date} 无效，请核对年份和源文档。`);
    const url = link.match(/\]\((https?:\/\/[^\s]+)\)/)?.[1] || '';
    const externalId = url.match(/\/job_detail\/([^/?]+)\.html/)?.[1] || '';
    const id = externalId
      ? `boss-${externalId}`
      : `job-${(await digest(`${company}|${role}|${platform}`)).slice(0, 24)}`;
    const stage = ['职位关闭', '回复不合适'].includes(status)
      ? '已结束'
      : /^(沟通中|已沟通|要了简历)/.test(status)
        ? '沟通中'
        : '已触达';
    const opportunity = {
      id,
      company,
      role,
      url,
      platform,
      externalId,
      appliedAt,
      stage,
      source: '',
      contact: '',
      readState: status.startsWith('已读') ? '已读' : '未读',
      resumeState: status.includes('接受简历')
        ? '对方已接收'
        : status.includes('要了简历')
          ? '被索要'
          : '未知',
      endReason: status === '职位关闭' ? '职位关闭' : status === '回复不合适' ? '不匹配/拒绝' : '',
      priority: '普通',
      rawStatus: status,
    };
    const events = [{ date: appliedAt, type: '首次联系', text: '首次联系（原表投递日期）' }];
    for (const part of status.split(/[,，]/)) {
      const match = part.match(/^(\d{4})(.*)$/);
      if (match) {
        const eventDate = isoDate(match[1], year);
        if (!eventDate) throw new Error(`${company} 的事件日期 ${match[1]} 无效。`);
        events.push({ date: eventDate, type: '导入记录', text: match[2] });
      } else if (part !== '沟通中') events.push({ date: '', type: '导入记录', text: part });
    }
    const activities = [];
    for (const e of events)
      activities.push({
        ...e,
        id: `event-${(await digest(`${id}|${e.date}|${e.text}`)).slice(0, 24)}`,
        opportunityId: id,
      });
    rows.push({
      opportunity,
      activities,
      raw: line,
      issue: company.includes('工程师') && !role.includes('工程师') ? '公司和岗位可能填反' : '',
    });
  }
  if (!rows.length) throw new Error('没有找到包含公司、岗位、链接、渠道、日期、状态六列的记录。');
  return {
    rows,
    batch: {
      id: `import-${await digest(`${year}\n${rawText}`)}`,
      filename,
      year: String(year),
      rawText,
      importedAt: new Date().toISOString(),
    },
  };
}
export function applyImport(data, parsed, selected, swaps = []) {
  const result = clone(data);
  let added = 0,
    skipped = 0;
  for (const row of parsed.rows) {
    if (!selected.includes(row.opportunity.id)) continue;
    if (result.opportunities.some((o) => o.id === row.opportunity.id)) {
      skipped++;
      continue;
    }
    const o = clone(row.opportunity);
    if (swaps.includes(o.id)) [o.company, o.role] = [o.role, o.company];
    result.opportunities.push(o);
    result.activities.push(...clone(row.activities));
    added++;
  }
  if (added && !result.imports.some((i) => i.id === parsed.batch.id))
    result.imports.push(clone(parsed.batch));
  return { data: validateData(result), added, skipped };
}
export function markdownExport(data) {
  const escape = (s) =>
    String(s || '')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '<br>');
  let out =
    '# 求职记录\n\n| 公司 | 岗位 | 阶段 | 消息 | 简历 | 首次联系 | 下一步 |\n| --- | --- | --- | --- | --- | --- | --- |\n';
  for (const o of live(data.opportunities)) {
    const status = getOpportunityStatus(o);
    const tasks = live(data.tasks).filter((t) => t.opportunityId === o.id && t.status === '待办');
    out +=
      '| ' +
      [
        o.company,
        o.role,
        status.stage,
        status.readState,
        o.resumeState,
        o.appliedAt,
        tasks.map((t) => `${t.dueAt || '未定日期'} ${t.text}`).join('；'),
      ]
        .map(escape)
        .join(' | ') +
      ' |\n';
  }
  for (const o of live(data.opportunities)) {
    out += `\n## ${escape(o.company)} · ${escape(o.role)}\n\n`;
    if (o.url) out += `岗位链接：${o.url}\n\n`;
    for (const a of live(data.activities)
      .filter((a) => a.opportunityId === o.id)
      .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')))
      out += `- ${a.date || '日期未记录'}：${escape(a.text)}\n`;
  }
  return out;
}
