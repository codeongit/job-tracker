import { BossRuntimeError } from './runtime.mjs';
import {
  DETAIL_DECISION_NOT_COMMITTED_CODES,
  normalizeDetailDecisionCommand,
  normalizeExpectedDetailTask,
} from '../../../dist/boss/contracts/detail-decision.js';
import { normalizeDetailRetryJobIds } from '../../../dist/boss/contracts/detail-retry.js';

const ACTIONS = new Set([
  'start',
  'run',
  'backfill',
  'pause',
  'resume',
  'resume-details',
  'retry-details',
  'resolve-detail',
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
  let detailDecisionRequest = false;
  try {
    if (req.method === 'GET') {
      const view = new URL(req.url, 'http://127.0.0.1').searchParams.get('view');
      if (view && !['doctor', 'progress', 'details'].includes(view))
        throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
      if (view === 'details') {
        send(200, { protocolVersion: 1, details: await controller.inspectDetails() });
        return true;
      }
      send(
        200,
        view === 'doctor'
          ? { protocolVersion: 1, doctor: await controller.doctor() }
          : {
              protocolVersion: 1,
              status:
                view !== 'progress' && controller.inspectStatus
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
      if (size > 8192) throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !ACTIONS.has(body.action))
      throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
    if (body.action === 'resolve-detail') {
      detailDecisionRequest = true;
      if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(['action', 'command']))
        throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
      const result = await controller.resolveDetail(normalizeDetailDecisionCommand(body.command));
      send(200, { protocolVersion: 1, ...result });
      return true;
    }
    const retry = body.action === 'retry-details';
    const expected =
      body.expectedTask === undefined ? undefined : normalizeExpectedDetailTask(body.expectedTask);
    if (
      JSON.stringify(Object.keys(body).sort()) !==
      JSON.stringify(
        retry
          ? expected
            ? ['action', 'expectedTask', 'jobIds']
            : ['action', 'jobIds']
          : ['action'],
      )
    )
      throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
    const status = retry
      ? await controller.action(body.action, {
          jobIds: normalizeDetailRetryJobIds(body.jobIds),
          ...(expected ? { expectedTask: expected } : {}),
        })
      : await controller.action(body.action);
    send(200, { protocolVersion: 1, status });
  } catch (error) {
    const known = error instanceof BossRuntimeError || /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code);
    send(known ? 409 : 500, {
      code: known ? error.code : 'BOSS_RUNTIME_FAILED',
      ...(detailDecisionRequest && DETAIL_DECISION_NOT_COMMITTED_CODES.includes(error?.code)
        ? { committed: false }
        : {}),
      message: detailDecisionRequest
        ? DETAIL_DECISION_NOT_COMMITTED_CODES.includes(error?.code)
          ? '请求已拒绝，未保存本次人工决定。'
          : '人工处理结果尚未确认，请保留原请求并刷新核对。'
        : known
          ? '跟踪状态未按请求改变，请查看状态和故障材料。'
          : '跟踪控制失败，现有正式数据和任务页未改动。',
    });
  }
  return true;
}
