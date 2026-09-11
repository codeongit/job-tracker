import { live, today } from './model.js';
import { parseBackup } from './workspace.js';
import { listSnapshots, restoreBackup } from './storage.js';
import { $, esc, download } from './ui.js';

export function createBackupUI({
  isSyncing,
  restored,
  report,
  prepareDrafts = () => ({ commit() {}, rollback() {} }),
}) {
  async function showRestore(backup) {
    if (isSyncing()) throw new Error('请等待同步结束，再恢复备份。');
    const incoming = parseBackup(backup);
    $('#import-content').innerHTML =
      `<div class="dialog-header"><h2>恢复 JSON 备份</h2><button class="close" data-close="import-dialog" aria-label="关闭">×</button></div><div class="dialog-body"><p>备份包含 ${live(incoming.data.opportunities).length} 个岗位、${live(incoming.data.activities).length} 条沟通记录、${incoming.drafts.length} 份草稿。</p><p class="section-gap">合并恢复：备份中的同 ID 记录优先，保留本机独有记录。</p><p>回到快照：本机记录恢复到备份内容，快照之外的已有记录标记为删除；下次同步会提交这些修改。</p>${incoming.workspace?.pending ? '<p class="warning">此完整备份包含未解决冲突，仅可回到快照，同时恢复备份中的同步目标和冲突双方。</p>' : ''}<p class="section-gap">执行前会自动保存本机快照。普通恢复保留当前同步目标；恢复后不会自动上传。</p></div><div class="dialog-footer"><button class="secondary" data-close="import-dialog">取消</button><button class="secondary" id="restore-snapshot">回到快照</button><button class="primary" id="restore-button" ${incoming.workspace?.pending ? 'disabled' : ''}>合并恢复备份</button></div>`;
    $('#import-dialog').showModal();
    let restoring = false;
    for (const [id, mode] of [
      ['restore-button', 'merge'],
      ['restore-snapshot', 'snapshot'],
    ]) {
      document.getElementById(id).onclick = async () => {
        if (restoring) return;
        let prepared,
          committed = false;
        try {
          if (isSyncing()) throw new Error('请等待同步结束，再恢复备份。');
          if (
            mode === 'snapshot' &&
            !confirm('回到此快照？快照外的本机记录将标记为删除，操作前会自动备份。')
          )
            return;
          restoring = true;
          prepared = prepareDrafts(incoming.drafts);
          const next = await restoreBackup(backup, mode);
          committed = true;
          prepared.commit();
          $('#import-dialog').close();
          await restored(next);
        } catch (e) {
          if (!committed) prepared?.rollback();
          report(e);
        } finally {
          restoring = false;
        }
      };
    }
  }

  async function showSnapshots() {
    const rows = await listSnapshots();
    $('#import-content').innerHTML =
      `<div class="dialog-header"><h2>本机自动快照</h2><button class="close" data-close="import-dialog" aria-label="关闭">×</button></div><div class="dialog-body"><p>保留最近 20 次删除、导入、恢复、升级或同步前的状态。快照与当前记录都保存在此浏览器，清理网站数据会一起删除。</p>${rows.length ? rows.map((row) => `<section class="section-gap"><p>${esc(new Date(row.createdAt).toLocaleString('zh-CN'))} · ${esc(row.reason)}</p><div class="button-row"><button class="secondary" data-snapshot-download="${row.id}">下载快照</button><button class="secondary" data-snapshot-restore="${row.id}">恢复此快照</button></div></section>`).join('') : '<p class="section-gap">暂无快照。</p>'}</div>`;
    $('#import-dialog').showModal();
    $('#import-content').onclick = async (e) => {
      const button = e.target.closest('button');
      if (!button) return;
      const id = Number(button.dataset.snapshotDownload || button.dataset.snapshotRestore);
      if (!id) return;
      try {
        const row = rows.find((r) => r.id === id);
        const backup = { backupVersion: 1, workspace: row.workspace };
        if (button.dataset.snapshotDownload)
          download(
            `求职快照-${row.id}-${today()}.json`,
            JSON.stringify(backup, null, 2),
            'application/json;charset=utf-8',
          );
        else {
          $('#import-content').onclick = null;
          await showRestore(backup);
        }
      } catch (e) {
        report(e);
      }
    };
  }
  return { showRestore, showSnapshots };
}
