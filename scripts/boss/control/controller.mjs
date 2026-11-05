import {
  projectRoot,
  integrationScript,
  defaultTrackerRoot,
  defaultTrackerDataRoot,
} from '../shared/paths.mjs';
import { bossAttributionSummary } from '../../../dist/boss/rules/attribution.js';
import {
  DETAIL_RETRY_NOT_STARTED_CODES,
  normalizeDetailRetryJobIds,
} from '../../../dist/boss/contracts/detail-retry.js';
import { latest as latestCollectorSnapshot } from '../../../collector/boss/persistence/storage.mjs';
import { execFile as execFileCallback } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { BossRuntime, BossRuntimeError } from './runtime.mjs';
import { loadRuntimeState } from '../../../collector/boss/persistence/runtime-state.mjs';
import {
  normalizeDetailDecisionCommand,
  normalizeExpectedDetailTask,
} from '../../../dist/boss/contracts/detail-decision.js';
import { normalizeDetailPolicy } from '../../../dist/boss/contracts/detail-policy.js';
import { stoppedDetailJobIds } from './detail-decisions.mjs';
import { detailTasksView, requireDetailAccount, requireDetailTask } from './detail-tasks.mjs';
import { BossInbox } from '../delivery/inbox.mjs';
import {
  issueBossInternalAuthorization,
  revokeBossInternalAuthorization,
} from './internal-auth.mjs';

const execFile = promisify(execFileCallback);
const MAX_OUTPUT_BYTES = 1_000_000;

function safeCode(value, fallback = 'BOSS_CONTROLLER_FAILED') {
  const code = String(value || fallback);
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(code) ? code : fallback;
}

async function regularFile(path) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new BossRuntimeError('BOSS_CONTROLLER_PATH_INVALID');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 5_000_000)
    throw new BossRuntimeError('BOSS_CONTROLLER_PATH_INVALID');
}

function parseOutput(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES)
    throw new BossRuntimeError('BOSS_CONTROLLER_OUTPUT_INVALID');
  try {
    const value = JSON.parse(stdout);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.ok !== 'boolean'
    )
      throw new Error();
    return value;
  } catch {
    throw new BossRuntimeError('BOSS_CONTROLLER_OUTPUT_INVALID');
  }
}

async function executeJson(file, args, runner = execFile, environment = {}) {
  await regularFile(file);
  try {
    const result = await runner(process.execPath, [file, ...args], {
      cwd: dirname(file),
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 24 * 60 * 1_000,
      env: { ...process.env, ...environment },
    });
    const output = parseOutput(result.stdout);
    if (!output.ok) {
      const failure = new BossRuntimeError(safeCode(output.error));
      failure.usage = output.usage;
      throw failure;
    }
    return output;
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim()) {
      const output = parseOutput(error.stdout);
      const failure = new BossRuntimeError(safeCode(output.error));
      failure.usage = output.usage;
      throw failure;
    }
    if (error instanceof BossRuntimeError) throw error;
    throw Object.assign(new Error('BOSS_CONTROLLER_EXEC_FAILED'), {
      code: 'BOSS_CONTROLLER_EXEC_FAILED',
    });
  }
}

export function createBossController({
  config,
  trackerRoot = defaultTrackerRoot,
  trackerDataRoot = defaultTrackerDataRoot,
  inboxRoot,
  workspaceStore,
  inboxConsumer,
  runner = execFile,
  now = () => new Date(),
  setTimer,
  clearTimer,
  runtimeStoreOptions,
} = {}) {
  if (!config || typeof config.account !== 'string' || !inboxRoot || !workspaceStore)
    throw new BossRuntimeError('BOSS_CONTROLLER_CONFIG_INVALID');
  const tracker = join(trackerRoot, 'tracker.mjs');
  const producerInbox = new BossInbox(inboxRoot);

  async function requireWorkspace() {
    const current = await workspaceStore.read();
    if (!current.workspace) throw new BossRuntimeError('WORKSPACE_MIGRATION_REQUIRED');
    return current;
  }

  const trackerAction = async (action) => {
    await requireWorkspace();
    return executeJson(tracker, [action, '--account', config.account], runner, {
      JOB_TRACKER_BOSS_DATA_ROOT: trackerDataRoot,
    });
  };

  const runtime = new BossRuntime({
    statePath: join(inboxRoot, 'tracking.json'),
    storeOptions: runtimeStoreOptions,
    now,
    ...(setTimer ? { setTimer } : {}),
    ...(clearTimer ? { clearTimer } : {}),
    prepareStart: async () => {
      if ((await producerInbox.readControl())?.paused)
        throw new BossRuntimeError('BOSS_INTEGRATION_PAUSED');
      return trackerAction('start');
    },
    verifyResume: async () => {
      // The browser must be healthy before clearing the producer's durable pause.
      await trackerAction('resume');
      await executeJson(integrationScript, ['resume'], runner);
    },
    recoverPage: () => trackerAction('recover-page'),
    executeCycle: async ({ budget, historyMode = 'change', retryDetailJobIds }) => {
      try {
        await requireWorkspace();
      } catch (error) {
        error.usage = { historyRequests: 0, domSwitches: 0, detailNavigations: 0 };
        throw error;
      }
      let detailPolicy;
      if (runtime.detailDecisionState().records.some((row) => row.status === 'stopped')) {
        const snapshot = await latestCollectorSnapshot(join(trackerDataRoot, config.account));
        if (!snapshot?.envelope?.accountNamespace)
          throw new BossRuntimeError('DETAIL_ACCOUNT_CHANGED');
        const accountNamespace = snapshot.envelope.accountNamespace;
        const excludedJobIds = stoppedDetailJobIds(runtime.detailDecisionState(), accountNamespace);
        if (excludedJobIds.length)
          detailPolicy = normalizeDetailPolicy({ accountNamespace, excludedJobIds });
      }
      const request = {
          command: 'collect-cycle',
          historyRequests: budget.historyRequests,
          detailLimit: budget.detailActions,
          domLimit: budget.domActions,
          historyMode,
          ...(retryDetailJobIds ? { retryDetailJobIds } : {}),
          ...(detailPolicy ? { detailPolicy } : {}),
        },
        authorization = await issueBossInternalAuthorization(inboxRoot, request, { now }),
        args = [
          'collect-cycle',
          '--history-requests',
          String(budget.historyRequests),
          '--detail-limit',
          String(budget.detailActions),
          '--dom-limit',
          String(budget.domActions),
          '--history-mode',
          historyMode,
          ...(retryDetailJobIds ? ['--retry-job-ids', retryDetailJobIds.join(',')] : []),
          ...(detailPolicy ? ['--detail-policy', JSON.stringify(detailPolicy)] : []),
        ];
      let output;
      try {
        output = await executeJson(integrationScript, args, runner, {
          JOB_TRACKER_BOSS_INTERNAL_AUTHORIZATION: authorization.token,
        });
      } finally {
        await revokeBossInternalAuthorization(inboxRoot, authorization.token);
      }
      let localImport = 'completed';
      let importError = '';
      let importSummary = null;
      try {
        importSummary = await inboxConsumer?.run();
        if (!importSummary) {
          localImport = 'pending';
          importError = 'WORKSPACE_IMPORT_STATUS_UNAVAILABLE';
        } else if (importSummary.waiting || importSummary.isolated?.length) {
          localImport = importSummary.processed ? 'partial' : 'pending';
          importError = importSummary.isolated?.length
            ? 'WORKSPACE_IMPORT_ISOLATED'
            : 'WORKSPACE_IMPORT_WAITING';
        }
      } catch (error) {
        // The immutable batch is already durable. The service's queue drain
        // retries this local-only step; never revisit BOSS just because the
        // authoritative workspace commit is temporarily unavailable.
        localImport = 'pending';
        importError = safeCode(error?.code, 'WORKSPACE_IMPORT_FAILED');
      }
      return {
        ...output,
        localImport,
        importError,
        importSummary,
        // The runtime validates all three counters against the exact issued
        // budget. Never manufacture zero usage from absent or partial output,
        // because doing so would erase the conservative preflight reservation.
        usage: output.usage,
        budget,
      };
    },
  });

  async function detailContext(expectedAccount) {
    const current = await requireWorkspace();
    const directory = join(trackerDataRoot, config.account);
    const [snapshot, collectorRuntime] = await Promise.all([
      latestCollectorSnapshot(directory),
      loadRuntimeState(directory),
    ]);
    const envelope = snapshot?.envelope;
    requireDetailAccount(current, envelope, expectedAccount);
    return { current, envelope, collectorRuntime };
  }
  function projectDetails(context, decisions = runtime.detailDecisionState()) {
    return detailTasksView({
      ...context,
      decisions,
      tracking: runtime.status(),
      now: now().toISOString(),
    });
  }

  return {
    async initialize() {
      await runtime.initialize();
      return this.status();
    },
    async inspectDetails() {
      return projectDetails(await detailContext());
    },
    async resolveDetail(input) {
      const command = normalizeDetailDecisionCommand(input);
      let context;
      const decision = await runtime.resolveDetail(command, {
        verifyAccount: async () => {
          context = await detailContext(command.accountNamespace);
        },
        verifyTask: async () => {
          const item = requireDetailTask(projectDetails(context), command);
          if (
            command.reason === 'reopen'
              ? item.resolution?.status !== 'stopped'
              : item.status === 'manually_stopped' || item.status === 'inactive'
          )
            throw new BossRuntimeError('DETAIL_TASK_CHANGED');
          if (
            command.reason === 'manual_details' &&
            (command.workspaceRevision !== context.current.revision ||
              !item.canCompleteWithDetails ||
              item.matchingOpportunityId !== command.opportunityId)
          )
            throw new BossRuntimeError('DETAIL_WORKSPACE_CHANGED');
        },
        summarize: (decisions) => projectDetails(context, decisions).summary,
      });
      return { details: projectDetails(context), decision };
    },
    async action(action, { jobIds, expectedTask } = {}) {
      if (action !== 'retry-details' && (jobIds !== undefined || expectedTask !== undefined))
        throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
      if (action === 'start') return runtime.start();
      if (action === 'retry-details') {
        let retryDetailJobIds;
        try {
          retryDetailJobIds = normalizeDetailRetryJobIds(jobIds);
          if (runtime.detailDecisionState().records.some((row) => row.status === 'stopped')) {
            const context = await detailContext();
            const stopped = stoppedDetailJobIds(
              runtime.detailDecisionState(),
              context.envelope.accountNamespace,
            );
            if (retryDetailJobIds.some((id) => stopped.includes(id)))
              throw new BossRuntimeError('DETAIL_TASK_MANUALLY_STOPPED');
          }
          if (expectedTask !== undefined) {
            const expected = normalizeExpectedDetailTask(expectedTask);
            if (retryDetailJobIds.length !== 1 || retryDetailJobIds[0] !== expected.jobId)
              throw new BossRuntimeError('DETAIL_RETRY_TARGETS_INVALID');
            const item = requireDetailTask(
              projectDetails(await detailContext(expected.accountNamespace)),
              expected,
            );
            if (!item.canRetry) throw new BossRuntimeError('DETAIL_RETRY_TARGETS_INVALID');
          }
        } catch (error) {
          if (DETAIL_RETRY_NOT_STARTED_CODES.includes(error?.code)) error.retryAttempted = false;
          throw error;
        }
        const result = await runtime.requestCycle({ retryDetailJobIds });
        return { ...runtime.status(), result };
      }
      if (action === 'run') {
        const result = await runtime.requestCycle({ scheduled: false });
        return { ...runtime.status(), result };
      }
      if (action === 'backfill') {
        if (runtime.cycle) throw new BossRuntimeError('BOSS_CYCLE_IN_PROGRESS');
        const result = await runtime.requestCycle({ scheduled: false, historyMode: 'backfill' });
        return { ...runtime.status(), result };
      }
      if (action === 'pause') return runtime.pause();
      if (action === 'resume') {
        // A producer pause can predate this service instance; explicit resume
        // must recover both layers even when runtime initialization is stopped.
        const producer = await producerInbox.readControl();
        if (producer?.paused && runtime.status().lifecycle !== 'paused')
          await runtime.pause('BOSS_INTEGRATION_PAUSED');
        return runtime.resume();
      }
      if (action === 'stop') return runtime.stop();
      if (action === 'recover-page') return runtime.recoverPage();
      if (action === 'resume-details')
        return runtime.runMaintenance(() => trackerAction('resume-details'));
      if (action === 'recover-saved') {
        // This is deliberately outside requestCycle: it waits for any active
        // cycle, holds the lifecycle queue, and neither reserves budget nor
        // touches CDP.
        await requireWorkspace();
        return runtime.runWhileStopped(async () => {
          const output = await executeJson(integrationScript, ['recover-saved'], runner);
          let localImport = 'completed';
          let importError = '';
          let importSummary = null;
          try {
            importSummary = await inboxConsumer?.run();
            if (!importSummary) {
              localImport = 'pending';
              importError = 'WORKSPACE_IMPORT_STATUS_UNAVAILABLE';
            } else if (importSummary.waiting || importSummary.isolated?.length) {
              localImport = importSummary.processed ? 'partial' : 'pending';
              importError = importSummary.isolated?.length
                ? 'WORKSPACE_IMPORT_ISOLATED'
                : 'WORKSPACE_IMPORT_WAITING';
            }
          } catch (error) {
            localImport = 'pending';
            importError = safeCode(error?.code, 'WORKSPACE_IMPORT_FAILED');
          }
          return { ...output, localImport, importError, importSummary };
        });
      }
      throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
    },
    async stop() {
      return runtime.stop();
    },
    async shutdown() {
      return runtime.shutdown();
    },
    async doctor() {
      const diagnostics = {
        workspace: { ok: false, revision: 0 },
        collector: { ok: false, error: '' },
        producer: { ok: false, paused: false, error: '' },
      };
      try {
        const current = await requireWorkspace();
        diagnostics.workspace = { ok: true, revision: current.revision };
      } catch (error) {
        diagnostics.workspace.error = safeCode(error?.code, 'WORKSPACE_MIGRATION_REQUIRED');
      }
      try {
        const report = await trackerAction('doctor');
        diagnostics.collector = { ok: true, report };
      } catch (error) {
        diagnostics.collector.error = safeCode(error?.code);
      }
      try {
        const control = await producerInbox.readControl();
        diagnostics.producer = {
          ok: true,
          paused: control?.paused ?? false,
          error: control?.pauseCode || '',
        };
      } catch (error) {
        diagnostics.producer.error = safeCode(error?.code, 'BOSS_CONTROL_INVALID');
      }
      return { status: this.status(), diagnostics };
    },
    async inspectStatus() {
      const current = await workspaceStore.read();
      const attribution = bossAttributionSummary(current.workspace?.data);
      const snapshot = await latestCollectorSnapshot(join(trackerDataRoot, config.account));
      const seen = new Set();
      for (const item of snapshot?.envelope?.resume?.lastUnresolved || []) {
        if (
          !['RESUME_STATUS_IDENTITY_INCOMPLETE', 'RESUME_MESSAGE_IDENTITY_INCOMPLETE'].includes(
            item.reason,
          )
        )
          continue;
        const id = `${item.conversationKey}:${item.reason}`;
        if (seen.has(id)) continue;
        seen.add(id);
        attribution.collection++;
        attribution.items.push({
          id,
          category: 'collection',
          reason: item.reason,
          label: '最近采集缺少稳定消息身份或时间',
          candidate: '',
          candidateCompany: '',
        });
      }
      let details = null;
      if (snapshot?.envelope) {
        const collectorRuntime = await loadRuntimeState(join(trackerDataRoot, config.account));
        try {
          details = projectDetails({ current, envelope: snapshot.envelope, collectorRuntime });
        } catch (error) {
          if (error.code !== 'DETAIL_ACCOUNT_CHANGED') throw error;
        }
      }
      return {
        ...this.status(),
        ...(details ? { detailEnrichment: details.summary } : {}),
        attribution,
      };
    },
    status() {
      return {
        ...runtime.status(),
        inbox: inboxConsumer?.status?.() || null,
      };
    },
  };
}
