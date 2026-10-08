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
  storageVersion = 1,
  makeId,
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
    storageVersion,
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
    makeId,
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

test('客户端接受存储版本2，读写继续使用协议1并缓存正式结果', async () => {
  const value = fixture({ storageVersion: 2 });
  assert.deepEqual(await value.client.read(), initialWorkspace());
  const saved = await value.client.editData((data) => {
    data.opportunities.push({
      id: 'catalog-job',
      company: '合成目录公司',
      role: '合成目录岗位',
      stage: '已触达',
    });
    return data;
  });
  assert.equal(saved.data.opportunities[0].id, 'catalog-job');
  assert.deepEqual(value.cache, saved);
  assert.equal(value.envelope().storageVersion, 2);
  assert.equal(value.envelope().revision, 2);
  const command = value.calls.find((call) => call.method === 'POST');
  assert.equal(command.headers['X-Job-Tracker-Protocol'], '1');
  assert.equal(command.parsed.expectedRevision, 1);
});

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

test('未知存储版本拒绝读取和修改，不覆盖缓存或退回静态写入', async () => {
  const cached = populatedWorkspace();
  const value = fixture({ storageVersion: 3, cached });
  await assert.rejects(value.client.read(), { code: 'LOCAL_WORKSPACE_PROTOCOL' });
  let transformed = false;
  await assert.rejects(
    value.client.editData((data) => {
      transformed = true;
      return data;
    }),
    { code: 'LOCAL_WORKSPACE_PROTOCOL' },
  );
  assert.equal(transformed, false);
  assert.deepEqual(value.cache, cached);
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(value.client.mode(), 'local');
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

test('资料确认命令使用已核对版本，丢失回复精确重试同一幂等请求', async () => {
  let posts = 0;
  const payload = {
    applicationIds: ['synthetic-ordinary-application'],
    opportunityId: 'synthetic-target',
    externalJobId: 'synthetic-job~',
    canonicalUrl: 'https://www.zhipin.com/job_detail/synthetic-job~.html',
  };
  const f = fixture({
    custom: (call, { envelope }) => {
      if (call.path !== './__local/workspace/commands') return;
      posts++;
      assert.equal(call.parsed.type, 'resolve_boss_job_details');
      assert.deepEqual(call.parsed.payload, payload);
      if (posts === 1) throw new Error('synthetic lost reply');
      return response({ ...envelope(), replayed: true });
    },
  });
  await f.client.read();
  await assert.rejects(f.client.resolveBossJobDetails(payload, 0), {
    code: 'WORKSPACE_REVISION_CONFLICT',
  });
  assert.equal(posts, 0);
  const saved = await f.client.resolveBossJobDetails(payload, 1);
  const commands = f.calls.filter((call) => call.path === './__local/workspace/commands');
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0].parsed, commands[1].parsed);
  assert.equal(f.calls.at(-1).path, './__local/workspace');
  assert.deepEqual(saved, f.cache);
});

test('资料确认版本冲突不自动换版本重放，保存失败不更改本机缓存', async () => {
  for (const [status, code] of [
    [409, 'WORKSPACE_REVISION_CONFLICT'],
    [500, 'SNAPSHOT_FAILED'],
  ]) {
    const f = fixture({
      custom: (call) =>
        call.path === './__local/workspace/commands'
          ? response({ message: 'synthetic save failed', code }, status)
          : undefined,
    });
    const original = structuredClone(f.cache);
    await assert.rejects(
      f.client.resolveBossJobDetails({ applicationIds: ['synthetic-application'] }, 1),
      { code },
    );
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
    assert.deepEqual(f.cache, original);
  }
});

test('核对快照只读取一次正式状态，资料与版本来自同一响应', async () => {
  let reads = 0;
  const f = fixture({
    authorityValue: JSON.stringify({ workspaceId: '00000000-0000-4000-8000-000000000001' }),
    custom: (call, { envelope }) => {
      if (call.path !== './__local/workspace') return;
      reads++;
      const current = envelope();
      current.revision = 7 + reads;
      current.workspace.generation = current.revision;
      return response(current);
    },
  });
  const reviewed = await f.client.readForReview();
  assert.equal(reads, 1);
  assert.equal(reviewed.revision, 8);
  assert.equal(reviewed.state.generation, 8);
  assert.equal(reviewed.workspaceId, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(reviewed.state, f.cache);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('核对快照串行等待已有修改完成，再返回最新正式版本', async () => {
  const f = fixture();
  const saving = f.client.editData((data) => {
    data.opportunities.push({
      id: 'before-review',
      company: '合成公司',
      role: '合成岗位',
      stage: '已触达',
    });
    return data;
  });
  const reviewing = f.client.readForReview();
  await saving;
  const reviewed = await reviewing;
  assert.equal(reviewed.revision, 2);
  assert.equal(reviewed.state.data.opportunities[0].id, 'before-review');
  assert.deepEqual(reviewed.state, f.cache);
});

test('核对快照拒绝离线缓存及静态模式，不把旧状态作为可提交依据', async () => {
  let offline = false;
  const f = fixture({
    custom: () => {
      if (offline) throw new TypeError('offline');
    },
  });
  await f.client.read();
  const original = structuredClone(f.cache);
  offline = true;
  assert.deepEqual(await f.client.read(), original);
  await assert.rejects(f.client.readForReview(), { code: 'LOCAL_WORKSPACE_UNAVAILABLE' });
  assert.deepEqual(f.cache, original);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  const website = fixture({ hostname: 'example.com' });
  await assert.rejects(website.client.readForReview(), { code: 'LOCAL_WORKSPACE_REQUIRED' });
  assert.equal(website.calls.length, 0);
});

const commandEntrances = [
  {
    name: '普通编辑',
    run: (client, transformed = () => {}) =>
      client.editData((data) => {
        transformed();
        data.opportunities.push({
          id: 'delivery-job',
          company: '合成交付公司',
          role: '合成交付岗位',
          stage: '已触达',
        });
        return data;
      }),
  },
  {
    name: '固定命令',
    run: (client) => client.ignoreBossObservations(['synthetic-application'], 1),
  },
];

test('普通编辑无变化不生成命令，随后固定操作仍可正常保存', async () => {
  let ids = 0;
  const f = fixture({
    makeId: () => `synthetic-command-${++ids}`,
    custom: (call, { envelope }) => (call.method === 'POST' ? response(envelope()) : undefined),
  });
  assert.deepEqual(await f.client.editData((data) => data), initialWorkspace());
  assert.equal(ids, 0);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  await f.client.ignoreBossObservations(['synthetic-application'], 1);
  assert.equal(ids, 1);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('固定操作和普通编辑共用串行顺序，编辑读取前一操作后的正式状态', async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let formal = initialWorkspace(),
    revision = 1,
    transformations = 0;
  const f = fixture({
    custom: async (call, { envelope }) => {
      const current = () => ({ ...envelope(), workspace: copy(formal), revision });
      if (call.path === './__local/workspace') return response(current());
      if (call.method !== 'POST') return;
      assert.equal(call.parsed.expectedRevision, revision);
      if (call.parsed.type === 'ignore_boss_observations') {
        entered.resolve();
        await release.promise;
      } else {
        assert.equal(call.parsed.type, 'edit_data');
        formal.data.opportunities = call.parsed.payload.changes.map((change) => change.record);
      }
      formal.generation++;
      revision++;
      return response(current());
    },
  });
  await f.client.active();
  const fixed = f.client.ignoreBossObservations(['synthetic-application'], 1);
  const editing = f.client.editData((data) => {
    transformations++;
    assert.equal(formal.generation, 1);
    data.opportunities.push({
      id: 'after-fixed-command',
      company: '合成串行公司',
      role: '合成串行岗位',
      stage: '已触达',
    });
    return data;
  });
  await entered.promise;
  assert.equal(transformations, 0);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  release.resolve();
  await fixed;
  const saved = await editing;
  assert.equal(saved.generation, 2);
  assert.equal(saved.data.opportunities[0].id, 'after-fixed-command');
  assert.deepEqual(f.cache, saved);
  assert.deepEqual(
    f.calls.filter((call) => call.method === 'POST').map((call) => call.parsed.expectedRevision),
    [1, 2],
  );
});

test('两种命令入口的版本冲突只刷新，保存失败不留下候选修改', async (t) => {
  for (const entry of commandEntrances) {
    for (const [status, code] of [
      [409, 'WORKSPACE_REVISION_CONFLICT'],
      [500, 'SNAPSHOT_FAILED'],
    ]) {
      await t.test(`${entry.name} ${status}`, async () => {
        let attempted = false,
          transformed = 0;
        const f = fixture({
          custom: (call, { envelope }) => {
            if (call.method === 'POST') {
              attempted = true;
              return response({ code, message: 'synthetic rejected save' }, status);
            }
            if (call.path === './__local/workspace' && attempted) {
              const latest = envelope();
              latest.revision = 5;
              latest.workspace.generation = 5;
              return response(latest);
            }
          },
        });
        await assert.rejects(
          entry.run(f.client, () => transformed++),
          { code },
        );
        assert.equal(transformed, entry.name === '普通编辑' ? 1 : 0);
        assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
        assert.equal(f.cache.generation, status === 409 ? 5 : 0);
        assert.equal(f.cache.data.opportunities.length, 0);
      });
    }
  }
});

test('两种入口丢失响应后重发原命令，旧回执不覆盖最新数据，缓存失败仍返回正式结果', async (t) => {
  for (const entry of commandEntrances) {
    for (const brokenCache of [false, true]) {
      await t.test(`${entry.name} cacheFailure=${brokenCache}`, async () => {
        let posts = 0,
          ids = 0;
        const f = fixture({
          brokenCache,
          makeId: () => `synthetic-command-${++ids}`,
          custom: (call, { envelope }) => {
            if (call.method === 'POST') {
              posts++;
              if (posts === 1) throw new TypeError('synthetic committed reply lost');
              const old = envelope();
              old.workspace.generation = 1;
              return response({ ...old, replayed: true });
            }
            if (call.path === './__local/workspace' && posts) {
              const latest = envelope();
              latest.revision = 7;
              latest.workspace.generation = 7;
              return response(latest);
            }
          },
        });
        const saved = await entry.run(f.client);
        const commands = f.calls.filter((call) => call.method === 'POST');
        assert.equal(commands.length, 2);
        assert.equal(ids, 1);
        assert.equal(commands[0].body, commands[1].body);
        assert.equal(saved.generation, 7);
        assert.equal(f.calls.at(-1).path, './__local/workspace');
        if (brokenCache) assert.ok(f.cacheFailures > 0);
        else assert.deepEqual(f.cache, saved);
      });
    }
  }
});
