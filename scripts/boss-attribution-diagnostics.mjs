import { RESUME_KINDS, RESUME_SUMMARIES } from '../dist/resume-rules.js';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, link, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assessBossAttribution } from '../dist/boss-attribution.js';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stages = new Set(['checkpoint', 'snapshot', 'queue', 'consume']);

// First occurrence only. Neither raw identities nor text are written to diagnostic files.
export async function recordAttributionDiagnostic(root, accountNamespace, event, stage) {
  if (!stages.has(stage)) throw new Error('ATTRIBUTION_DIAGNOSTIC_STAGE_INVALID');
  const decision = event.messageId
    ? assessBossAttribution(accountNamespace, event)
    : { status: 'collection', reason: 'missing_message_identity' };
  if (decision.status === 'verified') return;
  const evidence = event.attribution;
  const identityDigest = digest([
    accountNamespace,
    event.conversationKey,
    event.messageId || event.eventId || '',
  ]);
  const evidenceDigest = digest(
    evidence
      ? Object.keys(evidence)
          .sort()
          .map((key) => [key, evidence[key]])
      : null,
  );
  const body = {
    version: 1,
    stage,
    identityDigest,
    evidenceDigest,
    observationType: RESUME_SUMMARIES.includes(event.summary)
      ? event.summary
      : RESUME_KINDS.includes(event.kind)
        ? event.kind
        : 'unknown',
    status: decision.status,
    reason: decision.reason,
    fields: Object.fromEntries(
      [
        'messageId',
        'requestedBossId',
        'responseFriendId',
        'responseFriendSource',
        'responseBossId',
        'selfId',
        'senderId',
        'recipientId',
        'messageJobId',
      ].map((key) => [key, Boolean(evidence?.[key])]),
    ),
  };
  const name = `${digest(body)}.json`,
    directory = join(root, 'attribution-diagnostics');
  const parent = await lstat(root);
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error('ATTRIBUTION_DIAGNOSTIC_PATH_INVALID');
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('ATTRIBUTION_DIAGNOSTIC_PATH_INVALID');
  await chmod(directory, 0o700);
  const path = join(directory, name);
  const validateExisting = async () => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('ATTRIBUTION_DIAGNOSTIC_FILE_INVALID');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    const { recordedAt, ...content } = saved;
    if (digest(content) !== digest(body) || !Number.isFinite(Date.parse(recordedAt)))
      throw new Error('ATTRIBUTION_DIAGNOSTIC_FILE_INVALID');
    await chmod(path, 0o600);
  };
  let exists = false;
  try {
    await validateExisting();
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!exists) {
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({ ...body, recordedAt: new Date().toISOString() }) + '\n',
      );
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await link(temporary, path);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await validateExisting();
      }
    } finally {
      if (handle) await handle.close();
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  const parentBarrier = await open(root, 'r');
  try {
    await parentBarrier.sync();
  } finally {
    await parentBarrier.close();
  }
  const barrier = await open(directory, 'r');
  try {
    await barrier.sync();
  } finally {
    await barrier.close();
  }
}

export async function recordCollectorDiagnostics(
  directory,
  observations,
  { accountNamespace = null, stage = 'snapshot', associations = [], unresolved = [] } = {},
) {
  for (const item of unresolved) {
    if (
      ['RESUME_STATUS_IDENTITY_INCOMPLETE', 'RESUME_MESSAGE_IDENTITY_INCOMPLETE'].includes(
        item.reason,
      )
    )
      await recordAttributionDiagnostic(
        directory,
        accountNamespace,
        { conversationKey: item.conversationKey, messageId: '', eventId: item.reason },
        stage,
      );
  }
  for (const observation of observations || []) {
    const candidate = associations.find(
      (item) => item.conversationKey === observation.conversationKey && item.status === 'current',
    );
    const event = {
      ...observation,
      friendId: observation.friendId ?? observation.platformIdentity?.friendId,
      friendSource: observation.friendSource ?? observation.platformIdentity?.friendSource,
      externalJobId: candidate?.jobId || observation.externalJobId || '',
      attribution: observation.attribution ?? null,
    };
    await recordAttributionDiagnostic(directory, accountNamespace, event, stage);
  }
}
