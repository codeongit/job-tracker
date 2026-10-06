import { propagatePlatformJobState } from './boss-observations.js';
import {
  clone,
  emptyData,
  equal,
  mergeData,
  releaseManualFieldOwnership,
  resolveConflicts,
} from './model.js';
import { migrateWorkspace, restoreWorkspace } from './workspace.js';
import { acknowledge } from './github.js';
import { WORKSPACE_VERSION } from './version.js';
import { createLocalWorkspaceClient } from './local-workspace.js';

const SNAPSHOT_LIMIT = 20;
let dbPromise;
let localWorkspace;
function service() {
  return (localWorkspace ??= createLocalWorkspaceClient({
    readCache: readRawState,
    writeCache: (workspace, options = {}) =>
      updateCachedState(() => workspace, { emit: false, ...options }),
    onCacheFailure: () => window.dispatchEvent(new Event('workspace-cache-failed')),
    onOffline: () => window.dispatchEvent(new Event('workspace-offline')),
  }));
}
function database() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('job-tracker-v1', 2);
    let blocked = false;
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('workspace'))
        req.result.createObjectStore('workspace');
      if (!req.result.objectStoreNames.contains('snapshots'))
        req.result.createObjectStore('snapshots', { autoIncrement: true });
    };
    req.onblocked = () => {
      blocked = true;
      dbPromise = null;
      reject(new Error('请关闭其他旧版工作台页面，再刷新此页完成升级。'));
    };
    req.onsuccess = () => {
      if (blocked) {
        req.result.close();
        return;
      }
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(new Error('无法打开本地数据库，请检查网站存储权限或更新工作台。'));
    };
  }));
}

function snapshot(tx, workspace, reason) {
  const store = tx.objectStore('snapshots');
  store.add({ createdAt: new Date().toISOString(), reason, workspace: clone(workspace) });
  const keys = store.getAllKeys();
  keys.onsuccess = () =>
    keys.result
      .slice(0, Math.max(0, keys.result.length - SNAPSHOT_LIMIT))
      .forEach((key) => store.delete(key));
}

export async function readRawState() {
  // No version argument: emergency export still works after a future DB upgrade.
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('job-tracker-v1');
    open.onerror = () => reject(new Error('无法读取原始本地状态。'));
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('workspace')) {
        db.close();
        resolve(null);
        return;
      }
      const tx = db.transaction('workspace', 'readonly');
      const req = tx.objectStore('workspace').get('state');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = tx.onabort = () => db.close();
    };
  });
}

async function updateCachedState(transform, { reason = '', emit = true } = {}) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['workspace', 'snapshots'], 'readwrite');
    const store = tx.objectStore('workspace'),
      req = store.get('state');
    let next,
      failure,
      changed = false;
    req.onsuccess = () => {
      try {
        const raw = req.result,
          current = migrateWorkspace(raw);
        if (raw && (reason || raw.workspaceVersion !== WORKSPACE_VERSION))
          snapshot(tx, raw, reason || '工作区升级前');
        next = migrateWorkspace(transform(clone(current)));
        changed = !equal(raw, next);
        store.put(next, 'state');
      } catch (e) {
        failure = e;
        tx.abort();
      }
    };
    tx.oncomplete = () => {
      if (changed && emit) window.dispatchEvent(new Event('workspace-saved'));
      resolve(next);
    };
    tx.onerror = () => {
      failure ??= new Error('本地保存或快照失败，本次操作未生效。请导出备份并检查存储空间。');
    };
    tx.onabort = () => reject(failure || new Error('本次修改未保存。'));
  });
}

export async function updateState(transform, options = {}) {
  if (await service().active()) {
    const result = await service().update(transform, options);
    window.dispatchEvent(new Event('workspace-saved'));
    return result;
  }
  return updateCachedState(transform, options);
}
export const readState = async () => (await service().read()) ?? updateCachedState((s) => s);
export const prepareLocalWorkspaceMigration = (drafts) => service().prepareImport(drafts);
export const initializeLocalWorkspace = (prepared, drafts) =>
  service().importCurrent(prepared, drafts);
export const storageStatus = () => service().status();
export async function editData(transform, options = {}) {
  if (await service().active()) {
    const result = await service().editData(transform, options);
    window.dispatchEvent(new Event('workspace-saved'));
    return result;
  }
  return updateCachedState((s) => {
    if (s.pending) throw new Error('请先到“数据与同步”解决冲突，再继续编辑。');
    const next = releaseManualFieldOwnership(
      s.data,
      propagatePlatformJobState(s.data, transform(clone(s.data)), new Date().toISOString()),
    );
    if (!equal(next, s.data)) {
      s.data = next;
      s.generation++;
    }
    return s;
  }, options);
}
export async function setSyncConfig(config) {
  if (await service().active()) return service().setSyncConfig(config);
  return updateCachedState((s) => ({
    ...s,
    config,
    base: equal(config, s.config) ? s.base : emptyData(),
    lastSync: equal(config, s.config) ? s.lastSync : '',
    pending: equal(config, s.config) ? s.pending : null,
  }));
}
export async function stageSyncConflict({ remote, generation, syncTransactionId }) {
  if (await service().active()) return service().stageSyncConflict(syncTransactionId, generation);
  return updateCachedState((s) => {
    if (s.generation !== generation) throw new Error('本机记录刚发生修改，请重新同步。');
    const merged = mergeData(s.base, s.data, remote);
    if (!merged.conflicts.length) throw new Error('当前数据没有需要暂存的同步冲突。');
    s.pending = { data: merged.data, remote, conflicts: merged.conflicts, generation };
    return s;
  });
}
export async function resolveSyncConflict(pending, choices) {
  if (await service().active()) return service().resolveSyncConflict(choices, pending.generation);
  return updateCachedState((s) => {
    if (s.generation !== pending.generation)
      throw new Error('本机记录已变化，请关闭后再次同步，重新核对冲突。');
    s.data = resolveConflicts(pending.data, pending.conflicts, choices);
    if (pending.remote) s.base = pending.remote;
    s.pending = null;
    s.generation++;
    return s;
  });
}
export async function acknowledgeSync(captured, uploaded, syncTransactionId) {
  if (await service().active()) return service().acknowledgeSync(syncTransactionId);
  return updateCachedState((current) => acknowledge(current, captured, uploaded));
}
export async function bindBossSource(accountNamespace, { restore = false } = {}) {
  if (!(await service().active())) return null;
  return service().bindBossAccount(accountNamespace, restore);
}
export async function ignoreBossObservations(applicationIds, expectedRevision) {
  if (!(await service().active())) throw new Error('忽略观察需要连接本机服务。');
  return service().ignoreBossObservations(applicationIds, expectedRevision);
}
export async function saveSnapshot(reason) {
  if (await service().active()) return (await service().read()) ?? null;
  return updateCachedState((s) => s, { reason });
}
export async function restoreBackup(backup, mode) {
  if (await service().active()) return service().restoreWorkspace(backup, mode);
  return updateCachedState((s) => restoreWorkspace(s, backup, mode), {
    reason: '恢复备份前',
  });
}

export async function listSnapshots() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readonly'),
      store = tx.objectStore('snapshots');
    const rows = store.getAll(),
      keys = store.getAllKeys();
    tx.oncomplete = () =>
      resolve(rows.result.map((row, i) => ({ ...row, id: keys.result[i] })).reverse());
    tx.onerror = () => reject(new Error('无法读取本机快照。'));
  });
}
