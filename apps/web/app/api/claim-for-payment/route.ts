import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { Connection, PublicKey, type MessageCompiledInstruction } from '@solana/web3.js';
import nacl from 'tweetnacl';

import { getStore, rateLimitExceeded, type KvLike } from '@/lib/waitlist/store';
import { clientIp } from '@/lib/net/clientIp';
import { claimChallenge } from '@/lib/privacy/claimChallenge';
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
 */
function classifyPayment(
  instructions: readonly MessageCompiledInstruction[] | undefined,
  keys: readonly string[],
  till: string,
): { kind: PaymentKind } | { refuse: string } {
  const program = ZK_SHIELDED_PROGRAM_ID.toBase58();
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

  let body: { signature?: unknown; proof?: unknown; contribution?: unknown };
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
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.meta) return bad(404, 'that payment is not on chain yet; confirm it and retry');
    if (tx.meta.err) return bad(400, 'that transaction failed on chain, so it paid nothing');

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

    const classified = classifyPayment(message.compiledInstructions, keys, till);
    if ('refuse' in classified) return bad(400, classified.refuse, { till });
    kind = classified.kind;
  } catch (e) {
    return bad(502, `the payment could not be read: ${(e as Error).message}`);
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
    const relayed = await relayedContribution(kv, connection, signature, body.contribution);
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
        await kv.set(notePaidCodeKey(signature), claimCode);
        // The claim itself, in the shape /api/issue-note redeems. No expiry: see
        // the founder ruling in mint-claim, a bearer asset somebody bought is not
        // a liability to be timed out.
        await kv.set(`p01:note:claim-minted:${claimCode}`, `payment:${signature}`);
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
  rawContribution: unknown,
): Promise<{ poolKey: string; leafIndex: number } | null | NextResponse> {
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
  return bound;
}
