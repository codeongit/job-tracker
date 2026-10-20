import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyDetailEvidenceV2,
  canonicalJobUrlV2,
  compareLoadedSnapshotsV2,
  conversationKeyV2,
  resolveJobRowsV2,
} from '../collector/boss/materials/model-v2.mjs';
import {
  compactJobEvidenceHistory,
  compactSnapshotJobEvidenceHistory,
} from '../collector/boss/materials/job-evidence-history.mjs';
import { commit, latest } from '../collector/boss/persistence/storage.mjs';
import { saveEnvelope } from '../collector/boss/persistence/snapshot-save.mjs';
import { readTrackerSnapshot } from '../scripts/boss/delivery/snapshots.mjs';
import { resolveBossJobEvidence } from '../dist/boss/rules/job-evidence.js';
import { BOSS_SNAPSHOT_MAX_BYTES } from '../dist/boss/contracts/snapshot-format.js';
import { emptyData } from '../dist/model.js';
import { applyBossBatch, bindBossAccount } from '../dist/boss/application/integration.js';
import {
  createDatedYesterdayBatch,
  createInitialBatch,
} from '../scripts/boss/delivery/legacy-import.mjs';
import { createResumeBatch } from '../scripts/boss/delivery/conversion.mjs';
import {
  applyResumeHistoryV2,
  toResumeHistoryResult,
} from '../collector/boss/history/resume-history.mjs';

const namespace = `boss-geek:${'e'.repeat(64)}`;
const at = (minute) => `2026-10-20T10:${String(minute).padStart(2, '0')}:00.000Z`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const savedName = '2026-10-20T10-04-00-000Z_00000000-0000-4000-8000-000000000001.json';
const sourceId = '00000000-0000-4000-8000-000000000002';

function row(index, overrides = {}) {
  const friendId = `friend-${index}`;
  const jobId = `job-${index}`;
  return {
    key: conversationKeyV2(namespace, friendId, '1'),
    platformIdentity: { friendId, friendSource: '1', uniqueId: `${friendId}-1` },
    contact: `合成联系人${index}`,
    company: `合成公司${index}`,
    title: '招聘者',
    preview: '合成消息摘要',
    timeLabel: '10:00',
    unread: null,
    latestMessageId: `message-${index}`,
    outgoingReceipt: { status: 'unknown', label: null, source: null },
    jobAssociation: { jobId, detailUrl: canonicalJobUrlV2(jobId) },
    observedJobName: '合成工程师',
    ...overrides,
  };
}

function snapshot(records, minute) {
  return {
    capturedAt: at(minute),
    scope: 'loaded-chat-list',
    accountNamespace: namespace,
    records,
    coverage: {
      loadedRows: records.length,
      loadedDataRows: records.length,
      unresolvedRows: 0,
      renderedRows: records.length,
      offscreenRows: 0,
      truncated: false,
    },
  };
}

test('unchanged loaded job names retain their first and latest observations across repeated rounds', () => {
  const records = Array.from({ length: 8 }, (_, index) => row(index));
  let envelope = null;
  for (let minute = 0; minute < 5; minute += 1) {
    envelope = compareLoadedSnapshotsV2(envelope, snapshot(records, minute)).envelope;
  }
  assert.equal(envelope.jobs.evidence.length, 16);
  for (const record of records) {
    assert.deepEqual(
      envelope.jobs.evidence
        .filter((evidence) => evidence.conversationKey === record.key)
        .map((evidence) => evidence.observedAt)
        .sort(),
      [at(0), at(4)],
    );
  }
});

test('repeated A and B job names preserve every transition, including a return to an earlier name', () => {
  let envelope = null;
  const names = ['A', 'A', 'B', 'B', 'A', 'A', 'B', 'A'];
  for (const [minute, observedJobName] of names.entries()) {
    envelope = compareLoadedSnapshotsV2(
      envelope,
      snapshot([row(0, { observedJobName })], minute),
    ).envelope;
  }
  assert.deepEqual(
    [...envelope.jobs.evidence]
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
      .map((evidence) => [evidence.name, evidence.observedAt]),
    names.map((name, minute) => [name, at(minute)]),
  );
});

function evidence(index, overrides = {}) {
  return {
    id: `synthetic-evidence-${index}`,
    conversationKey: 'synthetic-conversation-a',
    jobId: 'synthetic-job-a',
    detailUrl: canonicalJobUrlV2('synthetic-job-a'),
    source: 'loaded_jobName',
    name: '合成工程师',
    company: '合成公司',
    observedAt: at(index),
    ...overrides,
  };
}

test('history compaction uses chronological streams and retains exact endpoint records without mutating input', () => {
  const records = [
    evidence(3),
    evidence(1, { conversationKey: 'synthetic-conversation-b' }),
    evidence(1),
    evidence(0),
    evidence(2),
    evidence(2, { conversationKey: 'synthetic-conversation-b' }),
    evidence(4, { conversationKey: 'synthetic-conversation-b' }),
    evidence(5, { source: 'detail_page_title', title: '原详情一' }),
    evidence(6, { source: 'detail_page_title', title: '原详情一' }),
    evidence(7, { source: 'legacy_named_job' }),
    evidence(8, { conversationKey: null }),
    evidence(9, { conversationKey: null }),
    evidence(10, { conversationKey: null }),
  ];
  const before = structuredClone(records);
  const compacted = compactJobEvidenceHistory(records);
  const keptIndexes = [0, 1, 3, 6, 7, 8, 9, 10, 11, 12];
  assert.deepEqual(
    compacted,
    keptIndexes.map((index) => before[index]),
  );
  for (const [index, record] of compacted.entries()) {
    assert.equal(record, records[keptIndexes[index]]);
  }
  assert.deepEqual(records, before);
  assert.deepEqual(compactJobEvidenceHistory(compacted), compacted);
});

test('job, URL, conversation and source boundaries remain independent and every changed fact ends a run', () => {
  const streamChanges = [
    { jobId: 'another-job' },
    { detailUrl: canonicalJobUrlV2('another-job') },
    { conversationKey: 'another-conversation' },
    { source: 'detail_page_title' },
  ];
  for (const change of streamChanges) {
    const records = [evidence(0), evidence(1), evidence(2, change), evidence(3), evidence(4)];
    assert.deepEqual(
      compactJobEvidenceHistory(records),
      [records[0], records[2], records[4]],
      JSON.stringify(change),
    );
  }
  const changes = [
    { name: '另一合成岗位' },
    { company: '另一合成公司' },
    { contact: '另一合成联系人' },
    { title: '另一原始文字' },
    { name: '合成工程师 ' },
    { attribution: { contact: 'synthetic-a' } },
    { extra: null },
  ];
  for (const change of changes) {
    const records = [evidence(0), evidence(1), evidence(2, change), evidence(3), evidence(4)];
    assert.deepEqual(compactJobEvidenceHistory(records), records, JSON.stringify(change));
  }
  const unknown = [evidence(0), evidence(1, { extra: null }), evidence(2)];
  assert.deepEqual(compactJobEvidenceHistory(unknown), unknown);
  const invalidTime = [evidence(0), evidence(1, { observedAt: 'invalid' }), evidence(2)];
  assert.deepEqual(compactJobEvidenceHistory(invalidTime), invalidTime);
});

test('compacting a saved container changes only supported job evidence and preserves all other material', () => {
  const input = compareLoadedSnapshotsV2(null, snapshot([row(0)], 0)).envelope;
  input.jobs.evidence = [evidence(0), evidence(1), evidence(2), evidence(3)];
  input.jobs.candidates.push({ id: 'synthetic-candidate', original: '候选材料' });
  input.jobs.confirmations.push({ id: 'synthetic-confirmation', original: '人工确认' });
  input.resume.observations.push({ id: 'synthetic-observation', original: '简历材料' });
  const before = structuredClone(input);
  const output = compactSnapshotJobEvidenceHistory(input);
  assert.deepEqual(output.jobs.evidence, [before.jobs.evidence[0], before.jobs.evidence[3]]);
  const expected = structuredClone(before);
  expected.jobs.evidence = [before.jobs.evidence[0], before.jobs.evidence[3]];
  assert.deepEqual(output, expected);
  assert.deepEqual(input, before);
  for (const original of [
    { ...input, version: 1 },
    { ...input, version: 9 },
    { ...input, jobs: { evidence: input.jobs.evidence } },
  ]) {
    assert.deepEqual(compactSnapshotJobEvidenceHistory(original), original);
  }
});

test('collector, detail delivery and legacy identity keep the same selected evidence and detail conflicts', () => {
  const conversation = row(0);
  const association = { ...conversation.jobAssociation, conversationKey: conversation.key };
  const observations = [0, 1, 2, 3].map((index) =>
    evidence(index, { ...association, company: conversation.company }),
  );
  const detail = evidence(4, {
    ...association,
    source: 'detail_page_title',
    name: '合成详情岗位',
    company: conversation.company,
    title: '合成详情原文',
  });
  const confirmed = { ...association, status: 'confirmed_user' };
  for (const details of [
    [],
    [detail],
    [detail, { ...detail, id: 'detail-conflict', name: '冲突岗位' }],
  ]) {
    const original = [...observations, ...details];
    const compacted = compactJobEvidenceHistory(original);
    for (const projection of ['collector', 'detail_delivery', 'legacy_identity']) {
      const select = (items) => {
        const { evidence: ranked, ...decision } = resolveBossJobEvidence(
          { association, conversation, evidence: items, confirmations: [confirmed] },
          projection,
        );
        return decision;
      };
      assert.deepEqual(select(compacted), select(original));
      assert.equal(select(compacted).confirmed, true);
      if (details.length === 2) assert.equal(select(compacted).conflict, true);
    }
    assert.deepEqual(
      compacted.filter((item) => item.source === 'detail_page_title'),
      details,
    );
  }
});

test('equivalent timestamp instants retain the original latest selection and its exact timestamp text', () => {
  const conversation = row(0);
  const association = { ...conversation.jobAssociation, conversationKey: conversation.key };
  const records = [
    evidence(0, { ...association, company: conversation.company }),
    evidence(1, {
      ...association,
      company: conversation.company,
      observedAt: '2026-10-20T10:01:00.1Z',
    }),
    evidence(2, {
      ...association,
      company: conversation.company,
      observedAt: '2026-10-20T18:01:00.100+08:00',
    }),
  ];
  const compacted = compactJobEvidenceHistory(records);
  for (const projection of ['collector', 'detail_delivery', 'legacy_identity']) {
    const decision = resolveBossJobEvidence(
      { association, conversation, evidence: compacted, confirmations: [] },
      projection,
    );
    assert.equal(decision.selected, records[1]);
    assert.equal(decision.selected.observedAt, '2026-10-20T10:01:00.1Z');
  }
  assert.equal(compacted[0], records[0]);
  assert.equal(compacted.at(-1), records[2]);
});

test('list compaction preserves first observed business dates, latest display time and every detail observation', () => {
  const record = row(0);
  const initial = compareLoadedSnapshotsV2(null, snapshot([record], 0)).envelope;
  const original = structuredClone(initial);
  let envelope = initial;
  for (let minute = 1; minute < 5; minute += 1) {
    envelope = compareLoadedSnapshotsV2(envelope, snapshot([record], minute)).envelope;
  }
  const detail = {
    conversationKey: record.key,
    ...record.jobAssociation,
    name: '合成详情岗位',
    company: '合成用人公司',
    title: '「合成详情岗位招聘」_合成用人公司招聘-BOSS直聘',
    source: 'detail_page_title',
  };
  for (const minute of [5, 6, 7]) {
    envelope = applyDetailEvidenceV2(
      envelope,
      { observations: [{ ...detail, observedAt: at(minute) }], candidates: [] },
      at(minute),
    ).envelope;
  }
  assert.deepEqual(initial, original);
  assert.equal(envelope.state.records[0].firstObservedAt, at(0));
  assert.equal(envelope.state.records[0].lastObservedAt, at(4));
  assert.equal(envelope.jobs.associations[0].firstObservedAt, at(0));
  assert.equal(envelope.jobs.associations[0].lastObservedAt, at(4));
  assert.equal(envelope.jobs.evidence.filter((item) => item.source === 'loaded_jobName').length, 2);
  assert.deepEqual(
    envelope.jobs.evidence
      .filter((item) => item.source === 'detail_page_title')
      .map((item) => item.observedAt)
      .sort(),
    [at(5), at(6), at(7)],
  );
  assert.equal(resolveJobRowsV2(envelope)[0].nameObservedAt, at(7));
});

function identityFixture() {
  const records = [row(0), row(1, { timeLabel: '昨天' })];
  let envelope = null;
  for (let minute = 0; minute < 5; minute += 1) {
    envelope = compareLoadedSnapshotsV2(envelope, snapshot(records, minute)).envelope;
  }
  const result = toResumeHistoryResult(
    {
      ok: true,
      url: 'https://www.zhipin.com/web/geek/chat',
      capturedAt: at(4),
      observations: [
        {
          conversationKey: records[0].key,
          friendId: 'friend-0',
          friendSource: '1',
          messageId: 'synthetic-resume-1',
          direction: 'outbound',
          messageType: 4,
          kind: 'sent_candidate',
          platformTime: at(0),
          externalJobId: 'job-0',
          source: 'geek_history_type_4',
        },
      ],
      unresolved: [],
      coverage: { requestedConversations: 1, resolvedConversations: 1, pagesPerConversation: 1 },
    },
    envelope,
  );
  return applyResumeHistoryV2(envelope, result).envelope;
}

test('initial, dated and resume batches preserve frozen 0.10.24 event, fact and application identities', () => {
  const envelope = identityFixture();
  const reference = { path: savedName, sha256: 'f'.repeat(64), envelope };
  const batches = [
    createInitialBatch(reference, 1),
    createDatedYesterdayBatch(reference, 2, '2026-10-19'),
    createResumeBatch(reference, 3),
  ];
  // Literal synthetic golden values were captured from the frozen 0.10.24 baseline.
  assert.deepEqual(
    batches.map((batch) => ({
      id: batch.batchId,
      eventIds: batch.events.map((event) => event.eventId),
    })),
    [
      {
        id: 'boss-batch-dbb50da04d24d9cb93caaa58e89e351fbbacbaf6010b0e9b848da5710e12db2e',
        eventIds: ['boss-event-647b58b137447b063befd6c198925487feddb64ab17c1e19b83895daec7dcc1c'],
      },
      {
        id: 'boss-batch-9eecb4d1df8fb86d1a332922d4c7cc4b79a8a5b79aa8176d25162975029b1b49',
        eventIds: ['boss-event-2f613b706eae9938289386cee2fd32b3f6f333105d2a276ab2a33a87d6673c19'],
      },
      {
        id: 'boss-batch-3b989a63a9a2b4ddc1117dc3247ec62c93011c61da942b446dfa48a2b46dec6c',
        eventIds: ['boss-event-f5dbd037bfb2e3665b076c42bdeefadd00b79a703d0b43aee29d103f2a5c65eb'],
      },
    ],
  );
  assert.deepEqual(
    envelope.resume.observations.map((item) => item.id),
    ['7c98af48796c0421d7d656739e0c2eddef1d6bf6c2e17e84dc5be3bbfb4c930a'],
  );
  let data = bindBossAccount(emptyData(), namespace, sourceId, at(0));
  for (const batch of batches) {
    data = applyBossBatch(data, batch, { workspaceSourceId: sourceId, stamp: at(5) }).data;
  }
  assert.deepEqual(
    data.sourceFacts.map((item) => item.id),
    [
      'boss-fact-d23367f5dc5d13600630afef53a202e0d3848dfbcf54c41cb7660793e9dae8e6',
      'boss-fact-5b195b015aaf99c964538eedc23ffdbdecf5e1737c35a973fe48f4e20afaca1a',
      'boss-fact-47d95ccf99e5b42f94ad1fa69a1219001b92fa9abca2f8d42c8f8eb69d0b565a',
    ],
  );
  assert.deepEqual(
    data.sourceApplications.map((item) => item.id),
    [
      'boss-application-d23367f5dc5d13600630afef53a202e0d3848dfbcf54c41cb7660793e9dae8e6',
      'boss-application-5b195b015aaf99c964538eedc23ffdbdecf5e1737c35a973fe48f4e20afaca1a',
      'boss-application-47d95ccf99e5b42f94ad1fa69a1219001b92fa9abca2f8d42c8f8eb69d0b565a',
    ],
  );
  assert.deepEqual(
    data.opportunities.map((item) => [item.externalId, item.appliedAt]),
    [
      ['job-0', '2026-09-18'],
      ['job-1', '2026-10-19'],
    ],
  );
});

test('direct snapshot commits compact a copy and leave the old immutable bytes and hash untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-snapshot-growth-immutable-'));
  try {
    let envelope = null;
    const originalEvidence = [];
    for (let minute = 0; minute < 5; minute += 1) {
      const capture = snapshot([row(0)], minute);
      originalEvidence.push(...compareLoadedSnapshotsV2(null, capture).envelope.jobs.evidence);
      envelope = compareLoadedSnapshotsV2(envelope, capture).envelope;
    }
    envelope.jobs.evidence = originalEvidence;
    const before = structuredClone(envelope);
    const oldPath = join(directory, savedName);
    const oldBytes = Buffer.from(JSON.stringify(envelope, null, 2) + '\n');
    await writeFile(oldPath, oldBytes, { mode: 0o600 });
    const oldHash = sha256(oldBytes);
    const newPath = await commit(directory, envelope);
    const newBytes = await readFile(newPath);
    const compacted = JSON.parse(newBytes);
    assert.notEqual(newPath, oldPath);
    assert.deepEqual(envelope, before);
    assert.deepEqual(compacted.jobs.evidence, [originalEvidence[0], originalEvidence[4]]);
    assert.equal(newBytes.toString('utf8'), JSON.stringify(compacted) + '\n');
    assert.equal((await stat(newPath)).mode & 0o777, 0o600);
    assert.equal(sha256(await readFile(oldPath)), oldHash);
    const reloadedOld = await readTrackerSnapshot(oldPath);
    assert.equal(reloadedOld.sha256, oldHash);
    assert.deepEqual(reloadedOld.envelope.jobs.evidence, originalEvidence);
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.tmp')).length, 0);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('both readers accept old files above 25 MB and the exact 50 MB boundary without rewriting bytes', async () => {
  assert.equal(BOSS_SNAPSHOT_MAX_BYTES, 50_000_000);
  const directory = await mkdtemp(join(tmpdir(), 'boss-snapshot-growth-reader-'));
  try {
    const envelope = compareLoadedSnapshotsV2(null, snapshot([row(0)], 0)).envelope;
    const json = Buffer.from(JSON.stringify(envelope, null, 2) + '\n');
    const path = join(directory, savedName);
    for (const size of [25_000_001, 50_000_000]) {
      const bytes = Buffer.alloc(size, 0x20);
      json.copy(bytes);
      const expectedHash = sha256(bytes);
      await writeFile(path, bytes, { mode: 0o600 });
      assert.deepEqual((await latest(directory)).envelope, envelope);
      const delivered = await readTrackerSnapshot(path);
      assert.deepEqual(delivered.envelope, envelope);
      assert.equal(delivered.sha256, expectedHash);
      assert.equal(sha256(await readFile(path)), expectedHash);
    }
    await writeFile(path, Buffer.alloc(50_000_001, 0x20));
    await assert.rejects(latest(directory), { message: 'BOSS_SNAPSHOT_TOO_LARGE' });
    await assert.rejects(readTrackerSnapshot(path), { code: 'BOSS_SNAPSHOT_TOO_LARGE' });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('writer rejects UTF-8 bytes above 50 MB before any new file, diagnostic or paired progress appears', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-snapshot-growth-writer-'));
  try {
    const envelope = compareLoadedSnapshotsV2(null, snapshot([row(0)], 0)).envelope;
    const originalPath = await commit(directory, envelope);
    const originalBytes = await readFile(originalPath);
    const progressPath = join(directory, 'synthetic-progress.json');
    const progress = '{"syntheticRevision":7}\n';
    await writeFile(progressPath, progress);
    const originalNames = (await readdir(directory)).sort();
    const oversized = structuredClone(envelope);
    oversized.report.syntheticPadding = '汉'.repeat(16_666_667);
    oversized.resume.observations.push({
      id: 'synthetic-diagnostic-observation',
      conversationKey: row(0).key,
      messageId: 'synthetic-unverified-message',
      kind: 'sent_candidate',
    });
    const serialized = JSON.stringify(oversized) + '\n';
    assert.ok(serialized.length < 50_000_000);
    assert.ok(Buffer.byteLength(serialized, 'utf8') > 50_000_000);
    await assert.rejects(commit(directory, oversized), { message: 'BOSS_SNAPSHOT_TOO_LARGE' });
    assert.deepEqual((await readdir(directory)).sort(), originalNames);
    assert.deepEqual(await readFile(originalPath), originalBytes);
    assert.equal(await readFile(progressPath, 'utf8'), progress);
    assert.equal((await latest(directory)).path, originalPath);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('writer accepts exactly 50 MB including its final newline and rejects the next byte', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-snapshot-growth-writer-boundary-'));
  try {
    const envelope = {
      version: 1,
      state: { records: [] },
      snapshot: { capturedAt: 'synthetic' },
      report: { syntheticPadding: '' },
    };
    const overhead = Buffer.byteLength(JSON.stringify(envelope) + '\n', 'utf8');
    envelope.report.syntheticPadding = 'a'.repeat(50_000_000 - overhead);
    const path = await commit(directory, envelope);
    assert.equal((await stat(path)).size, 50_000_000);
    const originalNames = (await readdir(directory)).sort();
    envelope.report.syntheticPadding += 'a';
    await assert.rejects(commit(directory, envelope), { message: 'BOSS_SNAPSHOT_TOO_LARGE' });
    assert.deepEqual((await readdir(directory)).sort(), originalNames);
    assert.equal((await stat(path)).size, 50_000_000);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('oversized snapshot failure stops the save flow before its paired export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-snapshot-growth-paired-save-'));
  try {
    const envelope = compareLoadedSnapshotsV2(null, snapshot([row(0)], 0)).envelope;
    envelope.report.syntheticPadding = '汉'.repeat(16_666_667);
    let exports = 0;
    await assert.rejects(
      saveEnvelope(directory, envelope, {
        exportJobs: async () => {
          exports += 1;
        },
      }),
      { message: 'BOSS_SNAPSHOT_TOO_LARGE' },
    );
    assert.equal(exports, 0);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true });
  }
});
