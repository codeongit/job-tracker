import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateBossBatch as validateStructure,
  bossEventDigestInput,
  bossBatchDigestInput,
} from '../dist/boss-batch.js';
import { validateBossBatch, BOSS_INTEGRATION_VERSION } from '../scripts/boss-inbox.mjs';
import { stableHash } from '../scripts/boss-conversion.mjs';
import { correctionBatch } from './fixtures/boss-resume-correction.mjs';

const viewedProof = {
  version: 2,
  messageType: 4,
  field: 'body.text',
  text: '对方已查看了您的附件简历',
  bizType: null,
  bodyType: 1,
  templateId: 3,
  hyperLinkType: null,
};
function batch(version, proof = viewedProof) {
  const value = correctionBatch(0, { summary: 'resume_viewed_confirmed', resumeEvidence: proof });
  value.version = version;
  value.events[0].eventId = `boss-event-${stableHash(bossEventDigestInput(value, value.events[0]))}`;
  value.batchId = `boss-batch-${stableHash(bossBatchDigestInput(value))}`;
  return value;
}

test('new private v6 batch explicitly carries v2 semantics and refuses future/legacy containers', () => {
  assert.equal(BOSS_INTEGRATION_VERSION, 6);
  for (const validate of [validateStructure, validateBossBatch]) {
    assert.equal(validate(batch(6)).events[0].resumeEvidence.version, 2);
    assert.throws(() => validate(batch(5)));
    assert.throws(() => validate(batch(7)));
    assert.equal(
      validate(
        batch(5, {
          version: 1,
          messageType: 5,
          field: 'body.text',
          text: '对方已查看了您的附件简历',
        }),
      ).version,
      5,
    );
  }
});

test('v6 keeps legacy source event identity and includes changed semantics in batch digest', () => {
  const oldProof = {
    version: 1,
    messageType: 5,
    field: 'body.text',
    text: '对方已查看了您的附件简历',
  };
  const legacy = batch(5, oldProof),
    current = batch(6, oldProof),
    confirmed = batch(6);
  assert.equal(legacy.events[0].eventId, current.events[0].eventId);
  assert.equal(current.events[0].eventId, confirmed.events[0].eventId);
  assert.notEqual(current.batchId, confirmed.batchId);
});
