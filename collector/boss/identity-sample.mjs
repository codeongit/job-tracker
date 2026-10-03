// Temporary, response-time evidence. Keep these functions self-contained: the
// collector embeds their source in the page without loading a browser module.
export function buildIdentitySample({
  stage,
  target,
  identity = null,
  response,
  account = {},
  list = null,
  page = 0,
}) {
  if (
    !['friend', 'history'].includes(stage) ||
    !Number.isInteger(page) ||
    (stage === 'friend' ? page !== 0 : page < 1 || page > 20)
  )
    throw new TypeError('IDENTITY_SAMPLE_INPUT_INVALID');

  const fields = [],
    arrays = [],
    identities = new Map();
  const read = (root, keys) => {
    let value = root;
    for (const key of keys) {
      if (
        value === null ||
        !['object', 'function'].includes(typeof value) ||
        !Object.hasOwn(value, key)
      )
        return { exists: false };
      value = value[key];
    }
    return { exists: true, value };
  };
  const add = (path, root, keys) => {
    const { exists, value } = read(root, keys);
    const type = !exists
      ? 'missing'
      : value === null
        ? 'null'
        : Array.isArray(value)
          ? 'array'
          : ['string', 'number', 'boolean', 'object', 'undefined'].includes(typeof value)
            ? typeof value
            : 'other';
    let state = !exists ? 'missing' : value === null ? 'null' : 'invalid',
      alias = null;
    if (type === 'string' || (type === 'number' && Number.isSafeInteger(value))) {
      const normalized = String(value).normalize('NFC').trim();
      if (/^[A-Za-z0-9_-]{1,300}$/.test(normalized)) {
        state = 'present';
        if (!identities.has(normalized))
          identities.set(normalized, `identity-${identities.size + 1}`);
        alias = identities.get(normalized);
      }
    }
    fields.push({ path, type, state, identity: alias });
  };
  for (const key of ['pageUid', 'storeUserId']) add(`account.${key}`, account, [key]);
  for (const key of ['friendId', 'friendSource']) add(`request.${key}`, target, [key]);
  add('request.bossId', stage === 'history' ? identity : null, ['bossId']);
  add('selection.bossId', stage === 'friend' ? identity : null, ['bossId']);
  for (const key of ['friendId', 'uid', 'friendSource', 'uniqueId', 'encryptJobId'])
    add(`list.${key}`, list, [key]);

  const result =
    response?.ok === false
      ? 'request_failed'
      : response?.ok === true && response.value?.code === 0
        ? 'ok'
        : 'response_unavailable';
  const payload = result === 'ok' ? response.value : null;
  const arrayKeys = stage === 'friend' ? ['result'] : ['messages', 'historyMsgList'];
  const messageKeys = [
    ['mid'],
    ['msgId'],
    ['messageId'],
    ['id'],
    ['body', 'mid'],
    ['body', 'msgId'],
    ['from', 'uid'],
    ['to', 'uid'],
    ['encryptJobId'],
    ['jobId'],
    ['body', 'encryptJobId'],
    ['body', 'jobId'],
    ['body', 'job', 'encryptJobId'],
    ['body', 'job', 'jobId'],
  ];
  for (const key of arrayKeys) {
    const path = `response.zpData.${key}`;
    const { exists, value } = read(payload, ['zpData', key]);
    const state = !exists
      ? 'missing'
      : value === null
        ? 'null'
        : Array.isArray(value)
          ? 'present'
          : 'invalid';
    const count = state === 'present' ? value.length : null;
    const sampled = count === null ? 0 : Math.min(count, 20);
    arrays.push({ path, state, count, sampled });
    for (let index = 0; index < sampled; index += 1) {
      const keys =
        stage === 'friend' ? [['uid'], ['friendId'], ['friendSource'], ['bossId']] : messageKeys;
      for (const parts of keys) add(`${path}[${index}].${parts.join('.')}`, value[index], parts);
    }
  }
  return { version: 1, stage, page, result, arrays, fields };
}

export function pageIdentityContext(target) {
  const account = {};
  const project = (value) => {
    if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value))
      return value;
    if (Array.isArray(value)) return [];
    // Invalid object values retain their type without exposing their contents.
    if (typeof value === 'object') return {};
    return undefined;
  };
  const copy = (destination, key, source, sourceKey = key) => {
    if (source && Object.hasOwn(source, sourceKey)) destination[key] = project(source[sourceKey]);
  };
  if (typeof window !== 'undefined') copy(account, 'pageUid', window._PAGE, 'uid');
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function')
    return { account, list: null };
  const rows = [...document.querySelectorAll('li[role="listitem"]')];
  let listVm = null;
  for (const start of rows.slice(0, 5)) {
    for (let node = start, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) {
      if (
        node.__vue__?.$options?.name === 'virtual-list' &&
        Array.isArray(node.__vue__?.$props?.dataSources)
      ) {
        listVm = node.__vue__;
        break;
      }
    }
    if (listVm) break;
  }
  if (!listVm) return { account, list: null };
  copy(account, 'storeUserId', listVm.$store?.state?.userInfo, 'userId');
  const sources = listVm.$props.dataSources;
  if (!sources.length || sources.length > 1000) return { account, list: null };
  const clean = (value) => {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)))
      return null;
    const normalized = String(value).normalize('NFC').trim();
    return /^[A-Za-z0-9_-]{1,300}$/.test(normalized) ? normalized : null;
  };
  const friendId = clean(target?.friendId),
    friendSource = clean(target?.friendSource);
  if (!friendId || !friendSource) return { account, list: null };
  const matches = sources.filter(
    (source) =>
      source &&
      typeof source === 'object' &&
      clean(source.friendId ?? source.uid) === friendId &&
      clean(source.friendSource) === friendSource,
  );
  if (matches.length !== 1) return { account, list: null };
  const list = {};
  for (const key of ['friendId', 'uid', 'friendSource', 'uniqueId', 'encryptJobId'])
    copy(list, key, matches[0]);
  return { account, list };
}
