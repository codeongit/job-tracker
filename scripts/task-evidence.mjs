import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const checkPattern = /^[a-z][a-z0-9-]{0,63}$/;
const policyPaths = [
  'package.json',
  'pnpm-lock.yaml',
  '.gitignore',
  '.github/workflows',
  'scripts/check.mjs',
  'scripts/docs-check.mjs',
  'scripts/module-check.mjs',
  'scripts/format-skills.mjs',
  'scripts/owned-skills.mjs',
  'scripts/task-evidence.mjs',
];
const toolPath = fileURLToPath(import.meta.url);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => hash(JSON.stringify(value) ?? 'undefined');
const same = (left, right) => digest(left) === digest(right);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function publicPath(value) {
  assert(typeof value === 'string' && value.length <= 1024, '输入路径必须是短的仓库相对路径。');
  const parts = value.split('/');
  assert(
    value &&
      !isAbsolute(value) &&
      !/[\\\u0000-\u001f]/.test(value) &&
      parts.every((part) => part && part !== '.' && part !== '..'),
    '输入路径不能包含绝对路径、回退或非规范分隔符。',
  );
  assert(
    !parts.some((part) =>
      /^(?:\.git|\.local|\.codex|\.aws|\.ssh|node_modules|\.sites-runtime|test-results|playwright-report)$/i.test(
        part,
      ),
    ) &&
      !parts.some((part) => /^\.env(?:\.|$)/i.test(part) && part !== '.env.example') &&
      !(parts[0] === '.agents' && parts[1] !== 'skills') &&
      !(
        value.startsWith('collector/boss/') &&
        parts.slice(2).some((part) => /^(?:data|profile|profiles|cdp|skills)$/i.test(part))
      ),
    '不能将私有目录、凭据路径或运行状态用作公开输入。',
  );
  return value;
}

function paths(value, name) {
  assert(
    Array.isArray(value) && value.length > 0 && value.length <= 256,
    `${name} 必须是非空路径数组。`,
  );
  value.forEach(publicPath);
  assert(new Set(value).size === value.length, `${name} 不能重复。`);
}

function declaration(value) {
  const keys = ['schema_version', 'goal', 'sources', 'rules', 'review_inputs', 'checks'];
  assert(value && typeof value === 'object' && !Array.isArray(value), '声明必须是 JSON 对象。');
  assert(
    Object.keys(value).every((key) => keys.includes(key)),
    '声明含未知字段。',
  );
  assert(value.schema_version === 1, '不支持的声明版本。');
  assert(
    typeof value.goal === 'string' && value.goal.trim() && value.goal.length <= 10000,
    'goal 必填。',
  );
  assert(
    Array.isArray(value.sources) &&
      value.sources.length > 0 &&
      value.sources.length <= 256 &&
      value.sources.every(
        (source) => typeof source === 'string' && source.trim() && source.length <= 10000,
      ),
    'sources 必须列出原始目标及验收依据的可定位引用；引用内容不由工具读取。',
  );
  paths(value.rules, 'rules');
  paths(value.review_inputs, 'review_inputs');
  assert(
    Array.isArray(value.checks) && value.checks.length > 0 && value.checks.length <= 128,
    'checks 必须非空。',
  );
  for (const check of value.checks) {
    assert(
      check &&
        Object.keys(check).every((key) => ['id', 'command', 'inputs'].includes(key)) &&
        typeof check.id === 'string' &&
        checkPattern.test(check.id),
      '检查必须有唯一的小写 id，且只能包含 id、command、inputs。',
    );
    assert(
      Array.isArray(check.command) &&
        check.command.length > 0 &&
        check.command.length <= 128 &&
        check.command.every(
          (item) => typeof item === 'string' && item.length <= 10000 && !item.includes('\0'),
        ) &&
        check.command[0],
      'command 必须是非空 argv 数组。',
    );
    paths(check.inputs, 'inputs');
  }
  assert(
    new Set(value.checks.map((check) => check.id)).size === value.checks.length,
    '检查 id 重复。',
  );
  return value;
}

// Reject links in every repository-relative component, including local output.
// This is an accidental-drift guard, not protection against a concurrent hostile writer.
async function inspect(root, path) {
  let absolute = root;
  for (const part of path.split('/')) {
    const names = await readdir(absolute).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (!names.includes(part)) {
      assert(
        !names.some((name) => name.toLowerCase() === part.toLowerCase()),
        '路径大小写不匹配。',
      );
      return null;
    }
    absolute = join(absolute, part);
    const info = await lstat(absolute);
    assert(!info.isSymbolicLink(), `路径不能包含符号链接：${path}`);
  }
  const info = await lstat(absolute);
  assert(info.isDirectory() || info.isFile(), `路径不是普通文件或目录：${path}`);
  return info;
}

async function readJSON(root, path, limit = 16 * 1024 * 1024) {
  const info = await inspect(root, path);
  assert(info?.isFile() && info.size <= limit, `JSON 文件不可用或过大：${path}`);
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

async function saveJSON(root, path, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  assert(Buffer.byteLength(content) <= 16 * 1024 * 1024, '证据记录超过 16 MiB；请缩小声明范围。');
  await inspect(root, path);
  await mkdir(dirname(join(root, path)), { recursive: true });
  await inspect(
    root,
    relative(root, dirname(join(root, path)))
      .split(sep)
      .join('/'),
  );
  await writeFile(join(root, path), content, { flag: 'wx', mode: 0o600 });
}

function publicFiles(root) {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert(result.status === 0 && !result.error, '无法读取 Git 公开文件清单。');
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
}

function ignoredInputs(root, inputs) {
  const result = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
    cwd: root,
    input: `${[...new Set(inputs)].join('\0')}\0`,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert([0, 1].includes(result.status) && !result.error, '无法核对 Git 忽略路径。');
  return new Set(result.stdout.split('\0').filter(Boolean));
}

async function scope(root, inputs, files, ignored, required = false) {
  const result = Object.create(null);
  for (const path of [...inputs].sort()) {
    publicPath(path);
    assert(!ignored.has(path), `不能声明 Git 忽略的输入：${path}`);
    const info = await inspect(root, path);
    assert(!required || info, `输入不存在：${path}`);
    if (!info) {
      result[path] = { type: 'missing' };
      continue;
    }
    const selected = files.filter(
      (file) => file === path || (info.isDirectory() && file.startsWith(`${path}/`)),
    );
    assert(!info.isFile() || selected.includes(path), `输入未被 Git 公开清单包含：${path}`);
    const members = Object.create(null);
    for (const file of selected) {
      // Ignored/private members of a broad source directory are never read.
      try {
        publicPath(file);
      } catch {
        continue;
      }
      const member = await inspect(root, file);
      if (!member) continue;
      assert(member.isFile() && member.size <= 32 * 1024 * 1024, `输入必须是有界普通文件：${file}`);
      members[file] = hash(await readFile(join(root, file)));
    }
    result[path] = { type: info.isFile() ? 'file' : 'directory', members };
  }
  return result;
}

async function state(root, input, required = false) {
  const value = declaration(await readJSON(root, input, 256 * 1024));
  const files = publicFiles(root);
  const policy = [
    ...new Set([
      ...policyPaths,
      ...(await readdir(root)).filter((name) => /^\.prettier|^prettier\.config\./.test(name)),
    ]),
  ].sort();
  const ignored = ignoredInputs(root, [
    ...policy,
    ...value.rules,
    ...value.review_inputs,
    ...value.checks.flatMap((check) => check.inputs),
  ]);
  const global = {
    goal: value.goal,
    sources: value.sources,
    rules: await scope(root, value.rules, files, ignored, required),
    policy: await scope(root, policy, files, ignored),
    tool: hash(await readFile(toolPath)),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const checks = Object.create(null);
  for (const check of value.checks)
    checks[check.id] = {
      command: check.command,
      inputs: await scope(root, check.inputs, files, ignored, required),
    };
  return {
    declaration: value,
    global,
    review: await scope(root, value.review_inputs, files, ignored, required),
    checks,
  };
}

function taskPath(task) {
  assert(uuidPattern.test(task ?? ''), 'task 必须是小写 UUID。');
  return `.local/tasks/${task}`;
}

async function snapshot(root, task, id) {
  assert(uuidPattern.test(id ?? ''), 'snapshot 必须是小写 UUID。');
  const directory = `${taskPath(task)}/evidence/${id}`;
  const saved = await readJSON(root, `${directory}/snapshot.json`);
  const { digest: storedDigest, ...body } = saved;
  assert(
    saved.schema_version === 1 &&
      saved.task === task &&
      saved.snapshot === id &&
      storedDigest === digest(body),
    '快照损坏。',
  );
  assert(
    dirname(saved.input) === taskPath(task) && saved.input.endsWith('.json'),
    '快照声明路径无效。',
  );
  declaration(saved.state.declaration);
  return { directory, saved };
}

async function capture(root, task, input, reuse) {
  const base = taskPath(task);
  assert(isAbsolute(input ?? ''), '--input 必须是绝对路径。');
  const path = relative(root, join(await realpath(dirname(input)), basename(input)))
    .split(sep)
    .join('/');
  assert(
    dirname(path) === base && path.endsWith('.json'),
    '声明必须直接位于本任务目录内，且在 evidence 输出目录外。',
  );
  const current = await state(root, path, true);
  const id = randomUUID();
  const body = {
    schema_version: 1,
    task,
    snapshot: id,
    captured_at: new Date().toISOString(),
    input: path,
    state: current,
  };
  const saved = { ...body, digest: digest(body) };
  const directory = `${base}/evidence/${id}`;
  await saveJSON(root, `${directory}/snapshot.json`, saved);
  const reused = [];
  if (reuse) {
    const previous = await snapshot(root, task, reuse);
    for (const check of current.declaration.checks) {
      if (!currentCheck(previous.saved, current, check.id)) continue;
      const record = await latestRun(root, previous.directory, check.id);
      if (!validPass(record, previous.saved, current, check.id)) continue;
      const runId = randomUUID();
      const started = {
        schema_version: 1,
        run: runId,
        snapshot_digest: saved.digest,
        check: check.id,
        sequence: 1,
        started_at: record.started_at,
        global_digest: record.global_digest,
        check_digest: record.check_digest,
        reused_at: new Date().toISOString(),
        reused_from: { snapshot: reuse, run: record.run },
      };
      const completed = { ...record, ...started };
      await saveJSON(root, `${directory}/runs/${check.id}/${runId}.started.json`, started);
      await saveJSON(root, `${directory}/runs/${check.id}/${runId}.completed.json`, completed);
      reused.push(check.id);
    }
  }
  return { task, snapshot: id, digest: saved.digest, reused };
}

function currentCheck(saved, current, id) {
  return (
    Object.hasOwn(saved.state.checks, id) &&
    Object.hasOwn(current.checks, id) &&
    same(saved.state.global, current.global) &&
    same(saved.state.checks[id], current.checks[id])
  );
}

async function run(root, task, id, checkId) {
  assert(checkPattern.test(checkId ?? ''), '--check 必须是检查 id。');
  const { directory, saved } = await snapshot(root, task, id);
  assert(Object.hasOwn(saved.state.checks, checkId), '快照中不存在该检查。');
  const before = await state(root, saved.input);
  assert(
    currentCheck(saved, before, checkId),
    '检查依据已变化；先重新 capture，并按影响更新审查。',
  );
  const runs = `${directory}/runs/${checkId}`;
  const runId = randomUUID();
  const started = {
    schema_version: 1,
    run: runId,
    snapshot_digest: saved.digest,
    check: checkId,
    started_at: new Date().toISOString(),
    global_digest: digest(before.global),
    check_digest: digest(before.checks[checkId]),
  };
  // The exclusive lock prevents overlapping attempts from making "latest" ambiguous.
  const lock = `${runs}/active.json`;
  await saveJSON(root, lock, started);
  try {
    const prior = await latestRun(root, directory, checkId, true);
    started.sequence = (prior?.sequence ?? 0) + 1;
    await saveJSON(root, `${runs}/${runId}.started.json`, started);
    const command = saved.state.checks[checkId].command;
    const result = spawnSync(command[0], command.slice(1), {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      timeout: 30 * 60 * 1000,
    });
    let after;
    let stateError = false;
    try {
      after = await state(root, saved.input);
    } catch {
      stateError = true;
    }
    const unchanged = !stateError && currentCheck(saved, after, checkId);
    const record = {
      ...started,
      finished_at: new Date().toISOString(),
      exit_code: result.status,
      signal: result.signal,
      execution_error: result.error?.code ?? null,
      after_global_digest: after ? digest(after.global) : null,
      after_check_digest: after ? digest(after.checks[checkId]) : null,
      state_error: stateError,
      status: !unchanged
        ? 'stale'
        : result.status === 0 && !result.error && !result.signal
          ? 'passed'
          : 'failed',
    };
    await saveJSON(root, `${runs}/${runId}.completed.json`, record);
    return record;
  } finally {
    // An interrupted process may leave this lock. It is never silently recovered:
    // capture a new snapshot after checking the abandoned command has stopped.
    await inspect(root, lock);
    await unlink(join(root, lock));
  }
}

async function latestRun(root, directory, id, ownLock = false) {
  const path = `${directory}/runs/${id}`;
  if (!(await inspect(root, path))) return null;
  const names = await readdir(join(root, path));
  if (!ownLock && names.includes('active.json'))
    return { status: 'missing', reason: '检查仍在执行或被中断。' };
  const starts = [];
  for (const name of names.filter((name) => /^[0-9a-f-]{36}\.started\.json$/.test(name))) {
    const record = await readJSON(root, `${path}/${name}`);
    assert(
      uuidPattern.test(record.run) &&
        record.check === id &&
        Number.isSafeInteger(record.sequence) &&
        record.sequence > 0 &&
        typeof record.started_at === 'string',
      '运行记录损坏。',
    );
    starts.push(record);
  }
  assert(new Set(starts.map((item) => item.sequence)).size === starts.length, '运行次序重复。');
  starts.sort((a, b) => a.sequence - b.sequence);
  const last = starts.at(-1);
  if (!last) return null;
  const completed = `${path}/${last.run}.completed.json`;
  if (!(await inspect(root, completed)))
    return { ...last, status: 'missing', reason: '最近一次检查没有完成记录。' };
  const result = await readJSON(root, completed);
  assert(
    Object.keys(last).every((key) => same(last[key], result[key])),
    '运行记录不匹配。',
  );
  return result;
}

function validPass(record, saved, current, check) {
  return Boolean(
    record?.status === 'passed' &&
    record.snapshot_digest === saved.digest &&
    record.global_digest === digest(current.global) &&
    record.after_global_digest === digest(current.global) &&
    record.check_digest === digest(current.checks[check]) &&
    record.after_check_digest === digest(current.checks[check]) &&
    record.exit_code === 0 &&
    !record.signal &&
    !record.execution_error &&
    !record.state_error,
  );
}

async function verify(root, task, id) {
  const { directory, saved } = await snapshot(root, task, id);
  const current = await state(root, saved.input);
  const globalCurrent = same(saved.state.global, current.global);
  const reviewCurrent = globalCurrent && same(saved.state.review, current.review);
  const checks = [];
  const ids = [
    ...new Set([...Object.keys(saved.state.checks), ...Object.keys(current.checks)]),
  ].sort();
  for (const check of ids) {
    const latest = await latestRun(root, directory, check);
    let status = latest?.status ?? 'missing';
    if (!currentCheck(saved, current, check)) status = 'stale';
    else if (latest && latest.status === 'passed') {
      assert(validPass(latest, saved, current, check), '通过记录与检查依据不匹配。');
    }
    checks.push({ id: check, status, run: latest?.run ?? null });
  }
  return {
    task,
    snapshot: id,
    snapshot_digest: saved.digest,
    current_digest: digest(current),
    policy: same(saved.state.global.policy, current.global.policy) ? 'current' : 'stale',
    rules_and_goal: globalCurrent ? 'current' : 'stale',
    review_snapshot: reviewCurrent ? 'current' : 'stale',
    checks,
    passed: reviewCurrent && checks.every((check) => check.status === 'passed'),
    limitation:
      '仅核对声明范围和本地版本；不证明输入完整、外部引用内容、授权、审查结论或人工验收。',
  };
}

const help = `本地任务证据（Node 24；从 Git 工作区执行）
  capture --task UUID --input /绝对路径/.local/tasks/UUID/evidence-input.json [--reuse SNAPSHOT_UUID]
  run UUID SNAPSHOT_UUID --check ID
  verify UUID SNAPSHOT_UUID

声明字段：schema_version:1、goal:string、sources:string[]、rules:string[]、
review_inputs:string[]、checks:[{id:string,command:string[],inputs:string[]}]
所有数组必填且非空；输入为 Git 可见的公开相对路径，可包含目录。
每个检查均为必需；命令按保存的 argv 执行（shell:false），最长 30 分钟。
--reuse 仅复用指定旧快照中依据仍一致、最近一次完整通过的检查，并保留来源。
verify 非零表示缺失、失败或过期；review_snapshot 只表示版本一致，不表示审查通过。
记录位于 .local/tasks/UUID/evidence/；不保存源文件副本或命令输出。
同权限写入者可修改记录或工具；本工具不是授权、沙箱或防篡改边界。
`;

async function main(args) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) {
    process.stdout.write(help);
    return;
  }
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  assert(git.status === 0, '请在 Git 工作区内执行。');
  const root = await realpath(git.stdout.trim());
  let result;
  if (
    args[0] === 'capture' &&
    [5, 7].includes(args.length) &&
    args[1] === '--task' &&
    args[3] === '--input' &&
    (args.length === 5 || args[5] === '--reuse')
  )
    result = await capture(root, args[2], args[4], args[6]);
  else if (args[0] === 'run' && args.length === 5 && args[3] === '--check') {
    result = await run(root, args[1], args[2], args[4]);
    if (result.status !== 'passed') process.exitCode = 1;
  } else if (args[0] === 'verify' && args.length === 3) {
    result = await verify(root, args[1], args[2]);
    if (!result.passed) process.exitCode = 1;
  } else throw new Error('命令参数无效；使用 --help 查看格式。');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`task-evidence: ${error.message}\n`);
  process.exitCode = 1;
});
