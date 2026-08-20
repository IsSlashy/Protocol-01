/**
 * A REAL shield, on devnet, through the code the app actually runs.
 *
 * ⛔ INERT UNLESS `P01_LIVE_DEVNET=1`. It spends real devnet SOL, takes minutes,
 * and depends on an RPC being reachable, so it must never run in a normal suite.
 * Skipped is the correct default; a green suite that quietly included this would
 * be measuring the network, not the code.
 *
 * WHY IT EXISTS
 * ─────────────
 * "The path is open" and "the flow lands" are different claims, and this
 * repository has already paid for confusing them. Unit tests here mock the
 * Connection, so every one of them can pass while no deposit has ever landed.
 * This drives `poolShieldPrepare` -> fund the ephemeral -> `poolShieldExecute`
 * against the live program and asserts a signature, a commitment and a leaf
 * index came back.
 *
 * WHAT IT DOES NOT COVER, STATED SO NOBODY READS MORE INTO A GREEN RUN
 * ────────────────────────────────────────────────────────────────────
 * It calls the worker handlers directly rather than through the Web Worker, and
 * it funds the ephemeral straight from the wallet instead of through the
 * deployment relay (`fundEphemeralForJob` with `relayThroughDeployment`, which
 * needs the Next server up). So this proves the deposit MECHANISM: tree read,
 * C6 proof, chunk upload, instruction landing. It proves nothing about the
 * relay, and a wallet-funded deposit is linkable by construction — that is the
 * documented fallback, not a claim about privacy.
 *
 * Run:
 *   P01_LIVE_DEVNET=1 P01_LIVE_KEYPAIR=~/.config/solana/id.json \
 *     npx vitest run --config vitest.pool.config.mts lib/privacy/pool/liveDevnetShield.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import nacl from 'tweetnacl';

import {
  configurePoolHandlers,
  handlePoolRequest,
} from '../worker/poolHandlers';
import { buildDerivationMessage } from '../message';
import { loadServiceRegistry } from '../serviceRegistry';

/**
 * `Worker` does not exist in Node, and `starkProver` needs one.
 *
 * ⛔ NOT A STUBBED PROVER. A fake proof would make this harness worthless: the
 * transaction would be rejected on chain and the failure would look like a
 * shield bug. This runs the REAL `starkProver.worker` module in-process, over
 * the same WASM bytes, by giving it the two browser globals it actually uses --
 * `self.onmessage` to receive and `self.postMessage` to reply. Everything the
 * proof depends on is unchanged; only the thread boundary is removed.
 */
class InProcessStarkWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private inbox: unknown[] = [];
  private shim: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };

  constructor() {
    const outer = this;
    this.shim = {
      onmessage: null,
      postMessage(m: unknown) {
        outer.onmessage?.({ data: m });
      },
    };
    (globalThis as unknown as { self: unknown }).self = this.shim;
    // Messages sent before the module finishes importing are queued, not lost:
    // the service posts nothing until `wasmLoaded`, but a dropped message here
    // would hang the run instead of failing it.
    void import('./starkProver.worker').then(() => {
      for (const m of this.inbox) this.shim.onmessage?.({ data: m });
      this.inbox = [];
    });
  }

  postMessage(m: unknown) {
    if (this.shim.onmessage) this.shim.onmessage({ data: m });
    else this.inbox.push(m);
  }

  terminate() {}
}

if (typeof (globalThis as unknown as { Worker?: unknown }).Worker === 'undefined') {
  (globalThis as unknown as { Worker: unknown }).Worker = InProcessStarkWorker;
}

const LIVE = process.env.P01_LIVE_DEVNET === '1';
const RPC = process.env.P01_LIVE_RPC ?? 'https://api.devnet.solana.com';
/**
 * The demo denomination, and the only pool left open to new deposits.
 *
 * WAS 0.1 UNTIL 2026-08-20. Two measured reasons it moved:
 *
 *  1. The 0.1 SOL pool is being closed to new deposits, and a harness that
 *     keeps depositing into a closed pool is a harness that proves the wrong
 *     thing. Its 10 unspent notes stay scannable and spendable — closing a
 *     pool closes the entrance, never the exit.
 *  2. Anonymity set. Measured on chain 2026-08-20: the 1 SOL pool held 33
 *     leaves and 10 unspent notes. Concentrating every deposit in one
 *     denomination is the only lever that raises that number, and the size of
 *     that set is the ceiling on any unlinkability claim this project makes.
 *
 * ⚠️ This constant drives the pre-fund arithmetic: a 1 SOL shield moves
 * 1,003,475,300 lamports of value plus ~0.57 SOL of refundable proof rent, so
 * the funding wallet needs roughly 1.6 SOL free before this runs, not 0.7.
 */
const DENOMINATION = 1;

/** Expand a leading `~` so the documented invocation works from any shell. */
function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

function loadKeypair(): Keypair {
  const path = expandHome(
    process.env.P01_LIVE_KEYPAIR ?? `${homedir()}/.config/solana/id.json`,
  );
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
  return Keypair.fromSecretKey(secret);
}

/** Carried from the shield test to the subscribe test, which spends that note. */
let deposited: { meta: string; leafIndex: number; encryptedNote: string } | null = null;

describe.skipIf(!LIVE)('a shield that actually lands on devnet', () => {
  it(
    'deposits into the 1 SOL V3 pool and comes back with a leaf',
    async () => {
      const wallet = loadKeypair();
      const connection = new Connection(RPC, 'confirmed');
      configurePoolHandlers(RPC);

      // The balance check is an assertion, not a courtesy: a failure for "not
      // enough SOL" three minutes into a proof reads as a broken shield.
      const balance = await connection.getBalance(wallet.publicKey);
      // eslint-disable-next-line no-console
      console.log(`wallet ${wallet.publicKey.toBase58()} — ${balance / 1e9} SOL`);
      expect(balance).toBeGreaterThan(0.5e9);

      // Same message the page signs, signed the same way. The seed is derived
      // from these bytes, so a harness that invented its own signature would be
      // deriving a different identity than production does.
      const message = buildDerivationMessage({
        walletPubkey: wallet.publicKey.toBase58(),
        origin: 'http://localhost:3000',
        chainTag: 'solana:devnet',
      });
      const signature = nacl.sign.detached(
        new TextEncoder().encode(message),
        wallet.secretKey,
      );

      const meta = 'live-devnet-shield';
      await handlePoolRequest({
        kind: 'poolDeriveIdentity',
        meta,
        signature: Array.from(signature),
      });

      const prep = await handlePoolRequest(
        { kind: 'poolShieldPrepare', meta, token: 'SOL', denomination: DENOMINATION },
        // eslint-disable-next-line no-console
        (s: string) => console.log('  prepare:', s),
      );
      expect(prep.ephemeralPubkey).toBeTruthy();
      expect(prep.requiredLamports).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(
        `  ephemeral ${prep.ephemeralPubkey} needs ${prep.requiredLamports / 1e9} SOL`,
      );

      // The wallet-direct fallback. `fundEphemeralForJob` is what production
      // calls; it adds the deployment relay and the dirty-ephemeral guard, and
      // both need the Next server, which is why this harness does the transfer
      // itself and says so at the top of the file.
      const fundSig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: new PublicKey(prep.ephemeralPubkey),
            lamports: prep.requiredLamports,
          }),
        ),
        [wallet],
        { commitment: 'confirmed' },
      );
      // eslint-disable-next-line no-console
      console.log('  funded:', fundSig);

      const done = await handlePoolRequest(
        {
          kind: 'poolShieldExecute',
          jobId: prep.jobId,
          ownerPubkey: wallet.publicKey.toBase58(),
          sweepTo: wallet.publicKey.toBase58(),
        },
        // eslint-disable-next-line no-console
        (s: string) => console.log('  execute:', s),
      );

      // eslint-disable-next-line no-console
      console.log('  SHIELD LANDED:', done.txSig, 'leaf', done.leafIndex);

      expect(done.txSig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);
      expect(done.commitment).toBeTruthy();
      expect(done.leafIndex).toBeGreaterThanOrEqual(0);
      expect(done.denomination).toBe(DENOMINATION);
      expect(done.encryptedNote).toContain('p01enc');

      // The transaction has to be readable on chain, not merely returned by a
      // client that thinks it sent one.
      const tx = await connection.getTransaction(done.txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      expect(tx).not.toBeNull();
      expect(tx?.meta?.err).toBeNull();

      deposited = { meta, leafIndex: done.leafIndex, encryptedNote: done.encryptedNote };
    },
    15 * 60 * 1000,
  );

  it(
    'then subscribes with the note it just deposited',
    async () => {
      expect(deposited, 'the shield must have landed first').not.toBeNull();
      const note = deposited!;
      const wallet = loadKeypair();
      const connection = new Connection(RPC, 'confirmed');

      // A real vendor, read from the on-chain registry -- not a hand-made
      // retailer. `subscribe_private_stark` checks the vault against a real
      // listing, so a synthetic one would prove nothing about the flow the app
      // actually runs.
      const registry = await loadServiceRegistry(connection, { force: true });
      const service = registry.services[0];
      expect(service, 'the devnet registry must list at least one service').toBeTruthy();
      // eslint-disable-next-line no-console
      console.log(`  service ${service.slug} — retailer ${service.retailer.toBase58()}`);

      const prep = await handlePoolRequest(
        {
          kind: 'poolSubscribePrepare',
          meta: note.meta,
          token: 'SOL',
          denomination: DENOMINATION,
          leafIndex: note.leafIndex,
          encryptedNotes: [note.encryptedNote],
        },
        // eslint-disable-next-line no-console
        (s: string) => console.log('  sub-prepare:', s),
      );
      // eslint-disable-next-line no-console
      console.log(
        `  ephemeral ${prep.ephemeralPubkey} needs ${prep.requiredLamports / 1e9} SOL`,
      );

      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: new PublicKey(prep.ephemeralPubkey),
            lamports: prep.requiredLamports,
          }),
        ),
        [wallet],
        { commitment: 'confirmed' },
      );

      const done = await handlePoolRequest(
        {
          kind: 'poolSubscribeExecute',
          jobId: prep.jobId,
          ownerPubkey: wallet.publicKey.toBase58(),
          sweepTo: wallet.publicKey.toBase58(),
          retailer: service.retailer.toBase58(),
          rate: service.priceAtomic.toString(),
          intervalSlots: service.intervalSlots.toString(),
          serviceId: null,
        },
        // eslint-disable-next-line no-console
        (s: string) => console.log('  sub-execute:', s),
      );

      // eslint-disable-next-line no-console
      console.log('  SUBSCRIPTION OPENED:', done.txSig, 'vault', done.vaultPDA);

      expect(done.txSig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,}$/);
      expect(done.vaultPDA).toBeTruthy();
      expect(done.licenseKey).toBeTruthy();

      const tx = await connection.getTransaction(done.txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      expect(tx).not.toBeNull();
      expect(tx?.meta?.err).toBeNull();
    },
    15 * 60 * 1000,
  );
});
