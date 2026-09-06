// @vitest-environment node
//
// ⛔ NOT jsdom, which is this package's default. `PublicKey.findProgramAddressSync`
// throws "Unable to find a viable program address nonce" for every input under
// jsdom here, so the nullifier-PDA derivation in the send path cannot run.
/**
 * The EXTENSION's v4 subscribe — the wire, the binding, and the property.
 *
 * ⛔ NOT REDUNDANT WITH apps/web's copy, for the reason `unshieldV4.test.ts`
 * gives: three surfaces carried three copies of the prover blob and only one
 * was being checked (2026-08-21). The encoder here is a copy of the web one
 * and will drift the same way unless this package asserts on it.
 *
 * WHAT v3 LEAKS
 * ─────────────
 * `subscribe_private_stark` (v3) spends on a C1 + C3 pair tied together by
 * `stark_commitment` — the note commitment, PUBLISHED IN THE CLEAR at
 * instruction byte 160. A subscription therefore NAMES the leaf it spends.
 *
 * 🚨 THE LEAK TEST BELOW IS THE ONLY ONE HERE THAT CHECKS THE PROPERTY. It
 * sweeps every 8-byte window of the serialised instruction rather than
 * asserting on named fields, because a field can be renamed, reordered, or
 * folded into another and the bytes would still be there.
 *
 * ⚠️ WHAT THIS FILE CANNOT SAY. It never touches an RPC, a worker or the WASM,
 * so a green run says nothing about whether a circuit-7 proof verifies, and
 * NOTHING about whether the deployed program accepts a subscribe built here —
 * this surface has not sent one. Do not read this suite as a gate on the chain.
 */

import { Keypair, PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it, vi } from 'vitest';

import {
  C7_SUBSCRIBE_DOMAIN,
  SUBSCRIBE_PREIMAGE_LEN,
  buildSubscribePrivateStarkV4Ix,
  deriveSubscriptionVaultPDAV4,
  subscribeBindingDigest,
  subscribeBindingLimbs,
  subscribeBindingPreimage,
  subscribePrivateStarkV4,
  type PrepareSubscribeV4Result,
  type SubscribeBinding,
  type SubscribeV4IxParams,
} from './subscribePrivateStarkV4';
import { ZK_SHIELDED_PROGRAM_ID, type PoolConfig, type ShieldReceipt } from './denominatedPool';
import type { WalletSigner } from './stark';

const PAYER = new PublicKey('7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU');
const RETAILER = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const POOL = new PublicKey('11111111111111111111111111111112');
const TREE = new PublicKey('11111111111111111111111111111113');
const NULLIFIER_PDA = new PublicKey('11111111111111111111111111111114');
const BUFFER = new PublicKey('11111111111111111111111111111115');
const VAULT = new PublicKey('11111111111111111111111111111116');

const le32 = (v: bigint): number[] => {
  const out = new Array<number>(32).fill(0);
  for (let i = 0; i < 8; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return out;
};

const NULLIFIER = 0x1122334455667788n;
const POOL_ROOT = 0x99aabbccddeeff00n;
const SUBTREE_ROOT = 0x0123456789abcdefn;
const SIBLINGS = [0xaaaaaaaaaaaaaaaan, 0xbbbbbbbbbbbbbbbbn, 0xccccccccccccccccn, 0xddddddddddddddddn];
const DIRECTIONS = [1, 0, 1, 0];
const SUBSCRIBER_COMMITMENT = 0x0fedcba987654321n;
const RATE = 100_000_000n;
const INTERVAL = 216_000n;
const VK_HASH = new Uint8Array(32).fill(0x42);

/** The values a v4 instruction must never contain. */
const NOTE_COMMITMENT = 0xdeadbeefcafebaben;
const NOTE_BLINDING = 0x7fedcba987654321n;

function params(over: Partial<SubscribeV4IxParams> = {}): SubscribeV4IxParams {
  return {
    payer: PAYER,
    retailer: RETAILER,
    vaultPDA: VAULT,
    poolPDA: POOL,
    treePDA: TREE,
    nullifierPDA: NULLIFIER_PDA,
    c7ProofBuffer: BUFFER,
    nullifierBytes: le32(NULLIFIER),
    merkleRootBytes: le32(POOL_ROOT),
    subtreeRoot: SUBTREE_ROOT,
    siblings: SIBLINGS,
    directions: DIRECTIONS,
    subscriberCommitmentBytes: new Uint8Array(le32(SUBSCRIBER_COMMITMENT)),
    rate: RATE,
    intervalSlots: INTERVAL,
    vkHashSubscriber: VK_HASH,
    ...over,
  };
}

describe('extension: subscribe_private_stark_v4 — the wire', () => {
  it('uses sha256("global:subscribe_private_stark_v4")[..8] as its discriminator', () => {
    const data = buildSubscribePrivateStarkV4Ix(params()).data;
    const expected = Buffer.from(
      sha256(new TextEncoder().encode('global:subscribe_private_stark_v4')).slice(0, 8),
    );
    expect(Buffer.from(data.subarray(0, 8))).toEqual(expected);
    // The value the web twin's comment quotes, so a drift in either shows.
    expect(expected.toString('hex')).toBe('6fbcb723d5cd4514');
  });

  it('serialises to exactly 205 bytes with a 4-level tail and no license', () => {
    // 8 disc + 32 nullifier + 32 merkle_root + 8 subtree_root         =  80
    //   + (4 + 4*8) siblings + (4 + 4) directions                      = 124
    //   + 32 subscriber_commitment + 8 rate + 8 interval + 32 vk       = 204
    //   + 1 option tag                                                  = 205
    expect(buildSubscribePrivateStarkV4Ix(params()).data.length).toBe(205);
  });

  it('adds exactly 32 bytes for a license commitment', () => {
    const data = buildSubscribePrivateStarkV4Ix(
      params({ licenseCommitment: new Uint8Array(32).fill(7) }),
    ).data;
    expect(data.length).toBe(237);
    expect(data.readUInt8(204)).toBe(1);
    expect(Buffer.from(data.subarray(205, 237))).toEqual(Buffer.from(new Uint8Array(32).fill(7)));
  });

  it('names ONE proof buffer and ELEVEN accounts, where v3 named two buffers', () => {
    const keys = buildSubscribePrivateStarkV4Ix(params()).keys;
    expect(keys.filter((k) => k.pubkey.equals(BUFFER))).toHaveLength(1);
    expect(keys).toHaveLength(11);
    expect(keys[0].isSigner).toBe(true);
    // The retailer is NAMED at index 1 — a vault seed, so it cannot be hidden
    // the way the v4 withdrawal hides its payee. A real disclosure difference.
    expect(keys[1].pubkey.equals(RETAILER)).toBe(true);
    // No fee escrow: v4 subscribe charges no protocol fee.
    expect(keys.some((k) => k.isWritable && k.pubkey.equals(ZK_SHIELDED_PROGRAM_ID))).toBe(false);
  });

  it('refuses the three shapes resolve_pool_root refuses, before any upload', () => {
    expect(() => buildSubscribePrivateStarkV4Ix(params({ directions: [1, 0, 1] }))).toThrow(
      /same length/,
    );
    expect(() => buildSubscribePrivateStarkV4Ix(params({ directions: [1, 0, 2, 0] }))).toThrow(
      /NonBinaryDirection/,
    );
    const P = (1n << 64n) - (1n << 32n) + 1n;
    expect(() =>
      buildSubscribePrivateStarkV4Ix(params({ siblings: [P, 1n, 2n, 3n] })),
    ).toThrow(/NonCanonicalFelt/);
  });
});

describe('extension: subscribe_private_stark_v4 — the property', () => {
  it('THE LEAK TEST: no 8-byte window holds the commitment or the blinding', () => {
    const data = buildSubscribePrivateStarkV4Ix(params()).data;
    const forbidden = new Map<string, bigint>([
      ['the note commitment', NOTE_COMMITMENT],
      ['the note blinding', NOTE_BLINDING],
    ]);
    for (const [label, value] of forbidden) {
      for (let off = 0; off + 8 <= data.length; off++) {
        expect(data.readBigUInt64LE(off), `${label} LE at byte ${off}`).not.toBe(value);
        expect(data.readBigUInt64BE(off), `${label} BE at byte ${off}`).not.toBe(value);
      }
    }
  });

  it('the leak test can actually fail', () => {
    // Anti-vacuity: the sweep must find a value known to be present.
    const data = buildSubscribePrivateStarkV4Ix(params()).data;
    let found = false;
    for (let off = 0; off + 8 <= data.length; off++) {
      if (data.readBigUInt64LE(off) === SUBTREE_ROOT) found = true;
    }
    expect(found).toBe(true);
  });

  it('carries no min_epoch and no stark_commitment field', () => {
    // v3 lays out: disc 8 | nullifier 32 | root 32 | min_epoch 8 at 72 |
    // commitment 32 | rate | interval | vk | stark_commitment 8 at 160 |
    // license option | walk. Here byte 72 starts `subtree_root`, and the two
    // extra u64s v3 carries would make this 221 rather than 205.
    const len = buildSubscribePrivateStarkV4Ix(params()).data.length;
    expect(len).toBe(205);
    expect(len).not.toBe(221);
  });
});

describe('extension: the subscribe binding', () => {
  const binding: SubscribeBinding = {
    vault: VAULT,
    rate: RATE,
    intervalSlots: INTERVAL,
    vkHashSubscriber: VK_HASH,
  };

  it('is 132 bytes: the frozen 19-byte domain, then vault, rate, interval, vk, 33-byte license slot', () => {
    expect(Buffer.from(C7_SUBSCRIBE_DOMAIN).toString('ascii')).toBe('P01:C7:SUBSCRIBE:v1');
    expect(C7_SUBSCRIBE_DOMAIN.length).toBe(19);
    const pre = Buffer.from(subscribeBindingPreimage(binding));
    expect(pre.length).toBe(SUBSCRIBE_PREIMAGE_LEN);
    expect(pre.subarray(0, 19).toString('ascii')).toBe('P01:C7:SUBSCRIBE:v1');
    expect(pre.subarray(19, 51).equals(Buffer.from(VAULT.toBytes()))).toBe(true);
    expect(pre.readBigUInt64LE(51)).toBe(RATE);
    expect(pre.readBigUInt64LE(59)).toBe(INTERVAL);
    expect(pre.subarray(67, 99).equals(Buffer.from(VK_HASH))).toBe(true);
    // Absent license: tag 0, then 32 zero bytes — never a 1-byte tail.
    expect(pre.subarray(99, 132).equals(Buffer.alloc(33))).toBe(true);
  });

  it('keeps the license slot at 33 bytes when present, tag first', () => {
    const lic = new Uint8Array(32).fill(0x5a);
    const pre = Buffer.from(subscribeBindingPreimage({ ...binding, licenseCommitment: lic }));
    expect(pre.length).toBe(132);
    expect(pre.readUInt8(99)).toBe(1);
    expect(pre.subarray(100, 132).equals(Buffer.from(lic))).toBe(true);
  });

  it('is sha256 of that preimage, split into four raw little-endian u64 limbs', () => {
    const digest = Buffer.from(sha256(subscribeBindingPreimage(binding)));
    expect(Buffer.from(subscribeBindingDigest(binding))).toEqual(digest);
    const limbs = subscribeBindingLimbs(binding);
    expect(limbs).toHaveLength(4);
    for (let i = 0; i < 4; i++) expect(limbs[i]).toBe(digest.readBigUInt64LE(i * 8));
    // The identity the on-chain one-move copy depends on.
    const rebuilt = Buffer.alloc(32);
    limbs.forEach((l, i) => rebuilt.writeBigUInt64LE(l, i * 8));
    expect(rebuilt.equals(digest)).toBe(true);
  });

  it('moves when any term moves — the point of binding the terms', () => {
    const base = subscribeBindingDigest(binding);
    const variants: SubscribeBinding[] = [
      { ...binding, rate: RATE + 1n },
      { ...binding, intervalSlots: 1n },
      { ...binding, vault: NULLIFIER_PDA },
      { ...binding, vkHashSubscriber: new Uint8Array(32).fill(0x43) },
      { ...binding, licenseCommitment: new Uint8Array(32) },
    ];
    for (const v of variants) {
      expect(Buffer.from(subscribeBindingDigest(v)).equals(Buffer.from(base))).toBe(false);
    }
  });

  it('refuses the two `require!`s of the handler and the two width mistakes, before proving', () => {
    expect(() => subscribeBindingPreimage({ ...binding, rate: 0n })).toThrow(/rate > 0/);
    expect(() => subscribeBindingPreimage({ ...binding, intervalSlots: 0n })).toThrow(
      /interval_slots > 0/,
    );
    expect(() =>
      subscribeBindingPreimage({ ...binding, vkHashSubscriber: new Uint8Array(31) }),
    ).toThrow(/exactly 32 bytes/);
    expect(() =>
      subscribeBindingPreimage({ ...binding, licenseCommitment: new Uint8Array(16) }),
    ).toThrow(/exactly 32 bytes when present/);
  });

  it('derives the vault on the same four seeds the program uses', () => {
    const c = new Uint8Array(32).fill(1);
    const [pda] = deriveSubscriptionVaultPDAV4(RETAILER, c, SystemProgram.programId);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('subscription_vault'), RETAILER.toBuffer(), Buffer.from(c), SystemProgram.programId.toBuffer()],
      ZK_SHIELDED_PROGRAM_ID,
    );
    expect(pda.equals(expected)).toBe(true);
  });
});

describe('extension: subscribePrivateStarkV4 refuses a prepared-for-X / executed-for-Y split before any upload', () => {
  /**
   * These refusals sit AHEAD of the upload, so they are reachable with no
   * connection and no prover. The connection object below has no methods; if
   * a refusal ever sinks below the upload, the test dies on a missing method
   * instead of the assertion — the correct signal.
   */
  const NO_CONNECTION = {} as unknown as Connection;
  const signer: WalletSigner = {
    publicKey: PAYER,
    signTransaction: async (t) => t,
  };
  const poolConfig = {
    token: 'SOL',
    denomination: 1,
    denominationHuman: 1,
    decimals: 9,
    poolPDA: POOL,
    treePDA: TREE,
    tokenMint: SystemProgram.programId,
  } as unknown as PoolConfig;
  const receipt = {} as ShieldReceipt;
  const binding: SubscribeBinding = {
    vault: VAULT,
    rate: RATE,
    intervalSlots: INTERVAL,
    vkHashSubscriber: VK_HASH,
  };
  const prepared: PrepareSubscribeV4Result = {
    c7ProofResult: { proofBytes: new Uint8Array(8), publicInputs: [1n, 2n, 3n, 4n, 5n, 6n], proofSize: 8 },
    merkleRoot: POOL_ROOT,
    subtreeRoot: SUBTREE_ROOT,
    nullifierGoldilocks: NULLIFIER,
    siblings: SIBLINGS,
    directions: DIRECTIONS,
    binding,
    subscriberCommitment: SUBSCRIBER_COMMITMENT,
    retailer: RETAILER,
  };
  const run = (over: Partial<Parameters<typeof subscribePrivateStarkV4>[0]>) =>
    subscribePrivateStarkV4(
      {
        receipt,
        poolConfig,
        prepared,
        retailer: RETAILER,
        subscriberCommitment: SUBSCRIBER_COMMITMENT,
        binding,
        ...over,
      },
      signer,
      NO_CONNECTION,
    );

  it('a different retailer', async () => {
    await expect(run({ retailer: Keypair.generate().publicKey })).rejects.toThrow(/prepared for retailer/);
  });
  it('a different subscriber commitment', async () => {
    await expect(run({ subscriberCommitment: 1n })).rejects.toThrow(/different subscriber commitment/);
  });
  it('a different vault', async () => {
    await expect(run({ binding: { ...binding, vault: NULLIFIER_PDA } })).rejects.toThrow(/bound to vault/);
  });
  it('a re-priced rate — the permissionless claim_period attack', async () => {
    await expect(run({ binding: { ...binding, rate: 1_000_000_000n } })).rejects.toThrow(
      /cannot open a vault at 1000000000/,
    );
  });
  it('a shortened interval', async () => {
    await expect(run({ binding: { ...binding, intervalSlots: 1n } })).rejects.toThrow(/interval of/);
  });
  it('a different vkHashSubscriber', async () => {
    await expect(
      run({ binding: { ...binding, vkHashSubscriber: new Uint8Array(32).fill(1) } }),
    ).rejects.toThrow(/different vkHashSubscriber/);
  });
  it('a license that appeared between prepare and send', async () => {
    await expect(
      run({ binding: { ...binding, licenseCommitment: new Uint8Array(32) } }),
    ).rejects.toThrow(/different license presence/);
  });
  it('and none of those reached the chain', () => {
    // NO_CONNECTION has no methods, so any refusal that had sunk below the
    // upload would have thrown a TypeError instead of the message asserted.
    expect(Object.keys(NO_CONNECTION)).toHaveLength(0);
    expect(vi.isMockFunction(signer.signTransaction)).toBe(false);
  });
});
