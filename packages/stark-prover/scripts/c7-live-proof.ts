/**
 * c7-live-proof.ts — submit a proof from the SHIPPED blob to the DEPLOYED
 * verifier, and read the answer back off the chain.
 *
 *   npx tsx packages/stark-prover/scripts/c7-live-proof.ts --dry-run
 *   npx tsx packages/stark-prover/scripts/c7-live-proof.ts
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
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import { initStarkWasm } from '../src/wasm-loader';
import { uploadAndVerify, getProofBufferPda } from '../src/upload-protocol';
import { DEFAULT_STARK_VERIFIER_PROGRAM_ID } from '../src/types';

const CIRCUIT_SPEND = 7;
/** `stark/src/air/spend.rs` CANONICAL_DEPTH — C7's subtree is 12, not the pool's 15. */
const CANONICAL_DEPTH = 12;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = args.includes('--dry-run');
const CLUSTER = flag('cluster') ?? 'devnet';
const KEYPAIR = flag('keypair') ?? join(homedir(), '.config', 'solana', 'id.json');

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

async function main(): Promise<void> {
  console.log('=== C7 live proof =========================================');

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

  if (DRY) {
    console.log('\n  --dry-run: nothing was submitted.');
    return;
  }

  const programId = new PublicKey(DEFAULT_STARK_VERIFIER_PROGRAM_ID);
  const payer = loadKeypair(KEYPAIR);
  const connection = new Connection(
    CLUSTER === 'devnet' ? 'https://api.devnet.solana.com' : `https://api.${CLUSTER}.solana.com`,
    'confirmed',
  );

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

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
