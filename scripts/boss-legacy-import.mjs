import { basename } from 'node:path';
import { resolveJobRows, eventFacts, createEvents, createBatch } from './boss-conversion.mjs';
import { integrationFail } from './boss-integration-error.mjs';
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INITIAL_POLICY = 'boss-initial-2026-09-18-v1';
const INITIAL_SNAPSHOT_NAME = '2026-09-18T14-49-59-473Z_ae82d08d-b89d-46a4-b8ec-cb855214bd5a.json';
const INITIAL_SNAPSHOT_SHA256 = '697f1d35c3c9f0920709ce8be86535b9581877b2aaf435fc0bb1eb0a160a6f65';
const INITIAL_DATE = '2026-09-18';
const TIMEZONE = 'Asia/Shanghai';
const YESTERDAY_LABEL = '昨天';
function classifyTimeLabel(label) {
  if (HH_MM.test(label)) return 'explicitTime';
  if (label === '昨天') return 'yesterday';
  if (label === '') return 'unknownTime';
  return 'otherTime';
}

export function previewInitialEnvelope(envelope) {
  const rows = resolveJobRows(envelope);
  const counts = {
    total: rows.length,
    included: 0,
    excludedYesterday: 0,
    unknownTime: 0,
    otherTime: 0,
    complete: 0,
    review: 0,
  };
  for (const row of rows) {
    const category = classifyTimeLabel(row.record.timeLabel);
    if (category === 'explicitTime') counts.included += 1;
    else if (category === 'yesterday') counts.excludedYesterday += 1;
    else counts[category] += 1;
    if (category === 'explicitTime') {
      const facts = eventFacts(row, envelope.accountNamespace);
      if (facts.intent === 'create_or_link' && facts.messageId) counts.complete += 1;
      else counts.review += 1;
    }
  }
  return counts;
}

export function createInitialBatch(snapshot, sourceSequence) {
  const policy = {
    id: INITIAL_POLICY,
    mode: 'initial',
    timezone: TIMEZONE,
    appliedAtForNew: INITIAL_DATE,
    autoCreateComplete: true,
  };
  const events = createEvents(snapshot.envelope, {
    sourceSequence,
    evidenceDate: INITIAL_DATE,
    appliedAtForNew: INITIAL_DATE,
  }).filter((event) => HH_MM.test(event.timeLabel));
  return createBatch({
    envelope: snapshot.envelope,
    snapshotName: basename(snapshot.path),
    snapshotSha256: snapshot.sha256,
    sourceSequence,
    policy,
    events,
  });
}

export function createDatedYesterdayBatch(snapshot, sourceSequence, evidenceDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(evidenceDate)) integrationFail('BOSS_EVIDENCE_DATE_INVALID');
  const parsed = new Date(`${evidenceDate}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== evidenceDate)
    integrationFail('BOSS_EVIDENCE_DATE_INVALID');
  const policy = {
    id: `boss-user-dated-label-${evidenceDate}-v1`,
    mode: 'dated',
    timezone: TIMEZONE,
    appliedAtForNew: evidenceDate,
    autoCreateComplete: true,
  };
  const events = createEvents(snapshot.envelope, {
    sourceSequence,
    evidenceDate,
    appliedAtForNew: evidenceDate,
  }).filter((event) => event.timeLabel === YESTERDAY_LABEL);
  if (!events.length) integrationFail('BOSS_DATED_LABEL_EMPTY');
  return createBatch({
    envelope: snapshot.envelope,
    snapshotName: basename(snapshot.path),
    snapshotSha256: snapshot.sha256,
    sourceSequence,
    policy,
    events,
  });
}

export const APPROVED_INITIAL = Object.freeze({
  name: INITIAL_SNAPSHOT_NAME,
  sha256: INITIAL_SNAPSHOT_SHA256,
});
export function assertInitialScope(counts) {
  if (
    counts.included !== 30 ||
    counts.excludedYesterday !== 10 ||
    counts.unknownTime !== 60 ||
    counts.otherTime !== 0 ||
    counts.complete !== 30 ||
    counts.review !== 0
  )
    integrationFail('BOSS_INITIAL_SCOPE_MISMATCH', { fatal: true });
}
