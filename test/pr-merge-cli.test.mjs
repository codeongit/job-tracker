import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const command = fileURLToPath(new URL('../scripts/pr-merge.mjs', import.meta.url));
const head = '1111111111111111111111111111111111111111';
const base = '2222222222222222222222222222222222222222';
const mergeCommit = '3333333333333333333333333333333333333333';

function remoteWrites(calls) {
  return calls.filter(({ tool, args }) => {
    if (tool !== 'gh') return false;
    if (args[0] === 'pr') return !['view', 'checks'].includes(args[1]);
    const methodFlag = args.findIndex((arg) => ['--method', '-X'].includes(arg));
    return (
      args[0] === 'api' &&
      (args.includes('--input') ||
        (methodFlag !== -1 && !['GET', 'HEAD'].includes(args[methodFlag + 1])))
    );
  });
}

// Only the external executables are replaced: CLI parsing, process I/O, JSON
// handling and result exit codes all run through the production entry point.
async function cliFixture(t, scenario = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-pr-merge-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, 'calls.jsonl');
  const state = join(root, 'merged');
  await writeFile(log, '');
  const executable = `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const input = args.includes('--input') ? readFileSync(0, 'utf8') : '';
appendFileSync(process.env.MERGE_TEST_LOG, JSON.stringify({ tool, args, input }) + '\\n');
const head = '${head}';
const base = '${base}';
const mergeCommit = '${mergeCommit}';
const merged = existsSync(process.env.MERGE_TEST_STATE);
const scenario = process.env.MERGE_TEST_SCENARIO;
const output = (value, status = 0) => { process.stdout.write(JSON.stringify(value)); process.exit(status); };
if (tool === 'git') {
  if (args.join(' ') === 'remote get-url origin') {
    process.stdout.write('git@github.com:codeongit/job-tracker.git\\n');
    process.exit(0);
  }
  if (args.join(' ') === 'fetch origin main') process.exit(scenario === 'lost-response-fetch-failed' ? 1 : 0);
}
if (tool === 'gh' && args[0] === 'pr' && args[2] === '412' &&
    args[args.indexOf('--repo') + 1] === 'github.com/codeongit/job-tracker') {
  if (args[1] === 'view') output({
    number: 412, url: 'https://github.com/codeongit/job-tracker/pull/412',
    state: merged ? 'MERGED' : 'OPEN', isDraft: false, isCrossRepository: false,
    headRefOid: head, baseRefName: 'main', baseRefOid: base,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', latestReviews: [],
    mergedAt: merged ? '2026-10-30T01:00:00Z' : null,
    mergeCommit: merged ? { oid: mergeCommit } : null,
  });
  if (args[1] === 'checks') output([
    { name: 'verify', state: scenario === 'ci-failed' ? 'FAILURE' : 'SUCCESS',
      bucket: scenario === 'ci-failed' ? 'fail' : 'pass', workflow: 'CI', event: 'pull_request' },
    { name: 'verify', state: 'SUCCESS', bucket: 'pass', workflow: 'CI', event: 'push' },
  ], scenario === 'ci-failed' ? 1 : 0);
}
if (tool === 'gh' && args[0] === 'api' &&
    args[args.indexOf('--hostname') + 1] === 'github.com') {
  const endpoint = args.find((arg) => arg.startsWith('repos/'));
  const method = args[args.indexOf('--method') + 1];
  if (endpoint === 'repos/codeongit/job-tracker/branches/main') output({ commit: { sha: base } });
  if (endpoint === 'repos/codeongit/job-tracker/pulls/412/merge' && method === 'PUT') {
    writeFileSync(process.env.MERGE_TEST_STATE, 'merged');
    if (scenario === 'lost-response-fetch-failed') {
      process.stderr.write('Synthetic lost merge response');
      process.exit(1);
    }
    output({ merged: true, sha: mergeCommit, message: 'Pull Request successfully merged' });
  }
  if (endpoint === 'repos/codeongit/job-tracker/git/commits/' + mergeCommit)
    output({ sha: mergeCommit, parents: [{ sha: base }, { sha: head }] });
}
process.stderr.write('Unexpected synthetic command: ' + JSON.stringify({ tool, args }));
process.exit(91);
`;
  for (const tool of ['gh', 'git']) await writeFile(join(root, tool), executable, { mode: 0o700 });
  return {
    run: (...args) =>
      spawnSync(process.execPath, [command, '412', '--head', head, '--base', base, ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        // No real gh/git can be reached through this PATH.
        env: {
          PATH: root,
          MERGE_TEST_LOG: log,
          MERGE_TEST_STATE: state,
          MERGE_TEST_SCENARIO: scenario,
        },
      }),
    calls: async () =>
      (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}

test('PR merge CLI sends the reviewed head once and reports a confirmed merge', async (t) => {
  const fixture = await cliFixture(t);
  const result = fixture.run('--execute');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'merged');
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.pr, 412);
  assert.equal(summary.head, head);
  assert.equal(summary.base, base);
  assert.equal(summary.mergeCommit, mergeCommit);
  const calls = await fixture.calls();
  const writes = remoteWrites(calls);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].args.includes('repos/codeongit/job-tracker/pulls/412/merge'));
  assert.equal(writes[0].args[writes[0].args.indexOf('--method') + 1], 'PUT');
  assert.equal(writes[0].args[writes[0].args.indexOf('--input') + 1], '-');
  assert.deepEqual(JSON.parse(writes[0].input), { sha: head, merge_method: 'merge' });
  assert.ok(
    calls.some(({ tool, args }) => tool === 'git' && args.join(' ') === 'fetch origin main'),
  );
});

test('PR merge CLI blocks a failing CI result before any remote write', async (t) => {
  const fixture = await cliFixture(t, 'ci-failed');
  const result = fixture.run('--execute');
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.exitCode, 1);
  assert.match(summary.message, /CI/);
  const calls = await fixture.calls();
  assert.equal(remoteWrites(calls).length, 0);
  assert.equal(calls.filter(({ tool, args }) => tool === 'git' && args[0] === 'fetch').length, 0);
});

test('PR merge CLI preserves a confirmed merge after a lost response and failed local fetch', async (t) => {
  const fixture = await cliFixture(t, 'lost-response-fetch-failed');
  const result = fixture.run('--execute');
  assert.equal(result.status, 3, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'merged');
  assert.equal(summary.exitCode, 3);
  assert.equal(summary.mergeCommit, mergeCommit);
  assert.ok(summary.warnings.some((warning) => /fetch|刷新/.test(warning)));
  const calls = await fixture.calls();
  const writes = remoteWrites(calls);
  assert.equal(writes.length, 1, 'An uncertain merge response must never trigger a second write');
  assert.deepEqual(JSON.parse(writes[0].input), { sha: head, merge_method: 'merge' });
  assert.ok(
    calls.some(({ tool, args }) => tool === 'git' && args.join(' ') === 'fetch origin main'),
  );
});
