import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { main } from '../scripts/boss/control/cli.mjs';
import { handleBossControllerApi } from '../scripts/boss/control/controller-api.mjs';
import { normalizeDetailRetryJobIds } from '../dist/boss/contracts/detail-retry.js';

async function apiRequest(body, action = async () => ({ lifecycle: 'stopped' })) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    url: '/__local/boss-runtime',
    method: 'POST',
    headers: {
      host: '127.0.0.1:9180',
      origin: 'http://127.0.0.1:9180',
      'content-type': 'application/json',
      'x-job-tracker-protocol': '1',
    },
  });
  let status, result;
  await handleBossControllerApi(
    req,
    {
      writeHead(value) {
        status = value;
      },
      end(value) {
        result = JSON.parse(value);
      },
    },
    { controller: { action } },
  );
  return { status, result };
}

test('定点详情CLI通过会话API发送唯一明确目标且保持停止', async () => {
  const calls = [],
    outputs = [];
  const priorWrite = process.stdout.write;
  process.stdout.write = function (value, ...args) {
    if (typeof value === 'string' && value.startsWith('{\n')) {
      outputs.push(value);
      return true;
    }
    return priorWrite.call(this, value, ...args);
  };
  try {
    await main(['retry-details', '--job-ids', 'job_a,job~b'], {
      serviceStatus: async () => ({ running: true, port: 9180, instanceId: 'synthetic-instance' }),
      fetcher: async (url, options) => {
        if (url.endsWith('/__local/session'))
          return {
            ok: true,
            json: async () => ({ session: 'a'.repeat(64), instanceId: 'synthetic-instance' }),
          };
        assert.equal(url, 'http://127.0.0.1:9180/__local/boss-runtime');
        assert.equal(options.headers['X-Job-Tracker-Session'], 'a'.repeat(64));
        const { status, result } = await apiRequest(JSON.parse(options.body), async (...args) => {
          calls.push(args);
          return { lifecycle: 'stopped' };
        });
        return { ok: status === 200, json: async () => result };
      },
    });
  } finally {
    process.stdout.write = priorWrite;
  }
  assert.deepEqual(calls, [['retry-details', { jobIds: ['job_a', 'job~b'] }]]);
  assert.equal(JSON.parse(outputs.join('')).status.lifecycle, 'stopped');
});

test('定点目标规范化拒绝空值、重复、非法身份并返回独立副本', () => {
  const ids = ['job_a', 'job~b'];
  const result = normalizeDetailRetryJobIds(ids);
  assert.deepEqual(result, ids);
  result.push('job_c');
  assert.deepEqual(ids, ['job_a', 'job~b']);
  for (const value of [
    null,
    {},
    'job_a',
    [],
    [1],
    [''],
    ['job_a', 'job_a'],
    [' job_a'],
    ['a'.repeat(301)],
    Array(2),
    Array.from({ length: 21 }, (_, i) => `job_${i}`),
  ])
    assert.throws(() => normalizeDetailRetryJobIds(value), {
      code: 'DETAIL_RETRY_TARGETS_INVALID',
    });
});

test('定点API只接受固定动作参数并支持20个最大长度岗位ID', async () => {
  let calls = 0;
  const action = async () => {
    calls++;
    return { lifecycle: 'stopped' };
  };
  for (const body of [
    { action: 'run', jobIds: ['job_a'] },
    { action: 'retry-details' },
    { action: 'retry-details', jobIds: ['job_a'], extra: true },
    { action: 'retry-details', jobIds: ['job_a', 'job_a'] },
    { action: 'retry-details', jobIds: [] },
    { action: 'retry-details', jobIds: ['job_a'], padding: 'x'.repeat(8192) },
  ]) {
    const response = await apiRequest(body, action);
    assert.equal(response.status, 409);
  }
  assert.equal(calls, 0);
  const jobIds = Array.from({ length: 20 }, (_, i) => String(i).padEnd(300, 'a'));
  const response = await apiRequest({ action: 'retry-details', jobIds }, async (name, options) => {
    assert.equal(name, 'retry-details');
    assert.deepEqual(options, { jobIds });
    calls++;
    return { lifecycle: 'stopped' };
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const legacy = await apiRequest({ action: 'run' }, async (...args) => {
    assert.deepEqual(args, ['run']);
    return { lifecycle: 'stopped' };
  });
  assert.equal(legacy.status, 200);
});

test('非法定点CLI参数在读取服务或发送请求前拒绝', async () => {
  let reads = 0;
  const options = {
    serviceStatus: async () => {
      reads++;
      throw new Error('UNEXPECTED_SERVICE_READ');
    },
  };
  for (const argv of [
    ['retry-details'],
    ['retry-details', '--job-ids', 'job_a,job_a'],
    ['retry-details', '--job-ids', ''],
    ['retry-details', '--job-id', 'job_a'],
    ['run', '--job-ids', 'job_a'],
  ])
    await assert.rejects(() => main(argv, options));
  assert.equal(reads, 0);
});
