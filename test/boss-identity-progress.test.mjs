import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectChangedResume, collectResume } from '../collector/boss/tracker.mjs';
import { compareLoadedSnapshotsV2, conversationKeyV2 } from '../collector/boss/model-v2.mjs';
import { observeHistoryList, pendingHistory } from '../collector/boss/change-history.mjs';
import {
  loadChangeCheckpoint,
  loadResumeCheckpoint,
  loadRuntimeState,
  normalizeRuntimeState,
  saveResumeCheckpoint,
  saveRuntimeState,
} from '../collector/boss/runtime-state.mjs';
import { latest } from '../collector/boss/storage.mjs';
import { buildIdentitySample } from '../collector/boss/identity-sample.mjs';

const privateTemporaryRoot = await realpath(tmpdir());
const capturedAt = '2026-10-03T02:00:00.000Z';

function fixture() {
  const namespace = `boss-geek:${'b'.repeat(64)}`;
  const records = ['601', '602'].map((friendId) => ({
    key: conversationKeyV2(namespace, friendId, '0'),
    platformIdentity: { friendId, friendSource: '0', uniqueId: `${friendId}-0` },
    contact: `Synthetic ${friendId}`,
    company: 'Synthetic Company',
    title: 'Recruiter',
    preview: 'Synthetic ordinary message',
    timeLabel: '10:00',
    unread: null,
    latestMessageId: `message-${friendId}`,
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: { jobId: null, detailUrl: null },
    observedJobName: null,
  }));
  const snapshot = {
    capturedAt,
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records,
    coverage: {
      loadedRows: 2,
      loadedDataRows: 2,
      renderedRows: 2,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  };
  const envelope = compareLoadedSnapshotsV2(null, snapshot).envelope;
  const initial = normalizeRuntimeState({
    version: 2,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  const runtime = {
    ...initial,
    history: observeHistoryList(initial.history, records, capturedAt),
  };
  const ordered = pendingHistory(runtime.history).map((item) =>
    records.find((record) => record.key === item.key),
  );
  return { envelope, runtime, ordered };
}

function friendPayload(record) {
  const identity = { bossId: `boss-${record.platformIdentity.friendId}`, securityId: 'synthetic' };
  return {
    ok: true,
    identity,
    identitySample: buildIdentitySample({
      stage: 'friend',
      target: record.platformIdentity,
      identity,
      response: {
        ok: true,
        value: { code: 0, zpData: { result: [{ uid: identity.bossId }] } },
      },
    }),
  };
}

test('later sample failure retains the first completed conversation and all three requests', async (t) => {
  const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-sample-progress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const {
    envelope,
    runtime,
    ordered: [first, second],
  } = fixture();
  await saveRuntimeState(directory, runtime);
  const sampleDirectory = join(directory, 'attribution-diagnostics', 'identity-check');
  const preservedSamples = join(directory, 'attribution-diagnostics', 'preserved-samples');
  const calls = [];

  await assert.rejects(
    collectChangedResume({
      directory,
      connection: {},
      envelope,
      runtime,
      maxRequests: 4,
      requestDelayMs: 0,
      betweenTargetsDelayMs: 0,
      reportOperation: async () => ({ ok: true, report: {} }),
      evaluate: async (_connection, _expression, metadata) => {
        calls.push([metadata.conversationKey, metadata.kind]);
        if (metadata.conversationKey === second.key) {
          assert.equal(metadata.kind, 'friend');
          assert.equal(await loadChangeCheckpoint(directory), null);
          const saved = await loadRuntimeState(directory);
          assert.equal(
            saved.history.conversations.find((item) => item.key === first.key).watermark,
            first.latestMessageId,
          );
          await rename(sampleDirectory, preservedSamples);
          await writeFile(sampleDirectory, 'synthetic write blocker', { mode: 0o600 });
          return friendPayload(second);
        }
        assert.equal(metadata.conversationKey, first.key);
        if (metadata.kind === 'friend') return friendPayload(first);
        const identity = friendPayload(first).identity;
        return {
          ok: true,
          observations: [],
          unresolved: [],
          messageIds: [first.latestMessageId],
          exhausted: true,
          page: metadata.page,
          identitySample: buildIdentitySample({
            stage: 'history',
            page: metadata.page,
            target: first.platformIdentity,
            identity,
            response: {
              ok: true,
              value: {
                code: 0,
                zpData: { messages: [{ id: first.latestMessageId, type: 1 }] },
              },
            },
          }),
        };
      },
    }),
    (error) => {
      assert.equal(error.code, 'BOSS_IDENTITY_SAMPLE_SAVE_FAILED');
      assert.equal(error.usage.historyRequests, 3);
      return true;
    },
  );

  assert.deepEqual(calls, [
    [first.key, 'friend'],
    [first.key, 'history_page'],
    [second.key, 'friend'],
  ]);
  const savedRuntime = await loadRuntimeState(directory);
  const savedFirst = savedRuntime.history.conversations.find((item) => item.key === first.key);
  const savedSecond = savedRuntime.history.conversations.find((item) => item.key === second.key);
  assert.equal(savedFirst.watermark, first.latestMessageId);
  assert.equal(savedFirst.task, null);
  assert.deepEqual(
    savedSecond,
    runtime.history.conversations.find((item) => item.key === second.key),
  );
  assert.deepEqual(
    pendingHistory(savedRuntime.history).map((item) => item.key),
    [second.key],
  );
  assert.equal(await loadChangeCheckpoint(directory), null);
  assert.ok(await latest(directory));
  assert.equal((await readdir(preservedSamples)).length, 2);
});

test('backfill sample failure keeps the original checkpoint and counts its one request', async (t) => {
  const directory = await mkdtemp(join(privateTemporaryRoot, 'boss-sample-backfill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const {
    envelope,
    runtime,
    ordered: [first],
  } = fixture();
  const checkpoint = {
    version: 2,
    capturedAt,
    nextConversationKey: first.key,
    nextPage: 3,
    observations: [],
    unresolved: [],
    coverage: {},
    usage: { historyRequests: 2 },
    partial: false,
    error: null,
  };
  await saveResumeCheckpoint(directory, checkpoint);
  const diagnosticDirectory = join(directory, 'attribution-diagnostics');
  await mkdir(diagnosticDirectory, { mode: 0o700 });
  await writeFile(join(diagnosticDirectory, 'identity-check'), 'synthetic write blocker', {
    mode: 0o600,
  });
  let calls = 0;
  await assert.rejects(
    collectResume({
      directory,
      connection: {},
      envelope,
      runtime,
      limit: 1,
      pages: 1,
      maxRequests: 2,
      reportOperation: async () => ({ ok: true, report: {} }),
      evaluate: async () => {
        calls += 1;
        return friendPayload(first);
      },
    }),
    (error) => {
      assert.equal(error.code, 'BOSS_IDENTITY_SAMPLE_SAVE_FAILED');
      assert.equal(error.usage.historyRequests, 1);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(await loadResumeCheckpoint(directory), checkpoint);
  assert.equal(await latest(directory), null);
});
