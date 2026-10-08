import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createCdpController, DETAIL_PAGE_STATE_EXPRESSION } from './cdp-browser.mjs';
import { accountExpression, expression as loadedListExpression } from './extract.mjs';

const url = 'https://www.zhipin.com/web/geek/chat';

function fixture({ initialUrl = url, identity = '12345' } = {}) {
  const calls = [];
  const target = {
    id: 'task-page',
    type: 'page',
    url: initialUrl === null ? 'about:blank' : initialUrl,
    webSocketDebuggerUrl: 'ws://task-page',
  };
  const cdpFactory = async (endpoint) => {
    calls.push(['attach', endpoint]);
    return {
      navigate: async (next) => {
        calls.push(['navigate', next]);
        target.url = next;
      },
      evaluate: async (expression) =>
        expression === 'IDENTITY'
          ? { ok: true, url, accountId: identity }
          : { ok: true, url, loadedDataRows: 4 },
      close: async () => {
        calls.push(['detach', endpoint]);
      },
    };
  };
  const fetchImpl = async (request) => {
    const requestUrl = String(request);
    if (requestUrl.endsWith('/json/version')) {
      const port = new URL(requestUrl).port;
      return {
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test-browser`,
        }),
      };
    }
    if (requestUrl.endsWith('/json/list'))
      return { ok: true, json: async () => [structuredClone(target)] };
    throw new Error('UNEXPECTED_FETCH');
  };
  const controller = createCdpController({
    fetchImpl,
    cdpFactory,
    now: () => new Date('2026-09-21T10:00:00.000Z'),
    wait: async () => {},
  });
  return { controller, calls, target };
}

function loadedListFixture({ isReady = () => true, onWait = () => {}, pageError = null } = {}) {
  const calls = [];
  const state = {
    clock: Date.parse('2026-09-21T10:00:00.000Z'),
    ready: true,
    accountId: '7001',
    instance: 'synthetic-browser',
    targetId: 'task-page',
    targetUrl: url,
    identityReads: 0,
    listReads: 0,
  };
  const source = {
    friendId: '101',
    friendSource: 0,
    uniqueId: '101-0',
    name: '示例联系人',
    brandName: '示例公司',
    lastMsgId: '9001',
  };
  const pageContext = (value) => ({
    location: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat' },
    window: { _PAGE: { uid: state.accountId } },
    document: {
      querySelectorAll: () =>
        state.ready && isReady(value, state)
          ? [
              {
                parentElement: null,
                __vue__: {
                  $options: { name: 'virtual-list' },
                  $props: { dataSources: [source] },
                  $store: { state: { userInfo: { userId: state.accountId } } },
                },
                querySelector: (selector) =>
                  selector === '.name-box'
                    ? {
                        children: [source.name, source.brandName, '招聘'].map((innerText) => ({
                          tagName: 'SPAN',
                          innerText,
                        })),
                      }
                    : null,
              },
            ]
          : [],
      visibilityState: 'hidden',
      hasFocus: () => false,
    },
  });
  const controller = createCdpController({
    fetchImpl: async (request) => ({
      ok: true,
      json: async () =>
        String(request).endsWith('/json/version')
          ? {
              webSocketDebuggerUrl: `ws://127.0.0.1:${new URL(request).port}/devtools/browser/${state.instance}`,
            }
          : [
              {
                id: state.targetId,
                type: 'page',
                url: state.targetUrl,
                webSocketDebuggerUrl: 'ws://synthetic-task',
              },
            ],
    }),
    cdpFactory: async () => ({
      evaluate: async (value) => {
        calls.push(['evaluate', value === accountExpression ? 'identity' : 'list']);
        if (value === accountExpression) state.identityReads += 1;
        else state.listReads += 1;
        return pageError
          ? { ok: false, reason: pageError }
          : vm.runInNewContext(value, pageContext(value));
      },
      close: async () => {},
      navigate: async () => {
        throw new Error('UNEXPECTED_NAVIGATION');
      },
      command: async () => {
        throw new Error('UNEXPECTED_TARGET_MUTATION');
      },
    }),
    now: () => new Date(state.clock),
    wait: async (milliseconds) => {
      calls.push(['wait', milliseconds]);
      state.clock += milliseconds;
      onWait(state);
    },
    spawnImpl: () => {
      throw new Error('UNEXPECTED_BROWSER_LAUNCH');
    },
  });
  const options = {
    account: 'main',
    identityExpression: accountExpression,
    extractAccountIdentity: (payload) => payload.accountId,
  };
  return { controller, calls, state, options };
}

test('binding entry points wait for the loaded list on the same task page', async () => {
  for (const method of ['start', 'connect', 'recoverPage']) {
    const value = loadedListFixture({ onWait: (state) => (state.ready = true) });
    value.state.ready = false;
    const bound = await value.controller[method](value.options);
    assert.equal(bound.ok, true, `${method}: ${JSON.stringify(bound.report)}`);
    assert.deepEqual(
      value.calls.filter(([kind]) => kind === 'wait'),
      [['wait', 500]],
    );
    assert.equal(bound.connection.taskTargetId, 'task-page');
  }
});

test('capture waits when the loaded list mounts before, during or after extraction', async () => {
  for (const phase of ['before', 'list', 'after']) {
    const value = loadedListFixture({
      isReady: (expression, state) => {
        if (state.readyOnce) return true;
        return !(
          (phase === 'before' && state.identityReads > 1) ||
          (phase === 'list' && expression === loadedListExpression) ||
          (phase === 'after' && state.identityReads > 2)
        );
      },
      onWait: (state) => (state.readyOnce = true),
    });
    const bound = await value.controller.connect(value.options);
    assert.equal(bound.ok, true);
    const captured = await value.controller.capture(
      bound.connection,
      loadedListExpression,
      value.options,
    );
    assert.equal(captured.ok, true, `${phase}: ${JSON.stringify(captured.report)}`);
    assert.equal(captured.payload.items.length, 1);
    assert.deepEqual(
      value.calls.filter(([kind]) => kind === 'wait'),
      [['wait', 500]],
    );
  }
});

test('resume waits for a temporarily missing loaded list without changing the target', async () => {
  const value = loadedListFixture({ onWait: (state) => (state.ready = true) });
  const bound = await value.controller.connect(value.options);
  value.state.ready = false;
  const resumed = await value.controller.resume(bound.connection, value.options);
  assert.equal(resumed.ok, true, JSON.stringify(resumed.report));
  assert.equal(resumed.connection.taskTargetId, bound.connection.taskTargetId);
  assert.deepEqual(
    value.calls.filter(([kind]) => kind === 'wait'),
    [['wait', 500]],
  );
});

test('a persistent missing loaded list stops within the readiness budget with its original error', async () => {
  const value = loadedListFixture();
  const bound = await value.controller.connect(value.options);
  value.state.ready = false;
  const captured = await value.controller.capture(
    bound.connection,
    loadedListExpression,
    value.options,
  );
  assert.equal(captured.ok, false);
  assert.equal(captured.report.error, 'LOADED_LIST_NOT_READY');
  assert.equal(captured.payload, null);
  const waits = value.calls.filter(([kind]) => kind === 'wait');
  assert.equal(waits.length, 20);
  assert.equal(
    waits.reduce((sum, [, milliseconds]) => sum + milliseconds, 0),
    10_000,
  );
  assert.equal(value.state.listReads, 0);
});

test('capture shares one readiness window across identity and list extraction', async () => {
  let waits = 0;
  const value = loadedListFixture({
    isReady: (expression, state) =>
      state.identityReads === 1 ||
      (expression === accountExpression && waits >= 10) ||
      (expression === loadedListExpression && waits > 20),
    onWait: () => (waits += 1),
  });
  const bound = await value.controller.connect(value.options);
  assert.equal(bound.ok, true);
  const captured = await value.controller.capture(
    bound.connection,
    loadedListExpression,
    value.options,
  );
  assert.equal(captured.ok, false);
  assert.equal(captured.report.error, 'LOADED_LIST_NOT_READY');
  assert.equal(waits, 20);
  assert.equal(value.state.listReads, 11);
  assert.equal(value.state.clock - Date.parse('2026-09-21T10:00:00.000Z'), 10_000);
});

test('readiness waiting rechecks the bound browser, target, URL and account', async () => {
  for (const [mutate, expectedError] of [
    [(state) => (state.instance = 'replacement-browser'), 'BROWSER_INSTANCE_CHANGED'],
    [(state) => (state.targetId = 'replacement-task'), 'TASK_TARGET_MISSING'],
    [(state) => (state.targetUrl = 'https://www.zhipin.com/web/user/'), 'TASK_TARGET_DRIFTED'],
    [(state) => (state.accountId = '7002'), 'ACCOUNT_NAMESPACE_CHANGED'],
  ]) {
    const value = loadedListFixture({
      onWait: (state) => {
        state.ready = true;
        mutate(state);
      },
    });
    const bound = await value.controller.connect(value.options);
    value.state.ready = false;
    const captured = await value.controller.capture(
      bound.connection,
      loadedListExpression,
      value.options,
    );
    assert.equal(captured.ok, false, expectedError);
    assert.equal(captured.report.error, expectedError);
    assert.equal(captured.payload, null);
    assert.equal(value.calls.filter(([kind]) => kind === 'wait').length, 1);
  }
});

test('readiness waiting does not retry other page identity or security errors', async () => {
  for (const pageError of [
    'WRONG_PAGE',
    'ACCOUNT_ID_UNVERIFIED',
    'LOADED_LIST_SIZE_INVALID',
    'LOGIN_REQUIRED',
    'CAPTCHA_REQUIRED',
  ]) {
    const value = loadedListFixture({ pageError });
    const bound = await value.controller.connect(value.options);
    assert.equal(bound.ok, false);
    assert.equal(bound.report.error, pageError);
    assert.equal(value.calls.filter(([kind]) => kind === 'wait').length, 0);
    assert.equal(value.state.identityReads, 1);
  }
});

test('CDP connect and capture reuse the exact task page without navigation', async () => {
  const value = fixture();
  const connected = await value.controller.connect({
    account: 'main',
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  assert.equal(connected.ok, true, JSON.stringify(connected.report));
  assert.equal(connected.connection.kind, 'cdp_bound');
  assert.equal(connected.connection.taskTargetId, 'task-page');
  assert.match(connected.connection.browserInstanceId, /^[a-f0-9]{64}$/);
  assert.equal(
    value.calls.some((call) => call[0] === 'navigate'),
    false,
  );

  const read = await value.controller.capture(connected.connection, 'READ', {
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  assert.equal(read.ok, true, JSON.stringify(read.report));
  assert.equal(read.payload.loadedDataRows, 4);
  assert.equal(
    value.calls.some((call) => call[0] === 'navigate'),
    false,
  );
  assert.equal(
    value.calls.filter((call) => call[0] === 'attach').length,
    value.calls.filter((call) => call[0] === 'detach').length,
  );
});

test('CDP connect navigates the one dedicated blank page exactly once and detaches', async () => {
  const value = fixture({ initialUrl: null });
  const connected = await value.controller.connect({
    account: 'main',
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  assert.equal(connected.ok, true, JSON.stringify(connected.report));
  assert.deepEqual(
    value.calls.filter((call) => call[0] === 'navigate'),
    [['navigate', url]],
  );
  assert.equal(
    value.calls.filter((call) => call[0] === 'attach').length,
    value.calls.filter((call) => call[0] === 'detach').length,
  );
});

test('explicit recover-page may rebuild one missing task page exactly once', async () => {
  const value = fixture({ initialUrl: null });
  const recovered = await value.controller.recoverPage({
    account: 'main',
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.report));
  assert.deepEqual(
    value.calls.filter((call) => call[0] === 'navigate'),
    [['navigate', url]],
  );
});

test('CDP capture rejects a changed account without returning page data', async () => {
  const first = fixture({ identity: '12345' });
  const connected = await first.controller.connect({
    account: 'main',
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  const second = fixture({ identity: '99999' });
  const read = await second.controller.capture(connected.connection, 'READ', {
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  assert.equal(read.ok, false);
  assert.equal(read.report.error, 'ACCOUNT_NAMESPACE_CHANGED');
  assert.equal(read.payload, null);
  assert.equal(
    second.calls.filter((call) => call[0] === 'attach').length,
    second.calls.filter((call) => call[0] === 'detach').length,
  );
});

test('CDP capture never creates or navigates when the bound task page is absent', async () => {
  const first = fixture();
  const connected = await first.controller.connect({
    account: 'main',
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  const second = fixture({ initialUrl: null });
  const read = await second.controller.capture(connected.connection, 'READ', {
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  assert.equal(read.ok, false);
  assert.equal(read.report.error, 'TASK_TARGET_DRIFTED');
  assert.equal(
    second.calls.some((call) => call[0] === 'navigate'),
    false,
  );
});

test('resume refuses a restarted browser instance and never navigates', async () => {
  const first = fixture();
  const connected = await first.controller.start({
    account: 'main',
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  const second = fixture();
  const original = second.controller;
  const changed = { ...connected.connection, browserInstanceId: 'a'.repeat(64) };
  const resumed = await original.resume(changed, {
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  assert.equal(resumed.ok, false);
  assert.equal(resumed.report.error, 'BROWSER_INSTANCE_CHANGED');
  assert.equal(
    second.calls.some((call) => call[0] === 'navigate'),
    false,
  );
});

test('CDP detail adapter creates, navigates, reads and closes only its owned target', async () => {
  const calls = [];
  const document = { readyState: 'loading', timeOrigin: 1000, documentUrl: null };
  const targets = [{ id: 'task-page', type: 'page', url, webSocketDebuggerUrl: 'ws://task-page' }];
  const fetchImpl = async (request) => {
    const requestUrl = String(request),
      port = new URL(requestUrl).port;
    if (requestUrl.endsWith('/json/version'))
      return {
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test-browser`,
        }),
      };
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
        targets.splice(index, 1);
        return { success: true };
      }
      throw new Error('UNEXPECTED_COMMAND');
    },
    async navigate(next) {
      const target = targets.find((item) => item.webSocketDebuggerUrl === endpoint);
      target.url = next;
    },
    async evaluate(expression) {
      if (expression === 'IDENTITY') return { ok: true, url, accountId: '12345' };
      assert.equal(expression, DETAIL_PAGE_STATE_EXPRESSION);
      const target = targets.find((item) => item.webSocketDebuggerUrl === endpoint);
      return {
        url: target.url,
        title: '「平台工程师招聘」_公司甲招聘-BOSS直聘',
        readyState: document.readyState,
        timeOrigin: document.timeOrigin,
        documentUrl: document.documentUrl ?? target.url,
      };
    },
    async close() {},
  });
  const controller = createCdpController({
    fetchImpl,
    cdpFactory,
    wait: async () => {},
    now: () => new Date('2026-09-21T10:00:00.000Z'),
  });
  const bound = await controller.start({
    account: 'main',
    identityExpression: 'IDENTITY',
    extractAccountIdentity: (payload) => payload.accountId,
  });
  const adapter = controller.createDetailAdapter(bound.connection);
  const first = 'https://www.zhipin.com/job_detail/job_a.html';
  const second = 'https://www.zhipin.com/job_detail/job_b.html';
  const handle = await adapter.createOwnedTab({ ownerToken: 'owner-1', initialUrl: first });
  const loading = await adapter.readOwnedTab(handle);
  assert.equal(loading.url, first);
  assert.equal(loading.documentReady, false);
  document.readyState = 'complete';
  document.documentUrl = second;
  assert.equal((await adapter.readOwnedTab(handle)).documentReady, false);
  document.documentUrl = first;
  assert.equal((await adapter.readOwnedTab(handle)).documentReady, true);
  await adapter.navigateOwnedTab(handle, {
    ownerToken: 'owner-1',
    expectedUrl: first,
    nextUrl: second,
  });
  document.documentUrl = second;
  const oldDocument = await adapter.readOwnedTab(handle);
  assert.equal(oldDocument.url, second);
  assert.equal(oldDocument.documentReady, false);
  document.timeOrigin = 2000;
  const newDocument = await adapter.readOwnedTab(handle);
  assert.equal(newDocument.documentReady, true);
  assert.equal(newDocument.title, oldDocument.title);
  document.timeOrigin = undefined;
  await assert.rejects(() => adapter.readOwnedTab(handle), /DETAIL_TAB_READ_INVALID/);
  document.timeOrigin = 2000;
  document.readyState = 'unknown';
  await assert.rejects(() => adapter.readOwnedTab(handle), /DETAIL_TAB_READ_INVALID/);
  document.readyState = 'complete';
  await adapter.closeOwnedTab(handle, { ownerToken: 'owner-1', expectedUrl: second });
  assert.equal(
    targets.some((target) => target.id === 'detail-page'),
    false,
  );
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['Target.createTarget', 'Target.closeTarget'],
  );
});
