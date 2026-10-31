import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildGraph, exportGraph } from '../scripts/uml-viewer/graph.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'job-tracker-uml-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), source);
  }
  for (const args of [
    ['init', '-q'],
    ['add', '--', ...Object.keys(files)],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return root;
}

test('tracked JS and MJS form one graph across all three production roots without execution', async (t) => {
  const root = await fixture(t, {
    'dist/model.js': 'export const model = 1;',
    'scripts/store.mjs': 'export { model } from "../dist/model.js";',
    'collector/boss/run.mjs':
      'import "../../scripts/store.mjs"; throw new Error("must not execute");',
  });
  const graph = await buildGraph(root);
  assert.deepEqual(
    graph.classes.map(({ id }) => id),
    ['collector.boss.run%2Emjs', 'dist.model%2Ejs', 'scripts.store%2Emjs'],
  );
  assert.deepEqual(graph.edges, [
    { from: 'collector.boss.run%2Emjs', to: 'scripts.store%2Emjs', kind: 'dependency' },
    { from: 'scripts.store%2Emjs', to: 'dist.model%2Ejs', kind: 'dependency' },
  ]);
  assert.equal(graph.classes[1].file, join(root, 'dist/model.js'));
  assert.equal(graph.classes[1].lang, 'typescript');
});

test('tracked symbolic links are rejected before reading their targets', async (t) => {
  const root = await fixture(t, { 'dist/app.js': 'export const app = true;' });
  await symlink(join(root, '.local/unknown-private-file.js'), join(root, 'dist/link.js'));
  assert.equal(spawnSync('git', ['add', 'dist/link.js'], { cwd: root }).status, 0);
  await assert.rejects(buildGraph(root), { code: 'MODULE_SYMLINK' });
});

test('Node builtin dependencies are explicit foreign nodes and source side effects never run', async (t) => {
  const root = await fixture(t, { 'scripts/read.mjs': 'export const value = 1;' });
  const marker = join(root, 'executed.txt');
  await writeFile(
    join(root, 'scripts/read.mjs'),
    `import { writeFileSync } from 'node:fs'; import 'fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`,
  );
  const graph = await buildGraph(root);
  assert.deepEqual(graph.edges, [
    { from: 'scripts.read%2Emjs', to: 'node.fs', kind: 'dependency' },
  ]);
  assert.ok(
    graph.classes.some((item) => item.id === 'node.fs' && item.name === 'node:fs' && item.foreign),
  );
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('dynamic loaders are refused instead of producing an incomplete static graph', async (t) => {
  const root = await fixture(t, {
    'scripts/run.mjs': 'const file = "./plugin.mjs"; await import(file);',
  });
  await assert.rejects(buildGraph(root), { code: 'MODULE_DYNAMIC_CODE' });
});

test('export writes hierarchical EDN and preserves the last good diagram if source becomes invalid', async (t) => {
  const root = await fixture(t, {
    'dist/model.js': 'export const value = 1;',
    'scripts/run.mjs': 'import "../dist/model.js";',
  });
  const output = join(root, '.local/uml-viewer/diagram.edn');
  assert.deepEqual(await exportGraph(root, output), { modules: 2, edges: 1, output });
  const first = await readFile(output, 'utf8');
  assert.match(first, /:hierarchical true/);
  assert.match(first, /:id :dist\.model%2Ejs/);
  assert.match(first, /:from :scripts\.run%2Emjs :to :dist\.model%2Ejs :kind :dependency/);
  assert.match(first, /:lang :typescript/);
  await writeFile(join(root, 'dist/model.js'), 'invalid source syntax!');
  await assert.rejects(exportGraph(root, output), /语法无效/);
  assert.equal(await readFile(output, 'utf8'), first);
});

test('file extensions and dotted names cannot collide with directory nodes', async (t) => {
  const root = await fixture(t, {
    'scripts/tool.mjs': 'export const a = 1;',
    'scripts/tool/main.mjs': 'export const b = 1;',
    'scripts/tool.main.mjs': 'export const c = 1;',
  });
  assert.deepEqual(
    (await buildGraph(root)).classes.map(({ id }) => id),
    ['scripts.tool%2Emain%2Emjs', 'scripts.tool%2Emjs', 'scripts.tool.main%2Emjs'],
  );
});

test('only explicit relative tracked production modules and Node builtins are accepted', async (t) => {
  const root = await fixture(t, {
    'scripts/run.mjs': 'export const run = true;',
    'scripts/pkg/leaf.mjs': 'export const leaf = 1;',
    '.local/private.mjs': 'not JavaScript',
    'dist/data.json': '{}',
  });
  for (const specifier of [
    'pkg/leaf.mjs',
    'https://example.test/remote.mjs',
    '../.local/private.mjs',
    '../../outside.mjs',
    './missing.mjs',
    '../dist/data.json',
  ]) {
    await writeFile(join(root, 'scripts/run.mjs'), `import ${JSON.stringify(specifier)};`);
    await assert.rejects(buildGraph(root), undefined, specifier);
  }
});

test('private, test and untracked files are excluded even when their content cannot be parsed', async (t) => {
  const root = await fixture(t, {
    'dist/app.js': 'export const app = true;',
    '.local/private.js': 'invalid private source',
    'dist/.local/private.js': 'invalid nested private source',
    'collector/boss/data/private.js': 'invalid private observation',
    'dist/app.test.js': 'invalid test source',
    'test/helper.mjs': 'invalid test helper',
  });
  await writeFile(join(root, 'dist/untracked.js'), 'invalid untracked source');
  await rm(join(root, '.local/private.js'));
  await symlink(join(root, 'missing-secret'), join(root, '.local/private.js'));
  assert.deepEqual(
    (await buildGraph(root)).classes.map(({ name }) => name),
    ['app.js'],
  );
});

test('a linked output directory is rejected without writing into its target', async (t) => {
  const root = await fixture(t, { 'dist/app.js': 'export const app = true;' });
  const target = await fixture(t, { 'keep.txt': 'unchanged' });
  await symlink(target, join(root, '.local'));
  await assert.rejects(
    exportGraph(root, join(root, '.local/uml-viewer/diagram.edn')),
    /无符号链接/,
  );
  await assert.rejects(readFile(join(target, 'uml-viewer/diagram.edn')), { code: 'ENOENT' });
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'unchanged');
});

test('unsupported syntax and malformed UTF-8 fail before replacing an existing diagram', async (t) => {
  const root = await fixture(t, { 'scripts/run.mjs': 'export const run = true;' });
  const output = join(root, '.local/uml-viewer/diagram.edn');
  await exportGraph(root, output);
  const first = await readFile(output);
  for (const source of ['const fs = require("node:fs");', Buffer.from([0xff, 0xfe])]) {
    await writeFile(join(root, 'scripts/run.mjs'), source);
    await assert.rejects(exportGraph(root, output));
    assert.deepEqual(await readFile(output), first);
  }
});

test('an empty tracked production scope is reported instead of exporting a blank success', async (t) => {
  const root = await fixture(t, { 'README.md': 'No production sources yet.' });
  await assert.rejects(buildGraph(root), /没有.*生产模块/);
});
