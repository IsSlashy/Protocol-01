/**
 * prover-behaviour.mjs — decide which proof-format generation a prover blob
 * belongs to by RUNNING it, not by reading strings out of it.
 *
 * # Why this exists
 *
 * `deployed-verifier-check.mjs` has to answer one question about the checked-in
 * WASM prover: does it emit B1-format proofs or pre-B1-format proofs? Until this
 * file existed the answer came from a scan for panic-message literals — the blob
 * and the Rust sources were asked what generation they were and they answered
 * with TEXT. Text is editable, and it was measured editable four rounds running:
 *
 *   MEASURED 2026-07-31, against the tree this file was added to. Rewriting FOUR
 *   BYTES of panic text inside the blob (`B1 ` -> `Bx `, `DEEP ` -> `DEEQ `,
 *   `B1 depends on` -> `Bx depends on`), applying the same three renames to
 *   stark/src/compact.rs, rewording ONE msg! line in
 *   programs/p01_stark_verifier/src/verify.rs (that single line carries BOTH
 *   literals the deployed-ELF scan discriminates on), reshipping the four twins
 *   with `stark-wasm-twins.mjs --write` and pointing the record at the new hash
 *   printed
 *
 *     PASS - the shipped prover matches the devnet deployment, and the chain was
 *     asked and agreed
 *
 *   at exit code 0, against the genuinely pre-B1 devnet deployment. The blob was
 *   211,370 bytes before and after, WebAssembly.validate stayed true, every
 *   control literal survived, all five artifacts still agreed with each other,
 *   and EVERY PROOF THAT CLIENT PRODUCED WOULD STILL HAVE DIED WITH
 *   FriFoldCheckFailed. Five strings in a diff a human reads was the entire
 *   strength of the gate, and no adversary was needed: rewording those panic
 *   messages during an ordinary refactor has the identical silent effect.
 *
 * # What replaces it
 *
 * B1 changed WHAT FRI FOLDS — a DEEP composition instead of the raw quotient LDE
 * — without adding or removing a single byte. So:
 *
 *   LENGTH cannot separate the two generations. MEASURED 2026-07-31 by driving
 *   both blobs under Node 22: the B1 blob and the last pre-B1 blob emit
 *   45,001 / 65,801 / 66,681 / 75,637 / 78,377 / 76,357 / 78,517 bytes for
 *   C0..C6 — the same seven numbers, to the byte.
 *
 *   CONTENT does separate them, on every circuit. All seven sha256 digests
 *   differ between the two blobs. That is the discriminator, and it is not
 *   reachable by editing panic text: the doctored blob above, driven through
 *   this file, still produces all seven B1 digests.
 *
 * A proof digest cannot be renamed. To move it you have to change what the
 * prover computes, which is the thing the gate is trying to detect.
 *
 * # What this DOES NOT prove
 *
 * That the blob is B1 on every input. This is a SAMPLE: seven fixed witnesses.
 * A blob rigged to recognise those seven witnesses and replay pre-B1 proof bytes
 * for them, while proving B1 for everything else, would classify as pre-B1 here.
 * That is not a four-byte edit — it means carrying a second prover, or ~486 KB
 * of canned proofs, inside an artifact whose size is pinned in the record and
 * whose twins are hashed — but it is not impossible, and this file does not
 * claim otherwise.
 *
 * # Cost
 *
 * MEASURED on this box: instantiate ~1 ms, seven proofs ~5.0 s wall (C0 30 ms,
 * C1 100 ms, C2 85 ms, C3 1.0 s, C4 300 ms, C5 1.9 s, C6 1.5 s). There is NO
 * cache, deliberately. A cache is a place to keep a verdict that was not
 * measured on this run, and every cheap key for one (the record, a sidecar
 * file, a marker in the blob) is editable by exactly the person this gate
 * exists to stop. Five seconds, in a script that already waits on a devnet RPC
 * round trip, is the cheaper thing to defend.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { REPO } from './wasm-artifacts.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// The fixtures. Witnesses and B1 digests are the SAME ones already pinned, in
// two languages, by the two files named in CORROBORATING_PINS below.
// ---------------------------------------------------------------------------

/**
 * `b1` — MEASURED from the Rust prover in `stark/`, pinned independently in
 * `programs/p01_stark_verifier/tests/b1_deep_binding.rs` (FIXTURE_C*_SHA256) and
 * in `packages/stark-prover/src/wireFormat.test.ts` (Pin.sha256). Those two pins
 * are checked against this table at run time, so editing the seven digests here
 * to make a pre-B1 blob read as B1 means editing the same seven in a Rust test
 * and a vitest suite that both still run against the real artifacts.
 *
 * `preB1` — MEASURED 2026-07-31 by driving the last pre-B1 blob in git history,
 * 5fe610c90ff1fe15eb96abbbef3ca881b47923b68232335fda0df5546babd114 (194,540 B,
 * commit 4b375d7c), through this exact code path. It is ONE artifact, not a
 * generation: a blob that matches it is that prover, and a blob that matches
 * neither column is refused rather than guessed at.
 *
 * `bytes` is the serialized proof length, identical in both columns — recorded
 * so a failure report can show that length was never going to separate them.
 */
const FIXTURES = [
  {
    label: 'C0 subscriber_ownership',
    bytes: 45_001,
    b1: 'e4aad1058b8cdb5aa7fd488e0e7dce29820566d934e8b9cf56ef2e09a397efa7',
    preB1: 'baf01d179f166d8f38729ac4e6dc1a766e089ba1e98665dea4b981fafd488986',
    entry: 'generate_stark_proof',
    drive: () => [42n],
  },
  {
    label: 'C1 pool_commitment',
    bytes: 65_801,
    b1: '935d918c0a6f06691b24568de75fc174586e02c09dc0ac27f2f14537bdef4e9b',
    preB1: 'df52ee3c7047442813b6d9b844cc8e4d260cff8ed70af603250e006b914d961c',
    entry: 'generate_pool_commitment_stark_proof',
    drive: () => [42n, 17n, 7n, 11n],
  },
  {
    label: 'C2 balance_proof',
    bytes: 66_681,
    b1: '063d86a18071ae369132c12a69c5af0e3c2efbe82f6340e6d7ec910be80fd49f',
    preB1: '5171c80e65ba6ed63c0b5a58f58b0bad11a060a60445be483f797d4777cc7d33',
    entry: 'generate_balance_stark_proof',
    drive: () => [42n, 1000n, 777n, 999n],
  },
  {
    label: 'C3 merkle_path',
    bytes: 75_637,
    b1: '2d97f56ffc3157fe7c644679d2945130efed8ea39c890a24c6c16022e78d5d9c',
    preB1: '0db183b6a257d03b15bd6439ff0ea554b7006dd134a3ccd6f3f6433b971c6bf3',
    entry: 'generate_merkle_path_stark_proof',
    drive: (w) => [777n, ...w.str(csv(15, (i) => 1000 + i)), ...w.str(csv(15, (i) => i % 2))],
  },
  {
    label: 'C4 confidential_balance',
    bytes: 78_377,
    b1: 'f877836723d0711e7190c2fd5c8a5c6d0476f21794d39ffd47a075f57d53e3e7',
    preB1: 'fbb631a3146225798360fcf80defb748664b2848ae0e59c88e6c9ec6342b2818',
    entry: 'generate_confidential_balance_stark_proof',
    drive: () => [42n, 1000n, 111n, 800n, 222n, 200n, 333n, 999n],
  },
  {
    label: 'C5 transfer',
    bytes: 76_357,
    b1: '78afe9bbd533913771d5c2438e279934114fe4c6db934b67b43c0644376ea125',
    preB1: '373f74ccff5a6a1ff5cbbb284f670e1df66f6909ca5c7eb46d78aa872a5ff574',
    entry: 'generate_transfer_stark_proof',
    drive: () => [13n, 500n, 77n, 400n, 88n, 100n, 150n, 1234n, 555n, 65n, 2222n, 333n, 50n],
  },
  {
    label: 'C6 merkle_update',
    bytes: 78_517,
    b1: '8e1166f5d08bd948bc70a407d9261d6b88c1de5b257c4545918d9c36d94524fc',
    preB1: '8f815c4c3c09fb141d6eb256a66e4fda612624c1af59971c0c28a40dd4c408a2',
    entry: 'generate_merkle_update_stark_proof',
    drive: (w) => [111n, 222n, ...w.str(csv(15, (i) => 100 + i * 13)), ...w.str(csv(15, (i) => i % 2))],
  },
];

/** `pathElements` / `pathIndices` are passed as one comma-separated string. */
function csv(n, f) {
  return Array.from({ length: n }, (_, i) => String(f(i))).join(',');
}

/**
 * The two files that pin the same B1 digests from the OTHER side of the
 * language boundary. Every `b1` digest above must appear in BOTH.
 *
 * This is what stops the table above from being the next single point of
 * failure. `b1` and `preB1` are only useful to an attacker if he can swap them,
 * and swapping them here makes seven digests vanish from a Rust integration
 * test and a vitest suite that are both run against the real prover.
 *
 * Unreadable is a FAILURE, never a skip.
 */
const CORROBORATING_PINS = [
  'packages/stark-prover/src/wireFormat.test.ts',
  'programs/p01_stark_verifier/tests/b1_deep_binding.rs',
];

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Sanity of the table itself, before it is used to judge anything. Returns a
 * `{ title, lines }` failure block, or null.
 *
 * A classifier whose reference table has been emptied, truncated or had its two
 * columns collapsed would classify everything as whatever is left, so the table
 * is checked for exactly the shapes that produce a false green: too few
 * circuits, a malformed digest, and a circuit whose two generations are the same
 * string.
 */
export function fixtureTableProblem() {
  const lines = [];
  if (FIXTURES.length !== 7) {
    lines.push(`  the table has ${FIXTURES.length} circuits; all 7 shipping circuits must be driven`);
  }
  for (const f of FIXTURES) {
    if (!HEX64.test(f.b1) || !HEX64.test(f.preB1)) lines.push(`  ${f.label}: a digest is not 64 hex characters`);
    if (f.b1 === f.preB1) lines.push(`  ${f.label}: the b1 and pre-b1 digests are the same string`);
  }
  for (const rel of CORROBORATING_PINS) {
    let text;
    try {
      text = readFileSync(resolve(REPO, rel), 'utf8');
    } catch (e) {
      lines.push(`  cannot read ${rel}: ${e.message}`);
      continue;
    }
    const missing = FIXTURES.filter((f) => !text.includes(f.b1)).map((f) => f.label);
    if (missing.length > 0) lines.push(`  ${rel} no longer pins the B1 digest for ${missing.join(', ')}`);
  }
  if (lines.length === 0) return null;
  return {
    title: 'the behavioural classifier\'s own reference table is not trustworthy',
    lines: [
      ...lines,
      '',
      'These seven digests are what decides which generation the shipped prover is. They are pinned in',
      'three places on purpose — here, in a Rust integration test and in a vitest suite — so that moving',
      'them is not a one-file edit. Refusing to classify while they disagree.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Driving the blob
// ---------------------------------------------------------------------------

/** The one host function a wasm-bindgen prover blob imports. */
const EXTERNREF_INIT = '__wbindgen_init_externref_table';

/** Exports the fixtures need. A blob missing any of them cannot be classified. */
const REQUIRED_EXPORTS = [
  'memory',
  '__wbindgen_start',
  '__wbindgen_malloc',
  '__wbindgen_free',
  '__wbindgen_externrefs',
  ...FIXTURES.map((f) => f.entry),
];

/**
 * Instantiate `bytes` and expose the wasm-bindgen marshalling the fixtures need.
 *
 * Imports are satisfied by NAME, from whatever module namespace the blob asks
 * for, so a wasm-bindgen glue rename does not silently change the verdict. Any
 * import this file does not recognise gets a stub that throws: instantiation
 * still succeeds, and if the blob actually calls it the run fails closed instead
 * of continuing with a host function that does nothing.
 */
function instantiate(bytes) {
  const mod = new WebAssembly.Module(bytes);
  let exp = null;
  const imports = {};
  const unknown = [];
  for (const im of WebAssembly.Module.imports(mod)) {
    imports[im.module] ??= {};
    if (im.name === EXTERNREF_INIT) {
      imports[im.module][im.name] = () => {
        const table = exp.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      };
    } else {
      unknown.push(`${im.module}.${im.name}`);
      imports[im.module][im.name] = () => {
        throw new Error(`the blob called an import this classifier cannot provide: ${im.module}.${im.name}`);
      };
    }
  }
  exp = new WebAssembly.Instance(mod, imports).exports;
  const missing = REQUIRED_EXPORTS.filter((n) => exp[n] === undefined);
  if (missing.length > 0) throw new Error(`the blob does not export ${missing.join(', ')}`);
  exp.__wbindgen_start();

  /** Fresh view every time — the heap grows under us while a proof is built. */
  const mem = () => new Uint8Array(exp.memory.buffer);

  return {
    unknownImports: unknown,
    /** Push an ASCII string into the wasm heap; the callee takes ownership. */
    str(s) {
      const ptr = exp.__wbindgen_malloc(s.length, 1) >>> 0;
      const m = mem();
      for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        if (c > 0x7f) throw new Error('fixture witnesses are ASCII by construction');
        m[ptr + i] = c;
      }
      return [ptr, s.length];
    },
    /** Call a proof entry point and return its decoded JSON. */
    call(name, args) {
      const [ptr, len] = exp[name](...args);
      const p = ptr >>> 0;
      const json = new TextDecoder('utf-8', { fatal: true }).decode(mem().subarray(p, p + len));
      exp.__wbindgen_free(ptr, len, 1);
      return JSON.parse(json);
    },
  };
}

/**
 * Classify a prover blob by what it emits.
 *
 * Returns `{ generation, results, problem, ms }`.
 *   generation  'b1'      every circuit matched the B1 digest
 *               'pre-b1'  every circuit matched the pre-B1 fixture digest
 *               null      ANYTHING else, including a mixture, an unknown digest,
 *                         a blob that will not instantiate and a blob that
 *                         throws mid-proof. `null` MUST be treated as a failure
 *                         by the caller; it is never "probably pre-b1".
 *
 * Unanimity is required in both directions on purpose. A blob that is B1 on some
 * circuits and pre-B1 on others is not a generation, and the reading that would
 * ship it is the one that calls it pre-B1.
 */
export function classifyProverBehaviour(bytes) {
  const t0 = Date.now();
  let w;
  try {
    w = instantiate(bytes);
  } catch (e) {
    return {
      generation: null,
      results: [],
      ms: Date.now() - t0,
      problem: `the blob could not be instantiated and driven: ${e.message}`,
    };
  }

  const results = [];
  for (const f of FIXTURES) {
    let json;
    try {
      json = w.call(f.entry, f.drive(w));
    } catch (e) {
      return {
        generation: null,
        results,
        ms: Date.now() - t0,
        problem: `${f.label} could not be proved: ${e.message}`,
      };
    }
    if (typeof json?.proof_hex !== 'string' || !/^[0-9a-f]*$/.test(json.proof_hex)) {
      return {
        generation: null,
        results,
        ms: Date.now() - t0,
        problem: `${f.label} returned no usable proof_hex`,
      };
    }
    const proof = Buffer.from(json.proof_hex, 'hex');
    const digest = sha256(proof);
    results.push({
      label: f.label,
      bytes: proof.length,
      expectedBytes: f.bytes,
      digest,
      verdict: digest === f.b1 ? 'b1' : digest === f.preB1 ? 'pre-b1' : 'unknown',
      b1: f.b1,
      preB1: f.preB1,
    });
  }

  const verdicts = new Set(results.map((r) => r.verdict));
  const generation = verdicts.size === 1 && !verdicts.has('unknown') ? results[0].verdict : null;
  return {
    generation,
    results,
    ms: Date.now() - t0,
    problem:
      generation === null
        ? verdicts.has('unknown')
          ? 'at least one circuit emitted a proof this classifier has never measured'
          : 'the circuits disagree about which generation this prover is'
        : null,
  };
}

/** Human-readable per-circuit table for a failure report. */
export function describeBehaviour(behaviour) {
  return behaviour.results.map(
    (r) =>
      `  ${r.label.padEnd(24)} ${String(r.bytes).padStart(6)} B  ${r.digest}  ${
        r.verdict === 'unknown' ? 'MATCHES NEITHER GENERATION' : r.verdict
      }`,
  );
}

export { FIXTURES as PROOF_FORMAT_FIXTURES };
