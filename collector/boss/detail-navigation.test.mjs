import test from 'node:test';
import assert from 'node:assert/strict';
import { createCdpController, DETAIL_PAGE_STATE_EXPRESSION } from './platform/cdp-browser.mjs';
import { collectDetailTitleEvidence } from './details/detail-enrich.mjs';
import { collectDetails, detailFailureScope } from './details/detail-phase.mjs';
import { compareLoadedSnapshotsV2, conversationKeyV2 } from './materials/model-v2.mjs';

const chatUrl = 'https://www.zhipin.com/web/geek/chat';
const jobUrl = (id) => `https://www.zhipin.com/job_detail/${id}.html`;
const firstDocument = {
  url: jobUrl('job_a'),
  documentUrl: jobUrl('job_a'),
  title: '「旧岗位招聘」_示例公司招聘-BOSS直聘',
  readyState: 'complete',
  timeOrigin: 1000,
};
const secondDocument = {
  url: jobUrl('job_b'),
  documentUrl: jobUrl('job_b'),
  title: '「新岗位招聘」_示例公司招聘-BOSS直聘',
  readyState: 'complete',
  timeOrigin: 2000,
};

async function collectAcrossNavigation(
  documents,
  { maxReads = 6, jobIds = ['job_a', 'job_b'], throughPhase = false } = {},
) {
  const calls = [];
  const targets = [
    { id: 'task-page', type: 'page', url: chatUrl, webSocketDebuggerUrl: 'ws://task-page' },
  ];
  let navigationStarted = false;
  let navigationReads = 0;
  const fetchImpl = async (request) => {
    const requestUrl = String(request);
    if (requestUrl.endsWith('/json/version')) {
      const port = new URL(requestUrl).port;
      return {
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/synthetic-browser`,
        }),
      };
    }
    if (requestUrl.endsWith('/json/list'))
      return { ok: true, json: async () => structuredClone(targets) };
    throw new Error('UNEXPECTED_FETCH');
  };
  const cdpFactory = async (endpoint) => ({
    async command(method, params) {
      calls.push([method, params]);
      if (method === 'Target.createTarget') {
        targets.push({
          id: 'detail-page',
          type: 'page',
          url: params.url,
          webSocketDebuggerUrl: 'ws://detail-page',
        });
        return { targetId: 'detail-page' };
      }
      if (method === 'Target.closeTarget') {
        const index = targets.findIndex((target) => target.id === params.targetId);
        assert.notEqual(index, -1);
        targets.splice(index, 1);
        return { success: true };
      }
      throw new Error('UNEXPECTED_COMMAND');
    },
    async navigate(nextUrl) {
      assert.equal(endpoint, 'ws://detail-page');
      calls.push(['navigate', nextUrl]);
      navigationStarted = true;
      // A navigation response does not itself replace the document being evaluated.
    },
    async evaluate(expression) {
      if (expression === 'IDENTITY') return { ok: true, url: chatUrl, accountId: '12345' };
      assert.equal(endpoint, 'ws://detail-page');
      assert.equal(expression, DETAIL_PAGE_STATE_EXPRESSION);
      const document = navigationStarted
        ? (documents[navigationReads++] ?? documents.at(-1))
        : firstDocument;
      targets.find((target) => target.id === 'detail-page').url = document.url;
      return structuredClone(document);
    },
    async close() {},
  });
  const controller = createCdpController({
    fetchImpl,
    cdpFactory,
    spawnImpl: () => {
      throw new Error('BROWSER_LAUNCH_FORBIDDEN');
    },
    wait: async () => {},
    now: () => new Date('2026-11-05T02:00:00.000Z'),
  });
  const bound = await controller.start({
    account: 'synthetic',
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  assert.equal(bound.ok, true);
  const options = {
    adapter: controller.createDetailAdapter(bound.connection),
    limit: jobIds.length,
    maxReads,
    stableReads: 2,
    pollMs: 0,
    wait: async () => {},
    now: () => '2026-11-05T02:00:00.000Z',
  };
  const phase = throughPhase
    ? await collectDetails({
        ...options,
        envelope: detailEnvelope(jobIds, bound.connection.accountNamespace),
        runtime: {
          version: 1,
          cursors: { resume: null, detail: null },
          lastRun: null,
          updatedAt: null,
        },
      })
    : null;
  const result =
    phase?.collected ??
    (await collectDetailTitleEvidence({
      ...options,
      candidates: jobIds.map((jobId) => ({
        conversationKey: `conversation-${jobId}`,
        jobId,
        company: '示例公司',
        detailUrl: jobUrl(jobId),
        jobName: null,
      })),
      makeOwnerToken: () => 'synthetic-owner',
    }));
  return { result, phase, calls, targets, navigationReads };
}

function detailEnvelope(jobIds, accountNamespace) {
  const identities = jobIds
    .map((_, index) => {
      const friendId = String(100 + index);
      return {
        key: conversationKeyV2(accountNamespace, friendId, '0'),
        platformIdentity: { friendId, friendSource: '0', uniqueId: `${friendId}-0` },
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  // Establish a/b/c in the existing fair conversation order independently of the collector.
  const records = identities.map((identity, index) => ({
    ...identity,
    contact: '合成招聘者',
    company: '示例公司',
    title: 'Recruiter',
    preview: '合成普通消息',
    timeLabel: '09:00',
    unread: null,
    latestMessageId: `message-${identity.platformIdentity.friendId}`,
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: { jobId: jobIds[index], detailUrl: jobUrl(jobIds[index]) },
    observedJobName: null,
  }));
  return compareLoadedSnapshotsV2(null, {
    capturedAt: '2026-11-05T01:00:00.000Z',
    scope: 'loaded-chat-list',
    accountNamespace,
    records,
    coverage: {
      loadedRows: records.length,
      loadedDataRows: records.length,
      renderedRows: records.length,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  }).envelope;
}

test('pending navigation waits for the new document without accepting the old job title', async () => {
  const { result, calls, targets, navigationReads } = await collectAcrossNavigation([
    firstDocument,
    firstDocument,
    { ...secondDocument, readyState: 'loading' },
    secondDocument,
    secondDocument,
  ]);
  assert.equal(result.halted, null);
  assert.deepEqual(
    result.observations.map(({ jobId, name }) => [jobId, name]),
    [
      ['job_a', '旧岗位'],
      ['job_b', '新岗位'],
    ],
  );
  assert.equal(navigationReads, 5);
  assert.deepEqual(
    calls.filter(([name]) => name === 'navigate'),
    [['navigate', jobUrl('job_b')]],
  );
  assert.equal(calls.filter(([name]) => name === 'Target.createTarget').length, 1);
  assert.deepEqual(result.cleanup, { status: 'closed' });
  assert.deepEqual(
    targets.map(({ id }) => id),
    ['task-page'],
  );
});

for (const { name, documents, code = 'DETAIL_TAB_UNEXPECTED_URL' } of [
  {
    name: 'the previous URL now belongs to a different document',
    documents: [{ ...firstDocument, timeOrigin: 3000 }],
  },
  {
    name: 'document URL changes while location still names the previous job',
    documents: [{ ...firstDocument, documentUrl: jobUrl('job_other') }],
  },
  {
    name: 'a new incomplete document is followed by the old document again',
    documents: [{ ...secondDocument, readyState: 'loading' }, firstDocument],
  },
  {
    name: 'an unrelated job replaces the pending document',
    documents: [
      firstDocument,
      { ...secondDocument, url: jobUrl('job_other'), documentUrl: jobUrl('job_other') },
    ],
  },
  {
    name: 'an unknown site replaces the pending document',
    documents: [
      firstDocument,
      { ...secondDocument, url: 'https://example.test/', documentUrl: 'https://example.test/' },
    ],
  },
  {
    name: 'a login redirect interrupts pending navigation',
    documents: [
      firstDocument,
      {
        ...secondDocument,
        url: 'https://www.zhipin.com/web/user/',
        documentUrl: 'https://www.zhipin.com/web/user/',
      },
    ],
    code: 'VERIFICATION_OR_LOGIN_REQUIRED',
  },
]) {
  test(`pending navigation stops immediately when ${name}`, async () => {
    const { result, calls, navigationReads } = await collectAcrossNavigation(documents, {
      jobIds: ['job_a', 'job_b', 'job_c'],
    });
    assert.equal(result.halted?.code, code);
    assert.equal(result.halted?.jobId, 'job_b');
    assert.deepEqual(
      result.observations.map(({ jobId }) => jobId),
      ['job_a'],
    );
    assert.equal(navigationReads, documents.length);
    assert.deepEqual(
      calls.filter(([name]) => name === 'navigate'),
      [['navigate', jobUrl('job_b')]],
    );
    assert.deepEqual(
      result.remaining.map(({ jobId }) => jobId),
      ['job_c'],
    );
  });
}

test('a navigation that never replaces its old document preserves successful material and backs off only the failed job', async () => {
  const { result, phase, calls, navigationReads } = await collectAcrossNavigation([firstDocument], {
    maxReads: 4,
    jobIds: ['job_a', 'job_b', 'job_c'],
    throughPhase: true,
  });
  assert.equal(phase.stateError, null);
  assert.equal(phase.applied.report.counts.accepted, 1);
  assert.equal(result.counts.attemptedJobs, 2);
  assert.equal(phase.detailCursor, 'job_b');
  assert.equal(detailFailureScope(result, { ok: true }), 'detail');
  assert.deepEqual(
    phase.detailRuntime.tasks.map(({ jobId, status, lastError }) => ({
      jobId,
      status,
      lastError,
    })),
    [{ jobId: 'job_b', status: 'backoff', lastError: 'DETAIL_NAVIGATION_TIMEOUT' }],
  );
  assert.equal(result.halted?.code, 'DETAIL_NAVIGATION_TIMEOUT');
  assert.equal(result.halted?.jobId, 'job_b');
  assert.deepEqual(
    result.observations.map(({ jobId }) => jobId),
    ['job_a'],
  );
  assert.equal(navigationReads, 4);
  assert.deepEqual(
    calls.filter(([name]) => name === 'navigate'),
    [['navigate', jobUrl('job_b')]],
  );
  assert.equal(calls.filter(([name]) => name === 'Target.createTarget').length, 1);
  assert.deepEqual(
    result.remaining.map(({ jobId }) => jobId),
    ['job_c'],
  );
});
