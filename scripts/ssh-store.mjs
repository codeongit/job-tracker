import { MAX_SYNC_BYTES, serializeForSync } from '../dist/limits.js';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyData, validateData } from '../dist/model.js';
export class BridgeError extends Error {
  constructor(message, status = 503, code = 'SSH_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function runGit(args, { cwd, input, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '-c',
        'core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=10',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '',
      bytes = 0,
      expired = false,
      overflow = false;
    const chunks = [];
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGKILL');
    }, 90000);
    child.stdout.on('data', (b) => {
      bytes += b.length;
      if (bytes > 6_000_000) {
        overflow = true;
        child.kill('SIGKILL');
      } else chunks.push(b);
    });
    child.stderr.on('data', (b) => {
      if (stderr.length < 12000) stderr += b;
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new BridgeError('本机无法执行 Git，请安装 Git 后重试。', 503, 'GIT_NOT_FOUND'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (overflow) {
        reject(new BridgeError('Git 输出超过允许大小。', 413, 'OUTPUT_LIMIT'));
        return;
      }
      try {
        stdout = decodeGitOutput(chunks);
      } catch (e) {
        reject(e);
        return;
      }
      if (code === 0) resolve(stdout);
      else {
        const race = /non-fast-forward|fetch first|\[rejected\]|stale info/.test(
          stdout + '\n' + stderr,
        );
        reject(classifyGitFailure({ stdout, stderr, expired, race }));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// The HTTP layer supplies fixed trusted configuration; browser input never selects remote/path.
export class GitStore {
  constructor({ cache, remote, path, checkPrivate = async () => {} }) {
    this.cache = cache;
    this.remote = remote;
    this.path = path;
    this.checkPrivate = checkPrivate;
    this.queue = Promise.resolve();
  }
  git(args, options = {}) {
    return runGit(args, { cwd: this.cache, ...options });
  }
  exclusive(fn) {
    const job = this.queue.then(async () => {
      await mkdir(this.cache, { recursive: true, mode: 0o700 });
      const lockPath = join(this.cache, 'bridge.lock');
      let lock;
      try {
        lock = await open(lockPath, 'wx', 0o600);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let stale = false;
        try {
          const pid = Number(await readFile(lockPath, 'utf8'));
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (e) {
              stale = e.code === 'ESRCH';
            }
          }
        } catch {}
        if (!stale) throw new BridgeError('另一个本机服务正在同步，请稍后重试。', 409);
        await unlink(lockPath);
        lock = await open(lockPath, 'wx', 0o600);
      }
      try {
        await lock.writeFile(String(process.pid));
        return await fn();
      } finally {
        await lock.close();
        await unlink(lockPath).catch(() => {});
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async initialize() {
    try {
      await readFile(join(this.cache, 'HEAD'), 'utf8');
    } catch {
      await this.git(['init', '--bare', '--quiet']);
      await this.git(['remote', 'add', 'origin', this.remote]);
      await this.git(['config', 'remote.origin.promisor', 'true']);
      await this.git(['config', 'remote.origin.partialclonefilter', 'blob:none']);
    }
    if ((await this.git(['remote', 'get-url', 'origin'])).trim() !== this.remote)
      throw new BridgeError('缓存仓库与配置不一致，请检查本地配置。', 400, 'CACHE_TARGET_MISMATCH');
  }
  async fetchHead() {
    await this.checkPrivate();
    await this.initialize();
    if (!this.branch) {
      const refs = await this.git(['ls-remote', '--symref', 'origin', 'HEAD']);
      this.branch = refs.match(/^ref: (refs\/heads\/[^\s]+)\s+HEAD$/m)?.[1];
      if (!this.branch)
        throw new BridgeError(
          '远端仓库尚无默认分支，请先初始化 README。',
          400,
          'REMOTE_UNINITIALIZED',
        );
      await this.git(['check-ref-format', this.branch]);
    }
    await this.git(['fetch', '--quiet', '--depth=1', '--filter=blob:none', 'origin', this.branch]);
    return (await this.git(['rev-parse', 'FETCH_HEAD'])).trim();
  }
  async fileAt(head) {
    const entry = await this.git(['ls-tree', '-z', head, '--', this.path]);
    if (!entry) return { data: emptyData(), sha: null, missing: true };
    const match = entry.match(/^100(?:644|755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/);
    if (!match || match[2] !== this.path)
      throw new BridgeError('目标路径不是普通 JSON 文件，已停止同步。', 400);
    const sha = match[1],
      size = Number((await this.git(['cat-file', '-s', sha])).trim());
    if (size > MAX_SYNC_BYTES) throw new BridgeError('云端数据文件超过 5 MB，已停止同步。', 413);
    let data;
    try {
      data = validateData(JSON.parse(await this.git(['cat-file', 'blob', sha])));
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw new BridgeError('云端 JSON 校验失败，已保留本地数据并停止同步。', 400);
    }
    return { data, sha, missing: false };
  }
  read() {
    return this.exclusive(async () => this.fileAt(await this.fetchHead()));
  }
  write(data, sha) {
    return this.exclusive(async () => {
      let text;
      try {
        text = serializeForSync(data);
      } catch (e) {
        throw new BridgeError(e.message, e.status || 400, 'DATA_INVALID');
      }
      const head = await this.fetchHead(),
        current = await this.fileAt(head);
      if (current.sha !== sha)
        throw new BridgeError('云端文件版本已变化，请重新同步。', 409, 'VERSION_CONFLICT');
      const blob = (await this.git(['hash-object', '-w', '--stdin'], { input: text })).trim();
      if (blob === current.sha) return { sha: blob, commit: head };
      const index = join(this.cache, `index-${randomUUID()}`),
        env = { GIT_INDEX_FILE: index };
      try {
        await this.git(['read-tree', head], { env });
        await this.git(['update-index', '--add', '--cacheinfo', '100644', blob, this.path], {
          env,
        });
        const tree = (await this.git(['write-tree'], { env })).trim();
        const commit = (
          await this.git([
            '-c',
            'user.name=Job Tracker',
            '-c',
            'user.email=job-tracker@localhost',
            'commit-tree',
            tree,
            '-p',
            head,
            '-m',
            'Update job tracker data',
          ])
        ).trim();
        const changed = await this.git([
          'diff-tree',
          '--no-commit-id',
          '--name-only',
          '-z',
          '-r',
          head,
          commit,
        ]);
        if (changed !== this.path + '\0')
          throw new BridgeError('提交包含目标文件之外的变化，已停止推送。', 400);
        await this.git(['push', '--porcelain', 'origin', `${commit}:${this.branch}`]);
        return { sha: blob, commit };
      } finally {
        await unlink(index).catch(() => {});
        await unlink(index + '.lock').catch(() => {});
      }
    });
  }
}

export function createSshStore(config, cache, fetcher = fetch) {
  const { owner, repo, path } = config;
  if (
    !/^[A-Za-z0-9][\w.-]*$/.test(owner) ||
    !/^[A-Za-z0-9][\w.-]*$/.test(repo) ||
    !path ||
    !path.endsWith('.json') ||
    path.split('/').some((p) => !p || p === '.' || p === '..') ||
    /[\0\r\n]/.test(path)
  )
    throw new BridgeError('本地 SSH 同步配置无效。', 400);
  return new GitStore({
    cache,
    path,
    remote: `git@github.com:${owner}/${repo}.git`,
    checkPrivate: async () => {
      // SSH verifies existence/access. Unauthenticated metadata detects a public repository without a PAT.
      let response;
      try {
        response = await fetcher(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          {
            headers: { Accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(15000),
          },
        );
      } catch {
        throw new BridgeError('无法核实仓库可见性，请检查网络后重试。', 503, 'VISIBILITY_NETWORK');
      }
      if (response.status === 404) return;
      if (response.ok)
        throw new BridgeError('目标仓库可公开访问，已停止上传求职数据。', 403, 'PUBLIC_REPOSITORY');
      if ([403, 429].includes(response.status))
        throw new BridgeError(
          'GitHub 可见性检查被限流，请稍后重试。',
          503,
          'VISIBILITY_RATE_LIMIT',
        );
      throw new BridgeError('暂时无法核实仓库可见性，请稍后重试。', 503, 'VISIBILITY_UNAVAILABLE');
    },
  });
}

export function classifyGitFailure({ stdout = '', stderr = '', expired = false, race = false }) {
  const text = stdout + '\n' + stderr;
  if (race || /non-fast-forward|fetch first|\[rejected\]|stale info/.test(text))
    return new BridgeError('云端刚发生更新，请重新同步。', 409, 'VERSION_CONFLICT');
  if (expired) return new BridgeError('SSH 操作超时，请检查网络后重试。', 503, 'SSH_TIMEOUT');
  if (/Permission denied \(publickey\)/i.test(text))
    return new BridgeError(
      'SSH key 未获授权，请检查系统 SSH agent 和 GitHub SSH keys。',
      503,
      'SSH_AUTH_FAILED',
    );
  if (/Host key verification failed/i.test(text))
    return new BridgeError(
      'SSH 主机校验失败，请在终端核实 GitHub 主机指纹。',
      503,
      'SSH_HOST_VERIFICATION',
    );
  if (/Repository not found|Could not read from remote repository/i.test(text))
    return new BridgeError('无法访问数据仓库，请检查仓库名和账号权限。', 503, 'REPOSITORY_ACCESS');
  if (
    /Could not resolve hostname|Connection (?:timed out|refused)|Network is unreachable/i.test(text)
  )
    return new BridgeError('无法连接 GitHub，请检查网络。', 503, 'SSH_NETWORK');
  return new BridgeError(
    'SSH 操作失败；本地数据保留。请按维护文档检查 Git、网络和仓库配置。',
    503,
    'SSH_FAILED',
  );
}

export function decodeGitOutput(chunks) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new BridgeError('Git 返回了无效的 UTF-8 文本，已停止读取。', 400, 'INVALID_UTF8');
  }
}
