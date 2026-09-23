import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshots } from './compare.mjs';

const at = (minute) => `2026-09-18T10:${String(minute).padStart(2, '0')}:00.000Z`;
const row = (key, overrides = {}) => ({
  key,
  identityConfidence: 'dom',
  contact: `Contact ${key}`,
  company: 'Example Co',
  title: 'Synthetic role',
  preview: 'Synthetic preview',
  timeLabel: '10:00',
  unread: 1,
  ...overrides,
});
const snapshot = (records, minute = 0, truncated = false) => ({
  capturedAt: at(minute),
  scope: 'loaded-chat-list',
  records,
  coverage: { loadedRows: records.length, truncated },
});
const baseline = (records) => compareSnapshots(null, snapshot(records)).state;
const receipt = (status) =>
  status === 'unknown'
    ? { status, label: null, source: null }
    : {
        status,
        label: { read: '[已读]', delivered: '[送达]', unread: '[未读]' }[status],
        source: 'list_receipt_label',
      };
const jobUrl = (id) => `https://www.zhipin.com/job_detail/${id}.html`;
const job = (name = null, detailUrl = null, source = null) => ({ name, detailUrl, source });

test('first capture establishes a baseline without notifications, including unread rows', () => {
  const { state, report } = compareSnapshots(null, snapshot([row('a'), row('b', { unread: 8 })]));
  assert.equal(report.mode, 'baseline');
  assert.deepEqual(report.changes, []);
  assert.equal(report.counts.baselineRecords, 2);
  assert.equal(report.counts.firstObserved, 0);
  assert.equal(state.records.length, 2);
  assert.equal(state.records[0].firstObservedAt, at(0));
});

test('list reordering does not create any changes', () => {
  const { report } = compareSnapshots(
    baseline([row('a'), row('b')]),
    snapshot([row('b'), row('a')], 1),
  );
  assert.deepEqual(report.changes, []);
  assert.equal(report.counts.comparedRecords, 2);
});

test('missing rows remain in history and reappearing rows are not first observations', () => {
  const initial = baseline([row('a'), row('b')]);
  const absent = compareSnapshots(initial, snapshot([row('b')], 1, true));
  assert.equal(absent.state.records.length, 2);
  assert.equal(absent.report.counts.notObservedThisCapture, 1);
  assert.deepEqual(absent.report.changes, []);
  const returned = compareSnapshots(absent.state, snapshot([row('a')], 2));
  assert.deepEqual(returned.report.changes, []);
  assert.equal(returned.state.records[0].firstObservedAt, at(0));
  assert.equal(returned.state.records[0].lastObservedAt, at(2));
});

test('previously unseen identities are only first_observed', () => {
  const { report } = compareSnapshots(baseline([row('a')]), snapshot([row('c')], 1));
  assert.deepEqual(
    report.changes.map((change) => change.type),
    ['first_observed'],
  );
  assert.equal(report.changes[0].before, null);
  assert.equal(report.changes[0].after.key, 'c');
});

test('preview and known unread changes are independent observations, not message claims', () => {
  const { report } = compareSnapshots(
    baseline([row('a')]),
    snapshot([row('a', { preview: 'Different synthetic preview', unread: 0 })], 1),
  );
  assert.deepEqual(
    report.changes.map((change) => change.type),
    ['preview_changed', 'unread_changed'],
  );
  assert.deepEqual(
    report.changes.map(({ before, after }) => [before, after]),
    [
      ['Synthetic preview', 'Different synthetic preview'],
      [1, 0],
    ],
  );
});

test('duplicate keys are all skipped, without arbitrary pairing or history overwrite', () => {
  const initial = baseline([row('a')]);
  const { state, report } = compareSnapshots(
    initial,
    snapshot(
      [
        row('a', { preview: 'first conflicting value' }),
        row('a', { preview: 'second conflicting value' }),
        row('b'),
        row('b', { unread: 12 }),
      ],
      1,
    ),
  );
  assert.deepEqual(report.changes, []);
  assert.deepEqual(report.ambiguities, [
    { key: 'a', count: 2 },
    { key: 'b', count: 2 },
  ]);
  assert.equal(report.counts.skippedAmbiguousRecords, 4);
  assert.deepEqual(state.records, initial.records);
});

test('baseline also skips duplicate keys entirely', () => {
  const { state, report } = compareSnapshots(null, snapshot([row('a'), row('a'), row('b')]));
  assert.deepEqual(
    state.records.map((record) => record.key),
    ['b'],
  );
  assert.deepEqual(report.changes, []);
  assert.equal(report.counts.baselineRecords, 1);
});

test('unknown unread never becomes zero or generates a change', () => {
  const initial = baseline([row('a', { unread: 2 }), row('b', { unread: null })]);
  const unknown = compareSnapshots(
    initial,
    snapshot([row('a', { unread: null }), row('b', { unread: 4 })], 1),
  );
  assert.deepEqual(unknown.report.changes, []);
  assert.equal(unknown.state.records[0].unread, 2);
  assert.equal(unknown.state.records[1].unread, 4);
  const knownAgain = compareSnapshots(unknown.state, snapshot([row('a', { unread: 3 })], 2));
  assert.deepEqual(
    knownAgain.report.changes.map(({ type, before, after }) => ({ type, before, after })),
    [{ type: 'unread_changed', before: 2, after: 3 }],
  );
});

test('time-label formatting changes are counted without producing change events', () => {
  const { report } = compareSnapshots(
    baseline([row('a')]),
    snapshot([row('a', { timeLabel: '昨天' })], 1),
  );
  assert.equal(report.counts.timeLabelChanged, 1);
  assert.deepEqual(report.changes, []);
});

test('empty partial capture cannot delete history or manufacture changes', () => {
  const initial = baseline([row('a')]);
  const { state, report } = compareSnapshots(initial, snapshot([], 1, true));
  assert.deepEqual(state.records, initial.records);
  assert.deepEqual(report.changes, []);
  assert.equal(report.coverage.truncated, true);
  assert.ok(report.warnings.some((warning) => warning.includes('truncated')));
});

test('name/company confidence stays explicit and is accompanied by an ambiguity warning', () => {
  const { report } = compareSnapshots(
    baseline([]),
    snapshot([row('a', { identityConfidence: 'name_company' })], 1),
  );
  assert.equal(report.changes[0].identityConfidence, 'name_company');
  assert.ok(report.warnings.some((warning) => warning.includes('contact/company')));
});

test('comparison does not mutate either input and history safely supports special keys', () => {
  const initial = baseline([row('__proto__')]);
  const next = snapshot([row('__proto__', { preview: 'Changed' })], 1);
  const initialCopy = structuredClone(initial);
  const nextCopy = structuredClone(next);
  const { state } = compareSnapshots(initial, next);
  assert.deepEqual(initial, initialCopy);
  assert.deepEqual(next, nextCopy);
  assert.equal(state.records[0].key, '__proto__');
  state.records[0].preview = 'Mutated returned state';
  assert.deepEqual(initial, initialCopy);
  assert.deepEqual(next, nextCopy);
});

test('malformed snapshots fail closed', () => {
  const invalidSnapshots = [
    null,
    {},
    { ...snapshot([]), capturedAt: 'not a date' },
    { ...snapshot([]), scope: 'all-chat-list' },
    snapshot([row('')]),
    snapshot([row('a', { unread: -1 })]),
    snapshot([row('a', { unread: undefined })]),
    snapshot([row('a', { unread: '3' })]),
    snapshot([row('a', { preview: null })]),
    snapshot([row('a', { identityConfidence: 'guessed' })]),
    { ...snapshot([row('a')]), coverage: { loadedRows: 0, truncated: false } },
    { ...snapshot([]), coverage: { loadedRows: 0, truncated: 'false' } },
  ];
  for (const invalid of invalidSnapshots)
    assert.throws(() => compareSnapshots(null, invalid), TypeError);
});

test('corrupted history and older snapshots fail closed', () => {
  const initial = baseline([row('a')]);
  assert.throws(() => compareSnapshots(undefined, snapshot([])), TypeError);
  assert.throws(() => compareSnapshots({ ...initial, version: 99 }, snapshot([])), TypeError);
  assert.throws(
    () =>
      compareSnapshots(
        { ...initial, records: [...initial.records, ...initial.records] },
        snapshot([]),
      ),
    TypeError,
  );
  assert.throws(
    () =>
      compareSnapshots(
        { ...initial, records: [{ ...initial.records[0], firstObservedAt: at(5) }] },
        snapshot([], 6),
      ),
    TypeError,
  );
  const later = compareSnapshots(initial, snapshot([row('a')], 5)).state;
  assert.throws(() => compareSnapshots(later, snapshot([row('a')], 1)), TypeError);
  assert.deepEqual(initial, baseline([row('a')]));
});

test('receipt-aware baseline includes receipt fields but never creates receipt alerts', () => {
  const { state, report } = compareSnapshots(
    null,
    snapshot([
      row('a', { outgoingReceipt: receipt('read') }),
      row('b', { outgoingReceipt: receipt('delivered') }),
      row('c', { outgoingReceipt: receipt('unknown') }),
      row('d'),
    ]),
  );
  assert.deepEqual(report.changes, []);
  assert.equal(report.counts.receiptObserved, 0);
  assert.equal(report.counts.receiptChanged, 0);
  assert.equal(report.counts.receiptUnavailable, 2);
  assert.deepEqual(
    state.records.map((record) => record.outgoingReceipt.status),
    ['read', 'delivered', 'unknown', 'unknown'],
  );
});

test('legacy state and snapshots normalize missing receipts without changing their version', () => {
  const legacy = baseline([row('a'), row('b')]);
  for (const record of legacy.records) delete record.outgoingReceipt;
  const legacyCopy = structuredClone(legacy);
  const { state, report } = compareSnapshots(
    legacy,
    snapshot([row('a', { outgoingReceipt: receipt('read') })], 1),
  );
  assert.equal(state.version, 1);
  assert.deepEqual(legacy, legacyCopy);
  assert.deepEqual(state.records[1].outgoingReceipt, receipt('unknown'));
  assert.equal(report.counts.receiptObserved, 1);
  assert.equal(report.counts.receiptChanged, 0);
  assert.deepEqual(
    report.changes.map(({ type, before, after, previewChanged }) => ({
      type,
      before,
      after,
      previewChanged,
    })),
    [
      {
        type: 'receipt_observed',
        before: receipt('unknown'),
        after: receipt('read'),
        previewChanged: false,
      },
    ],
  );
});

test('delivered to read is a latest-summary receipt change, with no same-message claim', () => {
  const initial = baseline([row('a', { outgoingReceipt: receipt('delivered') })]);
  const { report } = compareSnapshots(
    initial,
    snapshot([row('a', { outgoingReceipt: receipt('read') })], 1),
  );
  assert.deepEqual(
    report.changes.map(({ type, before, after, previewChanged }) => ({
      type,
      before,
      after,
      previewChanged,
    })),
    [
      {
        type: 'receipt_changed',
        before: receipt('delivered'),
        after: receipt('read'),
        previewChanged: false,
      },
    ],
  );
  assert.equal(report.counts.receiptChanged, 1);
  assert.equal(report.counts.receiptObserved, 0);
  assert.ok(report.warnings.some((warning) => warning.includes('same message')));
});

test('known receipt becoming unavailable clears current receipt without reporting unread', () => {
  const initial = baseline([row('a', { outgoingReceipt: receipt('read') })]);
  const unknown = compareSnapshots(
    initial,
    snapshot([row('a', { outgoingReceipt: receipt('unknown') })], 1),
  );
  assert.deepEqual(unknown.report.changes, []);
  assert.equal(unknown.report.counts.receiptUnavailable, 1);
  assert.deepEqual(unknown.state.records[0].outgoingReceipt, receipt('unknown'));
  const missingField = compareSnapshots(initial, snapshot([row('a')], 1));
  assert.deepEqual(missingField.state.records[0].outgoingReceipt, receipt('unknown'));
  const knownAgain = compareSnapshots(
    unknown.state,
    snapshot([row('a', { outgoingReceipt: receipt('read') })], 2),
  );
  assert.equal(knownAgain.report.changes[0].type, 'receipt_observed');
});

test('simultaneous preview and receipt changes explicitly mark previewChanged', () => {
  const initial = baseline([row('a', { outgoingReceipt: receipt('read') })]);
  const { report } = compareSnapshots(
    initial,
    snapshot(
      [row('a', { preview: 'Another synthetic summary', outgoingReceipt: receipt('delivered') })],
      1,
    ),
  );
  assert.deepEqual(
    report.changes.map((change) => change.type),
    ['preview_changed', 'receipt_changed'],
  );
  assert.equal(report.changes[1].previewChanged, true);
  assert.deepEqual(report.changes[1].after, receipt('delivered'));
});

test('unchanged receipt does not alert even when the preview changes', () => {
  const initial = baseline([row('a', { outgoingReceipt: receipt('read') })]);
  const { report } = compareSnapshots(
    initial,
    snapshot(
      [row('a', { preview: 'Another synthetic summary', outgoingReceipt: receipt('read') })],
      1,
    ),
  );
  assert.deepEqual(
    report.changes.map((change) => change.type),
    ['preview_changed'],
  );
  assert.equal(report.counts.receiptChanged, 0);
});

test('receipt bracket formatting does not manufacture a status change', () => {
  const initial = baseline([row('a', { outgoingReceipt: { ...receipt('read'), label: '已读' } })]);
  const { state, report } = compareSnapshots(
    initial,
    snapshot([row('a', { outgoingReceipt: receipt('read') })], 1),
  );
  assert.deepEqual(report.changes, []);
  assert.deepEqual(state.records[0].outgoingReceipt, receipt('read'));
});

test('new identities include receipts only inside first_observed data', () => {
  const { state, report } = compareSnapshots(
    baseline([]),
    snapshot([row('a', { outgoingReceipt: receipt('unread') })], 1),
  );
  assert.deepEqual(
    report.changes.map((change) => change.type),
    ['first_observed'],
  );
  assert.deepEqual(report.changes[0].after.outgoingReceipt, receipt('unread'));
  assert.equal(report.counts.receiptObserved, 0);
  report.changes[0].after.outgoingReceipt.status = 'unknown';
  assert.deepEqual(state.records[0].outgoingReceipt, receipt('unread'));
});

test('receipt history survives missing rows and duplicate keys are entirely skipped', () => {
  const initial = baseline([row('a', { outgoingReceipt: receipt('read') })]);
  const absent = compareSnapshots(initial, snapshot([], 1));
  assert.deepEqual(absent.state.records, initial.records);
  assert.equal(absent.report.counts.receiptUnavailable, 0);
  const duplicate = compareSnapshots(
    initial,
    snapshot(
      [
        row('a', { outgoingReceipt: receipt('unread') }),
        row('a', { outgoingReceipt: receipt('unknown') }),
      ],
      1,
    ),
  );
  assert.deepEqual(duplicate.report.changes, []);
  assert.deepEqual(duplicate.state.records, initial.records);
  assert.equal(duplicate.report.counts.receiptUnavailable, 0);
});

test('receipt objects are copied without mutating or aliasing either input', () => {
  const initial = baseline([row('a', { outgoingReceipt: receipt('delivered') })]);
  const next = snapshot([row('a', { outgoingReceipt: receipt('read') })], 1);
  const initialCopy = structuredClone(initial);
  const nextCopy = structuredClone(next);
  const { state, report } = compareSnapshots(initial, next);
  report.changes[0].before.status = 'unknown';
  report.changes[0].after.status = 'unknown';
  assert.deepEqual(state.records[0].outgoingReceipt, receipt('read'));
  state.records[0].outgoingReceipt.status = 'unknown';
  assert.deepEqual(initial, initialCopy);
  assert.deepEqual(next, nextCopy);
});

test('invalid or unsupported receipt evidence fails closed in snapshots and saved state', () => {
  const invalidReceipts = [
    null,
    undefined,
    '已读',
    {},
    { status: 'read', label: '已读', source: null },
    { status: 'delivered', label: '已读', source: 'list_receipt_label' },
    { status: 'read', label: '对方已读', source: 'list_receipt_label' },
    { status: 'read', label: '已读', source: 'preview_text' },
    { status: 'unknown', label: '未读', source: null },
    { status: 'unknown', label: null, source: 'list_receipt_label' },
    { status: 'rejected', label: '已拒绝', source: 'list_receipt_label' },
  ];
  const initial = baseline([row('a')]);
  for (const outgoingReceipt of invalidReceipts) {
    assert.throws(
      () => compareSnapshots(null, snapshot([row('a', { outgoingReceipt })])),
      TypeError,
    );
    const invalidState = { ...initial, records: [{ ...initial.records[0], outgoingReceipt }] };
    assert.throws(() => compareSnapshots(invalidState, snapshot([row('a')], 1)), TypeError);
  }
});

test('job-aware baseline records observed fields without creating job alerts', () => {
  const { state, report } = compareSnapshots(
    null,
    snapshot([
      row('a', { job: job('Synthetic engineer', jobUrl('Abc_123-x'), 'selected_chat_card') }),
      row('b', { job: job('Synthetic designer', null, 'chat_list') }),
      row('c'),
    ]),
  );
  assert.deepEqual(report.changes, []);
  assert.equal(report.counts.jobObserved, 0);
  assert.equal(report.counts.jobChanged, 0);
  assert.equal(report.counts.jobUnavailable, 1);
  assert.deepEqual(
    state.records[0].job,
    job('Synthetic engineer', jobUrl('Abc_123-x'), 'selected_chat_card'),
  );
  assert.deepEqual(state.records[2].job, job());
});

test('legacy baseline job fields migrate to unknown and subsequent evidence is job_observed', () => {
  const initial = baseline([row('a'), row('b')]);
  for (const record of initial.records) delete record.job;
  const initialCopy = structuredClone(initial);
  const { state, report } = compareSnapshots(
    initial,
    snapshot([row('a', { job: job('Synthetic engineer', null, 'chat_list') })], 1),
  );
  assert.equal(state.version, 1);
  assert.deepEqual(initial, initialCopy);
  assert.deepEqual(state.records[1].job, job());
  assert.deepEqual(
    report.changes.map(({ type, before, after }) => ({ type, before, after })),
    [
      {
        type: 'job_observed',
        before: job(),
        after: job('Synthetic engineer', null, 'chat_list'),
      },
    ],
  );
  assert.equal(report.counts.jobObserved, 1);
});

test('contact titles and preview text never become job names or links', () => {
  const { state, report } = compareSnapshots(
    null,
    snapshot([row('a', { title: '人力资源经理', preview: `招聘工程师 ${jobUrl('Synthetic')}` })]),
  );
  assert.equal(state.records[0].title, '人力资源经理');
  assert.deepEqual(state.records[0].job, job());
  assert.equal(report.counts.jobUnavailable, 1);
});

test('known job becoming unknown clears current fields without manufacturing a change', () => {
  const initial = baseline([
    row('a', { job: job('Synthetic engineer', jobUrl('One'), 'selected_chat_card') }),
  ]);
  const result = compareSnapshots(initial, snapshot([row('a', { job: job() })], 1));
  assert.deepEqual(result.state.records[0].job, job());
  assert.deepEqual(result.report.changes, []);
  assert.equal(result.report.counts.jobUnavailable, 1);
  const missingField = compareSnapshots(initial, snapshot([row('a')], 1));
  assert.deepEqual(missingField.state.records[0].job, job());
  const observedAgain = compareSnapshots(
    result.state,
    snapshot([row('a', { job: job('Synthetic engineer', null, 'chat_list') })], 2),
  );
  assert.equal(observedAgain.report.changes[0].type, 'job_observed');
});

test('adding a missing URL or name completes details without claiming a different job', () => {
  const nameOnly = baseline([row('a', { job: job('Synthetic engineer', null, 'chat_list') })]);
  const completed = compareSnapshots(
    nameOnly,
    snapshot(
      [row('a', { job: job('Synthetic engineer', jobUrl('One'), 'selected_chat_card') })],
      1,
    ),
  );
  assert.deepEqual(completed.report.changes, []);
  assert.equal(completed.report.counts.jobObserved, 0);
  assert.equal(completed.report.counts.jobChanged, 0);
  assert.deepEqual(
    completed.state.records[0].job,
    job('Synthetic engineer', jobUrl('One'), 'selected_chat_card'),
  );
  const urlOnly = baseline([row('a', { job: job(null, jobUrl('One'), 'chat_list') })]);
  const named = compareSnapshots(
    urlOnly,
    snapshot(
      [row('a', { job: job('Synthetic engineer', jobUrl('One'), 'selected_chat_card') })],
      1,
    ),
  );
  assert.deepEqual(named.report.changes, []);
});

test('missing fields are not compared against known values and are not inherited', () => {
  const full = baseline([
    row('a', { job: job('Synthetic engineer', jobUrl('One'), 'selected_chat_card') }),
  ]);
  const partial = compareSnapshots(
    full,
    snapshot([row('a', { job: job('Synthetic engineer', null, 'chat_list') })], 1),
  );
  assert.deepEqual(partial.report.changes, []);
  assert.deepEqual(partial.state.records[0].job, job('Synthetic engineer', null, 'chat_list'));
  const disjoint = compareSnapshots(
    partial.state,
    snapshot([row('a', { job: job(null, jobUrl('Another'), 'selected_chat_card') })], 2),
  );
  assert.deepEqual(disjoint.report.changes, []);
  assert.deepEqual(
    disjoint.state.records[0].job,
    job(null, jobUrl('Another'), 'selected_chat_card'),
  );
});

test('actual differing known job fields produce one job_changed with exact changedFields', () => {
  const initial = baseline([
    row('a', { job: job('Synthetic engineer', jobUrl('One'), 'selected_chat_card') }),
  ]);
  const next = compareSnapshots(
    initial,
    snapshot(
      [row('a', { job: job('Synthetic designer', jobUrl('Two'), 'selected_chat_card') })],
      1,
    ),
  );
  assert.deepEqual(
    next.report.changes.map((change) => change.type),
    ['job_changed'],
  );
  assert.deepEqual(next.report.changes[0].changedFields, ['name', 'detailUrl']);
  assert.equal(next.report.counts.jobChanged, 1);
  const urlOnlyChanged = compareSnapshots(
    initial,
    snapshot([row('a', { job: job(null, jobUrl('Two'), 'selected_chat_card') })], 1),
  );
  assert.deepEqual(urlOnlyChanged.report.changes[0].changedFields, ['detailUrl']);
  const nameOnlyChanged = compareSnapshots(
    initial,
    snapshot([row('a', { job: job('Synthetic designer', null, 'chat_list') })], 1),
  );
  assert.deepEqual(nameOnlyChanged.report.changes[0].changedFields, ['name']);
});

test('changing only the observation source does not manufacture a job change', () => {
  const initial = baseline([row('a', { job: job('Synthetic engineer', null, 'chat_list') })]);
  const { report } = compareSnapshots(
    initial,
    snapshot([row('a', { job: job('Synthetic engineer', null, 'selected_chat_card') })], 1),
  );
  assert.deepEqual(report.changes, []);
});

test('first_observed includes job data without a separate job notification', () => {
  const { state, report } = compareSnapshots(
    baseline([]),
    snapshot([row('a', { job: job('Synthetic engineer', jobUrl('One'), 'chat_list') })], 1),
  );
  assert.deepEqual(
    report.changes.map((change) => change.type),
    ['first_observed'],
  );
  assert.deepEqual(
    report.changes[0].after.job,
    job('Synthetic engineer', jobUrl('One'), 'chat_list'),
  );
  assert.equal(report.counts.jobObserved, 0);
  report.changes[0].after.job.name = 'Mutated report';
  assert.equal(state.records[0].job.name, 'Synthetic engineer');
});

test('absent records retain jobs and all duplicate-key rows are skipped', () => {
  const initial = baseline([row('a', { job: job('Synthetic engineer', null, 'chat_list') })]);
  const absent = compareSnapshots(initial, snapshot([], 1));
  assert.deepEqual(absent.state.records, initial.records);
  const duplicate = compareSnapshots(
    initial,
    snapshot(
      [row('a', { job: job('Synthetic designer', null, 'chat_list') }), row('a', { job: job() })],
      1,
    ),
  );
  assert.deepEqual(duplicate.state.records, initial.records);
  assert.deepEqual(duplicate.report.changes, []);
  assert.equal(duplicate.report.counts.jobUnavailable, 0);
});

test('job objects are copied without mutating or aliasing either input', () => {
  const initial = baseline([
    row('a', { job: job('Synthetic engineer', jobUrl('One'), 'chat_list') }),
  ]);
  const next = snapshot(
    [row('a', { job: job('Synthetic designer', jobUrl('Two'), 'selected_chat_card') })],
    1,
  );
  const initialCopy = structuredClone(initial);
  const nextCopy = structuredClone(next);
  const { state, report } = compareSnapshots(initial, next);
  report.changes[0].before.name = 'Mutated before';
  report.changes[0].after.name = 'Mutated after';
  assert.equal(state.records[0].job.name, 'Synthetic designer');
  state.records[0].job.name = 'Mutated state';
  assert.deepEqual(initial, initialCopy);
  assert.deepEqual(next, nextCopy);
});

test('unsafe, noncanonical and unrelated job URLs fail closed', () => {
  const invalidUrls = [
    'https://www.zhipin.com/',
    'https://www.zhipin.com/job_detail/',
    'https://evil.example/job_detail/One.html',
    'https://zhipin.com/job_detail/One.html',
    'http://www.zhipin.com/job_detail/One.html',
    'javascript:alert(1)',
    '/job_detail/One.html',
    '//www.zhipin.com/job_detail/One.html',
    'https://user:pass@www.zhipin.com/job_detail/One.html',
    'https://www.zhipin.com.evil.example/job_detail/One.html',
    'https://www.zhipin.com:443/job_detail/One.html',
    `${jobUrl('One')}?from=chat`,
    `${jobUrl('One')}#detail`,
    `${jobUrl('One')}?`,
    'https://www.zhipin.com/job_detail/../One.html',
    'https://www.zhipin.com/job_detail/%2e%2e.html',
    'https://www.zhipin.com/job_detail/a%2fb.html',
    'https://www.zhipin.com/job_detail/a/b.html',
    'https://www.zhipin.com/job_detail/a\\b.html',
    `${jobUrl('One')}\n`,
    ` ${jobUrl('One')}`,
    '',
    undefined,
    42,
  ];
  for (const detailUrl of invalidUrls) {
    assert.throws(
      () =>
        compareSnapshots(null, snapshot([row('a', { job: job(null, detailUrl, 'chat_list') })])),
      TypeError,
    );
  }
});

test('invalid job names, missing fields and inconsistent sources fail closed', () => {
  const invalidJobs = [
    null,
    undefined,
    'Synthetic engineer',
    {},
    { name: null, detailUrl: null },
    job('', null, 'chat_list'),
    job('  ', null, 'chat_list'),
    job('a'.repeat(301), null, 'chat_list'),
    job(3, null, 'chat_list'),
    job('Synthetic engineer', null, null),
    job(null, jobUrl('One'), null),
    job(null, null, 'chat_list'),
    job('Synthetic engineer', null, 'contact_title'),
  ];
  const initial = baseline([row('a')]);
  for (const value of invalidJobs) {
    assert.throws(() => compareSnapshots(null, snapshot([row('a', { job: value })])), TypeError);
    const invalidState = { ...initial, records: [{ ...initial.records[0], job: value }] };
    assert.throws(() => compareSnapshots(invalidState, snapshot([row('a')], 1)), TypeError);
  }
  const accepted = compareSnapshots(
    null,
    snapshot([row('a', { job: job('a'.repeat(300), null, 'chat_list') })]),
  );
  assert.equal(accepted.state.records[0].job.name.length, 300);
});
