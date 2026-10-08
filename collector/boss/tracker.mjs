import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  start as startBrowser,
  connect as connectBrowser,
  resume as resumeBrowser,
  recoverPage as recoverPageBrowser,
  capture,
  evaluateBound,
  createCdpDetailAdapter,
  disconnect as disconnectBrowser,
} from './cdp-browser.mjs';
import { accountExpression, expression, toSnapshot } from './extract.mjs';
import {
  latest,
  lock,
  commit,
  loadConnection,
  saveConnection,
  removeConnection,
} from './storage.mjs';
import {
  compareLoadedSnapshotsV2,
  migrateV1ToV2,
  resolveJobRowsV2,
  listEnrichmentTargetsV2,
  applyDetailEvidenceV2,
  upgradeEnvelope,
  validateEnvelope,
} from './model-v2.mjs';
import {
  collectDetailTitleEvidence,
  DETAIL_NAVIGATION_DELAY_MS,
  MAX_DETAIL_ENRICH_JOBS,
} from './detail-enrich.mjs';
import { renderJobs, writePrivateMarkdown } from './export-jobs.mjs';
import { jobCounts } from './job.mjs';
import { receiptCounts } from './receipt.mjs';
import {
  runResumeHistoryRequests,
  toResumeHistoryResult,
  applyResumeHistoryV2,
} from './resume-history.mjs';
import { collectDomSupplement, domSupplementStatus } from './dom-supplement.mjs';
import {
  loadRuntimeState,
  saveRuntimeState,
  selectFair,
  completeRun,
  saveResumeCheckpoint,
  loadResumeCheckpoint,
  removeResumeCheckpoint,
  clearCdpRetry,
  runWithPersistentCdpRetry,
  detailTaskDisposition,
  recordDetailFailure,
  clearDetailFailures,
  resumeDetailState,
  detailRuntimeSummary,
} from './runtime-state.mjs';
import { observeHistoryList, recordHistoryWatermark, historySummary } from './change-history.mjs';
import { createHistoryCommit } from './history-commit.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { accountDataDirectory } from './paths.mjs';

const identityOptions = {
  identityExpression: accountExpression,
  extractAccountIdentity: (payload) => payload?.accountId,
};
const modes = new Set([
  'start',
  'connect',
  'resume',
  'resume-details',
  'recover-page',
  'disconnect',
  'init',
  'check',
  'run',
  'enrich',
  'resume-scan',
  'status',
  'doctor',
]);

export function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new Error('ARGUMENTS_INVALID');
  if (argv.length === 1 && argv[0] === '--help')
    return {
      help: true,
      mode: 'status',
      account: 'main',
      limit: 3,
      pages: 2,
      timeLabel: null,
      jobId: null,
      historyRequests: 20,
      domLimit: 0,
      detailLimit: MAX_DETAIL_ENRICH_JOBS,
      historyMode: 'change',
    };
  const input = [...argv];
  const mode = input.shift() ?? 'status';
  if (!modes.has(mode)) throw new Error('ARGUMENTS_INVALID');
  let account = 'main',
    limit = mode === 'enrich' ? MAX_DETAIL_ENRICH_JOBS : 3,
    pages = 2,
    timeLabel = null,
    jobId = null;
  let historyRequests = 20,
    domLimit = 0,
    detailLimit = MAX_DETAIL_ENRICH_JOBS,
    historyMode = 'change';
  const seen = new Set();
  while (input.length) {
    const flag = input.shift();
    if (
      ![
        '--account',
        '--limit',
        '--pages',
        '--time-label',
        '--job-id',
        '--history-requests',
        '--dom-limit',
        '--detail-limit',
        '--history-mode',
      ].includes(flag) ||
      seen.has(flag) ||
      !input.length
    )
      throw new Error('ARGUMENTS_INVALID');
    seen.add(flag);
    const value = input.shift();
    if (flag === '--account') {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(value)) throw new Error('ARGUMENTS_INVALID');
      account = value;
    } else if (flag === '--limit') {
      limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('ARGUMENTS_INVALID');
    } else if (flag === '--pages') {
      pages = Number(value);
      if (!Number.isInteger(pages) || pages < 1 || pages > 20) throw new Error('ARGUMENTS_INVALID');
    } else if (flag === '--job-id') {
      if (!/^[A-Za-z0-9_-]{1,300}$/.test(value)) throw new Error('ARGUMENTS_INVALID');
      jobId = value;
    } else if (flag === '--history-requests') {
      historyRequests = Number(value);
      if (!Number.isInteger(historyRequests) || historyRequests < 0 || historyRequests > 20)
        throw new Error('ARGUMENTS_INVALID');
    } else if (flag === '--dom-limit') {
      domLimit = Number(value);
      if (!Number.isInteger(domLimit) || domLimit < 0 || domLimit > 1)
        throw new Error('ARGUMENTS_INVALID');
    } else if (flag === '--detail-limit') {
      detailLimit = Number(value);
      if (
        !Number.isInteger(detailLimit) ||
        detailLimit < 0 ||
        detailLimit > MAX_DETAIL_ENRICH_JOBS
      ) {
        throw new Error('ARGUMENTS_INVALID');
      }
    } else if (flag === '--history-mode') {
      if (!['change', 'backfill'].includes(value)) throw new Error('ARGUMENTS_INVALID');
      historyMode = value;
    } else {
      if (value !== '昨天') throw new Error('ARGUMENTS_INVALID');
      timeLabel = value;
    }
  }
  if (!['enrich', 'resume-scan'].includes(mode) && seen.has('--limit'))
    throw new Error('ARGUMENTS_INVALID');
  if (!['enrich', 'resume-scan'].includes(mode) && seen.has('--time-label'))
    throw new Error('ARGUMENTS_INVALID');
  if (mode !== 'resume-scan' && seen.has('--pages')) throw new Error('ARGUMENTS_INVALID');
  if (mode !== 'resume-scan' && seen.has('--job-id')) throw new Error('ARGUMENTS_INVALID');
  if (
    mode !== 'run' &&
    (seen.has('--history-requests') ||
      seen.has('--dom-limit') ||
      seen.has('--detail-limit') ||
      seen.has('--history-mode'))
  ) {
    throw new Error('ARGUMENTS_INVALID');
  }
  if (mode === 'enrich' && limit > MAX_DETAIL_ENRICH_JOBS) throw new Error('ARGUMENTS_INVALID');
  return {
    help: false,
    mode,
    account,
    limit,
    pages,
    timeLabel,
    jobId,
    historyRequests,
    domLimit,
    detailLimit,
    historyMode,
  };
}

function safeError(error, fallback = 'TRACKER_OR_DATA_ERROR') {
  const value = String(error?.message ?? fallback);
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(value) ? value : fallback;
}

export function trackerFailureReport(
  error,
  { mode, usage, savedRuntime = null, historyMode = 'change' } = {},
) {
  const snapshotPath = typeof error?.snapshotPath === 'string' ? error.snapshotPath : null;
  return {
    ok: false,
    saved: Boolean(snapshotPath),
    partial: mode === 'run',
    error: safeError(error),
    ...(snapshotPath ? { file: snapshotPath } : {}),
    ...(mode === 'run'
      ? {
          usage,
          runtimeSaved: Boolean(savedRuntime),
          ...(savedRuntime
            ? {
                history: {
                  mode: historyMode,
                  ...historySummary(savedRuntime.history),
                  backfillCursor: savedRuntime.cursors.resume,
                },
              }
            : {}),
        }
      : {}),
  };
}

const safeBrowserBooleans = [
  'identityVerified',
  'readSucceeded',
  'bindingRetained',
  'originalTargetRetained',
  'verificationUnbound',
  'ownedCreated',
  'released',
  'ownedTargetReleased',
  'alreadyReleased',
  'cleanupOwnedReleased',
  'recovered',
  'ownedReattached',
  'browserLaunched',
];

export function safeBrowserReport(report) {
  const output = {};
  if (!report || typeof report !== 'object' || Array.isArray(report)) return output;
  for (const key of safeBrowserBooleans) {
    if (typeof report[key] === 'boolean') output[key] = report[key];
  }
  for (const key of ['error', 'connectionFailure', 'preReleaseWarning']) {
    if (typeof report[key] === 'string') output[key] = safeError({ message: report[key] });
  }
  return output;
}

function invalidConnectionReport(report) {
  return (
    report?.error === 'CONNECTION_METADATA_INVALID' || report?.error === 'SAVED_CONNECTION_INVALID'
  );
}

async function discardConnection(directory, connection) {
  // A failed or stale lease is not sufficient proof that the referenced tab
  // still belongs to this task. Drop only the metadata; explicit disconnect is
  // the sole path allowed to release a browser tab.
  void connection;
  return removeConnection(directory);
}

function jobSummary(envelope) {
  if (envelope.version === 1)
    return { ...jobCounts(envelope.snapshot.records), candidates: 0, confirmed: 0 };
  const rows = resolveJobRowsV2(envelope);
  return {
    total: rows.length,
    named: rows.filter((row) => row.jobName).length,
    linked: rows.filter((row) => row.detailUrl).length,
    missingName: rows.filter((row) => row.detailUrl && !row.jobName).length,
    candidates: rows.reduce((total, row) => total + row.candidates.length, 0),
    confirmed: rows.filter((row) => row.confirmation === 'confirmed_user').length,
    historical: rows.filter((row) => row.associationStatus === 'historical').length,
  };
}

export function summarizeEnvelope(envelope) {
  if (envelope.version === 1) {
    return {
      version: 1,
      capturedAt: envelope.snapshot.capturedAt,
      trackedRecords: envelope.state.records.length,
      coverage: envelope.snapshot.coverage,
      outgoingReceipts: receiptCounts(envelope.snapshot.records),
      jobs: jobSummary(envelope),
    };
  }
  const checked = validateEnvelope(envelope);
  return {
    version: checked.version,
    capturedAt: checked.snapshot.capturedAt,
    trackedRecords: checked.state.records.length,
    observedThisCapture: checked.snapshot.records.length,
    coverage: checked.snapshot.coverage,
    jobs: jobSummary(checked),
    migration: {
      runs: checked.migration.runs.length,
      quarantined: checked.migration.quarantine.length,
    },
    resume: {
      observations: checked.resume.observations.length,
      strong: checked.resume.observations.filter((item) => item.status === 'strong').length,
      review: checked.resume.observations.filter((item) => item.status === 'review').length,
      lastScanAt: checked.resume.lastScanAt,
      unresolved: checked.resume.lastUnresolved.length,
    },
  };
}

async function readLegacyJobs(directory) {
  let value;
  try {
    value = JSON.parse(await readFile(join(directory, 'jobs-enriched.json'), 'utf8'));
  } catch {
    throw new Error('LEGACY_JOB_ARTIFACT_UNREADABLE');
  }
  return value;
}

async function exportCurrent(directory, envelope) {
  const markdown = renderJobs(envelope, { resolveV2: resolveJobRowsV2 });
  const output = join(directory, 'jobs.md');
  await writePrivateMarkdown(output, markdown);
  return output;
}

export function detailInputs(envelope, timeLabel = null) {
  const { targets } = listEnrichmentTargetsV2(envelope);
  const allowedConversations =
    timeLabel === null
      ? null
      : new Set(
          envelope.snapshot.records
            .filter((record) => record.timeLabel === timeLabel)
            .map((record) => record.key),
        );
  const candidates = targets
    .filter(
      (target) =>
        target.associationStatus === 'current' &&
        (allowedConversations === null || allowedConversations.has(target.conversationKey)),
    )
    .map((target) => ({
      conversationKey: target.conversationKey,
      jobId: target.jobId,
      company: target.company,
      detailUrl: target.detailUrl,
      jobName: target.knownEvidence[0]?.name ?? null,
    }));
  const byJob = new Map();
  for (const evidence of envelope.jobs.evidence) {
    if (
      evidence.source !== 'detail_page_title' ||
      typeof evidence.title !== 'string' ||
      !evidence.title
    )
      continue;
    const normalized = {
      jobId: evidence.jobId,
      detailUrl: evidence.detailUrl,
      name: evidence.name,
      observedCompany: evidence.company,
      title: evidence.title,
      observedAt: evidence.observedAt,
      source: evidence.source,
    };
    const serialized = JSON.stringify(normalized);
    const prior = byJob.get(evidence.jobId);
    if (!prior) byJob.set(evidence.jobId, { serialized, value: normalized, conflict: false });
    else if (prior.serialized !== serialized) prior.conflict = true;
  }
  const knownEvidence = [...byJob.values()]
    .filter((entry) => !entry.conflict)
    .map((entry) => entry.value);
  return { candidates, knownEvidence };
}

export async function saveEnvelope(directory, envelope, { exportJobs = exportCurrent } = {}) {
  const current = upgradeEnvelope(envelope);
  const file = await commit(directory, current);
  let jobsFile;
  try {
    jobsFile = await exportJobs(directory, current);
  } catch (caught) {
    // Export errors can contain field values. Only a machine code and the
    // committed snapshot path may cross the tracker reporting boundary.
    const error = new Error(safeError(caught, 'JOB_EXPORT_FAILED'));
    error.snapshotPath = file;
    throw error;
  }
  return { file, jobsFile };
}

export function fairResumeTargets(
  envelope,
  { cursor = null, limit = 10, timeLabel = null, jobId = null, resumeFrom = null } = {},
) {
  const checked = validateEnvelope(envelope);
  let eligible =
    timeLabel === null
      ? checked.snapshot.records
      : checked.snapshot.records.filter((record) => record.timeLabel === timeLabel);
  if (jobId !== null)
    eligible = eligible.filter((record) => record.jobAssociation?.jobId === jobId);
  let fair;
  const continuing =
    resumeFrom === null ? null : eligible.find((record) => record.key === resumeFrom);
  if (continuing) {
    const remaining = selectFair(
      eligible.filter((record) => record.key !== resumeFrom),
      {
        cursor,
        limit: Math.max(1, limit - 1),
        key: (record) => record.key,
      },
    );
    fair = {
      selected: [continuing, ...remaining.selected].slice(0, limit),
      cursor: remaining.cursor ?? resumeFrom,
    };
  } else {
    fair = selectFair(eligible, { cursor, limit, key: (record) => record.key });
  }
  return {
    cursor: fair.cursor,
    targets: fair.selected.map((record) => ({
      conversationKey: record.key,
      friendId: record.platformIdentity.friendId,
      friendSource: record.platformIdentity.friendSource,
    })),
  };
}

export function fairDetailInputs(
  envelope,
  {
    cursor = null,
    limit = 3,
    timeLabel = null,
    runtime = null,
    now = new Date().toISOString(),
  } = {},
) {
  const checked = validateEnvelope(envelope);
  const input = detailInputs(checked, timeLabel);
  const reviewKeys = new Set(
    checked.jobs.candidates.map((item) =>
      JSON.stringify([item.conversationKey, item.jobId, item.detailUrl]),
    ),
  );
  const eligible = input.candidates.filter(
    (item) =>
      !item.jobName &&
      !reviewKeys.has(JSON.stringify([item.conversationKey, item.jobId, item.detailUrl])),
  );
  const jobs = [];
  for (const candidate of eligible) {
    if (!jobs.some((item) => item.jobId === candidate.jobId)) jobs.push({ jobId: candidate.jobId });
  }
  const dispositions = new Map(
    jobs.map((item) => [
      item.jobId,
      runtime ? detailTaskDisposition(runtime, item.jobId, now) : 'ready',
    ]),
  );
  const selectable = jobs.filter((item) => dispositions.get(item.jobId) === 'ready');
  const fair = selectFair(selectable, { cursor, limit, key: (item) => item.jobId });
  const selectedIds = fair.selected.map((item) => item.jobId);
  return {
    cursor: fair.cursor,
    selectedIds,
    candidates: selectedIds.flatMap((id) => eligible.filter((item) => item.jobId === id)),
    knownEvidence: input.knownEvidence,
    eligibleJobIds: jobs.map((item) => item.jobId),
    pendingJobs: jobs.length,
    deferredJobs: jobs.filter((item) => dispositions.get(item.jobId) === 'backoff').length,
    isolatedJobs: jobs.filter((item) => dispositions.get(item.jobId) === 'isolated').length,
    blocked: runtime?.detail?.blocked === true,
  };
}

function completedDetailCursor(input, collected, priorCursor) {
  const attempted = Math.min(collected.counts.attemptedJobs, input.selectedIds.length);
  return attempted ? input.selectedIds[attempted - 1] : priorCursor;
}

function currentDetailSummary(envelope, runtime, now = new Date().toISOString()) {
  const input =
    envelope && [2, 3, 4].includes(envelope.version)
      ? fairDetailInputs(envelope, { limit: 1, runtime, now })
      : null;
  return detailRuntimeSummary(runtime, {
    pending: input?.pendingJobs ?? 0,
    eligibleJobIds: input?.eligibleJobIds ?? [],
    now,
  });
}

const accountDetailFailure = (code) =>
  /(?:VERIFICATION|LOGIN|LOGGED|ACCOUNT|IDENTITY|BROWSER_INSTANCE|CONNECTION_REBIND|TASK_TARGET|SECURITY)/.test(
    code ?? '',
  );

function updateDetailRuntime(runtime, collected, at, envelope) {
  let next = runtime;
  const completed = new Set(
    [...collected.observations, ...collected.candidates].map((item) => item.jobId),
  );
  if (completed.size) next = clearDetailFailures(next, [...completed], { updatedAt: at });
  for (const failure of collected.failures) {
    next = recordDetailFailure(next, {
      jobId: failure.jobId,
      error: failure.code,
      stage: failure.stage ?? 'read',
      at,
    });
  }
  if (collected.halted?.jobId && !accountDetailFailure(collected.halted.code)) {
    const closeAfterEvidence =
      collected.halted.stage === 'close' && completed.has(collected.halted.jobId);
    if (!closeAfterEvidence || collected.halted.code === 'DETAIL_TAB_OWNERSHIP_MISMATCH') {
      next = recordDetailFailure(next, {
        jobId: collected.halted.jobId,
        error: collected.halted.code,
        stage: collected.halted.stage ?? 'read',
        at,
        block: collected.halted.code === 'DETAIL_TAB_OWNERSHIP_MISMATCH',
      });
      if (closeAfterEvidence)
        next = clearDetailFailures(next, [collected.halted.jobId], { updatedAt: at });
    }
  }
  return {
    runtime: next,
    summary: currentDetailSummary(envelope, next, at),
  };
}

function detailFailureScope(collected, finalIdentity) {
  if (!finalIdentity.ok || accountDetailFailure(collected.halted?.code)) return 'account';
  if (collected.halted || collected.failures.length) return 'detail';
  return 'none';
}

async function withHistoryRequestUsage(options, operation) {
  let used = 0;
  const evaluate = options.evaluate ?? evaluateBound;
  try {
    return await operation({
      ...options,
      evaluate: (...args) => {
        // Issued requests with an unknown outcome still consume one action.
        // Keep the count independent of subsequent local persistence failures.
        used += 1;
        return evaluate(...args);
      },
    });
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(safeError(caught));
    error.usage = { historyRequests: used };
    throw error;
  }
}

export function collectResume(options) {
  return withHistoryRequestUsage(options, collectResumeOperation);
}

async function collectResumeOperation({
  directory,
  connection,
  envelope,
  runtime,
  limit = 10,
  pages = 2,
  maxRequests = 20,
  timeLabel = null,
  jobId = null,
  reportOperation = (operation) => operation(),
  evaluate = evaluateBound,
}) {
  const priorCheckpoint = await loadResumeCheckpoint(directory);
  if (priorCheckpoint?.observations.length) {
    const recovered = toResumeHistoryResult(
      {
        ok: true,
        url: 'https://www.zhipin.com/web/geek/chat',
        capturedAt: priorCheckpoint.capturedAt,
        observations: priorCheckpoint.observations,
        unresolved: priorCheckpoint.unresolved,
        coverage: priorCheckpoint.coverage,
      },
      envelope,
    );
    envelope = applyResumeHistoryV2(envelope, recovered).envelope;
  }
  const startConversationKey = priorCheckpoint?.nextConversationKey ?? null;
  const startPage = startConversationKey === null ? 1 : Math.max(1, priorCheckpoint.nextPage);
  const fair = fairResumeTargets(envelope, {
    cursor: runtime.cursors.resume,
    limit,
    timeLabel,
    jobId,
    resumeFrom: startConversationKey,
  });
  if (!fair.targets.length)
    return {
      envelope,
      counts: {
        observed: 0,
        added: 0,
        strong: 0,
        review: 0,
        unresolved: 0,
        unresolvedByReason: {},
        deduplicated: 0,
      },
      coverage: null,
      usage: { historyRequests: 0 },
      partial: false,
      error: null,
      cursor: runtime.cursors.resume,
      checkpointPending: Boolean(priorCheckpoint),
    };
  const preflight = await reportOperation(() => resumeBrowser(connection, identityOptions));
  if (!preflight.ok)
    return {
      envelope,
      counts: null,
      coverage: null,
      usage: { historyRequests: 0 },
      partial: true,
      error: preflight.report.error,
      cursor: runtime.cursors.resume,
      verification: preflight.report,
    };
  const scan = await runResumeHistoryRequests({
    targets: fair.targets,
    pages,
    maxRequests,
    requestDelayMs: 3000,
    initialObservations: priorCheckpoint?.observations ?? [],
    startConversationKey,
    startPage,
    knownMessageIds: [
      ...envelope.resume.observations.map((item) => ({
        conversationKey: item.conversationKey,
        messageId: item.messageId,
      })),
      ...(runtime.history?.conversations ?? [])
        .filter((item) => item.watermark)
        .map((item) => ({
          conversationKey: item.key,
          messageId: item.watermark,
        })),
    ],
    execute: async (expression) => {
      // The page may already have issued this platform request when CDP drops.
      // Never replay it inside the reconnect loop: the in-page XHR aborts at
      // 15 seconds, while the next scheduled round resumes the durable page.
      const payload = await evaluate(connection, expression);
      if (!payload || typeof payload !== 'object') throw new Error('HISTORY_RESPONSE_INVALID');
      return payload;
    },
    onCheckpoint: (value) => saveResumeCheckpoint(directory, value),
  });
  const result = toResumeHistoryResult(scan.payload, envelope);
  const applied = applyResumeHistoryV2(envelope, result);
  const finalCheck = await reportOperation(() => resumeBrowser(connection, identityOptions));
  const error = scan.error ?? (finalCheck.ok ? null : finalCheck.report.error);
  return {
    envelope: applied.envelope,
    counts: applied.report.counts,
    coverage: result.coverage,
    usage: scan.usage,
    partial: scan.partial || !finalCheck.ok,
    error,
    cursor: scan.cursor ?? runtime.cursors.resume,
    checkpointPending: true,
    continuation: scan.continuation,
    completed: scan.completed,
    verification: finalCheck.report,
  };
}

export function collectChangedResume(options) {
  return withHistoryRequestUsage(options, collectChangedResumeOperation);
}

async function collectChangedResumeOperation({
  directory,
  connection,
  envelope,
  runtime,
  maxRequests,
  saveProgress = (state) => saveRuntimeState(directory, { ...runtime, history: state }),
  saveEvidence = (value) => saveEnvelope(directory, value),
  requestDelayMs = 3000,
  betweenTargetsDelayMs = 3000,
  reportOperation = (operation) => operation(),
  evaluate = evaluateBound,
}) {
  const history = createHistoryCommit({
    directory,
    envelope,
    state: runtime.history,
    saveEvidence,
    saveProgress,
  });
  const pending = await history.prepare();
  const prior = history.checkpoint;
  if (!pending.length && !prior)
    return {
      envelope: history.envelope,
      state: history.state,
      counts: {
        observed: 0,
        added: 0,
        strong: 0,
        review: 0,
        unresolved: 0,
        unresolvedByReason: {},
        deduplicated: 0,
      },
      coverage: null,
      usage: { historyRequests: 0 },
      partial: false,
      error: null,
    };
  const preflight = await reportOperation(() => resumeBrowser(connection, identityOptions));
  if (!preflight.ok)
    return {
      envelope: history.envelope,
      state: history.state,
      counts: null,
      coverage: null,
      usage: { historyRequests: 0 },
      partial: true,
      error: preflight.report.error,
      verification: preflight.report,
    };
  let used = 0,
    coverage = null,
    partial = false,
    error = null;
  const counts = {
    observed: 0,
    added: 0,
    strong: 0,
    review: 0,
    unresolved: 0,
    unresolvedByReason: {},
    deduplicated: 0,
  };
  const ordered =
    prior?.nextConversationKey || prior?.completedConversationKey
      ? [...pending].sort(
          (a, b) =>
            (a.key === (prior.nextConversationKey ?? prior.completedConversationKey) ? -1 : 0) -
            (b.key === (prior.nextConversationKey ?? prior.completedConversationKey) ? -1 : 0),
        )
      : pending;
  for (const item of ordered) {
    if (maxRequests - used < 2 && history.checkpoint?.completedConversationKey !== item.key) break;
    const task = item.task;
    if (!task) continue;
    if (used && betweenTargetsDelayMs)
      await new Promise((resolve) => setTimeout(resolve, betweenTargetsDelayMs));
    const checkpoint = history.forTask(item.key);
    if (checkpoint && checkpoint.targetFingerprint !== task.fingerprint)
      throw new Error('CHANGE_CHECKPOINT_TARGET_CHANGED');
    if (checkpoint?.completedConversationKey === item.key) {
      await history.completeFromCheckpoint(item);
      continue;
    }
    const record = history.envelope.snapshot.records.find((entry) => entry.key === item.key);
    if (!record) {
      await history.discardMissingRecord();
      continue;
    }
    const startPage = checkpoint?.nextPage ?? task.page;
    const scan = await runResumeHistoryRequests({
      targets: [
        {
          conversationKey: item.key,
          friendId: record.platformIdentity.friendId,
          friendSource: record.platformIdentity.friendSource,
        },
      ],
      pages: 2,
      maxRequests: maxRequests - used,
      requestDelayMs,
      startConversationKey: item.key,
      startPage,
      initialObservations: checkpoint?.observations ?? [],
      initialHead: checkpoint?.head ?? task.head,
      knownMessageIds: item.watermark
        ? [{ conversationKey: item.key, messageId: item.watermark }]
        : [],
      execute: (expression, metadata) => evaluate(connection, expression, metadata),
      onCheckpoint: (value) => history.checkpointPage(value, task.fingerprint),
    });
    used += scan.usage.historyRequests;
    const committed = await history.commitScan(item, scan);
    for (const key of ['observed', 'added', 'strong', 'review', 'unresolved', 'deduplicated'])
      counts[key] += committed.counts[key] ?? 0;
    for (const [reason, amount] of Object.entries(committed.counts.unresolvedByReason ?? {}))
      counts.unresolvedByReason[reason] = (counts.unresolvedByReason[reason] ?? 0) + amount;
    if (!coverage)
      coverage = {
        requestedConversations: 0,
        resolvedConversations: 0,
        pagesPerConversation: 2,
        requestedPages: 0,
        completedPages: 0,
        exhaustedConversations: 0,
        truncatedConversations: 0,
        failedConversations: 0,
      };
    for (const key of [
      'requestedConversations',
      'resolvedConversations',
      'requestedPages',
      'completedPages',
      'exhaustedConversations',
      'truncatedConversations',
      'failedConversations',
    ])
      coverage[key] += committed.coverage[key] ?? 0;
    if (scan.error) {
      partial = true;
      error = scan.error;
      break;
    }
  }
  const finalCheck = await reportOperation(() => resumeBrowser(connection, identityOptions));
  return {
    envelope: history.envelope,
    state: history.state,
    counts,
    coverage,
    usage: { historyRequests: used },
    partial: partial || !finalCheck.ok,
    error: error ?? (finalCheck.ok ? null : finalCheck.report.error),
    verification: finalCheck.report,
  };
}

async function settleResumeCheckpoint(directory, scanned) {
  if (!scanned.checkpointPending) return;
  if (!scanned.continuation) {
    await removeResumeCheckpoint(directory);
    return;
  }
  await saveResumeCheckpoint(directory, {
    version: 2,
    capturedAt: new Date().toISOString(),
    nextConversationKey: scanned.continuation.conversationKey,
    nextPage: scanned.continuation.page,
    observations: [],
    unresolved: [],
    coverage: scanned.coverage ?? {},
    usage: { historyRequests: 0 },
    partial: false,
    error: null,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(
      [
        'Usage: node tracker.mjs start|connect|resume|resume-details|recover-page|run|check|enrich|resume-scan|status|doctor [--account label]',
        'start/connect: 显式启动并绑定专用 BOSS 页；缺页时最多创建或导航一次',
        'resume: 只核验已绑定浏览器与标签，不创建、导航或刷新',
        'resume-details: 仅解除详情所有权技术阻断，不访问浏览器、不清除岗位退避或隔离',
        'recover-page: 显式恢复任务页并重新绑定；最多创建或导航一次',
        'run: 默认变化驱动，一次有界执行列表、历史、DOM 和详情补齐',
        'run --history-mode backfill: 显式公平轮转历史扫描；正常轮次仍为变化驱动',
        'run budget: --history-requests 0..20 --dom-limit 0..1 --detail-limit 0..20；0 表示跳过该阶段',
        'check: 从任务专用后台页读取已加载会话、比较并保存 v3 快照',
        'enrich: 用任务自建详情标签补齐缺失岗位名称；默认且最多 --limit 20',
        'resume-scan: 通过只读历史接口保存结构化简历观察；默认 --limit 3 --pages 2',
        'status: 仅查看本地统计，不连接浏览器',
        'disconnect: 解除任务标签绑定，不关闭、置空或导航标签',
        'init: 建立全新的 v3 基线；已有任意基线时拒绝覆盖',
      ].join('\n'),
    );
    return;
  }
  const {
    mode,
    account,
    limit,
    pages,
    timeLabel,
    jobId,
    historyRequests,
    domLimit,
    detailLimit,
    historyMode,
  } = options;
  const directory = accountDataDirectory(account);
  let release;
  const failureUsage = {
    historyRequests: 0,
    domSwitches: 0,
    detailNavigations: 0,
    cdpReconnects: 0,
  };
  let runRuntime = null,
    sharedRuntime = null,
    runStartedAt = null,
    runId = null,
    runListObserved = 0,
    runFinalized = false;
  try {
    if (mode === 'status' || mode === 'doctor') {
      const [saved, connected, runtime] = await Promise.all([
        latest(directory),
        loadConnection(directory),
        loadRuntimeState(directory),
      ]);
      const dom =
        saved && [2, 3, 4].includes(saved.envelope.version)
          ? await domSupplementStatus(directory, saved.envelope)
          : null;
      console.log(
        JSON.stringify(
          {
            ok: true,
            account,
            connectionSaved: Boolean(connected),
            initialized: Boolean(saved),
            connectionVersion: connected?.connection.version ?? null,
            bindingRequiresUpgrade: connected?.connection.version === 1,
            ...(saved ? summarizeEnvelope(saved.envelope) : {}),
            file: saved?.path ?? null,
            runtime: runtime.lastRun,
            cdpRetry: runtime.cdpRetry,
            detailEnrichment: currentDetailSummary(saved?.envelope, runtime),
            history: { ...historySummary(runtime.history), backfillCursor: runtime.cursors.resume },
            dom,
          },
          null,
          2,
        ),
      );
      return;
    }

    release = await lock(directory);
    sharedRuntime = await loadRuntimeState(directory);
    if (mode === 'resume-details') {
      sharedRuntime = resumeDetailState(sharedRuntime, { updatedAt: new Date().toISOString() });
      await saveRuntimeState(directory, sharedRuntime);
      const current = await latest(directory);
      console.log(
        JSON.stringify(
          {
            ok: true,
            account,
            detailEnrichment: currentDetailSummary(current?.envelope, sharedRuntime),
          },
          null,
          2,
        ),
      );
      return;
    }
    const retryOperation = async (operation, errorOf) => {
      let priorAttempts = sharedRuntime.cdpRetry.attempts;
      const attempted = await runWithPersistentCdpRetry(sharedRuntime, {
        operation,
        errorOf,
        persist: async (value) => {
          if (value.cdpRetry.attempts > priorAttempts)
            failureUsage.cdpReconnects += value.cdpRetry.attempts - priorAttempts;
          priorAttempts = value.cdpRetry.attempts;
          sharedRuntime = value;
          if (mode === 'run') runRuntime = value;
          await saveRuntimeState(directory, value);
        },
      });
      sharedRuntime = attempted.state;
      if (mode === 'run') runRuntime = sharedRuntime;
      return attempted.value;
    };
    const retryReport = (operation) =>
      retryOperation(operation, (value) => (value?.ok === false ? value.report?.error : null));
    if (mode === 'run') {
      runRuntime = sharedRuntime;
      runStartedAt = new Date().toISOString();
      runId = randomUUID();
    }
    if (['start', 'connect', 'recover-page'].includes(mode)) {
      const operation =
        mode === 'recover-page'
          ? recoverPageBrowser
          : mode === 'start'
            ? startBrowser
            : connectBrowser;
      const result = await operation({ account, ...identityOptions });
      if (!result.ok) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              saved: false,
              error: result.report.error,
              connectionSaved: Boolean(await loadConnection(directory)),
              verification: safeBrowserReport(result.report),
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
      let path;
      try {
        path = await saveConnection(directory, result.connection);
      } catch (error) {
        try {
          await disconnectBrowser(result.connection);
        } catch {}
        throw error;
      }
      sharedRuntime = clearCdpRetry(sharedRuntime, { updatedAt: new Date().toISOString() });
      await saveRuntimeState(directory, sharedRuntime);
      console.log(
        JSON.stringify(
          {
            ok: true,
            connectionSaved: true,
            account,
            path,
            operation: mode,
            verification: {
              identityVerified: result.report.identityVerified,
              originalTargetRetained: result.report.originalTargetRetained,
              bindingRetained: result.report.bindingRetained,
            },
          },
          null,
          2,
        ),
      );
      return;
    }

    const storedConnection = await loadConnection(directory);
    if (mode === 'resume') {
      if (!storedConnection) throw new Error('CONNECTION_REQUIRED');
      const result = await retryReport(() =>
        resumeBrowser(storedConnection.connection, identityOptions),
      );
      console.log(
        JSON.stringify(
          {
            ok: result.ok,
            account,
            connectionSaved: true,
            error: result.ok ? null : result.report.error,
            usage: { cdpReconnects: failureUsage.cdpReconnects },
            verification: safeBrowserReport(result.report),
          },
          null,
          2,
        ),
      );
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (mode === 'disconnect') {
      if (!storedConnection) {
        console.log(
          JSON.stringify(
            { ok: true, connectionSaved: false, alreadyDisconnected: true, account },
            null,
            2,
          ),
        );
        return;
      }
      const result = await disconnectBrowser(storedConnection.connection);
      const definitelyReleased =
        result.ok ||
        result.report.alreadyReleased === true ||
        (result.report.released === true && result.report.ownedTargetReleased === true);
      const removed = definitelyReleased ? await removeConnection(directory) : false;
      const ok = Boolean(definitelyReleased && removed);
      console.log(
        JSON.stringify(
          {
            ok,
            connectionSaved: !removed,
            account,
            released: result.report.released === true || result.report.alreadyReleased === true,
            ownedTargetReleased: result.report.ownedTargetReleased === true,
            error: ok ? null : (result.report.error ?? 'DISCONNECT_FAILED'),
          },
          null,
          2,
        ),
      );
      if (!ok) process.exitCode = 1;
      return;
    }

    const saved = await latest(directory);
    if (mode === 'init' && saved) throw new Error('BASELINE_ALREADY_EXISTS');
    if (mode !== 'init' && !saved) throw new Error('BASELINE_REQUIRED');
    if (!storedConnection) throw new Error('CONNECTION_REQUIRED');
    const activeConnection = storedConnection.connection;
    let runtime = sharedRuntime;
    const commandStartedAt = runStartedAt ?? new Date().toISOString();

    if (mode === 'enrich') {
      if (![2, 3, 4].includes(saved.envelope.version)) throw new Error('V2_CHECK_REQUIRED');
      const identityCheck = await retryReport(() =>
        resumeBrowser(activeConnection, identityOptions),
      );
      runtime = sharedRuntime;
      if (!identityCheck.ok) {
        const connectionCleared = invalidConnectionReport(identityCheck.report)
          ? await discardConnection(directory, activeConnection)
          : false;
        console.log(
          JSON.stringify(
            {
              ok: false,
              saved: false,
              error: identityCheck.report.error,
              connectionCleared,
              verification: safeBrowserReport(identityCheck.report),
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
      const detailAt = new Date().toISOString();
      const input = fairDetailInputs(saved.envelope, {
        cursor: runtime.cursors.detail,
        limit,
        timeLabel,
        runtime,
        now: detailAt,
      });
      if (input.blocked) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              saved: false,
              error: 'DETAIL_ENRICHMENT_BLOCKED',
              detailEnrichment: detailRuntimeSummary(runtime, {
                pending: input.pendingJobs,
                eligibleJobIds: input.eligibleJobIds,
                now: detailAt,
              }),
              usage: {
                historyRequests: 0,
                domSwitches: 0,
                detailNavigations: 0,
                cdpReconnects: failureUsage.cdpReconnects,
              },
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
      const collected = await collectDetailTitleEvidence({
        ...input,
        limit,
        navigationDelayMs: DETAIL_NAVIGATION_DELAY_MS,
        adapter: createCdpDetailAdapter(activeConnection),
      });
      const appliedAt = new Date().toISOString();
      const applied = applyDetailEvidenceV2(saved.envelope, collected, appliedAt);
      let files = { file: saved.path, jobsFile: join(directory, 'jobs.md') };
      if (applied.report.counts.accepted || applied.report.counts.candidateSaved) {
        files = await saveEnvelope(directory, applied.envelope);
      } else {
        await exportCurrent(directory, applied.envelope);
      }
      const detailUpdate = updateDetailRuntime(
        runtime,
        collected,
        new Date().toISOString(),
        applied.envelope,
      );
      runtime = {
        ...detailUpdate.runtime,
        cursors: {
          ...detailUpdate.runtime.cursors,
          detail: completedDetailCursor(input, collected, runtime.cursors.detail),
        },
        updatedAt: new Date().toISOString(),
      };
      await saveRuntimeState(directory, runtime);
      sharedRuntime = runtime;
      const finalIdentityCheck = await retryReport(() =>
        resumeBrowser(activeConnection, identityOptions),
      );
      runtime = sharedRuntime;
      const connectionCleared =
        !finalIdentityCheck.ok && invalidConnectionReport(finalIdentityCheck.report)
          ? await discardConnection(directory, activeConnection)
          : false;
      const ok = !collected.halted && collected.failures.length === 0 && finalIdentityCheck.ok;
      console.log(
        JSON.stringify(
          {
            ok,
            account,
            saved: files.file !== saved.path,
            counts: { ...collected.counts, ...applied.report.counts },
            halted: collected.halted?.code ?? null,
            usage: {
              historyRequests: 0,
              domSwitches: 0,
              detailNavigations: collected.counts.attemptedJobs,
              cdpReconnects: failureUsage.cdpReconnects,
            },
            cleanup: collected.cleanup,
            remaining: collected.remaining.length,
            jobs: jobSummary(applied.envelope),
            failureScope: accountDetailFailure(collected.halted?.code)
              ? 'account'
              : collected.halted || collected.failures.length
                ? 'detail'
                : 'none',
            detailEnrichment: detailUpdate.summary,
            ...files,
            connectionCleared,
            verification: safeBrowserReport(finalIdentityCheck.report),
          },
          null,
          2,
        ),
      );
      if (!ok) process.exitCode = 1;
      return;
    }

    if (mode === 'resume-scan') {
      if (![2, 3, 4].includes(saved.envelope.version)) throw new Error('V2_CHECK_REQUIRED');
      const scanned = await collectResume({
        directory,
        connection: activeConnection,
        envelope: saved.envelope,
        runtime,
        limit,
        pages,
        timeLabel,
        jobId,
        reportOperation: retryReport,
      });
      runtime = sharedRuntime;
      if (scanned.counts === null) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              saved: false,
              partial: true,
              error: scanned.error,
              usage: {
                historyRequests: 0,
                domSwitches: 0,
                detailNavigations: 0,
                cdpReconnects: failureUsage.cdpReconnects,
              },
              verification: safeBrowserReport(scanned.verification),
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
      const files = await saveEnvelope(directory, scanned.envelope);
      await settleResumeCheckpoint(directory, scanned);
      runtime = {
        ...runtime,
        cursors: { ...runtime.cursors, resume: scanned.cursor },
        updatedAt: new Date().toISOString(),
      };
      await saveRuntimeState(directory, runtime);
      console.log(
        JSON.stringify(
          {
            ok: !scanned.partial,
            account,
            saved: true,
            partial: scanned.partial,
            error: scanned.error,
            accountNamespace: activeConnection.accountNamespace,
            counts: scanned.counts,
            coverage: scanned.coverage,
            ...files,
            usage: {
              ...scanned.usage,
              domSwitches: 0,
              detailNavigations: 0,
              cdpReconnects: failureUsage.cdpReconnects,
            },
            verification: safeBrowserReport(scanned.verification),
          },
          null,
          2,
        ),
      );
      if (scanned.partial) process.exitCode = 1;
      return;
    }

    const result = await retryReport(() => capture(activeConnection, expression, identityOptions));
    runtime = sharedRuntime;
    if (!result.ok) {
      const connectionCleared = invalidConnectionReport(result.report)
        ? await discardConnection(directory, activeConnection)
        : false;
      if (mode === 'run') {
        const finishedAt = new Date().toISOString();
        runtime = completeRun(runtime, {
          runId,
          startedAt: commandStartedAt,
          finishedAt,
          status: 'failed',
          error: result.report.error,
          counts: { listObserved: 0 },
          usage: {
            historyRequests: 0,
            domSwitches: 0,
            detailNavigations: 0,
            cdpReconnects: failureUsage.cdpReconnects,
          },
        });
        await saveRuntimeState(directory, runtime);
        runRuntime = runtime;
        runFinalized = true;
      }
      console.log(
        JSON.stringify(
          {
            ok: false,
            saved: false,
            partial: mode === 'run',
            error: result.report.error,
            accountNamespace: activeConnection.accountNamespace,
            connectionCleared,
            usage: {
              historyRequests: 0,
              domSwitches: 0,
              detailNavigations: 0,
              cdpReconnects: failureUsage.cdpReconnects,
            },
            verification: safeBrowserReport(result.report),
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      return;
    }
    const snapshot = toSnapshot(result.payload);
    if (mode === 'run') runListObserved = snapshot.records.length;
    if (snapshot.accountNamespace !== activeConnection.accountNamespace)
      throw new Error('ACCOUNT_NAMESPACE_CHANGED');
    let envelope, operationReport;
    if (!saved) {
      const compared = compareLoadedSnapshotsV2(null, snapshot);
      envelope = compared.envelope;
      operationReport = { capture: compared.report };
    } else if (saved.envelope.version === 1) {
      const migrated = migrateV1ToV2({
        snapshot,
        v1Envelope: saved.envelope,
        enrichedJobs: await readLegacyJobs(directory),
        migratedAt: new Date().toISOString(),
      });
      envelope = migrated.envelope;
      operationReport = migrated.report;
    } else {
      const compared = compareLoadedSnapshotsV2(saved.envelope, snapshot);
      envelope = compared.envelope;
      operationReport = { capture: compared.report };
    }
    if (mode === 'run') {
      const startedAt = commandStartedAt;
      // Preserve legacy page evidence before creating a new change-driven task.
      const legacyCheckpoint = await loadResumeCheckpoint(directory);
      const legacyDigest = legacyCheckpoint
        ? createHash('sha256').update(JSON.stringify(legacyCheckpoint)).digest('hex')
        : null;
      if (
        legacyCheckpoint?.observations.length &&
        legacyDigest !== runtime.history.legacyCheckpointDigest
      ) {
        const recovered = toResumeHistoryResult(
          {
            ok: true,
            url: 'https://www.zhipin.com/web/geek/chat',
            capturedAt: legacyCheckpoint.capturedAt,
            observations: legacyCheckpoint.observations,
            unresolved: legacyCheckpoint.unresolved,
            coverage: legacyCheckpoint.coverage,
          },
          envelope,
        );
        envelope = applyResumeHistoryV2(envelope, recovered).envelope;
        await saveEnvelope(directory, envelope);
      }
      runtime = {
        ...runtime,
        history: {
          ...observeHistoryList(runtime.history, snapshot.records, startedAt),
          legacyCheckpointDigest: legacyDigest ?? runtime.history.legacyCheckpointDigest,
        },
      };
      sharedRuntime = runtime;
      await saveRuntimeState(directory, runtime);
      let history = {
        envelope,
        counts: { observed: 0, added: 0, strong: 0, review: 0, unresolved: 0, deduplicated: 0 },
        coverage: null,
        usage: { historyRequests: 0 },
        partial: false,
        error: null,
        cursor: runtime.cursors.resume,
      };
      if ([2, 3, 4].includes(envelope.version) && historyRequests > 0)
        history =
          historyMode === 'backfill'
            ? await collectResume({
                directory,
                connection: activeConnection,
                envelope,
                runtime,
                limit: 10,
                pages: 2,
                maxRequests: historyRequests,
                reportOperation: retryReport,
              })
            : await collectChangedResume({
                directory,
                connection: activeConnection,
                envelope,
                runtime,
                maxRequests: historyRequests,
                saveProgress: async (state) => {
                  sharedRuntime = { ...sharedRuntime, history: state };
                  await saveRuntimeState(directory, sharedRuntime);
                },
                reportOperation: retryReport,
              });
      runtime = { ...sharedRuntime, history: history.state ?? runtime.history };
      if (historyMode === 'backfill' && history.completed?.length) {
        for (const item of history.completed)
          runtime.history = recordHistoryWatermark(
            runtime.history,
            item.conversationKey,
            item.head,
          );
      }
      sharedRuntime = runtime;
      failureUsage.historyRequests = history.usage.historyRequests;
      envelope = history.envelope;
      let dom = {
        envelope,
        usage: { domSwitches: 0 },
        counts: { pending: 0, selected: 0, switched: 0, observed: 0, added: 0, unresolved: 0 },
        partial: false,
        error: null,
        reason: 'DOM_BUDGET_ZERO',
        policyStatus: 'not_checked',
        checkpointPending: false,
        nextAllowedAt: null,
      };
      if (!history.partial && [2, 3, 4].includes(envelope.version) && domLimit > 0) {
        dom = await collectDomSupplement({
          directory,
          envelope,
          maxSwitches: domLimit,
          verify: async () => {
            const result = await retryReport(() =>
              resumeBrowser(activeConnection, identityOptions),
            );
            return { ok: result.ok, error: result.ok ? null : result.report.error };
          },
          execute: (expression, metadata) => evaluateBound(activeConnection, expression, metadata),
        });
      }
      runtime = sharedRuntime;
      failureUsage.domSwitches = dom.usage.domSwitches;
      envelope = dom.envelope;
      let detailCollected = {
        counts: {
          attemptedJobs: 0,
          accepted: 0,
          candidates: 0,
          failures: 0,
          skipped: 0,
          remaining: 0,
        },
        observations: [],
        candidates: [],
        failures: [],
        remaining: [],
        halted: null,
        cleanup: { status: 'not_needed' },
      };
      let detailApplied = {
        envelope,
        report: {
          counts: {
            observations: 0,
            candidates: 0,
            accepted: 0,
            candidateSaved: 0,
            duplicates: 0,
            companyMismatch: 0,
          },
        },
      };
      let detailCursor = runtime.cursors.detail;
      if (
        !history.partial &&
        !dom.partial &&
        [2, 3, 4].includes(envelope.version) &&
        detailLimit > 0
      ) {
        const detailAt = new Date().toISOString();
        const input = fairDetailInputs(envelope, {
          cursor: runtime.cursors.detail,
          limit: detailLimit,
          runtime,
          now: detailAt,
        });
        if (!input.blocked && input.selectedIds.length) {
          detailCollected = await collectDetailTitleEvidence({
            ...input,
            limit: detailLimit,
            navigationDelayMs: DETAIL_NAVIGATION_DELAY_MS,
            adapter: createCdpDetailAdapter(activeConnection),
          });
          detailCursor = completedDetailCursor(input, detailCollected, runtime.cursors.detail);
          failureUsage.detailNavigations = detailCollected.counts.attemptedJobs;
          detailApplied = applyDetailEvidenceV2(
            envelope,
            detailCollected,
            new Date().toISOString(),
          );
          envelope = detailApplied.envelope;
        }
        const detailUpdate = updateDetailRuntime(
          runtime,
          detailCollected,
          new Date().toISOString(),
          envelope,
        );
        runtime = detailUpdate.runtime;
        sharedRuntime = runtime;
        runRuntime = runtime;
        detailCollected.detailEnrichment = detailUpdate.summary;
      }
      const finalIdentity = await retryReport(() =>
        resumeBrowser(activeConnection, identityOptions),
      );
      runtime = sharedRuntime;
      const files = await saveEnvelope(directory, envelope);
      if (historyMode === 'backfill') await settleResumeCheckpoint(directory, history);
      const detailFailed = Boolean(detailCollected.halted || detailCollected.failures.length);
      const partial = history.partial || dom.partial || detailFailed || !finalIdentity.ok;
      const failureScope =
        history.partial || dom.partial || !finalIdentity.ok
          ? 'account'
          : detailFailureScope(detailCollected, finalIdentity);
      const error =
        history.error ??
        dom.error ??
        (finalIdentity.ok ? null : finalIdentity.report.error) ??
        detailCollected.halted?.code ??
        (detailCollected.failures.length ? 'DETAIL_ENRICH_PARTIAL' : null);
      const finishedAt = new Date().toISOString();
      runtime = {
        ...runtime,
        cursors: {
          resume: historyMode === 'backfill' ? history.cursor : runtime.cursors.resume,
          detail: detailCursor,
        },
      };
      const finalDetailSummary =
        detailCollected.detailEnrichment ?? currentDetailSummary(envelope, runtime, finishedAt);
      runtime = completeRun(runtime, {
        runId,
        startedAt,
        finishedAt,
        status: partial ? 'partial' : 'ok',
        error,
        counts: {
          listObserved: snapshot.records.length,
          resumeObserved: history.counts?.observed ?? 0,
          resumeAdded: history.counts?.added ?? 0,
          domObserved: dom.counts.observed,
          domAdded: dom.counts.added,
          detailAccepted: detailApplied.report.counts.accepted,
          detailCandidates: detailApplied.report.counts.candidateSaved,
        },
        usage: {
          historyRequests: history.usage.historyRequests,
          domSwitches: dom.usage.domSwitches,
          detailNavigations: detailCollected.counts.attemptedJobs,
          cdpReconnects: failureUsage.cdpReconnects,
        },
      });
      await saveRuntimeState(directory, runtime);
      runRuntime = runtime;
      runFinalized = true;
      console.log(
        JSON.stringify(
          {
            ok: !partial,
            saved: true,
            partial,
            error,
            account,
            accountNamespace: activeConnection.accountNamespace,
            file: files.file,
            jobsFile: files.jobsFile,
            counts: {
              list: operationReport.capture.counts,
              resume: history.counts,
              dom: dom.counts,
              detail: { ...detailCollected.counts, ...detailApplied.report.counts },
            },
            coverage: { list: snapshot.coverage, resume: history.coverage },
            history: {
              mode: historyMode,
              ...historySummary(runtime.history),
              backfillCursor: runtime.cursors.resume,
            },
            dom: {
              reason: dom.reason,
              policyStatus: dom.policyStatus,
              checkpointPending: dom.checkpointPending,
              nextAllowedAt: dom.nextAllowedAt,
            },
            usage: {
              historyRequests: history.usage.historyRequests,
              domSwitches: dom.usage.domSwitches,
              detailNavigations: detailCollected.counts.attemptedJobs,
              cdpReconnects: failureUsage.cdpReconnects,
            },
            failureScope,
            detailEnrichment: finalDetailSummary,
            verification: safeBrowserReport(finalIdentity.report),
          },
          null,
          2,
        ),
      );
      if (partial) process.exitCode = 1;
      return;
    }
    const files = await saveEnvelope(directory, envelope);
    console.log(
      JSON.stringify(
        {
          ok: true,
          saved: true,
          mode: operationReport.capture.mode,
          account,
          capturedAt: snapshot.capturedAt,
          accountNamespace: activeConnection.accountNamespace,
          coverage: snapshot.coverage,
          counts: operationReport.capture.counts,
          usage: {
            historyRequests: 0,
            domSwitches: 0,
            detailNavigations: 0,
            cdpReconnects: failureUsage.cdpReconnects,
          },
          migration: operationReport.migration?.counts ?? null,
          jobs: jobSummary(envelope),
          ...files,
          verification: {
            readSucceeded: result.report.readSucceeded,
            identityVerified: result.report.identityVerified,
            ownedBindingRetained: result.report.bindingRetained,
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (mode === 'run' && Object.hasOwn(error?.usage ?? {}, 'historyRequests')) {
      const reported = error.usage.historyRequests;
      if (Number.isSafeInteger(reported) && reported >= 0 && reported <= historyRequests)
        failureUsage.historyRequests = reported;
      else delete failureUsage.historyRequests;
    }
    let savedFailureRuntime = null;
    if (mode === 'run' && runRuntime && runStartedAt && runId && !runFinalized) {
      try {
        // Earlier conversations may already have committed progress before a
        // later stage failed. Keep the durable state, not the run's start.
        const failed = completeRun(await loadRuntimeState(directory), {
          runId,
          startedAt: runStartedAt,
          finishedAt: new Date().toISOString(),
          status: runListObserved ? 'partial' : 'failed',
          error: safeError(error),
          counts: { listObserved: runListObserved },
          usage: failureUsage,
        });
        await saveRuntimeState(directory, failed);
        savedFailureRuntime = failed;
      } catch {}
    }
    console.log(
      JSON.stringify(
        trackerFailureReport(error, {
          mode,
          usage: failureUsage,
          savedRuntime: savedFailureRuntime,
          historyMode,
        }),
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        console.error('CAPTURE_LOCK_RELEASE_FAILED');
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
