import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../scripts/doctor.mjs';

const APP = '0.10.13';
const PRIVATE = 'Synthetic private error, token and health body';
async function diagnose(status, overrides = {}) {
  const lines = [];
  let reads = 0;
  const result = await runDoctor({
    getStatus: async () => {
      reads++;
      return status;
    },
    command: (name, args, options) => {
      assert.equal(name, 'git');
      assert.deepEqual(args, ['--version']);
      assert.equal(options.encoding, 'utf8');
      return { status: 0, stdout: 'git version 2.50.1\n' };
    },
    nodeVersion: '24.19.0',
    appVersion: APP,
    ...overrides,
    write: (line) => lines.push(line),
  });
  assert.equal(reads, 1);
  assert.equal(lines.join('\n').includes(PRIVATE), false);
  return { ...result, output: lines.join('\n') };
}

test('doctor读取共享服务状态一次，匹配版本及SSH配置均来自已验证状态', async () => {
  const result = await diagnose({
    running: true,
    appVersion: APP,
    sshConfigured: true,
    port: 5321,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /符合支持版本/);
  assert.match(result.output, /git version 2\.50\.1/);
  assert.match(result.output, /本机服务 v0\.10\.13；SSH 配置：已启用/);
  const disabled = await diagnose({ running: true, appVersion: APP, sshConfigured: false });
  assert.equal(disabled.exitCode, 0);
  assert.match(disabled.output, /SSH 配置：未启用/);
  for (const appVersion of ['0.10.14-preview.1', '0.10.14+local.1']) {
    const metadata = await diagnose(
      { running: true, appVersion, sshConfigured: false },
      { appVersion },
    );
    assert.equal(metadata.exitCode, 0);
    assert.ok(metadata.output.includes(`本机服务 v${appVersion}`));
  }
});

test('doctor只在已验证的服务版本不一致时建议重启', async () => {
  const result = await diagnose({ running: true, appVersion: '0.10.12', sshConfigured: null });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /版本不一致，请重启本机服务/);
  assert.match(result.output, /SSH 配置：未知/);
});

test('doctor将缺失或无效服务版本和SSH信息报告为未知，不声称旧版本', async () => {
  for (const appVersion of [undefined, null, '', PRIVATE]) {
    const result = await diagnose({ running: true, appVersion, sshConfigured: PRIVATE });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /本机服务 版本未知；SSH 配置：未知/);
    assert.match(result.output, /无法核对/);
    assert.doesNotMatch(result.output, /旧版本|版本不一致|重启/);
  }
});

test('doctor区分正在启动、明确启动失败、启动退出及缺少启动记录', async () => {
  for (const [status, expected] of [
    [{ running: false, phase: 'starting', code: 'SERVICE_STARTING' }, /正在启动/],
    [
      { running: false, phase: 'failed', code: 'SERVICE_WORKSPACE_INVALID' },
      /启动失败（SERVICE_WORKSPACE_INVALID）/,
    ],
    [{ running: false, phase: 'failed', code: 'SERVICE_START_EXITED' }, /启动进程已退出/],
    [{ running: false, code: 'SERVICE_LAUNCH_UNCONFIRMED' }, /身份尚未确认/],
    [
      {
        running: false,
        starting: true,
        phase: 'starting',
        blocked: true,
        code: 'SERVICE_LAUNCH_UNCONFIRMED',
      },
      /身份尚未确认/,
    ],
    [{ running: false, code: 'SERVICE_NOT_STARTED' }, /未找到本机服务启动记录/],
  ]) {
    const result = await diagnose({ ...status, message: PRIVATE });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, expected);
    assert.doesNotMatch(result.output, /仍是旧版本|请双击/);
  }
});

test('doctor按固定诊断原因解释不可达或身份异常，不打印错误与健康正文', async () => {
  for (const [reason, expected] of [
    ['timeout', /健康检查超时/],
    ['connection_refused', /端口拒绝连接/],
    ['permission_denied', /当前执行上下文无权访问/],
    ['invalid_response', /健康响应无效/],
    ['http_error', /异常 HTTP 状态/],
    ['identity_mismatch', /身份与运行记录不匹配/],
    ['transport_error', /无法完成.*健康检查/],
  ]) {
    const code =
      reason === 'http_error' || reason === 'identity_mismatch'
        ? 'SERVICE_OWNERSHIP_MISMATCH'
        : 'SERVICE_UNAVAILABLE';
    const result = await diagnose({
      running: false,
      code,
      processAlive: true,
      message: PRIVATE,
      error: PRIVATE,
      health: PRIVATE,
      healthCheck: { reason, durationMs: 1501, timeoutMs: 1500, attempts: 1, body: PRIVATE },
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, expected);
    assert.ok(result.output.includes(`${code} / ${reason}`));
    assert.match(result.output, /宿主机终端/);
    assert.doesNotMatch(result.output, /未启动|旧版本|重启|请双击/);
  }
});

test('doctor对未知状态、未知原因及读取异常仅输出固定诊断', async () => {
  for (const status of [
    { running: false, code: PRIVATE, message: PRIVATE },
    { running: false, code: 'SERVICE_UNAVAILABLE', healthCheck: { reason: PRIVATE } },
    { running: false, code: 'SERVICE_OWNERSHIP_MISMATCH' },
    null,
  ]) {
    const result = await diagnose(status);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /宿主机终端/);
    assert.doesNotMatch(result.output, /未启动|旧版本/);
  }
  for (const error of [new Error(PRIVATE), new Error('SERVICE_RUNTIME_INVALID')]) {
    const lines = [];
    let reads = 0;
    const result = await runDoctor({
      getStatus: async () => {
        reads++;
        throw error;
      },
      command: () => ({ status: 0, stdout: 'git version 2.50.1\n' }),
      nodeVersion: '24.19.0',
      appVersion: APP,
      write: (line) => lines.push(line),
    });
    assert.equal(reads, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(lines.join('\n').includes(PRIVATE), false);
    assert.match(lines.join('\n'), /运行记录无效|无法读取本机服务状态/);
  }
});

test('doctor保留Node与Git检查，Git失败不泄露原始错误', async () => {
  const ready = { running: true, appVersion: APP, sshConfigured: false };
  const oldNode = await diagnose(ready, { nodeVersion: '22.18.0' });
  assert.equal(oldNode.exitCode, 1);
  assert.match(oldNode.output, /请使用 Node 24 LTS/);
  const noGit = await diagnose(ready, {
    command: () => ({ status: 1, stderr: PRIVATE, stdout: PRIVATE }),
  });
  assert.equal(noGit.exitCode, 1);
  assert.match(noGit.output, /未找到 Git/);
  const gitThrows = await diagnose(ready, {
    command: () => {
      throw new Error(PRIVATE);
    },
  });
  assert.equal(gitThrows.exitCode, 1);
  assert.match(gitThrows.output, /未找到 Git/);
  const unknownGitVersion = await diagnose(ready, {
    command: () => ({ status: 0, stdout: PRIVATE }),
  });
  assert.equal(unknownGitVersion.exitCode, 0);
  assert.match(unknownGitVersion.output, /Git 已安装，版本未知/);
});
