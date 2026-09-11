import { DRAFT_FIELDS, validateDrafts } from './draft-data.js';
import { equal } from './model.js';

const PREFIX = 'job-tracker-draft-v1:';
const storageKey = (draft) => `${PREFIX}${draft.id}:${draft.revision}`;
export class DraftStore {
  constructor(storage = localStorage) {
    this.storage = storage;
  }
  keys() {
    return Array.from({ length: this.storage.length }, (_, i) => this.storage.key(i)).filter(
      (key) => key?.startsWith(PREFIX),
    );
  }
  list() {
    const rows = new Map();
    for (const key of this.keys()) {
      const raw = this.storage.getItem(key);
      if (!raw) continue;
      const d = validateDrafts([JSON.parse(raw)])[0];
      if (!rows.has(d.id) || rows.get(d.id).updatedAt < d.updatedAt) rows.set(d.id, d);
    }
    return validateDrafts([...rows.values()]).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  save(draft) {
    const d = validateDrafts([draft])[0],
      rows = this.list();
    if (rows.length >= 200 && !rows.some((row) => row.id === d.id))
      throw new Error('草稿已达到200份，请先保存或整理草稿箱。');
    const key = storageKey(d);
    this.storage.setItem(key, JSON.stringify(d));
    // Only the page that owns this ID writes it. Other pages resume a fresh ID.
    for (const old of this.keys())
      if (old.startsWith(PREFIX + d.id + ':') && old !== key) this.storage.removeItem(old);
    this.changed();
    return d;
  }
  resume(source) {
    const original = validateDrafts([source])[0],
      rows = this.list();
    if (
      rows.length >= 200 &&
      !rows.some((row) => row.id === original.id && row.revision === original.revision)
    )
      throw new Error('草稿已达到200份，请先整理草稿箱。');
    const copy = {
      ...original,
      id: crypto.randomUUID(),
      revision: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    const key = storageKey(copy);
    this.storage.setItem(key, JSON.stringify(copy));
    try {
      this.storage.removeItem(storageKey(original));
    } catch (error) {
      this.storage.removeItem(key);
      throw error;
    }
    this.changed();
    return copy;
  }
  clear(draft) {
    // Immutable revision keys make clearing safe even while its owner types again.
    this.storage.removeItem(storageKey(draft));
    this.changed();
  }
  prepareImport(rows) {
    const incoming = validateDrafts(rows);
    if (this.list().length + incoming.length > 200)
      throw new Error('恢复后草稿超过200份，请先整理草稿箱。');
    const keys = [];
    const rollback = () => {
      for (const key of keys) this.storage.removeItem(key);
    };
    try {
      for (const row of incoming) {
        const copy = { ...row, id: crypto.randomUUID(), revision: crypto.randomUUID() },
          key = storageKey(copy);
        keys.push(key);
        this.storage.setItem(key, JSON.stringify(copy));
      }
    } catch (error) {
      rollback();
      throw error;
    }
    return { commit: () => this.changed(), rollback };
  }
  changed() {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('drafts-saved'));
  }
}

export function createDraftManager({ store = new DraftStore(), report, onCount = () => {} }) {
  const active = new Map(),
    bindings = new WeakMap();
  const keyOf = (kind, id) => `${kind}:${id}`;
  function refreshCount() {
    try {
      onCount(store.list().length);
    } catch (e) {
      report(e);
    }
  }
  function bind(form, { kind, opportunityId = '', original, source }) {
    if (!form) return;
    const key = keyOf(kind, opportunityId);
    let entry = active.get(key);
    if (source) {
      const copy = store.resume(source);
      entry = { draft: copy, baseline: null };
      active.set(key, entry);
    }
    if (!entry || !Object.keys(entry.draft.values).length) {
      entry = {
        draft: {
          id: crypto.randomUUID(),
          revision: crypto.randomUUID(),
          kind,
          opportunityId,
          values: {},
          ...(original?.id ? { original: structuredClone(original) } : {}),
          updatedAt: new Date().toISOString(),
        },
        baseline: Object.fromEntries(
          DRAFT_FIELDS[kind].map((name) => [
            name,
            String(form.elements.namedItem(name)?.value ?? ''),
          ]),
        ),
      };
      active.set(key, entry);
    } else {
      for (const [name, value] of Object.entries(entry.draft.values)) {
        const field = form.elements.namedItem(name);
        if (field) field.value = value;
      }
    }
    const note = document.createElement('small');
    note.className = 'muted';
    note.dataset.draftStatus = '';
    note.setAttribute('role', 'status');
    note.textContent = Object.keys(entry.draft.values).length
      ? entry.unsaved
        ? '草稿尚未写入本机，请先复制输入内容。'
        : '已恢复本机草稿，尚未提交。'
      : '输入会自动保存为本机草稿。';
    form.append(note);
    const binding = { key, entry, note, enabled: true };
    bindings.set(form, binding);
    function persist() {
      if (!binding.enabled || entry.discarded) return;
      const values = Object.fromEntries(
        DRAFT_FIELDS[kind].map((name) => [
          name,
          String(form.elements.namedItem(name)?.value ?? ''),
        ]),
      );
      const next = {
        ...entry.draft,
        values,
        revision: crypto.randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      try {
        if (entry.baseline && equal(values, entry.baseline)) {
          store.clear(entry.draft, true);
          entry.draft.values = {};
          note.textContent = '尚未修改。';
        } else {
          store.save(next);
          entry.draft = next;
          entry.unsaved = false;
          note.textContent = '草稿已保存到本机，尚未提交。';
        }
        refreshCount();
      } catch (e) {
        entry.draft = next;
        entry.unsaved = true;
        note.textContent = '草稿保存失败，请先复制输入内容。';
        report(e);
      }
    }
    form.addEventListener('input', persist);
    form.addEventListener('change', persist);
    form.addEventListener('compositionend', persist);
    refreshCount();
    return entry.draft;
  }
  function capture(form) {
    const binding = bindings.get(form);
    return binding ? structuredClone(binding.entry.draft) : null;
  }
  function complete(form, captured) {
    const binding = bindings.get(form);
    if (!binding || !captured) return;
    let warning = '';
    try {
      store.clear(captured);
    } catch (error) {
      warning = `草稿清理失败，请在草稿箱手动整理：${error.message}`;
    }
    if (binding.entry.draft.revision === captured.revision) {
      binding.enabled = false;
      active.delete(binding.key);
    }
    refreshCount();
    return warning;
  }
  function discard(draft) {
    store.clear(draft);
    const key = keyOf(draft.kind, draft.opportunityId),
      entry = active.get(key);
    if (entry?.draft.id === draft.id && entry.draft.revision === draft.revision) {
      entry.discarded = true;
      active.delete(key);
    }
    refreshCount();
  }
  return { store, bind, capture, complete, discard, refreshCount };
}
