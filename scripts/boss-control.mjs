import { main as legacyMain } from './boss-integration.mjs';
import { serviceStatus } from './service-control.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNTIME_COMMANDS = new Set([
  'start',
  'run',
  'check',
  'backfill',
  'pause',
  'resume',
  'resume-details',
  'stop',
  'recover-page',
  'recover-saved',
  'status',
  'doctor',
]);
const LEGACY_COMMANDS = new Set(['preview', 'enqueue', 'enqueue-yesterday', 'enqueue-resume']);

async function runtimeRequest(action, fetcher = fetch) {
  const service = await serviceStatus(undefined, fetcher);
  if (!service.running) throw Object.assign(new Error(service.code), { code: service.code });
  const origin = `http://127.0.0.1:${service.port}`,
    sessionResponse = await fetcher(`${origin}/__local/session`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    }),
    session = await sessionResponse.json();
  if (
    !sessionResponse.ok ||
    session.instanceId !== service.instanceId ||
    !/^[a-f0-9]{64}$/.test(session.session || '')
  )
    throw Object.assign(new Error('SERVICE_OWNERSHIP_MISMATCH'), {
      code: 'SERVICE_OWNERSHIP_MISMATCH',
    });
  const readOnly = action === 'status' || action === 'doctor',
    response = await fetcher(
      `${origin}/__local/boss-runtime${action === 'doctor' ? '?view=doctor' : ''}`,
      {
        method: readOnly ? 'GET' : 'POST',
        cache: 'no-store',
        headers: {
          'X-Job-Tracker-Session': session.session,
          'X-Job-Tracker-Protocol': '1',
          ...(readOnly ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
        },
        body: readOnly
          ? undefined
          : JSON.stringify({ action: action === 'check' ? 'run' : action }),
        signal: AbortSignal.timeout(
          ['run', 'check', 'backfill', 'recover-saved'].includes(action) ? 25 * 60_000 : 30_000,
        ),
      },
    );
  let result;
  try {
    result = await response.json();
  } catch {
    throw Object.assign(new Error('BOSS_RUNTIME_RESPONSE_INVALID'), {
      code: 'BOSS_RUNTIME_RESPONSE_INVALID',
    });
  }
  if (!response.ok)
    throw Object.assign(new Error(result.code || 'BOSS_RUNTIME_FAILED'), {
      code: result.code || 'BOSS_RUNTIME_FAILED',
    });
  return result;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const command = argv[0];
  if (LEGACY_COMMANDS.has(command)) return legacyMain(argv, options.legacyOptions);
  if (argv.length !== 1 || !RUNTIME_COMMANDS.has(command))
    throw Object.assign(new Error('BOSS_ARGUMENTS_INVALID'), { code: 'BOSS_ARGUMENTS_INVALID' });
  const result = await runtimeRequest(command, options.fetcher);
  process.stdout.write(`${JSON.stringify({ ok: true, command, ...result }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code) ? error.code : 'BOSS_CONTROL_FAILED';
    process.stdout.write(`${JSON.stringify({ ok: false, error: code }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
