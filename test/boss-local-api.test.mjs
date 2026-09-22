import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLocalApi } from '../scripts/local-api.mjs';

const SECRET = 'f'.repeat(64);
const BATCH_ID = `boss-batch-${'a'.repeat(64)}`;
const SOURCE_ID = '00000000-0000-4000-8000-000000000001';

function request(path, { method = 'GET', headers = {}, body = '' } = {}) {
  return {
    url: path,
    method,
    headers: { host: '127.0.0.1:4317', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

function response() {
  const output = { status: 0, value: null };
  return {
    output,
    writeHead(status) {
      output.status = status;
    },
    end(body) {
      output.value = body ? JSON.parse(body) : null;
    },
  };
}

async function call(path, { bossInbox, bossController, inboxConsumer, ...options } = {}) {
  const res = response();
  const handled = await handleLocalApi(request(path, options), res, {
    port: 4317,
    secret: SECRET,
    bridge: null,
    target: null,
    backups: null,
    bossInbox,
    bossController,
    inboxConsumer,
  });
  return { handled, ...res.output };
}

test('BOSS 队列接口沿用 loopback Host、Origin 与随机会话边界', async () => {
  const bossInbox = { status: async () => ({}), list: async () => [] };
  const noSession = await call('/__local/boss-inbox', { bossInbox });
  assert.equal(noSession.status, 403);
  const wrongHost = await call('/__local/boss-inbox', {
    bossInbox,
    headers: { host: 'evil.invalid:4317', 'x-job-tracker-session': SECRET },
  });
  assert.equal(wrongHost.status, 403);
  const wrongOrigin = await call('/__local/boss-inbox', {
    bossInbox,
    headers: { origin: 'http://evil.invalid:4317', 'x-job-tracker-session': SECRET },
  });
  assert.equal(wrongOrigin.status, 403);
  const valid = await call(`/__local/boss-inbox?workspaceSourceId=${SOURCE_ID}`, {
    bossInbox,
    bossController: { status: () => ({ lifecycle: 'running', detailEnrichment: { pending: 3 } }) },
    headers: { 'x-job-tracker-session': SECRET },
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.value.batches, []);
  assert.equal(valid.value.tracking.detailEnrichment.pending, 3);
});

test('服务恢复缺口可只读查看，显式重放要求会话、同源、协议和固定版本参数', async () => {
  let replays = 0;
  const bossInbox = { status: async () => ({}), list: async () => [] };
  const inboxConsumer = {
    inspect: async () => ({ revision: 8, restoreReview: [{ batchId: BATCH_ID, missing: 1 }] }),
    replay: async (batchId, expectedRevision) => {
      assert.equal(batchId, BATCH_ID);
      assert.equal(expectedRevision, 8);
      replays++;
      return { revision: 9 };
    },
  };
  const headers = {
    'x-job-tracker-session': SECRET,
    'x-job-tracker-protocol': '1',
    origin: 'http://127.0.0.1:4317',
    'content-type': 'application/json',
  };
  const index = await call('/__local/boss-inbox', { bossInbox, inboxConsumer, headers });
  assert.equal(index.value.recovery.restoreReview.length, 1);
  const options = {
    bossInbox,
    inboxConsumer,
    method: 'PUT',
    headers,
    body: JSON.stringify({ expectedRevision: 8 }),
  };
  assert.equal(
    (
      await call(`/__local/boss-inbox/${BATCH_ID}/replay`, {
        ...options,
        headers: { ...headers, 'x-job-tracker-protocol': undefined },
      })
    ).status,
    409,
  );
  assert.equal(replays, 0);
  assert.equal(
    (
      await call(`/__local/boss-inbox/${BATCH_ID}/replay`, {
        ...options,
        body: JSON.stringify({ expectedRevision: 8, workspace: {} }),
      })
    ).status,
    400,
  );
  assert.equal((await call(`/__local/boss-inbox/${BATCH_ID}/replay`, options)).status, 200);
  assert.equal(replays, 1);
});

test('只有固定路径和同源 JSON PUT 能写入处理回执', async () => {
  let saved = 0;
  const bossInbox = { acknowledge: async () => ({ saved: ++saved }) };
  const requestOptions = {
    bossInbox,
    method: 'PUT',
    headers: {
      origin: 'http://127.0.0.1:4317',
      'content-type': 'application/json',
      'x-job-tracker-session': SECRET,
    },
    body: '{}',
  };
  const invalidPath = await call(`/__local/boss-inbox/${BATCH_ID}/extra`, requestOptions);
  assert.equal(invalidPath.status, 400);
  assert.equal(saved, 0);
  const absentOrigin = await call(`/__local/boss-inbox/${BATCH_ID}/receipt`, {
    ...requestOptions,
    headers: { ...requestOptions.headers, origin: undefined },
  });
  assert.equal(absentOrigin.status, 403);
  assert.equal(saved, 0);
  const accepted = await call(`/__local/boss-inbox/${BATCH_ID}/receipt`, requestOptions);
  assert.equal(accepted.status, 200);
  assert.equal(saved, 1);
});

test('未知本机错误不会向网页暴露私有路径或异常正文', async () => {
  const bossInbox = {
    read: async () => {
      throw new Error('private path /Users/example/.local/secret.json and private JSON content');
    },
  };
  const result = await call(`/__local/boss-inbox/${BATCH_ID}`, {
    bossInbox,
    headers: { 'x-job-tracker-session': SECRET },
  });
  assert.equal(result.status, 500);
  assert.equal(result.value.code, 'BOSS_INBOX_FAILED');
  assert.doesNotMatch(JSON.stringify(result.value), /\.local|secret\.json|private JSON/);
});

test('跟踪控制接口与队列共用会话边界，只接受固定动作和同源 JSON', async () => {
  const actions = [];
  const bossController = {
    status: () => ({ lifecycle: 'stopped' }),
    doctor: async () => ({ diagnostics: { collector: { ok: true } } }),
    action: async (action) => {
      actions.push(action);
      return { lifecycle: action === 'start' ? 'running' : 'stopped' };
    },
  };
  const headers = {
    'x-job-tracker-session': SECRET,
    'x-job-tracker-protocol': '1',
  };
  const status = await call('/__local/boss-runtime', { bossController, headers });
  assert.equal(status.status, 200);
  assert.equal(status.value.status.lifecycle, 'stopped');
  const doctor = await call('/__local/boss-runtime?view=doctor', { bossController, headers });
  assert.equal(doctor.status, 200);
  assert.equal(doctor.value.doctor.diagnostics.collector.ok, true);
  const missingProtocol = await call('/__local/boss-runtime', {
    bossController,
    headers: { 'x-job-tracker-session': SECRET },
  });
  assert.equal(missingProtocol.status, 409);
  const rejected = await call('/__local/boss-runtime', {
    bossController,
    method: 'POST',
    headers: {
      ...headers,
      origin: 'http://evil.invalid:4317',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'start' }),
  });
  assert.equal(rejected.status, 403);
  assert.deepEqual(actions, []);
  const accepted = await call('/__local/boss-runtime', {
    bossController,
    method: 'POST',
    headers: {
      ...headers,
      origin: 'http://127.0.0.1:4317',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'start' }),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(actions, ['start']);
  const recovered = await call('/__local/boss-runtime', {
    bossController,
    method: 'POST',
    headers: {
      ...headers,
      origin: 'http://127.0.0.1:4317',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'recover-saved' }),
  });
  assert.equal(recovered.status, 200);
  assert.deepEqual(actions, ['start', 'recover-saved']);
});

test('跟踪控制错误只返回稳定错误码，不暴露采集器路径或正文', async () => {
  const bossController = {
    status: () => ({ lifecycle: 'paused' }),
    action: async () => {
      const error = new Error('/Users/private/browser profile has personal content');
      error.code = 'BOSS_LOGIN_REQUIRED';
      throw error;
    },
  };
  const result = await call('/__local/boss-runtime', {
    bossController,
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:4317',
      'content-type': 'application/json',
      'x-job-tracker-session': SECRET,
      'x-job-tracker-protocol': '1',
    },
    body: JSON.stringify({ action: 'resume' }),
  });
  assert.equal(result.status, 409);
  assert.equal(result.value.code, 'BOSS_LOGIN_REQUIRED');
  assert.doesNotMatch(JSON.stringify(result.value), /Users|private|personal|profile/);
});
