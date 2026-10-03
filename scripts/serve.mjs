import { DiskBackups } from './disk-backups.mjs';
import { BossInbox } from './boss-inbox.mjs';
import { APP_VERSION, DATA_VERSION, WORKSPACE_VERSION, BACKUP_VERSION } from '../dist/version.js';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSshStore } from './ssh-store.mjs';
import { handleLocalApi } from './local-api.mjs';
import { resolvePublicPath } from './static-files.mjs';
import { WorkspaceStore } from './workspace-store.mjs';
import { createWorkspaceInboxConsumer } from './workspace-consumer.mjs';
import { saveServiceRuntime, removeServiceRuntime } from './service-runtime.mjs';
import { createBossController } from './boss-controller.mjs';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
let config = {};
try {
  config = JSON.parse(await readFile(new URL('../.local/config.json', import.meta.url), 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT')
    throw new Error('本地配置无法读取或 JSON 格式无效，请检查 .local/config.json。');
}
const args = process.argv.slice(2),
  port = Number(args[args.indexOf('--port') + 1]) || 4317;
const seed = args.includes('--seed') ? args[args.indexOf('--seed') + 1] : config.sourceMarkdown;
const secret = randomBytes(32).toString('hex');
const instanceId = randomUUID(),
  controlToken = randomBytes(32).toString('hex');
const serviceRoot = fileURLToPath(new URL('../.local/service/', import.meta.url));
const workspaceStore = new WorkspaceStore(
  fileURLToPath(new URL('../.local/workspace/', import.meta.url)),
  { instanceId },
);
await workspaceStore.initialize();
const versions = {
  appVersion: APP_VERSION,
  dataVersion: DATA_VERSION,
  workspaceVersion: WORKSPACE_VERSION,
  backupVersion: BACKUP_VERSION,
};
const bridge = config.sshSync
  ? createSshStore(
      config.sshSync,
      fileURLToPath(new URL('../.local/ssh-cache.git', import.meta.url)),
    )
  : null;
const backups = new DiskBackups(fileURLToPath(new URL('../.local/backups/', import.meta.url)));
const bossInbox = config.bossIntegration
  ? new BossInbox(fileURLToPath(new URL('../.local/boss-integration/', import.meta.url)))
  : null;
if (bossInbox) await bossInbox.initialize();
const inboxConsumer = createWorkspaceInboxConsumer({ workspaceStore, inbox: bossInbox });
const bossController = bossInbox
  ? createBossController({
      config: config.bossIntegration,
      inboxRoot: bossInbox.root,
      workspaceStore,
      inboxConsumer,
    })
  : null;
if (bossController) await bossController.initialize();
let drainTimer,
  stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(drainTimer);
  await bossController?.shutdown();
  server.closeIdleConnections();
  await new Promise((accept) => server.close(accept));
  await workspaceStore.close();
  await removeServiceRuntime(serviceRoot, instanceId);
}
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Restrict the local source endpoint to requests addressed to this loopback server.
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) {
    res.writeHead(403);
    res.end();
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
          storageVersion: 1,
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
      path = resolvePublicPath(root, pathname);
    if ((await stat(path)).isDirectory()) throw new Error('Not found');
    const file = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('Not found');
  }
});
server.on('error', async (error) => {
  process.stderr.write(`无法启动本地工作台：${error.code || 'SERVICE_START_FAILED'}\n`);
  await workspaceStore.close();
  await removeServiceRuntime(serviceRoot, instanceId);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', async () => {
  await saveServiceRuntime(serviceRoot, {
    version: 1,
    instanceId,
    workspaceId: workspaceStore.workspaceId,
    pid: process.pid,
    port,
    controlToken,
    startedAt: new Date().toISOString(),
    processStartedAt: new Date(performance.timeOrigin).toISOString(),
    startupDurationMs: Math.round(Date.now() - performance.timeOrigin),
  });
  const drain = () =>
    void inboxConsumer.run().catch(() => process.stderr.write('WORKSPACE_INBOX_DRAIN_FAILED\n'));
  drain();
  drainTimer = setInterval(drain, 30000);
  process.stdout.write(
    `求职工作台：http://127.0.0.1:${port}\n仅监听本机；跟踪尚未启动；Ctrl+C 停止。\n`,
  );
});
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
