#!/usr/bin/env node
/**
 * wasm-repro.mjs: rebuild the shipped STARK prover blob from this tree with a
 * pinned toolchain, several times from clean target dirs, and check that every
 * rebuild is byte-identical to each other, to
 * `packages/stark-prover/wasm/p01_stark_bg.wasm`, to its wasm-bindgen glue, and
 * to the four base64 twins the clients actually import.
 *
 *   node scripts/ci/wasm-repro.mjs [--runs 2] [--work-dir DIR] [--cargo-home DIR]
 *   node --test scripts/ci/wasm-repro.test.mjs     (the comparator; no toolchain)
 *
 * Exit 0 = PASS, 1 = FAIL (a pin, a build or a comparison), 2 = usage error.
 * `.github/workflows/wasm-repro.yml` runs both on a Windows runner.
 *
 * # The recipe (each piece measured on 2026-09-18, WP0c)
 *
 *   cwd = repo root, CARGO_ENCODED_RUSTFLAGS = remapArgs(CARGO_HOME), then
 *   wasm-pack build stark --target web --out-dir <out> --release -- --features wasm --locked
 *
 * It is the recipe the blob was built with on 2026-09-12 (HANDOFF-2026-09-13 §6)
 * plus `--locked` and one path remap. Why each pin is there:
 *
 * - **The registry remap.** The shipped blob carries five panic-location strings
 *   under the builder's CARGO_HOME, `C:\Users\Slashy\.cargo\registry\src\...`
 *   (`embeddedSourcePaths`). The same recipe under any other CARGO_HOME emits
 *   other bytes: 265,836 B instead of 265,324, data section 512 B longer.
 *   One `--remap-path-prefix` from this machine's registry onto that prefix gives
 *   back the shipped bytes exactly, and changes nothing else: the rustc output is
 *   identical with and without it when CARGO_HOME is the builder's.
 * - **The host, x86_64-pc-windows-msvc.** Cargo hashes the host triple into the
 *   `-C metadata` of every crate with a build script or a proc-macro in its
 *   closure (typenum, digest, sha2, wasm-bindgen, js-sys, getrandom, p01-stark).
 *   A Linux rebuild with every embedded path respelled the Windows way still has
 *   one function fewer and 78 more code bytes (265,401 B). The shipped blob can
 *   only be reproduced on this host triple.
 * - **wasm-bindgen 0.2.114 built from crates.io** (`cargo install wasm-bindgen-cli
 *   --version =0.2.114 --locked`). The GitHub release binary of the same version
 *   stamps its commit into the producers section ("0.2.114 (22cfd5568)", 12 B
 *   more); the shipped blob says "0.2.114". Both print "wasm-bindgen 0.2.114" for
 *   --version, so only the producers diff tells them apart (`describeDifference`).
 * - **wasm-opt = binaryen version_117, first on PATH.** wasm-pack 0.14.0 runs the
 *   first `wasm-opt` on PATH as `wasm-opt <in> -o <out> -O` and downloads its own
 *   only when there is none. The copy it cached on 2026-09-12 is byte-identical
 *   to the binaryen version_117 release binary.
 * - **rustc 1.98.1 (48a229cea), wasm-pack 0.14.0.** The producers section of the
 *   shipped blob names rustc, walrus 0.25.2 and wasm-bindgen; the test file checks
 *   PINS against it, so a reship with other tools fails until PINS move with it.
 * - **A clean build environment.** RUSTFLAGS, CARGO_PROFILE_*, wrappers and the
 *   like would change the output; they are removed from the build's environment
 *   and the removal is printed.
 *
 * # What a FAIL means
 *
 * A pin FAIL means this machine is not the pinned toolchain. A comparison FAIL
 * after a change under `stark/` (or Cargo.lock) means the shipped blob is no
 * longer what this tree builds: every client runs a prover built from other
 * source. The remedy is a reship (rebuild with this recipe, then
 * `stark-wasm-twins.mjs --write`, then the record in deployed-verifier.json), or
 * reverting the change. The printed section diff says which kind of difference
 * it is: code, data (strings, paths), or producers (tool builds).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPO,
  CANONICAL,
  GLUE,
  TWIN_PATHS,
  extractBase64,
} from '../../packages/stark-prover/scripts/wasm-artifacts.mjs';

export const PINS = Object.freeze({
  rustc: {
    release: '1.98.1',
    commitHash: '48a229ceaefd4985c50990b14116b6d856af0985',
    commitDate: '2026-09-01',
    host: 'x86_64-pc-windows-msvc',
    llvm: '22.1.8',
  },
  wasmPack: '0.14.0',
  wasmBindgen: '0.2.114',
  walrus: '0.25.2',
  wasmOpt: 'version_117',
});

/** The registry prefix the shipped blob's panic locations carry (the builder's CARGO_HOME). */
export const BUILDER_REGISTRY_SRC = String.raw`C:\Users\Slashy\.cargo\registry\src`;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ── wasm reading ────────────────────────────────────────────────────────────

const SECTION_NAMES = ['custom', 'type', 'import', 'function', 'table', 'memory', 'global', 'export', 'start', 'element', 'code', 'data', 'datacount', 'tag'];

function cursor(buf, pos) {
  const c = {
    pos,
    leb() {
      let r = 0;
      let s = 0;
      let b;
      do {
        if (c.pos >= buf.length) throw new Error('truncated LEB128');
        b = buf[c.pos++];
        r += (b & 0x7f) * 2 ** s;
        s += 7;
      } while (b & 0x80);
      return r;
    },
    str() {
      const n = c.leb();
      if (c.pos + n > buf.length) throw new Error('string runs past the end');
      const v = buf.toString('utf8', c.pos, c.pos + n);
      c.pos += n;
      return v;
    },
  };
  return c;
}

/** The module's sections in order: `{ id, name, label, start, end, payload }`. Throws on a malformed module. */
export function wasmSections(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.readUInt32BE(0) !== 0x0061736d) {
    throw new Error('not a wasm module (bad magic)');
  }
  const out = [];
  const c = cursor(buf, 8);
  while (c.pos < buf.length) {
    const id = buf[c.pos++];
    const size = c.leb();
    const start = c.pos;
    const end = start + size;
    if (end > buf.length) throw new Error(`section ${id} at offset ${start} runs past the end`);
    let name = '';
    let payload = start;
    if (id === 0) {
      name = c.str();
      payload = c.pos;
    }
    out.push({ id, name, label: id === 0 ? `custom "${name}"` : (SECTION_NAMES[id] ?? `section ${id}`), start, end, payload });
    c.pos = end;
  }
  return out;
}

/** The `producers` custom section as `{ field: ['name version', ...] }`; `{}` when absent. */
export function producers(buf) {
  const s = wasmSections(buf).find((x) => x.id === 0 && x.name === 'producers');
  if (!s) return {};
  const c = cursor(buf, s.payload);
  const out = {};
  const fields = c.leb();
  for (let f = 0; f < fields; f++) {
    const field = c.str();
    const n = c.leb();
    const values = [];
    for (let k = 0; k < n; k++) {
      const name = c.str();
      const version = c.str();
      values.push(version ? `${name} ${version}` : name);
    }
    out[field] = values;
  }
  return out;
}

/**
 * Source-file paths the module carries (panic locations). rustc stores each one
 * NUL-terminated, so a run of path characters ending in `.rs` is one path; a
 * glued prefix before a drive letter is trimmed. Kept only when it has a `src`
 * directory, which drops URLs such as `https://docs.rs`.
 */
export function embeddedSourcePaths(buf) {
  const text = buf.toString('latin1');
  const found = new Set();
  for (const m of text.matchAll(/[A-Za-z0-9_.\-:\\/]+?\.rs(?![A-Za-z0-9_])/g)) {
    let p = m[0];
    const drive = p.search(/[A-Za-z]:[\\/]/);
    if (drive > 0) p = p.slice(drive);
    if (/[\\/]src[\\/]/.test(p)) found.add(p);
  }
  return [...found].sort();
}

// ── the recipe ──────────────────────────────────────────────────────────────

/** `--remap-path-prefix` that spells this machine's registry the way the shipped blob does. */
export function remapArgs(cargoHome) {
  return [`--remap-path-prefix=${win32.join(cargoHome, 'registry', 'src')}=${BUILDER_REGISTRY_SRC}`];
}

const HOST_WHY =
  ' (cargo hashes the host triple into -C metadata of every crate with a build script or proc-macro' +
  ' in its closure, so another host builds other code: measured in WP0c)';

/** Problems with the tool versions found on this machine; `[]` when every pin holds. */
export function checkTools({ rustcVV, wasmPack, wasmBindgen, wasmOpt, lockWasmBindgen }) {
  const problems = [];
  if (!rustcVV) {
    problems.push('rustc was not found');
  } else {
    const field = (k) => rustcVV.match(new RegExp(`^${k}: (.+)$`, 'm'))?.[1]?.trim();
    const want = {
      release: PINS.rustc.release,
      'commit-hash': PINS.rustc.commitHash,
      host: PINS.rustc.host,
      'LLVM version': PINS.rustc.llvm,
    };
    for (const [k, v] of Object.entries(want)) {
      const got = field(k);
      if (got !== v) problems.push(`rustc ${k} is ${got ?? 'missing'}, pinned ${v}${k === 'host' ? HOST_WHY : ''}`);
    }
  }
  if (wasmPack?.trim() !== `wasm-pack ${PINS.wasmPack}`) {
    problems.push(`wasm-pack is "${wasmPack?.trim() ?? 'not found'}", pinned ${PINS.wasmPack}`);
  }
  if (wasmBindgen?.trim() !== `wasm-bindgen ${PINS.wasmBindgen}`) {
    problems.push(`wasm-bindgen is "${wasmBindgen?.trim() ?? 'not found'}", pinned ${PINS.wasmBindgen}`);
  }
  if (!wasmOpt) {
    problems.push(`wasm-opt is not on PATH: wasm-pack would fetch its own. Put binaryen ${PINS.wasmOpt} first on PATH`);
  } else if (!wasmOpt.includes(`(${PINS.wasmOpt})`)) {
    problems.push(`wasm-opt is "${wasmOpt.trim()}", pinned ${PINS.wasmOpt}`);
  }
  if (lockWasmBindgen !== PINS.wasmBindgen) {
    problems.push(`Cargo.lock has wasm-bindgen ${lockWasmBindgen ?? '(none)'}; the CLI pin is ${PINS.wasmBindgen} and the two must match`);
  }
  return problems;
}

// ── the comparison ──────────────────────────────────────────────────────────

/** Why two modules differ: sizes, first offset, the sections that differ, producers, embedded paths. */
export function describeDifference(a, b) {
  const lines = [`sizes ${a.length} vs ${b.length} B`];
  const n = Math.min(a.length, b.length);
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      first = i;
      break;
    }
  }
  if (first < 0 && a.length !== b.length) first = n;
  if (first >= 0) lines.push(`first differing byte at offset ${first}`);
  let sa;
  let sb;
  try {
    sa = wasmSections(a);
    sb = wasmSections(b);
  } catch (e) {
    lines.push(`not comparable section by section: ${e.message}`);
    return lines;
  }
  const key = (s) => `${s.id}:${s.name}`;
  const differing = [];
  for (const s of sa) {
    const t = sb.find((x) => key(x) === key(s));
    if (!t) differing.push(`${s.label} only in the first`);
    else if (Buffer.compare(a.subarray(s.start, s.end), b.subarray(t.start, t.end)) !== 0) {
      differing.push(`${s.label} (${s.end - s.start} vs ${t.end - t.start} B)`);
    }
  }
  for (const t of sb) if (!sa.some((s) => key(s) === key(t))) differing.push(`${t.label} only in the second`);
  lines.push(differing.length > 0 ? `sections that differ: ${differing.join('; ')}` : 'every section is identical');
  const pa = producers(a)['processed-by'] ?? [];
  const pb = producers(b)['processed-by'] ?? [];
  if (pa.join('|') !== pb.join('|')) lines.push(`producers differ: [${pa.join(', ')}] vs [${pb.join(', ')}]`);
  const ea = embeddedSourcePaths(a);
  const eb = embeddedSourcePaths(b);
  const onlyA = ea.filter((p) => !eb.includes(p));
  const onlyB = eb.filter((p) => !ea.includes(p));
  if (onlyA.length > 0 || onlyB.length > 0) {
    lines.push(`embedded source paths differ: ${onlyA.length} only in the first, ${onlyB.length} only in the second`);
    for (const p of onlyA.slice(0, 8)) lines.push(`  first:  ${p}`);
    for (const p of onlyB.slice(0, 8)) lines.push(`  second: ${p}`);
  }
  return lines;
}

/**
 * The verdict. Every rebuild must equal the first (determinism) and the shipped
 * blob; every rebuild's glue must equal the shipped glue; every registered twin
 * must export exactly the shipped bytes.
 */
export function compareArtifacts({ builds = [], shipped, twins = [], twinPaths = TWIN_PATHS }) {
  const problems = [];
  const notes = [];
  const shippedSha = sha256(shipped.wasm);
  notes.push(`shipped blob: sha256 ${shippedSha} (${shipped.wasm.length} B)`);
  if (builds.length === 0) problems.push('no rebuild to compare: comparing nothing is not a reproduction');
  builds.forEach((b, k) => {
    const sha = sha256(b.wasm);
    notes.push(`${b.label}: sha256 ${sha} (${b.wasm.length} B)`);
    if (k > 0 && !b.wasm.equals(builds[0].wasm)) {
      problems.push(`${b.label} differs from ${builds[0].label}: the build is not deterministic on this host`);
      for (const l of describeDifference(builds[0].wasm, b.wasm)) notes.push(`${builds[0].label} vs ${b.label}: ${l}`);
    }
    if (!b.wasm.equals(shipped.wasm)) {
      problems.push(
        `${b.label} does not reproduce the shipped blob: sha256 ${sha} (${b.wasm.length} B) vs ${shippedSha} (${shipped.wasm.length} B)`,
      );
      for (const l of describeDifference(shipped.wasm, b.wasm)) notes.push(`shipped vs ${b.label}: ${l}`);
    }
    if (!b.glue || !shipped.glue || !b.glue.equals(shipped.glue)) {
      problems.push(`${b.label}: its wasm-bindgen glue (p01_stark.js) differs from the shipped glue`);
    }
  });
  for (const path of twinPaths) {
    const t = twins.find((x) => x.path === path);
    if (!t || t.text == null) {
      problems.push(`twin ${path} is missing`);
      continue;
    }
    const { base64, problem } = extractBase64(t.text);
    if (base64 === null) {
      problems.push(`twin ${path} ${problem}`);
      continue;
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.equals(shipped.wasm)) notes.push(`twin ${path}: identical to the shipped blob`);
    else problems.push(`twin ${path} decodes to sha256 ${sha256(bytes)} (${bytes.length} B), not the shipped blob`);
  }
  return { ok: problems.length === 0, problems, notes };
}

// ── main ────────────────────────────────────────────────────────────────────

/** Environment that would change what cargo builds; removed from the build's environment. */
const BUILD_ENV_OVERRIDES =
  /^(RUSTFLAGS|RUSTDOCFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_ENCODED_RUSTDOCFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_INCREMENTAL|CARGO_TARGET_DIR|CARGO_BUILD_.+|CARGO_PROFILE_.+|CARGO_TARGET_.+_(RUSTFLAGS|LINKER|RUNNER))$/i;

function parseArgs(argv) {
  const opts = { runs: 2, workDir: null, cargoHome: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--runs') opts.runs = Number(v);
    else if (a === '--work-dir') opts.workDir = v;
    else if (a === '--cargo-home') opts.cargoHome = v;
    else throw new Error(`unknown argument ${a}`);
    i++;
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a positive integer');
  return opts;
}

/** stdout of `cmd args`, trimmed, or null when it is not there or fails. */
function toolOutput(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: REPO, env, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function lockVersion(name) {
  const lock = readFileSync(resolve(REPO, 'Cargo.lock'), 'utf8');
  return lock.match(new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = "([^"]+)"`))?.[1] ?? null;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`wasm-repro: ${e.message}`);
    return 2;
  }
  const workDir = resolve(opts.workDir ?? join(tmpdir(), `p01-wasm-repro-${process.pid}`));

  const env = {};
  const stripped = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (BUILD_ENV_OVERRIDES.test(k)) stripped.push(k);
    else env[k] = v;
  }
  if (opts.cargoHome) env.CARGO_HOME = opts.cargoHome;
  const cargoHomeKey = Object.keys(env).find((k) => k.toUpperCase() === 'CARGO_HOME');
  const cargoHome = cargoHomeKey ? env[cargoHomeKey] : join(homedir(), '.cargo');
  const remap = remapArgs(cargoHome);

  const tools = {
    rustcVV: toolOutput('rustc', ['-vV'], env),
    wasmPack: toolOutput('wasm-pack', ['--version'], env),
    wasmBindgen: toolOutput('wasm-bindgen', ['--version'], env),
    wasmOpt: toolOutput('wasm-opt', ['--version'], env),
    lockWasmBindgen: lockVersion('wasm-bindgen'),
  };
  console.log(`wasm-repro: ${tools.rustcVV?.split(/\r?\n/)[0] ?? 'rustc not found'}, host ${tools.rustcVV?.match(/^host: (.+)$/m)?.[1] ?? '?'}`);
  console.log(`wasm-repro: ${tools.wasmPack ?? 'wasm-pack not found'}; ${tools.wasmBindgen ?? 'wasm-bindgen not found'}; ${tools.wasmOpt ?? 'wasm-opt not on PATH'}`);
  const toolProblems = checkTools(tools);
  if (toolProblems.length > 0) {
    console.log(`WASM-REPRO FAIL: this machine is not the pinned toolchain (${toolProblems.length} problem(s))`);
    for (const p of toolProblems) console.log(`  - ${p}`);
    return 1;
  }
  console.log(`wasm-repro: CARGO_HOME ${cargoHome}`);
  console.log(`wasm-repro: CARGO_ENCODED_RUSTFLAGS ${remap.join(' ')}`);
  if (stripped.length > 0) console.log(`wasm-repro: removed from the build environment: ${stripped.join(', ')}`);

  const shipped = { wasm: readFileSync(resolve(REPO, CANONICAL)), glue: readFileSync(resolve(REPO, GLUE)) };
  const twins = TWIN_PATHS.map((path) => ({
    path,
    text: existsSync(resolve(REPO, path)) ? readFileSync(resolve(REPO, path), 'utf8') : null,
  }));
  const builds = [];
  for (let k = 1; k <= opts.runs; k++) {
    const target = join(workDir, `target-${k}`);
    const out = join(workDir, `out-${k}`);
    rmSync(target, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    const args = ['build', 'stark', '--target', 'web', '--out-dir', out, '--release', '--', '--features', 'wasm', '--locked'];
    console.log(`wasm-repro: build ${k}/${opts.runs}: wasm-pack ${args.join(' ')}  (CARGO_TARGET_DIR ${target})`);
    const r = spawnSync('wasm-pack', args, {
      cwd: REPO,
      env: { ...env, CARGO_TARGET_DIR: target, CARGO_ENCODED_RUSTFLAGS: remap.join('\x1f') },
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      console.log(`WASM-REPRO FAIL: build ${k} exited ${r.status ?? r.error?.message}`);
      return 1;
    }
    const wasm = readFileSync(join(out, 'p01_stark_bg.wasm'));
    builds.push({ label: `build ${k}`, wasm, glue: readFileSync(join(out, 'p01_stark.js')) });
    console.log(`wasm-repro: build ${k}: sha256 ${sha256(wasm)} (${wasm.length} B)`);
  }

  const result = compareArtifacts({ builds, shipped, twins, twinPaths: TWIN_PATHS });
  for (const n of result.notes) console.log(`  note: ${n}`);
  if (!result.ok) {
    console.log(`WASM-REPRO FAIL: ${result.problems.length} problem(s)`);
    for (const p of result.problems) console.log(`  - ${p}`);
    return 1;
  }
  console.log(
    `WASM-REPRO PASS: ${builds.length} clean build(s) are byte-identical to each other, to ${CANONICAL} ` +
      `(sha256 ${sha256(shipped.wasm)}, ${shipped.wasm.length} B), to its glue and to its ${TWIN_PATHS.length} inlined twins`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
