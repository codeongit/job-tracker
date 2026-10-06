// One parser shared by capture adapters, delivery and business validation.
export const BOSS_JOB_ID = /^[A-Za-z0-9_~\-]{1,300}$/;
export function parseBossJobUrl(value, { relative = false } = {}) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  const pattern = relative
    ? /^(?:https:\/\/www\.zhipin\.com)?(\/job_detail\/([A-Za-z0-9_~\-]{1,300})\.html)(?:[?#].*)?$/
    : /^https:\/\/www\.zhipin\.com(\/job_detail\/([A-Za-z0-9_~\-]{1,300})\.html)(?:[?#].*)?$/;
  const match = pattern.exec(value);
  if (!match || /[\\\u0000-\u0020\u007f]/.test(value)) return null;
  return { jobId: match[2], canonicalUrl: `https://www.zhipin.com${match[1]}` };
}
export function isCanonicalBossJobUrl(value, jobId) {
  const parsed = parseBossJobUrl(value);
  return Boolean(parsed && parsed.canonicalUrl === value && (!jobId || parsed.jobId === jobId));
}
