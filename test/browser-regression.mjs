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

async function isolatedContext(t, api, contextOptions = {}) {
  const context = await browser.newContext({ ...contextOptions, serviceWorkers: 'block' });
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

async function savedDrafts(page) {
  return page.evaluate(async () => new (await import('/drafts.js')).DraftStore().list());
}

async function resumeDraft(page, matches) {
  const draft = (await savedDrafts(page)).find(matches);
  assert.ok(draft, 'The requested unsubmitted draft is still available');
  await page.locator('#draft-button').click();
  await page.locator(`[data-draft-restore="${draft.id}"]`).click();
}

async function list(page) {
  await page.locator('nav [data-view="list"]').click();
  await page.locator('#search').waitFor();
}

async function openJob(page, id, sections = []) {
  if (page.viewportSize()?.width <= 760 && (await page.locator('.detail-panel').count()))
    await closeDetail(page);
  await page.locator(`[data-job="${id}"]`).first().click();
  await page.locator('.detail-panel').waitFor();
  for (const section of sections) await openDetailSection(page, section);
}

async function openDetailSection(page, section) {
  const panel = page.locator(`[data-detail-section-panel="${section}"]`);
  if (!(await panel.evaluate((element) => element.open)))
    await page.locator(`[data-detail-section="${section}"]`).click();
}

async function closeDetail(page) {
  await page.locator('[data-close-detail]').click();
  await page.locator('.detail-panel').waitFor({ state: 'hidden' });
}

async function organize(page) {
  await page.locator('[data-action-tab="organize"]').click();
}

async function setJobDate(page, date) {
  await page.locator('#job-date').fill(date);
  await page.locator('#job-date').dispatchEvent('change');
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

test('今日行动列出未设下一步岗位，今日新增置顶且可原地安排', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    page = await openPage(context);
  const dates = await page.evaluate(async () => {
    const { today } = await import('/model.js');
    const current = new Date(),
      earlier = new Date(current);
    earlier.setDate(earlier.getDate() - 2);
    return {
      today: today(),
      createdToday: current.toISOString(),
      createdEarlier: earlier.toISOString(),
    };
  });
  const data = emptyData();
  data.opportunities.push(
    {
      id: 'today-new-job',
      company: '今日新增示例公司',
      role: '新岗位',
      stage: '已触达',
      createdAt: dates.createdToday,
    },
    {
      id: 'older-unplanned-job',
      company: '旧岗位示例公司',
      role: '旧岗位',
      stage: '沟通中',
      createdAt: dates.createdEarlier,
    },
    {
      id: 'job-with-task',
      company: '已有行动示例公司',
      role: '已有行动岗位',
      stage: '已触达',
      createdAt: dates.createdToday,
    },
    {
      id: 'job-with-suggestion',
      company: '待核实示例公司',
      role: '待核实岗位',
      stage: '沟通中',
      resumeState: '被索要',
      createdAt: dates.createdToday,
    },
    {
      id: 'ended-unplanned-job',
      company: '已结束示例公司',
      role: '已结束岗位',
      stage: '已结束',
      createdAt: dates.createdToday,
    },
  );
  data.tasks.push({
    id: 'existing-task',
    opportunityId: 'job-with-task',
    text: '已有待办行动',
    dueAt: dates.today,
    status: '待办',
  });
  await seed(page, fixtureState(data));

  assert.equal(await page.locator('.detail-panel').count(), 0);
  assert.match(await page.locator('[data-organize-new]').innerText(), /1/);
  await page.locator('[data-organize-new]').click();
  const planButtons = page.locator('[data-plan-job]');
  assert.equal(await planButtons.count(), 2);
  assert.deepEqual(
    await planButtons.evaluateAll((buttons) => buttons.map((button) => button.dataset.planJob)),
    ['today-new-job', 'older-unplanned-job'],
    'Today-created jobs are listed before older unplanned jobs',
  );
  assert.match(
    await page
      .locator('[data-plan-job="today-new-job"]')
      .evaluate((button) => button.closest('.action-row')?.innerText || ''),
    /今天新增/,
  );
  assert.doesNotMatch(
    await page
      .locator('[data-plan-job="older-unplanned-job"]')
      .evaluate((button) => button.closest('.action-row')?.innerText || ''),
    /今天新增/,
  );

  await page.locator('[data-plan-job="today-new-job"]').click();
  assert.equal(await page.locator('#page-title').innerText(), '行动');
  assert.equal(await page.locator('nav [data-view="today"]').getAttribute('aria-current'), 'page');
  assert.match(await page.locator('.detail-panel').innerText(), /今日新增示例公司/);
  assert.equal(
    await page
      .locator('#task-form input[name="text"]')
      .evaluate((input) => document.activeElement === input),
    true,
    'Planning from Today keeps the view open and focuses the new-task field',
  );
});

test('岗位按日期查询并合并当天记录，手机详情返回后保留日期', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t, undefined, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      timezoneId: 'Asia/Shanghai',
    }),
    page = await openPage(context);
  const dates = await page.evaluate(async () => {
    const { today } = await import('/model.js'),
      { addCalendarDays } = await import('/planning.js'),
      current = today();
    return {
      current,
      previous: addCalendarDays(current, -1),
      next: addCalendarDays(current, 1),
      empty: addCalendarDays(current, 2),
      completedAt: new Date(`${current}T13:00:00`).toISOString(),
      cancelledAt: new Date(`${current}T14:00:00`).toISOString(),
    };
  });
  const data = emptyData();
  data.opportunities.push(
    {
      id: 'daily-main-job',
      company: '每日记录示例公司',
      role: '后端工程师',
      stage: '沟通中',
      appliedAt: dates.current,
    },
    {
      id: 'daily-ended-job',
      company: '历史结束示例公司',
      role: '产品经理',
      stage: '已结束',
      endReason: '职位关闭',
      appliedAt: dates.next,
    },
  );
  data.tasks.push(
    {
      id: 'daily-pending',
      opportunityId: 'daily-main-job',
      text: '今天计划行动',
      dueAt: dates.current,
      status: '待办',
    },
    {
      id: 'daily-same-day',
      opportunityId: 'daily-main-job',
      text: '当天计划并完成',
      dueAt: dates.current,
      status: '完成',
      completedAt: dates.completedAt,
    },
    {
      id: 'daily-cross-day',
      opportunityId: 'daily-main-job',
      text: '跨日完成行动',
      dueAt: dates.previous,
      status: '完成',
      completedAt: dates.completedAt,
    },
    {
      id: 'daily-cancelled',
      opportunityId: 'daily-main-job',
      text: '当天取消行动',
      dueAt: dates.previous,
      status: '取消',
      completedAt: dates.cancelledAt,
    },
    {
      id: 'daily-future',
      opportunityId: 'daily-ended-job',
      text: '明天计划行动',
      dueAt: dates.next,
      status: '待办',
    },
  );
  data.activities.push(
    {
      id: 'daily-activity',
      opportunityId: 'daily-main-job',
      text: '今天收到回复',
      date: dates.current,
      type: '对方回复',
    },
    {
      id: 'daily-imported-first-contact',
      opportunityId: 'daily-main-job',
      text: '首次联系（原表投递日期）',
      date: dates.current,
      type: '首次联系',
    },
  );
  await seed(page, fixtureState(data));
  const initial = await savedState(page);

  assert.deepEqual(
    await page
      .locator('nav [data-view]')
      .evaluateAll((buttons) => buttons.map((b) => b.dataset.view)),
    ['today', 'list', 'settings'],
  );
  assert.equal(await page.locator('.detail-panel').count(), 0);
  await list(page);
  assert.equal(await page.locator('#page-title').innerText(), '岗位');
  assert.equal(await page.locator('#job-date').inputValue(), '');
  await page.locator('[data-job-date-today]').click();
  const results = page.locator('#job-results');
  assert.equal(await page.locator('#job-date').inputValue(), dates.current);
  for (const text of ['今天计划行动', '跨日完成行动', '当天取消行动', '今天收到回复'])
    assert.match(await results.innerText(), new RegExp(text));
  assert.equal(await results.getByText('首次联系（原表投递日期）', { exact: true }).count(), 0);
  assert.equal(await results.locator('[data-job="daily-main-job"]').count(), 1);
  assert.equal(await results.locator('[data-complete], [data-cancel-task]').count(), 0);
  assert.equal(await results.getByText('当天计划并完成', { exact: true }).count(), 1);

  await page.locator('[data-job-date-step="-1"]').click();
  assert.equal(await page.locator('#job-date').inputValue(), dates.previous);
  assert.match(await results.innerText(), /跨日完成行动/);
  await page.locator('[data-job-date-today]').click();
  assert.equal(await page.locator('#job-date').inputValue(), dates.current);
  await page.locator('[data-job-date-step="1"]').click();
  assert.equal(await page.locator('#job-date').inputValue(), dates.next);
  assert.match(await results.innerText(), /明天计划行动/);
  assert.match(await results.innerText(), /已结束/);
  assert.equal(await results.locator('[data-job="daily-ended-job"]').count(), 1);

  await openJob(page, 'daily-ended-job');
  assert.match(await page.locator('.detail-panel').innerText(), /历史结束示例公司/);
  assert.match(await page.locator('.detail-panel').innerText(), /查看日期/);
  assert.match(await page.locator('.detail-panel').innerText(), /明天计划行动/);
  assert.equal(await page.locator('#page-surface').isVisible(), false);
  assert.equal(
    await page.locator('#detail-title').evaluate((heading) => document.activeElement === heading),
    true,
  );
  await closeDetail(page);
  assert.equal(await page.locator('#page-surface').isVisible(), true);
  assert.equal(await page.locator('#job-date').inputValue(), dates.next);
  assert.equal(
    await page
      .locator('[data-job="daily-ended-job"]')
      .evaluate((button) => button === document.activeElement),
    true,
  );

  await setJobDate(page, dates.empty);
  assert.match(await results.innerText(), /没有/);
  assert.equal(await results.locator('[data-job]').count(), 0);
  for (const [value, step, expected] of [
    ['2026-12-31', '1', '2027-01-01'],
    ['2024-02-28', '1', '2024-02-29'],
    ['2024-03-01', '-1', '2024-02-29'],
  ]) {
    await setJobDate(page, value);
    await page.locator(`[data-job-date-step="${step}"]`).click();
    assert.equal(await page.locator('#job-date').inputValue(), expected);
  }
  await page.locator('[data-job-date-clear]').click();
  assert.equal(await page.locator('#job-date').inputValue(), '');
  assert.equal(await results.locator('[data-job]').count(), 2);
  assert.deepEqual(await savedState(page), initial, 'Date browsing never changes shared records');
  assert.equal(
    await page
      .locator('[data-job-date-step], [data-job-date-today], [data-job-date-clear]')
      .evaluateAll((buttons) =>
        buttons.every((button) => button.getBoundingClientRect().height >= 44),
      ),
    true,
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.reload();
  assert.equal(await page.locator('nav [data-view="today"]').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('.detail-panel').count(), 0);
  await list(page);
  assert.equal(await page.locator('#job-date').inputValue(), '');
});

test(
  '组合筛选、分页和详情草稿跨页面保留，编辑不匹配及删除后正确收拢结果',
  { timeout: 60000 },
  async (t) => {
    const context = await isolatedContext(t),
      page = await openPage(context);
    const data = emptyData();
    for (let index = 1; index <= 12; index++)
      data.opportunities.push({
        id: `filter-job-${index}`,
        company: `筛选示例公司 ${String(index).padStart(2, '0')}`,
        role: '工程师',
        stage: '沟通中',
        appliedAt: '2026-09-12',
        notes: '筛选原备注',
      });
    data.opportunities.push(
      {
        id: 'wrong-stage',
        company: '筛选示例不同阶段',
        role: '工程师',
        stage: '已触达',
        appliedAt: '2026-09-12',
      },
      {
        id: 'wrong-date',
        company: '筛选示例不同日期',
        role: '工程师',
        stage: '沟通中',
        appliedAt: '2026-09-11',
      },
      {
        id: 'wrong-query',
        company: '其他公司',
        role: '工程师',
        stage: '沟通中',
        appliedAt: '2026-09-12',
      },
    );
    await seed(page, fixtureState(data));
    await list(page);
    await page.locator('#search').fill('筛选示例');
    await page.locator('#stage-filter').selectOption('沟通中');
    await setJobDate(page, '2026-09-12');
    const filters = async () => [
      await page.locator('#search').inputValue(),
      await page.locator('#stage-filter').inputValue(),
      await page.locator('#job-date').inputValue(),
    ];
    const expected = ['筛选示例', '沟通中', '2026-09-12'];
    assert.equal(await page.locator('#job-results [data-job]').count(), 10);
    await page.locator('[data-page="1"]').click();
    assert.equal(await page.locator('#job-results [data-job]').count(), 2);
    const ids = await page
      .locator('#job-results [data-job]')
      .evaluateAll((buttons) => buttons.map((b) => b.dataset.job));
    const searchNode = await page.locator('#search').elementHandle();
    await openJob(page, ids[0]);
    assert.deepEqual(await filters(), expected);
    for (const section of ['task', 'activity'])
      assert.equal(
        await page.locator(`[data-detail-section-panel="${section}"]`).evaluate((el) => el.open),
        false,
      );
    await openDetailSection(page, 'task');
    await page.locator('#task-form input[name="text"]').fill('筛选中尚未提交的行动');
    await closeDetail(page);
    assert.equal(
      await searchNode.evaluate((el) => el.isConnected && el === document.querySelector('#search')),
      true,
    );
    assert.deepEqual(await filters(), expected);
    assert.equal(await page.locator('#job-results [data-job]').count(), 2);
    assert.equal(
      await page.locator(`[data-job="${ids[0]}"]`).evaluate((el) => el === document.activeElement),
      true,
    );
    await resumeDraft(page, (draft) => draft.kind === 'task' && draft.opportunityId === ids[0]);
    assert.deepEqual(await filters(), expected);
    assert.equal(
      await page.locator('#task-form input[name="text"]').inputValue(),
      '筛选中尚未提交的行动',
    );
    await closeDetail(page);

    assert.equal(await page.locator('[data-job-layout]').count(), 0);
    assert.equal(await page.locator('.board').count(), 0);
    await openJob(page, ids[0]);
    assert.match(await page.locator('.detail-panel').innerText(), /首次联系/);
    assert.deepEqual(await filters(), expected);
    assert.equal(await page.locator('#job-results [data-job]').count(), 2);
    assert.equal(
      await page.locator('#task-form input[name="text"]').inputValue(),
      '筛选中尚未提交的行动',
    );
    await closeDetail(page);
    await page.locator('nav [data-view="today"]').click();
    await page.locator('[data-action-tab="upcoming"]').click();
    await list(page);
    assert.deepEqual(await filters(), expected);
    assert.equal(await page.locator('#job-results [data-job]').count(), 2);
    await page.locator('nav [data-view="today"]').click();
    assert.equal(
      await page.locator('[data-action-tab="upcoming"]').getAttribute('aria-pressed'),
      'true',
    );
    await list(page);

    await openJob(page, ids[0]);
    await page.locator(`[data-action="edit"][data-id="${ids[0]}"]`).first().click();
    await page.locator('#editor-form textarea[name="notes"]').fill('保存仍匹配筛选的备注');
    await page.locator('#editor-form button[type="submit"]').click();
    await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await filters(), expected);
    assert.equal(await page.locator('#job-results [data-job]').count(), 2);
    await page.locator(`[data-action="edit"][data-id="${ids[0]}"]`).first().click();
    await page.locator('#editor-form select[name="stage"]').selectOption('已触达');
    await page.locator('#editor-form button[type="submit"]').click();
    await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await filters(), expected);
    assert.match(await page.locator('.detail-panel').innerText(), /不再|不符合|不匹配/);
    assert.equal(
      await page.locator('#task-form input[name="text"]').inputValue(),
      '筛选中尚未提交的行动',
    );
    assert.equal(await page.locator(`#job-results [data-job="${ids[0]}"]`).count(), 0);
    await closeDetail(page);
    assert.equal(await page.locator('#job-results [data-job]').count(), 1);
    await openJob(page, ids[1]);
    await page.locator(`[data-action="edit"][data-id="${ids[1]}"]`).first().click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator(`[data-delete="${ids[1]}"]`).click();
    await page.waitForFunction(() =>
      document.querySelector('#notice')?.textContent.includes('岗位已删除'),
    );
    assert.equal(await page.locator('.detail-panel').count(), 0);
    assert.deepEqual(await filters(), expected);
    assert.equal(await page.locator('#job-results [data-job]').count(), 10);
    assert.equal(await page.locator('[data-page="-1"]').isDisabled(), true);
    // Date reset preserves the other two conditions; clearing all is explicit.
    await page.locator('[data-job-date-clear]').click();
    assert.deepEqual(await filters(), ['筛选示例', '沟通中', '']);
    await page.locator('[data-clear-filters]').click();
    assert.deepEqual(await filters(), ['', '', '']);
    await page.reload();
    assert.equal(await page.locator('.detail-panel').count(), 0);
    assert.equal(
      await page.locator('nav [data-view="today"]').getAttribute('aria-current'),
      'page',
    );
    await list(page);
    assert.deepEqual(await filters(), ['', '', '']);
  },
);

test('手机岗位详情返回恢复列表位置和焦点，筛选及草稿仍保留', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t, undefined, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await openPage(context),
    data = emptyData();
  for (let index = 1; index <= 12; index++)
    data.opportunities.push({
      id: `mobile-job-${index}`,
      company: `手机回归公司 ${index}`,
      role: '工程师',
      stage: '沟通中',
      appliedAt: '2026-09-12',
    });
  await seed(page, fixtureState(data));
  await list(page);
  await page.locator('#search').fill('手机回归');
  await setJobDate(page, '2026-09-12');
  const source = page.locator('#job-results [data-job]').nth(7);
  await source.scrollIntoViewIfNeeded();
  await settleBrowserEvents(page);
  const sourceId = await source.getAttribute('data-job'),
    beforeScroll = await page.evaluate(() => window.scrollY);
  assert.ok(beforeScroll > 0, 'The fixture exercises a real scrolled list');
  await source.click();
  assert.equal(await page.locator('#page-surface').isVisible(), false);
  await openDetailSection(page, 'activity');
  await page.locator('#activity-form textarea[name="text"]').fill('手机返回前保留的沟通草稿');
  await closeDetail(page);
  await settleBrowserEvents(page);
  assert.equal(await page.locator('#search').inputValue(), '手机回归');
  assert.equal(await page.locator('#job-date').inputValue(), '2026-09-12');
  assert.ok(
    Math.abs((await page.evaluate(() => window.scrollY)) - beforeScroll) < 4,
    'Closing detail restores the original scroll position',
  );
  assert.equal(
    await page.locator(`[data-job="${sourceId}"]`).evaluate((el) => el === document.activeElement),
    true,
  );
  await openJob(page, sourceId);
  assert.equal(
    await page.locator('#activity-form textarea[name="text"]').inputValue(),
    '手机返回前保留的沟通草稿',
  );
  assert.equal(
    await page.locator('[data-detail-section-panel="activity"]').evaluate((el) => el.open),
    true,
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  assert.equal((await savedState(page)).data.activities.length, 0);
});

test('历史日期查询下沟通和行动使用实际操作日期', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t, undefined, { timezoneId: 'Asia/Shanghai' });
  const page = await openPage(context);
  const dates = await page.evaluate(async () => {
    const { today } = await import('/model.js'),
      { addCalendarDays } = await import('/planning.js');
    return {
      today: today(),
      previous: addCalendarDays(today(), -1),
      next: addCalendarDays(today(), 2),
    };
  });
  const data = emptyData();
  data.opportunities.push({
    id: 'historical-job',
    company: '历史日期操作示例',
    role: '工程师',
    stage: '沟通中',
    resumeState: '已发送',
    appliedAt: dates.previous,
  });
  data.tasks.push(
    {
      id: 'history-complete',
      opportunityId: 'historical-job',
      text: '历史计划今天完成',
      dueAt: dates.previous,
      status: '待办',
    },
    {
      id: 'history-cancel',
      opportunityId: 'historical-job',
      text: '历史计划今天取消',
      dueAt: dates.previous,
      status: '待办',
    },
  );
  await seed(page, fixtureState(data));
  await list(page);
  await setJobDate(page, dates.previous);
  await openJob(page, 'historical-job', ['activity']);
  assert.equal(await page.locator('#activity-form input[name="date"]').inputValue(), dates.today);
  await page.locator('#activity-form textarea[name="text"]').fill('今天实际收到回复');
  await page.locator('#activity-form button[type="submit"]').click();
  await page.waitForFunction(() =>
    document.querySelector('#notice')?.textContent.includes('沟通记录已保存'),
  );
  await page.locator('.detail-panel [data-complete="history-complete"]').click();
  await page.waitForFunction(() =>
    import('/storage.js').then(
      async ({ readState }) =>
        (await readState()).data.tasks.find((t) => t.id === 'history-complete').status === '完成',
    ),
  );
  await page.locator('.detail-panel [data-cancel-task="history-cancel"]').click();
  await page.waitForFunction(() =>
    import('/storage.js').then(
      async ({ readState }) =>
        (await readState()).data.tasks.find((t) => t.id === 'history-cancel').status === '取消',
    ),
  );
  await openDetailSection(page, 'task');
  assert.equal(await page.locator('#task-form input[name="dueAt"]').inputValue(), dates.next);
  const state = await savedState(page);
  assert.equal(state.data.activities.find((a) => a.text === '今天实际收到回复')?.date, dates.today);
  for (const task of state.data.tasks)
    assert.equal(
      await page.evaluate((timestamp) => {
        const date = new Date(timestamp);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }, task.completedAt),
      dates.today,
    );
  assert.equal(await page.locator('#job-date').inputValue(), dates.previous);
  assert.doesNotMatch(await page.locator('#job-results').innerText(), /今天实际收到回复/);
});

test('下一步预填两天后，快捷日期仅保存草稿且手动覆盖可精确提交', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t, undefined, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    }),
    page = await openPage(context);
  const dates = await page.evaluate(async () => {
    const { today } = await import('/model.js'),
      { addCalendarDays } = await import('/planning.js'),
      current = today();
    return {
      today: current,
      createdAt: new Date().toISOString(),
      tomorrow: addCalendarDays(current, 1),
      twoDaysLater: addCalendarDays(current, 2),
      manual: addCalendarDays(current, 5),
    };
  });
  const data = emptyData();
  data.opportunities.push(
    {
      id: 'sent-resume-unplanned-job',
      company: '简历已发送示例公司',
      role: '后端工程师',
      stage: '沟通中',
      resumeState: '已发送',
      createdAt: dates.createdAt,
    },
    {
      id: 'draft-switch-target',
      company: '切换岗位示例公司',
      role: '产品经理',
      stage: '已触达',
      priority: '暂缓',
      createdAt: dates.createdAt,
    },
  );
  await seed(page, fixtureState(data));
  const initial = await savedState(page);

  await organize(page);
  await page.locator('[data-plan-job="sent-resume-unplanned-job"]').click();
  const form = page.locator('#task-form'),
    text = form.locator('input[name="text"]'),
    dueAt = form.locator('input[name="dueAt"]'),
    twoDaysButton = form.getByRole('button', { name: /计划日期设为2天后/ }),
    tomorrowButton = form.getByRole('button', { name: /计划日期设为明天/ });
  assert.equal(await text.inputValue(), '询问面试安排');
  assert.equal(await dueAt.inputValue(), dates.twoDaysLater);
  assert.equal(await twoDaysButton.getAttribute('aria-pressed'), 'true');
  assert.equal(
    await form
      .locator('.date-preset')
      .evaluateAll((buttons) =>
        buttons.every((button) => button.getBoundingClientRect().height >= 44),
      ),
    true,
  );
  assert.equal(
    await form.locator('.date-presets').evaluate((row) => row.scrollWidth <= row.clientWidth),
    true,
  );
  assert.equal(await savedDrafts(page).then((drafts) => drafts.length), 0);

  await tomorrowButton.click();
  assert.equal(await dueAt.inputValue(), dates.tomorrow);
  assert.equal(await tomorrowButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await twoDaysButton.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(await savedState(page), initial, 'A date preset must not submit a task');
  assert.deepEqual(
    (await savedDrafts(page)).find(
      (draft) => draft.kind === 'task' && draft.opportunityId === 'sent-resume-unplanned-job',
    )?.values,
    { text: '询问面试安排', dueAt: dates.tomorrow },
    'The date preset is retained as an unsubmitted task draft',
  );

  await text.fill('手动确认下一轮面试时间');
  await dueAt.fill(dates.manual);
  await closeDetail(page);
  await page.locator('[data-plan-job="draft-switch-target"]').click();
  assert.match(await page.locator('.detail-panel').innerText(), /切换岗位示例公司/);
  await closeDetail(page);
  await page.locator('[data-plan-job="sent-resume-unplanned-job"]').click();
  assert.equal(await text.inputValue(), '手动确认下一轮面试时间');
  assert.equal(await dueAt.inputValue(), dates.manual);
  assert.equal(await form.locator('[data-due-offset][aria-pressed="true"]').count(), 0);

  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() =>
    document.querySelector('#notice')?.textContent.includes('下一步已安排'),
  );
  const saved = await savedState(page),
    submitted = saved.data.tasks.find(
      (task) => task.opportunityId === 'sent-resume-unplanned-job' && task.status === '待办',
    );
  assert.ok(submitted);
  assert.equal(submitted.text, '手动确认下一轮面试时间');
  assert.equal(submitted.dueAt, dates.manual);
  assert.equal(saved.data.tasks.length, 1);
  assert.equal(
    (await savedDrafts(page)).some(
      (draft) => draft.kind === 'task' && draft.opportunityId === 'sent-resume-unplanned-job',
    ),
    false,
  );
  assert.equal(await text.inputValue(), '');
  assert.equal(await dueAt.inputValue(), '');
});

test(
  '同步更新简历状态时，未编辑的行动建议会刷新且不写入任务或草稿',
  { timeout: 45000 },
  async (t) => {
    const local = emptyData();
    local.opportunities.push({
      id: 'synced-default-job',
      company: '同步默认值示例公司',
      role: '后端工程师',
      stage: '沟通中',
      resumeState: '被索要',
    });
    const remote = clone(local);
    remote.opportunities[0].resumeState = '已发送';
    const api = githubMock(remote),
      context = await isolatedContext(t, api),
      page = await openPage(context);
    await seed(page, fixtureState(local, local));
    await configureToken(page);
    await page.locator('[data-view="today"]').click();
    await organize(page);
    await openJob(page, 'synced-default-job', ['task']);

    const text = page.locator('#task-form input[name="text"]'),
      dueAt = page.locator('#task-form input[name="dueAt"]');
    assert.equal(await text.inputValue(), '发送简历');
    const originalDueAt = await dueAt.inputValue();
    assert.notEqual(originalDueAt, '');
    assert.deepEqual(await savedDrafts(page), []);
    assert.equal((await savedState(page)).data.tasks.length, 0);

    await text.focus();
    await page.locator('#sync-button').evaluate((button) => button.click());
    await page.waitForFunction(
      () => document.querySelector('#task-form input[name="text"]')?.value === '询问面试安排',
    );
    const saved = await savedState(page);
    assert.equal(saved.data.opportunities[0].resumeState, '已发送');
    assert.equal(saved.data.tasks.length, 0);
    assert.deepEqual(await savedDrafts(page), []);
    const refreshedDueAt = await page.evaluate(async () => {
      const { today } = await import('/model.js'),
        { addCalendarDays } = await import('/planning.js');
      return addCalendarDays(today(), 2);
    });
    assert.equal(await dueAt.inputValue(), refreshedDueAt);
    assert.equal(api.writes.length, 0);
  },
);

test('弹窗阻止重绘时，另一页新增待办后旧默认不能重复提交', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    first = await openPage(context);
  const data = emptyData();
  data.opportunities.push({
    id: 'stale-default-job',
    company: '旧默认并发示例公司',
    role: '后端工程师',
    stage: '沟通中',
    resumeState: '已发送',
  });
  await seed(first, fixtureState(data));
  const second = await openPage(context);
  await list(first);
  await list(second);
  await openJob(first, 'stale-default-job', ['task']);
  await openJob(second, 'stale-default-job', ['task']);

  const staleText = first.locator('#task-form input[name="text"]'),
    staleDueAt = first.locator('#task-form input[name="dueAt"]');
  assert.equal(await staleText.inputValue(), '询问面试安排');
  const originalDueAt = await staleDueAt.inputValue();
  assert.notEqual(originalDueAt, '');
  await first.evaluate(() => {
    window.__staleDefaultBroadcast = new BroadcastChannel('job-tracker-updates');
    window.__staleDefaultBroadcastCount = 0;
    window.__staleDefaultBroadcast.onmessage = () => window.__staleDefaultBroadcastCount++;
  });
  await first.locator('[data-action="edit"][data-id="stale-default-job"]').first().click();
  await first.locator('#editor-dialog').waitFor({ state: 'visible' });

  assert.equal(await second.locator('#task-form input[name="text"]').inputValue(), '询问面试安排');
  await second.locator('#task-form button[type="submit"]').click();
  await second.waitForFunction(() =>
    document.querySelector('#notice')?.textContent.includes('下一步已安排'),
  );
  await first.waitForFunction(() => window.__staleDefaultBroadcastCount > 0);
  await settleBrowserEvents(first);
  assert.equal(await staleText.inputValue(), '询问面试安排');
  assert.equal(await staleDueAt.inputValue(), originalDueAt);
  assert.equal((await savedState(first)).data.tasks.length, 1);

  await first.locator('#editor-form [data-close="editor-dialog"]').first().click();
  await first.locator('#editor-dialog').waitFor({ state: 'hidden' });
  assert.equal(await staleText.inputValue(), '询问面试安排');
  await first.locator('#task-form button[type="submit"]').click();
  await first.waitForFunction(() =>
    document.querySelector('#notice')?.textContent.includes('岗位状态刚发生变化'),
  );

  const saved = await savedState(first);
  assert.equal(saved.data.tasks.length, 1);
  assert.equal(saved.generation, 1);
  assert.equal(saved.data.tasks[0].opportunityId, 'stale-default-job');
  assert.equal(saved.data.tasks[0].text, '询问面试安排');
  assert.equal(await first.locator('#task-form input[name="text"]').inputValue(), '');
  assert.equal(await first.locator('#task-form input[name="dueAt"]').inputValue(), '');
  assert.deepEqual(await savedDrafts(first), []);
});

test(
  '核实建议分别显示且不被无关行动遮挡，完成或加入今日行动后持久保存',
  { timeout: 45000 },
  async (t) => {
    const context = await isolatedContext(t),
      page = await openPage(context);
    const localToday = await page.evaluate(async () => (await import('/model.js')).today());
    const data = emptyData();
    data.opportunities.push(
      {
        id: 'double-suggestion-job',
        company: '双核实示例公司',
        role: '研发负责人',
        stage: '沟通中',
        resumeState: '被索要',
        rawStatus: '要了简历，被问带人经验',
      },
      {
        id: 'pending-suggestion-job',
        company: '待安排核实示例公司',
        role: '工程师',
        stage: '已触达',
        resumeState: '被索要',
      },
    );
    data.tasks.push({
      id: 'unrelated-existing-task',
      opportunityId: 'double-suggestion-job',
      text: '准备作品集',
      dueAt: '',
      status: '待办',
    });
    await seed(page, fixtureState(data));
    await organize(page);

    const suggestionButton = (jobId, kind, choice) =>
      page.locator(
        `[data-opportunity-id="${jobId}"][data-suggestion-kind="${kind}"][data-suggestion-choice="${choice}"]`,
      );
    for (const kind of ['resume', 'leadership']) {
      assert.equal(
        await suggestionButton('double-suggestion-job', kind, 'done').count(),
        1,
        `The ${kind} suggestion remains visible beside an unrelated task`,
      );
      assert.equal(await suggestionButton('double-suggestion-job', kind, 'pending').count(), 1);
    }

    await suggestionButton('double-suggestion-job', 'resume', 'done').click();
    await page.waitForFunction(
      () =>
        window.indexedDB &&
        import('/storage.js').then(async ({ readState }) => {
          const state = await readState();
          const job = state.data.opportunities.find((row) => row.id === 'double-suggestion-job');
          return (
            job?.resumeState === '已发送' &&
            state.data.activities.some(
              (row) => row.opportunityId === job.id && row.type === '发送简历',
            )
          );
        }),
    );
    await suggestionButton('double-suggestion-job', 'leadership', 'done').click();
    await page.waitForFunction(() =>
      import('/storage.js').then(async ({ readState }) => {
        const state = await readState();
        return state.data.activities.some(
          (row) =>
            row.opportunityId === 'double-suggestion-job' &&
            row.type === '对方回复' &&
            row.text.includes('带人经验'),
        );
      }),
    );
    await suggestionButton('pending-suggestion-job', 'resume', 'pending').click();
    await page.waitForFunction(
      ({ jobId, dueAt }) =>
        import('/storage.js').then(async ({ readState }) => {
          const state = await readState();
          return state.data.tasks.some(
            (row) =>
              row.opportunityId === jobId &&
              row.status === '待办' &&
              row.dueAt === dueAt &&
              row.text.includes('简历'),
          );
        }),
      { jobId: 'pending-suggestion-job', dueAt: localToday },
    );

    const saved = await savedState(page);
    assert.equal(
      saved.data.tasks.find((row) => row.id === 'unrelated-existing-task')?.status,
      '待办',
    );
    assert.equal(
      saved.data.opportunities.find((row) => row.id === 'double-suggestion-job')?.resumeState,
      '已发送',
    );
    assert.ok(
      saved.data.activities.some(
        (row) => row.opportunityId === 'double-suggestion-job' && row.type === '发送简历',
      ),
    );
    assert.ok(
      saved.data.activities.some(
        (row) =>
          row.opportunityId === 'double-suggestion-job' &&
          row.type === '对方回复' &&
          row.text.includes('带人经验'),
      ),
    );
    assert.ok(
      saved.data.tasks.some(
        (row) =>
          row.opportunityId === 'pending-suggestion-job' &&
          row.status === '待办' &&
          row.dueAt === localToday &&
          row.text.includes('简历'),
      ),
    );

    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('#local-status')?.textContent.includes('本地已保存'),
    );
    await organize(page);
    assert.equal(await suggestionButton('double-suggestion-job', 'resume', 'done').count(), 0);
    assert.equal(await suggestionButton('double-suggestion-job', 'leadership', 'done').count(), 0);
    assert.equal(await suggestionButton('pending-suggestion-job', 'resume', 'done').count(), 0);
    const persisted = await savedState(page);
    assert.deepEqual(persisted.data, saved.data);
  },
);

test(
  '核实建议加入今日行动后，完成待办会保存确认结果且刷新不再建议',
  { timeout: 45000 },
  async (t) => {
    const context = await isolatedContext(t),
      page = await openPage(context);
    const data = emptyData();
    data.opportunities.push(
      {
        id: 'complete-resume-suggestion',
        company: '完成简历核实示例公司',
        role: '后端工程师',
        stage: '沟通中',
        resumeState: '被索要',
      },
      {
        id: 'complete-leadership-suggestion',
        company: '完成带人核实示例公司',
        role: '研发负责人',
        stage: '沟通中',
        rawStatus: '已读，被问带人经验',
      },
    );
    await seed(page, fixtureState(data));
    await organize(page);

    const suggestionButton = (jobId, kind, choice) =>
      page.locator(
        `[data-opportunity-id="${jobId}"][data-suggestion-kind="${kind}"][data-suggestion-choice="${choice}"]`,
      );
    await suggestionButton('complete-resume-suggestion', 'resume', 'pending').click();
    await suggestionButton('complete-leadership-suggestion', 'leadership', 'pending').click();
    const planned = await savedState(page),
      resumeTask = planned.data.tasks.find(
        (row) => row.opportunityId === 'complete-resume-suggestion' && row.status === '待办',
      ),
      leadershipTask = planned.data.tasks.find(
        (row) => row.opportunityId === 'complete-leadership-suggestion' && row.status === '待办',
      );
    assert.ok(resumeTask);
    assert.ok(leadershipTask);
    assert.equal(await suggestionButton('complete-resume-suggestion', 'resume', 'done').count(), 0);
    assert.equal(
      await suggestionButton('complete-leadership-suggestion', 'leadership', 'done').count(),
      0,
    );

    await page.locator('[data-action-tab="today"]').click();
    await page.locator(`.action-row > [data-complete="${resumeTask.id}"]`).click();
    await page.waitForFunction(
      ({ taskId, jobId }) =>
        import('/storage.js').then(async ({ readState }) => {
          const state = await readState(),
            task = state.data.tasks.find((row) => row.id === taskId),
            job = state.data.opportunities.find((row) => row.id === jobId);
          return (
            task?.status === '完成' &&
            job?.resumeState === '已发送' &&
            state.data.activities.some(
              (row) => row.opportunityId === jobId && row.type === '发送简历',
            )
          );
        }),
      { taskId: resumeTask.id, jobId: 'complete-resume-suggestion' },
    );
    await page.locator(`.action-row > [data-complete="${leadershipTask.id}"]`).click();
    await page.waitForFunction(
      ({ taskId, jobId }) =>
        import('/storage.js').then(async ({ readState }) => {
          const state = await readState(),
            task = state.data.tasks.find((row) => row.id === taskId);
          return (
            task?.status === '完成' &&
            state.data.activities.some(
              (row) =>
                row.opportunityId === jobId &&
                row.type === '对方回复' &&
                row.text.includes('带人经验'),
            )
          );
        }),
      { taskId: leadershipTask.id, jobId: 'complete-leadership-suggestion' },
    );

    assert.equal(await page.locator('#page-title').innerText(), '行动');
    assert.equal(await suggestionButton('complete-resume-suggestion', 'resume', 'done').count(), 0);
    assert.equal(
      await suggestionButton('complete-leadership-suggestion', 'leadership', 'done').count(),
      0,
    );
    const saved = await savedState(page);
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('#local-status')?.textContent.includes('本地已保存'),
    );
    assert.equal(await suggestionButton('complete-resume-suggestion', 'resume', 'done').count(), 0);
    assert.equal(
      await suggestionButton('complete-leadership-suggestion', 'leadership', 'done').count(),
      0,
    );
    await organize(page);
    assert.equal(await suggestionButton('complete-resume-suggestion', 'resume', 'done').count(), 0);
    assert.equal(
      await suggestionButton('complete-leadership-suggestion', 'leadership', 'done').count(),
      0,
    );
    assert.deepEqual((await savedState(page)).data, saved.data);
  },
);

test('另一标签已完成核实后，旧标签的相反选择不能覆盖结果', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    first = await openPage(context);
  const data = emptyData();
  data.opportunities.push({
    id: 'stale-suggestion-job',
    company: '跨标签核实示例公司',
    role: '测试工程师',
    stage: '沟通中',
    resumeState: '被索要',
  });
  await seed(first, fixtureState(data));
  const second = await openPage(context),
    stalePending = first.locator(
      '[data-opportunity-id="stale-suggestion-job"][data-suggestion-kind="resume"][data-suggestion-choice="pending"]',
    ),
    currentDone = second.locator(
      '[data-opportunity-id="stale-suggestion-job"][data-suggestion-kind="resume"][data-suggestion-choice="done"]',
    );
  await organize(first);
  await organize(second);
  assert.equal(await stalePending.count(), 1);
  await first.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'stale-suggestion-focus';
    input.setAttribute('aria-label', '保留旧页面');
    document.body.append(input);
    input.focus();
    window.__staleSuggestionBroadcast = new BroadcastChannel('job-tracker-updates');
    window.__staleSuggestionBroadcastCount = 0;
    window.__staleSuggestionBroadcast.onmessage = () => window.__staleSuggestionBroadcastCount++;
  });

  await currentDone.click();
  await second.waitForFunction(() =>
    import('/storage.js').then(async ({ readState }) => {
      const state = await readState(),
        job = state.data.opportunities.find((row) => row.id === 'stale-suggestion-job');
      return (
        job?.resumeState === '已发送' &&
        state.data.activities.some((row) => row.opportunityId === job.id && row.type === '发送简历')
      );
    }),
  );
  await first.waitForFunction(() => window.__staleSuggestionBroadcastCount > 0);
  await settleBrowserEvents(first);
  assert.equal(
    await stalePending.count(),
    1,
    'Focused input keeps the old suggestion DOM in place',
  );
  const beforeStaleChoice = await savedState(first);

  await stalePending.click();
  await first.locator('#notice:not([hidden])').waitFor();
  await settleBrowserEvents(first);
  assert.deepEqual(
    await savedState(first),
    beforeStaleChoice,
    'A stale opposite choice must not add a task or change the confirmed result',
  );
  await first.reload();
  await first.waitForFunction(() =>
    document.querySelector('#local-status')?.textContent.includes('本地已保存'),
  );
  await organize(first);
  assert.equal(await stalePending.count(), 0);
});

test('中文组合输入保留搜索节点、焦点、选区和未保存草稿', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    page = await openPage(context);
  await seed(page);
  await list(page);
  await openJob(page, 'e2e-shanghai', ['task', 'activity']);
  const task = page.locator('#task-form input[name="text"]');
  const activity = page.locator('#activity-form textarea[name="text"]');
  await task.fill('询问下次面试时间');
  await activity.fill('尚未保存的中文沟通草稿');
  const taskNode = await task.elementHandle(),
    activityNode = await activity.elementHandle();
  const { input, cdp } = await beginChineseInput(context, page);
  await assertCurrentFocusedInput(input);
  assert.equal(
    await page.locator('#job-results [data-job]').count(),
    2,
    'Do not filter temporary pinyin',
  );
  await cdp.send('Input.imeSetComposition', { text: '上海', selectionStart: 2, selectionEnd: 2 });
  await assertCurrentFocusedInput(input);
  assert.equal(await page.locator('#job-results [data-job]').count(), 2);
  await commitChineseInput(cdp);
  await page.waitForFunction(
    () => document.querySelectorAll('#job-results [data-job]').length === 1,
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
  assert.match(await page.locator('#job-results').innerText(), /上海示例科技/);
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
  assert.equal(await page.locator('#job-results [data-job]').count(), 2);
});

test('新增岗位提示同公司和同岗位，恢复草稿后仍提示且不阻止保存', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    page = await openPage(context),
    data = emptyData();
  data.opportunities.push(
    {
      id: 'company-same-role',
      company: 'ＡＣＭＥ　科技',
      role: '平台工程师',
      stage: '沟通中',
    },
    {
      id: 'company-other-1',
      company: 'ACME 科技',
      role: '产品<script>',
      stage: '已触达',
    },
    { id: 'company-other-2', company: 'acme   科技', role: '测试工程师', stage: '已结束' },
    { id: 'company-other-3', company: 'ACME 科技', role: '安全工程师', stage: '面试中' },
    {
      id: 'company-deleted',
      company: 'ACME 科技',
      role: '已删除岗位',
      stage: '已触达',
      deletedAt: '2026-09-14T01:00:00.000Z',
    },
    {
      id: 'company-similar',
      company: 'ACME 科技有限公司',
      role: '相似公司岗位',
      stage: '已触达',
    },
  );
  await seed(page, fixtureState(data));
  await page.locator('#new-button').click();
  const company = page.locator('#editor-form input[name="company"]'),
    role = page.locator('#editor-form input[name="role"]'),
    hint = page.locator('[data-company-match-hint]');
  await company.fill('  acme 科技  ');
  await role.fill('平台工程师');
  await hint.waitFor();
  assert.match(await hint.innerText(), /可能是重复岗位/);
  assert.match(await hint.innerText(), /找到 4 个未删除岗位/);
  assert.match(await hint.innerText(), /另有 1 个/);
  assert.equal(await hint.locator('.company-match-list > span').count(), 3);
  assert.match(
    await hint.locator('.company-match-list > span').first().innerText(),
    /岗位名称相同/,
  );
  assert.equal(await hint.locator('script').count(), 0);
  assert.doesNotMatch(await hint.innerText(), /已删除岗位|相似公司岗位/);

  await role.fill('新的岗位');
  assert.match(await hint.innerText(), /该公司已有其他岗位/);
  assert.doesNotMatch(await hint.innerText(), /可能是重复岗位/);
  await company.fill('');
  assert.equal(await hint.isHidden(), true);
  await company.fill('acme 科技');
  await page.locator('#editor-form [data-close="editor-dialog"]').first().click();
  await resumeDraft(page, (draft) => draft.kind === 'editor' && !draft.opportunityId);
  assert.match(await page.locator('[data-company-match-hint]').innerText(), /该公司已有其他岗位/);

  await page.locator('#editor-form button[type="submit"]').click();
  await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
  const saved = await savedState(page),
    created = saved.data.opportunities.find((row) => row.role === '新的岗位');
  assert.ok(created);
  await page.locator(`[data-action="edit"][data-id="${created.id}"]`).first().click();
  assert.equal(await page.locator('[data-company-match-hint]').count(), 0);
});

test('打开新增表单时，另一标签新增同公司会刷新提示', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    first = await openPage(context),
    second = await openPage(context);
  await seed(first, fixtureState(emptyData()));
  await second.reload();
  await second.waitForFunction(() =>
    document.querySelector('#local-status')?.textContent.includes('本地已保存'),
  );
  await first.locator('#new-button').click();
  await first.locator('#editor-form input[name="company"]').fill('跨标签公司');
  assert.equal(await first.locator('[data-company-match-hint]').isHidden(), true);
  await second.locator('#new-button').click();
  await second.locator('#editor-form input[name="company"]').fill('跨标签公司');
  await second.locator('#editor-form input[name="role"]').fill('另一岗位');
  await second.locator('#editor-form button[type="submit"]').click();
  await first.locator('[data-company-match-hint]').waitFor();
  assert.match(await first.locator('[data-company-match-hint]').innerText(), /另一岗位/);
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
  assert.match(await page.locator('#job-results').innerText(), /回归测试有限公司/);
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
  await openJob(first, 'e2e-shanghai');
  await list(second);
  await first.locator('[data-action="edit"][data-id="e2e-shanghai"]').first().click();
  await first.locator('#editor-form textarea[name="notes"]').fill('标签页 A 保存的备注');
  await second.locator('[data-job="e2e-beijing"]').click();
  await second.locator('[data-action="edit"][data-id="e2e-beijing"]').first().click();
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
    document.querySelector('#job-results')?.textContent.includes('跨标签页新增示例'),
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
  await openJob(page, 'e2e-shanghai', ['task']);
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
  assert.equal(await page.locator('#job-results [data-job]').count(), 1);
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
  await openJob(page, 'e2e-shanghai');
  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('[data-action="edit"]').first().click();
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

test('中文新增草稿刷新及关页重开后可继续，提交前不改正式工作区', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t);
  let page = await openPage(context);
  await seed(page, fixtureState(emptyData()));
  const initial = await savedState(page);
  await page.locator('#new-button').click();
  const company = page.locator('#editor-form input[name="company"]');
  await company.focus();
  const companyNode = await company.elementHandle();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    text: 'zhongwen',
    selectionStart: 8,
    selectionEnd: 8,
  });
  await cdp.send('Input.imeSetComposition', {
    text: '中文草稿公司',
    selectionStart: 6,
    selectionEnd: 6,
  });
  await commitChineseInput(cdp, '中文草稿公司');
  assert.equal(await company.inputValue(), '中文草稿公司');
  assert.equal(
    await companyNode.evaluate((node) => node.isConnected && node === document.activeElement),
    true,
  );
  await page.locator('#editor-form input[name="role"]').fill('尚未提交的工程师');
  await page.locator('#editor-form textarea[name="notes"]').fill('刷新也保留的中文\n第二行 🚀');
  const originalDrafts = await savedDrafts(page);
  assert.equal(originalDrafts.length, 1);
  assert.equal(originalDrafts[0].values.company, '中文草稿公司');
  assert.deepEqual(await savedState(page), initial);

  await page.reload();
  await page.locator('#draft-button').waitFor();
  assert.deepEqual(await savedDrafts(page), originalDrafts);
  await resumeDraft(page, (draft) => draft.kind === 'editor');
  assert.equal(
    await page.locator('#editor-form input[name="role"]').inputValue(),
    '尚未提交的工程师',
  );
  assert.equal(
    await page.locator('#editor-form textarea[name="notes"]').inputValue(),
    '刷新也保留的中文\n第二行 🚀',
  );
  await page.locator('#editor-form textarea[name="notes"]').fill('关页前最后输入：继续保留 🚀');
  // Reopen only a page within this test's temporary context. Do not touch the
  // user's browser profile or use browser-global storage fixtures.
  await page.close();
  page = await openPage(context);
  assert.deepEqual(await savedState(page), initial);
  await resumeDraft(page, (draft) => draft.kind === 'editor');
  assert.equal(
    await page.locator('#editor-form textarea[name="notes"]').inputValue(),
    '关页前最后输入：继续保留 🚀',
  );
  await page.locator('#editor-form button[type="submit"]').click();
  await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
  const saved = await savedState(page);
  assert.equal(saved.generation, initial.generation + 1);
  assert.equal(saved.data.opportunities.length, 1);
  assert.equal(saved.data.opportunities[0].company, '中文草稿公司');
  assert.equal(saved.data.opportunities[0].notes, '关页前最后输入：继续保留 🚀');
  assert.deepEqual(await savedDrafts(page), []);
});

test('岗位间行动和沟通草稿隔离，保存只清除已提交的那一份', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    page = await openPage(context);
  const data = fixtureData();
  data.tasks.push({
    id: 'existing-beijing-task',
    opportunityId: 'e2e-beijing',
    text: '北京：已有待办',
    dueAt: '',
    status: '待办',
  });
  await seed(page, fixtureState(data));
  const initial = await savedState(page);
  await list(page);
  await openJob(page, 'e2e-shanghai', ['task', 'activity']);
  await page.locator('#task-form input[name="text"]').fill('上海：询问下一轮时间');
  await page.locator('#task-form input[name="dueAt"]').fill('2026-10-02');
  await page.locator('#activity-form textarea[name="text"]').fill('上海：已沟通的中文草稿');
  await page.locator('#activity-form select[name="type"]').selectOption('对方回复');
  await openJob(page, 'e2e-beijing', ['task', 'activity']);
  assert.equal(await page.locator('#task-form input[name="text"]').inputValue(), '');
  assert.equal(await page.locator('#task-form input[name="dueAt"]').inputValue(), '');
  assert.equal(await page.locator('#activity-form textarea[name="text"]').inputValue(), '');
  await page.locator('#task-form input[name="text"]').fill('北京：准备作品集');
  await page.locator('#activity-form textarea[name="text"]').fill('北京：尚未提交沟通');
  assert.equal((await savedDrafts(page)).length, 4);
  assert.deepEqual(await savedState(page), initial);

  await openJob(page, 'e2e-shanghai', ['task', 'activity']);
  assert.equal(
    await page.locator('#task-form input[name="text"]').inputValue(),
    '上海：询问下一轮时间',
  );
  assert.equal(await page.locator('#task-form input[name="dueAt"]').inputValue(), '2026-10-02');
  assert.equal(
    await page.locator('#activity-form textarea[name="text"]').inputValue(),
    '上海：已沟通的中文草稿',
  );
  await page.locator('#task-form button[type="submit"]').click();
  await page.waitForFunction(() =>
    document.querySelector('#notice')?.textContent.includes('下一步已安排'),
  );
  let remaining = await savedDrafts(page);
  assert.equal(remaining.length, 3);
  assert.equal(
    remaining.some((draft) => draft.kind === 'task' && draft.opportunityId === 'e2e-shanghai'),
    false,
  );
  assert.equal(
    await page.locator('#activity-form textarea[name="text"]').inputValue(),
    '上海：已沟通的中文草稿',
  );
  assert.equal(await page.locator('#task-form input[name="text"]').inputValue(), '');
  assert.equal(await page.locator('#task-form input[name="dueAt"]').inputValue(), '');

  await page.reload();
  await page.locator('#draft-button').waitFor();
  await resumeDraft(
    page,
    (draft) => draft.kind === 'activity' && draft.opportunityId === 'e2e-shanghai',
  );
  assert.equal(await page.locator('#activity-form select[name="type"]').inputValue(), '对方回复');
  await page.locator('#activity-form button[type="submit"]').click();
  await page.waitForFunction(() =>
    document.querySelector('#notice')?.textContent.includes('沟通记录已保存'),
  );
  remaining = await savedDrafts(page);
  assert.equal(remaining.length, 2);
  assert.ok(remaining.every((draft) => draft.opportunityId === 'e2e-beijing'));
  const saved = await savedState(page);
  assert.equal(saved.generation, initial.generation + 2);
  assert.equal(saved.data.tasks.length, 2);
  const shanghaiTask = saved.data.tasks.find((task) => task.opportunityId === 'e2e-shanghai');
  assert.equal(shanghaiTask?.text, '上海：询问下一轮时间');
  assert.equal(saved.data.activities.length, 1);
  assert.equal(saved.data.activities[0].opportunityId, 'e2e-shanghai');
  assert.equal(saved.data.activities[0].text, '上海：已沟通的中文草稿');
  await resumeDraft(
    page,
    (draft) => draft.kind === 'task' && draft.opportunityId === 'e2e-beijing',
  );
  assert.equal(
    await page.locator('#task-form input[name="text"]').inputValue(),
    '北京：准备作品集',
  );
});

test('岗位校验失败保留完整草稿，刷新后补正再保存', { timeout: 45000 }, async (t) => {
  const context = await isolatedContext(t),
    page = await openPage(context);
  await seed(page, fixtureState(emptyData()));
  const initial = await savedState(page);
  await page.locator('#new-button').click();
  await page.locator('#editor-form input[name="company"]').fill('校验失败示例公司');
  await page.locator('#editor-form input[name="role"]').fill('测试岗位');
  await page.locator('#editor-form textarea[name="notes"]').fill('不能因为未填结束原因而丢失');
  await page.locator('#editor-form select[name="stage"]').selectOption('已结束');
  await page.locator('#editor-form button[type="submit"]').click();
  assert.match(await page.locator('#editor-error').innerText(), /结束原因/);
  const beforeReload = await savedDrafts(page);
  assert.equal(beforeReload.length, 1);
  assert.equal(beforeReload[0].values.stage, '已结束');
  assert.deepEqual(await savedState(page), initial);
  await page.reload();
  await page.locator('#draft-button').waitFor();
  assert.deepEqual(await savedDrafts(page), beforeReload);
  await resumeDraft(page, (draft) => draft.kind === 'editor');
  assert.equal(
    await page.locator('#editor-form textarea[name="notes"]').inputValue(),
    '不能因为未填结束原因而丢失',
  );
  await page.locator('#editor-form select[name="endReason"]').selectOption('主动放弃');
  await page.locator('#editor-form button[type="submit"]').click();
  await page.locator('#editor-dialog').waitFor({ state: 'hidden' });
  assert.equal((await savedState(page)).data.opportunities[0].endReason, '主动放弃');
  assert.deepEqual(await savedDrafts(page), []);
});

test(
  '设置中的 PAT 不进入草稿、网站存储或完整备份，刷新后令牌清空',
  { timeout: 45000 },
  async (t) => {
    const context = await isolatedContext(t),
      page = await openPage(context);
    await seed(page);
    await list(page);
    await openJob(page, 'e2e-shanghai', ['task']);
    await page.locator('#task-form input[name="text"]').fill('用于核实备份含草稿的合成行动');
    // Finish the input's native change event before comparing with settings;
    // advancing the draft revision on blur is expected behavior.
    await page.locator('#page-title').click();
    const drafts = await savedDrafts(page);
    await configureToken(page);
    assert.deepEqual(await savedDrafts(page), drafts, 'Settings never creates a business draft');
    const browserStorage = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }));
    assert.equal(JSON.stringify(browserStorage).includes(fakeToken), false);
    assert.equal(JSON.stringify(await savedState(page)).includes(fakeToken), false);
    const waiting = page.waitForEvent('download');
    await page.locator('[data-action="export-json"]').click();
    const download = await waiting;
    const text = await readFile(await download.path(), 'utf8');
    assert.equal(text.includes(fakeToken), false);
    assert.ok(text.includes('用于核实备份含草稿的合成行动'));
    await page.reload();
    await page.locator('[data-view="settings"]').click();
    assert.equal(await page.locator('#settings-form input[name="token"]').inputValue(), '');
    assert.deepEqual(await savedDrafts(page), drafts);
  },
);

test(
  '未改动的编辑取消后，另一页更新同岗位，再次编辑使用最新基线',
  { timeout: 45000 },
  async (t) => {
    const context = await isolatedContext(t),
      first = await openPage(context);
    await seed(first);
    const second = await openPage(context);
    await list(first);
    await openJob(first, 'e2e-shanghai');
    await first.locator('[data-action="edit"][data-id="e2e-shanghai"]').first().click();
    await first.locator('#editor-form .dialog-footer [data-close="editor-dialog"]').click();
    assert.deepEqual(
      await savedDrafts(first),
      [],
      'Opening an unchanged editor creates no stored draft',
    );
    await first.locator('#page-title').click();
    await list(second);
    await openJob(second, 'e2e-shanghai');
    await second.locator('[data-action="edit"][data-id="e2e-shanghai"]').first().click();
    await second.locator('#editor-form textarea[name="notes"]').fill('另一个页面先保存的新备注');
    await second.locator('#editor-form button[type="submit"]').click();
    await second.locator('#editor-dialog').waitFor({ state: 'hidden' });
    await first.waitForFunction(() =>
      document.querySelector('#app-content')?.textContent.includes('另一个页面先保存的新备注'),
    );
    await first.locator('[data-action="edit"][data-id="e2e-shanghai"]').first().click();
    assert.equal(
      await first.locator('#editor-form textarea[name="notes"]').inputValue(),
      '另一个页面先保存的新备注',
    );
    assert.equal(await first.locator('#editor-error').innerText(), '');
    await first.locator('#editor-form textarea[name="notes"]').fill('基于最新记录继续修改');
    await first.locator('#editor-form button[type="submit"]').click();
    await first.locator('#editor-dialog').waitFor({ state: 'hidden' });
    assert.equal((await savedState(first)).data.opportunities[0].notes, '基于最新记录继续修改');
    assert.equal((await savedState(first)).generation, 2);
    assert.deepEqual(await savedDrafts(first), []);
  },
);

test(
  '旧编辑草稿重开后保留原始基线，不能覆盖另一页已保存的新记录',
  { timeout: 45000 },
  async (t) => {
    const context = await isolatedContext(t),
      first = await openPage(context);
    await seed(first);
    await list(first);
    await openJob(first, 'e2e-shanghai');
    await first.locator('[data-action="edit"][data-id="e2e-shanghai"]').first().click();
    await first.locator('#editor-form textarea[name="notes"]').fill('尚未提交的旧版本修改');
    const originalDraft = (await savedDrafts(first))[0];
    assert.equal(originalDraft.original.notes, '原始备注');
    await first.close();
    const second = await openPage(context);
    await list(second);
    await openJob(second, 'e2e-shanghai');
    await second.locator('[data-action="edit"][data-id="e2e-shanghai"]').first().click();
    await second.locator('#editor-form textarea[name="notes"]').fill('另一页面已经正式保存');
    await second.locator('#editor-form button[type="submit"]').click();
    await second.locator('#editor-dialog').waitFor({ state: 'hidden' });
    const beforeResume = await savedState(second);
    assert.equal(
      (await savedDrafts(second)).length,
      1,
      'Submitting another page must not clear the older draft',
    );
    await resumeDraft(second, (draft) => draft.id === originalDraft.id);
    assert.equal(
      await second.locator('#editor-form textarea[name="notes"]').inputValue(),
      '尚未提交的旧版本修改',
    );
    assert.match(await second.locator('#editor-error').innerText(), /新修改|其他页面|原岗位/);
    await second.locator('#editor-form button[type="submit"]').click();
    assert.match(await second.locator('#editor-error').innerText(), /其他页面|修改/);
    assert.deepEqual(await savedState(second), beforeResume);
    const remaining = await savedDrafts(second);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].original.notes, '原始备注');
    assert.equal(remaining[0].values.notes, '尚未提交的旧版本修改');
  },
);

test(
  '恢复草稿超过上限或存储配额失败时，正式工作区和已有草稿均不改变',
  { timeout: 60000 },
  async (t) => {
    for (const failure of ['limit', 'quota']) {
      await t.test(failure, async (t) => {
        const context = await isolatedContext(t),
          page = await openPage(context);
        await seed(page);
        const backup = await page.evaluate(async (failure) => {
          const { DraftStore } = await import('/drafts.js');
          const { readState } = await import('/storage.js');
          const { createBackup } = await import('/workspace.js');
          const draft = (text) => ({
            id: crypto.randomUUID(),
            revision: crypto.randomUUID(),
            kind: 'task',
            opportunityId: 'e2e-shanghai',
            values: { text, dueAt: '' },
            updatedAt: new Date().toISOString(),
          });
          const store = new DraftStore();
          for (let i = 0; i < (failure === 'limit' ? 200 : 1); i++)
            store.save(draft(`已有合成草稿 ${i}`));
          const workspace = await readState();
          workspace.data.opportunities[0].notes = '此备份本来会改变工作区';
          const result = createBackup(workspace, [draft('待恢复第一份'), draft('待恢复第二份')]);
          if (failure === 'quota') {
            const original = Storage.prototype.setItem;
            let writes = 0;
            window.__restoreStorageSetItem = () => {
              Storage.prototype.setItem = original;
            };
            Storage.prototype.setItem = function (key, value) {
              if (
                this === localStorage &&
                key.startsWith('job-tracker-draft-v1:') &&
                ++writes === 2
              )
                throw new DOMException('合成草稿存储配额不足', 'QuotaExceededError');
              return original.call(this, key, value);
            };
          }
          return result;
        }, failure);
        const initial = await savedState(page),
          initialDrafts = await savedDrafts(page);
        const initialSnapshots = await page.evaluate(async () =>
          (await import('/storage.js')).listSnapshots(),
        );
        await page.locator('#file-input').setInputFiles({
          name: 'synthetic-draft-restore.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(backup)),
        });
        await page.locator('#restore-button').click();
        await page.waitForFunction((failure) => {
          const notice = document.querySelector('#notice')?.textContent || '';
          return notice.includes(failure === 'limit' ? '200' : '配额');
        }, failure);
        assert.deepEqual(await savedState(page), initial);
        assert.deepEqual(
          await savedDrafts(page),
          initialDrafts,
          'A partial draft import is rolled back',
        );
        assert.deepEqual(
          await page.evaluate(async () => (await import('/storage.js')).listSnapshots()),
          initialSnapshots,
        );
        await page.evaluate(() => window.__restoreStorageSetItem?.());
      });
    }
  },
);
