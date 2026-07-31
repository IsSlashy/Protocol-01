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
 * that its proof-format generation, derived from the blob's own bytes, equals
 * the generation that record attributes to the deployment.
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
 * # Generation detection
 *
 * Both sides are classified by scanning for message literals that B1 introduced,
 * each with a POSITIVE CONTROL — a literal present in every generation. Without
 * the control an empty, truncated or string-stripped artifact would scan as
 * "no B1 markers found" and be classified pre-B1, which is a FALSE GREEN in the
 * one direction that matters. If the controls are missing the scan refuses to
 * classify and the gate fails.
 *
 * The markers are hardcoded here, not read from the JSON, so editing the record
 * cannot weaken the scan.
 *
 * The controls only cover the WHOLESALE case, and saying they close the
 * false-green direction was an overstatement until this revision. MEASURED
 * 2026-07-31 against the previous revision: rewriting one byte inside each of the
 * three B1 marker literals in the blob (`B1 ` -> `Bx `, `DEEP ` -> `DEEQ `, and
 * the same in the third), which changes four bytes of panic text and nothing
 * else — WebAssembly.validate still true, every control still present, the same
 * 211,370 bytes — then reshipping the four twins with stark-wasm-twins.mjs
 * --write and setting client_blob.proof_format_generation to `pre-b1` and
 * accepts_client_blob_sha256 to the doctored hash, printed
 * "PASS — the shipped prover matches the devnet deployment, and the chain was
 * asked and agreed", exit 0, against the real pre-B1 devnet deployment. The blob
 * was still B1 in every way that reaches the chain, so every proof it produced
 * would still have died with FriFoldCheckFailed. stark-wasm-twins.mjs --check
 * passed on the doctored artifacts too, because they agree with each other.
 *
 * That is the same false green the controls were supposed to stop, reached by
 * editing the discriminator instead of deleting it. It does not need an
 * adversary: rewording those three panic messages in stark/src/compact.rs is an
 * ordinary refactor and would have had exactly the same effect silently.
 *
 * # The blob is CORROBORATED against the source it is built from
 *
 * So the blob no longer classifies itself. BLOB_B1_MARKERS are scanned in
 * `stark/src/compact.rs` as well, and the two sets must be EQUAL. The prover
 * source and the prover binary are supposed to correspond — src/wireFormat.test.ts
 * already asserts that this blob's proofs equal what the Rust prover in stark/
 * emits — so a marker the source has and the blob does not means the blob was not
 * built from this tree, or the literal was edited out of it. Either way the scan
 * refuses to classify rather than reading the absence as "pre-B1".
 *
 * This is not unfakeable and is not claimed to be. MEASURED 2026-07-31 against
 * THIS revision: applying the same three renames to stark/src/compact.rs as well
 * restores the agreement, and the gate printed the full PASS at exit 0 again
 * against the pre-B1 devnet deployment. What the corroboration buys is that the
 * cheapest false green now requires renaming the
 * B1 panic messages in the prover's own source, in the same commit, for no
 * stated reason, in a diff a human reads — instead of being reachable by
 * touching only generated artifacts, or by accident during a rename. Deriving
 * the generation from BEHAVIOUR rather than from strings (a proof from this blob
 * is a different length and digest per circuit either side of B1, which is what
 * src/wireFormat.test.ts already pins) is the only thing that would close it
 * properly, and it is not done here.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';

import { REPO, CANONICAL, TWIN_PATHS, extractBase64 } from './wasm-artifacts.mjs';

const RECORD_DEFAULT = 'packages/stark-prover/deployed-verifier.json';

// ---------------------------------------------------------------------------
// Generation markers. Hardcoded on purpose — see the header.
// ---------------------------------------------------------------------------

/** Literals B1 added to the PROVER (stark/src/compact.rs). Any hit means B1. */
const BLOB_B1_MARKERS = [
  'B1 TERMINAL DEGREE BOUND VIOLATED',
  'DEEP denominator vanishes at LDE position ',
  'break the committed-vector/ood_quotient agreement B1 depends on',
];

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

/** Literals B1 added to the VERIFIER (programs/p01_stark_verifier/src/verify.rs). */
const ELF_B1_MARKERS = ['[verify] final poly coeff ', ' non-zero, bound is '];

/** msg! literals that predate B1 and are still in the source today. */
const ELF_CONTROLS = [
  '[verify] step1 ok',
  '[verify] step3.5 ok',
  '[verify] OOD z mismatch: got ',
  'STARK proof verified for circuit ',
];

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
 * The id the CLIENTS actually send their proof to.
 *
 * Anchor.toml is what `anchor deploy` targets, but no client reads it. apps/web,
 * apps/extension, apps/mobile and packages/react-native-zk all resolve the
 * verifier through PROGRAM_IDS in the privacy SDK, which is generated from
 * Anchor.toml by scripts/sync-program-ids.ts — and `pnpm check-program-ids`,
 * which would catch the two drifting apart, is NOT run by .github/workflows/ci.yml
 * (MEASURED 2026-07-31). So the two can disagree, and if they do this gate would
 * be reading a deployment no user ever talks to: point Anchor.toml at a second,
 * B1 copy of the verifier and the on-chain leg agrees while every client keeps
 * sending proofs to the pre-B1 id and keeps failing with FriFoldCheckFailed.
 *
 * The fix is not to prefer one file over the other. Both are read and they must
 * agree, because "the deployment this build may ship against" and "the program
 * the shipped code calls" have to be the same program for the question this gate
 * asks to mean anything.
 *
 * Returns the base58 id, or null if the block or the key is absent.
 */
const SDK_PROGRAM_IDS = 'packages/privacy-sdk/src/constants.ts';
const SDK_PROGRAM_KEY = 'starkVerifier';

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
 * Classify an artifact's proof-format generation from its own bytes.
 * Returns { generation: 'b1' | 'pre-b1' | null, hits, missingControls }.
 * `generation: null` means "refuses to classify" and MUST be treated as a failure.
 */
function classify(buf, markers, controls) {
  const missingControls = controls.filter((c) => countOccurrences(buf, c) === 0);
  const hits = markers.filter((m) => countOccurrences(buf, m) > 0);
  if (missingControls.length > 0) return { generation: null, hits, missingControls };
  return { generation: hits.length > 0 ? 'b1' : 'pre-b1', hits, missingControls };
}

/** Which B1 markers the prover source in THIS TREE carries. null if unreadable. */
function proverSourceMarkerHits() {
  const src = readSources(BLOB_MARKER_SOURCES);
  if (src.text === null) return null;
  return BLOB_B1_MARKERS.filter((m) => src.text.includes(m));
}

/**
 * The blob must carry the same B1 discriminators as the prover source it is
 * built from. Returns a failure block, or null when they agree.
 *
 * A marker the source has and the blob does not is the measured false green in
 * the header: four bytes of panic text edited out of the artifact reclassify a
 * B1 prover as pre-B1 and green the gate against a pre-B1 chain, with every
 * control intact and every twin agreeing. Read as skew, not as a generation.
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
  const srcHits = BLOB_B1_MARKERS.filter((m) => src.text.includes(m));
  const onlySource = srcHits.filter((m) => !blobHits.includes(m));
  const onlyBlob = blobHits.filter((m) => !srcHits.includes(m));
  if (onlySource.length === 0 && onlyBlob.length === 0) return null;
  return {
    title: 'the prover blob and the prover source disagree about which B1 markers exist',
    lines: [
      `  source ${BLOB_MARKER_SOURCES.join(', ')}  ${srcHits.length}/${BLOB_B1_MARKERS.length}`,
      `  blob   ${CANONICAL}  ${blobHits.length}/${BLOB_B1_MARKERS.length}`,
      ...(onlySource.length > 0 ? ['', '  in the SOURCE but not in the BLOB:', ...onlySource.map((m) => `    ${JSON.stringify(m)}`)] : []),
      ...(onlyBlob.length > 0 ? ['', '  in the BLOB but not in the SOURCE:', ...onlyBlob.map((m) => `    ${JSON.stringify(m)}`)] : []),
      '',
      'Two things do this, and this gate cannot tell them apart, so it refuses to classify either way:',
      '',
      '  1. The blob was not built from this tree. src/wireFormat.test.ts asserts the blob\'s proofs equal',
      '     what the Rust prover in stark/ emits, so a blob that disagrees with that source here is a',
      '     reship that never happened, or one that happened from a different checkout.',
      '  2. The literals were edited. MEASURED: rewriting four bytes of panic text inside the blob leaves',
      '     WebAssembly.validate true, every control present, the byte count identical and all four twins',
      '     agreeing after --write, and reclassifies a B1 prover as pre-B1. That greened this gate against',
      '     the real pre-B1 devnet deployment at exit 0 while every proof would still have died with',
      '     FriFoldCheckFailed. Rewording those messages in a normal refactor does the same thing.',
      '',
      'If the messages were legitimately reworded, update BLOB_B1_MARKERS in this script in the same commit.',
      'Do not make the two sides agree by editing the artifact.',
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
  const missingMarkers = treeIsB1 ? ELF_B1_MARKERS.filter((m) => !src.text.includes(m)) : [];
  const missingControls = ELF_CONTROLS.filter((c) => !src.text.includes(c));
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
  const cls = classify(chain.elf, ELF_B1_MARKERS, ELF_CONTROLS);
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
          'The on-chain leg below reads the Anchor.toml id, and every client resolves the verifier through',
          'the SDK id. While those differ this gate is vouching for a deployment no user talks to: a second,',
          'B1 copy of the verifier deployed under the Anchor.toml id would satisfy the whole on-chain leg',
          'while every shipped client kept sending proofs to the other id and kept failing with',
          'FriFoldCheckFailed, which is the exact failure this gate exists to prevent.',
          '',
          'Regenerate the SDK block from Anchor.toml: pnpm sync-program-ids',
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
const blobCls = classify(blob, BLOB_B1_MARKERS, BLOB_CONTROLS);

console.log(`[deployed-verifier] gating   ${TARGET_CLUSTER}${clusterFlag === null ? ' (default)' : ' (--cluster)'} ${TARGET.endpoint}${LOCAL_MODE ? '  NOT A SHIPPING CLUSTER' : ''}`);
console.log(`[deployed-verifier] record   ${RECORD_REL}`);
console.log(`[deployed-verifier] blob     ${CANONICAL}`);
console.log(`[deployed-verifier]          ${blob.length.toLocaleString()} bytes, sha256 ${blobSha}`);
console.log(`[deployed-verifier]          generation ${blobCls.generation ?? 'UNCLASSIFIABLE'} (B1 markers found: ${blobCls.hits.length}/${BLOB_B1_MARKERS.length})`);
console.log(`[deployed-verifier] source   ${BLOB_MARKER_SOURCES.join(', ')} carries ${proverSourceMarkerHits()?.length ?? '?'}/${BLOB_B1_MARKERS.length} of the same markers`);
console.log(`[deployed-verifier] deployed ${deployed.program_id} on ${deployed.cluster} (as the record has it)`);
console.log(`[deployed-verifier]          generation ${deployed.proof_format_generation}, elf sha256 ${deployed.elf_sha256}, slot ${deployed.last_deployed_slot}`);

if (blobCls.generation === null) {
  fail('the checked-in prover blob cannot be classified', [
    `Missing control literals: ${JSON.stringify(blobCls.missingControls)}`,
    'These are present in every generation of the blob. Their absence means the artifact is empty,',
    'truncated, string-stripped or simply not the prover. Refusing to classify rather than guess:',
    'guessing here defaults to "pre-b1", which would wave a B1 blob past a pre-B1 deployment.',
  ]);
}

// The blob does not get to be the only witness to its own generation. Its B1
// markers are scanned in stark/src/compact.rs too and the two sets must match;
// a marker the source has and the artifact does not is skew, not a generation.
{
  const skew = blobSourceSkew(blobCls.hits);
  if (skew !== null) {
    fail(skew.title, skew.lines);
    // The classification is now worthless in the direction that matters, so it
    // must not be used to satisfy the interlock below.
    blobCls.generation = null;
  }
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
  const b64 = extractBase64(text);
  if (b64 === null) {
    fail(`${twinRel} has no base64 prover literal`, ['This client ships no prover, or the file was hand-edited.']);
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
if (blobCls.generation !== null && clientRec.proof_format_generation !== blobCls.generation) {
  fail('the record misstates the blob\'s own generation', [
    `  record client_blob.proof_format_generation  ${clientRec.proof_format_generation}`,
    `  derived from the blob's bytes               ${blobCls.generation}`,
    `  B1 markers found in the blob                ${JSON.stringify(blobCls.hits)}`,
    'The derived value wins: it comes from the artifact, the record is just prose.',
  ]);
}

// ---------------------------------------------------------------------------
// 5. THE INTERLOCK
// ---------------------------------------------------------------------------

const deployedGen = deployed.proof_format_generation;
const blobGen = blobCls.generation;

if (blobGen !== null && deployedGen !== blobGen) {
  fail(`the client blob is ${blobGen.toUpperCase()}, the deployed program is ${String(deployedGen).toUpperCase()}`, [
    `  client blob  ${blobGen.padEnd(7)} ${blobSha}  (${blob.length.toLocaleString()} B, this tree)`,
    `  deployed     ${String(deployedGen).padEnd(7)} ${deployed.elf_sha256}  (${Number(deployed.elf_bytes ?? 0).toLocaleString()} B, ${deployed.cluster} slot ${deployed.last_deployed_slot})`,
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

    const chainCls = classify(chain.elf, ELF_B1_MARKERS, ELF_CONTROLS);
    if (chainCls.generation === null) {
      fail('the deployed ELF could not be classified', [
        `Missing control literals: ${JSON.stringify(chainCls.missingControls)}`,
        'The deployed bytes carry none of the msg! literals this scan relies on. Refusing to classify.',
      ]);
    } else if (chainCls.generation !== deployedGen) {
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
      console.log(`[deployed-verifier] on-chain ok — the chain agrees the deployment is ${chainCls.generation}`);
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
