import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initialWorkspace, migrateWorkspace } from '../dist/workspace.js';
import { WorkspaceStore, workspaceDigest } from '../scripts/workspace-store.mjs';

const STAMP = '2026-10-06T00:00:00.000Z';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const filename = (commit) => `${String(commit.revision).padStart(12, '0')}-${commit.hash}.json`;

function rehash(commit) {
  const { hash: _oldHash, ...body } = commit;
  return { ...body, hash: workspaceDigest(body) };
}

async function historyFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'job-tracker-history-validation-'));
  const root = join(directory, 'workspace');
  const store = new WorkspaceStore(root, { now: () => STAMP });
  const reopened = new WorkspaceStore(root, { now: () => STAMP });
  t.after(async () => {
    await store.close();
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.initialize();
  const workspace = initialWorkspace();
  workspace.data.opportunities.push({
    id: 'synthetic-job',
    company: 'Synthetic employer',
    role: 'Synthetic role',
    stage: '已触达',
  });
  const first = await store.execute({
    commandId: 'synthetic-import',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: 'Synthetic import' },
  });
  const firstCommand = {
    commandId: 'synthetic-import',
    expectedRevision: 0,
    type: 'import_workspace',
    payload: { workspace, reason: 'Synthetic import' },
  };
  const next = structuredClone(first.workspace);
  next.generation++;
  next.data.opportunities[0].notes = 'Synthetic latest notes';
  await store.execute({
    commandId: 'synthetic-edit',
    expectedRevision: first.revision,
    type: 'commit_workspace',
    payload: { workspace: next, reason: 'Synthetic edit' },
  });
  const head = await json(join(root, 'HEAD.json'));
  const latest = await json(join(root, 'commits', head.file));
  const oldest = await json(join(root, 'commits', latest.previous.file));
  await store.close();
  return { root, head, latest, oldest, reopened, firstCommand };
}

async function replaceConsistentHistory({ root, head, latest }, modifiedOldest) {
  const oldest = rehash(modifiedOldest);
  const child = rehash({
    ...latest,
    previous: { file: filename(oldest), hash: oldest.hash },
  });
  const catalog = {
    catalogVersion: 1,
    workspaceId: head.workspaceId,
    head: { revision: child.revision, file: filename(child), hash: child.hash },
    entries: [oldest, child].map((commit) => ({
      commandId: commit.command.commandId,
      digest: commit.command.digest,
      revision: commit.revision,
      file: filename(commit),
      hash: commit.hash,
    })),
  };
  const catalogHash = workspaceDigest(catalog);
  const catalogFile = `catalog-${catalogHash}.json`;
  const nextHead = {
    ...head,
    storageVersion: 2,
    file: filename(child),
    hash: child.hash,
    catalog: { file: catalogFile, hash: catalogHash },
  };
  await writeFile(join(root, 'commits', filename(oldest)), JSON.stringify(oldest), { mode: 0o600 });
  await writeFile(join(root, 'commits', filename(child)), JSON.stringify(child), { mode: 0o600 });
  await writeFile(join(root, 'catalogs', catalogFile), JSON.stringify(catalog), { mode: 0o600 });
  await writeFile(join(root, 'HEAD.json'), JSON.stringify(nextHead));
  assert.equal(child.previous.file, filename(oldest));
  assert.equal(child.previous.hash, oldest.hash);
  assert.equal(nextHead.revision, child.revision);
  assert.equal(child.revision, oldest.revision + 1);
  assert.deepEqual(migrateWorkspace(child.workspace), latest.workspace);
  return { oldest, child, nextHead };
}

test('catalog startup defers unknown older fields until command-result lookup and then isolates writes', async (t) => {
  const fixture = await historyFixture(t);
  const modified = structuredClone(fixture.oldest);
  modified.workspace.data.schemaVersion = 3;
  modified.workspace.data.opportunities[0].futureField = 'Synthetic unknown value';
  const { oldest, nextHead } = await replaceConsistentHistory(fixture, modified);
  await fixture.reopened.initialize();
  assert.equal((await fixture.reopened.read()).revision, 2);
  await assert.rejects(fixture.reopened.commandResult('synthetic-import'), /未知字段/);
  await assert.rejects(fixture.reopened.execute(fixture.firstCommand), {
    code: 'WORKSPACE_WRITER_CLOSED',
  });
  assert.deepEqual(await json(join(fixture.root, 'HEAD.json')), nextHead);
  assert.deepEqual(await json(join(fixture.root, 'commits', filename(oldest))), oldest);
  assert.equal(fixture.reopened.closed, true);
});

test('catalog startup defers a future older schema until exact retry and then isolates writes', async (t) => {
  const fixture = await historyFixture(t);
  const modified = structuredClone(fixture.oldest);
  modified.workspace.data.schemaVersion++;
  const { oldest, nextHead } = await replaceConsistentHistory(fixture, modified);
  await fixture.reopened.initialize();
  await assert.rejects(fixture.reopened.execute(fixture.firstCommand), /不支持的版本/);
  await assert.rejects(fixture.reopened.execute(fixture.firstCommand), {
    code: 'WORKSPACE_WRITER_CLOSED',
  });
  assert.deepEqual(await json(join(fixture.root, 'HEAD.json')), nextHead);
  assert.deepEqual(await json(join(fixture.root, 'commits', filename(oldest))), oldest);
  assert.equal(fixture.reopened.closed, true);
});

test('an explicit audit detects an older damaged digest and isolates the writer without changing files', async (t) => {
  const fixture = await historyFixture(t);
  const modified = structuredClone(fixture.oldest);
  modified.workspace.data.opportunities[0].role = 'Synthetic tampered role';
  const path = join(fixture.root, 'commits', fixture.latest.previous.file);
  await writeFile(path, JSON.stringify(modified));
  assert.deepEqual(migrateWorkspace(fixture.latest.workspace), fixture.latest.workspace);
  await fixture.reopened.initialize();
  await assert.rejects(fixture.reopened.auditHistory(), { code: 'WORKSPACE_CORRUPT' });
  await assert.rejects(fixture.reopened.execute(fixture.firstCommand), {
    code: 'WORKSPACE_WRITER_CLOSED',
  });
  assert.deepEqual(await json(join(fixture.root, 'HEAD.json')), fixture.head);
  assert.deepEqual(await json(path), modified);
  assert.equal(fixture.reopened.closed, true);
});

for (const kind of ['unknown field', 'future schema']) {
  test(`legacy HEAD initialization fully audits ${kind} before publishing a catalog`, async (t) => {
    const fixture = await historyFixture(t);
    const modified = structuredClone(fixture.oldest);
    if (kind === 'unknown field')
      modified.workspace.data.opportunities[0].futureField = 'Synthetic';
    else modified.workspace.data.schemaVersion++;
    const { nextHead } = await replaceConsistentHistory(fixture, modified);
    const { catalog: _catalog, ...legacyHead } = { ...nextHead, storageVersion: 1 };
    await writeFile(join(fixture.root, 'HEAD.json'), JSON.stringify(legacyHead));
    await assert.rejects(
      fixture.reopened.initialize(),
      kind === 'unknown field' ? /未知字段/ : /不支持的版本/,
    );
    assert.deepEqual(await json(join(fixture.root, 'HEAD.json')), legacyHead);
    assert.equal(fixture.reopened.owned, false);
  });
}
