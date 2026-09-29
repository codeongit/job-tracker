import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDetailEvidenceV2,
  canonicalJobUrlV2,
  compareLoadedSnapshotsV2,
  conversationKeyV2,
  importLegacyV1ToV2,
  listEnrichmentTargetsV2,
  migrateV1ToV2,
  resolveJobRowsV2,
  upgradeEnvelope,
  validateEnvelopeV2,
  validateCurrentEnvelope,
  validateLoadedSnapshotV2,
} from './model-v2.mjs';

const at = (minute) => `2026-09-18T10:${String(minute).padStart(2, '0')}:00.000Z`;
const namespace = 'boss-account-fixture';
const receipt = (status) =>
  status === 'unknown'
    ? { status, label: null, source: null }
    : { status, label: status === 'read' ? '[已读]' : '[送达]', source: 'list_receipt_label' };

function row(friendId, overrides = {}) {
  const friendSource = String(overrides.friendSource ?? 1);
  const id = String(friendId);
  const result = {
    key: conversationKeyV2(namespace, id, friendSource),
    platformIdentity: { friendId: id, friendSource, uniqueId: `${id}-${friendSource}` },
    contact: `联系人${id}`,
    company: `公司${id}`,
    title: '招聘者',
    preview: '消息摘要',
    timeLabel: '10:00',
    unread: null,
    latestMessageId: `message-${id}`,
    outgoingReceipt: receipt('unknown'),
    jobAssociation: { jobId: null, detailUrl: null },
    observedJobName: null,
    ...overrides,
  };
  delete result.friendSource;
  return result;
}

function snapshot(records, minute = 0) {
  return {
    capturedAt: at(minute),
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records,
    coverage: {
      loadedRows: records.length,
      loadedDataRows: records.length,
      unresolvedRows: 0,
      renderedRows: records.length,
      offscreenRows: 0,
      truncated: false,
    },
  };
}

test('conversation identity is account + friendId + friendSource, never display text', () => {
  assert.equal(conversationKeyV2(namespace, '12', '1'), conversationKeyV2(namespace, 12, 1));
  assert.notEqual(conversationKeyV2(namespace, '12', '1'), conversationKeyV2(namespace, '12', '2'));
  assert.notEqual(
    conversationKeyV2(namespace, '12', '1'),
    conversationKeyV2('another-account', '12', '1'),
  );
  assert.equal(conversationKeyV2(namespace, '12', '1').length, 64);
  assert.throws(() => canonicalJobUrlV2('../unsafe'), TypeError);
});

test('capture validation recomputes keys and verifies platform uniqueId and job URL', () => {
  const valid = row('a', {
    jobAssociation: { jobId: 'job_A-1', detailUrl: canonicalJobUrlV2('job_A-1') },
    observedJobName: '架构师',
  });
  assert.deepEqual(validateLoadedSnapshotV2(snapshot([valid])).records[0], valid);
  assert.throws(() => validateLoadedSnapshotV2(snapshot([{ ...valid, key: 'wrong' }])), TypeError);
  assert.throws(
    () =>
      validateLoadedSnapshotV2(
        snapshot([
          {
            ...valid,
            platformIdentity: { ...valid.platformIdentity, uniqueId: 'wrong' },
          },
        ]),
      ),
    TypeError,
  );
  assert.throws(
    () =>
      validateLoadedSnapshotV2(
        snapshot([
          {
            ...valid,
            jobAssociation: { jobId: 'other', detailUrl: valid.jobAssociation.detailUrl },
          },
        ]),
      ),
    TypeError,
  );
});

test('comparison retains missing history and display-name changes do not create a new conversation', () => {
  const first = compareLoadedSnapshotsV2(null, snapshot([row('a'), row('b')], 0));
  const renamed = compareLoadedSnapshotsV2(
    first.envelope,
    snapshot([row('a', { contact: '新姓名', company: '新公司' })], 1),
  );
  assert.equal(renamed.envelope.state.records.length, 2);
  assert.equal(renamed.report.counts.notObservedThisCapture, 1);
  assert.equal(renamed.report.counts.firstObserved, 0);
  assert.deepEqual(
    renamed.report.changes.map((change) => change.type),
    ['profile_changed'],
  );
  assert.equal(
    renamed.envelope.state.records.find((item) => item.key === row('a').key).firstObservedAt,
    at(0),
  );
  assert.deepEqual(first.envelope, validateCurrentEnvelope(first.envelope));
});

test('legacy v2 envelopes upgrade explicitly and without changing their safe shape', () => {
  const current = compareLoadedSnapshotsV2(null, snapshot([row('a')], 0)).envelope;
  const legacy = { ...structuredClone(current), version: 2 };
  assert.equal(validateEnvelopeV2(legacy).version, 2);
  const upgraded = upgradeEnvelope(legacy);
  assert.equal(upgraded.version, 4);
  assert.deepEqual({ ...upgraded, version: 2 }, legacy);
  const next = compareLoadedSnapshotsV2(legacy, snapshot([row('a')], 1)).envelope;
  assert.equal(next.version, 4);
  assert.equal(legacy.version, 2);
});

test('message IDs gate receipt transitions', () => {
  const initial = compareLoadedSnapshotsV2(
    null,
    snapshot(
      [
        row('a', { latestMessageId: 'm1', outgoingReceipt: receipt('delivered') }),
        row('b', { latestMessageId: null, outgoingReceipt: receipt('delivered') }),
      ],
      0,
    ),
  ).envelope;
  const changed = compareLoadedSnapshotsV2(
    initial,
    snapshot(
      [
        row('a', { latestMessageId: 'm1', outgoingReceipt: receipt('read') }),
        row('b', { latestMessageId: null, outgoingReceipt: receipt('read') }),
      ],
      1,
    ),
  );
  assert.equal(changed.report.counts.receiptChanged, 1);
  assert.equal(changed.report.counts.receiptTransitionSuppressed, 1);
  assert.deepEqual(
    changed.report.changes
      .filter((change) => change.type.startsWith('receipt'))
      .map((change) => ({
        key: change.conversationKey,
        type: change.type,
        suppressed: change.transitionSuppressed ?? false,
      })),
    [
      { key: row('a').key, type: 'receipt_changed', suppressed: false },
      { key: row('b').key, type: 'receipt_observed', suppressed: true },
    ],
  );

  const newMessage = compareLoadedSnapshotsV2(
    initial,
    snapshot([row('a', { latestMessageId: 'm2', outgoingReceipt: receipt('read') })], 1),
  );
  assert.equal(newMessage.report.counts.receiptChanged, 0);
  assert.equal(newMessage.report.counts.receiptTransitionSuppressed, 1);
});

test('associations are independent: shared jobs, changes and unavailable jobs preserve history', () => {
  const shared = { jobId: 'shared', detailUrl: canonicalJobUrlV2('shared') };
  let current = compareLoadedSnapshotsV2(
    null,
    snapshot(
      [
        row('a', { jobAssociation: shared, observedJobName: '平台工程师' }),
        row('b', { jobAssociation: shared, observedJobName: null }),
      ],
      0,
    ),
  ).envelope;
  assert.equal(current.jobs.associations.length, 2);
  assert.equal(current.jobs.evidence.length, 1);
  current = compareLoadedSnapshotsV2(
    current,
    snapshot(
      [
        row('a', { jobAssociation: { jobId: 'next', detailUrl: canonicalJobUrlV2('next') } }),
        row('b'),
      ],
      1,
    ),
  ).envelope;
  const a = current.jobs.associations.filter((item) => item.conversationKey === row('a').key);
  assert.deepEqual(a.map((item) => [item.jobId, item.status]).sort(), [
    ['next', 'current'],
    ['shared', 'historical'],
  ]);
  assert.equal(
    current.jobs.associations.find((item) => item.conversationKey === row('b').key).status,
    'historical',
  );
  current = compareLoadedSnapshotsV2(
    current,
    snapshot([row('b', { jobAssociation: shared })], 2),
  ).envelope;
  assert.equal(
    current.jobs.associations.find((item) => item.conversationKey === row('b').key).status,
    'current',
  );
});

function legacyFixture(records) {
  return {
    version: 1,
    account: 'main',
    confirmedAt: at(3),
    state: {
      version: 1,
      scope: 'loaded-chat-list',
      baselineCapturedAt: at(0),
      lastCapturedAt: at(2),
      records: records.map((item) => ({
        key: item.legacyKey,
        contact: item.contact,
        company: item.company,
        job: item.legacyJob ?? { name: null, detailUrl: null, source: null },
      })),
    },
    jobEvidence: records[0] ? { recordKey: records[0].legacyKey, confirmedAt: at(3) } : null,
  };
}

function enrichedFixture(records) {
  return {
    version: 1,
    inboxCapturedAt: at(2),
    rows: records.map((item) => ({
      key: item.legacyKey,
      contact: item.contact,
      company: item.company,
      name: item.name ?? null,
      nameSource: item.name ? 'loaded_jobName' : null,
      jobName: item.name ?? null,
      detailUrl: item.url ?? null,
      confirmation: item.confirmed ? 'confirmed_user' : 'unverified_generated',
      loadedObservedAt: at(2),
      detailTitleObservation: null,
      candidateTitleObservation: item.candidate ?? null,
    })),
  };
}

test('legacy import maps only a unique compatible name/company pair and quarantines ambiguity/mismatch', () => {
  const sourceRows = [
    {
      legacyKey: 'old-a',
      contact: '甲',
      company: '公司甲',
      url: canonicalJobUrlV2('job-a'),
      name: '岗位甲',
      confirmed: true,
    },
    {
      legacyKey: 'old-b1',
      contact: '同名',
      company: '同公司',
      url: canonicalJobUrlV2('job-b1'),
      name: '岗位乙1',
    },
    {
      legacyKey: 'old-b2',
      contact: '同名',
      company: '同公司',
      url: canonicalJobUrlV2('job-b2'),
      name: '岗位乙2',
    },
    {
      legacyKey: 'old-c',
      contact: '丙',
      company: '公司丙',
      url: canonicalJobUrlV2('legacy-c'),
      name: '岗位丙',
    },
  ];
  const stable = snapshot(
    [
      row('a', { contact: '甲', company: '公司甲' }),
      row('b', { contact: '同名', company: '同公司' }),
      row('c', {
        contact: '丙',
        company: '公司丙',
        jobAssociation: { jobId: 'current-c', detailUrl: canonicalJobUrlV2('current-c') },
      }),
    ],
    4,
  );
  const migrated = migrateV1ToV2({
    snapshot: stable,
    v1Envelope: legacyFixture(sourceRows),
    enrichedJobs: enrichedFixture(sourceRows),
    migratedAt: at(5),
  });
  assert.equal(migrated.report.migration.counts.imported, 1);
  assert.equal(migrated.report.migration.counts.quarantined, 3);
  assert.equal(migrated.envelope.jobs.evidence.length, 1);
  assert.equal(migrated.envelope.jobs.confirmations.length, 1);
  assert.deepEqual(
    new Set(migrated.envelope.migration.quarantine.map((item) => item.reason)),
    new Set(['ambiguous_legacy_name_company', 'platform_job_mismatch']),
  );

  const again = importLegacyV1ToV2(migrated.envelope, {
    v1Envelope: legacyFixture(sourceRows),
    enrichedJobs: enrichedFixture(sourceRows),
    importedAt: at(5),
  });
  assert.equal(again.report.alreadyImported, true);
  assert.deepEqual(again.envelope, migrated.envelope);
});

test('detail evidence is exact, idempotent and company mismatch remains a candidate', () => {
  const job = { jobId: 'detail-job', detailUrl: canonicalJobUrlV2('detail-job') };
  const baseline = compareLoadedSnapshotsV2(
    null,
    snapshot([row('a', { contact: '甲', company: '公司甲', jobAssociation: job })], 0),
  ).envelope;
  const beforeState = structuredClone(baseline.state);
  const beforeSnapshot = structuredClone(baseline.snapshot);
  const result = {
    observations: [
      {
        conversationKey: row('a').key,
        ...job,
        name: '后端架构师',
        company: '公司甲',
        title: '「后端架构师招聘」_公司甲招聘-BOSS直聘',
        observedAt: at(1),
        source: 'detail_page_title',
      },
      {
        conversationKey: row('a').key,
        ...job,
        name: '另一个岗位',
        company: '页面另一公司',
        title: '「另一个岗位招聘」_页面另一公司招聘-BOSS直聘',
        observedAt: at(1),
        source: 'detail_page_title',
      },
    ],
    candidates: [],
  };
  const applied = applyDetailEvidenceV2(baseline, result, at(2));
  assert.equal(applied.report.counts.accepted, 1);
  assert.equal(applied.report.counts.candidateSaved, 1);
  assert.deepEqual(applied.envelope.state, beforeState);
  assert.deepEqual(applied.envelope.snapshot, beforeSnapshot);
  const view = resolveJobRowsV2(applied.envelope)[0];
  assert.equal(view.jobName, '后端架构师');
  assert.equal(view.candidates.length, 1);
  assert.equal(view.confirmation, 'unverified');
  const targets = listEnrichmentTargetsV2(applied.envelope);
  assert.equal(targets.targets[0].knownEvidence[0].title, result.observations[0].title);

  const repeated = applyDetailEvidenceV2(applied.envelope, result, at(3));
  assert.equal(repeated.report.counts.duplicates, 2);
  assert.deepEqual(repeated.envelope, applied.envelope);
  assert.throws(
    () =>
      applyDetailEvidenceV2(
        baseline,
        {
          observations: [{ ...result.observations[0], detailUrl: canonicalJobUrlV2('wrong') }],
          candidates: [],
        },
        at(2),
      ),
    TypeError,
  );
});

test('synthetic legacy batch migrates 39 names, one candidate and one exact confirmation', () => {
  const sourceRows = Array.from({ length: 40 }, (_, index) => ({
    legacyKey: `legacy-${index}`,
    contact: `迁移联系人${index}`,
    company: `迁移公司${index}`,
    url: canonicalJobUrlV2(`legacy-job-${index}`),
    name: index === 39 ? null : `迁移岗位${index}`,
    confirmed: index === 0,
    candidate:
      index === 39
        ? {
            name: '待核对岗位',
            source: 'detail_page_title',
            observedAt: at(2),
            observedCompany: '页面公司',
            title: '「待核对岗位招聘」_页面公司招聘-BOSS直聘',
          }
        : null,
  }));
  const stableRows = sourceRows.map((source, index) =>
    row(`migrated-${index}`, {
      contact: source.contact,
      company: source.company,
      latestMessageId: null,
    }),
  );
  const realSnapshot = { ...snapshot(stableRows, 20), capturedAt: '2026-09-18T13:30:00.000Z' };
  const migrated = migrateV1ToV2({
    snapshot: realSnapshot,
    v1Envelope: legacyFixture(sourceRows),
    enrichedJobs: enrichedFixture(sourceRows),
    migratedAt: '2026-09-18T14:00:00.000Z',
  });
  assert.equal(migrated.report.migration.counts.imported, 40);
  assert.equal(migrated.report.migration.counts.quarantined, 0);
  assert.equal(migrated.envelope.jobs.evidence.length, 39);
  assert.equal(migrated.envelope.jobs.candidates.length, 1);
  assert.equal(migrated.envelope.jobs.confirmations.length, 1);
  assert.equal(resolveJobRowsV2(migrated.envelope).filter((item) => item.jobName).length, 39);
  const confirmed = resolveJobRowsV2(migrated.envelope).filter(
    (item) => item.confirmation === 'confirmed_user',
  );
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].detailUrl, canonicalJobUrlV2('legacy-job-0'));
  const candidate = resolveJobRowsV2(migrated.envelope).find((item) => item.candidates.length);
  assert.equal(candidate.candidates[0].name, '待核对岗位');
});

test('all public operations reject malformed state without mutating inputs', () => {
  const originalSnapshot = snapshot([row('a')]);
  const snapshotCopy = structuredClone(originalSnapshot);
  const baseline = compareLoadedSnapshotsV2(null, originalSnapshot).envelope;
  assert.deepEqual(originalSnapshot, snapshotCopy);
  const corrupted = structuredClone(baseline);
  corrupted.state.records.push(structuredClone(corrupted.state.records[0]));
  assert.throws(() => validateEnvelopeV2(corrupted), TypeError);
  assert.throws(
    () => compareLoadedSnapshotsV2(baseline, { ...snapshot([]), accountNamespace: 'other' }),
    TypeError,
  );
  assert.deepEqual(baseline, compareLoadedSnapshotsV2(null, originalSnapshot).envelope);
});
