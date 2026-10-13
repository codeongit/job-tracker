import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const BOSS_RUNTIME_FORMAT = 'job-tracker-boss-runtime';
export const BOSS_RUNTIME_VERSION = 1;
export const DEFAULT_RUNTIME_INTERVAL_MS = 2 * 60 * 1_000;
export const DEFAULT_MANUAL_DEBOUNCE_MS = 10 * 1_000;

const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_LIMITS = Object.freeze({
  historyRequestsPerRun: 20,
  historyRequestsPerHour: 60,
  domActionsPerRun: 1,
  detailActionsPerRun: 20,
  navigationActionsPerHour: 60,
  domMinIntervalMs: 30 * 1_000,
  detailMinIntervalMs: 10 * 1_000,
});
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,100}$/;
const FATAL =
  /(?:LOGIN|LOGGED|CAPTCHA|VERIFY|ACCOUNT|IDENTITY|TARGET|TASK_PAGE|BROWSER_INSTANCE|URL_DRIFT|BINDING|LOADED_LIST_NOT_READY|STRUCTURE|USAGE|SECURITY|SESSION|REQUEST_STILL_RUNNING)/;

export class BossRuntimeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = SAFE_CODE.test(code) ? code : 'BOSS_RUNTIME_FAILED';
  }
}

const iso = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const safeCode = (error) => {
  const code = String(error?.code || 'BOSS_RUNTIME_FAILED');
  return SAFE_CODE.test(code) ? code : 'BOSS_RUNTIME_FAILED';
};

const initialDetailEnrichment = () => ({
  status: 'active',
  pending: 0,
  deferred: 0,
  isolated: 0,
  nextRetryAt: null,
  lastError: null,
});
const initialHistory = () => ({
  mode: 'change',
  initializedDay: null,
  pending: 0,
  paginating: 0,
  completed: 0,
  truncated: 0,
  waitingRetry: 0,
  failed: 0,
  isolated: 0,
  backfillCursor: null,
});
function validateHistory(value) {
  if (
    !value ||
    !['change', 'backfill'].includes(value.mode) ||
    (value.backfillCursor !== undefined &&
      value.backfillCursor !== null &&
      !/^[A-Za-z0-9_-]{1,300}$/.test(value.backfillCursor)) ||
    (value.initializedDay !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value.initializedDay)) ||
    ![
      'pending',
      'paginating',
      'completed',
      'truncated',
      'waitingRetry',
      'failed',
      'isolated',
    ].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
  )
    throw new BossRuntimeError('BOSS_RUNTIME_STATE_INVALID');
  return {
    mode: value.mode,
    initializedDay: value.initializedDay,
    pending: value.pending,
    paginating: value.paginating,
    completed: value.completed,
    truncated: value.truncated,
    waitingRetry: value.waitingRetry,
    failed: value.failed,
    isolated: value.isolated,
    backfillCursor: value.backfillCursor ?? null,
  };
}

function validateDetailEnrichment(input) {
  const value = structuredClone(input);
  const keys = ['status', 'pending', 'deferred', 'isolated', 'nextRetryAt', 'lastError'];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort()) ||
    !['active', 'waiting_retry', 'blocked'].includes(value.status) ||
    !['pending', 'deferred', 'isolated'].every(
      (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
    ) ||
    (value.nextRetryAt !== null && !iso(value.nextRetryAt)) ||
    (value.lastError !== null && !SAFE_CODE.test(value.lastError))
  )
    throw new BossRuntimeError('BOSS_RUNTIME_STATE_INVALID');
  return value;
}

function initialState(now = new Date()) {
  return {
    format: BOSS_RUNTIME_FORMAT,
    version: BOSS_RUNTIME_VERSION,
    lifecycle: 'stopped',
    sessionId: '',
    startedAt: '',
    updatedAt: now.toISOString(),
    lastTickAt: '',
    nextTickAt: '',
    lastSuccessAt: '',
    pauseCode: '',
    consecutiveFailures: 0,
    detailEnrichment: initialDetailEnrichment(),
    history: initialHistory(),
    actions: [],
  };
}

export function validateBossRuntimeState(input) {
  const value = structuredClone(input);
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'detailEnrichment')
  )
    value.detailEnrichment = initialDetailEnrichment();
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'history')
  )
    value.history = initialHistory();
  const keys = [
    'format',
    'version',
    'lifecycle',
    'sessionId',
    'startedAt',
    'updatedAt',
    'lastTickAt',
    'nextTickAt',
    'lastSuccessAt',
    'pauseCode',
    'consecutiveFailures',
    'detailEnrichment',
    'history',
    'actions',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort()) ||
    value.format !== BOSS_RUNTIME_FORMAT ||
    value.version !== BOSS_RUNTIME_VERSION ||
    !['stopped', 'running', 'paused'].includes(value.lifecycle) ||
    ![
      'sessionId',
      'startedAt',
      'updatedAt',
      'lastTickAt',
      'nextTickAt',
      'lastSuccessAt',
      'pauseCode',
    ].every((key) => typeof value[key] === 'string') ||
    !iso(value.updatedAt) ||
    !['startedAt', 'lastTickAt', 'nextTickAt', 'lastSuccessAt'].every(
      (key) => !value[key] || iso(value[key]),
    ) ||
    (value.sessionId && !/^boss-session-[a-f0-9]{32}$/.test(value.sessionId)) ||
    (value.pauseCode && !SAFE_CODE.test(value.pauseCode)) ||
    !Number.isSafeInteger(value.consecutiveFailures) ||
    value.consecutiveFailures < 0 ||
    !value.detailEnrichment ||
    !Array.isArray(value.actions) ||
    value.actions.length > 512
  )
    throw new BossRuntimeError('BOSS_RUNTIME_STATE_INVALID');
  value.detailEnrichment = validateDetailEnrichment(value.detailEnrichment);
  value.history = validateHistory(value.history);
  for (const action of value.actions) {
    if (
      !action ||
      JSON.stringify(Object.keys(action).sort()) !==
        JSON.stringify(['at', 'count', 'kind'].sort()) ||
      !iso(action.at) ||
      !['history', 'dom', 'detail'].includes(action.kind) ||
      !Number.isSafeInteger(action.count) ||
      action.count < 1 ||
      action.count > 1000
    )
      throw new BossRuntimeError('BOSS_RUNTIME_STATE_INVALID');
  }
  if (value.lifecycle === 'paused' ? !value.pauseCode : Boolean(value.pauseCode))
    throw new BossRuntimeError('BOSS_RUNTIME_STATE_INVALID');
  if (value.lifecycle === 'running' ? !value.sessionId : Boolean(value.sessionId))
    throw new BossRuntimeError('BOSS_RUNTIME_STATE_INVALID');
  return value;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new BossRuntimeError('BOSS_RUNTIME_PATH_INVALID');
  await chmod(path, 0o700);
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class BossRuntimeStateStore {
  constructor(path) {
    this.path = path;
  }

  async read(now = new Date()) {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128_000)
        throw new BossRuntimeError('BOSS_RUNTIME_PATH_INVALID');
      return validateBossRuntimeState(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return initialState(now);
      if (error instanceof BossRuntimeError) throw error;
      throw new BossRuntimeError('BOSS_RUNTIME_STATE_INVALID');
    }
  }

  async write(input) {
    const value = validateBossRuntimeState(input),
      directory = dirname(this.path),
      temporary = join(directory, `.runtime-${randomUUID()}`);
    await ensurePrivateDirectory(directory);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      await syncDirectory(directory);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
    return value;
  }
}

function currentActions(state, now) {
  const cutoff = now.getTime() - HOUR_MS;
  return state.actions.filter((action) => Date.parse(action.at) > cutoff);
}

function actionTotal(actions, kind) {
  return actions
    .filter(
      (action) => action.kind === kind || (kind === 'navigation' && action.kind !== 'history'),
    )
    .reduce((sum, action) => sum + action.count, 0);
}

function reportedUsage(result, budget) {
  const usage = result?.usage,
    fields = ['historyRequests', 'domSwitches', 'detailNavigations'],
    allowedKeys = [...fields, 'cdpReconnects'],
    keys =
      usage && typeof usage === 'object' && !Array.isArray(usage) ? Object.keys(usage).sort() : [];
  if (
    !usage ||
    typeof usage !== 'object' ||
    Array.isArray(usage) ||
    (JSON.stringify(keys) !== JSON.stringify([...fields].sort()) &&
      JSON.stringify(keys) !== JSON.stringify(allowedKeys.sort())) ||
    fields.some((field) => !Number.isSafeInteger(usage[field]) || usage[field] < 0) ||
    (Object.hasOwn(usage, 'cdpReconnects') &&
      (!Number.isSafeInteger(usage.cdpReconnects) || usage.cdpReconnects < 0)) ||
    usage.historyRequests > budget.historyRequests ||
    usage.domSwitches > budget.domActions ||
    usage.detailNavigations > budget.detailActions
  )
    return null;
  return {
    history: usage.historyRequests,
    dom: usage.domSwitches,
    detail: usage.detailNavigations,
  };
}

export class BossRuntime {
  constructor({
    statePath,
    executeCycle,
    prepareStart = async () => {},
    verifyResume = async () => {},
    recoverPage = async () => {},
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    intervalMs = DEFAULT_RUNTIME_INTERVAL_MS,
    manualDebounceMs = DEFAULT_MANUAL_DEBOUNCE_MS,
    limits = DEFAULT_LIMITS,
  }) {
    if (typeof executeCycle !== 'function')
      throw new BossRuntimeError('BOSS_RUNTIME_EXECUTOR_REQUIRED');
    this.store = new BossRuntimeStateStore(statePath);
    this.executeCycle = executeCycle;
    this.prepareStart = prepareStart;
    this.verifyResume = verifyResume;
    this.recoverPageAction = recoverPage;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.intervalMs = intervalMs;
    this.manualDebounceMs = manualDebounceMs;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.state = null;
    this.timer = null;
    this.cycle = null;
    this.stopRequested = false;
    // Lifecycle commands retain their call order, while durable state writes
    // use a separate queue. A cycle only holds the state queue while it
    // reserves/finalizes budget, so pause/stop can still take effect while the
    // platform request is in flight.
    this.lifecycleTail = Promise.resolve();
    this.stateTail = Promise.resolve();
    this.controlRevision = 0;
  }

  enqueueLifecycle(operation) {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.catch(() => undefined);
    return result;
  }

  enqueueState(operation) {
    const result = this.stateTail.then(operation);
    this.stateTail = result.catch(() => undefined);
    return result;
  }

  async initializeState() {
    if (this.state) return this.state;
    const now = this.now();
    this.state = await this.store.read(now);
    // A running authorization belongs to one service instance and never
    // survives a restart. Durable budgets/checkpoints remain intact.
    if (this.state.lifecycle === 'running') {
      this.state = await this.store.write({
        ...this.state,
        lifecycle: 'stopped',
        sessionId: '',
        startedAt: '',
        nextTickAt: '',
        pauseCode: '',
        updatedAt: now.toISOString(),
        actions: currentActions(this.state, now),
      });
      this.controlRevision++;
    }
    return this.state;
  }

  async initialize() {
    return this.enqueueLifecycle(async () => {
      await this.enqueueState(() => this.initializeState());
      return this.status();
    });
  }

  async persistState(patch, { controlMutation = false } = {}) {
    const now = this.now();
    const previousControl = this.state
      ? [this.state.lifecycle, this.state.sessionId, this.state.startedAt, this.state.pauseCode]
      : [];
    this.state = await this.store.write({
      ...this.state,
      ...patch,
      actions: currentActions(
        patch.actions ? { ...this.state, actions: patch.actions } : this.state,
        now,
      ),
      updatedAt: now.toISOString(),
    });
    const nextControl = [
      this.state.lifecycle,
      this.state.sessionId,
      this.state.startedAt,
      this.state.pauseCode,
    ];
    if (controlMutation || JSON.stringify(previousControl) !== JSON.stringify(nextControl))
      this.controlRevision++;
    return this.state;
  }

  async persist(patch) {
    return this.enqueueState(async () => {
      await this.initializeState();
      return this.persistState(patch);
    });
  }

  budget(now = this.now()) {
    const actions = currentActions(this.state, now),
      historyUsed = actionTotal(actions, 'history'),
      navigationUsed = actionTotal(actions, 'navigation'),
      navigationRemaining = Math.max(0, this.limits.navigationActionsPerHour - navigationUsed),
      latestAt = (kind) =>
        actions
          .filter((action) => action.kind === kind)
          .reduce((latest, action) => Math.max(latest, Date.parse(action.at)), 0),
      lastDetailAt = latestAt('detail'),
      lastDomAt = latestAt('dom'),
      detailReady =
        !lastDetailAt || now.getTime() - lastDetailAt >= this.limits.detailMinIntervalMs,
      domReady = !lastDomAt || now.getTime() - lastDomAt >= this.limits.domMinIntervalMs,
      detailActions = Math.max(
        0,
        detailReady ? Math.min(this.limits.detailActionsPerRun, navigationRemaining) : 0,
      ),
      domActions = Math.max(
        0,
        domReady ? Math.min(this.limits.domActionsPerRun, navigationRemaining - detailActions) : 0,
      ),
      nextRelease = (kind) => {
        const matching = actions
          .filter((action) =>
            kind === 'history' ? action.kind === 'history' : action.kind !== 'history',
          )
          .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
        return matching.length ? new Date(Date.parse(matching[0].at) + HOUR_MS).toISOString() : '';
      };
    return {
      historyRequests: Math.max(
        0,
        Math.min(
          this.limits.historyRequestsPerRun,
          this.limits.historyRequestsPerHour - historyUsed,
        ),
      ),
      domActions,
      detailActions,
      historyUsed,
      navigationUsed,
      nextHistoryAt:
        historyUsed >= this.limits.historyRequestsPerHour ? nextRelease('history') : '',
      nextNavigationAt:
        navigationUsed >= this.limits.navigationActionsPerHour ? nextRelease('navigation') : '',
      nextDetailAt: detailReady
        ? ''
        : new Date(lastDetailAt + this.limits.detailMinIntervalMs).toISOString(),
      nextDomAt: domReady ? '' : new Date(lastDomAt + this.limits.domMinIntervalMs).toISOString(),
    };
  }

  recordUsage(usage, at, state = this.state) {
    const actions = currentActions(state, at);
    for (const kind of ['history', 'dom', 'detail'])
      if (usage[kind] > 0) actions.push({ kind, count: usage[kind], at: at.toISOString() });
    return actions;
  }

  clearScheduledTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  async scheduleState(delay = this.intervalMs) {
    if (this.state.lifecycle !== 'running' || this.timer) return;
    const nextTickAt = new Date(this.now().getTime() + delay).toISOString();
    await this.persistState({ nextTickAt });
    if (this.state.lifecycle !== 'running' || this.timer) return;
    const timer = this.setTimer(() => {
      // A cleared/stale timer must never discard a newer scheduled handle.
      if (this.timer !== timer) return null;
      this.timer = null;
      // runCycle persists failure/pause details. A timer has no caller to catch
      // its rejection; contain it so one platform failure cannot kill the service.
      return this.requestCycle({ scheduled: true }).catch(() => undefined);
    }, delay);
    this.timer = timer;
    timer?.unref?.();
  }

  async schedule(delay = this.intervalMs) {
    return this.enqueueState(async () => {
      await this.initializeState();
      return this.scheduleState(delay);
    });
  }

  async runCycle({ scheduled = false, historyMode = 'change' } = {}) {
    const admission = await this.enqueueState(async () => {
      await this.initializeState();
      if (scheduled && this.state.lifecycle !== 'running') return null;
      if (this.state.lifecycle === 'paused') throw new BossRuntimeError('BOSS_INTEGRATION_PAUSED');
      const started = this.now(),
        previousTick = this.state.lastTickAt ? Date.parse(this.state.lastTickAt) : NaN,
        elapsedSincePrevious = started.getTime() - previousTick;
      // Manual run/check invocations within ten seconds of the preceding
      // completed trigger are a durable no-op. Scheduled ticks deliberately
      // bypass this guard, and an in-flight cycle is joined in requestCycle.
      if (
        !scheduled &&
        historyMode !== 'backfill' &&
        Number.isFinite(previousTick) &&
        elapsedSincePrevious >= 0 &&
        elapsedSincePrevious < this.manualDebounceMs
      )
        return {
          debounced: true,
          result: {
            deduplicated: true,
            reason: 'BOSS_MANUAL_DEBOUNCED',
            usage: { historyRequests: 0, domSwitches: 0, detailNavigations: 0 },
          },
        };
      const budget = this.budget(started),
        baseActions = currentActions(this.state, started),
        reservedUsage = {
          history: budget.historyRequests,
          dom: budget.domActions,
          detail: budget.detailActions,
        };
      // Persist a conservative upper bound before any platform action. A hard
      // process exit therefore cannot reset the rolling budget. Normal results
      // replace this reservation with actual reported usage below.
      await this.persistState({
        actions: this.recordUsage(reservedUsage, started, {
          ...this.state,
          actions: baseActions,
        }),
      });
      return {
        started,
        budget,
        baseActions,
        reservedUsage,
        controlRevision: this.controlRevision,
      };
    });
    if (!admission) return null;
    if (admission.debounced) return admission.result;
    const { started, budget, baseActions, reservedUsage, controlRevision } = admission;
    let result;
    try {
      result = await this.executeCycle({ budget, scheduled, historyMode });
      const trustedUsage = reportedUsage(result, budget);
      if (!trustedUsage) throw new BossRuntimeError('BOSS_USAGE_INVALID');
      await this.enqueueState(async () => {
        const finished = this.now(),
          actions = this.recordUsage(trustedUsage, finished, {
            ...this.state,
            actions: baseActions,
          });
        if (result?.partial === true) {
          const code = safeCode({ code: result.error }),
            detailOnly = result.failureScope === 'detail',
            failures = this.state.consecutiveFailures + 1,
            pause = FATAL.test(code) || failures >= 3,
            mayChangeControl = pause && this.controlRevision === controlRevision;
          if (detailOnly) {
            await this.persistState({
              actions,
              lastTickAt: started.toISOString(),
              lastSuccessAt: finished.toISOString(),
              nextTickAt: '',
              consecutiveFailures: 0,
              detailEnrichment: validateDetailEnrichment(result.detailEnrichment),
              history: result.history ? validateHistory(result.history) : this.state.history,
            });
            return;
          }
          await this.persistState(
            {
              actions,
              lastTickAt: started.toISOString(),
              nextTickAt: '',
              consecutiveFailures: failures,
              history: result.history ? validateHistory(result.history) : this.state.history,
              ...(mayChangeControl ? { lifecycle: 'paused', sessionId: '', pauseCode: code } : {}),
            },
            { controlMutation: mayChangeControl },
          );
          return;
        }
        await this.persistState({
          actions,
          lastTickAt: started.toISOString(),
          lastSuccessAt: finished.toISOString(),
          nextTickAt: '',
          consecutiveFailures: 0,
          detailEnrichment: validateDetailEnrichment(
            result?.detailEnrichment ?? this.state.detailEnrichment,
          ),
          history: result?.history ? validateHistory(result.history) : this.state.history,
        });
      });
      return result;
    } catch (error) {
      await this.enqueueState(async () => {
        const code = safeCode(error),
          usage = reportedUsage(error, budget) || reservedUsage,
          actions = this.recordUsage(usage, this.now(), {
            ...this.state,
            actions: baseActions,
          }),
          failures = this.state.consecutiveFailures + 1,
          pause = FATAL.test(code) || failures >= 3,
          mayChangeControl = pause && this.controlRevision === controlRevision;
        await this.persistState(
          {
            actions,
            lastTickAt: started.toISOString(),
            nextTickAt: '',
            consecutiveFailures: failures,
            ...(mayChangeControl ? { lifecycle: 'paused', sessionId: '', pauseCode: code } : {}),
          },
          { controlMutation: mayChangeControl },
        );
      });
      throw error;
    }
  }

  requestCycle(options = {}) {
    // Timer and manual triggers join the in-flight cycle. They never enqueue a
    // catch-up run, including after sleep or repeated CLI invocations.
    if (this.cycle) return this.cycle;
    // Lifecycle commands invoked before this trigger complete first. This
    // prevents a request from slipping between pause/start validation and its
    // durable state transition without making pause wait for platform I/O.
    const lifecycleBarrier = this.lifecycleTail;
    let tracked;
    const execution = lifecycleBarrier.then(() => this.runCycle(options));
    tracked = execution.finally(async () => {
      try {
        await this.enqueueState(async () => {
          if (this.state?.lifecycle === 'running' && !this.stopRequested)
            await this.scheduleState(this.intervalMs);
        });
      } finally {
        if (this.cycle === tracked) this.cycle = null;
      }
    });
    this.cycle = tracked;
    return tracked;
  }

  start() {
    // Capture only the cycle that was requested before this lifecycle command.
    // A later cycle is ordered behind this command through lifecycleTail, while
    // awaiting `this.cycle` dynamically could accidentally wait on that later
    // cycle and deadlock. Browser preparation must never overlap the captured
    // collector cycle.
    const precedingCycle = this.cycle;
    return this.enqueueLifecycle(async () => {
      await this.enqueueState(() => this.initializeState());
      if (this.state.lifecycle === 'running') return this.status();
      if (this.state.lifecycle === 'paused') throw new BossRuntimeError('BOSS_INTEGRATION_PAUSED');
      await precedingCycle?.catch(() => {});
      // The preceding cycle may have entered a durable pause while start was
      // waiting. Recheck before invoking the browser-facing preparation hook.
      if (this.state.lifecycle === 'running') return this.status();
      if (this.state.lifecycle === 'paused') throw new BossRuntimeError('BOSS_INTEGRATION_PAUSED');
      await this.prepareStart();
      await this.enqueueState(async () => {
        // A preceding one-off cycle may have paused while start validation was
        // running. Never clear that newer pause implicitly.
        if (this.state.lifecycle === 'paused')
          throw new BossRuntimeError('BOSS_INTEGRATION_PAUSED');
        if (this.state.lifecycle === 'running') return;
        this.stopRequested = false;
        this.clearScheduledTimer();
        await this.persistState(
          {
            lifecycle: 'running',
            sessionId: `boss-session-${randomBytes(16).toString('hex')}`,
            startedAt: this.now().toISOString(),
            nextTickAt: '',
            pauseCode: '',
            consecutiveFailures: 0,
          },
          { controlMutation: true },
        );
        await this.scheduleState(0);
      });
      return this.status();
    });
  }

  pause(code = 'BOSS_PAUSED_BY_USER') {
    if (!SAFE_CODE.test(code)) throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
    return this.enqueueLifecycle(async () => {
      await this.enqueueState(async () => {
        await this.initializeState();
        this.clearScheduledTimer();
        await this.persistState(
          {
            lifecycle: 'paused',
            sessionId: '',
            nextTickAt: '',
            pauseCode: code,
          },
          { controlMutation: true },
        );
      });
      return this.status();
    });
  }

  resume() {
    const precedingCycle = this.cycle;
    return this.enqueueLifecycle(async () => {
      await this.enqueueState(() => this.initializeState());
      if (this.state.lifecycle !== 'paused') return this.status();
      // pause is intentionally immediate, but a subsequent resume must not run
      // its CDP verification while the cycle that was paused is still using the
      // browser target.
      await precedingCycle?.catch(() => {});
      if (this.state.lifecycle !== 'paused') return this.status();
      await this.verifyResume();
      await this.enqueueState(async () => {
        // Another lifecycle command cannot pass this one, but a cycle that was
        // already active may have finalized while verification was running.
        if (this.state.lifecycle !== 'paused') return;
        this.stopRequested = false;
        this.clearScheduledTimer();
        await this.persistState(
          {
            lifecycle: 'running',
            sessionId: `boss-session-${randomBytes(16).toString('hex')}`,
            startedAt: this.now().toISOString(),
            nextTickAt: '',
            pauseCode: '',
            consecutiveFailures: 0,
          },
          { controlMutation: true },
        );
        await this.scheduleState(0);
      });
      return this.status();
    });
  }

  runWhileStopped(operation) {
    if (typeof operation !== 'function')
      throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
    const precedingCycle = this.cycle;
    this.stopRequested = true;
    return this.enqueueLifecycle(async () => {
      this.stopRequested = true;
      await this.enqueueState(async () => {
        await this.initializeState();
        this.clearScheduledTimer();
        await this.persistState(
          {
            lifecycle: 'stopped',
            sessionId: '',
            startedAt: '',
            nextTickAt: '',
            pauseCode: '',
            consecutiveFailures: 0,
          },
          { controlMutation: true },
        );
      });
      await precedingCycle?.catch(() => {});
      await this.enqueueState(() =>
        this.persistState(
          {
            lifecycle: 'stopped',
            sessionId: '',
            startedAt: '',
            nextTickAt: '',
            pauseCode: '',
            consecutiveFailures: 0,
          },
          { controlMutation: true },
        ),
      );
      const result = await operation();
      return { ...this.status(), result };
    });
  }

  runMaintenance(operation) {
    if (typeof operation !== 'function')
      throw new BossRuntimeError('BOSS_RUNTIME_ARGUMENT_INVALID');
    const precedingCycle = this.cycle;
    return this.enqueueLifecycle(async () => {
      await this.enqueueState(() => this.initializeState());
      await precedingCycle?.catch(() => {});
      const result = await operation();
      if (result?.detailEnrichment)
        await this.enqueueState(() =>
          this.persistState({
            detailEnrichment: validateDetailEnrichment(result.detailEnrichment),
          }),
        );
      return { ...this.status(), result };
    });
  }

  stop() {
    // Capture only work requested before stop. A later explicit one-off run is
    // ordered after stop through the lifecycle barrier and must not deadlock it.
    const precedingCycle = this.cycle;
    this.stopRequested = true;
    return this.enqueueLifecycle(async () => {
      // A preceding queued resume/start may have cleared the eager stop flag.
      // Reassert it when this ordered lifecycle command actually begins.
      this.stopRequested = true;
      await this.enqueueState(async () => {
        await this.initializeState();
        this.clearScheduledTimer();
        await this.persistState(
          {
            lifecycle: 'stopped',
            sessionId: '',
            startedAt: '',
            nextTickAt: '',
            pauseCode: '',
            consecutiveFailures: 0,
          },
          { controlMutation: true },
        );
      });
      await precedingCycle?.catch(() => {});
      // The cycle may have recorded failure counters after the first stop
      // commit. Finish with an authoritative stopped state, while resume/start
      // remain queued behind this lifecycle operation.
      await this.enqueueState(() =>
        this.persistState(
          {
            lifecycle: 'stopped',
            sessionId: '',
            startedAt: '',
            nextTickAt: '',
            pauseCode: '',
            consecutiveFailures: 0,
          },
          { controlMutation: true },
        ),
      );
      return this.status();
    });
  }

  shutdown() {
    const precedingCycle = this.cycle;
    this.stopRequested = true;
    return this.enqueueLifecycle(async () => {
      this.stopRequested = true;
      await this.enqueueState(async () => {
        await this.initializeState();
        this.clearScheduledTimer();
      });
      await precedingCycle?.catch(() => {});
      await this.enqueueState(async () => {
        if (this.state.lifecycle === 'running')
          await this.persistState(
            {
              lifecycle: 'stopped',
              sessionId: '',
              startedAt: '',
              nextTickAt: '',
              pauseCode: '',
            },
            { controlMutation: true },
          );
      });
      return this.status();
    });
  }

  recoverPage() {
    const precedingCycle = this.cycle;
    return this.enqueueLifecycle(async () => {
      await this.enqueueState(() => this.initializeState());
      if (this.state.lifecycle === 'running')
        throw new BossRuntimeError('BOSS_RECOVER_REQUIRES_PAUSE');
      // Page creation/navigation is a browser action too. A user may pause an
      // in-flight cycle and immediately request recovery, so wait for that exact
      // preceding cycle before touching the task page.
      await precedingCycle?.catch(() => {});
      if (this.state.lifecycle === 'running')
        throw new BossRuntimeError('BOSS_RECOVER_REQUIRES_PAUSE');
      const result = await this.recoverPageAction();
      return { ...this.status(), recovered: true, result };
    });
  }

  status() {
    if (!this.state) throw new BossRuntimeError('BOSS_RUNTIME_NOT_INITIALIZED');
    return {
      ...structuredClone(this.state),
      runningCycle: Boolean(this.cycle),
      tickPending: false,
      budget: this.budget(),
      intervalMs: this.intervalMs,
    };
  }
}
