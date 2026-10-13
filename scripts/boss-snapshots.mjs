import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BOSS_JOB_ID } from '../dist/boss-job-url.js';
import { validateAttributionEvidence } from '../dist/boss-attribution.js';
import {
  RESUME_KINDS,
  RESUME_STATUS_KINDS,
  RESUME_RULES,
  classifyResumeText,
  validateResumeEvidence,
} from '../dist/resume-rules.js';
import { stableHash } from './boss-conversion.mjs';
import { integrationFail } from './boss-integration-error.mjs';

export const SNAPSHOT_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9-]{36}\.json$/;
const ACCOUNT_NAMESPACE = /^boss-geek:[a-f0-9]{64}$/;
const MAX_SNAPSHOT_BYTES = 25_000_000;

function plain(value, code = 'BOSS_SNAPSHOT_STRUCTURE_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    integrationFail(code, { fatal: true });
  return value;
}

function exactKeys(value, keys, code = 'BOSS_SNAPSHOT_STRUCTURE_INVALID') {
  plain(value, code);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()))
    integrationFail(code, { fatal: true });
}

function requiredString(value, { max = 5_000, pattern } = {}) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes('\0') &&
    (!pattern || pattern.test(value))
  );
}

function optionalString(value, max = 5_000) {
  return typeof value === 'string' && value.length <= max && !value.includes('\0');
}

function isIso(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function bytesHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function regularFile(path, { maxBytes = MAX_SNAPSHOT_BYTES } = {}) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') integrationFail('BOSS_SNAPSHOT_NOT_FOUND');
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink())
    integrationFail('BOSS_SNAPSHOT_PATH_INVALID', { fatal: true });
  if (info.size > maxBytes) integrationFail('BOSS_SNAPSHOT_TOO_LARGE', { fatal: true });
  return info;
}

function validateCoverage(value, records) {
  exactKeys(value, [
    'loadedRows',
    'loadedDataRows',
    'unresolvedRows',
    'renderedRows',
    'offscreenRows',
    'truncated',
  ]);
  for (const key of [
    'loadedRows',
    'loadedDataRows',
    'unresolvedRows',
    'renderedRows',
    'offscreenRows',
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0)
      integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  }
  if (
    typeof value.truncated !== 'boolean' ||
    value.loadedDataRows < records ||
    value.loadedRows < value.renderedRows ||
    value.loadedDataRows < value.offscreenRows
  )
    integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  return structuredClone(value);
}

function conversationKey(accountNamespace, friendId, friendSource) {
  return stableHash([
    'boss',
    accountNamespace,
    String(friendId).trim(),
    String(friendSource).trim(),
  ]);
}

function validateRecord(record, accountNamespace) {
  exactKeys(record, [
    'key',
    'platformIdentity',
    'contact',
    'company',
    'title',
    'preview',
    'timeLabel',
    'unread',
    'latestMessageId',
    'outgoingReceipt',
    'jobAssociation',
    'observedJobName',
  ]);
  exactKeys(record.platformIdentity, ['friendId', 'friendSource', 'uniqueId']);
  const identity = record.platformIdentity;
  for (const key of ['friendId', 'friendSource', 'uniqueId']) {
    if (!requiredString(identity[key], { max: 300 }))
      integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  }
  if (
    identity.uniqueId !== `${identity.friendId}-${identity.friendSource}` ||
    record.key !== conversationKey(accountNamespace, identity.friendId, identity.friendSource)
  )
    integrationFail('BOSS_SNAPSHOT_IDENTITY_INVALID', { fatal: true });
  for (const [key, max] of [
    ['contact', 300],
    ['company', 500],
    ['title', 500],
    ['preview', 5_000],
    ['timeLabel', 100],
  ])
    if (!optionalString(record[key], max))
      integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  if (record.unread !== null) integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  if (record.latestMessageId !== null && !requiredString(record.latestMessageId, { max: 300 }))
    integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  exactKeys(record.outgoingReceipt, ['status', 'label', 'source']);
  const receipt = record.outgoingReceipt;
  if (!['read', 'delivered', 'unknown'].includes(receipt.status))
    integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  const knownReceipt = ['read', 'delivered'].includes(receipt.status);
  if (
    (knownReceipt &&
      (receipt.source !== 'list_receipt_label' ||
        receipt.label !== (receipt.status === 'read' ? '[已读]' : '[送达]'))) ||
    (!knownReceipt && (receipt.source !== null || receipt.label !== null))
  )
    integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  exactKeys(record.jobAssociation, ['jobId', 'detailUrl']);
  const { jobId, detailUrl } = record.jobAssociation;
  if ((jobId === null) !== (detailUrl === null))
    integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  if (jobId !== null) {
    if (
      !requiredString(jobId, { max: 300, pattern: BOSS_JOB_ID }) ||
      detailUrl !== `https://www.zhipin.com/job_detail/${jobId}.html`
    )
      integrationFail('BOSS_SNAPSHOT_JOB_INVALID', { fatal: true });
  }
  if (record.observedJobName !== null && !requiredString(record.observedJobName, { max: 300 }))
    integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  return structuredClone(record);
}

function validateHistoricalConversation(
  record,
  accountNamespace,
  baselineCapturedAt,
  lastCapturedAt,
) {
  exactKeys(record, [
    'key',
    'platformIdentity',
    'contact',
    'company',
    'title',
    'firstObservedAt',
    'lastObservedAt',
    'latestObservation',
  ]);
  exactKeys(record.latestObservation, [
    'preview',
    'timeLabel',
    'unread',
    'latestMessageId',
    'outgoingReceipt',
  ]);
  if (
    !isIso(record.firstObservedAt) ||
    !isIso(record.lastObservedAt) ||
    Date.parse(record.firstObservedAt) > Date.parse(record.lastObservedAt) ||
    Date.parse(record.firstObservedAt) < Date.parse(baselineCapturedAt) ||
    Date.parse(record.lastObservedAt) > Date.parse(lastCapturedAt)
  )
    integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  return validateRecord(
    {
      key: record.key,
      platformIdentity: record.platformIdentity,
      contact: record.contact,
      company: record.company,
      title: record.title,
      preview: record.latestObservation.preview,
      timeLabel: record.latestObservation.timeLabel,
      unread: record.latestObservation.unread,
      latestMessageId: record.latestObservation.latestMessageId,
      outgoingReceipt: record.latestObservation.outgoingReceipt,
      jobAssociation: { jobId: null, detailUrl: null },
      observedJobName: null,
    },
    accountNamespace,
  );
}

function conversationIndex(state, records, accountNamespace, capturedAt) {
  const current = new Map(records.map((record) => [record.key, record]));
  plain(state);
  // Older synthetic/legacy envelopes did not expose durable state records.
  // They remain readable, but cannot authorize observations for an absent
  // conversation. Real v2/v3 collector envelopes always carry this index.
  if (!Object.hasOwn(state, 'records')) return current;
  exactKeys(state, ['baselineCapturedAt', 'lastCapturedAt', 'records']);
  if (
    !isIso(state.baselineCapturedAt) ||
    !isIso(state.lastCapturedAt) ||
    state.lastCapturedAt !== capturedAt ||
    Date.parse(state.baselineCapturedAt) > Date.parse(state.lastCapturedAt) ||
    !Array.isArray(state.records) ||
    state.records.length > 100_000
  )
    integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  const historical = new Map();
  for (const source of state.records) {
    const record = validateHistoricalConversation(
      source,
      accountNamespace,
      state.baselineCapturedAt,
      state.lastCapturedAt,
    );
    if (historical.has(record.key))
      integrationFail('BOSS_SNAPSHOT_IDENTITY_INVALID', { fatal: true });
    historical.set(record.key, record);
  }
  for (const record of records) {
    const saved = historical.get(record.key);
    if (
      !saved ||
      JSON.stringify(saved.platformIdentity) !== JSON.stringify(record.platformIdentity)
    )
      integrationFail('BOSS_SNAPSHOT_IDENTITY_INVALID', { fatal: true });
  }
  return historical;
}

function validateJobs(value, records, conversations) {
  exactKeys(value, ['associations', 'evidence', 'candidates', 'confirmations']);
  for (const key of ['associations', 'evidence', 'candidates', 'confirmations'])
    if (!Array.isArray(value[key]) || value[key].length > 100_000)
      integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  const current = new Map();
  for (const association of value.associations) {
    plain(association);
    if (
      !requiredString(association.conversationKey, { max: 128 }) ||
      !requiredString(association.jobId, { max: 300, pattern: BOSS_JOB_ID }) ||
      association.detailUrl !== `https://www.zhipin.com/job_detail/${association.jobId}.html` ||
      !['current', 'historical'].includes(association.status) ||
      !conversations.has(association.conversationKey)
    )
      integrationFail('BOSS_SNAPSHOT_JOB_INVALID', { fatal: true });
    if (association.status === 'current') {
      // "current" is the latest durable job known for the conversation, not
      // proof that the conversation is present in this loaded-list snapshot.
      // State-only associations are needed to resolve historical messages.
      if (current.has(association.conversationKey))
        integrationFail('BOSS_SNAPSHOT_JOB_CONFLICT', { fatal: true });
      current.set(association.conversationKey, association);
    }
  }
  for (const record of records) {
    const direct = record.jobAssociation;
    const saved = current.get(record.key);
    if (
      (direct.jobId === null && saved) ||
      (direct.jobId !== null &&
        (!saved || saved.jobId !== direct.jobId || saved.detailUrl !== direct.detailUrl))
    )
      integrationFail('BOSS_SNAPSHOT_JOB_CONFLICT', { fatal: true });
  }
  for (const evidence of value.evidence) {
    plain(evidence);
    if (
      !requiredString(evidence.jobId, { max: 300, pattern: BOSS_JOB_ID }) ||
      evidence.detailUrl !== `https://www.zhipin.com/job_detail/${evidence.jobId}.html` ||
      !requiredString(evidence.name, { max: 300 }) ||
      !['loaded_jobName', 'detail_page_title', 'legacy_named_job'].includes(evidence.source) ||
      !isIso(evidence.observedAt) ||
      !optionalString(evidence.company, 500)
    )
      integrationFail('BOSS_SNAPSHOT_JOB_INVALID', { fatal: true });
  }
  for (const confirmation of value.confirmations) {
    plain(confirmation);
    if (
      confirmation.status !== 'confirmed_user' ||
      !requiredString(confirmation.conversationKey, { max: 128 }) ||
      !conversations.has(confirmation.conversationKey) ||
      !requiredString(confirmation.jobId, { max: 300, pattern: BOSS_JOB_ID }) ||
      confirmation.detailUrl !== `https://www.zhipin.com/job_detail/${confirmation.jobId}.html`
    )
      integrationFail('BOSS_SNAPSHOT_JOB_INVALID', { fatal: true });
  }
  return structuredClone(value);
}

export function validateTrackerEnvelope(input) {
  const value = structuredClone(input);
  if (value.resume === undefined)
    value.resume = { observations: [], lastScanAt: null, lastCoverage: null, lastUnresolved: [] };
  exactKeys(value, [
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
  ]);
  if (
    ![2, 3, 4, 5, 6, 7, 8].includes(value.version) ||
    value.scope !== 'loaded-chat-list' ||
    !requiredString(value.accountNamespace, { max: 75, pattern: ACCOUNT_NAMESPACE }) ||
    !isIso(value.createdAt) ||
    !isIso(value.updatedAt)
  )
    integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  exactKeys(value.snapshot, ['capturedAt', 'scope', 'accountNamespace', 'records', 'coverage']);
  if (
    !isIso(value.snapshot.capturedAt) ||
    value.snapshot.scope !== 'loaded-chat-list' ||
    value.snapshot.accountNamespace !== value.accountNamespace ||
    !Array.isArray(value.snapshot.records) ||
    value.snapshot.records.length > 100_000
  )
    integrationFail('BOSS_SNAPSHOT_STRUCTURE_INVALID', { fatal: true });
  const records = value.snapshot.records.map((record) =>
    validateRecord(record, value.accountNamespace),
  );
  if (new Set(records.map((record) => record.key)).size !== records.length)
    integrationFail('BOSS_SNAPSHOT_IDENTITY_INVALID', { fatal: true });
  value.snapshot.records = records;
  value.snapshot.coverage = validateCoverage(value.snapshot.coverage, records.length);
  const conversations = conversationIndex(
    value.state,
    records,
    value.accountNamespace,
    value.snapshot.capturedAt,
  );
  value.jobs = validateJobs(value.jobs, records, conversations);
  exactKeys(value.resume, ['observations', 'lastScanAt', 'lastCoverage', 'lastUnresolved']);
  if (!Array.isArray(value.resume.observations) || value.resume.observations.length > 100_000)
    integrationFail('BOSS_SNAPSHOT_RESUME_INVALID', { fatal: true });
  const resumeIds = new Set();
  for (const observation of value.resume.observations) {
    exactKeys(observation, [
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
      ...(value.version >= 4 ? ['attribution'] : []),
      ...(value.version >= 5 ? ['resumeEvidence'] : []),
    ]);
    if (value.version >= 4) validateAttributionEvidence(observation.attribution);
    if (value.version >= 5) {
      let proof;
      try {
        proof = validateResumeEvidence(observation.resumeEvidence);
      } catch {
        integrationFail('BOSS_SNAPSHOT_RESUME_INVALID', { fatal: true });
      }
      if (
        proof &&
        ((value.version < 6 && proof.version === 2) ||
          (value.version < 7 && proof.version === 3) ||
          (value.version < 8 && proof.version === 4) ||
          proof.messageType !== observation.messageType ||
          (proof.field === 'none'
            ? !['request_sent', 'sent_candidate', 'resume_card_other'].includes(observation.kind)
            : classifyResumeText(proof.text, RESUME_RULES) !== observation.kind))
      )
        integrationFail('BOSS_SNAPSHOT_RESUME_INVALID', { fatal: true });
    }
    const record = conversations.get(observation.conversationKey);
    const statusKind = RESUME_STATUS_KINDS.includes(observation.kind);
    if (
      !requiredString(observation.id, { max: 64, pattern: /^[a-f0-9]{64}$/ }) ||
      resumeIds.has(observation.id) ||
      !record ||
      JSON.stringify(observation.platformIdentity) !== JSON.stringify(record.platformIdentity) ||
      !requiredString(observation.messageId, { max: 128, pattern: /^[A-Za-z0-9_-]+$/ }) ||
      !['inbound', 'outbound', 'system'].includes(observation.direction) ||
      (!statusKind && observation.messageType !== 4) ||
      !RESUME_KINDS.includes(observation.kind) ||
      (!statusKind &&
        (observation.direction === 'outbound') !== (observation.kind === 'sent_candidate')) ||
      (statusKind && observation.direction !== 'system') ||
      !isIso(observation.platformTime) ||
      !isIso(observation.observedAt) ||
      !(statusKind
        ? ['geek_history_status_message', 'dom_chat_status_message_v1'].includes(observation.source)
        : observation.source === 'geek_history_type_4') ||
      (observation.externalJobId !== null &&
        !requiredString(observation.externalJobId, {
          max: 300,
          pattern: BOSS_JOB_ID,
        })) ||
      !['strong', 'review'].includes(observation.status) ||
      (observation.status === 'strong') !==
        ((observation.kind === 'sent_candidate' || statusKind) &&
          Boolean(observation.externalJobId))
    )
      integrationFail('BOSS_SNAPSHOT_RESUME_INVALID', { fatal: true });
    resumeIds.add(observation.id);
  }
  if (value.resume.lastScanAt !== null && !isIso(value.resume.lastScanAt))
    integrationFail('BOSS_SNAPSHOT_RESUME_INVALID', { fatal: true });
  if (!Array.isArray(value.resume.lastUnresolved))
    integrationFail('BOSS_SNAPSHOT_RESUME_INVALID', { fatal: true });
  if (value.resume.lastCoverage !== null) {
    const baseCoverageKeys = [
      'requestedConversations',
      'resolvedConversations',
      'pagesPerConversation',
    ];
    const pagedCoverageKeys = [
      ...baseCoverageKeys,
      'requestedPages',
      'completedPages',
      'exhaustedConversations',
      'truncatedConversations',
      'failedConversations',
    ];
    const coverageKeys = Object.keys(value.resume.lastCoverage);
    if (
      baseCoverageKeys.some((key) => !coverageKeys.includes(key)) ||
      coverageKeys.some((key) => !pagedCoverageKeys.includes(key))
    )
      integrationFail('BOSS_SNAPSHOT_RESUME_INVALID', { fatal: true });
    if (
      Object.values(value.resume.lastCoverage).some(
        (item) => !Number.isSafeInteger(item) || item < 0,
      ) ||
      value.resume.lastCoverage.resolvedConversations >
        value.resume.lastCoverage.requestedConversations ||
      (Object.hasOwn(value.resume.lastCoverage, 'requestedPages') &&
        Object.hasOwn(value.resume.lastCoverage, 'completedPages') &&
        value.resume.lastCoverage.completedPages > value.resume.lastCoverage.requestedPages)
    )
      integrationFail('BOSS_SNAPSHOT_RESUME_INVALID', { fatal: true });
  }
  plain(value.state);
  plain(value.report);
  plain(value.migration);
  return value;
}

export async function readTrackerSnapshot(path) {
  await regularFile(path);
  const bytes = await readFile(path);
  let parsed;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    integrationFail('BOSS_SNAPSHOT_JSON_INVALID', { fatal: true });
  }
  return { envelope: validateTrackerEnvelope(parsed), sha256: bytesHash(bytes), path };
}

export function snapshotDirectory(config) {
  return config.dataRoot
    ? join(config.dataRoot, config.account)
    : join(config.trackerRoot, 'data', config.account);
}

export function initialSnapshotPath(config) {
  return join(snapshotDirectory(config), config.initialSnapshot);
}

export async function listSnapshotNames(config) {
  const directory = snapshotDirectory(config);
  const names = (await readdir(directory)).filter((name) => SNAPSHOT_FILE.test(name)).sort();
  for (const name of names) await regularFile(join(directory, name));
  return names;
}

export function assertInitialSnapshot(config, snapshot, expected) {
  if (
    config.initialSnapshot !== expected.name ||
    basename(snapshot.path) !== expected.name ||
    snapshot.sha256 !== expected.sha256
  )
    integrationFail('BOSS_INITIAL_SNAPSHOT_CHANGED', { fatal: true });
}

export async function readCheckpointSnapshot(config, control) {
  const previous = await readTrackerSnapshot(
    join(snapshotDirectory(config), control.checkpoint.snapshotName),
  );
  if (previous.sha256 !== control.checkpoint.snapshotSha256)
    integrationFail('BOSS_CHECKPOINT_CHANGED', { fatal: true });
  return previous;
}

export async function readLatestSnapshot(config) {
  const latestName = (await listSnapshotNames(config)).at(-1);
  if (!latestName) integrationFail('BOSS_CHECKPOINT_SNAPSHOT_MISSING', { fatal: true });
  return readTrackerSnapshot(join(snapshotDirectory(config), latestName));
}
