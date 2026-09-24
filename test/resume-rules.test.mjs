import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESUME_RULES,
  RESUME_KINDS,
  RESUME_SUMMARIES,
  RESUME_STATES,
  resumeRule,
  classifyResumeText,
  classifyResumeMessage,
  resumeTransition,
} from '../dist/resume-rules.js';

test('用户确认的平台文案含义保持固定，不从 request 字面重新推断业务含义', () => {
  const cases = [
    ['附件简历请求已发送', 'request_sent', 'resume_request_sent', 'resume_sent', '已发送'],
    [
      '对方已同意，您的附件简历已发送给对方',
      'sent_confirmed',
      'resume_sent_confirmed',
      'resume_sent',
      '已发送',
    ],
    [
      '您的附件简历 synthetic.pdf 已发送给Boss',
      'attachment_sent',
      'resume_attachment_sent',
      'resume_sent',
      '已发送',
    ],
    [
      '对方已查看了您的附件简历',
      'viewed_confirmed',
      'resume_viewed_confirmed',
      'resume_received',
      '对方已接收',
    ],
  ];
  for (const [text, kind, summary, meaning, target] of cases) {
    assert.equal(classifyResumeText(text, RESUME_RULES), kind);
    const rule = resumeRule(kind);
    assert.equal(rule.summary, summary);
    assert.equal(rule.meaning, meaning);
    assert.equal(rule.target, target);
    assert.deepEqual(resumeTransition('未知', summary), { outcome: 'advance', target });
  }
  assert.equal(new Set(RESUME_KINDS).size, 6);
  assert.equal(new Set(RESUME_SUMMARIES).size, 6);
  assert.throws(() => resumeRule('future_status'), /RESUME_OBSERVATION_UNKNOWN/);
});

test('普通聊天引用、嵌套引用和宽泛关键词都不构成发送证据', () => {
  for (const message of [
    { type: 1, content: '附件简历请求已发送' },
    { type: 5, content: '他说：附件简历请求已发送' },
    { type: 5, metadata: { quoted: '附件简历请求已发送' } },
    { type: 5, content: '请发送简历' },
  ])
    assert.equal(classifyResumeMessage(message, 'boss_1', RESUME_RULES, classifyResumeText), null);
});

test('状态转换覆盖全部观察类型，普通卡片不推进、确认状态不回退', () => {
  for (const state of RESUME_STATES) {
    for (const summary of ['resume_sent_candidate', 'resume_card_other'])
      assert.deepEqual(resumeTransition(state, summary), {
        outcome: 'observation_only',
        target: null,
      });
  }
  for (const summary of [
    'resume_request_sent',
    'resume_sent_confirmed',
    'resume_attachment_sent',
  ]) {
    for (const state of ['未知', '被索要'])
      assert.equal(resumeTransition(state, summary).outcome, 'advance');
    for (const state of ['已发送', '对方已接收'])
      assert.equal(resumeTransition(state, summary).outcome, 'supported');
    assert.equal(resumeTransition('future_state', summary).outcome, 'protected');
  }
  for (const state of ['未知', '被索要', '已发送'])
    assert.equal(resumeTransition(state, 'resume_viewed_confirmed').outcome, 'advance');
  assert.equal(resumeTransition('对方已接收', 'resume_viewed_confirmed').outcome, 'supported');
});
