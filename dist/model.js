import { DATA_VERSION } from './version.js';
export const GROUPS = ['opportunities', 'activities', 'tasks', 'imports'];
export const STAGES = ['已触达', '沟通中', '面试中', 'Offer', '已结束'];
export const READ_STATES = ['未读', '已读'];
// Map retired UI values without rewriting sync baselines, backups, or draft originals.
export function getOpportunityStatus({ stage, readState } = {}) {
  return {
    stage: !stage || stage === '待联系' ? '已触达' : stage,
    readState: readState === '已读' ? '已读' : '未读',
  };
}
// Apply the user's BOSS workflow only during explicit edits/confirmations, not data loading.
export function getResumeLinkedStatus(opportunity) {
  if (
    !/^boss(?:直聘)?$/i.test((opportunity.platform || '').replace(/\s/g, '')) ||
    !['已发送', '对方已接收'].includes(opportunity.resumeState)
  )
    return {};
  return {
    readState: '已读',
    stage: getOpportunityStatus(opportunity).stage === '已触达' ? '沟通中' : opportunity.stage,
  };
}
export function getSentResumeStatus(opportunity) {
  const resumeState = opportunity.resumeState === '对方已接收' ? '对方已接收' : '已发送';
  return { resumeState, ...getResumeLinkedStatus({ ...opportunity, resumeState }) };
}
export const emptyData = () => ({
  schemaVersion: DATA_VERSION,
  opportunities: [],
  activities: [],
  tasks: [],
  imports: [],
});
export const clone = (value) => structuredClone(value);
export const uid = () => crypto.randomUUID();
export const live = (rows) => rows.filter((row) => !row.deletedAt);
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export function canonical(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    const rows = value.every((x) => x && typeof x === 'object' && typeof x.id === 'string')
      ? [...value].sort((a, b) => a.id.localeCompare(b.id))
      : value;
    return `[${rows.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const equal = (a, b) => canonical(a) === canonical(b);
export function serialize(data) {
  return (
    JSON.stringify(
      {
        schemaVersion: DATA_VERSION,
        ...Object.fromEntries(
          GROUPS.map((g) => [g, [...data[g]].sort((a, b) => a.id.localeCompare(b.id))]),
        ),
      },
      null,
      2,
    ) + '\n'
  );
}
export function validateData(input, { allowOrphans = false } = {}) {
  if (!input || input.schemaVersion !== DATA_VERSION)
    throw new Error('数据格式或版本不支持，已停止导入/同步。');
  if (Object.keys(input).some((k) => !['schemaVersion', ...GROUPS].includes(k)))
    throw new Error('数据包含未知字段，请更新工作台后重试；原数据未改动。');
  const out = emptyData();
  for (const group of GROUPS) {
    if (!Array.isArray(input[group]) || input[group].length > 50000)
      throw new Error(`数据集合 ${group} 无效。`);
    const ids = new Set();
    for (const item of input[group]) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id))
        throw new Error(`${group} 中存在无效或重复 ID。`);
      ids.add(item.id);
      const fields = {
        opportunities: [
          'id',
          'company',
          'role',
          'platform',
          'source',
          'contact',
          'url',
          'externalId',
          'appliedAt',
          'stage',
          'readState',
          'resumeState',
          'endReason',
          'priority',
          'location',
          'salary',
          'description',
          'notes',
          'rawStatus',
          'createdAt',
          'updatedAt',
          'deletedAt',
        ],
        activities: ['id', 'opportunityId', 'date', 'type', 'text', 'createdAt', 'deletedAt'],
        tasks: [
          'id',
          'opportunityId',
          'text',
          'dueAt',
          'status',
          'createdAt',
          'completedAt',
          'deletedAt',
        ],
        imports: ['id', 'filename', 'year', 'importedAt', 'rawText', 'deletedAt'],
      }[group];
      if (Object.keys(item).some((k) => !fields.includes(k)))
        throw new Error(`${group} 包含未知字段，已停止写入，请更新工作台。`);
      const clean = {};
      for (const field of fields) {
        if (item[field] !== undefined) {
          if (typeof item[field] !== 'string') throw new Error(`${group}.${field} 应为文本。`);
          clean[field] = item[field];
        }
      }
      if (!clean.deletedAt) {
        const required = {
          opportunities: ['company', 'role', 'stage'],
          activities: ['opportunityId', 'text'],
          tasks: ['opportunityId', 'text', 'status'],
          imports: ['filename', 'rawText'],
        }[group];
        if (required.some((f) => !clean[f]?.trim())) throw new Error(`${group} 缺少必要字段。`);
        if (group === 'opportunities' && ![...STAGES, '待联系'].includes(clean.stage))
          throw new Error('存在不支持的招聘阶段。');
        if (group === 'tasks' && !['待办', '完成', '取消'].includes(clean.status))
          throw new Error('存在不支持的任务状态。');
      }
      out[group].push(clean);
    }
  }
  const parentIds = new Set(live(out.opportunities).map((o) => o.id));
  for (const group of ['tasks', 'activities']) {
    if (!allowOrphans && live(out[group]).some((x) => !parentIds.has(x.opportunityId)))
      throw new Error('存在没有对应岗位的任务或记录。');
  }
  return out;
}

// Whole-record conflicts keep related fields together and never use device clocks to choose a winner.
export function mergeData(base, local, remote, choices = {}) {
  const data = emptyData(),
    conflicts = [];
  for (const group of GROUPS) {
    const maps = [base, local, remote].map((d) => new Map(d[group].map((row) => [row.id, row])));
    const ids = [...new Set(maps.flatMap((m) => [...m.keys()]))].sort();
    for (const id of ids) {
      const [b, l, r] = maps.map((m) => m.get(id));
      let chosen;
      if (equal(l, r)) chosen = l;
      else if (equal(l, b)) chosen = r;
      else if (equal(r, b)) chosen = l;
      else {
        const key = `${group}:${id}`;
        if (choices[key] === 'remote') chosen = r;
        else if (choices[key] === 'local') chosen = l;
        else {
          conflicts.push({ key, group, id, base: b, local: l, remote: r });
          chosen = l;
        }
      }
      if (chosen !== undefined) data[group].push(clone(chosen));
    }
  }
  // A delete on one device and a new child record on another must never orphan the child.
  for (const group of ['activities', 'tasks']) {
    for (const child of live(data[group])) {
      const parent = data.opportunities.find((o) => o.id === child.opportunityId);
      if (!parent || parent.deletedAt) {
        const key = `opportunities:${child.opportunityId}`;
        if (!conflicts.some((c) => c.key === key))
          conflicts.push({
            key,
            group: 'opportunities',
            id: child.opportunityId,
            base: base.opportunities.find((o) => o.id === child.opportunityId),
            local: local.opportunities.find((o) => o.id === child.opportunityId),
            remote: remote.opportunities.find((o) => o.id === child.opportunityId),
            relational: true,
          });
      }
    }
  }
  return { data, conflicts };
}

export function removeOpportunity(data, id) {
  const stamp = new Date().toISOString();
  for (const group of ['opportunities', 'activities', 'tasks'])
    for (const row of data[group]) {
      if ((group === 'opportunities' ? row.id : row.opportunityId) === id) row.deletedAt = stamp;
    }
}
export function resolveConflicts(candidate, conflicts, choices) {
  const data = clone(candidate);
  for (const conflict of conflicts) {
    if (!['local', 'remote'].includes(choices[conflict.key]))
      throw new Error('请为每项冲突选择要保留的版本。');
    const value = conflict[choices[conflict.key]],
      rows = data[conflict.group];
    const index = rows.findIndex((r) => r.id === conflict.id);
    if (value) {
      if (index >= 0) rows[index] = clone(value);
      else rows.push(clone(value));
    } else if (index >= 0) rows[index].deletedAt = new Date().toISOString();
  }
  for (const o of data.opportunities.filter((o) => o.deletedAt)) removeOpportunity(data, o.id);
  return validateData(data);
}

async function digest(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
function isoDate(raw, year) {
  if (!/^\d{4}$/.test(raw)) return '';
  const value = `${year}-${raw.slice(0, 2)}-${raw.slice(2)}`;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}
export async function parseMarkdown(
  rawText,
  year = String(new Date().getFullYear()),
  filename = '个人记录.md',
) {
  if (!/^\d{4}$/.test(String(year)) || Number(year) < 1900 || Number(year) > 2100)
    throw new Error('请选择有效的年份。');
  const rows = [];
  for (const line of rawText.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((s) => s.replace(/<br\s*\/?>/gi, '').trim());
    if (cells.length !== 6 || !/^\d{4}$/.test(cells[4])) continue;
    const [company, role, link, platform, date, status] = cells;
    if (!company || !role) throw new Error('有源行缺少公司或岗位，导入已停止。');
    const appliedAt = isoDate(date, year);
    if (!appliedAt) throw new Error(`${company} 的日期 ${date} 无效，请核对年份和源文档。`);
    const url = link.match(/\]\((https?:\/\/[^\s]+)\)/)?.[1] || '';
    const externalId = url.match(/\/job_detail\/([^/?]+)\.html/)?.[1] || '';
    const id = externalId
      ? `boss-${externalId}`
      : `job-${(await digest(`${company}|${role}|${platform}`)).slice(0, 24)}`;
    const stage = ['职位关闭', '回复不合适'].includes(status)
      ? '已结束'
      : /^(沟通中|已沟通|要了简历)/.test(status)
        ? '沟通中'
        : '已触达';
    const opportunity = {
      id,
      company,
      role,
      url,
      platform,
      externalId,
      appliedAt,
      stage,
      source: '',
      contact: '',
      readState: status.startsWith('已读') ? '已读' : '未读',
      resumeState: status.includes('接受简历')
        ? '对方已接收'
        : status.includes('要了简历')
          ? '被索要'
          : '未知',
      endReason: status === '职位关闭' ? '职位关闭' : status === '回复不合适' ? '不匹配/拒绝' : '',
      priority: '普通',
      rawStatus: status,
    };
    const events = [{ date: appliedAt, type: '首次联系', text: '首次联系（原表投递日期）' }];
    for (const part of status.split(/[,，]/)) {
      const match = part.match(/^(\d{4})(.*)$/);
      if (match) {
        const eventDate = isoDate(match[1], year);
        if (!eventDate) throw new Error(`${company} 的事件日期 ${match[1]} 无效。`);
        events.push({ date: eventDate, type: '导入记录', text: match[2] });
      } else if (part !== '沟通中') events.push({ date: '', type: '导入记录', text: part });
    }
    const activities = [];
    for (const e of events)
      activities.push({
        ...e,
        id: `event-${(await digest(`${id}|${e.date}|${e.text}`)).slice(0, 24)}`,
        opportunityId: id,
      });
    rows.push({
      opportunity,
      activities,
      raw: line,
      issue: company.includes('工程师') && !role.includes('工程师') ? '公司和岗位可能填反' : '',
    });
  }
  if (!rows.length) throw new Error('没有找到包含公司、岗位、链接、渠道、日期、状态六列的记录。');
  return {
    rows,
    batch: {
      id: `import-${await digest(`${year}\n${rawText}`)}`,
      filename,
      year: String(year),
      rawText,
      importedAt: new Date().toISOString(),
    },
  };
}
export function applyImport(data, parsed, selected, swaps = []) {
  const result = clone(data);
  let added = 0,
    skipped = 0;
  for (const row of parsed.rows) {
    if (!selected.includes(row.opportunity.id)) continue;
    if (result.opportunities.some((o) => o.id === row.opportunity.id)) {
      skipped++;
      continue;
    }
    const o = clone(row.opportunity);
    if (swaps.includes(o.id)) [o.company, o.role] = [o.role, o.company];
    result.opportunities.push(o);
    result.activities.push(...clone(row.activities));
    added++;
  }
  if (added && !result.imports.some((i) => i.id === parsed.batch.id))
    result.imports.push(clone(parsed.batch));
  return { data: validateData(result), added, skipped };
}
export function markdownExport(data) {
  const escape = (s) =>
    String(s || '')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '<br>');
  let out =
    '# 求职记录\n\n| 公司 | 岗位 | 阶段 | 消息 | 简历 | 首次联系 | 下一步 |\n| --- | --- | --- | --- | --- | --- | --- |\n';
  for (const o of live(data.opportunities)) {
    const status = getOpportunityStatus(o);
    const tasks = live(data.tasks).filter((t) => t.opportunityId === o.id && t.status === '待办');
    out +=
      '| ' +
      [
        o.company,
        o.role,
        status.stage,
        status.readState,
        o.resumeState,
        o.appliedAt,
        tasks.map((t) => `${t.dueAt || '未定日期'} ${t.text}`).join('；'),
      ]
        .map(escape)
        .join(' | ') +
      ' |\n';
  }
  for (const o of live(data.opportunities)) {
    out += `\n## ${escape(o.company)} · ${escape(o.role)}\n\n`;
    if (o.url) out += `岗位链接：${o.url}\n\n`;
    for (const a of live(data.activities)
      .filter((a) => a.opportunityId === o.id)
      .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')))
      out += `- ${a.date || '日期未记录'}：${escape(a.text)}\n`;
  }
  return out;
}
