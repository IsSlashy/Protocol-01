/**
 * Auto-Shield Store — Manages one-time receive addresses + automatic shielding.
 *
 * When the user opens "Receive", a fresh stealth address is generated.
 * The autonomous runner monitors these addresses for incoming funds.
 * When funds are detected, they are automatically shielded into the
 * denominated pool — the main wallet is NEVER exposed to senders.
 *
 * Flow:
 *   1. User opens Receive → generateReceiveAddress()
 *   2. Sender sends SOL to the one-time address
 *   3. Autonomous runner detects funds → checkAndAutoShield()
 *   4. Funds are shielded: stealth address → pool
 *   5. Main wallet never appears on-chain
 */

import { create } from 'zustand';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { getConnection } from '../services/solana/connection';
import { useWalletStore } from './walletStore';
import { useDenominatedPoolStore } from './denominatedPoolStore';
import { findPool } from '../services/denominatedPool';
import { getOrCreateStealthKeys } from '../services/stealth/keys';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum balance to trigger auto-shield (lamports) — 0.05 SOL */
const MIN_AUTO_SHIELD_LAMPORTS = 50_000_000;

/** Maximum age of an unfunded address before cleanup (ms) — 7 days */
const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60_000;

/** SecureStore key for persisted state */
const STORE_KEY = 'p01_auto_shield_addresses';
const COUNTER_KEY = 'p01_auto_shield_counter';

/** Available pool denominations in descending order */
const POOL_DENOMINATIONS = [100, 10, 1, 0.1];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingReceiveAddress {
  /** Base58 Solana address (one-time, never reused) */
  address: string;
  /** Hex-encoded 32-byte seed to recover the Keypair */
  seed: string;
  /** When this address was generated */
  createdAt: number;
  /** Current status */
  status: 'pending' | 'funded' | 'shielding' | 'shielded';
  /** Detected balance in lamports (set when funded) */
  balanceLamports?: number;
  /** Source of funds — 'receive' (manual), 'mugen' (P-01 Network buy), 'moonpay' */
  source?: 'receive' | 'mugen' | 'moonpay';
  /** Expected amount in lamports (for buy tracking) */
  expectedLamports?: number;
}

interface AutoShieldState {
  /** All tracked receive addresses */
  addresses: PendingReceiveAddress[];
  /** Incrementing counter for deterministic derivation */
  counter: number;
  /** Whether auto-shielding is enabled */
  enabled: boolean;
  /** Loading state */
  isGenerating: boolean;

  // Actions
  /** Load persisted state from SecureStore */
  load: () => Promise<void>;
  /** Generate a fresh one-time receive address */
  generateReceiveAddress: () => Promise<string>;
  /** Check all pending addresses and auto-shield funded ones */
  checkAndAutoShield: () => Promise<void>;
  /** Remove old unfunded addresses */
  cleanup: () => void;
  /** Toggle auto-shield on/off */
  setEnabled: (enabled: boolean) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAutoShieldStore = create<AutoShieldState>((set, get) => ({
  addresses: [],
  counter: 0,
  enabled: true,
  isGenerating: false,

  load: async () => {
    try {
      const raw = await SecureStore.getItemAsync(STORE_KEY);
      const counterRaw = await SecureStore.getItemAsync(COUNTER_KEY);

      if (raw) {
        const addresses = JSON.parse(raw) as PendingReceiveAddress[];
        // Filter out fully shielded addresses on load (keep last 5 for history)
        const active = addresses.filter(a => a.status !== 'shielded');
        const shielded = addresses.filter(a => a.status === 'shielded').slice(-5);
        set({ addresses: [...active, ...shielded] });
      }

      if (counterRaw) {
        set({ counter: parseInt(counterRaw, 10) });
      }

      console.log(`[AutoShield] Loaded ${get().addresses.length} addresses, counter=${get().counter}`);
    } catch (err: any) {
      console.error('[AutoShield] Load failed:', err.message);
    }
  },

  generateReceiveAddress: async () => {
    set({ isGenerating: true });

    try {
      const { publicKey } = useWalletStore.getState();
      if (!publicKey) throw new Error('No wallet');

      const counter = get().counter;

      // Deterministic derivation: HMAC(viewingSecretKey, "p01_auto_receive_<counter>")
      // Uses the stealth viewing secret key (SecureStore) — NOT the public key.
      // Only the device owner can derive receive addresses.
      const stealthKeys = await getOrCreateStealthKeys();
      const seed = hmac(
        sha256,
        stealthKeys.viewingSecretKey,
        `p01_auto_receive_${counter}`,
      );

      const keypair = Keypair.fromSeed(seed);
      const address = keypair.publicKey.toBase58();

      const entry: PendingReceiveAddress = {
        address,
        seed: bytesToHex(seed),
        createdAt: Date.now(),
        status: 'pending',
      };

      const newAddresses = [...get().addresses, entry];
      const newCounter = counter + 1;

      set({ addresses: newAddresses, counter: newCounter, isGenerating: false });

      // Persist
      await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(newAddresses));
      await SecureStore.setItemAsync(COUNTER_KEY, String(newCounter));

      console.log(`[AutoShield] Generated receive address #${counter}: ${address.slice(0, 8)}...`);

      return address;
    } catch (err: any) {
      set({ isGenerating: false });
      console.error('[AutoShield] Generate failed:', err.message);
      throw err;
    }
  },

  checkAndAutoShield: async () => {
    const { addresses, enabled } = get();
    if (!enabled) return;

    const pending = addresses.filter(a => a.status === 'pending');
    if (pending.length === 0) return;

    const connection = getConnection();

    for (const addr of pending) {
      try {
        const balance = await connection.getBalance(new PublicKey(addr.address));

        if (balance >= MIN_AUTO_SHIELD_LAMPORTS) {
          console.log(`[AutoShield] Funds detected on ${addr.address.slice(0, 8)}...: ${balance / LAMPORTS_PER_SOL} SOL`);

          // Update status to funded
          addr.status = 'funded';
          addr.balanceLamports = balance;
          set({ addresses: [...get().addresses] });

          // Find best denomination pool
          const solAmount = balance / LAMPORTS_PER_SOL;
          const bestDenom = POOL_DENOMINATIONS.find(d => d <= solAmount); // Exact match OK — shield pays fees from pool margin

          if (!bestDenom) {
            console.log(`[AutoShield] Balance ${solAmount} SOL too small for any pool — skipping`);
            continue;
          }

          const pool = findPool('SOL', bestDenom);
          if (!pool) {
            console.warn(`[AutoShield] No pool found for ${bestDenom} SOL`);
            continue;
          }

          // Recover keypair from seed
          const keypair = Keypair.fromSeed(hexToBytes(addr.seed));

          // Auto-shield: stealth → pool (main wallet never appears)
          addr.status = 'shielding';
          set({ addresses: [...get().addresses] });

          console.log(`[AutoShield] Shielding ${bestDenom} SOL from ${addr.address.slice(0, 8)}... to pool`);

          try {
            const { shield } = await import('../services/denominatedPool');
            const receipt = await shield(
              pool,
              (step) => console.log(`[AutoShield] ${step}`),
              undefined, // no wallet signer needed — stealth keypair signs
              keypair,   // overrideKeypair: shield directly from stealth
            );

            addr.status = 'shielded';
            set({ addresses: [...get().addresses] });

            // Store the note
            const noteId = receipt.commitment.toString(16).slice(0, 16);
            console.log(`[AutoShield] Auto-shielded! Note: ${noteId}`);

            // Persist updated state
            await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(get().addresses));

            // Refresh wallet balance
            useWalletStore.getState().refreshBalance?.();
          } catch (shieldErr: any) {
            console.error(`[AutoShield] Shield failed:`, shieldErr.message?.slice(0, 100));
            // Revert to funded so it retries next cycle
            addr.status = 'funded';
            set({ addresses: [...get().addresses] });
          }
        }
      } catch (err: any) {
        // Balance check failed — non-critical, retry next cycle
        if (!err.message?.includes('429')) {
          console.warn(`[AutoShield] Balance check failed for ${addr.address.slice(0, 8)}...:`, err.message?.slice(0, 60));
        }
      }
    }
  },

  cleanup: () => {
    const now = Date.now();
    const addresses = get().addresses.filter(a => {
      // Keep funded/shielding addresses regardless of age
      if (a.status !== 'pending') return true;
      // Remove old unfunded addresses
      return now - a.createdAt < MAX_PENDING_AGE_MS;
    });

    if (addresses.length !== get().addresses.length) {
      const removed = get().addresses.length - addresses.length;
      console.log(`[AutoShield] Cleaned up ${removed} expired addresses`);
      set({ addresses });
      SecureStore.setItemAsync(STORE_KEY, JSON.stringify(addresses)).catch(() => {});
    }
  },

  setEnabled: (enabled: boolean) => {
    set({ enabled });
    console.log(`[AutoShield] ${enabled ? 'Enabled' : 'Disabled'}`);
  },
}));
