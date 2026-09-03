/**
 * The note-in exchange, against the LIVE deployment. Nothing had ever run it.
 *
 * ⛔ INERT unless `P01_LIVE_BUY=1`. It spends real devnet SOL: the note being
 * given up leaves the pool for the till, and the circuit-7 withdrawal fronts a
 * float that is mostly swept back (the nullifier rent is not).
 *
 *   hold a 1 SOL note  ->  withdraw it on circuit 7 with the TILL as recipient
 *   ->  /api/claim-for-payment with the ephemeral's proof  ->  a claim code
 *   ->  /api/issue-note  ->  an OLDER note the buyer never deposited
 *
 * # What is actually being measured here
 *
 * Three things that existed only as unit tests until this file ran:
 *
 *   1. the worker signing the claim challenge with the withdrawal ephemeral
 *      (`signClaim`), the only key the buyer controls in that transaction;
 *   2. `/api/claim-for-payment` CLASSIFYING a pool withdrawal instead of a
 *      plain transfer -- program id, the v4 discriminator, the till as the
 *      instruction's last account -- on a real transaction, whose message is
 *      whatever `getTransaction` hands back rather than a fixture;
 *   3. the floor: a withdrawal credits the till the denomination MINUS the
 *      0.5 percent unshield fee, so 995,000,000 lamports for a 1 SOL note,
 *      and the route must accept that and not the round number.
 *
 * A failure of (2) is a 402 with the plain-transfer floor in the message; a
 * failure of (3) is a 402 quoting 1,000,000,000. Both are named below rather
 * than left to a generic assertion, because a wrong floor and a missed
 * classification look identical from the client.
 *
 * 🚨 THE SPEND HAPPENS BEFORE THE CLAIM. If the claim step fails, the note is
 * gone and the till holds its value: the code and the withdrawal signature are
 * written to the record file the moment they exist, so a rerun can collect the
 * note the payment already bought rather than paying twice.
 *
 * Run:
 *   cd apps/web
 *   P01_LIVE_BUY=1 P01_LIVE_KEYPAIR=~/.config/solana/v4-payer.json \
 *     P01_LIVE_RPC=<helius> P01_BASE=https://protocol-01.dev \
 *     P01_FUNDER_TICKET=<the public ticket> P01_LIVE_RECORD=<file.json> \
 *     npx vitest run --config vitest.pool.config.mts \
 *     lib/privacy/pool/liveNoteInExchange.test.ts
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

import './liveWorkerShim';
import { configurePoolHandlers, handlePoolRequest } from '../worker/poolHandlers';
import { claimChallenge } from '../claimChallenge';

/** `handlePoolRequest` is typed over a closed union; these harness calls read
 *  fields off the responses, so each one names the shape it uses. */
async function call<T>(req: unknown, onProgress?: (s: string) => void): Promise<T> {
  return (await handlePoolRequest(req as never, onProgress)) as T;
}

const LIVE = process.env.P01_LIVE_BUY === '1';
const BASE = process.env.P01_BASE ?? 'https://protocol-01.dev';
const RPC = process.env.P01_LIVE_RPC ?? 'https://api.devnet.solana.com';
const RECORD = process.env.P01_LIVE_RECORD;
const TICKET = process.env.P01_FUNDER_TICKET ?? '';

const DENOMINATION = 1;
/** 1 SOL minus the 0.5 percent unshield fee: what the till must actually receive. */
const EXPECTED_TILL_CREDIT = 995_000_000;

function say(s: string) {
   
  console.log(s);
}

function loadKeypair(): Keypair {
  const path = (process.env.P01_LIVE_KEYPAIR ?? '').replace(
    /^~/,
    process.env.USERPROFILE ?? process.env.HOME ?? '',
  );
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

interface Progress {
  spendSig?: string;
  claimProof?: string;
  claimCode?: string;
  gaveUpLeaf?: number;
  receivedLeaf?: number;
  sealedNote?: string;
  tillCredit?: number;
  landedAt?: string;
}

describe.skipIf(!LIVE)('the note-in exchange, live', () => {
  it(
    'gives up a note to the till and collects an older one the buyer never deposited',
    { timeout: 1_800_000 },
    async () => {
      const wallet = loadKeypair();
      const conn = new Connection(RPC, 'confirmed');
      configurePoolHandlers(RPC);
      say(`buyer   ${wallet.publicKey.toBase58()}`);

      const meta = process.env.P01_EXCHANGE_META ?? 'live-note-in-exchange';
      const identitySig = sha256(concatBytes(wallet.secretKey.slice(0, 32), utf8ToBytes(meta)));
      await call<unknown>({
        kind: 'poolDeriveIdentity',
        meta,
        signature: Array.from(identitySig),
      });

      const progressFile = RECORD ? `${RECORD}.progress.json` : null;
      const held: Progress =
        progressFile && existsSync(progressFile)
          ? (JSON.parse(readFileSync(progressFile, 'utf8')) as Progress)
          : {};
      const keep = () => {
        if (progressFile) writeFileSync(progressFile, JSON.stringify(held, null, 2));
      };

      // ------------------------------------------------------ 0. the terms
      const terms = await (await fetch(`${BASE}/api/claim-for-payment`)).json();
      expect(terms.configured, JSON.stringify(terms)).toBe(true);
      const till = new PublicKey(terms.till);
      say(`till    ${terms.till}  price ${(terms.priceLamports / 1e9).toFixed(3)} SOL`);
      // The route publishes the withdrawal floor since the classifier landed;
      // an older deployment answers undefined and would refuse this spend.
      say(`floor   transfer ${terms.priceLamports} | withdrawal ${terms.withdrawalFloorLamports ?? 'ABSENT'}`);
      expect(
        terms.withdrawalFloorLamports,
        'the deployment predates the pool-withdrawal classifier; deploy before spending',
      ).toBe(EXPECTED_TILL_CREDIT);

      const stock = await (await fetch(`${BASE}/api/issue-note`)).json();
      say(`stock   ${JSON.stringify(stock).slice(0, 160)}`);

      // ------------------------------------------- 1. the note to give up
      let leafIndex = held.gaveUpLeaf ?? -1;
      if (held.spendSig) {
        say(`resuming after the withdrawal ${held.spendSig} (leaf ${leafIndex})`);
      } else {
        const scan = await call<{ notes?: Array<{ leafIndex: number; spent: boolean }> }>({
          kind: 'poolScan',
          meta,
          token: 'SOL',
          denomination: DENOMINATION,
        });
        const unspent = (scan.notes ?? []).filter((n) => !n.spent);
        if (unspent.length > 0) {
          leafIndex = unspent[0].leafIndex;
          say(`  reusing unspent note at leaf ${leafIndex}`);
        } else {
          say('  no unspent note for this identity - shielding one');
          const prep = await call<{ jobId: string; ephemeralPubkey: string; requiredLamports: number }>(
            { kind: 'poolShieldPrepare', meta, token: 'SOL', denomination: DENOMINATION },
            (st: string) => say(`  shield-prepare: ${st}`),
          );
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
          say(`  funded shield signer with ${prep.requiredLamports}`);
          const shielded = await call<{ txSig: string; leafIndex: number }>(
            { kind: 'poolShieldExecute', jobId: prep.jobId, ownerPubkey: wallet.publicKey.toBase58() },
            (st: string) => say(`  shield-execute: ${st}`),
          );
          say(`  SHIELD LANDED: ${shielded.txSig} | leaf ${shielded.leafIndex}`);
          leafIndex = shielded.leafIndex;
          // The prepare rebuilds the path from history; give the RPC a moment.
          await new Promise((r) => setTimeout(r, 15_000));
        }
        held.gaveUpLeaf = leafIndex;
        keep();
      }
      expect(leafIndex).toBeGreaterThanOrEqual(0);

      // ------------------------------------- 2. withdraw it TO THE TILL
      if (!held.spendSig) {
        const prep = await call<{
          jobId: string;
          ephemeralPubkey: string;
          requiredLamports: number;
          version: string;
        }>(
          {
            kind: 'poolUnshieldPrepare',
            meta,
            token: 'SOL',
            denomination: DENOMINATION,
            leafIndex,
            recipient: till.toBase58(),
            ownerPubkey: wallet.publicKey.toBase58(),
          },
          (st: string) => say(`  unshield-prepare: ${st}`),
        );
        say(`  route ${prep.version} | job ${prep.jobId} | float ${prep.requiredLamports}`);
        // v3 republishes the note commitment; the exchange refuses it client-side
        // and the worker refuses to sign a claim on it.
        expect(prep.version, 'the exchange must not fall back to the v3 pair').toBe('v4');

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
        say(`  funded ${prep.ephemeralPubkey} with ${prep.requiredLamports}`);

        const done = await call<{ txSig: string; feePayer?: string; claimProof?: string }>(
          {
            kind: 'poolUnshieldExecute',
            jobId: prep.jobId,
            ownerPubkey: wallet.publicKey.toBase58(),
            sweepTo: wallet.publicKey.toBase58(),
            signClaim: true,
          },
          (st: string) => say(`  unshield-execute: ${st}`),
        );
        held.spendSig = done.txSig;
        held.claimProof = done.claimProof;
        held.landedAt = new Date().toISOString();
        keep();
        say(`  WITHDRAWAL TO THE TILL: ${done.txSig}`);
        say(`  fee payer ${done.feePayer} | proof ${done.claimProof ? 'signed' : 'MISSING'}`);
        expect(done.claimProof, 'the worker returned no claim proof').toBeTruthy();
        expect(done.feePayer, 'the worker did not report the fee payer').toBeTruthy();
      }

      // What the till actually received, from the transaction itself.
      const tx = await conn.getTransaction(held.spendSig!, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      expect(tx, 'the withdrawal is not on chain').toBeTruthy();
      expect(tx!.meta?.err, `the withdrawal reverted: ${JSON.stringify(tx!.meta?.err)}`).toBeNull();
      const keys = tx!.transaction.message.staticAccountKeys ?? [];
      const tillIdx = keys.findIndex((k) => k.equals(till));
      expect(tillIdx, 'the till is not an account of the withdrawal').toBeGreaterThanOrEqual(0);
      const credit = (tx!.meta!.postBalances[tillIdx] ?? 0) - (tx!.meta!.preBalances[tillIdx] ?? 0);
      held.tillCredit = credit;
      keep();
      say(`  the till received ${credit} lamports (expected ${EXPECTED_TILL_CREDIT})`);
      expect(credit).toBe(EXPECTED_TILL_CREDIT);
      // The buyer's wallet funded the ephemeral, so it is one hop away, but it
      // must not be IN the transaction that pays the till.
      expect(
        keys.some((k) => k.equals(wallet.publicKey)),
        'the buyer wallet is an account of the transaction that pays the till',
      ).toBe(false);

      // ------------------------------------------------- 3. the claim
      if (!held.claimCode) {
        // The proof is the ephemeral's, over the challenge the route rebuilds.
        say(`  challenge "${claimChallenge(held.spendSig!).split('\n')[0]}..."`);
        let claim: Record<string, unknown> = {};
        let status = 0;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const res = await fetch(`${BASE}/api/claim-for-payment`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ signature: held.spendSig, proof: held.claimProof }),
          });
          status = res.status;
          claim = await res.json();
          if (status !== 404) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
        say(`  claim-for-payment -> ${status} ${JSON.stringify(claim).slice(0, 200)}`);
        expect(
          status,
          status === 402
            ? 'the route refused the amount: either it did not classify the withdrawal ' +
              '(it is comparing against the plain-transfer floor) or the floor is wrong'
            : `claim-for-payment refused: ${JSON.stringify(claim)}`,
        ).toBe(200);
        expect(claim.kind, 'the route did not classify this as a pool withdrawal').toBe(
          'pool-withdrawal',
        );
        held.claimCode = String(claim.claimCode);
        keep();
        say(`  CLAIM ${held.claimCode.slice(0, 16)}...`);
      }

      // ------------------------------------------- 4. collect the older note
      if (!held.sealedNote) {
        const ident = await call<{ address: string }>({ kind: 'poolNoteAddress', meta });
        const issueRes = await fetch(`${BASE}/api/issue-note`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': TICKET },
          body: JSON.stringify({
            recipientAddress: ident.address,
            token: 'SOL',
            denomination: DENOMINATION,
            claimCode: held.claimCode,
          }),
        });
        const issued = await issueRes.json();
        say(`  issue-note -> ${issueRes.status} leaf ${issued.leafIndex}`);
        expect(issueRes.status, JSON.stringify(issued)).toBe(200);
        held.sealedNote = issued.sealedNote;
        held.receivedLeaf = issued.leafIndex;
        keep();
      }

      const imported = await call<{ note: { leafIndex: number; denomination: number } }>({
        kind: 'poolImportNote',
        meta,
        sealedNote: held.sealedNote,
      });
      expect(imported.note.denomination).toBe(DENOMINATION);
      expect(imported.note.leafIndex).toBe(held.receivedLeaf);
      // The whole point: what came back is not what went in.
      expect(
        imported.note.leafIndex,
        'the exchange handed back the same leaf that was given up',
      ).not.toBe(held.gaveUpLeaf);
      say(
        `  EXCHANGED leaf ${held.gaveUpLeaf} -> leaf ${imported.note.leafIndex}, ` +
          'deposited by the treasury before this buyer existed',
      );

      if (RECORD) {
        writeFileSync(
          RECORD,
          JSON.stringify(
            {
              flow: 'note-in-exchange',
              spendSig: held.spendSig,
              claimKind: 'pool-withdrawal',
              gaveUpLeaf: held.gaveUpLeaf,
              receivedLeaf: imported.note.leafIndex,
              tillCreditLamports: held.tillCredit,
              denomination: DENOMINATION,
              landedAt: held.landedAt,
              base: BASE,
            },
            null,
            2,
          ),
        );
        say(`  record written to ${RECORD}`);
      }
    },
  );
});
