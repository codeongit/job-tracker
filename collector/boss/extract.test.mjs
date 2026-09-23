import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { accountExpression, expression, toSnapshot } from './extract.mjs';

const unknown = { status: 'unknown', label: null, source: null };
const baseItem = {
  friendId: '101',
  friendSource: '0',
  uniqueId: '101-0',
  contact: '示例联系人',
  company: '示例公司',
  title: '招聘',
  preview: '列表摘要',
  timeLabel: '昨天',
  unread: null,
  latestMessageId: '9001',
  outgoingReceipt: unknown,
  receiptObservationSource: 'offscreen_unknown',
  rendered: false,
  domIdentityMatches: null,
  encryptJobId: 'safeJob_1',
  jobName: '后端工程师',
};
const payload = (overrides) => ({
  ok: true,
  url: 'https://www.zhipin.com/web/geek/chat',
  accountId: '7001',
  capturedAt: '2026-09-18T08:00:00.000Z',
  items: [{ ...baseItem }],
  unresolved: [],
  loadedRows: 1,
  loadedDataRows: 1,
  truncated: false,
  unreadCapability: 'unavailable',
  outgoingReceiptCapability: 'rendered_dom_only',
  jobCapability: 'loaded_chat_state',
  ...overrides,
});

test('platform identity is stable across mutable labels and namespaced by account', () => {
  const first = toSnapshot(payload());
  const renamed = toSnapshot(
    payload({ items: [{ ...baseItem, contact: '新名字', company: '新公司', preview: '更新' }] }),
  );
  const otherAccount = toSnapshot(payload({ accountId: '7002' }));
  assert.equal(first.records[0].key, renamed.records[0].key);
  assert.notEqual(first.records[0].key, otherAccount.records[0].key);
  assert.equal(first.identityMethod, 'account_friend_id_and_source');
  assert.deepEqual(first.records[0].platformIdentity, {
    friendId: '101',
    friendSource: '0',
    uniqueId: '101-0',
  });
});

test('job id becomes a canonical association while the actual jobName stays distinct', () => {
  const record = toSnapshot(payload()).records[0];
  assert.deepEqual(record.jobAssociation, {
    jobId: 'safeJob_1',
    detailUrl: 'https://www.zhipin.com/job_detail/safeJob_1.html',
    source: 'loaded_chat_state',
  });
  assert.equal(record.observedJobName, '后端工程师');
  assert.equal(record.title, '招聘');
});

test('invalid account, placeholder identities, duplicate platform ids, and unsafe jobs fail closed', () => {
  assert.throws(() => toSnapshot(payload({ accountId: '0' })), /ACCOUNT_ID_INVALID/);
  assert.throws(
    () => toSnapshot(payload({ items: [{ ...baseItem, friendId: '-1', uniqueId: '-1-0' }] })),
    /CAPTURE_PLATFORM_ID_INVALID/,
  );
  assert.throws(
    () => toSnapshot(payload({ items: [baseItem, { ...baseItem }], loadedDataRows: 2 })),
    /CAPTURE_DUPLICATE_PLATFORM_ID/,
  );
  assert.throws(
    () => toSnapshot(payload({ items: [{ ...baseItem, encryptJobId: 'bad/id' }] })),
    /CAPTURE_JOB_ID_INVALID/,
  );
});

function browserContext({ accountId = '7001', receipt = true } = {}) {
  const source = {
    friendId: '101',
    friendSource: 0,
    uniqueId: '101-0',
    name: '示例联系人',
    brandName: '示例公司',
    title: '招聘',
    lastText: '状态摘要',
    lastMsgId: '9001',
    encryptJobId: 'safeJob_1',
    jobName: '后端工程师',
  };
  const spans = [
    { tagName: 'SPAN', innerText: '示例联系人' },
    { tagName: 'SPAN', innerText: '示例公司' },
    { tagName: 'SPAN', innerText: '招聘' },
  ];
  const classList = ['message-status', 'status-read'];
  classList.contains = (value) => classList.includes(value);
  const marker = { tagName: 'I', innerText: '[已读]', classList, getClientRects: () => [{}] };
  const targets = {
    '.name-box': { children: spans },
    '.last-msg': { children: receipt ? [marker] : [] },
    '.last-msg-text': { innerText: '状态摘要' },
    '.time': { innerText: '12:00' },
  };
  const container = {
    parentElement: null,
    __vue__: {
      $options: { name: 'virtual-list' },
      $props: { dataSources: [source] },
      $store: { state: { userInfo: { userId: accountId } } },
    },
  };
  const row = {
    parentElement: container,
    __vue__: { $props: { source } },
    querySelector: (selector) => targets[selector] ?? null,
  };
  const document = {
    querySelectorAll: (selector) => (selector === 'li[role="listitem"]' ? [row] : []),
    visibilityState: 'visible',
    hasFocus: () => false,
  };
  return {
    location: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat' },
    document,
    window: { _PAGE: { uid: accountId } },
    getComputedStyle: () => ({ display: 'inline', visibility: 'visible', opacity: '1' }),
  };
}

test('page extractor reads loaded state and only accepts explicit rendered DOM receipts', () => {
  const result = vm.runInNewContext(expression, browserContext());
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].outgoingReceipt.status, 'read');
  assert.equal(result.items[0].receiptObservationSource, 'rendered_dom');
  assert.equal(result.documentFocused, false);
  assert.equal(toSnapshot(result).records[0].latestMessageId, '9001');
});

test('connect identity requires the page and Vue store account ids to agree', () => {
  const good = vm.runInNewContext(accountExpression, browserContext());
  assert.equal(good.ok, true);
  const context = browserContext();
  context.window._PAGE.uid = 'other';
  const bad = vm.runInNewContext(accountExpression, context);
  assert.deepEqual({ ...bad }, { ok: false, reason: 'ACCOUNT_ID_UNVERIFIED' });
});

test('wrong page guard runs before DOM access', () => {
  const context = {
    location: { origin: 'https://example.com', pathname: '/' },
    window: {},
    get document() {
      throw new Error('DOM must not be accessed');
    },
  };
  assert.equal(vm.runInNewContext(expression, context).reason, 'WRONG_PAGE');
  assert.equal(vm.runInNewContext(accountExpression, context).reason, 'WRONG_PAGE');
});
