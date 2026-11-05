import assert from 'node:assert/strict';
import test from 'node:test';
import { bossDetailReviewView } from '../dist/boss/detail-review-view.js';

const active = {
  jobId: 'job_a',
  canonicalUrl: 'https://www.zhipin.com/job_detail/job_a.html',
  company: '示例企业 <script>',
  jobName: '',
  status: 'isolated',
  error: 'DETAIL_TITLE_NOT_READY',
  attempts: 4,
  lastAttemptAt: '2026-11-05T02:00:00.000Z',
  canRetry: true,
  canCompleteWithDetails: false,
  matchingOpportunityId: '',
  canCreateOpportunity: true,
};
test('详情异常逐岗位展示原链接、人工补齐、明确停止与单次重试，已处理另列', () => {
  const html = bossDetailReviewView({
    details: {
      lifecycle: 'stopped',
      cycleInProgress: false,
      items: [
        active,
        {
          ...active,
          jobId: 'job_b',
          status: 'manually_stopped',
          resolution: { status: 'stopped', reason: 'not_needed', at: '2026-11-05T03:00:00.000Z' },
        },
      ],
    },
  });
  assert.match(html, /示例企业 &lt;script&gt;/);
  assert.match(html, /打开原岗位链接/);
  assert.match(html, /data-boss-detail-action="edit"/);
  assert.match(html, /data-boss-detail-action="not_needed"/);
  assert.match(html, /data-boss-detail-action="retry"/);
  assert.match(html, /人工处理记录/);
  assert.match(html, /data-boss-detail-action="reopen"/);
  assert.match(html, /仅此电脑/);
  assert.doesNotMatch(html, /资料已采集成功/);
});
test('失联不抹去原故障，未知人工请求可精确核对，异常链接不生成可打开入口', () => {
  const html = bossDetailReviewView({
    stale: true,
    error: '状态未确认',
    pendingCommand: { commandId: 'private-command' },
    details: { lifecycle: 'stopped', items: [{ ...active, canonicalUrl: 'javascript:alert(1)' }] },
  });
  assert.match(html, /DETAIL_TITLE_NOT_READY/);
  assert.match(html, /核对原处理请求/);
  assert.match(html, /状态未确认/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /data-boss-detail-action="not_needed"[^>]*disabled/);
  assert.doesNotMatch(html, /private-command/);
});
