/**
 * MOBILE's circuit-7 subscribe — the binding, the wire, the account order and
 * the per-note route, pinned independently of the web twin.
 *
 * ⛔ NOT REDUNDANT WITH apps/web's copy. On 2026-08-21 the extension and the
 * mobile app were found shipping a prover blob the deployed verifier REJECTS
 * while the web app carried the right one: three surfaces, three copies, one
 * checked. This port is a copy of the web file and will drift the same way
 * unless something in this package asserts on it.
 *
 * Wherever a layout is pinned it is pinned against the RUST SOURCE
 * (`programs/zk_shielded/src/instructions/subscribe_private_stark_v4.rs`),
 * never against a second copy of this file's own arithmetic: a list retyped
 * from memory agrees with the encoder by construction whenever the same person
 * wrote both, which is exactly how the web's vault/pool swap survived.
 *
 * ⚠️ WHAT THIS FILE CANNOT SAY. It never touches an RPC, a WebView or the WASM,
 * so a green run says nothing about whether a circuit-7 proof verifies, and
 * nothing about a phone. No device and no devnet send exist for this path yet.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  C7_SUBSCRIBE_DOMAIN,
  LEGACY_BLINDING_CEILING,
  SUBSCRIBE_PREIMAGE_LEN,
  SubscribeV4Unprovable,
  assertPreparedMatchesTerms,
  buildSubscribePrivateStarkV4Ix,
  chooseSubscribeRoute,
  subscribeBindingDigest,
  subscribeBindingLimbs,
  subscribeBindingPreimage,
  subscribePrivateStarkV4,
  whySubscribeCircuit7Cannot,
  type PrepareSubscribeV4Result,
  type SubscribeBinding,
  type SubscribeV4IxParams,
} from './subscribePrivateStarkV4';
import { ZK_SHIELDED_PROGRAM_ID } from './index';
import { SPEND_SUBTREE_DEPTH } from '../stark/spendWitness';
import { C7_SUBTREE_DEPTH, type PoolConfig, type ShieldReceipt } from '../denominatedPool';

const REPO = join(__dirname, '../../../..');
const RUST = 'programs/zk_shielded/src/instructions/subscribe_private_stark_v4.rs';
const RUST_SRC = readFileSync(join(REPO, RUST), 'utf8');

const VAULT = new PublicKey('11111111111111111111111111111112');
const RETAILER = Keypair.generate().publicKey;
const GOLDILOCKS_MODULUS = 0xffffffff00000001n;

function binding(over: Partial<SubscribeBinding> = {}): SubscribeBinding {
  return {
    vault: VAULT,
    rate: 250_000n,
    intervalSlots: 216_000n,
    vkHashSubscriber: new Uint8Array(32).fill(0xa5),
    ...over,
  };
}

/** The 4-level tail of an 11-deep circuit on the pool's depth-15 tree. */
const TAIL = 15 - SPEND_SUBTREE_DEPTH;
const SIBLINGS = Array.from({ length: TAIL }, (_, i) => 0x1111111111111111n * BigInt(i + 1));
const DIRECTIONS = Array.from({ length: TAIL }, (_, i) => i % 2);

const NULLIFIER = 0x1122334455667788n;
const POOL_ROOT = 0x99aabbccddeeff00n;
const SUBTREE_ROOT = 0x0123456789abcdefn;
/** The two values a v4 instruction must never contain. */
const NOTE_COMMITMENT = 0xdeadbeefcafebaben;
const NOTE_BLINDING = 0x7fedcba987654321n;

const le32 = (v: bigint): number[] => {
  const out = new Array<number>(32).fill(0);
  for (let i = 0; i < 8; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return out;
};

function ixParams(over: Partial<SubscribeV4IxParams> = {}): SubscribeV4IxParams {
  return {
    payer: Keypair.generate().publicKey,
    retailer: RETAILER,
    vaultPDA: VAULT,
    poolPDA: new PublicKey('11111111111111111111111111111113'),
    treePDA: new PublicKey('11111111111111111111111111111114'),
    nullifierPDA: new PublicKey('11111111111111111111111111111115'),
    c7ProofBuffer: new PublicKey('11111111111111111111111111111116'),
    nullifierBytes: le32(NULLIFIER),
    merkleRootBytes: le32(POOL_ROOT),
    subtreeRoot: SUBTREE_ROOT,
    siblings: SIBLINGS,
    directions: DIRECTIONS,
    subscriberCommitmentBytes: new Uint8Array(32).fill(0x42),
    rate: 250_000n,
    intervalSlots: 216_000n,
    vkHashSubscriber: new Uint8Array(32).fill(0xa5),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The two depth mirrors
// ---------------------------------------------------------------------------

describe('the circuit depth mobile slices at is the one the circuit has', () => {
  it('C7_SUBTREE_DEPTH and SPEND_SUBTREE_DEPTH agree, and both are 11', () => {
    // Two mirrors of `stark/src/air/spend.rs` CANONICAL_DEPTH exist in this
    // app; the prepare refuses to run if they disagree, and this pins them.
    expect(C7_SUBTREE_DEPTH).toBe(SPEND_SUBTREE_DEPTH);
    expect(C7_SUBTREE_DEPTH).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// The binding — the exact 132 bytes the chain rebuilds
// ---------------------------------------------------------------------------

describe('the subscribe binding preimage is the exact 132 bytes the chain rebuilds', () => {
  it('is 132 bytes, never more and never fewer', () => {
    expect(SUBSCRIBE_PREIMAGE_LEN).toBe(132);
    expect(subscribeBindingPreimage(binding()).length).toBe(132);
  });

  it('is STILL 132 bytes with a licence, because the slot is fixed width', () => {
    expect(
      subscribeBindingPreimage(binding({ licenseCommitment: new Uint8Array(32).fill(7) })).length,
    ).toBe(132);
  });

  it('opens with the frozen 19-byte domain tag the Rust file declares, no NUL', () => {
    expect(Buffer.from(C7_SUBSCRIBE_DOMAIN).toString('utf8')).toBe('P01:C7:SUBSCRIBE:v1');
    expect(C7_SUBSCRIBE_DOMAIN.length).toBe(19);
    expect(RUST_SRC).toContain('const C7_SUBSCRIBE_DOMAIN: &[u8] = b"P01:C7:SUBSCRIBE:v1";');
    const pre = subscribeBindingPreimage(binding());
    expect(Buffer.from(pre.subarray(0, 19)).toString('utf8')).toBe('P01:C7:SUBSCRIBE:v1');
    expect(pre[19]).not.toBe(0);
  });

  it('lays the fields out in the handler order, at the handler offsets', () => {
    // hashv(&[DOMAIN, vault, rate LE, interval LE, vk, lic[33]]) — read the
    // call out of the source so a reordering there goes red here.
    const call = RUST_SRC.slice(
      RUST_SRC.indexOf('let digest = solana_sha256_hasher::hashv(&['),
      RUST_SRC.indexOf('.to_bytes();', RUST_SRC.indexOf('let digest = solana_sha256_hasher::hashv(&[')),
    );
    const order = ['C7_SUBSCRIBE_DOMAIN', 'vault.as_ref()', 'rate.to_le_bytes()', 'interval_slots.to_le_bytes()', 'vk_hash_subscriber', '&lic'];
    let last = -1;
    for (const needle of order) {
      const at = call.indexOf(needle);
      expect(at, `${needle} missing from the handler's hashv`).toBeGreaterThan(last);
      last = at;
    }

    const lic = new Uint8Array(32).fill(0x33);
    const b = binding({ licenseCommitment: lic });
    const pre = Buffer.from(subscribeBindingPreimage(b));
    expect(pre.subarray(19, 51).equals(Buffer.from(VAULT.toBytes()))).toBe(true);
    expect(pre.readBigUInt64LE(51)).toBe(250_000n);
    expect(pre.readBigUInt64LE(59)).toBe(216_000n);
    expect(pre.subarray(67, 99).equals(Buffer.from(b.vkHashSubscriber))).toBe(true);
    expect(pre[99]).toBe(1);
    expect(pre.subarray(100, 132).equals(Buffer.from(lic))).toBe(true);
  });

  it('zeroes the whole 33-byte licence slot when there is no licence', () => {
    const pre = subscribeBindingPreimage(binding());
    expect(Array.from(pre.subarray(99, 132)).every((x) => x === 0)).toBe(true);
  });

  it('moves the digest when the RATE moves, which is the reason it exists', () => {
    expect(subscribeBindingDigest(binding({ rate: 1n }))).not.toEqual(
      subscribeBindingDigest(binding({ rate: 2n })),
    );
  });

  it('moves the digest when the INTERVAL moves', () => {
    expect(subscribeBindingDigest(binding({ intervalSlots: 1n }))).not.toEqual(
      subscribeBindingDigest(binding({ intervalSlots: 2n })),
    );
  });

  it('separates an absent licence from an all-zero one', () => {
    expect(subscribeBindingDigest(binding())).not.toEqual(
      subscribeBindingDigest(binding({ licenseCommitment: new Uint8Array(32) })),
    );
  });

  it('is domain-separated from a bare sha256 of the vault', () => {
    expect(subscribeBindingDigest(binding())).not.toEqual(sha256(VAULT.toBytes()));
  });

  it('refuses a vkHashSubscriber that is not 32 bytes', () => {
    expect(() => subscribeBindingPreimage(binding({ vkHashSubscriber: new Uint8Array(31) }))).toThrow(/32 bytes/);
  });

  it('refuses rate = 0 and intervalSlots = 0, the handler`s first two requires', () => {
    expect(() => subscribeBindingPreimage(binding({ rate: 0n }))).toThrow(/rate/);
    expect(() => subscribeBindingPreimage(binding({ intervalSlots: 0n }))).toThrow(/interval/);
    expect(RUST_SRC).toContain('require!(rate > 0, ZkShieldedError::InvalidRate);');
    expect(RUST_SRC).toContain('require!(interval_slots > 0, ZkShieldedError::InvalidInterval);');
  });
});

describe('the four limbs reassemble the digest byte for byte', () => {
  it('is the digest read as four little-endian u64s, carried RAW', () => {
    const b = binding();
    const digest = subscribeBindingDigest(b);
    const limbs = subscribeBindingLimbs(b);
    expect(limbs).toHaveLength(4);
    const rejoined = Buffer.alloc(32);
    limbs.forEach((l, i) => rejoined.writeBigUInt64LE(l, i * 8));
    expect(rejoined.equals(Buffer.from(digest))).toBe(true);
  });

  it('reads each limb straight off the digest with no reduction mod p', () => {
    // A limb above p is a 2**-32 event per draw, so it is not searched for;
    // the statement is made structurally instead: every limb equals the raw
    // little-endian read of its eight digest bytes, whatever their value.
    const b = binding();
    const digest = Buffer.from(subscribeBindingDigest(b));
    subscribeBindingLimbs(b).forEach((l, i) => expect(l).toBe(digest.readBigUInt64LE(i * 8)));
  });
});

// ---------------------------------------------------------------------------
// The instruction
// ---------------------------------------------------------------------------

describe('mobile: subscribe_private_stark_v4 — the wire', () => {
  it('opens with sha256("global:subscribe_private_stark_v4")[..8]', () => {
    const data = buildSubscribePrivateStarkV4Ix(ixParams()).data;
    const expected = Buffer.from(sha256(new TextEncoder().encode('global:subscribe_private_stark_v4')).slice(0, 8));
    expect(data.subarray(0, 8).equals(expected)).toBe(true);
  });

  it('is 205 bytes with the 4-level tail and no licence, 237 with one', () => {
    // 8 + 32 + 32 + 8 + (4 + 4*8) + (4 + 4) + 32 + 8 + 8 + 32 + 1 = 205
    expect(buildSubscribePrivateStarkV4Ix(ixParams()).data.length).toBe(205);
    expect(
      buildSubscribePrivateStarkV4Ix(ixParams({ licenseCommitment: new Uint8Array(32).fill(1) })).data.length,
    ).toBe(237);
  });

  it('puts every argument at the offset the Rust argument order implies', () => {
    const lic = new Uint8Array(32).fill(0x77);
    const p = ixParams({ licenseCommitment: lic });
    const data = buildSubscribePrivateStarkV4Ix(p).data;
    let o = 8;
    expect(data.subarray(o, o + 32).equals(Buffer.from(le32(NULLIFIER)))).toBe(true); o += 32;
    expect(data.subarray(o, o + 32).equals(Buffer.from(le32(POOL_ROOT)))).toBe(true); o += 32;
    expect(data.readBigUInt64LE(o)).toBe(SUBTREE_ROOT); o += 8;
    expect(data.readUInt32LE(o)).toBe(TAIL); o += 4;
    for (const s of SIBLINGS) { expect(data.readBigUInt64LE(o)).toBe(s); o += 8; }
    expect(data.readUInt32LE(o)).toBe(TAIL); o += 4;
    for (const d of DIRECTIONS) { expect(data.readUInt8(o)).toBe(d); o += 1; }
    expect(data.subarray(o, o + 32).equals(Buffer.from(p.subscriberCommitmentBytes))).toBe(true); o += 32;
    expect(data.readBigUInt64LE(o)).toBe(250_000n); o += 8;
    expect(data.readBigUInt64LE(o)).toBe(216_000n); o += 8;
    expect(data.subarray(o, o + 32).equals(Buffer.from(p.vkHashSubscriber))).toBe(true); o += 32;
    expect(data.readUInt8(o)).toBe(1); o += 1;
    expect(data.subarray(o, o + 32).equals(Buffer.from(lic))).toBe(true); o += 32;
    expect(o).toBe(data.length);

    // And the Rust handler takes them in that order.
    const sig = RUST_SRC.slice(RUST_SRC.indexOf('pub fn handler('), RUST_SRC.indexOf(') -> Result<()> {'));
    const args = ['nullifier: [u8; 32]', 'merkle_root: [u8; 32]', 'subtree_root: u64', 'siblings: Vec<u64>',
      'directions: Vec<u8>', 'subscriber_commitment: [u8; 32]', 'rate: u64', 'interval_slots: u64',
      'vk_hash_subscriber: [u8; 32]', 'license_commitment: Option<[u8; 32]>'];
    let last = -1;
    for (const a of args) {
      const at = sig.indexOf(a);
      expect(at, `${a} not in handler order`).toBeGreaterThan(last);
      last = at;
    }
  });

  it('carries NO stark_commitment and NO min_epoch, which is the property', () => {
    const data = buildSubscribePrivateStarkV4Ix(ixParams()).data;
    for (const forbidden of [NOTE_COMMITMENT, NOTE_BLINDING]) {
      const needle = Buffer.alloc(8);
      needle.writeBigUInt64LE(forbidden);
      for (let i = 0; i + 8 <= data.length; i++) {
        expect(data.subarray(i, i + 8).equals(needle)).toBe(false);
      }
    }
    expect(RUST_SRC).not.toMatch(/stark_commitment: \[u8; 32\]/);
    expect(RUST_SRC).not.toMatch(/\bmin_epoch: u64/);
  });

  it('refuses siblings/directions mismatch, a non-binary direction, a non-canonical sibling', () => {
    expect(() => buildSubscribePrivateStarkV4Ix(ixParams({ directions: DIRECTIONS.slice(1) }))).toThrow(/WrongSiblingCount/);
    expect(() => buildSubscribePrivateStarkV4Ix(ixParams({ directions: [2, ...DIRECTIONS.slice(1)] }))).toThrow(/NonBinaryDirection/);
    expect(() => buildSubscribePrivateStarkV4Ix(ixParams({ siblings: [GOLDILOCKS_MODULUS, ...SIBLINGS.slice(1)] }))).toThrow(/NonCanonicalFelt/);
  });
});

// ---------------------------------------------------------------------------
// Account order — parsed out of the Rust struct, never retyped
// ---------------------------------------------------------------------------

interface RustAccount { name: string; ty: string; optional: boolean; writable: boolean; signer: boolean }

function parseAccountsStruct(): RustAccount[] {
  const STRUCT = "pub struct SubscribePrivateStarkV4<'info> {";
  const start = RUST_SRC.indexOf(STRUCT);
  expect(start, `${RUST} no longer declares ${STRUCT}`).toBeGreaterThan(-1);
  const body = RUST_SRC.slice(start + STRUCT.length, RUST_SRC.indexOf('\n}', start));
  const out: RustAccount[] = [];
  let attr = '';
  let inAttr = false;
  for (const rawLine of body.split('\n')) {
    const trimmed = rawLine.trim();
    if (inAttr) { attr += '\n' + rawLine; if (trimmed.endsWith(')]')) inAttr = false; continue; }
    if (trimmed.startsWith('#[account(')) { attr += '\n' + rawLine; if (!trimmed.endsWith(')]')) inAttr = true; continue; }
    const field = trimmed.match(/^pub (\w+):\s*(.+?),?$/);
    if (!field) continue;
    const clean = attr.replace(/\/\/.*$/gm, '');
    out.push({
      name: field[1], ty: field[2],
      optional: /^Option</.test(field[2]),
      writable: /\bmut\b/.test(clean) || /\binit\b/.test(clean),
      signer: /\bSigner</.test(field[2]),
    });
    attr = '';
  }
  return out;
}

describe('the account list is the Rust struct, in the Rust order', () => {
  const k = () => Keypair.generate().publicKey;
  const supplied = {
    payer: k(), retailer: k(), vaultPDA: k(), poolPDA: k(), treePDA: k(),
    nullifierPDA: k(), c7ProofBuffer: k(), tokenProgram: k(), poolVault: k(), vaultTokenAccount: k(),
  };
  /** Rust field name → the pubkey the encoder must put there. A NAME map, never an ORDER map. */
  const roleOf: Record<string, PublicKey> = {
    payer: supplied.payer,
    retailer: supplied.retailer,
    vault: supplied.vaultPDA,
    denominated_pool: supplied.poolPDA,
    merkle_tree: supplied.treePDA,
    nullifier_record: supplied.nullifierPDA,
    c7_proof_buffer: supplied.c7ProofBuffer,
    system_program: SystemProgram.programId,
    token_program: supplied.tokenProgram,
    pool_vault: supplied.poolVault,
    vault_token_account: supplied.vaultTokenAccount,
  };

  it('binds index to role for all eleven, with the Rust signer and mut flags', () => {
    const rust = parseAccountsStruct();
    expect(rust.map((a) => a.name)).toEqual(Object.keys(roleOf));
    const keys = buildSubscribePrivateStarkV4Ix(ixParams(supplied)).keys;
    expect(keys).toHaveLength(rust.length);
    rust.forEach((a, i) => {
      expect(keys[i].pubkey.equals(roleOf[a.name]), `index ${i} should be ${a.name}`).toBe(true);
      expect(keys[i].isSigner, `${a.name} signer`).toBe(a.signer);
      expect(keys[i].isWritable, `${a.name} writable`).toBe(a.writable);
    });
  });

  it('encodes an absent optional as the program`s own id, and never shortens the list', () => {
    const rust = parseAccountsStruct();
    const keys = buildSubscribePrivateStarkV4Ix(ixParams()).keys;
    expect(keys).toHaveLength(rust.length);
    rust.forEach((a, i) => {
      if (a.optional) {
        expect(keys[i].pubkey.equals(ZK_SHIELDED_PROGRAM_ID), `${a.name} sentinel`).toBe(true);
        expect(keys[i].isWritable).toBe(false);
      }
    });
  });

  it('names ONE proof buffer and NO fee_escrow', () => {
    const names = parseAccountsStruct().map((a) => a.name);
    expect(names.filter((n) => n.includes('proof_buffer'))).toEqual(['c7_proof_buffer']);
    expect(names).not.toContain('fee_escrow');
  });
});

// ---------------------------------------------------------------------------
// The route — an allow-list, checked on `instanceof`
// ---------------------------------------------------------------------------

describe('the per-note route between circuit 7 and the C1 + C3 pair', () => {
  const PRF_NOTE = { depositEpoch: 0x7fedcba987654321n };
  const EPOCH_NOTE = { depositEpoch: 67_838n };

  it('refuses an epoch-blinded note synchronously, with the web`s needle in the message', () => {
    expect(whySubscribeCircuit7Cannot(EPOCH_NOTE)).toMatch(/circuit 7 needs at least/);
    expect(whySubscribeCircuit7Cannot(EPOCH_NOTE)).toMatch(/deposit\s+epoch|predates commitment blinding/i);
    expect(whySubscribeCircuit7Cannot(PRF_NOTE)).toBeNull();
    expect(LEGACY_BLINDING_CEILING).toBe(2n ** 32n);
  });

  it('routes an epoch note to v3 WITHOUT calling the prepare', async () => {
    const prepare = vi.fn(async () => 'never');
    const route = await chooseSubscribeRoute(EPOCH_NOTE, prepare);
    expect(route.version).toBe('v3');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('routes a PRF note to v4 when the prepare succeeds', async () => {
    const route = await chooseSubscribeRoute(PRF_NOTE, async () => ({ ok: true }));
    expect(route).toEqual({ version: 'v4', prepared: { ok: true } });
  });

  it('falls back to v3 ONLY on SubscribeV4Unprovable', async () => {
    const route = await chooseSubscribeRoute(PRF_NOTE, async () => {
      throw new SubscribeV4Unprovable('PRE-FLIGHT FAIL: root not in ring');
    });
    expect(route).toEqual({ version: 'v3', reason: 'PRE-FLIGHT FAIL: root not in ring' });
  });

  it('RETHROWS every other error — a broken prover must not republish the commitment', async () => {
    await expect(
      chooseSubscribeRoute(PRF_NOTE, async () => { throw new Error('Circuit 7 must publish exactly 6 felts, got 5.'); }),
    ).rejects.toThrow(/exactly 6 felts/);
    // And the text is NOT what routes: an Error carrying the needle still rethrows.
    await expect(
      chooseSubscribeRoute(PRF_NOTE, async () => { throw new Error('circuit 7 needs at least ...'); }),
    ).rejects.toThrow(/circuit 7 needs at least/);
  });

  it('SubscribeV4Unprovable survives instanceof through an async boundary', async () => {
    const e = await (async () => { throw new SubscribeV4Unprovable('x'); })().catch((err) => err);
    expect(e instanceof SubscribeV4Unprovable).toBe(true);
    expect(e instanceof Error).toBe(true);
    expect(e.name).toBe('SubscribeV4Unprovable');
  });
});

// ---------------------------------------------------------------------------
// Prepared-vs-executed — reachable with no connection, no wallet, no prover
// ---------------------------------------------------------------------------

describe('the send refuses terms that differ from the ones the proof was bound to', () => {
  const receipt = { leafIndex: 3 } as unknown as ShieldReceipt;
  const poolConfig = {
    poolPDA: new PublicKey('11111111111111111111111111111113'),
    treePDA: new PublicKey('11111111111111111111111111111114'),
    tokenMint: SystemProgram.programId,
  } as unknown as PoolConfig;
  const prepared: PrepareSubscribeV4Result = {
    c7ProofResult: { proofBytes: new Uint8Array(0), publicInputs: [1n, 2n, 3n, 4n, 5n, 6n], proofSize: 0 },
    merkleRoot: POOL_ROOT, subtreeRoot: SUBTREE_ROOT, nullifierGoldilocks: NULLIFIER,
    siblings: SIBLINGS, directions: DIRECTIONS,
    binding: binding(), subscriberCommitment: 42n, retailer: RETAILER,
  };
  const base = { receipt, poolConfig, prepared, retailer: RETAILER, subscriberCommitment: 42n, binding: binding() };

  it('passes when everything matches', () => {
    expect(() => assertPreparedMatchesTerms(base)).not.toThrow();
  });

  it.each([
    ['retailer', { retailer: Keypair.generate().publicKey }, /retailer/],
    ['subscriber commitment', { subscriberCommitment: 43n }, /subscriber commitment/],
    ['vault', { binding: binding({ vault: Keypair.generate().publicKey }) }, /vault/],
    ['rate', { binding: binding({ rate: 1n }) }, /rate/],
    ['interval', { binding: binding({ intervalSlots: 1n }) }, /interval/],
    ['vkHash', { binding: binding({ vkHashSubscriber: new Uint8Array(32) }) }, /vkHashSubscriber/],
    ['licence presence', { binding: binding({ licenseCommitment: new Uint8Array(32) }) }, /license presence/],
  ])('refuses a changed %s', (_what, over, re) => {
    expect(() => assertPreparedMatchesTerms({ ...base, ...over })).toThrow(re);
  });

  it('is what `subscribePrivateStarkV4` runs BEFORE any await — no connection needed to be refused', async () => {
    await expect(
      subscribePrivateStarkV4({ ...base, binding: binding({ rate: 1n }) }, undefined, undefined, null as never),
    ).rejects.toThrow(/rate/);
  });
});
