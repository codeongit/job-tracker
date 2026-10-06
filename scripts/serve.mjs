import { DiskBackups } from './disk-backups.mjs';
import { BossInbox } from './boss-inbox.mjs';
import { APP_VERSION, DATA_VERSION, WORKSPACE_VERSION, BACKUP_VERSION } from '../dist/version.js';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSshStore } from './ssh-store.mjs';
import { handleLocalApi } from './local-api.mjs';
import { resolvePublicPath } from './static-files.mjs';
import { WorkspaceStore } from './workspace-store.mjs';
import { createWorkspaceInboxConsumer } from './workspace-consumer.mjs';
import {
  saveServiceRuntime,
  readServiceRuntime,
  removeServiceRuntime,
  readServiceLaunch,
  claimServiceLaunch,
  updateServiceLaunch,
  removeServiceLaunch,
  SERVICE_FAILURE_CODES,
} from './service-runtime.mjs';
import { serviceProcessAlive } from './service-control.mjs';
import { createBossController } from './boss-controller.mjs';

const publicRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const privatePath = (name) => fileURLToPath(new URL(`../.local/${name}`, import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
function startupArguments(args) {
  const result = { port: 4317, seed: null, instanceId: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index],
      value = args[index + 1];
    if (!['--port', '--seed', '--launch-id'].includes(name) || !value || seen.has(name))
      throw new Error('SERVICE_ARGUMENTS_INVALID');
    seen.add(name);
    if (name === '--port') result.port = Number(value);
    if (name === '--seed') result.seed = value;
    if (name === '--launch-id') result.instanceId = value;
  }
  if (
    !Number.isSafeInteger(result.port) ||
    result.port < 1024 ||
    result.port > 65535 ||
    (result.instanceId !== null && !UUID.test(result.instanceId))
  )
    throw new Error('SERVICE_ARGUMENTS_INVALID');
  return result;
}
function startupFailure(error, stage) {
  if (SERVICE_FAILURE_CODES.has(error.code || error.message)) return error.code || error.message;
  if (error.code === 'EADDRINUSE') return 'SERVICE_PORT_IN_USE';
  if (stage === 'config_loading') return 'SERVICE_CONFIG_INVALID';
  if (
    ['history_validation', 'catalog_validation', 'head_validation', 'workspace_ready'].includes(
      stage,
    )
  )
    return 'SERVICE_WORKSPACE_INVALID';
  if (stage === 'inbox_initialization') return 'SERVICE_INBOX_INITIALIZATION_FAILED';
  if (stage === 'controller_initialization') return 'SERVICE_CONTROLLER_INITIALIZATION_FAILED';
  return 'SERVICE_START_FAILED';
}
export async function startLocalService({
  args = process.argv.slice(2),
  serviceRoot = privatePath('service/'),
  workspaceRoot = privatePath('workspace/'),
  config: suppliedConfig,
  readConfig = async () => {
    try {
      return JSON.parse(await readFile(privatePath('config.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('SERVICE_CONFIG_INVALID');
    }
  },
  createWorkspaceStore = (path, options) => new WorkspaceStore(path, options),
  createHttpServer = (handler) => http.createServer(handler),
  isProcessAlive = serviceProcessAlive,
  now = Date.now,
  processStartedAt = new Date(performance.timeOrigin).toISOString(),
  pid = process.pid,
} = {}) {
  const options = startupArguments(args),
    instanceId = options.instanceId || randomUUID(),
    controlToken = randomBytes(32).toString('hex'),
    secret = randomBytes(32).toString('hex'),
    port = options.port;
  let runtime = {
    version: 2,
    instanceId,
    workspaceId: null,
    pid,
    port,
    controlToken,
    phase: 'starting',
    processStartedAt,
    readyAt: null,
    startupDurationMs: null,
    progress: { stage: 'launching' },
    failureCode: null,
  };
  let workspaceStore,
    bossController,
    server,
    drainTimer,
    published = false,
    ownsLaunch = false,
    stopping = false;
  async function publish(value) {
    try {
      if (published && (await readServiceRuntime(serviceRoot))?.instanceId !== instanceId)
        throw new Error('SERVICE_RUNTIME_INVALID');
      await saveServiceRuntime(serviceRoot, value);
      runtime = value;
      published = true;
    } catch {
      throw new Error('SERVICE_RUNTIME_SAVE_FAILED');
    }
  }
  async function progress(value) {
    await publish({
      ...runtime,
      workspaceId: workspaceStore?.workspaceId || null,
      progress: {
        stage: value.stage,
        ...(value.completed === undefined ? {} : { completed: value.completed }),
        ...(value.total === undefined ? {} : { total: value.total }),
      },
    });
  }
  async function closeResources() {
    clearInterval(drainTimer);
    await bossController?.shutdown().catch(() => {});
    if (server?.listening) {
      server.closeIdleConnections();
      await new Promise((accept) => server.close(accept));
    }
    await workspaceStore?.close().catch(() => {});
  }
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await closeResources();
    await removeServiceLaunch(serviceRoot, instanceId);
    await removeServiceRuntime(serviceRoot, instanceId);
  }
  try {
    const previous = await readServiceRuntime(serviceRoot);
    if (
      previous &&
      previous.instanceId !== instanceId &&
      previous.version === 1 &&
      previous.pid === undefined
    )
      throw new Error('SERVICE_RUNTIME_UNCONFIRMED');
    if (previous && previous.instanceId !== instanceId && isProcessAlive(previous.pid))
      throw new Error('SERVICE_ALREADY_RUNNING');
    if (options.instanceId) {
      const launch = await readServiceLaunch(serviceRoot);
      if (
        launch?.instanceId !== instanceId ||
        launch.port !== port ||
        (launch.childPid !== null && launch.childPid !== pid)
      )
        throw new Error('SERVICE_OWNERSHIP_MISMATCH');
      ownsLaunch = true;
      await updateServiceLaunch(serviceRoot, instanceId, pid);
    } else {
      ownsLaunch = await claimServiceLaunch(serviceRoot, {
        version: 1,
        instanceId,
        launcherPid: pid,
        childPid: pid,
        port,
        processStartedAt,
      });
      if (!ownsLaunch) throw new Error('SERVICE_ALREADY_STARTING');
    }
    await publish(runtime);
    await progress({ stage: 'config_loading' });
    const config = suppliedConfig === undefined ? await readConfig() : suppliedConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('SERVICE_CONFIG_INVALID');
    const seed = options.seed || config.sourceMarkdown;
    workspaceStore = createWorkspaceStore(workspaceRoot, { instanceId, onProgress: progress });
    await progress({ stage: 'head_validation' });
    await workspaceStore.initialize();
    await progress({ stage: 'workspace_ready' });
    const versions = {
      appVersion: APP_VERSION,
      dataVersion: DATA_VERSION,
      workspaceVersion: WORKSPACE_VERSION,
      backupVersion: BACKUP_VERSION,
    };
    const bridge = config.sshSync
      ? createSshStore(config.sshSync, privatePath('ssh-cache.git'))
      : null;
    const backups = new DiskBackups(privatePath('backups/'));
    const bossInbox = config.bossIntegration
      ? new BossInbox(privatePath('boss-integration/'))
      : null;
    await progress({ stage: 'inbox_initialization' });
    if (bossInbox) await bossInbox.initialize();
    const inboxConsumer = createWorkspaceInboxConsumer({ workspaceStore, inbox: bossInbox });
    await progress({ stage: 'controller_initialization' });
    bossController = bossInbox
      ? createBossController({
          config: config.bossIntegration,
          inboxRoot: bossInbox.root,
          workspaceStore,
          inboxConsumer,
        })
      : null;
    if (bossController) await bossController.initialize();
    server = createHttpServer(async (req, res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (runtime.phase !== 'ready') {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code: 'SERVICE_STARTING', phase: 'starting' }));
        return;
      }
      if (
        await handleLocalApi(req, res, {
          port,
          secret,
          bridge,
          target: config.sshSync,
          backups,
          bossInbox,
          bossController,
          inboxConsumer,
          workspaceStore,
          instanceId,
          controlToken,
          shutdown,
          versions,
        })
      )
        return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname === '/__local/health') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              appVersion: APP_VERSION,
              nodeMajor: Number(process.versions.node.split('.')[0]),
              sshConfigured: !!bridge,
              backupEnabled: true,
              bossIntegrationEnabled: !!bossInbox,
              localWorkspaceEnabled: true,
              serviceKind: 'job-tracker-local',
              protocolVersion: 1,
              storageVersion: 2,
              phase: 'ready',
              instanceId,
              workspaceId: workspaceStore.workspaceId,
              ...versions,
              tracking: bossController?.status().lifecycle || 'disabled',
              inbox: inboxConsumer.status(),
            }),
          );
          return;
        }
        if (url.pathname === '/__local/source') {
          if (
            (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
            (req.headers['sec-fetch-site'] &&
              !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
          ) {
            res.writeHead(403);
            res.end();
            return;
          }
          if (!seed) {
            res.writeHead(404);
            res.end('No local source configured');
            return;
          }
          const source = await readFile(seed);
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : source);
          return;
        }
        const pathname = decodeURIComponent(url.pathname),
          path = resolvePublicPath(publicRoot, pathname);
        if ((await stat(path)).isDirectory()) throw new Error('Not found');
        const file = await readFile(path);
        res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
        res.end(req.method === 'HEAD' ? undefined : file);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
        res.end('Not found');
      }
    });
    await progress({ stage: 'listening' });
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        accept();
      });
    });
    await removeServiceLaunch(serviceRoot, instanceId);
    ownsLaunch = false;
    await publish({
      ...runtime,
      phase: 'ready',
      readyAt: new Date(now()).toISOString(),
      startupDurationMs: Math.max(0, Math.round(now() - Date.parse(processStartedAt))),
      progress: { stage: 'ready' },
    });
    server.on('error', () => {
      process.stderr.write('SERVICE_RUNTIME_FAILED\n');
      void shutdown();
    });
    const drain = () =>
      void inboxConsumer.run().catch(() => process.stderr.write('WORKSPACE_INBOX_DRAIN_FAILED\n'));
    drain();
    drainTimer = setInterval(drain, 30000);
    return { server, shutdown, instanceId, port, workspaceId: workspaceStore.workspaceId };
  } catch (error) {
    const failureCode = startupFailure(error, runtime.progress.stage);
    if (published) {
      await publish({
        ...runtime,
        phase: 'failed',
        failureCode,
        startupDurationMs: Math.max(0, Math.round(now() - Date.parse(processStartedAt))),
      }).catch(() => {});
    }
    await closeResources();
    if (ownsLaunch) await removeServiceLaunch(serviceRoot, instanceId).catch(() => {});
    throw new Error(failureCode);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const service = await startLocalService();
    process.once('SIGINT', () => void service.shutdown());
    process.once('SIGTERM', () => void service.shutdown());
    process.stdout.write(
      `求职工作台：http://127.0.0.1:${service.port}\n仅监听本机；跟踪尚未启动；Ctrl+C 停止。\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${SERVICE_FAILURE_CODES.has(error.message) ? error.message : 'SERVICE_START_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
