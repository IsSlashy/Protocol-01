import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { WalletAdapter } from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import { isValidPublicKey, solToLamports } from '../utils/helpers';

// [2026-09-13] `sendPrivate` (a stealth send announced through the `specter`
// program) and `estimateTransferFee` (its split-count fee model) left this
// module when that program was closed on devnet on 2026-09-13. Private
// payments go through the shielded pool; this file keeps the one transfer
// that never touched that program.

/**
 * Send a plain SOL or SPL-token transfer to a public key.
 *
 * Nothing about this call is private: the sender, the recipient and the
 * amount are all on the wire.
 */
export async function sendPublic(
  connection: Connection,
  sender: Keypair | WalletAdapter,
  recipient: string,
  amount: number,
  tokenMint?: PublicKey
): Promise<{ signature: string }> {
  if (!isValidPublicKey(recipient)) {
    throw new SpecterError(
      SpecterErrorCode.INVALID_RECIPIENT,
      'Invalid recipient public key. Expected a valid Solana public key (base58-encoded, 32-44 characters).'
    );
  }

  const recipientPubKey = new PublicKey(recipient);
  const senderPubKey =
    sender.publicKey;
  const amountLamports = tokenMint
    ? BigInt(Math.round(amount * 1e9))
    : solToLamports(amount);

  const transaction = new Transaction();

  if (tokenMint) {
    const senderAta = await getAssociatedTokenAddress(tokenMint, senderPubKey);
    const recipientAta = await getAssociatedTokenAddress(tokenMint, recipientPubKey);

    transaction.add(
      createTransferInstruction(
        senderAta,
        recipientAta,
        senderPubKey,
        amountLamports,
        [],
        TOKEN_PROGRAM_ID
      )
    );
  } else {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: senderPubKey,
        toPubkey: recipientPubKey,
        lamports: amountLamports,
      })
    );
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = senderPubKey;

  let signature: string;
  if ('secretKey' in sender) {
    signature = await sendAndConfirmTransaction(connection, transaction, [sender]);
  } else {
    const signedTx = await sender.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signedTx.serialize());
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });
  }

  return { signature };
}
