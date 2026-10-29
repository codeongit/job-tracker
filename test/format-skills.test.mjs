import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = fileURLToPath(new URL('../scripts/format-skills.mjs', import.meta.url));

test('skill format CLI reports and fixes owned Markdown and YAML while preserving external skills', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-format-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    '.prettierignore': '.agents/\n',
    '.agents/skills/code-review/SKILL.md': '#  审查\n',
    '.agents/skills/pr/SKILL.md': '#  正文\n',
    '.agents/skills/tdd/agents/openai.yaml': 'interface: {display_name: 测试}\n',
    '.agents/skills/external/SKILL.md': '#  外部技能\n',
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  const run = (mode) =>
    spawnSync(process.execPath, [command, mode], { cwd: root, encoding: 'utf8' });
  const failed = run('--check');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /code-review\/SKILL\.md/);
  assert.match(failed.stderr, /pr\/SKILL\.md/);
  assert.match(failed.stderr, /tdd\/agents\/openai\.yaml/);
  assert.doesNotMatch(failed.stderr, /external/);
  assert.equal(
    await readFile(join(root, '.agents/skills/code-review/SKILL.md'), 'utf8'),
    '#  审查\n',
  );
  const fixed = run('--write');
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(
    await readFile(join(root, '.agents/skills/code-review/SKILL.md'), 'utf8'),
    '# 审查\n',
  );
  assert.equal(
    await readFile(join(root, '.agents/skills/external/SKILL.md'), 'utf8'),
    '#  外部技能\n',
  );
  assert.equal(await readFile(join(root, '.agents/skills/pr/SKILL.md'), 'utf8'), '# 正文\n');
  assert.equal(run('--check').status, 0);
});

test('skill formatting refuses a directory alias before modifying material outside its scope', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-format-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.local/private'), { recursive: true });
  await mkdir(join(root, '.agents/skills'), { recursive: true });
  const privateFile = join(root, '.local/private/SKILL.md');
  await writeFile(privateFile, '#  私有材料\n');
  await symlink(join(root, '.local/private'), join(root, '.agents/skills/code-review'));
  const result = spawnSync(process.execPath, [command, '--write'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /符号链接/);
  assert.equal(await readFile(privateFile, 'utf8'), '#  私有材料\n');
});

test('skill formatting leaves nested private, dependency and fixture material outside its scope', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-format-exclusions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = join(root, '.agents/skills/code-review');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# 审查\n');
  const excluded = ['.local', 'node_modules', 'fixtures', 'test'];
  for (const directory of excluded) {
    await mkdir(join(skill, directory));
    await writeFile(join(skill, directory, 'sample.md'), '#  保留原样\n');
  }
  const run = (mode) =>
    spawnSync(process.execPath, [command, mode], { cwd: root, encoding: 'utf8' });
  const checked = run('--check');
  assert.equal(checked.status, 0, checked.stderr);
  const written = run('--write');
  assert.equal(written.status, 0, written.stderr);
  for (const directory of excluded)
    assert.equal(await readFile(join(skill, directory, 'sample.md'), 'utf8'), '#  保留原样\n');
});
