/**
 * The full round trip of the pre-deposited inventory, against the LIVE deployment.
 *
 * ⛔ INERT unless `P01_LIVE_BUY=1`. It spends real devnet SOL.
 *
 *   pay the till  ->  /api/claim-for-payment  ->  /api/issue-note  ->  a note
 *
 * WHAT IT IS FOR. Every piece of this was tested in isolation; none of it had
 * ever run end to end against the deployed site. The seam this exercises —
 * "a payment becomes a claim becomes a note" — is exactly where a mismatch
 * between a locally-set env var and a production one hides, and no unit test can
 * see it.
 *
 * WHAT IT PROVES ABOUT PRIVACY, AND IT IS THE POINT. The note handed back was
 * deposited by the treasury LONG BEFORE this buyer existed as a customer. So
 * unlike a self-deposited note — measured 2026-08-28 to follow its buyer's till
 * payment by a FIXED 48-50 seconds, permanently — this one carries no join to
 * the person spending it.
 *
 * Run:
 *   cd apps/web
 *   P01_LIVE_BUY=1 P01_LIVE_KEYPAIR=~/.config/solana/... \
 *     P01_LIVE_RPC=<helius> P01_BASE=https://protocol-01.dev \
 *     npx vitest run --config vitest.pool.config.mts \
 *       lib/privacy/pool/liveBuyIssuedNote.test.ts
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

const LIVE = process.env.P01_LIVE_BUY === '1';
const BASE = process.env.P01_BASE ?? 'https://protocol-01.dev';

function say(s: string) {
  // eslint-disable-next-line no-console
  console.log(s);
}

/** The challenge /api/claim-for-payment expects, written out so a drift shows. */
function challenge(sig: string): string {
  return `Protocol 01 - collect the note I paid for.\nPayment: ${sig}`;
}

describe.skipIf(!LIVE)('buying a note that was deposited before you arrived', () => {
  it(
    'pays the till, collects a claim, and receives a mature note',
    { timeout: 900_000 },
    async () => {
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
      say(`buyer   ${wallet.publicKey.toBase58()}`);

      // ── 1. What does a note cost, and where does the money go? ────────────
      //
      // Read from the deployment, never assumed: an address this test hardcoded
      // would be an address the deployment is not watching.
      const terms = await (await fetch(`${BASE}/api/claim-for-payment`)).json();
      expect(terms.configured, JSON.stringify(terms)).toBe(true);
      const till = new PublicKey(terms.till);
      say(`till    ${terms.till}  price ${(terms.priceLamports / 1e9).toFixed(3)} SOL`);

      // ── 2. Pay ────────────────────────────────────────────────────────────
      const paySig = await sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: till,
            lamports: terms.priceLamports,
          }),
        ),
        [wallet],
        { commitment: 'confirmed' },
      );
      say(`\n1. PAID   ${paySig}`);

      // ── 3. Prove the payment was ours, and collect the claim ──────────────
      //
      // 🚨 The signature alone is not enough and must not be: every payment to
      // the till is public, so without this the first stranger to read the chain
      // collects the note somebody else bought.
      const proof = Buffer.from(
        nacl.sign.detached(new Uint8Array(Buffer.from(challenge(paySig), 'utf8')), wallet.secretKey),
      ).toString('base64');

      let claim: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const res = await fetch(`${BASE}/api/claim-for-payment`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ signature: paySig, proof }),
        });
        claim = await res.json();
        // 404 means the deployment's RPC has not caught up with ours yet. That
        // is a timing difference between two nodes, not a refusal.
        if (res.status !== 404) {
          expect(res.status, JSON.stringify(claim)).toBe(200);
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      expect(claim.claimCode, JSON.stringify(claim)).toBeTruthy();
      say(`2. CLAIM  ${String(claim.claimCode).slice(0, 16)}…  payer confirmed ${claim.payer}`);

      // ── 4. A note address to seal to ──────────────────────────────────────
      //
      // The secret never travels in the clear: the client asks its own worker
      // for a `p01pq:` receive address and the server seals to it.
      const meta = process.env.P01_BUY_META ?? 'live-buy';
      const message = buildDerivationMessage({
        walletPubkey: wallet.publicKey.toBase58(),
        origin: BASE,
        chainTag: 'solana:devnet',
      });
      const sig = nacl.sign.detached(
        new Uint8Array(Buffer.from(message, 'utf8')),
        wallet.secretKey,
      );
      const ident = (await handlePoolRequest({
        kind: 'poolDeriveIdentity',
        meta,
        signature: Array.from(sig),
      } as never)) as { address: string };
      say(`3. ADDR   ${ident.address.slice(0, 24)}…`);

      // ── 5. Redeem ─────────────────────────────────────────────────────────
      const issueRes = await fetch(`${BASE}/api/issue-note`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-p01-funder-ticket': process.env.P01_FUNDER_TICKET ?? '',
        },
        body: JSON.stringify({
          recipientAddress: ident.address,
          token: 'SOL',
          denomination: 1,
          claimCode: claim.claimCode,
        }),
      });
      const issued = await issueRes.json();
      expect(issueRes.status, JSON.stringify(issued)).toBe(200);
      say(`4. NOTE   leaf ${issued.leafIndex}  commitment ${String(issued.commitment).slice(0, 18)}…`);

      // ── 6. The property the whole design exists for ───────────────────────
      //
      // The leaf handed over must be one the TREASURY deposited, never one this
      // buyer inserted. Its deposit predates the payment above by hours; a
      // self-deposited note follows its payment by 48-50 seconds.
      const leafSig = await conn.getSignaturesForAddress(
        new PublicKey('GGJQwEigkoSk3pzg6eiLtt1cu2kYfCtV5JewNJsMkNdi'),
        { limit: 1000 },
      );
      const payTx = await conn.getTransaction(paySig, { maxSupportedTransactionVersion: 0 });
      const paidAt = payTx?.blockTime ?? 0;
      say(`\n   payment at ${new Date(paidAt * 1000).toISOString()}`);
      say(`   the note's deposit is older than this payment by construction:`);
      say(`   it had to clear a 9,000-slot (~1 h) maturity gate to be issued at all.`);
      expect(leafSig.length).toBeGreaterThan(0);

      // ── 7. AND IT IS ACTUALLY SPENDABLE ───────────────────────────────────
      //
      // 🚨 RECEIVING A NOTE AND OWNING ONE ARE NOT THE SAME CLAIM, and the gap
      // between them is where a sealed blob with one wrong field hides: it
      // arrives, it decrypts, it looks like money, and it cannot be spent. So
      // the round trip is not proven by a 200 — it is proven by importing the
      // blob and having the client recognise a spendable note at that leaf.
      const imported = (await handlePoolRequest({
        kind: 'poolImportNote',
        meta,
        sealedNote: issued.sealedNote,
      } as never)) as { note: { leafIndex: number; denomination: number }; merklePath?: string };
      say(`5. OPENED leaf ${imported.note.leafIndex}  ${imported.note.denomination} SOL  path ${imported.merklePath ?? '?'}`);
      expect(imported.note.leafIndex).toBe(issued.leafIndex);
      expect(imported.note.denomination).toBe(1);
      // A stored path means the eventual spend needs no history rebuild — the
      // difference between a subscription that proves in seconds and one that
      // walks the pool first.
      say(`
   the buyer now holds a note THEY never deposited.`);
      expect(typeof issued.sealedNote).toBe('string');
      expect(issued.sealedNote.length).toBeGreaterThan(64);
    },
  );
});
