import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getZkServiceExtension, ZkServiceExtension, ZkAddress } from '../services/zk';

/**
 * Shielded note data (serializable)
 */
interface ShieldedNote {
  amount: string;
  commitment: string;
  leafIndex?: number;
  createdAt: number;
}

/**
 * Pending transaction
 */
interface PendingTransaction {
  id: string;
  type: 'shield' | 'unshield' | 'transfer';
  amount: number;
  status: 'pending' | 'generating_proof' | 'submitting' | 'confirmed' | 'failed';
  error?: string;
  createdAt: number;
  signature?: string;
}

/**
 * Shielded wallet state
 */
interface ShieldedState {
  // State
  isInitialized: boolean;
  isLoading: boolean;
  shieldedBalance: number;
  notes: ShieldedNote[];
  zkAddress: string | null;
  pendingTransactions: PendingTransaction[];
  lastSyncedIndex: number;
  merkleRoot: string | null;

  // Internal
  _zkService: ZkServiceExtension | null;

  // Actions
  initialize: (seedPhrase: string, connection: Connection) => Promise<void>;
  refreshBalance: () => Promise<void>;
  shield: (
    amount: number,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ) => Promise<string>;
  unshield: (
    amount: number,
    recipient: PublicKey,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ) => Promise<string>;
  transfer: (
    recipient: string,
    amount: number,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ) => Promise<string>;
  scanNotes: () => Promise<void>;
  reset: () => void;
}

/**
 * Shielded wallet store
 * Uses real ZK SDK service for on-chain shielded transactions
 */
export const useShieldedStore = create<ShieldedState>()(
  persist(
    (set, get) => ({
      // Initial state
      isInitialized: false,
      isLoading: false,
      shieldedBalance: 0,
      notes: [],
      zkAddress: null,
      pendingTransactions: [],
      lastSyncedIndex: 0,
      merkleRoot: null,
      _zkService: null,

      // Initialize with real ZK service
      initialize: async (seedPhrase: string, connection: Connection) => {
        set({ isLoading: true });

        try {
          // Get ZK service singleton
          const zkService = getZkServiceExtension();
          zkService.setConnection(connection);

          // Initialize with user's seed phrase
          await zkService.initialize(seedPhrase);

          // Get ZK address
          const zkAddress = zkService.getZkAddress();

          // Get initial balance
          const balanceLamports = zkService.getShieldedBalance();
          const balance = Number(balanceLamports) / 1e9;

          set({
            isInitialized: true,
            zkAddress: zkAddress.encoded,
            shieldedBalance: balance,
            isLoading: false,
            _zkService: zkService,
          });

          console.log('[Shielded] Initialized with ZK address:', zkAddress.encoded);
        } catch (error) {
          console.error('[Shielded] Initialize error:', error);
          set({ isLoading: false });
          throw error;
        }
      },

      // Refresh balance from ZK service
      refreshBalance: async () => {
        const { _zkService } = get();
        if (!_zkService) return;

        set({ isLoading: true });

        try {
          const balanceLamports = _zkService.getShieldedBalance();
          const balance = Number(balanceLamports) / 1e9;

          set({
            shieldedBalance: balance,
            isLoading: false,
          });
        } catch (error) {
          console.error('[Shielded] Refresh balance error:', error);
          set({ isLoading: false });
        }
      },

      // Shield tokens using real ZK SDK
      shield: async (amount: number, walletPublicKey: PublicKey, signTransaction) => {
        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        const txId = crypto.randomUUID();
        const amountLamports = BigInt(Math.floor(amount * 1e9));

        set(state => ({
          pendingTransactions: [
            ...state.pendingTransactions,
            {
              id: txId,
              type: 'shield',
              amount,
              status: 'generating_proof',
              createdAt: Date.now(),
            },
          ],
        }));

        try {
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          // Call real ZK service
          const signature = await _zkService.shield(
            amountLamports,
            walletPublicKey,
            signTransaction
          );

          // Update state
          const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;

          set(state => ({
            shieldedBalance: newBalance,
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'confirmed', signature } : tx
            ),
          }));

          // Remove from pending after delay
          setTimeout(() => {
            set(state => ({
              pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
            }));
          }, 5000);

          console.log('[Shielded] Shield successful:', signature);
          return signature;
        } catch (error) {
          console.error('[Shielded] Shield error:', error);
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId
                ? { ...tx, status: 'failed', error: (error as Error).message }
                : tx
            ),
          }));
          throw error;
        }
      },

      // Unshield tokens using real ZK SDK
      unshield: async (amount: number, recipient: PublicKey, walletPublicKey: PublicKey, signTransaction) => {
        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        const txId = crypto.randomUUID();
        const amountLamports = BigInt(Math.floor(amount * 1e9));

        set(state => ({
          pendingTransactions: [
            ...state.pendingTransactions,
            {
              id: txId,
              type: 'unshield',
              amount,
              status: 'generating_proof',
              createdAt: Date.now(),
            },
          ],
        }));

        try {
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          // Call real ZK service
          const signature = await _zkService.unshield(
            recipient,
            amountLamports,
            walletPublicKey,
            signTransaction
          );

          // Update state
          const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;

          set(state => ({
            shieldedBalance: newBalance,
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'confirmed', signature } : tx
            ),
          }));

          setTimeout(() => {
            set(state => ({
              pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
            }));
          }, 5000);

          console.log('[Shielded] Unshield successful:', signature);
          return signature;
        } catch (error) {
          console.error('[Shielded] Unshield error:', error);
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId
                ? { ...tx, status: 'failed', error: (error as Error).message }
                : tx
            ),
          }));
          throw error;
        }
      },

      // Transfer shielded tokens using real ZK SDK
      transfer: async (recipient: string, amount: number, walletPublicKey: PublicKey, signTransaction) => {
        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        const txId = crypto.randomUUID();
        const amountLamports = BigInt(Math.floor(amount * 1e9));

        // Parse recipient ZK address
        if (!recipient.startsWith('zk:')) {
          throw new Error('Invalid ZK address format. Must start with "zk:"');
        }

        // Decode ZK address
        const combined = Uint8Array.from(atob(recipient.slice(3)), c => c.charCodeAt(0));
        const receivingPubkeyBytes = combined.slice(0, 32);
        const viewingKey = combined.slice(32, 64);

        // Convert to bigint (LE)
        let receivingPubkey = BigInt(0);
        for (let i = receivingPubkeyBytes.length - 1; i >= 0; i--) {
          receivingPubkey = (receivingPubkey << BigInt(8)) + BigInt(receivingPubkeyBytes[i]);
        }

        const zkRecipient: ZkAddress = {
          receivingPubkey,
          viewingKey,
          encoded: recipient,
        };

        set(state => ({
          pendingTransactions: [
            ...state.pendingTransactions,
            {
              id: txId,
              type: 'transfer',
              amount,
              status: 'generating_proof',
              createdAt: Date.now(),
            },
          ],
        }));

        try {
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          // Call real ZK service
          const signature = await _zkService.transfer(
            zkRecipient,
            amountLamports,
            walletPublicKey,
            signTransaction
          );

          // Update state
          const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;

          set(state => ({
            shieldedBalance: newBalance,
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'confirmed', signature } : tx
            ),
          }));

          setTimeout(() => {
            set(state => ({
              pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
            }));
          }, 5000);

          console.log('[Shielded] Transfer successful:', signature);
          return signature;
        } catch (error) {
          console.error('[Shielded] Transfer error:', error);
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId
                ? { ...tx, status: 'failed', error: (error as Error).message }
                : tx
            ),
          }));
          throw error;
        }
      },

      // Scan for incoming notes on the blockchain
      scanNotes: async () => {
        const { _zkService } = get();
        if (!_zkService) return;

        set({ isLoading: true });

        try {
          // Get last scanned position
          const lastSignature = await _zkService.getLastScannedSignature();

          // Scan blockchain for incoming shielded notes
          const { found, newBalance } = await _zkService.scanIncomingNotes(lastSignature);

          // Update last scanned position if we found transactions
          // Note: In production, track the latest signature scanned

          // Update balance from scanned notes
          const balance = Number(newBalance) / 1e9;

          set({
            shieldedBalance: balance,
            lastSyncedIndex: get().lastSyncedIndex + found,
            isLoading: false,
          });

          if (found > 0) {
            console.log(`[Shielded] Found ${found} new incoming notes`);
          }
        } catch (error) {
          console.error('[Shielded] Scan notes error:', error);
          // Fall back to just refreshing local balance
          await get().refreshBalance();
        } finally {
          set({ isLoading: false });
        }
      },

      // Reset state
      reset: () => {
        const { _zkService } = get();
        if (_zkService) {
          _zkService.reset();
        }

        set({
          isInitialized: false,
          isLoading: false,
          shieldedBalance: 0,
          notes: [],
          zkAddress: null,
          pendingTransactions: [],
          lastSyncedIndex: 0,
          merkleRoot: null,
          _zkService: null,
        });
      },
    }),
    {
      name: 'p01-shielded',
      storage: createJSONStorage(() => ({
        getItem: async (name) => {
          const result = await chrome.storage.local.get(name);
          return result[name] || null;
        },
        setItem: async (name, value) => {
          await chrome.storage.local.set({ [name]: value });
        },
        removeItem: async (name) => {
          await chrome.storage.local.remove(name);
        },
      })),
      partialize: (state) => ({
        isInitialized: state.isInitialized,
        zkAddress: state.zkAddress,
        shieldedBalance: state.shieldedBalance,
        notes: state.notes,
        lastSyncedIndex: state.lastSyncedIndex,
        merkleRoot: state.merkleRoot,
      }),
    }
  )
);
