import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOM_RULE_ID,
  DOM_STATUS_SOURCE,
  collectDomSupplement,
  createDomSupplementPreflightExpression,
  createDomSupplementReadExpression,
  domSupplementTasks,
  normalizeDomSupplementPolicy,
} from './dom-supplement.mjs';
import {
  compareLoadedSnapshotsV2,
  conversationKeyV2,
  validateCurrentEnvelope,
} from './model-v2.mjs';

const namespace = 'boss-geek:' + 'a'.repeat(64);
const capturedAt = '2026-09-21T10:00:00.000Z';

function record(friendId) {
  return {
    key: conversationKeyV2(namespace, friendId, '0'),
    platformIdentity: { friendId, friendSource: '0', uniqueId: `${friendId}-0` },
    contact: `Synthetic ${friendId}`,
    company: 'Synthetic company',
    title: 'Recruiter',
    preview: 'Preview',
    timeLabel: '10:00',
    unread: null,
    latestMessageId: `message_${friendId}`,
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: null,
    observedJobName: null,
  };
}

function envelope(friendIds = ['101']) {
  const records = friendIds.map(record);
  const value = compareLoadedSnapshotsV2(null, {
    capturedAt,
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
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
  value.resume.lastUnresolved = records.map((item) => ({
    conversationKey: item.key,
    reason: 'HISTORY_UNAVAILABLE',
  }));
  return validateCurrentEnvelope(value);
}

function policy(enabled = true) {
  return {
    version: 1,
    enabled,
    accountNamespace: namespace,
    rule: {
      id: DOM_RULE_ID,
      acceptedBy: 'user',
      acceptedAt: '2026-09-21T09:00:00.000Z',
      noUnreadProof: 'vue_source_unreadMsgCount_zero',
      rowIdentity: 'vue_source_friendId_friendSource_uniqueId',
      messageIdentity: 'data-message-id_and_data-message-time',
    },
  };
}

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'boss-dom-supplement-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true });
  }
}

async function savePolicy(directory, value = policy()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, '.dom-supplement-policy-v1.json'), JSON.stringify(value), {
    mode: 0o600,
  });
}

test('policy requires explicit user acceptance of the fixed safety and identity rule', () => {
  assert.deepEqual(normalizeDomSupplementPolicy(policy(), namespace), policy());
  for (const invalid of [
    { ...policy(), accountNamespace: 'boss-geek:' + 'b'.repeat(64) },
    { ...policy(), rule: { ...policy().rule, acceptedBy: 'automatic' } },
    { ...policy(), rule: { ...policy().rule, noUnreadProof: 'missing_is_zero' } },
  ])
    assert.throws(
      () => normalizeDomSupplementPolicy(invalid, namespace),
      /DOM_SUPPLEMENT_POLICY_INVALID/,
    );
});

test('fair task selection resumes after the cursor and completed message tasks stay complete', () => {
  const current = envelope(['101', '102', '103']),
    accepted = policy();
  const initial = domSupplementTasks(current, {
    policy: accepted,
    state: {
      version: 1,
      cursor: record('101').key,
      lastSwitchAt: null,
      completed: [],
      updatedAt: null,
    },
  });
  assert.equal(initial.selected.conversationKey, record('102').key);
  const next = domSupplementTasks(current, {
    policy: accepted,
    state: {
      version: 1,
      cursor: record('101').key,
      lastSwitchAt: null,
      completed: [
        { taskId: initial.selected.taskId, completedAt: capturedAt, outcome: 'no_matching_status' },
      ],
      updatedAt: capturedAt,
    },
  });
  assert.equal(next.selected.conversationKey, record('103').key);
  assert.equal(next.pending, 2);
});

test('missing policy and zero budget never evaluate or switch the page', async () =>
  withDirectory(async (directory) => {
    let calls = 0;
    const disabled = await collectDomSupplement({
      directory,
      envelope: envelope(),
      maxSwitches: 1,
      execute: async () => {
        calls += 1;
        throw new Error('SHOULD_NOT_RUN');
      },
    });
    assert.equal(disabled.policyStatus, 'missing');
    assert.equal(disabled.reason, 'DOM_POLICY_DISABLED');
    assert.equal(disabled.counts.pending, 1);
    assert.equal(disabled.usage.domSwitches, 0);
    const zero = await collectDomSupplement({
      directory,
      envelope: envelope(),
      maxSwitches: 0,
      execute: async () => {
        calls += 1;
        throw new Error('SHOULD_NOT_RUN');
      },
    });
    assert.equal(zero.reason, 'DOM_BUDGET_ZERO');
    assert.equal(calls, 0);
  }));

test('preflight without explicit zero-unread proof remains pending and does not click', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    let calls = 0;
    const result = await collectDomSupplement({
      directory,
      envelope: envelope(),
      maxSwitches: 1,
      now: () => new Date('2026-09-21T10:01:00.000Z'),
      execute: async (_expression, metadata) => {
        calls += 1;
        assert.equal(metadata.kind, 'dom_preflight');
        return {
          ok: false,
          url: 'https://www.zhipin.com/web/geek/chat',
          reason: 'DOM_NO_UNREAD_PROOF',
          switchAttempted: false,
        };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.reason, 'DOM_NO_UNREAD_PROOF');
    assert.equal(result.partial, false);
    assert.equal(result.usage.domSwitches, 0);
    assert.equal(result.checkpointPending, true);
  }));

test('a simulated accepted DOM observation uses a distinct source and advances durable progress', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    let calls = 0,
      verified = 0;
    const original = envelope();
    const result = await collectDomSupplement({
      directory,
      envelope: original,
      maxSwitches: 1,
      now: () => new Date('2026-09-21T10:01:00.000Z'),
      verify: async () => {
        verified += 1;
        return { ok: true };
      },
      execute: async (_expression, metadata) => {
        calls += 1;
        const target = metadata.target;
        if (metadata.kind === 'dom_preflight')
          return {
            ok: true,
            url: 'https://www.zhipin.com/web/geek/chat',
            target,
            switchAttempted: false,
            selected: false,
            proof: {
              ruleId: DOM_RULE_ID,
              unreadMsgCount: 0,
              latestMessageId: target.latestMessageId,
            },
          };
        assert.equal(metadata.kind, 'dom_read');
        return {
          ok: true,
          url: 'https://www.zhipin.com/web/geek/chat',
          target,
          switchAttempted: true,
          capturedAt: '2026-09-21T10:01:05.000Z',
          observations: [
            {
              conversationKey: target.conversationKey,
              friendId: target.friendId,
              friendSource: target.friendSource,
              messageId: 'dom_message_1',
              direction: 'system',
              messageType: 5,
              kind: 'request_sent',
              platformTime: '2026-09-21T09:59:00.000Z',
              externalJobId: null,
              source: DOM_STATUS_SOURCE,
            },
          ],
          unresolved: [],
          coverage: {
            requestedConversations: 1,
            resolvedConversations: 1,
            pagesPerConversation: 0,
          },
        };
      },
    });
    assert.equal(calls, 2);
    assert.equal(verified, 1);
    assert.deepEqual(result.usage, { domSwitches: 1 });
    assert.deepEqual(result.counts, {
      pending: 0,
      selected: 1,
      switched: 1,
      observed: 1,
      added: 1,
      unresolved: 0,
    });
    assert.equal(result.envelope.resume.observations[0].source, DOM_STATUS_SOURCE);
    assert.equal(result.envelope.resume.lastScanAt, original.resume.lastScanAt);
    assert.deepEqual(result.envelope.resume.lastUnresolved, original.resume.lastUnresolved);
    assert.equal(result.checkpointPending, false);
    const statePath = join(directory, '.dom-supplement-state-v1.json');
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.cursor, record('101').key);
    assert.equal(state.completed.length, 1);
  }));

test('an uncertain issued switch is never retried and stays pending for review', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    let calls = 0;
    const first = await collectDomSupplement({
      directory,
      envelope: envelope(),
      maxSwitches: 1,
      now: () => new Date('2026-09-21T10:01:00.000Z'),
      execute: async (_expression, metadata) => {
        calls += 1;
        const target = metadata.target;
        if (metadata.kind === 'dom_preflight')
          return {
            ok: true,
            url: 'https://www.zhipin.com/web/geek/chat',
            target,
            switchAttempted: false,
            selected: false,
            proof: {
              ruleId: DOM_RULE_ID,
              unreadMsgCount: 0,
              latestMessageId: target.latestMessageId,
            },
          };
        throw new Error('CDP_CONNECTION_CLOSED');
      },
    });
    assert.equal(first.error, 'CDP_CONNECTION_CLOSED');
    assert.equal(first.usage.domSwitches, 1);
    assert.equal(first.checkpointPending, true);
    const second = await collectDomSupplement({
      directory,
      envelope: envelope(),
      maxSwitches: 1,
      now: () => new Date('2026-09-21T10:03:00.000Z'),
      execute: async () => {
        calls += 1;
        throw new Error('NO_RETRY');
      },
    });
    assert.equal(second.error, 'DOM_SWITCH_OUTCOME_UNKNOWN');
    assert.equal(second.usage.domSwitches, 0);
    assert.equal(calls, 2);
  }));

test('the durable 30-second interval defers the next task without evaluating the page', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    const current = envelope(['101', '102']);
    let calls = 0;
    const execute = async (_expression, metadata) => {
      calls += 1;
      const target = metadata.target;
      if (metadata.kind === 'dom_preflight')
        return {
          ok: true,
          url: 'https://www.zhipin.com/web/geek/chat',
          target,
          switchAttempted: false,
          selected: false,
          proof: {
            ruleId: DOM_RULE_ID,
            unreadMsgCount: 0,
            latestMessageId: target.latestMessageId,
          },
        };
      return {
        ok: true,
        url: 'https://www.zhipin.com/web/geek/chat',
        target,
        switchAttempted: true,
        capturedAt: '2026-09-21T10:01:01.000Z',
        observations: [],
        unresolved: [],
        coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 0 },
      };
    };
    const first = await collectDomSupplement({
      directory,
      envelope: current,
      maxSwitches: 1,
      now: () => new Date('2026-09-21T10:01:00.000Z'),
      execute,
    });
    const second = await collectDomSupplement({
      directory,
      envelope: first.envelope,
      maxSwitches: 1,
      now: () => new Date('2026-09-21T10:01:10.000Z'),
      execute,
    });
    assert.equal(first.usage.domSwitches, 1);
    assert.equal(second.reason, 'DOM_SWITCH_INTERVAL');
    assert.equal(second.nextAllowedAt, '2026-09-21T10:01:30.000Z');
    assert.equal(second.usage.domSwitches, 0);
    assert.equal(calls, 2);
  }));

test('generated CDP expressions contain only the fixed guarded read/switch flow', () => {
  const selected = domSupplementTasks(envelope(), {
    policy: policy(),
    state: { version: 1, cursor: null, lastSwitchAt: null, completed: [], updatedAt: null },
  }).selected;
  const preflight = createDomSupplementPreflightExpression(selected);
  const read = createDomSupplementReadExpression(selected);
  for (const value of [preflight, read]) {
    assert.match(value, /unreadMsgCount/);
    assert.match(value, /friendSource/);
    for (const forbidden of [
      'scrollIntoView',
      'window.scroll',
      'location.reload',
      'Page.navigate',
      'XMLHttpRequest',
      'fetch(',
      'send(',
      'submit(',
    ]) {
      assert.equal(value.includes(forbidden), false, forbidden);
    }
  }
  assert.equal(preflight.includes('.click()'), false);
  assert.equal(read.match(/\.click\(\)/g)?.length, 1);
});
