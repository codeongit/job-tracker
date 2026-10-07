import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData, clone, mergeData, resolveConflicts } from '../dist/model.js';
import {
  describeSyncConflict,
  groupSyncConflicts,
  completeSyncConflictChoices,
  syncConflictSignature,
  syncConflictView,
  createSyncConflictUI,
} from '../dist/sync-conflict-ui.js';

const job = (id = 'job-a', fields = {}) => ({
  id,
  company: '示例公司',
  role: '软件工程师',
  stage: '已触达',
  ...fields,
});
function fixture() {
  const base = {
    ...emptyData(),
    opportunities: [job('job-a', { notes: '', contact: '' }), job('job-b')],
  };
  const local = clone(base),
    remote = clone(base);
  Object.assign(local.opportunities[0], { notes: '本机备注', contact: '新增联系人' });
  Object.assign(remote.opportunities[0], { notes: '云端备注', stage: '沟通中' });
  local.opportunities[1].notes = '另一项本机修改';
  remote.opportunities[1].notes = '另一项云端修改';
  const merged = mergeData(base, local, remote);
  const pending = { ...merged, remote, generation: 7 };
  return { pending, data: local, generation: 7 };
}

test('只突出分歧，完整候选包含双方的独立修改，不改变三方合并规则', () => {
  const state = fixture(),
    conflict = state.pending.conflicts[0];
  const described = describeSyncConflict(conflict, state.pending.data);
  assert.deepEqual(
    described.fields.map((field) => field.field),
    ['notes'],
  );
  assert.equal(described.fields[0].label, '备注');
  assert.equal(conflict.local.contact, '新增联系人');
  assert.equal(conflict.remote.contact, '新增联系人');
  assert.equal(conflict.local.stage, '沟通中');
  const choices = { 'opportunities:job-a': 'remote', 'opportunities:job-b': 'local' };
  const result = resolveConflicts(state.pending.data, state.pending.conflicts, choices);
  assert.equal(result.opportunities[0].notes, '云端备注');
  assert.equal(result.opportunities[0].contact, '新增联系人');
  assert.equal(result.opportunities[0].stage, '沟通中');
  assert.equal(result.opportunities[1].notes, '另一项本机修改');
  assert.match(syncConflictView(state.pending, state.data, choices), /选择后的结果：保留云端版本/);
});

test('单组冲突核对完整候选后可一次保存，未选择前禁止提交', () => {
  const state = fixture();
  state.pending.conflicts = [state.pending.conflicts[0]];
  const before = syncConflictView(state.pending, state.data);
  assert.match(before, /id="conflict-form"/);
  assert.match(before, /type="submit" data-sync-conflict-action="save" disabled/);
  const after = syncConflictView(state.pending, state.data, { 'opportunities:job-a': 'local' });
  assert.match(after, /type="submit" data-sync-conflict-action="save" >保存全部选择/);
  assert.match(after, /选择后的结果：保留本机版本/);
  assert.doesNotMatch(after, /data-sync-conflict-action="next"/);
});

test('按岗位汇总关联记录，账号和无法归属的来源记录独立核对', () => {
  const state = fixture();
  state.pending.conflicts.push({
    key: 'sourceApplications:application-a',
    group: 'sourceApplications',
    id: 'application-a',
    local: {
      id: 'application-a',
      opportunityId: 'job-a',
      factId: 'fact-a',
      status: 'waiting',
      reason: 'missing_job_details',
    },
    remote: {
      id: 'application-a',
      opportunityId: 'job-a',
      factId: 'fact-a',
      status: 'protected',
      reason: 'user_ignored_unresolved_observation',
    },
  });
  state.pending.conflicts.push({
    key: 'sourceBindings:account-a',
    group: 'sourceBindings',
    id: 'account-a',
    local: {
      id: 'account-a',
      kind: 'account',
      accountNamespace: 'synthetic-account',
      workspaceSourceId: 'workspace-local',
    },
    remote: {
      id: 'account-a',
      kind: 'account',
      accountNamespace: 'synthetic-account',
      workspaceSourceId: 'workspace-remote',
    },
  });
  state.pending.conflicts.push({
    key: 'sourceFacts:fact-z',
    group: 'sourceFacts',
    id: 'fact-z',
    local: { id: 'fact-z', factType: 'message_observed' },
    remote: { id: 'fact-z', factType: 'message_receipt_read' },
  });
  const groups = groupSyncConflicts(state.pending, state.data);
  assert.equal(groups.length, 4);
  assert.deepEqual(
    groups[0].conflicts.map((conflict) => conflict.group),
    ['opportunities', 'sourceApplications'],
  );
  const view = syncConflictView(state.pending, state.data, {}, 2);
  assert.match(view, /所属本机工作区/);
  assert.match(view, /平台账号绑定/);
  assert.doesNotMatch(view, /input[^>]*checked/);
  assert.equal(completeSyncConflictChoices(state.pending, {}), false);
  const app = describeSyncConflict(state.pending.conflicts[2], state.data);
  assert.equal(app.fields.find((field) => field.field === 'reason').remote, '已人工忽略旧观察');
  assert.equal(
    describeSyncConflict(state.pending.conflicts[4], state.data).fields[0].remote,
    '消息已读事实',
  );
});

test('岗位删除说明关联记录影响，选择仍整体采用完整候选', () => {
  const data = {
    ...emptyData(),
    opportunities: [job()],
    activities: [{ id: 'activity-a', opportunityId: 'job-a', text: '合成沟通' }],
    tasks: [{ id: 'task-a', opportunityId: 'job-a', text: '合成任务', status: '待办' }],
  };
  const local = clone(data),
    remote = clone(data);
  local.opportunities[0].deletedAt = '2026-10-07T00:00:00.000Z';
  remote.opportunities[0].notes = '云端新修改';
  const pending = { ...mergeData(data, local, remote), remote, generation: 1 };
  pending.conflicts[0].relational = true;
  const view = syncConflictView(pending, pending.data, { 'opportunities:job-a': 'local' });
  assert.match(view, /一边删除了岗位/);
  assert.match(view, /1 条沟通记录、1 项任务/);
  assert.match(view, /记录是否保留/);
  const resolved = resolveConflicts(pending.data, pending.conflicts, {
    'opportunities:job-a': 'local',
  });
  assert.ok(resolved.opportunities[0].deletedAt);
  assert.ok(resolved.activities[0].deletedAt);
  assert.ok(resolved.tasks[0].deletedAt);
  assert.equal(data.opportunities[0].deletedAt, undefined);
});

test('候选名称和私有文字转义，原始 JSON 仅在折叠技术详情中', () => {
  const state = fixture();
  state.pending.conflicts[0].local.company = '<script>alert("private")</script>';
  state.pending.conflicts[0].local.notes = '<img src=x onerror=secret>';
  state.pending.conflicts[0].local.contact = 'open';
  const html = syncConflictView(state.pending, state.data);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<details[^>]*>[\s\S]*技术详情：完整候选/);
  assert.match(html, /&lt;img src=x onerror=secret&gt;/);
  const fields = describeSyncConflict(state.pending.conflicts[0], state.data).fields;
  assert.equal(fields.find((field) => field.field === 'contact').local, 'open');
});

test('核对签名包含 pending 和 generation，重基或版本变化不能沿用选择', () => {
  const state = fixture();
  const signature = syncConflictSignature(state.pending, state.generation);
  assert.equal(signature, syncConflictSignature(clone(state.pending), 7));
  assert.notEqual(signature, syncConflictSignature(state.pending, 8));
  const updated = clone(state.pending);
  updated.conflicts[0].remote.notes = '新云端内容';
  assert.notEqual(signature, syncConflictSignature(updated, 7));
  const staleView = syncConflictView(
    state.pending,
    state.data,
    { 'opportunities:job-a': 'local' },
    0,
    { stale: true },
  );
  assert.match(staleView, /重新核对最新内容/);
  assert.match(staleView, /data-sync-conflict-choice[^>]*disabled/);
});

function fakeElements() {
  const listeners = new Map();
  const content = {
    innerHTML: '',
    onclick: null,
    onchange: null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const dialog = {
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      listeners.get('close')?.();
    },
    addEventListener(name, fn) {
      listeners.set(name, fn);
    },
  };
  return {
    content,
    dialog,
    click: (action) =>
      content.onclick({
        target: { closest: () => ({ disabled: false, dataset: { syncConflictAction: action } }) },
      }),
    choose: (key, value) =>
      content.onchange({
        target: { closest: () => ({ dataset: { syncConflictChoice: key }, value }) },
      }),
  };
}

test('逐组选择与取消均不写入，重开保留同批选择，最终只提交一次全部选择', async () => {
  let state = fixture(),
    saves = 0,
    synchronized = 0;
  const elements = fakeElements(),
    errors = [];
  const ui = createSyncConflictUI({
    readState: async () => state,
    resolveSyncConflict: async (pending, choices) => {
      saves++;
      assert.deepEqual(choices, {
        'opportunities:job-a': 'remote',
        'opportunities:job-b': 'local',
      });
      return {
        ...state,
        data: resolveConflicts(pending.data, pending.conflicts, choices),
        pending: null,
        generation: 8,
      };
    },
    saved: (next) => {
      state = next;
    },
    report: (error) => errors.push(error),
    sync: () => {
      synchronized++;
    },
    getDialog: () => elements.dialog,
    getContent: () => elements.content,
  });
  await ui.show();
  elements.choose('opportunities:job-a', 'remote');
  await elements.click('close');
  assert.equal(saves, 0);
  await ui.show();
  assert.match(elements.content.innerHTML, /value="remote"[^>]*checked/);
  await elements.click('next');
  elements.choose('opportunities:job-b', 'local');
  await elements.click('next');
  assert.match(elements.content.innerHTML, /确认全部同步选择/);
  await elements.click('save');
  assert.equal(saves, 1);
  assert.equal(synchronized, 0);
  assert.equal(state.pending, null);
  assert.match(elements.content.innerHTML, /本机已保存，待同步/);
  assert.deepEqual(errors, []);
  await elements.click('sync');
  assert.equal(synchronized, 1);
});

test('版本变化保留页面选择但禁止保存，重新核对读取新批次并清空旧选择', async () => {
  let state = fixture(),
    saves = 0;
  const elements = fakeElements(),
    errors = [];
  const ui = createSyncConflictUI({
    readState: async () => state,
    resolveSyncConflict: () => {
      saves++;
    },
    saved: () => {},
    report: (error) => errors.push(error),
    sync: () => {},
    getDialog: () => elements.dialog,
    getContent: () => elements.content,
  });
  await ui.show();
  elements.choose('opportunities:job-a', 'local');
  await elements.click('next');
  elements.choose('opportunities:job-b', 'remote');
  await elements.click('next');
  state = { ...state, generation: 8 };
  await elements.click('save');
  assert.equal(saves, 0);
  assert.match(elements.content.innerHTML, /正式记录或同步冲突已变化/);
  assert.match(elements.content.innerHTML, /value="remote"[^>]*checked[^>]*disabled/);
  assert.equal(errors.length, 1);
  await elements.click('reload');
  assert.doesNotMatch(elements.content.innerHTML, /input[^>]*checked/);
});

test('连接过期不能保存或宣称完成，失败保持选择并可重新核对', async () => {
  const state = fixture(),
    elements = fakeElements(),
    errors = [];
  let offline = false,
    saves = 0;
  const ui = createSyncConflictUI({
    readState: async () => state,
    isUnavailable: () => offline,
    resolveSyncConflict: () => {
      saves++;
    },
    saved: () => {},
    report: (error) => errors.push(error),
    sync: () => {},
    getDialog: () => elements.dialog,
    getContent: () => elements.content,
  });
  await ui.show();
  elements.choose('opportunities:job-a', 'local');
  await elements.click('next');
  elements.choose('opportunities:job-b', 'remote');
  await elements.click('next');
  offline = true;
  await elements.click('save');
  assert.equal(saves, 0);
  assert.match(elements.content.innerHTML, /无法保存/);
  assert.doesNotMatch(elements.content.innerHTML, /本机已保存，待同步/);
  assert.match(elements.content.innerHTML, /value="remote"[^>]*checked/);
  assert.equal(errors.length, 1);
});

test('本机已拥有账号选择有效云端版本时，结果说明保留当前服务归属，删除仍须明确核对', () => {
  const local = {
    id: 'binding-a',
    kind: 'account',
    platform: 'boss',
    accountNamespace: 'example-account',
    workspaceSourceId: 'current-workspace',
  };
  const remote = { ...local, workspaceSourceId: 'another-workspace' };
  const data = { ...emptyData(), sourceBindings: [local] };
  const pending = {
    data,
    remote: { ...emptyData(), sourceBindings: [remote] },
    generation: 1,
    conflicts: [
      { key: 'sourceBindings:binding-a', group: 'sourceBindings', id: 'binding-a', local, remote },
    ],
  };
  const html = syncConflictView(pending, data, { 'sourceBindings:binding-a': 'remote' }, 0, {
    protectedAccountIds: new Set(['binding-a']),
  });
  assert.match(html, /所属本机工作区：仍保留当前本机工作区/);
  assert.match(html, /选择云端资料不会转移该账号/);
  const deleted = clone(pending);
  deleted.conflicts[0].remote.deletedAt = '2026-10-07T00:00:00.000Z';
  const deleteHtml = syncConflictView(deleted, data, { 'sourceBindings:binding-a': 'remote' }, 0, {
    protectedAccountIds: new Set(['binding-a']),
  });
  assert.match(deleteHtml, /删除这项平台绑定/);
  assert.doesNotMatch(deleteHtml, /选择云端资料不会转移该账号/);
});
