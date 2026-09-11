import { MAX_REQUEST_BYTES, MAX_BACKUP_BYTES } from '../dist/limits.js';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError } from './ssh-store.mjs';
import { BackupError } from './disk-backups.mjs';
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
  res.end(JSON.stringify(body));
};
export async function handleLocalApi(req, res, { port, secret, bridge, target, backups }) {
  const path = req.url.split('?')[0];
  const isBackup = path === '/__local/backups' || path.startsWith('/__local/backups/');
  if (!['/__local/session', '/__local/git'].includes(path) && !isBackup) return false;
  const origin = `http://${req.headers.host}`;
  if (
    ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) ||
    (req.headers.origin && req.headers.origin !== origin) ||
    (req.headers['sec-fetch-site'] &&
      !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
  ) {
    json(res, 403, { message: '只允许本机工作台访问此接口。' });
    return true;
  }
  if (path === '/__local/session') {
    if (req.method !== 'GET') {
      json(res, 405, { message: '请求方式不支持。' });
      return true;
    }
    json(res, 200, {
      enabled: !!bridge,
      session: bridge || backups ? secret : undefined,
      backupEnabled: !!backups,
      target: bridge ? target : undefined,
    });
    return true;
  }
  const supplied = req.headers['x-job-tracker-session'];
  if (
    typeof supplied !== 'string' ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
  ) {
    json(res, 403, { message: '本机会话已失效，请刷新工作台。' });
    return true;
  }
  if (isBackup && !backups) {
    json(res, 404, { message: '本机独立备份未启用。' });
    return true;
  }
  if (!isBackup && !bridge) {
    json(res, 404, { message: '此本机服务尚未配置 SSH 同步。' });
    return true;
  }
  try {
    if (req.method === 'GET') {
      if (isBackup) {
        if (path === '/__local/backups') json(res, 200, { files: await backups.list() });
        else {
          const parts = path.split('/');
          if (parts.length !== 5) throw new BackupError('备份文件标识无效。');
          json(res, 200, await backups.read(parts[3], parts[4]));
        }
      } else json(res, 200, await bridge.read());
      return true;
    }
    if (req.method !== 'PUT') {
      json(res, 405, { message: '请求方式不支持。' });
      return true;
    }
    if (
      req.headers.origin !== origin ||
      !req.headers['content-type']?.startsWith('application/json')
    ) {
      json(res, 403, { message: '写入只接受工作台发出的同源 JSON 请求。' });
      return true;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > (isBackup ? MAX_BACKUP_BYTES + 1024 : MAX_REQUEST_BYTES))
        throw new BridgeError(isBackup ? '备份请求超过50 MB。' : '数据超过5 MB。', 413);
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new BridgeError('请求 JSON 无效。', 400);
    }
    if (isBackup) {
      if (
        path !== '/__local/backups' ||
        !body ||
        Object.keys(body).some((k) => !['sourceId', 'backup'].includes(k))
      )
        throw new BackupError('备份请求参数无效。');
      json(res, 200, await backups.save(body.sourceId, body.backup));
      return true;
    }
    if (
      !body ||
      Object.keys(body).some((k) => !['data', 'sha'].includes(k)) ||
      !(body.sha === null || (typeof body.sha === 'string' && /^[a-f0-9]{40,64}$/.test(body.sha)))
    )
      throw new BridgeError('请求参数无效。', 400);
    json(res, 200, await bridge.write(body.data, body.sha));
  } catch (error) {
    json(res, error instanceof BridgeError || error instanceof BackupError ? error.status : 400, {
      message:
        error instanceof BridgeError || error instanceof BackupError
          ? error.message
          : isBackup
            ? ['EACCES', 'EPERM'].includes(error.code)
              ? '备份目录没有写入权限，请检查本机目录权限。'
              : error.code === 'ENOSPC'
                ? '磁盘空间不足，请释放空间后重试。'
                : '备份内容校验或磁盘操作失败，请检查数据格式和备份目录。'
            : '数据校验或本地操作失败，已停止同步。',
      code:
        error instanceof BridgeError || error instanceof BackupError ? error.code : 'DATA_INVALID',
    });
  }
  return true;
}
