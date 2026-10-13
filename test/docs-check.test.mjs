import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkDocumentation } from '../scripts/docs-check.mjs';

async function fixture(t, documents = {}) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-docs-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'docs/adr/README.md':
      '# 决策索引\n\n| 编号 | 决策 |\n| --- | --- |\n| [D001](0001-synthetic.md) | 合成决定 |\n',
    'docs/adr/0001-synthetic.md': '# D001：合成决定\n\n历史规则 v1 与应用 0.1.0。\n',
    ...documents,
  };
  for (const [file, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), body);
  }
  return root;
}

test('checks inline, image, reference and repository-root links without reading code headings', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '[说明](docs/guide.md#说明)\n![图片](assets/image.svg "标题")\n[代码](/scripts/example.mjs#symbol)\n[完整][Guide]\n[折叠][]\n[shortcut]\n\n[guide]: docs/guide.md#说明 "标题"\n[折叠]: <docs/guide.md#说明>\n[shortcut]: docs/guide.md\n',
    'docs/guide.md': '# 说明\n',
    'assets/image.svg': '<svg/>',
    'scripts/example.mjs': 'export const symbol = 1;\n',
  });
  assert.deepEqual(await checkDocumentation(root), []);
});

test('decodes Chinese and percent-encoded paths and handles spaces, parentheses and escapes', async (t) => {
  const root = await fixture(t, {
    'README.md':
      "[中文](docs/%E4%B8%AD%E6%96%87%20%25.md#%E6%A0%87%E9%A2%98)\n[括号](docs/name(one).md)\n[转义](docs/name\\(one\\).md)\n[空格](<docs/a b.md> '标题')\n",
    'docs/中文 %.md': '# 标题\n',
    'docs/name(one).md': '# Parenthesis\n',
    'docs/a b.md': '# Spaces\n',
  });
  assert.deepEqual(await checkDocumentation(root), []);
});

test('uses Chinese, punctuation, code text and collision-safe duplicate heading anchors', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '[版本](docs/headings.md#接口v01022d017)\n[代码](docs/headings.md#运行-pnpm-check)\n[重复](docs/headings.md#重复-1)\n[碰撞](docs/headings.md#重复-1-1)\n[再次](docs/headings.md#重复-2)\n[下划线](docs/headings.md#keep_under-score)\n[目录](docs/adr/#决策索引)\n[setext](docs/headings.md#setext)\n[强调](docs/headings.md#emphasis)\n[标点](docs/headings.md#甲乙--丙)\n',
    'docs/headings.md':
      '# 接口（v0.10.22，D017）\n# 运行 `pnpm check`\n# 重复\n# 重复\n# 重复-1\n# 重复\n# Keep_under-score\n\nSetext\n------\n\n# _Emphasis_\n# 甲—乙 &amp; 丙\n',
  });
  assert.deepEqual(await checkDocumentation(root), []);
});

test('reports missing targets, wrong case, missing anchors and invalid percent encoding with source lines', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '[不存在](docs/missing.md)\n[大小写](docs/Guide.md)\n[标题](docs/guide.md#不存在)\n[编码](docs/%xx.md)\n',
    'docs/guide.md': '# 存在\n',
  });
  const issues = await checkDocumentation(root);
  assert.deepEqual(
    issues.map(({ file, line, code }) => ({ file, line, code })),
    [
      { file: 'README.md', line: 1, code: 'link_target_missing' },
      { file: 'README.md', line: 2, code: 'link_case_mismatch' },
      { file: 'README.md', line: 3, code: 'link_anchor_missing' },
      { file: 'README.md', line: 4, code: 'link_encoding_invalid' },
    ],
  );
});

test('rejects traversal and symlinks out of the root while accepting an internal symlink', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '[越界](../outside.md)\n[外部链接](docs/outside.md)\n[内部链接](docs/inside.md#内部)\n',
    'docs/target.md': '# 内部\n',
  });
  const outside = await mkdtemp(join(tmpdir(), 'job-tracker-docs-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside.md'), '# 外部\n');
  await symlink(join(outside, 'outside.md'), join(root, 'docs/outside.md'));
  await symlink(join(root, 'docs/target.md'), join(root, 'docs/inside.md'));
  const issues = await checkDocumentation(root);
  assert.equal(issues.filter(({ code }) => code === 'link_outside_root').length, 2);
  assert.ok(!issues.some(({ line, file }) => file === 'README.md' && line === 3));
});

test('ignores fenced, indented and inline code and multiline comments', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '```markdown\n[假链接](missing-fence.md)\n# 假标题\n```\n~~~\n[假链接](missing-tilde.md)\n~~~\n\n    [假链接](missing-indent.md)\n\n`[假链接](missing-inline.md)`\n``[假链接](missing-long-inline.md)``\n<!-- [假链接](missing-comment.md)\n[另一个](missing-comment2.md) -->\n文字 [普通方括号] 与 \\[非链接](missing-escaped.md)\n[真链接](#真实)\n# 真实\n',
  });
  assert.deepEqual(await checkDocumentation(root), []);
});

test('checks a local image nested inside a valid outer link at its actual source line', async (t) => {
  const root = await fixture(t, {
    'README.md': '# 入口\n\n[![diagram](docs/absent.svg)](docs/guide.md)\n',
    'docs/guide.md': '# 说明\n',
  });
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ file, line, code }) => ({ file, line, code })),
    [{ file: 'README.md', line: 3, code: 'link_target_missing' }],
  );
});

test('checks both resources of a linked image and keeps an image inside an external link local', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '[![diagram](docs/absent.svg)](docs/absent.md)\n[![diagram][picture]](https://invalid.example/)\n\n[picture]: docs/absent.svg\n',
  });
  const findings = await checkDocumentation(root);
  assert.deepEqual(
    findings.map(({ line, code }) => ({ line, code })),
    [
      { line: 1, code: 'link_target_missing' },
      { line: 1, code: 'link_target_missing' },
      { line: 2, code: 'link_target_missing' },
      { line: 4, code: 'link_target_missing' },
    ],
  );
  assert.ok(findings.some(({ line, message }) => line === 1 && message.endsWith('docs/absent.md')));
  assert.ok(
    findings.some(({ line, message }) => line === 1 && message.endsWith('docs/absent.svg')),
  );
});

test('a comment opener inside fenced or inline code cannot hide a later real link', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '```html\n<!-- [fake](docs/also-absent.md)\n```\n[actual](docs/absent.md)\n`<!--`\n[actual](docs/absent.md)\n',
  });
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ file, line, code }) => ({ file, line, code })),
    [4, 6].map((line) => ({ file: 'README.md', line, code: 'link_target_missing' })),
  );
});

test('fences and backticks inside real HTML comments cannot hide links after the comment ends', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '<!--\n```html\n` [fake](docs/also-absent.md)\n-->\n[actual](docs/absent.md)\n<!-- `code` [fake](docs/also-absent.md) -->\n[actual](docs/absent.md)\n',
  });
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ file, line, code }) => ({ file, line, code })),
    [5, 7].map((line) => ({ file: 'README.md', line, code: 'link_target_missing' })),
  );
});

test('checks a reference destination continued on the next line', async (t) => {
  const root = await fixture(t, {
    'README.md': '[actual][guide]\n\n[guide]:\n  docs/absent.md\n',
  });
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ file, line, code }) => ({ file, line, code })),
    [1, 3].map((line) => ({ file: 'README.md', line, code: 'link_target_missing' })),
  );
});

test('accepts a continued reference destination and optional following title when the target exists', async (t) => {
  const root = await fixture(t, {
    'README.md': '[actual][guide]\n\n[guide]:\n  <docs/guide.md#说明>\n  "标题"\n',
    'docs/guide.md': '# 说明\n',
  });
  assert.deepEqual(await checkDocumentation(root), []);
});

test('quoted fences are code while indented list continuations remain checked prose', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '> ~~~markdown\n> [example](docs/absent.md)\n> ~~~\n\n- Item\n\n    [actual](docs/absent.md)\n\n      [list-code](docs/also-absent.md)\n\nOutside list.\n\n    [code](docs/also-absent.md)\n',
  });
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ file, line, code }) => ({ file, line, code })),
    [{ file: 'README.md', line: 7, code: 'link_target_missing' }],
  );
});

test('reports a broken symlink as a missing target without failing the whole check', async (t) => {
  const root = await fixture(t, { 'README.md': '[缺失](docs/broken.md)\n' });
  await symlink(join(root, 'docs/absent.md'), join(root, 'docs/broken.md'));
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ file, line, code }) => ({ file, line, code })),
    [{ file: 'README.md', line: 1, code: 'link_target_missing' }],
  );
});

test('skips external links for all schemes and protocol-relative URLs without network access', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '[HTTPS](https://invalid.example/path#missing)\n[SSH](ssh://invalid.example/repo)\n[邮件](mailto:someone@example.invalid)\n[插件](plugin://opaque)\n[文件](file:///not-read/private.md)\n[协议](//invalid.example/path)\n[锚点外部](https://invalid.example/#unknown)\n',
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('文档检查不应请求网络');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  assert.deepEqual(await checkDocumentation(root), []);
});

test('checks only owned documentation and excludes dependency, private, skill and fixture trees', async (t) => {
  const root = await fixture(t, {
    'README.md': '# 入口\n',
    'docs/owned.md': '[缺失](missing.md)\n',
    'collector/boss/AGENTS.md': '[缺失](missing.md)\n',
    '.github/reviews/README.md': '[缺失](missing.md)\n',
    'docs/fixtures/README.md': '[跳过](missing.md)\n',
    'collector/node_modules/a/README.md': '[跳过](missing.md)\n',
    'docs/.local/README.md': '[跳过](missing.md)\n',
    '.agents/skills/a/SKILL.md': '[跳过](missing.md)\n',
    'test/fixtures/README.md': '[跳过](missing.md)\n',
    '.local/README.md': '[跳过](missing.md)\n',
  });
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ file }) => file),
    ['.github/reviews/README.md', 'collector/boss/AGENTS.md', 'docs/owned.md'],
  );
});

test('reports unresolved explicit and collapsed references and permits ordinary unmatched brackets', async (t) => {
  const root = await fixture(t, {
    'README.md': '[显式][missing]\n[collapsed][]\n普通 [文字]。\n',
  });
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ line, code }) => ({ line, code })),
    [
      { line: 1, code: 'link_reference_missing' },
      { line: 2, code: 'link_reference_missing' },
    ],
  );
});

test('does not read excluded Markdown fragments or an internal symlink to private Markdown', async (t) => {
  const root = await fixture(t, {
    'README.md':
      '[私有](.local/private.md#secret)\n[材料](docs/fixtures/private.md#secret)\n[内部别名](docs/private-alias.md#secret)\n[范围外](test/fixture.md#secret)\n[代码](test/public-test.mjs#symbol)\n',
    '.local/private.md': '# secret\n[不能扫描](missing-private.md)\n',
    'docs/fixtures/private.md': '# secret\n[不能扫描](missing-fixture.md)\n',
    'test/fixture.md': '# secret\n[不能扫描](missing-test.md)\n',
    'test/public-test.mjs': 'export const symbol = 1;\n',
  });
  await symlink(join(root, '.local/private.md'), join(root, 'docs/private-alias.md'));
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ file, line, code }) => ({ file, line, code })),
    [1, 2, 3, 4].map((line) => ({
      file: 'README.md',
      line,
      code: 'link_markdown_scope_excluded',
    })),
  );
});

test('does not walk an owned source-directory alias pointing into a private directory', async (t) => {
  const root = await fixture(t, {
    '.local/collector/private.md': '# secret\n[不能扫描](missing-private.md)\n',
  });
  await symlink(join(root, '.local/collector'), join(root, 'collector'));
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ file, line, code }) => ({ file, line, code })),
    [{ file: 'collector', line: 1, code: 'document_scope_excluded' }],
  );
});

test('does not walk a top-level docs alias into private materials even when it contains an ADR index', async (t) => {
  const root = await fixture(t, {
    '.local/docs/README.md': '# secret\n[不能扫描](missing-private.md)\n',
    '.local/docs/adr/README.md': '# 私有索引\n',
  });
  await rm(join(root, 'docs'), { recursive: true });
  await symlink(join(root, '.local/docs'), join(root, 'docs'));
  assert.deepEqual(
    (await checkDocumentation(root)).map(({ file, line, code }) => ({ file, line, code })),
    [
      { file: 'docs', line: 1, code: 'document_scope_excluded' },
      { file: 'docs/adr/README.md', line: 1, code: 'adr_index_absent' },
    ],
  );
});

test('ADR index must cover every numbered file once and match label, filename and heading', async (t) => {
  const root = await fixture(t, {
    'docs/adr/README.md':
      '# 决策索引\n\n| 编号 | 决策 |\n| --- | --- |\n| [D001](0001-synthetic.md) | 一 |\n| [D001](0001-synthetic.md) | 重复 |\n| [D003](0002-second.md) | 错编号 |\n',
    'docs/adr/0002-second.md': '# D009：错误标题\n',
    'docs/adr/0004-omitted.md': '# D004：漏索引\n',
  });
  const issues = await checkDocumentation(root);
  assert.ok(issues.some(({ code }) => code === 'adr_index_duplicate'));
  assert.ok(issues.some(({ code }) => code === 'adr_index_number_mismatch'));
  assert.ok(issues.some(({ code }) => code === 'adr_heading_number_mismatch'));
  assert.ok(issues.some(({ code }) => code === 'adr_index_missing'));
});

test('ADR numbers need not be consecutive and historical version prose does not affect validity', async (t) => {
  const root = await fixture(t, {
    'docs/adr/README.md':
      '# 决策索引\n\n| 编号 | 决策 |\n| --- | --- |\n| [D001](0001-synthetic.md) | 一 |\n| [D049](0049-later.md) | 旧版本 |\n',
    'docs/adr/0049-later.md':
      '# D049：旧版本决定\n\n已被替代。应用 0.10.21，规则 v16，历史格式 v1。\n',
  });
  assert.deepEqual(await checkDocumentation(root), []);
});

test('ADR duplicate filenames for one number and absent index are reported', async (t) => {
  const root = await fixture(t, {
    'docs/adr/0001-another.md': '# D001：另一个决定\n',
  });
  assert.ok((await checkDocumentation(root)).some(({ code }) => code === 'adr_number_duplicate'));
  await rm(join(root, 'docs/adr/README.md'));
  assert.ok((await checkDocumentation(root)).some(({ code }) => code === 'adr_index_absent'));
});
