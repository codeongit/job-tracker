import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots } from './compare.mjs';
const snapshot = {
  capturedAt: '2026-09-18T09:00:00.000Z',
  scope: 'loaded-chat-list',
  coverage: { loadedRows: 1, truncated: false },
  records: [
    {
      key: 'example',
      identityConfidence: 'name_company',
      contact: '示例',
      company: '示例公司',
      title: 'HR',
      preview: '',
      timeLabel: '',
      unread: null,
      job: {
        name: '工程师',
        detailUrl: 'https://www.zhipin.com/job_detail/example.html',
        source: 'selected_chat_card',
        detailUrlConfirmation: 'pending_user',
      },
    },
  ],
};
test('pending user confirmation survives snapshot/state copying without becoming confirmed', () => {
  const baseline = compareSnapshots(null, snapshot);
  assert.equal(baseline.state.records[0].job.detailUrlConfirmation, 'pending_user');
  const again = compareSnapshots(baseline.state, snapshot);
  assert.equal(again.state.records[0].job.detailUrlConfirmation, 'pending_user');
  assert.equal(again.report.changes.length, 0);
});
test('review status requires an actual URL and a supported explicit state', () => {
  for (const changes of [
    { detailUrl: null },
    { detailUrlConfirmation: 'confirmed_automatically' },
  ]) {
    const value = structuredClone(snapshot);
    Object.assign(value.records[0].job, changes);
    assert.throws(() => compareSnapshots(null, value), /detailUrlConfirmation/);
  }
});
test('confirmed user review survives record copying and persisted-state round trips', () => {
  const value = structuredClone(snapshot);
  value.records[0].job.detailUrlConfirmation = 'confirmed_user';
  const baseline = compareSnapshots(null, value);
  assert.equal(baseline.state.records[0].job.detailUrlConfirmation, 'confirmed_user');
  const persisted = JSON.parse(JSON.stringify(baseline.state));
  const again = compareSnapshots(persisted, value);
  assert.equal(again.state.records[0].job.detailUrlConfirmation, 'confirmed_user');
  assert.deepEqual(again.report.changes, []);
});
test('one confirmed record never confirms another record with a pending link', () => {
  const value = structuredClone(snapshot);
  const confirmed = structuredClone(value.records[0]);
  confirmed.key = 'confirmed-example';
  confirmed.job.detailUrlConfirmation = 'confirmed_user';
  const pending = structuredClone(value.records[0]);
  pending.key = 'pending-example';
  pending.job.detailUrl = 'https://www.zhipin.com/job_detail/another-example.html';
  value.records = [confirmed, pending];
  value.coverage.loadedRows = 2;
  const baseline = compareSnapshots(null, value);
  const reordered = { ...value, records: [pending, confirmed] };
  const again = compareSnapshots(JSON.parse(JSON.stringify(baseline.state)), reordered);
  const records = new Map(again.state.records.map((record) => [record.key, record]));
  assert.equal(records.get('confirmed-example').job.detailUrlConfirmation, 'confirmed_user');
  assert.equal(records.get('pending-example').job.detailUrlConfirmation, 'pending_user');
  assert.equal(records.get('pending-example').job.detailUrl, pending.job.detailUrl);
  assert.deepEqual(again.report.changes, []);
});
test('confirmation alone does not report a job change when the URL and name match', () => {
  const baseline = compareSnapshots(null, snapshot);
  const confirmed = structuredClone(snapshot);
  confirmed.capturedAt = '2026-09-18T09:01:00.000Z';
  confirmed.records[0].job.detailUrlConfirmation = 'confirmed_user';
  const result = compareSnapshots(baseline.state, confirmed);
  assert.equal(result.state.records[0].job.detailUrlConfirmation, 'confirmed_user');
  assert.equal(result.report.counts.jobObserved, 0);
  assert.equal(result.report.counts.jobChanged, 0);
  assert.deepEqual(result.report.changes, []);
  assert.equal(baseline.state.records[0].job.detailUrlConfirmation, 'pending_user');
});
