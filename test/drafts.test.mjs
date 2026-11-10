import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DRAFT_FIELDS, validateDrafts } from '../dist/draft-data.js';
import { DraftStore, createDraftManager } from '../dist/drafts.js';
import { initialWorkspace, createBackup, parseBackup } from '../dist/workspace.js';

class MemoryStorage {
  values = new Map();
  setAttempts = 0;
  failOnSet = Infinity;

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.values.get(String(key)) ?? null;
  }

  setItem(key, value) {
    this.setAttempts++;
    if (this.setAttempts === this.failOnSet)
      throw new DOMException('合成存储配额不足', 'QuotaExceededError');
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }

  snapshot() {
    return [...this.values.entries()].sort(([a], [b]) => a.localeCompare(b));
  }
}

const job = (notes = '原始中文备注') => ({
  id: 'synthetic-job',
  company: '合成示例公司',
  role: '中文工程师',
  stage: '已触达',
  notes,
});

function draft(kind = 'task', values = { text: '合成跟进草稿', dueAt: '' }, extra = {}) {
  return {
    id: randomUUID(),
    revision: randomUUID(),
    kind,
    opportunityId: kind === 'editor' ? '' : 'synthetic-job',
    values,
    updatedAt: '2026-09-11T08:00:00.000Z',
    ...extra,
  };
}

function workspace() {
  const state = initialWorkspace();
  state.config = { owner: 'example', repo: 'draft-tests', path: 'fixtures/data.json' };
  state.data.opportunities.push(job());
  state.base = structuredClone(state.data);
  return state;
}

function draftForm(t, kind = 'editor') {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {
    createElement: () => ({ dataset: {}, setAttribute() {} }),
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  const fields = new Map(DRAFT_FIELDS[kind].map((name) => [name, { value: '' }]));
  const form = new EventTarget();
  form.elements = { namedItem: (name) => fields.get(name) };
  form.append = () => {};
  return form;
}

for (const [kind, values] of [
  [
    'editor',
    { company: '中文草稿公司', role: '尚未提交的工程师', notes: '关页前最后输入：继续保留 🚀' },
  ],
  ['task', { text: '联系招聘者', dueAt: '2026-11-10' }],
  ['activity', { text: '收到面试安排', date: '2026-11-10', type: '沟通记录' }],
]) {
  test(`恢复${kind}草稿提交期间的同值事件不产生新修订，成功后清理本次草稿`, (t) => {
    const store = new DraftStore(new MemoryStorage());
    const source = draft(kind, {
      ...Object.fromEntries(DRAFT_FIELDS[kind].map((name) => [name, ''])),
      ...values,
    });
    store.save(source);
    const form = draftForm(t, kind);
    const manager = createDraftManager({ store, report: assert.fail });
    manager.bind(form, { kind, opportunityId: source.opportunityId, source });
    const captured = manager.capture(form);
    assert.notEqual(captured.id, source.id, '恢复仍使用新的草稿 ID');
    for (const type of ['input', 'change', 'compositionend']) form.dispatchEvent(new Event(type));
    manager.complete(form, captured);
    assert.deepEqual(store.list(), [], '同值事件不能把已提交内容变成未提交的新稿');
    form.dispatchEvent(new Event('change'));
    assert.deepEqual(store.list(), [], '完成后的旧表单不再重新写入草稿');
  });
}

test('提交期间真正的新输入仍保留，后续同值事件不替换新修订', (t) => {
  const store = new DraftStore(new MemoryStorage());
  const form = draftForm(t);
  const manager = createDraftManager({ store, report: assert.fail });
  manager.bind(form, { kind: 'editor' });
  form.elements.namedItem('notes').value = '本次提交的内容';
  form.dispatchEvent(new Event('input'));
  const captured = manager.capture(form);
  form.elements.namedItem('notes').value = '提交后继续输入的内容';
  form.dispatchEvent(new Event('input'));
  const newer = manager.capture(form);
  assert.notEqual(newer.revision, captured.revision);
  form.dispatchEvent(new Event('change'));
  manager.complete(form, captured);
  assert.deepEqual(store.list(), [newer]);
  form.elements.namedItem('notes').value = '仍可以继续编辑';
  form.dispatchEvent(new Event('input'));
  assert.equal(store.list()[0].values.notes, '仍可以继续编辑');
});

test('同值事件仍重试前次失败的草稿写入，成功后才停止重复保存', (t) => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage);
  const form = draftForm(t);
  const failures = [];
  const manager = createDraftManager({ store, report: (error) => failures.push(error) });
  manager.bind(form, { kind: 'editor' });
  storage.failOnSet = storage.setAttempts + 1;
  form.elements.namedItem('notes').value = '配额失败后保留的中文';
  form.dispatchEvent(new Event('input'));
  assert.equal(failures.length, 1);
  assert.deepEqual(store.list(), []);
  storage.failOnSet = Infinity;
  form.dispatchEvent(new Event('change'));
  const saved = manager.capture(form);
  assert.deepEqual(store.list(), [saved]);
  const attempts = storage.setAttempts;
  form.dispatchEvent(new Event('compositionend'));
  assert.equal(storage.setAttempts, attempts);
  assert.deepEqual(store.list(), [saved]);
});

test('草稿接受中文、换行及未完成字段，不按正式记录校验或修改输入', () => {
  const rows = [
    draft('editor', {
      company: '上海示例',
      role: '',
      stage: '已结束',
      endReason: '',
      notes: '第一行中文\n第二行 🚀',
      description: '尚未填写完整',
    }),
    draft('task', { text: '', dueAt: '' }),
    draft('activity', { text: '还在记录沟通 shang', date: '', type: '' }),
  ];
  const before = structuredClone(rows);
  const validated = validateDrafts(rows);
  assert.deepEqual(validated, before);
  validated[0].values.company = '修改返回值';
  assert.deepEqual(rows, before, 'Validation returns an independent copy');
});

test('三类草稿字段白名单拒绝令牌、设置表单与未知字段，不能静默丢弃', () => {
  for (const kind of ['editor', 'task', 'activity']) {
    assert.equal(DRAFT_FIELDS[kind].includes('token'), false);
    assert.throws(() => validateDrafts([draft(kind, { token: 'synthetic-token' })]));
    assert.throws(() => validateDrafts([draft(kind, {}, { token: 'synthetic-token' })]));
    assert.throws(() => validateDrafts([draft(kind, { unknownField: '需要保留的未知值' })]));
  }
  assert.throws(() => validateDrafts([draft('settings', { owner: 'example', token: 'fake' })]));
});

test('编辑草稿保留独立原记录基线，缺少基线或岗位ID不一致时拒绝', () => {
  const original = job();
  const source = draft(
    'editor',
    { notes: '尚未提交的修改' },
    {
      opportunityId: original.id,
      original,
    },
  );
  const [validated] = validateDrafts([source]);
  assert.deepEqual(validated.original, original);
  validated.original.notes = '仅修改返回值';
  assert.equal(source.original.notes, '原始中文备注');
  const { original: omitted, ...withoutOriginal } = source;
  assert.throws(() => validateDrafts([withoutOriginal]));
  assert.throws(() =>
    validateDrafts([{ ...source, original: { ...original, id: 'different-job' } }]),
  );
});

test('草稿重新读取保留中文和不完整值，保存失败不替换已存版本', () => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage);
  const source = draft('editor', { company: '中文示例 🚀', role: '', notes: '第一行\n第二行' });
  store.save(source);
  assert.deepEqual(new DraftStore(storage).list(), [source]);
  const before = storage.snapshot();
  storage.failOnSet = storage.setAttempts + 1;
  assert.throws(() =>
    store.save({
      ...source,
      revision: randomUUID(),
      updatedAt: '2026-09-11T08:01:00.000Z',
      values: { ...source.values, notes: '写入失败的新内容' },
    }),
  );
  assert.deepEqual(storage.snapshot(), before);
  assert.deepEqual(store.list(), [source]);
});

test('清理提交时捕获的revision不删除后续输入，最终清理释放全部草稿存储', () => {
  const storage = new MemoryStorage();
  storage.setItem('unrelated-setting', '保留其他本机设置');
  const baseline = storage.snapshot();
  const store = new DraftStore(storage);
  const captured = draft();
  store.save(captured);
  const newer = {
    ...captured,
    revision: randomUUID(),
    updatedAt: '2026-09-11T08:01:00.000Z',
    values: { text: '点击保存后又输入的中文', dueAt: '2026-09-18' },
  };
  store.save(newer);
  store.clear(captured);
  assert.deepEqual(store.list(), [newer]);
  store.clear(newer);
  store.clear(newer);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(storage.snapshot(), baseline, 'No hidden payloads or revision markers remain');
});

test('达到200份上限仍能继续已有草稿，恢复副本替换原稿且总数不增加', () => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage);
  const source = draft('task', { text: '满额时仍需继续的中文草稿', dueAt: '' });
  store.save(source);
  for (let index = 1; index < 200; index++) store.save(draft('task', { text: `已有草稿${index}` }));
  const before = structuredClone(source);
  const resumed = store.resume(source);
  assert.notEqual(resumed.id, source.id);
  assert.notEqual(resumed.revision, source.revision);
  assert.deepEqual(resumed.values, source.values);
  const rows = store.list();
  assert.equal(rows.length, 200);
  assert.equal(
    rows.some((row) => row.id === source.id),
    false,
  );
  assert.deepEqual(
    rows.find((row) => row.id === resumed.id),
    resumed,
  );
  assert.deepEqual(source, before);
});

test('恢复副本配额失败保留原稿；恢复旧revision不清掉另一页较新的版本', () => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage);
  const source = draft('activity', { text: '最初的中文沟通草稿', date: '' });
  store.save(source);
  const before = storage.snapshot();
  storage.failOnSet = storage.setAttempts + 1;
  assert.throws(() => store.resume(source));
  assert.deepEqual(storage.snapshot(), before);
  assert.deepEqual(store.list(), [source]);
  storage.failOnSet = Infinity;
  const newer = {
    ...source,
    revision: randomUUID(),
    updatedAt: '2026-09-11T08:01:00.000Z',
    values: { text: '另一页后来输入的沟通', date: '2026-09-12' },
  };
  store.save(newer);
  const resumed = store.resume(source);
  const rows = store.list();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.find((row) => row.id === newer.id),
    newer,
  );
  assert.deepEqual(rows.find((row) => row.id === resumed.id).values, source.values);
  store.clear(source);
  assert.equal(store.list().length, 2);
  assert.deepEqual(
    store.list().find((row) => row.id === newer.id),
    newer,
  );
});

test('批次准备为导入分配新ID和revision，提交不覆盖原草稿或修改源备份', () => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage);
  const existing = draft();
  store.save(existing);
  const source = [structuredClone(existing), draft('activity', { text: '待恢复沟通', date: '' })];
  const before = structuredClone(source);
  const prepared = store.prepareImport(source);
  assert.equal(typeof prepared.commit, 'function');
  assert.equal(typeof prepared.rollback, 'function');
  prepared.commit();
  const rows = store.list();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.find((row) => row.id === existing.id),
    existing,
  );
  const imported = rows.filter((row) => row.id !== existing.id);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.ok(imported.every((row) => !source.some((original) => original.id === row.id)));
  assert.ok(
    imported.every((row) => !source.some((original) => original.revision === row.revision)),
  );
  assert.deepEqual(imported.find((row) => row.kind === 'task').values, existing.values);
  assert.deepEqual(imported.find((row) => row.kind === 'activity').values, source[1].values);
  assert.deepEqual(source, before);
});

test('批次超过总数200上限时整体拒绝，不写入任何一份草稿', () => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage);
  for (let index = 0; index < 199; index++) store.save(draft('task', { text: `已有草稿${index}` }));
  const before = storage.snapshot();
  const writes = storage.setAttempts;
  assert.throws(() => store.prepareImport([draft(), draft()]));
  assert.equal(storage.setAttempts, writes, 'Capacity validation happens before the first write');
  assert.deepEqual(storage.snapshot(), before);
  assert.equal(store.list().length, 199);
});

test('批次中的后续草稿无效时整体拒绝，前面的有效草稿也不落盘', () => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage);
  store.save(draft());
  const before = storage.snapshot();
  const writes = storage.setAttempts;
  assert.throws(() => store.prepareImport([draft(), draft('task', { token: 'synthetic-token' })]));
  assert.equal(storage.setAttempts, writes);
  assert.deepEqual(storage.snapshot(), before);
});

test('批次中途遇到QuotaExceeded时回滚所有新草稿，原有内容逐字保留', () => {
  const storage = new MemoryStorage();
  storage.setItem('unrelated-setting', '不应变化');
  const store = new DraftStore(storage);
  store.save(draft('task', { text: '原有中文草稿', dueAt: '' }));
  const before = storage.snapshot();
  const writes = storage.setAttempts;
  storage.failOnSet = writes + 2;
  assert.throws(() => store.prepareImport([draft(), draft(), draft()]));
  assert.equal(
    storage.setAttempts,
    writes + 2,
    'Failure occurs after one imported draft was written',
  );
  assert.deepEqual(
    storage.snapshot(),
    before,
    'All imported keys are removed after a partial write',
  );
  assert.equal(store.list().length, 1);
});

test('工作区恢复未提交时可以回滚已准备批次，同时保留原草稿的后续修改', () => {
  const storage = new MemoryStorage();
  const store = new DraftStore(storage);
  const existing = draft();
  store.save(existing);
  const prepared = store.prepareImport([draft(), draft('activity', { text: '待恢复沟通' })]);
  const newer = {
    ...existing,
    revision: randomUUID(),
    updatedAt: '2026-09-11T08:01:00.000Z',
    values: { text: '准备期间其他输入应保留' },
  };
  store.save(newer);
  prepared.rollback();
  assert.deepEqual(store.list(), [newer]);
  store.clear(newer);
  assert.equal(storage.length, 0);
});

test('v2完整备份JSON往返保留三类草稿和编辑基线，草稿不进入正式数据', () => {
  const state = workspace();
  const rows = [
    draft('editor', { company: '新增未完成中文岗位', role: '' }),
    draft(
      'editor',
      { notes: '旧基线上的编辑草稿' },
      {
        opportunityId: 'synthetic-job',
        original: job(),
      },
    ),
    draft('task', { text: '下一步尚未提交', dueAt: '' }),
    draft('activity', { text: '第一行沟通\n第二行 🚀', date: '', type: '沟通记录' }),
  ];
  const stateBefore = structuredClone(state);
  const draftsBefore = structuredClone(rows);
  const backup = createBackup(state, rows);
  assert.equal(backup.backupVersion, 2);
  const parsed = parseBackup(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(parsed.drafts, draftsBefore);
  assert.deepEqual(parsed.workspace, stateBefore);
  assert.deepEqual(parsed.data, stateBefore.data);
  assert.equal(parsed.data.tasks.length, 0);
  assert.equal(parsed.data.activities.length, 0);
  assert.deepEqual(state, stateBefore);
  assert.deepEqual(rows, draftsBefore);
});

test('v1完整备份和旧数据备份可读取，升级为v2后草稿保持为空', () => {
  const state = workspace();
  const old = { backupVersion: 1, workspace: structuredClone(state) };
  const parsed = parseBackup(JSON.parse(JSON.stringify(old)));
  assert.deepEqual(parsed.drafts, []);
  assert.deepEqual(parsed.workspace, state);
  const upgraded = createBackup(parsed.workspace, parsed.drafts);
  assert.equal(upgraded.backupVersion, 2);
  assert.deepEqual(parseBackup(JSON.parse(JSON.stringify(upgraded))).drafts, []);
  assert.deepEqual(parseBackup(state.data), { data: state.data, workspace: null, drafts: [] });
});

test('v1夹带草稿、v2缺失草稿和未知备份版本均拒绝，不静默舍弃内容', () => {
  const state = workspace();
  assert.throws(() => parseBackup({ backupVersion: 1, workspace: state, drafts: [draft()] }));
  assert.throws(() => parseBackup({ backupVersion: 2, workspace: state }));
  assert.throws(() => parseBackup({ backupVersion: 3, workspace: state, drafts: [draft()] }));
});
