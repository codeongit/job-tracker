import {
  projectRoot,
  defaultConfigPath,
  defaultInboxRoot,
  defaultTrackerRoot,
  defaultTrackerDataRoot,
} from '../shared/paths.mjs';
import { BossIntegrationError, integrationFail } from './integration-error.mjs';
export { BossIntegrationError } from './integration-error.mjs';
export {
  stableHash,
  createBatch,
  createEvents,
  createResumeEvents,
  createResumeStatusEvents,
  createResumeBatch,
} from './conversion.mjs';
import { APPROVED_INITIAL, assertInitialScope, previewInitialEnvelope } from './legacy-import.mjs';
export {
  previewInitialEnvelope,
  createInitialBatch,
  createDatedYesterdayBatch,
} from './legacy-import.mjs';
import { randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  BOSS_CONTROL_MAX_ATTEMPTS,
  BOSS_INCIDENT_FORMAT,
  BOSS_RUN_FORMAT,
  BossInbox,
  BossInboxError,
  validateBossControl,
} from './inbox.mjs';
import { consumeBossInternalAuthorization } from '../control/internal-auth.mjs';
import { deliverSaved, recoverSaved } from './saved.mjs';
export { emptyControl } from './saved.mjs';
import {
  SNAPSHOT_FILE,
  assertInitialSnapshot,
  initialSnapshotPath,
  listSnapshotNames,
  readCheckpointSnapshot,
  readLatestSnapshot,
  readTrackerSnapshot,
  snapshotDirectory,
} from './snapshots.mjs';
export { readTrackerSnapshot, validateTrackerEnvelope } from './snapshots.mjs';

const execFile = promisify(execFileCallback);
// Manual checks only read the page state that is already loaded.  Keep a
// short duplicate-click guard here; platform-request budgets are accounted
// for by the runtime/collector at the action that actually sends them.
const MIN_CHECK_INTERVAL_MS = 10 * 1_000;
const MAX_SNAPSHOT_BYTES = 25_000_000;
const MAX_TRACKER_OUTPUT_BYTES = 1_000_000;
const PRODUCER_LOCK = '.producer.lock';

function plain(value, code = 'BOSS_SNAPSHOT_STRUCTURE_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    integrationFail(code, { fatal: true });
  return value;
}

function requiredString(value, { max = 5_000, pattern } = {}) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes('\0') &&
    (!pattern || pattern.test(value))
  );
}

function isIso(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function safeErrorCode(error) {
  const code = String(error?.code ?? error?.message ?? 'BOSS_INTEGRATION_FAILED');
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(code) ? code : 'BOSS_INTEGRATION_FAILED';
}

function runId() {
  return `boss-run-${randomBytes(16).toString('hex')}`;
}

export async function withProducerLock(inbox, id, task) {
  await inbox.initialize();
  const path = join(inbox.root, PRODUCER_LOCK);
  let handle;
  try {
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') integrationFail('BOSS_PRODUCER_BUSY');
      throw error;
    }
    await handle.writeFile(
      `${JSON.stringify({ runId: id, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    await handle.sync();
    return await task();
  } finally {
    if (handle) {
      const owned = await handle.stat();
      await handle.close();
      try {
        const current = await lstat(path);
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          current.dev === owned.dev &&
          current.ino === owned.ino
        )
          await unlink(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

async function releaseStaleProducerLock(inbox) {
  const path = join(inbox.root, PRODUCER_LOCK);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000)
    integrationFail('BOSS_PRODUCER_LOCK_INVALID');
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    integrationFail('BOSS_PRODUCER_LOCK_INVALID');
  }
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'createdAt,pid,runId' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !/^boss-run-[a-f0-9]{32}$/.test(value.runId) ||
    !isIso(value.createdAt)
  )
    integrationFail('BOSS_PRODUCER_LOCK_INVALID');
  try {
    process.kill(value.pid, 0);
    integrationFail('BOSS_PRODUCER_BUSY');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const current = await lstat(path);
  if (current.dev !== info.dev || current.ino !== info.ino) integrationFail('BOSS_PRODUCER_BUSY');
  await unlink(path);
  return true;
}

function normalizeConfig(input) {
  const value = plain(input, 'BOSS_CONFIG_INVALID');
  const config = plain(value.bossIntegration, 'BOSS_CONFIG_REQUIRED');
  const keys = Object.keys(config).sort();
  const currentKeys = ['account', 'initialSnapshot'];
  const legacyKeys = ['account', 'initialSnapshot', 'trackerRoot'];
  if (
    JSON.stringify(keys) !== JSON.stringify(currentKeys) &&
    JSON.stringify(keys) !== JSON.stringify(legacyKeys)
  )
    integrationFail('BOSS_CONFIG_INVALID');
  if (
    (config.trackerRoot !== undefined &&
      (!requiredString(config.trackerRoot, { max: 1_000 }) || !isAbsolute(config.trackerRoot))) ||
    !requiredString(config.account, { max: 40, pattern: /^[A-Za-z0-9_-]+$/ }) ||
    !requiredString(config.initialSnapshot, { max: 205, pattern: SNAPSHOT_FILE }) ||
    basename(config.initialSnapshot) !== config.initialSnapshot
  )
    integrationFail('BOSS_CONFIG_INVALID');
  return {
    account: config.account,
    initialSnapshot: config.initialSnapshot,
    trackerRoot: defaultTrackerRoot,
    dataRoot: defaultTrackerDataRoot,
  };
}

export async function readBossConfig(path = defaultConfigPath) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') integrationFail('BOSS_CONFIG_REQUIRED');
    integrationFail('BOSS_CONFIG_INVALID');
  }
  return normalizeConfig(value);
}

async function regularFile(path, { maxBytes = MAX_SNAPSHOT_BYTES } = {}) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') integrationFail('BOSS_SNAPSHOT_NOT_FOUND');
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink())
    integrationFail('BOSS_SNAPSHOT_PATH_INVALID', { fatal: true });
  if (info.size > maxBytes) integrationFail('BOSS_SNAPSHOT_TOO_LARGE', { fatal: true });
  return info;
}

export function reserveCheckAttempt(inputControl, date) {
  const control = validateBossControl(inputControl);
  const now = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(now.getTime())) integrationFail('BOSS_TIME_INVALID');
  if (!control.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
  if (control.paused) integrationFail('BOSS_INTEGRATION_PAUSED');
  const duplicateUntil = control.lastAttemptAt
    ? new Date(Date.parse(control.lastAttemptAt) + MIN_CHECK_INTERVAL_MS)
    : null;
  // v0.7 persisted a 45-minute nextAllowedAt. It is only a compatibility
  // field now: derive the duplicate-click guard from the actual last read so
  // an old cooldown cannot survive the v0.8 migration.
  if (duplicateUntil && Number.isFinite(duplicateUntil.getTime()) && now < duplicateUntil)
    integrationFail('BOSS_CHECK_TOO_SOON', { nextAllowedAt: duplicateUntil.toISOString() });
  const attempts = control.attempts
    .filter((attempt) => now.getTime() - Date.parse(attempt) < 8 * 24 * 60 * 60 * 1_000)
    .slice(-(BOSS_CONTROL_MAX_ATTEMPTS - 1));
  const attemptedAt = now.toISOString();
  attempts.push(attemptedAt);
  const next = new Date(now.getTime() + MIN_CHECK_INTERVAL_MS).toISOString();
  return validateBossControl({
    ...control,
    attempts,
    lastAttemptAt: attemptedAt,
    nextAllowedAt: next,
  });
}

async function writeRun(inbox, details) {
  return inbox.recordRun({
    format: BOSS_RUN_FORMAT,
    version: 1,
    runId: details.runId,
    command: details.command,
    status: details.status,
    startedAt: details.startedAt,
    finishedAt: details.finishedAt,
    accountNamespace: details.accountNamespace ?? '',
    batchId: details.batchId ?? '',
    snapshotName: details.snapshotName ?? '',
    snapshotSha256: details.snapshotSha256 ?? '',
    counts: details.counts ?? {},
    errorCode: details.errorCode ?? '',
    nextAllowedAt: details.nextAllowedAt ?? '',
  });
}

function normalizedUsage(value, fallback = {}) {
  const result = {};
  for (const key of ['historyRequests', 'domSwitches', 'detailNavigations', 'cdpReconnects'])
    result[key] =
      Number.isSafeInteger(value?.[key]) && value[key] >= 0
        ? value[key]
        : Number.isSafeInteger(fallback[key]) && fallback[key] >= 0
          ? fallback[key]
          : 0;
  return result;
}

function requestedUsage(trackerMode, trackerArguments) {
  const argument = (name) => {
    const index = trackerArguments.indexOf(name);
    return index >= 0 ? Number(trackerArguments[index + 1]) : 0;
  };
  return normalizedUsage({
    historyRequests: trackerMode === 'run' ? argument('--history-requests') : 0,
    domSwitches: trackerMode === 'run' ? argument('--dom-limit') : 0,
    detailNavigations: trackerMode === 'run' ? argument('--detail-limit') : 0,
    cdpReconnects: 0,
  });
}

const DEFAULT_DETAIL_ENRICHMENT = Object.freeze({
  status: 'active',
  pending: 0,
  deferred: 0,
  isolated: 0,
  nextRetryAt: null,
  lastError: null,
});

function normalizedDetailEnrichment(input) {
  if (input === undefined) return { ...DEFAULT_DETAIL_ENRICHMENT };
  plain(input, 'BOSS_TRACKER_OUTPUT_INVALID');
  const value = {
    status: input.status,
    pending: input.pending,
    deferred: input.deferred,
    isolated: input.isolated,
    nextRetryAt: input.nextRetryAt,
    lastError: input.lastError,
  };
  if (
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(Object.keys(value).sort()) ||
    !['active', 'waiting_retry', 'blocked'].includes(value.status) ||
    !['pending', 'deferred', 'isolated'].every(
      (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
    ) ||
    (value.nextRetryAt !== null &&
      (typeof value.nextRetryAt !== 'string' || !Number.isFinite(Date.parse(value.nextRetryAt)))) ||
    (value.lastError !== null && !/^[A-Z][A-Z0-9_]{2,100}$/.test(value.lastError))
  )
    integrationFail('BOSS_TRACKER_OUTPUT_INVALID', { fatal: true });
  return value;
}

function parseTrackerOutput(stdout, fallbackUsage = {}) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_TRACKER_OUTPUT_BYTES)
    integrationFail('BOSS_TRACKER_OUTPUT_INVALID', {
      fatal: true,
      usage: normalizedUsage(null, fallbackUsage),
    });
  let output;
  try {
    output = JSON.parse(stdout);
  } catch {
    integrationFail('BOSS_TRACKER_OUTPUT_INVALID', {
      fatal: true,
      usage: normalizedUsage(null, fallbackUsage),
    });
  }
  plain(output, 'BOSS_TRACKER_OUTPUT_INVALID');
  const durablePartial =
    output.ok === false &&
    output.saved === true &&
    output.partial === true &&
    requiredString(output.file, { max: 2_000 });
  if (
    (output.ok !== true && !durablePartial) ||
    output.saved !== true ||
    !requiredString(output.file, { max: 2_000 })
  ) {
    const code = safeErrorCode({ code: output.error });
    throw new BossIntegrationError(code, code, {
      fatal: isFatalTrackerCode(code),
      usage: normalizedUsage(output.usage, fallbackUsage),
    });
  }
  const partial = output.partial === true,
    failureScope = partial
      ? ['detail', 'account'].includes(output.failureScope)
        ? output.failureScope
        : 'account'
      : 'none';
  return {
    ...output,
    failureScope,
    detailEnrichment: normalizedDetailEnrichment(output.detailEnrichment),
    usage: normalizedUsage(output.usage, fallbackUsage),
  };
}

export function isFatalTrackerCode(code) {
  return /(?:LOGIN|LOGGED|CAPTCHA|VERIFY|ACCOUNT|IDENTITY|TARGET|STRUCTURE|CAPTURE|CONNECTION|SNAPSHOT|CHAT_LIST_NOT_READY|BLANK|SECURITY|SESSION)/.test(
    code,
  );
}

async function invokeTracker(
  config,
  runner = execFile,
  trackerMode = 'check',
  trackerArguments = [],
) {
  const tracker = join(config.trackerRoot, 'tracker.mjs');
  await regularFile(tracker, { maxBytes: 5_000_000 });
  let result;
  const conservativeUsage = requestedUsage(trackerMode, trackerArguments);
  try {
    result = await runner(
      process.execPath,
      [tracker, trackerMode, '--account', config.account, ...trackerArguments],
      {
        cwd: config.trackerRoot,
        encoding: 'utf8',
        maxBuffer: MAX_TRACKER_OUTPUT_BYTES,
        timeout: 22 * 60 * 1_000,
        env: {
          ...process.env,
          ...(config.dataRoot ? { JOB_TRACKER_BOSS_DATA_ROOT: config.dataRoot } : {}),
        },
      },
    );
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim()) {
      // The tracker can emit a saved snapshot and still exit non-zero if its
      // final target/cleanup guard fails. The snapshot is recoverable later,
      // but this run must not be reported as a successful browser check.
      const parsed = parseTrackerOutput(error.stdout, conservativeUsage);
      if (parsed.partial === true) return parsed;
      integrationFail('BOSS_TRACKER_EXIT_FAILED', { fatal: true, usage: parsed.usage });
    }
    integrationFail('BOSS_TRACKER_EXEC_FAILED', { usage: conservativeUsage });
  }
  return parseTrackerOutput(result.stdout, conservativeUsage);
}

function fixedOutputSnapshot(config, trackerOutput) {
  const name = basename(trackerOutput.file);
  const expected = resolve(snapshotDirectory(config), name);
  if (
    !SNAPSHOT_FILE.test(name) ||
    resolve(trackerOutput.file) !== expected ||
    dirname(resolve(trackerOutput.file)) !== resolve(snapshotDirectory(config))
  )
    integrationFail('BOSS_TRACKER_PATH_INVALID', { fatal: true });
  return expected;
}

async function recordFailure({
  inbox,
  control,
  run,
  command,
  step,
  error,
  startedAt,
  counts = {},
  completedItems = 0,
  remainingItems = 0,
}) {
  const finishedAt = new Date().toISOString();
  const code = safeErrorCode(error);
  let updated = control;
  if (error?.fatal && control) {
    updated = validateBossControl({ ...control, paused: true, pauseCode: code });
    await inbox.writeControl(updated);
  }
  const accountNamespace = updated?.accountNamespace ?? '';
  await inbox.recordIncident({
    format: BOSS_INCIDENT_FORMAT,
    version: 1,
    runId: run,
    step,
    errorCode: code,
    startedAt,
    finishedAt,
    accountNamespace,
    lastCheckpoint: updated?.checkpoint?.snapshotName ?? '',
    counts,
    completedItems,
    remainingItems,
    paused: Boolean(updated?.paused),
    cleanupStatus: 'not_required',
  });
  await writeRun(inbox, {
    runId: run,
    command,
    status: 'failed',
    startedAt,
    finishedAt,
    accountNamespace,
    counts,
    errorCode: code,
    nextAllowedAt: error?.nextAllowedAt || updated?.nextAllowedAt || '',
  });
  return updated;
}

async function snapshotProgress(config, initial, current) {
  try {
    const names = await listSnapshotNames(config);
    const first = names.indexOf(initial?.checkpoint?.snapshotName);
    const last = names.indexOf(current?.checkpoint?.snapshotName);
    if (first < 0 || last < 0) return { completedItems: 0, remainingItems: 0 };
    return {
      completedItems: Math.max(0, last - first),
      remainingItems: Math.max(0, names.length - 1 - last),
    };
  } catch {
    return { completedItems: 0, remainingItems: 0 };
  }
}

export async function resumeCommand(inbox) {
  // Explicit operator action only. The next check still runs every identity,
  // login, page and frequency guard; this never reconnects the browser.
  const staleLockReleased = await releaseStaleProducerLock(inbox);
  return withProducerLock(inbox, runId(), async () => {
    const control = await inbox.readControl();
    if (!control?.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
    if (!control.paused) return { resumed: false, staleLockReleased, control };
    const updated = validateBossControl({ ...control, paused: false, pauseCode: '' });
    await inbox.writeControl(updated);
    return { resumed: true, staleLockReleased, control: updated };
  });
}

function locallyRecoverablePause(code) {
  return /^BOSS_(?:SNAPSHOT|CHECKPOINT)_[A-Z0-9_]+$/.test(code || '');
}

export async function recoverSavedCommand(
  config,
  inbox,
  onStage = () => {},
  initialIdentity = APPROVED_INITIAL,
) {
  let control = await inbox.readControl();
  if (!control?.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
  const recovered = await recoverSaved({ config, inbox, control, onStage, initialIdentity });
  control = recovered.control;
  const pauseCleared =
    control.paused && locallyRecoverablePause(control.pauseCode) && !recovered.domRecovery?.partial;
  if (pauseCleared) {
    control = validateBossControl({ ...control, paused: false, pauseCode: '' });
    onStage('clear_local_snapshot_pause');
    await inbox.writeControl(control);
  }
  return {
    recovered,
    control,
    pauseCleared,
    requiresResume: control.paused,
    usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
  };
}

export async function previewCommand(config, expected = APPROVED_INITIAL) {
  const snapshot = await readTrackerSnapshot(initialSnapshotPath(config));
  assertInitialSnapshot(config, snapshot, expected);
  const counts = previewInitialEnvelope(snapshot.envelope);
  assertInitialScope(counts);
  return {
    counts,
    snapshotName: basename(snapshot.path),
    snapshotSha256: snapshot.sha256,
    capturedAt: snapshot.envelope.snapshot.capturedAt,
  };
}

export async function enqueueCommand(
  config,
  inbox,
  expected = APPROVED_INITIAL,
  onStage = () => {},
) {
  onStage('read_initial_snapshot');
  const snapshot = await readTrackerSnapshot(initialSnapshotPath(config));
  assertInitialSnapshot(config, snapshot, expected);
  return deliverSaved({
    mode: 'initial',
    current: snapshot,
    inbox,
    initialIdentity: expected,
    onStage,
  });
}

async function enqueueObservedCommand(config, inbox, mode, evidenceDate, onStage) {
  onStage('read_control');
  const control = await inbox.readControl();
  if (!control?.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
  const previous = await readCheckpointSnapshot(config, control);
  const current = await readLatestSnapshot(config);
  return deliverSaved({ mode, current, previous, control, inbox, evidenceDate, onStage });
}

export async function enqueueDatedYesterdayCommand(
  config,
  inbox,
  evidenceDate,
  onStage = () => {},
) {
  return enqueueObservedCommand(config, inbox, 'dated', evidenceDate, onStage);
}

export async function enqueueResumeCommand(config, inbox, evidenceDate = '', onStage = () => {}) {
  return enqueueObservedCommand(config, inbox, 'resume', evidenceDate, onStage);
}

export async function checkCommand(
  config,
  inbox,
  {
    now = () => new Date(),
    runner = execFile,
    trackerMode = 'check',
    trackerArguments = [],
    onStage = () => {},
    initialIdentity = APPROVED_INITIAL,
  } = {},
) {
  onStage('read_control');
  let control = await inbox.readControl();
  if (!control?.checkpoint) integrationFail('BOSS_INITIAL_ENQUEUE_REQUIRED');
  if (control.paused) integrationFail('BOSS_INTEGRATION_PAUSED');
  const recovered = await recoverSaved({ config, inbox, control, onStage, initialIdentity });
  control = recovered.control;
  if (recovered.recovered)
    return {
      recovered,
      control,
      checked: false,
      batch: null,
      partial: false,
      // Saved-snapshot recovery is entirely local. The runtime requires an
      // exact three-field usage report so it can release the conservative
      // reservation without treating a successful recovery as untrusted.
      usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
    };
  // Do not reserve a browser budget before the local CDP connection has even
  // succeeded. A failed connection must not create a long cooldown.
  const checkTime = now();
  const duplicateUntil = control.lastAttemptAt
    ? new Date(Date.parse(control.lastAttemptAt) + MIN_CHECK_INTERVAL_MS)
    : null;
  if (duplicateUntil && Number.isFinite(duplicateUntil.getTime()) && checkTime < duplicateUntil)
    integrationFail('BOSS_CHECK_TOO_SOON', { nextAllowedAt: duplicateUntil.toISOString() });
  onStage('execute_tracker');
  const trackerOutput = await invokeTracker(config, runner, trackerMode, trackerArguments);
  onStage('record_loaded_list_read');
  control = reserveCheckAttempt(control, now());
  await inbox.writeControl(control);
  onStage('read_saved_snapshot');
  const current = await readTrackerSnapshot(fixedOutputSnapshot(config, trackerOutput));
  const previous = await readCheckpointSnapshot(config, control);
  const applied = await deliverSaved({
    mode: 'incremental',
    inbox,
    control,
    previous,
    current,
    onStage,
    initialIdentity,
  });
  const successful = validateBossControl({
    ...applied.control,
    lastSuccessAt: now().toISOString(),
    paused: false,
    pauseCode: '',
  });
  onStage('commit_success');
  await inbox.writeControl(successful);
  return {
    recovered,
    control: successful,
    checked: true,
    batch: applied.batch,
    partial: trackerOutput.partial === true,
    trackerError:
      trackerOutput.partial === true ? safeErrorCode({ code: trackerOutput.error }) : '',
    failureScope: trackerOutput.failureScope,
    detailEnrichment: trackerOutput.detailEnrichment,
    history: trackerOutput.history,
    usage: trackerOutput.usage ?? {
      historyRequests: 0,
      domSwitches: 0,
      detailNavigations: 0,
    },
  };
}

export async function statusCommand(config, inbox) {
  const control = await inbox.readControl();
  const queue = await inbox.status();
  const [runs, incidents] = await Promise.all([readdir(inbox.runs), readdir(inbox.incidents)]);
  let latestLocalSnapshot = '';
  try {
    latestLocalSnapshot = (await listSnapshotNames(config)).at(-1) ?? '';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    initialized: Boolean(control?.checkpoint),
    paused: control?.paused ?? false,
    pauseCode: control?.pauseCode ?? '',
    lastAttemptAt: control?.lastAttemptAt ?? '',
    lastSuccessAt: control?.lastSuccessAt ?? '',
    nextAllowedAt: control?.nextAllowedAt ?? '',
    checkpointSnapshot: control?.checkpoint?.snapshotName ?? '',
    checkpointSequence: control?.checkpoint?.sourceSequence ?? 0,
    latestLocalSnapshot,
    queue,
    runs: runs.filter((name) => /^boss-run-[a-f0-9]{32}\.json$/.test(name)).length,
    incidents: incidents.filter((name) => /^boss-run-[a-f0-9]{32}\.json$/.test(name)).length,
  };
}

function parseArguments(argv) {
  if (argv[0] === 'check') integrationFail('BOSS_USE_UNIFIED_RUNTIME');
  if (
    argv.length === 9 &&
    argv[0] === 'collect-cycle' &&
    argv[1] === '--history-requests' &&
    /^(?:[0-9]|1[0-9]|20)$/.test(argv[2]) &&
    argv[3] === '--detail-limit' &&
    /^(?:[0-9]|1[0-9]|20)$/.test(argv[4]) &&
    argv[5] === '--dom-limit' &&
    /^[0-1]$/.test(argv[6]) &&
    argv[7] === '--history-mode' &&
    ['change', 'backfill'].includes(argv[8])
  )
    return {
      command: argv[0],
      evidenceDate: '',
      historyRequests: Number(argv[2]),
      detailLimit: Number(argv[4]),
      domLimit: Number(argv[6]),
      historyMode: argv[8],
    };
  if (
    argv.length === 3 &&
    argv[0] === 'enqueue-yesterday' &&
    argv[1] === '--date' &&
    /^\d{4}-\d{2}-\d{2}$/.test(argv[2])
  )
    return {
      command: argv[0],
      evidenceDate: argv[2],
      historyRequests: 0,
      detailLimit: 0,
      domLimit: 0,
    };
  if (
    argv.length === 3 &&
    argv[0] === 'enqueue-resume' &&
    argv[1] === '--date' &&
    /^\d{4}-\d{2}-\d{2}$/.test(argv[2])
  )
    return {
      command: argv[0],
      evidenceDate: argv[2],
      historyRequests: 0,
      detailLimit: 0,
      domLimit: 0,
    };
  if (
    argv.length === 1 &&
    ['preview', 'enqueue', 'enqueue-resume', 'recover-saved', 'status', 'resume'].includes(argv[0])
  )
    return {
      command: argv[0],
      evidenceDate: '',
      historyRequests: 0,
      detailLimit: 0,
      domLimit: 0,
    };
  integrationFail('BOSS_ARGUMENTS_INVALID');
}

export async function main(
  argv = process.argv.slice(2),
  {
    configPath = defaultConfigPath,
    inboxRoot = defaultInboxRoot,
    now = () => new Date(),
    initialIdentity = APPROVED_INITIAL,
    inboxFactory = (root) => new BossInbox(root),
    configReader = readBossConfig,
    internalAuthorization = process.env.JOB_TRACKER_BOSS_INTERNAL_AUTHORIZATION || '',
  } = {},
) {
  const { command, evidenceDate, historyRequests, detailLimit, domLimit, historyMode } =
    parseArguments(argv);
  if (command === 'collect-cycle')
    await consumeBossInternalAuthorization(
      inboxRoot,
      internalAuthorization,
      { command, historyRequests, detailLimit, domLimit, historyMode },
      { now },
    );
  const started = now();
  const startedAt = started.toISOString();
  const id = runId();
  const inbox = inboxFactory(inboxRoot);
  await inbox.initialize();
  let config;
  let step = 'read_config';
  let beforeControl = null;
  try {
    config = await configReader(configPath);
    if (command === 'preview') {
      step = 'read_initial_snapshot';
      const result = await previewCommand(config, initialIdentity);
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: 'succeeded',
        startedAt,
        finishedAt: now().toISOString(),
        snapshotName: result.snapshotName,
        snapshotSha256: result.snapshotSha256,
        counts: result.counts,
      });
      console.log(
        JSON.stringify(
          { ok: true, command, counts: result.counts, snapshot: result.snapshotName },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'enqueue') {
      step = 'read_control';
      beforeControl = await inbox.readControl();
      step = 'producer_lock';
      const result = await withProducerLock(inbox, id, () =>
        enqueueCommand(config, inbox, initialIdentity, (value) => {
          step = value;
        }),
      );
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: 'succeeded',
        startedAt,
        finishedAt: now().toISOString(),
        accountNamespace: result.batch.accountNamespace,
        batchId: result.batch.batchId,
        snapshotName: result.batch.source.snapshotName,
        snapshotSha256: result.batch.source.snapshotSha256,
        counts: {
          included: result.preview.included,
          excludedYesterday: result.preview.excludedYesterday,
          unknownTime: result.preview.unknownTime,
          events: result.batch.events.length,
        },
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command,
            created: result.queued.created,
            counts: {
              included: result.preview.included,
              excludedYesterday: result.preview.excludedYesterday,
              unknownTime: result.preview.unknownTime,
              events: result.batch.events.length,
            },
            batchId: result.batch.batchId,
            queue: inbox.inbox,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'enqueue-yesterday') {
      step = 'read_control';
      beforeControl = await inbox.readControl();
      step = 'producer_lock';
      const result = await withProducerLock(inbox, id, () =>
        enqueueDatedYesterdayCommand(config, inbox, evidenceDate, (value) => {
          step = value;
        }),
      );
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: 'succeeded',
        startedAt,
        finishedAt: now().toISOString(),
        accountNamespace: result.batch.accountNamespace,
        batchId: result.batch.batchId,
        snapshotName: result.batch.source.snapshotName,
        snapshotSha256: result.batch.source.snapshotSha256,
        counts: result.counts,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command,
            created: result.queued.created,
            evidenceDate,
            counts: result.counts,
            batchId: result.batch.batchId,
            queue: inbox.inbox,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'enqueue-resume') {
      step = 'read_control';
      beforeControl = await inbox.readControl();
      step = 'producer_lock';
      const result = await withProducerLock(inbox, id, () =>
        enqueueResumeCommand(config, inbox, evidenceDate, (value) => {
          step = value;
        }),
      );
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: 'succeeded',
        startedAt,
        finishedAt: now().toISOString(),
        accountNamespace: result.batch?.accountNamespace ?? beforeControl?.accountNamespace ?? '',
        batchId: result.batch?.batchId ?? '',
        snapshotName: result.batch?.source.snapshotName ?? result.control.checkpoint.snapshotName,
        snapshotSha256:
          result.batch?.source.snapshotSha256 ?? result.control.checkpoint.snapshotSha256,
        counts: result.counts,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command,
            created: result.queued.created,
            counts: result.counts,
            batchId: result.batch?.batchId ?? '',
            queue: inbox.inbox,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'collect-cycle') {
      step = 'read_control';
      const before = await inbox.readControl();
      let checkStep = 'read_control';
      try {
        const result = await withProducerLock(inbox, id, () =>
          checkCommand(config, inbox, {
            now,
            trackerMode: 'run',
            trackerArguments: [
              '--history-requests',
              String(historyRequests),
              '--detail-limit',
              String(detailLimit),
              '--dom-limit',
              String(domLimit),
              '--history-mode',
              historyMode,
            ],
            onStage: (value) => {
              checkStep = value;
            },
          }),
        );
        const events = result.batch?.events.length ?? result.recovered.events;
        const counts = {
          browserChecks: result.checked ? 1 : 0,
          recoveredSnapshots: result.recovered.recovered,
          batches: result.batch ? 1 : result.recovered.batches,
          events,
          historyRequests: result.usage?.historyRequests ?? 0,
          domSwitches: result.usage?.domSwitches ?? 0,
          detailNavigations: result.usage?.detailNavigations ?? 0,
          cdpReconnects: result.usage?.cdpReconnects ?? 0,
        };
        await writeRun(inbox, {
          runId: id,
          command,
          status: result.partial ? 'partial' : result.checked ? 'succeeded' : 'recovered',
          startedAt,
          finishedAt: now().toISOString(),
          accountNamespace: result.control.accountNamespace,
          batchId: result.batch?.batchId ?? '',
          snapshotName: result.control.checkpoint.snapshotName,
          snapshotSha256: result.control.checkpoint.snapshotSha256,
          counts,
          errorCode: result.partial ? result.trackerError : '',
          nextAllowedAt: result.control.nextAllowedAt,
        });
        console.log(
          JSON.stringify(
            {
              ok: true,
              command,
              checked: result.checked,
              partial: result.partial ?? false,
              error: result.trackerError || '',
              failureScope: result.failureScope,
              detailEnrichment: result.detailEnrichment,
              history: result.history,
              paused: result.control.paused,
              counts,
              usage: result.usage,
              nextAllowedAt: result.control.nextAllowedAt,
              queue: inbox.inbox,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        const latest = (await inbox.readControl()) ?? before;
        const progress = await snapshotProgress(config, before, latest);
        const failed = await recordFailure({
          inbox,
          control: latest,
          run: id,
          command,
          step: error?.code === 'BOSS_PRODUCER_BUSY' ? 'producer_lock' : checkStep,
          error,
          startedAt,
          counts: {
            completedSnapshots: progress.completedItems,
            remainingSnapshots: progress.remainingItems,
            historyRequests: error?.usage?.historyRequests ?? 0,
            domSwitches: error?.usage?.domSwitches ?? 0,
            detailNavigations: error?.usage?.detailNavigations ?? 0,
            cdpReconnects: error?.usage?.cdpReconnects ?? 0,
          },
          ...progress,
        });
        console.log(
          JSON.stringify(
            {
              ok: false,
              command,
              error: safeErrorCode(error),
              paused: failed?.paused ?? false,
              nextAllowedAt: error?.nextAllowedAt || failed?.nextAllowedAt || '',
              usage: normalizedUsage(error?.usage),
              incidents: inbox.incidents,
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
      }
      return;
    }
    if (command === 'recover-saved') {
      step = 'read_control';
      beforeControl = await inbox.readControl();
      step = 'release_stale_lock';
      const staleLockReleased = await releaseStaleProducerLock(inbox);
      step = 'producer_lock';
      const result = await withProducerLock(inbox, id, () =>
        recoverSavedCommand(
          config,
          inbox,
          (value) => {
            step = value;
          },
          initialIdentity,
        ),
      );
      const counts = {
        recoveredSnapshots: result.recovered.recovered,
        batches: result.recovered.batches,
        events: result.recovered.events,
        pauseCleared: Number(result.pauseCleared),
        staleLockReleased: Number(staleLockReleased),
      };
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: result.recovered.recovered ? 'recovered' : 'unchanged',
        startedAt,
        finishedAt: now().toISOString(),
        accountNamespace: result.control.accountNamespace,
        snapshotName: result.control.checkpoint.snapshotName,
        snapshotSha256: result.control.checkpoint.snapshotSha256,
        counts,
        nextAllowedAt: result.control.nextAllowedAt,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command,
            localRecovery: true,
            checked: false,
            counts,
            pauseCleared: result.pauseCleared,
            requiresResume: result.requiresResume,
            usage: result.usage,
            queue: inbox.inbox,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'resume') {
      step = 'read_control';
      beforeControl = await inbox.readControl();
      step = 'resume_control';
      const result = await resumeCommand(inbox);
      step = 'record_run';
      await writeRun(inbox, {
        runId: id,
        command,
        status: result.resumed ? 'succeeded' : 'unchanged',
        startedAt,
        finishedAt: now().toISOString(),
        accountNamespace: result.control.accountNamespace,
        snapshotName: result.control.checkpoint.snapshotName,
        snapshotSha256: result.control.checkpoint.snapshotSha256,
        counts: {
          resumed: Number(result.resumed),
          staleLockReleased: Number(result.staleLockReleased),
        },
        nextAllowedAt: result.control.nextAllowedAt,
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            command,
            resumed: result.resumed,
            staleLockReleased: result.staleLockReleased,
            nextAllowedAt: result.control.nextAllowedAt,
          },
          null,
          2,
        ),
      );
      return;
    }
    step = 'read_status';
    const result = await statusCommand(config, inbox);
    console.log(JSON.stringify({ ok: true, command, ...result, root: inbox.root }, null, 2));
  } catch (error) {
    if (!(error instanceof BossIntegrationError || error instanceof BossInboxError)) {
      error = new BossIntegrationError('BOSS_INTEGRATION_FAILED');
    }
    let incidentRecorded = false;
    let latest = null;
    try {
      latest = await inbox.readControl();
    } catch {
      latest = beforeControl;
    }
    let counts = {};
    let completedItems = 0;
    let remainingItems = 0;
    if (command === 'enqueue') {
      try {
        const queued = (await inbox.list()).filter(
          (row) =>
            row.policyMode === 'initial' &&
            row.snapshotName === initialIdentity.name &&
            row.snapshotSha256 === initialIdentity.sha256,
        );
        const checkpointCommitted = Number(
          latest?.checkpoint?.snapshotName === initialIdentity.name &&
            latest?.checkpoint?.snapshotSha256 === initialIdentity.sha256,
        );
        counts = { queuedBatches: queued.length, checkpointCommitted };
        completedItems = queued.length;
        remainingItems = queued.length && !checkpointCommitted ? 1 : 0;
      } catch {
        counts = {};
      }
    } else if (command === 'resume') {
      counts = { resumed: Number(Boolean(beforeControl?.paused && latest && !latest.paused)) };
      completedItems = counts.resumed;
    } else if (command === 'recover-saved') {
      const progress = await snapshotProgress(config, beforeControl, latest);
      counts = {
        completedSnapshots: progress.completedItems,
        remainingSnapshots: progress.remainingItems,
      };
      completedItems = progress.completedItems;
      remainingItems = progress.remainingItems;
    }
    try {
      await recordFailure({
        inbox,
        control: latest,
        run: id,
        command,
        step,
        error,
        startedAt,
        counts,
        completedItems,
        remainingItems,
      });
      incidentRecorded = true;
    } catch {
      // A broken private volume can also prevent diagnostics. Keep stdout
      // limited to error codes and tell the operator the incident was not saved.
    }
    console.log(
      JSON.stringify(
        {
          ok: false,
          command,
          error: safeErrorCode(error),
          step,
          incidentRecorded,
          ...(command === 'collect-cycle' ? { usage: normalizedUsage(error?.usage) } : {}),
          incidents: inbox.incidents,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
