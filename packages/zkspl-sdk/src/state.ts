/**
 * Local state management for zkSPL confidential accounts.
 *
 * The owner must track their plaintext balance and salt locally because
 * the on-chain account only stores a Poseidon commitment.
 *
 * State is keyed by `${ownerPubkey}:${tokenMint}` and stored in a
 * caller-provided persistence layer (Map for in-memory, or a custom
 * adapter for IndexedDB / AsyncStorage / etc.).
 */

import type {
  FieldElement,
  LocalAccountState,
  KnownPendingCredit,
} from './types';

// ---------------------------------------------------------------------------
// Persistence adapter interface
// ---------------------------------------------------------------------------

/**
 * Minimal key-value persistence interface for storing confidential account state.
 *
 * Implement this to back local state with any storage backend. The SDK
 * serializes/deserializes BigInt values as strings, so the store only
 * needs to handle plain JSON strings.
 *
 * **Built-in implementations:**
 * - {@link InMemoryStateStore} (default) -- backed by a `Map`, lost on page reload.
 *
 * **Custom backend example (browser IndexedDB):**
 * ```ts
 * import { StateStore } from '@protocol-01/zkspl-sdk';
 *
 * class IndexedDBStateStore implements StateStore {
 *   private dbPromise: Promise<IDBDatabase>;
 *
 *   constructor(dbName = 'zkspl') {
 *     this.dbPromise = new Promise((resolve, reject) => {
 *       const req = indexedDB.open(dbName, 1);
 *       req.onupgradeneeded = () => req.result.createObjectStore('state');
 *       req.onsuccess = () => resolve(req.result);
 *       req.onerror = () => reject(req.error);
 *     });
 *   }
 *
 *   async get(key: string): Promise<string | null> {
 *     const db = await this.dbPromise;
 *     return new Promise((resolve, reject) => {
 *       const tx = db.transaction('state', 'readonly');
 *       const req = tx.objectStore('state').get(key);
 *       req.onsuccess = () => resolve(req.result ?? null);
 *       req.onerror = () => reject(req.error);
 *     });
 *   }
 *
 *   async set(key: string, value: string): Promise<void> {
 *     const db = await this.dbPromise;
 *     return new Promise((resolve, reject) => {
 *       const tx = db.transaction('state', 'readwrite');
 *       tx.objectStore('state').put(value, key);
 *       tx.oncomplete = () => resolve();
 *       tx.onerror = () => reject(tx.error);
 *     });
 *   }
 *
 *   async delete(key: string): Promise<void> {
 *     const db = await this.dbPromise;
 *     return new Promise((resolve, reject) => {
 *       const tx = db.transaction('state', 'readwrite');
 *       tx.objectStore('state').delete(key);
 *       tx.oncomplete = () => resolve();
 *       tx.onerror = () => reject(tx.error);
 *     });
 *   }
 * }
 * ```
 *
 * **React Native (AsyncStorage):**
 * ```ts
 * import AsyncStorage from '@react-native-async-storage/async-storage';
 * import { StateStore } from '@protocol-01/zkspl-sdk';
 *
 * class AsyncStorageStateStore implements StateStore {
 *   async get(key: string) { return AsyncStorage.getItem(key); }
 *   async set(key: string, value: string) { await AsyncStorage.setItem(key, value); }
 *   async delete(key: string) { await AsyncStorage.removeItem(key); }
 * }
 * ```
 */
export interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory store (default / testing)
// ---------------------------------------------------------------------------

/** Simple in-memory store backed by a Map */
export class InMemoryStateStore implements StateStore {
  private data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

// ---------------------------------------------------------------------------
// State serialization helpers
// ---------------------------------------------------------------------------

/** Build the storage key for a (owner, mint) pair */
function stateKey(ownerPubkey: string, tokenMint: string): string {
  return `zkspl:${ownerPubkey}:${tokenMint}`;
}

/** Serialize a LocalAccountState to JSON string */
function serialize(state: LocalAccountState): string {
  return JSON.stringify({
    tokenMint: state.tokenMint,
    balance: state.balance.toString(),
    salt: state.salt.toString(),
    nonce: state.nonce.toString(),
    spendingKey: state.spendingKey.toString(),
    knownPendingCredits: state.knownPendingCredits.map(pc => ({
      amountHash: pc.amountHash.toString(),
      amount: pc.amount.toString(),
      amountSalt: pc.amountSalt.toString(),
      sender: pc.sender,
    })),
  });
}

/** Deserialize a JSON string to LocalAccountState */
function deserialize(json: string): LocalAccountState {
  const obj = JSON.parse(json);
  return {
    tokenMint: obj.tokenMint,
    balance: BigInt(obj.balance),
    salt: BigInt(obj.salt),
    nonce: BigInt(obj.nonce),
    spendingKey: BigInt(obj.spendingKey),
    knownPendingCredits: (obj.knownPendingCredits ?? []).map(
      (pc: { amountHash: string; amount: string; amountSalt: string; sender: string }) => ({
        amountHash: BigInt(pc.amountHash),
        amount: BigInt(pc.amount),
        amountSalt: BigInt(pc.amountSalt),
        sender: pc.sender,
      })
    ),
  };
}

// ---------------------------------------------------------------------------
// LocalStateManager
// ---------------------------------------------------------------------------

/**
 * Manages the local plaintext state for all confidential accounts
 * belonging to an owner.
 *
 * **Persistence model:**
 * - On-chain, balances are stored as Poseidon commitments -- opaque 32-byte hashes.
 * - Only the owner (who knows the spending key) can interpret these commitments.
 * - This manager keeps the plaintext balance, salt, nonce, and spending key
 *   in a caller-provided {@link StateStore} so they survive across sessions.
 * - State is keyed by `"zkspl:<ownerPubkey>:<tokenMint>"`.
 *
 * **Recovery:**
 * - If local state is lost but the spending key is available, deterministic
 *   salts can be recomputed from `(spendingKey, nonce)` and the balance
 *   can be recovered by replaying on-chain events.
 * - See `ZkSplClient.emergencyReset()` for a last-resort reset.
 *
 * **Thread safety:**
 * - The manager caches deserialized state in memory for the current session.
 * - Concurrent writes to the same key are not safe -- serialize access
 *   at the application level if needed.
 *
 * @example
 * ```ts
 * import { LocalStateManager, InMemoryStateStore } from '@protocol-01/zkspl-sdk';
 *
 * const store = new InMemoryStateStore(); // or your custom StateStore
 * const stateManager = new LocalStateManager(store);
 *
 * // Initialize state for a new account
 * await stateManager.initializeState(ownerPubkey, tokenMint, spendingKey, salt);
 *
 * // Read state
 * const state = await stateManager.getState(ownerPubkey, tokenMint);
 * console.log(state?.balance); // 0n
 * ```
 */
export class LocalStateManager {
  private store: StateStore;
  /** Cache to avoid repeated deserialization within the same session */
  private cache = new Map<string, LocalAccountState>();

  constructor(store?: StateStore) {
    this.store = store ?? new InMemoryStateStore();
  }

  // -----------------------------------------------------------------------
  // Read
  // -----------------------------------------------------------------------

  /**
   * Load state for a (owner, mint) pair.
   * Returns null if no state exists yet.
   */
  async getState(
    ownerPubkey: string,
    tokenMint: string
  ): Promise<LocalAccountState | null> {
    const key = stateKey(ownerPubkey, tokenMint);

    // Check in-memory cache first
    const cached = this.cache.get(key);
    if (cached) return cached;

    const json = await this.store.get(key);
    if (!json) return null;

    const state = deserialize(json);
    this.cache.set(key, state);
    return state;
  }

  // -----------------------------------------------------------------------
  // Write
  // -----------------------------------------------------------------------

  /**
   * Save (create or update) state for a (owner, mint) pair.
   */
  async saveState(
    ownerPubkey: string,
    state: LocalAccountState
  ): Promise<void> {
    const key = stateKey(ownerPubkey, state.tokenMint);
    await this.store.set(key, serialize(state));
    this.cache.set(key, state);
  }

  /**
   * Initialize local state for a brand-new confidential account.
   */
  async initializeState(
    ownerPubkey: string,
    tokenMint: string,
    spendingKey: FieldElement,
    initialSalt: FieldElement
  ): Promise<LocalAccountState> {
    const state: LocalAccountState = {
      tokenMint,
      balance: 0n,
      salt: initialSalt,
      nonce: 0n,
      spendingKey,
      knownPendingCredits: [],
    };
    await this.saveState(ownerPubkey, state);
    return state;
  }

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  /**
   * Update local state after a deposit.
   */
  async afterDeposit(
    ownerPubkey: string,
    tokenMint: string,
    depositAmount: bigint,
    newSalt: FieldElement,
    newNonce: bigint
  ): Promise<LocalAccountState> {
    const state = await this.requireState(ownerPubkey, tokenMint);
    state.balance += depositAmount;
    state.salt = newSalt;
    state.nonce = newNonce;
    await this.saveState(ownerPubkey, state);
    return state;
  }

  /**
   * Update local state after a withdrawal.
   */
  async afterWithdraw(
    ownerPubkey: string,
    tokenMint: string,
    withdrawAmount: bigint,
    newSalt: FieldElement,
    newNonce: bigint
  ): Promise<LocalAccountState> {
    const state = await this.requireState(ownerPubkey, tokenMint);
    if (state.balance < withdrawAmount) {
      throw new Error(
        `Insufficient balance: have ${state.balance}, need ${withdrawAmount}`
      );
    }
    state.balance -= withdrawAmount;
    state.salt = newSalt;
    state.nonce = newNonce;
    await this.saveState(ownerPubkey, state);
    return state;
  }

  /**
   * Update local state after sending a confidential transfer (debit side).
   */
  async afterSend(
    ownerPubkey: string,
    tokenMint: string,
    sendAmount: bigint,
    newSalt: FieldElement,
    newNonce: bigint
  ): Promise<LocalAccountState> {
    const state = await this.requireState(ownerPubkey, tokenMint);
    if (state.balance < sendAmount) {
      throw new Error(
        `Insufficient balance: have ${state.balance}, need ${sendAmount}`
      );
    }
    state.balance -= sendAmount;
    state.salt = newSalt;
    state.nonce = newNonce;
    await this.saveState(ownerPubkey, state);
    return state;
  }

  /**
   * Record a known pending credit (received out-of-band from the sender).
   */
  async addPendingCredit(
    ownerPubkey: string,
    tokenMint: string,
    credit: KnownPendingCredit
  ): Promise<void> {
    const state = await this.requireState(ownerPubkey, tokenMint);
    // Avoid duplicates
    const exists = state.knownPendingCredits.some(
      pc => pc.amountHash === credit.amountHash
    );
    if (!exists) {
      state.knownPendingCredits.push(credit);
      await this.saveState(ownerPubkey, state);
    }
  }

  /**
   * Update local state after applying a pending credit (receive side).
   */
  async afterApplyPending(
    ownerPubkey: string,
    tokenMint: string,
    amountHash: FieldElement,
    receivedAmount: bigint,
    newSalt: FieldElement,
    newNonce: bigint
  ): Promise<LocalAccountState> {
    const state = await this.requireState(ownerPubkey, tokenMint);
    state.balance += receivedAmount;
    state.salt = newSalt;
    state.nonce = newNonce;
    // Remove the applied pending credit
    state.knownPendingCredits = state.knownPendingCredits.filter(
      pc => pc.amountHash !== amountHash
    );
    await this.saveState(ownerPubkey, state);
    return state;
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  /**
   * Remove local state for a (owner, mint) pair.
   */
  async deleteState(ownerPubkey: string, tokenMint: string): Promise<void> {
    const key = stateKey(ownerPubkey, tokenMint);
    await this.store.delete(key);
    this.cache.delete(key);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async requireState(
    ownerPubkey: string,
    tokenMint: string
  ): Promise<LocalAccountState> {
    const state = await this.getState(ownerPubkey, tokenMint);
    if (!state) {
      throw new Error(
        `No local state for mint ${tokenMint}. ` +
          'Call createAccount() first or restore from backup.'
      );
    }
    return state;
  }
}
