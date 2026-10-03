import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildIdentitySample, pageIdentityContext } from './identity-sample.mjs';

const target = { friendId: '301', friendSource: '0', conversationKey: 'private-conversation' };
const response = (zpData) => ({ ok: true, value: { code: 0, zpData } });
const field = (sample, path) => {
  const result = sample.fields.find((item) => item.path === path);
  assert.ok(result, path);
  return result;
};

test('friend sample preserves field provenance and equality without raw identities or credentials', () => {
  const sample = buildIdentitySample({
    stage: 'friend',
    target,
    identity: { bossId: 'boss_301', securityId: 'private-token' },
    account: { pageUid: 'self_1', storeUserId: ' self_1 ' },
    list: { friendId: 301, uid: 'different_uid', friendSource: 0 },
    response: response({
      result: [
        {
          uid: 'boss_301',
          friendId: '301',
          friendSource: '0',
          bossId: 'other_boss',
          securityId: 'private-token',
        },
      ],
    }),
  });
  assert.equal(sample.result, 'ok');
  assert.equal(field(sample, 'request.bossId').state, 'missing');
  assert.equal(
    field(sample, 'account.pageUid').identity,
    field(sample, 'account.storeUserId').identity,
  );
  assert.equal(field(sample, 'request.friendId').identity, field(sample, 'list.friendId').identity);
  assert.notEqual(field(sample, 'list.friendId').identity, field(sample, 'list.uid').identity);
  assert.equal(
    field(sample, 'selection.bossId').identity,
    field(sample, 'response.zpData.result[0].uid').identity,
  );
  assert.notEqual(
    field(sample, 'response.zpData.result[0].uid').identity,
    field(sample, 'response.zpData.result[0].bossId').identity,
  );
  for (const forbidden of ['private-conversation', 'private-token', 'boss_301', 'different_uid'])
    assert.equal(JSON.stringify(sample).includes(forbidden), false);
  const aliases = [...new Set(sample.fields.map((item) => item.identity).filter(Boolean))];
  assert.deepEqual(
    aliases,
    aliases.map((_, index) => `identity-${index + 1}`),
  );
});

test('history samples ordinary messages and every supported array and alias before filtering', () => {
  const sample = buildIdentitySample({
    stage: 'history',
    page: 1,
    target,
    identity: { bossId: 'boss_301' },
    response: response({
      messages: [
        {
          type: 1,
          mid: 'message_1',
          msgId: 'message_other',
          from: { uid: 'self_1' },
          to: { uid: 'boss_301' },
          jobId: 'job_1',
          body: { jobId: 'job_other', job: { encryptJobId: 'job_nested' } },
        },
      ],
      historyMsgList: [{ id: 'message_2', encryptJobId: 'job_2' }],
    }),
  });
  assert.equal(sample.arrays.length, 2);
  assert.equal(sample.arrays[0].sampled, 1);
  assert.equal(sample.arrays[1].sampled, 1);
  assert.equal(field(sample, 'selection.bossId').state, 'missing');
  assert.equal(
    field(sample, 'request.bossId').identity,
    field(sample, 'response.zpData.messages[0].to.uid').identity,
  );
  assert.notEqual(
    field(sample, 'response.zpData.messages[0].mid').identity,
    field(sample, 'response.zpData.messages[0].msgId').identity,
  );
  assert.notEqual(
    field(sample, 'response.zpData.messages[0].jobId').identity,
    field(sample, 'response.zpData.messages[0].body.jobId').identity,
  );
  assert.equal(field(sample, 'response.zpData.historyMsgList[0].id').state, 'present');
});

test('absence, null, invalid values, failed requests and empty arrays remain distinguishable', () => {
  const sample = buildIdentitySample({
    stage: 'history',
    page: 2,
    target: { friendId: undefined, friendSource: false },
    account: { pageUid: null, storeUserId: {} },
    list: { uid: [], uniqueId: Symbol('private-symbol'), encryptJobId: Infinity },
    response: response({ messages: [], historyMsgList: null }),
  });
  assert.deepEqual(sample.arrays, [
    { path: 'response.zpData.messages', state: 'present', count: 0, sampled: 0 },
    { path: 'response.zpData.historyMsgList', state: 'null', count: null, sampled: 0 },
  ]);
  for (const [path, type, state] of [
    ['account.pageUid', 'null', 'null'],
    ['account.storeUserId', 'object', 'invalid'],
    ['request.friendId', 'undefined', 'invalid'],
    ['request.friendSource', 'boolean', 'invalid'],
    ['list.friendId', 'missing', 'missing'],
    ['list.uid', 'array', 'invalid'],
    ['list.uniqueId', 'other', 'invalid'],
    ['list.encryptJobId', 'number', 'invalid'],
  ])
    assert.deepEqual(field(sample, path), { path, type, state, identity: null });
  for (const [payload, result] of [
    [{ ok: false, reason: 'private-error' }, 'request_failed'],
    [
      { ok: true, value: { code: 9, zpData: { result: [{ uid: 'should-not-read' }] } } },
      'response_unavailable',
    ],
    [undefined, 'response_unavailable'],
  ]) {
    const failed = buildIdentitySample({ stage: 'friend', target, response: payload });
    assert.equal(failed.result, result);
    assert.equal(failed.arrays[0].state, 'missing');
    assert.equal(
      failed.fields.some((item) => item.path.startsWith('response.')),
      false,
    );
  }
  assert.equal(
    buildIdentitySample({ stage: 'friend', target, response: response({ result: {} }) }).arrays[0]
      .state,
    'invalid',
  );
});

test('response sampling is bounded and never emits unknown keys, body text or raw values', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `private-message-${index}`,
    body: { content: 'private-resume-text', token: 'private-credential', jobId: 'x'.repeat(301) },
    'private-arbitrary-key': { uid: 'private-nested-identity' },
    from: { uid: Number.MAX_SAFE_INTEGER + 1 },
  }));
  const sample = buildIdentitySample({
    stage: 'history',
    page: 1,
    target,
    response: response({ messages: rows }),
  });
  assert.deepEqual(sample.arrays[0], {
    path: 'response.zpData.messages',
    state: 'present',
    count: 25,
    sampled: 20,
  });
  assert.equal(
    sample.fields.some((item) => item.path.includes('[20]')),
    false,
  );
  assert.equal(field(sample, 'response.zpData.messages[0].body.jobId').state, 'invalid');
  assert.equal(field(sample, 'response.zpData.messages[0].from.uid').state, 'invalid');
  assert.equal(JSON.stringify(sample).includes('private-'), false);
  assert.equal(JSON.stringify(sample).includes('x'.repeat(301)), false);
});

test('sample builder is self-contained and validates the fixed stage and page contract', () => {
  const input = { stage: 'friend', target, response: response({ result: [{ uid: 'boss_1' }] }) };
  assert.deepEqual(
    structuredClone(vm.runInNewContext(`(${buildIdentitySample.toString()})(input)`, { input })),
    buildIdentitySample(input),
  );
  for (const options of [
    { stage: 'other' },
    { stage: 'friend', page: 1 },
    { stage: 'history', page: 0 },
    { stage: 'history', page: 21 },
  ])
    assert.throws(() => buildIdentitySample(options), /IDENTITY_SAMPLE_INPUT_INVALID/);
});

function contextFor(sources, { accountId = 'self_1', storeId = 'self_1' } = {}) {
  const listVm = {
    $options: { name: 'virtual-list' },
    $props: { dataSources: sources },
    $store: { state: { userInfo: { userId: storeId, token: 'private-token' } } },
  };
  const listNode = { __vue__: listVm },
    row = { parentElement: listNode };
  return {
    window: { _PAGE: { uid: accountId, token: 'private-token' } },
    document: { querySelectorAll: () => [row] },
    target,
  };
}
const readContext = (context = {}) =>
  structuredClone(
    vm.runInNewContext(`(${pageIdentityContext.toString()})(target)`, { target, ...context }),
  );

test('page context reads only the unique matching list row and fixed account fields', () => {
  const matching = {
    friendId: '301',
    uid: 'other_uid',
    friendSource: 0,
    uniqueId: '301-0',
    encryptJobId: 'job_301',
    content: 'private-body',
    token: 'private-token',
  };
  const sources = [
    { ...matching, friendSource: '1', uniqueId: '301-1' },
    matching,
    { friendId: 'other_friend', friendSource: '0' },
  ];
  const before = structuredClone(sources);
  assert.deepEqual(readContext(contextFor(sources)), {
    account: { pageUid: 'self_1', storeUserId: 'self_1' },
    list: {
      friendId: '301',
      uid: 'other_uid',
      friendSource: 0,
      uniqueId: '301-0',
      encryptJobId: 'job_301',
    },
  });
  assert.deepEqual(sources, before);
  assert.equal(readContext(contextFor([matching, matching])).list, null);
  assert.equal(readContext(contextFor([{ ...matching, friendId: 'different' }])).list, null);
  assert.deepEqual(readContext(), { account: {}, list: null });
});

test('page context cannot expose nested values stored in whitelisted identity fields', () => {
  const context = contextFor(
    [
      {
        friendId: '301',
        friendSource: '0',
        uniqueId: { text: 'private-nested-content' },
        encryptJobId: ['private-nested-content'],
      },
    ],
    { accountId: { token: 'private-nested-content' } },
  );
  const value = readContext(context);
  assert.deepEqual(value.account.pageUid, {});
  assert.deepEqual(value.list.uniqueId, {});
  assert.deepEqual(value.list.encryptJobId, []);
  assert.equal(JSON.stringify(value).includes('private-'), false);
});
