/**
 * Active-wallet signer helpers for the Extension.
 *
 * Post Privy-removal there is exactly ONE signing path: the local keypair held
 * (in memory only) by the wallet store. These helpers centralize the "build a
 * WalletSigner / derive the note seed from the active wallet" logic so the ZK
 * services don't each re-implement it (and so there is a single place to wire
 * external / hardware signers in Phase 3/4).
 */

import { PublicKey, Transaction } from '@solana/web3.js';
import { useWalletStore } from '../store/wallet';
import { getConnection } from './wallet';
import type { WalletSigner } from './stark';

/**
 * Build a WalletSigner + connection from the current wallet store state.
 * Throws if the wallet is not unlocked (no local keypair available).
 */
export function getActiveSigner(): { signer: WalletSigner; connection: ReturnType<typeof getConnection> } {
  const walletState = useWalletStore.getState();

  if (!walletState.publicKey) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const keypair = walletState._keypair;
  if (!keypair) {
    throw new Error('Wallet not unlocked. Please unlock your wallet first.');
  }

  const walletPublicKey = new PublicKey(walletState.publicKey);
  const connection = getConnection(walletState.network);

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
 * Derive the 32-byte wallet note-seed from the active local keypair.
 * Mirrors mobile (`secretKey.slice(0, 32)`). Throws if locked.
 */
export function getWalletSeed(): Uint8Array {
  const keypair = useWalletStore.getState()._keypair;
  if (!keypair) {
    throw new Error('Cannot derive wallet seed: wallet is locked. Unlock and try again.');
  }
  return keypair.secretKey.slice(0, 32);
}
