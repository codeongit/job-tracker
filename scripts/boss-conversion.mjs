import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { bossBatchDigestInput } from '../dist/boss-batch.js';
import { resumeRule, classifyResumeText, RESUME_RULES } from '../dist/resume-rules.js';
import { BOSS_BATCH_FORMAT, BOSS_INTEGRATION_VERSION, validateBossBatch } from './boss-inbox.mjs';
import { integrationFail } from './boss-integration-error.mjs';
import { parseBossDetailTitle } from '../dist/boss-detail-title.js';
import { parseBossJobUrl } from '../dist/boss-job-url.js';
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INCREMENTAL_POLICY = 'boss-manual-check-v1';
const RESUME_POLICY = 'boss-resume-observation-v3';
const RESUME_STATUS_WORKFLOW = 'resume-status-linked-v2';
const TIMEZONE = 'Asia/Shanghai';
const YESTERDAY_LABEL = '昨天';
function detailSignature(detail) {
  const normalized = (value) =>
    String(value ?? '')
      .normalize('NFC')
      .replace(/\s+/gu, ' ')
      .trim();
  return JSON.stringify([normalized(detail.name), normalized(detail.company)]);
}
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
    if (
      existingAttribution &&
      attribution &&
      stableHash(existingAttribution) !== stableHash(attribution)
    )
      integrationFail('BOSS_ATTRIBUTION_EVIDENCE_CONFLICT', { fatal: true });
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
function retainedDetailRecords(envelope) {
  if (envelope.snapshot.accountNamespace !== envelope.accountNamespace) return [];
  const loadedKeys = new Set(envelope.snapshot.records.map((record) => record.key));
  return (envelope.state?.records ?? [])
    .filter((record) => {
      if (loadedKeys.has(record.key)) return false;
      const identity = record.platformIdentity;
      if (
        !identity ||
        typeof identity.friendId !== 'string' ||
        typeof identity.friendSource !== 'string' ||
        identity.uniqueId !== `${identity.friendId}-${identity.friendSource}` ||
        record.key !==
          stableHash([
            'boss',
            envelope.accountNamespace,
            identity.friendId,
            identity.friendSource,
          ]) ||
        !Number.isFinite(Date.parse(record.lastObservedAt)) ||
        !record.latestObservation
      )
        return false;
      const associations = envelope.jobs.associations.filter(
        (item) => item.status === 'current' && item.conversationKey === record.key,
      );
      if (associations.length !== 1) return false;
      const association = associations[0],
        parsedUrl = parseBossJobUrl(association.detailUrl);
      if (
        !parsedUrl ||
        parsedUrl.jobId !== association.jobId ||
        parsedUrl.canonicalUrl !== association.detailUrl
      )
        return false;
      const details = envelope.jobs.evidence.filter(
        (item) => item.jobId === association.jobId && item.source === 'detail_page_title',
      );
      if (!details.length) return false;
      const signatures = new Set();
      for (const detail of details) {
        const parsed = parseBossDetailTitle(detail.title);
        if (
          detail.detailUrl !== association.detailUrl ||
          !parsed ||
          parsed.name !== detail.name ||
          parsed.company !== detail.company
        )
          return false;
        signatures.add(detailSignature(parsed));
      }
      return signatures.size === 1;
    })
    .map((record) => ({
      key: record.key,
      platformIdentity: record.platformIdentity,
      contact: record.contact,
      company: record.company,
      title: record.title,
      ...record.latestObservation,
      observedJobName: null,
      lastObservedAt: record.lastObservedAt,
    }));
}

export function resolveJobRows(envelope, { includeRetainedDetails = false } = {}) {
  const rank = new Map([
    ['loaded_jobName', includeRetainedDetails ? 2 : 3],
    ['detail_page_title', includeRetainedDetails ? 3 : 2],
    ['legacy_named_job', 1],
  ]);
  const currentByConversation = new Map(
    envelope.jobs.associations
      .filter((item) => item.status === 'current')
      .map((item) => [item.conversationKey, item]),
  );
  const records = includeRetainedDetails
    ? [...envelope.snapshot.records, ...retainedDetailRecords(envelope)]
    : envelope.snapshot.records;
  return records.map((record) => {
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
    const details = evidence.filter((item) => item.source === 'detail_page_title');
    const detailConflict = includeRetainedDetails
      ? new Set(details.map(detailSignature)).size > 1
      : details.some(
          (item) => item.name !== details[0].name || item.company !== details[0].company,
        );
    // Keep the legacy fact mapping for resume IDs. Detail delivery uses the
    // verified employer, which can differ from the company in the chat list.
    const company = record.company.trim();
    const nameConflict = includeRetainedDetails
      ? detailConflict
      : evidence.some((item) => item.company.trim() && item.company.trim() !== company);
    const selected = includeRetainedDetails
      ? detailConflict
        ? null
        : (evidence[0] ?? null)
      : (evidence.find((item) => !item.company.trim() || item.company.trim() === company) ?? null);
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
      jobDetails: (() => {
        if (!details.length) return null;
        if (detailConflict || !details[0].company?.trim())
          return {
            jobId: association.jobId,
            canonicalUrl: association.detailUrl,
            jobName: '',
            company: '',
            source: 'detail_page_conflict',
          };
        return {
          jobId: association.jobId,
          canonicalUrl: association.detailUrl,
          jobName: details[0].name,
          company: details[0].company,
          source: 'detail_page_title',
        };
      })(),
      externalJobId: association?.jobId ?? '',
      canonicalUrl: association?.detailUrl ?? '',
      jobName:
        selected?.name ??
        (includeRetainedDetails && nameConflict ? '' : (record.observedJobName ?? '')),
      nameSource:
        selected?.source ??
        (includeRetainedDetails && nameConflict
          ? ''
          : record.observedJobName
            ? 'loaded_jobName'
            : ''),
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
  { sourceSequence, evidenceDate = '', appliedAtForNew = '', includeRetainedDetails = false },
) {
  const rows = resolveJobRows(envelope, { includeRetainedDetails });
  const loadedKeys = new Set(envelope.snapshot.records.map((record) => record.key));
  return rows.map((row) => {
    const facts = eventFacts(row, envelope.accountNamespace);
    const retained = !loadedKeys.has(row.record.key);
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
      timeLabel: retained ? '' : row.record.timeLabel,
      messageId: facts.messageId,
      messageDirection: facts.messageDirection,
      receiptStatus: facts.receiptStatus,
      receiptSource: facts.receiptSource,
      observedAt: retained ? row.record.lastObservedAt : envelope.snapshot.capturedAt,
      evidenceDate: retained ? '' : evidenceDate,
      nameSource: facts.nameSource,
      linkConfirmation: facts.linkConfirmation,
      intent: facts.intent,
      appliedAtForNew: retained ? '' : appliedAtForNew,
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
      // Retained only for legacy event identity/candidate display. assessBossAttribution owns authority.
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
  includeRetainedDetails = false,
}) {
  const rows = new Map(
    resolveJobRows(envelope, { includeRetainedDetails }).map((row) => [row.record.key, row]),
  );
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
    events: events.map((event) => {
      const row = rows.get(event.conversationKey);
      return {
        ...(event.eventType === 'resume_observed'
          ? { ...structuredClone(event), attribution: event.attribution ?? null }
          : structuredClone(event)),
        jobDetails: row?.jobDetails ?? null,
      };
    }),
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
    const loadedKeys = new Set(snapshot.envelope.snapshot.records.map((record) => record.key));
    return createEvents(snapshot.envelope, { sourceSequence, includeRetainedDetails: true }).map(
      (event) =>
        loadedKeys.has(event.conversationKey) && HH_MM.test(event.timeLabel)
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
    includeRetainedDetails: true,
  });
}
