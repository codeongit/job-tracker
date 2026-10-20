import { advanceHistoryTask, failHistoryTask, pendingHistory } from './change-history.mjs';
import { applyResumeHistoryV2, toResumeHistoryResult } from './resume-history.mjs';
import {
  loadChangeCheckpoint,
  removeChangeCheckpoint,
  saveChangeCheckpoint,
} from '../persistence/runtime-state.mjs';

const checkpointKey = (checkpoint) =>
  checkpoint?.nextConversationKey ?? checkpoint?.completedConversationKey;

function replayEvidence(envelope, checkpoint) {
  if (!checkpoint || (!checkpoint.observations.length && !checkpoint.unresolved?.length))
    return envelope;
  const result = toResumeHistoryResult(
    {
      ok: true,
      url: 'https://www.zhipin.com/web/geek/chat',
      capturedAt: checkpoint.capturedAt,
      observations: checkpoint.observations,
      unresolved: checkpoint.unresolved,
      coverage: checkpoint.coverage,
    },
    envelope,
  );
  return applyResumeHistoryV2(envelope, result).envelope;
}

// Owns the durable evidence -> progress -> checkpoint removal protocol. A
// checkpoint left by any failed step can be replayed without another read.
export function createHistoryCommit({
  directory,
  envelope,
  state,
  saveEvidence,
  saveProgress,
  checkpoints = {
    load: loadChangeCheckpoint,
    save: saveChangeCheckpoint,
    remove: removeChangeCheckpoint,
  },
}) {
  let currentEnvelope = envelope;
  let currentState = state;
  let prior = null;

  const persist = async (nextEnvelope, nextState, continuation = null) => {
    await saveEvidence(nextEnvelope);
    await saveProgress(nextState);
    if (continuation && prior?.nextConversationKey === continuation.conversationKey) {
      prior = { ...prior, observations: [], unresolved: [], usage: { historyRequests: 0 } };
      await checkpoints.save(directory, prior);
    } else {
      await checkpoints.remove(directory);
      prior = null;
    }
    currentEnvelope = nextEnvelope;
    currentState = nextState;
  };

  return {
    get envelope() {
      return currentEnvelope;
    },
    get state() {
      return currentState;
    },
    get checkpoint() {
      return prior;
    },
    async prepare() {
      prior = await checkpoints.load(directory);
      const loaded = new Set(currentEnvelope.snapshot.records.map((item) => item.key));
      const pending = pendingHistory(currentState).filter(
        (item) => loaded.has(item.key) || item.key === checkpointKey(prior),
      );
      const task = pending.find((item) => item.key === checkpointKey(prior));
      if (prior && task && prior.targetFingerprint !== task.task.fingerprint) {
        // The older page remains evidence even though the list now names a new target.
        if (prior.observations.length || prior.unresolved?.length) {
          const recovered = replayEvidence(currentEnvelope, prior);
          await saveEvidence(recovered);
          currentEnvelope = recovered;
        }
        await checkpoints.remove(directory);
        prior = null;
      }
      if (
        prior?.completedConversationKey &&
        !(
          prior.version === 7 &&
          typeof prior.previousPageHash === 'string' &&
          /^[a-f0-9]{64}$/.test(prior.previousPageHash)
        )
      ) {
        // Legacy completion used page-count heuristics without a verified message
        // cursor. Preserve its material, then establish coverage from page one.
        if (prior.observations.length || prior.unresolved?.length) {
          const recovered = replayEvidence(currentEnvelope, prior);
          await saveEvidence(recovered);
          currentEnvelope = recovered;
        }
        await checkpoints.remove(directory);
        prior = null;
      }
      if (prior && !pending.some((item) => item.key === checkpointKey(prior))) {
        // Progress was committed before a crash during checkpoint removal.
        await checkpoints.remove(directory);
        prior = null;
      }
      return pending;
    },
    forTask(key) {
      if (checkpointKey(prior) !== key) return null;
      currentEnvelope = replayEvidence(currentEnvelope, prior);
      return prior;
    },
    async checkpointPage(value, fingerprint) {
      const checkpoint = { ...value, targetFingerprint: fingerprint };
      await checkpoints.save(directory, checkpoint);
      prior = checkpoint;
    },
    async completeFromCheckpoint(item) {
      const nextEnvelope = replayEvidence(currentEnvelope, prior);
      const nextState = advanceHistoryTask(currentState, item.key, item.task.fingerprint, {
        complete: true,
        head: prior.head,
      });
      await persist(nextEnvelope, nextState);
    },
    async discardMissingRecord() {
      if (!prior) return;
      const recovered = replayEvidence(currentEnvelope, prior);
      await saveEvidence(recovered);
      await checkpoints.remove(directory);
      currentEnvelope = recovered;
      prior = null;
    },
    async commitScan(item, scan) {
      const result = toResumeHistoryResult(scan.payload, currentEnvelope);
      const applied = applyResumeHistoryV2(currentEnvelope, result);
      const head =
        scan.heads.find((entry) => entry.conversationKey === item.key)?.head ??
        prior?.head ??
        item.task.head;
      let nextState = currentState;
      if (scan.completed.some((entry) => entry.conversationKey === item.key))
        nextState = advanceHistoryTask(currentState, item.key, item.task.fingerprint, {
          complete: true,
          head,
        });
      else if (scan.payload.coverage.failedConversations && !scan.error) {
        const reason =
          scan.failures?.find((entry) => entry.conversationKey === item.key)?.reason ??
          scan.payload.unresolved.find((entry) => entry.conversationKey === item.key)?.reason;
        nextState = failHistoryTask(
          currentState,
          item.key,
          item.task.fingerprint,
          /^[A-Z][A-Z0-9_]{2,80}$/.test(reason ?? '') ? reason : 'HISTORY_UNAVAILABLE',
          new Date().toISOString(),
        );
      } else if (scan.continuation)
        nextState = advanceHistoryTask(currentState, item.key, item.task.fingerprint, {
          nextPage: scan.continuation.page,
          head,
        });
      else if (scan.payload.coverage.truncatedConversations && !scan.error)
        nextState = advanceHistoryTask(currentState, item.key, item.task.fingerprint, {
          nextPage: 20,
          head,
          truncated: true,
        });
      await persist(
        applied.envelope,
        nextState,
        scan.payload.coverage.failedConversations ? null : scan.continuation,
      );
      return { counts: applied.report.counts, coverage: result.coverage };
    },
  };
}
