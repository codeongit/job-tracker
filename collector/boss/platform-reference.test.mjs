import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  REVIEWED_PLATFORM_REFERENCE,
  LOADED_PLATFORM_SCRIPT_URLS_EXPRESSION,
  parsePublicPlatformScriptUrl,
  assessLoadedPlatformReference,
  fingerprintPublicPlatformBytes,
  readLoadedPlatformReference,
  PLATFORM_REFERENCE_EXPRESSION,
} from './platform/platform-reference.mjs';
import { accountNamespace } from './platform/extract.mjs';

const app = 'https://static.zhipin.com/fe-zhipin-geek/web/chat-new/v5550/static/js/app.4d4a6ac8.js';
const chat =
  'https://static.zhipin.com/fe-zhipin-geek/web/chat-new/v5550/static/js/chat.4d4a6ac8.js';

test('reviewed exact URLs identify the code basis without claiming current byte verification', () => {
  const value = assessLoadedPlatformReference([chat, app, app]);
  assert.equal(value.status, 'known');
  assert.equal(value.referenceId, 'boss-chat-v5550-4d4a6ac8');
  assert.equal(value.platformContract, 'boss-action40-v5550-4d4a6ac8');
  assert.equal(value.basis, 'reviewed_url');
  assert.equal(value.contentVerified, false);
  assert.equal(value.opaqueActionAllowed, true);
  assert.equal(value.reason, null);
  assert.deepEqual(
    value.scripts.map((item) => item.role),
    ['app', 'chat'],
  );
  assert.equal(
    value.scripts[0].reviewedSha256,
    '4af4cb03e5db9c61dd841db1c55cb7ccd9d089afc48e0cb11ee967b20c801ebf',
  );
  assert.equal(REVIEWED_PLATFORM_REFERENCE.rawHistoryVerified, false);
});

test('changed builds, assets and mixed code disable only the opaque permission', () => {
  for (const urls of [
    [app.replace('v5550', 'v5551'), chat.replace('v5550', 'v5551')],
    [app.replace('4d4a6ac8', '01234567'), chat],
    [app, chat.replace('4d4a6ac8', '01234567')],
  ]) {
    const value = assessLoadedPlatformReference(urls);
    assert.equal(value.status, 'changed');
    assert.equal(value.reason, 'PLATFORM_REFERENCE_CHANGED');
    assert.equal(value.opaqueActionAllowed, false);
    assert.equal(value.referenceId, null);
    assert.equal(value.platformContract, null);
    assert.equal(value.contentVerified, false);
  }
});

test('missing or ambiguous loaded roles remain unavailable and cannot select a trusted version', () => {
  for (const urls of [[], [app], [chat], [app, chat, app.replace('4d4a6ac8', '01234567')]]) {
    const value = assessLoadedPlatformReference(urls);
    assert.equal(value.status, 'unavailable');
    assert.equal(value.reason, 'PLATFORM_REFERENCE_UNAVAILABLE');
    assert.equal(value.opaqueActionAllowed, false);
    assert.equal(value.platformContract, null);
  }
});

test('loaded reference reads use one bound evaluation with before and after account checks', async () => {
  const connection = { accountNamespace: accountNamespace('1001') };
  const payload = {
    ok: true,
    beforeAccountId: '1001',
    afterAccountId: '1001',
    reference: { ok: true, loadedScriptUrls: [app, chat] },
  };
  const evaluate = async (bound, expression, metadata) => {
    assert.equal(bound, connection);
    assert.equal(expression, PLATFORM_REFERENCE_EXPRESSION);
    assert.deepEqual(metadata, { kind: 'platform_reference' });
    assert.equal(/fetch\(|XMLHttpRequest|Debugger\.|getResourceContent/.test(expression), false);
    return structuredClone(payload);
  };
  assert.equal((await readLoadedPlatformReference({ connection, evaluate })).status, 'known');
  for (const value of [
    { ...payload, beforeAccountId: '1002' },
    { ...payload, afterAccountId: '1002' },
    { ...payload, beforeAccountId: null },
    { ok: false, reason: 'ACCOUNT_ID_UNVERIFIED' },
  ])
    await assert.rejects(
      readLoadedPlatformReference({ connection, evaluate: async () => value }),
      /ACCOUNT_/,
    );
  await assert.rejects(
    readLoadedPlatformReference({
      connection,
      evaluate: async () => {
        throw new Error('TASK_TARGET_CHANGED');
      },
    }),
    /TASK_TARGET_CHANGED/,
  );
  assert.equal(
    (
      await readLoadedPlatformReference({
        connection,
        evaluate: async () => ({
          ...payload,
          reference: { ok: false, reason: 'PLATFORM_REFERENCE_UNAVAILABLE' },
        }),
      })
    ).platformContract,
    null,
  );
});

test('script parsing excludes credentials, queries, fragments and unrelated resources', () => {
  for (const value of [
    app + '?token=synthetic-secret',
    app + '#synthetic-secret',
    app.replace('https://', 'https://user:secret@'),
    app.replace('https://', 'http://'),
    app.replace('static.zhipin.com', 'www.zhipin.com'),
    app.replace('/app.', '/492.'),
    'https://example.invalid/private-chat.js',
  ])
    assert.equal(parsePublicPlatformScriptUrl(value), null);
  assert.deepEqual(parsePublicPlatformScriptUrl(chat), {
    role: 'chat',
    url: chat,
    platformBuild: 'v5550',
    assetVersion: '4d4a6ac8',
  });
});

test('the full loaded-reference expression checks account identity twice without message access', () => {
  let reads = 0;
  const store = { state: { userInfo: { userId: '1001' } } };
  const row = {
    __vue__: { $options: { name: 'virtual-list' }, $props: { dataSources: [{}] }, $store: store },
  };
  const page = {};
  Object.defineProperty(page, 'uid', {
    get() {
      reads += 1;
      return '1001';
    },
  });
  const context = {
    URL,
    window: { _PAGE: page },
    location: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat' },
    document: {
      querySelectorAll: () => [row],
      scripts: [{ src: app }],
      visibilityState: 'hidden',
      hasFocus: () => false,
    },
    performance: { getEntriesByType: () => [{ initiatorType: 'script', name: chat }] },
    fetch: () => assert.fail('must not fetch'),
    XMLHttpRequest: () => assert.fail('must not request'),
  };
  const value = vm.runInNewContext(PLATFORM_REFERENCE_EXPRESSION, context);
  assert.equal(value.ok, true);
  assert.equal(reads, 2);
  assert.equal(value.beforeAccountId, '1001');
  assert.equal(value.afterAccountId, '1001');
  assert.equal(
    assessLoadedPlatformReference(Array.from(value.reference.loadedScriptUrls)).status,
    'known',
  );
  reads = 0;
  Object.defineProperty(store.state.userInfo, 'userId', {
    get() {
      return reads === 1 ? '1001' : '1002';
    },
  });
  const changed = vm.runInNewContext(PLATFORM_REFERENCE_EXPRESSION, context);
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'ACCOUNT_ID_UNVERIFIED');
});

test('the loaded URL expression reads DOM and timing metadata without fetching or exposing other URLs', () => {
  const calls = [];
  const value = vm.runInNewContext(LOADED_PLATFORM_SCRIPT_URLS_EXPRESSION, {
    URL,
    location: { origin: 'https://www.zhipin.com', pathname: '/web/geek/chat' },
    document: { scripts: [{ src: app }, { src: 'https://example.invalid/private.js?secret=x' }] },
    performance: {
      getEntriesByType(type) {
        calls.push(type);
        return [
          { initiatorType: 'script', name: chat },
          { initiatorType: 'xmlhttprequest', name: app },
          { initiatorType: 'script', name: chat + '?secret=x' },
        ];
      },
    },
    fetch: () => assert.fail('must not fetch'),
    XMLHttpRequest: () => assert.fail('must not request'),
  });
  assert.equal(value.ok, true);
  assert.deepEqual(Array.from(value.loadedScriptUrls), [app, chat]);
  assert.deepEqual(calls, ['resource']);
  assert.equal(JSON.stringify(value).includes('secret'), false);
});

test('explicit public-byte fingerprinting never promotes different content at a reviewed URL', () => {
  const value = fingerprintPublicPlatformBytes(app, Buffer.from('hello'));
  assert.equal(value.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(value.bytes, 5);
  assert.equal(value.contentMatchesReviewed, false);
  assert.equal(value.hashBasis, 'raw_bytes_sha256');
  assert.equal(JSON.stringify(value).includes('hello'), false);
  assert.throws(
    () =>
      fingerprintPublicPlatformBytes('https://example.invalid/private.js', Buffer.from('hello')),
    /PLATFORM_REFERENCE_INPUT_INVALID/,
  );
  assert.throws(
    () => fingerprintPublicPlatformBytes(app, Buffer.from([255])),
    /PUBLIC_SCRIPT_UTF8_INVALID/,
  );
});
