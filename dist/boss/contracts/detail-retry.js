import { BOSS_JOB_ID } from './job-url.js';

// A code alone cannot establish this: later collector stages can return the
// same code. The service must also attest retryAttempted: false at admission.
export const DETAIL_RETRY_NOT_STARTED_CODES = Object.freeze([
  'DETAIL_TASK_CHANGED',
  'DETAIL_ACCOUNT_CHANGED',
  'DETAIL_TASK_MANUALLY_STOPPED',
  'DETAIL_RETRY_TARGETS_INVALID',
  'DETAIL_RETRY_REQUIRES_STOPPED',
  'DETAIL_RETRY_BUDGET_UNAVAILABLE',
  'BOSS_CYCLE_IN_PROGRESS',
  'BOSS_INTEGRATION_PAUSED',
  'DETAIL_DECISION_COMMAND_INVALID',
]);

export function normalizeDetailRetryJobIds(values) {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > 20 ||
    Array.from(values).some((value) => typeof value !== 'string' || !BOSS_JOB_ID.test(value)) ||
    new Set(values).size !== values.length
  )
    throw Object.assign(new Error('DETAIL_RETRY_TARGETS_INVALID'), {
      code: 'DETAIL_RETRY_TARGETS_INVALID',
    });
  return [...values];
}
