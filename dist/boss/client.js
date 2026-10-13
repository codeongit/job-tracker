import {
  applyBossBatch,
  bindBossAccount,
  bossReceiptGap,
  verifyBossBatch,
} from './application/integration.js';
import { clone, equal, live } from '../model.js';
import { sourceReviewCounts, bossWaitingItems } from '../source-ledger.js';
import { bossAttributionSummary } from './rules/attribution.js';

const BATCH_ID = /^boss-batch-[a-f0-9]{64}$/;
const ACCOUNT_NAMESPACE = /^boss-geek:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SOURCE_ID_KEY = 'job-tracker-boss-source-v1';

function integrationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function getBossWorkspaceSourceId(
  storage = localStorage,
  makeId = () => crypto.randomUUID(),
) {
  const stored = storage.getItem(SOURCE_ID_KEY);
  if (stored && UUID.test(stored)) return stored.toLowerCase();
  const created = makeId();
  if (!UUID.test(created)) throw integrationError('无法创建浏览器来源标识。', 'SOURCE_INVALID');
  storage.setItem(SOURCE_ID_KEY, created.toLowerCase());
  return created.toLowerCase();
}

export async function discoverBossIntegration(fetcher = fetch, hostname = location.hostname) {
  if (!['127.0.0.1', 'localhost'].includes(hostname)) return null;
  try {
    const response = await fetcher('./__local/session', { cache: 'no-store' });
    if (!response.ok) return null;
    const info = await response.json();
    return info.bossIntegrationEnabled && info.session
      ? {
          session: info.session,
          enabled: true,
          serverManaged: !!(info.localWorkspaceEnabled || info.localWorkspace),
          workspaceId: info.workspaceId,
        }
      : null;
  } catch {
    return null;
  }
}

export function bossInboxClient(session, workspaceSourceId, fetcher = fetch) {
  if (!/^[a-f0-9]{64}$/.test(session) || !UUID.test(workspaceSourceId))
    throw integrationError('本机 BOSS 接入会话无效。', 'SESSION_INVALID');
  async function request(path, options = {}, timeoutMs = 15000) {
    const signal = options.signal || AbortSignal.timeout(timeoutMs);
    const connectionError = () =>
      signal.reason?.name === 'TimeoutError'
        ? integrationError(`本机 BOSS 接口请求超过 ${timeoutMs / 1000} 秒未返回。`, 'LOCAL_TIMEOUT')
        : integrationError('本机 BOSS 接入服务暂时无法连接。', 'LOCAL_UNAVAILABLE');
    let response;
    try {
      response = await fetcher(path, {
        ...options,
        cache: 'no-store',
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          'X-Job-Tracker-Session': session,
          'X-Job-Tracker-Protocol': '1',
          ...options.headers,
        },
        signal,
      });
    } catch (error) {
      if (error?.name === 'TimeoutError')
        throw integrationError(
          `本机 BOSS 接口请求超过 ${timeoutMs / 1000} 秒未返回。`,
          'LOCAL_TIMEOUT',
        );
      throw connectionError();
    }
    let result;
    try {
      result = await response.json();
    } catch {
      if (signal.aborted) throw connectionError();
      throw integrationError('本机 BOSS 接入服务返回无效内容。', 'LOCAL_INVALID');
    }
    if (!response.ok) {
      const error = integrationError(result.message || '本机 BOSS 接入失败。', result.code);
      error.status = response.status;
      throw error;
    }
    return result;
  }
  return {
    index: () =>
      request(
        `./__local/boss-inbox?workspaceSourceId=${encodeURIComponent(workspaceSourceId)}`,
        {},
        30000,
      ),
    read: (batchId) => {
      if (!BATCH_ID.test(batchId)) throw integrationError('BOSS 批次 ID 无效。', 'BATCH_INVALID');
      return request(`./__local/boss-inbox/${batchId}`);
    },
    acknowledge: (batchId, receipt) => {
      if (!BATCH_ID.test(batchId)) throw integrationError('BOSS 批次 ID 无效。', 'BATCH_INVALID');
      return request(`./__local/boss-inbox/${batchId}/receipt`, {
        method: 'PUT',
        body: JSON.stringify(receipt),
      });
    },
    replay: (batchId, expectedRevision) => {
      if (!BATCH_ID.test(batchId)) throw integrationError('BOSS 批次 ID 无效。', 'BATCH_INVALID');
      return request(`./__local/boss-inbox/${batchId}/replay`, {
        method: 'PUT',
        body: JSON.stringify({ expectedRevision }),
      });
    },
  };
}

function summarizeIndex(index, data, workspaceSourceId) {
  const batches = Array.isArray(index?.batches) ? index.batches : [],
    accountBindings = live(data.sourceBindings).filter(
      (binding) => binding.kind === 'account' && binding.platform === 'boss',
    ),
    deletedAccountBindings = data.sourceBindings.filter(
      (binding) => binding.kind === 'account' && binding.platform === 'boss' && binding.deletedAt,
    ),
    accounts = [...new Set(batches.map((batch) => batch.accountNamespace))]
      .filter((account) => ACCOUNT_NAMESPACE.test(account))
      .map((accountNamespace) => {
        const binding = accountBindings.find(
            (candidate) => candidate.accountNamespace === accountNamespace,
          ),
          deleted = deletedAccountBindings.find(
            (candidate) => candidate.accountNamespace === accountNamespace,
          );
        return {
          accountNamespace,
          label: `BOSS 账号 · ${accountNamespace.slice(-8)}`,
          pending: batches.filter(
            (batch) =>
              batch.accountNamespace === accountNamespace && batch.receipt?.status !== 'processed',
          ).length,
          bound: binding?.workspaceSourceId === workspaceSourceId,
          ownedElsewhere:
            (!!binding && binding.workspaceSourceId !== workspaceSourceId) ||
            (!!deleted && deleted.workspaceSourceId !== workspaceSourceId),
          restoreRequired: !binding && deleted?.workspaceSourceId === workspaceSourceId,
        };
      });
  return {
    available: true,
    sourceId: workspaceSourceId,
    accounts,
    pending: batches.filter((batch) => batch.receipt?.status !== 'processed').length,
    queued: batches.length,
    server: index?.status || {},
    tracking: index?.tracking || null,
  };
}

export function createBossQueueConsumer({
  fetcher = fetch,
  storage = localStorage,
  readWorkspace,
  editWorkspace,
  bindWorkspace,
  onCommitted = () => {},
  onStatus = () => {},
  lockManager = navigator.locks,
  now = () => new Date().toISOString(),
  hostname = location.hostname,
}) {
  let workspaceSourceId = getBossWorkspaceSourceId(storage);
  let client = null,
    serverManaged = false,
    running = null,
    status = { available: false, sourceId: workspaceSourceId, accounts: [], pending: 0 };

  const publish = (patch) => {
    const next = { ...status, ...patch };
    if (!equal(next, status)) {
      status = next;
      onStatus(clone(status));
    }
    return status;
  };

  async function connect() {
    if (client) return true;
    const discovered = await discoverBossIntegration(fetcher, hostname);
    if (!discovered) {
      publish({ available: false, connected: false });
      return false;
    }
    serverManaged = discovered.serverManaged;
    if (serverManaged) {
      if (!UUID.test(discovered.workspaceId || ''))
        throw integrationError('本机工作区身份无效。', 'LOCAL_WORKSPACE_INVALID');
      workspaceSourceId = discovered.workspaceId;
    }
    client = bossInboxClient(discovered.session, workspaceSourceId, fetcher);
    publish({ available: true, serverManaged });
    return true;
  }

  async function applyBatch(batch, { acknowledge = true, allowEventRestore = false } = {}) {
    let counts;
    const stamp = now();
    await editWorkspace(
      (data) => {
        const applied = applyBossBatch(data, batch, {
          workspaceSourceId,
          stamp,
          allowEventRestore,
        });
        counts = applied.counts;
        return applied.data;
      },
      { reason: '录入 BOSS 来源批次前' },
    );
    await Promise.resolve(onCommitted());
    if (acknowledge)
      await client.acknowledge(batch.batchId, {
        format: 'job-tracker-boss-receipt',
        version: 2,
        batchId: batch.batchId,
        workspaceSourceId,
        status: 'processed',
        processedAt: stamp,
        counts,
        errorCode: '',
      });
    return counts;
  }

  async function findReceiptGaps(index, data, boundAccounts) {
    const gaps = [];
    for (const summary of (index.batches || []).filter(
      (batch) => batch.receipt?.status === 'processed' && boundAccounts.has(batch.accountNamespace),
    )) {
      const batch = await verifyBossBatch(await client.read(summary.batchId)),
        missing = bossReceiptGap(data, batch);
      if (missing)
        gaps.push({
          batchId: batch.batchId,
          accountNamespace: batch.accountNamespace,
          missing,
          sourceSequence: batch.sourceSequence,
        });
    }
    return gaps;
  }

  async function consume() {
    if (!(await connect())) return status;
    const index = await client.index(),
      initialState = await readWorkspace();
    publish({
      ...summarizeIndex(index, initialState.data, workspaceSourceId),
      connected: true,
      error: '',
      connectionStale: false,
      refreshFailures: 0,
      refreshError: '',
      lastStatusAt: now(),
      applicationCounts: sourceReviewCounts(initialState.data),
      waitingItems: serverManaged
        ? index.recovery?.waitingItems || []
        : bossWaitingItems(initialState.data),
    });
    if (serverManaged) {
      // The local service owns ingestion, including when this page is closed.
      // A browser is an observer/editor and must never replay applications.
      publish({
        serverManaged: true,
        attribution:
          index.tracking?.attribution ??
          index.recovery?.attribution ??
          bossAttributionSummary(initialState.data),
        blocked: index.recovery?.restoreReview?.length
          ? '当前正式工作区缺少已回执的来源证据，请核对后明确重放。'
          : '',
        restoreReview: index.recovery?.restoreReview || [],
        revision: index.recovery?.revision,
        accounts: status.accounts.map((account) => ({
          ...account,
          restoreRequired: account.restoreRequired || account.ownedElsewhere,
        })),
      });
      return status;
    }
    const boundAccounts = new Set(
        status.accounts
          .filter((account) => account.bound)
          .map((account) => account.accountNamespace),
      ),
      restoreReview = await findReceiptGaps(index, initialState.data, boundAccounts);
    publish({ restoreReview });
    if (initialState.pending) {
      publish({ blocked: '请先处理同步冲突，BOSS 待录入批次仍保留。' });
      return status;
    }
    if (restoreReview.length) {
      publish({ blocked: '当前工作区缺少已回执的来源证据，请先核对恢复批次。' });
      return status;
    }
    if ((index.batches || []).some((batch) => batch.receipt?.status === 'blocked')) {
      publish({ blocked: '本机存在被阻止的 BOSS 批次，请先查看故障材料并人工处理。' });
      return status;
    }
    const batches = (index.batches || [])
      .filter((batch) => !batch.receipt && boundAccounts.has(batch.accountNamespace))
      .sort(
        (a, b) =>
          Number(a.sourceSequence) - Number(b.sourceSequence) ||
          String(a.batchId).localeCompare(String(b.batchId)),
      );
    let processed = 0;
    for (const summary of batches) {
      const batch = await verifyBossBatch(await client.read(summary.batchId));
      await applyBatch(batch);
      processed++;
    }
    const refreshed = await client.index(),
      finalState = await readWorkspace();
    publish({
      ...summarizeIndex(refreshed, finalState.data, workspaceSourceId),
      connected: true,
      blocked: '',
      error: '',
      processed,
      lastProcessedAt: processed ? now() : status.lastProcessedAt || '',
      restoreReview: await findReceiptGaps(refreshed, finalState.data, boundAccounts),
    });
    return status;
  }

  async function consumeWithSessionRefresh() {
    try {
      return await consume();
    } catch (error) {
      if (error?.status !== 403) throw error;
      client = null;
      return consume();
    }
  }

  async function run() {
    if (running) return running;
    const execute = async () => {
      publish({ running: true });
      try {
        const task = () => consumeWithSessionRefresh();
        if (!lockManager?.request)
          throw integrationError(
            '当前浏览器无法协调多标签处理，BOSS 队列已暂停。',
            'LOCK_UNAVAILABLE',
          );
        return await lockManager.request(
          `job-tracker-boss-inbox:${workspaceSourceId}`,
          { ifAvailable: true },
          (lock) => (lock ? task() : status),
        );
      } catch (error) {
        if (
          serverManaged &&
          status.lastStatusAt &&
          ['LOCAL_UNAVAILABLE', 'LOCAL_TIMEOUT'].includes(error.code)
        ) {
          const refreshFailures = (status.refreshFailures || 0) + 1;
          publish({
            connectionStale: true,
            refreshFailures,
            refreshError: `${error.code}：${error.message}`,
            error: refreshFailures > 1 ? `${error.code}：${error.message}` : '',
          });
        } else
          publish({
            error: `${error.code || 'BOSS_INTEGRATION_FAILED'}：${error.message}`,
            blocked: '',
          });
        return status;
      } finally {
        publish({ running: false });
      }
    };
    running = execute().finally(() => {
      running = null;
    });
    return running;
  }

  async function bind(accountNamespace, { restore = false } = {}) {
    if (serverManaged && status.connectionStale)
      throw integrationError('状态尚未更新，请等待刷新成功后再处理绑定。', 'LOCAL_STATUS_STALE');
    if (!status.accounts.some((account) => account.accountNamespace === accountNamespace))
      throw integrationError('队列中没有这个 BOSS 来源账号。', 'SOURCE_INVALID');
    const stamp = now();
    if (serverManaged) {
      if (typeof bindWorkspace !== 'function')
        throw integrationError('本机服务不支持固定来源绑定命令。', 'LOCAL_WORKSPACE_INVALID');
      await bindWorkspace(accountNamespace, { restore });
    } else
      await editWorkspace(
        (data) =>
          bindBossAccount(data, accountNamespace, workspaceSourceId, stamp, {
            allowRestore: restore,
            allowRebind: false,
          }),
        { reason: '绑定 BOSS 采集来源前' },
      );
    await Promise.resolve(onCommitted());
    return run();
  }

  async function replay(batchId) {
    if (serverManaged && status.connectionStale)
      throw integrationError('状态尚未更新，请等待刷新成功后再核对重放。', 'LOCAL_STATUS_STALE');
    if (!status.restoreReview?.some((gap) => gap.batchId === batchId))
      throw integrationError('这个批次当前不需要恢复核对。', 'REPLAY_NOT_REQUIRED');
    if (!(await connect())) throw integrationError('本机 BOSS 接入未启用。', 'LOCAL_UNAVAILABLE');
    if (serverManaged) {
      await client.replay(batchId, status.revision);
      await Promise.resolve(onCommitted());
      return consumeWithSessionRefresh();
    }
    const task = async () => {
      const current = await readWorkspace();
      if (current.pending) throw integrationError('请先处理同步冲突。', 'SYNC_CONFLICT');
      const batch = await verifyBossBatch(await client.read(batchId));
      await applyBatch(batch, { acknowledge: false, allowEventRestore: true });
      return consume();
    };
    if (!lockManager?.request)
      throw integrationError('当前浏览器无法协调多标签处理，BOSS 队列已暂停。', 'LOCK_UNAVAILABLE');
    return lockManager.request(
      `job-tracker-boss-inbox:${workspaceSourceId}`,
      { ifAvailable: true },
      (lock) => {
        if (!lock) throw integrationError('另一个工作台页面正在处理 BOSS 队列。', 'LOCKED');
        return task();
      },
    );
  }

  return {
    run,
    bind,
    replay,
    getStatus: () => clone(status),
    workspaceSourceId,
  };
}
