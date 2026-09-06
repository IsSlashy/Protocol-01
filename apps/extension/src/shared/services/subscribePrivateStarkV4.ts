/**
 * subscribe_private_stark_v4 — open a subscription vault on ONE circuit-7 proof.
 *
 * THE EXTENSION'S TWIN OF `apps/web/lib/privacy/pool/subscribePrivateStarkV4.ts`.
 * Same file layout, same refusals, same wire bytes. What differs is the plumbing
 * this package already has: the prover is imported statically (no circular
 * module forces the lazy import web needs), the signer is the user's own wallet
 * via `createWalletSigner()` (there is no ephemeral pre-fund and no sweep), and
 * the send goes through `signSendV3` exactly as `unshieldDenominatedStarkV4`
 * does — relayer when the setting is on, direct submit otherwise.
 *
 * SIBLING OF the v3 path in `subscriptionVault.ts`, NOT ITS REPLACEMENT. The v3
 * path stays reachable indefinitely: a note whose blinding is unknown (a
 * pre-blinding note, or one received through `prepareTransfer`, which still
 * mints a real epoch) can only ever be spent on the C1 + C3 pair, and this path
 * has no stored-Merkle-path shortcut, so a note whose root has aged out of the
 * pool's 100-root ring still needs the v3 rebuild.
 *
 * WHAT v4 REMOVES FROM THE WIRE
 * -----------------------------
 * v3 publishes `stark_commitment` at instruction byte 160 — the note's own
 * commitment, the identical value the deposit emitted in its `LeafInserted`
 * event. One hop reaches the deposit and its payer, so the effective anonymity
 * set of a v3 subscription is ONE. Circuit 7 proves ownership AND membership in
 * one trace and publishes `[nullifier, subtree_root, rh0..rh3]` — no commitment
 * anywhere. `min_epoch` is gone with it.
 *
 * THE BINDING IS A DOMAIN-TAGGED COMPOSITE, NOT `sha256(vault)`
 * ------------------------------------------------------------
 * This is the ONE place this file must not be read as a copy of the v4
 * withdrawal. There, the destination is the whole economic statement, so
 * `sha256(recipient)` binds everything. Here the destination is only HALF:
 * `rate` and `interval_slots` decide how fast the retailer empties the vault.
 * `funded_periods() = total_deposited / rate`, the final `claim_period` pays the
 * entire residual and closes the account, and `claim_period` is PERMISSIONLESS
 * (its `retailer` is an `UncheckedAccount`, not a signer). So a relayer holding
 * the C7 buffer who sets `rate = denomination, interval_slots = 1` hands the
 * retailer the subscriber's whole prepaid envelope one slot after subscribe,
 * with no recovery — cancellation and refunds were deliberately removed. The
 * proof would still verify, because it said nothing about the terms.
 *
 * Hence the 132-byte preimage below, and hence `rate`, `intervalSlots`,
 * `vkHashSubscriber` and the license commitment are inputs to PREPARE rather
 * than to execute: they are inside the transcript, so they must be known before
 * the proof exists. The digest is rebuilt on chain by `c7_subscribe_pub_bytes`
 * (`programs/zk_shielded/src/instructions/subscribe_private_stark_v4.rs:273`);
 * a byte of drift is only discovered as `InvalidProof` AFTER a ~78-chunk upload.
 *
 * DO NOT factor `subscribeBindingDigest` together with `recipientHashLimbs`
 * "for reuse". The domain tag is the only structural separation between the two
 * C7 consumers, and that refactor deletes it while reading as a cleanup. The
 * Rust side carries the same warning over its own copy.
 *
 * WHAT IT STILL DOES NOT HIDE
 * ---------------------------
 * The `retailer` is a NAMED account at index 1 — it is a vault seed, so it
 * cannot be tucked into `remaining_accounts` the way the v4 withdrawal hides its
 * payee. `rate`, `interval_slots`, `vk_hash_subscriber` and the license
 * commitment are cleartext instruction arguments, and the vault is a public
 * account that every later `claim_period` re-publishes. The digest leaks nothing
 * EXTRA only because every one of its inputs is already in the same transaction.
 *
 * 🚨 AND ON THIS SURFACE THE PAYER IS THE USER'S OWN WALLET. Circuit 7 removes
 * the commitment from the wire; it does not remove the depositor's signature
 * from the subscribe, so an observer who saw that wallet deposit into this pool
 * still has it. That is the finding this repository recorded as "v4 seul = FAUX
 * VERT" (2026-08-16), and it is as true of this file as of the v4 withdrawal.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  submitAndConsumeStarkProof,
  getProofBufferPDA,
  CIRCUIT_SPEND,
  type GenericStarkProof,
  type WalletSigner,
} from './stark';
import { starkProver } from './starkProver';
import {
  C7_SUBTREE_DEPTH,
  V4Unprovable,
  ZK_SHIELDED_PROGRAM_ID,
  buildMerkleProofFromLeavesV3,
  bytesEqual,
  deriveNullifierPDA,
  fetchPoolLeavesByIndex,
  goldilocksToLeBytes32,
  goldilocksU64To32,
  hexToBytes,
  parsePoolV3Account,
  signSendV3,
  type PoolConfig,
  type ShieldReceipt,
} from './denominatedPool';

/**
 * `C7_SUBSCRIBE_DOMAIN` — 19 ASCII bytes, NO NUL terminator, frozen forever
 * (`subscribe_private_stark_v4.rs:227`). Changing one byte invalidates every
 * proof this file has ever built.
 */
export const C7_SUBSCRIBE_DOMAIN = new TextEncoder().encode('P01:C7:SUBSCRIBE:v1');

/** 19 + 32 + 8 + 8 + 32 + 33. Constant — the license slot is FIXED width. */
export const SUBSCRIBE_PREIMAGE_LEN = 132;

/**
 * `MODULUS` in `programs/zk_shielded/src/state/poseidon_gl.rs`. 2^64 - 2^32 + 1.
 */
const GOLDILOCKS_MODULUS = 0xffffffff00000001n;

/**
 * `SubscriptionVault::SEED_PREFIX`. The same literal `subscriptionVault.ts`
 * derives with; repeated here rather than imported so this file and that one do
 * not import each other (that file imports this one to route).
 */
const VAULT_SEED_PREFIX = 'subscription_vault';

/**
 * The vault PDA the program will `init`: `[b"subscription_vault", retailer,
 * subscriber_commitment, token_mint]`. Returned as a tuple like the web twin's
 * `deriveSubscriptionVaultPDA`, so the two files read the same.
 */
export function deriveSubscriptionVaultPDAV4(
  retailer: PublicKey,
  subscriberCommitmentBytes: Uint8Array,
  tokenMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_SEED_PREFIX),
      retailer.toBuffer(),
      Buffer.from(subscriberCommitmentBytes),
      tokenMint.toBuffer(),
    ],
    ZK_SHIELDED_PROGRAM_ID,
  );
}

/**
 * The terms the C7 transcript is bound to, beyond the note itself.
 *
 * This type exists because these values are the unit that must be identical at
 * prove time and at send time. Carrying them as one object is what lets
 * `subscribePrivateStarkV4` compare them in one place instead of four.
 */
export interface SubscribeBinding {
  /**
   * The vault PDA, NOT the retailer. Anchor's `init` + `seeds` forces
   * `vault.key() == find_program_address([b"subscription_vault", retailer,
   * subscriber_commitment, token_mint])`, so binding the address transitively
   * binds all three seeds. Binding `retailer` alone would leave
   * `subscriber_commitment` free — that hands a buffer holder pause/resume
   * control over the merchant's income while the honest subscriber's note burns.
   */
  vault: PublicKey;
  rate: bigint;
  intervalSlots: bigint;
  /** Exactly 32 bytes. Inert on-chain metadata, but inside the digest. */
  vkHashSubscriber: Uint8Array;
  /** `blake3(licenseSecret)`, exactly 32 bytes, or absent. */
  licenseCommitment?: Uint8Array;
}

/**
 * The exact 132 bytes the handler hashes, in the handler's order, no separators.
 *
 * The license slot is 33 bytes ALWAYS — tag byte then 32, all zero when absent.
 * A variable-length tail in a concatenated preimage is an ambiguity, and 33
 * bytes of hashing removes it entirely. Never emit a 1-byte tail for `None`.
 */
export function subscribeBindingPreimage(b: SubscribeBinding): Uint8Array {
  // A vkHash of the wrong length would shift every later byte of the preimage
  // and produce a digest discovered wrong only as `InvalidProof`, after the
  // upload has been paid for.
  if (b.vkHashSubscriber.length !== 32) {
    throw new Error(
      `vkHashSubscriber must be exactly 32 bytes, got ${b.vkHashSubscriber.length}. ` +
        'It sits inside the circuit-7 digest, so a short value shifts every byte after it.',
    );
  }
  if (b.licenseCommitment !== undefined && b.licenseCommitment.length !== 32) {
    throw new Error(
      `licenseCommitment must be exactly 32 bytes when present, got ${b.licenseCommitment.length}. ` +
        'Omit it entirely for a subscription with no license.',
    );
  }
  // Both mirror `require!` lines 1 and 2 of the handler. Catching them here
  // saves the ~78 chunk uploads that would be thrown away, and a zero rate is
  // not a small mistake: `funded_periods()` returns 0, so the vault is
  // unclaimable and `claim_period` is the only instruction that can close it.
  if (b.rate <= 0n) {
    throw new Error(
      'The per-period rate must be greater than zero: `require!(rate > 0)` is the first line ' +
        'of the v4 subscribe handler, and a zero rate mints a vault nobody can ever claim from.',
    );
  }
  if (b.intervalSlots <= 0n) {
    throw new Error(
      'The billing interval must be at least one slot: `require!(interval_slots > 0)` is the ' +
        'second line of the v4 subscribe handler, and zero divides by zero in `claimable_periods`.',
    );
  }

  const buf = Buffer.alloc(SUBSCRIBE_PREIMAGE_LEN);
  let o = 0;
  Buffer.from(C7_SUBSCRIBE_DOMAIN).copy(buf, o); o += C7_SUBSCRIBE_DOMAIN.length;
  Buffer.from(b.vault.toBytes()).copy(buf, o); o += 32;
  buf.writeBigUInt64LE(b.rate, o); o += 8;
  buf.writeBigUInt64LE(b.intervalSlots, o); o += 8;
  Buffer.from(b.vkHashSubscriber).copy(buf, o); o += 32;
  // The fixed-width license slot: tag byte, then 32 bytes, zeroed when absent.
  if (b.licenseCommitment) {
    buf.writeUInt8(1, o);
    Buffer.from(b.licenseCommitment).copy(buf, o + 1);
  }
  o += 33;
  if (o !== SUBSCRIBE_PREIMAGE_LEN) {
    throw new Error(
      `The subscribe binding preimage must be ${SUBSCRIBE_PREIMAGE_LEN} bytes, wrote ${o}.`,
    );
  }
  return new Uint8Array(buf);
}

/** `sha256(preimage)` — the 32 bytes that become public inputs 2..5. */
export function subscribeBindingDigest(b: SubscribeBinding): Uint8Array {
  return sha256(subscribeBindingPreimage(b));
}

/**
 * The digest as the four little-endian u64 limbs circuit 7 takes.
 *
 * CARRIED RAW — NOT REDUCED MOD THE GOLDILOCKS PRIME, and a limb may
 * legitimately exceed it. The limbs occupy no trace column and no constraint
 * (`SPEND_BOUNDARY_SPEC` in `stark/src/air/spend.rs` binds only public inputs 0
 * and 1), so nothing reduces them and the concatenation of the four IS the
 * digest byte for byte. The handler relies on that identity to rebuild the 48
 * hashed bytes with a single copy.
 */
export function subscribeBindingLimbs(b: SubscribeBinding): bigint[] {
  const digest = subscribeBindingDigest(b);
  const limbs: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    let v = 0n;
    for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(digest[i * 8 + k]);
    limbs.push(v);
  }
  return limbs;
}

export interface SubscribeV4IxParams {
  payer: PublicKey;
  retailer: PublicKey;
  vaultPDA: PublicKey;
  poolPDA: PublicKey;
  treePDA: PublicKey;
  nullifierPDA: PublicKey;
  c7ProofBuffer: PublicKey;
  nullifierBytes: Uint8Array | number[];
  merkleRootBytes: Uint8Array | number[];
  subtreeRoot: bigint;
  siblings: bigint[];
  directions: number[];
  subscriberCommitmentBytes: Uint8Array;
  rate: bigint;
  intervalSlots: bigint;
  vkHashSubscriber: Uint8Array;
  licenseCommitment?: Uint8Array;
  tokenProgram?: PublicKey;
  poolVault?: PublicKey;
  vaultTokenAccount?: PublicKey;
}

/**
 * Args: nullifier[32] | merkle_root[32] | subtree_root u64 | siblings Vec<u64>
 *       | directions Vec<u8> | subscriber_commitment[32] | rate u64
 *       | interval_slots u64 | vk_hash_subscriber[32] | Option<license[32]>
 *
 * NO `stark_commitment` AND NO `min_epoch`. The first is the linkage circuit 7
 * exists to remove; the second was pinned to 0 on every v3 path once commitments
 * gained a PRF blinding, and v4 deletes the field so it cannot be set wrong.
 * The v3 builder in `subscriptionVault.ts` is a FIXED-offset layout and cannot
 * describe this payload — it carries two Borsh Vecs.
 */
export function buildSubscribePrivateStarkV4Ix(p: SubscribeV4IxParams): TransactionInstruction {
  if (p.siblings.length !== p.directions.length) {
    throw new Error(
      `siblings (${p.siblings.length}) and directions (${p.directions.length}) must be the same ` +
        'length: `resolve_pool_root` rejects any other shape with WrongSiblingCount.',
    );
  }
  for (const d of p.directions) {
    if (d !== 0 && d !== 1) {
      throw new Error(
        `A path direction bit must be 0 or 1, got ${d} (SpendRootError::NonBinaryDirection).`,
      );
    }
  }
  for (const s of p.siblings) {
    if (s >= GOLDILOCKS_MODULUS) {
      throw new Error(
        `Merkle sibling ${s} is not a canonical Goldilocks element. resolve_pool_root refuses ` +
          'it with NonCanonicalFelt, because two byte strings would otherwise name one root.',
      );
    }
  }
  const hasLicense = !!p.licenseCommitment && p.licenseCommitment.length === 32;

  // sha256("global:subscribe_private_stark_v4")[..8], recomputed here rather
  // than hardcoded — target/idl/zk_shielded.json is STALE and carries neither
  // v4 instruction, so nothing IDL-driven can build this.
  const disc = Buffer.from(
    sha256(new TextEncoder().encode('global:subscribe_private_stark_v4')).slice(0, 8),
  );

  const data = Buffer.alloc(
    8 + 32 + 32 + 8 +
      (4 + p.siblings.length * 8) + (4 + p.directions.length) +
      32 + 8 + 8 + 32 + 1 + (hasLicense ? 32 : 0),
  );
  let o = 0;
  disc.copy(data, o); o += 8;
  Buffer.from(p.nullifierBytes).copy(data, o); o += 32;
  Buffer.from(p.merkleRootBytes).copy(data, o); o += 32;
  data.writeBigUInt64LE(p.subtreeRoot, o); o += 8;
  // Borsh Vec<T>: u32 length prefix, then the elements.
  data.writeUInt32LE(p.siblings.length, o); o += 4;
  for (const s of p.siblings) { data.writeBigUInt64LE(s, o); o += 8; }
  data.writeUInt32LE(p.directions.length, o); o += 4;
  for (const d of p.directions) { data.writeUInt8(d, o); o += 1; }
  Buffer.from(p.subscriberCommitmentBytes).copy(data, o); o += 32;
  data.writeBigUInt64LE(p.rate, o); o += 8;
  data.writeBigUInt64LE(p.intervalSlots, o); o += 8;
  Buffer.from(p.vkHashSubscriber).copy(data, o); o += 32;
  data.writeUInt8(hasLicense ? 1 : 0, o); o += 1;
  if (hasLicense) Buffer.from(p.licenseCommitment!).copy(data, o);

  // Account order mirrors `SubscribePrivateStarkV4<'info>`. All ELEVEN keys must
  // be present even for a native-SOL pool: Anchor 0.32 raises
  // AccountNotEnoughKeys (3005) inside the resolver, before the handler runs,
  // and an absent Option is encoded as the program's own id — the same
  // convention `buildSubscribePrivateStarkIx` and
  // `buildUnshieldDenominatedStarkV4Ix` already use.
  //
  // There is NO `fee_escrow` here, unlike the v4 withdrawal, and no protocol
  // fee: netting one out of `vault.total_deposited` makes the final
  // `claim_period` revert on its rent floor, and `claim_period` is the only
  // instruction that can close a vault.
  const sentinel = ZK_SHIELDED_PROGRAM_ID;
  return new TransactionInstruction({
    programId: ZK_SHIELDED_PROGRAM_ID,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      // NAMED, not hidden in remaining_accounts: it is a vault seed, so it has
      // to be resolvable before the handler runs. That is a real disclosure
      // difference from the v4 withdrawal and must not be described away.
      { pubkey: p.retailer, isSigner: false, isWritable: false },
      { pubkey: p.vaultPDA, isSigner: false, isWritable: true },
      { pubkey: p.poolPDA, isSigner: false, isWritable: true },
      { pubkey: p.treePDA, isSigner: false, isWritable: false },
      { pubkey: p.nullifierPDA, isSigner: false, isWritable: true },
      // ONE buffer. v3 named two here.
      { pubkey: p.c7ProofBuffer, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: p.tokenProgram ?? sentinel, isSigner: false, isWritable: false },
      { pubkey: p.poolVault ?? sentinel, isSigner: false, isWritable: !!p.poolVault },
      { pubkey: p.vaultTokenAccount ?? sentinel, isSigner: false, isWritable: !!p.vaultTokenAccount },
    ],
    data,
  });
}

export interface PrepareSubscribeV4Result {
  c7ProofResult: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number };
  /** The pool root the instruction NAMES. */
  merkleRoot: bigint;
  /** The depth-11 root the proof REACHES. The handler walks from here to the above. */
  subtreeRoot: bigint;
  nullifierGoldilocks: bigint;
  /** Levels 11..15 of the path — walked on chain, not in the circuit. */
  siblings: bigint[];
  directions: number[];
  /**
   * The exact terms this proof is bound to, carried so the send can refuse a
   * prepared-for-X / executed-for-Y mismatch BEFORE spending an upload on a
   * proof the chain will reject with a bare `InvalidProof`.
   *
   * There is deliberately NO `starkCommitment` field. Its absence is the
   * property, and leaving it in the type would let a caller keep publishing it.
   */
  binding: SubscribeBinding;
  /** The commitment the vault PDA is seeded on. Carried for the same reason. */
  subscriberCommitment: bigint;
  retailer: PublicKey;
}

/**
 * Fetch leaves, build the Merkle path, pre-flight the root, and generate ONE
 * circuit-7 proof bound to `binding`.
 *
 * The leaf-fetch / root pre-flight / 11-4 split below is a deliberate COPY of
 * `prepareUnshieldV4` rather than a shared helper. Factoring the two together
 * would mean editing the withdrawal path — proven end to end on devnet, spend
 * `22psv1tF...` — in order to ship a subscription that has not been exercised
 * on this surface at all. The duplication is the cheaper risk. The two must
 * stay identical in behaviour, so change them together.
 *
 * ⛔ WHICH FAILURES ARE `V4Unprovable` AND WHICH ARE NOT — the same split as
 * `prepareUnshieldV4`, and it is the whole safety property of the routing in
 * `subscribePrivate`. "This NOTE cannot go through this circuit" (root not in
 * the ring, path too short) is `V4Unprovable` and may fall back to the C1 + C3
 * pair. "The PROVER produced something circuit 7 does not produce" (wrong felt
 * count, a transcript bound to other terms, a non-canonical nullifier) and "the
 * BINDING is wrong" (vault does not derive) are plain `Error` and fail closed:
 * answering those by republishing the commitment on the pair would report a
 * successful subscription and hide the defect.
 */
export async function prepareSubscribeV4(
  receipt: ShieldReceipt,
  poolConfig: PoolConfig,
  connection: Connection,
  binding: SubscribeBinding,
  subscriberCommitment: bigint,
  retailer: PublicKey,
  onProgress?: (step: string) => void,
): Promise<PrepareSubscribeV4Result> {
  // The vault is a digest input AND account index 2, where Anchor re-derives it
  // from its three seeds. A binding built over any other vault produces a proof
  // the handler rebuilds differently — visible only as `InvalidProof`, after the
  // upload. Checked here, before the ~5.5s proof and the ~78 chunks.
  const [expectedVault] = deriveSubscriptionVaultPDAV4(
    retailer,
    goldilocksU64To32(subscriberCommitment),
    poolConfig.tokenMint,
  );
  if (!binding.vault.equals(expectedVault)) {
    throw new Error(
      `The circuit-7 binding names vault ${binding.vault.toBase58()}, but (retailer ` +
        `${retailer.toBase58()}, this subscriber commitment, mint ` +
        `${poolConfig.tokenMint.toBase58()}) derives ${expectedVault.toBase58()}. Anchor ` +
        're-derives the vault from those seeds, so the digest could never match.',
    );
  }

  // Statically imported, like `prepareUnshieldV4` on this surface.
  const prover = starkProver;

  onProgress?.('Fetching pool leaves...');
  const { leavesByIndex, missing } = await fetchPoolLeavesByIndex(
    connection,
    poolConfig.poolPDA,
    {
      maxSignatures: 1000,
      onProgress: (s, t) => onProgress?.(`Scanning events ${s}/${t}...`),
      onStep: onProgress,
      minLeafCount: receipt.leafIndex + 1,
    },
  );
  if (missing.length > 0) {
    console.warn(
      `[Subscribe/ext-v4] prepareSubscribeV4: ${missing.length} missing leaf gap(s): ${missing.slice(0, 5).join(',')}...`,
    );
  }

  onProgress?.('Building Merkle proof from leaf history...');
  let merkleResult = buildMerkleProofFromLeavesV3({
    leavesByIndex,
    targetLeafIndex: receipt.leafIndex,
  });

  // Root pre-flight. A rebuilt root the pool has never published means the proof
  // would be refused at the END of a ~78-chunk upload, so this check is worth
  // its two RPC calls.
  onProgress?.('Pre-flight root verification...');
  const poolAcct = await connection.getAccountInfo(poolConfig.poolPDA, 'confirmed');
  if (poolAcct) {
    const parsed = parsePoolV3Account(new Uint8Array(poolAcct.data));
    if (parsed) {
      const known = (root: bigint): boolean => {
        const b = new Uint8Array(goldilocksToLeBytes32(root));
        return bytesEqual(b, parsed.currentRoot) || parsed.historicalRoots.some((r) => bytesEqual(b, r));
      };
      if (!known(merkleResult.root)) {
        onProgress?.('Root not in ring — retrying event scan with extended limit...');
        const retry = await fetchPoolLeavesByIndex(connection, poolConfig.poolPDA, {
          maxSignatures: 3000,
          fresh: true,
          onStep: onProgress,
          minLeafCount: receipt.leafIndex + 1,
        });
        merkleResult = buildMerkleProofFromLeavesV3({
          leavesByIndex: retry.leavesByIndex,
          targetLeafIndex: receipt.leafIndex,
        });
        if (!known(merkleResult.root)) {
          // V4Unprovable, not Error: the note is fine and the prover is fine —
          // this rebuild could not place the note's root in the pool's ring, and
          // the C1 + C3 prepare pre-flights the root from the other side, so the
          // caller may retry there. Nothing has been spent at this point; the
          // message below says so itself.
          throw new V4Unprovable(
            `PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots ` +
            `(current + ${parsed.historicalRoots.length} historical). Aborting before proof rent is spent. ` +
            `Wait ~10s for the RPC to index recent transactions, then retry.`,
          );
        }
      }
    }
  }

  // 11 / 4 split. `buildMerkleProofFromLeavesV3` returns the full depth-15 path
  // and the two halves go to different verifiers: the first eleven levels are
  // proven in the circuit, the last four are walked on chain by
  // `resolve_pool_root`, whose `directions[i] == 0` means "the running value is
  // the LEFT input at that level" — the same sense the builder pushes (`idx & 1`).
  //
  // Never hardcode the directions: correct today, wrong from leaf 2,049.
  // Never source siblings from `filled_subtrees`: that is the insertion frontier,
  // not an existing leaf's path, and no proof binds it.
  if (merkleResult.pathElements.length < C7_SUBTREE_DEPTH) {
    // V4Unprovable for the same reason as the root pre-flight above: a path this
    // circuit cannot consume is a fact about the note, and the depth-15 pair can
    // still spend it. Unreachable against today's builder (it always returns
    // MERKLE_DEPTH = 15 elements) — defence in depth, as in `prepareUnshieldV4`.
    throw new V4Unprovable(
      `Merkle path is ${merkleResult.pathElements.length} deep; circuit 7 needs at least ${C7_SUBTREE_DEPTH}.`,
    );
  }
  const circuitElements = merkleResult.pathElements.slice(0, C7_SUBTREE_DEPTH);
  const circuitIndices = merkleResult.pathIndices.slice(0, C7_SUBTREE_DEPTH);
  const siblings = merkleResult.pathElements.slice(C7_SUBTREE_DEPTH);
  const directions = merkleResult.pathIndices.slice(C7_SUBTREE_DEPTH);

  // The 132-byte tagged composite, NOT sha256(pubkey). See the file header.
  const rhLimbs = subscribeBindingLimbs(binding);

  const proofStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const seconds = Math.round((Date.now() - proofStartedAt) / 1000);
    onProgress?.(`Proving ownership and membership in one trace (${seconds}s)...`);
  }, 10_000);
  let raw;
  try {
    onProgress?.('Proving ownership and membership in one trace...');
    await prover.start();
    raw = await prover.generateSpendProof(
      receipt.nullifierPreimage.toString(),
      receipt.secret.toString(),
      // Named `depositEpoch` on this surface and `noteBlinding` on the web
      // twin: it is the SAME field — the commitment's third input, which
      // stopped being a real epoch when blinding landed. The value is
      // `deriveNoteBlinding(...)` on both. `whyCircuit7Cannot` has already
      // refused any receipt where it is still a real epoch.
      receipt.depositEpoch.toString(),
      receipt.tokenMint.toString(),
      circuitElements.map((e) => e.toString()),
      circuitIndices,
      rhLimbs.map((l) => l.toString()),
    );
  } finally {
    clearInterval(heartbeat);
  }

  const publicInputs = raw.publicInputs.map((v) => BigInt(v));
  // ⛔ THE THROWS BELOW ARE PLAIN `Error` ON PURPOSE AND MUST STAY THAT WAY.
  // They say "the prover produced something circuit 7 does not produce", and
  // routing that to the C1 + C3 pair would answer a broken prover by
  // republishing the commitment and reporting success. They fail closed.
  if (publicInputs.length !== 6) {
    throw new Error(`Circuit 7 must publish exactly 6 felts, got ${publicInputs.length}.`);
  }
  // Fail here rather than on chain: a transcript bound to different terms is
  // otherwise only discovered by the public-inputs hash, after the upload.
  for (let i = 0; i < 4; i++) {
    if (publicInputs[2 + i] !== rhLimbs[i]) {
      throw new Error(
        `Circuit 7 published a subscribe binding that does not match the requested terms, at limb ${i}.`,
      );
    }
  }

  // The nullifier must be a CANONICAL Goldilocks element, checked on chain with
  // `SpendNonCanonicalFelt`. Since 2^64 - p = 2^32 - 1 exactly, a non-canonical
  // encoding `n + p` names a SECOND NullifierRecord PDA for one field element —
  // a double-spend with no forgery in it. A Poseidon-GL output is reduced by
  // construction, so a deviation here means a hand-built receipt rather than a
  // prover bug; refuse it before the upload instead of reading `InvalidProof`
  // at the end of one.
  if (publicInputs[0] >= GOLDILOCKS_MODULUS) {
    throw new Error(
      `Circuit 7 published a non-canonical nullifier (${publicInputs[0]} is at or above the ` +
        'Goldilocks modulus). The chain refuses it with SpendNonCanonicalFelt, because a second ' +
        'encoding of one field element is a second nullifier PDA for the same note.',
    );
  }

  return {
    c7ProofResult: { proofBytes: hexToBytes(raw.proofHex), publicInputs, proofSize: raw.proofSize },
    merkleRoot: merkleResult.root,
    subtreeRoot: publicInputs[1],
    nullifierGoldilocks: publicInputs[0],
    siblings,
    directions,
    binding,
    subscriberCommitment,
    retailer,
  };
}

export interface SubscribeV4OnChainParams {
  receipt: ShieldReceipt;
  poolConfig: PoolConfig;
  prepared: PrepareSubscribeV4Result;
  retailer: PublicKey;
  subscriberCommitment: bigint;
  binding: SubscribeBinding;
  /**
   * Fires immediately before the subscribe transaction is sent — after the
   * proof buffer is uploaded and verified, before the vault can exist. This is
   * where `subscribePrivate` records the license vault tag (FIX C, part 1):
   * late enough that a proof or upload failure never leaves a tag for a vault
   * that was never created, early enough that a confirmation this device never
   * observes still has the tag on disk.
   */
  onBeforeSend?: () => void;
}

/**
 * Upload the ONE proof, then open the vault.
 *
 * The terms are passed again and CHECKED against the prepared ones, all of them.
 * That is not redundancy: a stale-terms prepare/execute split is silent until
 * the very end. If a different `rate`, `intervalSlots`, `vkHashSubscriber`,
 * license commitment, retailer, subscriber commitment or vault reaches this
 * encoder than reached the prover, the digest moves, the buffer's
 * `public_inputs_hash` no longer matches, and the failure lands AFTER a
 * ~78-chunk upload with only `InvalidProof` to read.
 */
export async function subscribePrivateStarkV4(
  params: SubscribeV4OnChainParams,
  signer: WalletSigner,
  connection: Connection,
  onProgress?: (step: string) => void,
): Promise<{ txSig: string; vaultPDA: PublicKey }> {
  const { prepared, poolConfig } = params;

  // ── The prepared-vs-executed refusal, over EVERY digest input ─────────────
  //
  // Pure comparisons on values already in hand, so refusing here costs nothing
  // and is reachable in a test with no connection and no prover.
  if (!prepared.retailer.equals(params.retailer)) {
    throw new Error(
      `This proof was prepared for retailer ${prepared.retailer.toBase58()} and cannot open a ` +
        `vault for ${params.retailer.toBase58()}: the retailer is a vault seed and the vault is ` +
        'inside the circuit-7 digest. Re-run prepareSubscribeV4 for the new retailer.',
    );
  }
  if (prepared.subscriberCommitment !== params.subscriberCommitment) {
    throw new Error(
      'This proof was prepared for a different subscriber commitment. It is a vault seed and the ' +
        'vault is inside the circuit-7 digest, so the chain would reject this as InvalidProof.',
    );
  }
  if (!prepared.binding.vault.equals(params.binding.vault)) {
    throw new Error(
      `This proof is bound to vault ${prepared.binding.vault.toBase58()}, not ` +
        `${params.binding.vault.toBase58()}; the vault is the first 32 bytes after the domain tag.`,
    );
  }
  if (prepared.binding.rate !== params.binding.rate) {
    throw new Error(
      `This proof is bound to a rate of ${prepared.binding.rate} and cannot open a vault at ` +
        `${params.binding.rate}. The terms are inside the circuit-7 digest precisely so a buffer ` +
        'holder cannot re-price the subscription: `claim_period` is permissionless and the final ' +
        'one pays out the entire residual.',
    );
  }
  if (prepared.binding.intervalSlots !== params.binding.intervalSlots) {
    throw new Error(
      `This proof is bound to an interval of ${prepared.binding.intervalSlots} slots and cannot ` +
        `open a vault at ${params.binding.intervalSlots}. Same reason as the rate: ` +
        '`rate = denomination, interval_slots = 1` empties the envelope one slot after subscribe.',
    );
  }
  if (!bytesEqual(prepared.binding.vkHashSubscriber, params.binding.vkHashSubscriber)) {
    throw new Error(
      'This proof is bound to a different vkHashSubscriber. It is inert on chain but it is ' +
        'inside the digest, so it cannot be changed between prepare and send.',
    );
  }
  const preparedLicense = prepared.binding.licenseCommitment;
  const executeLicense = params.binding.licenseCommitment;
  if ((preparedLicense === undefined) !== (executeLicense === undefined)) {
    throw new Error(
      'This proof was prepared with a different license presence than the one being sent. The ' +
        'license slot is 33 fixed-width bytes of the digest, so present-versus-absent changes it.',
    );
  }
  if (preparedLicense && executeLicense && !bytesEqual(preparedLicense, executeLicense)) {
    throw new Error(
      'This proof is bound to a different license commitment; it is inside the digest.',
    );
  }

  {
    onProgress?.('Submitting the circuit-7 spend proof on-chain...');
    // `submitAndConsumeStarkProof` runs phase 1 AND the DEEP-ALI phase 2 for
    // circuitId <= 7, in the SAME transaction as the subscribe instruction and
    // the buffer close. Phase 2 is NOT optional here: the handler hard-requires
    // the `deep_ali_verified` byte at ProofBuffer offset 82, because without it
    // the buffer records only that the FRI layer checked out, which is not a
    // statement about the trace. The buffer address is a PDA of (signer,
    // circuit), so the instruction can name it before anything is uploaded.
    const proof: GenericStarkProof = {
      proofBytes: prepared.c7ProofResult.proofBytes,
      circuitId: CIRCUIT_SPEND,
      publicInputs: prepared.c7ProofResult.publicInputs,
      proofSize: prepared.c7ProofResult.proofSize,
    };
    const [c7ProofBuffer] = getProofBufferPDA(signer.publicKey, CIRCUIT_SPEND);

    const nullifierBytes = Uint8Array.from(goldilocksToLeBytes32(prepared.nullifierGoldilocks));
    const merkleRootBytes = Uint8Array.from(goldilocksToLeBytes32(prepared.merkleRoot));
    const subscriberCommitmentBytes = goldilocksU64To32(params.subscriberCommitment);
    const [nullifierPDA] = deriveNullifierPDA(poolConfig.poolPDA, Buffer.from(nullifierBytes));
    const vaultPDA = params.binding.vault;

    const isNativeSOL = poolConfig.tokenMint.equals(SystemProgram.programId);
    let tokenProgram: PublicKey | undefined;
    let poolVault: PublicKey | undefined;
    let vaultTokenAccount: PublicKey | undefined;
    if (!isNativeSOL) {
      // UNPROVEN LEG. Both funded pools are native SOL, so the handler's
      // `vault_token.owner == vault.key()` require has never executed on chain.
      // The vault's ATA is derived with allowOwnerOffCurve = true because the
      // vault is a PDA, and it MUST be owned by the vault: `claim_period`
      // constrains the same thing, so a subscribe into a foreign-owned token
      // account mints a vault whose funds can never be claimed and whose rent is
      // stranded permanently.
      const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = await import('@solana/spl-token');
      tokenProgram = TOKEN_PROGRAM_ID;
      poolVault = poolConfig.vaultATA
        ?? await getAssociatedTokenAddress(poolConfig.tokenMint, poolConfig.poolPDA, true);
      vaultTokenAccount = await getAssociatedTokenAddress(poolConfig.tokenMint, vaultPDA, true);
    }

    onProgress?.('Opening the subscription vault...');
    const ix = buildSubscribePrivateStarkV4Ix({
      payer: signer.publicKey,
      retailer: params.retailer,
      vaultPDA,
      poolPDA: poolConfig.poolPDA,
      treePDA: poolConfig.treePDA,
      nullifierPDA,
      c7ProofBuffer,
      nullifierBytes,
      merkleRootBytes,
      subtreeRoot: prepared.subtreeRoot,
      siblings: prepared.siblings,
      directions: prepared.directions,
      subscriberCommitmentBytes,
      rate: params.binding.rate,
      intervalSlots: params.binding.intervalSlots,
      vkHashSubscriber: params.binding.vkHashSubscriber,
      licenseCommitment: params.binding.licenseCommitment,
      tokenProgram,
      poolVault,
      vaultTokenAccount,
    });

    // [ONE-TX 2026-09-06] verify phase 1 + phase 2 + this instruction + close
    // in ONE transaction, the same figure the web twin sends: phase 1 878,756 +
    // phase 2 192,715 + subscribe ~175,000 = ~1,246,000 CU measured 2026-09-02,
    // under the 1,400,000 cap. The 500,000 below is the split-shape budget kept
    // for the automatic fallback: `resolve_pool_root` walks FOUR levels
    // (~137,876 CU at the ~34,469 measured per on-chain `hash2`), plus one
    // sha256 syscall over 132 bytes and two find_program_address searches.
    // ⚠️ Headroom, not an end-to-end measurement on this surface.
    onProgress?.('Sending the V4 subscription...');
    const { txSignature: txSig } = await submitAndConsumeStarkProof(
      proof,
      signer,
      connection,
      {
        instructions: [ix],
        computeUnits: 500_000,
        label: 'opening the subscription',
        // FIX C, part 1 keeps its placement: the instant before the transaction
        // that can create the vault is sent, after the upload.
        beforeSend: params.onBeforeSend,
        send: (tx) => signSendV3(connection, tx, signer, onProgress),
      },
      onProgress,
    );
    // NO EVENT is emitted by this instruction, so there is nothing to read back
    // out of the logs. Recovery is a discriminator-filtered `getProgramAccounts`
    // over vault accounts, which is unchanged: the vault layout keeps all
    // eighteen fields in v3's order.
    //
    // The buffer's rent came back inside that same transaction; on failure the
    // helper closed it before rethrowing, so there is no `finally` here.
    onProgress?.('V4 subscription confirmed!');
    return { txSig, vaultPDA };
  }
}
