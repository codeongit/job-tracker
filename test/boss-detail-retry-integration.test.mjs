import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBossController } from '../scripts/boss/control/controller.mjs';
import { BossInbox } from '../scripts/boss/delivery/inbox.mjs';
import { emptyControl, main as integrationMain } from '../scripts/boss/delivery/integration.mjs';
import {
  applyDetailEvidenceV2,
  compareLoadedSnapshotsV2,
} from '../collector/boss/materials/model-v2.mjs';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const BEFORE = '2026-11-05T01:00:00.000Z';
const NOW = '2026-11-05T02:00:00.000Z';
const FIRST = '2026-11-05T01-00-00-000Z_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json';
const SECOND = '2026-11-05T02-00-00-000Z_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json';

function envelopeFixture() {
  return compareLoadedSnapshotsV2(null, {
    capturedAt: BEFORE,
    scope: 'loaded-chat-list',
    accountNamespace: ACCOUNT,
    records: ['job_a', 'job_b'].map((jobId, index) => ({
      platformIdentity: {
        friendId: String(index + 1),
        friendSource: '0',
        uniqueId: `${index + 1}-0`,
      },
      contact: '合成招聘者',
      company: '合成公司',
      title: '招聘',
      preview: '合成消息',
      timeLabel: '09:00',
      unread: null,
      latestMessageId: `message_${index}`,
      outgoingReceipt: { status: 'unknown', label: null, source: null },
      jobAssociation: { jobId, detailUrl: `https://www.zhipin.com/job_detail/${jobId}.html` },
      observedJobName: null,
    })),
    coverage: {
      loadedRows: 2,
      loadedDataRows: 2,
      renderedRows: 2,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  }).envelope;
}

test('定点请求贯通controller票据、integration锁和交付，tracker只取得授权详情目标', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'job-tracker-detail-retry-'));
  let controller;
  t.after(async () => {
    await controller?.stop();
    await rm(root, { recursive: true, force: true });
  });
  const trackerRoot = join(root, 'tracker'),
    dataRoot = join(root, 'data'),
    data = join(dataRoot, 'main');
  await mkdir(trackerRoot);
  await mkdir(data, { recursive: true });
  await writeFile(join(trackerRoot, 'tracker.mjs'), '', { mode: 0o600 });
  const envelope = envelopeFixture(),
    bytes = `${JSON.stringify(envelope)}\n`;
  await writeFile(join(data, FIRST), bytes, { mode: 0o600 });
  const config = { account: 'main', trackerRoot, dataRoot, initialSnapshot: FIRST };
  const inbox = new BossInbox(join(root, 'inbox'));
  await inbox.initialize();
  await inbox.writeControl({
    ...emptyControl(),
    accountNamespace: ACCOUNT,
    checkpoint: {
      snapshotName: FIRST,
      snapshotSha256: createHash('sha256').update(bytes).digest('hex'),
      capturedAt: BEFORE,
      sourceSequence: 2,
    },
  });
  let trackerCalls = 0,
    consumed = 0;
  controller = createBossController({
    config,
    trackerRoot,
    trackerDataRoot: dataRoot,
    inboxRoot: inbox.root,
    workspaceStore: { read: async () => ({ workspace: { workspaceVersion: 3 }, revision: 1 }) },
    inboxConsumer: {
      run: async () => {
        consumed++;
        return { processed: (await inbox.list()).length, waiting: 0, isolated: [] };
      },
    },
    now: () => new Date(NOW),
    runner: async (_node, args, options) => {
      assert.equal(args[1], 'collect-cycle');
      const output = [],
        priorLog = console.log,
        priorExitCode = process.exitCode;
      console.log = (...parts) => output.push(parts.join(' '));
      try {
        await integrationMain(args.slice(1), {
          configReader: async () => config,
          inboxRoot: inbox.root,
          internalAuthorization: options.env.JOB_TRACKER_BOSS_INTERNAL_AUTHORIZATION,
          now: () => new Date(NOW),
          runner: async (_trackerNode, trackerArgs) => {
            trackerCalls++;
            assert.deepEqual(trackerArgs, [
              join(trackerRoot, 'tracker.mjs'),
              'enrich',
              '--account',
              'main',
              '--limit',
              '2',
              '--retry-job-ids',
              'job_a,job_b',
            ]);
            const updated = applyDetailEvidenceV2(
              envelope,
              {
                candidates: [],
                observations: envelope.jobs.associations.map((association, index) => ({
                  ...association,
                  name: `合成岗位${index + 1}`,
                  company: '合成公司',
                  title: `「合成岗位${index + 1}招聘」_合成公司招聘-BOSS直聘`,
                  source: 'detail_page_title',
                  observedAt: NOW,
                })),
              },
              NOW,
            ).envelope;
            await writeFile(join(data, SECOND), `${JSON.stringify(updated)}\n`, { mode: 0o600 });
            return {
              stdout: JSON.stringify({
                ok: true,
                saved: true,
                partial: false,
                file: join(data, SECOND),
                usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 2 },
                detailEnrichment: {
                  status: 'active',
                  pending: 0,
                  deferred: 0,
                  isolated: 0,
                  nextRetryAt: null,
                  lastError: null,
                },
              }),
            };
          },
        });
      } finally {
        console.log = priorLog;
        process.exitCode = priorExitCode;
      }
      assert.equal(output.length, 1);
      return { stdout: output[0] };
    },
  });
  await controller.initialize();
  const status = await controller.action('retry-details', { jobIds: ['job_a', 'job_b'] });
  assert.equal(status.lifecycle, 'stopped');
  assert.equal(status.result.checked, true);
  assert.equal(status.result.partial, false);
  assert.equal(trackerCalls, 1);
  assert.equal(consumed, 1);
  assert.equal(status.budget.navigationUsed, 2);
  assert.equal(status.budget.historyUsed, 0);
  assert.equal(status.detailEnrichment.pending, 0);
  assert.equal((await inbox.readControl()).checkpoint.snapshotName, SECOND);
  assert.deepEqual(await readdir(join(inbox.root, 'controller-authorizations')), []);
  const queued = await inbox.list();
  assert.equal(queued.length, 1);
  const batch = await inbox.read(queued[0].batchId);
  assert.equal(batch.events.length, 2);
});
