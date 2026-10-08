import { MAX_BACKUP_BYTES } from '../dist/limits.js';
import { WorkspaceStoreError } from './workspace-store.mjs';

const PUBLIC_WORKSPACE_COMMANDS = new Set([
  'import_workspace',
  'edit_data',
  'set_sync_config',
  'stage_sync_conflict',
  'resolve_sync_conflict',
  'restore_workspace',
  'acknowledge_sync',
  'bind_boss_account',
  'correct_boss_resume_request',
  'reject_boss_resume_observation',
  'correct_boss_resume_semantics',
  'ignore_boss_observations',
  'resolve_boss_job_details',
  'set_boss_job_state',
]);

export async function handleWorkspaceApi(
  req,
  res,
  { workspaceStore, shutdown, instanceId, controlToken },
) {
  const path = req.url.split('?')[0];
  const send = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  if (
    !['/__local/workspace', '/__local/workspace/commands', '/__local/service/stop'].includes(path)
  )
    return false;
  if (req.headers['x-job-tracker-protocol'] !== '1') {
    send(409, {
      code: 'PROTOCOL_UPGRADE_REQUIRED',
      message: '工作台协议版本不兼容，请更新页面后重试。',
    });
    return true;
  }
  try {
    if (path === '/__local/workspace' && req.method === 'GET') {
      send(200, await workspaceStore.read());
      return true;
    }
    if (
      req.method !== 'POST' ||
      req.headers.origin !== `http://${req.headers.host}` ||
      !req.headers['content-type']?.startsWith('application/json')
    ) {
      send(403, { code: 'WORKSPACE_REQUEST_REJECTED', message: '修改仅接受同源 JSON POST。' });
      return true;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BACKUP_BYTES * 3)
        throw new WorkspaceStoreError('WORKSPACE_TOO_LARGE', '工作区请求过大。', 413);
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new WorkspaceStoreError('WORKSPACE_INVALID', '工作区请求 JSON 无效。', 400);
    }
    if (path === '/__local/service/stop') {
      if (
        !shutdown ||
        body?.instanceId !== instanceId ||
        body?.controlToken !== controlToken ||
        Object.keys(body).some((key) => !['instanceId', 'controlToken'].includes(key))
      )
        throw new WorkspaceStoreError(
          'SERVICE_OWNERSHIP_MISMATCH',
          '服务实例身份不匹配，未停止任何进程。',
          403,
        );
      send(200, { stopping: true, instanceId });
      setImmediate(() => void shutdown());
      return true;
    }
    if (path !== '/__local/workspace/commands')
      throw new WorkspaceStoreError('WORKSPACE_ROUTE_INVALID', '工作区路径不支持。', 404);
    if (!PUBLIC_WORKSPACE_COMMANDS.has(body?.type))
      throw new WorkspaceStoreError(
        'WORKSPACE_COMMAND_INVALID',
        '网页只能提交固定的工作区业务命令。',
        400,
      );
    send(200, await workspaceStore.execute(body));
  } catch (error) {
    const known = error instanceof WorkspaceStoreError;
    send(known ? error.status : 500, {
      code: known ? error.code : 'WORKSPACE_OPERATION_FAILED',
      message: known ? error.message : '工作区校验或持久化失败，原有正式记录已保留。',
    });
  }
  return true;
}
