/**
 * ZkSPL Service for Mobile
 *
 * Wraps the @p01/zkspl-sdk client for use in the React Native mobile app.
 * Handles wallet integration, spending key derivation, and state persistence
 * via AsyncStorage.
 */

import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import type { Wallet } from '@coral-xyz/anchor';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getConnection } from '../solana/connection';
import { getKeypair } from '../solana/wallet';

// Import directly from SDK source (monorepo workspace)
import {
  ZkSplClient,
  ZkSplProver,
  LocalStateManager,
  poseidonHash,
  bytesToField,
  type StateStore,
  type ConfidentialAccountData,
  type ZkSplTxResult,
  type FieldElement,
  ZKSPL_PROGRAM_ID,
} from '../../../../packages/zkspl-sdk/src';

// ---------------------------------------------------------------------------
// AsyncStorage-backed StateStore for the SDK's LocalStateManager
// ---------------------------------------------------------------------------

const ZKSPL_STATE_PREFIX = 'zkspl_state:';

class AsyncStorageStateStore implements StateStore {
  async get(key: string): Promise<string | null> {
    return AsyncStorage.getItem(`${ZKSPL_STATE_PREFIX}${key}`);
  }

  async set(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(`${ZKSPL_STATE_PREFIX}${key}`, value);
  }

  async delete(key: string): Promise<void> {
    await AsyncStorage.removeItem(`${ZKSPL_STATE_PREFIX}${key}`);
  }
}

// ---------------------------------------------------------------------------
// Native SOL mint constant
// ---------------------------------------------------------------------------

/** For the MVP, we use native SOL. The token_mint = SystemProgram.programId */
export const NATIVE_SOL_MINT = SystemProgram.programId;
export const NATIVE_SOL_MINT_STR = NATIVE_SOL_MINT.toBase58(); // "11111111111111111111111111111111"

// ---------------------------------------------------------------------------
// Spending key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic spending key from the wallet keypair.
 *
 * Uses Poseidon(secretKeyField) to produce a BN254 field element.
 * The secret key bytes are reduced mod p via bytesToField, then hashed
 * with Poseidon to ensure the result is uniformly distributed in the field.
 *
 * This is deterministic: same keypair always produces the same spending key.
 */
function deriveSpendingKey(secretKey: Uint8Array): FieldElement {
  // Use the first 32 bytes of the secret key (the seed portion)
  const seed = secretKey.slice(0, 32);
  const seedField = bytesToField(seed);
  // Hash it with Poseidon to get a proper field element
  return poseidonHash([seedField]);
}

// ---------------------------------------------------------------------------
// Anchor-compatible wallet adapter for local keypair
// ---------------------------------------------------------------------------

class KeypairWallet implements Wallet {
  constructor(private keypair: import('@solana/web3.js').Keypair) {}

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    tx.sign(this.keypair);
    return tx;
  }

  async signAllTransactions(txs: Transaction[]): Promise<Transaction[]> {
    for (const tx of txs) {
      tx.sign(this.keypair);
    }
    return txs;
  }
}

// ---------------------------------------------------------------------------
// ZkSplService
// ---------------------------------------------------------------------------

export class ZkSplService {
  private client: ZkSplClient;
  private spendingKey: FieldElement;
  private walletPublicKey: PublicKey;

  constructor(
    connection: Connection,
    wallet: Wallet,
    spendingKey: FieldElement,
  ) {
    this.spendingKey = spendingKey;
    this.walletPublicKey = wallet.publicKey;

    // Build prover config - use remote prover from env if available
    const remoteProverUrl = process.env.EXPO_PUBLIC_RELAYER_URL
      ? `${process.env.EXPO_PUBLIC_RELAYER_URL}/prove`
      : '';

    this.client = new ZkSplClient({
      connection,
      wallet,
      programId: new PublicKey(ZKSPL_PROGRAM_ID),
      prover: {
        remoteProverUrl,
        timeout: 120_000,
      },
      stateStore: new AsyncStorageStateStore(),
      spendingKey,
    });
  }

  // -----------------------------------------------------------------------
  // Account setup
  // -----------------------------------------------------------------------

  /**
   * Initialize the mint config on-chain (one-time setup per token).
   * In practice this is done by the program authority, not end users.
   */
  async initializeMint(tokenMint: PublicKey): Promise<string> {
    // For MVP, pass zero hashes -- the on-chain program should already
    // have the mint initialized. This is a fallback.
    const zeroHash = new Uint8Array(32);
    return this.client.initializeMint(tokenMint, zeroHash, zeroHash);
  }

  /**
   * Create a confidential account for the given token mint.
   * Initializes local state with zero balance.
   */
  async createAccount(tokenMint: PublicKey): Promise<string> {
    return this.client.createAccount(tokenMint);
  }

  // -----------------------------------------------------------------------
  // Operations
  // -----------------------------------------------------------------------

  /**
   * Deposit tokens into the confidential account.
   * The deposit amount is public; the resulting balance is hidden.
   *
   * For native SOL, no userTokenAccount/poolVault needed --
   * the program handles lamport transfer via SystemProgram.
   */
  async deposit(
    tokenMint: PublicKey,
    amount: bigint,
  ): Promise<{ signature: string; newBalance: bigint }> {
    const result: ZkSplTxResult = await this.client.deposit(tokenMint, amount);
    return {
      signature: result.signature,
      newBalance: result.newBalance,
    };
  }

  /**
   * Withdraw tokens from the confidential account.
   * The withdrawal amount is public; the remaining balance stays hidden.
   */
  async withdraw(
    tokenMint: PublicKey,
    amount: bigint,
  ): Promise<{ signature: string; newBalance: bigint }> {
    const result: ZkSplTxResult = await this.client.withdraw(tokenMint, amount);
    return {
      signature: result.signature,
      newBalance: result.newBalance,
    };
  }

  /**
   * Send a confidential transfer to another user.
   * Returns the amountHash and amountSalt the recipient needs to apply.
   */
  async transfer(
    tokenMint: PublicKey,
    recipientPubkey: PublicKey,
    amount: bigint,
  ): Promise<{ signature: string; amountHash: bigint; amountSalt: bigint }> {
    const result = await this.client.confidentialTransfer(
      tokenMint,
      recipientPubkey,
      amount,
    );
    return {
      signature: result.signature,
      amountHash: result.amountHash,
      amountSalt: result.amountSaltUsed,
    };
  }

  /**
   * Apply a pending credit (receive side).
   * The recipient must know the plaintext amount and amount_salt
   * (communicated out-of-band by the sender).
   */
  async applyPending(
    tokenMint: PublicKey,
    amount: bigint,
    amountSalt: FieldElement,
  ): Promise<{ signature: string; newBalance: bigint }> {
    const result: ZkSplTxResult = await this.client.applyPending(
      tokenMint,
      amount,
      amountSalt,
    );
    return {
      signature: result.signature,
      newBalance: result.newBalance,
    };
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Fetch the on-chain ConfidentialAccount data.
   * Returns null if the account does not exist.
   */
  async getAccountInfo(
    tokenMint: PublicKey,
  ): Promise<ConfidentialAccountData | null> {
    return this.client.getConfidentialAccount(tokenMint);
  }

  /**
   * Get the locally-known plaintext balance for a token mint.
   * Returns 0 if no local state exists.
   */
  async getLocalBalance(tokenMint: PublicKey): Promise<bigint> {
    const balance = await this.client.getLocalBalance(tokenMint);
    return balance ?? 0n;
  }

  /**
   * Get pending credits count from on-chain.
   */
  async getPendingCreditsCount(tokenMint: PublicKey): Promise<number> {
    const credits = await this.client.getPendingCredits(tokenMint);
    return credits.length;
  }

  /**
   * Get the wallet public key.
   */
  getWalletPublicKey(): PublicKey {
    return this.walletPublicKey;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _service: ZkSplService | null = null;

/**
 * Get or create the ZkSplService singleton.
 * Returns null if wallet is not available.
 */
export async function getZkSplService(): Promise<ZkSplService | null> {
  if (_service) return _service;

  try {
    const keypair = await getKeypair();
    if (!keypair) {
      console.warn('[ZkSPL] No keypair available');
      return null;
    }

    const connection = getConnection();
    const wallet = new KeypairWallet(keypair);
    const spendingKey = deriveSpendingKey(keypair.secretKey);

    _service = new ZkSplService(connection, wallet, spendingKey);
    return _service;
  } catch (error) {
    console.error('[ZkSPL] Failed to create service:', error);
    return null;
  }
}

/**
 * Reset the singleton (e.g., on wallet logout).
 */
export function resetZkSplService(): void {
  _service = null;
}
