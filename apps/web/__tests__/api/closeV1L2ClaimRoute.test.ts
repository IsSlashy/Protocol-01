/**
 * close-v1 lane L2: what `/api/claim-for-payment` may mint, and when.
 *
 * Three findings of audit v1 (scratchpad audit-v1-opus), each written as the
 * case that failed on the tree before the fix:
 *
 *   F11  the relayed fallback minted a full note for a payment whose relayed
 *        lamports the caller kept. `/api/relay-to-buyer` forwards the payment
 *        (plus up to 0.65 SOL of rent) from the float to a caller-chosen
 *        ephemeral, and the fallback then sold the same payment again. The
 *        fallback now mints only once the ephemeral the relay funded for THIS
 *        payment has given the float back what it was sent.
 *   F63  a failed write of the code after the payment gate was taken left the
 *        gate held and no code anywhere: "already redeemed" for ever.
 *   F70  the note-in exchange hands the claim to the circuit-7 withdrawal's fee
 *        payer, which anyone copying the proof can become. Until the claim
 *        credential moves off the fee payer, the route stops selling against a
 *        withdrawal it cannot attribute (code EXCHANGE_DISABLED), keeping the
 *        ones that landed before the operator's cutoff collectable.
 *
 * The wire strings (the ephemeral's challenge, the relay's tag) are written out
 * here rather than imported, on purpose: they are what the relay, the client and
 * this route must agree on, and a test that derived them from the source would
 * follow the source anywhere it drifted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const mockGetStore = vi.fn();
vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => mockGetStore(),
  rateLimitExceeded: async () => false,
}));

/** signature -> the `getTransaction` answer; address -> its signature list. */
const chainTx = new Map<string, unknown>();
const chainHistory = new Map<string, string[]>();
const historyReads: string[] = [];
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    Connection: class {
      getGenesisHash = async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      getTransaction = async (sig: string) => chainTx.get(sig) ?? null;
      getSignaturesForAddress = async (address: { toBase58(): string }) => {
        historyReads.push(address.toBase58());
        return (chainHistory.get(address.toBase58()) ?? []).map((signature) => ({
          signature,
          err: null,
        }));
      };
    },
  };
});

vi.mock('@/lib/privacy/pool/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/privacy/pool/denominatedPool')>();
  return { ...actual, fetchPoolCommitments: vi.fn(async () => new Map()) };
});

import { getPoolsForTokenV3 } from '@/lib/privacy/pool/denominatedPool';

const TILL = 'F6R1sEJNLSCNGA3GXtwpofu55XqukDdn3U9jerLtW8wE';
const SIG = '5'.repeat(87);
const buyer = Keypair.generate();
const funder = Keypair.generate();
const FLOAT = funder.publicKey.toBase58();
const POOL = getPoolsForTokenV3('SOL').find((p) => p.denomination === 1)!;
const POOL_KEY = POOL.poolPDA.toBase58();
const LEAF = 6;
/** What the relay forwards for a 1 SOL contribution: the value plus the rent it fronts. */
const FORWARD = 1_573_486_080;

function challenge(sig: string): string {
  return `Protocol 01 - collect the note I paid for.
Payment: ${sig}`;
}
function ephemeralChallenge(sig: string): string {
  return `Protocol 01 - the deposit key this payment funded gave the float back.
Payment: ${sig}`;
}
/** The relay's tag: HMAC-SHA256 under a key derived from the float's secret. */
function relayTag(sig: string, eph: string): string {
  const key = sha256(concatBytes(utf8ToBytes('p01:relay:ephemeral-tag:v1\0'), funder.secretKey));
  return bytesToHex(hmac(sha256, key, utf8ToBytes(`${sig}\n${eph}`)));
}
function sign(message: string, kp: Keypair): string {
  return Buffer.from(
    nacl.sign.detached(new Uint8Array(Buffer.from(message, 'utf8')), kp.secretKey),
  ).toString('base64');
}

/** A transaction touching `keys` whose balances move by `deltas`. */
function balanceTx(keys: string[], deltas: number[], blockTime = 1_800_000_000) {
  const preBalances = keys.map(() => 10e9);
  return {
    blockTime,
    meta: {
      err: null,
      preBalances,
      postBalances: preBalances.map((b, i) => b + (deltas[i] ?? 0)),
      loadedAddresses: { writable: [], readonly: [] },
    },
    transaction: {
      message: {
        compiledInstructions: [],
        getAccountKeys: () => ({ staticAccountKeys: keys.map((k) => new PublicKey(k)) }),
      },
    },
  };
}

function store(failOnce?: (k: string) => boolean) {
  const data = new Map<string, unknown>();
  let armed = !!failOnce;
  return {
    data,
    incr: vi.fn(async (k: string) => {
      const n = Number(data.get(k) ?? 0) + 1;
      data.set(k, n);
      return n;
    }),
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown) => {
      if (armed && failOnce!(k)) {
        armed = false;
        throw new Error('UpstashError: transient (injected)');
      }
      data.set(k, v);
    }),
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
const minted = (kv: ReturnType<typeof store>) =>
  [...kv.data.keys()].filter((k) => k.startsWith('p01:note:claim-minted:'));

beforeEach(() => {
  vi.unstubAllEnvs();
  chainTx.clear();
  chainHistory.clear();
  historyReads.length = 0;
  vi.stubEnv('P01_TILL_ADDRESS', TILL);
  vi.stubEnv('P01_TREASURY_NOTE_DENOMINATION', '1');
  vi.stubEnv('P01_TREASURY_POOL_SEED', 'ab'.repeat(32));
  vi.stubEnv('P01_FUNDER_SECRET_KEY', bs58.encode(funder.secretKey));
  delete process.env.P01_NOTE_PRICE_LAMPORTS;
  delete process.env.P01_EXCHANGE_LEGACY_CUTOFF;
  // The buyer's payment: 1.003 SOL to the till, named by their wallet.
  chainTx.set(
    SIG,
    balanceTx([buyer.publicKey.toBase58(), TILL], [-1_003_005_000, 1_003_000_000]),
  );
});

// ── F11 ──────────────────────────────────────────────────────────────────────

/** A store in which the relay funded `eph` for leaf 6 with payment SIG, and tagged it. */
function relayedStore(eph: string, tagged = true) {
  const kv = store();
  kv.data.set(`p01:relay:payment:${SIG}`, 1);
  kv.data.set(`p01:relay:payment:${SIG}:contribution`, `${POOL_KEY}:${LEAF}`);
  if (tagged) kv.data.set(`p01:relay:payment:${SIG}:ephemeral-tag`, relayTag(SIG, eph));
  return kv;
}

/** The ephemeral's history: funded by the float, then `returned` lamports swept back. */
function ephemeralHistory(eph: Keypair, returned: number | null, elsewhere?: string) {
  const e = eph.publicKey.toBase58();
  const sigs = ['FUND'.padEnd(87, '1')];
  chainTx.set(sigs[0], balanceTx([FLOAT, e], [-(FORWARD + 5_000), FORWARD]));
  if (returned !== null) {
    sigs.push('SWEEP'.padEnd(87, '2'));
    chainTx.set(sigs[1], balanceTx([e, FLOAT], [-(returned + 5_000), returned]));
  }
  if (elsewhere) {
    sigs.push('AWAY'.padEnd(87, '3'));
    chainTx.set(sigs[sigs.length - 1], balanceTx([e, elsewhere], [-(FORWARD - 5_000), FORWARD - 10_000]));
  }
  chainHistory.set(e, sigs.reverse());
}

function fallback(eph: Keypair | null, over: Record<string, unknown> = {}) {
  return post({
    signature: SIG,
    proof: sign(challenge(SIG), buyer),
    contribution: { token: 'SOL', leafIndex: LEAF },
    ...(eph
      ? {
          ephemeral: eph.publicKey.toBase58(),
          ephemeralProof: sign(ephemeralChallenge(SIG), eph),
        }
      : {}),
    ...over,
  });
}

describe('F11 · the relayed fallback never sells a payment whose float the caller kept', () => {
  it('🚨 refuses the probe: float lamports forwarded to an address that kept them, then a claim', async () => {
    // audit-v1-opus/r1-server/probes/relayDoubleDip.test.ts, as a request: the
    // relay sent FORWARD lamports to `sink`, which moved them away and never
    // deposited. The fallback used to answer 200 with a claim code.
    const sink = Keypair.generate();
    const kv = relayedStore(sink.publicKey.toBase58());
    mockGetStore.mockReturnValue(kv);
    ephemeralHistory(sink, null, Keypair.generate().publicKey.toBase58());
    const { POST } = await route();
    const res = await POST(fallback(sink));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('RELAYED_FLOAT_NOT_RETURNED');
    expect(body.owedLamports).toBeGreaterThan(1_000_000_000);
    expect(minted(kv), 'one payment was paid out twice').toHaveLength(0);
    expect(kv.data.get(`p01:note:paid:${SIG}`), 'the refusal took the gate').toBeUndefined();
  });

  it('🚨 refuses a fallback that names no ephemeral at all, and mints nothing', async () => {
    const eph = Keypair.generate();
    const kv = relayedStore(eph.publicKey.toBase58());
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(fallback(null));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('RELAYED_EPHEMERAL_REQUIRED');
    expect(minted(kv)).toHaveLength(0);
  });

  it('⛔ refuses an ephemeral the relay did not tag for this payment, even one that repaid its float', async () => {
    // Laundering: some OTHER float-funded key (a fund-ephemeral grant, another
    // relay) that gave its lamports back must not stand in for the one that kept them.
    const kept = Keypair.generate();
    const clean = Keypair.generate();
    const kv = relayedStore(kept.publicKey.toBase58());
    mockGetStore.mockReturnValue(kv);
    ephemeralHistory(clean, FORWARD - 20_000);
    const { POST } = await route();
    const res = await POST(fallback(clean));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('RELAYED_EPHEMERAL_UNBOUND');
    expect(minted(kv)).toHaveLength(0);
  });

  it('⛔ refuses when the relay left no tag (a relay older than this rule): nothing proves which key it funded', async () => {
    const eph = Keypair.generate();
    const kv = relayedStore(eph.publicKey.toBase58(), false);
    mockGetStore.mockReturnValue(kv);
    ephemeralHistory(eph, FORWARD - 20_000);
    const { POST } = await route();
    const res = await POST(fallback(eph));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RELAYED_EPHEMERAL_UNBOUND');
    expect(minted(kv)).toHaveLength(0);
  });

  it('⛔ refuses an ephemeral proof signed by any other key', async () => {
    const eph = Keypair.generate();
    const kv = relayedStore(eph.publicKey.toBase58());
    mockGetStore.mockReturnValue(kv);
    ephemeralHistory(eph, FORWARD - 20_000);
    const { POST } = await route();
    const res = await POST(
      fallback(eph, { ephemeralProof: sign(ephemeralChallenge(SIG), Keypair.generate()) }),
    );
    expect(res.status).toBe(401);
    expect(minted(kv)).toHaveLength(0);
  });

  it('refuses while the funding is not visible yet, without reading it as "nothing was sent"', async () => {
    const eph = Keypair.generate();
    const kv = relayedStore(eph.publicKey.toBase58());
    mockGetStore.mockReturnValue(kv);
    chainHistory.set(eph.publicKey.toBase58(), []);
    const { POST } = await route();
    const res = await POST(fallback(eph));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('RELAYED_FUNDING_UNSEEN');
    expect(minted(kv)).toHaveLength(0);
  });

  it('mints once the float has its lamports back (less the fees of the attempt)', async () => {
    const eph = Keypair.generate();
    const kv = relayedStore(eph.publicKey.toBase58());
    mockGetStore.mockReturnValue(kv);
    ephemeralHistory(eph, FORWARD - 60_000);
    const { POST } = await route();
    const res = await POST(fallback(eph));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(minted(kv)).toEqual([`p01:note:claim-minted:${body.claimCode}`]);
    expect(historyReads).toEqual([eph.publicKey.toBase58()]);
  });

  it('a plain sale (no relay claim) reads no ephemeral history and needs no ephemeral', async () => {
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: sign(challenge(SIG), buyer) }));
    expect(res.status).toBe(200);
    expect(historyReads).toEqual([]);
  });
});

// ── F63 ──────────────────────────────────────────────────────────────────────

describe('F63 · a store blip after the gate never turns a paid purchase into "already redeemed"', () => {
  it('🚨 the retry after a failed code write mints exactly one code', async () => {
    // audit-v1-opus/r3-server/p4/probe-claim-store-blip.mts: the first `set` of
    // the code row throws once. Attempts 2-4 used to answer 409 for ever.
    const kv = store((k) => k.endsWith(':code'));
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const req = () => POST(post({ signature: SIG, proof: sign(challenge(SIG), buyer) }));
    const first = await req();
    expect(first.status).toBe(503);
    expect(minted(kv), 'a failed attempt left a redeemable code behind').toHaveLength(0);
    const second = await req();
    const body = await second.json();
    expect(second.status, JSON.stringify(body)).toBe(200);
    const third = await (await req()).json();
    expect(third.claimCode, 'a retry minted a second code').toBe(body.claimCode);
    expect(minted(kv)).toEqual([`p01:note:claim-minted:${body.claimCode}`]);
    expect(kv.data.get(`p01:note:claim-minted:${body.claimCode}`)).toBe(`payment:${SIG}`);
  });

  it('a failed write of the claim row gives the gate back the same way', async () => {
    const kv = store((k) => k.startsWith('p01:note:claim-minted:'));
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const req = () => POST(post({ signature: SIG, proof: sign(challenge(SIG), buyer) }));
    expect((await req()).status).toBe(503);
    expect(kv.data.get(`p01:note:paid:${SIG}`)).toBeUndefined();
    expect(kv.data.get(`p01:note:paid:${SIG}:code`)).toBeUndefined();
    const body = await (await req()).json();
    expect(body.claimCode).toBeTruthy();
    expect(minted(kv)).toEqual([`p01:note:claim-minted:${body.claimCode}`]);
  });
});

// ── F70 ──────────────────────────────────────────────────────────────────────

const ZK_SHIELDED = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const DISC_V4 = sha256(utf8ToBytes('global:unshield_denominated_stark_v4')).slice(0, 8);

/** A direct circuit-7 withdrawal to the till whose fee payer is `payer`. */
function withdrawal(payer: Keypair, blockTime: number) {
  const ix = new TransactionInstruction({
    programId: ZK_SHIELDED,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      ...Array.from({ length: 7 }, () => ({
        pubkey: Keypair.generate().publicKey,
        isSigner: false,
        isWritable: false,
      })),
      { pubkey: new PublicKey(TILL), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from(DISC_V4), Buffer.alloc(112)]),
  });
  const message = new Transaction({
    recentBlockhash: '11111111111111111111111111111111',
    feePayer: payer.publicKey,
  })
    .add(ix)
    .compileMessage();
  const keys = message.accountKeys.map((k) => k.toBase58());
  const pre = keys.map(() => 1e9);
  const postB = [...pre];
  postB[keys.indexOf(TILL)] += 995_000_000;
  return {
    blockTime,
    meta: { err: null, preBalances: pre, postBalances: postB },
    transaction: {
      message: {
        compiledInstructions: message.compiledInstructions,
        getAccountKeys: () => ({ staticAccountKeys: message.accountKeys }),
      },
    },
  };
}

describe('F70 · no note is sold against a withdrawal whose fee payer a proof copier can be', () => {
  it('🚨 GET says the exchange is off', async () => {
    mockGetStore.mockReturnValue(store());
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.exchange).toBe(false);
  });

  it('🚨 refuses a circuit-7 withdrawal to the till with code EXCHANGE_DISABLED, and takes no gate', async () => {
    // audit-v1-opus/r4-client/p2-exchange-claim-copier.test.ts: the copier
    // lands the buyer's proof as its own fee payer and signs the claim.
    const copier = Keypair.generate();
    chainTx.set(SIG, withdrawal(copier, 1_900_000_000));
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: sign(challenge(SIG), copier) }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.code).toBe('EXCHANGE_DISABLED');
    expect(kv.incr).not.toHaveBeenCalled();
    expect(minted(kv)).toHaveLength(0);
  });

  it('a withdrawal that landed before the operator cutoff is still collected (money already spent)', async () => {
    vi.stubEnv('P01_EXCHANGE_LEGACY_CUTOFF', '1800000000');
    const eph = Keypair.generate();
    chainTx.set(SIG, withdrawal(eph, 1_799_999_000));
    mockGetStore.mockReturnValue(store());
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: sign(challenge(SIG), eph) }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.kind).toBe('pool-withdrawal');
  });

  it('⛔ one that landed after the cutoff is refused like any other', async () => {
    vi.stubEnv('P01_EXCHANGE_LEGACY_CUTOFF', '1800000000');
    const eph = Keypair.generate();
    chainTx.set(SIG, withdrawal(eph, 1_800_000_001));
    mockGetStore.mockReturnValue(store());
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: sign(challenge(SIG), eph) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('EXCHANGE_DISABLED');
  });
});

// ── F11, round 2: a return is credited to one ephemeral, and once ────────────
//
// Verifier round 1 (`verify-r1/probe-double-count.test.ts`): the check summed
// the float's balance change in EVERY transaction that merely named the
// ephemeral, so one sweep back to the float could repay two relayed payments,
// and an ephemeral listed read-only in somebody else's sweep passed while it
// kept its own float lamports.

/** Two relayed payments in one store: SIG funded `a` at LEAF, SIG_B funded `b` at LEAF + 1. */
const SIG_B = '6'.repeat(87);
function twoRelayedStore(a: string, b: string) {
  const kv = store();
  for (const [sig, eph, leaf] of [
    [SIG, a, LEAF],
    [SIG_B, b, LEAF + 1],
  ] as const) {
    kv.data.set(`p01:relay:payment:${sig}`, 1);
    kv.data.set(`p01:relay:payment:${sig}:contribution`, `${POOL_KEY}:${leaf}`);
    kv.data.set(`p01:relay:payment:${sig}:ephemeral-tag`, relayTag(sig, eph));
  }
  return kv;
}
function fallbackFor(sig: string, eph: Keypair, leaf: number) {
  return post({
    signature: sig,
    proof: sign(challenge(sig), buyer),
    contribution: { token: 'SOL', leafIndex: leaf },
    ephemeral: eph.publicKey.toBase58(),
    ephemeralProof: sign(ephemeralChallenge(sig), eph),
  });
}

describe('F11 (round 2) · a return to the float repays one ephemeral, and one payment', () => {
  beforeEach(() => {
    chainTx.set(SIG_B, balanceTx([buyer.publicKey.toBase58(), TILL], [-1_003_005_000, 1_003_000_000]));
  });

  it('🚨 an ephemeral merely LISTED in another key\'s sweep is not repaid by it', async () => {
    const kept = Keypair.generate();
    const swept = Keypair.generate();
    const k = kept.publicKey.toBase58();
    const s = swept.publicKey.toBase58();
    const kv = twoRelayedStore(k, s);
    mockGetStore.mockReturnValue(kv);
    chainTx.set('FUNDK'.padEnd(87, '1'), balanceTx([FLOAT, k], [-(FORWARD + 5_000), FORWARD]));
    chainTx.set('FUNDS'.padEnd(87, '1'), balanceTx([FLOAT, s], [-(FORWARD + 5_000), FORWARD]));
    // ONE sweep: `swept` returns its float, `kept` is listed read-only (delta 0).
    chainTx.set('SWEEP'.padEnd(87, '2'), balanceTx([s, FLOAT, k], [-(FORWARD + 5_000), FORWARD, 0]));
    const sink = Keypair.generate().publicKey.toBase58();
    chainTx.set('AWAY'.padEnd(87, '3'), balanceTx([k, sink], [-(FORWARD - 5_000), FORWARD - 10_000]));
    chainHistory.set(k, ['AWAY'.padEnd(87, '3'), 'SWEEP'.padEnd(87, '2'), 'FUNDK'.padEnd(87, '1')]);
    chainHistory.set(s, ['SWEEP'.padEnd(87, '2'), 'FUNDS'.padEnd(87, '1')]);
    const { POST } = await route();
    const res = await POST(fallbackFor(SIG, kept, LEAF));
    const body = await res.json();
    expect(res.status, 'the ephemeral that KEPT its float was sold a note: ' + JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('RELAYED_FLOAT_NOT_RETURNED');
    expect(minted(kv)).toHaveLength(0);
    // The key that did sweep is still sold its own payment.
    const ok = await POST(fallbackFor(SIG_B, swept, LEAF + 1));
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
  });

  it('🚨 a transaction in which the kept key pays a sink while another key pays the float repays nobody', async () => {
    const kept = Keypair.generate();
    const other = Keypair.generate();
    const k = kept.publicKey.toBase58();
    const o = other.publicKey.toBase58();
    const kv = twoRelayedStore(k, o);
    mockGetStore.mockReturnValue(kv);
    const sink = Keypair.generate().publicKey.toBase58();
    chainTx.set('FUNDK'.padEnd(87, '1'), balanceTx([FLOAT, k], [-(FORWARD + 5_000), FORWARD]));
    // One transaction: k -> sink, o -> float. The float's gain is o's money.
    chainTx.set(
      'MIXED'.padEnd(87, '2'),
      balanceTx([k, sink, o, FLOAT], [-(FORWARD + 5_000), FORWARD, -FORWARD, FORWARD]),
    );
    chainHistory.set(k, ['MIXED'.padEnd(87, '2'), 'FUNDK'.padEnd(87, '1')]);
    const { POST } = await route();
    const res = await POST(fallbackFor(SIG, kept, LEAF));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('RELAYED_FLOAT_NOT_RETURNED');
    expect(minted(kv)).toHaveLength(0);
  });

  it('🚨 one return transaction backs one payment: a second payment funding the same key is not repaid by it', async () => {
    const eph = Keypair.generate();
    const e = eph.publicKey.toBase58();
    const kv = twoRelayedStore(e, e);
    mockGetStore.mockReturnValue(kv);
    chainTx.set('FUNDA'.padEnd(87, '1'), balanceTx([FLOAT, e], [-(FORWARD + 5_000), FORWARD]));
    chainTx.set('SWEEP'.padEnd(87, '2'), balanceTx([e, FLOAT], [-(FORWARD + 5_000), FORWARD - 20_000]));
    chainHistory.set(e, ['SWEEP'.padEnd(87, '2'), 'FUNDA'.padEnd(87, '1')]);
    const { POST } = await route();
    const first = await POST(fallbackFor(SIG, eph, LEAF));
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(200);
    // Payment B's relay row names the same key; the only return on chain has
    // already backed payment A.
    const second = await POST(fallbackFor(SIG_B, eph, LEAF + 1));
    const body = await second.json();
    expect(second.status, 'one sweep sold two payments: ' + JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('RELAYED_FLOAT_NOT_RETURNED');
    expect(minted(kv)).toHaveLength(1);
  });

  it('the same payment asking again is still repaid by the return it already holds', async () => {
    const eph = Keypair.generate();
    // The code row write fails once, so the first attempt ends 503 after the
    // return was recorded against this payment.
    const kv = store((k) => k.endsWith(':code'));
    kv.data.set(`p01:relay:payment:${SIG}`, 1);
    kv.data.set(`p01:relay:payment:${SIG}:contribution`, `${POOL_KEY}:${LEAF}`);
    kv.data.set(`p01:relay:payment:${SIG}:ephemeral-tag`, relayTag(SIG, eph.publicKey.toBase58()));
    mockGetStore.mockReturnValue(kv);
    ephemeralHistory(eph, FORWARD - 60_000);
    const { POST } = await route();
    expect((await POST(fallback(eph))).status).toBe(503);
    const res = await POST(fallback(eph));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(minted(kv)).toHaveLength(1);
  });

  it('the row that spends a return names neither the return nor the ephemeral in clear', async () => {
    const eph = Keypair.generate();
    const kv = relayedStore(eph.publicKey.toBase58());
    mockGetStore.mockReturnValue(kv);
    ephemeralHistory(eph, FORWARD - 60_000);
    const before = new Set(kv.data.keys());
    const { POST } = await route();
    expect((await POST(fallback(eph))).status).toBe(200);
    const added = [...kv.data.entries()].filter(([k]) => !before.has(k));
    const dump = JSON.stringify(added);
    expect(added.some(([k]) => k.startsWith('p01:relay:return:')), 'no return row was written').toBe(true);
    expect(dump).not.toContain('SWEEP'.padEnd(87, '2'));
    expect(dump).not.toContain(eph.publicKey.toBase58());
  });
});

// ── F70, round 2: a withdrawal wrapped in another program is still one ─────────

describe('F70 (round 2) · a circuit-7 withdrawal reached through CPI is refused like a direct one', () => {
  function wrapped(copier: Keypair, withInner: boolean) {
    // verify-r1/probe-cpi-wrap.test.ts: the copier re-uploads the copied proof,
    // calls circuit 7 from a program of its own, and tops the till up by 0.005 SOL.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const direct = withdrawal(copier, 1_900_000_000) as any;
    const wrapperProgram = Keypair.generate().publicKey;
    const keys: PublicKey[] = [...direct.transaction.message.getAccountKeys().staticAccountKeys, wrapperProgram];
    const c7 = direct.transaction.message.compiledInstructions[0];
    const tillIdx = keys.findIndex((k) => k.toBase58() === TILL);
    direct.transaction.message.compiledInstructions = [
      { programIdIndex: keys.length - 1, accountKeyIndexes: c7.accountKeyIndexes, data: new Uint8Array([1]) },
    ];
    direct.transaction.message.getAccountKeys = () => ({ staticAccountKeys: keys });
    direct.meta.preBalances = keys.map(() => 1e9);
    direct.meta.postBalances = keys.map(() => 1e9);
    direct.meta.postBalances[tillIdx] += 995_000_000 + 5_000_000;
    if (withInner) {
      direct.meta.innerInstructions = [
        {
          index: 0,
          instructions: [
            { programIdIndex: c7.programIdIndex, accounts: c7.accountKeyIndexes, data: bs58.encode(Buffer.from(c7.data)) },
          ],
        },
      ];
    }
    return direct;
  }

  it('🚨 the copier of a CPI-wrapped withdrawal is not sold the note (EXCHANGE_DISABLED, no gate)', async () => {
    const copier = Keypair.generate();
    chainTx.set(SIG, wrapped(copier, true));
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: sign(challenge(SIG), copier) }));
    const body = await res.json();
    expect(res.status, 'the copier was sold the note: ' + JSON.stringify(body)).toBe(403);
    expect(body.code).toBe('EXCHANGE_DISABLED');
    expect(kv.incr).not.toHaveBeenCalled();
    expect(minted(kv)).toHaveLength(0);
  });

  it('🚨 refused even before the operator cutoff: an honest exchange was never wrapped', async () => {
    vi.stubEnv('P01_EXCHANGE_LEGACY_CUTOFF', '2000000000');
    const copier = Keypair.generate();
    chainTx.set(SIG, wrapped(copier, true));
    mockGetStore.mockReturnValue(store());
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: sign(challenge(SIG), copier) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('EXCHANGE_DISABLED');
  });

  it('🚨 refused when the RPC returns no inner instructions: naming the pool program is enough', async () => {
    const copier = Keypair.generate();
    chainTx.set(SIG, wrapped(copier, false));
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: sign(challenge(SIG), copier) }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.code).toBe('EXCHANGE_DISABLED');
    expect(minted(kv)).toHaveLength(0);
  });

  it('a plain transfer to the till is still sold', async () => {
    mockGetStore.mockReturnValue(store());
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: sign(challenge(SIG), buyer) }));
    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe('transfer');
  });
});

// ── F57, round 2: a payment that failed on chain says so with a stable code ───

describe('F57 (round 2) · a payment that failed on chain is refused with a code the client can act on', () => {
  it('🚨 answers 400 with code PAYMENT_FAILED_ON_CHAIN', async () => {
    const failed = balanceTx([buyer.publicKey.toBase58(), TILL], [-5_000, 0]);
    (failed.meta as Record<string, unknown>).err = { InstructionError: [0, 'Custom'] };
    chainTx.set(SIG, failed);
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: sign(challenge(SIG), buyer) }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe('PAYMENT_FAILED_ON_CHAIN');
    expect(kv.incr).not.toHaveBeenCalled();
  });
});

describe('F11 (round 2) · what counts as the ephemeral giving the float back', () => {
  /** `balanceTx` with a message header: the first `signers` keys signed. */
  function signedTx(keys: string[], deltas: number[], signers: number) {
    const tx = balanceTx(keys, deltas) as ReturnType<typeof balanceTx> & {
      transaction: { message: { header?: unknown } };
    };
    tx.transaction.message.header = {
      numRequiredSignatures: signers,
      numReadonlySignedAccounts: 0,
      numReadonlyUnsignedAccounts: 0,
    };
    return tx;
  }

  it('the worker\'s close-and-sweep (proof buffer closed, everything to the float in one transaction) repays it', async () => {
    // `stark.ts` closeStarkProofBuffer with `sweepTo`: the buffer's rent comes
    // back through the ephemeral and leaves with its balance, in one transaction.
    const eph = Keypair.generate();
    const e = eph.publicKey.toBase58();
    const buffer = Keypair.generate().publicKey.toBase58();
    const RENT = 400_000_000;
    const kv = relayedStore(e);
    mockGetStore.mockReturnValue(kv);
    chainTx.set('FUND'.padEnd(87, '1'), balanceTx([FLOAT, e], [-(FORWARD + 5_000), FORWARD]));
    // The ephemeral pays the buffer's rent (the float is not named).
    chainTx.set('BUF'.padEnd(87, '2'), signedTx([e, buffer], [-(RENT + 5_000), RENT], 1));
    const amount = FORWARD - RENT - 5_000 + RENT - 5_000;
    chainTx.set(
      'CLOSE'.padEnd(87, '3'),
      signedTx([e, buffer, FLOAT], [RENT - amount - 5_000, -RENT, amount], 1),
    );
    chainHistory.set(e, ['CLOSE'.padEnd(87, '3'), 'BUF'.padEnd(87, '2'), 'FUND'.padEnd(87, '1')]);
    const { POST } = await route();
    const res = await POST(fallback(eph));
    const body = await res.json();
    expect(res.status, 'an honest close-and-sweep was not credited: ' + JSON.stringify(body)).toBe(200);
  });

  it('⛔ another SIGNER paying the float beside the ephemeral does not repay the ephemeral', async () => {
    const kept = Keypair.generate();
    const k = kept.publicKey.toBase58();
    const wallet = Keypair.generate().publicKey.toBase58();
    const kv = relayedStore(k);
    mockGetStore.mockReturnValue(kv);
    chainTx.set('FUND'.padEnd(87, '1'), balanceTx([FLOAT, k], [-(FORWARD + 5_000), FORWARD]));
    // k gives 1 lamport; a wallet of the caller's pays the float the rest.
    chainTx.set('TOPUP'.padEnd(87, '2'), signedTx([k, wallet, FLOAT], [-5_001, -FORWARD, FORWARD + 1], 2));
    chainHistory.set(k, ['TOPUP'.padEnd(87, '2'), 'FUND'.padEnd(87, '1')]);
    const { POST } = await route();
    const res = await POST(fallback(kept));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('RELAYED_FLOAT_NOT_RETURNED');
  });
});

// ── round 3: cases the verifier's mutants showed were unpinned ──────────────

describe('F70 (round 3) · the pool program reached only through a lookup table is still seen', () => {
  it('🚨 a CPI-wrapped withdrawal whose pool program sits only in meta.loadedAddresses is refused (EXCHANGE_DISABLED, no gate)', async () => {
    // verify-r2/probe-append.ts: the copier removes the zk_shielded program from
    // the static keys, loads it through an address lookup table, and wraps
    // circuit 7 in a program of its own. The RPC returns no inner instructions.
    // Mutant R-F70-no-loaded (the loaded addresses dropped from the scan) sold
    // this copier the note as a 'transfer'.
    const copier = Keypair.generate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const direct = withdrawal(copier, 1_900_000_000) as any;
    const statics: PublicKey[] = direct.transaction.message.getAccountKeys().staticAccountKeys;
    const c7 = direct.transaction.message.compiledInstructions[0];
    const program = statics[c7.programIdIndex];
    expect(program.toBase58()).toBe(ZK_SHIELDED.toBase58());
    const wrapperProgram = Keypair.generate().publicKey;
    const keys = [...statics.filter((_, i) => i !== c7.programIdIndex), wrapperProgram];
    expect(keys.some((k) => k.equals(ZK_SHIELDED)), 'the pool program is still a static key').toBe(false);
    const tillIdx = keys.findIndex((k) => k.toBase58() === TILL);
    direct.transaction.message.compiledInstructions = [
      { programIdIndex: keys.length - 1, accountKeyIndexes: [0, tillIdx], data: new Uint8Array([1]) },
    ];
    direct.transaction.message.getAccountKeys = () => ({ staticAccountKeys: keys });
    direct.meta.loadedAddresses = { writable: [], readonly: [program] };
    direct.meta.preBalances = [...keys, program].map(() => 1e9);
    direct.meta.postBalances = [...keys, program].map(() => 1e9);
    direct.meta.postBalances[tillIdx] += 1_000_000_000 + 5_000_000;
    delete direct.meta.innerInstructions;
    chainTx.set(SIG, direct);
    const kv = store();
    mockGetStore.mockReturnValue(kv);
    const { POST } = await route();
    const res = await POST(post({ signature: SIG, proof: sign(challenge(SIG), copier) }));
    const body = await res.json();
    expect(res.status, 'the copier was sold the note: ' + JSON.stringify(body)).toBe(403);
    expect(body.code).toBe('EXCHANGE_DISABLED');
    expect(kv.incr).not.toHaveBeenCalled();
    expect(minted(kv)).toHaveLength(0);
  });
});

describe('F11 (round 3) · a failed owner write gives the return back', () => {
  it('🚨 the first attempt answers 503 and leaves no ownerless return row; the retry mints once', async () => {
    // verify-r2/probe-append.ts. Mutant R-F11-owner-fail-keeps-row (no `kv.del`
    // of the return row when its `:owner` write fails) left the row taken with
    // no owner, so this payment's fallback was refused for good.
    const eph = Keypair.generate();
    const kv = store((k) => k.endsWith(':owner'));
    kv.data.set(`p01:relay:payment:${SIG}`, 1);
    kv.data.set(`p01:relay:payment:${SIG}:contribution`, `${POOL_KEY}:${LEAF}`);
    kv.data.set(`p01:relay:payment:${SIG}:ephemeral-tag`, relayTag(SIG, eph.publicKey.toBase58()));
    mockGetStore.mockReturnValue(kv);
    ephemeralHistory(eph, FORWARD - 60_000);
    const { POST } = await route();
    const first = await POST(fallback(eph));
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(503);
    expect(minted(kv), 'a failed attempt minted').toHaveLength(0);
    const returnRows = [...kv.data.keys()].filter((k) => k.startsWith('p01:relay:return:'));
    expect(returnRows, 'the return row stayed taken with no owner').toEqual([]);
    const res = await POST(fallback(eph));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(minted(kv)).toEqual([`p01:note:claim-minted:${body.claimCode}`]);
  });
});
