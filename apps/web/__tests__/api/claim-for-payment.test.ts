/**
 * Selling a note against an on-chain payment.
 *
 * This route runs AFTER the buyer's money has moved, which decides most of what
 * follows: every refusal it can give must either leave the payment reusable, or
 * hand over the thing that was bought. There is no third option that is honest.
 *
 * TWO SHAPES OF PAYMENT. A plain transfer to the till pays the full price. A
 * circuit-7 withdrawal whose recipient is the till (the note-in exchange) lands
 * the denomination minus the pool's 0.5 percent, so the floor is lowered by
 * exactly that, and the key that must sign the claim is the withdrawal's fee
 * payer, the ephemeral. The classifier reads `compiledInstructions`, which a
 * legacy `Message` and a `MessageV0` both expose; both are built here for real
 * rather than faked, because `getTransaction` returns a LEGACY message for the
 * direct v4 path and a classifier that only understood v0 would silently never
 * match and refuse every note-in as an underpaid transfer.
 *
 * AND ONE CASE THAT IS NOT A SALE. A payment that funded a relayed deposit is
 * a contribution's payment; this route is only its fallback, and it shares the
 * `p01:note:paid:<sig>` gate with `/api/contribute-note` confirm so the two can
 * never both mint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import nacl from 'tweetnacl';
import {
  Keypair,
  MessageV0,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type VersionedMessage,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

const mockGetStore = vi.fn();
const mockRateLimitExceeded = vi.fn();

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => mockGetStore(),
  rateLimitExceeded: (...a: unknown[]) => mockRateLimitExceeded(...a),
}));

const mockGetTransaction = vi.fn();
const mockGetGenesisHash = vi.fn();
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Connection: class {
      getTransaction = (...a: unknown[]) => mockGetTransaction(...a);
      getGenesisHash = () => mockGetGenesisHash();
    },
  };
});

vi.mock('@/lib/privacy/pool/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/privacy/pool/denominatedPool')>();
  return {
    ...actual,
    // Overridden per case. The default is a tree that holds nothing.
    fetchPoolCommitments: vi.fn(async () => new Map()),
  };
});

import {
  createCommitmentV3,
  deriveNoteMaterial,
  getPoolsForTokenV3,
  pubkeyToField,
} from '@/lib/privacy/pool/denominatedPool';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TILL = 'F6R1sEJNLSCNGA3GXtwpofu55XqukDdn3U9jerLtW8wE';
const buyer = Keypair.generate();
/** The withdrawal's fee payer, whose secret only the worker holds. */
const ephemeral = Keypair.generate();
const SIG = '5'.repeat(87);

/** A transaction whose account keys are [payer, till] with the given delta. */
function paidTx(lamports: number, payer = buyer.publicKey.toBase58(), err: unknown = null) {
  return {
    meta: { err, preBalances: [10e9, 1e9], postBalances: [10e9 - lamports, 1e9 + lamports] },
    transaction: {
      message: { getAccountKeys: () => ({ staticAccountKeys: [{ toBase58: () => payer }, { toBase58: () => TILL }] }) },
    },
  };
}

// ── The withdrawal fixture, built for real ──────────────────────────────────
//
// The wire facts are written out here rather than imported, on purpose: the
// program id and the discriminator are what the chain carries, and a test that
// derived them from the source would follow the source anywhere it drifted.
const ZK_SHIELDED = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const DISC_V4 = sha256(utf8ToBytes('global:unshield_denominated_stark_v4')).slice(0, 8);
const DISC_V4_RELAYED = sha256(utf8ToBytes('global:unshield_denominated_stark_v4_relayed')).slice(0, 8);
const BLOCKHASH = '11111111111111111111111111111111';
const SYSTEM = new PublicKey('11111111111111111111111111111111');
const POOL_PDA = Keypair.generate().publicKey;
const TREE_PDA = Keypair.generate().publicKey;
const NULLIFIER_PDA = Keypair.generate().publicKey;
const PROOF_BUFFER = Keypair.generate().publicKey;
const FEE_ESCROW = Keypair.generate().publicKey;

/**
 * The account list `buildUnshieldV4Instruction` emits: the fee payer first, the
 * recipient LAST as `remaining_accounts[0]` (pinned by `unshieldV4.test.ts`).
 */
function withdrawalIx(feePayer: PublicKey, recipient: PublicKey, disc: Uint8Array) {
  const data = Buffer.concat([Buffer.from(disc), Buffer.alloc(32 + 32 + 8 + 4 + 4 + 32)]);
  return new TransactionInstruction({
    programId: ZK_SHIELDED,
    keys: [
      { pubkey: feePayer, isSigner: true, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: TREE_PDA, isSigner: false, isWritable: false },
      { pubkey: NULLIFIER_PDA, isSigner: false, isWritable: true },
      { pubkey: PROOF_BUFFER, isSigner: false, isWritable: false },
      { pubkey: SYSTEM, isSigner: false, isWritable: false },
      { pubkey: ZK_SHIELDED, isSigner: false, isWritable: false },
      { pubkey: FEE_ESCROW, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
    ],
    data,
  });
}

function legacyMessage(feePayer: PublicKey, ix: TransactionInstruction): VersionedMessage {
  return new Transaction({ recentBlockhash: BLOCKHASH, feePayer }).add(ix).compileMessage();
}

function v0Message(feePayer: PublicKey, ix: TransactionInstruction): VersionedMessage {
  return MessageV0.compile({ payerKey: feePayer, instructions: [ix], recentBlockhash: BLOCKHASH });
}

/**
 * A `getTransaction` answer around a real message: balances are aligned to the
 * message's own static keys, with the till credited `tillCredit`.
 */
function withdrawalTx(
  tillCredit: number,
  opts: { recipient?: PublicKey; relayed?: boolean; shape?: 'legacy' | 'v0'; feePayer?: Keypair } = {},
) {
  const feePayer = opts.feePayer ?? ephemeral;
  const ix = withdrawalIx(
    feePayer.publicKey,
    opts.recipient ?? new PublicKey(TILL),
    opts.relayed ? DISC_V4_RELAYED : DISC_V4,
  );
  const message =
    opts.shape === 'v0' ? v0Message(feePayer.publicKey, ix) : legacyMessage(feePayer.publicKey, ix);
  const keys = message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
  // The till is credited whether or not the withdrawal named it as recipient:
  // that is the case the recipient check exists for.
  if (!keys.includes(TILL)) keys.push(TILL);
  const preBalances = keys.map(() => 1e9);
  const postBalances = [...preBalances];
  postBalances[keys.indexOf(TILL)] += tillCredit;
  return {
    meta: { err: null, preBalances, postBalances },
    transaction: {
      message: {
        compiledInstructions: message.compiledInstructions,
        getAccountKeys: () => ({ staticAccountKeys: keys.map((k) => new PublicKey(k)) }),
      },
    },
  };
}

/** One map for counters and values, so `get` sees what `incr` wrote, as the real stores do. */
function store() {
  const data = new Map<string, unknown>();
  return {
    data,
    incr: vi.fn(async (k: string) => {
      const n = Number(data.get(k) ?? 0) + 1;
      data.set(k, n);
      return n;
    }),
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown) => void data.set(k, v)),
    del: vi.fn(async (k: string) => void data.delete(k)),
    expire: vi.fn(),
    sadd: vi.fn(),
    smembers: vi.fn(async () => []),
  };
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/claim-for-payment', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function route() {
  return import('@/app/api/claim-for-payment/route');
}

/**
 * The OTHER half of the pair. The two routes share `p01:note:paid:<sig>` and
 * the contribution keys, and the fund-loss they used to cause together was
 * invisible to either suite alone: the fallback wrote a per-leaf row for a leaf
 * that held nothing, and the confirm of the buyer who was handed that index
 * next refused. Both are driven here, against ONE store, so the sequence is the
 * thing under test rather than two halves nobody joined.
 *
 * It is already loaded either way: the route under test imports
 * `treasuryCommitmentFor` from it.
 */
async function contributeRoute() {
  return import('@/app/api/contribute-note/route');
}

const CONTRIBUTE_TICKET = 'test-ticket';

function contributePost(body: unknown) {
  return new NextRequest('http://localhost/api/contribute-note', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-p01-funder-ticket': CONTRIBUTE_TICKET,
      'x-real-ip': '198.51.100.9',
    },
  });
}

/**
 * The challenge is written out here rather than imported, ON PURPOSE: this is
 * the wire format a wallet has to sign, so a test that derived it from the
 * source would follow the source anywhere it drifted and pin nothing.
 */
function challenge(sig: string): string {
  return `Protocol 01 - collect the note I paid for.
Payment: ${sig}`;
}

function proofFor(sig: string, kp = buyer) {
  return Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(challenge(sig), 'utf8')), kp.secretKey),
  ).toString('base64');
}

// ── The contribution the relayed-payment branch is bound to ────────────────
const SEED_HEX = 'ab'.repeat(32);
const SEED_BYTES = Uint8Array.from(SEED_HEX.match(/../g)!.map((h) => parseInt(h, 16)));
/** The 1 SOL pool: `P01_TREASURY_NOTE_DENOMINATION` is '1' below. */
const POOL = getPoolsForTokenV3('SOL').find((p) => p.denomination === 1)!;
const POOL_KEY = POOL.poolPDA.toBase58();
const LEAF = 6;

function treasuryCommitmentAt(leafIndex: number): bigint {
  const { secret, nullifierPreimage } = deriveNoteMaterial(SEED_BYTES, POOL.poolPDA, leafIndex);
  return createCommitmentV3(
    nullifierPreimage,
    secret,
    deriveNoteBlinding(SEED_BYTES, POOL.poolPDA, leafIndex),
    pubkeyToField(POOL.tokenMint),
  );
}

/** A store in which the relay has funded leaf 6 with payment SIG. */
function relayedStore() {
  const kv = store();
  kv.data.set(`p01:relay:payment:${SIG}`, 1);
  kv.data.set(`p01:relay:payment:${SIG}:contribution`, `${POOL_KEY}:${LEAF}`);
  return kv;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockRateLimitExceeded.mockResolvedValue(false);
  mockGetGenesisHash.mockResolvedValue(DEVNET_GENESIS);
  vi.stubEnv('P01_TILL_ADDRESS', TILL);
  vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', '1');
  vi.stubEnv('P01_TREASURY_POOL_SEED', SEED_HEX);
  // For the cases that drive `/api/contribute-note` confirm on the same store.
  vi.stubEnv('P01_FUNDER_TICKET', CONTRIBUTE_TICKET);
  delete process.env.P01_NOTE_PRICE_LAMPORTS;
});

describe('a claim is only sold against a payment that really landed', () => {
  it('mints one claim for a payment that covers the price', async () => {
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG) }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.claimCode).toMatch(/^[\w-]{43}$/);
    expect(body.expires).toBe(false);
    expect(body.kind).toBe('transfer');
  });

  it('🚨 the same payment returns the SAME claim, never a second one', async () => {
    // A buyer who lost the response has already paid. A second code sells one
    // payment twice; a refusal keeps their money and gives them nothing.
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000));
    const { POST } = await route();
    const first = await (await POST(post({ signature: SIG, proof: proofFor(SIG) }))).json();
    const again = await (await POST(post({ signature: SIG, proof: proofFor(SIG) }))).json();
    expect(again.claimCode).toBe(first.claimCode);
  });

  it('⛔ refuses a stranger who saw the payment on chain', async () => {
    // Every payment to the till is public. The signature cannot be the
    // credential, or the first passer-by collects the note somebody bought.
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG, Keypair.generate()) }));
    expect(res.status).toBe(401);
  });

  it('refuses an underpayment WITHOUT consuming it, so the buyer can top up', async () => {
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    mockGetTransaction.mockResolvedValue(paidTx(500_000_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG) }));
    expect(res.status).toBe(402);
    expect(kv.incr).not.toHaveBeenCalled();
  });

  it('⚠️ accepts an OVERPAYMENT, because refusing it would keep the money', async () => {
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(5_000_000_000));
    const { POST } = await route();
    expect((await POST(post({ signature: SIG, proof: proofFor(SIG) }))).status).toBe(200);
  });

  it('refuses a transaction that never named the till', async () => {
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue({
      meta: { err: null, preBalances: [10e9], postBalances: [9e9] },
      transaction: {
        message: {
          getAccountKeys: () => ({
            staticAccountKeys: [{ toBase58: () => buyer.publicKey.toBase58() }],
          }),
        },
      },
    });
    const { POST } = await route();
    expect((await POST(post({ signature: SIG, proof: proofFor(SIG) }))).status).toBe(400);
  });

  it('refuses a transaction that failed on chain', async () => {
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000, buyer.publicKey.toBase58(), { e: 1 }));
    const { POST } = await route();
    expect((await POST(post({ signature: SIG, proof: proofFor(SIG) }))).status).toBe(400);
  });

  it('⛔ fails closed with no durable store', async () => {
    // Without a counter one payment mints unbounded claims: the inventory given
    // away.
    mockGetStore.mockReturnValue(null);
    const { POST } = await route();
    expect((await POST(post({ signature: SIG, proof: proofFor(SIG) }))).status).toBe(503);
  });

  it('⛔ refuses to sell on anything but devnet, checked against the chain', async () => {
    // Every sibling route carries this guard; an env var pointing at mainnet
    // and named "devnet" would sell real notes.
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    mockGetGenesisHash.mockResolvedValue('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG) }));
    expect(res.status).toBe(403);
    expect(kv.incr).not.toHaveBeenCalled();
  });

  it('reports its own readiness rather than guessing', async () => {
    mockGetStore.mockReturnValue(store());
    vi.stubEnv('P01_FUNDER_RPC', 'https://example.invalid');
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.configured).toBe(true);
    expect(body.till).toBe(TILL);
    expect(body.priceLamports).toBe(1_000_000_000);
    // What a note-in lands at the till: the denomination minus the pool's 0.5%.
    expect(body.withdrawalFloorLamports).toBe(995_000_000);
  });
});

describe('a circuit-7 withdrawal to the till is a payment, at the withdrawal floor', () => {
  // MEASURED 2026-08-27 on the 1 SOL pool: "payee +0.995 SOL". The pool keeps
  // `UNSHIELD_FEE_BPS` = 50, so a note-in of a 1 SOL note lands 995,000,000 at
  // the till and the full-price floor would refuse every one of them.

  it('mints against a withdrawal that landed 995,000,000, signed by its fee payer', async () => {
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(withdrawalTx(995_000_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG, ephemeral) }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.kind).toBe('pool-withdrawal');
    expect(body.payer).toBe(ephemeral.publicKey.toBase58());
    expect(body.received).toBe(995_000_000);
    expect(body.floorLamports).toBe(995_000_000);
  });

  it('🚨 classifies a LEGACY message, which is what getTransaction returns for the direct path', async () => {
    // A classifier that only understood v0 would never match, and every
    // note-in would come back 402 as an underpaid transfer.
    const tx = withdrawalTx(995_000_000, { shape: 'legacy' });
    expect(tx.transaction.message.compiledInstructions.length).toBeGreaterThan(0);
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(tx);
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG, ephemeral) }));
    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe('pool-withdrawal');
  });

  it('classifies a MessageV0 the same way', async () => {
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(withdrawalTx(995_000_000, { shape: 'v0' }));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG, ephemeral) }));
    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe('pool-withdrawal');
  });

  it('⛔ refuses a proof from a wallet that is not the withdrawal fee payer', async () => {
    // The withdrawal is public. Whoever saw it must not be able to collect the
    // note it bought; only the ephemeral's holder can sign as keys[0].
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(withdrawalTx(995_000_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG, buyer) }));
    expect(res.status).toBe(401);
  });

  it('refuses a withdrawal whose recipient is not the till, even if the till was credited', async () => {
    // A withdrawal to a third party inside a transaction that credited the
    // till by some other route must not get the lowered floor.
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    mockGetTransaction.mockResolvedValue(
      withdrawalTx(995_000_000, { recipient: Keypair.generate().publicKey }),
    );
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG, ephemeral) }));
    expect(res.status).toBe(400);
    expect(kv.incr).not.toHaveBeenCalled();
  });

  it('refuses the RELAYED variant: its fee payer is the relayer, not the buyer', async () => {
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    mockGetTransaction.mockResolvedValue(withdrawalTx(995_000_000, { relayed: true }));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG, ephemeral) }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/relayed/);
    expect(kv.incr).not.toHaveBeenCalled();
  });

  it('refuses a 0.1 SOL withdrawal (99,500,000) buying a 1 SOL note', async () => {
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    mockGetTransaction.mockResolvedValue(withdrawalTx(99_500_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG, ephemeral) }));
    const body = await res.json();
    expect(res.status).toBe(402);
    expect(body.floorLamports).toBe(995_000_000);
    expect(kv.incr).not.toHaveBeenCalled();
  });

  it('does NOT lower the floor for a plain transfer of 995,000,000', async () => {
    // The lowered floor is the pool fee's, and only a withdrawal pays it.
    mockGetStore.mockReturnValue(store());
    mockGetTransaction.mockResolvedValue(paidTx(995_000_000));
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG) }));
    const body = await res.json();
    expect(res.status).toBe(402);
    expect(body.kind).toBe('transfer');
    expect(body.floorLamports).toBe(1_000_000_000);
  });
});

describe('a payment that funded a relayed deposit is a contribution, and this route is only its fallback', () => {
  const claim = (over: Record<string, unknown> = {}) =>
    post({ signature: SIG, proof: proofFor(SIG), contribution: { token: 'SOL', leafIndex: LEAF }, ...over });

  beforeEach(() => {
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000));
  });

  it('requires the contribution the relay recorded for this payment', async () => {
    const kv = relayedStore();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: proofFor(SIG) }));
    expect(res.status).toBe(400);
    expect(kv.incr).not.toHaveBeenCalled();
  });

  it('⛔ refuses a contribution that is not the one this payment funded', async () => {
    // The binding is written by the relay after the lamports moved. A payer
    // cannot point the fallback at somebody else's reservation.
    const kv = relayedStore();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(claim({ contribution: { token: 'SOL', leafIndex: LEAF + 1 } }));
    expect(res.status).toBe(400);
    expect(kv.incr).not.toHaveBeenCalled();
  });

  it('refuses when the relay recorded no contribution for this payment', async () => {
    const kv = relayedStore();
    kv.data.delete(`p01:relay:payment:${SIG}:contribution`);
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    expect((await POST(claim())).status).toBe(400);
  });

  it('answers 409 "collect through confirm" once the leaf is confirmed, read without confirming', async () => {
    const kv = relayedStore();
    kv.data.set(`p01:note:contrib-confirmed:${POOL_KEY}:${LEAF}`, 1);
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(claim());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/confirm/);
    // Read with `get`, never `incr`: reading must not confirm.
    expect(kv.incr).not.toHaveBeenCalled();
  });

  it('answers 409 "deposit landed, confirm it" when the treasury commitment is on the tree', async () => {
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(fetchPoolCommitments).mockResolvedValueOnce(
      new Map([
        [treasuryCommitmentAt(LEAF).toString(), { leafIndex: LEAF, commitment: treasuryCommitmentAt(LEAF), depositSlot: 1 }],
      ]) as never,
    );
    const kv = relayedStore();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(claim());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/landed/);
    expect(kv.incr).not.toHaveBeenCalled();
  });

  it('🚨 mints for a deposit that never landed, and marks the PAYMENT, never the leaf', async () => {
    // This branch has just PROVEN the treasury's commitment is not on the
    // tree, so the leaf holds nothing. A `contrib-confirmed` row written for it
    // has no TTL and no writer that ever clears it, and the reserve loop hands
    // that same index to the next contributor once the reclaim window passes.
    const kv = relayedStore();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(claim());
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.claimCode).toMatch(/^[\w-]{43}$/);
    expect(kv.data.get(`p01:note:paid:${SIG}:code`)).toBe(body.claimCode);
    expect(kv.data.get(`p01:note:claim-minted:${body.claimCode}`)).toBe(`payment:${SIG}`);
    expect(
      [...kv.data.keys()].filter((k) => k.startsWith('p01:note:contrib-')),
      'the fallback marked a leaf that holds nothing',
    ).toHaveLength(0);
  });

  it('🚨 a late confirm of the deposit that DID land replays the fallback code, never a second one', async () => {
    // The replay that actually matters, and it runs off the PAYMENT, not the
    // leaf: the fallback took `p01:note:paid:<sig>` first, so the confirm sees
    // a counter that is not 1 and hands back the code already sold.
    const kv = relayedStore();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const fallback = await (await POST(claim())).json();

    // The deposit lands after all, and the same buyer confirms it.
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(fetchPoolCommitments).mockResolvedValueOnce(
      new Map([
        [
          treasuryCommitmentAt(LEAF).toString(),
          { leafIndex: LEAF, commitment: treasuryCommitmentAt(LEAF), depositSlot: 1 },
        ],
      ]) as never,
    );
    const contribute = await contributeRoute();
    const res = await contribute.POST(
      contributePost({
        action: 'confirm',
        token: 'SOL',
        leafIndex: LEAF,
        paymentSignature: SIG,
        proof: proofFor(SIG),
      }),
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.replayed).toBe(true);
    expect(body.claimCode, 'one payment sold two notes').toBe(fallback.claimCode);
    expect(
      [...kv.data.keys()].filter((k) => k.startsWith('p01:note:claim-minted:')),
      'one payment minted two codes',
    ).toHaveLength(1);
  });

  it('🚨 leaves the reclaimed leaf clean, so the NEXT buyer who is handed it can still confirm', async () => {
    // THE FUND LOSS THIS PINS. Buyer A pays, the relayed deposit never lands,
    // the fallback pays them. Twenty minutes later `/api/contribute-note`
    // reclaims that index and hands it to buyer B, who pays AND deposits
    // honestly. B's confirm used to answer 409 "already confirmed under a
    // different payment" and give the payment gate back, and the fallback
    // answered 409 "collect its code through confirm": each route pointed at
    // the other and B had paid for nothing.
    const kv = relayedStore();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const first = await (await POST(claim())).json();
    expect(first.claimCode).toBeTruthy();

    // Buyer B: a different wallet, a different payment, the same leaf index.
    const nextBuyer = Keypair.generate();
    const SIG_B = '7'.repeat(87);
    kv.data.set(`p01:relay:payment:${SIG_B}`, 1);
    kv.data.set(`p01:relay:payment:${SIG_B}:contribution`, `${POOL_KEY}:${LEAF}`);
    mockGetTransaction.mockResolvedValue(paidTx(1_003_000_000, nextBuyer.publicKey.toBase58()));
    const { fetchPoolCommitments } = await import('@/lib/privacy/pool/denominatedPool');
    vi.mocked(fetchPoolCommitments).mockResolvedValueOnce(
      new Map([
        [
          treasuryCommitmentAt(LEAF).toString(),
          { leafIndex: LEAF, commitment: treasuryCommitmentAt(LEAF), depositSlot: 1 },
        ],
      ]) as never,
    );
    const contribute = await contributeRoute();
    const res = await contribute.POST(
      contributePost({
        action: 'confirm',
        token: 'SOL',
        leafIndex: LEAF,
        paymentSignature: SIG_B,
        proof: proofFor(SIG_B, nextBuyer),
      }),
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.claimCode).toBeTruthy();
    expect(body.claimCode, 'B was handed the code A already spent').not.toBe(first.claimCode);
    expect(body.replayed).toBeFalsy();
    // A's payment is untouched: it kept the code it bought.
    expect(kv.data.get(`p01:note:paid:${SIG}:code`)).toBe(first.claimCode);
  });

  it('returns the code confirm already minted for this payment, whatever the leaf says now', async () => {
    // confirm-then-fallback: the client lost the confirm response and fell
    // back. The answer is the confirm's code, not a refusal.
    const kv = relayedStore();
    kv.data.set(`p01:note:paid:${SIG}`, 1);
    kv.data.set(`p01:note:paid:${SIG}:code`, 'CONFIRMED-CODE');
    kv.data.set(`p01:note:contrib-confirmed:${POOL_KEY}:${LEAF}`, 1);
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(claim());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.claimCode).toBe('CONFIRMED-CODE');
    // And nothing was minted twice.
    expect([...kv.data.keys()].filter((k) => k.startsWith('p01:note:claim-minted:'))).toHaveLength(0);
  });

  it('treats a payment with no relay claim as a plain sale, contribution or not', async () => {
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(claim());
    expect(res.status).toBe(200);
    expect(
      [...kv.data.keys()].filter((k) => k.startsWith('p01:note:contrib-')),
      'a plain sale wrote contribution keys',
    ).toHaveLength(0);
  });
});
