import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';

// Uses the project's devDependency. NODE_PATH can point at an existing Playwright
// installation when running this file before it is copied into test/.
const { chromium } = createRequire(import.meta.url)('playwright');
const appRoot = process.env.JOB_TRACKER_APP_ROOT || fileURLToPath(new URL('../', import.meta.url));
const publicRoot = resolve(appRoot, 'dist');
const config = { owner: 'example', repo: 'browser-regression', path: 'fixtures/data.json' };
const fakeToken = 'browser-regression-fake-token';
const clone = (value) => structuredClone(value);
const emptyData = () => ({
  schemaVersion: 1,
  opportunities: [],
  activities: [],
  tasks: [],
  imports: [],
});
const fixtureData = () => ({
  ...emptyData(),
  opportunities: [
    {
      id: 'e2e-shanghai',
      company: '上海示例科技',
      role: '后端工程师',
      stage: '已触达',
      notes: '原始备注',
    },
    {
      id: 'e2e-beijing',
      company: '北京示例科技',
      role: '产品经理',
      stage: '沟通中',
      notes: '原始备注',
    },
  ],
});
const fixtureState = (data = fixtureData(), base = data) => ({
  data: clone(data),
  base: clone(base),
  config: clone(config),
  generation: 0,
  lastSync: '',
  pending: null,
});
const deferred = () => {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};
let browser, server, origin;

before(
  async () => {
    // Serve dist only. The application server intentionally is not imported:
    // scripts/serve.mjs reads .local/config.json and may enable the user's SSH bridge.
    server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        if (!['GET', 'HEAD'].includes(req.method)) {
          res.writeHead(405).end();
          return;
        }
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (
          pathname.startsWith('/__local/') ||
          pathname.split('/').some((part) => part.startsWith('.'))
        ) {
          res.writeHead(404).end();
          return;
        }
        const path = resolve(publicRoot, pathname === '/' ? 'index.html' : '.' + pathname);
        if (!path.startsWith(publicRoot + sep)) {
          res.writeHead(403).end();
          return;
        }
        const types = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
        };
        if (!types[extname(path)]) {
          res.writeHead(404).end();
          return;
        }
        const content = await readFile(path);
        res.writeHead(200, { 'Content-Type': types[extname(path)] + '; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : content);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    // launch() creates its own temporary profile; never connect to a running browser
    // or pass the user's Chrome user-data directory.
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    });
  },
  { timeout: 30000 },
);

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise((resolveClose) => server.close(resolveClose));
});

function githubMock(initialRemote, { readGate, readStarted } = {}) {
  const state = { remote: clone(initialRemote), sha: 'fixture-sha-1', writes: [], reads: 0 };
  const prefix = `/repos/${config.owner}/${config.repo}`;
  state.respond = async (request) => {
    const url = new URL(request.url()),
      method = request.method();
    if (method === 'OPTIONS') return { status: 204, body: '' };
    assert.equal(request.headers().authorization, `Bearer ${fakeToken}`);
    if (method === 'GET' && url.pathname === prefix)
      return { json: { private: true, default_branch: 'main' } };
    if (method === 'GET' && url.pathname === prefix + '/branches/main')
      return { json: { name: 'main' } };
    assert.equal(url.pathname, prefix + '/contents/' + config.path);
    if (method === 'GET') {
      assert.equal(url.searchParams.get('ref'), 'main');
      state.reads++;
      readStarted?.resolve();
      await readGate?.promise;
      const text = JSON.stringify(state.remote);
      return {
        json: {
          type: 'file',
          encoding: 'base64',
          sha: state.sha,
          size: Buffer.byteLength(text),
          content: Buffer.from(text).toString('base64'),
        },
      };
    }
    assert.equal(method, 'PUT');
    const payload = request.postDataJSON();
    assert.equal(payload.branch, 'main');
    assert.equal(payload.sha, state.sha);
    const uploaded = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8'));
    // The only accepted remote writes are captured in this in-memory fake.
    state.writes.push(clone(uploaded));
    state.remote = clone(uploaded);
    state.sha = `fixture-sha-${state.writes.length + 1}`;
    return {
      json: {
        content: { sha: state.sha },
        commit: { sha: `fixture-commit-${state.writes.length}` },
      },
    };
  };
  return state;
}

async function isolatedContext(t, api) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  context.setDefaultTimeout(10000);
  const failures = [];
  context.on('page', (page) => page.on('pageerror', (error) => failures.push(error.message)));
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin) {
      await route.continue();
      return;
    }
    try {
      assert.equal(url.origin, 'https://api.github.com', 'Unexpected external origin');
      assert.ok(api, 'This test must not request GitHub');
      const response = await api.respond(request);
      await route.fulfill({
        ...response,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
        },
      });
    } catch (error) {
      failures.push(error.message);
      await route.abort('blockedbyclient');
    }
  });
  t.after(async () => {
    await context.close();
    assert.deepEqual(failures, [], 'No page errors or unexpected external requests');
  });
  return context;
}

async function openPage(context) {
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() =>
    document.querySelector('#local-status')?.textContent.includes('本地已保存'),
  );
  return page;
}

async function seed(page, state = fixtureState()) {
  await page.evaluate(async (state) => {
    const { updateState } = await import('/storage.js');
    await updateState(() => state);
  }, state);
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('#local-status')?.textContent.includes('本地已保存'),
  );
}

async function savedState(page) {
  return page.evaluate(async () => (await import('/storage.js')).readState());
}

async function list(page) {
  await page.locator('nav [data-view="list"]').click();
  await page.locator('#search').waitFor();
}

async function configureToken(page) {
  await page.locator('[data-view="settings"]').click();
  await page.locator('#settings-form input[name="token"]').fill(fakeToken);
  await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForFunction(() =>
    document.querySelector('#notice')?.textContent.includes('连接设置已保存'),
  );
}

async function settleBrowserEvents(page) {
  await page.evaluate(
    () =>
      new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
      ),
  );
}

async function beginChineseInput(context, page, text = 'shang') {
  await page.locator('#search').focus();
  const input = await page.locator('#search').elementHandle();
  const cdp = await context.newCDPSession(page);
  // Chromium dispatches native composition/input events here. fill() alone would
  // bypass the IME lifecycle and could miss the original node-replacement bug.
  await cdp.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
  return { input, cdp };
}

async function commitChineseInput(cdp, text = '上海') {
  await cdp.send('Input.insertText', { text });
  await cdp.detach();
}

async function assertCurrentFocusedInput(input) {
  assert.equal(
    await input.evaluate(
      (element) =>
        element.isConnected &&
        element === document.querySelector('#search') &&
        element === document.activeElement,
    ),
    true,
    'The original search input remains connected and focused',
  );
}

test('中文组合输入保留搜索节点、焦点、选区和未保存草稿', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    page = await openPage(context);
  await seed(page);
  await list(page);
  const task = page.locator('#task-form input[name="text"]');
  const activity = page.locator('#activity-form textarea[name="text"]');
  await task.fill('询问下次面试时间');
  await activity.fill('尚未保存的中文沟通草稿');
  const taskNode = await task.elementHandle(),
    activityNode = await activity.elementHandle();
  const { input, cdp } = await beginChineseInput(context, page);
  await assertCurrentFocusedInput(input);
  assert.equal(
    await page.locator('#job-list-panel [data-job]').count(),
    2,
    'Do not filter temporary pinyin',
  );
  await cdp.send('Input.imeSetComposition', { text: '上海', selectionStart: 2, selectionEnd: 2 });
  await assertCurrentFocusedInput(input);
  assert.equal(await page.locator('#job-list-panel [data-job]').count(), 2);
  await commitChineseInput(cdp);
  await page.waitForFunction(
    () => document.querySelectorAll('#job-list-panel [data-job]').length === 1,
  );
  await settleBrowserEvents(page);
  await assertCurrentFocusedInput(input);
  assert.deepEqual(
    await input.evaluate((element) => [
      element.value,
      element.selectionStart,
      element.selectionEnd,
    ]),
    ['上海', 2, 2],
  );
  assert.match(await page.locator('#job-list-panel').innerText(), /上海示例科技/);
  assert.equal(
    await taskNode.evaluate(
      (element) => element.isConnected && element.value === '询问下次面试时间',
    ),
    true,
  );
  assert.equal(
    await activityNode.evaluate(
      (element) => element.isConnected && element.value === '尚未保存的中文沟通草稿',
    ),
    true,
  );
  await page.locator('#search').fill('');
  assert.equal(await page.locator('#job-list-panel [data-job]').count(), 2);
});

test('新增中文岗位实际保存到 IndexedDB，刷新后内容完整', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    page = await openPage(context);
  await seed(page, fixtureState(emptyData()));
  await page.locator('#new-button').click();
  await page.locator('#editor-form input[name="company"]').fill('回归测试有限公司');
  await page.locator('#editor-form input[name="role"]').fill('中文输入工程师');
  await page.locator('#editor-form textarea[name="notes"]').fill('第一行中文\n第二行：已沟通 🚀');
  await page.locator('#editor-form button[type="submit"]').click();
  await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
  const beforeReload = await savedState(page);
  assert.equal(beforeReload.data.opportunities.length, 1);
  assert.equal(beforeReload.generation, 1);
  await page.reload();
  await list(page);
  assert.match(await page.locator('#job-list-panel').innerText(), /回归测试有限公司/);
  const afterReload = await savedState(page);
  assert.deepEqual(afterReload, beforeReload);
  assert.equal(afterReload.data.opportunities[0].role, '中文输入工程师');
  assert.equal(afterReload.data.opportunities[0].notes, '第一行中文\n第二行：已沟通 🚀');
});

test('两个标签页共享保存并通知刷新，另一标签页编辑草稿保持', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    first = await openPage(context);
  await seed(first);
  const second = await openPage(context);
  await list(first);
  await list(second);
  await first.locator('[data-action="edit"][data-id="e2e-shanghai"]').click();
  await first.locator('#editor-form textarea[name="notes"]').fill('标签页 A 保存的备注');
  await second.locator('[data-job="e2e-beijing"]').click();
  await second.locator('[data-action="edit"][data-id="e2e-beijing"]').click();
  await second.locator('#editor-form textarea[name="notes"]').fill('标签页 B 的中文草稿');
  const draft = await second.locator('#editor-form textarea[name="notes"]').elementHandle();
  // A read-only observer makes message delivery deterministic without adding a
  // production test hook. Both pages still use the real shared IndexedDB.
  await second.evaluate(() => {
    window.__regressionBroadcast = new BroadcastChannel('job-tracker-updates');
    window.__regressionBroadcastCount = 0;
    window.__regressionBroadcast.onmessage = () => window.__regressionBroadcastCount++;
  });
  await first.locator('#editor-form button[type="submit"]').click();
  await first.locator('#editor-dialog').waitFor({ state: 'hidden' });
  await second.waitForFunction(() => window.__regressionBroadcastCount > 0);
  await settleBrowserEvents(second);
  assert.equal(
    await draft.evaluate(
      (element) => element.isConnected && element.value === '标签页 B 的中文草稿',
    ),
    true,
  );
  await second.locator('#editor-form button[type="submit"]').click();
  await second.locator('#editor-dialog').waitFor({ state: 'hidden' });
  const state = await savedState(second);
  assert.equal(
    state.data.opportunities.find((job) => job.id === 'e2e-shanghai').notes,
    '标签页 A 保存的备注',
  );
  assert.equal(
    state.data.opportunities.find((job) => job.id === 'e2e-beijing').notes,
    '标签页 B 的中文草稿',
  );
  assert.equal(state.generation, 2);
  // A non-editing tab should visibly update from the application's own channel.
  await first.locator('#page-title').click();
  await second.locator('#new-button').click();
  await second.locator('#editor-form input[name="company"]').fill('跨标签页新增示例');
  await second.locator('#editor-form input[name="role"]').fill('测试工程师');
  await second.locator('#editor-form button[type="submit"]').click();
  await second.locator('#editor-dialog').waitFor({ state: 'hidden' });
  await first.waitForFunction(() =>
    document.querySelector('#job-list-panel')?.textContent.includes('跨标签页新增示例'),
  );
  assert.deepEqual((await savedState(first)).data, (await savedState(second)).data);
});

test('同步在组合输入期间完成时保留输入，选字后恢复结果和草稿', { timeout: 45000 }, async (t) => {
  const remote = fixtureData();
  remote.opportunities[1].notes = '同步带来的合成更新';
  const readGate = deferred(),
    readStarted = deferred();
  const api = githubMock(remote, { readGate, readStarted });
  const context = await isolatedContext(t, api),
    page = await openPage(context);
  t.after(() => readGate.resolve());
  await seed(page);
  await configureToken(page);
  await list(page);
  await page.locator('#task-form input[name="text"]').fill('同步期间保留的草稿');
  await page.locator('#sync-button').click();
  await readStarted.promise;
  const { input, cdp } = await beginChineseInput(context, page);
  readGate.resolve();
  await page.waitForFunction(
    async () => !!(await (await import('/storage.js')).readState()).lastSync,
  );
  await settleBrowserEvents(page);
  await assertCurrentFocusedInput(input);
  assert.equal(await input.inputValue(), 'shang');
  await commitChineseInput(cdp);
  await page.waitForFunction(() => document.querySelector('#sync-state')?.textContent === '已同步');
  assert.equal(await page.locator('#search').inputValue(), '上海');
  assert.deepEqual(
    await page
      .locator('#search')
      .evaluate((element) => [
        document.activeElement === element,
        element.selectionStart,
        element.selectionEnd,
      ]),
    [true, 2, 2],
  );
  assert.equal(await page.locator('#job-list-panel [data-job]').count(), 1);
  assert.equal(
    await page.locator('#task-form input[name="text"]').inputValue(),
    '同步期间保留的草稿',
  );
  assert.equal(
    (await savedState(page)).data.opportunities.find((job) => job.id === 'e2e-beijing').notes,
    '同步带来的合成更新',
  );
  assert.equal(api.writes.length, 0);
});

test('合成云端冲突先保留两版，选择后再次同步才写入假服务', { timeout: 45000 }, async (t) => {
  const base = fixtureData(),
    local = clone(base),
    remote = clone(base);
  local.opportunities[0].notes = '本机中文修改';
  remote.opportunities[0].notes = '云端中文修改';
  const api = githubMock(remote),
    context = await isolatedContext(t, api),
    page = await openPage(context);
  const initial = fixtureState(local, base);
  initial.generation = 1;
  await seed(page, initial);
  await configureToken(page);
  await page.locator('#sync-button').click();
  await page.locator('#conflict-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#conflict-form').innerText(), /本机中文修改/);
  assert.match(await page.locator('#conflict-form').innerText(), /云端中文修改/);
  assert.equal(api.writes.length, 0, 'Unresolved conflicts must not upload');
  const pending = await savedState(page);
  assert.equal(pending.pending.conflicts.length, 1);
  assert.deepEqual(pending.base, base);
  await page.locator('#conflict-form input[value="local"]').check();
  await page.locator('#conflict-form button[type="submit"]').click();
  await page.locator('#conflict-dialog').waitFor({ state: 'hidden' });
  const resolved = await savedState(page);
  assert.equal(resolved.pending, null);
  assert.equal(
    resolved.data.opportunities.find((job) => job.id === 'e2e-shanghai').notes,
    '本机中文修改',
  );
  assert.deepEqual(resolved.base, remote);
  assert.equal(api.writes.length, 0, 'Choosing a version only saves locally');
  await page.locator('#sync-button').click();
  await page.waitForFunction(() => document.querySelector('#sync-state')?.textContent === '已同步');
  assert.equal(api.writes.length, 1);
  assert.equal(
    api.remote.opportunities.find((job) => job.id === 'e2e-shanghai').notes,
    '本机中文修改',
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#sync-state')?.textContent === '已同步');
  const persisted = await savedState(page);
  assert.equal(persisted.pending, null);
  assert.deepEqual(persisted.data, persisted.base);
  assert.equal(
    JSON.stringify(persisted).includes(fakeToken),
    false,
    'The session token is never persisted',
  );
});

test('工作区升级先保留原始快照；快照写入失败时恢复事务整体回滚', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    page = await context.newPage();
  await page.goto(origin + '/styles.css');
  await page.evaluate(
    (state) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('job-tracker-v1', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('workspace');
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction('workspace', 'readwrite');
          tx.objectStore('workspace').put(state, 'state');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    fixtureState(),
  );
  await page.goto(origin);
  await page.locator('#app-version').waitFor();
  const result = await page.evaluate(async () => {
    const storage = await import('/storage.js');
    const before = await storage.readState(),
      snaps = await storage.listSnapshots();
    const add = IDBObjectStore.prototype.add;
    let error = '';
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'snapshots') throw new DOMException('合成配额失败', 'QuotaExceededError');
      return add.apply(this, args);
    };
    try {
      await storage.restoreBackup(
        { schemaVersion: 1, opportunities: [], activities: [], tasks: [], imports: [] },
        'snapshot',
      );
    } catch (e) {
      error = e.message;
    } finally {
      IDBObjectStore.prototype.add = add;
    }
    return { before, after: await storage.readState(), snaps, error };
  });
  assert.equal(result.before.workspaceVersion, 2);
  assert.equal(result.snaps.length, 1);
  assert.equal(result.snaps[0].workspace.workspaceVersion, undefined);
  assert.match(result.error, /配额/);
  assert.deepEqual(result.after, result.before);
});

test('删除后通过快照恢复并再次同步，自动备份和远端状态都正确', { timeout: 45000 }, async (t) => {
  const api = githubMock(fixtureData()),
    context = await isolatedContext(t, api),
    page = await openPage(context);
  await seed(page);
  await list(page);
  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('[data-action="edit"]').click();
  await page.locator('[data-delete]').click();
  await page.waitForFunction(() =>
    document.querySelector('#notice')?.textContent.includes('岗位已删除'),
  );
  await configureToken(page);
  await page.locator('[data-action="snapshots"]').click();
  await page.locator('[data-snapshot-restore]').first().click();
  await page.locator('#restore-snapshot').click();
  await page.waitForFunction(() =>
    document.querySelector('#notice')?.textContent.includes('备份已恢复'),
  );
  assert.equal((await savedState(page)).data.opportunities.filter((o) => !o.deletedAt).length, 2);
  await page.locator('#sync-button').click();
  await page.waitForFunction(() => document.querySelector('#sync-state')?.textContent === '已同步');
  assert.equal(api.remote.opportunities.filter((o) => !o.deletedAt).length, 2);
  const reasons = await page.evaluate(async () =>
    (await (await import('/storage.js')).listSnapshots()).map((s) => s.reason),
  );
  assert.ok(reasons.includes('删除岗位前'));
  assert.ok(reasons.includes('恢复备份前'));
});

test('含父岗位删除和新增任务的待解决冲突，刷新后仍能处理', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    page = await openPage(context);
  const state = fixtureState();
  const parent = state.data.opportunities[0];
  parent.deletedAt = '2026-09-11';
  state.data.tasks.push({
    id: 'orphan-task',
    opportunityId: parent.id,
    text: '合成待处理任务',
    status: '待办',
  });
  state.pending = {
    generation: 0,
    data: clone(state.data),
    conflicts: [
      {
        key: 'opportunities:' + parent.id,
        group: 'opportunities',
        id: parent.id,
        base: clone(state.base.opportunities[0]),
        local: clone(parent),
        remote: clone(state.base.opportunities[0]),
        relational: true,
      },
    ],
  };
  await seed(page, state);
  await page.locator('#sync-button').click();
  await page.locator('#conflict-dialog[open]').waitFor();
  assert.equal(await page.locator('input[type="radio"][value="remote"]').count(), 1);
});

test('未知工作区字段阻止启动时仍可导出完整原始状态', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    page = await openPage(context);
  const raw = { ...fixtureState(), workspaceVersion: 3, futureField: '合成未来内容' };
  await page.evaluate(
    (raw) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('job-tracker-v1');
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction('workspace', 'readwrite');
          tx.objectStore('workspace').put(raw, 'state');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    raw,
  );
  await page.reload();
  const waiting = page.waitForEvent('download');
  await page.locator('[data-action="raw-backup"]').click();
  const download = await waiting,
    content = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.deepEqual(content.workspace, raw);
});
