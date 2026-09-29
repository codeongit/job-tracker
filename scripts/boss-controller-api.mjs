import { BossRuntimeError } from './boss-runtime.mjs';

const ACTIONS = new Set([
  'start',
  'run',
  'backfill',
  'pause',
  'resume',
  'resume-details',
  'stop',
  'recover-page',
  'recover-saved',
]);

export async function handleBossControllerApi(req, res, { controller }) {
  const send = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  if (req.url.split('?')[0] !== '/__local/boss-runtime') return false;
  if (!controller) {
    send(404, { code: 'BOSS_INTEGRATION_DISABLED', message: 'BOSS 本机接入尚未启用。' });
    return true;
  }
  if (req.headers['x-job-tracker-protocol'] !== '1') {
    send(409, {
      code: 'PROTOCOL_UPGRADE_REQUIRED',
      message: '跟踪控制协议版本不兼容，请更新命令行和本机服务。',
    });
    return true;
  }
  try {
    if (req.method === 'GET') {
      const view = new URL(req.url, 'http://127.0.0.1').searchParams.get('view');
      if (view && view !== 'doctor') throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
      send(
        200,
        view === 'doctor'
          ? { protocolVersion: 1, doctor: await controller.doctor() }
          : {
              protocolVersion: 1,
              status: controller.inspectStatus
                ? await controller.inspectStatus()
                : controller.status(),
            },
      );
      return true;
    }
    if (
      req.method !== 'POST' ||
      req.headers.origin !== `http://${req.headers.host}` ||
      !req.headers['content-type']?.startsWith('application/json')
    ) {
      send(403, {
        code: 'BOSS_RUNTIME_REQUEST_REJECTED',
        message: '跟踪控制只接受本机同源 JSON 请求。',
      });
      return true;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024) throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !ACTIONS.has(body.action)
    )
      throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
    send(200, { protocolVersion: 1, status: await controller.action(body.action) });
  } catch (error) {
    const known = error instanceof BossRuntimeError || /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code);
    send(known ? 409 : 500, {
      code: known ? error.code : 'BOSS_RUNTIME_FAILED',
      message: known
        ? '跟踪状态未按请求改变，请查看状态和故障材料。'
        : '跟踪控制失败，现有正式数据和任务页未改动。',
    });
  }
  return true;
}
