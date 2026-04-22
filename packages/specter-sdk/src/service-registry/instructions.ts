import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { REGISTRY_PROGRAM_ID } from '../constants';
import { getServicePDA } from './pda';

/**
 * Protocol 01 authority able to flip the `verified` flag on a service.
 * Hardcoded in `programs/p01_registry/src/state/service_registry.rs`.
 */
export const PROTOCOL_VERIFIED_AUTHORITY = new PublicKey(
  '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU',
);

/** Anchor ix discriminators (`sha256("global:<fn>")[..8]`). */
export const SERVICE_IX_DISCRIMINATORS = {
  registerService: Buffer.from([11, 133, 158, 232, 193, 19, 229, 73]),
  updateService: Buffer.from([46, 169, 26, 33, 191, 78, 40, 221]),
  attestService: Buffer.from([161, 34, 104, 197, 226, 142, 169, 113]),
  bumpSubscriberCount: Buffer.from([163, 54, 47, 190, 138, 183, 35, 223]),
  deregisterService: Buffer.from([27, 239, 41, 242, 247, 40, 85, 63]),
} as const;

// ---------------------------------------------------------------------------
// Borsh encoding helpers (kept local — we only need a thin slice of Borsh)
// ---------------------------------------------------------------------------

function encodeString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf-8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([prefix, bytes]);
}

function encodeU64(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

function encodeBool(b: boolean): Buffer {
  return Buffer.from([b ? 1 : 0]);
}

function encodeOption<T>(
  value: T | null | undefined,
  encode: (v: T) => Buffer,
): Buffer {
  if (value === null || value === undefined) {
    return Buffer.from([0]);
  }
  return Buffer.concat([Buffer.from([1]), encode(value)]);
}

// ---------------------------------------------------------------------------
// register_service
// ---------------------------------------------------------------------------

export interface RegisterServiceArgs {
  /** Per-owner unique identifier (max 32 bytes). Used as PDA seed. */
  slug: string;
  /** Display name shown to subscribers. */
  name: string;
  /** Icon identifier ("netflix", "spotify", etc.). */
  iconKey: string;
  /** Category slug ("streaming", "music", ...). */
  category: string;
  /** Off-chain metadata URI (IPFS, HTTPS). Pass `''` if none. */
  metadataUri: string;
  /** Pubkey that will receive payments. */
  retailer: PublicKey;
  /** Token mint (`SystemProgram.programId` for native SOL). */
  tokenMint: PublicKey;
  /** Price per billing period in the smallest unit of `tokenMint`. */
  priceAtomic: bigint;
  /** Billing period in Solana slots (~0.4s each). */
  intervalSlots: bigint;
  /** Accept one-shot unshield payments. */
  supportsOneshot: boolean;
  /** Accept recurring subscription vaults. */
  supportsVault: boolean;
}

/**
 * Build a `register_service` instruction.
 *
 * The `owner` signer becomes the service's controller (can update/deregister).
 * The resulting PDA is `[b"service", owner.key(), slug.as_bytes()]`.
 */
export function buildRegisterServiceIx(
  owner: PublicKey,
  args: RegisterServiceArgs,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): TransactionInstruction {
  const [servicePda] = getServicePDA(owner, args.slug, programId);

  const data = Buffer.concat([
    SERVICE_IX_DISCRIMINATORS.registerService,
    encodeString(args.slug),
    encodeString(args.name),
    encodeString(args.iconKey),
    encodeString(args.category),
    encodeString(args.metadataUri),
    args.retailer.toBuffer(),
    args.tokenMint.toBuffer(),
    encodeU64(args.priceAtomic),
    encodeU64(args.intervalSlots),
    encodeBool(args.supportsOneshot),
    encodeBool(args.supportsVault),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: servicePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// update_service
// ---------------------------------------------------------------------------

export interface UpdateServiceArgs {
  slug: string;
  name?: string;
  iconKey?: string;
  category?: string;
  metadataUri?: string;
  priceAtomic?: bigint;
  intervalSlots?: bigint;
  supportsOneshot?: boolean;
  supportsVault?: boolean;
  active?: boolean;
}

/**
 * Build an `update_service` instruction.
 *
 * All fields are optional — pass only what you want to change.
 * `retailer` and `tokenMint` are intentionally immutable post-registration.
 */
export function buildUpdateServiceIx(
  owner: PublicKey,
  args: UpdateServiceArgs,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): TransactionInstruction {
  const [servicePda] = getServicePDA(owner, args.slug, programId);

  const data = Buffer.concat([
    SERVICE_IX_DISCRIMINATORS.updateService,
    encodeOption(args.name, encodeString),
    encodeOption(args.iconKey, encodeString),
    encodeOption(args.category, encodeString),
    encodeOption(args.metadataUri, encodeString),
    encodeOption(args.priceAtomic, encodeU64),
    encodeOption(args.intervalSlots, encodeU64),
    encodeOption(args.supportsOneshot, encodeBool),
    encodeOption(args.supportsVault, encodeBool),
    encodeOption(args.active, encodeBool),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: servicePda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// attest_service
// ---------------------------------------------------------------------------

/**
 * Build an `attest_service` instruction. Only the protocol authority
 * ({@link PROTOCOL_VERIFIED_AUTHORITY}) can sign.
 */
export function buildAttestServiceIx(
  authority: PublicKey,
  servicePda: PublicKey,
  verified: boolean,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): TransactionInstruction {
  const data = Buffer.concat([
    SERVICE_IX_DISCRIMINATORS.attestService,
    encodeBool(verified),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: servicePda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// bump_subscriber_count
// ---------------------------------------------------------------------------

/**
 * Build a `bump_subscriber_count` instruction (owner-only).
 * The counter is informational — the program does not enforce correctness.
 */
export function buildBumpSubscriberCountIx(
  owner: PublicKey,
  slug: string,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): TransactionInstruction {
  const [servicePda] = getServicePDA(owner, slug, programId);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: servicePda, isSigner: false, isWritable: true },
    ],
    data: SERVICE_IX_DISCRIMINATORS.bumpSubscriberCount,
  });
}

// ---------------------------------------------------------------------------
// deregister_service
// ---------------------------------------------------------------------------

/** Build a `deregister_service` instruction — closes the PDA, refunds rent. */
export function buildDeregisterServiceIx(
  owner: PublicKey,
  slug: string,
  programId: PublicKey = REGISTRY_PROGRAM_ID,
): TransactionInstruction {
  const [servicePda] = getServicePDA(owner, slug, programId);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: servicePda, isSigner: false, isWritable: true },
    ],
    data: SERVICE_IX_DISCRIMINATORS.deregisterService,
  });
}
