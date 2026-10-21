import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalWorkspaceClient } from '../dist/local-workspace.js';
import { initialWorkspace } from '../dist/workspace.js';
import { startLocalService } from '../scripts/serve.mjs';

const MIGRATED_JOB = {
  id: 'http-migrated-job',
  company: '合成迁移公司',
  role: '合成迁移岗位',
  stage: '已触达',
};
const ADDED_JOB = {
  id: 'http-added-job',
  company: '合成新增公司',
  role: '合成新增岗位',
  stage: '沟通中',
};
const ROUTES = new Set([
  'GET /__local/session',
  'GET /__local/workspace',
  'GET /__local/health',
  'POST /__local/workspace/commands',
]);
const copy = (value) => structuredClone(value);
const migrationWorkspace = () => {
  const workspace = initialWorkspace();
  workspace.data.opportunities.push(copy(MIGRATED_JOB));
  return workspace;
};
const addJob = (record) => (data) => {
  data.opportunities.push(copy(record));
  return data;
};

async function availablePort() {
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    return probe.address().port;
  } finally {
    if (probe.listening)
      await new Promise((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-workspace-http-'));
  let service = null,
    origin,
    starts = 0;
  async function start() {
    assert.equal(service, null);
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await availablePort();
      try {
        service = await startLocalService({
          args: ['--port', String(port)],
          serviceRoot: join(root, `service-${++starts}`),
          workspaceRoot: join(root, 'workspace'),
          config: {},
          readConfig: async () => assert.fail('The fixture must not read the real configuration'),
        });
        origin = `http://127.0.0.1:${service.port}`;
        return;
      } catch (error) {
        // Port discovery and binding are separate; retry only an actual collision.
        if (error.message !== 'SERVICE_PORT_IN_USE' || attempt === 2) throw error;
      }
    }
  }
  async function stop() {
    await service?.shutdown();
    service = null;
  }
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  async function request(path, options = {}) {
    const url = new URL(path, origin),
      method = options.method || 'GET';
    assert.equal(url.origin, origin, 'Requests must stay on this isolated service');
    assert.equal(url.search + url.hash + url.username + url.password, '');
    assert.ok(ROUTES.has(`${method} ${url.pathname}`), 'Only workspace test routes are allowed');
    const headers = new Headers(options.headers);
    if (!headers.has('Origin')) headers.set('Origin', origin);
    // Node needs the absolute URL and Origin that a browser normally supplies.
    return fetch(url, {
      ...options,
      headers,
      redirect: 'error',
      signal: options.signal || AbortSignal.timeout(5000),
    });
  }
  function createClient({ initial = null, beforeRequest, afterResponse } = {}) {
    const metadata = new Map(),
      calls = [];
    let cached = copy(initial),
      cacheWrites = 0;
    const client = createLocalWorkspaceClient({
      hostname: '127.0.0.1',
      authorityStorage: {
        getItem: (key) => metadata.get(key) ?? null,
        setItem: (key, value) => metadata.set(key, value),
      },
      readCache: async () => copy(cached),
      writeCache: async (state) => {
        cached = copy(state);
        cacheWrites++;
      },
      fetcher: async (path, options = {}) => {
        const call = { path, method: options.method || 'GET', body: options.body };
        calls.push(call);
        await beforeRequest?.(call);
        const response = await request(path, options);
        call.status = response.status;
        await afterResponse?.(call, response);
        return response;
      },
    });
    return {
      client,
      calls,
      get cached() {
        return copy(cached);
      },
      get cacheWrites() {
        return cacheWrites;
      },
    };
  }
  await start();
  return { start, stop, request, createClient };
}

async function initializeClient(service, options = {}) {
  const writer = service.createClient({ initial: migrationWorkspace(), ...options }),
    prepared = await writer.client.prepareImport([]);
  await writer.client.importCurrent(prepared, []);
  return writer;
}

const editRequests = (reader) =>
  reader.calls.filter(
    (call) => call.method === 'POST' && JSON.parse(call.body).type === 'edit_data',
  );

test(
  '真实HTTP客户端显式迁移并保存岗位，服务重启后新客户端读回正式记录',
  { timeout: 30000 },
  async (t) => {
    const service = await fixture(t),
      writer = service.createClient({ initial: migrationWorkspace() });
    const health = await (await service.request('/__local/health')).json();
    assert.equal(health.sshConfigured, false);
    assert.equal(health.bossIntegrationEnabled, false);
    assert.equal(health.tracking, 'disabled');
    await assert.rejects(writer.client.read(), { code: 'LOCAL_WORKSPACE_IMPORT_REQUIRED' });
    await assert.rejects(writer.client.importCurrent(), {
      code: 'LOCAL_WORKSPACE_MIGRATION_PREFLIGHT_REQUIRED',
    });
    assert.equal(writer.calls.filter((call) => call.method === 'POST').length, 0);
    const prepared = await writer.client.prepareImport([]);
    assert.equal(prepared.summary.opportunities, 1);
    await writer.client.importCurrent(prepared, []);
    const before = await writer.client.readForReview();
    await writer.client.editData(addJob(ADDED_JOB));
    const saved = await writer.client.readForReview();
    assert.equal(saved.revision, before.revision + 1);
    assert.deepEqual(saved.state.data.opportunities, [MIGRATED_JOB, ADDED_JOB]);
    assert.deepEqual(writer.cached, saved.state);
    await service.stop();
    await service.start();
    const reader = service.createClient(),
      reopened = await reader.client.readForReview();
    assert.deepEqual(reopened, saved);
    assert.deepEqual(reader.client.status(), { local: true, offline: false });
  },
);

test(
  '真实HTTP提交后丢失响应只重试原命令，正式revision只增加一次',
  { timeout: 30000 },
  async (t) => {
    const service = await fixture(t);
    let committed = null;
    const writer = await initializeClient(service, {
      afterResponse: async (call, response) => {
        if (call.method !== 'POST' || JSON.parse(call.body).type !== 'edit_data' || committed)
          return;
        // The real server has committed; consume the reply before hiding it from the client.
        committed = await response.json();
        throw new TypeError('Synthetic lost HTTP reply');
      },
    });
    const before = await writer.client.readForReview();
    await writer.client.editData(addJob(ADDED_JOB));
    const requests = editRequests(writer),
      formal = await service.createClient().client.readForReview();
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((call) => call.status),
      [200, 200],
    );
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(JSON.parse(requests[0].body).expectedRevision, before.revision);
    assert.equal(committed.revision, before.revision + 1);
    assert.equal(formal.revision, committed.revision);
    assert.deepEqual(formal.state.data.opportunities, [MIGRATED_JOB, ADDED_JOB]);
    assert.deepEqual(writer.cached, formal.state);
  },
);

test(
  '两个真实HTTP客户端竞争时旧revision收到409，不重放且刷新缓存',
  { timeout: 30000 },
  async (t) => {
    const service = await fixture(t),
      reachedPost = Promise.withResolvers(),
      releasePost = Promise.withResolvers();
    const writerA = await initializeClient(service, {
      beforeRequest: async (call) => {
        if (call.method === 'POST' && JSON.parse(call.body).type === 'edit_data') {
          reachedPost.resolve();
          await releasePost.promise;
        }
      },
    });
    const writerB = service.createClient(),
      before = await writerB.client.readForReview();
    let transforms = 0;
    const attempted = writerA.client.editData((data) => {
      transforms++;
      return addJob({ ...ADDED_JOB, id: 'http-stale-job' })(data);
    });
    try {
      await Promise.race([
        reachedPost.promise,
        attempted.then(() => assert.fail('Writer A must wait before its POST')),
      ]);
      await writerB.client.editData(addJob(ADDED_JOB));
      const rejected = assert.rejects(attempted, {
        code: 'WORKSPACE_REVISION_CONFLICT',
        status: 409,
      });
      releasePost.resolve();
      await rejected;
    } finally {
      releasePost.resolve();
      await attempted.catch(() => {});
    }
    const requests = editRequests(writerA),
      formal = await service.createClient().client.readForReview();
    assert.equal(transforms, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, 409);
    assert.equal(JSON.parse(requests[0].body).expectedRevision, before.revision);
    assert.equal(formal.revision, before.revision + 1);
    assert.deepEqual(formal.state.data.opportunities, [MIGRATED_JOB, ADDED_JOB]);
    assert.deepEqual(writerA.cached, formal.state);
    assert.deepEqual(writerB.cached, formal.state);
  },
);

test(
  '真实服务断开后只读缓存并拒绝写入，重启后重新取得会话和正式记录',
  { timeout: 30000 },
  async (t) => {
    const service = await fixture(t),
      writer = await initializeClient(service),
      before = await writer.client.readForReview(),
      cacheWrites = writer.cacheWrites;
    await service.stop();
    assert.deepEqual(await writer.client.read(), before.state);
    assert.deepEqual(writer.client.status(), { local: true, offline: true });
    let transforms = 0;
    await assert.rejects(
      writer.client.editData((data) => {
        transforms++;
        return addJob(ADDED_JOB)(data);
      }),
      { code: 'LOCAL_WORKSPACE_UNAVAILABLE' },
    );
    assert.equal(transforms, 0);
    assert.equal(editRequests(writer).length, 0);
    assert.equal(writer.cacheWrites, cacheWrites);
    assert.deepEqual(writer.cached, before.state);
    const resumeStart = writer.calls.length;
    await service.start();
    assert.deepEqual(await writer.client.readForReview(), before);
    assert.deepEqual(writer.client.status(), { local: true, offline: false });
    assert.deepEqual(
      writer.calls.slice(resumeStart).map(({ path, status }) => [path, status]),
      [
        ['./__local/workspace', 403],
        ['./__local/session', 200],
        ['./__local/workspace', 200],
      ],
    );
    assert.deepEqual(await service.createClient().client.readForReview(), before);
  },
);

test(
  '真实HTTP写请求的Origin、会话和协议校验拒绝修改且保持正式revision',
  { timeout: 30000 },
  async (t) => {
    const service = await fixture(t),
      writer = await initializeClient(service),
      before = await writer.client.readForReview(),
      { session } = await (await service.request('/__local/session')).json();
    const headers = {
      'Content-Type': 'application/json',
      'X-Job-Tracker-Session': session,
      'X-Job-Tracker-Protocol': '1',
    };
    const body = JSON.stringify({
      commandId: 'http-authenticated-edit',
      expectedRevision: before.revision,
      type: 'edit_data',
      payload: {
        changes: [{ group: 'opportunities', record: ADDED_JOB }],
        releaseFields: [],
        reason: '合成HTTP边界核对',
      },
    });
    const wrongSession = (session[0] === '0' ? '1' : '0') + session.slice(1);
    for (const [changed, status, code] of [
      [{ Origin: 'https://untrusted.invalid' }, 403],
      [{ 'X-Job-Tracker-Session': wrongSession }, 403],
      [{ 'X-Job-Tracker-Protocol': 'future' }, 409, 'PROTOCOL_UPGRADE_REQUIRED'],
    ]) {
      const response = await service.request('/__local/workspace/commands', {
        method: 'POST',
        headers: { ...headers, ...changed },
        body,
      });
      const rejected = await response.json();
      assert.equal(response.status, status);
      if (code) assert.equal(rejected.code, code);
      assert.deepEqual(await writer.client.readForReview(), before);
    }
    // The same otherwise-valid command must succeed with the correct HTTP credentials.
    const accepted = await service.request('/__local/workspace/commands', {
      method: 'POST',
      headers,
      body,
    });
    const result = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(result.revision, before.revision + 1);
    const formal = await service.createClient().client.readForReview();
    assert.equal(formal.revision, result.revision);
    assert.deepEqual(formal.state.data.opportunities, [MIGRATED_JOB, ADDED_JOB]);
  },
);
