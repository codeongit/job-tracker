import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const tool = fileURLToPath(new URL('../scripts/task-evidence.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'task-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const task = randomUUID();
  const input = join(root, '.local/tasks', task, 'evidence-input.json');
  const spec = {
    schema_version: 1,
    goal: '验证两个独立模块并保留其审查版本。',
    sources: ['合成需求：两个模块的常量保持为 1。'],
    rules: ['AGENTS.md'],
    review_inputs: ['src'],
    checks: [
      { id: 'a', command: [process.execPath, '-e', 'process.exit(0)'], inputs: ['src/a'] },
      { id: 'b', command: [process.execPath, '-e', 'process.exit(0)'], inputs: ['src/b'] },
    ],
  };
  async function write(path, content) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await write('.gitignore', '.local/\n.env*\nignored/\n');
  await write('AGENTS.md', '# 合成规则\n');
  await write('src/a/value.js', 'export const value = 1;\n');
  await write('src/b/value.js', 'export const value = 1;\n');
  await mkdir(dirname(input), { recursive: true });
  async function declare() {
    await writeFile(input, JSON.stringify(spec));
  }
  await declare();
  function cli(args, status = 0) {
    const result = spawnSync(process.execPath, [tool, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim() ? JSON.parse(result.stdout) : result.stderr;
  }
  const capture = (reuse) =>
    cli(['capture', '--task', task, '--input', input, ...(reuse ? ['--reuse', reuse] : [])]);
  const run = (snapshot, check, status = 0) =>
    cli(['run', task, snapshot, '--check', check], status);
  const verify = (snapshot, status = 0) => cli(['verify', task, snapshot], status);
  return { root, task, input, spec, write, declare, cli, capture, run, verify };
}

test('missing checks fail; captured executions pass without persisting source or output', async (t) => {
  const f = await fixture(t);
  const { snapshot } = f.capture();
  assert.deepEqual(
    f.verify(snapshot, 1).checks.map((item) => item.status),
    ['missing', 'missing'],
  );
  f.run(snapshot, 'a');
  f.run(snapshot, 'b');
  const result = f.verify(snapshot);
  assert.equal(result.passed, true);
  assert.equal(result.review_snapshot, 'current');
  const saved = await readFile(
    join(f.root, '.local/tasks', f.task, 'evidence', snapshot, 'snapshot.json'),
    'utf8',
  );
  assert.ok(!saved.includes('export const value'));
  assert.ok(!saved.includes('stdout'));
});

test('unrelated inputs keep evidence valid; changed check is rerun after explicit scoped reuse', async (t) => {
  const f = await fixture(t);
  const old = f.capture().snapshot;
  f.run(old, 'a');
  f.run(old, 'b');
  await f.write('src/a/new.js', 'export const newValue = 2;\n');
  const result = f.verify(old, 1);
  assert.deepEqual(
    result.checks.map((item) => item.status),
    ['stale', 'passed'],
  );
  assert.equal(result.review_snapshot, 'stale');
  assert.match(f.run(old, 'a', 1), /重新 capture/);
  const next = f.capture(old);
  assert.deepEqual(next.reused, ['b']);
  assert.deepEqual(
    f.verify(next.snapshot, 1).checks.map((item) => item.status),
    ['missing', 'passed'],
  );
  f.run(next.snapshot, 'a');
  assert.equal(f.verify(next.snapshot).passed, true);
});

test('deleted directory members and tracked deletions invalidate evidence', async (t) => {
  const f = await fixture(t);
  assert.equal(spawnSync('git', ['add', 'src'], { cwd: f.root }).status, 0);
  const { snapshot } = f.capture();
  f.run(snapshot, 'a');
  f.run(snapshot, 'b');
  await rm(join(f.root, 'src/a/value.js'));
  assert.deepEqual(
    f.verify(snapshot, 1).checks.map((item) => item.status),
    ['stale', 'passed'],
  );
});

test('goal, source references and rules invalidate every check and prevent reuse', async (t) => {
  for (const change of ['goal', 'source', 'rules']) {
    const f = await fixture(t);
    const { snapshot } = f.capture();
    f.run(snapshot, 'a');
    f.run(snapshot, 'b');
    if (change === 'rules') await f.write('AGENTS.md', '# 修正的合成规则\n');
    else {
      if (change === 'goal') f.spec.goal = '更新目标';
      else f.spec.sources.push('新的需求来源');
      await f.declare();
    }
    const result = f.verify(snapshot, 1);
    assert.equal(result.rules_and_goal, 'stale');
    assert.deepEqual(
      result.checks.map((item) => item.status),
      ['stale', 'stale'],
    );
    assert.deepEqual(f.capture(snapshot).reused, []);
  }
});

test('adding a previously absent policy file and new workflow invalidates all evidence', async (t) => {
  for (const path of [
    'package.json',
    '.prettierrc.json',
    '.github/workflows/check.yml',
    'scripts/check.mjs',
  ]) {
    const f = await fixture(t);
    const { snapshot } = f.capture();
    f.run(snapshot, 'a');
    await f.write(path, '{}');
    const result = f.verify(snapshot, 1);
    assert.equal(result.policy, 'stale', path);
    assert.deepEqual(
      result.checks.map((item) => item.status),
      ['stale', 'stale'],
    );
  }
});

test('command changes invalidate only that check; changing check list cannot silently remove a requirement', async (t) => {
  const f = await fixture(t);
  const { snapshot } = f.capture();
  f.run(snapshot, 'a');
  f.run(snapshot, 'b');
  f.spec.checks[0].command = [process.execPath, '-e', 'process.exit(1)'];
  await f.declare();
  assert.deepEqual(
    f.verify(snapshot, 1).checks.map((item) => item.status),
    ['stale', 'passed'],
  );
  f.spec.checks.shift();
  await f.declare();
  assert.deepEqual(
    f.verify(snapshot, 1).checks.map((item) => item.status),
    ['stale', 'passed'],
  );
});

test('a later failed run supersedes an earlier pass', async (t) => {
  const f = await fixture(t);
  f.spec.checks[0].command = [
    process.execPath,
    '-e',
    'process.exit(require("node:fs").existsSync(".local/fail") ? 1 : 0)',
  ];
  await f.declare();
  const { snapshot } = f.capture();
  const first = f.run(snapshot, 'a');
  await f.write('.local/fail', 'synthetic switch');
  const second = f.run(snapshot, 'a', 1);
  assert.ok(second.sequence > first.sequence);
  assert.equal(second.status, 'failed');
  assert.equal(f.verify(snapshot, 1).checks[0].status, 'failed');
  assert.deepEqual(f.capture(snapshot).reused, []);
});

test('input changes during a successful command are stale; command argv is not shell expanded', async (t) => {
  const f = await fixture(t);
  f.spec.checks[0].command = [
    process.execPath,
    '-e',
    'const fs = require("node:fs"); require("node:assert/strict").equal(process.argv[1], "; touch should-not-exist"); fs.writeFileSync("src/a/value.js", "changed");',
    '; touch should-not-exist',
  ];
  await f.declare();
  const { snapshot } = f.capture();
  const result = f.run(snapshot, 'a', 1);
  assert.equal(result.exit_code, 0);
  assert.equal(result.status, 'stale');
  assert.ok(!(await readdir(f.root)).includes('should-not-exist'));
});

test('missing executable produces failed evidence rather than passing', async (t) => {
  const f = await fixture(t);
  f.spec.checks[0].command = ['nonexistent-task-evidence-executable'];
  await f.declare();
  const { snapshot } = f.capture();
  const result = f.run(snapshot, 'a', 1);
  assert.equal(result.execution_error, 'ENOENT');
  assert.equal(f.verify(snapshot, 1).checks[0].status, 'failed');
});

test('an unfinished latest attempt cannot fall back to an old pass', async (t) => {
  const f = await fixture(t);
  const { snapshot } = f.capture();
  const first = f.run(snapshot, 'a');
  const directory = `.local/tasks/${f.task}/evidence/${snapshot}/runs/a`;
  const next = randomUUID();
  await f.write(
    `${directory}/${next}.started.json`,
    JSON.stringify({ ...first, run: next, sequence: first.sequence + 1 }),
  );
  assert.equal(f.verify(snapshot, 1).checks[0].status, 'missing');
  assert.equal(f.run(snapshot, 'a').sequence, first.sequence + 2);
  await f.write(`${directory}/active.json`, '{}');
  assert.equal(f.verify(snapshot, 1).checks[0].status, 'missing');
  assert.match(f.run(snapshot, 'a', 1), /EEXIST/);
});

test('public paths reject traversal, private state, ignored files and symlinks', async (t) => {
  const f = await fixture(t);
  await f.write('ignored/private.txt', 'synthetic private');
  await symlink(join(f.root, '.local'), join(f.root, 'src/escape'));
  for (const path of [
    '../outside',
    '/tmp/outside',
    '.local',
    '.env.secret',
    'ignored',
    'ignored/private.txt',
    'src/escape',
  ]) {
    f.spec.checks[0].inputs = [path];
    await f.declare();
    assert.equal(typeof f.cli(['capture', '--task', f.task, '--input', f.input], 1), 'string');
  }
});

test('declaration and local output cannot traverse symlinks or include snapshot output', async (t) => {
  const f = await fixture(t);
  f.spec.review_inputs = [`.local/tasks/${f.task}/evidence`];
  await f.declare();
  assert.match(f.cli(['capture', '--task', f.task, '--input', f.input], 1), /私有/);
  f.spec.review_inputs = ['src'];
  await f.declare();
  const linkInput = join(dirname(f.input), 'linked.json');
  await symlink(f.input, linkInput);
  assert.match(f.cli(['capture', '--task', f.task, '--input', linkInput], 1), /符号链接/);
  await symlink(join(f.root, 'src'), join(dirname(f.input), 'evidence'));
  assert.match(f.cli(['capture', '--task', f.task, '--input', f.input], 1), /符号链接/);
});

test('unknown versions, unknown fields and empty review scopes are rejected', async (t) => {
  const f = await fixture(t);
  f.spec.schema_version = 2;
  await f.declare();
  assert.match(f.cli(['capture', '--task', f.task, '--input', f.input], 1), /版本/);
  f.spec.schema_version = 1;
  f.spec.approved = true;
  await f.declare();
  assert.match(f.cli(['capture', '--task', f.task, '--input', f.input], 1), /未知字段/);
  delete f.spec.approved;
  f.spec.review_inputs = [];
  await f.declare();
  assert.match(f.cli(['capture', '--task', f.task, '--input', f.input], 1), /非空/);
});
