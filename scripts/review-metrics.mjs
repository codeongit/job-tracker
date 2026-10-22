import { readFile, writeFile, mkdir, rename, rm, readdir, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const HELP = `审查统计（仅本机；记录在 .local/reviews/<编号>/）

pnpm review:metrics start --case "案例名称" --type docs|code|mixed [--parent 原审查编号]
pnpm review:metrics finish <编号> --input /绝对路径/首报.json
pnpm review:metrics feedback <编号> --input /绝对路径/反馈.json
pnpm review:metrics stats

start 保存开始时间以及当时实际使用的技能、流程副本。由主代理串行维护同一编号；
审查按返回目录中的 rules/ 版本执行。准备材料存放在该目录，不依赖临时目录。
--parent 用于修复后复查，首次审查和复查分别统计。

finish 输入示例：
{
  "snapshot": {"base":"已解析的基线提交或本目录基线摘要", "target":"受审提交或本目录 manifest 的 SHA256", "scope":"范围与限制"},
  "report":"首次汇总报告的 Markdown 正文，包括两个审查轴",
  "findings":[{"id":"F1","category":"defect","summary":"触发条件和影响","verdict":"pending","evidence":"尚缺复现"}]
}
category：defect（缺陷候选）、suggestion（建议）、out_of_scope（范围外问题）。
只有 defect 提供 verdict 与 evidence；verdict 为 pending、valid 或 false_alarm，
后两者必须提供非空证据。相同编号的相同明细去重；同编号内容不一致须先合并证据。
snapshot 的材料须由代理固定并保存在记录目录；本工具不判断证据是否真实充分。
首报正文与时间只写一次；重复 finish 只接受相同内容，修复不撤销原有效发现。

feedback 输入示例（各部分可分别提供）：
{
  "findings":[{"id":"F1","verdict":"valid","evidence":"已保存的复现或契约依据"}],
  "misses":[{"id":"M1","summary":"原版本遗漏","evidence":"原版本复现与范围依据","present_in_reviewed_version":true,"in_scope":true}],
  "followup":{"scope":"本次实际核对的范围","evidence":"复核记录引用"}
}
单项反馈不代表整次复核；只有显式 followup 才记录复核日期与范围。
后来确认的遗漏不加入首次报告有效数。新回归归属新版本，建议和范围外问题不计缺陷。
误报占比为确认误报／（确认有效＋确认误报），零分母无法计算。
没有完整缺陷集不计算漏报率。
首报经过时间从准备材料到首次汇总报告，包含等待及首报前穿插的修复，并行时间不相加。
它不是纯审查用时；缺失不估算，不扣除修复时间。反馈不改写计时，修复后复查另建关联记录。
stats 按变更类型、技能和流程版本、首次或复查分组；范围是否可比仍须人工判断。
至少 5 个可比较的已完成样本才汇总；未知版本单列，不用于效果比较。

一次性迁移已有全零文档记录：
pnpm review:metrics import-legacy --source /绝对路径/旧目录 --case "旧案例名称"
保留原报告、版本清单、差异、受审副本及必要基线；排除候选副本、依赖和日志。
旧耗时保留来源；不补时间戳、不推定执行技能版本。重复导入同一份证据不新增样本。`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => {
  throw new Error(message);
};
const string = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label}必须是非空字符串。`);
};
const exact = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象。`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}含未知字段：${key}`);
};
function identifier(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(id))
    fail('审查或问题编号无效。');
  return id;
}
function options(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key) || Object.hasOwn(result, key)) fail(`未知或重复参数：${key}`);
    string(args[i + 1], key);
    result[key] = args[i + 1];
  }
  return result;
}
async function json(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail(`无法读取有效 JSON：${path}`);
  }
}
function timestamp(value) {
  if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value))))
    fail('记录时间格式无效。');
}
async function loadRecord(store, id) {
  const record = await json(join(store, identifier(id), 'record.json'));
  return validateRecord(record, id);
}
function validateRecord(record, id) {
  exact(
    record,
    [
      'schema_version',
      'id',
      'case_name',
      'change_type',
      'parent_id',
      'rules',
      'started_at',
      'first_report_at',
      'first_report',
      'feedback',
      'legacy',
    ],
    '审查记录',
  );
  if (record.schema_version !== 1) fail('不支持的审查记录版本。');
  if (record.id !== id) fail('记录编号与目录不一致。');
  string(record.case_name, '案例名称');
  if (!['docs', 'code', 'mixed'].includes(record.change_type)) fail('记录变更类型无效。');
  if (record.parent_id !== null) identifier(record.parent_id);
  exact(record.rules, ['skill', 'workflow'], '规则版本');
  for (const digest of [record.rules.skill, record.rules.workflow]) {
    if (digest !== null && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))
      fail('规则版本哈希无效。');
  }
  timestamp(record.started_at);
  timestamp(record.first_report_at);
  if (record.first_report !== null) validateReport(record.first_report);
  else if (record.first_report_at !== null) fail('缺少首次报告。');
  if (!Array.isArray(record.feedback)) fail('反馈记录必须是数组。');
  const preceding = { ...record, feedback: [] };
  for (const event of record.feedback) {
    exact(event, ['at', 'input'], '反馈事件');
    string(event.at, '反馈时间');
    timestamp(event.at);
    if (!record.first_report) fail('未完成记录不能包含反馈。');
    validateFeedback(event.input, preceding);
    preceding.feedback.push(event);
  }
  if (record.legacy !== null) {
    exact(record.legacy, ['source', 'imported_at', 'elapsed_minutes', 'duration_note'], '迁移来源');
    string(record.legacy.source, '旧记录来源');
    timestamp(record.legacy.imported_at);
    if (
      record.legacy.elapsed_minutes !== null &&
      (!Number.isFinite(record.legacy.elapsed_minutes) || record.legacy.elapsed_minutes < 0)
    )
      fail('旧记录耗时无效。');
    string(record.legacy.duration_note, '旧计时说明');
  }
  return record;
}
async function save(directory, record) {
  validateRecord(record, record.id);
  const temporary = join(directory, `.record-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, join(directory, 'record.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}
// Publish complete new records together with their evidence. A failed start/import
// must not leave a directory that stats mistakes for a damaged existing record.
async function publish(store, record, files) {
  await mkdir(store, { recursive: true });
  const staging = join(dirname(store), `.review-new-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const [name, bytes] of files) {
      const target = join(staging, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    await save(staging, record);
    await rename(staging, join(store, record.id));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
function validateReport(input) {
  exact(input, ['snapshot', 'report', 'findings'], '首报');
  exact(input.snapshot, ['base', 'target', 'scope'], '版本依据');
  for (const key of ['base', 'target', 'scope']) string(input.snapshot[key], key);
  string(input.report, '报告');
  if (!Array.isArray(input.findings)) fail('findings 必须是数组。');
  const findings = unique(
    input.findings.map((item) => {
      exact(item, ['id', 'category', 'summary', 'verdict', 'evidence'], '发现');
      identifier(item.id);
      string(item.summary, '问题摘要');
      if (!['defect', 'suggestion', 'out_of_scope'].includes(item.category)) fail('发现分类无效。');
      if (item.category === 'defect') validateVerdict(item);
      else if (item.verdict !== undefined || item.evidence !== undefined)
        fail('建议与范围外问题不参与缺陷判定。');
      return item;
    }),
  );
  return { ...input, findings };
}
function unique(items) {
  const byId = new Map();
  for (const item of items) {
    if (byId.has(item.id) && !isDeepStrictEqual(byId.get(item.id), item))
      fail(`编号 ${item.id} 冲突，请先合并同根因证据。`);
    byId.set(item.id, item);
  }
  return [...byId.values()];
}
function validateVerdict(item) {
  if (!['valid', 'false_alarm', 'pending'].includes(item.verdict))
    fail('判定必须为 valid、false_alarm 或 pending。');
  if (item.verdict !== 'pending') string(item.evidence, '判定证据');
  else if (item.evidence !== undefined && typeof item.evidence !== 'string')
    fail('证据必须是字符串。');
}
function validateFeedback(input, record) {
  exact(input, ['findings', 'misses', 'followup'], '反馈');
  if (!Object.keys(input).length) fail('反馈不能为空。');
  const original = new Map(record.first_report.findings.map((item) => [item.id, item]));
  const findings = input.findings === undefined ? [] : input.findings;
  const misses = input.misses === undefined ? [] : input.misses;
  if (!Array.isArray(findings) || !Array.isArray(misses)) fail('反馈明细必须是数组。');
  for (const item of findings) {
    exact(item, ['id', 'verdict', 'evidence'], '问题反馈');
    if (original.get(item.id)?.category !== 'defect') fail(`不是首次报告的缺陷编号：${item.id}`);
    validateVerdict(item);
  }
  for (const item of misses) {
    exact(item, ['id', 'summary', 'evidence', 'present_in_reviewed_version', 'in_scope'], '遗漏');
    identifier(item.id);
    string(item.summary, '遗漏摘要');
    string(item.evidence, '遗漏证据');
    if (original.has(item.id)) fail('首次报告已有的编号不能同时计为遗漏。');
    if (item.present_in_reviewed_version !== true || item.in_scope !== true)
      fail('遗漏必须确认存在于受审版本且属于约定范围。');
  }
  unique([...record.feedback.flatMap((event) => event.input.misses ?? []), ...misses]);
  if (input.followup !== undefined) {
    exact(input.followup, ['scope', 'evidence'], '复核');
    string(input.followup.scope, '复核范围');
    string(input.followup.evidence, '复核证据');
  }
  return {
    findings: unique(findings),
    misses: unique(misses),
    ...(input.followup ? { followup: input.followup } : {}),
  };
}
function summary(record) {
  const minutes = record.legacy
    ? record.legacy.elapsed_minutes
    : record.first_report_at === null || record.started_at === null
      ? null
      : (Date.parse(record.first_report_at) - Date.parse(record.started_at)) / 60000;
  const findings = new Map((record.first_report?.findings ?? []).map((item) => [item.id, item]));
  const misses = new Map();
  let followup = null;
  for (const event of record.feedback) {
    for (const update of event.input.findings)
      findings.set(update.id, { ...findings.get(update.id), ...update });
    for (const item of event.input.misses) misses.set(item.id, item);
    if (event.input.followup) followup = { ...event.input.followup, at: event.at };
  }
  const items = [...findings.values()];
  const count = (verdict) =>
    items.filter((item) => item.category === 'defect' && item.verdict === verdict).length;
  const valid = count('valid'),
    falseAlarm = count('false_alarm');
  const elapsed = minutes !== null && Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
  return {
    valid,
    false_alarm: falseAlarm,
    pending: count('pending'),
    suggestions: items.filter((item) => item.category === 'suggestion').length,
    out_of_scope: items.filter((item) => item.category === 'out_of_scope').length,
    misses: misses.size,
    followup,
    false_alarm_ratio: valid + falseAlarm ? falseAlarm / (valid + falseAlarm) : null,
    elapsed_minutes: elapsed,
    timing_status: !record.first_report
      ? 'unfinished'
      : elapsed !== null
        ? record.legacy
          ? 'legacy'
          : 'measured'
        : minutes === null
          ? 'missing'
          : 'invalid',
  };
}
function describe(record) {
  const result = summary(record);
  const timing = { unfinished: '未完成', invalid: '时间异常', missing: '无法取得' }[
    result.timing_status
  ];
  return `${record.id}｜${record.case_name}｜有效 ${result.valid}｜误报 ${result.false_alarm}｜待确认 ${result.pending}｜建议 ${result.suggestions}｜范围外 ${result.out_of_scope}｜已知遗漏 ${result.misses}｜${result.followup ? '截至 ' + result.followup.at + ' 已核对复核范围：' + result.followup.scope : '尚未复核'}｜首报经过时间 ${timing ?? result.elapsed_minutes.toFixed(1) + ' 分钟'}${record.legacy ? '（旧记录口径）' : ''}`;
}
function groupRecords(records) {
  const groups = new Map();
  for (const entry of records) {
    const { record } = entry;
    const phase = record.parent_id ? 'recheck' : 'first';
    const known = Boolean(record.rules.skill && record.rules.workflow);
    const key = JSON.stringify([record.change_type, phase, record.rules, known ? '' : record.id]);
    if (!groups.has(key))
      groups.set(key, {
        change_type: record.change_type,
        phase,
        rules: record.rules,
        known,
        entries: [],
      });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()].map(({ entries, ...group }) => {
    const completed = entries.filter(({ record }) => record.first_report);
    const durations = completed
      .map(({ summary: item }) => item.elapsed_minutes)
      .filter((n) => n !== null)
      .sort((a, b) => a - b);
    const sums = Object.fromEntries(
      ['valid', 'false_alarm', 'pending', 'suggestions', 'out_of_scope', 'misses'].map((key) => [
        key,
        completed.reduce((sum, entry) => sum + entry.summary[key], 0),
      ]),
    );
    const middle = Math.floor(durations.length / 2);
    return {
      ...group,
      total: entries.length,
      completed: completed.length,
      timed: durations.length,
      followed_up: completed.filter(({ summary: item }) => item.followup).length,
      aggregate:
        group.known && completed.length >= 5
          ? {
              ...sums,
              false_alarm_ratio:
                sums.valid + sums.false_alarm
                  ? sums.false_alarm / (sums.valid + sums.false_alarm)
                  : null,
              median_minutes: !durations.length
                ? null
                : durations.length % 2
                  ? durations[middle]
                  : (durations[middle - 1] + durations[middle]) / 2,
            }
          : null,
    };
  });
}

// Legacy imports are deliberately limited to the existing zero-finding document reviews.
// A reviewed skill snapshot is evidence, not proof of the skill actually executed.
async function importLegacy(store, source, caseName, at) {
  const read = async (name, optional = false) => {
    let path = source;
    for (const part of ['', ...name.split('/')]) {
      path = join(path, part);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (optional && error.code === 'ENOENT') return null;
        throw error;
      }
      if (info.isSymbolicLink()) fail(`旧材料含符号链接：${name}`);
    }
    return readFile(path);
  };
  const resultBytes = await read('review-result.json');
  const manifestBytes = await read('review-manifest.json');
  const original = JSON.parse(resultBytes);
  const manifest = JSON.parse(manifestBytes);
  for (const key of [
    'confirmed_valid',
    'confirmed_false_alarm',
    'unresolved',
    'later_known_misses',
  ]) {
    if (original[key] !== 0) fail('此迁移仅接受已有的全零文档记录；有发现的记录需要原始问题明细。');
  }
  const duration = original.elapsed_minutes;
  if (duration !== null && (!Number.isFinite(duration) || duration < 0))
    fail('旧耗时无效，不能估算。');
  exact(manifest, Object.keys(manifest), '旧版本清单');
  if (!Object.keys(manifest).length) fail('旧版本清单为空。');
  const paths = Object.keys(manifest);
  for (const path of paths) {
    if (
      !/^(?:docs\/|\.agents\/skills\/).+\.(?:md|yaml|yml)$/.test(path) ||
      path.split('/').some((part) => !part || part === '..' || part === '.')
    )
      fail(`不是受支持的公开文档路径：${path}`);
  }
  const files = new Map([
    ['review-result.json', resultBytes],
    ['review-manifest.json', manifestBytes],
  ]);
  for (const name of ['review.diff', 'started.json', 'baseline-commit.txt']) {
    const bytes = await read(name, name !== 'review.diff');
    if (bytes !== null) files.set(name, bytes);
  }
  const evidencePaths = new Set([
    ...paths,
    '.agents/skills/code-review/SKILL.md',
    'docs/agents/change-workflow.md',
  ]);
  for (const path of evidencePaths) {
    for (const prefix of ['baseline', 'review']) {
      const name = `${prefix}/${path}`;
      const bytes = await read(name, prefix !== 'review' || !paths.includes(path));
      if (bytes === null) continue;
      if (prefix === 'review' && paths.includes(path) && hash(bytes) !== manifest[path])
        fail(`受审材料与清单不一致：${path}`);
      files.set(name, bytes);
    }
  }
  const started = files.has('started.json')
    ? JSON.parse(files.get('started.json')).review_started_utc
    : null;
  const ended = original.first_consolidated_report_utc ?? null;
  timestamp(started);
  timestamp(ended);
  const digest = hash(
    Buffer.concat(
      [...files.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([name, bytes]) => [Buffer.from(name + '\0'), Buffer.from(hash(bytes))]),
    ),
  );
  const id = `legacy-${digest.slice(0, 24)}`;
  const directory = join(store, id);
  try {
    await lstat(directory);
    return loadRecord(store, id);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const record = {
    schema_version: 1,
    id,
    case_name: caseName,
    change_type: 'docs',
    parent_id: null,
    rules: { skill: null, workflow: null },
    started_at: started,
    first_report_at: ended,
    first_report: {
      snapshot: {
        base:
          original.case_version?.base ??
          files.get('baseline-commit.txt')?.toString().trim() ??
          '未知（原记录未提供提交）',
        target: `sha256:${hash(manifestBytes)}`,
        scope: paths.join('、'),
      },
      report: resultBytes.toString(),
      findings: [],
    },
    feedback: [],
    legacy: {
      source,
      imported_at: at,
      elapsed_minutes: duration,
      duration_note:
        original.duration_note || '沿用旧报告耗时；缺失时间戳不倒算，执行技能版本未知。',
    },
  };
  await publish(
    store,
    record,
    [...files].map(([name, bytes]) => [`legacy/${name}`, bytes]),
  );
  return record;
}

export async function runReviewMetrics(
  args,
  { root = projectRoot, now = () => new Date(), write = console.log } = {},
) {
  const [command, ...rest] = args;
  const store = join(root, '.local/reviews');
  if (command === '--help' || command === undefined) {
    options(rest, []);
    write(HELP);
    return { help: HELP };
  }
  if (command === 'import-legacy') {
    const opts = options(rest, ['--source', '--case']);
    string(opts['--source'], '--source');
    string(opts['--case'], '案例名称');
    const record = await importLegacy(
      store,
      resolve(opts['--source']),
      opts['--case'],
      now().toISOString(),
    );
    write(describe(record));
    return { record, summary: summary(record) };
  }
  if (command === 'start') {
    const opts = options(rest, ['--case', '--type', '--parent']);
    string(opts['--case'], '案例名称');
    if (!['docs', 'code', 'mixed'].includes(opts['--type']))
      fail('--type 使用 docs、code 或 mixed。');
    if (opts['--parent']) {
      const parent = await loadRecord(store, opts['--parent']);
      if (!parent.first_report) fail('复查须关联已有首次报告的记录。');
    }
    const startedAt = now().toISOString();
    const skill = await readFile(join(root, '.agents/skills/code-review/SKILL.md'), 'utf8');
    const workflow = await readFile(join(root, 'docs/agents/change-workflow.md'), 'utf8');
    const record = {
      schema_version: 1,
      id: randomUUID(),
      case_name: opts['--case'],
      change_type: opts['--type'],
      parent_id: opts['--parent'] ?? null,
      rules: { skill: hash(skill), workflow: hash(workflow) },
      started_at: startedAt,
      first_report_at: null,
      first_report: null,
      feedback: [],
      legacy: null,
    };
    const directory = join(store, record.id);
    await publish(store, record, [
      ['rules/SKILL.md', skill],
      ['rules/change-workflow.md', workflow],
    ]);
    write(`开始审查：${record.id}\n记录目录：${directory}`);
    return { record, summary: summary(record) };
  }
  if (command === 'finish') {
    const [id, ...flags] = rest;
    const directory = join(store, identifier(id));
    const opts = options(flags, ['--input']);
    string(opts['--input'], '--input');
    const record = await loadRecord(store, id);
    const input = validateReport(await json(resolve(opts['--input'])));
    if (record.first_report) {
      if (!isDeepStrictEqual(record.first_report, input))
        fail('首报已固定；判定更新请用 feedback，新版本请用 start。');
    } else {
      record.first_report = input;
      record.first_report_at = now().toISOString();
      await save(directory, record);
    }
    write(describe(record));
    return { record, summary: summary(record) };
  }
  if (command === 'feedback') {
    const [id, ...flags] = rest;
    const directory = join(store, identifier(id));
    const opts = options(flags, ['--input']);
    string(opts['--input'], '--input');
    const record = await loadRecord(store, id);
    if (!record.first_report) fail('尚无首次报告，不能登记反馈。');
    const input = validateFeedback(await json(resolve(opts['--input'])), record);
    if (!isDeepStrictEqual(record.feedback.at(-1)?.input, input)) {
      record.feedback.push({ at: now().toISOString(), input });
      await save(directory, record);
    }
    write(describe(record));
    return { record, summary: summary(record) };
  }
  if (command === 'stats') {
    options(rest, []);
    let names;
    try {
      names = await readdir(store);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      names = [];
    }
    const records = [];
    for (const id of names.sort()) {
      const record = await loadRecord(store, id);
      records.push({ record, summary: summary(record) });
    }
    const groups = groupRecords(records);
    write(`审查记录共 ${records.length} 次。`);
    for (const { record } of records) write(describe(record));
    for (const group of groups) {
      write(
        `${group.change_type}／${group.phase === 'first' ? '首次审查' : '复查'}／${group.known ? '技能 ' + group.rules.skill.slice(0, 12) + '，流程 ' + group.rules.workflow.slice(0, 12) : '技能或流程版本未知，单列'}：总样本 ${group.total}，已完成 ${group.completed}，已复核 ${group.followed_up}，首报经过时间有效样本 ${group.timed}`,
      );
      if (!group.aggregate) write('仅展示明细；版本未知或可比较的已完成样本不足 5 次。');
      else {
        const a = group.aggregate;
        write(
          `误报占比 ${a.false_alarm_ratio === null ? '无法计算' : (a.false_alarm_ratio * 100).toFixed(1) + '%'}（${a.false_alarm}/${a.valid + a.false_alarm}），待确认 ${a.pending}，已知遗漏 ${a.misses}，首报经过时间中位数 ${a.median_minutes === null ? '无法取得' : a.median_minutes.toFixed(1) + ' 分钟'}。`,
        );
      }
    }
    write('已知遗漏不等于全部遗漏；没有完整缺陷集，不计算漏报率。');
    return { records, groups };
  }
  fail('未知命令。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runReviewMetrics(process.argv.slice(2));
  } catch (error) {
    console.error(`审查统计失败：${error.message}`);
    process.exitCode = 1;
  }
}
