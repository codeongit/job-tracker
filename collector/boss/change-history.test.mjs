import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyHistoryState,
  observeHistoryList,
  pendingHistory,
  advanceHistoryTask,
  failHistoryTask,
  recordHistoryWatermark,
  historySummary,
} from './change-history.mjs';

const at = '2026-09-23T16:30:00.000Z'; // Shanghai: 2026-09-24 00:30
const row = (key, label = '昨天', message = 'm1', preview = 'hello', jobId = 'job-a') => ({
  key: key.repeat(64),
  latestMessageId: message,
  preview,
  timeLabel: label,
  jobAssociation: { jobId },
});

test('one failed conversation backs off without starving another and eventually isolates', () => {
  const rows = [row('a'), row('b')];
  let state = observeHistoryList(emptyHistoryState(), rows, at);
  const first = state.conversations[0];
  state = failHistoryTask(state, first.key, first.fingerprint, 'FRIEND_INFO_UNAVAILABLE', at);
  assert.deepEqual(
    pendingHistory(state, at).map((item) => item.key),
    [rows[1].key],
  );
  assert.equal(historySummary(state).waitingRetry, 1);
  for (const date of [
    '2026-09-23T17:00:00.000Z',
    '2026-09-23T19:00:00.000Z',
    '2026-09-24T19:00:00.000Z',
  ])
    state = failHistoryTask(state, first.key, first.fingerprint, 'FRIEND_INFO_UNAVAILABLE', date);
  assert.equal(historySummary(state).isolated, 1);
  assert.deepEqual(
    pendingHistory(state, '2026-09-30T00:00:00.000Z').map((item) => item.key),
    [rows[1].key],
  );
});

test('first Shanghai-day initialization selects only today and yesterday once', () => {
  const rows = [row('a', '00:30'), row('b', '昨天'), row('c', '09-20')];
  let state = observeHistoryList(emptyHistoryState(), rows, at);
  assert.equal(state.initializedDay, '2026-09-24');
  assert.deepEqual(
    pendingHistory(state).map((item) => item.key),
    ['a'.repeat(64), 'b'.repeat(64)],
  );
  state = observeHistoryList(state, rows, '2026-09-24T16:30:00.000Z');
  assert.equal(pendingHistory(state).length, 2);
  assert.equal(state.initializedDay, '2026-09-24');
});

test('new identity, message, preview and job enqueue; label, order and receipt do not', () => {
  const a = row('a', '昨天');
  let state = observeHistoryList(emptyHistoryState(), [a], at);
  const fingerprint = state.conversations[0].fingerprint;
  state = advanceHistoryTask(state, a.key, fingerprint, { complete: true, head: 'm1' });
  assert.equal(pendingHistory(state).length, 0);
  state = observeHistoryList(state, [{ ...a, timeLabel: '09-23', unread: 1 }], at);
  assert.equal(pendingHistory(state).length, 0);
  state = observeHistoryList(state, [{ ...a, preview: 'changed' }], at);
  assert.equal(pendingHistory(state).length, 1);
  const originalEnqueued = pendingHistory(state)[0].task.enqueuedAt;
  state = observeHistoryList(state, [{ ...a, latestMessageId: 'm2' }], '2026-09-24T00:00:00.000Z');
  assert.equal(pendingHistory(state).length, 1);
  assert.equal(pendingHistory(state)[0].task.enqueuedAt, originalEnqueued);
  state = observeHistoryList(state, [row('b', '09-20'), { ...a, latestMessageId: 'm2' }], at);
  assert.equal(pendingHistory(state).length, 2);
});

test('an in-flight old target never completes a newer fingerprint', () => {
  const a = row('a');
  let state = observeHistoryList(emptyHistoryState(), [a], at);
  const old = state.conversations[0].fingerprint;
  state = observeHistoryList(state, [{ ...a, latestMessageId: 'm2' }], at);
  state = advanceHistoryTask(state, a.key, old, { complete: true, head: 'm1' });
  assert.equal(pendingHistory(state).length, 1);
  state = recordHistoryWatermark(state, a.key, 'm2');
  assert.deepEqual(historySummary(state), {
    initializedDay: '2026-09-24',
    pending: 0,
    paginating: 0,
    completed: 1,
    truncated: 0,
    waitingRetry: 0,
    failed: 0,
    isolated: 0,
  });
});
