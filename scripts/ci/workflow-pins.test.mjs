// Tests for every workflow under .github/workflows that holds a secret.
// Run: node --test scripts/ci/workflow-pins.test.mjs
//
// Audit v1, finding F43 (and the F12 residual). run-settler.yml was fixed in
// round 2 (scripts/ci/run-settler-pins.test.mjs), but the other workflows that
// hold a secret still ran code chosen on the day of the run:
//
//   - third-party actions referenced by a MOVING ref (`actions/checkout@v4`,
//     `pnpm/action-setup@v2`, `dtolnay/rust-toolchain@stable`, and
//     `cpina/github-action-push-to-another-repository@main`, which receives
//     the SSH deploy keys of the mirror repos). Whoever can move that tag or
//     branch runs code next to the secret. Only a full commit SHA is fixed.
//   - tools installed at floating versions next to the secret:
//     `npm i -g vercel@latest` beside VERCEL_TOKEN, `cargo install --git
//     .../anchor avm` (the default branch HEAD) beside SOLANA_KEYPAIR, and
//     `npx` in the restock steps, which fetches from the registry whenever the
//     name does not resolve in the installed tree.
//   - deploy-anchor.yml used `dtolnay/rust-action@stable`, a repository that
//     does not exist under that name: whoever registers it runs next to the
//     program-upgrade key.
//
// The rules below apply to every workflow whose text references `secrets.`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(REPO, '.github', 'workflows');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const PNPM = String(pkg.packageManager ?? '').replace(/^pnpm@/, '');

const indentOf = (l) => l.length - l.trimStart().length;

// Same step parser as run-settler-pins.test.mjs, for the YAML subset these
// workflows use: `- name:` / `- uses:` / `- run:` opens a step; `run:` (inline
// or `|` block), `uses:`, `with:` and `env:` maps sit at the step's key indent.
function parseSteps(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)- (name|uses|run):\s*(.*)$/);
    if (!open) continue;
    const keyIndent = open[1].length + 2;
    const step = { line: i + 1, name: null, uses: null, run: '', with: {}, env: {} };
    const first = open[3].replace(/\s+#.*$/, '').trim();
    if (open[2] === 'name') step.name = first;
    if (open[2] === 'uses') step.uses = first;
    if (open[2] === 'run') step.run = first + '\n';
    let j = i + 1;
    let block = null;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() !== '' && indentOf(l) < keyIndent) break;
      if (l.trim() !== '' && indentOf(l) === keyIndent && /^\s*- /.test(l)) break;
      if (l.trim() === '' || /^\s*#/.test(l)) { j++; continue; }
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

// Top-level `env:` of the workflow: NAME -> value.
function topEnv(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = {};
  const start = lines.findIndex((l) => l === 'env:');
  if (start < 0) return out;
  for (let k = start + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    if (indentOf(l) === 0) break;
    const m = l.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return out;
}

const SECRET_WORKFLOWS = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(join(DIR, f), 'utf8') }))
  .filter((w) => /\bsecrets\./.test(w.text.replace(/^\s*#.*$/gm, '')))
  .map((w) => ({ ...w, steps: parseSteps(w.text), env: topEnv(w.text) }));

// Rust toolchain channels allowed to float, by workflow. ci.yml holds only the
// Turborepo cache token (TURBO_TOKEN / TURBO_TEAM) and its Rust jobs never use
// it; pinning its toolchain is a separate decision (it would also pin what
// every `cargo check` in CI accepts). Every workflow that holds a signing key,
// a deploy key or a deploy token must name an exact toolchain.
const FLOATING_TOOLCHAIN_ALLOWED = new Set(['ci.yml']);

// OPEN, and listed so it cannot be forgotten: restock-inventory.yml still
// uses moving refs (actions/checkout@v4, pnpm/action-setup@v2,
// actions/setup-node@v4) and `npx tsx` / `npx vitest` beside the funder and
// treasury keys. It is not pinned here because
// apps/web/lib/privacy/pool/ciLogHygiene.test.ts holds that workflow to a
// golden copy and a `uses:` allowlist (VETTED_USES) with these exact strings,
// so the two files must change in the same edit. The `pending` test below
// fails as soon as one of these offences disappears, so the entry has to be
// removed then (a ratchet, not an exemption that outlives the fix).
const PENDING = {
  'restock-inventory.yml': [
    'uses actions/checkout@v4',
    'uses pnpm/action-setup@v2',
    'uses actions/setup-node@v4',
    'npx may fetch from the registry -> npx tsx scripts/topUpRestockWallet.mts',
    'npx may fetch from the registry -> npx vitest run',
  ],
};
const pendingHit = (msg) => Object.entries(PENDING).some(([f, subs]) => msg.startsWith(`${f}:`) && subs.some((x) => msg.includes(x)));
const seenPending = new Set();
const open = (msgs) => msgs.filter((m) => {
  if (!pendingHit(m)) return true;
  seenPending.add(Object.entries(PENDING).flatMap(([f, subs]) => subs.filter((x) => m.startsWith(`${f}:`) && m.includes(x)).map((x) => `${f}|${x}`))[0]);
  return false;
});

const EXACT = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

test('the secret-holding workflows are the ones this file expects', () => {
  const names = SECRET_WORKFLOWS.map((w) => w.file).sort();
  for (const must of ['ci.yml', 'deploy-anchor.yml', 'deploy-web.yml', 'restock-inventory.yml', 'run-settler.yml', 'settle-till.yml', 'sync-all.yml', 'sync-repos.yml']) {
    assert.ok(names.includes(must), `${must} no longer references a secret, or was renamed: review this test (found ${names.join(', ')})`);
  }
});

test('every action a secret-holding workflow uses is pinned by a full commit SHA', () => {
  const bad = [];
  for (const w of SECRET_WORKFLOWS) {
    for (const s of w.steps) {
      if (!s.uses) continue;
      if (s.uses.startsWith('./')) continue;
      const m = s.uses.match(/^([^@\s]+)@([^\s]+)$/);
      if (m && m[1].startsWith('docker://')) continue;
      if (!m || !SHA.test(m[2])) bad.push(`${w.file}:${s.line} uses ${s.uses}`);
    }
  }
  assert.deepEqual(open(bad), [], `actions referenced by a moving tag or branch:\n  ${bad.join('\n  ')}`);
});

test('no secret-holding workflow references an action repository that does not exist', () => {
  // dtolnay publishes `rust-toolchain`; `dtolnay/rust-action` is not a
  // repository of his, so whoever registers that name runs beside the key.
  const bad = [];
  for (const w of SECRET_WORKFLOWS) {
    for (const s of w.steps) {
      if (s.uses && /^dtolnay\/rust-action@/.test(s.uses)) bad.push(`${w.file}:${s.line} uses ${s.uses}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('no step of a secret-holding workflow installs or runs a tool at a floating version', () => {
  const bad = [];
  for (const w of SECRET_WORKFLOWS) {
    for (const s of w.steps) {
      const where = `${w.file}:${s.line} "${s.name ?? s.uses}"`;
      for (const line of s.run.split('\n')) {
        if (!line.trim()) continue;
        if (/@latest\b/.test(line)) bad.push(`${where}: @latest -> ${line}`);
        if (/@\^|@~|@>=?/.test(line)) bad.push(`${where}: version range -> ${line}`);
        const g = line.match(/\bnpm\s+(?:i|install|add)\s+(?:-g|--global)\s+(.+)$/);
        if (g) {
          for (const spec of g[1].split(/\s+/).filter((t) => t && !t.startsWith('-'))) {
            const v = spec.replace(/^@?[^@]+@?/, '');
            if (!EXACT.test(v)) bad.push(`${where}: global npm install without an exact version -> ${line}`);
          }
        } else if (/\bnpm\s+(?:i|install|add|ci)\b/.test(line)) {
          bad.push(`${where}: npm install in a pnpm workspace (no package-lock.json) -> ${line}`);
        }
        if (/\bnpx\b/.test(line) && !/\bnpx\s+--no-install\b/.test(line)) bad.push(`${where}: npx may fetch from the registry -> ${line}`);
        if (/\bpnpm\s+dlx\b/.test(line)) bad.push(`${where}: pnpm dlx fetches outside the lockfile -> ${line}`);
        if (/\bcargo\s+install\s+--git\b/.test(line) && !/--(tag|rev)\s+\S+/.test(line)) bad.push(`${where}: cargo install --git without --tag/--rev -> ${line}`);
        if (/\bcargo\s+install\b/.test(line) && !/--git\b/.test(line) && !/--version\s+=?\d|@\d+\.\d+\.\d+/.test(line)) bad.push(`${where}: cargo install without a version -> ${line}`);
        const piped = /\b(curl|wget)\b[^\n]*\|\s*(ba|z)?sh\b/.test(line) || /\bsh\s+-c\s+"\$\((curl|wget)\b/.test(line);
        if (piped) {
          const url = (line.match(/https?:\/\/[^"')]+/) ?? [''])[0];
          const ver = url.match(/\/v(\d+\.\d+\.\d+|\$\{\{\s*env\.([A-Z_]+)\s*\}\})\//);
          const resolved = ver && (ver[2] ? w.env[ver[2]] : ver[1]);
          if (!resolved || !EXACT.test(resolved)) bad.push(`${where}: installer script without an exact version in its URL -> ${line}`);
        }
      }
    }
  }
  assert.deepEqual(open(bad), [], `floating installs next to a secret:\n  ${bad.join('\n  ')}`);
});

test('pnpm/action-setup installs the pnpm version package.json declares', () => {
  assert.ok(PNPM, 'package.json declares no packageManager pnpm version');
  const bad = [];
  for (const w of SECRET_WORKFLOWS) {
    for (const s of w.steps) {
      if (!(s.uses ?? '').startsWith('pnpm/action-setup@')) continue;
      if (s.with.version !== PNPM) bad.push(`${w.file}:${s.line} version ${s.with.version ?? '(none)'} != ${PNPM}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('dtolnay/rust-toolchain names its toolchain, exactly where a key is held', () => {
  // Pinned by SHA, the action no longer reads the channel from the ref, so
  // `toolchain:` is mandatory; outside ci.yml it must be an exact version.
  const bad = [];
  for (const w of SECRET_WORKFLOWS) {
    for (const s of w.steps) {
      if (!(s.uses ?? '').startsWith('dtolnay/rust-toolchain@')) continue;
      const tc = s.with.toolchain;
      if (!tc) { bad.push(`${w.file}:${s.line} has no toolchain input`); continue; }
      if (!FLOATING_TOOLCHAIN_ALLOWED.has(w.file) && !EXACT.test(tc)) bad.push(`${w.file}:${s.line} toolchain ${tc} is not an exact version`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('every PENDING entry is still an open offence (remove it once fixed)', () => {
  // Runs last: node:test runs the tests of a file in order, so the two tests
  // above have filled seenPending.
  const listed = Object.entries(PENDING).flatMap(([f, subs]) => subs.map((x) => `${f}|${x}`));
  const gone = listed.filter((k) => !seenPending.has(k));
  assert.deepEqual(gone, [], `fixed but still listed in PENDING, remove them:\n  ${gone.join('\n  ')}`);
});
