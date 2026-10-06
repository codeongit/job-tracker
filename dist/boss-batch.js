import { BOSS_JOB_ID, isCanonicalBossJobUrl } from './boss-job-url.js';
import { RESUME_SUMMARIES } from './resume-rules.js';
import { validateAttributionEvidence } from './boss-attribution.js';
const clone = structuredClone;
const BATCH_ID = /^boss-batch-[a-f0-9]{64}$/;
const EVENT_ID = /^boss-event-[a-f0-9]{64}$/;
const ACCOUNT_NAMESPACE = /^boss-geek:[a-f0-9]{64}$/;
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.json$/;
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function integrationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasOnly(value, fields) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((field) => fields.includes(field))
  );
}

function text(value, field, max = 10000, { required = false } = {}) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    value.includes('\0') ||
    (required && !value.trim())
  )
    throw integrationError(`BOSS 批次字段 ${field} 无效。`, 'BATCH_INVALID');
  return value;
}

function exactDate(value, field, { empty = true } = {}) {
  text(value, field, 10);
  if (!empty || value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw integrationError(`BOSS 批次日期 ${field} 无效。`, 'BATCH_INVALID');
    const parsed = new Date(`${value}T12:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
      throw integrationError(`BOSS 批次日期 ${field} 无效。`, 'BATCH_INVALID');
  }
  return value;
}

function canonicalIso(value, field) {
  text(value, field, 24, { required: true });
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw integrationError(`BOSS 批次时间 ${field} 无效。`, 'BATCH_INVALID');
  return value;
}

function shanghaiDay(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function validateEvent(event, batch) {
  const baseFields = [
    'eventId',
    'conversationKey',
    'friendId',
    'friendSource',
    'uniqueId',
    'externalJobId',
    'canonicalUrl',
    'jobName',
    'company',
    'contact',
    'summary',
    'timeLabel',
    'messageId',
    'messageDirection',
    'receiptStatus',
    'receiptSource',
    'observedAt',
    'evidenceDate',
    'nameSource',
    'linkConfirmation',
    'intent',
    'appliedAtForNew',
    'sourceSequence',
  ];
  const eventType = event.eventType || 'conversation_observed';
  const fields =
    eventType === 'resume_observed'
      ? [...baseFields, 'eventType', ...(batch.version >= 3 ? ['attribution'] : [])]
      : baseFields;
  if (batch.version >= 4) fields.push('jobDetails');
  if (batch.version >= 3 && eventType === 'resume_observed')
    validateAttributionEvidence(event.attribution);
  if (batch.version >= 4) validateJobDetails(event.jobDetails, event);
  if (!hasOnly(event, fields) || fields.some((field) => !(field in event)))
    throw integrationError('BOSS 批次事件结构无效。', 'BATCH_INVALID');
  if (!EVENT_ID.test(event.eventId))
    throw integrationError('BOSS 批次事件 ID 无效。', 'BATCH_INVALID');
  const limits = {
    eventId: 75,
    conversationKey: 128,
    friendId: 128,
    friendSource: 128,
    uniqueId: 256,
    externalJobId: 300,
    canonicalUrl: 600,
    jobName: 300,
    company: 300,
    contact: 300,
    summary: 2000,
    timeLabel: 100,
    messageId: 128,
    receiptSource: 100,
    nameSource: 100,
  };
  for (const field of fields.filter(
    (field) => !['sourceSequence', 'eventType', 'attribution', 'jobDetails'].includes(field),
  ))
    text(event[field], `events.${field}`, limits[field] || 1000);
  if (!['conversation_observed', 'resume_observed'].includes(eventType))
    throw integrationError('BOSS 批次事件类型无效。', 'BATCH_INVALID');
  if (
    !/^[a-f0-9]{64}$/.test(event.conversationKey) ||
    !event.friendId ||
    !event.friendSource ||
    !Number.isSafeInteger(event.sourceSequence) ||
    event.sourceSequence !== batch.sourceSequence
  )
    throw integrationError('BOSS 批次事件序号无效。', 'BATCH_INVALID');
  if (!['create_or_link', 'review', 'observe_only'].includes(event.intent))
    throw integrationError('BOSS 批次事件意图无效。', 'BATCH_INVALID');
  if (!['inbound', 'outbound', 'unknown'].includes(event.messageDirection))
    throw integrationError('BOSS 批次消息方向无效。', 'BATCH_INVALID');
  if (!['read', 'delivered', 'unknown', 'not_applicable'].includes(event.receiptStatus))
    throw integrationError('BOSS 批次回执无效。', 'BATCH_INVALID');
  if (
    eventType === 'conversation_observed' &&
    ((event.messageDirection === 'inbound' && event.receiptStatus !== 'not_applicable') ||
      (event.messageDirection === 'unknown' && event.receiptStatus !== 'unknown') ||
      (['read', 'delivered'].includes(event.receiptStatus) &&
        event.messageDirection !== 'outbound') ||
      (event.receiptStatus === 'unknown' && event.messageDirection !== 'unknown'))
  )
    throw integrationError('BOSS 消息方向与回执不相容。', 'BATCH_INVALID');
  if (
    eventType === 'resume_observed' &&
    (!['inbound', 'outbound'].includes(event.messageDirection) ||
      event.receiptStatus !== 'not_applicable' ||
      event.receiptSource !== '' ||
      !RESUME_SUMMARIES.includes(event.summary) ||
      event.intent !== 'observe_only')
  )
    throw integrationError('BOSS 简历观察结构无效。', 'BATCH_INVALID');
  if (
    (['read', 'delivered'].includes(event.receiptStatus) &&
      event.receiptSource !== 'list_receipt_label') ||
    (['unknown', 'not_applicable'].includes(event.receiptStatus) && event.receiptSource)
  )
    throw integrationError('BOSS 回执证据来源无效。', 'BATCH_INVALID');
  if (!['confirmed_user', 'unverified'].includes(event.linkConfirmation))
    throw integrationError('BOSS 岗位链接确认状态无效。', 'BATCH_INVALID');
  if (Boolean(event.externalJobId) !== Boolean(event.canonicalUrl))
    throw integrationError('BOSS 岗位 ID 与链接必须同时存在。', 'BATCH_INVALID');
  if (event.externalJobId) {
    if (!BOSS_JOB_ID.test(event.externalJobId))
      throw integrationError('BOSS 岗位 ID 无效。', 'BATCH_INVALID');
    const expectedUrl = new URL(`/job_detail/${event.externalJobId}.html`, 'https://www.zhipin.com')
      .href;
    if (event.canonicalUrl !== expectedUrl)
      throw integrationError('BOSS 岗位链接与岗位 ID 不一致。', 'BATCH_INVALID');
  }
  if (
    event.intent === 'create_or_link' &&
    (!event.externalJobId || !event.canonicalUrl || !event.jobName.trim() || !event.company.trim())
  )
    throw integrationError('BOSS 自动建档事件缺少必要字段。', 'BATCH_INVALID');
  exactDate(event.evidenceDate, 'events.evidenceDate');
  exactDate(event.appliedAtForNew, 'events.appliedAtForNew');
  const incrementalSameDay =
    batch.version >= 2 && batch.policy.mode === 'incremental' && HH_MM.test(event.timeLabel);
  const legacyIncremental = batch.version === 1 && batch.policy.mode === 'incremental';
  if (
    (['initial', 'dated'].includes(batch.policy.mode) &&
      event.appliedAtForNew !== batch.policy.appliedAtForNew) ||
    (batch.policy.mode === 'resume' && event.appliedAtForNew !== '') ||
    (incrementalSameDay &&
      (event.evidenceDate !== shanghaiDay(batch.source.capturedAt) ||
        event.appliedAtForNew !== event.evidenceDate)) ||
    (batch.version >= 2 &&
      batch.policy.mode === 'incremental' &&
      !incrementalSameDay &&
      (event.evidenceDate !== '' || event.appliedAtForNew !== '')) ||
    (legacyIncremental && (event.evidenceDate !== '' || event.appliedAtForNew !== ''))
  )
    throw integrationError('BOSS 事件首次联系日期与批次策略不一致。', 'BATCH_INVALID');
  canonicalIso(event.observedAt, 'events.observedAt');
  return event;
}

export function validateBossBatch(input) {
  const fields = [
    'format',
    'version',
    'batchId',
    'platform',
    'accountNamespace',
    'sourceSequence',
    'policy',
    'source',
    'coverage',
    'events',
  ];
  if (!hasOnly(input, fields) || fields.some((field) => !(field in input)))
    throw integrationError('BOSS 队列批次结构无效。', 'BATCH_INVALID');
  if (
    input.format !== 'job-tracker-boss-batch' ||
    ![1, 2, 3, 4].includes(input.version) ||
    !BATCH_ID.test(input.batchId) ||
    input.platform !== 'boss' ||
    !ACCOUNT_NAMESPACE.test(input.accountNamespace) ||
    !Number.isSafeInteger(input.sourceSequence) ||
    input.sourceSequence < 1
  )
    throw integrationError('BOSS 队列批次身份无效。', 'BATCH_INVALID');
  const policyFields = ['id', 'mode', 'timezone', 'appliedAtForNew', 'autoCreateComplete'];
  if (
    !hasOnly(input.policy, policyFields) ||
    policyFields.some((field) => !(field in input.policy))
  )
    throw integrationError('BOSS 批次策略无效。', 'BATCH_INVALID');
  text(input.policy.id, 'policy.id', 100, { required: true });
  if (!/^[a-z0-9][a-z0-9_.-]+$/.test(input.policy.id))
    throw integrationError('BOSS 批次策略 ID 无效。', 'BATCH_INVALID');
  if (!['initial', 'incremental', 'dated', 'resume'].includes(input.policy.mode))
    throw integrationError('BOSS 批次模式无效。', 'BATCH_INVALID');
  if (
    input.policy.timezone !== 'Asia/Shanghai' ||
    input.policy.autoCreateComplete !== (input.policy.mode !== 'resume')
  )
    throw integrationError('BOSS 批次策略超出工作台允许范围。', 'BATCH_INVALID');
  exactDate(input.policy.appliedAtForNew, 'policy.appliedAtForNew');
  if (['initial', 'dated'].includes(input.policy.mode) && !input.policy.appliedAtForNew)
    throw integrationError('日期批次必须包含用户确认的首次联系日期。', 'BATCH_INVALID');
  if (['incremental', 'resume'].includes(input.policy.mode) && input.policy.appliedAtForNew)
    throw integrationError('后续检查不能推断首次联系日期。', 'BATCH_INVALID');
  const sourceFields = ['snapshotName', 'snapshotSha256', 'capturedAt'];
  if (
    !hasOnly(input.source, sourceFields) ||
    sourceFields.some((field) => !(field in input.source))
  )
    throw integrationError('BOSS 批次来源无效。', 'BATCH_INVALID');
  text(input.source.snapshotName, 'source.snapshotName', 205, { required: true });
  if (!SNAPSHOT_NAME.test(input.source.snapshotName))
    throw integrationError('BOSS 快照名称无效。', 'BATCH_INVALID');
  if (!/^[a-f0-9]{64}$/.test(input.source.snapshotSha256))
    throw integrationError('BOSS 快照摘要无效。', 'BATCH_INVALID');
  canonicalIso(input.source.capturedAt, 'source.capturedAt');
  const coverageFields = [
    'loadedRows',
    'loadedDataRows',
    'renderedRows',
    'offscreenRows',
    'unresolvedRows',
    'truncated',
  ];
  if (
    !hasOnly(input.coverage, coverageFields) ||
    coverageFields.some((field) => !(field in input.coverage))
  )
    throw integrationError('BOSS 批次覆盖统计无效。', 'BATCH_INVALID');
  for (const field of coverageFields.filter((field) => field !== 'truncated'))
    if (
      !Number.isSafeInteger(input.coverage[field]) ||
      input.coverage[field] < 0 ||
      input.coverage[field] > 100000
    )
      throw integrationError('BOSS 批次覆盖统计无效。', 'BATCH_INVALID');
  if (typeof input.coverage.truncated !== 'boolean')
    throw integrationError('BOSS 批次覆盖标记无效。', 'BATCH_INVALID');
  if (!Array.isArray(input.events) || input.events.length > 1000)
    throw integrationError('BOSS 批次事件数量无效。', 'BATCH_INVALID');
  const ids = new Set();
  for (const event of input.events) {
    validateEvent(event, input);
    if (ids.has(event.eventId)) throw integrationError('BOSS 批次包含重复事件。', 'BATCH_INVALID');
    ids.add(event.eventId);
  }
  return clone(input);
}

function resumeStatusWorkflow(batch, event) {
  if (
    event.eventType !== 'resume_observed' ||
    ['resume_sent_candidate', 'resume_card_other'].includes(event.summary)
  )
    return '';
  // Queue v2 uses the current semantic identity in every batch mode. Queue
  // v1 remains readable with the policy-specific identities it wrote before.
  if (batch.version >= 2) return 'resume-status-linked-v2';
  if (!batch.policy.id.startsWith('boss-resume-observation')) return '';
  if (batch.policy.id.endsWith('-v3')) return 'resume-status-linked-v2';
  if (batch.policy.id.endsWith('-v2')) return 'resume-status-linked-v1';
  return '';
}

export function bossEventDigestInput(batch, event) {
  const facts = {
    platform: 'boss',
    ...(event.eventType === 'resume_observed' ? { eventType: event.eventType } : {}),
    accountNamespace: batch.accountNamespace,
    conversationKey: event.conversationKey,
    friendId: event.friendId,
    friendSource: event.friendSource,
    uniqueId: event.uniqueId,
    externalJobId: event.externalJobId,
    canonicalUrl: event.canonicalUrl,
    jobName: event.jobName,
    company: event.company,
    contact: event.contact,
    summary: event.summary,
    messageId: event.messageId,
    messageDirection: event.messageDirection,
    receiptStatus: event.receiptStatus,
    receiptSource: event.receiptSource,
    nameSource: event.nameSource,
    linkConfirmation: event.linkConfirmation,
    intent: event.intent,
  };
  const workflow = resumeStatusWorkflow(batch, event);
  return workflow ? { ...facts, workflow } : facts;
}
export function bossBatchDigestInput(batch) {
  return {
    ...(batch.version >= 4
      ? {
          jobDetails: batch.events
            .map((event) => ({ eventId: event.eventId, details: event.jobDetails }))
            .sort((a, b) => a.eventId.localeCompare(b.eventId)),
        }
      : {}),
    policy: batch.policy.id,
    snapshotSha256: batch.source.snapshotSha256,
    accountNamespace: batch.accountNamespace,
    eventIds: batch.events.map((event) => event.eventId).sort(),
    ...(batch.version >= 3
      ? {
          attribution: batch.events
            .filter((event) => event.eventType === 'resume_observed')
            .map((event) => ({ eventId: event.eventId, evidence: event.attribution }))
            .sort((a, b) => a.eventId.localeCompare(b.eventId)),
          version: batch.version,
        }
      : {}),
  };
}

function validateJobDetails(details, event) {
  if (details === null) return;
  const fields = ['jobId', 'canonicalUrl', 'company', 'jobName', 'source'];
  if (!hasOnly(details, fields) || fields.some((field) => !(field in details)))
    throw integrationError('岗位详情结构无效。', 'BATCH_INVALID');
  for (const field of fields)
    text(details[field], field, field === 'canonicalUrl' ? 600 : 300, {
      required: !(
        ['jobName', 'company'].includes(field) && details.source === 'detail_page_conflict'
      ),
    });
  if (
    !['detail_page_title', 'detail_page_conflict'].includes(details.source) ||
    !BOSS_JOB_ID.test(details.jobId) ||
    !isCanonicalBossJobUrl(details.canonicalUrl, details.jobId) ||
    details.jobId !== event.externalJobId ||
    details.canonicalUrl !== event.canonicalUrl
  )
    throw integrationError('岗位详情身份不一致。', 'BATCH_INVALID');
}
