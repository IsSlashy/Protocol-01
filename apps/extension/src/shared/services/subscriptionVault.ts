/**
 * Subscription Vault Service for Chrome Extension
 *
 * Wraps subscription vault operations from the zk_shielded program.
 * Supports both normal (wallet-based) and private (ZK-based) vaults.
 *
 * Normal mode: Subscriber deposits from wallet, authenticates with wallet signature
 * Private mode: Subscriber deposits from denominated pool note, authenticates with ZK proof
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import type { Wallet } from '@coral-xyz/anchor';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { useWalletStore, getPrivySigner } from '../store/wallet';
import { getConnection } from './wallet';
import type { VaultInfo, SubscribeNormalParams, SubscribePrivateParams, ProofData } from './subscriptionVault.types';

// Re-export types
export type { VaultInfo, SubscribeNormalParams, SubscribePrivateParams, ProofData };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** zk_shielded program ID (devnet) */
export const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');

/** Subscription vault PDA seed prefix */
const VAULT_SEED_PREFIX = 'subscription_vault';

/** Subscriber VK data PDA seed prefix */
const SUBSCRIBER_VK_DATA_SEED = 'vk_data_subscriber';

/** Native SOL mint (system program ID) */
const NATIVE_SOL_MINT = SystemProgram.programId;

// ---------------------------------------------------------------------------
// Wallet adapter
// ---------------------------------------------------------------------------

function createWalletAdapter(): { wallet: Wallet; connection: Connection } {
  const walletState = useWalletStore.getState();
  const privySigner = getPrivySigner();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const connection = getConnection(walletState.network);
  const keypair = walletState._keypair;

  const wallet: Wallet = {
    publicKey: walletPublicKey,
    signTransaction: async (tx: Transaction): Promise<Transaction> => {
      if (walletState.isPrivyWallet && privySigner) {
        return await privySigner(tx);
      } else if (keypair) {
        tx.sign(keypair);
        return tx;
      }
      throw new Error('No signing method available');
    },
    signAllTransactions: async (txs: Transaction[]): Promise<Transaction[]> => {
      const signed: Transaction[] = [];
      for (const tx of txs) {
        if (walletState.isPrivyWallet && privySigner) {
          signed.push(await privySigner(tx));
        } else if (keypair) {
          tx.sign(keypair);
          signed.push(tx);
        } else {
          throw new Error('No signing method available');
        }
      }
      return signed;
    },
  };

  return { wallet, connection };
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

/**
 * Derive subscription vault PDA.
 * @param retailer - Retailer pubkey
 * @param subscriberIdBytes - Subscriber ID (pubkey for normal, commitment for private)
 * @param tokenMint - Token mint pubkey
 * @returns Vault PDA
 */
export function deriveVaultPDA(
  retailer: PublicKey,
  subscriberIdBytes: Uint8Array,
  tokenMint: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_SEED_PREFIX),
      retailer.toBuffer(),
      Buffer.from(subscriberIdBytes),
      tokenMint.toBuffer(),
    ],
    ZK_SHIELDED_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive subscriber VK data PDA.
 * @param authority - Authority pubkey
 * @returns VK data PDA
 */
export function deriveSubscriberVkPDA(authority: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SUBSCRIBER_VK_DATA_SEED), authority.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Computation helpers
// ---------------------------------------------------------------------------

/**
 * Compute claimable periods for a vault at current slot.
 * @param vault - Vault info
 * @param currentSlot - Current Solana slot
 * @returns Number of claimable periods
 */
export function computeClaimable(vault: VaultInfo, currentSlot: number): number {
  if (!vault.isActive || vault.isPaused) {
    return 0;
  }

  const effectiveElapsed = currentSlot - vault.startSlot - vault.totalPausedSlots;
  if (effectiveElapsed <= 0) {
    return 0;
  }

  const totalPeriods = Math.floor(effectiveElapsed / vault.intervalSlots);
  return Math.max(0, totalPeriods - vault.claimedPeriods);
}

/**
 * Compute claimable amount in lamports/atomic units.
 */
export function computeClaimableAmount(vault: VaultInfo, currentSlot: number): number {
  const periods = computeClaimable(vault, currentSlot);
  const amount = periods * vault.rate;

  const totalOwed = vault.claimedPeriods * vault.rate;
  const available = vault.totalDeposited - totalOwed;
  return Math.min(amount, available);
}

/**
 * Compute refundable amount if vault were cancelled now.
 */
export function computeRefundable(vault: VaultInfo, currentSlot: number): number {
  const claimable = computeClaimable(vault, currentSlot);
  const totalOwed = (vault.claimedPeriods + claimable) * vault.rate;
  return Math.max(0, vault.totalDeposited - totalOwed);
}

/**
 * Estimate next claimable slot.
 */
export function nextClaimableSlot(vault: VaultInfo): number | null {
  if (!vault.isActive || vault.isPaused) {
    return null;
  }

  const nextPeriod = vault.claimedPeriods + 1;
  const slotsNeeded = nextPeriod * vault.intervalSlots;
  return vault.startSlot + vault.totalPausedSlots + slotsNeeded;
}

// ---------------------------------------------------------------------------
// Vault parsing
// ---------------------------------------------------------------------------

/**
 * Parse vault account data into VaultInfo.
 * @param data - Raw account data buffer
 * @param address - Vault PDA address (base58)
 * @returns Parsed vault info
 */
export function parseVaultAccount(data: Buffer, address: string): VaultInfo {
  let offset = 8; // Skip discriminator

  // Option<Pubkey> subscriber_pubkey
  const hasSubscriberPubkey = data[offset] === 1;
  offset += 1;
  const subscriberPubkey = hasSubscriberPubkey
    ? new PublicKey(data.slice(offset, offset + 32)).toBase58()
    : null;
  offset += 32;

  // Option<[u8;32]> subscriber_commitment
  const hasCommitment = data[offset] === 1;
  offset += 1;
  const subscriberCommitment = hasCommitment
    ? Buffer.from(data.slice(offset, offset + 32)).toString('hex')
    : null;
  offset += 32;

  // Pubkey retailer
  const retailer = new PublicKey(data.slice(offset, offset + 32)).toBase58();
  offset += 32;

  // Pubkey token_mint
  const tokenMint = new PublicKey(data.slice(offset, offset + 32)).toBase58();
  offset += 32;

  // u64 total_deposited
  const totalDeposited = Number(data.readBigUInt64LE(offset));
  offset += 8;

  // u64 rate
  const rate = Number(data.readBigUInt64LE(offset));
  offset += 8;

  // u64 interval_slots
  const intervalSlots = Number(data.readBigUInt64LE(offset));
  offset += 8;

  // i64 start_slot
  const startSlot = Number(data.readBigInt64LE(offset));
  offset += 8;

  // u64 claimed_periods
  const claimedPeriods = Number(data.readBigUInt64LE(offset));
  offset += 8;

  // bool is_active
  const isActive = data[offset] === 1;
  offset += 1;

  // bool is_paused
  const isPaused = data[offset] === 1;
  offset += 1;

  // Option<i64> pause_slot
  const hasPauseSlot = data[offset] === 1;
  offset += 1;
  const pauseSlot = hasPauseSlot ? Number(data.readBigInt64LE(offset)) : null;
  offset += 8;

  // i64 total_paused_slots
  const totalPausedSlots = Number(data.readBigInt64LE(offset));
  offset += 8;

  // [u8;32] vk_hash_subscriber (skip)
  offset += 32;

  // Option<Pubkey> source_pool
  const hasSourcePool = data[offset] === 1;
  offset += 1;
  const sourcePool = hasSourcePool
    ? new PublicKey(data.slice(offset, offset + 32)).toBase58()
    : null;
  offset += 32;

  return {
    address,
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
    sourcePool,
    isNormalMode: hasSubscriberPubkey,
    isPrivateMode: hasCommitment,
  };
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a normal (wallet-based) subscription vault.
 * @param params - Subscription parameters
 * @returns Transaction signature
 */
export async function subscribeNormal(params: {
  retailer: string;
  tokenMint: string;
  amount: number;
  rate: number;
  intervalSlots: number;
  vkHashSubscriber: Uint8Array;
}): Promise<string> {
  const { wallet, connection } = createWalletAdapter();
  const retailerPubkey = new PublicKey(params.retailer);
  const tokenMintPubkey = new PublicKey(params.tokenMint);

  const vaultPDA = deriveVaultPDA(
    retailerPubkey,
    wallet.publicKey.toBytes(),
    tokenMintPubkey
  );

  // Build instruction manually (no IDL for now)
  // In production, use Anchor Program with IDL
  const tx = new Transaction();
  // TODO: Add subscribe_normal instruction
  // This would require the full IDL or manual instruction building

  throw new Error('subscribeNormal: Not yet implemented. Requires Anchor IDL integration.');
}

/**
 * Create a private (ZK-based) subscription vault from a denominated pool note.
 * @param params - Private subscription parameters
 * @returns Transaction signature
 */
export async function subscribePrivate(params: {
  retailer: string;
  poolAddress: string;
  proof: any; // Groth16Proof
  nullifier: string;
  merkleRoot: string;
  minEpoch: number;
  subscriberSecret: string;
  rate: number;
  intervalSlots: number;
  vkHashSubscriber: Uint8Array;
}): Promise<string> {
  throw new Error('subscribePrivate: Not yet implemented. Requires Anchor IDL integration.');
}

/**
 * Claim accrued periods from a vault (retailer only).
 * @param vaultAddress - Vault PDA address (base58)
 * @returns Transaction signature
 */
export async function claimPeriod(vaultAddress: string): Promise<string> {
  throw new Error('claimPeriod: Not yet implemented. Requires Anchor IDL integration.');
}

/**
 * Pause a normal vault (subscriber only).
 * @param vaultAddress - Vault PDA address (base58)
 * @returns Transaction signature
 */
export async function pauseNormal(vaultAddress: string): Promise<string> {
  throw new Error('pauseNormal: Not yet implemented. Requires Anchor IDL integration.');
}

/**
 * Resume a normal vault (subscriber only).
 * @param vaultAddress - Vault PDA address (base58)
 * @returns Transaction signature
 */
export async function resumeNormal(vaultAddress: string): Promise<string> {
  throw new Error('resumeNormal: Not yet implemented. Requires Anchor IDL integration.');
}

/**
 * Pause a private vault (requires ZK proof of subscriber secret).
 * @param vaultAddress - Vault PDA address (base58)
 * @param secret - Subscriber secret (bigint string)
 * @returns Transaction signature
 */
export async function pausePrivate(vaultAddress: string, secret: string): Promise<string> {
  throw new Error('pausePrivate: Not yet implemented. Requires Anchor IDL integration.');
}

/**
 * Resume a private vault (requires ZK proof of subscriber secret).
 * @param vaultAddress - Vault PDA address (base58)
 * @param secret - Subscriber secret (bigint string)
 * @returns Transaction signature
 */
export async function resumePrivate(vaultAddress: string, secret: string): Promise<string> {
  throw new Error('resumePrivate: Not yet implemented. Requires Anchor IDL integration.');
}

/**
 * Cancel a normal vault and refund remaining balance to subscriber.
 * @param vaultAddress - Vault PDA address (base58)
 * @returns Transaction signature
 */
export async function cancelNormal(vaultAddress: string): Promise<string> {
  throw new Error('cancelNormal: Not yet implemented. Requires Anchor IDL integration.');
}

/**
 * Cancel a private vault and re-shield refundable amount to denominated pool.
 * @param vaultAddress - Vault PDA address (base58)
 * @param secret - Subscriber secret (bigint string)
 * @param poolAddress - Denominated pool address (base58)
 * @returns Transaction signature
 */
export async function cancelPrivate(
  vaultAddress: string,
  secret: string,
  poolAddress: string
): Promise<string> {
  throw new Error('cancelPrivate: Not yet implemented. Requires Anchor IDL integration.');
}

/**
 * Fetch a vault by address.
 * @param vaultAddress - Vault PDA address (base58)
 * @returns Vault info or null if not found
 */
export async function fetchVault(vaultAddress: string): Promise<VaultInfo | null> {
  const { connection } = createWalletAdapter();
  const vaultPubkey = new PublicKey(vaultAddress);

  try {
    const accountInfo = await connection.getAccountInfo(vaultPubkey);
    if (!accountInfo || !accountInfo.data) {
      return null;
    }

    return parseVaultAccount(accountInfo.data, vaultAddress);
  } catch (error) {
    console.error('[SubscriptionVault] fetchVault error:', error);
    return null;
  }
}

/**
 * Fetch all vaults for a wallet (as subscriber).
 * Uses getProgramAccounts with memcmp filter.
 * @param walletPubkey - Wallet pubkey (base58)
 * @returns Array of vault info
 */
export async function fetchAllVaults(walletPubkey: string): Promise<VaultInfo[]> {
  const { connection } = createWalletAdapter();
  const pubkey = new PublicKey(walletPubkey);

  try {
    // Filter by subscriber_pubkey (offset 9 = discriminator + Option<Pubkey> tag)
    const accounts = await connection.getProgramAccounts(ZK_SHIELDED_PROGRAM_ID, {
      filters: [
        { dataSize: 297 }, // SubscriptionVault::LEN
        {
          memcmp: {
            offset: 8, // discriminator
            bytes: pubkey.toBase58(),
          },
        },
      ],
    });

    const vaults: VaultInfo[] = [];
    for (const { pubkey: vaultPubkey, account } of accounts) {
      try {
        const vault = parseVaultAccount(account.data, vaultPubkey.toBase58());
        vaults.push(vault);
      } catch (error) {
        console.error('[SubscriptionVault] Failed to parse vault:', vaultPubkey.toBase58(), error);
      }
    }

    return vaults;
  } catch (error) {
    console.error('[SubscriptionVault] fetchAllVaults error:', error);
    return [];
  }
}
