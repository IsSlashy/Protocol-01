/**
 * The founder's scenario, end to end against the LIVE deployment: pay the
 * treasury, collect an OLDER note the buyer never deposited, subscribe with it
 * on circuit 7, and write the license key the buyer would paste at a merchant.
 *
 * ⛔ INERT unless `P01_LIVE_BUY=1`. It spends real devnet SOL (the note's price
 * at the till, then the circuit-7 float, most of which is swept back) and
 * consumes one note of the deployment's inventory.
 *
 *   pay the till -> /api/claim-for-payment -> /api/issue-note -> import
 *   -> poolSubscribePrepare (v4) -> fund -> poolSubscribeExecute -> key
 *
 * The first half is `liveBuyIssuedNote.test.ts` verbatim; what this file adds
 * is the subscribe with the ISSUED note and the record the merchant-side
 * check reads (`packages/merchant-sdk/scripts/verify-live-license.mjs`). The
 * question it answers is not "does a key work" (measured on a self-shielded
 * note the same day) but "does the key work when the note came from the
 * exchange", where the note's secret was derived by the treasury and reaches
 * the worker as a received blob rather than from the buyer's own seed.
 *
 * Re-runs: after step 4 the sealed note is written next to the record
 * (`<record>.note.json`). A later run that finds that file skips the purchase
 * and subscribes with the note it already holds, so a failure in the second
 * half does not cost another SOL.
 *
 * Run:
 *   cd apps/web
 *   P01_LIVE_BUY=1 P01_LIVE_KEYPAIR=~/.config/solana/v4-payer.json \
 *     P01_LIVE_RPC=<helius> P01_BASE=https://protocol-01.dev \
 *     P01_FUNDER_TICKET=<the public ticket> P01_LIVE_RECORD=<file.json> \
 *     npx vitest run --config vitest.pool.config.mts \
 *       lib/privacy/pool/liveIssuedNoteSubscribeV4.test.ts
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import nacl from 'tweetnacl';

import './liveWorkerShim';
import { configurePoolHandlers, handlePoolRequest } from '../worker/poolHandlers';
import { buildDerivationMessage } from '@/lib/privacy/message';

const LIVE = process.env.P01_LIVE_BUY === '1';
const BASE = process.env.P01_BASE ?? 'https://protocol-01.dev';
const RPC = process.env.P01_LIVE_RPC ?? 'https://api.devnet.solana.com';
const RECORD = process.env.P01_LIVE_RECORD;

/** The inventory is 1 SOL notes; the terms fit ten periods inside one. */
const DENOMINATION = 1;
const RATE = String(100_000_000);
const INTERVAL_SLOTS = String(1_500);

function say(s: string) {
  // eslint-disable-next-line no-console
  console.log(s);
}

/** The challenge /api/claim-for-payment expects, written out so a drift shows. */
function challenge(sig: string): string {
  return `Protocol 01 - collect the note I paid for.\nPayment: ${sig}`;
}

function loadKeypair(): Keypair {
  const path = (process.env.P01_LIVE_KEYPAIR ?? '').replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? '');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

interface HeldNote {
  sealedNote: string;
  leafIndex: number;
  commitment: string;
  paySig: string | null;
  claimCode: string | null;
}

describe.skipIf(!LIVE)('a subscription paid with a note the buyer never deposited', () => {
  it(
    'buys an older note from the treasury, subscribes with it on circuit 7, and gets a license key',
    { timeout: 1_500_000 },
    async () => {
      const wallet = loadKeypair();
      const conn = new Connection(RPC, 'confirmed');
      configurePoolHandlers(RPC);
      say(`buyer   ${wallet.publicKey.toBase58()}`);

      // The worker identity the note is sealed to. Same message the web app
      // signs, so the blob the deployment returns opens here.
      const meta = process.env.P01_BUY_META ?? 'live-buy-subscribe';
      const message = buildDerivationMessage({
        walletPubkey: wallet.publicKey.toBase58(),
        origin: BASE,
        chainTag: 'solana:devnet',
      });
      const identitySig = nacl.sign.detached(new Uint8Array(Buffer.from(message, 'utf8')), wallet.secretKey);
      const ident = (await handlePoolRequest({
        kind: 'poolDeriveIdentity',
        meta,
        signature: Array.from(identitySig),
      } as never)) as { address: string };
      say(`address ${ident.address.slice(0, 24)}…`);

      // ------------------------------------------------ 1-4. buy, or reuse
      // Everything the buyer holds between steps is written here as soon as it
      // exists: the claim code right after the payment (a ticket mismatch at
      // issue-note must not strand the SOL), the sealed note right after it
      // is issued. A re-run resumes from whatever the file already holds.
      const noteFile = RECORD ? `${RECORD}.note.json` : null;
      const keep = (h: Partial<HeldNote>) => {
        if (noteFile) writeFileSync(noteFile, JSON.stringify(h, null, 2));
      };
      let held: Partial<HeldNote> =
        noteFile && existsSync(noteFile) ? (JSON.parse(readFileSync(noteFile, 'utf8')) as Partial<HeldNote>) : {};
      if (held.sealedNote) {
        say(`reusing the note bought earlier: leaf ${held.leafIndex}`);
      } else {
        if (!held.claimCode) {
          const terms = await (await fetch(`${BASE}/api/claim-for-payment`)).json();
          expect(terms.configured, JSON.stringify(terms)).toBe(true);
          const till = new PublicKey(terms.till);
          say(`till    ${terms.till}  price ${(terms.priceLamports / 1e9).toFixed(3)} SOL`);

          const paySig = await sendAndConfirmTransaction(
            conn,
            new Transaction().add(
              SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: till, lamports: terms.priceLamports }),
            ),
            [wallet],
            { commitment: 'confirmed' },
          );
          say(`1. PAID   ${paySig}`);
          held = { paySig };
          keep(held);

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
            if (res.status !== 404) {
              expect(res.status, JSON.stringify(claim)).toBe(200);
              break;
            }
            await new Promise((r) => setTimeout(r, 3000));
          }
          expect(claim.claimCode, JSON.stringify(claim)).toBeTruthy();
          held.claimCode = String(claim.claimCode);
          keep(held);
          say(`2. CLAIM  ${held.claimCode.slice(0, 16)}… (kept in full at ${noteFile ?? 'nowhere: set P01_LIVE_RECORD'})`);
        } else {
          say(`reusing the claim code from the earlier payment ${held.paySig}`);
        }

        const issueRes = await fetch(`${BASE}/api/issue-note`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-p01-funder-ticket': process.env.P01_FUNDER_TICKET ?? '',
          },
          body: JSON.stringify({
            recipientAddress: ident.address,
            token: 'SOL',
            denomination: DENOMINATION,
            claimCode: held.claimCode,
          }),
        });
        const issued = await issueRes.json();
        expect(issueRes.status, JSON.stringify(issued)).toBe(200);
        say(`3. NOTE   leaf ${issued.leafIndex}  commitment ${String(issued.commitment).slice(0, 18)}…`);
        held = {
          ...held,
          sealedNote: issued.sealedNote,
          leafIndex: issued.leafIndex,
          commitment: String(issued.commitment),
        };
        keep(held);
        if (noteFile) say(`   sealed note kept at ${noteFile} for a re-run`);
      }
      expect(held.sealedNote).toBeTruthy();
      expect(typeof held.leafIndex).toBe('number');
      const sealedNote = held.sealedNote as string;
      const leafIndex = held.leafIndex as number;

      const imported = (await handlePoolRequest({
        kind: 'poolImportNote',
        meta,
        sealedNote,
      } as never)) as { note: { leafIndex: number; denomination: number }; encryptedNote: string };
      expect(imported.note.leafIndex).toBe(leafIndex);
      expect(imported.note.denomination).toBe(DENOMINATION);
      expect(typeof imported.encryptedNote).toBe('string');
      say(`4. OPENED leaf ${imported.note.leafIndex}  ${imported.note.denomination} SOL, the buyer never deposited it`);

      // ------------------------------------------------ 5. prepare (v4)
      const retailerKp = Keypair.fromSeed(
        sha256(concatBytes(wallet.secretKey.slice(0, 32), utf8ToBytes('p01:issued-subscribe-retailer:v1'))),
      );
      const retailer = retailerKp.publicKey;
      say(`retailer ${retailer.toBase58()}`);

      const prep = await handlePoolRequest({
        kind: 'poolSubscribePrepare',
        meta,
        token: 'SOL',
        denomination: DENOMINATION,
        leafIndex,
        encryptedNotes: [imported.encryptedNote],
        retailer: retailer.toBase58(),
        rate: RATE,
        intervalSlots: INTERVAL_SLOTS,
        serviceId: null,
      });
      say(`5. ROUTE  ${prep.version} | job ${prep.jobId} | float ${prep.requiredLamports}`);
      // An issued note carries a 63-bit blinding, so circuit 7 must take it.
      // A v3 fallback here would still mint a valid key but would republish
      // the treasury's deposit commitment; it is a regression, not a variant.
      expect(prep.version).toBe('v4');

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
      say(`   funded ${prep.ephemeralPubkey} with ${prep.requiredLamports}`);

      // ------------------------------------------------ 6. execute (v4)
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
      const landedAt = new Date().toISOString();
      say(`6. LANDED ${done.txSig}`);
      say(`   vault ${done.vaultPDA} | service tag ${done.serviceTag}`);
      expect(done.txSig).toBeTruthy();
      expect(done.licenseKey, 'the subscribe returned no license key').toMatch(/^P01-/);

      const tx = await conn.getTransaction(done.txSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      expect(tx, 'the subscribe signature is not on chain').toBeTruthy();
      expect(tx!.meta?.err, `the subscription reverted: ${JSON.stringify(tx!.meta?.err)}`).toBeNull();

      if (RECORD) {
        writeFileSync(
          RECORD,
          JSON.stringify(
            {
              txSig: done.txSig,
              vaultPDA: done.vaultPDA,
              licenseKey: done.licenseKey,
              serviceTag: done.serviceTag,
              retailer: retailer.toBase58(),
              rate: RATE,
              intervalSlots: INTERVAL_SLOTS,
              denomination: DENOMINATION,
              landedAt,
              noteSource: 'issued',
              issuedLeaf: leafIndex,
              paySig: held.paySig ?? null,
              version: prep.version,
            },
            null,
            2,
          ),
        );
        say(`   record written to ${RECORD}`);
      }
    },
  );
});
