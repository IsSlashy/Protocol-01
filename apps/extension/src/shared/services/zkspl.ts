/**
 * zkSPL Confidential Balance Service for Chrome Extension
 *
 * Wraps the @protocol-01/zkspl-sdk client for use in the extension.
 * Handles wallet signing (Privy + legacy), spending key derivation,
 * and Chrome storage persistence for local state.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js';
import type { Wallet } from '@coral-xyz/anchor/dist/cjs/provider';
import {
  ZkSplClient,
  type ZkSplClientConfig,
  type StateStore,
  type ZkSplTxResult,
  type FieldElement,
  bytesToField,
  poseidonHash,
  ZKSPL_PROGRAM_ID,
} from '@protocol-01/zkspl-sdk';
import { useWalletStore } from '../store/wallet';
import { getConnection } from './wallet';

// ---------------------------------------------------------------------------
// Token constants
// ---------------------------------------------------------------------------

const NATIVE_SOL_MINT = SystemProgram.programId;
export const NATIVE_SOL_MINT_STR = NATIVE_SOL_MINT.toBase58();

export const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const USDC_DEVNET_MINT_STR = USDC_DEVNET_MINT.toBase58();

export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

export interface TokenConfig {
  mint: PublicKey;
  mintStr: string;
  symbol: string;
  name: string;
  decimals: number;
}

export const SUPPORTED_TOKENS: TokenConfig[] = [
  { mint: NATIVE_SOL_MINT, mintStr: NATIVE_SOL_MINT_STR, symbol: 'SOL', name: 'Solana', decimals: SOL_DECIMALS },
  { mint: USDC_DEVNET_MINT, mintStr: USDC_DEVNET_MINT_STR, symbol: 'USDC', name: 'USD Coin', decimals: USDC_DECIMALS },
];

export function getTokenConfig(mintStr: string): TokenConfig | undefined {
  return SUPPORTED_TOKENS.find(t => t.mintStr === mintStr);
}

export function getTokenDecimals(mintStr: string): number {
  return getTokenConfig(mintStr)?.decimals ?? 9;
}

export function getTokenSymbol(mintStr: string): string {
  return getTokenConfig(mintStr)?.symbol ?? 'TOKEN';
}

export function formatTokenAmount(mintStr: string, atomicAmount: number): string {
  const d = getTokenDecimals(mintStr);
  const value = atomicAmount / Math.pow(10, d);
  return value.toFixed(d >= 9 ? 4 : 2);
}

// ---------------------------------------------------------------------------
// Chrome storage-backed StateStore for zkSPL local state
// ---------------------------------------------------------------------------

class ChromeStateStore implements StateStore {
  private prefix = 'zkspl_state:';

  async get(key: string): Promise<string | null> {
    const storageKey = this.prefix + key;
    const result = await chrome.storage.local.get(storageKey);
    return result[storageKey] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const storageKey = this.prefix + key;
    await chrome.storage.local.set({ [storageKey]: value });
  }

  async delete(key: string): Promise<void> {
    const storageKey = this.prefix + key;
    await chrome.storage.local.remove(storageKey);
  }
}

// ---------------------------------------------------------------------------
// Spending key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic spending key from the wallet's secret key.
 * Uses Poseidon(bytesToField(seed)) — matches the mobile app and the
 * circuit's OwnerDerivation template (owner_pubkey = Poseidon(spending_key)).
 */
function deriveSpendingKeyFromSecret(secretKey: Uint8Array): FieldElement {
  const seed = secretKey.slice(0, 32);
  const seedField = bytesToField(seed);
  return poseidonHash([seedField]);
}

// ---------------------------------------------------------------------------
// DATA-LOSS NOTICE (Privy removal — Phase 2)
// ---------------------------------------------------------------------------
// The former `deriveSpendingKeyForPrivy` helper derived the zkSPL spending key
// from a RANDOM per-wallet seed stored under `p01_zkspl_privy_seed_<address>`.
// With Privy removed there is no path that produces or restores that random
// seed, so any confidential (zkSPL) balance that was keyed to it is ORPHANED
// and UNRECOVERABLE (accept-loss decision, see docs/privy-removal-spec.md R-12 /
// R-14, orphaning class (d) `p01_zkspl_privy_seed_*`).
//
// The local-keypair path below is deterministic from the seed phrase, so a
// re-imported local wallet always reproduces the same zkSPL spending key.
// TODO(Phase5-UI): surface a one-time user-facing warning for any wallet that
// still has a `p01_zkspl_privy_seed_*` entry in chrome.storage.local.

// ---------------------------------------------------------------------------
// Wallet adapter (matches Anchor Wallet interface)
// ---------------------------------------------------------------------------

function createWalletAdapter(): {
  wallet: Wallet;
  connection: Connection;
  spendingKeyPromise: Promise<FieldElement>;
} {
  const walletState = useWalletStore.getState();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const connection = getConnection(walletState.network);
  const keypair = walletState._keypair;

  if (!keypair) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  // Build Anchor-compatible wallet — local keypair is the only signing path.
  const wallet: Wallet = {
    publicKey: walletPublicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if (!(tx instanceof Transaction)) {
        throw new Error('VersionedTransaction signing not supported in this path');
      }
      tx.sign(keypair);
      return tx as unknown as T;
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
      const signed: T[] = [];
      for (const tx of txs) {
        if (!(tx instanceof Transaction)) {
          throw new Error('VersionedTransaction signing not supported in this path');
        }
        tx.sign(keypair);
        signed.push(tx as unknown as T);
      }
      return signed;
    },
  };

  // Derive spending key deterministically from the local keypair.
  const spendingKeyPromise = Promise.resolve(deriveSpendingKeyFromSecret(keypair.secretKey));

  return { wallet, connection, spendingKeyPromise };
}

// ---------------------------------------------------------------------------
// Singleton service
// ---------------------------------------------------------------------------

let _client: ZkSplClient | null = null;
let _clientOwner: string | null = null;

/**
 * Get or create the ZkSplClient singleton.
 * Re-creates if the wallet owner has changed.
 */
export async function getZkSplClient(): Promise<ZkSplClient> {
  const walletState = useWalletStore.getState();
  const currentOwner = walletState.publicKey;

  if (!currentOwner) {
    throw new Error('Wallet not connected');
  }

  // Return cached client if owner hasn't changed
  if (_client && _clientOwner === currentOwner) {
    return _client;
  }

  const { wallet, connection, spendingKeyPromise } = createWalletAdapter();
  const spendingKey = await spendingKeyPromise;

  // STARK-ONLY MODE: the SDK never generates proofs. Callers must upload +
  // verify a STARK proof buffer via `p01_stark_verifier` and pass its pubkey
  // to each mutation. The spending key is used locally only to derive
  // commitments for bookkeeping — it never leaves this process.
  const config: ZkSplClientConfig = {
    connection,
    wallet,
    programId: new PublicKey(ZKSPL_PROGRAM_ID),
    stateStore: new ChromeStateStore(),
    spendingKey,
  };

  _client = new ZkSplClient(config);
  _clientOwner = currentOwner;

  return _client;
}

/**
 * Reset the cached client (call on wallet disconnect / lock).
 */
export function resetZkSplClient(): void {
  _client = null;
  _clientOwner = null;
}

/**
 * Check if an on-chain confidential account exists for the current wallet.
 */
export async function hasConfidentialAccount(): Promise<boolean> {
  const client = await getZkSplClient();
  const account = await client.getConfidentialAccount(NATIVE_SOL_MINT);
  return account !== null && account.isInitialized;
}

/**
 * Get the native SOL mint public key (SystemProgram.programId).
 */
export function getNativeSolMint(): PublicKey {
  return NATIVE_SOL_MINT;
}
