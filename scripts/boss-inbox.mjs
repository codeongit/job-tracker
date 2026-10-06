import { recordAttributionDiagnostic } from './boss-attribution-diagnostics.mjs';
import { buildBossAttributionContext } from '../dist/boss-attribution.js';
import {
  validateBossBatch as validateBatchStructure,
  bossEventDigestInput,
  bossBatchDigestInput,
} from '../dist/boss-batch.js';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const BOSS_BATCH_FORMAT = 'job-tracker-boss-batch';
export const BOSS_RECEIPT_FORMAT = 'job-tracker-boss-receipt';
export const BOSS_CONTROL_FORMAT = 'job-tracker-boss-control';
export const BOSS_RUN_FORMAT = 'job-tracker-boss-run';
export const BOSS_INCIDENT_FORMAT = 'job-tracker-boss-incident';
export const BOSS_INTEGRATION_VERSION = 4;
export const BOSS_CONTROL_MAX_ATTEMPTS = 128;
const SUPPORTED_QUEUE_VERSIONS = new Set([1, 2, 3, BOSS_INTEGRATION_VERSION]);

const MAX_BATCH_BYTES = 5_000_000;
const MAX_CONTROL_BYTES = 128_000;
const BATCH_ID = /^boss-batch-[a-f0-9]{64}$/;
const RUN_ID = /^boss-run-[a-f0-9]{32}$/;
const WORKSPACE_SOURCE_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ERROR = /^(?:[A-Z][A-Z0-9_]{2,100})?$/;
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.json$/;
const DAY = /^(?:\d{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

export class BossInboxError extends Error {
  constructor(message, status = 400, code = 'BOSS_INBOX_INVALID') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(message, status, code) {
  throw new BossInboxError(message, status, code);
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 格式无效。`);
  return value;
}

function exactKeys(value, keys, label) {
  plain(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} 包含未知或缺失字段。`);
}

function string(value, label, { max = 1_000, empty = true, pattern } = {}) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && value.length === 0) ||
    /\u0000/.test(value) ||
    (pattern && !pattern.test(value))
  )
    fail(`${label} 格式无效。`);
  return value;
}

function oneOf(value, values, label) {
  if (!values.includes(value)) fail(`${label} 格式无效。`);
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} 格式无效。`);
  return value;
}

function iso(value, label, { empty = false } = {}) {
  string(value, label, { max: 40, empty });
  if (value === '' && empty) return value;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail(`${label} 格式无效。`);
  return value;
}

function day(value, label, { empty = true } = {}) {
  string(value, label, { max: 10, empty });
  if (value) {
    if (!DAY.test(value)) fail(`${label} 格式无效。`);
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
      fail(`${label} 格式无效。`);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

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
  if (!SUPPORTED_QUEUE_VERSIONS.has(input?.version))
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

const COUNT_KEYS = ['added', 'linked', 'observed', 'reviewed', 'skipped'];

export function validateBossReceipt(input) {
  const value = clone(input);
  exactKeys(
    value,
    [
      'format',
      'version',
      'batchId',
      'workspaceSourceId',
      'status',
      'processedAt',
      'counts',
      'errorCode',
    ],
    '回执',
  );
  if (value.format !== BOSS_RECEIPT_FORMAT || !SUPPORTED_QUEUE_VERSIONS.has(value.version))
    fail('回执版本不受支持。', 409, 'BOSS_RECEIPT_VERSION_UNSUPPORTED');
  string(value.batchId, 'receipt.batchId', { max: 75, empty: false, pattern: BATCH_ID });
  string(value.workspaceSourceId, 'receipt.workspaceSourceId', {
    max: 36,
    empty: false,
    pattern: WORKSPACE_SOURCE_ID,
  });
  // A receipt is a durable acknowledgement. Failed consumption must remain
  // unacknowledged so a later page session can safely retry it.
  oneOf(value.status, ['processed'], 'receipt.status');
  iso(value.processedAt, 'receipt.processedAt');
  exactKeys(value.counts, COUNT_KEYS, 'receipt.counts');
  for (const key of COUNT_KEYS)
    integer(value.counts[key], `receipt.counts.${key}`, { max: 100_000 });
  string(value.errorCode, 'receipt.errorCode', { max: 100, pattern: SAFE_ERROR });
  if ((value.status === 'processed') !== (value.errorCode === '')) fail('回执状态与错误码不相容。');
  return value;
}

async function ensureDirectory(path) {
  try {
    const existing = await lstat(path);
    if (!existing.isDirectory() || existing.isSymbolicLink())
      fail('BOSS 接入目录必须是本机普通目录。', 500, 'BOSS_INBOX_PATH_INVALID');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path, { mode: 0o700 });
  }
  await chmod(path, 0o700);
}

async function ensureParentDirectory(path) {
  // The parent can be a shared directory (notably /private/tmp in tests).
  // Creating a missing task parent is safe; chmod on an existing parent is not.
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    fail('BOSS 接入父目录必须是本机普通目录。', 500, 'BOSS_INBOX_PATH_INVALID');
}

async function regularFile(path, { missing = false, maxBytes = MAX_BATCH_BYTES } = {}) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      fail('BOSS 接入文件必须是本机普通文件。', 500, 'BOSS_INBOX_PATH_INVALID');
    if (info.size > maxBytes) fail('BOSS 接入文件超过大小限制。', 413, 'BOSS_INBOX_TOO_LARGE');
    return info;
  } catch (error) {
    if (error.code === 'ENOENT' && missing) return null;
    throw error;
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeNewJson(directory, filename, value, { maxBytes = MAX_BATCH_BYTES } = {}) {
  await ensureDirectory(directory);
  const target = join(directory, filename);
  await regularFile(target, { missing: true, maxBytes });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > maxBytes)
    fail('BOSS 接入内容超过大小限制。', 413, 'BOSS_INBOX_TOO_LARGE');
  const temporary = join(directory, `.pending-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporary, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    }
    await chmod(target, 0o600);
    await syncDirectory(directory);
    return true;
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export function validateBossControl(input) {
  const value = clone(input);
  exactKeys(
    value,
    [
      'format',
      'version',
      'accountNamespace',
      'checkpoint',
      'attempts',
      'lastAttemptAt',
      'lastSuccessAt',
      'nextAllowedAt',
      'paused',
      'pauseCode',
    ],
    '控制状态',
  );
  if (value.format !== BOSS_CONTROL_FORMAT || !SUPPORTED_QUEUE_VERSIONS.has(value.version))
    fail('控制状态版本不受支持。', 409, 'BOSS_CONTROL_VERSION_UNSUPPORTED');
  string(value.accountNamespace, 'control.accountNamespace', {
    max: 75,
    pattern: /^(?:|boss-geek:[a-f0-9]{64})$/,
  });
  if (value.checkpoint !== null) {
    exactKeys(
      value.checkpoint,
      ['snapshotName', 'snapshotSha256', 'capturedAt', 'sourceSequence'],
      'control.checkpoint',
    );
    string(value.checkpoint.snapshotName, 'control.checkpoint.snapshotName', {
      max: 205,
      empty: false,
      pattern: SNAPSHOT_NAME,
    });
    string(value.checkpoint.snapshotSha256, 'control.checkpoint.snapshotSha256', {
      max: 64,
      empty: false,
      pattern: SHA256,
    });
    iso(value.checkpoint.capturedAt, 'control.checkpoint.capturedAt');
    integer(value.checkpoint.sourceSequence, 'control.checkpoint.sourceSequence', { min: 0 });
  }
  if (!Array.isArray(value.attempts) || value.attempts.length > BOSS_CONTROL_MAX_ATTEMPTS)
    fail('control.attempts 格式无效。');
  value.attempts.forEach((attempt, index) => iso(attempt, `control.attempts[${index}]`));
  if (new Set(value.attempts).size !== value.attempts.length)
    fail('control.attempts 包含重复时间。');
  for (const key of ['lastAttemptAt', 'lastSuccessAt', 'nextAllowedAt'])
    iso(value[key], `control.${key}`, { empty: true });
  if (typeof value.paused !== 'boolean') fail('control.paused 格式无效。');
  string(value.pauseCode, 'control.pauseCode', { max: 100, pattern: SAFE_ERROR });
  if (value.paused !== Boolean(value.pauseCode)) fail('暂停状态与错误码不相容。');
  if (
    value.accountNamespace &&
    value.checkpoint === null &&
    (value.lastSuccessAt || value.nextAllowedAt || value.attempts.length)
  )
    fail('控制状态缺少检查点。');
  return value;
}

async function replaceJson(directory, filename, value, { maxBytes = MAX_CONTROL_BYTES } = {}) {
  await ensureDirectory(directory);
  const target = join(directory, filename);
  await regularFile(target, { missing: true, maxBytes });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > maxBytes)
    fail('BOSS 接入内容超过大小限制。', 413, 'BOSS_INBOX_TOO_LARGE');
  const temporary = join(directory, `.pending-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    await chmod(target, 0o600);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function readJson(path, { maxBytes = MAX_BATCH_BYTES } = {}) {
  await regularFile(path, { maxBytes });
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
  try {
    return JSON.parse(raw);
  } catch {
    fail('BOSS 接入 JSON 无效。', 500, 'BOSS_INBOX_JSON_INVALID');
  }
}

function batchFilename(batchId) {
  string(batchId, 'batchId', { max: 75, empty: false, pattern: BATCH_ID });
  return `${batchId}.json`;
}

function sourceFilename(sourceId) {
  string(sourceId, 'workspaceSourceId', {
    max: 36,
    empty: false,
    pattern: WORKSPACE_SOURCE_ID,
  });
  return `${sourceId}.json`;
}

function safeRecord(value, kind) {
  const expectedFormat = kind === 'run' ? BOSS_RUN_FORMAT : BOSS_INCIDENT_FORMAT;
  const keys =
    kind === 'run'
      ? [
          'format',
          'version',
          'runId',
          'command',
          'status',
          'startedAt',
          'finishedAt',
          'accountNamespace',
          'batchId',
          'snapshotName',
          'snapshotSha256',
          'counts',
          'errorCode',
          'nextAllowedAt',
        ]
      : [
          'format',
          'version',
          'runId',
          'step',
          'errorCode',
          'startedAt',
          'finishedAt',
          'accountNamespace',
          'lastCheckpoint',
          'counts',
          'completedItems',
          'remainingItems',
          'paused',
          'cleanupStatus',
        ];
  const output = clone(value);
  exactKeys(output, keys, kind === 'run' ? '运行记录' : '故障记录');
  if (output.format !== expectedFormat || output.version !== 1) fail('运行材料版本无效。');
  string(output.runId, 'runId', { max: 41, empty: false, pattern: RUN_ID });
  for (const key of kind === 'run' ? ['command', 'status'] : ['step', 'cleanupStatus'])
    string(output[key], key, { max: 100, empty: false, pattern: /^[a-z0-9_.-]+$/ });
  string(output.errorCode, 'errorCode', { max: 100, pattern: SAFE_ERROR });
  iso(output.startedAt, 'startedAt');
  iso(output.finishedAt, 'finishedAt');
  string(output.accountNamespace, 'accountNamespace', {
    max: 75,
    pattern: /^(?:boss-geek:[a-f0-9]{64})?$/,
  });
  plain(output.counts, 'counts');
  for (const [key, count] of Object.entries(output.counts)) {
    string(key, 'counts key', { max: 50, empty: false, pattern: /^[a-z][A-Za-z0-9]*$/ });
    integer(count, `counts.${key}`, { max: 1_000_000 });
  }
  if (kind === 'run') {
    string(output.batchId, 'batchId', { max: 75, pattern: /^(?:boss-batch-[a-f0-9]{64})?$/ });
    string(output.snapshotName, 'snapshotName', {
      max: 205,
      pattern: /^(?:|[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\.json)$/,
    });
    string(output.snapshotSha256, 'snapshotSha256', { max: 64, pattern: /^(?:|[a-f0-9]{64})$/ });
    iso(output.nextAllowedAt, 'nextAllowedAt', { empty: true });
  } else {
    string(output.lastCheckpoint, 'lastCheckpoint', { max: 205 });
    integer(output.completedItems, 'completedItems', { max: 1_000_000 });
    integer(output.remainingItems, 'remainingItems', { max: 1_000_000 });
    if (typeof output.paused !== 'boolean') fail('paused 格式无效。');
  }
  return output;
}

export class BossInbox {
  constructor(root, { beforeCommit = async () => {} } = {}) {
    if (typeof root !== 'string' || !root || !root.startsWith('/'))
      fail('BOSS 接入根目录必须是绝对路径。', 500, 'BOSS_INBOX_PATH_INVALID');
    this.root = root;
    this.inbox = join(root, 'inbox');
    this.receipts = join(root, 'receipts');
    this.runs = join(root, 'runs');
    this.incidents = join(root, 'incidents');
    this.controlPath = join(root, 'control.json');
    this.beforeCommit = beforeCommit;
    this.queue = Promise.resolve();
  }

  exclusive(task) {
    const job = this.queue.then(task);
    this.queue = job.catch(() => {});
    return job;
  }

  async initialize() {
    await ensureParentDirectory(dirname(this.root));
    await ensureDirectory(this.root);
    for (const directory of [this.inbox, this.receipts, this.runs, this.incidents])
      await ensureDirectory(directory);
  }

  async enqueue(input) {
    const batch = validateBossBatch(input);
    return this.exclusive(async () => {
      await this.initialize();
      const attributionContext = buildBossAttributionContext(
        batch.events.map((event) => ({ ...event, accountNamespace: batch.accountNamespace })),
      );
      for (const event of batch.events)
        if (event.eventType === 'resume_observed')
          await recordAttributionDiagnostic(
            this.root,
            batch.accountNamespace,
            event,
            'queue',
            attributionContext,
          );
      await this.beforeCommit('batch', batch);
      const filename = batchFilename(batch.batchId);
      const created = await writeNewJson(this.inbox, filename, batch);
      if (!created) {
        const existing = validateBossBatch(await readJson(join(this.inbox, filename)));
        if (
          JSON.stringify({ ...existing, version: BOSS_INTEGRATION_VERSION }) !==
          JSON.stringify({ ...batch, version: BOSS_INTEGRATION_VERSION })
        )
          fail('同一批次标识已有不同内容。', 409, 'BOSS_BATCH_CONFLICT');
      }
      return { batchId: batch.batchId, created, events: batch.events.length };
    });
  }

  async read(batchId) {
    await this.initialize();
    const path = join(this.inbox, batchFilename(batchId));
    try {
      return validateBossBatch(await readJson(path));
    } catch (error) {
      if (error.code === 'ENOENT') fail('BOSS 接入批次不存在。', 404, 'BOSS_BATCH_NOT_FOUND');
      throw error;
    }
  }

  async readReceipt(batchId, workspaceSourceId) {
    batchFilename(batchId);
    const filename = sourceFilename(workspaceSourceId);
    const directory = join(this.receipts, batchId);
    try {
      const value = validateBossReceipt(
        await readJson(join(directory, filename), { maxBytes: MAX_CONTROL_BYTES }),
      );
      if (value.batchId !== batchId || value.workspaceSourceId !== workspaceSourceId)
        fail('BOSS 接入回执身份不一致。', 500, 'BOSS_RECEIPT_INVALID');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async acknowledge(batchId, input) {
    const receipt = validateBossReceipt(input);
    if (receipt.batchId !== batchId) fail('回执批次不一致。');
    return this.exclusive(async () => {
      await this.read(batchId);
      await this.initialize();
      const directory = join(this.receipts, batchId);
      await ensureDirectory(directory);
      await this.beforeCommit('receipt', receipt);
      const filename = sourceFilename(receipt.workspaceSourceId);
      const created = await writeNewJson(directory, filename, receipt, {
        maxBytes: MAX_CONTROL_BYTES,
      });
      if (!created) {
        const existing = validateBossReceipt(
          await readJson(join(directory, filename), { maxBytes: MAX_CONTROL_BYTES }),
        );
        if (
          JSON.stringify({ ...existing, version: BOSS_INTEGRATION_VERSION }) !==
          JSON.stringify({ ...receipt, version: BOSS_INTEGRATION_VERSION })
        )
          fail('该工作区已有不同的批次回执。', 409, 'BOSS_RECEIPT_CONFLICT');
      }
      return { batchId, created, status: receipt.status };
    });
  }

  async list({ workspaceSourceId } = {}) {
    await this.initialize();
    if (workspaceSourceId) sourceFilename(workspaceSourceId);
    const rows = [];
    for (const name of (await readdir(this.inbox)).sort()) {
      if (!/^boss-batch-[a-f0-9]{64}\.json$/.test(name)) continue;
      const batch = validateBossBatch(await readJson(join(this.inbox, name)));
      const receipt = workspaceSourceId
        ? await this.readReceipt(batch.batchId, workspaceSourceId)
        : null;
      rows.push({
        batchId: batch.batchId,
        platform: batch.platform,
        accountNamespace: batch.accountNamespace,
        sourceSequence: batch.sourceSequence,
        policyId: batch.policy.id,
        policyMode: batch.policy.mode,
        snapshotName: batch.source.snapshotName,
        snapshotSha256: batch.source.snapshotSha256,
        capturedAt: batch.source.capturedAt,
        eventCount: batch.events.length,
        receipt,
      });
    }
    return rows.sort(
      (a, b) =>
        a.accountNamespace.localeCompare(b.accountNamespace) ||
        a.sourceSequence - b.sourceSequence ||
        a.batchId.localeCompare(b.batchId),
    );
  }

  async status({ workspaceSourceId } = {}) {
    const batches = await this.list({ workspaceSourceId });
    let processed = batches.filter((row) => row.receipt?.status === 'processed').length;
    let blocked = batches.filter((row) => row.receipt?.status === 'blocked').length;
    let receipts = processed + blocked;
    let processedBatches = processed;
    if (!workspaceSourceId) {
      processed = 0;
      blocked = 0;
      receipts = 0;
      processedBatches = 0;
      for (const row of batches) {
        const directory = join(this.receipts, row.batchId);
        let names = [];
        try {
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink())
            fail('BOSS 回执目录无效。', 500, 'BOSS_INBOX_PATH_INVALID');
          names = await readdir(directory);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        let batchProcessed = false;
        for (const name of names.filter((entry) => /^[a-f0-9-]{36}\.json$/.test(entry))) {
          const receipt = validateBossReceipt(
            await readJson(join(directory, name), { maxBytes: MAX_CONTROL_BYTES }),
          );
          if (receipt.batchId !== row.batchId || `${receipt.workspaceSourceId}.json` !== name)
            fail('BOSS 回执身份不一致。', 500, 'BOSS_RECEIPT_INVALID');
          receipts += 1;
          if (receipt.status === 'processed') {
            processed += 1;
            batchProcessed = true;
          } else blocked += 1;
        }
        if (batchProcessed) processedBatches += 1;
      }
    }
    const [runNames, incidentNames] = await Promise.all([
      readdir(this.runs),
      readdir(this.incidents),
    ]);
    return {
      enabled: true,
      batches: batches.length,
      events: batches.reduce((total, row) => total + row.eventCount, 0),
      receipts,
      processed,
      processedBatches,
      blocked,
      pending: batches.length - processedBatches,
      runs: runNames.filter((name) => /^boss-run-[a-f0-9]{32}\.json$/.test(name)).length,
      incidents: incidentNames.filter((name) => /^boss-run-[a-f0-9]{32}\.json$/.test(name)).length,
      latestCapturedAt: batches.at(-1)?.capturedAt ?? '',
    };
  }

  async readControl() {
    await this.initialize();
    try {
      return validateBossControl(await readJson(this.controlPath, { maxBytes: MAX_CONTROL_BYTES }));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeControl(value) {
    const control = validateBossControl({ ...value, version: BOSS_INTEGRATION_VERSION });
    return this.exclusive(async () => {
      await this.initialize();
      await this.beforeCommit('control', control);
      await replaceJson(this.root, 'control.json', control);
      return clone(control);
    });
  }

  async recordRun(value) {
    const record = safeRecord(value, 'run');
    return this.exclusive(async () => {
      await this.initialize();
      const created = await writeNewJson(this.runs, `${record.runId}.json`, record, {
        maxBytes: MAX_CONTROL_BYTES,
      });
      if (!created) fail('运行记录已存在。', 409, 'BOSS_RUN_CONFLICT');
      return { runId: record.runId };
    });
  }

  async recordIncident(value) {
    const record = safeRecord(value, 'incident');
    return this.exclusive(async () => {
      await this.initialize();
      const created = await writeNewJson(this.incidents, `${record.runId}.json`, record, {
        maxBytes: MAX_CONTROL_BYTES,
      });
      if (!created) fail('故障记录已存在。', 409, 'BOSS_INCIDENT_CONFLICT');
      return { runId: record.runId };
    });
  }
}
