import { applyDetailEvidenceV2, listEnrichmentTargetsV2, validateEnvelope } from './model-v2.mjs';
import {
  collectDetailTitleEvidence,
  DETAIL_NAVIGATION_DELAY_MS,
  MAX_DETAIL_ENRICH_JOBS,
} from './detail-enrich.mjs';
import {
  clearDetailFailures,
  detailRuntimeSummary,
  detailTaskDisposition,
  normalizeRuntimeState,
  recordDetailFailure,
  selectFair,
} from './runtime-state.mjs';

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

export function currentDetailSummary(envelope, runtime, now = new Date().toISOString()) {
  const input =
    envelope && [2, 3, 4, 5, 6, 7, 8].includes(envelope.version)
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
    detail: next.detail,
    summary: currentDetailSummary(envelope, next, at),
  };
}

export function detailFailureScope(collected, finalIdentity) {
  if (!finalIdentity.ok || accountDetailFailure(collected.halted?.code)) return 'account';
  if (collected.halted || collected.failures.length) return 'detail';
  return 'none';
}

function emptyCollected() {
  return {
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
    skipped: [],
    remaining: [],
    halted: null,
    cleanup: { status: 'not_needed' },
  };
}

function emptyApplied(envelope) {
  return {
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
}

/**
 * Run the shared detail phase without saving evidence or runtime progress.
 * Callers must save the returned envelope before committing detailRuntime and
 * detailCursor. Merge these fields into the latest runtime so intervening CDP
 * retries, history progress and final identity checks retain their state.
 * A stateError leaves adopted material available to the caller, but neither
 * detailRuntime nor detailEnrichment can be committed in that result.
 */
export async function collectDetails({
  envelope,
  runtime,
  limit,
  timeLabel = null,
  adapter,
  now = () => new Date().toISOString(),
  navigationDelayMs = DETAIL_NAVIGATION_DELAY_MS,
  wait,
  maxReads,
  pollMs,
  stableReads,
}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_DETAIL_ENRICH_JOBS)
    throw new TypeError(`limit must be an integer from 0 to ${MAX_DETAIL_ENRICH_JOBS}`);
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const checked = validateEnvelope(envelope);
  const current = normalizeRuntimeState(runtime);
  const startedAt = now();
  let input = fairDetailInputs(checked, {
    cursor: current.cursors.detail,
    limit: Math.max(1, limit),
    timeLabel,
    runtime: current,
    now: startedAt,
  });
  if (limit === 0)
    input = { ...input, cursor: current.cursors.detail, selectedIds: [], candidates: [] };
  const skippedReason =
    limit === 0
      ? 'DETAIL_BUDGET_ZERO'
      : input.blocked
        ? 'DETAIL_ENRICHMENT_BLOCKED'
        : input.selectedIds.length === 0
          ? 'DETAIL_TARGETS_EMPTY'
          : null;
  if (skippedReason) {
    return {
      input,
      collected: emptyCollected(),
      applied:
        skippedReason === 'DETAIL_TARGETS_EMPTY'
          ? applyDetailEvidenceV2(checked, emptyCollected(), startedAt)
          : emptyApplied(checked),
      detailRuntime: current.detail,
      detailCursor: current.cursors.detail,
      detailEnrichment:
        skippedReason === 'DETAIL_ENRICHMENT_BLOCKED'
          ? detailRuntimeSummary(current, {
              pending: input.pendingJobs,
              eligibleJobIds: input.eligibleJobIds,
              now: startedAt,
            })
          : currentDetailSummary(checked, current, startedAt),
      updatedAt: startedAt,
      skippedReason,
      stateError: null,
    };
  }
  const collected = await collectDetailTitleEvidence({
    ...input,
    limit,
    adapter,
    now,
    navigationDelayMs,
    wait,
    maxReads,
    pollMs,
    stableReads,
  });
  let applied;
  try {
    applied = applyDetailEvidenceV2(checked, collected, now());
  } catch (error) {
    // Moving adoption behind the phase must retain the caller's issued use.
    error.usage = { detailNavigations: collected.counts.attemptedJobs };
    throw error;
  }
  const updatedAt = now();
  let detailUpdate = null;
  let stateError = null;
  try {
    detailUpdate = updateDetailRuntime(current, collected, updatedAt, applied.envelope);
  } catch (error) {
    // The caller owns whether material is saved before its progress calculation.
    // Preserve the adopted envelope even when no runtime candidate is valid.
    stateError = error;
    stateError.usage = { detailNavigations: collected.counts.attemptedJobs };
  }
  return {
    input,
    collected,
    applied,
    detailRuntime: detailUpdate?.detail ?? null,
    detailCursor: completedDetailCursor(input, collected, current.cursors.detail),
    detailEnrichment: detailUpdate?.summary ?? null,
    updatedAt,
    skippedReason: null,
    stateError,
  };
}
