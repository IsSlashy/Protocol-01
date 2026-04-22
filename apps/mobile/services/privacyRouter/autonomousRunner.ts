/**
 * Autonomous Privacy Router Runner
 *
 * Self-initializing service that runs the full privacy pipeline. Started once
 * at app launch (after auth) by `startAutonomousRunner()`. Hops are picked up
 * from encrypted SecureStore and executed via injected callbacks.
 *
 * STARK proofs require the foreground WebView prover. When the app is
 * foregrounded, the StarkProverProvider calls `setForegroundProver()` to
 * register itself; unshield + split hops then run end-to-end. When backgrounded,
 * the callbacks throw `RETRY:` so the scheduler reschedules the hop and a local
 * notification nudges the user to reopen the app.
 */

import { AppState, AppStateStatus, NativeModules, Platform } from 'react-native';
import { Buffer } from 'buffer';
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
import { deriveSplitOutputSecrets } from '../denominatedPool';

// ---------------------------------------------------------------------------
// Foreground STARK prover injection
// ---------------------------------------------------------------------------

/**
 * Subset of `StarkProverContextType` (providers/StarkProverProvider) the runner
 * needs. The provider registers itself via `setForegroundProver` on mount and
 * clears via `clearForegroundProver` on unmount, so the runner reads the live
 * prover at hop execution time rather than capturing a stale closure.
 */
export interface RouterProverFacade {
  isReady: boolean;
  generatePoolCommitmentProof: (
    np: string,
    secret: string,
    epoch: string,
    mint: string,
  ) => Promise<{
    proofHex: string;
    proofSize: number;
    publicInputs: string[];
  }>;
}

let _foregroundProver: RouterProverFacade | null = null;

export function setForegroundProver(prover: RouterProverFacade): void {
  _foregroundProver = prover;
}

export function clearForegroundProver(): void {
  _foregroundProver = null;
}

function getReadyProver(): RouterProverFacade | null {
  if (_foregroundProver && _foregroundProver.isReady) return _foregroundProver;
  return null;
}

// ---------------------------------------------------------------------------
// Local notification throttling — one nudge per hour across all routes
// ---------------------------------------------------------------------------

let _lastNudgeAt = 0;
const NUDGE_THROTTLE_MS = 60 * 60_000;

async function nudgeUserOpenApp(): Promise<void> {
  const now = Date.now();
  if (now - _lastNudgeAt < NUDGE_THROTTLE_MS) return;
  _lastNudgeAt = now;

  try {
    const Notifications = await import('expo-notifications');
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Privacy route ready',
        body: 'Open Protocol 01 to advance your private send.',
      },
      trigger: null,
    });
  } catch {
    // expo-notifications optional — silently skip if unavailable
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _running = false;
let _pollInterval: ReturnType<typeof setInterval> | null = null;
let _appStateListener: any = null;

const POLL_INTERVAL_MS = 60_000;
const MATURITY_REFRESH_MS = 5 * 60_000;
let _lastMaturityRefresh = 0;

// ---------------------------------------------------------------------------
// Real execution callbacks
// ---------------------------------------------------------------------------

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
      // Shield uses the user's main-wallet HKDF derivation through the store —
      // no STARK proof required (commitment-only inclusion). Works in both fg
      // and bg as long as the wallet signer is mounted.
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

      const prover = getReadyProver();
      if (!prover) {
        // Background or prover not yet ready — bounce off so the scheduler
        // retries when the user reopens the app.
        nudgeUserOpenApp();
        throw new Error('RETRY: STARK prover unavailable (open app to advance route)');
      }

      const store = useDenominatedPoolStore.getState();
      const matureNote = store.notes.find(
        n => n.denomination === params.sourceDenomination &&
             n.status === 'mature' &&
             n.token === 'SOL'
      );

      if (!matureNote) {
        throw new Error(`RETRY: No mature note for ${params.sourceDenomination} SOL split`);
      }

      // Derive deterministic output secrets from the parent note's secret so
      // the user can recover the children from seed alone (Phase 2 of the
      // note-secret fix — see bug-note-secret-nondeterministic memory).
      const { receiptFromJSON } = await import('../denominatedPool');
      const { vaultDecrypt } = await import('../../utils/crypto/noteVault');
      const receipt = receiptFromJSON(vaultDecrypt(matureNote.receiptJSON));
      const outputSecrets = deriveSplitOutputSecrets(receipt.secret, params.numOutputs);

      const proofResult = await prover.generatePoolCommitmentProof(
        receipt.nullifierPreimage.toString(),
        receipt.secret.toString(),
        receipt.depositEpoch.toString(),
        receipt.tokenMint.toString(),
      );

      const proofBytes = Buffer.from(proofResult.proofHex, 'hex');
      const publicInputs = proofResult.publicInputs.map((s: string) => BigInt(s));

      try {
        const { txSignature, outputCommitments } = await store.splitNoteStark(
          matureNote.id,
          targetPool.poolPDA.toBase58(),
          outputSecrets,
          { proofBytes, publicInputs, proofSize: proofResult.proofSize },
        );
        console.log(`[AutoRunner] ✂️ Split confirmed: ${txSignature.slice(0, 16)}...`);
        return {
          txSignature,
          outputCommitments: outputCommitments.map((c) => c.toString()),
        };
      } catch (err: any) {
        console.warn(`[AutoRunner] ✂️ Split failed:`, err.message?.slice(0, 100));
        throw err;
      }
    },

    unshield: async (params) => {
      console.log(`[AutoRunner] 🔓 UNSHIELD: ${params.denomination} SOL → ${params.toAddress.slice(0, 8)}...`);

      const prover = getReadyProver();
      if (!prover) {
        nudgeUserOpenApp();
        throw new Error('RETRY: STARK prover unavailable (open app to advance route)');
      }

      const store = useDenominatedPoolStore.getState();
      const matureNote = store.notes.find(
        n => n.denomination === params.denomination &&
             n.status === 'mature' &&
             n.token === 'SOL'
      );

      if (!matureNote) {
        console.warn(`[AutoRunner] 🔓 No mature note for ${params.denomination} SOL — will retry later`);
        throw new Error(`RETRY: No mature note available for ${params.denomination} SOL`);
      }

      const { receiptFromJSON } = await import('../denominatedPool');
      const { vaultDecrypt } = await import('../../utils/crypto/noteVault');
      const receipt = receiptFromJSON(vaultDecrypt(matureNote.receiptJSON));

      const proofResult = await prover.generatePoolCommitmentProof(
        receipt.nullifierPreimage.toString(),
        receipt.secret.toString(),
        receipt.depositEpoch.toString(),
        receipt.tokenMint.toString(),
      );

      const proofBytes = Buffer.from(proofResult.proofHex, 'hex');
      const publicInputs = proofResult.publicInputs.map((s: string) => BigInt(s));

      try {
        const sig = await store.unshieldNoteStark(
          matureNote.id,
          params.toAddress,
          { proofBytes, publicInputs, proofSize: proofResult.proofSize },
          false, // not emergency — Phase-1 indistinguishability handles min_epoch
        );
        console.log(`[AutoRunner] 🔓 STARK unshield confirmed: ${sig.slice(0, 16)}...`);
        return { txSignature: sig };
      } catch (starkErr: any) {
        console.warn(`[AutoRunner] 🔓 STARK unshield failed:`, starkErr.message?.slice(0, 80));
        throw starkErr;
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

    const { sha256 } = require('@noble/hashes/sha2');
    const { bytesToHex } = require('@noble/hashes/utils');
    const spendingKeyHash = bytesToHex(sha256(new TextEncoder().encode(publicKey)));

    const pending = await checkPendingRoutes(spendingKeyHash);
    if (pending.length > 0) {
      console.log(`[AutoRunner] ⏰ ${pending.length} hops due for execution`);

      const callbacks = buildCallbacks();
      for (const { hop, route } of pending.slice(0, 3)) {
        try {
          const result = await executeHop(hop, route, spendingKeyHash, callbacks);
          if (result.success) {
            console.log(`[AutoRunner] ✅ Hop ${hop.id.slice(0, 8)}... completed: ${result.txSignature?.slice(0, 16)}...`);
            const completedCount = route.hops.filter((h: any) => h.status === 'completed').length + 1;
            notifyHopComplete(hop.type, completedCount, route.hops.length, hop.amount);
          } else {
            console.warn(`[AutoRunner] ⚠️ Hop ${hop.id.slice(0, 8)}... failed: ${result.error}`);
          }
        } catch (err: any) {
          console.error(`[AutoRunner] ❌ Hop execution error:`, err.message?.slice(0, 100));
        }
      }

      useWalletStore.getState().refreshBalance?.();

      if (Platform.OS === 'android') {
        try {
          const { PrivacyRouterModule } = NativeModules;
          const remainingHops = await checkPendingRoutes(spendingKeyHash);
          if (remainingHops.length === 0) {
            await PrivacyRouterModule?.stopService();
            console.log('[AutoRunner] All hops completed — foreground service stopped');
          } else {
            await PrivacyRouterModule?.updateNotification(remainingHops.length, '');
          }
        } catch {}
      }
    }

    const now = Date.now();
    if (now - _lastMaturityRefresh > MATURITY_REFRESH_MS) {
      _lastMaturityRefresh = now;
      try {
        await useDenominatedPoolStore.getState().refreshAllPools?.();
        console.log('[AutoRunner] 🔄 Note maturity refreshed');
      } catch {}

      try {
        await useAutoShieldStore.getState().checkAndAutoShield();
        useAutoShieldStore.getState().cleanup();
      } catch {}
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
    if (!_pollInterval) {
      console.log('[AutoRunner] App foregrounded — resuming polling');
      _pollInterval = setInterval(pollPendingHops, POLL_INTERVAL_MS);
    }
    pollPendingHops();
  } else if (nextState === 'background') {
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
    const { sha256 } = require('@noble/hashes/sha2');
    const { bytesToHex } = require('@noble/hashes/utils');
    const spendingKeyHash = bytesToHex(sha256(new TextEncoder().encode(publicKey)));

    await useAutoShieldStore.getState().load();

    if (!isPrivacyRouterAvailable()) {
      await initPrivacyRouter({
        spendingKeyHash,
        callbacks: buildCallbacks(),
      });
      console.log('[AutoRunner] Privacy router initialized');
    }

    await resumeRoutes(spendingKeyHash);

    _pollInterval = setInterval(pollPendingHops, POLL_INTERVAL_MS);
    _appStateListener = AppState.addEventListener('change', handleAppStateChange);
    _running = true;

    if (Platform.OS === 'android') {
      try {
        const { PrivacyRouterModule } = NativeModules;
        if (PrivacyRouterModule) {
          const pending = await checkPendingRoutes(spendingKeyHash);
          await PrivacyRouterModule.startService(pending.length, '');
          console.log('[AutoRunner] Android foreground service started');
        }
      } catch (fgErr: any) {
        console.warn('[AutoRunner] Foreground service failed (non-fatal):', fgErr.message);
      }
    }

    console.log('[AutoRunner] ✅ Autonomous runner active — polling every 60s');
    pollPendingHops();
  } catch (err: any) {
    console.error('[AutoRunner] Failed to start:', err.message);
  }
}

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

  if (Platform.OS === 'android') {
    try {
      const { PrivacyRouterModule } = NativeModules;
      await PrivacyRouterModule?.stopService();
    } catch {}
  }

  _running = false;
  console.log('[AutoRunner] Stopped');
}

export function isRunnerActive(): boolean {
  return _running;
}
