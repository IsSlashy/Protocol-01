import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { PublicKey, Transaction, Keypair, SystemProgram } from '@solana/web3.js';
import { getZkServiceExtension, ZkServiceExtension, ZkAddress, RecipientNoteData } from '../services/zk';
import { getConnection } from '../services/wallet';
import { useWalletStore, getPrivySigner } from './wallet';
import nacl from 'tweetnacl';

// ============= STEALTH ADDRESS UTILITIES (X25519 ECDH) =============

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA256 hash using Web Crypto API (hashes raw bytes)
 */
async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return new Uint8Array(hashBuffer);
}

/**
 * SHA256 hash of hex string (to match mobile's expo-crypto behavior)
 */
async function sha256Hex(data: Uint8Array): Promise<Uint8Array> {
  const hexString = bytesToHex(data);
  const encoder = new TextEncoder();
  const hexBytes = encoder.encode(hexString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', hexBytes as unknown as ArrayBuffer);
  return new Uint8Array(hashBuffer);
}

/**
 * Compute X25519 shared secret using nacl.box
 */
function computeX25519SharedSecret(mySecretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(theirPublicKey, mySecretKey);
}

/**
 * Derive stealth private key seed for spending
 * Must match mobile's algorithm with derivation hash
 */
async function deriveStealthSeed(
  spendingPrivateKey: Uint8Array,
  sharedSecret: Uint8Array
): Promise<Uint8Array> {
  // Hash the shared secret to get derivation bytes
  const derivationBytes = await sha256Hex(sharedSecret);

  // Combine spending seed + derivation bytes
  const spendingSeed = spendingPrivateKey.slice(0, 32);
  const combined = new Uint8Array(64);
  combined.set(spendingSeed);
  combined.set(derivationBytes);

  // Hash to get stealth seed
  return await sha256Hex(combined);
}

/**
 * Generate view tag for efficient scanning
 * Must match mobile: sha256(hex(sharedSecret) + 'view_tag').slice(0,4)
 */
async function generateViewTag(sharedSecret: Uint8Array): Promise<string> {
  // Mobile does: Crypto.digestStringAsync(SHA256, hexString + 'view_tag')
  const hexString = bytesToHex(sharedSecret) + 'view_tag';
  const encoder = new TextEncoder();
  const input = encoder.encode(hexString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', input as unknown as ArrayBuffer);
  const hash = new Uint8Array(hashBuffer);
  // Return first 4 hex chars (2 bytes)
  return bytesToHex(hash.slice(0, 2));
}

/**
 * Scan a stealth payment to derive the private key
 * Uses X25519 ECDH (matches mobile's fixed algorithm)
 */
async function scanStealthPayment(
  ephemeralPublicKey: string,
  viewingPrivateKey: Uint8Array,
  spendingPrivateKey: Uint8Array,
  expectedViewTag?: string
): Promise<{ found: boolean; stealthAddress?: string; privateKey?: Uint8Array }> {
  try {
    console.log('[Stealth] Scanning with ephemeral:', ephemeralPublicKey.slice(0, 16) + '...');

    // Decode ephemeral X25519 public key
    let ephemeralX25519Public: Uint8Array;
    try {
      // Try as base64 (new format)
      const decoded = new Uint8Array(Buffer.from(ephemeralPublicKey, 'base64'));
      if (decoded.length === 32) {
        ephemeralX25519Public = decoded;
        console.log('[Stealth] Decoded ephemeral as base64 X25519');
      } else {
        throw new Error('Invalid length');
      }
    } catch {
      // Fallback: try as base58 Solana public key (old format - won't work with new algorithm)
      try {
        console.log('[Stealth] Ephemeral appears to be old base58 format - cannot scan with X25519');
        return { found: false };
      } catch {
        console.error('[Stealth] Failed to decode ephemeral public key');
        return { found: false };
      }
    }

    // Convert viewing private key to X25519 format
    // MUST match mobile's getStealthKeys: nacl.hash(viewingKey).slice(0, 32)
    const viewingSeed = viewingPrivateKey.slice(0, 32);
    const viewingX25519Secret = nacl.hash(viewingSeed).slice(0, 32);

    // Compute shared secret using X25519 ECDH
    const sharedSecret = computeX25519SharedSecret(viewingX25519Secret, ephemeralX25519Public);
    console.log('[Stealth] X25519 shared secret computed');

    // Check view tag for quick rejection
    if (expectedViewTag) {
      const computedViewTag = await generateViewTag(sharedSecret);
      console.log('[Stealth] View tag: expected=', expectedViewTag, 'computed=', computedViewTag);
      if (computedViewTag !== expectedViewTag) {
        console.log('[Stealth] View tag mismatch - not for us');
        return { found: false };
      }
    }

    // Derive the stealth seed
    const stealthPrivateKeySeed = await deriveStealthSeed(spendingPrivateKey, sharedSecret);

    // Derive the corresponding keypair
    const stealthKeypair = Keypair.fromSeed(stealthPrivateKeySeed);
    console.log('[Stealth] Derived stealth address:', stealthKeypair.publicKey.toBase58());

    return {
      found: true,
      stealthAddress: stealthKeypair.publicKey.toBase58(),
      privateKey: stealthKeypair.secretKey,
    };
  } catch (error) {
    console.error('[Stealth] Scan failed:', error);
    return { found: false };
  }
}

/**
 * Generate a stealth address for a recipient from their ZK address
 * Uses X25519 ECDH matching the mobile app's algorithm exactly
 *
 * @param ownerPubkeyBytes - First 32 bytes of recipient's ZK address
 * @param viewingKeyBytes - Last 32 bytes of recipient's ZK address
 */
async function generateStealthAddressForRecipient(
  ownerPubkeyBytes: Uint8Array,
  viewingKeyBytes: Uint8Array
): Promise<{ address: string; ephemeralPublicKey: string; viewTag: string }> {
  // 1. Generate ephemeral X25519 keypair
  const ephemeralX25519 = nacl.box.keyPair();

  // 2. Derive recipient's X25519 viewing public key from viewing key bytes
  //    Must match mobile's derivation: nacl.hash(viewingSeed).slice(0, 32)
  const viewingX25519Secret = nacl.hash(viewingKeyBytes).slice(0, 32);
  const recipientX25519Public = nacl.box.keyPair.fromSecretKey(viewingX25519Secret).publicKey;

  // 3. Compute shared secret via X25519 ECDH
  const sharedSecret = computeX25519SharedSecret(ephemeralX25519.secretKey, recipientX25519Public);

  // 4. Generate view tag
  const viewTag = await generateViewTag(sharedSecret);

  // 5. Derive stealth address (must match mobile's deriveStealthPublicKey)
  //    a. Hash shared secret to get derivation bytes
  const derivationBytes = await sha256Hex(sharedSecret);

  //    b. Get recipient's "spending public key" from ownerPubkey bytes
  //       Mobile does: Keypair.fromSeed(ownerPubkeyBytes).publicKey.toBytes()
  const recipientSpendingKeypair = Keypair.fromSeed(ownerPubkeyBytes);
  const spendingPubBytes = recipientSpendingKeypair.publicKey.toBytes();

  //    c. Combine spending pub bytes + derivation bytes
  const combined = new Uint8Array(64);
  combined.set(spendingPubBytes);
  combined.set(derivationBytes);

  //    d. Hash combined to get stealth seed
  const stealthSeed = await sha256Hex(combined);

  //    e. Create stealth keypair
  const stealthKeypair = Keypair.fromSeed(stealthSeed);

  // 6. Encode ephemeral X25519 public key as base64
  const ephemeralPubKeyBase64 = btoa(String.fromCharCode(...ephemeralX25519.publicKey));

  return {
    address: stealthKeypair.publicKey.toBase58(),
    ephemeralPublicKey: ephemeralPubKeyBase64,
    viewTag,
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
 * Helper to get or generate ZK seed for Privy wallets
 * Stored in chrome.storage.local, unique per wallet address
 */
async function getOrCreatePrivyZkSeed(walletAddress: string): Promise<string> {
  const storageKey = `${PRIVY_ZK_SEED_KEY}_${walletAddress}`;

  try {
    // Try to retrieve existing seed
    const result = await chrome.storage.local.get(storageKey);
    if (result[storageKey]) {
      console.log('[Shielded] Retrieved existing ZK seed for Privy wallet');
      return result[storageKey];
    }

    // Generate new seed (32 random bytes as hex)
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const seedHex = Array.from(randomBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Store for future use
    await chrome.storage.local.set({ [storageKey]: seedHex });
    console.log('[Shielded] Generated new ZK seed for Privy wallet');

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
          console.log('[Shielded] Already initialized');
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

        console.log('[Private Transfer] Using relayer for sender privacy');
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
          const stealth = await generateStealthAddressForRecipient(receivingPubkeyBytes, viewingKeyBytes);
          console.log('[Private Transfer] Stealth address:', stealth.address.slice(0, 16) + '...');

          // Step 2: Generate ZK proof for relayer
          const proofData = await _zkService.generateTransferProofForRelayer(amountLamports);
          console.log('[Private Transfer] Proof generated');

          set(state => ({
            pendingTransactions: state.pendingTransactions.map(tx =>
              tx.id === txId ? { ...tx, status: 'submitting' } : tx
            ),
          }));

          // Step 3: Get relayer info
          const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || 'https://p01-relayer-production.up.railway.app';
          let relayerAddress: string;
          let feeBps: number;

          try {
            const infoRes = await fetch(`${RELAYER_URL}/health`);
            const info = await infoRes.json();
            relayerAddress = info.relayer;
            feeBps = info.feeBps || 50;
          } catch {
            const infoRes = await fetch(`${RELAYER_URL}/info`);
            const info = await infoRes.json();
            relayerAddress = info.relayer;
            feeBps = info.feeBps || 50;
          }

          // Step 4: Fund the relayer
          const feeLamports = BigInt(Math.ceil(Number(amountLamports) * feeBps / 10000));
          const rentExempt = BigInt(890880);
          const gasEstimate = BigInt(10000);
          const totalFunding = amountLamports + feeLamports + gasEstimate + rentExempt;

          console.log('[Private Transfer] Funding relayer:', relayerAddress);
          console.log('[Private Transfer] Total:', Number(totalFunding) / 1e9, 'SOL (amount + fee + gas + rent)');

          const fundingTx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: walletPublicKey,
              toPubkey: new PublicKey(relayerAddress),
              lamports: Number(totalFunding),
            })
          );
          fundingTx.feePayer = walletPublicKey;
          fundingTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

          const signedFundingTx = await signTransaction(fundingTx);
          const fundingSignature = await connection.sendRawTransaction(signedFundingTx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          });
          await connection.confirmTransaction(fundingSignature, 'confirmed');
          console.log('[Private Transfer] Funding confirmed:', fundingSignature);

          // Step 5: Send proof + stealth info to relayer
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

          // Step 6: Mark notes as spent
          await _zkService.markNoteSpent(proofData.nullifier);

          const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;

          set(state => ({
            shieldedBalance: newBalance,
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
          return { signature: result.signature, recipientNote: {} as RecipientNoteData };

        } catch (relayerError) {
          console.error('[Private Transfer] Relayer failed:', relayerError);
          console.log('[Private Transfer] Falling back to direct on-chain transfer...');

          // Fallback: direct on-chain ZK transfer (sender visible but still works)
          try {
            const directResult = await _zkService.transfer(
              zkRecipient,
              amountLamports,
              walletPublicKey,
              signTransaction
            );

            const newBalance = Number(_zkService.getShieldedBalance()) / 1e9;

            set(state => ({
              shieldedBalance: newBalance,
              pendingTransactions: state.pendingTransactions.map(tx =>
                tx.id === txId ? { ...tx, status: 'confirmed', signature: directResult.signature } : tx
              ),
            }));

            setTimeout(() => {
              set(state => ({
                pendingTransactions: state.pendingTransactions.filter(tx => tx.id !== txId),
              }));
            }, 5000);

            console.log('[Private Transfer] Fallback successful (sender visible):', directResult.signature);
            return directResult;
          } catch (fallbackError) {
            console.error('[Private Transfer] Fallback also failed:', fallbackError);
            set(state => ({
              pendingTransactions: state.pendingTransactions.map(tx =>
                tx.id === txId
                  ? { ...tx, status: 'failed', error: (relayerError as Error).message }
                  : tx
              ),
            }));
            throw relayerError;
          }
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

        console.log('[Shielded] Notes cleared');
      },

      // ============= STEALTH PAYMENT RECOVERY =============

      // Scan for stealth payments from relayer
      scanStealthPayments: async () => {
        console.log('[Shielded] Starting stealth payment scan...');
        const { isInitialized, _zkService } = get();
        if (!isInitialized || !_zkService) {
          console.log('[Shielded] ZK service not initialized, skipping scan');
          return { found: 0, amount: 0, payments: [] };
        }

        try {
          // Use the relayer URL from environment or default
          const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || 'http://localhost:3000';
          console.log('[Shielded] Fetching from relayer:', RELAYER_URL);
          const response = await fetch(`${RELAYER_URL}/relay/stealth-payments?limit=100`);

          if (!response.ok) {
            console.warn('[Shielded] Failed to fetch stealth payments, status:', response.status);
            return { found: 0, amount: 0, payments: [] };
          }

          const data = await response.json();
          const payments = data.payments || [];
          console.log('[Shielded] Relayer returned', payments.length, 'payments');

          if (payments.length === 0) {
            console.log('[Shielded] No payments to scan');
            return { found: 0, amount: 0, payments: [] };
          }

          // Get stealth keys from ZK service (derived from seed phrase)
          const stealthKeys = _zkService.getStealthKeys();
          if (!stealthKeys) {
            console.warn('[Shielded] Stealth keys not available');
            return { found: 0, amount: 0, payments: [] };
          }

          // Use the proper ZK-derived viewing and spending keys
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
              console.log('[Shielded] Scanning payment:', payment.stealthAddress.slice(0, 16) + '...', 'viewTag:', payment.viewTag);
              const result = await scanStealthPayment(
                payment.ephemeralPublicKey,
                viewingKey,
                spendingKey,
                payment.viewTag
              );

              console.log('[Shielded] Scan result:', result.found ? 'found' : 'not found',
                'derived:', result.stealthAddress?.slice(0, 16) + '...',
                'expected:', payment.stealthAddress.slice(0, 16) + '...',
                'match:', result.stealthAddress === payment.stealthAddress);

              if (result.found && result.stealthAddress === payment.stealthAddress && result.privateKey) {
                // Check on-chain balance — skip if already swept
                const { network } = getWalletData();
                const conn = getConnection(network);
                const onChainBalance = await conn.getBalance(new PublicKey(payment.stealthAddress));

                if (onChainBalance === 0) {
                  console.log('[Shielded] Stealth payment already swept (0 balance), skipping:', payment.stealthAddress.slice(0, 16) + '...');
                  continue;
                }

                const actualAmount = onChainBalance / 1e9;
                console.log('[Shielded] Found stealth payment!', actualAmount, 'SOL (on-chain:', onChainBalance, 'lamports)');
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

          console.log('[Shielded] Found', found, 'stealth payments totaling', totalAmount, 'SOL');

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
        console.log('[Shielded] Sweeping stealth payment from', stealthAddress.slice(0, 16) + '...');

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
          console.log('[Shielded] Stealth address balance:', balance / 1e9, 'SOL');

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

          console.log('[Shielded] Sweep successful! Signature:', signature);
          console.log('[Shielded] Transferred', amountToSend / 1e9, 'SOL to', recipientAddress.slice(0, 16) + '...');

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
        console.log('[Shielded] Sweeping all stealth payments...');

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

        console.log('[Shielded] Sweep complete:', results.swept, 'payments,', results.totalAmount, 'SOL');
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
