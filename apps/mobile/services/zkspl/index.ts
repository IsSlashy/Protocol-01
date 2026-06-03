/**
 * ZkSPL Service for Mobile
 *
 * Wraps the @protocol-01/zkspl-sdk client for use in the React Native mobile
 * app. STARK-only mode: proofs are generated off-device (via the in-app
 * WASM prover), uploaded to `p01_stark_verifier`, and the verified proof
 * buffer pubkey is passed to every zkSPL instruction. The SDK itself never
 * generates proofs and never sees private witnesses.
 *
 * Handles wallet integration, spending key derivation, and state persistence
 * via AsyncStorage.
 */

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import type { Wallet } from '@coral-xyz/anchor';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { getConnection } from '../solana/connection';
import { getKeypair, deriveKeypairFromMnemonic } from '../solana/wallet';
import { getZkService } from '../zk';
import { vaultEncrypt, vaultDecrypt, isVaultUnlocked } from '../../utils/crypto/noteVault';

// SecureStore keys — must match wallet.ts and shieldedStore.ts
const MNEMONIC_KEY = 'p01_mnemonic';
// NOTE(Privy-removal, R-12): the `p01_zk_seed` random-mnemonic fallback is gone.
// That key is now one of the four accepted orphaned seed classes — see
// services/privacy/privyDataLoss.ts.
const SECURE_OPTIONS = {
  keychainService: 'protocol-01',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// Import directly from SDK source (monorepo workspace)
import {
  ZkSplClient,
  LocalStateManager,
  poseidonHash,
  bytesToField,
  pubkeyToField,
  deriveOwnerPubkey,
  deriveDeterministicSalt,
  fieldToBytes,
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
    const raw = await AsyncStorage.getItem(`${ZKSPL_STATE_PREFIX}${key}`);
    if (!raw) return null;
    // Decrypt vault-encrypted state (contains spending key)
    return vaultDecrypt(raw);
  }

  async set(key: string, value: string): Promise<void> {
    // Encrypt state at rest — contains spending key and balance secrets
    const encrypted = isVaultUnlocked() ? vaultEncrypt(value) : value;
    await AsyncStorage.setItem(`${ZKSPL_STATE_PREFIX}${key}`, encrypted);
  }

  async delete(key: string): Promise<void> {
    await AsyncStorage.removeItem(`${ZKSPL_STATE_PREFIX}${key}`);
  }
}

// ---------------------------------------------------------------------------
// Token constants
// ---------------------------------------------------------------------------

/** For native SOL, the token_mint = SystemProgram.programId */
export const NATIVE_SOL_MINT = SystemProgram.programId;
export const NATIVE_SOL_MINT_STR = NATIVE_SOL_MINT.toBase58(); // "11111111111111111111111111111111"

/** Devnet USDC mint */
export const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const USDC_DEVNET_MINT_STR = USDC_DEVNET_MINT.toBase58();

/** Decimal places for each token type */
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

/** Token metadata for supported tokens */
export interface TokenConfig {
  mint: PublicKey;
  mintStr: string;
  symbol: string;
  name: string;
  decimals: number;
  icon: string; // Ionicon name
}

export const SUPPORTED_TOKENS: TokenConfig[] = [
  {
    mint: NATIVE_SOL_MINT,
    mintStr: NATIVE_SOL_MINT_STR,
    symbol: 'SOL',
    name: 'Solana',
    decimals: SOL_DECIMALS,
    icon: 'logo-bitcoin', // closest Ionicon; UI can override with custom SVG
  },
  {
    mint: USDC_DEVNET_MINT,
    mintStr: USDC_DEVNET_MINT_STR,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: USDC_DECIMALS,
    icon: 'cash-outline',
  },
];

/** Look up token config by mint string */
export function getTokenConfig(mintStr: string): TokenConfig | undefined {
  return SUPPORTED_TOKENS.find(t => t.mintStr === mintStr);
}

/** Get decimals for a given mint (defaults to 9 for unknown tokens) */
export function getTokenDecimals(mintStr: string): number {
  return getTokenConfig(mintStr)?.decimals ?? 9;
}

/** Get symbol for a given mint */
export function getTokenSymbol(mintStr: string): string {
  return getTokenConfig(mintStr)?.symbol ?? 'TOKEN';
}

/**
 * Format a raw lamport/atomic amount for display.
 * E.g., formatTokenAmount(USDC_DEVNET_MINT_STR, 1_500_000) => "1.5000"
 */
export function formatTokenAmount(mintStr: string, atomicAmount: number, decimals?: number): string {
  const d = decimals ?? getTokenDecimals(mintStr);
  const value = atomicAmount / Math.pow(10, d);
  // Show 4 decimal places for SOL, 2 for USDC
  const displayDecimals = d >= 9 ? 4 : 2;
  return value.toFixed(displayDecimals);
}

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

class KeypairWallet {
  constructor(private keypair: import('@solana/web3.js').Keypair) {}

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async signTransaction<T extends Transaction | import('@solana/web3.js').VersionedTransaction>(tx: T): Promise<T> {
    (tx as Transaction).sign(this.keypair);
    return tx;
  }

  async signAllTransactions<T extends Transaction | import('@solana/web3.js').VersionedTransaction>(txs: T[]): Promise<T[]> {
    for (const tx of txs) {
      (tx as Transaction).sign(this.keypair);
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
  private connection: Connection;
  private keypair: Keypair;

  constructor(
    connection: Connection,
    wallet: Wallet,
    spendingKey: FieldElement,
    keypair: Keypair,
  ) {
    this.spendingKey = spendingKey;
    this.walletPublicKey = wallet.publicKey;
    this.connection = connection;
    this.keypair = keypair;

    // STARK-ONLY MODE: No prover config. Callers upload a verified STARK proof
    // buffer to `p01_stark_verifier` and pass its pubkey to each mutation.
    if (__DEV__) console.log('[ZkSPL] STARK-only mode: spending_key never leaves the device');

    this.client = new ZkSplClient({
      connection,
      wallet,
      programId: new PublicKey(ZKSPL_PROGRAM_ID),
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
  // Operations (STARK-proof-buffer-driven)
  // -----------------------------------------------------------------------

  /**
   * Check if a token mint is native SOL (SystemProgram.programId).
   */
  private isNativeSol(tokenMint: PublicKey): boolean {
    return tokenMint.equals(NATIVE_SOL_MINT);
  }

  /**
   * For SPL tokens (non-SOL), derive the user's ATA and pool vault ATA.
   * Returns undefined for both if the token is native SOL.
   */
  private deriveTokenAccounts(tokenMint: PublicKey): {
    userTokenAccount: PublicKey | undefined;
    poolVaultTokenAccount: PublicKey | undefined;
  } {
    if (this.isNativeSol(tokenMint)) {
      return { userTokenAccount: undefined, poolVaultTokenAccount: undefined };
    }
    return {
      userTokenAccount: this.client.deriveUserTokenAccount(this.walletPublicKey, tokenMint),
      poolVaultTokenAccount: this.client.derivePoolVaultTokenAccount(tokenMint),
    };
  }

  /**
   * For SPL tokens, ensure the user's ATA exists (creates it if needed).
   */
  async ensureTokenAccount(tokenMint: PublicKey): Promise<PublicKey | undefined> {
    if (this.isNativeSol(tokenMint)) return undefined;
    return this.client.ensureTokenAccountExists(this.walletPublicKey, tokenMint);
  }

  /**
   * Deposit tokens into the confidential account.
   *
   * Caller must have already uploaded + verified a STARK proof for circuit 4
   * (confidential_balance) and pass the verified proof buffer here along with
   * the same `newCommitment` that was bound into the proof's public inputs.
   */
  async deposit(
    tokenMint: PublicKey,
    amount: bigint,
    proofBuffer: PublicKey,
    newCommitment: Uint8Array,
  ): Promise<{ signature: string; newBalance: bigint }> {
    const { userTokenAccount, poolVaultTokenAccount } = this.deriveTokenAccounts(tokenMint);
    const result: ZkSplTxResult = await this.client.deposit(
      tokenMint,
      amount,
      proofBuffer,
      newCommitment,
      userTokenAccount,
      poolVaultTokenAccount,
    );
    return {
      signature: result.signature,
      newBalance: result.newBalance,
    };
  }

  /**
   * Withdraw tokens from the confidential account.
   *
   * Caller must have already uploaded + verified a STARK proof for circuit 4
   * and pass the verified proof buffer here.
   */
  async withdraw(
    tokenMint: PublicKey,
    amount: bigint,
    proofBuffer: PublicKey,
    newCommitment: Uint8Array,
  ): Promise<{ signature: string; newBalance: bigint }> {
    // For SPL tokens, ensure user has an ATA to receive the tokens
    if (!this.isNativeSol(tokenMint)) {
      await this.ensureTokenAccount(tokenMint);
    }
    const { userTokenAccount, poolVaultTokenAccount } = this.deriveTokenAccounts(tokenMint);
    const result: ZkSplTxResult = await this.client.withdraw(
      tokenMint,
      amount,
      proofBuffer,
      newCommitment,
      userTokenAccount,
      poolVaultTokenAccount,
    );
    return {
      signature: result.signature,
      newBalance: result.newBalance,
    };
  }

  /**
   * Send a confidential transfer to another user.
   *
   * Caller must have already uploaded + verified a STARK proof for circuit 4
   * (confidential_balance — sender-side balance update). Circuit 5 (UTXO
   * transfer) belongs to `zk_shielded`, not to zkSPL.
   *
   * Returns the amountHash and amountSalt the recipient needs to apply.
   */
  async transfer(
    tokenMint: PublicKey,
    recipientPubkey: PublicKey,
    amount: bigint,
    proofBuffer: PublicKey,
    newCommitment: Uint8Array,
    amountHash: Uint8Array,
    amountSalt: FieldElement,
  ): Promise<{ signature: string; amountHash: bigint; amountSalt: bigint }> {
    const result = await this.client.confidentialTransfer(
      tokenMint,
      recipientPubkey,
      amount,
      proofBuffer,
      newCommitment,
      amountHash,
      amountSalt,
    );
    return {
      signature: result.signature,
      amountHash: bytesToField(amountHash),
      amountSalt: result.amountSaltUsed,
    };
  }

  /**
   * Apply a pending credit (receive side).
   *
   * The recipient must know the plaintext amount and amount_salt
   * (communicated out-of-band by the sender) so they can regenerate the
   * matching STARK proof.
   */
  async applyPending(
    tokenMint: PublicKey,
    amount: bigint,
    proofBuffer: PublicKey,
    newCommitment: Uint8Array,
    amountHash: Uint8Array,
  ): Promise<{ signature: string; newBalance: bigint }> {
    const result: ZkSplTxResult = await this.client.applyPending(
      tokenMint,
      amount,
      proofBuffer,
      newCommitment,
      amountHash,
    );
    return {
      signature: result.signature,
      newBalance: result.newBalance,
    };
  }

  /**
   * Prove the balance satisfies a threshold. Caller must have uploaded +
   * verified a STARK proof for circuit 2 (balance_proof).
   */
  async proveBalance(
    tokenMint: PublicKey,
    threshold: bigint,
    proofBuffer: PublicKey,
  ): Promise<string> {
    return this.client.proveBalance(tokenMint, threshold, proofBuffer);
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

  /** Expose the derived spending key (never leaves the device). */
  getSpendingKey(): FieldElement {
    return this.spendingKey;
  }

  // -----------------------------------------------------------------------
  // STARK proof inputs — expose internal state for STARK proof generation
  // -----------------------------------------------------------------------

  /**
   * Get the inputs needed for STARK confidential_balance proof generation.
   * This reads the current local state (balance, salt, nonce) and computes
   * the values the STARK circuit expects.
   *
   * @param tokenMint - The SPL token mint
   * @param amount - The operation amount (in atomic units)
   * @param isDebit - Whether this is a withdrawal/transfer (debit) vs deposit (credit)
   * @returns All values needed for STARK circuit 4 (confidential_balance)
   */
  async getConfidentialProofInputs(
    tokenMint: PublicKey,
    amount: bigint,
    isDebit: boolean,
  ): Promise<{
    spendingKey: string;
    oldBalance: string;
    oldSalt: string;
    newBalance: string;
    newSalt: string;
    amount: string;
    amountSalt: string;
    tokenMint: string;
  }> {
    const tokenMintField = pubkeyToField(tokenMint.toBytes());

    const state = await this.client.getLocalState(tokenMint);
    if (!state) {
      throw new Error('No local state. Call createAccount() first.');
    }

    const oldBalance = state.balance;
    const oldSalt = state.salt;
    const currentNonce = state.nonce;
    const newBalance = isDebit ? oldBalance - amount : oldBalance + amount;
    const newSalt = deriveDeterministicSalt(this.spendingKey, currentNonce + 1n);

    return {
      spendingKey: this.spendingKey.toString(),
      oldBalance: oldBalance.toString(),
      oldSalt: oldSalt.toString(),
      newBalance: newBalance.toString(),
      newSalt: newSalt.toString(),
      amount: amount.toString(),
      amountSalt: '0', // deposit/withdraw use zero amount salt
      tokenMint: tokenMintField.toString(),
    };
  }

  /**
   * Get the inputs needed for STARK transfer proof generation.
   *
   * NOTE: zkSPL's confidential_transfer uses STARK circuit 4 (confidential_balance)
   * for the sender's balance update — NOT circuit 5 (which is UTXO-style and
   * reserved for `zk_shielded`). This helper returns the same shape as
   * `getConfidentialProofInputs` but with a non-zero `amountSalt` so the
   * resulting `amount_hash = Poseidon(amount, amountSalt)` can be shared
   * with the recipient.
   *
   * @param tokenMint - The SPL token mint
   * @param amount - The transfer amount (in atomic units)
   */
  async getTransferProofInputs(
    tokenMint: PublicKey,
    amount: bigint,
  ): Promise<{
    spendingKey: string;
    oldBalance: string;
    oldSalt: string;
    newBalance: string;
    newSalt: string;
    amount: string;
    amountSalt: string;
    tokenMint: string;
  }> {
    const tokenMintField = pubkeyToField(tokenMint.toBytes());

    const state = await this.client.getLocalState(tokenMint);
    if (!state) {
      throw new Error('No local state. Call createAccount() first.');
    }

    const currentNonce = state.nonce;
    const oldBalance = state.balance;
    const oldSalt = state.salt;
    const newBalance = oldBalance - amount;
    const newSalt = deriveDeterministicSalt(this.spendingKey, currentNonce + 1n);

    // Amount salt binds the pending credit to a specific sender/nonce.
    // Derive deterministically so we can regenerate it if the store is lost.
    const amountSalt = deriveDeterministicSalt(
      this.spendingKey,
      currentNonce + 1n + (1n << 32n), // domain separator away from balance salt
    );

    return {
      spendingKey: this.spendingKey.toString(),
      oldBalance: oldBalance.toString(),
      oldSalt: oldSalt.toString(),
      newBalance: newBalance.toString(),
      newSalt: newSalt.toString(),
      amount: amount.toString(),
      amountSalt: amountSalt.toString(),
      tokenMint: tokenMintField.toString(),
    };
  }

  /**
   * Compute the 32-byte LE representation of a bigint commitment / hash, as
   * required by the zkSPL Anchor instructions. Each u64 value is projected
   * into the first 8 bytes of the [u8; 32] and the rest stays zero, matching
   * the Goldilocks-field convention used on-chain.
   */
  static fieldToBytes32LE(value: FieldElement | string | bigint): Uint8Array {
    const v = typeof value === 'bigint' ? value : BigInt(value);
    return fieldToBytes(v);
  }

  // -----------------------------------------------------------------------
  // State validation & recovery
  // -----------------------------------------------------------------------

  /**
   * Validate that local state matches the on-chain commitment.
   */
  async validateState(tokenMint: PublicKey): Promise<{
    isValid: boolean;
    localNonce: bigint;
    onChainNonce: bigint;
    localBalance: bigint;
    commitmentMatches: boolean;
    details: string;
  }> {
    return this.client.validateState(tokenMint);
  }

  /**
   * Emergency reset: clear local state and reinitialize with zero balance.
   * WARNING: This forfeits any confidential balance that can't be recovered.
   */
  async emergencyReset(tokenMint: PublicKey): Promise<string | null> {
    return this.client.emergencyReset(tokenMint);
  }

  /**
   * Send regular SOL from the ZK wallet to any destination address.
   * Used to sweep funds back to the main wallet after withdraw/unshield.
   */
  async sweepSol(
    destination: PublicKey,
    lamports: bigint,
  ): Promise<string> {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.walletPublicKey,
        toPubkey: destination,
        lamports,
      }),
    );
    return sendAndConfirmTransaction(this.connection, tx, [this.keypair]);
  }

  /**
   * Private sweep: move SOL from ZK wallet to main wallet via the shielded pool.
   *
   * Flow:
   *   1. Shield SOL from ZK wallet into the shielded pool
   *   2. Unshield SOL from the pool to the main wallet address
   *
   * This breaks the on-chain link between the ZK wallet and main wallet —
   * no direct SystemProgram.transfer is visible.
   *
   * @param mainWalletAddress - Destination main wallet public key
   * @param lamports - Amount in lamports to sweep
   * @param onProgress - Callback for progress updates (step: 'shield' | 'unshield', message: string)
   */
  async privateSweepToMainWallet(
    mainWalletAddress: PublicKey,
    lamports: bigint,
    onProgress?: (step: 'shield' | 'unshield', message: string) => void,
  ): Promise<{ shieldSig: string; unshieldSig: string }> {
    const zkService = getZkService();
    if (!(zkService as any).isInitialized) {
      // ZkService needs to be initialized with the mnemonic/seed.
      // It should already be initialized by the shielded store if the user
      // has used shielded features before. If not, we need to init it.
      // Privy `p01_zk_seed` fallback removed (spec §3 Phase 1, R-12) — local
      // wallet mnemonic is the only seed source now.
      const seed = await SecureStore.getItemAsync(MNEMONIC_KEY, SECURE_OPTIONS);
      if (!seed) {
        throw new Error('No seed available to initialize ZK service for private sweep');
      }
      await zkService.initialize(seed);
    }

    // Use the ZK wallet's keypair to sign shield transactions
    const zkWalletKeypair = this.keypair;
    const signTransaction = async (tx: Transaction): Promise<Transaction> => {
      tx.sign(zkWalletKeypair);
      return tx;
    };

    // Step 1: Shield SOL from ZK wallet into the shielded pool
    onProgress?.('shield', 'Shielding into pool...');
    const shieldSig = await zkService.shield(
      lamports,
      zkWalletKeypair.publicKey,
      signTransaction,
    );

    // Step 2: Unshield SOL from the pool to the main wallet
    onProgress?.('unshield', 'Unshielding to main wallet...');
    const unshieldSig = await zkService.unshield(
      mainWalletAddress,
      lamports,
      zkWalletKeypair.publicKey,
      signTransaction,
    );

    return { shieldSig, unshieldSig };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _service: ZkSplService | null = null;

/**
 * Resolve a Keypair for the ZkSPL service.
 *
 * Tries, in order:
 *   1. getKeypair()  — reads p01_private_key from SecureStore (fast path)
 *   2. p01_mnemonic  — derive keypair from the wallet mnemonic
 *
 * NOTE(Privy-removal, spec §3 Phase 1, R-12): the former steps 3 + 4 — derive
 * from / GENERATE a random `p01_zk_seed` mnemonic for keyless (Privy) wallets —
 * have been REMOVED. The random-mnemonic fallback was a footgun: it minted a
 * fresh, non-deterministic ZK identity that no other device could reproduce,
 * silently orphaning any zkSPL balances created under it. `p01_zk_seed` is one
 * of the four accepted orphaned seed classes (see services/privacy/privyDataLoss
 * and the denominatedPool data-loss notice). If neither a private key nor a
 * mnemonic is present, the ZkSPL service is simply unavailable (returns null).
 */
async function resolveKeypair(): Promise<Keypair | null> {
  // 1. Fast path — private key already in SecureStore
  const kp = await getKeypair();
  if (kp) {
    if (__DEV__) console.log('[ZkSPL] Keypair from SecureStore private key');
    return kp;
  }

  // 2. Derive from mnemonic
  const mnemonic = await SecureStore.getItemAsync(MNEMONIC_KEY, SECURE_OPTIONS);
  if (mnemonic) {
    if (__DEV__) console.log('[ZkSPL] Deriving keypair from mnemonic');
    return deriveKeypairFromMnemonic(mnemonic);
  }

  // No local keypair material — ZkSPL unavailable (Privy fallback removed).
  return null;
}

/**
 * Get or create the ZkSplService singleton.
 * Returns null if wallet is not available.
 */
export async function getZkSplService(): Promise<ZkSplService | null> {
  if (_service) return _service;

  try {
    const keypair = await resolveKeypair();
    if (!keypair) {
      console.warn('[ZkSPL] No keypair available after all fallbacks');
      return null;
    }

    const connection = getConnection();
    const wallet = new KeypairWallet(keypair);
    const spendingKey = deriveSpendingKey(keypair.secretKey);

    _service = new ZkSplService(connection, wallet as any, spendingKey, keypair);
    if (__DEV__) console.log('[ZkSPL] Service initialized, wallet:', keypair.publicKey.toBase58());
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
