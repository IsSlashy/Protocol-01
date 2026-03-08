/**
 * Resets all privacy-related stores when switching wallets.
 * Prevents data leaking from one wallet to another.
 */

import { useShieldedStore } from './shieldedStore';
import { useDenominatedPoolStore } from './denominatedPoolStore';
import { useConfidentialStore } from './confidentialStore';
import { useStreamStore } from './streamStore';
import { useSubscriptionVaultStore } from './subscriptionVaultStore';
import { useSharingStore } from './sharingStore';

export async function resetAllPrivacyStores(): Promise<void> {
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
