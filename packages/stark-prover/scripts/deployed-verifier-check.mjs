#!/usr/bin/env node
/**
 * deployed-verifier-check.mjs — refuse to ship a client prover the deployed
 * on-chain verifier will reject.
 *
 *   node packages/stark-prover/scripts/deployed-verifier-check.mjs                  # offline gate (blocking)
 *   node packages/stark-prover/scripts/deployed-verifier-check.mjs --verify-onchain # + prove the record against the chain
 *   node packages/stark-prover/scripts/deployed-verifier-check.mjs --measure        # print a fresh `deployed` block
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

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const wantOnchain = argv.includes('--verify-onchain');
const wantMeasure = argv.includes('--measure');
const recordIdx = argv.indexOf('--record');
const RECORD_REL = recordIdx !== -1 ? argv[recordIdx + 1] : RECORD_DEFAULT;

for (const a of argv) {
  if (!['--verify-onchain', '--measure', '--record', RECORD_REL].includes(a)) {
    console.error(`[deployed-verifier] unknown argument ${a}`);
    console.error('usage: deployed-verifier-check.mjs [--verify-onchain] [--measure] [--record <path>]');
    process.exit(2);
  }
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
 * programdata account. Throws on any RPC problem; the caller decides whether an
 * unreachable cluster is a SKIP or a failure.
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

// The instructions in the record are the only thing standing between a red gate
// and someone "fixing" it by editing the wrong side. Stripping them is a defeat
// of the gate, so they are required to exist and be non-trivial.
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
  ['deployed.rpc_url', deployed.rpc_url],
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
// --measure: print a fresh `deployed` block and stop
// ---------------------------------------------------------------------------

if (wantMeasure) {
  const rpcUrl = deployed.rpc_url ?? 'https://api.devnet.solana.com';
  const programId = deployed.program_id;
  let chain;
  try {
    chain = await readDeployed(rpcUrl, programId);
  } catch (e) {
    console.error(`[deployed-verifier] --measure could not read ${programId} on ${rpcUrl}: ${e.message}`);
    process.exit(1);
  }
  const cls = classify(chain.elf, ELF_B1_MARKERS, ELF_CONTROLS);
  const observedSlot = await rpc(rpcUrl, 'getSlot', []).catch(() => null);
  console.log(
    JSON.stringify(
      {
        cluster: deployed.cluster ?? '<set me>',
        rpc_url: rpcUrl,
        program_id: programId,
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
  process.exit(0);
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

console.log(`[deployed-verifier] record   ${RECORD_REL}`);
console.log(`[deployed-verifier] blob     ${CANONICAL}`);
console.log(`[deployed-verifier]          ${blob.length.toLocaleString()} bytes, sha256 ${blobSha}`);
console.log(`[deployed-verifier]          generation ${blobCls.generation ?? 'UNCLASSIFIABLE'} (B1 markers found: ${blobCls.hits.length}/${BLOB_B1_MARKERS.length})`);
console.log(`[deployed-verifier] deployed ${deployed.program_id} on ${deployed.cluster}`);
console.log(`[deployed-verifier]          generation ${deployed.proof_format_generation}, elf sha256 ${deployed.elf_sha256}, slot ${deployed.last_deployed_slot}`);

if (blobCls.generation === null) {
  fail('the checked-in prover blob cannot be classified', [
    `Missing control literals: ${JSON.stringify(blobCls.missingControls)}`,
    'These are present in every generation of the blob. Their absence means the artifact is empty,',
    'truncated, string-stripped or simply not the prover. Refusing to classify rather than guess:',
    'guessing here defaults to "pre-b1", which would wave a B1 blob past a pre-B1 deployment.',
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
    '  node packages/stark-prover/scripts/deployed-verifier-check.mjs --measure',
    `and update ${RECORD_REL}. Editing that file without redeploying makes this gate green and changes`,
    'nothing on chain; --verify-onchain exists to catch exactly that edit.',
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
// This is the leg that cannot be cheated by editing the record. Everything above
// trusts `deployed.*`; this refetches it.
//
// A cluster we cannot reach is reported as SKIPPED and does not fail the build —
// a network flake must not block a merge. A cluster we CAN reach that disagrees
// with the record is a hard failure. So the record can only be believed when the
// network is down, and it is checked whenever it is up.

if (wantOnchain) {
  let chain = null;
  try {
    chain = await readDeployed(deployed.rpc_url, deployed.program_id);
  } catch (e) {
    console.log(`[deployed-verifier] on-chain SKIPPED — ${deployed.rpc_url} unreachable or unusable: ${e.message}`);
    console.log('[deployed-verifier] the offline result above still stands; rerun when the cluster is reachable.');
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
        'This is the check that makes the record unfakeable. The deployed program is what it is; editing',
        'the JSON to say otherwise turns the offline gate green and is caught here. Deploy the program.',
      ]);
    } else {
      console.log(`[deployed-verifier] on-chain ok — the chain agrees the deployment is ${chainCls.generation}`);
    }
  }
} else {
  console.log('[deployed-verifier] on-chain check not requested (pass --verify-onchain to prove the record against the cluster)');
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

console.log('\n[deployed-verifier] PASS — the shipped prover matches the recorded deployment.');
