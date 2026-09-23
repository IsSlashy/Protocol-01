import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { Connection, Keypair, PublicKey, type MessageCompiledInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

import { getStore, rateLimitExceeded, type KvLike } from '@/lib/waitlist/store';
import { clientIp } from '@/lib/net/clientIp';
import {
  claimChallenge,
  relayEphemeralChallenge,
  relayEphemeralTag,
  relayEphemeralTagKey,
  relayReturnKey,
  relayReturnOwner,
} from '@/lib/privacy/claimChallenge';
import { activeTreasurySeed } from '@/lib/privacy/treasurySeeds';
import {
  UNSHIELD_FEE_BPS,
  UNSHIELD_V4_DISCRIMINATOR,
  UNSHIELD_V4_RELAYED_DISCRIMINATOR,
  ZK_SHIELDED_PROGRAM_ID,
  fetchPoolCommitments,
  type OnChainCommitment,
} from '@/lib/privacy/pool/denominatedPool';
import {
  contribConfirmedKey,
  contributionBinding,
  counterValue,
  notePaidCodeKey,
  notePaidKey,
  parseContributionRef,
  relayPaymentClaimKey,
  relayPaymentContributionKey,
  resolveContributionPool,
} from '@/lib/privacy/paymentBinding';
import { installKvPoolHistory } from '@/lib/privacy/pool/kvPoolHistory';
import { treasuryCommitmentFor } from '@/app/api/contribute-note/route';

/**
 * claim-for-payment: turn a settled on-chain payment into ONE claim code.
 *
 * WHY THIS EXISTS. `/api/mint-claim` says of itself: "This is a seam, not a
 * payment integration... Until such a webhook exists, an operator calls it by
 * hand." This is that webhook, for the only payment rail this deployment
 * actually has: SOL sent to the till.
 *
 * WHAT IT BUYS, AND IT IS THE POINT OF THE INVENTORY DESIGN. The buyer pays,
 * then receives a note the TREASURY deposited long before they arrived. There
 * is no deposit of theirs anywhere on chain, so the 48-50 second join measured
 * on 2026-08-28, between a buyer paying the till and their own leaf being
 * inserted, does not exist for them. What is left is payment -> spend, and
 * unlike the other gap that one is under the buyer's control: they can wait.
 *
 * TWO SHAPES OF PAYMENT, ONE ROUTE.
 *
 *   `transfer`         a wallet sent lamports to the till. Pays the full price.
 *                      Names the payer, as it always did.
 *
 *   `pool-withdrawal`  a circuit-7 withdrawal whose recipient IS the till: the
 *                      note-in exchange. The pool pays the till the denomination
 *                      minus `UNSHIELD_FEE_BPS`, so the floor is lowered by
 *                      exactly that, and the fee payer is the withdrawal's
 *                      ephemeral, whose secret only the worker holds. The
 *                      buyer's wallet is in no transaction here. What remains
 *                      is the ephemeral's funding edge from the float, the
 *                      nullifier, and the clock.
 *
 * AND ONE MORE CASE, WHICH IS NOT A SALE. A payment that funded a RELAYED
 * DEPOSIT (`p01:relay:payment:<sig>` exists) belongs to a contribution. If that
 * deposit landed, the claim is collected through `/api/contribute-note`
 * confirm; if it did not, this route is the fallback, and it mints under the
 * same `p01:note:paid:<sig>` gate so the two can never both pay.
 *
 * IT DOES NOT MAKE A TRANSFER PRIVATE. Paying the till from a wallet names the
 * payer. This moves the join; it does not delete it.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// [CACHE-1] The pool history this route walks is shared by every isolate
// through one KV row per pool that holds public chain data only
// (`lib/privacy/pool/kvPoolHistory.test.ts`).
installKvPoolHistory();

/** Re-exported for the route's existing importers; the worker imports the module directly. */
export { claimChallenge };

const RATE_SALT = 'p01:claim-for-payment:v1';
const CLAIMS_PER_IP_PER_HOUR = 12;

/** Devnet genesis. The same guard every sibling route carries. */
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export type PaymentKind = 'transfer' | 'pool-withdrawal';

/**
 * What a note costs, in lamports.
 *
 * A FLOOR, NOT AN EQUALITY. Paying MORE must never be refused: this route
 * runs after the money has moved, so a 400 on an overpayment leaves the buyer
 * out of pocket with nothing. Underpayment is refused WITHOUT consuming the
 * payment, so they can top up and present the new transaction.
 */
function priceLamports(): number {
  const raw = Number(process.env.P01_NOTE_PRICE_LAMPORTS ?? '');
  if (Number.isInteger(raw) && raw > 0) return raw;
  const denom = Number(process.env.P01_TREASURY_NOTE_DENOMINATION ?? '1');
  return Math.round((Number.isFinite(denom) && denom > 0 ? denom : 1) * 1e9);
}

/**
 * What a withdrawal of one note actually lands at the till: the price minus
 * the pool's own fee (`fee.rs: UNSHIELD_FEE_BPS`, measured "payee +0.995 SOL"
 * on the 1 SOL pool). 995,000,000 for a 1 SOL note.
 *
 * Still `>=`, never `===`: a withdrawal from a larger pool overpays and must
 * be accepted, for the same reason an overpaying transfer is.
 */
function withdrawalFloorLamports(price: number): number {
  return price - Number((BigInt(price) * UNSHIELD_FEE_BPS) / 10_000n);
}

function tillAddress(): string | null {
  const t = process.env.P01_TILL_ADDRESS;
  if (!t) return null;
  try {
    return new PublicKey(t).toBase58();
  } catch {
    return null;
  }
}

/**
 * [close-v1 F70] Unix seconds before which a circuit-7 withdrawal to the till is
 * still sold its note. `null` (unset or unparseable) sells none.
 *
 * WHY A CUTOFF AND NOT A FLAT REFUSAL. A buyer who exchanged before this rule
 * shipped has already spent their note into the till; refusing their claim
 * would keep the note and give nothing. A withdrawal that landed before the
 * operator's cutoff was exposed to the copier exactly as before, so collecting
 * it adds no risk; everything after it is either a stale client or a copier.
 */
function exchangeLegacyCutoff(): number | null {
  const raw = Number(process.env.P01_EXCHANGE_LEGACY_CUTOFF ?? '');
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** The float, whose secret keys the relay's ephemeral tag (`relayEphemeralTag`). */
function funderKeypair(): Keypair | null {
  const raw = process.env.P01_FUNDER_SECRET_KEY?.trim();
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(
      raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw) as number[]) : bs58.decode(raw),
    );
  } catch {
    return null;
  }
}

/**
 * [close-v1 F11] How much of what the float sent a relayed ephemeral may be
 * missing when it is read back: the fees of a failed attempt (the relay's own
 * transfer fee, the ephemeral's signatures, buffers it closed again). 0.01 SOL,
 * 1% of a 1 SOL note; anything short by more is money the caller kept, and
 * Recover is what brings it home.
 */
const RELAYED_RETURN_TOLERANCE_LAMPORTS = 10_000_000;
/** An honest deposit ephemeral signs a few dozen transactions; past this the history is not read. */
const MAX_EPHEMERAL_HISTORY = 400;

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Tell a plain transfer from a circuit-7 withdrawal to the till.
 *
 * Read off `compiledInstructions`, which both a legacy `Message` and a
 * `MessageV0` expose with the same shape (`programIdIndex`,
 * `accountKeyIndexes`, `data`). `getTransaction` returns a legacy message for
 * the direct v4 path, so anything that only understood v0 would silently never
 * match and every note-in would be refused as an underpaid transfer.
 *
 * Each refusal names the failure it prevents:
 *   - the relayed variant: its fee payer is the relayer, a stranger; there is
 *     no buyer-controlled key to sign the claim with.
 *   - a recipient that is not the till: a withdrawal to a third party inside a
 *     transaction that credited the till by some other route must not get the
 *     lowered floor.
 *   - ⛔ [close-v1 F70, verifier round 1] ANY OTHER TRANSACTION THAT NAMES THE
 *     POOL PROGRAM. A copier used to wrap the copied circuit-7 withdrawal in a
 *     program of its own, add a 0.005 SOL top-up to the till, and be sold the
 *     note as a plain `transfer`: the scan above reads top-level instructions
 *     only, and the pool program checks no stack height. A program reached by
 *     CPI must still be passed to the transaction as an account, so naming it
 *     anywhere (static keys, loaded addresses, or an inner instruction) is
 *     enough to refuse, whether or not the RPC returned `innerInstructions`.
 *     A buyer's payment to the till is a plain transfer and never names it.
 *     Refused whatever the operator cutoff says: no honest exchange was ever
 *     wrapped. Pinned by `closeV1L2ClaimRoute.test.ts`, "F70 (round 2)".
 */
type Refusal = { refuse: string; status?: number; code?: string };

const NESTED_POOL_CALL: Refusal = {
  refuse: 'the note-in exchange is disabled on this deployment',
  status: 403,
  code: 'EXCHANGE_DISABLED',
};

function classifyPayment(
  instructions: readonly MessageCompiledInstruction[] | undefined,
  keys: readonly string[],
  till: string,
  allKeys: readonly string[] = keys,
  inner?: ReadonlyArray<{ instructions?: ReadonlyArray<{ programIdIndex: number }> }> | null,
): { kind: PaymentKind } | Refusal {
  const program = ZK_SHIELDED_PROGRAM_ID.toBase58();
  const direct = classifyTopLevel(instructions, keys, till, program);
  if (!('kind' in direct) || direct.kind === 'pool-withdrawal') return direct;
  for (const group of Array.isArray(inner) ? inner : []) {
    for (const ix of Array.isArray(group?.instructions) ? group.instructions : []) {
      if (allKeys[ix.programIdIndex] === program) return NESTED_POOL_CALL;
    }
  }
  if (allKeys.includes(program)) return NESTED_POOL_CALL;
  return direct;
}

function classifyTopLevel(
  instructions: readonly MessageCompiledInstruction[] | undefined,
  keys: readonly string[],
  till: string,
  program: string,
): { kind: PaymentKind } | Refusal {
  for (const ix of Array.isArray(instructions) ? instructions : []) {
    if (keys[ix.programIdIndex] !== program) continue;
    const data = ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data ?? []);
    const disc = data.subarray(0, 8);
    if (sameBytes(disc, UNSHIELD_V4_RELAYED_DISCRIMINATOR)) {
      return {
        refuse:
          'that withdrawal was relayed, so its fee payer is the relayer and no key of yours ' +
          'can claim it; withdraw to the till directly instead',
      };
    }
    if (!sameBytes(disc, UNSHIELD_V4_DISCRIMINATOR)) continue;
    // remaining_accounts[0], the recipient, is the LAST account of the
    // instruction (pinned by `unshieldV4.test.ts`).
    const last = ix.accountKeyIndexes[ix.accountKeyIndexes.length - 1];
    if (last === undefined || keys[last] !== till) {
      return { refuse: 'that withdrawal paid somebody other than the till' };
    }
    return { kind: 'pool-withdrawal' };
  }
  return { kind: 'transfer' };
}

export async function GET() {
  const reasons: string[] = [];
  if (!tillAddress()) reasons.push('P01_TILL_ADDRESS is unset or not a public key.');
  if (!getStore()) reasons.push('No durable KV store, so one payment could mint many claims.');
  if (!process.env.P01_FUNDER_RPC) reasons.push('P01_FUNDER_RPC is unset; payments cannot be read.');
  const price = priceLamports();
  return NextResponse.json({
    ok: true,
    configured: reasons.length === 0,
    till: tillAddress(),
    priceLamports: price,
    /** What a circuit-7 withdrawal to the till must land: the price minus the pool fee. */
    withdrawalFloorLamports: withdrawalFloorLamports(price),
    /**
     * [close-v1 F70] The note-in exchange is OFF: no new withdrawal to the till
     * is sold a note, because the claim goes to the withdrawal's fee payer and
     * a proof copier can be that fee payer. `exchangeLegacyCutoff` is the unix
     * time before which a withdrawal that already landed is still collected.
     */
    exchange: false,
    exchangeLegacyCutoff: exchangeLegacyCutoff(),
    reasons,
  });
}

export async function POST(request: NextRequest) {
  const till = tillAddress();
  if (!till) return bad(503, 'this deployment has no till configured; refusing to sell notes');

  // FAILS CLOSED. Without a durable store one payment could mint an unbounded
  // number of claims, which is the whole inventory given away.
  const kv = getStore();
  if (!kv) return bad(503, 'no durable store; a claim that cannot be recorded must not be minted');

  const ip = clientIp(request);
  try {
    if (await rateLimitExceeded(kv, ip, RATE_SALT, CLAIMS_PER_IP_PER_HOUR)) {
      return bad(429, 'too many claim requests from this address in the last hour');
    }
  } catch {
    // ⛔ THE REFUSAL CARRIES NO TEXT FROM THE STORE. The store words a failure
    // as `${error}, command was: ${JSON.stringify(commands)}` and with
    // auto-pipelining that list holds the commands of every other request
    // batched into the same round trip: another route's claim code, a payment
    // signature, another caller's limiter bucket. This body is printed to the
    // buyer verbatim (`lib/privacy/shieldClient.ts`, the claim-for-payment
    // branch), so interpolating it hands the batch to whoever asked. Fixed
    // words, whatever failed — the same posture as `/api/fund-ephemeral`.
    // Pinned by `__tests__/api/claim-for-payment.test.ts` "a limiter that fails
    // says so without passing on what the store carried", which runs the same
    // failure with two different batches and requires one answer.
    return bad(503, 'the rate limiter could not be read');
  }

  let body: {
    signature?: unknown;
    proof?: unknown;
    contribution?: unknown;
    ephemeral?: unknown;
    ephemeralProof?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad(400, 'send { signature, proof }');
  }
  const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
  const proof = typeof body.proof === 'string' ? body.proof.trim() : '';
  if (!signature) return bad(400, 'signature is required: the transaction that paid the till');
  if (!proof) return bad(400, 'proof is required: sign the challenge with the paying wallet');

  const connection = new Connection(
    process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com',
    'confirmed',
  );

  // Devnet only, checked against the chain rather than a variable: an env var
  // pointing at mainnet and named "devnet" would sell real notes.
  try {
    const genesis = await connection.getGenesisHash();
    if (genesis !== DEVNET_GENESIS) {
      return bad(403, 'this deployment is devnet-only and the configured RPC is not devnet', {
        genesis,
      });
    }
  } catch (e) {
    return bad(502, `the configured RPC could not be reached: ${(e as Error).message}`);
  }

  let payer: string;
  let received: number;
  let kind: PaymentKind;
  let blockTime: number | null = null;
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) return bad(404, 'that payment is not on chain yet; confirm it and retry');
    // [close-v1 F57, verifier round 1] A stable code: the client's resume reads
    // it as "this payment paid nothing", drops the record that named it, and
    // stops refusing new contributions with PAYMENT_OUTSTANDING because of it.
    if (tx.meta.err) {
      return bad(400, 'that transaction failed on chain, so it paid nothing', {
        code: 'PAYMENT_FAILED_ON_CHAIN',
      });
    }
    blockTime = typeof tx.blockTime === 'number' ? tx.blockTime : null;

    const message = tx.transaction.message;
    const keys = message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const idx = keys.indexOf(till);
    if (idx < 0) {
      return bad(400, 'that transaction did not name the address this deployment collects at', {
        till,
      });
    }
    // READ AT THE TILL'S INDEX, NEVER FROM THE REQUEST. An amount the caller
    // states is an amount the caller chooses: the 2026-08-18 leak expressed as
    // an array index.
    received = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0);
    // The fee payer. On a transfer that is the wallet; on a direct withdrawal
    // it is the ephemeral, whose secret only the worker holds.
    payer = keys[0];

    // Every account the transaction loaded, in the order its balances are
    // listed: a program reached by CPI may sit in a lookup table.
    const allKeys = [
      ...keys,
      ...(tx.meta.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
      ...(tx.meta.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
    ];
    const classified = classifyPayment(
      message.compiledInstructions,
      keys,
      till,
      allKeys,
      tx.meta.innerInstructions,
    );
    if ('refuse' in classified) {
      return bad(classified.status ?? 400, classified.refuse, {
        till,
        ...(classified.code
          ? {
              code: classified.code,
              hint:
                'A withdrawal to the till names its submitter as fee payer, and anyone copying ' +
                'its proof can be that submitter, so no note is sold against one, direct or ' +
                'called from another program.',
            }
          : {}),
      });
    }
    kind = classified.kind;
  } catch (e) {
    return bad(502, `the payment could not be read: ${(e as Error).message}`);
  }

  /**
   * ⛔ [close-v1 F70] THE NOTE-IN EXCHANGE SELLS NOTHING NEW.
   *
   * The claim goes to whoever can sign as the withdrawal's fee payer, and the
   * fee payer of a circuit-7 withdrawal is whoever submits it. A stranger who
   * copies the uploaded proof and lands the withdrawal first IS that fee payer,
   * and used to be handed the note the buyer's spent note paid for (audit v1,
   * `r4-client/p2-exchange-claim-copier.test.ts`). The real fix moves the
   * credential off the fee payer; until it ships, no withdrawal is sold a note
   * unless it landed before the operator's cutoff. Refused BEFORE the gate, so
   * nothing is consumed. The client refuses before spending (`EXCHANGE_DISABLED`
   * in `exchangeNoteForIssued`), so an honest buyer never reaches this.
   * Pinned by `__tests__/api/closeV1L2ClaimRoute.test.ts`, F70.
   */
  if (kind === 'pool-withdrawal') {
    const cutoff = exchangeLegacyCutoff();
    if (cutoff === null || blockTime === null || blockTime >= cutoff) {
      return bad(403, 'the note-in exchange is disabled on this deployment', {
        code: 'EXCHANGE_DISABLED',
        hint:
          'A withdrawal to the till names its submitter as fee payer, and anyone copying its ' +
          'proof can be that submitter, so no note is sold against one. A withdrawal that ' +
          'landed before the exchange was switched off is settled through support.',
      });
    }
  }

  const price = priceLamports();
  const floor = kind === 'pool-withdrawal' ? withdrawalFloorLamports(price) : price;
  if (received < floor) {
    return bad(402, 'that transaction paid the till less than a note costs', {
      received,
      priceLamports: price,
      floorLamports: floor,
      kind,
    });
  }

  // THE SIGNATURE IS PUBLIC, SO IT CANNOT BE THE CREDENTIAL. Every payment to
  // the till is visible to anyone reading the chain. Without this check the
  // first stranger to spot one would collect the note it bought. The claim goes
  // only to a caller who can sign as the key that paid: the wallet on a
  // transfer, the withdrawal's ephemeral on a note-in.
  try {
    // Buffer, not TextEncoder. tweetnacl checks `instanceof Uint8Array`, and
    // under a jsdom test environment TextEncoder returns one from a different
    // realm, which throws "unexpected type" on a proof that is perfectly
    // valid. This route is `runtime = 'nodejs'`, so Buffer is always here.
    const ok = nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(claimChallenge(signature), 'utf8')),
      new Uint8Array(Buffer.from(proof, 'base64')),
      new PublicKey(payer).toBytes(),
    );
    if (!ok) return bad(401, 'that proof was not signed by the wallet that made this payment');
  } catch {
    return bad(400, 'proof must be base64 of a 64-byte ed25519 signature');
  }

  /**
   * ⛔ WHAT THIS PAYMENT ALREADY EARNED, ANSWERED BEFORE THE BINDING IS READ.
   *
   * The payer has just proved who they are, and what they are owed depends on
   * their PAYMENT alone. The binding is not permanent — `issue-note` deletes
   * it at redemption along with the code row — so a payer who came back after
   * that used to be told 'that contribution is not the one this payment
   * funded' about a payment that had funded exactly it.
   *
   * `get`, never `incr`: reading must not consume the gate. Pinned by
   * `__tests__/api/claim-for-payment.test.ts` "replays the code this payment
   * bought, even though the binding is gone" and the two refusals beside it.
   */
  const paidKey = notePaidKey(signature);
  let earnedCode: string | null = null;
  let alreadyRedeemed = false;
  try {
    // The counter first, and the code row only once the gate is taken: a code
    // is written only after `incr(paidKey)`, so a counter at 0 means no code.
    // A purchase pays one GET here; replays and refusals pay two. Pinned by
    // "a first sale reads the payment counter, never the code row".
    if (counterValue(await kv.get(paidKey)) >= 1) {
      earnedCode = await kv.get<string>(notePaidCodeKey(signature));
      alreadyRedeemed = !earnedCode;
    }
  } catch (e) {
    return bad(503, `the claim record could not be read: ${(e as Error).message}`);
  }
  if (alreadyRedeemed) {
    // The gate is taken and the code row is gone, which is what redemption
    // leaves behind. Nothing is owed, and a second code would sell this
    // payment twice.
    return bad(409, 'this payment has already been redeemed', {
      hint: 'Its claim code was collected at /api/issue-note, and a note already issued is not issued again.',
    });
  }

  // Did this payment fund a RELAYED DEPOSIT? Then it is a contribution's
  // payment, not a plain sale, and it can only be claimed here as the
  // fallback for a deposit that never landed.
  //
  // ⛔ Skipped once the payment has its code: every refusal in there is about
  // whether a claim may be MINTED, and this one is not minting.
  if (!earnedCode) {
    const relayed = await relayedContribution(kv, connection, signature, body);
    if (relayed instanceof NextResponse) return relayed;
  }

  // One payment, one claim, and the SAME claim on a retry.
  //
  // IDEMPOTENT ON PURPOSE. A buyer who lost the response has already paid.
  // Minting a second code sells one payment twice; refusing outright keeps
  // their money and gives them nothing. Returning the code they already bought
  // is the only answer that is neither. The gate is shared with the confirm of
  // `/api/contribute-note`: whichever runs first mints, the other replays.
  let claimCode = earnedCode ?? '';
  if (!claimCode) {
    try {
      const first = await kv.incr(paidKey);
      if (first === 1) {
        claimCode = randomBytes(32).toString('base64url');
        /**
         * ⛔ [close-v1 F63] THE GATE IS GIVEN BACK IF EITHER WRITE FAILS.
         *
         * The gate above is the only thing that says "this payment is sold".
         * A transient store error on the next write used to leave it taken with
         * no code anywhere, and every retry answered 409 "already redeemed"
         * about a purchase that never got its code (audit v1,
         * `r3-server/p4/probe-claim-store-blip.mts`). So: the redeemable row
         * first (a random code nobody knows yet), the replay row second, and on
         * any failure both are deleted and the gate released, so the retry
         * mints exactly one code. Pinned by `closeV1L2ClaimRoute.test.ts`, F63.
         */
        const mintedKey = `p01:note:claim-minted:${claimCode}`;
        try {
          // The claim itself, in the shape /api/issue-note redeems. No expiry: see
          // the founder ruling in mint-claim, a bearer asset somebody bought is not
          // a liability to be timed out.
          // Written as the literal key, not through `mintedKey`: the writer scan
          // in `issue-note.node.test.ts` reads the shape off this very line.
          await kv.set(`p01:note:claim-minted:${claimCode}`, `payment:${signature}`);
          await kv.set(notePaidCodeKey(signature), claimCode);
        } catch {
          for (const k of [mintedKey, notePaidCodeKey(signature), paidKey]) {
            try {
              await kv.del(k);
            } catch {
              /* best effort: a store that cannot delete leaves the gate as before */
            }
          }
          return bad(
            503,
            'the claim could not be recorded; nothing was sold, so ask again with the same payment',
          );
        }
        /**
         * 🚨 THE PAYMENT IS MARKED, NEVER THE LEAF. This branch runs only for a
         * deposit this route has just PROVEN is not on the tree, so the leaf
         * holds nothing.
         *
         * It used to `incr` `contrib-confirmed:<pool>:<leaf>` and write a
         * per-leaf claim row here, with no TTL and no writer that ever cleared
         * them, and that poisoned the index for whoever came next. The reserve
         * loop in `/api/contribute-note` reclaims a leaf the tree never reached
         * after `RECLAIM_AFTER_MS` and hands it to the next contributor; that
         * buyer pays, deposits honestly, and is then refused by confirm ("this
         * contribution was already confirmed under a different payment", which
         * also gives their payment gate back) and by this route ("already
         * confirmed; collect its code through confirm"), each pointing at the
         * other. Money spent, no note, no way out.
         *
         * Nothing is lost by dropping the writes. The replay that mattered runs
         * off the payment: a confirm of a deposit that lands after all reads
         * `p01:note:paid:<sig>:code` - this code - before it reads anything
         * about the leaf. The per-leaf rows were never read by anything, and
         * `/api/contribute-note` stopped writing its own in KV-1.
         */
      } else {
        // A concurrent request took the gate between the read above and this
        // increment. Hand back its code if it has been written, and refuse
        // otherwise rather than mint a second one.
        const existing = await kv.get<string>(notePaidCodeKey(signature));
        if (!existing) {
          return bad(409, 'this payment has already been redeemed', {
            hint: 'If its claim code was issued and not yet used, ask again with the same payment.',
          });
        }
        claimCode = existing;
      }
    } catch (e) {
      return bad(503, `the claim could not be recorded: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    claimCode,
    kind,
    payer,
    received,
    priceLamports: price,
    floorLamports: floor,
    expires: false,
    note:
      kind === 'pool-withdrawal'
        ? 'Redeem this at /api/issue-note. The note you receive was deposited by the treasury ' +
          'long before you paid. Your withdrawal named an ephemeral, not your wallet; what still ' +
          'ties the two is the float that funded it, the nullifier, and the clock.'
        : 'Redeem this at /api/issue-note. The note you receive was deposited by the treasury ' +
          'long before you paid, so no deposit of yours exists on chain. Your payment to the ' +
          'till is still public and names you; waiting before you spend is what dilutes the ' +
          'link between them.',
  });
}

/**
 * The relayed-deposit branch.
 *
 * Returns `null` for a plain sale (no relay claim on this signature), the
 * contribution this payment is bound to when the fallback may mint, or the
 * refusal to send. Every refusal here leaves the payment unconsumed.
 *
 *   - `body.contribution` must equal the binding the relay recorded AFTER it
 *     funded the deposit: a payer cannot point the fallback at somebody else's
 *     reservation.
 *   - already confirmed: the code exists on the leaf, collect it through
 *     confirm. Read with `get`, never `incr`, or reading would confirm.
 *   - the treasury commitment is on the tree: the deposit landed, so the leaf
 *     is stock and confirm is the path that records it as such.
 *
 * ⛔ IT IS NOT REACHED AT ALL once this payment already holds its code. The
 * POST answers that above, before the binding is read, because the binding is
 * deleted at redemption and every refusal in here is about whether a claim may
 * be MINTED. So confirm-then-fallback never arrives at this function, and a
 * missing binding can no longer refuse a payer their own code.
 */
async function relayedContribution(
  kv: KvLike,
  connection: Connection,
  signature: string,
  body: { contribution?: unknown; ephemeral?: unknown; ephemeralProof?: unknown },
): Promise<{ poolKey: string; leafIndex: number } | null | NextResponse> {
  const rawContribution = body.contribution;
  let relayClaim: unknown;
  try {
    relayClaim = await kv.get(relayPaymentClaimKey(signature));
  } catch (e) {
    return bad(503, `the relay record could not be read: ${(e as Error).message}`);
  }
  if (relayClaim === null || relayClaim === undefined) return null;

  const contribution = parseContributionRef(rawContribution);
  if (!contribution) {
    return bad(400, 'this payment funded a relayed deposit; send the contribution it paid for', {
      hint: 'contribution: { token, leafIndex } from the reservation this payment funded.',
    });
  }
  const pool = resolveContributionPool(contribution.token);
  if (!pool) return bad(503, `no ${contribution.token} pool is configured for contributions`);
  const poolKey = pool.poolPDA.toBase58();
  const expected = contributionBinding(poolKey, contribution.leafIndex);

  let binding: string | null;
  let confirmed: unknown;
  try {
    binding = await kv.get<string>(relayPaymentContributionKey(signature));
    confirmed = await kv.get(contribConfirmedKey(poolKey, contribution.leafIndex));
  } catch (e) {
    return bad(503, `the contribution record could not be read: ${(e as Error).message}`);
  }
  if (binding !== expected) {
    return bad(400, 'that contribution is not the one this payment funded', {
      hint: binding
        ? 'The relay recorded a different leaf for this payment.'
        : 'The relay recorded no contribution for this payment, so it cannot be claimed here.',
    });
  }
  const bound = { poolKey, leafIndex: contribution.leafIndex };
  if (counterValue(confirmed) >= 1) {
    return bad(409, 'this contribution was already confirmed; collect its code through confirm', {
      leafIndex: contribution.leafIndex,
      hint: 'POST /api/contribute-note { action: "confirm" } with the same payment and proof.',
    });
  }

  const seed = activeTreasurySeed();
  if (!seed) return bad(503, 'this deployment holds no treasury and cannot check the deposit');
  let commitments: Map<string, OnChainCommitment>;
  try {
    commitments = await fetchPoolCommitments(connection, pool.poolPDA);
  } catch (e) {
    return bad(502, `the pool's history could not be read: ${(e as Error).message}`);
  }
  const onTree = commitments.get(
    treasuryCommitmentFor(seed, pool.poolPDA, pool.tokenMint, contribution.leafIndex).toString(),
  );
  if (onTree) {
    return bad(409, 'the deposit this payment funded landed; confirm it', {
      leafIndex: contribution.leafIndex,
      foundAt: onTree.leafIndex,
      hint: 'POST /api/contribute-note { action: "confirm" }: that is what records the leaf as stock.',
    });
  }
  const repaid = await relayedFloatRepaid(kv, connection, signature, body);
  if (repaid instanceof NextResponse) return repaid;
  return bound;
}

/**
 * ⛔ [close-v1 F11] A RELAYED PAYMENT IS SOLD HERE ONLY ONCE THE FLOAT HAS ITS LAMPORTS BACK.
 *
 * `/api/relay-to-buyer` forwards the payment, plus up to 0.65 SOL of rent it
 * fronts, from the float to an ephemeral the CALLER names. This fallback used
 * to mint a full note for that same payment as soon as the deposit was not on
 * the tree, so a caller who relayed to a key of their own and never deposited
 * kept the float's lamports AND collected a note: one payment paid out twice
 * (audit v1, `r1-server/probes/relayDoubleDip.test.ts`).
 *
 * So the caller now names the ephemeral and signs `relayEphemeralChallenge`
 * with it, and three facts must hold before anything is minted:
 *
 *   1. the relay tagged THAT ephemeral for THIS payment (`relayEphemeralTag`,
 *      keyed by the float's secret). Without it any other float-funded key that
 *      gave its lamports back (another relay, a fund-ephemeral grant) could
 *      stand in for the one that kept them. A relay older than the tag left
 *      none, and is refused: nothing then proves which key it funded.
 *   2. the chain shows the float funding it, so "no history yet" is never read
 *      as "nothing was sent".
 *   3. the float is short by no more than `RELAYED_RETURN_TOLERANCE_LAMPORTS`:
 *      every debit of the float in a transaction naming the ephemeral counts,
 *      and a gain of the float counts only as a RETURN (below). A deposit that
 *      landed elsewhere, a transfer away, or a key never swept all fail this;
 *      Recover (which sweeps the ephemeral back to the float) is the way out,
 *      and the payment stays unconsumed until then.
 *
 * ⛔ WHAT A RETURN IS [verifier round 1, `verify-r1/probe-double-count`]. The
 * float's gain used to be summed over every transaction that merely NAMED the
 * ephemeral, so one sweep could repay several payments: an ephemeral listed
 * read-only in another key's sweep passed while it kept its own float, and so
 * did one that paid a sink in the same transaction as another key paid the
 * float. A return now counts only in a successful transaction in which the
 * ephemeral LOST lamports and no account but the float GAINED any, so nothing
 * the ephemeral gave up went anywhere else; and it credits at most the
 * ephemeral's own loss plus what non-signer accounts gave up (the proof buffer
 * the worker closes back through the ephemeral in its close-and-sweep,
 * `stark.ts`), never another signer's money.
 * And each return backs ONE payment, across all payments: it is recorded
 * against the first payment it is credited to (`relayReturnKey`, keyed rows,
 * first writer wins), and the same payment asking again keeps it.
 *
 * Every refusal is a 409 with a stable `code` and leaves the gate untouched.
 */
async function relayedFloatRepaid(
  kv: KvLike,
  connection: Connection,
  signature: string,
  body: { ephemeral?: unknown; ephemeralProof?: unknown },
): Promise<true | NextResponse> {
  const ephemeralRaw = typeof body.ephemeral === 'string' ? body.ephemeral.trim() : '';
  const ephemeralProof = typeof body.ephemeralProof === 'string' ? body.ephemeralProof.trim() : '';
  const recoverHint =
    'Run Recover on this device (it sweeps the deposit key back to the float), then ask ' +
    'again with the same payment. Nothing was sold and the payment is not consumed.';
  if (!ephemeralRaw || !ephemeralProof) {
    return bad(409, 'this payment funded a relayed deposit; name the deposit key it funded', {
      code: 'RELAYED_EPHEMERAL_REQUIRED',
      hint:
        'ephemeral: the key the relay funded, and ephemeralProof: its signature over the ' +
        'ephemeral challenge. ' + recoverHint,
    });
  }
  let ephemeral: PublicKey;
  try {
    ephemeral = new PublicKey(ephemeralRaw);
  } catch {
    return bad(400, 'ephemeral must be a public key');
  }
  try {
    const ok = nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(relayEphemeralChallenge(signature), 'utf8')),
      new Uint8Array(Buffer.from(ephemeralProof, 'base64')),
      ephemeral.toBytes(),
    );
    if (!ok) return bad(401, 'that ephemeral proof was not signed by the key it names');
  } catch {
    return bad(400, 'ephemeralProof must be base64 of a 64-byte ed25519 signature');
  }

  const funder = funderKeypair();
  if (!funder) {
    return bad(503, 'this deployment holds no float key, so a relayed payment cannot be checked');
  }
  let tag: unknown;
  try {
    tag = await kv.get(relayEphemeralTagKey(signature));
  } catch {
    return bad(503, 'the relay record could not be read');
  }
  if (
    typeof tag !== 'string' ||
    tag !== relayEphemeralTag(funder.secretKey, signature, ephemeral.toBase58())
  ) {
    return bad(409, 'that key is not the one the relay funded with this payment', {
      code: 'RELAYED_EPHEMERAL_UNBOUND',
      hint:
        'The relay records which key it funded; this payment has no such record for the key ' +
        'named. A payment relayed before that record existed is settled through support.',
    });
  }

  const float = funder.publicKey.toBase58();
  const eph = ephemeral.toBase58();
  let net = 0;
  let funded = false;
  const returns: Array<{ signature: string; lamports: number }> = [];
  try {
    const history = await connection.getSignaturesForAddress(
      ephemeral,
      { limit: MAX_EPHEMERAL_HISTORY },
      'confirmed',
    );
    if (history.length >= MAX_EPHEMERAL_HISTORY) {
      return bad(409, 'that deposit key has too long a history to be checked here', {
        code: 'RELAYED_FLOAT_NOT_RETURNED',
        hint: 'Settled through support.',
      });
    }
    for (const entry of history) {
      const tx = await connection.getTransaction(entry.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx?.meta) {
        return bad(502, "the deposit key's history could not be read in full; retry");
      }
      const keys = [
        ...tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58()),
        ...(tx.meta.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
        ...(tx.meta.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
      ];
      const fi = keys.indexOf(float);
      const ei = keys.indexOf(eph);
      if (fi < 0 || ei < 0) continue;
      const pre = tx.meta.preBalances;
      const post = tx.meta.postBalances;
      // The signers are the first static keys. Unknown means every other
      // account is treated as a signer: only the ephemeral's own loss counts.
      const header = (tx.transaction.message as { header?: { numRequiredSignatures?: unknown } })
        .header;
      const signers =
        typeof header?.numRequiredSignatures === 'number' ? header.numRequiredSignatures : null;
      const delta = (i: number) => (post[i] ?? 0) - (pre[i] ?? 0);
      const floatDelta = delta(fi);
      const ephDelta = delta(ei);
      if (floatDelta < 0) {
        // Every debit of the float counts: over-counting what is owed can only
        // refuse, never sell.
        if (ephDelta > 0) funded = true;
        net += floatDelta;
        continue;
      }
      if (floatDelta === 0 || tx.meta.err || ephDelta >= 0) continue;
      // A RETURN only if no account but the float gained: then whatever the
      // ephemeral lost went to the float. It is credited with the ephemeral's
      // own loss plus what NON-SIGNER accounts gave up (a proof buffer the
      // ephemeral paid for, closed back through it by the worker's
      // close-and-sweep), never with another signer's money.
      let fromEphemeral = -ephDelta;
      let foreignGain = false;
      for (let i = 0; i < keys.length; i += 1) {
        if (i === fi || i === ei) continue;
        const d = delta(i);
        if (d > 0) foreignGain = true;
        else if (d < 0 && signers !== null && i >= signers) fromEphemeral -= d;
      }
      if (foreignGain) continue;
      returns.push({ signature: entry.signature, lamports: Math.min(floatDelta, fromEphemeral) });
    }
  } catch {
    return bad(502, "the deposit key's history could not be read; retry");
  }
  if (!funded) {
    return bad(409, "the relay's transfer to that key is not visible on chain yet", {
      code: 'RELAYED_FUNDING_UNSEEN',
      hint: 'Retry in a minute. If the relay never sent it, the payment is settled through support.',
    });
  }
  // Oldest first (the history is newest first), and only as many as the debt
  // needs: a return this payment does not need is not recorded against it.
  try {
    for (const r of returns.reverse()) {
      if (net >= -RELAYED_RETURN_TOLERANCE_LAMPORTS) break;
      if (await returnBacksPayment(kv, funder.secretKey, r.signature, signature)) {
        net += r.lamports;
      }
    }
  } catch {
    return bad(503, 'the relay record could not be written; nothing was sold, ask again');
  }
  if (net < -RELAYED_RETURN_TOLERANCE_LAMPORTS) {
    return bad(409, 'the lamports the relay forwarded for this payment are not back at the float', {
      code: 'RELAYED_FLOAT_NOT_RETURNED',
      owedLamports: -net,
      hint: recoverHint,
    });
  }
  return true;
}

/**
 * Record `returnSignature` as backing `paymentSignature`, or say whether it
 * already does. First writer wins (`incr` on the keyed row); a payment asking
 * again finds its own owner row and keeps the return. A failed owner write
 * gives the row back, so a retry can take it. Throws on a store failure.
 */
async function returnBacksPayment(
  kv: KvLike,
  funderSecretKey: Uint8Array,
  returnSignature: string,
  paymentSignature: string,
): Promise<boolean> {
  const key = relayReturnKey(funderSecretKey, returnSignature);
  const owner = relayReturnOwner(funderSecretKey, paymentSignature);
  if ((await kv.incr(key)) === 1) {
    try {
      await kv.set(`${key}:owner`, owner);
      return true;
    } catch (e) {
      try {
        await kv.del(key);
      } catch {
        /* best effort: the row stays taken, and support settles it */
      }
      throw e;
    }
  }
  return (await kv.get<string>(`${key}:owner`)) === owner;
}
