import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const upstreamRevision = 'f65dafe93b3cb1b4e6bb02dbe41503ed05bd9ebf';
export const upstreamRepository = 'https://github.com/unclebob/uml-viewer.git';

function gitOutput(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error || result.status !== 0)
    throw new Error('UML 工具副本不可读取，请运行 pnpm uml setup。');
  return result.stdout.trim();
}

export function assertCheckout(directory, revision = upstreamRevision) {
  if (!existsSync(directory)) throw new Error('UML 工具尚未安装，请运行 pnpm uml setup。');
  if (lstatSync(directory).isSymbolicLink()) throw new Error('UML 工具副本不能使用符号链接。');
  if (gitOutput(directory, ['rev-parse', 'HEAD']) !== revision)
    throw new Error('UML 工具版本不符；请保留旧副本后重新运行 pnpm uml setup。');
  if (gitOutput(directory, ['status', '--porcelain', '--untracked-files=no']))
    throw new Error('UML 工具源码已修改；请保留旧副本后重新运行 pnpm uml setup。');
  // Include ignored files: an extra namespace can affect the JVM classpath.
  if (gitOutput(directory, ['ls-files', '--others', '-z']))
    throw new Error('UML 工具副本含额外文件；请保留旧副本后重新运行 pnpm uml setup。');
}

export async function prepareDirectory(root) {
  let current = root;
  for (const name of ['.local', 'uml-viewer']) {
    current = join(current, name);
    try {
      await mkdir(current);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('UML 本机目录必须是普通目录，不能使用符号链接。');
  }
  return current;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0)
    throw new Error(
      `UML 命令未完成：${command}（${result.error?.code ?? result.status ?? result.signal}）。`,
    );
}

export async function installCheckout(directory) {
  const checkout = join(directory, 'upstream');
  if (!existsSync(checkout)) {
    const temporary = await mkdtemp(join(directory, '.checkout-'));
    try {
      run('git', ['init', '-q', temporary]);
      run('git', ['-C', temporary, 'remote', 'add', 'origin', upstreamRepository]);
      run('git', ['-C', temporary, 'fetch', '--depth=1', 'origin', upstreamRevision]);
      run('git', ['-C', temporary, 'checkout', '--detach', '-q', 'FETCH_HEAD']);
      assertCheckout(temporary);
      await rename(temporary, checkout);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  assertCheckout(checkout);
}

export function runtimeEnvironment(directory) {
  const localJava = join(
    directory,
    'runtime',
    'java',
    ...(process.platform === 'darwin' ? ['Contents', 'Home'] : []),
  );
  const javaHome =
    process.env.UML_JAVA_HOME || (existsSync(localJava) ? localJava : process.env.JAVA_HOME);
  const localClojure = join(directory, 'runtime', 'clojure', 'bin', 'clojure');
  const clojure = process.env.UML_CLOJURE || (existsSync(localClojure) ? localClojure : 'clojure');
  const javaCommand = javaHome ? join(javaHome, 'bin', 'java') : 'java';
  const env = {
    ...process.env,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    // The Clojure CLI prefers JAVA_CMD/PATH over JAVA_HOME on some platforms.
    JAVA_CMD: javaCommand,
    CLJ_CONFIG: join(directory, 'clojure-config'),
    CLJ_CACHE: join(directory, 'clojure-cache'),
  };
  const java = spawnSync(javaCommand, ['-version'], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const version = Number(/version "(\d+)/.exec(java.stderr ?? '')?.[1]);
  if (java.error || java.status !== 0 || version < 21 || !version)
    throw new Error(
      '需要 Java 21 或更高版本；安装后配置 JAVA_HOME 或 UML_JAVA_HOME，详见维护手册。',
    );
  const cli = spawnSync(clojure, ['-Sdescribe'], { env, encoding: 'utf8', timeout: 10_000 });
  if (cli.error || cli.status !== 0 || !cli.stdout.includes(':version'))
    throw new Error('需要 Clojure CLI；安装后放入 PATH 或设置 UML_CLOJURE，详见维护手册。');
  return { clojure, env };
}

export function runViewer(root, directory, mode, diagram, runtime) {
  assertCheckout(join(directory, 'upstream'));
  const quote = JSON.stringify;
  const deps = `{:paths [${quote(join(directory, 'upstream', 'src'))}]
    :mvn/local-repo ${quote(join(directory, 'm2'))}
    :mvn/repos {"central" {:url "https://repo.maven.apache.org/maven2/"}}
    :deps {org.clojure/clojure {:mvn/version "1.12.0"}
           quil/quil {:mvn/version "4.3.1563"}}}`;
  const args = ['-Srepro', '-Sdeps', deps];
  if (mode === 'setup') args.push('-P', '-M');
  else {
    if (mode === 'check') args.push('-J-Djava.awt.headless=true');
    args.push('-M', '-i', join(root, 'scripts', 'uml-viewer', 'standalone.clj'));
    if (mode === 'check')
      args.push('-i', join(root, 'scripts', 'uml-viewer', 'standalone-check.clj'));
    args.push('-m', 'job-tracker.uml-viewer', mode, diagram);
  }
  run(runtime.clojure, args, { cwd: directory, env: runtime.env });
}
