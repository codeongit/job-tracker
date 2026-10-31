import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, sep, resolve, parse, join } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';

export const productionRoots = ['dist', 'scripts', 'collector'];
const privateDirectories = new Set(['.local', '.git', 'node_modules', '.agents', '.codex']);
const legacyCollectorDirectories = new Set(['data', 'profile', 'profiles', 'cdp', 'skills']);

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

export function inside(root, path) {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

export function ignoredPath(file) {
  const parts = file.split('/');
  return (
    parts.some((part) => privateDirectories.has(part.toLowerCase())) ||
    (file.startsWith('collector/boss/') &&
      parts.slice(2).some((part) => legacyCollectorDirectories.has(part.toLowerCase())))
  );
}

export function productionPath(file) {
  return productionRoots.some((root) => file.startsWith(`${root}/`)) && !ignoredPath(file);
}

export function productionFile(file) {
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

export function dynamicUse(source) {
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

export function parseModules(sources) {
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
  if (parsed.status !== 0 || parsed.error) throw new Error('Node 24 静态模块解析失败。');
  return JSON.parse(parsed.stdout);
}

export function createModuleInspector() {
  const entries = new Map(),
    infos = new Map();
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
  return inspect;
}
