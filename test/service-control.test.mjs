import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveServiceRuntime,
  readServiceRuntime,
  removeServiceRuntime,
  readServiceLaunch,
  claimServiceLaunch,
} from '../scripts/service-runtime.mjs';
import { EventEmitter } from 'node:events';
import {
  serviceStatus,
  stopService,
  startService,
  auditWorkspace,
} from '../scripts/service-control.mjs';

const INSTANCE = '00000000-0000-4000-8000-000000000001',
  WORKSPACE = '00000000-0000-4000-8000-000000000002';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-service-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveServiceRuntime(root, {
    version: 1,
    instanceId: INSTANCE,
    workspaceId: WORKSPACE,
    port: 4317,
    controlToken: 'a'.repeat(64),
  });
  return root;
}
test('服务控制记录私有且只能清理匹配实例的记录', async (t) => {
  const root = await fixture(t);
  assert.equal((await lstat(join(root, 'runtime.json'))).mode & 0o777, 0o600);
  await removeServiceRuntime(root, WORKSPACE);
  assert.ok(await readServiceRuntime(root));
  await removeServiceRuntime(root, INSTANCE);
  assert.equal(await readServiceRuntime(root), null);
});
test('端口被其他服务接管时status/stop拒绝，不发停止请求', async (t) => {
  const root = await fixture(t);
  let requests = 0;
  const fetcher = async () => {
    requests++;
    return Response.json({
      serviceKind: 'job-tracker-local',
      instanceId: WORKSPACE,
      workspaceId: WORKSPACE,
    });
  };
  assert.equal((await serviceStatus(root, fetcher)).code, 'SERVICE_OWNERSHIP_MISMATCH');
  assert.equal((await stopService(root, fetcher)).running, false);
  assert.equal(requests, 2);
});
test('停止只向匹配实例发送带会话和控制令牌的HTTP请求', async (t) => {
  const root = await fixture(t);
  const fetcher = async (url, options) => {
    if (url.endsWith('/health'))
      return Response.json({
        serviceKind: 'job-tracker-local',
        instanceId: INSTANCE,
        workspaceId: WORKSPACE,
        protocolVersion: 1,
      });
    if (url.endsWith('/session'))
      return Response.json({ instanceId: INSTANCE, session: 'b'.repeat(64) });
    assert.equal(url, 'http://127.0.0.1:4317/__local/service/stop');
    assert.equal(options.headers['X-Job-Tracker-Protocol'], '1');
    assert.equal(JSON.parse(options.body).instanceId, INSTANCE);
    return Response.json({ stopping: true });
  };
  assert.equal((await stopService(root, fetcher)).stopping, true);
});

test('服务初始化超过三秒时start仍等待实际就绪，不误报未启动', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-service-start-'));
  let timer, publication, launchedInstance;
  t.after(async () => {
    clearTimeout(timer);
    await publication;
    await rm(root, { recursive: true, force: true });
  });
  const spawnProcess = (_executable, args) => {
    launchedInstance = args[args.indexOf('--launch-id') + 1];
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unref = () => {};
    queueMicrotask(() => {
      child.emit('spawn');
      timer = setTimeout(() => {
        publication = saveServiceRuntime(root, {
          version: 1,
          instanceId: launchedInstance,
          workspaceId: WORKSPACE,
          port: 4317,
          controlToken: 'a'.repeat(64),
        });
      }, 4000);
    });
    return child;
  };
  const fetcher = async () =>
    Response.json({
      serviceKind: 'job-tracker-local',
      instanceId: launchedInstance,
      workspaceId: WORKSPACE,
      protocolVersion: 1,
      tracking: 'stopped',
    });
  const status = await startService({ root, spawnProcess, fetcher });
  assert.equal(status.running, true);
  assert.equal(status.tracking, 'stopped');
});

test('服务状态报告启动耗时，旧记录缺失指标不当作零', async (t) => {
  const root = await fixture(t);
  const fetcher = async () =>
    Response.json({
      serviceKind: 'job-tracker-local',
      instanceId: INSTANCE,
      workspaceId: WORKSPACE,
    });
  const old = await serviceStatus(root, fetcher);
  assert.equal(old.processStartedAt, null);
  assert.equal(old.startupDurationMs, null);
  const runtime = await readServiceRuntime(root);
  await saveServiceRuntime(root, {
    ...runtime,
    startedAt: '2026-10-03T14:09:49.883Z',
    processStartedAt: '2026-10-03T14:06:24.000Z',
    startupDurationMs: 205883,
  });
  const status = await serviceStatus(root, fetcher);
  assert.equal(status.processStartedAt, '2026-10-03T14:06:24.000Z');
  assert.equal(status.readyAt, '2026-10-03T14:09:49.883Z');
  assert.equal(status.startupDurationMs, 205883);
  await writeFile(
    join(root, 'runtime.json'),
    JSON.stringify({ ...runtime, processStartedAt: 'invalid', startupDurationMs: 0 }),
  );
  await assert.rejects(readServiceRuntime(root), /SERVICE_RUNTIME_INVALID/);
});

function startingRuntime(overrides = {}) {
  return {
    version: 2,
    instanceId: INSTANCE,
    workspaceId: null,
    pid: process.pid,
    port: 4317,
    controlToken: 'a'.repeat(64),
    phase: 'starting',
    processStartedAt: '2026-10-06T00:00:00.000Z',
    readyAt: null,
    startupDurationMs: null,
    progress: { stage: 'history_validation', completed: 50, total: 6000 },
    failureCode: null,
    ...overrides,
  };
}

test('启动阶段报告进度及耗时，重复start和stop均不创建或结束进程', async (t) => {
  const root = await fixture(t);
  await saveServiceRuntime(root, startingRuntime());
  let requests = 0,
    spawns = 0;
  const options = {
    now: () => Date.parse('2026-10-06T00:00:45.000Z'),
    isProcessAlive: () => true,
  };
  const fetcher = async () => {
    requests++;
    throw new Error('No listener yet');
  };
  const status = await serviceStatus(root, fetcher, options);
  assert.equal(status.phase, 'starting');
  assert.equal(status.elapsedMs, 45000);
  assert.deepEqual(status.progress, { stage: 'history_validation', completed: 50, total: 6000 });
  assert.equal((await stopService(root, fetcher, options)).code, 'SERVICE_STARTING');
  const repeated = await startService({
    root,
    fetcher,
    ...options,
    spawnProcess: () => {
      spawns++;
    },
  });
  assert.equal(repeated.phase, 'starting');
  assert.equal(spawns, 0);
  assert.equal(requests, 0);
  assert.equal(JSON.stringify(status).includes('a'.repeat(64)), false);
});

test('首次start等待三十秒后明确正在启动，spawn至runtime窗口重复start不再spawn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-service-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let currentTime = Date.parse('2026-10-06T00:00:00.000Z'),
    spawns = 0;
  const spawnProcess = () => {
    spawns++;
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const options = {
    root,
    spawnProcess,
    now: () => currentTime,
    pollMs: 10000,
    wait: async (milliseconds) => {
      currentTime += milliseconds;
    },
    fetcher: async () => {
      throw new Error('Not listening');
    },
  };
  const status = await startService(options);
  assert.equal(status.phase, 'starting');
  assert.equal(status.elapsedMs, 30000);
  assert.match(status.message, /正在启动/);
  assert.equal((await startService(options)).phase, 'starting');
  assert.equal(spawns, 1);
  assert.equal((await lstat(join(root, 'launch.lock'))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, 'launch.lock', 'owner.json'))).mode & 0o777, 0o600);
});

test('并发start只有一个调用能够创建服务进程', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-service-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let spawns = 0;
  const spawnProcess = () => {
    spawns++;
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const results = await Promise.all([
    startService({ root, spawnProcess, waitMs: 0 }),
    startService({ root, spawnProcess, waitMs: 0 }),
  ]);
  assert.equal(spawns, 1);
  assert.ok(results.every((result) => result.phase === 'starting'));
});

test('PID存在不能确认ready，HTTP不可达的现存进程不会触发重复spawn', async (t) => {
  const root = await fixture(t);
  await saveServiceRuntime(
    root,
    startingRuntime({
      workspaceId: WORKSPACE,
      phase: 'ready',
      readyAt: '2026-10-06T00:00:01.000Z',
      startupDurationMs: 1000,
      progress: { stage: 'ready' },
    }),
  );
  let spawns = 0;
  const result = await startService({
    root,
    fetcher: async () => {
      throw new Error('Unavailable');
    },
    isProcessAlive: () => true,
    spawnProcess: () => {
      spawns++;
    },
  });
  assert.equal(result.running, false);
  assert.equal(result.code, 'SERVICE_UNAVAILABLE');
  assert.equal(spawns, 0);
});

test('无法证明旧启动意图的子进程身份时保留意图并阻止新启动', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-service-uncertain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await claimServiceLaunch(root, {
    version: 1,
    instanceId: INSTANCE,
    launcherPid: 12345,
    childPid: null,
    port: 4317,
    processStartedAt: '2026-10-06T00:00:00.000Z',
  });
  let spawns = 0;
  const result = await startService({
    root,
    isProcessAlive: () => false,
    spawnProcess: () => {
      spawns++;
    },
  });
  assert.equal(result.code, 'SERVICE_LAUNCH_UNCONFIRMED');
  assert.equal(result.blocked, true);
  assert.equal(spawns, 0);
  assert.equal((await readServiceLaunch(root)).instanceId, INSTANCE);
});

test('已确认spawn失败只报告固定错误码并释放本次意图', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-service-spawn-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spawnProcess = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('Synthetic private error details')));
    return child;
  };
  await assert.rejects(startService({ root, spawnProcess }), /SERVICE_SPAWN_FAILED/);
  assert.equal(await readServiceLaunch(root), null);
});

test('runtime v2拒绝未知阶段、未来字段、原始失败内容及null文件', async (t) => {
  const root = await fixture(t);
  await saveServiceRuntime(root, startingRuntime());
  for (const invalid of [
    startingRuntime({ progress: { stage: 'private-stage' } }),
    startingRuntime({ privateData: 'Synthetic private content' }),
    startingRuntime({ phase: 'failed', failureCode: 'Synthetic private error details' }),
  ])
    await assert.rejects(saveServiceRuntime(root, invalid), /SERVICE_RUNTIME_INVALID/);
  assert.equal((await readServiceRuntime(root)).phase, 'starting');
  await writeFile(join(root, 'runtime.json'), 'null');
  await assert.rejects(readServiceRuntime(root), /SERVICE_RUNTIME_INVALID/);
});

test('显式离线audit使用存储interface且成功或失败均释放写者', async () => {
  const calls = [];
  const result = await auditWorkspace({
    root: '/private/tmp/synthetic-workspace',
    createStore: (root) => ({
      initialize: async () => {
        calls.push(['initialize', root]);
      },
      auditHistory: async () => {
        calls.push(['audit']);
        return { revision: 3, commits: 3, commands: 3 };
      },
      close: async () => {
        calls.push(['close']);
      },
    }),
  });
  assert.deepEqual(result, { audited: true, revision: 3, commits: 3, commands: 3 });
  assert.deepEqual(
    calls.map((row) => row[0]),
    ['initialize', 'audit', 'close'],
  );
  let closed = false;
  await assert.rejects(
    auditWorkspace({
      createStore: () => ({
        initialize: async () => {
          throw Object.assign(new Error('busy'), { code: 'WORKSPACE_WRITER_BUSY' });
        },
        close: async () => {
          closed = true;
        },
      }),
    }),
    { code: 'WORKSPACE_WRITER_BUSY' },
  );
  assert.equal(closed, true);
});

test('runtime和launch身份必须是字符串，旧runtime只接受明确字段与合法可选PID', async (t) => {
  const root = await fixture(t);
  const legacy = await readServiceRuntime(root);
  for (const invalid of [
    { ...legacy, instanceId: [INSTANCE] },
    { ...legacy, workspaceId: [WORKSPACE] },
    { ...legacy, controlToken: ['a'.repeat(64)] },
    { ...legacy, pid: '12345' },
    { ...legacy, pid: 0 },
    { ...legacy, futureField: true },
    startingRuntime({ instanceId: [INSTANCE] }),
    startingRuntime({ workspaceId: [WORKSPACE] }),
    startingRuntime({ controlToken: ['a'.repeat(64)] }),
  ])
    await assert.rejects(saveServiceRuntime(root, invalid), /SERVICE_RUNTIME_INVALID/);
  await assert.rejects(
    claimServiceLaunch(root, {
      version: 1,
      instanceId: [INSTANCE],
      launcherPid: process.pid,
      childPid: null,
      port: 4317,
      processStartedAt: '2026-10-06T00:00:00.000Z',
    }),
    /SERVICE_RUNTIME_INVALID/,
  );
});
