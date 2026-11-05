import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { normalizeDetailPolicy } from '../dist/boss/contracts/detail-policy.js';
import { issueBossInternalAuthorization } from '../scripts/boss/control/internal-auth.mjs';
import { emptyControl, main as integrationMain } from '../scripts/boss/delivery/integration.mjs';
import { BossInbox } from '../scripts/boss/delivery/inbox.mjs';
import { main as trackerMain } from '../collector/boss/tracker.mjs';
import { toSnapshot } from '../collector/boss/platform/extract.mjs';
import { compareLoadedSnapshotsV2 } from '../collector/boss/materials/model-v2.mjs';
import { saveEnvelope } from '../collector/boss/persistence/snapshot-save.mjs';
import { saveConnection } from '../collector/boss/persistence/storage.mjs';
import {
  normalizeRuntimeState,
  recordDetailFailure,
  saveRuntimeState,
  loadRuntimeState,
} from '../collector/boss/persistence/runtime-state.mjs';
import { collectDetails } from '../collector/boss/details/detail-phase.mjs';

const BEFORE = '2026-11-01T00:00:00.000Z';
const NOW = '2026-11-05T00:00:00.000Z';
function payload() {
  return {
    ok: true,
    url: 'https://www.zhipin.com/web/geek/chat',
    accountId: '7001',
    capturedAt: BEFORE,
    items: ['job_a', 'job_b', 'job_c'].map((jobId, i) => ({
      friendId: String(101 + i),
      friendSource: '0',
      uniqueId: `${101 + i}-0`,
      contact: '合成联系人',
      company: '合成公司',
      title: '招聘',
      preview: '',
      timeLabel: '09:00',
      latestMessageId: String(201 + i),
      outgoingReceipt: { status: 'unknown', label: null, source: null },
      receiptObservationSource: 'offscreen_unknown',
      rendered: false,
      domIdentityMatches: null,
      encryptJobId: jobId,
      jobName: null,
    })),
    unresolved: [],
    loadedRows: 3,
    loadedDataRows: 3,
    truncated: false,
    unreadCapability: 'unavailable',
    outgoingReceiptCapability: 'rendered_dom_only',
    jobCapability: 'loaded_chat_state',
  };
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'boss-detail-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data'),
    directory = join(dataRoot, 'main');
  await mkdir(directory, { recursive: true });
  const source = payload(),
    envelope = compareLoadedSnapshotsV2(null, toSnapshot(source)).envelope;
  const saved = await saveEnvelope(directory, envelope);
  await saveConnection(directory, {
    version: 2,
    kind: 'cdp_bound',
    session: `boss-tracker-cdp-${'a'.repeat(16)}`,
    browserPort: '19001',
    browserProfile: `boss-tracker-profile-${'a'.repeat(16)}`,
    browserInstanceId: 'b'.repeat(64),
    taskTargetId: 'SYNTHETIC',
    taskTargetCreatedByTask: true,
    page: source.url,
    accountNamespace: envelope.accountNamespace,
    connectedAt: BEFORE,
  });
  let runtime = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  for (let i = 0; i < 4; i++)
    runtime = recordDetailFailure(runtime, {
      jobId: 'job_b',
      error: 'DETAIL_TITLE_NOT_READY',
      stage: 'read',
      at: BEFORE,
    });
  await saveRuntimeState(directory, runtime);
  const inbox = new BossInbox(join(root, 'inbox'));
  await inbox.initialize();
  await inbox.writeControl({
    ...emptyControl(),
    accountNamespace: envelope.accountNamespace,
    checkpoint: {
      snapshotName: basename(saved.file),
      snapshotSha256: createHash('sha256')
        .update(await readFile(saved.file))
        .digest('hex'),
      capturedAt: BEFORE,
      sourceSequence: 3,
    },
  });
  return {
    root,
    dataRoot,
    directory,
    envelope,
    source,
    runtime,
    inbox,
    config: {
      account: 'main',
      trackerRoot: resolve('collector/boss'),
      dataRoot,
      initialSnapshot: basename(saved.file),
    },
  };
}
async function captureOutput(operation) {
  const priorLog = console.log,
    priorExit = process.exitCode,
    output = [];
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await operation();
    return output.at(-1);
  } finally {
    console.log = priorLog;
    process.exitCode = priorExit;
  }
}

for (const mode of ['ordinary', 'retry_stopped', 'wrong_account'])
  test(`精确票据到真实tracker/phase遵守本机详情决定：${mode}`, async (t) => {
    const f = await setup(t),
      visited = [];
    let cdpReads = 0,
      trackerCalls = 0,
      currentUrl;
    const detailPolicy = {
      accountNamespace:
        mode === 'wrong_account' ? `boss-geek:${'b'.repeat(64)}` : f.envelope.accountNamespace,
      excludedJobIds: ['job_a', 'job_b'],
    };
    const retry = mode === 'retry_stopped';
    const request = {
      command: 'collect-cycle',
      historyRequests: 0,
      detailLimit: retry ? 1 : 3,
      domLimit: 0,
      historyMode: 'change',
      ...(retry ? { retryDetailJobIds: ['job_b'] } : {}),
      detailPolicy,
    };
    const ticket = await issueBossInternalAuthorization(f.inbox.root, request, {
      now: () => new Date(NOW),
    });
    const args = [
      'collect-cycle',
      '--history-requests',
      '0',
      '--detail-limit',
      String(request.detailLimit),
      '--dom-limit',
      '0',
      '--history-mode',
      'change',
      ...(retry ? ['--retry-job-ids', 'job_b'] : []),
      '--detail-policy',
      JSON.stringify(detailPolicy),
    ];
    const adapter = {
      async createOwnedTab({ ownerToken, initialUrl }) {
        currentUrl = initialUrl;
        visited.push(initialUrl);
        return { ownerToken, tabId: 'synthetic', windowId: 'synthetic' };
      },
      async readOwnedTab(handle) {
        return {
          ...handle,
          url: currentUrl,
          title: '「合成岗位招聘」_合成公司招聘-BOSS直聘',
          documentReady: true,
        };
      },
      async navigateOwnedTab(_handle, { nextUrl }) {
        currentUrl = nextUrl;
        visited.push(nextUrl);
      },
      async closeOwnedTab() {},
    };
    const previousRoot = process.env.JOB_TRACKER_BOSS_DATA_ROOT;
    process.env.JOB_TRACKER_BOSS_DATA_ROOT = f.dataRoot;
    let output;
    try {
      output = await captureOutput(() =>
        integrationMain(args, {
          configReader: async () => f.config,
          inboxRoot: f.inbox.root,
          internalAuthorization: ticket.token,
          now: () => new Date(NOW),
          runner: async (_node, trackerArgs) => {
            trackerCalls++;
            const report = await captureOutput(() =>
              trackerMain(trackerArgs.slice(1), {
                captureList: async () => {
                  cdpReads++;
                  return { ok: true, payload: { ...f.source, capturedAt: NOW }, report: {} };
                },
                resumeIdentity: async () => {
                  cdpReads++;
                  return { ok: true, report: { identityVerified: true } };
                },
                createDetailAdapter: () => adapter,
                collectDetailPhase: (options) =>
                  collectDetails({ ...options, wait: async () => {}, maxReads: 2, pollMs: 0 }),
              }),
            );
            return { stdout: JSON.stringify(report) };
          },
        }),
      );
    } finally {
      if (previousRoot === undefined) delete process.env.JOB_TRACKER_BOSS_DATA_ROOT;
      else process.env.JOB_TRACKER_BOSS_DATA_ROOT = previousRoot;
    }
    assert.equal(trackerCalls, 1);
    assert.deepEqual((await loadRuntimeState(f.directory)).detail.tasks, f.runtime.detail.tasks);
    if (mode === 'ordinary') {
      assert.equal(output.ok, true);
      assert.equal(output.usage.detailNavigations, 1);
      assert.deepEqual(visited, ['https://www.zhipin.com/job_detail/job_c.html']);
      assert.equal(output.detailEnrichment.pending, 0);
      assert.equal(output.detailEnrichment.isolated, 0);
    } else {
      assert.equal(output.ok, false);
      assert.equal(
        output.error,
        retry ? 'DETAIL_RETRY_TARGETS_INVALID' : 'DETAIL_POLICY_ACCOUNT_MISMATCH',
      );
      assert.equal(cdpReads, 0);
      assert.deepEqual(visited, []);
      assert.equal(output.usage.detailNavigations, 0);
    }
  });

test('停止集合严格校验、复制输入，并受完整UTF8字节上限约束', () => {
  const valid = { accountNamespace: `boss-geek:${'a'.repeat(64)}`, excludedJobIds: ['job_a'] };
  const normalized = normalizeDetailPolicy(valid);
  normalized.excludedJobIds.push('job_b');
  assert.deepEqual(valid.excludedJobIds, ['job_a']);
  for (const value of [
    null,
    { ...valid, extra: true },
    { ...valid, accountNamespace: 'boss-geek:wrong' },
    { ...valid, excludedJobIds: [] },
    { ...valid, excludedJobIds: ['a', 'a'] },
    { ...valid, excludedJobIds: ['a/b'] },
    { ...valid, excludedJobIds: Array.from({ length: 1001 }, (_, i) => `job_${i}`) },
    {
      ...valid,
      excludedJobIds: Array.from({ length: 220 }, (_, i) => `job_${i}`.padEnd(300, 'a')),
    },
  ])
    assert.throws(() => normalizeDetailPolicy(value), { code: 'DETAIL_POLICY_INVALID' });
});

test('停止集合以包含账号身份的完整64000字节为边界', () => {
  const policy = {
    accountNamespace: `boss-geek:${'a'.repeat(64)}`,
    excludedJobIds: [
      ...Array.from({ length: 210 }, (_, i) => `job_${i}`.padEnd(300, 'a')),
      'last'.padEnd(251, 'a'),
    ],
  };
  assert.equal(Buffer.byteLength(JSON.stringify(policy)), 64000);
  assert.deepEqual(normalizeDetailPolicy(policy), policy);
  const tooLarge = {
    ...policy,
    excludedJobIds: [...policy.excludedJobIds.slice(0, -1), 'last'.padEnd(252, 'a')],
  };
  assert.equal(Buffer.byteLength(JSON.stringify(tooLarge)), 64001);
  assert.throws(() => normalizeDetailPolicy(tooLarge), { code: 'DETAIL_POLICY_INVALID' });
});

test('integration在漏传或篡改人工停止集合时拒绝票据且不启动tracker', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boss-detail-policy-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const detailPolicy = {
    accountNamespace: `boss-geek:${'a'.repeat(64)}`,
    excludedJobIds: ['job_a'],
  };
  const request = {
    command: 'collect-cycle',
    historyRequests: 0,
    detailLimit: 1,
    domLimit: 0,
    historyMode: 'change',
    detailPolicy,
  };
  for (const policy of [null, { ...detailPolicy, excludedJobIds: ['job_b'] }]) {
    const ticket = await issueBossInternalAuthorization(root, request, {
      now: () => new Date(NOW),
    });
    await assert.rejects(
      integrationMain(
        [
          'collect-cycle',
          '--history-requests',
          '0',
          '--detail-limit',
          '1',
          '--dom-limit',
          '0',
          '--history-mode',
          'change',
          ...(policy ? ['--detail-policy', JSON.stringify(policy)] : []),
        ],
        {
          inboxRoot: root,
          internalAuthorization: ticket.token,
          now: () => new Date(NOW),
          configReader: async () => assert.fail('unapproved scope cannot read configuration'),
          runner: async () => assert.fail('unapproved scope cannot invoke tracker'),
        },
      ),
      { code: 'BOSS_INTERNAL_AUTH_SCOPE_MISMATCH' },
    );
  }
});
