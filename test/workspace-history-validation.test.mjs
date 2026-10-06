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
  return { root, head, latest, oldest, reopened };
}

async function replaceConsistentHistory({ root, head, latest }, modifiedOldest) {
  const oldest = rehash(modifiedOldest);
  const child = rehash({
    ...latest,
    previous: { file: filename(oldest), hash: oldest.hash },
  });
  const nextHead = { ...head, file: filename(child), hash: child.hash };
  await writeFile(join(root, 'commits', filename(oldest)), JSON.stringify(oldest), { mode: 0o600 });
  await writeFile(join(root, 'commits', filename(child)), JSON.stringify(child), { mode: 0o600 });
  await writeFile(join(root, 'HEAD.json'), JSON.stringify(nextHead));
  assert.equal(child.previous.file, filename(oldest));
  assert.equal(child.previous.hash, oldest.hash);
  assert.equal(nextHead.revision, child.revision);
  assert.equal(child.revision, oldest.revision + 1);
  assert.deepEqual(migrateWorkspace(child.workspace), latest.workspace);
  return { oldest, child, nextHead };
}

test('a valid latest workspace cannot hide an unknown field in digest-valid migrated history', async (t) => {
  const fixture = await historyFixture(t);
  const modified = structuredClone(fixture.oldest);
  modified.workspace.data.schemaVersion = 3;
  modified.workspace.data.opportunities[0].futureField = 'Synthetic unknown value';
  const { oldest, nextHead } = await replaceConsistentHistory(fixture, modified);
  await assert.rejects(fixture.reopened.initialize(), /未知字段/);
  assert.deepEqual(await json(join(fixture.root, 'HEAD.json')), nextHead);
  assert.deepEqual(await json(join(fixture.root, 'commits', filename(oldest))), oldest);
  assert.equal(fixture.reopened.owned, false);
});

test('a valid latest workspace cannot hide a future schema in a digest-valid earlier commit', async (t) => {
  const fixture = await historyFixture(t);
  const modified = structuredClone(fixture.oldest);
  modified.workspace.data.schemaVersion++;
  const { oldest, nextHead } = await replaceConsistentHistory(fixture, modified);
  await assert.rejects(fixture.reopened.initialize(), /不支持的版本/);
  assert.deepEqual(await json(join(fixture.root, 'HEAD.json')), nextHead);
  assert.deepEqual(await json(join(fixture.root, 'commits', filename(oldest))), oldest);
  assert.equal(fixture.reopened.owned, false);
});

test('tampering with an earlier commit without repairing its digest still stops initialization', async (t) => {
  const fixture = await historyFixture(t);
  const modified = structuredClone(fixture.oldest);
  modified.workspace.data.opportunities[0].role = 'Synthetic tampered role';
  const path = join(fixture.root, 'commits', fixture.latest.previous.file);
  await writeFile(path, JSON.stringify(modified));
  assert.deepEqual(migrateWorkspace(fixture.latest.workspace), fixture.latest.workspace);
  await assert.rejects(fixture.reopened.initialize(), { code: 'WORKSPACE_CORRUPT' });
  assert.deepEqual(await json(join(fixture.root, 'HEAD.json')), fixture.head);
  assert.deepEqual(await json(path), modified);
  assert.equal(fixture.reopened.owned, false);
});
