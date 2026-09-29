import { bossBatchDigestInput } from '../dist/boss-batch.js';
import {
  RESUME_KINDS,
  RESUME_STATUS_KINDS,
  RESUME_RULES,
  resumeRule,
  classifyResumeText,
} from '../dist/resume-rules.js';
import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BOSS_BATCH_FORMAT,
  BOSS_CONTROL_MAX_ATTEMPTS,
  BOSS_CONTROL_FORMAT,
  BOSS_INCIDENT_FORMAT,
  BOSS_INTEGRATION_VERSION,
  BOSS_RUN_FORMAT,
  BossInbox,
  BossInboxError,
  validateBossBatch,
  validateBossControl,
} from './boss-inbox.mjs';
import { consumeBossInternalAuthorization } from './boss-internal-auth.mjs';

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultConfigPath = join(projectRoot, '.local', 'config.json');
const defaultInboxRoot = join(projectRoot, '.local', 'boss-integration');
const defaultTrackerRoot = join(projectRoot, 'collector', 'boss');
const defaultTrackerDataRoot = join(projectRoot, '.local', 'boss-collector');
const SNAPSHOT_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9-]{36}\.json$/;
const ACCOUNT_NAMESPACE = /^boss-geek:[a-f0-9]{64}$/;
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INITIAL_POLICY = 'boss-initial-2026-09-18-v1';
const INITIAL_SNAPSHOT_NAME = '2026-09-18T14-49-59-473Z_ae82d08d-b89d-46a4-b8ec-cb855214bd5a.json';
const INITIAL_SNAPSHOT_SHA256 = '697f1d35c3c9f0920709ce8be86535b9581877b2aaf435fc0bb1eb0a160a6f65';
const INCREMENTAL_POLICY = 'boss-manual-check-v1';
const RESUME_POLICY = 'boss-resume-observation-v3';
const RESUME_STATUS_WORKFLOW = 'resume-status-linked-v2';
const INITIAL_DATE = '2026-09-18';
const TIMEZONE = 'Asia/Shanghai';
const YESTERDAY_LABEL = '昨天';
// Manual checks only read the page state that is already loaded.  Keep a
// short duplicate-click guard here; platform-request budgets are accounted
// for by the runtime/collector at the action that actually sends them.
const MIN_CHECK_INTERVAL_MS = 10 * 1_000;
const MAX_SNAPSHOT_BYTES = 25_000_000;
const MAX_TRACKER_OUTPUT_BYTES = 1_000_000;
const PRODUCER_LOCK = '.producer.lock';

export class BossIntegrationError extends Error {
  constructor(code, message = code, { status = 1, fatal = false, nextAllowedAt = '', usage } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.fatal = fatal;
    this.nextAllowedAt = nextAllowedAt;
    if (usage) this.usage = usage;
  }
}

function integrationFail(code, options) {
  throw new BossIntegrationError(code, code, options);
}

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
    const { observedAt: existingObservedAt, ...existingIdentity } = existing;
    const { observedAt, ...eventIdentity } = event;
    if (stableHash(existingIdentity) !== stableHash(eventIdentity))
      integrationFail('BOSS_EVENT_ID_COLLISION', { fatal: true });
    if (observedAt.localeCompare(existingObservedAt) < 0) unique.set(event.eventId, event);
  }
  return [...unique.values()];
}

function bytesHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeErrorCode(error) {
  const code = String(error?.code ?? error?.message ?? 'BOSS_INTEGRATION_FAILED');
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(code) ? code : 'BOSS_INTEGRATION_FAILED';
}

function runId() {
  return `boss-run-${randomBytes(16).toString('hex')}`;
}

async function withProducerLock(inbox, id, task) {
  await inbox.initialize();
  const path = join(inbox.root, PRODUCER_LOCK);
  let handle;
  try {
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') integrationFail('BOSS_PRODUCER_BUSY');
      throw error;
    }
    await handle.writeFile(
      `${JSON.stringify({ runId: id, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    await handle.sync();
    return await task();
  } finally {
    if (handle) {
      const owned = await handle.stat();
      await handle.close();
      try {
        const current = await lstat(path);
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          current.dev === owned.dev &&
          current.ino === owned.ino
        )
          await unlink(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

async function releaseStaleProducerLock(inbox) {
  const path = join(inbox.root, PRODUCER_LOCK);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000)
    integrationFail('BOSS_PRODUCER_LOCK_INVALID');
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    integrationFail('BOSS_PRODUCER_LOCK_INVALID');
  }
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'createdAt,pid,runId' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !/^boss-run-[a-f0-9]{32}$/.test(value.runId) ||
    !isIso(value.createdAt)
  )
    integrationFail('BOSS_PRODUCER_LOCK_INVALID');
  try {
    process.kill(value.pid, 0);
    integrationFail('BOSS_PRODUCER_BUSY');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const current = await lstat(path);
  if (current.dev !== info.dev || current.ino !== info.ino) integrationFail('BOSS_PRODUCER_BUSY');
  await unlink(path);
  return true;
}

function normalizeConfig(input) {
  const value = plain(input, 'BOSS_CONFIG_INVALID');
  const config = plain(value.bossIntegration, 'BOSS_CONFIG_REQUIRED');
  const keys = Object.keys(config).sort();
  const currentKeys = ['account', 'initialSnapshot'];
  const legacyKeys = ['account', 'initialSnapshot', 'trackerRoot'];
  if (
    JSON.stringify(keys) !== JSON.stringify(currentKeys) &&
    JSON.stringify(keys) !== JSON.stringify(legacyKeys)
  )
    integrationFail('BOSS_CONFIG_INVALID');
  if (
    (config.trackerRoot !== undefined &&
      (!requiredString(config.trackerRoot, { max: 1_000 }) || !isAbsolute(config.trackerRoot))) ||
    !requiredString(config.account, { max: 40, pattern: /^[A-Za-z0-9_-]+$/ }) ||
    !requiredString(config.initialSnapshot, { max: 205, pattern: SNAPSHOT_FILE }) ||
    basename(config.initialSnapshot) !== config.initialSnapshot
  )
    integrationFail('BOSS_CONFIG_INVALID');
  return {
    account: config.account,
    initialSnapshot: config.initialSnapshot,
    trackerRoot: defaultTrackerRoot,
    dataRoot: defaultTrackerDataRoot,
  };
}

export async function readBossConfig(path = defaultConfigPath) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') integrationFail('BOSS_CONFIG_REQUIRED');
    integrationFail('BOSS_CONFIG_INVALID');
  }
  return normalizeConfig(value);
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
      !requiredString(jobId, { max: 300, pattern: /^[A-Za-z0-9_-]+$/ }) ||
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
      !requiredString(association.jobId, { max: 300, pattern: /^[A-Za-z0-9_-]+$/ }) ||
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
      !requiredString(evidence.jobId, { max: 300, pattern: /^[A-Za-z0-9_-]+$/ }) ||
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
      !requiredString(confirmation.jobId, { max: 300, pattern: /^[A-Za-z0-9_-]+$/ }) ||
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
    ![2, 3].includes(value.version) ||
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
    ]);
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
          pattern: /^[A-Za-z0-9_-]+$/,
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

function snapshotDirectory(config) {
  return config.dataRoot
    ? join(config.dataRoot, config.account)
    : join(config.trackerRoot, 'data', config.account);
}

function initialSnapshotPath(config) {
  return join(snapshotDirectory(config), config.initialSnapshot);
}

function resolveJobRows(envelope) {
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

function eventFacts(row, accountNamespace) {
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

function classifyTimeLabel(label) {
  if (HH_MM.test(label)) return 'explicitTime';
  if (label === '昨天') return 'yesterday';
  if (label === '') return 'unknownTime';
  return 'otherTime';
}

export function previewInitialEnvelope(envelope) {
  const rows = resolveJobRows(envelope);
  const counts = {
    total: rows.length,
    included: 0,
    excludedYesterday: 0,
    unknownTime: 0,
    otherTime: 0,
    complete: 0,
    review: 0,
  };
  for (const row of rows) {
    const category = classifyTimeLabel(row.record.timeLabel);
    if (category === 'explicitTime') counts.included += 1;
    else if (category === 'yesterday') counts.excludedYesterday += 1;
    else counts[category] += 1;
    if (category === 'explicitTime') {
      const facts = eventFacts(row, envelope.accountNamespace);
      if (facts.intent === 'create_or_link' && facts.messageId) counts.complete += 1;
      else counts.review += 1;
    }
  }
  return counts;
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

export function createInitialBatch(snapshot, sourceSequence) {
  const policy = {
    id: INITIAL_POLICY,
    mode: 'initial',
    timezone: TIMEZONE,
    appliedAtForNew: INITIAL_DATE,
    autoCreateComplete: true,
  };
  const events = createEvents(snapshot.envelope, {
    sourceSequence,
    evidenceDate: INITIAL_DATE,
    appliedAtForNew: INITIAL_DATE,
  }).filter((event) => HH_MM.test(event.timeLabel));
  return createBatch({
    envelope: snapshot.envelope,
    snapshotName: basename(snapshot.path),
    snapshotSha256: snapshot.sha256,
    sourceSequence,
    policy,
    events,
  });
}

export function createDatedYesterdayBatch(snapshot, sourceSequence, evidenceDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(evidenceDate)) integrationFail('BOSS_EVIDENCE_DATE_INVALID');
  const parsed = new Date(`${evidenceDate}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== evidenceDate)
    integrationFail('BOSS_EVIDENCE_DATE_INVALID');
  const policy = {
    id: `boss-user-dated-label-${evidenceDate}-v1`,
    mode: 'dated',
    timezone: TIMEZONE,
    appliedAtForNew: evidenceDate,
    autoCreateComplete: true,
  };
  const events = createEvents(snapshot.envelope, {
    sourceSequence,
    evidenceDate,
    appliedAtForNew: evidenceDate,
  }).filter((event) => event.timeLabel === YESTERDAY_LABEL);
  if (!events.length) integrationFail('BOSS_DATED_LABEL_EMPTY');
  return createBatch({
    envelope: snapshot.envelope,
    snapshotName: basename(snapshot.path),
    snapshotSha256: snapshot.sha256,
    sourceSequence,
    policy,
    events,
  });
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

function createIncrementalBatch(previous, current, sourceSequence, { afterInitial = false } = {}) {
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
    ].map((event) => event.eventId),
  );
  const events = uniqueEventsById([
    ...eventsFor(current),
    ...createResumeEvents(current.envelope, { sourceSequence }),
  ]).filter((event) => !previousIds.has(event.eventId));
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

export function emptyControl() {
  return {
    format: BOSS_CONTROL_FORMAT,
    version: BOSS_INTEGRATION_VERSION,
    accountNamespace: '',
    checkpoint: null,
    attempts: [],
    lastAttemptAt: '',
    lastSuccessAt: '',
    nextAllowedAt: '',
    paused: false,
    pauseCode: '',
  };
}

function checkpoint(snapshot, sourceSequence) {
  return {
    snapshotName: basename(snapshot.path),
    snapshotSha256: snapshot.sha256,
    capturedAt: snapshot.envelope.snapshot.capturedAt,
    sourceSequence,
  };
}

function shanghaiDay(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function reserveCheckAttempt(inputControl, date) {
  const control = validateBossControl(inputControl);
  const now = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(now.getTime())) integrationFail('BOSS_TIME_INVALID');
  if (!control.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
  if (control.paused) integrationFail('BOSS_INTEGRATION_PAUSED');
  const duplicateUntil = control.lastAttemptAt
    ? new Date(Date.parse(control.lastAttemptAt) + MIN_CHECK_INTERVAL_MS)
    : null;
  // v0.7 persisted a 45-minute nextAllowedAt. It is only a compatibility
  // field now: derive the duplicate-click guard from the actual last read so
  // an old cooldown cannot survive the v0.8 migration.
  if (duplicateUntil && Number.isFinite(duplicateUntil.getTime()) && now < duplicateUntil)
    integrationFail('BOSS_CHECK_TOO_SOON', { nextAllowedAt: duplicateUntil.toISOString() });
  const attempts = control.attempts
    .filter((attempt) => now.getTime() - Date.parse(attempt) < 8 * 24 * 60 * 60 * 1_000)
    .slice(-(BOSS_CONTROL_MAX_ATTEMPTS - 1));
  const attemptedAt = now.toISOString();
  attempts.push(attemptedAt);
  const next = new Date(now.getTime() + MIN_CHECK_INTERVAL_MS).toISOString();
  return validateBossControl({
    ...control,
    attempts,
    lastAttemptAt: attemptedAt,
    nextAllowedAt: next,
  });
}

function checkpointMatches(control, snapshot) {
  return (
    control.checkpoint?.snapshotName === basename(snapshot.path) &&
    control.checkpoint?.snapshotSha256 === snapshot.sha256
  );
}

async function ensureAccount(control, snapshot) {
  if (control.accountNamespace && control.accountNamespace !== snapshot.envelope.accountNamespace)
    integrationFail('BOSS_ACCOUNT_MISMATCH', { fatal: true });
}

async function writeRun(inbox, details) {
  return inbox.recordRun({
    format: BOSS_RUN_FORMAT,
    version: 1,
    runId: details.runId,
    command: details.command,
    status: details.status,
    startedAt: details.startedAt,
    finishedAt: details.finishedAt,
    accountNamespace: details.accountNamespace ?? '',
    batchId: details.batchId ?? '',
    snapshotName: details.snapshotName ?? '',
    snapshotSha256: details.snapshotSha256 ?? '',
    counts: details.counts ?? {},
    errorCode: details.errorCode ?? '',
    nextAllowedAt: details.nextAllowedAt ?? '',
  });
}

async function listSnapshotNames(config) {
  const directory = snapshotDirectory(config);
  const names = (await readdir(directory)).filter((name) => SNAPSHOT_FILE.test(name)).sort();
  for (const name of names) await regularFile(join(directory, name));
  return names;
}

async function applySnapshot(
  inbox,
  control,
  previous,
  current,
  onStage = () => {},
  initialIdentity = APPROVED_INITIAL,
) {
  onStage('validate_snapshot');
  await ensureAccount(control, current);
  if (
    Date.parse(current.envelope.snapshot.capturedAt) <
    Date.parse(previous.envelope.snapshot.capturedAt)
  )
    integrationFail('BOSS_SNAPSHOT_ORDER_INVALID', { fatal: true });
  const nextSequence = control.checkpoint.sourceSequence + 1;
  const afterInitial =
    control.checkpoint.sourceSequence === 1 &&
    control.checkpoint.snapshotName === initialIdentity.name &&
    control.checkpoint.snapshotSha256 === initialIdentity.sha256;
  const batch = createIncrementalBatch(previous, current, nextSequence, { afterInitial });
  let queueResult = null;
  let sourceSequence = control.checkpoint.sourceSequence;
  if (batch) {
    onStage('enqueue_events');
    queueResult = await inbox.enqueue(batch);
    sourceSequence = nextSequence;
  }
  const updated = validateBossControl({
    ...control,
    accountNamespace: current.envelope.accountNamespace,
    checkpoint: checkpoint(current, sourceSequence),
  });
  onStage('commit_checkpoint');
  await inbox.writeControl(updated);
  return { control: updated, batch, queueResult };
}

async function recoverUnexported(
  config,
  inbox,
  control,
  onStage = () => {},
  initialIdentity = APPROVED_INITIAL,
) {
  if (!control.checkpoint) return { control, recovered: 0, batches: 0, events: 0 };
  onStage('scan_saved_snapshots');
  const names = await listSnapshotNames(config);
  const index = names.indexOf(control.checkpoint.snapshotName);
  if (index === -1) integrationFail('BOSS_CHECKPOINT_SNAPSHOT_MISSING', { fatal: true });
  const checkpointPath = join(snapshotDirectory(config), control.checkpoint.snapshotName);
  let previous = await readTrackerSnapshot(checkpointPath);
  if (previous.sha256 !== control.checkpoint.snapshotSha256)
    integrationFail('BOSS_CHECKPOINT_CHANGED', { fatal: true });
  let currentControl = control;
  let recovered = 0;
  let batches = 0;
  let events = 0;
  for (const name of names.slice(index + 1)) {
    onStage('recover_saved_snapshot');
    const current = await readTrackerSnapshot(join(snapshotDirectory(config), name));
    const result = await applySnapshot(
      inbox,
      currentControl,
      previous,
      current,
      onStage,
      initialIdentity,
    );
    currentControl = result.control;
    recovered += 1;
    if (result.batch) {
      batches += 1;
      events += result.batch.events.length;
    }
    previous = current;
  }
  return { control: currentControl, recovered, batches, events };
}

function normalizedUsage(value, fallback = {}) {
  const result = {};
  for (const key of ['historyRequests', 'domSwitches', 'detailNavigations', 'cdpReconnects'])
    result[key] =
      Number.isSafeInteger(value?.[key]) && value[key] >= 0
        ? value[key]
        : Number.isSafeInteger(fallback[key]) && fallback[key] >= 0
          ? fallback[key]
          : 0;
  return result;
}

function requestedUsage(trackerMode, trackerArguments) {
  const argument = (name) => {
    const index = trackerArguments.indexOf(name);
    return index >= 0 ? Number(trackerArguments[index + 1]) : 0;
  };
  return normalizedUsage({
    historyRequests: trackerMode === 'run' ? argument('--history-requests') : 0,
    domSwitches: trackerMode === 'run' ? argument('--dom-limit') : 0,
    detailNavigations: trackerMode === 'run' ? argument('--detail-limit') : 0,
    cdpReconnects: 0,
  });
}

const DEFAULT_DETAIL_ENRICHMENT = Object.freeze({
  status: 'active',
  pending: 0,
  deferred: 0,
  isolated: 0,
  nextRetryAt: null,
  lastError: null,
});

function normalizedDetailEnrichment(input) {
  if (input === undefined) return { ...DEFAULT_DETAIL_ENRICHMENT };
  plain(input, 'BOSS_TRACKER_OUTPUT_INVALID');
  const value = {
    status: input.status,
    pending: input.pending,
    deferred: input.deferred,
    isolated: input.isolated,
    nextRetryAt: input.nextRetryAt,
    lastError: input.lastError,
  };
  if (
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(Object.keys(value).sort()) ||
    !['active', 'waiting_retry', 'blocked'].includes(value.status) ||
    !['pending', 'deferred', 'isolated'].every(
      (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
    ) ||
    (value.nextRetryAt !== null &&
      (typeof value.nextRetryAt !== 'string' || !Number.isFinite(Date.parse(value.nextRetryAt)))) ||
    (value.lastError !== null && !/^[A-Z][A-Z0-9_]{2,100}$/.test(value.lastError))
  )
    integrationFail('BOSS_TRACKER_OUTPUT_INVALID', { fatal: true });
  return value;
}

function parseTrackerOutput(stdout, fallbackUsage = {}) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_TRACKER_OUTPUT_BYTES)
    integrationFail('BOSS_TRACKER_OUTPUT_INVALID', {
      fatal: true,
      usage: normalizedUsage(null, fallbackUsage),
    });
  let output;
  try {
    output = JSON.parse(stdout);
  } catch {
    integrationFail('BOSS_TRACKER_OUTPUT_INVALID', {
      fatal: true,
      usage: normalizedUsage(null, fallbackUsage),
    });
  }
  plain(output, 'BOSS_TRACKER_OUTPUT_INVALID');
  const durablePartial =
    output.ok === false &&
    output.saved === true &&
    output.partial === true &&
    requiredString(output.file, { max: 2_000 });
  if (
    (output.ok !== true && !durablePartial) ||
    output.saved !== true ||
    !requiredString(output.file, { max: 2_000 })
  ) {
    const code = safeErrorCode({ code: output.error });
    throw new BossIntegrationError(code, code, {
      fatal: isFatalTrackerCode(code),
      usage: normalizedUsage(output.usage, fallbackUsage),
    });
  }
  const partial = output.partial === true,
    failureScope = partial
      ? ['detail', 'account'].includes(output.failureScope)
        ? output.failureScope
        : 'account'
      : 'none';
  return {
    ...output,
    failureScope,
    detailEnrichment: normalizedDetailEnrichment(output.detailEnrichment),
    usage: normalizedUsage(output.usage, fallbackUsage),
  };
}

export function isFatalTrackerCode(code) {
  return /(?:LOGIN|LOGGED|CAPTCHA|VERIFY|ACCOUNT|IDENTITY|TARGET|STRUCTURE|CAPTURE|CONNECTION|SNAPSHOT|CHAT_LIST_NOT_READY|BLANK|SECURITY|SESSION)/.test(
    code,
  );
}

async function invokeTracker(
  config,
  runner = execFile,
  trackerMode = 'check',
  trackerArguments = [],
) {
  const tracker = join(config.trackerRoot, 'tracker.mjs');
  await regularFile(tracker, { maxBytes: 5_000_000 });
  let result;
  const conservativeUsage = requestedUsage(trackerMode, trackerArguments);
  try {
    result = await runner(
      process.execPath,
      [tracker, trackerMode, '--account', config.account, ...trackerArguments],
      {
        cwd: config.trackerRoot,
        encoding: 'utf8',
        maxBuffer: MAX_TRACKER_OUTPUT_BYTES,
        timeout: 22 * 60 * 1_000,
        env: {
          ...process.env,
          ...(config.dataRoot ? { JOB_TRACKER_BOSS_DATA_ROOT: config.dataRoot } : {}),
        },
      },
    );
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim()) {
      // The tracker can emit a saved snapshot and still exit non-zero if its
      // final target/cleanup guard fails. The snapshot is recoverable later,
      // but this run must not be reported as a successful browser check.
      const parsed = parseTrackerOutput(error.stdout, conservativeUsage);
      if (parsed.partial === true) return parsed;
      integrationFail('BOSS_TRACKER_EXIT_FAILED', { fatal: true, usage: parsed.usage });
    }
    integrationFail('BOSS_TRACKER_EXEC_FAILED', { usage: conservativeUsage });
  }
  return parseTrackerOutput(result.stdout, conservativeUsage);
}

function fixedOutputSnapshot(config, trackerOutput) {
  const name = basename(trackerOutput.file);
  const expected = resolve(snapshotDirectory(config), name);
  if (
    !SNAPSHOT_FILE.test(name) ||
    resolve(trackerOutput.file) !== expected ||
    dirname(resolve(trackerOutput.file)) !== resolve(snapshotDirectory(config))
  )
    integrationFail('BOSS_TRACKER_PATH_INVALID', { fatal: true });
  return expected;
}

async function recordFailure({
  inbox,
  control,
  run,
  command,
  step,
  error,
  startedAt,
  counts = {},
  completedItems = 0,
  remainingItems = 0,
}) {
  const finishedAt = new Date().toISOString();
  const code = safeErrorCode(error);
  let updated = control;
  if (error?.fatal && control) {
    updated = validateBossControl({ ...control, paused: true, pauseCode: code });
    await inbox.writeControl(updated);
  }
  const accountNamespace = updated?.accountNamespace ?? '';
  await inbox.recordIncident({
    format: BOSS_INCIDENT_FORMAT,
    version: 1,
    runId: run,
    step,
    errorCode: code,
    startedAt,
    finishedAt,
    accountNamespace,
    lastCheckpoint: updated?.checkpoint?.snapshotName ?? '',
    counts,
    completedItems,
    remainingItems,
    paused: Boolean(updated?.paused),
    cleanupStatus: 'not_required',
  });
  await writeRun(inbox, {
    runId: run,
    command,
    status: 'failed',
    startedAt,
    finishedAt,
    accountNamespace,
    counts,
    errorCode: code,
    nextAllowedAt: error?.nextAllowedAt || updated?.nextAllowedAt || '',
  });
  return updated;
}

async function snapshotProgress(config, initial, current) {
  try {
    const names = await listSnapshotNames(config);
    const first = names.indexOf(initial?.checkpoint?.snapshotName);
    const last = names.indexOf(current?.checkpoint?.snapshotName);
    if (first < 0 || last < 0) return { completedItems: 0, remainingItems: 0 };
    return {
      completedItems: Math.max(0, last - first),
      remainingItems: Math.max(0, names.length - 1 - last),
    };
  } catch {
    return { completedItems: 0, remainingItems: 0 };
  }
}

export async function resumeCommand(inbox) {
  // Explicit operator action only. The next check still runs every identity,
  // login, page and frequency guard; this never reconnects the browser.
  const staleLockReleased = await releaseStaleProducerLock(inbox);
  return withProducerLock(inbox, runId(), async () => {
    const control = await inbox.readControl();
    if (!control?.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
    if (!control.paused) return { resumed: false, staleLockReleased, control };
    const updated = validateBossControl({ ...control, paused: false, pauseCode: '' });
    await inbox.writeControl(updated);
    return { resumed: true, staleLockReleased, control: updated };
  });
}

function locallyRecoverablePause(code) {
  return /^BOSS_(?:SNAPSHOT|CHECKPOINT)_[A-Z0-9_]+$/.test(code || '');
}

export async function recoverSavedCommand(
  config,
  inbox,
  onStage = () => {},
  initialIdentity = APPROVED_INITIAL,
) {
  let control = await inbox.readControl();
  if (!control?.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
  const recovered = await recoverUnexported(config, inbox, control, onStage, initialIdentity);
  control = recovered.control;
  const pauseCleared = control.paused && locallyRecoverablePause(control.pauseCode);
  if (pauseCleared) {
    control = validateBossControl({ ...control, paused: false, pauseCode: '' });
    onStage('clear_local_snapshot_pause');
    await inbox.writeControl(control);
  }
  return {
    recovered,
    control,
    pauseCleared,
    requiresResume: control.paused,
    usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
  };
}

function assertInitialSnapshot(config, snapshot, expected) {
  if (
    config.initialSnapshot !== expected.name ||
    basename(snapshot.path) !== expected.name ||
    snapshot.sha256 !== expected.sha256
  )
    integrationFail('BOSS_INITIAL_SNAPSHOT_CHANGED', { fatal: true });
}

const APPROVED_INITIAL = Object.freeze({
  name: INITIAL_SNAPSHOT_NAME,
  sha256: INITIAL_SNAPSHOT_SHA256,
});

export async function previewCommand(config, expected = APPROVED_INITIAL) {
  const snapshot = await readTrackerSnapshot(initialSnapshotPath(config));
  assertInitialSnapshot(config, snapshot, expected);
  const counts = previewInitialEnvelope(snapshot.envelope);
  if (
    counts.included !== 30 ||
    counts.excludedYesterday !== 10 ||
    counts.unknownTime !== 60 ||
    counts.otherTime !== 0 ||
    counts.complete !== 30 ||
    counts.review !== 0
  )
    integrationFail('BOSS_INITIAL_SCOPE_MISMATCH', { fatal: true });
  return {
    counts,
    snapshotName: basename(snapshot.path),
    snapshotSha256: snapshot.sha256,
    capturedAt: snapshot.envelope.snapshot.capturedAt,
  };
}

export async function enqueueCommand(
  config,
  inbox,
  expected = APPROVED_INITIAL,
  onStage = () => {},
) {
  onStage('read_initial_snapshot');
  const snapshot = await readTrackerSnapshot(initialSnapshotPath(config));
  assertInitialSnapshot(config, snapshot, expected);
  const preview = previewInitialEnvelope(snapshot.envelope);
  if (
    preview.included !== 30 ||
    preview.excludedYesterday !== 10 ||
    preview.unknownTime !== 60 ||
    preview.otherTime !== 0 ||
    preview.complete !== 30 ||
    preview.review !== 0
  )
    integrationFail('BOSS_INITIAL_SCOPE_MISMATCH', { fatal: true });
  let control = (await inbox.readControl()) ?? emptyControl();
  await ensureAccount(control, snapshot);
  if (control.checkpoint && !checkpointMatches(control, snapshot))
    integrationFail('BOSS_INITIAL_ALREADY_ADVANCED');
  const sourceSequence = control.checkpoint?.sourceSequence || 1;
  const batch = createInitialBatch(snapshot, sourceSequence);
  onStage('enqueue_events');
  const queued = await inbox.enqueue(batch);
  control = validateBossControl({
    ...control,
    accountNamespace: snapshot.envelope.accountNamespace,
    checkpoint: checkpoint(snapshot, sourceSequence),
  });
  onStage('commit_checkpoint');
  await inbox.writeControl(control);
  return { batch, queued, control, preview };
}

export async function enqueueDatedYesterdayCommand(
  config,
  inbox,
  evidenceDate,
  onStage = () => {},
) {
  onStage('read_control');
  let control = await inbox.readControl();
  if (!control?.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
  const checkpointSnapshot = await readTrackerSnapshot(
    join(snapshotDirectory(config), control.checkpoint.snapshotName),
  );
  if (checkpointSnapshot.sha256 !== control.checkpoint.snapshotSha256)
    integrationFail('BOSS_CHECKPOINT_CHANGED', { fatal: true });
  const latestName = (await listSnapshotNames(config)).at(-1);
  if (!latestName) integrationFail('BOSS_CHECKPOINT_SNAPSHOT_MISSING', { fatal: true });
  const current = await readTrackerSnapshot(join(snapshotDirectory(config), latestName));
  await ensureAccount(control, current);
  if (
    Date.parse(current.envelope.snapshot.capturedAt) <
    Date.parse(checkpointSnapshot.envelope.snapshot.capturedAt)
  )
    integrationFail('BOSS_SNAPSHOT_ORDER_INVALID', { fatal: true });

  const changedSnapshot = current.sha256 !== checkpointSnapshot.sha256;
  if (
    changedSnapshot &&
    JSON.stringify(current.envelope.snapshot) !==
      JSON.stringify(checkpointSnapshot.envelope.snapshot)
  )
    integrationFail('BOSS_DATED_IMPORT_REQUIRES_CURRENT_CHECKPOINT', { fatal: true });
  const sourceSequence = control.checkpoint.sourceSequence + Number(changedSnapshot);
  const batch = createDatedYesterdayBatch(current, sourceSequence, evidenceDate);
  const counts = {
    events: batch.events.length,
    complete: batch.events.filter((event) => event.intent === 'create_or_link').length,
    review: batch.events.filter((event) => event.intent === 'review').length,
  };
  onStage('enqueue_events');
  const queued = await inbox.enqueue(batch);
  if (changedSnapshot) {
    control = validateBossControl({
      ...control,
      checkpoint: checkpoint(current, sourceSequence),
    });
    onStage('commit_checkpoint');
    await inbox.writeControl(control);
  }
  return { batch, queued, control, counts };
}

export async function enqueueResumeCommand(config, inbox, evidenceDate = '', onStage = () => {}) {
  onStage('read_control');
  let control = await inbox.readControl();
  if (!control?.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
  const checkpointSnapshot = await readTrackerSnapshot(
    join(snapshotDirectory(config), control.checkpoint.snapshotName),
  );
  if (checkpointSnapshot.sha256 !== control.checkpoint.snapshotSha256)
    integrationFail('BOSS_CHECKPOINT_CHANGED', { fatal: true });
  const latestName = (await listSnapshotNames(config)).at(-1);
  if (!latestName) integrationFail('BOSS_CHECKPOINT_SNAPSHOT_MISSING', { fatal: true });
  const current = await readTrackerSnapshot(join(snapshotDirectory(config), latestName));
  await ensureAccount(control, current);
  if (checkpointMatches(control, current) && !evidenceDate) {
    return {
      batch: null,
      queued: { created: false },
      control,
      counts: { events: 0, strong: 0, review: 0 },
    };
  }
  if (
    Date.parse(current.envelope.snapshot.capturedAt) <
    Date.parse(checkpointSnapshot.envelope.snapshot.capturedAt)
  )
    integrationFail('BOSS_SNAPSHOT_ORDER_INVALID', { fatal: true });
  if (
    JSON.stringify(current.envelope.snapshot) !==
    JSON.stringify(checkpointSnapshot.envelope.snapshot)
  )
    integrationFail('BOSS_RESUME_IMPORT_REQUIRES_CURRENT_CHECKPOINT', { fatal: true });
  const sourceSequence = control.checkpoint.sourceSequence + 1;
  const batch = createResumeBatch(current, sourceSequence, evidenceDate);
  const counts = {
    events: batch.events.length,
    strong: batch.events.filter((event) =>
      [
        'resume_sent_candidate',
        'resume_request_sent',
        'resume_sent_confirmed',
        'resume_attachment_sent',
        'resume_viewed_confirmed',
      ].includes(event.summary),
    ).length,
    review: batch.events.filter((event) => event.summary === 'resume_card_other').length,
  };
  onStage('enqueue_events');
  const queued = await inbox.enqueue(batch);
  control = validateBossControl({
    ...control,
    checkpoint: checkpoint(current, sourceSequence),
  });
  onStage('commit_checkpoint');
  await inbox.writeControl(control);
  return { batch, queued, control, counts };
}

export async function checkCommand(
  config,
  inbox,
  {
    now = () => new Date(),
    runner = execFile,
    trackerMode = 'check',
    trackerArguments = [],
    onStage = () => {},
    initialIdentity = APPROVED_INITIAL,
  } = {},
) {
  onStage('read_control');
  let control = await inbox.readControl();
  if (!control?.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
  if (control.paused) integrationFail('BOSS_INTEGRATION_PAUSED');
  const recovered = await recoverUnexported(config, inbox, control, onStage, initialIdentity);
  control = recovered.control;
  if (recovered.recovered)
    return {
      recovered,
      control,
      checked: false,
      batch: null,
      partial: false,
      // Saved-snapshot recovery is entirely local. The runtime requires an
      // exact three-field usage report so it can release the conservative
      // reservation without treating a successful recovery as untrusted.
      usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
    };
  // Do not reserve a browser budget before the local CDP connection has even
  // succeeded. A failed connection must not create a long cooldown.
  const checkTime = now();
  const duplicateUntil = control.lastAttemptAt
    ? new Date(Date.parse(control.lastAttemptAt) + MIN_CHECK_INTERVAL_MS)
    : null;
  if (duplicateUntil && Number.isFinite(duplicateUntil.getTime()) && checkTime < duplicateUntil)
    integrationFail('BOSS_CHECK_TOO_SOON', { nextAllowedAt: duplicateUntil.toISOString() });
  onStage('execute_tracker');
  const trackerOutput = await invokeTracker(config, runner, trackerMode, trackerArguments);
  onStage('record_loaded_list_read');
  control = reserveCheckAttempt(control, now());
  await inbox.writeControl(control);
  onStage('read_saved_snapshot');
  const current = await readTrackerSnapshot(fixedOutputSnapshot(config, trackerOutput));
  const previous = await readTrackerSnapshot(
    join(snapshotDirectory(config), control.checkpoint.snapshotName),
  );
  if (previous.sha256 !== control.checkpoint.snapshotSha256)
    integrationFail('BOSS_CHECKPOINT_CHANGED', { fatal: true });
  const applied = await applySnapshot(inbox, control, previous, current, onStage, initialIdentity);
  const successful = validateBossControl({
    ...applied.control,
    lastSuccessAt: now().toISOString(),
    paused: false,
    pauseCode: '',
  });
  onStage('commit_success');
  await inbox.writeControl(successful);
  return {
    recovered,
    control: successful,
    checked: true,
    batch: applied.batch,
    partial: trackerOutput.partial === true,
    trackerError:
      trackerOutput.partial === true ? safeErrorCode({ code: trackerOutput.error }) : '',
    failureScope: trackerOutput.failureScope,
    detailEnrichment: trackerOutput.detailEnrichment,
    history: trackerOutput.history,
    usage: trackerOutput.usage ?? {
      historyRequests: 0,
      domSwitches: 0,
      detailNavigations: 0,
    },
  };
}

export async function statusCommand(config, inbox) {
  const control = await inbox.readControl();
  const queue = await inbox.status();
  const [runs, incidents] = await Promise.all([readdir(inbox.runs), readdir(inbox.incidents)]);
  let latestLocalSnapshot = '';
  try {
    latestLocalSnapshot = (await listSnapshotNames(config)).at(-1) ?? '';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    initialized: Boolean(control?.checkpoint),
    paused: control?.paused ?? false,
    pauseCode: control?.pauseCode ?? '',
    lastAttemptAt: control?.lastAttemptAt ?? '',
    lastSuccessAt: control?.lastSuccessAt ?? '',
    nextAllowedAt: control?.nextAllowedAt ?? '',
    checkpointSnapshot: control?.checkpoint?.snapshotName ?? '',
    checkpointSequence: control?.checkpoint?.sourceSequence ?? 0,
    latestLocalSnapshot,
    queue,
    runs: runs.filter((name) => /^boss-run-[a-f0-9]{32}\.json$/.test(name)).length,
    incidents: incidents.filter((name) => /^boss-run-[a-f0-9]{32}\.json$/.test(name)).length,
  };
}

function parseArguments(argv) {
  if (argv[0] === 'check') integrationFail('BOSS_USE_UNIFIED_RUNTIME');
  if (
    argv.length === 9 &&
    argv[0] === 'collect-cycle' &&
    argv[1] === '--history-requests' &&
    /^(?:[0-9]|1[0-9]|20)$/.test(argv[2]) &&
    argv[3] === '--detail-limit' &&
    /^(?:[0-9]|1[0-9]|20)$/.test(argv[4]) &&
    argv[5] === '--dom-limit' &&
    /^[0-1]$/.test(argv[6]) &&
    argv[7] === '--history-mode' &&
    ['change', 'backfill'].includes(argv[8])
  )
    return {
      command: argv[0],
      evidenceDate: '',
      historyRequests: Number(argv[2]),
      detailLimit: Number(argv[4]),
      domLimit: Number(argv[6]),
      historyMode: argv[8],
    };
  if (
    argv.length === 3 &&
    argv[0] === 'enqueue-yesterday' &&
    argv[1] === '--date' &&
    /^\d{4}-\d{2}-\d{2}$/.test(argv[2])
  )
    return {
      command: argv[0],
      evidenceDate: argv[2],
      historyRequests: 0,
      detailLimit: 0,
      domLimit: 0,
    };
  if (
    argv.length === 3 &&
    argv[0] === 'enqueue-resume' &&
    argv[1] === '--date' &&
    /^\d{4}-\d{2}-\d{2}$/.test(argv[2])
  )
    return {
      command: argv[0],
      evidenceDate: argv[2],
      historyRequests: 0,
      detailLimit: 0,
      domLimit: 0,
    };
  if (
    argv.length === 1 &&
    ['preview', 'enqueue', 'enqueue-resume', 'recover-saved', 'status', 'resume'].includes(argv[0])
  )
    return {
      command: argv[0],
      evidenceDate: '',
      historyRequests: 0,
      detailLimit: 0,
      domLimit: 0,
    };
  integrationFail('BOSS_ARGUMENTS_INVALID');
}

export async function main(
  argv = process.argv.slice(2),
  {
    configPath = defaultConfigPath,
    inboxRoot = defaultInboxRoot,
    now = () => new Date(),
    initialIdentity = APPROVED_INITIAL,
    inboxFactory = (root) => new BossInbox(root),
    configReader = readBossConfig,
    internalAuthorization = process.env.JOB_TRACKER_BOSS_INTERNAL_AUTHORIZATION || '',
  } = {},
) {
  const { command, evidenceDate, historyRequests, detailLimit, domLimit, historyMode } =
    parseArguments(argv);
  if (command === 'collect-cycle')
    await consumeBossInternalAuthorization(
      inboxRoot,
      internalAuthorization,
      { command, historyRequests, detailLimit, domLimit, historyMode },
      { now },
    );
  const started = now();
  const startedAt = started.toISOString();
  const id = runId();
  const inbox = inboxFactory(inboxRoot);
  await inbox.initialize();
  let config;
  let step = 'read_config';
  let beforeControl = null;
  try {
    config = await configReader(configPath);
    if (command === 'preview') {
      step = 'read_initial_snapshot';
      const result = await previewCommand(config, initialIdentity);
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: 'succeeded',
        startedAt,
        finishedAt: now().toISOString(),
        snapshotName: result.snapshotName,
        snapshotSha256: result.snapshotSha256,
        counts: result.counts,
      });
      console.log(
        JSON.stringify(
          { ok: true, command, counts: result.counts, snapshot: result.snapshotName },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'enqueue') {
      step = 'read_control';
      beforeControl = await inbox.readControl();
      step = 'producer_lock';
      const result = await withProducerLock(inbox, id, () =>
        enqueueCommand(config, inbox, initialIdentity, (value) => {
          step = value;
        }),
      );
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: 'succeeded',
        startedAt,
        finishedAt: now().toISOString(),
        accountNamespace: result.batch.accountNamespace,
        batchId: result.batch.batchId,
        snapshotName: result.batch.source.snapshotName,
        snapshotSha256: result.batch.source.snapshotSha256,
        counts: {
          included: result.preview.included,
          excludedYesterday: result.preview.excludedYesterday,
          unknownTime: result.preview.unknownTime,
          events: result.batch.events.length,
        },
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command,
            created: result.queued.created,
            counts: {
              included: result.preview.included,
              excludedYesterday: result.preview.excludedYesterday,
              unknownTime: result.preview.unknownTime,
              events: result.batch.events.length,
            },
            batchId: result.batch.batchId,
            queue: inbox.inbox,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'enqueue-yesterday') {
      step = 'read_control';
      beforeControl = await inbox.readControl();
      step = 'producer_lock';
      const result = await withProducerLock(inbox, id, () =>
        enqueueDatedYesterdayCommand(config, inbox, evidenceDate, (value) => {
          step = value;
        }),
      );
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: 'succeeded',
        startedAt,
        finishedAt: now().toISOString(),
        accountNamespace: result.batch.accountNamespace,
        batchId: result.batch.batchId,
        snapshotName: result.batch.source.snapshotName,
        snapshotSha256: result.batch.source.snapshotSha256,
        counts: result.counts,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command,
            created: result.queued.created,
            evidenceDate,
            counts: result.counts,
            batchId: result.batch.batchId,
            queue: inbox.inbox,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'enqueue-resume') {
      step = 'read_control';
      beforeControl = await inbox.readControl();
      step = 'producer_lock';
      const result = await withProducerLock(inbox, id, () =>
        enqueueResumeCommand(config, inbox, evidenceDate, (value) => {
          step = value;
        }),
      );
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: 'succeeded',
        startedAt,
        finishedAt: now().toISOString(),
        accountNamespace: result.batch?.accountNamespace ?? beforeControl?.accountNamespace ?? '',
        batchId: result.batch?.batchId ?? '',
        snapshotName: result.batch?.source.snapshotName ?? result.control.checkpoint.snapshotName,
        snapshotSha256:
          result.batch?.source.snapshotSha256 ?? result.control.checkpoint.snapshotSha256,
        counts: result.counts,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command,
            created: result.queued.created,
            counts: result.counts,
            batchId: result.batch?.batchId ?? '',
            queue: inbox.inbox,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'collect-cycle') {
      step = 'read_control';
      const before = await inbox.readControl();
      let checkStep = 'read_control';
      try {
        const result = await withProducerLock(inbox, id, () =>
          checkCommand(config, inbox, {
            now,
            trackerMode: 'run',
            trackerArguments: [
              '--history-requests',
              String(historyRequests),
              '--detail-limit',
              String(detailLimit),
              '--dom-limit',
              String(domLimit),
              '--history-mode',
              historyMode,
            ],
            onStage: (value) => {
              checkStep = value;
            },
          }),
        );
        const events = result.batch?.events.length ?? result.recovered.events;
        const counts = {
          browserChecks: result.checked ? 1 : 0,
          recoveredSnapshots: result.recovered.recovered,
          batches: result.batch ? 1 : result.recovered.batches,
          events,
          historyRequests: result.usage?.historyRequests ?? 0,
          domSwitches: result.usage?.domSwitches ?? 0,
          detailNavigations: result.usage?.detailNavigations ?? 0,
          cdpReconnects: result.usage?.cdpReconnects ?? 0,
        };
        await writeRun(inbox, {
          runId: id,
          command,
          status: result.partial ? 'partial' : result.checked ? 'succeeded' : 'recovered',
          startedAt,
          finishedAt: now().toISOString(),
          accountNamespace: result.control.accountNamespace,
          batchId: result.batch?.batchId ?? '',
          snapshotName: result.control.checkpoint.snapshotName,
          snapshotSha256: result.control.checkpoint.snapshotSha256,
          counts,
          errorCode: result.partial ? result.trackerError : '',
          nextAllowedAt: result.control.nextAllowedAt,
        });
        console.log(
          JSON.stringify(
            {
              ok: true,
              command,
              checked: result.checked,
              partial: result.partial ?? false,
              error: result.trackerError || '',
              failureScope: result.failureScope,
              detailEnrichment: result.detailEnrichment,
              history: result.history,
              paused: result.control.paused,
              counts,
              usage: result.usage,
              nextAllowedAt: result.control.nextAllowedAt,
              queue: inbox.inbox,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        const latest = (await inbox.readControl()) ?? before;
        const progress = await snapshotProgress(config, before, latest);
        const failed = await recordFailure({
          inbox,
          control: latest,
          run: id,
          command,
          step: error?.code === 'BOSS_PRODUCER_BUSY' ? 'producer_lock' : checkStep,
          error,
          startedAt,
          counts: {
            completedSnapshots: progress.completedItems,
            remainingSnapshots: progress.remainingItems,
            historyRequests: error?.usage?.historyRequests ?? 0,
            domSwitches: error?.usage?.domSwitches ?? 0,
            detailNavigations: error?.usage?.detailNavigations ?? 0,
            cdpReconnects: error?.usage?.cdpReconnects ?? 0,
          },
          ...progress,
        });
        console.log(
          JSON.stringify(
            {
              ok: false,
              command,
              error: safeErrorCode(error),
              paused: failed?.paused ?? false,
              nextAllowedAt: error?.nextAllowedAt || failed?.nextAllowedAt || '',
              usage: normalizedUsage(error?.usage),
              incidents: inbox.incidents,
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
      }
      return;
    }
    if (command === 'recover-saved') {
      step = 'read_control';
      beforeControl = await inbox.readControl();
      step = 'release_stale_lock';
      const staleLockReleased = await releaseStaleProducerLock(inbox);
      step = 'producer_lock';
      const result = await withProducerLock(inbox, id, () =>
        recoverSavedCommand(
          config,
          inbox,
          (value) => {
            step = value;
          },
          initialIdentity,
        ),
      );
      const counts = {
        recoveredSnapshots: result.recovered.recovered,
        batches: result.recovered.batches,
        events: result.recovered.events,
        pauseCleared: Number(result.pauseCleared),
        staleLockReleased: Number(staleLockReleased),
      };
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: result.recovered.recovered ? 'recovered' : 'unchanged',
        startedAt,
        finishedAt: now().toISOString(),
        accountNamespace: result.control.accountNamespace,
        snapshotName: result.control.checkpoint.snapshotName,
        snapshotSha256: result.control.checkpoint.snapshotSha256,
        counts,
        nextAllowedAt: result.control.nextAllowedAt,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command,
            localRecovery: true,
            checked: false,
            counts,
            pauseCleared: result.pauseCleared,
            requiresResume: result.requiresResume,
            usage: result.usage,
            queue: inbox.inbox,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'resume') {
      step = 'read_control';
      beforeControl = await inbox.readControl();
      step = 'resume_control';
      const result = await resumeCommand(inbox);
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: result.resumed ? 'succeeded' : 'unchanged',
        startedAt,
        finishedAt: now().toISOString(),
        accountNamespace: result.control.accountNamespace,
        snapshotName: result.control.checkpoint.snapshotName,
        snapshotSha256: result.control.checkpoint.snapshotSha256,
        counts: {
          resumed: Number(result.resumed),
          staleLockReleased: Number(result.staleLockReleased),
        },
        nextAllowedAt: result.control.nextAllowedAt,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command,
            resumed: result.resumed,
            staleLockReleased: result.staleLockReleased,
            nextAllowedAt: result.control.nextAllowedAt,
          },
          null,
          2,
        ),
      );
      return;
    }
    step = 'read_status';
    const result = await statusCommand(config, inbox);
    console.log(JSON.stringify({ ok: true, command, ...result, root: inbox.root }, null, 2));
  } catch (error) {
    if (!(error instanceof BossIntegrationError || error instanceof BossInboxError)) {
      error = new BossIntegrationError('BOSS_INTEGRATION_FAILED');
    }
    let incidentRecorded = false;
    let latest = null;
    try {
      latest = await inbox.readControl();
    } catch {
      latest = beforeControl;
    }
    let counts = {};
    let completedItems = 0;
    let remainingItems = 0;
    if (command === 'enqueue') {
      try {
        const queued = (await inbox.list()).filter(
          (row) =>
            row.policyMode === 'initial' &&
            row.snapshotName === initialIdentity.name &&
            row.snapshotSha256 === initialIdentity.sha256,
        );
        const checkpointCommitted = Number(
          latest?.checkpoint?.snapshotName === initialIdentity.name &&
            latest?.checkpoint?.snapshotSha256 === initialIdentity.sha256,
        );
        counts = { queuedBatches: queued.length, checkpointCommitted };
        completedItems = queued.length;
        remainingItems = queued.length && !checkpointCommitted ? 1 : 0;
      } catch {
        counts = {};
      }
    } else if (command === 'resume') {
      counts = { resumed: Number(Boolean(beforeControl?.paused && latest && !latest.paused)) };
      completedItems = counts.resumed;
    } else if (command === 'recover-saved') {
      const progress = await snapshotProgress(config, beforeControl, latest);
      counts = {
        completedSnapshots: progress.completedItems,
        remainingSnapshots: progress.remainingItems,
      };
      completedItems = progress.completedItems;
      remainingItems = progress.remainingItems;
    }
    try {
      await recordFailure({
        inbox,
        control: latest,
        run: id,
        command,
        step,
        error,
        startedAt,
        counts,
        completedItems,
        remainingItems,
      });
      incidentRecorded = true;
    } catch {
      // A broken private volume can also prevent diagnostics. Keep stdout
      // limited to error codes and tell the operator the incident was not saved.
    }
    console.log(
      JSON.stringify(
        {
          ok: false,
          command,
          error: safeErrorCode(error),
          step,
          incidentRecorded,
          ...(command === 'collect-cycle' ? { usage: normalizedUsage(error?.usage) } : {}),
          incidents: inbox.incidents,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
