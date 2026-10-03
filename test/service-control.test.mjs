import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveServiceRuntime,
  readServiceRuntime,
  removeServiceRuntime,
} from '../scripts/service-runtime.mjs';
import { EventEmitter } from 'node:events';
import { serviceStatus, stopService, startService } from '../scripts/service-control.mjs';

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
  let timer, publication;
  t.after(async () => {
    clearTimeout(timer);
    await publication;
    await rm(root, { recursive: true, force: true });
  });
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => {
      child.emit('spawn');
      timer = setTimeout(() => {
        publication = saveServiceRuntime(root, {
          version: 1,
          instanceId: INSTANCE,
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
      instanceId: INSTANCE,
      workspaceId: WORKSPACE,
      protocolVersion: 1,
      tracking: 'stopped',
    });
  const status = await startService({ root, spawnProcess, fetcher });
  assert.equal(status.running, true);
  assert.equal(status.tracking, 'stopped');
});
