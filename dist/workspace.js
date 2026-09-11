import { clone, emptyData, GROUPS, validateData, removeOpportunity } from './model.js';
import { APP_VERSION, BACKUP_VERSION, DATA_VERSION, WORKSPACE_VERSION } from './version.js';

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

// Add a pure, one-version step here when the shared data format actually changes.
const dataMigrations = new Map();
export function migrateData(input, options) {
  let data = clone(input);
  if (!Number.isInteger(data?.schemaVersion) || data.schemaVersion > DATA_VERSION) {
    throw new Error('数据来自不支持的版本，请更新工作台后再打开；原数据未改动。');
  }
  while (data.schemaVersion < DATA_VERSION) {
    const migrate = dataMigrations.get(data.schemaVersion);
    if (!migrate) throw new Error('缺少此版本的数据迁移步骤，已保留原数据。');
    data = migrate(data);
  }
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
        c[side] = migrateData({ ...emptyData(), [c.group]: [c[side]] }, { allowOrphans: true })[
          c.group
        ][0];
      }
    }
  }
  return out;
}

export function migrateWorkspace(input) {
  if (!input) return initialWorkspace();
  const version = input.workspaceVersion ?? 1;
  if (![1, WORKSPACE_VERSION].includes(version))
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

export const createBackup = (state) => ({
  backupVersion: BACKUP_VERSION,
  appVersion: APP_VERSION,
  exportedAt: new Date().toISOString(),
  workspace: migrateWorkspace(state),
});

export function parseBackup(input) {
  if (input?.backupVersion !== undefined) {
    if (input.backupVersion !== BACKUP_VERSION)
      throw new Error('备份来自更新版本，请先更新工作台。');
    if (
      !input.workspace ||
      typeof input.workspace !== 'object' ||
      Array.isArray(input.workspace) ||
      !input.workspace.data ||
      !input.workspace.base
    )
      throw new Error('完整备份缺少工作区内容或格式无效，已停止恢复。');
    const workspace = migrateWorkspace(input.workspace);
    return { data: workspace.data, workspace };
  }
  return { data: migrateData(input), workspace: null };
}

export function restoreWorkspace(current, backup, mode) {
  const s = migrateWorkspace(current),
    incoming = parseBackup(backup);
  if (!['merge', 'snapshot'].includes(mode)) throw new Error('请选择恢复方式。');
  if (s.pending) throw new Error('请先解决当前冲突，再恢复备份；仍可导出完整备份。');
  if (incoming.workspace?.pending) {
    if (mode !== 'snapshot')
      throw new Error('包含同步冲突的完整备份请使用“回到快照”，以保留双方记录。');
    const restored = incoming.workspace;
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
      for (const row of [...current.data[group], ...current.base[group]]) {
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
  for (const job of s.data.opportunities.filter((o) => o.deletedAt))
    removeOpportunity(s.data, job.id);
  s.data = validateData(s.data);
  s.generation++;
  s.lastSync = '';
  return s;
}
