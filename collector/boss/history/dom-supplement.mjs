import {
  RESUME_RULES,
  classifyResumeText,
  classifyResumeEvidence,
  assessResumeEvidence,
  RESUME_STATUS_KINDS,
  validateResumeEvidence,
} from '../../../dist/boss/rules/resume-rules.js';
import { validateAttributionEvidence } from '../../../dist/boss/rules/attribution.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { expectedUrl } from '../platform/guard.mjs';
import { applyResumeHistoryV2, toResumeHistoryResult } from './resume-history.mjs';
import {
  conversationKeyV2,
  validateEnvelope,
  validateCurrentEnvelope,
  upgradeEnvelope,
} from '../materials/model-v2.mjs';
import { commit } from '../persistence/storage.mjs';

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
    !onlyFields(value, ['version', 'cursor', 'lastSwitchAt', 'completed', 'updatedAt']) ||
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
      !onlyFields(item, ['taskId', 'completedAt', 'outcome']) ||
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
  const legacyFields = [
    'version',
    'taskId',
    'conversationKey',
    'latestMessageId',
    'ruleId',
    'stage',
    'selectedAt',
    'issuedAt',
  ];
  const resultFields = ['capturedAt', 'switchAttempted', 'observations', 'unresolved', 'coverage'];
  const fields =
    value?.version === 1
      ? legacyFields
      : [
          ...legacyFields,
          'accountNamespace',
          'target',
          ...(value?.stage === 'result_ready' ? resultFields : []),
        ];
  if (
    !onlyFields(value, fields) ||
    ![1, 2].includes(value.version) ||
    !keyPattern.test(value.taskId ?? '') ||
    !keyPattern.test(value.conversationKey ?? '') ||
    !idPattern.test(value.latestMessageId ?? '') ||
    value.ruleId !== DOM_RULE_ID ||
    !['selected', 'switch_issued', ...(value.version === 2 ? ['result_ready'] : [])].includes(
      value.stage,
    ) ||
    !iso(value.selectedAt) ||
    (value.issuedAt !== null && !iso(value.issuedAt)) ||
    (value.stage === 'selected' && value.issuedAt !== null) ||
    (value.stage === 'switch_issued' && value.issuedAt === null)
  ) {
    throw new Error('DOM_SUPPLEMENT_CHECKPOINT_INVALID');
  }
  if (value.version === 2) {
    try {
      const target = normalizedTarget(value.target);
      if (
        !/^boss-geek:[a-f0-9]{64}$/.test(value.accountNamespace ?? '') ||
        value.taskId !== target.taskId ||
        value.conversationKey !== target.conversationKey ||
        value.latestMessageId !== target.latestMessageId ||
        target.conversationKey !==
          conversationKeyV2(value.accountNamespace, target.friendId, target.friendSource) ||
        target.taskId !==
          taskId(value.accountNamespace, {
            key: target.conversationKey,
            latestMessageId: target.latestMessageId,
          })
      )
        throw new Error('INVALID_TARGET');
      if (value.stage === 'result_ready') {
        if (
          !iso(value.capturedAt) ||
          typeof value.switchAttempted !== 'boolean' ||
          (value.switchAttempted && value.issuedAt === null) ||
          !Array.isArray(value.observations) ||
          !Array.isArray(value.unresolved) ||
          !onlyFields(value.coverage, [
            'requestedConversations',
            'resolvedConversations',
            'pagesPerConversation',
            'requestedPages',
            'completedPages',
            'exhaustedConversations',
            'truncatedConversations',
            'failedConversations',
          ]) ||
          value.coverage.requestedConversations !== 1 ||
          value.coverage.resolvedConversations !== 1 ||
          value.coverage.pagesPerConversation !== 0 ||
          Object.values(value.coverage).some((item) => !Number.isSafeInteger(item) || item < 0)
        )
          throw new Error('INVALID_RESULT');
        for (const observation of value.observations) {
          if (
            !onlyFields(observation, [
              'conversationKey',
              'friendId',
              'friendSource',
              'messageId',
              'direction',
              'messageType',
              'kind',
              'platformTime',
              'externalJobId',
              'source',
              'resumeEvidence',
              'attribution',
            ]) ||
            observation.conversationKey !== target.conversationKey ||
            observation.friendId !== target.friendId ||
            observation.friendSource !== target.friendSource ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(observation.messageId ?? '') ||
            observation.direction !== 'system' ||
            observation.messageType !== 5 ||
            !RESUME_STATUS_KINDS.includes(observation.kind) ||
            !iso(observation.platformTime) ||
            (observation.externalJobId !== null &&
              !/^[A-Za-z0-9_~\-]{1,300}$/.test(observation.externalJobId ?? '')) ||
            observation.source !== DOM_STATUS_SOURCE
          )
            throw new Error('INVALID_OBSERVATION');
          const proof = validateResumeEvidence(observation.resumeEvidence);
          if (proof && proof.messageType !== observation.messageType)
            throw new Error('INVALID_PROOF');
          validateAttributionEvidence(observation.attribution);
          if (
            observation.attribution &&
            observation.attribution.accountNamespace !== value.accountNamespace
          )
            throw new Error('INVALID_ACCOUNT');
        }
        if (
          value.unresolved.some(
            (item) =>
              !onlyFields(item, ['conversationKey', 'reason']) ||
              item.conversationKey !== target.conversationKey ||
              !codePattern.test(item.reason ?? ''),
          )
        )
          throw new Error('INVALID_UNRESOLVED');
      }
    } catch {
      throw new Error('DOM_SUPPLEMENT_CHECKPOINT_INVALID');
    }
  }
  return structuredClone(value);
}

function onlyFields(value, fields) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key))
  );
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
    !onlyFields(value, [
      'taskId',
      'conversationKey',
      'friendId',
      'friendSource',
      'uniqueId',
      'latestMessageId',
    ]) ||
    Object.values(value).some((item) => typeof item !== 'string') ||
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
    const statusEvidence = text => (${classifyResumeEvidence.toString()})({type:5,content:text}, ${JSON.stringify(RESUME_RULES)}, (${classifyResumeText.toString()}), {platformContract:null}, (${assessResumeEvidence.toString()}));
    const observations=[],unresolved=[],seen=new Set();
    for(const node of panels[0].querySelectorAll('[data-message-id][data-message-time]')){
      const statusNode=node.querySelector('.system-text');
      const status=statusEvidence(clean(statusNode?.innerText));if(!status)continue;const kind=status.kind;
      const messageId=clean(node.getAttribute('data-message-id')),platformTime=normalizeTime(node.getAttribute('data-message-time'));
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(messageId??'')||!platformTime){
        unresolved.push({conversationKey:target.conversationKey,reason:'DOM_MESSAGE_IDENTITY_INCOMPLETE'});continue;}
      const key=JSON.stringify([messageId,kind,platformTime]);if(seen.has(key))continue;seen.add(key);
      const rawJobId=clean(node.getAttribute('data-job-id'));
      observations.push({conversationKey:target.conversationKey,friendId:target.friendId,
        friendSource:target.friendSource,messageId,direction:'system',messageType:5,kind,resumeEvidence:status.evidence,platformTime,
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
  applied.result = normalized;
  return applied;
}

function checkpointFor(target, accountNamespace, stage, selectedAt, issuedAt) {
  return {
    version: 2,
    taskId: target.taskId,
    conversationKey: target.conversationKey,
    latestMessageId: target.latestMessageId,
    ruleId: DOM_RULE_ID,
    stage,
    selectedAt,
    issuedAt,
    accountNamespace,
    target: structuredClone(target),
  };
}

function readyCheckpoint(checkpoint, payload, result) {
  return normalizeCheckpoint({
    ...checkpoint,
    stage: 'result_ready',
    capturedAt: result.capturedAt,
    switchAttempted: payload.switchAttempted,
    observations: result.observations.map((item) => ({
      conversationKey: item.conversationKey,
      friendId: item.platformIdentity.friendId,
      friendSource: item.platformIdentity.friendSource,
      messageId: item.messageId,
      direction: item.direction,
      messageType: item.messageType,
      kind: item.kind,
      platformTime: item.platformTime,
      externalJobId: item.externalJobId,
      source: item.source,
      resumeEvidence: item.resumeEvidence,
      attribution: item.attribution,
    })),
    unresolved: result.unresolved,
    coverage: result.coverage,
  });
}

const defaultCheckpoints = {
  load: readCheckpoint,
  save: saveCheckpoint,
  remove: removeCheckpoint,
};

function domReport(envelope, checkpoint = null) {
  return {
    envelope,
    recovered: false,
    usage: { domSwitches: 0 },
    counts: { pending: 0, selected: 0, switched: 0, observed: 0, added: 0, unresolved: 0 },
    partial: false,
    error: null,
    nextAllowedAt: null,
    policyStatus: 'not_checked',
    checkpointPending: Boolean(checkpoint),
    reason: null,
  };
}

function withUsage(error, domSwitches) {
  const failure = error instanceof Error ? error : new Error('DOM_SUPPLEMENT_SAVE_FAILED');
  failure.usage = { ...failure.usage, domSwitches };
  return failure;
}

async function commitDomResult({
  directory,
  envelope,
  state,
  checkpoint,
  saveEvidence,
  saveProgress,
  checkpoints,
}) {
  const payload = {
    ok: true,
    url: expectedUrl,
    target: checkpoint.target,
    switchAttempted: checkpoint.switchAttempted,
    capturedAt: checkpoint.capturedAt,
    observations: checkpoint.observations,
    unresolved: checkpoint.unresolved,
    coverage: checkpoint.coverage,
  };
  const applied = applyDomPayload(payload, envelope, checkpoint.target);
  const completed = state.completed.find((item) => item.taskId === checkpoint.taskId);
  const nextState = completed
    ? state
    : normalizeState({
        ...state,
        cursor: checkpoint.conversationKey,
        lastSwitchAt: checkpoint.issuedAt ?? state.lastSwitchAt,
        completed: [
          ...state.completed,
          {
            taskId: checkpoint.taskId,
            completedAt: checkpoint.capturedAt,
            outcome: applied.report.counts.observed ? 'observed' : 'no_matching_status',
          },
        ],
        updatedAt: checkpoint.capturedAt,
      });
  const files = await saveEvidence(applied.envelope);
  const snapshotPath =
    typeof files === 'string' ? files : (files?.snapshotPath ?? files?.file ?? null);
  try {
    await saveProgress(nextState);
    await checkpoints.remove(directory);
  } catch (error) {
    if (error instanceof Error && snapshotPath) error.snapshotPath ??= snapshotPath;
    throw error;
  }
  return {
    ...domReport(applied.envelope),
    recovered: true,
    snapshotPath,
    counts: {
      pending: domSupplementTasks(applied.envelope, { state: nextState }).pending,
      selected: 1,
      switched: 0,
      observed: applied.report.counts.observed,
      added: applied.report.counts.added,
      unresolved: applied.report.counts.unresolved,
    },
  };
}

// Only replays validated local results. Pending selection and uncertain actions
// remain untouched until an authorized collection or an explicit review.
export async function recoverDomSupplement({
  directory,
  envelope,
  saveEvidence = (value) => commit(directory, value),
  saveProgress = (value) => saveState(directory, value),
  checkpoints = defaultCheckpoints,
} = {}) {
  const checked = validateEnvelope(envelope);
  checkpoints = { ...defaultCheckpoints, ...checkpoints };
  if (
    typeof directory !== 'string' ||
    !directory ||
    typeof saveEvidence !== 'function' ||
    typeof saveProgress !== 'function' ||
    !checkpoints ||
    ['load', 'save', 'remove'].some((key) => typeof checkpoints[key] !== 'function')
  )
    throw new TypeError('DOM_SUPPLEMENT_INPUT_INVALID');
  try {
    const [state, loaded] = await Promise.all([readState(directory), checkpoints.load(directory)]);
    const checkpoint = loaded === null ? null : normalizeCheckpoint(loaded);
    const base = domReport(checked, checkpoint);
    if (!checkpoint) return base;
    if (checkpoint.version === 2 && checkpoint.accountNamespace !== checked.accountNamespace)
      throw new Error('DOM_SUPPLEMENT_CHECKPOINT_ACCOUNT_MISMATCH');
    if (checkpoint.stage === 'selected')
      return { ...base, reason: 'DOM_CHECKPOINT_AWAITING_AUTHORIZATION' };
    if (checkpoint.stage === 'switch_issued')
      return {
        ...base,
        partial: true,
        error: 'DOM_SWITCH_OUTCOME_UNKNOWN',
        reason: 'DOM_CHECKPOINT_REQUIRES_REVIEW',
      };
    return await commitDomResult({
      directory,
      envelope: checked,
      state,
      checkpoint,
      saveEvidence,
      saveProgress,
      checkpoints,
    });
  } catch (error) {
    throw withUsage(error, 0);
  }
}

export async function collectDomSupplement({
  directory,
  envelope,
  maxSwitches = 0,
  execute,
  verify = async () => ({ ok: true }),
  now = () => new Date(),
  minimumIntervalMs = 30_000,
  saveRecoveryBase = (value) => commit(directory, upgradeEnvelope(value)),
  saveEvidence = (value) => commit(directory, value),
  saveProgress = (value) => saveState(directory, value),
  checkpoints = defaultCheckpoints,
} = {}) {
  const checked = validateEnvelope(envelope);
  checkpoints = { ...defaultCheckpoints, ...checkpoints };
  if (
    typeof directory !== 'string' ||
    !directory ||
    !Number.isInteger(maxSwitches) ||
    maxSwitches < 0 ||
    maxSwitches > 1 ||
    typeof execute !== 'function' ||
    typeof verify !== 'function' ||
    typeof now !== 'function' ||
    typeof saveRecoveryBase !== 'function' ||
    typeof saveEvidence !== 'function' ||
    typeof saveProgress !== 'function' ||
    !Number.isInteger(minimumIntervalMs) ||
    minimumIntervalMs < 30_000
  ) {
    throw new TypeError('DOM_SUPPLEMENT_INPUT_INVALID');
  }
  const recovered = await recoverDomSupplement({
    directory,
    envelope: checked,
    saveEvidence,
    saveProgress,
    checkpoints,
  });
  if (recovered.recovered || recovered.partial) return recovered;
  const [policyResult, state, checkpoint] = await Promise.all([
    loadDomSupplementPolicy(directory, checked.accountNamespace),
    readState(directory),
    checkpoints.load(directory),
  ]);
  const base = {
    ...domReport(checked, checkpoint),
    policyStatus: policyResult.status,
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
  // A newly loaded target may not exist in the prior immutable snapshot. Keep
  // its validated model context before any target read so a ready result can
  // be recovered from disk even if the later evidence save fails.
  try {
    await saveRecoveryBase(checked);
  } catch (error) {
    throw withUsage(error, 0);
  }
  const selectedAt = checkpoint?.selectedAt ?? currentIso;
  let activeCheckpoint = checkpointFor(
    target,
    checked.accountNamespace,
    'selected',
    selectedAt,
    null,
  );
  if (!checkpoint) await checkpoints.save(directory, activeCheckpoint);
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
    activeCheckpoint = checkpointFor(
      target,
      checked.accountNamespace,
      'switch_issued',
      selectedAt,
      issuedAt,
    );
    await checkpoints.save(directory, activeCheckpoint);
  }
  let nextState = needsSwitch ? { ...state, lastSwitchAt: issuedAt, updatedAt: issuedAt } : state;
  if (needsSwitch) await saveProgress(nextState);
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
    const unknown = typeof payload?.switchAttempted !== 'boolean' && needsSwitch;
    if (!switched && !unknown) {
      try {
        await checkpoints.save(
          directory,
          checkpointFor(target, checked.accountNamespace, 'selected', selectedAt, null),
        );
      } catch (error) {
        throw withUsage(error, 0);
      }
    }
    return {
      ...base,
      usage: { domSwitches: switched || unknown ? 1 : 0 },
      counts: { ...base.counts, switched: switched || unknown ? 1 : 0 },
      partial: switched || unknown,
      error: unknown
        ? 'DOM_SWITCH_OUTCOME_UNKNOWN'
        : switched
          ? safeReason(payload.reason, 'DOM_SUPPLEMENT_FAILED')
          : null,
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
      usage: {
        domSwitches:
          typeof payload.switchAttempted === 'boolean'
            ? Number(payload.switchAttempted)
            : Number(needsSwitch),
      },
      partial: true,
      error: safeReason(error?.message, 'DOM_SUPPLEMENT_RESULT_INVALID'),
      checkpointPending: true,
      reason: 'DOM_RESULT_REJECTED',
    };
  }
  let committed;
  try {
    const ready = readyCheckpoint(activeCheckpoint, payload, applied.result);
    await checkpoints.save(directory, ready);
    committed = await commitDomResult({
      directory,
      envelope: checked,
      state: nextState,
      checkpoint: ready,
      saveEvidence,
      saveProgress,
      checkpoints,
    });
  } catch (error) {
    throw withUsage(error, payload.switchAttempted ? 1 : 0);
  }
  return {
    ...committed,
    recovered: false,
    usage: { domSwitches: payload.switchAttempted ? 1 : 0 },
    counts: {
      pending: committed.counts.pending,
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
