import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assessBossAttribution } from '../../dist/boss-attribution.js';
import { createEnvelopeV2, conversationKeyV2, validateEnvelopeV2 } from './model-v2.mjs';
import {
  createResumeHistoryExpression,
  createResumeFriendExpression,
  createResumePageExpression,
  runResumeHistoryRequests,
  toResumeHistoryResult,
  applyResumeHistoryV2,
} from './resume-history.mjs';

const namespace = 'boss-geek:' + 'c'.repeat(64);
const conversationKey = conversationKeyV2(namespace, '301', '0');
const snapshot = {
  capturedAt: '2026-09-21T06:00:00.000Z',
  scope: 'loaded-chat-list',
  accountNamespace: namespace,
  records: [
    {
      key: conversationKey,
      platformIdentity: { friendId: '301', friendSource: '0', uniqueId: '301-0' },
      contact: 'Synthetic contact',
      company: 'Synthetic company',
      title: 'Recruiter',
      preview: 'Preview',
      timeLabel: '10:00',
      unread: null,
      latestMessageId: '900',
      outgoingReceipt: { status: 'unknown', label: null, source: null },
      jobAssociation: {
        jobId: 'job_301',
        detailUrl: 'https://www.zhipin.com/job_detail/job_301.html',
      },
      observedJobName: 'Synthetic role',
    },
  ],
  coverage: {
    loadedRows: 1,
    loadedDataRows: 1,
    renderedRows: 1,
    offscreenRows: 0,
    unresolvedRows: 0,
    truncated: false,
  },
};

function payload(observations) {
  return {
    ok: true,
    url: 'https://www.zhipin.com/web/geek/chat',
    capturedAt: '2026-09-21T06:10:00.000Z',
    observations,
    unresolved: [],
    coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 2 },
  };
}

test('history expression uses only read APIs and contains no chat click or message write', () => {
  const expression = createResumeHistoryExpression({
    targets: [{ conversationKey, friendId: '301', friendSource: '0' }],
    pages: 2,
  });
  assert.match(expression, /getGeekFriendList\.json/);
  assert.match(expression, /encodeURIComponent\(target.friendId\)/);
  assert.match(expression, /rows.length !== 1/);
  assert.match(expression, /uniqueIdentityPair/);
  assert.match(expression, /geek\/historyMsg/);
  assert.match(expression, /setTimeout\(resolve,3000\)/);
  assert.match(expression, /encodeURIComponent\(target\.friendSource\)/);
  assert.match(expression, /附件简历请求已发送/);
  assert.doesNotMatch(expression, /value\.includes\('附件简历请求已发送'\)/);
  assert.match(expression, /点击查看附件/);
  // Temporary identity checks read the existing list's account/ID fields only.
  assert.match(expression, /querySelectorAll\('li\[role="listitem"\]'\)/);
  for (const forbidden of [
    'document.cookie',
    'localStorage',
    'innerText',
    'dispatchEvent',
    'click(',
    'contenteditable',
    'sendMsg',
  ]) {
    assert.equal(expression.includes(forbidden), false);
  }
  assert.throws(
    () =>
      createResumeHistoryExpression({
        targets: Array.from({ length: 7 }, (_, index) => ({
          conversationKey: String(index).padStart(64, 'a'),
          friendId: String(index + 1),
          friendSource: '0',
        })),
        pages: 2,
      }),
    /RESUME_SCAN_INPUT_INVALID/,
  );
});

test('outbound type-4 with message and job identity is strong, while inbound or unscoped stays review', () => {
  const { envelope } = createEnvelopeV2(snapshot);
  const result = toResumeHistoryResult(
    payload([
      {
        conversationKey,
        friendId: '301',
        friendSource: '0',
        messageId: 'm1',
        direction: 'outbound',
        messageType: 4,
        kind: 'sent_candidate',
        platformTime: '2026-09-20T01:00:00.000Z',
        externalJobId: 'job_301',
        source: 'geek_history_type_4',
      },
      {
        conversationKey,
        friendId: '301',
        friendSource: '0',
        messageId: 'm2',
        direction: 'inbound',
        messageType: 4,
        kind: 'resume_card_other',
        platformTime: '2026-09-20T01:01:00.000Z',
        externalJobId: null,
        source: 'geek_history_type_4',
      },
      {
        conversationKey,
        friendId: '301',
        friendSource: '0',
        messageId: 'm4',
        direction: 'system',
        messageType: 5,
        kind: 'request_sent',
        platformTime: '2026-09-20T01:02:00.000Z',
        externalJobId: null,
        source: 'geek_history_status_message',
      },
    ]),
    envelope,
  );
  assert.deepEqual(
    result.observations.map((item) => item.status),
    ['strong', 'review', 'review'],
  );
  const applied = applyResumeHistoryV2(envelope, result);
  assert.deepEqual(applied.report.counts, {
    observed: 3,
    added: 3,
    strong: 1,
    review: 2,
    unresolved: 0,
    unresolvedByReason: {},
    deduplicated: 0,
  });
  assert.equal(applied.envelope.resume.observations.length, 3);
  const repeated = applyResumeHistoryV2(applied.envelope, result);
  assert.equal(repeated.report.counts.added, 0);
  assert.equal(repeated.report.counts.deduplicated, 0);
  assert.equal(repeated.envelope.resume.observations.length, 3);
});

test('same platform message ignores timestamp jitter but keeps a different resume fact', () => {
  const { envelope } = createEnvelopeV2(snapshot);
  const result = toResumeHistoryResult(
    payload([
      {
        conversationKey,
        friendId: '301',
        friendSource: '0',
        messageId: 'm-jitter',
        direction: 'inbound',
        messageType: 4,
        kind: 'resume_card_other',
        platformTime: '2026-09-20T01:01:58.720Z',
        externalJobId: null,
        source: 'geek_history_type_4',
      },
      {
        conversationKey,
        friendId: '301',
        friendSource: '0',
        messageId: 'm-jitter',
        direction: 'inbound',
        messageType: 4,
        kind: 'resume_card_other',
        platformTime: '2026-09-20T01:01:59.000Z',
        externalJobId: null,
        source: 'geek_history_type_4',
      },
      {
        conversationKey,
        friendId: '301',
        friendSource: '0',
        messageId: 'm-jitter',
        direction: 'system',
        messageType: 5,
        kind: 'request_sent',
        platformTime: '2026-09-20T01:01:59.000Z',
        externalJobId: null,
        source: 'geek_history_status_message',
      },
    ]),
    envelope,
  );
  const applied = applyResumeHistoryV2(envelope, result);
  assert.equal(applied.report.counts.observed, 3);
  assert.equal(applied.report.counts.added, 2);
  assert.deepEqual(applied.envelope.resume.observations.map((item) => item.kind).sort(), [
    'request_sent',
    'resume_card_other',
  ]);
  assert.equal(
    applied.envelope.resume.observations.find((item) => item.kind === 'resume_card_other')
      .platformTime,
    '2026-09-20T01:01:58.720Z',
  );

  const legacyDuplicates = structuredClone(envelope);
  legacyDuplicates.resume.observations = structuredClone(result.observations);
  const cleaned = applyResumeHistoryV2(legacyDuplicates, {
    capturedAt: '2026-09-21T06:20:00.000Z',
    observations: [],
    unresolved: [],
    coverage: { requestedConversations: 0, resolvedConversations: 0, pagesPerConversation: 2 },
  });
  assert.equal(cleaned.report.counts.deduplicated, 1);
  assert.equal(cleaned.envelope.resume.observations.length, 2);
});

test('legacy v2 envelopes gain an empty resume container and malformed evidence fails closed', () => {
  const { envelope } = createEnvelopeV2(snapshot);
  envelope.version = 2;
  delete envelope.resume;
  assert.deepEqual(validateEnvelopeV2(envelope).resume, {
    observations: [],
    lastScanAt: null,
    lastCoverage: null,
    lastUnresolved: [],
  });
  assert.throws(
    () =>
      toResumeHistoryResult(
        payload([
          {
            conversationKey,
            friendId: '301',
            friendSource: '0',
            messageId: 'm3',
            direction: 'unknown',
            messageType: 4,
            kind: 'sent_candidate',
            platformTime: '2026-09-20T01:00:00.000Z',
            externalJobId: 'job_301',
            source: 'geek_history_type_4',
          },
        ]),
        createEnvelopeV2(snapshot).envelope,
      ),
    /RESUME_HISTORY_OBSERVATION_INVALID/,
  );
});

test('split expressions perform exactly one scoped request and use friendSource in history URL', () => {
  const target = { conversationKey, friendId: '301', friendSource: '7' };
  const friend = createResumeFriendExpression({ target });
  assert.equal((friend.match(/\.send\(/g) ?? []).length, 1);
  assert.match(friend, /getGeekFriendList\.json/);
  const page = createResumePageExpression({
    target,
    identity: { bossId: 'boss_1', securityId: 'security-token' },
    page: 2,
  });
  assert.equal((page.match(/\.send\(/g) ?? []).length, 1);
  assert.match(page, /historyMsg/);
  assert.match(page, /encodeURIComponent\(target\.friendSource\)/);
  assert.doesNotMatch(page, /Object\.values\(current\)/);
});

test('page classifier accepts exact platform system fields but not chat text or arbitrary nested quotes', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  const messages = [
    {
      id: 'm1',
      type: 5,
      content: '附件简历请求已发送',
      time: 1_790_000_000,
      encryptJobId: 'job_301',
    },
    { id: 'm2', type: 1, content: '附件简历请求已发送', time: 1_790_000_001 },
    { id: 'm3', type: 5, metadata: { quoted: '附件简历请求已发送' }, time: 1_790_000_002 },
    { id: 'm4', type: 5, content: '他说：附件简历请求已发送', time: 1_790_000_003 },
    {
      id: 'm5',
      type: 4,
      bizType: 317,
      from: { uid: 'boss_301' },
      time: 1_790_000_004,
      body: { type: 16, style: 3, templateId: 1, articles: [{ title: 'synthetic.pdf' }] },
    },
    {
      id: 'm6',
      type: 4,
      bizType: 317,
      from: { uid: 'boss_301' },
      time: 1_790_000_005,
      body: { type: 16, style: 3, templateId: 2, articles: [{ title: 'synthetic.pdf' }] },
    },
  ];
  class FakeXHR {
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.responseText = JSON.stringify({
        code: 0,
        zpData: this.url.includes('getGeekFriendList')
          ? { result: [{ uid: 'boss_301', securityId: 'security-token' }] }
          : { messages },
      });
      queueMicrotask(() => this.onload());
    }
  }
  const expressions = [
    createResumePageExpression({
      target,
      identity: { bossId: 'boss_301', securityId: 'security-token' },
      page: 1,
    }),
    createResumeHistoryExpression({ targets: [target], pages: 1 }),
  ];
  for (const expression of expressions) {
    const result = await vm.runInNewContext(expression, {
      setTimeout: (callback) => {
        callback();
        return 0;
      },
      location: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat' },
      XMLHttpRequest: FakeXHR,
      URL,
      Date,
      JSON,
      Number,
      String,
      Object,
      Array,
      RegExp,
      encodeURIComponent,
      queueMicrotask,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(result.observations.map((item) => [item.messageId, item.kind, item.source])),
      ),
      [
        ['m1', 'request_sent', 'geek_history_status_message'],
        ['m5', 'request_sent', 'geek_history_status_message'],
        ['m6', 'resume_card_other', 'geek_history_type_4'],
      ],
    );
    if (result.messageIds)
      assert.deepEqual(JSON.parse(JSON.stringify(result.messageIds)), [
        'm1',
        'm2',
        'm3',
        'm4',
        'm5',
        'm6',
      ]);
  }
});

test('bounded history runner checkpoints every request and reports actual coverage and usage', async () => {
  const targets = [
    { conversationKey, friendId: '301', friendSource: '0' },
    { conversationKey: 'd'.repeat(64), friendId: '302', friendSource: '0' },
  ];
  const calls = [],
    checkpoints = [],
    waits = [];
  const result = await runResumeHistoryRequests({
    targets,
    pages: 2,
    maxRequests: 5,
    requestDelayMs: 3000,
    now: () => '2026-09-21T10:00:00.000Z',
    wait: async (value) => waits.push(value),
    onCheckpoint: async (value) => checkpoints.push(value),
    execute: async (_expression, metadata) => {
      calls.push(metadata);
      if (metadata.kind === 'friend')
        return {
          ok: true,
          url: 'https://www.zhipin.com/web/geek/chat',
          identity: {
            bossId: `boss_${metadata.conversationKey.slice(0, 2)}`,
            securityId: 'security-token',
          },
        };
      return {
        ok: true,
        url: 'https://www.zhipin.com/web/geek/chat',
        page: metadata.page,
        exhausted: metadata.page === 2 || metadata.conversationKey === 'd'.repeat(64),
        messageIds: [],
        observations: [],
        unresolved: [],
      };
    },
  });
  assert.equal(result.partial, false);
  assert.equal(result.usage.historyRequests, 5);
  assert.deepEqual(result.payload.coverage, {
    requestedConversations: 2,
    resolvedConversations: 2,
    pagesPerConversation: 2,
    requestedPages: 3,
    completedPages: 3,
    exhaustedConversations: 2,
    truncatedConversations: 0,
    failedConversations: 0,
  });
  assert.equal(checkpoints.length, 5);
  assert.equal(waits.length, 4);
  assert.equal(
    waits.every((value) => value === 3000),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.kind),
    ['friend', 'history_page', 'history_page', 'friend', 'history_page'],
  );
});

test('temporary samples retain ordinary-message fields and conflicting paths without trusting them', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  const messages = [
    {
      id: 'ordinary-secret-id',
      type: 1,
      content: 'PRIVATE_CHAT_BODY',
      from: { uid: 'self-secret-id' },
      to: { uid: 'boss-secret-id' },
      encryptJobId: 'job-other',
      body: { jobId: 'job-candidate' },
      time: 1_790_000_000,
    },
    {
      id: 'resume-secret-id',
      type: 5,
      content: '附件简历请求已发送',
      from: { uid: 'self-secret-id' },
      to: { uid: 'boss-secret-id' },
      encryptJobId: 'job-candidate',
      time: 1_790_000_001,
    },
  ];
  class FakeXHR {
    open(_method, url) {
      this.url = url;
    }
    setRequestHeader() {}
    send() {
      this.status = 200;
      this.responseText = JSON.stringify({
        code: 0,
        zpData: this.url.includes('getGeekFriendList')
          ? {
              result: [
                {
                  uid: 'boss-secret-id',
                  friendId: '301',
                  friendSource: '0',
                  securityId: 'SECRET_TOKEN',
                },
              ],
            }
          : { messages },
      });
      queueMicrotask(() => this.onload());
    }
  }
  const vmNode = {
    __vue__: {
      $options: { name: 'virtual-list' },
      $props: {
        dataSources: [
          { friendId: '301', friendSource: '0', uniqueId: '301-0', encryptJobId: 'job-candidate' },
        ],
      },
      $store: { state: { userInfo: { userId: 'self-secret-id' } } },
    },
  };
  const context = {
    location: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat' },
    window: { _PAGE: { uid: 'self-secret-id' } },
    document: { querySelectorAll: () => [vmNode], hasFocus: () => true },
    XMLHttpRequest: FakeXHR,
    queueMicrotask,
  };
  const friend = await vm.runInNewContext(createResumeFriendExpression({ target }), context);
  const page = await vm.runInNewContext(
    createResumePageExpression({ target, identity: friend.identity, page: 1 }),
    context,
  );
  const fields = new Map(page.identitySample.fields.map((field) => [field.path, field]));
  assert.equal(page.identitySample.arrays[0].count, 2);
  assert.equal(page.observations.length, 1);
  assert.equal(page.observations[0].kind, 'request_sent');
  assert.equal(
    fields.get('response.zpData.messages[0].from.uid').identity,
    fields.get('account.pageUid').identity,
  );
  assert.equal(
    fields.get('response.zpData.messages[0].to.uid').identity,
    fields.get('request.bossId').identity,
  );
  assert.notEqual(
    fields.get('response.zpData.messages[0].encryptJobId').identity,
    fields.get('response.zpData.messages[0].body.jobId').identity,
  );
  const serialized = JSON.stringify([friend.identitySample, page.identitySample]);
  assert.doesNotMatch(
    serialized,
    /SECRET|PRIVATE|secret-id|job-candidate|job-other|securityId|附件简历/,
  );
  assert.equal(page.observations[0].attribution.selfId, 'self-secret-id');
  assert.equal(page.observations[0].attribution.responseFriendId, 'boss-secret-id');
  const decision = assessBossAttribution(namespace, {
    ...page.observations[0],
    externalJobId: 'job-candidate',
    attribution: { ...page.observations[0].attribution, accountNamespace: namespace },
  });
  assert.equal(decision.status, 'conflict');
  assert.equal(decision.reason, 'attribution_contact_conflict');
});

test('temporary sample persistence precedes checkpoints and failure retains consumed request usage', async () => {
  for (const failAt of [0, 1, 2]) {
    const checkpoints = [],
      order = [];
    let samples = 0,
      calls = 0;
    const operation = runResumeHistoryRequests({
      targets: [{ conversationKey, friendId: '301', friendSource: '0' }],
      pages: 1,
      maxRequests: 2,
      requestDelayMs: 0,
      execute: async (_expression, metadata) => {
        calls++;
        return metadata.kind === 'friend'
          ? { ok: true, identity: { bossId: 'boss1', securityId: 'SECRET_TOKEN' } }
          : {
              ok: true,
              messageIds: ['ordinary'],
              observations: [],
              unresolved: [],
              exhausted: true,
            };
      },
      onIdentitySample: async (sample, metadata) => {
        order.push('sample');
        samples++;
        if (samples === failAt) throw new Error('PRIVATE_DISK_ERROR');
        assert.equal(sample.result, 'response_unavailable');
        assert.equal(metadata.previous, samples === 1 ? null : 'friend-file');
        return 'friend-file';
      },
      onCheckpoint: async (value) => {
        order.push('checkpoint');
        checkpoints.push(value);
      },
    });
    if (!failAt) {
      assert.equal((await operation).usage.historyRequests, 2);
      assert.deepEqual(order, ['sample', 'checkpoint', 'sample', 'checkpoint']);
    } else {
      await assert.rejects(operation, (error) => {
        assert.equal(error.message, 'BOSS_IDENTITY_SAMPLE_SAVE_FAILED');
        assert.equal(error.usage.historyRequests, failAt);
        return true;
      });
      assert.equal(checkpoints.length, failAt - 1);
      if (checkpoints.length) assert.equal(checkpoints[0].nextPage, 1);
      assert.equal(calls, failAt);
    }
  }
});

test('bounded history runner does not spend a one-request budget on an unusable friend lookup', async () => {
  const checkpoints = [];
  const result = await runResumeHistoryRequests({
    targets: [{ conversationKey, friendId: '301', friendSource: '0' }],
    pages: 2,
    maxRequests: 1,
    requestDelayMs: 0,
    onCheckpoint: async (value) => checkpoints.push(value),
    execute: async () => ({
      ok: true,
      url: 'https://www.zhipin.com/web/geek/chat',
      identity: { bossId: 'boss_1', securityId: 'token' },
    }),
  });
  assert.equal(result.partial, false);
  assert.equal(result.error, null);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.usage.historyRequests, 0);
  assert.equal(result.cursor, null);
  assert.equal(checkpoints.length, 0);
});

test('request budget advances the fair cursor only through the last attempted conversation', async () => {
  const second = 'd'.repeat(64),
    calls = [];
  const result = await runResumeHistoryRequests({
    targets: [
      { conversationKey, friendId: '301', friendSource: '0' },
      { conversationKey: second, friendId: '302', friendSource: '0' },
    ],
    pages: 1,
    maxRequests: 2,
    requestDelayMs: 0,
    onCheckpoint: async () => {},
    execute: async (_expression, metadata) => {
      calls.push(metadata);
      if (metadata.kind === 'friend')
        return {
          ok: true,
          url: 'https://www.zhipin.com/web/geek/chat',
          identity: { bossId: 'boss_1', securityId: 'token' },
        };
      return {
        ok: true,
        url: 'https://www.zhipin.com/web/geek/chat',
        exhausted: true,
        messageIds: [],
        observations: [],
        unresolved: [],
      };
    },
  });
  assert.deepEqual(
    calls.map((call) => [call.kind, call.conversationKey]),
    [
      ['friend', conversationKey],
      ['history_page', conversationKey],
    ],
  );
  assert.equal(result.cursor, conversationKey);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.partial, false);
  assert.equal(result.error, null);
});

test('history runner resumes the durable page and retains it until the conversation is complete', async () => {
  const calls = [],
    checkpoints = [];
  const result = await runResumeHistoryRequests({
    targets: [
      { conversationKey: 'd'.repeat(64), friendId: '302', friendSource: '0' },
      { conversationKey, friendId: '301', friendSource: '0' },
    ],
    pages: 2,
    maxRequests: 3,
    requestDelayMs: 0,
    startConversationKey: conversationKey,
    startPage: 3,
    onCheckpoint: async (value) => checkpoints.push(value),
    execute: async (_expression, metadata) => {
      calls.push(metadata);
      if (metadata.kind === 'friend')
        return {
          ok: true,
          url: 'https://www.zhipin.com/web/geek/chat',
          identity: { bossId: 'boss_1', securityId: 'token' },
        };
      return {
        ok: true,
        url: 'https://www.zhipin.com/web/geek/chat',
        exhausted: false,
        messageIds: [],
        observations: [],
        unresolved: [],
      };
    },
  });
  assert.deepEqual(
    calls.map((call) => [call.kind, call.conversationKey, call.page ?? null]),
    [
      ['friend', conversationKey, null],
      ['history_page', conversationKey, 3],
      ['history_page', conversationKey, 4],
    ],
  );
  assert.deepEqual(result.continuation, { conversationKey, page: 5 });
  assert.equal(result.cursor, null);
  assert.equal(checkpoints.at(-1).nextPage, 5);
});

test('history runner stops at an already observed message and advances the fair cursor', async () => {
  const calls = [];
  const result = await runResumeHistoryRequests({
    targets: [{ conversationKey, friendId: '301', friendSource: '0' }],
    pages: 5,
    maxRequests: 6,
    requestDelayMs: 0,
    knownMessageIds: [{ conversationKey, messageId: 'known_1' }],
    onCheckpoint: async () => {},
    execute: async (_expression, metadata) => {
      calls.push(metadata);
      if (metadata.kind === 'friend')
        return {
          ok: true,
          url: 'https://www.zhipin.com/web/geek/chat',
          identity: { bossId: 'boss_1', securityId: 'token' },
        };
      return {
        ok: true,
        url: 'https://www.zhipin.com/web/geek/chat',
        exhausted: false,
        messageIds: ['new_1', 'known_1'],
        observations: [],
        unresolved: [],
      };
    },
  });
  assert.deepEqual(
    calls.map((call) => call.kind),
    ['friend', 'history_page'],
  );
  assert.equal(result.continuation, null);
  assert.equal(result.cursor, conversationKey);
  assert.equal(result.payload.coverage.exhaustedConversations, 1);
});

test('new snapshots retain partial identity evidence and enrich observations without changing IDs', () => {
  const base = createEnvelopeV2(snapshot).envelope;
  const raw = {
    conversationKey,
    friendId: '301',
    friendSource: '0',
    messageId: 'enrich-message',
    direction: 'system',
    messageType: 5,
    kind: 'request_sent',
    platformTime: '2026-09-20T08:00:00.000Z',
    externalJobId: null,
    source: 'geek_history_status_message',
  };
  const first = applyResumeHistoryV2(base, toResumeHistoryResult(payload([raw]), base));
  const evidence = {
    version: 1,
    source: 'history',
    accountNamespace: null,
    conversationKey,
    messageId: raw.messageId,
    requestedBossId: 'boss_301',
    responseFriendId: null,
    responseFriendSource: null,
    responseBossId: 'boss_301',
    selfId: null,
    senderId: 'boss_301',
    recipientId: null,
    messageJobId: null,
  };
  const second = applyResumeHistoryV2(
    first.envelope,
    toResumeHistoryResult(payload([{ ...raw, attribution: evidence }]), first.envelope),
  );
  assert.equal(second.envelope.version, 4);
  assert.equal(second.envelope.resume.observations.length, 1);
  assert.equal(second.envelope.resume.observations[0].id, first.envelope.resume.observations[0].id);
  assert.equal(second.envelope.resume.observations[0].attribution.responseFriendId, null);
  assert.equal(
    second.envelope.resume.observations[0].attribution.accountNamespace,
    base.accountNamespace,
  );
});

test('response contact and checked self identity share the gate across paged and compatibility reads', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  for (const scenario of [
    {
      name: 'message has no job identity',
      reason: 'attribution_job_missing',
      status: 'insufficient',
    },
    { name: 'wrong contact', uid: 302, reason: 'attribution_contact_conflict', status: 'conflict' },
    { name: 'wrong source', source: 1, reason: 'attribution_contact_conflict', status: 'conflict' },
    {
      name: 'missing source',
      source: null,
      reason: 'attribution_conversation_missing',
      status: 'insufficient',
    },
    {
      name: 'wrong participant',
      sender: 999,
      reason: 'attribution_participant_conflict',
      status: 'conflict',
    },
    {
      name: 'self sources disagree',
      storeSelf: 102,
      reason: 'attribution_participants_missing',
      status: 'insufficient',
    },
  ]) {
    const contact = { uid: scenario.uid ?? 301, securityId: 'synthetic-security' };
    if (scenario.source !== null) contact.friendSource = scenario.source ?? 0;
    const message = {
      mid: 500,
      type: 5,
      content: '附件简历请求已发送',
      time: 1790000000,
      from: { uid: scenario.sender ?? 101 },
      to: { uid: contact.uid },
    };
    class FakeXHR {
      open(_method, url) {
        this.url = url;
      }
      setRequestHeader() {}
      send() {
        this.status = 200;
        this.responseText = JSON.stringify({
          code: 0,
          zpData: this.url.includes('getGeekFriendList')
            ? { result: [contact] }
            : { messages: [message] },
        });
        queueMicrotask(() => this.onload());
      }
    }
    const vmNode = {
      __vue__: {
        $options: { name: 'virtual-list' },
        $props: {
          dataSources: [
            { friendId: 301, friendSource: 0, uniqueId: '301-0', encryptJobId: 'candidate-job' },
          ],
        },
        $store: { state: { userInfo: { userId: scenario.storeSelf ?? 101 } } },
      },
    };
    const context = {
      location: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat' },
      window: { _PAGE: { uid: 101 } },
      document: { querySelectorAll: () => [vmNode], hasFocus: () => true },
      XMLHttpRequest: FakeXHR,
      queueMicrotask,
      setTimeout: (callback) => queueMicrotask(callback),
    };
    const friend = await vm.runInNewContext(createResumeFriendExpression({ target }), context);
    const page = await vm.runInNewContext(
      createResumePageExpression({ target, identity: friend.identity, page: 1 }),
      context,
    );
    const legacy = await vm.runInNewContext(
      createResumeHistoryExpression({ targets: [target], pages: 1 }),
      context,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(legacy.observations)),
      JSON.parse(JSON.stringify(page.observations)),
      scenario.name,
    );
    const observation = page.observations[0];
    assert.equal(observation.kind, 'request_sent', scenario.name);
    assert.equal(observation.externalJobId, null, scenario.name);
    const result = assessBossAttribution(namespace, {
      ...observation,
      externalJobId: 'candidate-job',
      attribution: { ...observation.attribution, accountNamespace: namespace },
    });
    assert.equal(result.status, scenario.status, scenario.name);
    assert.equal(result.reason, scenario.reason, scenario.name);
  }
});
