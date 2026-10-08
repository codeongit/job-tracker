import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bossIntegrationView,
  reconcileBossIgnoreSelection,
  settingsView,
  bossDetailsConfirmationView,
} from '../dist/settings-view.js';
import { initialWorkspace } from '../dist/workspace.js';
import {
  bossProcessingFeedback,
  bossFailureGuidance,
  bossConflictTargets,
} from '../dist/settings-guidance.js';
import { bossApplicationId } from '../dist/source-identity.js';

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
  assert.match(html, /存在 1 项归属或资料矛盾/);
  assert.match(html, /<strong>3<\/strong> 技术隔离/);
  assert.match(html, /DETAIL_TAB_OWNERSHIP_MISMATCH/);
  assert.match(html, /pnpm boss resume-details/);
});

test('正常等待显示摘要，人工保护和回执折叠，不误报故障或继续采集', () => {
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
  assert.match(primary, /最近成功处理（含本机恢复）/);
  assert.doesNotMatch(primary, /仍继续|badge warn|47|68/);
  assert.match(primary, /等待资料或证据/);
  assert.match(
    html,
    /<details[^>]*data-settings-details="boss-status"[^>]*><summary[^>]*>运行详情<\/summary>/,
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
  assert.match(primary, /登录、验证和账号/);
  assert.match(paused, /LOGIN_REQUIRED/);
  assert.doesNotMatch(primary, /LOGIN_REQUIRED/);
  assert.doesNotMatch(primary, /仍继续/);
});

test('聊天列表未就绪时说明实际读取失败及恢复前提', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    tracking: { lifecycle: 'paused', pauseCode: 'LOADED_LIST_NOT_READY' },
  });
  const primary = html.slice(0, html.indexOf('<details'));
  assert.match(primary, /聊天列表暂时无法读取/);
  assert.match(primary, /没有找到可读取的聊天列表数据/);
  assert.match(primary, /采集专用页面/);
  assert.match(primary, /确认登录和验证已完成、聊天列表正常显示/);
  assert.match(html, /pnpm boss resume/);
  assert.doesNotMatch(primary, /LOADED_LIST_NOT_READY|查看本机诊断定位原因/);
});

test('岗位清单导出失败说明快照保留，不误报登录或资料缺失', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    tracking: { lifecycle: 'paused', pauseCode: 'JOB_EXPORT_FAILED' },
  });
  const primary = html.slice(0, html.indexOf('<details'));
  assert.match(primary, /本机岗位清单导出失败/);
  assert.match(primary, /采集快照已保存/);
  assert.match(primary, /正式录入结果须按当前应用记录核对/);
  assert.match(html, /pnpm boss resume/);
  assert.doesNotMatch(primary, /查看本机诊断定位原因|登录、验证和账号/);
});

test('批次处理记录与保存的聊天进度不冒充最新录入结果', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    server: { receipts: 5, processed: 3, incidents: 2 },
    tracking: { lifecycle: 'stopped', history: { mode: 'backfill', completed: 4 } },
  });
  assert.match(html, /本机保存了 <strong>5<\/strong> 份采集批次处理记录/);
  assert.match(html, /处理记录不代表所有消息都已用于更新岗位/);
  assert.match(html, /<strong>2<\/strong> 份故障诊断记录/);
  assert.match(html, /上次采集方式：手动补录/);
  assert.match(html, /已有历史检查记录的聊天：<strong>4<\/strong> 个/);
  assert.match(html, /不是上次新增的消息或岗位数量/);
  assert.match(html, /不表示每个聊天的全部历史都已读完/);
  assert.doesNotMatch(html, /本机回执|已完成会话|最近一次手动回填/);
});

test('采集上限与滚动次数占用分开，聊天补查额度不宣称已启用', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    tracking: {
      lifecycle: 'stopped',
      budget: {
        historyRequests: 6,
        detailActions: 2,
        domActions: 1,
        historyUsed: 3,
        navigationUsed: 4,
      },
    },
  });
  assert.match(html, /读取聊天历史资料<\/dt><dd>最多 <strong>6<\/strong> 次/);
  assert.match(html, /查询联系人或读取一页消息，各计 1 次/);
  assert.match(html, /打开岗位详情<\/dt><dd>最多 <strong>2<\/strong> 次/);
  assert.match(html, /打开聊天补查<\/dt><dd>最多 <strong>1<\/strong> 次/);
  assert.match(html, /有次数上限不表示此方式已开启/);
  assert.match(html, /以上是上限，不是已经执行的次数/);
  assert.match(html, /跟踪未运行时不会因此开始采集/);
  assert.match(html, /过去 60 分钟的次数占用/);
  assert.match(html, /历史资料读取<\/dt><dd>已占用 <strong>3<\/strong> 次/);
  assert.match(html, /打开岗位详情或聊天<\/dt><dd>已占用 <strong>4<\/strong> 次/);
  assert.match(html, /用量未确认时，也可能保留预留次数/);
  assert.doesNotMatch(html, /历史请求额度|详情额度|会话操作额度/);
});

test('零可用次数明确展示，缺失预算不当作零用量', () => {
  const render = (budget, history) =>
    bossIntegrationView({
      available: true,
      serverManaged: true,
      tracking: { lifecycle: 'running', budget, history },
    });
  const html = render(
    { historyRequests: 0, detailActions: 0, domActions: 0, historyUsed: 0 },
    { mode: 'change', completed: 0 },
  );
  assert.equal((html.match(/最多 <strong>0<\/strong> 次/g) || []).length, 3);
  assert.match(html, /已有历史检查记录的聊天：<strong>0<\/strong> 个/);
  assert.match(html, /历史资料读取<\/dt><dd>已占用 <strong>0<\/strong> 次/);
  assert.doesNotMatch(html, /打开岗位详情或聊天<\/dt>/);
  const unknown = render({});
  assert.match(unknown, /当前可用次数尚未取得/);
  assert.doesNotMatch(unknown, /<strong>0<\/strong>|过去 60 分钟的次数占用/);
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
  assert.match(html, /存在 1 项归属或资料矛盾/);
  assert.match(primary, /详情未完成/);
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

test('三张任务卡保留主要动作，本机模式不提供令牌写入替代路径', () => {
  const state = initialWorkspace();
  const html = settingsView({
    state,
    ssh: true,
    bossStatus: { available: false },
    persistence: { local: true },
  });
  assert.equal((html.match(/class="panel"/g) || []).length, 3);
  for (const text of [
    'BOSS 采集',
    'GitHub 同步',
    '备份与文件',
    '手动同步到 GitHub',
    '下载完整备份',
    '连接配置',
    '应用运行详情',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /name="token"/);
  assert.match(html, /查看浏览器旧快照/);
  const configured = settingsView({
    state,
    ssh: false,
    sshTarget: { owner: 'synthetic', repo: 'private', path: 'synthetic.json' },
    bossStatus: { available: false },
    persistence: { local: true },
  });
  assert.match(configured, /data-action="use-ssh-target"/);
  assert.doesNotMatch(configured, /name="token"/);
  const blocked = settingsView({
    state,
    ssh: false,
    sshTarget: { owner: 'synthetic', repo: 'private', path: 'synthetic.json' },
    bossStatus: { available: false },
    persistence: { local: true, offline: true },
  });
  assert.match(blocked, /data-action="use-ssh-target" disabled/);
  const remote = settingsView({
    state,
    bossStatus: { available: false },
    persistence: { local: false },
  });
  assert.match(remote, /name="token"/);
  assert.match(remote, /本次会话/);
  assert.match(remote, /查看浏览器操作快照/);
});

test('备份失败在主卡片可见，技术原因折叠且不混作采集问题', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hostname: '127.0.0.1' },
  });
  t.after(() =>
    descriptor
      ? Object.defineProperty(globalThis, 'location', descriptor)
      : delete globalThis.location,
  );
  const html = settingsView({
    state: initialWorkspace(),
    bossStatus: { available: false },
    backupStatus: { error: '<合成磁盘错误>', message: '独立备份未完成' },
  });
  const backup = html.slice(html.indexOf('id="backup-files"'));
  assert.match(backup, /独立备份尚未完成|正式记录和草稿仍保留/);
  assert.match(backup, /查看磁盘备份/);
  assert.match(backup, /&lt;合成磁盘错误&gt;/);
  assert.doesNotMatch(backup, /<合成磁盘错误>/);
});

function mixedObservationData() {
  const data = initialWorkspace().data;
  for (const [i, status] of ['waiting', 'review'].entries()) {
    const factId = `boss-fact-${String(i + 1).repeat(64)}`;
    const id = bossApplicationId(factId);
    data.sourceApplications.push({
      id,
      factId,
      status,
      reason: status === 'waiting' ? 'missing_job_details' : 'attribution_message_multiple_jobs',
    });
    data.sourceFacts.push({ id: factId, platform: 'boss' });
    data.sourceEvents.push({
      id: `synthetic-${i}`,
      factId,
      platform: 'boss',
      accountNamespace: 'synthetic-account',
      conversationKey: 'synthetic-conversation',
      messageId: 'same-message',
      eventType: status === 'waiting' ? 'conversation_observed' : 'resume_observed',
    });
  }
  return data;
}

test('混合消息只勾选等待子项，冲突保留且显示消息与观察两种单位', () => {
  const data = mixedObservationData();
  const html = bossIntegrationView(
    {
      available: true,
      serverManaged: true,
      revision: 1,
      waitingItems: data.sourceApplications.map((row) => ({
        applicationId: row.id,
        status: row.status,
        reason: row.reason,
      })),
    },
    { data },
  );
  assert.match(html, /待核对 1 条消息 · 2 项观察/);
  assert.match(html, /可忽略 1 项等待观察；仍需核对 1 项矛盾观察/);
  const input = html.match(/<input[^>]*data-boss-ignore-item[^>]*>/)?.[0];
  assert.ok(input.includes(data.sourceApplications[0].id));
  assert.ok(!input.includes(data.sourceApplications[1].id));
  assert.doesNotMatch(html, /data-boss-confirm=/);
});

test('处理反馈按当前应用报告剩余问题，不因到达重评时间而自动完成', () => {
  const data = mixedObservationData();
  const feedback = {
    applicationIds: data.sourceApplications.map((row) => row.id),
    label: '岗位已保存',
    checking: true,
    startedAt: 0,
  };
  assert.match(bossProcessingFeedback(data, {}, feedback, 100), /等待本机重新检查/);
  assert.match(
    bossProcessingFeedback(data, {}, feedback, 31000),
    /1 条消息未完成.*1 项等待资料或证据.*1 项归属或资料矛盾/,
  );
  data.sourceApplications[0].status = 'protected';
  data.sourceApplications[0].reason = 'user_ignored_unresolved_observation';
  assert.match(
    bossProcessingFeedback(data, {}, { ...feedback, label: '已忽略 1 项', checking: false }, 31000),
    /已忽略 1 项.*1 项归属或资料矛盾/,
  );
  assert.doesNotMatch(
    bossProcessingFeedback(data, { connectionStale: true }, feedback, 31000),
    /已处理/,
  );
  data.sourceApplications[1].status = 'no_effect';
  assert.match(bossProcessingFeedback(data, {}, feedback, 31000), /所选观察已处理/);
  data.sourceApplications.pop();
  assert.match(bossProcessingFeedback(data, {}, feedback, 31000), /记录已变化/);
});

test('资料确认预览说明有限影响，私有候选转义并保留混合组其他项', () => {
  const html = bossDetailsConfirmationView({
    target: { company: '<候选公司>', role: '<岗位>' },
    externalJobId: 'synthetic',
    canonicalUrl: '<合成链接>',
    messageCount: 1,
    observationCount: 2,
    excludedApplicationIds: ['resume'],
  });
  assert.match(html, /1 条消息 \/ 2 项普通资料观察/);
  assert.match(html, /其他 1 项观察/);
  assert.match(html, /不修改简历状态或招聘阶段/);
  assert.match(html, /&lt;候选公司&gt;/);
  assert.doesNotMatch(html, /<候选公司>|<岗位>|<合成链接>/);
});

test('故障处理区分页面、登录、本地交付和详情阻断，均只给步骤', () => {
  assert.equal(bossFailureGuidance('LOGIN_REQUIRED').command, 'pnpm boss resume');
  assert.equal(bossFailureGuidance('TASK_PAGE_LOST').command, 'pnpm boss recover-page');
  assert.equal(bossFailureGuidance('CHECKPOINT_SAVE_FAILED').command, 'pnpm boss recover-saved');
  assert.equal(
    bossFailureGuidance('DETAIL_TAB_OWNERSHIP_MISMATCH').command,
    'pnpm boss resume-details',
  );
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    tracking: { lifecycle: 'stopped', detailEnrichment: { pending: 1, deferred: 1 } },
  });
  assert.match(html, /系统等待/);
  assert.match(html, /不会自动继续取得/);
  assert.doesNotMatch(html, /badge warn/);
});

test('正式工作区离线时不宣称采集正常或确认处理完成', () => {
  const html = bossIntegrationView(
    { available: true, serverManaged: true, tracking: { lifecycle: 'running' } },
    {
      offline: true,
      data: initialWorkspace().data,
      feedback: { label: '资料已保存', applicationIds: [], startedAt: 0 },
    },
  );
  assert.match(html, /状态待更新|本机状态暂时无法更新/);
  assert.match(html, /尚不能确认剩余问题/);
  assert.doesNotMatch(html, /关闭此页面后仍继续|所选观察已处理/);
  const initial = bossIntegrationView({ available: false }, { offline: true });
  assert.match(initial, /采集状态待确认/);
  assert.doesNotMatch(initial, /本机队列已连接/);
});

test('归属冲突列出同账号同消息的相关岗位，跨账号隔离且删除项只保留线索', () => {
  const data = mixedObservationData();
  Object.assign(data.sourceFacts[1], { accountNamespace: 'account-a', messageId: 'message' });
  for (const [i, row] of data.sourceEvents.entries())
    Object.assign(row, {
      accountNamespace: 'account-a',
      messageId: 'message',
      externalJobId: `job-${i}`,
    });
  data.sourceEvents.push({
    id: 'synthetic-other-account',
    platform: 'boss',
    accountNamespace: 'account-b',
    messageId: 'message',
    externalJobId: 'job-2',
  });
  for (let i = 0; i < 3; i++)
    data.opportunities.push({
      id: `local-${i}`,
      externalId: `job-${i}`,
      company: '合成公司',
      role: `岗位 ${i}`,
      platform: 'BOSS',
      deletedAt: i === 1 ? '2026-10-07T00:00:00Z' : '',
    });
  const related = bossConflictTargets(data, [data.sourceApplications[1].id]);
  assert.deepEqual(
    related.map((row) => [row.opportunityId, row.deleted]),
    [
      ['local-0', false],
      ['local-1', true],
    ],
  );
  const html = bossIntegrationView(
    {
      available: true,
      serverManaged: true,
      waitingItems: [
        {
          applicationId: data.sourceApplications[1].id,
          reason: data.sourceApplications[1].reason,
          status: 'review',
        },
      ],
    },
    { data },
  );
  assert.match(html, /同一消息涉及的本机候选岗位（归属未确认）/);
  assert.match(html, /data-boss-related-job="local-0"/);
  assert.doesNotMatch(html, /data-boss-related-job="local-1"|data-boss-related-job="local-2"/);
  assert.match(html, /已删除，保留核对线索/);
});
