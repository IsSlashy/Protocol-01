import { NextRequest, NextResponse } from 'next/server';
import { Connection } from '@solana/web3.js';

import { getStore, rateLimitExceeded } from '@/lib/waitlist/store';
import {
  createCommitmentV3,
  decodeShareableNote,
  deriveNoteMaterial,
  fetchPoolCommitments,
  fetchSpentNullifierSet,
  isNullifierSpentInSet,
  getPoolsForTokenV3,
  pubkeyToField,
  type OnChainCommitment,
  type ShareableNote,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { isNoteEncryptionAddress } from '@/lib/privacy/pool/noteCrypto';

/**
 * TAKE A NOTE IN — the return half of the exchange.
 *
 * Everything this deployment does today moves notes ONE WAY: the treasury
 * deposits its own capital, `issue-note` sells the result, the revenue settles
 * to the float and never comes back as stock. That is a SHOP, and in a shop the
 * stock only shrinks. This route is the other direction, and without it the
 * sentence "the treasury mixes everyone's notes" is false by construction.
 *
 * ── WHY IT HANDS NOTHING BACK IN THE SAME REQUEST ───────────────────────────
 *
 * 🚨 THE DRAIN, AND IT IS THE WHOLE REASON THIS ENDPOINT IS ASYNCHRONOUS.
 * A note IS its opening. Whoever hands one in STILL KNOWS IT and can still
 * spend it. So a route that verifies note X and hands back note Y in the same
 * breath lets one caller walk away with two denominations for one: swap, then
 * spend X before the treasury does. The verification below cannot prevent that
 * — it proves X is unspent AT THIS INSTANT, and the attacker's spend comes
 * afterwards.
 *
 * The only thing that makes a swap safe is the treasury SPENDING X FIRST, so
 * the caller's copy is dead before a replacement exists. That is a real
 * transaction with a real fee, it must be RELAYED (a spend the caller pays for
 * names the caller, which is the entire thing this route exists to avoid), and
 * it cannot happen inside an HTTP request. So the shape is:
 *
 *     submit  ->  verified and queued  ->  converted off-line  ->  collect
 *
 * ⛔ AND THE DELAY IS NOT A COMPROMISE, IT IS THE DESIGN. A replacement handed
 * over seconds after a note is handed in rejoins the two halves on the clock
 * alone — the same shape as the maturity gate, which exists because a note
 * deposited moments before it is sold carries the buyer's clock. An
 * asynchronous swap gets that separation for free.
 *
 * ── WHAT THE CALLER GETS BACK ───────────────────────────────────────────────
 *
 * A ticket. Once the conversion lands, the ticket is minted as a claim and
 * `issue-note` serves it from stock — the SAME issuance path, with its spent
 * check, its maturity gate, its atomic per-leaf claim and its shuffle. No
 * second issuance implementation, and nothing in this file can hand out a note.
 *
 * 🚨 AND A PENDING LEAF IS NOT INVENTORY. `recordInventoryLeaf` takes leaves
 * whose opening the treasury DERIVES from its own seed; an incoming note's
 * secrets are the sender's and derive from nothing we hold. Writing an incoming
 * leaf there would put a leaf in the issuable set whose derived commitment is
 * not the one on the tree, and `issue-note` would answer 500 'the configured
 * inventory does not match the chain' — to a buyer, on a paid request. The
 * pending set below is a DIFFERENT key for exactly that reason: a leaf becomes
 * inventory only after conversion produces a note this treasury derives.
 */

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RATE_SALT = 'p01:swap-note:v1';

/** Deliberately tight: this queues value and mints a ticket. */
const SWAPS_PER_IP_PER_HOUR = (() => {
  const raw = Number(process.env.P01_SWAPS_PER_IP_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
})();

/** The pending queue, per pool. Enumerated by the conversion worker. */
export const KV_PENDING_PREFIX = 'p01:note:pending:';
/** One key per submitted leaf — `incr` on it is the idempotency argument. */
export const KV_PENDING_LEAF_PREFIX = 'p01:note:pending-leaf:';
/** The opening the worker needs in order to spend it. */
export const KV_PENDING_OPENING_PREFIX = 'p01:note:pending-opening:';
/** The ticket that becomes a claim once the conversion lands. */
export const KV_SWAP_TICKET_PREFIX = 'p01:note:swap:';

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

/** The treasury's pool seed, 32 bytes as 64 hex characters. */
function treasurySeed(): Uint8Array | null {
  const hex = process.env.P01_TREASURY_POOL_SEED;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The denomination this deployment deals in.
 *
 * Kept identical to `issue-note`'s reader on purpose: a swap that accepted a
 * denomination issuance cannot serve would queue a note against a ticket that
 * can never be filled — the caller's note taken, nothing owed back that the
 * stock can pay.
 */
function inventoryDenomination(): number {
  const raw = Number(process.env.P01_TREASURY_NOTE_DENOMINATION);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.1;
}

/** 32 hex characters — inside `issue-note`'s claim-code alphabet by construction. */
function mintTicket(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export async function GET() {
  // A readiness answer, not a queue dump. What a caller needs to know before
  // submitting is whether this deployment can take a note at all.
  const seed = treasurySeed();
  return NextResponse.json({
    ok: true,
    accepting: Boolean(seed) && Boolean(getStore()),
    denomination: inventoryDenomination(),
    asynchronous: true,
    note:
      'A swap is queued, not served. The note handed in must be spent by the treasury before a ' +
      'replacement can exist, or one caller could keep both halves. Submit, then collect with ' +
      'the ticket once the conversion has landed.',
  });
}

export async function POST(request: NextRequest) {
  const ticketHeader = process.env.P01_FUNDER_TICKET;
  const seed = treasurySeed();
  if (!seed) return bad(503, 'this deployment holds no treasury and cannot take a note in');
  if (!ticketHeader) return bad(503, 'no ticket configured; refusing to accept notes anonymously');
  if (request.headers.get('x-p01-funder-ticket') !== ticketHeader) {
    return bad(401, 'bad or missing ticket');
  }

  let body: { note?: unknown; recipientAddress?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad(400, 'body must be JSON');
  }

  // Where the REPLACEMENT will be sealed once the ticket is filled. Recorded
  // now, with the submission, so the collect step cannot be pointed at a
  // different address by whoever later presents the ticket.
  const recipientAddress = String(body.recipientAddress ?? '');
  if (!isNoteEncryptionAddress(recipientAddress)) {
    return bad(400, 'recipientAddress is not a p01pq: note address');
  }

  /**
   * The note, as its OPENING.
   *
   * ⚠️ IT ARRIVES IN THE CLEAR, over TLS, and that is a choice rather than an
   * oversight. The treasury has to spend this note, so it has to learn the
   * opening; sealing it to a treasury note address would hide it from a proxy
   * and from nobody else. What that would buy is protection against
   * intermediate logging, and what it would cost is a second key to hold and a
   * second way to lose one. Say which one this is rather than imply the
   * stronger one.
   */
  let note: ShareableNote;
  try {
    note =
      typeof body.note === 'string'
        ? decodeShareableNote(body.note)
        : (body.note as ShareableNote);
    if (!note || note.version !== 1) throw new Error('unsupported note version');
  } catch (e) {
    return bad(400, `note could not be read: ${(e as Error).message}`);
  }

  const toField = (v: unknown): bigint | null => {
    try {
      const n = BigInt(String(v));
      return n >= 0n ? n : null;
    } catch {
      return null;
    }
  };
  const secret = toField(note.secret);
  const nullifierPreimage = toField(note.nullifier_preimage);
  // The wire key stays `deposit_epoch` and carries the blinding. See the type.
  const blinding = toField(note.deposit_epoch);
  if (secret === null || nullifierPreimage === null || blinding === null) {
    return bad(400, 'note is missing an opening (secret, nullifier_preimage, deposit_epoch)');
  }
  const claimedLeaf = Number(note.leafIndex);
  if (!Number.isInteger(claimedLeaf) || claimedLeaf < 0) {
    return bad(400, 'note has no usable leafIndex');
  }

  const token = note.token === 'USDC' ? 'USDC' : 'SOL';
  const denomination = Number(note.denominationHuman);
  const pool = getPoolsForTokenV3(token).find((p) => p.denomination === denomination);
  if (!pool) return bad(400, `no ${denomination} ${token} pool is configured`);
  if (denomination !== inventoryDenomination()) {
    return bad(400, `this deployment deals in ${inventoryDenomination()} ${token} notes`, {
      denomination: inventoryDenomination(),
    });
  }
  const poolKey = pool.poolPDA.toBase58();
  // The note names its own pool. A mismatch means the leaf index would be read
  // in the wrong tree — the same class of error the denomination check above
  // catches, one level down.
  if (note.pool && note.pool !== poolKey) {
    return bad(400, 'note belongs to a different pool than its denomination implies', {
      notePool: note.pool,
      expected: poolKey,
    });
  }

  const kv = getStore();
  if (!kv) return bad(503, 'no durable store is configured; refusing to accept notes untracked');
  try {
    if (await rateLimitExceeded(kv, clientIp(request), RATE_SALT, SWAPS_PER_IP_PER_HOUR)) {
      return bad(429, 'too many swap requests from this address in the last hour', {
        limit: SWAPS_PER_IP_PER_HOUR,
      });
    }
  } catch (e) {
    return bad(503, `the rate limiter could not be read: ${(e as Error).message}`);
  }

  /**
   * 🚨 THE COMMITMENT IS RECOMPUTED, NEVER TRUSTED.
   *
   * `note.commitment` is a claim made by whoever sent it. Recomputing from the
   * opening is what proves they hold the note rather than a copy of somebody
   * else's public leaf: every commitment is on chain for anyone to read, and
   * without this a passer-by could queue a stranger's leaf, mint a ticket and
   * collect a note against value they never had.
   *
   * ⚠️ ARGUMENT ORDER IS (nullifierPreimage, secret, blinding, tokenMintField)
   * and the first two are both bigints, so swapping them type-checks and
   * silently yields a commitment that is on no tree.
   *
   * The mint FIELD comes from the pool, not from `note.token_mint`: the native
   * SOL mint is thirty-two characters that are all digits, so a wrong value
   * there parses instead of throwing.
   */
  const commitment = createCommitmentV3(
    nullifierPreimage,
    secret,
    blinding,
    pubkeyToField(pool.tokenMint),
  );
  //
  // ⛔ AND `commitment` IS MANDATORY, not checked-if-present. It used to read
  // `if (note.commitment && ...)`, so omitting the field skipped the comparison
  // entirely -- a caller who cannot state the commitment they claim to hold is
  // not proving anything by leaving it out, and the omission also walked past
  // the ownership guard below by making its index the only thing left to lie
  // about.
  if (!note.commitment) {
    return bad(400, 'note must declare its commitment');
  }
  if (note.commitment !== commitment.toString()) {
    return bad(400, 'the note does not open to the commitment it declares');
  }

  const connection = new Connection(
    process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com',
    'confirmed',
  );
  // Checked against the chain rather than the URL string, for the same reason
  // the funder does: an env var pointing at mainnet and named "devnet" would
  // queue real money.
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (e) {
    return bad(502, `the configured RPC could not be reached: ${(e as Error).message}`);
  }
  if (genesis !== DEVNET_GENESIS) {
    return bad(403, 'this deployment is devnet-only and the configured RPC is not devnet', {
      genesis,
    });
  }

  let commitments: Map<string, OnChainCommitment>;
  try {
    commitments = await fetchPoolCommitments(connection, pool.poolPDA);
  } catch (e) {
    return bad(502, `the pool's history could not be read: ${(e as Error).message}`);
  }
  const onChain = commitments.get(commitment.toString());
  if (!onChain) {
    return bad(400, 'this note is not on the pool tree', {
      hint: 'The opening is well formed, but its commitment was never deposited into this pool.',
    });
  }
  // The chain's index wins over the caller's copy: it is what the worker will
  // spend against, and a stale `leafIndex` in a shared blob is ordinary.
  const trueLeaf = onChain.leafIndex;

  /**
   * ⛔ REFUSE OUR OWN NOTES.
   *
   * A leaf the treasury derives is already ours. Queueing it would mint a ticket
   * for a note we would be buying back from ourselves: stock leaves through
   * issuance, nothing arrives, and the treasury pays both pool fees for the
   * privilege. It is also the shape an accidental refund loop would take.
   *
   * 🚨 THIS RAN ABOVE, AGAINST `note.leafIndex`, AND THAT WAS THE BUG.
   * The index came from the caller and was validated only as a non-negative
   * integer, so submitting a note this deployment had just sold with
   * `leafIndex: 999999` derived the treasury's note at leaf 999999, compared it
   * against a commitment it has nothing to do with, found them different, and
   * let the submission through. The chain lookup then resolved the real leaf and
   * queued it. The guard has to key on the index the CHAIN reports, which is why
   * it now sits here rather than thirty lines earlier.
   *
   * Deriving at `trueLeaf` is also complete rather than merely better: a note
   * this treasury issued sits at exactly one index, its own, so the check at the
   * authoritative index catches every one of them.
   */
  const mine = deriveNoteMaterial(seed, pool.poolPDA, trueLeaf);
  const mineCommitment = createCommitmentV3(
    mine.nullifierPreimage,
    mine.secret,
    deriveNoteBlinding(seed, pool.poolPDA, trueLeaf),
    pubkeyToField(pool.tokenMint),
  );
  if (mineCommitment === commitment) {
    return bad(409, 'this note was issued by this deployment and is already held here', {
      leafIndex: trueLeaf,
      hint: 'Spend it or keep it. Handing it back buys nothing and would cost the treasury a note.',
    });
  }

  /**
   * ⛔ UNSPENT, READ FROM THE CHAIN — AND STILL NOT A GUARANTEE.
   *
   * This is the check that stops an already-dead note being queued for a
   * ticket. It is necessary and it is NOT sufficient: see the drain at the top
   * of this file. The sender keeps the opening and can spend it a moment after
   * this read returns. That is precisely why the ticket is filled by the
   * conversion and not by this request.
   */
  let spent: ReadonlySet<string>;
  try {
    spent = await fetchSpentNullifierSet(connection, pool.poolPDA);
  } catch (e) {
    // Refuse rather than queue blind. An unread spent-set is not an empty one.
    return bad(502, `the pool's spent notes could not be read: ${(e as Error).message}`);
  }
  if (isNullifierSpentInSet(spent, pool.poolPDA, nullifierPreimage, secret)) {
    return bad(409, 'this note has already been spent', {
      hint: 'A commitment stays on the tree after its note is spent, so it still looks present.',
    });
  }

  /**
   * ATOMIC, PER LEAF. `incr` returns 1 only for the caller that created the
   * key, so one note cannot be queued twice even by two simultaneous requests
   * — which would otherwise mint two tickets against one denomination and drain
   * the treasury by exactly the amount this endpoint exists to add.
   */
  const leafKey = `${KV_PENDING_LEAF_PREFIX}${poolKey}:${trueLeaf}`;
  let queued: number;
  try {
    queued = await kv.incr(leafKey);
  } catch (e) {
    return bad(503, `the pending queue could not be written: ${(e as Error).message}`);
  }
  if (queued !== 1) {
    return bad(409, 'this note is already queued for conversion', {
      leafIndex: trueLeaf,
      hint: 'Present the ticket from the first submission. A second one would owe two notes for one.',
    });
  }

  const ticket = mintTicket();
  try {
    /**
     * The opening the worker needs in order to spend it.
     *
     * ⚠️ THIS IS NOTE MATERIAL AT REST. Whoever reads this store can spend
     * every queued note. That is the same power the treasury already holds over
     * every note it issues — `issue-note` derives those from a seed this server
     * holds, and its disclosure says so — so the posture does not change. It is
     * written down here so it is not discovered later.
     */
    await kv.set(
      `${KV_PENDING_OPENING_PREFIX}${poolKey}:${trueLeaf}`,
      JSON.stringify({
        secret: note.secret,
        nullifier_preimage: note.nullifier_preimage,
        deposit_epoch: note.deposit_epoch,
        commitment: commitment.toString(),
        leafIndex: trueLeaf,
        pool: poolKey,
        token,
        denominationHuman: denomination,
        ticket,
      }),
    );
    await kv.set(
      `${KV_SWAP_TICKET_PREFIX}${ticket}`,
      JSON.stringify({
        pool: poolKey,
        leafIndex: trueLeaf,
        recipientAddress,
        denomination,
        token,
        status: 'pending',
      }),
    );
    // Written LAST, so the worker never enumerates a leaf whose opening is not
    // stored yet. An enumerated leaf it cannot open reads as a corrupt queue.
    await kv.sadd(`${KV_PENDING_PREFIX}${poolKey}`, String(trueLeaf));
  } catch (e) {
    return bad(503, `the submission could not be recorded: ${(e as Error).message}`);
  }

  return NextResponse.json({
    ok: true,
    status: 'queued',
    ticket,
    leafIndex: trueLeaf,
    commitment: commitment.toString(),
    denomination,
    token,
    // Said in the response, not only in a doc, because whatever renders this is
    // the last thing between the submission and a user believing it.
    disclosure:
      'This note is queued, not exchanged. It stays spendable by whoever submitted it until the ' +
      'treasury spends it, and no replacement exists before then — that ordering is what stops ' +
      'one caller keeping both halves. Keep the ticket: it becomes the claim that draws the ' +
      'replacement from stock, and the replacement is a different note with a different history. ' +
      'This server learns the opening submitted to it, because it has to spend it.',
  });
}
