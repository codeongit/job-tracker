import test from 'node:test';
import assert from 'node:assert/strict';
import { runMerge } from '../scripts/pr-merge.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const args = ['7', '--head', HEAD, '--base', BASE];
const merged = () => ({
  ...pr(),
  state: 'MERGED',
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'UNKNOWN',
  mergedAt: '2026-10-29T16:10:00Z',
  mergeCommit: { oid: MERGE },
});
const pr = () => ({
  number: 7,
  url: 'https://github.com/codeongit/job-tracker/pull/7',
  state: 'OPEN',
  isDraft: false,
  isCrossRepository: false,
  headRefOid: HEAD,
  baseRefName: 'main',
  baseRefOid: BASE,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: '',
  latestReviews: [],
  body: '原有需求和审查结果。',
});
const checks = () =>
  ['push', 'pull_request'].map((event) => ({
    name: 'verify',
    workflow: 'CI',
    event,
    bucket: 'pass',
    state: 'SUCCESS',
  }));
function github(overrides = {}) {
  const calls = [];
  let current = pr();
  const run = (command, argv, input) => {
    calls.push({ command, argv, input });
    if (overrides.run) {
      const answer = overrides.run(command, argv, input, calls);
      if (answer !== undefined) return answer;
    }
    let value;
    if (command === 'gh' && argv[0] === 'pr' && argv[1] === 'view')
      value = overrides.pr ? overrides.pr(calls) : current;
    else if (command === 'gh' && argv[0] === 'pr' && argv[1] === 'checks')
      value = overrides.checks ? overrides.checks(calls) : checks();
    else if (command === 'gh' && argv.includes('repos/codeongit/job-tracker/branches/main'))
      value = { commit: { sha: BASE } };
    else if (command === 'gh' && argv.includes('PUT')) {
      assert.deepEqual(JSON.parse(input), { sha: HEAD, merge_method: 'merge' });
      current = merged();
      value = { merged: true, sha: MERGE };
    } else if (
      command === 'gh' &&
      argv.includes(`repos/codeongit/job-tracker/git/commits/${MERGE}`)
    )
      value = { sha: MERGE, parents: [{ sha: BASE }, { sha: HEAD }] };
    else if (command === 'git' && argv[0] === 'remote')
      return { status: 0, stdout: 'git@github.com:codeongit/job-tracker.git\n' };
    else if (command === 'git' && argv[0] === 'fetch') return { status: 0, stdout: '' };
    else throw new Error(`Unexpected command: ${command} ${argv.join(' ')}`);
    return { status: 0, stdout: JSON.stringify(value) };
  };
  return {
    run,
    calls,
    setPR(value) {
      current = value;
    },
  };
}

test('默认只读核对已指定版本与 CI，不发合并或更新命令', async () => {
  const io = github();
  const result = await runMerge(args, { run: io.run });
  assert.equal(result.status, 'ready');
  assert.equal(result.exitCode, 0);
  assert.equal(result.head, HEAD);
  assert.equal(result.base, BASE);
  assert.ok(io.calls.some(({ argv }) => argv[1] === 'checks'));
  assert.ok(
    io.calls.every(
      ({ command, argv }) => command === 'gh' && !argv.includes('PUT') && !argv.includes('PATCH'),
    ),
  );
});

const blockers = [
  ['PR编号不符', { pr: () => ({ ...pr(), number: 8 }) }],
  ['仓库URL不符', { pr: () => ({ ...pr(), url: 'https://github.com/another/repo/pull/7' }) }],
  ['跨仓PR', { pr: () => ({ ...pr(), isCrossRepository: true }) }],
  ['目标分支不符', { pr: () => ({ ...pr(), baseRefName: 'release' }) }],
  ['PR基线已变', { pr: () => ({ ...pr(), baseRefOid: 'd'.repeat(40) }) }],
  ['草稿', { pr: () => ({ ...pr(), isDraft: true }) }],
  ['关闭未合并', { pr: () => ({ ...pr(), state: 'CLOSED' }) }],
  ['冲突', { pr: () => ({ ...pr(), mergeable: 'CONFLICTING' }) }],
  ['合并状态未知', { pr: () => ({ ...pr(), mergeStateStatus: 'UNKNOWN' }) }],
  ['平台阻断', { pr: () => ({ ...pr(), mergeStateStatus: 'BLOCKED' }) }],
  ['需要审查', { pr: () => ({ ...pr(), reviewDecision: 'REVIEW_REQUIRED' }) }],
  ['新的修改请求', { pr: () => ({ ...pr(), latestReviews: [{ state: 'CHANGES_REQUESTED' }] }) }],
  ['缺少PR检查', { checks: () => checks().slice(0, 1) }],
  [
    'CI明确失败',
    { checks: () => checks().map((c) => ({ ...c, bucket: 'fail', state: 'FAILURE' })) },
  ],
  [
    'CI取消',
    { checks: () => checks().map((c) => ({ ...c, bucket: 'cancel', state: 'CANCELLED' })) },
  ],
  [
    'CI跳过',
    { checks: () => checks().map((c) => ({ ...c, bucket: 'skipping', state: 'SKIPPED' })) },
  ],
  [
    'CI尚未完成',
    { checks: () => checks().map((c) => ({ ...c, bucket: 'pending', state: 'IN_PROGRESS' })) },
  ],
  [
    '其他检查失败',
    { checks: () => [...checks(), { name: 'external', bucket: 'fail', state: 'FAILURE' }] },
  ],
];
for (const [name, overrides] of blockers) {
  test(`${name}时停止且没有合并写入`, async () => {
    const io = github(overrides);
    const result = await runMerge([...args, '--execute'], { run: io.run });
    assert.equal(result.status, 'blocked');
    assert.equal(result.exitCode, 1);
    assert.ok(!io.calls.some(({ argv }) => argv.includes('PUT')));
  });
}

test('CI读取期间head变化时不能沿用前一版本的绿灯', async () => {
  let views = 0;
  const io = github({ pr: () => ({ ...pr(), headRefOid: ++views === 1 ? HEAD : 'd'.repeat(40) }) });
  const result = await runMerge([...args, '--execute'], { run: io.run });
  assert.equal(result.status, 'blocked');
  assert.ok(!io.calls.some(({ argv }) => argv.includes('PUT')));
});

test('只读检查可在给定预算内等到同版本CI完成', async () => {
  let clock = 0,
    queries = 0;
  const io = github({
    checks: () =>
      ++queries === 1
        ? checks().map((c) => ({ ...c, bucket: 'pending', state: 'IN_PROGRESS' }))
        : checks(),
  });
  const result = await runMerge([...args, '--wait', '20'], {
    run: io.run,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result.status, 'ready');
  assert.ok(queries > 1);
  assert.ok(clock > 0 && clock <= 20_000);
});

test('执行只合并预期head，回读结果后刷新引用，不改PR正文或工作树', async () => {
  const io = github();
  const result = await runMerge([...args, '--execute'], { run: io.run });
  assert.equal(result.status, 'merged');
  assert.equal(result.exitCode, 0);
  assert.equal(result.mergeCommit, MERGE);
  assert.equal(result.mergedAt, '2026-10-30 00:10:00 +08:00');
  assert.equal(io.calls.filter(({ argv }) => argv.includes('PUT')).length, 1);
  assert.ok(
    io.calls.some(
      ({ command, argv }) => command === 'git' && argv.join(' ') === 'fetch origin main',
    ),
  );
  assert.ok(
    io.calls.every(
      ({ argv }) =>
        !argv.includes('PATCH') && !argv.includes('checkout') && !argv.includes('reset'),
    ),
  );
});

for (const execute of [false, true]) {
  test(`已合并的同一版本重入只回读${execute ? '并刷新引用' : '，保持只读'}`, async () => {
    const io = github();
    io.setPR(merged());
    const result = await runMerge([...args, ...(execute ? ['--execute'] : [])], { run: io.run });
    assert.equal(result.status, 'merged');
    assert.equal(result.mergeCommit, MERGE);
    assert.ok(!io.calls.some(({ argv }) => argv.includes('PUT')));
    assert.equal(
      io.calls.some(({ command, argv }) => command === 'git' && argv[0] === 'fetch'),
      execute,
    );
  });
}

test('合并请求响应丢失时先回读，确认已合并后不重发', async () => {
  const io = github({
    run(command, argv) {
      if (command === 'gh' && argv.includes('PUT')) {
        io.setPR(merged());
        return { status: 1, stdout: '' };
      }
    },
  });
  const result = await runMerge([...args, '--execute'], { run: io.run });
  assert.equal(result.status, 'merged');
  assert.equal(result.exitCode, 0);
  assert.equal(io.calls.filter(({ argv }) => argv.includes('PUT')).length, 1);
});

test('请求后仍未确认合并时报告未知，不刷新引用或盲目重发', async () => {
  const io = github({
    run(command, argv) {
      if (command === 'gh' && argv.includes('PUT')) return { status: 1, stdout: '' };
    },
  });
  const result = await runMerge([...args, '--execute'], { run: io.run });
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.exitCode, 2);
  assert.equal(io.calls.filter(({ argv }) => argv.includes('PUT')).length, 1);
  assert.ok(!io.calls.some(({ command }) => command === 'git'));
});

test('合并后回读失败时保持未知，保留下一步回查指引', async () => {
  const io = github({
    run(command, argv, _input, calls) {
      if (command === 'gh' && argv[1] === 'view' && calls.some((call) => call.argv.includes('PUT')))
        return { status: 1, stdout: '' };
    },
  });
  const result = await runMerge([...args, '--execute'], { run: io.run });
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.exitCode, 2);
  assert.match(result.message, /回查/);
});

for (const [name, override] of [
  [
    '刷新失败',
    (command, argv) =>
      command === 'git' && argv[0] === 'fetch' ? { status: 1, stdout: '' } : undefined,
  ],
  [
    'origin不符',
    (command, argv) =>
      command === 'git' && argv[0] === 'remote'
        ? { status: 0, stdout: 'git@github.com:another/repo.git' }
        : undefined,
  ],
  [
    '父提交读回失败',
    (command, argv) =>
      command === 'gh' && argv.some((a) => a.includes('/git/commits/'))
        ? { status: 1, stdout: '' }
        : undefined,
  ],
  [
    'base在最后核对后变化',
    (command, argv) =>
      command === 'gh' && argv.some((a) => a.includes('/git/commits/'))
        ? {
            status: 0,
            stdout: JSON.stringify({
              sha: MERGE,
              parents: [{ sha: 'd'.repeat(40) }, { sha: HEAD }],
            }),
          }
        : undefined,
  ],
]) {
  test(`${name}仍保留已合并事实并报告需处理`, async () => {
    const io = github({ run: override });
    const result = await runMerge([...args, '--execute'], { run: io.run });
    assert.equal(result.status, 'merged');
    assert.equal(result.exitCode, 3);
    assert.equal(result.mergeCommit, MERGE);
    assert.ok(result.warnings.length > 0);
    if (name === 'origin不符')
      assert.ok(!io.calls.some(({ command, argv }) => command === 'git' && argv[0] === 'fetch'));
  });
}

test('无效或重复参数在任何外部调用前拒绝', async () => {
  for (const argv of [
    [],
    ['0', '--head', HEAD, '--base', BASE],
    ['7', '--head', 'abc', '--base', BASE],
    [...args, '--execute', '--execute'],
    [...args, '--admin'],
    [...args, '--wait', '601'],
    [...args, '--wait'],
  ]) {
    const result = await runMerge(argv, {
      run() {
        assert.fail('不应发出外部调用');
      },
    });
    assert.equal(result.status, 'blocked');
  }
});

test('main实际分支已前进时拒绝合并，即使PR缓存仍是旧base', async () => {
  const io = github({
    run(command, argv) {
      if (command === 'gh' && argv.includes('repos/codeongit/job-tracker/branches/main'))
        return { status: 0, stdout: JSON.stringify({ commit: { sha: 'd'.repeat(40) } }) };
    },
  });
  assert.equal((await runMerge([...args, '--execute'], { run: io.run })).status, 'blocked');
  assert.ok(!io.calls.some(({ argv }) => argv.includes('PUT')));
});

test('等待CI期间有新的审查阻断时停止', async () => {
  let views = 0,
    clock = 0;
  const io = github({
    pr: () => ({ ...pr(), reviewDecision: ++views > 2 ? 'CHANGES_REQUESTED' : '' }),
    checks: () => checks().map((c) => ({ ...c, bucket: 'pending', state: 'IN_PROGRESS' })),
  });
  const result = await runMerge([...args, '--execute', '--wait', '20'], {
    run: io.run,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result.status, 'blocked');
  assert.ok(!io.calls.some(({ argv }) => argv.includes('PUT')));
});

test('检查尚未建立时可等待，不能把空结果当通过', async () => {
  let queries = 0,
    clock = 0;
  const io = github({
    run(command, argv) {
      if (command === 'gh' && argv[1] === 'checks' && ++queries === 1)
        return { status: 1, stdout: '' };
    },
  });
  const result = await runMerge([...args, '--wait', '10'], {
    run: io.run,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(clock, 5000);
});

test('持续pending在预算结束后退出且没有写入', async () => {
  let clock = 0;
  const io = github({
    run(command, argv) {
      if (command === 'gh' && argv[1] === 'checks')
        return {
          status: 8,
          stdout: JSON.stringify(
            checks().map((c) => ({ ...c, bucket: 'pending', state: 'IN_PROGRESS' })),
          ),
        };
    },
  });
  const result = await runMerge([...args, '--execute', '--wait', '10'], {
    run: io.run,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(clock, 10000);
  assert.ok(!io.calls.some(({ argv }) => argv.includes('PUT')));
});

test('已合并PR的head不符时不把它当作本次结果或刷新本地引用', async () => {
  const io = github({ pr: () => ({ ...merged(), headRefOid: 'd'.repeat(40) }) });
  assert.equal((await runMerge([...args, '--execute'], { run: io.run })).status, 'blocked');
  assert.ok(!io.calls.some(({ command }) => command === 'git'));
});

test('最后核对后head变化由合并请求的sha条件拒绝，不能改为合并新head', async () => {
  const nextHead = 'd'.repeat(40);
  let applied = 0;
  const io = github({
    run(command, argv, input) {
      if (command === 'gh' && argv.includes('PUT')) {
        io.setPR({ ...pr(), headRefOid: nextHead });
        if (JSON.parse(input).sha === nextHead) {
          applied++;
          io.setPR(merged());
          return { status: 0, stdout: '{}' };
        }
        return { status: 1, stdout: '' };
      }
    },
  });
  const result = await runMerge([...args, '--execute'], { run: io.run });
  assert.equal(applied, 0);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(io.calls.filter(({ argv }) => argv.includes('PUT')).length, 1);
});

for (const output of ['not JSON', '{}', 'null']) {
  test(`CI异常返回 ${output} 时不会合并`, async () => {
    const io = github({
      run(command, argv) {
        if (command === 'gh' && argv[1] === 'checks') return { status: 0, stdout: output };
      },
    });
    assert.equal((await runMerge([...args, '--execute'], { run: io.run })).status, 'blocked');
    assert.ok(!io.calls.some(({ argv }) => argv.includes('PUT')));
  });
}
