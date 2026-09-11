import {
  mkdir,
  lstat,
  chmod,
  open,
  rename,
  link,
  unlink,
  readdir,
  readFile,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createBackup, parseBackup } from '../dist/workspace.js';
import { GROUPS } from '../dist/model.js';
import { MAX_BACKUP_BYTES, utf8Bytes } from '../dist/limits.js';

export const isSourceId = (id) =>
  typeof id === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
const validFile = (name) => name === 'latest.json' || DAY_FILE.test(name);
export class BackupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.code = 'DISK_BACKUP_FAILED';
  }
}
async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new BackupError('备份目录必须是本机普通目录。');
  await chmod(path, 0o700);
}
async function regular(path) {
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink()) throw new BackupError('备份目标不是普通文件。');
    return s;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
const dayOf = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export class DiskBackups {
  constructor(root, { now = () => new Date(), beforeCommit = async () => {} } = {}) {
    this.root = root;
    this.now = now;
    this.beforeCommit = beforeCommit;
    this.queue = Promise.resolve();
  }
  async initialize() {
    await directory(dirname(this.root));
    await directory(this.root);
  }
  exclusive(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    return job;
  }
  async save(sourceId, input) {
    if (!isSourceId(sourceId)) throw new BackupError('备份来源格式无效。');
    const parsed = parseBackup(input);
    if (!parsed.workspace) throw new BackupError('独立备份需要完整工作区。');
    const backup = createBackup(parsed.workspace, parsed.drafts);
    if (
      GROUPS.every((g) => !backup.workspace.data[g].length && !backup.workspace.base[g].length) &&
      !backup.workspace.pending &&
      !backup.drafts.length
    )
      return { skipped: true, reason: '尚无记录或草稿可备份。' };
    const text = JSON.stringify(backup, null, 2) + '\n';
    if (utf8Bytes(text) > MAX_BACKUP_BYTES)
      throw new BackupError('完整备份超过 50 MB，请手动导出后整理数据。', 413);
    return this.exclusive(async () => {
      await this.initialize();
      const dir = join(this.root, sourceId);
      await directory(dir);
      const now = this.now(),
        day = dayOf(now),
        daily = join(dir, day + '.json'),
        latest = join(dir, 'latest.json');
      await regular(daily);
      const previous = await regular(latest);
      const signature = (value) =>
        createHash('sha256')
          .update(JSON.stringify({ workspace: value.workspace, drafts: value.drafts }))
          .digest('hex');
      if (previous) {
        const old = JSON.parse(await readFile(latest, 'utf8'));
        if (signature(old) === signature(backup) && (await regular(daily)))
          return { savedAt: old.exportedAt, sourceId, file: 'latest.json', unchanged: true };
      }
      const temp = join(dir, `.pending-${randomUUID()}`);
      let handle;
      try {
        handle = await open(temp, 'wx', 0o600);
        await handle.writeFile(text, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await this.beforeCommit();
        // link is exclusive and atomic: the day's first complete snapshot is never replaced.
        try {
          await link(temp, daily);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
        await rename(temp, latest);
        const dates = (await readdir(dir)).filter((name) => DAY_FILE.test(name)).sort();
        for (const name of dates.slice(0, Math.max(0, dates.length - 30))) {
          await regular(join(dir, name));
          await unlink(join(dir, name));
        }
        return { savedAt: backup.exportedAt, sourceId, file: 'latest.json', unchanged: false };
      } finally {
        await handle?.close();
        await unlink(temp).catch(() => {});
      }
    });
  }
  async list() {
    await this.initialize();
    const rows = [];
    for (const sourceId of await readdir(this.root)) {
      if (!isSourceId(sourceId)) continue;
      const dir = join(this.root, sourceId),
        info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      for (const file of await readdir(dir)) {
        if (!validFile(file)) continue;
        const stat = await regular(join(dir, file));
        if (!stat) continue;
        rows.push({ sourceId, file, savedAt: stat.mtime.toISOString(), size: stat.size });
      }
    }
    return rows.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  async read(sourceId, file) {
    if (!isSourceId(sourceId) || !validFile(file)) throw new BackupError('备份文件标识无效。');
    await this.initialize();
    const dir = join(this.root, sourceId);
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BackupError('备份目录无效。');
    const path = join(dir, file),
      stat = await regular(path);
    if (!stat) throw new BackupError('备份文件不存在。', 404);
    if (stat.size > MAX_BACKUP_BYTES)
      throw new BackupError('备份文件过大，请在私有目录中手动读取。', 413);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
    parseBackup(JSON.parse(raw));
    return JSON.parse(raw);
  }
}
