import { PublicKey } from '@solana/web3.js';

/**
 * Anchor account discriminator for `ServiceRegistry`.
 * `sha256("account:ServiceRegistry")[..8]`.
 */
export const SERVICE_REGISTRY_DISCRIMINATOR = Buffer.from([
  105, 133, 96, 79, 207, 176, 202, 71,
]);

/** Upper bound on a `ServiceRegistry` account size (matches Rust `SIZE`). */
export const SERVICE_REGISTRY_MAX_SIZE = 385;

/** On-chain service registry entry (decoded form). */
export interface ServiceRegistryAccount {
  /** Merchant wallet that registered the service. */
  owner: PublicKey;
  /** Payment recipient (can differ from `owner`). */
  retailer: PublicKey;
  /** Token mint used for pricing (`SystemProgram.programId` = native SOL). */
  tokenMint: PublicKey;
  /** Price per billing period in the smallest unit of `tokenMint`. */
  priceAtomic: bigint;
  /** Billing period in Solana slots. */
  intervalSlots: bigint;
  /** Informational subscriber counter. */
  subscriberCount: bigint;
  /** Accepts one-shot unshield payments. */
  supportsOneshot: boolean;
  /** Accepts recurring subscription vaults. */
  supportsVault: boolean;
  /** Protocol-attested verification badge. */
  verified: boolean;
  /** Merchant has not paused the listing. */
  active: boolean;
  /** PDA bump seed. */
  bump: number;
  /** Unix seconds when the entry was created. */
  createdAt: number;
  /** Unix seconds of last mutation. */
  updatedAt: number;
  /** Per-owner unique identifier (used as PDA seed). */
  slug: string;
  /** Display name ("Netflix Premium"). */
  name: string;
  /** Icon identifier — mapped client-side to an asset. */
  iconKey: string;
  /** Category tag ("streaming", "music", ...). */
  category: string;
  /** Off-chain metadata URI (may be empty). */
  metadataUri: string;
}

class BorshReader {
  constructor(
    private readonly buf: Buffer,
    private offset = 0,
  ) {}

  readU8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readU64(): bigint {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readI64(): bigint {
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readBool(): boolean {
    return this.readU8() === 1;
  }

  readPubkey(): PublicKey {
    const pk = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return pk;
  }

  readString(): string {
    const len = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    const s = this.buf.subarray(this.offset, this.offset + len).toString('utf-8');
    this.offset += len;
    return s;
  }

  get position(): number {
    return this.offset;
  }
}

/**
 * Decode a raw `ServiceRegistry` account data buffer.
 *
 * The discriminator check is strict — pass `skipDiscriminator: true` if the
 * caller has already sliced it off.
 */
export function decodeServiceRegistryAccount(
  data: Buffer | Uint8Array,
  opts: { skipDiscriminator?: boolean } = {},
): ServiceRegistryAccount {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

  let body = buf;
  if (!opts.skipDiscriminator) {
    if (buf.length < 8) {
      throw new Error(`account data too short: ${buf.length} bytes`);
    }
    const disc = buf.subarray(0, 8);
    if (!disc.equals(SERVICE_REGISTRY_DISCRIMINATOR)) {
      throw new Error(
        `discriminator mismatch: expected ${SERVICE_REGISTRY_DISCRIMINATOR.toString('hex')}, ` +
          `got ${disc.toString('hex')}`,
      );
    }
    body = buf.subarray(8);
  }

  const r = new BorshReader(body);
  const owner = r.readPubkey();
  const retailer = r.readPubkey();
  const tokenMint = r.readPubkey();
  const priceAtomic = r.readU64();
  const intervalSlots = r.readU64();
  const subscriberCount = r.readU64();
  const supportsOneshot = r.readBool();
  const supportsVault = r.readBool();
  const verified = r.readBool();
  const active = r.readBool();
  const bump = r.readU8();
  const createdAt = Number(r.readI64());
  const updatedAt = Number(r.readI64());
  const slug = r.readString();
  const name = r.readString();
  const iconKey = r.readString();
  const category = r.readString();
  const metadataUri = r.readString();

  return {
    owner,
    retailer,
    tokenMint,
    priceAtomic,
    intervalSlots,
    subscriberCount,
    supportsOneshot,
    supportsVault,
    verified,
    active,
    bump,
    createdAt,
    updatedAt,
    slug,
    name,
    iconKey,
    category,
    metadataUri,
  };
}
