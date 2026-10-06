import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareLoadedSnapshotsV2,
  conversationKeyV2,
  applyDetailEvidenceV2,
} from '../collector/boss/model-v2.mjs';
import { toResumeHistoryResult, applyResumeHistoryV2 } from '../collector/boss/resume-history.mjs';
import {
  createBatch,
  createEvents,
  createResumeEvents,
  createIncrementalBatch,
  resolveJobRows,
} from '../scripts/boss-conversion.mjs';
import { validateTrackerEnvelope } from '../scripts/boss-integration.mjs';
import { validateBossBatch } from '../scripts/boss-inbox.mjs';
import { validateBossBatch as validateSharedBatch } from '../dist/boss-batch.js';
import { emptyData } from '../dist/model.js';
import {
  applyBossBatch,
  bindBossAccount,
  ignoreBossObservations,
} from '../dist/boss-integration.js';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const OTHER_ACCOUNT = `boss-geek:${'b'.repeat(64)}`;
const SOURCE_ID = '00000000-0000-4000-8000-000000000001';
const FIRST = '2026-09-18T08:00:00.000Z';
const CAPTURE = '2026-09-20T08:00:00.000Z';
const DETAIL = '2026-10-06T08:00:00.000Z';
const url = (id) => `https://www.zhipin.com/job_detail/${id}.html`;

function record(friendId) {
  return {
    key: conversationKeyV2(ACCOUNT, friendId, '0'),
    platformIdentity: { friendId, friendSource: '0', uniqueId: `${friendId}-0` },
    contact: '合成招聘者',
    company: '合成公司',
    title: '合成联系人',
    preview: '合成旧消息',
    timeLabel: '14:00',
    unread: null,
    latestMessageId: `${friendId}001`,
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: { jobId: `job_${friendId}`, detailUrl: url(`job_${friendId}`) },
    observedJobName: null,
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
  const retained = record('1'),
    loaded = record('2');
  const initial = compareLoadedSnapshotsV2(null, snapshot([retained, loaded], FIRST)).envelope;
  let envelope = compareLoadedSnapshotsV2(initial, snapshot([loaded], CAPTURE)).envelope;
  const resume = toResumeHistoryResult(
    {
      ok: true,
      url: 'https://www.zhipin.com/web/geek/chat',
      capturedAt: CAPTURE,
      observations: [
        {
          conversationKey: retained.key,
          friendId: '1',
          friendSource: '0',
          messageId: '9001',
          direction: 'outbound',
          messageType: 4,
          kind: 'sent_candidate',
          platformTime: FIRST,
          externalJobId: 'job_1',
          source: 'geek_history_type_4',
        },
      ],
      unresolved: [],
      coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 1 },
    },
    envelope,
  );
  envelope = applyResumeHistoryV2(envelope, resume).envelope;
  const withDetails = applyDetailEvidenceV2(
    envelope,
    {
      observations: [
        {
          conversationKey: retained.key,
          jobId: 'job_1',
          detailUrl: url('job_1'),
          name: '合成岗位',
          company: '合成公司',
          title: '「合成岗位招聘」_合成公司招聘-BOSS直聘',
          source: 'detail_page_title',
          observedAt: DETAIL,
        },
      ],
      candidates: [],
    },
    DETAIL,
  ).envelope;
  return { initial, envelope, withDetails, retained, loaded };
}
const reference = (envelope, digit) => ({
  path: `synthetic-${digit}.json`,
  sha256: digit.repeat(64),
  envelope,
});
const options = { workspaceSourceId: SOURCE_ID, stamp: DETAIL };

test('retained current conversation with exact real detail evidence enters the incremental delivery', () => {
  const { envelope, withDetails, retained } = fixture();
  assert.equal(resolveJobRows(withDetails).length, 1);
  const rows = resolveJobRows(withDetails, { includeRetainedDetails: true });
  assert.equal(rows.length, 2);
  const batch = createIncrementalBatch(reference(envelope, 'a'), reference(withDetails, 'b'), 2);
  assert.ok(batch);
  assert.equal(batch.events.length, 1);
  const event = batch.events[0];
  assert.equal(event.conversationKey, retained.key);
  assert.equal(event.observedAt, FIRST);
  assert.equal(event.timeLabel, '');
  assert.equal(event.evidenceDate, '');
  assert.equal(event.appliedAtForNew, '');
  assert.equal(batch.source.capturedAt, CAPTURE);
  assert.deepEqual(event.jobDetails, {
    jobId: 'job_1',
    canonicalUrl: url('job_1'),
    jobName: '合成岗位',
    company: '合成公司',
    source: 'detail_page_title',
  });
  validateBossBatch(batch);
  validateSharedBatch(batch);
  validateTrackerEnvelope(withDetails);
  assert.equal(
    createIncrementalBatch(reference(withDetails, 'b'), reference(withDetails, 'c'), 3),
    null,
  );
});

test('retained delivery preserves loaded ordinary IDs, old resume IDs and capture/message state', () => {
  const { envelope, withDetails } = fixture();
  assert.deepEqual(
    createEvents(withDetails, { sourceSequence: 2 }),
    createEvents(envelope, { sourceSequence: 2 }),
  );
  assert.deepEqual(
    createResumeEvents(withDetails, { sourceSequence: 2 }),
    createResumeEvents(envelope, { sourceSequence: 2 }),
  );
  assert.deepEqual(withDetails.snapshot, envelope.snapshot);
  assert.deepEqual(withDetails.state, envelope.state);
  assert.deepEqual(withDetails.resume, envelope.resume);
});

test('missing, non-title, contradictory job or account evidence never supplements retained state', () => {
  const { envelope, withDetails } = fixture();
  assert.equal(resolveJobRows(envelope, { includeRetainedDetails: true }).length, 1);
  const changes = [
    (copy) => {
      copy.jobs.evidence[0].source = 'legacy_named_job';
    },
    (copy) => {
      copy.jobs.evidence[0].title = '合成岗位';
    },
    (copy) => {
      copy.jobs.evidence[0].detailUrl = url('another_job');
    },
    (copy) => {
      copy.jobs.evidence.push({
        ...copy.jobs.evidence[0],
        name: '矛盾岗位',
        title: '「矛盾岗位招聘」_合成公司招聘-BOSS直聘',
      });
    },
    (copy) => {
      copy.accountNamespace = OTHER_ACCOUNT;
    },
    (copy) => {
      copy.jobs.associations[0].status = 'historical';
    },
  ];
  for (const change of changes) {
    const copy = structuredClone(withDetails);
    change(copy);
    assert.equal(resolveJobRows(copy, { includeRetainedDetails: true }).length, 1);
  }
});

test('retained detail delivery uses the existing shared consumer and preserves manual fields', () => {
  const { envelope, withDetails } = fixture();
  const batch = createIncrementalBatch(reference(envelope, 'a'), reference(withDetails, 'b'), 2);
  assert.ok(batch);
  const bound = bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, DETAIL);
  const applied = applyBossBatch(bound, batch, options).data;
  assert.equal(applied.opportunities.length, 1);
  assert.equal(applied.opportunities[0].role, '合成岗位');
  assert.equal(applied.opportunities[0].appliedAt, '');
  const manual = structuredClone(bound);
  manual.opportunities.push({
    id: 'manual',
    company: '人工公司',
    role: '人工岗位',
    platform: 'BOSS',
    externalId: 'job_1',
    url: url('job_1'),
    stage: '面试中',
    resumeState: '未知',
  });
  const protectedResult = applyBossBatch(manual, batch, options).data;
  assert.deepEqual(protectedResult.opportunities, manual.opportunities);
});

test('retained verified employer details may differ from the recruiter without rewriting the chat', () => {
  const { envelope, retained } = fixture();
  const withEmployer = applyDetailEvidenceV2(
    envelope,
    {
      observations: [
        {
          conversationKey: retained.key,
          jobId: 'job_1',
          detailUrl: url('job_1'),
          name: '实际岗位',
          company: '实际用人公司',
          title: '「实际岗位招聘」_实际用人公司招聘-BOSS直聘',
          source: 'detail_page_title',
          observedAt: DETAIL,
        },
      ],
      candidates: [],
    },
    DETAIL,
  ).envelope;
  const batch = createIncrementalBatch(reference(envelope, 'a'), reference(withEmployer, 'b'), 2);
  assert.ok(batch);
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].company, '合成公司');
  assert.equal(batch.events[0].jobDetails.company, '实际用人公司');
  const applied = applyBossBatch(
    bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, DETAIL),
    batch,
    options,
  ).data;
  assert.equal(applied.opportunities[0].company, '实际用人公司');
  assert.equal(applied.opportunities[0].role, '实际岗位');
  assert.equal(applied.sourceEvents[0].company, '合成公司');
  assert.deepEqual(withEmployer.state, envelope.state);
});

test('detail delivery ranks the employer title first while preserving legacy loaded and resume facts', () => {
  const { envelope, retained, loaded } = fixture();
  const loadedEnvelope = compareLoadedSnapshotsV2(
    envelope,
    snapshot([{ ...retained, observedJobName: '列表岗位' }, loaded], CAPTURE),
  ).envelope;
  const withDetails = applyDetailEvidenceV2(
    loadedEnvelope,
    {
      observations: [
        {
          conversationKey: retained.key,
          jobId: 'job_1',
          detailUrl: url('job_1'),
          name: '实际岗位',
          company: '实际用人公司',
          title: '「实际岗位招聘」_实际用人公司招聘-BOSS直聘',
          source: 'detail_page_title',
          observedAt: DETAIL,
        },
      ],
      candidates: [],
    },
    DETAIL,
  ).envelope;
  const modern = resolveJobRows(withDetails, { includeRetainedDetails: true }).find(
    (row) => row.record.key === retained.key,
  );
  assert.equal(modern.jobName, '实际岗位');
  assert.equal(modern.nameSource, 'detail_page_title');
  assert.equal(modern.nameConflict, false);
  assert.equal(modern.jobDetails.company, '实际用人公司');
  const legacy = createEvents(withDetails, { sourceSequence: 2 }).find(
    (event) => event.conversationKey === retained.key,
  );
  assert.equal(legacy.jobName, '列表岗位');
  assert.equal(legacy.nameSource, 'loaded_jobName');
  assert.equal(legacy.intent, 'review');
  assert.deepEqual(
    createResumeEvents(withDetails, { sourceSequence: 2 }),
    createResumeEvents(loadedEnvelope, { sourceSequence: 2 }),
  );
  const conflicting = structuredClone(withDetails);
  const original = conflicting.jobs.evidence.find((item) => item.source === 'detail_page_title');
  conflicting.jobs.evidence.push({
    ...original,
    name: '矛盾岗位',
    title: '「矛盾岗位招聘」_实际用人公司招聘-BOSS直聘',
  });
  const unresolved = resolveJobRows(conflicting, { includeRetainedDetails: true }).find(
    (row) => row.record.key === retained.key,
  );
  assert.equal(unresolved.jobName, '');
  assert.equal(unresolved.nameConflict, true);
  assert.equal(unresolved.jobDetails.source, 'detail_page_conflict');
});

test('retained evidence compares normalized semantics without discarding actual titles', () => {
  const { withDetails } = fixture();
  const copy = structuredClone(withDetails);
  const original = copy.jobs.evidence.find((item) => item.source === 'detail_page_title');
  Object.assign(original, {
    name: 'Café 开发',
    company: '合成 公司',
    title: '「Café 开发招聘」_合成 公司招聘-BOSS直聘',
  });
  copy.jobs.evidence.push({
    ...original,
    name: 'Cafe\u0301  开发',
    company: '合成  公司',
    title: 'Cafe\u0301  开发怎么样_合成  公司2026年Cafe\u0301  开发前景怎么样-BOSS直聘',
    observedAt: '2026-10-06T09:00:00.000Z',
  });
  const before = structuredClone(copy.jobs.evidence);
  const rows = resolveJobRows(copy, { includeRetainedDetails: true });
  assert.equal(rows.length, 2);
  const row = rows.find((item) => item.externalJobId === 'job_1');
  assert.equal(row.nameConflict, false);
  assert.equal(row.jobDetails.source, 'detail_page_title');
  assert.deepEqual(copy.jobs.evidence, before);
});

test('new retained detail material does not reactivate an ignored ordinary fact', () => {
  const { initial, envelope, withDetails, retained } = fixture();
  const original = createEvents(initial, { sourceSequence: 1 })
    .filter((event) => event.conversationKey === retained.key)
    .map((event) => ({ ...event, timeLabel: '' }));
  const initialBatch = createBatch({
    envelope: initial,
    snapshotName: 'synthetic-a.json',
    snapshotSha256: 'a'.repeat(64),
    sourceSequence: 1,
    policy: {
      id: 'boss-manual-check-v1',
      mode: 'incremental',
      timezone: 'Asia/Shanghai',
      appliedAtForNew: '',
      autoCreateComplete: true,
    },
    events: original,
  });
  const bound = bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, DETAIL);
  const waiting = applyBossBatch(bound, initialBatch, options).data;
  const ignored = ignoreBossObservations(waiting, {
    applicationIds: [waiting.sourceApplications[0].id],
    ...options,
  });
  const next = createIncrementalBatch(reference(envelope, 'a'), reference(withDetails, 'b'), 2);
  assert.ok(next);
  const after = applyBossBatch(ignored, next, options).data;
  assert.deepEqual(after.sourceApplications, ignored.sourceApplications);
  assert.deepEqual(after.opportunities, ignored.opportunities);
});
