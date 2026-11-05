import assert from 'node:assert/strict';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  consumeBossInternalAuthorization,
  issueBossInternalAuthorization,
  revokeBossInternalAuthorization,
} from '../scripts/boss/control/internal-auth.mjs';

const REQUEST = {
  command: 'collect-cycle',
  historyRequests: 20,
  detailLimit: 20,
  domLimit: 1,
  historyMode: 'change',
};
const START = new Date('2026-09-22T00:00:00.000Z');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-boss-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('内部采集授权是0600短时票据并且只能原子消费一次', async (t) => {
  const root = await fixture(t);
  const authorization = await issueBossInternalAuthorization(root, REQUEST, { now: () => START });
  const directory = join(root, 'controller-authorizations'),
    path = join(directory, `${authorization.token}.json`);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const results = await Promise.allSettled([
    consumeBossInternalAuthorization(root, authorization.token, REQUEST, { now: () => START }),
    consumeBossInternalAuthorization(root, authorization.token, REQUEST, { now: () => START }),
  ]);
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter((row) => row.status === 'rejected').length, 1);
  assert.deepEqual(await readdir(directory), []);
});

test('授权与动作额度严格绑定，错配尝试也会消耗票据', async (t) => {
  const root = await fixture(t);
  const authorization = await issueBossInternalAuthorization(root, REQUEST, { now: () => START });
  await assert.rejects(
    consumeBossInternalAuthorization(
      root,
      authorization.token,
      { ...REQUEST, detailLimit: 19 },
      { now: () => START },
    ),
    { code: 'BOSS_INTERNAL_AUTH_SCOPE_MISMATCH' },
  );
  await assert.rejects(
    consumeBossInternalAuthorization(root, authorization.token, REQUEST, { now: () => START }),
    { code: 'BOSS_INTERNAL_AUTH_REQUIRED' },
  );
});

test('详情授权拒绝超过每轮上限的请求', async (t) => {
  const root = await fixture(t);
  await assert.rejects(issueBossInternalAuthorization(root, { ...REQUEST, detailLimit: 21 }), {
    code: 'BOSS_INTERNAL_AUTH_INVALID',
  });
});

test('过期授权拒绝且清理，未使用授权可由controller撤销', async (t) => {
  const root = await fixture(t);
  const expired = await issueBossInternalAuthorization(root, REQUEST, {
    now: () => START,
    ttlMs: 1_000,
  });
  await assert.rejects(
    consumeBossInternalAuthorization(root, expired.token, REQUEST, {
      now: () => new Date(START.getTime() + 1_001),
    }),
    { code: 'BOSS_INTERNAL_AUTH_EXPIRED' },
  );
  const revoked = await issueBossInternalAuthorization(root, REQUEST, { now: () => START });
  await revokeBossInternalAuthorization(root, revoked.token);
  await assert.rejects(
    consumeBossInternalAuthorization(root, revoked.token, REQUEST, { now: () => START }),
    { code: 'BOSS_INTERNAL_AUTH_REQUIRED' },
  );
});

test('定点详情票据绑定完整目标列表，不能借票据重试其他岗位', async (t) => {
  const root = await fixture(t);
  const request = {
    ...REQUEST,
    historyRequests: 0,
    detailLimit: 2,
    domLimit: 0,
    retryDetailJobIds: ['job_a', 'job_b'],
  };
  const authorization = await issueBossInternalAuthorization(root, request, { now: () => START });
  await assert.rejects(
    consumeBossInternalAuthorization(
      root,
      authorization.token,
      { ...request, retryDetailJobIds: ['job_a', 'job_other'] },
      { now: () => START },
    ),
    { code: 'BOSS_INTERNAL_AUTH_SCOPE_MISMATCH' },
  );
  const valid = await issueBossInternalAuthorization(root, request, { now: () => START });
  const consumed = await consumeBossInternalAuthorization(root, valid.token, request, {
    now: () => START,
  });
  assert.deepEqual(consumed.request.retryDetailJobIds, ['job_a', 'job_b']);
});

test('定点票据拒绝额外平台范围或错配数量并支持最大合法请求', async (t) => {
  const root = await fixture(t);
  const request = {
    ...REQUEST,
    historyRequests: 0,
    domLimit: 0,
    detailLimit: 2,
    retryDetailJobIds: ['job_a', 'job_b'],
  };
  for (const patch of [
    { historyRequests: 1 },
    { domLimit: 1 },
    { historyMode: 'backfill' },
    { detailLimit: 1 },
    { retryDetailJobIds: ['job_a', 'job_a'] },
  ])
    await assert.rejects(issueBossInternalAuthorization(root, { ...request, ...patch }), {
      code: 'BOSS_INTERNAL_AUTH_INVALID',
    });
  const maximum = {
    ...request,
    detailLimit: 20,
    retryDetailJobIds: Array.from({ length: 20 }, (_, i) => String(i).padEnd(300, 'a')),
  };
  const ticket = await issueBossInternalAuthorization(root, maximum, { now: () => START });
  const consumed = await consumeBossInternalAuthorization(root, ticket.token, maximum, {
    now: () => START,
  });
  assert.deepEqual(consumed.request, maximum);
});
