import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBossController } from '../scripts/boss-controller.mjs';
import { BossInbox } from '../scripts/boss-inbox.mjs';
import { emptyControl } from '../scripts/boss-integration.mjs';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-controller-')),
    trackerRoot = join(root, 'tracker'),
    clock = { value: new Date('2026-09-21T00:00:00.000Z') };
  await mkdir(trackerRoot);
  await writeFile(join(trackerRoot, 'tracker.mjs'), '', { mode: 0o600 });
  const calls = [],
    environments = [],
    timers = [],
    behavior = { runner: null },
    workspaceStore = {
      read: async () => ({ workspace: { workspaceVersion: 3 }, revision: 1 }),
    },
    inboxConsumer = {
      runs: 0,
      run: async () => ({ processed: ++inboxConsumer.runs, waiting: 0, isolated: [] }),
      status: () => ({ processed: inboxConsumer.runs }),
    },
    runner = async (_node, args, options) => {
      calls.push(args);
      environments.push(options?.env || {});
      if (behavior.runner) return behavior.runner(args);
      const command = args[1];
      if (command === 'collect-cycle')
        return {
          stdout: JSON.stringify({
            ok: true,
            saved: true,
            checked: true,
            partial: false,
            usage: { historyRequests: 4, domSwitches: 0, detailNavigations: 2 },
          }),
        };
      return { stdout: JSON.stringify({ ok: true, operation: command }) };
    },
    controller = createBossController({
      config: { account: 'main' },
      trackerRoot,
      trackerDataRoot: join(root, 'collector-data'),
      inboxRoot: join(root, 'inbox'),
      workspaceStore,
      inboxConsumer,
      runner,
      now: () => new Date(clock.value),
      setTimer: (callback, delay) => {
        const timer = { callback, delay, unref() {}, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => void (timer.cleared = true),
    });
  await controller.initialize();
  return {
    root,
    calls,
    environments,
    timers,
    controller,
    inboxConsumer,
    behavior,
    advance(ms) {
      clock.value = new Date(clock.value.getTime() + ms);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('单次完整运行使用剩余额度并在采集后消费正式队列', async () => {
  const f = await setup();
  try {
    const status = await f.controller.action('run');
    assert.equal(status.result.usage.historyRequests, 4);
    assert.equal(f.inboxConsumer.runs, 1);
    const cycle = f.calls.find((args) => args[1] === 'collect-cycle');
    assert.deepEqual(cycle.slice(1), [
      'collect-cycle',
      '--history-requests',
      '20',
      '--detail-limit',
      '20',
      '--dom-limit',
      '1',
      '--history-mode',
      'change',
    ]);
    assert.equal(status.budget.historyUsed, 4);
    assert.equal(status.budget.navigationUsed, 2);
    const callIndex = f.calls.indexOf(cycle);
    assert.match(
      f.environments[callIndex].JOB_TRACKER_BOSS_INTERNAL_AUTHORIZATION,
      /^[a-f0-9]{64}$/,
    );
    assert.deepEqual(await readdir(join(f.root, 'inbox', 'controller-authorizations')), []);
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('explicit backfill is one bounded cycle and the next run returns to change mode', async () => {
  const f = await setup();
  try {
    await f.controller.action('backfill');
    f.advance(11_000);
    await f.controller.action('run');
    const cycles = f.calls.filter((args) => args[1] === 'collect-cycle');
    assert.equal(cycles.length, 2);
    assert.deepEqual(
      cycles.map((args) => args.slice(-2)),
      [
        ['--history-mode', 'backfill'],
        ['--history-mode', 'change'],
      ],
    );
    assert.equal(f.controller.status().budget.historyUsed, 8);
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('本地快照恢复的零用量会释放保守预算且不触发用量错误', async () => {
  const f = await setup();
  try {
    f.behavior.runner = async (args) => {
      assert.equal(args[1], 'collect-cycle');
      return {
        stdout: JSON.stringify({
          ok: true,
          recovered: { recovered: 1, batches: 1, events: 1 },
          checked: false,
          batch: null,
          partial: false,
          usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
        }),
      };
    };
    const status = await f.controller.action('run');
    assert.equal(status.result.checked, false);
    assert.deepEqual(status.result.usage, {
      historyRequests: 0,
      domSwitches: 0,
      detailNavigations: 0,
    });
    assert.equal(status.budget.historyUsed, 0);
    assert.equal(status.budget.navigationUsed, 0);
    assert.deepEqual(status.actions, []);
    assert.equal(status.lifecycle, 'stopped');
    assert.equal(status.pauseCode, '');
    assert.equal(status.consecutiveFailures, 0);
    assert.equal(f.inboxConsumer.runs, 1);
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('recover-saved 保持停止且只执行本地恢复和正式队列消费', async () => {
  const f = await setup();
  try {
    const before = f.controller.status();
    f.behavior.runner = async (args) => {
      assert.match(args[0], /boss-integration\.mjs$/);
      assert.deepEqual(args.slice(1), ['recover-saved']);
      return {
        stdout: JSON.stringify({
          ok: true,
          command: 'recover-saved',
          localRecovery: true,
          checked: false,
          counts: { recoveredSnapshots: 1, batches: 1, events: 1 },
          pauseCleared: true,
          requiresResume: false,
          usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
        }),
      };
    };
    const status = await f.controller.action('recover-saved');
    assert.equal(status.lifecycle, 'stopped');
    assert.equal(status.runningCycle, false);
    assert.equal(status.result.localRecovery, true);
    assert.equal(status.result.localImport, 'completed');
    assert.equal(f.inboxConsumer.runs, 1);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(status.actions, before.actions);
    assert.equal(status.budget.historyUsed, before.budget.historyUsed);
    assert.equal(status.budget.navigationUsed, before.budget.navigationUsed);
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('resume-details 只解除采集器详情阻断且不改变生命周期或预算', async () => {
  const f = await setup();
  try {
    f.behavior.runner = async (args) => {
      assert.deepEqual(args.slice(1), ['resume-details', '--account', 'main']);
      return {
        stdout: JSON.stringify({
          ok: true,
          detailEnrichment: {
            status: 'waiting_retry',
            pending: 9,
            deferred: 2,
            isolated: 1,
            nextRetryAt: '2026-09-21T00:30:00.000Z',
            lastError: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
          },
        }),
      };
    };
    const before = f.controller.status(),
      result = await f.controller.action('resume-details');
    assert.equal(result.lifecycle, 'stopped');
    assert.deepEqual(result.actions, before.actions);
    assert.equal(result.budget.navigationUsed, before.budget.navigationUsed);
    assert.equal(result.detailEnrichment.status, 'waiting_retry');
    assert.equal(result.detailEnrichment.isolated, 1);
    assert.equal(f.inboxConsumer.runs, 0);
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('recover-saved 持有生命周期队列，后续 start 不会并发接触浏览器', async () => {
  const f = await setup();
  let releaseRecovery;
  let recoveryStarted;
  const entered = new Promise((resolve) => {
    recoveryStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseRecovery = resolve;
  });
  try {
    f.behavior.runner = async (args) => {
      if (args[1] === 'recover-saved') {
        recoveryStarted();
        await gate;
        return {
          stdout: JSON.stringify({
            ok: true,
            localRecovery: true,
            checked: false,
            counts: { recoveredSnapshots: 1, batches: 1, events: 1 },
            pauseCleared: true,
            requiresResume: false,
            usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
          }),
        };
      }
      return { stdout: JSON.stringify({ ok: true, operation: args[1] }) };
    };
    const recovery = f.controller.action('recover-saved');
    await entered;
    const starting = f.controller.action('start');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.calls.map((args) => args[1]),
      ['recover-saved'],
    );
    releaseRecovery();
    assert.equal((await recovery).lifecycle, 'stopped');
    assert.equal((await starting).lifecycle, 'running');
    assert.deepEqual(
      f.calls.map((args) => args[1]),
      ['recover-saved', 'start'],
    );
  } finally {
    releaseRecovery?.();
    await f.controller.stop();
    await f.cleanup();
  }
});

test('recover-saved 失败保持停止，不伪装为平台恢复暂停', async () => {
  const f = await setup();
  try {
    f.behavior.runner = async () => ({
      stdout: JSON.stringify({ ok: false, error: 'BOSS_SNAPSHOT_STRUCTURE_INVALID' }),
    });
    await assert.rejects(
      () => f.controller.action('recover-saved'),
      /BOSS_SNAPSHOT_STRUCTURE_INVALID/,
    );
    assert.equal(f.controller.status().lifecycle, 'stopped');
    assert.equal(f.controller.status().pauseCode, '');
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('恢复先核验浏览器再清生产者暂停；核验失败不会清暂停', async () => {
  const f = await setup();
  try {
    await f.controller.action('pause');
    await f.controller.action('resume');
    const resumes = f.calls.filter((args) => args[1] === 'resume');
    assert.equal(resumes.length, 2);
    assert.match(resumes[0][0], /tracker\.mjs$/);
    assert.match(resumes[1][0], /boss-integration\.mjs$/);
    await f.controller.action('pause');
    const before = f.calls.length;
    f.behavior.runner = async () => ({
      stdout: JSON.stringify({ ok: false, error: 'BOSS_LOGIN_REQUIRED' }),
    });
    await assert.rejects(() => f.controller.action('resume'), /BOSS_LOGIN_REQUIRED/);
    assert.equal(f.calls.length, before + 1);
    assert.equal(f.controller.status().lifecycle, 'paused');
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('跨服务实例留下的生产者暂停阻止 start，显式 resume 恢复两层', async () => {
  const f = await setup();
  try {
    const inbox = new BossInbox(join(f.root, 'inbox'));
    await inbox.writeControl({ ...emptyControl(), paused: true, pauseCode: 'NOT_LOGGED_IN' });
    await assert.rejects(() => f.controller.action('start'), /BOSS_INTEGRATION_PAUSED/);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.controller.action('resume')).lifecycle, 'running');
    assert.deepEqual(
      f.calls.map((args) => args[1]),
      ['resume', 'resume'],
    );
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('消费者 waiting 和 isolated 不误报正式录入完成', async () => {
  const f = await setup();
  try {
    f.inboxConsumer.run = async () => ({ processed: 0, waiting: 1, isolated: [] });
    let result = (await f.controller.action('run')).result;
    assert.equal(result.localImport, 'pending');
    assert.equal(result.importError, 'WORKSPACE_IMPORT_WAITING');
    f.advance(60_000);
    f.inboxConsumer.run = async () => ({
      processed: 1,
      waiting: 0,
      isolated: [{ code: 'BATCH_INVALID' }],
    });
    result = (await f.controller.action('run')).result;
    assert.equal(result.localImport, 'partial');
    assert.equal(result.importSummary.isolated.length, 1);
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('开始、暂停和恢复是显式动作，停止不关闭任务页', async () => {
  const f = await setup();
  try {
    assert.equal((await f.controller.action('start')).lifecycle, 'running');
    assert.ok(f.calls.some((args) => args[1] === 'start'));
    assert.equal(f.timers.length, 1);
    assert.equal((await f.controller.action('pause')).lifecycle, 'paused');
    assert.equal((await f.controller.action('resume')).lifecycle, 'running');
    assert.ok(f.calls.some((args) => args[1] === 'resume'));
    assert.equal((await f.controller.action('stop')).lifecycle, 'stopped');
    assert.equal(
      f.calls.some((args) => args[1] === 'disconnect'),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('未迁移正式工作区时不会启动或接触采集器', async () => {
  const f = await setup();
  try {
    const original = f.controller;
    // The store is captured by the controller, so switch its read result in place.
    // No tracker call may occur before this guard succeeds.
    const emptyRoot = await mkdtemp(join(tmpdir(), 'job-tracker-controller-empty-'));
    const trackerRoot = join(emptyRoot, 'tracker');
    await mkdir(trackerRoot);
    await writeFile(join(trackerRoot, 'tracker.mjs'), '', { mode: 0o600 });
    let invoked = false;
    const controller = createBossController({
      config: { account: 'main' },
      trackerRoot,
      trackerDataRoot: join(emptyRoot, 'collector-data'),
      inboxRoot: join(emptyRoot, 'inbox'),
      workspaceStore: { read: async () => ({ workspace: null, revision: 0 }) },
      inboxConsumer: { run: async () => {}, status: () => ({}) },
      runner: async () => {
        invoked = true;
        return { stdout: JSON.stringify({ ok: true }) };
      },
    });
    await controller.initialize();
    await assert.rejects(() => controller.action('start'), /WORKSPACE_MIGRATION_REQUIRED/);
    await assert.rejects(() => controller.action('recover-saved'), /WORKSPACE_MIGRATION_REQUIRED/);
    assert.equal(invoked, false);
    await controller.stop();
    await rm(emptyRoot, { recursive: true, force: true });
    await original.stop();
  } finally {
    await f.cleanup();
  }
});

test('正式提交暂时失败只保留本地重试，不重新触发平台采集', async () => {
  const f = await setup();
  try {
    f.inboxConsumer.run = async () => {
      const error = new Error('synthetic local commit failure');
      error.code = 'WORKSPACE_STORAGE_UNAVAILABLE';
      throw error;
    };
    const status = await f.controller.action('run');
    assert.equal(status.result.localImport, 'pending');
    assert.equal(status.result.importError, 'WORKSPACE_STORAGE_UNAVAILABLE');
    assert.equal(status.budget.historyUsed, 4);
    assert.equal(f.calls.filter((args) => args[1] === 'collect-cycle').length, 1);
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('采集器缺少可信用量时不以零次覆盖保守预算', async () => {
  const f = await setup();
  try {
    f.behavior.runner = async (args) => ({
      stdout: JSON.stringify(
        args[1] === 'collect-cycle'
          ? { ok: true, saved: true, checked: true, partial: false }
          : { ok: true },
      ),
    });
    await assert.rejects(() => f.controller.action('run'), /BOSS_USAGE_INVALID/);
    const status = f.controller.status();
    assert.equal(status.lifecycle, 'paused');
    assert.equal(status.budget.historyUsed, 20);
    assert.equal(status.budget.navigationUsed, 21);
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});

test('doctor 只读核验工作区、采集器和生产者状态，不触发采集轮次', async () => {
  const f = await setup();
  try {
    const report = await f.controller.doctor();
    assert.equal(report.diagnostics.workspace.ok, true);
    assert.equal(report.diagnostics.collector.ok, true);
    assert.equal(report.diagnostics.producer.ok, true);
    assert.ok(f.calls.some((args) => args[1] === 'doctor'));
    assert.equal(
      f.calls.some((args) => args[1] === 'collect-cycle'),
      false,
    );
  } finally {
    await f.controller.stop();
    await f.cleanup();
  }
});
