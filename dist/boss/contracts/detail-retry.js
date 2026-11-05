import { BOSS_JOB_ID } from './job-url.js';

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
