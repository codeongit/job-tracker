import { resolveBossJobEvidence } from './job-evidence.mjs';
import { BOSS_JOB_ID, parseBossJobUrl, isCanonicalBossJobUrl } from '../../dist/boss-job-url.js';
import { parseBossDetailTitle } from '../../dist/boss-detail-title.js';
import { validateAttributionEvidence } from '../../dist/boss-attribution.js';
import {
  RESUME_KINDS,
  RESUME_STATUS_KINDS,
  validateResumeEvidence,
} from '../../dist/resume-rules.js';
import { createHash } from 'node:crypto';

export const V2_SCOPE = 'loaded-chat-list';
const RECEIPTS = new Set(['unknown', 'delivered', 'read', 'unread']);
const ASSOCIATION_STATUSES = new Set(['current', 'historical']);

function fail(message) {
  throw new TypeError(message);
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} must be an object`);
}

function string(value, path, { nullable = false, empty = false, max = 1000 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) {
    fail(
      `${path} must be ${nullable ? 'null or ' : ''}a${empty ? '' : ' nonempty'} string of at most ${max} characters`,
    );
  }
  return value.normalize('NFC');
}

function timestamp(value, path) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail(`${path} must be an ISO timestamp with a timezone`);
  return value;
}

function jsonClone(value, path = 'input', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value))
    fail(`${path} must contain only acyclic JSON data`);
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(`${path} must contain only plain JSON objects`);
  }
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? value.map((item, index) => jsonClone(item, `${path}[${index}]`, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          jsonClone(item, `${path}.${key}`, ancestors),
        ]),
      );
  ancestors.delete(value);
  return copy;
}

function normText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();
}

function identityPart(value, path) {
  if (
    !['string', 'number'].includes(typeof value) ||
    (typeof value === 'number' && !Number.isSafeInteger(value))
  )
    fail(`${path} must be a string or safe integer`);
  const result = normText(value);
  if (!result || result.length > 300) fail(`${path} must identify one platform value`);
  return result;
}

function digest(value) {
  const canonical = (current) => {
    if (Array.isArray(current)) return current.map(canonical);
    if (current && typeof current === 'object') {
      return Object.fromEntries(
        Object.keys(current)
          .filter((key) => current[key] !== undefined)
          .sort()
          .map((key) => [key, canonical(current[key])]),
      );
    }
    return current;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Stable within one verified BOSS account namespace. Display names never participate. */
export function conversationKeyV2(accountNamespace, friendId, friendSource) {
  const namespace = identityPart(accountNamespace, 'accountNamespace');
  const id = identityPart(friendId, 'friendId');
  const source = identityPart(friendSource, 'friendSource');
  return digest(['boss', namespace, id, source]);
}

export function canonicalJobUrlV2(jobId) {
  const id = identityPart(jobId, 'jobId');
  if (!BOSS_JOB_ID.test(id)) fail('jobId contains unsupported characters');
  return `https://www.zhipin.com/job_detail/${id}.html`;
}

function jobIdFromUrl(url, path) {
  const match = typeof url === 'string' && parseBossJobUrl(url);
  if (!match || !isCanonicalBossJobUrl(url))
    fail(`${path} must be a canonical BOSS job-detail URL`);
  return match.jobId;
}

function normalizeReceipt(value, path) {
  if (value === undefined) return { status: 'unknown', label: null, source: null };
  object(value, path);
  if (!RECEIPTS.has(value.status)) fail(`${path}.status is invalid`);
  if (value.status === 'unknown') {
    if (value.label !== null || value.source !== null)
      fail(`${path} unknown status requires null label and source`);
    return { status: 'unknown', label: null, source: null };
  }
  return {
    status: value.status,
    label: string(value.label, `${path}.label`, { max: 30 }),
    source: string(value.source, `${path}.source`, { max: 100 }),
  };
}

function normalizeJobAssociation(value, path) {
  if (value === undefined || value === null || (value.jobId === null && value.detailUrl === null)) {
    return { jobId: null, detailUrl: null };
  }
  object(value, path);
  const jobId = identityPart(value.jobId, `${path}.jobId`);
  const detailUrl = string(value.detailUrl, `${path}.detailUrl`, { max: 500 });
  if (
    jobIdFromUrl(detailUrl, `${path}.detailUrl`) !== jobId ||
    canonicalJobUrlV2(jobId) !== detailUrl
  ) {
    fail(`${path} jobId and detailUrl do not identify the same canonical job`);
  }
  return { jobId, detailUrl };
}

function normalizeCaptureRecord(value, namespace, path) {
  object(value, path);
  object(value.platformIdentity, `${path}.platformIdentity`);
  const friendId = identityPart(
    value.platformIdentity.friendId,
    `${path}.platformIdentity.friendId`,
  );
  const friendSource = identityPart(
    value.platformIdentity.friendSource,
    `${path}.platformIdentity.friendSource`,
  );
  const uniqueId = identityPart(
    value.platformIdentity.uniqueId,
    `${path}.platformIdentity.uniqueId`,
  );
  if (uniqueId !== `${friendId}-${friendSource}`)
    fail(`${path}.platformIdentity.uniqueId is inconsistent with friendId/friendSource`);
  const key = conversationKeyV2(namespace, friendId, friendSource);
  if (value.key !== undefined && value.key !== key)
    fail(`${path}.key is inconsistent with its platform identity`);
  const unread = value.unread;
  if (unread !== null && (!Number.isSafeInteger(unread) || unread < 0))
    fail(`${path}.unread must be null or a nonnegative integer`);
  const latestMessageId =
    value.latestMessageId === null || value.latestMessageId === undefined
      ? null
      : identityPart(value.latestMessageId, `${path}.latestMessageId`);
  const jobAssociation = normalizeJobAssociation(value.jobAssociation, `${path}.jobAssociation`);
  const observedJobName =
    value.observedJobName === null || value.observedJobName === undefined
      ? null
      : string(value.observedJobName, `${path}.observedJobName`, { max: 300 });
  if (observedJobName !== null && jobAssociation.jobId === null) {
    fail(`${path}.observedJobName requires a platform job association`);
  }
  return {
    key,
    platformIdentity: { friendId, friendSource, uniqueId },
    contact: string(value.contact, `${path}.contact`, { empty: true, max: 300 }),
    company: string(value.company, `${path}.company`, { empty: true, max: 500 }),
    title: string(value.title, `${path}.title`, { empty: true, max: 500 }),
    preview: string(value.preview, `${path}.preview`, { empty: true, max: 5000 }),
    timeLabel: string(value.timeLabel, `${path}.timeLabel`, { empty: true, max: 100 }),
    unread,
    latestMessageId,
    outgoingReceipt: normalizeReceipt(value.outgoingReceipt, `${path}.outgoingReceipt`),
    jobAssociation,
    observedJobName,
  };
}

function normalizeCoverage(value, recordCount) {
  object(value, 'snapshot.coverage');
  const metric = (name, fallback) => {
    const current = value[name] ?? fallback;
    if (!Number.isSafeInteger(current) || current < 0)
      fail(`snapshot.coverage.${name} must be a nonnegative integer`);
    return current;
  };
  const loadedRows = metric('loadedRows', recordCount);
  const loadedDataRows = metric('loadedDataRows', loadedRows);
  const unresolvedRows = metric('unresolvedRows', Math.max(0, loadedDataRows - recordCount));
  const renderedRows = metric('renderedRows', recordCount);
  const offscreenRows = metric('offscreenRows', Math.max(0, loadedDataRows - renderedRows));
  if (loadedDataRows < recordCount || loadedRows < renderedRows || loadedDataRows < offscreenRows) {
    fail('snapshot.coverage metrics are inconsistent with captured records');
  }
  const truncated = value.truncated ?? false;
  if (typeof truncated !== 'boolean') fail('snapshot.coverage.truncated must be a boolean');
  return { loadedRows, loadedDataRows, unresolvedRows, renderedRows, offscreenRows, truncated };
}

/** Validate and normalize a capture without changing it. */
export function validateLoadedSnapshotV2(snapshot) {
  object(snapshot, 'snapshot');
  const capturedAt = timestamp(snapshot.capturedAt, 'snapshot.capturedAt');
  if (snapshot.scope !== V2_SCOPE) fail('snapshot.scope is invalid');
  const accountNamespace = identityPart(snapshot.accountNamespace, 'snapshot.accountNamespace');
  if (!Array.isArray(snapshot.records)) fail('snapshot.records must be an array');
  const records = snapshot.records.map((record, index) =>
    normalizeCaptureRecord(record, accountNamespace, `snapshot.records[${index}]`),
  );
  return {
    capturedAt,
    scope: V2_SCOPE,
    accountNamespace,
    records,
    coverage: normalizeCoverage(snapshot.coverage, records.length),
  };
}

function observationFrom(record) {
  return {
    preview: record.preview,
    timeLabel: record.timeLabel,
    unread: record.unread,
    latestMessageId: record.latestMessageId,
    outgoingReceipt: { ...record.outgoingReceipt },
  };
}

function stateRecordFrom(record, at, previous = null) {
  return {
    key: record.key,
    platformIdentity: { ...record.platformIdentity },
    contact: record.contact,
    company: record.company,
    title: record.title,
    firstObservedAt: previous?.firstObservedAt ?? at,
    lastObservedAt: at,
    latestObservation: observationFrom(record),
  };
}

function evidenceId(kind, facts) {
  return digest(['boss-v2-evidence', kind, facts]);
}

function associationId(conversationKey, jobId) {
  return digest(['boss-v2-association', conversationKey, jobId]);
}

function emptyEnvelope(snapshot) {
  return {
    version: 6,
    scope: V2_SCOPE,
    accountNamespace: snapshot.accountNamespace,
    createdAt: snapshot.capturedAt,
    updatedAt: snapshot.capturedAt,
    snapshot: jsonClone(snapshot),
    state: {
      baselineCapturedAt: snapshot.capturedAt,
      lastCapturedAt: snapshot.capturedAt,
      records: [],
    },
    report: {
      mode: 'baseline',
      capturedAt: snapshot.capturedAt,
      previousCapturedAt: null,
      counts: {},
      changes: [],
      ambiguities: [],
      coverage: jsonClone(snapshot.coverage),
      warnings: [],
    },
    jobs: { associations: [], evidence: [], candidates: [], confirmations: [] },
    resume: { observations: [], lastScanAt: null, lastCoverage: null, lastUnresolved: [] },
    migration: { importedLegacyKeys: [], runs: [], quarantine: [] },
  };
}

function uniqueBy(values, key, path) {
  const seen = new Set();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) fail(`${path} contains a duplicate: ${id}`);
    seen.add(id);
  }
}

function validateStateRecord(record, envelope, path) {
  object(record, path);
  const normalized = normalizeCaptureRecord(
    {
      ...record,
      preview: record.latestObservation?.preview,
      timeLabel: record.latestObservation?.timeLabel,
      unread: record.latestObservation?.unread,
      latestMessageId: record.latestObservation?.latestMessageId,
      outgoingReceipt: record.latestObservation?.outgoingReceipt,
      jobAssociation: null,
      observedJobName: null,
    },
    envelope.accountNamespace,
    path,
  );
  timestamp(record.firstObservedAt, `${path}.firstObservedAt`);
  timestamp(record.lastObservedAt, `${path}.lastObservedAt`);
  if (
    Date.parse(record.firstObservedAt) > Date.parse(record.lastObservedAt) ||
    Date.parse(record.firstObservedAt) < Date.parse(envelope.state.baselineCapturedAt) ||
    Date.parse(record.lastObservedAt) > Date.parse(envelope.state.lastCapturedAt)
  )
    fail(`${path} has inconsistent timestamps`);
  return {
    key: normalized.key,
    platformIdentity: normalized.platformIdentity,
    contact: normalized.contact,
    company: normalized.company,
    title: normalized.title,
    firstObservedAt: record.firstObservedAt,
    lastObservedAt: record.lastObservedAt,
    latestObservation: observationFrom(normalized),
  };
}

function validateAssociation(record, envelope, path) {
  object(record, path);
  string(record.id, `${path}.id`, { max: 100 });
  string(record.conversationKey, `${path}.conversationKey`, { max: 100 });
  const jobId = identityPart(record.jobId, `${path}.jobId`);
  const detailUrl = string(record.detailUrl, `${path}.detailUrl`, { max: 500 });
  if (
    jobIdFromUrl(detailUrl, `${path}.detailUrl`) !== jobId ||
    record.id !== associationId(record.conversationKey, jobId)
  ) {
    fail(`${path} has inconsistent identity fields`);
  }
  if (!ASSOCIATION_STATUSES.has(record.status)) fail(`${path}.status is invalid`);
  timestamp(record.firstObservedAt, `${path}.firstObservedAt`);
  timestamp(record.lastObservedAt, `${path}.lastObservedAt`);
  if (Date.parse(record.firstObservedAt) > Date.parse(record.lastObservedAt))
    fail(`${path} timestamps are reversed`);
  string(record.source, `${path}.source`, { max: 100 });
  if (record.legacyKey !== undefined) string(record.legacyKey, `${path}.legacyKey`, { max: 200 });
  if (record.historicalReason !== undefined)
    string(record.historicalReason, `${path}.historicalReason`, { max: 100 });
}

function validateEvidence(record, kind, path) {
  object(record, path);
  string(record.id, `${path}.id`, { max: 100 });
  const jobId = identityPart(record.jobId, `${path}.jobId`);
  const detailUrl = string(record.detailUrl, `${path}.detailUrl`, { max: 500 });
  if (jobIdFromUrl(detailUrl, `${path}.detailUrl`) !== jobId) fail(`${path} URL and job ID differ`);
  string(record.conversationKey, `${path}.conversationKey`, { max: 100 });
  string(record.name, `${path}.name`, { max: 300 });
  string(record.source, `${path}.source`, { max: 100 });
  timestamp(record.observedAt, `${path}.observedAt`);
  string(record.company, `${path}.company`, { empty: true, max: 500 });
  if (record.title !== undefined && record.title !== null)
    string(record.title, `${path}.title`, { max: 1000 });
  if (kind === 'candidate') {
    string(record.reason, `${path}.reason`, { max: 200 });
    string(record.observedCompany, `${path}.observedCompany`, { max: 500 });
    string(record.expectedCompany, `${path}.expectedCompany`, { empty: true, max: 500 });
  }
  if (record.source === 'detail_page_title')
    validateDetailTitle(
      record.title,
      record.name,
      kind === 'candidate' ? record.observedCompany : record.company,
      path,
    );
  if (record.legacyKey !== undefined) string(record.legacyKey, `${path}.legacyKey`, { max: 200 });
  const facts = Object.fromEntries(
    Object.entries(record).filter(([key]) => !['id', 'attribution'].includes(key)),
  );
  if (record.id !== evidenceId(kind, facts)) fail(`${path}.id does not match its evidence facts`);
}

function validateDetailTitle(title, name, company, path) {
  const parsed = parseBossDetailTitle(title);
  if (!parsed || parsed.name !== name || parsed.company !== company)
    fail(`${path}.title does not match its job name and observed company`);
}

function validateConfirmation(record, path) {
  object(record, path);
  string(record.id, `${path}.id`, { max: 100 });
  const jobId = identityPart(record.jobId, `${path}.jobId`);
  const detailUrl = string(record.detailUrl, `${path}.detailUrl`, { max: 500 });
  if (jobIdFromUrl(detailUrl, `${path}.detailUrl`) !== jobId) fail(`${path} URL and job ID differ`);
  string(record.conversationKey, `${path}.conversationKey`, { max: 100 });
  if (record.status !== 'confirmed_user') fail(`${path}.status is invalid`);
  timestamp(record.confirmedAt, `${path}.confirmedAt`);
  string(record.source, `${path}.source`, { max: 100 });
  if (record.legacyKey !== undefined) string(record.legacyKey, `${path}.legacyKey`, { max: 200 });
  const facts = Object.fromEntries(
    Object.entries(record).filter(([key]) => !['id', 'attribution'].includes(key)),
  );
  if (record.id !== evidenceId('confirmation', facts))
    fail(`${path}.id does not match its confirmation facts`);
}

function validateEnvelopeVersion(input, allowedVersions) {
  const envelope = jsonClone(input, 'envelope');
  object(envelope, 'envelope');
  if (
    Object.keys(envelope).some(
      (key) =>
        ![
          'version',
          'scope',
          'accountNamespace',
          'createdAt',
          'updatedAt',
          'snapshot',
          'state',
          'report',
          'jobs',
          'migration',
          'resume',
        ].includes(key),
    )
  )
    fail('envelope contains unknown fields');
  if (!allowedVersions.includes(envelope.version) || envelope.scope !== V2_SCOPE) {
    fail('envelope has an unsupported version or scope');
  }
  envelope.accountNamespace = identityPart(envelope.accountNamespace, 'envelope.accountNamespace');
  timestamp(envelope.createdAt, 'envelope.createdAt');
  timestamp(envelope.updatedAt, 'envelope.updatedAt');
  if (Date.parse(envelope.createdAt) > Date.parse(envelope.updatedAt))
    fail('envelope timestamps are reversed');
  envelope.snapshot = validateLoadedSnapshotV2(envelope.snapshot);
  if (envelope.snapshot.accountNamespace !== envelope.accountNamespace)
    fail('snapshot belongs to another account namespace');
  object(envelope.state, 'envelope.state');
  timestamp(envelope.state.baselineCapturedAt, 'envelope.state.baselineCapturedAt');
  timestamp(envelope.state.lastCapturedAt, 'envelope.state.lastCapturedAt');
  if (
    envelope.state.lastCapturedAt !== envelope.snapshot.capturedAt ||
    Date.parse(envelope.state.baselineCapturedAt) > Date.parse(envelope.state.lastCapturedAt)
  ) {
    fail('chat state and snapshot timestamps are inconsistent');
  }
  if (!Array.isArray(envelope.state.records)) fail('envelope.state.records must be an array');
  envelope.state.records = envelope.state.records.map((record, index) =>
    validateStateRecord(record, envelope, `envelope.state.records[${index}]`),
  );
  uniqueBy(envelope.state.records, (record) => record.key, 'envelope.state.records');
  object(envelope.report, 'envelope.report');
  object(envelope.jobs, 'envelope.jobs');
  if (!Array.isArray(envelope.jobs.associations))
    fail('envelope.jobs.associations must be an array');
  envelope.jobs.associations.forEach((record, index) =>
    validateAssociation(record, envelope, `envelope.jobs.associations[${index}]`),
  );
  uniqueBy(envelope.jobs.associations, (record) => record.id, 'envelope.jobs.associations');
  const currentByConversation = envelope.jobs.associations.filter(
    (record) => record.status === 'current',
  );
  uniqueBy(
    currentByConversation,
    (record) => record.conversationKey,
    'current conversation-job associations',
  );
  for (const [name, kind] of [
    ['evidence', 'accepted'],
    ['candidates', 'candidate'],
  ]) {
    if (!Array.isArray(envelope.jobs[name])) fail(`envelope.jobs.${name} must be an array`);
    envelope.jobs[name].forEach((record, index) =>
      validateEvidence(record, kind, `envelope.jobs.${name}[${index}]`),
    );
    uniqueBy(envelope.jobs[name], (record) => record.id, `envelope.jobs.${name}`);
  }
  if (!Array.isArray(envelope.jobs.confirmations))
    fail('envelope.jobs.confirmations must be an array');
  envelope.jobs.confirmations.forEach((record, index) =>
    validateConfirmation(record, `envelope.jobs.confirmations[${index}]`),
  );
  uniqueBy(envelope.jobs.confirmations, (record) => record.id, 'envelope.jobs.confirmations');
  if (envelope.resume === undefined) {
    envelope.resume = {
      observations: [],
      lastScanAt: null,
      lastCoverage: null,
      lastUnresolved: [],
    };
  }
  object(envelope.resume, 'envelope.resume');
  if (!Array.isArray(envelope.resume.observations))
    fail('envelope.resume.observations must be an array');
  for (const [index, record] of envelope.resume.observations.entries()) {
    const path = `envelope.resume.observations[${index}]`;
    object(record, path);
    if (
      Object.keys(record).some(
        (key) =>
          ![
            'id',
            'conversationKey',
            'platformIdentity',
            'messageId',
            'direction',
            'messageType',
            'kind',
            'platformTime',
            'externalJobId',
            'observedAt',
            'source',
            'status',
            ...(envelope.version >= 4 ? ['attribution'] : []),
            ...(envelope.version >= 5 ? ['resumeEvidence'] : []),
          ].includes(key),
      )
    )
      fail('observation contains unknown fields');
    if (envelope.version >= 4) validateAttributionEvidence(record.attribution);
    else if (Object.hasOwn(record, 'attribution')) fail('legacy observation contains attribution');
    if (envelope.version >= 5) {
      const proof = validateResumeEvidence(record.resumeEvidence);
      if (proof?.version === 2 && envelope.version < 6)
        fail('resume evidence version requires envelope v6');
      if (proof && proof.messageType !== record.messageType)
        fail('resume evidence message type is inconsistent');
    } else if (Object.hasOwn(record, 'resumeEvidence'))
      fail('legacy observation contains resume evidence');
    string(record.id, `${path}.id`, { max: 100 });
    const conversationKey = string(record.conversationKey, `${path}.conversationKey`, { max: 100 });
    const conversation = envelope.state.records.find((item) => item.key === conversationKey);
    if (!conversation) fail(`${path}.conversationKey is unknown`);
    object(record.platformIdentity, `${path}.platformIdentity`);
    const identity = {
      friendId: identityPart(record.platformIdentity.friendId, `${path}.platformIdentity.friendId`),
      friendSource: identityPart(
        record.platformIdentity.friendSource,
        `${path}.platformIdentity.friendSource`,
      ),
      uniqueId: identityPart(record.platformIdentity.uniqueId, `${path}.platformIdentity.uniqueId`),
    };
    if (
      identity.uniqueId !== `${identity.friendId}-${identity.friendSource}` ||
      JSON.stringify(identity) !== JSON.stringify(conversation.platformIdentity)
    )
      fail(`${path}.platformIdentity is inconsistent`);
    string(record.messageId, `${path}.messageId`, { max: 128 });
    const statusKind = RESUME_STATUS_KINDS.includes(record.kind);
    if (
      !['inbound', 'outbound', 'system'].includes(record.direction) ||
      (!statusKind && record.messageType !== 4) ||
      !RESUME_KINDS.includes(record.kind) ||
      (!statusKind && (record.direction === 'outbound') !== (record.kind === 'sent_candidate')) ||
      (statusKind && record.direction !== 'system')
    )
      fail(`${path} message classification is invalid`);
    timestamp(record.platformTime, `${path}.platformTime`);
    if (record.externalJobId !== null) {
      const externalJobId = identityPart(record.externalJobId, `${path}.externalJobId`);
      if (!BOSS_JOB_ID.test(externalJobId)) fail(`${path}.externalJobId is invalid`);
    }
    timestamp(record.observedAt, `${path}.observedAt`);
    const expectedSources = statusKind
      ? ['geek_history_status_message', 'dom_chat_status_message_v1']
      : ['geek_history_type_4'];
    if (
      !expectedSources.includes(record.source) ||
      !['strong', 'review'].includes(record.status) ||
      (record.status === 'strong') !==
        ((record.kind === 'sent_candidate' || statusKind) && record.externalJobId !== null)
    ) {
      fail(`${path} evidence status is invalid`);
    }
    const facts = Object.fromEntries(
      Object.entries(record).filter(
        ([key]) => !['id', 'attribution', 'resumeEvidence'].includes(key),
      ),
    );
    const stableId = digest([
      'boss-v2-evidence',
      'resume_observation',
      record.conversationKey,
      record.messageId,
      record.direction,
      record.messageType,
      record.kind,
      record.platformTime,
      record.externalJobId,
      record.source,
    ]);
    const legacyId = evidenceId('resume_observation', facts);
    if (record.id !== stableId && record.id !== legacyId)
      fail(`${path}.id does not match its evidence facts`);
  }
  uniqueBy(envelope.resume.observations, (record) => record.id, 'envelope.resume.observations');
  if (envelope.resume.lastScanAt !== null)
    timestamp(envelope.resume.lastScanAt, 'envelope.resume.lastScanAt');
  if (!Array.isArray(envelope.resume.lastUnresolved))
    fail('envelope.resume.lastUnresolved must be an array');
  for (const [index, item] of envelope.resume.lastUnresolved.entries()) {
    object(item, `envelope.resume.lastUnresolved[${index}]`);
    string(item.conversationKey, `envelope.resume.lastUnresolved[${index}].conversationKey`, {
      max: 100,
    });
    string(item.reason, `envelope.resume.lastUnresolved[${index}].reason`, { max: 100 });
  }
  if (envelope.resume.lastCoverage !== null) {
    object(envelope.resume.lastCoverage, 'envelope.resume.lastCoverage');
    for (const key of ['requestedConversations', 'resolvedConversations', 'pagesPerConversation']) {
      if (
        !Number.isSafeInteger(envelope.resume.lastCoverage[key]) ||
        envelope.resume.lastCoverage[key] < 0
      ) {
        fail(`envelope.resume.lastCoverage.${key} must be a nonnegative integer`);
      }
    }
    for (const key of [
      'requestedPages',
      'completedPages',
      'exhaustedConversations',
      'truncatedConversations',
      'failedConversations',
    ]) {
      if (
        envelope.resume.lastCoverage[key] !== undefined &&
        (!Number.isSafeInteger(envelope.resume.lastCoverage[key]) ||
          envelope.resume.lastCoverage[key] < 0)
      ) {
        fail(`envelope.resume.lastCoverage.${key} must be a nonnegative integer`);
      }
    }
  }
  object(envelope.migration, 'envelope.migration');
  for (const field of ['importedLegacyKeys', 'runs', 'quarantine']) {
    if (!Array.isArray(envelope.migration[field]))
      fail(`envelope.migration.${field} must be an array`);
  }
  uniqueBy(
    envelope.migration.importedLegacyKeys,
    (value) => string(value, 'importedLegacyKey', { max: 300 }),
    'envelope.migration.importedLegacyKeys',
  );
  for (const [index, run] of envelope.migration.runs.entries()) {
    object(run, `envelope.migration.runs[${index}]`);
    string(run.sourceFingerprint, `envelope.migration.runs[${index}].sourceFingerprint`, {
      max: 100,
    });
    timestamp(run.importedAt, `envelope.migration.runs[${index}].importedAt`);
    timestamp(run.sourceCapturedAt, `envelope.migration.runs[${index}].sourceCapturedAt`);
    timestamp(run.targetCapturedAt, `envelope.migration.runs[${index}].targetCapturedAt`);
    if (run.fingerprint !== digest([run.sourceFingerprint, run.targetCapturedAt])) {
      fail(`envelope.migration.runs[${index}].fingerprint is inconsistent`);
    }
  }
  uniqueBy(
    envelope.migration.runs,
    (value) => string(value.fingerprint, 'migration run fingerprint', { max: 100 }),
    'envelope.migration.runs',
  );
  for (const [index, item] of envelope.migration.quarantine.entries()) {
    object(item, `envelope.migration.quarantine[${index}]`);
    string(item.reason, `envelope.migration.quarantine[${index}].reason`, { max: 200 });
    const facts = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id'));
    if (item.id !== evidenceId('quarantine', facts))
      fail(`envelope.migration.quarantine[${index}].id is inconsistent`);
  }
  uniqueBy(
    envelope.migration.quarantine,
    (value) => string(value.id, 'quarantine id', { max: 100 }),
    'envelope.migration.quarantine',
  );
  return envelope;
}

/** Validate a legacy v2 envelope without silently changing its on-disk format. */
export function validateEnvelopeV2(input) {
  return validateEnvelopeVersion(input, [2]);
}

/** Validate the current v6 envelope format. */
export function validateCurrentEnvelope(input) {
  return validateEnvelopeVersion(input, [6]);
}

/** Read supported versions without upgrading a read-only operation. */
export function validateEnvelope(input) {
  return validateEnvelopeVersion(input, [2, 3, 4, 5, 6]);
}

/** Explicit, shape-preserving adapter used before every mutation or new commit. */
export function upgradeEnvelope(input) {
  const envelope = validateEnvelope(input);
  envelope.version = 6;
  for (const observation of envelope.resume.observations) {
    observation.attribution ??= null;
    observation.resumeEvidence ??= null;
  }
  return validateCurrentEnvelope(envelope);
}

function addUnique(array, item) {
  if (!array.some((existing) => existing.id === item.id)) array.push(item);
}

function setAssociation(envelope, record, capturedAt, source) {
  const { jobId, detailUrl } = record.jobAssociation;
  const forConversation = envelope.jobs.associations.filter(
    (item) => item.conversationKey === record.key,
  );
  if (jobId === null) {
    for (const association of forConversation.filter((item) => item.status === 'current')) {
      association.status = 'historical';
      association.historicalReason = 'job_not_observed';
    }
    return;
  }
  for (const association of forConversation.filter(
    (item) => item.status === 'current' && item.jobId !== jobId,
  )) {
    association.status = 'historical';
    association.historicalReason = 'different_job_observed';
  }
  let association = forConversation.find((item) => item.jobId === jobId);
  if (!association) {
    association = {
      id: associationId(record.key, jobId),
      conversationKey: record.key,
      jobId,
      detailUrl,
      status: 'current',
      firstObservedAt: capturedAt,
      lastObservedAt: capturedAt,
      source,
    };
    envelope.jobs.associations.push(association);
  } else {
    association.detailUrl = detailUrl;
    association.status = 'current';
    association.lastObservedAt = capturedAt;
    association.source = source === 'loaded_chat_state' ? source : association.source;
    delete association.historicalReason;
  }
  if (record.observedJobName !== null) {
    const evidence = {
      jobId,
      detailUrl,
      name: record.observedJobName,
      source: 'loaded_jobName',
      observedAt: capturedAt,
      conversationKey: record.key,
      company: record.company,
    };
    evidence.id = evidenceId('accepted', evidence);
    addUnique(envelope.jobs.evidence, evidence);
  }
}

function sortedEnvelope(envelope) {
  envelope.state.records.sort((a, b) => a.key.localeCompare(b.key));
  envelope.jobs.associations.sort((a, b) => a.id.localeCompare(b.id));
  envelope.jobs.evidence.sort((a, b) => a.id.localeCompare(b.id));
  envelope.jobs.candidates.sort((a, b) => a.id.localeCompare(b.id));
  envelope.jobs.confirmations.sort((a, b) => a.id.localeCompare(b.id));
  envelope.resume.observations.sort((a, b) => a.id.localeCompare(b.id));
  envelope.migration.importedLegacyKeys.sort();
  envelope.migration.runs.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  envelope.migration.quarantine.sort((a, b) => a.id.localeCompare(b.id));
  return envelope;
}

/**
 * Compare one loaded-list capture. Missing conversations remain in history.
 * Receipt transitions are reported only when both observations carry the same
 * non-null platform message ID; otherwise a known receipt is only an observation.
 */
export function compareLoadedSnapshotsV2(previousEnvelope, inputSnapshot) {
  const snapshot = validateLoadedSnapshotV2(inputSnapshot);
  const envelope =
    previousEnvelope === null ? emptyEnvelope(snapshot) : upgradeEnvelope(previousEnvelope);
  if (envelope.accountNamespace !== snapshot.accountNamespace)
    fail('snapshot belongs to another account namespace');
  if (Date.parse(snapshot.capturedAt) < Date.parse(envelope.state.lastCapturedAt))
    fail('snapshot is older than the saved state');
  if (
    previousEnvelope !== null &&
    Date.parse(snapshot.capturedAt) < Date.parse(envelope.updatedAt)
  ) {
    fail('snapshot precedes a later saved enrichment or migration');
  }
  const baseline = previousEnvelope === null;
  envelope.snapshot = jsonClone(snapshot);
  envelope.updatedAt = snapshot.capturedAt;
  envelope.state.lastCapturedAt = snapshot.capturedAt;

  const groups = new Map();
  for (const record of snapshot.records)
    groups.set(record.key, [...(groups.get(record.key) ?? []), record]);
  const state = new Map(envelope.state.records.map((record) => [record.key, record]));
  const changes = [];
  const ambiguities = [];
  const counts = {
    receivedRecords: snapshot.records.length,
    comparedRecords: 0,
    baselineRecords: 0,
    firstObserved: 0,
    profileChanged: 0,
    previewChanged: 0,
    latestMessageChanged: 0,
    unreadChanged: 0,
    receiptObserved: 0,
    receiptChanged: 0,
    receiptTransitionSuppressed: 0,
    currentJobAssociations: 0,
    historicalJobAssociations: 0,
    notObservedThisCapture: 0,
    ambiguousKeys: 0,
    skippedAmbiguousRecords: 0,
  };

  for (const [key, records] of groups) {
    if (records.length !== 1) {
      ambiguities.push({ key, count: records.length, reason: 'duplicate_platform_identity' });
      counts.ambiguousKeys += 1;
      counts.skippedAmbiguousRecords += records.length;
      continue;
    }
    const current = records[0];
    const previous = state.get(key) ?? null;
    if (baseline) counts.baselineRecords += 1;
    else if (!previous) {
      counts.firstObserved += 1;
      changes.push({ type: 'first_observed', conversationKey: key });
    } else {
      counts.comparedRecords += 1;
      const profileFields = ['contact', 'company', 'title'].filter(
        (field) => previous[field] !== current[field],
      );
      if (profileFields.length) {
        counts.profileChanged += 1;
        changes.push({ type: 'profile_changed', conversationKey: key, fields: profileFields });
      }
      const prior = previous.latestObservation;
      if (prior.preview !== current.preview) {
        counts.previewChanged += 1;
        changes.push({ type: 'preview_changed', conversationKey: key });
      }
      if (prior.latestMessageId !== current.latestMessageId) {
        counts.latestMessageChanged += 1;
        changes.push({
          type: 'latest_message_changed',
          conversationKey: key,
          before: prior.latestMessageId,
          after: current.latestMessageId,
        });
      }
      if (prior.unread !== null && current.unread !== null && prior.unread !== current.unread) {
        counts.unreadChanged += 1;
        changes.push({
          type: 'unread_changed',
          conversationKey: key,
          before: prior.unread,
          after: current.unread,
        });
      }
      const beforeReceipt = prior.outgoingReceipt;
      const afterReceipt = current.outgoingReceipt;
      if (afterReceipt.status !== 'unknown' && beforeReceipt.status !== afterReceipt.status) {
        const sameMessage =
          prior.latestMessageId !== null &&
          current.latestMessageId !== null &&
          prior.latestMessageId === current.latestMessageId;
        if (beforeReceipt.status !== 'unknown' && sameMessage) {
          counts.receiptChanged += 1;
          changes.push({
            type: 'receipt_changed',
            conversationKey: key,
            messageId: current.latestMessageId,
            before: beforeReceipt.status,
            after: afterReceipt.status,
          });
        } else {
          counts.receiptObserved += 1;
          if (beforeReceipt.status !== 'unknown') counts.receiptTransitionSuppressed += 1;
          changes.push({
            type: 'receipt_observed',
            conversationKey: key,
            messageId: current.latestMessageId,
            status: afterReceipt.status,
            transitionSuppressed: beforeReceipt.status !== 'unknown' && !sameMessage,
          });
        }
      }
    }
    state.set(key, stateRecordFrom(current, snapshot.capturedAt, previous));
    setAssociation(envelope, current, snapshot.capturedAt, 'loaded_chat_state');
  }
  counts.notObservedThisCapture = [...state.keys()].filter((key) => !groups.has(key)).length;
  envelope.state.records = [...state.values()];
  counts.currentJobAssociations = envelope.jobs.associations.filter(
    (item) => item.status === 'current',
  ).length;
  counts.historicalJobAssociations = envelope.jobs.associations.filter(
    (item) => item.status === 'historical',
  ).length;
  sortedEnvelope(envelope);
  const report = {
    mode: baseline ? 'baseline' : 'comparison',
    capturedAt: snapshot.capturedAt,
    previousCapturedAt: previousEnvelope?.state?.lastCapturedAt ?? null,
    counts,
    changes,
    ambiguities,
    coverage: jsonClone(snapshot.coverage),
    warnings: [
      'Only the already-loaded chat list was observed; absence is not evidence of deletion.',
      'Receipt transitions require the same non-null platform message ID in both observations.',
      'A missing job field preserves job history but does not prove that a job was removed.',
    ],
  };
  envelope.report = jsonClone(report);
  return { envelope, report };
}

function validateLegacySources(v1Envelope, enrichedJobs) {
  object(v1Envelope, 'v1Envelope');
  if (v1Envelope.version !== 1) fail('v1Envelope.version must be 1');
  object(v1Envelope.state, 'v1Envelope.state');
  if (!Array.isArray(v1Envelope.state.records)) fail('v1Envelope.state.records must be an array');
  timestamp(v1Envelope.state.lastCapturedAt, 'v1Envelope.state.lastCapturedAt');
  object(enrichedJobs, 'enrichedJobs');
  if (enrichedJobs.version !== 1 || !Array.isArray(enrichedJobs.rows))
    fail('enrichedJobs must be the version-1 derived job list');
  timestamp(enrichedJobs.inboxCapturedAt, 'enrichedJobs.inboxCapturedAt');
  return {
    legacy: jsonClone(v1Envelope),
    enriched: jsonClone(enrichedJobs),
    sourceFingerprint: digest([
      'legacy-v1',
      v1Envelope.account ?? null,
      v1Envelope.state.lastCapturedAt,
      enrichedJobs,
    ]),
  };
}

function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value]);
  return groups;
}

function legacyPair(record) {
  return JSON.stringify([normText(record.contact), normText(record.company)]);
}

function legacyJob(record, row) {
  const first = row?.detailUrl ?? null;
  const second = record.job?.detailUrl ?? null;
  if (first && second && first !== second) return { conflict: true };
  const detailUrl = first ?? second;
  if (!detailUrl) return { conflict: false, jobId: null, detailUrl: null };
  return { conflict: false, jobId: jobIdFromUrl(detailUrl, 'legacy job URL'), detailUrl };
}

function addQuarantine(envelope, sourceFingerprint, legacyRecord, reason, detail = null) {
  const item = {
    sourceFingerprint,
    legacyKey: legacyRecord?.key ?? null,
    contact: normText(legacyRecord?.contact),
    company: normText(legacyRecord?.company),
    reason,
    detail,
  };
  item.id = evidenceId('quarantine', item);
  addUnique(envelope.migration.quarantine, item);
  return item;
}

function importAccepted(envelope, mapping, row, job) {
  if (!row?.name) return false;
  const source =
    row.nameSource === 'loaded_jobName'
      ? 'loaded_jobName'
      : row.nameSource === 'detail_page_title'
        ? 'detail_page_title'
        : 'legacy_named_job';
  const observedAt =
    source === 'detail_page_title' ? row.detailTitleObservation?.observedAt : row.loadedObservedAt;
  timestamp(observedAt, 'enriched job name observedAt');
  const evidence = {
    jobId: job.jobId,
    detailUrl: job.detailUrl,
    name: string(row.name, 'enriched job name', { max: 300 }),
    source,
    observedAt,
    conversationKey: mapping.key,
    company: mapping.company,
    legacyKey: row.key,
  };
  if (source === 'detail_page_title') {
    evidence.title = string(row.detailTitleObservation?.title, 'detail title evidence', {
      max: 1000,
    });
  }
  evidence.id = evidenceId('accepted', evidence);
  const before = envelope.jobs.evidence.length;
  addUnique(envelope.jobs.evidence, evidence);
  return envelope.jobs.evidence.length > before;
}

function importCandidate(envelope, mapping, row, job) {
  const candidate = row?.candidateTitleObservation;
  if (!candidate) return false;
  const evidence = {
    jobId: job.jobId,
    detailUrl: job.detailUrl,
    name: string(candidate.name, 'candidate name', { max: 300 }),
    source: string(candidate.source, 'candidate source', { max: 100 }),
    observedAt: timestamp(candidate.observedAt, 'candidate observedAt'),
    conversationKey: mapping.key,
    company: mapping.company,
    legacyKey: row.key,
    reason: 'detail_company_mismatch',
    observedCompany: string(candidate.observedCompany, 'candidate observedCompany', { max: 500 }),
    expectedCompany: mapping.company,
    title: string(candidate.title, 'candidate title', { max: 1000 }),
  };
  evidence.id = evidenceId('candidate', evidence);
  const before = envelope.jobs.candidates.length;
  addUnique(envelope.jobs.candidates, evidence);
  return envelope.jobs.candidates.length > before;
}

function importConfirmation(envelope, mapping, legacy, row, job, importedAt) {
  const confirmed =
    row?.confirmation === 'confirmed_user' ||
    (legacy.job?.detailUrl === job.detailUrl &&
      legacy.job?.detailUrlConfirmation === 'confirmed_user');
  if (!confirmed) return false;
  const confirmedAt = timestamp(
    legacy.__envelopeConfirmedAt ?? row.loadedObservedAt ?? importedAt,
    'legacy confirmation time',
  );
  const confirmation = {
    jobId: job.jobId,
    detailUrl: job.detailUrl,
    conversationKey: mapping.key,
    status: 'confirmed_user',
    confirmedAt,
    source: 'legacy_user_confirmation',
    legacyKey: legacy.key,
  };
  confirmation.id = evidenceId('confirmation', confirmation);
  const before = envelope.jobs.confirmations.length;
  addUnique(envelope.jobs.confirmations, confirmation);
  return envelope.jobs.confirmations.length > before;
}

/**
 * Import legacy name/company-keyed state after a stable platform-ID capture.
 * Mapping is allowed only for a unique normalized contact+company pair on both
 * sides and a compatible known job ID. Ambiguities are quarantined, never guessed.
 */
export function importLegacyV1ToV2(inputEnvelope, { v1Envelope, enrichedJobs, importedAt }) {
  const envelope = upgradeEnvelope(inputEnvelope);
  timestamp(importedAt, 'importedAt');
  if (Date.parse(importedAt) < Date.parse(envelope.updatedAt))
    fail('importedAt precedes the v2 capture');
  const { legacy, enriched, sourceFingerprint } = validateLegacySources(v1Envelope, enrichedJobs);
  const runFingerprint = digest([sourceFingerprint, envelope.state.lastCapturedAt]);
  if (envelope.migration.runs.some((run) => run.fingerprint === runFingerprint)) {
    return {
      envelope,
      report: { alreadyImported: true, sourceFingerprint, counts: { imported: 0, quarantined: 0 } },
    };
  }
  const legacyRecords = legacy.state.records.map((record) => ({
    ...record,
    __envelopeConfirmedAt:
      legacy.jobEvidence?.recordKey === record.key
        ? (legacy.jobEvidence.confirmedAt ?? legacy.confirmedAt)
        : undefined,
  }));
  const oldPairs = groupBy(legacyRecords, legacyPair);
  const newPairs = groupBy(envelope.state.records, legacyPair);
  const enrichedByKey = groupBy(enriched.rows, (row) => row.key);
  const currentCapture = new Map(envelope.snapshot.records.map((record) => [record.key, record]));
  const importedTokens = new Set(envelope.migration.importedLegacyKeys);
  const counts = {
    legacyRecords: legacyRecords.length,
    matched: 0,
    imported: 0,
    alreadyPresent: 0,
    acceptedEvidence: 0,
    candidates: 0,
    confirmations: 0,
    associations: 0,
    quarantined: 0,
  };

  for (const legacyRecord of legacyRecords) {
    const token = `${sourceFingerprint}:${legacyRecord.key}`;
    if (importedTokens.has(token)) {
      counts.alreadyPresent += 1;
      continue;
    }
    const pair = legacyPair(legacyRecord);
    const oldGroup = oldPairs.get(pair) ?? [];
    const newGroup = newPairs.get(pair) ?? [];
    const jobRows = enrichedByKey.get(legacyRecord.key) ?? [];
    let reason = null;
    if (oldGroup.length !== 1) reason = 'ambiguous_legacy_name_company';
    else if (newGroup.length === 0) reason = 'no_platform_identity_match';
    else if (newGroup.length !== 1) reason = 'ambiguous_platform_name_company';
    else if (jobRows.length > 1) reason = 'ambiguous_enriched_job_rows';
    const row = jobRows[0] ?? null;
    const job = legacyJob(legacyRecord, row);
    if (!reason && job.conflict) reason = 'legacy_job_source_conflict';
    const mapping = newGroup[0] ?? null;
    const observedJob = mapping ? currentCapture.get(mapping.key)?.jobAssociation : null;
    if (!reason && job.jobId && observedJob?.jobId && observedJob.jobId !== job.jobId)
      reason = 'platform_job_mismatch';
    if (reason) {
      addQuarantine(
        envelope,
        sourceFingerprint,
        legacyRecord,
        reason,
        job.jobId && observedJob?.jobId
          ? { legacyJobId: job.jobId, observedJobId: observedJob.jobId }
          : null,
      );
      counts.quarantined += 1;
      continue;
    }
    counts.matched += 1;
    if (job.jobId) {
      let association = envelope.jobs.associations.find(
        (item) => item.conversationKey === mapping.key && item.jobId === job.jobId,
      );
      if (!association) {
        association = {
          id: associationId(mapping.key, job.jobId),
          conversationKey: mapping.key,
          jobId: job.jobId,
          detailUrl: job.detailUrl,
          status: 'historical',
          firstObservedAt: enriched.inboxCapturedAt,
          lastObservedAt: enriched.inboxCapturedAt,
          source: 'legacy_v1_unique_name_company',
          legacyKey: legacyRecord.key,
          historicalReason: 'not_observed_in_v2_capture',
        };
        envelope.jobs.associations.push(association);
        counts.associations += 1;
      }
      if (importAccepted(envelope, mapping, row, job)) counts.acceptedEvidence += 1;
      if (importCandidate(envelope, mapping, row, job)) counts.candidates += 1;
      if (importConfirmation(envelope, mapping, legacyRecord, row, job, importedAt))
        counts.confirmations += 1;
    }
    importedTokens.add(token);
    counts.imported += 1;
  }

  const legacyKeys = new Set(legacyRecords.map((record) => record.key));
  for (const row of enriched.rows.filter((row) => !legacyKeys.has(row.key))) {
    addQuarantine(envelope, sourceFingerprint, row, 'enriched_row_without_legacy_conversation');
    counts.quarantined += 1;
  }
  envelope.migration.importedLegacyKeys = [...importedTokens];
  const run = {
    fingerprint: runFingerprint,
    sourceFingerprint,
    importedAt,
    sourceCapturedAt: legacy.state.lastCapturedAt,
    targetCapturedAt: envelope.state.lastCapturedAt,
    matched: counts.matched,
    imported: counts.imported,
    quarantined: counts.quarantined,
  };
  envelope.migration.runs.push(run);
  envelope.updatedAt = importedAt;
  sortedEnvelope(envelope);
  return {
    envelope,
    report: {
      alreadyImported: false,
      sourceFingerprint,
      counts,
      warnings: [
        'Legacy contact/company values were used only for unique migration matching; v2 identity remains platform-ID based.',
        'Quarantined records were not associated or used as job evidence.',
        'User confirmation is scoped to the exact conversation, job ID and canonical URL.',
      ],
    },
  };
}

/** Convenience for the first stable capture plus one legacy import. */
export function migrateV1ToV2({ snapshot, v1Envelope, enrichedJobs, migratedAt }) {
  const baseline = compareLoadedSnapshotsV2(null, snapshot);
  const migration = importLegacyV1ToV2(baseline.envelope, {
    v1Envelope,
    enrichedJobs,
    importedAt: migratedAt,
  });
  return {
    envelope: migration.envelope,
    report: { capture: baseline.report, migration: migration.report },
  };
}

/** Explicit baseline constructor for tracker/storage callers. */
export function createEnvelopeV2(snapshot) {
  return compareLoadedSnapshotsV2(null, snapshot);
}

/** Resolve a stable, privacy-minimal export/status view without mutating input. */
export function resolveJobRowsV2(inputEnvelope) {
  const envelope = validateEnvelope(inputEnvelope);
  return envelope.state.records
    .map((conversation) => {
      const associations = envelope.jobs.associations
        .filter((item) => item.conversationKey === conversation.key)
        .sort(
          (a, b) =>
            (a.status === 'current' ? -1 : 1) - (b.status === 'current' ? -1 : 1) ||
            Date.parse(b.lastObservedAt) - Date.parse(a.lastObservedAt),
        );
      const association = associations[0] ?? null;
      const { selected, confirmed } = resolveBossJobEvidence(
        {
          association,
          conversation,
          evidence: envelope.jobs.evidence,
          confirmations: envelope.jobs.confirmations,
        },
        'collector',
      );
      const candidates = association
        ? envelope.jobs.candidates
            .filter(
              (item) =>
                item.conversationKey === conversation.key &&
                item.jobId === association.jobId &&
                item.detailUrl === association.detailUrl,
            )
            .map((item) => ({
              name: item.name,
              observedCompany: item.observedCompany,
              observedAt: item.observedAt,
              source: item.source,
              reason: item.reason,
            }))
        : [];
      return {
        conversationKey: conversation.key,
        contact: conversation.contact,
        company: selected?.source === 'detail_page_title' ? selected.company : conversation.company,
        jobId: association?.jobId ?? null,
        detailUrl: association?.detailUrl ?? null,
        associationStatus: association?.status ?? null,
        jobName: selected?.name ?? null,
        nameSource: selected?.source ?? null,
        nameObservedAt: selected?.observedAt ?? null,
        confirmation: confirmed ? 'confirmed_user' : association ? 'unverified' : null,
        candidates,
      };
    })
    .sort((a, b) => a.conversationKey.localeCompare(b.conversationKey));
}

/** List exact saved associations for the separate, bounded detail-page helper. */
export function listEnrichmentTargetsV2(inputEnvelope) {
  const envelope = validateEnvelope(inputEnvelope);
  const conversations = new Map(envelope.state.records.map((record) => [record.key, record]));
  const targets = envelope.jobs.associations
    .map((association) => {
      const conversation = conversations.get(association.conversationKey);
      if (!conversation) return null;
      const { evidence, conflict } = resolveBossJobEvidence(
        {
          association,
          conversation,
          evidence: envelope.jobs.evidence,
          confirmations: envelope.jobs.confirmations,
        },
        'collector',
      );
      const candidates = envelope.jobs.candidates
        .filter(
          (item) =>
            item.conversationKey === association.conversationKey &&
            item.jobId === association.jobId &&
            item.detailUrl === association.detailUrl,
        )
        .map((item) => ({
          name: item.name,
          observedCompany: item.observedCompany,
          observedAt: item.observedAt,
          source: item.source,
          reason: item.reason,
        }));
      return {
        conversationKey: association.conversationKey,
        contact: conversation.contact,
        company: conversation.company,
        jobId: association.jobId,
        detailUrl: association.detailUrl,
        associationStatus: association.status,
        knownEvidence: (conflict ? [] : evidence).map((item) => ({
          name: item.name,
          company: item.company,
          title: item.title ?? null,
          observedAt: item.observedAt,
          source: item.source,
        })),
        candidates,
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        (a.knownEvidence.length ? 1 : 0) - (b.knownEvidence.length ? 1 : 0) ||
        (a.associationStatus === 'current' ? -1 : 1) -
          (b.associationStatus === 'current' ? -1 : 1) ||
        a.conversationKey.localeCompare(b.conversationKey),
    );
  return { capturedAt: envelope.snapshot.capturedAt, targets };
}

function detailInput(value, path) {
  object(value, path);
  const conversationKey = string(value.conversationKey, `${path}.conversationKey`, { max: 100 });
  const jobId = identityPart(value.jobId, `${path}.jobId`);
  const detailUrl = string(value.detailUrl, `${path}.detailUrl`, { max: 500 });
  if (
    jobIdFromUrl(detailUrl, `${path}.detailUrl`) !== jobId ||
    canonicalJobUrlV2(jobId) !== detailUrl
  ) {
    fail(`${path} URL and job ID differ`);
  }
  return {
    conversationKey,
    jobId,
    detailUrl,
    name: string(value.name, `${path}.name`, { max: 300 }),
    observedAt: timestamp(value.observedAt, `${path}.observedAt`),
    source: string(value.source, `${path}.source`, { max: 100 }),
    title:
      value.title === null || value.title === undefined
        ? null
        : string(value.title, `${path}.title`, { max: 1000 }),
  };
}

/**
 * Add independently timed detail-page results without changing snapshot/state.
 * Verified detail evidence supplies its observed employer; the conversation
 * retains the recruiter. Explicit legacy candidates remain candidates.
 * Exact association identity is required for every result.
 */
export function applyDetailEvidenceV2(inputEnvelope, result, appliedAt) {
  const envelope = upgradeEnvelope(inputEnvelope);
  object(result, 'result');
  if (!Array.isArray(result.observations) || !Array.isArray(result.candidates)) {
    fail('result.observations and result.candidates must be arrays');
  }
  timestamp(appliedAt, 'appliedAt');
  if (Date.parse(appliedAt) < Date.parse(envelope.updatedAt))
    fail('appliedAt precedes the saved envelope');
  const conversations = new Map(envelope.state.records.map((record) => [record.key, record]));
  const associationFor = (item, path) => {
    const association = envelope.jobs.associations.find(
      (saved) =>
        saved.conversationKey === item.conversationKey &&
        saved.jobId === item.jobId &&
        saved.detailUrl === item.detailUrl,
    );
    if (!association) fail(`${path} does not match an exact saved conversation-job association`);
    const conversation = conversations.get(item.conversationKey);
    if (!conversation) fail(`${path} refers to an unknown conversation`);
    return { association, conversation };
  };
  const counts = {
    observations: result.observations.length,
    candidates: result.candidates.length,
    accepted: 0,
    candidateSaved: 0,
    duplicates: 0,
    companyMismatch: 0,
  };

  for (const [index, value] of result.observations.entries()) {
    const path = `result.observations[${index}]`;
    const item = detailInput(value, path);
    if (Date.parse(item.observedAt) > Date.parse(appliedAt))
      fail(`${path}.observedAt is later than appliedAt`);
    associationFor(item, path);
    if (item.source !== 'detail_page_title') fail(`${path}.source must be detail_page_title`);
    if (item.title === null) fail(`${path}.title is required for detail-page evidence`);
    const observedCompany = string(value.company, `${path}.company`, { empty: true, max: 500 });
    validateDetailTitle(item.title, item.name, observedCompany, path);
    const evidence = { ...item, company: observedCompany };
    evidence.id = evidenceId('accepted', evidence);
    const before = envelope.jobs.evidence.length;
    addUnique(envelope.jobs.evidence, evidence);
    counts[envelope.jobs.evidence.length > before ? 'accepted' : 'duplicates'] += 1;
  }

  for (const [index, value] of result.candidates.entries()) {
    const path = `result.candidates[${index}]`;
    const item = detailInput(value, path);
    if (Date.parse(item.observedAt) > Date.parse(appliedAt))
      fail(`${path}.observedAt is later than appliedAt`);
    if (item.title === null) fail(`${path}.title is required for detail-page candidates`);
    const { conversation } = associationFor(item, path);
    const expectedCompany = string(value.expectedCompany, `${path}.expectedCompany`, {
      empty: true,
      max: 500,
    });
    if (normText(expectedCompany) !== normText(conversation.company))
      fail(`${path}.expectedCompany does not match the conversation`);
    const observedCompany = string(value.observedCompany, `${path}.observedCompany`, { max: 500 });
    if (normText(observedCompany) === normText(expectedCompany))
      fail(`${path} is not a company-mismatch candidate`);
    const reason = string(value.reason, `${path}.reason`, { max: 200 });
    if (reason !== 'detail_company_mismatch') fail(`${path}.reason is invalid`);
    validateDetailTitle(item.title, item.name, observedCompany, path);
    const candidate = {
      ...item,
      company: conversation.company,
      expectedCompany,
      observedCompany,
      reason,
    };
    candidate.id = evidenceId('candidate', candidate);
    const before = envelope.jobs.candidates.length;
    addUnique(envelope.jobs.candidates, candidate);
    counts[envelope.jobs.candidates.length > before ? 'candidateSaved' : 'duplicates'] += 1;
  }
  if (counts.accepted || counts.candidateSaved) envelope.updatedAt = appliedAt;
  sortedEnvelope(envelope);
  return {
    envelope,
    report: {
      appliedAt,
      counts,
      warnings: [
        'Detail evidence was stored separately; snapshot/state and message observation timestamps were not changed.',
        'Detail evidence supplies the employer; the conversation retains the recruiter and explicit legacy candidates remain unchanged.',
      ],
    },
  };
}

// Read-only legacy API aliases; new writes always use the current adapter.
export const validateEnvelopeV2OrV3 = (input) => validateEnvelopeVersion(input, [2, 3]);
export const validateEnvelopeV3 = (input) => validateEnvelopeVersion(input, [3]);
export const upgradeEnvelopeToV3 = (input) => {
  const value = validateEnvelopeV2OrV3(input);
  value.version = 3;
  return validateEnvelopeV3(value);
};
