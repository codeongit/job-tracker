import { parseBossJobUrl } from '../contracts/job-url.js';
import { assessBossJobMaterials } from './job-materials.js';
import { validateBossBatch, bossEventDigestInput, bossBatchDigestInput } from '../rules/batch.js';
export { validateBossBatch } from '../rules/batch.js';
import { assessBossAttribution, buildBossAttributionContext } from '../rules/attribution.js';
import { resumeRule, resumeTransition, resumeEvidenceMeaning } from '../rules/resume-rules.js';
import {
  clone,
  getResumeLinkedStatus,
  live,
  validateData,
  SOURCE_AUTO_FIELDS,
} from '../../model.js';
import {
  recordSourceApplication,
  sourceApplicationForEvent,
  effectiveSourceFacts,
  isIgnoredObservation,
  IGNORED_OBSERVATION_REASON,
  SOURCE_RULE_VERSION,
} from '../../source-ledger.js';
import { bossApplicationId, bossFactId, hasBossFactIdentity } from '../../source-identity.js';

const ACCOUNT_NAMESPACE = /^boss-geek:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
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
  return parseBossJobUrl(value)?.jobId || '';
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

function refreshAutoOwnedFields(
  opportunity,
  binding,
  event,
  stamp,
  allowUpdates,
  updateFields = AUTO_FIELDS,
) {
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
    if (allowUpdates && updateFields.includes(field) && incoming && current !== incoming) {
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
  let attribution = assessBossAttribution(batch.accountNamespace, event, context);
  let observationOnly = !resumeRule(event.summary).target;
  // All status observations need their own recheckable system semantics. Keep
  // historical labels and IDs, but never promote a producer's label to proof.
  if (!observationOnly && attribution.status !== 'conflict') {
    const identity = { ...event, platform: 'boss', accountNamespace: batch.accountNamespace };
    const factId = bossFactId(identity);
    const candidates = [...(context?.factAssociations?.get(factId) ?? []), identity];
    const classified = candidates.map((candidate) => ({
      candidate,
      meaning: resumeEvidenceMeaning(candidate.summary, candidate.resumeEvidence ?? null),
    }));
    const confirmed = classified.filter((item) => item.meaning.status === 'verified');
    const cards = classified.filter((item) => item.candidate.resumeEvidence?.field === 'none');
    if (!confirmed.length && cards.length) observationOnly = true;
    else if (!confirmed.length || cards.length)
      return {
        status: 'review',
        targetId: '',
        applicationStatus: 'waiting',
        reason: 'resume_semantics_missing',
      };
    else {
      // Attribution and system semantics must be complete in the same
      // observation. Never combine an old candidate's identity with another
      // candidate's system text to manufacture a valid chain.
      const proofCandidates = confirmed.map((item) => item.candidate);
      const factObservations = new Map(context?.factObservations ?? []);
      factObservations.set(factId, proofCandidates);
      attribution = assessBossAttribution(batch.accountNamespace, proofCandidates[0], {
        ...context,
        factObservations,
      });
    }
  }
  // A card with no status meaning only needs archival, never a confirmed job
  // target. Keep explicit contradictions visible and retain its candidate
  // association in the immutable source context for later cross-job checks.
  if (observationOnly && attribution.status !== 'conflict')
    return {
      status: 'recorded',
      targetId: '',
      applicationStatus: 'no_effect',
      reason: 'observation_only',
      evidenceStatus: 'review',
    };
  if (attribution.status !== 'verified')
    return {
      status: 'review',
      targetId: '',
      applicationStatus: attribution.status === 'conflict' ? 'review' : 'waiting',
      reason: attribution.reason,
    };
  const externalJobId = attribution.externalJobId;
  const canonicalUrl = externalJobId
    ? new URL(`/job_detail/${externalJobId}.html`, 'https://www.zhipin.com').href
    : '';
  if (!externalJobId || !canonicalUrl)
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
      binding.externalJobId === externalJobId,
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
    !isBossPlatform(opportunity.platform || '') ||
    (opportunity.externalId && opportunity.externalId !== externalJobId) ||
    binding.canonicalUrl !== canonicalUrl ||
    parseBossJobUrl(opportunity.url)?.canonicalUrl !== canonicalUrl
  )
    return {
      status: 'review',
      targetId: opportunity?.id || '',
      applicationStatus: opportunity?.deletedAt ? 'protected' : 'review',
      reason: opportunity?.deletedAt ? 'opportunity_deleted' : 'job_identity_conflict',
    };
  return {
    status: 'recorded',
    targetId: opportunity.id,
    attributionReason: attribution.reason,
    attributionJobId: externalJobId,
    attributionBindingId: binding.id,
  };
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
    (row) => row.kind === 'opportunity' && row.id === result.attributionBindingId,
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

// Explicitly reviewed semantic corrections are separate from automatic import.
// They revoke selected facts without claiming any new message/job attribution.
function retractCorrectedResumeStage(data, opportunity, binding) {
  if (
    !splitAutoFields(binding).has('stage') ||
    opportunity.stage !== '沟通中' ||
    binding.lastAutoStage !== '沟通中' ||
    live(data.activities).some((activity) => activity.opportunityId === opportunity.id)
  )
    return false;
  opportunity.stage = '已触达';
  binding.lastAutoStage = '已触达';
  return true;
}

export function correctBossResumeSemantics(
  inputData,
  { applicationIds, stamp, workspaceSourceId },
) {
  const unsafe = () => {
    throw integrationError(
      '简历发送误判纠正条件不满足，未改动正式记录。',
      'BOSS_RESUME_CORRECTION_UNSAFE',
    );
  };
  try {
    canonicalIso(stamp, 'correctedAt');
    if (
      !UUID.test(workspaceSourceId) ||
      !Array.isArray(applicationIds) ||
      !applicationIds.length ||
      applicationIds.length > 100 ||
      new Set(applicationIds).size !== applicationIds.length ||
      applicationIds.some(
        (id) => typeof id !== 'string' || !/^boss-application-[a-f0-9]{64}$/.test(id),
      )
    )
      unsafe();
    const data = validateData(clone(inputData));
    const facts = new Map(data.sourceFacts.map((fact) => [fact.id, fact]));
    const applications = new Map(
      data.sourceApplications.map((application) => [application.id, application]),
    );
    const selectedFacts = new Set();
    const targets = new Map();
    const approved = applicationIds.map((id) => {
      const application = applications.get(id),
        fact = facts.get(application?.factId);
      const previouslyRejected =
        application?.status === 'protected' &&
        application.reason === 'user_rejected_wrong_resume_semantics';
      if (
        !application ||
        application.deletedAt ||
        (application.status !== 'applied' && !previouslyRejected) ||
        application.action !== 'resume_observed' ||
        application.resolutionSource ||
        !application.opportunityId ||
        !fact ||
        fact.deletedAt ||
        fact.platform !== 'boss' ||
        fact.factType !== 'resume_request_sent' ||
        !hasBossFactIdentity(fact) ||
        bossFactId(fact) !== fact.id ||
        bossApplicationId(fact.id) !== application.id ||
        selectedFacts.has(fact.id)
      )
        unsafe();
      const aliases = data.sourceEvents.filter(
        (event) =>
          event.factId === fact.id || (hasBossFactIdentity(event) && bossFactId(event) === fact.id),
      );
      if (
        !aliases.length ||
        aliases.some(
          (event) =>
            event.deletedAt ||
            event.platform !== 'boss' ||
            event.eventType !== 'resume_observed' ||
            event.summary !== 'resume_request_sent' ||
            !hasBossFactIdentity(event) ||
            event.factId !== fact.id ||
            bossFactId(event) !== fact.id ||
            event.accountNamespace !== fact.accountNamespace ||
            event.conversationKey !== fact.conversationKey ||
            event.messageId !== fact.messageId,
        )
      )
        unsafe();
      const opportunity = data.opportunities.find((row) => row.id === application.opportunityId);
      const bindings = live(data.sourceBindings).filter(
        (row) => row.kind === 'opportunity' && row.opportunityId === application.opportunityId,
      );
      const binding = bindings.length === 1 ? bindings[0] : null;
      const accountBindings = live(data.sourceBindings).filter(
        (row) => row.kind === 'account' && row.accountNamespace === fact.accountNamespace,
      );
      if (
        !opportunity ||
        opportunity.deletedAt ||
        !/^boss(?:直聘)?$/i.test((opportunity.platform || '').replace(/\s/g, '')) ||
        !binding ||
        binding.platform !== 'boss' ||
        binding.accountNamespace !== fact.accountNamespace ||
        binding.id !== opportunityBindingId(fact.accountNamespace, binding.externalJobId) ||
        accountBindings.length !== 1 ||
        accountBindings[0].workspaceSourceId !== workspaceSourceId ||
        (fact.externalJobId && fact.externalJobId !== binding.externalJobId) ||
        (opportunity.externalId && opportunity.externalId !== binding.externalJobId) ||
        (opportunity.url &&
          parseBossJobUrl(opportunity.url)?.canonicalUrl !== binding.canonicalUrl) ||
        !splitAutoFields(binding).has('resumeState') ||
        opportunity.resumeState !== (previouslyRejected ? '未知' : '已发送') ||
        binding.lastAutoResumeState !== opportunity.resumeState
      )
        unsafe();
      const jobBindings = live(data.sourceBindings).filter(
        (row) =>
          row.kind === 'opportunity' &&
          row.accountNamespace === fact.accountNamespace &&
          row.externalJobId === binding.externalJobId,
      );
      if (
        jobBindings.length !== 1 ||
        jobBindings[0].opportunityId !== opportunity.id ||
        aliases.some(
          (event) =>
            (event.opportunityId && event.opportunityId !== opportunity.id) ||
            (event.externalJobId && event.externalJobId !== binding.externalJobId) ||
            (event.canonicalUrl && event.canonicalUrl !== binding.canonicalUrl),
        )
      )
        unsafe();
      const targetKey = JSON.stringify([fact.accountNamespace, binding.externalJobId]);
      if (targets.has(targetKey) && targets.get(targetKey).opportunity.id !== opportunity.id)
        unsafe();
      targets.set(targetKey, { opportunity, binding });
      selectedFacts.add(fact.id);
      return { application, fact, opportunity, binding, previouslyRejected };
    });
    const deniedReasons = new Set([
      'user_rejected_wrong_conversation',
      'user_rejected_wrong_resume_semantics',
      IGNORED_OBSERVATION_REASON,
    ]);
    for (const { fact, opportunity, binding } of approved) {
      const relatedEvents = data.sourceEvents.filter(
        (event) =>
          event.eventType === 'resume_observed' &&
          (event.opportunityId === opportunity.id ||
            applications.get(bossApplicationId(event.factId))?.opportunityId === opportunity.id ||
            (event.accountNamespace === fact.accountNamespace &&
              (event.externalJobId === binding.externalJobId ||
                (!event.externalJobId && event.conversationKey === fact.conversationKey)))),
      );
      const relatedFactIds = new Set(relatedEvents.map((event) => event.factId));
      for (const application of data.sourceApplications)
        if (
          application.action === 'resume_observed' &&
          application.opportunityId === opportunity.id
        )
          relatedFactIds.add(application.factId);
      for (const candidate of data.sourceFacts)
        if (
          candidate.accountNamespace === fact.accountNamespace &&
          candidate.conversationKey === fact.conversationKey &&
          (!candidate.externalJobId || candidate.externalJobId === binding.externalJobId)
        )
          relatedFactIds.add(candidate.id);
      for (const id of relatedFactIds) {
        if (selectedFacts.has(id)) continue;
        const otherFact = facts.get(id),
          otherApplication = applications.get(bossApplicationId(id));
        const aliases = relatedEvents.filter((event) => event.factId === id);
        if (!otherFact || !otherApplication) unsafe();
        if (!otherFact.factType.startsWith('resume_')) continue;
        if (!resumeRule(otherFact.factType).target) continue;
        if (otherApplication.status === 'protected' && deniedReasons.has(otherApplication.reason))
          continue;
        // Any remaining send/receive fact or incomplete ledger may independently
        // support the current status. A selected false card cannot erase it.
        if (
          otherFact.deletedAt ||
          otherApplication.deletedAt ||
          !aliases.length ||
          aliases.some((event) => event.deletedAt)
        )
          unsafe();
        unsafe();
      }
    }
    for (const { opportunity, binding } of targets.values()) {
      let changed = opportunity.resumeState !== '未知';
      if (changed) {
        opportunity.resumeState = '未知';
        binding.lastAutoResumeState = '未知';
      }
      if (retractCorrectedResumeStage(data, opportunity, binding)) changed = true;
      if (changed) {
        opportunity.updatedAt = stamp;
        binding.updatedAt = stamp;
      }
    }
    for (const { application, previouslyRejected } of approved) {
      if (previouslyRejected) continue;
      application.status = 'protected';
      application.reason = 'user_rejected_wrong_resume_semantics';
      application.appliedAt = '';
      application.ruleVersion = SOURCE_RULE_VERSION;
      application.updatedAt = stamp;
    }
    return validateData(data);
  } catch {
    unsafe();
  }
}

export function preserveBossResumeCorrections(beforeData, restoredData) {
  const unsafe = () => {
    throw integrationError(
      '恢复材料与已人工否决的简历观察身份冲突，原工作区未改动。',
      'BOSS_RESUME_CORRECTION_UNSAFE',
    );
  };
  try {
    const before = validateData(clone(beforeData), { allowOrphans: true });
    const data = validateData(clone(restoredData), { allowOrphans: true });
    const preservedTargets = new Map();
    for (const previous of before.sourceApplications) {
      if (
        previous.deletedAt ||
        previous.status !== 'protected' ||
        previous.reason !== 'user_rejected_wrong_resume_semantics'
      )
        continue;
      const fact = before.sourceFacts.find((row) => row.id === previous.factId && !row.deletedAt);
      const incomingFact = data.sourceFacts.find(
        (row) => row.id === previous.factId && !row.deletedAt,
      );
      const application = data.sourceApplications.find(
        (row) => row.id === previous.id && !row.deletedAt,
      );
      const opportunity = data.opportunities.find(
        (row) => row.id === previous.opportunityId && !row.deletedAt,
      );
      const aliases = live(data.sourceEvents).filter((row) => row.factId === previous.factId);
      // Missing/deleted entities remain recovery gaps or tombstones. The helper
      // only preserves a decision where its existing live materials remain.
      if (!fact || !incomingFact || !application || !opportunity || !aliases.length) continue;
      if (
        fact.factType !== 'resume_request_sent' ||
        bossFactId(fact) !== fact.id ||
        bossFactId(incomingFact) !== fact.id ||
        bossApplicationId(fact.id) !== previous.id ||
        application.factId !== fact.id ||
        (application.opportunityId && application.opportunityId !== previous.opportunityId)
      )
        unsafe();
      const priorBindings = before.sourceBindings.filter(
        (row) =>
          row.kind === 'opportunity' &&
          row.opportunityId === previous.opportunityId &&
          row.accountNamespace === fact.accountNamespace,
      );
      const priorJobIds = new Set(priorBindings.map((row) => row.externalJobId));
      if (priorJobIds.size !== 1) unsafe();
      const expectedJobId = [...priorJobIds][0];
      const expectedUrl = new URL(`/job_detail/${expectedJobId}.html`, 'https://www.zhipin.com')
        .href;
      const bindings = live(data.sourceBindings).filter(
        (row) => row.kind === 'opportunity' && row.opportunityId === previous.opportunityId,
      );
      if (
        (fact.externalJobId && fact.externalJobId !== expectedJobId) ||
        (incomingFact.externalJobId && incomingFact.externalJobId !== expectedJobId) ||
        aliases.some(
          (row) =>
            row.platform !== 'boss' ||
            row.eventType !== 'resume_observed' ||
            row.summary !== 'resume_request_sent' ||
            !hasBossFactIdentity(row) ||
            bossFactId(row) !== fact.id ||
            (row.opportunityId && row.opportunityId !== opportunity.id) ||
            (row.externalJobId && row.externalJobId !== expectedJobId) ||
            (row.canonicalUrl && row.canonicalUrl !== expectedUrl),
        ) ||
        (opportunity.externalId && opportunity.externalId !== expectedJobId) ||
        (opportunity.url && parseBossJobUrl(opportunity.url)?.canonicalUrl !== expectedUrl) ||
        bindings.some(
          (row) =>
            row.accountNamespace !== fact.accountNamespace ||
            row.externalJobId !== expectedJobId ||
            row.canonicalUrl !== expectedUrl,
        ) ||
        bindings.length > 1
      )
        unsafe();
      Object.assign(application, clone(previous));
      const priorOpportunity = live(before.opportunities).find((row) => row.id === opportunity.id);
      const livePriorBindings = live(priorBindings);
      const stageWasRetracted =
        priorOpportunity?.stage === '已触达' &&
        livePriorBindings.length === 1 &&
        splitAutoFields(livePriorBindings[0]).has('stage') &&
        livePriorBindings[0].lastAutoStage === '已触达';
      preservedTargets.set(opportunity.id, {
        opportunity,
        binding: bindings[0] ?? null,
        stamp: stageWasRetracted
          ? priorOpportunity.updatedAt || previous.updatedAt
          : previous.updatedAt,
        stageWasRetracted,
      });
    }
    // Preserve every selected decision before checking the remaining support,
    // so multiple corrected facts on one job cannot protect each other.
    for (const { opportunity, binding, stamp, stageWasRetracted } of preservedTargets.values()) {
      if (
        !binding ||
        !/^boss(?:直聘)?$/i.test((opportunity.platform || '').replace(/\s/g, '')) ||
        !['已发送', '未知'].includes(opportunity.resumeState) ||
        !splitAutoFields(binding).has('resumeState') ||
        binding.lastAutoResumeState !== opportunity.resumeState
      )
        continue;
      const independentSupport =
        data.sourceApplications.some((application) => {
          if (
            application.deletedAt ||
            application.opportunityId !== opportunity.id ||
            application.action !== 'resume_observed' ||
            !['applied', 'no_effect'].includes(application.status)
          )
            return false;
          const fact = data.sourceFacts.find(
            (row) => row.id === application.factId && !row.deletedAt,
          );
          return !fact || Boolean(resumeRule(fact.factType).target);
        }) ||
        data.sourceEvents.some((event) => {
          if (
            event.deletedAt ||
            event.eventType !== 'resume_observed' ||
            event.opportunityId !== opportunity.id ||
            !resumeRule(event.summary).target
          )
            return false;
          const application = data.sourceApplications.find(
            (row) => row.factId === event.factId && !row.deletedAt,
          );
          return !application;
        });
      if (independentSupport) continue;
      let changed = opportunity.resumeState !== '未知';
      if (changed) {
        opportunity.resumeState = '未知';
        binding.lastAutoResumeState = '未知';
      }
      if (stageWasRetracted && retractCorrectedResumeStage(data, opportunity, binding))
        changed = true;
      if (changed) {
        opportunity.updatedAt = stamp;
        binding.updatedAt = stamp;
      }
    }
    return validateData(data, { allowOrphans: true });
  } catch {
    unsafe();
  }
}

// A navigation candidate is not an attribution decision and never changes data.
export function bossWaitingReviewTarget(data, applicationId) {
  const application = live(data?.sourceApplications || []).find(
    (row) => row.id === applicationId && row.status === 'waiting',
  );
  const fact =
    application &&
    live(data.sourceFacts || []).find(
      (row) => row.id === application.factId && row.platform === 'boss',
    );
  const events = fact && live(data.sourceEvents || []).filter((row) => row.factId === fact.id);
  if (
    !events?.length ||
    events.some((row) => row.platform !== 'boss' || row.accountNamespace !== fact.accountNamespace)
  )
    return null;
  const jobIds = new Set(events.map((row) => row.externalJobId).filter(Boolean));
  if (jobIds.size !== 1) return null;
  const externalJobId = [...jobIds][0];
  const urls = new Set(events.map((row) => row.canonicalUrl).filter(Boolean));
  if (
    urls.size !== 1 ||
    bossJobIdFromUrl([...urls][0]) !== externalJobId ||
    !events.some((row) => row.externalJobId === externalJobId && row.canonicalUrl === [...urls][0])
  )
    return null;
  const canonicalUrl = [...urls][0];
  const bindings = live(data.sourceBindings || []).filter(
    (row) =>
      row.platform === 'boss' &&
      row.kind === 'opportunity' &&
      row.accountNamespace === fact.accountNamespace &&
      row.externalJobId === externalJobId,
  );
  if (bindings.length !== 1 || bindings[0].canonicalUrl !== canonicalUrl) return null;
  const binding = bindings[0];
  const opportunity = live(data.opportunities || []).find(
    (row) => row.id === binding.opportunityId,
  );
  if (
    !opportunity ||
    !isBossPlatform(opportunity.platform || '') ||
    (opportunity.externalId && opportunity.externalId !== externalJobId) ||
    bossJobIdFromUrl(opportunity.url) !== externalJobId ||
    events.some(
      (row) =>
        (row.company && normalize(row.company) !== normalize(opportunity.company)) ||
        (row.jobName && normalize(row.jobName) !== normalize(opportunity.role)),
    )
  )
    return null;
  return {
    opportunityId: opportunity.id,
    company: opportunity.company || '',
    role: opportunity.role || '',
    resumeState: opportunity.resumeState || '未知',
    manualResumeState: !(
      splitAutoFields(binding).has('resumeState') &&
      (opportunity.resumeState || '') === (binding.lastAutoResumeState || '')
    ),
  };
}

// Suggestions are for manual inspection only; company similarity never grants attribution.
export function bossWaitingReviewCandidates(data, applicationId) {
  const application = live(data?.sourceApplications || []).find(
    (row) => row.id === applicationId && ['waiting', 'review'].includes(row.status),
  );
  const fact =
    application &&
    live(data.sourceFacts || []).find(
      (row) => row.id === application.factId && row.platform === 'boss',
    );
  if (!fact) return [];
  const events = live(data.sourceEvents || []).filter(
    (row) =>
      row.factId === fact.id &&
      row.platform === 'boss' &&
      row.accountNamespace === fact.accountNamespace,
  );
  if (!events.length) return [];
  return live(data.opportunities || [])
    .flatMap((opportunity) => {
      if (
        !isBossPlatform(opportunity.platform || '') ||
        live(data.sourceBindings || []).some(
          (row) =>
            row.kind === 'opportunity' &&
            row.platform === 'boss' &&
            row.opportunityId === opportunity.id &&
            row.accountNamespace !== fact.accountNamespace,
        )
      )
        return [];
      const exact = events.some(
        (row) =>
          row.externalJobId &&
          (opportunity.externalId === row.externalJobId ||
            bossJobIdFromUrl(opportunity.url) === row.externalJobId),
      );
      const sameCompany = events.some(
        (row) => row.company && normalize(row.company) === normalize(opportunity.company),
      );
      return exact || sameCompany
        ? [
            {
              opportunityId: opportunity.id,
              company: opportunity.company || '',
              role: opportunity.role || '',
              exact,
            },
          ]
        : [];
    })
    .sort((a, b) => Number(b.exact) - Number(a.exact) || a.role.localeCompare(b.role, 'zh-CN'));
}

export function ignoreBossObservations(inputData, { applicationIds, workspaceSourceId, stamp }) {
  canonicalIso(stamp, 'ignoredAt');
  if (
    !UUID.test(workspaceSourceId) ||
    !Array.isArray(applicationIds) ||
    !applicationIds.length ||
    applicationIds.length > 100 ||
    new Set(applicationIds).size !== applicationIds.length ||
    applicationIds.some(
      (id) => typeof id !== 'string' || !/^boss-application-[a-f0-9]{64}$/.test(id),
    )
  )
    throw integrationError('忽略观察参数无效。', 'BOSS_IGNORE_INVALID');
  const data = clone(inputData);
  const selected = applicationIds.map((id) => {
    const application = live(data.sourceApplications).find((row) => row.id === id);
    const fact = application && live(data.sourceFacts).find((row) => row.id === application.factId);
    const event =
      application &&
      live(data.sourceEvents).find((row) => sourceApplicationForEvent(data, row)?.id === id);
    const accounts =
      event &&
      live(data.sourceBindings).filter(
        (row) =>
          row.kind === 'account' &&
          row.platform === 'boss' &&
          row.accountNamespace === event.accountNamespace,
      );
    if (
      !application ||
      application.status !== 'waiting' ||
      !fact ||
      fact.platform !== 'boss' ||
      !event ||
      event.platform !== 'boss' ||
      fact.accountNamespace !== event.accountNamespace ||
      accounts.length !== 1 ||
      accounts[0].workspaceSourceId !== workspaceSourceId
    )
      throw integrationError('所选观察已变化或来源无效，请刷新后重新核对。', 'BOSS_IGNORE_UNSAFE');
    return application;
  });
  for (const application of selected) {
    application.status = 'protected';
    application.reason = IGNORED_OBSERVATION_REASON;
    application.ruleVersion = SOURCE_RULE_VERSION;
    application.appliedAt = '';
    application.updatedAt = stamp;
  }
  return validateData(data);
}

// Every ordinary observation, including queue replay, uses the same current
// workspace material decision. Mutation and field ownership stay in this adapter.
function resolveEvent(data, batch, originalEvent, stamp) {
  const material = assessBossJobMaterials({
    event: originalEvent,
    accountNamespace: batch.accountNamespace,
    opportunities: data.opportunities,
    bindings: data.sourceBindings,
  });
  const opportunity = material.targetId
    ? data.opportunities.find((row) => row.id === material.targetId)
    : null;
  const binding = material.bindingId
    ? data.sourceBindings.find((row) => row.id === material.bindingId)
    : null;
  if (
    binding &&
    opportunity &&
    !opportunity.deletedAt &&
    !material.reuseOnly &&
    (originalEvent.intent !== 'review' || originalEvent.jobDetails)
  )
    refreshAutoOwnedFields(opportunity, binding, material.effectiveEvent, stamp, false);
  if (material.status !== 'ready')
    return {
      status: 'review',
      targetId: material.targetId,
      applicationStatus: material.status,
      reason: material.reason,
    };
  const event = material.effectiveEvent;
  if (material.reuseOnly) {
    if (!binding)
      data.sourceBindings.push(createBinding(batch, originalEvent, opportunity.id, stamp, false));
    return {
      status: 'recorded',
      evidenceStatus: 'review',
      targetId: opportunity.id,
      applicationStatus: 'no_effect',
      reason: material.reason,
      ...(!binding ? { linked: true } : {}),
    };
  }
  if (opportunity) {
    if (binding) {
      const latestSequence = Math.max(
        0,
        ...live(data.sourceEvents)
          .filter(
            (stored) => stored.opportunityId === opportunity.id && stored.status === 'recorded',
          )
          .map((stored) => Number(stored.sourceSequence) || 0),
      );
      refreshAutoOwnedFields(
        opportunity,
        binding,
        event,
        stamp,
        event.sourceSequence >= latestSequence,
        material.updateFields,
      );
      return { status: 'recorded', targetId: opportunity.id };
    }
    data.sourceBindings.push(createBinding(batch, originalEvent, opportunity.id, stamp, false));
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
  const created = createOpportunity(batch, event, stamp);
  if (data.opportunities.some((row) => row.id === created.id))
    return { status: 'review', targetId: created.id };
  data.opportunities.push(created);
  data.sourceBindings.push(createBinding(batch, event, created.id, stamp, true));
  return { status: 'recorded', targetId: created.id, added: true };
}

export function applyBossBatch(
  inputData,
  inputBatch,
  {
    workspaceSourceId,
    stamp,
    allowEventRestore = false,
    blockedOpportunityIds = [],
    attributionObservations = [],
    attributionContextEvents = [],
  },
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
  const attributionContext = buildBossAttributionContext(
    [
      ...data.sourceEvents,
      ...attributionContextEvents,
      ...batch.events.map((event) => ({ ...event, accountNamespace: batch.accountNamespace })),
    ],
    { observations: attributionObservations },
  );
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
      application &&
      (application.resolutionSource === 'user' ||
        isIgnoredObservation(application) ||
        (event.eventType === 'resume_observed' &&
          !['waiting', 'review'].includes(application.status)))
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
          : resolveEvent(data, batch, event, stamp);
    if (
      event.eventType === 'resume_observed' &&
      result.applicationStatus === 'no_effect' &&
      result.reason === 'observation_only' &&
      application?.status === 'review' &&
      (application.reason.startsWith('attribution_') ||
        ['job_identity_conflict', 'ambiguous_job_identity'].includes(application.reason))
    )
      Object.assign(result, {
        status: 'review',
        targetId: '',
        applicationStatus: 'review',
        reason: application.reason,
      });
    if (result.targetId && blockedOpportunityIds.includes(result.targetId))
      Object.assign(result, {
        status: 'review',
        targetId: '',
        applicationStatus: 'waiting',
        reason: 'entity_sync_conflict',
      });
    if (
      event.eventType !== 'resume_observed' &&
      event.jobDetails &&
      (!event.jobName.trim() || !event.company.trim())
    )
      result.evidenceStatus = 'review';
    if (event.eventType === 'resume_observed' && (!event.externalJobId || !event.canonicalUrl))
      result.evidenceStatus = 'review';
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
        : sourceEvent(batch, event, result.targetId, result.evidenceStatus || result.status, stamp);
    if (!stored || stored.deletedAt) data.sourceEvents.push(evidence);
    recordSourceApplication(data, evidence, result, stamp, { allowRestore: allowEventRestore });
  }
  return { data: validateData(data), counts };
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

export function platformObservationLabel(event, application = null) {
  if (!event) return '';
  if (event.eventType === 'resume_observed' && event.summary === 'resume_request_sent') {
    if (application?.reason === 'user_rejected_wrong_resume_semantics')
      return '平台卡片（发送误判已人工否决）';
    if (application?.reason === 'observation_only') return '旧平台卡片（仅存档，未确认发送）';
    if (application?.reason === 'resume_semantics_missing') return '旧平台卡片（发送依据不足）';
    if (['waiting', 'review'].includes(application?.status))
      return '简历相关观察（待核对，未确认发送）';
  }
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
