import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertCheckout,
  prepareDirectory,
  runtimeEnvironment,
} from '../scripts/uml-viewer/runtime.mjs';
import { main } from '../scripts/uml.mjs';

test('UML 只启动固定提交且没有额外源码的工具副本', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uml checkout '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q');
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'src', 'main.clj'), '(ns main)\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  const revision = git('rev-parse', 'HEAD');
  assert.doesNotThrow(() => assertCheckout(directory, revision));
  const linked = `${directory}-link`;
  await symlink(directory, linked);
  t.after(() => rm(linked, { force: true }));
  assert.throws(() => assertCheckout(linked, revision), /符号链接/);
  assert.throws(() => assertCheckout(directory, '0'.repeat(40)), /版本不符/);
  await writeFile(join(directory, 'src', 'main.clj'), '(ns changed)\n');
  assert.throws(() => assertCheckout(directory, revision), /已修改/);
  await writeFile(join(directory, 'src', 'main.clj'), '(ns main)\n');
  await writeFile(join(directory, 'src', 'extra.clj'), '(ns extra)\n');
  assert.throws(() => assertCheckout(directory, revision), /额外文件/);
  await writeFile(join(directory, '.git', 'info', 'exclude'), 'src/extra.clj\n');
  assert.throws(() => assertCheckout(directory, revision), /额外文件/);
});

test('独立打开缺少运行环境时明确失败，不启动安装或查看器', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'uml missing runtime '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prior = process.env.UML_JAVA_HOME;
  process.env.UML_JAVA_HOME = join(root, 'missing-java');
  t.after(() => {
    if (prior === undefined) delete process.env.UML_JAVA_HOME;
    else process.env.UML_JAVA_HOME = prior;
  });
  await assert.rejects(() => main(['open'], root), /需要 Java 21/);
  await assert.rejects(() => main(['--restart'], root), /不支持的 UML 参数/);
});

test('UML 不沿本机目录符号链接写入其他位置', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'uml root '));
  const outside = await mkdtemp(join(tmpdir(), 'uml outside '));
  t.after(() =>
    Promise.all([root, outside].map((path) => rm(path, { recursive: true, force: true }))),
  );
  await symlink(outside, join(root, '.local'));
  await assert.rejects(() => prepareDirectory(root), /符号链接/);
});

test('Clojure 必须使用已检查的专用 Java，而不是 PATH 中的另一个版本', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'uml java selection '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const javaHome = join(directory, 'java');
  const java = join(javaHome, 'bin/java');
  const clojure = join(directory, 'clojure');
  await mkdir(join(javaHome, 'bin'), { recursive: true });
  await writeFile(java, '#!/bin/sh\nprintf \'openjdk version "21.0.13"\\n\' >&2\n');
  await writeFile(clojure, '#!/bin/sh\nprintf \'{:version "fixture"}\\n\'\n');
  await Promise.all([java, clojure].map((file) => chmod(file, 0o755)));
  const prior = { UML_JAVA_HOME: process.env.UML_JAVA_HOME, UML_CLOJURE: process.env.UML_CLOJURE };
  Object.assign(process.env, { UML_JAVA_HOME: javaHome, UML_CLOJURE: clojure });
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  assert.equal(runtimeEnvironment(directory).env.JAVA_CMD, java);
});
