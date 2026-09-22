import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const TOKEN = /^[a-f0-9]{64}$/;
const FORMAT = 'job-tracker-boss-internal-authorization';
const VERSION = 1;
const DEFAULT_TTL_MS = 60_000;

export class BossInternalAuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = (code) => {
  throw new BossInternalAuthorizationError(code);
};
const iso = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

function authorizationDirectory(root) {
  if (!isAbsolute(root)) fail('BOSS_INTERNAL_AUTH_PATH_INVALID');
  return join(root, 'controller-authorizations');
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('BOSS_INTERNAL_AUTH_PATH_INVALID');
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

function validateRequest(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['command', 'detailLimit', 'domLimit', 'historyRequests'].sort()) ||
    value.command !== 'collect-cycle' ||
    !Number.isSafeInteger(value.historyRequests) ||
    value.historyRequests < 0 ||
    value.historyRequests > 20 ||
    !Number.isSafeInteger(value.detailLimit) ||
    value.detailLimit < 0 ||
    value.detailLimit > 20 ||
    !Number.isSafeInteger(value.domLimit) ||
    value.domLimit < 0 ||
    value.domLimit > 1
  )
    fail('BOSS_INTERNAL_AUTH_INVALID');
  return structuredClone(value);
}

function validateTicket(value, token) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['expiresAt', 'format', 'issuedAt', 'request', 'token', 'version'].sort()) ||
    value.format !== FORMAT ||
    value.version !== VERSION ||
    value.token !== token ||
    !TOKEN.test(value.token) ||
    !iso(value.issuedAt) ||
    !iso(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
  )
    fail('BOSS_INTERNAL_AUTH_INVALID');
  return { ...value, request: validateRequest(value.request) };
}

async function regularTicket(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    fail('BOSS_INTERNAL_AUTH_INVALID');
}

export async function issueBossInternalAuthorization(
  root,
  request,
  { now = () => new Date(), ttlMs = DEFAULT_TTL_MS } = {},
) {
  const safeRequest = validateRequest(request);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > DEFAULT_TTL_MS)
    fail('BOSS_INTERNAL_AUTH_INVALID');
  const directory = authorizationDirectory(root);
  await ensurePrivateDirectory(directory);
  const token = randomBytes(32).toString('hex'),
    issued = now(),
    ticket = {
      format: FORMAT,
      version: VERSION,
      token,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + ttlMs).toISOString(),
      request: safeRequest,
    },
    path = join(directory, `${token}.json`);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(ticket)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
  return { token, expiresAt: ticket.expiresAt };
}

export async function consumeBossInternalAuthorization(
  root,
  token,
  request,
  { now = () => new Date() } = {},
) {
  if (!TOKEN.test(token || '')) fail('BOSS_INTERNAL_AUTH_REQUIRED');
  const expected = validateRequest(request),
    directory = authorizationDirectory(root),
    source = join(directory, `${token}.json`),
    claimed = join(directory, `.claimed-${token}-${randomUUID()}.json`);
  try {
    await rename(source, claimed);
  } catch (error) {
    if (error.code === 'ENOENT') fail('BOSS_INTERNAL_AUTH_REQUIRED');
    throw error;
  }
  try {
    await regularTicket(claimed);
    let ticket;
    try {
      ticket = validateTicket(JSON.parse(await readFile(claimed, 'utf8')), token);
    } catch (error) {
      if (error instanceof BossInternalAuthorizationError) throw error;
      fail('BOSS_INTERNAL_AUTH_INVALID');
    }
    if (now().getTime() >= Date.parse(ticket.expiresAt)) fail('BOSS_INTERNAL_AUTH_EXPIRED');
    if (JSON.stringify(ticket.request) !== JSON.stringify(expected))
      fail('BOSS_INTERNAL_AUTH_SCOPE_MISMATCH');
    return ticket;
  } finally {
    await unlink(claimed).catch(() => {});
    await syncDirectory(directory).catch(() => {});
  }
}

export async function revokeBossInternalAuthorization(root, token) {
  if (!TOKEN.test(token || '')) return;
  const directory = authorizationDirectory(root);
  await unlink(join(directory, `${token}.json`)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await syncDirectory(directory).catch(() => {});
}
