import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REPO = 'codeongit/job-tracker';
const TARGET = `github.com/${REPO}`;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHA = /^[a-f0-9]{40}$/;
const FIELDS =
  'number,url,state,isDraft,isCrossRepository,headRefOid,baseRefName,baseRefOid,mergeable,mergeStateStatus,reviewDecision,latestReviews,mergedAt,mergeCommit';
const USAGE =
  '用法：pnpm pr:merge <PR编号> --head <已审查完整SHA> --base <已核对main完整SHA> [--execute] [--wait <0-600秒>]\n默认只读检查；已有独立审查、适用验收和用户合并授权后，才使用 --execute。\n--wait 默认 0 秒，只等待 CI 或合并状态；单个命令另有 30 秒超时。\n退出码：0 检查就绪或已合并，1 执行前阻断，2 请求后尚未确认，3 已合并但有待处理项。';

function command(executable, args, input) {
  return spawnSync(executable, args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}
function parse(argv) {
  if (!/^[1-9]\d*$/.test(argv[0] ?? '')) throw new Error(USAGE);
  const options = { pr: Number(argv[0]), execute: false, wait: 0 };
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (!['--head', '--base', '--execute', '--wait'].includes(key) || seen.has(key))
      throw new Error(`未知或重复参数：${key}。\n${USAGE}`);
    seen.add(key);
    if (key === '--execute') options.execute = true;
    else options[key.slice(2)] = argv[++i];
  }
  if (
    !Number.isSafeInteger(options.pr) ||
    !SHA.test(options.head ?? '') ||
    !SHA.test(options.base ?? '') ||
    !/^\d+$/.test(String(options.wait)) ||
    Number(options.wait) > 600
  )
    throw new Error(USAGE);
  options.wait = Number(options.wait);
  return options;
}

function validateIdentity(pr, options) {
  if (
    pr?.number !== options.pr ||
    pr.url !== `https://github.com/${REPO}/pull/${options.pr}` ||
    pr.isCrossRepository !== false ||
    pr.baseRefName !== 'main'
  )
    throw new Error('PR 仓库、编号或目标分支不符合当前命令范围。');
  if (pr.headRefOid !== options.head)
    throw new Error('PR 提交已变化，请回到原流程核对受影响结果。');
}

function validatePR(pr, options) {
  validateIdentity(pr, options);
  if (pr.baseRefOid !== options.base) throw new Error('PR 基线已变化，请核对受影响结果。');
  if (pr.state !== 'OPEN' || pr.isDraft !== false) throw new Error('PR 必须处于开放且非草稿状态。');
  if (pr.mergeable === 'CONFLICTING') throw new Error('PR 存在合并冲突。');
  if (
    !['', 'APPROVED'].includes(pr.reviewDecision) ||
    !Array.isArray(pr.latestReviews) ||
    pr.latestReviews.some((review) => review.state === 'CHANGES_REQUESTED')
  )
    throw new Error('PR 存在未满足的审查状态，请返回原有审查流程。');
}

function pendingReason(pr, checks) {
  if (!Array.isArray(checks)) throw new Error('CI 返回格式无效。');
  if (
    checks.some(
      (check) =>
        !['pass', 'pending'].includes(check.bucket) ||
        (check.bucket === 'pass' && check.state !== 'SUCCESS'),
    )
  )
    throw new Error('CI 存在失败、取消、跳过或无法确认成功的检查。');
  if (checks.some((check) => check.bucket === 'pending')) return 'CI 尚未完成';
  if (
    !['push', 'pull_request'].every((event) =>
      checks.some(
        (check) =>
          check.name === 'verify' &&
          check.workflow === 'CI' &&
          check.event === event &&
          check.state === 'SUCCESS',
      ),
    )
  )
    return '缺少 CI/verify 的 push 或 pull_request 成功结果';
  if (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN')
    return 'GitHub 合并状态尚未确定';
  if (pr.mergeable !== 'MERGEABLE' || pr.mergeStateStatus !== 'CLEAN')
    throw new Error('GitHub 当前不允许直接合并，请核对阻断状态。');
  return null;
}

export async function runMerge(argv, { run = command, sleep = delay, now = Date.now } = {}) {
  if (argv.length === 1 && argv[0] === '--help')
    return { status: 'help', exitCode: 0, message: USAGE };
  let options,
    attempted = false;
  try {
    options = parse(argv);
    const identity = {
      pr: options.pr,
      head: options.head,
      base: options.base,
      url: `https://github.com/${REPO}/pull/${options.pr}`,
    };
    const decode = (value) => {
      try {
        return JSON.parse(value);
      } catch {
        throw new Error('GitHub 返回了无效 JSON。');
      }
    };
    const json = (args) => {
      const result = run('gh', args);
      if (result.status !== 0) throw new Error('GitHub 查询失败，请核对网络、gh 登录和权限。');
      return decode(result.stdout);
    };
    const api = (path) => json(['api', '--hostname', 'github.com', `repos/${REPO}/${path}`]);
    const readPR = () =>
      json(['pr', 'view', String(options.pr), '--repo', TARGET, '--json', FIELDS]);
    const finishMerged = (confirmed) => {
      validateIdentity(confirmed, options);
      if (
        confirmed.state !== 'MERGED' ||
        !SHA.test(confirmed.mergeCommit?.oid ?? '') ||
        typeof confirmed.mergedAt !== 'string' ||
        !Number.isFinite(Date.parse(confirmed.mergedAt))
      )
        throw new Error('尚未读回有效合并结果。');
      const mergeCommit = confirmed.mergeCommit.oid;
      const warnings = [];
      try {
        const commit = api(`git/commits/${mergeCommit}`);
        if (
          commit.sha !== mergeCommit ||
          commit.parents?.length !== 2 ||
          commit.parents[0].sha !== options.base ||
          commit.parents[1].sha !== options.head
        )
          warnings.push('已合并，但实际父提交与预期 base/head 不符，需回到原流程核对受影响结果。');
      } catch {
        warnings.push('已合并，但合并父提交未能核对，需回查。');
      }
      if (options.execute) {
        try {
          const remote = run('git', ['remote', 'get-url', 'origin']);
          if (
            remote.status !== 0 ||
            ![
              'git@github.com:codeongit/job-tracker.git',
              'https://github.com/codeongit/job-tracker.git',
              'https://github.com/codeongit/job-tracker',
              'ssh://git@github.com/codeongit/job-tracker.git',
            ].includes(remote.stdout.trim())
          )
            warnings.push('已合并；本地 origin 与目标仓库不符或无法读取，未刷新引用。');
          else if (run('git', ['fetch', 'origin', 'main']).status !== 0)
            warnings.push('已合并，但本地远端引用刷新失败，可单独重试 fetch。');
        } catch {
          warnings.push('已合并，但本地远端引用未能刷新，可单独回查。');
        }
      }
      const mergedAt =
        new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(confirmed.mergedAt)) + ' +08:00';
      return {
        status: 'merged',
        exitCode: warnings.length ? 3 : 0,
        ...identity,
        mergeCommit,
        mergedAt,
        warnings,
      };
    };
    const end = now() + options.wait * 1000;
    while (true) {
      const current = readPR();
      if (current.state === 'MERGED') return finishMerged(current);
      validatePR(current, options);
      const checkResult = run('gh', [
        'pr',
        'checks',
        String(options.pr),
        '--repo',
        TARGET,
        '--json',
        'name,state,bucket,workflow,event',
      ]);
      if (![0, 1, 8].includes(checkResult.status))
        throw new Error('CI 查询失败，请核对网络、gh 登录和权限。');
      const checks =
        checkResult.status === 1 && !checkResult.stdout.trim() ? [] : decode(checkResult.stdout);
      if (
        checkResult.status !== 0 &&
        (!Array.isArray(checks) ||
          (checks.length > 0 && checks.every((check) => check.bucket === 'pass')))
      )
        throw new Error('CI 查询退出状态与检查结果不一致。');
      const latest = readPR();
      if (latest.state === 'MERGED') return finishMerged(latest);
      validatePR(latest, options);
      if (api('branches/main').commit?.sha !== options.base)
        throw new Error('main 已变化，请核对受影响结果。');
      const pending = pendingReason(latest, checks);
      if (!pending) break;
      if (now() >= end) throw new Error(`${pending}；等待预算已用完，本次未合并。`);
      await sleep(Math.min(5000, end - now()));
    }
    if (!options.execute) return { status: 'ready', exitCode: 0, ...identity };
    // GitHub 的 sha 条件约束 head；base 并非原子条件，合并后另核对实际父提交。
    attempted = true;
    try {
      run(
        'gh',
        [
          'api',
          '--hostname',
          'github.com',
          '--method',
          'PUT',
          `repos/${REPO}/pulls/${options.pr}/merge`,
          '--input',
          '-',
        ],
        JSON.stringify({ sha: options.head, merge_method: 'merge' }),
      );
    } catch {
      // 传输失败不能证明远端未应用；下面仍独立回读，且本次不重发。
    }
    return finishMerged(readPR());
  } catch (error) {
    return {
      status: attempted ? 'unconfirmed' : 'blocked',
      exitCode: attempted ? 2 : 1,
      ...(options ? { pr: options.pr, head: options.head, base: options.base } : {}),
      message: attempted
        ? '合并请求已发出，尚未确认结果；请先回查 PR 状态，再决定后续操作。'
        : error.message,
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runMerge(process.argv.slice(2));
  process.stdout.write(
    result.status === 'help' ? `${result.message}\n` : `${JSON.stringify(result, null, 2)}\n`,
  );
  process.exitCode = result.exitCode;
}
