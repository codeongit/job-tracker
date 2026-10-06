import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBackup, initialWorkspace } from '../dist/workspace.js';
import { WorkspaceStore, workspaceDigest } from '../scripts/workspace-store.mjs';

const STAMP = '2026-10-06T00:00:00.000Z';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function replaceCatalog(f, change) {
  const catalog = await json(join(f.root, 'catalogs', f.head.catalog.file));
  change(catalog);
  const hash = workspaceDigest(catalog);
  const file = `catalog-${hash}.json`;
  await writeFile(join(f.root, 'catalogs', file), JSON.stringify(catalog), { mode: 0o600 });
  const head = { ...f.head, catalog: { file, hash } };
  await writeFile(join(f.root, 'HEAD.json'), JSON.stringify(head));
  return head;
}

function nextCommand(current, commandId = 'synthetic-third') {
  const workspace = structuredClone(current.workspace);
  workspace.generation++;
  workspace.data.opportunities[0].notes = 'Synthetic third notes';
  return {
    commandId,
    expectedRevision: current.revision,
    type: 'commit_workspace',
    payload: { workspace, reason: 'Synthetic third edit' },
  };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'job-tracker-workspace-catalog-'));
  const root = join(directory, 'workspace');
  const instances = [];
  const createStore = (settings = {}) => {
    const store = new WorkspaceStore(root, { now: () => STAMP, ...settings });
    instances.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of instances) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const store = createStore(options);
  await store.initialize();
  const workspace = initialWorkspace();
  workspace.data.opportunities.push({
    id: 'synthetic-job',
    company: 'Synthetic employer',
    role: 'Synthetic role',
    stage: '已触达',
  });
  const firstCommand = {
    commandId: 'synthetic-import',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: 'Synthetic import' },
  };
  const first = await store.execute(firstCommand, { result: { imported: 1 } });
  const next = structuredClone(first.workspace);
  next.generation++;
  next.data.opportunities[0].notes = 'Synthetic latest notes';
  const secondCommand = {
    commandId: 'synthetic-edit',
    expectedRevision: 1,
    type: 'commit_workspace',
    payload: { workspace: next, reason: 'Synthetic edit' },
  };
  const latest = await store.execute(secondCommand, { result: { edited: 1 } });
  const head = await json(join(root, 'HEAD.json'));
  const commit = await json(join(root, 'commits', head.file));
  return { root, store, createStore, firstCommand, secondCommand, first, latest, head, commit };
}

test('catalog startup reads the current workspace without opening unrelated older commits', async (t) => {
  const f = await fixture(t);
  const oldest = join(f.root, 'commits', f.commit.previous.file);
  await f.store.close();
  await writeFile(oldest, 'SYNTHETIC_UNREADABLE_HISTORY');
  const reopened = f.createStore();
  await reopened.initialize();
  assert.equal((await reopened.read()).revision, 2);
  assert.deepEqual((await reopened.read()).workspace, f.latest.workspace);
  await assert.rejects(reopened.execute(f.firstCommand), { code: 'WORKSPACE_CORRUPT' });
  await assert.rejects(reopened.execute({ ...f.secondCommand, commandId: 'after-corruption' }), {
    code: 'WORKSPACE_WRITER_CLOSED',
  });
  assert.deepEqual(await json(join(f.root, 'HEAD.json')), f.head);
  assert.equal((await readdir(join(f.root, 'commits'))).length, 2);
});

test('one HEAD binds a complete catalog to the exact current commit and private file modes', async (t) => {
  const f = await fixture(t);
  assert.equal(f.head.storageVersion, 2);
  const catalog = await json(join(f.root, 'catalogs', f.head.catalog.file));
  assert.equal(f.head.catalog.hash, workspaceDigest(catalog));
  assert.equal(f.head.catalog.file, `catalog-${f.head.catalog.hash}.json`);
  assert.deepEqual(catalog.head, { revision: 2, file: f.head.file, hash: f.head.hash });
  assert.equal(catalog.workspaceId, f.latest.workspaceId);
  assert.deepEqual(
    catalog.entries.map((entry) => ({ commandId: entry.commandId, revision: entry.revision })),
    [
      { commandId: 'synthetic-import', revision: 1 },
      { commandId: 'synthetic-edit', revision: 2 },
    ],
  );
  assert.equal(catalog.entries[0].file, f.commit.previous.file);
  assert.equal(catalog.entries[0].hash, f.commit.previous.hash);
  assert.equal(f.commit.storageVersion, 1);
  assert.equal((await json(join(f.root, 'identity.json'))).storageVersion, 1);
  for (const directory of [f.root, join(f.root, 'commits'), join(f.root, 'catalogs')])
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  for (const path of [
    join(f.root, 'HEAD.json'),
    join(f.root, 'commits', f.head.file),
    join(f.root, 'catalogs', f.head.catalog.file),
  ])
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await f.store.auditHistory(), { revision: 2, commits: 2, commands: 2 });
});

for (const [name, change] of [
  ['unknown fields', (catalog) => (catalog.futureField = 'Synthetic')],
  ['unknown entry fields', (catalog) => (catalog.entries[0].futureField = 'Synthetic')],
  ['future catalog versions', (catalog) => (catalog.catalogVersion = 2)],
  ['a missing history entry', (catalog) => catalog.entries.shift()],
  [
    'a repeated command ID',
    (catalog) => (catalog.entries[1].commandId = catalog.entries[0].commandId),
  ],
  ['a numeric command ID', (catalog) => (catalog.entries[0].commandId = 1)],
  ['an array command ID', (catalog) => (catalog.entries[0].commandId = ['synthetic-import'])],
  [
    'an array command digest',
    (catalog) => (catalog.entries[0].digest = [catalog.entries[0].digest]),
  ],
  ['a revision gap', (catalog) => (catalog.entries[0].revision = 0)],
  ['a mismatched catalog head', (catalog) => (catalog.head.hash = '0'.repeat(64))],
  [
    'a foreign workspace',
    (catalog) => (catalog.workspaceId = '00000000-0000-4000-8000-000000000001'),
  ],
  ['an invalid commit path', (catalog) => (catalog.entries[0].file = '../HEAD.json')],
  ['an altered latest command digest', (catalog) => (catalog.entries[1].digest = '0'.repeat(64))],
  [
    'a historical pointer that differs from the current commit predecessor',
    (catalog) => {
      catalog.entries[0].hash = '0'.repeat(64);
      catalog.entries[0].file = `000000000001-${'0'.repeat(64)}.json`;
    },
  ],
]) {
  test(`a digest-valid catalog with ${name} stops startup without replacing the root`, async (t) => {
    const f = await fixture(t);
    await f.store.close();
    const head = await replaceCatalog(f, change);
    const reopened = f.createStore();
    await assert.rejects(reopened.initialize());
    assert.deepEqual(await json(join(f.root, 'HEAD.json')), head);
    assert.equal(reopened.owned, false);
    assert.equal((await readdir(join(f.root, 'commits'))).length, 2);
  });
}

test('a changed catalog digest and a missing catalog both fail rather than rebuilding an empty index', async (t) => {
  const f = await fixture(t);
  await f.store.close();
  const path = join(f.root, 'catalogs', f.head.catalog.file);
  const original = await readFile(path);
  await writeFile(path, JSON.stringify({ catalogVersion: 1 }));
  await assert.rejects(f.createStore().initialize());
  await writeFile(path, original);
  await unlink(path);
  await assert.rejects(f.createStore().initialize());
  assert.deepEqual(await json(join(f.root, 'HEAD.json')), f.head);
  assert.equal((await readdir(join(f.root, 'commits'))).length, 2);
});

test('a historical catalog entry is compared with its full commit before returning a command result', async (t) => {
  const f = await fixture(t);
  await f.store.close();
  const head = await replaceCatalog(f, (catalog) => {
    catalog.entries[0].digest = '0'.repeat(64);
  });
  const reopened = f.createStore();
  await reopened.initialize();
  assert.equal((await reopened.read()).revision, 2);
  await assert.rejects(reopened.commandResult(f.firstCommand.commandId), {
    code: 'WORKSPACE_CORRUPT',
  });
  await assert.rejects(reopened.execute(nextCommand(f.latest)), {
    code: 'WORKSPACE_WRITER_CLOSED',
  });
  assert.deepEqual(await json(join(f.root, 'HEAD.json')), head);
});

test('explicit history audit compares historical command identities with catalog entries', async (t) => {
  const f = await fixture(t);
  await f.store.close();
  const head = await replaceCatalog(f, (catalog) => {
    catalog.entries[0].commandId = 'synthetic-unrelated-command';
  });
  const reopened = f.createStore();
  await reopened.initialize();
  await assert.rejects(reopened.auditHistory(), { code: 'WORKSPACE_CORRUPT' });
  await assert.rejects(reopened.execute(nextCommand(f.latest)), {
    code: 'WORKSPACE_WRITER_CLOSED',
  });
  assert.deepEqual(await json(join(f.root, 'HEAD.json')), head);
});

test('an external catalog root replacement is rejected even when the commit pointer is unchanged', async (t) => {
  const f = await fixture(t);
  const head = await replaceCatalog(f, (catalog) => {
    catalog.entries[0].digest = '0'.repeat(64);
  });
  assert.equal(head.hash, f.head.hash);
  assert.equal(head.file, f.head.file);
  await assert.rejects(f.store.execute(nextCommand(f.latest)), {
    code: 'WORKSPACE_HEAD_CHANGED',
  });
  assert.deepEqual(await json(join(f.root, 'HEAD.json')), head);
  assert.equal((await readdir(join(f.root, 'commits'))).length, 2);
});

for (const [kind, change, error] of [
  [
    'unknown current fields',
    (workspace) => (workspace.data.opportunities[0].futureField = 'Synthetic'),
    /未知字段/,
  ],
  ['a future current schema', (workspace) => workspace.data.schemaVersion++, /不支持的版本/],
]) {
  test(`a matching catalog and digest cannot allow ${kind} into the current workspace`, async (t) => {
    const f = await fixture(t);
    await f.store.close();
    const body = { ...f.commit };
    delete body.hash;
    change(body.workspace);
    const hash = workspaceDigest(body);
    const file = `${String(body.revision).padStart(12, '0')}-${hash}.json`;
    await writeFile(join(f.root, 'commits', file), JSON.stringify({ ...body, hash }), {
      mode: 0o600,
    });
    const head = await replaceCatalog({ ...f, head: { ...f.head, file, hash } }, (catalog) => {
      catalog.head = { revision: body.revision, file, hash };
      Object.assign(catalog.entries.at(-1), { file, hash });
    });
    const reopened = f.createStore();
    await assert.rejects(reopened.initialize(), error);
    assert.deepEqual(await json(join(f.root, 'HEAD.json')), head);
    assert.equal(reopened.owned, false);
  });
}

test('a missing older commit is deferred at startup but explicit audit isolates further writes', async (t) => {
  const f = await fixture(t);
  await f.store.close();
  await unlink(join(f.root, 'commits', f.commit.previous.file));
  const reopened = f.createStore();
  await reopened.initialize();
  await assert.rejects(reopened.auditHistory());
  await assert.rejects(reopened.execute(nextCommand(f.latest)), {
    code: 'WORKSPACE_WRITER_CLOSED',
  });
  assert.deepEqual(await json(join(f.root, 'HEAD.json')), f.head);
});

test('a missing HEAD with existing commits is not an empty workspace', async (t) => {
  const f = await fixture(t);
  await f.store.close();
  await unlink(join(f.root, 'HEAD.json'));
  const reopened = f.createStore();
  await assert.rejects(reopened.initialize());
  assert.equal(reopened.owned, false);
  assert.equal((await readdir(join(f.root, 'commits'))).length, 2);
  await assert.rejects(readFile(join(f.root, 'HEAD.json')), { code: 'ENOENT' });
});

test('legacy HEAD migrates only after full audit and preserves its original pointer and commit bytes', async (t) => {
  const f = await fixture(t);
  await f.store.close();
  const { catalog: _catalog, ...legacyHead } = { ...f.head, storageVersion: 1 };
  await writeFile(join(f.root, 'HEAD.json'), JSON.stringify(legacyHead));
  const commitPath = join(f.root, 'commits', f.head.file);
  const originalCommit = await readFile(commitPath);
  const reopened = f.createStore();
  await reopened.initialize();
  assert.equal((await json(join(f.root, 'HEAD.json'))).storageVersion, 2);
  const migrationPath = join(f.root, `migration-head-${workspaceDigest(legacyHead)}.json`);
  assert.deepEqual(await json(migrationPath), legacyHead);
  assert.deepEqual(await readFile(commitPath), originalCommit);
  assert.equal((await reopened.read()).revision, 2);
  assert.deepEqual(await reopened.commandResult(f.firstCommand.commandId), {
    revision: 1,
    hash: f.first.hash,
    result: { imported: 1 },
  });
});

for (const stage of ['before_catalog_file', 'before_head']) {
  test(`a crash at ${stage} leaves the old root and exact retry publishes one commit`, async (t) => {
    let failed = false;
    const f = await fixture(t, {
      beforeCommit: async (currentStage, commit) => {
        if (currentStage === stage && commit.revision === 3 && !failed) {
          failed = true;
          throw new Error('Synthetic catalog interruption');
        }
      },
    });
    const command = nextCommand(f.latest);
    await assert.rejects(f.store.execute(command, { result: { saved: 1 } }), /Synthetic/);
    assert.deepEqual(await json(join(f.root, 'HEAD.json')), f.head);
    assert.equal((await f.store.read()).revision, 2);
    const saved = await f.store.execute(command, { result: { saved: 1 } });
    assert.equal(saved.revision, 3);
    assert.equal((await readdir(join(f.root, 'commits'))).length, 3);
    await f.store.close();
    const reopened = f.createStore();
    await reopened.initialize();
    const replay = await reopened.execute(command);
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, 3);
    assert.deepEqual(replay.commandResult, { saved: 1 });
    assert.equal((await readdir(join(f.root, 'commits'))).length, 3);
  });
}

test('a lost response after publishing HEAD replays the same catalog-bound result after restart', async (t) => {
  let failed = false;
  const f = await fixture(t, {
    beforeCommit: async (stage, commit) => {
      if (stage === 'after_head' && commit.revision === 3 && !failed) {
        failed = true;
        throw new Error('Synthetic lost response');
      }
    },
  });
  const command = nextCommand(f.latest);
  await assert.rejects(f.store.execute(command, { result: { saved: 1 } }), /lost response/);
  await f.store.close();
  const reopened = f.createStore();
  const replay = await reopened.execute(command);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 3);
  assert.deepEqual(replay.commandResult, { saved: 1 });
  assert.deepEqual(await reopened.auditHistory(), { revision: 3, commits: 3, commands: 3 });
});

test('a temporary root fsync failure reconciles the paired commit and catalog before confirming success', async (t) => {
  let syncCalls = 0;
  const f = await fixture(t, {
    syncHeadDirectory: async () => {
      if (++syncCalls === 3) throw new Error('Synthetic temporary root fsync failure');
    },
  });
  const command = nextCommand(f.latest);
  const saved = await f.store.execute(command, { result: { saved: 1 } });
  assert.equal(saved.revision, 3);
  assert.equal(syncCalls, 4);
  await f.store.close();
  const reopened = f.createStore();
  assert.equal((await reopened.execute(command)).replayed, true);
  assert.deepEqual(await reopened.auditHistory(), { revision: 3, commits: 3, commands: 3 });
});

test('a persistent root fsync failure isolates writes and restart resolves the visible paired root', async (t) => {
  let syncCalls = 0;
  const f = await fixture(t, {
    syncHeadDirectory: async () => {
      if (++syncCalls >= 3) throw new Error('Synthetic persistent root fsync failure');
    },
  });
  const command = nextCommand(f.latest);
  await assert.rejects(f.store.execute(command, { result: { saved: 1 } }), {
    code: 'WORKSPACE_DURABILITY_UNCERTAIN',
  });
  await assert.rejects(f.store.execute(command), { code: 'WORKSPACE_WRITER_CLOSED' });
  assert.equal((await f.store.read()).revision, 2);
  await f.store.close();
  const reopened = f.createStore();
  const replay = await reopened.execute(command);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 3);
  assert.deepEqual(replay.commandResult, { saved: 1 });
  assert.deepEqual(await reopened.auditHistory(), { revision: 3, commits: 3, commands: 3 });
});

test('command-result lookup waits for a concurrent root publication and returns the original durable result', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let syncCalls = 0;
  const f = await fixture(t, {
    syncHeadDirectory: async () => {
      if (++syncCalls === 3) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const saving = f.store.execute(nextCommand(f.latest), { result: { saved: 1 } });
  await entered.promise;
  const lookup = f.store.commandResult(f.firstCommand.commandId);
  const outcome = await Promise.race([
    lookup.then(
      () => 'returned',
      () => 'failed',
    ),
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 50)),
  ]);
  release.resolve();
  const [saved, original] = await Promise.all([saving, lookup]);
  assert.equal(outcome, 'waiting');
  assert.equal(saved.revision, 3);
  assert.deepEqual(original, { revision: 1, hash: f.first.hash, result: { imported: 1 } });
  assert.equal(f.store.closed, false);
  assert.deepEqual(await f.store.auditHistory(), { revision: 3, commits: 3, commands: 3 });
});

test('catalog cleanup failure keeps the committed success and exact replay while preserving all commit files', async (t) => {
  const f = await fixture(t);
  const originalCommits = await readdir(join(f.root, 'commits'));
  const unsafeCatalog = join(f.root, 'catalogs', `catalog-${'0'.repeat(64)}.json`);
  await symlink(join(f.root, 'HEAD.json'), unsafeCatalog);
  const command = nextCommand(f.latest);
  const saved = await f.store.execute(command, { result: { saved: 1 } });
  assert.equal(saved.revision, 3);
  assert.deepEqual(saved.commandResult, { saved: 1 });
  assert.equal(f.store.catalogCleanupFailed, true);
  assert.equal(f.store.closed, false);
  for (const file of originalCommits) await readFile(join(f.root, 'commits', file));
  assert.equal((await readdir(join(f.root, 'commits'))).length, 3);
  assert.equal((await lstat(unsafeCatalog)).isSymbolicLink(), true);
  await f.store.close();
  const reopened = f.createStore();
  const replay = await reopened.execute(command);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, 3);
  assert.deepEqual(replay.commandResult, { saved: 1 });
  assert.deepEqual(await reopened.auditHistory(), { revision: 3, commits: 3, commands: 3 });
});

test('restore creates a new catalog entry while preserving current sync baseline and omission tombstones', async (t) => {
  const f = await fixture(t);
  const workspace = structuredClone(f.latest.workspace);
  workspace.generation++;
  workspace.data.opportunities.push({
    id: 'synthetic-later-job',
    company: 'Synthetic later employer',
    role: 'Synthetic later role',
    stage: '已触达',
  });
  const current = await f.store.execute({
    commandId: 'synthetic-before-restore',
    expectedRevision: 2,
    type: 'commit_workspace',
    payload: { workspace, reason: 'Synthetic later job' },
  });
  const restored = await f.store.execute({
    commandId: 'synthetic-restore',
    expectedRevision: current.revision,
    type: 'restore_workspace',
    payload: { backup: createBackup(f.first.workspace), mode: 'snapshot' },
  });
  assert.equal(restored.revision, 4);
  assert.deepEqual(restored.workspace.base, current.workspace.base);
  assert.ok(
    restored.workspace.data.opportunities.find((row) => row.id === 'synthetic-later-job').deletedAt,
  );
  await f.store.close();
  const reopened = f.createStore();
  await reopened.initialize();
  assert.deepEqual((await reopened.read()).workspace, restored.workspace);
  assert.deepEqual(await reopened.auditHistory(), { revision: 4, commits: 4, commands: 4 });
});
