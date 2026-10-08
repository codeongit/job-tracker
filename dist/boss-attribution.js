import { BOSS_JOB_ID } from './boss-job-url.js';
import { bossFactId, hasBossFactIdentity } from './source-identity.js';
// Evidence is carried only by private snapshots/batches. Shared data stores the decision.
export const ATTRIBUTION_REASONS = Object.freeze({
  attribution_evidence_missing: '缺少独立归属依据',
  attribution_binding_conflict: '归属依据与观察身份不符',
  attribution_contact_conflict: '平台返回的联系人身份不符',
  attribution_participant_conflict: '消息参与者身份不符',
  attribution_job_conflict: '消息岗位与候选岗位不符',
  attribution_conversation_missing: '缺少独立会话身份',
  attribution_participants_missing: '缺少消息参与者身份',
  attribution_job_missing: '消息未提供岗位身份',
  attribution_message_multiple_jobs: '同一消息关联了不同候选岗位',
  attribution_conversation_job_changed: '会话曾关联不同岗位，消息缺少岗位身份',
});
export const BOSS_OBSERVATION_REASONS = Object.freeze({
  ...ATTRIBUTION_REASONS,
  resume_semantics_missing: '旧平台卡片缺少可核对的简历发送依据',
});

// Ephemeral candidate associations, never proof of message/job ownership.
export function buildBossAttributionContext(events, { observations = [] } = {}) {
  const messageJobs = new Map(),
    conversationJobs = new Map(),
    factObservations = new Map(),
    factAssociations = new Map();
  const add = (map, account, identity, job) => {
    if (!identity) return;
    const key = JSON.stringify([account, identity]);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(job);
  };
  for (const event of [...events, ...observations]) {
    if (event.deletedAt || (event.platform && event.platform !== 'boss') || !event.accountNamespace)
      continue;
    if (event.eventType === 'resume_observed' && hasBossFactIdentity(event)) {
      const factId = bossFactId(event);
      if (!factAssociations.has(factId)) factAssociations.set(factId, []);
      factAssociations.get(factId).push(event);
    }
    if (!event.externalJobId) continue;
    add(messageJobs, event.accountNamespace, event.messageId, event.externalJobId);
    add(conversationJobs, event.accountNamespace, event.conversationKey, event.externalJobId);
  }
  for (const event of observations) {
    if (
      event.deletedAt ||
      (event.platform && event.platform !== 'boss') ||
      event.eventType !== 'resume_observed' ||
      !hasBossFactIdentity(event)
    )
      continue;
    const factId = bossFactId(event);
    if (!factObservations.has(factId)) factObservations.set(factId, []);
    factObservations.get(factId).push(event);
  }
  return { messageJobs, conversationJobs, factObservations, factAssociations };
}
const fields = [
  'version',
  'source',
  'accountNamespace',
  'conversationKey',
  'messageId',
  'requestedBossId',
  'responseFriendId',
  'responseFriendSource',
  'responseBossId',
  'selfId',
  'senderId',
  'recipientId',
  'messageJobId',
];
export function validateAttributionEvidence(value) {
  if (value === null) return null;
  if (
    !value ||
    Array.isArray(value) ||
    value.version !== 1 ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    !['history', 'dom', 'list'].includes(value.source) ||
    fields
      .filter((key) => !['version', 'source'].includes(key))
      .some(
        (key) =>
          value[key] !== null &&
          (typeof value[key] !== 'string' ||
            !(key.endsWith('JobId') ? BOSS_JOB_ID : /^[A-Za-z0-9_:-]{1,300}$/).test(value[key])),
      )
  ) {
    throw Object.assign(new Error('BOSS_ATTRIBUTION_EVIDENCE_INVALID'), { code: 'BATCH_INVALID' });
  }
  return structuredClone(value);
}

function assessObservation(accountNamespace, event, context = null) {
  const evidence = validateAttributionEvidence(event.attribution ?? null);
  const result = (status, reason) => ({
    status,
    reason,
    externalJobId: status === 'verified' ? event.externalJobId : '',
  });
  if (context?.messageJobs.get(JSON.stringify([accountNamespace, event.messageId]))?.size > 1)
    return result('conflict', 'attribution_message_multiple_jobs');
  const changedJob =
    context?.conversationJobs.get(JSON.stringify([accountNamespace, event.conversationKey]))?.size >
    1;
  if (!evidence)
    return result(
      'insufficient',
      changedJob ? 'attribution_conversation_job_changed' : 'attribution_evidence_missing',
    );
  if (
    evidence.accountNamespace !== accountNamespace ||
    evidence.conversationKey !== event.conversationKey ||
    evidence.messageId !== event.messageId
  )
    return result('conflict', 'attribution_binding_conflict');
  if (
    (evidence.responseFriendId && evidence.responseFriendId !== event.friendId) ||
    (evidence.responseFriendSource && evidence.responseFriendSource !== event.friendSource) ||
    (evidence.responseBossId &&
      evidence.requestedBossId &&
      evidence.responseBossId !== evidence.requestedBossId)
  )
    return result('conflict', 'attribution_contact_conflict');
  if (evidence.messageJobId && event.externalJobId && evidence.messageJobId !== event.externalJobId)
    return result('conflict', 'attribution_job_conflict');
  const participants = [evidence.senderId, evidence.recipientId];
  const expected = [evidence.selfId, evidence.responseBossId];
  if (expected.every(Boolean) && participants.some((id) => id && !expected.includes(id)))
    return result('conflict', 'attribution_participant_conflict');
  if (changedJob && !evidence.messageJobId)
    return result('insufficient', 'attribution_conversation_job_changed');
  if (
    !evidence.responseFriendId ||
    !evidence.responseFriendSource ||
    !evidence.responseBossId ||
    !evidence.requestedBossId
  )
    return result('insufficient', 'attribution_conversation_missing');
  if (
    !evidence.selfId ||
    !participants.every(Boolean) ||
    new Set(participants).size !== 2 ||
    !expected.every((id) => participants.includes(id))
  )
    return result('insufficient', 'attribution_participants_missing');
  if (!event.externalJobId) return result('insufficient', 'attribution_job_missing');
  return result(
    'verified',
    evidence.messageJobId ? 'attribution_verified' : 'attribution_conversation_association',
  );
}

const insufficientPriority = Object.freeze({
  attribution_evidence_missing: 0,
  attribution_conversation_missing: 1,
  attribution_participants_missing: 2,
  attribution_job_missing: 3,
  attribution_conversation_job_changed: 4,
});
const conflictPriority = Object.freeze({
  attribution_message_multiple_jobs: 0,
  attribution_binding_conflict: 1,
  attribution_contact_conflict: 2,
  attribution_participant_conflict: 3,
  attribution_job_conflict: 4,
});

// Each observation retains its own identity chain. Values from different samples
// are never combined to manufacture one complete chain.
function sampleConflict(observations, associations = []) {
  const differs = (values) => new Set(values.filter(Boolean)).size > 1;
  const rawObservations = [...observations, ...associations];
  const evidences = observations.map((event) =>
    validateAttributionEvidence(event.attribution ?? null),
  );
  if (
    ['friendId', 'friendSource', 'uniqueId'].some((field) =>
      differs(rawObservations.map((event) => event[field])),
    ) ||
    ['requestedBossId', 'responseFriendId', 'responseFriendSource', 'responseBossId'].some(
      (field) => differs(evidences.map((evidence) => evidence?.[field])),
    )
  )
    return 'attribution_contact_conflict';
  if (
    ['selfId', 'senderId', 'recipientId'].some((field) =>
      differs(evidences.map((evidence) => evidence?.[field])),
    )
  )
    return 'attribution_participant_conflict';
  if (
    differs(rawObservations.map((event) => event.externalJobId)) ||
    differs(evidences.map((evidence) => evidence?.messageJobId))
  )
    return 'attribution_job_conflict';
  return '';
}

export function assessBossAttribution(accountNamespace, event, context = null) {
  const identity = { ...event, platform: 'boss', accountNamespace };
  const candidates = hasBossFactIdentity(identity)
    ? context?.factObservations?.get(bossFactId(identity))
    : null;
  if (!candidates?.length) return assessObservation(accountNamespace, event, context);
  const observations = [...candidates, identity];
  const results = observations.map((candidate) =>
    assessObservation(accountNamespace, candidate, context),
  );
  const contradiction = sampleConflict(
    observations,
    context.factAssociations?.get(bossFactId(identity)),
  );
  if (contradiction) results.push({ status: 'conflict', reason: contradiction, externalJobId: '' });
  const conflicts = results.filter((result) => result.status === 'conflict');
  if (conflicts.length)
    return conflicts.sort(
      (left, right) =>
        conflictPriority[left.reason] - conflictPriority[right.reason] ||
        left.reason.localeCompare(right.reason),
    )[0];
  const verified = results.filter((result) => result.status === 'verified');
  if (verified.length)
    return verified.sort(
      (left, right) =>
        Number(right.reason === 'attribution_verified') -
          Number(left.reason === 'attribution_verified') || left.reason.localeCompare(right.reason),
    )[0];
  return results.sort(
    (left, right) =>
      insufficientPriority[right.reason] - insufficientPriority[left.reason] ||
      left.reason.localeCompare(right.reason),
  )[0];
}

// Query current decisions, never historical diagnostic-file counts.
export function bossAttributionSummary(data) {
  const result = { insufficient: 0, conflict: 0, semantic: 0, collection: 0, items: [] };
  const seen = new Set();
  for (const application of data?.sourceApplications || []) {
    if (
      application.deletedAt ||
      !['waiting', 'review'].includes(application.status) ||
      !Object.hasOwn(BOSS_OBSERVATION_REASONS, application.reason) ||
      seen.has(application.factId)
    )
      continue;
    seen.add(application.factId);
    const event = (data.sourceEvents || []).find(
      (event) => !event.deletedAt && event.factId === application.factId,
    );
    const category =
      application.status === 'review'
        ? 'conflict'
        : application.reason === 'resume_semantics_missing'
          ? 'semantic'
          : 'insufficient';
    result[category]++;
    result.items.push({
      id: application.factId,
      category,
      reason: application.reason,
      label: BOSS_OBSERVATION_REASONS[application.reason],
      candidate: event?.jobName || '',
      candidateCompany: event?.company || '',
    });
  }
  for (const event of data?.sourceEvents || []) {
    if (
      event.deletedAt ||
      event.eventType !== 'resume_observed' ||
      event.messageId ||
      seen.has(event.id)
    )
      continue;
    seen.add(event.id);
    result.collection++;
    result.items.push({
      id: event.id,
      category: 'collection',
      reason: 'missing_message_identity',
      label: '缺少稳定消息身份',
      candidate: '',
      candidateCompany: '',
    });
  }
  result.items.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
