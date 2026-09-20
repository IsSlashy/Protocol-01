// Tests for scripts/ci/wasm-repro.mjs. Run: node --test scripts/ci/wasm-repro.test.mjs
//
// These need no Rust toolchain. They check the comparator and the recipe
// helpers against planted modules (each negative case must FAIL, so a
// comparator that passes everything goes red here) and against the checked-in
// blob, whose producers section and embedded paths are the evidence the pins
// in wasm-repro.mjs were read from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PINS,
  BUILDER_REGISTRY_SRC,
  wasmSections,
  producers,
  embeddedSourcePaths,
  remapArgs,
  checkTools,
  describeDifference,
  compareArtifacts,
} from './wasm-repro.mjs';
import { REPO, CANONICAL, GLUE, TWIN_PATHS } from '../../packages/stark-prover/scripts/wasm-artifacts.mjs';

// ── planted modules ─────────────────────────────────────────────────────────

const leb = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
const str = (s) => Buffer.concat([leb(Buffer.byteLength(s)), Buffer.from(s)]);
const section = (id, payload) => Buffer.concat([Buffer.from([id]), leb(payload.length), payload]);
const custom = (name, payload) => section(0, Buffer.concat([str(name), payload]));
const producersPayload = (fields) =>
  Buffer.concat([
    leb(fields.length),
    ...fields.map(([field, values]) =>
      Buffer.concat([str(field), leb(values.length), ...values.map(([n, v]) => Buffer.concat([str(n), str(v)]))]),
    ),
  ]);

const SHIPPED_TOOLS = [
  ['rustc', '1.98.1 (48a229cea 2026-09-01)'],
  ['walrus', '0.25.2'],
  ['wasm-bindgen', '0.2.114'],
];

/** A structurally valid module: code, data and a producers section. Big enough for a twin literal. */
function plantedWasm({ code = 'code-A', data = 'data-A', processedBy = SHIPPED_TOOLS } = {}) {
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    section(10, Buffer.from(code.padEnd(700, '.'))),
    section(11, Buffer.from(data.padEnd(700, '.'))),
    custom('producers', producersPayload([['language', [['Rust', '']]], ['processed-by', processedBy]])),
  ]);
}

const twinText = (buf) =>
  `/** planted twin */\nexport const STARK_WASM_BASE64 = '${buf.toString('base64')}';\n`;

function plantedSet(overrides = {}) {
  const wasm = plantedWasm();
  const glue = Buffer.from('export function prove() {}\n');
  return {
    builds: [
      { label: 'build 1', wasm, glue },
      { label: 'build 2', wasm: Buffer.from(wasm), glue: Buffer.from(glue) },
    ],
    shipped: { wasm, glue },
    twins: TWIN_PATHS.map((path) => ({ path, text: twinText(wasm) })),
    twinPaths: TWIN_PATHS,
    ...overrides,
  };
}

// ── the comparator ──────────────────────────────────────────────────────────

test('compareArtifacts: a consistent planted set passes', () => {
  const r = compareArtifacts(plantedSet());
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('compareArtifacts: a twin that decodes to other bytes fails and is named', () => {
  const set = plantedSet();
  const other = plantedWasm({ code: 'code-B' });
  set.twins[2] = { path: set.twins[2].path, text: twinText(other) };
  const r = compareArtifacts(set);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes(TWIN_PATHS[2])), r.problems.join('\n'));
});

test('compareArtifacts: a twin carrying a decoy second literal fails', () => {
  const set = plantedSet();
  const wasm = set.shipped.wasm;
  set.twins[0] = {
    path: set.twins[0].path,
    text: `const decoy = '${plantedWasm({ code: 'decoy' }).toString('base64')}';\n${twinText(wasm)}`,
  };
  const r = compareArtifacts(set);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes(TWIN_PATHS[0])), r.problems.join('\n'));
});

test('compareArtifacts: a missing twin fails', () => {
  const set = plantedSet();
  set.twins = set.twins.slice(0, 3);
  const r = compareArtifacts(set);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes(TWIN_PATHS[3])), r.problems.join('\n'));
});

test('compareArtifacts: two builds that differ fail as non-deterministic, even when one matches', () => {
  const set = plantedSet();
  set.builds[1] = { ...set.builds[1], wasm: plantedWasm({ data: 'data-B' }) };
  const r = compareArtifacts(set);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /determinis/i.test(p)), r.problems.join('\n'));
});

test('compareArtifacts: builds that agree with each other but not with the shipped blob fail', () => {
  const rebuilt = plantedWasm({ code: 'code-C' });
  const set = plantedSet();
  set.builds = set.builds.map((b) => ({ ...b, wasm: Buffer.from(rebuilt) }));
  const r = compareArtifacts(set);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /does not reproduce/.test(p)), r.problems.join('\n'));
});

test('compareArtifacts: a glue mismatch fails', () => {
  const set = plantedSet();
  set.builds = set.builds.map((b) => ({ ...b, glue: Buffer.from('export function prove(x) {}\n') }));
  const r = compareArtifacts(set);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /glue/.test(p)), r.problems.join('\n'));
});

test('compareArtifacts: zero builds is a failure, not a vacuous pass', () => {
  const r = compareArtifacts(plantedSet({ builds: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.problems.length > 0);
});

// ── the diagnostics ─────────────────────────────────────────────────────────

test('wasmSections walks the planted module', () => {
  const secs = wasmSections(plantedWasm());
  assert.deepEqual(
    secs.map((s) => [s.id, s.name]),
    [
      [10, ''],
      [11, ''],
      [0, 'producers'],
    ],
  );
});

test('describeDifference: a producers-only difference is named as such, with both tool lists', () => {
  const a = plantedWasm();
  const b = plantedWasm({
    processedBy: [SHIPPED_TOOLS[0], SHIPPED_TOOLS[1], ['wasm-bindgen', '0.2.114 (22cfd5568)']],
  });
  const lines = describeDifference(a, b).join('\n');
  assert.match(lines, /producers/);
  assert.match(lines, /0\.2\.114 \(22cfd5568\)/);
  assert.doesNotMatch(lines, /\bcode\b.*differs/i);
});

test('describeDifference: a code difference is named as such', () => {
  const lines = describeDifference(plantedWasm(), plantedWasm({ code: 'code-D' })).join('\n');
  assert.match(lines, /code/);
});

// rustc 1.98 stores each panic-location file name NUL-terminated (the shipped
// blob has `...\src\core_api.rs<0>stark\s...`), so the planted strings are too.
test('embeddedSourcePaths finds host paths of either spelling', () => {
  const buf = Buffer.concat([
    plantedWasm(),
    Buffer.from(
      'xxC:\\Users\\someone\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\sha2-0.10.9\\src\\core_api.rs\0' +
        'stark\\src\\air\\spend.rs\0/home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/once_cell-1.21.4/src/lib.rs' +
        '\0/rustc/48a229ceaefd4985c50990b14116b6d856af0985/library/core/src/num/mod.rs\0https://docs.rs',
    ),
  ]);
  const paths = embeddedSourcePaths(buf);
  assert.ok(paths.includes('C:\\Users\\someone\\.cargo\\registry\\src\\index.crates.io-1949cf8c6b5b557f\\sha2-0.10.9\\src\\core_api.rs'), paths.join('\n'));
  assert.ok(paths.includes('/home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/once_cell-1.21.4/src/lib.rs'), paths.join('\n'));
  assert.ok(paths.includes('/rustc/48a229ceaefd4985c50990b14116b6d856af0985/library/core/src/num/mod.rs'), paths.join('\n'));
  assert.ok(paths.some((p) => p.endsWith('stark\\src\\air\\spend.rs')), paths.join('\n'));
  assert.ok(!paths.some((p) => p.includes('docs.rs')), paths.join('\n'));
});

// ── the recipe helpers ──────────────────────────────────────────────────────

test('remapArgs maps the builder-local registry onto the prefix the shipped blob carries', () => {
  assert.deepEqual(remapArgs('D:\\a\\_temp\\cargo-home'), [
    '--remap-path-prefix=D:\\a\\_temp\\cargo-home\\registry\\src=C:\\Users\\Slashy\\.cargo\\registry\\src',
  ]);
  assert.deepEqual(remapArgs('C:/x/ch'), ['--remap-path-prefix=C:\\x\\ch\\registry\\src=C:\\Users\\Slashy\\.cargo\\registry\\src']);
});

const GOOD_TOOLS = {
  rustcVV: [
    'rustc 1.98.1 (48a229cea 2026-09-01)',
    'binary: rustc',
    'commit-hash: 48a229ceaefd4985c50990b14116b6d856af0985',
    'commit-date: 2026-09-01',
    'host: x86_64-pc-windows-msvc',
    'release: 1.98.1',
    'LLVM version: 22.1.8',
  ].join('\n'),
  wasmPack: 'wasm-pack 0.14.0',
  wasmBindgen: 'wasm-bindgen 0.2.114',
  wasmOpt: 'wasm-opt version 117 (version_117)',
  lockWasmBindgen: '0.2.114',
};

test('checkTools accepts the pinned set', () => {
  assert.deepEqual(checkTools(GOOD_TOOLS), []);
});

test('checkTools rejects each drift on its own', () => {
  const drifts = {
    rustcVV: GOOD_TOOLS.rustcVV.replace('48a229ceaefd4985c50990b14116b6d856af0985', '0123456789abcdef0123456789abcdef01234567'),
    wasmPack: 'wasm-pack 0.15.0',
    wasmBindgen: 'wasm-bindgen 0.2.113',
    wasmOpt: 'wasm-opt version 116 (version_116)',
    lockWasmBindgen: '0.2.113',
  };
  for (const [k, v] of Object.entries(drifts)) {
    const problems = checkTools({ ...GOOD_TOOLS, [k]: v });
    assert.ok(problems.length > 0, `a drifted ${k} was accepted`);
  }
  assert.ok(checkTools({ ...GOOD_TOOLS, wasmOpt: null }).length > 0, 'a missing wasm-opt was accepted');
  assert.ok(
    checkTools({ ...GOOD_TOOLS, rustcVV: GOOD_TOOLS.rustcVV.replace('x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu') }).length > 0,
    'a Linux host was accepted (the host triple enters cargo metadata, see wasm-repro.mjs)',
  );
});

// ── the checked-in artifacts ────────────────────────────────────────────────

const shippedWasm = readFileSync(resolve(REPO, CANONICAL));
const shippedGlue = readFileSync(resolve(REPO, GLUE));

test('the pins are the tools the shipped blob says built it', () => {
  const p = producers(shippedWasm);
  assert.deepEqual(p.language, ['Rust']);
  assert.deepEqual(p['processed-by'], [
    `rustc ${PINS.rustc.release} (${PINS.rustc.commitHash.slice(0, 9)} ${PINS.rustc.commitDate})`,
    `walrus ${PINS.walrus}`,
    `wasm-bindgen ${PINS.wasmBindgen}`,
  ]);
});

test('the shipped blob carries the builder registry prefix and Windows-spelled workspace paths', () => {
  const paths = embeddedSourcePaths(shippedWasm);
  const absoluteWindows = paths.filter((p) => /^[A-Za-z]:[\\/]/.test(p));
  assert.ok(absoluteWindows.length > 0, 'no absolute builder path found: the remap target would be unfounded');
  for (const p of absoluteWindows) assert.ok(p.startsWith(`${BUILDER_REGISTRY_SRC}\\`), p);
  assert.ok(paths.some((p) => p.startsWith('stark\\src\\')), paths.join('\n'));
  assert.ok(!paths.some((p) => p.startsWith('stark/src/')), paths.join('\n'));
});

test('the checked-in blob, glue and four twins agree through the comparator', () => {
  const twins = TWIN_PATHS.map((path) => ({ path, text: readFileSync(resolve(REPO, path), 'utf8') }));
  const r = compareArtifacts({
    builds: [{ label: 'checked-in', wasm: shippedWasm, glue: shippedGlue }],
    shipped: { wasm: shippedWasm, glue: shippedGlue },
    twins,
    twinPaths: TWIN_PATHS,
  });
  assert.deepEqual(r.problems, []);
});
