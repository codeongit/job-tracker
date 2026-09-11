import { DiskBackups } from './disk-backups.mjs';
import { APP_VERSION } from '../dist/version.js';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createSshStore } from './ssh-store.mjs';
import { handleLocalApi } from './local-api.mjs';
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
const bridge = config.sshSync
  ? createSshStore(
      config.sshSync,
      fileURLToPath(new URL('../.local/ssh-cache.git', import.meta.url)),
    )
  : null;
const backups = new DiskBackups(fileURLToPath(new URL('../.local/backups/', import.meta.url)));
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
  if (await handleLocalApi(req, res, { port, secret, bridge, target: config.sshSync, backups }))
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
      path = resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
    if (
      !path.startsWith(root + sep) ||
      pathname.split('/').some((p) => p.startsWith('.')) ||
      (await stat(path)).isDirectory()
    )
      throw new Error('Not found');
    const file = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end('Not found');
  }
});
server.on('error', (error) => {
  process.stderr.write(`无法启动本地工作台：${error.message}\n`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () =>
  process.stdout.write(`求职工作台：http://127.0.0.1:${port}\n仅监听本机；Ctrl+C 停止。\n`),
);
