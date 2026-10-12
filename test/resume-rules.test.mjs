import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  RESUME_RULES,
  RESUME_KINDS,
  RESUME_SUMMARIES,
  RESUME_STATES,
  resumeRule,
  classifyResumeText,
  classifyResumeMessage,
  classifyResumeEvidence,
  assessResumeEvidence,
  RESUME_EXTENSION_FORMATS,
  BOSS_ACTION40_PLATFORM_CONTRACT,
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

test('动作通知没有正文时仍能确认附件发送，并仅保留固定语义依据', () => {
  const message = {
    type: 1,
    body: {
      type: 4,
      templateId: 1,
      action: { aid: 40, extend: '{"fileName":"private-synthetic.pdf","url":"private-link"}' },
    },
  };
  const evidence = {
    version: 3,
    messageType: 1,
    field: 'body.action',
    text: '附件简历请求已发送',
    bodyType: 4,
    templateId: 1,
    actionAid: 40,
    annexType: null,
  };
  const result = classifyResumeEvidence(message, RESUME_RULES, classifyResumeText);
  assert.deepEqual(result, { kind: 'request_sent', evidence });
  assert.deepEqual(validateResumeEvidence(evidence), evidence);
  assert.deepEqual(resumeEvidenceMeaning('resume_request_sent', evidence), {
    status: 'verified',
    meaning: 'resume_sent',
    target: '已发送',
  });
  assert.deepEqual(classifyResumeEvidence(message, RESUME_RULES, classifyResumeText), result);
  for (const privateValue of ['private-synthetic', 'private-link', 'fileName', 'url', 'extend'])
    assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test('合成非 JSON 动作扩展须匹配已核实的平台契约，发送依据保留扩展形态', () => {
  const message = {
    type: 1,
    body: {
      type: 4,
      templateId: 1,
      action: { aid: 40, extend: 'synthetic-opaque-action-token' },
    },
  };
  const platformContract = 'boss-action40-v5550-4d4a6ac8';
  assert.deepEqual(
    classifyResumeEvidence(message, RESUME_RULES, classifyResumeText, { platformContract }),
    {
      kind: 'request_sent',
      evidence: {
        version: 4,
        messageType: 1,
        field: 'body.action',
        text: '附件简历请求已发送',
        bodyType: 4,
        templateId: 1,
        actionAid: 40,
        annexType: null,
        extensionFormat: 'opaque_string',
        platformContract,
      },
    },
  );
  assert.equal(classifyResumeEvidence(message, RESUME_RULES, classifyResumeText), null);
  const result = classifyResumeEvidence(message, RESUME_RULES, classifyResumeText, {
    platformContract,
  });
  assert.deepEqual(validateResumeEvidence(result.evidence), result.evidence);
  assert.deepEqual(resumeEvidenceMeaning('resume_request_sent', result.evidence), {
    status: 'verified',
    meaning: 'resume_sent',
    target: '已发送',
  });
  assert.equal(JSON.stringify(result).includes('synthetic-opaque-action-token'), false);
});

test('动作扩展评估区分无关消息、作品集及需要诊断的扩展不足', () => {
  assert.deepEqual(RESUME_EXTENSION_FORMATS, ['absent', 'json_object', 'opaque_string']);
  const context = { platformContract: BOSS_ACTION40_PLATFORM_CONTRACT };
  const message = (extend) => ({
    type: 1,
    text: '附件简历请求已发送',
    body: { type: 4, templateId: 1, action: { aid: 40, extend } },
  });
  const assessment = (extend, contract = context) =>
    assessResumeEvidence(message(extend), RESUME_RULES, classifyResumeText, contract);
  for (const contract of [undefined, null, {}, { platformContract: 'future-contract' }])
    assert.deepEqual(
      assessResumeEvidence(
        message('synthetic-opaque-token'),
        RESUME_RULES,
        classifyResumeText,
        contract,
      ),
      {
        status: 'unsupported',
        reason: 'RESUME_ACTION_PLATFORM_CONTRACT_UNVERIFIED',
      },
    );
  assert.equal(assessment('synthetic-opaque-token').status, 'classified');
  assert.deepEqual(assessment('{"annexType":1}'), {
    status: 'not_relevant',
    reason: 'RESUME_ACTION_PORTFOLIO',
  });
  for (const annexType of [2, -1, '0', '1', null, false, {}])
    assert.deepEqual(assessment(JSON.stringify({ annexType })), {
      status: 'unsupported',
      reason: 'RESUME_ACTION_ANNEX_TYPE_UNSUPPORTED',
    });
  for (const extend of [
    '{',
    '{"annexType":1',
    '{"annexType":1} trailing',
    '[',
    'opaque[fragment',
    'opaque]fragment',
    'opaque{fragment',
    'opaque}fragment',
    'opaque"fragment',
    "opaque'fragment",
    '[]',
    '"quoted"',
    '0',
    'true',
    'false',
    'null',
    ' null ',
    'undefined',
    ' undefined ',
    'NULL',
    'UNDEFINED',
    ' ',
    '\t\n',
    0,
    false,
    {},
    [],
  ]) {
    assert.deepEqual(assessment(extend), {
      status: 'unsupported',
      reason: 'RESUME_ACTION_EXTENSION_INVALID',
    });
    assert.equal(
      classifyResumeEvidence(message(extend), RESUME_RULES, classifyResumeText, context),
      null,
    );
  }
  for (const candidate of [
    { type: 1, text: '附件简历请求已发送' },
    { ...message('synthetic-opaque-token'), body: { type: 4, templateId: 1, action: { aid: 27 } } },
  ])
    assert.deepEqual(assessResumeEvidence(candidate, RESUME_RULES, classifyResumeText, context), {
      status: 'not_relevant',
      reason: 'NOT_RESUME_EVIDENCE',
    });
  for (const extend of [undefined, null, '', '{}', '{"annexType":0}']) {
    const result = assessment(extend, {});
    assert.equal(result.status, 'classified');
    assert.equal(result.evidence.version, 3);
    assert.equal(Object.hasOwn(result.evidence, 'extensionFormat'), false);
    assert.equal(Object.hasOwn(result.evidence, 'platformContract'), false);
  }
});

test('明确 aid40 标记但结构变化时保留不足原因，字符串编号只能用于诊断', () => {
  const message = {
    type: 1,
    text: '附件简历请求已发送',
    body: { type: 4, templateId: 1, action: { aid: 40, extend: '' } },
  };
  const context = { platformContract: BOSS_ACTION40_PLATFORM_CONTRACT };
  for (const candidate of [
    ...[0, 2, 4, 5, 1001, '1', '4', undefined, null].map((type) => ({ ...message, type })),
    { ...message, body: { ...message.body, type: 1 } },
    { ...message, body: { ...message.body, type: '4' } },
    { ...message, body: { ...message.body, templateId: 2 } },
    { ...message, body: { ...message.body, templateId: '1' } },
    { ...message, body: { ...message.body, templateId: undefined } },
    { ...message, body: { ...message.body, action: { aid: '40', extend: '' } } },
  ]) {
    assert.deepEqual(assessResumeEvidence(candidate, RESUME_RULES, classifyResumeText, context), {
      status: 'unsupported',
      reason: 'RESUME_ACTION_SHAPE_UNSUPPORTED',
    });
    assert.equal(
      classifyResumeEvidence(candidate, RESUME_RULES, classifyResumeText, context),
      null,
    );
  }
  for (const aid of [27, '27', 32, 75, undefined])
    assert.deepEqual(
      assessResumeEvidence(
        { ...message, body: { ...message.body, action: { aid, extend: '' } } },
        RESUME_RULES,
        classifyResumeText,
        context,
      ),
      { status: 'not_relevant', reason: 'NOT_RESUME_EVIDENCE' },
    );
});

test('动作评估可以独立注入确定性表达式，兼容分类接口显式注入评估函数', () => {
  const message = {
    type: 1,
    body: { type: 4, templateId: 1, action: { aid: 40, extend: 'synthetic-opaque-token' } },
  };
  const context = { platformContract: BOSS_ACTION40_PLATFORM_CONTRACT };
  const expected = classifyResumeEvidence(message, RESUME_RULES, classifyResumeText, context);
  const serialized = vm.runInNewContext(
    `JSON.stringify((${classifyResumeEvidence.toString()})(
      ${JSON.stringify(message)}, ${JSON.stringify(RESUME_RULES)},
      (${classifyResumeText.toString()}), ${JSON.stringify(context)},
      (${assessResumeEvidence.toString()})
    ))`,
  );
  assert.deepEqual(JSON.parse(serialized), expected);
});

test('v4 只接受已核实的不透明扩展组合，消费独立核对动作结构与类别', () => {
  const evidence = {
    version: 4,
    messageType: 1,
    field: 'body.action',
    text: '附件简历请求已发送',
    bodyType: 4,
    templateId: 1,
    actionAid: 40,
    annexType: null,
    extensionFormat: 'opaque_string',
    platformContract: BOSS_ACTION40_PLATFORM_CONTRACT,
  };
  assert.deepEqual(validateResumeEvidence(evidence), evidence);
  for (const candidate of [
    { ...evidence, messageType: 4 },
    { ...evidence, bodyType: 1 },
    { ...evidence, templateId: 2 },
    { ...evidence, actionAid: 27 },
  ])
    assert.equal(resumeEvidenceMeaning('resume_request_sent', candidate).status, 'insufficient');
  for (const summary of [
    'resume_attachment_sent',
    'resume_viewed_confirmed',
    'resume_sent_confirmed',
  ])
    assert.equal(resumeEvidenceMeaning(summary, evidence).status, 'insufficient');
  assert.equal(resumeEvidenceMeaning('resume_card_other', evidence).status, 'observation_only');
  for (const invalid of [
    { ...evidence, version: 5 },
    { ...evidence, version: 3 },
    { ...evidence, field: 'message.text' },
    { ...evidence, text: '对方已查看了您的附件简历' },
    { ...evidence, actionAid: '40' },
    { ...evidence, bodyType: '4' },
    { ...evidence, templateId: '1' },
    { ...evidence, annexType: 0 },
    { ...evidence, annexType: 1 },
    { ...evidence, annexType: 2 },
    { ...evidence, extensionFormat: 'absent' },
    { ...evidence, extensionFormat: 'json_object' },
    { ...evidence, extensionFormat: 'future_format' },
    { ...evidence, extensionFormat: null },
    { ...evidence, platformContract: 'future-contract' },
    { ...evidence, platformContract: null },
    { ...evidence, platformContract: undefined },
    { ...evidence, rawExtend: 'synthetic-opaque-token' },
    { ...evidence, rawBody: {} },
  ]) {
    assert.throws(() => validateResumeEvidence(invalid), /RESUME_EVIDENCE_INVALID/);
    assert.throws(
      () => resumeEvidenceMeaning('resume_request_sent', invalid),
      /RESUME_EVIDENCE_INVALID/,
    );
  }
  for (const field of ['extensionFormat', 'platformContract', 'annexType']) {
    const incomplete = { ...evidence };
    delete incomplete[field];
    assert.throws(() => validateResumeEvidence(incomplete), /RESUME_EVIDENCE_INVALID/);
  }
});

test('动作通知只接受缺省或已核实的附件类型，作品集和无效扩展不确认', () => {
  const actionMessage = (extend) => ({
    type: 1,
    text: '附件简历请求已发送',
    body: { type: 4, templateId: 1, action: { aid: 40, extend } },
  });
  for (const extend of [undefined, null, '', '{}', '{"fileName":"private-synthetic.pdf"}']) {
    const result = classifyResumeEvidence(actionMessage(extend), RESUME_RULES, classifyResumeText);
    assert.equal(result?.kind, 'request_sent');
    assert.equal(result.evidence.annexType, null);
  }
  const attachment = classifyResumeEvidence(
    actionMessage('{"annexType":0,"content":"private-synthetic"}'),
    RESUME_RULES,
    classifyResumeText,
  );
  assert.equal(attachment?.kind, 'request_sent');
  assert.equal(attachment.evidence.annexType, 0);
  assert.equal(JSON.stringify(attachment).includes('private-synthetic'), false);
  for (const extend of [
    '{"annexType":1}',
    '{"annexType":2}',
    '{"annexType":-1}',
    '{"annexType":"0"}',
    '{"annexType":null}',
    '{"annexType":false}',
    '{"annexType":{}}',
    '{',
    ' ',
    'null',
    '[]',
    '"quoted"',
    '0',
    0,
    false,
    {},
  ])
    assert.equal(
      classifyResumeEvidence(actionMessage(extend), RESUME_RULES, classifyResumeText),
      null,
    );
});

test('伪造发送文字不能绕过动作编号、类型和模板结构', () => {
  const message = {
    type: 1,
    text: '附件简历请求已发送',
    body: { type: 4, templateId: 1, action: { aid: 40, extend: '' } },
  };
  for (const candidate of [
    { type: 1, text: message.text },
    { ...message, type: '1' },
    { ...message, type: 4 },
    { ...message, body: { ...message.body, type: 1 } },
    { ...message, body: { ...message.body, type: '4' } },
    { ...message, body: { ...message.body, templateId: 2 } },
    { ...message, body: { ...message.body, templateId: '1' } },
    { ...message, body: { ...message.body, templateId: undefined } },
    { ...message, body: { ...message.body, action: undefined } },
    { ...message, body: { ...message.body, action: [] } },
    ...[27, 32, 75, '40', undefined].map((aid) => ({
      ...message,
      body: { ...message.body, action: { aid, extend: '' } },
    })),
  ])
    assert.equal(classifyResumeEvidence(candidate, RESUME_RULES, classifyResumeText), null);
});

test('v3 动作依据消费重验结构与观察类别，旧 type1 依据仍不足', () => {
  const evidence = {
    version: 3,
    messageType: 1,
    field: 'body.action',
    text: '附件简历请求已发送',
    bodyType: 4,
    templateId: 1,
    actionAid: 40,
    annexType: null,
  };
  for (const candidate of [
    { ...evidence, messageType: 4 },
    { ...evidence, bodyType: 1 },
    { ...evidence, templateId: 2 },
    { ...evidence, actionAid: 27 },
    { ...evidence, annexType: 1 },
  ])
    assert.equal(resumeEvidenceMeaning('resume_request_sent', candidate).status, 'insufficient');
  for (const summary of [
    'resume_attachment_sent',
    'resume_viewed_confirmed',
    'resume_sent_confirmed',
  ])
    assert.equal(resumeEvidenceMeaning(summary, evidence).status, 'insufficient');
  assert.equal(resumeEvidenceMeaning('resume_card_other', evidence).status, 'observation_only');
  for (const invalid of [
    { ...evidence, version: 4 },
    { ...evidence, field: 'message.text' },
    { ...evidence, text: '对方已查看了您的附件简历' },
    { ...evidence, actionAid: '40' },
    { ...evidence, actionAid: null },
    { ...evidence, bodyType: undefined },
    { ...evidence, templateId: 1001 },
    { ...evidence, annexType: 2 },
    { ...evidence, annexType: '0' },
    { ...evidence, annexType: false },
    { ...evidence, annexType: undefined },
    { ...evidence, extend: '{"fileName":"private-synthetic.pdf"}' },
    { ...evidence, bizType: null },
  ])
    assert.throws(() => validateResumeEvidence(invalid), /RESUME_EVIDENCE_INVALID/);
  for (const legacy of [
    { version: 1, messageType: 1, field: 'body.text', text: evidence.text },
    {
      version: 2,
      messageType: 1,
      field: 'body.text',
      text: evidence.text,
      bizType: null,
      bodyType: 4,
      templateId: 1,
      hyperLinkType: null,
    },
  ])
    assert.equal(resumeEvidenceMeaning('resume_request_sent', legacy).status, 'insufficient');
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
