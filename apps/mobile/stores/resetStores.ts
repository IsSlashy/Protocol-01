/**
 * Resets all privacy-related stores when switching wallets.
 * Archives notes for the outgoing wallet first, so they can be restored later.
 */

import { useShieldedStore, archiveShieldedForWallet, restoreShieldedForWallet } from './shieldedStore';
import { useDenominatedPoolStore, archiveNotesForWallet, restoreNotesForWallet } from './denominatedPoolStore';
import { useConfidentialStore } from './confidentialStore';
import { useStreamStore } from './streamStore';
import { useSubscriptionVaultStore } from './subscriptionVaultStore';
import { useSharingStore } from './sharingStore';

/**
 * Archive notes for the current wallet, then reset all privacy stores.
 * Call this BEFORE switching wallets so notes are not lost.
 */
export async function resetAllPrivacyStores(outgoingWalletAddress?: string): Promise<void> {
  // Archive notes for the outgoing wallet before wiping
  if (outgoingWalletAddress) {
    await archiveNotesForWallet(outgoingWalletAddress);
    await archiveShieldedForWallet(outgoingWalletAddress);
  }

  // Reset shielded notes (ZK)
  try { useShieldedStore.getState().reset(); } catch {}

  // Reset denominated pool notes
  try { useDenominatedPoolStore.getState().reset(); } catch {}

  // Reset confidential balances (zkSPL)
  try { useConfidentialStore.getState().reset(); } catch {}

  // Reset streams
  try { await useStreamStore.getState().resetAll(); } catch {}

  // Reset subscription vaults (also clears SecureStore secrets)
  try { useSubscriptionVaultStore.getState().reset(); } catch {}

  // Cancel any active sharing session
  try { useSharingStore.getState().cancelSession(); } catch {}
}

/**
 * Restore archived notes for a wallet after switching to it.
 * Call this AFTER the wallet is initialized.
 */
export async function restorePrivacyStoresForWallet(walletAddress: string): Promise<void> {
  if (!walletAddress) return;
  await restoreNotesForWallet(walletAddress);
  await restoreShieldedForWallet(walletAddress);
}
