import { createHash } from 'node:crypto';
import { expectedUrl } from './guard.mjs';
import { parseReceipt } from './receipt.mjs';

const MAX_LOADED_ROWS = 1000;
const MAX_TEXT = 2000;
const JOB_ID = /^[A-Za-z0-9_-]+$/;
const POSITIVE_ID = /^[1-9]\d*$/;
const SOURCE_ID = /^\d+$/;

function pagePrelude(body) {
  return `(() => {
    const expected = ${JSON.stringify(expectedUrl)};
    const url = location.origin + location.pathname;
    if (url !== expected) return {ok:false, reason:'WRONG_PAGE'};
    const clean = value => typeof value === 'string' || typeof value === 'number'
      ? String(value).normalize('NFC').replace(/\\s+/g, ' ').trim() : null;
    const domRows = [...document.querySelectorAll('li[role="listitem"]')];
    let listVm = null;
    for (const start of domRows.slice(0, 5)) {
      for (let node = start, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) {
        if (node.__vue__?.$options?.name === 'virtual-list' && Array.isArray(node.__vue__?.$props?.dataSources)) {
          listVm = node.__vue__; break;
        }
      }
      if (listVm) break;
    }
    if (!listVm) return {ok:false, reason:'LOADED_LIST_NOT_READY'};
    const sources = listVm.$props.dataSources;
    if (!Array.isArray(sources) || !sources.length || sources.length > ${MAX_LOADED_ROWS}) {
      return {ok:false, reason:'LOADED_LIST_SIZE_INVALID'};
    }
    const pageAccountId = clean(window._PAGE?.uid);
    const storeAccountId = clean(listVm.$store?.state?.userInfo?.userId);
    if (!pageAccountId || !storeAccountId || pageAccountId !== storeAccountId) {
      return {ok:false, reason:'ACCOUNT_ID_UNVERIFIED'};
    }
    ${body}
  })()`;
}

// Used by connect. It intentionally reads only the two account-id fields needed
// to namespace local records; it never reads cookies, tokens, or browser storage.
export const accountExpression = pagePrelude(`
  return {ok:true, url, accountId:pageAccountId, loadedDataRows:sources.length,
    visibility:document.visibilityState, documentFocused:document.hasFocus()};
`);

// Read all rows already present in the page's virtual-list data source. No
// scrolling, clicking, navigation, network calls, or chat selection is used.
// Explicit DOM receipt labels are accepted only for currently rendered rows.
// Off-screen state numbers remain unknown until a separate runtime calibration
// proves the site's display rules.
export const expression = pagePrelude(`
  const parseReceipt = ${parseReceipt.toString()};
  const text = node => clean(node?.innerText) ?? '';
  const renderedBySource = new Map();
  for (const node of domRows) {
    const source = node.__vue__?.$props?.source;
    if (source && typeof source === 'object') {
      const group = renderedBySource.get(source) ?? [];
      group.push(node); renderedBySource.set(source, group);
    }
  }
  const items = [], unresolved = [];
  sources.forEach((source, sourceIndex) => {
    if (!source || typeof source !== 'object') {
      unresolved.push({sourceIndex, reason:'SOURCE_NOT_OBJECT'}); return;
    }
    const friendId = clean(source.friendId ?? source.uid);
    const friendSource = clean(source.friendSource);
    const uniqueId = clean(source.uniqueId);
    if (!/^[1-9]\\d*$/.test(friendId ?? '') || !/^\\d+$/.test(friendSource ?? '') ||
        uniqueId !== friendId + '-' + friendSource) {
      unresolved.push({sourceIndex, reason:'PLATFORM_ID_INVALID'}); return;
    }
    const contact = clean(source.name), company = clean(source.brandName);
    if (!contact || !company || contact.length > ${MAX_TEXT} || company.length > ${MAX_TEXT}) {
      unresolved.push({sourceIndex, reason:'SOURCE_IDENTITY_INVALID'}); return;
    }
    const rendered = renderedBySource.get(source) ?? [];
    if (rendered.length > 1) {
      unresolved.push({sourceIndex, reason:'SOURCE_RENDERED_MULTIPLE_TIMES'}); return;
    }
    const node = rendered[0] ?? null;
    let domIdentityMatches = null, outgoingReceipt = {status:'unknown',label:null,source:null};
    if (node) {
      const spans = [...(node.querySelector('.name-box')?.children ?? [])].filter(child => child.tagName === 'SPAN');
      domIdentityMatches = spans.length === 3 && clean(spans[0]?.innerText) === contact && clean(spans[1]?.innerText) === company;
      if (!domIdentityMatches) {
        unresolved.push({sourceIndex, reason:'DOM_SOURCE_IDENTITY_MISMATCH'}); return;
      }
      const block = node.querySelector('.last-msg');
      const markers = block ? [...block.children].filter(child => child.tagName === 'I' && child.classList.contains('message-status')) : [];
      outgoingReceipt = parseReceipt(markers.map(marker => {
        const style = getComputedStyle(marker);
        return {label:text(marker), classes:[...marker.classList],
          visible:style.display !== 'none' && !['hidden','collapse'].includes(style.visibility) &&
            style.opacity !== '0' && marker.getClientRects().length > 0};
      }));
    }
    const encryptJobId = clean(source.encryptJobId);
    const jobName = clean(source.jobName);
    const lastMsgId = clean(source.lastMsgId);
    const preview = clean(source.lastText) ?? (node ? text(node.querySelector('.last-msg-text')) : '');
    const title = clean(source.title) ?? '';
    const timeLabel = node ? text(node.querySelector('.time')) : '';
    const values = [preview, title, timeLabel, jobName].filter(value => value !== null);
    if (values.some(value => value.length > ${MAX_TEXT})) {
      unresolved.push({sourceIndex, reason:'SOURCE_TEXT_TOO_LARGE'}); return;
    }
    items.push({
      friendId, friendSource, uniqueId, contact, company, title, preview, timeLabel,
      latestMessageId:/^[1-9]\\d*$/.test(lastMsgId ?? '') ? lastMsgId : null,
      unread:null, outgoingReceipt,
      receiptObservationSource:node ? 'rendered_dom' : 'offscreen_unknown',
      rendered:Boolean(node), domIdentityMatches,
      encryptJobId:/^[A-Za-z0-9_-]+$/.test(encryptJobId ?? '') ? encryptJobId : null,
      jobName:jobName || null,
    });
  });
  return {ok:items.length > 0, url, accountId:pageAccountId,
    capturedAt:new Date().toISOString(), items, unresolved,
    loadedRows:domRows.length, loadedDataRows:sources.length,
    truncated:false, unreadCapability:'unavailable',
    outgoingReceiptCapability:'rendered_dom_only',
    jobCapability:'loaded_chat_state', visibility:document.visibilityState,
    documentFocused:document.hasFocus()};
`);

function cleanString(value, { required = false, max = MAX_TEXT } = {}) {
  if (typeof value !== 'string' || value.length > max) throw new Error('CAPTURE_ROW_INVALID');
  const normalized = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (required && !normalized) throw new Error('CAPTURE_ROW_INVALID');
  return normalized;
}

export function accountNamespace(accountId) {
  const id = String(accountId ?? '').trim();
  if (!POSITIVE_ID.test(id)) throw new Error('ACCOUNT_ID_INVALID');
  return 'boss-geek:' + createHash('sha256').update('boss-geek\0').update(id).digest('hex');
}

export function conversationKey(namespace, friendId, friendSource) {
  if (
    !/^boss-geek:[a-f0-9]{64}$/.test(namespace) ||
    !POSITIVE_ID.test(friendId) ||
    !SOURCE_ID.test(friendSource)
  ) {
    throw new Error('PLATFORM_ID_INVALID');
  }
  return createHash('sha256')
    .update(JSON.stringify(['boss', namespace, friendId, friendSource]))
    .digest('hex');
}

export function accountIdentity(data) {
  if (!data?.ok || data.url !== expectedUrl) throw new Error('ACCOUNT_CAPTURE_INVALID');
  return { platform: 'boss', namespace: accountNamespace(data.accountId) };
}

export function toSnapshot(data) {
  if (
    !data?.ok ||
    data.url !== expectedUrl ||
    !Array.isArray(data.items) ||
    !data.items.length ||
    !Array.isArray(data.unresolved) ||
    !Number.isSafeInteger(data.loadedRows) ||
    data.loadedRows < 0 ||
    !Number.isSafeInteger(data.loadedDataRows) ||
    data.loadedDataRows < data.items.length ||
    data.loadedDataRows > MAX_LOADED_ROWS ||
    typeof data.truncated !== 'boolean' ||
    data.unreadCapability !== 'unavailable' ||
    data.outgoingReceiptCapability !== 'rendered_dom_only' ||
    data.jobCapability !== 'loaded_chat_state' ||
    typeof data.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(data.capturedAt))
  ) {
    throw new Error('CAPTURE_SCHEMA_INVALID');
  }
  const identity = accountIdentity(data);
  const seen = new Set();
  const records = data.items.map((item) => {
    const friendId = cleanString(item.friendId, { required: true, max: 64 });
    const friendSource = cleanString(item.friendSource, { required: true, max: 32 });
    const uniqueId = cleanString(item.uniqueId, { required: true, max: 100 });
    if (
      !POSITIVE_ID.test(friendId) ||
      !SOURCE_ID.test(friendSource) ||
      uniqueId !== `${friendId}-${friendSource}`
    ) {
      throw new Error('CAPTURE_PLATFORM_ID_INVALID');
    }
    const key = conversationKey(identity.namespace, friendId, friendSource);
    if (seen.has(key)) throw new Error('CAPTURE_DUPLICATE_PLATFORM_ID');
    seen.add(key);
    const receipt = item.outgoingReceipt;
    if (
      !receipt ||
      !['read', 'delivered', 'unknown'].includes(receipt.status) ||
      (receipt.status === 'unknown'
        ? receipt.label !== null || receipt.source !== null
        : receipt.source !== 'list_receipt_label' ||
          receipt.label !== { read: '[已读]', delivered: '[送达]' }[receipt.status])
    ) {
      throw new Error('CAPTURE_RECEIPT_INVALID');
    }
    if (
      !['rendered_dom', 'offscreen_unknown'].includes(item.receiptObservationSource) ||
      (!item.rendered &&
        (item.receiptObservationSource !== 'offscreen_unknown' || receipt.status !== 'unknown')) ||
      (item.rendered && item.domIdentityMatches !== true)
    ) {
      throw new Error('CAPTURE_RECEIPT_SOURCE_INVALID');
    }
    const latestMessageId =
      item.latestMessageId === null
        ? null
        : cleanString(item.latestMessageId, { required: true, max: 64 });
    if (latestMessageId !== null && !POSITIVE_ID.test(latestMessageId))
      throw new Error('CAPTURE_MESSAGE_ID_INVALID');
    const jobId =
      item.encryptJobId === null
        ? null
        : cleanString(item.encryptJobId, { required: true, max: 300 });
    if (jobId !== null && !JOB_ID.test(jobId)) throw new Error('CAPTURE_JOB_ID_INVALID');
    const jobName =
      item.jobName === null ? null : cleanString(item.jobName, { required: true, max: 300 });
    return {
      key,
      identityConfidence: 'platform',
      platformIdentity: { friendId, friendSource, uniqueId },
      contact: cleanString(item.contact, { required: true }),
      company: cleanString(item.company, { required: true }),
      title: cleanString(item.title),
      preview: cleanString(item.preview),
      timeLabel: cleanString(item.timeLabel),
      unread: null,
      latestMessageId,
      outgoingReceipt: {
        status: receipt.status,
        label: receipt.label,
        source: receipt.source,
        observationSource: item.receiptObservationSource,
      },
      jobAssociation: jobId
        ? {
            jobId,
            detailUrl: `https://www.zhipin.com/job_detail/${jobId}.html`,
            source: 'loaded_chat_state',
          }
        : null,
      observedJobName: jobName,
      rendered: item.rendered,
    };
  });
  return {
    capturedAt: data.capturedAt,
    scope: 'loaded-chat-list',
    accountNamespace: identity.namespace,
    records,
    coverage: {
      loadedRows: data.loadedRows,
      loadedDataRows: data.loadedDataRows,
      renderedRows: records.filter((record) => record.rendered).length,
      offscreenRows: records.filter((record) => !record.rendered).length,
      unresolvedRows: data.unresolved.length,
      truncated: data.truncated,
      unreadCapability: 'unavailable',
      outgoingReceiptCapability: 'rendered_dom_only',
      jobCapability: 'loaded_chat_state',
      fullHistory: false,
    },
    identityMethod: 'account_friend_id_and_source',
  };
}
