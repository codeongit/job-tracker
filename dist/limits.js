import { serialize, validateData } from './model.js';

export const MAX_SYNC_BYTES = 5_000_000;
export const MAX_REQUEST_BYTES = MAX_SYNC_BYTES + 1024;
export const MAX_BACKUP_BYTES = 50_000_000;
export const utf8Bytes = (text) => new TextEncoder().encode(text).byteLength;

export function checkSyncText(text) {
  if (utf8Bytes(text) > MAX_SYNC_BYTES) {
    const error = new Error(
      '数据文件超过 5 MB，已停止同步。请先导出完整备份，再整理历史导入原文。',
    );
    error.status = 413;
    throw error;
  }
  return text;
}

// Check the exact persisted representation, not the smaller HTTP request body.
export const serializeForSync = (data) => checkSyncText(serialize(validateData(data)));
