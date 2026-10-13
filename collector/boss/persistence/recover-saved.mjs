import { latest, lock } from './storage.mjs';
import { saveEnvelope } from './snapshot-save.mjs';
import { recoverDomSupplement } from '../history/dom-supplement.mjs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Snapshot/progress recovery has no browser dependency or platform executor.
// The same account lock used by collection protects the paired local writes.
export async function recoverDomSaved(directory, accountNamespace) {
  try {
    const info = await lstat(join(directory, '.dom-supplement-checkpoint-v1.json'));
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('DOM_SUPPLEMENT_CHECKPOINT_UNREADABLE');
  } catch (error) {
    if (error.code === 'ENOENT')
      return { recovered: false, checkpointPending: false, partial: false };
    throw error;
  }
  const release = await lock(directory);
  try {
    const saved = await latest(directory);
    if (!saved) throw new Error('BOSS_DOM_RECOVERY_SNAPSHOT_MISSING');
    if (accountNamespace && saved.envelope.accountNamespace !== accountNamespace)
      throw new Error('BOSS_DOM_RECOVERY_ACCOUNT_MISMATCH');
    return await recoverDomSupplement({
      directory,
      envelope: saved.envelope,
      saveEvidence: (value) => saveEnvelope(directory, value),
    });
  } finally {
    await release();
  }
}
