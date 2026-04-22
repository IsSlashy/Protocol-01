import { PublicKey } from '@solana/web3.js';

/**
 * Anchor account discriminator for `ServiceRegistry`.
 * `sha256("account:ServiceRegistry")[..8]`.
 */
export const SERVICE_REGISTRY_DISCRIMINATOR = new Uint8Array([
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

// ---------------------------------------------------------------------------
// DataView-based Borsh reader
//
// Using DataView + Uint8Array (standard ES2020) instead of Node's Buffer
// methods (readBigUInt64LE, equals, etc.) — those are absent from the
// React Native / Hermes buffer polyfill and cause silent decode failures.
// ---------------------------------------------------------------------------

class BytesReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset: number;

  constructor(bytes: Uint8Array, startOffset = 0) {
    this.bytes = bytes;
    this.view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    this.offset = startOffset;
  }

  readU8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readU32LE(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readU64LE(): bigint {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readI64LE(): bigint {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readBool(): boolean {
    return this.readU8() === 1;
  }

  readPubkey(): PublicKey {
    const pk = new PublicKey(this.bytes.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return pk;
  }

  readString(): string {
    const len = this.readU32LE();
    const slice = this.bytes.subarray(this.offset, this.offset + len);
    this.offset += len;
    // TextDecoder is available in Hermes (RN >= 0.71) and Node.
    return new TextDecoder('utf-8').decode(slice);
  }
}

function bytesEqual(
  a: Uint8Array | ArrayLike<number>,
  b: Uint8Array | ArrayLike<number>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function toHex(bytes: Uint8Array | ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] as number;
    out += (v < 16 ? '0' : '') + v.toString(16);
  }
  return out;
}

/**
 * Decode a raw `ServiceRegistry` account data buffer.
 *
 * The discriminator check is strict — pass `skipDiscriminator: true` if the
 * caller has already sliced it off.
 *
 * Works on Node, browsers, and React Native (Hermes) — no Buffer-specific
 * methods are used.
 */
export function decodeServiceRegistryAccount(
  data: Uint8Array | ArrayLike<number>,
  opts: { skipDiscriminator?: boolean } = {},
): ServiceRegistryAccount {
  // Normalize input. web3.js may hand us a Buffer (Node), a polyfilled
  // Buffer (RN), or a plain Uint8Array. `ArrayBuffer.isView` catches all
  // TypedArray shapes; anything else is normalized via Uint8Array.from.
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) {
    bytes = data;
  } else if (ArrayBuffer.isView(data as unknown as ArrayBufferView)) {
    const v = data as unknown as ArrayBufferView;
    bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  } else {
    bytes = Uint8Array.from(data as ArrayLike<number>);
  }

  let startOffset = 0;
  if (!opts.skipDiscriminator) {
    if (bytes.length < 8) {
      throw new Error(`account data too short: ${bytes.length} bytes`);
    }
    const disc = bytes.subarray(0, 8);
    if (!bytesEqual(disc, SERVICE_REGISTRY_DISCRIMINATOR)) {
      throw new Error(
        `discriminator mismatch: expected ${toHex(SERVICE_REGISTRY_DISCRIMINATOR)}, got ${toHex(disc)}`,
      );
    }
    startOffset = 8;
  }

  const r = new BytesReader(bytes, startOffset);
  const owner = r.readPubkey();
  const retailer = r.readPubkey();
  const tokenMint = r.readPubkey();
  const priceAtomic = r.readU64LE();
  const intervalSlots = r.readU64LE();
  const subscriberCount = r.readU64LE();
  const supportsOneshot = r.readBool();
  const supportsVault = r.readBool();
  const verified = r.readBool();
  const active = r.readBool();
  const bump = r.readU8();
  const createdAt = Number(r.readI64LE());
  const updatedAt = Number(r.readI64LE());
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
