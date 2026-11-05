import { BOSS_JOB_ID } from './job-url.js';

export const DETAIL_POLICY_MAX_BYTES = 64000;
const fail = () => {
  throw Object.assign(new Error('DETAIL_POLICY_INVALID'), { code: 'DETAIL_POLICY_INVALID' });
};

export function normalizeExcludedDetailJobIds(value) {
  if (!Array.isArray(value) || value.length > 1000) fail();
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !BOSS_JOB_ID.test(id) || seen.has(id)) fail();
    seen.add(id);
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > DETAIL_POLICY_MAX_BYTES) fail();
  return [...value];
}

export function normalizeDetailPolicy(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['accountNamespace', 'excludedJobIds']) ||
    typeof value.accountNamespace !== 'string' ||
    !/^boss-geek:[a-f0-9]{64}$/.test(value.accountNamespace ?? '')
  )
    fail();
  const excludedJobIds = normalizeExcludedDetailJobIds(value.excludedJobIds);
  if (!excludedJobIds.length) fail();
  const result = { accountNamespace: value.accountNamespace, excludedJobIds };
  if (new TextEncoder().encode(JSON.stringify(result)).length > DETAIL_POLICY_MAX_BYTES) fail();
  return result;
}
