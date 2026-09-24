import { createHash } from 'node:crypto';

const KEY = /^[a-f0-9]{64}$/;
const MESSAGE = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR = /^[A-Z][A-Z0-9_]{2,80}$/;
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const emptyHistoryState = () => ({
  initializedDay: null,
  legacyCheckpointDigest: null,
  conversations: [],
});

export function normalizeHistoryState(value = emptyHistoryState()) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value.initializedDay !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value.initializedDay)) ||
    (value.legacyCheckpointDigest !== undefined &&
      value.legacyCheckpointDigest !== null &&
      !KEY.test(value.legacyCheckpointDigest)) ||
    !Array.isArray(value.conversations) ||
    value.conversations.length > 5000
  )
    throw new Error('RUNTIME_HISTORY_INVALID');
  const seen = new Set();
  const conversations = value.conversations.map((item) => {
    if (
      !item ||
      !KEY.test(item.key ?? '') ||
      seen.has(item.key) ||
      !KEY.test(item.fingerprint ?? '') ||
      (item.watermark !== null && !MESSAGE.test(item.watermark ?? '')) ||
      (item.task !== null &&
        (!item.task ||
          !KEY.test(item.task.fingerprint ?? '') ||
          !iso(item.task.enqueuedAt) ||
          !Number.isInteger(item.task.page) ||
          item.task.page < 1 ||
          item.task.page > 20 ||
          (item.task.truncated !== undefined && typeof item.task.truncated !== 'boolean') ||
          (item.task.attempts !== undefined &&
            (!Number.isInteger(item.task.attempts) ||
              item.task.attempts < 0 ||
              item.task.attempts > 4)) ||
          (item.task.nextRetryAt !== undefined &&
            item.task.nextRetryAt !== null &&
            !iso(item.task.nextRetryAt)) ||
          (item.task.lastError !== undefined &&
            item.task.lastError !== null &&
            !ERROR.test(item.task.lastError)) ||
          (item.task.isolated !== undefined && typeof item.task.isolated !== 'boolean') ||
          (item.task.head !== null && !MESSAGE.test(item.task.head ?? ''))))
    )
      throw new Error('RUNTIME_HISTORY_INVALID');
    seen.add(item.key);
    return {
      key: item.key,
      fingerprint: item.fingerprint,
      watermark: item.watermark,
      task: item.task === null ? null : { ...item.task },
    };
  });
  return {
    initializedDay: value.initializedDay,
    legacyCheckpointDigest: value.legacyCheckpointDigest ?? null,
    conversations,
  };
}

export function listFingerprint(record) {
  return hash([
    record.latestObservation?.latestMessageId ?? record.latestMessageId ?? '',
    hash(record.latestObservation?.preview ?? record.preview ?? ''),
    record.jobAssociation?.jobId ?? null,
  ]);
}

const shanghaiDay = (at) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));

const bootstrapEligible = (record) => {
  const label = record.latestObservation?.timeLabel ?? record.timeLabel ?? '';
  return label === '昨天' || /^\d{1,2}:\d{2}$/.test(label);
};

export function observeHistoryList(state, records, at) {
  const current = normalizeHistoryState(state);
  if (!iso(at) || !Array.isArray(records)) throw new Error('RUNTIME_HISTORY_INVALID');
  const initializing = current.initializedDay === null;
  const byKey = new Map(current.conversations.map((item) => [item.key, item]));
  for (const record of records) {
    if (!KEY.test(record?.key ?? '')) throw new Error('RUNTIME_HISTORY_INVALID');
    const fingerprint = listFingerprint(record),
      prior = byKey.get(record.key);
    if (!prior) {
      byKey.set(record.key, {
        key: record.key,
        fingerprint,
        watermark: null,
        task:
          !initializing || bootstrapEligible(record)
            ? { fingerprint, enqueuedAt: at, page: 1, head: null }
            : null,
      });
    } else if (prior.fingerprint !== fingerprint) {
      byKey.set(record.key, {
        ...prior,
        fingerprint,
        task: { fingerprint, enqueuedAt: prior.task?.enqueuedAt ?? at, page: 1, head: null },
      });
    }
  }
  return normalizeHistoryState({
    initializedDay: current.initializedDay ?? shanghaiDay(at),
    legacyCheckpointDigest: current.legacyCheckpointDigest,
    conversations: [...byKey.values()],
  });
}

export function pendingHistory(state, at = new Date().toISOString()) {
  return normalizeHistoryState(state)
    .conversations.filter(
      (item) =>
        item.task &&
        !item.task.truncated &&
        !item.task.isolated &&
        (!item.task.nextRetryAt || Date.parse(item.task.nextRetryAt) <= Date.parse(at)),
    )
    .sort(
      (a, b) => a.task.enqueuedAt.localeCompare(b.task.enqueuedAt) || a.key.localeCompare(b.key),
    );
}

export function advanceHistoryTask(
  state,
  key,
  targetFingerprint,
  { nextPage = null, head = null, complete = false, truncated = false } = {},
) {
  const current = normalizeHistoryState(state);
  return normalizeHistoryState({
    ...current,
    conversations: current.conversations.map((item) => {
      if (item.key !== key || !item.task) return item;
      if (item.task.fingerprint !== targetFingerprint) return item;
      if (complete)
        return { ...item, watermark: head ?? item.task.head ?? item.watermark, task: null };
      return {
        ...item,
        task: {
          ...item.task,
          page: nextPage ?? item.task.page,
          head: head ?? item.task.head,
          truncated,
          attempts: 0,
          nextRetryAt: null,
          lastError: null,
          isolated: false,
        },
      };
    }),
  });
}

export function failHistoryTask(state, key, fingerprint, error, at) {
  if (!ERROR.test(error ?? '') || !iso(at)) throw new Error('RUNTIME_HISTORY_INVALID');
  const current = normalizeHistoryState(state);
  return normalizeHistoryState({
    ...current,
    conversations: current.conversations.map((item) => {
      if (item.key !== key || item.task?.fingerprint !== fingerprint) return item;
      const attempts = Math.min(4, (item.task.attempts ?? 0) + 1);
      const delays = [30 * 60_000, 2 * 60 * 60_000, 24 * 60 * 60_000];
      return {
        ...item,
        task: {
          ...item.task,
          attempts,
          lastError: error,
          nextRetryAt:
            attempts === 4 ? null : new Date(Date.parse(at) + delays[attempts - 1]).toISOString(),
          isolated: attempts === 4,
        },
      };
    }),
  });
}

export function recordHistoryWatermark(state, key, head) {
  const current = normalizeHistoryState(state);
  if (!MESSAGE.test(head ?? '')) return current;
  return normalizeHistoryState({
    ...current,
    conversations: current.conversations.map((item) =>
      item.key === key ? { ...item, watermark: head, task: null } : item,
    ),
  });
}

export function historySummary(state) {
  const current = normalizeHistoryState(state);
  const tasks = current.conversations.filter((item) => item.task);
  return {
    initializedDay: current.initializedDay,
    pending: tasks.length,
    paginating: tasks.filter((item) => item.task.page > 1).length,
    completed: current.conversations.filter((item) => item.watermark && !item.task).length,
    truncated: tasks.filter((item) => item.task.truncated).length,
    waitingRetry: tasks.filter((item) => item.task.nextRetryAt).length,
    failed: tasks.filter((item) => item.task.lastError).length,
    isolated: tasks.filter((item) => item.task.isolated).length,
  };
}
