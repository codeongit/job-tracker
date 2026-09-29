import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { bossBatchDigestInput } from '../dist/boss-batch.js';
import { resumeRule, classifyResumeText, RESUME_RULES } from '../dist/resume-rules.js';
import { BOSS_BATCH_FORMAT, BOSS_INTEGRATION_VERSION, validateBossBatch } from './boss-inbox.mjs';
import { integrationFail } from './boss-integration-error.mjs';
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INCREMENTAL_POLICY = 'boss-manual-check-v1';
const RESUME_POLICY = 'boss-resume-observation-v3';
const RESUME_STATUS_WORKFLOW = 'resume-status-linked-v2';
const TIMEZONE = 'Asia/Shanghai';
const YESTERDAY_LABEL = '昨天';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function stableHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function uniqueEventsById(events) {
  const unique = new Map();
  for (const event of events) {
    const existing = unique.get(event.eventId);
    if (!existing) {
      unique.set(event.eventId, event);
      continue;
    }
    const {
      observedAt: existingObservedAt,
      attribution: existingAttribution,
      ...existingIdentity
    } = existing;
    const { observedAt, attribution, ...eventIdentity } = event;
    if (stableHash(existingIdentity) !== stableHash(eventIdentity))
      integrationFail('BOSS_EVENT_ID_COLLISION', { fatal: true });
    if (
      (attribution && !existingAttribution) ||
      (Boolean(attribution) === Boolean(existingAttribution) &&
        observedAt.localeCompare(existingObservedAt) < 0)
    )
      unique.set(event.eventId, event);
  }
  return [...unique.values()];
}

export function shanghaiDay(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function resolveJobRows(envelope) {
  const rank = new Map([
    ['loaded_jobName', 3],
    ['detail_page_title', 2],
    ['legacy_named_job', 1],
  ]);
  const currentByConversation = new Map(
    envelope.jobs.associations
      .filter((item) => item.status === 'current')
      .map((item) => [item.conversationKey, item]),
  );
  return envelope.snapshot.records.map((record) => {
    const association = currentByConversation.get(record.key) ?? null;
    const evidence = association
      ? envelope.jobs.evidence
          .filter(
            (item) => item.jobId === association.jobId && item.detailUrl === association.detailUrl,
          )
          .sort(
            (a, b) =>
              (rank.get(b.source) ?? 0) - (rank.get(a.source) ?? 0) ||
              Date.parse(b.observedAt) - Date.parse(a.observedAt),
          )
      : [];
    // A job id can have evidence collected from several conversations. A title
    // observed under another company is only a candidate, never an auto-fill.
    const company = record.company.trim();
    const nameConflict = evidence.some(
      (item) => item.company.trim() && item.company.trim() !== company,
    );
    const selected =
      evidence.find((item) => !item.company.trim() || item.company.trim() === company) ?? null;
    const confirmed = association
      ? envelope.jobs.confirmations.some(
          (item) =>
            item.conversationKey === record.key &&
            item.jobId === association.jobId &&
            item.detailUrl === association.detailUrl &&
            item.status === 'confirmed_user',
        )
      : false;
    return {
      record,
      externalJobId: association?.jobId ?? '',
      canonicalUrl: association?.detailUrl ?? '',
      jobName: selected?.name ?? record.observedJobName ?? '',
      nameSource: selected?.source ?? (record.observedJobName ? 'loaded_jobName' : ''),
      nameConflict,
      linkConfirmation: confirmed ? 'confirmed_user' : 'unverified',
    };
  });
}

export function eventFacts(row, accountNamespace) {
  const record = row.record;
  const receiptKnown =
    Boolean(record.latestMessageId) &&
    ['read', 'delivered'].includes(record.outgoingReceipt.status);
  const messageDirection = receiptKnown ? 'outbound' : 'unknown';
  const receiptStatus = receiptKnown ? record.outgoingReceipt.status : 'unknown';
  const receiptSource = receiptKnown ? record.outgoingReceipt.source : '';
  const complete = Boolean(
    row.externalJobId && row.canonicalUrl && row.jobName && record.company && !row.nameConflict,
  );
  return {
    platform: 'boss',
    accountNamespace,
    conversationKey: record.key,
    friendId: record.platformIdentity.friendId,
    friendSource: record.platformIdentity.friendSource,
    uniqueId: record.platformIdentity.uniqueId,
    externalJobId: row.externalJobId,
    canonicalUrl: row.canonicalUrl,
    jobName: row.jobName,
    company: record.company,
    contact: record.contact,
    summary: record.preview,
    messageId: record.latestMessageId ?? '',
    messageDirection,
    receiptStatus,
    receiptSource,
    nameSource: row.nameSource,
    linkConfirmation: row.linkConfirmation,
    intent: complete ? 'create_or_link' : 'review',
  };
}

export function createEvents(
  envelope,
  { sourceSequence, evidenceDate = '', appliedAtForNew = '' },
) {
  const rows = resolveJobRows(envelope);
  return rows.map((row) => {
    const facts = eventFacts(row, envelope.accountNamespace);
    return {
      eventId: `boss-event-${stableHash(facts)}`,
      conversationKey: facts.conversationKey,
      friendId: facts.friendId,
      friendSource: facts.friendSource,
      uniqueId: facts.uniqueId,
      externalJobId: facts.externalJobId,
      canonicalUrl: facts.canonicalUrl,
      jobName: facts.jobName,
      company: facts.company,
      contact: facts.contact,
      summary: facts.summary,
      timeLabel: row.record.timeLabel,
      messageId: facts.messageId,
      messageDirection: facts.messageDirection,
      receiptStatus: facts.receiptStatus,
      receiptSource: facts.receiptSource,
      observedAt: envelope.snapshot.capturedAt,
      evidenceDate,
      nameSource: facts.nameSource,
      linkConfirmation: facts.linkConfirmation,
      intent: facts.intent,
      appliedAtForNew,
      sourceSequence,
    };
  });
}

export function createResumeEvents(envelope, { sourceSequence, evidenceDate = '' }) {
  const rows = new Map(resolveJobRows(envelope).map((row) => [row.record.key, row]));
  const associatedJobs = new Map();
  for (const association of envelope.jobs.associations) {
    if (!associatedJobs.has(association.conversationKey))
      associatedJobs.set(association.conversationKey, new Set());
    associatedJobs.get(association.conversationKey).add(association.jobId);
  }
  const events = envelope.resume.observations
    .filter(
      (observation) =>
        !evidenceDate || shanghaiDay(new Date(observation.platformTime)) === evidenceDate,
    )
    .map((observation) => {
      const row = rows.get(observation.conversationKey);
      const candidates = [...(associatedJobs.get(observation.conversationKey) ?? [])];
      const resolvedJobId =
        observation.externalJobId ?? (candidates.length === 1 ? candidates[0] : '');
      const matchingJob = row && resolvedJobId && row.externalJobId === resolvedJobId;
      const facts = {
        platform: 'boss',
        eventType: 'resume_observed',
        accountNamespace: envelope.accountNamespace,
        conversationKey: observation.conversationKey,
        friendId: observation.platformIdentity.friendId,
        friendSource: observation.platformIdentity.friendSource,
        uniqueId: observation.platformIdentity.uniqueId,
        externalJobId: resolvedJobId,
        canonicalUrl: resolvedJobId
          ? `https://www.zhipin.com/job_detail/${resolvedJobId}.html`
          : '',
        jobName: matchingJob ? row.jobName : '',
        company: matchingJob ? row.record.company : '',
        contact: row?.record.contact ?? '',
        summary: resumeRule(observation.kind).summary,
        messageId: observation.messageId,
        messageDirection: observation.direction === 'system' ? 'outbound' : observation.direction,
        receiptStatus: 'not_applicable',
        receiptSource: '',
        nameSource: matchingJob ? row.nameSource : '',
        linkConfirmation: matchingJob ? row.linkConfirmation : 'unverified',
        intent: 'observe_only',
      };
      return {
        eventId: `boss-event-${stableHash({
          ...facts,
          ...(observation.kind === 'resume_card_other' || observation.kind === 'sent_candidate'
            ? {}
            : { workflow: RESUME_STATUS_WORKFLOW }),
        })}`,
        eventType: facts.eventType,
        attribution: observation.attribution ?? null,
        conversationKey: facts.conversationKey,
        friendId: facts.friendId,
        friendSource: facts.friendSource,
        uniqueId: facts.uniqueId,
        externalJobId: facts.externalJobId,
        canonicalUrl: facts.canonicalUrl,
        jobName: facts.jobName,
        company: facts.company,
        contact: facts.contact,
        summary: facts.summary,
        timeLabel: '',
        messageId: facts.messageId,
        messageDirection: facts.messageDirection,
        receiptStatus: facts.receiptStatus,
        receiptSource: facts.receiptSource,
        observedAt: observation.platformTime,
        evidenceDate,
        nameSource: facts.nameSource,
        linkConfirmation: facts.linkConfirmation,
        intent: facts.intent,
        appliedAtForNew: '',
        sourceSequence,
      };
    });
  return uniqueEventsById(events);
}

function resumeStatusSummary(preview) {
  const kind = classifyResumeText(preview, RESUME_RULES);
  return kind ? resumeRule(kind).summary : '';
}

export function createResumeStatusEvents(envelope, { sourceSequence, evidenceDate }) {
  return resolveJobRows(envelope)
    .filter(
      (row) =>
        row.record.timeLabel === YESTERDAY_LABEL &&
        resumeStatusSummary(row.record.preview) &&
        row.record.latestMessageId &&
        row.externalJobId &&
        row.canonicalUrl,
    )
    .map((row) => {
      const record = row.record;
      const facts = {
        platform: 'boss',
        eventType: 'resume_observed',
        accountNamespace: envelope.accountNamespace,
        conversationKey: record.key,
        friendId: record.platformIdentity.friendId,
        friendSource: record.platformIdentity.friendSource,
        uniqueId: record.platformIdentity.uniqueId,
        externalJobId: row.externalJobId,
        canonicalUrl: row.canonicalUrl,
        jobName: row.jobName,
        company: record.company,
        contact: record.contact,
        summary: resumeStatusSummary(record.preview),
        messageId: record.latestMessageId,
        messageDirection: 'outbound',
        receiptStatus: 'not_applicable',
        receiptSource: '',
        nameSource: row.nameSource,
        linkConfirmation: row.linkConfirmation,
        intent: 'observe_only',
      };
      return {
        eventId: `boss-event-${stableHash({ ...facts, workflow: RESUME_STATUS_WORKFLOW })}`,
        eventType: facts.eventType,
        conversationKey: facts.conversationKey,
        friendId: facts.friendId,
        friendSource: facts.friendSource,
        uniqueId: facts.uniqueId,
        externalJobId: facts.externalJobId,
        canonicalUrl: facts.canonicalUrl,
        jobName: facts.jobName,
        company: facts.company,
        contact: facts.contact,
        summary: facts.summary,
        timeLabel: '',
        messageId: facts.messageId,
        messageDirection: facts.messageDirection,
        receiptStatus: facts.receiptStatus,
        receiptSource: facts.receiptSource,
        observedAt: envelope.snapshot.capturedAt,
        evidenceDate,
        nameSource: facts.nameSource,
        linkConfirmation: facts.linkConfirmation,
        intent: facts.intent,
        appliedAtForNew: '',
        sourceSequence,
      };
    });
}

function coverageOf(envelope) {
  const source = envelope.snapshot.coverage;
  return {
    loadedRows: source.loadedRows,
    loadedDataRows: source.loadedDataRows,
    renderedRows: source.renderedRows,
    offscreenRows: source.offscreenRows,
    unresolvedRows: source.unresolvedRows,
    truncated: source.truncated,
  };
}

function batchIdFor(batch) {
  return `boss-batch-${stableHash(bossBatchDigestInput(batch))}`;
}

export function createBatch({
  envelope,
  snapshotName,
  snapshotSha256,
  sourceSequence,
  policy,
  events,
}) {
  const batch = {
    format: BOSS_BATCH_FORMAT,
    version: BOSS_INTEGRATION_VERSION,
    batchId: '',
    platform: 'boss',
    accountNamespace: envelope.accountNamespace,
    sourceSequence,
    policy: structuredClone(policy),
    source: {
      snapshotName,
      snapshotSha256,
      capturedAt: envelope.snapshot.capturedAt,
    },
    coverage: coverageOf(envelope),
    events: events.map((event) =>
      event.eventType === 'resume_observed'
        ? { ...structuredClone(event), attribution: event.attribution ?? null }
        : structuredClone(event),
    ),
  };
  batch.batchId = batchIdFor(batch);
  return validateBossBatch(batch);
}

export function createResumeBatch(snapshot, sourceSequence, evidenceDate = '') {
  if (evidenceDate && !/^\d{4}-\d{2}-\d{2}$/.test(evidenceDate))
    integrationFail('BOSS_EVIDENCE_DATE_INVALID');
  const policy = {
    id: evidenceDate ? `boss-resume-observation-date-${evidenceDate}-v3` : RESUME_POLICY,
    mode: 'resume',
    timezone: TIMEZONE,
    appliedAtForNew: '',
    autoCreateComplete: false,
  };
  const candidates = [
    ...createResumeEvents(snapshot.envelope, { sourceSequence, evidenceDate }),
    ...(evidenceDate
      ? createResumeStatusEvents(snapshot.envelope, { sourceSequence, evidenceDate })
      : []),
  ];
  const events = uniqueEventsById(candidates);
  if (!events.length) integrationFail('BOSS_RESUME_OBSERVATIONS_EMPTY');
  return createBatch({
    envelope: snapshot.envelope,
    snapshotName: basename(snapshot.path),
    snapshotSha256: snapshot.sha256,
    sourceSequence,
    policy,
    events,
  });
}

export function createIncrementalBatch(
  previous,
  current,
  sourceSequence,
  { afterInitial = false } = {},
) {
  const eventsFor = (snapshot) => {
    const captureDay = shanghaiDay(new Date(snapshot.envelope.snapshot.capturedAt));
    return createEvents(snapshot.envelope, { sourceSequence }).map((event) =>
      HH_MM.test(event.timeLabel)
        ? { ...event, evidenceDate: captureDay, appliedAtForNew: captureDay }
        : event,
    );
  };
  const previousIds = new Set(
    [
      ...eventsFor(previous).filter((event) => !afterInitial || HH_MM.test(event.timeLabel)),
      ...createResumeEvents(previous.envelope, { sourceSequence }),
    ].map((event) => `${event.eventId}:${stableHash(event.attribution ?? null)}`),
  );
  const events = uniqueEventsById([
    ...eventsFor(current),
    ...createResumeEvents(current.envelope, { sourceSequence }),
  ]).filter(
    (event) => !previousIds.has(`${event.eventId}:${stableHash(event.attribution ?? null)}`),
  );
  if (!events.length) return null;
  const policy = {
    id: INCREMENTAL_POLICY,
    mode: 'incremental',
    timezone: TIMEZONE,
    appliedAtForNew: '',
    autoCreateComplete: true,
  };
  return createBatch({
    envelope: current.envelope,
    snapshotName: basename(current.path),
    snapshotSha256: current.sha256,
    sourceSequence,
    policy,
    events,
  });
}
