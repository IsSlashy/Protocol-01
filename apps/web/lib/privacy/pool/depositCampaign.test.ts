/**
 * The deposit campaign — the only lever that raises the anonymity set.
 *
 * ⛔ INERT UNLESS `P01_DEPOSIT_CAMPAIGN=1`. It spends real devnet SOL, runs for
 * hours, and is meant to be left alone. Skipped is the correct default.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT CODE THAT SHIPS
 * ─────────────────────────────────────────────────
 * Every other channel this project has measured is closed by a change to a
 * program or a circuit. This one is not: the anonymity set is the number of
 * UNSPENT notes at a denomination, and no line of code creates one. Only a
 * deposit does.
 *
 *   capital / denomination = notes
 *
 * That formula argues for the SMALLEST denomination — 42.9 SOL buys ~420 notes
 * at 0.1 SOL and only ~42 at 1 SOL, because the proof work, the fees and the
 * ~0.57 SOL of transient proof rent are identical either way; the circuits do
 * not know what a note is worth.
 *
 * ⛔ AND THE CAMPAIGN RUNS AT 1 SOL ANYWAY. Founder decision, 2026-08-21, and it
 * is the right one: a set does not add across denominations, it SPLITS, and a
 * set in a pool the demo does not spend from is worth nothing to the claim the
 * demo makes. Quoting 420 while showing a spend out of a pool of 42 is the
 * true-sentence-that-reads-false this project keeps paying for. One
 * denomination, and it is the one carrying the proven journey.
 *
 * The honest consequence, stated so nobody has to rediscover it: the ceiling is
 * ~41 notes at the current balance, not 420. Raising it needs capital, not code.
 *
 * ⚠️ RECYCLING BUYS NOTHING. Deposit, spend, redeposit grows the tree without
 * growing the set: at the moment of a spend the candidates are the leaves still
 * UNSPENT, so the ceiling is capital, not time. These notes must be deposited
 * and then LEFT ALONE.
 *
 * IT ALSO DILUTES THE CLOCK. Measured on the frozen demo: 524 slots between the
 * deposit and the spend that consumed it — about three and a half minutes on a
 * pool that receives roughly one deposit a day. An observer needs no
 * cryptography for that. Random gaps between deposits are therefore not
 * cosmetic; they are the second thing this file buys.
 *
 * RESTART SAFETY comes free and is not a feature of this file: the note counter
 * is read from the tree account inside `prepareShield`, so a run that dies
 * mid-flight simply continues from whatever the chain says next time. Nothing
 * is checkpointed because nothing needs to be.
 *
 * Run:
 *   cd apps/web
 *   P01_DEPOSIT_CAMPAIGN=1 P01_LIVE_KEYPAIR=~/.config/solana/id.json \
 *     P01_CAMPAIGN_TARGET=400 NODE_OPTIONS=--max-old-space-size=8192 \
 *     npx vitest run --config vitest.pool.config.mts \
 *       lib/privacy/pool/depositCampaign.test.ts
 */

import { describe, it, expect } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
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
import { findPoolV3 } from './denominatedPool';

/**
 * ⚠️ DELIBERATE COPY of the shim in `liveDevnetShield.test.ts`, not an import.
 *
 * That file is the instrument the frozen Castle DAO demo was proven with, and it
 * is not to be edited before 2026-09-04 — extracting a shared module would touch
 * it. The duplication is the cheaper risk, and it is temporary: fold both into
 * one module after the demo.
 */
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

const RUN = process.env.P01_DEPOSIT_CAMPAIGN === '1';
const RPC = process.env.P01_LIVE_RPC ?? 'https://api.devnet.solana.com';

/**
 * 1 SOL — the project's ONE denomination, and the pool the frozen demo spends
 * from. See the header on why this is not the note-maximising choice and is
 * still the right one.
 */
const DENOMINATION = 1;

/** How many UNSPENT notes to aim for. Overridable so a short run can be tried. */
const TARGET = Number(process.env.P01_CAMPAIGN_TARGET ?? 400);

/**
 * Stop while there is still enough to finish a deposit in flight.
 *
 * A deposit moves the denomination plus ~0.57 SOL of proof-buffer rent, and the
 * rent comes back. Stopping at 1.5 SOL leaves room for one full journey plus the
 * sweep, so the campaign never dies holding an ephemeral it cannot afford to
 * unwind — which is how float gets stranded.
 */
const FLOOR_LAMPORTS = 1.5e9;

/** Random gap between deposits. Not cosmetic — see the header on the clock. */
const GAP_MIN_MS = Number(process.env.P01_CAMPAIGN_GAP_MIN_MS ?? 15_000);
const GAP_MAX_MS = Number(process.env.P01_CAMPAIGN_GAP_MAX_MS ?? 90_000);

const LOG = process.env.P01_CAMPAIGN_LOG ?? 'campaign-progress.jsonl';

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

function loadKeypair(): Keypair {
  const path = expandHome(process.env.P01_LIVE_KEYPAIR ?? `${homedir()}/.config/solana/id.json`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

/** Leaves inserted so far, straight off the tree account. */
async function leafCount(conn: Connection, treePDA: PublicKey): Promise<number> {
  const ai = await conn.getAccountInfo(treePDA, 'confirmed');
  if (!ai) throw new Error('tree account not found');
  // MerkleTreeStateV3: 8 discriminator + 32 pool + 32 root, then leaf_count u64.
  return Number(ai.data.readBigUInt64LE(8 + 32 + 32));
}

/** Value held by the pool beyond its own rent — i.e. the unspent notes. */
async function unspentNotes(conn: Connection, poolPDA: PublicKey, denom: number): Promise<number> {
  const ai = await conn.getAccountInfo(poolPDA, 'confirmed');
  if (!ai) return 0;
  const rent = await conn.getMinimumBalanceForRentExemption(ai.data.length);
  return Math.round((ai.lamports - rent) / (denom * 1e9));
}

function record(line: Record<string, unknown>): void {
  try {
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n');
  } catch {
    // A campaign that cannot write its log must not stop depositing.
  }
}

describe.skipIf(!RUN)('deposit campaign', () => {
  it(
    'fills the 1 SOL pool until the capital runs out',
    async () => {
      const wallet = loadKeypair();
      const conn = new Connection(RPC, 'confirmed');
      configurePoolHandlers(RPC);

      const pool = findPoolV3('SOL', DENOMINATION);
      expect(pool, 'the 1 SOL pool must exist in the table').toBeTruthy();

      // The same message the page signs, signed the same way — a harness that
      // invented its own signature would derive a different identity than
      // production, and its notes would be invisible to the real client.
      const message = buildDerivationMessage({
        walletPubkey: wallet.publicKey.toBase58(),
        origin: 'http://localhost:3000',
        chainTag: 'solana:devnet',
      });
      const signature = nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey);
      const meta = 'deposit-campaign';
      await handlePoolRequest({ kind: 'poolDeriveIdentity', meta, signature: Array.from(signature) });

      const startLeaves = await leafCount(conn, pool!.treePDA);
      const startUnspent = await unspentNotes(conn, pool!.poolPDA, DENOMINATION);
      const startBalance = await conn.getBalance(wallet.publicKey);
      // eslint-disable-next-line no-console
      console.log(
        `campaign start — leaves ${startLeaves}, unspent ${startUnspent}, ` +
          `balance ${(startBalance / 1e9).toFixed(3)} SOL, target ${TARGET}`,
      );
      record({ event: 'start', leaves: startLeaves, unspent: startUnspent, balance: startBalance, target: TARGET });

      let landed = 0;
      let failed = 0;

      for (;;) {
        const balance = await conn.getBalance(wallet.publicKey);
        const unspent = await unspentNotes(conn, pool!.poolPDA, DENOMINATION);

        if (unspent >= TARGET) {
          // eslint-disable-next-line no-console
          console.log(`TARGET REACHED — ${unspent} unspent notes`);
          record({ event: 'target-reached', unspent });
          break;
        }
        if (balance < FLOOR_LAMPORTS) {
          // eslint-disable-next-line no-console
          console.log(`FLOOR REACHED — ${(balance / 1e9).toFixed(3)} SOL left, stopping cleanly`);
          record({ event: 'floor-reached', balance, unspent });
          break;
        }

        try {
          const prep = await handlePoolRequest({
            kind: 'poolShieldPrepare',
            meta,
            token: 'SOL',
            denomination: DENOMINATION,
          });

          await sendAndConfirmTransaction(
            conn,
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

          const done = await handlePoolRequest({
            kind: 'poolShieldExecute',
            jobId: prep.jobId,
            ownerPubkey: wallet.publicKey.toBase58(),
            sweepTo: wallet.publicKey.toBase58(),
          });

          landed += 1;
          // eslint-disable-next-line no-console
          console.log(
            `  #${landed} leaf ${done.leafIndex} ${done.txSig.slice(0, 12)}… ` +
              `unspent≈${unspent + 1} balance ${(balance / 1e9).toFixed(3)}`,
          );
          record({ event: 'deposit', n: landed, leaf: done.leafIndex, sig: done.txSig, balance });
        } catch (e) {
          failed += 1;
          const msg = (e as Error).message?.slice(0, 200) ?? String(e);
          // eslint-disable-next-line no-console
          console.log(`  !! deposit failed (${failed}): ${msg}`);
          record({ event: 'failure', n: failed, error: msg });
          // ⚠️ A failure is NOT fatal and must not be. Devnet drops
          // transactions, and the float left on a failed ephemeral is
          // re-derivable from the seed — `recoverFloat` sweeps it later. Ten
          // consecutive failures mean something structural, not weather.
          if (failed >= 10 && landed === 0) throw e;
        }

        const gap = GAP_MIN_MS + Math.floor(Math.random() * (GAP_MAX_MS - GAP_MIN_MS));
        await new Promise((r) => setTimeout(r, gap));
      }

      const endLeaves = await leafCount(conn, pool!.treePDA);
      const endUnspent = await unspentNotes(conn, pool!.poolPDA, DENOMINATION);
      // eslint-disable-next-line no-console
      console.log(
        `campaign end — leaves ${startLeaves} → ${endLeaves}, ` +
          `unspent ${startUnspent} → ${endUnspent}, landed ${landed}, failed ${failed}`,
      );
      record({ event: 'end', leaves: endLeaves, unspent: endUnspent, landed, failed });

      // The campaign is a success if it moved the number. It is NOT a success
      // if it merely ran: a run that lands nothing and reports green would be
      // the false green this project keeps paying for.
      expect(endUnspent).toBeGreaterThan(startUnspent);
    },
    // Two days. The loop stops itself on target, on the balance floor, or on a
    // structural failure; this bound only stops a hung run from living forever.
    48 * 60 * 60 * 1000,
  );
});
