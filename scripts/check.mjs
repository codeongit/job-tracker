import { readFile, readdir, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { APP_VERSION } from '../dist/version.js';
const root = new URL('../', import.meta.url);
async function files(dir) {
  const result = [];
  for (const name of await readdir(new URL(dir, root))) {
    const path = dir + name,
      info = await lstat(new URL(path, root));
    if (info.isSymbolicLink()) throw new Error(`${path} 不应包含符号链接。`);
    if (info.isDirectory()) result.push(...(await files(path + '/')));
    else result.push(path);
  }
  return result;
}
const publicFiles = await files('dist/');
for (const file of [...publicFiles, ...(await files('scripts/')), ...(await files('test/'))]) {
  if (!/\.(?:m?js)$/.test(file)) continue;
  const url = new URL(file, root),
    r = spawnSync(process.execPath, ['--check', url.pathname], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
  const code = await readFile(url, 'utf8');
  for (const match of code.matchAll(/from\s*['"](\.[^'"]+)['"]/g))
    await readFile(new URL(match[1], url));
}
const html = await readFile(new URL('dist/index.html', root), 'utf8');
for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g))
  await readFile(new URL('dist/' + match[1], root));
for (const file of publicFiles) {
  if (!/\.(js|css|html|svg)$/.test(file)) throw new Error(`${file} 不是预期的公开资源。`);
  const content = await readFile(new URL(file, root), 'utf8');
  if (
    /(?:ghp_|github_pat_)[A-Za-z0-9_]{16,}|securityId=|zhipin\.com\/job_detail\/|BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY/.test(
      content,
    )
  )
    throw new Error(`${file} 含有凭证或真实岗位链接，请移除后再发布。`);
}
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (pkg.version !== APP_VERSION) throw new Error('package.json 与页面版本号不一致。');
process.stdout.write('语法、相对导入、入口资源、版本号与公开目录检查通过。\n');
