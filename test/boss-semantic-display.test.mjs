import assert from 'node:assert/strict';
import test from 'node:test';
import { bossAttributionSummary } from '../dist/boss-attribution.js';
import { groupBossObservations } from '../dist/boss-observations.js';
import { bossIntegrationView, bossObservationReason } from '../dist/settings-view.js';
import { syncConflictView } from '../dist/sync-conflict-ui.js';
import { initialWorkspace } from '../dist/workspace.js';
import { createViews } from '../dist/views.js';
import { effectiveSourceEvents, effectiveSourceFacts } from '../dist/source-ledger.js';
import { platformObservationLabel } from '../dist/boss-integration.js';

const reason = 'resume_semantics_missing';
const label = '缺少可核对的简历状态依据';
function observationData() {
  const data = initialWorkspace().data;
  for (const [index, status, applicationReason, eventType] of [
    [0, 'waiting', 'missing_job_details', 'conversation_observed'],
    [1, 'waiting', reason, 'resume_observed'],
    [2, 'no_effect', 'observation_recorded', 'conversation_observed'],
  ]) {
    const factId = `synthetic-fact-${index}`;
    data.sourceFacts.push({ id: factId, platform: 'boss' });
    data.sourceApplications.push({
      id: `synthetic-application-${index}`,
      factId,
      status,
      reason: applicationReason,
    });
    data.sourceEvents.push({
      id: `synthetic-event-${index}`,
      factId,
      platform: 'boss',
      accountNamespace: 'synthetic-account',
      conversationKey: 'synthetic-conversation',
      messageId: 'synthetic-message',
      eventType,
      receiptStatus: index === 2 ? 'delivered' : '',
      jobName: '<合成岗位>',
      company: '<合成公司>',
      summary: 'SECRET_MESSAGE_BODY',
    });
  }
  return data;
}
const waitingItems = (data) =>
  data.sourceApplications
    .filter((row) => ['waiting', 'review'].includes(row.status))
    .map((row) => ({
      applicationId: row.id,
      status: row.status,
      reason: row.reason,
      candidate: '<合成岗位>',
      candidateCompany: '<合成公司>',
    }));

test('发送依据不足独立计数，按事实去重且已处理或已删除观察退出摘要', () => {
  const data = observationData();
  data.sourceApplications.push({ ...data.sourceApplications[1] });
  const summary = bossAttributionSummary(data);
  assert.equal(summary.semantic, 1);
  assert.equal(summary.insufficient, 0);
  assert.equal(summary.conflict, 0);
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].category, 'semantic');
  assert.equal(summary.items[0].label, label);
  assert.equal(summary.items[0].candidate, '<合成岗位>');
  assert.doesNotMatch(JSON.stringify(summary), /SECRET_MESSAGE_BODY/);
  for (const row of data.sourceApplications.filter((row) => row.reason === reason))
    row.status = 'no_effect';
  assert.equal(bossAttributionSummary(data).semantic, 0);
  data.sourceApplications[1].status = 'waiting';
  data.sourceApplications[1].deletedAt = '2026-10-08T00:00:00Z';
  assert.equal(bossAttributionSummary(data).semantic, 0);
});

test('同消息的发送依据不足优先于岗位资料缺失，完成回执不掩盖等待且与顺序无关', () => {
  const data = observationData();
  const items = waitingItems(data);
  for (const ordered of [items, [...items].reverse()]) {
    const groups = groupBossObservations(ordered, data);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].reason, reason);
    assert.equal(groups[0].status, 'waiting');
    assert.equal(groups[0].observations.length, 3);
    assert.equal(groups[0].waitingApplicationIds.length, 2);
  }
  data.sourceApplications[0].reason = 'attribution_message_multiple_jobs';
  data.sourceApplications[0].status = 'review';
  const conflicted = waitingItems(data);
  for (const ordered of [conflicted, [...conflicted].reverse()]) {
    const group = groupBossObservations(ordered, data)[0];
    assert.equal(group.status, 'review');
    assert.equal(group.reason, 'attribution_message_multiple_jobs');
    assert.equal(group.waitingApplicationIds.length, 1);
    assert.ok(group.observations.some((row) => row.reason === reason));
  }
});

test('语义等待卡片明确系统文案缺失、发送未证明、候选未确认，保留现有忽略但无资料确认', () => {
  const data = observationData();
  data.sourceApplications[0].status = 'no_effect';
  const html = bossIntegrationView(
    {
      available: true,
      serverManaged: true,
      revision: 1,
      waitingItems: waitingItems(data),
      attribution: bossAttributionSummary(data),
    },
    { data },
  );
  assert.match(html, /简历状态依据不足 · 1 条/);
  assert.match(html, /现有观察缺少可核对的系统状态依据/);
  assert.match(html, /这项观察不能证明简历已发送或已接收，也不确认岗位归属/);
  assert.match(html, /候选岗位：&lt;合成公司&gt; \/ &lt;合成岗位&gt;/);
  assert.match(html, /编辑不会补齐平台状态依据/);
  assert.match(html, /可忽略 1 项等待观察/);
  assert.equal((html.match(new RegExp(label, 'g')) || []).length, 2);
  assert.doesNotMatch(
    html,
    /缺少岗位资料 ·|聊天归属无法确认 ·|其他等待项 ·|data-boss-confirm=|SECRET_MESSAGE_BODY|<合成岗位>|已确认归属/,
  );
});

test('只有只读摘要时仍展示发送依据不足及候选，不误称归属或岗位资料缺失', () => {
  const summary = bossAttributionSummary(observationData());
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    attribution: summary,
  });
  assert.match(html, /简历状态依据不足：<strong>1<\/strong>/);
  assert.match(html, new RegExp(label));
  assert.match(html, /候选岗位：&lt;合成公司&gt; \/ &lt;合成岗位&gt;/);
  assert.doesNotMatch(html, /归属证据不足|缺少岗位资料|SECRET_MESSAGE_BODY/);
  const mixed = observationData();
  mixed.sourceApplications[0].reason = 'attribution_evidence_missing';
  const mixedHtml = bossIntegrationView({
    available: true,
    serverManaged: true,
    attribution: bossAttributionSummary(mixed),
  });
  assert.match(mixedHtml, /归属证据不足：<strong>1<\/strong>/);
  assert.match(mixedHtml, /简历状态依据不足：<strong>1<\/strong>/);
});

test('同步冲突中的新等待原因使用相同中文说明，原原因码仍保留在技术详情', () => {
  const data = initialWorkspace().data;
  const local = {
    id: 'synthetic-application',
    factId: 'synthetic-fact',
    status: 'waiting',
    reason,
  };
  const pending = {
    data,
    conflicts: [
      {
        key: 'sourceApplications:synthetic-application',
        group: 'sourceApplications',
        id: local.id,
        local,
        remote: { ...local, status: 'protected', reason: 'user_ignored_unresolved_observation' },
      },
    ],
  };
  const html = syncConflictView(pending, data);
  assert.match(html, new RegExp(label));
  assert.doesNotMatch(html.slice(0, html.indexOf('<details')), /resume_semantics_missing/);
  assert.match(html.slice(html.indexOf('<details')), /resume_semantics_missing/);
});

test('语义等待与无目标纯存档不借用旧事件的岗位关联，原始观察保持不变', () => {
  for (const [status, applicationReason] of [
    ['waiting', reason],
    ['no_effect', 'observation_only'],
  ]) {
    const data = observationData();
    data.sourceApplications = [data.sourceApplications[1]];
    data.sourceEvents = [data.sourceEvents[1]];
    const application = data.sourceApplications[0];
    Object.assign(application, { status, reason: applicationReason, opportunityId: '' });
    Object.assign(data.sourceEvents[0], {
      opportunityId: 'synthetic-job',
      status: 'recorded',
      summary: 'resume_request_sent',
    });
    data.opportunities.push({
      id: 'synthetic-job',
      company: '合成公司',
      role: '合成岗位',
      platform: 'BOSS',
      stage: '已触达',
      resumeState: '未知',
    });
    const before = structuredClone(data);
    assert.equal(effectiveSourceEvents(data)[0].opportunityId, '');
    assert.equal(effectiveSourceFacts(data)[0].opportunityId, '');
    const views = createViews(
      () => ({ state: { data }, selected: 'synthetic-job' }),
      () => [],
    );
    assert.doesNotMatch(views.detail(), /平台观察 <span|附件简历请求已发送/);
    assert.deepEqual(data, before);
  }
});

test('详情与冲突按来源应用解释旧request_sent枚举，已应用发送标签保持', () => {
  const data = observationData();
  data.sourceApplications = [data.sourceApplications[1]];
  data.sourceEvents = [data.sourceEvents[1]];
  const application = data.sourceApplications[0];
  const event = data.sourceEvents[0];
  Object.assign(application, {
    status: 'no_effect',
    reason: 'observation_only',
    opportunityId: 'synthetic-job',
  });
  Object.assign(event, {
    opportunityId: 'synthetic-job',
    status: 'recorded',
    summary: 'resume_request_sent',
  });
  data.opportunities.push({
    id: 'synthetic-job',
    company: '合成公司',
    role: '合成岗位',
    platform: 'BOSS',
    stage: '已触达',
    resumeState: '未知',
  });
  const views = createViews(
    () => ({ state: { data }, selected: 'synthetic-job' }),
    () => [],
  );
  assert.match(views.detail(), /旧平台卡片（仅存档，未确认发送）/);
  assert.doesNotMatch(views.detail(), /附件简历请求已发送/);
  assert.equal(
    platformObservationLabel(event, { ...application, status: 'waiting', reason }),
    '旧平台卡片（发送依据不足）',
  );
  assert.equal(
    platformObservationLabel(event, {
      ...application,
      status: 'applied',
      reason: 'resume_state_applied',
    }),
    '附件简历请求已发送',
  );
  assert.equal(platformObservationLabel(event), '附件简历请求已发送');
  const pending = {
    data,
    conflicts: [
      {
        key: `sourceEvents:${event.id}`,
        group: 'sourceEvents',
        id: event.id,
        local: event,
        remote: { ...event, summary: 'resume_card_other' },
      },
    ],
  };
  const html = syncConflictView(pending, data);
  const primary = html.slice(0, html.indexOf('<details'));
  assert.match(primary, /旧平台卡片（仅存档，未确认发送）/);
  assert.doesNotMatch(primary, /附件简历请求已发送/);
  assert.match(html.slice(html.indexOf('<details')), /resume_request_sent/);
});

test('人工否决发送误判显示固定原因，退出等待并归入人工决定，正文与旧发送标签不展示', () => {
  const data = observationData();
  data.sourceApplications = [data.sourceApplications[1]];
  data.sourceEvents = [data.sourceEvents[1]];
  const application = data.sourceApplications[0];
  Object.assign(application, {
    status: 'protected',
    reason: 'user_rejected_wrong_resume_semantics',
  });
  const label = '已人工否决错误简历发送判断';
  assert.equal(bossObservationReason(application), label);
  const summary = bossAttributionSummary(data);
  assert.equal(summary.semantic, 0);
  assert.equal(summary.items.length, 0);
  const html = bossIntegrationView(
    {
      available: true,
      serverManaged: true,
      revision: 2,
      applicationCounts: { protected: 1 },
      waitingItems: [
        { applicationId: application.id, status: 'waiting', reason: 'resume_semantics_missing' },
      ],
      attribution: summary,
    },
    { data },
  );
  assert.match(html, /人工决定已保留：<strong>1<\/strong>/);
  assert.doesNotMatch(
    html,
    /data-boss-ignore-item|等待资料或证据|附件简历请求已发送|SECRET_MESSAGE_BODY/,
  );
  const pending = {
    data,
    conflicts: [
      {
        key: `sourceApplications:${application.id}`,
        group: 'sourceApplications',
        id: application.id,
        local: application,
        remote: { ...application, status: 'applied', reason: 'resume_state_applied' },
      },
    ],
  };
  const conflict = syncConflictView(pending, data);
  assert.match(conflict, new RegExp(label));
  assert.doesNotMatch(
    conflict.slice(0, conflict.indexOf('<details')),
    /user_rejected_wrong_resume_semantics/,
  );
  assert.deepEqual(data.sourceEvents[0].summary, 'SECRET_MESSAGE_BODY');
});
