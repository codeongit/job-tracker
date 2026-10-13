import { recoverDomSaved } from '../collector/boss/recover-saved.mjs';
import { basename, join } from 'node:path';
import {
  BOSS_CONTROL_FORMAT,
  BOSS_INTEGRATION_VERSION,
  validateBossControl,
} from './boss-inbox.mjs';
import { createIncrementalBatch, createResumeBatch } from './boss-conversion.mjs';
import {
  APPROVED_INITIAL,
  assertInitialScope,
  createInitialBatch,
  createDatedYesterdayBatch,
  previewInitialEnvelope,
} from './boss-legacy-import.mjs';
import { integrationFail } from './boss-integration-error.mjs';
import {
  listSnapshotNames,
  readCheckpointSnapshot,
  readTrackerSnapshot,
  snapshotDirectory,
} from './boss-snapshots.mjs';

export function emptyControl() {
  return {
    format: BOSS_CONTROL_FORMAT,
    version: BOSS_INTEGRATION_VERSION,
    accountNamespace: '',
    checkpoint: null,
    attempts: [],
    lastAttemptAt: '',
    lastSuccessAt: '',
    nextAllowedAt: '',
    paused: false,
    pauseCode: '',
  };
}

function checkpoint(snapshot, sourceSequence) {
  return {
    snapshotName: basename(snapshot.path),
    snapshotSha256: snapshot.sha256,
    capturedAt: snapshot.envelope.snapshot.capturedAt,
    sourceSequence,
  };
}

function checkpointMatches(control, snapshot) {
  return (
    control.checkpoint?.snapshotName === basename(snapshot.path) &&
    control.checkpoint?.snapshotSha256 === snapshot.sha256
  );
}

function ensureAccount(control, snapshot) {
  if (control.accountNamespace && control.accountNamespace !== snapshot.envelope.accountNamespace)
    integrationFail('BOSS_ACCOUNT_MISMATCH', { fatal: true });
}

function ensureOrder(previous, current) {
  if (
    Date.parse(current.envelope.snapshot.capturedAt) <
    Date.parse(previous.envelope.snapshot.capturedAt)
  )
    integrationFail('BOSS_SNAPSHOT_ORDER_INVALID', { fatal: true });
}

function prepareIncremental(control, previous, current, initialIdentity) {
  const nextSequence = control.checkpoint.sourceSequence + 1;
  const afterInitial =
    control.checkpoint.sourceSequence === 1 &&
    control.checkpoint.snapshotName === initialIdentity.name &&
    control.checkpoint.snapshotSha256 === initialIdentity.sha256;
  const batch = createIncrementalBatch(previous, current, nextSequence, { afterInitial });
  return {
    batch,
    sourceSequence: batch ? nextSequence : control.checkpoint.sourceSequence,
    commitCheckpoint: true,
  };
}

function prepareDated(control, previous, current, evidenceDate) {
  const changedSnapshot = current.sha256 !== previous.sha256;
  if (
    changedSnapshot &&
    JSON.stringify(current.envelope.snapshot) !== JSON.stringify(previous.envelope.snapshot)
  )
    integrationFail('BOSS_DATED_IMPORT_REQUIRES_CURRENT_CHECKPOINT', { fatal: true });
  const sourceSequence = control.checkpoint.sourceSequence + Number(changedSnapshot);
  const batch = createDatedYesterdayBatch(current, sourceSequence, evidenceDate);
  return {
    batch,
    sourceSequence,
    commitCheckpoint: changedSnapshot,
    counts: {
      events: batch.events.length,
      complete: batch.events.filter((event) => event.intent === 'create_or_link').length,
      review: batch.events.filter((event) => event.intent === 'review').length,
    },
  };
}

function prepareResume(control, previous, current, evidenceDate) {
  if (JSON.stringify(current.envelope.snapshot) !== JSON.stringify(previous.envelope.snapshot))
    integrationFail('BOSS_RESUME_IMPORT_REQUIRES_CURRENT_CHECKPOINT', { fatal: true });
  const sourceSequence = control.checkpoint.sourceSequence + 1;
  const batch = createResumeBatch(current, sourceSequence, evidenceDate);
  return {
    batch,
    sourceSequence,
    commitCheckpoint: true,
    counts: {
      events: batch.events.length,
      strong: batch.events.filter((event) =>
        [
          'resume_sent_candidate',
          'resume_request_sent',
          'resume_sent_confirmed',
          'resume_attachment_sent',
          'resume_viewed_confirmed',
        ].includes(event.summary),
      ).length,
      review: batch.events.filter((event) => event.summary === 'resume_card_other').length,
    },
  };
}

// Snapshot refs come from readTrackerSnapshot: schema validation and the raw
// byte digest happen before this module receives them. The caller owns the
// producer lock. All modes share the durable enqueue-before-checkpoint order.
export async function deliverSaved({
  mode,
  current,
  previous,
  control,
  inbox,
  evidenceDate = '',
  initialIdentity = APPROVED_INITIAL,
  onStage = () => {},
}) {
  let prepared;
  if (mode === 'initial') {
    if (
      basename(current.path) !== initialIdentity.name ||
      current.sha256 !== initialIdentity.sha256
    )
      integrationFail('BOSS_INITIAL_SNAPSHOT_CHANGED', { fatal: true });
    const preview = previewInitialEnvelope(current.envelope);
    assertInitialScope(preview);
    control ??= (await inbox.readControl()) ?? emptyControl();
    ensureAccount(control, current);
    if (control.checkpoint && !checkpointMatches(control, current))
      integrationFail('BOSS_INITIAL_ALREADY_ADVANCED');
    const sourceSequence = control.checkpoint?.sourceSequence || 1;
    prepared = {
      batch: createInitialBatch(current, sourceSequence),
      sourceSequence,
      commitCheckpoint: true,
      preview,
    };
  } else {
    if (!control?.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
    if (mode === 'incremental') onStage('validate_snapshot');
    if (previous.sha256 !== control.checkpoint.snapshotSha256)
      integrationFail('BOSS_CHECKPOINT_CHANGED', { fatal: true });
    ensureAccount(control, current);
    if (mode === 'resume' && checkpointMatches(control, current) && !evidenceDate)
      return {
        batch: null,
        queued: { created: false },
        control,
        counts: { events: 0, strong: 0, review: 0 },
      };
    ensureOrder(previous, current);
    if (mode === 'incremental')
      prepared = prepareIncremental(control, previous, current, initialIdentity);
    else if (mode === 'dated') prepared = prepareDated(control, previous, current, evidenceDate);
    else if (mode === 'resume') prepared = prepareResume(control, previous, current, evidenceDate);
    else integrationFail('BOSS_DELIVERY_MODE_INVALID');
  }
  const { batch, sourceSequence, commitCheckpoint, ...summary } = prepared;
  let queued = null;
  if (batch) {
    onStage('enqueue_events');
    // BossInbox owns attribution diagnostics and the immutable atomic write.
    queued = await inbox.enqueue(batch);
  }
  if (commitCheckpoint) {
    control = validateBossControl({
      ...control,
      accountNamespace:
        mode === 'initial' || mode === 'incremental'
          ? current.envelope.accountNamespace
          : control.accountNamespace,
      checkpoint: checkpoint(current, sourceSequence),
    });
    onStage('commit_checkpoint');
    await inbox.writeControl(control);
  }
  return { control, batch, queued, ...summary };
}

export async function recoverSaved({
  config,
  inbox,
  control,
  onStage = () => {},
  initialIdentity = APPROVED_INITIAL,
}) {
  if (!control.checkpoint) return { control, recovered: 0, batches: 0, events: 0 };
  const dom = await recoverDomSaved(snapshotDirectory(config), control.accountNamespace);
  onStage('scan_saved_snapshots');
  const names = await listSnapshotNames(config);
  const index = names.indexOf(control.checkpoint.snapshotName);
  if (index === -1) integrationFail('BOSS_CHECKPOINT_SNAPSHOT_MISSING', { fatal: true });
  let previous = await readCheckpointSnapshot(config, control);
  let currentControl = control;
  let recovered = 0;
  let batches = 0;
  let events = 0;
  for (const name of names.slice(index + 1)) {
    onStage('recover_saved_snapshot');
    const current = await readTrackerSnapshot(join(snapshotDirectory(config), name));
    const result = await deliverSaved({
      mode: 'incremental',
      inbox,
      control: currentControl,
      previous,
      current,
      onStage,
      initialIdentity,
    });
    currentControl = result.control;
    recovered += 1;
    if (result.batch) {
      batches += 1;
      events += result.batch.events.length;
    }
    previous = current;
  }
  return {
    control: currentControl,
    recovered,
    batches,
    events,
    ...(dom.recovered || dom.checkpointPending
      ? {
          domRecovery: {
            recovered: dom.recovered,
            checkpointPending: dom.checkpointPending,
            partial: dom.partial,
            error: dom.error,
          },
        }
      : {}),
  };
}
