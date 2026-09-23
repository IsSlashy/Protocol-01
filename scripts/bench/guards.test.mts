/**
 * node --test scripts/bench/guards.test.mts
 *
 * Where a run may write. A dry run measures nothing that may be published, yet
 * `live-timing.ts --dry-run` prints proving times: before this guard a dry run
 * with no --out wrote them under docs/bench/<date>/ (verifier finding,
 * 2026-09-22). The rules pinned here:
 *   - a dry run never writes under docs/bench, whatever --out says;
 *   - a dry run with no --out goes to a scratch directory under the temp dir;
 *   - a measuring run with N < 30 never writes under docs/bench, and neither
 *     does a run whose wasm cold rows have fewer than 30 samples (--cold-n);
 *   - on Windows the check is case-insensitive and survives another drive.
 * And the private directory (re-verifier finding, 2026-09-22):
 *   - every run gets a new, empty private directory, so a --cache cold sample
 *     never reads an earlier run's history cache and a purchase sample never
 *     resumes an earlier run's record;
 *   - before a cold sample its cache file is removed; a purchase record left
 *     in place is never deleted (it may hold an unredeemed claim code): the
 *     sample is refused instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveOutDir, smallestSampleCount, makePrivateRunDir, prepareSampleFiles, nonEmptyOutRefusal, pidsForProfile } from './guards.mts';

const W = path.win32;
const base = { root: 'D:\\Protocol-01', date: '2026-09-22', tmpDir: 'C:\\Users\\A\\AppData\\Local\\Temp', minN: 30, pathApi: W };

test('a dry run with no --out goes to a scratch directory, not docs/bench', () => {
  const r = resolveOutDir({ ...base, dry: true, n: 30 });
  assert.equal(r.refused, undefined);
  assert.ok(!r.out.toLowerCase().includes('docs\\bench'), r.out);
  assert.ok(r.out.toLowerCase().startsWith(base.tmpDir.toLowerCase()), r.out);
});

test('a dry run is refused under docs/bench, whatever the case or the depth', () => {
  for (const out of ['D:\\Protocol-01\\docs\\bench\\2026-09-22', 'd:\\protocol-01\\Docs\\Bench\\x', 'D:\\Protocol-01\\docs\\bench']) {
    const r = resolveOutDir({ ...base, dry: true, n: 30, out });
    assert.ok(r.refused, `not refused: ${out}`);
  }
});

test('a measuring run with N < 30 is refused under docs/bench, allowed elsewhere', () => {
  assert.ok(resolveOutDir({ ...base, dry: false, n: 5 }).refused);
  assert.ok(resolveOutDir({ ...base, dry: false, n: 5, out: 'd:\\protocol-01\\DOCS\\bench\\z' }).refused);
  assert.equal(resolveOutDir({ ...base, dry: false, n: 5, out: 'E:\\scratch\\smoke' }).refused, undefined);
});

test('a measuring run with N >= 30 and no --out writes to docs/bench/<date>', () => {
  const r = resolveOutDir({ ...base, dry: false, n: 30 });
  assert.equal(r.refused, undefined);
  assert.equal(r.out, 'D:\\Protocol-01\\docs\\bench\\2026-09-22');
});

test('a path on another drive is not mistaken for docs/bench', () => {
  const r = resolveOutDir({ ...base, dry: true, n: 30, out: 'E:\\docs\\bench\\2026-09-22' });
  assert.equal(r.refused, undefined);
});

test('--n 30 --cold-n 5 with a wasm flow is refused under docs/bench (5 cold samples per row)', () => {
  for (const flows of [['wasm-node'], ['wasm-browser'], ['native', 'wasm-node', 'wasm-browser', 'deposit']]) {
    const n = smallestSampleCount({ n: 30, coldN: 5, flows });
    assert.equal(n, 5, flows.join(','));
    assert.ok(resolveOutDir({ ...base, dry: false, n }).refused, flows.join(','));
  }
});

test('--cold-n only counts where a flow writes cold rows', () => {
  assert.equal(smallestSampleCount({ n: 30, coldN: 5, flows: ['native', 'stark-pipeline', 'deposit', 'withdrawal'] }), 30);
  assert.equal(smallestSampleCount({ n: 30, coldN: 40, flows: ['wasm-node'] }), 30);
  assert.equal(smallestSampleCount({ n: 12, coldN: 30, flows: ['wasm-browser'] }), 12);
});

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'styx-bench-guards-test-'));
}

test('two runs, even started in the same millisecond, get two different empty private directories', () => {
  const root = scratch();
  try {
    const a = makePrivateRunDir(root, '2026-09-22T10:00:00.000Z');
    writeFileSync(path.join(a, 'withdrawal-history-cache-1.json'), '{"k":{}}');
    const b = makePrivateRunDir(root, '2026-09-22T10:00:00.000Z');
    assert.notEqual(a, b);
    assert.deepEqual(readdirSync(b), []);
    for (const d of [a, b]) assert.ok(path.relative(root, d) && !path.relative(root, d).startsWith('..'), d);
    assert.notEqual(a, path.join(root, '2026-09-22'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cold sample starts with no cache file; a warm one keeps the cache the previous sample left', () => {
  const dir = scratch();
  try {
    const cold = prepareSampleFiles({ privateDir: dir, id: 'withdrawal', tag: '1', cache: 'cold' });
    writeFileSync(cold.cacheFile!, '{"stale":{}}');
    const again = prepareSampleFiles({ privateDir: dir, id: 'withdrawal', tag: '1', cache: 'cold' });
    assert.equal(again.cacheFile, cold.cacheFile);
    assert.equal(existsSync(cold.cacheFile!), false, 'a cold sample must not read a cache left in place');

    const w1 = prepareSampleFiles({ privateDir: dir, id: 'subscription', tag: 'warmup', cache: 'warm' });
    writeFileSync(w1.cacheFile!, '{"filled":{}}');
    const w2 = prepareSampleFiles({ privateDir: dir, id: 'subscription', tag: '1', cache: 'warm' });
    assert.equal(w2.cacheFile, w1.cacheFile);
    assert.equal(existsSync(w2.cacheFile!), true, 'the warm cache is what a warm sample measures');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deposit gets no cache file at all (the harness does not read one)', () => {
  const dir = scratch();
  try {
    assert.equal(prepareSampleFiles({ privateDir: dir, id: 'deposit', tag: '1', cache: 'cold' }).cacheFile, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a purchase record or its .progress.json left in place refuses the sample and is not deleted', () => {
  const dir = scratch();
  try {
    const p = prepareSampleFiles({ privateDir: dir, id: 'purchase', tag: '1', cache: 'warm' });
    assert.equal(p.recordFile, path.join(dir, 'purchase-record-1.json'));
    for (const f of [p.recordFile!, `${p.recordFile}.progress.json`]) {
      writeFileSync(f, '{"spendSig":"x"}');
      assert.throws(() => prepareSampleFiles({ privateDir: dir, id: 'purchase', tag: '1', cache: 'warm' }), /resume/);
      assert.equal(existsSync(f), true, 'never delete a record that may hold a claim code');
      rmSync(f);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Two runs into one directory (re-verifier finding r2, 2026-09-22): `--only
// local` then `--only live` on the same day both defaulted to
// docs/bench/<date>/, so the second overwrote manifest.json and summary.md and
// left the first run's <flow>.json with no manifest describing it.
test('two runs on the same day get two directories by default', () => {
  const a = resolveOutDir({ ...base, dry: false, n: 30, runId: 'run-20260922T101500Z' });
  const b = resolveOutDir({ ...base, dry: false, n: 30, runId: 'run-20260922T143000Z' });
  assert.notEqual(a.out, b.out);
  assert.equal(a.out, W.join(base.root, 'docs', 'bench', '2026-09-22', 'run-20260922T101500Z'));
});

test('a run refuses an output directory that already holds files', () => {
  assert.match(String(nonEmptyOutRefusal(W.join('D:', 'x'), ['manifest.json'])), /not empty/);
  assert.equal(nonEmptyOutRefusal(W.join('D:', 'x'), []), undefined);
});

test('the leftover Chrome processes of this run are found by their profile, and only those', () => {
  const profile = W.join('C:', 'Users', 'A', 'AppData', 'Local', 'Temp', 'styx-bench-profile-rWn4m2');
  const other = W.join('C:', 'Users', 'A', 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  const procs = [
    { pid: 11, commandLine: `"chrome.exe" --type=renderer --user-data-dir=${profile} --foo` },
    { pid: 12, commandLine: `"chrome.exe" --type=gpu-process --user-data-dir="${profile}"` },
    { pid: 13, commandLine: `"chrome.exe" --user-data-dir=${other}` },
    { pid: 14, commandLine: `"chrome.exe" --user-data-dir=${profile}X` },
    { pid: 15, commandLine: null },
  ];
  assert.deepEqual(pidsForProfile(procs, profile), [11, 12]);
});
