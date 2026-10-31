import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createModuleInspector,
  dynamicUse,
  parseModules,
  productionFile,
} from '../module-source.mjs';

// Only path separators create hierarchy. Preserve extensions so foo.mjs and
// foo/bar.mjs remain a leaf and a component, respectively.
function moduleID(file) {
  return file
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[.!'()*~]/g,
        (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('.');
}

export async function buildGraph(rootPath) {
  const root = resolve(rootPath);
  const inspect = createModuleInspector();
  const rootInfo = await inspect(root);
  if (rootInfo.code || !rootInfo.info?.isDirectory()) {
    throw Object.assign(new Error('项目根必须是无符号链接的实际目录。'), {
      code: rootInfo.code ?? 'MODULE_NOT_DIRECTORY',
    });
  }
  const tracked = spawnSync('git', ['ls-files', '--cached', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32_000_000,
  });
  if (tracked.status !== 0 || tracked.error) throw new Error('无法读取 Git 跟踪的公开源码。');
  const files = [...new Set(tracked.stdout.split('\0').filter(productionFile))].sort();
  if (!files.length) throw new Error('没有 Git 跟踪的公开生产模块。');
  const ids = new Map(files.map((file) => [file, moduleID(file)]));
  const sources = [];
  for (const file of files) {
    const inspected = await inspect(join(root, file));
    if (inspected.code || !inspected.info?.isFile()) {
      throw Object.assign(new Error(`源码路径不可用：${file}`), {
        code: inspected.code ?? 'MODULE_NOT_FILE',
      });
    }
    const source = new TextDecoder('utf-8', { fatal: true }).decode(
      await readFile(join(root, file)),
    );
    if (dynamicUse(source)) {
      throw Object.assign(new Error(`动态加载或执行不在静态依赖图范围内：${file}`), {
        code: 'MODULE_DYNAMIC_CODE',
      });
    }
    sources.push({ file, source });
  }
  const classes = files.map((file) => ({
    id: ids.get(file),
    name: basename(file),
    ns: `job-tracker.${ids.get(file)}`,
    file: join(root, file),
    lang: 'typescript',
  }));
  const edges = [];
  const foreign = new Map();
  for (const { file, requests, parseError } of parseModules(sources)) {
    if (parseError) throw new Error(`模块语法无效：${file}`);
    for (const specifier of requests) {
      if (isBuiltin(specifier)) {
        const name = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
        const id = name.replaceAll(':', '.').replaceAll('/', '.');
        foreign.set(id, { id, name, foreign: true });
        edges.push({ from: ids.get(file), to: id, kind: 'dependency' });
        continue;
      }
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        throw new Error(`仅支持相对模块路径和 Node 内置模块：${file} → ${specifier}`);
      }
      const target = relative(
        root,
        fileURLToPath(new URL(specifier, pathToFileURL(join(root, file)))),
      );
      if (!ids.has(target)) throw new Error(`未找到生产模块：${file} → ${specifier}`);
      edges.push({ from: ids.get(file), to: ids.get(target), kind: 'dependency' });
    }
  }
  return {
    title: 'job-tracker · static module dependencies',
    hierarchical: true,
    prefix: 'job-tracker',
    classes: [...classes, ...[...foreign.values()].sort((a, b) => a.id.localeCompare(b.id))],
    edges: [...new Map(edges.map((edge) => [`${edge.from}\0${edge.to}`, edge])).values()],
  };
}

function documentEDN(graph) {
  const string = JSON.stringify;
  const classes = graph.classes.map(
    (item) =>
      `{:id :${item.id} :name ${string(item.name)}${
        item.foreign
          ? ' :foreign true'
          : ` :ns ${string(item.ns)} :file ${string(item.file)} :lang :typescript`
      }}`,
  );
  const edges = graph.edges.map(
    (edge) => `{:from :${edge.from} :to :${edge.to} :kind :dependency}`,
  );
  return `{:title ${string(graph.title)}\n :hierarchical true\n :prefix ${string(graph.prefix)}\n :order [:dist :scripts :collector]\n :classes [${classes.join('\n           ')}]\n :edges [${edges.join('\n         ')}]}\n`;
}

export async function exportGraph(rootPath, outputPath) {
  const root = resolve(rootPath),
    output = resolve(outputPath);
  const directory = join(root, '.local', 'uml-viewer');
  if (dirname(output) !== directory || !output.endsWith('.edn')) {
    throw new Error('UML 输出必须位于 .local/uml-viewer/，并使用 .edn 后缀。');
  }
  const graph = await buildGraph(root);
  for (const path of [join(root, '.local'), directory]) {
    try {
      await mkdir(path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const inspected = await createModuleInspector()(path);
    if (inspected.code || !inspected.info?.isDirectory()) {
      throw new Error('UML 输出目录必须是无符号链接的实际目录。');
    }
  }
  const existing = await createModuleInspector()(output);
  if (
    (existing.code && existing.code !== 'MODULE_MISSING') ||
    (existing.info && !existing.info.isFile())
  ) {
    throw new Error('UML 输出必须是普通文件。');
  }
  const temporary = join(directory, `.diagram-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, documentEDN(graph), { flag: 'wx', mode: 0o600 });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    modules: graph.classes.filter((item) => !item.foreign).length,
    edges: graph.edges.length,
    output,
  };
}
