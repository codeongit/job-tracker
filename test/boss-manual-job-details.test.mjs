import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBossJobDetails } from '../dist/boss-observations.js';
import { applyBossBatch, bindBossAccount } from '../dist/boss-integration.js';
import { emptyData } from '../dist/model.js';
import { stableHash } from '../scripts/boss-integration.mjs';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const OTHER_ACCOUNT = `boss-geek:${'b'.repeat(64)}`;
const SOURCE_ID = '00000000-0000-4000-8000-000000000001';
const OBSERVED = '2026-10-05T01:00:00.000Z';
const STAMP = '2026-10-06T01:00:00.000Z';
const JOB_ID = 'syntheticJob~';
const JOB_URL = `https://www.zhipin.com/job_detail/${JOB_ID}.html`;

function fixture({ externalId = JOB_ID } = {}) {
  const facts = {
    platform: 'boss',
    accountNamespace: ACCOUNT,
    conversationKey: '1'.repeat(64),
    friendId: 'friend-1',
    friendSource: 'source-1',
    uniqueId: 'friend-1-source-1',
    externalJobId: JOB_ID,
    canonicalUrl: JOB_URL,
    jobName: '',
    company: '合成招聘方',
    contact: '合成联系人',
    summary: '合成普通消息',
    messageId: 'message-1',
    messageDirection: 'unknown',
    receiptStatus: 'unknown',
    receiptSource: '',
    nameSource: '',
    linkConfirmation: 'unverified',
    intent: 'review',
  };
  const event = {
    eventId: `boss-event-${stableHash(facts)}`,
    ...Object.fromEntries(
      Object.entries(facts).filter(([key]) => !['platform', 'accountNamespace'].includes(key)),
    ),
    timeLabel: '',
    observedAt: OBSERVED,
    evidenceDate: '',
    appliedAtForNew: '',
    sourceSequence: 1,
  };
  const delivery = {
    format: 'job-tracker-boss-batch',
    version: 1,
    batchId: `boss-batch-${stableHash({
      policy: 'boss-manual-check-v1',
      snapshotSha256: 'c'.repeat(64),
      accountNamespace: ACCOUNT,
      eventIds: [event.eventId],
    })}`,
    platform: 'boss',
    accountNamespace: ACCOUNT,
    sourceSequence: 1,
    policy: {
      id: 'boss-manual-check-v1',
      mode: 'incremental',
      timezone: 'Asia/Shanghai',
      appliedAtForNew: '',
      autoCreateComplete: true,
    },
    source: {
      snapshotName: 'synthetic.json',
      snapshotSha256: 'c'.repeat(64),
      capturedAt: OBSERVED,
    },
    coverage: {
      loadedRows: 1,
      loadedDataRows: 1,
      renderedRows: 1,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
    events: [event],
  };
  const data = applyBossBatch(
    bindBossAccount(emptyData(), ACCOUNT, SOURCE_ID, OBSERVED),
    delivery,
    {
      workspaceSourceId: SOURCE_ID,
      stamp: OBSERVED,
    },
  ).data;
  assert.equal(data.sourceApplications[0].status, 'waiting');
  data.opportunities.push({
    id: 'target',
    company: '人工用人公司',
    role: '人工岗位',
    platform: 'BOSS',
    externalId,
    url: JOB_URL,
    stage: '面试中',
    resumeState: '已发送',
    readState: '已读',
    createdAt: OBSERVED,
    updatedAt: OBSERVED,
  });
  return {
    data,
    delivery,
    options: {
      applicationIds: data.sourceApplications.map((row) => row.id),
      opportunityId: 'target',
      externalJobId: JOB_ID,
      canonicalUrl: JOB_URL,
      workspaceSourceId: SOURCE_ID,
      stamp: STAMP,
    },
  };
}

function retired(data, id = 'deleted-copy', overrides = {}) {
  const row = { ...data.opportunities[0], id, deletedAt: OBSERVED, ...overrides };
  data.opportunities.push(row);
  return row;
}

function rejectsWithoutMutation(data, options) {
  const original = structuredClone(data);
  assert.throws(() => resolveBossJobDetails(data, options), { code: 'BOSS_DETAILS_UNSAFE' });
  assert.deepEqual(data, original);
}

test('explicit ordinary resolution repairs only a missing ID proven by the target URL', () => {
  const { data, delivery, options } = fixture({ externalId: '' });
  const original = structuredClone(data);
  const result = resolveBossJobDetails(data, options);
  assert.deepEqual(data, original);
  assert.deepEqual(result.opportunities[0], {
    ...original.opportunities[0],
    externalId: JOB_ID,
    updatedAt: STAMP,
  });
  assert.deepEqual(result.sourceEvents, original.sourceEvents);
  assert.deepEqual(result.sourceFacts, original.sourceFacts);
  assert.deepEqual(result.sourceBindings, original.sourceBindings);
  assert.equal(result.sourceApplications[0].status, 'no_effect');
  assert.equal(result.sourceApplications[0].reason, 'user_confirmed_job_details');
  assert.equal(result.sourceApplications[0].resolutionSource, 'user');
  assert.equal(result.sourceApplications[0].resolvedJobId, JOB_ID);
  assert.equal(result.sourceApplications[0].resolvedJobUrl, JOB_URL);
  assert.deepEqual(
    applyBossBatch(result, delivery, { workspaceSourceId: SOURCE_ID, stamp: STAMP }).data,
    result,
  );
});

test('an already complete target keeps its timestamp and all manually maintained fields', () => {
  const { data, options } = fixture();
  const result = resolveBossJobDetails(data, options);
  assert.deepEqual(result.opportunities, data.opportunities);
});

test('deleted matching duplicates block by default and explicit complete designation preserves tombstones', () => {
  const { data, options } = fixture({ externalId: '' });
  retired(data);
  retired(data, 'deleted-copy-2', { externalId: '' });
  rejectsWithoutMutation(data, options);
  const original = structuredClone(data);
  const result = resolveBossJobDetails(data, {
    ...options,
    retiredOpportunityIds: ['deleted-copy-2', 'deleted-copy'],
  });
  assert.deepEqual(data, original);
  assert.deepEqual(result.opportunities.slice(1), original.opportunities.slice(1));
  assert.equal(result.opportunities[0].externalId, JOB_ID);
  assert.equal(result.sourceApplications[0].status, 'no_effect');
});

test('retired designation rejects incomplete, extra, duplicate and non-list IDs', () => {
  const { data, options } = fixture();
  retired(data);
  retired(data, 'deleted-copy-2');
  for (const retiredOpportunityIds of [
    ['deleted-copy'],
    ['deleted-copy', 'deleted-copy-2', 'unknown'],
    ['deleted-copy', 'deleted-copy'],
    ['deleted-copy', ''],
    'deleted-copy',
  ]) {
    rejectsWithoutMutation(data, { ...options, retiredOpportunityIds });
  }
});

test('live duplicate or deleted target cannot be bypassed through explicit designation', () => {
  const { data, options } = fixture();
  retired(data, 'live-copy', { deletedAt: '' });
  rejectsWithoutMutation(data, { ...options, retiredOpportunityIds: ['live-copy'] });
  const deletedTarget = fixture();
  deletedTarget.data.opportunities[0].deletedAt = OBSERVED;
  rejectsWithoutMutation(deletedTarget.data, deletedTarget.options);
});

test('retired duplicate must have the same canonical URL, compatible ID and BOSS platform', () => {
  for (const overrides of [
    { externalId: 'different-job' },
    { url: 'https://www.zhipin.com/job_detail/different-job.html' },
    { platform: '其他平台' },
  ]) {
    const { data, options } = fixture();
    retired(data, 'deleted-copy', overrides);
    rejectsWithoutMutation(data, { ...options, retiredOpportunityIds: ['deleted-copy'] });
  }
});

test('conflicting target ID or URL cannot be repaired as missing metadata', () => {
  for (const overrides of [
    { externalId: 'different-job' },
    { externalId: '', url: 'https://www.zhipin.com/job_detail/different-job.html' },
    { platform: '其他平台' },
  ]) {
    const { data, options } = fixture({ externalId: '' });
    Object.assign(data.opportunities[0], overrides);
    rejectsWithoutMutation(data, options);
  }
});

test('live bindings to a retired target remain unsafe even from another account', () => {
  for (const accountNamespace of [ACCOUNT, OTHER_ACCOUNT]) {
    const { data, options } = fixture();
    retired(data);
    data.sourceBindings.push({
      id: `boss-job-${accountNamespace.slice('boss-geek:'.length)}-${encodeURIComponent(JOB_ID)}`,
      kind: 'opportunity',
      platform: 'boss',
      accountNamespace,
      opportunityId: 'deleted-copy',
      externalJobId: JOB_ID,
      canonicalUrl: JOB_URL,
      createdAt: OBSERVED,
    });
    rejectsWithoutMutation(data, { ...options, retiredOpportunityIds: ['deleted-copy'] });
  }
});

test('human resolution still rejects resume, attribution conflicts and prior manual decisions', () => {
  for (const change of [
    (data) => {
      data.sourceEvents[0].eventType = 'resume_observed';
    },
    (data) => {
      data.sourceApplications[0].reason = 'attribution_message_multiple_jobs';
    },
    (data) => {
      data.sourceApplications[0].status = 'protected';
    },
    (data) => {
      data.sourceApplications[0].status = 'applied';
    },
    (data) => {
      data.sourceEvents[0].externalJobId = 'different-job';
    },
  ]) {
    const { data, options } = fixture({ externalId: '' });
    change(data);
    rejectsWithoutMutation(data, options);
  }
});

test('foreign workspace ownership or target account binding cannot be bypassed', () => {
  const { data, options } = fixture({ externalId: '' });
  rejectsWithoutMutation(data, {
    ...options,
    workspaceSourceId: '00000000-0000-4000-8000-000000000002',
  });
  data.sourceBindings.push({
    id: `boss-job-${OTHER_ACCOUNT.slice('boss-geek:'.length)}-${encodeURIComponent(JOB_ID)}`,
    kind: 'opportunity',
    platform: 'boss',
    accountNamespace: OTHER_ACCOUNT,
    opportunityId: 'target',
    externalJobId: JOB_ID,
    canonicalUrl: JOB_URL,
    createdAt: OBSERVED,
  });
  rejectsWithoutMutation(data, options);
});

test('same-account cross-job message evidence blocks resolution before repairing the target', () => {
  const { data, options } = fixture({ externalId: '' });
  data.sourceEvents.push({
    ...data.sourceEvents[0],
    id: 'synthetic-conflicting-event',
    externalJobId: 'different-job',
    canonicalUrl: 'https://www.zhipin.com/job_detail/different-job.html',
  });
  rejectsWithoutMutation(data, options);
});

test('a later failing selected observation cannot partially resolve an earlier selected observation', () => {
  const { data, options } = fixture({ externalId: '' });
  const application = data.sourceApplications[0];
  data.sourceApplications.push({
    ...application,
    id: 'synthetic-second-application',
    factId: 'synthetic-second-fact',
    reason: 'attribution_evidence_missing',
  });
  data.sourceFacts.push({ ...data.sourceFacts[0], id: 'synthetic-second-fact' });
  data.sourceEvents.push({
    ...data.sourceEvents[0],
    id: 'synthetic-second-event',
    factId: 'synthetic-second-fact',
  });
  rejectsWithoutMutation(data, {
    ...options,
    applicationIds: [...options.applicationIds, 'synthetic-second-application'],
  });
});
