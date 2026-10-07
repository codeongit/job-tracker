import { bossPlatformState, buildBossPlatformStates } from './platform-job-state.js';
export { PLATFORM_JOB_LABELS } from './platform-job-state.js';
import { clone, live, validateData } from './model.js';
import { BOSS_JOB_ID, isCanonicalBossJobUrl, parseBossJobUrl } from './boss-job-url.js';
import { sourceApplicationForEvent, SOURCE_RULE_VERSION } from './source-ledger.js';
import { bossFactId, hasBossFactIdentity } from './source-identity.js';

export const USER_JOB_DETAILS_REASON = 'user_confirmed_job_details';

const unsafe = () => {
  const error = new Error('观察或岗位已变化，请刷新后核对。');
  error.code = 'BOSS_DETAILS_UNSAFE';
  throw error;
};
function accountBound(data, accountNamespace, workspaceSourceId) {
  const rows = live(data.sourceBindings).filter(
    (row) =>
      row.kind === 'account' &&
      row.accountNamespace === accountNamespace &&
      row.platform === 'boss',
  );
  return rows.length === 1 && rows[0].workspaceSourceId === workspaceSourceId;
}
function selectedRows(data, applicationIds) {
  if (
    !Array.isArray(applicationIds) ||
    !applicationIds.length ||
    applicationIds.length > 100 ||
    new Set(applicationIds).size !== applicationIds.length ||
    applicationIds.some((id) => typeof id !== 'string' || !id)
  )
    unsafe();
  const selectedIds = new Set(applicationIds),
    applications = new Map(),
    applicationsByFact = new Map(),
    facts = new Map(live(data.sourceFacts).map((row) => [row.id, row])),
    eventsByApplication = new Map();
  for (const application of live(data.sourceApplications)) {
    applications.set(application.id, application);
    if (!applicationsByFact.has(application.factId))
      applicationsByFact.set(application.factId, application);
  }
  // Match the legacy/semantic lookup without scanning every application per event.
  for (const event of live(data.sourceEvents)) {
    const factId = event.factId || (hasBossFactIdentity(event) ? bossFactId(event) : '');
    const application =
      applicationsByFact.get(factId) ||
      applicationsByFact.get(event.id.replace(/^boss-event-/, 'boss-fact-'));
    if (!application || !selectedIds.has(application.id)) continue;
    const events = eventsByApplication.get(application.id) || [];
    events.push(event);
    eventsByApplication.set(application.id, events);
  }
  return applicationIds.map((id) => {
    const application = applications.get(id);
    const fact = application && facts.get(application.factId);
    const events = eventsByApplication.get(id);
    if (!application || !fact || !events?.length || fact.platform !== 'boss') unsafe();
    return { application, fact, events };
  });
}
function checkBossJobDetails(
  data,
  {
    applicationIds,
    opportunityId,
    externalJobId,
    canonicalUrl,
    retiredOpportunityIds = [],
    workspaceSourceId,
  },
) {
  if (
    !BOSS_JOB_ID.test(externalJobId) ||
    !isCanonicalBossJobUrl(canonicalUrl, externalJobId) ||
    !Array.isArray(retiredOpportunityIds) ||
    retiredOpportunityIds.length > 100 ||
    retiredOpportunityIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(retiredOpportunityIds).size !== retiredOpportunityIds.length
  )
    unsafe();
  const opportunity = live(data.opportunities).find((row) => row.id === opportunityId);
  const matching = data.opportunities.filter(
    (row) => row.externalId === externalJobId || parseBossJobUrl(row.url)?.jobId === externalJobId,
  );
  // Only an explicit manual command can distinguish a live target from deleted duplicates.
  const retired = matching.filter((row) => row.id !== opportunityId);
  if (
    !opportunity ||
    retired.length !== retiredOpportunityIds.length ||
    retired.some(
      (row) =>
        !row.deletedAt ||
        !retiredOpportunityIds.includes(row.id) ||
        (row.externalId && row.externalId !== externalJobId) ||
        parseBossJobUrl(row.url)?.canonicalUrl !== canonicalUrl ||
        !/^boss(?:直聘)?$/i.test((row.platform || '').replace(/\s/g, '')),
    ) ||
    (opportunity.externalId && opportunity.externalId !== externalJobId) ||
    parseBossJobUrl(opportunity.url)?.canonicalUrl !== canonicalUrl ||
    !/^boss(?:直聘)?$/i.test((opportunity.platform || '').replace(/\s/g, ''))
  )
    unsafe();
  const selected = selectedRows(data, applicationIds);
  const accounts = new Set(selected.map((row) => row.fact.accountNamespace));
  if (accounts.size !== 1) unsafe();
  const account = [...accounts][0];
  if (
    !accountBound(data, account, workspaceSourceId) ||
    live(data.sourceBindings).some(
      (row) =>
        row.kind === 'opportunity' &&
        (retiredOpportunityIds.includes(row.opportunityId) ||
          (row.opportunityId === opportunityId &&
            (row.accountNamespace !== account ||
              row.externalJobId !== externalJobId ||
              row.canonicalUrl !== canonicalUrl)) ||
          (row.accountNamespace === account &&
            row.externalJobId === externalJobId &&
            row.opportunityId !== opportunityId)),
    )
  )
    unsafe();
  for (const { application, fact, events } of selected) {
    if (
      !['waiting', 'review'].includes(application.status) ||
      !['missing_job_details', 'identity_conflict'].includes(application.reason) ||
      events.some(
        (event) =>
          event.eventType !== 'conversation_observed' ||
          event.accountNamespace !== account ||
          (event.externalJobId && event.externalJobId !== externalJobId) ||
          (event.canonicalUrl && event.canonicalUrl !== canonicalUrl),
      ) ||
      (fact.externalJobId && fact.externalJobId !== externalJobId)
    )
      unsafe();
    // Company differences may be recruiter/employer differences; message/job identity conflicts may not.
    const messageJobs = new Set(
      live(data.sourceEvents)
        .filter(
          (event) =>
            event.accountNamespace === account &&
            event.messageId &&
            event.messageId === fact.messageId,
        )
        .map((event) => event.externalJobId)
        .filter(Boolean),
    );
    if (messageJobs.size > 1 || (messageJobs.size === 1 && !messageJobs.has(externalJobId)))
      unsafe();
  }
  return { selected, opportunity };
}

export function resolveBossJobDetails(input, options) {
  const data = clone(input);
  const { selected, opportunity } = checkBossJobDetails(data, options);
  const { opportunityId, externalJobId, canonicalUrl, stamp } = options;
  for (const { application } of selected) {
    Object.assign(application, {
      opportunityId,
      resolutionSource: 'user',
      resolvedJobId: externalJobId,
      resolvedJobUrl: canonicalUrl,
      status: 'no_effect',
      reason: USER_JOB_DETAILS_REASON,
      ruleVersion: SOURCE_RULE_VERSION,
      appliedAt: '',
      updatedAt: stamp,
    });
  }
  if (!opportunity.externalId)
    Object.assign(opportunity, { externalId: externalJobId, updatedAt: stamp });
  return validateData(data);
}

// A read-only preflight. Confirmation still rechecks the current service workspace.
export function bossJobDetailsConfirmation(data, applicationIds, workspaceSourceId) {
  const result = {
    allowed: false,
    reason: '',
    reasonCode: '',
    applicationIds: [],
    excludedApplicationIds: [],
    target: null,
    externalJobId: '',
    canonicalUrl: '',
    messageCount: 0,
    observationCount: 0,
  };
  const blocked = (reasonCode, reason) => ({ ...result, reasonCode, reason });
  let rows;
  try {
    rows = selectedRows(data, applicationIds);
  } catch {
    return blocked('changed', '观察已变化或缺少来源材料，请刷新后核对。');
  }
  const selected = rows.filter(
    ({ application, events }) =>
      ['waiting', 'review'].includes(application.status) &&
      ['missing_job_details', 'identity_conflict'].includes(application.reason) &&
      events.every((event) => event.eventType === 'conversation_observed'),
  );
  result.applicationIds = selected.map(({ application }) => application.id);
  result.excludedApplicationIds = applicationIds.filter(
    (id) => !result.applicationIds.includes(id),
  );
  result.observationCount = selected.length;
  result.messageCount = new Set(
    selected.map(({ application, fact }) =>
      fact.messageId && fact.accountNamespace && fact.conversationKey
        ? JSON.stringify([fact.accountNamespace, fact.conversationKey, fact.messageId])
        : application.id,
    ),
  ).size;
  if (!selected.length)
    return blocked('unsupported', '这些观察不能通过岗位资料确认处理；简历归属需单独核对。');
  const accounts = new Set(selected.map(({ fact }) => fact.accountNamespace));
  if (accounts.size !== 1)
    return blocked('account_conflict', '所选观察来自不同 BOSS 账号，不能一起确认。');
  const account = [...accounts][0];
  if (!accountBound(data, account, workspaceSourceId))
    return blocked('account_unbound', 'BOSS 账号尚未唯一绑定当前工作区，请先核对账号绑定。');
  const jobIds = new Set(),
    urls = new Set();
  for (const { fact, events } of selected) {
    if (fact.externalJobId) jobIds.add(fact.externalJobId);
    let hasJobLink = false;
    for (const event of events) {
      if (event.externalJobId) jobIds.add(event.externalJobId);
      if (!event.canonicalUrl) continue;
      const identity = parseBossJobUrl(event.canonicalUrl);
      if (!identity || identity.canonicalUrl !== event.canonicalUrl)
        return blocked('identity_conflict', '观察的岗位链接无效，需先核对来源资料。');
      jobIds.add(identity.jobId);
      urls.add(identity.canonicalUrl);
      hasJobLink = true;
    }
    if (!hasJobLink)
      return blocked('identity_missing', '观察尚无规范岗位链接，不能仅凭公司名称确认。');
  }
  if (jobIds.size !== 1 || urls.size !== 1)
    return blocked('identity_conflict', '所选观察的岗位 ID 或链接互相矛盾，需先核对。');
  const externalJobId = [...jobIds][0],
    canonicalUrl = [...urls][0];
  const matching = data.opportunities.filter(
    (row) => row.externalId === externalJobId || parseBossJobUrl(row.url)?.jobId === externalJobId,
  );
  if (!matching.length)
    return blocked('target_missing', '本机尚无这个岗位 ID 和链接对应的岗位，请先补齐岗位资料。');
  if (matching.some((row) => row.deletedAt))
    return blocked('deleted_match', '同一平台职位存在已删除记录，需要定点核对，暂不能在此确认。');
  if (matching.length !== 1)
    return blocked('multiple_targets', '同一平台职位对应多个本机岗位，需要先核对重复记录。');
  const opportunity = matching[0];
  if (
    (opportunity.externalId && opportunity.externalId !== externalJobId) ||
    parseBossJobUrl(opportunity.url)?.canonicalUrl !== canonicalUrl ||
    !/^boss(?:直聘)?$/i.test((opportunity.platform || '').replace(/\s/g, ''))
  )
    return blocked('target_identity_conflict', '本机岗位的平台、岗位 ID 或链接不一致，请先核对。');
  const bindings = live(data.sourceBindings).filter(
    (row) =>
      row.kind === 'opportunity' &&
      row.accountNamespace === account &&
      row.externalJobId === externalJobId,
  );
  if (
    bindings.length > 1 ||
    bindings.some(
      (row) => row.opportunityId !== opportunity.id || row.canonicalUrl !== canonicalUrl,
    ) ||
    live(data.sourceBindings).some(
      (row) =>
        row.kind === 'opportunity' &&
        row.opportunityId === opportunity.id &&
        (row.accountNamespace !== account ||
          row.externalJobId !== externalJobId ||
          row.canonicalUrl !== canonicalUrl),
    )
  )
    return blocked('binding_conflict', '岗位来源绑定存在不同账号、目标或链接，需先核对绑定。');
  try {
    checkBossJobDetails(data, {
      applicationIds: result.applicationIds,
      opportunityId: opportunity.id,
      externalJobId,
      canonicalUrl,
      workspaceSourceId,
    });
  } catch {
    return blocked(
      'observation_conflict',
      '普通观察包含跨岗位或其他身份矛盾，不能用资料确认解除。',
    );
  }
  return {
    ...result,
    allowed: true,
    target: { opportunityId: opportunity.id, company: opportunity.company, role: opportunity.role },
    externalJobId,
    canonicalUrl,
  };
}

export function setBossJobState(
  input,
  { applicationIds, externalJobId, canonicalUrl, state, workspaceSourceId, stamp },
) {
  const data = clone(input);
  if (
    !['unknown', 'open', 'closed'].includes(state) ||
    !BOSS_JOB_ID.test(externalJobId) ||
    !isCanonicalBossJobUrl(canonicalUrl, externalJobId)
  )
    unsafe();
  const selected = selectedRows(data, applicationIds);
  const accounts = new Set(selected.map((row) => row.fact.accountNamespace));
  if (accounts.size !== 1) unsafe();
  const account = [...accounts][0];
  if (
    !accountBound(data, account, workspaceSourceId) ||
    selected.some((row) =>
      row.events.some(
        (event) =>
          event.accountNamespace !== account ||
          event.externalJobId !== externalJobId ||
          event.canonicalUrl !== canonicalUrl,
      ),
    )
  )
    unsafe();
  const fields = {
    platformJobState: state,
    platformJobStateSource: state === 'unknown' ? '' : 'user',
    platformJobStateAt: state === 'unknown' ? '' : stamp,
  };
  for (const event of live(data.sourceEvents).filter(
    (row) =>
      row.accountNamespace === account &&
      row.externalJobId === externalJobId &&
      row.canonicalUrl === canonicalUrl,
  )) {
    const application = sourceApplicationForEvent(data, event);
    if (application) Object.assign(application, fields);
  }
  const targets = data.opportunities.filter(
    (row) => row.externalId === externalJobId || parseBossJobUrl(row.url)?.jobId === externalJobId,
  );
  if (
    targets.length > 1 ||
    targets.some(
      (row) =>
        row.deletedAt ||
        (row.externalId && row.externalId !== externalJobId) ||
        parseBossJobUrl(row.url)?.canonicalUrl !== canonicalUrl,
    ) ||
    live(data.sourceBindings).some(
      (row) =>
        row.kind === 'opportunity' &&
        targets.some((target) => target.id === row.opportunityId) &&
        row.accountNamespace !== account,
    )
  )
    unsafe();
  for (const row of targets) Object.assign(row, fields, { updatedAt: stamp });
  return validateData(data);
}

// Called by both business save paths. Metadata propagation never confirms attribution.
export function propagatePlatformJobState(before, next, stamp) {
  for (const opportunity of live(next.opportunities)) {
    const old = before.opportunities.find((row) => row.id === opportunity.id);
    if ((old?.platformJobState || 'unknown') === (opportunity.platformJobState || 'unknown'))
      continue;
    const state = opportunity.platformJobState || 'unknown';
    const fields = {
      platformJobState: state,
      platformJobStateSource: state === 'unknown' ? '' : 'user',
      platformJobStateAt: state === 'unknown' ? '' : stamp,
    };
    Object.assign(opportunity, fields);
    const bindings = live(next.sourceBindings).filter(
      (row) =>
        row.kind === 'opportunity' &&
        row.opportunityId === opportunity.id &&
        row.externalJobId === opportunity.externalId &&
        row.canonicalUrl === parseBossJobUrl(opportunity.url)?.canonicalUrl,
    );
    for (const event of live(next.sourceEvents)) {
      const application = sourceApplicationForEvent(next, event);
      const identityMatches = bindings.some(
        (binding) =>
          binding.accountNamespace === event.accountNamespace &&
          binding.externalJobId === event.externalJobId &&
          binding.canonicalUrl === event.canonicalUrl,
      );
      const manualMatches =
        application?.resolutionSource === 'user' &&
        application.opportunityId === opportunity.id &&
        application.resolvedJobId === opportunity.externalId &&
        application.resolvedJobUrl === parseBossJobUrl(opportunity.url)?.canonicalUrl;
      if (application && (identityMatches || manualMatches)) Object.assign(application, fields);
    }
  }
  return next;
}

export function groupBossObservations(items, data) {
  const groups = new Map();
  const platformStates = data ? buildBossPlatformStates(data) : new Map();
  for (const item of items || []) {
    const application = data?.sourceApplications?.find(
      (row) => !row.deletedAt && row.id === item.applicationId,
    );
    const event =
      application &&
      live(data.sourceEvents || []).find(
        (row) => sourceApplicationForEvent(data, row)?.id === application.id,
      );
    const key =
      event?.messageId && event.accountNamespace && event.conversationKey
        ? JSON.stringify([event.accountNamespace, event.conversationKey, event.messageId])
        : item.applicationId;
    const group = groups.get(key) || {
      ...item,
      groupKey: key,
      applicationIds: [],
      waitingApplicationIds: [],
      observations: [],
      platformJobState: 'unknown',
    };
    group.applicationIds.push(item.applicationId);
    if ((item.status || application?.status || 'waiting') === 'waiting')
      group.waitingApplicationIds.push(item.applicationId);
    group.observations.push({
      ...item,
      observationType:
        event?.receiptStatus === 'read'
          ? '已读回执'
          : event?.receiptStatus === 'delivered'
            ? '已送达回执'
            : event?.eventType === 'resume_observed'
              ? '简历相关观察'
              : '普通消息观察',
      platformJobState: application?.platformJobState || 'unknown',
    });
    if (
      (item.status || application?.status) === 'review' ||
      (group.status !== 'review' &&
        item.reason.startsWith('attribution_') &&
        !group.reason.startsWith('attribution_'))
    ) {
      group.reason = item.reason;
      group.status = item.status || application?.status || 'waiting';
    }
    const states = new Set(
      group.observations.map((row) => row.platformJobState).filter((state) => state !== 'unknown'),
    );
    group.platformJobState = states.size > 1 ? 'conflict' : [...states][0] || 'unknown';
    const state =
      event && data
        ? bossPlatformState(
            data,
            event.accountNamespace,
            event.externalJobId || application?.resolvedJobId,
            event.canonicalUrl || application?.resolvedJobUrl,
            platformStates,
          )
        : { state: 'unknown' };
    if (state.state !== 'unknown') group.platformJobState = state.state;
    groups.set(key, group);
  }
  // Show completed receipt facts in the same card without selecting them for ignore.
  for (const group of groups.values()) {
    const seen = new Set(group.observations.map((row) => row.applicationId));
    for (const event of live(data?.sourceEvents || [])) {
      if (
        !event.messageId ||
        JSON.stringify([event.accountNamespace, event.conversationKey, event.messageId]) !==
          group.groupKey
      )
        continue;
      const application = sourceApplicationForEvent(data, event);
      if (!application || seen.has(application.id)) continue;
      seen.add(application.id);
      group.observations.push({
        applicationId: application.id,
        status: application.status,
        reason: application.reason,
        candidate: event.jobName || '',
        candidateCompany: event.company || '',
        observationType:
          event.receiptStatus === 'read'
            ? '已读回执'
            : event.receiptStatus === 'delivered'
              ? '已送达回执'
              : event.eventType === 'resume_observed'
                ? '简历相关观察'
                : '普通消息观察',
      });
    }
  }
  return [...groups.values()];
}

export function bossObservationGroups(data) {
  const seen = new Set();
  const items = live(data.sourceEvents || []).flatMap((event) => {
    const application = sourceApplicationForEvent(data, event);
    if (
      !application ||
      seen.has(application.id) ||
      !['waiting', 'review'].includes(application.status)
    )
      return [];
    seen.add(application.id);
    return [
      {
        applicationId: application.id,
        status: application.status,
        reason: application.reason,
        candidate: event.jobName || '',
        candidateCompany: event.company || '',
      },
    ];
  });
  return groupBossObservations(items, data);
}
