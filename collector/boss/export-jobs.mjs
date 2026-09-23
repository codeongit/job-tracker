import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareSnapshots } from './compare.mjs';
import { latest } from './storage.mjs';
import { resolveJobRowsV2 } from './model-v2.mjs';
import { accountDataDirectory } from './paths.mjs';

function cell(value, fallback = '待补') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\|`*_~\[\]!]/g, '\\$&');
}

function observationTime(record, evidence) {
  const job = record.job;
  if (!job || (!job.name && !job.detailUrl)) return '待补';
  const matches = evidence.filter(
    (item) =>
      item &&
      typeof item === 'object' &&
      item.key === record.key &&
      item.company === record.company &&
      item.job?.name === job.name &&
      item.job?.detailUrl === job.detailUrl,
  );
  if (matches.length > 1) return '观测时间待核验';
  const value = matches[0]?.observedAt;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return '未记录独立时间';
  return cell(value);
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DETAIL_URL = /^https:\/\/www\.zhipin\.com\/job_detail\/[A-Za-z0-9_-]+\.html$/;

function validTime(value) {
  return typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));
}

function optionalText(value, path, max = 1000, allowEmpty = false) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    (!allowEmpty && !value) ||
    value.length > max
  ) {
    throw new TypeError(`${path} must be null or a nonempty trimmed string`);
  }
  return value;
}

function normalizedV2View(envelope, resolveV2) {
  if (typeof resolveV2 !== 'function')
    throw new TypeError('A resolveV2 callback is required for a version-2 envelope');
  const resolved = resolveV2(envelope);
  const rows = Array.isArray(resolved) ? resolved : resolved?.rows;
  if (!Array.isArray(rows))
    throw new TypeError('resolveV2 must return rows or { rows, capturedAt }');
  const capturedAt = Array.isArray(resolved)
    ? (envelope?.state?.lastCapturedAt ??
      envelope?.chatState?.lastCapturedAt ??
      envelope?.updatedAt)
    : (resolved.capturedAt ??
      envelope?.state?.lastCapturedAt ??
      envelope?.chatState?.lastCapturedAt ??
      envelope?.updatedAt);
  if (!validTime(capturedAt))
    throw new TypeError('The resolved v2 view requires a valid capturedAt');
  const seen = new Set();
  const normalized = rows.map((row, index) => {
    const path = `resolved.rows[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new TypeError(`${path} must be an object`);
    const conversationKey = optionalText(row.conversationKey, `${path}.conversationKey`);
    if (conversationKey === null) throw new TypeError(`${path}.conversationKey is required`);
    if (seen.has(conversationKey))
      throw new TypeError('The resolved v2 view contains a duplicate conversationKey');
    seen.add(conversationKey);
    const contact = optionalText(row.contact, `${path}.contact`, 300, true);
    const company = optionalText(row.company, `${path}.company`, 500, true);
    const jobId = optionalText(row.jobId, `${path}.jobId`, 256);
    const detailUrl = optionalText(row.detailUrl, `${path}.detailUrl`, 1000);
    if (
      detailUrl !== null &&
      (!DETAIL_URL.test(detailUrl) || new URL(detailUrl).href !== detailUrl)
    ) {
      throw new TypeError(`${path}.detailUrl is not a canonical BOSS job-detail URL`);
    }
    if (jobId !== null && !/^[A-Za-z0-9_-]+$/.test(jobId))
      throw new TypeError(`${path}.jobId is invalid`);
    if (jobId !== null && detailUrl !== null && !detailUrl.endsWith(`/${jobId}.html`)) {
      throw new TypeError(`${path}.jobId does not match detailUrl`);
    }
    if (![null, 'current', 'historical'].includes(row.associationStatus ?? null)) {
      throw new TypeError(`${path}.associationStatus is invalid`);
    }
    const jobName = optionalText(row.jobName, `${path}.jobName`, 300);
    const nameSource = optionalText(row.nameSource, `${path}.nameSource`, 100);
    const nameObservedAt = row.nameObservedAt ?? null;
    if (nameObservedAt !== null && !validTime(nameObservedAt))
      throw new TypeError(`${path}.nameObservedAt is invalid`);
    const confirmation = row.confirmation ?? null;
    if (![null, 'confirmed_user', 'unverified'].includes(confirmation))
      throw new TypeError(`${path}.confirmation is invalid`);
    if (!Array.isArray(row.candidates)) throw new TypeError(`${path}.candidates must be an array`);
    const candidates = row.candidates.map((candidate, candidateIndex) => {
      const candidatePath = `${path}.candidates[${candidateIndex}]`;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
        throw new TypeError(`${candidatePath} must be an object`);
      const observedAt = candidate.observedAt;
      if (!validTime(observedAt)) throw new TypeError(`${candidatePath}.observedAt is invalid`);
      return {
        name: optionalText(candidate.name, `${candidatePath}.name`, 300),
        observedCompany: optionalText(
          candidate.observedCompany,
          `${candidatePath}.observedCompany`,
          300,
        ),
        observedAt,
        source: optionalText(candidate.source, `${candidatePath}.source`, 100),
        reason: optionalText(candidate.reason, `${candidatePath}.reason`, 100),
      };
    });
    return {
      conversationKey,
      contact,
      company,
      jobId,
      detailUrl,
      associationStatus: row.associationStatus ?? null,
      jobName,
      nameSource,
      nameObservedAt,
      confirmation,
      candidates,
    };
  });
  return {
    capturedAt,
    rows: normalized.sort((a, b) => a.conversationKey.localeCompare(b.conversationKey)),
  };
}

function v2Status(row) {
  const association =
    row.associationStatus === 'current'
      ? '当前关联'
      : row.associationStatus === 'historical'
        ? '历史证据（本次未观察到）'
        : '关联状态待核对';
  if (!row.candidates.length) return association;
  const candidates = row.candidates.map((candidate) =>
    ['company_mismatch', 'detail_company_mismatch'].includes(candidate.reason)
      ? `候选“${candidate.name}”（页面公司：${candidate.observedCompany}，与会话公司不同）`
      : `候选“${candidate.name}”（${candidate.reason}）`,
  );
  return `${association}；${candidates.join('；')}`;
}

function v2EvidenceTimes(row) {
  const values = [];
  if (row.nameObservedAt) values.push(`名称：${row.nameObservedAt}`);
  for (const candidate of row.candidates) values.push(`候选：${candidate.observedAt}`);
  return values.length ? values.join('；') : '待补';
}

function renderV2Jobs(envelope, resolveV2) {
  const { capturedAt, rows } = normalizedV2View(envelope, resolveV2);
  const named = rows.filter((row) => row.jobName).length;
  const linked = rows.filter((row) => row.detailUrl).length;
  const confirmed = rows.filter(
    (row) => row.detailUrl && row.confirmation === 'confirmed_user',
  ).length;
  const candidateCount = rows.reduce((sum, row) => sum + row.candidates.length, 0);
  const historical = rows.filter((row) => row.associationStatus === 'historical').length;
  const lines = [
    '# BOSS 岗位清单',
    '',
    `已加载会话视图共 ${rows.length} 条；已记录岗位名称 ${named} 条、详情链接 ${linked} 条、用户确认链接 ${confirmed} 条、待核对名称候选 ${candidateCount} 条。历史关联 ${historical} 条。`,
    '',
    `聊天基线采集时间（capturedAt）：\`${capturedAt}\`。岗位名称与候选使用各自的证据时间，不以聊天时间代替。`,
    '',
    '“历史证据”表示本次页面未观察到该岗位关联，但证据仍被保留；“候选”不计入已命名，也不代表用户确认。',
    '',
    '| 公司 | 联系人 | 岗位名称 | 名称来源 | 岗位／候选状态 | 详情链接 | 链接确认状态 | 岗位证据时间 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const link = row.detailUrl ? `[查看岗位](${row.detailUrl})` : '待补';
    const confirmation = !row.detailUrl
      ? '待补'
      : row.confirmation === 'confirmed_user'
        ? '用户已确认（仅本链接）'
        : row.confirmation === 'unverified'
          ? '尚未人工确认'
          : '确认状态待补';
    lines.push(
      `| ${cell(row.company)} | ${cell(row.contact)} | ${cell(row.jobName)} | ${cell(row.nameSource)} | ${cell(v2Status(row))} | ${link} | ${confirmation} | ${cell(v2EvidenceTimes(row))} |`,
    );
  }
  lines.push(
    '',
    '本清单仅导出岗位及关联联系人信息，不包含聊天正文、消息摘要、Cookie 或登录凭据。',
    '',
  );
  return lines.join('\n');
}

/** Render only the current baseline's job directory; never render chat content. */
export function renderJobs(envelope, { resolveV2 = resolveJobRowsV2 } = {}) {
  if ([2, 3].includes(envelope?.version)) return renderV2Jobs(envelope, resolveV2);
  if (!envelope || typeof envelope !== 'object' || envelope.version !== 1 || !envelope.snapshot) {
    throw new TypeError('A version-1 or resolvable version-2 snapshot envelope is required');
  }
  // Validate fields and canonical URLs without using or persisting a new state.
  compareSnapshots(null, envelope.snapshot);
  const evidence = envelope.jobEnrichments ?? [];
  if (!Array.isArray(evidence)) throw new TypeError('jobEnrichments must be an array');
  const records = envelope.snapshot.records;
  const linked = records.filter((record) => record.job?.detailUrl).length;
  const named = records.filter((record) => record.job?.name).length;
  const confirmed = records.filter(
    (record) => record.job?.detailUrl && record.job.detailUrlConfirmation === 'confirmed_user',
  ).length;
  const pending = records.filter(
    (record) => record.job?.detailUrl && record.job.detailUrlConfirmation === 'pending_user',
  ).length;
  const lines = [
    '# BOSS 岗位清单',
    '',
    `当前基线共 ${records.length} 条会话；已记录岗位名称 ${named} 条、详情链接 ${linked} 条。已由用户确认的链接 ${confirmed} 条，待逐条人工确认的链接 ${pending} 条。缺失字段明确标为“待补”。`,
    '',
    `原消息快照采集时间（capturedAt）：\`${envelope.snapshot.capturedAt}\`。此时间属于原收件箱消息快照，不代表全部岗位在同一时刻完成观察。`,
    '',
    '岗位证据有独立的 observedAt，见表格“岗位观测时间”；未记录独立时间时不使用原消息时间代替。时间保留原 ISO 时区标记，Z 表示 UTC。',
    '',
    '“用户已确认”仅适用于该行的具体链接，不推广到其他岗位。pending_user 显示为“页面已提取，未逐条人工确认”，不表示用户已经审核。',
    '',
    '| 公司 | 联系人 | 岗位名称 | 详情链接 | 链接确认状态 | 岗位观测时间 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const record of records) {
    const job = record.job;
    const link = job?.detailUrl ? `[查看岗位](${job.detailUrl})` : '待补';
    const confirmation = !job?.detailUrl
      ? '待补'
      : job.detailUrlConfirmation === 'confirmed_user'
        ? '用户已确认（仅本条）'
        : job.detailUrlConfirmation === 'pending_user'
          ? '页面已提取，未逐条人工确认'
          : '确认状态待补';
    lines.push(
      `| ${cell(record.company)} | ${cell(record.contact)} | ${cell(job?.name)} | ${link} | ${confirmation} | ${observationTime(record, evidence)} |`,
    );
  }
  lines.push(
    '',
    '本清单仅导出当前基线的公司、联系人和岗位信息，不包含聊天正文、消息摘要或回执。',
    '',
  );
  return lines.join('\n');
}

export async function writePrivateMarkdown(outputPath, markdown) {
  if (typeof outputPath !== 'string' || !outputPath || typeof markdown !== 'string') {
    throw new TypeError('outputPath and markdown must be strings');
  }
  const temporary = join(dirname(outputPath), `.jobs-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(markdown, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // Atomic replacement also ensures an older permissive output is replaced
    // by this newly created 0600 file, without touching any source JSON.
    await rename(temporary, outputPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: node export-jobs.mjs\nRead the latest private main-account snapshot and write jobs.md (0600). No browser connection.',
    );
    return;
  }
  if (args.length) throw new TypeError('No arguments are accepted except --help');
  const directory = accountDataDirectory('main');
  const saved = await latest(directory);
  if (!saved) throw new Error('NO_SAVED_BASELINE');
  const markdown = renderJobs(saved.envelope);
  const outputPath = join(directory, 'jobs.md');
  await writePrivateMarkdown(outputPath, markdown);
  console.log(
    JSON.stringify({
      ok: true,
      records: saved.envelope.snapshot.records.length,
      output: outputPath,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      'EXPORT_JOBS_FAILED: no directory was exported; check the saved snapshot and output permissions.',
    );
    process.exitCode = 1;
  });
}
