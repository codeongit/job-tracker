import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { bossInboxClient } from '../dist/boss/client.js';
import { applyImport, emptyData, parseMarkdown, validateData } from '../dist/model.js';
import { applyBossBatch, bindBossAccount } from '../dist/boss/application/integration.js';
import { createBatch, createEvents } from '../scripts/boss/delivery/conversion.mjs';
import { createBossController } from '../scripts/boss/control/controller.mjs';
import { handleBossControllerApi } from '../scripts/boss/control/controller-api.mjs';
import {
  compareLoadedSnapshotsV2,
  conversationKeyV2,
} from '../collector/boss/materials/model-v2.mjs';
import { saveEnvelope } from '../collector/boss/persistence/snapshot-save.mjs';
import {
  normalizeRuntimeState,
  recordDetailFailure,
  saveRuntimeState,
  loadRuntimeState,
} from '../collector/boss/persistence/runtime-state.mjs';

const ACCOUNT = `boss-geek:${'a'.repeat(64)}`;
const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const STAMP = '2026-11-05T04:00:00.000Z';
const JOB_URL = 'https://www.zhipin.com/job_detail/job_a.html';

function envelope(observedJobName = null) {
  return compareLoadedSnapshotsV2(null, {
    capturedAt: STAMP,
    scope: 'loaded-chat-list',
    accountNamespace: ACCOUNT,
    records: [
      {
        key: conversationKeyV2(ACCOUNT, '100', '0'),
        platformIdentity: { friendId: '100', friendSource: '0', uniqueId: '100-0' },
        contact: '合成联系人',
        company: '合成公司',
        title: 'Recruiter',
        preview: '合成消息',
        timeLabel: '',
        unread: null,
        latestMessageId: 'message-100',
        outgoingReceipt: { status: 'unknown', label: null, source: null },
        jobAssociation: { jobId: 'job_a', detailUrl: JOB_URL },
        observedJobName,
      },
    ],
    coverage: {
      loadedRows: 1,
      loadedDataRows: 1,
      renderedRows: 1,
      offscreenRows: 0,
      unresolvedRows: 0,
      truncated: false,
    },
  }).envelope;
}

function autoCreatedData(snapshot) {
  const batch = createBatch({
    envelope: snapshot,
    snapshotName: 'synthetic.json',
    snapshotSha256: 'c'.repeat(64),
    sourceSequence: 1,
    policy: {
      id: 'boss-manual-check-v1',
      mode: 'incremental',
      timezone: 'Asia/Shanghai',
      appliedAtForNew: '',
      autoCreateComplete: true,
    },
    events: createEvents(snapshot, { sourceSequence: 1 }),
  });
  return applyBossBatch(bindBossAccount(emptyData(), ACCOUNT, WORKSPACE, STAMP), batch, {
    workspaceSourceId: WORKSPACE,
    stamp: STAMP,
  }).data;
}

// Exercise the real web client, API, controller and disk store; only HTTP transport,
// the formal workspace read and forbidden platform process are replaced.
async function assertManualCompletion(t, data, snapshot) {
  assert.equal(data.opportunities.length, 1);
  assert.deepEqual(validateData(data), data);
  const opportunityId = data.opportunities[0].id;
  const root = await mkdtemp(join(tmpdir(), 'boss-detail-opportunity-id-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'collector', 'main');
  await mkdir(directory, { recursive: true });
  await saveEnvelope(directory, snapshot);
  let collector = normalizeRuntimeState({
    version: 1,
    cursors: { resume: null, detail: null },
    lastRun: null,
    updatedAt: null,
  });
  for (let i = 0; i < 4; i++)
    collector = recordDetailFailure(collector, {
      jobId: 'job_a',
      error: 'DETAIL_TAB_UNEXPECTED_URL',
      stage: 'read',
      at: STAMP,
    });
  await saveRuntimeState(directory, collector);
  const workspace = { revision: 7, workspaceId: WORKSPACE, workspace: { data, pending: null } };
  const original = structuredClone(workspace);
  let platformCalls = 0;
  const create = () =>
    createBossController({
      config: { account: 'main' },
      trackerDataRoot: join(root, 'collector'),
      inboxRoot: join(root, 'inbox'),
      workspaceStore: { read: async () => structuredClone(workspace) },
      runner: async () => {
        platformCalls++;
        throw Error('platform not allowed');
      },
      now: () => new Date(STAMP),
    });
  let controller = create();
  await controller.initialize();
  const responses = [];
  const client = bossInboxClient('f'.repeat(64), WORKSPACE, async (path, options) => {
    assert.equal(options.headers['X-Job-Tracker-Protocol'], '1');
    const req = Readable.from(options.body ? [Buffer.from(options.body)] : []);
    Object.assign(req, {
      url: path.replace(/^\./, ''),
      method: options.method ?? 'GET',
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
        writeHead: (value) => {
          status = value;
        },
        end: (value) => {
          result = JSON.parse(value);
        },
      },
      { controller },
    );
    responses.push({ status, result });
    return { ok: status === 200, status, json: async () => result };
  });
  const details = await client.details();
  assert.equal(details.items[0].matchingOpportunityId, opportunityId);
  assert.equal(details.items[0].canCompleteWithDetails, true);
  const command = {
    version: 1,
    commandId: '10000000-0000-4000-8000-000000000001',
    expectedRevision: details.revision,
    accountNamespace: ACCOUNT,
    jobId: 'job_a',
    taskVersion: details.items[0].taskVersion,
    reason: 'manual_details',
    opportunityId,
    workspaceRevision: 7,
  };
  const requestCount = responses.length;
  for (const invalidId of ['', null, 42]) {
    await assert.rejects(client.resolveDetail({ ...command, opportunityId: invalidId }), {
      code: 'DETAIL_DECISION_COMMAND_INVALID',
    });
  }
  assert.equal(responses.length, requestCount);
  const completed = await client.resolveDetail(command);
  assert.equal(completed.items[0].status, 'manually_stopped');
  assert.equal(completed.items[0].resolution.opportunityId, opportunityId);
  assert.equal(completed.items[0].resolution.workspaceRevision, 7);
  assert.equal(completed.summary.isolated, 0);
  const saved = JSON.parse(await readFile(join(root, 'inbox', 'tracking.json'), 'utf8'));
  assert.equal(saved.detailDecisions.records[0].reason, 'manual_details');
  assert.equal(saved.detailDecisions.records[0].opportunityId, opportunityId);
  controller = create();
  await controller.initialize();
  const replay = await client.resolveDetail(command);
  assert.equal(replay.revision, 1);
  assert.equal(replay.items[0].resolution.opportunityId, opportunityId);
  assert.equal(responses.at(-1).result.decision.replayed, true);
  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'inbox', 'tracking.json'), 'utf8')).detailDecisions,
    saved.detailDecisions,
  );
  assert.deepEqual((await loadRuntimeState(directory)).detail.tasks, collector.detail.tasks);
  assert.deepEqual(workspace, original);
  assert.equal(platformCalls, 0);
}

test('自动建档的既有岗位 ID 可经网页确认资料完成并在重启后重放', async (t) => {
  const data = autoCreatedData(envelope('合成岗位'));
  assert.match(data.opportunities[0]?.id ?? '', /^boss-auto-/);
  await assertManualCompletion(t, data, envelope());
});

for (const withJobUrl of [true, false]) {
  test(`Markdown 导入的 ${withJobUrl ? 'boss' : 'job 摘要'} ID 可经网页确认资料完成并在重启后重放`, async (t) => {
    const parsed = await parseMarkdown(
      `| 合成公司 | 合成岗位 | ${withJobUrl ? `[岗位](${JOB_URL})` : ''} | BOSS | 1105 | 沟通中 |`,
      '2026',
      'synthetic.md',
    );
    const imported = applyImport(
      emptyData(),
      parsed,
      parsed.rows.map((row) => row.opportunity.id),
    ).data;
    const opportunity = imported.opportunities[0];
    assert.match(opportunity.id, withJobUrl ? /^boss-job_a$/ : /^job-[a-f0-9]{24}$/);
    // A previously imported row may receive its BOSS link later; its original ID stays stable.
    if (!withJobUrl) opportunity.url = JOB_URL;
    const data = bindBossAccount(imported, ACCOUNT, WORKSPACE, STAMP);
    await assertManualCompletion(t, data, envelope());
  });
}
