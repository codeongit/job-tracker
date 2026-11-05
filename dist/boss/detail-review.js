import { DETAIL_DECISION_NOT_COMMITTED_CODES } from './contracts/detail-decision.js';

const copy = (value) => structuredClone(value);

// Keeps review, transport uncertainty and the exact local command together.
// Platform retries are never repeated by this coordinator.
export function createBossDetailReview({
  client,
  makeId = () => crypto.randomUUID(),
  onChange = () => {},
}) {
  let state = {
    details: null,
    loading: false,
    busy: false,
    stale: false,
    error: '',
    feedback: '',
    pendingCommand: null,
    retryUnconfirmed: null,
  };
  const publish = (patch, detailsUpdated = false) => {
    state = { ...state, ...patch };
    onChange(copy(state), { detailsUpdated });
  };
  const accept = (details) => {
    if (!details || !Array.isArray(details.items) || !Number.isSafeInteger(details.revision))
      throw Object.assign(new Error('本机详情任务返回无效内容，请刷新核对。'), {
        code: 'LOCAL_INVALID',
      });
    publish({ details: copy(details), stale: false }, true);
    const pending = state.retryUnconfirmed;
    if (
      pending &&
      details.accountNamespace === pending.accountNamespace &&
      !details.cycleInProgress
    ) {
      const row = details.items.find((item) => item.jobId === pending.jobId);
      if (!row)
        publish({
          retryUnconfirmed: null,
          error: '',
          feedback:
            '当前已无该岗位的详情采集待办；这不代表已确认平台采集成功，请核对正式岗位资料。',
        });
      else if (row.lastAttemptAt && row.lastAttemptAt !== pending.lastAttemptAt)
        publish({
          retryUnconfirmed: null,
          error: '',
          feedback: '本次详情尝试已记录；该岗位仍需处理，请核对当前原因。',
        });
    }
    return details;
  };
  const read = async () => accept(await client.details());
  const currentItem = (details, jobId) => {
    const row = details.items.find((item) => item.jobId === jobId);
    if (!row) throw new Error('该岗位任务已变化，请重新核对。');
    if (details.lifecycle !== 'stopped' || details.cycleInProgress)
      throw new Error('请先停止跟踪并等待当前轮次结束，再处理详情任务。');
    return row;
  };
  const saved = (command, details) => {
    accept(details);
    publish({
      pendingCommand: null,
      error: '',
      feedback:
        command.reason === 'reopen'
          ? '已撤销人工处理；按当前材料重新显示任务，尚未发起重试。'
          : '已人工停止该岗位详情采集；原失败记录保留，岗位资料与消息仍分别处理。',
    });
  };
  async function submit(command) {
    publish({ pendingCommand: copy(command) });
    try {
      saved(command, await client.resolveDetail(copy(command)));
    } catch (error) {
      const rejected = DETAIL_DECISION_NOT_COMMITTED_CODES.includes(error.code);
      publish({
        stale: true,
        pendingCommand: rejected ? null : command,
        error: rejected
          ? `${error.message} 请刷新后重新核对。`
          : '人工处理结果尚未确认。请核对原请求，系统不会创建另一条处理命令。',
        feedback: '',
      });
    }
  }
  return {
    getState: () => copy(state),
    async refresh() {
      if (state.loading || state.busy) return state.details;
      publish({ loading: true, error: '' });
      try {
        return await read();
      } catch (error) {
        publish({ stale: true, error: error.message });
        return null;
      } finally {
        publish({ loading: false });
      }
    },
    async resolve(jobId, reason, confirm) {
      if (state.busy || state.pendingCommand) return;
      publish({ busy: true, error: '', feedback: '' });
      try {
        const details = await read(),
          row = currentItem(details, jobId);
        if (reason === 'manual_details' && !row.canCompleteWithDetails)
          throw new Error(
            row.completionBlockedReason || '岗位资料尚不能精确对应，请先核对并保存。',
          );
        if (!(await confirm(copy(row)))) return;
        await submit({
          version: 1,
          commandId: makeId(),
          expectedRevision: details.revision,
          accountNamespace: details.accountNamespace,
          jobId,
          taskVersion: row.taskVersion,
          reason,
          opportunityId: reason === 'manual_details' ? row.matchingOpportunityId : '',
          workspaceRevision: reason === 'manual_details' ? row.workspaceRevision : null,
        });
      } catch (error) {
        publish({ error: error.message, stale: true });
      } finally {
        publish({ busy: false });
      }
    },
    async reconcile() {
      if (state.busy || !state.pendingCommand) return;
      publish({ busy: true, error: '' });
      try {
        await submit(copy(state.pendingCommand));
      } finally {
        publish({ busy: false });
      }
    },
    async retry(jobId, confirm) {
      if (state.busy || state.pendingCommand || state.retryUnconfirmed) return;
      publish({ busy: true, error: '', feedback: '' });
      try {
        const details = await read(),
          row = currentItem(details, jobId);
        if (!row.canRetry)
          throw new Error('当前任务不符合单次重试条件，请核对隔离及人工处理状态。');
        if (!(await confirm(copy(row)))) return;
        const request = {
          accountNamespace: details.accountNamespace,
          jobId,
          taskVersion: row.taskVersion,
        };
        publish({ retryUnconfirmed: { ...request, lastAttemptAt: row.lastAttemptAt } });
        const reply = await client.retryDetail(request);
        if (typeof reply?.result?.retryAttempted !== 'boolean')
          throw new Error('补查响应尚不能确认执行结果。');
        publish({
          retryUnconfirmed: null,
          feedback: reply.result.retryAttempted
            ? '本次补查已结束；请按当前清单核对仍未完成的项目。'
            : '本轮没有实际补查详情，请核对返回状态后再决定下一步。',
        });
        try {
          await read();
        } catch {
          publish({ stale: true, error: '补查结果已返回，但任务列表刷新失败，请刷新本机状态。' });
        }
      } catch (error) {
        const denied =
          error.status === 409 &&
          [
            'DETAIL_RETRY_REQUIRES_STOPPED',
            'DETAIL_RETRY_BUDGET_UNAVAILABLE',
            'BOSS_CYCLE_IN_PROGRESS',
            'BOSS_INTEGRATION_PAUSED',
          ].includes(error.code);
        publish({
          stale: true,
          ...(denied ? { retryUnconfirmed: null } : {}),
          error:
            state.retryUnconfirmed && !denied
              ? '本次补查结果尚未确认，请刷新任务状态或查看运行记录；不会自动重试。'
              : error.message,
        });
      } finally {
        publish({ busy: false });
      }
    },
    async stop(confirm) {
      if (state.busy) return;
      if (!(await confirm())) return;
      publish({ busy: true, error: '', feedback: '' });
      try {
        await client.stopTracking();
        publish({ feedback: '跟踪已停止，当前轮次已收尾。' });
        await read();
      } catch (error) {
        publish({ stale: true, error: `停止结果尚未确认，请刷新状态。${error.message}` });
      } finally {
        publish({ busy: false });
      }
    },
  };
}
