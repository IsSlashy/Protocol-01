/**
 * live-timing.ts — WALL-CLOCK of the STARK pipeline against the DEPLOYED verifier.
 *
 *   npx tsx packages/stark-prover/scripts/live-timing.ts --dry-run
 *   npx tsx packages/stark-prover/scripts/live-timing.ts                     # throwaway key, airdrop, C7 + C6
 *   npx tsx packages/stark-prover/scripts/live-timing.ts --circuit 6 --runs 3
 *   npx tsx packages/stark-prover/scripts/live-timing.ts --circuit 0,2,4,5 --v1   # the masked four, since 2026-09-12
 *   npx tsx packages/stark-prover/scripts/live-timing.ts --legacy            # the pre-L2 path, for A/B
 *   npx tsx packages/stark-prover/scripts/live-timing.ts --pacing fast       # waves 8 / 150 ms / one batch
 *   npx tsx packages/stark-prover/scripts/live-timing.ts --keypair path.json --rpc https://...
 *
 * # What it measures
 *
 * For a circuit-7 (spend: v4 withdraw, subscription) and a circuit-6 (merkle
 * update: shield) proof from the SHIPPED blob, the time from the start of
 * proving to the confirmed on-chain verification, with the buffer closed after:
 *
 *   prove | allocate | upload chunks | verify (phase 1 + 2) | close | TOTAL
 *
 * That is the whole STARK half of a shield / unshield / subscription. The pool
 * instruction that consumes the verified buffer is ONE more transaction and is
 * not sent here (it needs pool state and a funded note). Every figure comes
 * with the signatures that produced it, so it can be read back from the ledger.
 *
 * # What it does NOT measure
 *
 * The product wall clock a user sees (UI, worker hand-off, wallet prompts), or
 * the pool instruction that consumes the buffer. It runs against
 * the public devnet endpoint unless `--rpc` says otherwise, and the public
 * endpoint's rate limit is part of what it measures.
 *
 * # Keys
 *
 * By default a THROWAWAY keypair is generated and funded by airdrop (never the
 * founder's key). The 80 KB buffer wants ~0.57 SOL of rent for the duration
 * of the run; it is recovered when the buffer is closed. If the faucet refuses,
 * the address is printed so it can be funded by hand, and the script waits.
 */
import { readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import { initStarkWasm } from '../src/wasm-loader';
import {
  uploadAndVerify,
  deriveProofBufferKeypair,
  getProofBufferPda,
  type ChunkPacing,
} from '../src/upload-protocol';
import { DEFAULT_STARK_VERIFIER_PROGRAM_ID } from '../src/types';
import { makeV1ChunkUploader, V1_CHUNK_SIZE } from './v1-chunks';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = args.includes('--dry-run');
const LEGACY = args.includes('--legacy');
const NO_MERGE = args.includes('--no-merge');
// [TX-V1] chunks as 4,096-byte transaction-v1 envelopes (SIMD-0385), live on devnet.
const V1 = args.includes('--v1');
const V1_CHUNK = Number(flag('v1-chunk') ?? V1_CHUNK_SIZE);
const V1_WAVE = Number(flag('v1-wave') ?? 8);
const V1_WAVE_DELAY = Number(flag('v1-wave-delay') ?? 100);
const RPC = flag('rpc') ?? 'https://api.devnet.solana.com';
const RUNS = Number(flag('runs') ?? 1);
const CIRCUITS = (flag('circuit') ?? '7,6').split(',').map((c) => Number(c.trim()));
const PACING_NAME = flag('pacing') ?? 'default';
const PACINGS: Record<string, ChunkPacing> = {
  default: {},
  // MEASURED 2026-09-13 on api.devnet.solana.com: 8 / 150 ms dies on tx[19] with
  // "Too many requests for a specific RPC call" -- the public endpoint allows
  // about 40 sends per 10 s per method. `public` sits just under that (3.75/s)
  // and confirms once at the end instead of once per 20 chunks.
  fast: { waveSize: 8, waveDelayMs: 150, batchSize: Infinity },
  medium: { waveSize: 5, waveDelayMs: 400, batchSize: 40 },
  public: { waveSize: 3, waveDelayMs: 800, batchSize: Infinity },
  // For a private RPC without the per-method limit.
  private: { waveSize: 16, waveDelayMs: 50, batchSize: Infinity },
};
const PACING = PACINGS[PACING_NAME];
if (!PACING) {
  console.error(`FAIL — unknown --pacing ${PACING_NAME}; one of ${Object.keys(PACINGS).join(', ')}`);
  process.exit(1);
}

/** `stark/src/air/spend.rs` / `merkle_update.rs` CANONICAL_DEPTH — the circuits' subtree, not the pool's. */
const CANONICAL_DEPTH = 11;

interface Proof {
  circuitId: number;
  label: string;
  proofBytes: Uint8Array;
  publicInputs: bigint[];
  provingMs: number;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * [UNIFORM-MASK 2026-09-12] All eight circuits, the witnesses `bench_all_circuits.rs`
 * and `wasm_blob_parity.rs` drive. Public inputs are read back from the JSON in
 * the order the Rust `public_inputs` vector carries them (stark/src/lib.rs prints
 * them in that order), so the verify instruction sees what the prover committed.
 */
interface Drive {
  label: string;
  entry: string;
  args: () => Array<bigint | string>;
  pubs: (json: Record<string, unknown>) => bigint[];
}
const csvOf = (n: number, f: (i: number) => number): string => Array.from({ length: n }, (_, i) => String(f(i))).join(',');
const big = (v: unknown): bigint => BigInt(v as string | number);
const DRIVES: Record<number, Drive> = {
  0: { label: 'C0 subscriber_ownership (legacy subscription)', entry: 'generate_stark_proof', args: () => [42n], pubs: (j) => [big(j.commitment)] },
  1: { label: 'C1 pool_commitment (v3 shield pair)', entry: 'generate_pool_commitment_stark_proof', args: () => [111n, 222n, 333n, 444n], pubs: (j) => [big(j.nullifier), big(j.commitment)] },
  2: { label: 'C2 balance_proof', entry: 'generate_balance_stark_proof', args: () => [42n, 1000n, 777n, 999n], pubs: (j) => [big(j.commitment), big(j.token_mint)] },
  3: { label: 'C3 merkle_path (v3 unshield pair)', entry: 'generate_merkle_path_stark_proof', args: () => [777n, csvOf(CANONICAL_DEPTH, (i) => 1000 + i * 37), csvOf(CANONICAL_DEPTH, (i) => i % 2)], pubs: (j) => [big(j.leaf), big(j.root), big(j.depth)] },
  4: { label: 'C4 confidential_balance', entry: 'generate_confidential_balance_stark_proof', args: () => [42n, 1000n, 111n, 800n, 222n, 200n, 333n, 999n], pubs: (j) => [big(j.old_commitment), big(j.new_commitment), big(j.amount_hash), big(j.token_mint)] },
  5: { label: 'C5 transfer', entry: 'generate_transfer_stark_proof', args: () => [13n, 500n, 77n, 400n, 88n, 100n, 150n, 1234n, 555n, 65n, 2222n, 333n, 50n], pubs: (j) => [big(j.nullifier_1), big(j.nullifier_2), big(j.output_commitment_1), big(j.output_commitment_2), big(j.public_amount), big(j.token_mint)] },
  6: { label: 'C6 merkle update (shield)', entry: 'generate_merkle_update_stark_proof', args: () => [0n, 123456789n, csvOf(CANONICAL_DEPTH, (i) => 1000 + i * 7), csvOf(CANONICAL_DEPTH, (i) => i % 2)], pubs: (j) => [big(j.old_leaf), big(j.new_leaf), big(j.old_root), big(j.new_root), big(j.depth)] },
  7: { label: 'C7 spend (unshield v4, subscription)', entry: 'generate_spend_stark_proof', args: () => [11n, 22n, 33n, 44n, csvOf(CANONICAL_DEPTH, (i) => 1000 + i * 7), csvOf(CANONICAL_DEPTH, (i) => i % 2), '111111111,222222222,333333333,444444444'], pubs: (j) => [big(j.nullifier), big(j.root), ...(j.recipient_hash as string[]).map(big)] },
};

async function proveAll(): Promise<Proof[]> {
  const exports = await initStarkWasm() as unknown as Record<string, (...a: Array<bigint | string>) => string>;
  const proofs: Proof[] = [];
  for (const cid of CIRCUITS) {
    const d = DRIVES[cid];
    if (!d) throw new Error(`--circuit ${cid}: unknown circuit (0..7)`);
    const entry = exports[d.entry];
    if (typeof entry !== 'function') throw new Error(`the shipped blob does not export ${d.entry}`);
    const t0 = performance.now();
    const json = JSON.parse(entry(...d.args())) as Record<string, unknown> & { error?: string; proof_hex: string };
    const provingMs = Math.round(performance.now() - t0);
    if (json.error) throw new Error(`C${cid} prover refused: ${json.error}`);
    proofs.push({ circuitId: cid, label: d.label, proofBytes: hexToBytes(json.proof_hex), publicInputs: d.pubs(json), provingMs });
  }
  return proofs;
}

async function fundThrowaway(connection: Connection): Promise<Keypair> {
  const kp = Keypair.generate();
  console.log(`  throwaway key    ${kp.publicKey.toBase58()}`);
  const want = 1.2 * LAMPORTS_PER_SOL; // ~0.57 SOL rent for an 83 KB buffer + fees, twice over for two circuits
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sig = await connection.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
      const bh = await connection.getLatestBlockhash('confirmed');
      await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
      const bal = await connection.getBalance(kp.publicKey, 'confirmed');
      console.log(`  airdrop ${attempt}        ${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL  (${sig})`);
      if (bal >= want) return kp;
    } catch (e) {
      console.log(`  airdrop ${attempt}        refused: ${(e as Error).message.split('\n')[0]}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // Wait for a manual top-up rather than fail: the faucet is the flaky part.
  console.log(`\n  The faucet did not fund enough. Send >= ${(want / LAMPORTS_PER_SOL).toFixed(1)} SOL (devnet) to`);
  console.log(`  ${kp.publicKey.toBase58()}  — polling for 10 minutes.`);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const bal = await connection.getBalance(kp.publicKey, 'confirmed');
    if (bal >= want) {
      console.log(`  funded           ${(bal / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
      return kp;
    }
  }
  throw new Error('throwaway key never funded');
}

interface Stage { name: string; ms: number }

async function timeOne(connection: Connection, payer: Keypair, programId: PublicKey, proof: Proof, run: number) {
  const stages: Stage[] = [];
  let stageName = 'allocate';
  let stageStart = performance.now();
  const t0 = stageStart;
  const bump = (next: string) => {
    const now = performance.now();
    if (stages.length === 0 || stages[stages.length - 1]!.name !== stageName) {
      stages.push({ name: stageName, ms: Math.round(now - stageStart) });
    } else {
      stages[stages.length - 1]!.ms += Math.round(now - stageStart);
    }
    stageName = next;
    stageStart = now;
  };
  const onProgress = (s: string) => {
    if (/Uploading proof batch 1\/|Uploading proof batch/.test(s) && stageName === 'allocate') bump('upload');
    else if (/^Verifying/.test(s) && stageName !== 'verify') bump('verify');
    else if (/^Closing proof buffer/.test(s)) bump('close');
  };
  const v1 = V1 ? makeV1ChunkUploader({ rpcUrl: RPC, chunkSize: V1_CHUNK, waveSize: V1_WAVE, waveDelayMs: V1_WAVE_DELAY }) : null;
  const result = await uploadAndVerify(connection, payer, proof.circuitId, proof.proofBytes, proof.publicInputs, {
    programId,
    retainBuffer: false,
    onProgress,
    legacyBuffer: LEGACY,
    mergePhases: !NO_MERGE,
    chunkPacing: PACING,
    uploadChunks: v1
      ? (c, bytes, buf, auth, p, pid, prog) => {
          if (!('secretKey' in p)) throw new Error('--v1 needs a Keypair payer');
          return v1.upload(c, bytes, buf, auth, p as Keypair, pid, prog);
        }
      : undefined,
  });
  bump('end');
  const totalMs = Math.round(performance.now() - t0);

  const tx = await connection.getTransaction(result.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 1 });
  const logs = tx?.meta?.logMessages ?? [];
  const success = logs.some((l) => l === `Program ${programId.toBase58()} success`);
  const cu = logs.find((l) => l.includes('consumed'))?.trim() ?? '';
  const chunks = Math.ceil(proof.proofBytes.length / (v1 ? v1.chunkSize : 1000));
  console.log(`\n  [${proof.label}] run ${run}`);
  const v1Note = v1 ? ` (tx v1, ${v1.chunkSize} B each, largest wire ${v1.stats.maxWireBytes} B, ${v1.stats.resends} resent, send ${v1.stats.sendMs} ms + confirm ${v1.stats.confirmMs} ms)` : '';
  console.log(`    bytes ${proof.proofBytes.length.toLocaleString()}  chunks ${chunks}${v1Note}  path ${LEGACY ? 'legacy PDA' : 'L2 keypair'}  phases ${NO_MERGE ? 'split' : 'merged where allowed'}  pacing ${v1 ? `v1 ${V1_WAVE}/${V1_WAVE_DELAY}ms` : PACING_NAME}`);
  console.log(`    prove ${proof.provingMs} ms | ${stages.map((s) => `${s.name} ${s.ms} ms`).join(' | ')} | STARK pipeline ${totalMs} ms | prove + pipeline ${proof.provingMs + totalMs} ms`);
  console.log(`    verify tx ${result.verifySignatures.join(', ')}`);
  console.log(`    slot ${tx?.slot ?? '?'}  verifier ${success ? 'success' : 'NO SUCCESS LINE'}  ${cu}`);
  return { totalMs, stages, success, sig: result.signature, slot: tx?.slot };
}

async function main(): Promise<void> {
  console.log('=== STARK pipeline live timing =========================================');
  console.log(`  rpc              ${RPC.replace(/api-key=[^&]+/, 'api-key=<redacted>')}`);
  console.log(`  circuits         ${CIRCUITS.join(', ')}   runs ${RUNS}   path ${LEGACY ? 'legacy' : 'L2'}   pacing ${PACING_NAME}`);
  const proofs = await proveAll();
  for (const p of proofs) console.log(`  proved           ${p.label}: ${p.proofBytes.length.toLocaleString()} B in ${p.provingMs} ms (Node, shipped blob)`);
  if (DRY) {
    console.log('\n  --dry-run: nothing was submitted.');
    return;
  }
  const connection = new Connection(RPC, 'confirmed');
  const programId = new PublicKey(DEFAULT_STARK_VERIFIER_PROGRAM_ID);
  const kpPath = flag('keypair');
  const payer = kpPath
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kpPath, 'utf8')) as number[]))
    : await fundThrowaway(connection);
  const before = await connection.getBalance(payer.publicKey);
  console.log(`  verifier         ${programId.toBase58()}`);
  console.log(`  authority        ${payer.publicKey.toBase58()}   balance ${(before / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  for (const p of proofs) {
    console.log(`  buffer (${p.circuitId})       L2 ${deriveProofBufferKeypair(payer.publicKey, p.circuitId).publicKey.toBase58()}  PDA ${getProofBufferPda(payer.publicKey, p.circuitId, programId)[0].toBase58()}`);
  }

  const totals: Record<string, number[]> = {};
  for (let run = 1; run <= RUNS; run++) {
    for (const p of proofs) {
      const r = await timeOne(connection, payer, programId, p, run);
      (totals[p.label] ??= []).push(p.provingMs + r.totalMs);
      if (!r.success) console.error(`    FAIL — the verifier never logged success for ${p.label}`);
    }
  }
  const after = await connection.getBalance(payer.publicKey);
  console.log(`\n  cost             ${((before - after) / LAMPORTS_PER_SOL).toFixed(6)} SOL over ${RUNS} run(s) (rent recovered: buffers closed)`);
  console.log('\n  SUMMARY (prove + STARK pipeline, ms)');
  for (const [label, arr] of Object.entries(totals)) {
    const sorted = [...arr].sort((a, b) => a - b);
    console.log(`    ${label.padEnd(40)} min ${sorted[0]}  median ${sorted[Math.floor(sorted.length / 2)]}  max ${sorted[sorted.length - 1]}`);
  }
  console.log('\n  The pool instruction that consumes the buffer is one more transaction, not timed here.');
}

main().catch((e) => {
  console.error('\nFAIL —', e instanceof Error ? e.message : e);
  process.exit(1);
});
