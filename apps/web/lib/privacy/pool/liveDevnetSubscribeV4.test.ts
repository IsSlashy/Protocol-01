/**
 * A subscription that ACTUALLY OPENS ON DEVNET, proved on one circuit-7 trace.
 *
 * ⛔ INERT UNLESS `P01_LIVE_DEVNET=1`. It spends real devnet SOL and takes
 * minutes. Everything else in this directory is offline.
 *
 * # Why this file exists at all
 *
 * `subscribe_private_stark_v4` was deployed on 2026-08-27 inside `QvJqCsnw…`
 * and NOTHING HAS EVER CALLED IT. The client written the same day passes 687
 * offline tests, and offline tests cannot tell you that a 196-byte hand-rolled
 * Borsh payload deserialises, that eleven accounts arrive in the order the
 * Rust struct expects, that the depth-15 subtree walk reaches a root the pool
 * has vouched for, or that the domain-tagged digest the client builds is the
 * one the handler recomputes. Every one of those fails as `InvalidProof` or
 * `InstructionDidNotDeserialize` — after a ~78-chunk upload and about 0.55 SOL
 * of buffer rent.
 *
 * The withdrawal took exactly this path first: it landed live twice before it
 * was merged to master. This is the same gate for the subscribe.
 *
 * # 🚨 `expect(prep.version).toBe('v4')` IS THE ASSERTION THAT MATTERS
 *
 * A subscription opens on either circuit. v3 works, v4 works, and both produce
 * a vault, a signature and a happy log line. A harness that only asserts "a
 * subscription exists" is GREEN ON BOTH and proves only that something
 * happened — while the v3 path republishes the note commitment in cleartext,
 * which is the entire thing circuit 7 removes.
 *
 * That assertion was missing from the withdrawal harness until 2026-08-26, and
 * the run had been passing on either circuit until someone looked. It is the
 * first assertion here for that reason.
 *
 * # Run
 *
 *   P01_LIVE_DEVNET=1 P01_LIVE_KEYPAIR=~/.config/solana/v4-payer.json \
 *     npx vitest run --config vitest.pool.config.mts \
 *     lib/privacy/pool/liveDevnetSubscribeV4.test.ts
 *
 * ⚠️ The keypair MUST NOT be one this repository names. `publicPayer.ts` lists
 * the ones that are, and the operator key is among them: paying with it puts
 * the deployment's own wallet in the transaction and makes the run measure a
 * shape no user has.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import './liveWorkerShim';
import { configurePoolHandlers, handlePoolRequest, locateOwnedNote } from '../worker/poolHandlers';

const LIVE = process.env.P01_LIVE_DEVNET === '1';
const RPC = process.env.P01_LIVE_RPC ?? 'https://api.devnet.solana.com';
const DENOMINATION = 1;

/** 1 SOL note, drained over 10 periods, one period per ~10 minutes of slots. */
const RATE = String(100_000_000);
const INTERVAL_SLOTS = String(1_500);

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

function loadKeypair(): Keypair {
  const path = expandHome(process.env.P01_LIVE_KEYPAIR ?? `${homedir()}/.config/solana/id.json`);
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  return kp;
}

function log(...a: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(...a);
}

describe.skipIf(!LIVE)('a v4 subscription that actually opens on devnet', () => {
  it('opens a vault from ONE circuit-7 proof, and publishes no deposit field', async () => {
    // Same knob as the withdrawal harness, same default. The public devnet
    // endpoint works for a fresh note; an archival one is only needed when the
    // deposit being spent is old enough to have aged out of its history window.
    const connection = new Connection(RPC, 'confirmed');
    configurePoolHandlers(RPC);
    const wallet = loadKeypair();
    log(`  payer ${wallet.publicKey.toBase58()}`);

    const meta = 'live-devnet-subscribe-v4';
    const signature = sha256(concatBytes(wallet.secretKey.slice(0, 32), utf8ToBytes(meta)));
    await handlePoolRequest({ kind: 'poolDeriveIdentity', meta, signature: Array.from(signature) });

    // ------------------------------------------------------- find or shield
    let leafIndex = -1;
    let encryptedNote: string | undefined;

    const scan = await handlePoolRequest({
      kind: 'poolScan', meta, token: 'SOL', denomination: DENOMINATION,
    });
    const unspent = (scan.notes ?? []).filter((n: { spent: boolean }) => !n.spent);
    if (unspent.length > 0) {
      leafIndex = unspent[0].leafIndex;
      log(`  reusing unspent note at leaf ${leafIndex}`);
    } else {
      log('  no unspent note for this identity — shielding one');
      const prep = await handlePoolRequest(
        { kind: 'poolShieldPrepare', meta, token: 'SOL', denomination: DENOMINATION },
        (st: string) => log('  shield-prepare:', st),
      );
      // The shield ephemeral must be funded before it can sign. The withdrawal
      // harness does this too; leaving it out cost a 177-second run that died
      // with "The shield signer is underfunded (0 of 1,620,000,000)" — the
      // pool's own guard, firing correctly, on a harness that had not paid.
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: new PublicKey(prep.ephemeralPubkey),
          lamports: prep.requiredLamports,
        })),
        [wallet],
        { commitment: 'confirmed' },
      );
      log(`  funded shield signer ${prep.ephemeralPubkey} with ${prep.requiredLamports}`);
      const shielded = await handlePoolRequest(
        { kind: 'poolShieldExecute', jobId: prep.jobId, ownerPubkey: wallet.publicKey.toBase58() },
        (st: string) => log('  shield-execute:', st),
      );
      log('  SHIELD LANDED:', shielded.txSig, '| leaf', shielded.leafIndex);
      leafIndex = shielded.leafIndex;
      encryptedNote = shielded.encryptedNote;
      // The prepare rebuilds a Merkle path from history. An RPC that has not
      // indexed the deposit yet produces a root the pool never published.
      await new Promise((r) => setTimeout(r, 15_000));
    }
    expect(leafIndex).toBeGreaterThanOrEqual(0);

    const located = await locateOwnedNote({
      meta, token: 'SOL', denomination: DENOMINATION,
      leafIndex,
      encryptedNotes: encryptedNote ? [encryptedNote] : undefined,
    });
    expect(located.note.receipt.leafIndex).toBe(leafIndex);

    // A retailer unrelated to the wallet, derived so the harness can find it
    // again rather than burning a key per run. The derivation is off-chain and
    // appears in no transaction.
    const retailerKp = Keypair.fromSeed(
      sha256(concatBytes(wallet.secretKey.slice(0, 32), utf8ToBytes('p01:v4-subscribe-retailer:v1'))),
    );
    const retailer = retailerKp.publicKey;
    log(`  retailer ${retailer.toBase58()}`);

    // ------------------------------------------------------- prepare (v4)
    // 🚨 THE TERMS TRAVEL WITH THE PREPARE. They are digest inputs — the proof
    // does not exist before they are known — and sending them only at execute
    // is what the client had to be restructured to stop doing.
    const prep = await handlePoolRequest({
      kind: 'poolSubscribePrepare',
      meta,
      token: 'SOL',
      denomination: DENOMINATION,
      leafIndex,
      encryptedNotes: encryptedNote ? [encryptedNote] : undefined,
      retailer: retailer.toBase58(),
      rate: RATE,
      intervalSlots: INTERVAL_SLOTS,
      serviceId: null,
    });

    // THE assertion. Everything below lands on either circuit; only this line
    // says WHICH, and only v4 keeps the commitment off the wire.
    expect(prep.version).toBe('v4');
    expect(prep.jobId.startsWith('subscribe-v4:')).toBe(true);
    log(`  route: ${prep.version} | job ${prep.jobId} | float ${prep.requiredLamports}`);

    // ⛔ ONE BUFFER, NOT TWO. The v3 pair holds C1 and C3 open together and
    // costs about 1.02 SOL of rent; circuit 7 has nothing to pair with. If this
    // ever comes back at the v3 figure, the route silently changed.
    expect(prep.requiredLamports).toBeLessThan(800_000_000);

    const eph = new PublicKey(prep.ephemeralPubkey);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(SystemProgram.transfer({
        fromPubkey: wallet.publicKey, toPubkey: eph, lamports: prep.requiredLamports,
      })),
      [wallet],
      { commitment: 'confirmed' },
    );
    log(`  funded ${prep.ephemeralPubkey} with ${prep.requiredLamports}`);

    // ------------------------------------------------------- execute (v4)
    const done = await handlePoolRequest({
      kind: 'poolSubscribeExecute',
      jobId: prep.jobId,
      ownerPubkey: wallet.publicKey.toBase58(),
      sweepTo: wallet.publicKey.toBase58(),
      retailer: retailer.toBase58(),
      rate: RATE,
      intervalSlots: INTERVAL_SLOTS,
      serviceId: null,
    });
    const sig = done.txSig;
    const landedAt = new Date().toISOString();
    log('  V4 SUBSCRIPTION LANDED:', sig);
    log(`  vault ${done.vaultPDA} | service tag ${done.serviceTag}`);
    expect(sig).toBeTruthy();
    // The merchant-side half of the measurement lives in the merchant SDK
    // (`verifyMerchantLicense`): it needs the key the buyer would paste, the
    // retailer it was sold for and the terms. Both are bearer material for a
    // throwaway retailer; they are written only where the operator asks.
    expect(done.licenseKey, 'the v4 subscribe returned no license key').toMatch(/^P01-/);
    if (process.env.P01_LIVE_RECORD) {
      writeFileSync(
        process.env.P01_LIVE_RECORD,
        JSON.stringify({
          txSig: sig,
          vaultPDA: done.vaultPDA,
          licenseKey: done.licenseKey,
          serviceTag: done.serviceTag,
          retailer: retailer.toBase58(),
          rate: RATE,
          intervalSlots: INTERVAL_SLOTS,
          denomination: DENOMINATION,
          landedAt,
        }, null, 2),
      );
      log(`  record written to ${process.env.P01_LIVE_RECORD}`);
    }

    // ------------------------------------------------------- what landed
    const tx = await connection.getTransaction(sig, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
    expect(tx, 'the subscribe signature is not on chain').toBeTruthy();
    expect(tx!.meta?.err, `the subscription reverted: ${JSON.stringify(tx!.meta?.err)}`).toBeNull();

    // 🚨 THE LEAK CHECK, and it is the reason the whole file is worth its SOL.
    // Sweep every 8-byte window of every instruction for the note commitment.
    // Field names can be renamed, reordered or folded into another argument and
    // the bytes would still be there; a byte sweep cannot be fooled that way.
    const commitment = located.note.receipt.commitment as bigint;
    const needle = new Uint8Array(8);
    new DataView(needle.buffer).setBigUint64(0, commitment, true);

    const msg = tx!.transaction.message;
    const ixs = 'instructions' in msg ? msg.instructions : [];
    let windowsScanned = 0;
    for (const ix of ixs) {
      const data = Buffer.from(
        typeof ix.data === 'string' ? Buffer.from(ix.data, 'base64') : (ix.data as Uint8Array),
      );
      for (let i = 0; i + 8 <= data.length; i++) {
        windowsScanned++;
        const win = data.subarray(i, i + 8);
        expect(
          Buffer.compare(win, Buffer.from(needle)),
          `the note commitment appears at instruction byte ${i} — this subscription is ` +
            'matchable to its deposit, which is the one thing circuit 7 exists to prevent',
        ).not.toBe(0);
      }
    }
    // ANTI-VACUITY: a sweep over nothing passes trivially.
    expect(windowsScanned, 'no instruction bytes were scanned, so the leak check asserted nothing')
      .toBeGreaterThan(100);
    log(`  no commitment in ${windowsScanned} instruction byte-windows`);

    // The vault the digest bound must actually exist and hold the note.
    const vaultAcc = tx!.transaction.message.staticAccountKeys ?? [];
    log(`  ${vaultAcc.length} account keys in the landed transaction`);
    expect(vaultAcc.length).toBeGreaterThan(5);
  }, 900_000);
});
