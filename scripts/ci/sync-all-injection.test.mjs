// Tests for .github/workflows/sync-all.yml. Run: node --test scripts/ci/sync-all-injection.test.mjs
//
// Audit v1, round 1, fix lane 3. The workflow runs on every push to master
// with a PAT that can force-push four repositories. It built the sync commit
// message from `git log -1 --pretty=%s`, stripped only quotes and backticks,
// and pasted it with `${{ steps.msg.outputs.msg }}` into a double-quoted
// `git commit -m "..."` inside `run:` scripts that also expanded
// `${{ secrets.PAT_TOKEN }}`. GitHub substitutes `${{ }}` as TEXT before bash
// parses the script, so a `$( ... )` in a merged PR's title or branch name ran
// in a script holding the PAT.
//
// The static tests pin the rule the fix follows (no `${{ }}` inside any
// `run:` script: every value reaches bash through `env:` and is read as a
// quoted variable) plus least privilege. The replay test does what the runner
// does, on a throwaway local repository: it runs the "Set commit message"
// step for real, substitutes its output into each step's `git commit` line and
// `env:` exactly as GitHub does, runs that line with `bash -eo pipefail`, and
// checks that a `$( ... )` subject stays data. Nothing is pushed; the PAT is
// a dummy string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'sync-all.yml');

// ── a parser for the subset of YAML this workflow uses ──────────────────────

const indentOf = (l) => l.length - l.trimStart().length;

function mapBlock(lines, i, keyIndent) {
  // `key:` followed by `  K: V` lines at deeper indent.
  const out = {};
  let j = i + 1;
  while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > keyIndent)) {
    const m = lines[j].match(/^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m && lines[j].trim() !== '') out[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
    j++;
  }
  return [out, j];
}

function literalBlock(lines, i, keyIndent) {
  const body = [];
  let j = i + 1;
  while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > keyIndent)) {
    body.push(lines[j]);
    j++;
  }
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  const cut = Math.min(...body.filter((l) => l.trim() !== '').map(indentOf));
  return [body.map((l) => l.slice(cut)).join('\n') + '\n', j];
}

export function parseWorkflow(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const wf = { env: {}, permissions: null, jobEnv: {}, jobPermissions: null, steps: [] };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^env:\s*$/.test(l)) wf.env = mapBlock(lines, i, 0)[0];
    if (/^permissions:/.test(l)) wf.permissions = l.includes(':') && l.split(':')[1].trim() ? l.split(':')[1].trim() : mapBlock(lines, i, 0)[0];
    if (/^    env:\s*$/.test(l)) wf.jobEnv = mapBlock(lines, i, 4)[0];
    if (/^    permissions:/.test(l)) wf.jobPermissions = l.split(':')[1].trim() || mapBlock(lines, i, 4)[0];
    const s = l.match(/^(\s*)- name:\s*(.*)$/);
    if (!s) continue;
    const keyIndent = s[1].length + 2;
    const step = { name: s[2].trim(), env: {}, with: {}, run: null, uses: null, id: null };
    let j = i + 1;
    // the `- name:` line opens the step; its other keys sit at keyIndent
    while (j < lines.length) {
      const k = lines[j];
      if (k.trim() === '') { j++; continue; }
      if (indentOf(k) < keyIndent) break;
      const m = k.match(/^\s*([A-Za-z_-]+):\s*(.*)$/);
      if (!m || indentOf(k) !== keyIndent) { j++; continue; }
      const [key, val] = [m[1], m[2]];
      if (key === 'run' && /^\|/.test(val)) { [step.run, j] = literalBlock(lines, j, keyIndent); continue; }
      if (key === 'run') step.run = val + '\n';
      if (key === 'env') { [step.env, j] = mapBlock(lines, j, keyIndent); continue; }
      if (key === 'with') { [step.with, j] = mapBlock(lines, j, keyIndent); continue; }
      if (key === 'uses') step.uses = val.trim();
      if (key === 'id') step.id = val.trim();
      j++;
    }
    wf.steps.push(step);
    i = j - 1;
  }
  return wf;
}

// ── GitHub's `${{ }}` substitution, as text ────────────────────────────────

function render(text, ctx) {
  return text.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    if (expr in ctx) return ctx[expr];
    throw new Error(`the replay does not know how to render \${{ ${expr} }}`);
  });
}

function findBash() {
  if (process.env.SYNC_TEST_BASH) return process.env.SYNC_TEST_BASH;
  if (process.platform === 'win32') {
    for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) {
      if (existsSync(p)) return p;
    }
  }
  return 'bash';
}
const BASH = findBash();

function sh(script, { cwd, env }) {
  // the runner's default shell for `run:` on Linux
  const r = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return r;
}

function git(args, cwd, env = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

const IDENT = {
  GIT_AUTHOR_NAME: 'sync-test', GIT_AUTHOR_EMAIL: 'sync-test@localhost',
  GIT_COMMITTER_NAME: 'sync-test', GIT_COMMITTER_EMAIL: 'sync-test@localhost',
  GIT_CONFIG_NOSYSTEM: '1',
};

function parseOutputs(file) {
  const out = {};
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heredoc = lines[i].match(/^([^=<]+)<<(.+)$/);
    if (heredoc) {
      const body = [];
      i++;
      while (i < lines.length && lines[i] !== heredoc[2]) body.push(lines[i++]);
      out[heredoc[1]] = body.join('\n');
      continue;
    }
    const kv = lines[i].match(/^([^=]+)=(.*)$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

const wf = parseWorkflow(readFileSync(WORKFLOW, 'utf8'));

// ── static rules ───────────────────────────────────────────────────────────

test('the parser sees the workflow steps (control)', () => {
  const names = wf.steps.map((s) => s.name);
  for (const n of ['Set commit message', 'Sync p01-web', 'Sync p01-mobile', 'Sync p01-extension', 'Sync p01-sdk']) {
    assert.ok(names.includes(n), `step "${n}" not found; parsed: ${names.join(', ')}`);
  }
  const commits = wf.steps.filter((s) => s.run && /git commit/.test(s.run));
  assert.equal(commits.length, 4, 'four steps commit');
});

test('no run: script contains a ${{ }} expression: values reach bash through env:', () => {
  const offenders = [];
  for (const s of wf.steps) {
    if (!s.run) continue;
    s.run.split('\n').forEach((line, n) => {
      if (line.includes('${{')) offenders.push(`${s.name} (+${n + 1}): ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `expressions pasted into shell scripts:\n${offenders.join('\n')}`);
});

test('the PAT never appears in a run: script and the commit message is read as a quoted variable', () => {
  for (const s of wf.steps.filter((x) => x.run && /git commit/.test(x.run))) {
    assert.ok(!/secrets\./.test(s.run), `${s.name}: a secret is expanded into the script`);
    const commit = s.run.split('\n').find((l) => /git commit/.test(l));
    assert.match(commit, /git commit -m "\$[A-Z_]+"\s*$/, `${s.name}: commit line is ${commit.trim()}`);
    const v = commit.match(/"\$([A-Z_]+)"/)[1];
    assert.equal(s.env[v], '${{ steps.msg.outputs.msg }}', `${s.name}: ${v} comes from env:`);
  }
});

test('the workflow runs with a read-only GITHUB_TOKEN and does not persist it', () => {
  const perms = wf.jobPermissions ?? wf.permissions;
  assert.ok(perms && typeof perms === 'object', 'a permissions: block is declared');
  assert.equal(perms.contents, 'read', 'contents: read');
  assert.equal(Object.keys(perms).length, 1, `only contents: read is granted: ${JSON.stringify(perms)}`);
  const checkout = wf.steps.find((s) => s.uses && s.uses.startsWith('actions/checkout@'));
  assert.equal(checkout?.with['persist-credentials'], 'false', 'checkout does not leave the token in .git/config');
});

// ── the replay ─────────────────────────────────────────────────────────────

const SUBJECTS = [
  // squash-merge: the PR title
  'Fix typo in docs $(touch pwned-title) (#12)',
  // merge commit: the fork branch, a valid ref name with no spaces
  'Merge pull request #13 from attacker/fix/$(touch${IFS}pwned-branch)',
  // backticks and quotes, which the old cleanup deleted
  'Quote "a" and \'b\' and `touch pwned-backtick` ${PAT_TOKEN} $GITHUB_OUTPUT',
];

for (const subject of SUBJECTS) {
  test(`a commit subject stays data in every sync step: ${subject}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-all-'));
    try {
      // the checkout: a repository whose last commit carries the subject
      const src = join(dir, 'src');
      git(['init', '-q', src], dir);
      writeFileSync(join(src, 'f.txt'), 'x\n');
      git(['add', '-A'], src);
      git(['commit', '-q', '-m', subject], src);

      const msgStep = wf.steps.find((s) => s.id === 'msg');
      assert.ok(msgStep, 'the step with id msg exists');
      const outFile = join(dir, 'github_output');
      writeFileSync(outFile, '');
      const baseCtx = {};
      for (const [k, v] of Object.entries(wf.env)) baseCtx[`env.${k}`] = v;
      const msgEnv = Object.fromEntries(Object.entries(msgStep.env).map(([k, v]) => [k, render(v, baseCtx)]));
      const r0 = sh(render(msgStep.run, baseCtx), { cwd: src, env: { ...IDENT, ...wf.env, ...msgEnv, GITHUB_OUTPUT: outFile } });
      assert.equal(r0.status, 0, `the message step failed: ${r0.stderr}`);
      const msg = parseOutputs(outFile).msg;
      assert.ok(msg !== undefined, 'the message step sets outputs.msg');

      const ctx = {
        ...baseCtx,
        'steps.msg.outputs.msg': msg,
        'secrets.PAT_TOKEN': 'dummy-not-a-secret',
      };

      for (const s of wf.steps.filter((x) => x.run && /git commit/.test(x.run))) {
        const work = mkdtempSync(join(dir, 'w-'));
        git(['init', '-q', '.'], work);
        writeFileSync(join(work, 'a.txt'), 'a\n');
        git(['add', '-A'], work);
        const line = s.run.split('\n').find((l) => /git commit/.test(l));
        const env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, render(v, ctx)]));
        const r = sh(render(line, ctx), { cwd: work, env: { ...IDENT, ...wf.env, ...env } });
        for (const m of ['pwned-title', 'pwned-branch', 'pwned-backtick']) {
          assert.ok(!existsSync(join(work, m)), `${s.name}: the subject ran as code (${m} was created); commit line: ${render(line, ctx).trim()}`);
        }
        assert.equal(r.status, 0, `${s.name}: commit failed: ${r.stderr}`);
        const got = git(['log', '-1', '--pretty=%s'], work).replace(/\r?\n$/, '');
        assert.equal(got, `Sync: ${subject}`, `${s.name}: the synced commit keeps the subject verbatim`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
