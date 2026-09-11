import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { GitStore, runGit, createSshStore } from '../scripts/ssh-store.mjs';
import { handleLocalApi } from '../scripts/local-api.mjs';
import { emptyData, clone } from '../dist/model.js';

const data = (note) => ({
  ...emptyData(),
  opportunities: [{ id: 'a', company: '测试公司', role: '测试岗位', stage: '已触达', notes: note }],
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git'),
    work = join(root, 'work');
  await mkdir(work);
  await runGit(['init', '--quiet', '--bare', '-b', 'main', remote]);
  await runGit(['init', '--quiet', '-b', 'main'], { cwd: work });
  await writeFile(join(work, 'note.md'), 'keep this note\n');
  await runGit(['add', 'note.md'], { cwd: work });
  await runGit(
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '--quiet',
      '-m',
      'Initial note',
    ],
    { cwd: work },
  );
  await runGit(['remote', 'add', 'origin', remote], { cwd: work });
  await runGit(['push', '--quiet', 'origin', 'HEAD:main'], { cwd: work });
  return {
    root,
    remote,
    work,
    store: new GitStore({
      cache: join(root, 'cache.git'),
      remote,
      path: '简历准备/job-tracker/data.json',
    }),
  };
}
test('SSH Git 提交只写目标 JSON，保留笔记；读写版本为文件 blob SHA', async (t) => {
  const { store, remote } = await fixture(t);
  const first = await store.read();
  assert.equal(first.missing, true);
  const result = await store.write(data('中文 🚀'), null);
  const fetched = await store.read();
  assert.equal(fetched.sha, result.sha);
  assert.notEqual(result.commit, result.sha);
  assert.equal(fetched.data.opportunities[0].notes, '中文 🚀');
  assert.equal(await runGit(['show', 'main:note.md'], { cwd: remote }), 'keep this note\n');
  const same = await store.write(data('中文 🚀'), result.sha);
  assert.equal(same.commit, result.commit);
});
test('读取后其他笔记有新提交，基于最新树更新而不回退笔记', async (t) => {
  const { store, remote, work } = await fixture(t);
  const read = await store.read();
  await writeFile(join(work, 'note.md'), 'new note\n');
  await runGit(['add', 'note.md'], { cwd: work });
  await runGit(
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '--quiet',
      '-m',
      'Edit note',
    ],
    { cwd: work },
  );
  await runGit(['push', '--quiet', 'origin', 'HEAD:main'], { cwd: work });
  await store.write(data('new job'), read.sha);
  assert.equal(await runGit(['show', 'main:note.md'], { cwd: remote }), 'new note\n');
});
test('旧文件 SHA 被拒绝，同缓存并发写串行化且不覆盖', async (t) => {
  const { store } = await fixture(t);
  const read = await store.read();
  const result = await Promise.allSettled([
    store.write(data('first'), read.sha),
    store.write(data('second'), read.sha),
  ]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(result.find((r) => r.status === 'rejected').reason.status, 409);
  assert.equal((await store.read()).data.opportunities[0].notes, 'first');
});
test('push 前远端推进时，普通 push 拒绝，不强制覆盖', async (t) => {
  const { store, root, remote } = await fixture(t);
  await store.write(data('base'), null);
  const original = await store.read();
  const other = new GitStore({ cache: join(root, 'other.git'), remote, path: store.path }),
    git = store.git.bind(store);
  let injected = false;
  store.git = async (args, options) => {
    if (args[0] === 'push' && !injected) {
      injected = true;
      const r = await other.read();
      await other.write(data('other device'), r.sha);
    }
    return git(args, options);
  };
  await assert.rejects(
    () => store.write(data('my device'), original.sha),
    (e) => e.status === 409,
  );
  assert.equal((await other.read()).data.opportunities[0].notes, 'other device');
});
test('公开仓库、非法远端标识或路径在 Git 执行前被拒绝', async () => {
  const cfg = { owner: 'example', repo: 'repo', path: 'data.json' };
  assert.throws(() => createSshStore({ ...cfg, owner: '-upload-pack=bad' }, '/unused'));
  assert.throws(() => createSshStore({ ...cfg, path: '../data.json' }, '/unused'));
  const s = createSshStore(cfg, '/unused', async () => new Response('{}', { status: 200 }));
  await assert.rejects(
    () => s.checkPrivate(),
    (e) => e.status === 403,
  );
});

const secret = 'a'.repeat(64),
  baseHeaders = {
    host: '127.0.0.1:4317',
    origin: 'http://127.0.0.1:4317',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-job-tracker-session': secret,
  };
async function request({
  url = '/__local/git',
  method = 'PUT',
  headers = baseHeaders,
  body = { data: emptyData(), sha: null },
} = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { url, method, headers });
  let status,
    text,
    calls = 0;
  const res = { writeHead: (n) => (status = n), end: (s) => (text = s) };
  await handleLocalApi(req, res, {
    port: 4317,
    secret,
    target: { owner: 'example', repo: 'private', path: 'data.json' },
    bridge: {
      read: async () => {
        calls++;
        return { data: emptyData(), sha: null, missing: true };
      },
      write: async () => {
        calls++;
        return { sha: 'b'.repeat(40) };
      },
    },
  });
  return { status, body: JSON.parse(text), calls };
}
test('跨源、伪造Host、无会话或非ASCII会话均在访问Git前拒绝', async () => {
  for (const headers of [
    { ...baseHeaders, origin: 'https://evil.example' },
    { ...baseHeaders, host: 'evil.example:4317' },
    { ...baseHeaders, 'x-job-tracker-session': '' },
    { ...baseHeaders, 'x-job-tracker-session': 'é'.repeat(64) },
    { ...baseHeaders, 'sec-fetch-site': 'cross-site' },
  ]) {
    const r = await request({ headers });
    assert.equal(r.status, 403);
    assert.equal(r.calls, 0);
  }
});
test('本机会话可获取，但不允许跨源读取；PUT不接受自选路径或远端', async () => {
  assert.equal(
    (await request({ url: '/__local/session', method: 'GET', headers: { host: baseHeaders.host } }))
      .body.session,
    secret,
  );
  assert.equal(
    (
      await request({
        url: '/__local/session',
        method: 'GET',
        headers: { ...baseHeaders, origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  const bad = await request({ body: { data: emptyData(), sha: null, path: 'other.json' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.calls, 0);
  const ok = await request();
  assert.equal(ok.status, 200);
  assert.equal(ok.calls, 1);
});
