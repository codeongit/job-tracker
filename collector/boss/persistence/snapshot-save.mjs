import { join } from 'node:path';
import { commit } from './storage.mjs';
import { upgradeEnvelope, resolveJobRowsV2 } from '../materials/model-v2.mjs';
import { renderJobs, writePrivateMarkdown } from '../materials/export-jobs.mjs';

function safeError(error, fallback = 'JOB_EXPORT_FAILED') {
  const value = String(error?.message ?? fallback);
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(value) ? value : fallback;
}

export async function exportCurrent(directory, envelope) {
  const markdown = renderJobs(envelope, { resolveV2: resolveJobRowsV2 });
  const output = join(directory, 'jobs.md');
  await writePrivateMarkdown(output, markdown);
  return output;
}

export async function saveEnvelope(directory, envelope, { exportJobs = exportCurrent } = {}) {
  const current = upgradeEnvelope(envelope);
  const file = await commit(directory, current);
  let jobsFile;
  try {
    jobsFile = await exportJobs(directory, current);
  } catch (caught) {
    // Export errors can contain field values. Only a machine code and the
    // committed snapshot path may cross the tracker reporting boundary.
    const error = new Error(safeError(caught, 'JOB_EXPORT_FAILED'));
    error.snapshotPath = file;
    throw error;
  }
  return { file, jobsFile };
}
