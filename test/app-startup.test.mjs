import test from 'node:test';
import assert from 'node:assert/strict';
import { runAppStartup } from '../dist/app-startup.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('初始化就绪标识等待工作区读取和首屏初始化全部完成', async () => {
  const root = { dataset: {} },
    work = deferred();
  const startup = runAppStartup(() => work.promise, root);
  assert.equal(root.dataset.appState, 'starting');
  await Promise.resolve();
  assert.equal(root.dataset.appState, 'starting');
  work.resolve('initialized');
  assert.equal(await startup, 'initialized');
  assert.equal(root.dataset.appState, 'ready');
});

test('初始化失败标识不能被视为就绪，原始错误仍交给应急界面', async () => {
  const root = { dataset: {} },
    error = new Error('synthetic workspace failure');
  await assert.rejects(
    runAppStartup(() => {
      throw error;
    }, root),
    (actual) => actual === error,
  );
  assert.equal(root.dataset.appState, 'failed');
});

test('迁移后重新初始化清除失败标识，完成前不能误报成功', async () => {
  const root = { dataset: { appState: 'ready' } },
    work = deferred();
  const startup = runAppStartup(() => work.promise, root);
  assert.equal(root.dataset.appState, 'starting');
  const error = new Error('synthetic read failure');
  work.reject(error);
  await assert.rejects(startup, (actual) => actual === error);
  assert.equal(root.dataset.appState, 'failed');
  const retry = deferred();
  const recovered = runAppStartup(() => retry.promise, root);
  assert.equal(root.dataset.appState, 'starting');
  retry.resolve();
  await recovered;
  assert.equal(root.dataset.appState, 'ready');
});
