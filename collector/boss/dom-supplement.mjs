import { RESUME_RULES, classifyResumeText } from '../../dist/resume-rules.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { expectedUrl } from './guard.mjs';
import { applyResumeHistoryV2, toResumeHistoryResult } from './resume-history.mjs';
import { validateEnvelope, validateCurrentEnvelope } from './model-v2.mjs';

export const DOM_STATUS_SOURCE = 'dom_chat_status_message_v1';
export const DOM_RULE_ID = 'boss_dom_status_v1';
const policyName = '.dom-supplement-policy-v1.json';
const stateName = '.dom-supplement-state-v1.json';
const checkpointName = '.dom-supplement-checkpoint-v1.json';
const keyPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9_-]{1,300}$/;
const codePattern = /^[A-Z][A-Z0-9_]{2,80}$/;
const pendingReasons = new Set([
  'FRIEND_IDENTITY_AMBIGUOUS',
  'HISTORY_IDENTITY_MISSING',
  'HISTORY_UNAVAILABLE',
  'RESUME_MESSAGE_IDENTITY_INCOMPLETE',
  'RESUME_STATUS_IDENTITY_INCOMPLETE',
]);

const emptyState = () => ({
  version: 1,
  cursor: null,
  lastSwitchAt: null,
  completed: [],
  updatedAt: null,
});

function iso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function taskId(accountNamespace, record) {
  return digest([
    'boss-dom-supplement-v1',
    accountNamespace,
    record.key,
    record.latestMessageId,
    DOM_RULE_ID,
  ]);
}

function policyFor(value, accountNamespace) {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.enabled !== 'boolean' ||
    value.accountNamespace !== accountNamespace ||
    !value.rule ||
    value.rule.id !== DOM_RULE_ID ||
    value.rule.acceptedBy !== 'user' ||
    !iso(value.rule.acceptedAt) ||
    value.rule.noUnreadProof !== 'vue_source_unreadMsgCount_zero' ||
    value.rule.rowIdentity !== 'vue_source_friendId_friendSource_uniqueId' ||
    value.rule.messageIdentity !== 'data-message-id_and_data-message-time'
  ) {
    throw new Error('DOM_SUPPLEMENT_POLICY_INVALID');
  }
  return structuredClone(value);
}

export function normalizeDomSupplementPolicy(value, accountNamespace) {
  if (!/^boss-geek:[a-f0-9]{64}$/.test(accountNamespace ?? '')) {
    throw new Error('DOM_SUPPLEMENT_POLICY_INVALID');
  }
  return policyFor(value, accountNamespace);
}

export async function loadDomSupplementPolicy(directory, accountNamespace) {
  try {
    const value = JSON.parse(await readFile(join(directory, policyName), 'utf8'));
    return {
      policy: policyFor(value, accountNamespace),
      status: value.enabled ? 'enabled' : 'disabled',
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { policy: null, status: 'missing' };
    if (error instanceof SyntaxError) throw new Error('DOM_SUPPLEMENT_POLICY_UNREADABLE');
    throw error;
  }
}

function normalizeState(value) {
  if (
    !value ||
    value.version !== 1 ||
    (value.cursor !== null && !keyPattern.test(value.cursor ?? '')) ||
    (value.lastSwitchAt !== null && !iso(value.lastSwitchAt)) ||
    (value.updatedAt !== null && !iso(value.updatedAt)) ||
    !Array.isArray(value.completed) ||
    value.completed.length > 10_000
  )
    throw new Error('DOM_SUPPLEMENT_STATE_INVALID');
  const completed = value.completed.map((item) => {
    if (
      !item ||
      !keyPattern.test(item.taskId ?? '') ||
      !iso(item.completedAt) ||
      !['observed', 'no_matching_status'].includes(item.outcome)
    ) {
      throw new Error('DOM_SUPPLEMENT_STATE_INVALID');
    }
    return { taskId: item.taskId, completedAt: item.completedAt, outcome: item.outcome };
  });
  if (new Set(completed.map((item) => item.taskId)).size !== completed.length) {
    throw new Error('DOM_SUPPLEMENT_STATE_INVALID');
  }
  return {
    version: 1,
    cursor: value.cursor,
    lastSwitchAt: value.lastSwitchAt,
    completed,
    updatedAt: value.updatedAt,
  };
}

function normalizeCheckpoint(value) {
  if (
    !value ||
    value.version !== 1 ||
    !keyPattern.test(value.taskId ?? '') ||
    !keyPattern.test(value.conversationKey ?? '') ||
    !idPattern.test(value.latestMessageId ?? '') ||
    value.ruleId !== DOM_RULE_ID ||
    !['selected', 'switch_issued'].includes(value.stage) ||
    !iso(value.selectedAt) ||
    (value.issuedAt !== null && !iso(value.issuedAt)) ||
    (value.stage === 'selected' && value.issuedAt !== null) ||
    (value.stage === 'switch_issued' && value.issuedAt === null)
  ) {
    throw new Error('DOM_SUPPLEMENT_CHECKPOINT_INVALID');
  }
  return structuredClone(value);
}

async function writePrivateJson(directory, name, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('DATA_DIRECTORY_INVALID');
  const path = join(directory, name),
    temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return path;
}

async function readState(directory) {
  try {
    return normalizeState(JSON.parse(await readFile(join(directory, stateName), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    if (error instanceof SyntaxError) throw new Error('DOM_SUPPLEMENT_STATE_UNREADABLE');
    throw error;
  }
}

async function readCheckpoint(directory) {
  try {
    return normalizeCheckpoint(JSON.parse(await readFile(join(directory, checkpointName), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('DOM_SUPPLEMENT_CHECKPOINT_UNREADABLE');
    throw error;
  }
}

const saveState = (directory, value) =>
  writePrivateJson(directory, stateName, normalizeState(value));
const saveCheckpoint = (directory, value) =>
  writePrivateJson(directory, checkpointName, normalizeCheckpoint(value));
async function removeCheckpoint(directory) {
  try {
    await unlink(join(directory, checkpointName));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function unresolvedKeys(envelope) {
  return new Set(
    envelope.resume.lastUnresolved
      .filter((item) => pendingReasons.has(item.reason))
      .map((item) => item.conversationKey),
  );
}

export function domSupplementTasks(
  inputEnvelope,
  { policy, state = emptyState(), checkpoint = null } = {},
) {
  const envelope = validateEnvelope(inputEnvelope);
  const safeState = normalizeState(state);
  const unresolved = unresolvedKeys(envelope),
    completed = new Set(safeState.completed.map((item) => item.taskId));
  const tasks = envelope.snapshot.records
    .filter((record) => unresolved.has(record.key) && record.latestMessageId !== null)
    .map((record) => ({
      taskId: taskId(envelope.accountNamespace, record),
      conversationKey: record.key,
      friendId: record.platformIdentity.friendId,
      friendSource: record.platformIdentity.friendSource,
      uniqueId: record.platformIdentity.uniqueId,
      latestMessageId: record.latestMessageId,
    }))
    .filter((task) => !completed.has(task.taskId))
    .sort((a, b) => a.conversationKey.localeCompare(b.conversationKey));
  if (!policy?.enabled)
    return { tasks, selected: null, pending: tasks.length, reason: 'DOM_POLICY_DISABLED' };
  policyFor(policy, envelope.accountNamespace);
  let selected = null;
  if (checkpoint) {
    const safe = normalizeCheckpoint(checkpoint);
    selected = tasks.find((task) => task.taskId === safe.taskId) ?? null;
    if (!selected)
      return {
        tasks,
        selected: null,
        pending: tasks.length,
        reason: 'DOM_CHECKPOINT_TARGET_STALE',
      };
  } else if (tasks.length) {
    const index = tasks.findIndex((task) => task.conversationKey === safeState.cursor);
    selected = tasks[index < 0 ? 0 : (index + 1) % tasks.length];
  }
  return { tasks, selected, pending: tasks.length, reason: selected ? null : 'DOM_TASKS_EMPTY' };
}

export async function domSupplementStatus(
  directory,
  inputEnvelope,
  { now = () => new Date() } = {},
) {
  const envelope = validateEnvelope(inputEnvelope);
  const [policyResult, state, checkpoint] = await Promise.all([
    loadDomSupplementPolicy(directory, envelope.accountNamespace),
    readState(directory),
    readCheckpoint(directory),
  ]);
  const selection = domSupplementTasks(envelope, {
    policy: policyResult.policy,
    state,
    checkpoint,
  });
  const current = now(),
    currentTime = current instanceof Date ? current.getTime() : Date.parse(current);
  if (!Number.isFinite(currentTime)) throw new TypeError('DOM_SUPPLEMENT_CLOCK_INVALID');
  const nextAllowedAt =
    state.lastSwitchAt === null
      ? null
      : new Date(Date.parse(state.lastSwitchAt) + 30_000).toISOString();
  return {
    policyStatus: policyResult.status,
    pending: selection.pending,
    checkpointStage: checkpoint?.stage ?? null,
    lastSwitchAt: state.lastSwitchAt,
    nextAllowedAt: nextAllowedAt && currentTime < Date.parse(nextAllowedAt) ? nextAllowedAt : null,
    completedTasks: state.completed.length,
    reason: selection.reason,
  };
}

function normalizedTarget(value) {
  if (
    !value ||
    !keyPattern.test(value.conversationKey ?? '') ||
    !keyPattern.test(value.taskId ?? '') ||
    !/^\d+$/.test(value.friendId ?? '') ||
    !/^\d+$/.test(value.friendSource ?? '') ||
    value.uniqueId !== `${value.friendId}-${value.friendSource}` ||
    !idPattern.test(value.latestMessageId ?? '')
  ) {
    throw new TypeError('DOM_SUPPLEMENT_TARGET_INVALID');
  }
  return structuredClone(value);
}

function expressionPrelude(target, body) {
  const safe = normalizedTarget(target);
  return `(async()=>{
    const expected=${JSON.stringify(expectedUrl)},target=${JSON.stringify(safe)};
    const url=location.origin+location.pathname;
    if(url!==expected)return {ok:false,url,reason:'WRONG_PAGE',switchAttempted:false};
    const clean=value=>typeof value==='string'||typeof value==='number'?String(value).normalize('NFC').trim():null;
    const rows=[...document.querySelectorAll('li[role="listitem"]')];let vm=null;
    for(const start of rows.slice(0,5)){for(let node=start,depth=0;node&&depth<12;node=node.parentElement,depth+=1){
      if(node.__vue__?.$options?.name==='virtual-list'&&Array.isArray(node.__vue__?.$props?.dataSources)){vm=node.__vue__;break;}}
      if(vm)break;}
    if(!vm)return {ok:false,url,reason:'LOADED_LIST_NOT_READY',switchAttempted:false};
    const pageId=clean(window._PAGE?.uid),storeId=clean(vm.$store?.state?.userInfo?.userId);
    if(!pageId||pageId!==storeId)return {ok:false,url,reason:'ACCOUNT_ID_UNVERIFIED',switchAttempted:false};
    const sources=vm.$props.dataSources.filter(source=>source&&typeof source==='object'&&
      clean(source.friendId??source.uid)===target.friendId&&clean(source.friendSource)===target.friendSource&&
      clean(source.uniqueId)===target.uniqueId);
    if(sources.length!==1)return {ok:false,url,reason:'DOM_SOURCE_IDENTITY_NOT_UNIQUE',switchAttempted:false};
    const source=sources[0],lastMsgId=clean(source.lastMsgId);
    if(lastMsgId!==target.latestMessageId)return {ok:false,url,reason:'DOM_TASK_MESSAGE_CHANGED',switchAttempted:false};
    if(!Number.isSafeInteger(source.unreadMsgCount)||source.unreadMsgCount!==0){
      return {ok:false,url,reason:'DOM_NO_UNREAD_PROOF',switchAttempted:false};}
    const rendered=rows.filter(row=>row.__vue__?.$props?.source===source);
    if(rendered.length!==1)return {ok:false,url,reason:'DOM_TARGET_NOT_RENDERED_UNIQUE',switchAttempted:false};
    const row=rendered[0],contents=[...row.querySelectorAll('.friend-content')];
    if(contents.length!==1||typeof contents[0].click!=='function'){
      return {ok:false,url,reason:'DOM_CLICK_TARGET_INVALID',switchAttempted:false};}
    const content=contents[0];
    ${body}
  })()`;
}

export function createDomSupplementPreflightExpression(target) {
  return expressionPrelude(
    target,
    `
    return {ok:true,url,target,switchAttempted:false,selected:content.classList.contains('selected'),
      proof:{ruleId:${JSON.stringify(DOM_RULE_ID)},unreadMsgCount:0,latestMessageId:lastMsgId}};`,
  );
}

export function createDomSupplementReadExpression(target, { allowSwitch = true } = {}) {
  if (typeof allowSwitch !== 'boolean') throw new TypeError('DOM_SUPPLEMENT_TARGET_INVALID');
  return expressionPrelude(
    target,
    `
    let switchAttempted=false;
    if(!content.classList.contains('selected')&&!${JSON.stringify(allowSwitch)}){
      return {ok:false,url,target,reason:'DOM_SELECTION_CHANGED',switchAttempted:false};}
    if(!content.classList.contains('selected')){switchAttempted=true;content.click();
      for(let attempt=0;attempt<20&&!content.classList.contains('selected');attempt+=1){
        await new Promise(resolve=>setTimeout(resolve,250));}}
    if(!content.classList.contains('selected')){
      return {ok:false,url,target,reason:'DOM_SELECTION_UNCONFIRMED',switchAttempted};}
    const panels=[...document.querySelectorAll('.chat-message-list')];
    if(panels.length!==1)return {ok:false,url,target,reason:'DOM_MESSAGE_PANEL_NOT_UNIQUE',switchAttempted};
    const normalizeTime=value=>{const text=clean(value);if(!text)return null;const numeric=Number(text);
      const millis=Number.isFinite(numeric)?(numeric>0&&numeric<100000000000?numeric*1000:numeric):Date.parse(text);
      const date=new Date(millis);return Number.isFinite(date.getTime())?date.toISOString():null;};
    const statusKind = text => (${classifyResumeText.toString()})(text, ${JSON.stringify(RESUME_RULES)});
    const observations=[],unresolved=[],seen=new Set();
    for(const node of panels[0].querySelectorAll('[data-message-id][data-message-time]')){
      const statusNode=node.querySelector('.system-text');
      const kind=statusKind(clean(statusNode?.innerText));if(!kind)continue;
      const messageId=clean(node.getAttribute('data-message-id')),platformTime=normalizeTime(node.getAttribute('data-message-time'));
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(messageId??'')||!platformTime){
        unresolved.push({conversationKey:target.conversationKey,reason:'DOM_MESSAGE_IDENTITY_INCOMPLETE'});continue;}
      const key=JSON.stringify([messageId,kind,platformTime]);if(seen.has(key))continue;seen.add(key);
      const rawJobId=clean(node.getAttribute('data-job-id'));
      observations.push({conversationKey:target.conversationKey,friendId:target.friendId,
        friendSource:target.friendSource,messageId,direction:'system',messageType:5,kind,platformTime,
        externalJobId:/^[A-Za-z0-9_~\-]{1,300}$/.test(rawJobId??'')?rawJobId:null,
        source:${JSON.stringify(DOM_STATUS_SOURCE)}});}
    return {ok:true,url,target,switchAttempted,capturedAt:new Date().toISOString(),observations,unresolved,
      coverage:{requestedConversations:1,resolvedConversations:1,pagesPerConversation:0}};`,
  );
}

function safeReason(value, fallback) {
  return codePattern.test(String(value ?? '')) ? String(value) : fallback;
}

function validatePreflight(value, target) {
  return Boolean(
    value?.ok &&
    value.url === expectedUrl &&
    value.switchAttempted === false &&
    JSON.stringify(value.target) === JSON.stringify(target) &&
    value.proof?.ruleId === DOM_RULE_ID &&
    value.proof?.unreadMsgCount === 0 &&
    value.proof?.latestMessageId === target.latestMessageId &&
    typeof value.selected === 'boolean',
  );
}

function applyDomPayload(payload, envelope, target) {
  if (
    !payload?.ok ||
    payload.url !== expectedUrl ||
    JSON.stringify(payload.target) !== JSON.stringify(target) ||
    typeof payload.switchAttempted !== 'boolean' ||
    !Array.isArray(payload.observations) ||
    payload.observations.some((item) => item.source !== DOM_STATUS_SOURCE)
  ) {
    throw new Error('DOM_SUPPLEMENT_RESULT_INVALID');
  }
  const previous = {
    lastScanAt: envelope.resume.lastScanAt,
    lastCoverage: envelope.resume.lastCoverage,
    lastUnresolved: envelope.resume.lastUnresolved,
  };
  const normalized = toResumeHistoryResult(payload, envelope);
  const applied = applyResumeHistoryV2(envelope, normalized);
  applied.envelope.resume.lastScanAt = previous.lastScanAt;
  applied.envelope.resume.lastCoverage = structuredClone(previous.lastCoverage);
  applied.envelope.resume.lastUnresolved = structuredClone(previous.lastUnresolved);
  applied.envelope = validateCurrentEnvelope(applied.envelope);
  return applied;
}

export async function collectDomSupplement({
  directory,
  envelope,
  maxSwitches = 0,
  execute,
  verify = async () => ({ ok: true }),
  now = () => new Date(),
  minimumIntervalMs = 30_000,
} = {}) {
  const checked = validateEnvelope(envelope);
  if (
    typeof directory !== 'string' ||
    !directory ||
    !Number.isInteger(maxSwitches) ||
    maxSwitches < 0 ||
    maxSwitches > 1 ||
    typeof execute !== 'function' ||
    typeof verify !== 'function' ||
    typeof now !== 'function' ||
    !Number.isInteger(minimumIntervalMs) ||
    minimumIntervalMs < 30_000
  ) {
    throw new TypeError('DOM_SUPPLEMENT_INPUT_INVALID');
  }
  const [policyResult, state, checkpoint] = await Promise.all([
    loadDomSupplementPolicy(directory, checked.accountNamespace),
    readState(directory),
    readCheckpoint(directory),
  ]);
  const base = {
    envelope: checked,
    usage: { domSwitches: 0 },
    counts: { pending: 0, selected: 0, switched: 0, observed: 0, added: 0, unresolved: 0 },
    partial: false,
    error: null,
    nextAllowedAt: null,
    policyStatus: policyResult.status,
    checkpointPending: Boolean(checkpoint),
  };
  if (maxSwitches === 0) return { ...base, error: null, reason: 'DOM_BUDGET_ZERO' };
  const selection = domSupplementTasks(checked, { policy: policyResult.policy, state, checkpoint });
  base.counts.pending = selection.pending;
  if (!policyResult.policy?.enabled) return { ...base, reason: 'DOM_POLICY_DISABLED' };
  if (!selection.selected) return { ...base, reason: selection.reason };
  const target = selection.selected;
  base.counts.selected = 1;
  if (checkpoint?.stage === 'switch_issued') {
    return {
      ...base,
      partial: true,
      error: 'DOM_SWITCH_OUTCOME_UNKNOWN',
      reason: 'DOM_CHECKPOINT_REQUIRES_REVIEW',
    };
  }
  const current = now(),
    currentIso = current instanceof Date ? current.toISOString() : new Date(current).toISOString();
  if (!Number.isFinite(Date.parse(currentIso))) throw new TypeError('DOM_SUPPLEMENT_CLOCK_INVALID');
  const nextAllowedAt =
    state.lastSwitchAt === null
      ? null
      : new Date(Date.parse(state.lastSwitchAt) + minimumIntervalMs).toISOString();
  if (nextAllowedAt && Date.parse(currentIso) < Date.parse(nextAllowedAt)) {
    return { ...base, nextAllowedAt, reason: 'DOM_SWITCH_INTERVAL' };
  }
  if (!checkpoint)
    await saveCheckpoint(directory, {
      version: 1,
      taskId: target.taskId,
      conversationKey: target.conversationKey,
      latestMessageId: target.latestMessageId,
      ruleId: DOM_RULE_ID,
      stage: 'selected',
      selectedAt: currentIso,
      issuedAt: null,
    });
  const identity = await verify();
  if (!identity?.ok)
    return {
      ...base,
      partial: true,
      error: safeReason(identity?.error, 'DOM_IDENTITY_CHECK_FAILED'),
      checkpointPending: true,
      reason: 'DOM_IDENTITY_CHECK_FAILED',
    };
  let preflight;
  try {
    preflight = await execute(createDomSupplementPreflightExpression(target), {
      kind: 'dom_preflight',
      target,
    });
  } catch (error) {
    return {
      ...base,
      partial: true,
      error: safeReason(error?.message, 'DOM_PREFLIGHT_FAILED'),
      checkpointPending: true,
      reason: 'DOM_PREFLIGHT_FAILED',
    };
  }
  if (!validatePreflight(preflight, target)) {
    return {
      ...base,
      reason: safeReason(preflight?.reason, 'DOM_PREFLIGHT_REJECTED'),
      checkpointPending: true,
    };
  }
  const needsSwitch = !preflight.selected;
  const issuedAt = currentIso;
  if (needsSwitch) {
    await saveCheckpoint(directory, {
      version: 1,
      taskId: target.taskId,
      conversationKey: target.conversationKey,
      latestMessageId: target.latestMessageId,
      ruleId: DOM_RULE_ID,
      stage: 'switch_issued',
      selectedAt: checkpoint?.selectedAt ?? currentIso,
      issuedAt,
    });
  }
  let nextState = needsSwitch ? { ...state, lastSwitchAt: issuedAt, updatedAt: issuedAt } : state;
  if (needsSwitch) await saveState(directory, nextState);
  let payload;
  try {
    payload = await execute(
      createDomSupplementReadExpression(target, { allowSwitch: needsSwitch }),
      { kind: 'dom_read', target },
    );
  } catch (error) {
    return {
      ...base,
      usage: { domSwitches: needsSwitch ? 1 : 0 },
      partial: true,
      error: safeReason(error?.message, 'DOM_SUPPLEMENT_FAILED'),
      checkpointPending: true,
      reason: 'DOM_READ_FAILED',
    };
  }
  if (!payload?.ok) {
    const switched = payload?.switchAttempted === true;
    if (!switched)
      await saveCheckpoint(directory, {
        version: 1,
        taskId: target.taskId,
        conversationKey: target.conversationKey,
        latestMessageId: target.latestMessageId,
        ruleId: DOM_RULE_ID,
        stage: 'selected',
        selectedAt: checkpoint?.selectedAt ?? currentIso,
        issuedAt: null,
      });
    return {
      ...base,
      usage: { domSwitches: switched ? 1 : 0 },
      counts: { ...base.counts, switched: switched ? 1 : 0 },
      partial: switched,
      error: switched ? safeReason(payload.reason, 'DOM_SUPPLEMENT_FAILED') : null,
      checkpointPending: true,
      reason: safeReason(payload?.reason, 'DOM_SUPPLEMENT_REJECTED'),
    };
  }
  let applied;
  try {
    applied = applyDomPayload(payload, checked, target);
  } catch (error) {
    return {
      ...base,
      usage: { domSwitches: payload.switchAttempted ? 1 : 0 },
      partial: true,
      error: safeReason(error?.message, 'DOM_SUPPLEMENT_RESULT_INVALID'),
      checkpointPending: true,
      reason: 'DOM_RESULT_REJECTED',
    };
  }
  const completedAt = payload.capturedAt;
  nextState = normalizeState({
    ...nextState,
    cursor: target.conversationKey,
    completed: [
      ...nextState.completed,
      {
        taskId: target.taskId,
        completedAt,
        outcome: applied.report.counts.observed ? 'observed' : 'no_matching_status',
      },
    ],
    updatedAt: completedAt,
  });
  await saveState(directory, nextState);
  await removeCheckpoint(directory);
  return {
    ...base,
    envelope: applied.envelope,
    usage: { domSwitches: payload.switchAttempted ? 1 : 0 },
    counts: {
      pending: Math.max(0, selection.pending - 1),
      selected: 1,
      switched: payload.switchAttempted ? 1 : 0,
      observed: applied.report.counts.observed,
      added: applied.report.counts.added,
      unresolved: applied.report.counts.unresolved,
    },
    policyStatus: 'enabled',
    checkpointPending: false,
    reason: null,
  };
}
