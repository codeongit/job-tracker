import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectHistory,
  fairResumeTargets,
  saveHistoryCapture,
  settleSaved,
} from './history/history-phase.mjs';
import { compareLoadedSnapshotsV2, conversationKeyV2 } from './materials/model-v2.mjs';
import { applyResumeHistoryV2, toResumeHistoryResult } from './history/resume-history.mjs';
import { observeHistoryList, pendingHistory } from './history/change-history.mjs';
import { accountNamespace } from './platform/extract.mjs';
import {
  normalizeRuntimeState,
  loadRuntimeState,
  saveRuntimeState,
  saveChangeCheckpoint,
  loadChangeCheckpoint,
  saveResumeCheckpoint,
  loadResumeCheckpoint,
} from './persistence/runtime-state.mjs';
import { assessLoadedPlatformReference } from './platform/platform-reference.mjs';
import { saveEnvelope } from './persistence/snapshot-save.mjs';
import { latest } from './persistence/storage.mjs';

const privateTemporaryRoot = await realpath(tmpdir());
const capturedAt = '2026-09-24T02:00:00.000Z';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-history-phase-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(count = 1) {
  const namespace = accountNamespace('1001');
  const records = Array.from({ length: count }, (_, index) => {
    const friendId = String(901 + index);
    return {
      key: conversationKeyV2(namespace, friendId, '0'),
      platformIdentity: { friendId, friendSource: '0', uniqueId: `${friendId}-0` },
      contact: 'Synthetic contact',
      company: 'Synthetic company',
      title: 'Recruiter',
      preview: 'ordinary',
      timeLabel: '10:00',
      unread: null,
      latestMessageId: `list-${friendId}`,
      outgoingReceipt: { status: 'unknown', label: null, source: null },
      jobAssociation: { jobId: null, detailUrl: null },
      observedJobName: null,
    };
  });
  const envelope = compareLoadedSnapshotsV2(null, {
    capturedAt,
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records,
    coverage: {
      loadedRows: count,
      loadedDataRows: count,
      renderedRows: count,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  }).envelope;
  const runtime = normalizeRuntimeState({
    version: 3,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  runtime.history = observeHistoryList(runtime.history, records, capturedAt);
  return { envelope, runtime, records, record: records[0] };
}

const baseOptions = (directory, input) => ({
  directory,
  connection: { accountNamespace: input.envelope.accountNamespace },
  envelope: input.envelope,
  runtime: input.runtime,
  limit: 10,
  pages: 2,
  maxRequests: 4,
  requestDelayMs: 0,
  betweenTargetsDelayMs: 0,
  reportOperation: async () => ({ ok: true, report: {} }),
  readPlatformReference: async () => assessLoadedPlatformReference([]),
  saveEvidence: async () => {},
  saveProgress: async () => {},
});

const friend = () => ({
  ok: true,
  identity: { bossId: 'synthetic-boss', securityId: 'synthetic-security' },
});
const page = (messageIds = ['new-head'], exhausted = true) => ({
  ok: true,
  observations: [],
  unresolved: [],
  messageIds,
  exhausted,
  nextCursor: exhausted ? null : '100',
});
const checkpoint = (record, overrides = {}) => ({
  version: 6,
  capturedAt,
  nextConversationKey: record.key,
  nextPage: 4,
  observations: [],
  unresolved: [],
  coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 2 },
  usage: { historyRequests: 3 },
  partial: false,
  error: null,
  ...overrides,
});

function addKnownObservation(envelope, record) {
  const result = toResumeHistoryResult(
    {
      ok: true,
      url: 'https://www.zhipin.com/web/geek/chat',
      capturedAt,
      observations: [
        {
          conversationKey: record.key,
          friendId: record.platformIdentity.friendId,
          friendSource: record.platformIdentity.friendSource,
          messageId: 'known-card',
          direction: 'outbound',
          messageType: 4,
          kind: 'sent_candidate',
          platformTime: capturedAt,
          externalJobId: null,
          source: 'geek_history_type_4',
          resumeEvidence: null,
        },
      ],
      unresolved: [],
      coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 1 },
    },
    envelope,
  );
  return applyResumeHistoryV2(envelope, result).envelope;
}

test('both policies use ordinary watermarks rather than selected resume observations as coverage boundaries', async (t) => {
  for (const mode of ['change', 'backfill']) {
    await t.test(mode, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      input.envelope = addKnownObservation(input.envelope, input.record);
      input.runtime.history.conversations[0].watermark = 'known-ordinary';
      const calls = [];
      const result = await collectHistory({
        ...baseOptions(directory, input),
        mode,
        evaluate: async (_connection, _expression, metadata) => {
          calls.push(metadata.kind === 'friend' ? 'friend' : metadata.page);
          return metadata.kind === 'friend'
            ? friend()
            : metadata.page === 1
              ? page(['new-head', 'known-card'], false)
              : page(['known-ordinary'], false);
        },
      });
      assert.deepEqual(calls, ['friend', 1, 2]);
      assert.equal(result.usage.historyRequests, 3);
      assert.equal(
        result.state.conversations[0].watermark,
        mode === 'change' ? 'new-head' : 'known-ordinary',
      );
      assert.equal(result.coverage.exhaustedConversations, 1);
      assert.equal(result.partial, false);
      assert.equal(result.mode, mode);
    });
  }
});

test('normal backfill returns completed watermarks while standalone leaves history state intact', async (t) => {
  const input = fixture();
  for (const normalRun of [false, true]) {
    await t.test(normalRun ? 'normal run' : 'standalone', async (t) => {
      const directory = await temporaryDirectory(t);
      const result = await collectHistory({
        ...baseOptions(directory, input),
        mode: 'backfill',
        ...(normalRun ? { listObservedAt: capturedAt } : {}),
        evaluate: async (_connection, _expression, metadata) =>
          metadata.kind === 'friend' ? friend() : page(),
      });
      assert.equal(result.completed[0].head, 'new-head');
      assert.equal(result.state.conversations[0].watermark, normalRun ? 'new-head' : null);
      assert.equal(Boolean(result.state.conversations[0].task), !normalRun);
      assert.ok(await loadResumeCheckpoint(directory));
    });
  }
});

test('both modes continue the durable page and retain unsupported reasons', async (t) => {
  for (const mode of ['change', 'backfill']) {
    await t.test(mode, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      const reason = {
        conversationKey: input.record.key,
        reason: 'RESUME_ACTION_PLATFORM_CONTRACT_UNVERIFIED',
      };
      const value = checkpoint(input.record, {
        version: 7,
        nextCursor: '200',
        unresolved: [reason],
        ...(mode === 'change'
          ? {
              head: 'saved-head',
              targetFingerprint: input.runtime.history.conversations[0].task.fingerprint,
            }
          : {}),
      });
      await (mode === 'change' ? saveChangeCheckpoint : saveResumeCheckpoint)(directory, value);
      const result = await collectHistory({
        ...baseOptions(directory, input),
        mode,
        maxRequests: 2,
        evaluate: async (_connection, _expression, metadata) => {
          if (metadata.kind === 'friend') return friend();
          assert.equal(metadata.page, 4);
          return page(['page-four'], false);
        },
      });
      assert.deepEqual(result.envelope.resume.lastUnresolved, [reason]);
      assert.equal(result.usage.historyRequests, 2);
      if (mode === 'change') {
        assert.equal(result.state.conversations[0].task.page, 5);
        assert.equal(result.state.conversations[0].task.head, 'saved-head');
        const saved = await loadChangeCheckpoint(directory);
        assert.equal(saved.nextCursor, '100');
        assert.deepEqual(saved.observations, []);
      } else {
        assert.deepEqual(result.continuation, { conversationKey: input.record.key, page: 5 });
        assert.equal((await loadResumeCheckpoint(directory)).nextPage, 5);
      }
    });
  }
});

test('zero-budget list preparation saves legacy evidence before progress and never accesses the platform', async (t) => {
  for (const mode of ['change', 'backfill']) {
    await t.test(mode, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      input.runtime.history = normalizeRuntimeState({
        version: 3,
        cursors: { resume: null, detail: null },
        lastRun: null,
        updatedAt: null,
      }).history;
      const reason = { conversationKey: input.record.key, reason: 'HISTORY_MESSAGE_ID_MISSING' };
      const value = checkpoint(input.record, { unresolved: [reason] });
      await saveResumeCheckpoint(directory, value);
      const events = [];
      const run = (runtime, envelope) =>
        collectHistory({
          ...baseOptions(directory, { ...input, runtime, envelope }),
          mode,
          maxRequests: 0,
          listObservedAt: capturedAt,
          saveEvidence: async (next) => {
            events.push('evidence');
            assert.deepEqual(next.resume.lastUnresolved, [reason]);
          },
          saveProgress: async (state) => {
            events.push('progress');
            assert.match(state.legacyCheckpointDigest, /^[a-f0-9]{64}$/);
          },
          reportOperation: async () =>
            assert.fail('zero-budget preparation cannot verify a browser'),
          readPlatformReference: async () =>
            assert.fail('zero-budget preparation cannot inspect loaded code'),
          evaluate: async () => assert.fail('zero-budget preparation cannot issue requests'),
        });
      const result = await run(input.runtime, input.envelope);
      assert.deepEqual(events, ['evidence', 'progress']);
      assert.equal(pendingHistory(result.state).length, 1);
      assert.deepEqual(result.usage, { historyRequests: 0 });
      assert.deepEqual(await loadResumeCheckpoint(directory), value);
      events.length = 0;
      await run({ ...input.runtime, history: result.state }, result.envelope);
      assert.deepEqual(events, ['progress']);
    });
  }
});

test('list preparation failure preserves checkpoint, skips progress and reports zero usage', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  const value = checkpoint(input.record, {
    unresolved: [{ conversationKey: input.record.key, reason: 'HISTORY_UNAVAILABLE' }],
  });
  await saveResumeCheckpoint(directory, value);
  await assert.rejects(
    collectHistory({
      ...baseOptions(directory, input),
      mode: 'change',
      listObservedAt: capturedAt,
      saveEvidence: async () => {
        throw new Error('LOCAL_EVIDENCE_FAILED');
      },
      saveProgress: async () => assert.fail('failed evidence cannot mark a digest complete'),
      reportOperation: async () => assert.fail('failed preparation cannot access browser'),
    }),
    (error) => {
      assert.equal(error.message, 'LOCAL_EVIDENCE_FAILED');
      assert.deepEqual(error.usage, { historyRequests: 0 });
      return true;
    },
  );
  assert.deepEqual(await loadResumeCheckpoint(directory), value);
});

test('completed change checkpoint recovers with zero requests and does not bypass the budget for other tasks', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture(3);
  const item = pendingHistory(input.runtime.history)[0];
  await saveChangeCheckpoint(
    directory,
    checkpoint(
      { key: item.key },
      {
        version: 7,
        previousPageHash: 'a'.repeat(64),
        nextConversationKey: null,
        nextPage: 0,
        completedConversationKey: item.key,
        targetFingerprint: item.task.fingerprint,
        head: 'recovered-head',
      },
    ),
  );
  const events = [];
  const result = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'change',
    maxRequests: 0,
    saveEvidence: async () => {
      events.push('evidence');
      assert.ok(await loadChangeCheckpoint(directory));
    },
    saveProgress: async (state) => {
      events.push('progress');
      assert.ok(await loadChangeCheckpoint(directory));
      assert.equal(
        state.conversations.find((entry) => entry.key === item.key).watermark,
        'recovered-head',
      );
    },
    readPlatformReference: async () =>
      assert.fail('completed evidence cannot inspect platform code'),
    evaluate: async () => assert.fail('completed evidence cannot issue another request'),
  });
  assert.deepEqual(events, ['evidence', 'progress']);
  assert.deepEqual(result.usage, { historyRequests: 0 });
  assert.equal(pendingHistory(result.state).length, 2);
  assert.equal(await loadChangeCheckpoint(directory), null);
});

test('issued usage survives evidence failure and pure checkpoint recovery reports zero', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  let calls = 0;
  const failing = {
    ...baseOptions(directory, input),
    mode: 'change',
    saveEvidence: async () => {
      throw new Error('LOCAL_EVIDENCE_FAILED');
    },
    evaluate: async (_connection, _expression, metadata) => {
      calls += 1;
      return metadata.kind === 'friend' ? friend() : page();
    },
  };
  await assert.rejects(collectHistory(failing), (error) => {
    assert.deepEqual(error.usage, { historyRequests: 2 });
    return true;
  });
  assert.equal((await loadChangeCheckpoint(directory)).completedConversationKey, input.record.key);
  await assert.rejects(
    collectHistory({ ...failing, evaluate: async () => assert.fail('recovery cannot reread') }),
    (error) => {
      assert.deepEqual(error.usage, { historyRequests: 0 });
      return true;
    },
  );
  assert.equal(calls, 2);
});

test('both modes preserve actual usage when checkpoint persistence fails after friend lookup', async (t) => {
  for (const mode of ['change', 'backfill']) {
    await t.test(mode, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      const checkpointName =
        mode === 'change' ? '.change-checkpoint-v1.json' : '.resume-checkpoint-v1.json';
      let calls = 0;
      await assert.rejects(
        collectHistory({
          ...baseOptions(directory, input),
          mode,
          evaluate: async (_connection, _expression, metadata) => {
            assert.equal(metadata.kind, 'friend');
            calls += 1;
            await mkdir(join(directory, checkpointName));
            return friend();
          },
        }),
        (error) => {
          assert.deepEqual(error.usage, { historyRequests: 1 });
          return true;
        },
      );
      assert.equal(calls, 1);
    });
  }
});

test('both modes share identity guards and exclude loaded references from request usage', async (t) => {
  for (const mode of ['change', 'backfill']) {
    await t.test(mode, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      const events = [];
      const result = await collectHistory({
        ...baseOptions(directory, input),
        mode,
        readPlatformReference: undefined,
        reportOperation: async () => {
          events.push('identity');
          return { ok: true, report: {} };
        },
        evaluate: async (_connection, _expression, metadata) => {
          events.push(metadata.kind);
          return metadata.kind === 'platform_reference'
            ? {
                ok: true,
                beforeAccountId: '1001',
                afterAccountId: '1001',
                reference: { ok: true, loadedScriptUrls: [] },
              }
            : metadata.kind === 'friend'
              ? friend()
              : page();
        },
      });
      assert.deepEqual(events, [
        'identity',
        'platform_reference',
        'friend',
        'history_page',
        'identity',
      ]);
      assert.deepEqual(result.usage, { historyRequests: 2 });
    });
  }
});

test('identity failure before loaded-reference discovery stops requests for both modes', async (t) => {
  for (const mode of ['change', 'backfill']) {
    await t.test(mode, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      const result = await collectHistory({
        ...baseOptions(directory, input),
        mode,
        reportOperation: async () => ({
          ok: false,
          report: { error: 'ACCOUNT_NAMESPACE_CHANGED' },
        }),
        readPlatformReference: async () => assert.fail('failed preflight cannot inspect platform'),
        evaluate: async () => assert.fail('failed preflight cannot request history'),
      });
      assert.equal(result.error, 'ACCOUNT_NAMESPACE_CHANGED');
      assert.equal(result.partial, true);
      assert.deepEqual(result.usage, { historyRequests: 0 });
    });
  }
});

test('loaded-reference identity failure reports zero usage and stops before history', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  await assert.rejects(
    collectHistory({
      ...baseOptions(directory, input),
      mode: 'change',
      readPlatformReference: undefined,
      evaluate: async (_connection, _expression, metadata) => {
        assert.equal(metadata.kind, 'platform_reference');
        return {
          ok: true,
          beforeAccountId: '1001',
          afterAccountId: '1002',
          reference: { ok: true, loadedScriptUrls: [] },
        };
      },
    }),
    (error) => {
      assert.equal(error.message, 'ACCOUNT_NAMESPACE_CHANGED');
      assert.deepEqual(error.usage, { historyRequests: 0 });
      return true;
    },
  );
});

test('both modes skip loaded references and requests when lookup plus one page cannot fit', async (t) => {
  for (const mode of ['change', 'backfill']) {
    await t.test(mode, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      const result = await collectHistory({
        ...baseOptions(directory, input),
        mode,
        maxRequests: 1,
        readPlatformReference: async () => assert.fail('insufficient quota cannot inspect code'),
        evaluate: async () => assert.fail('insufficient quota cannot issue a lookup'),
      });
      assert.deepEqual(result.usage, { historyRequests: 0 });
      assert.equal(result.partial, false);
    });
  }
});

test('both modes with no eligible work skip all browser identity and platform reads', async (t) => {
  for (const mode of ['change', 'backfill']) {
    await t.test(mode, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture(0);
      const result = await collectHistory({
        ...baseOptions(directory, input),
        mode,
        reportOperation: async () => assert.fail('no work cannot need a browser identity check'),
        readPlatformReference: async () => assert.fail('no work cannot inspect platform code'),
        evaluate: async () => assert.fail('no work cannot request history'),
      });
      assert.equal(result.counts.observed, 0);
      assert.deepEqual(result.usage, { historyRequests: 0 });
      assert.equal(result.partial, false);
    });
  }
});

test('both modes report final identity failure together with actual history usage', async (t) => {
  for (const mode of ['change', 'backfill']) {
    await t.test(mode, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      let identityChecks = 0;
      const result = await collectHistory({
        ...baseOptions(directory, input),
        mode,
        reportOperation: async () =>
          ++identityChecks === 1
            ? { ok: true, report: {} }
            : { ok: false, report: { error: 'ACCOUNT_NAMESPACE_CHANGED' } },
        evaluate: async (_connection, _expression, metadata) =>
          metadata.kind === 'friend' ? friend() : page(),
      });
      assert.equal(identityChecks, 2);
      assert.equal(result.error, 'ACCOUNT_NAMESPACE_CHANGED');
      assert.equal(result.partial, true);
      assert.deepEqual(result.usage, { historyRequests: 2 });
      if (mode === 'change') {
        assert.equal(result.state.conversations[0].watermark, 'new-head');
        assert.equal(await loadChangeCheckpoint(directory), null);
      } else assert.ok(await loadResumeCheckpoint(directory));
    });
  }
});

test('injected progress persistence merges into current runtime without losing CDP retry state', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  let current = input.runtime;
  const result = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'change',
    listObservedAt: capturedAt,
    reportOperation: async () => {
      current = {
        ...current,
        cdpRetry: {
          attempts: 1,
          nextRetryAt: '2026-09-24T02:00:02.000Z',
          lastError: 'CDP_CONNECTION_CLOSED',
          exhausted: false,
        },
      };
      return { ok: true, report: {} };
    },
    saveProgress: async (history) => {
      current = { ...current, history };
      await saveRuntimeState(directory, current);
    },
    evaluate: async (_connection, _expression, metadata) =>
      metadata.kind === 'friend' ? friend() : page(),
  });
  const saved = await loadRuntimeState(directory);
  assert.equal(saved.cdpRetry.attempts, 1);
  assert.equal(saved.cdpRetry.lastError, 'CDP_CONNECTION_CLOSED');
  assert.deepEqual(saved.history, result.state);
});

test('backfill settles only after both snapshot and Markdown export receipts succeed', async (t) => {
  for (const continuing of [false, true]) {
    await t.test(continuing ? 'continuation' : 'complete', async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      const value = checkpoint(input.record, {
        ...(continuing ? { nextPage: 5 } : {}),
        unresolved: [{ conversationKey: input.record.key, reason: 'HISTORY_UNAVAILABLE' }],
      });
      await saveResumeCheckpoint(directory, value);
      const result = {
        mode: 'backfill',
        checkpointPending: true,
        continuation: continuing ? { conversationKey: input.record.key, page: 5 } : null,
        coverage: value.coverage,
      };
      for (const receipt of [
        undefined,
        {},
        { file: '/private/tmp/synthetic.json' },
        { jobsFile: '/private/tmp/jobs.md' },
        { file: '', jobsFile: '/private/tmp/jobs.md' },
      ]) {
        await assert.rejects(
          settleSaved(directory, result, receipt),
          /HISTORY_SAVE_RECEIPT_REQUIRED/,
        );
        assert.deepEqual(await loadResumeCheckpoint(directory), value);
      }
      const files = await saveEnvelope(directory, input.envelope);
      await settleSaved(directory, result, files);
      const next = await loadResumeCheckpoint(directory);
      if (continuing) {
        assert.equal(next.nextConversationKey, input.record.key);
        assert.equal(next.nextPage, 5);
        assert.deepEqual(next.observations, []);
        assert.deepEqual(next.unresolved, []);
        assert.deepEqual(next.usage, { historyRequests: 0 });
      } else assert.equal(next, null);
    });
  }
});

test('capture completion saves material and progress before settling its checkpoint', async (t) => {
  for (const continuing of [false, true]) {
    await t.test(continuing ? 'continuing page' : 'completed history', async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      const pending = checkpoint(input.record, {
        version: 7,
        head: '100',
        nextCursor: '61',
        previousPageHash: 'a'.repeat(64),
      });
      await saveResumeCheckpoint(directory, pending);
      const runtime = { ...input.runtime, updatedAt: capturedAt };
      const history = {
        mode: 'backfill',
        checkpointPending: true,
        continuation: continuing ? { conversationKey: input.record.key, page: 4 } : null,
      };
      const order = [];
      const files = await saveHistoryCapture(
        directory,
        { envelope: input.envelope, runtime, history },
        {
          saveEvidence: async (...args) => {
            order.push('material');
            return saveEnvelope(...args);
          },
          saveProgress: async (...args) => {
            order.push('progress');
            assert.ok(await latest(directory));
            assert.deepEqual(await loadResumeCheckpoint(directory), pending);
            await saveRuntimeState(...args);
          },
          settle: async (...args) => {
            order.push('settle');
            assert.deepEqual(await loadRuntimeState(directory), runtime);
            await settleSaved(...args);
          },
        },
      );
      assert.deepEqual(order, ['material', 'progress', 'settle']);
      assert.ok(files.file);
      assert.ok(files.jobsFile);
      const remaining = await loadResumeCheckpoint(directory);
      if (continuing) {
        assert.equal(remaining.nextCursor, '61');
        assert.equal(remaining.head, '100');
        assert.deepEqual(remaining.usage, { historyRequests: 0 });
      } else assert.equal(remaining, null);
    });
  }
});

test('capture completion preserves recovery material at each failed save boundary', async (t) => {
  for (const failedStage of ['material', 'export', 'progress', 'settle']) {
    await t.test(failedStage, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      await saveRuntimeState(directory, input.runtime);
      const pending = checkpoint(input.record);
      await saveResumeCheckpoint(directory, pending);
      const runtime = { ...input.runtime, updatedAt: capturedAt };
      const history = { mode: 'backfill', checkpointPending: true, continuation: null };
      let progressCalls = 0;
      let settleCalls = 0;
      await assert.rejects(
        saveHistoryCapture(
          directory,
          { envelope: input.envelope, runtime, history },
          {
            saveEvidence: (...args) => {
              if (failedStage === 'material') throw new Error('SYNTHETIC_SAVE_FAILED');
              return saveEnvelope(...args, {
                exportJobs: async () => {
                  if (failedStage === 'export') throw new Error('private exception text');
                  return '/synthetic/jobs.md';
                },
              });
            },
            saveProgress: async (...args) => {
              progressCalls += 1;
              if (failedStage === 'progress') throw new Error('SYNTHETIC_PROGRESS_FAILED');
              await saveRuntimeState(...args);
            },
            settle: async (...args) => {
              settleCalls += 1;
              if (failedStage === 'settle') throw new Error('SYNTHETIC_SETTLE_FAILED');
              await settleSaved(...args);
            },
          },
        ),
        failedStage === 'export' ? /JOB_EXPORT_FAILED/ : /SYNTHETIC_\w+_FAILED/,
      );
      assert.equal(progressCalls, ['material', 'export'].includes(failedStage) ? 0 : 1);
      assert.equal(settleCalls, failedStage === 'settle' ? 1 : 0);
      assert.deepEqual(await loadResumeCheckpoint(directory), pending);
      assert.deepEqual(
        await loadRuntimeState(directory),
        failedStage === 'settle' ? runtime : input.runtime,
      );
      assert.equal(Boolean(await latest(directory)), failedStage !== 'material');
      await saveHistoryCapture(directory, { envelope: input.envelope, runtime, history });
      assert.equal(await loadResumeCheckpoint(directory), null);
      assert.deepEqual(await loadRuntimeState(directory), runtime);
    });
  }
});

test('fair backfill selection preserves its continuing conversation before the rotation', () => {
  const input = fixture(3);
  const first = input.records[0].key;
  const selected = fairResumeTargets(input.envelope, {
    cursor: first,
    limit: 2,
    resumeFrom: first,
  });
  assert.equal(selected.targets[0].conversationKey, first);
  assert.equal(selected.targets.length, 2);
  assert.notEqual(selected.targets[1].conversationKey, first);
});

test('saved fair backfill continuation completes the change task at the first-page ordinary message', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  const firstCalls = [];
  const first = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'backfill',
    listObservedAt: capturedAt,
    maxRequests: 2,
    evaluate: async (_connection, _expression, metadata) => {
      firstCalls.push(metadata.kind === 'friend' ? 'friend' : metadata.page);
      return metadata.kind === 'friend' ? friend() : page(['newest-page-one'], false);
    },
  });
  assert.deepEqual(firstCalls, ['friend', 1]);
  assert.equal(first.state.conversations[0].watermark, null);
  assert.equal(pendingHistory(first.state).length, 1);
  await saveHistoryCapture(directory, {
    envelope: first.envelope,
    history: first,
    runtime: {
      ...input.runtime,
      history: first.state,
      cursors: { ...input.runtime.cursors, resume: first.cursor },
    },
  });

  const saved = await latest(directory);
  const runtime = await loadRuntimeState(directory);
  const secondCalls = [];
  const second = await collectHistory({
    ...baseOptions(directory, { ...input, envelope: saved.envelope, runtime }),
    mode: 'backfill',
    listObservedAt: '2026-09-24T02:05:00.000Z',
    maxRequests: 2,
    evaluate: async (_connection, _expression, metadata) => {
      secondCalls.push(metadata.kind === 'friend' ? 'friend' : metadata.page);
      return metadata.kind === 'friend' ? friend() : page(['oldest-page-two'], true);
    },
  });
  assert.deepEqual(secondCalls, ['friend', 2]);
  assert.equal(second.envelope.resume.observations.length, 0);
  assert.equal(second.state.conversations[0].watermark, 'newest-page-one');
  assert.equal(pendingHistory(second.state).length, 0);
  await saveHistoryCapture(directory, {
    envelope: second.envelope,
    history: second,
    runtime: { ...runtime, history: second.state },
  });
  assert.equal((await loadRuntimeState(directory)).history.conversations[0].task, null);
  assert.equal(await loadResumeCheckpoint(directory), null);
});

test('old backfill continuation cannot settle a changed list task using its old head', async (t) => {
  for (const hadTask of [true, false]) {
    await t.test(hadTask ? 'pending change task' : 'baseline without a task', async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      if (!hadTask) input.runtime.history.conversations[0].task = null;
      const first = await collectHistory({
        ...baseOptions(directory, input),
        mode: 'backfill',
        listObservedAt: capturedAt,
        maxRequests: 2,
        evaluate: async (_connection, _expression, metadata) =>
          metadata.kind === 'friend' ? friend() : page(['old-task-head'], false),
      });
      await settleSaved(directory, first, await saveEnvelope(directory, first.envelope));
      await saveRuntimeState(directory, { ...input.runtime, history: first.state });

      const saved = await latest(directory);
      const changedAt = '2026-09-24T02:05:00.000Z';
      const changed = compareLoadedSnapshotsV2(saved.envelope, {
        ...saved.envelope.snapshot,
        capturedAt: changedAt,
        records: [
          { ...input.record, latestMessageId: 'changed-list-head', preview: 'new preview' },
        ],
      }).envelope;
      const second = await collectHistory({
        ...baseOptions(directory, {
          ...input,
          envelope: changed,
          runtime: await loadRuntimeState(directory),
        }),
        mode: 'backfill',
        listObservedAt: changedAt,
        maxRequests: 2,
        evaluate: async (_connection, _expression, metadata) => {
          if (metadata.kind === 'friend') return friend();
          assert.equal(metadata.page, 2);
          return page(['old-page-two'], true);
        },
      });
      assert.equal(second.state.conversations[0].watermark, null);
      assert.equal(pendingHistory(second.state).length, 1);
      assert.equal(second.state.conversations[0].task.page, 1);
      assert.notEqual(
        second.state.conversations[0].task.fingerprint,
        first.state.conversations[0].fingerprint,
      );
      const files = await saveEnvelope(directory, second.envelope);
      await settleSaved(directory, second, files);
      await saveRuntimeState(directory, { ...input.runtime, history: second.state });
      assert.equal(pendingHistory((await loadRuntimeState(directory)).history).length, 1);
    });
  }
});

test('backfill continuation retains its head across an issued page failure and a saved retry', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  await saveResumeCheckpoint(
    directory,
    checkpoint(input.record, {
      version: 7,
      nextPage: 2,
      nextCursor: '200',
      head: 'first-page-head',
      targetFingerprint: input.runtime.history.conversations[0].task.fingerprint,
    }),
  );
  const failedCalls = [];
  const failed = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'backfill',
    listObservedAt: capturedAt,
    maxRequests: 2,
    evaluate: async (_connection, _expression, metadata) => {
      failedCalls.push(metadata.kind === 'friend' ? 'friend' : metadata.page);
      if (metadata.kind === 'friend') return friend();
      throw new Error('HISTORY_REQUEST_UNCERTAIN');
    },
  });
  assert.deepEqual(failedCalls, ['friend', 2]);
  assert.deepEqual(failed.usage, { historyRequests: 2 });
  assert.equal(failed.partial, true);
  await settleSaved(directory, failed, await saveEnvelope(directory, failed.envelope));
  await saveRuntimeState(directory, { ...input.runtime, history: failed.state });
  const saved = await latest(directory);
  const retried = await collectHistory({
    ...baseOptions(directory, {
      ...input,
      envelope: saved.envelope,
      runtime: await loadRuntimeState(directory),
    }),
    mode: 'backfill',
    listObservedAt: '2026-09-24T02:05:00.000Z',
    maxRequests: 2,
    evaluate: async (_connection, _expression, metadata) => {
      if (metadata.kind === 'friend') return friend();
      assert.equal(metadata.page, 2);
      return page(['last-page-message'], true);
    },
  });
  assert.equal(retried.state.conversations[0].watermark, 'first-page-head');
  assert.equal(pendingHistory(retried.state).length, 0);
});

test('backfill checkpoint identity is independent for each fair target', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture(2);
  const requested = [];
  const result = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'backfill',
    listObservedAt: capturedAt,
    pages: 1,
    maxRequests: 4,
    evaluate: async (_connection, _expression, metadata) => {
      requested.push(metadata.conversationKey);
      if (metadata.kind === 'friend') return friend();
      const saved = await loadResumeCheckpoint(directory);
      assert.equal(saved.head, null);
      assert.equal(
        saved.targetFingerprint,
        input.runtime.history.conversations.find((item) => item.key === metadata.conversationKey)
          .task.fingerprint,
      );
      return page([`ordinary-${metadata.conversationKey.slice(0, 8)}`], true);
    },
  });
  assert.equal(requested.length, 4);
  assert.notEqual(requested[0], requested[2]);
  assert.equal(pendingHistory(result.state).length, 0);
  for (const item of result.state.conversations)
    assert.equal(item.watermark, `ordinary-${item.key.slice(0, 8)}`);
});

test('legacy or unbound backfill continuations preserve the current change task', async (t) => {
  for (const version of [6, 7]) {
    await t.test(`checkpoint v${version}`, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      await saveResumeCheckpoint(
        directory,
        checkpoint(input.record, {
          version,
          nextPage: 2,
          head: 'unbound-old-head',
          ...(version === 6
            ? {
                targetFingerprint: input.runtime.history.conversations[0].task.fingerprint,
              }
            : {}),
        }),
      );
      const result = await collectHistory({
        ...baseOptions(directory, input),
        mode: 'backfill',
        listObservedAt: capturedAt,
        maxRequests: 2,
        evaluate: async (_connection, _expression, metadata) =>
          metadata.kind === 'friend' ? friend() : page(['page-two'], true),
      });
      assert.equal(result.state.conversations[0].watermark, null);
      assert.equal(pendingHistory(result.state).length, 1);
      assert.equal(result.cursor, input.record.key);
      await settleSaved(directory, result, await saveEnvelope(directory, result.envelope));
      assert.equal(await loadResumeCheckpoint(directory), null);
    });
  }
});

test('explicit backfill refreshes an unchanged conversation watermark without creating a change task', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  input.runtime.history.conversations[0].task = null;
  input.runtime.history.conversations[0].watermark = 'prior-watermark';
  const result = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'backfill',
    listObservedAt: capturedAt,
    maxRequests: 2,
    evaluate: async (_connection, _expression, metadata) =>
      metadata.kind === 'friend' ? friend() : page(['new-scan-head'], true),
  });
  assert.equal(result.state.conversations[0].watermark, 'new-scan-head');
  assert.equal(result.state.conversations[0].task, null);
});

test('saved backfill establishes an ordinary-message watermark for an unchanged old-date baseline', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  const oldRecord = { ...input.record, timeLabel: '09-01' };
  input.envelope = compareLoadedSnapshotsV2(input.envelope, {
    ...input.envelope.snapshot,
    records: [oldRecord],
  }).envelope;
  input.runtime.history = observeHistoryList(
    { initializedDay: null, legacyCheckpointDigest: null, conversations: [] },
    [oldRecord],
    capturedAt,
  );
  assert.equal(input.runtime.history.conversations[0].task, null);
  assert.equal(input.runtime.history.conversations[0].watermark, null);

  const first = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'backfill',
    listObservedAt: capturedAt,
    maxRequests: 2,
    evaluate: async (_connection, _expression, metadata) =>
      metadata.kind === 'friend' ? friend() : page(['ordinary-old-date-head'], false),
  });
  assert.equal(first.state.conversations[0].task, null);
  assert.equal(first.state.conversations[0].watermark, null);
  await settleSaved(directory, first, await saveEnvelope(directory, first.envelope));
  await saveRuntimeState(directory, { ...input.runtime, history: first.state });
  const saved = await latest(directory);
  const calls = [];
  const second = await collectHistory({
    ...baseOptions(directory, {
      ...input,
      envelope: saved.envelope,
      runtime: await loadRuntimeState(directory),
    }),
    mode: 'backfill',
    listObservedAt: '2026-09-24T02:05:00.000Z',
    maxRequests: 2,
    evaluate: async (_connection, _expression, metadata) => {
      calls.push(metadata.kind === 'friend' ? 'friend' : metadata.page);
      return metadata.kind === 'friend' ? friend() : page(['ordinary-old-date-tail'], true);
    },
  });
  assert.deepEqual(calls, ['friend', 2]);
  assert.equal(second.envelope.resume.observations.length, 0);
  assert.equal(second.state.conversations[0].watermark, 'ordinary-old-date-head');
  assert.equal(second.state.conversations[0].task, null);
  await settleSaved(directory, second, await saveEnvelope(directory, second.envelope));
  await saveRuntimeState(directory, { ...input.runtime, history: second.state });
  const restored = await loadRuntimeState(directory);
  assert.equal(restored.history.conversations[0].watermark, 'ordinary-old-date-head');
  assert.equal(restored.history.conversations[0].task, null);
});

test('backfill at page twenty keeps the change task pending when history is truncated', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  await saveResumeCheckpoint(
    directory,
    checkpoint(input.record, {
      version: 7,
      nextPage: 20,
      nextCursor: '200',
      head: 'first-page-head',
      targetFingerprint: input.runtime.history.conversations[0].task.fingerprint,
    }),
  );
  const calls = [];
  const result = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'backfill',
    listObservedAt: capturedAt,
    maxRequests: 2,
    evaluate: async (_connection, _expression, metadata) => {
      calls.push(metadata.kind === 'friend' ? 'friend' : metadata.page);
      return metadata.kind === 'friend' ? friend() : page(['page-twenty'], false);
    },
  });
  assert.deepEqual(calls, ['friend', 20]);
  assert.equal(result.coverage.truncatedConversations, 1);
  assert.equal(result.state.conversations[0].watermark, null);
  assert.equal(pendingHistory(result.state).length, 1);
  assert.equal(result.cursor, input.record.key);
  assert.equal(result.continuation, null);
});

test('backfill settlement refuses a checkpoint for another continuation', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  const value = checkpoint(input.record, {
    version: 7,
    head: 'first-page-head',
    targetFingerprint: input.runtime.history.conversations[0].task.fingerprint,
  });
  await saveResumeCheckpoint(directory, value);
  const files = await saveEnvelope(directory, input.envelope);
  for (const continuation of [
    { conversationKey: input.record.key, page: 5 },
    { conversationKey: 'f'.repeat(64), page: value.nextPage },
  ]) {
    await assert.rejects(
      settleSaved(
        directory,
        {
          mode: 'backfill',
          checkpointPending: true,
          continuation,
        },
        files,
      ),
      /RESUME_CHECKPOINT_CONTINUATION_MISMATCH/,
    );
    assert.deepEqual(await loadResumeCheckpoint(directory), value);
  }
});

test('a one-request backfill allowance cannot discard its saved page continuation', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  const value = checkpoint(input.record, {
    version: 7,
    head: 'first-page-head',
    targetFingerprint: input.runtime.history.conversations[0].task.fingerprint,
  });
  await saveResumeCheckpoint(directory, value);
  const result = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'backfill',
    listObservedAt: capturedAt,
    maxRequests: 1,
    evaluate: async () => assert.fail('one request cannot fit lookup plus a history page'),
  });
  assert.deepEqual(result.usage, { historyRequests: 0 });
  const files = await saveEnvelope(directory, result.envelope);
  await settleSaved(directory, result, files);
  const saved = await loadResumeCheckpoint(directory);
  assert.equal(saved?.nextConversationKey, value.nextConversationKey);
  assert.equal(saved?.nextPage, 4);
  assert.equal(saved?.head, 'first-page-head');
  assert.equal(saved?.targetFingerprint, value.targetFingerprint);
  assert.deepEqual(result.completed, []);
  assert.deepEqual(result.state.conversations[0].task, input.runtime.history.conversations[0].task);
  assert.equal(pendingHistory(result.state).length, 1);
});

test('saved history resumes the platform message cursor instead of repeating the first page', async (t) => {
  for (const mode of ['change', 'backfill']) {
    await t.test(mode, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      const requests = [];
      const evaluate = async (_connection, expression) => {
        class FakeXHR {
          open(method, url) {
            this.url = url;
          }
          setRequestHeader() {}
          send() {
            this.status = 200;
            let zpData;
            if (this.url.includes('getGeekFriendList')) {
              zpData = {
                result: [{ uid: '901', friendSource: '0', securityId: 'synthetic-security' }],
              };
            } else {
              const query = new URL(this.url).searchParams;
              requests.push({ page: query.get('page'), cursor: query.get('maxMsgId') });
              const tail = query.get('maxMsgId') === '81';
              zpData = {
                messages: Array.from({ length: tail ? 11 : 20 }, (_, index) => ({
                  mid: String((tail ? 80 : 100) - index),
                  type: 1,
                  time: 1790000000,
                  body: { text: 'synthetic ordinary message' },
                })),
                minMsgId: tail ? 70 : 81,
                hasMore: !tail,
              };
            }
            this.responseText = JSON.stringify({ code: 0, zpData });
            queueMicrotask(() => this.onload());
          }
        }
        return vm.runInNewContext(expression, {
          location: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat' },
          XMLHttpRequest: FakeXHR,
          queueMicrotask,
          URL,
          setTimeout,
        });
      };
      let runtime = input.runtime;
      const run = (envelope) =>
        collectHistory({
          ...baseOptions(directory, { ...input, envelope, runtime }),
          mode,
          listObservedAt: capturedAt,
          maxRequests: 2,
          evaluate,
          saveEvidence: (value) => saveEnvelope(directory, value),
          saveProgress: async (history) => {
            runtime = { ...runtime, history };
            await saveRuntimeState(directory, runtime);
          },
        });
      const first = await run(input.envelope);
      assert.equal(
        mode === 'change' ? first.state.conversations[0].task?.page : first.continuation?.page,
        2,
      );
      await settleSaved(directory, first, await saveEnvelope(directory, first.envelope));
      runtime = { ...runtime, history: first.state };
      await saveRuntimeState(directory, runtime);
      runtime = await loadRuntimeState(directory);
      const second = await run((await latest(directory)).envelope);
      assert.deepEqual(requests, [
        { page: '1', cursor: '0' },
        { page: '2', cursor: '81' },
      ]);
      assert.equal(second.state.conversations[0].task, null);
      assert.equal(second.state.conversations[0].watermark, '100');
      assert.equal(second.coverage.exhaustedConversations, 1);
      assert.equal(second.envelope.resume.observations.length, 0);
      assert.deepEqual(second.usage, { historyRequests: 2 });
    });
  }
});

test('legacy continuation rereads page one without treating restored resume observations as a known boundary', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  input.envelope = addKnownObservation(input.envelope, input.record);
  await saveResumeCheckpoint(
    directory,
    checkpoint(input.record, {
      version: 6,
      nextPage: 20,
      head: 'legacy-head',
      targetFingerprint: input.runtime.history.conversations[0].task.fingerprint,
    }),
  );
  const calls = [];
  const result = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'backfill',
    listObservedAt: capturedAt,
    maxRequests: 3,
    evaluate: async (_connection, _expression, metadata) => {
      calls.push(metadata.kind === 'friend' ? 'friend' : metadata.page);
      if (metadata.kind === 'friend') return friend();
      return metadata.page === 1 ? page(['known-card'], false) : page(['actual-tail'], true);
    },
  });
  assert.deepEqual(calls, ['friend', 1, 2]);
  assert.equal(result.coverage.exhaustedConversations, 1);
  assert.equal(result.state.conversations[0].watermark, null);
  assert.ok(result.state.conversations[0].task);
  assert.equal(result.envelope.resume.observations.length, 1);
});

test('legacy completion cannot clear a current task without validating the new pagination contract', async (t) => {
  for (const version of [6, 7]) {
    const directory = await temporaryDirectory(t);
    const input = fixture();
    await saveChangeCheckpoint(
      directory,
      checkpoint(input.record, {
        version,
        nextConversationKey: null,
        nextPage: 0,
        completedConversationKey: input.record.key,
        head: 'unverified-old-head',
        targetFingerprint: input.runtime.history.conversations[0].task.fingerprint,
      }),
    );
    const result = await collectHistory({
      ...baseOptions(directory, input),
      mode: 'change',
      maxRequests: 0,
      evaluate: async () => assert.fail('zero budget must not read platform'),
    });
    assert.equal(result.state.conversations[0].watermark, null);
    assert.ok(result.state.conversations[0].task);
    assert.deepEqual(result.usage, { historyRequests: 0 });
    assert.equal(await loadChangeCheckpoint(directory), null);
  }
});

test('change cursor failures save evidence before retry state, while unrelated targets continue', async (t) => {
  for (const failingStep of [null, 'evidence', 'progress']) {
    await t.test(failingStep ?? 'success', async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture(2);
      const firstKey = pendingHistory(input.runtime.history)[0].key;
      const events = [];
      const options = {
        ...baseOptions(directory, input),
        mode: 'change',
        maxRequests: 4,
        saveEvidence: async () => {
          events.push('evidence');
          if (failingStep === 'evidence') throw new Error('INJECTED_EVIDENCE_FAILURE');
        },
        saveProgress: async () => {
          events.push('progress');
          if (failingStep === 'progress') throw new Error('INJECTED_PROGRESS_FAILURE');
        },
        evaluate: async (_connection, _expression, metadata) => {
          if (metadata.kind === 'friend') return friend();
          return metadata.conversationKey === firstKey
            ? { ...page(['100'], false), nextCursor: null }
            : page(['200'], true);
        },
      };
      if (failingStep) {
        await assert.rejects(collectHistory(options), (error) => {
          assert.equal(error.usage.historyRequests, 2);
          return true;
        });
        const saved = await loadChangeCheckpoint(directory);
        assert.equal(saved.unresolved.at(-1).reason, 'HISTORY_CURSOR_NOT_ADVANCING');
        assert.deepEqual(
          events,
          failingStep === 'evidence' ? ['evidence'] : ['evidence', 'progress'],
        );
      } else {
        const result = await collectHistory(options);
        const failed = result.state.conversations.find((item) => item.key === firstKey);
        assert.equal(failed.task.lastError, 'HISTORY_CURSOR_NOT_ADVANCING');
        assert.equal(failed.task.attempts, 1);
        assert.equal(result.state.conversations.find((item) => item.key !== firstKey).task, null);
        assert.equal(result.partial, true);
        assert.equal(result.usage.historyRequests, 4);
        assert.equal(await loadChangeCheckpoint(directory), null);
        assert.deepEqual(events, ['evidence', 'progress', 'evidence', 'progress']);
      }
    });
  }
});

test('an issued continuation keeps its exact cursor across evidence or progress save failure', async (t) => {
  for (const failingStep of ['evidence', 'progress']) {
    await t.test(failingStep, async (t) => {
      const directory = await temporaryDirectory(t);
      const input = fixture();
      const firstOptions = {
        ...baseOptions(directory, input),
        mode: 'change',
        maxRequests: 2,
        saveEvidence: async () => {
          if (failingStep === 'evidence') throw new Error('INJECTED_SAVE_FAILURE');
        },
        saveProgress: async () => {
          throw new Error('INJECTED_SAVE_FAILURE');
        },
        evaluate: async (_connection, _expression, metadata) =>
          metadata.kind === 'friend' ? friend() : { ...page(['100'], false), nextCursor: '81' },
      };
      await assert.rejects(collectHistory(firstOptions), (error) => {
        assert.equal(error.usage.historyRequests, 2);
        return true;
      });
      const checkpoint = await loadChangeCheckpoint(directory);
      assert.equal(checkpoint.nextCursor, '81');
      assert.equal(checkpoint.nextPage, 2);
      assert.equal(checkpoint.head, '100');
      assert.match(checkpoint.previousPageHash, /^[a-f0-9]{64}$/);
      const calls = [];
      const recovered = await collectHistory({
        ...baseOptions(directory, input),
        mode: 'change',
        maxRequests: 2,
        evaluate: async (_connection, _expression, metadata) => {
          if (metadata.kind === 'friend') return friend();
          calls.push([metadata.page, metadata.maxMsgId]);
          return page(['80'], true);
        },
      });
      assert.deepEqual(calls, [[2, '81']]);
      assert.equal(recovered.state.conversations[0].task, null);
      assert.equal(recovered.state.conversations[0].watermark, '100');
      assert.equal(recovered.usage.historyRequests, 2);
      assert.equal(await loadChangeCheckpoint(directory), null);
    });
  }
});

test('an old truncated task without a checkpoint cannot finish merely by finding its saved first-page observation', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  input.envelope = addKnownObservation(input.envelope, input.record);
  input.runtime.history.conversations[0].task.page = 20;
  input.runtime.history.conversations[0].task.truncated = true;
  assert.equal(await loadResumeCheckpoint(directory), null);
  const calls = [];
  const result = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'backfill',
    listObservedAt: capturedAt,
    maxRequests: 3,
    evaluate: async (_connection, _expression, metadata) => {
      if (metadata.kind === 'friend') return friend();
      calls.push([metadata.page, metadata.maxMsgId]);
      return metadata.page === 1
        ? { ...page(['known-card'], false), nextCursor: '81' }
        : page(['tail'], true);
    },
  });
  assert.deepEqual(calls, [
    [1, '0'],
    [2, '81'],
  ]);
  assert.equal(result.state.conversations[0].task, null);
  assert.equal(result.state.conversations[0].watermark, 'known-card');
  assert.equal(result.envelope.resume.observations.length, 1);
  assert.equal(result.usage.historyRequests, 3);
});

test('a matching message ID in another conversation does not satisfy this conversation watermark', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture(2);
  const [first, second] = input.records;
  input.runtime.history.conversations.find((item) => item.key === first.key).watermark =
    'first-old';
  input.runtime.history.conversations.find((item) => item.key === second.key).watermark =
    'shared-id';
  const calls = [];
  const result = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'backfill',
    listObservedAt: capturedAt,
    maxRequests: 5,
    evaluate: async (_connection, _expression, metadata) => {
      if (metadata.kind === 'friend') return friend();
      calls.push([metadata.conversationKey, metadata.page]);
      if (metadata.conversationKey === second.key) return page(['shared-id'], false);
      return metadata.page === 1 ? page(['shared-id'], false) : page(['first-old'], false);
    },
  });
  assert.deepEqual(
    calls.filter(([key]) => key === first.key).map(([, page]) => page),
    [1, 2],
  );
  assert.deepEqual(
    calls.filter(([key]) => key === second.key).map(([, page]) => page),
    [1],
  );
  assert.equal(result.coverage.exhaustedConversations, 2);
  assert.equal(result.usage.historyRequests, 5);
});

test('a healthy change continuation retains the single checkpoint before another task can overwrite it', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture(2);
  const firstKey = pendingHistory(input.runtime.history)[0].key;
  const calls = [];
  let runtime = input.runtime;
  const run = (envelope, maxRequests) =>
    collectHistory({
      ...baseOptions(directory, { ...input, envelope, runtime }),
      mode: 'change',
      maxRequests,
      saveEvidence: (value) => saveEnvelope(directory, value),
      saveProgress: async (history) => {
        runtime = { ...runtime, history };
        await saveRuntimeState(directory, runtime);
      },
      evaluate: async (_connection, _expression, metadata) => {
        calls.push(metadata);
        if (metadata.kind === 'friend') return friend();
        const start = metadata.page === 1 ? 100 : metadata.page === 2 ? 80 : 60;
        return {
          ...page(
            Array.from({ length: metadata.page < 3 ? 20 : 11 }, (_, i) => String(start - i)),
            metadata.page === 3,
          ),
          nextCursor: metadata.page === 1 ? '81' : metadata.page === 2 ? '61' : '50',
        };
      },
    });
  const first = await run(input.envelope, 20);
  assert.equal(first.usage.historyRequests, 3);
  assert.ok(calls.every((call) => call.conversationKey === firstKey));
  const continuation = await loadChangeCheckpoint(directory);
  assert.equal(continuation.nextConversationKey, firstKey);
  assert.equal(continuation.nextPage, 3);
  assert.equal(continuation.nextCursor, '61');
  runtime = await loadRuntimeState(directory);
  calls.length = 0;
  const second = await run((await latest(directory)).envelope, 2);
  assert.deepEqual(
    calls.filter((call) => call.kind === 'history_page').map((call) => [call.page, call.maxMsgId]),
    [[3, '61']],
  );
  assert.equal(second.state.conversations.find((row) => row.key === firstKey).task, null);
  assert.equal(second.state.conversations.find((row) => row.key === firstKey).watermark, '100');
  assert.equal(pendingHistory(second.state).length, 1);
});

test('a current pagination failure takes precedence over an older semantic diagnostic', async (t) => {
  const directory = await temporaryDirectory(t);
  const input = fixture();
  await saveChangeCheckpoint(
    directory,
    checkpoint(input.record, {
      version: 7,
      nextPage: 2,
      nextCursor: '100',
      previousPageHash: 'a'.repeat(64),
      targetFingerprint: input.runtime.history.conversations[0].task.fingerprint,
      unresolved: [
        { conversationKey: input.record.key, reason: 'RESUME_ACTION_PLATFORM_CONTRACT_UNVERIFIED' },
      ],
    }),
  );
  const result = await collectHistory({
    ...baseOptions(directory, input),
    mode: 'change',
    maxRequests: 2,
    evaluate: async (_connection, _expression, metadata) =>
      metadata.kind === 'friend' ? friend() : { ...page(['90'], false), nextCursor: '100' },
  });
  assert.equal(result.state.conversations[0].task.lastError, 'HISTORY_CURSOR_NOT_ADVANCING');
  assert.equal(result.envelope.resume.lastUnresolved.length, 2);
});
