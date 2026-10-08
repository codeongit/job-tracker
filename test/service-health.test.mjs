import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, lstat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveServiceRuntime,
  readServiceRuntime,
  readServiceLaunch,
} from '../scripts/service-runtime.mjs';
import { serviceStatus, startService } from '../scripts/service-control.mjs';
import { EventEmitter } from 'node:events';

const INSTANCE = '00000000-0000-4000-8000-000000000001';
const WORKSPACE = '00000000-0000-4000-8000-000000000002';
const PORT = 4521;
const health = () =>
  Response.json({
    serviceKind: 'job-tracker-local',
    instanceId: INSTANCE,
    workspaceId: WORKSPACE,
    appVersion: '0.10.14',
    sshConfigured: true,
    protocolVersion: 1,
    tracking: 'stopped',
  });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-health-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveServiceRuntime(root, {
    version: 2,
    instanceId: INSTANCE,
    workspaceId: WORKSPACE,
    pid: process.pid,
    port: PORT,
    controlToken: 'a'.repeat(64),
    phase: 'ready',
    processStartedAt: '2026-10-08T00:00:00.000Z',
    readyAt: '2026-10-08T00:00:01.000Z',
    startupDurationMs: 1000,
    progress: { stage: 'ready' },
    failureCode: null,
  });
  return root;
}
const transport = (code) =>
  Object.assign(new TypeError('synthetic private transport content'), {
    cause: { code, message: 'synthetic private cause' },
  });

test('健康失败分类、时间和身份摘要来自同一检查，status 不写入诊断', async (t) => {
  const cases = [
    [
      'timeout',
      () => {
        throw new DOMException('synthetic private timeout', 'TimeoutError');
      },
      'SERVICE_UNAVAILABLE',
    ],
    [
      'connection_refused',
      () => {
        throw transport('ECONNREFUSED');
      },
      'SERVICE_UNAVAILABLE',
    ],
    [
      'permission_denied',
      () => {
        throw transport('EPERM');
      },
      'SERVICE_UNAVAILABLE',
    ],
    [
      'transport_error',
      () => {
        throw transport('EOTHER');
      },
      'SERVICE_UNAVAILABLE',
    ],
    [
      'invalid_response',
      () => new Response('synthetic private invalid JSON'),
      'SERVICE_UNAVAILABLE',
    ],
    ['invalid_response', () => Response.json(null), 'SERVICE_UNAVAILABLE'],
    [
      'http_error',
      () => new Response('synthetic private HTTP body', { status: 503 }),
      'SERVICE_OWNERSHIP_MISMATCH',
    ],
    [
      'identity_mismatch',
      () => Response.json({ serviceKind: 'other', privateBody: 'synthetic private identity' }),
      'SERVICE_OWNERSHIP_MISMATCH',
    ],
  ];
  for (const [reason, respond, code] of cases) {
    await t.test(`${reason} ${code}`, async (t) => {
      const root = await fixture(t);
      const before = await readFile(join(root, 'runtime.json'), 'utf8');
      let time = Date.parse('2026-10-08T01:00:00.000Z'),
        requests = 0;
      const result = await serviceStatus(
        root,
        async (url, { signal }) => {
          requests++;
          assert.equal(url, `http://127.0.0.1:${PORT}/__local/health`);
          assert.ok(signal instanceof AbortSignal);
          time += 37;
          return respond();
        },
        { now: () => time, isProcessAlive: () => true },
      );
      assert.equal(result.running, false);
      assert.equal(result.code, code);
      assert.equal(result.processAlive, true);
      assert.equal(result.port, PORT);
      assert.equal(result.healthCheck.reason, reason);
      assert.equal(result.healthCheck.durationMs, 37);
      assert.equal(result.healthCheck.timeoutMs, 1500);
      assert.equal(result.healthCheck.attempts, 1);
      assert.equal(requests, 1);
      assert.ok(result.message);
      assert.doesNotMatch(JSON.stringify(result), /synthetic private|a{64}/);
      assert.equal(await readFile(join(root, 'runtime.json'), 'utf8'), before);
      assert.deepEqual(await readdir(root), ['runtime.json']);
    });
  }
});

test('服务元信息只从通过身份检查的响应中提取，缺失信息保持未知', async (t) => {
  const root = await fixture(t);
  const status = await serviceStatus(root, health);
  assert.equal(status.running, true);
  assert.equal(status.appVersion, '0.10.14');
  assert.equal(status.sshConfigured, true);
  assert.equal(status.healthCheck.reason, 'ok');
  const unknown = await serviceStatus(root, () =>
    Response.json({
      serviceKind: 'job-tracker-local',
      instanceId: INSTANCE,
      workspaceId: WORKSPACE,
      appVersion: 'synthetic private version',
      sshConfigured: 'synthetic private flag',
    }),
  );
  assert.equal(unknown.running, true);
  assert.equal(unknown.appVersion, null);
  assert.equal(unknown.sshConfigured, null);
  assert.doesNotMatch(JSON.stringify(unknown), /synthetic private/);
});

test('健康检查超时覆盖响应正文读取，不留下后台等待', async (t) => {
  const root = await fixture(t);
  let timer;
  t.after(() => clearTimeout(timer));
  const result = await serviceStatus(
    root,
    async (_url, { signal }) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('body never aborted')), 2000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    }),
    { healthTimeoutMs: 20 },
  );
  assert.equal(result.code, 'SERVICE_UNAVAILABLE');
  assert.equal(result.healthCheck.reason, 'timeout');
  assert.equal(result.healthCheck.timeoutMs, 20);
});

test('start 只补查一次临时故障，成功后不写失败日志或创建第二个进程', async (t) => {
  for (const reason of ['timeout', 'connection_refused']) {
    await t.test(reason, async (t) => {
      const root = await fixture(t);
      const before = await readServiceRuntime(root);
      let time = Date.parse('2026-10-08T01:00:00.000Z'),
        requests = 0,
        spawns = 0;
      const waits = [];
      const result = await startService({
        root,
        isProcessAlive: () => true,
        now: () => time,
        wait: async (ms) => {
          waits.push(ms);
          time += ms;
        },
        fetcher: async () => {
          requests++;
          time += requests === 1 ? 1500 : 1;
          if (requests === 1) {
            if (reason === 'timeout') throw new DOMException('private timeout', 'TimeoutError');
            throw transport('ECONNREFUSED');
          }
          return health();
        },
        spawnProcess: () => {
          spawns++;
        },
      });
      assert.equal(result.running, true);
      assert.equal(result.healthCheck.attempts, 2);
      assert.equal(result.healthCheck.durationMs, 1701);
      assert.equal(requests, 2);
      assert.equal(spawns, 0);
      assert.deepEqual(waits, [200]);
      assert.deepEqual(await readServiceRuntime(root), before);
      assert.equal(await readServiceLaunch(root), null);
      assert.deepEqual(await readdir(root), ['runtime.json']);
    });
  }
});

test('start 的两次检查用完预算仍保留进程，失败摘要私有且不含响应或凭据', async (t) => {
  const root = await fixture(t);
  const before = await readServiceRuntime(root);
  let time = Date.parse('2026-10-08T01:00:00.000Z'),
    requests = 0,
    spawns = 0;
  const result = await startService({
    root,
    now: () => time,
    isProcessAlive: () => true,
    wait: async (ms) => {
      time += ms;
    },
    fetcher: async () => {
      requests++;
      time += 1500;
      throw new DOMException('private timeout', 'TimeoutError');
    },
    spawnProcess: () => {
      spawns++;
    },
  });
  assert.equal(result.code, 'SERVICE_UNAVAILABLE');
  assert.equal(result.processAlive, true);
  assert.equal(result.healthCheck.attempts, 2);
  assert.equal(result.healthCheck.durationMs, 3200);
  assert.equal(result.diagnosticSaved, true);
  assert.equal(requests, 2);
  assert.equal(spawns, 0);
  assert.deepEqual(await readServiceRuntime(root), before);
  assert.equal(await readServiceLaunch(root), null);
  const text = await readFile(join(root, 'service.log'), 'utf8');
  const record = JSON.parse(text);
  assert.equal(record.event, 'service_start_diagnostic');
  assert.equal(record.reason, 'timeout');
  assert.equal(record.attempts, 2);
  assert.equal(record.durationMs, 3200);
  assert.equal(record.port, PORT);
  assert.doesNotMatch(text, /private|a{64}|controlToken|workspaceId|http:\/\//);
  assert.equal((await lstat(join(root, 'service.log'))).mode & 0o777, 0o600);
});

test('身份、格式及权限失败不补查，诊断保存失败也不重新启动', async (t) => {
  for (const respond of [
    () => {
      throw transport('EACCES');
    },
    () => new Response('private invalid body'),
    () => Response.json({ serviceKind: 'other' }),
  ]) {
    await t.test('non transient', async (t) => {
      const root = await fixture(t);
      const target = join(root, 'preserved.txt');
      await writeFile(target, 'preserved');
      await symlink(target, join(root, 'service.log'));
      let requests = 0,
        waits = 0,
        spawns = 0;
      const attempt = startService({
        root,
        isProcessAlive: () => true,
        fetcher: async () => {
          requests++;
          return respond();
        },
        wait: async () => {
          waits++;
        },
        spawnProcess: () => {
          spawns++;
        },
      });
      let result;
      try {
        result = await attempt;
      } catch (error) {
        assert.equal(error.message, 'SERVICE_OWNERSHIP_MISMATCH');
        result = error.status;
      }
      assert.equal(result.running, false);
      assert.equal(result.healthCheck.attempts, 1);
      assert.equal(result.diagnosticSaved, false);
      assert.equal(requests, 1);
      assert.equal(waits, 0);
      assert.equal(spawns, 0);
      assert.equal(await readFile(target, 'utf8'), 'preserved');
    });
  }
});

test('新启动的健康补查不重置原等待窗口，窗口内不足延迟时直接返回未确认结果', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-health-start-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-08T01:00:00.000Z'),
    requests = 0,
    instance,
    spawns = 0;
  const began = time,
    waits = [];
  const result = await startService({
    root,
    port: PORT,
    now: () => time,
    isProcessAlive: () => true,
    waitMs: 50,
    pollMs: 10,
    spawnProcess: (_exec, args) => {
      spawns++;
      instance = args[args.indexOf('--launch-id') + 1];
      const child = new EventEmitter();
      child.pid = process.pid;
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    wait: async (ms) => {
      waits.push(ms);
      time += ms;
      await saveServiceRuntime(root, {
        version: 2,
        instanceId: instance,
        workspaceId: WORKSPACE,
        pid: process.pid,
        port: PORT,
        controlToken: 'a'.repeat(64),
        phase: 'ready',
        processStartedAt: new Date(began).toISOString(),
        readyAt: new Date(time).toISOString(),
        startupDurationMs: 10,
        progress: { stage: 'ready' },
        failureCode: null,
      });
    },
    fetcher: async () => {
      requests++;
      time += 40;
      throw new DOMException('synthetic timeout', 'TimeoutError');
    },
  });
  assert.equal(result.code, 'SERVICE_UNAVAILABLE');
  assert.equal(result.healthCheck.attempts, 1);
  assert.equal(result.healthCheck.timeoutMs, 1500);
  assert.equal(time - began, 50);
  assert.deepEqual(waits, [10]);
  assert.equal(requests, 1);
  assert.equal(spawns, 1);
  assert.equal((await readServiceRuntime(root)).instanceId, instance);
  assert.equal((await readServiceLaunch(root)).instanceId, instance);
});

test('新启动后发现身份不符同样抛出固定错误并保留运行记录和诊断', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-health-late-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-08T01:00:00.000Z'),
    instance,
    requests = 0,
    spawns = 0;
  await assert.rejects(
    startService({
      root,
      port: PORT,
      now: () => time,
      isProcessAlive: () => true,
      waitMs: 1000,
      pollMs: 10,
      spawnProcess: (_exec, args) => {
        spawns++;
        instance = args[args.indexOf('--launch-id') + 1];
        const child = new EventEmitter();
        child.pid = process.pid;
        child.unref = () => {};
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      wait: async (ms) => {
        time += ms;
        await saveServiceRuntime(root, {
          version: 2,
          instanceId: instance,
          workspaceId: WORKSPACE,
          pid: process.pid,
          port: PORT,
          controlToken: 'a'.repeat(64),
          phase: 'ready',
          processStartedAt: '2026-10-08T01:00:00.000Z',
          readyAt: new Date(time).toISOString(),
          startupDurationMs: 10,
          progress: { stage: 'ready' },
          failureCode: null,
        });
      },
      fetcher: async () => {
        requests++;
        return Response.json({ serviceKind: 'other', privateBody: 'synthetic private HTTP body' });
      },
    }),
    (error) => {
      assert.equal(error.message, 'SERVICE_OWNERSHIP_MISMATCH');
      assert.equal(error.status.healthCheck.reason, 'identity_mismatch');
      assert.equal(error.status.diagnosticSaved, true);
      assert.doesNotMatch(JSON.stringify(error.status), /private|a{64}/);
      return true;
    },
  );
  assert.equal(spawns, 1);
  assert.equal(requests, 1);
  assert.equal((await readServiceRuntime(root)).instanceId, instance);
  assert.equal((await readServiceLaunch(root)).instanceId, instance);
});
