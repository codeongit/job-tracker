import { execFile as execFileCallback } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BossRuntime, BossRuntimeError } from './boss-runtime.mjs';
import { BossInbox } from './boss-inbox.mjs';
import {
  issueBossInternalAuthorization,
  revokeBossInternalAuthorization,
} from './boss-internal-auth.mjs';

const execFile = promisify(execFileCallback);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const integrationScript = join(projectRoot, 'scripts', 'boss-integration.mjs');
const defaultTrackerRoot = join(projectRoot, 'collector', 'boss');
const defaultTrackerDataRoot = join(projectRoot, '.local', 'boss-collector');
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
    executeCycle: async ({ budget }) => {
      try {
        await requireWorkspace();
      } catch (error) {
        error.usage = { historyRequests: 0, domSwitches: 0, detailNavigations: 0 };
        throw error;
      }
      const request = {
          command: 'collect-cycle',
          historyRequests: budget.historyRequests,
          detailLimit: budget.detailActions,
          domLimit: budget.domActions,
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

  return {
    async initialize() {
      await runtime.initialize();
      return this.status();
    },
    async action(action) {
      if (action === 'start') return runtime.start();
      if (action === 'run') {
        const result = await runtime.requestCycle({ scheduled: false });
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
    status() {
      return {
        ...runtime.status(),
        inbox: inboxConsumer?.status?.() || null,
      };
    },
  };
}
