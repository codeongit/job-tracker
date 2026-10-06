import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicPath } from '../scripts/static-files.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { startLocalService } from '../scripts/serve.mjs';
import {
  readServiceRuntime,
  readServiceLaunch,
  saveServiceRuntime,
} from '../scripts/service-runtime.mjs';

const INSTANCE = '00000000-0000-4000-8000-000000000001';
const WORKSPACE = '00000000-0000-4000-8000-000000000002';
async function startupFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-serve-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    serviceRoot: join(root, 'service'),
    workspaceRoot: join(root, 'workspace'),
    args: [],
    config: {},
  };
}
function fakeServer(handler, error) {
  const server = new EventEmitter();
  server.listening = false;
  server.listen = (_port, host, accept) => {
    assert.equal(host, '127.0.0.1');
    queueMicrotask(() => {
      if (error) server.emit('error', error);
      else {
        server.listening = true;
        accept();
      }
    });
  };
  server.closeIdleConnections = () => {};
  server.close = (accept) => {
    server.listening = false;
    accept();
  };
  server.request = async (url, host = '127.0.0.1:4317') => {
    const response = { status: null, body: null };
    await handler(
      { method: 'GET', url, headers: { host } },
      {
        setHeader() {},
        writeHead(status) {
          response.status = status;
        },
        end(body) {
          response.body = body;
        },
      },
    );
    return response;
  };
  return server;
}
function fakeStore(options, initialize = async () => {}) {
  return {
    workspaceId: WORKSPACE,
    initialize: async () => initialize(options),
    read: async () => ({ workspaceId: WORKSPACE, revision: 0, workspace: null }),
    close: async () => {},
  };
}

test('本机服务在带尾斜杠的公开目录正确解析首页和静态文件', () => {
  const root = '/private/tmp/job-tracker-dist/';
  assert.equal(resolvePublicPath(root, '/'), '/private/tmp/job-tracker-dist/index.html');
  assert.equal(resolvePublicPath(root, '/app.js'), '/private/tmp/job-tracker-dist/app.js');
});

test('本机静态服务拒绝越界路径和隐藏文件', () => {
  const root = '/private/tmp/job-tracker-dist/';
  for (const path of ['/../private.json', '/.local/config.json', '/nested/.secret'])
    assert.throws(() => resolvePublicPath(root, path), /Not found/);
});

test('整个初始化阶段失败会保留固定失败状态，不泄露配置错误内容', async (t) => {
  const options = await startupFixture(t);
  delete options.config;
  await assert.rejects(
    startLocalService({
      ...options,
      readConfig: async () => {
        throw new Error('Synthetic private configuration content');
      },
    }),
    /SERVICE_CONFIG_INVALID/,
  );
  const runtime = await readServiceRuntime(options.serviceRoot);
  assert.equal(runtime.phase, 'failed');
  assert.equal(runtime.failureCode, 'SERVICE_CONFIG_INVALID');
  assert.equal(runtime.workspaceId, null);
  assert.equal(JSON.stringify(runtime).includes('Synthetic private'), false);
  assert.equal(await readServiceLaunch(options.serviceRoot), null);
});

test('工作区历史进度在就绪前落盘，校验失败仍保留阶段且关闭写者', async (t) => {
  const options = await startupFixture(t);
  let closed = false;
  await assert.rejects(
    startLocalService({
      ...options,
      createWorkspaceStore: (_path, dependencies) => ({
        workspaceId: WORKSPACE,
        initialize: async () => {
          await dependencies.onProgress({
            stage: 'history_validation',
            completed: 50,
            total: 6000,
          });
          const runtime = await readServiceRuntime(options.serviceRoot);
          assert.equal(runtime.phase, 'starting');
          assert.deepEqual(runtime.progress, {
            stage: 'history_validation',
            completed: 50,
            total: 6000,
          });
          throw new Error('Synthetic private history content');
        },
        close: async () => {
          closed = true;
        },
      }),
    }),
    /SERVICE_WORKSPACE_INVALID/,
  );
  const runtime = await readServiceRuntime(options.serviceRoot);
  assert.equal(runtime.phase, 'failed');
  assert.equal(runtime.failureCode, 'SERVICE_WORKSPACE_INVALID');
  assert.equal(runtime.progress.stage, 'history_validation');
  assert.equal(closed, true);
});

test('进度不能持久化时启动失败，不能发布ready', async (t) => {
  const options = await startupFixture(t);
  await assert.rejects(
    startLocalService({
      ...options,
      createWorkspaceStore: (_path, dependencies) =>
        fakeStore(dependencies, async () => {
          await dependencies.onProgress({ stage: 'unknown-private-stage' });
        }),
    }),
    /SERVICE_RUNTIME_SAVE_FAILED/,
  );
  const runtime = await readServiceRuntime(options.serviceRoot);
  assert.equal(runtime.phase, 'failed');
  assert.equal(runtime.failureCode, 'SERVICE_RUNTIME_SAVE_FAILED');
  assert.equal(runtime.readyAt, null);
});

test('成功启动在完整初始化后发布ready并保持health协议和Host边界', async (t) => {
  const options = await startupFixture(t);
  const phases = [];
  const service = await startLocalService({
    ...options,
    createWorkspaceStore: (_path, dependencies) =>
      fakeStore(dependencies, async () => {
        for (const stage of ['head_validation', 'catalog_validation']) {
          await dependencies.onProgress({ stage });
          phases.push((await readServiceRuntime(options.serviceRoot)).phase);
        }
      }),
    createHttpServer: fakeServer,
  });
  t.after(() => service.shutdown());
  assert.deepEqual(phases, ['starting', 'starting']);
  const runtime = await readServiceRuntime(options.serviceRoot);
  assert.equal(runtime.phase, 'ready');
  assert.equal(runtime.workspaceId, WORKSPACE);
  assert.ok(runtime.startupDurationMs >= 0);
  assert.equal(await readServiceLaunch(options.serviceRoot), null);
  const health = await service.server.request('/__local/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).protocolVersion, 1);
  assert.equal(JSON.parse(health.body).storageVersion, 2);
  assert.equal(JSON.parse(health.body).phase, 'ready');
  assert.equal((await service.server.request('/__local/health', 'example.com:4317')).status, 403);
  await service.shutdown();
  assert.equal(await readServiceRuntime(options.serviceRoot), null);
});

test('端口监听失败保留固定失败码且不发布ready', async (t) => {
  const options = await startupFixture(t);
  await assert.rejects(
    startLocalService({
      ...options,
      createWorkspaceStore: (_path, dependencies) => fakeStore(dependencies),
      createHttpServer: (handler) =>
        fakeServer(
          handler,
          Object.assign(new Error('Synthetic private address details'), { code: 'EADDRINUSE' }),
        ),
    }),
    /SERVICE_PORT_IN_USE/,
  );
  const runtime = await readServiceRuntime(options.serviceRoot);
  assert.equal(runtime.phase, 'failed');
  assert.equal(runtime.failureCode, 'SERVICE_PORT_IN_USE');
  assert.equal(runtime.readyAt, null);
});

test('直接启动不能覆盖仍活跃的其他实例runtime', async (t) => {
  const options = await startupFixture(t);
  await saveServiceRuntime(options.serviceRoot, {
    version: 1,
    instanceId: INSTANCE,
    workspaceId: WORKSPACE,
    pid: process.pid,
    port: 4317,
    controlToken: 'a'.repeat(64),
  });
  await assert.rejects(
    startLocalService({ ...options, isProcessAlive: () => true }),
    /SERVICE_START_FAILED/,
  );
  assert.equal((await readServiceRuntime(options.serviceRoot)).instanceId, INSTANCE);
  assert.equal(await readServiceLaunch(options.serviceRoot), null);
});

test('旧runtime缺PID时直接启动保守拒绝并保留原服务身份', async (t) => {
  const options = await startupFixture(t);
  const legacy = {
    version: 1,
    instanceId: INSTANCE,
    workspaceId: WORKSPACE,
    port: 4317,
    controlToken: 'a'.repeat(64),
  };
  await saveServiceRuntime(options.serviceRoot, legacy);
  let initialized = false;
  await assert.rejects(
    startLocalService({
      ...options,
      createWorkspaceStore: () => {
        initialized = true;
        throw new Error('Should not initialize');
      },
    }),
    /SERVICE_RUNTIME_UNCONFIRMED/,
  );
  assert.equal(initialized, false);
  assert.deepEqual(await readServiceRuntime(options.serviceRoot), legacy);
  assert.equal(await readServiceLaunch(options.serviceRoot), null);
});
