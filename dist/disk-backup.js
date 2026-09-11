import { createBackup } from './workspace.js';
import { GROUPS } from './model.js';

export function createDiskBackup({
  readWorkspace,
  readDrafts,
  onStatus = () => {},
  fetcher = fetch,
  delay = 2500,
  poll = 30000,
}) {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  let session = null,
    timer = null,
    interval = null,
    running = false,
    stopped = false,
    again = false,
    lastContent = '',
    lastDay = '',
    status = {
      available: false,
      message: local ? '正在检查本机独立备份…' : '此网页可下载完整备份；自动磁盘备份需要本机服务。',
    };
  const update = (patch) => {
    status = { ...status, ...patch };
    onStatus(status);
  };
  async function discover() {
    const response = await fetcher('./__local/session', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('本机服务未启动或版本较旧。');
    const info = await response.json();
    if (!info.backupEnabled || !info.session)
      throw new Error('此服务不支持独立备份，请更新后重启。');
    session = info.session;
    update({ available: true });
  }
  async function request(path, method = 'GET', body, retry = true) {
    if (!session) await discover();
    const response = await fetcher(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Job-Tracker-Session': session },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 403 && retry) {
      session = null;
      await discover();
      return request(path, method, body, false);
    }
    const value = await response.json();
    if (!response.ok) throw new Error(value.message || '独立备份暂时失败。');
    return value;
  }
  function sourceId() {
    const key = 'job-tracker-backup-source-v1';
    let value = localStorage.getItem(key);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value || '')) {
      value = crypto.randomUUID();
      localStorage.setItem(key, value);
    }
    return value;
  }
  async function perform(force) {
    const workspace = await readWorkspace(),
      drafts = readDrafts();
    if (!workspace) return;
    const backup = createBackup(workspace, drafts);
    if (
      GROUPS.every((g) => !backup.workspace.data[g].length && !backup.workspace.base[g].length) &&
      !backup.workspace.pending &&
      !drafts.length
    ) {
      update({ message: '尚无记录或草稿可备份。已有磁盘备份保留。' });
      return;
    }
    const content = JSON.stringify({ workspace: backup.workspace, drafts }),
      day = new Date().toDateString();
    if (!force && lastContent === content && lastDay === day) return;
    const result = await request('./__local/backups', 'PUT', { sourceId: sourceId(), backup });
    if (!result.skipped) {
      lastContent = content;
      lastDay = day;
      update({
        available: true,
        lastSavedAt: result.savedAt,
        message: `独立备份已保存：${new Date(result.savedAt).toLocaleString('zh-CN')}`,
      });
    }
  }
  async function run(force = false) {
    if (!local) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const execute = () => perform(force);
      if (navigator.locks) await navigator.locks.request('job-tracker-disk-backup', execute);
      else await execute();
    } catch (error) {
      session = null;
      const message =
        error instanceof TypeError || error.name === 'TimeoutError'
          ? '无法连接本机服务，请启动服务后重试。'
          : error.message;
      update({ message: `独立备份未完成：${message} 本机记录与草稿仍保留。` });
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  }
  function schedule() {
    if (!local || timer || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delay);
  }
  const focus = () => run();
  function start() {
    stopped = false;
    onStatus(status);
    if (!local) return;
    window.addEventListener('workspace-saved', schedule);
    window.addEventListener('drafts-saved', schedule);
    window.addEventListener('focus', focus);
    interval = setInterval(() => run(), poll);
    run();
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
    clearInterval(interval);
    timer = null;
    interval = null;
    window.removeEventListener('workspace-saved', schedule);
    window.removeEventListener('drafts-saved', schedule);
    window.removeEventListener('focus', focus);
  }
  return {
    start,
    stop,
    run: () => run(true),
    status: () => status,
    list: () => request('./__local/backups'),
    read: (source, file) =>
      request(`./__local/backups/${encodeURIComponent(source)}/${encodeURIComponent(file)}`),
  };
}
