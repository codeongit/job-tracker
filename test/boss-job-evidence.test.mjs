import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareLoadedSnapshotsV2,
  conversationKeyV2,
  applyDetailEvidenceV2,
  resolveJobRowsV2,
  listEnrichmentTargetsV2,
} from '../collector/boss/model-v2.mjs';
import { toResumeHistoryResult, applyResumeHistoryV2 } from '../collector/boss/resume-history.mjs';
import {
  resolveJobRows,
  createResumeBatch,
  createIncrementalBatch,
  stableHash,
} from '../scripts/boss-conversion.mjs';
import { createInitialBatch, createDatedYesterdayBatch } from '../scripts/boss-legacy-import.mjs';

import { resolveBossJobEvidence } from '../collector/boss/job-evidence.mjs';
import { bossFactId, bossApplicationId } from '../dist/source-identity.js';
import { bossBatchDigestInput } from '../dist/boss-batch.js';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const FIRST = '2026-09-18T08:00:00.000Z';
const CAPTURE = '2026-09-20T08:00:00.000Z';
const DETAIL = '2026-10-06T08:00:00.000Z';
const url = (id) => `https://www.zhipin.com/job_detail/${id}.html`;

function record(id, { timeLabel = '14:00', jobId = `job~${id}` } = {}) {
  return {
    key: conversationKeyV2(ACCOUNT, id, '0'),
    platformIdentity: { friendId: id, friendSource: '0', uniqueId: `${id}-0` },
    contact: `Synthetic contact ${id}`,
    company: 'Synthetic recruiter',
    title: 'Recruiter',
    preview: 'Synthetic message',
    timeLabel,
    unread: null,
    latestMessageId: `message-${id}`,
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: { jobId, detailUrl: jobId ? url(jobId) : null },
    observedJobName: jobId ? `Loaded role ${id}` : null,
  };
}
function snapshot(records, capturedAt) {
  return {
    capturedAt,
    scope: 'loaded-chat-list',
    accountNamespace: ACCOUNT,
    records,
    coverage: {
      loadedRows: records.length,
      loadedDataRows: records.length,
      renderedRows: records.length,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  };
}
function fixture() {
  const records = [
    record('1'),
    record('2', { timeLabel: '昨天', jobId: 'j'.repeat(299) + '~' }),
    record('3', { jobId: null }),
    record('4'),
  ];
  const first = compareLoadedSnapshotsV2(null, snapshot(records, FIRST)).envelope;
  const previous = compareLoadedSnapshotsV2(first, snapshot(records.slice(0, 3), CAPTURE)).envelope;
  let current = applyDetailEvidenceV2(
    previous,
    {
      observations: [records[0], records[1], records[3]].map((item) => ({
        conversationKey: item.key,
        jobId: item.jobAssociation.jobId,
        detailUrl: item.jobAssociation.detailUrl,
        name: 'Detail role',
        company: 'Synthetic employer',
        title: '「Detail role招聘」_Synthetic employer招聘-BOSS直聘',
        source: 'detail_page_title',
        observedAt: DETAIL,
      })),
      candidates: [],
    },
    DETAIL,
  ).envelope;
  const resume = toResumeHistoryResult(
    {
      ok: true,
      url: 'https://www.zhipin.com/web/geek/chat',
      capturedAt: DETAIL,
      observations: ['sent_candidate', 'request_sent'].map((kind, index) => ({
        conversationKey: records[0].key,
        friendId: '1',
        friendSource: '0',
        messageId: `resume-${index}`,
        direction: index === 0 ? 'outbound' : 'system',
        messageType: 4,
        kind,
        platformTime: CAPTURE,
        externalJobId: 'job~1',
        source: index === 0 ? 'geek_history_type_4' : 'geek_history_status_message',
      })),
      unresolved: [],
      coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 1 },
    },
    current,
  );
  current = applyResumeHistoryV2(current, resume).envelope;
  return { previous, current };
}
const reference = (envelope, digit) => ({
  path: `synthetic-${digit}.json`,
  sha256: digit.repeat(64),
  envelope,
});
function characterizedOutputs() {
  const { previous, current } = fixture();
  const before = structuredClone(current);
  const ref = reference(current, '2');
  const outputs = {
    collector: resolveJobRowsV2(current),
    enrichment: listEnrichmentTargetsV2(current),
    legacy: resolveJobRows(current),
    delivery: resolveJobRows(current, { includeRetainedDetails: true }),
    initial: createInitialBatch(ref, 1),
    dated: createDatedYesterdayBatch(ref, 2, '2026-09-19'),
    resume: createResumeBatch(ref, 3),
    incremental: createIncrementalBatch(reference(previous, '1'), ref, 4),
  };
  outputs.sourceIdentities = Object.fromEntries(
    ['initial', 'dated', 'resume', 'incremental'].map((key) => [
      key,
      outputs[key].events.map((event) => {
        const factId = bossFactId({ ...event, accountNamespace: outputs[key].accountNamespace });
        return { eventId: event.eventId, factId, applicationId: bossApplicationId(factId) };
      }),
    ]),
  );
  assert.deepEqual(current, before);
  return outputs;
}

// Recorded from c22bcd2 before extracting evidence selection. Hashes cover
// complete public outputs, including batch/event IDs and all identity inputs.
const GOLDEN = {
  sourceIdentities: 'fd69cdd2c1d9298f3796f69275502657c885329d8be2f1c6e0076f052de07323',
  collector: '92219edad9e27b54c43f5def75a051d4f68ffe508d0a617e4c3df677a9cd7fba',
  enrichment: '7ebc7ad2ea37c468ee5474c71be88d9897cb26109e3b9d01f74f85152eed373c',
  legacy: '6dc66660f44e05b7d2e541e5f12c78a826955762ad45c95ac59c9bed64037761',
  delivery: '767076bda9e8d5807b463bca681ec40ff1a93d8d80fd5ce3ff6f461d1a5af447',
  initial: 'ba4bd2c278badeb1a08afcbb7c97ae7401e3c66fd3b3b138ce74d47c78e88666',
  dated: '41ead2db09d8c2bc60676214427be95269d63a47dbd06cbe8f42d5c89005fa8b',
  resume: '85e8d07c1074db87969090cabea4a640aa94bc159c5bf0f30c15ad108a3f5dc8',
  incremental: '752837a57928f2d74875482a7b6f0af3b2d2604e1bb9763e936e0c196a5c868e',
};
const V5_BATCH_GOLDEN = {
  initial: 'c96decbf6e17350f4805db36bea91ba37a141b04f84a9c14d96495177a7e16a8',
  dated: '4fbe5ff7920922fc898ea2457e8e5b450a6dee884f0faf6b03acd519a13d0eeb',
  resume: '13cbb4746b2a515d1b5917039824786b03cc0d4ed668c71a83fc92c18780c7d3',
  incremental: '77573eda68ff194583c33a080a25b573dffd8791b3d344925ef506ec7f1c8243',
};

function legacyBatchProjection(batch) {
  const legacy = structuredClone(batch);
  legacy.version = 4;
  for (const event of legacy.events) delete event.resumeEvidence;
  legacy.batchId = `boss-batch-${stableHash(bossBatchDigestInput(legacy))}`;
  return legacy;
}

test('evidence projections and stable identities retain baseline outputs across explicit v5 delivery', () => {
  const outputs = characterizedOutputs();
  const hashes = Object.fromEntries(
    Object.entries(outputs).map(([key, value]) => [
      key,
      stableHash(key in V5_BATCH_GOLDEN ? legacyBatchProjection(value) : value),
    ]),
  );
  assert.deepEqual(hashes, GOLDEN);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(V5_BATCH_GOLDEN).map((key) => {
        assert.equal(outputs[key].version, 5);
        return [key, stableHash(outputs[key])];
      }),
    ),
    V5_BATCH_GOLDEN,
  );
  assert.deepEqual(
    outputs.resume.events.find((event) => event.summary === 'resume_request_sent').resumeEvidence,
    { version: 1, messageType: 4, field: 'none', text: '' },
  );
  assert.equal(
    outputs.collector.find((row) => row.jobId === 'job~1').company,
    'Synthetic employer',
  );
  assert.equal(outputs.legacy[0].jobName, 'Loaded role 1');
  assert.equal(outputs.delivery[0].jobName, 'Detail role');
  assert.equal(outputs.delivery.length, 4);
  assert.equal(outputs.resume.events.length, 2);
});

const association = { jobId: 'job~1', detailUrl: url('job~1') };
const conversation = {
  key: 'synthetic-conversation',
  company: 'Recruiter',
  observedJobName: 'Fallback role',
};
const evidence = (source, name, company = 'Recruiter', observedAt = CAPTURE) => ({
  ...association,
  source,
  name,
  company,
  observedAt,
});
const decide = (items, projection, overrides = {}) =>
  resolveBossJobEvidence(
    {
      association,
      conversation,
      evidence: items,
      confirmations: [],
      ...overrides,
    },
    projection,
  );

test('modern employer selection and legacy identity projection preserve distinct responsibilities', () => {
  const items = [
    evidence('loaded_jobName', 'Loaded role'),
    evidence('detail_page_title', 'Detail role', 'Employer'),
  ];
  const before = structuredClone(items);
  for (const projection of ['collector', 'detail_delivery']) {
    const decision = decide(items, projection);
    assert.equal(decision.jobName, 'Detail role');
    assert.equal(decision.nameConflict, false);
    assert.equal(decision.jobDetails.company, 'Employer');
  }
  const legacy = decide(items, 'legacy_identity');
  assert.equal(legacy.jobName, 'Loaded role');
  assert.equal(legacy.nameConflict, true);
  assert.equal(legacy.jobDetails.company, 'Employer');
  assert.deepEqual(items, before);
});

test('semantic-equivalent details preserve original values while legacy uses exact conflict comparison', () => {
  const items = [
    evidence('detail_page_title', 'Cafe\u0301  role', 'Employer'),
    evidence('detail_page_title', 'Café role', 'Employer'),
  ];
  for (const projection of ['collector', 'detail_delivery']) {
    const decision = decide(items, projection);
    assert.equal(decision.conflict, false);
    assert.equal(decision.jobName, 'Cafe\u0301  role');
  }
  assert.equal(decide(items, 'legacy_identity').jobDetails.source, 'detail_page_conflict');
});

test('contradictory detail evidence cannot fall back in modern selection, while legacy identity remains intact', () => {
  const items = [
    evidence('loaded_jobName', 'Loaded role'),
    evidence('detail_page_title', 'First detail', 'Employer'),
    evidence('detail_page_title', 'Other detail', 'Employer', DETAIL),
  ];
  assert.equal(decide(items, 'collector').jobName, null);
  assert.equal(decide(items, 'detail_delivery').jobName, '');
  const legacy = decide(items, 'legacy_identity');
  assert.equal(legacy.jobName, 'Loaded role');
  assert.deepEqual(legacy.jobDetails, {
    jobId: 'job~1',
    canonicalUrl: url('job~1'),
    jobName: '',
    company: '',
    source: 'detail_page_conflict',
  });
});

test('selection filters both job and canonical link and preserves insertion order on equal timestamps', () => {
  const first = evidence('detail_page_title', 'Detail role', 'Employer');
  const second = { ...first, title: 'Different original title' };
  const unrelated = [
    { ...first, jobId: 'other', name: 'Other job' },
    { ...first, detailUrl: url('other'), name: 'Other link' },
  ];
  for (const projection of ['collector', 'detail_delivery', 'legacy_identity']) {
    const decision = decide([...unrelated, first, second], projection);
    assert.deepEqual(decision.evidence, [first, second]);
    assert.equal(decision.jobDetails.jobName, 'Detail role');
  }
  assert.equal(decide([first, second], 'collector').selected, first);
  assert.equal(decide([second, first], 'collector').selected, second);
});

test('missing association keeps collector nulls and conversion fallback without treating evidence as a match', () => {
  const items = [evidence('loaded_jobName', 'Unmatched role')];
  assert.equal(decide(items, 'collector', { association: null }).jobName, null);
  for (const projection of ['detail_delivery', 'legacy_identity']) {
    const decision = decide(items, projection, { association: null });
    assert.equal(decision.jobName, 'Fallback role');
    assert.equal(decision.nameSource, 'loaded_jobName');
    assert.equal(decision.jobDetails, null);
  }
});

test('explicit confirmation requires exact conversation, job, canonical link and confirmed status', () => {
  const exact = { ...association, conversationKey: conversation.key, status: 'confirmed_user' };
  const mismatches = [
    { ...exact, jobId: 'other' },
    { ...exact, detailUrl: url('other') },
    { ...exact, conversationKey: 'other' },
    { ...exact, status: 'candidate' },
  ];
  for (const projection of ['collector', 'detail_delivery', 'legacy_identity']) {
    assert.equal(decide([], projection, { confirmations: mismatches }).confirmed, false);
    assert.equal(decide([], projection, { confirmations: [...mismatches, exact] }).confirmed, true);
    assert.equal(
      decide([], projection, { association: null, confirmations: [exact] }).confirmed,
      false,
    );
  }
  assert.throws(() => decide([], 'unknown'), /BOSS_JOB_EVIDENCE_PROJECTION_INVALID/);
});
