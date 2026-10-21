import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBossBatch, bindBossAccount } from '../dist/boss/application/integration.js';
import { emptyData, markManualFields } from '../dist/model.js';
import { bossBatchDigestInput, validateBossBatch } from '../dist/boss/rules/batch.js';
import { stableHash } from '../scripts/boss/delivery/conversion.mjs';
import {
  correctionBatch,
  CORRECTION_ACCOUNT,
  CORRECTION_SOURCE,
  CORRECTION_STAMP,
} from './fixtures/boss-resume-correction.mjs';
import {
  saveResumeCheckpoint,
  loadResumeCheckpoint,
  saveChangeCheckpoint,
  loadChangeCheckpoint,
} from '../collector/boss/persistence/runtime-state.mjs';

const proof = {
  version: 3,
  messageType: 1,
  field: 'body.action',
  text: '附件简历请求已发送',
  bodyType: 4,
  templateId: 1,
  actionAid: 40,
  annexType: null,
};
const options = { workspaceSourceId: CORRECTION_SOURCE, stamp: CORRECTION_STAMP };
function batch(version = 7, overrides = {}) {
  const value = correctionBatch(0, { resumeEvidence: proof, ...overrides });
  value.version = version;
  value.batchId = `boss-batch-${stableHash(bossBatchDigestInput(value))}`;
  return value;
}
function seed() {
  return applyBossBatch(
    bindBossAccount(emptyData(), CORRECTION_ACCOUNT, CORRECTION_SOURCE, CORRECTION_STAMP),
    correctionBatch(0, { ordinary: true }),
    options,
  ).data;
}

test('action proof requires v7 delivery; old evidence retains its stable event and fact identity', () => {
  assert.doesNotThrow(() => validateBossBatch(batch()));
  assert.doesNotThrow(() => validateBossBatch(batch(8)));
  for (const version of [5, 6, 9]) assert.throws(() => validateBossBatch(batch(version)));
  const old = correctionBatch(0);
  assert.equal(batch().events[0].eventId, old.events[0].eventId);
  assert.notEqual(batch().batchId, old.batchId);
  const current = applyBossBatch(seed(), batch(), options).data;
  const previous = applyBossBatch(seed(), old, options).data;
  assert.equal(current.sourceFacts.at(-1).id, previous.sourceFacts.at(-1).id);
});

test('action confirmation updates existing automatic state once and preserves manual or deleted targets', () => {
  const original = seed();
  const applied = applyBossBatch(original, batch(), options).data;
  assert.equal(applied.opportunities.length, original.opportunities.length);
  assert.equal(applied.opportunities[0].resumeState, '已发送');
  assert.equal(applied.opportunities[0].stage, '沟通中');
  assert.equal(applied.opportunities[0].readState, '已读');
  assert.equal(applied.sourceApplications.at(-1).status, 'applied');
  assert.equal(applied.sourceApplications.at(-1).reason, 'resume_status_advanced');
  assert.deepEqual(applyBossBatch(applied, batch(), options).data, applied);
  const manual = structuredClone(original);
  manual.opportunities[0].resumeState = '被索要';
  markManualFields(manual, manual.opportunities[0].id, ['resumeState']);
  const manualBefore = structuredClone(manual),
    protectedManual = applyBossBatch(manual, batch(), options).data;
  assert.deepEqual(protectedManual.opportunities, manualBefore.opportunities);
  assert.deepEqual(protectedManual.sourceBindings, manualBefore.sourceBindings);
  assert.equal(protectedManual.sourceApplications.at(-1).status, 'protected');
  assert.equal(protectedManual.sourceApplications.at(-1).reason, 'manual_resume_state');
  const deleted = structuredClone(original);
  deleted.opportunities[0].deletedAt = CORRECTION_STAMP;
  const deletedBefore = structuredClone(deleted),
    protectedDeleted = applyBossBatch(deleted, batch(), options).data;
  assert.deepEqual(protectedDeleted.opportunities, deletedBefore.opportunities);
  assert.deepEqual(protectedDeleted.sourceBindings, deletedBefore.sourceBindings);
  assert.equal(protectedDeleted.sourceApplications.at(-1).status, 'protected');
  assert.equal(protectedDeleted.sourceApplications.at(-1).reason, 'opportunity_deleted');
});

test('action semantics do not bypass participants, cross-job checks or portfolio exclusion', () => {
  const original = seed(),
    before = structuredClone(original);
  for (const [overrides, status, reason] of [
    [
      { attribution: { ...batch().events[0].attribution, recipientId: 'another-self' } },
      'review',
      'attribution_participant_conflict',
    ],
    [{ resumeEvidence: { ...proof, annexType: 1 } }, 'waiting', 'resume_semantics_missing'],
  ]) {
    const input = batch(7, overrides),
      result = applyBossBatch(original, input, options).data;
    assert.deepEqual(result.opportunities, before.opportunities);
    assert.deepEqual(result.sourceBindings, before.sourceBindings);
    assert.equal(result.sourceApplications.at(-1).status, status);
    assert.equal(result.sourceApplications.at(-1).reason, reason);
    assert.equal(result.sourceApplications.at(-1).opportunityId, '');
    assert.equal(result.sourceEvents.length, before.sourceEvents.length + 1);
    assert.equal(result.sourceEvents.at(-1).id, input.events[0].eventId);
    assert.equal(result.sourceEvents.at(-1).summary, 'resume_request_sent');
  }
  const conflict = applyBossBatch(
    original,
    correctionBatch(1, { ordinary: true, messageId: batch().events[0].messageId }),
    options,
  ).data;
  const conflictBefore = structuredClone(conflict),
    result = applyBossBatch(conflict, batch(), options).data;
  assert.deepEqual(result.opportunities, conflictBefore.opportunities);
  assert.deepEqual(result.sourceBindings, conflictBefore.sourceBindings);
  assert.equal(result.sourceApplications.at(-1).status, 'review');
  assert.equal(result.sourceApplications.at(-1).reason, 'attribution_message_multiple_jobs');
  assert.equal(result.sourceApplications.at(-1).opportunityId, '');
});

test('both history checkpoint paths carry action evidence from v5, with private permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-action-checkpoint-'));
  const checkpoint = {
    version: 5,
    capturedAt: CORRECTION_STAMP,
    nextConversationKey: null,
    nextPage: 0,
    observations: [{ messageType: 1, resumeEvidence: proof }],
    unresolved: [],
    coverage: { requestedConversations: 1 },
    usage: { historyRequests: 2 },
    partial: false,
    error: null,
  };
  try {
    for (const [save, load] of [
      [saveResumeCheckpoint, loadResumeCheckpoint],
      [saveChangeCheckpoint, loadChangeCheckpoint],
    ]) {
      const file = await save(directory, checkpoint);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.deepEqual(await load(directory), checkpoint);
      assert.deepEqual(await load(directory), checkpoint);
      await save(directory, { ...checkpoint, version: 6 });
      await save(directory, { ...checkpoint, version: 7 });
      assert.deepEqual(await load(directory), { ...checkpoint, version: 7 });
      for (const version of [3, 4, 8])
        await assert.rejects(
          save(directory, { ...checkpoint, version }),
          /RESUME_CHECKPOINT_INVALID/,
        );
      await assert.rejects(
        save(directory, {
          ...checkpoint,
          observations: [
            { messageType: 1, resumeEvidence: { ...proof, rawExtend: 'synthetic-secret' } },
          ],
        }),
        /RESUME_EVIDENCE_INVALID|RESUME_CHECKPOINT_INVALID/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const opaqueProof = {
  ...proof,
  version: 4,
  extensionFormat: 'opaque_string',
  platformContract: 'boss-action40-v5550-4d4a6ac8',
};

test('opaque action proof needs v8 and consumer rechecks its fixed platform contract', () => {
  const original = seed();
  const current = batch(8, { resumeEvidence: opaqueProof });
  assert.doesNotThrow(() => validateBossBatch(current));
  for (const version of [5, 6, 7, 9])
    assert.throws(() => validateBossBatch(batch(version, { resumeEvidence: opaqueProof })));
  for (const change of [
    { platformContract: 'synthetic-unreviewed-contract' },
    { extensionFormat: 'json_object' },
    { annexType: 0 },
    { rawExtend: 'synthetic-private-token' },
  ])
    assert.throws(() =>
      validateBossBatch(batch(8, { resumeEvidence: { ...opaqueProof, ...change } })),
    );
  const applied = applyBossBatch(original, current, options).data;
  assert.equal(applied.opportunities[0].resumeState, '已发送');
  assert.equal(applied.opportunities[0].stage, '沟通中');
  assert.deepEqual(applyBossBatch(applied, current, options).data, applied);
  assert.equal(current.events[0].eventId, batch().events[0].eventId);
  assert.equal(
    applied.sourceFacts.at(-1).id,
    applyBossBatch(original, batch(), options).data.sourceFacts.at(-1).id,
  );
  const mismatched = batch(8, {
    resumeEvidence: opaqueProof,
    attribution: { ...current.events[0].attribution, senderId: 'synthetic-wrong-participant' },
  });
  assert.equal(
    applyBossBatch(original, mismatched, options).data.opportunities[0].resumeState,
    '未知',
  );
});

test('opaque checkpoint evidence needs v6 and never stores its source string', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-opaque-checkpoint-'));
  const checkpoint = {
    version: 6,
    capturedAt: CORRECTION_STAMP,
    nextConversationKey: null,
    nextPage: 0,
    observations: [{ messageType: 1, resumeEvidence: opaqueProof }],
    unresolved: [{ conversationKey: 'a'.repeat(64), reason: 'RESUME_ACTION_EXTENSION_INVALID' }],
    coverage: { requestedConversations: 1 },
    usage: { historyRequests: 2 },
    partial: false,
    error: null,
  };
  try {
    for (const [save, load] of [
      [saveResumeCheckpoint, loadResumeCheckpoint],
      [saveChangeCheckpoint, loadChangeCheckpoint],
    ]) {
      await save(directory, checkpoint);
      assert.deepEqual(await load(directory), checkpoint);
      await save(directory, { ...checkpoint, version: 7 });
      assert.deepEqual(await load(directory), { ...checkpoint, version: 7 });
      for (const version of [3, 4, 5, 8])
        await assert.rejects(
          save(directory, { ...checkpoint, version }),
          /RESUME_CHECKPOINT_INVALID/,
        );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
