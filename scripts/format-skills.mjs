import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devNull } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ownedSkillDirectories, skippedDocumentationDirectories } from './owned-skills.mjs';

async function skillFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !skippedDocumentationDirectories.has(entry.name))
      result.push(...(await skillFiles(path)));
    else if (entry.isFile() && /\.(md|ya?ml)$/i.test(entry.name)) result.push(path);
  }
  return result;
}

try {
  const [mode, ...extra] = process.argv.slice(2);
  if (!['--check', '--write'].includes(mode) || extra.length)
    throw new Error('用法：node scripts/format-skills.mjs --check|--write');
  const files = [];
  const root = await realpath(process.cwd());
  for (const directory of ownedSkillDirectories) {
    try {
      if ((await realpath(directory)) !== join(root, directory))
        throw new Error(`${directory} 含有符号链接，不能格式化。`);
      files.push(...(await skillFiles(directory)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (files.length) {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve('prettier/bin/prettier.cjs')),
        mode,
        '--ignore-path',
        devNull,
        ...files.sort(),
      ],
      { stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  process.stderr.write(`技能格式检查失败：${error.message}\n`);
  process.exitCode = 1;
}
