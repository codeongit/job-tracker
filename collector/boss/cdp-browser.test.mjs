import test from 'node:test';
import assert from 'node:assert/strict';
import { createCdpController } from './cdp-browser.mjs';

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
      const target = targets.find((item) => item.webSocketDebuggerUrl === endpoint);
      return { url: target.url, title: '「平台工程师招聘」_公司甲招聘-BOSS直聘' };
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
  assert.equal((await adapter.readOwnedTab(handle)).url, first);
  await adapter.navigateOwnedTab(handle, {
    ownerToken: 'owner-1',
    expectedUrl: first,
    nextUrl: second,
  });
  assert.equal((await adapter.readOwnedTab(handle)).url, second);
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
