import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

const invalidCode = 'BOSS_IDENTITY_SAMPLE_INVALID';
const saveCode = 'BOSS_IDENTITY_SAMPLE_SAVE_FAILED';
const states = new Set(['missing', 'null', 'invalid', 'present']);
const types = new Set([
  'missing',
  'null',
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'undefined',
  'other',
]);
const commonPaths = new Set([
  'account.pageUid',
  'account.storeUserId',
  'request.friendId',
  'request.friendSource',
  'request.bossId',
  'selection.bossId',
  'list.friendId',
  'list.uid',
  'list.friendSource',
  'list.uniqueId',
  'list.encryptJobId',
]);
const uuidFile = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\.json$/;
const friendPath = /^response\.zpData\.result\[(\d|1\d)\]\.(uid|friendId|friendSource|bossId)$/;
const historyPath =
  /^response\.zpData\.(messages|historyMsgList)\[(\d|1\d)\]\.(mid|msgId|messageId|id|body\.mid|body\.msgId|from\.uid|to\.uid|encryptJobId|jobId|body\.encryptJobId|body\.jobId|body\.job\.encryptJobId|body\.job\.jobId)$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function object(value, keys) {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
  )
    fail(invalidCode);
}

function array(value, maximum) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    fail(invalidCode);
  for (let index = 0; index < value.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(value, index);
    if (!property || !Object.hasOwn(property, 'value')) fail(invalidCode);
  }
}

function validateSample(sample, stage, page) {
  object(sample, ['version', 'stage', 'page', 'result', 'arrays', 'fields']);
  if (
    sample.version !== 1 ||
    sample.stage !== stage ||
    sample.page !== page ||
    !['ok', 'request_failed', 'response_unavailable'].includes(sample.result)
  )
    fail(invalidCode);
  array(sample.arrays, 2);
  array(sample.fields, 600);
  const paths = new Set();
  const arrays = sample.arrays.map((item) => {
    object(item, ['path', 'state', 'count', 'sampled']);
    const allowed =
      stage === 'friend'
        ? ['response.zpData.result']
        : ['response.zpData.messages', 'response.zpData.historyMsgList'];
    if (
      !allowed.includes(item.path) ||
      paths.has(item.path) ||
      !states.has(item.state) ||
      !Number.isSafeInteger(item.sampled) ||
      item.sampled < 0 ||
      item.sampled > 20 ||
      (item.state === 'present'
        ? !Number.isSafeInteger(item.count) ||
          item.count < 0 ||
          item.sampled !== Math.min(item.count, 20)
        : item.count !== null || item.sampled !== 0)
    )
      fail(invalidCode);
    paths.add(item.path);
    return { path: item.path, state: item.state, count: item.count, sampled: item.sampled };
  });
  const identities = new Set();
  const fields = sample.fields.map((item) => {
    object(item, ['path', 'type', 'state', 'identity']);
    if (
      typeof item.path !== 'string' ||
      (!commonPaths.has(item.path) &&
        !(stage === 'friend' ? friendPath : historyPath).test(item.path)) ||
      paths.has(item.path) ||
      !types.has(item.type) ||
      !states.has(item.state) ||
      (item.state === 'missing' && item.type !== 'missing') ||
      (item.state === 'null' && item.type !== 'null') ||
      (item.state === 'invalid' && ['missing', 'null'].includes(item.type)) ||
      (item.state === 'present' && !['string', 'number'].includes(item.type))
    )
      fail(invalidCode);
    if (item.state !== 'present') {
      if (item.identity !== null) fail(invalidCode);
    } else if (!identities.has(item.identity)) {
      if (item.identity !== `identity-${identities.size + 1}`) fail(invalidCode);
      identities.add(item.identity);
    }
    if (item.path.startsWith('response.')) {
      const match = /^(.*)\[(\d+)\]\./.exec(item.path);
      const source = arrays.find((entry) => entry.path === match[1]);
      if (!source || Number(match[2]) >= source.sampled) fail(invalidCode);
    }
    paths.add(item.path);
    return { path: item.path, type: item.type, state: item.state, identity: item.identity };
  });
  return { version: 1, stage, page, result: sample.result, arrays, fields };
}

async function checkDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(saveCode);
}

async function checkRoot(root) {
  let current = parse(root).root;
  for (const part of root.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    await checkDirectory(current);
  }
}

async function prepareDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await checkDirectory(path);
  await chmod(path, 0o700);
}

async function syncDirectory(path) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// One-time investigation material, separate from snapshots and business evidence.
export async function saveBossIdentitySample(root, options) {
  let body;
  try {
    if (typeof root !== 'string' || !root || root.includes('\0')) fail(invalidCode);
    if (!options || typeof options !== 'object') fail(invalidCode);
    const keys = Reflect.ownKeys(options);
    if (
      keys.some((key) => !['conversationKey', 'stage', 'page', 'sample', 'previous'].includes(key))
    )
      fail(invalidCode);
    object(options, keys);
    const { conversationKey, stage, page = 0, sample, previous = null } = options;
    if (
      typeof conversationKey !== 'string' ||
      !/^[a-f\d]{64}$/.test(conversationKey) ||
      !['friend', 'history'].includes(stage) ||
      !Number.isSafeInteger(page) ||
      (stage === 'friend' ? page !== 0 : page < 1 || page > 20) ||
      (previous !== null &&
        (stage !== 'history' || typeof previous !== 'string' || !uuidFile.test(previous)))
    )
      fail(invalidCode);
    body = {
      capturedAt: new Date().toISOString(),
      conversationKey,
      sample: validateSample(sample, stage, page),
      previous,
    };
  } catch {
    fail(invalidCode);
  }

  let temporary = null,
    handle = null;
  try {
    root = resolve(root);
    await checkRoot(root);
    await chmod(root, 0o700);
    const parent = join(root, 'attribution-diagnostics');
    const directory = join(parent, 'identity-check');
    await prepareDirectory(parent);
    await prepareDirectory(directory);
    if (body.previous !== null) {
      const info = await lstat(join(directory, body.previous));
      if (!info.isFile() || info.isSymbolicLink()) fail(saveCode);
    }
    const name = `${randomUUID()}.json`;
    const path = join(directory, name);
    temporary = join(directory, `.${randomUUID()}.tmp`);
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(body)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, path);
    await unlink(temporary);
    temporary = null;
    for (const path of [directory, parent, root]) await syncDirectory(path);
    return name;
  } catch {
    fail(saveCode);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
