import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryCommit } from './history/history-commit.mjs';
import { observeHistoryList } from './history/change-history.mjs';
import { createEnvelopeV2, conversationKeyV2 } from './materials/model-v2.mjs';

const key = 'a'.repeat(64);
const record = { key, timeLabel: '10:00', latestMessageId: 'first' };
const initialState = observeHistoryList(
  { initializedDay: null, legacyCheckpointDigest: null, conversations: [] },
  [record],
  '2026-09-24T02:00:00.000Z',
);
const fingerprint = initialState.conversations[0].task.fingerprint;
const initialEnvelope = { snapshot: { records: [record] } };

for (const failingStep of ['evidence', 'progress', 'remove']) {
  test(`completed history checkpoint recovers after ${failingStep} fails`, async () => {
    let durableState = initialState;
    let checkpoint = {
      nextConversationKey: null,
      completedConversationKey: key,
      targetFingerprint: fingerprint,
      observations: [],
      head: 'latest',
    };
    let failOnce = true;
    const events = [];
    const attempt = async () => {
      const history = createHistoryCommit({
        directory: 'synthetic',
        envelope: initialEnvelope,
        state: durableState,
        saveEvidence: async () => {
          events.push('evidence');
          if (failingStep === 'evidence' && failOnce) {
            failOnce = false;
            throw new Error('INJECTED_FAILURE');
          }
        },
        saveProgress: async (nextState) => {
          events.push('progress');
          if (failingStep === 'progress' && failOnce) {
            failOnce = false;
            throw new Error('INJECTED_FAILURE');
          }
          durableState = nextState;
        },
        checkpoints: {
          load: async () => checkpoint,
          save: async () => assert.fail('no platform page should be read'),
          remove: async () => {
            events.push('remove');
            if (failingStep === 'remove' && failOnce) {
              failOnce = false;
              throw new Error('INJECTED_FAILURE');
            }
            checkpoint = null;
          },
        },
      });
      const pending = await history.prepare();
      if (pending.length) await history.completeFromCheckpoint(pending[0]);
    };

    await assert.rejects(attempt(), /INJECTED_FAILURE/);
    assert.ok(checkpoint);
    if (failingStep === 'evidence') assert.deepEqual(events, ['evidence']);
    if (failingStep === 'progress') assert.deepEqual(events, ['evidence', 'progress']);
    if (failingStep === 'remove') assert.deepEqual(events, ['evidence', 'progress', 'remove']);

    events.length = 0;
    await attempt();
    assert.equal(checkpoint, null);
    assert.equal(durableState.conversations[0].watermark, 'latest');
    assert.deepEqual(
      events,
      failingStep === 'remove' ? ['remove'] : ['evidence', 'progress', 'remove'],
    );
  });
}

function unresolvedFixture() {
  const accountNamespace = `boss-geek:${'c'.repeat(64)}`;
  const conversationKey = conversationKeyV2(accountNamespace, '301', '0');
  const { envelope } = createEnvelopeV2({
    scope: 'loaded-chat-list',
    capturedAt: '2026-09-24T02:00:00.000Z',
    accountNamespace,
    records: [
      {
        key: conversationKey,
        platformIdentity: { friendId: '301', friendSource: '0', uniqueId: '301-0' },
        contact: 'Synthetic contact',
        company: 'Synthetic company',
        title: '',
        preview: '',
        timeLabel: '10:00',
        unread: null,
        latestMessageId: 'first',
        outgoingReceipt: { status: 'unknown', label: null, source: null },
        jobAssociation: null,
        observedJobName: null,
      },
    ],
    coverage: {
      loadedRows: 1,
      loadedDataRows: 1,
      renderedRows: 1,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  });
  const state = observeHistoryList(
    { initializedDay: null, legacyCheckpointDigest: null, conversations: [] },
    envelope.snapshot.records,
    envelope.updatedAt,
  );
  const reason = { conversationKey, reason: 'RESUME_ACTION_PLATFORM_CONTRACT_UNVERIFIED' };
  const checkpoint = {
    version: 6,
    capturedAt: '2026-09-24T02:01:00.000Z',
    nextConversationKey: null,
    completedConversationKey: conversationKey,
    targetFingerprint: state.conversations[0].task.fingerprint,
    observations: [],
    unresolved: [reason],
    head: 'unsupported-message',
    coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 1 },
  };
  return { envelope, state, checkpoint, reason };
}

test('unsupported-only checkpoint survives evidence failure before local completion advances progress', async () => {
  const input = unresolvedFixture();
  let checkpoint = input.checkpoint,
    state = input.state,
    envelope = input.envelope;
  let failOnce = true,
    removed = 0;
  const attempt = async () => {
    const commit = createHistoryCommit({
      directory: 'synthetic',
      envelope,
      state,
      saveEvidence: async (next) => {
        assert.deepEqual(next.resume.lastUnresolved, [input.reason]);
        if (failOnce) {
          failOnce = false;
          throw new Error('DIAGNOSTIC_SAVE_FAILED');
        }
        envelope = next;
      },
      saveProgress: async (next) => {
        state = next;
      },
      checkpoints: {
        load: async () => checkpoint,
        save: async () => assert.fail('no platform read'),
        remove: async () => {
          removed++;
          checkpoint = null;
        },
      },
    });
    const [task] = await commit.prepare();
    await commit.completeFromCheckpoint(task);
  };
  await assert.rejects(attempt(), /DIAGNOSTIC_SAVE_FAILED/);
  assert.ok(checkpoint);
  assert.equal(state.conversations[0].watermark, null);
  assert.equal(removed, 0);
  await attempt();
  assert.deepEqual(envelope.resume.lastUnresolved, [input.reason]);
  assert.equal(state.conversations[0].watermark, 'unsupported-message');
  assert.equal(removed, 1);
});

test('changed task preserves unsupported-only old page before discarding its checkpoint', async () => {
  const input = unresolvedFixture();
  let checkpoint = { ...input.checkpoint, targetFingerprint: 'different-synthetic-fingerprint' };
  const order = [];
  const commit = createHistoryCommit({
    directory: 'synthetic',
    envelope: input.envelope,
    state: input.state,
    saveEvidence: async (next) => {
      assert.deepEqual(next.resume.lastUnresolved, [input.reason]);
      order.push('evidence');
    },
    saveProgress: async () => assert.fail('old page cannot complete the changed task'),
    checkpoints: {
      load: async () => checkpoint,
      save: async () => assert.fail('no platform read'),
      remove: async () => {
        order.push('remove');
        checkpoint = null;
      },
    },
  });
  await commit.prepare();
  assert.deepEqual(order, ['evidence', 'remove']);
  assert.equal(checkpoint, null);
  assert.deepEqual(commit.envelope.resume.lastUnresolved, [input.reason]);
});
