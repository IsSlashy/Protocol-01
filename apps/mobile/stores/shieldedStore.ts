import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PublicKey, Transaction } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import { getZkService, ZkService, ZkAddress, Note } from '../services/zk';
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import nacl from 'tweetnacl';

const MNEMONIC_KEY = 'p01_mnemonic';
const ZK_SEED_KEY = 'p01_zk_seed'; // Separate seed for ZK features (Privy users)

// Must match wallet.ts SecureStore options for reading mnemonic
const SECURE_OPTIONS = {
  keychainService: 'protocol-01',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Shielded note data (serializable version)
 */
interface ShieldedNote {
  amount: string; // bigint as string for storage
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
  _zkService: ZkService | null;

  // Actions
  initialize: (seedPhrase?: string) => Promise<void>;
  ensureInitialized: () => Promise<boolean>;
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
  importNote: (noteString: string) => Promise<void>;
  getLastSentNote: () => { noteString: string; amount: number; leafIndex: number } | null;
  clearNotes: () => Promise<void>;
  reset: () => void;
  // Stealth address methods
  getStealthKeys: () => { spendingPublicKey: string; viewingPublicKey: string; encoded: string } | null;
  unshieldStealth: (
    amount: number,
    recipientSpendingPubKey: string,
    recipientViewingPubKey: string,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ) => Promise<{ signature: string; stealthAddress: string; ephemeralPublicKey: string; viewTag: string }>;

  // True ZK private send via relayer
  privateSend: (
    recipientStealthKeys: string,
    denominationIndex: number,
    walletPublicKey: PublicKey,
    signTransaction: (tx: Transaction) => Promise<Transaction>
  ) => Promise<{
    success: boolean;
    txSignature?: string;
    stealthAddress?: string;
    error?: string;
  }>;

  // Stealth payment scanning and sweeping
  scanStealthPayments: () => Promise<{
    found: number;
    amount: number;
    payments: Array<{ stealthAddress: string; amount: number; signature: string }>;
  }>;
  getPendingStealthPayments: () => Array<{ stealthAddress: string; amount: number; signature: string }>;
  sweepStealthPayment: (stealthAddress: string, recipientAddress: string) => Promise<{
    success: boolean;
    signature?: string;
    error?: string;
  }>;
  sweepAllStealthPayments: (recipientAddress: string) => Promise<{
    success: boolean;
    swept: number;
    totalAmount: number;
    signatures: string[];
    errors: string[];
  }>;
}

// Helper to generate UUID
const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

/**
 * Shielded wallet store for mobile
 * Uses the real ZK SDK service for proof generation and on-chain transactions
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

      // AUTO-RESET: Clear old data due to key derivation fix (v2)
      // This runs once on app start to clear incompatible notes
      _dataVersion: 2,

      // Initialize the shielded wallet with real ZK service
      initialize: async (seedPhrase?: string) => {
        set({ isLoading: true });

        try {
          // If no seed phrase provided, try to get it from SecureStore
          let phrase = seedPhrase;
          if (!phrase) {
            // First try the main wallet mnemonic
            phrase = await SecureStore.getItemAsync(MNEMONIC_KEY, SECURE_OPTIONS) || undefined;

            if (!phrase) {
              // Try the ZK-specific seed (for Privy users who don't have local mnemonic)
              phrase = await SecureStore.getItemAsync(ZK_SEED_KEY, SECURE_OPTIONS) || undefined;

              if (phrase) {
                console.log('[Shielded] Using ZK-specific seed phrase');
              } else {
                // Generate a new ZK seed for Privy users
                console.log('[Shielded] Generating new ZK seed for Privy wallet...');
                phrase = generateMnemonic(wordlist, 128); // 12 words
                await SecureStore.setItemAsync(ZK_SEED_KEY, phrase, SECURE_OPTIONS);
                console.log('[Shielded] ZK seed created and stored');
              }
            } else {
              console.log('[Shielded] Retrieved seed phrase from SecureStore');
            }
          }

          // Get or create ZK service instance
          const zkService = getZkService();

          // Configure backend prover URL for mobile (no local circuit bundling)
          // Uses EXPO_PUBLIC_RELAYER_URL from .env or falls back to Cloudflare tunnel
          const RELAYER_URL = process.env.EXPO_PUBLIC_RELAYER_URL || 'https://corps-mag-distributed-ref.trycloudflare.com';
          ZkService.setBackendProverUrl(RELAYER_URL);
          console.log('[Shielded] Backend prover configured:', RELAYER_URL);

          // Initialize with user's seed phrase
          await zkService.initialize(phrase);

          // Get ZK address
          const zkAddress = zkService.getZkAddress();

          // Get initial balance and notes
          const balanceLamports = zkService.getShieldedBalance();
          const balance = Number(balanceLamports) / 1e9;

          // Sync notes from ZK service
          const zkNotes = zkService.getNotes();
          const serializedNotes: ShieldedNote[] = zkNotes.map(note => ({
            amount: note.amount.toString(),
            commitment: note.commitment.toString(),
            leafIndex: note.leafIndex,
            createdAt: Date.now(),
          }));

          set({
            isInitialized: true,
            zkAddress: zkAddress.encoded,
            shieldedBalance: balance,
            notes: serializedNotes,
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

      // Ensure ZK service is initialized (called before shield/unshield/transfer)
      ensureInitialized: async () => {
        const { _zkService } = get();

        // If service exists, we're good
        if (_zkService) {
          return true;
        }

        // Try to initialize from SecureStore (handles app restart and post-migration cases)
        console.log('[Shielded] Initializing ZK service from SecureStore...');
        try {
          await get().initialize();
          return get()._zkService !== null;
        } catch (error) {
          console.error('[Shielded] Failed to initialize:', error);
          return false;
        }
      },

      // Refresh shielded balance from ZK service
      refreshBalance: async () => {
        // Try to ensure initialized first
        await get().ensureInitialized();

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
        // Ensure ZK service is initialized (handles app restart case)
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized. Please restart the app.');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        const txId = generateUUID();
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

          // Sync notes from ZK service
          const zkNotes = _zkService.getNotes();
          const serializedNotes: ShieldedNote[] = zkNotes.map(note => ({
            amount: note.amount.toString(),
            commitment: note.commitment.toString(),
            leafIndex: note.leafIndex,
            createdAt: Date.now(),
          }));

          set(state => ({
            shieldedBalance: newBalance,
            notes: serializedNotes,
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
        // Ensure ZK service is initialized (handles app restart case)
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized. Please restart the app.');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        const txId = generateUUID();
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
          // Update status to submitting
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

          // Sync notes from ZK service
          const zkNotes = _zkService.getNotes();
          const serializedNotes: ShieldedNote[] = zkNotes.map(note => ({
            amount: note.amount.toString(),
            commitment: note.commitment.toString(),
            leafIndex: note.leafIndex,
            createdAt: Date.now(),
          }));

          set(state => ({
            shieldedBalance: newBalance,
            notes: serializedNotes,
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

      // Transfer shielded tokens using PRIVATE TRANSFER via relayer
      // This automatically routes through the relayer for sender privacy
      transfer: async (recipient: string, amount: number, walletPublicKey: PublicKey, signTransaction) => {
        // Ensure ZK service is initialized (handles app restart case)
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized. Please restart the app.');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        const txId = generateUUID();
        const amountLamports = BigInt(Math.floor(amount * 1e9));

        // Parse recipient ZK address to extract viewing/spending keys
        if (!recipient.startsWith('zk:')) {
          throw new Error('Invalid ZK address format. Must start with "zk:"');
        }

        const combined = Buffer.from(recipient.slice(3), 'base64');
        const receivingPubkeyBytes = combined.slice(0, 32);
        const viewingKeyBytes = combined.slice(32, 64);

        // Convert receiving pubkey bytes to Ed25519 public key for stealth address derivation
        const { Keypair: SolKeypair } = await import('@solana/web3.js');
        const recipientSpendingPubKey = SolKeypair.fromSeed(receivingPubkeyBytes).publicKey.toBase58();
        const recipientViewingPubKey = SolKeypair.fromSeed(viewingKeyBytes).publicKey.toBase58();

        // Derive X25519 public key from raw viewing key bytes
        // MUST match scanner's derivation: nacl.hash(viewingSeed).slice(0, 32) → X25519 secret → public key
        const viewingX25519Secret = nacl.hash(new Uint8Array(viewingKeyBytes)).slice(0, 32);
        const recipientViewingX25519Pub = nacl.box.keyPair.fromSecretKey(viewingX25519Secret).publicKey;

        console.log('[Private Transfer] Using automatic privacy via relayer');
        console.log('[Private Transfer] Amount:', amount, 'SOL');

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
          // Step 1: Generate stealth address for recipient
          const { generateStealthAddress } = await import('../utils/crypto/stealth');
          const stealth = await generateStealthAddress(recipientSpendingPubKey, recipientViewingPubKey, recipientViewingX25519Pub);
          console.log('[Private Transfer] Generated stealth address:', stealth.address.slice(0, 16) + '...');

          // Step 2: Generate ZK proof showing we have funds
          // Use the unshield proof generation (proves ownership, creates nullifier)
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'generating_proof' } : tx
            ),
          }));

          const proofData = await _zkService.generateTransferProofForRelayer(amountLamports);
          console.log('[Private Transfer] Proof generated');

          // Step 3: Fund the relayer (amount + fee + gas)
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          const RELAYER_URL = process.env.EXPO_PUBLIC_RELAYER_URL || 'https://corps-mag-distributed-ref.trycloudflare.com';

          // Fetch relayer info to get fee and wallet address
          let relayerAddress: string;
          let feeBps: number;
          try {
            const infoRes = await fetch(`${RELAYER_URL}/health`);
            const info = await infoRes.json();
            relayerAddress = info.relayer;
            feeBps = info.feeBps || 50;
          } catch {
            // Fallback
            const infoRes = await fetch(`${RELAYER_URL}/info`);
            const info = await infoRes.json();
            relayerAddress = info.relayer;
            feeBps = info.feeBps || 50;
          }

          const feeLamports = BigInt(Math.ceil(Number(amountLamports) * feeBps / 10000));
          const rentExempt = BigInt(890880); // Minimum balance for rent exemption
          const gasEstimate = BigInt(10000); // ~0.00001 SOL for tx fees
          const totalFunding = amountLamports + feeLamports + gasEstimate + rentExempt;

          console.log('[Private Transfer] Funding relayer:', relayerAddress);
          console.log('[Private Transfer] Amount:', Number(amountLamports) / 1e9, 'SOL + Fee:', Number(feeLamports) / 1e9, 'SOL + Gas:', Number(gasEstimate) / 1e9, 'SOL + Rent:', Number(rentExempt) / 1e9, 'SOL');
          console.log('[Private Transfer] Total funding:', Number(totalFunding) / 1e9, 'SOL');

          // Send funding tx: User → Relayer
          const { Connection, PublicKey: SolPubKey, Transaction: SolTx, SystemProgram: SolSystem } = await import('@solana/web3.js');
          const conn = new Connection(process.env.EXPO_PUBLIC_SOLANA_NETWORK === 'mainnet-beta'
            ? 'https://api.mainnet-beta.solana.com'
            : 'https://api.devnet.solana.com', 'confirmed');

          const fundingTx = new SolTx().add(
            SolSystem.transfer({
              fromPubkey: walletPublicKey,
              toPubkey: new SolPubKey(relayerAddress),
              lamports: Number(totalFunding),
            })
          );
          fundingTx.feePayer = walletPublicKey;
          fundingTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

          const signedFundingTx = await signTransaction(fundingTx);
          const fundingSignature = await conn.sendRawTransaction(signedFundingTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          });
          await conn.confirmTransaction(fundingSignature, 'confirmed');

          console.log('[Private Transfer] Funding tx confirmed:', fundingSignature);

          // Step 4: Send proof + funding signature to relayer
          console.log('[Private Transfer] Sending proof to relayer:', RELAYER_URL);

          const response = await fetch(`${RELAYER_URL}/relay/private-transfer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              proof: proofData.proof,
              publicSignals: proofData.publicSignals,
              nullifier: proofData.nullifier,
              stealthAddress: stealth.address,
              ephemeralPublicKey: stealth.ephemeralPublicKey,
              viewTag: stealth.viewTag,
              amountLamports: amountLamports.toString(),
              fundingTxSignature: fundingSignature,
            }),
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Private transfer failed');
          }

          const result = await response.json();
          console.log('[Private Transfer] Relayer response:', result);

          // Step 4: Update local state - mark note as spent
          await _zkService.markNoteSpent(proofData.nullifier);

          const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;
          const zkNotes = _zkService.getNotes();
          const serializedNotes: ShieldedNote[] = zkNotes.map(note => ({
            amount: note.amount.toString(),
            commitment: note.commitment.toString(),
            leafIndex: note.leafIndex,
            createdAt: Date.now(),
          }));

          set(state => ({
            shieldedBalance: newBalance,
            notes: serializedNotes,
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'confirmed', signature: result.signature } : tx
            ),
          }));

          setTimeout(() => {
            set(state => ({
              pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
            }));
          }, 5000);

          console.log('[Private Transfer] SUCCESS - Sender hidden, recipient at stealth address');
          console.log('[Private Transfer] On-chain shows: Relayer →', stealth.address.slice(0, 16) + '...');
          return result.signature;

        } catch (error) {
          console.error('[Private Transfer] Error:', error);

          // Fallback to direct transfer if relayer fails
          console.log('[Private Transfer] Falling back to direct transfer...');

          try {
            // Parse ZK address again for direct transfer
            let receivingPubkey = BigInt(0);
            for (let i = receivingPubkeyBytes.length - 1; i >= 0; i--) {
              receivingPubkey = (receivingPubkey << BigInt(8)) + BigInt(receivingPubkeyBytes[i]);
            }

            const zkRecipient: ZkAddress = {
              receivingPubkey,
              viewingKey: viewingKeyBytes,
              encoded: recipient,
            };

            const signature = await _zkService.transfer(
              zkRecipient,
              amountLamports,
              walletPublicKey,
              signTransaction
            );

            const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;
            const zkNotes = _zkService.getNotes();
            const serializedNotes: ShieldedNote[] = zkNotes.map(note => ({
              amount: note.amount.toString(),
              commitment: note.commitment.toString(),
              leafIndex: note.leafIndex,
              createdAt: Date.now(),
            }));

            set(state => ({
              shieldedBalance: newBalance,
              notes: serializedNotes,
              pendingTransactions: state.pendingTransactions.map(tx =>
                tx.id === txId ? { ...tx, status: 'confirmed', signature } : tx
              ),
            }));

            setTimeout(() => {
              set(state => ({
                pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
              }));
            }, 5000);

            console.log('[Private Transfer] Fallback successful (sender visible):', signature);
            return signature;
          } catch (fallbackError) {
            console.error('[Private Transfer] Fallback also failed:', fallbackError);
            set(state => ({
              pendingTransactions: state.pendingTransactions.map(tx =>
                tx.id === txId
                  ? { ...tx, status: 'failed', error: (error as Error).message }
                  : tx
              ),
            }));
            throw error;
          }
        }
      },

      // Scan for incoming notes on the blockchain
      scanNotes: async () => {
        // Try to ensure initialized first
        await get().ensureInitialized();

        const { _zkService } = get();
        if (!_zkService) return;

        set({ isLoading: true });

        try {
          // Get last scanned position
          const lastSignature = await _zkService.getLastScannedSignature();

          // Scan blockchain for incoming shielded notes
          const { found, newBalance } = await _zkService.scanIncomingNotes(lastSignature);

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

      // Import a note received from another user
      importNote: async (noteString: string) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not available');
        }

        set({ isLoading: true });

        try {
          const note = await _zkService.importNote(noteString);
          const amountSOL = Number(note.amount) / 1e9;

          // Refresh balance
          await get().refreshBalance();

          console.log('[Shielded] Imported note:', amountSOL, 'SOL');
        } finally {
          set({ isLoading: false });
        }
      },

      // Get the last sent note for sharing with recipient
      getLastSentNote: () => {
        const { _zkService } = get();
        if (!_zkService) return null;

        const lastNote = _zkService.getLastSentNote();
        if (!lastNote) return null;

        return {
          noteString: lastNote.noteString,
          amount: Number(lastNote.amount) / 1e9,
          leafIndex: lastNote.leafIndex,
        };
      },

      // Clear all notes (for when notes become unrecoverable)
      clearNotes: async () => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not available');
        }

        await _zkService.clearNotes();
        set({ shieldedBalance: 0, notes: [] });
        console.log('[Shielded] Notes cleared');
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

      // Get stealth keys for receiving anonymous payments
      getStealthKeys: () => {
        const { _zkService } = get();
        if (!_zkService) {
          return null;
        }
        try {
          return _zkService.getStealthKeys();
        } catch (e) {
          console.error('[Shielded] Failed to get stealth keys:', e);
          return null;
        }
      },

      // Unshield to a stealth address for maximum privacy
      unshieldStealth: async (
        amount: number,
        recipientSpendingPubKey: string,
        recipientViewingPubKey: string,
        walletPublicKey: PublicKey,
        signTransaction: (tx: Transaction) => Promise<Transaction>
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          throw new Error('ZK service not initialized');
        }

        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not available');
        }

        set({ isLoading: true });
        const txId = generateUUID();

        try {
          // Add pending transaction
          const pendingTx: PendingTransaction = {
            id: txId,
            type: 'unshield',
            amount,
            createdAt: Date.now(),
            status: 'generating_proof',
          };
          set(state => ({
            pendingTransactions: [...state.pendingTransactions, pendingTx],
          }));

          // Perform stealth unshield
          const amountLamports = BigInt(Math.floor(amount * 1e9));
          const result = await _zkService.unshieldStealth(
            recipientSpendingPubKey,
            recipientViewingPubKey,
            amountLamports,
            walletPublicKey,
            signTransaction
          );

          // Update pending transaction
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'confirmed' as const, signature: result.signature } : tx
            ),
          }));

          // Refresh balance
          await get().refreshBalance();

          // Remove pending after delay
          setTimeout(() => {
            set(state => ({
              pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
            }));
          }, 3000);

          return {
            signature: result.signature,
            stealthAddress: result.stealthAddress,
            ephemeralPublicKey: result.ephemeralPublicKey,
            viewTag: result.viewTag,
          };
        } catch (e) {
          // Update pending transaction with error
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'failed' as const, error: (e as Error).message } : tx
            ),
          }));
          throw e;
        } finally {
          set({ isLoading: false });
        }
      },

      // TRUE ZK: Private send via relayer (anonymizing relay)
      // Sender hidden (relayer sends), recipient hidden (stealth address), amount hidden (fixed denominations)
      privateSend: async (
        recipientStealthKeys: string,
        denominationIndex: number,
        walletPublicKey: PublicKey,
        signTransaction: (tx: Transaction) => Promise<Transaction>
      ) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          return { success: false, error: 'ZK service not initialized' };
        }

        const { _zkService } = get();
        if (!_zkService) {
          return { success: false, error: 'ZK service not available' };
        }

        const DENOMINATIONS = [0.1, 1, 10]; // SOL
        if (denominationIndex < 0 || denominationIndex >= DENOMINATIONS.length) {
          return { success: false, error: 'Invalid denomination' };
        }

        const amount = DENOMINATIONS[denominationIndex];
        const txId = generateUUID();

        set({ isLoading: true });
        set(state => ({
          pendingTransactions: [
            ...state.pendingTransactions,
            {
              id: txId,
              type: 'transfer' as const,
              amount,
              status: 'generating_proof' as const,
              createdAt: Date.now(),
            },
          ],
        }));

        try {
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' as const } : tx
            ),
          }));

          const result = await _zkService.privateSend(
            recipientStealthKeys,
            denominationIndex,
            walletPublicKey,
            signTransaction
          );

          if (result.success) {
            // Refresh balance
            const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;
            set(state => ({
              shieldedBalance: newBalance,
              pendingTransactions: state.pendingTransactions.map(tx =>
                tx.id === txId ? { ...tx, status: 'confirmed' as const, signature: result.txSignature } : tx
              ),
            }));

            setTimeout(() => {
              set(state => ({
                pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
              }));
            }, 5000);
          } else {
            set(state => ({
              pendingTransactions: state.pendingTransactions.map(tx =>
                tx.id === txId ? { ...tx, status: 'failed' as const, error: result.error } : tx
              ),
            }));
          }

          return result;
        } catch (e) {
          const error = (e as Error).message;
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'failed' as const, error } : tx
            ),
          }));
          return { success: false, error };
        } finally {
          set({ isLoading: false });
        }
      },

      // Scan for stealth payments sent to our addresses
      scanStealthPayments: async () => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          return { found: 0, amount: 0, payments: [] };
        }

        const { _zkService } = get();
        if (!_zkService) {
          return { found: 0, amount: 0, payments: [] };
        }

        console.log('[Store] Scanning for stealth payments...');
        const result = await _zkService.scanStealthPayments();
        console.log('[Store] Scan result:', result.found, 'payments,', result.amount, 'SOL');
        return result;
      },

      // Get pending stealth payments that can be swept
      getPendingStealthPayments: () => {
        const { _zkService } = get();
        if (!_zkService) {
          return [];
        }
        return _zkService.getPendingStealthPayments();
      },

      // Sweep a single stealth payment to recipient address
      sweepStealthPayment: async (stealthAddress: string, recipientAddress: string) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          return { success: false, error: 'ZK service not initialized' };
        }

        const { _zkService } = get();
        if (!_zkService) {
          return { success: false, error: 'ZK service not available' };
        }

        console.log('[Store] Sweeping stealth payment from', stealthAddress.slice(0, 16) + '...');
        return await _zkService.sweepStealthPayment(stealthAddress, recipientAddress);
      },

      // Sweep all pending stealth payments
      sweepAllStealthPayments: async (recipientAddress: string) => {
        const initialized = await get().ensureInitialized();
        if (!initialized) {
          return { success: false, swept: 0, totalAmount: 0, signatures: [], errors: ['ZK service not initialized'] };
        }

        const { _zkService } = get();
        if (!_zkService) {
          return { success: false, swept: 0, totalAmount: 0, signatures: [], errors: ['ZK service not available'] };
        }

        console.log('[Store] Sweeping all stealth payments to', recipientAddress.slice(0, 16) + '...');
        return await _zkService.sweepAllStealthPayments(recipientAddress);
      },
    }),
    {
      name: 'p01-shielded-mobile',
      version: 2, // Increment when data format changes
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        isInitialized: state.isInitialized,
        zkAddress: state.zkAddress,
        shieldedBalance: state.shieldedBalance,
        notes: state.notes,
        lastSyncedIndex: state.lastSyncedIndex,
        merkleRoot: state.merkleRoot,
      }),
      // Migration: reset on version change (key derivation fix)
      migrate: (persistedState: any, version: number) => {
        console.log('[Shielded] Migration check: stored version', version, '-> current version 2');
        if (version < 2) {
          console.log('[Shielded] Resetting shielded wallet due to key derivation fix');
          // Also clear ZK service SecureStore notes (async, fire-and-forget)
          ZkService.resetStorage().catch(err =>
            console.error('[Shielded] Failed to reset ZK storage:', err)
          );
          // Return fresh state - old notes are incompatible
          return {
            isInitialized: false,
            isLoading: false,
            shieldedBalance: 0,
            notes: [],
            zkAddress: null,
            pendingTransactions: [],
            lastSyncedIndex: 0,
            merkleRoot: null,
            _zkService: null,
          };
        }
        return persistedState;
      },
    }
  )
);
