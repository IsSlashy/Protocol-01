import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * On-chain v2 hybrid stealth announcements (X25519 + ML-KEM-768).
 *
 * The 1088-byte KEM ciphertext cannot ride in a transaction memo (1232-byte
 * cap) or a single instruction, so the sender streams it into a program-owned
 * PDA with `init_stealth_v2` + `write_stealth_kem_chunk`. Recipients discover
 * announcements with `getProgramAccounts` (no memo, no external indexer).
 *
 * Instruction / account discriminators are Anchor's `sha256("global:<name>")`
 * / `sha256("account:<Name>")` first 8 bytes, computed here so they stay in
 * sync with the program without shipping an IDL.
 */

export const STEALTH_V2_SEED = utf8ToBytes('stealth_v2');
export const MLKEM768_CIPHERTEXT_LEN = 1088;
/** discriminator(8)+version(1)+eph(32)+addr(32)+viewTag(1)+amount(8)+mint(32)+slot(8)+claimed(1)+createdAt(8)+bump(1)+kem(1088) */
export const STEALTH_V2_ACCOUNT_LEN = 1220;
/** Chunk size for streaming the KEM ciphertext (fits well inside a tx). */
export const KEM_CHUNK_SIZE = 544;

function anchorDiscriminator(prefix: string, name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`${prefix}:${name}`)).slice(0, 8));
}

export const IX_INIT_STEALTH_V2 = anchorDiscriminator('global', 'init_stealth_v2');
export const IX_WRITE_KEM_CHUNK = anchorDiscriminator('global', 'write_stealth_kem_chunk');
export const ACCT_STEALTH_V2 = anchorDiscriminator('account', 'StealthAccountV2');

/** Derive the announcement PDA: ["stealth_v2", sender, stealthAddress]. */
export function deriveAnnouncementPda(
  sender: PublicKey,
  stealthAddress: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(STEALTH_V2_SEED), sender.toBuffer(), stealthAddress.toBuffer()],
    programId,
  );
}

/** `init_stealth_v2(amount, ephemeral_pub_key, stealth_address, view_tag)` — header only. */
export function buildInitStealthV2Ix(params: {
  programId: PublicKey;
  sender: PublicKey;
  stealthAddress: PublicKey;
  amount: bigint;
  ephemeralPubKey: Uint8Array;
  viewTag: number;
}): TransactionInstruction {
  const { programId, sender, stealthAddress, amount, ephemeralPubKey, viewTag } = params;
  const [pda] = deriveAnnouncementPda(sender, stealthAddress, programId);

  const amt = Buffer.alloc(8);
  amt.writeBigUInt64LE(amount);
  const data = Buffer.concat([
    IX_INIT_STEALTH_V2,
    amt,
    Buffer.from(ephemeralPubKey),
    stealthAddress.toBuffer(),
    Buffer.from([viewTag & 0xff]),
  ]);

  return new TransactionInstruction({
    programId,
    data,
    keys: [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

/** `write_stealth_kem_chunk(stealth_address, offset, chunk)`. */
export function buildWriteKemChunkIx(params: {
  programId: PublicKey;
  sender: PublicKey;
  stealthAddress: PublicKey;
  offset: number;
  chunk: Uint8Array;
}): TransactionInstruction {
  const { programId, sender, stealthAddress, offset, chunk } = params;
  const [pda] = deriveAnnouncementPda(sender, stealthAddress, programId);

  const off = Buffer.alloc(2);
  off.writeUInt16LE(offset);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(chunk.length);
  const data = Buffer.concat([
    IX_WRITE_KEM_CHUNK,
    stealthAddress.toBuffer(),
    off,
    len,
    Buffer.from(chunk),
  ]);

  return new TransactionInstruction({
    programId,
    data,
    keys: [
      { pubkey: sender, isSigner: true, isWritable: false },
      { pubkey: pda, isSigner: false, isWritable: true },
    ],
  });
}

/** Split a 1088-byte KEM ciphertext into write instructions. */
export function buildKemChunkIxs(params: {
  programId: PublicKey;
  sender: PublicKey;
  stealthAddress: PublicKey;
  kemCiphertext: Uint8Array;
}): TransactionInstruction[] {
  const { programId, sender, stealthAddress, kemCiphertext } = params;
  const ixs: TransactionInstruction[] = [];
  for (let offset = 0; offset < kemCiphertext.length; offset += KEM_CHUNK_SIZE) {
    ixs.push(
      buildWriteKemChunkIx({
        programId,
        sender,
        stealthAddress,
        offset,
        chunk: kemCiphertext.subarray(offset, Math.min(offset + KEM_CHUNK_SIZE, kemCiphertext.length)),
      }),
    );
  }
  return ixs;
}

export interface DecodedStealthV2 {
  version: number;
  ephemeralPubKey: Uint8Array;
  stealthAddress: PublicKey;
  viewTag: number;
  amount: bigint;
  tokenMint: PublicKey;
  slot: bigint;
  claimed: boolean;
  createdAt: bigint;
  bump: number;
  kemCiphertext: Uint8Array;
}

/** Decode a `StealthAccountV2` account buffer (discriminator already present). */
export function decodeStealthV2(data: Uint8Array): DecodedStealthV2 {
  const buf = Buffer.from(data);
  let o = 8; // discriminator
  const version = buf.readUInt8(o); o += 1;
  const ephemeralPubKey = Uint8Array.from(buf.subarray(o, o + 32)); o += 32;
  const stealthAddress = new PublicKey(buf.subarray(o, o + 32)); o += 32;
  const viewTag = buf.readUInt8(o); o += 1;
  const amount = buf.readBigUInt64LE(o); o += 8;
  const tokenMint = new PublicKey(buf.subarray(o, o + 32)); o += 32;
  const slot = buf.readBigUInt64LE(o); o += 8;
  const claimed = buf.readUInt8(o) === 1; o += 1;
  const createdAt = buf.readBigInt64LE(o); o += 8;
  const bump = buf.readUInt8(o); o += 1;
  const kemCiphertext = Uint8Array.from(buf.subarray(o, o + MLKEM768_CIPHERTEXT_LEN));
  return { version, ephemeralPubKey, stealthAddress, viewTag, amount, tokenMint, slot, claimed, createdAt, bump, kemCiphertext };
}

/** Fetch all v2 stealth announcements from the program via getProgramAccounts. */
export async function fetchV2Announcements(
  connection: Connection,
  programId: PublicKey,
): Promise<DecodedStealthV2[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { dataSize: STEALTH_V2_ACCOUNT_LEN },
      { memcmp: { offset: 0, bytes: bs58Encode(ACCT_STEALTH_V2) } },
    ],
  });
  return accounts.map(({ account }) => decodeStealthV2(account.data));
}

// Minimal base58 encode for the 8-byte discriminator (avoids a bs58 import cycle).
function bs58Encode(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let x = 0n;
  for (const b of bytes) x = (x << 8n) + BigInt(b);
  let out = '';
  while (x > 0n) { const m = Number(x % 58n); out = ALPHABET[m] + out; x /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}
