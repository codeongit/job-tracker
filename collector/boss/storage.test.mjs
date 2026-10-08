import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  latest,
  lock,
  commit,
  loadConnection,
  saveConnection,
  removeConnection,
} from './storage.mjs';

test('private immutable commits, contention, and no partial state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-tracker-test-'));
  try {
    assert.equal(await latest(directory), null);
    const release = await lock(directory);
    await assert.rejects(lock(directory), /CAPTURE_ALREADY_LOCKED/);
    const envelope = {
      version: 1,
      state: { records: [] },
      snapshot: { capturedAt: 'test' },
      report: { mode: 'baseline' },
    };
    const first = await commit(directory, envelope);
    assert.equal((await stat(first)).mode & 0o777, 0o600);
    assert.equal((await latest(directory)).path, first);
    await release();
    const releaseAgain = await lock(directory);
    const second = await commit(directory, envelope);
    assert.notEqual(second, first);
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.json')).length, 2);
    await releaseAgain();
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('connection metadata is private, replaceable, validated, and removable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-tracker-connection-'));
  const connection = {
    version: 1,
    kind: 'owned_background',
    session: 'boss-tracker-owned-' + 'a'.repeat(16),
    nativeTabId: '12',
    nativeWindowId: '34',
    page: 'page-12',
    accountNamespace: 'boss-geek:' + 'a'.repeat(64),
    connectedAt: '2026-09-18T10:00:00.000Z',
  };
  try {
    assert.equal(await loadConnection(directory), null);
    const path = await saveConnection(directory, connection);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await loadConnection(directory)).connection, connection);
    await saveConnection(directory, { ...connection, page: 'page-13' });
    assert.equal((await loadConnection(directory)).connection.page, 'page-13');
    await assert.rejects(
      saveConnection(directory, { ...connection, kind: 'borrowed' }),
      /SAVED_CONNECTION_INVALID/,
    );
    await assert.rejects(
      saveConnection(directory, { ...connection, session: 'boss-tracker-main' }),
      /SAVED_CONNECTION_INVALID/,
    );
    await assert.rejects(
      saveConnection(directory, { ...connection, cookie: 'must-not-persist' }),
      /SAVED_CONNECTION_INVALID/,
    );
    await assert.rejects(
      saveConnection(directory, { ...connection, accountNamespace: 'raw-account-id' }),
      /SAVED_CONNECTION_INVALID/,
    );
    assert.equal(await removeConnection(directory), true);
    assert.equal(await removeConnection(directory), false);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('version-2 CDP binding persists browser instance and exact target identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-tracker-connection-v2-'));
  const connection = {
    version: 2,
    kind: 'cdp_bound',
    session: 'boss-tracker-cdp-' + 'b'.repeat(16),
    browserPort: '19001',
    browserProfile: 'boss-tracker-profile-' + 'b'.repeat(16),
    browserInstanceId: 'c'.repeat(64),
    taskTargetId: 'ABC123',
    taskTargetCreatedByTask: true,
    page: 'https://www.zhipin.com/web/geek/chat',
    accountNamespace: 'boss-geek:' + 'd'.repeat(64),
    connectedAt: '2026-09-21T10:00:00.000Z',
  };
  try {
    await saveConnection(directory, connection);
    assert.deepEqual((await loadConnection(directory)).connection, connection);
    await assert.rejects(
      saveConnection(directory, { ...connection, taskTargetId: 'bad target' }),
      /SAVED_CONNECTION_INVALID/,
    );
    await assert.rejects(
      saveConnection(directory, { ...connection, browserInstanceId: 'raw-websocket' }),
      /SAVED_CONNECTION_INVALID/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('latest accepts version 2 through 5 envelopes while keeping version 1 compatibility', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boss-tracker-v2-'));
  try {
    const path = await commit(directory, {
      version: 2,
      state: { records: [] },
      snapshot: { capturedAt: 'test' },
      report: { mode: 'baseline' },
      jobs: {},
    });
    assert.equal((await latest(directory)).path, path);
    assert.equal((await latest(directory)).envelope.version, 2);
    const v3 = await commit(directory, {
      version: 3,
      state: { records: [] },
      snapshot: { capturedAt: 'test' },
      report: { mode: 'baseline' },
      jobs: {},
    });
    assert.equal((await latest(directory)).path, v3);
    assert.equal((await latest(directory)).envelope.version, 3);
    for (const version of [4, 5]) {
      const path = await commit(directory, {
        version,
        state: { records: [] },
        snapshot: { capturedAt: 'test' },
        report: { mode: 'baseline' },
        jobs: {},
      });
      assert.equal((await latest(directory)).path, path);
      assert.equal((await latest(directory)).envelope.version, version);
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});
