import assert from 'node:assert/strict';
import test from 'node:test';
import { createBossDetailReview } from '../dist/boss/detail-review.js';
import { bossInboxClient } from '../dist/boss/client.js';

const accountNamespace = `boss-geek:${'a'.repeat(64)}`;
const commandId = '00000000-0000-4000-8000-000000000001';
const item = {
  jobId: 'job_a',
  canonicalUrl: 'https://www.zhipin.com/job_detail/job_a.html',
  status: 'isolated',
  taskVersion: 'b'.repeat(64),
  lastAttemptAt: '2026-11-05T01:00:00.000Z',
  canRetry: true,
  canCompleteWithDetails: false,
  matchingOpportunityId: '',
  workspaceRevision: 7,
};
const details = () => ({
  accountNamespace,
  revision: 3,
  lifecycle: 'stopped',
  cycleInProgress: false,
  blocked: false,
  summary: {
    status: 'active',
    pending: 1,
    deferred: 0,
    isolated: 1,
    nextRetryAt: null,
    lastError: 'DETAIL_TITLE_NOT_READY',
  },
  items: [structuredClone(item)],
});
const decidedDetails = (reason = 'not_needed', revision = 4) => ({
  ...details(),
  revision,
  items: [
    {
      ...item,
      status: reason === 'reopen' ? 'isolated' : 'manually_stopped',
      resolution: {
        status: reason === 'reopen' ? 'reopened' : 'stopped',
        reason,
        at: '2026-11-05T02:00:00.000Z',
      },
    },
  ],
});

for (const [original, current] of [
  ['not_needed', 'reopen'],
  ['reopen', 'not_needed'],
]) {
  test(`回查旧 ${original} 请求时保留另一页面更新的 ${current} 决定并准确提示`, async () => {
    const writes = [];
    const review = createBossDetailReview({
      makeId: () => commandId,
      client: {
        details: async () => (original === 'reopen' ? decidedDetails() : details()),
        resolveDetail: async (command) => {
          writes.push(command);
          if (writes.length === 1) throw Error('saved but reply lost');
          return decidedDetails(current, 6);
        },
      },
    });
    await review.resolve('job_a', original, () => true);
    await review.reconcile();
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], writes[0]);
    assert.equal(review.getState().details.items[0].resolution.reason, current);
    assert.equal(review.getState().pendingCommand, null);
    assert.match(review.getState().feedback, /原请求已确认.*当前决定已变化/);
    assert.match(
      review.getState().feedback,
      current === 'reopen' ? /当前已撤销停止/ : /当前已停止详情采集/,
    );
  });
}

test('响应未知保留同一人工命令；刷新不重发，主动核对只复用原幂等键和版本', async () => {
  const writes = [];
  const review = createBossDetailReview({
    makeId: () => commandId,
    client: {
      details: async () => details(),
      resolveDetail: async (command) => {
        writes.push(command);
        if (writes.length === 1) throw new Error('transport lost');
        return decidedDetails();
      },
    },
  });
  await review.resolve('job_a', 'not_needed', () => true);
  assert.match(review.getState().error, /尚未确认/);
  assert.equal(review.getState().pendingCommand.commandId, commandId);
  await review.refresh();
  await review.resolve('job_a', 'not_needed', () => true);
  assert.equal(writes.length, 1);
  await review.reconcile();
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(review.getState().pendingCommand, null);
});

test('本机原子写入结果未确认即使返回409也保留原人工命令', async () => {
  const review = createBossDetailReview({
    makeId: () => commandId,
    client: {
      details: async () => details(),
      resolveDetail: async () => {
        throw Object.assign(Error('write uncertain'), {
          status: 409,
          code: 'BOSS_RUNTIME_WRITE_UNCONFIRMED',
        });
      },
    },
  });
  await review.resolve('job_a', 'not_needed', () => true);
  assert.equal(review.getState().pendingCommand?.commandId, commandId);
  assert.match(review.getState().error, /尚未确认/);
});

test('资料确认绑定新鲜的工作区版本，取消和运行中不提交人工决定', async () => {
  const commands = [];
  let running = false;
  const review = createBossDetailReview({
    makeId: () => commandId,
    client: {
      details: async () => ({
        ...details(),
        lifecycle: running ? 'running' : 'stopped',
        items: [
          {
            ...item,
            canCompleteWithDetails: true,
            matchingOpportunityId: commandId,
            workspaceRevision: 19,
          },
        ],
      }),
      resolveDetail: async (command) => {
        commands.push(command);
        return decidedDetails(command.reason);
      },
    },
  });
  await review.resolve('job_a', 'manual_details', () => false);
  assert.equal(commands.length, 0);
  await review.resolve('job_a', 'manual_details', () => true);
  assert.equal(commands[0].workspaceRevision, 19);
  assert.equal(commands[0].opportunityId, commandId);
  running = true;
  await review.resolve('job_a', 'not_needed', () => assert.fail('运行中不应询问确认'));
  assert.equal(commands.length, 1);
  assert.match(review.getState().error, /先停止/);
});

test('已确认保存后的列表刷新失败保留成功反馈与原清单，不显示空列表', async () => {
  let unavailable = false;
  const review = createBossDetailReview({
    makeId: () => commandId,
    client: {
      details: async () => {
        if (unavailable) throw Error('本机不可达');
        return details();
      },
      resolveDetail: async () => decidedDetails(),
    },
  });
  await review.resolve('job_a', 'not_needed', () => true);
  unavailable = true;
  await review.refresh();
  assert.match(review.getState().feedback, /人工停止/);
  assert.equal(review.getState().details.revision, 4);
  assert.equal(review.getState().stale, true);
});

test('定点重试只发送一次，响应未知时刷新也不重发平台请求', async () => {
  const retries = [];
  let attempted = false;
  const review = createBossDetailReview({
    client: {
      details: async () => ({
        ...details(),
        items: [
          { ...item, lastAttemptAt: attempted ? '2026-11-05T02:00:00.000Z' : item.lastAttemptAt },
        ],
      }),
      retryDetail: async (request) => {
        retries.push(request);
        throw Error('transport lost');
      },
    },
  });
  await review.retry('job_a', () => true);
  assert.deepEqual(retries, [{ accountNamespace, jobId: 'job_a', taskVersion: item.taskVersion }]);
  assert.match(review.getState().error, /尚未确认/);
  await review.refresh();
  await review.retry('job_a', () => assert.fail('未确认的重试不可再发'));
  assert.equal(retries.length, 1);
  attempted = true;
  await review.refresh();
  assert.equal(review.getState().retryUnconfirmed, null);
  assert.match(review.getState().feedback, /已记录.*仍需处理/);
});

test('网页客户端保留人工命令和定点重试的精确账号与任务版本', async () => {
  const requests = [];
  const client = bossInboxClient('c'.repeat(64), commandId, async (path, options) => {
    requests.push({
      path,
      body: options.body && JSON.parse(options.body),
      headers: options.headers,
    });
    return {
      ok: true,
      json: async () => ({
        protocolVersion: 1,
        details: details(),
        status: { result: { retryAttempted: true } },
      }),
    };
  });
  await client.details();
  await client.resolveDetail({
    version: 1,
    commandId,
    expectedRevision: 3,
    accountNamespace,
    jobId: 'job_a',
    taskVersion: item.taskVersion,
    reason: 'not_needed',
    opportunityId: '',
    workspaceRevision: null,
  });
  await client.retryDetail({ accountNamespace, jobId: 'job_a', taskVersion: item.taskVersion });
  assert.equal(requests[0].path, './__local/boss-runtime?view=details');
  assert.equal(requests[1].body.action, 'resolve-detail');
  assert.equal(requests[1].body.command.commandId, commandId);
  assert.deepEqual(requests[2].body, {
    action: 'retry-details',
    jobIds: ['job_a'],
    expectedTask: { accountNamespace, jobId: 'job_a', taskVersion: item.taskVersion },
  });
  assert.equal(requests[2].headers['X-Job-Tracker-Protocol'], '1');
});

test('补查响应丢失后任务已不在清单，只确认待办状态，不冒充资料采集成功', async () => {
  let remaining = true,
    requests = 0;
  const review = createBossDetailReview({
    client: {
      details: async () => ({ ...details(), items: remaining ? [item] : [] }),
      retryDetail: async () => {
        requests++;
        throw Error('reply lost');
      },
    },
  });
  await review.retry('job_a', () => true);
  remaining = false;
  await review.refresh();
  assert.equal(requests, 1);
  assert.equal(review.getState().retryUnconfirmed, null);
  assert.match(review.getState().feedback, /已无.*待办/);
  assert.match(review.getState().feedback, /不代表.*采集成功/);
});

test('停止决定已撤销的补查丢响应后，保留的inactive记录也能解除未知状态', async () => {
  let completed = false,
    requests = 0;
  const review = createBossDetailReview({
    client: {
      details: async () => {
        const current = decidedDetails('reopen');
        if (completed) {
          current.items[0].status = 'inactive';
          current.items[0].lastAttemptAt = '';
          current.items[0].canRetry = false;
        }
        return current;
      },
      retryDetail: async () => {
        requests++;
        throw Error('reply lost');
      },
    },
  });
  await review.retry('job_a', () => true);
  assert.ok(review.getState().retryUnconfirmed);
  completed = true;
  await review.refresh();
  assert.equal(requests, 1);
  assert.equal(review.getState().retryUnconfirmed, null);
  assert.equal(review.getState().details.items[0].resolution.reason, 'reopen');
  assert.match(review.getState().feedback, /已无.*待办/);
  assert.match(review.getState().feedback, /不代表.*采集成功/);
});

test('服务明确未执行补查时解除锁定，下一次须重新读取和确认', async () => {
  for (const code of [
    'DETAIL_TASK_CHANGED',
    'DETAIL_ACCOUNT_CHANGED',
    'DETAIL_TASK_MANUALLY_STOPPED',
    'DETAIL_RETRY_TARGETS_INVALID',
  ]) {
    let reads = 0,
      requests = 0,
      confirmations = 0;
    const review = createBossDetailReview({
      client: {
        details: async () => {
          reads++;
          return details();
        },
        retryDetail: async () => {
          requests++;
          throw Object.assign(Error('target changed before execution'), {
            status: 409,
            code,
            retryAttempted: false,
          });
        },
      },
    });
    const confirm = () => {
      confirmations++;
      return true;
    };
    await review.retry('job_a', confirm);
    assert.equal(review.getState().retryUnconfirmed, null, code);
    assert.match(review.getState().error, /未执行.*刷新.*核对/);
    await review.refresh();
    assert.equal(requests, 1);
    await review.retry('job_a', confirm);
    assert.equal(reads, 3);
    assert.equal(confirmations, 2);
    assert.equal(requests, 2);
  }
});

test('没有明确未执行依据的409保留未知补查，客户端保留服务的执行标志', async () => {
  const client = bossInboxClient('c'.repeat(64), commandId, async () => ({
    ok: false,
    status: 409,
    json: async () => ({ code: 'DETAIL_TASK_CHANGED', retryAttempted: false }),
  }));
  await assert.rejects(
    client.retryDetail({ accountNamespace, jobId: item.jobId, taskVersion: item.taskVersion }),
    (error) => error.retryAttempted === false && error.code === 'DETAIL_TASK_CHANGED',
  );
  const review = createBossDetailReview({
    client: {
      details: async () => details(),
      retryDetail: async () => {
        throw Object.assign(Error('unconfirmed'), { status: 409, code: 'DETAIL_TASK_CHANGED' });
      },
    },
  });
  await review.retry('job_a', () => true);
  await review.refresh();
  assert.ok(review.getState().retryUnconfirmed);
});

test('人工停止先读取当前任务，明确确认后提交绑定账号、版本和持久幂等键的命令', async () => {
  const calls = [];
  const review = createBossDetailReview({
    makeId: () => commandId,
    client: {
      details: async () => {
        calls.push('read');
        return details();
      },
      resolveDetail: async (command) => {
        calls.push(command);
        const next = details();
        next.revision = 4;
        next.items[0].status = 'manually_stopped';
        next.items[0].resolution = {
          status: 'stopped',
          reason: 'not_needed',
          at: '2026-11-05T02:00:00.000Z',
        };
        return next;
      },
      retryDetail: async () => assert.fail('人工操作不能读取平台'),
    },
  });
  await review.resolve('job_a', 'not_needed', async (row) => {
    assert.equal(row.taskVersion, item.taskVersion);
    calls.push('confirm');
    return true;
  });
  assert.deepEqual(calls, [
    'read',
    'confirm',
    {
      version: 1,
      commandId,
      expectedRevision: 3,
      accountNamespace,
      jobId: 'job_a',
      taskVersion: item.taskVersion,
      reason: 'not_needed',
      opportunityId: '',
      workspaceRevision: null,
    },
  ]);
  assert.equal(review.getState().details.items[0].status, 'manually_stopped');
  assert.match(review.getState().feedback, /人工停止/);
  assert.equal(review.getState().pendingCommand, null);
});
