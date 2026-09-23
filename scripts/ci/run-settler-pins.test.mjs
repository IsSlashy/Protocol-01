// Tests for .github/workflows/run-settler.yml. Run: node --test scripts/ci/run-settler-pins.test.mjs
//
// Audit v1, round 2, fix lane 4 (axis 7, "manual workflows that hold signing
// keys install tools at floating versions"). The settler workflow ran
// `npm install --no-save tsx @solana/web3.js@^1.98.4` and then
// `npx tsx scripts/run-settler.ts` with SETTLER_KEYPAIR_JSON in its env. The
// repository has no package-lock.json (it is a pnpm workspace; only
// pnpm-lock.yaml is tracked), so npm resolved the root tree fresh on the day
// of the run and executed whatever the registry served inside `^1` while the
// keeper key was in hand. @solana/web3.js 1.x has already had one key-stealing
// publish (1.95.6 / 1.95.7, December 2024).
//
// The rule these tests pin: every step up to and including the one that holds
// the key installs from pnpm-lock.yaml with --frozen-lockfile, with the pnpm
// version package.json declares, and runs code only from that locked tree
// (`pnpm exec`, never `npx`, never `npm install`, never `@latest`, never a
// `curl | sh`). Every package the settler script imports must be one the
// lockfile's root importer pins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'run-settler.yml');
const SECRET = 'secrets.SETTLER_KEYPAIR_JSON';

const indentOf = (l) => l.length - l.trimStart().length;

// Steps of the single job, for the subset of YAML this workflow uses:
// `- name:` or `- uses:` opens a step; `run:` (inline or `|` block), `uses:`,
// `with:` and `env:` maps at the step's key indent.
function parseSteps(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)- (name|uses|run):\s*(.*)$/);
    if (!open) continue;
    const keyIndent = open[1].length + 2;
    const step = { name: null, uses: null, run: '', with: {}, env: {}, raw: [] };
    const first = open[3].trim();
    if (open[2] === 'name') step.name = first;
    if (open[2] === 'uses') step.uses = first;
    if (open[2] === 'run') step.run = first + '\n';
    step.raw.push(lines[i]);
    let j = i + 1;
    let block = null; // 'run' | 'with' | 'env'
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() !== '' && indentOf(l) < keyIndent) break;
      if (l.trim() !== '' && indentOf(l) === keyIndent && /^\s*- /.test(l)) break;
      step.raw.push(l);
      if (l.trim() === '') { j++; continue; }
      if (indentOf(l) === keyIndent) {
        const m = l.match(/^\s*([A-Za-z_-]+):\s*(.*)$/);
        block = null;
        if (m) {
          const [key, val] = [m[1], m[2].replace(/\s+#.*$/, '')];
          if (key === 'run') { if (/^\|/.test(val)) block = 'run'; else step.run += val + '\n'; }
          if (key === 'uses') step.uses = val.trim();
          if (key === 'name') step.name = val.trim();
          if (key === 'with' || key === 'env') block = key;
        }
      } else if (block === 'run') {
        step.run += l.trim() + '\n';
      } else if (block) {
        const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (m) step[block][m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
      }
      j++;
    }
    steps.push(step);
    i = j - 1;
  }
  return steps;
}

const text = readFileSync(WORKFLOW, 'utf8');
const steps = parseSteps(text);
const secretIdx = steps.findIndex((s) => Object.values(s.env).some((v) => v.includes(SECRET)));
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));

// The root importer (`.`) of pnpm-lock.yaml: name -> { specifier, version }.
function rootImporter() {
  const lines = readFileSync(join(REPO, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l === 'importers:');
  assert.ok(start >= 0, 'pnpm-lock.yaml has no importers section');
  const dot = lines.findIndex((l, k) => k > start && l === '  .:');
  assert.ok(dot >= 0, 'pnpm-lock.yaml has no root importer');
  const out = {};
  let name = null;
  for (let k = dot + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() !== '' && indentOf(l) <= 2) break;
    const dep = l.match(/^ {6}'?([^':]+(?::[^':]+)?)'?:\s*$/);
    if (dep) { name = dep[1]; out[name] = {}; continue; }
    const field = l.match(/^ {8}(specifier|version):\s*(.+)$/);
    if (field && name) out[name][field[1]] = field[2].trim();
  }
  return out;
}

test('the workflow parses and one step holds the settler key', () => {
  assert.ok(steps.length >= 3, `parsed ${steps.length} steps`);
  assert.ok(secretIdx >= 0, `no step carries ${SECRET} in env`);
});

test('no step up to the one holding the key installs or runs anything outside the lockfile', () => {
  const upTo = steps.slice(0, secretIdx + 1);
  for (const s of upTo) {
    const where = `step "${s.name ?? s.uses}"`;
    const run = s.run;
    assert.doesNotMatch(run, /\bnpm\s+(install|i|add|ci)\b/, `${where} runs npm install: npm has no lockfile in this pnpm workspace\n${run}`);
    assert.doesNotMatch(run, /\bnpx\b/, `${where} runs npx, which fetches a package that is not installed\n${run}`);
    assert.doesNotMatch(run, /\bpnpm\s+(dlx|add)\b/, `${where} fetches outside the lockfile\n${run}`);
    assert.doesNotMatch(run, /@latest\b/, `${where} installs @latest\n${run}`);
    assert.doesNotMatch(run, /\b(curl|wget)\b[^\n]*\|\s*(ba|z)?sh\b/, `${where} pipes a download into a shell\n${run}`);
    assert.doesNotMatch(run, /cargo\s+install\s+--git(?![^\n]*--(rev|tag)\b)/, `${where} installs a git HEAD\n${run}`);
    assert.doesNotMatch(run, /@\^|@~|@>=?/, `${where} installs a version range\n${run}`);
  }
});

test('the dependencies come from pnpm-lock.yaml, frozen, with the pnpm package.json declares', () => {
  const before = steps.slice(0, secretIdx);
  const install = before.findIndex((s) => /\bpnpm\s+install\b/.test(s.run));
  assert.ok(install >= 0, 'no `pnpm install` before the step that holds the key');
  assert.match(before[install].run, /--frozen-lockfile\b/, 'the install is not --frozen-lockfile');
  const setup = before.findIndex((s) => (s.uses ?? '').startsWith('pnpm/action-setup@'));
  assert.ok(setup >= 0 && setup < install, 'pnpm/action-setup does not run before the install');
  const declared = String(pkg.packageManager ?? '').replace(/^pnpm@/, '');
  assert.ok(declared, 'package.json declares no pnpm version');
  assert.equal(before[setup].with.version, declared, 'pnpm/action-setup version differs from packageManager');
});

test('the step holding the key runs the settler from the locked tree', () => {
  const run = steps[secretIdx].run;
  assert.match(run, /\bpnpm\s+exec\s+tsx\s+scripts\/run-settler\.ts\b/, `the key step does not run \`pnpm exec tsx scripts/run-settler.ts\`\n${run}`);
});

test('every package the settler imports, and tsx, is pinned by the lockfile root importer', () => {
  const src = readFileSync(join(REPO, 'scripts', 'run-settler.ts'), 'utf8');
  const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const builtins = new Set([...builtinModules, ...builtinModules.map((b) => `node:${b}`)]);
  const external = [...new Set(specs.filter((s) => !s.startsWith('.') && !builtins.has(s)))]
    .map((s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]));
  assert.ok(external.includes('@solana/web3.js'), `expected web3.js among the imports, got ${external.join(', ')}`);
  const locked = rootImporter();
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const name of [...new Set([...external, 'tsx'])]) {
    assert.ok(declared[name], `${name} is not declared in the root package.json`);
    assert.ok(locked[name]?.version, `${name} has no locked version in the pnpm-lock.yaml root importer`);
    assert.equal(locked[name].specifier, declared[name], `${name}: lockfile specifier differs from package.json`);
  }
});
