import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalWorkspaceClient } from '../dist/local-workspace.js';
import { initialWorkspace } from '../dist/workspace.js';

const copy = (value) => structuredClone(value);
const response = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => copy(value),
});

function fixture({
  initial = initialWorkspace(),
  cached = initialWorkspace(),
  hostname = '127.0.0.1',
  custom,
  brokenCache = false,
  authorityValue = '',
} = {}) {
  let workspace = copy(initial),
    revision = initial ? 1 : 0,
    cache = copy(cached),
    offline = 0,
    cacheFailures = 0;
  const metadata = new Map(),
    calls = [];
  if (authorityValue) metadata.set('job-tracker-local-authority-v1', authorityValue);
  const envelope = () => ({
    protocolVersion: 1,
    storageVersion: 1,
    workspaceId: '00000000-0000-4000-8000-000000000001',
    revision,
    hash: workspace ? 'a'.repeat(64) : '',
    workspace: copy(workspace),
  });
  const fetcher = async (path, options = {}) => {
    const call = { path, ...options, parsed: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (custom) {
      const result = await custom(call, { envelope, calls });
      if (result !== undefined) return result;
    }
    if (path === './__local/session')
      return response({ localWorkspaceEnabled: true, session: 'f'.repeat(64) });
    if (path === './__local/workspace') return response(envelope());
    if (path === './__local/workspace/commands') {
      assert.equal(options.headers['X-Job-Tracker-Protocol'], '1');
      assert.equal(call.parsed.expectedRevision, revision);
      if (call.parsed.type === 'import_workspace') workspace = copy(call.parsed.payload.workspace);
      else if (call.parsed.type === 'edit_data') {
        for (const change of call.parsed.payload.changes) {
          const rows = workspace.data[change.group],
            index = rows.findIndex((row) => row.id === change.record.id);
          if (index >= 0) rows[index] = copy(change.record);
          else rows.push(copy(change.record));
        }
        workspace.generation++;
        if (workspace.pending) workspace.pending.generation = workspace.generation;
      } else throw new Error(`Unexpected synthetic command: ${call.parsed.type}`);
      revision++;
      return response(envelope());
    }
    throw new Error('Unexpected synthetic endpoint');
  };
  const client = createLocalWorkspaceClient({
    fetcher,
    hostname,
    authorityStorage: {
      getItem: (key) => metadata.get(key) || null,
      setItem: (key, value) => metadata.set(key, value),
    },
    readCache: async () => copy(cache),
    writeCache: async (next) => {
      if (brokenCache) throw new Error('quota');
      cache = copy(next);
    },
    onOffline: () => offline++,
    onCacheFailure: () => cacheFailures++,
  });
  return {
    client,
    calls,
    metadata,
    envelope,
    get cache() {
      return cache;
    },
    get offline() {
      return offline;
    },
    get cacheFailures() {
      return cacheFailures;
    },
    replaceCache(next) {
      cache = copy(next);
    },
  };
}

function populatedWorkspace() {
  const value = initialWorkspace();
  value.data.opportunities.push({
    id: 'migration-job',
    company: '合成迁移公司',
    role: '合成迁移岗位',
    stage: '已触达',
  });
  return value;
}

test('首次迁移需要显式操作，重复初始化只读取服务且不覆盖正式数据', async () => {
  const value = fixture({ initial: null, cached: populatedWorkspace() });
  await assert.rejects(value.client.read(), { code: 'LOCAL_WORKSPACE_IMPORT_REQUIRED' });
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(value.metadata.size, 0);
  await assert.rejects(value.client.importCurrent(), {
    code: 'LOCAL_WORKSPACE_MIGRATION_PREFLIGHT_REQUIRED',
  });
  const prepared = await value.client.prepareImport([]);
  assert.equal(prepared.summary.opportunities, 1);
  assert.match(prepared.sha256, /^[a-f0-9]{64}$/);
  assert.equal(prepared.backup.backupVersion, 2);
  assert.deepEqual(prepared.backup.drafts, []);
  await value.client.importCurrent(prepared, []);
  await value.client.importCurrent();
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(
    value.metadata.get('job-tracker-local-authority-v1'),
    JSON.stringify({ workspaceId: '00000000-0000-4000-8000-000000000001' }),
  );
});

test('已有服务不会静默覆盖另一浏览器缓存，完整备份后才能明确切换', async () => {
  const formal = populatedWorkspace(),
    local = populatedWorkspace();
  formal.data.opportunities[0].company = '服务正式公司';
  local.data.opportunities[0].company = '另一浏览器未同步公司';
  const value = fixture({ initial: formal, cached: local });

  await assert.rejects(value.client.read(), {
    code: 'LOCAL_WORKSPACE_BROWSER_DATA_UNMIGRATED',
  });
  assert.equal(value.cache.data.opportunities[0].company, '另一浏览器未同步公司');
  assert.equal(value.metadata.size, 0);

  const prepared = await value.client.prepareImport([]);
  assert.equal(prepared.backup.workspace.data.opportunities[0].company, '另一浏览器未同步公司');
  const adopted = await value.client.importCurrent(prepared, []);
  assert.equal(adopted.data.opportunities[0].company, '服务正式公司');
  assert.equal(value.cache.data.opportunities[0].company, '服务正式公司');
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 0);
});

test('旧版无工作区身份标记不能跳过差异核对或静默覆盖缓存', async () => {
  const formal = populatedWorkspace(),
    local = populatedWorkspace();
  formal.data.opportunities[0].company = '服务正式公司';
  local.data.opportunities[0].company = '旧标记浏览器公司';
  const value = fixture({ initial: formal, cached: local, authorityValue: '1' });
  await assert.rejects(value.client.read(), {
    code: 'LOCAL_WORKSPACE_BROWSER_DATA_UNMIGRATED',
  });
  assert.equal(value.cache.data.opportunities[0].company, '旧标记浏览器公司');
  assert.equal(value.metadata.get('job-tracker-local-authority-v1'), '1');
});

test('并发初始化的409不能把另一来源误报为本次迁移成功', async () => {
  const local = populatedWorkspace(),
    value = fixture({
      initial: null,
      cached: local,
      custom: (call) =>
        call.method === 'POST'
          ? response({ message: 'already initialized', code: 'WORKSPACE_ALREADY_INITIALIZED' }, 409)
          : undefined,
    }),
    prepared = await value.client.prepareImport([]);

  await assert.rejects(value.client.importCurrent(prepared, []), {
    code: 'WORKSPACE_ALREADY_INITIALIZED',
  });
  assert.equal(value.cache.data.opportunities[0].company, '合成迁移公司');
  assert.equal(value.metadata.size, 0);
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 1);
});

test('错误或空浏览器不能创建正式工作区，备份后的记录和草稿变化要求重新核对', async () => {
  const missing = fixture({ initial: null, cached: null });
  await assert.rejects(missing.client.prepareImport([]), {
    code: 'LOCAL_WORKSPACE_SOURCE_MISSING',
  });
  const empty = fixture({ initial: null, cached: initialWorkspace() });
  await assert.rejects(empty.client.prepareImport([]), {
    code: 'LOCAL_WORKSPACE_SOURCE_EMPTY',
  });

  const changedDrafts = fixture({ initial: null, cached: populatedWorkspace() }),
    prepared = await changedDrafts.client.prepareImport([]);
  await assert.rejects(
    changedDrafts.client.importCurrent(prepared, [
      {
        id: '00000000-0000-4000-8000-000000000002',
        revision: '00000000-0000-4000-8000-000000000003',
        kind: 'editor',
        opportunityId: '',
        values: { company: '尚未提交' },
        updatedAt: '2026-09-22T00:00:00.000Z',
      },
    ]),
    { code: 'LOCAL_WORKSPACE_MIGRATION_DRAFTS_CHANGED' },
  );
  assert.equal(changedDrafts.calls.filter((call) => call.method === 'POST').length, 0);

  const changedSource = fixture({ initial: null, cached: populatedWorkspace() }),
    sourcePrepared = await changedSource.client.prepareImport([]),
    replacement = populatedWorkspace();
  replacement.data.opportunities[0].notes = '备份后变化';
  changedSource.replaceCache(replacement);
  await assert.rejects(changedSource.client.importCurrent(sourcePrepared, []), {
    code: 'LOCAL_WORKSPACE_MIGRATION_SOURCE_CHANGED',
  });
  assert.equal(changedSource.calls.filter((call) => call.method === 'POST').length, 0);
});

test('迁移预检的内部原件不受调用方修改，提交仍使用备份时的原工作区', async () => {
  const original = populatedWorkspace(),
    value = fixture({ initial: null, cached: original }),
    prepared = await value.client.prepareImport([]);
  prepared.backup.workspace.data.opportunities[0].company = '伪造公司';
  prepared.summary.formalRecords = 999;
  await value.client.importCurrent(prepared, []);
  const command = value.calls.find((call) => call.method === 'POST').parsed;
  assert.equal(command.payload.workspace.data.opportunities[0].company, '合成迁移公司');
});

test('每次修改从服务最新版本计算，提交后仅将已确认结果缓存', async () => {
  const value = fixture();
  const saved = await value.client.editData((data) => {
    data.opportunities.push({
      id: 'job-1',
      company: '合成公司',
      role: '合成岗位',
      stage: '已触达',
    });
    return data;
  });
  assert.equal(saved.generation, 1);
  assert.deepEqual(value.cache, saved);
  const command = value.calls.find((call) => call.method === 'POST').parsed;
  assert.equal(command.type, 'edit_data');
  assert.equal(Object.hasOwn(command.payload, 'workspace'), false);
  assert.deepEqual(
    command.payload.changes.map((change) => change.group),
    ['opportunities'],
  );
  assert.equal((await value.client.read()).generation, 1);
});

test('409刷新缓存但不重新执行变换、不盲目覆盖服务更新', async () => {
  let mutations = 0;
  const value = fixture({
    custom: (call) =>
      call.method === 'POST'
        ? response({ message: 'conflict', code: 'WORKSPACE_REVISION_CONFLICT' }, 409)
        : undefined,
  });
  await assert.rejects(
    value.client.editData((data) => {
      mutations++;
      data.opportunities.push({
        id: 'job-1',
        company: '合成公司',
        role: '合成岗位',
        stage: '已触达',
      });
      return data;
    }),
    { code: 'WORKSPACE_REVISION_CONFLICT' },
  );
  assert.equal(mutations, 1);
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(value.calls.filter((call) => call.path === './__local/workspace').length, 2);
  assert.equal(value.cache.generation, 0);
});

test('本机客户端拒绝通用整库覆盖及通过业务编辑伪造来源账本', async () => {
  const value = fixture();
  await assert.rejects(
    value.client.update(() => initialWorkspace()),
    {
      code: 'LOCAL_WORKSPACE_COMMAND_REQUIRED',
    },
  );
  await assert.rejects(
    value.client.editData((data) => {
      data.sourceEvents.push({ id: 'forged' });
      return data;
    }),
  );
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 0);
});

test('本机客户端把冲突期间的业务编辑交给权威服务按岗位隔离', async () => {
  const workspace = initialWorkspace(),
    conflicted = {
      id: 'conflicted-job',
      company: '冲突公司',
      role: '冲突岗位',
      stage: '已触达',
    },
    independent = {
      id: 'independent-job',
      company: '独立公司',
      role: '独立岗位',
      stage: '已触达',
    };
  workspace.data.opportunities = [copy(conflicted), copy(independent)];
  workspace.base.opportunities = [copy(conflicted), copy(independent)];
  workspace.pending = {
    data: copy(workspace.data),
    remote: {
      ...copy(workspace.data),
      opportunities: [{ ...copy(conflicted), notes: '云端冲突' }, copy(independent)],
    },
    conflicts: [
      {
        key: 'opportunities:conflicted-job',
        group: 'opportunities',
        id: 'conflicted-job',
        base: copy(conflicted),
        local: { ...copy(conflicted), notes: '本机冲突' },
        remote: { ...copy(conflicted), notes: '云端冲突' },
      },
    ],
    generation: 0,
  };
  const value = fixture({ initial: workspace, cached: workspace });
  const saved = await value.client.editData((data) => {
    data.opportunities.find((row) => row.id === independent.id).notes = '独立编辑';
    return data;
  });
  assert.equal(saved.data.opportunities.find((row) => row.id === independent.id).notes, '独立编辑');
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 1);
});

test('本机同步命令只提交服务签发的事务标识，不回传整库或云端数据', async () => {
  const transactionId = 'sync-00000000-0000-4000-8000-000000000001';
  const value = fixture({
    custom: (call, { envelope }) => (call.method === 'POST' ? response(envelope()) : undefined),
  });
  await value.client.acknowledgeSync(transactionId);
  await value.client.stageSyncConflict(transactionId, 0);
  const commands = value.calls.filter((call) => call.method === 'POST').map((call) => call.parsed);
  assert.deepEqual(commands[0].payload, { syncTransactionId: transactionId });
  assert.deepEqual(commands[1].payload, { syncTransactionId: transactionId, generation: 0 });
  assert.equal(JSON.stringify(commands).includes('uploaded'), false);
  assert.equal(JSON.stringify(commands).includes('captured'), false);
  assert.equal(JSON.stringify(commands).includes('remote'), false);
});

test('响应丢失只重发同一命令ID，旧幂等响应后重新读最新正式版本', async () => {
  let posts = 0;
  const value = fixture({
    custom: (call, { envelope }) => {
      if (call.method !== 'POST') return;
      posts++;
      if (posts === 1) throw new TypeError('synthetic network interruption');
      return response({ ...envelope(), replayed: true, commandId: call.parsed.commandId });
    },
  });
  await value.client.editData((data) => {
    data.opportunities.push({
      id: 'job-1',
      company: '合成公司',
      role: '合成岗位',
      stage: '已触达',
    });
    return data;
  });
  const requests = value.calls.filter((call) => call.method === 'POST');
  assert.deepEqual(requests[0].parsed, requests[1].parsed);
  assert.equal(value.calls.at(-1).path, './__local/workspace');
});

test('本机服务中断只读验证缓存，正式写入不降级到IndexedDB', async () => {
  let unavailable = false;
  const value = fixture({
    custom: () => {
      if (unavailable) throw new TypeError('offline');
    },
  });
  await value.client.read();
  unavailable = true;
  assert.deepEqual(await value.client.read(), value.cache);
  assert.equal(value.client.status().offline, true);
  let changed = false;
  await assert.rejects(
    value.client.editData((data) => {
      changed = true;
      return data;
    }),
    { code: 'LOCAL_WORKSPACE_UNAVAILABLE' },
  );
  assert.equal(changed, false);
  assert.equal(value.offline, 1);
});

test('服务提交成功后的浏览器缓存失败不伪装成提交失败', async () => {
  const value = fixture({ brokenCache: true });
  const saved = await value.client.editData((data) => {
    data.opportunities.push({
      id: 'job-1',
      company: '合成公司',
      role: '合成岗位',
      stage: '已触达',
    });
    return data;
  });
  assert.equal(saved.generation, 1);
  assert.ok(value.cacheFailures > 0);
});

test('未来服务协议拒绝正式读写；静态域不访问本机服务', async () => {
  const invalid = fixture({
    custom: (call, { envelope }) =>
      call.path === './__local/workspace'
        ? response({ ...envelope(), protocolVersion: 2 })
        : undefined,
  });
  await assert.rejects(invalid.client.read(), { code: 'LOCAL_WORKSPACE_PROTOCOL' });
  const website = fixture({ hostname: 'example.com' });
  assert.equal(await website.client.read(), null);
  assert.equal(await website.client.update((value) => value), null);
  assert.equal(website.calls.length, 0);
});

test('忽略命令绑定已核对版本，丢失回复重用同一请求，不盲目跟随新版本', async () => {
  let posts = 0;
  const f = fixture({
    custom: async (call, { envelope }) => {
      if (call.path !== './__local/workspace/commands') return;
      assert.equal(call.parsed.type, 'ignore_boss_observations');
      posts++;
      if (posts === 1) throw new Error('synthetic lost reply');
      return response(envelope());
    },
  });
  await f.client.read();
  await assert.rejects(f.client.ignoreBossObservations(['synthetic-id'], 0), {
    code: 'WORKSPACE_REVISION_CONFLICT',
  });
  assert.equal(posts, 0);
  await f.client.ignoreBossObservations(['synthetic-id'], 1);
  const commands = f.calls.filter((call) => call.path === './__local/workspace/commands');
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].parsed, commands[1].parsed);
});
