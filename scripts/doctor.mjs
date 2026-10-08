import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../dist/version.js';
import { serviceStatus } from './service-control.mjs';
import { SERVICE_FAILURE_CODES } from './service-runtime.mjs';

const HEALTH_MESSAGES = new Map([
  ['timeout', '本机服务健康检查超时'],
  ['connection_refused', '本机服务端口拒绝连接'],
  ['permission_denied', '当前执行上下文无权访问本机服务'],
  ['invalid_response', '本机服务健康响应无效'],
  ['http_error', '本机服务健康检查返回异常 HTTP 状态'],
  ['identity_mismatch', '本机服务身份与运行记录不匹配'],
  ['transport_error', '当前执行上下文无法完成本机服务健康检查'],
]);
const version = (value) =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : null;

function unavailableMessage(status) {
  const reason = status.healthCheck?.reason;
  const description =
    HEALTH_MESSAGES.get(reason) ||
    (status.code === 'SERVICE_OWNERSHIP_MISMATCH'
      ? '本机服务身份或健康响应不匹配'
      : '当前执行上下文未确认本机服务可达');
  const details = HEALTH_MESSAGES.has(reason) ? `${status.code} / ${reason}` : status.code;
  return `${description}（${details}）。请在宿主机终端运行 pnpm service status 核对。`;
}

export async function runDoctor({
  getStatus = serviceStatus,
  command = spawnSync,
  nodeVersion = process.versions.node,
  appVersion = APP_VERSION,
  write = console.log,
} = {}) {
  let exitCode = 0;
  const supportedNode = version(nodeVersion)?.split('.')[0] === '24';
  write(
    `工作台 ${version(appVersion) ? `v${appVersion}` : '版本未知'}；Node ${version(nodeVersion) || '版本未知'}：${supportedNode ? '符合支持版本' : '请使用 Node 24 LTS'}`,
  );
  if (!supportedNode) exitCode = 1;
  let git;
  try {
    git = command('git', ['--version'], { encoding: 'utf8' });
  } catch {
    git = null;
  }
  const gitVersion =
    typeof git?.stdout === 'string' ? /^git version (\d+\.\d+(?:\.\d+)?)/.exec(git.stdout) : null;
  write(
    git?.status === 0
      ? gitVersion
        ? `git version ${gitVersion[1]}`
        : 'Git 已安装，版本未知。'
      : '未找到 Git，本机 SSH 同步需要安装 Git。',
  );
  if (git?.status !== 0) exitCode = 1;
  try {
    const status = await getStatus();
    if (status?.running) {
      const serviceVersion = version(status.appVersion);
      const ssh =
        status.sshConfigured === true
          ? '已启用'
          : status.sshConfigured === false
            ? '未启用'
            : '未知';
      write(`本机服务 ${serviceVersion ? `v${serviceVersion}` : '版本未知'}；SSH 配置：${ssh}`);
      if (!serviceVersion) {
        write('无法核对本机服务与工作台的版本是否一致。');
        exitCode = 1;
      } else if (serviceVersion !== appVersion) {
        write('本机服务与工作台版本不一致，请重启本机服务并刷新页面。');
        exitCode = 1;
      }
    } else {
      exitCode = 1;
      if (status?.code === 'SERVICE_LAUNCH_UNCONFIRMED') {
        write(
          '本机服务启动进程身份尚未确认（SERVICE_LAUNCH_UNCONFIRMED），请保留启动记录并核对状态。',
        );
      } else if (status?.starting || status?.phase === 'starting') {
        write('本机服务正在启动，请稍后运行 pnpm service status。');
      } else if (status?.code === 'SERVICE_NOT_STARTED') {
        write(
          '未找到本机服务启动记录（SERVICE_NOT_STARTED），请在宿主机终端核对 pnpm service status。',
        );
      } else if (['SERVICE_UNAVAILABLE', 'SERVICE_OWNERSHIP_MISMATCH'].includes(status?.code)) {
        write(unavailableMessage(status));
      } else if (SERVICE_FAILURE_CODES.has(status?.code)) {
        write(`本机服务启动失败（${status.code}），请在宿主机终端核对状态及私有服务日志。`);
      } else if (status?.code === 'SERVICE_START_EXITED') {
        write('本机服务启动进程已退出（SERVICE_START_EXITED），请核对私有服务日志。');
      } else {
        write('无法确认本机服务状态，请在宿主机终端运行 pnpm service status 核对。');
      }
    }
  } catch (error) {
    exitCode = 1;
    if (error?.code === 'SERVICE_RUNTIME_INVALID' || error?.message === 'SERVICE_RUNTIME_INVALID') {
      write('本机服务运行记录无效（SERVICE_RUNTIME_INVALID），请保留原记录并在宿主机终端核对。');
    } else {
      write('无法读取本机服务状态，请在宿主机终端运行 pnpm service status 核对。');
    }
  }
  return { exitCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runDoctor();
  process.exitCode = result.exitCode;
}
