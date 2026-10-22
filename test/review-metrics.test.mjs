import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { runReviewMetrics } from '../scripts/review-metrics.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'review-metrics-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.agents/skills/code-review'), { recursive: true });
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, '.agents/skills/code-review/SKILL.md'), '合成审查技能');
  await writeFile(join(root, 'docs/agents/change-workflow.md'), '合成变更流程');
  let time = '2026-10-22T00:00:00Z';
  let serial = 0;
  const lines = [];
  return {
    root,
    lines,
    time(value) {
      time = value;
    },
    run: (args) =>
      runReviewMetrics(args, {
        root,
        now: () => new Date(time),
        write: (line) => lines.push(line),
      }),
    async input(value) {
      const path = join(root, `input-${serial++}.json`);
      await writeFile(path, JSON.stringify(value));
      return path;
    },
  };
}

const report = (findings = []) => ({
  snapshot: { base: 'commit-base', target: 'sha256:synthetic-snapshot', scope: '合成文档差异' },
  report: '## 规范审查\n已核对合成材料。\n## 规格审查\n已核对原始目标。',
  findings,
});

test('开始与首次报告持久保存，重复结束保持首次报告与五分钟耗时', async (t) => {
  const w = await workspace(t);
  const started = await w.run(['start', '--case', '合成案例', '--type', 'docs']);
  assert.match(started.record.rules.skill, /^[a-f0-9]{64}$/);
  assert.equal(started.record.started_at, '2026-10-22T00:00:00.000Z');
  const input = await w.input(report());
  w.time('2026-10-22T00:05:00Z');
  const finished = await w.run(['finish', started.record.id, '--input', input]);
  assert.equal(finished.summary.elapsed_minutes, 5);
  w.time('2026-10-22T01:00:00Z');
  const again = await w.run(['finish', started.record.id, '--input', input]);
  assert.deepEqual(again.record, finished.record);
  const saved = JSON.parse(
    await readFile(join(rootPath(w, started.record.id), 'record.json'), 'utf8'),
  );
  assert.deepEqual(saved, finished.record);
  assert.equal(saved.first_report.report, report().report);
});

const rootPath = (w, id) => join(w.root, '.local/reviews', id);

const finding = (id, verdict = 'pending') => ({
  id,
  category: 'defect',
  summary: `合成问题 ${id}`,
  verdict,
  evidence: verdict === 'pending' ? '' : '合成复现记录',
});

test('双轴同编号只计一次，反馈更新判定而遗漏与首次发现分开', async (t) => {
  const w = await workspace(t);
  const { record: start } = await w.run(['start', '--case', '反馈案例', '--type', 'code']);
  const initial = report([
    finding('F1'),
    finding('F1'),
    finding('F2'),
    finding('F3', 'valid'),
    { id: 'S1', category: 'suggestion', summary: '可选改名' },
    { id: 'O1', category: 'out_of_scope', summary: '范围外既有问题' },
  ]);
  w.time('2026-10-22T00:04:00Z');
  const done = await w.run(['finish', start.id, '--input', await w.input(initial)]);
  assert.equal(done.summary.valid, 1);
  assert.equal(done.summary.pending, 2);
  assert.equal(done.summary.suggestions, 1);
  assert.equal(done.summary.out_of_scope, 1);
  assert.equal(done.summary.followup, null);
  w.time('2026-10-22T01:00:00Z');
  const feedback = {
    findings: [
      { id: 'F1', verdict: 'valid', evidence: '独立复现，已修复' },
      { id: 'F2', verdict: 'false_alarm', evidence: '契约明确允许该行为' },
    ],
    misses: [
      {
        id: 'M1',
        summary: '原版本遗漏',
        evidence: '基线复现与范围核对',
        present_in_reviewed_version: true,
        in_scope: true,
      },
    ],
  };
  const changed = await w.run(['feedback', start.id, '--input', await w.input(feedback)]);
  assert.deepEqual(changed.record.first_report, done.record.first_report);
  assert.equal(changed.summary.valid, 2);
  assert.equal(changed.summary.false_alarm, 1);
  assert.equal(changed.summary.pending, 0);
  assert.equal(changed.summary.misses, 1);
  assert.equal(changed.summary.false_alarm_ratio, 1 / 3);
  assert.equal(changed.summary.elapsed_minutes, 4);
  assert.equal(changed.summary.followup, null);
  const duplicate = await w.run(['feedback', start.id, '--input', await w.input(feedback)]);
  assert.deepEqual(duplicate.record, changed.record);
  const checked = await w.run([
    'feedback',
    start.id,
    '--input',
    await w.input({ followup: { scope: '本次约定的合成场景', evidence: '独立复核记录' } }),
  ]);
  assert.equal(checked.summary.followup.at, '2026-10-22T01:00:00.000Z');
  assert.match(w.lines.at(-1), /截至.*复核范围/);
});

test('统计合并分子分母，排除未完成和异常耗时，复查单独分组', async (t) => {
  const w = await workspace(t);
  const ids = [];
  for (const [index, minute] of [2, 4, 6, 10, -1].entries()) {
    w.time('2026-10-22T00:00:00Z');
    const { record } = await w.run(['start', '--case', `案例${index}`, '--type', 'code']);
    ids.push(record.id);
    const findings =
      index === 0
        ? [
            ...Array.from({ length: 9 }, (_, i) => finding(`V${i}`, 'valid')),
            finding('F1', 'false_alarm'),
          ]
        : index === 1
          ? [finding('F2', 'false_alarm')]
          : [];
    w.time(new Date(Date.parse('2026-10-22T00:00:00Z') + minute * 60000).toISOString());
    await w.run(['finish', record.id, '--input', await w.input(report(findings))]);
    if (index === 0) {
      const beforeFive = await w.run(['stats']);
      assert.equal(beforeFive.groups[0].aggregate, null);
    }
  }
  await w.run(['start', '--case', '未完成', '--type', 'code']);
  const { record: recheck } = await w.run([
    'start',
    '--case',
    '修复后复查',
    '--type',
    'code',
    '--parent',
    ids[0],
  ]);
  await w.run(['finish', recheck.id, '--input', await w.input(report())]);
  const result = await w.run(['stats']);
  assert.equal(result.records.length, 7);
  assert.equal(result.groups.length, 2);
  const first = result.groups.find((group) => group.phase === 'first');
  assert.equal(first.completed, 5);
  assert.equal(first.total, 6);
  assert.equal(first.timed, 4);
  assert.equal(first.aggregate.median_minutes, 5);
  assert.equal(first.aggregate.false_alarm_ratio, 2 / 11);
  assert.equal(first.aggregate.valid, 9);
  assert.equal(first.aggregate.false_alarm, 2);
  const abnormal = result.records.find(({ record }) => record.id === ids[4]);
  assert.equal(abnormal.summary.timing_status, 'invalid');
  assert.equal(result.groups.find((group) => group.phase === 'recheck').aggregate, null);
});

test('无效输入、未确认的遗漏及未知持久格式不会覆盖旧记录，坏记录明确报错', async (t) => {
  const w = await workspace(t);
  const { record } = await w.run(['start', '--case', '错误输入', '--type', 'docs']);
  const path = join(rootPath(w, record.id), 'record.json');
  const original = await readFile(path, 'utf8');
  for (const invalid of [
    { ...report(), unexpected: 1 },
    report([finding('F1', 'valid'), { ...finding('F1'), summary: '冲突根因' }]),
    report([{ ...finding('F1', 'valid'), evidence: '' }]),
  ]) {
    await assert.rejects(w.run(['finish', record.id, '--input', await w.input(invalid)]));
    assert.equal(await readFile(path, 'utf8'), original);
  }
  await w.run(['finish', record.id, '--input', await w.input(report([finding('F1')]))]);
  const completed = await readFile(path, 'utf8');
  for (const invalid of [
    { findings: [{ id: 'unknown', verdict: 'valid', evidence: '证据' }] },
    {
      misses: [
        {
          id: 'M1',
          summary: '新版本回归',
          evidence: '证据',
          present_in_reviewed_version: false,
          in_scope: true,
        },
      ],
    },
    {
      misses: [
        {
          id: 'M1',
          summary: '范围外',
          evidence: '证据',
          present_in_reviewed_version: true,
          in_scope: false,
        },
      ],
    },
    { findings: null },
  ]) {
    await assert.rejects(w.run(['feedback', record.id, '--input', await w.input(invalid)]));
    assert.equal(await readFile(path, 'utf8'), completed);
  }
  for (const corrupt of [
    { ...JSON.parse(completed), schema_version: 2 },
    { ...JSON.parse(completed), unknown: '未来字段' },
  ]) {
    await writeFile(path, JSON.stringify(corrupt));
    await assert.rejects(w.run(['stats']), /版本|未知字段/);
    await assert.rejects(
      w.run([
        'feedback',
        record.id,
        '--input',
        await w.input({ followup: { scope: '范围', evidence: '证据' } }),
      ]),
    );
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), corrupt);
  }
  await writeFile(path, '{bad');
  await assert.rejects(w.run(['stats']), /无法读取有效 JSON/);
});

test('旧记录迁移保留原始证据和未知时间，重复导入不重复计数或冒认技能版本', async (t) => {
  const w = await workspace(t);
  for (const [index, duration] of [null, 7.9, 2.3].entries()) {
    const source = join(w.root, `legacy-${index}`);
    await mkdir(join(source, 'review/docs'), { recursive: true });
    await mkdir(join(source, 'baseline/docs'), { recursive: true });
    await mkdir(join(source, 'python-deps'), { recursive: true });
    await writeFile(join(source, 'python-deps/ignored.txt'), '不得迁入');
    const content = `合成受审材料${index}`;
    await writeFile(join(source, 'review/docs/example.md'), content);
    await writeFile(join(source, 'baseline/docs/example.md'), '合成基线');
    const manifest = { 'docs/example.md': createHash('sha256').update(content).digest('hex') };
    const original = {
      case_version: `历史案例${index}`,
      confirmed_valid: 0,
      confirmed_false_alarm: 0,
      unresolved: 0,
      later_known_misses: 0,
      elapsed_minutes: duration,
      ...(index === 1 ? { first_consolidated_report_utc: '2026-10-21T00:07:56Z' } : {}),
    };
    await writeFile(join(source, 'review-result.json'), JSON.stringify(original));
    await writeFile(join(source, 'review-manifest.json'), JSON.stringify(manifest));
    await writeFile(join(source, 'review.diff'), '合成差异');
    if (index > 0)
      await writeFile(
        join(source, 'started.json'),
        JSON.stringify({ review_started_utc: '2026-10-21T00:00:00Z' }),
      );
    const args = ['import-legacy', '--source', source, '--case', `旧案例${index}`];
    const imported = await w.run(args);
    const repeated = await w.run(args);
    assert.deepEqual(repeated.record, imported.record);
    assert.equal(imported.summary.elapsed_minutes, duration);
    assert.equal(imported.summary.timing_status, duration === null ? 'missing' : 'legacy');
    assert.deepEqual(imported.record.rules, { skill: null, workflow: null });
    assert.equal(imported.record.first_report_at, index === 1 ? '2026-10-21T00:07:56Z' : null);
    assert.equal(imported.summary.followup, null);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(rootPath(w, imported.record.id), 'legacy/review-result.json'), 'utf8'),
      ),
      original,
    );
    await assert.rejects(
      readFile(join(rootPath(w, imported.record.id), 'legacy/python-deps/ignored.txt')),
      { code: 'ENOENT' },
    );
  }
  const result = await w.run(['stats']);
  assert.equal(result.records.length, 3);
  assert.equal(result.groups.length, 3);
  assert.ok(result.groups.every((group) => group.aggregate === null));
  assert.equal(
    result.groups.reduce((sum, group) => sum + group.timed, 0),
    2,
  );
  assert.ok(result.records.every(({ summary }) => summary.false_alarm_ratio === null));
});

test('五条全零且时间缺失时显示无法计算，规则版本变化不会混入同组', async (t) => {
  const w = await workspace(t);
  for (let i = 0; i < 5; i++) {
    const { record } = await w.run(['start', '--case', `无发现${i}`, '--type', 'docs']);
    const finished = await w.run(['finish', record.id, '--input', await w.input(report())]);
    // Simulate unavailable timestamps in an otherwise preserved report.
    await writeFile(
      join(rootPath(w, record.id), 'record.json'),
      JSON.stringify({ ...finished.record, started_at: null, first_report_at: null }),
    );
  }
  await writeFile(join(w.root, '.agents/skills/code-review/SKILL.md'), '新技能版本');
  await w.run(['start', '--case', '新版未完成', '--type', 'docs']);
  const result = await w.run(['stats']);
  const aggregate = result.groups.find((group) => group.completed === 5).aggregate;
  assert.equal(aggregate.false_alarm_ratio, null);
  assert.equal(aggregate.median_minutes, null);
  assert.equal(result.groups.length, 2);
  assert.ok(w.lines.some((line) => line.includes('无法计算（0/0）')));
  assert.ok(w.lines.some((line) => line.includes('首报经过时间中位数 无法取得')));
});

test('实际命令入口提供中文帮助和明确的错误退出码', () => {
  const path = fileURLToPath(new URL('../scripts/review-metrics.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [path, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /首次报告/);
  assert.match(help.stdout, /present_in_reviewed_version/);
  const bad = spawnSync(process.execPath, [path, 'unknown'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /审查统计失败/);
});

test('独立生成的相同 JSON 字段顺序不影响去重、首报或反馈幂等', async (t) => {
  const w = await workspace(t);
  const reorder = (object) => Object.fromEntries(Object.entries(object).reverse());
  const { record } = await w.run(['start', '--case', '独立双轴材料', '--type', 'code']);
  const initial = report([finding('F1'), reorder(finding('F1'))]);
  const first = await w.run(['finish', record.id, '--input', await w.input(initial)]);
  assert.equal(first.summary.pending, 1);
  const equivalent = reorder({
    ...report([reorder(finding('F1'))]),
    snapshot: reorder(initial.snapshot),
  });
  const again = await w.run(['finish', record.id, '--input', await w.input(equivalent)]);
  assert.deepEqual(again.record, first.record);
  const update = { id: 'F1', verdict: 'valid', evidence: '独立证据' };
  const changed = await w.run([
    'feedback',
    record.id,
    '--input',
    await w.input({ findings: [update] }),
  ]);
  const repeated = await w.run([
    'feedback',
    record.id,
    '--input',
    await w.input({ findings: [reorder(update)] }),
  ]);
  assert.deepEqual(repeated.record, changed.record);
});

test('开始记录的中途写入失败不留下可见残片，已有记录仍能汇总', async (t) => {
  const w = await workspace(t);
  const { record } = await w.run(['start', '--case', '已有记录', '--type', 'docs']);
  await w.run(['finish', record.id, '--input', await w.input(report())]);
  const original = fs.writeFile;
  const fault = t.mock.method(fs, 'writeFile', async (path, ...args) => {
    if (String(path).endsWith('/rules/change-workflow.md')) {
      throw Object.assign(new Error('合成磁盘故障'), { code: 'EIO' });
    }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(w.run(['start', '--case', '失败的新记录', '--type', 'docs']), {
      code: 'EIO',
    });
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
  }
  const result = await w.run(['stats']);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].record.id, record.id);
  await w.run(['start', '--case', '恢复后', '--type', 'docs']);
  assert.equal((await w.run(['stats'])).records.length, 2);
});
