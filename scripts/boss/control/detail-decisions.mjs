import { createHash } from 'node:crypto';
import { BOSS_JOB_ID } from '../../../dist/boss/contracts/job-url.js';
import {
  DETAIL_ACCOUNT,
  exactDetailKeys,
  detailDecisionError,
  normalizeDetailDecisionCommand,
} from '../../../dist/boss/contracts/detail-decision.js';
import { normalizeDetailPolicy } from '../../../dist/boss/contracts/detail-policy.js';

export const emptyDetailDecisions = () => ({ revision: 0, records: [], commands: [] });
const key = (row) => `${row.accountNamespace}:${row.jobId}`;
export const detailCommandDigest = (command) =>
  createHash('sha256')
    .update(JSON.stringify(normalizeDetailDecisionCommand(command)))
    .digest('hex');
function validateRecord(row) {
  if (
    !exactDetailKeys(row, [
      'accountNamespace',
      'jobId',
      'status',
      'reason',
      'at',
      'opportunityId',
      'workspaceRevision',
    ]) ||
    !DETAIL_ACCOUNT.test(row.accountNamespace ?? '') ||
    !BOSS_JOB_ID.test(row.jobId ?? '') ||
    !['stopped', 'reopened'].includes(row.status) ||
    !['manual_details', 'not_needed', 'reopen'].includes(row.reason) ||
    (row.status === 'reopened') !== (row.reason === 'reopen') ||
    typeof row.at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.at) ||
    !Number.isFinite(Date.parse(row.at))
  )
    throw detailDecisionError('DETAIL_DECISIONS_INVALID');
  normalizeDetailDecisionCommand({
    version: 1,
    commandId: '00000000-0000-0000-0000-000000000000',
    expectedRevision: 0,
    taskVersion: '0'.repeat(64),
    ...Object.fromEntries(
      ['accountNamespace', 'jobId', 'reason', 'opportunityId', 'workspaceRevision'].map((k) => [
        k,
        row[k],
      ]),
    ),
  });
}
export function normalizeDetailDecisions(value) {
  if (
    !exactDetailKeys(value, ['revision', 'records', 'commands']) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.records) ||
    value.records.length > 1000 ||
    !Array.isArray(value.commands) ||
    value.commands.length !== value.revision
  )
    throw detailDecisionError('DETAIL_DECISIONS_INVALID');
  const latest = new Map(),
    ids = new Set();
  for (const [index, entry] of value.commands.entries()) {
    if (
      !exactDetailKeys(entry, ['commandId', 'digest', 'revision', 'record']) ||
      typeof entry.commandId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.commandId) ||
      ids.has(entry.commandId) ||
      typeof entry.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.digest) ||
      entry.revision !== index + 1
    )
      throw detailDecisionError('DETAIL_DECISIONS_INVALID');
    validateRecord(entry.record);
    ids.add(entry.commandId);
    latest.set(key(entry.record), entry.record);
  }
  const records = new Set();
  for (const row of value.records) {
    validateRecord(row);
    if (records.has(key(row)) || JSON.stringify(row) !== JSON.stringify(latest.get(key(row))))
      throw detailDecisionError('DETAIL_DECISIONS_INVALID');
    records.add(key(row));
  }
  if (records.size !== latest.size) throw detailDecisionError('DETAIL_DECISIONS_INVALID');
  for (const accountNamespace of new Set(value.records.map((row) => row.accountNamespace))) {
    const excludedJobIds = stoppedDetailJobIds(value, accountNamespace);
    if (excludedJobIds.length) normalizeDetailPolicy({ accountNamespace, excludedJobIds });
  }
  return structuredClone(value);
}
export function appendDetailDecision(input, command, at) {
  const value = normalizeDetailDecisions(input);
  const record = {
    accountNamespace: command.accountNamespace,
    jobId: command.jobId,
    status: command.reason === 'reopen' ? 'reopened' : 'stopped',
    reason: command.reason,
    at,
    opportunityId: command.opportunityId,
    workspaceRevision: command.workspaceRevision,
  };
  const revision = value.revision + 1;
  return normalizeDetailDecisions({
    revision,
    records: [...value.records.filter((row) => key(row) !== key(record)), record],
    commands: [
      ...value.commands,
      { commandId: command.commandId, digest: detailCommandDigest(command), revision, record },
    ],
  });
}
export function stoppedDetailJobIds(value, accountNamespace) {
  return value.records
    .filter((row) => row.accountNamespace === accountNamespace && row.status === 'stopped')
    .map((row) => row.jobId)
    .sort();
}
