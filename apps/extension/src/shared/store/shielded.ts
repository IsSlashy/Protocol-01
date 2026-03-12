import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { PublicKey, Transaction, Keypair, SystemProgram } from '@solana/web3.js';
import { getZkServiceExtension, ZkServiceExtension, ZkAddress, RecipientNoteData } from '../services/zk';
import { getConnection } from '../services/wallet';
import { useWalletStore, getPrivySigner } from './wallet';
import {
  encryptForSession,
  decryptFromSession,
  isEncryptedBlob,
  getSessionPassword,
} from '../services/sessionCrypto';
import nacl from 'tweetnacl';

// ============= SPECTER SDK STEALTH IMPORTS =============
import {
  deriveSharedSecret,
  computeViewTag,
  generateEphemeralKeypair,
} from '@p01/specter-sdk';
import { sha256 } from '@noble/hashes/sha256';

// ============= STEALTH ADDRESS UTILITIES (Unified SDK v2 + Legacy v1) =============

/**
 * Convert Uint8Array to hex string (kept for v1 legacy compat)
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// V1 LEGACY helpers -- kept ONLY for backward-compatible scanning of old
// stealth payments that were created before the SDK unification.
// No new addresses should ever be generated with these functions.
// ---------------------------------------------------------------------------

/**
 * SHA256 hash of hex-encoded data (legacy v1 -- matches old mobile expo-crypto behavior)
 */
async function sha256HexLegacy(data: Uint8Array): Promise<Uint8Array> {
  const hexString = bytesToHex(data);
  const encoder = new TextEncoder();
  const hexBytes = encoder.encode(hexString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', hexBytes as unknown as ArrayBuffer);
  return new Uint8Array(hashBuffer);
}

/**
 * V1 Legacy: Derive stealth seed using old SHA-256-of-hex algorithm
 */
async function deriveStealthSeedV1(
  spendingPrivateKey: Uint8Array,
  sharedSecret: Uint8Array
): Promise<Uint8Array> {
  const derivationBytes = await sha256HexLegacy(sharedSecret);
  const spendingSeed = spendingPrivateKey.slice(0, 32);
  const combined = new Uint8Array(64);
  combined.set(spendingSeed);
  combined.set(derivationBytes);
  return await sha256HexLegacy(combined);
}

/**
 * V1 Legacy: Generate view tag using old hex + 'view_tag' algorithm
 * Returns a 4-char hex string (2 bytes)
 */
async function generateViewTagV1(sharedSecret: Uint8Array): Promise<string> {
  const hexString = bytesToHex(sharedSecret) + 'view_tag';
  const encoder = new TextEncoder();
  const input = encoder.encode(hexString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', input as unknown as ArrayBuffer);
  const hash = new Uint8Array(hashBuffer);
  return bytesToHex(hash.slice(0, 2));
}

/**
 * V1 Legacy: Scan a stealth payment using old algorithm.
 * Only used as fallback when the SDK (v2) scan does not match.
 */
async function scanStealthPaymentV1(
  ephemeralPublicKey: string,
  viewingPrivateKey: Uint8Array,
  spendingPrivateKey: Uint8Array,
  expectedViewTag?: string
): Promise<{ found: boolean; stealthAddress?: string; privateKey?: Uint8Array }> {
  try {
    let ephemeralX25519Public: Uint8Array;
    try {
      const decoded = new Uint8Array(Buffer.from(ephemeralPublicKey, 'base64'));
      if (decoded.length === 32) {
        ephemeralX25519Public = decoded;
      } else {
        throw new Error('Invalid length');
      }
    } catch {
      return { found: false };
    }

    // V1 used nacl.hash(viewingSeed).slice(0,32) to get X25519 secret
    const viewingSeed = viewingPrivateKey.slice(0, 32);
    const viewingX25519Secret = nacl.hash(viewingSeed).slice(0, 32);

    // nacl.box.before is equivalent to nacl.scalarMult for shared secret
    const sharedSecret = nacl.box.before(ephemeralX25519Public, viewingX25519Secret);

    if (expectedViewTag) {
      const computedViewTag = await generateViewTagV1(sharedSecret);
      if (computedViewTag !== expectedViewTag) {
        return { found: false };
      }
    }

    const stealthPrivateKeySeed = await deriveStealthSeedV1(spendingPrivateKey, sharedSecret);
    const stealthKeypair = Keypair.fromSeed(stealthPrivateKeySeed);

    return {
      found: true,
      stealthAddress: stealthKeypair.publicKey.toBase58(),
      privateKey: stealthKeypair.secretKey,
    };
  } catch (error) {
    console.error('[Stealth] V1 scan failed:', error);
    return { found: false };
  }
}

// ---------------------------------------------------------------------------
// V2 (SDK-backed) stealth functions -- used for ALL new stealth addresses
// Uses specter-sdk's deriveSharedSecret (nacl.scalarMult), sha256 from
// @noble/hashes, and computeViewTag (first byte of sha256).
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded ephemeral public key to Uint8Array.
 * Returns null if decoding fails or length is not 32 bytes.
 */
function decodeEphemeralPubKey(encoded: string): Uint8Array | null {
  try {
    const decoded = new Uint8Array(Buffer.from(encoded, 'base64'));
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Derive the X25519 viewing secret key from the raw viewing key bytes.
 * Matches the ZK service's key derivation: nacl.hash(seed).slice(0,32)
 */
function deriveViewingX25519Secret(viewingKeyBytes: Uint8Array): Uint8Array {
  const seed = viewingKeyBytes.slice(0, 32);
  return nacl.hash(seed).slice(0, 32);
}

/**
 * V2 SDK: Derive stealth private key from spending key + shared secret.
 * Uses sha256 of raw bytes (not hex encoding) and byte-wise modular addition.
 * Matches specter-sdk/src/utils/crypto.ts deriveStealthPrivateKey exactly.
 */
function deriveStealthSeedV2(
  spendingPrivateKey: Uint8Array,
  sharedSecret: Uint8Array
): Uint8Array {
  const hashedSecret = sha256(sharedSecret);
  const spendingSeed = spendingPrivateKey.slice(0, 32);
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    result[i] = (spendingSeed[i]! + hashedSecret[i]!) % 256;
  }
  return result;
}

/**
 * V2 SDK: Derive the expected stealth public key for verification.
 * Uses the same addPublicKeys logic from the SDK's derive.ts.
 */
function deriveStealthPubKeyV2(
  spendingPubKey: Uint8Array,
  sharedSecret: Uint8Array
): Uint8Array {
  const hashedSecret = sha256(sharedSecret);

  // Generate scalar*G (the point corresponding to the hashed secret)
  const scalarKeypair = nacl.sign.keyPair.fromSeed(hashedSecret);
  const scalarPoint = scalarKeypair.publicKey;

  // XOR-based combination then hash (matches SDK's addPublicKeys)
  const xored = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    xored[i] = spendingPubKey[i]! ^ scalarPoint[i]!;
  }

  return sha256(xored);
}

/**
 * Scan a stealth payment using the SDK's v2 algorithm.
 * Tries v2 first; if the derived address does not match the expected stealth
 * address, falls back to v1 legacy for backward compatibility.
 */
async function scanStealthPayment(
  ephemeralPublicKey: string,
  viewingPrivateKey: Uint8Array,
  spendingPrivateKey: Uint8Array,
  expectedViewTag?: string
): Promise<{ found: boolean; stealthAddress?: string; privateKey?: Uint8Array }> {
  try {
    const ephemeralPubBytes = decodeEphemeralPubKey(ephemeralPublicKey);
    if (!ephemeralPubBytes) {
      return { found: false };
    }

    // Derive X25519 viewing secret
    const viewingX25519Secret = deriveViewingX25519Secret(viewingPrivateKey);

    // --- V2 (SDK) path ---
    // Compute shared secret using SDK's deriveSharedSecret (nacl.scalarMult)
    const sharedSecret = deriveSharedSecret(viewingX25519Secret, ephemeralPubBytes);

    // Quick rejection via view tag (SDK: first byte of sha256)
    const sdkViewTag = computeViewTag(sharedSecret);

    // The view tag format differs between v1 (4-char hex string) and v2 (number 0-255).
    // If expectedViewTag is provided we need to check both formats.
    let v2ViewTagMatch = true;
    if (expectedViewTag !== undefined) {
      // v2 format: view tag stored as decimal number string or as a number
      const expectedAsNumber = Number(expectedViewTag);
      if (!isNaN(expectedAsNumber) && expectedAsNumber === sdkViewTag) {
        v2ViewTagMatch = true;
      } else {
        // May be v1 hex format -- v2 won't match, skip to v1 fallback
        v2ViewTagMatch = false;
      }
    }

    if (v2ViewTagMatch) {
      // Derive stealth private key using v2 algorithm
      const stealthSeed = deriveStealthSeedV2(spendingPrivateKey, sharedSecret);
      const seedKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);
      const stealthKeypair = Keypair.fromSecretKey(seedKeypair.secretKey);

      return {
        found: true,
        stealthAddress: stealthKeypair.publicKey.toBase58(),
        privateKey: stealthKeypair.secretKey,
      };
    }

    // --- V1 Legacy fallback ---
    return await scanStealthPaymentV1(
      ephemeralPublicKey,
      viewingPrivateKey,
      spendingPrivateKey,
      expectedViewTag
    );
  } catch (error) {
    console.error('[Stealth] Scan failed:', error);
    // Last-resort: try v1 legacy
    try {
      return await scanStealthPaymentV1(
        ephemeralPublicKey,
        viewingPrivateKey,
        spendingPrivateKey,
        expectedViewTag
      );
    } catch {
      return { found: false };
    }
  }
}

/**
 * Generate a stealth address for a recipient from their ZK address.
 * Uses the SDK's v2 algorithm (X25519 ECDH + sha256 of raw bytes).
 *
 * @param ownerPubkeyBytes - First 32 bytes of recipient's ZK address
 * @param viewingKeyBytes  - Last 32 bytes of recipient's ZK address
 */
async function generateStealthAddressForRecipient(
  ownerPubkeyBytes: Uint8Array,
  viewingKeyBytes: Uint8Array
): Promise<{ address: string; ephemeralPublicKey: string; viewTag: string }> {
  // 1. Generate ephemeral X25519 keypair via SDK
  const ephemeralKeypair = generateEphemeralKeypair();

  // 2. Derive recipient's X25519 viewing public key
  const viewingX25519Secret = deriveViewingX25519Secret(viewingKeyBytes);
  const recipientX25519Public = nacl.box.keyPair.fromSecretKey(viewingX25519Secret).publicKey;

  // 3. Compute shared secret via SDK (nacl.scalarMult)
  const sharedSecret = deriveSharedSecret(ephemeralKeypair.secretKey, recipientX25519Public);

  // 4. Compute view tag via SDK (first byte of sha256)
  const viewTag = computeViewTag(sharedSecret);

  // 5. Derive stealth public key using SDK-compatible algorithm
  const recipientSpendingKeypair = Keypair.fromSeed(ownerPubkeyBytes);
  const spendingPubBytes = recipientSpendingKeypair.publicKey.toBytes();
  const stealthPubKeyBytes = deriveStealthPubKeyV2(spendingPubBytes, sharedSecret);

  // Create stealth keypair from the derived public key seed
  const stealthKeypair = Keypair.fromSeed(stealthPubKeyBytes);

  // 6. Encode ephemeral X25519 public key as base64
  const ephemeralPubKeyBase64 = btoa(String.fromCharCode(...ephemeralKeypair.publicKey));

  return {
    address: stealthKeypair.publicKey.toBase58(),
    ephemeralPublicKey: ephemeralPubKeyBase64,
    viewTag: viewTag.toString(),
  };
}

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
  _seedPhrase: string | null;
  _foundStealthPayments: Array<{
    stealthAddress: string;
    privateKey: Uint8Array;
    amount: number;
    signature: string;
    ephemeralPublicKey: string;
  }>;

  // Actions - Simplified interface (gets wallet data internally)
  initialize: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  shield: (amount: number) => Promise<string>;
  unshield: (amount: number) => Promise<string>;
  transfer: (recipient: string, amount: number) => Promise<{ signature: string; recipientNote: RecipientNoteData }>;
  scanNotes: () => Promise<void>;
  exportNotes: () => string;
  importNotes: (jsonData: string) => Promise<{ imported: number; skipped: number }>;
  syncFromBlockchain: () => Promise<{ success: boolean; localRoot: string; onChainRoot: string }>;
  clearNotes: () => Promise<void>;
  reset: () => void;

  // Stealth payment recovery
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

/**
 * Helper to get wallet data from wallet store
 * Supports both legacy (keypair) and Privy (signer) wallets
 */
function getWalletData() {
  const walletState = useWalletStore.getState();
  const privySigner = getPrivySigner();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  // For Privy wallets, we need privySigner; for legacy wallets, we need _keypair
  if (walletState.isPrivyWallet) {
    if (!privySigner) {
      throw new Error('Privy signer not available. Please reconnect your wallet.');
    }
  } else {
    if (!walletState._keypair) {
      throw new Error('Wallet not unlocked. Please unlock your wallet first.');
    }
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const keypair = walletState._keypair; // May be null for Privy wallets
  const network = walletState.network;
  const connection = getConnection(network);

  // Sign transaction function - use Privy signer or keypair
  const signTransaction = async (tx: Transaction): Promise<Transaction> => {
    if (walletState.isPrivyWallet && privySigner) {
      return await privySigner(tx);
    } else if (keypair) {
      tx.sign(keypair);
      return tx;
    }
    throw new Error('No signing method available');
  };

  return { walletPublicKey, keypair, connection, signTransaction, network };
}

// Storage key for Privy users' ZK seed
const PRIVY_ZK_SEED_KEY = 'p01_privy_zk_seed';

/**
 * Helper to get or generate ZK seed for Privy wallets.
 * The seed is encrypted at rest with the user's session password via
 * AES-256-GCM so it never sits in chrome.storage.local as plaintext.
 *
 * Backward compatibility: if a legacy plaintext hex seed is found, it is
 * transparently migrated to the encrypted format on first access.
 */
async function getOrCreatePrivyZkSeed(walletAddress: string): Promise<string> {
  const storageKey = `${PRIVY_ZK_SEED_KEY}_${walletAddress}`;
  const password = getSessionPassword();

  try {
    // Try to retrieve existing seed
    const result = await chrome.storage.local.get(storageKey);
    const stored = result[storageKey];

    if (stored) {
      if (isEncryptedBlob(stored)) {
        // New encrypted format
        if (!password) {
          throw new Error('Wallet must be unlocked to access ZK seed');
        }
        return await decryptFromSession(stored, password);
      }

      // Legacy plaintext hex -- migrate to encrypted
      if (typeof stored === 'string') {
        console.warn('[Shielded] Migrating legacy plaintext Privy ZK seed to encrypted');
        if (password) {
          const encryptedBlob = await encryptForSession(stored, password);
          await chrome.storage.local.set({ [storageKey]: encryptedBlob });
          console.log('[Shielded] Privy ZK seed migration complete');
        }
        return stored;
      }
    }

    // Generate new seed (32 random bytes as hex)
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const seedHex = Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Store encrypted — require session password to protect ZK seed at rest
    if (password) {
      const encryptedBlob = await encryptForSession(seedHex, password);
      await chrome.storage.local.set({ [storageKey]: encryptedBlob });
    } else {
      // No session password — store in session-only storage (cleared on restart)
      // NEVER store ZK seed plaintext in persistent chrome.storage.local
      console.warn('[Shielded] No session password — ZK seed stored in memory only (will not persist)');
      // Seed lives only in the returned value; callers should cache in-memory
    }

    return seedHex;
  } catch (e) {
    console.error('[Shielded] Failed to get/create Privy ZK seed:', e);
    throw new Error('Failed to initialize ZK keys for Privy wallet');
  }
}

/**
 * Helper to get seed phrase from wallet store (requires decryption)
 * For Privy wallets, generates/retrieves a separate ZK seed
 */
async function getSeedPhrase(): Promise<string> {
  const walletState = useWalletStore.getState();

  // For Privy wallets, use a separate stored ZK seed
  if (walletState.isPrivyWallet) {
    if (!walletState.publicKey) {
      throw new Error('Privy wallet not initialized');
    }
    return await getOrCreatePrivyZkSeed(walletState.publicKey);
  }

  // Legacy wallet - derive from keypair
  if (!walletState._keypair) {
    throw new Error('Wallet not unlocked');
  }

  // Use the keypair's secret key as seed for ZK derivation
  // This ensures consistent ZK addresses across sessions
  const secretKey = walletState._keypair.secretKey;
  const seedHex = Array.from(secretKey.slice(0, 32))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return seedHex;
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
      _seedPhrase: null,
      _foundStealthPayments: [],

      // Initialize with real ZK service (simplified - gets wallet data internally)
      initialize: async () => {
        const { isInitialized, _zkService } = get();

        // Already initialized
        if (isInitialized && _zkService) {
          return;
        }

        set({ isLoading: true });

        try {
          // Get wallet data
          const { connection } = getWalletData();
          const seedPhrase = await getSeedPhrase();

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
            _seedPhrase: seedPhrase,
          });

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

      // Shield tokens (simplified - gets wallet data internally)
      shield: async (amount: number) => {
        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized. Please wait for initialization.');
        }

        // Get wallet data
        const { walletPublicKey, signTransaction } = getWalletData();

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

      // Unshield tokens (simplified - recipient defaults to own wallet)
      unshield: async (amount: number) => {
        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized. Please wait for initialization.');
        }

        // Get wallet data - recipient is own wallet by default
        const { walletPublicKey, signTransaction } = getWalletData();

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

          // Call real ZK service - recipient is own wallet
          const signature = await _zkService.unshield(
            walletPublicKey, // recipient
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
      // Routes through relayer for sender privacy, falls back to direct on-chain
      transfer: async (recipient: string, amount: number) => {
        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized. Please wait for initialization.');
        }

        // Get wallet data
        const { walletPublicKey, signTransaction, connection, network } = getWalletData();

        const txId = crypto.randomUUID();
        const amountLamports = BigInt(Math.floor(amount * 1e9));

        // Parse recipient ZK address
        if (!recipient.startsWith('zk:')) {
          throw new Error('Invalid ZK address format. Must start with "zk:"');
        }

        // Decode ZK address
        const combined = Uint8Array.from(atob(recipient.slice(3)), c => c.charCodeAt(0));
        const receivingPubkeyBytes = combined.slice(0, 32);
        const viewingKeyBytes = combined.slice(32, 64);

        // Convert to bigint (LE)
        let receivingPubkey = BigInt(0);
        for (let i = receivingPubkeyBytes.length - 1; i >= 0; i--) {
          receivingPubkey = (receivingPubkey << BigInt(8)) + BigInt(receivingPubkeyBytes[i]);
        }

        const zkRecipient: ZkAddress = {
          receivingPubkey,
          viewingKey: viewingKeyBytes,
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
          // Step 1: Build the transfer transaction via ZK service
          // This generates the proof client-side and builds the full Solana tx
          const transferResult = await _zkService.transfer(
            zkRecipient,
            amountLamports,
            walletPublicKey,
            signTransaction,
          );

          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          // Step 2: Route through decentralized on-chain relay for sender privacy
          // The relay uses an ephemeral keypair — no on-chain link to the user's wallet
          const { relayTransaction } = await import('../services/relay');
          try {
            const serializedTx = new Uint8Array(Buffer.from(transferResult.signature, 'base64'));
            const relaySig = await relayTransaction(
              serializedTx,
              walletPublicKey,
              signTransaction,
              connection,
            );

            const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;
            set(state => ({
              shieldedBalance: newBalance,
              pendingTransactions: state.pendingTransactions.map(tx =>
                tx.id === txId ? { ...tx, status: 'confirmed', signature: relaySig } : tx
              ),
            }));

            setTimeout(() => {
              set(state => ({
                pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
              }));
            }, 5000);

            return { signature: relaySig, recipientNote: {} as RecipientNoteData };
          } catch (relayError) {
            // Relay not available yet (program not deployed) — use direct result
            console.warn('[Private Transfer] On-chain relay unavailable, using direct tx:', relayError);

            const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;
            set(state => ({
              shieldedBalance: newBalance,
              pendingTransactions: state.pendingTransactions.map(tx =>
                tx.id === txId ? { ...tx, status: 'confirmed', signature: transferResult.signature } : tx
              ),
            }));

            setTimeout(() => {
              set(state => ({
                pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
              }));
            }, 5000);

            return transferResult;
          }

        } catch (transferError: any) {
          console.error('[Private Transfer] Failed:', transferError);
          const displayError = transferError?.message?.includes('Insufficient SOL')
            ? transferError.message
            : transferError?.message?.includes('insufficient lamports')
            ? 'Insufficient SOL for transaction fees. Please fund your wallet.'
            : transferError?.message || 'Transfer failed';
          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId
                ? { ...tx, status: 'failed', error: displayError }
                : tx
            ),
          }));
          throw new Error(displayError);
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

          // Update balance from scanned notes
          const balance = Number(newBalance) / 1e9;

          set({
            shieldedBalance: balance,
            lastSyncedIndex: get().lastSyncedIndex + found,
            isLoading: false,
          });

        } catch (error) {
          console.error('[Shielded] Scan notes error:', error);
          // Fall back to just refreshing local balance
          await get().refreshBalance();
        } finally {
          set({ isLoading: false });
        }
      },

      // Export notes for backup
      exportNotes: () => {
        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }
        return _zkService.exportNotes();
      },

      // Import notes from backup
      importNotes: async (jsonData: string) => {
        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        const result = await _zkService.importNotes(jsonData);

        // Refresh balance after import
        const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;
        const notes = _zkService.getNotes();

        set({
          shieldedBalance: newBalance,
          notes: notes.map(note => ({
            amount: note.amount.toString(),
            commitment: note.commitment.toString(),
            leafIndex: note.leafIndex,
            createdAt: Date.now(),
          })),
        });

        return result;
      },

      // Sync Merkle tree from blockchain
      syncFromBlockchain: async () => {
        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        set({ isLoading: true });

        try {
          const result = await _zkService.syncFromBlockchain();

          if (result.success) {
            // Refresh balance after sync
            const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;
            const notes = _zkService.getNotes();

            set({
              shieldedBalance: newBalance,
              merkleRoot: result.localRoot,
              notes: notes.map(note => ({
                amount: note.amount.toString(),
                commitment: note.commitment.toString(),
                leafIndex: note.leafIndex,
                createdAt: Date.now(),
              })),
              isLoading: false,
            });
          } else {
            set({ isLoading: false });
          }

          return result;
        } catch (error) {
          console.error('[Shielded] Sync from blockchain error:', error);
          set({ isLoading: false });
          throw error;
        }
      },

      // Clear notes but keep tree intact
      clearNotes: async () => {
        const { _zkService } = get();
        if (!_zkService) {
          throw new Error('ZK service not initialized');
        }

        await _zkService.clearNotes();

        set({
          shieldedBalance: 0,
          notes: [],
        });

      },

      // ============= STEALTH PAYMENT RECOVERY =============

      // Scan for stealth payments directly from Solana (no relayer)
      scanStealthPayments: async () => {
        const { isInitialized, _zkService } = get();
        if (!isInitialized || !_zkService) {
          return { found: 0, amount: 0, payments: [] };
        }

        try {
          // Scan on-chain transactions directly — no relayer dependency.
          // Uses the SDK's StealthIndexer for batched signature fetching,
          // view-tag quick-rejection, and instruction data parsing.
          const { scanForPayments } = await import('@p01/specter-sdk');
          const { network: net } = getWalletData();
          const conn = getConnection(net);

          const stealthKeys = _zkService.getStealthKeys();
          if (!stealthKeys) {
            console.warn('[Shielded] Stealth keys not available');
            return { found: 0, amount: 0, payments: [] };
          }

          const onChainPayments = await scanForPayments(
            conn,
            stealthKeys.viewingKey,
            stealthKeys.spendingKey,
            { limit: 100 }
          );

          // Convert SDK StealthPayment format to the legacy format used below
          const payments = onChainPayments.map(p => ({
            ephemeralPublicKey: Buffer.from(p.ephemeralPubKey).toString('base64'),
            viewTag: p.viewTag.toString(),
            stealthAddress: p.stealthAddress.toBase58(),
            signature: p.signature,
          }));

          if (payments.length === 0) {
            return { found: 0, amount: 0, payments: [] };
          }

          // Use the stealth keys already fetched above
          const viewingKey = stealthKeys.viewingKey;
          const spendingKey = stealthKeys.spendingKey;

          // Scan each payment to find ones that belong to us
          let found = 0;
          let totalAmount = 0;
          const foundPayments: Array<{ stealthAddress: string; amount: number; signature: string }> = [];
          const newFoundPayments: Array<{
            stealthAddress: string;
            privateKey: Uint8Array;
            amount: number;
            signature: string;
            ephemeralPublicKey: string;
          }> = [];

          for (const payment of payments) {
            try {
              // Check if we already have this payment in local state
              const existing = get()._foundStealthPayments.find(p => p.signature === payment.signature);
              if (existing) {
                // Verify it still has balance (not already swept)
                const { network: net } = getWalletData();
                const c = getConnection(net);
                const bal = await c.getBalance(new PublicKey(payment.stealthAddress));
                if (bal === 0) {
                  // Already swept — remove from local state
                  set(state => ({
                    _foundStealthPayments: state._foundStealthPayments.filter(p => p.signature !== payment.signature),
                  }));
                  continue;
                }
                foundPayments.push({
                  stealthAddress: payment.stealthAddress,
                  amount: bal / 1e9,
                  signature: payment.signature,
                });
                continue;
              }

              // Try to scan this payment with our keys
              const result = await scanStealthPayment(
                payment.ephemeralPublicKey,
                viewingKey,
                spendingKey,
                payment.viewTag
              );

              if (result.found && result.stealthAddress === payment.stealthAddress && result.privateKey) {
                // Check on-chain balance — skip if already swept
                const { network } = getWalletData();
                const conn = getConnection(network);
                const onChainBalance = await conn.getBalance(new PublicKey(payment.stealthAddress));

                if (onChainBalance === 0) {
                  continue;
                }

                const actualAmount = onChainBalance / 1e9;
                found++;
                totalAmount += actualAmount;

                foundPayments.push({
                  stealthAddress: payment.stealthAddress,
                  amount: actualAmount,
                  signature: payment.signature,
                });

                newFoundPayments.push({
                  stealthAddress: payment.stealthAddress,
                  privateKey: result.privateKey,
                  amount: actualAmount,
                  signature: payment.signature,
                  ephemeralPublicKey: payment.ephemeralPublicKey,
                });
              }
            } catch (e) {
              // Not for us, skip
            }
          }

          // Store found payments
          if (newFoundPayments.length > 0) {
            set(state => ({
              _foundStealthPayments: [...state._foundStealthPayments, ...newFoundPayments],
            }));
          }

          return {
            found,
            amount: totalAmount,
            payments: foundPayments,
          };
        } catch (error) {
          console.error('[Shielded] Stealth scan error:', error);
          return { found: 0, amount: 0, payments: [] };
        }
      },

      // Get pending stealth payments
      getPendingStealthPayments: () => {
        return get()._foundStealthPayments.map(p => ({
          stealthAddress: p.stealthAddress,
          amount: p.amount,
          signature: p.signature,
        }));
      },

      // Sweep a single stealth payment
      sweepStealthPayment: async (stealthAddress: string, recipientAddress: string) => {

        try {
          // Find the stealth payment with private key
          const payment = get()._foundStealthPayments.find(p => p.stealthAddress === stealthAddress);
          if (!payment) {
            return { success: false, error: 'Stealth payment not found. Run scan first.' };
          }

          // Create keypair from the stealth private key
          const stealthKeypair = Keypair.fromSecretKey(payment.privateKey);

          // Verify the keypair matches the stealth address
          if (stealthKeypair.publicKey.toBase58() !== stealthAddress) {
            return { success: false, error: 'Stealth keypair mismatch' };
          }

          // Get connection
          const { network } = getWalletData();
          const connection = getConnection(network);

          // Get balance of stealth address
          const balance = await connection.getBalance(stealthKeypair.publicKey);

          if (balance === 0) {
            return { success: false, error: 'Stealth address has no balance' };
          }

          // Calculate amount to send (balance minus tx fee)
          const txFee = 5000; // 0.000005 SOL
          const amountToSend = balance - txFee;

          if (amountToSend <= 0) {
            return { success: false, error: 'Balance too low to cover transaction fee' };
          }

          // Create transfer transaction
          const recipient = new PublicKey(recipientAddress);
          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: stealthKeypair.publicKey,
              toPubkey: recipient,
              lamports: amountToSend,
            })
          );

          transaction.feePayer = stealthKeypair.publicKey;
          transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
          transaction.sign(stealthKeypair);

          // Send transaction
          const signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          });

          await connection.confirmTransaction(signature, 'confirmed');

          // Remove the swept payment from pending list
          set(state => ({
            _foundStealthPayments: state._foundStealthPayments.filter(p => p.stealthAddress !== stealthAddress),
          }));

          return { success: true, signature };
        } catch (error: any) {
          console.error('[Shielded] Sweep error:', error);
          return { success: false, error: error.message || 'Sweep failed' };
        }
      },

      // Sweep all stealth payments
      sweepAllStealthPayments: async (recipientAddress: string) => {

        const results = {
          success: true,
          swept: 0,
          totalAmount: 0,
          signatures: [] as string[],
          errors: [] as string[],
        };

        const payments = [...get()._foundStealthPayments];

        for (const payment of payments) {
          const result = await get().sweepStealthPayment(payment.stealthAddress, recipientAddress);

          if (result.success && result.signature) {
            results.swept++;
            results.totalAmount += payment.amount;
            results.signatures.push(result.signature);
          } else {
            results.errors.push(`${payment.stealthAddress.slice(0, 16)}...: ${result.error}`);
          }
        }

        if (results.errors.length > 0) {
          results.success = false;
        }

        return results;
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
          _seedPhrase: null,
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
