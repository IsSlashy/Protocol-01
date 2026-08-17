import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';

import { getStore, rateLimitExceeded } from '@/lib/waitlist/store';
import {
  buildMerkleProofFromLeavesV3,
  createCommitmentV3,
  deriveNoteMaterial,
  fetchPoolCommitments,
  getPoolsForTokenV3,
  pubkeyToField,
  type OnChainCommitment,
  type ShareableNote,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { encryptNote, isNoteEncryptionAddress } from '@/lib/privacy/pool/noteCrypto';

/**
 * issue-note — hand a caller a shielded note THIS DEPLOYMENT deposited.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE WHOLE PRODUCT
 * ───────────────────────────────────────────────
 * Spending a note republishes, in cleartext, the exact commitment its deposit
 * emitted. The program forces that — the C1 inputs hash binds the argument, C3
 * proves it is a leaf, the root must be the pool's — so no client change alters
 * it before the verifier is redeployed. The consequence is one hop:
 *
 *   subscription → commitment → the deposit that emitted it → its fee payer
 *
 * If that fee payer is the buyer, everything else is decoration: the spend can
 * be paid by a treasury, swept to a treasury and signed by a fresh ephemeral,
 * and the buyer is still one hop away through their own deposit.
 *
 * So the buyer must spend a note SOMEBODY ELSE deposited. Until now that meant
 * a two-wallet ritual — shield from A, seal to B, import into B, subscribe from
 * B — which is a runbook, not a product. A person will do exactly one thing:
 * click Subscribe. This endpoint is what makes the rest happen underneath.
 *
 * ⛔ WHAT THIS DOES NOT DO, AND MUST NEVER BE DESCRIBED AS DOING
 * ─────────────────────────────────────────────────────────────
 * It does not make the buyer anonymous to US. The note's secrets are
 * `HKDF(treasurySeed, poolPDA, counter)` — enumerable offline, forever, from a
 * seed this server holds. So `subscriber_commitment`, `license_commitment`, the
 * nullifier and the vault PDA of every subscription bought with an issued note
 * are each a pure function of a value we can regenerate, with no records kept
 * and no log written. **Against the issuer the anonymity set is one,
 * unconditionally and permanently**, and it stays one after any redeploy.
 *
 * It also does not transfer exclusive ownership. Holding the seed means this
 * deployment can spend an issued note itself, at any time, until the recipient
 * spends it first. On devnet with the operator's own SOL that is a recovery
 * path; anywhere else it is custody, and it must be stated as custody.
 *
 * What it DOES buy is precise and worth having: a chain observer who is not the
 * issuer and not the merchant cannot get from the subscription to the buyer,
 * because the deposit names us.
 *
 * 🚨 IT GIVES AWAY MONEY, LIKE THE FUNDER, BUT WORSE
 * ──────────────────────────────────────────────────
 * A grant from `/api/fund-ephemeral` is rent that comes back. A note is the
 * denomination itself and does not. The bounds here are: a finite, explicitly
 * configured inventory that can only shrink; an atomic per-leaf claim so one
 * note is never issued twice; a durable per-IP rate limit; and the devnet
 * genesis guard. None of that is an anti-abuse story for real value — the
 * inventory bound is what makes the worst case a known number rather than a
 * balance.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RATE_SALT = 'p01:issue-note:v1';
/** Deliberately tighter than the funder's: this hands over value, not rent. */
const ISSUES_PER_IP_PER_HOUR = 3;

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

function clientIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

/** The treasury's pool seed, 32 bytes as 64 hex characters. */
function treasurySeed(): Uint8Array | null {
  const hex = process.env.P01_TREASURY_POOL_SEED;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The leaf indices this deployment deposited and is willing to give away.
 *
 * EXPLICIT, not discovered. The server could scan the pool and claim every leaf
 * whose commitment its seed reproduces — but a derivation bug, a wrong pool or a
 * seed reused across environments would then quietly hand out notes nobody meant
 * to give, and the failure would look like success. A list an operator typed is
 * a list an operator can be asked about.
 */
/**
 * The denomination the treasury's inventory actually sits in.
 *
 * 🚨 LEAF INDICES ARE ONLY MEANINGFUL INSIDE ONE POOL. Every pool has its own
 * tree, so leaf 34 of the 1 SOL pool and leaf 34 of the 0.1 SOL pool are
 * different notes — and asking for the wrong one produces "the configured
 * inventory does not match the chain", which is correct and reads like a
 * derivation bug.
 *
 * The client used to hard-code what it asked for, so a treasury that deposited
 * into any other pool was simply unreachable. Publishing it here lets the
 * client ask for what exists instead of guessing.
 */
function inventoryDenomination(): number {
  const raw = Number(process.env.P01_TREASURY_NOTE_DENOMINATION ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 0.1;
}

function inventoryLeaves(): number[] {
  return (process.env.P01_TREASURY_NOTE_LEAVES ?? '')
    .split(',')
    .map((s) => s.trim())
    // 🚨 THE EMPTY-STRING FILTER IS LOAD-BEARING, and it was missing.
    // `''.split(',')` is `['']`, and `Number('')` is 0 — which is an integer
    // and is >= 0. So an UNSET variable produced an inventory of exactly one
    // leaf, index 0, and the readiness check reported it as configured. Found
    // by curling the built route rather than by any test, which is the argument
    // for curling the built route.
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

export async function GET() {
  // Readiness, in the shape /api/fund-ephemeral uses: every way this is switched
  // off is silent at the point of use, so it has to be answerable in advance.
  const seed = treasurySeed();
  const leaves = inventoryLeaves();
  const kv = getStore();
  const reasons: string[] = [];
  if (!seed) reasons.push('P01_TREASURY_POOL_SEED is unset or not 64 hex characters.');
  if (leaves.length === 0) reasons.push('P01_TREASURY_NOTE_LEAVES lists no leaf indices.');
  if (!process.env.P01_FUNDER_TICKET) reasons.push('P01_FUNDER_TICKET is unset.');
  if (!kv) reasons.push('No durable KV store, so issued notes cannot be tracked and this refuses.');
  return NextResponse.json({
    ok: true,
    configured: reasons.length === 0,
    inventorySize: leaves.length,
    // The client asks for THIS, rather than assuming. Leaf indices only mean
    // something inside one pool.
    denomination: inventoryDenomination(),
    token: 'SOL',
    reasons,
    note:
      'inventorySize counts what was CONFIGURED, not what is still unissued — reading the ' +
      'remaining count would require the KV lookups an issuance does, and an endpoint that ' +
      'reports a number it did not check is how a demo discovers an empty inventory on stage.',
  });
}

export async function POST(request: NextRequest) {
  const ticket = process.env.P01_FUNDER_TICKET;
  const seed = treasurySeed();
  if (!seed) return bad(503, 'this deployment issues no notes');
  if (!ticket) return bad(503, 'no ticket configured; refusing to hand out notes anonymously');
  if (request.headers.get('x-p01-funder-ticket') !== ticket) {
    return bad(401, 'bad or missing ticket');
  }

  let body: { recipientAddress?: unknown; token?: unknown; denomination?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad(400, 'body must be JSON');
  }

  const recipientAddress = String(body.recipientAddress ?? '');
  if (!isNoteEncryptionAddress(recipientAddress)) {
    return bad(400, 'recipientAddress is not a p01pq: note address');
  }
  const token = body.token === 'USDC' ? 'USDC' : 'SOL';
  const denomination = Number(body.denomination);
  if (!Number.isFinite(denomination) || denomination <= 0) {
    return bad(400, 'denomination must be a positive number');
  }
  const pool = getPoolsForTokenV3(token).find((p) => p.denomination === denomination);
  if (!pool) return bad(400, `no ${denomination} ${token} pool is configured`);
  // Refuse a request for a pool this treasury did not deposit into, BEFORE the
  // claim is consumed. Without this the leaf indices would be looked up in the
  // wrong tree and fail on the on-chain check — after the claim was spent, for a
  // reason that reads like a derivation bug rather than a mismatched pool.
  if (denomination !== inventoryDenomination()) {
    return bad(400, `this deployment issues ${inventoryDenomination()} ${token} notes`, {
      denomination: inventoryDenomination(),
    });
  }

  // Same posture as the funder: no durable counter, no handing over value. Here
  // it is doubly load-bearing, because the claim that stops a note being issued
  // twice is a KV increment.
  const kv = getStore();
  if (!kv) return bad(503, 'no durable store is configured; refusing to issue notes untracked');
  try {
    if (await rateLimitExceeded(kv, clientIp(request), RATE_SALT, ISSUES_PER_IP_PER_HOUR)) {
      return bad(429, 'too many note requests from this address in the last hour', {
        limit: ISSUES_PER_IP_PER_HOUR,
      });
    }
  } catch (e) {
    return bad(503, `the rate limiter could not be read: ${(e as Error).message}`);
  }

  const connection = new Connection(
    process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com',
    'confirmed',
  );
  // Checked against the chain rather than the URL string, for the same reason
  // the funder does: an env var pointing at mainnet and named "devnet" would
  // give away real money.
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch (e) {
    return bad(502, `the configured RPC could not be reached: ${(e as Error).message}`);
  }
  if (genesis !== DEVNET_GENESIS) {
    return bad(403, 'this issuer is devnet-only and the configured RPC is not devnet', { genesis });
  }

  // ── The payment gate ─────────────────────────────────────────────────────
  //
  // A note IS the denomination. Handing one over is handing over money, so it
  // happens against a claim that something was paid for — not against a ticket
  // that ships in the browser bundle.
  //
  // The shape is deliberately dumb and auditable: a claim code exists in KV, was
  // put there by whatever took the payment, and is consumed here ATOMICALLY. It
  // is not a payment integration and does not pretend to be one — it is the
  // seam a payment integration plugs into, and the thing that stops the endpoint
  // being a faucet in the meantime.
  //
  // ⛔ NO "SKIP IF UNSET". A gate that is optional is a gate that is off in
  // production on the day it matters, because the env var that enables it is the
  // one nobody set. Unconfigured means REFUSE, and the operator turns it on by
  // minting claims rather than by removing a check.
  const claimCode = String((body as { claimCode?: unknown }).claimCode ?? '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(claimCode)) {
    return bad(402, 'a paid claim code is required to receive a note', {
      hint: 'Notes are the denomination itself. One is issued per claim, and a claim is created when a payment settles.',
    });
  }
  let claimed: number;
  try {
    // `incr` is the whole concurrency argument: exactly one caller sees 1, so a
    // claim cannot be spent twice even if two requests arrive together. Reading
    // then writing would let both pass and hand out two notes for one payment.
    claimed = await kv.incr(`p01:note:claim:${claimCode}`);
  } catch (e) {
    return bad(503, `the claim could not be read: ${(e as Error).message}`);
  }
  if (claimed !== 1) {
    return bad(409, 'this claim code has already been used', {
      hint: 'A claim is worth one note. If a note was not received, recover it rather than reissuing — the first one is spendable.',
    });
  }
  // A claim must have been MINTED, not merely typed. `incr` above created the
  // key if it was absent, so the existence check has to be separate — and it
  // has to come after the claim, or two callers race on an unminted code.
  let minted: string | null = null;
  try {
    minted = await kv.get<string>(`p01:note:claim-minted:${claimCode}`);
  } catch {
    // Treated as unminted below: an unreadable store must not authorise value.
  }
  if (!minted) {
    return bad(402, 'this claim code was never issued against a payment', {
      hint: 'The code is now consumed either way, so a guessed code cannot be retried.',
    });
  }

  const leaves = inventoryLeaves();
  if (leaves.length === 0) return bad(503, 'this deployment has no note inventory configured');

  // The pool's leaves, once, for both the on-chain check below and the Merkle
  // path. Building the path HERE rather than leaving the recipient to rebuild
  // it is the difference between a subscription that starts immediately and one
  // that walks the pool's whole history first.
  let commitments: Map<string, OnChainCommitment>;
  try {
    commitments = await fetchPoolCommitments(connection, pool.poolPDA);
  } catch (e) {
    return bad(502, `the pool's history could not be read: ${(e as Error).message}`);
  }

  const poolKey = pool.poolPDA.toBase58();
  for (const leafIndex of leaves) {
    // ATOMIC CLAIM, before any work. `incr` returns 1 only for the caller that
    // created the key, so exactly one concurrent request can win a leaf. Doing
    // the derivation first and claiming afterwards would let two simultaneous
    // callers be handed the same note — and a note is spent once, so the second
    // buyer's subscription would fail on a nullifier collision after ~150
    // uploads and ~1 SOL of buffer rent.
    let claim: number;
    try {
      claim = await kv.incr(`p01:note:issued:${poolKey}:${leafIndex}`);
    } catch (e) {
      return bad(503, `the inventory could not be claimed: ${(e as Error).message}`);
    }
    if (claim !== 1) continue; // already issued

    // ⚠️ ARGUMENT ORDER IS (nullifierPreimage, secret, blinding, tokenMintField)
    // and both of the first two are bigints, so getting them the wrong way round
    // type-checks and silently produces a commitment that is on no tree. The
    // on-chain check below is what caught it while writing this; do not remove
    // that check on the grounds that the derivation is "obviously" right.
    // Mirrors `poolNotes.ts:175` exactly, which is the derivation the rest of
    // the app finds notes with.
    const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, leafIndex);
    const noteBlinding = deriveNoteBlinding(seed, pool.poolPDA, leafIndex);
    const commitment = createCommitmentV3(
      nullifierPreimage,
      secret,
      noteBlinding,
      pubkeyToField(pool.tokenMint),
    );

    // The note must actually BE on the tree, at the leaf we think it is. A
    // mismatch means the seed, the pool or the index is wrong, and issuing it
    // would hand someone a blob that cannot be spent — money that looks
    // received and is not. Refuse the whole request rather than move on: a
    // configuration error must not be silently absorbed by trying the next leaf.
    const onChain = commitments.get(commitment.toString());
    if (!onChain || onChain.leafIndex !== leafIndex) {
      return bad(500, 'the configured inventory does not match the chain', {
        leafIndex,
        found: onChain?.leafIndex ?? null,
        hint:
          'P01_TREASURY_POOL_SEED, the pool, or P01_TREASURY_NOTE_LEAVES is wrong. The leaf has ' +
          'been marked issued to stop a retry loop from consuming the whole inventory.',
      });
    }

    let merkle: Pick<ShareableNote, 'merkle_root' | 'merkle_path_elements' | 'merkle_path_indices'> = {};
    try {
      let maxIdx = -1;
      for (const e of commitments.values()) if (e.leafIndex > maxIdx) maxIdx = e.leafIndex;
      const leavesByIndex: bigint[] = maxIdx >= 0 ? new Array<bigint>(maxIdx + 1).fill(0n) : [];
      for (const e of commitments.values()) leavesByIndex[e.leafIndex] = e.commitment;
      const built = buildMerkleProofFromLeavesV3({ leavesByIndex, targetLeafIndex: leafIndex });
      merkle = {
        merkle_root: built.root.toString(),
        merkle_path_elements: built.pathElements.map((e) => e.toString()),
        merkle_path_indices: built.pathIndices,
      };
    } catch {
      // Ship the note without a path rather than with a wrong one. The
      // recipient rebuilds from history: slower, always correct.
    }

    const shareable: ShareableNote = {
      version: 1,
      pool: poolKey,
      secret: secret.toString(),
      nullifier_preimage: nullifierPreimage.toString(),
      // The wire key stays `deposit_epoch` and carries the blinding. Renaming it
      // silently drops the stored Merkle path on every consumer.
      deposit_epoch: noteBlinding.toString(),
      // 🚨 THE FIELD, NOT THE ADDRESS. `PublicKey.toString()` is base58, and the
      // native-SOL mint is `11111111111111111111111111111111` — thirty-two
      // characters that are ALL DIGITS. So `BigInt(note.token_mint)` on the
      // import side parsed it as a decimal number instead of failing, produced a
      // value nothing else agrees with, and the note was rejected with
      // "commitment does not match its secrets" — a message about the secrets,
      // for a bug in a field that is not secret.
      //
      // The commitment above is computed from `pubkeyToField(...)`, which is 0
      // for native SOL, so the note WAS the right leaf on chain and still could
      // not be opened. Any mint whose base58 contains a letter would have thrown
      // a SyntaxError and been found immediately; this one is the single value
      // that fails silently.
      token_mint: pubkeyToField(pool.tokenMint).toString(),
      commitment: commitment.toString(),
      leafIndex,
      token,
      denominationHuman: denomination,
      ...merkle,
    };

    const sealedNote = encryptNote(
      recipientAddress,
      new TextEncoder().encode(JSON.stringify(shareable)),
    );

    return NextResponse.json({
      ok: true,
      sealedNote,
      leafIndex,
      commitment: commitment.toString(),
      denomination,
      token,
      merklePath: merkle.merkle_root ? 'rebuilt' : 'none',
      // Said in the response, not only in a doc, because whatever renders this
      // will be the last thing between the claim and a user believing it.
      disclosure:
        'This note was deposited by this deployment, so a chain observer who follows the ' +
        'subscription back to its deposit lands on us rather than on you. It does NOT hide you ' +
        'from us: the note derives from a seed this server holds, so we can identify every ' +
        'subscription bought with it, and we can spend it ourselves until you do.',
    });
  }

  return bad(503, 'the note inventory is empty', {
    configured: leaves.length,
    hint: 'Deposit more notes from the treasury wallet and extend P01_TREASURY_NOTE_LEAVES.',
  });
}
