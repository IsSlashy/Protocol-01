import { NextRequest, NextResponse } from 'next/server';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * fund-ephemeral — pay the rent and fees for one pool job, so the user's wallet
 * never appears on chain.
 *
 * WHY THIS ENDPOINT EXISTS
 * ────────────────────────
 * A pool spend is signed by a fresh ephemeral key, which is good. But an
 * ephemeral key cannot pay a fee from nothing, so something funds it, and on
 * Solana that something is a public `SystemProgram::transfer`. The client also
 * sweeps the residue back when the job ends. Today both ends point at the user's
 * wallet, which brackets the whole operation with its name on it: measured on
 * `verify/fixtures/v3-subscribe`, three RPC calls take a stranger from the
 * subscription to the buyer's wallet (probe P6). That is the cheapest attack on
 * this protocol and it is not cryptographic.
 *
 * Moving both ends here replaces one wallet-per-user with one treasury shared by
 * every user of this deployment. The anonymity set of the financial channel goes
 * from "one" to "everyone this endpoint has funded".
 *
 * ⛔ WHAT THIS ENDPOINT MUST NEVER DO — AND WHY IT IS SHAPED THIS WAY
 * ──────────────────────────────────────────────────────────────────
 * It never receives proof bytes, and it never signs a pool instruction. That is
 * not tidiness, it is the security boundary. A third party holding verified C1
 * and C3 buffers can already steal the whole note: `retailer` is an unconstrained
 * `AccountInfo` (`subscribe_private_stark.rs:82`), `rate` and `interval_slots`
 * are free arguments bound to no proof, and `claim_period` is permissionless with
 * `retailer` not a signer (`claim_period.rs:47-62`). Set `rate > amount` and the
 * vault is exhausted at slot zero, so one `claim_period` call empties it to an
 * attacker-chosen retailer. There is no `cancel`. So: the ephemeral key stays in
 * the browser (derived by HKDF from the user's own seed), the client uploads its
 * own chunks and calls subscribe itself, and this endpoint only ever moves
 * lamports to an address it is handed.
 *
 * 🚨 THIS IS A FAUCET, AND EVERY FAUCET CAN BE DRAINED
 * ────────────────────────────────────────────────────
 * An attacker who calls this with a fresh keypair each time and never runs the
 * job keeps the lamports. Cost to them: zero. Cost to the treasury: up to the cap
 * per call. The guards below (ticket, cap, empty-target, per-instance budget)
 * raise the effort and bound the damage; none of them makes the endpoint safe to
 * expose without a ticket. Before this is worth anything beyond devnet it needs a
 * real anti-abuse story — payment, proof of work, or an allowlist. That work is
 * NOT done, and the devnet guard below is what keeps the gap from mattering yet.
 */

// Node runtime: this route signs with a secret key and talks to an RPC.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The largest legitimate request, with headroom.
 *
 * Measured job shapes on devnet: a subscribe pre-funds 1,035,725,040 lamports
 * (two proof buffers' rent + the vault's + the nullifier record's + a fee
 * budget) and a shield 1,573,486,080. The cap sits above the larger of the two
 * and below anything that would matter, so a client bug asking for 100 SOL is
 * refused rather than served.
 */
const MAX_LAMPORTS_PER_REQUEST = 2_000_000_000;

/**
 * Ceiling for one server instance's lifetime. Serverless instances are recycled,
 * so this is a blast-radius bound on a single runaway loop, NOT a daily budget —
 * saying otherwise would be the kind of guard that reads stronger than it is.
 */
const MAX_LAMPORTS_PER_INSTANCE = 20_000_000_000;
let spentThisInstance = 0;

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

function bad(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

export async function POST(request: NextRequest) {
  const ticket = process.env.P01_FUNDER_TICKET;
  const secret = process.env.P01_FUNDER_SECRET_KEY;

  // Unconfigured is a distinct answer from refused. A deployment that simply has
  // no funder should say so, or the client cannot tell "turned off here" from
  // "your request was rejected" and will show the user the wrong thing.
  if (!secret) return bad(503, 'no funder configured on this deployment');
  if (!ticket) return bad(503, 'no funder ticket configured; refusing to run as an open faucet');

  if (request.headers.get('x-p01-funder-ticket') !== ticket) {
    return bad(401, 'bad or missing funder ticket');
  }

  let body: { ephemeralPubkey?: unknown; lamports?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad(400, 'body must be JSON');
  }

  let target: PublicKey;
  try {
    target = new PublicKey(String(body.ephemeralPubkey ?? ''));
  } catch {
    return bad(400, 'ephemeralPubkey is not a valid public key');
  }

  const lamports = Number(body.lamports);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) {
    return bad(400, 'lamports must be a positive integer');
  }
  if (lamports > MAX_LAMPORTS_PER_REQUEST) {
    return bad(400, 'lamports exceeds the per-request cap', { cap: MAX_LAMPORTS_PER_REQUEST });
  }
  if (spentThisInstance + lamports > MAX_LAMPORTS_PER_INSTANCE) {
    return bad(429, 'this instance has reached its funding ceiling');
  }

  const rpc = process.env.P01_FUNDER_RPC ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpc, 'confirmed');

  // Devnet guard, checked against the chain rather than against the URL string.
  // An env var pointing at a mainnet RPC named "devnet" would otherwise spend
  // real money, and this endpoint has no anti-abuse story that survives that.
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    return bad(403, 'this funder is devnet-only and the configured RPC is not devnet', { genesis });
  }

  let funder: Keypair;
  try {
    funder = Keypair.fromSecretKey(bs58.decode(secret));
  } catch {
    return bad(503, 'funder secret key is not valid base58');
  }
  if (target.equals(funder.publicKey)) return bad(400, 'refusing to fund the funder');

  // The target must be empty. A fresh ephemeral always is, so this costs a
  // legitimate caller nothing — and it stops the endpoint being used to top up
  // an address that already holds a balance. It does NOT stop an attacker
  // generating unlimited fresh keys; see the faucet note in the header.
  const existing = await connection.getBalance(target, 'confirmed');
  if (existing > 0) {
    return bad(409, 'target already holds lamports; this endpoint only funds a fresh ephemeral', {
      balance: existing,
    });
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: target, lamports }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = funder.publicKey;
  tx.sign(funder);

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize());
  } catch (e) {
    return bad(502, `funding transaction was rejected: ${(e as Error).message}`);
  }

  const conf = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    return bad(502, `funding transaction failed: ${JSON.stringify(conf.value.err)}`);
  }

  // Counted only after confirmation, so a rejected send does not eat the budget.
  spentThisInstance += lamports;

  return NextResponse.json({
    ok: true,
    signature,
    lamports,
    funder: funder.publicKey.toBase58(),
    // The client shows this to the user. The point of the endpoint is that the
    // sweep goes back HERE and not to their wallet, so they should be able to
    // see where their residue is going before they start.
    sweepTo: funder.publicKey.toBase58(),
  });
}
