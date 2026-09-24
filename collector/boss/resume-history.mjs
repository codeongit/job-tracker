import { createHash } from 'node:crypto';
import { expectedUrl } from './guard.mjs';
import {
  conversationKeyV2,
  upgradeEnvelopeToV3,
  validateEnvelopeV2OrV3,
  validateEnvelopeV3,
} from './model-v2.mjs';

const ID = /^[A-Za-z0-9_-]{1,300}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE = 'geek_history_type_4';
const STATUS_SOURCE = 'geek_history_status_message';
const DOM_STATUS_SOURCE = 'dom_chat_status_message_v1';

function digest(value) {
  const canonical = (current) => {
    if (Array.isArray(current)) return current.map(canonical);
    if (current && typeof current === 'object') {
      return Object.fromEntries(
        Object.keys(current)
          .filter((key) => current[key] !== undefined)
          .sort()
          .map((key) => [key, canonical(current[key])]),
      );
    }
    return current;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function clean(value, max = 300) {
  if (!['string', 'number'].includes(typeof value)) return null;
  const output = String(value).normalize('NFC').trim();
  return output && output.length <= max ? output : null;
}

function normalizeTarget(target) {
  const friendId = clean(target?.friendId, 128);
  const friendSource = clean(target?.friendSource, 128);
  const conversationKey = clean(target?.conversationKey, 128);
  if (
    !/^\d+$/.test(friendId ?? '') ||
    !/^\d+$/.test(friendSource ?? '') ||
    !/^[a-f0-9]{64}$/.test(conversationKey ?? '')
  )
    throw new TypeError('RESUME_SCAN_INPUT_INVALID');
  return { friendId, friendSource, conversationKey };
}

function requestPrelude(target, timeoutMs) {
  return `
    const expected = ${JSON.stringify(expectedUrl)};
    const url = location.origin + location.pathname;
    if (url !== expected) return {ok:false,url,reason:'WRONG_PAGE'};
    const target = ${JSON.stringify(target)};
    const request = (method, requestUrl, body = null) => new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, requestUrl, true); xhr.withCredentials = true; xhr.timeout = ${timeoutMs};
      xhr.setRequestHeader('Accept', 'application/json');
      if (method === 'POST') xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) return resolve({ok:false,reason:'HTTP_STATUS_ERROR'});
        try { resolve({ok:true,value:JSON.parse(xhr.responseText)}); }
        catch { resolve({ok:false,reason:'RESPONSE_NOT_JSON'}); }
      };
      xhr.onerror = () => resolve({ok:false,reason:'NETWORK_ERROR'});
      xhr.ontimeout = () => resolve({ok:false,reason:'REQUEST_TIMEOUT'});
      xhr.send(body);
    });`;
}

/** One expression performs exactly one platform request for the stable friend identity. */
export function createResumeFriendExpression({ target, timeoutMs = 15_000 }) {
  const safeTarget = normalizeTarget(target);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15_000)
    throw new TypeError('RESUME_SCAN_TIMEOUT_INVALID');
  return `(async () => {${requestPrelude(safeTarget, timeoutMs)}
    const normalizeId = (value, max = 300) => {
      if (!['string','number'].includes(typeof value)) return null;
      const output = String(value).normalize('NFC').trim();
      return output && output.length <= max && /^[A-Za-z0-9_-]+$/.test(output) ? output : null;
    };
    const normalizeSecurity = value => {
      if (typeof value !== 'string') return null;
      const output = value.normalize('NFC').trim();
      return output && output.length <= 500 && !/[\\s\\u0000-\\u001f\\u007f]/.test(output) ? output : null;
    };
    const uniqueIdentityPair = root => {
      const directBossId = normalizeId(root?.uid, 128), directSecurityId = normalizeSecurity(root?.securityId);
      if (directBossId && directSecurityId) return {bossId:directBossId,securityId:directSecurityId};
      const inspect = [root], pairs = new Map(); let visited = 0;
      while (inspect.length && visited < 100) {
        const current = inspect.shift(); visited += 1;
        if (!current || typeof current !== 'object') continue;
        if (!Array.isArray(current) && Object.hasOwn(current,'uid') && Object.hasOwn(current,'securityId')) {
          const bossId=normalizeId(current.uid,128),securityId=normalizeSecurity(current.securityId);
          if (bossId && securityId) pairs.set(JSON.stringify([bossId,securityId]),{bossId,securityId});
        }
        inspect.push(...(Array.isArray(current)?current.slice(0,50):Object.values(current).slice(0,50)));
      }
      return pairs.size===1?[...pairs.values()][0]:null;
    };
    const response = await request('POST','https://www.zhipin.com/wapi/zprelation/friend/getGeekFriendList.json',
      'friendIds=' + encodeURIComponent(target.friendId));
    const rows = response.ok && response.value?.code === 0 ? response.value?.zpData?.result : null;
    if (!Array.isArray(rows)) return {ok:false,url,reason:response.reason ?? 'FRIEND_INFO_UNAVAILABLE'};
    if (rows.length !== 1) return {ok:true,url,target,identity:null,reason:'FRIEND_IDENTITY_AMBIGUOUS'};
    const identity=uniqueIdentityPair(rows[0]);
    return identity ? {ok:true,url,target,identity} : {ok:true,url,target,identity:null,reason:'HISTORY_IDENTITY_MISSING'};
  })()`;
}

/** One expression performs exactly one history-page request. */
export function createResumePageExpression({ target, identity, page, timeoutMs = 15_000 }) {
  const safeTarget = normalizeTarget(target);
  const bossId = clean(identity?.bossId, 128),
    securityId = clean(identity?.securityId, 500);
  if (
    !MESSAGE_ID.test(bossId ?? '') ||
    !securityId ||
    /[\s\u0000-\u001f\u007f]/.test(securityId) ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 20 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 15_000
  )
    throw new TypeError('RESUME_SCAN_INPUT_INVALID');
  return `(async () => {${requestPrelude(safeTarget, timeoutMs)}
    const identity=${JSON.stringify({ bossId, securityId })}, page=${page};
    const normalizeId = (value, max = 300) => {
      if (!['string','number'].includes(typeof value)) return null;
      const output=String(value).normalize('NFC').trim();
      return output && output.length<=max && /^[A-Za-z0-9_-]+$/.test(output)?output:null;
    };
    const messageId = message => normalizeId(message.mid ?? message.msgId ?? message.messageId ?? message.id ??
      message.body?.mid ?? message.body?.msgId,128);
    const jobId = message => normalizeId(message.encryptJobId ?? message.jobId ?? message.body?.encryptJobId ??
      message.body?.jobId ?? message.body?.job?.encryptJobId ?? message.body?.job?.jobId,300);
    const isoTime = value => {
      const number=Number(value),millis=Number.isFinite(number)?(number>0&&number<100000000000?number*1000:number):NaN;
      const date=new Date(millis);return Number.isFinite(date.getTime())?date.toISOString():null;
    };
    const statusKind = message => {
      const body=message?.body;
      if(Number(message?.type)===4&&Number(message?.bizType)===317&&
          Number(body?.type)===16&&Number(body?.style)===3&&Number(body?.templateId)===1&&
          Array.isArray(body?.articles)&&body.articles.length===1&&
          normalizeId(message?.from?.uid,128)===identity.bossId)return 'request_sent';
      if ([1,4].includes(Number(message?.type))) return null;
      const values=[message?.text,message?.content,message?.title,message?.description,
        message?.body?.text,message?.body?.content,message?.body?.title,message?.body?.description,
        message?.body?.card?.text,message?.body?.card?.content,message?.body?.card?.title]
        .filter(value=>typeof value==='string').map(value=>value.normalize('NFC').replace(/\\s+/g,' ').trim());
      for (const value of values) {
        if (value==='附件简历请求已发送') return 'request_sent';
        if (value==='对方已同意，您的附件简历已发送给对方') return 'sent_confirmed';
        if (value==='对方已查看了您的附件简历') return 'viewed_confirmed';
        if (/^您的附件简历 .{1,300} 已发送给Boss(?:点击查看附件)?$/.test(value)) return 'attachment_sent';
      }
      return null;
    };
    const endpoint='https://www.zhipin.com/wapi/zpchat/geek/historyMsg?bossId='+encodeURIComponent(identity.bossId)+
      '&securityId='+encodeURIComponent(identity.securityId)+'&page='+page+'&c=20&src='+encodeURIComponent(target.friendSource);
    const response=await request('GET',endpoint);
    const messages=response.ok && response.value?.code===0?
      (response.value?.zpData?.messages ?? response.value?.zpData?.historyMsgList):null;
    if (!Array.isArray(messages)) return {ok:false,url,reason:response.reason ?? 'HISTORY_UNAVAILABLE'};
    const observations=[],unresolved=[],messageIds=[];
    for (const message of messages) {
      const id=messageId(message),platformTime=isoTime(message.time ?? message.msgTime ?? message.timestamp);
      if (id) messageIds.push(id);
      const status=statusKind(message);
      if (status) {
        if (!id || !platformTime) { unresolved.push({conversationKey:target.conversationKey,reason:'RESUME_STATUS_IDENTITY_INCOMPLETE'});continue; }
        observations.push({conversationKey:target.conversationKey,friendId:target.friendId,
          friendSource:target.friendSource,messageId:id,direction:'system',messageType:Number(message?.type)||5,
          kind:status,platformTime,externalJobId:jobId(message),source:${JSON.stringify(STATUS_SOURCE)}});continue;
      }
      if (Number(message?.type)!==4) continue;
      const fromUid=normalizeId(message.from?.uid,128);
      const direction=fromUid?(fromUid===identity.bossId?'inbound':'outbound'):'unknown';
      if (!id || !platformTime || direction==='unknown') {
        unresolved.push({conversationKey:target.conversationKey,reason:'RESUME_MESSAGE_IDENTITY_INCOMPLETE'});continue;
      }
      observations.push({conversationKey:target.conversationKey,friendId:target.friendId,
        friendSource:target.friendSource,messageId:id,direction,messageType:4,
        kind:direction==='outbound'?'sent_candidate':'resume_card_other',platformTime,
        externalJobId:jobId(message),source:${JSON.stringify(SOURCE)}});
    }
    return {ok:true,url,target,page,messageCount:messages.length,exhausted:messages.length<20,
      messageIds:[...new Set(messageIds)],observations,unresolved};
  })()`;
}

function scanError(error, fallback = 'HISTORY_SCAN_FAILED') {
  const value = String(error?.message ?? '');
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(value) ? value : fallback;
}

/**
 * Runs a bounded scan one network request at a time. The caller owns browser
 * identity preflight and persists the privacy-minimal checkpoint supplied here.
 */
export async function runResumeHistoryRequests({
  targets,
  pages = 2,
  maxRequests = 20,
  requestDelayMs = 3000,
  initialObservations = [],
  initialHead = null,
  startConversationKey = null,
  startPage = 1,
  knownMessageIds = [],
  execute,
  onCheckpoint = async () => {},
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => new Date().toISOString(),
} = {}) {
  if (
    !Array.isArray(targets) ||
    !targets.length ||
    targets.length > 100 ||
    !Number.isInteger(pages) ||
    pages < 1 ||
    pages > 20 ||
    !Number.isInteger(maxRequests) ||
    maxRequests < 1 ||
    maxRequests > 20 ||
    !Array.isArray(initialObservations) ||
    (initialHead !== null && !MESSAGE_ID.test(initialHead)) ||
    (startConversationKey !== null && !/^[a-f0-9]{64}$/.test(startConversationKey)) ||
    !Number.isInteger(startPage) ||
    startPage < 1 ||
    startPage > 20 ||
    !Array.isArray(knownMessageIds) ||
    !Number.isInteger(requestDelayMs) ||
    requestDelayMs < 0 ||
    requestDelayMs > 60_000 ||
    typeof execute !== 'function' ||
    typeof onCheckpoint !== 'function' ||
    typeof wait !== 'function' ||
    typeof now !== 'function'
  ) {
    throw new TypeError('RESUME_SCAN_INPUT_INVALID');
  }
  let safeTargets = targets.map(normalizeTarget);
  if (startConversationKey !== null) {
    const startIndex = safeTargets.findIndex(
      (target) => target.conversationKey === startConversationKey,
    );
    if (startIndex >= 0)
      safeTargets = [...safeTargets.slice(startIndex), ...safeTargets.slice(0, startIndex)];
  }
  const knownByConversation = new Map();
  for (const item of knownMessageIds) {
    const conversationKey = clean(item?.conversationKey, 128),
      messageId = clean(item?.messageId, 128);
    if (!/^[a-f0-9]{64}$/.test(conversationKey ?? '') || !MESSAGE_ID.test(messageId ?? '')) {
      throw new TypeError('RESUME_SCAN_INPUT_INVALID');
    }
    if (!knownByConversation.has(conversationKey))
      knownByConversation.set(conversationKey, new Set());
    knownByConversation.get(conversationKey).add(messageId);
  }
  const observations = structuredClone(initialObservations),
    unresolved = [];
  const coverage = {
    requestedConversations: safeTargets.length,
    resolvedConversations: 0,
    pagesPerConversation: pages,
    requestedPages: 0,
    completedPages: 0,
    exhaustedConversations: 0,
    truncatedConversations: 0,
    failedConversations: 0,
  };
  let historyRequests = 0,
    partial = false,
    error = null,
    cursor = null,
    budgetExhausted = false,
    continuation = null;
  const completedConversations = [];
  const heads = new Map();
  if (initialHead && startConversationKey) heads.set(startConversationKey, initialHead);
  const checkpoint = async (nextConversationKey, nextPage, metadata = {}) =>
    onCheckpoint({
      version: 1,
      capturedAt: now(),
      nextConversationKey,
      nextPage,
      observations: structuredClone(observations),
      unresolved: structuredClone(unresolved),
      coverage: structuredClone(coverage),
      usage: { historyRequests },
      partial,
      error,
      ...metadata,
    });
  const request = async (expression, metadata) => {
    if (historyRequests >= maxRequests) return { budget: false };
    if (historyRequests && requestDelayMs) await wait(requestDelayMs);
    historyRequests += 1;
    try {
      return { budget: true, payload: await execute(expression, metadata) };
    } catch (caught) {
      error = scanError(caught);
      partial = true;
      return { budget: true, failed: true };
    }
  };
  for (const [targetIndex, target] of safeTargets.entries()) {
    if (error) break;
    // A friend lookup without room for at least one history page cannot make
    // durable progress because the ephemeral security identity is never saved.
    if (maxRequests - historyRequests < 2) {
      budgetExhausted = true;
      break;
    }
    const firstPage = target.conversationKey === startConversationKey ? startPage : 1;
    const friend = await request(createResumeFriendExpression({ target }), {
      kind: 'friend',
      conversationKey: target.conversationKey,
    });
    if (!friend.budget) {
      budgetExhausted = true;
      break;
    }
    if (friend.failed) {
      continuation = { conversationKey: target.conversationKey, page: firstPage };
      unresolved.push({ conversationKey: target.conversationKey, reason: error });
      await checkpoint(target.conversationKey, firstPage);
      break;
    }
    if (!friend.payload?.ok) {
      const reason = scanError({ message: friend.payload?.reason }, 'FRIEND_INFO_UNAVAILABLE');
      unresolved.push({ conversationKey: target.conversationKey, reason });
      coverage.failedConversations += 1;
      cursor = target.conversationKey;
      await checkpoint(null, 0);
      continue;
    }
    if (!friend.payload.identity) {
      unresolved.push({
        conversationKey: target.conversationKey,
        reason: friend.payload.reason ?? 'HISTORY_IDENTITY_MISSING',
      });
      coverage.failedConversations += 1;
      cursor = target.conversationKey;
      await checkpoint(null, 0);
      continue;
    }
    // Persist request usage/progress, but never persist the ephemeral security identity.
    await checkpoint(target.conversationKey, firstPage);
    let completed = true,
      exhausted = false,
      knownBoundary = false,
      lastPage = firstPage - 1;
    for (let offset = 0; offset < pages && firstPage + offset <= 20; offset += 1) {
      const page = firstPage + offset;
      lastPage = page;
      coverage.requestedPages += 1;
      const pageResult = await request(
        createResumePageExpression({ target, identity: friend.payload.identity, page }),
        { kind: 'history_page', conversationKey: target.conversationKey, page },
      );
      if (!pageResult.budget) {
        budgetExhausted = true;
        break;
      }
      if (pageResult.failed) {
        completed = false;
        continuation = { conversationKey: target.conversationKey, page };
        unresolved.push({ conversationKey: target.conversationKey, reason: error });
        await checkpoint(target.conversationKey, page);
        break;
      }
      if (
        !pageResult.payload?.ok ||
        !Array.isArray(pageResult.payload.observations) ||
        !Array.isArray(pageResult.payload.unresolved) ||
        !Array.isArray(pageResult.payload.messageIds) ||
        pageResult.payload.messageIds.some((id) => typeof id !== 'string' || !MESSAGE_ID.test(id))
      ) {
        const reason = scanError({ message: pageResult.payload?.reason }, 'HISTORY_UNAVAILABLE');
        unresolved.push({ conversationKey: target.conversationKey, reason });
        completed = false;
        coverage.failedConversations += 1;
        continuation = { conversationKey: target.conversationKey, page };
        await checkpoint(target.conversationKey, page);
        break;
      }
      coverage.completedPages += 1;
      if (!heads.has(target.conversationKey) && firstPage === 1)
        heads.set(target.conversationKey, pageResult.payload.messageIds[0] ?? null);
      observations.push(...pageResult.payload.observations);
      unresolved.push(...pageResult.payload.unresolved);
      if (
        pageResult.payload.unresolved.some((item) =>
          /IDENTITY_INCOMPLETE/.test(item?.reason ?? ''),
        ) ||
        (!pageResult.payload.messageIds.length && pageResult.payload.unresolved.length)
      ) {
        unresolved.push({
          conversationKey: target.conversationKey,
          reason: 'HISTORY_MESSAGE_ID_MISSING',
        });
        completed = false;
        coverage.failedConversations += 1;
        continuation = { conversationKey: target.conversationKey, page };
        await checkpoint(target.conversationKey, page, {
          head: heads.get(target.conversationKey) ?? null,
        });
        break;
      }
      exhausted = pageResult.payload.exhausted === true;
      const known = knownByConversation.get(target.conversationKey) ?? new Set();
      knownBoundary = pageResult.payload.messageIds.some(
        (id) => MESSAGE_ID.test(id) && known.has(id),
      );
      if (exhausted || knownBoundary || page === 20) {
        continuation = null;
        await checkpoint(null, 0, {
          completedConversationKey: exhausted || knownBoundary ? target.conversationKey : null,
          head: heads.get(target.conversationKey) ?? null,
          truncated: page === 20 && !exhausted && !knownBoundary,
        });
        break;
      }
      continuation = { conversationKey: target.conversationKey, page: page + 1 };
      await checkpoint(target.conversationKey, page + 1, {
        head: heads.get(target.conversationKey) ?? null,
      });
    }
    if (completed) {
      coverage.resolvedConversations += 1;
      if (exhausted || knownBoundary) {
        coverage.exhaustedConversations += 1;
        cursor = target.conversationKey;
        completedConversations.push({
          conversationKey: target.conversationKey,
          head: heads.get(target.conversationKey) ?? null,
          complete: true,
        });
      } else {
        coverage.truncatedConversations += 1;
        if (lastPage >= 20) cursor = target.conversationKey;
      }
    }
    // Do not advance to another conversation while this one's durable page
    // continuation is pending; otherwise the next checkpoint would lose it.
    if (continuation) break;
    if (
      error ||
      budgetExhausted ||
      (historyRequests >= maxRequests && targetIndex < safeTargets.length - 1)
    ) {
      budgetExhausted =
        budgetExhausted || (historyRequests >= maxRequests && targetIndex < safeTargets.length - 1);
      break;
    }
  }
  return {
    payload: { ok: true, url: expectedUrl, capturedAt: now(), observations, unresolved, coverage },
    usage: { historyRequests },
    partial,
    error,
    cursor,
    budgetExhausted,
    continuation,
    completed: completedConversations,
    heads: [...heads].map(([conversationKey, head]) => ({ conversationKey, head })),
  };
}

export function createResumeHistoryExpression({ targets, pages = 2 }) {
  if (
    !Array.isArray(targets) ||
    !targets.length ||
    targets.length > 100 ||
    !Number.isSafeInteger(pages) ||
    pages < 1 ||
    pages > 20 ||
    targets.length * (pages + 1) > 20
  ) {
    throw new TypeError('RESUME_SCAN_INPUT_INVALID');
  }
  const safeTargets = targets.map((target) => {
    const friendId = clean(target.friendId, 128);
    const friendSource = clean(target.friendSource, 128);
    const conversationKey = clean(target.conversationKey, 128);
    if (
      !/^\d+$/.test(friendId ?? '') ||
      !/^\d+$/.test(friendSource ?? '') ||
      !/^[a-f0-9]{64}$/.test(conversationKey ?? '')
    )
      throw new TypeError('RESUME_SCAN_INPUT_INVALID');
    return { friendId, friendSource, conversationKey };
  });
  return `(async () => {
    const expected = ${JSON.stringify(expectedUrl)};
    const url = location.origin + location.pathname;
    if (url !== expected) return {ok:false,url,reason:'WRONG_PAGE'};
    const targets = ${JSON.stringify(safeTargets)};
    const pages = ${pages};
    let lastRequestAt = 0;
    const request = async (method, requestUrl, body = null) => {
      const gap = Date.now() - lastRequestAt;
      if (lastRequestAt && gap < 3000) await new Promise(resolve => setTimeout(resolve, 3000-gap));
      lastRequestAt = Date.now();
      return new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, requestUrl, true); xhr.withCredentials = true; xhr.timeout = 15000;
        xhr.setRequestHeader('Accept', 'application/json');
        if (method === 'POST') xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        xhr.onload = () => { try { resolve({ok:true,value:JSON.parse(xhr.responseText)}); }
          catch { resolve({ok:false,reason:'RESPONSE_NOT_JSON'}); } };
        xhr.onerror = () => resolve({ok:false,reason:'NETWORK_ERROR'});
        xhr.ontimeout = () => resolve({ok:false,reason:'REQUEST_TIMEOUT'});
        xhr.send(body);
      });
    };
    const normalizeId = (value, max = 300) => {
      if (!['string','number'].includes(typeof value)) return null;
      const output = String(value).normalize('NFC').trim();
      return output && output.length <= max && /^[A-Za-z0-9_-]+$/.test(output) ? output : null;
    };
    const normalizeSecurity = value => {
      if (typeof value !== 'string') return null;
      const output = value.normalize('NFC').trim();
      return output && output.length <= 500 && !/[\\s\\u0000-\\u001f\\u007f]/.test(output) ? output : null;
    };
    const uniqueIdentityPair = root => {
      const directBossId = normalizeId(root?.uid, 128), directSecurityId = normalizeSecurity(root?.securityId);
      if (directBossId && directSecurityId) return {bossId:directBossId,securityId:directSecurityId};
      const inspect = [root], pairs = new Map();
      let visited = 0;
      while (inspect.length && visited < 100) {
        const current = inspect.shift(); visited += 1;
        if (!current || typeof current !== 'object') continue;
        if (!Array.isArray(current) && Object.hasOwn(current, 'uid') && Object.hasOwn(current, 'securityId')) {
          const bossId = normalizeId(current.uid, 128), securityId = normalizeSecurity(current.securityId);
          if (bossId && securityId) pairs.set(JSON.stringify([bossId,securityId]),{bossId,securityId});
        }
        inspect.push(...(Array.isArray(current) ? current.slice(0,50) : Object.values(current).slice(0,50)));
      }
      return pairs.size === 1 ? [...pairs.values()][0] : null;
    };
    const messageId = message => normalizeId(
      message.mid ?? message.msgId ?? message.messageId ?? message.id ?? message.body?.mid ?? message.body?.msgId, 128);
    const jobId = message => normalizeId(
      message.encryptJobId ?? message.jobId ?? message.body?.encryptJobId ?? message.body?.jobId ??
      message.body?.job?.encryptJobId ?? message.body?.job?.jobId, 300);
    const statusKind = message => {
      const body=message?.body;
      if(Number(message?.type)===4&&Number(message?.bizType)===317&&
          Number(body?.type)===16&&Number(body?.style)===3&&Number(body?.templateId)===1&&
          Array.isArray(body?.articles)&&body.articles.length===1&&
          normalizeId(message?.from?.uid,128)===identity.bossId)return 'request_sent';
      const inspect = [message];
      let visited = 0;
      while (inspect.length && visited < 300) {
        const current = inspect.shift(); visited += 1;
        if (typeof current === 'string') {
          const value = current.normalize('NFC').trim();
          if (value.includes('附件简历请求已发送')) return 'request_sent';
          if (value.includes('对方已同意，您的附件简历已发送给对方')) return 'sent_confirmed';
          if (value.includes('对方已查看了您的附件简历')) return 'viewed_confirmed';
          if (/您的附件简历 .{1,300} 已发送给Boss(?:点击查看附件)?/.test(value)) return 'attachment_sent';
        } else if (current && typeof current === 'object') {
          inspect.push(...(Array.isArray(current) ? current.slice(0,100) : Object.values(current).slice(0,100)));
        }
      }
      return null;
    };
    const isoTime = value => {
      const number = Number(value);
      const millis = Number.isFinite(number) ? (number > 0 && number < 100000000000 ? number * 1000 : number) : NaN;
      const date = new Date(millis);
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    };
    const friendByConversation = new Map();
    for (const target of targets) {
      const response = await request('POST', 'https://www.zhipin.com/wapi/zprelation/friend/getGeekFriendList.json',
        'friendIds=' + target.friendId);
      const rows = response.ok && response.value?.code === 0 ? response.value?.zpData?.result : null;
      if (!Array.isArray(rows)) return {ok:false,url,reason:'FRIEND_INFO_UNAVAILABLE'};
      if (rows.length === 1) friendByConversation.set(target.conversationKey, rows[0]);
    }
    const observations = [], unresolved = [];
    for (const target of targets) {
      const friend = friendByConversation.get(target.conversationKey);
      if (!friend) { unresolved.push({conversationKey:target.conversationKey,reason:'FRIEND_IDENTITY_AMBIGUOUS'}); continue; }
      const identity = uniqueIdentityPair(friend);
      const bossId = identity?.bossId, securityId = identity?.securityId;
      if (!bossId || !securityId) { unresolved.push({conversationKey:target.conversationKey,reason:'HISTORY_IDENTITY_MISSING'}); continue; }
      let exhausted = false;
      for (let page = 1; page <= pages && !exhausted; page += 1) {
        const endpoint = 'https://www.zhipin.com/wapi/zpchat/geek/historyMsg?bossId=' + encodeURIComponent(bossId) +
          '&securityId=' + encodeURIComponent(securityId) + '&page=' + page + '&c=20&src=' + encodeURIComponent(target.friendSource);
        const response = await request('GET', endpoint);
        const messages = response.ok && response.value?.code === 0
          ? (response.value?.zpData?.messages ?? response.value?.zpData?.historyMsgList) : null;
        if (!Array.isArray(messages)) { unresolved.push({conversationKey:target.conversationKey,reason:'HISTORY_UNAVAILABLE'}); break; }
        exhausted = messages.length < 20;
        for (const message of messages) {
          const id = messageId(message), platformTime = isoTime(message.time ?? message.msgTime ?? message.timestamp);
          const status = statusKind(message);
          if (status) {
            if (!id || !platformTime) {
              unresolved.push({conversationKey:target.conversationKey,reason:'RESUME_STATUS_IDENTITY_INCOMPLETE'}); continue;
            }
            observations.push({conversationKey:target.conversationKey,friendId:target.friendId,
              friendSource:target.friendSource,messageId:id,direction:'system',messageType:Number(message?.type) || 5,
              kind:status,platformTime,externalJobId:jobId(message),source:${JSON.stringify(STATUS_SOURCE)}});
            continue;
          }
          if (Number(message?.type) !== 4) continue;
          const fromUid = normalizeId(message.from?.uid, 128);
          const direction = fromUid ? (fromUid === bossId ? 'inbound' : 'outbound') : 'unknown';
          if (!id || !platformTime || direction === 'unknown') {
            unresolved.push({conversationKey:target.conversationKey,reason:'RESUME_MESSAGE_IDENTITY_INCOMPLETE'}); continue;
          }
          observations.push({conversationKey:target.conversationKey,friendId:target.friendId,
            friendSource:target.friendSource,messageId:id,direction,messageType:4,
            kind:direction === 'outbound' ? 'sent_candidate' : 'resume_card_other',
            platformTime,externalJobId:jobId(message),source:${JSON.stringify(SOURCE)}});
        }
      }
    }
    return {ok:true,url,capturedAt:new Date().toISOString(),observations,unresolved,
      coverage:{requestedConversations:targets.length,resolvedConversations:targets.length -
        new Set(unresolved.filter(item => item.reason === 'HISTORY_IDENTITY_MISSING').map(item => item.conversationKey)).size,
        pagesPerConversation:pages}};
  })()`;
}

export function toResumeHistoryResult(payload, envelope) {
  const checked = validateEnvelopeV2OrV3(envelope);
  if (
    !payload?.ok ||
    payload.url !== expectedUrl ||
    !Array.isArray(payload.observations) ||
    !Array.isArray(payload.unresolved) ||
    !payload.coverage ||
    !Number.isFinite(Date.parse(payload.capturedAt))
  )
    throw new Error('RESUME_HISTORY_SCHEMA_INVALID');
  const conversations = new Map(checked.state.records.map((record) => [record.key, record]));
  const observations = [],
    ids = new Set();
  for (const [index, value] of payload.observations.entries()) {
    const conversation = conversations.get(value?.conversationKey);
    const statusKind = [
      'request_sent',
      'sent_confirmed',
      'viewed_confirmed',
      'attachment_sent',
    ].includes(value?.kind);
    const expectedSource =
      statusKind && value?.source === DOM_STATUS_SOURCE
        ? DOM_STATUS_SOURCE
        : statusKind
          ? STATUS_SOURCE
          : SOURCE;
    if (
      !conversation ||
      value.friendId !== conversation.platformIdentity.friendId ||
      value.friendSource !== conversation.platformIdentity.friendSource ||
      !MESSAGE_ID.test(value.messageId ?? '') ||
      !['inbound', 'outbound', 'system'].includes(value.direction) ||
      (!statusKind && value.messageType !== 4) ||
      ![
        'sent_candidate',
        'resume_card_other',
        'request_sent',
        'sent_confirmed',
        'viewed_confirmed',
        'attachment_sent',
      ].includes(value.kind) ||
      !Number.isFinite(Date.parse(value.platformTime)) ||
      value.source !== expectedSource ||
      (value.externalJobId !== null && !ID.test(value.externalJobId ?? ''))
    ) {
      throw new Error(`RESUME_HISTORY_OBSERVATION_INVALID_${index}`);
    }
    if (
      (!statusKind && (value.direction === 'outbound') !== (value.kind === 'sent_candidate')) ||
      (statusKind &&
        (value.direction !== 'system' ||
          ![STATUS_SOURCE, DOM_STATUS_SOURCE].includes(value.source)))
    ) {
      throw new Error(`RESUME_HISTORY_DIRECTION_INVALID_${index}`);
    }
    const facts = {
      conversationKey: value.conversationKey,
      platformIdentity: { ...conversation.platformIdentity },
      messageId: value.messageId,
      direction: value.direction,
      messageType: value.messageType,
      kind: value.kind,
      platformTime: new Date(value.platformTime).toISOString(),
      externalJobId: value.externalJobId,
      observedAt: new Date(payload.capturedAt).toISOString(),
      source: expectedSource,
      status:
        (value.kind === 'sent_candidate' || statusKind) && value.externalJobId
          ? 'strong'
          : 'review',
    };
    const id = digest([
      'boss-v2-evidence',
      'resume_observation',
      facts.conversationKey,
      facts.messageId,
      facts.direction,
      facts.messageType,
      facts.kind,
      facts.platformTime,
      facts.externalJobId,
      facts.source,
    ]);
    if (ids.has(id)) continue;
    ids.add(id);
    observations.push({ id, ...facts });
  }
  const unresolved = payload.unresolved.map((item) => ({
    conversationKey: clean(item?.conversationKey, 128),
    reason: clean(item?.reason, 100),
  }));
  if (
    unresolved.some(
      (item) =>
        !conversations.has(item.conversationKey) ||
        !/^[A-Z][A-Z0-9_]{2,80}$/.test(item.reason ?? ''),
    )
  )
    throw new Error('RESUME_HISTORY_UNRESOLVED_INVALID');
  const coverage = {
    requestedConversations: Number(payload.coverage.requestedConversations),
    resolvedConversations: Number(payload.coverage.resolvedConversations),
    pagesPerConversation: Number(payload.coverage.pagesPerConversation),
  };
  for (const key of [
    'requestedPages',
    'completedPages',
    'exhaustedConversations',
    'truncatedConversations',
    'failedConversations',
  ]) {
    if (payload.coverage[key] !== undefined) coverage[key] = Number(payload.coverage[key]);
  }
  if (
    Object.values(coverage).some((value) => !Number.isSafeInteger(value) || value < 0) ||
    coverage.resolvedConversations > coverage.requestedConversations ||
    (coverage.completedPages ?? 0) > (coverage.requestedPages ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('RESUME_HISTORY_COVERAGE_INVALID');
  }
  return {
    capturedAt: new Date(payload.capturedAt).toISOString(),
    observations,
    unresolved,
    coverage,
  };
}

export function applyResumeHistoryV2(inputEnvelope, result) {
  const envelope = upgradeEnvelopeToV3(inputEnvelope);
  if (
    !result ||
    !Array.isArray(result.observations) ||
    !Array.isArray(result.unresolved) ||
    !Number.isFinite(Date.parse(result.capturedAt))
  )
    throw new TypeError('RESUME_HISTORY_RESULT_INVALID');
  const eventKey = (item) =>
    digest([
      item.conversationKey,
      item.messageId,
      item.direction,
      item.messageType,
      item.kind,
      item.externalJobId,
      item.source,
    ]);
  const prior = new Map();
  let deduplicated = 0;
  for (const observation of [...envelope.resume.observations].sort(
    (a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id),
  )) {
    const key = eventKey(observation);
    if (prior.has(key)) {
      deduplicated += 1;
      continue;
    }
    prior.set(key, observation);
  }
  envelope.resume.observations = [...prior.values()];
  let added = 0;
  for (const observation of result.observations) {
    const key = eventKey(observation);
    if (prior.has(key)) continue;
    envelope.resume.observations.push(structuredClone(observation));
    prior.set(key, observation);
    added += 1;
  }
  envelope.resume.observations.sort((a, b) => a.id.localeCompare(b.id));
  envelope.resume.lastScanAt = result.capturedAt;
  envelope.resume.lastCoverage = structuredClone(result.coverage);
  envelope.resume.lastUnresolved = structuredClone(result.unresolved);
  if (added || deduplicated) envelope.updatedAt = result.capturedAt;
  const unresolvedByReason = Object.fromEntries(
    [...new Set(result.unresolved.map((item) => item.reason))]
      .sort()
      .map((reason) => [reason, result.unresolved.filter((item) => item.reason === reason).length]),
  );
  return {
    envelope: validateEnvelopeV3(envelope),
    report: {
      counts: {
        observed: result.observations.length,
        added,
        strong: result.observations.filter((item) => item.status === 'strong').length,
        review: result.observations.filter((item) => item.status === 'review').length,
        unresolved: result.unresolved.length,
        unresolvedByReason,
        deduplicated,
      },
    },
  };
}
