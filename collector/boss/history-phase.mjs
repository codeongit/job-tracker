import { createHash } from 'node:crypto';
import { evaluateBound, resume as resumeBrowser } from './cdp-browser.mjs';
import { accountExpression } from './extract.mjs';
import { validateEnvelope } from './model-v2.mjs';
import { readLoadedPlatformReference } from './platform-reference.mjs';
import { saveEnvelope } from './snapshot-save.mjs';
import {
  runResumeHistoryRequests,
  toResumeHistoryResult,
  applyResumeHistoryV2,
} from './resume-history.mjs';
import {
  selectFair,
  saveRuntimeState,
  loadResumeCheckpoint,
  saveResumeCheckpoint,
  removeResumeCheckpoint,
} from './runtime-state.mjs';
import { observeHistoryList, recordHistoryWatermark } from './change-history.mjs';
import { createHistoryCommit } from './history-commit.mjs';

const identityOptions = {
  identityExpression: accountExpression,
  extractAccountIdentity: (payload) => payload?.accountId,
};

const emptyCounts = () => ({
  observed: 0,
  added: 0,
  strong: 0,
  review: 0,
  unresolved: 0,
  unresolvedByReason: {},
  deduplicated: 0,
});

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
      { cursor, limit: Math.max(1, limit - 1), key: (record) => record.key },
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

function replayResumeCheckpoint(envelope, checkpoint) {
  if (!checkpoint || (!checkpoint.observations.length && !checkpoint.unresolved.length))
    return envelope;
  return applyResumeHistoryV2(
    envelope,
    toResumeHistoryResult(
      {
        ok: true,
        url: 'https://www.zhipin.com/web/geek/chat',
        capturedAt: checkpoint.capturedAt,
        observations: checkpoint.observations,
        unresolved: checkpoint.unresolved,
        coverage: checkpoint.coverage,
      },
      envelope,
    ),
  ).envelope;
}

async function prepareHistoryList({
  directory,
  envelope,
  runtime,
  listObservedAt,
  saveEvidence,
  saveProgress,
}) {
  const checkpoint = await loadResumeCheckpoint(directory);
  const digest = checkpoint
    ? createHash('sha256').update(JSON.stringify(checkpoint)).digest('hex')
    : null;
  if (
    checkpoint &&
    (checkpoint.observations.length || checkpoint.unresolved.length) &&
    digest !== runtime.history.legacyCheckpointDigest
  ) {
    envelope = replayResumeCheckpoint(envelope, checkpoint);
    await saveEvidence(envelope);
  }
  const state = {
    ...observeHistoryList(runtime.history, envelope.snapshot.records, listObservedAt),
    legacyCheckpointDigest: digest ?? runtime.history.legacyCheckpointDigest,
  };
  await saveProgress(state);
  return { envelope, state, checkpoint };
}

async function collectBackfill({
  directory,
  envelope,
  runtime,
  priorCheckpoint,
  fair,
  pages,
  maxRequests,
  requestDelayMs,
  evaluate,
  connection,
  platformReference,
}) {
  const startConversationKey = priorCheckpoint?.nextConversationKey ?? null;
  const scan = await runResumeHistoryRequests({
    targets: fair.targets,
    pages,
    maxRequests,
    platformContract: maxRequests >= 2 ? (await platformReference()).platformContract : null,
    requestDelayMs,
    initialObservations: priorCheckpoint?.observations ?? [],
    initialUnresolved: priorCheckpoint?.unresolved ?? [],
    startConversationKey,
    startPage: startConversationKey === null ? 1 : Math.max(1, priorCheckpoint.nextPage),
    knownMessageIds: [
      ...envelope.resume.observations.map((item) => ({
        conversationKey: item.conversationKey,
        messageId: item.messageId,
      })),
      ...(runtime.history?.conversations ?? [])
        .filter((item) => item.watermark)
        .map((item) => ({ conversationKey: item.key, messageId: item.watermark })),
    ],
    execute: async (expression, metadata) => {
      const payload = await evaluate(connection, expression, metadata);
      if (!payload || typeof payload !== 'object') throw new Error('HISTORY_RESPONSE_INVALID');
      return payload;
    },
    onCheckpoint: (value) => saveResumeCheckpoint(directory, value),
  });
  const result = toResumeHistoryResult(scan.payload, envelope);
  const applied = applyResumeHistoryV2(envelope, result);
  return {
    envelope: applied.envelope,
    state: runtime.history,
    counts: applied.report.counts,
    coverage: result.coverage,
    partial: scan.partial,
    error: scan.error,
    cursor: scan.cursor ?? runtime.cursors.resume,
    checkpointPending: true,
    continuation: scan.continuation,
    completed: scan.completed,
  };
}

async function collectChanges({
  connection,
  history,
  pending,
  maxRequests,
  requestDelayMs,
  betweenTargetsDelayMs,
  evaluate,
  platformReference,
}) {
  let used = 0,
    coverage = null,
    partial = false,
    error = null;
  const counts = emptyCounts();
  const prior = history.checkpoint;
  const checkpointKey = prior?.nextConversationKey ?? prior?.completedConversationKey;
  const ordered = checkpointKey
    ? [...pending].sort(
        (a, b) => (a.key === checkpointKey ? -1 : 0) - (b.key === checkpointKey ? -1 : 0),
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
      platformContract: (await platformReference()).platformContract,
      requestDelayMs,
      startConversationKey: item.key,
      startPage: checkpoint?.nextPage ?? task.page,
      initialObservations: checkpoint?.observations ?? [],
      initialUnresolved: checkpoint?.unresolved ?? [],
      initialHead: checkpoint?.head ?? task.head,
      knownMessageIds: item.watermark
        ? [{ conversationKey: item.key, messageId: item.watermark }]
        : [],
      // An issued request with an unknown CDP outcome must never be replayed.
      execute: (expression, metadata) => evaluate(connection, expression, metadata),
      onCheckpoint: (value) => history.checkpointPage(value, task.fingerprint),
    });
    used += scan.usage.historyRequests;
    const committed = await history.commitScan(item, scan);
    for (const key of ['observed', 'added', 'strong', 'review', 'unresolved', 'deduplicated'])
      counts[key] += committed.counts[key] ?? 0;
    for (const [reason, amount] of Object.entries(committed.counts.unresolvedByReason ?? {}))
      counts.unresolvedByReason[reason] = (counts.unresolvedByReason[reason] ?? 0) + amount;
    coverage ??= {
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
  return { envelope: history.envelope, state: history.state, counts, coverage, partial, error };
}

// The two policies share identity guards, loaded-code discovery and issued-use
// accounting. Their checkpoints retain their distinct durable commit protocols.
export async function collectHistory({
  mode,
  directory,
  connection,
  envelope,
  runtime,
  limit = 10,
  pages = 2,
  maxRequests = 20,
  timeLabel = null,
  jobId = null,
  listObservedAt,
  saveProgress = (state) => saveRuntimeState(directory, { ...runtime, history: state }),
  saveEvidence = (value) => saveEnvelope(directory, value),
  requestDelayMs = 3000,
  betweenTargetsDelayMs = 3000,
  reportOperation = (operation) => operation(),
  evaluate = evaluateBound,
  readPlatformReference = readLoadedPlatformReference,
}) {
  let issued = 0;
  const evaluateIssued = (...args) => {
    if (args[2]?.kind !== 'platform_reference') issued += 1;
    return evaluate(...args);
  };
  try {
    if (!['change', 'backfill'].includes(mode)) throw new Error('HISTORY_MODE_INVALID');
    let legacyCheckpoint;
    if (listObservedAt !== undefined) {
      const prepared = await prepareHistoryList({
        directory,
        envelope,
        runtime,
        listObservedAt,
        saveEvidence,
        saveProgress,
      });
      envelope = prepared.envelope;
      runtime = { ...runtime, history: prepared.state };
      legacyCheckpoint = prepared.checkpoint;
    }
    const empty = () => ({
      mode,
      envelope,
      state: runtime.history,
      counts: emptyCounts(),
      coverage: null,
      usage: { historyRequests: 0 },
      partial: false,
      error: null,
      cursor: runtime.cursors?.resume ?? null,
    });
    // A zero-budget normal run still commits list preparation, as before.
    if (listObservedAt !== undefined && maxRequests === 0) return empty();

    let history, pending, fair, priorCheckpoint;
    if (mode === 'change') {
      history = createHistoryCommit({
        directory,
        envelope,
        state: runtime.history,
        saveEvidence,
        saveProgress,
      });
      pending = await history.prepare();
      envelope = history.envelope;
      if (!pending.length && !history.checkpoint) return empty();
    } else {
      priorCheckpoint =
        legacyCheckpoint === undefined ? await loadResumeCheckpoint(directory) : legacyCheckpoint;
      envelope = replayResumeCheckpoint(envelope, priorCheckpoint);
      fair = fairResumeTargets(envelope, {
        cursor: runtime.cursors.resume,
        limit,
        timeLabel,
        jobId,
        resumeFrom: priorCheckpoint?.nextConversationKey ?? null,
      });
      if (!fair.targets.length)
        return {
          ...empty(),
          checkpointPending: Boolean(priorCheckpoint),
        };
    }
    const preflight = await reportOperation(() => resumeBrowser(connection, identityOptions));
    if (!preflight.ok)
      return {
        ...empty(),
        counts: null,
        partial: true,
        error: preflight.report.error,
        verification: preflight.report,
      };
    let reference;
    const platformReference = async () => {
      reference ??= await readPlatformReference({ connection, evaluate: evaluateIssued });
      return reference;
    };
    const common = {
      connection,
      maxRequests,
      requestDelayMs,
      evaluate: evaluateIssued,
      platformReference,
    };
    const result =
      mode === 'change'
        ? await collectChanges({ ...common, history, pending, betweenTargetsDelayMs })
        : await collectBackfill({
            ...common,
            directory,
            envelope,
            runtime,
            priorCheckpoint,
            fair,
            pages,
          });
    if (mode === 'backfill' && listObservedAt !== undefined)
      for (const item of result.completed ?? [])
        result.state = recordHistoryWatermark(result.state, item.conversationKey, item.head);
    const finalCheck = await reportOperation(() => resumeBrowser(connection, identityOptions));
    return {
      ...result,
      mode,
      usage: { historyRequests: issued },
      partial: result.partial || !finalCheck.ok,
      error: result.error ?? (finalCheck.ok ? null : finalCheck.report.error),
      verification: finalCheck.report,
    };
  } catch (caught) {
    const value = String(caught?.message ?? 'HISTORY_SCAN_FAILED');
    const error =
      caught instanceof Error
        ? caught
        : new Error(/^[A-Z][A-Z0-9_]{2,80}$/.test(value) ? value : 'HISTORY_SCAN_FAILED');
    error.usage = { historyRequests: issued };
    throw error;
  }
}

// Backfill evidence belongs to the final snapshot; never settle on a failed
// save or on a JSON-only receipt whose Markdown export has not succeeded.
export async function settleSaved(directory, result, savedFiles) {
  if (result.mode !== 'backfill' || !result.checkpointPending) return;
  if (
    typeof savedFiles?.file !== 'string' ||
    !savedFiles.file ||
    typeof savedFiles?.jobsFile !== 'string' ||
    !savedFiles.jobsFile
  )
    throw new Error('HISTORY_SAVE_RECEIPT_REQUIRED');
  if (!result.continuation) {
    await removeResumeCheckpoint(directory);
    return;
  }
  await saveResumeCheckpoint(directory, {
    version: 6,
    capturedAt: new Date().toISOString(),
    nextConversationKey: result.continuation.conversationKey,
    nextPage: result.continuation.page,
    observations: [],
    unresolved: [],
    coverage: result.coverage ?? {},
    usage: { historyRequests: 0 },
    partial: false,
    error: null,
  });
}
