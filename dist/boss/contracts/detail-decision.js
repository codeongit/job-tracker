import { BOSS_JOB_ID } from './job-url.js';

export const DETAIL_ACCOUNT = /^boss-geek:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
export const detailDecisionError = (code) => Object.assign(new Error(code), { code });
// Only these rejections establish that this requested decision was not written.
// Persistence failures and a faulted writer can follow a completed rename.
export const DETAIL_DECISION_NOT_COMMITTED_CODES = Object.freeze([
  'DETAIL_DECISION_COMMAND_INVALID',
  'DETAIL_DECISION_COMMAND_CONFLICT',
  'DETAIL_DECISION_REVISION_CONFLICT',
  'DETAIL_TASK_CHANGED',
  'DETAIL_WORKSPACE_CHANGED',
  'BOSS_RUNTIME_TOO_LARGE',
  'DETAIL_POLICY_INVALID',
]);
export function exactDetailKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}
export function normalizeDetailDecisionCommand(value) {
  const keys = [
    'version',
    'commandId',
    'expectedRevision',
    'accountNamespace',
    'jobId',
    'taskVersion',
    'reason',
    'opportunityId',
    'workspaceRevision',
  ];
  if (
    !exactDetailKeys(value, keys) ||
    value.version !== 1 ||
    !UUID.test(value.commandId ?? '') ||
    !['commandId', 'accountNamespace', 'jobId', 'taskVersion', 'reason', 'opportunityId'].every(
      (key) => typeof value[key] === 'string',
    ) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    !DETAIL_ACCOUNT.test(value.accountNamespace ?? '') ||
    !BOSS_JOB_ID.test(value.jobId ?? '') ||
    !HASH.test(value.taskVersion ?? '') ||
    !['manual_details', 'not_needed', 'reopen'].includes(value.reason) ||
    (value.reason === 'manual_details'
      ? !value.opportunityId ||
        !Number.isSafeInteger(value.workspaceRevision) ||
        value.workspaceRevision < 1
      : value.opportunityId !== '' || value.workspaceRevision !== null)
  )
    throw detailDecisionError('DETAIL_DECISION_COMMAND_INVALID');
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
export function normalizeExpectedDetailTask(value) {
  if (
    !exactDetailKeys(value, ['accountNamespace', 'jobId', 'taskVersion']) ||
    !['accountNamespace', 'jobId', 'taskVersion'].every((key) => typeof value[key] === 'string') ||
    !DETAIL_ACCOUNT.test(value.accountNamespace ?? '') ||
    !BOSS_JOB_ID.test(value.jobId ?? '') ||
    !HASH.test(value.taskVersion ?? '')
  )
    throw detailDecisionError('DETAIL_DECISION_COMMAND_INVALID');
  return {
    accountNamespace: value.accountNamespace,
    jobId: value.jobId,
    taskVersion: value.taskVersion,
  };
}
