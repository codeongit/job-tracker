import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBossController } from '../scripts/boss/control/controller.mjs';
import { handleBossControllerApi } from '../scripts/boss/control/controller-api.mjs';
import {
  compareLoadedSnapshotsV2,
  conversationKeyV2,
} from '../collector/boss/materials/model-v2.mjs';
import { saveEnvelope } from '../collector/boss/persistence/snapshot-save.mjs';
import {
  normalizeRuntimeState,
  recordDetailFailure,
  saveRuntimeState,
  loadRuntimeState,
} from '../collector/boss/persistence/runtime-state.mjs';
import { emptyData } from '../dist/model.js';
import { bindBossAccount } from '../dist/boss/application/integration.js';
import { bossInboxClient } from '../dist/boss/client.js';
import { consumeBossInternalAuthorization } from '../scripts/boss/control/internal-auth.mjs';
import { fairDetailInputs, currentDetailSummary } from '../collector/boss/details/detail-phase.mjs';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const STAMP = '2026-11-05T04:00:00.000Z';
const URL = 'https://www.zhipin.com/job_detail/job_a.html';
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'boss-resolution-api-'));
  const directory = join(root, 'collector', 'main');
  await mkdir(directory, { recursive: true });
  const envelope = compareLoadedSnapshotsV2(null, {
    capturedAt: STAMP,
    scope: 'loaded-chat-list',
    accountNamespace: ACCOUNT,
    records: [
      {
        key: conversationKeyV2(ACCOUNT, '100', '0'),
        platformIdentity: { friendId: '100', friendSource: '0', uniqueId: '100-0' },
        contact: '合成联系人',
        company: '合成公司',
        title: 'Recruiter',
        preview: '合成消息',
        timeLabel: '12:00',
        unread: null,
        latestMessageId: 'message-100',
        outgoingReceipt: { status: 'unknown', label: null, source: null },
        jobAssociation: { jobId: 'job_a', detailUrl: URL },
        observedJobName: null,
      },
    ],
    coverage: {
      loadedRows: 1,
      loadedDataRows: 1,
      renderedRows: 1,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  }).envelope;
  await saveEnvelope(directory, envelope);
  let runtime = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  for (let i = 0; i < 4; i++)
    runtime = recordDetailFailure(runtime, {
      jobId: 'job_a',
      error: 'DETAIL_TITLE_NOT_READY',
      stage: 'read',
      at: STAMP,
    });
  await saveRuntimeState(directory, runtime);
  const workspace = {
    revision: 7,
    workspaceId: WORKSPACE,
    workspace: { data: bindBossAccount(emptyData(), ACCOUNT, WORKSPACE, STAMP), pending: null },
  };
  let platformCalls = 0;
  const behavior = { runner: null, read: null };
  const create = () =>
    createBossController({
      config: { account: 'main' },
      trackerDataRoot: join(root, 'collector'),
      inboxRoot: join(root, 'inbox'),
      runtimeStoreOptions: options.runtimeStoreOptions,
      workspaceStore: {
        read: async () => (behavior.read ? behavior.read() : structuredClone(workspace)),
      },
      runner: async (...args) => {
        platformCalls++;
        if (behavior.runner) return behavior.runner(...args);
        throw Error('platform not allowed');
      },
      now: () => new Date(STAMP),
    });
  const controller = create();
  await controller.initialize();
  return {
    root,
    directory,
    envelope,
    workspace,
    controller,
    create,
    behavior,
    platformCalls: () => platformCalls,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
async function request(controller, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, {
    url: body ? '/__local/boss-runtime' : '/__local/boss-runtime?view=details',
    method: body ? 'POST' : 'GET',
    headers: {
      host: '127.0.0.1:9180',
      origin: 'http://127.0.0.1:9180',
      'content-type': 'application/json',
      'x-job-tracker-protocol': '1',
    },
  });
  let status, result;
  await handleBossControllerApi(
    req,
    {
      writeHead: (v) => {
        status = v;
      },
      end: (v) => {
        result = JSON.parse(v);
      },
    },
    { controller },
  );
  return { status, result };
}
function decision(details, patch = {}) {
  const item = details.items[0];
  return {
    version: 1,
    commandId: '10000000-0000-4000-8000-000000000001',
    expectedRevision: details.revision,
    accountNamespace: details.accountNamespace,
    jobId: item.jobId,
    taskVersion: item.taskVersion,
    reason: 'not_needed',
    opportunityId: '',
    workspaceRevision: null,
    ...patch,
  };
}
test('真实API与控制器列出故障，人工停止/撤销并重启保留且不访问平台', async () => {
  const f = await fixture();
  try {
    const initial = await request(f.controller);
    assert.equal(initial.status, 200);
    const details = initial.result.details;
    assert.equal(details.items[0].status, 'isolated');
    assert.equal(details.items[0].canonicalUrl, URL);
    assert.equal(details.items[0].attempts, 4);
    assert.equal(details.items[0].canCreateOpportunity, true);
    const command = decision(details);
    const stopped = await request(f.controller, { action: 'resolve-detail', command });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.result.details.items[0].status, 'manually_stopped');
    assert.equal(stopped.result.details.summary.isolated, 0);
    assert.equal(stopped.result.details.summary.lastError, null);
    assert.equal(f.controller.status().detailEnrichment.lastError, null);
    const retry = await request(f.controller, { action: 'retry-details', jobIds: ['job_a'] });
    assert.equal(retry.status, 409);
    assert.equal(retry.result.code, 'DETAIL_TASK_MANUALLY_STOPPED');
    assert.equal(retry.result.retryAttempted, false);
    const restarted = f.create();
    await restarted.initialize();
    const replay = await request(restarted, { action: 'resolve-detail', command });
    assert.equal(replay.status, 200);
    assert.equal(replay.result.details.revision, 1);
    const reopened = await request(restarted, {
      action: 'resolve-detail',
      command: decision(replay.result.details, {
        commandId: '10000000-0000-4000-8000-000000000002',
        reason: 'reopen',
      }),
    });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.result.details.items[0].status, 'isolated');
    assert.equal(reopened.result.details.items[0].attempts, 4);
    assert.equal((await loadRuntimeState(f.directory)).detail.tasks[0].attempts, 4);
    assert.equal(f.platformCalls(), 0);
  } finally {
    await f.cleanup();
  }
});

const TARGET = '20000000-0000-4000-8000-000000000001';
const opportunity = () => ({
  id: TARGET,
  company: '合成公司',
  role: '人工补齐岗位',
  platform: 'BOSS',
  url: URL,
  externalId: '',
  stage: '已触达',
  createdAt: STAMP,
  updatedAt: STAMP,
});
test('人工资料完成核对正式版本和唯一精确目标，不改正式字段，恢复资料后本机决定仍保留', async () => {
  const f = await fixture();
  try {
    f.workspace.workspace.data.opportunities.push(opportunity());
    const details = (await request(f.controller)).result.details;
    assert.equal(details.items[0].canCompleteWithDetails, true);
    const command = decision(details, {
      reason: 'manual_details',
      opportunityId: TARGET,
      workspaceRevision: 7,
    });
    const saved = await request(f.controller, { action: 'resolve-detail', command });
    assert.equal(saved.status, 200);
    assert.equal(saved.result.details.items[0].resolution.workspaceRevision, 7);
    assert.equal(f.workspace.workspace.data.opportunities[0].externalId, '');
    // Restoring business data does not restore a permission to read the platform.
    f.workspace.workspace.data.opportunities = [];
    f.workspace.revision = 8;
    const restored = (await request(f.controller)).result.details;
    assert.equal(restored.items[0].status, 'manually_stopped');
    assert.equal(restored.items[0].canCompleteWithDetails, false);
    assert.equal(restored.items[0].matchingOpportunityId, '');
    const replay = await request(f.controller, { action: 'resolve-detail', command });
    assert.equal(replay.status, 200);
    assert.equal(replay.result.details.revision, 1);
    f.workspace.workspace.data.sourceBindings = [];
    assert.equal(
      (await request(f.controller, { action: 'resolve-detail', command })).result.code,
      'DETAIL_ACCOUNT_CHANGED',
    );
    assert.equal(f.platformCalls(), 0);
  } finally {
    await f.cleanup();
  }
});

test('人工资料确认拒绝版本变化、缺项、重复、删除、错链与外账号绑定', async () => {
  for (const mutation of [
    (f) => {
      f.workspace.revision = 8;
    },
    (f) => {
      f.workspace.workspace.data.opportunities[0].role = '';
    },
    (f) => {
      f.workspace.workspace.data.opportunities.push({
        ...opportunity(),
        id: '20000000-0000-4000-8000-000000000002',
      });
    },
    (f) => {
      f.workspace.workspace.data.opportunities[0].deletedAt = STAMP;
    },
    (f) => {
      f.workspace.workspace.data.opportunities[0].externalId = 'other_job';
    },
    (f) => {
      f.workspace.workspace.data.sourceBindings.push({
        kind: 'opportunity',
        accountNamespace: `boss-geek:${'b'.repeat(64)}`,
        externalJobId: 'job_a',
        canonicalUrl: URL,
        opportunityId: TARGET,
      });
    },
  ]) {
    const f = await fixture();
    try {
      f.workspace.workspace.data.opportunities.push(opportunity());
      const details = (await request(f.controller)).result.details;
      const command = decision(details, {
        reason: 'manual_details',
        opportunityId: TARGET,
        workspaceRevision: 7,
      });
      mutation(f);
      const result = await request(f.controller, { action: 'resolve-detail', command });
      assert.equal(result.status, 409);
      assert.equal(result.result.code, 'DETAIL_WORKSPACE_CHANGED');
      assert.equal(f.controller.status().detailDecisionRevision, 0);
      assert.equal(f.platformCalls(), 0);
    } finally {
      await f.cleanup();
    }
  }
});

test('任务变化拒绝新决定和网页重试，已保存命令仍可回查', async () => {
  const f = await fixture();
  try {
    const details = (await request(f.controller)).result.details;
    const command = decision(details);
    const state = await loadRuntimeState(f.directory);
    await saveRuntimeState(
      f.directory,
      recordDetailFailure(state, {
        jobId: 'job_a',
        error: 'DETAIL_TAB_UNEXPECTED_URL',
        stage: 'read',
        at: '2026-11-05T04:01:00.000Z',
      }),
    );
    assert.equal(
      (await request(f.controller, { action: 'resolve-detail', command })).result.code,
      'DETAIL_TASK_CHANGED',
    );
    const retry = await request(f.controller, {
      action: 'retry-details',
      jobIds: ['job_a'],
      expectedTask: {
        accountNamespace: ACCOUNT,
        jobId: 'job_a',
        taskVersion: command.taskVersion,
      },
    });
    assert.equal(retry.result.code, 'DETAIL_TASK_CHANGED');
    assert.equal(retry.result.retryAttempted, false);
    const updated = (await request(f.controller)).result.details;
    const current = decision(updated);
    assert.equal(
      (await request(f.controller, { action: 'resolve-detail', command: current })).status,
      200,
    );
    await saveRuntimeState(f.directory, state);
    assert.equal(
      (await request(f.controller, { action: 'resolve-detail', command: current })).status,
      200,
    );
    assert.equal(f.platformCalls(), 0);
  } finally {
    await f.cleanup();
  }
});

test('真实API在暂停状态拒绝定点重试并明确本次未开始', async () => {
  const f = await fixture();
  try {
    await f.controller.action('pause');
    const result = await request(f.controller, { action: 'retry-details', jobIds: ['job_a'] });
    assert.equal(result.status, 409);
    assert.equal(result.result.code, 'BOSS_INTEGRATION_PAUSED');
    assert.equal(result.result.retryAttempted, false);
    assert.equal(f.platformCalls(), 0);
  } finally {
    await f.cleanup();
  }
});

test('真实API在账号、目标及审阅格式变化时明确拒绝重试且零平台调用', async () => {
  const f = await fixture();
  try {
    const details = (await request(f.controller)).result.details;
    const expectedTask = {
      accountNamespace: ACCOUNT,
      jobId: 'job_a',
      taskVersion: details.items[0].taskVersion,
    };
    for (const [patch, code] of [
      [
        { expectedTask: { ...expectedTask, accountNamespace: `boss-geek:${'b'.repeat(64)}` } },
        'DETAIL_ACCOUNT_CHANGED',
      ],
      [{ jobIds: ['job_b'] }, 'DETAIL_RETRY_TARGETS_INVALID'],
      [{ jobIds: [] }, 'DETAIL_RETRY_TARGETS_INVALID'],
      [
        { expectedTask: { ...expectedTask, taskVersion: 'invalid' } },
        'DETAIL_DECISION_COMMAND_INVALID',
      ],
    ]) {
      const result = await request(f.controller, {
        action: 'retry-details',
        jobIds: ['job_a'],
        expectedTask,
        ...patch,
      });
      assert.equal(result.status, 409);
      assert.equal(result.result.code, code);
      assert.equal(result.result.retryAttempted, false);
      assert.equal(f.platformCalls(), 0);
    }
  } finally {
    await f.cleanup();
  }
});

const successfulRetry = () => ({
  stdout: JSON.stringify({
    ok: true,
    usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 1 },
  }),
});

test('真实API在运行或额度不足时拒绝新增重试，不增加平台调用', async () => {
  const f = await fixture();
  try {
    f.behavior.runner = async () => successfulRetry();
    await f.controller.action('start');
    const startedCalls = f.platformCalls();
    const running = await request(f.controller, { action: 'retry-details', jobIds: ['job_a'] });
    assert.equal(running.result.code, 'DETAIL_RETRY_REQUIRES_STOPPED');
    assert.equal(running.result.retryAttempted, false);
    assert.equal(f.platformCalls(), startedCalls);
    await f.controller.action('stop');
    assert.equal(
      (await request(f.controller, { action: 'retry-details', jobIds: ['job_a'] })).status,
      200,
    );
    const retryCalls = f.platformCalls();
    const unavailable = await request(f.controller, { action: 'retry-details', jobIds: ['job_a'] });
    assert.equal(unavailable.result.code, 'DETAIL_RETRY_BUDGET_UNAVAILABLE');
    assert.equal(unavailable.result.retryAttempted, false);
    assert.equal(f.platformCalls(), retryCalls);
  } finally {
    await f.controller.action('stop');
    await f.cleanup();
  }
});

test('真实API在已有在途轮次时明确新重试未开始，不加入或再发平台动作', async () => {
  const f = await fixture();
  let release, entered;
  const gate = new Promise((resolve) => (release = resolve));
  const ready = new Promise((resolve) => (entered = resolve));
  let pending;
  try {
    f.behavior.runner = async () => {
      entered();
      await gate;
      return successfulRetry();
    };
    pending = request(f.controller, { action: 'retry-details', jobIds: ['job_a'] });
    await ready;
    const result = await request(f.controller, { action: 'retry-details', jobIds: ['job_a'] });
    assert.equal(result.result.code, 'BOSS_CYCLE_IN_PROGRESS');
    assert.equal(result.result.retryAttempted, false);
    assert.equal(f.platformCalls(), 1);
    release();
    assert.equal((await pending).status, 200);
  } finally {
    release();
    await pending;
    await f.cleanup();
  }
});

test('真实API不把执行阶段同码错误或未知故障当成明确未开始', async () => {
  for (const code of [
    'DETAIL_RETRY_TARGETS_INVALID',
    'DETAIL_RETRY_BUDGET_UNAVAILABLE',
    'DETAIL_ACCOUNT_CHANGED',
    'BOSS_INTEGRATION_PAUSED',
    'SYNTHETIC_EXECUTION_FAILED',
  ]) {
    const f = await fixture();
    try {
      f.behavior.runner = async () => ({
        stdout: JSON.stringify({
          ok: false,
          error: code,
          usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
        }),
      });
      const result = await request(f.controller, { action: 'retry-details', jobIds: ['job_a'] });
      assert.equal(result.result.code, code);
      assert.equal(Object.hasOwn(result.result, 'retryAttempted'), false);
      assert.equal(f.platformCalls(), 1);
    } finally {
      await f.cleanup();
    }
  }
});

test('网页客户端经过真实API和控制器保存、回查及撤销，仅交换固定命令', async () => {
  const f = await fixture();
  try {
    const client = bossInboxClient('f'.repeat(64), WORKSPACE, async (path, options) => {
      assert.equal(options.headers['X-Job-Tracker-Session'], 'f'.repeat(64));
      assert.equal(options.headers['X-Job-Tracker-Protocol'], '1');
      assert.equal(
        path,
        options.method === 'POST'
          ? './__local/boss-runtime'
          : './__local/boss-runtime?view=details',
      );
      const result = await request(
        f.controller,
        options.body ? JSON.parse(options.body) : undefined,
      );
      return { ok: result.status === 200, status: result.status, json: async () => result.result };
    });
    const original = await client.details();
    const command = decision(original);
    const saved = await client.resolveDetail(command);
    assert.equal(saved.items[0].status, 'manually_stopped');
    assert.equal((await client.resolveDetail(command)).revision, 1);
    const reopened = await client.resolveDetail(
      decision(saved, { commandId: '10000000-0000-4000-8000-000000000002', reason: 'reopen' }),
    );
    assert.equal(reopened.items[0].status, 'isolated');
    assert.equal(reopened.summary.isolated, 1);
    assert.equal(f.platformCalls(), 0);
  } finally {
    await f.cleanup();
  }
});

test('人工停止集合进入正常轮次的精确票据与详情选择，未读取的岗位不计成功', async () => {
  const f = await fixture();
  try {
    const details = (await request(f.controller)).result.details;
    await request(f.controller, { action: 'resolve-detail', command: decision(details) });
    f.behavior.runner = async (_node, args, options) => {
      assert.equal(args[1], 'collect-cycle');
      assert.equal(args.at(-2), '--detail-policy');
      const detailPolicy = JSON.parse(args.at(-1));
      assert.deepEqual(detailPolicy, { accountNamespace: ACCOUNT, excludedJobIds: ['job_a'] });
      await consumeBossInternalAuthorization(
        join(f.root, 'inbox'),
        options.env.JOB_TRACKER_BOSS_INTERNAL_AUTHORIZATION,
        {
          command: 'collect-cycle',
          historyRequests: 20,
          detailLimit: 20,
          domLimit: 1,
          historyMode: 'change',
          detailPolicy,
        },
        { now: () => new Date(STAMP) },
      );
      const runtime = await loadRuntimeState(f.directory);
      const input = fairDetailInputs(f.envelope, {
        runtime,
        excludedJobIds: detailPolicy.excludedJobIds,
      });
      assert.equal(input.pendingJobs, 0);
      assert.deepEqual(input.selectedIds, []);
      return {
        stdout: JSON.stringify({
          ok: true,
          detailEnrichment: currentDetailSummary(f.envelope, runtime, {
            excludedJobIds: detailPolicy.excludedJobIds,
          }),
          usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
        }),
      };
    };
    const result = await request(f.controller, { action: 'run' });
    assert.equal(result.status, 200);
    assert.equal(result.result.status.budget.navigationUsed, 0);
    assert.equal(result.result.status.detailEnrichment.pending, 0);
    assert.equal((await loadRuntimeState(f.directory)).detail.tasks[0].attempts, 4);
  } finally {
    await f.cleanup();
  }
});

test('已人工处理目标不再合格仍保留记录，撤销只回到inactive且不清原失败', async () => {
  const f = await fixture();
  try {
    const details = (await request(f.controller)).result.details;
    await request(f.controller, { action: 'resolve-detail', command: decision(details) });
    const snapshot = structuredClone(f.envelope.snapshot);
    snapshot.capturedAt = '2026-11-05T04:01:00.000Z';
    snapshot.records[0].observedJobName = '后来取得的合成岗位名';
    const updated = compareLoadedSnapshotsV2(f.envelope, snapshot).envelope;
    await saveEnvelope(f.directory, updated);
    const stopped = (await request(f.controller)).result.details;
    assert.equal(stopped.items.length, 1);
    assert.equal(stopped.items[0].status, 'manually_stopped');
    const reopened = await request(f.controller, {
      action: 'resolve-detail',
      command: decision(stopped, {
        commandId: '10000000-0000-4000-8000-000000000002',
        reason: 'reopen',
      }),
    });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.result.details.items[0].status, 'inactive');
    assert.equal(reopened.result.details.items[0].canRetry, false);
    assert.equal(reopened.result.details.items[0].attempts, 4);
    assert.equal(reopened.result.details.summary.pending, 0);
    assert.equal(f.platformCalls(), 0);
  } finally {
    await f.cleanup();
  }
});

test('成功保存不依赖附属状态重读，rename后未知结果保留同请求回查语义', async () => {
  const f = await fixture();
  try {
    const details = (await request(f.controller)).result.details;
    let reads = 0;
    f.behavior.read = async () => {
      if (++reads > 1) throw Error('synthetic refresh failure');
      return structuredClone(f.workspace);
    };
    const saved = await request(f.controller, {
      action: 'resolve-detail',
      command: decision(details),
    });
    assert.equal(saved.status, 200);
    assert.equal(reads, 1);
    assert.equal(saved.result.details.revision, 1);
  } finally {
    await f.cleanup();
  }
  let fail = true;
  const uncertain = await fixture({
    runtimeStoreOptions: {
      sync: async () => {
        if (fail) throw Error('synthetic barrier failure');
      },
    },
  });
  try {
    const details = (await request(uncertain.controller)).result.details;
    const command = decision(details);
    const result = await request(uncertain.controller, { action: 'resolve-detail', command });
    assert.equal(result.result.code, 'BOSS_RUNTIME_WRITE_UNCONFIRMED');
    assert.equal(Object.hasOwn(result.result, 'committed'), false);
    assert.equal((await request(uncertain.controller)).result.code, 'BOSS_RUNTIME_WRITER_FAULT');
    assert.equal(uncertain.controller.status().writerFault, true);
    const locked = await request(uncertain.controller, { action: 'resolve-detail', command });
    assert.equal(locked.result.code, 'BOSS_RUNTIME_WRITER_FAULT');
    assert.equal(Object.hasOwn(locked.result, 'committed'), false);
    fail = false;
    const restarted = uncertain.create();
    await restarted.initialize();
    const confirmed = await request(restarted, { action: 'resolve-detail', command });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.result.details.revision, 1);
    assert.equal(confirmed.result.decision.replayed, true);
    assert.equal(uncertain.platformCalls(), 0);
  } finally {
    await uncertain.cleanup();
  }
});
