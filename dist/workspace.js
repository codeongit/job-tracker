import { validateDrafts } from './draft-data.js';
import { clone, emptyData, GROUPS, validateData, removeOpportunity } from './model.js';
import { APP_VERSION, BACKUP_VERSION, DATA_VERSION, WORKSPACE_VERSION } from './version.js';
import { upgradeSourceLedger } from './source-ledger.js';

export function initialWorkspace() {
  return {
    workspaceVersion: WORKSPACE_VERSION,
    data: emptyData(),
    base: emptyData(),
    config: { owner: 'codeongit', repo: 'personalNote', path: '简历准备/job-tracker/data.json' },
    generation: 0,
    lastSync: '',
    pending: null,
  };
}

const V1_GROUPS = ['opportunities', 'activities', 'tasks', 'imports'];
const dataMigrations = new Map([
  [
    3,
    (input) => {
      const stateFields = ['platformJobState', 'platformJobStateSource', 'platformJobStateAt'];
      const resolutionFields = ['resolutionSource', 'resolvedJobId', 'resolvedJobUrl'];
      for (const group of ['opportunities', 'sourceApplications']) {
        if (
          !Array.isArray(input[group]) ||
          input[group].some((row) =>
            [...stateFields, ...resolutionFields].some((field) => field in row),
          )
        )
          throw new Error('旧数据包含未知字段，已停止迁移。');
      }
      input = upgradeSourceLedger(input);
      return {
        ...input,
        schemaVersion: 4,
        opportunities: input.opportunities.map((row) => ({
          ...row,
          platformJobState: 'unknown',
          platformJobStateSource: '',
          platformJobStateAt: '',
        })),
        sourceApplications: input.sourceApplications.map((row) => ({
          ...row,
          resolutionSource: '',
          resolvedJobId: '',
          resolvedJobUrl: '',
          platformJobState: 'unknown',
          platformJobStateSource: '',
          platformJobStateAt: '',
        })),
      };
    },
  ],
  [
    1,
    (input) => {
      if (Object.keys(input).some((key) => !['schemaVersion', ...V1_GROUPS].includes(key)))
        throw new Error('旧数据包含未知字段，已停止迁移；原数据未改动。');
      return {
        ...input,
        schemaVersion: 2,
        sourceBindings: [],
        sourceEvents: [],
      };
    },
  ],
  [
    2,
    (input) => {
      const fields = ['schemaVersion', ...V1_GROUPS, 'sourceBindings', 'sourceEvents'];
      if (
        Object.keys(input).some((key) => !fields.includes(key)) ||
        !Array.isArray(input.sourceEvents)
      )
        throw new Error('旧数据包含未知字段或来源集合无效，已停止迁移；原数据未改动。');
      return {
        ...input,
        schemaVersion: 3,
        // The v3 adapter aggregates semantic facts and decisions once. Starting
        // empty avoids duplicate application IDs and makes migration independent
        // of the v2 event array order.
        sourceFacts: [],
        sourceApplications: [],
      };
    },
  ],
]);
export function migrateData(input, options) {
  let data = clone(input);
  let ledgerAdapted = false;
  if (!Number.isInteger(data?.schemaVersion) || data.schemaVersion > DATA_VERSION) {
    throw new Error('数据来自不支持的版本，请更新工作台后再打开；原数据未改动。');
  }
  while (data.schemaVersion < DATA_VERSION) {
    const version = data.schemaVersion;
    const migrate = dataMigrations.get(version);
    if (!migrate) throw new Error('缺少此版本的数据迁移步骤，已保留原数据。');
    data = migrate(data);
    ledgerAdapted = version === 3 && data.schemaVersion === DATA_VERSION;
  }
  if (!ledgerAdapted) data = upgradeSourceLedger(data);
  return validateData(data, options);
}

function validatePending(pending) {
  if (!pending) return null;
  if (!Array.isArray(pending.conflicts) || !Number.isSafeInteger(pending.generation))
    throw new Error('冲突备份格式无效。');
  if (Object.keys(pending).some((k) => !['data', 'remote', 'conflicts', 'generation'].includes(k)))
    throw new Error('冲突备份包含未知字段。');
  const out = clone(pending);
  out.data = migrateData(out.data, { allowOrphans: true });
  if (out.remote) out.remote = migrateData(out.remote);
  for (const c of out.conflicts) {
    if (
      !c ||
      Object.keys(c).some(
        (k) => !['key', 'group', 'id', 'base', 'local', 'remote', 'relational'].includes(k),
      )
    )
      throw new Error('冲突记录包含未知字段。');
    if (!GROUPS.includes(c.group) || typeof c.id !== 'string' || c.key !== `${c.group}:${c.id}`)
      throw new Error('冲突记录格式无效。');
    for (const side of ['base', 'local', 'remote']) {
      if (c[side] !== undefined) {
        if (c[side].id !== c.id) throw new Error('冲突记录 ID 不一致。');
        const sideData = emptyData();
        if (pending.data.schemaVersion < 3) {
          delete sideData.sourceFacts;
          delete sideData.sourceApplications;
        }
        if (pending.data.schemaVersion < 2) {
          delete sideData.sourceBindings;
          delete sideData.sourceEvents;
        }
        c[side] = migrateData(
          { ...sideData, schemaVersion: pending.data.schemaVersion, [c.group]: [c[side]] },
          { allowOrphans: true },
        )[c.group][0];
      }
    }
  }
  return out;
}

export function migrateWorkspace(input) {
  if (!input) return initialWorkspace();
  const version = input.workspaceVersion ?? 1;
  if (![1, 2, WORKSPACE_VERSION].includes(version))
    throw new Error('本地工作区来自更新版本，请更新工作台；原数据未改动。');
  if (
    Object.keys(input).some(
      (k) =>
        ![
          'workspaceVersion',
          'data',
          'base',
          'config',
          'generation',
          'lastSync',
          'pending',
        ].includes(k),
    )
  )
    throw new Error('工作区包含未知字段，已停止写入，请先导出原始备份。');
  const s = clone(input),
    c = s.config;
  if (
    !c ||
    !/^[\w.-]+$/.test(c.owner) ||
    !/^[\w.-]+$/.test(c.repo) ||
    typeof c.path !== 'string' ||
    !c.path.endsWith('.json') ||
    c.path.split('/').some((p) => !p || p === '.' || p === '..') ||
    Object.keys(c).some((k) => !['owner', 'repo', 'path'].includes(k))
  )
    throw new Error('工作区同步目标无效。');
  if (!Number.isSafeInteger(s.generation) || s.generation < 0 || typeof s.lastSync !== 'string')
    throw new Error('工作区状态无效。');
  s.pending = validatePending(s.pending);
  s.data = migrateData(s.data, { allowOrphans: !!s.pending });
  s.base = migrateData(s.base);
  if (s.pending && s.pending.generation !== s.generation)
    throw new Error('冲突版本与工作区不一致，请先导出原始备份。');
  s.workspaceVersion = WORKSPACE_VERSION;
  return s;
}

export const createBackup = (state, drafts = []) => ({
  backupVersion: BACKUP_VERSION,
  appVersion: APP_VERSION,
  exportedAt: new Date().toISOString(),
  workspace: migrateWorkspace(state),
  drafts: validateDrafts(drafts),
});

export function parseBackup(input) {
  if (input?.backupVersion !== undefined) {
    if (![1, BACKUP_VERSION].includes(input.backupVersion))
      throw new Error('备份来自更新版本，请先更新工作台。');
    if (
      !input.workspace ||
      typeof input.workspace !== 'object' ||
      Array.isArray(input.workspace) ||
      !input.workspace.data ||
      !input.workspace.base
    )
      throw new Error('完整备份缺少工作区内容或格式无效，已停止恢复。');
    if (
      Object.keys(input).some(
        (k) => !['backupVersion', 'appVersion', 'exportedAt', 'workspace', 'drafts'].includes(k),
      )
    )
      throw new Error('备份包含未知字段。');
    if (input.backupVersion === 1 && input.drafts !== undefined)
      throw new Error('旧版备份不支持草稿字段。');
    const workspace = migrateWorkspace(input.workspace);
    return {
      data: workspace.data,
      workspace,
      drafts: input.backupVersion === 2 ? validateDrafts(input.drafts) : [],
    };
  }
  return { data: migrateData(input), workspace: null, drafts: [] };
}

export function restoreWorkspace(current, backup, mode) {
  const s = migrateWorkspace(current),
    incoming = parseBackup(backup);
  const before = clone(s);
  if (!['merge', 'snapshot'].includes(mode)) throw new Error('请选择恢复方式。');
  if (s.pending) throw new Error('请先解决当前冲突，再恢复备份；仍可导出完整备份。');
  if (incoming.workspace?.pending) {
    if (mode !== 'snapshot')
      throw new Error('包含同步冲突的完整备份请使用“回到快照”，以保留双方记录。');
    const restored = incoming.workspace;
    preserveManualJobDetails(before.data, restored.data);
    preserveManualJobDetails(before.data, restored.pending.data);
    restored.generation = s.generation + 1;
    restored.pending.generation = restored.generation;
    restored.lastSync = '';
    return restored;
  }
  if (mode === 'snapshot') {
    // Keep the current sync baseline: restoring is a new local edit, not an upload acknowledgement.
    s.data = clone(incoming.data);
    for (const group of GROUPS) {
      const ids = new Set(s.data[group].map((row) => row.id));
      for (const row of [...before.data[group], ...before.base[group]]) {
        if (!ids.has(row.id)) {
          s.data[group].push({ ...clone(row), deletedAt: new Date().toISOString() });
          ids.add(row.id);
        }
      }
    }
  } else {
    for (const group of GROUPS) {
      const rows = new Map(s.data[group].map((row) => [row.id, row]));
      for (const row of incoming.data[group]) rows.set(row.id, clone(row));
      s.data[group] = [...rows.values()];
    }
  }
  preserveManualJobDetails(before.data, s.data);
  const originalSchema = backup?.workspace?.data?.schemaVersion ?? backup?.schemaVersion;
  if (originalSchema < 4) {
    for (const group of ['opportunities', 'sourceApplications']) {
      for (const previous of before.data[group]) {
        const row = s.data[group].find((row) => row.id === previous.id && !row.deletedAt);
        if (
          row &&
          !previous.deletedAt &&
          previous.platformJobStateSource === 'user' &&
          (row.platformJobState || 'unknown') === 'unknown'
        ) {
          row.platformJobState = previous.platformJobState;
          row.platformJobStateSource = previous.platformJobStateSource;
          row.platformJobStateAt = previous.platformJobStateAt;
        }
      }
    }
  }
  for (const job of s.data.opportunities.filter((o) => o.deletedAt))
    removeOpportunity(s.data, job.id);
  s.data = validateData(s.data);
  s.generation++;
  s.lastSync = '';
  return s;
}

function preserveManualJobDetails(before, next) {
  for (const previous of before.sourceApplications) {
    if (previous.deletedAt || previous.resolutionSource !== 'user') continue;
    const row = next.sourceApplications.find(
      (row) => row.id === previous.id && row.factId === previous.factId && !row.deletedAt,
    );
    if (!row || !['waiting', 'review'].includes(row.status)) continue;
    if (!next.opportunities.some((target) => target.id === previous.opportunityId))
      throw new Error('备份缺少已人工确认的岗位目标，请保留当前工作区并核对备份。');
    Object.assign(row, clone(previous));
  }
}
