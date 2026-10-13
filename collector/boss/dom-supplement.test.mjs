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
  recoverDomSupplement,
} from './history/dom-supplement.mjs';
import { saveEnvelope } from './persistence/snapshot-save.mjs';
import { commit, latest } from './persistence/storage.mjs';
import {
  compareLoadedSnapshotsV2,
  conversationKeyV2,
  validateCurrentEnvelope,
} from './materials/model-v2.mjs';

const namespace = 'boss-geek:' + 'a'.repeat(64);
const capturedAt = '2026-09-21T10:00:00.000Z';

function record(friendId, accountNamespace = namespace) {
  return {
    key: conversationKeyV2(accountNamespace, friendId, '0'),
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

function envelope(friendIds = ['101'], accountNamespace = namespace) {
  const records = friendIds.map((friendId) => record(friendId, accountNamespace));
  const value = compareLoadedSnapshotsV2(null, {
    capturedAt,
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

function successfulDomExecute(calls = []) {
  return async (_expression, metadata) => {
    calls.push(metadata.kind);
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
      coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 0 },
    };
  };
}

test('evidence save failure preserves a ready result without completing the DOM task', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    const calls = [];
    await assert.rejects(
      collectDomSupplement({
        directory,
        envelope: envelope(),
        maxSwitches: 1,
        now: () => new Date('2026-09-21T10:01:00.000Z'),
        execute: successfulDomExecute(calls),
        saveEvidence: async () => {
          throw new Error('SNAPSHOT_SAVE_FAILED');
        },
      }),
      (error) => error.message === 'SNAPSHOT_SAVE_FAILED' && error.usage.domSwitches === 1,
    );
    assert.deepEqual(calls, ['dom_preflight', 'dom_read']);
    const checkpoint = JSON.parse(
      await readFile(join(directory, '.dom-supplement-checkpoint-v1.json'), 'utf8'),
    );
    assert.equal(checkpoint.version, 2);
    assert.equal(checkpoint.stage, 'result_ready');
    assert.equal(checkpoint.observations.length, 1);
    const state = JSON.parse(
      await readFile(join(directory, '.dom-supplement-state-v1.json'), 'utf8'),
    );
    assert.deepEqual(state.completed, []);
    assert.equal(state.cursor, null);
  }));

async function prepareReadyResult(directory, execute = successfulDomExecute()) {
  await savePolicy(directory);
  await assert.rejects(
    collectDomSupplement({
      directory,
      envelope: envelope(),
      maxSwitches: 1,
      now: () => new Date('2026-09-21T10:01:00.000Z'),
      execute,
      saveEvidence: async () => {
        throw new Error('SNAPSHOT_SAVE_FAILED');
      },
    }),
    /SNAPSHOT_SAVE_FAILED/,
  );
  return join(directory, '.dom-supplement-checkpoint-v1.json');
}

test('ready recovery precedes zero budget and disabled policy, retaining the old message task', async () =>
  withDirectory(async (directory) => {
    const checkpointPath = await prepareReadyResult(directory);
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    await savePolicy(directory, policy(false));
    const original = envelope();
    const changed = compareLoadedSnapshotsV2(original, {
      ...original.snapshot,
      accountNamespace: namespace,
      capturedAt: '2026-09-21T10:05:00.000Z',
      records: [{ ...original.snapshot.records[0], latestMessageId: 'new_message_101' }],
    }).envelope;
    const recovered = await collectDomSupplement({
      directory,
      envelope: changed,
      maxSwitches: 0,
      execute: async () => assert.fail('local recovery must not evaluate'),
      verify: async () => assert.fail('local recovery must not verify the page'),
    });
    assert.equal(recovered.recovered, true);
    assert.deepEqual(recovered.usage, { domSwitches: 0 });
    assert.equal(recovered.counts.switched, 0);
    assert.equal(recovered.envelope.resume.observations.length, 1);
    assert.equal(recovered.envelope.snapshot.records[0].latestMessageId, 'new_message_101');
    assert.deepEqual(recovered.envelope.resume.lastUnresolved, changed.resume.lastUnresolved);
    const state = JSON.parse(
      await readFile(join(directory, '.dom-supplement-state-v1.json'), 'utf8'),
    );
    assert.equal(state.completed[0].taskId, checkpoint.taskId);
    assert.equal(state.cursor, checkpoint.conversationKey);
    assert.equal(state.lastSwitchAt, checkpoint.issuedAt);
    await assert.rejects(readFile(checkpointPath), { code: 'ENOENT' });
    const repeated = await recoverDomSupplement({ directory, envelope: recovered.envelope });
    assert.equal(repeated.recovered, false);
    assert.equal(repeated.checkpointPending, false);
    assert.deepEqual(repeated.envelope, recovered.envelope);
  }));

test('JSON saved before Markdown failure retains snapshot and ready checkpoint until local recovery', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    let failure;
    await assert.rejects(
      collectDomSupplement({
        directory,
        envelope: envelope(),
        maxSwitches: 1,
        now: () => new Date('2026-09-21T10:01:00.000Z'),
        execute: successfulDomExecute(),
        saveEvidence: (value) =>
          saveEnvelope(directory, value, {
            exportJobs: async () => {
              throw new Error('PRIVATE EXPORT BODY');
            },
          }),
      }),
      (error) => {
        failure = error;
        return error.message === 'JOB_EXPORT_FAILED' && error.usage.domSwitches === 1;
      },
    );
    assert.ok(failure.snapshotPath);
    const saved = JSON.parse(await readFile(failure.snapshotPath, 'utf8'));
    assert.equal(saved.resume.observations.length, 1);
    const stableId = saved.resume.observations[0].id;
    const checkpointPath = join(directory, '.dom-supplement-checkpoint-v1.json');
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    assert.equal(checkpoint.stage, 'result_ready');
    assert.equal((await stat(checkpointPath)).mode & 0o777, 0o600);
    assert.equal(Object.hasOwn(checkpoint, 'envelope'), false);
    assert.equal(Object.hasOwn(checkpoint, 'payload'), false);
    assert.equal(Object.hasOwn(checkpoint.observations[0], 'text'), false);
    const state = JSON.parse(
      await readFile(join(directory, '.dom-supplement-state-v1.json'), 'utf8'),
    );
    assert.deepEqual(state.completed, []);
    const recovered = await recoverDomSupplement({
      directory,
      envelope: saved,
      saveEvidence: (value) => saveEnvelope(directory, value),
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.counts.added, 0);
    assert.deepEqual(recovered.usage, { domSwitches: 0 });
    assert.equal(recovered.envelope.resume.observations.length, 1);
    assert.equal(recovered.envelope.resume.observations[0].id, stableId);
    await assert.rejects(readFile(checkpointPath), { code: 'ENOENT' });
  }));

test('progress failure leaves evidence and ready result for retry without a second DOM action', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    let failure;
    let saves = 0;
    await assert.rejects(
      collectDomSupplement({
        directory,
        envelope: envelope(),
        maxSwitches: 1,
        now: () => new Date('2026-09-21T10:01:00.000Z'),
        execute: successfulDomExecute(),
        saveEvidence: async (value) => {
          const saved = await saveEnvelope(directory, value);
          // The issued-state save happened before the DOM action; fail the
          // completion-state write through the real atomic file rename.
          await rm(join(directory, '.dom-supplement-state-v1.json'));
          await mkdir(join(directory, '.dom-supplement-state-v1.json'));
          saves += 1;
          return saved;
        },
      }),
      (error) => {
        failure = error;
        return ['EISDIR', 'ENOTDIR'].includes(error.code) && error.usage.domSwitches === 1;
      },
    );
    assert.equal(saves, 1);
    assert.ok(failure.snapshotPath);
    const saved = JSON.parse(await readFile(failure.snapshotPath, 'utf8'));
    await rm(join(directory, '.dom-supplement-state-v1.json'), { recursive: true });
    const recovered = await recoverDomSupplement({ directory, envelope: saved });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.counts.added, 0);
    assert.deepEqual(recovered.usage, { domSwitches: 0 });
    const state = JSON.parse(
      await readFile(join(directory, '.dom-supplement-state-v1.json'), 'utf8'),
    );
    assert.equal(state.completed.length, 1);
    assert.equal(state.lastSwitchAt, '2026-09-21T10:01:00.000Z');
  }));

test('checkpoint removal failure replays evidence idempotently after completion was saved', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    let failure;
    await assert.rejects(
      collectDomSupplement({
        directory,
        envelope: envelope(),
        maxSwitches: 1,
        now: () => new Date('2026-09-21T10:01:00.000Z'),
        execute: successfulDomExecute(),
        checkpoints: {
          remove: async () => {
            throw new Error('CHECKPOINT_REMOVE_FAILED');
          },
        },
      }),
      (error) => {
        failure = error;
        return error.message === 'CHECKPOINT_REMOVE_FAILED' && error.usage.domSwitches === 1;
      },
    );
    const statePath = join(directory, '.dom-supplement-state-v1.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.completed.length, 1);
    const saved = JSON.parse(await readFile(failure.snapshotPath, 'utf8'));
    const recovered = await recoverDomSupplement({ directory, envelope: saved });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.counts.added, 0);
    assert.deepEqual(recovered.usage, { domSwitches: 0 });
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), state);
    assert.equal(recovered.envelope.resume.observations[0].id, saved.resume.observations[0].id);
  }));

test('legacy selected and unknown issued checkpoints remain local and are never replayed by recovery', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    const target = domSupplementTasks(envelope(), { policy: policy() }).selected;
    const checkpointPath = join(directory, '.dom-supplement-checkpoint-v1.json');
    for (const stage of ['selected', 'switch_issued']) {
      const checkpoint = {
        version: 1,
        taskId: target.taskId,
        conversationKey: target.conversationKey,
        latestMessageId: target.latestMessageId,
        ruleId: DOM_RULE_ID,
        stage,
        selectedAt: '2026-09-21T10:01:00.000Z',
        issuedAt: stage === 'selected' ? null : '2026-09-21T10:01:00.000Z',
      };
      const serialized = JSON.stringify(checkpoint);
      await writeFile(checkpointPath, serialized, { mode: 0o600 });
      const recovered = await recoverDomSupplement({
        directory,
        envelope: envelope(),
        saveEvidence: async () => assert.fail('legacy checkpoint has no result to save'),
        saveProgress: async () => assert.fail('legacy checkpoint cannot complete locally'),
      });
      assert.equal(recovered.recovered, false);
      assert.equal(recovered.checkpointPending, true);
      assert.deepEqual(recovered.usage, { domSwitches: 0 });
      assert.equal(recovered.partial, stage === 'switch_issued');
      assert.equal(
        recovered.error,
        stage === 'switch_issued' ? 'DOM_SWITCH_OUTCOME_UNKNOWN' : null,
      );
      const collected = await collectDomSupplement({
        directory,
        envelope: envelope(),
        maxSwitches: stage === 'selected' ? 0 : 1,
        execute: async () => assert.fail('legacy checkpoint recovery must not evaluate'),
        verify: async () => assert.fail('legacy checkpoint recovery must not verify'),
      });
      assert.equal(
        collected.reason,
        stage === 'selected' ? 'DOM_BUDGET_ZERO' : 'DOM_CHECKPOINT_REQUIRES_REVIEW',
      );
      assert.equal(await readFile(checkpointPath, 'utf8'), serialized);
    }
  }));

test('ready recovery rejects future versions, unknown fields and inconsistent target identities before writes', async () =>
  withDirectory(async (directory) => {
    const checkpointPath = await prepareReadyResult(directory);
    const original = JSON.parse(await readFile(checkpointPath, 'utf8'));
    const statePath = join(directory, '.dom-supplement-state-v1.json');
    const stateBytes = await readFile(statePath, 'utf8');
    const mutations = [
      (value) => {
        value.version = 3;
      },
      (value) => {
        value.future = true;
      },
      (value) => {
        value.target.future = true;
      },
      (value) => {
        value.target.friendId = 101;
      },
      (value) => {
        value.taskId = value.target.taskId = 'f'.repeat(64);
      },
      (value) => {
        value.accountNamespace = 'boss-geek:' + 'b'.repeat(64);
      },
      (value) => {
        value.observations[0].body = 'Synthetic body';
      },
      (value) => {
        value.observations[0].resumeEvidence = { version: 99 };
      },
      (value) => {
        value.coverage.future = 1;
      },
      (value) => {
        value.unresolved = [
          {
            conversationKey: value.conversationKey,
            reason: 'HISTORY_UNAVAILABLE',
            body: 'Synthetic body',
          },
        ];
      },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(original);
      mutate(value);
      const serialized = JSON.stringify(value);
      await writeFile(checkpointPath, serialized);
      await assert.rejects(
        recoverDomSupplement({
          directory,
          envelope: envelope(),
          saveEvidence: async () => assert.fail('invalid checkpoint must not save evidence'),
          saveProgress: async () => assert.fail('invalid checkpoint must not save progress'),
        }),
        (error) =>
          error.message === 'DOM_SUPPLEMENT_CHECKPOINT_INVALID' && error.usage.domSwitches === 0,
      );
      assert.equal(await readFile(checkpointPath, 'utf8'), serialized);
      assert.equal(await readFile(statePath, 'utf8'), stateBytes);
    }
    await writeFile(checkpointPath, JSON.stringify(original));
    await assert.rejects(
      recoverDomSupplement({
        directory,
        envelope: envelope(['101'], 'boss-geek:' + 'b'.repeat(64)),
        saveEvidence: async () => assert.fail('other account cannot consume the checkpoint'),
      }),
      /DOM_SUPPLEMENT_CHECKPOINT_ACCOUNT_MISMATCH/,
    );
    await writeFile(statePath, JSON.stringify({ ...JSON.parse(stateBytes), future: true }));
    await assert.rejects(
      recoverDomSupplement({ directory, envelope: envelope() }),
      /DOM_SUPPLEMENT_STATE_INVALID/,
    );
  }));

test('ready checkpoint save failure preserves issued-action usage and never advances completion', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    const checkpointPath = join(directory, '.dom-supplement-checkpoint-v1.json');
    await assert.rejects(
      collectDomSupplement({
        directory,
        envelope: envelope(),
        maxSwitches: 1,
        now: () => new Date('2026-09-21T10:01:00.000Z'),
        execute: successfulDomExecute(),
        checkpoints: {
          save: async (_directory, value) => {
            if (value.stage === 'result_ready') throw new Error('CHECKPOINT_SAVE_FAILED');
            await writeFile(checkpointPath, JSON.stringify(value), { mode: 0o600 });
          },
        },
        saveEvidence: async () => assert.fail('result must be checkpointed before evidence save'),
      }),
      (error) => error.message === 'CHECKPOINT_SAVE_FAILED' && error.usage.domSwitches === 1,
    );
    assert.equal(JSON.parse(await readFile(checkpointPath, 'utf8')).stage, 'switch_issued');
    const state = JSON.parse(
      await readFile(join(directory, '.dom-supplement-state-v1.json'), 'utf8'),
    );
    assert.deepEqual(state.completed, []);
    const recovered = await recoverDomSupplement({ directory, envelope: envelope() });
    assert.equal(recovered.error, 'DOM_SWITCH_OUTCOME_UNKNOWN');
    assert.deepEqual(recovered.usage, { domSwitches: 0 });
  }));

test('a ready empty observation result retains normalized unresolved and coverage until saved', async () =>
  withDirectory(async (directory) => {
    const execute = successfulDomExecute();
    const checkpointPath = await prepareReadyResult(directory, async (...args) => {
      const payload = await execute(...args);
      if (args[1].kind === 'dom_read') {
        payload.observations = [];
        payload.unresolved = [
          {
            conversationKey: payload.target.conversationKey,
            reason: 'DOM_MESSAGE_IDENTITY_INCOMPLETE',
          },
        ];
      }
      return payload;
    });
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    assert.deepEqual(checkpoint.observations, []);
    assert.deepEqual(checkpoint.unresolved, [
      { conversationKey: record('101').key, reason: 'DOM_MESSAGE_IDENTITY_INCOMPLETE' },
    ]);
    assert.deepEqual(checkpoint.coverage, {
      requestedConversations: 1,
      resolvedConversations: 1,
      pagesPerConversation: 0,
    });
    const recovered = await recoverDomSupplement({ directory, envelope: envelope() });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.counts.observed, 0);
    assert.equal(recovered.counts.unresolved, 1);
    const state = JSON.parse(
      await readFile(join(directory, '.dom-supplement-state-v1.json'), 'utf8'),
    );
    assert.equal(state.completed[0].outcome, 'no_matching_status');
  }));

test('a new DOM target is recoverable from disk when the later evidence save fails', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    await commit(directory, envelope(['101']));
    const current = { ...envelope(['101', '202']), version: 7 };
    current.resume.lastUnresolved = [
      { conversationKey: record('202').key, reason: 'HISTORY_UNAVAILABLE' },
    ];
    const calls = [];
    await assert.rejects(
      collectDomSupplement({
        directory,
        envelope: current,
        maxSwitches: 1,
        now: () => new Date('2026-09-21T10:01:00.000Z'),
        execute: successfulDomExecute(calls),
        saveEvidence: async () => {
          throw new Error('SNAPSHOT_SAVE_FAILED');
        },
      }),
      (error) => error.message === 'SNAPSHOT_SAVE_FAILED' && error.usage.domSwitches === 1,
    );
    assert.deepEqual(calls, ['dom_preflight', 'dom_read']);
    const saved = await latest(directory);
    assert.equal(saved.envelope.version, 8);
    const recovered = await recoverDomSupplement({ directory, envelope: saved.envelope });
    assert.equal(recovered.recovered, true);
    assert.deepEqual(recovered.usage, { domSwitches: 0 });
    assert.equal(recovered.envelope.resume.observations.length, 1);
    assert.equal(recovered.envelope.resume.observations[0].conversationKey, record('202').key);
    assert.deepEqual(recovered.envelope.snapshot.records, current.snapshot.records);
    const state = JSON.parse(
      await readFile(join(directory, '.dom-supplement-state-v1.json'), 'utf8'),
    );
    assert.equal(state.completed.length, 1);
    assert.equal(state.cursor, record('202').key);
  }));

test('recovery base save failure stops before any target DOM action and reports zero usage', async () =>
  withDirectory(async (directory) => {
    await savePolicy(directory);
    const calls = [];
    let verifications = 0;
    await assert.rejects(
      collectDomSupplement({
        directory,
        envelope: envelope(),
        maxSwitches: 1,
        now: () => new Date('2026-09-21T10:01:00.000Z'),
        execute: successfulDomExecute(calls),
        verify: async () => {
          verifications += 1;
          return { ok: true };
        },
        saveRecoveryBase: async () => {
          throw new Error('RECOVERY_BASE_SAVE_FAILED');
        },
      }),
      (error) => error.message === 'RECOVERY_BASE_SAVE_FAILED' && error.usage.domSwitches === 0,
    );
    assert.deepEqual(calls, []);
    assert.equal(verifications, 0);
    await assert.rejects(readFile(join(directory, '.dom-supplement-checkpoint-v1.json')), {
      code: 'ENOENT',
    });
    await assert.rejects(readFile(join(directory, '.dom-supplement-state-v1.json')), {
      code: 'ENOENT',
    });
  }));
