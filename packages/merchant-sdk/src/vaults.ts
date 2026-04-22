import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * `zk_shielded` program ID on devnet. Swap for the mainnet ID in production.
 * Matches `Anchor.toml [programs.devnet]` / `localnet` entries that were in
 * sync with the mobile at v0.9.9.
 */
export const ZK_SHIELDED_PROGRAM_ID = new PublicKey(
  'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c',
);

/**
 * Anchor account discriminator for `SubscriptionVault`
 * (`sha256("account:SubscriptionVault")[..8]`).
 */
export const SUBSCRIPTION_VAULT_DISCRIMINATOR = Buffer.from([
  96, 90, 247, 202, 157, 16, 86, 190,
]);

/**
 * Offset where `retailer: Pubkey` starts within the account body.
 * See `programs/zk_shielded/src/state/subscription_vault.rs`:
 *   8 disc + 33 (Option<Pubkey>) + 33 (Option<[u8;32]>) = 74.
 */
export const SUBSCRIPTION_VAULT_RETAILER_OFFSET = 74;

/** Decoded `SubscriptionVault` snapshot. */
export interface SubscriptionVaultAccount {
  pda: PublicKey;
  /** `null` in private mode. */
  subscriberPubkey: PublicKey | null;
  /** `null` in normal mode. */
  subscriberCommitment: Uint8Array | null;
  retailer: PublicKey;
  tokenMint: PublicKey;
  totalDeposited: bigint;
  rate: bigint;
  intervalSlots: bigint;
  startSlot: bigint;
  claimedPeriods: bigint;
  isActive: boolean;
  isPaused: boolean;
  pauseSlot: bigint | null;
  totalPausedSlots: bigint;
  vkHashSubscriber: Uint8Array;
  sourcePool: PublicKey | null;
  bump: number;
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

class VaultReader {
  constructor(
    private readonly buf: Buffer,
    private offset = 0,
  ) {}
  readU8(): number { const v = this.buf.readUInt8(this.offset); this.offset += 1; return v; }
  readU64(): bigint { const v = this.buf.readBigUInt64LE(this.offset); this.offset += 8; return v; }
  readI64(): bigint { const v = this.buf.readBigInt64LE(this.offset); this.offset += 8; return v; }
  readBool(): boolean { return this.readU8() === 1; }
  readPubkey(): PublicKey {
    const pk = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return pk;
  }
  readBytes(n: number): Uint8Array {
    const out = new Uint8Array(this.buf.subarray(this.offset, this.offset + n));
    this.offset += n;
    return out;
  }
  readOptionPubkey(): PublicKey | null {
    const tag = this.readU8();
    if (tag === 0) { this.offset += 32; return null; }
    return this.readPubkey();
  }
  readOption32(): Uint8Array | null {
    const tag = this.readU8();
    if (tag === 0) { this.offset += 32; return null; }
    return this.readBytes(32);
  }
  readOptionI64(): bigint | null {
    const tag = this.readU8();
    if (tag === 0) { this.offset += 8; return null; }
    return this.readI64();
  }
}

export function decodeSubscriptionVault(
  data: Buffer | Uint8Array,
  pda: PublicKey,
): SubscriptionVaultAccount {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 8) throw new Error(`vault account data too short: ${buf.length}`);
  const disc = buf.subarray(0, 8);
  if (!disc.equals(SUBSCRIPTION_VAULT_DISCRIMINATOR)) {
    throw new Error(
      `discriminator mismatch: expected ${SUBSCRIPTION_VAULT_DISCRIMINATOR.toString('hex')}, ` +
        `got ${disc.toString('hex')}`,
    );
  }

  const r = new VaultReader(buf, 8);
  const subscriberPubkey = r.readOptionPubkey();
  const subscriberCommitment = r.readOption32();
  const retailer = r.readPubkey();
  const tokenMint = r.readPubkey();
  const totalDeposited = r.readU64();
  const rate = r.readU64();
  const intervalSlots = r.readU64();
  const startSlot = r.readI64();
  const claimedPeriods = r.readU64();
  const isActive = r.readBool();
  const isPaused = r.readBool();
  const pauseSlot = r.readOptionI64();
  const totalPausedSlots = r.readI64();
  const vkHashSubscriber = r.readBytes(32);
  const sourcePool = r.readOptionPubkey();
  const bump = r.readU8();

  return {
    pda,
    subscriberPubkey,
    subscriberCommitment,
    retailer,
    tokenMint,
    totalDeposited,
    rate,
    intervalSlots,
    startSlot,
    claimedPeriods,
    isActive,
    isPaused,
    pauseSlot,
    totalPausedSlots,
    vkHashSubscriber,
    sourcePool,
    bump,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ListVaultsOptions {
  /** Include vaults whose `is_active` is false. Default: false. */
  includeInactive?: boolean;
  /** Include vaults whose `is_paused` is true. Default: true (they may resume). */
  includePaused?: boolean;
  /** Only return vaults created with the given `token_mint`. */
  tokenMint?: PublicKey;
  /** Commitment. Default `confirmed`. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Override the `zk_shielded` program ID (e.g. mainnet). */
  programId?: PublicKey;
}

/**
 * Fetch every `SubscriptionVault` whose `retailer` field equals the given
 * pubkey. Uses an RPC `memcmp` filter at `offset=74` so each merchant only
 * hydrates their own vaults.
 *
 * ⚠ On busy clusters `getProgramAccounts` is expensive. Merchants should
 * cache and throttle (call every 30–60s in a background worker).
 */
export async function listVaultsForRetailer(
  connection: Connection,
  retailer: PublicKey,
  opts: ListVaultsOptions = {},
): Promise<SubscriptionVaultAccount[]> {
  const programId = opts.programId ?? ZK_SHIELDED_PROGRAM_ID;
  const commitment = opts.commitment ?? 'confirmed';

  const filters = [
    { memcmp: { offset: 0, bytes: bs58.encode(SUBSCRIPTION_VAULT_DISCRIMINATOR) } },
    { memcmp: { offset: SUBSCRIPTION_VAULT_RETAILER_OFFSET, bytes: retailer.toBase58() } },
  ];

  const accounts = await connection.getProgramAccounts(programId, {
    commitment,
    filters,
  });

  const out: SubscriptionVaultAccount[] = [];
  for (const acc of accounts) {
    let decoded: SubscriptionVaultAccount;
    try {
      decoded = decodeSubscriptionVault(acc.account.data, acc.pubkey);
    } catch {
      continue;
    }
    if (!opts.includeInactive && !decoded.isActive) continue;
    if (opts.includePaused === false && decoded.isPaused) continue;
    if (opts.tokenMint && !decoded.tokenMint.equals(opts.tokenMint)) continue;
    out.push(decoded);
  }

  out.sort((a, b) => Number(a.startSlot - b.startSlot));
  return out;
}

/**
 * Compute whether a subscriber has an active, unpaused vault granting them
 * access right now. Callers typically derive the subscriber ID from an
 * out-of-band session token and check here.
 *
 * The function only validates on-chain state; any off-chain mapping between
 * subscriber identities and vault IDs is the merchant's responsibility.
 */
export async function hasActiveVaultAccess(
  connection: Connection,
  retailer: PublicKey,
  subscriberIdBytes: Uint8Array,
  opts: Omit<ListVaultsOptions, 'includeInactive'> = {},
): Promise<SubscriptionVaultAccount | null> {
  if (subscriberIdBytes.length !== 32) {
    throw new Error('subscriberIdBytes must be exactly 32 bytes');
  }
  const vaults = await listVaultsForRetailer(connection, retailer, {
    ...opts,
    includeInactive: false,
  });
  for (const v of vaults) {
    const idBytes = v.subscriberPubkey
      ? v.subscriberPubkey.toBytes()
      : v.subscriberCommitment;
    if (!idBytes) continue;
    if (idBytes.length !== 32) continue;
    let matches = true;
    for (let i = 0; i < 32; i++) {
      if (idBytes[i] !== subscriberIdBytes[i]) { matches = false; break; }
    }
    if (matches) return v;
  }
  return null;
}
