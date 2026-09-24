import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryCommit } from './history-commit.mjs';
import { observeHistoryList } from './change-history.mjs';

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
