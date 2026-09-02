/**
 * Walk the whole mixer loop once, and print the one line that proves it works.
 *
 *   reserve  ->  pay the till  ->  the float funds an ephemeral  ->  deposit a
 *   leaf you do NOT own  ->  confirm (signed)  ->  collect
 *
 * WHAT IT DEMONSTRATES. The leaf you contribute and the leaf you receive are
 * DIFFERENT, and the one you receive was deposited by somebody else long before
 * you arrived. That is the whole claim: a chain reader who walks your future
 * spend back to its deposit lands on a transaction you were not in.
 *
 * IT RUNS THE PRODUCTION TOPOLOGY, since 2026-09-02. The payer pays the TILL
 * (and the operator fee wallet, in the same transaction), and the FLOAT funds
 * the depositing ephemeral through `/api/relay-to-buyer`, which binds the
 * payment to the reserved leaf. It used to fund the ephemeral directly as a
 * shortcut; `confirm` now refuses a leaf that no relayed payment funded, and
 * requires the payer to sign the claim challenge, so the shortcut no longer
 * confirms anything.
 *
 * IT MOVES REAL DEVNET SOL and does nothing without `--go`. The payer sends
 * the denomination plus the pool's 0.3 percent to the till and 1 percent to
 * the fee wallet; the float fronts the proof rent and sweeps it back to itself.
 * The denomination does NOT come back: it becomes the treasury's note, which
 * is the point.
 *
 *   cd apps/web
 *   npx tsx scripts/contributeAndCollect.mts                 # says what it would do
 *   npx tsx scripts/contributeAndCollect.mts --go            # does it
 *   npx tsx scripts/contributeAndCollect.mts --go --base https://...  # against prod
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import nacl from 'tweetnacl';

import { getPoolsForTokenV3, decodeShareableNote } from '../lib/privacy/pool/denominatedPool';
import { prepareContribution, executeContribution } from '../lib/privacy/pool/shieldEphemeral';
import { createNoteEncryptionAddress, decryptNote } from '../lib/privacy/pool/noteCrypto';
import { claimChallenge } from '../lib/privacy/claimChallenge';

const GO = process.argv.includes('--go');
const argOf = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = argOf('--base', 'http://127.0.0.1:3000').replace(/\/$/, '');

/**
 * Mirrors `OPERATOR_FEE_BPS` in `lib/privacy/pool/ephemeralFunder.ts`: one
 * percent of the denomination, in atoms. The relay refuses a fee below
 * floor(received * 99 / 10000), so this is what an honest client sends.
 * Not imported: that module is written for the browser.
 */
const OPERATOR_FEE_BPS = 100n;

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

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json as Record<string, unknown>;
}

/** The float's transfer may be reported before it is confirmed; wait for it to land. */
async function waitForFunding(connection: Connection, key: PublicKey, needed: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const held = await connection.getBalance(key, 'confirmed');
    if (held >= needed) return;
    if (Date.now() > deadline) {
      throw new Error(`the ephemeral holds ${held} of the ${needed} lamports the relay said it sent`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
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

  // Who to pay. Read from the relay rather than from the env, because the relay
  // is what measures the payment: an address it does not collect at is a
  // payment it refuses, after the money has moved.
  const terms = await get('/api/relay-to-buyer');
  if (terms.ready !== true) {
    const reasons = Array.isArray(terms.reasons) ? terms.reasons.join(' ') : '';
    throw new Error(`the relay cannot serve: ${reasons || 'no reason given'}`);
  }
  const till = new PublicKey(String(terms.till));
  const feeWallet = new PublicKey(String(terms.feeWallet));
  const feeLamports = Number((pool.denominationAtomic * OPERATOR_FEE_BPS) / 10_000n);

  console.log(`base          ${BASE}`);
  console.log(`pool          ${pool.poolPDA.toBase58()}  (${denomination} SOL, deposits ${pool.deposits})`);
  console.log(`payer         ${payer.publicKey.toBase58()}  ${(balance / 1e9).toFixed(4)} SOL`);
  console.log(`till          ${till.toBase58()}`);
  console.log(`fee wallet    ${feeWallet.toBase58()}`);
  console.log(`note address  ${recipientAddress.slice(0, 28)}...\n`);

  // ── 1. reserve ────────────────────────────────────────────────────────────
  const reserved = await post('/api/contribute-note', { action: 'reserve', token: 'SOL' }, ticket);
  const leafIndex = Number(reserved.leafIndex);
  const commitment = BigInt(String(reserved.commitment));
  console.log(`1. reserved   leaf ${leafIndex}, commitment ${commitment.toString().slice(0, 20)}...`);
  console.log(`              this commitment is the TREASURY's: you cannot spend what you deposit\n`);

  // ── 2. prove the insert ───────────────────────────────────────────────────
  const ctx = await prepareContribution(
    pool,
    connection,
    contributorSeed,
    commitment,
    leafIndex,
    (s) => console.log(`   ... ${s}`),
  );
  const outlay = ctx.valueLamports + feeLamports;
  console.log(`2. proved     the float will front ${(ctx.requiredLamports / 1e9).toFixed(6)} SOL`);
  console.log(`              you pay the till ${(ctx.valueLamports / 1e9).toFixed(6)} SOL (never returns)`);
  console.log(`              and the fee wallet ${(feeLamports / 1e9).toFixed(6)} SOL`);
  console.log(`              ephemeral ${ctx.ephemeral.publicKey.toBase58()}\n`);

  if (!GO) {
    console.log('DRY RUN: nothing was paid, nothing was deposited. Re-run with --go.');
    console.log(`Needs ${(outlay / 1e9).toFixed(4)} SOL on the payer; it has ${(balance / 1e9).toFixed(4)}.`);
    return;
  }
  if (balance < outlay + 10_000_000) {
    throw new Error(
      `payer holds ${(balance / 1e9).toFixed(4)} SOL, needs about ` +
        `${((outlay + 10_000_000) / 1e9).toFixed(4)}`,
    );
  }

  // ── 3. pay the till, and the fee, in one transaction ──────────────────────
  //
  // The payer is named here, once, against the till. It is NOT named against
  // the ephemeral: the float does that leg, so no address stands in both.
  console.log('3. paying the till...');
  const pay = new Transaction()
    .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: till, lamports: ctx.valueLamports }))
    .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: feeWallet, lamports: feeLamports }));
  const paySig = await sendAndConfirmTransaction(connection, pay, [payer], { commitment: 'confirmed' });
  console.log(`   ${paySig}\n`);

  // ── 4. the float funds the ephemeral, and binds the payment to the leaf ───
  console.log('4. asking the float to fund the ephemeral...');
  const relayed = await post(
    '/api/relay-to-buyer',
    {
      paymentSignature: paySig,
      buyerPubkey: ctx.ephemeral.publicKey.toBase58(),
      requiredLamports: ctx.requiredLamports,
      contribution: { token: 'SOL', leafIndex },
    },
    ticket,
  );
  console.log(`   ${relayed.signature}  (bound: ${relayed.contribution ?? 'nothing'})`);
  await waitForFunding(connection, ctx.ephemeral.publicKey, ctx.requiredLamports);
  const sweepTo = new PublicKey(String(relayed.funder ?? terms.funder));
  console.log(`   residue sweeps to the float ${sweepTo.toBase58()}\n`);

  // ── 5. deposit ────────────────────────────────────────────────────────────
  console.log("5. depositing the treasury's commitment...");
  const done = await executeContribution(ctx, connection, sweepTo, (s) => console.log(`   ... ${s}`));
  console.log(`   ${done.txSig}\n`);

  // ── 6. confirm, which mints the claim ─────────────────────────────────────
  //
  // Signed: the claim goes only to whoever can sign as the wallet that paid.
  const proof = Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(claimChallenge(paySig), 'utf8')), payer.secretKey),
  ).toString('base64');
  const confirmed = await post(
    '/api/contribute-note',
    { action: 'confirm', token: 'SOL', leafIndex, paymentSignature: paySig, proof },
    ticket,
  );
  const claimCode = String(confirmed.claimCode);
  console.log(`6. confirmed  claim ${claimCode.slice(0, 12)}...${confirmed.replayed ? ' (replayed)' : ''}\n`);

  // ── 7. collect a DIFFERENT note ───────────────────────────────────────────
  const issued = await post(
    '/api/issue-note',
    { claimCode, recipientAddress, token: 'SOL', denomination },
    ticket,
  );
  const note = decodeShareableNote(
    new TextDecoder().decode(decryptNote(noteSeed, String(issued.sealedNote))),
  );

  console.log('-'.repeat(72));
  console.log(`you contributed   leaf ${leafIndex}`);
  console.log(`you received      leaf ${note.leafIndex}`);
  console.log('-'.repeat(72));
  if (note.leafIndex === leafIndex) {
    console.log('THE SAME LEAF CAME BACK. The maturity gate did not hold, and the note you');
    console.log('received is the one you just funded, which links your spend to your deposit.');
    process.exitCode = 1;
    return;
  }
  console.log('Different leaves. The note you now hold was deposited before you arrived, by a');
  console.log('transaction you were not in. Walk it on chain:');
  console.log(`  node verify/p01-verify.mjs --spend <your future spend> --wallet ${payer.publicKey.toBase58()}`);
}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
