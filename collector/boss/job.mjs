import { parseBossJobUrl } from '../../dist/boss-job-url.js';
export function unknownJob() {
  return { name: null, detailUrl: null, source: null };
}

// Accept only a real, observed same-site detail href. A chat/security ID or a
// search result guessed from the company name must never be converted to a URL.
export function normalizeJobCandidate(candidate) {
  if (!candidate || !['chat_list', 'selected_chat_card'].includes(candidate.source))
    return unknownJob();
  const name = typeof candidate.name === 'string' ? candidate.name.replace(/\s+/g, ' ').trim() : '';
  if (name.length > 300) return unknownJob();
  let detailUrl = null;
  if (typeof candidate.href === 'string' && candidate.href.trim()) {
    const parsed = parseBossJobUrl(candidate.href, { relative: true });
    if (!parsed) return unknownJob();
    detailUrl = parsed.canonicalUrl;
  }
  if (!name && !detailUrl) return unknownJob();
  return { name: name || null, detailUrl, source: candidate.source };
}

export function chooseJob(candidates) {
  if (!Array.isArray(candidates)) return unknownJob();
  const jobs = candidates.map(normalizeJobCandidate).filter((job) => job.source);
  const unique = new Map(jobs.map((job) => [JSON.stringify(job), job]));
  return unique.size === 1 ? [...unique.values()][0] : unknownJob();
}

export function jobCounts(records) {
  const counts = { named: 0, linked: 0, complete: 0, unknown: 0 };
  for (const record of records) {
    const job = record.job ?? unknownJob();
    if (job.name) counts.named += 1;
    if (job.detailUrl) counts.linked += 1;
    if (job.name && job.detailUrl) counts.complete += 1;
    if (!job.name && !job.detailUrl) counts.unknown += 1;
  }
  return counts;
}
