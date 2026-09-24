// Platform observations are wire identifiers, not business meanings. In particular,
// request_sent is the legacy BOSS identifier for a confirmed resume send (D025/D030).
// Keep these identifiers stable: persisted event/fact IDs depend on them.
export const RESUME_STATE = Object.freeze({
  UNKNOWN: '未知',
  REQUESTED: '被索要',
  SENT: '已发送',
  RECEIVED: '对方已接收',
});
export const RESUME_STATES = Object.freeze(Object.values(RESUME_STATE));
export const RESUME_MEANING = Object.freeze({
  OBSERVATION: 'observation_only',
  SENT: 'resume_sent',
  RECEIVED: 'resume_received',
});
export const RESUME_RULES = Object.freeze(
  [
    {
      kind: 'sent_candidate',
      summary: 'resume_sent_candidate',
      meaning: RESUME_MEANING.OBSERVATION,
      target: null,
      label: '简历卡片（发送方向）',
    },
    {
      kind: 'resume_card_other',
      summary: 'resume_card_other',
      meaning: RESUME_MEANING.OBSERVATION,
      target: null,
      label: '简历卡片（平台观察）',
    },
    {
      kind: 'request_sent',
      summary: 'resume_request_sent',
      meaning: RESUME_MEANING.SENT,
      target: RESUME_STATE.SENT,
      label: '附件简历请求已发送',
      text: '附件简历请求已发送',
      structured: true,
    },
    {
      kind: 'sent_confirmed',
      summary: 'resume_sent_confirmed',
      meaning: RESUME_MEANING.SENT,
      target: RESUME_STATE.SENT,
      label: '简历已发送（对方已同意）',
      text: '对方已同意，您的附件简历已发送给对方',
    },
    {
      kind: 'attachment_sent',
      summary: 'resume_attachment_sent',
      meaning: RESUME_MEANING.SENT,
      target: RESUME_STATE.SENT,
      label: '附件简历已发送给 Boss',
      pattern: '^您的附件简历 .{1,300} 已发送给Boss(?:点击查看附件)?$',
    },
    {
      kind: 'viewed_confirmed',
      summary: 'resume_viewed_confirmed',
      meaning: RESUME_MEANING.RECEIVED,
      target: RESUME_STATE.RECEIVED,
      label: '对方已查看附件简历',
      text: '对方已查看了您的附件简历',
    },
  ].map(Object.freeze),
);
export const RESUME_KINDS = Object.freeze(RESUME_RULES.map((rule) => rule.kind));
export const RESUME_SUMMARIES = Object.freeze(RESUME_RULES.map((rule) => rule.summary));
export const RESUME_STATUS_KINDS = Object.freeze(
  RESUME_RULES.filter((rule) => rule.target).map((rule) => rule.kind),
);

export function resumeRule(value) {
  const rule = RESUME_RULES.find((rule) => rule.kind === value || rule.summary === value);
  if (!rule) throw new Error('RESUME_OBSERVATION_UNKNOWN');
  return rule;
}

// Self-contained functions can also run inside deterministic collector expressions.
// rules is passed explicitly there; no browser/module globals or private data needed.
export function classifyResumeText(text, rules) {
  if (typeof text !== 'string') return null;
  const value = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  return (
    rules.find(
      (rule) =>
        (rule.text && rule.text === value) ||
        (rule.pattern && new RegExp(rule.pattern).test(value)),
    )?.kind ?? null
  );
}

export function classifyResumeMessage(message, bossId, rules, classifyText) {
  const body = message?.body;
  const sender = ['string', 'number'].includes(typeof message?.from?.uid)
    ? String(message.from.uid).normalize('NFC').trim()
    : null;
  if (
    Number(message?.type) === 4 &&
    Number(message?.bizType) === 317 &&
    Number(body?.type) === 16 &&
    Number(body?.style) === 3 &&
    Number(body?.templateId) === 1 &&
    Array.isArray(body?.articles) &&
    body.articles.length === 1 &&
    sender &&
    sender === bossId
  )
    return rules.find((rule) => rule.structured)?.kind ?? null;
  if ([1, 4].includes(Number(message?.type))) return null;
  for (const value of [
    message?.text,
    message?.content,
    message?.title,
    message?.description,
    body?.text,
    body?.content,
    body?.title,
    body?.description,
    body?.card?.text,
    body?.card?.content,
    body?.card?.title,
  ]) {
    const kind = classifyText(value, rules);
    if (kind) return kind;
  }
  return null;
}

// Call only after verifying the observation's opportunity and field ownership.
// This function decides state transitions, never conversation/job attribution.
export function resumeTransition(current, summary) {
  const { target } = resumeRule(summary);
  if (!target) return { outcome: 'observation_only', target: null };
  if (!RESUME_STATES.includes(current)) return { outcome: 'protected', target };
  if (current === target || (target === RESUME_STATE.SENT && current === RESUME_STATE.RECEIVED))
    return { outcome: 'supported', target };
  const allowed =
    target === RESUME_STATE.SENT
      ? [RESUME_STATE.UNKNOWN, RESUME_STATE.REQUESTED]
      : [RESUME_STATE.UNKNOWN, RESUME_STATE.REQUESTED, RESUME_STATE.SENT];
  return { outcome: allowed.includes(current) ? 'advance' : 'protected', target };
}
