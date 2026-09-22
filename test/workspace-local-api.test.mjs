import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLocalApi } from '../scripts/local-api.mjs';

const SECRET = 'f'.repeat(64);
async function call(
  path,
  {
    method = 'GET',
    headers = {},
    body = {},
    store = { read: async () => ({ revision: 0 }), execute: async () => ({ revision: 1 }) },
    shutdown,
  } = {},
) {
  const result = {};
  const req = {
    url: path,
    method,
    headers: {
      host: '127.0.0.1:4317',
      'x-job-tracker-session': SECRET,
      'x-job-tracker-protocol': '1',
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    writeHead(status) {
      result.status = status;
    },
    end(text) {
      result.body = JSON.parse(text);
    },
  };
  await handleLocalApi(req, res, {
    port: 4317,
    secret: SECRET,
    workspaceStore: store,
    instanceId: 'synthetic-instance',
    controlToken: 'synthetic-control',
    shutdown,
  });
  return result;
}
test('正式工作区读取要求session和协议，写入要求同源固定POST入口', async () => {
  assert.equal((await call('/__local/workspace')).status, 200);
  assert.equal(
    (await call('/__local/workspace', { headers: { 'x-job-tracker-session': '' } })).status,
    403,
  );
  assert.equal(
    (await call('/__local/workspace', { headers: { 'x-job-tracker-protocol': undefined } })).body
      .code,
    'PROTOCOL_UPGRADE_REQUIRED',
  );
  assert.equal(
    (await call('/__local/workspace', { headers: { origin: 'http://untrusted.invalid' } })).status,
    403,
  );
  const write = {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' },
    body: { type: 'edit_data' },
  };
  assert.equal((await call('/__local/workspace/commands', write)).body.revision, 1);
  assert.equal(
    (await call('/__local/workspace/commands', { ...write, method: 'PUT' })).status,
    403,
  );
  assert.equal((await call('/__local/workspace/extra', write)).status, 404);
  const fullOverwrite = await call('/__local/workspace/commands', {
    ...write,
    body: { type: 'commit_workspace' },
  });
  assert.equal(fullOverwrite.status, 400);
  assert.equal(fullOverwrite.body.code, 'WORKSPACE_COMMAND_INVALID');
});
test('工作区内部错误不暴露路径或正文，session发现报告本机权威存储能力', async () => {
  const error = await call('/__local/workspace', {
    store: {
      read: async () => {
        throw new Error('secret personal data /private/name');
      },
    },
  });
  assert.equal(error.body.code, 'WORKSPACE_OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(error), /personal|private/);
  const session = await call('/__local/session');
  assert.equal(session.body.localWorkspaceEnabled, true);
  assert.equal(session.body.protocolVersion, 1);
});
test('停止服务只接受当前实例私有控制标识，绝不按PID杀进程', async () => {
  let stops = 0;
  const options = {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' },
    shutdown: async () => {
      stops++;
    },
  };
  const rejected = await call('/__local/service/stop', {
    ...options,
    body: { instanceId: 'wrong', controlToken: 'synthetic-control' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(stops, 0);
  const accepted = await call('/__local/service/stop', {
    ...options,
    body: { instanceId: 'synthetic-instance', controlToken: 'synthetic-control' },
  });
  assert.equal(accepted.body.stopping, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
});
