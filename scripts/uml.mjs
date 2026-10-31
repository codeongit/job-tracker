import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { exportGraph } from './uml-viewer/graph.mjs';
import {
  assertCheckout,
  installCheckout,
  prepareDirectory,
  runtimeEnvironment,
  runViewer,
  upstreamRevision,
} from './uml-viewer/runtime.mjs';

const usage = `独立 UML 源码浏览器

pnpm uml setup   获取固定上游版本并准备 JVM 依赖（需要 Java 21+、Clojure CLI）
pnpm uml export  仅用 Node 生成公开源码依赖图
pnpm uml check   生成图并用真实上游做无 GUI 的加载、下钻和隔离检查
pnpm uml open    生成图并前台打开独立桌面查看器（默认）

图和工具位于 .local/uml-viewer/；不启动 Grok、tmux 或项目服务。
修改源码后执行 pnpm uml export，再在查看器按 R 刷新。
详见 docs/MAINTENANCE.md 的“独立 UML 源码浏览器”。`;

export async function main(args, root = fileURLToPath(new URL('../', import.meta.url))) {
  const [mode = 'open', ...rest] = args;
  if (rest.length || !['setup', 'export', 'check', 'open', '--help', '-h'].includes(mode))
    throw new Error(`不支持的 UML 参数。\n${usage}`);
  if (mode === '--help' || mode === '-h') {
    console.log(usage);
    return;
  }
  const directory = await prepareDirectory(root);
  const output = join(directory, 'diagram.edn');
  if (mode === 'export') {
    console.log(JSON.stringify(await exportGraph(root, output)));
    return;
  }
  const runtime = runtimeEnvironment(directory);
  if (mode === 'setup') {
    await installCheckout(directory);
    runViewer(root, directory, mode, output, runtime);
    console.log(`UML 工具准备完成：${upstreamRevision}。运行 pnpm uml 打开。`);
    return;
  }
  assertCheckout(join(directory, 'upstream'));
  console.log(JSON.stringify(await exportGraph(root, output)));
  runViewer(root, directory, mode, output, runtime);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
