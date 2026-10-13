import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { checkModules } from '../scripts/module-check.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'job-tracker-modules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), source);
  }
  return { root, url: pathToFileURL(`${root}/`) };
}

function has(findings, code, file) {
  assert.ok(
    findings.some((finding) => finding.code === code && (!file || finding.file === file)),
    `Missing ${code} for ${file ?? 'any file'}: ${JSON.stringify(findings)}`,
  );
}

test('legal layers retain shared identity, model-to-rules and application-to-model edges', async (t) => {
  const { url } = await fixture(t, {
    'dist/source-identity.js': 'export const identity = 1;',
    'dist/boss/contracts/base.js':
      'import { identity } from "../../source-identity.js"; export { identity };',
    'dist/boss/rules/helpers/leaf.js': 'export const rule = 1;',
    'dist/boss/rules/state.js':
      'import { identity } from "../contracts/base.js"; export { rule } from "./helpers/leaf.js";',
    'dist/model.js': 'import { rule } from "./boss/rules/state.js"; export const model = rule;',
    'dist/storage.js': 'export { model } from "./model.js";',
    'dist/boss/application/app.js': 'export { model } from "../../model.js";',
    'dist/boss/client.js': 'import "../storage.js"; export { model } from "./application/app.js";',
    'dist/app.js': 'import "./boss/client.js";',
    'scripts/boss/shared/diagnostics.mjs':
      'import fs from "node:fs"; import "../../../dist/boss/rules/state.js";',
    'collector/boss/collect.mjs':
      'import "../../scripts/boss/shared/diagnostics.mjs"; import path from "node:path";',
    'scripts/boss/delivery/deliver.mjs': 'import "../../../dist/boss/application/app.js";',
    'scripts/boss/control/run.mjs':
      'import "../../../collector/boss/collect.mjs"; import "../delivery/deliver.mjs";',
    'scripts/service.mjs': 'import "./boss/control/run.mjs"; import http from "node:http";',
  });
  assert.deepEqual(await checkModules(url), []);
});

test('the parser includes side-effect imports and all re-export forms without evaluating source', async (t) => {
  const { root, url } = await fixture(t, {
    'scripts/entry.mjs':
      'import "./side.mjs"; export * from "./named.mjs"; export { value as other } from "./other.mjs";',
    'scripts/named.mjs': 'export const named = 1;',
    'scripts/other.mjs': 'export const value = 2;',
    'scripts/side.mjs': 'export const side = 1;',
  });
  const marker = join(root, 'executed.txt');
  await writeFile(
    join(root, 'scripts/side.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('must not execute');`,
  );
  assert.deepEqual(await checkModules(url), []);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('missing side-effect and re-export targets are checked by native module metadata', async (t) => {
  const { url } = await fixture(t, {
    'dist/app.js':
      'import "./side.js"; export * from "./star.js"; export { missing } from "./named.js";',
  });
  const findings = await checkModules(url);
  assert.equal(findings.filter((finding) => finding.code === 'MODULE_MISSING').length, 3);
  assert.ok(findings.some((finding) => finding.message.includes('side.js')));
  assert.ok(findings.some((finding) => finding.message.includes('star.js')));
  assert.ok(findings.some((finding) => finding.message.includes('named.js')));
});

test('the native parser accepts escaped and multiline import specifiers', async (t) => {
  const { url } = await fixture(t, {
    'dist/app.js':
      'import /* comment */ {\nvalue\n} from "./\\u006ceaf.js"; export * as group from "./leaf.js";',
    'dist/leaf.js': 'export const value = 1;',
  });
  assert.deepEqual(await checkModules(url), []);
});

test('unimported production modules are parsed, while top-level and colocated tests are excluded', async (t) => {
  const { url } = await fixture(t, {
    'dist/app.js': 'export const app = true;',
    'scripts/unimported.mjs': 'this is invalid JavaScript;',
    'test/broken.test.mjs': 'invalid test source;',
    'collector/boss/legacy.test.mjs': 'invalid old test source;',
  });
  const findings = await checkModules(url);
  has(findings, 'MODULE_PARSE_ERROR', 'scripts/unimported.mjs');
  assert.equal(findings.length, 1);
});

test('cycles include imports, side-effect imports, re-exports and self dependencies', async (t) => {
  const { url } = await fixture(t, {
    'dist/a.js': 'export * from "./b.js";',
    'dist/b.js': 'import "./c.js";',
    'dist/c.js': 'import "./a.js";',
    'scripts/self.mjs': 'import "./self.mjs";',
  });
  const findings = await checkModules(url);
  assert.equal(findings.filter((finding) => finding.code === 'MODULE_CYCLE').length, 2);
  assert.ok(
    findings.some((finding) => finding.message.includes('dist/a.js, dist/b.js, dist/c.js')),
  );
  has(findings, 'MODULE_CYCLE', 'scripts/self.mjs');
});

test('dist dependency closure cannot reach scripts, Node builtins or browser external packages', async (t) => {
  const { url } = await fixture(t, {
    'dist/app.js': 'import "./bridge.js";',
    'dist/bridge.js': 'import "../scripts/leaf.mjs";',
    'dist/node.js': 'import fs from "node:fs";',
    'dist/external.js': 'import "https://example.invalid/client.js"; import "package-name";',
    'scripts/leaf.mjs': 'import fs from "node:fs";',
  });
  const findings = await checkModules(url);
  has(findings, 'MODULE_DIST_ESCAPE', 'dist/app.js');
  has(findings, 'MODULE_NODE_IN_BROWSER', 'dist/node.js');
  assert.equal(findings.filter((finding) => finding.code === 'MODULE_EXTERNAL_IMPORT').length, 2);
});

test('foundational contracts and rules reject transitive application and shared model/storage dependencies', async (t) => {
  const { url } = await fixture(t, {
    'dist/boss/contracts/base.js': 'import "../../source-identity.js";',
    'dist/source-identity.js': 'import "./model.js";',
    'dist/model.js': 'export const data = 1;',
    'dist/storage.js': 'export const storage = 1;',
    'dist/boss/rules/state.js': 'import "../application/app.js"; import "../../storage.js";',
    'dist/boss/application/app.js': 'export const app = 1;',
  });
  const findings = await checkModules(url);
  has(findings, 'MODULE_LAYER_VIOLATION', 'dist/boss/contracts/base.js');
  has(findings, 'MODULE_LAYER_VIOLATION', 'dist/boss/rules/state.js');
});

test('foundations only reach contracts, rules and the exact shared identity leaf', async (t) => {
  const { url } = await fixture(t, {
    'dist/boss/contracts/base.js': 'import "../../ui.js";',
    'dist/ui.js': 'document.body.textContent = "must not execute";',
    'dist/boss/rules/state.js': 'import "../../source-identity.js";',
    'dist/source-identity.js': 'import "./bridge.js";',
    'dist/bridge.js': 'import "./ui.js";',
  });
  const findings = await checkModules(url);
  has(findings, 'MODULE_LAYER_VIOLATION', 'dist/boss/contracts/base.js');
  has(findings, 'MODULE_LAYER_VIOLATION', 'dist/boss/rules/state.js');
  assert.ok(
    findings.some((finding) =>
      finding.message.includes('dist/source-identity.js -> dist/bridge.js'),
    ),
  );
});

test('an identity dependency through another allowed rule cannot reach UI', async (t) => {
  const { url } = await fixture(t, {
    'dist/boss/contracts/base.js': 'import "../../source-identity.js";',
    'dist/source-identity.js': 'import "./boss/rules/bridge.js";',
    'dist/boss/rules/bridge.js': 'import "../../ui.js";',
    'dist/ui.js': 'document.body.textContent = "must not execute";',
  });
  const findings = await checkModules(url);
  has(findings, 'MODULE_LAYER_VIOLATION', 'dist/boss/contracts/base.js');
  has(findings, 'MODULE_LAYER_VIOLATION', 'dist/boss/rules/bridge.js');
});

test('Node roots and application rules reject browser clients reached through shared modules', async (t) => {
  const { url } = await fixture(t, {
    'scripts/service.mjs': 'import "../dist/bridge.js";',
    'collector/boss/collect.mjs': 'import "../../dist/bridge.js";',
    'dist/boss/application/app.js': 'import "../../bridge.js";',
    'dist/bridge.js': 'import "./boss/client.js";',
    'dist/boss/client.js': 'export const browser = 1;',
  });
  const findings = await checkModules(url);
  for (const file of [
    'scripts/service.mjs',
    'collector/boss/collect.mjs',
    'dist/boss/application/app.js',
  ])
    has(findings, 'MODULE_LAYER_VIOLATION', file);
});

test('collectors cannot import control or delivery and shared diagnostics must remain a leaf', async (t) => {
  const { url } = await fixture(t, {
    'collector/boss/collect.mjs':
      'import "../../scripts/boss/control/run.mjs"; import "../../scripts/boss/delivery/deliver.mjs"; import "../../scripts/boss/shared/diagnostics.mjs";',
    'scripts/boss/control/run.mjs': 'export const run = 1;',
    'scripts/boss/delivery/deliver.mjs': 'export const deliver = 1;',
    'scripts/boss/shared/diagnostics.mjs': 'import "../control/run.mjs";',
  });
  const findings = await checkModules(url);
  assert.equal(
    findings.filter(
      (finding) =>
        finding.file === 'collector/boss/collect.mjs' && finding.code === 'MODULE_LAYER_VIOLATION',
    ).length,
    2,
  );
  has(findings, 'MODULE_DIAGNOSTIC_NOT_LEAF', 'scripts/boss/shared/diagnostics.mjs');
});

test('Node builtin imports accept prefixed and bare forms, while third party packages are rejected', async (t) => {
  const { url } = await fixture(t, {
    'scripts/valid.mjs': 'import "node:fs/promises"; import "path";',
    'collector/boss/valid.mjs': 'import "node:crypto";',
    'scripts/external.mjs': 'import "uninstalled-package";',
  });
  const findings = await checkModules(url);
  assert.equal(findings.length, 1);
  has(findings, 'MODULE_EXTERNAL_IMPORT', 'scripts/external.mjs');
});

test('case checks cover filenames and parent directories on case-insensitive hosts too', async (t) => {
  const { url } = await fixture(t, {
    'dist/app.js': 'import "./leaf.js"; import "./rules/item.js";',
    'dist/Leaf.js': 'export const leaf = 1;',
    'dist/Rules/item.js': 'export const item = 1;',
  });
  const findings = await checkModules(url);
  assert.equal(findings.filter((finding) => finding.code === 'MODULE_CASE_MISMATCH').length, 2);
});

test('directory and excluded-test targets are not accepted as production modules', async (t) => {
  const { url } = await fixture(t, {
    'dist/app.js': 'import "./folder"; import "../test/helper.mjs";',
    'dist/folder/leaf.js': 'export const leaf = 1;',
    'test/helper.mjs': 'export const testOnly = 1;',
  });
  const findings = await checkModules(url);
  has(findings, 'MODULE_NOT_FILE', 'dist/app.js');
  has(findings, 'MODULE_OUTSIDE_PRODUCTION', 'dist/app.js');
});

test('symbolic links in module files and parent directories are rejected without following them', async (t) => {
  const { root, url } = await fixture(t, {
    'dist/app.js': 'import "./linked.js"; import "./alias/leaf.js";',
    'dist/real.js': 'export const real = 1;',
    'outside/leaf.js': 'invalid external source must not be parsed;',
  });
  await symlink(join(root, 'dist/real.js'), join(root, 'dist/linked.js'));
  await symlink(join(root, 'outside'), join(root, 'dist/alias'));
  const findings = await checkModules(url);
  has(findings, 'MODULE_SYMLINK', 'dist/app.js');
  has(findings, 'MODULE_SYMLINK', 'dist/linked.js');
  has(findings, 'MODULE_SYMLINK', 'dist/alias');
  assert.ok(!findings.some((finding) => finding.code === 'MODULE_PARSE_ERROR'));
});

test('a symbolic link above the project root is rejected', async (t) => {
  const { root } = await fixture(t, { 'project/dist/app.js': 'export const app = 1;' });
  const alias = `${root}-alias`;
  t.after(() => rm(alias, { force: true }));
  await symlink(root, alias);
  const findings = await checkModules(pathToFileURL(`${alias}/project/`));
  has(findings, 'MODULE_SYMLINK', '.');
});

test('imports cannot escape the supplied project root', async (t) => {
  const { url } = await fixture(t, { 'dist/app.js': 'import "../../outside.js";' });
  has(await checkModules(url), 'MODULE_OUTSIDE_ROOT', 'dist/app.js');
});

test('private directories are rejected before inspecting their filesystem', async (t) => {
  const { root, url } = await fixture(t, {
    'scripts/entry.mjs': 'import "../.local/private.mjs";',
    'outside/private.mjs': 'private source must not be parsed;',
  });
  await symlink(join(root, 'outside'), join(root, '.local'));
  const findings = await checkModules(url);
  assert.equal(findings.length, 1);
  has(findings, 'MODULE_OUTSIDE_PRODUCTION', 'scripts/entry.mjs');
});

test('private dependencies and legacy collector materials are skipped without hiding public data/profile modules', async (t) => {
  const { root, url } = await fixture(t, {
    'scripts/.local/secret.mjs': 'invalid private source;',
    'scripts/.git/secret.mjs': 'invalid private source;',
    'scripts/node_modules/package/source.mjs': 'invalid third party source;',
    'scripts/.agents/skills/source.mjs': 'invalid third party source;',
    'collector/boss/data/account/raw.mjs': 'invalid private source;',
    'collector/boss/profile/raw.mjs': 'invalid private source;',
    'collector/boss/profiles/raw.mjs': 'invalid private source;',
    'collector/boss/cdp/raw.mjs': 'invalid private source;',
    'collector/boss/skills/source.mjs': 'invalid third party source;',
    'dist/data/source.js': 'invalid public source;',
    'dist/profile/source.js': 'invalid public source;',
    'dist/skills/source.js': 'invalid public source;',
    'collector/boss/entry.mjs': 'import "./data/account/raw.mjs"; import "./profile/raw.mjs";',
  });
  await symlink(join(root, 'scripts/.local'), join(root, 'collector/boss/.local'));
  const findings = await checkModules(url);
  assert.deepEqual(
    findings
      .filter((finding) => finding.code === 'MODULE_PARSE_ERROR')
      .map((finding) => finding.file),
    ['dist/data/source.js', 'dist/profile/source.js', 'dist/skills/source.js'],
  );
  assert.equal(
    findings.filter((finding) => finding.code === 'MODULE_OUTSIDE_PRODUCTION').length,
    2,
  );
  assert.ok(!findings.some((finding) => finding.code === 'MODULE_SYMLINK'));
});

test('new dynamic loaders and executors are refused, including template expressions and aliases', async (t) => {
  const { url } = await fixture(t, {
    'scripts/import.mjs': 'const value = import("./leaf.mjs");',
    'scripts/require.mjs': 'const load = require;',
    'scripts/eval.mjs': 'const run = eval;',
    'scripts/function.mjs': 'new Function("return 1");',
    'scripts/worker.mjs': 'new Worker("./leaf.mjs");',
    'scripts/import-scripts.mjs': 'importScripts("./leaf.mjs");',
    'scripts/template.mjs': 'const value = `text ${import("./leaf.mjs")}`;',
    'scripts/division.mjs': 'const value = { number: 1 } / import("./leaf.mjs") / 2;',
    'scripts/escaped.mjs': 'const load = re\\u0071uire;',
    'scripts/computed.mjs': 'globalThis["eval"]("text");',
    'scripts/leaf.mjs': 'export const leaf = 1;',
  });
  const findings = await checkModules(url);
  assert.equal(findings.filter((finding) => finding.code === 'MODULE_DYNAMIC_CODE').length, 10);
});

test('division after function/class expressions and postfix operators cannot hide dynamic imports', async (t) => {
  const expressions = {
    anonymous: 'function () {}',
    named: 'function named() {}',
    async: 'async function () {}',
    generator: 'function* () {}',
    asyncGenerator: 'async function* named() {}',
    class: 'class {}',
    namedClass: 'class Named {}',
    subclass: 'class extends (class {}) {}',
    functionSuperclass: 'class extends (function () { const value = 1; }) {}',
    increment: 'number++',
    decrement: 'number--',
    arrow: '(() => {})',
    method: '({ method() {} })',
    arrowReturn: '() => function () {}',
  };
  const files = { 'scripts/leaf.mjs': 'export const leaf = 1;' };
  for (const [name, expression] of Object.entries(expressions))
    files[`scripts/${name}.mjs`] =
      `let number = 1; const value = ${expression} / import("./leaf.mjs") / 2;`;
  const { url } = await fixture(t, files);
  const findings = await checkModules(url);
  assert.ok(!findings.some((finding) => finding.code === 'MODULE_PARSE_ERROR'));
  for (const name of Object.keys(expressions))
    has(findings, 'MODULE_DYNAMIC_CODE', `scripts/${name}.mjs`);
  assert.equal(findings.length, Object.keys(expressions).length);
});

test('declarations and statement blocks still allow regex literals containing dynamic-looking text', async (t) => {
  const { url } = await fixture(t, {
    'scripts/declarations.mjs': String.raw`
function declared() {} /import\(/.test('text');
async function declaredAsync() {} /require\(/.test('text');
function* declaredGenerator() {} /eval\(/.test('text');
class Declared {} /importScripts\(/.test('text');
{ const value = 1; } /Function\(/.test('text');
if (true) {} /Worker\(/.test('text');
const expression = function () { return /import\(/; };
const arrow = () => { /eval\(/.test('text'); };
export default function () {} /require\(/.test('text');
`,
  });
  assert.deepEqual(await checkModules(url), []);
});

test('comments, quoted text, regular expressions and template text do not invent dependencies or dynamic calls', async (t) => {
  const { url } = await fixture(t, {
    'scripts/text.mjs': `
// import("./missing.mjs"); require('missing');
/* new Function('text'); eval('text'); */
const text = "import('./missing.mjs'); eval('text')";
const template = \`new Worker('missing') and require('missing')\`;
const names = ['require', 'eval', 'Function'];
const singleton = ['Worker'];
const regex = /import\\(['"]missing['"]\\)|eval\\(/;
if (true) /require\\('missing'\\)/.test(text);
export const value = 1;
`,
  });
  assert.deepEqual(await checkModules(url), []);
});
