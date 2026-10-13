import { createHash } from 'node:crypto';
import { isBossQueueVersion } from '../../../dist/boss/contracts/batch-format.js';
import {
  validateBossBatch as validateBatchStructure,
  bossEventDigestInput,
  bossBatchDigestInput,
} from '../../../dist/boss/rules/batch.js';
import { fail } from './inbox-error.mjs';

function stableDigest(value) {
  const canonical = (current) => {
    if (Array.isArray(current)) return current.map(canonical);
    if (current && typeof current === 'object')
      return Object.fromEntries(
        Object.keys(current)
          .filter((key) => current[key] !== undefined)
          .sort()
          .map((key) => [key, canonical(current[key])]),
      );
    return current;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function validateBossBatch(input) {
  if (!isBossQueueVersion(input?.version))
    fail('批次版本不受支持。', 409, 'BOSS_BATCH_VERSION_UNSUPPORTED');
  let value;
  try {
    value = validateBatchStructure(input);
  } catch (error) {
    fail(error.message);
  }
  for (const event of value.events) {
    if (event.eventId !== `boss-event-${stableDigest(bossEventDigestInput(value, event))}`)
      fail('事件 ID 与事实不一致。');
  }
  if (value.batchId !== `boss-batch-${stableDigest(bossBatchDigestInput(value))}`)
    fail('batchId 与批次内容不一致。');
  return value;
}
