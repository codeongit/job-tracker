import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BossRuntime,
  BossRuntimeStateStore,
  validateBossRuntimeState,
} from '../scripts/boss-runtime.mjs';

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-runtime-')),
    clock = { value: new Date('2026-09-21T00:00:00.000Z') },
    timers = [],
    runtime = new BossRuntime({
      statePath: join(root, 'runtime.json'),
      executeCycle:
        options.executeCycle ||
        (async () => ({
          usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
        })),
      prepareStart: options.prepareStart,
      verifyResume: options.verifyResume,
      recoverPage: options.recoverPage,
      now: () => new Date(clock.value),
      setTimer: (callback, delay) => {
        const timer = { callback, delay, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        timer.cleared = true;
      },
    });
  await runtime.initialize();
  return {
    root,
    runtime,
    clock,
    timers,
    advance(ms) {
      clock.value = new Date(clock.value.getTime() + ms);
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('服务重启取消旧运行授权，但保留动作预算', async () => {
  const f = await fixture();
  try {
    const store = new BossRuntimeStateStore(join(f.root, 'runtime.json')),
      state = validateBossRuntimeState({
        ...(await store.read()),
        lifecycle: 'running',
        sessionId: `boss-session-${'a'.repeat(32)}`,
        startedAt: '2026-09-21T00:00:00.000Z',
        actions: [{ kind: 'history', count: 7, at: '2026-09-21T00:00:00.000Z' }],
      });
    await store.write(state);
    const restarted = new BossRuntime({
      statePath: join(f.root, 'runtime.json'),
      executeCycle: async () => ({ usage: {} }),
      now: () => new Date(f.clock.value),
    });
    const status = await restarted.initialize();
    assert.equal(status.lifecycle, 'stopped');
    assert.equal(status.sessionId, '');
    assert.equal(status.budget.historyUsed, 7);
  } finally {
    await f.cleanup();
  }
});

test('旧运行状态自动补入详情摘要且不改变暂停和预算', () => {
  const migrated = validateBossRuntimeState({
    format: 'job-tracker-boss-runtime',
    version: 1,
    lifecycle: 'paused',
    sessionId: '',
    startedAt: '',
    updatedAt: '2026-09-21T00:00:00.000Z',
    lastTickAt: '2026-09-21T00:00:00.000Z',
    nextTickAt: '',
    lastSuccessAt: '',
    pauseCode: 'DETAIL_TAB_OPERATION_FAILED',
    consecutiveFailures: 3,
    actions: [{ kind: 'detail', count: 49, at: '2026-09-21T00:00:00.000Z' }],
  });
  assert.equal(migrated.pauseCode, 'DETAIL_TAB_OPERATION_FAILED');
  assert.equal(migrated.actions[0].count, 49);
  assert.deepEqual(migrated.detailEnrichment, {
    status: 'active',
    pending: 0,
    deferred: 0,
    isolated: 0,
    nextRetryAt: null,
    lastError: null,
  });
});

test('详情降级重复出现也不累计账号失败或暂停', async () => {
  const detail = {
    status: 'waiting_retry',
    pending: 12,
    deferred: 1,
    isolated: 0,
    nextRetryAt: '2026-09-21T00:30:00.000Z',
    lastError: 'DETAIL_TAB_CHANGED',
  };
  const f = await fixture({
    executeCycle: async () => ({
      partial: true,
      error: 'DETAIL_TAB_CHANGED',
      failureScope: 'detail',
      detailEnrichment: detail,
      usage: { historyRequests: 2, domSwitches: 0, detailNavigations: 1 },
    }),
  });
  try {
    for (let index = 0; index < 3; index += 1) {
      await f.runtime.requestCycle();
      f.advance(10_000);
    }
    const status = f.runtime.status();
    assert.equal(status.lifecycle, 'stopped');
    assert.equal(status.consecutiveFailures, 0);
    assert.equal(status.lastSuccessAt, '2026-09-21T00:00:20.000Z');
    assert.deepEqual(status.detailEnrichment, detail);
    assert.equal(status.budget.navigationUsed, 3);
  } finally {
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('详情维护串行等待采集且不改变生命周期和预算', async () => {
  let release, started;
  const gate = new Promise((resolve) => (release = resolve)),
    entered = new Promise((resolve) => (started = resolve)),
    f = await fixture({
      executeCycle: async () => {
        started();
        await gate;
        return { usage: { historyRequests: 1, domSwitches: 0, detailNavigations: 1 } };
      },
    });
  try {
    const cycle = f.runtime.requestCycle();
    await entered;
    let maintained = false;
    const maintenance = f.runtime.runMaintenance(async () => {
      maintained = true;
      return {
        detailEnrichment: {
          status: 'active',
          pending: 4,
          deferred: 0,
          isolated: 1,
          nextRetryAt: null,
          lastError: 'DETAIL_TAB_CHANGED',
        },
      };
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(maintained, false);
    release();
    await Promise.all([cycle, maintenance]);
    const status = f.runtime.status();
    assert.equal(status.lifecycle, 'stopped');
    assert.equal(status.budget.historyUsed, 1);
    assert.equal(status.budget.navigationUsed, 1);
    assert.equal(status.detailEnrichment.isolated, 1);
  } finally {
    release();
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('手动开始只准备一次，同一轮期间的触发合并且不补跑积压', async () => {
  let prepares = 0,
    release,
    markCycleStarted,
    cycles = 0;
  const gate = new Promise((resolve) => (release = resolve)),
    cycleStarted = new Promise((resolve) => (markCycleStarted = resolve)),
    f = await fixture({
      prepareStart: async () => prepares++,
      executeCycle: async () => {
        cycles++;
        markCycleStarted();
        await gate;
        return { usage: { historyRequests: 2, domSwitches: 1, detailNavigations: 1 } };
      },
    });
  try {
    await f.runtime.start();
    assert.equal(prepares, 1);
    assert.equal(f.timers.length, 1);
    const scheduled = f.timers[0].callback();
    // runCycle persists its conservative budget before invoking executeCycle.
    // Under the full parallel suite that fsync can legitimately take more than
    // the old 100 ms polling window, so synchronize on the actual lifecycle
    // event instead of wall-clock timing.
    await cycleStarted;
    const duplicate = f.runtime.requestCycle({ scheduled: true });
    assert.equal(cycles, 1);
    release();
    await Promise.all([scheduled, duplicate]);
    assert.equal(cycles, 1);
    assert.equal(f.runtime.status().budget.historyUsed, 2);
    assert.equal(f.runtime.status().budget.navigationUsed, 2);
    assert.equal(f.timers.length, 2);
    assert.equal(f.timers.at(-1).delay, 2 * 60 * 1000);
  } finally {
    release();
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('并发 start 串行化且只执行一次浏览器准备', async () => {
  let prepares = 0,
    releasePrepare,
    markPreparing;
  const prepareGate = new Promise((resolve) => (releasePrepare = resolve)),
    preparing = new Promise((resolve) => (markPreparing = resolve)),
    f = await fixture({
      prepareStart: async () => {
        prepares++;
        markPreparing();
        await prepareGate;
      },
    });
  try {
    const first = f.runtime.start(),
      second = f.runtime.start();
    await preparing;
    assert.equal(prepares, 1);
    releasePrepare();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.lifecycle, 'running');
    assert.equal(right.lifecycle, 'running');
    assert.equal(prepares, 1);
    assert.equal(f.timers.length, 1);
  } finally {
    releasePrepare();
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('one-off 轮次未结束时 start 不并发执行浏览器准备', async () => {
  let prepares = 0,
    releaseCycle,
    markCycleStarted;
  const cycleGate = new Promise((resolve) => (releaseCycle = resolve)),
    cycleStarted = new Promise((resolve) => (markCycleStarted = resolve)),
    f = await fixture({
      prepareStart: async () => prepares++,
      executeCycle: async () => {
        markCycleStarted();
        await cycleGate;
        return { usage: { historyRequests: 1, domSwitches: 0, detailNavigations: 0 } };
      },
    });
  try {
    const cycle = f.runtime.requestCycle();
    await cycleStarted;
    const starting = f.runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prepares, 0);
    releaseCycle();
    await Promise.all([cycle, starting]);
    assert.equal(prepares, 1);
    assert.equal(f.runtime.status().lifecycle, 'running');
  } finally {
    releaseCycle();
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('暂停中的轮次未结束时 resume 不并发执行 CDP 核验', async () => {
  let verifies = 0,
    releaseCycle,
    markCycleStarted;
  const cycleGate = new Promise((resolve) => (releaseCycle = resolve)),
    cycleStarted = new Promise((resolve) => (markCycleStarted = resolve)),
    f = await fixture({
      verifyResume: async () => verifies++,
      executeCycle: async () => {
        markCycleStarted();
        await cycleGate;
        return { usage: { historyRequests: 1, domSwitches: 0, detailNavigations: 0 } };
      },
    });
  try {
    const cycle = f.runtime.requestCycle();
    await cycleStarted;
    await f.runtime.pause();
    const resuming = f.runtime.resume();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(verifies, 0);
    releaseCycle();
    await Promise.all([cycle, resuming]);
    assert.equal(verifies, 1);
    assert.equal(f.runtime.status().lifecycle, 'running');
  } finally {
    releaseCycle();
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('暂停中的轮次未结束时 recover-page 不并发操作任务页', async () => {
  let recovered = 0,
    releaseCycle,
    markCycleStarted;
  const cycleGate = new Promise((resolve) => (releaseCycle = resolve)),
    cycleStarted = new Promise((resolve) => (markCycleStarted = resolve)),
    f = await fixture({
      recoverPage: async () => ++recovered,
      executeCycle: async () => {
        markCycleStarted();
        await cycleGate;
        return { usage: { historyRequests: 1, domSwitches: 0, detailNavigations: 0 } };
      },
    });
  try {
    const cycle = f.runtime.requestCycle();
    await cycleStarted;
    await f.runtime.pause();
    const recovering = f.runtime.recoverPage();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recovered, 0);
    releaseCycle();
    await Promise.all([cycle, recovering]);
    assert.equal(recovered, 1);
    assert.equal(f.runtime.status().lifecycle, 'paused');
  } finally {
    releaseCycle();
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('先发出的 pause 阻止随后并发的采集预约', async () => {
  let cycles = 0;
  const f = await fixture({
    executeCycle: async () => {
      cycles++;
      return { usage: { historyRequests: 1, domSwitches: 0, detailNavigations: 0 } };
    },
  });
  try {
    const pause = f.runtime.pause(),
      cycle = f.runtime.requestCycle();
    await pause;
    await assert.rejects(() => cycle, /BOSS_INTEGRATION_PAUSED/);
    assert.equal(cycles, 0);
    assert.equal(f.runtime.status().budget.historyUsed, 0);
  } finally {
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('运行中人工 pause 不会被晚到的致命轮次结算覆盖', async () => {
  let releaseCycle, markCycleStarted;
  const cycleGate = new Promise((resolve) => (releaseCycle = resolve)),
    cycleStarted = new Promise((resolve) => (markCycleStarted = resolve)),
    f = await fixture({
      executeCycle: async () => {
        markCycleStarted();
        await cycleGate;
        throw Object.assign(new Error('login'), {
          code: 'BOSS_LOGIN_REQUIRED',
          usage: { historyRequests: 3, domSwitches: 0, detailNavigations: 1 },
        });
      },
    });
  try {
    await f.runtime.start();
    const cycle = f.runtime.requestCycle();
    await cycleStarted;
    await f.runtime.pause('BOSS_PAUSED_BY_USER');
    releaseCycle();
    await assert.rejects(() => cycle, /login/);
    const status = f.runtime.status();
    assert.equal(status.lifecycle, 'paused');
    assert.equal(status.pauseCode, 'BOSS_PAUSED_BY_USER');
    assert.equal(status.budget.historyUsed, 3);
    assert.equal(status.budget.navigationUsed, 1);
    assert.equal(f.timers.filter((timer) => !timer.cleared).length, 0);
  } finally {
    releaseCycle();
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('stop 等待已预约轮次结算且最终状态不会被轮次覆盖', async () => {
  let releaseCycle,
    markCycleStarted,
    stopSettled = false;
  const cycleGate = new Promise((resolve) => (releaseCycle = resolve)),
    cycleStarted = new Promise((resolve) => (markCycleStarted = resolve)),
    f = await fixture({
      executeCycle: async () => {
        markCycleStarted();
        await cycleGate;
        return { usage: { historyRequests: 4, domSwitches: 0, detailNavigations: 1 } };
      },
    });
  try {
    await f.runtime.start();
    const cycle = f.runtime.requestCycle();
    await cycleStarted;
    const stopping = f.runtime.stop().then((value) => {
      stopSettled = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopSettled, false);
    releaseCycle();
    await Promise.all([cycle, stopping]);
    const status = f.runtime.status();
    assert.equal(status.lifecycle, 'stopped');
    assert.equal(status.consecutiveFailures, 0);
    assert.equal(status.budget.historyUsed, 4);
    assert.equal(status.budget.navigationUsed, 1);
    assert.equal(f.timers.filter((timer) => !timer.cleared).length, 0);
  } finally {
    releaseCycle();
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('服务关闭保留已有暂停原因，运行态则只撤销本实例授权', async () => {
  const paused = await fixture();
  try {
    await paused.runtime.pause('DETAIL_TAB_OPERATION_FAILED');
    const status = await paused.runtime.shutdown();
    assert.equal(status.lifecycle, 'paused');
    assert.equal(status.pauseCode, 'DETAIL_TAB_OPERATION_FAILED');
  } finally {
    await paused.runtime.stop();
    await paused.cleanup();
  }

  const running = await fixture();
  try {
    await running.runtime.start();
    const status = await running.runtime.shutdown();
    assert.equal(status.lifecycle, 'stopped');
    assert.equal(status.sessionId, '');
    assert.equal(status.pauseCode, '');
  } finally {
    await running.runtime.stop();
    await running.cleanup();
  }
});

test('并发 resume 后 stop 保持生命周期调用顺序', async () => {
  let verifies = 0,
    releaseVerify,
    markVerifying;
  const verifyGate = new Promise((resolve) => (releaseVerify = resolve)),
    verifying = new Promise((resolve) => (markVerifying = resolve)),
    f = await fixture({
      verifyResume: async () => {
        verifies++;
        markVerifying();
        await verifyGate;
      },
    });
  try {
    await f.runtime.pause();
    const resume = f.runtime.resume(),
      stop = f.runtime.stop();
    await verifying;
    assert.equal(verifies, 1);
    releaseVerify();
    const [resumed, stopped] = await Promise.all([resume, stop]);
    assert.equal(resumed.lifecycle, 'running');
    assert.equal(stopped.lifecycle, 'stopped');
    assert.equal(f.runtime.status().lifecycle, 'stopped');
    assert.equal(f.timers.filter((timer) => !timer.cleared).length, 0);
  } finally {
    releaseVerify();
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('连接失败不虚构平台用量，连续三次失败进入持久暂停', async () => {
  const f = await fixture({
    executeCycle: async () => {
      const error = new Error('local connection');
      error.code = 'BOSS_CDP_UNAVAILABLE';
      error.usage = { historyRequests: 0, domSwitches: 0, detailNavigations: 0 };
      throw error;
    },
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) f.advance(10_000);
      await assert.rejects(() => f.runtime.requestCycle(), /local connection/);
    }
    const status = f.runtime.status();
    assert.equal(status.lifecycle, 'paused');
    assert.equal(status.pauseCode, 'BOSS_CDP_UNAVAILABLE');
    assert.equal(status.budget.historyUsed, 0);
    assert.equal(status.budget.navigationUsed, 0);
  } finally {
    await f.cleanup();
  }
});

test('定时轮次失败被消费，服务继续下一轮并在第三次暂停', async () => {
  let calls = 0;
  const f = await fixture({
    executeCycle: async () => {
      calls++;
      throw Object.assign(new Error('synthetic failure'), {
        code: 'BOSS_CDP_UNAVAILABLE',
        usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
      });
    },
  });
  try {
    await f.runtime.start();
    for (let index = 0; index < 3; index++) {
      await assert.doesNotReject(() => f.timers[index].callback());
      f.advance(120000);
    }
    assert.equal(calls, 3);
    assert.equal(f.runtime.status().lifecycle, 'paused');
    assert.equal(f.timers.length, 3);
    await assert.rejects(() => f.runtime.requestCycle(), /BOSS_INTEGRATION_PAUSED/);
    assert.equal(calls, 3);
  } finally {
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('登录类错误立即暂停；恢复页只由显式动作调用', async () => {
  let recovered = 0;
  const f = await fixture({
    executeCycle: async () => {
      const error = new Error('login');
      error.code = 'BOSS_LOGIN_REQUIRED';
      error.usage = { historyRequests: 0, domSwitches: 0, detailNavigations: 0 };
      throw error;
    },
    recoverPage: async () => ++recovered,
  });
  try {
    await assert.rejects(() => f.runtime.requestCycle(), /login/);
    assert.equal(f.runtime.status().lifecycle, 'paused');
    const result = await f.runtime.recoverPage();
    assert.equal(result.recovered, true);
    assert.equal(recovered, 1);
  } finally {
    await f.cleanup();
  }
});

test('平台动作前先持久化保守预算，正常完成后替换为实际用量', async () => {
  let release, started;
  const entered = new Promise((resolve) => (started = resolve));
  const gate = new Promise((resolve) => (release = resolve)),
    f = await fixture({
      executeCycle: async () => {
        started();
        await gate;
        return {
          usage: {
            historyRequests: 2,
            domSwitches: 0,
            detailNavigations: 1,
            cdpReconnects: 0,
          },
        };
      },
    });
  try {
    const cycle = f.runtime.requestCycle();
    // The executor can start only after reservation is durable. Synchronize on
    // that boundary instead of assuming disk fsync finishes within 100 ms.
    await Promise.race([
      entered,
      cycle.then(() => {
        throw new Error('CYCLE_FINISHED_WITHOUT_EXECUTION');
      }),
    ]);
    const durable = await new BossRuntimeStateStore(join(f.root, 'runtime.json')).read();
    assert.equal(durable.actions.find((row) => row.kind === 'history')?.count, 20);
    assert.equal(
      durable.actions
        .filter((row) => row.kind !== 'history')
        .reduce((total, row) => total + row.count, 0),
      21,
    );
    release();
    await cycle;
    assert.equal(f.runtime.status().budget.historyUsed, 2);
    assert.equal(f.runtime.status().budget.navigationUsed, 1);
  } finally {
    release();
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('成功或部分结果的用量缺失、负数或超出授权时保留预留并立即暂停', async () => {
  for (const result of [
    { partial: false },
    {
      partial: true,
      error: 'BOSS_CDP_UNAVAILABLE',
      usage: { historyRequests: -1, domSwitches: 0, detailNavigations: 0 },
    },
    {
      partial: false,
      usage: { historyRequests: 21, domSwitches: 0, detailNavigations: 0 },
    },
    {
      partial: false,
      usage: {
        historyRequests: 0,
        domSwitches: 0,
        detailNavigations: 0,
        unknown: 0,
      },
    },
    {
      partial: false,
      usage: {
        historyRequests: 0,
        domSwitches: 0,
        detailNavigations: 0,
        cdpReconnects: -1,
      },
    },
  ]) {
    const f = await fixture({ executeCycle: async () => result });
    try {
      await assert.rejects(() => f.runtime.requestCycle(), /BOSS_USAGE_INVALID/);
      const status = f.runtime.status();
      assert.equal(status.lifecycle, 'paused');
      assert.equal(status.pauseCode, 'BOSS_USAGE_INVALID');
      assert.equal(status.budget.historyUsed, 20);
      assert.equal(status.budget.navigationUsed, 21);
    } finally {
      await f.cleanup();
    }
  }
});

test('错误结果只有完整且未超授权的用量才替换保守预留', async () => {
  const f = await fixture({
    executeCycle: async () => {
      throw Object.assign(new Error('malformed usage'), {
        code: 'BOSS_TRACKER_EXEC_FAILED',
        usage: { historyRequests: 0, domSwitches: 0 },
      });
    },
  });
  try {
    await assert.rejects(() => f.runtime.requestCycle(), /malformed usage/);
    assert.equal(f.runtime.status().budget.historyUsed, 20);
    assert.equal(f.runtime.status().budget.navigationUsed, 21);
  } finally {
    await f.cleanup();
  }
});

test('十秒内重复手动轮次跨运行时实例去重，周期轮次不受防抖影响', async () => {
  let calls = 0;
  const f = await fixture({
    executeCycle: async () => {
      calls++;
      return { usage: { historyRequests: 1, domSwitches: 0, detailNavigations: 0 } };
    },
  });
  try {
    await f.runtime.requestCycle();
    f.advance(1_000);
    const duplicate = await f.runtime.requestCycle();
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.reason, 'BOSS_MANUAL_DEBOUNCED');
    assert.equal(calls, 1);
    assert.equal(f.runtime.status().budget.historyUsed, 1);

    const restarted = new BossRuntime({
      statePath: join(f.root, 'runtime.json'),
      executeCycle: async () => {
        calls++;
        return { usage: { historyRequests: 1, domSwitches: 0, detailNavigations: 0 } };
      },
      now: () => new Date(f.clock.value),
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
    });
    await restarted.initialize();
    assert.equal((await restarted.requestCycle()).deduplicated, true);
    assert.equal(calls, 1);

    // Scheduled ticks use their own cadence and are never suppressed by the
    // manual debounce marker.
    await restarted.start();
    await restarted.requestCycle({ scheduled: true });
    assert.equal(calls, 2);
    await restarted.stop();
  } finally {
    await f.runtime.stop();
    await f.cleanup();
  }
});

test('结果未知时按错误携带的实际用量保守记账', async () => {
  const f = await fixture({
    executeCycle: async () => {
      const error = new Error('request outcome unknown');
      error.code = 'BOSS_TRACKER_EXEC_FAILED';
      error.usage = { historyRequests: 5, domSwitches: 0, detailNavigations: 1 };
      throw error;
    },
  });
  try {
    await assert.rejects(() => f.runtime.requestCycle(), /request outcome unknown/);
    assert.equal(f.runtime.status().budget.historyUsed, 5);
    assert.equal(f.runtime.status().budget.navigationUsed, 1);
  } finally {
    await f.cleanup();
  }
});

test('小时预算耗尽时报告精确的下一次释放时间', async () => {
  const f = await fixture();
  try {
    await f.runtime.persist({
      actions: [
        { kind: 'history', count: 60, at: '2026-09-21T00:00:00.000Z' },
        { kind: 'detail', count: 60, at: '2026-09-21T00:00:00.000Z' },
      ],
    });
    const budget = f.runtime.status().budget;
    assert.equal(budget.historyRequests, 0);
    assert.equal(budget.detailActions, 0);
    assert.equal(budget.domActions, 0);
    assert.equal(budget.nextHistoryAt, '2026-09-21T01:00:00.000Z');
    assert.equal(budget.nextNavigationAt, '2026-09-21T01:00:00.000Z');
  } finally {
    await f.cleanup();
  }
});

test('详情和 DOM 动作跨轮次保留最小间隔', async () => {
  const f = await fixture();
  try {
    await f.runtime.persist({
      actions: [
        { kind: 'detail', count: 1, at: '2026-09-21T00:00:00.000Z' },
        { kind: 'dom', count: 1, at: '2026-09-21T00:00:00.000Z' },
      ],
    });
    let budget = f.runtime.status().budget;
    assert.equal(budget.detailActions, 0);
    assert.equal(budget.domActions, 0);
    assert.equal(budget.nextDetailAt, '2026-09-21T00:00:10.000Z');
    assert.equal(budget.nextDomAt, '2026-09-21T00:00:30.000Z');
    f.advance(10_000);
    budget = f.runtime.status().budget;
    assert.equal(budget.detailActions, 20);
    assert.equal(budget.domActions, 0);
    f.advance(20_000);
    budget = f.runtime.status().budget;
    assert.equal(budget.detailActions, 20);
    assert.equal(budget.domActions, 1);
  } finally {
    await f.cleanup();
  }
});
