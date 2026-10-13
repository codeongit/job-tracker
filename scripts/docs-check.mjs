import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, join, dirname, isAbsolute, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const skippedDirectories = new Set([
  '.git',
  '.local',
  '.agents',
  '.codex',
  'node_modules',
  'test',
  'tests',
  'fixtures',
  '__fixtures__',
  '__tests__',
  'vendor',
  'third-party',
  'third_party',
]);
const syntaxLimit = 16_384;
const ownedDirectories = new Set(['docs', 'collector', '.github']);

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function ownedScope(root, path, directory = false) {
  if (!inside(root, path)) return false;
  const parts = relative(root, path).split(sep).filter(Boolean);
  if (parts.some((part) => skippedDirectories.has(part))) return false;
  if (directory) return ownedDirectories.has(parts[0]);
  return /\.md$/i.test(path) && (parts.length === 1 || ownedDirectories.has(parts[0]));
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function mask(text) {
  return text.replace(/[^\r\n]/g, ' ');
}

function escaped(source, index) {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && source[at] === '\\'; at--) slashes++;
  return slashes % 2 === 1;
}

function unescape(text) {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
}

function blockContext() {
  let listIndents = [],
    afterBlank = false,
    previousQuote = 0;
  return (line, update = true) => {
    let content = line,
      quoteDepth = 0;
    for (
      let quote = content.match(/^ {0,3}>[ \t]?/);
      quote;
      quote = content.match(/^ {0,3}>[ \t]?/)
    ) {
      content = content.slice(quote[0].length);
      quoteDepth++;
    }
    if (update && quoteDepth !== previousQuote) listIndents = [];
    if (update) previousQuote = quoteDepth;
    const leading = content.match(/^[ \t]*/)[0].length;
    if (!update)
      return content.slice(leading >= (listIndents.at(-1) || 0) ? listIndents.at(-1) || 0 : 0);
    if (!content.trim()) {
      afterBlank = true;
      return content;
    }
    const marker = content.match(/^([ \t]*)(?:[-+*]|\d{1,9}[.)])[ \t]+/);
    const base = listIndents.findLast((indent) => indent <= leading) || 0;
    if (marker && leading - base <= 3) {
      while (listIndents.at(-1) > leading) listIndents.pop();
      listIndents.push(marker[0].length);
      afterBlank = false;
      return content.slice(marker[0].length);
    }
    if (afterBlank) while (listIndents.at(-1) > leading) listIndents.pop();
    afterBlank = false;
    return content.slice(leading >= (listIndents.at(-1) || 0) ? listIndents.at(-1) || 0 : 0);
  };
}

// This is an offline checker for the repository's Markdown syntax, not a full
// CommonMark renderer. Masking preserves line positions for diagnostics.
function prose(source) {
  const contentOf = blockContext();
  let result = '',
    fence;
  for (let at = 0; at < source.length;) {
    if (at === 0 || source[at - 1] === '\n') {
      const newline = source.indexOf('\n', at),
        end = newline < 0 ? source.length : newline + 1;
      const line = source.slice(at, end),
        content = contentOf(line, !fence);
      const start = content.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        const closing = new RegExp(
          `^ {0,3}${fence.character}{${fence.length},}[ \\t]*(?:\\r?\\n)?$`,
        );
        if (closing.test(content)) fence = undefined;
        result += mask(line);
        at = end;
        continue;
      } else if (start) {
        fence = { character: start[1][0], length: start[1].length };
        result += mask(line);
        at = end;
        continue;
      } else if (/^(?: {4}|\t)/.test(content)) {
        result += mask(line);
        at = end;
        continue;
      }
    }
    if (source.startsWith('<!--', at)) {
      const closing = source.indexOf('-->', at + 4),
        end = closing < 0 ? source.length : closing + 3;
      result += mask(source.slice(at, end));
      at = end;
      continue;
    }
    if (source[at] === '`' && !escaped(source, at)) {
      const end = codeSpanEnd(source, at);
      if (end !== undefined) {
        // Keep inline code text for heading slugs, but do not interpret a
        // comment opener inside it. Link scanning masks it in the next pass.
        result += source.slice(at, end);
        at = end;
        continue;
      }
      let runEnd = at + 1;
      while (source[runEnd] === '`') runEnd++;
      result += source.slice(at, runEnd);
      at = runEnd;
      continue;
    }
    result += source[at++];
  }
  return result;
}

function codeSpanEnd(source, start) {
  let end = start;
  while (source[end] === '`') end++;
  const run = source.slice(start, end);
  let closing = source.indexOf(run, end);
  while (closing >= 0 && (source[closing - 1] === '`' || source[closing + run.length] === '`'))
    closing = source.indexOf(run, closing + run.length);
  return closing < 0 ? undefined : closing + run.length;
}

function withoutInlineCode(source) {
  let result = '',
    cursor = 0;
  for (let at = 0; at < source.length; at++) {
    if (source[at] !== '`' || escaped(source, at)) continue;
    const end = codeSpanEnd(source, at);
    if (end === undefined) {
      while (source[at + 1] === '`') at++;
      continue;
    }
    result += source.slice(cursor, at) + mask(source.slice(at, end));
    cursor = end;
    at = cursor - 1;
  }
  return result + source.slice(cursor);
}

function bracket(source, start) {
  if (source[start] !== '[') return undefined;
  let depth = 1;
  for (let at = start + 1; at < Math.min(source.length, start + syntaxLimit); at++) {
    if (source[at] === '\\') {
      at++;
      continue;
    }
    if (source[at] === '[' && ++depth > 32) return undefined;
    if (source[at] === ']' && --depth === 0)
      return { label: source.slice(start + 1, at), end: at + 1 };
  }
}

function whitespace(source, at) {
  while (/\s/.test(source[at] || '') && at < source.length) at++;
  return at;
}

function destination(source, start, wrapped) {
  const limit = Math.min(source.length, start + syntaxLimit);
  let at = whitespace(source, start),
    target;
  if (source[at] === '<') {
    const begin = ++at;
    for (; at < limit; at++) {
      if (source[at] === '\\') at++;
      else if (source[at] === '\n' || source[at] === '\r') return undefined;
      else if (source[at] === '>') break;
    }
    if (at >= limit) return undefined;
    target = source.slice(begin, at++);
  } else {
    const begin = at;
    let depth = 0;
    for (; at < limit; at++) {
      const character = source[at];
      if (character === '\\') at++;
      else if (character === '(') {
        if (++depth > 32) return undefined;
      } else if (character === ')') {
        if (depth) depth--;
        else if (wrapped) break;
        else return undefined;
      } else if (/\s/.test(character)) break;
    }
    if (depth || (at >= limit && (wrapped || limit < source.length))) return undefined;
    target = source.slice(begin, at);
    if (!target && !wrapped) return undefined;
  }
  const beforeSpace = at;
  at = whitespace(source, at);
  if (wrapped && source[at] === ')') return { target: unescape(target), end: at + 1 };
  if (!wrapped && at === source.length) return { target: unescape(target), end: at };
  const title = source[at],
    closer = title === '(' ? ')' : title;
  if (at === beforeSpace || !['"', "'", '('].includes(title)) return undefined;
  at++;
  for (; at < limit; at++) {
    if (source[at] === '\\') at++;
    else if (source[at] === closer) break;
  }
  if (at >= limit) return undefined;
  at = whitespace(source, at + 1);
  if (wrapped ? source[at] !== ')' : at !== source.length) return undefined;
  return { target: unescape(target), end: wrapped ? at + 1 : at };
}

function referenceKey(label) {
  return unescape(label).trim().replace(/\s+/g, ' ').toLowerCase();
}

function markdown(source) {
  let text = withoutInlineCode(prose(source));
  const references = new Map(),
    links = [],
    problems = [];
  let offset = 0,
    consumedThrough = -1;
  const lines = text.split(/(?<=\n)/);
  text = lines
    .map((line, index) => {
      if (index <= consumedThrough) {
        offset += line.length;
        return mask(line);
      }
      const begin = line.search(/\S/),
        label = begin >= 0 && begin <= 3 ? bracket(line, begin) : undefined;
      let result = line;
      if (label && line[label.end] === ':') {
        let definition = line.trimEnd(),
          endLine = index;
        if (!definition.slice(label.end + 1).trim() && /^ {0,3}\S/.test(lines[index + 1] || '')) {
          definition += `\n${lines[++endLine].trimEnd()}`;
        }
        let value = destination(definition, label.end + 1, false);
        if (value && /^ {0,3}["'(]/.test(lines[endLine + 1] || '')) {
          const withTitle = destination(
            `${definition}\n${lines[endLine + 1].trimEnd()}`,
            label.end + 1,
            false,
          );
          if (withTitle) {
            value = withTitle;
            endLine++;
          }
        }
        if (value) {
          const key = referenceKey(label.label);
          if (!references.has(key)) references.set(key, value.target);
          links.push({ label: label.label, target: value.target, offset: offset + begin });
          result = mask(line);
          consumedThrough = endLine;
        }
      }
      offset += line.length;
      return result;
    })
    .join('');
  function scan(begin, limit, imagesOnly = false, depth = 0) {
    for (let at = begin; at < limit; at++) {
      if (text[at] !== '[' || escaped(text, at)) continue;
      if (imagesOnly && (text[at - 1] !== '!' || escaped(text, at - 1))) continue;
      const label = bracket(text, at);
      if (!label || label.end > limit) continue;
      let end = label.end,
        target;
      if (text[end] === '(') {
        const value = destination(text, end + 1, true);
        if (!value) continue;
        target = value.target;
        end = value.end;
      } else if (text[end] === '[') {
        const reference = bracket(text, end);
        if (!reference) continue;
        const key = referenceKey(reference.label || label.label);
        target = references.get(key);
        end = reference.end;
        if (target === undefined)
          problems.push({
            offset: at,
            code: 'link_reference_missing',
            message: `引用定义不存在：${key}`,
          });
      } else target = references.get(referenceKey(label.label));
      if (target !== undefined) links.push({ label: label.label, target, offset: at });
      // An image can be a link label. Its destination remains an independent
      // resource even when the enclosing navigation link is valid or external.
      if (depth < 32) scan(at + 1, label.end - 1, true, depth + 1);
      at = end - 1;
    }
  }
  scan(0, text.length);
  return { links, problems };
}

function headingText(text) {
  return unescape(text)
    .replace(/!?(?:\[([^\]]+)\])(?:\([^)]*\)|\[[^\]]*\])/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos);|&#(?:\d+|x[\da-f]+);/gi, (entity) => {
      const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const number = entity.slice(2, -1),
        value = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    })
    .replace(/(?<![\p{L}\p{N}_])_{1,2}([^_\n]+)_{1,2}(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/[*~`]/g, '');
}

function headings(source) {
  const lines = prose(source).split('\n'),
    result = [],
    used = new Set();
  for (let at = 0; at < lines.length; at++) {
    const match = lines[at].match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/);
    let text = match?.[2].replace(/[ \t]+#+[ \t]*$/, ''),
      level = match?.[1].length;
    if (
      !match &&
      at + 1 < lines.length &&
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[at + 1]) &&
      lines[at].trim()
    ) {
      text = lines[at].trim();
      level = lines[at + 1].trim()[0] === '=' ? 1 : 2;
    }
    if (text === undefined) continue;
    const readable = headingText(text),
      base = readable
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
        .replace(/\s/g, '-');
    let slug = base,
      suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    result.push({ text: readable, slug, level, line: at + 1 });
  }
  return result;
}

async function documentationFiles(root, excluded) {
  const result = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !skippedDirectories.has(entry.name)) await walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) result.push(path);
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isFile() && /\.md$/i.test(entry.name)) result.push(join(root, entry.name));
  for (const directory of ownedDirectories) {
    const path = join(root, directory);
    try {
      const resolved = await realpath(path);
      if (!ownedScope(root, resolved, true)) excluded(path);
      else if ((await stat(path)).isDirectory()) await walk(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return result.sort();
}

async function exactPath(root, target) {
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    let names;
    try {
      names = await readdir(current);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return 'link_target_missing';
      throw error;
    }
    if (!names.includes(part))
      return names.some((name) => name.toLowerCase() === part.toLowerCase())
        ? 'link_case_mismatch'
        : 'link_target_missing';
    current = join(current, part);
    // Resolve each step before looking inside a directory symlink.
    try {
      if (!inside(root, await realpath(current))) return 'link_outside_root';
    } catch (error) {
      if (error.code === 'ENOENT') return 'link_target_missing';
      throw error;
    }
  }
}

/**
 * Check owned project Markdown and the ADR index without any network requests.
 * Supported links: inline/image links and full, collapsed or defined shortcut
 * references; escaped/balanced destinations, angle paths and optional titles.
 * Markdown content is read only from root files or owned documentation trees,
 * including after symlink resolution; excluded Markdown targets are reported.
 * Raw HTML links/anchors and arbitrary CommonMark extensions are not parsed.
 * Returns deterministic { file, line, code, message } findings; no files change.
 */
export async function checkDocumentation(directory) {
  const root = await realpath(
    directory instanceof URL ? fileURLToPath(directory) : resolve(directory),
  );
  const documents = new Map(),
    findings = [];
  function add(file, line, code, message) {
    findings.push({ file: relative(root, file).split(sep).join('/'), line, code, message });
  }
  const excludedSource = (file) =>
    add(file, 1, 'document_scope_excluded', '文档来源不属于公开文档检查范围。');
  for (const file of await documentationFiles(root, excludedSource)) {
    if (!ownedScope(root, file) || !ownedScope(root, await realpath(file))) {
      excludedSource(file);
      continue;
    }
    const source = await readFile(file, 'utf8');
    documents.set(file, { source, ...markdown(source), headings: headings(source) });
  }
  const headingCache = new Map([...documents].map(([file, document]) => [file, document.headings]));
  for (const [file, document] of documents) {
    for (const problem of document.problems)
      add(file, lineAt(document.source, problem.offset), problem.code, problem.message);
    for (const link of document.links) {
      const line = lineAt(document.source, link.offset),
        raw = link.target;
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) continue;
      const hash = raw.indexOf('#'),
        pathPart = (hash < 0 ? raw : raw.slice(0, hash)).split('?')[0];
      let path, fragment;
      try {
        path = decodeURIComponent(pathPart);
        fragment = hash < 0 ? undefined : decodeURIComponent(raw.slice(hash + 1));
        if (path.includes('\0')) throw new URIError('NUL');
      } catch {
        add(file, line, 'link_encoding_invalid', `链接编码无效：${raw}`);
        continue;
      }
      let target = path
        ? resolve(path.startsWith('/') ? root : dirname(file), path.replace(/^\/+/, ''))
        : file;
      if (!inside(root, target)) {
        add(file, line, 'link_outside_root', `链接超出项目目录：${raw}`);
        continue;
      }
      const error = await exactPath(root, target);
      if (error) {
        add(file, line, error, `本地链接目标无效：${raw}`);
        continue;
      }
      const info = await stat(target);
      if (info.isDirectory()) {
        if (!fragment) continue;
        target = join(target, 'README.md');
        const readmeError = await exactPath(root, target);
        if (readmeError) {
          add(file, line, readmeError, `目录片段需要 README.md：${raw}`);
          continue;
        }
      }
      if (extname(target).toLowerCase() !== '.md') continue;
      if (!ownedScope(root, target) || !ownedScope(root, await realpath(target))) {
        add(
          file,
          line,
          'link_markdown_scope_excluded',
          '链接指向公开文档检查范围之外的 Markdown。',
        );
        continue;
      }
      if (!fragment) continue;
      if (!headingCache.has(target))
        headingCache.set(target, headings(await readFile(target, 'utf8')));
      if (!headingCache.get(target).some(({ slug }) => slug === fragment))
        add(file, line, 'link_anchor_missing', `Markdown 标题锚点不存在：${raw}`);
    }
  }

  const adrDirectory = join(root, 'docs/adr'),
    indexPath = join(adrDirectory, 'README.md'),
    index = documents.get(indexPath);
  const adrFiles = [...documents.keys()].filter(
    (file) => dirname(file) === adrDirectory && /^\d+-.*\.md$/.test(relative(adrDirectory, file)),
  );
  if (!index) add(indexPath, 1, 'adr_index_absent', '缺少统一 ADR 索引 docs/adr/README.md。');
  const numbers = new Map(),
    entries = new Map();
  for (const file of adrFiles) {
    const number = Number(relative(adrDirectory, file).match(/^\d+/)[0]),
      label = `D${String(number).padStart(3, '0')}`;
    if (numbers.has(number)) add(file, 1, 'adr_number_duplicate', `ADR 编号重复：${label}`);
    numbers.set(number, file);
    const firstHeading = documents.get(file).headings.find(({ level }) => level === 1);
    if (!firstHeading || !new RegExp(`^${label}(?:[：: \\t]|$)`).test(firstHeading.text))
      add(
        file,
        firstHeading?.line || 1,
        'adr_heading_number_mismatch',
        `ADR 一级标题应使用 ${label}。`,
      );
  }
  if (index)
    for (const link of index.links) {
      const line = lineAt(index.source, link.offset),
        lineText = index.source.split('\n')[line - 1];
      if (!/^\s*\|/.test(lineText) || !/^D\d+$/.test(link.label)) continue;
      let target;
      try {
        target = resolve(adrDirectory, decodeURIComponent(link.target.split('#')[0]));
      } catch {
        continue;
      }
      const filename = relative(adrDirectory, target),
        number = Number(filename.match(/^(\d+)-[^/]+\.md$/)?.[1]);
      if (!adrFiles.includes(target) || link.label !== `D${String(number).padStart(3, '0')}`)
        add(
          indexPath,
          line,
          'adr_index_number_mismatch',
          `索引编号与 ADR 文件不一致：${link.label} → ${link.target}`,
        );
      if (entries.has(target))
        add(indexPath, line, 'adr_index_duplicate', `ADR 索引条目重复：${link.target}`);
      entries.set(target, line);
    }
  for (const file of adrFiles)
    if (!entries.has(file)) add(file, 1, 'adr_index_missing', '此 ADR 缺少索引表条目。');

  return findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file, 'en') || a.line - b.line || a.code.localeCompare(b.code, 'en'),
  );
}
