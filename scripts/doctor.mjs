import { spawnSync } from 'node:child_process';
import { APP_VERSION } from '../dist/version.js';
const major = Number(process.versions.node.split('.')[0]);
console.log(
  `工作台 v${APP_VERSION}；Node ${process.versions.node}：${major === 24 ? '符合支持版本' : '请使用 Node 24 LTS'}`,
);
const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
console.log(git.status === 0 ? git.stdout.trim() : '未找到 Git，本机 SSH 同步需要安装 Git。');
try {
  const response = await fetch('http://127.0.0.1:4317/__local/health', {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error('服务未提供健康检查，请重启工作台。');
  const health = await response.json();
  console.log(
    `本机服务 v${health.appVersion}；SSH 配置：${health.sshConfigured ? '已启用' : '未启用'}`,
  );
  if (health.appVersion !== APP_VERSION) process.exitCode = 1;
} catch {
  console.log('本机服务未启动或仍是旧版本。请双击“启动.command”后重试。');
  process.exitCode = 1;
}
if (major !== 24 || git.status !== 0) process.exitCode = 1;
