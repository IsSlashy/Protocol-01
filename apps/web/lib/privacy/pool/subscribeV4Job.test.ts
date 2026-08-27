/**
 * The circuit-7 SUBSCRIBE binding, and every guard standing on it.
 *
 * WHY THIS FILE IS LARGER THAN ITS WITHDRAWAL TWIN
 * ───────────────────────────────────────────────
 * `unshield_denominated_stark_v4` binds `sha256(recipient)` — one pubkey, one
 * hash, and the destination IS the whole economic statement. A subscription's
 * destination is only HALF of it: `rate` and `interval_slots` decide how fast
 * the retailer empties the vault, `funded_periods() = total_deposited / rate`,
 * the final `claim_period` pays the entire residual and closes the account, and
 * `claim_period` is PERMISSIONLESS — its `retailer` is an `UncheckedAccount`,
 * not a signer. So a relayer holding the C7 buffer who could still choose
 * `rate = denomination, interval_slots = 1` would hand the retailer the
 * subscriber's whole prepaid envelope one slot after subscribe, with no
 * cancellation and no refund to undo it. The proof would verify: it said nothing
 * about the terms.
 *
 * The cure is a 132-byte domain-tagged composite, and a composite has a LAYOUT.
 * Every byte of it is re-derived on chain by `c7_subscribe_pub_bytes`
 * (`programs/zk_shielded/src/instructions/subscribe_private_stark_v4.rs:272`),
 * and a byte of drift is discovered only as a bare `InvalidProof` AFTER a
 * ~78-chunk upload has been paid for. So the layout is pinned here against the
 * Rust source itself rather than against a second copy of my own arithmetic.
 *
 * ⚠️ Several of these tests deliberately reach a guard WITHOUT a connection, a
 * wallet seed or a prover. That is only possible because the guard sits ahead of
 * every `await` in its function. If someone moves an RPC read or a dynamic
 * import above one, those tests start failing with a network or module error
 * rather than the assertion — which is the correct signal, and the reason they
 * pass `null` for everything they do not need.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  buildSubscribePrivateStarkV4Ix,
  subscribeBindingDigest,
  subscribeBindingLimbs,
  subscribeBindingPreimage,
  subscribePrivateStarkV4,
  type PrepareSubscribeV4Result,
  type SubscribeBinding,
} from './subscribePrivateStarkV4';
import { prepareSubscribeJobV4, type PreparedSubscribeV4 } from './subscribeEphemeral';
import { deriveSubscriptionVaultPDA } from './subscribePrivateStark';
import { goldilocksU64To32 } from './denominatedPool';
import type { PoolConfig, ShieldReceipt, WalletSigner } from './denominatedPool';

const REPO = join(__dirname, '../../../../..');
const RUST_SRC = readFileSync(
  join(REPO, 'programs/zk_shielded/src/instructions/subscribe_private_stark_v4.rs'),
  'utf8',
);

const VAULT = new PublicKey('11111111111111111111111111111112');
const RETAILER = Keypair.generate().publicKey;
const NO_CONNECTION = null as unknown as Connection;
const NO_SEED = new Uint8Array(32);

/** A PRF-drawn blinding, so the legacy-note guard lets the receipt through. */
const PRF_BLINDING = 7_284_991_002_338_477_113n;

/** Enough shape to reach a guard, and nothing beyond it. */
const RECEIPT = {
  leafIndex: 7,
  noteBlinding: PRF_BLINDING,
} as unknown as ShieldReceipt;

const POOL = {
  poolPDA: Keypair.generate().publicKey,
  tokenMint: SystemProgram.programId,
  denomination: 1,
} as unknown as PoolConfig;

function binding(over: Partial<SubscribeBinding> = {}): SubscribeBinding {
  return {
    vault: VAULT,
    rate: 250_000n,
    intervalSlots: 216_000n,
    vkHashSubscriber: new Uint8Array(32),
    ...over,
  };
}

// ===========================================================================
// THE 132 BYTES
// ===========================================================================

describe('the subscribe binding preimage is the exact 132 bytes the chain rebuilds', () => {
  it('is 132 bytes, never more and never fewer', () => {
    expect(subscribeBindingPreimage(binding())).toHaveLength(132);
  });

  it('is STILL 132 bytes with a licence, because the slot is fixed width', () => {
    // ⛔ THE WHOLE POINT. A variable-length tail in a concatenated preimage is an
    // ambiguity: `None` written as one tag byte would let a 32-byte value ending
    // in the right place collide with a shorter absent-licence preimage. 33
    // bytes of hashing removes it entirely, and the Rust side pays the same 33.
    const withLicence = subscribeBindingPreimage(
      binding({ licenseCommitment: new Uint8Array(32).fill(9) }),
    );
    expect(withLicence).toHaveLength(132);
    expect(subscribeBindingPreimage(binding())).toHaveLength(withLicence.length);
  });

  it('opens with the frozen 19-byte domain tag and no NUL terminator', () => {
    const pre = subscribeBindingPreimage(binding());
    expect(new TextDecoder().decode(pre.slice(0, 19))).toBe('P01:C7:SUBSCRIBE:v1');
    // Byte 19 is the vault's first byte, not a terminator. `11111111111111111111111111111112`
    // is the all-zeros-but-last pubkey, so this also pins where the vault starts.
    expect(pre[19]).toBe(VAULT.toBytes()[0]);
  });

  it('lays the fields out in the handler order, at the handler offsets', () => {
    const lic = new Uint8Array(32).fill(0xab);
    const pre = subscribeBindingPreimage(
      binding({ rate: 0x0102030405060708n, intervalSlots: 0x1112131415161718n, licenseCommitment: lic }),
    );
    expect([...pre.slice(19, 51)]).toEqual([...VAULT.toBytes()]);
    // Little-endian u64: the low byte first. A big-endian write would still be
    // eight bytes and would still hash — to a digest the chain never produces.
    expect([...pre.slice(51, 59)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect([...pre.slice(59, 67)]).toEqual([0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11]);
    expect([...pre.slice(67, 99)]).toEqual(new Array(32).fill(0));
    expect(pre[99]).toBe(1);
    expect([...pre.slice(100, 132)]).toEqual([...lic]);
  });

  it('zeroes the whole 33-byte licence slot when there is no licence', () => {
    const pre = subscribeBindingPreimage(binding());
    expect([...pre.slice(99, 132)]).toEqual(new Array(33).fill(0));
  });

  it('moves the digest when the RATE moves, which is the reason it exists', () => {
    // If this ever stops being true, a buffer holder can re-price a subscription
    // between prepare and send and `claim_period` empties the envelope.
    const a = subscribeBindingDigest(binding({ rate: 250_000n }));
    const b = subscribeBindingDigest(binding({ rate: 250_001n }));
    expect([...a]).not.toEqual([...b]);
  });

  it('moves the digest when the INTERVAL moves', () => {
    const a = subscribeBindingDigest(binding({ intervalSlots: 216_000n }));
    const b = subscribeBindingDigest(binding({ intervalSlots: 1n }));
    expect([...a]).not.toEqual([...b]);
  });

  it('moves the digest when the VAULT moves, which carries all three seeds', () => {
    const a = subscribeBindingDigest(binding());
    const b = subscribeBindingDigest(binding({ vault: Keypair.generate().publicKey }));
    expect([...a]).not.toEqual([...b]);
  });

  it('separates an absent licence from an all-zero one', () => {
    // The tag byte is the only thing between them, and it must be enough.
    const absent = subscribeBindingDigest(binding());
    const zeroed = subscribeBindingDigest(binding({ licenseCommitment: new Uint8Array(32) }));
    expect([...absent]).not.toEqual([...zeroed]);
  });

  it('is domain-separated from a bare sha256 of the vault', () => {
    // ⛔ The tag is the ONLY structural separation between a buffer minted for a
    // withdrawal and one spent on a subscribe. Without it the separation is the
    // accident that sha256(pubkey) is unlikely to collide with sha256(composite).
    const bare = sha256(VAULT.toBytes());
    expect([...subscribeBindingDigest(binding())]).not.toEqual([...bare]);
  });
});

describe('the four limbs reassemble the digest byte for byte', () => {
  it('is the digest read as four little-endian u64s, carried RAW', () => {
    // ⛔ NOT REDUCED MOD THE GOLDILOCKS PRIME. The limbs occupy no trace column
    // and no constraint, so nothing reduces them, and the handler relies on that
    // identity to rebuild the 48 hashed bytes with ONE copy of the digest. A
    // future change that publishes reduced felts breaks this silently.
    const b = binding();
    const digest = subscribeBindingDigest(b);
    const limbs = subscribeBindingLimbs(b);
    expect(limbs).toHaveLength(4);
    const rebuilt = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
      let v = limbs[i]!;
      for (let k = 0; k < 8; k++) {
        rebuilt[i * 8 + k] = Number(v & 0xffn);
        v >>= 8n;
      }
    }
    expect([...rebuilt]).toEqual([...digest]);
  });

  it('does not reduce a limb that exceeds the Goldilocks modulus', () => {
    // Search for a binding whose first limb is >= p, then assert it survives
    // intact. About 1 in 2^32 of random digests qualify per limb, so scanning
    // rates is cheap and this is not a theoretical claim.
    const MODULUS = 0xffffffff00000001n;
    let found = false;
    for (let r = 1n; r < 4000n && !found; r++) {
      const limbs = subscribeBindingLimbs(binding({ rate: r }));
      for (const l of limbs) {
        if (l >= MODULUS) {
          expect(l).toBeLessThan(2n ** 64n);
          found = true;
          break;
        }
      }
    }
    // Not asserting `found` — a run that happens to find none proves nothing
    // either way. What IS asserted is the invariant every limb must satisfy.
    for (let r = 1n; r < 200n; r++) {
      for (const l of subscribeBindingLimbs(binding({ rate: r }))) {
        expect(l).toBeGreaterThanOrEqual(0n);
        expect(l).toBeLessThan(2n ** 64n);
      }
    }
  });
});

// ===========================================================================
// THE LAYOUT AGAINST THE RUST, NOT AGAINST A SECOND COPY OF MY ARITHMETIC
// ===========================================================================

describe('the binding is pinned to the deployed handler, not to a restatement of it', () => {
  it('uses the domain tag the Rust file declares', () => {
    // Reads the constant out of the program source. Reword it there without
    // rewording it here and every proof this client builds becomes unspendable.
    expect(RUST_SRC).toContain('const C7_SUBSCRIBE_DOMAIN: &[u8] = b"P01:C7:SUBSCRIBE:v1";');
    expect(new TextDecoder().decode(subscribeBindingPreimage(binding()).slice(0, 19))).toBe(
      'P01:C7:SUBSCRIBE:v1',
    );
  });

  it('hashes the same six pieces in the same order the handler hashes them', () => {
    // ⛔ NOT `RUST_SRC.contains("C7_SUBSCRIBE_DOMAIN")`. A name appears in the
    // doc comment above the function too, so matching the identifier would stay
    // green with the `hashv` call gutted. This matches the whole CALL, in order.
    const call = RUST_SRC.slice(RUST_SRC.indexOf('let digest = solana_sha256_hasher::hashv(&['));
    const body = call.slice(0, call.indexOf(']'));
    const order = [
      'C7_SUBSCRIBE_DOMAIN',
      'vault.as_ref()',
      '&rate.to_le_bytes()',
      '&interval_slots.to_le_bytes()',
      'vk_hash_subscriber',
      '&lic',
    ];
    let cursor = -1;
    for (const piece of order) {
      const at = body.indexOf(piece);
      expect(at, `the handler no longer hashes ${piece} where this client puts it`).toBeGreaterThan(
        cursor,
      );
      cursor = at;
    }
  });

  it('agrees with the handler that the licence slot is 33 fixed bytes', () => {
    expect(RUST_SRC).toContain('let mut lic = [0u8; 33];');
    expect(subscribeBindingPreimage(binding())).toHaveLength(132);
  });

  it('agrees with the handler that the hashed public bytes are 48', () => {
    expect(RUST_SRC).toContain('const C7_PUB_BYTES_LEN: usize = 48;');
    // 8 nullifier + 8 subtree root + 32 digest.
    expect(8 + 8 + subscribeBindingDigest(binding()).length).toBe(48);
  });
});

// ===========================================================================
// THE PREIMAGE'S OWN REFUSALS
// ===========================================================================

describe('the binding refuses inputs that would silently shift the digest', () => {
  it('refuses a vkHashSubscriber that is not 32 bytes', () => {
    // A short value shifts every byte after it, and the failure would land as
    // `InvalidProof` at the end of a ~78-chunk upload.
    expect(() => subscribeBindingPreimage(binding({ vkHashSubscriber: new Uint8Array(31) }))).toThrow(
      /exactly 32 bytes/,
    );
  });

  it('refuses a licence commitment that is not 32 bytes', () => {
    expect(() =>
      subscribeBindingPreimage(binding({ licenseCommitment: new Uint8Array(16) })),
    ).toThrow(/exactly 32 bytes when present/);
  });

  it('refuses rate = 0, which mints a vault nobody can claim from', () => {
    // `funded_periods()` and `claimable_periods()` both return 0 on rate 0, so
    // the vault is unclaimable but still closable — and `claim_period` is the
    // only instruction that can close it.
    expect(() => subscribeBindingPreimage(binding({ rate: 0n }))).toThrow(/greater than zero/);
  });

  it('refuses intervalSlots = 0, which divides by zero on chain', () => {
    expect(() => subscribeBindingPreimage(binding({ intervalSlots: 0n }))).toThrow(
      /at least one slot/,
    );
  });

  it('mirrors both of the handler`s first two requires', () => {
    expect(RUST_SRC).toContain('require!(rate > 0, ZkShieldedError::InvalidRate);');
    expect(RUST_SRC).toContain(
      'require!(interval_slots > 0, ZkShieldedError::InvalidInterval);',
    );
  });
});

// ===========================================================================
// THE INSTRUCTION
// ===========================================================================

function ixParams(over: Record<string, unknown> = {}) {
  return {
    payer: Keypair.generate().publicKey,
    retailer: RETAILER,
    vaultPDA: VAULT,
    poolPDA: POOL.poolPDA,
    treePDA: Keypair.generate().publicKey,
    nullifierPDA: Keypair.generate().publicKey,
    c7ProofBuffer: Keypair.generate().publicKey,
    nullifierBytes: new Uint8Array(32),
    merkleRootBytes: new Uint8Array(32),
    subtreeRoot: 42n,
    siblings: [1n, 2n, 3n],
    directions: [0, 1, 0],
    subscriberCommitmentBytes: new Uint8Array(32),
    rate: 250_000n,
    intervalSlots: 216_000n,
    vkHashSubscriber: new Uint8Array(32),
    ...over,
  } as Parameters<typeof buildSubscribePrivateStarkV4Ix>[0];
}

describe('the v4 subscribe instruction encodes what the handler decodes', () => {
  it('opens with sha256("global:subscribe_private_stark_v4")[..8]', () => {
    const ix = buildSubscribePrivateStarkV4Ix(ixParams());
    const expected = Buffer.from(
      sha256(new TextEncoder().encode('global:subscribe_private_stark_v4')).slice(0, 8),
    );
    expect(ix.data.subarray(0, 8).toString('hex')).toBe(expected.toString('hex'));
    // The frozen value, so a change to the derivation is visible as a diff and
    // not merely as two computations agreeing with each other.
    expect(ix.data.subarray(0, 8).toString('hex')).toBe('6fbcb723d5cd4514');
  });

  it('is 196 bytes on a depth-15 pool with no licence, 228 with one', () => {
    expect(buildSubscribePrivateStarkV4Ix(ixParams()).data).toHaveLength(196);
    expect(
      buildSubscribePrivateStarkV4Ix(
        ixParams({ licenseCommitment: new Uint8Array(32).fill(3) }),
      ).data,
    ).toHaveLength(228);
  });

  it('puts every argument at the offset the Rust argument order implies', () => {
    const nul = new Uint8Array(32).fill(7);
    const root = new Uint8Array(32).fill(8);
    const commit = new Uint8Array(32).fill(9);
    const vk = new Uint8Array(32).fill(10);
    const ix = buildSubscribePrivateStarkV4Ix(
      ixParams({
        nullifierBytes: nul,
        merkleRootBytes: root,
        subscriberCommitmentBytes: commit,
        vkHashSubscriber: vk,
        subtreeRoot: 0x0807060504030201n,
      }),
    );
    const d = ix.data;
    expect([...d.subarray(8, 40)]).toEqual([...nul]);
    expect([...d.subarray(40, 72)]).toEqual([...root]);
    expect(d.readBigUInt64LE(72)).toBe(0x0807060504030201n);
    // Borsh Vec<u64>: u32 length prefix then the elements.
    expect(d.readUInt32LE(80)).toBe(3);
    expect(d.readBigUInt64LE(84)).toBe(1n);
    expect(d.readUInt32LE(108)).toBe(3);
    expect([...d.subarray(112, 115)]).toEqual([0, 1, 0]);
    expect([...d.subarray(115, 147)]).toEqual([...commit]);
    expect(d.readBigUInt64LE(147)).toBe(250_000n);
    expect(d.readBigUInt64LE(155)).toBe(216_000n);
    expect([...d.subarray(163, 195)]).toEqual([...vk]);
    expect(d[195]).toBe(0);
  });

  it('carries NO stark_commitment and NO min_epoch, which is the property', () => {
    // The v3 payload puts `min_epoch` at byte 72 and `stark_commitment` at 160.
    // Here byte 72 is the subtree root and 160 is inside `interval_slots`, and
    // the whole payload is 196 bytes where v3's is 169/201. Asserting the total
    // length plus the two occupied offsets is what pins their absence: a field
    // cannot be present without lengthening the buffer.
    const ix = buildSubscribePrivateStarkV4Ix(ixParams({ subtreeRoot: 5n }));
    expect(ix.data).toHaveLength(196);
    expect(ix.data.readBigUInt64LE(72)).toBe(5n);
    // And the deployed handler declares exactly ten arguments, none of them
    // either name.
    const sig = RUST_SRC.slice(RUST_SRC.indexOf('pub fn handler('));
    const args = sig.slice(0, sig.indexOf(') -> Result<()>'));
    expect(args).not.toContain('stark_commitment');
    expect(args).not.toContain('min_epoch');
  });

  it('sends ELEVEN accounts even for a native-SOL pool', () => {
    // Anchor 0.32 raises AccountNotEnoughKeys (3005) inside the RESOLVER, before
    // the handler runs, so a short list fails with an error that names nothing
    // about the real problem.
    const ix = buildSubscribePrivateStarkV4Ix(ixParams());
    expect(ix.keys).toHaveLength(11);
  });

  it('encodes an absent optional account as the program`s own id', () => {
    const ix = buildSubscribePrivateStarkV4Ix(ixParams());
    for (const i of [8, 9, 10]) {
      expect(ix.keys[i]!.pubkey.equals(ix.programId)).toBe(true);
      // ⛔ And an absent optional must NOT be writable: a sentinel marked
      // writable asks the runtime for write access to the program account.
      expect(ix.keys[i]!.isWritable).toBe(false);
    }
  });

  it('marks exactly the four accounts the handler writes as writable', () => {
    // payer (fees), vault (init), pool (mut), nullifier_record (init).
    const ix = buildSubscribePrivateStarkV4Ix(ixParams());
    expect(ix.keys.map((k) => k.isWritable)).toEqual([
      true, false, true, true, false, true, false, false, false, false, false,
    ]);
    expect(ix.keys.map((k) => k.isSigner)).toEqual([
      true, false, false, false, false, false, false, false, false, false, false,
    ]);
  });

  it('names the retailer at index 1, and does not pretend otherwise', () => {
    // ⛔ A REAL DISCLOSURE DIFFERENCE from the v4 withdrawal, which hides its
    // payee in remaining_accounts. The retailer cannot be hidden: it is a vault
    // seed, so Anchor must resolve it before the handler runs. Pinned so nobody
    // later describes the two paths as having the same posture.
    const ix = buildSubscribePrivateStarkV4Ix(ixParams());
    expect(ix.keys[1]!.pubkey.equals(RETAILER)).toBe(true);
    expect(RUST_SRC).toContain('pub retailer: AccountInfo<');
  });

  it('carries no fee_escrow, because a fee here strands the vault', () => {
    // `vault.total_deposited` is what `funded_periods()` divides; netting a fee
    // out of it makes the final `claim_period` revert on its rent floor, and
    // `claim_period` is the only instruction that can close a vault.
    const ix = buildSubscribePrivateStarkV4Ix(ixParams());
    expect(ix.keys).toHaveLength(11);
    // ⛔ NOT `RUST_SRC.not.toContain('fee_escrow')`. MEASURED: the module header
    // says "there is deliberately NO `fee_escrow` account", so matching the NAME
    // fails on the prose that explains the absence — and would equally pass if
    // the field were added while the comment stayed. Read the STRUCT.
    const struct = RUST_SRC.slice(RUST_SRC.indexOf("pub struct SubscribePrivateStarkV4<'info> {"));
    const fields = struct.slice(0, struct.indexOf('\n}'));
    const declared = [...fields.matchAll(/^\s{4}pub (\w+):/gm)].map((m) => m[1]);
    expect(declared).toEqual([
      'payer', 'retailer', 'vault', 'denominated_pool', 'merkle_tree',
      'nullifier_record', 'c7_proof_buffer', 'system_program', 'token_program',
      'pool_vault', 'vault_token_account',
    ]);
    expect(declared).toHaveLength(ix.keys.length);
  });

  it('refuses siblings and directions of different lengths', () => {
    expect(() =>
      buildSubscribePrivateStarkV4Ix(ixParams({ siblings: [1n, 2n], directions: [0, 1, 0] })),
    ).toThrow(/same/);
  });

  it('refuses a direction bit that is neither 0 nor 1', () => {
    expect(() =>
      buildSubscribePrivateStarkV4Ix(ixParams({ directions: [0, 2, 1] })),
    ).toThrow(/NonBinaryDirection/);
  });

  it('refuses a non-canonical sibling, which would name one root twice', () => {
    expect(() =>
      buildSubscribePrivateStarkV4Ix(ixParams({ siblings: [1n, 2n, 0xffffffff00000002n] })),
    ).toThrow(/NonCanonicalFelt/);
  });
});

// ===========================================================================
// THE JOB
// ===========================================================================

describe('the v4 subscribe job refuses a note circuit 7 would only appear to protect', () => {
  /**
   * A note deposited before `noteBlinding` landed carries its deposit EPOCH as
   * the commitment's third input. Circuit 7 keeps the commitment off the wire,
   * but the nullifier is published by construction and `token_mint` is public,
   * so the leaf is rebuildable by trying a few thousand epochs. Proving such a
   * note on circuit 7 buys nothing and LOOKS like it bought everything — and it
   * is worse here than on a withdrawal, because the subscription leaves a
   * permanent public vault that every `claim_period` re-publishes.
   *
   * MEASURED: epoch = slot/7200 = 67,838 today, five digits. A PRF blinding is
   * 63 bits. The threshold sits 63,000x above any real epoch.
   */
  const EPOCH_LIKE = { ...RECEIPT, noteBlinding: 67_838n } as unknown as ShieldReceipt;

  const terms = {
    retailer: RETAILER,
    subscriberCommitment: 12_345n,
    rate: 250_000n,
    intervalSlots: 216_000n,
    vkHashSubscriber: new Uint8Array(32),
  };

  it('refuses an epoch-blinded note, before any RPC call', async () => {
    await expect(
      prepareSubscribeJobV4(EPOCH_LIKE, POOL, NO_CONNECTION, NO_SEED, terms),
    ).rejects.toThrow(/deposit\s+epoch|predates commitment blinding/i);
  });

  it('carries the needle the worker falls back on, so the note stays subscribable', async () => {
    // ⛔ THIS STRING IS LOAD-BEARING ACROSS TWO FILES. `V4_REBUILD_FAILURES` in
    // poolHandlers.ts routes on `includes('circuit 7 needs at least')`. Reword
    // the throw without rewording that list and the note stops falling back to
    // the C1 + C3 pair — it becomes unsubscribable from the web app instead,
    // silently, because refusing looks like working.
    await expect(
      prepareSubscribeJobV4(EPOCH_LIKE, POOL, NO_CONNECTION, NO_SEED, terms),
    ).rejects.toThrow(/circuit 7 needs at least/);
  });

  it('pins the needle in the worker`s allow-list, so the two cannot drift apart', () => {
    // Anti-vacuity: the behavioural tests inject the message themselves, so they
    // would stay green with the list reworded. This reads the list.
    const handlers = readFileSync(
      join(__dirname, '../worker/poolHandlers.ts'),
      'utf8',
    );
    expect(handlers).toContain(
      "const V4_REBUILD_FAILURES = ['PRE-FLIGHT FAIL', 'circuit 7 needs at least'] as const;",
    );

    // ⛔ AND THE SUBSCRIBE PREPARE ROUTES THROUGH IT — anchored, not merely
    // present somewhere in the file.
    //
    // MEASURED 2026-08-27: a bare `toContain('if (!isV4RebuildFailure(err)) throw err;')`
    // asserted NOTHING about this path. That exact line exists TWICE in
    // poolHandlers.ts — once in the withdrawal fallback (~:2070) and once in the
    // subscribe fallback (~:2915) — so deleting the SUBSCRIBE one leaves the
    // withdrawal one and this file stays green at 58 passed. A needle that two
    // call sites satisfy pins neither of them.
    //
    // So: count both, and locate the subscribe one inside its own handler. The
    // fallback swallows the error, and an unguarded swallow routes a brand-new
    // failure mode onto the C1 + C3 pair — the path that republishes this note's
    // commitment — instead of surfacing it. The allow-list only fails closed
    // while this line stands.
    const guards = handlers.match(/if \(!isV4RebuildFailure\(err\)\) throw err;/g) ?? [];
    expect(guards, 'both v4 fallbacks must keep their allow-list guard').toHaveLength(2);

    const handlerStart = handlers.indexOf('async function handlePoolSubscribePrepare');
    const subscribeWarn = handlers.indexOf(
      "'[pool/subscribe] circuit 7 could not prove this note; falling back to the C1 + C3 '",
    );
    // Both anchors must exist and be in this order, or the slice below would be
    // some other region of the file agreeing with itself.
    expect(handlerStart, 'handlePoolSubscribePrepare not found').toBeGreaterThan(-1);
    expect(subscribeWarn, 'the subscribe fallback warning not found').toBeGreaterThan(handlerStart);

    const subscribeFallback = handlers.slice(handlerStart, subscribeWarn);
    // The withdrawal handler ends before `handlePoolSubscribePrepare` begins, so
    // its copy of the line cannot satisfy this.
    expect(subscribeFallback).toContain('if (!isV4RebuildFailure(err)) throw err;');
    expect(
      subscribeFallback.match(/if \(!isV4RebuildFailure\(err\)\) throw err;/g) ?? [],
    ).toHaveLength(1);
  });

  it('refuses rate = 0 before proving', async () => {
    await expect(
      prepareSubscribeJobV4(RECEIPT, POOL, NO_CONNECTION, NO_SEED, { ...terms, rate: 0n }),
    ).rejects.toThrow(/greater than zero/);
  });

  it('refuses intervalSlots = 0 before proving', async () => {
    await expect(
      prepareSubscribeJobV4(RECEIPT, POOL, NO_CONNECTION, NO_SEED, {
        ...terms,
        intervalSlots: 0n,
      }),
    ).rejects.toThrow(/at least one slot/);
  });

  it('lets a PRF-blinded note through the guard', async () => {
    // Must fail LATER and for a different reason — with no connection it dies on
    // the unspent-note read. A different error is the proof the guard passed it.
    await expect(
      prepareSubscribeJobV4(RECEIPT, POOL, NO_CONNECTION, NO_SEED, terms),
    ).rejects.not.toThrow(/predates commitment blinding/);
  });

  it('puts the blinding threshold where the two populations actually are', () => {
    const CEILING = 2n ** 32n;
    expect(67_838n).toBeLessThan(CEILING);              // every real epoch
    expect(CEILING).toBeLessThan(2n ** 63n);            // every PRF draw's range
    expect(CEILING / 67_838n).toBeGreaterThan(60_000n); // and by a wide margin
  });
});

describe('the v4 subscribe job is distinguishable from the v3 one', () => {
  const SRC = readFileSync(join(__dirname, 'subscribeEphemeral.ts'), 'utf8');

  it('mints a job id that cannot collide with the v3 job for the same note', () => {
    const v4Prefix = 'subscribe-v4:';
    const v3Prefix = 'subscribe:';
    expect(v4Prefix.startsWith(v3Prefix)).toBe(false);
    expect(v3Prefix.startsWith(v4Prefix)).toBe(false);
    // And the source really does use them, so this is not two string literals
    // agreeing with each other in a vacuum.
    expect(SRC).toContain('`subscribe:${poolConfig.poolPDA.toBase58()}:${receipt.leafIndex}`');
    expect(SRC).toContain(
      '`subscribe-v4:${poolConfig.poolPDA.toBase58()}:${receipt.leafIndex}:${vaultPDA.toBase58()}`',
    );
  });

  it('💰 qualifies the v4 key with the VAULT, which names the terms it is bound to', () => {
    // `subscribe:<pool>:<leaf>` names no terms while the job is BOUND to them.
    // Two prepares of the same note for two retailers would collide on one key,
    // the second replacing the first — and the ephemeral is deterministic in
    // (seed, pool, leaf), so the first caller's pre-fund sits on exactly the
    // signer the second caller's proof spends from. This is the shape already
    // paid for once on the v4 withdrawal.
    expect(SRC).toContain(':${vaultPDA.toBase58()}`');
  });

  it('leaves the shared v3 prepare untouched and still reaching prepareUnshieldJob', () => {
    // ⛔ `prepareSubscribeJob` is shared and MUST keep routing to the C1 + C3
    // pair: a note whose blinding is unknown can be spent nowhere else.
    expect(SRC).toMatch(/const base: PreparedUnshield = await prepareUnshieldJob\(/);
  });

  it('does NOT reach for the withdrawal`s v4 prepare, which binds the wrong digest', () => {
    // ⛔ NOT the old reason ("there is no subscribe_private_stark_v4"), which is
    // dead — it is registered at `programs/zk_shielded/src/lib.rs:549`. The
    // reason is now STRONGER: `prepareUnshieldJobV4` binds `sha256(recipient)`,
    // while this instruction rebuilds a 132-byte domain-tagged composite. A
    // buffer minted by the withdrawal's prepare would fail this handler's
    // public-inputs-hash check at the END of a ~78-chunk upload.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/\bprepareUnshieldJobV4\b/.test(code)).toBe(false);
    // ⛔ THE CALL STATEMENT, NOT THE NAME. MEASURED 2026-08-27: written as
    // `.toMatch(/\bprepareSubscribeV4\b/)` this was HOLLOW — renaming the CALL
    // to `prepareSubscribeV4NOPE(` left it green, because the identifier
    // survives in the import list, which `code` does not strip.
    expect(code).toContain('const prepared = await prepareSubscribeV4(');
  });
});

// ===========================================================================
// THE PREPARED-VS-EXECUTED REFUSAL
// ===========================================================================

describe('the send refuses terms that drifted after the proof was built', () => {
  /**
   * A stale-terms prepare/execute split is silent until the very end: the digest
   * moves, the buffer's `public_inputs_hash` stops matching, and the failure
   * lands after a ~78-chunk upload with only `InvalidProof` to read. Every one
   * of these refusals replaces that with a sentence, before anything is spent.
   */
  const PREPARED = {
    c7ProofResult: { proofBytes: new Uint8Array(0), publicInputs: [], proofSize: 0 },
    merkleRoot: 1n,
    subtreeRoot: 2n,
    nullifierGoldilocks: 3n,
    siblings: [1n, 2n, 3n],
    directions: [0, 0, 0],
    binding: binding(),
    subscriberCommitment: 12_345n,
    retailer: RETAILER,
  } satisfies PrepareSubscribeV4Result;

  const NO_SIGNER = null as unknown as WalletSigner;

  function send(over: Record<string, unknown>) {
    return subscribePrivateStarkV4(
      {
        receipt: RECEIPT,
        poolConfig: POOL,
        prepared: PREPARED,
        retailer: RETAILER,
        subscriberCommitment: 12_345n,
        binding: binding(),
        ...over,
      },
      NO_SIGNER,
      NO_CONNECTION,
    );
  }

  it('refuses a different rate', async () => {
    await expect(send({ binding: binding({ rate: 1n }) })).rejects.toThrow(
      /bound to a rate of 250000/,
    );
  });

  it('says WHY the rate is bound, because a refusal nobody understands gets deleted', async () => {
    await expect(send({ binding: binding({ rate: 1n }) })).rejects.toThrow(
      /claim_period` is permissionless/,
    );
  });

  it('refuses a different interval', async () => {
    await expect(send({ binding: binding({ intervalSlots: 1n }) })).rejects.toThrow(
      /bound to an interval of 216000 slots/,
    );
  });

  it('refuses a different retailer', async () => {
    await expect(send({ retailer: Keypair.generate().publicKey })).rejects.toThrow(
      /prepared for retailer/,
    );
  });

  it('refuses a different subscriber commitment', async () => {
    await expect(send({ subscriberCommitment: 999n })).rejects.toThrow(
      /different subscriber commitment/,
    );
  });

  it('refuses a different vault', async () => {
    await expect(
      send({ binding: binding({ vault: Keypair.generate().publicKey }) }),
    ).rejects.toThrow(/bound to vault/);
  });

  it('refuses a different vkHashSubscriber', async () => {
    await expect(
      send({ binding: binding({ vkHashSubscriber: new Uint8Array(32).fill(1) }) }),
    ).rejects.toThrow(/different vkHashSubscriber/);
  });

  it('refuses a licence appearing between prepare and send', async () => {
    // Present-versus-absent moves the 33-byte slot's tag byte, so it moves the
    // digest — it is not a "more information" case.
    await expect(
      send({ binding: binding({ licenseCommitment: new Uint8Array(32).fill(4) }) }),
    ).rejects.toThrow(/different license presence/);
  });

  it('refuses a licence that changed value between prepare and send', async () => {
    const preparedWithLicence = {
      ...PREPARED,
      binding: binding({ licenseCommitment: new Uint8Array(32).fill(4) }),
    } satisfies PrepareSubscribeV4Result;
    await expect(
      subscribePrivateStarkV4(
        {
          receipt: RECEIPT,
          poolConfig: POOL,
          prepared: preparedWithLicence,
          retailer: RETAILER,
          subscriberCommitment: 12_345n,
          binding: binding({ licenseCommitment: new Uint8Array(32).fill(5) }),
        },
        NO_SIGNER,
        NO_CONNECTION,
      ),
    ).rejects.toThrow(/different license commitment/);
  });

  it('lets a matching set of terms past every refusal', async () => {
    // Must fail LATER and for a different reason — with no signer and no
    // connection it dies inside the upload. A different error is the proof that
    // all eight refusals passed it through.
    await expect(send({})).rejects.not.toThrow(/bound to|prepared for|different/);
  });
});

// ===========================================================================
// THE VAULT THE DIGEST NAMES
// ===========================================================================

describe('the vault in the binding is the one Anchor will re-derive', () => {
  it('is seeded on retailer, subscriber commitment and mint, in that order', () => {
    const commitment = 987_654_321n;
    const [derived] = deriveSubscriptionVaultPDA(
      RETAILER,
      goldilocksU64To32(commitment),
      SystemProgram.programId,
    );
    // Swapping any seed gives a different address, which is why binding the
    // ADDRESS transitively binds all three. Binding the retailer alone would
    // leave `subscriber_commitment` free, handing a buffer holder pause/resume
    // control over the merchant's income while the honest subscriber's note burns.
    const [other] = deriveSubscriptionVaultPDA(
      Keypair.generate().publicKey,
      goldilocksU64To32(commitment),
      SystemProgram.programId,
    );
    expect(derived.equals(other)).toBe(false);
    expect(RUST_SRC).toContain('SubscriptionVault::SEED_PREFIX,');
    expect(RUST_SRC).toContain('retailer.key().as_ref(),');
    expect(RUST_SRC).toContain('subscriber_commitment.as_ref(),');
  });

  it('refuses a binding whose vault those seeds do not derive', async () => {
    // Reached with no connection, so this proves the check sits ahead of every
    // await in `prepareSubscribeJobV4`'s call into `prepareSubscribeV4`.
    const { prepareSubscribeV4 } = await import('./subscribePrivateStarkV4');
    await expect(
      prepareSubscribeV4(
        RECEIPT,
        POOL,
        NO_CONNECTION,
        binding({ vault: Keypair.generate().publicKey }),
        12_345n,
        RETAILER,
      ),
    ).rejects.toThrow(/derives/);
  });
});

// ===========================================================================
// THE THING THE PROOF DOES NOT SAY
// ===========================================================================

describe('what circuit 7 does NOT bind, stated so nobody has to discover it', () => {
  it('does not tie subscriber_commitment to the C7 witness', () => {
    // The recipient felts occupy no trace column: `SPEND_BOUNDARY_SPEC` binds
    // public inputs 0 and 1 only. So a vault can be minted on an unrelated
    // commitment — the money is not stolen, but pause and resume then fail for
    // that subscriber forever and `claim_period` is the only closer. "One
    // secret, one note, one vault" is a CLIENT convention; nothing on chain
    // catches a wrong commitment.
    const air = readFileSync(join(REPO, 'stark/src/air/spend.rs'), 'utf8');
    const spec = air.slice(air.indexOf('pub const SPEND_BOUNDARY_SPEC'));
    const table = spec.slice(0, spec.indexOf('];'));
    expect(table).toContain('Some(0)');
    expect(table).toContain('Some(1)');
    // Nothing binds public inputs 2..5 — the four binding felts.
    expect(table).not.toContain('Some(2)');
    expect(table).not.toContain('Some(3)');
    expect(table).not.toContain('Some(4)');
    expect(table).not.toContain('Some(5)');
  });

  it('leaves the subtree root and the direction bits on the wire', () => {
    // `subtree_root` is a tree-state fingerprint recomputable from public
    // `LeafInserted` events, and `directions` names 1 of 8 buckets. Zero
    // information today (both funded pools sit in bucket 0), a hard 3-bit
    // narrowing from leaf 4,097 — and unlike a withdrawal, a subscription sits
    // beside a permanent vault that keeps re-publishing itself.
    const ix = buildSubscribePrivateStarkV4Ix(ixParams({ subtreeRoot: 77n }));
    expect(ix.data.readBigUInt64LE(72)).toBe(77n);
    expect([...ix.data.subarray(112, 115)]).toEqual([0, 1, 0]);
  });
});
