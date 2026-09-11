import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { DiskBackups } from '../scripts/disk-backups.mjs';
import { handleLocalApi } from '../scripts/local-api.mjs';
import { createBackup, initialWorkspace, parseBackup } from '../dist/workspace.js';
import { clone } from '../dist/model.js';

const SOURCE_A = '11111111-1111-4111-8111-111111111111';
const SOURCE_B = '22222222-2222-4222-8222-222222222222';
const SOURCE_C = '33333333-3333-4333-8333-333333333333';
const SECRET = 'a'.repeat(64);
const HEADERS = {
  host: '127.0.0.1:4317',
  origin: 'http://127.0.0.1:4317',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
  'x-job-tracker-session': SECRET,
};

function workspace(notes = '第一份中文记录 🚀') {
  const value = initialWorkspace();
  value.data.opportunities.push({
    id: 'job-a',
    company: '合成公司',
    role: '合成岗位',
    stage: '已触达',
    notes,
  });
  return value;
}

function editorDraft(job) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    revision: '55555555-5555-4555-8555-555555555555',
    kind: 'editor',
    opportunityId: job.id,
    values: { company: job.company, notes: '尚未提交的中文草稿 📝' },
    original: clone(job),
    updatedAt: '2026-09-11T04:00:00.000Z',
  };
}

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'job-tracker-disk-backups-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, '.local', 'backups');
  let now = new Date(2026, 8, 11, 12),
    failure = false;
  const store = new DiskBackups(root, {
    now: () => now,
    beforeCommit: async () => {
      if (failure) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
    },
  });
  return {
    temp,
    root,
    store,
    day: (year, month, date) => {
      now = new Date(year, month - 1, date, 12);
    },
    fail: (enabled) => {
      failure = enabled;
    },
  };
}

async function api(
  backups,
  {
    url = '/__local/backups',
    method = 'PUT',
    headers = HEADERS,
    body = { sourceId: SOURCE_A, backup: createBackup(workspace()) },
    chunks,
  } = {},
) {
  const req = Readable.from(chunks ?? [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { url, method, headers });
  let status, response;
  const res = {
    writeHead: (value) => {
      status = value;
    },
    end: (value) => {
      response = value;
    },
  };
  const handled = await handleLocalApi(req, res, {
    port: 4317,
    secret: SECRET,
    bridge: null,
    target: undefined,
    backups,
  });
  return { handled, status, body: response === undefined ? undefined : JSON.parse(response) };
}

test('每日首份不变，latest 跟随更新；无变化去重，隔日仍生成首份', async (t) => {
  const { root, store, day } = await fixture(t);
  const first = createBackup(workspace('当天首份'));
  await store.save(SOURCE_A, first);
  const daily = join(root, SOURCE_A, '2026-09-11.json');
  const originalBytes = await readFile(daily);
  const updated = createBackup(workspace('当天下午的新记录'));
  await store.save(SOURCE_A, updated);
  assert.deepEqual(await readFile(daily), originalBytes);
  assert.deepEqual((await store.read(SOURCE_A, 'latest.json')).workspace, updated.workspace);
  const latestBytes = await readFile(join(root, SOURCE_A, 'latest.json'));
  const duplicate = await store.save(SOURCE_A, { ...updated, exportedAt: '2099-01-01T00:00:00Z' });
  assert.equal(duplicate.unchanged, true);
  assert.deepEqual(await readFile(join(root, SOURCE_A, 'latest.json')), latestBytes);
  day(2026, 9, 12);
  await store.save(SOURCE_A, updated);
  assert.deepEqual((await store.read(SOURCE_A, '2026-09-12.json')).workspace, updated.workspace);
  assert.deepEqual(await readFile(daily), originalBytes);
});

test('只保留最近30个有备份日期及latest，不删除其他文件或其他来源', async (t) => {
  const { root, store, day } = await fixture(t);
  await store.save(SOURCE_B, createBackup(workspace('其他来源')));
  const otherBytes = await readFile(join(root, SOURCE_B, 'latest.json'));
  for (let index = 0; index < 32; index++) {
    day(2026, 1, 1 + index * 2);
    await store.save(SOURCE_A, createBackup(workspace(`合成日期 ${index}`)));
    if (index === 0) await writeFile(join(root, SOURCE_A, 'keep-notes.txt'), 'keep me');
  }
  const names = await readdir(join(root, SOURCE_A));
  const dates = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  assert.equal(dates.length, 30);
  assert.equal(dates[0], '2026-01-05.json');
  assert.equal(dates.at(-1), '2026-03-04.json');
  assert.equal(
    (await store.read(SOURCE_A, 'latest.json')).workspace.data.opportunities[0].notes,
    '合成日期 31',
  );
  assert.equal(await readFile(join(root, SOURCE_A, 'keep-notes.txt'), 'utf8'), 'keep me');
  assert.deepEqual(await readFile(join(root, SOURCE_B, 'latest.json')), otherBytes);
  assert.ok((await store.list()).every((row) => row.file !== 'keep-notes.txt'));
});

test('来源相互隔离；初始空状态不覆盖旧备份，删除标记仍会备份', async (t) => {
  const { root, store } = await fixture(t);
  await store.save(SOURCE_A, createBackup(workspace('浏览器 A')));
  await store.save(SOURCE_B, createBackup(workspace('浏览器 B')));
  const before = await readFile(join(root, SOURCE_A, 'latest.json'));
  assert.equal((await store.save(SOURCE_A, createBackup(initialWorkspace()))).skipped, true);
  assert.equal((await store.save(SOURCE_C, createBackup(initialWorkspace()))).skipped, true);
  assert.deepEqual(await readFile(join(root, SOURCE_A, 'latest.json')), before);
  assert.equal(
    (await store.read(SOURCE_B, 'latest.json')).workspace.data.opportunities[0].notes,
    '浏览器 B',
  );
  assert.ok(!(await readdir(root)).includes(SOURCE_C));
  const deleted = workspace('用户删除的记录');
  deleted.data.opportunities[0].deletedAt = '2026-09-11T08:00:00.000Z';
  await store.save(SOURCE_A, createBackup(deleted));
  assert.deepEqual((await store.read(SOURCE_A, 'latest.json')).workspace, deleted);
});

test('提交前磁盘故障保留旧文件并清除临时文件，恢复后可继续备份', async (t) => {
  const { root, store, day, fail } = await fixture(t);
  await store.save(SOURCE_A, createBackup(workspace('可靠的旧备份')));
  const dir = join(root, SOURCE_A);
  const first = await readFile(join(dir, '2026-09-11.json'));
  const latest = await readFile(join(dir, 'latest.json'));
  day(2026, 9, 12);
  fail(true);
  await assert.rejects(() => store.save(SOURCE_A, createBackup(workspace('失败的备份'))), {
    code: 'ENOSPC',
  });
  assert.deepEqual(await readFile(join(dir, 'latest.json')), latest);
  assert.deepEqual(await readFile(join(dir, '2026-09-11.json')), first);
  assert.deepEqual((await readdir(dir)).sort(), ['2026-09-11.json', 'latest.json']);
  fail(false);
  await store.save(SOURCE_A, createBackup(workspace('恢复后的备份')));
  assert.equal(
    (await store.read(SOURCE_A, 'latest.json')).workspace.data.opportunities[0].notes,
    '恢复后的备份',
  );
  assert.deepEqual(await readFile(join(dir, '2026-09-11.json')), first);
});

test('私有目录权限0700，完整备份权限0600', { skip: process.platform === 'win32' }, async (t) => {
  const { root, store } = await fixture(t);
  await store.save(SOURCE_A, createBackup(workspace()));
  for (const dir of [join(root, '..'), root, join(root, SOURCE_A)]) {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
  for (const file of ['latest.json', '2026-09-11.json']) {
    assert.equal((await stat(join(root, SOURCE_A, file))).mode & 0o777, 0o600);
  }
});

test('来源和文件名不能逃出固定备份目录', async (t) => {
  const { temp, root, store } = await fixture(t);
  const outside = join(temp, 'outside.json');
  await writeFile(outside, 'outside sentinel');
  for (const id of ['../outside', SOURCE_A + '/..', '/tmp/outside', 'not-a-uuid']) {
    await assert.rejects(() => store.save(id, createBackup(workspace())));
    await assert.rejects(() => store.read(id, 'latest.json'));
  }
  await store.save(SOURCE_A, createBackup(workspace()));
  for (const file of [
    '../outside.json',
    '../../outside.json',
    '/tmp/outside.json',
    '%2e%2e%2foutside.json',
    'latest.json/..',
  ]) {
    await assert.rejects(() => store.read(SOURCE_A, file));
  }
  assert.equal(await readFile(outside, 'utf8'), 'outside sentinel');
  assert.deepEqual(await readdir(root), [SOURCE_A]);
});

test(
  '目录或备份文件符号链接被拒绝，不修改链接目标',
  { skip: process.platform === 'win32' },
  async (t) => {
    for (const target of ['root', 'source', 'latest', 'daily']) {
      await t.test(target, async (t) => {
        const { temp, root, store, day } = await fixture(t);
        const outsideDir = join(temp, 'outside');
        const outside = join(outsideDir, 'private.json');
        await mkdir(outsideDir);
        await writeFile(outside, 'outside sentinel');
        if (target === 'root') {
          await mkdir(join(temp, '.local'));
          await symlink(outsideDir, root, 'dir');
        } else if (target === 'source') {
          await store.initialize();
          await symlink(outsideDir, join(root, SOURCE_A), 'dir');
        } else {
          await store.save(SOURCE_A, createBackup(workspace('旧备份')));
          if (target === 'latest') {
            await unlink(join(root, SOURCE_A, 'latest.json'));
            await symlink(outside, join(root, SOURCE_A, 'latest.json'));
          } else {
            day(2026, 9, 12);
            await symlink(outside, join(root, SOURCE_A, '2026-09-12.json'));
          }
        }
        await assert.rejects(() => store.save(SOURCE_A, createBackup(workspace('不得写入'))));
        await assert.rejects(() =>
          store.read(SOURCE_A, target === 'daily' ? '2026-09-12.json' : 'latest.json'),
        );
        assert.equal(await readFile(outside, 'utf8'), 'outside sentinel');
        assert.deepEqual(await readdir(outsideDir), ['private.json']);
      });
    }
  },
);

test('v2完整备份保留草稿、基线和关联冲突双方；v1仍可读取并升级保存', async (t) => {
  const { store } = await fixture(t);
  const state = workspace('冲突前记录');
  const original = clone(state.data.opportunities[0]);
  state.data.opportunities[0].deletedAt = '2026-09-11T04:00:00Z';
  state.base = clone(state.data);
  state.data.tasks.push({
    id: 'task-a',
    opportunityId: original.id,
    text: '上传时新增的任务',
    status: '待办',
  });
  state.pending = {
    generation: state.generation,
    data: clone(state.data),
    conflicts: [
      {
        key: `opportunities:${original.id}`,
        group: 'opportunities',
        id: original.id,
        base: original,
        local: original,
        remote: clone(state.data.opportunities[0]),
        relational: true,
      },
    ],
  };
  const drafts = [editorDraft(original)];
  await store.save(SOURCE_A, createBackup(state, drafts));
  const saved = await store.read(SOURCE_A, 'latest.json');
  assert.equal(saved.backupVersion, 2);
  assert.deepEqual(saved.workspace, state);
  assert.deepEqual(saved.drafts, drafts);
  assert.deepEqual(parseBackup(saved).workspace.pending.conflicts, state.pending.conflicts);
  const oldWorkspace = workspace('旧版工作区');
  delete oldWorkspace.workspaceVersion;
  const legacy = { backupVersion: 1, appVersion: '0.2.0', workspace: oldWorkspace };
  assert.deepEqual(parseBackup(legacy).drafts, []);
  await store.save(SOURCE_B, legacy);
  const upgraded = await store.read(SOURCE_B, 'latest.json');
  assert.equal(upgraded.backupVersion, 2);
  assert.equal(upgraded.workspace.workspaceVersion, 2);
  assert.deepEqual(upgraded.workspace.data, oldWorkspace.data);
  assert.deepEqual(upgraded.drafts, []);
});

test('只有未提交草稿也会备份；令牌及未知草稿字段不能进入备份', async (t) => {
  const { root, store } = await fixture(t);
  const draft = { ...editorDraft(workspace().data.opportunities[0]), opportunityId: '' };
  delete draft.original;
  await store.save(SOURCE_A, createBackup(initialWorkspace(), [draft]));
  const before = await readFile(join(root, SOURCE_A, 'latest.json'));
  assert.deepEqual((await store.read(SOURCE_A, 'latest.json')).drafts, [draft]);
  const valid = createBackup(workspace());
  const invalid = [
    { ...valid, token: 'synthetic-token-must-not-persist' },
    { ...valid, workspace: { ...valid.workspace, session: SECRET } },
    { ...valid, drafts: [{ ...draft, values: { token: 'synthetic-token-must-not-persist' } }] },
    { ...valid, backupVersion: 1, drafts: [] },
    { backupVersion: 2, drafts: [] },
    { ...valid, backupVersion: 999 },
  ];
  for (const backup of invalid) await assert.rejects(() => store.save(SOURCE_A, backup));
  assert.deepEqual(await readFile(join(root, SOURCE_A, 'latest.json')), before);
});

test('未配置SSH仍可取得备份会话并保存、列出、读取磁盘备份', async (t) => {
  const { root, store } = await fixture(t);
  const session = await api(store, {
    url: '/__local/session',
    method: 'GET',
    headers: { host: HEADERS.host },
  });
  assert.equal(session.status, 200);
  assert.equal(session.body.enabled, false);
  assert.equal(session.body.backupEnabled, true);
  assert.equal(session.body.session, SECRET);
  assert.equal(session.body.target, undefined);
  const input = createBackup(workspace('无SSH备份成功'));
  const saved = await api(store, { body: { sourceId: SOURCE_A, backup: input } });
  assert.equal(saved.status, 200);
  const listed = await api(store, { method: 'GET' });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.files.map((row) => row.file).sort(), [
    '2026-09-11.json',
    'latest.json',
  ]);
  const downloaded = await api(store, {
    url: `/__local/backups/${SOURCE_A}/latest.json`,
    method: 'GET',
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.body.workspace, input.workspace);
  assert.equal((await api(store, { url: '/__local/git', method: 'GET' })).status, 404);
  assert.ok(!(await readFile(join(root, SOURCE_A, 'latest.json'), 'utf8')).includes(SECRET));
});

test('Origin、Host和会话防护在任何磁盘访问之前执行', async () => {
  let calls = 0;
  const backups = {
    save: async () => {
      calls++;
      return {};
    },
    list: async () => {
      calls++;
      return [];
    },
    read: async () => {
      calls++;
      return {};
    },
  };
  for (const headers of [
    { ...HEADERS, origin: 'https://evil.example' },
    { ...HEADERS, origin: undefined },
    { ...HEADERS, host: 'evil.example:4317' },
    { ...HEADERS, 'sec-fetch-site': 'cross-site' },
    { ...HEADERS, 'x-job-tracker-session': undefined },
    { ...HEADERS, 'x-job-tracker-session': 'b'.repeat(64) },
    { ...HEADERS, 'x-job-tracker-session': 'é'.repeat(64) },
    { ...HEADERS, 'content-type': 'text/plain' },
  ]) {
    assert.equal((await api(backups, { headers })).status, 403);
  }
  assert.equal(
    (await api(backups, { method: 'GET', headers: { ...HEADERS, 'x-job-tracker-session': '' } }))
      .status,
    403,
  );
  assert.equal(
    (
      await api(backups, {
        url: '/__local/session',
        method: 'GET',
        headers: { ...HEADERS, origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal((await api(backups, { method: 'DELETE' })).status, 405);
  assert.equal(calls, 0);
});

test('备份API拒绝自选文件路径、额外凭证及非法UTF-8，分块中文请求可正常往返', async (t) => {
  const { root, store } = await fixture(t);
  const backup = createBackup(workspace('分块的中文原文 🚀'));
  for (const body of [
    { sourceId: SOURCE_A, backup, filename: '../outside.json' },
    { sourceId: SOURCE_A, backup, token: 'synthetic-token' },
    { sourceId: '../outside', backup },
    { sourceId: SOURCE_A, backup: { ...backup, token: 'synthetic-token' } },
  ])
    assert.equal((await api(store, { body })).status, 400);
  assert.equal((await api(store, { url: `/__local/backups/${SOURCE_A}/latest.json` })).status, 400);
  assert.equal(
    (
      await api(store, {
        chunks: [Buffer.from('{"invalid":"'), Buffer.from([0xff]), Buffer.from('"}')],
      })
    ).status,
    400,
  );
  const payload = Buffer.from(JSON.stringify({ sourceId: SOURCE_A, backup }));
  const boundary = payload.indexOf(Buffer.from('分')) + 1;
  const response = await api(store, {
    chunks: [payload.subarray(0, boundary), payload.subarray(boundary)],
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await store.read(SOURCE_A, 'latest.json')).workspace, backup.workspace);
  assert.deepEqual(await readdir(root), [SOURCE_A]);
});
