import { BOSS_JOB_ID, parseBossJobUrl, isCanonicalBossJobUrl } from '../../dist/boss-job-url.js';
import { parseBossDetailTitle } from '../../dist/boss-detail-title.js';
export { parseBossDetailTitle };
import { randomUUID } from 'node:crypto';

export const MAX_DETAIL_ENRICH_JOBS = 20;
export const DETAIL_NAVIGATION_DELAY_MS = 10_000;
import { setTimeout as delay } from 'node:timers/promises';

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const LOGIN_OR_SECURITY =
  /(?:\/passport(?:\/|$)|\/login(?:\/|$)|\/security(?:\/|$)|\/captcha(?:\/|$)|\/web\/user(?:\/|$)|[?&][^#]*login)/i;

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
}

function text(value, path, max = 300) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > max) {
    throw new TypeError(
      `${path} must be a nonempty trimmed string no longer than ${max} characters`,
    );
  }
  return value;
}

function time(value, path) {
  if (typeof value !== 'string' || !ISO_TIME.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${path} must be an ISO timestamp`);
  }
  return value;
}

function detailUrl(value, path) {
  if (typeof value !== 'string' || !isCanonicalBossJobUrl(value) || new URL(value).href !== value) {
    throw new TypeError(`${path} must be a canonical BOSS job-detail URL`);
  }
  return value;
}

function jobIdFromUrl(value) {
  return parseBossJobUrl(value)?.jobId ?? null;
}

function safeCode(error, fallback) {
  const candidate = error && typeof error === 'object' ? (error.code ?? error.message) : null;
  return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(candidate)
    ? candidate
    : fallback;
}

function validateAdapter(adapter) {
  object(adapter, 'adapter');
  for (const name of ['createOwnedTab', 'readOwnedTab', 'navigateOwnedTab', 'closeOwnedTab']) {
    if (typeof adapter[name] !== 'function')
      throw new TypeError(`adapter.${name} must be a function`);
  }
}

function normalizeCandidate(value, index) {
  const path = `candidates[${index}]`;
  object(value, path);
  const conversationKey = text(value.conversationKey, `${path}.conversationKey`, 1000);
  const jobId = text(value.jobId, `${path}.jobId`, 256);
  if (!BOSS_JOB_ID.test(jobId)) throw new TypeError(`${path}.jobId is invalid`);
  const url = detailUrl(value.detailUrl, `${path}.detailUrl`);
  if (jobIdFromUrl(url) !== jobId) throw new TypeError(`${path}.jobId does not match detailUrl`);
  const company = text(value.company, `${path}.company`);
  if (value.jobName !== null && value.jobName !== undefined) text(value.jobName, `${path}.jobName`);
  return {
    conversationKey,
    jobId,
    company,
    detailUrl: url,
    jobName: value.jobName ?? null,
  };
}

function normalizeEvidence(value, index) {
  const path = `knownEvidence[${index}]`;
  object(value, path);
  const jobId = text(value.jobId, `${path}.jobId`, 256);
  if (!BOSS_JOB_ID.test(jobId)) throw new TypeError(`${path}.jobId is invalid`);
  const url = detailUrl(value.detailUrl, `${path}.detailUrl`);
  if (jobIdFromUrl(url) !== jobId) throw new TypeError(`${path}.jobId does not match detailUrl`);
  const name = text(value.name, `${path}.name`);
  const observedCompany = text(value.observedCompany, `${path}.observedCompany`);
  const title = text(value.title, `${path}.title`, 1000);
  const observedAt = time(value.observedAt, `${path}.observedAt`);
  if (value.source !== 'detail_page_title') throw new TypeError(`${path}.source is invalid`);
  const parsed = parseBossDetailTitle(title);
  if (!parsed || parsed.name !== name || parsed.company !== observedCompany) {
    throw new TypeError(`${path}.title does not verify its name and company`);
  }
  return { jobId, detailUrl: url, name, observedCompany, title, observedAt, source: value.source };
}

function normalizeHandle(value, ownerToken) {
  object(value, 'adapter.createOwnedTab result');
  if (value.ownerToken !== ownerToken)
    throw Object.assign(new Error('DETAIL_TAB_OWNERSHIP_MISMATCH'), {
      code: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
    });
  const tabId = text(String(value.tabId ?? ''), 'detail tab id', 200);
  const windowId = text(String(value.windowId ?? ''), 'detail window id', 200);
  return { ...value, ownerToken, tabId, windowId };
}

function normalizeRead(value, handle) {
  object(value, 'adapter.readOwnedTab result');
  if (
    value.ownerToken !== handle.ownerToken ||
    String(value.tabId ?? '') !== handle.tabId ||
    String(value.windowId ?? '') !== handle.windowId
  ) {
    throw Object.assign(new Error('DETAIL_TAB_OWNERSHIP_MISMATCH'), {
      code: 'DETAIL_TAB_OWNERSHIP_MISMATCH',
    });
  }
  if (
    typeof value.url !== 'string' ||
    typeof value.title !== 'string' ||
    (Object.hasOwn(value, 'documentReady') && typeof value.documentReady !== 'boolean')
  ) {
    throw Object.assign(new Error('DETAIL_TAB_READ_INVALID'), { code: 'DETAIL_TAB_READ_INVALID' });
  }
  return { url: value.url, title: value.title, documentReady: value.documentReady !== false };
}

function groupCandidates(candidates) {
  const byConversation = new Set();
  const byJob = new Map();
  for (const candidate of candidates) {
    if (byConversation.has(candidate.conversationKey))
      throw new TypeError('candidates contain a duplicate conversationKey');
    byConversation.add(candidate.conversationKey);
    const prior = byJob.get(candidate.jobId);
    if (prior && prior.detailUrl !== candidate.detailUrl)
      throw new TypeError('one jobId maps to multiple detail URLs');
    const group = prior ?? {
      jobId: candidate.jobId,
      detailUrl: candidate.detailUrl,
      candidates: [],
    };
    group.candidates.push(candidate);
    byJob.set(candidate.jobId, group);
  }
  return [...byJob.values()];
}

function classify(group, evidence, reused) {
  const accepted = [];
  const candidates = [];
  for (const item of group.candidates) {
    const common = {
      conversationKey: item.conversationKey,
      jobId: group.jobId,
      company: item.company,
      detailUrl: group.detailUrl,
      name: evidence.name,
      observedAt: evidence.observedAt,
      source: evidence.source,
      title: evidence.title,
      evidence: { ...evidence },
      reused,
    };
    accepted.push({ ...common, company: evidence.observedCompany, status: 'accepted' });
  }
  return { accepted, candidates };
}

async function stableEvidence({
  adapter,
  handle,
  targetUrl,
  maxReads,
  pollMs,
  stableReads,
  wait,
  now,
}) {
  let previousTitle = null;
  let repeats = 0;
  let lastState = null;
  for (let attempt = 0; attempt < maxReads; attempt += 1) {
    if (attempt) await wait(pollMs);
    const state = normalizeRead(await adapter.readOwnedTab(handle), handle);
    lastState = state;
    if (LOGIN_OR_SECURITY.test(state.url)) {
      return {
        halt: { code: 'VERIFICATION_OR_LOGIN_REQUIRED', stage: 'read', url: state.url },
        state,
        owned: true,
      };
    }
    if (state.url !== targetUrl) {
      if (state.url === 'about:blank') continue;
      return {
        halt: { code: 'DETAIL_TAB_UNEXPECTED_URL', stage: 'read', url: state.url },
        state,
        owned: true,
      };
    }
    if (!state.documentReady) {
      previousTitle = null;
      repeats = 0;
      continue;
    }
    const parsed = parseBossDetailTitle(state.title);
    if (!parsed) {
      previousTitle = null;
      repeats = 0;
      continue;
    }
    if (state.title === previousTitle) repeats += 1;
    else {
      previousTitle = state.title;
      repeats = 1;
    }
    if (repeats >= stableReads) {
      const observedAt = now();
      time(observedAt, 'now() result');
      return {
        evidence: {
          name: parsed.name,
          observedCompany: parsed.company,
          title: state.title,
          detailUrl: targetUrl,
          observedAt,
          source: 'detail_page_title',
        },
        state,
        owned: true,
      };
    }
  }
  return {
    failure: { code: 'DETAIL_TITLE_NOT_READY', stage: 'read' },
    state: lastState,
    owned: true,
  };
}

/**
 * Collect independently timed detail-title evidence without touching a chat tab.
 *
 * The injected adapter owns all native browser operations. It must create a new
 * task-owned tab and echo ownerToken/tabId/windowId on every read. Operational
 * failures are returned with partial results; invalid caller data throws before
 * creating a tab. `limit` counts unique jobs that require a browser read.
 */
export async function collectDetailTitleEvidence({
  candidates,
  knownEvidence = [],
  limit,
  adapter,
  maxReads = 40,
  pollMs = 700,
  stableReads = 2,
  navigationDelayMs = 0,
  wait = delay,
  now = () => new Date().toISOString(),
  makeOwnerToken = randomUUID,
}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  if (!Array.isArray(knownEvidence)) throw new TypeError('knownEvidence must be an array');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DETAIL_ENRICH_JOBS) {
    throw new TypeError(`limit must be an integer from 1 to ${MAX_DETAIL_ENRICH_JOBS}`);
  }
  if (!Number.isInteger(maxReads) || maxReads < 1 || maxReads > 200)
    throw new TypeError('maxReads must be an integer from 1 to 200');
  if (!Number.isInteger(stableReads) || stableReads < 2 || stableReads > maxReads)
    throw new TypeError('stableReads must be between 2 and maxReads');
  if (!Number.isInteger(pollMs) || pollMs < 0 || pollMs > 60_000)
    throw new TypeError('pollMs is invalid');
  if (
    !Number.isInteger(navigationDelayMs) ||
    navigationDelayMs < 0 ||
    navigationDelayMs > 300_000
  ) {
    throw new TypeError('navigationDelayMs is invalid');
  }
  if (
    typeof wait !== 'function' ||
    typeof now !== 'function' ||
    typeof makeOwnerToken !== 'function'
  ) {
    throw new TypeError('wait, now and makeOwnerToken must be functions');
  }
  validateAdapter(adapter);
  const normalized = candidates.map(normalizeCandidate);
  const groups = groupCandidates(normalized);
  const evidenceByJob = new Map();
  for (const [index, item] of knownEvidence.map(normalizeEvidence).entries()) {
    if (evidenceByJob.has(item.jobId))
      throw new TypeError(`knownEvidence[${index}] duplicates a jobId`);
    evidenceByJob.set(item.jobId, item);
  }

  const result = {
    observations: [],
    candidates: [],
    failures: [],
    skipped: [],
    remaining: [],
    halted: null,
    cleanup: { status: 'not_needed' },
  };
  const browse = [];
  for (const group of groups) {
    const unnamed = group.candidates.filter((item) => !item.jobName);
    if (!unnamed.length) {
      result.skipped.push(
        ...group.candidates.map((item) => ({
          conversationKey: item.conversationKey,
          jobId: item.jobId,
          status: 'already_named',
        })),
      );
      continue;
    }
    const active = { ...group, candidates: unnamed };
    const cached = evidenceByJob.get(group.jobId);
    if (cached) {
      if (cached.detailUrl !== group.detailUrl)
        throw new TypeError('known evidence URL conflicts with a candidate');
      const classified = classify(active, cached, true);
      result.observations.push(...classified.accepted);
      result.candidates.push(...classified.candidates);
      continue;
    }
    if (browse.length < limit) browse.push(active);
    else
      result.remaining.push(
        ...unnamed.map((item) => ({
          conversationKey: item.conversationKey,
          jobId: item.jobId,
          detailUrl: item.detailUrl,
        })),
      );
  }

  if (!browse.length) {
    result.counts = counts(result, 0);
    return result;
  }

  const ownerToken = text(makeOwnerToken(), 'makeOwnerToken() result', 200);
  let handle = null;
  let currentUrl = null;
  let owned = false;
  let attemptedJobs = 0;
  try {
    try {
      handle = normalizeHandle(
        await adapter.createOwnedTab({ ownerToken, initialUrl: browse[0].detailUrl }),
        ownerToken,
      );
      owned = true;
    } catch (error) {
      attemptedJobs = 1;
      result.halted = {
        code: safeCode(error, 'DETAIL_TAB_CREATE_FAILED'),
        stage: 'create',
        jobId: browse[0].jobId,
      };
      result.remaining.unshift(
        ...browse.flatMap((group) =>
          group.candidates.map((item) => ({
            conversationKey: item.conversationKey,
            jobId: item.jobId,
            detailUrl: item.detailUrl,
          })),
        ),
      );
      result.counts = counts(result, attemptedJobs);
      return result;
    }

    for (const group of browse) {
      attemptedJobs += 1;
      if (result.halted) break;
      let stage = 'read';
      try {
        if (currentUrl !== null && currentUrl !== group.detailUrl) {
          if (navigationDelayMs) await wait(navigationDelayMs);
          stage = 'navigate';
          await adapter.navigateOwnedTab(handle, {
            ownerToken,
            expectedUrl: currentUrl,
            nextUrl: group.detailUrl,
          });
        }
        stage = 'read';
        const observed = await stableEvidence({
          adapter,
          handle,
          targetUrl: group.detailUrl,
          maxReads,
          pollMs,
          stableReads,
          wait,
          now,
        });
        currentUrl = observed.state?.url ?? currentUrl;
        owned = observed.owned !== false;
        if (observed.halt) {
          result.halted = { ...observed.halt, jobId: group.jobId };
          break;
        }
        if (observed.failure) {
          result.failures.push({
            jobId: group.jobId,
            detailUrl: group.detailUrl,
            ...observed.failure,
          });
          continue;
        }
        const evidence = { jobId: group.jobId, ...observed.evidence };
        const classified = classify(group, evidence, false);
        result.observations.push(...classified.accepted);
        result.candidates.push(...classified.candidates);
      } catch (error) {
        const code = safeCode(error, 'DETAIL_UNKNOWN_OPERATION_FAILED');
        if (code === 'DETAIL_TAB_OWNERSHIP_MISMATCH') owned = false;
        result.halted = { code, stage, jobId: group.jobId };
      }
    }

    if (result.halted) {
      const attempted = new Set(browse.slice(0, attemptedJobs).map((group) => group.jobId));
      for (const group of browse) {
        if (attempted.has(group.jobId)) continue;
        result.remaining.push(
          ...group.candidates.map((item) => ({
            conversationKey: item.conversationKey,
            jobId: item.jobId,
            detailUrl: item.detailUrl,
          })),
        );
      }
    }
  } finally {
    if (handle && owned && currentUrl) {
      try {
        await adapter.closeOwnedTab(handle, { ownerToken, expectedUrl: currentUrl });
        result.cleanup = { status: 'closed' };
      } catch (error) {
        const reason = safeCode(error, 'DETAIL_TAB_CLOSE_NOT_VERIFIED');
        result.cleanup = { status: 'skipped', stage: 'close', reason };
        if (!result.halted)
          result.halted = {
            code: reason,
            stage: 'close',
            jobId: browse[Math.max(0, attemptedJobs - 1)].jobId,
          };
      }
    } else if (handle) {
      result.cleanup = { status: 'skipped', reason: 'DETAIL_TAB_OWNERSHIP_NOT_VERIFIED' };
    }
  }
  result.counts = counts(result, attemptedJobs);
  return result;
}

function counts(result, attemptedJobs) {
  return {
    attemptedJobs,
    accepted: result.observations.length,
    candidates: result.candidates.length,
    failures: result.failures.length,
    skipped: result.skipped.length,
    remaining: result.remaining.length,
  };
}
