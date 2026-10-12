import { createHash } from 'node:crypto';
import { accountExpression, accountNamespace } from './extract.mjs';
import { expectedUrl } from './guard.mjs';

// Public static code reviewed separately from private history evidence. URL
// discovery does not prove that the currently loaded bytes still have this hash.
export const REVIEWED_PLATFORM_REFERENCE = Object.freeze({
  version: 1,
  referenceId: 'boss-chat-v5550-4d4a6ac8',
  platformContract: 'boss-action40-v5550-4d4a6ac8',
  platformBuild: 'v5550',
  assetVersion: '4d4a6ac8',
  rawHistoryVerified: false,
  scripts: Object.freeze([
    Object.freeze({
      role: 'app',
      url: 'https://static.zhipin.com/fe-zhipin-geek/web/chat-new/v5550/static/js/app.4d4a6ac8.js',
      sha256: '4af4cb03e5db9c61dd841db1c55cb7ccd9d089afc48e0cb11ee967b20c801ebf',
      bytes: 3985739,
    }),
    Object.freeze({
      role: 'chat',
      url: 'https://static.zhipin.com/fe-zhipin-geek/web/chat-new/v5550/static/js/chat.4d4a6ac8.js',
      sha256: '7a6e63ced157e70fdb4a237209f26a512873d8047164a9919393bffcf7d5d953',
      bytes: 340499,
    }),
  ]),
});

export function parsePublicPlatformScriptUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'static.zhipin.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== value
    )
      return null;
    const match =
      /^\/fe-zhipin-geek\/web\/chat-new\/(v[0-9]{1,10})\/static\/js\/(app|chat)\.([a-f0-9]{8,64})\.js$/.exec(
        url.pathname,
      );
    if (!match) return null;
    return { role: match[2], url: value, platformBuild: match[1], assetVersion: match[3] };
  } catch {
    return null;
  }
}

export const LOADED_PLATFORM_SCRIPT_URLS_EXPRESSION = `(() => {
  const url = location.origin + location.pathname;
  if (url !== ${JSON.stringify(expectedUrl)}) return {ok:false, reason:'WRONG_PAGE'};
  const parse = ${parsePublicPlatformScriptUrl.toString()};
  const loadedScriptUrls = [], seen = new Set();
  const add = value => {
    const script = parse(value);
    if (script && !seen.has(script.url)) {
      seen.add(script.url); loadedScriptUrls.push(script.url);
    }
  };
  try {
    const scripts = Array.from(document.scripts ?? []);
    const resources = performance.getEntriesByType('resource');
    if (scripts.length > 10000 || !Array.isArray(resources) || resources.length > 10000)
      return {ok:false, reason:'PLATFORM_REFERENCE_UNAVAILABLE'};
    for (const script of scripts) add(script.src);
    for (const resource of resources) if (resource.initiatorType === 'script') add(resource.name);
    if (loadedScriptUrls.length > 100) return {ok:false, reason:'PLATFORM_REFERENCE_UNAVAILABLE'};
    return {ok:true, url, loadedScriptUrls};
  } catch {
    return {ok:false, reason:'PLATFORM_REFERENCE_UNAVAILABLE'};
  }
})()`;

// evaluateBound verifies the saved browser instance and target before and after
// this expression; the two existing identity reads protect the account too.
export const PLATFORM_REFERENCE_EXPRESSION = `(() => {
  const before = (${accountExpression});
  if (!before?.ok) return {ok:false, reason:before?.reason ?? 'ACCOUNT_ID_UNVERIFIED'};
  const reference = (${LOADED_PLATFORM_SCRIPT_URLS_EXPRESSION});
  const after = (${accountExpression});
  if (!after?.ok) return {ok:false, reason:after?.reason ?? 'ACCOUNT_ID_UNVERIFIED'};
  if (before.accountId !== after.accountId) return {ok:false, reason:'ACCOUNT_NAMESPACE_CHANGED'};
  return {ok:true, beforeAccountId:before.accountId, afterAccountId:after.accountId, reference};
})()`;

export function assessLoadedPlatformReference(urls) {
  const scripts =
    Array.isArray(urls) && urls.length <= 100
      ? [...new Set(urls)].map(parsePublicPlatformScriptUrl).filter(Boolean)
      : [];
  scripts.sort((a, b) => a.role.localeCompare(b.role) || a.url.localeCompare(b.url));
  const complete = ['app', 'chat'].every(
    (role) => scripts.filter((item) => item.role === role).length === 1,
  );
  const known =
    complete &&
    scripts.every((item) =>
      REVIEWED_PLATFORM_REFERENCE.scripts.some((reviewed) => reviewed.url === item.url),
    );
  const status = known ? 'known' : complete ? 'changed' : 'unavailable';
  return {
    version: 1,
    status,
    referenceId: known ? REVIEWED_PLATFORM_REFERENCE.referenceId : null,
    platformContract: known ? REVIEWED_PLATFORM_REFERENCE.platformContract : null,
    basis: known ? 'reviewed_url' : 'loaded_url_comparison',
    contentVerified: false,
    opaqueActionAllowed: known,
    reason: known
      ? null
      : status === 'changed'
        ? 'PLATFORM_REFERENCE_CHANGED'
        : 'PLATFORM_REFERENCE_UNAVAILABLE',
    scripts: scripts.map((item) => ({
      ...item,
      reviewedSha256:
        REVIEWED_PLATFORM_REFERENCE.scripts.find((reviewed) => reviewed.url === item.url)?.sha256 ??
        null,
    })),
  };
}

export async function readLoadedPlatformReference({ connection, evaluate }) {
  const payload = await evaluate(connection, PLATFORM_REFERENCE_EXPRESSION, {
    kind: 'platform_reference',
  });
  if (!payload?.ok) throw new Error(payload?.reason ?? 'PLATFORM_REFERENCE_RESPONSE_INVALID');
  let before, after;
  try {
    before = accountNamespace(payload.beforeAccountId);
    after = accountNamespace(payload.afterAccountId);
  } catch {
    throw new Error('ACCOUNT_ID_UNVERIFIED');
  }
  if (before !== connection.accountNamespace || after !== connection.accountNamespace)
    throw new Error('ACCOUNT_NAMESPACE_CHANGED');
  if (!payload.reference?.ok) {
    if (payload.reference?.reason === 'WRONG_PAGE') throw new Error('WRONG_PAGE');
    return assessLoadedPlatformReference([]);
  }
  return assessLoadedPlatformReference(payload.reference.loadedScriptUrls);
}

// Explicit diagnostics may fingerprint bytes already obtained from a public
// resource. This helper performs no I/O, stores no source and grants no contract.
export function fingerprintPublicPlatformBytes(url, bytes) {
  const script = parsePublicPlatformScriptUrl(url);
  if (
    !script ||
    !(bytes instanceof Uint8Array) ||
    !bytes.byteLength ||
    bytes.byteLength > 8 * 1024 * 1024
  )
    throw new Error('PLATFORM_REFERENCE_INPUT_INVALID');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('PUBLIC_SCRIPT_UTF8_INVALID');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const reviewed = REVIEWED_PLATFORM_REFERENCE.scripts.find((item) => item.url === script.url);
  return {
    ...script,
    sha256,
    bytes: bytes.byteLength,
    hashBasis: 'raw_bytes_sha256',
    contentMatchesReviewed: reviewed?.sha256 === sha256,
  };
}
