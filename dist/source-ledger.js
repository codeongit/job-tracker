import { bossPlatformState } from './platform-job-state.js';
import {
  bossApplicationId,
  bossFactId,
  bossFactType,
  hasBossFactIdentity,
} from './source-identity.js';

// Evidence is immutable. Application decisions are separately replayable and never
// turn a rule upgrade or a restored backup into a new platform observation.
export const SOURCE_RULE_VERSION = 'boss-application-v9';

export function sourceApplicationForEvent(data, event) {
  const factId = event.factId || (hasBossFactIdentity(event) ? bossFactId(event) : '');
  return (
    (factId
      ? data.sourceApplications?.find((row) => !row.deletedAt && row.factId === factId)
      : null) ??
    data.sourceApplications?.find(
      (row) => !row.deletedAt && row.factId === event.id.replace(/^boss-event-/, 'boss-fact-'),
    )
  );
}

export const IGNORED_OBSERVATION_REASON = 'user_ignored_unresolved_observation';

export function isIgnoredObservation(application) {
  return application?.status === 'protected' && application.reason === IGNORED_OBSERVATION_REASON;
}

export function bossWaitingItems(data) {
  const seen = new Set();
  return (data.sourceEvents || [])
    .filter((event) => !event.deletedAt)
    .flatMap((event) => {
      const application = sourceApplicationForEvent(data, event);
      if (!application || application.status !== 'waiting' || seen.has(application.id)) return [];
      seen.add(application.id);
      return [
        {
          applicationId: application.id,
          reason: application.reason,
          candidate: event.jobName || '',
          candidateCompany: event.company || '',
        },
      ];
    })
    .sort((a, b) => a.applicationId.localeCompare(b.applicationId));
}

export function sourceReviewCounts(data) {
  const result = { waiting: 0, review: 0, protected: 0, applied: 0, no_effect: 0 },
    seen = new Set();
  for (const event of data.sourceEvents || []) {
    if (event.deletedAt) continue;
    const application = sourceApplicationForEvent(data, event);
    if (application && !seen.has(application.id)) {
      seen.add(application.id);
      if (isIgnoredObservation(application)) result.ignored = (result.ignored || 0) + 1;
      else if (application.status in result) result[application.status]++;
    } else if (!application && !event.factId) result.waiting++;
  }
  for (const application of data.sourceApplications || []) {
    if (application.deletedAt || seen.has(application.id)) continue;
    const fact = data.sourceFacts?.find((row) => row.id === application.factId);
    const mappedEvent = fact?.legacyEventId
      ? data.sourceEvents?.find((event) => event.id === fact.legacyEventId && !event.deletedAt)
      : null;
    // The old application remains auditable, while the semantic mapping is the
    // one active decision shown to users.
    if (mappedEvent?.factId && mappedEvent.factId !== fact.id) continue;
    seen.add(application.id);
    if (isIgnoredObservation(application)) result.ignored = (result.ignored || 0) + 1;
    else if (application.status in result) result[application.status]++;
  }
  return result;
}

export function effectiveSourceEvents(data) {
  return data.sourceEvents.map((event) => {
    const application = sourceApplicationForEvent(data, event);
    if (!application) return event;
    return {
      ...event,
      opportunityId: application.reason.startsWith('attribution_')
        ? ''
        : application.opportunityId || event.opportunityId,
      status:
        ['applied', 'no_effect', 'protected'].includes(application.status) &&
        application.opportunityId
          ? 'recorded'
          : event.status,
    };
  });
}

function evidencePreference(event) {
  const completeness = [
    event.opportunityId,
    event.externalJobId,
    event.canonicalUrl,
    event.jobName,
    event.company,
    event.contact,
  ].filter(Boolean).length;
  return [
    event.status === 'recorded' ? 1 : 0,
    completeness,
    Number(event.sourceSequence || 0),
    event.observedAt || '',
    event.createdAt || '',
    event.id || '',
  ];
}

function prefersEvidence(candidate, current) {
  const left = evidencePreference(candidate);
  const right = evidencePreference(current);
  for (let index = 0; index < left.length; index++) {
    if (left[index] === right[index]) continue;
    return left[index] > right[index];
  }
  return false;
}

// Raw evidence remains immutable for audit. Product views use one best row per
// semantic fact so metadata enrichment and snapshot re-observation do not make
// the same platform message appear to accumulate repeatedly.
export function effectiveSourceFacts(data) {
  const facts = new Map();
  for (const event of effectiveSourceEvents(data)) {
    if (event.deletedAt) continue;
    if (
      ['user_rejected_wrong_conversation', IGNORED_OBSERVATION_REASON].includes(
        sourceApplicationForEvent(data, event)?.reason,
      )
    )
      continue;
    const key =
      event.factId ||
      (hasBossFactIdentity(event) ? bossFactId(event) : event.id || JSON.stringify(event));
    const current = facts.get(key);
    if (!current || prefersEvidence(event, current)) facts.set(key, event);
  }
  return [...facts.values()];
}

export function factFromLegacyEvent(event) {
  if (!hasBossFactIdentity(event)) return null;
  return {
    id: bossFactId(event),
    platform: event.platform,
    accountNamespace: event.accountNamespace,
    conversationKey: event.conversationKey,
    messageId: event.messageId || '',
    factType: bossFactType(event),
    deletedAt: event.deletedAt || '',
  };
}

export function applicationFromLegacyEvent(event) {
  if (!hasBossFactIdentity(event)) return null;
  const factId = bossFactId(event);
  return {
    id: bossApplicationId(factId),
    factId,
    opportunityId: event.opportunityId || '',
    ruleVersion: 'legacy_v1',
    action: event.eventType || 'conversation_observed',
    status: { recorded: 'applied', skipped: 'protected', review: 'review' }[event.status],
    reason: `legacy_${event.status}`,
    appliedAt: event.status === 'recorded' ? event.createdAt : '',
    updatedAt: event.createdAt,
    deletedAt: event.deletedAt || '',
  };
}

function restoreRequired() {
  const error = new Error('来源事实或应用已删除，需要明确核对后恢复。');
  error.code = 'RESTORE_REVIEW_REQUIRED';
  throw error;
}

export function recordSourceApplication(
  data,
  event,
  decision,
  stamp,
  { allowRestore = false } = {},
) {
  const fact = factFromLegacyEvent(event);
  if (!fact) return null;
  const existingFact = data.sourceFacts.find((row) => row.id === fact.id);
  if (existingFact?.deletedAt) {
    if (!allowRestore) restoreRequired();
    existingFact.deletedAt = '';
  } else if (!existingFact) data.sourceFacts.push(fact);
  const id = bossApplicationId(fact.id);
  const existing = data.sourceApplications.find((row) => row.id === id);
  if (existing?.deletedAt && !allowRestore) restoreRequired();
  // A completed or manually protected decision is not silently replayed.
  if (existing && !existing.deletedAt && !['waiting', 'review'].includes(existing.status))
    return existing;
  const application = {
    ...Object.fromEntries(
      ['platformJobState', 'platformJobStateSource', 'platformJobStateAt']
        .filter((field) => existing && field in existing)
        .map((field) => [field, existing[field]]),
    ),
    id,
    factId: fact.id,
    opportunityId: decision.targetId || '',
    ruleVersion: SOURCE_RULE_VERSION,
    action: event.eventType,
    status: decision.applicationStatus || (decision.status === 'recorded' ? 'applied' : 'review'),
    reason:
      decision.reason ||
      (decision.status === 'recorded' ? 'observation_recorded' : 'identity_conflict'),
    appliedAt:
      (decision.applicationStatus || (decision.status === 'recorded' ? 'applied' : 'review')) ===
      'applied'
        ? stamp
        : '',
    updatedAt: stamp,
    deletedAt: '',
  };
  const availability = bossPlatformState(
    data,
    event.accountNamespace,
    event.externalJobId,
    event.canonicalUrl,
  );
  if (!existing?.platformJobState || existing.platformJobState === 'unknown') {
    if (['open', 'closed'].includes(availability.state))
      Object.assign(application, {
        platformJobState: availability.state,
        platformJobStateSource: availability.source,
        platformJobStateAt: availability.at,
      });
  }
  if (existing) Object.assign(existing, application);
  else data.sourceApplications.push(application);
  return application;
}

const applicationPriority = Object.freeze({
  applied: 5,
  protected: 4,
  no_effect: 3,
  review: 2,
  waiting: 1,
});

function ensureUniqueIds(rows, group) {
  const ids = new Set();
  for (const row of rows) {
    if (row && typeof row.id === 'string' && ids.has(row.id))
      throw new Error(`${group} 中存在无效或重复 ID。`);
    if (row && typeof row.id === 'string') ids.add(row.id);
  }
}

function applicationTieKey(application) {
  return JSON.stringify(
    Object.keys(application)
      .sort()
      .map((key) => [key, application[key]]),
  );
}

function preferredApplication(left, right) {
  if (!left) return right;
  if (Boolean(left.deletedAt) !== Boolean(right.deletedAt)) return right.deletedAt ? left : right;
  const leftPriority = applicationPriority[left.status] || 0;
  const rightPriority = applicationPriority[right.status] || 0;
  if (leftPriority !== rightPriority) return rightPriority > leftPriority ? right : left;
  if (left.updatedAt !== right.updatedAt) return right.updatedAt < left.updatedAt ? right : left;
  return applicationTieKey(right) < applicationTieKey(left) ? right : left;
}

// v0.8 pre-release builds derived fact IDs from the much broader legacy event
// hash. Preserve those rows and add semantic mappings instead of renaming or
// replaying them. This adapter is idempotent and also deduplicates v2 events
// that describe the same platform fact.
export function upgradeSourceLedger(data) {
  ensureUniqueIds(data.sourceFacts, 'sourceFacts');
  ensureUniqueIds(data.sourceApplications, 'sourceApplications');
  const sourceFacts = data.sourceFacts.map((row) => ({ ...row }));
  const facts = new Map(sourceFacts.map((row) => [row.id, row]));
  const sourceApplications = data.sourceApplications.map((row) => ({ ...row }));
  const applications = new Map(sourceApplications.map((row) => [row.id, row]));
  const newFacts = new Map();
  const candidates = new Map();
  const sourceEvents = data.sourceEvents.map((event) => {
    const hadFactId = Object.prototype.hasOwnProperty.call(event, 'factId');
    if (!hasBossFactIdentity(event)) {
      if (hadFactId && event.factId) throw new Error('来源事件事实身份与消息标识不相容。');
      return { ...event, factId: '' };
    }
    const fact = factFromLegacyEvent(event);
    if (hadFactId && event.factId !== fact.id)
      throw new Error('来源事件事实身份与消息标识不相容。');
    if (!facts.has(fact.id)) {
      const priorFact = newFacts.get(fact.id);
      if (!priorFact || (priorFact.deletedAt && !fact.deletedAt)) newFacts.set(fact.id, fact);
    }
    event = { ...event, factId: fact.id };
    const semanticId = bossApplicationId(fact.id);
    if (applications.has(semanticId)) return event;
    const legacyId = event.id.replace(/^boss-event-/, 'boss-application-');
    const legacy = applications.get(legacyId);
    const candidate = legacy
      ? {
          ...legacy,
          id: semanticId,
          factId: fact.id,
          reason: String(legacy.reason || '').startsWith('legacy_')
            ? legacy.reason
            : `legacy_mapped_${legacy.reason || 'unknown'}`,
        }
      : applicationFromLegacyEvent(event);
    const prior = candidates.get(semanticId);
    candidates.set(semanticId, preferredApplication(prior, candidate));
    return event;
  });
  for (const [id, fact] of [...newFacts].sort(([left], [right]) => left.localeCompare(right))) {
    if (!facts.has(id)) {
      facts.set(id, fact);
      sourceFacts.push(fact);
    }
  }
  for (const [id, application] of [...candidates].sort(([left], [right]) =>
    left.localeCompare(right),
  ))
    if (!applications.has(id)) {
      applications.set(id, application);
      sourceApplications.push(application);
    }
  return {
    ...data,
    sourceEvents,
    sourceFacts,
    sourceApplications,
  };
}
