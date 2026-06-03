/**
 * Active-wallet signer helpers for the Extension.
 *
 * Post Privy-removal there were two signing paths to centralize; with Ledger
 * (docs/pairing-ledger-spec.md §3 S4) there are now TWO WALLET KINDS:
 *   - 'local-seed' : the in-memory Keypair held by the wallet store. The note
 *     seed is `keypair.secretKey.slice(0, 32)` (raw, §0).
 *   - 'hardware'   : a Ledger that co-signs on-chain. The note seed is a SEPARATE
 *     CSPRNG 32-byte value, encrypted at rest (services/ledger/spendingSeed.ts),
 *     fed RAW to the SAME note consumers in the SAME position (§0).
 *
 * These helpers are the single seam every ZK service uses, so the branch on
 * walletKind lives in ONE place. `getActiveSigner` returns the right WalletSigner
 * (local `tx.sign(keypair)` OR Ledger device co-sign); `getWalletSeed` returns the
 * RAW 32-byte note seed for whichever kind is active.
 */

import { PublicKey, Transaction } from '@solana/web3.js';
import { useWalletStore } from '../store/wallet';
import { getConnection } from './wallet';
import { getSessionPassword } from './sessionCrypto';
import type { WalletSigner } from './stark';
import { makeLedgerWalletSigner, getSpendingSeed as getLedgerSpendingSeed } from './ledger';

/**
 * Build a WalletSigner + connection from the current wallet store state.
 * Branches on walletKind:
 *   - hardware  → a Ledger device co-signer (proof → assemble → fresh blockhash →
 *     device-sign ordering is enforced by the SERVICE calling signTransaction
 *     last; see services/ledger/signer.ts).
 *   - local-seed→ the in-memory keypair.
 * Throws if the wallet is not unlocked / no signing material is available.
 *
 * `onBeforeSign` (hardware only) is invoked right before the device prompt so a
 * caller can surface the per-sign review modal (blind-sign explainer / 0x6808).
 */
export function getActiveSigner(opts?: { onBeforeSign?: () => void }): {
  signer: WalletSigner;
  connection: ReturnType<typeof getConnection>;
} {
  const walletState = useWalletStore.getState();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const connection = getConnection(walletState.network);

  // ── Hardware (Ledger) ──────────────────────────────────────────────────────
  if (walletState.walletKind === 'hardware') {
    if (!walletState.ledgerPath) {
      throw new Error('Ledger wallet has no derivation path. Reconnect your Ledger.');
    }
    const signer = makeLedgerWalletSigner({
      publicKey: walletState.publicKey,
      ledgerPath: walletState.ledgerPath,
      onBeforeSign: opts?.onBeforeSign,
    });
    return { signer, connection };
  }

  // ── Local seed ──────────────────────────────────────────────────────────────
  const keypair = walletState._keypair;
  if (!keypair) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const signer: WalletSigner = {
    publicKey: walletPublicKey,
    signTransaction: async (tx: Transaction): Promise<Transaction> => {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      if (!tx.recentBlockhash) tx.recentBlockhash = blockhash;
      if (!tx.feePayer) tx.feePayer = walletPublicKey;
      tx.sign(keypair);
      return tx;
    },
  };

  return { signer, connection };
}

/**
 * Derive the RAW 32-byte wallet note-seed for the ACTIVE wallet (§0).
 *
 *   - local-seed → `keypair.secretKey.slice(0, 32)`.
 *   - hardware   → decrypt the separate CSPRNG spending seed with the cached
 *     session password. Fed RAW to the SAME note consumers; NEVER HKDF'd.
 *
 * Async because the hardware path decrypts at rest. The caller should treat the
 * returned bytes as sensitive (the local-seed path returns a fresh slice copy;
 * the hardware path a fresh decrypted buffer the caller may `fill(0)`).
 *
 * Throws if locked / no signing material / (hardware) no cached password.
 */
export async function getWalletSeed(): Promise<Uint8Array> {
  const walletState = useWalletStore.getState();

  if (walletState.walletKind === 'hardware') {
    if (!walletState.publicKey) {
      throw new Error('Cannot derive wallet seed: Ledger wallet not initialized.');
    }
    const password = getSessionPassword();
    if (!password) {
      throw new Error(
        'Cannot derive hardware wallet seed: locked. Unlock the wallet and try again.',
      );
    }
    return getLedgerSpendingSeed(walletState.publicKey, password);
  }

  const keypair = walletState._keypair;
  if (!keypair) {
    throw new Error('Cannot derive wallet seed: wallet is locked. Unlock and try again.');
  }
  return keypair.secretKey.slice(0, 32);
}
