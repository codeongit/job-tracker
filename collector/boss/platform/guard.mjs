export const expectedUrl = 'https://www.zhipin.com/web/geek/chat';

export const guardedRead = `(() => {
  const url = location.origin + location.pathname;
  if (url !== ${JSON.stringify(expectedUrl)}) {
    return {ok: false, reason: 'WRONG_PAGE'};
  }
  const nodes = Array.from(document.querySelectorAll('li[role="listitem"]'));
  const rows = nodes.slice(0, 100).map(node => node.innerText.trim()).filter(Boolean);
  const text = document.body?.innerText ?? '';
  const hasChatFilters = text.includes('未读') && text.includes('新招呼');
  if (!hasChatFilters || rows.length === 0) {
    return {ok: false, reason: 'CHAT_LIST_NOT_READY'};
  }
  return {
    ok: true, url, timeOrigin: performance.timeOrigin,
    visibility: document.visibilityState, documentFocused: document.hasFocus(),
    loadedRows: nodes.length, checkedRows: rows.length, rows
  };
})()`;

export function isExpectedUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname === expectedUrl;
  } catch {
    return false;
  }
}

export function selectBoundPage(tabs) {
  if (
    !Array.isArray(tabs) ||
    tabs.length !== 1 ||
    !isExpectedUrl(tabs[0].url) ||
    typeof tabs[0].page !== 'string' ||
    !tabs[0].page
  ) {
    throw new Error('BOUND_TARGET_NOT_UNIQUE_OR_WRONG_PAGE');
  }
  return tabs[0].page;
}

export function parseNativeSnapshot(text) {
  const result = {
    browserRunning: null,
    enumerationComplete: null,
    targets: [],
    queryErrors: [],
    changes: [],
  };
  const targets = new Map();
  const invalid = () => {
    throw new Error('NATIVE_TARGET_METADATA_INVALID');
  };
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const p = line.split('|');
    if (
      p[0] === 'state' &&
      p.length === 2 &&
      ['running', 'not_running'].includes(p[1]) &&
      result.browserRunning === null
    ) {
      result.browserRunning = p[1] === 'running';
    } else if (
      p[0] === 'complete' &&
      p.length === 2 &&
      ['true', 'false'].includes(p[1]) &&
      result.enumerationComplete === null
    ) {
      result.enumerationComplete = p[1] === 'true';
    } else if (p[0] === 'target' && p.length === 3 && p.slice(1).every((v) => /^\d+$/.test(v))) {
      if (targets.has(p[1])) invalid();
      targets.set(p[1], { id: p[1], windowId: p[2], kind: null, url: null, focus: null });
    } else if (
      p[0] === 'url' &&
      p.length === 4 &&
      targets.has(p[1]) &&
      ['chat', 'login', 'newtab', 'other'].includes(p[2])
    ) {
      Object.assign(targets.get(p[1]), { kind: p[2], url: p[3] });
    } else if (
      p[0] === 'focus' &&
      p.length === 5 &&
      targets.has(p[1]) &&
      p.slice(2).every((v) => ['true', 'false'].includes(v))
    ) {
      targets.get(p[1]).focus = {
        selected: p[2] === 'true',
        windowFront: p[3] === 'true',
        chromeFrontmost: p[4] === 'true',
      };
    } else if (p[0] === 'error' && p.length === 5 && /^-?\d+$/.test(p[4])) {
      result.queryErrors.push({ stage: p[1], windowId: p[2], tabId: p[3], code: Number(p[4]) });
    } else if (p[0] === 'changed' && p.length === 3) {
      result.changes.push({ scope: p[1], windowId: p[2] });
    } else invalid();
  }
  if (result.browserRunning === null || result.enumerationComplete === null) invalid();
  result.targets = [...targets.values()];
  return result;
}

export function observeTarget(snapshot, id) {
  const target = snapshot.targets.find((row) => row.id === id);
  if (target) return { status: 'observed', target };
  return {
    status:
      snapshot.enumerationComplete && !snapshot.queryErrors.length && !snapshot.changes.length
        ? 'not_observed'
        : 'unknown',
    target: null,
  };
}

export function requireExpectedTarget(observation) {
  if (observation.status !== 'observed')
    throw new Error('TARGET_' + observation.status.toUpperCase());
  if (!observation.target.url) throw new Error('TARGET_URL_QUERY_UNKNOWN');
  if (observation.target.kind !== 'chat' || !isExpectedUrl(observation.target.url))
    throw new Error('TARGET_URL_CHANGED');
  return observation.target;
}

export function summarizeDiagnostic(readSucceeded, before, after, pageStable) {
  const readable = (value) => value?.status === 'observed' && isExpectedUrl(value.target?.url);
  return {
    readsSucceeded: readSucceeded ? 1 : 0,
    readsFullyVerified:
      readSucceeded &&
      readable(before) &&
      readable(after) &&
      before.target.id === after.target.id &&
      pageStable
        ? 1
        : 0,
    targetObservationAfterRead: after?.status ?? 'unknown',
    movedWindow:
      before?.target && after?.target ? before.target.windowId !== after.target.windowId : null,
  };
}
