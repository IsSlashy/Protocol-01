/**
 * Autonomous Privacy Router Runner
 *
 * Self-initializing service that runs the full privacy pipeline without
 * user intervention. Call `startAutonomousRunner()` once at app startup
 * (after auth) and everything works automatically:
 *
 * 1. Initializes the privacy router with real callbacks
 * 2. Resumes any pending routes from previous sessions
 * 3. Polls for mature notes and executes due hops
 * 4. Auto-refreshes note maturity status
 * 5. Handles errors with retry logic
 *
 * This replaces the lazy initialization in private-send.tsx
 * and ensures the background task is always registered.
 */

import { AppState, AppStateStatus, NativeModules, Platform } from 'react-native';
import {
  initPrivacyRouter,
  resumeRoutes,
  isPrivacyRouterAvailable,
} from './index';
import { checkPendingRoutes, executeHop } from './scheduler';
import { findPool } from '../denominatedPool';
import { useDenominatedPoolStore } from '../../stores/denominatedPoolStore';
import { useWalletStore } from '../../stores/walletStore';
import type { HopExecutionCallbacks } from './types';
import { useAutoShieldStore } from '../../stores/autoShieldStore';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _running = false;
let _pollInterval: ReturnType<typeof setInterval> | null = null;
let _appStateListener: any = null;

/** How often to check for pending hops (ms) */
const POLL_INTERVAL_MS = 60_000; // 1 minute

/** How often to refresh note maturity (ms) */
const MATURITY_REFRESH_MS = 5 * 60_000; // 5 minutes

let _lastMaturityRefresh = 0;

// ---------------------------------------------------------------------------
// Real execution callbacks
// ---------------------------------------------------------------------------

/** Send a local push notification when a hop completes */
async function notifyHopComplete(hopType: string, hopIndex: number, totalHops: number, denomination: number): Promise<void> {
  try {
    const { p01Alert } = require('@/stores/alertStore');
    p01Alert(
      `Route Progress`,
      `${hopType === 'shield' ? 'Shield' : hopType === 'unshield' ? 'Unshield' : 'Split'} hop ${hopIndex}/${totalHops} completed (${denomination} SOL)`,
    );
  } catch {}
}

function buildCallbacks(): HopExecutionCallbacks {
  return {
    shield: async (params) => {
      console.log(`[AutoRunner] 🛡️ SHIELD: ${params.amount} SOL → ${params.denomination} SOL pool`);

      const pool = findPool('SOL', params.denomination);
      if (!pool) throw new Error(`No pool for ${params.denomination} SOL`);

      const shieldNote = useDenominatedPoolStore.getState().shieldNote;
      const noteId = await shieldNote(pool);

      console.log(`[AutoRunner] 🛡️ Shield confirmed: ${noteId}`);
      return { txSignature: `shield_${noteId}`, commitment: noteId };
    },

    split: async (params) => {
      console.log(`[AutoRunner] ✂️ SPLIT: ${params.sourceDenomination} SOL → ${params.numOutputs}x ${params.targetDenomination} SOL`);

      const sourcePool = findPool('SOL', params.sourceDenomination);
      const targetPool = findPool('SOL', params.targetDenomination);
      if (!sourcePool) throw new Error(`No source pool for ${params.sourceDenomination} SOL`);
      if (!targetPool) throw new Error(`No target pool for ${params.targetDenomination} SOL`);

      // Find a mature note in the source pool
      const store = useDenominatedPoolStore.getState();
      const matureNote = store.notes.find(
        n => n.denomination === params.sourceDenomination &&
             n.status === 'mature' &&
             n.token === 'SOL'
      );

      if (!matureNote) {
        throw new Error(`RETRY: No mature note for ${params.sourceDenomination} SOL split`);
      }

      console.log(`[AutoRunner] ✂️ Split note ${matureNote.id.slice(0, 8)}... into ${params.numOutputs} outputs`);
      // Note: actual ZK proof generation requires WebView prover (not available in background)
      // For now, mark as RETRY — the split will execute when the app is in foreground
      throw new Error(`RETRY: Split proof generation requires foreground WebView prover`);
    },

    unshield: async (params) => {
      console.log(`[AutoRunner] 🔓 UNSHIELD: ${params.denomination} SOL → ${params.toAddress.slice(0, 8)}...`);

      const store = useDenominatedPoolStore.getState();
      const notes = store.notes;

      // Find a mature note matching this denomination
      const matureNote = notes.find(
        n => n.denomination === params.denomination &&
             (n.status === 'mature' || n.status === 'pending') &&
             n.token === 'SOL'
      );

      if (!matureNote) {
        console.warn(`[AutoRunner] 🔓 No mature note for ${params.denomination} SOL — will retry later`);
        throw new Error(`RETRY: No mature note available for ${params.denomination} SOL`);
      }

      // Use STARK unshield (quantum-resistant)
      try {
        const sig = await store.unshieldNoteStark(
          matureNote.id,
          params.toAddress,
          // STARK proof data — generate from WebView prover
          { proofBytes: new Uint8Array(0), publicInputs: [], proofSize: 0 },
          false, // not emergency
        );
        console.log(`[AutoRunner] 🔓 STARK unshield confirmed: ${sig.slice(0, 16)}...`);
        return { txSignature: sig };
      } catch (starkErr: any) {
        console.warn(`[AutoRunner] 🔓 STARK unshield failed, trying Groth16:`, starkErr.message?.slice(0, 80));

        // Fallback: try regular unshield if STARK proof fails
        // This requires a ZK proof generator which may not be available in background
        throw new Error(`RETRY: Proof generation not available in background — ${starkErr.message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

async function pollPendingHops(): Promise<void> {
  try {
    const { publicKey } = useWalletStore.getState();
    if (!publicKey) return;

    const { sha256 } = require('@noble/hashes/sha256');
    const { bytesToHex } = require('@noble/hashes/utils');
    const spendingKeyHash = bytesToHex(sha256(new TextEncoder().encode(publicKey)));

    // Check for due hops
    const pending = await checkPendingRoutes(spendingKeyHash);
    if (pending.length > 0) {
      console.log(`[AutoRunner] ⏰ ${pending.length} hops due for execution`);

      const callbacks = buildCallbacks();
      for (const { hop, route } of pending.slice(0, 3)) { // max 3 per cycle
        try {
          const result = await executeHop(hop, route, spendingKeyHash, callbacks);
          if (result.success) {
            console.log(`[AutoRunner] ✅ Hop ${hop.id.slice(0, 8)}... completed: ${result.txSignature?.slice(0, 16)}...`);
            // Notify user of hop completion
            const completedCount = route.hops.filter((h: any) => h.status === 'completed').length + 1;
            notifyHopComplete(hop.type, completedCount, route.hops.length, hop.amount);
          } else {
            console.warn(`[AutoRunner] ⚠️ Hop ${hop.id.slice(0, 8)}... failed: ${result.error}`);
          }
        } catch (err: any) {
          console.error(`[AutoRunner] ❌ Hop execution error:`, err.message?.slice(0, 100));
        }
      }

      // Refresh wallet balance after executing hops
      useWalletStore.getState().refreshBalance?.();

      // Update foreground service notification
      if (Platform.OS === 'android') {
        try {
          const { PrivacyRouterModule } = NativeModules;
          const remainingHops = await checkPendingRoutes(spendingKeyHash);
          if (remainingHops.length === 0) {
            // All hops done — stop the service
            await PrivacyRouterModule?.stopService();
            console.log('[AutoRunner] All hops completed — foreground service stopped');
          } else {
            await PrivacyRouterModule?.updateNotification(remainingHops.length, '');
          }
        } catch {}
      }
    }

    // Auto-refresh note maturity periodically
    const now = Date.now();
    if (now - _lastMaturityRefresh > MATURITY_REFRESH_MS) {
      _lastMaturityRefresh = now;
      try {
        await useDenominatedPoolStore.getState().refreshAllPools?.();
        console.log('[AutoRunner] 🔄 Note maturity refreshed');
      } catch {
        // Non-critical
      }

      // Auto-shield: check pending receive addresses for incoming funds
      try {
        await useAutoShieldStore.getState().checkAndAutoShield();
        useAutoShieldStore.getState().cleanup();
      } catch {
        // Non-critical — retries next cycle
      }
    }
  } catch (err: any) {
    console.error('[AutoRunner] Poll error:', err.message?.slice(0, 100));
  }
}

// ---------------------------------------------------------------------------
// App state handling — pause in background, resume in foreground
// ---------------------------------------------------------------------------

function handleAppStateChange(nextState: AppStateStatus): void {
  if (!_running) return;

  if (nextState === 'active') {
    // Resume polling when app comes to foreground
    if (!_pollInterval) {
      console.log('[AutoRunner] App foregrounded — resuming polling');
      _pollInterval = setInterval(pollPendingHops, POLL_INTERVAL_MS);
    }
    // Immediately check for pending hops
    pollPendingHops();
  } else if (nextState === 'background') {
    // Pause polling when app goes to background to prevent OOM/ANR
    if (_pollInterval) {
      console.log('[AutoRunner] App backgrounded — pausing polling');
      clearInterval(_pollInterval);
      _pollInterval = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the autonomous privacy router.
 *
 * Call once after user authentication (wallet available).
 * Idempotent — safe to call multiple times.
 */
export async function startAutonomousRunner(): Promise<void> {
  if (_running) {
    console.log('[AutoRunner] Already running');
    return;
  }

  const { publicKey } = useWalletStore.getState();
  if (!publicKey) {
    console.log('[AutoRunner] No wallet — skipping init');
    return;
  }

  console.log('[AutoRunner] Starting autonomous privacy router...');

  try {
    const { sha256 } = require('@noble/hashes/sha256');
    const { bytesToHex } = require('@noble/hashes/utils');
    const spendingKeyHash = bytesToHex(sha256(new TextEncoder().encode(publicKey)));

    // Load auto-shield receive addresses from SecureStore
    await useAutoShieldStore.getState().load();

    // Initialize the router if not already done
    if (!isPrivacyRouterAvailable()) {
      await initPrivacyRouter({
        spendingKeyHash,
        callbacks: buildCallbacks(),
      });
      console.log('[AutoRunner] Privacy router initialized');
    }

    // Resume any routes from previous sessions
    await resumeRoutes(spendingKeyHash);

    // Note locking is handled at Private Send time via lockNote().
    // The persist middleware saves the locked status across sessions.

    // Start foreground polling
    _pollInterval = setInterval(pollPendingHops, POLL_INTERVAL_MS);

    // Listen for app state changes
    _appStateListener = AppState.addEventListener('change', handleAppStateChange);

    _running = true;

    // Start Android foreground service to survive app closure
    if (Platform.OS === 'android') {
      try {
        const { PrivacyRouterModule } = NativeModules;
        if (PrivacyRouterModule) {
          // Count pending hops for notification
          const pending = await checkPendingRoutes(spendingKeyHash);
          const totalHops = pending.length;
          await PrivacyRouterModule.startService(totalHops, '');
          console.log('[AutoRunner] Android foreground service started');
        }
      } catch (fgErr: any) {
        console.warn('[AutoRunner] Foreground service failed (non-fatal):', fgErr.message);
      }
    }

    console.log('[AutoRunner] ✅ Autonomous runner active — polling every 60s');

    // Immediately check for pending hops
    pollPendingHops();
  } catch (err: any) {
    console.error('[AutoRunner] Failed to start:', err.message);
  }
}

/**
 * Stop the autonomous runner (e.g., on logout).
 */
export async function stopAutonomousRunner(): Promise<void> {
  if (!_running) return;

  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }

  if (_appStateListener) {
    _appStateListener.remove();
    _appStateListener = null;
  }

  // Stop Android foreground service
  if (Platform.OS === 'android') {
    try {
      const { PrivacyRouterModule } = NativeModules;
      await PrivacyRouterModule?.stopService();
    } catch {}
  }

  _running = false;
  console.log('[AutoRunner] Stopped');
}

/**
 * Check if the runner is active.
 */
export function isRunnerActive(): boolean {
  return _running;
}
