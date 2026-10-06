import { BOSS_JOB_ID, parseBossJobUrl, isCanonicalBossJobUrl } from '../../dist/boss-job-url.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { expectedUrl, isExpectedUrl } from './guard.mjs';
import { browserProfileDirectory } from './paths.mjs';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const accountPattern = /^[a-zA-Z0-9_-]{1,40}$/;
const namespacePattern = /^boss-geek:[0-9a-f]{64}$/;
const targetPattern = /^[A-Za-z0-9_-]{1,200}$/;
const safeDetailRedirect =
  /^https:\/\/www\.zhipin\.com\/(?:passport|login|security|captcha|web\/user)(?:\/|\?|$)/i;

function safeCode(error, fallback) {
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(String(error?.message)) ? String(error.message) : fallback;
}
const coded = (value) => Object.assign(new Error(value), { code: value });

function digestAccount(account) {
  if (!accountPattern.test(account ?? '')) throw new Error('ACCOUNT_LABEL_INVALID');
  return createHash('sha256').update('boss-tracker\0').update(account).digest('hex').slice(0, 16);
}

function portForAccount(account) {
  const value = Number.parseInt(digestAccount(account).slice(0, 6), 16);
  return 19000 + (value % 800);
}

function namespace(value) {
  if (!['string', 'number'].includes(typeof value)) throw new Error('ACCOUNT_ID_INVALID');
  const normalized = String(value).normalize('NFC').trim();
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(normalized)) throw new Error('ACCOUNT_ID_INVALID');
  return 'boss-geek:' + createHash('sha256').update('boss-geek\0').update(normalized).digest('hex');
}

function browserInstanceId(webSocketDebuggerUrl) {
  if (
    typeof webSocketDebuggerUrl !== 'string' ||
    !/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(webSocketDebuggerUrl)
  ) {
    throw new Error('CDP_BROWSER_IDENTITY_INVALID');
  }
  return createHash('sha256')
    .update('boss-cdp-browser\0')
    .update(webSocketDebuggerUrl)
    .digest('hex');
}

export function normalizeConnection(value) {
  if (
    value?.version === 1 &&
    value.kind === 'cdp_persistent' &&
    /^boss-tracker-cdp-[0-9a-f]{16}$/.test(value.session ?? '') &&
    /^19\d{3}$/.test(value.nativeTabId ?? '') &&
    value.nativeWindowId === value.nativeTabId &&
    value.page === expectedUrl &&
    namespacePattern.test(value.accountNamespace ?? '') &&
    Number.isFinite(Date.parse(value.connectedAt))
  )
    return structuredClone(value);
  if (
    !value ||
    value.version !== 2 ||
    value.kind !== 'cdp_bound' ||
    !/^boss-tracker-cdp-[0-9a-f]{16}$/.test(value.session ?? '') ||
    !/^19\d{3}$/.test(value.browserPort ?? '') ||
    !/^boss-tracker-profile-[0-9a-f]{16}$/.test(value.browserProfile ?? '') ||
    !/^[0-9a-f]{64}$/.test(value.browserInstanceId ?? '') ||
    !targetPattern.test(value.taskTargetId ?? '') ||
    typeof value.taskTargetCreatedByTask !== 'boolean' ||
    value.page !== expectedUrl ||
    !namespacePattern.test(value.accountNamespace ?? '') ||
    !Number.isFinite(Date.parse(value.connectedAt))
  )
    throw new Error('CONNECTION_METADATA_INVALID');
  return structuredClone(value);
}

function connectionFor(account, accountNamespace, endpoint, target, createdByTask, now) {
  const digest = digestAccount(account);
  return {
    version: 2,
    kind: 'cdp_bound',
    session: `boss-tracker-cdp-${digest}`,
    browserPort: String(endpoint.port),
    browserProfile: `boss-tracker-profile-${digest}`,
    browserInstanceId: endpoint.instanceId,
    taskTargetId: target.id,
    taskTargetCreatedByTask: Boolean(createdByTask),
    page: expectedUrl,
    accountNamespace,
    connectedAt: new Date(now()).toISOString(),
  };
}

function connectionPort(connection) {
  return Number(connection.version === 1 ? connection.nativeTabId : connection.browserPort);
}

function profileFor(account) {
  return browserProfileDirectory(digestAccount(account));
}

function launchChrome(account, port, spawnImpl = spawn) {
  const child = spawnImpl(
    chrome,
    [
      `--user-data-dir=${profileFor(account)}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref?.();
}

export class RawCdpClient {
  constructor(socket, timeout = 20_000) {
    this.socket = socket;
    this.timeout = timeout;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error('CDP_COMMAND_FAILED'));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending());
    socket.addEventListener('error', () => this.rejectPending());
  }
  rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP_CONNECTION_CLOSED'));
    }
    this.pending.clear();
  }
  command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP_COMMAND_TIMEOUT'));
      }, this.timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('CDP_SEND_FAILED'));
      }
    });
  }
  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails || !result?.result || !Object.hasOwn(result.result, 'value')) {
      throw new Error('CDP_EVALUATION_FAILED');
    }
    return result.result.value;
  }
  async navigate(url) {
    const result = await this.command('Page.navigate', { url });
    if (result?.errorText) throw new Error('CDP_NAVIGATION_FAILED');
  }
  async close() {
    this.rejectPending();
    if (this.socket.readyState >= 2) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      timer.unref?.();
      this.socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.close(1000, 'tracker operation complete');
    });
  }
}

async function defaultCdpFactory(url, WebSocketImpl = WebSocket) {
  const socket = new WebSocketImpl(url);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP_CONNECT_TIMEOUT')), 10_000);
      timer.unref?.();
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP_CONNECT_FAILED'));
        },
        { once: true },
      );
    });
  } catch (error) {
    try {
      socket.close();
    } catch {}
    throw error;
  }
  return new RawCdpClient(socket);
}

export function createCdpController({
  fetchImpl = fetch,
  spawnImpl = spawn,
  WebSocketImpl = WebSocket,
  cdpFactory = (url) => defaultCdpFactory(url, WebSocketImpl),
  now = () => new Date(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const endpoint = async (port) => {
    let response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      throw new Error('CONNECTION_REQUIRED');
    }
    if (!response?.ok) throw new Error('CONNECTION_REQUIRED');
    let value;
    try {
      value = await response.json();
    } catch {
      throw new Error('CDP_BROWSER_IDENTITY_INVALID');
    }
    return {
      port,
      webSocketDebuggerUrl: value?.webSocketDebuggerUrl,
      instanceId: browserInstanceId(value?.webSocketDebuggerUrl),
    };
  };
  const endpointReady = async (port) => {
    try {
      return await endpoint(port);
    } catch {
      return null;
    }
  };
  const ensureBrowser = async (account) => {
    const port = portForAccount(account);
    const existing = await endpointReady(port);
    if (existing) return { ...existing, launched: false };
    await mkdir(profileFor(account), { recursive: true, mode: 0o700 });
    launchChrome(account, port, spawnImpl);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(500);
      const ready = await endpointReady(port);
      if (ready) return { ...ready, launched: true };
    }
    throw new Error('CDP_BROWSER_START_TIMEOUT');
  };
  const listTargets = async (port) => {
    let response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      throw new Error('CDP_TARGET_LIST_FAILED');
    }
    if (!response.ok) throw new Error('CDP_TARGET_LIST_FAILED');
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error('CDP_TARGET_LIST_INVALID');
    return targets.filter(
      (target) =>
        target?.type === 'page' &&
        targetPattern.test(target.id ?? '') &&
        typeof target.url === 'string' &&
        typeof target.webSocketDebuggerUrl === 'string',
    );
  };
  const withClient = async (url, operation) => {
    const client = await cdpFactory(url);
    try {
      return await operation(client);
    } finally {
      await client.close();
    }
  };
  const navigate = async (target, url) =>
    withClient(target.webSocketDebuggerUrl, (client) => client.navigate(url));
  const createTarget = async (currentEndpoint, url) =>
    withClient(currentEndpoint.webSocketDebuggerUrl, async (client) => {
      if (typeof client.command !== 'function') throw new Error('CDP_TARGET_CREATE_UNSUPPORTED');
      const result = await client.command('Target.createTarget', { url, background: true });
      if (!targetPattern.test(result?.targetId ?? '')) throw new Error('CDP_TARGET_CREATE_FAILED');
      return result.targetId;
    });
  const waitForTarget = async (port, targetId, url) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const target = (await listTargets(port)).find((item) => item.id === targetId);
      if (target && target.url === url) return target;
      if (target && /(?:\/passport|\/login|\/security|\/captcha|\/web\/user)/i.test(target.url)) {
        throw new Error('LOGIN_REQUIRED');
      }
      await wait(500);
    }
    throw new Error('TASK_PAGE_LOAD_TIMEOUT');
  };
  const acquireTaskTarget = async (currentEndpoint, { allowCreate }) => {
    const targets = await listTargets(currentEndpoint.port);
    const matches = targets.filter((target) => isExpectedUrl(target.url));
    if (matches.length > 1) throw new Error('MULTIPLE_TASK_PAGES');
    if (matches.length) return { target: matches[0], createdByTask: false };
    if (targets.some((target) => target.url.startsWith('https://www.zhipin.com/web/user/')))
      throw new Error('LOGIN_REQUIRED');
    if (!allowCreate) throw new Error('TASK_PAGE_REQUIRED');
    const blanks = targets.filter((target) => target.url === 'about:blank');
    let targetId;
    if (blanks.length === 1) {
      targetId = blanks[0].id;
      await navigate(blanks[0], expectedUrl);
    } else targetId = await createTarget(currentEndpoint, expectedUrl);
    return {
      target: await waitForTarget(currentEndpoint.port, targetId, expectedUrl),
      createdByTask: true,
    };
  };
  const evaluateTarget = async (target, expression) =>
    withClient(target.webSocketDebuggerUrl, (client) => client.evaluate(expression));
  const readIdentity = async (target, expression, extract) => {
    const payload = await evaluateTarget(target, expression);
    if (!payload?.ok || !isExpectedUrl(payload.url))
      throw new Error(payload?.reason ?? 'ACCOUNT_IDENTITY_GUARD_FAILED');
    return namespace(extract(payload));
  };
  const boundTarget = async (connection) => {
    if (connection.version !== 2) throw new Error('CONNECTION_REBIND_REQUIRED');
    const currentEndpoint = await endpoint(connectionPort(connection));
    if (currentEndpoint.instanceId !== connection.browserInstanceId)
      throw new Error('BROWSER_INSTANCE_CHANGED');
    const target = (await listTargets(currentEndpoint.port)).find(
      (item) => item.id === connection.taskTargetId,
    );
    if (!target) throw new Error('TASK_TARGET_MISSING');
    if (!isExpectedUrl(target.url)) throw new Error('TASK_TARGET_DRIFTED');
    return { endpoint: currentEndpoint, target };
  };
  async function bind(
    operation,
    { account = 'main', identityExpression, extractAccountIdentity, allowCreate = true } = {},
  ) {
    const report = {
      operation,
      startedAt: new Date(now()).toISOString(),
      identityVerified: false,
      bindingRetained: false,
      originalTargetRetained: true,
    };
    try {
      if (typeof identityExpression !== 'string' || typeof extractAccountIdentity !== 'function')
        throw new Error('IDENTITY_OPTIONS_INVALID');
      const currentEndpoint = await ensureBrowser(account);
      report.browserLaunched = currentEndpoint.launched;
      const acquired = await acquireTaskTarget(currentEndpoint, { allowCreate });
      const accountNamespace = await readIdentity(
        acquired.target,
        identityExpression,
        extractAccountIdentity,
      );
      const connection = connectionFor(
        account,
        accountNamespace,
        currentEndpoint,
        acquired.target,
        acquired.createdByTask,
        now,
      );
      report.identityVerified = true;
      report.bindingRetained = true;
      report.targetCreated = acquired.createdByTask;
      report.finishedAt = new Date(now()).toISOString();
      return { ok: true, connection, report };
    } catch (error) {
      report.error = safeCode(error, 'CDP_BIND_FAILED');
      report.finishedAt = new Date(now()).toISOString();
      return { ok: false, connection: null, report };
    }
  }
  async function start(options = {}) {
    return bind('start', { ...options, allowCreate: true });
  }
  async function connect(options = {}) {
    return bind('connect', { ...options, allowCreate: true });
  }
  async function recoverPage(options = {}) {
    return bind('recover-page', { ...options, allowCreate: true });
  }
  async function resume(connectionValue, { identityExpression, extractAccountIdentity } = {}) {
    const report = {
      operation: 'resume',
      startedAt: new Date(now()).toISOString(),
      identityVerified: false,
      bindingRetained: false,
      originalTargetRetained: true,
    };
    try {
      const connection = normalizeConnection(connectionValue);
      const { target } = await boundTarget(connection);
      const actual = await readIdentity(target, identityExpression, extractAccountIdentity);
      if (actual !== connection.accountNamespace) throw new Error('ACCOUNT_NAMESPACE_CHANGED');
      report.identityVerified = true;
      report.bindingRetained = true;
      report.finishedAt = new Date(now()).toISOString();
      return { ok: true, connection, report };
    } catch (error) {
      report.error = safeCode(error, 'CDP_RESUME_FAILED');
      report.finishedAt = new Date(now()).toISOString();
      return { ok: false, connection: null, report };
    }
  }
  async function evaluateBound(connectionValue, expression) {
    const connection = normalizeConnection(connectionValue);
    if (typeof expression !== 'string' || !expression.trim())
      throw new Error('READ_EXPRESSION_INVALID');
    const { target } = await boundTarget(connection);
    const payload = await evaluateTarget(target, expression);
    const after = await boundTarget(connection);
    if (after.target.id !== target.id) throw new Error('TASK_TARGET_CHANGED');
    return payload;
  }
  async function capture(
    connectionValue,
    expression,
    { identityExpression, extractAccountIdentity } = {},
  ) {
    const report = {
      operation: 'capture',
      startedAt: new Date(now()).toISOString(),
      identityVerified: false,
      readSucceeded: false,
      bindingRetained: false,
    };
    try {
      const connection = normalizeConnection(connectionValue);
      const { target } = await boundTarget(connection);
      const before = await readIdentity(target, identityExpression, extractAccountIdentity);
      if (before !== connection.accountNamespace) throw new Error('ACCOUNT_NAMESPACE_CHANGED');
      const payload = await evaluateBound(connection, expression);
      if (!payload?.ok || !isExpectedUrl(payload.url))
        throw new Error(payload?.reason ?? 'PAGE_READ_GUARD_FAILED');
      report.readSucceeded = true;
      const { target: afterTarget } = await boundTarget(connection);
      const after = await readIdentity(afterTarget, identityExpression, extractAccountIdentity);
      if (after !== connection.accountNamespace) throw new Error('ACCOUNT_NAMESPACE_CHANGED');
      report.identityVerified = true;
      report.bindingRetained = true;
      report.finishedAt = new Date(now()).toISOString();
      return { ok: true, payload, report };
    } catch (error) {
      report.error = safeCode(error, 'CDP_CAPTURE_FAILED');
      report.finishedAt = new Date(now()).toISOString();
      return { ok: false, payload: null, report };
    }
  }
  function createDetailAdapter(connectionValue) {
    const connection = normalizeConnection(connectionValue);
    let ownedTargetId = null,
      owner = null;
    const verifyHandle = (handle, ownerToken) => {
      if (
        !handle ||
        handle.ownerToken !== ownerToken ||
        owner !== ownerToken ||
        handle.tabId !== ownedTargetId ||
        handle.windowId !== connection.browserInstanceId
      ) {
        throw coded('DETAIL_TAB_OWNERSHIP_MISMATCH');
      }
    };
    const ownedTarget = async () => {
      if (connection.version !== 2) throw coded('CONNECTION_REBIND_REQUIRED');
      const currentEndpoint = await endpoint(connectionPort(connection));
      if (currentEndpoint.instanceId !== connection.browserInstanceId)
        throw coded('BROWSER_INSTANCE_CHANGED');
      const target = (await listTargets(currentEndpoint.port)).find(
        (item) => item.id === ownedTargetId,
      );
      if (!target) throw coded('DETAIL_TAB_MISSING');
      return { currentEndpoint, target };
    };
    return {
      async createOwnedTab({ ownerToken, initialUrl }) {
        if (ownedTargetId || !isCanonicalBossJobUrl(initialUrl))
          throw coded(ownedTargetId ? 'DETAIL_TAB_ALREADY_CREATED' : 'INVALID_DETAIL_URL');
        const binding = await boundTarget(connection);
        owner = ownerToken;
        ownedTargetId = await createTarget(binding.endpoint, initialUrl);
        await waitForTarget(binding.endpoint.port, ownedTargetId, initialUrl);
        return { ownerToken, tabId: ownedTargetId, windowId: connection.browserInstanceId };
      },
      async readOwnedTab(handle) {
        verifyHandle(handle, handle?.ownerToken);
        const { target } = await ownedTarget();
        const value = await evaluateTarget(target, '({url:location.href,title:document.title})');
        if (!value || typeof value.url !== 'string' || typeof value.title !== 'string')
          throw coded('DETAIL_TAB_READ_INVALID');
        return { ...handle, url: value.url, title: value.title.replace(/\s+/g, ' ').trim() };
      },
      async navigateOwnedTab(handle, { ownerToken, expectedUrl, nextUrl }) {
        verifyHandle(handle, ownerToken);
        if (!isCanonicalBossJobUrl(expectedUrl) || !isCanonicalBossJobUrl(nextUrl))
          throw coded('INVALID_DETAIL_URL');
        const { target } = await ownedTarget();
        if (target.url !== expectedUrl) throw coded('DETAIL_TAB_CHANGED');
        await navigate(target, nextUrl);
      },
      async closeOwnedTab(handle, { ownerToken, expectedUrl }) {
        verifyHandle(handle, ownerToken);
        if (!isCanonicalBossJobUrl(expectedUrl) && !safeDetailRedirect.test(expectedUrl))
          throw coded('INVALID_DETAIL_URL');
        const { currentEndpoint, target } = await ownedTarget();
        if (target.url !== expectedUrl) throw coded('DETAIL_TAB_CHANGED');
        await withClient(currentEndpoint.webSocketDebuggerUrl, async (client) => {
          if (typeof client.command !== 'function') throw coded('CDP_TARGET_CLOSE_UNSUPPORTED');
          const result = await client.command('Target.closeTarget', { targetId: ownedTargetId });
          if (result?.success !== true) throw coded('DETAIL_TAB_CLOSE_FAILED');
        });
        ownedTargetId = null;
        owner = null;
      },
    };
  }
  async function disconnect(connectionValue) {
    normalizeConnection(connectionValue);
    return {
      ok: true,
      report: {
        operation: 'disconnect',
        released: true,
        targetRetained: true,
        ownedTargetReleased: true,
        finishedAt: new Date(now()).toISOString(),
      },
    };
  }
  return {
    start,
    connect,
    resume,
    recoverPage,
    capture,
    evaluateBound,
    createDetailAdapter,
    disconnect,
  };
}

const controller = createCdpController();
export const start = (options) => controller.start(options);
export const connect = (options) => controller.connect(options);
export const resume = (connection, options) => controller.resume(connection, options);
export const recoverPage = (options) => controller.recoverPage(options);
export const capture = (connection, expression, options) =>
  controller.capture(connection, expression, options);
export const evaluateBound = (connection, expression) =>
  controller.evaluateBound(connection, expression);
export const createCdpDetailAdapter = (connection) => controller.createDetailAdapter(connection);
export const disconnect = (connection) => controller.disconnect(connection);
