import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BossRuntime,
  BossRuntimeStateStore,
  BOSS_RUNTIME_MAX_BYTES,
  validateBossRuntimeState,
} from '../scripts/boss/control/runtime.mjs';
import { normalizeDetailDecisionCommand } from '../dist/boss/contracts/detail-decision.js';

const accountNamespace = `boss-geek:${'a'.repeat(64)}`;
const stamp = '2026-11-05T04:00:00.000Z';
const command = (patch = {}) => ({
  version: 1,
  commandId: '10000000-0000-4000-8000-000000000001',
  expectedRevision: 0,
  accountNamespace,
  jobId: 'job_a',
  taskVersion: 'b'.repeat(64),
  reason: 'not_needed',
  opportunityId: '',
  workspaceRevision: null,
  ...patch,
});

test('旧状态升级保留原件、未知字段拒写，rename后回查屏障恢复后才确认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-decisions-store-'));
  try {
    const path = join(root, 'tracking.json');
    const store = new BossRuntimeStateStore(path);
    const initial = await store.read(new Date(stamp));
    const { detailDecisions, ...legacy } = initial;
    legacy.version = 1;
    const original = JSON.stringify(legacy);
    await writeFile(path, original);
    assert.equal((await store.read()).version, 2);
    assert.equal(await readFile(`${path}.v1.json`, 'utf8'), original);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
    await assert.rejects(store.write({ ...initial, unknown: true }), /INVALID/);
    let checks = 0;
    const recovered = new BossRuntimeStateStore(path, {
      afterRename: async () => {
        checks++;
        throw Error('synthetic post-rename failure');
      },
    });
    const saved = await recovered.write({ ...initial, lastTickAt: stamp });
    assert.equal(saved.lastTickAt, stamp);
    assert.equal(checks, 1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await recovered.read()).lastTickAt, stamp);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
const verify = { verifyAccount: async () => {}, verifyTask: async () => {} };

test('人工停止及撤销持久保留，原命令重放不再次判断已变化任务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-decisions-'));
  try {
    let calls = 0;
    const create = () =>
      new BossRuntime({
        statePath: join(root, 'tracking.json'),
        now: () => new Date(stamp),
        executeCycle: async () => {
          calls++;
        },
      });
    const runtime = create();
    await runtime.initialize();
    const result = await runtime.resolveDetail(command(), verify);
    assert.equal(result.revision, 1);
    assert.equal(result.record.status, 'stopped');
    const restarted = create();
    await restarted.initialize();
    const replay = await restarted.resolveDetail(command(), {
      ...verify,
      verifyTask: async () => assert.fail('不得重验旧任务版本'),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, 1);
    await restarted.resolveDetail(
      command({
        commandId: '10000000-0000-4000-8000-000000000002',
        expectedRevision: 1,
        reason: 'reopen',
      }),
      verify,
    );
    const saved = await new BossRuntimeStateStore(join(root, 'tracking.json')).read();
    assert.equal(saved.detailDecisions.records[0].status, 'reopened');
    assert.equal(saved.detailDecisions.commands.length, 2);
    assert.equal(saved.lifecycle, 'stopped');
    assert.deepEqual(saved.actions, []);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('无法确认rename后屏障时锁住写者，重启可回查已保存命令且不覆盖决定', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-decisions-fault-'));
  try {
    const path = join(root, 'tracking.json');
    let fail = true,
      platform = 0;
    const runtime = new BossRuntime({
      statePath: path,
      now: () => new Date(stamp),
      executeCycle: async () => {
        platform++;
      },
      prepareStart: async () => {
        platform++;
      },
      storeOptions: {
        sync: async () => {
          if (fail) throw Error('synthetic fsync');
        },
      },
    });
    await runtime.initialize();
    await assert.rejects(runtime.resolveDetail(command(), verify), {
      code: 'BOSS_RUNTIME_WRITE_UNCONFIRMED',
    });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).detailDecisions.revision, 1);
    fail = false;
    await assert.rejects(runtime.stop(), { code: 'BOSS_RUNTIME_WRITER_FAULT' });
    await assert.rejects(runtime.start(), { code: 'BOSS_RUNTIME_WRITER_FAULT' });
    assert.equal(platform, 0);
    const restored = new BossRuntime({
      statePath: path,
      now: () => new Date(stamp),
      executeCycle: async () => {
        platform++;
      },
    });
    await restored.initialize();
    assert.equal((await restored.resolveDetail(command(), verify)).replayed, true);
    assert.equal(restored.detailDecisionState().records[0].status, 'stopped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('人工命令拒绝旧revision、同键异内容、非停止和在途状态，重放仍先核验账号', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-decisions-conflicts-'));
  let finish;
  const runtime = new BossRuntime({
    statePath: join(root, 'tracking.json'),
    now: () => new Date(stamp),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    executeCycle: async () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({ usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 } });
      }),
  });
  try {
    await runtime.initialize();
    await assert.rejects(runtime.resolveDetail(command({ expectedRevision: 1 }), verify), {
      code: 'DETAIL_DECISION_REVISION_CONFLICT',
    });
    await runtime.resolveDetail(command(), verify);
    await assert.rejects(runtime.resolveDetail(command({ reason: 'reopen' }), verify), {
      code: 'DETAIL_DECISION_COMMAND_CONFLICT',
    });
    await assert.rejects(
      runtime.resolveDetail(command(), {
        ...verify,
        verifyAccount: async () => {
          throw Error('account changed');
        },
      }),
      /account changed/,
    );
    await runtime.start();
    await assert.rejects(runtime.resolveDetail(command(), verify), {
      code: 'DETAIL_DECISION_REQUIRES_STOPPED',
    });
    await runtime.stop();
    const cycle = runtime.requestCycle();
    await assert.rejects(runtime.resolveDetail(command(), verify), {
      code: 'BOSS_CYCLE_IN_PROGRESS',
    });
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    finish();
    await cycle;
    assert.equal(runtime.detailDecisionState().revision, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('持久账本读写使用相同完整5MiB上限，历史回执不淘汰，未知版本和字段拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boss-decisions-capacity-'));
  try {
    const path = join(root, 'tracking.json'),
      store = new BossRuntimeStateStore(path),
      initial = await store.read(new Date(stamp));
    const record = {
      accountNamespace,
      jobId: 'job_a',
      status: 'stopped',
      reason: 'not_needed',
      at: stamp,
      opportunityId: '',
      workspaceRevision: null,
    };
    const state = (count) => ({
      ...initial,
      detailDecisions: {
        revision: count,
        records: [record],
        commands: Array.from({ length: count }, (_, i) => ({
          commandId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          digest: 'b'.repeat(64),
          revision: i + 1,
          record,
        })),
      },
    });
    const small = state(6000),
      large = state(15000);
    assert.ok(Buffer.byteLength(JSON.stringify(small, null, 2) + '\n') < BOSS_RUNTIME_MAX_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(large, null, 2) + '\n') > BOSS_RUNTIME_MAX_BYTES);
    await store.write(small);
    assert.equal((await store.read()).detailDecisions.commands.length, 6000);
    const before = await readFile(path, 'utf8');
    await assert.rejects(store.write(large), { code: 'BOSS_RUNTIME_TOO_LARGE' });
    assert.equal(await readFile(path, 'utf8'), before);
    for (const malformed of [
      { ...initial, version: 3 },
      { ...initial, detailDecisions: { ...initial.detailDecisions, unknown: true } },
      { ...initial, history: { ...initial.history, unknown: true } },
    ])
      assert.throws(() => validateBossRuntimeState(malformed), /INVALID/);
    for (const patch of [
      { jobId: 123 },
      { taskVersion: ['b'.repeat(64)] },
      { reason: 'not_needed', workspaceRevision: 7 },
      { unknown: true },
    ])
      assert.throws(() => normalizeDetailDecisionCommand(command(patch)), {
        code: 'DETAIL_DECISION_COMMAND_INVALID',
      });
    await writeFile(path, JSON.stringify(large, null, 2) + '\n');
    await assert.rejects(store.read(), { code: 'BOSS_RUNTIME_PATH_INVALID' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
