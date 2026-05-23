/**
 * Auto-deposit poller: Ed25519 (owner_id) → Quantum vault PDA.
 *
 * Subscribes to account changes on the user's owner_id pubkey. Every time
 * lamports cross the trigger threshold, we fire a `deposit` ix moving the
 * surplus into the quantum wallet PDA. The user perceives a single unified
 * balance; the Ed25519 layer is plumbing.
 *
 * Single-flight per (owner_id) — we won't enqueue a second deposit while
 * one is in flight. The on-chain `deposit` is idempotent at the protocol
 * level (it just transfers a fresh `amount`), but double-spend on the same
 * lamports is wasteful. The single-flight guard lives in the caller's store.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  AUTO_DEPOSIT_KEEP_LAMPORTS,
  AUTO_DEPOSIT_TRIGGER_LAMPORTS,
  buildDepositIx,
} from './index';

export interface AutoDepositResult {
  txSignature: string;
  depositedLamports: number;
}

/** One-shot: if Ed25519 balance is above the trigger, sweep the surplus into
 *  the quantum wallet. Returns null if nothing to do.
 *
 *  `ownerKeypair` is the Ed25519 keypair that owns the lamports — used to
 *  sign the deposit. In production this lives in SecureStore. For Privy
 *  wallets we'd swap to a WalletSigner. */
export async function autoDepositOnce(args: {
  connection: Connection;
  ownerKeypair: Keypair;
}): Promise<AutoDepositResult | null> {
  const balance = await args.connection.getBalance(args.ownerKeypair.publicKey, 'confirmed');
  if (balance < AUTO_DEPOSIT_TRIGGER_LAMPORTS) return null;

  const surplus = balance - AUTO_DEPOSIT_KEEP_LAMPORTS;
  if (surplus <= 0) return null;

  const ix = buildDepositIx({
    depositor: args.ownerKeypair.publicKey,
    ownerId: args.ownerKeypair.publicKey,
    amount: surplus,
  });

  const tx = new Transaction().add(ix);
  const { blockhash } = await args.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = args.ownerKeypair.publicKey;
  tx.partialSign(args.ownerKeypair);

  const sig = await args.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await args.connection.confirmTransaction(sig, 'confirmed');

  return { txSignature: sig, depositedLamports: surplus };
}

/** Subscribe to balance changes and fire `onChange` whenever the Ed25519
 *  side changes by ≥1 lamport. Returns an unsubscribe fn. The subscription
 *  uses WebSocket (`onAccountChange`) so we don't poll the RPC. */
export function subscribeOwnerBalance(args: {
  connection: Connection;
  ownerId: PublicKey;
  onChange: (newLamports: number) => void;
}): () => void {
  const subId = args.connection.onAccountChange(
    args.ownerId,
    (info) => {
      args.onChange(info.lamports);
    },
    'confirmed',
  );
  return () => {
    args.connection.removeAccountChangeListener(subId).catch(() => {});
  };
}
