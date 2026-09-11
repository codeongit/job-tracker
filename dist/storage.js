import { clone } from './model.js';
import { migrateWorkspace, restoreWorkspace } from './workspace.js';
import { WORKSPACE_VERSION } from './version.js';

const SNAPSHOT_LIMIT = 20;
let dbPromise;
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

export async function updateState(transform, { reason = '' } = {}) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['workspace', 'snapshots'], 'readwrite');
    const store = tx.objectStore('workspace'),
      req = store.get('state');
    let next, failure;
    req.onsuccess = () => {
      try {
        const raw = req.result,
          current = migrateWorkspace(raw);
        if (raw && (reason || raw.workspaceVersion !== WORKSPACE_VERSION))
          snapshot(tx, raw, reason || '工作区升级前');
        next = migrateWorkspace(transform(clone(current)));
        store.put(next, 'state');
      } catch (e) {
        failure = e;
        tx.abort();
      }
    };
    tx.oncomplete = () => {
      window.dispatchEvent(new Event('workspace-saved'));
      resolve(next);
    };
    tx.onerror = () => {
      failure ??= new Error('本地保存或快照失败，本次操作未生效。请导出备份并检查存储空间。');
    };
    tx.onabort = () => reject(failure || new Error('本次修改未保存。'));
  });
}

export const readState = () => updateState((s) => s);
export const editData = (transform, options) =>
  updateState((s) => {
    if (s.pending) throw new Error('请先到“数据与同步”解决冲突，再继续编辑。');
    s.data = transform(s.data);
    s.generation++;
    return s;
  }, options);
export const saveSnapshot = (reason) => updateState((s) => s, { reason });
export const restoreBackup = (backup, mode) =>
  updateState((s) => restoreWorkspace(s, backup, mode), { reason: '恢复备份前' });

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
