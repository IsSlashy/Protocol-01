/**
 * Mock: @solana/spl-token
 */
import { PublicKey } from '../@solana/web3.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey, _allowOwnerOffCurve?: boolean): PublicKey {
  return new PublicKey(mint.toBase58() + owner.toBase58());
}

export function createAssociatedTokenAccountInstruction(
  payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey
): any {
  return { programId: ASSOCIATED_TOKEN_PROGRAM_ID, keys: [], data: Buffer.alloc(0) };
}

export function createTransferInstruction(
  source: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint | number
): any {
  return { programId: TOKEN_PROGRAM_ID, keys: [], data: Buffer.alloc(0) };
}
