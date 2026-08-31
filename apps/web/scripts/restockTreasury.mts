/**
 * Deposit notes the TREASURY can actually open — the restock that was missing.
 *
 * 🚨 THE BUG THIS EXISTS TO FIX, DIAGNOSED 2026-08-31. The old restock went
 * through the worker's `poolDeriveIdentity`, which derives a seed from a WALLET
 * SIGNATURE plus an origin. `issue-note` reads a FIXED seed out of
 * `P01_TREASURY_POOL_SEED`. Those two can never agree unless a human copies one
 * into the other, and nobody did — so ten notes were deposited at leaves 83-92,
 * 10 SOL of real value, owned by a seed the issuing route does not have. They
 * sit on the tree, spendable by nobody who asks that route.
 *
 * This script derives from the CONFIGURED seed and nothing else, so a note it
 * deposits is a note `issue-note` can hand over — by construction, not by
 * bookkeeping.
 *
 * ⛔ IT MOVES REAL DEVNET SOL and does nothing without `--go`.
 *
 *   cd apps/web
 *   npx tsx scripts/restockTreasury.mts --count 3          # says what it would do
 *   npx tsx scripts/restockTreasury.mts --count 3 --go     # does it
 */
import './../lib/privacy/pool/liveWorkerShim';

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import {
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  getPoolsForTokenV3,
  pubkeyToField,
} from '../lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '../lib/privacy/pool/noteBlinding';
import { prepareContribution, executeContribution } from '../lib/privacy/pool/shieldEphemeral';

const GO = process.argv.includes('--go');
const argOf = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const COUNT = Math.max(1, Number(argOf('--count', '1')));

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

async function main() {
  const e = env();
  const hex = e.P01_TREASURY_POOL_SEED;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('P01_TREASURY_POOL_SEED is missing or malformed in .env.local');
  }
  const seed = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  const denomination = Number(e.P01_TREASURY_NOTE_DENOMINATION ?? '0.1');
  const pool = getPoolsForTokenV3('SOL').find((p) => p.denomination === denomination);
  if (!pool) throw new Error(`no ${denomination} SOL pool is configured`);
  if (pool.deposits !== 'open') {
    throw new Error(`the ${denomination} SOL pool is closed to deposits`);
  }

  const rpc = e.P01_FUNDER_RPC || 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, 'confirmed');
  const genesis = await connection.getGenesisHash();
  if (genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') {
    throw new Error(`refusing to run against a non-devnet chain (genesis ${genesis})`);
  }

  const path = (process.env.P01_LIVE_KEYPAIR ?? `${homedir()}/.config/solana/id.json`).replace(
    /^~/,
    homedir(),
  );
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  const balance = await connection.getBalance(payer.publicKey);

  console.log(`pool        ${pool.poolPDA.toBase58()}  (${denomination} SOL, deposits open)`);
  console.log(`payer       ${payer.publicKey.toBase58()}  ${(balance / 1e9).toFixed(4)} SOL`);
  console.log(`depositing  ${COUNT} note(s) the CONFIGURED seed can open\n`);

  for (let n = 0; n < COUNT; n += 1) {
    // Read the tree every round: the index moves as we deposit, and a stale
    // counter derives a note at an index this insert will not occupy.
    const commitments = await fetchPoolCommitments(connection, pool.poolPDA);
    let maxLeaf = -1;
    for (const c of commitments.values()) if (c.leafIndex > maxLeaf) maxLeaf = c.leafIndex;
    const leafIndex = maxLeaf + 1;

    const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, leafIndex);
    const commitment = createCommitmentV3(
      nullifierPreimage,
      secret,
      deriveNoteBlinding(seed, pool.poolPDA, leafIndex),
      pubkeyToField(pool.tokenMint),
    );

    console.log(`[${n + 1}/${COUNT}] leaf ${leafIndex} · commitment ${commitment.toString().slice(0, 22)}…`);

    // ⛔ `payer.secretKey.slice(0,32)` is the CONTRIBUTOR seed, and it derives the
    // throwaway ephemeral ONLY. The note is the treasury's — see the commitment
    // above, which came from the configured seed and nothing else.
    const ctx = await prepareContribution(
      pool,
      connection,
      payer.secretKey.slice(0, 32),
      commitment,
      leafIndex,
      (s) => console.log(`        … ${s}`),
    );

    if (!GO) {
      console.log(`        DRY RUN — needs ${(ctx.requiredLamports / 1e9).toFixed(6)} SOL`);
      console.log(`        of which ${(ctx.valueLamports / 1e9).toFixed(6)} never returns.`);
      console.log('        Re-run with --go to deposit.');
      return;
    }
    if (balance < ctx.requiredLamports + 10_000_000) {
      throw new Error(
        `payer holds ${(balance / 1e9).toFixed(4)} SOL, this note needs about ` +
          `${((ctx.requiredLamports + 10_000_000) / 1e9).toFixed(4)}`,
      );
    }

    const fund = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: ctx.ephemeral.publicKey,
        lamports: ctx.requiredLamports,
      }),
    );
    await sendAndConfirmTransaction(connection, fund, [payer], { commitment: 'confirmed' });

    const done = await executeContribution(ctx, connection, payer.publicKey, (s) =>
      console.log(`        … ${s}`),
    );
    console.log(`        ✅ leaf ${done.leafIndex} · ${done.txSig}\n`);
  }

  if (GO) {
    console.log('Done. Now run:  npx tsx scripts/findTreasuryLeaves.mts');
    console.log('It reads the tree and lists every leaf this seed can open — the issuing');
    console.log('route discovers the same set, so nothing has to be written down anywhere.');
  }
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
