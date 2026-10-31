import { readFile, readdir } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  productionRoots,
  inside,
  ignoredPath,
  productionPath,
  productionFile,
  dynamicUse,
  parseModules,
  createModuleInspector,
} from './module-source.mjs';

const diagnosticLeaves = new Set(['scripts/boss/shared/diagnostics.mjs']);

function browserClient(file) {
  return file === 'dist/boss/client.js' || file.startsWith('dist/boss/client/');
}

function foundation(file) {
  return file.startsWith('dist/boss/contracts/') || file.startsWith('dist/boss/rules/');
}

function application(file) {
  return file.startsWith('dist/boss/application/');
}

function sharedState(file) {
  return (
    file === 'dist/model.js' ||
    file === 'dist/storage.js' ||
    file.startsWith('dist/model/') ||
    file.startsWith('dist/storage/')
  );
}

function firstPath(graph, start, forbidden) {
  const visited = new Set([start]);
  const queue = [[start]];
  for (let at = 0; at < queue.length; at++) {
    const path = queue[at];
    for (const target of [...(graph.get(path.at(-1)) ?? [])].sort()) {
      if (forbidden(target)) return [...path, target];
      if (!visited.has(target)) {
        visited.add(target);
        queue.push([...path, target]);
      }
    }
  }
  return null;
}

function cycles(graph) {
  const index = new Map(),
    low = new Map(),
    stack = [],
    active = new Set(),
    result = [];
  let next = 0;
  function visit(file) {
    index.set(file, next);
    low.set(file, next++);
    stack.push(file);
    active.add(file);
    for (const target of [...graph.get(file)].filter((value) => graph.has(value)).sort()) {
      if (!index.has(target)) {
        visit(target);
        low.set(file, Math.min(low.get(file), low.get(target)));
      } else if (active.has(target)) low.set(file, Math.min(low.get(file), index.get(target)));
    }
    if (low.get(file) === index.get(file)) {
      const group = [];
      let member;
      do {
        member = stack.pop();
        active.delete(member);
        group.push(member);
      } while (member !== file);
      if (group.length > 1 || graph.get(file).has(file)) result.push(group.sort());
    }
  }
  for (const file of [...graph.keys()].sort()) if (!index.has(file)) visit(file);
  return result;
}

// Static import/re-export/side-effect edges are exhaustive for the supported
// syntax. This does not execute code or prove runtime purity, identifier scope,
// computed global access, browser behavior, or paths passed to spawn/evaluate.
// New dynamic loaders/executors are rejected for explicit architectural review.
export async function checkModules(rootURL) {
  const root = resolve(fileURLToPath(rootURL));
  const findings = [];
  const add = (file, code, message, line = 1) => findings.push({ file, line, code, message });
  const display = (path) => relative(root, path).split(sep).join('/') || '.';
  const inspect = createModuleInspector();
  const rootInfo = await inspect(root);
  if (rootInfo.code || !rootInfo.info?.isDirectory()) {
    add(
      '.',
      rootInfo.code ?? 'MODULE_NOT_DIRECTORY',
      '模块根路径必须是大小写准确、无符号链接的目录。',
    );
    return findings;
  }
  const sources = [];
  async function collect(path) {
    const inspected = await inspect(path);
    if (inspected.code) {
      add(display(path), inspected.code, `生产路径不可用：${display(inspected.path)}`);
      return;
    }
    if (inspected.info.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        if (!ignoredPath(`${display(path)}/${name}`)) await collect(join(path, name));
    } else if (productionFile(display(path))) {
      if (!inspected.info.isFile()) {
        add(display(path), 'MODULE_NOT_FILE', '生产模块必须是普通文件。');
        return;
      }
      try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
        sources.push({ file: display(path), source });
      } catch {
        add(display(path), 'MODULE_SOURCE_UNREADABLE', '生产模块无法按 UTF-8 读取。');
      }
    }
  }
  for (const directory of productionRoots) {
    const path = join(root, directory),
      inspected = await inspect(path);
    if (inspected.code === 'MODULE_MISSING') continue;
    await collect(path);
  }
  let metadata;
  try {
    metadata = parseModules(sources);
  } catch {
    add('.', 'MODULE_PARSER_FAILED', 'Node 24 的静态模块解析子进程未成功。');
    return findings;
  }
  const graph = new Map(sources.map(({ file }) => [file, new Set()]));
  for (const { file, source } of sources) {
    const dynamic = dynamicUse(source);
    if (dynamic)
      add(
        file,
        'MODULE_DYNAMIC_CODE',
        `动态加载或执行语法需明确审查：${dynamic.value}`,
        source.slice(0, dynamic.offset).split('\n').length,
      );
  }
  for (const { file, requests, parseError } of metadata) {
    if (parseError) {
      add(file, 'MODULE_PARSE_ERROR', 'JavaScript 模块语法无效。');
      continue;
    }
    for (const specifier of requests) {
      if (isBuiltin(specifier)) {
        graph.get(file).add(specifier.startsWith('node:') ? specifier : `node:${specifier}`);
        if (file.startsWith('dist/'))
          add(file, 'MODULE_NODE_IN_BROWSER', `浏览器模块不能引用 Node 内置模块：${specifier}`);
        continue;
      }
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        graph.get(file).add(`external:${specifier}`);
        add(file, 'MODULE_EXTERNAL_IMPORT', `不支持外部或绝对模块引用：${specifier}`);
        continue;
      }
      let target;
      try {
        target = fileURLToPath(new URL(specifier, pathToFileURL(join(root, file))));
      } catch {
        add(file, 'MODULE_SPECIFIER_INVALID', `模块路径无法解析：${specifier}`);
        continue;
      }
      if (!inside(root, target)) {
        add(file, 'MODULE_OUTSIDE_ROOT', `模块引用越过项目根目录：${specifier}`);
        continue;
      }
      const dependency = display(target);
      // Reject private/test/foreign scopes before looking at their filesystem.
      if (!productionPath(dependency)) {
        add(file, 'MODULE_OUTSIDE_PRODUCTION', `模块引用不属于生产源码：${dependency}`);
        continue;
      }
      const inspected = await inspect(target);
      if (inspected.code) {
        add(file, inspected.code, `模块引用路径不可用：${specifier}`);
        continue;
      }
      if (!inspected.info.isFile()) {
        add(file, 'MODULE_NOT_FILE', `模块引用不是普通文件：${specifier}`);
        continue;
      }
      if (!productionFile(dependency) || !['.js', '.mjs'].includes(extname(target))) {
        add(file, 'MODULE_OUTSIDE_PRODUCTION', `模块引用不属于生产源码：${dependency}`);
        continue;
      }
      graph.get(file).add(dependency);
      if (
        file.startsWith('collector/boss/') &&
        dependency.startsWith('scripts/') &&
        !diagnosticLeaves.has(dependency)
      )
        add(file, 'MODULE_LAYER_VIOLATION', `采集器不能引用控制、交付或服务模块：${dependency}`);
    }
  }
  for (const file of [...graph.keys()].sort()) {
    const constraints = [];
    if (file.startsWith('dist/'))
      constraints.push([
        'MODULE_DIST_ESCAPE',
        (target) => !target.startsWith('dist/'),
        '浏览器依赖链离开 dist',
      ]);
    if (foundation(file))
      constraints.push([
        'MODULE_LAYER_VIOLATION',
        (target) => !foundation(target) && target !== 'dist/source-identity.js',
        '基础契约和规则依赖链离开基础层或精确的 source-identity 叶模块',
      ]);
    if (application(file))
      constraints.push(['MODULE_LAYER_VIOLATION', browserClient, '应用规则依赖浏览器客户端']);
    if (file.startsWith('scripts/') || file.startsWith('collector/'))
      constraints.push(['MODULE_LAYER_VIOLATION', browserClient, 'Node 模块依赖浏览器客户端']);
    if (diagnosticLeaves.has(file))
      constraints.push([
        'MODULE_DIAGNOSTIC_NOT_LEAF',
        (target) =>
          target.startsWith('scripts/') ||
          target.startsWith('collector/') ||
          application(target) ||
          browserClient(target) ||
          sharedState(target),
        '共享诊断模块不再是独立叶模块',
      ]);
    for (const [code, forbidden, message] of constraints) {
      const path = firstPath(graph, file, forbidden);
      if (path) add(file, code, `${message}：${path.join(' -> ')}`);
    }
  }
  for (const group of cycles(graph))
    add(group[0], 'MODULE_CYCLE', `模块依赖循环：${group.join(', ')}`);
  return findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );
}
