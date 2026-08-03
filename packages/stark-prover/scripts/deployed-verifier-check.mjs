#!/usr/bin/env node
/**
 * deployed-verifier-check.mjs — refuse to ship a client prover the deployed
 * on-chain verifier will reject.
 *
 *   node packages/stark-prover/scripts/deployed-verifier-check.mjs                  # offline gate (blocking)
 *   node packages/stark-prover/scripts/deployed-verifier-check.mjs --verify-onchain # + prove the record against the chain
 *   node packages/stark-prover/scripts/deployed-verifier-check.mjs --measure        # print a fresh `deployed` block
 *
 * `--cluster <devnet|mainnet-beta>` names WHICH deployment this run is about.
 * It defaults to devnet and it is the CALLER's to choose, never the record's.
 *
 * # Why this exists
 *
 * The proof wire format is agreed between `packages/stark-prover/wasm/` and the
 * on-chain verifier, and NOTHING on the wire says which generation produced a
 * proof. A client one generation ahead of the deployed program still builds,
 * still serialises, still uploads all ~78 KB in chunks, and then fails on the
 * final instruction with `FriFoldCheckFailed`. No parse error, no length
 * mismatch, no early exit. It looks like an unexplained transaction failure at
 * the end of a slow upload.
 *
 * Every other WASM gate in this package compares the blob against THIS TREE:
 *   stark-wasm-twins.mjs --check   five artifacts carry the same bytes
 *   src/wireFormat.test.ts         those bytes match the Rust prover in stark/
 *   src/wasmProbeScan.test.ts      no fails-closed probe code survived
 * All three are green when the tree is one generation ahead of the chain,
 * because all three look at the same side of the skew. This one looks at the
 * other side.
 *
 * # What it proves and what it does not
 *
 * PROVES: the checked-in blob (and every inlined twin) is the exact artifact
 * `deployed-verifier.json` records as compatible with the deployed program, and
 * that its proof-format generation — MEASURED by generating seven proofs with it
 * and hashing them, not read off it — equals the generation that record
 * attributes to the deployment.
 *
 * DOES NOT PROVE: that a proof from this blob verifies on chain. Only a real
 * submission proves that. The record's `accepts_client_blob_sha256` is the place
 * that fact gets written down once someone has done it.
 *
 * # What `--verify-onchain` establishes, exactly
 *
 * It refetches the programdata account and re-derives three things from the
 * bytes it gets back: `deployed.elf_sha256`, `deployed.last_deployed_slot` and
 * `deployed.proof_format_generation`. Those three fields cannot be edited into
 * agreement, because the chain is asked what they are.
 *
 * It can only do that because the record does NOT get to say where to look. See
 * the next section: the caller names the cluster, the record is only checked
 * against it.
 *
 * It does NOT establish `deployed.accepts_client_blob_sha256`. Nothing on chain
 * records which client blob a deployment accepts. That field is a human
 * attestation that someone submitted a proof and watched it land, and this
 * script cannot check it against anything. It is the one field in the `deployed`
 * block that is believed rather than verified.
 *
 * # Which chain gets asked, and who chooses
 *
 * The CALLER chooses, with `--cluster`, defaulting to devnet. The label selects
 * an endpoint from `CLUSTERS` below and a program id from Anchor.toml. The
 * record's own `cluster` and `program_id` are then CHECKED against that choice,
 * and either disagreeing is a hard failure. So the record is data about a
 * deployment, not an instruction about where to look.
 *
 * A gate that decides whether a client may SHIP accepts devnet and mainnet-beta
 * and nothing else. `localnet` is refused outright unless the caller both asks
 * for it and sets P01_ALLOW_LOCAL_VERIFIER_GATE=1, and that path prints its
 * result as NOT A SHIPPING VERDICT and is refused again if CI is set. Nothing in
 * this repo sets that variable: not .github/workflows/ci.yml, not the apps/web,
 * apps/extension or apps/mobile build scripts, not either prepublishOnly.
 *
 * That is not hypothetical tidiness. Until this revision the cluster came from
 * the record and `localnet` was one of the labels. MEASURED 2026-07-30 against
 * the previous revision of this file: setting `cluster` to `localnet`,
 * `program_id` to the id Anchor.toml [programs.localnet] genuinely carries (so
 * the cross-check passes), `proof_format_generation` to `b1` and
 * `accepts_client_blob_sha256` to the blob's own hash, plus a fabricated elf hash
 * and slot; then a throwaway JSON-RPC server on 127.0.0.1:8899 answering
 * getAccountInfo with 149 bytes carrying the two B1 marker literals and the four
 * controls. It printed "PASS — the shipped prover matches the deployment, and the
 * chain was asked and agreed", exit 0. Killing the listener and rerunning the
 * same record exited 1, so the pass came entirely from the listener.
 *
 * NOT measured, because it is strictly easier and needs no forgery at all: a
 * `solana-test-validator` with the current verifier deployed to it answers every
 * one of those checks honestly, and the gate would then be green forever while
 * devnet stayed pre-B1 and every client proof died with FriFoldCheckFailed.
 * Nobody ran it; the forged run already establishes that the gate believed
 * whatever answered 127.0.0.1:8899.
 *
 * CI was safe only by accident, because nothing listens on 8899 on a fresh
 * runner. The other six call sites are developer and release machines, where a
 * local validator is normal.
 *
 * An earlier round the same day removed `deployed.rpc_url`, which is why a record
 * carrying one is still rejected below. MEASURED then: editing generation to `b1`,
 * `accepts_client_blob_sha256` to the blob's own hash and `rpc_url` to
 * `https://api.devnet.solana.invalid` made `--verify-onchain` print
 * "on-chain SKIPPED" and then "PASS", exit 0, with the chain never contacted.
 * Hence also: an unresolvable cluster label is rejected, and a cluster that
 * cannot be reached is a hard failure whenever nothing else was going to fail
 * the build.
 *
 * # Generation detection — the CLIENT side is measured, not read
 *
 * The client blob's generation comes from what it DOES: seven fixed witnesses in,
 * seven serialized proofs out, sha256 each, and every one must match the same
 * column of the fixture table in scripts/prover-behaviour.mjs. B1 is
 * length-preserving on all seven circuits, so length alone cannot separate the
 * generations (MEASURED: both blobs emit 45,001 / 65,801 / 66,681 / 75,637 /
 * 78,377 / 76,357 / 78,517 bytes) and the CONTENT digests are the discriminator.
 * A mixture, or a digest in neither column, refuses to classify and fails.
 *
 * This replaced a scan for panic-message literals, which was cheated four rounds
 * running and was cheatable by accident. MEASURED 2026-07-31 against the previous
 * revision: rewriting FOUR BYTES of panic text inside the blob (`B1 ` -> `Bx `,
 * `DEEP ` -> `DEEQ `, `B1 depends on` -> `Bx depends on`), applying the same three
 * renames to stark/src/compact.rs, rewording ONE msg! line in
 * programs/p01_stark_verifier/src/verify.rs — that single line carries BOTH
 * literals the deployed-ELF scan discriminates on, so the "five strings" this was
 * costed at was really three plus one — then reshipping the four twins with
 * stark-wasm-twins.mjs --write and pointing the record at the doctored hash,
 * printed "PASS — the shipped prover matches the devnet deployment, and the chain
 * was asked and agreed", exit 0, against the real pre-B1 devnet deployment. Same
 * 211,370 bytes, WebAssembly.validate still true, every control still present,
 * stark-wasm-twins.mjs --check still green. Every proof that client produced
 * would still have died with FriFoldCheckFailed.
 *
 * MEASURED against THIS revision, the same doctored blob still emits all seven B1
 * digests, so it classifies b1 and the interlock fires. Renaming every literal in
 * every Rust file and in the artifact does not move the verdict, because none of
 * them is read to reach it.
 *
 * What the digests do NOT prove is that the blob is B1 on every input; they are a
 * seven-witness sample. See the "What this DOES NOT prove" section of
 * scripts/prover-behaviour.mjs.
 *
 * The DEPLOYED side is still classified by scanning the ELF for msg! literals,
 * because nothing here can run a BPF program and a proof cannot be submitted to
 * one without funding and a chunked upload. The markers are hardcoded in this
 * file, not read from the record, so no edit to the record weakens that scan —
 * but ELF_B1_MARKERS is now the softest thing left in this gate, and that is
 * stated rather than implied: pointing those two literals at a string the pre-B1
 * deployment also carries would make the chain read b1. KNOWN_ELF_GENERATIONS
 * bounds that. It pins the sha256 of the two live deployments as measured by
 * hand, and a scan that reads one of them as a different generation is a
 * contradiction and a hard failure — offline as well as on chain, since the
 * record names the same hash. What is left after that is an edit to the
 * guardrail itself, deleting a measured constant, which is a louder diff than a
 * panic-message rename in a refactor. It is not the same as impossible.
 *
 * # The blob is ALSO corroborated against the source it is built from
 *
 * The panic-literal scan is kept, demoted to corroboration. BLOB_ALL_MARKERS
 * (BLOB_MARKERS_B1 + BLOB_MARKERS_B2) are scanned in the blob and in
 * `stark/src/compact.rs`, and the two sets must be EQUAL. That still detects a
 * blob that was not built from this tree, and a string-stripped artifact,
 * neither of which the digests speak to. And a blob that PROVES one generation
 * while its strings CLAIM another is now its own named failure — that
 * combination is the four-byte edit above and has no innocent explanation.
 *
 * The two lists were ONE list until 2026-08-02, and `classify` could only say
 * `b1` or `pre-b1`, so a B2 blob carrying both `[B2] …-SEGMENTED` asserts was
 * reported as claiming b1 while proving b2 — a reader that could not count past
 * one, dressed up as an accusation against the artifact. `classifyBlob` is a
 * three-rung ladder now. The deployed-ELF side cannot be a three-rung ladder,
 * because the verifier carries no B2-distinguishing literal at all; `classifyElf`
 * therefore answers `'b1+'` — "B1 or newer, and this method cannot say which" —
 * rather than guessing `b1`, and that label is compared with
 * `generationsAreCompatible`. See the notes on ELF_B1_MARKERS and ELF_MARKERS_B2
 * for the reason and for what it leaves open.
 *
 * # An independent audit of this file, 2026-07-31, and what it found
 *
 * A fourth attempt to cheat this gate found three things. All three are now
 * closed.
 *
 *   1. THE TWINS WERE NOT REALLY CHECKED. Both this gate and stark-wasm-twins.mjs
 *      pulled the base64 with the FIRST long-base64-run regex, which need not be
 *      the string the client imports. MEASURED: a decoy const carrying the
 *      canonical bytes above `export const STARK_WASM_BASE64 = '<other blob>'` in
 *      apps/web's twin printed "PASS — 4 twins" and "ok apps/web/…" from the two
 *      gates while apps/web shipped a prover neither had hashed. Both now read the
 *      export and refuse a module carrying more than one long literal.
 *
 *   2. THE GATE VERIFIED A PROGRAM ONE SHIPPED CODE PATH DOES NOT CALL. The SDK
 *      cross-check read one key. packages/privacy-sdk/src/modules/instantUnshield.ts
 *      pins a SECOND verifier id, and it is a different live devnet deployment.
 *      See verifierConstantsInPrivacySdk for the measurement; every such constant
 *      is swept now.
 *
 *   3. THE TWO-CRATE RENAME IS CLOSED, behaviourally. It was open and measured:
 *      renaming the B1 literals in stark/src/compact.rs and in
 *      programs/p01_stark_verifier/src/{verify,lib}.rs, with four bytes edited in
 *      the blob, printed the full PASS at exit 0 with devnet genuinely pre-B1.
 *      MEASURED 2026-07-31 against this revision, the identical cheat now exits 1
 *      with "the blob PROVES one generation and its panic strings CLAIM another"
 *      and the FriFoldCheckFailed interlock underneath it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';

import { REPO, CANONICAL, TWIN_PATHS, extractBase64 } from './wasm-artifacts.mjs';
import { classifyProverBehaviour, describeBehaviour, fixtureTableProblem } from './prover-behaviour.mjs';

const RECORD_DEFAULT = 'packages/stark-prover/deployed-verifier.json';

// ---------------------------------------------------------------------------
// Generation markers. Hardcoded on purpose — see the header.
// ---------------------------------------------------------------------------

/**
 * Literals B1 and B2 added to the PROVER (stark/src/compact.rs).
 *
 * These NO LONGER decide the blob's generation — scripts/prover-behaviour.mjs
 * does, by driving it. They are kept because they still detect two things the
 * proof digests are silent about: an artifact whose strings were stripped, and
 * an artifact that was not built from the source in this tree. And a blob whose
 * strings disagree with its proofs is reported as exactly that.
 *
 * [B2] `'break the committed-vector/ood_quotient agreement B1 depends on'` is
 * gone from the source and therefore from the blob. It was the message on the
 * `q_poly.len() <= lde_size` assert in the six quotient builders, and B2 moved
 * that guarantee: each segment is asserted to fit in `trace_length <= lde_size`
 * coefficients and its committed column is built by evaluating that very vector,
 * so the divergence the message described cannot occur by construction. Replaced
 * here, in the same commit, by the two `segment_quotient_poly` asserts — which
 * are the strings that now carry the same job.
 */
/**
 * [B2 FIX] The eras are now SEPARATE lists, because lumping them made the string
 * scan unable to name the generation the tree is actually on.
 *
 * These four literals were one array called `BLOB_B1_MARKERS`, and `classify`
 * returned `'b1'` if ANY of them hit. Two of the four are `[B2]`-only strings,
 * added when B2 landed, so on this tree the scan read `'b1'` while the blob
 * PROVES `'b2'` — and the check named "the blob PROVES one generation and its
 * panic strings CLAIM another" fired on a correctly reshipped artifact. MEASURED
 * 2026-08-02: `node scripts/deployed-verifier-check.mjs` printed that block with
 * source and blob markers in perfect agreement, and its remedy ("reship the blob
 * from this tree") could never have cleared it. A guardrail that is permanently
 * red for a reason the reader cannot act on is a guardrail that gets deleted.
 *
 * Split into eras, the scan is a genuine three-way discriminator again: a pre-B1
 * blob carries neither list, a B1 blob carries the first and not the second, a B2
 * blob carries both.
 */
const BLOB_MARKERS_B1 = [
  'B1 TERMINAL DEGREE BOUND VIOLATED',
  'DEEP denominator vanishes at LDE position ',
];

/**
 * Literals B2 added to the PROVER (stark/src/compact.rs), on top of B1's — the
 * two `segment_quotient_poly` asserts that check the split in both directions.
 * They exist only in a tree where the quotient is segmented at all, which is
 * what B2 is.
 *
 * [MERGE 2026-08-03] Two lots of work fixed this same defect independently and
 * this file carries ONE of the two fixes, deliberately, not a blend. The other
 * lot's `classifyBlobStrings` called a blob `b2` on ANY B2 marker; the version
 * kept here requires the WHOLE era (see `classifyBlob`), because half the B2
 * asserts present is an edited artifact rather than a generation, and
 * `blobSourceSkew` reports that case on its own. Neither reading can be silently
 * greener than the other today — the shipped blob carries both markers — and the
 * partial-era cases were checked to stay red under both.
 */
const BLOB_MARKERS_B2 = [
  '[B2] UNDER-SEGMENTED: the quotient has ',
  '[B2] OVER-SEGMENTED: the quotient has ',
];

/** Every marker, either era. Used where the question is "built from this tree?". */
const BLOB_ALL_MARKERS = [...BLOB_MARKERS_B1, ...BLOB_MARKERS_B2];

/**
 * Literals present in EVERY generation of the prover blob. If these are gone the
 * artifact's strings were stripped (wasm-opt, a truncated file, the wrong file)
 * and "no B1 markers" means nothing.
 */
const BLOB_CONTROLS = [
  'rlc-c1\0\0',
  'rlc-c2\0\0',
  'rlc-c3\0\0',
  'rlc-c5\0\0',
  'bnd-c5\0\0',
  'bnd-c6\0\0',
  'proof_hex',
];

/**
 * Literals B1 added to the VERIFIER (programs/p01_stark_verifier/src/verify.rs).
 *
 * ELF_MARKERS_B2 IS EMPTY AND THAT IS A KNOWN LIMIT OF THIS GATE, recorded here
 * rather than left to be discovered. B2 (quotient segmentation) changed the
 * verifier's arithmetic and its Fiat-Shamir absorption but added NOT ONE new
 * `msg!` literal to verify.rs — MEASURED 2026-08-02 and re-counted 2026-08-03,
 * the 11 `msg!` sites in that file are all pre-B1 step markers plus B1's degree
 * bound, and every `[B2]` annotation is a `//` comment, which never reaches the
 * ELF. Adding one would move all 13 CU pins, so it is not a free fix.
 *
 * The consequence, stated plainly: the deployed side of this gate can observe
 * `pre-b1` or `b1+` and nothing else, and `b1+` is NOT a synonym for `b1` — it
 * means "B1 or newer, and this method cannot say which". Today the deployment is
 * pre-b1 and the client is b2, so the interlock is red for the right reason.
 * After a CORRECT B2 deploy this scan reads `b1+`, which is compatible with a
 * record saying `b2` but does not confirm it, and the run says so out loud on the
 * PASS path. Do not "solve" a red here by widening ELF_B1_MARKERS. The two things
 * that would make this exact are a B2-only literal in the verifier listed in
 * ELF_MARKERS_B2, or a hand measurement in KNOWN_ELF_GENERATIONS — which is
 * exactly what that table is for.
 */
const ELF_B1_MARKERS = ['[verify] final poly coeff ', ' non-zero, bound is '];

/**
 * Literals B2 added to the VERIFIER. THERE ARE NONE, and that is a finding, not
 * an omission in this file.
 *
 * MEASURED 2026-08-02 across `programs/p01_stark_verifier/src/`: B2 added the
 * `quotient_segments` field, the segment recombination and the per-segment gamma
 * powers, and not one runtime string. Every `msg!` in `verify.rs` predates B2
 * (`grep -n 'msg!(' verify.rs` -> 11 sites, all step markers and B1's degree
 * bound); no `#[error_code]` variant mentions segmentation; no new `b"..."`
 * domain tag was added. So the deployed-ELF scan CANNOT SEPARATE B1 FROM B2.
 *
 * That is the sharp end of it, because B2 is NOT length-preserving — a B1
 * verifier rejects every B2 proof at the parser — so B1 -> B2 is exactly the
 * boundary that breaks every proof loudly, and it is the one boundary this scan
 * is blind to. `classifyElf` therefore returns the AMBIGUOUS label `'b1+'` rather
 * than guessing `'b1'`, and `generationsAreCompatible` treats `'b1+'` as
 * satisfying a record that says `b1` OR `b2` and nothing else. The interlock
 * still compares the record's exact label against the behaviourally measured
 * client generation, so a B2 client against a record saying `b1` still fails.
 *
 * WHAT THAT LEAVES OPEN, stated rather than implied away: with the record saying
 * `b2`, a deployment that is really B1 passes the on-chain leg, because nothing
 * this script can do distinguishes them. `accepts_client_blob_sha256` and
 * KNOWN_ELF_GENERATIONS are the only two things that would catch it, and both are
 * human attestations. The real fix is a BEHAVIOURAL classifier for the deployed
 * side — `programs/p01_stark_verifier/tests/cu_budget.rs` already loads a built
 * `.so` into litesvm and executes it, so running a fixture proof against the
 * programdata bytes fetched from the chain is a known-possible thing in this
 * repo, just not from a build script. Until then: add a B2-only literal to the
 * verifier and list it here, or do the litesvm classifier. Do not paper over it
 * by pretending `'b1+'` means `b1`.
 */
const ELF_MARKERS_B2 = [];

/** msg! literals that predate B1 and are still in the source today. */
const ELF_CONTROLS = [
  '[verify] step1 ok',
  '[verify] step3.5 ok',
  '[verify] OOD z mismatch: got ',
  'STARK proof verified for circuit ',
];

/**
 * ELF sha256 -> the generation that exact deployment was measured to be.
 *
 * The client side is classified by RUNNING the prover, so no rename moves it.
 * The deployed side cannot be: nothing in a build script can execute a BPF
 * program, and putting a real proof in front of one needs funding and a ~78 KB
 * chunked upload. So the chain is still classified by scanning its ELF for msg!
 * literals, and that leaves ELF_B1_MARKERS as the softest thing in this gate:
 * point those two literals at a string the pre-B1 deployment also carries and
 * the chain reads b1.
 *
 * This table is what stops that from being enough on its own. Every entry is a
 * deployment somebody read off devnet and classified by hand; if the chain hands
 * back those exact bytes it is still that deployment, whatever the scan says. A
 * marker table edited to make a pinned pre-B1 ELF read as b1 now CONTRADICTS the
 * pin, and a contradiction is a hard failure. The cost of the cheapest false
 * green on this side therefore goes from "reword two literals" to "reword two
 * literals AND delete a measured constant that names the program, the slot and
 * the byte count it was taken from".
 *
 * Both entries MEASURED 2026-07-31 off https://api.devnet.solana.com, by reading
 * the programdata account and scanning the payload: neither carries either B1
 * marker, both carry all four ELF_CONTROLS. They are the two live
 * p01_stark_verifier deployments the clients can address — see
 * verifierConstantsInPrivacySdk for why there are two.
 *
 * An entry here is NOT a claim about any other deployment. A redeploy changes
 * the hash, the new hash is not in this table, and the scan is then the only
 * evidence again — which is the honest state until someone measures the new one
 * and adds it. This table can only ever add a contradiction, never a pass.
 */
const KNOWN_ELF_GENERATIONS = {
  c359ab535f42d2d8a91a2b0228521b17d26c0bde32dc526538d92987c7019f5c: {
    generation: 'pre-b1',
    what: 'devnet EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z, programdata 35XxrnBYPTWjir8Zc3BdS9LQA9Fjh6JB73iM3WaxKr57, slot 456289287, 780,249 B',
  },
  c1a26c1772a27f46d50570127bfa0b18ea3f46594ded4b80d9e40e3f87c03755: {
    generation: 'pre-b1',
    what: 'devnet DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs, programdata Dmndh5d1SMr54vjGMHVcvsfC1Dy3LXHfAhn58RM1eWJi, slot 469197514, 817,617 B',
  },
};

/**
 * A generation attributed to a specific ELF, checked against what that ELF was
 * measured to be. Returns a failure block, or null when there is nothing pinned
 * about that hash or the two agree.
 *
 * `where` says whose claim is being checked, because the two cases read very
 * differently: the record claiming it is prose that can be edited, the marker
 * scan claiming it means the discriminator itself has gone stale or been
 * reworded.
 */
function knownElfContradiction(elfSha, claimedGeneration, where) {
  const known = KNOWN_ELF_GENERATIONS[elfSha];
  if (known === undefined) return null;
  if (claimedGeneration === null || claimedGeneration === undefined) return null;
  // `generationsAreCompatible`, not `===`, because the ELF scan's `'b1+'` is an
  // inexact observation. It is still a CONTRADICTION against a hand-measured
  // `pre-b1` — `'b1+'` excludes pre-B1 — so this loses no strength on the one
  // pin that exists today.
  if (generationsAreCompatible(claimedGeneration, known.generation)) return null;
  return {
    title: `${where} contradicts a deployment that was measured by hand`,
    lines: [
      `  elf sha256          ${elfSha}`,
      `  those bytes are     ${known.what}`,
      `  measured by hand    ${known.generation}`,
      `  ${`${where} says`.padEnd(18)}${claimedGeneration}`,
      '',
      'Those exact bytes were read off the chain and classified on 2026-07-31, and they have not changed',
      'since — the hash is how we know. A redeploy would produce a different hash and this check would',
      'have nothing to say. So this is not a stale pin disagreeing with a fresh reading, it is two',
      'readings of the SAME bytes disagreeing, and one of them was edited.',
      '',
      'If the marker scan is what changed, that is the failure: ELF_B1_MARKERS is the only thing telling',
      'this gate what generation a deployment is, and pointing it at a literal the pre-B1 program also',
      'carries turns every pre-B1 deployment into a b1 one. If a deployment genuinely changed, redeploy',
      'and re-measure — do not reconcile these by editing either side.',
    ],
  };
}

/**
 * The Rust sources every literal above was lifted from. They are read so the
 * scan can be corroborated instead of believed:
 *
 *   BLOB_MARKER_SOURCES  the prover the blob is built from. The markers found
 *                        here and the markers found in the blob MUST be the same
 *                        set. A marker the source has and the blob does not is
 *                        the doctored-blob false green described in the header,
 *                        and is refused rather than read as "pre-B1".
 *
 *   ELF_MARKER_SOURCES   the verifier the deployed program is built from. The
 *                        deployed bytes are ALLOWED to lag this source — that
 *                        skew is the whole subject of this gate — so nothing is
 *                        compared against the chain here. What is required is
 *                        that the literals this scan discriminates on still
 *                        EXIST in the source, because once they are reworded
 *                        "the chain has no B1 markers" stops meaning "the chain
 *                        is pre-B1" and starts meaning "this script is stale".
 */
const BLOB_MARKER_SOURCES = ['stark/src/compact.rs'];
const ELF_MARKER_SOURCES = [
  'programs/p01_stark_verifier/src/verify.rs',
  'programs/p01_stark_verifier/src/lib.rs',
];

/** Concatenate a list of repo-relative source files. Returns null if any is unreadable. */
function readSources(rels) {
  const parts = [];
  for (const rel of rels) {
    try {
      parts.push(readFileSync(resolve(REPO, rel), 'utf8'));
    } catch (e) {
      return { text: null, unreadable: rel, message: e.message };
    }
  }
  return { text: parts.join('\n'), unreadable: null, message: null };
}

/**
 * Does `needle` appear in `text` somewhere that will actually reach the ELF?
 *
 * MEASURED 2026-08-03, by mutation, and this function exists because of what the
 * mutation found. `elfMarkerSourceProblem` used a plain `text.includes(needle)`
 * over the concatenated verifier source. Both `msg!("STARK proof verified for
 * circuit {}", …)` sites were replaced with a different string and the gate
 * stayed SILENT under `--verify-onchain`, because a `//` comment three lines
 * above happened to quote the literal while explaining why it mattered. Deleting
 * that comment too made the gate fire and name the control. So the check was
 * satisfiable by prose — and prose never reaches rodata, which is the one place
 * the deployed-ELF scan looks.
 *
 * The rule is a line-level heuristic on purpose: a marker counts only if at
 * least ONE line carrying it is not a comment line. It cannot be fooled by a
 * doc block or a `//` note, and it cannot produce a false RED from over-eager
 * comment stripping, because a real `msg!("…")` line is never a comment line.
 * What it does not catch is a literal that survives only inside a `#[doc = "…"]`
 * attribute or a raw string used as data; neither exists in this verifier, and
 * both would be a strange way to keep a marker alive.
 */
function emittedInSource(text, needle) {
  return text
    .split('\n')
    .some((line) => {
      if (!line.includes(needle)) return false;
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    });
}

// ---------------------------------------------------------------------------
// Where to look. Pinned HERE, chosen by the CALLER, never taken from the record.
// ---------------------------------------------------------------------------

/**
 * A cluster LABEL selects an endpoint from this table and a program id from
 * Anchor.toml. The label comes from `--cluster`; the record's `cluster` is
 * checked against it, so the record cannot redirect the on-chain leg at a chain,
 * or a program, of its choosing.
 *
 * `anchorSection` is the Anchor.toml table for that cluster; Anchor's own name
 * for mainnet is `programs.mainnet`, not `programs.mainnet-beta`. A label with no
 * entry here is a hard failure — there is no default and no fallback, because a
 * fallback is how an unrecognised label becomes a silent pass.
 *
 * `shipping: false` means a client build or publish must never be gated on it.
 * localnet is here so `--measure` and hand runs can reach a test validator, and
 * for nothing else; every path that reads it demands the escape-hatch variable
 * below and labels its own verdict as not a shipping verdict.
 */
const CLUSTERS = {
  devnet: { endpoint: 'https://api.devnet.solana.com', anchorSection: 'programs.devnet', sdkNetwork: 'devnet', shipping: true },
  'mainnet-beta': { endpoint: 'https://api.mainnet-beta.solana.com', anchorSection: 'programs.mainnet', sdkNetwork: 'mainnet', shipping: true },
  localnet: { endpoint: 'http://127.0.0.1:8899', anchorSection: 'programs.localnet', sdkNetwork: null, shipping: false },
};

/** Used when the caller passes no `--cluster`. A label, not an endpoint. */
const DEFAULT_CLUSTER = 'devnet';

/**
 * The one way to point this script at a non-shipping cluster. It must be set in
 * the environment by a human, per invocation. No build or publish step in this
 * repo sets it, and it is refused outright when CI is set.
 */
const LOCAL_ESCAPE_ENV = 'P01_ALLOW_LOCAL_VERIFIER_GATE';

/** The Anchor.toml key naming the verifier program, in every cluster table. */
const ANCHOR_PROGRAM_KEY = 'p01_stark_verifier';

/**
 * Read `p01_stark_verifier` out of one Anchor.toml `[programs.*]` table.
 * Anchor.toml is what `anchor deploy` targets and what `declare_id!` is kept in
 * step with, so it is the repo's answer to "which program is the verifier".
 * Returns null if the table or the key is absent.
 */
function programIdFromAnchorToml(anchorSection) {
  const text = readFileSync(resolve(REPO, 'Anchor.toml'), 'utf8');
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      inSection = line.slice(1, -1) === anchorSection;
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]+)"\s*$/);
    if (m !== null && m[1] === ANCHOR_PROGRAM_KEY) return m[2];
  }
  return null;
}

/**
 * EVERY id the CLIENTS can send a STARK proof to.
 *
 * Anchor.toml is what `anchor deploy` targets, but no client reads it. Clients
 * resolve the verifier through the privacy SDK, so the SDK's ids and the
 * Anchor.toml id have to be the same program or this gate is vouching for a
 * deployment nobody talks to: point Anchor.toml at a second, B1 copy of the
 * verifier and the on-chain leg agrees while every client keeps sending proofs to
 * the other id and keeps failing with FriFoldCheckFailed.
 *
 * An earlier revision of this file read ONE id, `PROGRAM_IDS[network].starkVerifier`
 * in constants.ts, and said in this comment that "every client resolves the
 * verifier through the SDK id". That was wrong, and the way it was wrong is the
 * reason this now sweeps instead of reading one key. MEASURED 2026-07-31:
 *
 *   packages/privacy-sdk/src/constants.ts    devnet.starkVerifier
 *                                            EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z
 *   packages/privacy-sdk/src/modules/instantUnshield.ts:65
 *                                            P01_STARK_VERIFIER_PROGRAM_ID
 *                                            DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
 *
 * The second is exported from the SDK's index, is the `programId` of all seven
 * instant-unshield instruction builders, and is the default value of
 * `starkVerifierProgramId` on the client class. Both ids are LIVE, DISTINCT
 * p01_stark_verifier deployments on devnet under the same upgrade authority
 * (EXmAQqm… slot 456289287, 780,249 B; DGY37k3… slot 469197514, 817,617 B —
 * measured with --measure), and DGY37k3… is also what `declare_id!` in
 * programs/p01_stark_verifier/src/lib.rs names. So the gate was reading one
 * deployment while a shipped SDK path addressed another.
 *
 * Nothing here prefers one file over another: the Anchor.toml id and every id the
 * SDK associates with the stark verifier must all be equal.
 *
 * `pnpm check-program-ids` is the other place this is caught. It could not catch
 * anything until 2026-08-02: it ran `tsx scripts/sync-program-ids.ts --check`
 * and that file had never existed in this tree (MEASURED 2026-07-31 and again
 * 2026-08-02, `git ls-files` has no match and there is no `scripts/` directory).
 * It is now `node scripts/sync-program-ids.mjs --check`, it exists, it sweeps the
 * WHOLE repo rather than the SDK, and it is keyed on `declare_id!`. It is still
 * not run by .github/workflows/ci.yml, so this sweep stays here rather than
 * delegating: the gate that gets run is the one that has to check.
 *
 * The roots below are every package and app that pins a verifier id in code. It
 * was `packages/privacy-sdk/src` alone until 2026-08-02, which meant that the
 * FOUR other client-side pins — packages/stark-prover/src/types.ts,
 * packages/zkspl-sdk/src/constants.ts, apps/web, apps/extension, apps/mobile —
 * were unchecked by the gate that exists to prove the client and the deployment
 * interlock. They all happen to agree today; "happen to" is the problem.
 *
 * Returns `[{ file, symbol, id }]`, empty when nothing could be read.
 */
const SDK_ROOT = 'packages/privacy-sdk/src';

/**
 * Every tree that compiles a verifier program id into a shipped artifact.
 * Scanned for module-level `*STARK_VERIFIER*` constants; see the note above.
 */
const CLIENT_ID_ROOTS = [
  'packages/privacy-sdk/src',
  'packages/stark-prover/src',
  'packages/zkspl-sdk/src',
  'packages/react-native-zk/src',
  'apps/web/lib',
  'apps/extension/src',
  'apps/mobile/services',
];
const SDK_PROGRAM_IDS = 'packages/privacy-sdk/src/constants.ts';
const SDK_PROGRAM_KEY = 'starkVerifier';

/** base58, 32-byte-ish. Loose on length on purpose; it is compared, not decoded. */
const B58_ID = "[1-9A-HJ-NP-Za-km-z]{32,44}";

function programIdFromPrivacySdk(sdkNetwork) {
  let text;
  try {
    text = readFileSync(resolve(REPO, SDK_PROGRAM_IDS), 'utf8');
  } catch {
    return null;
  }
  let inNetwork = false;
  let depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!inNetwork) {
      if (new RegExp(`^${sdkNetwork}\\s*:\\s*\\{`).test(line)) {
        inNetwork = true;
        depth = 1;
      }
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*new PublicKey\('([^']+)'\)/);
    if (m !== null && m[1] === SDK_PROGRAM_KEY) return m[2];
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth <= 0) return null;
  }
  return null;
}

/**
 * Any OTHER module-level constant in the SDK that pins a verifier id, e.g.
 * `export const P01_STARK_VERIFIER_PROGRAM_ID = new PublicKey('…')`. Scoped to
 * names that say stark verifier, so this does not sweep up unrelated program ids;
 * the network-keyed table is read separately above because its other networks are
 * legitimately different ids.
 */
function verifierConstantsInPrivacySdk() {
  const out = [];
  // `new PublicKey('…')` OR a bare string literal: two of the five roots pin the
  // id as a plain string (packages/stark-prover/src/types.ts
  // DEFAULT_STARK_VERIFIER_PROGRAM_ID, packages/zkspl-sdk/src/constants.ts
  // STARK_VERIFIER_PROGRAM_ID), and a regex that only understood PublicKey would
  // have swept a root and found nothing, which reads identically to a clean root.
  const re = new RegExp(
    `const\\s+([A-Za-z0-9_]*STARK_VERIFIER[A-Za-z0-9_]*)\\s*(?::[^=]*)?=\\s*(?:new PublicKey\\(\\s*)?'(${B58_ID})'`,
    'g',
  );
  for (const root of CLIENT_ID_ROOTS) {
    let entries;
    try {
      entries = readdirSync(resolve(REPO, root), { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !/\.(ts|tsx|mts|js|mjs)$/.test(ent.name)) continue;
      const abs = resolve(ent.parentPath ?? ent.path, ent.name);
      let text;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const rel = relative(REPO, abs).split('\\').join('/');
      for (const m of text.matchAll(re)) {
        const line = text.slice(0, m.index).split('\n').length;
        out.push({ file: `${rel}:${line}`, symbol: m[1], id: m[2] });
      }
    }
  }
  return out;
}

/**
 * The address `declare_id!` bakes into the verifier bytecode.
 *
 * This is the check the Anchor.toml/SDK comparison above was missing: those two
 * agreeing proves only that they agree, and a tree where they agree on an
 * address the PROGRAM rejects is a tree where every instruction fails with
 * `DeclaredProgramIdMismatch` before a single proof byte is read. MEASURED
 * 2026-08-02: Anchor.toml [programs.devnet] named EXmAQqm… while declare_id!
 * named DGY37k3…, both live on devnet, and `solana program dump` of each shows
 * the 32-byte pubkey embedded in the ELF is its own address — so the bytes
 * deployed at EXmAQqm… are not built from this tree and never can be.
 */
const VERIFIER_LIB_RS = 'programs/p01_stark_verifier/src/lib.rs';

function verifierDeclaredId() {
  let text;
  try {
    text = readFileSync(resolve(REPO, VERIFIER_LIB_RS), 'utf8');
  } catch {
    return null;
  }
  return text.match(new RegExp(`declare_id!\\(\\s*"(${B58_ID})"\\s*\\)`))?.[1] ?? null;
}

// ---------------------------------------------------------------------------

const USAGE =
  'usage: deployed-verifier-check.mjs [--verify-onchain] [--measure] [--record <path>] [--cluster <label>]';

const argv = process.argv.slice(2);
let wantOnchain = false;
let wantMeasure = false;
let RECORD_REL = RECORD_DEFAULT;
let clusterFlag = null;

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--verify-onchain') {
    wantOnchain = true;
  } else if (a === '--measure') {
    wantMeasure = true;
  } else if (a === '--record' || a === '--cluster') {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      console.error(`[deployed-verifier] ${a} needs a value`);
      console.error(USAGE);
      process.exit(2);
    }
    if (a === '--record') RECORD_REL = v;
    else clusterFlag = v;
    i += 1;
  } else {
    console.error(`[deployed-verifier] unknown argument ${a}`);
    console.error(USAGE);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// WHICH DEPLOYMENT THIS RUN IS ABOUT. Decided here, before anything is read.
// ---------------------------------------------------------------------------
//
// The record is not consulted. It carries a `cluster` label of its own, but that
// label is evidence to be checked against this choice further down, and a
// disagreement fails the run. A record that could pick the cluster could pick
// `localnet` and be verified against a chain the person editing it controls.

const TARGET_CLUSTER = clusterFlag ?? DEFAULT_CLUSTER;
const TARGET = CLUSTERS[TARGET_CLUSTER];

if (TARGET === undefined) {
  console.error(`[deployed-verifier] unknown --cluster ${JSON.stringify(TARGET_CLUSTER)}`);
  console.error(`[deployed-verifier] known labels: ${Object.keys(CLUSTERS).join(', ')}`);
  console.error(USAGE);
  process.exit(2);
}

/** The caller named a cluster that cannot produce a shipping verdict. */
const LOCAL_MODE = TARGET.shipping !== true;

if (LOCAL_MODE) {
  const allowed = process.env[LOCAL_ESCAPE_ENV] === '1';
  const inCI = ['CI', 'GITHUB_ACTIONS', 'VERCEL', 'EAS_BUILD'].some(
    (v) => process.env[v] !== undefined && process.env[v] !== '' && process.env[v] !== 'false' && process.env[v] !== '0',
  );
  if (!allowed || inCI) {
    console.error(`${'='.repeat(78)}`);
    console.error(`[deployed-verifier] REFUSED — ${TARGET_CLUSTER} cannot answer the question this gate asks.`);
    console.error('');
    console.error('  This gate decides whether a client may SHIP. Shipped clients talk to devnet and');
    console.error('  mainnet-beta. A validator on this machine proves nothing about either: deploy the');
    console.error('  current verifier to a local validator and the gate goes green forever while devnet');
    console.error('  is still pre-B1 and every proof a user generates dies on chain with');
    console.error('  FriFoldCheckFailed. That much needs no forgery at all, and a fake JSON-RPC');
    console.error(`  listener on ${TARGET.endpoint} reaches the same green with less work.`);
    console.error('');
    console.error(`  Shipping clusters: ${Object.entries(CLUSTERS).filter(([, c]) => c.shipping).map(([k]) => k).join(', ')}`);
    console.error('');
    if (inCI && allowed) {
      console.error(`  ${LOCAL_ESCAPE_ENV}=1 is set, and is being IGNORED because this is CI. The escape`);
      console.error('  hatch is for a human at a keyboard on their own machine, and CI never ships a');
      console.error('  verdict that a developer machine vouched for.');
    } else {
      console.error(`  If you are developing against a local validator and you know the result is NOT a`);
      console.error(`  shipping verdict, rerun with ${LOCAL_ESCAPE_ENV}=1 in the environment.`);
    }
    console.error(`${'='.repeat(78)}`);
    process.exit(1);
  }
  console.error(`${'!'.repeat(78)}`);
  console.error(`[deployed-verifier] LOCAL MODE — cluster ${TARGET_CLUSTER} (${TARGET.endpoint}).`);
  console.error(`[deployed-verifier] ${LOCAL_ESCAPE_ENV}=1 was set, so this run is allowed against a chain`);
  console.error('[deployed-verifier] that is not a shipping cluster. WHATEVER IT PRINTS IS NOT A SHIPPING');
  console.error('[deployed-verifier] VERDICT. It says nothing about devnet or mainnet-beta, and a green run');
  console.error('[deployed-verifier] here does not mean a client built from this tree can ship.');
  console.error(`${'!'.repeat(78)}`);
}

function countOccurrences(buf, needle) {
  const nb = Buffer.from(needle, 'binary');
  let n = 0;
  let i = 0;
  while ((i = buf.indexOf(nb, i)) !== -1) {
    n += 1;
    i += 1;
  }
  return n;
}

/**
 * Classify a PROVER BLOB's proof-format generation from its own bytes.
 *
 * Returns { generation: 'b2' | 'b1' | 'pre-b1' | null, hits, missingControls }.
 * `generation: null` means "refuses to classify" and MUST be treated as a
 * failure. This DECIDES NOTHING — `prover-behaviour.mjs` decides, by driving the
 * blob — it is corroboration, and the value of corroboration is that it can name
 * the same generation the behaviour does. A two-label scan in a three-generation
 * world could not, which is the bug this replaced.
 */
function classifyBlob(buf) {
  const missingControls = BLOB_CONTROLS.filter((c) => countOccurrences(buf, c) === 0);
  const hits = BLOB_ALL_MARKERS.filter((m) => countOccurrences(buf, m) > 0);
  if (missingControls.length > 0) return { generation: null, hits, missingControls };
  const b2 = BLOB_MARKERS_B2.filter((m) => countOccurrences(buf, m) > 0);
  const b1 = BLOB_MARKERS_B1.filter((m) => countOccurrences(buf, m) > 0);
  // Newest era first. A partial era is NOT that era: half the B2 asserts present
  // is an artifact somebody edited, and `blobSourceSkew` reports it separately.
  const generation =
    b2.length === BLOB_MARKERS_B2.length ? 'b2' : b1.length > 0 ? 'b1' : 'pre-b1';
  return { generation, hits, missingControls };
}

/**
 * Classify a DEPLOYED ELF's proof-format generation from its own bytes.
 *
 * Returns { generation: 'b1+' | 'pre-b1' | null, hits, missingControls }.
 *
 * `'b1+'` means "B1 or newer, and this method cannot say which". It is NOT a
 * synonym for `b1`; see `ELF_MARKERS_B2` for why there is no literal that would
 * separate them and what it would take to get one. Compare it with
 * `generationsAreCompatible`, never with `===`.
 */
function classifyElf(buf) {
  const missingControls = ELF_CONTROLS.filter((c) => countOccurrences(buf, c) === 0);
  const hits = ELF_B1_MARKERS.filter((m) => countOccurrences(buf, m) > 0);
  if (missingControls.length > 0) return { generation: null, hits, missingControls };
  if (ELF_MARKERS_B2.length > 0) {
    // Kept live rather than commented out: the day somebody adds a B2 literal to
    // the verifier and lists it above, this scan becomes exact with no other edit.
    const b2 = ELF_MARKERS_B2.filter((m) => countOccurrences(buf, m) > 0);
    if (b2.length === ELF_MARKERS_B2.length) return { generation: 'b2', hits, missingControls };
    if (hits.length > 0) return { generation: 'b1', hits, missingControls };
    return { generation: 'pre-b1', hits, missingControls };
  }
  return { generation: hits.length > 0 ? 'b1+' : 'pre-b1', hits, missingControls };
}

/**
 * Is `claimed` (an exact generation somebody wrote down) consistent with
 * `observed` (what a scan could actually see)?
 *
 * The only inexact observation is `'b1+'`. Everything else must match exactly, so
 * this never loosens a comparison that used to be tight.
 */
function generationsAreCompatible(observed, claimed) {
  if (observed === null || claimed === null || claimed === undefined) return true;
  if (observed === 'b1+') return claimed === 'b1' || claimed === 'b2';
  return observed === claimed;
}

// [MERGE 2026-08-03] `classifyBlobStrings` stood here — the other lot's version
// of the same three-rung ladder `classifyBlob` above implements. It is deleted
// rather than kept beside it: two classifiers over the same markers, one called
// and one not, is precisely the shape of a guard that reads as covering
// something and covers nothing. The difference between them was the partial-era
// rule, recorded on BLOB_MARKERS_B2.

/** Which generation markers the prover source in THIS TREE carries. null if unreadable. */
function proverSourceMarkerHits() {
  const src = readSources(BLOB_MARKER_SOURCES);
  if (src.text === null) return null;
  return BLOB_ALL_MARKERS.filter((m) => src.text.includes(m));
}

/**
 * The blob must carry the same B1 discriminators as the prover source it is
 * built from. Returns a failure block, or null when they agree.
 *
 * A marker the source has and the blob does not used to BE the false green:
 * four bytes of panic text edited out of the artifact reclassified a B1 prover
 * as pre-B1 and greened this gate against a pre-B1 chain. It no longer decides
 * the generation, so what this check reports now is narrower and still worth a
 * red: the artifact and the source it is supposed to be built from disagree
 * about themselves, which means one of them was edited or the blob was never
 * reshipped from this checkout.
 */
function blobSourceSkew(blobHits) {
  const src = readSources(BLOB_MARKER_SOURCES);
  if (src.text === null) {
    return {
      title: `cannot read ${src.unreadable}, so the blob's generation cannot be corroborated`,
      lines: [
        `  ${src.message}`,
        'That file is the prover source the checked-in blob is supposed to be built from, and it is what',
        "stops the blob from being the only witness to its own generation. Without it a blob with its B1",
        'panic strings edited out reads as pre-B1 and greens this gate against a pre-B1 chain.',
      ],
    };
  }
  const srcHits = BLOB_ALL_MARKERS.filter((m) => src.text.includes(m));
  const onlySource = srcHits.filter((m) => !blobHits.includes(m));
  const onlyBlob = blobHits.filter((m) => !srcHits.includes(m));
  if (onlySource.length === 0 && onlyBlob.length === 0) return null;
  return {
    title: 'the prover blob and the prover source disagree about which generation markers exist',
    lines: [
      `  source ${BLOB_MARKER_SOURCES.join(', ')}  ${srcHits.length}/${BLOB_ALL_MARKERS.length}`,
      `  blob   ${CANONICAL}  ${blobHits.length}/${BLOB_ALL_MARKERS.length}`,
      ...(onlySource.length > 0 ? ['', '  in the SOURCE but not in the BLOB:', ...onlySource.map((m) => `    ${JSON.stringify(m)}`)] : []),
      ...(onlyBlob.length > 0 ? ['', '  in the BLOB but not in the SOURCE:', ...onlyBlob.map((m) => `    ${JSON.stringify(m)}`)] : []),
      '',
      'Two things do this, and this gate cannot tell them apart:',
      '',
      '  1. The blob was not built from this tree. src/wireFormat.test.ts asserts the blob\'s proofs equal',
      '     what the Rust prover in stark/ emits, so a blob that disagrees with that source here is a',
      '     reship that never happened, or one that happened from a different checkout.',
      '  2. The literals were edited. MEASURED: rewriting four bytes of panic text inside the blob leaves',
      '     WebAssembly.validate true, every control present, the byte count identical and all four twins',
      '     agreeing after --write, and used to reclassify a B1 prover as pre-B1. That greened this gate',
      '     against the real pre-B1 devnet deployment at exit 0 while every proof would still have died',
      '     with FriFoldCheckFailed. It no longer moves the verdict — the generation is measured by',
      '     driving the blob — but it is still an artifact nobody can account for.',
      '',
      'If the messages were legitimately reworded, update BLOB_MARKERS_B1 / BLOB_MARKERS_B2 in this script',
      'in the same commit.',
      'Do not make the two sides agree by editing the artifact.',
    ],
  };
}

/**
 * The two halves of this tree have to agree about which generation it is.
 *
 * B1 landed in the prover and in the verifier together, so a tree whose verifier
 * source carries its B1 literals while its prover source carries none is skew,
 * and one of the two was edited.
 *
 * This used to be a load-bearing defence, costed at "renaming five strings across
 * two crates" — and MEASURED at that cost, which the rename bought and then
 * spent: the gate printed the full PASS at exit 0 against the real pre-B1 devnet
 * deployment. Deriving the generation from BEHAVIOUR is what closed it, and this
 * check is now a consistency assertion about the sources rather than the thing
 * standing between the repo and a false green.
 *
 * Returns a failure block, or null.
 */
function treeGenerationSkew() {
  const proverHits = proverSourceMarkerHits();
  if (proverHits === null) return null; // blobSourceSkew already reports an unreadable prover source.
  const src = readSources(ELF_MARKER_SOURCES);
  if (src.text === null) return null; // elfMarkerSourceProblem already reports this.
  const verifierHits = ELF_B1_MARKERS.filter((m) => src.text.includes(m));
  if ((proverHits.length > 0) === (verifierHits.length > 0)) return null;
  return {
    title: 'the prover source and the verifier source disagree about whether this tree is B1',
    lines: [
      `  ${BLOB_MARKER_SOURCES.join(', ')}  ${proverHits.length}/${BLOB_ALL_MARKERS.length} generation markers`,
      `  ${ELF_MARKER_SOURCES.join(', ')}  ${verifierHits.length}/${ELF_B1_MARKERS.length} B1 markers`,
      '',
      'B1 changed the prover and the verifier together, so one half carrying its B1 literals while the',
      'other carries none is not a generation, it is skew, and one of the two files was edited. The',
      'client generation no longer depends on this — it is measured by driving the blob — so this is a',
      'red about the sources, not about the interlock verdict.',
      '',
      'If these messages were legitimately reworded, update BLOB_MARKERS_B1 / BLOB_MARKERS_B2 /',
      'ELF_B1_MARKERS in this',
      'script in the same commit.',
    ],
  };
}

/**
 * The literals the DEPLOYED-ELF scan discriminates on must still exist in the
 * verifier source. Nothing here is compared against the chain: the deployed
 * bytes are expected to lag, that lag is the subject of this gate. What is
 * checked is that the discriminator itself is not stale, because once these are
 * reworded "no B1 markers on chain" means "this script can no longer tell",
 * which is not the same claim at all. Returns a failure block, or null.
 */
function elfMarkerSourceProblem(treeIsB1) {
  const src = readSources(ELF_MARKER_SOURCES);
  if (src.text === null) {
    return {
      title: `cannot read ${src.unreadable}, so the deployed-ELF scan cannot be corroborated`,
      lines: [`  ${src.message}`, 'That file is where the literals this scan classifies a deployment by come from.'],
    };
  }
  // `emittedInSource`, not `includes` — see that function. A literal that
  // survives only in a comment is a literal the deployed ELF will not carry, and
  // this check exists to say the scan's discriminators are still real.
  const missingMarkers = treeIsB1 ? ELF_B1_MARKERS.filter((m) => !emittedInSource(src.text, m)) : [];
  const missingControls = ELF_CONTROLS.filter((c) => !emittedInSource(src.text, c));
  if (missingMarkers.length === 0 && missingControls.length === 0) return null;
  return {
    title: 'the literals this gate classifies a DEPLOYMENT by no longer exist in the verifier source',
    lines: [
      `  source ${ELF_MARKER_SOURCES.join(', ')}`,
      ...(missingMarkers.length > 0 ? ['', '  B1 markers gone from the source:', ...missingMarkers.map((m) => `    ${JSON.stringify(m)}`)] : []),
      ...(missingControls.length > 0 ? ['', '  controls gone from the source:', ...missingControls.map((m) => `    ${JSON.stringify(m)}`)] : []),
      '',
      'The tree is B1 and these are the strings that say so, so a deployment scanned with them would now',
      'be reported pre-B1 whatever it is actually running, or refuse to classify for the wrong reason.',
      'Update ELF_B1_MARKERS / ELF_CONTROLS in this script to literals the current verifier really emits.',
    ],
  };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const failures = [];
const fail = (title, lines) => failures.push({ title, lines });

// ---------------------------------------------------------------------------
// on-chain reader, shared by --measure and --verify-onchain
// ---------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toBase58(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) s = `1${s}`;
    else break;
  }
  return s;
}

/** Hard cap so a slow or hanging RPC cannot stall a client build. */
const RPC_TIMEOUT_MS = 20_000;

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

/**
 * Read the deployed program's ELF straight off the BPFLoaderUpgradeable
 * programdata account. Throws on any RPC problem.
 */
async function readDeployed(rpcUrl, programId) {
  const prog = await rpc(rpcUrl, 'getAccountInfo', [programId, { encoding: 'base64' }]);
  if (!prog?.value) throw new Error(`program account ${programId} does not exist on ${rpcUrl}`);
  const progData = Buffer.from(prog.value.data[0], 'base64');
  if (progData.length !== 36 || progData.readUInt32LE(0) !== 2) {
    throw new Error(`${programId} is not an upgradeable Program account (len ${progData.length}, enum ${progData.readUInt32LE(0)})`);
  }
  const programdataAddress = toBase58(progData.subarray(4, 36));

  const pd = await rpc(rpcUrl, 'getAccountInfo', [programdataAddress, { encoding: 'base64' }]);
  if (!pd?.value) throw new Error(`programdata account ${programdataAddress} does not exist`);
  const raw = Buffer.from(pd.value.data[0], 'base64');
  if (raw.readUInt32LE(0) !== 3) throw new Error(`programdata enum is ${raw.readUInt32LE(0)}, expected 3`);

  const lastDeployedSlot = Number(raw.readBigUInt64LE(4));
  const hasAuthority = raw[12] === 1;
  const upgradeAuthority = hasAuthority ? toBase58(raw.subarray(13, 45)) : null;

  // 45-byte header, then the ELF, then loader-reserved zero padding.
  const padded = raw.subarray(45);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1;
  const elf = padded.subarray(0, end);
  if (elf.subarray(0, 4).toString('latin1') !== '\x7fELF') {
    throw new Error('programdata payload does not start with the ELF magic');
  }

  return {
    programdataAddress,
    loader: prog.value.owner,
    upgradeAuthority,
    lastDeployedSlot,
    programdataAccountSpace: pd.value.space,
    elf,
    elfSha256: sha256(elf),
    elfBytes: elf.length,
    paddedSha256: sha256(padded),
    paddedBytes: padded.length,
  };
}

/** How many times to try the chain before calling it unreachable. */
const RPC_ATTEMPTS = 3;

/**
 * `readDeployed` with a bounded retry. This exists because the alternative to a
 * flake is now a RED BUILD rather than a skip, and public devnet returns a
 * JSON-RPC error under rate limiting often enough to matter.
 *
 * It cannot manufacture a pass. Every attempt has to reach the RPC, get a
 * programdata account back and parse an ELF out of it; there is no branch here
 * that returns anything on failure. All it can do is turn N transient errors
 * into one report of the last one.
 */
async function readDeployedWithRetry(rpcUrl, programId) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt += 1) {
    try {
      return await readDeployed(rpcUrl, programId);
    } catch (e) {
      lastErr = e;
      if (attempt < RPC_ATTEMPTS) {
        console.log(`[deployed-verifier] chain read attempt ${attempt}/${RPC_ATTEMPTS} failed (${e.message}); retrying`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// --measure: print a fresh `deployed` block and stop
// ---------------------------------------------------------------------------
//
// This runs BEFORE the record is read and reads nothing out of it. --measure is
// what you run when the record is stale or wrong, so depending on the record
// would make it useless in the one situation it exists for. The cluster comes
// from --cluster, the program id from Anchor.toml, and neither is negotiable
// here either: a --measure that could be aimed by the record would just be the
// same hole one step earlier, since its output is what gets pasted in.

if (wantMeasure) {
  const srcHits = proverSourceMarkerHits();
  const elfStale = elfMarkerSourceProblem(srcHits !== null && srcHits.length > 0);
  if (elfStale !== null) {
    console.error(`[deployed-verifier] --measure refuses to classify: ${elfStale.title}`);
    for (const line of elfStale.lines) console.error(line);
    process.exit(1);
  }
  const measureProgramId = programIdFromAnchorToml(TARGET.anchorSection);
  if (measureProgramId === null) {
    console.error(`[deployed-verifier] --measure: Anchor.toml has no ${ANCHOR_PROGRAM_KEY} under [${TARGET.anchorSection}]`);
    console.error('That table is where this script learns which program to read, so there is nothing to fetch.');
    process.exit(1);
  }
  console.error(`[deployed-verifier] --measure reading ${measureProgramId} on ${TARGET_CLUSTER} (${TARGET.endpoint})`);
  let chain;
  try {
    chain = await readDeployedWithRetry(TARGET.endpoint, measureProgramId);
  } catch (e) {
    console.error(`[deployed-verifier] --measure could not read ${measureProgramId} on ${TARGET.endpoint}: ${e.message}`);
    process.exit(1);
  }
  const cls = classifyElf(chain.elf);
  const observedSlot = await rpc(TARGET.endpoint, 'getSlot', []).catch(() => null);
  console.log(
    JSON.stringify(
      {
        cluster: TARGET_CLUSTER,
        program_id: measureProgramId,
        programdata_address: chain.programdataAddress,
        loader: chain.loader,
        upgrade_authority: chain.upgradeAuthority,
        last_deployed_slot: chain.lastDeployedSlot,
        elf_sha256: chain.elfSha256,
        elf_bytes: chain.elfBytes,
        elf_sha256_with_loader_padding: chain.paddedSha256,
        elf_bytes_with_loader_padding: chain.paddedBytes,
        programdata_account_space: chain.programdataAccountSpace,
        proof_format_generation: cls.generation ?? 'UNCLASSIFIABLE',
        measured_at: { date_utc: new Date().toISOString().slice(0, 10), observed_slot: observedSlot },
      },
      null,
      2,
    ),
  );
  if (cls.generation === null) {
    console.error(`\n[deployed-verifier] the deployed ELF could not be classified: controls missing ${JSON.stringify(cls.missingControls)}`);
    process.exit(1);
  }
  {
    // --measure output is what gets pasted into the record, so a scan that
    // disagrees with a hand-measured deployment must not be printed as fact.
    const contradiction = knownElfContradiction(chain.elfSha256, cls.generation, 'the marker scan');
    if (contradiction !== null) {
      console.error(`\n[deployed-verifier] --measure refuses to vouch for that block: ${contradiction.title}`);
      for (const line of contradiction.lines) console.error(line);
      process.exit(1);
    }
  }
  console.error(
    `\n[deployed-verifier] --measure only READS the chain. Paste the block above into ${RECORD_REL}, ` +
      'and set accepts_client_blob_sha256 only after proving a blob against this deployment end to end.',
  );
  if (LOCAL_MODE) {
    console.error(`[deployed-verifier] This block describes ${TARGET_CLUSTER}. Pasting it in makes the record describe a`);
    console.error('[deployed-verifier] local chain, and every shipping run of this gate will then fail on the cluster');
    console.error('[deployed-verifier] mismatch. That is deliberate: do not commit it.');
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. the record
// ---------------------------------------------------------------------------

const recordAbs = resolve(REPO, RECORD_REL);
let record;
try {
  record = JSON.parse(readFileSync(recordAbs, 'utf8'));
} catch (e) {
  console.error(`[deployed-verifier] cannot read ${RECORD_REL}: ${e.message}`);
  console.error('That file is the record of which on-chain verifier this client blob may talk to.');
  console.error('Without it nothing knows whether the shipped prover matches the deployed program.');
  process.exit(1);
}

// The instructions in the record are what tells whoever hits a red gate which
// side to fix. Deleting them would not defeat the on-chain leg, but it would
// leave a red gate with no stated remedy, which is how a red gate gets quietly
// reinterpreted. They are required to exist and be non-trivial.
const REQUIRED_DOC_FIELDS = [
  '_WHAT_THIS_IS',
  '_HOW_TO_MAKE_THE_GATE_GREEN',
  '_WHICH_EXISTING_GATES_LET_A_STALE_BLOB_THROUGH_SILENTLY',
];
for (const field of REQUIRED_DOC_FIELDS) {
  const v = record[field];
  const text = Array.isArray(v) ? v.join('\n') : typeof v === 'string' ? v : '';
  if (text.trim().length < 200) {
    fail(`${RECORD_REL} is missing the required doc field ${field}`, [
      'That block records why this gate exists and the ONE legitimate way to make it green.',
      'It is required so a red gate cannot be quietly reinterpreted. Restore it.',
    ]);
  }
}

const deployed = record.deployed ?? {};
const clientRec = record.client_blob ?? {};
for (const [path, value] of [
  ['deployed.cluster', deployed.cluster],
  ['deployed.program_id', deployed.program_id],
  ['deployed.elf_sha256', deployed.elf_sha256],
  ['deployed.proof_format_generation', deployed.proof_format_generation],
  ['client_blob.sha256', clientRec.sha256],
  ['client_blob.proof_format_generation', clientRec.proof_format_generation],
]) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${RECORD_REL} is missing ${path}`, ['Every field above is required for the interlock to mean anything.']);
  }
}

// ---------------------------------------------------------------------------
// 1b. the record's cluster label is CHECKED against the caller's choice
// ---------------------------------------------------------------------------
//
// The endpoint and the program id were fixed by --cluster before this file was
// opened. What is left for the record to do is agree, or fail the run. A record
// that disagrees is describing some other deployment than the one this run is
// about, and nothing it says applies.

const endpoint = TARGET.endpoint;
let programId = null;

if ('rpc_url' in deployed) {
  fail(`${RECORD_REL} carries deployed.rpc_url`, [
    'The endpoint is pinned in deployed-verifier-check.mjs and keyed by the --cluster label the CALLER',
    "passed. It is not the record's to choose, because a record that names its own endpoint can name one",
    'that does not answer, and an endpoint that does not answer used to be a SKIP that still exited 0.',
    'Delete the field.',
  ]);
}

if (typeof deployed.cluster === 'string' && deployed.cluster.length > 0) {
  if (CLUSTERS[deployed.cluster] === undefined) {
    fail(`${RECORD_REL} names an unknown cluster ${JSON.stringify(deployed.cluster)}`, [
      `Known labels: ${Object.keys(CLUSTERS).join(', ')}.`,
      'There is deliberately no default: an unrecognised label must not quietly become devnet.',
    ]);
  } else if (deployed.cluster !== TARGET_CLUSTER) {
    fail(`${RECORD_REL} describes ${deployed.cluster}, but this run is gating ${TARGET_CLUSTER}`, [
      `  record deployed.cluster  ${deployed.cluster}`,
      `  this run  --cluster      ${TARGET_CLUSTER}${clusterFlag === null ? ' (the default; pass --cluster to change it)' : ''}`,
      '',
      'The caller says which deployment a build is allowed to ship against. The record is evidence about',
      'a deployment, and evidence that is about a different chain is not evidence. This is the check that',
      'stops a record from choosing where it is verified: it used to name the cluster, so setting it to',
      'localnet and answering on 127.0.0.1:8899 produced a full PASS with exit code 0.',
      '',
      'If the record is right and this run is wrong, pass --cluster ' + deployed.cluster + '.',
    ]);
  }
}

{
  const anchorId = programIdFromAnchorToml(TARGET.anchorSection);
  if (anchorId === null) {
    fail(`Anchor.toml has no ${ANCHOR_PROGRAM_KEY} under [${TARGET.anchorSection}]`, [
      'That table is where this script learns which program to read. Without it the cluster label',
      'resolves to an endpoint but not to a program, and the on-chain leg has nothing to fetch.',
    ]);
  } else {
    programId = anchorId;
    // declare_id! outranks both files below: it is enforced by the bytecode.
    {
      const declaredId = verifierDeclaredId();
      if (declaredId === null) {
        fail(`cannot read declare_id! out of ${VERIFIER_LIB_RS}`, [
          'That macro is the address the verifier bytecode enforces. Without it this gate cannot tell',
          'whether the program it is about to fetch is one a .so from this tree could even run as.',
        ]);
      } else if (declaredId !== anchorId) {
        fail('Anchor.toml aims `anchor deploy` at an address the verifier itself rejects', [
          `  ${VERIFIER_LIB_RS}  declare_id!  ${declaredId}`,
          `  Anchor.toml [${TARGET.anchorSection}] ${ANCHOR_PROGRAM_KEY}  ${anchorId}`,
          '',
          'An Anchor program compares the id it is invoked with against declare_id! and rejects every',
          'instruction with DeclaredProgramIdMismatch when they differ. So a .so built from this tree can',
          'only ever execute at the declare_id! address, and this gate would otherwise be reading, and',
          'vouching for, a deployment this source can never become.',
          '',
          'MEASURED 2026-08-02: this was exactly the state of the tree. Anchor.toml named EXmAQqm…,',
          'declare_id! named DGY37k3…, both live on devnet under the same upgrade authority, and dumping',
          'both ELFs shows each embeds its OWN id — the bytes at EXmAQqm… are from the lineage commit',
          '04885979 reverted off. Fix Anchor.toml, or run `pnpm check-program-ids` for the whole picture.',
        ]);
      }
    }
    if (TARGET.sdkNetwork !== null) {
      const sdkId = programIdFromPrivacySdk(TARGET.sdkNetwork);
      if (sdkId === null) {
        fail(`${SDK_PROGRAM_IDS} does not name ${SDK_PROGRAM_KEY} for ${TARGET.sdkNetwork}`, [
          'That is the id every client sends its proof to. If this gate cannot read it, it cannot show that',
          'the deployment it just verified is the deployment the shipped code will actually talk to.',
        ]);
      } else if (sdkId !== anchorId) {
        fail('Anchor.toml and the privacy SDK disagree about which verifier the clients call', [
          `  Anchor.toml [${TARGET.anchorSection}] ${ANCHOR_PROGRAM_KEY}  ${anchorId}`,
          `  ${SDK_PROGRAM_IDS} ${TARGET.sdkNetwork}.${SDK_PROGRAM_KEY}  ${sdkId}`,
          '',
          'The on-chain leg below reads the Anchor.toml id, and clients resolve the verifier through the',
          'SDK. While those differ this gate is vouching for a deployment no user talks to: a second,',
          'B1 copy of the verifier deployed under the Anchor.toml id would satisfy the whole on-chain leg',
          'while every shipped client kept sending proofs to the other id and kept failing with',
          'FriFoldCheckFailed, which is the exact failure this gate exists to prevent.',
        ]);
      }

      // constants.ts is not the only place the SDK pins this program. Every
      // module-level *STARK_VERIFIER* constant is swept, because one of them
      // names a DIFFERENT live devnet deployment and is what the instant-unshield
      // instructions are actually built against. See verifierConstantsInPrivacySdk.
      for (const c of verifierConstantsInPrivacySdk()) {
        if (c.id === anchorId) continue;
        fail(`${c.symbol} in ${c.file.split(':')[0]} names a different verifier than Anchor.toml`, [
          `  Anchor.toml [${TARGET.anchorSection}] ${ANCHOR_PROGRAM_KEY}  ${anchorId}`,
          `  ${c.file}  ${c.symbol}  ${c.id}`,
          '',
          'This gate verifies the Anchor.toml id against the chain. That constant is compiled into the',
          'published SDK and is what the code using it sends its proof to, so while the two differ the',
          'green this gate can print is about a program that code never addresses. Both ids being pre-B1',
          'today is why the verdict does not change; it is not a reason to leave it unchecked.',
          '',
          'Point them at the same program. `pnpm check-program-ids` (node scripts/sync-program-ids.mjs',
          '--check) sweeps the whole repo for this and reports every occurrence with the declare_id! it',
          'should carry. That command existed only in package.json until 2026-08-02.',
        ]);
      }
    }
    if (anchorId !== deployed.program_id) {
      fail(`${RECORD_REL} and Anchor.toml disagree about the verifier program`, [
        `  record deployed.program_id           ${deployed.program_id}`,
        `  Anchor.toml [${TARGET.anchorSection}] ${ANCHOR_PROGRAM_KEY}  ${anchorId}`,
        'The Anchor.toml value wins and is what gets fetched. This is not a formality: if the record could',
        'name the program, a record could point the on-chain leg at some other program that happens to be',
        'the generation it wants to claim, and the leg would agree with it.',
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. the checked-in blob
// ---------------------------------------------------------------------------

const canonicalAbs = resolve(REPO, CANONICAL);
let blob;
try {
  blob = readFileSync(canonicalAbs);
} catch (e) {
  console.error(`[deployed-verifier] cannot read ${CANONICAL}: ${e.message}`);
  process.exit(1);
}
const blobSha = sha256(blob);

// THE VERDICT. The blob is driven — seven witnesses in, seven proof digests out
// — and the generation is whichever column of the fixture table all seven match.
// Nothing here reads a string out of the artifact or out of any Rust source, so
// no rename in any file changes what this returns. See prover-behaviour.mjs.
const tableProblem = fixtureTableProblem();
if (tableProblem !== null) fail(tableProblem.title, tableProblem.lines);
const blobBehaviour = classifyProverBehaviour(blob);

// CORROBORATION ONLY. The panic-literal scan that used to BE the verdict is kept
// because it still detects things the digests do not — a string-stripped
// artifact, or a blob that was not built from the source in this tree — and
// because a disagreement between what the blob says and what it does is itself
// the signature of the measured four-byte edit. It no longer decides anything.
const blobStrings = classifyBlob(blob);

/** The generation the interlock is allowed to act on. Behavioural, or nothing. */
const blobGen = tableProblem === null ? blobBehaviour.generation : null;

console.log(`[deployed-verifier] gating   ${TARGET_CLUSTER}${clusterFlag === null ? ' (default)' : ' (--cluster)'} ${TARGET.endpoint}${LOCAL_MODE ? '  NOT A SHIPPING CLUSTER' : ''}`);
console.log(`[deployed-verifier] record   ${RECORD_REL}`);
console.log(`[deployed-verifier] blob     ${CANONICAL}`);
console.log(`[deployed-verifier]          ${blob.length.toLocaleString()} bytes, sha256 ${blobSha}`);
console.log(
  `[deployed-verifier]          generation ${blobGen ?? 'UNCLASSIFIABLE'} — MEASURED by driving it: ` +
    `${blobBehaviour.results.filter((r) => r.verdict === blobGen).length}/${blobBehaviour.results.length} ` +
    `circuits emit the ${blobGen ?? 'expected'} proof digest (${(blobBehaviour.ms / 1000).toFixed(1)} s)`,
);
console.log(
  `[deployed-verifier]          panic-string scan says ${blobStrings.generation ?? 'UNCLASSIFIABLE'} ` +
    `(${blobStrings.hits.length}/${BLOB_ALL_MARKERS.length} era markers) — corroboration, not the verdict`,
);
console.log(`[deployed-verifier] source   ${BLOB_MARKER_SOURCES.join(', ')} carries ${proverSourceMarkerHits()?.length ?? '?'}/${BLOB_ALL_MARKERS.length} of the same markers`);
console.log(`[deployed-verifier] deployed ${deployed.program_id} on ${deployed.cluster} (as the record has it)`);
console.log(`[deployed-verifier]          generation ${deployed.proof_format_generation}, elf sha256 ${deployed.elf_sha256}, slot ${deployed.last_deployed_slot}`);

if (blobGen === null) {
  fail('the checked-in prover blob could not be classified by what it DOES', [
    `  ${blobBehaviour.problem ?? 'the reference fixture table was rejected; see the failure above'}`,
    ...(blobBehaviour.results.length > 0 ? ['', ...describeBehaviour(blobBehaviour), ''] : ['']),
    'The generation is decided by driving the blob against seven fixed witnesses and comparing the seven',
    'proof digests, because B1 is length-preserving on all seven circuits and only the CONTENT moves.',
    'A blob whose digests match neither the B1 column nor the measured pre-B1 artifact is a prover this',
    'gate has never seen, and there is no safe default: guessing would guess "pre-b1", which is exactly',
    'the guess that ships a B1 client at a pre-B1 chain. Refusing instead.',
    '',
    'If the wire format changed on purpose, re-measure the fixtures in scripts/prover-behaviour.mjs in',
    'lockstep with src/wireFormat.test.ts and programs/p01_stark_verifier/tests/b1_deep_binding.rs.',
  ]);
}

// The blob does not get to be the only witness to its own generation. Its B1
// markers are scanned in stark/src/compact.rs too and the two sets must match;
// a marker the source has and the artifact does not is skew, not a generation.
// ...and the prover source does not get to be the only witness either: B1 landed
// in the prover and the verifier together, so the two crates must agree about
// which generation this tree is.
//
// None of these null out `blobGen` any more. They used to, because the string
// scan WAS the verdict and a skewed scan had to be prevented from satisfying the
// interlock. Now the verdict comes from behaviour, which a skew cannot touch, so
// each of these adds a failure and the interlock still fires underneath it.
if (blobStrings.generation === null) {
  fail('the checked-in prover blob carries none of the literals every generation has', [
    `Missing control literals: ${JSON.stringify(blobStrings.missingControls)}`,
    'These are present in every generation of the blob. Their absence means the artifact is empty,',
    'truncated, string-stripped or simply not the prover. That is worth failing on even though the',
    'generation is now measured by driving the blob rather than by scanning it.',
  ]);
}
{
  const skew = blobSourceSkew(blobStrings.hits);
  if (skew !== null) fail(skew.title, skew.lines);
  const treeSkew = treeGenerationSkew();
  if (treeSkew !== null) fail(treeSkew.title, treeSkew.lines);
}

// WHAT THE BLOB SAYS vs WHAT THE BLOB DOES. This is the four-byte edit, named.
// A B1 prover with its B1 panic strings rewritten scans as pre-B1 and proves as
// B1, and that combination has no innocent explanation.
if (blobGen !== null && blobStrings.generation !== null && blobGen !== blobStrings.generation) {
  fail('the blob PROVES one generation and its panic strings CLAIM another', [
    `  driving the blob (seven proof digests)  ${blobGen}`,
    `  scanning the blob for panic literals    ${blobStrings.generation} (${blobStrings.hits.length}/${BLOB_ALL_MARKERS.length} era markers)`,
    '',
    ...describeBehaviour(blobBehaviour),
    '',
    'The digests win, because they are what the on-chain verifier sees; the strings are what a human',
    'reads. MEASURED 2026-07-31: rewriting four bytes of panic text inside the blob left the length,',
    'WebAssembly.validate, every control literal and all four twins intact, reclassified a B1 prover as',
    'pre-B1 and printed the full PASS at exit 0 against the genuinely pre-B1 devnet deployment. This is',
    'that edit. Reship the blob from this tree; do not reconcile the two sides by editing either.',
  ]);
}

// ---------------------------------------------------------------------------
// 3. the twins — what the clients actually import
// ---------------------------------------------------------------------------
//
// apps/web, apps/extension, apps/mobile and packages/react-native-zk import the
// inlined base64, never the .wasm. Checking only the canonical blob would check
// a file no client ships.

for (const twinRel of TWIN_PATHS) {
  const abs = resolve(REPO, twinRel);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (e) {
    fail(`${twinRel} is missing`, [e.message]);
    continue;
  }
  const { base64: b64, problem } = extractBase64(text);
  if (b64 === null) {
    fail(`${twinRel} does not present one exported prover literal`, [
      `  ${problem}`,
      'The literal hashed here has to be the one the client imports. It was not until 2026-07-31: both',
      'this gate and stark-wasm-twins.mjs took the FIRST long base64 run in the file, so a decoy carrying',
      'the canonical bytes above the export made both print ok while apps/web shipped a different prover.',
    ]);
    continue;
  }
  const decoded = Buffer.from(b64, 'base64');
  const twinSha = sha256(decoded);
  if (twinSha !== blobSha) {
    fail(`${twinRel} carries a DIFFERENT prover than ${CANONICAL}`, [
      `  twin      ${decoded.length.toLocaleString()} bytes, sha256 ${twinSha}`,
      `  canonical ${blob.length.toLocaleString()} bytes, sha256 ${blobSha}`,
      'This client is on its own generation and this gate cannot vouch for it.',
      'Fix with: node packages/stark-prover/scripts/stark-wasm-twins.mjs --write',
    ]);
  } else {
    console.log(`[deployed-verifier] ok       ${twinRel}`);
  }
}

// ---------------------------------------------------------------------------
// 4. the record is reconciled with the blob on disk
// ---------------------------------------------------------------------------

if (clientRec.sha256 !== blobSha) {
  fail('the record has NOT been reconciled with the blob on disk', [
    `  record client_blob.sha256  ${clientRec.sha256}`,
    `  blob on disk               ${blobSha}`,
    'The prover was reshipped without revisiting deployment compatibility. Every reship changes what',
    'the on-chain verifier must be running. Re-derive the record, do not just paste the new hash in.',
  ]);
}
if (typeof clientRec.bytes === 'number' && clientRec.bytes !== blob.length) {
  fail('the record\'s client_blob.bytes does not match the blob on disk', [
    `  record ${clientRec.bytes} / disk ${blob.length}`,
  ]);
}
if (blobGen !== null && clientRec.proof_format_generation !== blobGen) {
  fail('the record misstates the blob\'s own generation', [
    `  record client_blob.proof_format_generation  ${clientRec.proof_format_generation}`,
    `  measured by driving the blob                ${blobGen}`,
    '',
    ...describeBehaviour(blobBehaviour),
    '',
    'The measured value wins: it is what the artifact does, the record is just prose.',
  ]);
}

// ---------------------------------------------------------------------------
// 5. THE INTERLOCK
// ---------------------------------------------------------------------------

const deployedGen = deployed.proof_format_generation;

// Before the interlock reads it: the generation the record attributes to that
// ELF, against what that ELF was measured to be. This one needs no chain — an
// offline run catches an edited generation too, as long as elf_sha256 is one of
// the deployments somebody has already read.
{
  const contradiction = knownElfContradiction(deployed.elf_sha256, deployedGen, 'the record');
  if (contradiction !== null) fail(contradiction.title, contradiction.lines);
}

if (blobGen !== null && deployedGen !== blobGen) {
  fail(`the client blob is ${blobGen.toUpperCase()}, the deployed program is ${String(deployedGen).toUpperCase()}`, [
    `  client blob  ${blobGen.padEnd(7)} ${blobSha}  (${blob.length.toLocaleString()} B, this tree)`,
    `  deployed     ${String(deployedGen).padEnd(7)} ${deployed.elf_sha256}  (${Number(deployed.elf_bytes ?? 0).toLocaleString()} B, ${deployed.cluster} slot ${deployed.last_deployed_slot})`,
    '',
    `The client generation was MEASURED by driving the blob, not read off it (${(blobBehaviour.ms / 1000).toFixed(1)} s, all seven circuits):`,
    ...describeBehaviour(blobBehaviour),
    '',
    'EVERY PROOF THIS CLIENT GENERATES WILL BE REJECTED WITH FriFoldCheckFailed.',
    '',
    'Not a parse error, not a length mismatch, not an early exit. The proof serialises, uploads in full',
    'over many chunked transactions, and fails on the LAST instruction. To a user it looks like an',
    'unexplained transaction failure at the end of a slow upload.',
    '',
    'SHIP THE PROGRAM FIRST. Deploy programs/p01_stark_verifier to the cluster above, then re-measure:',
    `  node packages/stark-prover/scripts/deployed-verifier-check.mjs --measure --cluster ${TARGET_CLUSTER}`,
    `and update ${RECORD_REL}. Editing that file without redeploying satisfies the checks above and`,
    'changes nothing on chain. The --verify-onchain leg refetches the deployment and rejects that edit,',
    'and every build and publish step that runs this script runs it with --verify-onchain.',
  ]);
} else if (deployed.accepts_client_blob_sha256 !== blobSha) {
  // Same generation, but this exact artifact has never been proven against the
  // deployment. Weaker than the mismatch above, still not something to ship blind.
  fail('this exact blob has never been proven against the deployed program', [
    `  blob on disk                            ${blobSha}`,
    `  record deployed.accepts_client_blob_sha256  ${deployed.accepts_client_blob_sha256 === null ? 'null (never recorded)' : deployed.accepts_client_blob_sha256}`,
    '',
    `The generations agree (${blobGen}), so this is not the FriFoldCheckFailed mismatch, but nobody has`,
    'submitted a proof from this artifact to that program and written the result down.',
    'Submit one, then set deployed.accepts_client_blob_sha256 to the hash above.',
  ]);
}

// ---------------------------------------------------------------------------
// 6. optional: prove the record against the chain
// ---------------------------------------------------------------------------
//
// Sections 1 to 5 read `deployed.*` and believe it. This one refetches the three
// fields that describe the deployment — elf_sha256, last_deployed_slot and
// proof_format_generation — and re-derives them from the programdata account, so
// an edit to any of the three does not survive here.
//
// It only means that because the record does not say where to look: the cluster
// comes from the caller's --cluster, the endpoint from CLUSTERS and the program
// id from Anchor.toml, and the record's own cluster and program_id have already
// been checked against those rather than followed.
//
// A cluster that cannot be reached is a HARD FAILURE whenever nothing else was
// going to fail this run. That is the point. It used to be a SKIP that still
// exited 0, which meant a record that named an unreachable endpoint got believed
// on its own authority; MEASURED, three edited fields passed --verify-onchain
// without the chain being contacted. A verification that could not reach the
// chain has established nothing, and must not report success on the strength of
// the file it was checking.
//
// When the run is already red the unreachable cluster is reported and not
// counted again: the exit code is 1 either way, and adding a second failure to a
// build that is already failing only buries the real one.

if (wantOnchain) {
  // Snapshot BEFORE the chain read: "was anything else going to fail this run?"
  const nothingElseWouldFail = failures.length === 0;

  let chain = null;
  let chainErr = null;
  if (programId === null) {
    chainErr = new Error(`Anchor.toml does not name ${ANCHOR_PROGRAM_KEY} for ${TARGET_CLUSTER} (see the failures above)`);
  } else {
    console.log(`[deployed-verifier] on-chain reading ${programId} on ${TARGET_CLUSTER} (${endpoint})`);
    try {
      chain = await readDeployedWithRetry(endpoint, programId);
    } catch (e) {
      chainErr = e;
    }
  }

  if (chainErr !== null) {
    if (nothingElseWouldFail) {
      fail('the on-chain leg could not run, and nothing else was going to fail this build', [
        `  cluster  ${TARGET_CLUSTER}`,
        `  endpoint ${endpoint}`,
        `  program  ${programId ?? '(unresolved)'}`,
        `  error    ${chainErr.message}`,
        '',
        `Tried ${RPC_ATTEMPTS} times. Everything else in this run passed, which means the only thing left`,
        'saying the record is true is the record. That is not a verification, so this is a failure and not',
        'a skip. Rerun when the cluster answers.',
      ]);
    } else {
      console.log(`[deployed-verifier] on-chain leg did NOT run: ${chainErr.message}`);
      console.log('[deployed-verifier] this run is already red for the reasons below, so the unreachable cluster is');
      console.log('[deployed-verifier] not counted twice. Rerun when it answers to get the on-chain verdict too.');
    }
  }

  if (chain) {
    console.log(`[deployed-verifier] on-chain programdata ${chain.programdataAddress}, slot ${chain.lastDeployedSlot}, elf ${chain.elfBytes.toLocaleString()} B sha256 ${chain.elfSha256}`);

    if (chain.elfSha256 !== deployed.elf_sha256) {
      fail('the record does not describe what is actually deployed (elf sha256)', [
        `  record ${deployed.elf_sha256}`,
        `  chain  ${chain.elfSha256}`,
        'Either the program was redeployed without updating the record, or the record was written by hand.',
        'Regenerate it: node packages/stark-prover/scripts/deployed-verifier-check.mjs --measure',
      ]);
    }
    if (typeof deployed.last_deployed_slot === 'number' && chain.lastDeployedSlot !== deployed.last_deployed_slot) {
      fail('the record does not describe what is actually deployed (last_deployed_slot)', [
        `  record ${deployed.last_deployed_slot}`,
        `  chain  ${chain.lastDeployedSlot}`,
      ]);
    }

    const elfStale = elfMarkerSourceProblem(proverSourceMarkerHits()?.length > 0);
    if (elfStale !== null) fail(elfStale.title, elfStale.lines);

    const chainCls = classifyElf(chain.elf);
    if (chainCls.generation === null) {
      fail('the deployed ELF could not be classified', [
        `Missing control literals: ${JSON.stringify(chainCls.missingControls)}`,
        'The deployed bytes carry none of the msg! literals this scan relies on. Refusing to classify.',
      ]);
    } else if (!generationsAreCompatible(chainCls.generation, deployedGen)) {
      fail('THE RECORD CLAIMS A GENERATION THE CHAIN DOES NOT HAVE', [
        `  record deployed.proof_format_generation  ${deployedGen}`,
        `  derived from the deployed bytes          ${chainCls.generation}`,
        `  B1 markers found on chain                ${JSON.stringify(chainCls.hits)}`,
        '',
        'The generation was re-derived from the bytes the chain returned, not read from the record, and the',
        'cluster, endpoint and program id were not the record\'s to choose. Editing the JSON turns the',
        'offline half green and is caught here. Deploy the program.',
      ]);
    } else {
      if (chainCls.generation === 'b1+') {
        // Say the limit out loud on the PASS path, not only in a comment nobody
        // reads while shipping. See ELF_MARKERS_B2.
        console.log(
          `[deployed-verifier] on-chain PARTIAL — the ELF scan can only say "B1 or newer"; the record's ` +
            `"${deployedGen}" is compatible with that but was NOT confirmed by it.`,
        );
        console.log(
          '[deployed-verifier]          No literal in programs/p01_stark_verifier/src/ separates B1 from B2, ' +
            'and B1 -> B2 is the boundary that breaks every proof.',
        );
      }
      // The scan agreed with the record. Both of those can be reworded; the
      // bytes the chain just handed back cannot. If those bytes are a
      // deployment somebody measured by hand, the scan has to agree with THAT
      // too, or the discriminator is what changed.
      const contradiction = knownElfContradiction(chain.elfSha256, chainCls.generation, 'the marker scan');
      if (contradiction !== null) fail(contradiction.title, contradiction.lines);
      console.log(`[deployed-verifier] on-chain ok — the chain agrees the deployment is ${chainCls.generation}`);
      if (KNOWN_ELF_GENERATIONS[chain.elfSha256] !== undefined) {
        console.log(`[deployed-verifier]          and those exact bytes were measured ${KNOWN_ELF_GENERATIONS[chain.elfSha256].generation} by hand on 2026-07-31`);
      }
      if (deployed.accepts_client_blob_sha256 === blobSha) {
        console.log('[deployed-verifier] note: accepts_client_blob_sha256 is an attestation. Nothing on chain records');
        console.log('[deployed-verifier]       which blob a deployment accepts, so this script did not verify it.');
      }
    }
  }
} else {
  console.log('[deployed-verifier] on-chain check not requested — this run checked the record against itself only.');
  console.log('[deployed-verifier] pass --verify-onchain to refetch the deployment and prove the record against it.');
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${'='.repeat(78)}`);
  console.error('[deployed-verifier] FAIL — the client prover and the deployed verifier do not interlock.');
  for (const f of failures) {
    console.error(`\n  ${f.title}`);
    for (const line of f.lines) console.error(line ? `    ${line}` : '');
  }
  console.error(`\n  Read ${relative(REPO, recordAbs).split('\\').join('/')} before changing anything.`);
  console.error(`${'='.repeat(78)}`);
  process.exit(1);
}

if (LOCAL_MODE) {
  // Not a shipping verdict, and it must not be quotable as one. The word PASS is
  // deliberately absent from this branch.
  console.log(`\n${'!'.repeat(78)}`);
  console.log(
    wantOnchain
      ? `[deployed-verifier] LOCAL OK — the blob matches the record, and ${TARGET_CLUSTER} agreed.`
      : `[deployed-verifier] LOCAL OK — the blob matches the record. No chain was asked.`,
  );
  console.log('[deployed-verifier] THIS IS NOT A SHIPPING VERDICT. It was measured against');
  console.log(`[deployed-verifier] ${TARGET.endpoint}, which no user has ever talked to. It says nothing about`);
  console.log(`[deployed-verifier] devnet or mainnet-beta. Before shipping anything, rerun without`);
  console.log(`[deployed-verifier] ${LOCAL_ESCAPE_ENV} and without --cluster ${TARGET_CLUSTER}.`);
  console.log(`${'!'.repeat(78)}`);
} else {
  console.log(
    wantOnchain
      ? `\n[deployed-verifier] PASS — the shipped prover matches the ${TARGET_CLUSTER} deployment, and the chain was asked and agreed.`
      : `\n[deployed-verifier] PASS — the shipped prover matches the RECORDED ${TARGET_CLUSTER} deployment. The chain was not asked.`,
  );
}
