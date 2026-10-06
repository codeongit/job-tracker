// Availability is display metadata, never message attribution evidence.
export const PLATFORM_JOB_LABELS = {
  unknown: '平台状态未知',
  open: '平台招聘中',
  closed: '平台职位已关闭',
};
const key = (account, jobId, url) => JSON.stringify([account, jobId, url]);
export function buildBossPlatformStates(data) {
  const rows = new Map();
  const add = (account, jobId, url, row) => {
    if (!account || !jobId || !url || !row?.platformJobState || row.platformJobState === 'unknown')
      return;
    const identity = key(account, jobId, url);
    const states = rows.get(identity) || [];
    states.push(row);
    rows.set(identity, states);
  };
  const applications = new Map(
    (data.sourceApplications || []).filter((row) => !row.deletedAt).map((row) => [row.factId, row]),
  );
  for (const event of data.sourceEvents || []) {
    if (!event.deletedAt)
      add(
        event.accountNamespace,
        event.externalJobId,
        event.canonicalUrl,
        applications.get(event.factId),
      );
  }
  const accounts = new Map(
    (data.sourceFacts || [])
      .filter((row) => !row.deletedAt)
      .map((row) => [row.id, row.accountNamespace]),
  );
  for (const application of applications.values()) {
    if (application.resolutionSource === 'user')
      add(
        accounts.get(application.factId),
        application.resolvedJobId,
        application.resolvedJobUrl,
        application,
      );
  }
  const opportunities = new Map(
    (data.opportunities || []).filter((row) => !row.deletedAt).map((row) => [row.id, row]),
  );
  for (const binding of data.sourceBindings || []) {
    if (!binding.deletedAt && binding.kind === 'opportunity')
      add(
        binding.accountNamespace,
        binding.externalJobId,
        binding.canonicalUrl,
        opportunities.get(binding.opportunityId),
      );
  }
  const result = new Map();
  for (const [identity, values] of rows) {
    const states = new Set(values.map((row) => row.platformJobState));
    const row = values[0];
    result.set(
      identity,
      states.size > 1
        ? { state: 'conflict' }
        : {
            state: row.platformJobState,
            source: row.platformJobStateSource,
            at: row.platformJobStateAt,
          },
    );
  }
  return result;
}
export function bossPlatformState(
  data,
  accountNamespace,
  externalJobId,
  canonicalUrl,
  context = buildBossPlatformStates(data),
) {
  return context.get(key(accountNamespace, externalJobId, canonicalUrl)) || { state: 'unknown' };
}
