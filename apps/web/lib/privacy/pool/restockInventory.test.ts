/**
 * Keep the note inventory stocked, on a clock, never in reaction to a purchase.
 *
 * ⛔ INERT unless `P01_RESTOCK=1`. It spends real devnet SOL and shields for
 * minutes. Skipped is the correct default.
 *
 * WHY THIS EXISTS. The capital is a ONE-TIME outlay and the cycle closes on its
 * own: a buyer pays 1 SOL for a note, the treasury is one note lighter and one
 * SOL heavier, and re-depositing puts it back. Nothing was automating the
 * re-deposit, so "one-time capital" was true on paper and false in practice —
 * the pot drained and stayed drained.
 *
 * 🚨 ON A CLOCK, AND THAT IS THE WHOLE PRIVACY ARGUMENT.
 *
 * MEASURED 2026-08-28: a relayed deposit follows its buyer's payment to the till
 * by a FIXED 48-50 seconds, on 4 of 4. That gap is what lets an analyst say
 * which deposit belongs to whom, and it is written at deposit time and
 * permanent. If the treasury re-deposited BECAUSE someone just bought, the same
 * gap would reappear one layer up: every restock would timestamp a sale.
 *
 * A schedule breaks that link by construction — the deposits answer to the
 * clock, not to the customer. The random start delay below matters for the same
 * reason: a cron at :23 makes "the deposits that land near :23" a recognisable
 * class, and a partitioned anonymity set is smaller than its count suggests.
 *
 * ⚠️ STRICTLY SEQUENTIAL, AND NOT BY CHOICE. `shield_denominated_v3` recomputes
 * the C6 proof's public-inputs hash against `merkle_tree.root` AS IT IS AT
 * EXECUTION, so a second deposit landing between another's proof and its send
 * makes the first fail `InvalidProof` — after its payer has already paid. One at
 * a time is the only shape that works.
 *
 * Run (this is what the workflow does):
 *   cd apps/web
 *   P01_RESTOCK=1 P01_LIVE_KEYPAIR=... P01_LIVE_RPC=... \
 *     P01_TREASURY_TARGET=10 P01_TREASURY_LOW_WATER=7 \
 *     npx vitest run --config vitest.pool.config.mts \
 *       lib/privacy/pool/restockInventory.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import nacl from 'tweetnacl';

import { handlePoolRequest } from '@/lib/privacy/worker/poolHandlers';
import { buildDerivationMessage } from '@/lib/privacy/message';
import {
  findPoolV3,
  fetchPoolCommitments,
  fetchSpentNullifierSet,
  isNullifierSpentInSet,
  createCommitmentV3,
  pubkeyToField,
  deriveNoteMaterial,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';

const LIVE = process.env.P01_RESTOCK === '1';

/** How many notes the pot should hold. */
const TARGET = Number(process.env.P01_TREASURY_TARGET ?? 10);
/** Below this, restock. Above it, do nothing — a tick that deposits every time
 *  is a tick that tracks demand, which is what the clock is here to avoid. */
const LOW_WATER = Number(process.env.P01_TREASURY_LOW_WATER ?? 7);
/** Bound per run, so one tick cannot spend the whole treasury on a miscount. */
const MAX_PER_RUN = Number(process.env.P01_TREASURY_MAX_PER_RUN ?? 3);
/** Never spend below this: the treasury still has to pay fees. */
const FLOOR_LAMPORTS = Number(process.env.P01_TREASURY_FLOOR ?? 1_100_000_000);

const DENOMINATION = 1;

function say(s: string) {
  // eslint-disable-next-line no-console
  console.log(s);
}

/** The leaves the operator has authorised, ranges included. Mirrors the route. */
function authorisedLeaves(): number[] {
  const out: number[] = [];
  for (const piece of (process.env.P01_TREASURY_NOTE_LEAVES ?? '').split(',')) {
    const s = piece.trim();
    if (s.length === 0) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(s);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (Number.isInteger(lo) && Number.isInteger(hi) && hi >= lo) {
        for (let i = lo; i <= hi && out.length < 512; i += 1) out.push(i);
      }
      continue;
    }
    const n = Number(s);
    if (Number.isInteger(n) && n >= 0 && out.length < 512) out.push(n);
  }
  return [...new Set(out)];
}

describe.skipIf(!LIVE)('the inventory refills itself, on a clock', () => {
  it('tops the pot back up to target', { timeout: 3_600_000 }, async () => {
    const wallet = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(
          readFileSync(
            (process.env.P01_LIVE_KEYPAIR ?? '').replace(/^~/, process.env.USERPROFILE ?? ''),
            'utf8',
          ),
        ),
      ),
    );
    const conn = new Connection(process.env.P01_LIVE_RPC!, 'confirmed');
    const pool = findPoolV3('SOL', DENOMINATION);
    expect(pool, 'the 1 SOL pool must exist').toBeTruthy();

    // ⚠️ THE SAME DERIVATION THE ROUTE USES, or the notes this deposits are
    // notes the deployment cannot hand out. The seed comes from the wallet
    // SIGNATURE — measured today, the `meta` label does not enter it, so a
    // different label is not a different treasury.
    const message = buildDerivationMessage({
      walletPubkey: wallet.publicKey.toBase58(),
      origin: 'http://localhost:3000',
      chainTag: 'solana:devnet',
    });
    const signature = nacl.sign.detached(
      new Uint8Array(Buffer.from(message, 'utf8')),
      wallet.secretKey,
    );
    const meta = 'deposit-campaign';
    await handlePoolRequest({
      kind: 'poolDeriveIdentity',
      meta,
      signature: Array.from(signature),
    } as never);

    // ── How much stock is there, really? ────────────────────────────────────
    //
    // Counted from the chain, never from a stored number: a count that drifts
    // from the pool is a pot that reports full and serves 503.
    const seedOut = (await handlePoolRequest({
      kind: 'poolExportSeed',
      meta,
      confirm:
        'I am configuring a note-issuing treasury and accept that this seed can spend every note it derives',
    } as never)) as { seedHex: string };
    const seed = Uint8Array.from(Buffer.from(seedOut.seedHex, 'hex'));

    /**
     * ⚠️ THIS IS A CEILING ON AVAILABILITY, NOT AVAILABILITY.
     *
     * It counts notes that are on the tree and UNSPENT. A note already issued
     * to a buyer who has not spent it yet is both — so it is counted here and
     * refused by `/api/issue-note`, which also checks a KV claim. MEASURED
     * right after the first live purchase: leaf 88 was sealed to a buyer and
     * this still read 10.
     *
     * The consequence is under-restocking, never over: the pot can be emptier
     * than this says and never fuller. Set the low-water mark with that in
     * mind — it is the reason it defaults to 7 of 10 rather than 9.
     *
     * Reading true availability needs the KV the route holds, and a harness
     * with the issuer's store credentials is a worse trade than a conservative
     * threshold.
     */
    async function stock(): Promise<number> {
      const commitments = await fetchPoolCommitments(conn, pool!.poolPDA);
      const spent = await fetchSpentNullifierSet(conn, pool!.poolPDA);
      let live = 0;
      for (const leaf of authorisedLeaves()) {
        const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool!.poolPDA, leaf);
        const blinding = deriveNoteBlinding(seed, pool!.poolPDA, leaf);
        const c = createCommitmentV3(
          nullifierPreimage,
          secret,
          blinding,
          pubkeyToField(pool!.tokenMint),
        );
        const onChain = commitments.get(c.toString());
        if (!onChain || onChain.leafIndex !== leaf) continue;
        // ⚠️ Argument order is (set, pool, nullifierPreimage, secret) — the same
        // order the route uses. Getting it wrong reads every note as unspent and
        // reports a full pot over an empty one.
        if (isNullifierSpentInSet(spent, pool!.poolPDA, nullifierPreimage, secret)) continue;
        live += 1;
      }
      return live;
    }

    const before = await stock();
    const balance = await conn.getBalance(wallet.publicKey);
    say(`stock ${before}/${TARGET}  low-water ${LOW_WATER}  balance ${(balance / 1e9).toFixed(3)} SOL`);

    if (before > LOW_WATER) {
      say('above low-water — nothing to do. A tick that deposits every time tracks demand.');
      return;
    }

    // 🚨 A RANDOM START, so the deposits are not "the ones that land near the
    // cron minute". A recognisable class of deposits partitions the anonymity
    // set, and a partitioned set is smaller than its count says.
    const jitterMs = Math.floor(Math.random() * Number(process.env.P01_RESTOCK_JITTER_MS ?? 900_000));
    say(`waiting ${Math.round(jitterMs / 1000)}s before the first deposit`);
    await new Promise((r) => setTimeout(r, jitterMs));

    const wanted = Math.min(TARGET - before, MAX_PER_RUN);
    let landed = 0;
    for (let i = 0; i < wanted; i += 1) {
      const bal = await conn.getBalance(wallet.publicKey);
      if (bal < FLOOR_LAMPORTS) {
        say(`FLOOR — ${(bal / 1e9).toFixed(3)} SOL left, stopping cleanly`);
        break;
      }
      const prep = (await handlePoolRequest({
        kind: 'poolShieldPrepare',
        meta,
        token: 'SOL',
        denomination: DENOMINATION,
      } as never)) as { jobId: string; ephemeralPubkey: string; requiredLamports: number };

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

      const done = (await handlePoolRequest({
        kind: 'poolShieldExecute',
        jobId: prep.jobId,
        ownerPubkey: wallet.publicKey.toBase58(),
        sweepTo: wallet.publicKey.toBase58(),
      } as never)) as { leafIndex?: number };
      landed += 1;
      say(`  +1 leaf ${done.leafIndex ?? '?'}  (${landed}/${wanted})`);

      // Random gap between deposits, for the same reason as the start jitter.
      if (i < wanted - 1) {
        const gap = 15_000 + Math.floor(Math.random() * 75_000);
        await new Promise((r) => setTimeout(r, gap));
      }
    }

    const after = await stock();
    say(`\nstock ${before} -> ${after}  (target ${TARGET}, landed ${landed})`);
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
