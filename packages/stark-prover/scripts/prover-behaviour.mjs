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
 * # [B2] A THIRD generation
 *
 * B2 splits the composition polynomial into `quotient_segments` columns, which
 * widens three wire fields, so unlike B1 it is NOT length-preserving: C0..C6 go
 * to 47,641 / 68,881 / 69,761 / 78,157 / 81,457 / 78,877 / 81,037 bytes. Length
 * therefore DOES separate B2 from the two earlier generations.
 *
 * That is not licence to classify on length. A blob can be given any length;
 * only content is expensive to fake. The `bytes` column stays a recorded
 * observation for the failure report and the verdict stays on the digest, now
 * three-way. A blob matching NONE of the three is still refused rather than
 * guessed at, which is the property that matters.
 *
 * A proof digest cannot be renamed. To move it you have to change what the
 * prover computes, which is the thing the gate is trying to detect.
 *
 * # [MASK 2026-08-29 .. 2026-08-31] Five circuits stopped being byte-reproducible
 *
 * C7 never had a digest: its prover draws a CSPRNG blinding mask per proof and
 * refuses to build without one. C1, C3 and C6 took the same kind of mask on
 * 2026-08-29 and C5 on 2026-08-31, so for FIVE of the eight shipping circuits
 * two proofs of the same witness are different bytes BY CONSTRUCTION. A digest
 * fixture for any of them cannot exist, and one could only be made to pass by
 * removing the masking — the underdetermination the whole privacy argument
 * rests on. `wireFormat.test.ts` (`Pin.sha256`) and `b1_deep_binding.rs`
 * retired the same digests on the same days for the same reason.
 *
 * So the table now has two kinds of row, the verdict is reached differently on
 * each, and every row SAYS which it is rather than letting one label cover both:
 *
 *   DIGEST rows  C0, C2, C4. Deterministic. The proof's sha256 must equal the
 *                column of one generation, exactly as before. Content is the
 *                discriminator; length is an observation.
 *
 *   MASKED rows  C1, C3, C5, C6, C7. The proof is driven and decoded and its
 *                LENGTH must equal what the current generation emits — the
 *                same number `wireFormat.test.ts` (`absolute`),
 *                `b1_deep_binding.rs` (`len`) and `cross_circuit_confusion.rs`
 *                pin against the Rust prover, and this file reads those pins
 *                back at run time exactly as it reads the digest pins. Length is
 *                all a masked proof has that is reproducible.
 *
 * ⚠️ WHAT A MASKED ROW CAN AND CANNOT SEE, stated so nobody reads "8/8" as more
 * than it is. Length pins the wire LAYOUT — field widths, query count, trace
 * width, path depth — and a proof that decodes at all pins that the entry point
 * exists and runs to completion on the fixture witness. It does NOT pin what
 * FRI folds. That is the B1-class gap the top of this file describes, and on
 * the masked circuits it is OPEN by necessity. MEASURED 2026-09-02 through this
 * exact code path: the 2026-08-31 blob df02e19c (the 160-entry lift) emits C1
 * at 94,897 B and C0 at the same digest as the shipped blob 36c1fd4e, so THIS
 * CLASSIFIER CANNOT TELL THOSE TWO APART, although the deployed verifier
 * rejects every C1/C3/C6/C7 proof of the older one with DeepAliFailed. What
 * separates them in the gate is the record: `client_blob.sha256`, and the human
 * attestation `accepts_client_blob_sha256`. The pre-lift blobs ARE separated
 * here — 72a8c700 emits C1 at 68,881 B, and 51a947e3 has no circuit 7 at all
 * (both MEASURED the same day, same code path).
 *
 * What still covers the masked circuits' CONTENT is the two suites this file
 * corroborates against and does not run: `wireFormat.test.ts` asserts that two
 * proofs of the same witness DIFFER (the property a digest can never express),
 * and `b1_deep_binding.rs` drives the Rust prover with a FIXED mask and pins the
 * result. CI runs both.
 *
 * # [GLUE 2026-09-02] Instantiated THROUGH the generated wasm-bindgen glue
 *
 * Until this revision `instantiate()` satisfied the blob's imports by hand: one
 * real import (`__wbindgen_init_externref_table`) and a throwing stub for every
 * other. That held while the prover was pure computation. A masked prover asks
 * the host for randomness — getrandom -> `crypto.getRandomValues`, reached
 * through `self` / `globalThis` — and the first masked circuit this file drove
 * died on a stub. MEASURED 2026-09-02: the gate had been red since 2026-08-25
 * with "C5 transfer could not be proved: the blob called an import this
 * classifier cannot provide: ./p01_stark_bg.js.__wbg_static_accessor_SELF_…".
 *
 * The blob is now instantiated by `initSync({ module })` of the generated glue,
 * `packages/stark-prover/wasm/p01_stark.js` — the same file every client loads
 * through `src/wasm-loader.ts` — imported from the canonical path
 * `wasm-artifacts.mjs` names as GLUE. Three consequences, all deliberate:
 *
 *   - The 25 content-hashed imports are the glue's problem, as they are for the
 *     clients. A blob whose imports the glue on disk cannot satisfy fails to
 *     LINK here, and that is a real finding, not a limitation: the same pair
 *     fails in every client, so the blob and its glue were not shipped together.
 *
 *   - A FRESH glue module instance is imported for every classification, by a
 *     cache-busting query on the module URL. The glue's `initSync` is idempotent
 *     (`if (wasm !== undefined) return wasm;`) and its `wasm` binding is module
 *     state, so a second blob classified through the same instance would be
 *     driven as the FIRST, silently — a verdict about the wrong artifact with
 *     no error anywhere. Distinct URLs are distinct module records in Node's
 *     ESM loader; nothing about the file itself changes. It also means this
 *     file never shares an instance with `wasm-loader.ts` if both are loaded in
 *     one process.
 *
 *   - The options object is built HERE, in the glue's own realm. `initSync`
 *     sniffs it with `Object.getPrototypeOf(module) === Object.prototype` and,
 *     when that fails across a realm boundary, does not throw: it warns and
 *     takes a deprecated branch (see the note in wasm-loader.ts). Same realm,
 *     no worker, no structuredClone.
 *
 * Node prints `MODULE_TYPELESS_PACKAGE_JSON` when it loads that glue, because
 * `packages/stark-prover/package.json` declares no `"type"` and the glue is
 * ESM. That warning is about the package's manifest, not about the blob, and
 * it is suppressed for the duration of the import — narrowly, by code — so a
 * CI log does not carry a warning nobody can act on from here. Whether the
 * package should declare `"type": "module"` is a packaging decision for the
 * tsup build, and it is not taken in a gate.
 *
 * The verdict is still reached the only way it ever was: the blob is DRIVEN and
 * what it emits is compared. Nothing here reads a string out of the blob, out
 * of the glue or out of any Rust source.
 *
 * # What this DOES NOT prove
 *
 * That the blob is the current generation on every input. This is a SAMPLE:
 * eight fixed witnesses. A blob rigged to recognise those eight and replay
 * canned proof bytes for them, while proving something else for everything
 * else, would classify clean here. That is not a four-byte edit — it means
 * carrying a second prover, or ~600 KB of canned proofs, inside an artifact
 * whose size is pinned in the record and whose twins are hashed — but it is not
 * impossible, and this file does not claim otherwise. And on the five masked
 * rows the sample is weaker still: see the [MASK] section for exactly what a
 * length can and cannot see.
 *
 * # Cost
 *
 * MEASURED 2026-09-02 on this box, through the glue, all eight circuits, with
 * other work running: ~29 s wall (C0 1.3 s, C1 4.5 s, C2 4.9 s, C3 1.6 s,
 * C4 0.8 s, C5 8.1 s, C6 2.2 s, C7 5.6 s). Proving time is high-variance on
 * this machine — a factor of 5 has been measured on an identical witness — so
 * read that as a shape, not a budget. There is NO cache, deliberately. A cache
 * is a place to keep a verdict that was not measured on this run, and every
 * cheap key for one (the record, a sidecar file, a marker in the blob) is
 * editable by exactly the person this gate exists to stop. Half a minute, in a
 * script that already waits on a devnet RPC round trip, is the cheaper thing to
 * defend.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO, GLUE } from './wasm-artifacts.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** `pathElements` / `pathIndices` are passed as one comma-separated string. */
function csv(n, f) {
  return Array.from({ length: n }, (_, i) => String(f(i))).join(',');
}

// ---------------------------------------------------------------------------
// The fixtures. Witnesses, digests and lengths are the SAME ones already pinned,
// in two languages, by the files named in CORROBORATING_PINS and on each masked
// row's `lengthPinnedIn` below.
// ---------------------------------------------------------------------------

/**
 * The files that pin the same numbers from the OTHER side of the language
 * boundary. Every digest row's `b2` must appear in BOTH of the first two; every
 * masked row's `bytes` must appear in every file its `lengthPinnedIn` names.
 *
 * This is what stops the table below from being the next single point of
 * failure. `b1` and `preB1` are only useful to an attacker if he can swap them,
 * and swapping them here makes the digests vanish from a Rust integration test
 * and a vitest suite that are both run against the real prover.
 *
 * Unreadable is a FAILURE, never a skip.
 */
const PIN_WIRE_FORMAT = 'packages/stark-prover/src/wireFormat.test.ts';
const PIN_DEEP_BINDING = 'programs/p01_stark_verifier/tests/b1_deep_binding.rs';
const PIN_CROSS_CIRCUIT = 'programs/p01_stark_verifier/tests/cross_circuit_confusion.rs';

const CORROBORATING_PINS = [PIN_WIRE_FORMAT, PIN_DEEP_BINDING];

/** Where a masked circuit's length is pinned. C7 has no row in b1_deep_binding.rs. */
const LENGTH_PINS = [PIN_WIRE_FORMAT, PIN_DEEP_BINDING, PIN_CROSS_CIRCUIT];
const LENGTH_PINS_C7 = [PIN_WIRE_FORMAT, PIN_CROSS_CIRCUIT];

/**
 * `b2` — MEASURED from the Rust prover in `stark/` on this tree, pinned
 * independently in `programs/p01_stark_verifier/tests/b1_deep_binding.rs`
 * (FIXTURE_C*_SHA256) and in `packages/stark-prover/src/wireFormat.test.ts`
 * (Pin.sha256). Those two pins are checked against this table at run time, so
 * editing the digests here to make an older blob read as current means editing
 * the same digests in a Rust test and a vitest suite that both still run
 * against the real artifacts.
 *
 * `b1` — the same witnesses, MEASURED against the pre-B2 (post-B1) prover. Kept,
 * not replaced: the whole value of this table is that a blob matching NO column
 * is refused, and deleting a known generation shrinks the set of things that can
 * be named instead of guessed at.
 *
 * `preB1` — MEASURED 2026-07-31 by driving the last pre-B1 blob in git history,
 * 5fe610c90ff1fe15eb96abbbef3ca881b47923b68232335fda0df5546babd114 (194,540 B,
 * commit 4b375d7c), through this exact code path.
 *
 * `bytes` is the serialized proof length under the CURRENT generation. On a
 * digest row it is an observation for the failure report. On a masked row it IS
 * the pin — see the [MASK] section. `bytesPreB2` is the length the two older
 * generations share — recorded so a failure report can show that length never
 * separated THOSE two, and that it separates them from B2 only by accident of
 * the field widths.
 *
 * `masked: true` marks a row whose prover draws a fresh CSPRNG mask per proof.
 * Such a row carries NO `b2` digest and `fixtureTableProblem` refuses one: a
 * digest fixture for a masked circuit can only be made to pass by removing the
 * masking. Older, deterministic columns (`b1`, `preB1`) may stay on a masked row
 * where they were measured, so an old blob's row is still NAMED in the table
 * rather than merely refused, and so the stale-pin check below still sees them.
 */
/**
 * ⛔ THE `b2` COLUMN WAS RE-SYNCED 2026-08-25 AND THE OLD VALUES WERE NOT A
 * DIFFERENT GENERATION -- THEY WERE A DIFFERENT BRANCH.
 *
 * This script was recovered from `b7-drop-aligned-checks`, and its seven `b2`
 * digests came with it. They matched neither authority the doc comment above
 * cites: `b1_deep_binding.rs` FIXTURE_C*_SHA256 and `wireFormat.test.ts`
 * Pin.sha256 agree with each other on all seven, and disagreed with this table
 * on all seven. The blob on disk produces the values those two pin.
 *
 * 🧠 SAME TRAP, SECOND FILE. `wireFormat.test.ts` was recovered from the same
 * branch on the same day and went red 9 of 12 for exactly this reason. Both
 * times the reflex is to suspect the artifact; both times the artifact was
 * right and the recovered pins were stale. When a recovered pin disagrees with
 * a pin that is still being generated, the recovered one is the suspect.
 */
const FIXTURES = [
  {
    label: 'C0 subscriber_ownership',
    bytes: 47_641,
    bytesPreB2: 45_001,
    b2: '157f45be56f966afeaa0bbb43255e17e16e0de07a2817429c7d554923b30930e',
    b1: 'e4aad1058b8cdb5aa7fd488e0e7dce29820566d934e8b9cf56ef2e09a397efa7',
    preB1: 'baf01d179f166d8f38729ac4e6dc1a766e089ba1e98665dea4b981fafd488986',
    entry: 'generate_stark_proof',
    drive: () => [42n],
  },
  {
    label: 'C1 pool_commitment',
    masked: true,
    // [C1-N256 2026-08-29] 68,881 -> 80,577 (n 128 -> 256) then [ZK-LIFT
    // 2026-08-31] -> 94,897 with the lift column. The same witness
    // wireFormat.test.ts drives. The pre-mask digest that used to sit here was
    // retired with the mask on 2026-08-29, along with C3 and C6.
    bytes: 94_897,
    entry: 'generate_pool_commitment_stark_proof',
    drive: () => [42n, 17n, 7n, 11n],
    lengthPinnedIn: LENGTH_PINS,
  },
  {
    label: 'C2 balance_proof',
    bytes: 69_761,
    bytesPreB2: 66_681,
    // [BIND-C2C4 2026-08-03] MOVED by the C2 boundary fold, and the blob was
    // reshipped in the SAME commit, so this column still describes the artifact on
    // disk — which is the only thing that makes it a measurement rather than a wish.
    // MEASURED off the freshly built blob and equal, byte for byte, to the digest
    // the Rust prover pins independently at b1_deep_binding.rs FIXTURE_C2_SHA256.
    // Superseded pre-fold B2 digest, recorded so a stale artifact stays legible in a
    // bisect: 6541e57b85419fd87a4227bf08cfc2f151d0179870ba04d5011338843cd51ce8.
    // It is deliberately NOT given a column: a pre-fold blob must refuse to classify,
    // because this tree's verifier rejects every proof it emits.
    b2: 'c3961423c1573f04e4c62ea4b0cf7e15c6146507fa2b015cc7a5f473cfbb8a7c',
    b1: '063d86a18071ae369132c12a69c5af0e3c2efbe82f6340e6d7ec910be80fd49f',
    preB1: '5171c80e65ba6ed63c0b5a58f58b0bad11a060a60445be483f797d4777cc7d33',
    entry: 'generate_balance_stark_proof',
    drive: () => [42n, 1000n, 777n, 999n],
  },
  {
    label: 'C3 merkle_path',
    masked: true,
    // [ZK-LIFT 2026-08-31] 78,877 -> 79,597: the lift column, 22 x 4 + 2 = 90
    // felts. Same witness as wireFormat.test.ts: leaf 777, a 15-deep path.
    bytes: 79_597,
    entry: 'generate_merkle_path_stark_proof',
    drive: () => [777n, csv(15, (i) => 1000 + i), csv(15, (i) => i % 2)],
    lengthPinnedIn: LENGTH_PINS,
  },
  {
    label: 'C4 confidential_balance',
    bytes: 81_457,
    bytesPreB2: 78_377,
    // [BIND-C2C4 2026-08-03] MOVED by the C4 boundary fold, same cause and same
    // reshipped-in-the-same-commit rule as C2 above. MEASURED off the freshly built
    // blob, equal to b1_deep_binding.rs FIXTURE_C4_SHA256. Superseded pre-fold B2
    // digest: f4918f36632e011049366c079489b8f70858113f45831bcd76e0cf630d92929a.
    b2: '6a7f55050d85af39f05a81a3d8bc715d90f63ee62c7bba9d72fb57462f8bc5c0',
    b1: 'f877836723d0711e7190c2fd5c8a5c6d0476f21794d39ffd47a075f57d53e3e7',
    preB1: 'fbb631a3146225798360fcf80defb748664b2848ae0e59c88e6c9ec6342b2818',
    entry: 'generate_confidential_balance_stark_proof',
    drive: () => [42n, 1000n, 111n, 800n, 222n, 200n, 333n, 999n],
  },
  {
    label: 'C5 transfer',
    masked: true,
    // [ZK-MASK 2026-08-30/31] 78,877 -> 89,821: the blinding region is committed.
    // This row was a DIGEST row until then; its last deterministic b2 digest was
    // a9e3805e504ac0468632739d615ac7d90e34843f27442685f8b30efb7723b5ed (78,877 B),
    // recorded here for a bisect and deliberately given NO column — the shipped
    // prover draws a fresh mask and can never emit it again, and a pre-mask blob
    // must refuse to classify. ⛔ Do NOT copy b1_deep_binding.rs FIXTURE_C5_SHA256
    // in here either: `fixture_c5` feeds a FIXED mask and is reproducible; the
    // shipped prover is not, and a copied digest would fail at random rather than
    // fail honestly (wireFormat.test.ts says the same on its C5 row).
    //
    // `b1` and `preB1` stay: those generations were deterministic on C5 and were
    // measured, so an old blob's C5 row is still named in the table.
    bytes: 89_821,
    bytesPreB2: 76_357,
    b1: '78afe9bbd533913771d5c2438e279934114fe4c6db934b67b43c0644376ea125',
    preB1: '373f74ccff5a6a1ff5cbbb284f670e1df66f6909ca5c7eb46d78aa872a5ff574',
    entry: 'generate_transfer_stark_proof',
    drive: () => [13n, 500n, 77n, 400n, 88n, 100n, 150n, 1234n, 555n, 65n, 2222n, 333n, 50n],
    lengthPinnedIn: LENGTH_PINS,
  },
  {
    label: 'C6 merkle_update',
    masked: true,
    // [ZK-LIFT 2026-08-31] 81,757 -> 82,477: the lift column. Same witness as
    // wireFormat.test.ts: leaves 111 -> 222, a 15-deep path.
    bytes: 82_477,
    entry: 'generate_merkle_update_stark_proof',
    drive: () => [111n, 222n, csv(15, (i) => 100 + i * 13), csv(15, (i) => i % 2)],
    lengthPinnedIn: LENGTH_PINS,
  },
  {
    label: 'C7 spend',
    masked: true,
    // Never had a digest. [ZK-LIFT 2026-08-31] 77,965 -> 79,405. The witness is
    // wireFormat.test.ts's: an ELEVEN-deep path (air::spend::CANONICAL_DEPTH), a
    // twelve-deep one is refused by the prover rather than proving the wrong tree,
    // and a refusal here is reported as exactly that, not as a length mismatch.
    bytes: 79_405,
    entry: 'generate_spend_stark_proof',
    drive: () => [
      11n, 22n, 33n, 44n,
      csv(11, (i) => 1000 + i * 7),
      csv(11, (i) => i % 2),
      '111111111,222222222,333333333,444444444',
    ],
    lengthPinnedIn: LENGTH_PINS_C7,
  },
];

/** The rows the table MUST have, by kind. Named so nobody quietly moves one. */
const EXPECTED_DIGEST_ROWS = ['C0', 'C2', 'C4'];
const EXPECTED_MASKED_ROWS = ['C1', 'C3', 'C5', 'C6', 'C7'];

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `94_897`, `94,897` or `94897`, as its own number — not a run inside a longer
 * one. "Longer" means a digit on either side, or a separator that is itself
 * next to a digit (`1_094_897`); a trailing `,` that ends a table entry is not
 * a separator, and the first cut of this regex rejected exactly that and read
 * four real pins as missing. Neither `_` nor `,` is a regex metacharacter.
 */
function pinsLength(text, n) {
  const digits = String(n);
  const grouped = (sep) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return [digits, grouped('_'), grouped(',')].some((form) =>
    new RegExp(`(?<![0-9])(?<![0-9][_,])${form}(?![0-9])(?![_,][0-9])`).test(text),
  );
}

/**
 * Sanity of the table itself, before it is used to judge anything. Returns a
 * `{ title, lines }` failure block, or null.
 *
 * A classifier whose reference table has been emptied, truncated or had its
 * columns collapsed would classify everything as whatever is left, so the table
 * is checked for exactly the shapes that produce a false green: a row missing or
 * moved between kinds, a malformed digest, a circuit whose generations are the
 * same string, a masked row that grew a digest, and a pin the other side of the
 * language boundary no longer carries.
 */
export function fixtureTableProblem() {
  const lines = [];
  // 🚨 EIGHT ROWS, THREE BY DIGEST AND FIVE BY LENGTH, AND WHICH IS WHICH IS
  // PINNED HERE. C1, C3 and C6 joined C7 as MASKED circuits on 2026-08-29 and C5
  // on 2026-08-31: each draws a fresh CSPRNG blinding region per proof and
  // refuses to build without one, so two proofs of the same witness are
  // different bytes by construction.
  //
  // ⛔ A DIGEST FIXTURE FOR THEM CANNOT EXIST. Adding one could only be made to
  // pass by removing the masking, which is the underdetermination the whole
  // privacy argument rests on — the change would look like a fixed test and be
  // a privacy regression. Moving a row the other way (a deterministic circuit
  // demoted to length-only) is how a content check disappears quietly, and it
  // is refused too.
  const id = (f) => f.label.split(' ')[0];
  const digestRows = FIXTURES.filter((f) => f.masked !== true).map(id);
  const maskedRows = FIXTURES.filter((f) => f.masked === true).map(id);
  const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  if (!sameSet(digestRows, EXPECTED_DIGEST_ROWS) || !sameSet(maskedRows, EXPECTED_MASKED_ROWS)) {
    lines.push(
      `  the table drives ${digestRows.join(', ') || 'nothing'} by digest and ${maskedRows.join(', ') || 'nothing'} by ` +
        `length; it must drive exactly ${EXPECTED_DIGEST_ROWS.join(', ')} by digest and ` +
        `${EXPECTED_MASKED_ROWS.join(', ')} by length — every shipping circuit, each by the strongest check its ` +
        'prover allows. See the [MASK] note at the top of prover-behaviour.mjs.',
    );
  }
  for (const f of FIXTURES) {
    if (!Number.isInteger(f.bytes) || f.bytes <= 0) lines.push(`  ${f.label}: no positive proof length`);
    if (typeof f.entry !== 'string' || typeof f.drive !== 'function') lines.push(`  ${f.label}: no entry point or witness`);
    for (const col of ['b1', 'preB1']) {
      if (f[col] !== undefined && !HEX64.test(f[col])) lines.push(`  ${f.label}: ${col} is not 64 hex characters`);
    }
    if (f.masked === true) {
      if (f.b2 !== undefined) {
        lines.push(
          `  ${f.label}: a MASKED circuit carries a current-generation digest. Its prover draws a fresh mask per ` +
            'proof, so this can only pass with the masking removed — a privacy regression dressed as a fixture',
        );
      }
      if (!Array.isArray(f.lengthPinnedIn) || f.lengthPinnedIn.length < 2) {
        lines.push(`  ${f.label}: a masked row's length must be corroborated by at least two other files`);
      }
    } else {
      if (!HEX64.test(f.b2) || !HEX64.test(f.b1) || !HEX64.test(f.preB1)) {
        lines.push(`  ${f.label}: a digest is not 64 hex characters`);
      }
      // Any two generations sharing a digest collapses the verdict silently.
      const gens = new Set([f.b2, f.b1, f.preB1]);
      if (gens.size !== 3) lines.push(`  ${f.label}: two of the three generation digests are the same string`);
    }
  }

  const texts = new Map();
  const readPin = (rel) => {
    if (!texts.has(rel)) {
      try {
        texts.set(rel, readFileSync(resolve(REPO, rel), 'utf8'));
      } catch (e) {
        texts.set(rel, null);
        lines.push(`  cannot read ${rel}: ${e.message}`);
      }
    }
    return texts.get(rel);
  };

  for (const rel of CORROBORATING_PINS) {
    const text = readPin(rel);
    if (text === null) continue;
    const missing = FIXTURES.filter((f) => f.masked !== true && !text.includes(f.b2)).map((f) => f.label);
    if (missing.length > 0) lines.push(`  ${rel} no longer pins the current digest for ${missing.join(', ')}`);
    // A SUPERSEDED digest left behind in a corroborating pin is the half-updated
    // pin set `cross_language_fixture_digests` warns about in its own failure
    // text ("update BOTH ... do not update one of them"). Nothing checked for it.
    // Presence of a current digest cannot: both can be in the file at once, one
    // in the assertion and one in a comment, and the includes() above passes.
    // Neither of these two files has any business carrying a digest from an
    // older generation — this table is the only place those are kept, on purpose.
    const stale = FIXTURES.filter(
      (f) => (f.b1 !== undefined && text.includes(f.b1)) || (f.preB1 !== undefined && text.includes(f.preB1)),
    ).map((f) => f.label);
    if (stale.length > 0) {
      lines.push(
        `  ${rel} still carries a SUPERSEDED digest for ${stale.join(', ')} — a pin set that was ` +
          'updated in one place and not the other',
      );
    }
  }

  // The masked rows' lengths, read back from the files that pin them against the
  // Rust prover. Same rule as the digests: a number that exists only here is a
  // number one edit can move.
  for (const f of FIXTURES) {
    if (f.masked !== true || !Array.isArray(f.lengthPinnedIn)) continue;
    for (const rel of f.lengthPinnedIn) {
      const text = readPin(rel);
      if (text === null) continue;
      if (!pinsLength(text, f.bytes)) {
        lines.push(`  ${rel} no longer pins ${f.bytes.toLocaleString('en-US')} B for ${f.label}`);
      }
    }
  }

  if (lines.length === 0) return null;
  return {
    title: 'the behavioural classifier\'s own reference table is not trustworthy',
    lines: [
      ...lines,
      '',
      'These three digests and five lengths are what decides which generation the shipped prover is. They',
      'are pinned in more than one place on purpose — here, in a Rust integration test and in a vitest',
      'suite, the lengths in a second Rust test as well — so that moving them is not a one-file edit.',
      'Refusing to classify while they disagree.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Driving the blob — THROUGH the generated glue. See the [GLUE] section.
// ---------------------------------------------------------------------------

/** Exports the fixtures need from the INSTANCE. The glue wraps each one. */
const REQUIRED_EXPORTS = ['memory', ...FIXTURES.map((f) => f.entry)];

/** The warning Node prints for the glue's missing `"type"`; see the header. */
const TYPELESS_WARNING = 'MODULE_TYPELESS_PACKAGE_JSON';

let glueImports = 0;

/**
 * Import a FRESH instance of the generated glue from its canonical path.
 *
 * Fresh, because `initSync` is idempotent on module state: the second blob
 * classified through the same instance would be driven as the first. The query
 * string makes a distinct module record; the file on disk is the same one the
 * clients load. The typeless-package warning is silenced only for this import
 * and only for that code — see the header for why it is not fixed here.
 */
async function loadFreshGlue() {
  glueImports += 1;
  const url = `${pathToFileURL(resolve(REPO, GLUE)).href}?p01-classifier=${process.pid}-${glueImports}`;
  const emitWarning = process.emitWarning;
  process.emitWarning = function silencedForTheGlueImport(warning, ...rest) {
    const code =
      (warning !== null && typeof warning === 'object' && warning.code) ||
      (rest[0] !== null && typeof rest[0] === 'object' ? rest[0].code : rest[1]);
    if (code === TYPELESS_WARNING) return undefined;
    return emitWarning.call(process, warning, ...rest);
  };
  try {
    return await import(url);
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Compile `bytes`, instantiate them through the glue's `initSync`, and return
 * the glue — whose exported wrappers do the (ptr,len) marshalling and return
 * the prover's JSON as a string. Throws with a named reason on anything short
 * of a driveable prover; the caller turns that into a fail-closed verdict.
 */
async function instantiate(bytes) {
  const glue = await loadFreshGlue();
  if (typeof glue.initSync !== 'function') {
    throw new Error(`${GLUE} exports no initSync — it is not the wasm-bindgen glue for this blob`);
  }
  let mod;
  try {
    mod = new WebAssembly.Module(bytes);
  } catch (e) {
    throw new Error(`the blob does not compile: ${e.message}`);
  }
  let instanceExports;
  try {
    // Same realm, plain object literal: `initSync` checks
    // `Object.getPrototypeOf(module) === Object.prototype` before it will read
    // `.module`. It returns the raw instance exports.
    instanceExports = glue.initSync({ module: mod });
  } catch (e) {
    throw new Error(
      `the generated glue ${GLUE} cannot link this blob (${WebAssembly.Module.imports(mod).length} imports): ` +
        `${e.message}. The blob and its glue are generated together by wasm-pack; a pair that does not link ` +
        'here does not link in any client either — reship both.',
    );
  }
  const missing = REQUIRED_EXPORTS.filter((n) => instanceExports?.[n] === undefined);
  if (missing.length > 0) throw new Error(`the blob does not export ${missing.join(', ')}`);
  const unwrapped = FIXTURES.map((f) => f.entry).filter((n) => typeof glue[n] !== 'function');
  if (unwrapped.length > 0) throw new Error(`${GLUE} does not wrap ${unwrapped.join(', ')}`);
  return glue;
}

/**
 * Classify a prover blob by what it emits.
 *
 * Returns `{ generation, results, total, problem, ms }`.
 *   generation  'b2'      every circuit matched the current generation — the
 *                         three digest rows by digest, the five masked rows by
 *                         length
 *               'b1'      every circuit matched the B1 column (unreachable on
 *               'pre-b1'  a masked row today, so these name a row in the table
 *                         rather than a whole blob — see [MASK])
 *               null      ANYTHING else, including a mixture, an unknown digest
 *                         or length, a blob that will not compile or link, a
 *                         blob that throws mid-proof and a prover that refuses
 *                         a fixture witness. `null` MUST be treated as a
 *                         failure by the caller; it is never "probably pre-b1".
 *   results     one entry per circuit DRIVEN, in table order. Driving stops at
 *               the first circuit that cannot be proved, so on failure this can
 *               be shorter than `total`; count against `total`, not against
 *               `results.length`.
 *   total       the number of rows in the table.
 *
 * Unanimity is required in both directions on purpose. A blob that is B1 on some
 * circuits and pre-B1 on others is not a generation, and the reading that would
 * ship it is the one that calls it pre-B1.
 */
export async function classifyProverBehaviour(bytes) {
  const t0 = Date.now();
  const total = FIXTURES.length;
  const verdict = (generation, results, problem) => ({ generation, results, total, ms: Date.now() - t0, problem });

  let glue;
  try {
    glue = await instantiate(bytes);
  } catch (e) {
    return verdict(null, [], `the blob could not be instantiated and driven: ${e.message}`);
  }

  const results = [];
  for (const f of FIXTURES) {
    let json;
    try {
      json = JSON.parse(glue[f.entry](...f.drive()));
    } catch (e) {
      return verdict(null, results, `${f.label} could not be proved: ${e.message}`);
    }
    if (typeof json?.error === 'string') {
      return verdict(null, results, `${f.label}: the prover refused the fixture witness: ${json.error}`);
    }
    if (typeof json?.proof_hex !== 'string' || !/^[0-9a-f]*$/.test(json.proof_hex)) {
      return verdict(null, results, `${f.label} returned no usable proof_hex`);
    }
    const proof = Buffer.from(json.proof_hex, 'hex');
    if (typeof json.proof_size === 'number' && json.proof_size !== proof.length) {
      return verdict(null, results, `${f.label} reports proof_size ${json.proof_size} but emitted ${proof.length} bytes`);
    }
    const digest = sha256(proof);
    let gen = 'unknown';
    let matchedBy = null;
    if (digest === f.b2) [gen, matchedBy] = ['b2', 'digest'];
    else if (digest === f.b1) [gen, matchedBy] = ['b1', 'digest'];
    else if (digest === f.preB1) [gen, matchedBy] = ['pre-b1', 'digest'];
    else if (f.masked === true && proof.length === f.bytes) [gen, matchedBy] = ['b2', 'length'];
    results.push({
      label: f.label,
      masked: f.masked === true,
      bytes: proof.length,
      expectedBytes: f.bytes,
      digest,
      verdict: gen,
      matchedBy,
      b2: f.b2,
      b1: f.b1,
      preB1: f.preB1,
    });
  }

  const verdicts = new Set(results.map((r) => r.verdict));
  const generation = verdicts.size === 1 && !verdicts.has('unknown') ? results[0].verdict : null;
  return verdict(
    generation,
    results,
    generation === null
      ? verdicts.has('unknown')
        ? 'at least one circuit emitted a proof this classifier has never measured'
        : 'the circuits disagree about which generation this prover is'
      : null,
  );
}

/** Human-readable per-circuit table for a failure report. Says HOW each row was judged. */
export function describeBehaviour(behaviour) {
  return behaviour.results.map((r) => {
    const head = `  ${r.label.padEnd(24)} ${String(r.bytes).padStart(6)} B  ${r.digest}  `;
    if (r.verdict === 'unknown') {
      return r.masked
        ? `${head}MATCHES NO KNOWN GENERATION (masked: judged by length; the current generation emits ` +
            `${r.expectedBytes.toLocaleString('en-US')} B)`
        : `${head}MATCHES NO KNOWN GENERATION`;
    }
    return `${head}${r.verdict}  ${
      r.matchedBy === 'length' ? '(masked: by length — the digest is fresh on every proof)' : '(by digest)'
    }`;
  });
}

export { FIXTURES as PROOF_FORMAT_FIXTURES };
