import { emptyData, validateData } from './model.js';

export const DRAFT_FIELDS = {
  editor: [
    'company',
    'role',
    'platform',
    'source',
    'contact',
    'url',
    'appliedAt',
    'stage',
    'readState',
    'resumeState',
    'endReason',
    'priority',
    'location',
    'salary',
    'notes',
    'description',
  ],
  task: ['text', 'dueAt'],
  activity: ['text', 'date', 'type'],
};
export function validateDrafts(input) {
  if (!Array.isArray(input) || input.length > 200) throw new Error('草稿数量或格式无效。');
  const ids = new Set();
  return input.map((d) => {
    if (
      !d ||
      Object.keys(d).some(
        (k) =>
          !['id', 'revision', 'kind', 'opportunityId', 'values', 'original', 'updatedAt'].includes(
            k,
          ),
      ) ||
      !DRAFT_FIELDS[d.kind] ||
      !/^[a-f0-9-]{36}$/.test(d.id) ||
      ids.has(d.id) ||
      !/^[a-f0-9-]{36}$/.test(d.revision) ||
      typeof d.opportunityId !== 'string' ||
      typeof d.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(d.updatedAt))
    )
      throw new Error('草稿格式无效。');
    ids.add(d.id);
    if (
      !d.values ||
      typeof d.values !== 'object' ||
      Array.isArray(d.values) ||
      Object.entries(d.values).some(
        ([k, v]) => !DRAFT_FIELDS[d.kind].includes(k) || typeof v !== 'string' || v.length > 200000,
      )
    )
      throw new Error('草稿包含不支持的字段或内容过长。');
    if (d.kind !== 'editor' && !d.opportunityId) throw new Error('草稿缺少对应岗位。');
    const result = structuredClone(d);
    if (d.original !== undefined) {
      if (d.kind !== 'editor' || d.original.id !== d.opportunityId)
        throw new Error('编辑草稿的原记录不匹配。');
      result.original = validateData({
        ...emptyData(),
        opportunities: [d.original],
      }).opportunities[0];
    }
    if (d.kind === 'editor' && d.opportunityId && !d.original)
      throw new Error('编辑草稿缺少原记录版本。');
    return result;
  });
}
