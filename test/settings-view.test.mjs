import assert from 'node:assert/strict';
import test from 'node:test';
import { bossIntegrationView } from '../dist/settings-view.js';

test('详情技术隔离独立显示，不混入人工判断', () => {
  const html = bossIntegrationView({
    available: true,
    serverManaged: true,
    accounts: [],
    pending: 0,
    server: {},
    sourceId: '00000000-0000-4000-8000-000000000001',
    applicationCounts: { waiting: 7, review: 1, protected: 0 },
    tracking: {
      detailEnrichment: {
        status: 'blocked',
        pending: 5,
        deferred: 2,
        isolated: 3,
        nextRetryAt: '2026-09-22T12:00:00.000Z',
        lastError: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
      },
    },
  });
  assert.match(html, /<strong>1<\/strong> 需要人工判断/);
  assert.match(html, /<strong>3<\/strong> 技术隔离/);
  assert.match(html, /DETAIL_TAB_OWNERSHIP_MISMATCH/);
  assert.match(html, /pnpm boss resume-details/);
});
