import test from 'node:test';
import assert from 'node:assert/strict';
import { unknownJob, normalizeJobCandidate, chooseJob, jobCounts } from './job.mjs';
const candidate = {
  name: '示例岗位',
  href: '/job_detail/abc_123.html?tracking=test',
  source: 'chat_list',
};

test('observed detail href is normalized without inventing an ID or copying query tokens', () => {
  assert.deepEqual(normalizeJobCandidate(candidate), {
    name: '示例岗位',
    detailUrl: 'https://www.zhipin.com/job_detail/abc_123.html',
    source: 'chat_list',
  });
});
test('chat IDs, unsafe schemes, foreign URLs, and malformed paths are not job links', () => {
  for (const href of [
    'javascript:alert(1)',
    'https://example.com/job_detail/a.html',
    'https://user:pass@www.zhipin.com/job_detail/a.html',
    '/web/geek/chat',
    'chatSecurityId',
    '/job_detail/../chat',
    '/job_detail/a%2fb.html',
  ]) {
    assert.deepEqual(normalizeJobCandidate({ ...candidate, href }), unknownJob());
  }
});
test('recruiter title is never a fallback job name; partial observation is explicit', () => {
  assert.deepEqual(normalizeJobCandidate({ title: 'HR总监', source: 'chat_list' }), unknownJob());
  assert.deepEqual(normalizeJobCandidate({ name: '示例岗位', source: 'selected_chat_card' }), {
    name: '示例岗位',
    detailUrl: null,
    source: 'selected_chat_card',
  });
});
test('multiple different jobs stay ambiguous instead of taking the first', () => {
  assert.deepEqual(
    chooseJob([candidate, { ...candidate, href: '/job_detail/different.html' }]),
    unknownJob(),
  );
  assert.equal(chooseJob([candidate, candidate]).name, '示例岗位');
});
test('job coverage reports missing and partial fields', () => {
  assert.deepEqual(
    jobCounts([
      { job: normalizeJobCandidate(candidate) },
      { job: { name: '岗位', detailUrl: null } },
      {},
    ]),
    { named: 2, linked: 1, complete: 1, unknown: 1 },
  );
});
