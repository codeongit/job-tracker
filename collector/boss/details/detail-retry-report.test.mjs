import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDetailRetryReport } from './detail-retry-report.mjs';
import { collectDetailTitleEvidence } from './detail-enrich.mjs';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const tasks = [
  {
    jobId: 'private_job_a',
    attempts: 4,
    status: 'isolated',
    nextRetryAt: null,
    lastError: 'DETAIL_TITLE_NOT_READY',
    lastStage: 'read',
    lastAttemptAt: '2026-11-04T04:41:44.676Z',
  },
  {
    jobId: 'private_job_b',
    attempts: 4,
    status: 'isolated',
    nextRetryAt: null,
    lastError: 'DETAIL_TAB_UNEXPECTED_URL',
    lastStage: 'read',
    lastAttemptAt: '2026-11-04T04:41:44.676Z',
  },
];
const result = {
  counts: { attemptedJobs: 1, accepted: 0, candidates: 0, failures: 0, skipped: 0, remaining: 1 },
  halted: {
    jobId: 'private_job_a',
    code: 'DETAIL_TAB_UNEXPECTED_URL',
    stage: 'read',
    url: 'https://example.test/?private=value',
  },
  observations: [],
  candidates: [],
  failures: [],
  skipped: [],
  remaining: [
    {
      jobId: 'private_job_b',
      detailUrl: 'https://example.test/private',
      company: 'Private company',
    },
  ],
  diagnostics: [
    {
      jobId: 'private_job_a',
      code: 'DETAIL_TAB_UNEXPECTED_URL',
      stage: 'read',
      readCount: 1,
      urlKind: 'other',
      sameCanonicalJob: false,
      queryPresent: true,
      fragmentPresent: false,
      documentReady: false,
      navigationPending: false,
      titlePresent: true,
      titleParsed: false,
      titleStable: false,
      title: 'Private title',
      url: 'https://example.test/private',
    },
  ],
};

test('retry reports preserve prior isolation and safe outcomes without raw job identities or page content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'detail-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await createDetailRetryReport(directory, { accountNamespace: ACCOUNT, tasks });
  assert.match(report.attemptId, /^[a-f0-9-]{36}$/);
  const [beforeName] = await readdir(directory);
  const beforeText = await readFile(join(directory, beforeName), 'utf8');
  const before = JSON.parse(beforeText);
  assert.equal(before.phase, 'prepared');
  assert.deepEqual(
    before.tasks.map(({ attempts, status, lastError }) => ({ attempts, status, lastError })),
    [
      { attempts: 4, status: 'isolated', lastError: 'DETAIL_TITLE_NOT_READY' },
      { attempts: 4, status: 'isolated', lastError: 'DETAIL_TAB_UNEXPECTED_URL' },
    ],
  );
  assert.equal(before.tasks[0].lastAttemptAt, '2026-11-04T04:41:44.676Z');
  assert.match(before.tasks[0].jobDigest, /^[a-f0-9]{64}$/);
  await report.beforeCleanup(result);
  const names = await readdir(directory);
  assert.equal(names.length, 2);
  const afterName = names.find((name) => name !== beforeName);
  const afterText = await readFile(join(directory, afterName), 'utf8');
  const after = JSON.parse(afterText);
  assert.equal(after.phase, 'before_cleanup');
  assert.deepEqual(
    after.targetDigests,
    before.tasks.map(({ jobDigest }) => jobDigest),
  );
  assert.deepEqual(after.remaining, [before.tasks[1].jobDigest]);
  assert.equal(after.halted.jobDigest, before.tasks[0].jobDigest);
  assert.equal(after.halted.code, 'DETAIL_TAB_UNEXPECTED_URL');
  assert.equal(after.diagnostics[0].queryPresent, true);
  for (const secret of [
    'private_job',
    ACCOUNT,
    'Private title',
    'Private company',
    'https:',
    'private=value',
  ])
    assert.equal((beforeText + afterText).includes(secret), false);
  for (const name of names) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  await assert.rejects(report.beforeCleanup(result), { code: 'DETAIL_DIAGNOSTIC_SAVE_FAILED' });
  assert.equal(await readFile(join(directory, afterName), 'utf8'), afterText);
});

test('retry report rejects invalid inputs and symlink directories before creating evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'detail-report-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const options of [
    { accountNamespace: ACCOUNT, tasks: [] },
    { accountNamespace: 'private account text', tasks },
    { accountNamespace: ACCOUNT, tasks: [{ ...tasks[0], lastError: 'private text' }] },
    { accountNamespace: ACCOUNT, tasks: [{ ...tasks[0], attempts: 0 }] },
    { accountNamespace: ACCOUNT, tasks: [tasks[0], tasks[0]] },
  ])
    await assert.rejects(createDetailRetryReport(directory, options), {
      code: 'DETAIL_DIAGNOSTIC_SAVE_FAILED',
    });
  assert.deepEqual(await readdir(directory), []);
  const link = join(directory, 'link');
  await symlink(directory, link);
  await assert.rejects(createDetailRetryReport(link, { accountNamespace: ACCOUNT, tasks }), {
    code: 'DETAIL_DIAGNOSTIC_SAVE_FAILED',
  });
});

test('retry result report refuses unavailable storage and foreign targets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'detail-report-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'file');
  await writeFile(directory, 'not a directory');
  await assert.rejects(createDetailRetryReport(directory, { accountNamespace: ACCOUNT, tasks }), {
    code: 'DETAIL_DIAGNOSTIC_SAVE_FAILED',
  });
  const report = await createDetailRetryReport(root, { accountNamespace: ACCOUNT, tasks });
  await assert.rejects(
    report.beforeCleanup({
      ...result,
      diagnostics: [{ ...result.diagnostics[0], jobId: 'other_job' }],
    }),
    { code: 'DETAIL_DIAGNOSTIC_SAVE_FAILED' },
  );
  await rm(root, { recursive: true });
  await assert.rejects(report.beforeCleanup(result), { code: 'DETAIL_DIAGNOSTIC_SAVE_FAILED' });
});

test('the real collector writes its safe result before closing the owned detail tab', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'detail-report-collector-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await createDetailRetryReport(directory, { accountNamespace: ACCOUNT, tasks });
  let currentUrl;
  let closed = false;
  const collected = await collectDetailTitleEvidence({
    candidates: tasks.map(({ jobId }) => ({
      jobId,
      conversationKey: `conversation-${jobId}`,
      company: 'Private company',
      detailUrl: `https://www.zhipin.com/job_detail/${jobId}.html`,
      jobName: null,
    })),
    adapter: {
      async createOwnedTab({ ownerToken, initialUrl }) {
        currentUrl = initialUrl;
        return { ownerToken, tabId: 'task', windowId: 'browser' };
      },
      async readOwnedTab(handle) {
        return {
          ...handle,
          url: currentUrl,
          title: 'Private unparseable title',
          documentReady: true,
        };
      },
      async navigateOwnedTab(handle, { nextUrl }) {
        currentUrl = nextUrl;
      },
      async closeOwnedTab() {
        const names = await readdir(directory);
        assert.equal(names.filter((name) => name.endsWith('-before-cleanup.json')).length, 1);
        closed = true;
      },
    },
    beforeCleanup: report.beforeCleanup,
    limit: 2,
    maxReads: 2,
    stableReads: 2,
    wait: async () => {},
    now: () => '2026-11-05T02:00:00.000Z',
  });
  assert.equal(closed, true);
  assert.equal(collected.failures.length, 2);
  const afterName = (await readdir(directory)).find((name) =>
    name.endsWith('-before-cleanup.json'),
  );
  const saved = JSON.parse(await readFile(join(directory, afterName), 'utf8'));
  assert.equal(saved.failures.length, 2);
  assert.deepEqual(
    saved.diagnostics.map(({ titleParsed, titleStable }) => ({ titleParsed, titleStable })),
    [
      { titleParsed: false, titleStable: true },
      { titleParsed: false, titleStable: true },
    ],
  );
});
