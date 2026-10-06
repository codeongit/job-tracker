import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBossDetailTitle } from '../dist/boss-detail-title.js';

test('complete quoted and observed SEO titles retain their explicit job and employer', () => {
  const titles = [
    '「示例研发负责人招聘」_示例科技招聘-BOSS直聘',
    '示例研发负责人怎么样_示例科技2026年示例研发负责人前景怎么样-BOSS直聘',
    '示例 架构岗位招聘工资_示例科技2031年示例 架构岗位工资待遇-BOSS直聘',
    '示例研发负责人就业前景_示例科技2026年示例研发负责人招聘工资-BOSS直聘',
    '示例研发负责人工作内容_示例科技2026年示例研发负责人工作要求-BOSS直聘',
    '「什么是示例研发负责人」示例科技2026年示例研发负责人岗位职责-BOSS直聘',
  ];
  assert.deepEqual(parseBossDetailTitle(titles[0]), {
    name: '示例研发负责人',
    company: '示例科技',
  });
  assert.deepEqual(parseBossDetailTitle(titles[1]), {
    name: '示例研发负责人',
    company: '示例科技',
  });
  assert.deepEqual(parseBossDetailTitle(titles[2]), { name: '示例 架构岗位', company: '示例科技' });
  for (const title of titles.slice(3))
    assert.deepEqual(parseBossDetailTitle(title), { name: '示例研发负责人', company: '示例科技' });
});

test('SEO title repetition, year boundary and full suffix must match without guessing', () => {
  for (const title of [
    '示例研发负责人怎么样_示例科技2026年另一岗位前景怎么样-BOSS直聘',
    '示例 架构岗位招聘工资_示例科技2026年示例架构岗位工资待遇-BOSS直聘',
    '示例岗位就业前景_示例科技2026年另一岗位招聘工资-BOSS直聘',
    '示例岗位工作内容_示例科技2026年另一岗位工作要求-BOSS直聘',
    '「什么是示例岗位」示例科技2026年另一岗位岗位职责-BOSS直聘',
    '什么是示例岗位_示例科技2026年示例岗位岗位职责-BOSS直聘',
    '示例岗位怎么样_示例科技026年示例岗位前景怎么样-BOSS直聘',
    '示例岗位怎么样_示例科技20260年示例岗位前景怎么样-BOSS直聘',
    '示例岗位怎么样_示例科技2026年示例岗位前景怎么样',
    '示例岗位招聘工资_示例科技2026年示例岗位工资待遇-其他网站',
    '示例岗位怎么样_2026年示例岗位前景怎么样-BOSS直聘',
    '怎么样_示例科技2026年前景怎么样-BOSS直聘',
    '「示例岗位怎么样_示例科技2026年示例岗位前景怎么样-BOSS直聘」',
  ])
    assert.equal(parseBossDetailTitle(title), null, title);
});

test('partial, generic, verification and malformed titles remain unknown', () => {
  for (const title of [
    null,
    42,
    '',
    'BOSS直聘',
    '安全验证',
    '验证码',
    '职位已关闭',
    '示例岗位_示例科技',
    '「招聘」_示例科技招聘-BOSS直聘',
    '「示例岗位招聘」_招聘-BOSS直聘',
    '「示例\n岗位招聘」_示例科技招聘-BOSS直聘',
    '「示例\u0000岗位招聘」_示例科技招聘-BOSS直聘',
    `「${'x'.repeat(301)}招聘」_示例科技招聘-BOSS直聘`,
    `「示例岗位招聘」_${'x'.repeat(301)}招聘-BOSS直聘`,
    'x'.repeat(1001),
  ])
    assert.equal(parseBossDetailTitle(title), null);
});
