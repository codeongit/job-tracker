import { bossObservationGroups } from '../dist/boss-observations.js';
import { parseBossJobUrl } from '../dist/boss-job-url.js';
import { bossAttributionSummary, buildBossAttributionContext } from '../dist/boss-attribution.js';
import { recordAttributionDiagnostic } from './boss-attribution-diagnostics.mjs';
import { readdir } from 'node:fs/promises';
import { applyBossBatch, bossReceiptGap } from '../dist/boss-integration.js';
import { validateData, mergeData, equal } from '../dist/model.js';
import { bossApplicationId, bossFactId, hasBossFactIdentity } from '../dist/source-identity.js';
import { bossWaitingItems } from '../dist/source-ledger.js';
import { WorkspaceStoreError } from './workspace-store.mjs';

const applicationIdFor = (batch, event) => {
  const identity = { ...event, platform: 'boss', accountNamespace: batch.accountNamespace };
  return hasBossFactIdentity(identity) ? bossApplicationId(bossFactId(identity)) : '';
};

export function workspaceConflictScope(workspace) {
  const opportunityIds = new Set(),
    accountNamespaces = new Set(),
    dataSets = [workspace.data, workspace.pending?.data, workspace.pending?.remote].filter(Boolean),
    rowsForFact = (factId) =>
      dataSets.flatMap((data) => [
        ...(data.sourceEvents || []).filter((row) => row.factId === factId),
        ...(data.sourceApplications || []).filter((row) => row.factId === factId),
      ]);
  let unscoped = false;
  for (const conflict of workspace.pending?.conflicts || []) {
    let scoped = false;
    if (conflict.group === 'opportunities') {
      opportunityIds.add(conflict.id);
      scoped = true;
    }
    for (const row of [conflict.base, conflict.local, conflict.remote].filter(Boolean)) {
      if (row.opportunityId) {
        opportunityIds.add(row.opportunityId);
        scoped = true;
      }
      if (conflict.group === 'sourceBindings' && row.kind === 'account') {
        accountNamespaces.add(row.accountNamespace);
        scoped = true;
      }
      if (row.externalJobId)
        for (const data of dataSets)
          for (const binding of data.sourceBindings || []) {
            if (
              binding.kind === 'opportunity' &&
              binding.externalJobId === row.externalJobId &&
              (!row.accountNamespace || row.accountNamespace === binding.accountNamespace)
            ) {
              opportunityIds.add(binding.opportunityId);
              scoped = true;
            }
          }
      if (row.factId)
        for (const linked of rowsForFact(row.factId))
          if (linked.opportunityId) {
            opportunityIds.add(linked.opportunityId);
            scoped = true;
          }
    }
    if (conflict.group === 'sourceFacts')
      for (const linked of rowsForFact(conflict.id))
        if (linked.opportunityId) {
          opportunityIds.add(linked.opportunityId);
          scoped = true;
        }
    if (!scoped) unscoped = true;
  }
  return { opportunityIds: [...opportunityIds], accountNamespaces, unscoped };
}

function preserveUnchangedDecisionTimes(before, after) {
  for (const application of after.sourceApplications || []) {
    const previous = before.sourceApplications.find((row) => row.id === application.id);
    if (previous && equal({ ...previous, updatedAt: '' }, { ...application, updatedAt: '' }))
      application.updatedAt = previous.updatedAt;
  }
}

const batchObservations = (batch) =>
  batch.events.map((event) => ({
    ...event,
    platform: 'boss',
    accountNamespace: batch.accountNamespace,
  }));

function opportunityBlocked(data, event, scope) {
  return (
    data.sourceBindings.some(
      (binding) =>
        !binding.deletedAt &&
        binding.kind === 'opportunity' &&
        binding.accountNamespace === event.accountNamespace &&
        binding.externalJobId === event.externalJobId &&
        scope.opportunityIds.includes(binding.opportunityId),
    ) ||
    data.opportunities.some(
      (opportunity) =>
        scope.opportunityIds.includes(opportunity.id) &&
        (opportunity.externalId === event.externalJobId ||
          parseBossJobUrl(opportunity.url)?.jobId === event.externalJobId),
    )
  );
}

function observationDeletedOrMissing(data, batch, event) {
  const stored = data.sourceEvents.find((row) => row.id === event.eventId);
  const identity = { ...event, platform: 'boss', accountNamespace: batch.accountNamespace };
  const factId = hasBossFactIdentity(identity) ? bossFactId(identity) : '';
  return Boolean(
    (stored && (stored.deletedAt || bossReceiptGap(data, { ...batch, events: [event] }))) ||
    (factId &&
      (data.sourceFacts.some((row) => row.id === factId && row.deletedAt) ||
        data.sourceApplications.some(
          (row) => row.id === bossApplicationId(factId) && row.deletedAt,
        ))),
  );
}

// Draining the private inbox is a local operation and never connects to the recruitment site.
export function createWorkspaceInboxConsumer({
  workspaceStore,
  inbox,
  now = () => new Date().toISOString(),
  onError = () => {},
}) {
  let running = null;
  let tail = Promise.resolve();
  const serial = (operation) => {
    const job = tail.then(operation);
    tail = job.catch(() => {});
    return job;
  };
  const accountBound = (current, batch) =>
    current.workspace.data.sourceBindings.some(
      (binding) =>
        binding.kind === 'account' &&
        !binding.deletedAt &&
        binding.accountNamespace === batch.accountNamespace &&
        binding.workspaceSourceId === current.workspaceId,
    );
  const gapSummary = (batch, missing) => ({
    batchId: batch.batchId,
    accountNamespace: batch.accountNamespace,
    missing,
    sourceSequence: batch.sourceSequence,
  });
  let last = { processed: 0, waiting: 0, isolated: [], restoreReview: [], lastRunAt: '' };
  async function readBatches(summary) {
    await inbox.initialize();
    const batches = [];
    for (const filename of (await readdir(inbox.inbox)).sort()) {
      if (!/^boss-batch-[a-f0-9]{64}\.json$/.test(filename)) continue;
      const batchId = filename.slice(0, -5);
      try {
        batches.push(await inbox.read(batchId));
      } catch (error) {
        summary.isolated.push({ batchId, code: error.code || 'BATCH_INVALID' });
      }
    }
    batches.sort(
      (a, b) =>
        a.accountNamespace.localeCompare(b.accountNamespace) ||
        a.sourceSequence - b.sourceSequence ||
        a.batchId.localeCompare(b.batchId),
    );
    return batches;
  }

  function freshAttributionPool(current, batch, pool, { allowEventRestore = false } = {}) {
    const scope = workspaceConflictScope(current.workspace);
    const blockedAccounts = new Set();
    const eligible = [];
    for (const candidate of pool.candidateBatches) {
      const restoring = allowEventRestore && candidate.batchId === batch.batchId;
      if (
        !accountBound(current, candidate) ||
        (blockedAccounts.has(candidate.accountNamespace) && !restoring)
      )
        continue;
      if (
        scope.unscoped ||
        scope.accountNamespaces.has(candidate.accountNamespace) ||
        (!restoring &&
          ((pool.processedBatchIds.has(candidate.batchId) &&
            bossReceiptGap(current.workspace.data, candidate)) ||
            candidate.events.some((event) =>
              observationDeletedOrMissing(current.workspace.data, candidate, event),
            )))
      ) {
        blockedAccounts.add(candidate.accountNamespace);
        continue;
      }
      eligible.push(candidate);
      if (
        restoring &&
        pool.processedBatchIds.has(candidate.batchId) &&
        bossReceiptGap(current.workspace.data, candidate)
      )
        blockedAccounts.add(candidate.accountNamespace);
    }
    const restoringEventIds = new Set(
      allowEventRestore ? batch.events.map((event) => event.eventId) : [],
    );
    const contextEvents = eligible.flatMap(batchObservations).filter((event) => {
      if (restoringEventIds.has(event.eventId)) return true;
      const application = hasBossFactIdentity(event)
        ? current.workspace.data.sourceApplications.find(
            (row) => row.id === bossApplicationId(bossFactId(event)),
          )
        : null;
      return (
        !application ||
        (!application.deletedAt && ['waiting', 'review'].includes(application.status))
      );
    });
    return { contextEvents, observations: contextEvents };
  }

  async function saveDiagnostics(current, batch, pool, blockedOpportunityIds, options = {}) {
    const fresh = freshAttributionPool(current, batch, pool, options);
    const observations = fresh.observations.filter(
      (event) =>
        !opportunityBlocked(current.workspace.data, event, {
          opportunityIds: blockedOpportunityIds,
        }),
    );
    const context = buildBossAttributionContext(
      [...current.workspace.data.sourceEvents, ...fresh.contextEvents, ...batchObservations(batch)],
      { observations },
    );
    for (const event of batch.events)
      if (event.eventType === 'resume_observed')
        await recordAttributionDiagnostic(
          inbox.root,
          batch.accountNamespace,
          event,
          'consume',
          context,
        );
    return { observations, contextEvents: fresh.contextEvents };
  }

  // Both the in-memory eligibility pass and the real command prepare changes
  // through this one application/rebase path. No preview commits or receipts.
  async function prepareBatch(current, batch, pool, stamp, { allowEventRestore = false } = {}) {
    const scope = workspaceConflictScope(current.workspace);
    const apply = async (blockedOpportunityIds) => {
      const fresh = await saveDiagnostics(current, batch, pool, blockedOpportunityIds, {
        allowEventRestore,
      });
      const applied = applyBossBatch(current.workspace.data, batch, {
        workspaceSourceId: current.workspaceId,
        stamp,
        allowEventRestore,
        blockedOpportunityIds,
        attributionObservations: fresh.observations,
        attributionContextEvents: fresh.contextEvents,
      });
      preserveUnchangedDecisionTimes(current.workspace.data, applied.data);
      return applied;
    };
    let applied = await apply(scope.opportunityIds);
    const next = {
      ...current.workspace,
      data: validateData(applied.data),
      generation: current.workspace.generation + 1,
    };
    if (current.workspace.pending) {
      let merged = mergeData(current.workspace.data, next.data, current.workspace.pending.data);
      if (merged.conflicts.length) {
        const discovered = workspaceConflictScope({
          data: next.data,
          pending: { conflicts: merged.conflicts },
        });
        if (discovered.unscoped || discovered.accountNamespaces.has(batch.accountNamespace)) {
          const error = new Error('待处理同步内容与本批账号身份产生新冲突。');
          error.code = 'WORKSPACE_PENDING_REBASE_CONFLICT';
          throw error;
        }
        applied = await apply([
          ...new Set([...scope.opportunityIds, ...discovered.opportunityIds]),
        ]);
        next.data = validateData(applied.data);
        merged = mergeData(current.workspace.data, next.data, current.workspace.pending.data);
        if (merged.conflicts.length) {
          const error = new Error('待处理同步内容与本批导入产生无法隔离的新冲突。');
          error.code = 'WORKSPACE_PENDING_REBASE_CONFLICT';
          throw error;
        }
      }
      next.pending = {
        ...current.workspace.pending,
        data: merged.data,
        generation: next.generation,
      };
    }
    return { applied, next };
  }

  // Private material is eligible only within the same serial recovery boundary
  // as normal consumption. Receipts never stand in for the workspace's facts.
  async function attributionPool(current, batches, { restoringBatchId = '' } = {}) {
    const scope = workspaceConflictScope(current.workspace);
    const blockedAccounts = new Set();
    const failures = new Map();
    const processedBatchIds = new Set();
    let eligible = [];
    for (const batch of batches) {
      const restoring = batch.batchId === restoringBatchId;
      if (
        !accountBound(current, batch) ||
        (blockedAccounts.has(batch.accountNamespace) && !restoring)
      )
        continue;
      try {
        const receipt = await inbox.readReceipt(batch.batchId, current.workspaceId);
        if (receipt?.status === 'processed') processedBatchIds.add(batch.batchId);
        if (
          (!restoring &&
            receipt?.status === 'processed' &&
            bossReceiptGap(current.workspace.data, batch)) ||
          receipt?.status === 'blocked' ||
          scope.unscoped ||
          scope.accountNamespaces.has(batch.accountNamespace) ||
          (!restoring &&
            batch.events.some((event) =>
              observationDeletedOrMissing(current.workspace.data, batch, event),
            ))
        ) {
          blockedAccounts.add(batch.accountNamespace);
          continue;
        }
        // A completed receipt is only skippable after its facts were checked.
        // Completed/manual applications need no private evidence replay; their
        // shared source records remain in the cross-job context.
        if (
          receipt?.status === 'processed' &&
          !batch.events.some((event) =>
            current.workspace.data.sourceApplications.some(
              (application) =>
                application.id === applicationIdFor(batch, event) &&
                !application.deletedAt &&
                ['waiting', 'review'].includes(application.status),
            ),
          ) &&
          !restoring
        )
          continue;
        eligible.push(batch);
        if (
          restoring &&
          receipt?.status === 'processed' &&
          bossReceiptGap(current.workspace.data, batch)
        )
          blockedAccounts.add(batch.accountNamespace);
      } catch (error) {
        failures.set(batch.batchId, error);
        blockedAccounts.add(batch.accountNamespace);
      }
    }
    for (;;) {
      const pool = { candidateBatches: eligible, processedBatchIds };
      let preview = current;
      let failedIndex = -1;
      for (let index = 0; index < eligible.length; index++) {
        const batch = eligible[index];
        try {
          const { next } = await prepareBatch(preview, batch, pool, now(), {
            allowEventRestore: batch.batchId === restoringBatchId,
          });
          preview = { ...preview, workspace: next };
        } catch (error) {
          failures.set(batch.batchId, error);
          failedIndex = index;
          break;
        }
      }
      if (failedIndex < 0) return { ...pool, failures };
      const failedAccount = eligible[failedIndex].accountNamespace;
      // Remove the failed batch and later batches of that account, then save
      // diagnostics again using exactly the reduced material set to be applied.
      eligible = eligible.filter(
        (batch, index) => index < failedIndex || batch.accountNamespace !== failedAccount,
      );
    }
  }

  async function drain() {
    const initial = await workspaceStore.read();
    const summary = { processed: 0, waiting: 0, isolated: [], restoreReview: [], lastRunAt: now() };
    if (!initial.workspace || !inbox) return (last = summary);
    const batches = await readBatches(summary);
    const pool = await attributionPool(initial, batches);
    const blockedAccounts = new Set();
    // Unknown corrupt files cannot establish an account/dependency identity. Keep evidence
    // isolated, and do not interpret or repair their contents in the consumer.
    for (const batch of batches) {
      if (blockedAccounts.has(batch.accountNamespace)) {
        summary.waiting++;
        continue;
      }
      try {
        if (pool.failures.has(batch.batchId)) throw pool.failures.get(batch.batchId);
        const current = await workspaceStore.read();
        if (!accountBound(current, batch)) {
          summary.waiting++;
          continue;
        }
        const receipt = await inbox.readReceipt(batch.batchId, current.workspaceId);
        const missing =
          receipt?.status === 'processed' ? bossReceiptGap(current.workspace.data, batch) : 0;
        if (missing) {
          summary.waiting++;
          summary.restoreReview.push(gapSummary(batch, missing));
          blockedAccounts.add(batch.accountNamespace);
          continue;
        }
        const replayable = batch.events.some((event) =>
          current.workspace.data.sourceApplications.some(
            (application) =>
              application.id === applicationIdFor(batch, event) &&
              !application.deletedAt &&
              ['waiting', 'review'].includes(application.status),
          ),
        );
        if (receipt?.status === 'processed' && !replayable) continue;
        const scope = workspaceConflictScope(current.workspace);
        if (
          receipt?.status === 'blocked' ||
          scope.unscoped ||
          scope.accountNamespaces.has(batch.accountNamespace)
        ) {
          summary.waiting++;
          blockedAccounts.add(batch.accountNamespace);
          continue;
        }
        const replaying = receipt?.status === 'processed';
        const commandId = replaying
            ? `boss-replay:${batch.batchId}:${current.revision}`
            : `boss:${batch.batchId}`,
          saved = await workspaceStore.commandResult(commandId);
        let result = saved?.result;
        if (!saved) {
          const stamp = now();
          const { applied, next } = await prepareBatch(current, batch, pool, stamp);
          if (replaying && equal(applied.data, current.workspace.data)) {
            summary.waiting++;
            continue;
          }
          const applicationStates = {
            applied: 0,
            protected: 0,
            waiting: 0,
            review: 0,
            no_effect: 0,
          };
          for (const event of batch.events) {
            const applicationId = applicationIdFor(batch, event),
              application = applicationId
                ? next.data.sourceApplications.find((row) => row.id === applicationId)
                : null;
            if (application?.status in applicationStates) applicationStates[application.status]++;
            else if (!applicationId) applicationStates.waiting++;
          }
          result = { counts: applied.counts, applicationStates, processedAt: stamp };
          await workspaceStore.execute(
            {
              commandId,
              expectedRevision: current.revision,
              type: 'commit_workspace',
              payload: { workspace: next, reason: '录入 BOSS 来源批次前' },
            },
            { result },
          );
          pool.processedBatchIds.add(batch.batchId);
        }
        if (saved) await saveDiagnostics(current, batch, pool, scope.opportunityIds);
        if (!replaying)
          await inbox.acknowledge(batch.batchId, {
            format: 'job-tracker-boss-receipt',
            version: 2,
            batchId: batch.batchId,
            workspaceSourceId: current.workspaceId,
            status: 'processed',
            processedAt: result.processedAt,
            counts: result.counts,
            errorCode: '',
          });
        summary.processed++;
        if (result.applicationStates?.waiting || result.applicationStates?.review)
          summary.waiting++;
      } catch (error) {
        onError(error, { batchId: batch.batchId });
        summary.isolated.push({
          batchId: batch.batchId,
          accountNamespace: batch.accountNamespace,
          code: error.code || 'WORKSPACE_IMPORT_FAILED',
        });
        // Preserve ordering when a verified batch fails. Other accounts remain independent.
        blockedAccounts.add(batch.accountNamespace);
      }
    }
    await workspaceStore.recordImportDiagnostic(summary);
    return (last = summary);
  }
  async function inspect() {
    const current = await workspaceStore.read();
    const restoreReview = [];
    if (current.workspace && inbox) {
      await inbox.initialize();
      for (const row of await inbox.list({ workspaceSourceId: current.workspaceId })) {
        if (row.receipt?.status !== 'processed') continue;
        const batch = await inbox.read(row.batchId);
        if (!accountBound(current, batch)) continue;
        const missing = bossReceiptGap(current.workspace.data, batch);
        if (missing) restoreReview.push(gapSummary(batch, missing));
      }
    }
    return {
      workspaceId: current.workspaceId,
      revision: current.revision,
      restoreReview,
      attribution: bossAttributionSummary(current.workspace?.data),
      waitingItems: current.workspace ? bossWaitingItems(current.workspace.data) : [],
      observationMessageCounts: current.workspace
        ? {
            waiting: bossObservationGroups(current.workspace.data).filter(
              (group) => group.waitingApplicationIds.length,
            ).length,
            review: bossObservationGroups(current.workspace.data).filter(
              (group) => group.status === 'review',
            ).length,
          }
        : { waiting: 0, review: 0 },
    };
  }
  async function replay(batchId, expectedRevision) {
    if (
      !/^boss-batch-[a-f0-9]{64}$/.test(batchId) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1
    )
      throw new WorkspaceStoreError('RESTORE_REQUEST_INVALID', '恢复批次参数无效。', 400);
    const commandId = `boss-restore:${batchId}:${expectedRevision}`;
    const saved = await workspaceStore.commandResult(commandId);
    if (saved) return { ...saved.result, revision: saved.revision, replayed: true };
    const current = await workspaceStore.read();
    if (current.revision !== expectedRevision)
      throw new WorkspaceStoreError(
        'WORKSPACE_REVISION_CONFLICT',
        '正式记录已变化，请重新核对恢复批次。',
      );
    if (!current.workspace || current.workspace.pending)
      throw new WorkspaceStoreError('RESTORE_REVIEW_REQUIRED', '请先迁移工作区并处理同步冲突。');
    const batch = await inbox.read(batchId);
    if (!accountBound(current, batch))
      throw new WorkspaceStoreError('SOURCE_NOT_BOUND', '请先明确确认此账号的本机工作区归属。');
    const receipt = await inbox.readReceipt(batchId, current.workspaceId);
    if (receipt?.status !== 'processed' || !bossReceiptGap(current.workspace.data, batch))
      throw new WorkspaceStoreError('REPLAY_NOT_REQUIRED', '此批次没有待确认的恢复缺口。');
    const batches = await readBatches({ isolated: [] });
    const pool = await attributionPool(current, batches, { restoringBatchId: batchId });
    if (pool.failures.has(batchId)) throw pool.failures.get(batchId);
    const stamp = now();
    const { applied, next: workspace } = await prepareBatch(current, batch, pool, stamp, {
      allowEventRestore: true,
    });
    const result = { batchId, counts: applied.counts, processedAt: stamp };
    const committed = await workspaceStore.execute(
      {
        commandId,
        expectedRevision,
        type: 'commit_workspace',
        payload: { workspace, reason: '明确核对 BOSS 恢复批次前' },
      },
      { result },
    );
    return { ...result, revision: committed.revision, replayed: false };
  }
  return {
    run() {
      return (running ??= serial(drain).finally(() => {
        running = null;
      }));
    },
    inspect: () => serial(inspect),
    replay: (batchId, expectedRevision) => serial(() => replay(batchId, expectedRevision)),
    status: () => structuredClone(last),
  };
}
