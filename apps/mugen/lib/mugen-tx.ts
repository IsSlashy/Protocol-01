/**
 * Mugen Exchange — Transaction builders for on-chain interactions.
 *
 * These functions build unsigned transactions that can be signed
 * by the P01 extension wallet or sent to mobile for signing.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
  Keypair,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const MUGEN_PROGRAM_ID = new PublicKey('EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN');

const CONFIG_SEED = Buffer.from('mugen_config');
const ORDER_SEED = Buffer.from('mugen_order');
const ESCROW_SEED = Buffer.from('mugen_escrow');
const VAULT_SEED = Buffer.from('mugen_vault');
const REPUTATION_SEED = Buffer.from('mugen_rep');

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.devnet.solana.com';

function anchorDisc(name: string): Buffer {
  // sha256("global:<name>")[0..8]
  const encoder = new TextEncoder();
  const data = encoder.encode(`global:${name}`);
  // Use SubtleCrypto in edge runtime
  // For server-side, we use a simple hash
  const { createHash } = require('crypto');
  const hash = createHash('sha256').update(Buffer.from(data)).digest();
  return Buffer.from(hash.subarray(0, 8));
}

function getConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], MUGEN_PROGRAM_ID);
}

function getEscrowPDA(order: PublicKey, taker: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ESCROW_SEED, order.toBuffer(), taker.toBuffer()],
    MUGEN_PROGRAM_ID,
  );
}

function getVaultPDA(escrow: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, escrow.toBuffer()],
    MUGEN_PROGRAM_ID,
  );
}

export interface TakeOrderParams {
  orderAddress: string;
  takerWallet: string;
  tokenMint: string;
  sellerTokenAccount: string;
  paymentMethod: number;
  stealthRecipient?: Uint8Array;
}

/**
 * Build a takeOrder transaction (partially unsigned).
 *
 * Two signers required:
 *   1. Taker (buyer) — signs client-side (extension/mobile)
 *   2. Seller (maker) — co-signs server-side if seller is the bot
 *
 * The seller pubkey is read from the order account on-chain (maker field).
 * The returned `sellerWallet` tells the caller who needs to co-sign.
 */
export async function buildTakeOrderTx(params: TakeOrderParams): Promise<{
  transaction: string; // base64 serialized
  escrowAddress: string;
  sellerWallet: string; // seller pubkey that must co-sign
}> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const [configPDA] = getConfigPDA();
  const orderPubkey = new PublicKey(params.orderAddress);
  const takerPubkey = new PublicKey(params.takerWallet);
  const tokenMint = new PublicKey(params.tokenMint);
  const sellerTokenAccount = new PublicKey(params.sellerTokenAccount);

  // Read the order to get the REAL seller (maker) pubkey
  const orderInfo = await connection.getAccountInfo(orderPubkey);
  if (!orderInfo) throw new Error('Order account not found');
  const orderData = Buffer.from(orderInfo.data);
  const sellerPubkey = new PublicKey(orderData.subarray(8, 40)); // maker field

  const [escrowPDA] = getEscrowPDA(orderPubkey, takerPubkey);
  const [vaultPDA] = getVaultPDA(escrowPDA);

  // Authority key (for attestation bypass on devnet)
  const configAccount = await connection.getAccountInfo(configPDA);
  let authorityKey = takerPubkey;
  if (configAccount) {
    const data = Buffer.from(configAccount.data);
    authorityKey = new PublicKey(data.subarray(8, 40));
  }

  // Encode: disc(8) + option<[u8;32]>(1 + 0|32) + u16
  const disc = anchorDisc('take_order');
  const hasStealthRecipient = params.stealthRecipient && params.stealthRecipient.some(b => b !== 0);
  const dataLen = 8 + 1 + (hasStealthRecipient ? 32 : 0) + 2;
  const data = Buffer.alloc(dataLen);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  if (hasStealthRecipient && params.stealthRecipient) {
    data.writeUInt8(1, offset); offset += 1;
    Buffer.from(params.stealthRecipient).copy(data, offset); offset += 32;
  } else {
    data.writeUInt8(0, offset); offset += 1;
  }
  data.writeUInt16LE(params.paymentMethod, offset);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: takerPubkey, isSigner: true, isWritable: true },       // taker
      { pubkey: configPDA, isSigner: false, isWritable: false },        // config
      { pubkey: orderPubkey, isSigner: false, isWritable: true },       // order
      { pubkey: escrowPDA, isSigner: false, isWritable: true },         // escrow (init)
      { pubkey: vaultPDA, isSigner: false, isWritable: true },          // vault (init)
      { pubkey: sellerTokenAccount, isSigner: false, isWritable: true },// seller ATA
      { pubkey: sellerPubkey, isSigner: true, isWritable: false },      // seller (REAL maker, must co-sign)
      { pubkey: tokenMint, isSigner: false, isWritable: false },        // mint
      { pubkey: authorityKey, isSigner: false, isWritable: false },     // attestation bypass
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    programId: MUGEN_PROGRAM_ID,
    data,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(ix);

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = takerPubkey;

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    transaction: serialized.toString('base64'),
    escrowAddress: escrowPDA.toBase58(),
    sellerWallet: sellerPubkey.toBase58(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE ORDER
// ═══════════════════════════════════════════════════════════════════════════════

export interface CreateOrderParams {
  makerWallet: string;
  tokenMint: string;
  orderType: number;       // 0 = buy_crypto, 1 = sell_crypto
  cryptoAmount: bigint;    // in base units (lamports / smallest token unit)
  fiatAmount: bigint;      // in cents
  fiatCurrency: string;    // 3-char ISO code, e.g. "USD"
  paymentMethods: number;  // bitfield
  minAmount?: bigint;
  maxAmount?: bigint;
  expiresIn?: bigint;      // seconds (default 86400 = 24h)
}

/**
 * Build a createOrder transaction (unsigned).
 * Generates a random 16-byte nonce and 32-byte reputation commitment.
 */
export async function buildCreateOrderTx(params: CreateOrderParams): Promise<{
  transaction: string; // base64 serialized
  orderAddress: string;
  nonce: string; // hex
}> {
  const { randomBytes } = require('crypto');
  const connection = new Connection(RPC_URL, 'confirmed');
  const makerPubkey = new PublicKey(params.makerWallet);
  const tokenMint = new PublicKey(params.tokenMint);
  const [configPDA] = getConfigPDA();

  // Generate random nonce (16 bytes) and reputation commitment (32 bytes)
  const nonce: Buffer = randomBytes(16);
  const reputationCommitment: Buffer = randomBytes(32);

  // Derive order PDA: seeds = ["mugen_order", maker, nonce]
  const [orderPDA] = PublicKey.findProgramAddressSync(
    [ORDER_SEED, makerPubkey.toBuffer(), nonce],
    MUGEN_PROGRAM_ID,
  );

  // For devnet: use config.authority as compliance_attestation (authority bypass)
  const configAccount = await connection.getAccountInfo(configPDA);
  let complianceAttestation = makerPubkey;
  if (configAccount) {
    const configData = Buffer.from(configAccount.data);
    complianceAttestation = new PublicKey(configData.subarray(8, 40)); // authority field
  }

  // Encode fiat currency as 3-byte ASCII
  const fiatCurrencyBytes = Buffer.alloc(3);
  Buffer.from(params.fiatCurrency.slice(0, 3).toUpperCase(), 'ascii').copy(fiatCurrencyBytes);

  const minAmount = params.minAmount ?? BigInt(0);
  const maxAmount = params.maxAmount ?? BigInt(0);
  const expiresIn = params.expiresIn ?? BigInt(86400);

  // Instruction data layout:
  // disc(8) + order_type(u8,1) + crypto_amount(u64,8) + fiat_amount(u64,8) +
  // fiat_currency([u8;3],3) + payment_methods(u16,2) + min_amount(u64,8) +
  // max_amount(u64,8) + reputation_commitment([u8;32],32) + nonce([u8;16],16) + expires_in(i64,8)
  const disc = anchorDisc('create_order');
  const dataLen = 8 + 1 + 8 + 8 + 3 + 2 + 8 + 8 + 32 + 16 + 8;
  const data = Buffer.alloc(dataLen);
  let offset = 0;

  disc.copy(data, offset); offset += 8;
  data.writeUInt8(params.orderType, offset); offset += 1;
  data.writeBigUInt64LE(params.cryptoAmount, offset); offset += 8;
  data.writeBigUInt64LE(params.fiatAmount, offset); offset += 8;
  fiatCurrencyBytes.copy(data, offset); offset += 3;
  data.writeUInt16LE(params.paymentMethods, offset); offset += 2;
  data.writeBigUInt64LE(minAmount, offset); offset += 8;
  data.writeBigUInt64LE(maxAmount, offset); offset += 8;
  reputationCommitment.copy(data, offset); offset += 32;
  nonce.copy(data, offset); offset += 16;
  data.writeBigInt64LE(expiresIn, offset); offset += 8;

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: makerPubkey, isSigner: true, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: false },
      { pubkey: orderPDA, isSigner: false, isWritable: true },
      { pubkey: complianceAttestation, isSigner: false, isWritable: false },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: MUGEN_PROGRAM_ID,
    data,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(ix);

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = makerPubkey;

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    transaction: serialized.toString('base64'),
    orderAddress: orderPDA.toBase58(),
    nonce: nonce.toString('hex'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRM PAYMENT
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConfirmPaymentParams {
  escrowAddress: string;
  buyerWallet: string;
}

/**
 * Build a confirmPayment transaction (unsigned).
 */
export async function buildConfirmPaymentTx(params: ConfirmPaymentParams): Promise<string> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const escrowPubkey = new PublicKey(params.escrowAddress);
  const buyerPubkey = new PublicKey(params.buyerWallet);

  const disc = anchorDisc('confirm_payment');

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: buyerPubkey, isSigner: true, isWritable: false },
      { pubkey: escrowPubkey, isSigner: false, isWritable: true },
    ],
    programId: MUGEN_PROGRAM_ID,
    data: disc,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(ix);

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = buyerPubkey;

  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RELEASE ESCROW
// ═══════════════════════════════════════════════════════════════════════════════

export interface ReleaseEscrowParams {
  escrowAddress: string;
  sellerWallet: string;
  buyerTokenAccount?: string;
}

function getRepPDA(commitment: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [REPUTATION_SEED, commitment],
    MUGEN_PROGRAM_ID,
  );
}

/**
 * Build a releaseEscrow transaction (unsigned).
 * Reads the escrow and order accounts on-chain to derive all required PDAs
 * (vault, fee wallet, maker/taker reputation).
 */
export async function buildReleaseEscrowTx(params: ReleaseEscrowParams): Promise<string> {
  const { getAssociatedTokenAddress } = require('@solana/spl-token');
  const connection = new Connection(RPC_URL, 'confirmed');
  const escrowPubkey = new PublicKey(params.escrowAddress);
  const sellerPubkey = new PublicKey(params.sellerWallet);
  // buyerTokenAccount: from params or derive from taker's ATA
  let buyerTokenAccount: PublicKey;

  // ── Read escrow account ──────────────────────────────────────────────────
  const escrowInfo = await connection.getAccountInfo(escrowPubkey);
  if (!escrowInfo) throw new Error('Escrow account not found');

  const escrowData = Buffer.from(escrowInfo.data);
  // Layout after 8-byte discriminator:
  //   order(32) + maker(32) + taker(32) + token_mint(32) +
  //   crypto_amount(8) + fiat_amount(8) + escrow_vault(32) + ...
  let eOff = 8;
  const orderKey = new PublicKey(escrowData.subarray(eOff, eOff + 32)); eOff += 32;
  /* maker */ eOff += 32;
  const takerKey = new PublicKey(escrowData.subarray(eOff, eOff + 32)); eOff += 32;
  const tokenMint = new PublicKey(escrowData.subarray(eOff, eOff + 32)); eOff += 32;

  // Resolve buyer token account
  if (params.buyerTokenAccount) {
    buyerTokenAccount = new PublicKey(params.buyerTokenAccount);
  } else {
    buyerTokenAccount = await getAssociatedTokenAddress(tokenMint, takerKey);
  }

  // Derive vault PDA from escrow
  const [vaultPDA] = getVaultPDA(escrowPubkey);

  // ── Read config to get 4 fee wallets ─────────────────────────────────────
  const [configPDA] = getConfigPDA();
  const configInfo = await connection.getAccountInfo(configPDA);
  if (!configInfo) throw new Error('Config account not found');

  const configData = Buffer.from(configInfo.data);
  // Config layout: disc(8) + authority(32) + fee_bps(2) +
  //   p01_fee_wallet(32) + mugen_fee_wallet(32) + treasury_wallet(32) +
  //   p01_fee_share(2) + mugen_fee_share(2) + noise_fund_wallet(32) + noise_fee_share(2)
  let cfgOff = 8 + 32 + 2; // skip disc + authority + fee_bps
  const p01FeeWallet = new PublicKey(configData.subarray(cfgOff, cfgOff + 32)); cfgOff += 32;
  const mugenFeeWallet = new PublicKey(configData.subarray(cfgOff, cfgOff + 32)); cfgOff += 32;
  const treasuryWallet = new PublicKey(configData.subarray(cfgOff, cfgOff + 32)); cfgOff += 32;
  cfgOff += 2; // p01_fee_share
  cfgOff += 2; // mugen_fee_share
  const noiseFundWallet = new PublicKey(configData.subarray(cfgOff, cfgOff + 32));

  const p01FeeAta: PublicKey = await getAssociatedTokenAddress(tokenMint, p01FeeWallet);
  const mugenFeeAta: PublicKey = await getAssociatedTokenAddress(tokenMint, mugenFeeWallet);
  const treasuryFeeAta: PublicKey = await getAssociatedTokenAddress(tokenMint, treasuryWallet);
  const noiseFundAta: PublicKey = await getAssociatedTokenAddress(tokenMint, noiseFundWallet);

  // ── Read order to get maker reputation commitment ────────────────────────
  const orderInfo = await connection.getAccountInfo(orderKey);
  if (!orderInfo) throw new Error('Order account not found');

  const orderData = Buffer.from(orderInfo.data);
  // Order layout after disc(8):
  //   maker(32) + order_type(1) + token_mint(32) + crypto_amount(8) + fiat_amount(8) +
  //   fiat_currency(3) + payment_methods(2) + min_amount(8) + max_amount(8) +
  //   compliance_attestation(32) + reputation_commitment(32) + nonce(16) + ...
  const repCommitmentOffset = 8 + 32 + 1 + 32 + 8 + 8 + 3 + 2 + 8 + 8 + 32;
  const makerRepCommitment = Buffer.from(orderData.subarray(repCommitmentOffset, repCommitmentOffset + 32));
  const [makerRepPDA] = getRepPDA(makerRepCommitment);

  // ── Find taker reputation PDA ────────────────────────────────────────────
  // Reputation PDAs are keyed by Poseidon commitment (not by wallet pubkey).
  // We scan all reputation accounts (MugenReputation::LEN = 85) and find the
  // one that is NOT the maker's rep. For a multi-taker exchange this is naive,
  // but sufficient for the current devnet with few active trades.
  const repAccounts = await connection.getProgramAccounts(MUGEN_PROGRAM_ID, {
    filters: [{ dataSize: 85 }],
  });

  let takerRepPubkey: PublicKey | null = null;
  for (const { pubkey, account } of repAccounts) {
    if (pubkey.equals(makerRepPDA)) continue;
    const repData = Buffer.from(account.data);
    const commitment = Buffer.from(repData.subarray(8, 40));
    const [derived] = getRepPDA(commitment);
    if (derived.equals(pubkey)) {
      takerRepPubkey = pubkey;
      break;
    }
  }
  if (!takerRepPubkey) {
    throw new Error('Taker reputation account not found');
  }

  // ── Build instruction ────────────────────────────────────────────────────
  const disc = anchorDisc('release_escrow');

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: sellerPubkey, isSigner: true, isWritable: false },      // seller
      { pubkey: configPDA, isSigner: false, isWritable: true },          // config
      { pubkey: escrowPubkey, isSigner: false, isWritable: true },       // escrow
      { pubkey: vaultPDA, isSigner: false, isWritable: true },           // vault
      { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },  // buyer ATA
      { pubkey: p01FeeAta, isSigner: false, isWritable: true },          // p01 fee (15%)
      { pubkey: mugenFeeAta, isSigner: false, isWritable: true },        // mugen fee (55%)
      { pubkey: treasuryFeeAta, isSigner: false, isWritable: true },     // treasury fee (15%)
      { pubkey: noiseFundAta, isSigner: false, isWritable: true },       // noise fund (15%)
      { pubkey: makerRepPDA, isSigner: false, isWritable: true },        // maker rep
      { pubkey: takerRepPubkey, isSigner: false, isWritable: true },     // taker rep
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // token program
    ],
    programId: MUGEN_PROGRAM_ID,
    data: disc,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(ix);

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = sellerPubkey;

  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
