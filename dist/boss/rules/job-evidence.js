// Modern evidence decisions and the frozen legacy identity projection share
// exact matching, ordering and confirmation. The legacy policy preserves hash
// inputs for persisted resume and initial/date facts; it is not application authority.
const PROJECTIONS = new Set(['collector', 'detail_delivery', 'legacy_identity']);
const normalize = (value) =>
  String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();

export function bossDetailSignature(detail) {
  return JSON.stringify([normalize(detail.name), normalize(detail.company)]);
}

/** Pure selection over validated material. Association/record eligibility stays
 * with callers; this decision never establishes attribution or changes evidence. */
export function resolveBossJobEvidence(
  { association, conversation, evidence, confirmations },
  projection,
) {
  if (!PROJECTIONS.has(projection)) throw new TypeError('BOSS_JOB_EVIDENCE_PROJECTION_INVALID');
  const legacy = projection === 'legacy_identity';
  const rank = new Map([
    ['detail_page_title', legacy ? 2 : 3],
    ['loaded_jobName', legacy ? 3 : 2],
    ['legacy_named_job', 1],
  ]);
  const ranked = association
    ? evidence
        .filter(
          (item) => item.jobId === association.jobId && item.detailUrl === association.detailUrl,
        )
        .sort(
          (a, b) =>
            (rank.get(b.source) ?? 0) - (rank.get(a.source) ?? 0) ||
            Date.parse(b.observedAt) - Date.parse(a.observedAt),
        )
    : [];
  const details = ranked.filter((item) => item.source === 'detail_page_title');
  const conflict = legacy
    ? details.some((item) => item.name !== details[0].name || item.company !== details[0].company)
    : new Set(details.map(bossDetailSignature)).size > 1;
  const company = legacy ? conversation.company.trim() : null;
  const nameConflict = legacy
    ? ranked.some((item) => item.company.trim() && item.company.trim() !== company)
    : conflict;
  const selected = legacy
    ? (ranked.find((item) => !item.company.trim() || item.company.trim() === company) ?? null)
    : conflict
      ? null
      : (ranked[0] ?? null);
  const confirmed = Boolean(
    association &&
    confirmations.some(
      (item) =>
        item.conversationKey === conversation.key &&
        item.jobId === association.jobId &&
        item.detailUrl === association.detailUrl &&
        item.status === 'confirmed_user',
    ),
  );
  const fallback =
    projection === 'collector'
      ? null
      : !legacy && nameConflict
        ? ''
        : (conversation.observedJobName ?? '');
  const fallbackSource =
    projection === 'collector'
      ? null
      : !legacy && nameConflict
        ? ''
        : conversation.observedJobName
          ? 'loaded_jobName'
          : '';
  return {
    evidence: ranked,
    selected,
    conflict,
    nameConflict,
    confirmed,
    jobName: selected?.name ?? fallback,
    nameSource: selected?.source ?? fallbackSource,
    jobDetails: !details.length
      ? null
      : {
          jobId: association.jobId,
          canonicalUrl: association.detailUrl,
          jobName: conflict || !details[0].company?.trim() ? '' : details[0].name,
          company: conflict || !details[0].company?.trim() ? '' : details[0].company,
          source:
            conflict || !details[0].company?.trim() ? 'detail_page_conflict' : 'detail_page_title',
        },
  };
}
