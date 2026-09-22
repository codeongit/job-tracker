import { MAX_REQUEST_BYTES, MAX_BACKUP_BYTES } from '../dist/limits.js';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError } from './ssh-store.mjs';
import { BackupError } from './disk-backups.mjs';
import { BossInboxError } from './boss-inbox.mjs';
import { handleWorkspaceApi } from './workspace-api.mjs';
import { handleBossControllerApi } from './boss-controller-api.mjs';
import { WorkspaceStoreError } from './workspace-store.mjs';
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
  res.end(JSON.stringify(body));
};
const BOSS_RECEIPT_BYTES = 64 * 1024;
const BATCH_ID = /^boss-batch-[a-f0-9]{64}$/;
const WORKSPACE_SOURCE_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export async function handleLocalApi(
  req,
  res,
  {
    port,
    secret,
    bridge,
    target,
    backups,
    bossInbox,
    bossController,
    inboxConsumer,
    workspaceStore,
    instanceId,
    controlToken,
    shutdown,
    versions = {},
  },
) {
  const path = req.url.split('?')[0];
  const isBackup = path === '/__local/backups' || path.startsWith('/__local/backups/');
  const isBoss = path === '/__local/boss-inbox' || path.startsWith('/__local/boss-inbox/');
  const isBossRuntime = path === '/__local/boss-runtime';
  const isWorkspace =
    path === '/__local/workspace' ||
    path.startsWith('/__local/workspace/') ||
    path === '/__local/service/stop';
  if (
    !['/__local/session', '/__local/git'].includes(path) &&
    !isBackup &&
    !isBoss &&
    !isBossRuntime &&
    !isWorkspace
  )
    return false;
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
      session:
        bridge || backups || bossInbox || bossController || workspaceStore ? secret : undefined,
      backupEnabled: !!backups,
      bossIntegrationEnabled: !!bossInbox,
      bossTrackingEnabled: !!bossController,
      target: bridge ? target : undefined,
      localWorkspaceEnabled: !!workspaceStore,
      protocolVersion: 1,
      storageVersion: 1,
      instanceId,
      workspaceId: workspaceStore?.workspaceId,
      ...versions,
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
  if (isBoss && !bossInbox) {
    json(res, 404, { message: 'BOSS 本机接入尚未启用。' });
    return true;
  }
  if (isBossRuntime) {
    await handleBossControllerApi(req, res, { controller: bossController });
    return true;
  }
  if (isWorkspace) {
    if (!workspaceStore) {
      json(res, 404, { code: 'WORKSPACE_UNAVAILABLE', message: '本机正式工作区尚未启用。' });
      return true;
    }
    if (
      !(await handleWorkspaceApi(req, res, { workspaceStore, instanceId, controlToken, shutdown }))
    )
      json(res, 404, { code: 'WORKSPACE_ROUTE_INVALID', message: '工作区路径不支持。' });
    return true;
  }
  if (
    workspaceStore &&
    path === '/__local/git' &&
    req.method !== 'GET' &&
    req.headers['x-job-tracker-protocol'] !== '1'
  ) {
    json(res, 409, {
      code: 'PROTOCOL_UPGRADE_REQUIRED',
      message: '旧版工作台不能修改本机同步目标，请更新页面。',
    });
    return true;
  }
  if (!isBackup && !isBoss && !bridge) {
    json(res, 404, { message: '此本机服务尚未配置 SSH 同步。' });
    return true;
  }
  try {
    if (req.method === 'GET') {
      if (isBoss) {
        const parts = path.split('/');
        if (path === '/__local/boss-inbox') {
          const sourceId = new URL(req.url, origin).searchParams.get('workspaceSourceId') || '';
          if (sourceId && !WORKSPACE_SOURCE_ID.test(sourceId))
            throw new BridgeError('浏览器来源标识无效。', 400, 'SOURCE_INVALID');
          json(res, 200, {
            status: await bossInbox.status(
              sourceId ? { workspaceSourceId: sourceId.toLowerCase() } : {},
            ),
            batches: await bossInbox.list(
              sourceId ? { workspaceSourceId: sourceId.toLowerCase() } : {},
            ),
            ...(inboxConsumer ? { recovery: await inboxConsumer.inspect() } : {}),
            tracking: bossController?.status() ?? null,
          });
        } else {
          if (parts.length !== 4 || !BATCH_ID.test(parts[3]))
            throw new BridgeError('BOSS 批次标识无效。', 400, 'BATCH_INVALID');
          json(res, 200, await bossInbox.read(parts[3]));
        }
      } else if (isBackup) {
        if (path === '/__local/backups') json(res, 200, { files: await backups.list() });
        else {
          const parts = path.split('/');
          if (parts.length !== 5) throw new BackupError('备份文件标识无效。');
          json(res, 200, await backups.read(parts[3], parts[4]));
        }
      } else {
        const remote = await bridge.read();
        const transaction = workspaceStore
          ? await workspaceStore.prepareSyncTransaction(remote, target)
          : null;
        json(res, 200, transaction ? { ...remote, ...transaction } : remote);
      }
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
      if (
        size >
        (isBoss ? BOSS_RECEIPT_BYTES : isBackup ? MAX_BACKUP_BYTES + 1024 : MAX_REQUEST_BYTES)
      )
        throw new BridgeError(
          isBoss ? 'BOSS 回执请求过大。' : isBackup ? '备份请求超过50 MB。' : '数据超过5 MB。',
          413,
        );
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new BridgeError('请求 JSON 无效。', 400);
    }
    if (isBoss) {
      const parts = path.split('/');
      if (parts.length === 5 && parts[4] === 'replay' && BATCH_ID.test(parts[3])) {
        if (!inboxConsumer || req.headers['x-job-tracker-protocol'] !== '1')
          throw new BridgeError(
            '请使用当前本机工作区协议恢复批次。',
            409,
            'PROTOCOL_UPGRADE_REQUIRED',
          );
        if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'expectedRevision'))
          throw new BridgeError('恢复请求只接受已核对的正式版本。', 400, 'RESTORE_REQUEST_INVALID');
        json(res, 200, await inboxConsumer.replay(parts[3], body.expectedRevision));
        return true;
      }
      if (parts.length !== 5 || parts[4] !== 'receipt' || !BATCH_ID.test(parts[3]))
        throw new BridgeError('BOSS 回执路径无效。', 400, 'BATCH_INVALID');
      json(res, 200, await bossInbox.acknowledge(parts[3], body));
      return true;
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
    const gitFields = workspaceStore ? ['data', 'sha', 'syncTransactionId'] : ['data', 'sha'];
    if (
      !body ||
      Object.keys(body).some((k) => !gitFields.includes(k)) ||
      !(
        body.sha === null ||
        (typeof body.sha === 'string' && /^[a-f0-9]{40,64}$/.test(body.sha))
      ) ||
      (workspaceStore && typeof body.syncTransactionId !== 'string')
    )
      throw new BridgeError('请求参数无效。', 400);
    let upload = body.data;
    if (workspaceStore)
      upload = await workspaceStore.reserveSyncUpload(body.syncTransactionId, body.data, body.sha);
    try {
      const written = await bridge.write(upload, body.sha);
      const transaction = workspaceStore
        ? await workspaceStore.completeSyncUpload(body.syncTransactionId)
        : null;
      json(res, 200, transaction ? { ...written, ...transaction } : written);
    } catch (error) {
      if (workspaceStore) await workspaceStore.failSyncUpload(body.syncTransactionId);
      throw error;
    }
  } catch (error) {
    const knownError =
      error instanceof BridgeError ||
      error instanceof BackupError ||
      error instanceof WorkspaceStoreError ||
      (isBoss && error instanceof BossInboxError);
    json(res, knownError ? error.status : isBoss ? 500 : 400, {
      message: knownError
        ? error.message
        : isBoss
          ? 'BOSS 队列操作失败，已停止处理；请查看本机故障材料。'
          : isBackup
            ? ['EACCES', 'EPERM'].includes(error.code)
              ? '备份目录没有写入权限，请检查本机目录权限。'
              : error.code === 'ENOSPC'
                ? '磁盘空间不足，请释放空间后重试。'
                : '备份内容校验或磁盘操作失败，请检查数据格式和备份目录。'
            : '数据校验或本地操作失败，已停止同步。',
      code: knownError ? error.code : isBoss ? 'BOSS_INBOX_FAILED' : 'DATA_INVALID',
    });
  }
  return true;
}
