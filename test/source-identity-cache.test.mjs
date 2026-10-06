import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { emptyData, validateData } from '../dist/model.js';
import { migrateData } from '../dist/workspace.js';
import { upgradeSourceLedger } from '../dist/source-ledger.js';
import { bossFactId, createBossFactIdResolver } from '../dist/source-identity.js';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const STAMP = '2026-10-06T00:00:00.000Z';
const identity = (more = {}) => ({
  platform: 'boss',
  accountNamespace: ACCOUNT,
  conversationKey: 'b'.repeat(64),
  messageId: 'synthetic-message',
  factType: 'message_observed',
  ...more,
});

// This native SHA implementation is independent of the dependency-free browser hash.
function historicalId(event) {
  return (
    'boss-fact-' +
    createHash('sha256')
      .update(
        JSON.stringify([
          'boss-fact-v1',
          event.platform || 'boss',
          event.accountNamespace,
          event.conversationKey,
          event.messageId,
          event.factType,
        ]),
      )
      .digest('hex')
  );
}

function validData() {
  const data = emptyData();
  data.sourceBindings.push({
    id: `boss-account-${'a'.repeat(64)}`,
    kind: 'account',
    platform: 'boss',
    accountNamespace: ACCOUNT,
    workspaceSourceId: '00000000-0000-4000-8000-000000000001',
    createdAt: STAMP,
  });
  const event = {
    id: `boss-event-${'c'.repeat(64)}`,
    batchId: `boss-batch-${'d'.repeat(64)}`,
    platform: 'boss',
    accountNamespace: ACCOUNT,
    conversationKey: 'b'.repeat(64),
    friendId: 'synthetic-friend',
    friendSource: 'synthetic-source',
    uniqueId: 'synthetic-friend-synthetic-source',
    externalJobId: 'synthetic-job',
    opportunityId: '',
    eventType: 'conversation_observed',
    messageId: 'synthetic-message',
    messageDirection: 'unknown',
    receiptStatus: 'unknown',
    receiptSource: '',
    summary: 'Synthetic evidence',
    timeLabel: '',
    contact: 'Synthetic contact',
    company: 'Synthetic company',
    jobName: '',
    nameSource: '',
    canonicalUrl: 'https://www.zhipin.com/job_detail/synthetic-job.html',
    linkConfirmation: 'unverified',
    observedAt: STAMP,
    evidenceDate: '',
    appliedAtSource: '',
    sourceSnapshot: `synthetic.json#sha256:${'e'.repeat(64)}`,
    sourceSequence: '1',
    status: 'review',
    importPolicy: 'boss-manual-check-v1',
    createdAt: STAMP,
  };
  event.factId = bossFactId(event);
  data.sourceEvents.push(event);
  return validateData(upgradeSourceLedger(data));
}

test('cached facts retain historical SHA identities including UTF-8 and escaped text', () => {
  const resolver = createBossFactIdResolver();
  for (const event of [
    identity(),
    identity({ messageId: '合成消息😀\"\\\n' }),
    identity({ messageId: '\ud800' }),
    identity({ platform: undefined }),
  ]) {
    assert.equal(resolver.factId(event), historicalId(event));
    assert.equal(resolver.factId(structuredClone(event)), historicalId(event));
  }
  assert.equal(resolver.stats().hits, 5);
});

test('every identity component invalidates reuse while supplied IDs and labels cannot choose the result', () => {
  const resolver = createBossFactIdResolver();
  const original = identity();
  const first = resolver.factId(original);
  for (const change of [
    { platform: 'synthetic-platform' },
    { accountNamespace: `boss-geek:${'f'.repeat(64)}` },
    { conversationKey: 'f'.repeat(64) },
    { messageId: 'synthetic-other-message' },
    { factType: 'message_receipt_read' },
  ]) {
    const changed = { ...original, ...change };
    assert.equal(resolver.factId(changed), historicalId(changed));
    assert.notEqual(resolver.factId(changed), first);
  }
  assert.equal(
    resolver.factId({
      ...original,
      factId: `boss-fact-${'0'.repeat(64)}`,
      externalJobId: 'unrelated-candidate',
      company: 'Changed label',
      summary: 'Changed ordinary message label',
      observedAt: '2026-10-07T00:00:00.000Z',
    }),
    first,
  );
  assert.equal(resolver.stats().entries, 6);
  original.messageId = 'mutated-same-object';
  assert.equal(resolver.factId(original), historicalId(original));
  assert.notEqual(resolver.factId(original), first);
});

test('count limit evicts least recently used identity without changing any result', () => {
  const resolver = createBossFactIdResolver({ maxEntries: 2 });
  const a = identity({ messageId: 'synthetic-a' });
  const b = identity({ messageId: 'synthetic-b' });
  const c = identity({ messageId: 'synthetic-c' });
  for (const event of [a, b, a, c, a, b]) assert.equal(resolver.factId(event), historicalId(event));
  assert.deepEqual(
    { ...resolver.stats(), bytes: 0 },
    { entries: 2, bytes: 0, hits: 2, misses: 4, evictions: 2 },
  );
  const snapshot = resolver.stats();
  snapshot.entries = 100000;
  assert.equal(resolver.stats().entries, 2);
});

test('byte budget independently evicts retained identities and exposes only numeric counters', () => {
  const resolver = createBossFactIdResolver({ maxEntries: 10, maxBytes: 1000 });
  for (const messageId of ['synthetic-byte-a', 'synthetic-byte-b', 'synthetic-byte-c']) {
    const event = identity({ messageId });
    assert.equal(resolver.factId(event), historicalId(event));
    assert.ok(resolver.stats().bytes <= 1000);
  }
  assert.equal(resolver.stats().entries, 1);
  assert.equal(resolver.stats().evictions, 2);
  assert.deepEqual(Object.keys(resolver.stats()).sort(), [
    'bytes',
    'entries',
    'evictions',
    'hits',
    'misses',
  ]);
  assert.ok(Object.values(resolver.stats()).every(Number.isSafeInteger));
});

test('oversized and zero-retention inputs remain correct without clearing a useful retained entry', () => {
  const resolver = createBossFactIdResolver({ maxBytes: 2048 });
  const small = identity();
  assert.equal(resolver.factId(small), historicalId(small));
  const retainedBytes = resolver.stats().bytes;
  const large = identity({ messageId: '合'.repeat(2500) });
  assert.equal(resolver.factId(large), historicalId(large));
  assert.equal(resolver.factId(large), historicalId(large));
  assert.equal(resolver.factId(small), historicalId(small));
  assert.deepEqual(resolver.stats(), {
    entries: 1,
    bytes: retainedBytes,
    hits: 1,
    misses: 3,
    evictions: 0,
  });
  for (const limits of [{ maxEntries: 0 }, { maxBytes: 0 }, { maxBytes: 128 }]) {
    const disabled = createBossFactIdResolver(limits);
    assert.equal(disabled.factId(small), historicalId(small));
    assert.equal(disabled.factId(small), historicalId(small));
    assert.deepEqual(disabled.stats(), {
      entries: 0,
      bytes: 0,
      hits: 0,
      misses: 2,
      evictions: 0,
    });
  }
});

test('unsafe limits and incomplete identities cannot populate the resolver', () => {
  for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '2', null])
    for (const field of ['maxEntries', 'maxBytes'])
      assert.throws(() => createBossFactIdResolver({ [field]: limit }));
  const resolver = createBossFactIdResolver();
  resolver.factId(identity());
  const before = resolver.stats();
  for (const field of ['accountNamespace', 'conversationKey', 'messageId'])
    assert.throws(() => resolver.factId(identity({ [field]: '' })), /INCOMPLETE/);
  assert.throws(
    () => resolver.factId(identity({ factType: '', eventType: 'resume_observed', summary: '' })),
    /INCOMPLETE/,
  );
  assert.deepEqual(resolver.stats(), before);
});

test('warm identity cache cannot make forged facts, unknown fields or future data writable', () => {
  const good = validData();
  assert.equal(bossFactId(good.sourceEvents[0]), good.sourceEvents[0].factId);
  assert.deepEqual(validateData(good), good);
  for (const tamper of [
    (data) => {
      data.sourceEvents[0].factId = `boss-fact-${'0'.repeat(64)}`;
    },
    (data) => {
      data.sourceFacts[0].id = `boss-fact-${'0'.repeat(64)}`;
    },
    (data) => {
      data.sourceEvents[0].validated = 'true';
    },
    (data) => {
      data.sourceFacts[0].futureField = 'synthetic';
    },
    (data) => {
      data.schemaVersion++;
    },
  ]) {
    const corrupted = structuredClone(good);
    tamper(corrupted);
    const before = structuredClone(corrupted);
    assert.throws(() => validateData(corrupted));
    assert.throws(() => migrateData(corrupted));
    assert.deepEqual(corrupted, before);
  }
  assert.deepEqual(migrateData(good), good);
});
