/**
 * p01_mugen on-chain escrow helper.
 *
 * Builds real token-bearing MugenEscrow PDAs via the p01_mugen program
 * on Solana devnet. Used by the claim-match route as the primary path
 * (reputation receipt remains as a fallback).
 *
 * Program source of truth:
 *   - programs/p01_mugen/src/lib.rs
 *   - programs/p01_mugen/src/instructions/create_order.rs
 *   - programs/p01_mugen/src/instructions/take_order.rs
 *   - programs/p01_mugen/src/state/mod.rs
 */

import * as path from 'path';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import { loadKeypair } from './keypair-loader';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';

// ═══════════════════════════════════════════════════════════════════════════
// Constants — must mirror programs/p01_mugen/src/state/mod.rs
// ═══════════════════════════════════════════════════════════════════════════

export const P01_MUGEN_PROGRAM_ID = new PublicKey(
  'EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN',
);
export const WSOL_MINT = NATIVE_MINT;
export const CONFIG_SEED = Buffer.from('mugen_config');
export const ORDER_SEED = Buffer.from('mugen_order');
export const ESCROW_SEED = Buffer.from('mugen_escrow');
export const VAULT_SEED = Buffer.from('mugen_vault');
export const REPUTATION_SEED = Buffer.from('mugen_rep');

/** Escrow status codes — must mirror programs/p01_mugen/src/state/mod.rs */
export const ESCROW_AWAITING_PAYMENT = 0;
export const ESCROW_PAYMENT_CONFIRMED = 1;
export const ESCROW_RELEASED = 2;
export const ESCROW_DISPUTED = 3;
export const ESCROW_REFUNDED = 4;
export const ESCROW_EXPIRED = 5;

/** SELL_CRYPTO in program constants (state/mod.rs). */
const ORDER_TYPE_SELL_CRYPTO = 1;
/** BUY_CRYPTO in program constants. */
const ORDER_TYPE_BUY_CRYPTO = 0;

// ═══════════════════════════════════════════════════════════════════════════
// PDA helpers
// ═══════════════════════════════════════════════════════════════════════════

export function deriveConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], P01_MUGEN_PROGRAM_ID);
}

export function deriveOrderPDA(
  maker: PublicKey,
  nonce: Uint8Array,
): [PublicKey, number] {
  if (nonce.length !== 16) {
    throw new Error(`order nonce must be 16 bytes, got ${nonce.length}`);
  }
  return PublicKey.findProgramAddressSync(
    [ORDER_SEED, maker.toBuffer(), Buffer.from(nonce)],
    P01_MUGEN_PROGRAM_ID,
  );
}

export function deriveEscrowPDA(
  order: PublicKey,
  taker: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ESCROW_SEED, order.toBuffer(), taker.toBuffer()],
    P01_MUGEN_PROGRAM_ID,
  );
}

export function deriveVaultPDA(escrow: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, escrow.toBuffer()],
    P01_MUGEN_PROGRAM_ID,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Config existence probe
// ═══════════════════════════════════════════════════════════════════════════

/** Returns true iff the MugenConfig singleton PDA is initialized on-chain. */
export async function configExists(connection: Connection): Promise<boolean> {
  const [pda] = deriveConfigPDA();
  const info = await connection.getAccountInfo(pda, 'confirmed');
  return info !== null && info.data.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Taker keypair — env-var-first, no auto-generation.
//
// Resolution order:
//   1. MUGEN_TAKER_KEYPAIR_B64 env var — base64 of 64-byte secret key
//      (canonical on Vercel; filesystem is read-only outside /tmp).
//   2. apps/mugen/.secrets/taker-keypair.json — JSON number array (local dev).
//
// If neither is present we THROW. The previous auto-generate-and-write
// behavior silently created orphan keys on Vercel cold starts (lost SOL).
// Run `pnpm --filter @protocol-01/mugen env:export-keypairs` to produce the
// env value from a local file.
// ═══════════════════════════════════════════════════════════════════════════

let cachedTaker: Keypair | null = null;

export function getTakerKeypair(): Keypair {
  if (cachedTaker) return cachedTaker;

  const fallbackPath = path.resolve(
    process.cwd(),
    '.secrets',
    'taker-keypair.json',
  );

  cachedTaker = loadKeypair('MUGEN_TAKER_KEYPAIR_B64', fallbackPath);
  return cachedTaker;
}

// ═══════════════════════════════════════════════════════════════════════════
// Wrapped-SOL ensure helper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ensure the relayer has an ATA for wSOL holding at least `requiredLamports`.
 * Creates the ATA if missing, transfers SOL into it, and calls sync_native
 * so the token account balance reflects the underlying SOL.
 *
 * Returns the ATA pubkey.
 */
export async function ensureRelayerWrappedSol(
  connection: Connection,
  relayer: Keypair,
  requiredLamports: number,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(
    WSOL_MINT,
    relayer.publicKey,
    false,
  );
  const ixs: TransactionInstruction[] = [];

  let currentBalance = 0n;
  try {
    const account = await getAccount(connection, ata, 'confirmed');
    currentBalance = account.amount;
  } catch {
    // Account doesn't exist — create it.
    ixs.push(
      createAssociatedTokenAccountInstruction(
        relayer.publicKey,
        ata,
        relayer.publicKey,
        WSOL_MINT,
      ),
    );
  }

  if (currentBalance < BigInt(requiredLamports)) {
    const diff = BigInt(requiredLamports) - currentBalance;
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: relayer.publicKey,
        toPubkey: ata,
        lamports: Number(diff),
      }),
    );
    ixs.push(createSyncNativeInstruction(ata));
  }

  if (ixs.length === 0) return ata;

  const { Transaction } = await import('@solana/web3.js');
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = relayer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(relayer);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(sig, 'confirmed');
  return ata;
}

// ═══════════════════════════════════════════════════════════════════════════
// Anchor discriminator + Borsh-ish encoding
// ═══════════════════════════════════════════════════════════════════════════

function anchorDisc(ixName: string): Buffer {
  return Buffer.from(sha256(`global:${ixName}`).slice(0, 8));
}

function u16LE(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}

function i64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n, 0);
  return b;
}

// ═══════════════════════════════════════════════════════════════════════════
// create_order instruction builder
// ═══════════════════════════════════════════════════════════════════════════

export interface BuildCreateOrderArgs {
  maker: PublicKey;
  nonce: Uint8Array; // 16 bytes
  orderType: 'sell' | 'buy';
  cryptoAmount: bigint;
  fiatAmount: bigint;
  fiatCurrency: string; // 3 ASCII uppercase
  paymentMethods: number;
  expiresIn: number; // seconds
  configPDA: PublicKey;
  orderPDA: PublicKey;
  configAuthority: PublicKey; // bypass attestation via authority
  tokenMint: PublicKey;
}

export function buildCreateOrderIx(
  args: BuildCreateOrderArgs,
): TransactionInstruction {
  if (args.nonce.length !== 16) {
    throw new Error(`nonce must be 16 bytes, got ${args.nonce.length}`);
  }
  if (args.fiatCurrency.length !== 3) {
    throw new Error(`fiatCurrency must be 3 ASCII uppercase chars`);
  }

  const disc = anchorDisc('create_order');

  // CreateOrderParams:
  //   order_type: u8
  //   crypto_amount: u64
  //   fiat_amount: u64
  //   fiat_currency: [u8;3]
  //   payment_methods: u16
  //   min_amount: u64
  //   max_amount: u64
  //   reputation_commitment: [u8;32]
  //   nonce: [u8;16]
  //   expires_in: i64
  const orderType =
    args.orderType === 'sell' ? ORDER_TYPE_SELL_CRYPTO : ORDER_TYPE_BUY_CRYPTO;
  const fiatCurrencyBytes = Buffer.from(args.fiatCurrency, 'ascii');
  const minAmount = 0n;
  const maxAmount = 0n; // 0 ⇒ program defaults to crypto_amount
  const reputationCommitment = Buffer.alloc(32); // zero-commitment for MVP

  const params = Buffer.concat([
    Buffer.from([orderType]),
    u64LE(args.cryptoAmount),
    u64LE(args.fiatAmount),
    fiatCurrencyBytes,
    u16LE(args.paymentMethods),
    u64LE(minAmount),
    u64LE(maxAmount),
    reputationCommitment,
    Buffer.from(args.nonce),
    i64LE(BigInt(args.expiresIn)),
  ]);

  const data = Buffer.concat([disc, params]);

  // Account order MUST match CreateOrder<'info> in create_order.rs:
  //   0. maker (signer, mut)
  //   1. config
  //   2. order (mut, init)
  //   3. compliance_attestation  ← passed as config.authority for bypass
  //   4. token_mint
  //   5. system_program
  const keys = [
    { pubkey: args.maker, isSigner: true, isWritable: true },
    { pubkey: args.configPDA, isSigner: false, isWritable: false },
    { pubkey: args.orderPDA, isSigner: false, isWritable: true },
    { pubkey: args.configAuthority, isSigner: false, isWritable: false },
    { pubkey: args.tokenMint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: P01_MUGEN_PROGRAM_ID,
    keys,
    data,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// take_order instruction builder
// ═══════════════════════════════════════════════════════════════════════════

export interface BuildTakeOrderArgs {
  taker: PublicKey;
  seller: PublicKey;
  sellerTokenAccount: PublicKey;
  orderPDA: PublicKey;
  escrowPDA: PublicKey;
  vaultPDA: PublicKey;
  configPDA: PublicKey;
  configAuthority: PublicKey;
  tokenMint: PublicKey;
  stealthRecipient: [number, number] | null; // Option<[u8;32]>
  paymentMethod: number;
}

export function buildTakeOrderIx(
  args: BuildTakeOrderArgs,
): TransactionInstruction {
  const disc = anchorDisc('take_order');

  // Args:
  //   stealth_recipient: Option<[u8;32]>  — 1 byte discriminator + 32 if Some
  //   payment_method: u16
  let stealthBuf: Buffer;
  if (args.stealthRecipient === null) {
    stealthBuf = Buffer.from([0]);
  } else {
    // Accept either a 2-element shorthand (per task signature) or raw 32 bytes.
    // For safety we expand any [number, number] hint into a zero-padded 32 buf.
    const payload = Buffer.alloc(32);
    payload.writeInt8(args.stealthRecipient[0] & 0xff, 0);
    payload.writeInt8(args.stealthRecipient[1] & 0xff, 1);
    stealthBuf = Buffer.concat([Buffer.from([1]), payload]);
  }

  const data = Buffer.concat([disc, stealthBuf, u16LE(args.paymentMethod)]);

  // Account order MUST match TakeOrder<'info> in take_order.rs:
  //   0. taker (signer, mut)
  //   1. config
  //   2. order (mut)
  //   3. escrow (mut, init)
  //   4. escrow_vault (mut, init)  — PDA token account
  //   5. seller_token_account (mut)
  //   6. seller (signer)
  //   7. token_mint
  //   8. taker_attestation       ← bypass = config.authority
  //   9. token_program
  //   10. system_program
  //   11. rent sysvar
  const keys = [
    { pubkey: args.taker, isSigner: true, isWritable: true },
    { pubkey: args.configPDA, isSigner: false, isWritable: false },
    { pubkey: args.orderPDA, isSigner: false, isWritable: true },
    { pubkey: args.escrowPDA, isSigner: false, isWritable: true },
    { pubkey: args.vaultPDA, isSigner: false, isWritable: true },
    { pubkey: args.sellerTokenAccount, isSigner: false, isWritable: true },
    { pubkey: args.seller, isSigner: true, isWritable: false },
    { pubkey: args.tokenMint, isSigner: false, isWritable: false },
    { pubkey: args.configAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: P01_MUGEN_PROGRAM_ID,
    keys,
    data,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Convenience: derive/compile everything for a match given maker+nonce+amount
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Turn a 32-byte maker-nonce pubkey into a 16-byte order nonce by
 * taking the first 16 bytes. Deterministic — same nonce pubkey always
 * maps to the same order PDA.
 */
export function makerNonceToOrderNonce(
  makerNoncePubkey: PublicKey,
): Uint8Array {
  return makerNoncePubkey.toBuffer().subarray(0, 16);
}

/** Re-export so the ASSOCIATED_TOKEN_PROGRAM_ID is available if needed. */
export { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID };

// ═══════════════════════════════════════════════════════════════════════════
// Reputation PDA — p01_mugen "mugen_rep" seed + 32-byte commitment
// ═══════════════════════════════════════════════════════════════════════════

export function deriveReputationPDA(
  commitment: Uint8Array,
): [PublicKey, number] {
  if (commitment.length !== 32) {
    throw new Error(
      `reputation commitment must be 32 bytes, got ${commitment.length}`,
    );
  }
  return PublicKey.findProgramAddressSync(
    [REPUTATION_SEED, Buffer.from(commitment)],
    P01_MUGEN_PROGRAM_ID,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Account decoders
// ═══════════════════════════════════════════════════════════════════════════

export interface MugenEscrowState {
  status: number;
  maker: PublicKey;
  taker: PublicKey;
  cryptoAmount: bigint;
  fiatAmount: bigint;
  expiresAt: number;
  paymentConfirmedAt: number;
  vault: PublicKey;
  tokenMint: PublicKey;
  disputeReason: number;
  disputeInitiator: PublicKey;
}

/**
 * Read and decode a MugenEscrow account. Returns null if missing.
 *
 * Layout (after 8-byte Anchor discriminator):
 *   order(32) + maker(32) + taker(32) + token_mint(32) + crypto_amount(u64)
 *   + fiat_amount(u64) + escrow_vault(32) + maker_attestation(32)
 *   + taker_attestation(32) + stealth_recipient(32) + payment_method(u16)
 *   + status(u8) + created_at(i64) + expires_at(i64) + payment_confirmed_at(i64)
 *   + dispute_initiator(32) + dispute_reason(u8) + bump(u8) + vault_bump(u8)
 */
export async function readMugenEscrow(
  connection: Connection,
  escrowPDA: PublicKey,
): Promise<MugenEscrowState | null> {
  const info = await connection.getAccountInfo(escrowPDA, 'confirmed');
  if (!info) return null;
  const data = Buffer.from(info.data);
  if (data.length < 312) return null;

  let offset = 8; // skip Anchor discriminator
  /* order */ offset += 32;
  const maker = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const taker = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const tokenMint = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const cryptoAmount = data.readBigUInt64LE(offset);
  offset += 8;
  const fiatAmount = data.readBigUInt64LE(offset);
  offset += 8;
  const vault = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  /* maker_attestation */ offset += 32;
  /* taker_attestation */ offset += 32;
  /* stealth_recipient */ offset += 32;
  /* payment_method */ offset += 2;
  const status = data.readUInt8(offset);
  offset += 1;
  /* created_at */ offset += 8;
  const expiresAt = Number(data.readBigInt64LE(offset));
  offset += 8;
  const paymentConfirmedAt = Number(data.readBigInt64LE(offset));
  offset += 8;
  const disputeInitiator = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const disputeReason = data.readUInt8(offset);

  return {
    status,
    maker,
    taker,
    cryptoAmount,
    fiatAmount,
    expiresAt,
    paymentConfirmedAt,
    vault,
    tokenMint,
    disputeReason,
    disputeInitiator,
  };
}

export interface MugenConfigState {
  authority: PublicKey;
  p01FeeWallet: PublicKey;
  mugenFeeWallet: PublicKey;
  treasuryWallet: PublicKey;
  noiseFundWallet: PublicKey;
  feeBps: number;
}

/**
 * Read and decode the MugenConfig singleton PDA.
 *
 * Layout (after 8-byte Anchor discriminator):
 *   authority(32) + fee_bps(u16) + p01_fee_wallet(32) + mugen_fee_wallet(32)
 *   + treasury_wallet(32) + p01_fee_share(u16) + mugen_fee_share(u16)
 *   + noise_fund_wallet(32) + noise_fee_share(u16) + ...
 */
export async function readMugenConfig(
  connection: Connection,
): Promise<MugenConfigState | null> {
  const [configPDA] = deriveConfigPDA();
  const info = await connection.getAccountInfo(configPDA, 'confirmed');
  if (!info) return null;
  const data = Buffer.from(info.data);

  let offset = 8; // skip Anchor discriminator
  const authority = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const feeBps = data.readUInt16LE(offset);
  offset += 2;
  const p01FeeWallet = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const mugenFeeWallet = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const treasuryWallet = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  /* p01_fee_share */ offset += 2;
  /* mugen_fee_share */ offset += 2;
  const noiseFundWallet = new PublicKey(data.subarray(offset, offset + 32));

  return {
    authority,
    p01FeeWallet,
    mugenFeeWallet,
    treasuryWallet,
    noiseFundWallet,
    feeBps,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// confirm_payment instruction builder
//
// ConfirmPayment<'info> (confirm_payment.rs):
//   0. buyer (signer)
//   1. escrow (mut)
// Args: none.
// ═══════════════════════════════════════════════════════════════════════════

export interface BuildConfirmPaymentArgs {
  buyer: PublicKey;
  escrowPDA: PublicKey;
}

export function buildConfirmPaymentIx(
  args: BuildConfirmPaymentArgs,
): TransactionInstruction {
  const disc = anchorDisc('confirm_payment');
  return new TransactionInstruction({
    programId: P01_MUGEN_PROGRAM_ID,
    keys: [
      { pubkey: args.buyer, isSigner: true, isWritable: false },
      { pubkey: args.escrowPDA, isSigner: false, isWritable: true },
    ],
    data: disc,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// dispute_escrow instruction builder
//
// DisputeEscrow<'info> (dispute_escrow.rs):
//   0. disputer (signer)
//   1. escrow (mut)
// Args: reason: u8
// ═══════════════════════════════════════════════════════════════════════════

export interface BuildDisputeEscrowArgs {
  disputer: PublicKey;
  escrowPDA: PublicKey;
  reason: number;
}

export function buildDisputeEscrowIx(
  args: BuildDisputeEscrowArgs,
): TransactionInstruction {
  const disc = anchorDisc('dispute_escrow');
  const reasonByte = Buffer.from([args.reason & 0xff]);
  const data = Buffer.concat([disc, reasonByte]);
  return new TransactionInstruction({
    programId: P01_MUGEN_PROGRAM_ID,
    keys: [
      { pubkey: args.disputer, isSigner: true, isWritable: false },
      { pubkey: args.escrowPDA, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// release_escrow instruction builder
//
// ReleaseEscrow<'info> (release_escrow.rs):
//   0. seller (signer)
//   1. config (mut)
//   2. escrow (mut)
//   3. escrow_vault (mut)
//   4. buyer_token_account (mut)
//   5. p01_fee_account (mut)
//   6. mugen_fee_account (mut)
//   7. treasury_fee_account (mut)
//   8. noise_fund_account (mut)
//   9. maker_reputation (mut)
//   10. taker_reputation (mut)
//   11. token_program
// Args: none.
// ═══════════════════════════════════════════════════════════════════════════

export interface BuildReleaseEscrowArgs {
  seller: PublicKey;
  configPDA: PublicKey;
  escrowPDA: PublicKey;
  vaultPDA: PublicKey;
  buyerTokenAccount: PublicKey;
  p01FeeAccount: PublicKey;
  mugenFeeAccount: PublicKey;
  treasuryFeeAccount: PublicKey;
  noiseFundAccount: PublicKey;
  makerReputationPDA: PublicKey;
  takerReputationPDA: PublicKey;
}

export function buildReleaseEscrowIx(
  args: BuildReleaseEscrowArgs,
): TransactionInstruction {
  const disc = anchorDisc('release_escrow');
  return new TransactionInstruction({
    programId: P01_MUGEN_PROGRAM_ID,
    keys: [
      { pubkey: args.seller, isSigner: true, isWritable: false },
      { pubkey: args.configPDA, isSigner: false, isWritable: true },
      { pubkey: args.escrowPDA, isSigner: false, isWritable: true },
      { pubkey: args.vaultPDA, isSigner: false, isWritable: true },
      { pubkey: args.buyerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: args.p01FeeAccount, isSigner: false, isWritable: true },
      { pubkey: args.mugenFeeAccount, isSigner: false, isWritable: true },
      { pubkey: args.treasuryFeeAccount, isSigner: false, isWritable: true },
      { pubkey: args.noiseFundAccount, isSigner: false, isWritable: true },
      { pubkey: args.makerReputationPDA, isSigner: false, isWritable: true },
      { pubkey: args.takerReputationPDA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: disc,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// init_reputation instruction builder
//
// InitReputation<'info> (init_reputation.rs):
//   0. payer (signer, mut)
//   1. reputation (mut, init)
//   2. system_program
// Args: commitment: [u8;32]
// ═══════════════════════════════════════════════════════════════════════════

export interface BuildInitReputationArgs {
  payer: PublicKey;
  reputationPDA: PublicKey;
  commitment: Uint8Array;
}

export function buildInitReputationIx(
  args: BuildInitReputationArgs,
): TransactionInstruction {
  if (args.commitment.length !== 32) {
    throw new Error(
      `init_reputation commitment must be 32 bytes, got ${args.commitment.length}`,
    );
  }
  const disc = anchorDisc('init_reputation');
  const data = Buffer.concat([disc, Buffer.from(args.commitment)]);
  return new TransactionInstruction({
    programId: P01_MUGEN_PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.reputationPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
