import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bossAttributionSummary } from '../dist/boss-attribution.js';
import { bossIntegrationView } from '../dist/settings-view.js';
import { recordAttributionDiagnostic } from '../scripts/boss-attribution-diagnostics.mjs';
import { commit, latest } from '../collector/boss/storage.mjs';
import { saveResumeCheckpoint, loadResumeCheckpoint } from '../collector/boss/runtime-state.mjs';

const account = `boss-geek:${'a'.repeat(64)}`;
const event = {
  eventType: 'resume_observed',
  conversationKey: 'b'.repeat(64),
  friendId: 'secret-contact',
  friendSource: '0',
  messageId: 'secret-message',
  externalJobId: 'secret-job',
  summary: 'SECRET_BODY',
  attribution: null,
};
const observation = { ...event, platformIdentity: { friendId: event.friendId, friendSource: '0' } };

test('未应用摘要按事实去重，成功应用退出，候选岗位明确标识且正文不展示', () => {
  const data = {
    sourceApplications: [
      { factId: 'fact', status: 'waiting', reason: 'attribution_evidence_missing' },
      { factId: 'fact', status: 'waiting', reason: 'attribution_evidence_missing' },
    ],
    sourceEvents: [
      {
        id: 'event',
        factId: 'fact',
        jobName: '<候选岗位>',
        company: '同名公司',
        summary: 'SECRET_BODY',
      },
    ],
  };
  const summary = bossAttributionSummary(data);
  assert.equal(summary.insufficient, 1);
  assert.equal(summary.items.length, 1);
  const html = bossIntegrationView({ available: true, serverManaged: true, attribution: summary });
  assert.match(html, /证据不足/);
  assert.match(html, /候选岗位：同名公司 \/ &lt;候选岗位&gt;/);
  assert.doesNotMatch(html, /SECRET_BODY|确认归属<\/button>|收起<\/button>/);
  for (const row of data.sourceApplications) row.status = 'applied';
  assert.equal(bossAttributionSummary(data).items.length, 0);
});

test('诊断去重且仅含摘要，权限严格，重启后重复写不增加材料', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boss-attribution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await recordAttributionDiagnostic(root, account, event, 'queue');
  await recordAttributionDiagnostic(root, account, event, 'queue');
  const directory = join(root, 'attribution-diagnostics'),
    names = await readdir(directory);
  assert.equal(names.length, 1);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(directory, names[0]))).mode & 0o777, 0o600);
  const text = await readFile(join(directory, names[0]), 'utf8');
  assert.doesNotMatch(text, /secret|SECRET|securityId|boss-geek/);
  const diagnostic = JSON.parse(text);
  assert.equal(diagnostic.reason, 'attribution_evidence_missing');
  assert.equal(diagnostic.stage, 'queue');
});

test('诊断落盘失败不提交快照或推进检查点，可修复后重放本机材料', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'boss-diagnostic-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'attribution-diagnostics'), 'blocked', { mode: 0o600 });
  const envelope = {
    version: 4,
    accountNamespace: account,
    state: {},
    snapshot: {},
    report: {},
    resume: { observations: [observation] },
  };
  const checkpoint = {
    version: 2,
    capturedAt: '2026-09-29T00:00:00.000Z',
    nextConversationKey: event.conversationKey,
    nextPage: 2,
    observations: [observation],
    unresolved: [],
    coverage: {},
    usage: { historyRequests: 1 },
    partial: false,
    error: null,
  };
  await assert.rejects(commit(root, envelope), /DIAGNOSTIC_PATH_INVALID/);
  await assert.rejects(saveResumeCheckpoint(root, checkpoint), /DIAGNOSTIC_PATH_INVALID/);
  assert.equal(await latest(root), null);
  assert.equal(await loadResumeCheckpoint(root), null);
  await rm(join(root, 'attribution-diagnostics'));
  await saveResumeCheckpoint(root, checkpoint);
  assert.equal((await loadResumeCheckpoint(root)).nextPage, 2);
  await commit(root, envelope);
  assert.equal((await latest(root)).envelope.version, 4);
});
