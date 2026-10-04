import { validateBossBatch, bossEventDigestInput, bossBatchDigestInput } from './boss-batch.js';
export { validateBossBatch } from './boss-batch.js';
import {
  assessBossAttribution,
  bossAttributionSummary,
  buildBossAttributionContext,
} from './boss-attribution.js';
import { resumeRule, resumeTransition } from './resume-rules.js';
import {
  clone,
  equal,
  getResumeLinkedStatus,
  live,
  validateData,
  SOURCE_AUTO_FIELDS,
} from './model.js';
import {
  recordSourceApplication,
  sourceApplicationForEvent,
  sourceReviewCounts,
  effectiveSourceFacts,
} from './source-ledger.js';
import { bossApplicationId, bossFactId, hasBossFactIdentity } from './source-identity.js';

const BATCH_ID = /^boss-batch-[a-f0-9]{64}$/;
const ACCOUNT_NAMESPACE = /^boss-geek:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SOURCE_ID_KEY = 'job-tracker-boss-source-v1';
const AUTO_FIELDS = SOURCE_AUTO_FIELDS;

function integrationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
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

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('zh-CN');
}

function bossJobIdFromUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.zhipin.com') return '';
    return decodeURIComponent(url.pathname.match(/^\/job_detail\/([^/]+)\.html$/)?.[1] || '');
  } catch {
    return '';
  }
}

function isBossPlatform(value) {
  return !value || /^boss(?:直聘)?$/i.test(value.replace(/\s/g, ''));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

async function stableDigest(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The local service verifies these hashes on disk. Verify them again before an IndexedDB write,
// since a stale page or malformed response must not bypass the producer's immutable identity.
export async function verifyBossBatch(input) {
  const batch = validateBossBatch(input);
  for (const event of batch.events) {
    const statusWorkflow = bossEventDigestInput(batch, event);
    if (event.eventId !== `boss-event-${await stableDigest(statusWorkflow)}`)
      throw integrationError('BOSS 批次事件身份校验失败。', 'BATCH_INVALID');
  }
  const expected = await stableDigest(bossBatchDigestInput(batch));
  if (batch.batchId !== `boss-batch-${expected}`)
    throw integrationError('BOSS 批次内容摘要校验失败。', 'BATCH_INVALID');
  return batch;
}

function accountBindingId(accountNamespace) {
  return `boss-account-${accountNamespace.slice('boss-geek:'.length)}`;
}

function opportunityBindingId(accountNamespace, externalJobId) {
  return `boss-job-${accountNamespace.slice('boss-geek:'.length)}-${encodeURIComponent(externalJobId)}`;
}

function opportunityId(accountNamespace, externalJobId) {
  return `boss-auto-${accountNamespace.slice('boss-geek:'.length)}-${encodeURIComponent(externalJobId)}`;
}

export function bindBossAccount(
  data,
  accountNamespace,
  workspaceSourceId,
  stamp,
  { allowRestore = false, allowRebind = false } = {},
) {
  if (!ACCOUNT_NAMESPACE.test(accountNamespace) || !UUID.test(workspaceSourceId))
    throw integrationError('BOSS 来源身份无效。', 'SOURCE_INVALID');
  canonicalIso(stamp, 'boundAt');
  const next = clone(data),
    tombstone = next.sourceBindings.find(
      (binding) =>
        binding.id === accountBindingId(accountNamespace) &&
        binding.kind === 'account' &&
        binding.platform === 'boss' &&
        binding.accountNamespace === accountNamespace &&
        binding.deletedAt,
    ),
    bindings = live(next.sourceBindings).filter(
      (binding) =>
        binding.kind === 'account' &&
        binding.platform === 'boss' &&
        binding.accountNamespace === accountNamespace,
    );
  if (bindings.some((binding) => binding.workspaceSourceId !== workspaceSourceId)) {
    if (!allowRestore || !allowRebind || bindings.length !== 1)
      throw integrationError('这个采集账号已经绑定到另一个工作区。', 'SOURCE_ALREADY_BOUND');
    bindings[0].workspaceSourceId = workspaceSourceId;
    bindings[0].updatedAt = stamp;
  }
  if (!bindings.length && tombstone) {
    if (!allowRestore || (tombstone.workspaceSourceId !== workspaceSourceId && !allowRebind))
      throw integrationError(
        '检测到已删除的来源绑定，请在当前工作区明确核对后恢复。',
        'RESTORE_REVIEW_REQUIRED',
      );
    delete tombstone.deletedAt;
    tombstone.workspaceSourceId = workspaceSourceId;
    tombstone.updatedAt = stamp;
  } else if (!bindings.length)
    next.sourceBindings.push({
      id: accountBindingId(accountNamespace),
      kind: 'account',
      platform: 'boss',
      accountNamespace,
      workspaceSourceId,
      createdAt: stamp,
      updatedAt: stamp,
    });
  return validateData(next);
}

function splitAutoFields(binding) {
  return new Set(
    (binding.autoFields || '')
      .split(',')
      .map((field) => field.trim())
      .filter((field) => AUTO_FIELDS.includes(field)),
  );
}

function autoValue(event, field) {
  return {
    company: event.company,
    role: event.jobName,
    platform: 'BOSS',
    contact: event.contact,
    url: event.canonicalUrl,
    externalId: event.externalJobId,
  }[field];
}

function lastAutoField(field) {
  return `lastAuto${field[0].toUpperCase()}${field.slice(1)}`;
}

function refreshAutoOwnedFields(opportunity, binding, event, stamp, allowUpdates) {
  const owned = splitAutoFields(binding);
  let changed = false;
  for (const field of AUTO_FIELDS) {
    if (!owned.has(field)) continue;
    const lastField = lastAutoField(field),
      last = binding[lastField] || '',
      current = opportunity[field] || '',
      incoming = autoValue(event, field) || '';
    if (current !== last) {
      owned.delete(field);
      changed = true;
      continue;
    }
    if (allowUpdates && incoming && current !== incoming) {
      opportunity[field] = incoming;
      binding[lastField] = incoming;
      opportunity.updatedAt = stamp;
      changed = true;
    }
  }
  const value = AUTO_FIELDS.filter((field) => owned.has(field)).join(',');
  if (binding.autoFields !== value) {
    binding.autoFields = value;
    changed = true;
  }
  if (changed) binding.updatedAt = stamp;
}

function isCompatible(opportunity, event, binding = null) {
  const roleMatches = !opportunity.role || normalize(opportunity.role) === normalize(event.jobName),
    urlJobId = bossJobIdFromUrl(opportunity.url),
    roleIsAutoOwned =
      binding &&
      splitAutoFields(binding).has('role') &&
      (opportunity.role || '') === (binding.lastAutoRole || '');
  return (
    isBossPlatform(opportunity.platform) &&
    (!opportunity.company || normalize(opportunity.company) === normalize(event.company)) &&
    (roleMatches || roleIsAutoOwned) &&
    (!opportunity.externalId || opportunity.externalId === event.externalJobId) &&
    (!urlJobId || urlJobId === event.externalJobId)
  );
}

function createBinding(batch, event, targetId, stamp, isAutomatic) {
  return {
    id: opportunityBindingId(batch.accountNamespace, event.externalJobId),
    kind: 'opportunity',
    platform: 'boss',
    accountNamespace: batch.accountNamespace,
    externalJobId: event.externalJobId,
    canonicalUrl: event.canonicalUrl,
    opportunityId: targetId,
    autoFields: isAutomatic ? AUTO_FIELDS.join(',') : '',
    lastAutoCompany: isAutomatic ? event.company : '',
    lastAutoRole: isAutomatic ? event.jobName : '',
    lastAutoUrl: isAutomatic ? event.canonicalUrl : '',
    lastAutoContact: isAutomatic ? event.contact : '',
    lastAutoPlatform: isAutomatic ? 'BOSS' : '',
    lastAutoExternalId: isAutomatic ? event.externalJobId : '',
    lastAutoResumeState: isAutomatic ? '未知' : '',
    lastAutoReadState: '',
    lastAutoStage: isAutomatic ? '已触达' : '',
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function createOpportunity(batch, event, stamp) {
  return {
    id: opportunityId(batch.accountNamespace, event.externalJobId),
    company: event.company.trim(),
    role: event.jobName.trim(),
    platform: 'BOSS',
    source: '',
    contact: event.contact.trim(),
    url: event.canonicalUrl,
    externalId: event.externalJobId,
    appliedAt: event.appliedAtForNew || batch.policy.appliedAtForNew || '',
    stage: '已触达',
    resumeState: '未知',
    endReason: '',
    priority: '普通',
    location: '',
    salary: '',
    description: '',
    notes: '',
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function sourceEvent(batch, event, targetId, status, stamp) {
  const output = {
    id: event.eventId,
    batchId: batch.batchId,
    platform: 'boss',
    accountNamespace: batch.accountNamespace,
    conversationKey: event.conversationKey,
    friendId: event.friendId,
    friendSource: event.friendSource,
    uniqueId: event.uniqueId,
    externalJobId: event.externalJobId,
    opportunityId: targetId || '',
    eventType: event.eventType || 'conversation_observed',
    messageId: event.messageId,
    messageDirection: event.messageDirection,
    receiptStatus: event.receiptStatus,
    receiptSource: event.receiptSource,
    summary: event.summary,
    timeLabel: event.timeLabel,
    contact: event.contact,
    company: event.company,
    jobName: event.jobName,
    nameSource: event.nameSource,
    canonicalUrl: event.canonicalUrl,
    linkConfirmation: event.linkConfirmation,
    observedAt: event.observedAt,
    evidenceDate: event.evidenceDate,
    sourceSnapshot: `${batch.source.snapshotName}#sha256:${batch.source.snapshotSha256}`,
    sourceSequence: String(event.sourceSequence),
    status,
    importPolicy: batch.policy.id,
    appliedAtSource: event.appliedAtForNew
      ? batch.policy.mode === 'incremental'
        ? 'platform_same_day_time_label'
        : 'user_confirmed_initial_contact_date'
      : '',
    createdAt: stamp,
  };
  output.factId = hasBossFactIdentity(output) ? bossFactId(output) : '';
  return output;
}

function eventIdentityMatches(stored, batch, event) {
  return (
    stored.eventType === (event.eventType || 'conversation_observed') &&
    stored.accountNamespace === batch.accountNamespace &&
    stored.conversationKey === event.conversationKey &&
    stored.friendId === event.friendId &&
    stored.friendSource === event.friendSource &&
    stored.uniqueId === event.uniqueId &&
    stored.externalJobId === event.externalJobId &&
    stored.messageId === event.messageId &&
    stored.messageDirection === event.messageDirection &&
    stored.receiptStatus === event.receiptStatus &&
    stored.receiptSource === event.receiptSource &&
    stored.summary === event.summary &&
    stored.jobName === event.jobName &&
    stored.company === event.company &&
    stored.contact === event.contact &&
    stored.canonicalUrl === event.canonicalUrl &&
    stored.nameSource === event.nameSource &&
    stored.linkConfirmation === event.linkConfirmation
  );
}

export function bossReceiptGap(data, batch) {
  return batch.events.filter((event) => {
    const stored = data.sourceEvents.find((row) => row.id === event.eventId && !row.deletedAt);
    const identity = { ...event, platform: 'boss', accountNamespace: batch.accountNamespace };
    if (!stored || !eventIdentityMatches(stored, batch, event)) return true;
    if (!hasBossFactIdentity(identity)) return stored.factId !== '';
    const factId = bossFactId(identity);
    return (
      !data.sourceFacts.some((row) => row.id === factId && !row.deletedAt) ||
      !data.sourceApplications.some((row) => row.id === bossApplicationId(factId) && !row.deletedAt)
    );
  }).length;
}

function resolveResumeEvent(data, batch, event, context) {
  const attribution = assessBossAttribution(batch.accountNamespace, event, context);
  if (attribution.status !== 'verified')
    return {
      status: 'review',
      targetId: '',
      applicationStatus: attribution.status === 'conflict' ? 'review' : 'waiting',
      reason: attribution.reason,
    };
  if (!event.externalJobId || !event.canonicalUrl)
    return {
      status: 'review',
      targetId: '',
      applicationStatus: 'waiting',
      reason: 'missing_job_identity',
    };
  const bindings = live(data.sourceBindings).filter(
    (binding) =>
      binding.kind === 'opportunity' &&
      binding.platform === 'boss' &&
      binding.accountNamespace === batch.accountNamespace &&
      binding.externalJobId === event.externalJobId,
  );
  if (bindings.length !== 1)
    return {
      status: 'review',
      targetId: '',
      applicationStatus: bindings.length ? 'review' : 'waiting',
      reason: bindings.length ? 'ambiguous_job_identity' : 'job_not_linked',
    };
  const binding = bindings[0];
  const opportunity = data.opportunities.find((row) => row.id === binding.opportunityId);
  if (
    !opportunity ||
    opportunity.deletedAt ||
    binding.canonicalUrl !== event.canonicalUrl ||
    opportunity.url !== event.canonicalUrl
  )
    return {
      status: 'review',
      targetId: opportunity?.id || '',
      applicationStatus: opportunity?.deletedAt ? 'protected' : 'review',
      reason: opportunity?.deletedAt ? 'opportunity_deleted' : 'job_identity_conflict',
    };
  return { status: 'recorded', targetId: opportunity.id, attributionReason: attribution.reason };
}

function applyResumeStatus(data, result, event, stamp) {
  if (result.status !== 'recorded' || !result.targetId) return;
  const opportunity = data.opportunities.find((row) => row.id === result.targetId);
  if (!opportunity || opportunity.deletedAt) return;
  const { target } = resumeRule(event.summary);
  if (!target) {
    result.applicationStatus = 'no_effect';
    result.reason = 'observation_only';
    return;
  }
  const binding = live(data.sourceBindings).find(
    (row) =>
      row.kind === 'opportunity' &&
      row.opportunityId === opportunity.id &&
      row.externalJobId === event.externalJobId,
  );
  if (!binding) return;
  const owned = splitAutoFields(binding);
  for (const field of ['resumeState', 'readState', 'stage']) {
    if ((opportunity[field] || '') !== (binding[lastAutoField(field)] || '')) owned.delete(field);
  }
  binding.autoFields = AUTO_FIELDS.filter((field) => owned.has(field)).join(',');
  if (!owned.has('resumeState')) {
    result.applicationStatus = 'protected';
    result.reason = 'manual_resume_state';
    return;
  }
  const transition = resumeTransition(opportunity.resumeState, event.summary);
  const allowed = transition.outcome === 'advance';
  if (transition.outcome === 'protected') {
    result.applicationStatus = 'protected';
    result.reason = 'resume_state_no_regression';
    return;
  }
  if (allowed) opportunity.resumeState = target;
  const linked = getResumeLinkedStatus(opportunity);
  let changed = allowed;
  for (const field of ['readState', 'stage']) {
    if (owned.has(field) && linked[field] !== undefined && opportunity[field] !== linked[field]) {
      opportunity[field] = linked[field];
      changed = true;
    }
  }
  for (const field of ['resumeState', 'readState', 'stage']) {
    if (owned.has(field)) binding[lastAutoField(field)] = opportunity[field] || '';
  }
  if (changed) {
    opportunity.updatedAt = stamp;
    binding.updatedAt = stamp;
  }
  result.applicationStatus = changed ? 'applied' : 'no_effect';
  result.reason = changed ? 'resume_status_advanced' : 'state_already_supported';
}

// A user-confirmed wrong-conversation observation remains in the immutable
// evidence ledger, but no longer contributes to product views or auto fields.
export function rejectMisattributedResumeObservation(data, { opportunityId, eventId, stamp }) {
  const next = clone(data);
  const opportunity = live(next.opportunities).find((row) => row.id === opportunityId);
  const bindings = live(next.sourceBindings).filter(
    (row) => row.kind === 'opportunity' && row.opportunityId === opportunityId,
  );
  const evidence = live(next.sourceEvents).filter(
    (row) => row.opportunityId === opportunityId && row.eventType === 'resume_observed',
  );
  const request = evidence.find((row) => row.id === eventId);
  const binding = bindings.length === 1 ? bindings[0] : null;
  const owned = binding ? splitAutoFields(binding) : new Set();
  const application = request ? sourceApplicationForEvent(next, request) : null;
  if (
    !opportunity ||
    !binding ||
    !request ||
    evidence.length !== 1 ||
    request.status !== 'recorded' ||
    request.summary !== 'resume_request_sent' ||
    request.accountNamespace !== binding.accountNamespace ||
    request.externalJobId !== binding.externalJobId ||
    !application ||
    application.status !== 'applied' ||
    application.opportunityId !== opportunityId ||
    !owned.has('resumeState') ||
    !['已发送', '被索要'].includes(opportunity.resumeState) ||
    binding.lastAutoResumeState !== opportunity.resumeState
  )
    throw integrationError(
      '简历观察否决条件不满足，未改动正式记录。',
      'BOSS_RESUME_REJECTION_UNSAFE',
    );

  opportunity.resumeState = '未知';
  binding.lastAutoResumeState = '未知';
  if (
    owned.has('readState') &&
    opportunity.readState === '已读' &&
    binding.lastAutoReadState === '已读'
  ) {
    delete opportunity.readState;
    binding.lastAutoReadState = '';
  }
  if (owned.has('stage') && opportunity.stage === '沟通中' && binding.lastAutoStage === '沟通中') {
    opportunity.stage = '已触达';
    binding.lastAutoStage = '已触达';
  }
  application.status = 'protected';
  application.reason = 'user_rejected_wrong_conversation';
  application.appliedAt = '';
  application.updatedAt = stamp;
  opportunity.updatedAt = stamp;
  binding.updatedAt = stamp;
  return validateData(next);
}

function resolveEvent(data, batch, event, stamp) {
  const jobBindings = live(data.sourceBindings).filter(
    (binding) =>
      binding.kind === 'opportunity' &&
      binding.platform === 'boss' &&
      binding.accountNamespace === batch.accountNamespace &&
      binding.externalJobId === event.externalJobId,
  );
  if (jobBindings.length > 1) return { status: 'review', targetId: '' };
  if (jobBindings.length === 1) {
    const binding = jobBindings[0],
      opportunity = data.opportunities.find((row) => row.id === binding.opportunityId);
    if (opportunity && !opportunity.deletedAt)
      refreshAutoOwnedFields(opportunity, binding, event, stamp, false);
    if (
      !opportunity ||
      opportunity.deletedAt ||
      binding.canonicalUrl !== event.canonicalUrl ||
      !isCompatible(opportunity, event, binding)
    )
      return { status: 'review', targetId: opportunity?.id || '' };
    const latestSequence = Math.max(
      0,
      ...live(data.sourceEvents)
        .filter((stored) => stored.opportunityId === opportunity.id && stored.status === 'recorded')
        .map((stored) => Number(stored.sourceSequence) || 0),
    );
    refreshAutoOwnedFields(
      opportunity,
      binding,
      event,
      stamp,
      event.sourceSequence >= latestSequence,
    );
    return { status: 'recorded', targetId: opportunity.id };
  }

  const candidates = data.opportunities.filter(
    (opportunity) =>
      opportunity.externalId === event.externalJobId ||
      bossJobIdFromUrl(opportunity.url) === event.externalJobId,
  );
  if (candidates.length > 1) return { status: 'review', targetId: '' };
  if (candidates.length === 1) {
    const opportunity = candidates[0],
      otherAccountBinding = live(data.sourceBindings).some(
        (binding) =>
          binding.kind === 'opportunity' &&
          binding.platform === 'boss' &&
          binding.opportunityId === opportunity.id &&
          binding.accountNamespace !== batch.accountNamespace,
      );
    if (opportunity.deletedAt || otherAccountBinding || !isCompatible(opportunity, event))
      return { status: 'review', targetId: opportunity.id };
    data.sourceBindings.push(createBinding(batch, event, opportunity.id, stamp, false));
    return { status: 'recorded', targetId: opportunity.id, linked: true };
  }

  const complete =
    event.intent === 'create_or_link' &&
    batch.policy.autoCreateComplete &&
    event.company.trim() &&
    event.jobName.trim() &&
    event.externalJobId.trim() &&
    event.canonicalUrl.trim();
  if (!complete)
    return {
      status: 'review',
      targetId: '',
      applicationStatus: 'waiting',
      reason: 'missing_job_details',
    };
  const opportunity = createOpportunity(batch, event, stamp);
  if (data.opportunities.some((row) => row.id === opportunity.id))
    return { status: 'review', targetId: opportunity.id };
  data.opportunities.push(opportunity);
  data.sourceBindings.push(createBinding(batch, event, opportunity.id, stamp, true));
  return { status: 'recorded', targetId: opportunity.id, added: true };
}

export function applyBossBatch(
  inputData,
  inputBatch,
  { workspaceSourceId, stamp, allowEventRestore = false, blockedOpportunityIds = [] },
) {
  const batch = validateBossBatch(inputBatch);
  if (!UUID.test(workspaceSourceId))
    throw integrationError('BOSS 工作区处理参数无效。', 'SOURCE_INVALID');
  canonicalIso(stamp, 'processedAt');
  const data = clone(inputData),
    accountBindings = live(data.sourceBindings).filter(
      (binding) =>
        binding.kind === 'account' &&
        binding.platform === 'boss' &&
        binding.accountNamespace === batch.accountNamespace,
    );
  if (accountBindings.length !== 1 || accountBindings[0].workspaceSourceId !== workspaceSourceId)
    throw integrationError('此 BOSS 账号尚未绑定到当前浏览器工作区。', 'SOURCE_NOT_BOUND');

  const counts = { added: 0, linked: 0, observed: 0, reviewed: 0, skipped: 0 };
  const attributionContext = buildBossAttributionContext([
    ...data.sourceEvents,
    ...batch.events.map((event) => ({ ...event, accountNamespace: batch.accountNamespace })),
  ]);
  for (const event of batch.events) {
    const identity = { ...event, platform: 'boss', accountNamespace: batch.accountNamespace },
      completeFactIdentity = hasBossFactIdentity(identity),
      factId = completeFactIdentity ? bossFactId(identity) : '',
      applicationId = factId ? bossApplicationId(factId) : '',
      application = applicationId
        ? data.sourceApplications.find((row) => row.id === applicationId && !row.deletedAt)
        : null;
    const storedIndex = data.sourceEvents.findIndex((row) => row.id === event.eventId),
      stored = storedIndex >= 0 ? data.sourceEvents[storedIndex] : null;
    const restoreLedger =
      Boolean(stored && completeFactIdentity) &&
      (!data.sourceFacts.some((row) => row.id === factId && !row.deletedAt) || !application);
    if (restoreLedger && !allowEventRestore)
      throw integrationError(
        '批次事实账本在当前工作区已删除或缺失，需要明确核对后重放。',
        'RESTORE_REVIEW_REQUIRED',
      );
    if (stored) {
      if (!eventIdentityMatches(stored, batch, event))
        throw integrationError('BOSS 稳定事件 ID 与已有证据冲突。', 'EVENT_ID_CONFLICT');
      if (!stored.deletedAt) {
        if (
          (!application || !['waiting', 'review'].includes(application.status)) &&
          !restoreLedger
        ) {
          counts.skipped++;
          continue;
        }
      }
      if (stored.deletedAt && !allowEventRestore)
        throw integrationError(
          '批次事件在当前工作区已被删除，需要明确核对后重放。',
          'RESTORE_REVIEW_REQUIRED',
        );
      if (stored.deletedAt) data.sourceEvents.splice(storedIndex, 1);
    }
    if (
      event.eventType === 'resume_observed' &&
      application &&
      !['waiting', 'review'].includes(application.status)
    ) {
      const evidence =
        stored && !stored.deletedAt ? stored : sourceEvent(batch, event, '', 'review', stamp);
      if (!stored || stored.deletedAt) data.sourceEvents.push(evidence);
      counts.skipped++;
      continue;
    }
    const blocked =
      data.sourceBindings.some(
        (binding) =>
          binding.kind === 'opportunity' &&
          binding.accountNamespace === batch.accountNamespace &&
          binding.externalJobId === event.externalJobId &&
          blockedOpportunityIds.includes(binding.opportunityId),
      ) ||
      data.opportunities.some(
        (opportunity) =>
          blockedOpportunityIds.includes(opportunity.id) &&
          (opportunity.externalId === event.externalJobId ||
            bossJobIdFromUrl(opportunity.url) === event.externalJobId),
      );
    const result = !completeFactIdentity
      ? {
          status: 'review',
          targetId: '',
          applicationStatus: 'waiting',
          reason: 'missing_message_identity',
        }
      : blocked
        ? {
            status: 'review',
            targetId: '',
            applicationStatus: 'waiting',
            reason: 'entity_sync_conflict',
          }
        : event.eventType === 'resume_observed'
          ? resolveResumeEvent(data, batch, event, attributionContext)
          : event.intent === 'review'
            ? {
                status: 'review',
                targetId: '',
                applicationStatus: event.externalJobId && event.jobName ? 'review' : 'waiting',
                reason:
                  event.externalJobId && event.jobName
                    ? 'identity_conflict'
                    : 'missing_job_details',
              }
            : resolveEvent(data, batch, event, stamp);
    if (result.added) counts.added++;
    if (result.linked) counts.linked++;
    if (result.status === 'recorded') counts.observed++;
    else counts.reviewed++;
    if (event.eventType === 'resume_observed') {
      applyResumeStatus(data, result, event, stamp);
      if (
        result.attributionReason === 'attribution_conversation_association' &&
        ['applied', 'no_effect'].includes(result.applicationStatus)
      )
        result.reason += '_conversation_association';
    }
    const evidence =
      stored && !stored.deletedAt
        ? stored
        : sourceEvent(batch, event, result.targetId, result.status, stamp);
    if (!stored || stored.deletedAt) data.sourceEvents.push(evidence);
    recordSourceApplication(data, evidence, result, stamp, { allowRestore: allowEventRestore });
  }
  return { data: validateData(data), counts };
}

export function getBossWorkspaceSourceId(
  storage = localStorage,
  makeId = () => crypto.randomUUID(),
) {
  const stored = storage.getItem(SOURCE_ID_KEY);
  if (stored && UUID.test(stored)) return stored.toLowerCase();
  const created = makeId();
  if (!UUID.test(created)) throw integrationError('无法创建浏览器来源标识。', 'SOURCE_INVALID');
  storage.setItem(SOURCE_ID_KEY, created.toLowerCase());
  return created.toLowerCase();
}

export async function discoverBossIntegration(fetcher = fetch, hostname = location.hostname) {
  if (!['127.0.0.1', 'localhost'].includes(hostname)) return null;
  try {
    const response = await fetcher('./__local/session', { cache: 'no-store' });
    if (!response.ok) return null;
    const info = await response.json();
    return info.bossIntegrationEnabled && info.session
      ? {
          session: info.session,
          enabled: true,
          serverManaged: !!(info.localWorkspaceEnabled || info.localWorkspace),
          workspaceId: info.workspaceId,
        }
      : null;
  } catch {
    return null;
  }
}

export function bossInboxClient(session, workspaceSourceId, fetcher = fetch) {
  if (!/^[a-f0-9]{64}$/.test(session) || !UUID.test(workspaceSourceId))
    throw integrationError('本机 BOSS 接入会话无效。', 'SESSION_INVALID');
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetcher(path, {
        ...options,
        cache: 'no-store',
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          'X-Job-Tracker-Session': session,
          'X-Job-Tracker-Protocol': '1',
          ...options.headers,
        },
        signal: options.signal || AbortSignal.timeout(15000),
      });
    } catch {
      throw integrationError('本机 BOSS 接入服务暂时无法连接。', 'LOCAL_UNAVAILABLE');
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw integrationError('本机 BOSS 接入服务返回无效内容。', 'LOCAL_INVALID');
    }
    if (!response.ok) {
      const error = integrationError(result.message || '本机 BOSS 接入失败。', result.code);
      error.status = response.status;
      throw error;
    }
    return result;
  }
  return {
    index: () =>
      request(`./__local/boss-inbox?workspaceSourceId=${encodeURIComponent(workspaceSourceId)}`),
    read: (batchId) => {
      if (!BATCH_ID.test(batchId)) throw integrationError('BOSS 批次 ID 无效。', 'BATCH_INVALID');
      return request(`./__local/boss-inbox/${batchId}`);
    },
    acknowledge: (batchId, receipt) => {
      if (!BATCH_ID.test(batchId)) throw integrationError('BOSS 批次 ID 无效。', 'BATCH_INVALID');
      return request(`./__local/boss-inbox/${batchId}/receipt`, {
        method: 'PUT',
        body: JSON.stringify(receipt),
      });
    },
    replay: (batchId, expectedRevision) => {
      if (!BATCH_ID.test(batchId)) throw integrationError('BOSS 批次 ID 无效。', 'BATCH_INVALID');
      return request(`./__local/boss-inbox/${batchId}/replay`, {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision }),
      });
    },
  };
}

function summarizeIndex(index, data, workspaceSourceId) {
  const batches = Array.isArray(index?.batches) ? index.batches : [],
    accountBindings = live(data.sourceBindings).filter(
      (binding) => binding.kind === 'account' && binding.platform === 'boss',
    ),
    deletedAccountBindings = data.sourceBindings.filter(
      (binding) => binding.kind === 'account' && binding.platform === 'boss' && binding.deletedAt,
    ),
    accounts = [...new Set(batches.map((batch) => batch.accountNamespace))]
      .filter((account) => ACCOUNT_NAMESPACE.test(account))
      .map((accountNamespace) => {
        const binding = accountBindings.find(
            (candidate) => candidate.accountNamespace === accountNamespace,
          ),
          deleted = deletedAccountBindings.find(
            (candidate) => candidate.accountNamespace === accountNamespace,
          );
        return {
          accountNamespace,
          label: `BOSS 账号 · ${accountNamespace.slice(-8)}`,
          pending: batches.filter(
            (batch) =>
              batch.accountNamespace === accountNamespace && batch.receipt?.status !== 'processed',
          ).length,
          bound: binding?.workspaceSourceId === workspaceSourceId,
          ownedElsewhere:
            (!!binding && binding.workspaceSourceId !== workspaceSourceId) ||
            (!!deleted && deleted.workspaceSourceId !== workspaceSourceId),
          restoreRequired: !binding && deleted?.workspaceSourceId === workspaceSourceId,
        };
      });
  return {
    available: true,
    sourceId: workspaceSourceId,
    accounts,
    pending: batches.filter((batch) => batch.receipt?.status !== 'processed').length,
    queued: batches.length,
    server: index?.status || {},
    tracking: index?.tracking || null,
  };
}

export function createBossQueueConsumer({
  fetcher = fetch,
  storage = localStorage,
  readWorkspace,
  editWorkspace,
  bindWorkspace,
  onCommitted = () => {},
  onStatus = () => {},
  lockManager = navigator.locks,
  now = () => new Date().toISOString(),
  hostname = location.hostname,
}) {
  let workspaceSourceId = getBossWorkspaceSourceId(storage);
  let client = null,
    serverManaged = false,
    running = null,
    status = { available: false, sourceId: workspaceSourceId, accounts: [], pending: 0 };

  const publish = (patch) => {
    const next = { ...status, ...patch };
    if (!equal(next, status)) {
      status = next;
      onStatus(clone(status));
    }
    return status;
  };

  async function connect() {
    if (client) return true;
    const discovered = await discoverBossIntegration(fetcher, hostname);
    if (!discovered) {
      publish({ available: false, connected: false });
      return false;
    }
    serverManaged = discovered.serverManaged;
    if (serverManaged) {
      if (!UUID.test(discovered.workspaceId || ''))
        throw integrationError('本机工作区身份无效。', 'LOCAL_WORKSPACE_INVALID');
      workspaceSourceId = discovered.workspaceId;
    }
    client = bossInboxClient(discovered.session, workspaceSourceId, fetcher);
    return true;
  }

  async function applyBatch(batch, { acknowledge = true, allowEventRestore = false } = {}) {
    let counts;
    const stamp = now();
    await editWorkspace(
      (data) => {
        const applied = applyBossBatch(data, batch, {
          workspaceSourceId,
          stamp,
          allowEventRestore,
        });
        counts = applied.counts;
        return applied.data;
      },
      { reason: '录入 BOSS 来源批次前' },
    );
    await Promise.resolve(onCommitted());
    if (acknowledge)
      await client.acknowledge(batch.batchId, {
        format: 'job-tracker-boss-receipt',
        version: 2,
        batchId: batch.batchId,
        workspaceSourceId,
        status: 'processed',
        processedAt: stamp,
        counts,
        errorCode: '',
      });
    return counts;
  }

  async function findReceiptGaps(index, data, boundAccounts) {
    const gaps = [];
    for (const summary of (index.batches || []).filter(
      (batch) => batch.receipt?.status === 'processed' && boundAccounts.has(batch.accountNamespace),
    )) {
      const batch = await verifyBossBatch(await client.read(summary.batchId)),
        missing = bossReceiptGap(data, batch);
      if (missing)
        gaps.push({
          batchId: batch.batchId,
          accountNamespace: batch.accountNamespace,
          missing,
          sourceSequence: batch.sourceSequence,
        });
    }
    return gaps;
  }

  async function consume() {
    if (!(await connect())) return status;
    const index = await client.index(),
      initialState = await readWorkspace();
    publish({
      ...summarizeIndex(index, initialState.data, workspaceSourceId),
      connected: true,
      error: '',
      applicationCounts: sourceReviewCounts(initialState.data),
    });
    if (serverManaged) {
      // The local service owns ingestion, including when this page is closed.
      // A browser is an observer/editor and must never replay applications.
      publish({
        serverManaged: true,
        attribution:
          index.tracking?.attribution ??
          index.recovery?.attribution ??
          bossAttributionSummary(initialState.data),
        blocked: index.recovery?.restoreReview?.length
          ? '当前正式工作区缺少已回执的来源证据，请核对后明确重放。'
          : '',
        restoreReview: index.recovery?.restoreReview || [],
        revision: index.recovery?.revision,
        accounts: status.accounts.map((account) => ({
          ...account,
          restoreRequired: account.restoreRequired || account.ownedElsewhere,
        })),
      });
      return status;
    }
    const boundAccounts = new Set(
        status.accounts
          .filter((account) => account.bound)
          .map((account) => account.accountNamespace),
      ),
      restoreReview = await findReceiptGaps(index, initialState.data, boundAccounts);
    publish({ restoreReview });
    if (initialState.pending) {
      publish({ blocked: '请先处理同步冲突，BOSS 待录入批次仍保留。' });
      return status;
    }
    if (restoreReview.length) {
      publish({ blocked: '当前工作区缺少已回执的来源证据，请先核对恢复批次。' });
      return status;
    }
    if ((index.batches || []).some((batch) => batch.receipt?.status === 'blocked')) {
      publish({ blocked: '本机存在被阻止的 BOSS 批次，请先查看故障材料并人工处理。' });
      return status;
    }
    const batches = (index.batches || [])
      .filter((batch) => !batch.receipt && boundAccounts.has(batch.accountNamespace))
      .sort(
        (a, b) =>
          Number(a.sourceSequence) - Number(b.sourceSequence) ||
          String(a.batchId).localeCompare(String(b.batchId)),
      );
    let processed = 0;
    for (const summary of batches) {
      const batch = await verifyBossBatch(await client.read(summary.batchId));
      await applyBatch(batch);
      processed++;
    }
    const refreshed = await client.index(),
      finalState = await readWorkspace();
    publish({
      ...summarizeIndex(refreshed, finalState.data, workspaceSourceId),
      connected: true,
      blocked: '',
      error: '',
      processed,
      lastProcessedAt: processed ? now() : status.lastProcessedAt || '',
      restoreReview: await findReceiptGaps(refreshed, finalState.data, boundAccounts),
    });
    return status;
  }

  async function consumeWithSessionRefresh() {
    try {
      return await consume();
    } catch (error) {
      if (error?.status !== 403) throw error;
      client = null;
      return consume();
    }
  }

  async function run() {
    if (running) return running;
    const execute = async () => {
      publish({ running: true });
      try {
        const task = () => consumeWithSessionRefresh();
        if (!lockManager?.request)
          throw integrationError(
            '当前浏览器无法协调多标签处理，BOSS 队列已暂停。',
            'LOCK_UNAVAILABLE',
          );
        return await lockManager.request(
          `job-tracker-boss-inbox:${workspaceSourceId}`,
          { ifAvailable: true },
          (lock) => (lock ? task() : status),
        );
      } catch (error) {
        publish({
          error: `${error.code || 'BOSS_INTEGRATION_FAILED'}：${error.message}`,
          blocked: '',
        });
        return status;
      } finally {
        publish({ running: false });
      }
    };
    running = execute().finally(() => {
      running = null;
    });
    return running;
  }

  async function bind(accountNamespace, { restore = false } = {}) {
    if (!status.accounts.some((account) => account.accountNamespace === accountNamespace))
      throw integrationError('队列中没有这个 BOSS 来源账号。', 'SOURCE_INVALID');
    const stamp = now();
    if (serverManaged) {
      if (typeof bindWorkspace !== 'function')
        throw integrationError('本机服务不支持固定来源绑定命令。', 'LOCAL_WORKSPACE_INVALID');
      await bindWorkspace(accountNamespace, { restore });
    } else
      await editWorkspace(
        (data) =>
          bindBossAccount(data, accountNamespace, workspaceSourceId, stamp, {
            allowRestore: restore,
            allowRebind: false,
          }),
        { reason: '绑定 BOSS 采集来源前' },
      );
    await Promise.resolve(onCommitted());
    return run();
  }

  async function replay(batchId) {
    if (!status.restoreReview?.some((gap) => gap.batchId === batchId))
      throw integrationError('这个批次当前不需要恢复核对。', 'REPLAY_NOT_REQUIRED');
    if (!(await connect())) throw integrationError('本机 BOSS 接入未启用。', 'LOCAL_UNAVAILABLE');
    if (serverManaged) {
      await client.replay(batchId, status.revision);
      await Promise.resolve(onCommitted());
      return consumeWithSessionRefresh();
    }
    const task = async () => {
      const current = await readWorkspace();
      if (current.pending) throw integrationError('请先处理同步冲突。', 'SYNC_CONFLICT');
      const batch = await verifyBossBatch(await client.read(batchId));
      await applyBatch(batch, { acknowledge: false, allowEventRestore: true });
      return consume();
    };
    if (!lockManager?.request)
      throw integrationError('当前浏览器无法协调多标签处理，BOSS 队列已暂停。', 'LOCK_UNAVAILABLE');
    return lockManager.request(
      `job-tracker-boss-inbox:${workspaceSourceId}`,
      { ifAvailable: true },
      (lock) => {
        if (!lock) throw integrationError('另一个工作台页面正在处理 BOSS 队列。', 'LOCKED');
        return task();
      },
    );
  }

  return {
    run,
    bind,
    replay,
    getStatus: () => clone(status),
    workspaceSourceId,
  };
}

export function latestPlatformObservation(data, opportunityId) {
  return live(effectiveSourceFacts(data))
    .filter(
      (event) =>
        event.opportunityId === opportunityId &&
        event.status === 'recorded' &&
        event.eventType === 'conversation_observed',
    )
    .sort(
      (a, b) =>
        Number(b.sourceSequence || 0) - Number(a.sourceSequence || 0) ||
        (b.observedAt || '').localeCompare(a.observedAt || '') ||
        b.id.localeCompare(a.id),
    )[0];
}

export function platformObservationLabel(event) {
  if (!event) return '';
  if (event.eventType === 'resume_observed') return resumeRule(event.summary).label;
  if (event.messageDirection === 'inbound' || event.receiptStatus === 'not_applicable')
    return '对方消息';
  return (
    {
      read: '对方已读',
      delivered: '已送达',
      unknown: '状态未知',
    }[event.receiptStatus] || '状态未知'
  );
}
