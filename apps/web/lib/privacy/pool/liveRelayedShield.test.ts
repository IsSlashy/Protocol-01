/**
 * The relayed deposit, end to end, against the DEPLOYED relay.
 *
 * ⛔ INERT UNLESS `P01_LIVE_RELAY=1`. It spends real devnet SOL from the wallet
 * you point it at, asks a live deployment to spend more, and takes minutes.
 *
 * WHY THIS EXISTS AND `liveDevnetShield` DOES NOT COVER IT
 * ───────────────────────────────────────────────────────
 * That harness funds the depositing ephemeral straight from the wallet and says
 * so at the top of its own file: `fundEphemeralForJob` is what production calls,
 * and it needs the Next server. So the leg that was added on 2026-08-21 — the
 * one that makes a deposit unlinkable — has never been exercised by anything.
 *
 * 🚨 MEASURED 2026-08-22 BEFORE THIS FILE EXISTED: the till and the fee wallet
 * were accounts that DID NOT EXIST on devnet (`getMultipleAccounts` → null,
 * null). Not "empty" — absent. No relayed deposit had ever completed, on any
 * deployment, ever. Every guard around that path was reasoned about and none of
 * it had been run.
 *
 * WHAT IT ACTUALLY PROVES, step by step, each printed:
 *   1. the deployment states its terms, and they are ready
 *   2. ONE wallet signature moves the note's value to the till and 1% to the
 *      fee sink — and nothing to the ephemeral
 *   3. the deployment funds the ephemeral from a THIRD address
 *   4. the ephemeral proves and deposits, so the pool transaction never names
 *      the buyer
 *   5. the refundable rent comes back to the float, not to the buyer
 *
 * ⚠️ It drives the HTTP API rather than `fundEphemeralForJob`, because that
 * function fetches a relative URL and there is no page here. The three things
 * this cannot catch are therefore the client's own refusals; those are covered
 * by `fundEphemeralForJob.test.ts`. What it does catch is the only thing that
 * unit tests cannot: whether the whole chain lands on chain.
 *
 * Run:
 *   P01_LIVE_RELAY=1 P01_RELAY_TICKET=<ticket> \
 *     P01_LIVE_KEYPAIR="$HOME/.config/solana/id.json" \
 *     NODE_OPTIONS="--max-old-space-size=8192" \
 *     npx vitest run --config vitest.pool.config.mts lib/privacy/pool/liveRelayedShield.test.ts
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

import { configurePoolHandlers, handlePoolRequest } from '../worker/poolHandlers';
import { buildDerivationMessage } from '../message';
import { operatorFeeAtomic } from './ephemeralFunder';
import { findPoolV3 } from './denominatedPool';

/*
 * ⚠️ COPIED FROM `liveDevnetShield.test.ts`, DELIBERATELY NOT EXTRACTED.
 *
 * That file is the harness the frozen Castle DAO demo was proven with.
 * Refactoring a shared module out of it would edit the one artefact whose whole
 * value is that it has not moved since the run it attests to. Thirty duplicated
 * lines are cheaper than that risk; extract them the week after 2026-09-04, not
 * before.
 *
 * 🚨 THIS PARAGRAPH USED TO SAY THE COPY ON `demo/castle-dao-2026-09-04` WAS
 * TAGGED. MEASURED 2026-08-26: no such branch and no such tag exists — `git
 * tag --list` holds 27 tags, all `v*`, and no remote branch matches `demo/*`.
 * So the safety net the freeze leaned on was never there, and "do not edit this
 * file" was the only thing actually protecting the artefact. If the demo state
 * is worth freezing, tag it; until then this comment is the whole mechanism.
 */
/**
 * `Worker` does not exist in Node, and `starkProver` needs one.
 *
 * ⛔ NOT A STUBBED PROVER. A fake proof would make this harness worthless: the
 * transaction would be rejected on chain and the failure would look like a
 * shield bug. This runs the REAL `starkProver.worker` module in-process, over
 * the same WASM bytes, by giving it the browser globals it actually uses --
 * `self.onmessage` to receive, `self.postMessage` to reply, and `self.crypto`
 * for the CSPRNG. Everything the proof depends on is unchanged; only the thread
 * boundary is removed.
 */
class InProcessStarkWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private inbox: unknown[] = [];
  private shim: {
    onmessage: ((e: { data: unknown }) => void) | null;
    postMessage: (m: unknown) => void;
    crypto: Crypto;
  };

  constructor() {
    const outer = this;
    this.shim = {
      onmessage: null,
      postMessage(m: unknown) {
        outer.onmessage?.({ data: m });
      },
      // 🚨 `crypto` IS NOT OPTIONAL, and leaving it out already cost a live run.
      //
      // In a real Web Worker `self` IS the global, so `self.crypto` is the Web
      // Crypto API. The line below REPLACES `self` with this bare object, and
      // the wasm-bindgen glue resolves the CSPRNG through `self.crypto`. Drop
      // this property and any circuit that draws a mask dies with:
      //
      //   {"error":"no CSPRNG available, refusing to build a C7 proof:
      //   Web Crypto API is unavailable"}            -- stark/src/lib.rs:432
      //
      // THIS FILE IS SAFE TODAY ONLY BY ACCIDENT OF SCOPE: the relayed shield
      // proves C6, which draws no randomness at all, so an impoverished `self`
      // is invisible here. Point this harness at a masked circuit (C7 draws a
      // 1,280-element mask) and the trap reproduces immediately — which is
      // exactly how it was found in liveDevnetUnshieldV4.test.ts.
      crypto: globalThis.crypto,
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

const LIVE = process.env.P01_LIVE_RELAY === '1';
const RPC = process.env.P01_LIVE_RPC ?? 'https://api.devnet.solana.com';
const BASE = process.env.P01_RELAY_BASE ?? 'https://protocol-01.dev';
const TICKET = process.env.P01_RELAY_TICKET ?? '';
/** The only pool open to deposits. 0.1 is closed by policy; 10+ is over the cap. */
const DENOMINATION = 1;

/* eslint-disable no-console */
const say = (s: string) => console.log(s);

function loadKeypair(): Keypair {
  const path = process.env.P01_LIVE_KEYPAIR ?? `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

interface Terms {
  ok: boolean;
  ready: boolean;
  reasons: string[];
  funder: string;
  till: string;
  feeWallet: string;
  funderLamports: number | null;
  relaysRemaining: number | null;
  relaysPerHour: number;
  maxRelayLamports: number;
  maxRentSubsidyLamports: number;
}

describe.skipIf(!LIVE)('a RELAYED deposit that actually lands on devnet', () => {
  it(
    'pays the till, is funded by the float, and deposits without naming the buyer',
    async () => {
      const wallet = loadKeypair();
      const connection = new Connection(RPC, 'confirmed');
      configurePoolHandlers(RPC);

      // ── 1. What the deployment says it will do ───────────────────────────
      const terms = (await (await fetch(`${BASE}/api/relay-to-buyer`)).json()) as Terms;
      say(`\n1. TERMS from ${BASE}`);
      say(`   ready            ${terms.ready}  ${terms.reasons.join(' ') || '(no reasons)'}`);
      say(`   till   (R)       ${terms.till}`);
      say(`   fee sink         ${terms.feeWallet}`);
      say(`   float  (F)       ${terms.funder}  ${(terms.funderLamports ?? 0) / 1e9} SOL`);
      say(`   relays left      ${terms.relaysRemaining}/${terms.relaysPerHour} this hour`);
      expect(terms.ready, terms.reasons.join(' ')).toBe(true);
      // The property this whole leg exists for, asserted before a lamport moves.
      expect(new Set([terms.till, terms.feeWallet, terms.funder]).size).toBe(3);

      // ── 2. Prove and price, before anything is signed ────────────────────
      const message = buildDerivationMessage({
        walletPubkey: wallet.publicKey.toBase58(),
        origin: 'http://localhost:3000',
        chainTag: 'solana:devnet',
      });
      const signature = nacl.sign.detached(
        new TextEncoder().encode(message),
        wallet.secretKey,
      );
      const meta = 'live-relayed-shield';
      await handlePoolRequest({ kind: 'poolDeriveIdentity', meta, signature: Array.from(signature) });

      say(`\n2. PREPARE — the C6 proof runs here, and takes minutes`);
      const prep = await handlePoolRequest(
        { kind: 'poolShieldPrepare', meta, token: 'SOL', denomination: DENOMINATION },
        (s: string) => say(`   ${s}`),
      );
      const pool = findPoolV3('SOL', DENOMINATION)!;
      const feeLamports = Number(
        operatorFeeAtomic({
          token: pool.token,
          denominationAtomic: pool.denominationAtomic,
          decimals: pool.decimals,
        }),
      );
      say(`   ephemeral        ${prep.ephemeralPubkey}`);
      say(`   value  -> till   ${prep.valueLamports / 1e9} SOL`);
      say(`   fee    -> sink   ${feeLamports / 1e9} SOL`);
      say(`   float fronts     ${(prep.requiredLamports - prep.valueLamports) / 1e9} SOL of rent`);

      const before = {
        wallet: await connection.getBalance(wallet.publicKey, 'confirmed'),
        till: await connection.getBalance(new PublicKey(terms.till), 'confirmed'),
        fee: await connection.getBalance(new PublicKey(terms.feeWallet), 'confirmed'),
        float: await connection.getBalance(new PublicKey(terms.funder), 'confirmed'),
        ephemeral: await connection.getBalance(new PublicKey(prep.ephemeralPubkey), 'confirmed'),
      };
      // The relay refuses a buyer that already holds lamports, and it is right
      // to: a reused identity ties its deposits to each other.
      expect(before.ephemeral).toBe(0);

      // ── 3. ONE signature, two credits, and NOTHING to the ephemeral ──────
      say(`\n3. THE BUYER SIGNS ONCE`);
      const paySig = await sendAndConfirmTransaction(
        connection,
        new Transaction()
          .add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: new PublicKey(terms.till),
              lamports: prep.valueLamports,
            }),
          )
          .add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: new PublicKey(terms.feeWallet),
              lamports: feeLamports,
            }),
          ),
        [wallet],
        { commitment: 'confirmed' },
      );
      say(`   payment          ${paySig}`);

      // ── 4. The deployment funds the ephemeral, from a third address ──────
      say(`\n4. THE DEPLOYMENT FUNDS THE EPHEMERAL`);
      const res = await fetch(`${BASE}/api/relay-to-buyer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': TICKET },
        body: JSON.stringify({
          paymentSignature: paySig,
          buyerPubkey: prep.ephemeralPubkey,
          requiredLamports: prep.requiredLamports,
        }),
      });
      const relayed = (await res.json()) as Record<string, unknown>;
      say(`   HTTP ${res.status}  ${JSON.stringify(relayed).slice(0, 400)}`);
      expect(res.status, JSON.stringify(relayed)).toBeLessThan(300);
      expect(relayed.ok).toBe(true);

      // ── 5. The deposit itself, signed by the ephemeral ───────────────────
      say(`\n5. EXECUTE — the ephemeral uploads the proof and deposits`);
      const done = await handlePoolRequest(
        {
          kind: 'poolShieldExecute',
          jobId: prep.jobId,
          ownerPubkey: wallet.publicKey.toBase58(),
          // ⛔ THE FLOAT, NOT THE WALLET. The float fronted the refundable rent,
          // so the residue is its own. Sweeping it to the buyer would be taking
          // the deployment's money; sweeping it home would rebuild the
          // `ephemeral -> wallet` edge this entire detour removes.
          sweepTo: terms.funder,
        },
        (s: string) => say(`   ${s}`),
      );
      say(`\n   DEPOSIT LANDED   ${done.txSig}`);
      say(`   leaf             ${done.leafIndex}`);

      // ── 6. Read it back from the chain, not from the client ──────────────
      const tx = await connection.getTransaction(done.txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      expect(tx).not.toBeNull();
      expect(tx?.meta?.err).toBeNull();

      const keys = tx!.transaction.message
        .getAccountKeys()
        .staticAccountKeys.map((k) => k.toBase58());
      say(`\n6. WHO IS NAMED BY THE DEPOSIT TRANSACTION`);
      say(`   ${keys.join('\n   ')}`);
      // 🚨 THE WHOLE POINT, AND THE ONLY ASSERTION THAT MATTERS. The buyer's
      // wallet must not appear in the transaction that touches the pool.
      expect(keys).not.toContain(wallet.publicKey.toBase58());
      expect(keys).toContain(prep.ephemeralPubkey);

      const after = {
        wallet: await connection.getBalance(wallet.publicKey, 'confirmed'),
        till: await connection.getBalance(new PublicKey(terms.till), 'confirmed'),
        fee: await connection.getBalance(new PublicKey(terms.feeWallet), 'confirmed'),
        float: await connection.getBalance(new PublicKey(terms.funder), 'confirmed'),
      };
      const d = (a: number, b: number) => `${((b - a) / 1e9).toFixed(6)} SOL`;
      say(`\n7. WHERE THE MONEY WENT`);
      say(`   buyer            ${d(before.wallet, after.wallet)}`);
      say(`   till   (R)       ${d(before.till, after.till)}`);
      say(`   fee sink         ${d(before.fee, after.fee)}`);
      say(`   float  (F)       ${d(before.float, after.float)}`);

      // The till received exactly the note's value: not the fee, not the rent.
      expect(after.till - before.till).toBe(prep.valueLamports);
      expect(after.fee - before.fee).toBe(feeLamports);
      // The buyer paid the value and the fee, and no rent. Network fees make the
      // debit slightly larger, never smaller.
      expect(before.wallet - after.wallet).toBeGreaterThanOrEqual(
        prep.valueLamports + feeLamports,
      );
      expect(before.wallet - after.wallet).toBeLessThan(
        prep.valueLamports + feeLamports + 1_000_000,
      );
    },
    20 * 60 * 1000,
  );
});
