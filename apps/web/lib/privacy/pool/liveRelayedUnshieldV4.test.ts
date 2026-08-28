/**
 * A withdrawal the buyer neither signs nor pays for.
 *
 * ⛔ INERT UNLESS `P01_LIVE_RELAYED=1`. It spends real devnet SOL, needs a
 * relayer node reachable at `P01_RELAYER_URL`, and takes minutes.
 *
 * WHY IT EXISTS
 * ─────────────
 * `liveDevnetUnshieldV4.test.ts` proves the v4 withdrawal lands and publishes no
 * field of the deposit. It says nothing about WHO paid, and its own header is
 * blunt about it: the wallet funds an ephemeral, so an RPC walk finds the buyer
 * one hop out. That is probe P11, the only `[open]` one left.
 *
 * This file exercises the other entry point.
 * `unshield_denominated_stark_v4_relayed` pays its submitter out of the protocol
 * fee the pool already charges, so a stranger can afford to send the
 * transaction and NO LAMPORT TRAVELS FROM THE BUYER TO THEM. There is no
 * pre-fund here, no ephemeral, and no sweep.
 *
 * 🚨 SAFE ONLY BECAUSE CIRCUIT 7 BINDS THE RECIPIENT. The proof names the payee
 * inside `public_inputs_hash`, so a relayer that re-points the payout
 * invalidates the proof it is relaying (`unshield_denominated_stark_v4.rs:577`).
 * Handing a v3 proof to a stranger was handing them the money, which is why the
 * worker refuses to relay one.
 *
 * WHAT IT MEASURES, and it is one line
 * ────────────────────────────────────
 * That the buyer's address appears in NO account key of the withdrawal. Not as
 * a signer, not as a payer, not as a writable account, not anywhere — because
 * `accountKeys` is what the cheapest real extraction reads, and P11 asks exactly
 * that question over four surfaces.
 *
 * ⚠️ THIS FILE ANSWERS ONE OF THE FOUR. P11 also walks the DEPOSIT payer's
 * history. A note deposited straight from the wallet still names the buyer
 * there, whatever this withdrawal does — so a green run here is necessary and
 * NOT sufficient, and `verify/p01-verify.mjs --wallet` is what settles the rest.
 * Point `P01_LIVE_LEAF` at a note from `liveRelayedShield.test.ts` for the full
 * question.
 *
 * Run:
 *   P01_LIVE_RELAYED=1 P01_RELAYER_URL=http://127.0.0.1:8790 \
 *     P01_LIVE_KEYPAIR=<a fresh buyer> \
 *     npx vitest run --config vitest.pool.config.mts \
 *       lib/privacy/pool/liveRelayedUnshieldV4.test.ts
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { buildDerivationMessage } from '../message';
import { configurePoolHandlers, handlePoolRequest } from '../worker/poolHandlers';

import './liveWorkerShim';

const LIVE = process.env.P01_LIVE_RELAYED === '1';
const RPC = process.env.P01_LIVE_RPC ?? 'https://api.devnet.solana.com';
const RELAYER_URL = process.env.P01_RELAYER_URL ?? 'http://127.0.0.1:8790';
/** The only denomination whose 0.5% fee covers the relayer reward. */
const DENOMINATION = 1;

const expandHome = (p: string) => (p.startsWith('~') ? p.replace(/^~/, homedir()) : p);
const log = (...a: unknown[]) => { /* eslint-disable-next-line no-console */ console.log(...a); };

/**
 * ⛔ NO `assertPayerNotPubliclyNamed` HERE, and its absence is the point.
 *
 * That guard exists because the DIRECT path pays with the wallet it is handed.
 * On this path the wallet pays nothing — the relayer is `accountKeys[0]` — so
 * the guard would be refusing a key that never reaches the chain. What matters
 * instead is that the buyer is a key the relayer's own funder has never named,
 * which is a property of the run's setup and is asserted on chain below.
 */
function loadBuyer(): Keypair {
  const path = expandHome(process.env.P01_LIVE_KEYPAIR ?? `${homedir()}/.config/solana/id.json`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

describe.skipIf(!LIVE)('a withdrawal the buyer neither signs nor pays for', () => {
  it('lands through a relayer, and names the buyer nowhere on chain', async () => {
    const buyer = loadBuyer();
    const connection = new Connection(RPC, 'confirmed');
    configurePoolHandlers(RPC);

    // The relayer says who it is; the client never carries its key in config.
    const health = await (await fetch(`${RELAYER_URL}/health`)).json();
    const operator = new PublicKey(health.operator);
    log(`buyer    ${buyer.publicKey.toBase58()}`);
    log(`relayer  ${operator.toBase58()} at ${RELAYER_URL}`);
    expect(operator.equals(buyer.publicKey), 'the buyer cannot be its own relayer').toBe(false);

    const meta = 'live-relayed-unshield-v4';
    const message = buildDerivationMessage({
      walletPubkey: buyer.publicKey.toBase58(),
      origin: 'http://localhost:3000',
      chainTag: 'solana:devnet',
    });
    const signature = nacl.sign.detached(new TextEncoder().encode(message), buyer.secretKey);
    await handlePoolRequest({ kind: 'poolDeriveIdentity', meta, signature: Array.from(signature) });

    // A note this identity already owns. Deposited how, is this file's caller's
    // business — a wallet-funded one measures the withdrawal surface alone, a
    // relayed one measures both. `P01_LIVE_LEAF` is how the caller says which.
    let leafIndex: number | null =
      process.env.P01_LIVE_LEAF !== undefined ? Number(process.env.P01_LIVE_LEAF) : null;
    if (leafIndex === null) {
      const scan = await handlePoolRequest(
        { kind: 'poolScan', meta, token: 'SOL', denomination: DENOMINATION },
        (st: string) => log('  scan:', st),
      );
      const usable = (scan.notes ?? []).find(
        (n: { spent: boolean; spentChecked?: boolean; leafIndex: number }) =>
          !n.spent && n.spentChecked !== false,
      );
      expect(usable, 'this identity owns no unspent 1 SOL note — deposit one first').toBeTruthy();
      leafIndex = usable!.leafIndex;
    }
    log(`  spending leaf ${leafIndex}`);

    // A payee unrelated to the buyer on chain: paying the funding wallet would
    // re-create the very edge this path removes.
    const payeeSeed = sha256(concatBytes(
      buyer.secretKey.slice(0, 32), utf8ToBytes('p01:relayed-harness-payee:v1'),
    ));
    const payee = Keypair.fromSeed(payeeSeed).publicKey;
    const before = await connection.getBalance(payee);

    const prep = await handlePoolRequest({
      kind: 'poolUnshieldPrepare',
      meta,
      token: 'SOL',
      denomination: DENOMINATION,
      leafIndex: leafIndex!,
      recipient: payee.toBase58(),
      ownerPubkey: buyer.publicKey.toBase58(),
    });
    expect(prep.version).toBe('v4');
    log(`  route ${prep.version} | job ${prep.jobId}`);

    // ⛔ NOTHING IS SENT TO THE EPHEMERAL. The direct path funds one here; this
    // one does not, and that omission is the whole mechanism.
    const buyerBefore = await connection.getBalance(buyer.publicKey);

    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: payee.toBase58(),
      ownerPubkey: buyer.publicKey.toBase58(),
      relayerUrl: RELAYER_URL,
    }, (st: string) => log('  relay:', st));
    const sig = done.txSig;
    log('  RELAYED WITHDRAWAL LANDED:', sig);

    // ------------------------------------------------- ask the chain, not us
    const tx = await connection.getTransaction(sig, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
    expect(tx, 'the chain has no record of the withdrawal').not.toBeNull();
    expect(tx!.meta?.err, JSON.stringify(tx!.meta?.logMessages ?? [])).toBeNull();

    // ------------------------------------------------------- THE MEASUREMENT
    // 🚨 The buyer appears in NO account key. `accountKeys` is what the cheapest
    // real extraction prints — an address can sit there read-only, move not one
    // lamport, and still be the first line of somebody's grep.
    const keys = tx!.transaction.message.staticAccountKeys ?? [];
    const names = keys.map((k) => k.toBase58());
    expect(names, 'the buyer is named in the withdrawal').not.toContain(buyer.publicKey.toBase58());
    expect(names[0], 'the fee payer is not the relayer').toBe(operator.toBase58());
    log(`  ${names.length} account keys, and the buyer is none of them`);

    // The buyer paid nothing. Not "little" — nothing.
    const buyerAfter = await connection.getBalance(buyer.publicKey);
    expect(buyerAfter, 'the buyer paid for part of this withdrawal').toBe(buyerBefore);

    const after = await connection.getBalance(payee);
    log(`  payee received ${(after - before) / 1e9} SOL`);
    expect(after).toBeGreaterThan(before);
  }, 25 * 60 * 1000);
});
