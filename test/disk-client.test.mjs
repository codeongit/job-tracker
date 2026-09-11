import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDiskBackup } from '../dist/disk-backup.js';
import { initialWorkspace } from '../dist/workspace.js';

const stamp = '2026-09-11T08:00:00.000Z';
const copy = (value) => structuredClone(value);
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => copy(body),
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

function workspace(empty = false) {
  const state = initialWorkspace();
  state.config = { owner: 'example', repo: 'disk-client-tests', path: 'fixtures/data.json' };
  if (!empty)
    state.data.opportunities.push({
      id: 'synthetic-job',
      company: '合成示例',
      role: '中文工程师',
      stage: '已触达',
      notes: '本机中文记录 🚀',
    });
  state.base = copy(state.data);
  return state;
}

function draft() {
  return {
    id: randomUUID(),
    revision: randomUUID(),
    kind: 'editor',
    opportunityId: '',
    values: { company: '尚未提交的中文岗位', role: '', notes: '第一行\n第二行' },
    updatedAt: stamp,
  };
}

function browserEnvironment(t, { hostname = '127.0.0.1', locks = true } = {}) {
  const values = new Map();
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const window = new EventTarget();
  const lockNames = [];
  const replacements = {
    location: { hostname },
    localStorage,
    window,
    navigator: locks
      ? {
          locks: {
            request: async (name, callback) => {
              lockNames.push(name);
              return callback();
            },
          },
        }
      : {},
  };
  const descriptors = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const clients = [];
  t.after(() => {
    for (const client of clients) client.stop();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return {
    window,
    values,
    lockNames,
    track: (client) => {
      clients.push(client);
      return client;
    },
  };
}

function service(custom) {
  const calls = [];
  let sessions = 0;
  const fetcher = async (path, options = {}) => {
    const call = {
      path,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    if (custom) {
      const answer = await custom(call, calls);
      if (answer !== undefined) return answer;
    }
    if (path === './__local/session')
      return response({ backupEnabled: true, session: `synthetic-session-${++sessions}` });
    if (path === './__local/backups' && call.method === 'PUT') return response({ savedAt: stamp });
    throw new Error(`Unexpected fake endpoint: ${call.method} ${path}`);
  };
  return { calls, fetcher, puts: () => calls.filter((call) => call.method === 'PUT') };
}

test('空工作区或尚未初始化时不PUT，不以空内容替换既有磁盘历史', async (t) => {
  const env = browserEnvironment(t);
  const api = service();
  for (const state of [null, workspace(true)]) {
    const client = env.track(
      createDiskBackup({
        readWorkspace: async () => copy(state),
        readDrafts: () => [],
        fetcher: api.fetcher,
      }),
    );
    await client.run();
    assert.equal(api.calls.length, 0);
    if (state) assert.match(client.status().message, /已有磁盘备份保留/);
  }
});

test('完整工作区、冲突双方和草稿一起备份，只使用本机会话且不发送PAT', async (t) => {
  const env = browserEnvironment(t);
  env.window.inMemoryPat = 'synthetic-pat-not-for-backups';
  const state = workspace();
  const remote = copy(state.base);
  remote.opportunities[0].notes = '远端中文修改';
  state.data.opportunities[0].notes = '本机尚未同步的修改';
  state.generation = 2;
  state.pending = {
    data: copy(state.data),
    remote,
    generation: 2,
    conflicts: [
      {
        key: 'opportunities:synthetic-job',
        group: 'opportunities',
        id: 'synthetic-job',
        base: copy(state.base.opportunities[0]),
        local: copy(state.data.opportunities[0]),
        remote: copy(remote.opportunities[0]),
      },
    ],
  };
  const rows = [draft()];
  const before = copy({ state, rows });
  const api = service();
  const client = env.track(
    createDiskBackup({
      readWorkspace: async () => copy(state),
      readDrafts: () => copy(rows),
      fetcher: api.fetcher,
    }),
  );
  await client.run();
  const [put] = api.puts();
  assert.equal(api.puts().length, 1);
  assert.deepEqual(put.body.backup.workspace, state);
  assert.deepEqual(put.body.backup.drafts, rows);
  assert.equal(put.body.backup.backupVersion, 2);
  assert.match(put.body.sourceId, /^[a-f0-9-]{36}$/);
  assert.equal(put.headers['X-Job-Tracker-Session'], 'synthetic-session-1');
  assert.ok(
    api.calls.every(
      (call) => !Object.keys(call.headers).some((name) => name.toLowerCase() === 'authorization'),
    ),
  );
  assert.equal(JSON.stringify(api.calls).includes(env.window.inMemoryPat), false);
  assert.equal(JSON.stringify([...env.values]).includes(env.window.inMemoryPat), false);
  assert.deepEqual({ state, rows }, before);
  assert.deepEqual(env.lockNames, ['job-tracker-disk-backup']);
  assert.equal(client.status().lastSavedAt, stamp);
});

test('只有未提交草稿、没有正式记录时仍可生成独立备份，无Web Locks也可用', async (t) => {
  const env = browserEnvironment(t, { locks: false });
  const state = workspace(true),
    rows = [draft()],
    api = service();
  const client = env.track(
    createDiskBackup({
      readWorkspace: async () => state,
      readDrafts: () => rows,
      fetcher: api.fetcher,
    }),
  );
  await client.run();
  assert.equal(api.puts().length, 1);
  assert.deepEqual(api.puts()[0].body.backup.drafts, rows);
  assert.equal(api.puts()[0].body.backup.workspace.data.opportunities.length, 0);
});

test('本机服务重启返回403后重新获取session，并使用同一备份重试一次', async (t) => {
  const env = browserEnvironment(t);
  let acceptedSession = 'synthetic-session-1';
  const api = service((call) => {
    if (call.method === 'PUT' && call.headers['X-Job-Tracker-Session'] !== acceptedSession)
      return response({ message: '会话已过期' }, 403);
  });
  const client = env.track(
    createDiskBackup({
      readWorkspace: async () => workspace(),
      readDrafts: () => [],
      fetcher: api.fetcher,
    }),
  );
  await client.run();
  acceptedSession = 'synthetic-session-2';
  await client.run();
  assert.equal(api.calls.filter((call) => call.path === './__local/session').length, 2);
  assert.equal(api.puts().length, 3);
  assert.equal(api.puts()[1].headers['X-Job-Tracker-Session'], 'synthetic-session-1');
  assert.equal(api.puts()[2].headers['X-Job-Tracker-Session'], 'synthetic-session-2');
  assert.deepEqual(api.puts()[2].body, api.puts()[1].body);
  assert.equal(api.puts()[2].body.sourceId, api.puts()[0].body.sourceId);
  assert.match(client.status().message, /独立备份已保存/);
});

test('50MB上限和目录权限失败保留服务端具体原因，403不会无限重试', async (t) => {
  const env = browserEnvironment(t);
  for (const [status, message] of [
    [413, '独立备份超过50MB限制，请整理内容后重试。'],
    [403, '备份目录没有写入权限，请检查本机目录权限。'],
  ]) {
    const state = workspace(),
      rows = [draft()],
      before = copy({ state, rows });
    const api = service((call) =>
      call.method === 'PUT' ? response({ message }, status) : undefined,
    );
    const client = env.track(
      createDiskBackup({
        readWorkspace: async () => state,
        readDrafts: () => rows,
        fetcher: api.fetcher,
      }),
    );
    await client.run();
    assert.ok(client.status().message.includes(message));
    assert.match(client.status().message, /本机记录与草稿仍保留/);
    assert.equal(api.puts().length, status === 403 ? 2 : 1);
    assert.deepEqual({ state, rows }, before);
  }
});

test('连接TypeError与超时给出启动本机服务提示，不改变记录和草稿', async (t) => {
  const env = browserEnvironment(t);
  for (const error of [
    new TypeError('Failed to fetch'),
    new DOMException('timeout', 'TimeoutError'),
  ]) {
    const state = workspace(),
      rows = [draft()],
      before = copy({ state, rows });
    const client = env.track(
      createDiskBackup({
        readWorkspace: async () => state,
        readDrafts: () => rows,
        fetcher: async () => {
          throw error;
        },
      }),
    );
    await client.run();
    assert.match(client.status().message, /无法连接本机服务，请启动服务后重试/);
    assert.match(client.status().message, /本机记录与草稿仍保留/);
    assert.deepEqual({ state, rows }, before);
  }
});

test('start立即备份，保存事件合并调度；内容不变不反复PUT或自行循环', async (t) => {
  const env = browserEnvironment(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date(stamp) });
  const state = workspace(),
    api = service();
  let reads = 0;
  const client = env.track(
    createDiskBackup({
      readWorkspace: async () => {
        reads++;
        return copy(state);
      },
      readDrafts: () => [],
      fetcher: api.fetcher,
      delay: 100,
      poll: 10000,
    }),
  );
  client.start();
  await settle();
  assert.equal(reads, 1);
  assert.equal(api.puts().length, 1);
  env.window.dispatchEvent(new Event('workspace-saved'));
  env.window.dispatchEvent(new Event('drafts-saved'));
  env.window.dispatchEvent(new Event('workspace-saved'));
  t.mock.timers.tick(99);
  await settle();
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(reads, 2);
  assert.equal(api.puts().length, 1);
  t.mock.timers.tick(300);
  await settle();
  assert.equal(reads, 2, 'Unchanged backup does not schedule itself again');
  state.data.opportunities[0].notes = '保存事件后的新内容';
  state.generation++;
  env.window.dispatchEvent(new Event('workspace-saved'));
  t.mock.timers.tick(100);
  await settle();
  assert.equal(api.puts().length, 2);
  assert.equal(
    api.puts()[1].body.backup.workspace.data.opportunities[0].notes,
    '保存事件后的新内容',
  );
});

test('poll和focus检查新草稿；stop清理轮询、待执行计时器及事件监听', async (t) => {
  const env = browserEnvironment(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date(stamp) });
  const state = workspace(),
    rows = [draft()],
    api = service();
  let reads = 0;
  const client = env.track(
    createDiskBackup({
      readWorkspace: async () => {
        reads++;
        return copy(state);
      },
      readDrafts: () => copy(rows),
      fetcher: api.fetcher,
      delay: 10,
      poll: 100,
    }),
  );
  client.start();
  await settle();
  t.mock.timers.tick(100);
  await settle();
  assert.equal(reads, 2);
  assert.equal(api.puts().length, 1);
  rows[0].values.notes = '轮询发现的新草稿';
  rows[0].revision = randomUUID();
  t.mock.timers.tick(100);
  await settle();
  assert.equal(api.puts().length, 2);
  rows[0].values.notes = '重新聚焦后的新草稿';
  env.window.dispatchEvent(new Event('focus'));
  await settle();
  assert.equal(api.puts().length, 3);
  env.window.dispatchEvent(new Event('drafts-saved'));
  client.stop();
  const stoppedReads = reads;
  env.window.dispatchEvent(new Event('workspace-saved'));
  env.window.dispatchEvent(new Event('drafts-saved'));
  env.window.dispatchEvent(new Event('focus'));
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(reads, stoppedReads);
  assert.equal(api.puts().length, 3);
});

test('stop发生在进行中的备份结束前，也不再调度积压的自动备份', async (t) => {
  const env = browserEnvironment(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date(stamp) });
  const state = workspace(),
    api = service();
  let release,
    reads = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = env.track(
    createDiskBackup({
      readWorkspace: async () => {
        reads++;
        await gate;
        return copy(state);
      },
      readDrafts: () => [],
      fetcher: api.fetcher,
      delay: 10,
      poll: 100,
    }),
  );
  client.start();
  await settle();
  env.window.dispatchEvent(new Event('drafts-saved'));
  t.mock.timers.tick(10);
  await settle();
  client.stop();
  release();
  await settle();
  assert.equal(reads, 1);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(reads, 1, 'An in-flight run must not recreate timers after stop');
});

test('公开网页不启动本机自动备份，也不尝试连接本机接口', async (t) => {
  const env = browserEnvironment(t, { hostname: 'example.test' });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const api = service();
  let reads = 0;
  const client = env.track(
    createDiskBackup({
      readWorkspace: async () => {
        reads++;
        return workspace();
      },
      readDrafts: () => [],
      fetcher: api.fetcher,
    }),
  );
  client.start();
  await client.run();
  env.window.dispatchEvent(new Event('workspace-saved'));
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(reads, 0);
  assert.equal(api.calls.length, 0);
  assert.match(client.status().message, /自动磁盘备份需要本机服务/);
});
