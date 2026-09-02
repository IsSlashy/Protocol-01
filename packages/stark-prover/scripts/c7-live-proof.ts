/**
 * c7-live-proof.ts — submit a proof from the SHIPPED blob to the DEPLOYED
 * verifier, and read the answer back off the chain.
 *
 *   npx tsx packages/stark-prover/scripts/c7-live-proof.ts --dry-run
 *   npx tsx packages/stark-prover/scripts/c7-live-proof.ts
 *   npx tsx packages/stark-prover/scripts/c7-live-proof.ts --tamper [--input N]
 *   npx tsx packages/stark-prover/scripts/c7-live-proof.ts --forge  [--byte N]
 *
 * # Why this exists
 *
 * `shippedBlob.test.ts` says, in its own header:
 *
 *   "a deliberate rebuild needs the verifier redeployed and this value
 *    re-measured against a proof that actually landed, not against the build
 *    that produced it."
 *
 * and `deployed-verifier-check.mjs` says the same thing from the other side:
 *
 *   "DOES NOT PROVE: that a proof from this blob verifies on chain. Only a real
 *    submission proves that."
 *
 * Every other gate in this package compares the tree against itself. This one
 * is the only thing in the repository that asks the deployed program.
 *
 * ⚠️ IT IS WRITTEN IN TypeScript, not .mjs like its neighbours, because it must
 * import `src/` directly. `dist/` is built by tsup and goes stale exactly when
 * it matters most — right after a reship — and a gate that measures a stale
 * build of the loader is worse than no gate.
 *
 * # Cost
 *
 * The proof buffer is a PDA of (authority, circuit_id), so `close_proof_buffer`
 * needs only the authority — which this script holds. Rent is recovered.
 *
 * 🚨 That is NOT true of the 45 orphaned `ProofBuffer` accounts holding 20.50
 * SOL on devnet: those predate the PDA scheme and want an ephemeral key nobody
 * kept. Do not assume rent is recoverable just because it was here.
 *
 * # What it proves, exactly
 *
 * That the bytes in `packages/stark-prover/wasm/p01_stark_bg.wasm` produce a
 * circuit-7 proof which the program at `DEFAULT_STARK_VERIFIER_PROGRAM_ID`
 * accepts through BOTH phases — phase 1 (FRI / Merkle) and phase 2 (DEEP-ALI,
 * which carries C7's entire public-input-to-trace binding).
 *
 * It does NOT prove anything about the pool: `zk_shielded` reads the verified
 * buffer cross-program and applies its own checks. A spend landing end to end
 * is a separate measurement.
 *
 * # The two adversarial modes (gate 8 — black-box against the DEPLOYED program)
 *
 * An honest ACCEPT is half a measurement: a verifier that accepts everything
 * also accepts an honest proof. The two modes below take the SAME honest proof,
 * change exactly one thing, and ask the deployed program again. Both are
 * REPLAY attacks — the prover is honest, the submitter is not.
 *
 * The rejection is required to LAND. A transaction that fails preflight is the
 * RPC node's simulation: no slot, no signature, nothing an indexer can see. So
 * these modes send every transaction with `skipPreflight: true` and then read
 * the failing transaction back from the ledger, the same way the honest mode
 * reads its success back. The verdict comes from `meta.err` and the program
 * logs, never from the exception the client threw.
 *
 * --tamper: honest proof bytes, ONE public input changed. Default: the low bit
 *   of the nullifier (`--input N` picks another of the six, in wire order).
 *   Phase 1 step 1b re-derives the OOD point from a transcript that absorbs
 *   the public inputs (`verify.rs::verify_generic`), so the predicted
 *   rejection is PHASE 1, `[verify] OOD z mismatch: got .. want ..`, then
 *   `InvalidProof`.
 *   PROVES: the deployed program binds its Fiat-Shamir transcript to the
 *   public inputs — an honest proof cannot be re-labelled with a different
 *   nullifier, root or recipient.
 *   DOES NOT PROVE: that phase 2's DEEP-ALI binding rejects a wrong input.
 *   Phase 2 is never reached; the transcript check fires first. Nor that a
 *   prover who RE-PROVES with a wrong input is rejected — that is AIR
 *   soundness, measured off-chain in `stark/tests`, not here. Nor that
 *   changing the inputs BETWEEN the two phases is refused — that is the
 *   `public_inputs_hash` equality in `verify_deep_ali_phase2`, not exercised
 *   by this mode.
 *
 * --forge: honest public inputs, ONE proof byte flipped. Default: the low bit
 *   of the first byte of query 0's trace Merkle path — a sibling hash.
 *   `--byte N` picks any offset; the script names the field it lands in from a
 *   copy of the CONFIG_SPEND wire layout, and REFUSES to run if that model's
 *   total disagrees with the proof length, so the field name is checked, not
 *   assumed. Predicted rejection for the default: PHASE 1, step 3
 *   (`verify_merkle_proofs_generic`), after `[verify] step2 ok`.
 *   PROVES: the deployed program checks the Merkle openings it is handed.
 *   DOES NOT PROVE: FRI fold soundness (step 3.5) unless `--byte` targets a
 *   `fri[..]` field; nor anything about a forgery that is not a bit flip. A
 *   single flipped bit is the WEAKEST forgery. Rejecting it is necessary and
 *   never sufficient.
 *
 * # Why the on-chain error is always `InvalidProof`
 *
 * `lib.rs` maps every `verify::VerifyError` to `StarkVerifierError::InvalidProof`
 * (`.map_err(|_| InvalidProof)`) in both phases. The named inner variant —
 * `OodConstraintFailed`, `MerkleProofFailed`, `FriFoldCheckFailed`,
 * `DeepAliFailed` — never reaches the chain. What does: WHICH instruction
 * failed (decoded here from the discriminator), and the `[verify] stepN ok`
 * markers `verify_generic` prints as it goes. The last marker names the step
 * that refused. Either mode exits 0 only on `InvalidProof` from a verify
 * instruction. Anything else — `IncompleteProof`, a dropped chunk, a timeout —
 * is a failure of the MEASUREMENT and is reported as one. An ACCEPT in either
 * mode is a soundness failure of the deployed program and exits 2.
 *
 * # Rent in the adversarial modes
 *
 * `uploadAndVerify` closes the buffer only after phase 2 succeeds; a rejected
 * verify throws past that step. These modes close the PDA themselves and then
 * READ IT BACK — the run is not green until `getAccountInfo` returns null.
 *
 * # 429s
 *
 * `@solana/web3.js`'s RPC client retries HTTP 429 five times with a doubling
 * delay from 500 ms (`createRpcClient`, on by default). Chunk uploads retry on
 * top of that inside `uploadAndVerify`. Nothing here disables either.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type SendOptions,
  type VersionedTransactionResponse,
} from '@solana/web3.js';

import { initStarkWasm } from '../src/wasm-loader';
import {
  uploadAndVerify,
  getProofBufferPda,
  buildCloseProofBufferIx,
  DISCRIMINATORS,
} from '../src/upload-protocol';
import { DEFAULT_STARK_VERIFIER_PROGRAM_ID } from '../src/types';

const CIRCUIT_SPEND = 7;
/** `stark/src/air/spend.rs` CANONICAL_DEPTH — C7's subtree is 11, not the pool's 15. */
const CANONICAL_DEPTH = 11;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = args.includes('--dry-run');
const CLUSTER = flag('cluster') ?? 'devnet';
const KEYPAIR = flag('keypair') ?? join(homedir(), '.config', 'solana', 'id.json');

type Mode = 'honest' | 'tamper' | 'forge';
const MODE: Mode = args.includes('--tamper') ? 'tamper' : args.includes('--forge') ? 'forge' : 'honest';
if (args.includes('--tamper') && args.includes('--forge')) {
  console.error('FAIL — --tamper and --forge change different things; run them one at a time.');
  process.exit(1);
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

interface SpendJson {
  circuit_id: number;
  nullifier: string;
  root: string;
  recipient_hash: [string, string, string, string];
  proof_hex: string;
  proof_size: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// C7 wire layout — a copy of what `GenericCompactProof::from_bytes` walks
// ---------------------------------------------------------------------------

/**
 * `programs/p01_stark_verifier/src/compact_proof.rs` CONFIG_SPEND, only the
 * fields the byte layout depends on. `num_fri_layers` is derived exactly as the
 * parser derives it: `log2(lde_size / fri_final_poly_size) - 1`.
 */
const C7 = {
  traceWidth: 12,
  merkleDepth: 13,
  quotientSegments: 8,
  friFinalPolySize: 32,
  ldeSize: 8192,
  numQueries: 22,
} as const;

interface WireField { name: string; start: number; end: number }

/** Every field of a C7 proof with its byte range, in `from_bytes` order. */
function c7WireLayout(): WireField[] {
  const { traceWidth: tw, merkleDepth: md, quotientSegments: k, friFinalPolySize: fps, ldeSize, numQueries: nq } = C7;
  const numFriLayers = Math.log2(ldeSize / fps) - 1;
  const fields: WireField[] = [];
  let cursor = 0;
  const push = (name: string, len: number): void => {
    fields.push({ name, start: cursor, end: cursor + len });
    cursor += len;
  };
  push('trace_root', 32);
  push('quotient_root', 32);
  push('ood_current', tw * 8);
  push('ood_next', tw * 8);
  push('ood_z', 8);
  push('ood_quotient', k * 8);
  push('num_fri_layers', 1);
  push('fri_layer_roots', numFriLayers * 32);
  push('fri_final_poly_size', 2);
  push('fri_final_poly', fps * 8);
  push('grinding_nonce', 8);
  push('num_queries', 2);
  for (let q = 0; q < nq; q++) {
    const p = `query[${q}].`;
    push(`${p}position`, 4);
    push(`${p}trace_values`, tw * 8);
    push(`${p}trace_mirror_values`, tw * 8);
    push(`${p}next_trace_values`, tw * 8);
    push(`${p}next_trace_mirror_values`, tw * 8);
    push(`${p}merkle_path`, (md - 1) * 32);
    push(`${p}next_merkle_path`, (md - 1) * 32);
    push(`${p}quotient_mirror`, k * 8);
    push(`${p}quotient_pair_path`, (md - 1) * 32);
    for (let i = 0; i < numFriLayers; i++) {
      push(`${p}fri[${i}].values`, 16);
      // `fri_layer_pair_path_bytes`: merkle_depth.saturating_sub(layer + 2) * 32
      push(`${p}fri[${i}].pair_path`, Math.max(md - (i + 2), 0) * 32);
    }
  }
  push('quotient_values', nq * k * 8);
  return fields;
}

function describeOffset(layout: WireField[], offset: number): string {
  const f = layout.find((x) => offset >= x.start && offset < x.end);
  return f ? `${f.name} byte ${offset - f.start} of ${f.end - f.start}` : 'PAST THE END OF THE LAYOUT';
}

// ---------------------------------------------------------------------------
// Reading a rejection back off the chain
// ---------------------------------------------------------------------------

/**
 * `StarkVerifierError` in declaration order. Anchor numbers custom errors from
 * 6000, so index i is code 6000 + i. Mirror of `programs/p01_stark_verifier/src/lib.rs`.
 */
const VERIFIER_ERRORS = [
  'AlreadyVerified', 'ChunkOutOfBounds', 'IncompleteProof', 'InvalidProof',
  'DeserializationError', 'UnsupportedCircuit', 'NotYetVerified', 'CircuitZeroIsLegacyOnly',
] as const;

/**
 * A Connection that never asks the RPC to preflight — so a rejected verify
 * LANDS and is recorded — and remembers every signature it sent, so the failing
 * transaction can be found after `uploadAndVerify` throws without naming it.
 */
class RecordingConnection extends Connection {
  readonly sent: string[] = [];
  override async sendRawTransaction(
    raw: Buffer | Uint8Array | number[],
    options?: SendOptions,
  ): Promise<string> {
    const sig = await super.sendRawTransaction(raw, { ...options, skipPreflight: true });
    this.sent.push(sig);
    return sig;
  }
}

/** The ledger can lag the confirmation by a poll or two; do not conclude "no record" on the first miss. */
async function fetchTransaction(
  connection: Connection,
  signature: string,
): Promise<VersionedTransactionResponse | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/** Name of the verifier instruction in a transaction, from its discriminator. */
function verifierInstruction(tx: VersionedTransactionResponse, programId: PublicKey): string | null {
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys;
  for (const ix of msg.compiledInstructions) {
    if (!keys[ix.programIdIndex]?.equals(programId)) continue;
    const disc = ix.data.subarray(0, 8);
    for (const [name, bytes] of Object.entries(DISCRIMINATORS)) {
      if (bytes.every((b, i) => disc[i] === b)) return name;
    }
    return 'UNKNOWN DISCRIMINATOR';
  }
  return null;
}

/** `{ InstructionError: [ix, { Custom: code }] }` → the Anchor error name, or the raw error. */
function describeError(err: unknown): { custom: number | null; text: string } {
  const e = err as { InstructionError?: [number, unknown] } | null;
  const inner = e?.InstructionError?.[1] as { Custom?: number } | string | undefined;
  if (inner && typeof inner === 'object' && typeof inner.Custom === 'number') {
    const code = inner.Custom;
    const name = VERIFIER_ERRORS[code - 6000] ?? 'not a StarkVerifierError';
    return { custom: code, text: `${name} (${code} = 0x${code.toString(16)})` };
  }
  return { custom: null, text: JSON.stringify(err) };
}

async function closeBufferAndReadBack(
  connection: Connection,
  payer: Keypair,
  pda: PublicKey,
  programId: PublicKey,
): Promise<{ signature: string | null; stillOpen: boolean }> {
  let signature: string | null = null;
  if (await connection.getAccountInfo(pda)) {
    const tx = new Transaction().add(buildCloseProofBufferIx(pda, payer.publicKey, programId));
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    signature = await connection.sendRawTransaction(tx.serialize());
    const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (res.value.err) console.error(`  close_proof_buffer reverted: ${JSON.stringify(res.value.err)}`);
  }
  // Read, do not trust: "confirmed with no error" is still the client's view.
  const stillOpen = (await connection.getAccountInfo(pda)) !== null;
  return { signature, stillOpen };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`=== C7 live proof ${MODE === 'honest' ? '' : `(--${MODE}) `}=========================================`);

  const exports = await initStarkWasm();
  const spend = exports.generate_spend_stark_proof;
  if (!spend) {
    console.error('FAIL — the shipped blob does not export generate_spend_stark_proof.');
    console.error('       The reship did not happen, or it shipped the pre-C7 build.');
    process.exit(1);
  }

  // An arbitrary but well-formed witness. C7 DERIVES the subtree root from the
  // path rather than checking it against a fixed value, so any consistent path
  // yields a valid proof -- which is the whole point: the root is an output.
  const pathElements = Array.from({ length: CANONICAL_DEPTH }, (_, i) => String(1000 + i * 7));
  const pathIndices = Array.from({ length: CANONICAL_DEPTH }, (_, i) => String(i % 2));
  const recipientHash = ['111111111', '222222222', '333333333', '444444444'];

  const t0 = Date.now();
  const json = JSON.parse(spend(
    11n, 22n, 33n, 44n,
    pathElements.join(','), pathIndices.join(','), recipientHash.join(','),
  )) as SpendJson;
  const provingMs = Date.now() - t0;

  if (json.error) {
    console.error(`FAIL — the prover refused: ${json.error}`);
    process.exit(1);
  }

  const proofBytes = hexToBytes(json.proof_hex);
  // The public inputs are serialised VERBATIM in this order and the on-chain
  // reconstruction is sensitive to it. Do not sort, do not reorder.
  const publicInputs = [
    BigInt(json.nullifier),
    BigInt(json.root),
    ...json.recipient_hash.map((h) => BigInt(h)),
  ];

  console.log(`  circuit          ${json.circuit_id}`);
  console.log(`  proof            ${proofBytes.length.toLocaleString()} bytes`
    + `  (${Math.ceil(proofBytes.length / 1000)} chunks)`);
  console.log(`  proving          ${provingMs} ms`);
  console.log(`  public inputs    ${publicInputs.length} felts`);
  console.log(`  nullifier        ${json.nullifier}`);
  console.log(`  subtree root     ${json.root}`);

  if (json.circuit_id !== CIRCUIT_SPEND) {
    console.error(`FAIL — the generator returned circuit ${json.circuit_id}, not ${CIRCUIT_SPEND}.`);
    process.exit(1);
  }
  if (proofBytes.length !== json.proof_size) {
    console.error('FAIL — proof_hex and proof_size disagree; the wire format is broken.');
    process.exit(1);
  }

  // What the adversarial modes will actually submit. The honest proof and the
  // honest inputs are kept intact; each mode copies and edits exactly one.
  let submittedProof = proofBytes;
  let submittedInputs = publicInputs;
  let predicted = '';

  if (MODE === 'tamper') {
    const INPUT_NAMES = ['nullifier', 'subtree root', 'recipient_hash[0]', 'recipient_hash[1]', 'recipient_hash[2]', 'recipient_hash[3]'];
    const idx = Number(flag('input') ?? 0);
    const honest = publicInputs[idx];
    if (!Number.isInteger(idx) || honest === undefined) {
      console.error(`FAIL — --input must be 0..${publicInputs.length - 1}.`);
      process.exit(1);
    }
    submittedInputs = publicInputs.slice();
    submittedInputs[idx] = honest ^ 1n;
    predicted = 'phase 1, step 1b: [verify] OOD z mismatch';
    console.log(`\n  tamper           public input #${idx} (${INPUT_NAMES[idx]}) low bit flipped:`);
    console.log(`                   ${honest} -> ${submittedInputs[idx]}`);
    console.log('                   proof bytes intact');
  }

  if (MODE === 'forge') {
    const layout = c7WireLayout();
    const modelled = layout[layout.length - 1]?.end ?? 0;
    if (modelled !== proofBytes.length) {
      console.error(`FAIL — this script's copy of the C7 wire layout totals ${modelled} bytes; the proof is ${proofBytes.length}.`);
      console.error('       CONFIG_SPEND changed under it. Refusing to name a byte it cannot place; fix `C7` above first.');
      process.exit(1);
    }
    const defaultTarget = layout.find((f) => f.name === 'query[0].merkle_path');
    const offset = flag('byte') !== undefined ? Number(flag('byte')) : defaultTarget?.start ?? -1;
    const honest = proofBytes[offset];
    if (!Number.isInteger(offset) || honest === undefined) {
      console.error(`FAIL — --byte must be 0..${proofBytes.length - 1}.`);
      process.exit(1);
    }
    submittedProof = proofBytes.slice();
    submittedProof[offset] = honest ^ 0x01;
    if (flag('byte') === undefined) predicted = 'phase 1, step 3: verify_merkle_proofs_generic (after step2 ok)';
    console.log(`\n  forge            proof byte ${offset.toLocaleString()} low bit flipped:`);
    console.log(`                   0x${honest.toString(16).padStart(2, '0')} -> 0x${submittedProof[offset]!.toString(16).padStart(2, '0')}`);
    console.log(`                   field: ${describeOffset(layout, offset)}`);
    console.log(`                   layout check: model ${modelled.toLocaleString()} bytes = proof ${proofBytes.length.toLocaleString()} bytes`);
    console.log('                   public inputs intact');
  }

  if (DRY) {
    console.log('\n  --dry-run: nothing was submitted.');
    return;
  }

  const programId = new PublicKey(DEFAULT_STARK_VERIFIER_PROGRAM_ID);
  const payer = loadKeypair(KEYPAIR);
  const rpcUrl = CLUSTER === 'devnet' ? 'https://api.devnet.solana.com' : `https://api.${CLUSTER}.solana.com`;

  if (MODE !== 'honest') {
    await submitExpectingRejection(new RecordingConnection(rpcUrl, 'confirmed'), payer, programId, submittedProof, submittedInputs, predicted);
    return;
  }

  const connection = new Connection(rpcUrl, 'confirmed');

  const before = await connection.getBalance(payer.publicKey);
  console.log(`\n  cluster          ${CLUSTER}`);
  console.log(`  verifier         ${programId.toBase58()}`);
  console.log(`  authority        ${payer.publicKey.toBase58()}`);
  console.log(`  balance          ${(before / 1e9).toFixed(6)} SOL`);
  console.log(`  buffer PDA       ${getProofBufferPda(payer.publicKey, CIRCUIT_SPEND, programId)[0].toBase58()}\n`);

  const result = await uploadAndVerify(
    connection, payer, CIRCUIT_SPEND, proofBytes, publicInputs,
    { programId, retainBuffer: false, onProgress: (s) => console.log(`  · ${s}`) },
  );

  // ⛔ DO NOT STOP HERE. `uploadAndVerify` returning is the CLIENT's opinion.
  // The 2026-08-18 leak was found on a program dump, not deduced from a client
  // that reported success -- and 46d37ad9 fixed a client that reported success
  // on a half-verified proof. Ask the chain what happened.
  const tx = await connection.getTransaction(result.signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    console.error(`\nFAIL — the chain has no record of ${result.signature}.`);
    process.exit(1);
  }
  if (tx.meta?.err) {
    console.error(`\nFAIL — the phase-2 transaction reverted: ${JSON.stringify(tx.meta.err)}`);
    for (const l of tx.meta.logMessages ?? []) console.error(`    ${l}`);
    process.exit(1);
  }

  const logs = tx.meta?.logMessages ?? [];
  const success = logs.some((l) => l === `Program ${programId.toBase58()} success`);
  const cu = logs.find((l) => l.includes('consumed'));

  console.log(`\n  signature        ${result.signature}`);
  console.log(`  slot             ${tx.slot}`);
  console.log(`  verifier log     ${success ? 'success' : 'NO SUCCESS LINE'}`);
  if (cu) console.log(`  ${cu.trim()}`);

  const after = await connection.getBalance(payer.publicKey);
  console.log(`  cost             ${((before - after) / 1e9).toFixed(6)} SOL`
    + ` (rent recovered: buffer closed)`);

  if (!success) {
    console.error('\nFAIL — the transaction landed but the verifier never logged success.');
    process.exit(1);
  }

  console.log('\n  VERDICT: the deployed verifier ACCEPTED a circuit-7 proof from the shipped blob.');
  console.log('  Record it in packages/stark-prover/deployed-verifier.json as');
  console.log('  deployed.accepts_client_blob_sha256.');
}

/**
 * The adversarial submission. Runs the SAME `uploadAndVerify` the honest mode
 * runs — same init, resize, chunking, phase 1, phase 2 — with preflight off,
 * then decides from the ledger, closes the PDA, and reads it back.
 */
async function submitExpectingRejection(
  connection: RecordingConnection,
  payer: Keypair,
  programId: PublicKey,
  proof: Uint8Array,
  inputs: bigint[],
  predicted: string,
): Promise<void> {
  const [pda] = getProofBufferPda(payer.publicKey, CIRCUIT_SPEND, programId);
  const before = await connection.getBalance(payer.publicKey);
  console.log(`\n  cluster          ${CLUSTER}`);
  console.log(`  verifier         ${programId.toBase58()}`);
  console.log(`  authority        ${payer.publicKey.toBase58()}`);
  console.log(`  balance          ${(before / 1e9).toFixed(6)} SOL`);
  console.log(`  buffer PDA       ${pda.toBase58()}`);
  console.log(`  preflight        skipped, so the rejection lands and is recorded`);
  if (predicted) console.log(`  predicted        ${predicted}`);
  console.log('');

  let thrown: unknown = null;
  try {
    await uploadAndVerify(
      connection, payer, CIRCUIT_SPEND, proof, inputs,
      { programId, retainBuffer: false, onProgress: (s) => console.log(`  · ${s}`) },
    );
  } catch (e) {
    thrown = e;
    // Not always an Error: one run threw a plain object from the RPC layer
    // (printed as "[object Object]"); the ledger, not this line, is the verdict.
    console.log(`  · client threw: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  }

  // The failing transaction is the last one the client sent: `uploadAndVerify`
  // stops at the first error. Taken BEFORE the close below, which goes through
  // the same recording connection and would otherwise become "the last one" --
  // MEASURED 2026-09-02: the first --tamper run analysed its own close tx.
  const failSig = connection.sent[connection.sent.length - 1];

  // Rent first, verdict second: whatever happened above, the PDA must not
  // outlive this run. `uploadAndVerify` only closes after a phase-2 success.
  const closed = await closeBufferAndReadBack(connection, payer, pda, programId);
  const after = await connection.getBalance(payer.publicKey);

  if (!thrown) {
    console.error(`\n  cost             ${((before - after) / 1e9).toFixed(6)} SOL`);
    console.error(`\n  VERDICT: the deployed verifier ACCEPTED a --${MODE} submission through both phases.`);
    console.error('  That is a soundness failure of the DEPLOYED program. Do not close this as a gate; open it as an incident.');
    console.error(`  transactions: ${connection.sent.join(' ')}`);
    process.exit(2);
  }

  // Which instruction failed is read from the ledger, not inferred from the
  // exception the client threw.
  const tx = failSig ? await fetchTransaction(connection, failSig) : null;
  if (!failSig || !tx) {
    console.error(`\nFAIL — the client threw but the chain has no record of ${failSig ?? '(nothing was sent)'}.`);
    console.error('       Nothing was measured against the deployed program.');
    process.exit(1);
  }

  const ix = verifierInstruction(tx, programId);
  const err = describeError(tx.meta?.err);
  const logs = tx.meta?.logMessages ?? [];
  const anchorLine = logs.find((l) => l.includes('AnchorError'));
  const stepMarkers = logs.filter((l) => /\[verify\] step[0-9ab.]+ ok/.test(l));
  const lastOk = stepMarkers[stepMarkers.length - 1];
  const detail = logs.filter((l) => l.includes('[verify]') && !/ ok$/.test(l));
  const cuLine = logs.find((l) => l.includes('consumed'));

  console.log(`\n  signature        ${failSig}`);
  console.log(`  slot             ${tx.slot}`);
  console.log(`  instruction      ${ix ?? 'NOT A VERIFIER INSTRUCTION'}`
    + (ix === 'verifyStarkProofV2' ? ' (phase 1)' : ix === 'verifyDeepAliPhase2' ? ' (phase 2)' : ''));
  console.log(`  error            ${tx.meta?.err ? err.text : 'NONE — the transaction succeeded'}`);
  if (anchorLine) console.log(`  verifier log     ${anchorLine.replace(/^Program log: /, '')}`);
  console.log(`  last step ok     ${lastOk ? lastOk.replace(/^Program log: /, '') : '(none — failed before step 1)'}`);
  for (const l of detail) console.log(`  detail           ${l.replace(/^Program log: /, '')}`);
  if (cuLine) console.log(`  ${cuLine.trim()}`);
  if (tx.meta?.computeUnitsConsumed !== undefined) console.log(`  CU (meta)        ${tx.meta.computeUnitsConsumed.toLocaleString()}`);
  console.log(`  transactions     ${connection.sent.length} sent this run`);
  console.log(`  buffer           ${closed.stillOpen
    ? `STILL OPEN at ${pda.toBase58()} — RENT NOT RECOVERED`
    : `closed${closed.signature ? ` in ${closed.signature}` : ' (already gone)'}; getAccountInfo(pda) = null, rent recovered`}`);
  console.log(`  cost             ${((before - after) / 1e9).toFixed(6)} SOL`);

  const isVerifyIx = ix === 'verifyStarkProofV2' || ix === 'verifyDeepAliPhase2';
  const isInvalidProof = err.custom === 6003;
  if (!tx.meta?.err || !isVerifyIx || !isInvalidProof) {
    console.error(`\nFAIL — the run did not end in the verifier refusing the ${MODE === 'tamper' ? 'inputs' : 'proof'}.`);
    console.error('       A rejection for any other reason (upload, budget, account state) measures nothing about soundness.');
    process.exit(1);
  }
  if (closed.stillOpen) {
    console.error('\nFAIL — rejected as expected, but the proof buffer is still open. Close it before calling this green.');
    process.exit(1);
  }

  const where = `${ix === 'verifyStarkProofV2' ? 'phase 1' : 'phase 2'}${lastOk ? `, after ${lastOk.replace(/^Program log: \[verify\] /, '')}` : ''}`;
  console.log(`\n  VERDICT: the deployed verifier REJECTED the --${MODE} submission with InvalidProof in ${where}.`);
  if (predicted) {
    const asPredicted = MODE === 'tamper'
      ? detail.some((l) => l.includes('OOD z mismatch'))
      : ix === 'verifyStarkProofV2' && lastOk?.includes('step2 ok') === true;
    console.log(`  ${asPredicted ? 'As predicted' : 'NOT where predicted'}: ${predicted}`);
  }
  console.log(`  What this does not prove is in the header of this file. Read it before quoting.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
