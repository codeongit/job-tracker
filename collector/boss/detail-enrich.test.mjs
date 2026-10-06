import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDetailTitleEvidence, parseBossDetailTitle } from './detail-enrich.mjs';
import { applyDetailEvidenceV2, compareLoadedSnapshotsV2, conversationKeyV2 } from './model-v2.mjs';

const url = (id) => `https://www.zhipin.com/job_detail/${id}.html`;
const candidate = (conversationKey, jobId, company, overrides = {}) => ({
  conversationKey,
  jobId,
  company,
  detailUrl: url(jobId),
  jobName: null,
  ...overrides,
});

function adapterFixture(pages, options = {}) {
  const calls = [];
  let index = 0;
  let current = null;
  const identity = { tabId: 'task-tab-7', windowId: 'task-window-2' };
  const adapter = {
    async createOwnedTab({ ownerToken, initialUrl }) {
      calls.push(['create', initialUrl]);
      current = initialUrl;
      return { ...identity, ownerToken };
    },
    async readOwnedTab(handle) {
      calls.push(['read', current]);
      const page = pages[index++] ?? pages.at(-1);
      if (options.wrongOwnerAt === index)
        return { ...identity, ownerToken: 'somebody-else', ...page };
      return { ...identity, ownerToken: handle.ownerToken, documentReady: true, ...page };
    },
    async navigateOwnedTab(handle, { ownerToken, expectedUrl, nextUrl }) {
      calls.push(['navigate', expectedUrl, nextUrl]);
      assert.equal(ownerToken, handle.ownerToken);
      assert.equal(expectedUrl, current);
      current = nextUrl;
    },
    async closeOwnedTab(handle, { ownerToken, expectedUrl }) {
      calls.push(['close', expectedUrl]);
      assert.equal(ownerToken, handle.ownerToken);
      if (options.closeError)
        throw Object.assign(new Error('changed'), { code: 'DETAIL_TAB_CHANGED' });
    },
  };
  return { adapter, calls };
}

const runOptions = (adapter) => ({
  adapter,
  limit: 3,
  wait: async () => {},
  now: () => '2026-09-18T13:00:00.000Z',
  makeOwnerToken: () => 'test-owner',
  maxReads: 8,
  stableReads: 2,
  pollMs: 0,
});

test('strictly parses complete detail titles only', () => {
  assert.deepEqual(parseBossDetailTitle('「平台工程师招聘」_示例公司招聘-BOSS直聘'), {
    name: '平台工程师',
    company: '示例公司',
  });
  for (const title of [
    '',
    '平台工程师_示例公司',
    '安全验证',
    '「招聘」_示例公司招聘-BOSS直聘',
    '「平台工程师招聘」_招聘-BOSS直聘',
  ]) {
    assert.equal(parseBossDetailTitle(title), null);
  }
});

test('creates one task-owned tab, reads stable titles serially and closes it', async () => {
  const pages = [
    { url: url('aaa'), title: '加载中' },
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: url('bbb'), title: '「后端工程师招聘」_公司乙招聘-BOSS直聘' },
    { url: url('bbb'), title: '「后端工程师招聘」_公司乙招聘-BOSS直聘' },
  ];
  const { adapter, calls } = adapterFixture(pages);
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [
      candidate('conversation-a', 'aaa', '公司甲'),
      candidate('conversation-b', 'bbb', '公司乙'),
    ],
  });
  assert.deepEqual(
    result.observations.map((item) => [item.jobId, item.evidence.name]),
    [
      ['aaa', '平台工程师'],
      ['bbb', '后端工程师'],
    ],
  );
  assert.equal(result.observations[0].title, '「平台工程师招聘」_公司甲招聘-BOSS直聘');
  assert.equal(result.observations[0].company, '公司甲');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.halted, null);
  assert.deepEqual(result.cleanup, { status: 'closed' });
  assert.deepEqual(
    calls.filter((call) => call[0] === 'create'),
    [['create', url('aaa')]],
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === 'navigate'),
    [['navigate', url('aaa'), url('bbb')]],
  );
  assert.deepEqual(calls.at(-1), ['close', url('bbb')]);
});

test('new URL with the previous document title cannot supply detail evidence', async () => {
  const previousTitle = '「旧岗位招聘」_示例公司招聘-BOSS直聘';
  const nextTitle = '「新岗位招聘」_示例公司招聘-BOSS直聘';
  const { adapter, calls } = adapterFixture([
    { url: url('aaa'), title: previousTitle },
    { url: url('aaa'), title: previousTitle },
    { url: url('bbb'), title: previousTitle, documentReady: false },
    { url: url('bbb'), title: previousTitle, documentReady: false },
    { url: url('bbb'), title: nextTitle, documentReady: true },
    { url: url('bbb'), title: nextTitle, documentReady: true },
  ]);
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [
      candidate('conversation-a', 'aaa', '示例公司'),
      candidate('conversation-b', 'bbb', '示例公司'),
    ],
  });
  assert.deepEqual(
    result.observations.map((item) => [item.jobId, item.name]),
    [
      ['aaa', '旧岗位'],
      ['bbb', '新岗位'],
    ],
  );
  assert.equal(calls.filter((call) => call[0] === 'read').length, 6);
});

test('a document not ready resets title stability, while a new ready document may share the title', async () => {
  const title = '「同名岗位招聘」_示例公司招聘-BOSS直聘';
  const { adapter, calls } = adapterFixture([
    { url: url('aaa'), title, documentReady: false },
    { url: url('aaa'), title, documentReady: true },
    { url: url('aaa'), title, documentReady: false },
    { url: url('aaa'), title, documentReady: true },
    { url: url('aaa'), title, documentReady: true },
    { url: url('bbb'), title, documentReady: false },
    { url: url('bbb'), title, documentReady: true },
    { url: url('bbb'), title, documentReady: true },
  ]);
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [
      candidate('conversation-a', 'aaa', '示例公司'),
      candidate('conversation-b', 'bbb', '示例公司'),
    ],
  });
  assert.equal(result.observations.length, 2);
  assert.equal(calls.filter((call) => call[0] === 'read').length, 8);
});

test('an unready detail document never becomes successful through repeated parseable titles', async () => {
  const { adapter } = adapterFixture([
    { url: url('aaa'), title: '「旧岗位招聘」_示例公司招聘-BOSS直聘', documentReady: false },
  ]);
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [candidate('conversation-a', 'aaa', '示例公司')],
  });
  assert.equal(result.observations.length, 0);
  assert.equal(result.failures[0].code, 'DETAIL_TITLE_NOT_READY');
  assert.equal(result.cleanup.status, 'closed');
});

test('legacy injected reads remain compatible, while a provided readiness flag must be boolean', async () => {
  for (const legacy of [true, false]) {
    const { adapter } = adapterFixture([
      { url: url('aaa'), title: '「平台工程师招聘」_示例公司招聘-BOSS直聘' },
    ]);
    const read = adapter.readOwnedTab;
    adapter.readOwnedTab = async (handle) => {
      const value = await read(handle);
      if (legacy) delete value.documentReady;
      else value.documentReady = 'true';
      return value;
    };
    const result = await collectDetailTitleEvidence({
      ...runOptions(adapter),
      candidates: [candidate('conversation-a', 'aaa', '示例公司')],
    });
    if (legacy) assert.equal(result.observations.length, 1);
    else {
      assert.equal(result.observations.length, 0);
      assert.equal(result.halted.code, 'DETAIL_TAB_READ_INVALID');
    }
  }
});

test('waits for the configured human-paced interval before navigating to another detail', async () => {
  const pages = [
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: url('bbb'), title: '「后端工程师招聘」_公司乙招聘-BOSS直聘' },
    { url: url('bbb'), title: '「后端工程师招聘」_公司乙招聘-BOSS直聘' },
  ];
  const { adapter } = adapterFixture(pages);
  const waits = [];
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    navigationDelayMs: 10_000,
    wait: async (duration) => waits.push(duration),
    candidates: [
      candidate('conversation-a', 'aaa', '公司甲'),
      candidate('conversation-b', 'bbb', '公司乙'),
    ],
  });
  assert.equal(result.observations.length, 2);
  assert.equal(waits.filter((duration) => duration === 10_000).length, 1);
});

test('same job is visited once and employer evidence may differ from recruiter', async () => {
  const pages = [
    { url: url('aaa'), title: '「Team Lead招聘」_实际雇主招聘-BOSS直聘' },
    { url: url('aaa'), title: '「Team Lead招聘」_实际雇主招聘-BOSS直聘' },
  ];
  const { adapter, calls } = adapterFixture(pages);
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [
      candidate('recruiter-a', 'aaa', '实际雇主'),
      candidate('recruiter-b', 'aaa', '猎头公司'),
    ],
  });
  assert.equal(result.observations.length, 2);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.observations[1].company, '实际雇主');
  assert.equal(calls.filter((call) => call[0] === 'create').length, 1);
});

test('reuses exact prior job evidence without opening a browser tab', async () => {
  const { adapter, calls } = adapterFixture([]);
  const knownEvidence = [
    {
      jobId: 'aaa',
      detailUrl: url('aaa'),
      name: '平台工程师',
      observedCompany: '公司甲',
      title: '「平台工程师招聘」_公司甲招聘-BOSS直聘',
      observedAt: '2026-09-18T12:00:00.000Z',
      source: 'detail_page_title',
    },
  ];
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [candidate('conversation-a', 'aaa', '公司甲')],
    knownEvidence,
  });
  assert.equal(result.observations[0].reused, true);
  assert.equal(result.cleanup.status, 'not_needed');
  assert.deepEqual(calls, []);
});

test('login/security halts safely and returns earlier partial results', async () => {
  const pages = [
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: 'https://www.zhipin.com/web/user/?ka=header-login', title: '登录' },
  ];
  // Use an explicit security URL that must be detected before title parsing.
  pages[2].url = 'https://www.zhipin.com/security/captcha';
  pages[2].documentReady = false;
  const { adapter } = adapterFixture(pages);
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [
      candidate('conversation-a', 'aaa', '公司甲'),
      candidate('conversation-b', 'bbb', '公司乙'),
      candidate('conversation-c', 'ccc', '公司丙'),
    ],
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.halted.code, 'VERIFICATION_OR_LOGIN_REQUIRED');
  assert.equal(result.halted.jobId, 'bbb');
  assert.deepEqual(
    result.remaining.map((item) => item.jobId),
    ['ccc'],
  );
  assert.equal(result.cleanup.status, 'closed');
});

test('ownership mismatch halts and never closes an unverified tab', async () => {
  const pages = [
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
  ];
  const { adapter, calls } = adapterFixture(pages, { wrongOwnerAt: 1 });
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [candidate('conversation-a', 'aaa', '公司甲')],
  });
  assert.equal(result.halted.code, 'DETAIL_TAB_OWNERSHIP_MISMATCH');
  assert.deepEqual(result.cleanup, {
    status: 'skipped',
    reason: 'DETAIL_TAB_OWNERSHIP_NOT_VERIFIED',
  });
  assert.equal(
    calls.some((call) => call[0] === 'close'),
    false,
  );
});

test('adapter message codes and stages survive create and navigation failures', async () => {
  const createAdapter = {
    async createOwnedTab() {
      throw new Error('DETAIL_TAB_MISSING');
    },
    async readOwnedTab() {
      throw new Error('UNEXPECTED');
    },
    async navigateOwnedTab() {
      throw new Error('UNEXPECTED');
    },
    async closeOwnedTab() {
      throw new Error('UNEXPECTED');
    },
  };
  const created = await collectDetailTitleEvidence({
    ...runOptions(createAdapter),
    candidates: [candidate('conversation-a', 'aaa', '公司甲')],
  });
  assert.deepEqual(created.halted, { code: 'DETAIL_TAB_MISSING', stage: 'create', jobId: 'aaa' });
  assert.equal(created.counts.attemptedJobs, 1);

  const { adapter } = adapterFixture([
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
  ]);
  adapter.navigateOwnedTab = async () => {
    throw new Error('DETAIL_TAB_CHANGED');
  };
  const navigated = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [
      candidate('conversation-a', 'aaa', '公司甲'),
      candidate('conversation-b', 'bbb', '公司乙'),
    ],
  });
  assert.deepEqual(navigated.halted, {
    code: 'DETAIL_TAB_CHANGED',
    stage: 'navigate',
    jobId: 'bbb',
  });

  const timeoutAdapter = {
    async createOwnedTab({ ownerToken }) {
      return { ownerToken, tabId: 'tab-timeout', windowId: 'window-1' };
    },
    async readOwnedTab() {
      throw new Error('CDP_COMMAND_TIMEOUT');
    },
    async navigateOwnedTab() {},
    async closeOwnedTab() {},
  };
  const timedOut = await collectDetailTitleEvidence({
    ...runOptions(timeoutAdapter),
    candidates: [candidate('conversation-a', 'aaa', '公司甲')],
  });
  assert.deepEqual(timedOut.halted, { code: 'CDP_COMMAND_TIMEOUT', stage: 'read', jobId: 'aaa' });
});

test('cleanup preserves its concrete safe error code and close stage', async () => {
  const pages = [
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
  ];
  const { adapter } = adapterFixture(pages, { closeError: true });
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [candidate('conversation-a', 'aaa', '公司甲')],
  });
  assert.deepEqual(result.cleanup, {
    status: 'skipped',
    stage: 'close',
    reason: 'DETAIL_TAB_CHANGED',
  });
  assert.deepEqual(result.halted, { code: 'DETAIL_TAB_CHANGED', stage: 'close', jobId: 'aaa' });
});

test('batch limit counts unique missing jobs and returns untouched remainder', async () => {
  const pages = [
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
  ];
  const { adapter } = adapterFixture(pages);
  const result = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    limit: 1,
    candidates: [
      candidate('already', 'named', '公司零', { jobName: '已有名称' }),
      candidate('a', 'aaa', '公司甲'),
      candidate('b', 'bbb', '公司乙'),
    ],
  });
  assert.equal(result.skipped[0].status, 'already_named');
  assert.deepEqual(
    result.remaining.map((item) => item.jobId),
    ['bbb'],
  );
  assert.equal(result.counts.attemptedJobs, 1);
});

test('detail batches accept the configured cap and reject anything above it', async () => {
  const { adapter } = adapterFixture([]);
  const atLimit = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    limit: 20,
    candidates: [],
  });
  assert.equal(atLimit.counts.attemptedJobs, 0);
  await assert.rejects(
    collectDetailTitleEvidence({
      ...runOptions(adapter),
      limit: 21,
      candidates: [candidate('conversation-a', 'aaa', '公司甲')],
    }),
    /limit must be an integer from 1 to 20/,
  );
});

test('invalid identity, URL, duplicate keys and malformed prior evidence fail before browser use', async () => {
  const { adapter, calls } = adapterFixture([]);
  const invalid = [
    [candidate('a', 'aaa', '公司甲'), candidate('a', 'bbb', '公司乙')],
    [{ ...candidate('a', 'aaa', '公司甲'), detailUrl: url('bbb') }],
    [{ ...candidate('a', 'aaa', '公司甲'), detailUrl: 'https://evil.example/job_detail/aaa.html' }],
  ];
  for (const candidates of invalid) {
    await assert.rejects(
      collectDetailTitleEvidence({ ...runOptions(adapter), candidates }),
      TypeError,
    );
  }
  await assert.rejects(
    collectDetailTitleEvidence({
      ...runOptions(adapter),
      candidates: [candidate('a', 'aaa', '公司甲')],
      knownEvidence: [
        {
          jobId: 'aaa',
          detailUrl: url('aaa'),
          name: '错误',
          observedCompany: '公司甲',
          title: '安全验证',
          observedAt: '2026-09-18T12:00:00.000Z',
          source: 'detail_page_title',
        },
      ],
    }),
    TypeError,
  );
  assert.deepEqual(calls, []);
});

test('collected flat results apply directly to the v2 evidence model', async () => {
  const capturedAt = '2026-09-18T12:00:00.000Z';
  const conversationKey = conversationKeyV2('account-a', 'friend-a', 'source-a');
  const snapshot = {
    capturedAt,
    scope: 'loaded-chat-list',
    accountNamespace: 'account-a',
    records: [
      {
        platformIdentity: {
          friendId: 'friend-a',
          friendSource: 'source-a',
          uniqueId: 'friend-a-source-a',
        },
        contact: '联系人甲',
        company: '公司甲',
        title: '招聘者',
        preview: '',
        timeLabel: '',
        unread: null,
        latestMessageId: null,
        outgoingReceipt: { status: 'unknown', label: null, source: null },
        jobAssociation: { jobId: 'aaa', detailUrl: url('aaa') },
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
  const { envelope } = compareLoadedSnapshotsV2(null, snapshot);
  const pages = [
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
    { url: url('aaa'), title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' },
  ];
  const { adapter } = adapterFixture(pages);
  const collected = await collectDetailTitleEvidence({
    ...runOptions(adapter),
    candidates: [candidate(conversationKey, 'aaa', '公司甲')],
  });
  const applied = applyDetailEvidenceV2(envelope, collected, '2026-09-18T13:01:00.000Z');
  assert.equal(applied.report.counts.accepted, 1);
  assert.equal(applied.envelope.jobs.evidence[0].name, '平台工程师');
  assert.equal(applied.envelope.jobs.evidence[0].title, '「平台工程师招聘」_公司甲招聘-BOSS直聘');
  assert.equal(applied.envelope.snapshot.capturedAt, capturedAt);
  assert.equal(applied.envelope.state.lastCapturedAt, capturedAt);
});
