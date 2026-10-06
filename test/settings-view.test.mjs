import assert from 'node:assert/strict';
import test from 'node:test';
import { bossIntegrationView, reconcileBossIgnoreSelection } from '../dist/settings-view.js';

test('详情技术隔离独立显示，不混入人工判断', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    accounts: [],
    pending: 0,
    server: {},
    sourceId: '00000000-0000-4000-8000-000000000001',
    applicationCounts: { waiting: 7, review: 1, protected: 0 },
    tracking: {
      detailEnrichment: {
        status: 'blocked',
        pending: 5,
        deferred: 2,
        isolated: 3,
        nextRetryAt: '2026-09-22T12:00:00.000Z',
        lastError: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
      },
    },
  });
  assert.match(html, /<strong>1<\/strong> 需要人工判断/);
  assert.match(html, /<strong>3<\/strong> 技术隔离/);
  assert.match(html, /DETAIL_TAB_OWNERSHIP_MISMATCH/);
  assert.match(html, /pnpm boss resume-details/);
});

test('正常等待和人工保护收进默认折叠详情，不误报故障或继续采集', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    tracking: { lifecycle: 'stopped', lastSuccessAt: '2026-10-04T07:32:00Z' },
    applicationCounts: { waiting: 72, review: 0, protected: 47 },
    attribution: { insufficient: 46, conflict: 0, collection: 0, items: [] },
    pending: 0,
    server: { receiptCount: 68, incidentCount: 0 },
  });
  const primary = html.slice(0, html.indexOf('<details'));
  assert.match(primary, /跟踪已停止/);
  assert.match(primary, /上次成功采集/);
  assert.doesNotMatch(primary, /仍继续|需要处理|72|47|68|证据不足/);
  assert.match(
    html,
    /<details[^>]*data-settings-details="boss-status"[^>]*><summary[^>]*>查看详情<\/summary>/,
  );
  assert.doesNotMatch(html, /<details[^>]*\bopen\b|<strong>0<\/strong>/);
  assert.match(html, /等待资料或证据：<strong>72<\/strong>，其中 <strong>46<\/strong>/);
  assert.match(html, /人工决定已保留：<strong>47<\/strong>/);
});

test('运行和暂停状态文案准确，故障始终在主区域可见', () => {
  const base = { available: true, serverManaged: true };
  const running = bossIntegrationView({ ...base, tracking: { lifecycle: 'running' } });
  assert.match(running, /跟踪中/);
  assert.match(running, /关闭此页面后仍继续/);
  const paused = bossIntegrationView({
    ...base,
    tracking: { lifecycle: 'paused', pauseCode: 'LOGIN_REQUIRED' },
  });
  const primary = paused.slice(0, paused.indexOf('<details'));
  assert.match(primary, /需要处理|跟踪已暂停/);
  assert.match(primary, /LOGIN_REQUIRED/);
  assert.doesNotMatch(primary, /仍继续/);
});

test('绑定与恢复重放动作不收进详情，外部字段仍转义', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    tracking: { lifecycle: 'stopped' },
    accounts: [{ label: '<账号>', accountNamespace: '<账号身份>', bound: false, pending: 0 }],
    restoreReview: [{ batchId: '<批次>', missing: 2 }],
    attribution: { items: [{ label: '<原因>', candidate: '<岗位>', candidateCompany: '<公司>' }] },
  });
  const primary = html.slice(0, html.indexOf('<details'));
  assert.match(primary, /data-boss-bind="&lt;账号身份&gt;"/);
  assert.match(primary, /data-boss-replay="&lt;批次&gt;"/);
  assert.doesNotMatch(html, /<账号>|<原因>|<岗位>|<公司>/);
  assert.match(html, /候选岗位：&lt;公司&gt; \/ &lt;岗位&gt;/);
});

test('归属冲突和采集隔离不会因折叠或较旧的应用计数而隐藏', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    applicationCounts: { review: 0 },
    attribution: { conflict: 1 },
    tracking: { lifecycle: 'stopped', detailEnrichment: { isolated: 2 } },
  });
  const primary = html.slice(0, html.indexOf('<details'));
  assert.match(primary, /需要处理/);
  assert.match(primary, /<strong>1<\/strong> 需要人工判断/);
  assert.match(primary, /采集因故障未完成/);
});

test('旧状态明确标识，不宣称持续采集，绑定与重放等待状态恢复', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    connectionStale: true,
    refreshError: 'LOCAL_TIMEOUT：超时',
    tracking: { lifecycle: 'running' },
    accounts: [{ label: '合成账号', accountNamespace: 'synthetic', bound: false }],
    restoreReview: [{ batchId: 'synthetic', missing: 1 }],
  });
  assert.match(html, /上次成功获取的状态/);
  assert.doesNotMatch(html, /关闭此页面后仍继续/);
  assert.match(html, /data-boss-bind="synthetic" disabled/);
  assert.match(html, /data-boss-replay="synthetic" disabled/);
  assert.match(html, /LOCAL_TIMEOUT/);
  const quiet = bossIntegrationView({
    available: true,
    serverManaged: true,
    connectionStale: true,
    tracking: { lifecycle: 'running' },
  });
  assert.match(quiet, /状态待更新/);
});

test('等待原因可逐条多选忽略，默认不选，候选明确，忽略独立计数', () => {
  const status = {
    available: true,
    serverManaged: true,
    revision: 4,
    applicationCounts: { waiting: 2, protected: 47, ignored: 3 },
    waitingItems: [
      {
        applicationId: 'boss-application-one',
        reason: 'missing_job_details',
        candidateCompany: '<合成公司>',
        candidate: '',
      },
      {
        applicationId: 'boss-application-two',
        reason: 'attribution_evidence_missing',
        candidateCompany: '合成公司',
        candidate: '合成岗位',
      },
    ],
    attribution: {
      insufficient: 1,
      items: [{ category: 'insufficient', label: '不应重复', candidate: '' }],
    },
  };
  const html = bossIntegrationView(status);
  assert.match(html, /缺少岗位资料/);
  assert.match(html, /候选公司：&lt;合成公司&gt;/);
  assert.match(html, /候选岗位：合成公司 \/ 合成岗位/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 2);
  assert.doesNotMatch(html, /checked|不应重复/);
  assert.match(html, /已忽略：<strong>3<\/strong>/);
  assert.match(html, /人工决定已保留：<strong>47<\/strong>/);
  assert.match(html, /data-boss-ignore="true" disabled/);
  const selected = new Set(['boss-application-one']);
  assert.match(bossIntegrationView(status, { selected }), /data-boss-ignore="true" >忽略所选观察/);
  for (const options of [
    { selected, pendingConflict: true },
    { selected, busy: true },
  ])
    assert.match(bossIntegrationView(status, options), /data-boss-ignore="true" disabled/);
  assert.match(
    bossIntegrationView({ ...status, connectionStale: true }, { selected }),
    /data-boss-ignore="true" disabled/,
  );
});

test('状态暂未更新时仍可勾选旧等待项，提交明确解释阻止原因', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    revision: 7,
    connectionStale: true,
    waitingItems: [
      {
        applicationId: 'boss-application-synthetic',
        reason: 'missing_job_details',
        candidate: '',
        candidateCompany: '合成公司',
      },
    ],
    applicationCounts: { waiting: 1 },
  });
  const checkbox = html.match(/<input[^>]*data-boss-ignore-item[^>]*>/)?.[0];
  assert.ok(checkbox);
  assert.doesNotMatch(checkbox, /disabled/);
  assert.match(html, /状态尚未更新.*可以先勾选/);
  assert.match(html, /data-boss-ignore="true" disabled/);
});

test('刷新保留仍等待的选择，仅移除已离开清单的观察', () => {
  const selected = new Set(['first', 'second']);
  const retained = reconcileBossIgnoreSelection(selected, [
    { applicationId: 'first' },
    { applicationId: 'second' },
  ]);
  assert.deepEqual([...retained], ['first', 'second']);
  assert.deepEqual(
    [...reconcileBossIgnoreSelection(retained, [{ applicationId: 'second' }])],
    ['second'],
  );
});

test('问题按原因分组，显示联系人、记录类型和具体缺项，私有文字正确转义', () => {
  const id = 'synthetic-application';
  const data = {
    sourceApplications: [{ id, factId: 'synthetic-fact' }],
    sourceEvents: [
      {
        factId: 'synthetic-fact',
        contact: '<合成联系人>',
        eventType: 'conversation_observed',
        observedAt: '2026-10-04T09:00:00Z',
        jobName: '',
        externalJobId: '',
        canonicalUrl: '',
        summary: '不应展示的聊天正文',
      },
    ],
  };
  const html = bossIntegrationView(
    {
      available: true,
      serverManaged: true,
      revision: 1,
      waitingItems: [
        {
          applicationId: id,
          reason: 'missing_job_details',
          candidateCompany: '合成公司',
          candidate: '',
        },
      ],
      applicationCounts: { waiting: 1 },
    },
    { data },
  );
  assert.match(html, /缺少岗位资料 · 1 条/);
  assert.match(html, /&lt;合成联系人&gt; · 包含 1 项观察/);
  assert.match(html, /岗位名称、岗位编号、岗位链接未取得/);
  assert.match(html, /可直接核对下方候选岗位/);
  assert.match(html, /刷新本机状态/);
  assert.doesNotMatch(html, /不应展示的聊天正文|<合成联系人>/);
  const pending = bossIntegrationView(
    {
      available: true,
      serverManaged: true,
      revision: 1,
      waitingItems: [{ applicationId: id, reason: 'attribution_evidence_missing' }],
    },
    { pendingConflict: true },
  );
  assert.match(pending, /聊天归属无法确认 · 1 条/);
  assert.match(pending, /请先处理同步冲突；可以先勾选/);
  assert.doesNotMatch(pending.match(/<input[^>]*>/)[0], /disabled/);
});
