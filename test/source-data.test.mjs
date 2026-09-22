import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  SOURCE_AUTO_FIELDS,
  clone,
  emptyData,
  equal,
  mergeData,
  serialize,
  validateData,
} from '../dist/model.js';
import {
  createBackup,
  initialWorkspace,
  migrateData,
  migrateWorkspace,
  parseBackup,
  restoreWorkspace,
} from '../dist/workspace.js';
import { encodeUtf8, githubClient } from '../dist/github.js';
import { localSshClient } from '../dist/local-ssh.js';
import { GitStore } from '../scripts/ssh-store.mjs';
import { bossFactId, bossFactType, sha256Hex } from '../dist/source-identity.js';
import {
  effectiveSourceFacts,
  sourceReviewCounts,
  upgradeSourceLedger,
} from '../dist/source-ledger.js';

const STAMP = '2026-09-18T12:00:00.000Z';
const ACCOUNT_HASH = 'a'.repeat(64);
const ACCOUNT_NAMESPACE = `boss-geek:${ACCOUNT_HASH}`;
const EVENT_ID = `boss-event-${'b'.repeat(64)}`;
const BATCH_ID = `boss-batch-${'c'.repeat(64)}`;
const SNAPSHOT = `synthetic.json#sha256:${'d'.repeat(64)}`;
const job = (more = {}) => ({
  id: 'synthetic-opportunity',
  company: '合成公司',
  role: '合成岗位',
  stage: '已触达',
  ...more,
});
const accountBinding = (more = {}) => ({
  id: `boss-account-${ACCOUNT_HASH}`,
  kind: 'account',
  platform: 'boss',
  accountNamespace: ACCOUNT_NAMESPACE,
  workspaceSourceId: '00000000-0000-4000-8000-000000000001',
  createdAt: STAMP,
  ...more,
});
const opportunityBinding = (more = {}) => ({
  id: `boss-job-${ACCOUNT_HASH}-synthetic-job-id`,
  kind: 'opportunity',
  platform: 'boss',
  accountNamespace: ACCOUNT_NAMESPACE,
  externalJobId: 'synthetic-job-id',
  canonicalUrl: 'https://www.zhipin.com/job_detail/synthetic-job-id.html',
  opportunityId: 'synthetic-opportunity',
  autoFields: SOURCE_AUTO_FIELDS.join(','),
  lastAutoCompany: '合成公司',
  lastAutoRole: '合成岗位',
  lastAutoUrl: 'https://www.zhipin.com/job_detail/synthetic-job-id.html',
  lastAutoContact: '合成招聘者',
  lastAutoPlatform: 'BOSS',
  lastAutoExternalId: 'synthetic-job-id',
  createdAt: STAMP,
  ...more,
});
const sourceEvent = (more = {}) => {
  const value = {
    id: EVENT_ID,
    batchId: BATCH_ID,
    platform: 'boss',
    accountNamespace: ACCOUNT_NAMESPACE,
    conversationKey: 'a'.repeat(64),
    friendId: 'friend-1',
    friendSource: 'source-1',
    uniqueId: 'friend-1-source-1',
    externalJobId: 'synthetic-job-id',
    opportunityId: 'synthetic-opportunity',
    eventType: 'conversation_observed',
    messageId: 'message-1',
    messageDirection: 'outbound',
    receiptStatus: 'delivered',
    receiptSource: 'list_receipt_label',
    summary: '合成摘要，不含真实招聘信息',
    timeLabel: '14:18',
    contact: '合成招聘者',
    company: '合成公司',
    jobName: '合成岗位',
    nameSource: 'loaded_jobName',
    canonicalUrl: 'https://www.zhipin.com/job_detail/synthetic-job-id.html',
    linkConfirmation: 'unverified',
    observedAt: '2026-09-18T06:18:00.000Z',
    evidenceDate: '2026-09-18',
    appliedAtSource: 'user_confirmed_initial_contact_date',
    sourceSnapshot: SNAPSHOT,
    sourceSequence: '1',
    status: 'recorded',
    importPolicy: 'boss-initial-2026-09-18-v1',
    createdAt: STAMP,
    ...more,
  };
  value.factId = more.factId ?? (value.messageId ? bossFactId(value) : '');
  return value;
};
function sourceData(event = sourceEvent()) {
  const data = emptyData();
  data.opportunities.push(job());
  data.sourceBindings.push(accountBinding(), opportunityBinding());
  data.sourceEvents.push(event);
  return upgradeSourceLedger(data);
}
function asV1(input) {
  const data = clone(input);
  data.schemaVersion = 1;
  delete data.sourceBindings;
  delete data.sourceEvents;
  delete data.sourceFacts;
  delete data.sourceApplications;
  return data;
}

test('同一平台事实的多份不可变证据只展示一次并优先采用完整的新证据', () => {
  const first = sourceEvent({
    id: `boss-event-${'1'.repeat(64)}`,
    opportunityId: '',
    externalJobId: '',
    canonicalUrl: '',
    jobName: '',
    status: 'review',
    sourceSequence: '1',
  });
  const second = sourceEvent({
    id: `boss-event-${'2'.repeat(64)}`,
    factId: first.factId,
    status: 'recorded',
    sourceSequence: '2',
  });
  const data = sourceData(first);
  data.sourceEvents.push(second);
  const [visible] = effectiveSourceFacts(data);
  assert.equal(effectiveSourceFacts(data).length, 1);
  assert.equal(visible.id, second.id);
  assert.equal(visible.opportunityId, 'synthetic-opportunity');
});

test('v2迁移生成独立事实与应用账本，保留原事件且不会重放旧状态', () => {
  const old = sourceData();
  old.schemaVersion = 2;
  delete old.sourceFacts;
  delete old.sourceApplications;
  delete old.sourceEvents[0].factId;
  const before = clone(old);
  const migrated = migrateData(old);
  assert.deepEqual(old, before);
  assert.equal(migrated.sourceEvents[0].factId, bossFactId(old.sourceEvents[0]));
  assert.deepEqual(migrated.opportunities, old.opportunities);
  assert.equal(migrated.sourceFacts[0].id, bossFactId(old.sourceEvents[0]));
  assert.equal(migrated.sourceApplications[0].ruleVersion, 'legacy_v1');
  assert.equal(migrated.sourceApplications[0].status, 'applied');
  assert.deepEqual(migrateData(migrated), migrated);
  const unknown = { ...old, futureFacts: [] };
  assert.throws(() => migrateData(unknown), /未知字段/);
});

test('事实身份只使用平台账号、会话、消息和事实类型，并区分回执状态', () => {
  const delivered = sourceEvent();
  assert.equal(
    sha256Hex('中文 identity'),
    createHash('sha256').update('中文 identity').digest('hex'),
  );
  assert.equal(bossFactType(delivered), 'message_receipt_delivered');
  assert.equal(
    bossFactId(delivered),
    bossFactId({
      ...delivered,
      company: '另一家公司',
      jobName: '另一个岗位',
      contact: '另一位招聘者',
      externalJobId: 'another-job',
      observedAt: '2026-09-20T00:00:00.000Z',
      importPolicy: 'boss-manual-check-v1',
    }),
  );
  assert.notEqual(bossFactId(delivered), bossFactId({ ...delivered, receiptStatus: 'read' }));
  assert.notEqual(bossFactId(delivered), bossFactId({ ...delivered, messageId: 'message-2' }));
});

test('旧 v3 事件派生 ID 原样保留，并追加语义事实映射而不重放', () => {
  const v2 = sourceData();
  v2.schemaVersion = 2;
  delete v2.sourceFacts;
  delete v2.sourceApplications;
  const legacy = migrateData(v2);
  const legacyFactId = EVENT_ID.replace('boss-event-', 'boss-fact-');
  legacy.sourceFacts[0].id = legacyFactId;
  legacy.sourceFacts[0].legacyEventId = EVENT_ID;
  legacy.sourceApplications[0].id = EVENT_ID.replace('boss-event-', 'boss-application-');
  legacy.sourceApplications[0].factId = legacyFactId;
  const before = clone(legacy);
  const adapted = migrateData(legacy);
  assert.deepEqual(legacy, before);
  assert.ok(adapted.sourceFacts.some((row) => row.id === legacyFactId));
  const semanticId = bossFactId(legacy.sourceEvents[0]);
  assert.ok(adapted.sourceFacts.some((row) => row.id === semanticId));
  assert.equal(
    adapted.sourceApplications.find((row) => row.factId === semanticId).status,
    'applied',
  );
  assert.equal(sourceReviewCounts(adapted).applied, 1);
  assert.deepEqual(migrateData(adapted), adapted);
});

test('v3 适配保留事实证据字段，重复事实或应用 ID 必须停止写入', () => {
  const input = sourceData();
  Object.assign(input.sourceFacts[0], {
    legacyEventId: EVENT_ID,
    externalJobId: 'synthetic-job-id',
    evidenceSource: 'snapshot',
    evidenceRef: SNAPSHOT,
    observedAt: '2026-09-18T06:18:00.000Z',
    createdAt: STAMP,
  });
  const before = clone(input);
  assert.deepEqual(migrateData(input), before);
  assert.deepEqual(input, before);
  for (const group of ['sourceFacts', 'sourceApplications']) {
    const duplicate = clone(input);
    duplicate[group].push(clone(duplicate[group][0]));
    const unchanged = clone(duplicate);
    assert.throws(() => migrateData(duplicate), /重复 ID/);
    assert.deepEqual(duplicate, unchanged);
  }
});

test('缺少消息 ID 的观察只保留待补证据，不创建可跨消息复用的事实或应用', () => {
  const incomplete = sourceData(sourceEvent({ messageId: '', factId: '' }));
  assert.equal(incomplete.sourceEvents[0].factId, '');
  assert.equal(incomplete.sourceFacts.length, 0);
  assert.equal(incomplete.sourceApplications.length, 0);
  assert.doesNotThrow(() => validateData(incomplete));
  assert.throws(() => bossFactId(incomplete.sourceEvents[0]), /INCOMPLETE/);
});

test('v2 同一事实的多个旧决定按固定优先级聚合，事件顺序不改变迁移结果', () => {
  const applied = sourceEvent();
  delete applied.factId;
  const review = sourceEvent({
    id: `boss-event-${'e'.repeat(64)}`,
    status: 'review',
    opportunityId: '',
    company: '另一标签',
  });
  delete review.factId;
  const protectedEvent = sourceEvent({
    id: `boss-event-${'f'.repeat(64)}`,
    status: 'skipped',
    opportunityId: '',
    contact: '另一联系人',
  });
  delete protectedEvent.factId;
  const migrate = (events) => {
    const value = sourceData();
    value.schemaVersion = 2;
    value.sourceEvents = events;
    delete value.sourceFacts;
    delete value.sourceApplications;
    return migrateData(value);
  };
  const forward = migrate([review, protectedEvent, applied]);
  const reverse = migrate([applied, protectedEvent, review]);
  assert.equal(forward.sourceApplications.length, 1);
  assert.equal(forward.sourceApplications[0].status, 'applied');
  assert.deepEqual(forward.sourceApplications, reverse.sourceApplications);
});

test('来源绑定和观察事件按严格字符串结构往返，序列化纳入两个新集合', () => {
  const input = sourceData();
  const before = clone(input);
  const validated = validateData(input);
  assert.deepEqual(validated, before);
  assert.notEqual(validated, input);
  assert.match(serialize(validated), /"sourceBindings"/);
  assert.match(serialize(validated), /"sourceEvents"/);
  assert.deepEqual(input, before);
});

test('账号与岗位绑定字段分型，自动字段列表和来源值不能被静默规范化', () => {
  for (const binding of [
    accountBinding({ externalJobId: '' }),
    opportunityBinding({ workspaceSourceId: '' }),
    opportunityBinding({ autoFields: 'role,company' }),
    opportunityBinding({ autoFields: 'company,futureField' }),
    opportunityBinding({ canonicalUrl: 'javascript:synthetic' }),
    opportunityBinding({ canonicalUrl: 'https://example.com/job_detail/synthetic-job-id.html' }),
    opportunityBinding({ externalJobId: 'other-job' }),
    opportunityBinding({ platform: 'other' }),
    opportunityBinding({ accountNamespace: `boss-geek:${'e'.repeat(64)}` }),
    opportunityBinding({ createdAt: 'not-a-time' }),
  ]) {
    const data = sourceData();
    data.sourceBindings[1] = binding;
    if (binding.kind === 'account') data.sourceBindings.shift();
    assert.throws(() => validateData(data));
  }
  const data = sourceData();
  data.sourceBindings[1].futureField = 'must-not-disappear';
  assert.throws(() => validateData(data), /未知字段/);
  assert.equal(data.sourceBindings[1].futureField, 'must-not-disappear');
  const invalidAccount = sourceData();
  invalidAccount.sourceBindings[0].workspaceSourceId = 'not-a-workspace-id';
  assert.throws(() => validateData(invalidAccount), /工作区 ID/);
});

test('入站、出站和未知消息各自保留回执语义，事件枚举与时间严格校验', () => {
  for (const accepted of [
    sourceEvent({
      messageDirection: 'inbound',
      receiptStatus: 'not_applicable',
      receiptSource: '',
    }),
    sourceEvent({ messageDirection: 'outbound', receiptStatus: 'read' }),
    sourceEvent({ messageDirection: 'outbound', receiptStatus: 'delivered' }),
    sourceEvent({ messageDirection: 'outbound', receiptStatus: 'unknown', receiptSource: '' }),
    sourceEvent({ messageDirection: 'unknown', receiptStatus: 'unknown', receiptSource: '' }),
    sourceEvent({ appliedAtSource: '', evidenceDate: '' }),
    sourceEvent({ appliedAtSource: 'platform_same_day_time_label' }),
    sourceEvent({ importPolicy: 'boss-user-dated-label-2026-09-20-v1' }),
    sourceEvent({ importPolicy: 'boss-resume-observation-v2' }),
    sourceEvent({ importPolicy: 'boss-resume-observation-date-2026-09-20-v2' }),
    sourceEvent({ importPolicy: 'boss-resume-observation-v3' }),
    sourceEvent({ importPolicy: 'boss-resume-observation-date-2026-09-20-v3' }),
  ]) {
    const data = sourceData(accepted);
    assert.deepEqual(validateData(data).sourceEvents, [accepted]);
  }
  for (const rejected of [
    sourceEvent({ messageDirection: 'inbound', receiptStatus: 'read' }),
    sourceEvent({ messageDirection: 'unknown', receiptStatus: 'delivered' }),
    sourceEvent({ receiptStatus: 'unknown', receiptSource: 'invented_source' }),
    sourceEvent({ receiptSource: 'invented_source' }),
    sourceEvent({ receiptSource: '' }),
    sourceEvent({ messageDirection: 'future' }),
    sourceEvent({ receiptStatus: 'unread' }),
    sourceEvent({ nameSource: '' }),
    sourceEvent({ nameSource: 'invented_source' }),
    sourceEvent({ linkConfirmation: 'future' }),
    sourceEvent({ appliedAtSource: 'inferred' }),
    sourceEvent({ appliedAtSource: 'user_confirmed_initial_contact_date', evidenceDate: '' }),
    sourceEvent({ eventType: 'future_event' }),
    sourceEvent({ status: 'future_status' }),
    sourceEvent({ importPolicy: 'future_policy' }),
    sourceEvent({ sourceSequence: '0' }),
    sourceEvent({ sourceSequence: '-1' }),
    sourceEvent({ sourceSequence: String(Number.MAX_SAFE_INTEGER + 1) }),
    sourceEvent({ evidenceDate: '2026-02-30' }),
    sourceEvent({ createdAt: '2026-09-18' }),
    sourceEvent({ observedAt: 'invalid' }),
    sourceEvent({ platform: 'other' }),
    sourceEvent({ accountNamespace: `boss-geek:${'e'.repeat(64)}` }),
    sourceEvent({ canonicalUrl: 'https://example.com/job_detail/synthetic-job-id.html' }),
    sourceEvent({ id: 'non-deterministic-event' }),
    sourceEvent({ batchId: 'non-deterministic-batch' }),
    sourceEvent({ conversationKey: 'not-a-hash' }),
    sourceEvent({ sourceSnapshot: 'unknown-snapshot' }),
    sourceEvent({ friendId: '' }),
    sourceEvent({ friendSource: '' }),
    sourceEvent({ uniqueId: 'does-not-match' }),
  ]) {
    const data = sourceData(rejected);
    assert.throws(() => validateData(data));
  }
  for (const field of ['receiptSource', 'nameSource', 'linkConfirmation', 'appliedAtSource']) {
    const data = sourceData();
    delete data.sourceEvents[0][field];
    assert.throws(() => validateData(data), /证据字段/);
  }
});

test('简历平台观察可记录但不伪装为会话回执或人工简历状态', () => {
  const resume = sourceEvent({
    eventType: 'resume_observed',
    messageDirection: 'outbound',
    receiptStatus: 'not_applicable',
    receiptSource: '',
    summary: 'resume_sent_candidate',
    timeLabel: '',
    evidenceDate: '',
    appliedAtSource: '',
    importPolicy: 'boss-resume-observation-v1',
  });
  const data = sourceData(resume);
  assert.deepEqual(validateData(data).sourceEvents, [resume]);
  data.sourceEvents[0] = { ...resume, receiptStatus: 'read' };
  assert.throws(() => validateData(data), /简历观察/);
});

test('已录入事件必须关联岗位；待核对可无岗位但来源账号、岗位引用不可孤立', () => {
  const review = sourceData(
    sourceEvent({
      status: 'review',
      opportunityId: '',
      externalJobId: '',
      canonicalUrl: '',
      company: '',
      jobName: '',
      nameSource: '',
      appliedAtSource: '',
    }),
  );
  assert.doesNotThrow(() => validateData(review));

  const missingRecorded = sourceData(sourceEvent({ opportunityId: '' }));
  assert.throws(() => validateData(missingRecorded), /必要来源字段/);

  for (const mutate of [
    (data) => data.sourceBindings.shift(),
    (data) => (data.sourceBindings[1].opportunityId = 'missing'),
    (data) => (data.sourceEvents[0].opportunityId = 'missing'),
  ]) {
    const data = sourceData();
    mutate(data);
    assert.throws(() => validateData(data));
    assert.doesNotThrow(() => validateData(data, { allowOrphans: true }));
  }
});

test('账号与岗位稳定身份不能重复，已删除岗位仍保留绑定与历史观察以阻止复活', () => {
  for (const duplicate of [
    accountBinding({ workspaceSourceId: 'other-source' }),
    opportunityBinding(),
    opportunityBinding({
      id: `boss-job-${ACCOUNT_HASH}-other-job`,
      externalJobId: 'other-job',
      opportunityId: 'other-opportunity',
    }),
  ]) {
    const data = sourceData();
    if (duplicate.opportunityId === 'other-opportunity')
      data.opportunities.push(job({ id: 'other-opportunity' }));
    data.sourceBindings.push(duplicate);
    assert.throws(() => validateData(data));
  }
  const deleted = sourceData();
  deleted.opportunities[0].deletedAt = STAMP;
  assert.doesNotThrow(() => validateData(deleted));
});

test('确定性来源事件重复合并为一条，同 ID 内容分歧保留冲突', () => {
  const base = sourceData();
  const local = clone(base);
  const remote = clone(base);
  const newEventId = `boss-event-${'e'.repeat(64)}`;
  local.sourceEvents.push(sourceEvent({ id: newEventId, sourceSequence: '2' }));
  remote.sourceEvents.push(sourceEvent({ id: newEventId, sourceSequence: '2' }));
  const merged = mergeData(base, local, remote);
  assert.equal(merged.conflicts.length, 0);
  assert.equal(merged.data.sourceEvents.filter((row) => row.id === newEventId).length, 1);
  remote.sourceEvents.at(-1).receiptStatus = 'read';
  assert.equal(mergeData(base, local, remote).conflicts[0].key, `sourceEvents:${newEventId}`);
});

test('v1数据逐级迁移到v3且未知旧字段、未来格式继续停止写入', () => {
  const old = asV1(sourceData());
  const before = clone(old);
  const migrated = migrateData(old);
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.sourceBindings, []);
  assert.deepEqual(migrated.sourceEvents, []);
  assert.deepEqual(old, before);
  assert.deepEqual(migrateData(migrated), migrated);

  const unknown = { ...old, sourceEvents: [] };
  assert.throws(() => migrateData(unknown), /未知字段/);
  assert.deepEqual(unknown.sourceEvents, []);
  assert.throws(() => migrateData({ ...emptyData(), schemaVersion: 4 }), /版本/);
});

test('工作区data/base/pending及冲突双方、完整备份和草稿原版本一并通过v1迁移', () => {
  const current = initialWorkspace();
  const old = asV1(sourceData());
  current.data = clone(old);
  current.base = clone(old);
  current.pending = {
    data: clone(old),
    remote: clone(old),
    generation: current.generation,
    conflicts: [
      {
        key: 'opportunities:synthetic-opportunity',
        group: 'opportunities',
        id: 'synthetic-opportunity',
        base: job({ notes: '基线' }),
        local: job({ notes: '本机' }),
        remote: job({ notes: '远端' }),
      },
    ],
  };
  const migrated = migrateWorkspace(current);
  for (const data of [
    migrated.data,
    migrated.base,
    migrated.pending.data,
    migrated.pending.remote,
  ]) {
    assert.equal(data.schemaVersion, 3);
    assert.deepEqual(data.sourceBindings, []);
    assert.deepEqual(data.sourceEvents, []);
  }
  assert.equal(migrated.pending.conflicts[0].local.notes, '本机');

  const draft = {
    id: '00000000-0000-4000-8000-000000000010',
    revision: '00000000-0000-4000-8000-000000000011',
    kind: 'editor',
    opportunityId: 'synthetic-opportunity',
    values: { notes: '合成未提交内容' },
    original: job(),
    updatedAt: STAMP,
  };
  const backup = {
    ...createBackup(migrated, [draft]),
    workspace: current,
  };
  const parsed = parseBackup(backup);
  assert.equal(parsed.workspace.data.schemaVersion, 3);
  assert.deepEqual(parsed.drafts[0].original, draft.original);
});

test('含来源集合的完整备份往返和快照等价检查不丢字段', () => {
  const workspace = initialWorkspace();
  workspace.data = migrateData(sourceData());
  workspace.base = clone(workspace.data);
  const backup = createBackup(workspace);
  const parsed = parseBackup(JSON.parse(JSON.stringify(backup)));
  assert.ok(equal(parsed.workspace.data, workspace.data));
  assert.deepEqual(parsed.workspace, workspace);
});

test('从 v1 工作区直接回到 v1 快照时也迁移全部集合并保留墓碑', () => {
  const current = initialWorkspace();
  current.data = asV1(sourceData());
  current.base = asV1(sourceData());
  const older = asV1(sourceData());
  older.opportunities = [];
  const restored = restoreWorkspace(current, older, 'snapshot');
  assert.equal(restored.data.schemaVersion, 3);
  assert.deepEqual(restored.data.sourceBindings, []);
  assert.deepEqual(restored.data.sourceEvents, []);
  assert.ok(restored.data.opportunities[0].deletedAt);
});

test('GitHub、浏览器SSH桥和服务端Git读取均在远端入口迁移v1数据', async () => {
  const legacy = asV1(sourceData()),
    text = JSON.stringify(legacy);
  let githubCall = 0;
  const github = githubClient(
    { owner: 'synthetic', repo: 'private', path: 'fixtures/data.json' },
    'synthetic-token',
    async () => {
      githubCall++;
      if (githubCall === 1) return Response.json({ private: true, default_branch: 'main' });
      if (githubCall === 2) return Response.json({ name: 'main' });
      return Response.json({
        type: 'file',
        encoding: 'base64',
        size: new TextEncoder().encode(text).byteLength,
        sha: 'a'.repeat(40),
        content: encodeUtf8(text),
      });
    },
  );
  assert.equal((await github.read()).data.schemaVersion, 3);

  const local = localSshClient('synthetic-session', async () =>
    Response.json({ data: legacy, sha: 'b'.repeat(40), missing: false }),
  );
  assert.equal((await local.read()).data.schemaVersion, 3);

  const store = new GitStore({
    cache: 'unused',
    remote: 'git@github.com:synthetic/private.git',
    path: 'fixtures/data.json',
  });
  store.git = async (args) => {
    if (args[0] === 'ls-tree') return `100644 blob ${'c'.repeat(40)}\tfixtures/data.json\0`;
    if (args[1] === '-s') return String(Buffer.byteLength(text));
    if (args[1] === 'blob') return text;
    throw new Error(`Unexpected synthetic git call: ${args.join(' ')}`);
  };
  assert.equal((await store.fileAt('synthetic-head')).data.schemaVersion, 3);
});
