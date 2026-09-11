import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyData,
  clone,
  equal,
  live,
  mergeData,
  serialize,
  parseMarkdown,
} from '../dist/model.js';
import {
  initialWorkspace,
  migrateWorkspace,
  migrateData,
  createBackup,
  parseBackup,
  restoreWorkspace,
} from '../dist/workspace.js';
import { MAX_SYNC_BYTES, serializeForSync, utf8Bytes } from '../dist/limits.js';
import { githubClient, syncWorkspace } from '../dist/github.js';
import { GitStore, classifyGitFailure, decodeGitOutput } from '../scripts/ssh-store.mjs';
const job = (id, notes = '') => ({
  id,
  company: '合成示例',
  role: '中文工程师 🚀',
  stage: '已触达',
  notes,
});
const data = (...jobs) => ({ ...emptyData(), opportunities: jobs });
function workspace(d = data(job('a'))) {
  return { ...initialWorkspace(), data: clone(d), base: clone(d) };
}
function conflictWorkspace() {
  const s = workspace();
  s.data.opportunities[0].notes = '本机';
  const remote = data(job('a', '远端')),
    combined = mergeData(s.base, s.data, remote);
  s.pending = { ...combined, remote, generation: s.generation };
  return s;
}

test('旧工作区升级幂等，保留数据、基线、删除标记和冲突双方且不修改输入', () => {
  const old = conflictWorkspace();
  delete old.workspaceVersion;
  old.data.tasks.push({ id: 'deleted-task', deletedAt: '2026-01-01' });
  const before = clone(old),
    upgraded = migrateWorkspace(old);
  assert.equal(upgraded.workspaceVersion, 2);
  assert.deepEqual(old, before);
  assert.deepEqual(migrateWorkspace(upgraded), upgraded);
  assert.equal(upgraded.pending.conflicts[0].remote.notes, '远端');
  assert.equal(upgraded.data.tasks[0].deletedAt, '2026-01-01');
});
test('未来数据/工作区版本和未知字段拒绝写入，不静默丢弃字段', () => {
  assert.throws(() => migrateData({ ...emptyData(), schemaVersion: 2 }), /版本/);
  assert.throws(() => migrateWorkspace({ ...workspace(), workspaceVersion: 3 }), /版本/);
  const d = data(job('a'));
  d.opportunities[0].futureField = '保留';
  assert.throws(() => migrateData(d), /未知字段/);
  assert.equal(d.opportunities[0].futureField, '保留');
  assert.throws(() => migrateWorkspace({ ...workspace(), token: 'fake' }), /未知字段/);
});
test('完整备份往返保留待解决冲突，快照恢复更新generation且合并模式拒绝丢掉冲突', () => {
  const source = conflictWorkspace(),
    backup = createBackup(source);
  assert.deepEqual(parseBackup(JSON.parse(JSON.stringify(backup))).workspace, source);
  const target = workspace();
  target.generation = 9;
  const restored = restoreWorkspace(target, backup, 'snapshot');
  assert.equal(restored.generation, 10);
  assert.equal(restored.pending.generation, 10);
  assert.equal(restored.pending.conflicts[0].local.notes, '本机');
  assert.equal(restored.pending.conflicts[0].remote.notes, '远端');
  assert.throws(() => restoreWorkspace(target, backup, 'merge'), /冲突/);
});
test('回到旧快照作为新的本机修改，额外记录留删除标记，再同步不会复活', async () => {
  let state = workspace(data(job('a', '后来修改'), job('b', '后来新增')));
  const remote = clone(state.base),
    backup = data(job('a', '旧内容'));
  state = restoreWorkspace(state, backup, 'snapshot');
  assert.equal(live(state.data.opportunities).length, 1);
  assert.ok(state.data.opportunities.find((o) => o.id === 'b').deletedAt);
  assert.deepEqual(state.base, remote);
  assert.equal(equal(state.data, state.base), false);
  let uploaded;
  await syncWorkspace({
    client: {
      read: async () => ({ data: remote, sha: 'fake', missing: false }),
      write: async (d) => {
        uploaded = clone(d);
      },
    },
    readState: async () => clone(state),
    updateState: async (fn) => (state = fn(clone(state))),
  });
  assert.equal(uploaded.opportunities[0].notes, '旧内容');
  assert.equal(live(uploaded.opportunities).length, 1);
});
test('合并恢复保留独有记录，删除岗位会联动关联任务；恢复前冲突必须先解决', () => {
  const current = workspace(data(job('a'), job('b'))),
    deleted = data({ ...job('a'), deletedAt: '2026-01-01' });
  current.data.tasks.push({ id: 'task', opportunityId: 'a', text: '跟进', status: '待办' });
  const restored = restoreWorkspace(current, deleted, 'merge');
  assert.ok(restored.data.opportunities.find((o) => o.id === 'b'));
  assert.ok(restored.data.tasks[0].deletedAt);
  assert.throws(() => restoreWorkspace(conflictWorkspace(), deleted, 'snapshot'), /先解决/);
});
function sizedData(bytes) {
  const d = data(job('boundary', '中文🚀"\\\n'));
  const padding = bytes - utf8Bytes(serialize(d));
  assert.ok(padding >= 0);
  d.opportunities[0].notes += 'x'.repeat(padding);
  return d;
}
test('最终UTF-8文件恰好5MB可同步，超出一字节拒绝；紧凑请求体大小不能绕过', () => {
  for (const delta of [-1, 0])
    assert.equal(
      utf8Bytes(serializeForSync(sizedData(MAX_SYNC_BYTES + delta))),
      MAX_SYNC_BYTES + delta,
    );
  const over = sizedData(MAX_SYNC_BYTES + 1);
  assert.ok(utf8Bytes(JSON.stringify({ data: over, sha: null })) < MAX_SYNC_BYTES);
  assert.throws(() => serializeForSync(over), /5 MB/);
  assert.ok(createBackup(workspace(over)).workspace.data); // Emergency backup is never capped by sync size.
});
test('SSH和PAT在访问远端前拒绝无法读回的超限文件', async () => {
  const over = sizedData(MAX_SYNC_BYTES + 1);
  let calls = 0;
  const ssh = new GitStore({ cache: 'unused', remote: 'unused', path: 'data.json' });
  ssh.exclusive = (fn) => fn();
  ssh.fetchHead = async () => {
    calls++;
    throw new Error('不应访问');
  };
  await assert.rejects(
    () => ssh.write(over, null),
    (e) => e.status === 413,
  );
  const client = githubClient(
    { owner: 'example', repo: 'private', path: 'data.json' },
    'fake',
    async () => {
      calls++;
      throw new Error('不应访问');
    },
  );
  await assert.rejects(() => client.write(over, null), /5 MB/);
  assert.equal(calls, 0);
});
test('GitHub大文件按blob SHA读取raw，不受元数据读取后分支变化影响', async () => {
  const source = sizedData(1_100_000),
    blob = 'a'.repeat(40);
  let calls = 0;
  const client = githubClient(
    { owner: 'example', repo: 'private', path: 'data.json' },
    'fake',
    async (url, options) => {
      calls++;
      if (calls === 1) return Response.json({ private: true, default_branch: 'main' });
      if (calls === 2) return Response.json({ name: 'main' });
      if (calls === 3)
        return Response.json({
          type: 'file',
          encoding: 'none',
          size: 1_100_000,
          sha: blob,
          content: '',
        });
      assert.ok(url.endsWith('/git/blobs/' + blob));
      assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
      return new Response(serialize(source));
    },
  );
  const r = await client.read();
  assert.equal(r.sha, blob);
  assert.deepEqual(r.data, source);
  assert.equal(calls, 4);
});
test('raw内容超限、非法UTF-8或blob丢失均报错，不被当作空仓库', async () => {
  for (const result of [
    () => new Response('x'.repeat(MAX_SYNC_BYTES + 1)),
    () => new Response(Uint8Array.from([255, 255])),
    () => new Response('', { status: 404 }),
  ]) {
    let i = 0;
    const client = githubClient(
      { owner: 'example', repo: 'private', path: 'data.json' },
      'fake',
      async () => {
        i++;
        return i === 1
          ? Response.json({ private: true, default_branch: 'main' })
          : i === 2
            ? Response.json({ name: 'main' })
            : i === 3
              ? Response.json({ type: 'file', encoding: 'none', size: 2, sha: 'a'.repeat(40) })
              : result();
      },
    );
    await assert.rejects(() => client.read(), /校验失败/);
  }
});
test('诊断分类不回显Git原始输出或私有路径', () => {
  for (const [stderr, code] of [
    ['Permission denied (publickey). private-record', 'SSH_AUTH_FAILED'],
    ['Could not resolve hostname github.com', 'SSH_NETWORK'],
    ['Repository not found. private-name', 'REPOSITORY_ACCESS'],
    ['[rejected] private-path', 'VERSION_CONFLICT'],
  ]) {
    const error = classifyGitFailure({ stderr });
    assert.equal(error.code, code);
    assert.ok(!error.message.includes('private'));
  }
});
test('导入默认年份跟随当前年份，并可显式导入2026历史记录', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2028-09-11T12:00:00Z') });
  const md =
    '| 公司 | 岗位 | 链接 | 平台 | 日期 | 状态 |\n|---|---|---|---|---|---|\n|示例|工程师| |BOSS|0907|已读|';
  const current = await parseMarkdown(md),
    historic = await parseMarkdown(md, '2026');
  assert.equal(current.rows[0].opportunity.appliedAt, '2028-09-07');
  assert.equal(historic.rows[0].opportunity.appliedAt, '2026-09-07');
});

test('完整备份缺少workspace时拒绝恢复，不能解释为空快照', () => {
  for (const workspace of [undefined, null, [], 42])
    assert.throws(() => parseBackup({ backupVersion: 1, workspace }), /缺少|无效/);
});

test('Git分块读取保留跨边界中文，非法UTF-8明确拒绝', () => {
  const bytes = Buffer.from('招聘 🚀');
  assert.equal(
    decodeGitOutput([bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)]),
    '招聘 🚀',
  );
  assert.throws(() => decodeGitOutput([Buffer.from([255])]), /UTF-8/);
});
