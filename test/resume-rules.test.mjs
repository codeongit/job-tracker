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
  classifyResumeEvidence,
  validateResumeEvidence,
  resumeEvidenceMeaning,
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

test('岗位卡片共享简历旧模板时，结构本身不能证明简历发送', () => {
  const message = {
    type: 4,
    bizType: 317,
    from: { uid: 'boss_1' },
    to: { uid: 'self_1' },
    body: {
      type: 16,
      style: 3,
      templateId: 1,
      articles: [
        { title: '合成公司 Java 工程师', url: 'https://www.zhipin.com/job_detail/job_1.html' },
      ],
    },
  };
  assert.equal(classifyResumeMessage(message, 'boss_1', RESUME_RULES, classifyResumeText), null);
});

test('发送依据保留精确字段和固定文案，附件文件名不进入依据', () => {
  const result = classifyResumeEvidence(
    { type: 5, body: { content: ' 附件简历请求已发送 ' } },
    RESUME_RULES,
    classifyResumeText,
  );
  assert.deepEqual(result, {
    kind: 'request_sent',
    evidence: { version: 1, messageType: 5, field: 'body.content', text: '附件简历请求已发送' },
  });
  assert.deepEqual(resumeEvidenceMeaning('resume_request_sent', result.evidence), {
    status: 'verified',
    meaning: 'resume_sent',
    target: '已发送',
  });
  const attachment = classifyResumeEvidence(
    { type: 5, content: '您的附件简历 private-synthetic.pdf 已发送给Boss点击查看附件' },
    RESUME_RULES,
    classifyResumeText,
  );
  assert.equal(attachment.evidence.text, '您的附件简历 [attachment] 已发送给Boss');
  assert.equal(JSON.stringify(attachment.evidence).includes('private-synthetic'), false);
  assert.equal(
    resumeEvidenceMeaning('resume_attachment_sent', attachment.evidence).status,
    'verified',
  );
});

test('真实字段模式的附件发送与查看确认保留最小可重验依据', () => {
  const cases = [
    {
      message: {
        type: 3,
        bizType: 13,
        body: {
          type: 12,
          templateId: 1,
          hyperLink: {
            hyperLinkType: 6,
            text: '您的附件简历 private-synthetic.pdf 已发送给Boss点击查看附件',
            url: 'https://example.invalid/private-resume',
          },
        },
      },
      kind: 'attachment_sent',
      evidence: {
        version: 2,
        messageType: 3,
        field: 'body.hyperLink.text',
        text: '您的附件简历 [attachment] 已发送给Boss',
        bizType: 13,
        bodyType: 12,
        templateId: 1,
        hyperLinkType: 6,
      },
      target: '已发送',
    },
    {
      message: {
        type: 4,
        body: { type: 1, templateId: 3, text: '对方已查看了您的附件简历' },
      },
      kind: 'viewed_confirmed',
      evidence: {
        version: 2,
        messageType: 4,
        field: 'body.text',
        text: '对方已查看了您的附件简历',
        bizType: null,
        bodyType: 1,
        templateId: 3,
        hyperLinkType: null,
      },
      target: '对方已接收',
    },
  ];
  for (const { message, kind, evidence, target } of cases) {
    assert.deepEqual(classifyResumeEvidence(message, RESUME_RULES, classifyResumeText), {
      kind,
      evidence,
    });
    assert.deepEqual(validateResumeEvidence(evidence), evidence);
    assert.equal(resumeEvidenceMeaning(resumeRule(kind).summary, evidence).target, target);
    for (const privateValue of ['private-synthetic', 'private-resume', 'https://'])
      assert.equal(JSON.stringify(evidence).includes(privateValue), false);
  }
});

test('新增字段或类型四系统文案缺少已核实结构时仍不推进', () => {
  const send = {
    type: 3,
    bizType: 13,
    body: {
      type: 12,
      templateId: 1,
      hyperLink: { hyperLinkType: 6, text: '您的附件简历 synthetic.pdf 已发送给Boss' },
    },
  };
  const viewed = {
    type: 4,
    body: { type: 1, templateId: 3, text: '对方已查看了您的附件简历' },
  };
  for (const message of [
    { ...send, type: 1 },
    { ...send, bizType: 317 },
    { ...send, body: { ...send.body, type: 16 } },
    { ...send, body: { ...send.body, templateId: 2 } },
    { ...send, body: { ...send.body, hyperLink: { ...send.body.hyperLink, hyperLinkType: 5 } } },
    {
      ...send,
      body: { ...send.body, hyperLink: { ...send.body.hyperLink, hyperLinkType: undefined } },
    },
    { ...send, body: { ...send.body, hyperLink: { ...send.body.hyperLink, text: '请发送简历' } } },
    { ...send, body: { ...send.body, hyperLink: { type: 6, text: send.body.hyperLink.text } } },
    { ...viewed, type: 1 },
    { ...viewed, bizType: 317 },
    { ...viewed, body: { ...viewed.body, type: 16 } },
    { ...viewed, body: { ...viewed.body, templateId: undefined } },
    { ...viewed, body: { ...viewed.body, templateId: 1 } },
    { ...viewed, body: { ...viewed.body, text: '他说：对方已查看了您的附件简历' } },
    { ...viewed, body: { ...viewed.body, hyperLink: { hyperLinkType: 6 } } },
  ])
    assert.equal(classifyResumeEvidence(message, RESUME_RULES, classifyResumeText), null);
});

test('v2 依据重验结构，旧依据不因新规则变成可信类型四', () => {
  const viewed = {
    version: 2,
    messageType: 4,
    field: 'body.text',
    text: '对方已查看了您的附件简历',
    bizType: null,
    bodyType: 1,
    templateId: 3,
    hyperLinkType: null,
  };
  assert.equal(resumeEvidenceMeaning('resume_viewed_confirmed', viewed).status, 'verified');
  for (const evidence of [
    { ...viewed, messageType: 1 },
    { ...viewed, bizType: 317 },
    { ...viewed, bodyType: 16 },
    { ...viewed, templateId: 1 },
    { ...viewed, hyperLinkType: 6 },
    { ...viewed, field: 'message.text' },
  ])
    assert.equal(resumeEvidenceMeaning('resume_viewed_confirmed', evidence).status, 'insufficient');
  assert.equal(resumeEvidenceMeaning('resume_request_sent', viewed).status, 'insufficient');
  for (const invalid of [
    { ...viewed, version: 3 },
    { ...viewed, rawBody: {} },
    { ...viewed, field: 'body.hyperLink.url' },
    { ...viewed, templateId: '3' },
    { ...viewed, bodyType: 1001 },
    { ...viewed, hyperLinkType: -1 },
    { ...viewed, bizType: undefined },
  ])
    assert.throws(() => validateResumeEvidence(invalid), /RESUME_EVIDENCE_INVALID/);
  assert.equal(
    resumeEvidenceMeaning('resume_viewed_confirmed', {
      version: 1,
      messageType: 4,
      field: 'body.text',
      text: viewed.text,
    }).status,
    'insufficient',
  );
});

test('缺依据与普通消息不能变成发送证据，旧类型四观察允许只存档', () => {
  assert.deepEqual(resumeEvidenceMeaning('resume_request_sent', null), {
    status: 'insufficient',
    meaning: 'observation_only',
    target: null,
  });
  for (const messageType of [1, 4]) {
    const evidence = {
      version: 1,
      messageType,
      field: 'message.content',
      text: '附件简历请求已发送',
    };
    assert.equal(resumeEvidenceMeaning('resume_request_sent', evidence).status, 'insufficient');
    assert.equal(
      classifyResumeEvidence(
        { type: messageType, content: evidence.text },
        RESUME_RULES,
        classifyResumeText,
      ),
      null,
    );
  }
  assert.deepEqual(
    resumeEvidenceMeaning('resume_request_sent', {
      version: 1,
      messageType: 4,
      field: 'none',
      text: '',
    }),
    { status: 'observation_only', meaning: 'observation_only', target: null },
  );
  assert.equal(
    resumeEvidenceMeaning('resume_sent_confirmed', {
      version: 1,
      messageType: 5,
      field: 'message.content',
      text: '附件简历请求已发送',
    }).status,
    'insufficient',
  );
});

test('发送依据拒绝未来版本、未知字段、任意正文与私有附件名', () => {
  const evidence = {
    version: 1,
    messageType: 5,
    field: 'message.content',
    text: '附件简历请求已发送',
  };
  assert.equal(validateResumeEvidence(null), null);
  for (const value of [
    { ...evidence, version: 2 },
    { ...evidence, token: 'synthetic-token' },
    { ...evidence, field: 'body.extend' },
    { ...evidence, text: '合成聊天正文' },
    { ...evidence, text: '您的附件简历 private-synthetic.pdf 已发送给Boss' },
    { ...evidence, field: 'none', text: '' },
  ])
    assert.throws(() => validateResumeEvidence(value), /RESUME_EVIDENCE_INVALID/);
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
