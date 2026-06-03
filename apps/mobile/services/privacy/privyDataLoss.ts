/**
 * Privy-removal data-loss notice (spec §3 Phase 1, R-09 / R-12).
 *
 * Removing Privy is an ACCEPTED, SURFACED data-loss event — never a silent drop.
 * Wherever a former Privy/random-seed derivation path was deleted, the orphaned
 * seed class is enumerated and this one-time, user-facing warning flag is the
 * hook the UI uses to tell the user that any balances held under those seeds are
 * no longer recoverable on this build.
 *
 * Four orphaned seed classes are accepted (see spec R-12):
 *   (a) mobile  `p01_note_seed_v1_*`     (services/denominatedPool)
 *   (b) mobile  `p01_zk_seed`            (services/zkspl, services/stark)
 *   (c) ext.    `p01_privy_zk_seed`
 *   (d) ext.    `p01_zkspl_privy_seed_*`
 *
 * This module is intentionally tiny and dependency-light so it can be imported
 * from any service or screen. TODO(Phase5-UI): replace the simple flag with a
 * full in-app data-loss / re-onboard screen.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** AsyncStorage key for the "user has acknowledged the Privy data-loss notice" flag. */
export const PRIVY_DATA_LOSS_ACK_KEY = 'p01_privy_data_loss_ack_v1';

/** The orphaned seed classes, for display in the warning surface. */
export const PRIVY_ORPHANED_SEED_CLASSES = [
  'mobile p01_note_seed_v1_* (denominated-pool notes)',
  'mobile p01_zk_seed (zkSPL / STARK keyless fallback)',
  'extension p01_privy_zk_seed',
  'extension p01_zkspl_privy_seed_*',
] as const;

/** Human-readable copy for the one-time warning surface. */
export const PRIVY_DATA_LOSS_MESSAGE =
  'Embedded (Privy) wallets are no longer supported. Any shielded balances that ' +
  'were created with a former embedded/email wallet cannot be recovered on this ' +
  'version. Your local seed-phrase wallet and its notes are unaffected.';

/** True once the user has acknowledged the data-loss notice. */
export async function hasAcknowledgedPrivyDataLoss(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PRIVY_DATA_LOSS_ACK_KEY)) === 'true';
  } catch {
    return false;
  }
}

/** Persist the user's acknowledgement of the data-loss notice. */
export async function acknowledgePrivyDataLoss(): Promise<void> {
  try {
    await AsyncStorage.setItem(PRIVY_DATA_LOSS_ACK_KEY, 'true');
  } catch {
    // Best-effort — worst case the notice can surface again next launch.
  }
}
