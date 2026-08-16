/**
 * subscribe plumbing — layout and pricing gates.
 *
 * Run: cd apps/web && pnpm test:pool
 * (`pnpm test` only includes `__tests__/**`; the pool suites run against the
 * REAL @solana/web3.js in a node environment — see vitest.pool.config.mts.)
 *
 * WHAT IS ACTUALLY AT RISK HERE
 * ─────────────────────────────
 * `subscribe_private_stark` takes nine Borsh arguments and the program does not
 * — cannot — tell a shifted encoding from an honest one. `client_stealth_meta:
 * Option<[u8;64]>` used to sit between `stark_commitment` and
 * `license_commitment` and its tag byte was written even when None. The program
 * no longer declares it. Emitting that byte today does not revert: it slides
 * `license_commitment` one byte along, the vault stores a corrupt commitment,
 * the subscriber's key verifies against nothing, and the first symptom is a
 * merchant rejecting a paying customer weeks later.
 *
 * So the offsets below are written as LITERALS, not read out of
 * `SUBSCRIBE_ARG_OFFSETS`. A test that derives its expectations from the table
 * it is guarding agrees with the encoder no matter what either of them says.
 * The table is then asserted against the same literals separately, so a drift in
 * either the table or the encoder fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import {
  SUBSCRIBE_ARG_OFFSETS,
  SUBSCRIBE_MIN_EPOCH,
  buildSubscribePrivateStarkIx,
  deriveSubscriptionVaultPDA,
  goldilocksU64To32,
} from './subscribePrivateStark';

// `prepareSubscribeJob` delegates every expensive step to the proven withdrawal
// preparer. Stubbing it isolates the ONE thing this file adds: the extra rent
// and the re-keyed job id.
vi.mock('./unshieldEphemeral', () => ({
  prepareUnshieldJob: vi.fn(),
}));

import { prepareUnshieldJob } from './unshieldEphemeral';
import { SUBSCRIPTION_VAULT_LEN, prepareSubscribeJob } from './subscribeEphemeral';
import { PREFUND_STEP_LAMPORTS, PREFUND_MAX_EXTRA_STEPS } from './prefundAmount';

// ---------------------------------------------------------------------------
// Fixtures — every field a distinct fill byte, so a shifted write is visible.
// ---------------------------------------------------------------------------

const PAYER = new PublicKey('7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh');
const RETAILER = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');
const POOL = new PublicKey('11111111111111111111111111111112');
const TREE = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const NULLIFIER_PDA = new PublicKey('SysvarRent111111111111111111111111111111111');
const C1_BUF = new PublicKey('SysvarS1otHashes111111111111111111111111111');
const C3_BUF = new PublicKey('SysvarRecentB1ockHashes11111111111111111111');
const MINT = SystemProgram.programId;

const fill = (b: number) => new Uint8Array(32).fill(b);

const NULLIFIER = fill(0xa1);
const MERKLE_ROOT = fill(0xb2);
const SUBSCRIBER_COMMITMENT = fill(0xc3);
const VK_HASH = fill(0xd4);
const LICENSE_COMMITMENT = fill(0xe5);

const RATE = 123_456_789n;
const INTERVAL_SLOTS = 216_000n;
const STARK_COMMITMENT = 1_126_946_528_953_530_644n;

function buildIx(licenseCommitment?: Uint8Array) {
  return buildSubscribePrivateStarkIx({
    payer: PAYER,
    retailer: RETAILER,
    vaultPDA: deriveSubscriptionVaultPDA(RETAILER, SUBSCRIBER_COMMITMENT, MINT)[0],
    poolPDA: POOL,
    treePDA: TREE,
    nullifierPDA: NULLIFIER_PDA,
    c1ProofBuffer: C1_BUF,
    c3ProofBuffer: C3_BUF,
    nullifierBytes: NULLIFIER,
    merkleRootBytes: MERKLE_ROOT,
    subscriberCommitmentBytes: SUBSCRIBER_COMMITMENT,
    rate: RATE,
    intervalSlots: INTERVAL_SLOTS,
    vkHashSubscriber: VK_HASH,
    starkCommitment: STARK_COMMITMENT,
    licenseCommitment,
  });
}

/**
 * Decode the instruction at hard-coded absolute offsets and assert every field.
 * Throws on the first field that does not sit where the deployed program reads
 * it. Used on the honest encoding AND on a deliberately corrupted one below.
 */
function assertSubscribeLayout(data: Buffer, opts: { withLicense: boolean }): void {
  const expectedDisc = Buffer.from(sha256(utf8ToBytes('global:subscribe_private_stark')).slice(0, 8));

  expect(data.subarray(0, 8)).toEqual(expectedDisc);
  expect(data.subarray(8, 40)).toEqual(Buffer.from(NULLIFIER));
  expect(data.subarray(40, 72)).toEqual(Buffer.from(MERKLE_ROOT));
  expect(data.readBigUInt64LE(72)).toBe(0n);
  expect(data.subarray(80, 112)).toEqual(Buffer.from(SUBSCRIBER_COMMITMENT));
  expect(data.readBigUInt64LE(112)).toBe(RATE);
  expect(data.readBigUInt64LE(120)).toBe(INTERVAL_SLOTS);
  expect(data.subarray(128, 160)).toEqual(Buffer.from(VK_HASH));
  expect(data.readBigUInt64LE(160)).toBe(STARK_COMMITMENT);

  if (opts.withLicense) {
    expect(data.readUInt8(168)).toBe(1);
    expect(data.subarray(169, 201)).toEqual(Buffer.from(LICENSE_COMMITMENT));
    expect(data.length).toBe(201);
  } else {
    expect(data.readUInt8(168)).toBe(0);
    expect(data.length).toBe(169);
  }
}

// ---------------------------------------------------------------------------

describe('subscribe_private_stark instruction layout', () => {
  it('pins every argument to its absolute byte offset', async () => {
    const ix = await buildIx(LICENSE_COMMITMENT);
    assertSubscribeLayout(ix.data, { withLicense: true });
  });

  it('keeps SUBSCRIBE_ARG_OFFSETS equal to the offsets asserted above', () => {
    // Written out longhand on purpose: this is the table the rest of the app and
    // any future decoder read, so it must be checked against the same literals
    // the layout assertion uses, not against the encoder.
    expect({ ...SUBSCRIBE_ARG_OFFSETS }).toEqual({
      discriminator: 0,
      nullifier: 8,
      merkleRoot: 40,
      minEpoch: 72,
      subscriberCommitment: 80,
      rate: 112,
      intervalSlots: 120,
      vkHashSubscriber: 128,
      starkCommitment: 160,
      licenseTag: 168,
      licenseValue: 169,
    });
  });

  it('never publishes min_epoch — it is pinned to 0, not the note blinding', async () => {
    // The third commitment input is now a 63-bit secret blinding. Publishing it
    // here would hand an observer the value that makes the commitment
    // recomputable from the nullifier.
    expect(SUBSCRIBE_MIN_EPOCH).toBe(0n);
    const ix = await buildIx(LICENSE_COMMITMENT);
    expect(ix.data.readBigUInt64LE(72)).toBe(0n);
  });

  it('emits a 1-byte None tag and nothing more when there is no license', async () => {
    const ix = await buildIx(undefined);
    assertSubscribeLayout(ix.data, { withLicense: false });
    // "Nothing more" stated as bytes, not as a length: byte 168 is the last one.
    expect(ix.data.length - SUBSCRIBE_ARG_OFFSETS.licenseTag).toBe(1);
  });

  it('treats a wrong-length license commitment as absent rather than encoding it', async () => {
    // The realistic mistake is passing the 16-byte licenseSecret instead of its
    // 32-byte blake3. `buildSubscribePrivateStarkIx` requires length 32, so the
    // vault opens with NO license rather than with a corrupt one — worth pinning,
    // because the two failure modes need very different support answers.
    const ix = await buildIx(new Uint8Array(16).fill(0xe5));
    assertSubscribeLayout(ix.data, { withLicense: false });
  });

  it('fires when one byte is inserted at the license tag (the client_stealth_meta regression)', async () => {
    const honest = (await buildIx(LICENSE_COMMITMENT)).data;
    // Exactly the historical bug: a stray Option tag byte written at 168, sliding
    // license_commitment one byte along. Every argument before it is untouched,
    // which is why this shipped unnoticed.
    const corrupted = Buffer.concat([
      honest.subarray(0, SUBSCRIBE_ARG_OFFSETS.licenseTag),
      Buffer.from([0]),
      honest.subarray(SUBSCRIBE_ARG_OFFSETS.licenseTag),
    ]);
    expect(corrupted.length).toBe(honest.length + 1);
    expect(() => assertSubscribeLayout(corrupted, { withLicense: true })).toThrow();
  });

  it('passes the 12 accounts the Anchor resolver demands, in order', async () => {
    // Anchor 0.32 rejects a short list with AccountNotEnoughKeys (3005) inside
    // the resolver, before the handler runs, so the three trailing Option
    // accounts must be present even for a native-SOL pool.
    const ix = await buildIx(LICENSE_COMMITMENT);
    expect(ix.keys).toHaveLength(12);

    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [true, true],   // payer
      [false, false], // retailer
      [false, true],  // vault (init)
      [false, true],  // denominated_pool
      [false, false], // merkle_tree
      [false, true],  // nullifier_record (init)
      [false, false], // c1_proof_buffer
      [false, false], // c3_proof_buffer
      [false, false], // system_program
      [false, false], // token_program (absent -> program id sentinel)
      [false, false], // pool_vault
      [false, false], // vault_token_account
    ]);
    expect(ix.keys[8]!.pubkey.equals(SystemProgram.programId)).toBe(true);
    for (const i of [9, 10, 11]) {
      expect(ix.keys[i]!.pubkey.equals(ix.programId)).toBe(true);
    }
  });

  it('seeds the vault PDA on the 32-byte commitment with zeroed high bytes', async () => {
    // The program reads commitment[..8] as a u64 and seeds the PDA on all 32
    // bytes, so a non-zero high half derives a vault the program never will.
    const bytes = goldilocksU64To32(STARK_COMMITMENT);
    expect(Array.from(bytes.subarray(8))).toEqual(new Array(24).fill(0));
    const [pda] = deriveSubscriptionVaultPDA(RETAILER, bytes, MINT);
    const [again] = deriveSubscriptionVaultPDA(RETAILER, bytes, MINT);
    expect(pda.toBase58()).toBe(again.toBase58());
  });
});

// ---------------------------------------------------------------------------

describe('prepareSubscribeJob pricing', () => {
  const ephemeral = Keypair.generate();
  const poolConfig = { poolPDA: POOL, denomination: 1 } as never;
  const receipt = { leafIndex: 7 } as never;

  const BASE_LAMPORTS = 1_000_000;
  const VAULT_RENT = 3_381_120;

  let rentFor: number[];
  let conn: Connection;

  beforeEach(() => {
    rentFor = [];
    conn = {
      getMinimumBalanceForRentExemption: async (n: number) => {
        rentFor.push(n);
        return VAULT_RENT;
      },
    } as unknown as Connection;

    vi.mocked(prepareUnshieldJob).mockResolvedValue({
      jobId: `unshield:${POOL.toBase58()}:7`,
      poolConfig,
      receipt,
      ephemeral,
      requiredLamports: BASE_LAMPORTS,
      rawRequiredLamports: BASE_LAMPORTS,
      prepared: {} as never,
    });
  });

  it('matches SubscriptionVault::LEN, summed field by field from the program', () => {
    // subscription_vault.rs:135-153. Recomputed rather than copied so a field
    // added on chain without a client update fails here instead of on devnet
    // with a half-funded ephemeral that has already uploaded ~150 chunks.
    const LEN =
      8 +   // discriminator
      33 +  // subscriber_pubkey: Option<Pubkey>
      33 +  // subscriber_commitment: Option<[u8;32]>
      32 +  // retailer
      32 +  // token_mint
      8 +   // total_deposited
      8 +   // rate
      8 +   // interval_slots
      8 +   // start_slot
      8 +   // claimed_periods
      1 +   // is_active
      1 +   // is_paused
      9 +   // pause_slot: Option<i64>
      8 +   // total_paused_slots
      32 +  // vk_hash_subscriber
      33 +  // source_pool: Option<Pubkey>
      1 +   // bump
      65 +  // client_stealth_meta: Option<[u8;64]>
      33;   // license_commitment: Option<[u8;32]>
    expect(LEN).toBe(361);
    expect(SUBSCRIPTION_VAULT_LEN).toBe(LEN);
  });

  it('adds the vault rent on top of the withdrawal pre-fund', async () => {
    const ctx = await prepareSubscribeJob(receipt, poolConfig, conn, new Uint8Array(32));

    // The vault is `init, payer = payer` and the payer is the ephemeral, so this
    // rent has to be in the ONE transfer the user signs. Dropping it fails the
    // subscribe AFTER both proofs are uploaded.
    expect(rentFor).toEqual([SUBSCRIPTION_VAULT_LEN]);

    // The FLOOR is exact and is what the assertion above is really about. The
    // transferred figure is jittered on purpose (`prefundAmount.ts`), so
    // asserting equality on it would pin the very constant that made one
    // `memcmp` enumerate every subscription — and would fail four times in five.
    expect(ctx.rawRequiredLamports).toBe(BASE_LAMPORTS + VAULT_RENT);
    expect(ctx.requiredLamports).toBeGreaterThanOrEqual(ctx.rawRequiredLamports);
  });

  it('jitters the transferred figure without ever going under the floor', async () => {
    // The failure mode is silent and expensive: an under-funded ephemeral does
    // not fail cheaply, it fails after ~150 chunk uploads with the float
    // stranded. So the floor is checked on every draw, not on one.
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const ctx = await prepareSubscribeJob(receipt, poolConfig, conn, new Uint8Array(32));
      expect(ctx.requiredLamports).toBeGreaterThanOrEqual(BASE_LAMPORTS + VAULT_RENT);
      expect(ctx.requiredLamports % PREFUND_STEP_LAMPORTS).toBe(0);
      expect(ctx.requiredLamports).toBeLessThanOrEqual(
        Math.ceil((BASE_LAMPORTS + VAULT_RENT) / PREFUND_STEP_LAMPORTS) * PREFUND_STEP_LAMPORTS +
          PREFUND_MAX_EXTRA_STEPS * PREFUND_STEP_LAMPORTS,
      );
      seen.add(ctx.requiredLamports);
    }
    // The point of the exercise. If this ever collapses to one value the jitter
    // is dead and the constant is back, whatever the code says it does.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('re-keys the job id so a subscribe can never be run by the withdrawal executor', async () => {
    const ctx = await prepareSubscribeJob(receipt, poolConfig, conn, new Uint8Array(32));
    expect(ctx.jobId).toBe(`subscribe:${POOL.toBase58()}:7`);
    expect(ctx.jobId.startsWith('unshield:')).toBe(false);
  });

  it('reuses the withdrawal ephemeral, which is what recoverStuckFloat sweeps', async () => {
    // recoverFloat.ts:83-87 derives exactly two keys per leaf, 'shield' and
    // 'unshield'. A subscribe-only derivation would put a crashed subscribe's
    // proof-buffer rent outside the only recovery path this app has.
    const ctx = await prepareSubscribeJob(receipt, poolConfig, conn, new Uint8Array(32));
    expect(ctx.ephemeral.publicKey.equals(ephemeral.publicKey)).toBe(true);
  });

  it('passes the stored Merkle path straight through to the withdrawal preparer', async () => {
    const storedPath = { pathElements: ['1'], pathIndices: [0], root: '2' };
    const seed = new Uint8Array(32).fill(9);
    await prepareSubscribeJob(receipt, poolConfig, conn, seed, undefined, storedPath);
    expect(vi.mocked(prepareUnshieldJob)).toHaveBeenCalledWith(
      receipt, poolConfig, conn, seed, undefined, storedPath,
    );
  });
});
