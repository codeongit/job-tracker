import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assessBossAttribution } from '../../dist/boss/rules/attribution.js';
import { BOSS_ACTION40_PLATFORM_CONTRACT } from '../../dist/boss/rules/resume-rules.js';
import {
  createEnvelopeV2,
  conversationKeyV2,
  validateEnvelopeV2,
  upgradeEnvelope,
} from './materials/model-v2.mjs';
import {
  createResumeHistoryExpression,
  createResumeFriendExpression,
  createResumePageExpression,
  runResumeHistoryRequests,
  toResumeHistoryResult,
  applyResumeHistoryV2,
} from './history/resume-history.mjs';

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

function syntheticHistoryFixture(messages) {
  const requests = [];
  class FakeXHR {
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader() {}
    send() {
      requests.push({ method: this.method, url: this.url });
      this.status = 200;
      this.responseText = JSON.stringify({
        code: 0,
        zpData: this.url.includes('getGeekFriendList')
          ? { result: [{ uid: 'boss_301', friendSource: '0', securityId: 'synthetic-security' }] }
          : typeof messages === 'function'
            ? messages(this.url)
            : { messages },
      });
      queueMicrotask(() => this.onload());
    }
  }
  return {
    requests,
    context: {
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
    },
  };
}

function syntheticActionNotice(mid, extend) {
  return {
    mid,
    type: 1,
    time: 1_790_000_006,
    from: { uid: 'self_301' },
    to: { uid: 'boss_301' },
    body: { type: 4, templateId: 1, action: { aid: 40, extend } },
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
  // Account verification reads the existing list and fixed account fields only.
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
        ['m5', 'resume_card_other', 'geek_history_type_4'],
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

test('历史与兼容入口识别真实系统模式，普通卡片同次保留且正文不交付', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  const actionNotice = {
    mid: 'synthetic-action-send',
    type: 1,
    time: 1_790_000_006,
    from: { uid: 'self_301' },
    to: { uid: 'boss_301' },
    body: {
      type: 4,
      templateId: 1,
      action: { aid: 40, extend: '{"fileName":"private-action.pdf","url":"private-action-link"}' },
    },
  };
  const messages = [
    actionNotice,
    actionNotice,
    {
      mid: 'synthetic-send',
      type: 3,
      bizType: 13,
      time: 1_790_000_007,
      from: { uid: 'boss_301' },
      to: { uid: 'self_301' },
      body: {
        type: 12,
        templateId: 1,
        hyperLink: {
          hyperLinkType: 6,
          text: '您的附件简历 private-synthetic.pdf 已发送给Boss',
          url: 'https://example.invalid/private-resume',
        },
      },
    },
    {
      mid: 'synthetic-viewed',
      type: 4,
      time: 1_790_000_009,
      from: { uid: 'boss_301' },
      to: { uid: 'self_301' },
      body: { type: 1, templateId: 3, text: '对方已查看了您的附件简历' },
    },
    {
      mid: 'synthetic-job-card',
      type: 4,
      bizType: 317,
      time: 1_790_000_010,
      from: { uid: 'boss_301' },
      to: { uid: 'self_301' },
      body: { type: 16, templateId: 1, articles: [{ title: 'Synthetic company role' }] },
    },
    {
      mid: 'synthetic-user-quote',
      type: 1,
      time: 1_790_000_011,
      from: { uid: 'self_301' },
      to: { uid: 'boss_301' },
      body: { type: 1, templateId: 3, text: '对方已查看了您的附件简历' },
    },
    {
      ...actionNotice,
      mid: 'synthetic-portfolio',
      text: '附件简历请求已发送',
      body: { ...actionNotice.body, action: { aid: 40, extend: '{"annexType":1}' } },
    },
    {
      ...actionNotice,
      mid: 'synthetic-malformed-action',
      text: '附件简历请求已发送',
      body: { ...actionNotice.body, action: { aid: 40, extend: '{' } },
    },
    {
      ...actionNotice,
      mid: 'synthetic-phone-action',
      text: '附件简历请求已发送',
      body: { ...actionNotice.body, action: { aid: 27, extend: '' } },
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
          ? { result: [{ uid: 'boss_301', securityId: 'synthetic-security' }] }
          : { messages },
      });
      queueMicrotask(() => this.onload());
    }
  }
  const { envelope } = createEnvelopeV2(snapshot);
  const collected = [];
  for (const expression of [
    createResumePageExpression({
      target,
      identity: { bossId: 'boss_301', securityId: 'synthetic-security' },
      page: 1,
    }),
    createResumeHistoryExpression({ targets: [target], pages: 1 }),
  ]) {
    const value = await vm.runInNewContext(expression, {
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
    const observations = JSON.parse(JSON.stringify(value.observations));
    assert.deepEqual(
      observations.map((item) => [item.messageId, item.kind]),
      [
        ['synthetic-action-send', 'request_sent'],
        ['synthetic-action-send', 'request_sent'],
        ['synthetic-send', 'attachment_sent'],
        ['synthetic-viewed', 'viewed_confirmed'],
        ['synthetic-job-card', 'resume_card_other'],
      ],
    );
    assert.deepEqual(
      observations.map((item) => item.resumeEvidence.version),
      [3, 3, 2, 2, 1],
    );
    assert.deepEqual(observations[0].resumeEvidence, {
      version: 3,
      messageType: 1,
      field: 'body.action',
      text: '附件简历请求已发送',
      bodyType: 4,
      templateId: 1,
      actionAid: 40,
      annexType: null,
    });
    assert.equal(observations[0].direction, 'system');
    assert.equal(observations[0].attribution.senderId, 'self_301');
    assert.equal(observations[0].attribution.recipientId, 'boss_301');
    for (const privateValue of [
      'private-synthetic',
      'private-resume',
      'synthetic-security',
      'Synthetic company role',
      'private-action',
      'fileName',
      'extend',
    ])
      assert.equal(JSON.stringify(observations).includes(privateValue), false);
    const result = toResumeHistoryResult(payload(observations), envelope);
    assert.equal(
      result.observations.filter((item) => item.messageId === 'synthetic-action-send').length,
      1,
    );
    const applied = applyResumeHistoryV2(envelope, result);
    assert.equal(applied.envelope.version, 8);
    assert.deepEqual(
      applyResumeHistoryV2(applied.envelope, result).envelope.resume.observations,
      applied.envelope.resume.observations,
    );
    const legacy = structuredClone(applied.envelope);
    legacy.version = 5;
    assert.throws(() => upgradeEnvelope(legacy), /resume evidence version/);
    collected.push(result.observations.map((item) => item.id));
  }
  assert.deepEqual(collected[0], collected[1]);
});

test('生成的历史表达式按已核实契约接收合成不透明动作，并保留不足诊断', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  const messages = [
    syntheticActionNotice('opaque-send', 'synthetic-opaque-action-token'),
    syntheticActionNotice('json-send', '{"annexType":0,"fileName":"synthetic-private.pdf"}'),
    syntheticActionNotice('portfolio', '{"annexType":1}'),
    syntheticActionNotice('malformed-json', '{"annexType":1'),
    syntheticActionNotice('unknown-annex', '{"annexType":2}'),
    { ...syntheticActionNotice('changed-action-shape', ''), type: '1' },
    {
      ...syntheticActionNotice('unrelated-action', ''),
      body: { type: 4, templateId: 1, action: { aid: 27, extend: '' } },
    },
    {
      mid: 'chat-quote',
      type: 1,
      body: { type: 1, text: '附件简历请求已发送' },
    },
    {
      mid: 'ordinary-card',
      type: 4,
      time: 1_790_000_007,
      from: { uid: 'boss_301' },
      to: { uid: 'self_301' },
      body: { type: 16, templateId: 1, articles: [{ title: 'Synthetic role' }] },
    },
  ];
  for (const platformContract of [BOSS_ACTION40_PLATFORM_CONTRACT, null, 'future-contract']) {
    for (const compatibility of [false, true]) {
      const fixture = syntheticHistoryFixture(messages);
      const expression = compatibility
        ? createResumeHistoryExpression({ targets: [target], pages: 1, platformContract })
        : createResumePageExpression({
            target,
            identity: { bossId: 'boss_301', securityId: 'synthetic-security' },
            page: 1,
            platformContract,
          });
      const value = JSON.parse(
        JSON.stringify(await vm.runInNewContext(expression, fixture.context)),
      );
      assert.equal(value.ok, true);
      const verified = platformContract === BOSS_ACTION40_PLATFORM_CONTRACT;
      assert.deepEqual(
        value.observations.map((item) => [item.messageId, item.kind, item.resumeEvidence.version]),
        [
          ...(verified ? [['opaque-send', 'request_sent', 4]] : []),
          ['json-send', 'request_sent', 3],
          ['ordinary-card', 'resume_card_other', 1],
        ],
      );
      assert.deepEqual(value.unresolved, [
        ...(!verified
          ? [{ conversationKey, reason: 'RESUME_ACTION_PLATFORM_CONTRACT_UNVERIFIED' }]
          : []),
        { conversationKey, reason: 'RESUME_ACTION_EXTENSION_INVALID' },
        { conversationKey, reason: 'RESUME_ACTION_ANNEX_TYPE_UNSUPPORTED' },
        { conversationKey, reason: 'RESUME_ACTION_SHAPE_UNSUPPORTED' },
      ]);
      assert.equal(fixture.requests.length, compatibility ? 2 : 1);
      for (const privateValue of [
        'synthetic-opaque-action-token',
        'synthetic-private.pdf',
        'synthetic-security',
        'fileName',
        'extend',
      ])
        assert.equal(JSON.stringify(value).includes(privateValue), false);
      const { envelope } = createEnvelopeV2(snapshot);
      assert.doesNotThrow(() =>
        toResumeHistoryResult(
          { ...payload(value.observations), unresolved: value.unresolved },
          envelope,
        ),
      );
      if (verified) {
        assert.equal(value.observations[0].resumeEvidence.extensionFormat, 'opaque_string');
        assert.equal(value.observations[0].resumeEvidence.platformContract, platformContract);
        assert.equal(value.observations[0].attribution.senderId, 'self_301');
        assert.equal(value.observations[0].attribution.recipientId, 'boss_301');
      }
    }
  }
});

test('有界历史读取将契约传入实际生成表达式，v7 检查点不泄露请求私有字段', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  const fixture = syntheticHistoryFixture([
    syntheticActionNotice('opaque-send', 'synthetic-opaque-action-token'),
    syntheticActionNotice('malformed-json', '{'),
    syntheticActionNotice('portfolio', '{"annexType":1}'),
  ]);
  const checkpoints = [],
    calls = [];
  const result = await runResumeHistoryRequests({
    targets: [target],
    pages: 1,
    maxRequests: 2,
    requestDelayMs: 0,
    platformContract: BOSS_ACTION40_PLATFORM_CONTRACT,
    onCheckpoint: async (value) => checkpoints.push(value),
    execute: async (expression, metadata) => {
      calls.push(metadata.kind);
      return JSON.parse(JSON.stringify(await vm.runInNewContext(expression, fixture.context)));
    },
  });
  assert.deepEqual(calls, ['friend', 'history_page']);
  assert.equal(fixture.requests.length, 2);
  assert.equal(result.usage.historyRequests, 2);
  assert.equal(result.partial, false);
  assert.equal(result.payload.coverage.completedPages, 1);
  assert.deepEqual(
    result.payload.observations.map((item) => item.resumeEvidence.version),
    [4],
  );
  assert.deepEqual(result.payload.unresolved, [
    { conversationKey, reason: 'RESUME_ACTION_EXTENSION_INVALID' },
  ]);
  assert.equal(checkpoints.length, 2);
  assert.equal(
    checkpoints.every((item) => item.version === 7),
    true,
  );
  assert.equal(checkpoints.at(-1).usage.historyRequests, 2);
  assert.deepEqual(checkpoints.at(-1).observations, result.payload.observations);
  assert.deepEqual(checkpoints.at(-1).unresolved, result.payload.unresolved);
  for (const privateValue of [
    'synthetic-opaque-action-token',
    'synthetic-security',
    'responseText',
    'extend',
  ])
    assert.equal(JSON.stringify(checkpoints).includes(privateValue), false);
});

test('历史执行失败仍计入已发请求，v7 检查点保留失败页而不保存私有错误正文', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  const checkpoints = [];
  const result = await runResumeHistoryRequests({
    targets: [target],
    pages: 1,
    maxRequests: 2,
    requestDelayMs: 0,
    onCheckpoint: async (value) => checkpoints.push(value),
    execute: async (_expression, metadata) => {
      if (metadata.kind === 'friend')
        return { ok: true, identity: { bossId: 'boss_301', securityId: 'synthetic-security' } };
      throw new Error('synthetic-private-error');
    },
  });
  assert.equal(result.usage.historyRequests, 2);
  assert.equal(result.partial, true);
  assert.equal(result.error, 'HISTORY_SCAN_FAILED');
  assert.deepEqual(result.continuation, { conversationKey, page: 1 });
  assert.equal(checkpoints.at(-1).version, 7);
  assert.equal(checkpoints.at(-1).usage.historyRequests, 2);
  assert.equal(checkpoints.at(-1).nextPage, 1);
  assert.equal(JSON.stringify(checkpoints).includes('synthetic-private-error'), false);
});

test('恢复历史读取继承并按会话及原因去重 initial unresolved，不覆盖已保存不足', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  const initialUnresolved = [
    { conversationKey, reason: 'RESUME_ACTION_SHAPE_UNSUPPORTED' },
    { conversationKey, reason: 'RESUME_ACTION_EXTENSION_INVALID' },
    { conversationKey, reason: 'RESUME_ACTION_SHAPE_UNSUPPORTED' },
  ];
  const fixture = syntheticHistoryFixture([
    syntheticActionNotice('malformed-json', '{'),
    { ...syntheticActionNotice('changed-shape', ''), type: '1' },
  ]);
  const checkpoints = [];
  const result = await runResumeHistoryRequests({
    targets: [target],
    pages: 1,
    maxRequests: 2,
    requestDelayMs: 0,
    initialUnresolved,
    onCheckpoint: async (value) => checkpoints.push(value),
    execute: async (expression) =>
      JSON.parse(JSON.stringify(await vm.runInNewContext(expression, fixture.context))),
  });
  const expected = initialUnresolved.slice(0, 2);
  assert.equal(initialUnresolved.length, 3);
  assert.deepEqual(result.payload.unresolved, expected);
  assert.deepEqual(checkpoints[0].unresolved, expected);
  assert.deepEqual(checkpoints.at(-1).unresolved, expected);
  assert.equal(result.usage.historyRequests, 2);
});

test('initial unresolved 拒绝未知字段及不合白名单的身份或原因，不发请求', async () => {
  for (const initialUnresolved of [
    null,
    {},
    [{ conversationKey, reason: 'RESUME_ACTION_SHAPE_UNSUPPORTED', rawExtend: 'synthetic' }],
    [{ conversationKey }],
    [{ conversationKey: 'short-key', reason: 'RESUME_ACTION_SHAPE_UNSUPPORTED' }],
    [{ conversationKey, reason: 'private free text' }],
    [{ conversationKey, reason: 'resume_action_shape_unsupported' }],
  ]) {
    let requests = 0;
    await assert.rejects(
      runResumeHistoryRequests({
        targets: [{ conversationKey, friendId: '301', friendSource: '0' }],
        initialUnresolved,
        execute: async () => {
          requests++;
          return {};
        },
      }),
      /RESUME_SCAN_INPUT_INVALID/,
    );
    assert.equal(requests, 0);
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
        messageIds: [String(100 - metadata.page)],
        nextCursor: String(100 - metadata.page),
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
  assert.equal(
    checkpoints.every((item) => item.version === 7),
    true,
  );
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
    initialCursor: '100',
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
        messageIds: [String(100 - metadata.page)],
        nextCursor: String(100 - metadata.page),
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
  assert.equal(second.envelope.version, 8);
  assert.equal(second.envelope.resume.observations.length, 1);
  assert.equal(second.envelope.resume.observations[0].id, first.envelope.resume.observations[0].id);
  assert.equal(second.envelope.resume.observations[0].attribution.responseFriendId, null);
  assert.equal(
    second.envelope.resume.observations[0].attribution.accountNamespace,
    base.accountNamespace,
  );
});

test('v4 类型四误分类升级保留原观察身份，并显式缺少发送依据', () => {
  const { envelope } = createEnvelopeV2(snapshot);
  const raw = {
    conversationKey,
    friendId: '301',
    friendSource: '0',
    messageId: 'legacy-card',
    direction: 'system',
    messageType: 4,
    kind: 'request_sent',
    platformTime: '2026-09-20T08:00:00.000Z',
    externalJobId: null,
    source: 'geek_history_status_message',
  };
  const current = applyResumeHistoryV2(
    envelope,
    toResumeHistoryResult(payload([raw]), envelope),
  ).envelope;
  const legacy = structuredClone(current);
  legacy.version = 4;
  delete legacy.resume.observations[0].resumeEvidence;
  const upgraded = upgradeEnvelope(legacy);
  assert.equal(upgraded.version, 8);
  assert.equal(upgraded.resume.observations[0].resumeEvidence, null);
  assert.equal(upgraded.resume.observations[0].kind, 'request_sent');
  assert.equal(upgraded.resume.observations[0].id, current.resume.observations[0].id);
  assert.equal(Object.hasOwn(legacy.resume.observations[0], 'resumeEvidence'), false);
  const bad = structuredClone(upgraded);
  bad.resume.observations[0].resumeEvidence = {
    version: 2,
    messageType: 4,
    field: 'none',
    text: '',
  };
  assert.throws(() => upgradeEnvelope(bad), /RESUME_EVIDENCE_INVALID/);
});

test('同一观察补入精确发送依据时不改变身份，卡片依据仍不含正文', () => {
  const { envelope } = createEnvelopeV2(snapshot);
  const raw = {
    conversationKey,
    friendId: '301',
    friendSource: '0',
    messageId: 'same-status',
    direction: 'system',
    messageType: 5,
    kind: 'request_sent',
    platformTime: '2026-09-20T08:00:00.000Z',
    externalJobId: null,
    source: 'geek_history_status_message',
  };
  const first = applyResumeHistoryV2(envelope, toResumeHistoryResult(payload([raw]), envelope));
  const proof = {
    version: 1,
    messageType: 5,
    field: 'message.content',
    text: '附件简历请求已发送',
  };
  const second = applyResumeHistoryV2(
    first.envelope,
    toResumeHistoryResult(payload([{ ...raw, resumeEvidence: proof }]), first.envelope),
  );
  assert.equal(second.envelope.resume.observations.length, 1);
  assert.equal(second.envelope.resume.observations[0].id, first.envelope.resume.observations[0].id);
  assert.deepEqual(second.envelope.resume.observations[0].resumeEvidence, proof);
  const repeated = applyResumeHistoryV2(
    second.envelope,
    toResumeHistoryResult(payload([{ ...raw, resumeEvidence: proof }]), second.envelope),
  );
  assert.deepEqual(repeated.envelope.resume.observations, second.envelope.resume.observations);
});

test('重复消息的身份与发送依据保持同次观察，不能跨采样拼成完整证明', () => {
  const { envelope } = createEnvelopeV2(snapshot);
  const raw = {
    conversationKey,
    friendId: '301',
    friendSource: '0',
    messageId: 'independent-status',
    direction: 'system',
    messageType: 5,
    kind: 'request_sent',
    platformTime: '2026-09-20T08:00:00.000Z',
    externalJobId: null,
    source: 'geek_history_status_message',
  };
  const attribution = {
    version: 1,
    source: 'history',
    accountNamespace: null,
    conversationKey,
    messageId: raw.messageId,
    requestedBossId: 'boss_301',
    responseFriendId: '301',
    responseFriendSource: '0',
    responseBossId: 'boss_301',
    selfId: 'self_301',
    senderId: 'boss_301',
    recipientId: 'self_301',
    messageJobId: null,
  };
  const proof = {
    version: 1,
    messageType: 5,
    field: 'message.content',
    text: '附件简历请求已发送',
  };
  const identityOnly = { ...raw, attribution },
    semanticsOnly = { ...raw, resumeEvidence: proof };
  const first = applyResumeHistoryV2(
    envelope,
    toResumeHistoryResult(payload([identityOnly]), envelope),
  );
  const second = applyResumeHistoryV2(
    first.envelope,
    toResumeHistoryResult(payload([semanticsOnly]), first.envelope),
  );
  const paired = second.envelope.resume.observations[0];
  assert.equal(Boolean(paired.attribution && paired.resumeEvidence), false);
  assert.equal(paired.id, first.envelope.resume.observations[0].id);
  for (const items of [
    [identityOnly, semanticsOnly],
    [semanticsOnly, identityOnly],
  ]) {
    const converted = toResumeHistoryResult(payload(items), envelope);
    assert.equal(converted.observations.length, 1);
    assert.equal(
      Boolean(converted.observations[0].attribution && converted.observations[0].resumeEvidence),
      false,
    );
    assert.deepEqual(
      converted.observations,
      toResumeHistoryResult(payload([...items].reverse()), envelope).observations,
    );
  }
  const complete = applyResumeHistoryV2(
    second.envelope,
    toResumeHistoryResult(
      payload([{ ...raw, attribution, resumeEvidence: proof }]),
      second.envelope,
    ),
  );
  assert.deepEqual(complete.envelope.resume.observations[0].resumeEvidence, proof);
  assert.equal(complete.envelope.resume.observations[0].attribution.selfId, 'self_301');
  assert.equal(complete.envelope.resume.observations[0].id, paired.id);
  const conflicting = {
    ...raw,
    attribution,
    resumeEvidence: { ...proof, text: '对方已查看了您的附件简历' },
  };
  assert.throws(
    () =>
      toResumeHistoryResult(
        payload([{ ...raw, attribution, resumeEvidence: proof }, conflicting]),
        envelope,
      ),
    /RESUME_SEMANTIC_EVIDENCE_CONFLICT/,
  );
  assert.throws(
    () =>
      applyResumeHistoryV2(
        complete.envelope,
        toResumeHistoryResult(payload([conflicting]), complete.envelope),
      ),
    /RESUME_SEMANTIC_EVIDENCE_CONFLICT/,
  );
  assert.deepEqual(complete.envelope.resume.observations[0].resumeEvidence, proof);
});

test('response contact and checked self identity share the gate across paged and compatibility reads', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  for (const scenario of [
    {
      name: 'complete synthetic message identity',
      job: 'candidate-job',
      reason: 'attribution_verified',
      status: 'verified',
    },
    {
      name: 'complete synthetic message identity with tilde job ID',
      candidateJob: 'candidate~job',
      job: 'candidate~job',
      reason: 'attribution_verified',
      status: 'verified',
    },
    {
      name: 'complete synthetic message identity with 300 character job ID',
      candidateJob: 'a'.repeat(299) + '~',
      job: 'a'.repeat(299) + '~',
      reason: 'attribution_verified',
      status: 'verified',
    },
    {
      name: 'message belongs to another job',
      job: 'other-job',
      reason: 'attribution_job_conflict',
      status: 'conflict',
    },
    {
      name: 'message uses conversation association without its own job identity',
      reason: 'attribution_conversation_association',
      status: 'verified',
    },
    ...['bad id', 'job/id', 'job.id', 'a'.repeat(300) + '~'].map((job) => ({
      name: `unsupported synthetic message job ID (${job.length} characters)`,
      job,
      extractedJob: null,
      reason: 'attribution_conversation_association',
      status: 'verified',
    })),
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
      name: 'unsupported participant ID remains unavailable',
      sender: 'sender~101',
      reason: 'attribution_participants_missing',
      status: 'insufficient',
    },
    {
      name: 'self sources disagree',
      storeSelf: 102,
      reason: 'attribution_participants_missing',
      status: 'insufficient',
    },
  ]) {
    const candidateJob = scenario.candidateJob ?? 'candidate-job';
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
    if (scenario.job) message.encryptJobId = scenario.job;
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
            { friendId: 301, friendSource: 0, uniqueId: '301-0', encryptJobId: candidateJob },
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
    const extractedJob = Object.hasOwn(scenario, 'extractedJob')
      ? scenario.extractedJob
      : (scenario.job ?? null);
    assert.equal(observation.externalJobId, extractedJob, scenario.name);
    assert.equal(observation.attribution.messageJobId, extractedJob, scenario.name);
    const result = assessBossAttribution(namespace, {
      ...observation,
      externalJobId: candidateJob,
      attribution: { ...observation.attribution, accountNamespace: namespace },
    });
    assert.equal(result.status, scenario.status, scenario.name);
    assert.equal(result.reason, scenario.reason, scenario.name);
    if (scenario.candidateJob) {
      const inputSnapshot = structuredClone(snapshot);
      inputSnapshot.records[0].jobAssociation = {
        jobId: candidateJob,
        detailUrl: `https://www.zhipin.com/job_detail/${candidateJob}.html`,
      };
      const { envelope } = createEnvelopeV2(inputSnapshot);
      const converted = toResumeHistoryResult(
        payload(JSON.parse(JSON.stringify(page.observations))),
        envelope,
      );
      assert.equal(converted.observations[0].externalJobId, candidateJob, scenario.name);
      assert.equal(converted.observations[0].attribution.messageJobId, candidateJob, scenario.name);
      const applied = applyResumeHistoryV2(envelope, converted);
      assert.equal(applied.envelope.resume.observations[0].id, converted.observations[0].id);
      assert.equal(applied.envelope.resume.observations[0].externalJobId, candidateJob);
      assert.equal(applied.envelope.resume.observations[0].attribution.messageJobId, candidateJob);
      const repeated = applyResumeHistoryV2(applied.envelope, converted);
      assert.equal(repeated.report.counts.added, 0);
      assert.equal(repeated.envelope.resume.observations[0].id, converted.observations[0].id);
    }
  }
});

test('history conversion accepts tilde job IDs without relaxing other observation identities', () => {
  const { envelope } = createEnvelopeV2(snapshot);
  const raw = {
    conversationKey,
    friendId: '301',
    friendSource: '0',
    messageId: 'synthetic-message',
    direction: 'outbound',
    messageType: 4,
    kind: 'sent_candidate',
    platformTime: '2026-09-20T01:00:00.000Z',
    externalJobId: 'job~301',
    source: 'geek_history_type_4',
  };
  const result = toResumeHistoryResult(payload([raw]), envelope);
  assert.equal(result.observations[0].externalJobId, 'job~301');
  for (const externalJobId of ['', 'bad id', 'job/id', 'job.id', 'a'.repeat(300) + '~'])
    assert.throws(
      () => toResumeHistoryResult(payload([{ ...raw, externalJobId }]), envelope),
      /RESUME_HISTORY_OBSERVATION_INVALID/,
    );
  for (const invalid of [
    { messageId: 'message~301' },
    { friendId: 'friend~301' },
    { friendSource: 'source~0' },
  ])
    assert.throws(
      () => toResumeHistoryResult(payload([{ ...raw, ...invalid }]), envelope),
      /RESUME_HISTORY_OBSERVATION_INVALID/,
    );
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  for (const invalid of [
    { target, identity: { bossId: 'boss~301', securityId: 'synthetic-security' } },
    {
      target: { ...target, friendId: 'friend~301' },
      identity: { bossId: '301', securityId: 'synthetic-security' },
    },
    {
      target: { ...target, friendSource: 'source~0' },
      identity: { bossId: '301', securityId: 'synthetic-security' },
    },
    { target, identity: { bossId: '301', securityId: 'synthetic security' } },
  ])
    assert.throws(
      () => createResumePageExpression({ ...invalid, page: 1 }),
      /RESUME_SCAN_INPUT_INVALID/,
    );
});

test('real page expressions and compatibility reads advance maxMsgId and use the 19-message boundary', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  const fixture = syntheticHistoryFixture((url) => {
    const tail = new URL(url).searchParams.get('maxMsgId') === '82';
    return {
      messages: Array.from({ length: tail ? 11 : 19 }, (_, index) => ({
        mid: String((tail ? 81 : 100) - index),
        type: 1,
        time: 1790000000,
      })),
      minMsgId: tail ? 71 : 82,
      hasMore: false,
    };
  });
  const first = await vm.runInNewContext(
    createResumePageExpression({
      target,
      identity: { bossId: 'boss_301', securityId: 'synthetic-security' },
      page: 1,
    }),
    fixture.context,
  );
  assert.equal(first.exhausted, false);
  assert.equal(first.nextCursor, '82');
  const result = await vm.runInNewContext(
    createResumeHistoryExpression({ targets: [target], pages: 2 }),
    fixture.context,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.unresolved), []);
  const pages = fixture.requests.filter((item) => item.url.includes('historyMsg'));
  assert.deepEqual(
    pages.map((item) => new URL(item.url).searchParams.get('maxMsgId')),
    ['0', '0', '82'],
  );
});

test('page cursors preserve decimal precision, reject unsafe response numbers and validate inputs', async () => {
  const target = { conversationKey, friendId: '301', friendSource: '0' };
  const options = {
    target,
    identity: { bossId: 'boss_301', securityId: 'synthetic-security' },
    page: 2,
  };
  for (const cursor of [1, '01', '-1', '1.5', 'raw secret', '', '0'.repeat(129)])
    assert.throws(
      () => createResumePageExpression({ ...options, maxMsgId: cursor }),
      /RESUME_SCAN_INPUT_INVALID/,
    );
  const fixture = syntheticHistoryFixture(() => ({
    messages: [{ mid: '90071992547409931', type: 1 }],
    hasMore: true,
  }));
  const result = await vm.runInNewContext(
    createResumePageExpression({ ...options, maxMsgId: '90071992547409932' }),
    fixture.context,
  );
  assert.equal(result.nextCursor, '90071992547409931');
  const unsafe = syntheticHistoryFixture(() => ({
    messages: [{ mid: 90071992547409930, type: 1 }],
    minMsgId: 90071992547409930,
    hasMore: true,
  }));
  const rejected = await vm.runInNewContext(createResumePageExpression(options), unsafe.context);
  assert.equal(rejected.nextCursor, null);
});

test('runner rejects a page hash array before issuing requests', async () => {
  await assert.rejects(
    runResumeHistoryRequests({
      targets: [{ conversationKey, friendId: '301', friendSource: '0' }],
      maxRequests: 1,
      initialPageHash: ['a'.repeat(64)],
      execute: async () => assert.fail('invalid recovery input must not issue a request'),
    }),
    /RESUME_SCAN_INPUT_INVALID/,
  );
});

test('history rejects repeated page sets and nonadvancing cursors instead of reporting truncation', async (t) => {
  for (const scenario of ['repeated', 'stalled', 'missing']) {
    await t.test(scenario, async () => {
      const checkpoints = [];
      const result = await runResumeHistoryRequests({
        targets: [{ conversationKey, friendId: '301', friendSource: '0' }],
        maxRequests: 3,
        pages: 2,
        requestDelayMs: 0,
        onCheckpoint: async (value) => checkpoints.push(value),
        execute: async (_expression, metadata) =>
          metadata.kind === 'friend'
            ? { ok: true, identity: { bossId: 'boss_301', securityId: 'synthetic-security' } }
            : {
                ok: true,
                observations: [],
                unresolved: [],
                exhausted: false,
                messageIds: [scenario === 'repeated' || metadata.page === 1 ? '100' : '80'],
                nextCursor:
                  scenario === 'missing'
                    ? null
                    : metadata.page === 1 || scenario === 'stalled'
                      ? '81'
                      : '70',
              },
      });
      const reason =
        scenario === 'repeated' ? 'HISTORY_PAGE_REPEATED' : 'HISTORY_CURSOR_NOT_ADVANCING';
      assert.equal(result.partial, true);
      assert.equal(result.payload.coverage.failedConversations, 1);
      assert.equal(result.payload.coverage.truncatedConversations, 0);
      assert.deepEqual(result.completed, []);
      assert.equal(result.payload.unresolved.at(-1).reason, reason);
      assert.equal(checkpoints.at(-1).unresolved.at(-1).reason, reason);
      assert.equal(result.usage.historyRequests, scenario === 'missing' ? 2 : 3);
    });
  }
});
