/**
 * QuantumWalletBootProvider — app-level lifecycle for the unified wallet.
 *
 * The two-wallet UX collapsed into a single unified wallet, so the
 * Ed25519 → quantum-vault auto-deposit sweep and the STARK auth-proof
 * pre-computation can no longer be tied to the (now hidden) quantum
 * screen's mount/unmount lifecycle. They have to fire at app boot,
 * regardless of which tab the user is on, so that:
 *
 *  1. Lamports landing on the Ed25519 address waterfall into the
 *     quantum vault automatically (no manual "deposit" button).
 *  2. The first send feels instant because the auth proof is already
 *     warm in the cached `ProofBuffer` PDA by the time the user
 *     taps Send.
 *
 * Mount this provider INSIDE `StarkProverProvider` (it depends on the
 * STARK prover context being available). It renders no UI of its own.
 *
 * Hydration ordering — important:
 *  - walletStore.initialized must flip true BEFORE we call
 *    startAutoDeposit (otherwise getKeypair() returns null and the
 *    WebSocket subscribes to a non-existent address).
 *  - quantumWalletStore.initialized must flip true BEFORE we call
 *    startAutoDeposit too (no owner_id PDA otherwise). If the user
 *    hasn't initialized their quantum wallet yet, the effect is a
 *    no-op and will re-fire once they do.
 *  - StarkProver.isReady must flip true BEFORE we pre-prove (the
 *    pre-prove helper itself short-circuits, but skipping the call
 *    avoids unnecessary churn).
 *
 * Foreground/background lifecycle:
 *  - autoDeposit's WebSocket sub stays open while the app is
 *    foregrounded. On `background` we tear it down to avoid a stale
 *    socket churning in the OS — we re-subscribe on `active`.
 *  - We only stop the sub on `background`, not on `inactive` (which
 *    fires for momentary states like Control Center / app switcher).
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useStarkProver } from './StarkProverProvider';
import { useWalletStore } from '../stores/walletStore';
import {
  useQuantumWalletStore,
  preProveQuantumAuth,
} from '../stores/quantumWalletStore';

interface Props {
  children: ReactNode;
}

export function QuantumWalletBootProvider({ children }: Props) {
  const prover = useStarkProver();
  const walletInitialized = useWalletStore((s) => s.initialized);
  const hasWallet = useWalletStore((s) => s.hasWallet);
  const quantumInitialized = useQuantumWalletStore((s) => s.initialized);
  const hydrate = useQuantumWalletStore((s) => s.hydrate);
  const initWallet = useQuantumWalletStore((s) => s.initWallet);
  const startAutoDeposit = useQuantumWalletStore((s) => s.startAutoDeposit);
  const stopAutoDeposit = useQuantumWalletStore((s) => s.stopAutoDeposit);

  // Hydrate the quantum store once the wallet layer is ready. The store's
  // own `hydrate` is idempotent and short-circuits if it has nothing to do,
  // but we still gate on hasWallet so we don't fire it before SecureStore
  // has been probed.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!walletInitialized || !hasWallet) return;
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    void hydrate();
  }, [walletInitialized, hasWallet, hydrate]);

  // Auto-initialize the quantum vault on first boot. Without this, a fresh
  // install would leave the user's Ed25519 funds exposed forever because
  // autoDeposit needs an existing on-chain vault to deposit into. We sign the
  // init tx with the user's Ed25519 key (same identity that hydrated walletStore)
  // and pay rent (~0.002 SOL) from their Ed25519 balance.
  //
  // Concurrent-fire guard via ref. On error (most often "no SOL on Ed25519 for
  // rent"), we reset the ref so retries fire when deps next change (e.g. STARK
  // prover finishes loading, walletStore re-hydrates after a Privy restore).
  const initFiringRef = useRef(false);
  useEffect(() => {
    if (!walletInitialized || !hasWallet) return;
    if (!prover.isReady) return;
    if (quantumInitialized) return;
    if (initFiringRef.current) return;
    initFiringRef.current = true;
    void (async () => {
      try {
        await initWallet({ prover, enableRecovery: false });
        console.log('[QuantumWalletBoot] vault auto-initialized at boot');
      } catch (err: any) {
        console.warn('[QuantumWalletBoot] auto-init failed:', err?.message ?? err);
      } finally {
        initFiringRef.current = false;
      }
    })();
  }, [walletInitialized, hasWallet, prover.isReady, quantumInitialized, initWallet, prover]);

  // Start the Ed25519 → vault auto-deposit sweep once everything is ready.
  // The store guards against double-subscribing, so it's safe to call this
  // multiple times — but we only need to call it when the gating conditions
  // first flip true, hence the dep array.
  useEffect(() => {
    if (!walletInitialized || !hasWallet || !quantumInitialized) return;
    void startAutoDeposit();
    return () => {
      // On unmount (full app teardown), drop the socket.
      stopAutoDeposit();
    };
  }, [walletInitialized, hasWallet, quantumInitialized, startAutoDeposit, stopAutoDeposit]);

  // Pre-prove the STARK auth proof once the prover is ready so the user's
  // first Send is fast. No-op if a fresh proof is already cached on-chain.
  useEffect(() => {
    if (!walletInitialized || !hasWallet || !quantumInitialized) return;
    if (!prover.isReady) return;
    void preProveQuantumAuth(prover);
    // We intentionally only re-fire on these state flips. The pre-prove
    // helper internally checks for proof freshness and exits early if a
    // cached proof is still valid, so cheap to re-call.
  }, [walletInitialized, hasWallet, quantumInitialized, prover.isReady, prover]);

  // Mirror the auto-deposit sub lifecycle to AppState. We can't keep a
  // long-lived WebSocket open in `background` (OS will tear it down anyway
  // and the next `active` would resume on a stale socket).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      // Only react if the user actually has a quantum wallet to watch.
      const qs = useQuantumWalletStore.getState();
      const ws = useWalletStore.getState();
      if (!ws.initialized || !ws.hasWallet || !qs.initialized) return;

      if (state === 'background') {
        stopAutoDeposit();
      } else if (state === 'active') {
        void startAutoDeposit();
      }
    });
    return () => sub.remove();
  }, [startAutoDeposit, stopAutoDeposit]);

  return <>{children}</>;
}
