import { mkdir, open, readFile, rename, unlink, lstat, rmdir, chmod } from 'node:fs/promises';
import { join, isAbsolute, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { migrateWorkspace, restoreWorkspace } from '../dist/workspace.js';
import { acknowledge, validateConfig } from '../dist/github.js';
import {
  SOURCE_AUTO_FIELDS,
  emptyData,
  equal,
  markManualFields,
  mergeData,
  releaseManualFieldOwnership,
  resolveConflicts,
  validateData,
} from '../dist/model.js';
import { bindBossAccount, rejectMisattributedResumeObservation } from '../dist/boss-integration.js';
import { MAX_BACKUP_BYTES } from '../dist/limits.js';

export const WORKSPACE_PROTOCOL_VERSION = 1;
export const WORKSPACE_STORAGE_VERSION = 1;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT_FILE = /^\d{12}-[a-f0-9]{64}\.json$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/;
const SYNC_TRANSACTION_ID =
  /^sync-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_COMMIT_BYTES = MAX_BACKUP_BYTES + 1024 * 1024;
const MAX_SYNC_TRANSACTIONS = 32;
const BUSINESS_GROUPS = new Set(['opportunities', 'activities', 'tasks', 'imports']);
const COMMAND_TYPES = new Set([
  'import_workspace',
  'commit_workspace',
  'edit_data',
  'set_sync_config',
  'stage_sync_conflict',
  'resolve_sync_conflict',
  'restore_workspace',
  'acknowledge_sync',
  'bind_boss_account',
  'correct_boss_resume_request',
  'reject_boss_resume_observation',
]);

export class WorkspaceStoreError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const fail = (code, message, status) => {
  throw new WorkspaceStoreError(code, message, status);
};
const copy = (value) => structuredClone(value);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const workspaceDigest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
function object(value, fields) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    fail('WORKSPACE_INVALID', '工作区命令或存储格式无效。', 400);
  return value;
}
async function regular(path, { missing = false } = {}) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_COMMIT_BYTES)
      fail('WORKSPACE_PATH_INVALID', '工作区私有文件类型或大小无效。', 500);
    return info;
  } catch (error) {
    if (missing && error.code === 'ENOENT') return null;
    throw error;
  }
}
async function privateDirectory(path) {
  const parent = dirname(path);
  try {
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
      fail('WORKSPACE_PATH_INVALID', '工作区父目录必须是本机普通目录。', 500);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    fail('WORKSPACE_PATH_INVALID', '工作区必须使用本机普通目录。', 500);
  await chmod(path, 0o700);
}
async function readJson(path) {
  await regular(path);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)));
  } catch {
    fail('WORKSPACE_CORRUPT', '工作区文件无法校验，已停止写入。', 500);
  }
}
async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeExclusive(path, value) {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > MAX_COMMIT_BYTES)
    fail('WORKSPACE_TOO_LARGE', '工作区超过本机存储上限。', 413);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function replaceJson(directory, filename, value, sync = syncDirectory) {
  const temporary = join(directory, `.pending-${randomUUID()}`);
  const target = join(directory, filename);
  await regular(target, { missing: true });
  try {
    await writeExclusive(temporary, value);
    await rename(temporary, target);
    await sync(directory);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function pendingConflictScope(workspace) {
  const opportunityIds = new Set(),
    dataSets = [workspace.data, workspace.pending?.data, workspace.pending?.remote].filter(Boolean),
    factOpportunityIds = new Map();
  for (const data of dataSets)
    for (const row of [...(data.sourceEvents || []), ...(data.sourceApplications || [])])
      if (row.factId && row.opportunityId) {
        const ids = factOpportunityIds.get(row.factId) || new Set();
        ids.add(row.opportunityId);
        factOpportunityIds.set(row.factId, ids);
      }
  let unscoped = false;
  for (const conflict of workspace.pending?.conflicts || []) {
    let scoped = false;
    if (conflict.group === 'opportunities') {
      opportunityIds.add(conflict.id);
      scoped = true;
    }
    for (const row of [conflict.base, conflict.local, conflict.remote].filter(Boolean)) {
      if (row.opportunityId) {
        opportunityIds.add(row.opportunityId);
        scoped = true;
      }
      if (conflict.group === 'sourceBindings' && row.kind === 'account') unscoped = true;
      if (row.externalJobId) {
        for (const data of dataSets)
          for (const binding of data.sourceBindings || [])
            if (
              binding.kind === 'opportunity' &&
              binding.externalJobId === row.externalJobId &&
              (!row.accountNamespace || binding.accountNamespace === row.accountNamespace)
            ) {
              opportunityIds.add(binding.opportunityId);
              scoped = true;
            }
      }
      if (row.factId)
        for (const opportunityId of factOpportunityIds.get(row.factId) || []) {
          opportunityIds.add(opportunityId);
          scoped = true;
        }
    }
    if (conflict.group === 'sourceFacts')
      for (const opportunityId of factOpportunityIds.get(conflict.id) || []) {
        opportunityIds.add(opportunityId);
        scoped = true;
      }
    if (!scoped) unscoped = true;
  }
  return { opportunityIds, unscoped };
}

function mergeSyncData(base, local, remote, workspaceId) {
  const merged = mergeData(base, local, remote),
    baseBindings = new Map(base.sourceBindings.map((row) => [row.id, row])),
    remoteBindings = new Map(remote.sourceBindings.map((row) => [row.id, row]));
  for (const localBinding of local.sourceBindings) {
    if (
      localBinding.kind !== 'account' ||
      localBinding.platform !== 'boss' ||
      localBinding.deletedAt ||
      localBinding.workspaceSourceId !== workspaceId
    )
      continue;
    const baseBinding = baseBindings.get(localBinding.id),
      remoteBinding = remoteBindings.get(localBinding.id),
      baseOwnsIdentity =
        baseBinding?.kind === 'account' &&
        baseBinding.platform === 'boss' &&
        !baseBinding.deletedAt &&
        baseBinding.workspaceSourceId === workspaceId,
      remoteKeepsIdentity =
        remoteBinding?.kind === 'account' &&
        remoteBinding.platform === 'boss' &&
        !remoteBinding.deletedAt &&
        remoteBinding.workspaceSourceId === workspaceId &&
        remoteBinding.accountNamespace === localBinding.accountNamespace;
    // A remote-only mutation cannot silently transfer or remove a BOSS account
    // already owned by this service. The first post-migration sync is different:
    // its base still carries the old browser identity, so the local service ID is
    // uploaded normally instead of becoming a manufactured conflict.
    if (!baseOwnsIdentity || remoteKeepsIdentity) continue;
    const key = `sourceBindings:${localBinding.id}`;
    if (!merged.conflicts.some((conflict) => conflict.key === key))
      merged.conflicts.push({
        key,
        group: 'sourceBindings',
        id: localBinding.id,
        base: copy(baseBinding),
        local: copy(localBinding),
        ...(remoteBinding ? { remote: copy(remoteBinding) } : {}),
      });
    const index = merged.data.sourceBindings.findIndex((row) => row.id === localBinding.id);
    if (index >= 0) merged.data.sourceBindings[index] = copy(localBinding);
    else merged.data.sourceBindings.push(copy(localBinding));
  }
  merged.conflicts.sort((left, right) => left.key.localeCompare(right.key));
  return merged;
}

// Exactly one service owns the writer lock. CLI and browsers submit commands to that service.
export class WorkspaceStore {
  constructor(
    root,
    {
      instanceId = randomUUID(),
      now = () => new Date().toISOString(),
      beforeCommit = async () => {},
      syncHeadDirectory = syncDirectory,
    } = {},
  ) {
    if (!isAbsolute(root) || !UUID.test(instanceId))
      fail('WORKSPACE_CONFIG_INVALID', '工作区存储配置无效。', 500);
    this.root = root;
    this.commits = join(root, 'commits');
    this.lock = join(root, 'writer.lock');
    this.instanceId = instanceId;
    this.now = now;
    this.beforeCommit = beforeCommit;
    this.syncHeadDirectory = syncHeadDirectory;
    this.queue = Promise.resolve();
    this.commandIndex = new Map();
    this.syncTransactions = new Map();
    this.head = null;
    this.workspaceId = '';
    this.owned = false;
    this.closed = false;
  }
  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOnce();
    try {
      await this.initializing;
      return this;
    } catch (error) {
      await this.releaseLock();
      throw error;
    }
  }
  async initializeOnce() {
    await privateDirectory(this.root);
    await privateDirectory(this.commits);
    try {
      await mkdir(this.lock, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(this.lock);
      if (!info.isDirectory() || info.isSymbolicLink())
        fail('WORKSPACE_LOCK_INVALID', '工作区写入锁无效。', 500);
      let owner;
      try {
        owner = await readJson(join(this.lock, 'owner.json'));
      } catch {
        fail('WORKSPACE_WRITER_BUSY', '工作区写入锁尚未完成或需要人工核验。');
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !UUID.test(owner.instanceId))
        fail('WORKSPACE_LOCK_INVALID', '工作区写入锁无效。', 500);
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') alive = false;
      }
      if (alive) fail('WORKSPACE_WRITER_BUSY', '已有本机服务持有此工作区。');
      const current = await lstat(this.lock);
      if (info.dev !== current.dev || info.ino !== current.ino)
        fail('WORKSPACE_WRITER_BUSY', '工作区写入锁已变化。');
      await unlink(join(this.lock, 'owner.json'));
      await rmdir(this.lock);
      await mkdir(this.lock, { mode: 0o700 });
    }
    await writeExclusive(join(this.lock, 'owner.json'), {
      pid: process.pid,
      instanceId: this.instanceId,
    });
    this.owned = true;
    const identityPath = join(this.root, 'identity.json');
    if (!(await regular(identityPath, { missing: true }))) {
      await writeExclusive(identityPath, { storageVersion: 1, workspaceId: randomUUID() });
      await syncDirectory(this.root);
    }
    const identity = object(await readJson(identityPath), ['storageVersion', 'workspaceId']);
    if (identity.storageVersion !== 1 || !UUID.test(identity.workspaceId))
      fail('WORKSPACE_VERSION_UNSUPPORTED', '工作区存储版本不受支持。');
    this.workspaceId = identity.workspaceId;
    const headPath = join(this.root, 'HEAD.json');
    if (!(await regular(headPath, { missing: true }))) return;
    const head = object(await readJson(headPath), [
      'storageVersion',
      'workspaceId',
      'revision',
      'hash',
      'file',
    ]);
    if (
      head.storageVersion !== 1 ||
      head.workspaceId !== this.workspaceId ||
      !COMMIT_FILE.test(head.file) ||
      !HASH.test(head.hash)
    )
      fail('WORKSPACE_CORRUPT', '工作区提交指针无效。', 500);
    let file = head.file,
      expectedRevision = head.revision,
      expectedHash = head.hash;
    while (file) {
      const commit = await this.readCommit(file);
      if (commit.revision !== expectedRevision || commit.hash !== expectedHash)
        fail('WORKSPACE_CORRUPT', '工作区提交链不连续。', 500);
      if (!this.head) this.head = commit;
      if (this.commandIndex.has(commit.command.commandId))
        fail('WORKSPACE_CORRUPT', '工作区命令重复提交。', 500);
      this.commandIndex.set(commit.command.commandId, {
        digest: commit.command.digest,
        file,
        revision: commit.revision,
        hash: commit.hash,
        result: copy(commit.command.result ?? null),
      });
      expectedRevision--;
      file = commit.previous?.file || '';
      expectedHash = commit.previous?.hash || '';
      if ((!file && expectedRevision !== 0) || (file && !COMMIT_FILE.test(file)))
        fail('WORKSPACE_CORRUPT', '工作区历史提交缺失。', 500);
    }
  }
  async readCommit(file) {
    const commit = object(await readJson(join(this.commits, file)), [
      'storageVersion',
      'workspaceId',
      'revision',
      'previous',
      'createdAt',
      'command',
      'workspace',
      'hash',
    ]);
    const { hash, ...body } = commit;
    if (
      body.storageVersion !== 1 ||
      body.workspaceId !== this.workspaceId ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 1 ||
      !HASH.test(hash) ||
      workspaceDigest(body) !== hash ||
      `${String(body.revision).padStart(12, '0')}-${hash}.json` !== file
    )
      fail('WORKSPACE_CORRUPT', '工作区提交内容校验失败。', 500);
    object(body.command, ['commandId', 'digest', 'type', 'result']);
    if (!COMMAND_ID.test(body.command.commandId) || !HASH.test(body.command.digest))
      fail('WORKSPACE_CORRUPT', '工作区命令记录无效。', 500);
    migrateWorkspace(body.workspace);
    return commit;
  }
  envelope(commit = this.head) {
    return {
      protocolVersion: 1,
      storageVersion: 1,
      workspaceId: this.workspaceId,
      revision: commit?.revision || 0,
      hash: commit?.hash || '',
      workspace: commit ? migrateWorkspace(commit.workspace) : null,
    };
  }
  async read() {
    await this.initialize();
    return copy(this.envelope());
  }
  syncTransaction(id, states) {
    if (typeof id !== 'string' || !SYNC_TRANSACTION_ID.test(id))
      fail('SYNC_TRANSACTION_INVALID', '同步事务标识无效。', 400);
    const transaction = this.syncTransactions.get(id);
    if (!transaction)
      fail('SYNC_TRANSACTION_EXPIRED', '同步事务已失效，请重新读取云端后再同步。', 409);
    if (!states.includes(transaction.state))
      fail(
        transaction.state === 'consumed'
          ? 'SYNC_TRANSACTION_REPLAYED'
          : 'SYNC_TRANSACTION_STATE_INVALID',
        transaction.state === 'consumed'
          ? '同步事务已经确认，不能用新命令重复提交。'
          : '同步事务状态已变化，请重新读取云端后再同步。',
        409,
      );
    return transaction;
  }
  trimSyncTransactions() {
    while (this.syncTransactions.size >= MAX_SYNC_TRANSACTIONS) {
      const candidate = [...this.syncTransactions.entries()].find(
        ([, transaction]) => transaction.state !== 'uploading',
      );
      if (!candidate) fail('SYNC_TRANSACTION_BUSY', '已有同步上传正在执行，请稍后重试。', 409);
      this.syncTransactions.delete(candidate[0]);
    }
  }
  async prepareSyncTransaction(remote, target) {
    await this.initialize();
    if (this.closed || !this.owned) fail('WORKSPACE_WRITER_CLOSED', '工作区服务正在停止。', 503);
    const current = this.envelope();
    if (!current.workspace) fail('WORKSPACE_MIGRATION_REQUIRED', '请先迁移原浏览器工作区。');
    if (current.workspace.pending) fail('SYNC_CONFLICT', '请先解决同步冲突，再重新读取云端。');
    const trustedTarget = object(target, ['owner', 'repo', 'path']);
    validateConfig(trustedTarget);
    if (workspaceDigest(trustedTarget) !== workspaceDigest(current.workspace.config))
      fail('SYNC_TARGET_CHANGED', '本机 SSH 目标与正式工作区配置不一致。', 409);
    const input = object(remote, ['data', 'sha', 'missing']);
    if (
      typeof input.missing !== 'boolean' ||
      !(
        input.sha === null ||
        (typeof input.sha === 'string' && /^[a-f0-9]{40,64}$/.test(input.sha))
      ) ||
      (input.missing ? input.sha !== null : input.sha === null)
    )
      fail('SYNC_REMOTE_INVALID', '云端读取结果无效。', 400);
    const remoteData = validateData(input.data);
    if (input.missing && !equal(remoteData, emptyData()))
      fail('SYNC_REMOTE_INVALID', '云端缺失状态不能包含数据。', 400);
    if (input.missing && !equal(current.workspace.base, emptyData()))
      fail('SYNC_REMOTE_MISSING', '原有云端文件消失了，已停止同步以保留正式记录。', 409);
    const combined = mergeSyncData(
        current.workspace.base,
        current.workspace.data,
        remoteData,
        this.workspaceId,
      ),
      uploadRequired = input.missing || !equal(combined.data, remoteData),
      id = `sync-${randomUUID()}`;
    this.trimSyncTransactions();
    const transaction = {
      id,
      state: combined.conflicts.length ? 'conflict' : uploadRequired ? 'prepared' : 'confirmable',
      capturedRevision: current.revision,
      captured: copy(current.workspace),
      configDigest: workspaceDigest(current.workspace.config),
      remote: copy(remoteData),
      remoteSha: input.sha,
      uploaded: copy(combined.data),
      uploadDigest: workspaceDigest(combined.data),
      uploadRequired,
      conflictCount: combined.conflicts.length,
    };
    this.syncTransactions.set(id, transaction);
    return {
      syncTransactionId: id,
      workspaceRevision: current.revision,
      uploadDigest: transaction.uploadDigest,
      uploadRequired,
      conflictCount: transaction.conflictCount,
    };
  }
  async reserveSyncUpload(id, data, sha) {
    await this.initialize();
    if (this.closed || !this.owned) fail('WORKSPACE_WRITER_CLOSED', '工作区服务正在停止。', 503);
    const transaction = this.syncTransaction(id, ['prepared']);
    const current = this.envelope();
    if (
      !current.workspace ||
      current.workspace.pending ||
      transaction.configDigest !== workspaceDigest(current.workspace.config) ||
      !equal(transaction.captured.base, current.workspace.base)
    ) {
      transaction.state = 'invalid';
      fail('SYNC_CONTEXT_CHANGED', '同步目标、基线或冲突状态已变化，请重新同步。', 409);
    }
    const candidate = validateData(data);
    if (sha !== transaction.remoteSha || workspaceDigest(candidate) !== transaction.uploadDigest)
      fail('SYNC_PLAN_MISMATCH', '上传内容或云端版本与服务签发的同步计划不一致，请重新同步。', 409);
    transaction.state = 'uploading';
    return copy(transaction.uploaded);
  }
  async completeSyncUpload(id) {
    await this.initialize();
    if (this.closed || !this.owned) fail('WORKSPACE_WRITER_CLOSED', '工作区服务正在停止。', 503);
    const transaction = this.syncTransaction(id, ['uploading']);
    transaction.state = 'uploaded';
    return { syncTransactionId: id, uploadDigest: transaction.uploadDigest };
  }
  async failSyncUpload(id) {
    await this.initialize();
    const transaction = this.syncTransactions.get(id);
    if (transaction?.state === 'uploading') transaction.state = 'invalid';
  }
  async execute(input, { result = null } = {}) {
    const task = this.queue.then(async () => {
      await this.initialize();
      if (this.closed || !this.owned) fail('WORKSPACE_WRITER_CLOSED', '工作区服务正在停止。', 503);
      const command = object(input, ['commandId', 'expectedRevision', 'type', 'payload']);
      if (
        typeof command.commandId !== 'string' ||
        !COMMAND_ID.test(command.commandId) ||
        !Number.isSafeInteger(command.expectedRevision) ||
        command.expectedRevision < 0 ||
        !COMMAND_TYPES.has(command.type)
      )
        fail('WORKSPACE_COMMAND_INVALID', '工作区命令参数无效。', 400);
      const digest = workspaceDigest(command),
        previousCommand = this.commandIndex.get(command.commandId);
      if (previousCommand) {
        if (previousCommand.digest !== digest)
          fail('COMMAND_ID_CONFLICT', '相同命令 ID 已用于不同内容。');
        const committed = await this.indexedCommit(command.commandId, previousCommand);
        return {
          ...copy(this.envelope(committed)),
          commandId: command.commandId,
          commandResult: copy(committed.command.result ?? null),
          replayed: true,
        };
      }
      const current = this.envelope();
      const headPath = join(this.root, 'HEAD.json');
      const diskHead = (await regular(headPath, { missing: true }))
        ? await readJson(headPath)
        : null;
      if (
        (this.head &&
          (diskHead?.hash !== this.head.hash ||
            diskHead?.revision !== this.head.revision ||
            diskHead?.workspaceId !== this.workspaceId)) ||
        (!this.head && diskHead)
      )
        fail('WORKSPACE_HEAD_CHANGED', '工作区提交指针在服务外发生变化，已停止写入。');
      if (command.expectedRevision !== current.revision)
        fail('WORKSPACE_REVISION_CONFLICT', '正式工作区已变化，请读取最新版本后重新核对。');
      let workspace,
        consumedSyncTransaction = null;
      const payload = command.payload;
      if (command.type === 'import_workspace' || command.type === 'commit_workspace') {
        object(payload, ['workspace', 'reason']);
        if (typeof payload.reason !== 'string' || payload.reason.length > 500)
          fail('WORKSPACE_COMMAND_INVALID', '工作区提交原因无效。', 400);
        if (
          !payload.workspace ||
          typeof payload.workspace !== 'object' ||
          Array.isArray(payload.workspace)
        )
          fail('WORKSPACE_COMMAND_INVALID', '提交必须包含明确的完整工作区。', 400);
        if (command.type === 'import_workspace' && current.workspace)
          fail('WORKSPACE_ALREADY_INITIALIZED', '本机正式工作区已经迁移，不能再次初始化。');
        if (command.type === 'commit_workspace' && !current.workspace)
          fail('WORKSPACE_MIGRATION_REQUIRED', '请先迁移原浏览器工作区。');
        workspace = migrateWorkspace(payload.workspace);
        if (command.type === 'import_workspace') {
          const migrationPath = join(this.root, `migration-source-${digest}.json`);
          if (!(await regular(migrationPath, { missing: true })))
            await writeExclusive(migrationPath, {
              sourceDigest: digest,
              importedAt: this.now(),
              workspace: payload.workspace,
            });
          const rebind = (binding) => {
            if (binding?.kind === 'account' && binding.platform === 'boss')
              binding.workspaceSourceId = this.workspaceId;
          };
          // workspace.data is the local side and must use the new stable
          // service identity immediately. base and pending.remote are evidence
          // of what the remote last contained; rebinding them would make the
          // next three-way merge treat the old remote identity as a new change
          // and silently undo the migration. pending.data is the local merged
          // candidate, so it follows the local identity.
          for (const data of [workspace.data, workspace.pending?.data].filter(Boolean)) {
            for (const binding of data.sourceBindings || []) rebind(binding);
          }
          for (const conflict of workspace.pending?.conflicts || []) {
            // Conflict choices are live candidates. Either local or remote may
            // become workspace.data, so both must carry the stable service
            // ownership. Historical remote/base evidence remains unchanged in
            // workspace.base, pending.remote, conflict.base and migration-source.
            if (conflict.group === 'sourceBindings') {
              rebind(conflict.local);
              rebind(conflict.remote);
            }
          }
          workspace = migrateWorkspace(workspace);
        }
        if (
          current.workspace &&
          (workspace.generation < current.workspace.generation ||
            workspace.generation > current.workspace.generation + 1)
        )
          fail('WORKSPACE_GENERATION_INVALID', '工作区业务版本不连续。');
      } else {
        if (!current.workspace) fail('WORKSPACE_MIGRATION_REQUIRED', '请先迁移原浏览器工作区。');
        if (command.type === 'restore_workspace') {
          object(payload, ['backup', 'mode']);
          workspace = restoreWorkspace(current.workspace, payload.backup, payload.mode);
        } else if (command.type === 'acknowledge_sync') {
          object(payload, ['syncTransactionId']);
          const transaction = this.syncTransaction(payload.syncTransactionId, [
            'confirmable',
            'uploaded',
          ]);
          if (transaction.configDigest !== workspaceDigest(current.workspace.config))
            fail('SYNC_TARGET_CHANGED', '同步目标已变化。');
          if (
            current.workspace.pending ||
            !equal(transaction.captured.base, current.workspace.base)
          )
            fail('SYNC_CONTEXT_CHANGED', '同步基线或冲突状态已变化，请重新读取云端后再同步。', 409);
          workspace = migrateWorkspace(
            acknowledge(current.workspace, transaction.captured, transaction.uploaded),
          );
          consumedSyncTransaction = transaction;
        } else if (command.type === 'edit_data') {
          object(payload, ['changes', 'releaseFields', 'reason']);
          if (
            !Array.isArray(payload.changes) ||
            payload.changes.length > 100_000 ||
            !Array.isArray(payload.releaseFields) ||
            payload.releaseFields.length > 10_000 ||
            typeof payload.reason !== 'string' ||
            payload.reason.length > 500
          )
            fail('WORKSPACE_COMMAND_INVALID', '业务编辑参数无效。', 400);
          workspace = copy(current.workspace);
          const seen = new Set(),
            touchedOpportunityIds = new Set(),
            pendingConflictKeys = new Set(
              (current.workspace.pending?.conflicts || []).map((conflict) => conflict.key),
            );
          for (const value of payload.changes) {
            const change = object(value, ['group', 'record']);
            if (
              !BUSINESS_GROUPS.has(change.group) ||
              !change.record ||
              Array.isArray(change.record) ||
              typeof change.record !== 'object' ||
              typeof change.record.id !== 'string' ||
              !change.record.id
            )
              fail('WORKSPACE_COMMAND_INVALID', '业务编辑记录无效。', 400);
            const key = `${change.group}:${change.record.id}`;
            if (seen.has(key)) fail('WORKSPACE_COMMAND_INVALID', '业务编辑包含重复记录。', 400);
            if (pendingConflictKeys.has(key))
              fail('SYNC_CONFLICT', '本次编辑涉及待处理冲突记录，请先核对该项。', 409);
            seen.add(key);
            const rows = workspace.data[change.group];
            const index = rows.findIndex((row) => row.id === change.record.id);
            const previous = index >= 0 ? rows[index] : null;
            if (change.group === 'opportunities') touchedOpportunityIds.add(change.record.id);
            else if (change.group === 'activities' || change.group === 'tasks') {
              if (previous?.opportunityId) touchedOpportunityIds.add(previous.opportunityId);
              if (change.record.opportunityId)
                touchedOpportunityIds.add(change.record.opportunityId);
            }
            if (index >= 0) rows[index] = copy(change.record);
            else rows.push(copy(change.record));
          }
          workspace.data = releaseManualFieldOwnership(current.workspace.data, workspace.data);
          for (const value of payload.releaseFields) {
            const release = object(value, ['opportunityId', 'fields']);
            if (
              typeof release.opportunityId !== 'string' ||
              !release.opportunityId ||
              !Array.isArray(release.fields) ||
              !release.fields.length ||
              new Set(release.fields).size !== release.fields.length ||
              release.fields.some((field) => !SOURCE_AUTO_FIELDS.includes(field))
            )
              fail('WORKSPACE_COMMAND_INVALID', '人工字段释放参数无效。', 400);
            touchedOpportunityIds.add(release.opportunityId);
            markManualFields(workspace.data, release.opportunityId, release.fields);
          }
          workspace.data = validateData(workspace.data);
          if (equal(workspace.data, current.workspace.data))
            fail('WORKSPACE_COMMAND_NO_EFFECT', '业务编辑没有产生变化。', 409);
          workspace.generation++;
          if (current.workspace.pending) {
            const scope = pendingConflictScope(current.workspace);
            if ([...touchedOpportunityIds].some((id) => scope.opportunityIds.has(id)))
              fail('SYNC_CONFLICT', '本次编辑涉及待处理冲突，请先核对该岗位。', 409);
            const rebased = mergeData(
              current.workspace.data,
              workspace.data,
              current.workspace.pending.data,
            );
            if (rebased.conflicts.length)
              fail('SYNC_CONFLICT', '本次编辑与待处理同步内容产生冲突，请先核对。', 409);
            workspace.pending = {
              ...workspace.pending,
              data: validateData(rebased.data, { allowOrphans: true }),
              generation: workspace.generation,
            };
          }
        } else if (command.type === 'correct_boss_resume_request') {
          fail('BOSS_RESUME_CORRECTION_SUPERSEDED', '旧简历纠正命令已停用。', 409);
        } else if (command.type === 'reject_boss_resume_observation') {
          object(payload, ['opportunityId', 'eventId']);
          if (
            typeof payload.opportunityId !== 'string' ||
            !payload.opportunityId ||
            typeof payload.eventId !== 'string' ||
            !/^boss-event-[a-f0-9]{64}$/.test(payload.eventId)
          )
            fail('WORKSPACE_COMMAND_INVALID', '简历观察否决参数无效。', 400);
          if (current.workspace.pending)
            fail('SYNC_CONFLICT', '请先核对待处理同步冲突，再否决错误观察。', 409);
          workspace = copy(current.workspace);
          try {
            workspace.data = rejectMisattributedResumeObservation(workspace.data, {
              ...payload,
              stamp: this.now(),
            });
          } catch (error) {
            if (error.code === 'BOSS_RESUME_REJECTION_UNSAFE')
              fail('BOSS_RESUME_REJECTION_UNSAFE', error.message, 409);
            throw error;
          }
          workspace.generation++;
        } else if (command.type === 'set_sync_config') {
          object(payload, ['config']);
          const config = object(payload.config, ['owner', 'repo', 'path']);
          validateConfig(config);
          if (current.workspace.pending) fail('SYNC_CONFLICT', '请先解决同步冲突，再切换仓库。');
          workspace = copy(current.workspace);
          if (!equal(config, workspace.config)) {
            workspace.config = copy(config);
            workspace.base = emptyData();
            workspace.lastSync = '';
            workspace.pending = null;
          }
        } else if (command.type === 'stage_sync_conflict') {
          object(payload, ['syncTransactionId', 'generation']);
          if (
            !Number.isSafeInteger(payload.generation) ||
            payload.generation !== current.workspace.generation ||
            current.workspace.pending
          )
            fail('WORKSPACE_REVISION_CONFLICT', '本机记录已变化，请重新同步。');
          const transaction = this.syncTransaction(payload.syncTransactionId, ['conflict']);
          if (transaction.configDigest !== workspaceDigest(current.workspace.config))
            fail('SYNC_TARGET_CHANGED', '同步目标已变化。');
          if (!equal(transaction.captured.base, current.workspace.base))
            fail('SYNC_CONTEXT_CHANGED', '同步基线已变化，请重新读取云端后再同步。', 409);
          const remote = transaction.remote;
          const merged = mergeSyncData(
            current.workspace.base,
            current.workspace.data,
            remote,
            this.workspaceId,
          );
          if (!merged.conflicts.length)
            fail('WORKSPACE_COMMAND_NO_EFFECT', '当前数据没有需要暂存的同步冲突。', 409);
          workspace = copy(current.workspace);
          workspace.pending = {
            data: merged.data,
            remote,
            conflicts: merged.conflicts,
            generation: workspace.generation,
          };
          consumedSyncTransaction = transaction;
        } else if (command.type === 'resolve_sync_conflict') {
          object(payload, ['choices', 'generation']);
          if (
            !current.workspace.pending ||
            !Number.isSafeInteger(payload.generation) ||
            payload.generation !== current.workspace.generation
          )
            fail('WORKSPACE_REVISION_CONFLICT', '同步冲突已变化，请重新核对。');
          const choices = object(
            payload.choices,
            current.workspace.pending.conflicts.map((conflict) => conflict.key),
          );
          if (
            Object.keys(choices).length !== current.workspace.pending.conflicts.length ||
            Object.values(choices).some((choice) => !['local', 'remote'].includes(choice))
          )
            fail('WORKSPACE_COMMAND_INVALID', '请为每项冲突选择版本。', 400);
          workspace = copy(current.workspace);
          const protectedAccountBindings = new Set(
            workspace.data.sourceBindings
              .filter(
                (binding) =>
                  binding.kind === 'account' &&
                  binding.platform === 'boss' &&
                  !binding.deletedAt &&
                  binding.workspaceSourceId === this.workspaceId,
              )
              .map((binding) => binding.id),
          );
          workspace.data = resolveConflicts(
            workspace.pending.data,
            workspace.pending.conflicts,
            choices,
          );
          for (const binding of workspace.data.sourceBindings)
            if (
              protectedAccountBindings.has(binding.id) &&
              binding.kind === 'account' &&
              binding.platform === 'boss' &&
              !binding.deletedAt
            )
              binding.workspaceSourceId = this.workspaceId;
          workspace.data = validateData(workspace.data);
          if (workspace.pending.remote) workspace.base = workspace.pending.remote;
          workspace.pending = null;
          workspace.generation++;
        } else if (command.type === 'bind_boss_account') {
          object(payload, ['accountNamespace', 'restore']);
          if (typeof payload.restore !== 'boolean' || current.workspace.pending)
            fail('WORKSPACE_COMMAND_INVALID', 'BOSS 来源绑定参数无效。', 400);
          workspace = copy(current.workspace);
          workspace.data = bindBossAccount(
            workspace.data,
            payload.accountNamespace,
            this.workspaceId,
            this.now(),
            { allowRestore: payload.restore, allowRebind: payload.restore },
          );
          workspace.generation++;
        } else {
          fail('WORKSPACE_COMMAND_INVALID', '工作区命令类型无效。', 400);
        }
      }
      if (
        current.workspace &&
        [...this.syncTransactions.values()].some(
          (transaction) => transaction.state === 'uploading',
        ) &&
        (!equal(workspace.config, current.workspace.config) ||
          !equal(workspace.base, current.workspace.base) ||
          !equal(workspace.pending, current.workspace.pending))
      )
        fail(
          'SYNC_TRANSACTION_BUSY',
          '同步上传期间不能改变同步目标、基线或冲突状态；普通业务编辑仍可继续。',
          409,
        );
      const body = {
        storageVersion: 1,
        workspaceId: this.workspaceId,
        revision: current.revision + 1,
        previous: this.head ? { file: this.filename(this.head), hash: this.head.hash } : null,
        createdAt: this.now(),
        command: { commandId: command.commandId, digest, type: command.type, result },
        workspace,
      };
      const commit = { ...body, hash: workspaceDigest(body) },
        file = this.filename(commit);
      await this.beforeCommit('before_commit_file', commit);
      try {
        await writeExclusive(join(this.commits, file), commit);
      } catch (error) {
        if (
          error.code !== 'EEXIST' ||
          workspaceDigest(await readJson(join(this.commits, file))) !== workspaceDigest(commit)
        )
          throw error;
      }
      await syncDirectory(this.commits);
      await this.beforeCommit('before_head', commit);
      try {
        await replaceJson(
          this.root,
          'HEAD.json',
          {
            storageVersion: 1,
            workspaceId: this.workspaceId,
            revision: commit.revision,
            hash: commit.hash,
            file,
          },
          this.syncHeadDirectory,
        );
      } catch (error) {
        // A directory fsync can report failure after rename made the new HEAD
        // visible. Visibility alone is not a durable commit point: retry the
        // exact directory sync a bounded number of times. If durability still
        // cannot be established, quarantine this writer and do not let a queue
        // receipt or browser success escape.
        const persisted = await readJson(join(this.root, 'HEAD.json')).catch(() => null);
        if (persisted?.hash === commit.hash && persisted.file === file) {
          let durable = false;
          for (let attempt = 0; attempt < 2 && !durable; attempt++)
            try {
              await this.syncHeadDirectory(this.root);
              durable = true;
            } catch {
              // Retry only the local durability barrier, never the business
              // command, rename, platform request or remote upload.
            }
          if (!durable) {
            this.closed = true;
            fail(
              'WORKSPACE_DURABILITY_UNCERTAIN',
              '正式提交指针已可见但无法确认持久化；已隔离写者，请重启服务后读取核对。',
              503,
            );
          }
        } else throw error;
      }
      this.head = commit;
      this.commandIndex.set(command.commandId, {
        digest,
        file: this.filename(commit),
        revision: commit.revision,
        hash: commit.hash,
        result: copy(commit.command.result ?? null),
      });
      if (consumedSyncTransaction) consumedSyncTransaction.state = 'consumed';
      await this.beforeCommit('after_head', commit);
      return {
        ...copy(this.envelope()),
        commandId: command.commandId,
        commandResult: copy(result),
        replayed: false,
      };
    });
    this.queue = task.catch(() => {});
    return task;
  }
  filename(commit) {
    return `${String(commit.revision).padStart(12, '0')}-${commit.hash}.json`;
  }
  async indexedCommit(commandId, stored) {
    const commit = await this.readCommit(stored.file);
    if (
      commit.revision !== stored.revision ||
      commit.hash !== stored.hash ||
      commit.command.commandId !== commandId ||
      commit.command.digest !== stored.digest
    )
      fail('WORKSPACE_CORRUPT', '工作区幂等提交校验失败。', 500);
    return commit;
  }
  async commandResult(commandId) {
    await this.initialize();
    const stored = this.commandIndex.get(commandId);
    return stored
      ? { revision: stored.revision, hash: stored.hash, result: copy(stored.result) }
      : null;
  }
  async recordImportDiagnostic(summary) {
    await this.initialize();
    if (!summary.isolated?.length) return;
    const errors = summary.isolated.map((row) => ({
      batchId: /^boss-batch-[a-f0-9]{64}$/.test(row.batchId) ? row.batchId : '',
      accountNamespace: /^boss-geek:[a-f0-9]{64}$/.test(row.accountNamespace)
        ? row.accountNamespace
        : '',
      code: /^[A-Z][A-Z0-9_]{0,100}$/.test(row.code) ? row.code : 'WORKSPACE_IMPORT_FAILED',
    }));
    const directory = join(this.root, 'incidents');
    await privateDirectory(directory);
    const file = join(directory, `inbox-${workspaceDigest(errors)}.json`);
    try {
      await writeExclusive(file, {
        format: 'job-tracker-workspace-inbox-incident',
        version: 1,
        workspaceId: this.workspaceId,
        observedAt: summary.lastRunAt,
        revision: this.head?.revision || 0,
        errors,
      });
      await syncDirectory(directory);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  async releaseLock() {
    if (!this.owned) return;
    const path = join(this.lock, 'owner.json');
    const owner = await readJson(path).catch(() => null);
    if (owner?.instanceId === this.instanceId && owner.pid === process.pid) {
      await unlink(path);
      await rmdir(this.lock);
    }
    this.owned = false;
  }
  async close() {
    this.closed = true;
    await this.queue;
    await this.releaseLock();
  }
}
