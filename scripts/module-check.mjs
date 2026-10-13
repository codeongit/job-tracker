import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const productionRoots = ['dist', 'scripts', 'collector'];
const privateDirectories = new Set(['.local', '.git', 'node_modules', '.agents', '.codex']);
const legacyCollectorDirectories = new Set(['data', 'profile', 'profiles', 'cdp', 'skills']);
const diagnosticLeaves = new Set(['scripts/boss/shared/diagnostics.mjs']);

// The child compiles source only to obtain the engine's static import metadata.
// It never links or evaluates a checked module, including side-effect imports.
const parserSource = `
import { SourceTextModule } from 'node:vm';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const result = JSON.parse(input).map(({ file, source }) => {
  try {
    const module = new SourceTextModule(source, { identifier: file });
    return { file, requests: module.moduleRequests.map((request) => request.specifier) };
  } catch {
    return { file, parseError: true };
  }
});
process.stdout.write(JSON.stringify(result));
`;

function inside(root, path) {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function ignoredPath(file) {
  const parts = file.split('/');
  return (
    parts.some((part) => privateDirectories.has(part.toLowerCase())) ||
    (file.startsWith('collector/boss/') &&
      parts.slice(2).some((part) => legacyCollectorDirectories.has(part.toLowerCase())))
  );
}

function productionPath(file) {
  return productionRoots.some((root) => file.startsWith(`${root}/`)) && !ignoredPath(file);
}

function productionFile(file) {
  return productionPath(file) && /\.(?:m?js)$/.test(file) && !/\.test\.(?:m?js)$/.test(file);
}

function identifierCharacter(character) {
  return character && /[$_\p{ID_Continue}]/u.test(character);
}

// This conservative lexical guard tracks common slash contexts, not the full
// JavaScript grammar or scope/alias semantics.
// Templates retain their expressions; comments, strings and regex contents do
// not become code. The dangerous identifiers are reserved in production code.
function tokens(source) {
  const result = [];
  let at = 0;
  function scan(expression = false) {
    let braces = 0;
    let regexAllowed = true;
    let statementStart = !expression;
    let lineBreak = false;
    let brackets = 0;
    const parentheses = [];
    const bodies = [];
    const pendingBodies = [];
    const pendingAt = (phase) =>
      pendingBodies.findLast(
        (body) =>
          body.phase === phase &&
          body.braces === braces &&
          body.parentheses === parentheses.length &&
          body.brackets === brackets,
      );
    while (at < source.length) {
      const character = source[at];
      if (/\s/.test(character)) {
        if (/[\n\r\u2028\u2029]/.test(character)) lineBreak = true;
        at++;
        continue;
      }
      if (source.startsWith('//', at)) {
        lineBreak = true;
        at = source.indexOf('\n', at);
        if (at < 0) at = source.length;
        continue;
      }
      if (source.startsWith('/*', at)) {
        const end = source.indexOf('*/', at + 2);
        if (/[\n\r\u2028\u2029]/.test(source.slice(at, end < 0 ? source.length : end)))
          lineBreak = true;
        at = end < 0 ? source.length : end + 2;
        continue;
      }
      if (character === '"' || character === "'") {
        const offset = at++;
        let value = '';
        while (at < source.length && source[at] !== character) {
          if (source[at] === '\\') {
            at += 2;
            value += '\\';
          } else value += source[at++];
        }
        at++;
        result.push({ value, offset, literal: true });
        regexAllowed = false;
        statementStart = false;
        lineBreak = false;
        continue;
      }
      if (character === '`') {
        at++;
        while (at < source.length && source[at] !== '`') {
          if (source[at] === '\\') at += 2;
          else if (source.startsWith('${', at)) {
            at += 2;
            scan(true);
          } else at++;
        }
        at++;
        result.push({ value: '', offset: at, literal: true });
        regexAllowed = false;
        statementStart = false;
        lineBreak = false;
        continue;
      }
      if (character === '/' && regexAllowed) {
        at++;
        let bracket = false;
        while (at < source.length) {
          const item = source[at++];
          if (item === '\\') at++;
          else if (item === '[') bracket = true;
          else if (item === ']') bracket = false;
          else if (item === '/' && !bracket) break;
        }
        while (/[A-Za-z]/.test(source[at] ?? '')) at++;
        result.push({ value: '', offset: at, literal: true });
        regexAllowed = false;
        statementStart = false;
        lineBreak = false;
        continue;
      }
      if (identifierCharacter(character) || character === '\\') {
        const offset = at;
        let value = '';
        while (at < source.length) {
          if (identifierCharacter(source[at])) value += source[at++];
          else if (source[at] === '\\') {
            const match = source.slice(at).match(/^\\u(?:\{([a-f\d]+)\}|([a-f\d]{4}))/i);
            if (!match) {
              at++;
              break;
            }
            const point = Number.parseInt(match[1] ?? match[2], 16);
            value += point <= 0x10ffff ? String.fromCodePoint(point) : '';
            at += match[0].length;
          } else break;
        }
        const previous = result.at(-1)?.value;
        if ((value === 'function' || value === 'class') && previous !== '.') {
          // Only the body-closing slash context is needed here. This is not a
          // parser: retain declaration/expression position through names,
          // generator stars, parameters and a class's extends expression.
          const declaration =
            statementStart ||
            (lineBreak && (!regexAllowed || /^(?:return|break|continue)$/.test(previous)));
          pendingBodies.push({
            phase: value === 'function' ? 'parameters' : 'body',
            expression: !declaration,
            braces,
            parentheses: parentheses.length,
            brackets,
          });
        }
        result.push({ value, offset });
        regexAllowed =
          /^(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|new|else|do)$/.test(
            value,
          );
        statementStart =
          /^(?:else|do|try|finally)$/.test(value) ||
          (statementStart && /^(?:export|default|async)$/.test(value));
        lineBreak = false;
        continue;
      }
      if (expression && character === '}' && braces === 0) {
        at++;
        return;
      }
      const previous = result.at(-1)?.value;
      const pair = source.slice(at, at + 2);
      if (pair === '++' || pair === '--' || pair === '=>') {
        result.push({ value: pair, offset: at });
        at += 2;
        // Prefix ++/-- still need an operand; postfix ++/-- end a value.
        if (pair === '=>') regexAllowed = true;
        statementStart = false;
        lineBreak = false;
        continue;
      }
      if (character === '{') {
        const pending = pendingAt('body');
        if (pending) pendingBodies.splice(pendingBodies.indexOf(pending), 1);
        const valueBody = pending
          ? pending.expression
          : previous === '=>' || /^(?:=|\(|\[|:|,|return|yield)$/.test(previous);
        bodies.push(valueBody);
        braces++;
        regexAllowed = true;
        statementStart = Boolean(pending) || previous === '=>' || !valueBody;
      } else if (character === '}') {
        braces--;
        regexAllowed = !bodies.pop();
        statementStart = regexAllowed;
      } else if (character === '(') {
        const pending = pendingAt('parameters');
        if (pending) pending.phase = 'in_parameters';
        parentheses.push({
          control: /^(?:if|while|for|with|switch|catch)$/.test(previous),
          pending,
        });
        regexAllowed = true;
        statementStart = false;
      } else if (character === ')') {
        const closed = parentheses.pop();
        if (closed?.pending) closed.pending.phase = 'body';
        regexAllowed = Boolean(closed?.control);
        statementStart = regexAllowed;
      } else {
        if (character === '[') brackets++;
        if (character === ']') brackets--;
        regexAllowed = character !== ']' && character !== '.';
        statementStart = character === ';';
        if (statementStart)
          for (let index = pendingBodies.length - 1; index >= 0; index--)
            if (
              pendingBodies[index].braces === braces &&
              pendingBodies[index].parentheses === parentheses.length
            )
              pendingBodies.splice(index, 1);
      }
      result.push({ value: character, offset: at++ });
      lineBreak = false;
    }
  }
  scan();
  return result;
}

function dynamicUse(source) {
  const values = tokens(source);
  const forbidden = new Set([
    'require',
    'importScripts',
    'Worker',
    'SharedWorker',
    'eval',
    'Function',
  ]);
  return values.find(
    (token, index) =>
      (!token.literal &&
        (forbidden.has(token.value) ||
          (token.value === 'import' &&
            values[index + 1]?.value === '(' &&
            values[index - 1]?.value !== '.'))) ||
      (token.literal &&
        forbidden.has(token.value) &&
        values[index - 1]?.value === '[' &&
        ['globalThis', 'window', 'self', 'global'].includes(values[index - 2]?.value)),
  );
}

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
  const entries = new Map(),
    infos = new Map();
  const display = (path) => relative(root, path).split(sep).join('/') || '.';
  async function inspect(path) {
    const absolute = resolve(path);
    let parent = parse(absolute).root;
    for (const name of absolute.slice(parent.length).split(sep).filter(Boolean)) {
      let names;
      try {
        if (!entries.has(parent)) entries.set(parent, await readdir(parent));
        names = entries.get(parent);
      } catch {
        return { code: 'MODULE_PATH_UNREADABLE', path: parent };
      }
      if (!names.includes(name))
        return {
          code: names.some((item) => item.toLowerCase() === name.toLowerCase())
            ? 'MODULE_CASE_MISMATCH'
            : 'MODULE_MISSING',
          path: join(parent, name),
        };
      parent = join(parent, name);
      try {
        if (!infos.has(parent)) infos.set(parent, await lstat(parent));
      } catch {
        return { code: 'MODULE_PATH_UNREADABLE', path: parent };
      }
      const info = infos.get(parent);
      if (info.isSymbolicLink()) return { code: 'MODULE_SYMLINK', path: parent };
      if (parent !== absolute && !info.isDirectory())
        return { code: 'MODULE_NOT_DIRECTORY', path: parent };
    }
    return { info: infos.get(absolute) };
  }
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
  const parsed = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', '--input-type=module', '-e', parserSource],
    {
      input: JSON.stringify(sources),
      encoding: 'utf8',
      maxBuffer: 32_000_000,
      timeout: 20_000,
    },
  );
  let metadata;
  try {
    if (parsed.status !== 0 || parsed.error) throw new Error();
    metadata = JSON.parse(parsed.stdout);
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
