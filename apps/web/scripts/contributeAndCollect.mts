/**
 * Walk the whole mixer loop once, and print the one line that proves it works.
 *
 *   reserve  ->  deposit a leaf you do NOT own  ->  confirm  ->  collect
 *
 * 🎯 WHAT IT DEMONSTRATES. The leaf you contribute and the leaf you receive are
 * DIFFERENT, and the one you receive was deposited by somebody else long before
 * you arrived. That is the whole claim: a chain reader who walks your future
 * spend back to its deposit lands on a transaction you were not in.
 *
 * ⛔ IT MOVES REAL DEVNET SOL and does nothing without `--go`. A contribution
 * pre-funds an ephemeral with roughly the denomination plus proof-buffer rent,
 * and the rent comes back on sweep while the denomination does NOT — it becomes
 * the treasury's note, which is the point.
 *
 *   cd apps/web
 *   npx tsx scripts/contributeAndCollect.mts                 # says what it would do
 *   npx tsx scripts/contributeAndCollect.mts --go            # does it
 *   npx tsx scripts/contributeAndCollect.mts --go --base https://…  # against prod
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { getPoolsForTokenV3, decodeShareableNote } from '../lib/privacy/pool/denominatedPool';
import { prepareContribution, executeContribution } from '../lib/privacy/pool/shieldEphemeral';
import { createNoteEncryptionAddress, decryptNote } from '../lib/privacy/pool/noteCrypto';

const GO = process.argv.includes('--go');
const argOf = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = argOf('--base', 'http://127.0.0.1:3000').replace(/\/$/, '');

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path.replace(/^~/, homedir()), 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function post(path: string, body: unknown, ticket: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': ticket },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json as Record<string, unknown>;
}

async function main() {
  const e = env();
  const ticket = e.P01_FUNDER_TICKET;
  if (!ticket) throw new Error('P01_FUNDER_TICKET is not set in .env.local');
  const denomination = Number(e.P01_TREASURY_NOTE_DENOMINATION ?? '0.1');
  const pool = getPoolsForTokenV3('SOL').find((p) => p.denomination === denomination);
  if (!pool) throw new Error(`no ${denomination} SOL pool is configured`);
  if (pool.deposits !== 'open') {
    throw new Error(`the ${denomination} SOL pool is closed to deposits; a contribution is a deposit`);
  }

  const connection = new Connection(e.P01_FUNDER_RPC || 'https://api.devnet.solana.com', 'confirmed');
  const genesis = await connection.getGenesisHash();
  if (genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') {
    throw new Error(`refusing to run against a non-devnet chain (genesis ${genesis})`);
  }

  const payer = loadKeypair(process.env.P01_LIVE_KEYPAIR ?? `${homedir()}/.config/solana/id.json`);
  const balance = await connection.getBalance(payer.publicKey);

  // The seeds this run uses. Deterministic from the payer so a retry sweeps the
  // same ephemeral instead of stranding the last one.
  const contributorSeed = sha256(payer.secretKey.slice(0, 32));
  const noteSeed = sha256(contributorSeed);
  const recipientAddress = createNoteEncryptionAddress(noteSeed);

  console.log(`base          ${BASE}`);
  console.log(`pool          ${pool.poolPDA.toBase58()}  (${denomination} SOL, deposits ${pool.deposits})`);
  console.log(`payer         ${payer.publicKey.toBase58()}  ${(balance / 1e9).toFixed(4)} SOL`);
  console.log(`note address  ${recipientAddress.slice(0, 28)}…\n`);

  // ── 1. reserve ────────────────────────────────────────────────────────────
  const reserved = await post('/api/contribute-note', { action: 'reserve', token: 'SOL' }, ticket);
  const leafIndex = Number(reserved.leafIndex);
  const commitment = BigInt(String(reserved.commitment));
  console.log(`1. reserved   leaf ${leafIndex}, commitment ${commitment.toString().slice(0, 20)}…`);
  console.log(`              ⛔ this commitment is the TREASURY's — you cannot spend what you deposit\n`);

  // ── 2. prove the insert ───────────────────────────────────────────────────
  const ctx = await prepareContribution(
    pool,
    connection,
    contributorSeed,
    commitment,
    leafIndex,
    (s) => console.log(`   … ${s}`),
  );
  console.log(`2. proved     pre-fund ${(ctx.requiredLamports / 1e9).toFixed(6)} SOL`);
  console.log(`              of which value (never returns) ${(ctx.valueLamports / 1e9).toFixed(6)} SOL`);
  console.log(`              ephemeral ${ctx.ephemeral.publicKey.toBase58()}\n`);

  if (!GO) {
    console.log('DRY RUN — nothing was funded, nothing was deposited. Re-run with --go.');
    console.log(`Needs ${(ctx.requiredLamports / 1e9).toFixed(4)} SOL on the payer; it has ${(balance / 1e9).toFixed(4)}.`);
    return;
  }
  if (balance < ctx.requiredLamports + 10_000_000) {
    throw new Error(
      `payer holds ${(balance / 1e9).toFixed(4)} SOL, needs about ` +
        `${((ctx.requiredLamports + 10_000_000) / 1e9).toFixed(4)}`,
    );
  }

  // ── 3. fund the ephemeral ─────────────────────────────────────────────────
  //
  // ⚠️ THE PAYER IS NAMED HERE, AND ON A REAL RUN IT MUST NOT BE THE USER'S
  // WALLET. In production this leg is `wallet -> till` and `float -> ephemeral`,
  // two transfers with no address in both. This script funds directly because it
  // is a harness: the property it demonstrates is which LEAF you receive, not
  // who paid for the one you contributed.
  console.log('3. funding the ephemeral…');
  const fund = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: ctx.ephemeral.publicKey,
      lamports: ctx.requiredLamports,
    }),
  );
  const fundSig = await sendAndConfirmTransaction(connection, fund, [payer], { commitment: 'confirmed' });
  console.log(`   ${fundSig}\n`);

  // ── 4. deposit ────────────────────────────────────────────────────────────
  console.log('4. depositing the treasury\'s commitment…');
  const done = await executeContribution(ctx, connection, payer.publicKey, (s) => console.log(`   … ${s}`));
  console.log(`   ${done.txSig}\n`);

  // ── 5. confirm, which mints the claim ─────────────────────────────────────
  const confirmed = await post('/api/contribute-note', { action: 'confirm', token: 'SOL', leafIndex }, ticket);
  const claimCode = String(confirmed.claimCode);
  console.log(`5. confirmed  claim ${claimCode.slice(0, 12)}…\n`);

  // ── 6. collect a DIFFERENT note ───────────────────────────────────────────
  const issued = await post(
    '/api/issue-note',
    { claimCode, recipientAddress, token: 'SOL', denomination },
    ticket,
  );
  const note = decodeShareableNote(
    new TextDecoder().decode(decryptNote(noteSeed, String(issued.sealedNote))),
  );

  console.log('─'.repeat(72));
  console.log(`you contributed   leaf ${leafIndex}`);
  console.log(`you received      leaf ${note.leafIndex}`);
  console.log('─'.repeat(72));
  if (note.leafIndex === leafIndex) {
    console.log('🚨 THE SAME LEAF CAME BACK. The maturity gate did not hold, and the note you');
    console.log('   received is the one you just funded — which links your spend to your deposit.');
    process.exitCode = 1;
    return;
  }
  console.log('✅ Different leaves. The note you now hold was deposited before you arrived, by a');
  console.log('   transaction you were not in. Walk it on chain:');
  console.log(`     node verify/p01-verify.mjs --spend <your future spend> --wallet ${payer.publicKey.toBase58()}`);
}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
