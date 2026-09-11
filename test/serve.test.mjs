import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicPath } from '../scripts/static-files.mjs';

test('本机服务在带尾斜杠的公开目录正确解析首页和静态文件', () => {
  const root = '/private/tmp/job-tracker-dist/';
  assert.equal(resolvePublicPath(root, '/'), '/private/tmp/job-tracker-dist/index.html');
  assert.equal(resolvePublicPath(root, '/app.js'), '/private/tmp/job-tracker-dist/app.js');
});

test('本机静态服务拒绝越界路径和隐藏文件', () => {
  const root = '/private/tmp/job-tracker-dist/';
  for (const path of ['/../private.json', '/.local/config.json', '/nested/.secret'])
    assert.throws(() => resolvePublicPath(root, path), /Not found/);
});
