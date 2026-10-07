import assert from 'node:assert/strict';
import test from 'node:test';
import { bossJobDetailsConfirmation, resolveBossJobDetails } from '../dist/boss-observations.js';
import { applyBossBatch, bindBossAccount } from '../dist/boss-integration.js';
import { emptyData } from '../dist/model.js';
import { stableHash } from '../scripts/boss-integration.mjs';
import { bossApplicationId, bossFactId } from '../dist/source-identity.js';

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

test('web confirmation reuses strict ordinary resolution without changing manual fields or evidence', () => {
  for (const externalId of [JOB_ID, '']) {
    const { data } = fixture({ externalId });
    const original = structuredClone(data);
    const preview = bossJobDetailsConfirmation(
      data,
      data.sourceApplications.map((row) => row.id),
      SOURCE_ID,
    );
    assert.equal(preview.allowed, true);
    assert.deepEqual(preview.target, {
      opportunityId: 'target',
      company: '人工用人公司',
      role: '人工岗位',
    });
    assert.equal(preview.externalJobId, JOB_ID);
    assert.equal(preview.canonicalUrl, JOB_URL);
    assert.equal(preview.messageCount, 1);
    assert.equal(preview.observationCount, 1);
    assert.deepEqual(data, original);
    const result = resolveBossJobDetails(data, {
      applicationIds: preview.applicationIds,
      opportunityId: preview.target.opportunityId,
      externalJobId: preview.externalJobId,
      canonicalUrl: preview.canonicalUrl,
      workspaceSourceId: SOURCE_ID,
      stamp: STAMP,
    });
    assert.equal(result.sourceApplications[0].reason, 'user_confirmed_job_details');
    assert.equal(result.opportunities[0].resumeState, '已发送');
    assert.equal(result.opportunities[0].stage, '面试中');
    assert.deepEqual(result.sourceEvents, original.sourceEvents);
  }
});

test('ordinary company identity review is eligible without weakening resume attribution checks', () => {
  const { data, options } = fixture();
  data.sourceApplications[0].status = 'review';
  data.sourceApplications[0].reason = 'identity_conflict';
  const preview = bossJobDetailsConfirmation(data, options.applicationIds, SOURCE_ID);
  assert.equal(preview.allowed, true);
  assert.equal(preview.observationCount, 1);
  assert.equal(resolveBossJobDetails(data, options).sourceApplications[0].status, 'no_effect');
  data.sourceApplications[0].reason = 'attribution_message_multiple_jobs';
  assert.equal(bossJobDetailsConfirmation(data, options.applicationIds, SOURCE_ID).allowed, false);
});

function addObservation(data, { factType = 'message_receipt_delivered', ...overrides } = {}) {
  const event = {
    ...data.sourceEvents[0],
    id: `boss-event-${stableHash({ factType, ...overrides })}`,
    factType,
    ...overrides,
  };
  event.factId = bossFactId(event);
  delete event.factType;
  const fact = { ...data.sourceFacts[0], factType, id: event.factId };
  for (const key of ['accountNamespace', 'conversationKey', 'messageId', 'externalJobId'])
    if (Object.hasOwn(overrides, key)) fact[key] = overrides[key];
  const application = {
    ...data.sourceApplications[0],
    id: bossApplicationId(fact.id),
    factId: fact.id,
  };
  data.sourceEvents.push(event);
  data.sourceFacts.push(fact);
  data.sourceApplications.push(application);
  return application;
}

test('mixed message group confirms ordinary data only and preserves resume review', () => {
  const { data } = fixture();
  const receipt = addObservation(data, {
    messageDirection: 'outbound',
    receiptStatus: 'delivered',
    receiptSource: 'list_receipt_label',
  });
  const resume = addObservation(data, {
    factType: 'resume_attachment_sent',
    eventType: 'resume_observed',
    summary: 'resume_attachment_sent',
    messageDirection: 'outbound',
    receiptStatus: 'not_applicable',
  });
  resume.reason = 'attribution_evidence_missing';
  const original = structuredClone(data);
  const preview = bossJobDetailsConfirmation(
    data,
    data.sourceApplications.map((row) => row.id),
    SOURCE_ID,
  );
  assert.equal(preview.allowed, true);
  assert.deepEqual(preview.applicationIds, [data.sourceApplications[0].id, receipt.id]);
  assert.deepEqual(preview.excludedApplicationIds, [resume.id]);
  assert.equal(preview.messageCount, 1);
  assert.equal(preview.observationCount, 2);
  assert.deepEqual(data, original);
  const resolved = resolveBossJobDetails(data, {
    applicationIds: preview.applicationIds,
    opportunityId: preview.target.opportunityId,
    externalJobId: preview.externalJobId,
    canonicalUrl: preview.canonicalUrl,
    workspaceSourceId: SOURCE_ID,
    stamp: STAMP,
  });
  assert.equal(resolved.sourceApplications[0].reason, 'user_confirmed_job_details');
  assert.equal(resolved.sourceApplications[1].reason, 'user_confirmed_job_details');
  assert.deepEqual(resolved.sourceApplications[2], original.sourceApplications[2]);
});

test('multiple messages are counted separately and a cross-account batch cannot be confirmed', () => {
  const { data } = fixture();
  addObservation(data, { factType: 'message_observed', messageId: 'message-2' });
  const ids = data.sourceApplications.map((row) => row.id);
  const preview = bossJobDetailsConfirmation(data, ids, SOURCE_ID);
  assert.equal(preview.allowed, true);
  assert.equal(preview.messageCount, 2);
  assert.equal(preview.observationCount, 2);
  addObservation(data, {
    factType: 'message_observed',
    accountNamespace: OTHER_ACCOUNT,
    messageId: 'message-1',
  });
  assert.equal(
    bossJobDetailsConfirmation(
      data,
      data.sourceApplications.map((row) => row.id),
      SOURCE_ID,
    ).reasonCode,
    'account_conflict',
  );
});

test('web confirmation blocks duplicate/deleted targets and company-only suggestions with clear reasons', () => {
  for (const [change, reasonCode] of [
    [(data) => (data.opportunities[0].deletedAt = OBSERVED), 'deleted_match'],
    [(data) => retired(data), 'deleted_match'],
    [(data) => retired(data, 'live-copy', { deletedAt: '' }), 'multiple_targets'],
    [(data) => (data.opportunities = []), 'target_missing'],
    [(data) => Object.assign(data.opportunities[0], { externalId: '', url: '' }), 'target_missing'],
    [(data) => (data.opportunities[0].externalId = 'different-job'), 'target_identity_conflict'],
  ]) {
    const { data, options } = fixture();
    change(data);
    const original = structuredClone(data);
    const preview = bossJobDetailsConfirmation(data, options.applicationIds, SOURCE_ID);
    assert.equal(preview.allowed, false);
    assert.equal(preview.reasonCode, reasonCode);
    assert.ok(preview.reason);
    assert.deepEqual(data, original);
  }
});

test('web confirmation blocks foreign ownership, conflicting bindings and inconsistent observed links', () => {
  for (const [change, reasonCode] of [
    [(data) => (data.sourceBindings[0].workspaceSourceId = 'other-workspace'), 'account_unbound'],
    [
      (data) =>
        data.sourceBindings.push({
          kind: 'opportunity',
          platform: 'boss',
          accountNamespace: OTHER_ACCOUNT,
          opportunityId: 'target',
          externalJobId: JOB_ID,
          canonicalUrl: JOB_URL,
        }),
      'binding_conflict',
    ],
    [
      (data) =>
        (data.sourceEvents[0].canonicalUrl =
          'https://www.zhipin.com/job_detail/different-job.html'),
      'identity_conflict',
    ],
    [(data) => (data.sourceEvents[0].canonicalUrl = ''), 'identity_missing'],
  ]) {
    const { data, options } = fixture();
    change(data);
    const preview = bossJobDetailsConfirmation(data, options.applicationIds, SOURCE_ID);
    assert.equal(preview.allowed, false);
    assert.equal(preview.reasonCode, reasonCode);
  }
});

test('web confirmation allows a matching binding and refuses multiple bindings', () => {
  const { data, options } = fixture();
  const binding = {
    kind: 'opportunity',
    platform: 'boss',
    accountNamespace: ACCOUNT,
    opportunityId: 'target',
    externalJobId: JOB_ID,
    canonicalUrl: JOB_URL,
  };
  data.sourceBindings.push(binding);
  assert.equal(bossJobDetailsConfirmation(data, options.applicationIds, SOURCE_ID).allowed, true);
  data.sourceBindings.push({ ...binding });
  assert.equal(
    bossJobDetailsConfirmation(data, options.applicationIds, SOURCE_ID).reasonCode,
    'binding_conflict',
  );
});

test('web confirmation refuses resume, attribution conflicts, ignored and completed observations', () => {
  for (const change of [
    (data) => (data.sourceEvents[0].eventType = 'resume_observed'),
    (data) => (data.sourceApplications[0].reason = 'attribution_message_multiple_jobs'),
    (data) => (data.sourceApplications[0].status = 'applied'),
    (data) => (data.sourceApplications[0].status = 'protected'),
    (data) => (data.sourceApplications[0].reason = 'user_ignored_unresolved_observation'),
  ]) {
    const { data, options } = fixture();
    change(data);
    const preview = bossJobDetailsConfirmation(data, options.applicationIds, SOURCE_ID);
    assert.equal(preview.allowed, false);
    assert.equal(preview.reasonCode, 'unsupported');
    assert.equal(preview.observationCount, 0);
  }
});

test('same-account cross-job evidence blocks preview; another account message does not', () => {
  for (const accountNamespace of [ACCOUNT, OTHER_ACCOUNT]) {
    const { data, options } = fixture();
    data.sourceEvents.push({
      ...data.sourceEvents[0],
      id: 'synthetic-cross-job-event',
      accountNamespace,
      externalJobId: 'different-job',
      canonicalUrl: 'https://www.zhipin.com/job_detail/different-job.html',
      factId: 'not-selected',
    });
    const preview = bossJobDetailsConfirmation(data, options.applicationIds, SOURCE_ID);
    assert.equal(preview.allowed, accountNamespace !== ACCOUNT);
    if (accountNamespace === ACCOUNT) assert.equal(preview.reasonCode, 'observation_conflict');
  }
});

test('preview requires still-present sources and does not accept empty or duplicate selection', () => {
  const { data, options } = fixture();
  for (const applicationIds of [
    [],
    ['missing-id'],
    [...options.applicationIds, ...options.applicationIds],
  ]) {
    assert.equal(bossJobDetailsConfirmation(data, applicationIds, SOURCE_ID).reasonCode, 'changed');
  }
  data.sourceEvents[0].deletedAt = OBSERVED;
  assert.equal(
    bossJobDetailsConfirmation(data, options.applicationIds, SOURCE_ID).reasonCode,
    'changed',
  );
});
