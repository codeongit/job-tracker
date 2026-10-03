import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildIdentitySample } from '../collector/boss/identity-sample.mjs';
import { saveBossIdentitySample } from '../scripts/boss-identity-sample.mjs';

const conversationKey = 'a'.repeat(64);
const privateId = 'synthetic-private-id-991122';
const privateJob = 'synthetic-private-job-554433';
const privateText = 'SYNTHETIC_PRIVATE_CHAT_BODY';
const sampleDirectory = (root) => join(root, 'attribution-diagnostics', 'identity-check');
const friendSample = () =>
  buildIdentitySample({
    stage: 'friend',
    target: { friendId: privateId, friendSource: 0 },
    account: { pageUid: 'synthetic-self', storeUserId: 'synthetic-self' },
    list: { friendId: privateId, encryptJobId: privateJob },
    identity: { bossId: privateId },
    response: {
      ok: true,
      value: {
        code: 0,
        zpData: { result: [{ uid: privateId, friendId: privateId, body: privateText }] },
      },
    },
  });
const options = (sample = friendSample()) => ({
  conversationKey,
  stage: sample.stage,
  page: sample.page,
  sample,
});
async function withRoot(run) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'boss-identity-sample-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function fixedError(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('identity samples persist only approved evidence with private permissions', async () => {
  await withRoot(async (root) => {
    const sample = friendSample();
    const name = await saveBossIdentitySample(root, options(sample));
    assert.match(name, /^[a-f\d-]{36}\.json$/);
    const content = await readFile(join(sampleDirectory(root), name), 'utf8');
    const saved = JSON.parse(content);
    assert.deepEqual(Object.keys(saved), ['capturedAt', 'conversationKey', 'sample', 'previous']);
    assert.ok(Number.isFinite(Date.parse(saved.capturedAt)));
    assert.equal(saved.conversationKey, conversationKey);
    assert.equal(saved.previous, null);
    assert.deepEqual(saved.sample, sample);
    for (const secret of [privateId, privateJob, privateText]) assert.ok(!content.includes(secret));
    for (const path of [root, join(root, 'attribution-diagnostics'), sampleDirectory(root)])
      assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(sampleDirectory(root), name))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(sampleDirectory(root)), [name]);
  });
});

test('new samples preserve earlier files and history can refer to its friend sample', async () => {
  await withRoot(async (root) => {
    const name = await saveBossIdentitySample(root, options());
    const original = await readFile(join(sampleDirectory(root), name), 'utf8');
    const next = await saveBossIdentitySample(root, options());
    assert.notEqual(next, name);
    const sample = buildIdentitySample({
      stage: 'history',
      page: 1,
      target: { friendId: privateId, friendSource: 0 },
      identity: { bossId: privateId },
      response: { ok: true, value: { code: 0, zpData: { messages: [] } } },
    });
    const history = await saveBossIdentitySample(root, { ...options(sample), previous: name });
    assert.equal(JSON.parse(await readFile(join(sampleDirectory(root), history))).previous, name);
    assert.equal(await readFile(join(sampleDirectory(root), name), 'utf8'), original);
    assert.equal((await readdir(sampleDirectory(root))).length, 3);
  });
});

test('full history samples accept both message arrays within the fixed bound', async () => {
  await withRoot(async (root) => {
    const messages = Array.from({ length: 21 }, (_, index) => ({
      mid: `synthetic-message-${index}`,
      from: { uid: privateId },
      to: { uid: 'synthetic-self' },
      body: { job: { jobId: privateJob }, text: privateText },
    }));
    const sample = buildIdentitySample({
      stage: 'history',
      page: 20,
      response: { ok: true, value: { code: 0, zpData: { messages, historyMsgList: messages } } },
    });
    assert.equal(sample.fields.length, 571);
    const name = await saveBossIdentitySample(root, options(sample));
    const saved = JSON.parse(await readFile(join(sampleDirectory(root), name)));
    assert.deepEqual(
      saved.sample.arrays.map((item) => [item.count, item.sampled]),
      [
        [21, 20],
        [21, 20],
      ],
    );
  });
});

test('unknown keys, paths and unredacted values fail before creating directories', async () => {
  await withRoot(async (root) => {
    const mutations = [
      (value) => {
        value.sample.raw = privateText;
      },
      (value) => {
        value.raw = privateText;
      },
      (value) => {
        value.sample.fields[0].value = privateId;
      },
      (value) => {
        value.sample.fields[0].path = `body.${privateText}`;
      },
      (value) => {
        value.sample.fields[0].identity = privateId;
      },
      (value) => {
        value.sample.fields[0].identity = 'identity-992';
      },
      (value) => {
        value.sample.arrays[0].path = 'response.raw';
      },
      (value) => {
        value.sample.arrays[0].raw = privateText;
      },
      (value) => {
        value.sample.fields[0].state = privateText;
      },
      (value) => {
        value.sample.fields[0].type = privateText;
      },
      (value) => {
        value.sample.result = privateText;
      },
      (value) => {
        value.sample.version = 2;
      },
      (value) => {
        value.conversationKey = privateId;
      },
      (value) => {
        value.previous = '../private.json';
      },
    ];
    for (const mutate of mutations) {
      const value = options();
      mutate(value);
      await assert.rejects(
        saveBossIdentitySample(root, value),
        fixedError('BOSS_IDENTITY_SAMPLE_INVALID'),
      );
    }
    assert.deepEqual(await readdir(root), []);
  });
});

test('inconsistent stage, page, identity states and array ranges are rejected', async () => {
  await withRoot(async (root) => {
    const mutations = [
      (value) => {
        value.stage = 'history';
        value.page = 1;
      },
      (value) => {
        value.page = 1;
        value.sample.page = 1;
      },
      (value) => {
        value.sample.fields[0].state = 'missing';
        value.sample.fields[0].type = 'missing';
      },
      (value) => {
        value.sample.fields[0].type = 'object';
      },
      (value) => {
        value.sample.fields.push({ ...value.sample.fields[0] });
      },
      (value) => {
        value.sample.arrays[0].sampled = 2;
      },
      (value) => {
        value.sample.arrays[0].count = -1;
      },
      (value) => {
        value.sample.arrays = [];
      },
      (value) => {
        value.sample.fields.push({
          path: 'response.zpData.result[19].uid',
          type: 'missing',
          state: 'missing',
          identity: null,
        });
      },
    ];
    for (const mutate of mutations) {
      const value = options();
      mutate(value);
      await assert.rejects(
        saveBossIdentitySample(root, value),
        fixedError('BOSS_IDENTITY_SAMPLE_INVALID'),
      );
    }
    assert.deepEqual(await readdir(root), []);
  });
});

test('non-data properties cannot execute or serialize private content', async () => {
  await withRoot(async (root) => {
    for (const target of ['options', 'sample', 'field', 'array']) {
      const value = options();
      const object =
        target === 'options'
          ? value
          : target === 'sample'
            ? value.sample
            : target === 'field'
              ? value.sample.fields[0]
              : value.sample.fields;
      const key = target === 'array' ? '0' : Object.keys(object)[0];
      Object.defineProperty(object, key, {
        get() {
          throw new Error(privateText);
        },
        enumerable: true,
      });
      await assert.rejects(
        saveBossIdentitySample(root, value),
        fixedError('BOSS_IDENTITY_SAMPLE_INVALID'),
      );
    }
    const modifiedArray = options();
    Object.setPrototypeOf(modifiedArray.sample.fields, {
      ...Array.prototype,
      toJSON: () => privateText,
    });
    await assert.rejects(
      saveBossIdentitySample(root, modifiedArray),
      fixedError('BOSS_IDENTITY_SAMPLE_INVALID'),
    );
    const value = options();
    value.sample.toJSON = () => privateText;
    await assert.rejects(
      saveBossIdentitySample(root, value),
      fixedError('BOSS_IDENTITY_SAMPLE_INVALID'),
    );
    assert.deepEqual(await readdir(root), []);
  });
});

test('root, ancestors and either diagnostic subdirectory cannot be symbolic links', async () => {
  for (const location of ['root', 'ancestor', 'attribution-diagnostics', 'identity-check']) {
    await withRoot(async (temporary) => {
      const account = join(temporary, 'account');
      const outside = join(temporary, 'outside');
      await mkdir(outside);
      let root = account;
      if (location === 'root') await symlink(outside, account);
      else if (location === 'ancestor') {
        await mkdir(join(outside, 'account'));
        await symlink(outside, join(temporary, 'link'));
        root = join(temporary, 'link', 'account');
      } else {
        await mkdir(account);
        if (location === 'attribution-diagnostics')
          await symlink(outside, join(account, 'attribution-diagnostics'));
        else {
          await mkdir(join(account, 'attribution-diagnostics'));
          await symlink(outside, sampleDirectory(account));
        }
      }
      await assert.rejects(
        saveBossIdentitySample(root, options()),
        fixedError('BOSS_IDENTITY_SAMPLE_SAVE_FAILED'),
      );
      assert.deepEqual(await readdir(outside), location === 'ancestor' ? ['account'] : []);
    });
  }
});

test('filesystem errors are sanitized and existing material stays intact', async () => {
  await withRoot(async (root) => {
    const path = join(root, 'attribution-diagnostics');
    await writeFile(path, privateText);
    await assert.rejects(
      saveBossIdentitySample(root, options()),
      fixedError('BOSS_IDENTITY_SAMPLE_SAVE_FAILED'),
    );
    assert.equal(await readFile(path, 'utf8'), privateText);
    await assert.rejects(
      saveBossIdentitySample(join(root, privateId), options()),
      fixedError('BOSS_IDENTITY_SAMPLE_SAVE_FAILED'),
    );
  });
});

test('a previous sample reference must exist and cannot follow a symbolic link', async () => {
  await withRoot(async (root) => {
    const name = await saveBossIdentitySample(root, options());
    const sample = buildIdentitySample({ stage: 'history', page: 1 });
    const previous = '12345678-1234-4123-8123-123456789abc.json';
    await assert.rejects(
      saveBossIdentitySample(root, { ...options(sample), previous }),
      fixedError('BOSS_IDENTITY_SAMPLE_SAVE_FAILED'),
    );
    await symlink(join(sampleDirectory(root), name), join(sampleDirectory(root), previous));
    await assert.rejects(
      saveBossIdentitySample(root, { ...options(sample), previous }),
      fixedError('BOSS_IDENTITY_SAMPLE_SAVE_FAILED'),
    );
    assert.equal((await readdir(sampleDirectory(root))).length, 2);
  });
});
