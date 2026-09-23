import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderJobs, writePrivateMarkdown } from './export-jobs.mjs';
import { compareLoadedSnapshotsV2 } from './model-v2.mjs';

const at = (minute) => `2026-09-18T10:${String(minute).padStart(2, '0')}:00.000Z`;
const url = (id) => `https://www.zhipin.com/job_detail/${id}.html`;
const job = (id, confirmation = 'pending_user') => ({
  name: `Synthetic role ${id}`,
  detailUrl: url(id),
  source: 'selected_chat_card',
  detailUrlConfirmation: confirmation,
});
const row = (key, overrides = {}) => ({
  key,
  identityConfidence: 'dom',
  contact: `Synthetic contact ${key}`,
  company: `Synthetic company ${key}`,
  title: 'SECRET_RECRUITER_TITLE',
  preview: 'SECRET_CHAT_PREVIEW',
  timeLabel: 'SECRET_CHAT_TIME',
  unread: 7,
  outgoingReceipt: { status: 'read', label: '[已读]', source: 'list_receipt_label' },
  ...overrides,
});
const envelope = (records) => ({
  version: 1,
  snapshot: {
    capturedAt: at(0),
    scope: 'loaded-chat-list',
    records,
    coverage: { loadedRows: records.length, truncated: false },
  },
  state: { records: [row('historical-only', { company: 'SECRET_HISTORICAL_COMPANY' })] },
  report: { changes: [{ private: 'SECRET_REPORT_CONTENT' }] },
});
const evidence = (record, observedAt = at(3)) => ({
  key: record.key,
  company: record.company,
  job: structuredClone(record.job),
  observedAt,
  evidence: { private: 'SECRET_EVIDENCE_CONTENT' },
});

test('renders the current baseline job fields and keeps confirmations local to each row', () => {
  const records = [row('a', { job: job('a', 'confirmed_user') }), row('b', { job: job('b') })];
  const value = envelope(records);
  value.jobEnrichments = records.map((record) => evidence(record));
  const markdown = renderJobs(value);
  assert.match(markdown, /当前基线共 2 条会话/);
  assert.match(markdown, /已由用户确认的链接 1 条/);
  assert.match(markdown, /待逐条人工确认的链接 1 条/);
  const lines = markdown.split('\n');
  const confirmed = lines.find((line) => line.includes('Synthetic company a'));
  const pending = lines.find((line) => line.includes('Synthetic company b'));
  assert.ok(confirmed.includes('用户已确认（仅本条）'));
  assert.ok(pending.includes('页面已提取，未逐条人工确认'));
  assert.ok(!pending.includes('用户已确认'));
  assert.ok(confirmed.includes(`[查看岗位](${url('a')})`));
  assert.ok(!markdown.includes('SECRET_'));
});

test('missing job fields stay pending and never fall back to the recruiter title', () => {
  const value = envelope([
    row('a'),
    row('b', { job: { name: 'Synthetic partial role', detailUrl: null, source: 'chat_list' } }),
  ]);
  const markdown = renderJobs(value);
  const missing = markdown.split('\n').find((line) => line.includes('Synthetic company a'));
  const partial = markdown.split('\n').find((line) => line.includes('Synthetic company b'));
  assert.ok(missing.endsWith('| 待补 | 待补 | 待补 | 待补 |'));
  assert.ok(partial.includes('| Synthetic partial role | 待补 | 待补 | 未记录独立时间 |'));
  assert.ok(!markdown.includes('SECRET_RECRUITER_TITLE'));
});

test('capture time and individually observed job time are kept distinct', () => {
  const record = row('a', { job: job('a') });
  const value = envelope([record]);
  value.jobEnrichments = [evidence(record, at(8))];
  const markdown = renderJobs(value);
  assert.ok(markdown.includes(`capturedAt）：\`${at(0)}\``));
  const line = markdown.split('\n').find((item) => item.includes('Synthetic company a'));
  assert.ok(line.includes(at(8)));
  assert.ok(!line.includes(at(0)));
  assert.ok(markdown.includes('不代表全部岗位在同一时刻完成观察'));
});

test('stale or mismatched job evidence cannot supply a current row observation time', () => {
  const record = row('a', { job: job('a') });
  const entries = [
    { ...evidence(record), key: 'other' },
    { ...evidence(record), company: 'Other synthetic company' },
    { ...evidence(record), job: job('different') },
  ];
  const value = envelope([record]);
  value.jobEnrichments = entries;
  const line = renderJobs(value)
    .split('\n')
    .find((item) => item.includes('Synthetic company a'));
  assert.ok(line.includes('未记录独立时间'));
  assert.ok(!line.includes(at(3)));
  value.jobEnrichments = [evidence(record), evidence(record, at(4))];
  assert.ok(renderJobs(value).includes('观测时间待核验'));
});

test('known links without a recorded confirmation status do not become confirmed or pending implicitly', () => {
  const observed = job('a');
  delete observed.detailUrlConfirmation;
  const markdown = renderJobs(envelope([row('a', { job: observed })]));
  const line = markdown.split('\n').find((item) => item.includes('Synthetic company a'));
  assert.ok(line.includes('确认状态待补'));
});

test('Markdown table values are escaped without exposing raw markup or line breaks', () => {
  const value = envelope([
    row('a', {
      company: 'Synthetic|Company\n<script>alert(1)</script>',
      contact: '[click](https://example.invalid) *text*',
      job: { ...job('a'), name: 'Role|Name\nwith `code`' },
    }),
  ]);
  const markdown = renderJobs(value);
  assert.ok(markdown.includes('Synthetic\\|Company &lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(markdown.includes('\\[click\\](https://example.invalid) \\*text\\*'));
  assert.ok(markdown.includes('Role\\|Name with \\`code\\`'));
  assert.ok(!markdown.includes('<script>'));
});

test('rendering is deterministic and does not change or alias the input', () => {
  const record = row('a', { job: job('a') });
  const value = envelope([record]);
  value.jobEnrichments = [evidence(record)];
  const original = structuredClone(value);
  assert.equal(renderJobs(value), renderJobs(value));
  assert.deepEqual(value, original);
});

test('unsafe or malformed links fail validation instead of being rendered', () => {
  for (const detailUrl of [
    'javascript:alert(1)',
    'https://evil.example/job_detail/a.html',
    `${url('a')}?tracking=1`,
  ]) {
    assert.throws(
      () => renderJobs(envelope([row('a', { job: { ...job('a'), detailUrl } })])),
      TypeError,
    );
  }
  assert.throws(() => renderJobs(null), TypeError);
  assert.throws(() => renderJobs({ ...envelope([]), jobEnrichments: {} }), TypeError);
});

test('renders a resolver-backed v2 view with independent evidence and candidate statuses', () => {
  const input = { version: 2, updatedAt: at(9), private: 'SECRET_V2_STATE' };
  const rows = [
    {
      conversationKey: 'account:friend-1',
      contact: '联系人甲',
      company: '招聘公司',
      jobId: 'job-a',
      detailUrl: url('job-a'),
      associationStatus: 'historical',
      jobName: null,
      nameSource: null,
      nameObservedAt: null,
      confirmation: 'unverified',
      candidates: [
        {
          name: 'Team Lead',
          observedCompany: '实际雇主',
          observedAt: at(8),
          source: 'detail_page_title',
          reason: 'detail_company_mismatch',
        },
      ],
    },
    {
      conversationKey: 'account:friend-2',
      contact: '联系人乙',
      company: '公司乙',
      jobId: 'job-b',
      detailUrl: url('job-b'),
      associationStatus: 'current',
      jobName: '后端工程师',
      nameSource: 'detail_page_title',
      nameObservedAt: at(7),
      confirmation: 'confirmed_user',
      candidates: [],
    },
  ];
  const before = structuredClone([input, rows]);
  const markdown = renderJobs(input, {
    resolveV2: (value) => {
      assert.equal(value, input);
      return { capturedAt: at(6), rows };
    },
  });
  assert.match(markdown, /待核对名称候选 1 条/);
  assert.match(markdown, /历史证据（本次未观察到）/);
  assert.match(markdown, /候选“Team Lead”（页面公司：实际雇主，与会话公司不同）/);
  assert.match(markdown, new RegExp(`候选：${at(8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(markdown, new RegExp(`名称：${at(7).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(markdown, /用户已确认（仅本链接）/);
  assert.ok(!markdown.includes('SECRET_V2_STATE'));
  assert.deepEqual([input, rows], before);
});

test('v2 resolver output is validated before rendering', () => {
  const base = {
    conversationKey: 'one',
    contact: '甲',
    company: '公司',
    jobId: 'safe',
    detailUrl: url('safe'),
    associationStatus: 'current',
    jobName: null,
    nameSource: null,
    nameObservedAt: null,
    confirmation: 'unverified',
    candidates: [],
  };
  assert.throws(() => renderJobs({ version: 2, updatedAt: at(1) }), TypeError);
  assert.throws(
    () =>
      renderJobs(
        { version: 2, updatedAt: at(1) },
        { resolveV2: () => [{ ...base, detailUrl: 'javascript:alert(1)' }] },
      ),
    TypeError,
  );
  assert.throws(
    () => renderJobs({ version: 2, updatedAt: at(1) }, { resolveV2: () => [base, { ...base }] }),
    /duplicate conversationKey/,
  );
  assert.throws(
    () =>
      renderJobs(
        { version: 2, updatedAt: at(1) },
        {
          resolveV2: () => [
            {
              ...base,
              candidates: [
                {
                  name: '候选',
                  observedCompany: '公司',
                  observedAt: 'tomorrow',
                  source: 'detail_page_title',
                  reason: 'detail_company_mismatch',
                },
              ],
            },
          ],
        },
      ),
    TypeError,
  );
});

test('the default resolver renders a validated v2 envelope without caller wiring', () => {
  const snapshot = {
    capturedAt: at(1),
    scope: 'loaded-chat-list',
    accountNamespace: 'account-a',
    records: [
      {
        platformIdentity: {
          friendId: 'friend-a',
          friendSource: 'source-a',
          uniqueId: 'friend-a-source-a',
        },
        contact: '',
        company: '',
        title: '',
        preview: '',
        timeLabel: '',
        unread: null,
        latestMessageId: null,
        outgoingReceipt: { status: 'unknown', label: null, source: null },
        jobAssociation: null,
        observedJobName: null,
      },
    ],
    coverage: {
      loadedRows: 1,
      loadedDataRows: 1,
      unresolvedRows: 0,
      renderedRows: 1,
      offscreenRows: 0,
      truncated: false,
    },
  };
  const { envelope: value } = compareLoadedSnapshotsV2(null, snapshot);
  const markdown = renderJobs(value);
  assert.match(markdown, /已加载会话视图共 1 条/);
  assert.match(markdown, new RegExp(at(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markdown, /\| 待补 \| 待补 \| 待补 \|/);
});

test('private Markdown writes atomically with mode 0600, including replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-job-export-'));
  const output = join(directory, 'jobs.md');
  await writeFile(output, 'old', { mode: 0o644 });
  await writePrivateMarkdown(output, 'new\n');
  assert.equal(await readFile(output, 'utf8'), 'new\n');
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});
