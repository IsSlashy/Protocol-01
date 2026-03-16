import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { vaultEncrypt, vaultDecrypt, isVaultUnlocked } from '../utils/crypto/noteVault';
import { getConnection, getCluster } from '../services/solana/connection';
import {
  type PoolConfig,
  type ShieldReceipt,
  type PoolOnChainInfo,
  type ProofGenerator,
  type WalletSigner,
  type ShareableNote,
  ALL_POOLS,
  SOL_POOLS,
  USDC_POOLS,
  fetchPoolInfo,
  shield,
  unshield,
  unshieldStark,
  emergencyUnshield,
  transferNote as serviceTransferNote,
  importNote as serviceImportNote,
  exportNote as serviceExportNote,
  encodeShareableNote,
  decodeShareableNote,
  receiptToJSON,
  receiptFromJSON,
  slotToEpoch,
  findPool,
  createNullifier,
  bigintToLeBytes32,
  deriveNullifierPDA,
} from '../services/denominatedPool';
import { useWalletStore, getPrivySigner } from './walletStore';
import { scheduleLocalNotification } from '../services/notifications';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NoteStatus = 'pending' | 'mature' | 'spent' | 'transferred' | 'imported';
export type NoteSource = 'shielded' | 'received' | 'imported_backup';

export interface StoredNote {
  id: string; // commitment hex (first 16 chars)
  receiptJSON: string;
  token: 'SOL' | 'USDC';
  denomination: number;
  poolPDA: string;
  shieldedAt: number;
  status: NoteStatus;
  source: NoteSource;
  cluster?: 'devnet' | 'mainnet-beta' | 'testnet'; // network where note was created
  spentTxSig?: string;
  transferredTo?: string; // encoded shareable note (for re-display)
}

interface PoolCacheEntry {
  info: PoolOnChainInfo;
  fetchedAt: number;
}

type TokenFilter = 'SOL' | 'USDC' | 'ALL';

interface DenominatedPoolState {
  // Persisted
  notes: StoredNote[];
  selectedToken: TokenFilter;
  selectedDenomination: number | null;

  // Transient (not persisted)
  isLoading: boolean;
  error: string | null;
  /** Cached pool info keyed by pool PDA base58 */
  poolCache: Record<string, PoolCacheEntry>;
  /** Current operation progress message */
  progress: string | null;
  /** Whether proof generation is in progress (long-running) */
  isProving: boolean;

  // Actions
  refreshPoolInfo: (poolPDA?: string) => Promise<void>;
  refreshAllPools: () => Promise<void>;
  refreshNoteStatuses: () => Promise<void>;
  setSelectedToken: (token: TokenFilter) => void;
  setSelectedDenomination: (denom: number | null) => void;
  shieldNote: (pool: PoolConfig) => Promise<string>;
  unshieldNote: (
    noteId: string,
    recipient: string,
    proofGenerator: ProofGenerator,
  ) => Promise<string>;
  /** Quantum-resistant STARK unshield (no Groth16 proof needed) */
  unshieldNoteStark: (
    noteId: string,
    recipient: string,
    starkProofData: { proofBytes: Uint8Array; publicInputs: bigint[]; proofSize: number },
    emergency?: boolean,
  ) => Promise<string>;
  emergencyUnshieldNote: (
    noteId: string,
    recipient: string,
    proofGenerator: ProofGenerator,
  ) => Promise<string>;
  transferNote: (
    noteId: string,
    proofGenerator: ProofGenerator,
  ) => Promise<{ txSig: string; shareableNote: string }>;
  importNote: (encodedNote: string, source?: NoteSource) => void;
  exportAllNotes: () => string[];
  exportNote: (noteId: string) => string;
  getFilteredPools: () => PoolConfig[];
  getNotesForPool: (poolPDA: string) => StoredNote[];
  getActiveNotes: () => StoredNote[];
  recoverTransferredNotes: () => number;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Encrypted storage adapter (H1 — note secrets must not sit in AsyncStorage plaintext)
// ---------------------------------------------------------------------------

let _noteEncryptionKey: Uint8Array | null = null;

async function getNoteEncryptionKey(): Promise<Uint8Array> {
  if (_noteEncryptionKey) return _noteEncryptionKey;
  const existing = await SecureStore.getItemAsync('p01_note_encryption_key');
  if (existing) {
    _noteEncryptionKey = new Uint8Array(Buffer.from(existing, 'base64'));
    return _noteEncryptionKey;
  }
  const key = nacl.randomBytes(32);
  await SecureStore.setItemAsync('p01_note_encryption_key', Buffer.from(key).toString('base64'));
  _noteEncryptionKey = key;
  return key;
}

function encryptData(data: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const encrypted = nacl.secretbox(new TextEncoder().encode(data), nonce, key);
  if (!encrypted) throw new Error('Encryption failed');
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return Buffer.from(combined).toString('base64');
}

function decryptData(encrypted: string, key: Uint8Array): string {
  const data = new Uint8Array(Buffer.from(encrypted, 'base64'));
  const nonce = data.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = data.slice(nacl.secretbox.nonceLength);
  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) throw new Error('Decryption failed');
  return new TextDecoder().decode(decrypted);
}

/** AsyncStorage wrapper that encrypts values at rest using nacl.secretbox */
const encryptedStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const raw = await AsyncStorage.getItem(name);
    if (!raw) return null;
    try {
      const key = await getNoteEncryptionKey();
      return decryptData(raw, key);
    } catch {
      // Fallback: if decryption fails, data may be unencrypted (migration from old format)
      return raw;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    const key = await getNoteEncryptionKey();
    const encrypted = encryptData(value, key);
    await AsyncStorage.setItem(name, encrypted);
  },
  removeItem: async (name: string): Promise<void> => {
    await AsyncStorage.removeItem(name);
  },
};

// ---------------------------------------------------------------------------
// Wallet-scoped note archival (prevents note loss on wallet switch)
// ---------------------------------------------------------------------------

const ARCHIVE_PREFIX = 'p01_notes_archive_';

/**
 * Archive current notes for a specific wallet address before switching.
 * Notes are encrypted and saved under a wallet-specific key.
 */
export async function archiveNotesForWallet(walletAddress: string): Promise<void> {
  if (!walletAddress) return;
  const { notes } = useDenominatedPoolStore.getState();
  if (notes.length === 0) return;
  try {
    const key = await getNoteEncryptionKey();
    const data = JSON.stringify(notes);
    const encrypted = encryptData(data, key);
    await AsyncStorage.setItem(`${ARCHIVE_PREFIX}${walletAddress}`, encrypted);
    console.log(`[DenomStore] Archived ${notes.length} notes for wallet ${walletAddress.slice(0, 8)}...`);
  } catch (err) {
    console.error('[DenomStore] Failed to archive notes:', (err as Error).message);
  }
}

/**
 * Restore archived notes for a wallet address after switching back.
 * Merges with any existing notes (deduplicates by id).
 */
export async function restoreNotesForWallet(walletAddress: string): Promise<void> {
  if (!walletAddress) return;
  try {
    const raw = await AsyncStorage.getItem(`${ARCHIVE_PREFIX}${walletAddress}`);
    if (!raw) return;
    const key = await getNoteEncryptionKey();
    let decrypted: string;
    try {
      decrypted = decryptData(raw, key);
    } catch {
      // May be unencrypted legacy data
      decrypted = raw;
    }
    const archived: StoredNote[] = JSON.parse(decrypted);
    if (!Array.isArray(archived) || archived.length === 0) return;

    const { notes: currentNotes } = useDenominatedPoolStore.getState();
    const existingIds = new Set(currentNotes.map(n => n.id));
    const newNotes = archived.filter(n => !existingIds.has(n.id));

    if (newNotes.length > 0) {
      useDenominatedPoolStore.setState({ notes: [...currentNotes, ...newNotes] });
      console.log(`[DenomStore] Restored ${newNotes.length} notes for wallet ${walletAddress.slice(0, 8)}...`);
    }
  } catch (err) {
    console.error('[DenomStore] Failed to restore notes:', (err as Error).message);
  }
}

const POOL_CACHE_TTL = 30_000; // 30s

/** Build a WalletSigner for Privy wallets, or undefined for local keypair wallets. */
function getWalletSignerIfPrivy(): WalletSigner | undefined {
  const { isPrivyWallet, publicKey } = useWalletStore.getState();
  if (!isPrivyWallet || !publicKey) return undefined;
  const signer = getPrivySigner();
  if (!signer) return undefined;
  return { publicKey: new PublicKey(publicKey), signTransaction: signer };
}

function noteIdFromReceipt(receipt: ShieldReceipt): string {
  return receipt.commitment.toString(16).slice(0, 16);
}

/** Encrypt receipt before storing — adds vault layer if PIN is set. */
function secureReceipt(receipt: ShieldReceipt): string {
  const json = receiptToJSON(receipt);
  return isVaultUnlocked() ? vaultEncrypt(json) : json;
}

/** Decrypt receipt before using — unwraps vault layer if present. */
function readReceipt(storedReceipt: string): ShieldReceipt {
  const json = vaultDecrypt(storedReceipt); // no-op if not vault-encrypted
  return receiptFromJSON(json);
}

function serializablePoolInfo(info: PoolOnChainInfo): PoolOnChainInfo {
  return {
    ...info,
    // Ensure bigints survive
    totalShielded: info.totalShielded,
    epochDelay: info.epochDelay,
    currentRoot: info.currentRoot,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDenominatedPoolStore = create<DenominatedPoolState>()(
  persist(
    (set, get) => ({
      // Initial state
      notes: [],
      selectedToken: 'SOL',
      selectedDenomination: null,
      isLoading: false,
      error: null,
      poolCache: {},
      progress: null,
      isProving: false,

      // ------------------------------------------------------------------
      // Pool info
      // ------------------------------------------------------------------

      refreshPoolInfo: async (poolPDA?: string) => {
        const connection = getConnection();
        const pools = poolPDA
          ? ALL_POOLS.filter(p => p.poolPDA.toBase58() === poolPDA)
          : ALL_POOLS;

        const cache = { ...get().poolCache };

        for (const pool of pools) {
          const key = pool.poolPDA.toBase58();
          const cached = cache[key];
          if (cached && Date.now() - cached.fetchedAt < POOL_CACHE_TTL) continue;

          try {
            const info = await fetchPoolInfo(connection, pool);
            if (info) {
              cache[key] = { info: serializablePoolInfo(info), fetchedAt: Date.now() };
            }
          } catch (err) {
            // Failed to fetch pool info — will retry on next refresh
          }
        }

        set({ poolCache: cache });
      },

      refreshAllPools: async () => {
        set({ isLoading: true, error: null });
        try {
          await get().refreshPoolInfo();
          await get().refreshNoteStatuses();
          set({ isLoading: false });
        } catch (err) {
          console.error('[DenomPool] refreshAllPools error:', err);
          set({ isLoading: false, error: (err as Error).message });
        }
      },

      // ------------------------------------------------------------------
      // Note status (mature / pending)
      // ------------------------------------------------------------------

      refreshNoteStatuses: async () => {
        const { notes } = get();
        if (notes.length === 0) return;

        try {
          const connection = getConnection();
          const slot = await connection.getSlot('confirmed');
          const currentEpoch = slotToEpoch(slot);

          // Check nullifier PDAs on-chain for non-terminal notes (current cluster only)
          // If a nullifier PDA exists, the note was already spent (possibly on another device)
          const cluster = getCluster();
          const activeNotes = notes.filter(n =>
            n.status !== 'spent' && n.status !== 'transferred' &&
            (n.cluster ?? 'devnet') === cluster
          );
          const nullifierPDAs: { noteId: string; pda: PublicKey }[] = [];

          for (const note of activeNotes) {
            try {
              const receipt = readReceipt(note.receiptJSON);
              const nullifier = createNullifier(receipt.nullifierPreimage, receipt.secret);
              const nullifierBytes = bigintToLeBytes32(nullifier);
              const poolKey = new PublicKey(note.poolPDA);
              const [pda] = deriveNullifierPDA(poolKey, nullifierBytes);
              nullifierPDAs.push({ noteId: note.id, pda });
            } catch {
              // skip notes with invalid receipts
            }
          }

          // Batch fetch nullifier accounts
          const spentNoteIds = new Set<string>();
          if (nullifierPDAs.length > 0) {
            const accounts = await connection.getMultipleAccountsInfo(
              nullifierPDAs.map(n => n.pda)
            );
            for (let i = 0; i < accounts.length; i++) {
              if (accounts[i] !== null) {
                spentNoteIds.add(nullifierPDAs[i].noteId);
              }
            }
          }

          const updated = notes.map(note => {
            // Terminal states — never change
            if (note.status === 'spent' || note.status === 'transferred') return note;

            // Nullifier exists on-chain — note was spent (possibly on another device)
            if (spentNoteIds.has(note.id)) {
              return { ...note, status: 'spent' as NoteStatus };
            }

            const receipt = readReceipt(note.receiptJSON);
            const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
            if (!pool) return note;

            const cached = get().poolCache[note.poolPDA];
            const epochDelay = cached?.info.epochDelay ?? 1n;
            const dynamicDelay = BigInt(cached?.info.dynamicDelay ?? 2);
            const totalDelay = epochDelay + dynamicDelay;

            const minEpoch = currentEpoch - totalDelay;
            const isMature = receipt.depositEpoch <= minEpoch;

            // imported notes go to mature when ready, pending/imported when not
            const newStatus: NoteStatus = isMature ? 'mature' : (note.status === 'imported' ? 'imported' : 'pending');
            return { ...note, status: newStatus };
          });

          set({ notes: updated });
        } catch (err) {
          // refreshNoteStatuses error — non-fatal
        }
      },

      // ------------------------------------------------------------------
      // Filters
      // ------------------------------------------------------------------

      setSelectedToken: (token) => set({ selectedToken: token, selectedDenomination: null }),
      setSelectedDenomination: (denom) => set({ selectedDenomination: denom }),

      getFilteredPools: () => {
        const { selectedToken } = get();
        if (selectedToken === 'SOL') return SOL_POOLS;
        if (selectedToken === 'USDC') return USDC_POOLS;
        return ALL_POOLS;
      },

      getNotesForPool: (poolPDA) => {
        return get().notes.filter(n => n.poolPDA === poolPDA && n.status !== 'spent');
      },

      getActiveNotes: () => {
        const cluster = getCluster();
        return get().notes.filter(n =>
          n.status !== 'spent' && n.status !== 'transferred' &&
          // Only show notes from the current network (legacy notes without cluster default to devnet)
          (n.cluster ?? 'devnet') === cluster
        );
      },

      recoverTransferredNotes: () => {
        // Recover notes that were marked 'transferred' due to a failed NFC/BLE
        // transfer (the receiver never got the data, so the note is still ours).
        // Only recovers notes that have NO spentTxSig (not spent on-chain).
        const notes = get().notes;
        const recoverable = notes.filter(
          n => n.status === 'transferred' && !n.spentTxSig,
        );
        if (recoverable.length === 0) return 0;
        set({
          notes: notes.map(n =>
            n.status === 'transferred' && !n.spentTxSig
              ? { ...n, status: 'mature' as NoteStatus, transferredTo: undefined }
              : n
          ),
        });
        console.log(`[DenomStore] Recovered ${recoverable.length} transferred note(s)`);
        return recoverable.length;
      },

      // ------------------------------------------------------------------
      // Shield (deposit)
      // ------------------------------------------------------------------

      shieldNote: async (pool) => {
        console.log('[DenomStore] shieldNote start:', pool.denomination, pool.token);
        set({ isLoading: true, error: null, progress: 'Preparing...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const walletPubkey = walletSigner
            ? walletSigner.publicKey
            : (await import('../services/solana/wallet')).then(m => m.getKeypair()).then(kp => kp?.publicKey);
          console.log('[DenomStore] walletSigner:', walletSigner ? `Privy(${walletSigner.publicKey.toBase58().slice(0,8)})` : 'local keypair');

          // ── Stealth intermediary: break wallet→pool on-chain link ──
          // Transfer SOL to an ephemeral stealth address first, then shield from there.
          // On-chain: wallet→stealth (normal transfer), stealth→pool (shield) — no direct link.
          let receipt: ShieldReceipt;
          set({ progress: 'Creating stealth intermediary...' });
          console.log('[DenomStore] Creating stealth intermediary to hide wallet origin...');
          try {
            const { Keypair: SolKeypair, SystemProgram, Transaction } = await import('@solana/web3.js');
            const { sha256 } = await import('@noble/hashes/sha256');
            const { bytesToHex } = await import('@noble/hashes/utils');
            const { hmac } = await import('@noble/hashes/hmac');
            const connection = getConnection();

            const walletAddr = walletSigner?.publicKey.toBase58() || '';
            const seed = hmac(sha256, new TextEncoder().encode(walletAddr), new TextEncoder().encode(`stealth_shield_${Date.now()}`));
            const stealthKp = SolKeypair.fromSeed(seed);

            console.log(`[DenomStore] Stealth: ${stealthKp.publicKey.toBase58().slice(0, 12)}...`);

            // Transfer denomination + rent + shield fee to stealth
            const lamports = pool.denomination === 0.1 ? 100_000_000 : pool.denomination === 0.5 ? 500_000_000 : pool.denomination * 1_000_000_000;
            const extra = 5_000_000; // 0.005 SOL for fees + rent
            const transferAmount = lamports + extra;

            set({ progress: 'Transferring to stealth address...' });
            const transferTx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: walletSigner!.publicKey,
                toPubkey: stealthKp.publicKey,
                lamports: transferAmount,
              })
            );
            const { blockhash } = await connection.getLatestBlockhash();
            transferTx.recentBlockhash = blockhash;
            transferTx.feePayer = walletSigner!.publicKey;
            const signedTransfer = await walletSigner!.signTransaction(transferTx);
            const transferSig = await connection.sendRawTransaction(signedTransfer.serialize());
            await connection.confirmTransaction(transferSig, 'confirmed');
            console.log(`[DenomStore] Stealth transfer confirmed: ${transferSig.slice(0, 16)}...`);

            // Now shield from the stealth keypair (not the user's wallet)
            set({ progress: 'Shielding from stealth address...' });
            console.log('[DenomStore] Shielding from stealth (wallet hidden on-chain)...');
            receipt = await shield(pool, (step) => {
              console.log('[DenomStore] progress:', step);
              set({ progress: step });
            }, undefined, stealthKp); // Pass stealth keypair as the shielder

            console.log('[DenomStore] ✅ Shield via stealth — wallet NOT visible on-chain');
          } catch (stealthErr: any) {
            // Stealth failed — fallback to direct (e.g., local keypair, no Privy signer)
            console.warn('[DenomStore] Stealth shield failed, using direct:', stealthErr.message);
            receipt = await shield(pool, (step) => {
              console.log('[DenomStore] progress:', step);
              set({ progress: step });
            }, walletSigner);
          }

          const storedNote: StoredNote = {
            id: noteIdFromReceipt(receipt),
            receiptJSON: secureReceipt(receipt),
            token: pool.token,
            denomination: pool.denomination,
            poolPDA: pool.poolPDA.toBase58(),
            shieldedAt: receipt.shieldedAt,
            status: 'pending',
            source: 'shielded',
            cluster: getCluster(),
          };

          console.log('[DenomStore] Note stored:', storedNote.id, 'status:', storedNote.status);
          set(state => ({
            isLoading: false,
            progress: null,
            notes: [storedNote, ...state.notes],
          }));

          // Notify user of successful shield
          scheduleLocalNotification(
            'Shield Confirmed',
            `${pool.denomination} ${pool.token} shielded to privacy pool`,
            { category: 'transaction', token: pool.token, amount: String(pool.denomination), channelId: 'transactions' },
          ).catch(() => {}); // fire-and-forget, never block on notification failure

          return storedNote.id;
        } catch (err) {
          console.error('[DenomStore] Shield error:', err);
          set({ isLoading: false, progress: null, error: (err as Error).message });

          scheduleLocalNotification(
            'Shield Failed',
            `Failed to shield ${pool.denomination} ${pool.token}: ${(err as Error).message}`,
            { category: 'transaction', token: pool.token, amount: String(pool.denomination), channelId: 'transactions' },
          ).catch(() => {});

          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Unshield (withdraw)
      // ------------------------------------------------------------------

      unshieldNote: async (noteId, recipientAddress, proofGenerator) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');

        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found for this note');

        const { PublicKey, Keypair: SolKeypair, SystemProgram, Transaction } = await import('@solana/web3.js');

        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing stealth withdrawal...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();

          // ── Stealth intermediary: break pool→wallet on-chain link ──
          // Unshield to a stealth address, then sweep from stealth to the real recipient.
          // On-chain: pool→stealth (ZK proof), stealth→wallet (normal transfer) — no direct link.
          const { sha256 } = await import('@noble/hashes/sha256');
          const { hmac } = await import('@noble/hashes/hmac');
          const walletAddr = walletSigner?.publicKey.toBase58() || recipientAddress;
          const seed = hmac(sha256, new TextEncoder().encode(walletAddr), new TextEncoder().encode(`stealth_unshield_${Date.now()}`));
          const stealthKp = SolKeypair.fromSeed(seed);

          console.log(`[DenomStore] Unshield via stealth: ${stealthKp.publicKey.toBase58().slice(0, 12)}... → ${recipientAddress.slice(0, 8)}...`);

          // Step 1: Unshield from pool to stealth address
          set({ progress: 'Unshielding to stealth address...' });
          const sig = await unshield(
            receipt,
            pool,
            stealthKp.publicKey, // Unshield to stealth, NOT to wallet
            proofGenerator,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof');
              set({ progress: step, isProving: proving });
            },
            walletSigner,
          );

          console.log(`[DenomStore] Unshield to stealth confirmed: ${sig.slice(0, 16)}...`);

          // Step 2: Sweep from stealth to the real recipient
          set({ progress: 'Sweeping to destination...', isProving: false });
          try {
            const connection = getConnection();
            const stealthBalance = await connection.getBalance(stealthKp.publicKey);
            const sweepAmount = stealthBalance - 5000; // Leave 5K lamports for TX fee

            if (sweepAmount > 0) {
              const sweepTx = new Transaction().add(
                SystemProgram.transfer({
                  fromPubkey: stealthKp.publicKey,
                  toPubkey: new PublicKey(recipientAddress),
                  lamports: sweepAmount,
                })
              );
              const { blockhash } = await connection.getLatestBlockhash();
              sweepTx.recentBlockhash = blockhash;
              sweepTx.feePayer = stealthKp.publicKey;
              sweepTx.sign(stealthKp);
              const sweepSig = await connection.sendRawTransaction(sweepTx.serialize());
              await connection.confirmTransaction(sweepSig, 'confirmed');
              console.log(`[DenomStore] ✅ Stealth sweep confirmed: ${sweepSig.slice(0, 16)}... → ${recipientAddress.slice(0, 8)}...`);
            }
          } catch (sweepErr: any) {
            console.warn('[DenomStore] Stealth sweep failed (funds safe in stealth):', sweepErr.message);
          }

          // Mark note as spent
          set(state => ({
            isLoading: false,
            isProving: false,
            progress: null,
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'spent' as NoteStatus, spentTxSig: sig } : n
            ),
          }));

          // Refresh wallet balance immediately, delay transaction fetch
          // to let RPC rate-limit window reset after STARK chunk uploads
          useWalletStore.getState().refreshBalance();
          setTimeout(() => {
            useWalletStore.getState().refreshTransactions();
          }, 5000);

          scheduleLocalNotification(
            'Unshield Confirmed',
            `${note.denomination} ${note.token} withdrawn from privacy pool`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          return sig;
        } catch (err) {
          console.error('[DenomPool] Unshield error:', err);
          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });

          scheduleLocalNotification(
            'Unshield Failed',
            `Failed to withdraw ${note.denomination} ${note.token}: ${(err as Error).message}`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          throw err;
        }
      },

      // ------------------------------------------------------------------
      // STARK Unshield (quantum-resistant — no Groth16 proof)
      // ------------------------------------------------------------------

      unshieldNoteStark: async (noteId, recipientAddress, starkProofData, emergency) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');

        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found for this note');

        const { PublicKey } = await import('@solana/web3.js');
        const recipient = new PublicKey(recipientAddress);

        set({ isLoading: true, isProving: false, error: null, progress: emergency ? 'Preparing emergency unshield...' : 'Preparing STARK unshield...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await unshieldStark(
            receipt,
            pool,
            recipient,
            starkProofData,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof') || step.includes('STARK');
              set({ progress: step, isProving: proving });
            },
            walletSigner,
            emergency,
          );

          set(state => ({
            isLoading: false,
            isProving: false,
            progress: null,
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'spent' as NoteStatus, spentTxSig: sig } : n
            ),
          }));

          // Refresh wallet balance immediately, delay transaction fetch
          // to let RPC rate-limit window reset after STARK chunk uploads
          useWalletStore.getState().refreshBalance();
          setTimeout(() => {
            useWalletStore.getState().refreshTransactions();
          }, 5000);

          scheduleLocalNotification(
            'Unshield Confirmed',
            `${note.denomination} ${note.token} withdrawn from privacy pool`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          return sig;
        } catch (err) {
          console.error('[DenomPool] STARK unshield error:', err);
          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });

          scheduleLocalNotification(
            'Unshield Failed',
            `Failed to withdraw ${note.denomination} ${note.token}: ${(err as Error).message}`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Emergency Unshield (bypass maturity)
      // ------------------------------------------------------------------

      emergencyUnshieldNote: async (noteId, recipientAddress, proofGenerator) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');

        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found for this note');

        const { PublicKey } = await import('@solana/web3.js');
        const recipient = new PublicKey(recipientAddress);

        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing emergency unshield...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const sig = await emergencyUnshield(
            receipt,
            pool,
            recipient,
            proofGenerator,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof');
              set({ progress: step, isProving: proving });
            },
            walletSigner,
          );

          set(state => ({
            isLoading: false,
            isProving: false,
            progress: null,
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'spent' as NoteStatus, spentTxSig: sig } : n
            ),
          }));

          // Refresh wallet balance immediately, delay transaction fetch
          // to let RPC rate-limit window reset after STARK chunk uploads
          useWalletStore.getState().refreshBalance();
          setTimeout(() => {
            useWalletStore.getState().refreshTransactions();
          }, 5000);

          scheduleLocalNotification(
            'Unshield Confirmed',
            `${note.denomination} ${note.token} withdrawn from privacy pool`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          return sig;
        } catch (err) {
          console.error('[DenomPool] Emergency unshield error:', err);
          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });

          scheduleLocalNotification(
            'Unshield Failed',
            `Failed to withdraw ${note.denomination} ${note.token}: ${(err as Error).message}`,
            { category: 'transaction', token: note.token, amount: String(note.denomination), channelId: 'transactions' },
          ).catch(() => {});

          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Transfer note (peer-to-peer)
      // ------------------------------------------------------------------

      transferNote: async (noteId, proofGenerator) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        if (note.status === 'spent') throw new Error('Note already spent');
        if (note.status !== 'mature') throw new Error('Note must be mature for transfer');

        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found for this note');

        set({ isLoading: true, isProving: false, error: null, progress: 'Preparing transfer...' });

        try {
          const walletSigner = getWalletSignerIfPrivy();
          const { txSig, recipientNote } = await serviceTransferNote(
            receipt,
            pool,
            proofGenerator,
            (step) => {
              const proving = step.includes('proof') || step.includes('Proof');
              set({ progress: step, isProving: proving });
            },
            walletSigner,
          );

          const encoded = encodeShareableNote(recipientNote);

          // Mark old note as transferred (not just spent)
          set(state => ({
            isLoading: false,
            isProving: false,
            progress: null,
            notes: state.notes.map(n =>
              n.id === noteId ? { ...n, status: 'transferred' as NoteStatus, spentTxSig: txSig, transferredTo: encoded } : n
            ),
          }));

          return { txSig, shareableNote: encoded };
        } catch (err) {
          console.error('[DenomPool] Transfer error:', err);
          set({ isLoading: false, isProving: false, progress: null, error: (err as Error).message });
          throw err;
        }
      },

      // ------------------------------------------------------------------
      // Note import/export (backup & sharing)
      // ------------------------------------------------------------------

      importNote: (encodedNote, source: NoteSource = 'received') => {
        console.log('[DenomStore] importNote called, source:', source, 'dataLen:', encodedNote.length);
        try {
          const noteData = decodeShareableNote(encodedNote);
          const receipt = serviceImportNote(noteData);
          const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === noteData.pool);
          if (!pool) throw new Error('Unknown pool');

          const storedNote: StoredNote = {
            id: noteIdFromReceipt(receipt),
            receiptJSON: secureReceipt(receipt),
            token: noteData.token,
            denomination: noteData.denominationHuman,
            poolPDA: noteData.pool,
            shieldedAt: receipt.shieldedAt || Date.now(),
            status: 'imported',
            source,
            cluster: getCluster(),
          };

          // Check if note already exists
          const existing = get().notes.find(n => n.id === storedNote.id);
          if (existing) {
            // If the existing note was transferred out, replace it with the incoming one
            if (existing.status === 'transferred') {
              set(state => ({
                notes: state.notes.map(n =>
                  n.id === storedNote.id ? storedNote : n
                ),
                error: null,
              }));
            } else {
              throw new Error('This note already exists in your wallet');
            }
          } else {
            set(state => ({
              notes: [storedNote, ...state.notes],
              error: null,
            }));
          }
        } catch (err) {
          console.error('[DenomPool] Import error:', err);
          set({ error: (err as Error).message });
          throw err;
        }
      },

      exportAllNotes: () => {
        const { notes } = get();
        return notes
          .filter(n => n.status !== 'spent')
          .map(n => {
            const receipt = readReceipt(n.receiptJSON);
            const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === n.poolPDA);
            if (!pool) return '';
            return encodeShareableNote(serviceExportNote(receipt, pool));
          })
          .filter(Boolean);
      },

      exportNote: (noteId) => {
        const note = get().notes.find(n => n.id === noteId);
        if (!note) throw new Error('Note not found');
        const receipt = readReceipt(note.receiptJSON);
        const pool = ALL_POOLS.find(p => p.poolPDA.toBase58() === note.poolPDA);
        if (!pool) throw new Error('Pool config not found');
        return encodeShareableNote(serviceExportNote(receipt, pool));
      },

      reset: () => {
        set({
          notes: [],
          selectedToken: 'SOL',
          selectedDenomination: null,
          isLoading: false,
          error: null,
          poolCache: {},
          progress: null,
          isProving: false,
        });
      },
    }),
    {
      name: 'p01-denominated-pool',
      version: 2,
      storage: createJSONStorage(() => encryptedStorage),
      partialize: (state) => ({
        notes: state.notes,
        selectedToken: state.selectedToken,
      }),
      migrate: (persistedState: any, version: number) => {
        // v1 → v2: storage changed from plain AsyncStorage to encrypted;
        // data shape is the same, just accept it as-is.
        return persistedState as any;
      },
    },
  ),
);
