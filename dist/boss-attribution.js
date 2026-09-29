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
});
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
          (typeof value[key] !== 'string' || !/^[A-Za-z0-9_:-]{1,300}$/.test(value[key])),
      )
  ) {
    throw Object.assign(new Error('BOSS_ATTRIBUTION_EVIDENCE_INVALID'), { code: 'BATCH_INVALID' });
  }
  return structuredClone(value);
}

export function assessBossAttribution(accountNamespace, event) {
  const evidence = validateAttributionEvidence(event.attribution ?? null);
  const result = (status, reason) => ({
    status,
    reason,
    externalJobId: status === 'verified' ? event.externalJobId : '',
  });
  if (!evidence) return result('insufficient', 'attribution_evidence_missing');
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
  if (!evidence.messageJobId || !event.externalJobId)
    return result('insufficient', 'attribution_job_missing');
  return result('verified', 'attribution_verified');
}
