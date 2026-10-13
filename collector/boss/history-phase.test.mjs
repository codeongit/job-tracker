import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectHistory, fairResumeTargets, settleSaved } from './history/history-phase.mjs';
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

test('change uses its ordinary watermark while backfill also stops at known resume observations', async (t) => {
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
      assert.deepEqual(calls, mode === 'change' ? ['friend', 1, 2] : ['friend', 1]);
      assert.equal(result.usage.historyRequests, mode === 'change' ? 3 : 2);
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
        assert.equal(await loadChangeCheckpoint(directory), null);
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
