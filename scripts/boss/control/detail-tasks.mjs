import { createHash } from 'node:crypto';
import { parseBossJobUrl, isCanonicalBossJobUrl } from '../../../dist/boss/contracts/job-url.js';
import {
  DETAIL_ACCOUNT,
  detailDecisionError,
} from '../../../dist/boss/contracts/detail-decision.js';
import {
  detailInputs,
  fairDetailInputs,
  currentDetailSummary,
} from '../../../collector/boss/details/detail-phase.mjs';
import { stoppedDetailJobIds } from './detail-decisions.mjs';

export function requireDetailAccount(current, envelope, expected) {
  const accountNamespace = envelope?.accountNamespace;
  const bindings =
    current.workspace?.data?.sourceBindings?.filter(
      (row) =>
        row.kind === 'account' && row.accountNamespace === accountNamespace && !row.deletedAt,
    ) ?? [];
  if (
    !DETAIL_ACCOUNT.test(accountNamespace ?? '') ||
    (expected && expected !== accountNamespace) ||
    bindings.length !== 1 ||
    bindings[0].workspaceSourceId !== current.workspaceId
  )
    throw detailDecisionError('DETAIL_ACCOUNT_CHANGED');
  return accountNamespace;
}

function matchingOpportunity(current, accountNamespace, jobId, canonicalUrl) {
  const data = current.workspace.data;
  const matches = data.opportunities.filter(
    (row) => row.externalId === jobId || parseBossJobUrl(row.url)?.jobId === jobId,
  );
  const blocked = (completionBlockedReason, matchingOpportunityId = '') => ({
    matchingOpportunityId,
    canCompleteWithDetails: false,
    canCreateOpportunity: false,
    completionBlockedReason,
  });
  if (!matches.length)
    return {
      ...blocked('本机尚无对应岗位，请先补齐资料。'),
      canCreateOpportunity: Boolean(canonicalUrl),
    };
  if (matches.some((row) => row.deletedAt)) return blocked('存在已删除的对应岗位，需要先核对。');
  if (matches.length !== 1) return blocked('存在多个对应岗位，需要先核对重复记录。');
  const target = matches[0];
  if (
    (target.externalId && target.externalId !== jobId) ||
    parseBossJobUrl(target.url)?.canonicalUrl !== canonicalUrl ||
    !/^boss(?:直聘)?$/i.test((target.platform || '').replace(/\s/g, ''))
  )
    return blocked('岗位的平台、编号或链接不一致，需要先核对。');
  const bindings = data.sourceBindings.filter(
    (row) => row.kind === 'opportunity' && !row.deletedAt,
  );
  if (
    bindings.some(
      (row) =>
        (row.opportunityId === target.id &&
          (row.accountNamespace !== accountNamespace ||
            row.externalJobId !== jobId ||
            row.canonicalUrl !== canonicalUrl)) ||
        (row.accountNamespace === accountNamespace &&
          row.externalJobId === jobId &&
          (row.opportunityId !== target.id || row.canonicalUrl !== canonicalUrl)),
    )
  )
    return blocked('岗位来源绑定存在账号或身份矛盾，需要先核对。');
  if (current.workspace.pending) return blocked('请先处理同步冲突，再确认资料已补齐。', target.id);
  if (!target.company?.trim() || !target.role?.trim())
    return blocked('岗位公司或名称尚未补齐。', target.id);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(target.id))
    return blocked('岗位标识需要核对。', target.id);
  return {
    matchingOpportunityId: target.id,
    canCompleteWithDetails: true,
    canCreateOpportunity: false,
    completionBlockedReason: '',
  };
}

export function detailTasksView({ current, envelope, collectorRuntime, decisions, tracking, now }) {
  const accountNamespace = requireDetailAccount(current, envelope);
  const excludedJobIds = stoppedDetailJobIds(decisions, accountNamespace);
  const input = fairDetailInputs(envelope, { runtime: collectorRuntime, now, limit: 1 });
  const candidates = detailInputs(envelope).candidates;
  const records = decisions.records.filter((row) => row.accountNamespace === accountNamespace);
  const ids = [...new Set([...input.eligibleJobIds, ...records.map((row) => row.jobId)])].sort();
  const items = ids.map((jobId) => {
    const eligible = input.eligibleJobIds.includes(jobId);
    const observed = candidates.filter((row) => row.jobId === jobId);
    const urls = [
      ...new Set(
        observed.map((row) => row.detailUrl).filter((url) => isCanonicalBossJobUrl(url, jobId)),
      ),
    ];
    const canonicalUrl = urls.length === 1 ? urls[0] : '';
    const task = collectorRuntime.detail.tasks.find((row) => row.jobId === jobId) ?? null;
    const resolution = records.find((row) => row.jobId === jobId) ?? null;
    const stopped = resolution?.status === 'stopped';
    const status = stopped
      ? 'manually_stopped'
      : !eligible
        ? 'inactive'
        : (task?.status ?? 'available');
    const row = observed[0];
    const listRow = envelope.snapshot.records.find((record) => record.key === row?.conversationKey);
    const taskVersion = createHash('sha256')
      .update(JSON.stringify({ accountNamespace, jobId, eligible, urls, task, resolution }))
      .digest('hex');
    return {
      jobId,
      canonicalUrl,
      company: row?.company ?? '',
      jobName: row?.jobName ?? '',
      contact: listRow?.contact ?? '',
      error: task?.lastError ?? '',
      attempts: task?.attempts ?? 0,
      lastAttemptAt: task?.lastAttemptAt ?? '',
      status,
      resolution: resolution
        ? Object.fromEntries(
            ['status', 'reason', 'at', 'opportunityId', 'workspaceRevision'].map((key) => [
              key,
              resolution[key],
            ]),
          )
        : null,
      taskVersion,
      ...matchingOpportunity(current, accountNamespace, jobId, canonicalUrl),
      workspaceRevision: current.revision,
      canRetry:
        eligible &&
        !stopped &&
        !collectorRuntime.detail.blocked &&
        task?.status === 'isolated' &&
        tracking.lifecycle === 'stopped' &&
        !tracking.runningCycle,
    };
  });
  return {
    accountNamespace,
    revision: decisions.revision,
    lifecycle: tracking.lifecycle,
    cycleInProgress: tracking.runningCycle,
    blocked: collectorRuntime.detail.blocked,
    summary: currentDetailSummary(envelope, collectorRuntime, { excludedJobIds, now }),
    items,
  };
}

export function requireDetailTask(details, expected) {
  if (details.accountNamespace !== expected.accountNamespace)
    throw detailDecisionError('DETAIL_ACCOUNT_CHANGED');
  const item = details.items.find((row) => row.jobId === expected.jobId);
  if (!item || item.taskVersion !== expected.taskVersion)
    throw detailDecisionError('DETAIL_TASK_CHANGED');
  return item;
}
