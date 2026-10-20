import { isDeepStrictEqual } from 'node:util';

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function streamKey(evidence) {
  if (
    !object(evidence) ||
    evidence.source !== 'loaded_jobName' ||
    ['conversationKey', 'jobId', 'detailUrl'].some(
      (field) => typeof evidence[field] !== 'string' || !evidence[field],
    )
  )
    return null;
  return JSON.stringify([
    evidence.conversationKey,
    evidence.jobId,
    evidence.detailUrl,
    evidence.source,
  ]);
}

function semanticFacts(evidence) {
  return Object.fromEntries(
    Object.entries(evidence).filter(([key]) => !['id', 'observedAt'].includes(key)),
  );
}

/** Keep both endpoints of each unchanged run, preserving every value transition. */
export function compactJobEvidenceHistory(evidence) {
  if (!Array.isArray(evidence)) throw new TypeError('job evidence must be an array');
  const streams = new Map();
  const keep = new Set();
  for (const [index, record] of evidence.entries()) {
    const key = streamKey(record);
    if (key === null) {
      keep.add(index);
      continue;
    }
    const entries = streams.get(key) ?? [];
    entries.push({
      index,
      record,
      at: typeof record.observedAt === 'string' ? Date.parse(record.observedAt) : NaN,
    });
    streams.set(key, entries);
  }
  for (const entries of streams.values()) {
    // Malformed material is left intact for the existing schema validator.
    if (entries.some((entry) => !Number.isFinite(entry.at))) {
      for (const entry of entries) keep.add(entry.index);
      continue;
    }
    entries.sort((a, b) => a.at - b.at || a.index - b.index);
    // Equal instants can use different ISO spellings. Preserve every tie so
    // stable evidence selection keeps its original record and timestamp text.
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1].at === entries[index].at) {
        keep.add(entries[index - 1].index);
        keep.add(entries[index].index);
      }
    }
    let first = null;
    let latest = null;
    let facts = null;
    const keepRun = () => {
      if (first) {
        keep.add(first.index);
        keep.add(latest.index);
      }
    };
    for (const entry of entries) {
      const currentFacts = semanticFacts(entry.record);
      if (!latest || !isDeepStrictEqual(facts, currentFacts)) {
        keepRun();
        first = entry;
        facts = currentFacts;
      }
      latest = entry;
    }
    keepRun();
  }
  return evidence.filter((_, index) => keep.has(index));
}

/** Copy the container without rebuilding or discarding unrelated/unknown fields. */
export function compactSnapshotJobEvidenceHistory(envelope) {
  const current = structuredClone(envelope);
  if (
    object(current) &&
    [2, 3, 4, 5, 6, 7, 8].includes(current.version) &&
    object(current.jobs) &&
    ['associations', 'evidence', 'candidates', 'confirmations'].every((field) =>
      Array.isArray(current.jobs[field]),
    )
  ) {
    current.jobs.evidence = compactJobEvidenceHistory(current.jobs.evidence);
  }
  return current;
}
