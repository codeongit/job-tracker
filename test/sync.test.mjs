import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData, clone, equal } from '../dist/model.js';
import {
  syncWorkspace,
  acknowledge,
  githubClient,
  RemoteError,
  encodeUtf8,
  decodeUtf8,
} from '../dist/github.js';
const job = (id, notes = '') => ({ id, company: '示例', role: '工程师', stage: '已触达', notes });
const data = (...jobs) => ({ ...emptyData(), opportunities: jobs });
const stateFor = (d) => ({
  data: clone(d),
  base: clone(d),
  config: { owner: 'example', repo: 'private', path: 'data.json' },
  generation: 0,
  lastSync: '',
  pending: null,
});
function storage(initial) {
  let value = clone(initial);
  return {
    readState: async () => clone(value),
    updateState: async (fn) => (value = fn(clone(value))),
    get: () => value,
  };
}
test('上传期间新增编辑仍待同步，基线只确认上传快照', async () => {
  const initial = stateFor(data(job('a')));
  initial.data.opportunities[0].notes = '本次上传';
  const store = storage(initial);
  let sent;
  const client = {
    read: async () => ({ data: initial.base, sha: 's', missing: false }),
    write: async (d) => {
      sent = clone(d);
      await store.updateState((s) => {
        s.data.opportunities.push(job('b'));
        s.generation++;
        return s;
      });
    },
  };
  const r = await syncWorkspace({ client, ...store });
  assert.equal(sent.opportunities.length, 1);
  assert.equal(store.get().base.opportunities.length, 1);
  assert.equal(store.get().data.opportunities.length, 2);
  assert.equal(r.dirty, true);
});
test('上传期间相同记录又有分歧，保留冲突并禁止误标已同步', () => {
  const captured = stateFor(data(job('a'))),
    current = clone(captured);
  current.generation++;
  current.data.opportunities[0].notes = '新本机';
  const result = acknowledge(current, captured, data(job('a', '云端')));
  assert.ok(result.pending);
  assert.equal(result.pending.conflicts[0].local.notes, '新本机');
  assert.equal(result.pending.conflicts[0].remote.notes, '云端');
  assert.equal(result.base.opportunities[0].notes, '云端');
});
test('409 后重新读取合并，保留另一设备的新岗位', async () => {
  const start = stateFor(data(job('a')));
  start.data.opportunities[0].notes = '本机';
  const store = storage(start);
  let reads = 0,
    writes = 0,
    last;
  const client = {
    read: async () => ({
      data: ++reads === 1 ? start.base : data(job('a'), job('b')),
      sha: String(reads),
      missing: false,
    }),
    write: async (d) => {
      if (++writes === 1) throw new RemoteError('race', 409);
      last = clone(d);
    },
  };
  await syncWorkspace({ client, ...store });
  assert.equal(reads, 2);
  assert.equal(writes, 2);
  assert.equal(last.opportunities.length, 2);
  assert.equal(last.opportunities[0].notes, '本机');
});
test('并发冲突不会上传或更新基线', async () => {
  const start = stateFor(data(job('a')));
  start.data.opportunities[0].notes = '本机';
  const store = storage(start);
  let writes = 0;
  const r = await syncWorkspace({
    client: {
      read: async () => ({ data: data(job('a', '云端')), sha: 's' }),
      write: async () => writes++,
    },
    ...store,
  });
  assert.equal(r.conflicts.length, 1);
  assert.equal(writes, 0);
  assert.ok(equal(store.get().base, start.base));
});
test('PUT 超时但远端已提交，读回确认而不重复写', async () => {
  const start = stateFor(data(job('a')));
  start.data.opportunities[0].notes = '上传';
  const store = storage(start);
  let remote = clone(start.base),
    writes = 0;
  const client = {
    read: async () => ({ data: remote, sha: 's', missing: false }),
    write: async (d) => {
      writes++;
      remote = clone(d);
      throw new RemoteError('timeout', 0);
    },
  };
  const r = await syncWorkspace({ client, ...store });
  assert.equal(writes, 1);
  assert.equal(r.dirty, false);
});
test('离线失败保留本机修改与原基线', async () => {
  const start = stateFor(data(job('a')));
  start.data.opportunities[0].notes = '离线';
  const store = storage(start);
  await assert.rejects(() =>
    syncWorkspace({
      client: {
        read: async () => {
          throw new Error('offline');
        },
      },
      ...store,
    }),
  );
  assert.deepEqual(store.get(), start);
});
test('新文件缺失先要求初始化；已有远端丢失不自动重建', async () => {
  const start = stateFor(emptyData());
  start.data = data(job('a'));
  const store = storage(start);
  let writes = 0;
  const client = {
    read: async () => ({ data: emptyData(), missing: true, sha: null }),
    write: async () => writes++,
  };
  assert.equal((await syncWorkspace({ client, ...store })).needsCreate, true);
  assert.equal(writes, 0);
  await syncWorkspace({ client, ...store, allowCreate: true });
  assert.equal(writes, 1);
  await assert.rejects(() => syncWorkspace({ client, ...store, allowCreate: true }), /消失/);
});
test('仓库认证 404 不当作空文件，公开仓库拒绝同步', async () => {
  let calls = 0;
  const c = githubClient(
    { owner: 'example', repo: 'repo', path: 'data.json' },
    'fake',
    async () => {
      calls++;
      return new Response('{}', { status: 404 });
    },
  );
  await assert.rejects(
    () => c.read(),
    (e) => e.status === 404,
  );
  assert.equal(calls, 1);
  const publicClient = githubClient(
    { owner: 'example', repo: 'repo', path: 'data.json' },
    'fake',
    async () => new Response(JSON.stringify({ private: false })),
  );
  await assert.rejects(() => publicClient.read(), /不是私有/);
});
test('验证私有仓库及分支后，文件404才返回缺失；错误JSON不被覆盖', async () => {
  const config = { owner: 'example', repo: 'repo', path: '目录/data.json' };
  let i = 0;
  const responses = [{ private: true, default_branch: 'main' }, { name: 'main' }, null];
  const c = githubClient(config, 'fake', async () => {
    const value = responses[i++];
    return new Response(JSON.stringify(value), { status: value === null ? 404 : 200 });
  });
  assert.equal((await c.read()).missing, true);
  assert.equal(i, 3);
  i = 0;
  const broken = githubClient(
    config,
    'fake',
    async () =>
      new Response(
        JSON.stringify(
          i++ === 0
            ? { private: true, default_branch: 'main' }
            : i === 2
              ? { name: 'main' }
              : {
                  type: 'file',
                  size: 10,
                  encoding: 'base64',
                  sha: 's',
                  content: encodeUtf8('{broken'),
                },
        ),
      ),
  );
  await assert.rejects(() => broken.read(), /校验失败/);
});
test('中文及 emoji 往返编码不会损坏', () => {
  const s = '简历准备 / 岗位 🚀';
  assert.equal(decodeUtf8(encodeUtf8(s)), s);
});
