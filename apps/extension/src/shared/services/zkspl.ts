/**
 * zkSPL Confidential Balance Service for Chrome Extension
 *
 * Wraps the @p01/zkspl-sdk client for use in the extension.
 * Handles wallet signing (Privy + legacy), spending key derivation,
 * and Chrome storage persistence for local state.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import type { Wallet } from '@coral-xyz/anchor';
import {
  ZkSplClient,
  type ZkSplClientConfig,
  type StateStore,
  type ZkSplTxResult,
  type FieldElement,
  bytesToField,
  ZKSPL_PROGRAM_ID,
} from '@p01/zkspl-sdk';
import { useWalletStore, getPrivySigner } from '../store/wallet';
import { getConnection } from './wallet';

// ---------------------------------------------------------------------------
// Native SOL token mint (SystemProgram.programId)
// ---------------------------------------------------------------------------

const NATIVE_SOL_MINT = SystemProgram.programId;

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
 * Uses SHA-256 of (secretKey + "zkspl_spending_key") reduced mod field.
 */
async function deriveSpendingKeyFromSecret(secretKey: Uint8Array): Promise<FieldElement> {
  const label = new TextEncoder().encode('zkspl_spending_key');
  const combined = new Uint8Array(secretKey.length + label.length);
  combined.set(secretKey);
  combined.set(label, secretKey.length);

  const hashBuffer = await crypto.subtle.digest('SHA-256', combined as unknown as ArrayBuffer);
  const hashBytes = new Uint8Array(hashBuffer);
  return bytesToField(hashBytes);
}

/**
 * Derive spending key for Privy wallets using a stored random seed.
 */
async function deriveSpendingKeyForPrivy(walletAddress: string): Promise<FieldElement> {
  const storageKey = `p01_zkspl_privy_seed_${walletAddress}`;
  const result = await chrome.storage.local.get(storageKey);

  let seedHex: string;
  if (result[storageKey]) {
    seedHex = result[storageKey];
  } else {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    seedHex = Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    await chrome.storage.local.set({ [storageKey]: seedHex });
  }

  const seedBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    seedBytes[i] = parseInt(seedHex.substr(i * 2, 2), 16);
  }
  return deriveSpendingKeyFromSecret(seedBytes);
}

// ---------------------------------------------------------------------------
// Wallet adapter (matches Anchor Wallet interface)
// ---------------------------------------------------------------------------

function createWalletAdapter(): {
  wallet: Wallet;
  connection: Connection;
  spendingKeyPromise: Promise<FieldElement>;
} {
  const walletState = useWalletStore.getState();
  const privySigner = getPrivySigner();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const connection = getConnection(walletState.network);
  const keypair = walletState._keypair;

  // Build Anchor-compatible wallet
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

  // Derive spending key
  let spendingKeyPromise: Promise<FieldElement>;
  if (walletState.isPrivyWallet) {
    spendingKeyPromise = deriveSpendingKeyForPrivy(walletState.publicKey);
  } else if (keypair) {
    spendingKeyPromise = deriveSpendingKeyFromSecret(keypair.secretKey.slice(0, 32));
  } else {
    throw new Error('No key material available for spending key derivation');
  }

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

  const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || 'https://p01-relayer-production.up.railway.app';

  const config: ZkSplClientConfig = {
    connection,
    wallet,
    programId: new PublicKey(ZKSPL_PROGRAM_ID),
    prover: {
      remoteProverUrl: `${RELAYER_URL}/prove`,
    },
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
