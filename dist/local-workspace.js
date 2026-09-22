import { createBackup, migrateWorkspace } from './workspace.js';
import { SOURCE_AUTO_FIELDS, equal, validateData } from './model.js';
import { sha256Hex } from './source-identity.js';

const PROTOCOL_VERSION = 1;
const BUSINESS_GROUPS = ['opportunities', 'activities', 'tasks', 'imports'];

function failure(message, code, status = 0) {
  return Object.assign(new Error(message), { code, status });
}

export function createLocalWorkspaceClient({
  fetcher = fetch,
  hostname = location.hostname,
  readCache,
  writeCache,
  authorityStorage = localStorage,
  makeId = () => crypto.randomUUID(),
  onCacheFailure = () => {},
  onOffline = () => {},
} = {}) {
  const local = ['localhost', '127.0.0.1'].includes(hostname);
  const authorityKey = 'job-tracker-local-authority-v1';
  let session = '',
    mode = null,
    chain = Promise.resolve(),
    offline = false;
  const preparedImports = new WeakMap();

  function authority() {
    const raw = authorityStorage?.getItem(authorityKey);
    if (!raw) return null;
    // The pre-release marker proves local-mode use, but carries no workspace
    // identity. It is upgraded only after the cache equals the service or the
    // user completes the explicit backup/switch flow.
    if (raw === '1') return { legacy: true };
    try {
      const value = JSON.parse(raw);
      return typeof value?.workspaceId === 'string' ? value : { invalid: true };
    } catch {
      return { invalid: true };
    }
  }

  function rememberAuthority(workspaceId) {
    authorityStorage?.setItem(authorityKey, JSON.stringify({ workspaceId }));
  }

  function authorityMatches(workspaceId) {
    const value = authority();
    return !!value && value.workspaceId === workspaceId;
  }

  async function discover() {
    if (!local) {
      mode = 'static';
      return false;
    }
    const response = await fetcher('./__local/session', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) {
      if (authorityStorage?.getItem(authorityKey))
        throw failure(
          '本机工作区服务不可用，正式数据仍保存在本机服务。',
          'LOCAL_WORKSPACE_REQUIRED',
        );
      mode = 'static';
      return false;
    }
    if (!response.ok)
      throw failure('无法连接本机工作区服务。', 'LOCAL_WORKSPACE_UNAVAILABLE', response.status);
    const value = await response.json();
    if (!(value.localWorkspaceEnabled || value.localWorkspace)) {
      if (authorityStorage?.getItem(authorityKey))
        throw failure('本机服务版本不支持当前工作区，请更新服务。', 'LOCAL_WORKSPACE_REQUIRED');
      mode = 'static';
      return false;
    }
    if (!/^[a-f0-9]{64}$/.test(value.session || ''))
      throw failure('本机工作区会话无效。', 'LOCAL_SESSION_INVALID');
    session = value.session;
    mode = 'local';
    return true;
  }

  async function request(path, { method = 'GET', body, refresh = true, replay = true } = {}) {
    if (!session) await discover();
    let response;
    try {
      response = await fetcher(path, {
        method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-Job-Tracker-Session': session,
          'X-Job-Tracker-Protocol': String(PROTOCOL_VERSION),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      // A lost reply is retried only with the exact same durable command ID/body.
      if (body?.commandId && replay) return request(path, { method, body, refresh, replay: false });
      throw failure(
        '无法确认本机服务操作结果。恢复连接后会先读取正式记录，不会改存浏览器。',
        'LOCAL_WORKSPACE_UNAVAILABLE',
      );
    }
    if (response.status === 403 && refresh) {
      session = '';
      await discover();
      return request(path, { method, body, refresh: false, replay });
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw failure('本机工作区返回无效内容。', 'LOCAL_WORKSPACE_INVALID');
    }
    if (!response.ok)
      throw failure(
        value.message || '本机工作区操作失败。',
        value.code || 'LOCAL_WORKSPACE_FAILED',
        response.status,
      );
    if (
      value.protocolVersion !== 1 ||
      value.storageVersion !== 1 ||
      typeof value.workspaceId !== 'string' ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      typeof value.hash !== 'string' ||
      !Object.hasOwn(value, 'workspace') ||
      (value.workspace !== null && !/^[a-f0-9]{64}$/.test(value.hash))
    )
      throw failure('本机工作区协议版本或结构不兼容，请更新服务。', 'LOCAL_WORKSPACE_PROTOCOL');
    return {
      ...value,
      workspace: value.workspace === null ? null : migrateWorkspace(value.workspace),
    };
  }

  async function cache(envelope, reason = '') {
    if (!envelope.workspace) return;
    try {
      await writeCache(envelope.workspace, { reason, emit: false });
    } catch {
      onCacheFailure();
    }
  }

  async function load() {
    const envelope = await request('./__local/workspace');
    if (envelope.workspace === null)
      throw failure(
        '请先将此浏览器的记录迁移到本机工作区；迁移会保留原浏览器记录。',
        'LOCAL_WORKSPACE_IMPORT_REQUIRED',
      );
    if (!authorityMatches(envelope.workspaceId)) {
      const raw = await readCache();
      let same = false;
      try {
        same =
          raw !== null && raw !== undefined && equal(migrateWorkspace(raw), envelope.workspace);
      } catch {
        // An unreadable or future local cache is evidence that must be exported,
        // never a reason to replace it with the service copy.
      }
      if (!same && raw !== null && raw !== undefined)
        throw failure(
          '此浏览器仍有未迁移的本地记录。请先导出完整备份并核对，再明确启用本机正式工作区。',
          'LOCAL_WORKSPACE_BROWSER_DATA_UNMIGRATED',
        );
      const known = authority();
      if (known?.invalid || (known?.workspaceId && known.workspaceId !== envelope.workspaceId))
        throw failure(
          '此浏览器曾绑定另一份本机工作区。请先导出完整备份并核对，再明确切换。',
          'LOCAL_WORKSPACE_AUTHORITY_MISMATCH',
        );
    }
    rememberAuthority(envelope.workspaceId);
    offline = false;
    await cache(envelope);
    return envelope;
  }

  function migrationSummary(backup) {
    const { workspace, drafts } = backup,
      groups = [
        'opportunities',
        'activities',
        'tasks',
        'imports',
        'sourceBindings',
        'sourceEvents',
        'sourceFacts',
        'sourceApplications',
      ],
      formalRecords = groups.reduce((total, group) => total + workspace.data[group].length, 0),
      baselineRecords = groups.reduce((total, group) => total + workspace.base[group].length, 0),
      conflicts = workspace.pending?.conflicts?.length || 0;
    return {
      opportunities: workspace.data.opportunities.length,
      formalRecords,
      baselineRecords,
      conflicts,
      drafts: drafts.length,
    };
  }

  async function prepareImport(drafts = []) {
    if (!(await active())) throw failure('此网页没有本机工作区服务。', 'LOCAL_WORKSPACE_REQUIRED');
    const service = await request('./__local/workspace');
    const raw = await readCache();
    if (raw === null || raw === undefined)
      throw failure(
        '当前浏览器没有可迁移的原工作区，请回到保存正式记录的浏览器导出并迁移。',
        'LOCAL_WORKSPACE_SOURCE_MISSING',
      );
    const backup = createBackup(migrateWorkspace(raw), drafts),
      summary = migrationSummary(backup);
    if (
      service.workspace === null &&
      summary.formalRecords + summary.baselineRecords + summary.conflicts + summary.drafts === 0
    )
      throw failure(
        '当前浏览器工作区和草稿均为空，已拒绝把它作为旧工作区迁移；请核对浏览器来源。',
        'LOCAL_WORKSPACE_SOURCE_EMPTY',
      );
    const text = `${JSON.stringify(backup, null, 2)}\n`,
      prepared = {
        backup: structuredClone(backup),
        text,
        sha256: sha256Hex(text),
        summary: structuredClone(summary),
      };
    preparedImports.set(prepared, {
      source: structuredClone(raw),
      drafts: structuredClone(backup.drafts),
      serviceWorkspaceId: service.workspace === null ? null : service.workspaceId,
    });
    return prepared;
  }

  async function importCurrent(prepared, currentDrafts = []) {
    if (!(await active())) throw failure('此网页没有本机工作区服务。', 'LOCAL_WORKSPACE_REQUIRED');
    let envelope = await request('./__local/workspace');
    const needsPreflight = envelope.workspace === null || !authorityMatches(envelope.workspaceId),
      preflight = preparedImports.get(prepared);
    let raw;
    if (needsPreflight && !preflight)
      throw failure(
        '请先导出并核对本浏览器的完整迁移备份。',
        'LOCAL_WORKSPACE_MIGRATION_PREFLIGHT_REQUIRED',
      );
    if (needsPreflight) {
      raw = await readCache();
      if (raw === null || raw === undefined || !equal(raw, preflight.source))
        throw failure(
          '浏览器正式记录在备份后发生变化，请重新导出完整迁移备份。',
          'LOCAL_WORKSPACE_MIGRATION_SOURCE_CHANGED',
        );
      const freshBackup = createBackup(migrateWorkspace(raw), currentDrafts);
      if (!equal(freshBackup.drafts, preflight.drafts))
        throw failure(
          '浏览器草稿在备份后发生变化，请重新导出完整迁移备份。',
          'LOCAL_WORKSPACE_MIGRATION_DRAFTS_CHANGED',
        );
      if (
        preflight.serviceWorkspaceId !== (envelope.workspace === null ? null : envelope.workspaceId)
      )
        throw failure(
          '本机正式工作区在备份核对期间发生切换或初始化，请保留备份并重新核对，未覆盖任何一方。',
          'LOCAL_WORKSPACE_MIGRATION_AUTHORITY_CHANGED',
          409,
        );
    }
    if (envelope.workspace === null) {
      const workspace = raw;
      // Validate before sending, but let the service retain the original version
      // as migration evidence before it commits the v3 representation.
      migrateWorkspace(workspace);
      envelope = await request('./__local/workspace/commands', {
        method: 'POST',
        body: {
          commandId: makeId(),
          expectedRevision: envelope.revision,
          type: 'import_workspace',
          payload: { workspace, reason: '首次迁移浏览器工作区' },
        },
      });
      if (!envelope.workspace)
        throw failure('本机工作区尚未完成初始迁移。', 'LOCAL_WORKSPACE_UNINITIALIZED');
    }
    if (envelope.replayed) envelope = await request('./__local/workspace');
    if (needsPreflight) preparedImports.delete(prepared);
    rememberAuthority(envelope.workspaceId);
    offline = false;
    await cache(envelope, needsPreflight ? '切换本机正式工作区前' : '');
    return envelope.workspace;
  }

  async function active() {
    if (mode === null) return discover();
    return mode === 'local';
  }

  async function readCurrent() {
    try {
      if (!(await active())) return null;
      return (await load()).workspace;
    } catch (error) {
      const unavailable =
        error instanceof TypeError ||
        error?.name === 'TimeoutError' ||
        ['LOCAL_WORKSPACE_UNAVAILABLE', 'LOCAL_WORKSPACE_REQUIRED'].includes(error?.code);
      if (!unavailable || !authorityStorage?.getItem(authorityKey)) throw error;
      const cached = await readCache();
      if (!cached) throw error;
      mode = 'local';
      offline = true;
      onOffline();
      return migrateWorkspace(cached);
    }
  }

  function read() {
    const job = chain.then(readCurrent);
    chain = job.catch(() => {});
    return job;
  }

  async function submit(type, payload) {
    if (!(await active())) return null;
    const execute = async () => {
      const current = await load();
      let committed;
      try {
        committed = await request('./__local/workspace/commands', {
          method: 'POST',
          body: {
            commandId: makeId(),
            expectedRevision: current.revision,
            type,
            payload,
          },
        });
      } catch (error) {
        if (error.code !== 'WORKSPACE_REVISION_CONFLICT') throw error;
        await cache(await request('./__local/workspace'));
        throw failure(
          '记录已由另一操作更新，本次修改未覆盖它。请核对最新记录后再保存，草稿仍保留。',
          'WORKSPACE_REVISION_CONFLICT',
          409,
        );
      }
      if (committed.replayed) committed = await request('./__local/workspace');
      await cache(committed);
      return committed.workspace;
    };
    const job = chain.then(execute);
    chain = job.catch(() => {});
    return job;
  }

  function releaseHints(before, next) {
    for (const group of ['sourceEvents', 'sourceFacts', 'sourceApplications'])
      if (!equal(before[group], next[group]))
        throw failure('网页业务编辑不能修改来源证据。', 'LOCAL_WORKSPACE_COMMAND_REQUIRED');
    const nextBindings = new Map(next.sourceBindings.map((row) => [row.id, row]));
    if (nextBindings.size !== before.sourceBindings.length)
      throw failure('网页业务编辑不能新增或删除来源绑定。', 'LOCAL_WORKSPACE_COMMAND_REQUIRED');
    const hints = [];
    for (const prior of before.sourceBindings) {
      const current = nextBindings.get(prior.id);
      if (!current)
        throw failure('网页业务编辑不能新增或删除来源绑定。', 'LOCAL_WORKSPACE_COMMAND_REQUIRED');
      const left = { ...prior },
        right = { ...current };
      delete left.autoFields;
      delete right.autoFields;
      if (!equal(left, right))
        throw failure('网页业务编辑不能改写来源绑定。', 'LOCAL_WORKSPACE_COMMAND_REQUIRED');
      const oldFields = new Set((prior.autoFields || '').split(',').filter(Boolean)),
        newFields = new Set((current.autoFields || '').split(',').filter(Boolean));
      if ([...newFields].some((field) => !oldFields.has(field)))
        throw failure('网页业务编辑不能取得自动字段所有权。', 'LOCAL_WORKSPACE_COMMAND_REQUIRED');
      const fields = SOURCE_AUTO_FIELDS.filter(
        (field) => oldFields.has(field) && !newFields.has(field),
      );
      if (fields.length) hints.push({ opportunityId: prior.opportunityId, fields });
    }
    return hints;
  }

  async function editData(transform, { reason = '' } = {}) {
    if (!(await active())) return null;
    const execute = async () => {
      const current = await load();
      const before = current.workspace.data,
        next = validateData(transform(structuredClone(before))),
        changes = [];
      for (const group of BUSINESS_GROUPS) {
        const prior = new Map(before[group].map((row) => [row.id, row]));
        for (const row of next[group]) {
          if (!equal(prior.get(row.id), row)) changes.push({ group, record: row });
          prior.delete(row.id);
        }
        if (prior.size)
          throw failure(
            '正式记录必须使用删除标记，不能从集合中直接移除。',
            'LOCAL_WORKSPACE_COMMAND_REQUIRED',
          );
      }
      const releaseFields = releaseHints(before, next);
      if (!changes.length && !releaseFields.length) return current.workspace;
      let committed;
      try {
        committed = await request('./__local/workspace/commands', {
          method: 'POST',
          body: {
            commandId: makeId(),
            expectedRevision: current.revision,
            type: 'edit_data',
            payload: { changes, releaseFields, reason },
          },
        });
      } catch (error) {
        if (error.code !== 'WORKSPACE_REVISION_CONFLICT') throw error;
        await cache(await request('./__local/workspace'));
        throw failure(
          '记录已由另一操作更新，本次修改未覆盖它。请核对最新记录后再保存，草稿仍保留。',
          'WORKSPACE_REVISION_CONFLICT',
          409,
        );
      }
      if (committed.replayed) committed = await request('./__local/workspace');
      await cache(committed);
      return committed.workspace;
    };
    const job = chain.then(execute);
    chain = job.catch(() => {});
    return job;
  }

  async function update() {
    if (!(await active())) return null;
    throw failure('本机正式工作区只接受固定业务命令。', 'LOCAL_WORKSPACE_COMMAND_REQUIRED', 400);
  }

  return {
    read,
    update,
    editData,
    setSyncConfig: (config) => submit('set_sync_config', { config }),
    stageSyncConflict: (syncTransactionId, generation) =>
      submit('stage_sync_conflict', { syncTransactionId, generation }),
    resolveSyncConflict: (choices, generation) =>
      submit('resolve_sync_conflict', { choices, generation }),
    restoreWorkspace: (backup, mode) => submit('restore_workspace', { backup, mode }),
    acknowledgeSync: (syncTransactionId) => submit('acknowledge_sync', { syncTransactionId }),
    bindBossAccount: (accountNamespace, restore = false) =>
      submit('bind_boss_account', { accountNamespace, restore }),
    active,
    prepareImport,
    importCurrent,
    mode: () => mode,
    status: () => ({ local: mode === 'local', offline }),
  };
}
