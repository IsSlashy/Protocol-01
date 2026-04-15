import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { createHash } from 'crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import {
  getByMakerNonce,
  removeByMakerNonce,
  type EncryptedOrderEntry,
} from '@/lib/encrypted-order-registry';
import { getRelayerKeypair } from '@/lib/arcium';
import {
  P01_MUGEN_PROGRAM_ID,
  WSOL_MINT,
  configExists,
  deriveConfigPDA,
  deriveEscrowPDA,
  deriveOrderPDA,
  deriveVaultPDA,
  ensureRelayerWrappedSol,
  getTakerKeypair,
  buildCreateOrderIx,
  buildTakeOrderIx,
  makerNonceToOrderNonce,
} from '@/lib/mugen-escrow';
import {
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { FiatCurrency } from '@/lib/mpc-types';

/**
 * p01_mugen program on devnet.
 *
 * Primary path (NEW): create a real token-bearing MugenEscrow PDA by
 * combining `create_order` (relayer=maker) + `take_order` (relayer=seller,
 * takerKeypair=taker) in a single atomic transaction. Wraps SOL on the fly
 * so the escrow vault is funded with actual wSOL.
 *
 * Fallback path: init_reputation receipt PDA (sha256 commitment of the
 * match terms). Kept so the claim-match UX still succeeds when any piece
 * of the escrow flow is unavailable on the current devnet state.
 */
const REPUTATION_SEED = Buffer.from('mugen_rep');
const DEVNET_RPC =
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

function anchorDisc(ixName: string): Buffer {
  return Buffer.from(sha256(`global:${ixName}`).slice(0, 8));
}

interface ClaimMatchBody {
  takerNoncePubkey: string;
  matchedMakerNonce: string;
  takerWallet: string;
}

interface MatchedTerms {
  cryptoAmountLamports: number;
  fiatAmountCents: number;
  fiatCurrency: FiatCurrency;
  paymentMethods: number;
  makerNoncePubkey: string;
  takerNoncePubkey: string;
  takerWallet: string;
}

interface ClaimMatchResponse {
  ok: true;
  /** True when the token escrow path succeeded. */
  tokenEscrow?: boolean;
  escrowPDA?: string;
  vaultPDA?: string;
  orderPDA?: string;
  /** Reputation PDA — present on both paths (always computed as receipt). */
  reputationPDA?: string;
  txSignature?: string;
  simulated?: boolean;
  matchedTerms: MatchedTerms;
  note?: string;
  fallbackReason?: string;
}

function validate(body: Partial<ClaimMatchBody>): string | null {
  if (
    typeof body.takerNoncePubkey !== 'string' ||
    body.takerNoncePubkey.length < 32
  ) {
    return 'takerNoncePubkey must be a base58-encoded pubkey string';
  }
  if (
    typeof body.matchedMakerNonce !== 'string' ||
    body.matchedMakerNonce.length < 32
  ) {
    return 'matchedMakerNonce must be a base58-encoded pubkey string';
  }
  if (typeof body.takerWallet !== 'string' || body.takerWallet.length < 32) {
    return 'takerWallet must be a base58-encoded pubkey string';
  }
  try {
    new PublicKey(body.takerWallet);
  } catch {
    return 'takerWallet is not a valid base58 Solana pubkey';
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Primary path — real token escrow via p01_mugen.create_order + take_order
// ───────────────────────────────────────────────────────────────────────────

interface TokenEscrowResult {
  escrowPDA: string;
  vaultPDA: string;
  orderPDA: string;
  txSignature: string;
}

async function tryCreateTokenEscrow(
  entry: EncryptedOrderEntry,
  _validated: ClaimMatchBody,
): Promise<TokenEscrowResult> {
  const connection = new Connection(DEVNET_RPC, 'confirmed');
  const relayer = getRelayerKeypair();

  // 1. Config must exist.
  if (!(await configExists(connection))) {
    throw new Error('MugenConfig not initialized on devnet');
  }

  // Read the config to learn config.authority (needed for attestation bypass).
  const [configPDA] = deriveConfigPDA();
  const configInfo = await connection.getAccountInfo(configPDA, 'confirmed');
  if (!configInfo) {
    throw new Error('MugenConfig PDA exists but has no data');
  }
  // Layout: 8-byte discriminator + authority (32 bytes) + ...
  const authorityBytes = configInfo.data.slice(8, 40);
  const configAuthority = new PublicKey(authorityBytes);

  // Read min_trade_amount from config (offset: 8 disc + 32 auth + 2 fee_bps
  // + 32 p01 + 32 mugen + 32 treasury + 2 p01_share + 2 mugen_share
  // + 32 noise_fund + 2 noise_share = 176 ⇒ min_trade_amount @ 176).
  const minTradeAmount = Number(configInfo.data.readBigUInt64LE(176));
  const maxTradeAmount = Number(configInfo.data.readBigUInt64LE(184));

  // Clamp crypto amount to the on-chain policy window so create_order passes.
  let cryptoAmount = BigInt(entry.cryptoAmountLamports);
  if (cryptoAmount < BigInt(minTradeAmount)) {
    cryptoAmount = BigInt(minTradeAmount);
  }
  if (cryptoAmount > BigInt(maxTradeAmount)) {
    cryptoAmount = BigInt(maxTradeAmount);
  }

  // 2. Derive PDAs. Use the maker nonce's first 16 bytes as the order nonce
  //    so the mapping is deterministic and idempotent.
  const makerNoncePubkey = new PublicKey(entry.makerNoncePubkey);
  const orderNonce = makerNonceToOrderNonce(makerNoncePubkey);
  const maker = relayer.publicKey; // relayer acts as maker for on-chain order
  const [orderPDA] = deriveOrderPDA(maker, orderNonce);

  // 3. Taker keypair — generated/loaded from disk. Must have SOL for fees.
  const takerKp = getTakerKeypair();
  const takerLamports = await connection.getBalance(takerKp.publicKey, 'confirmed');
  if (takerLamports < 20_000_000) {
    throw new Error(
      `taker keypair ${takerKp.publicKey.toBase58()} has insufficient SOL ` +
        `(${takerLamports} lamports); run scripts/setup-mugen-token-escrow.mjs`,
    );
  }

  const [escrowPDA] = deriveEscrowPDA(orderPDA, takerKp.publicKey);
  const [vaultPDA] = deriveVaultPDA(escrowPDA);

  // 4. Ensure relayer has wSOL funded with at least cryptoAmount.
  const sellerTokenAccount = await ensureRelayerWrappedSol(
    connection,
    relayer,
    Number(cryptoAmount),
  );

  // Sanity check: the ATA resolution must match getAssociatedTokenAddressSync.
  const expectedAta = getAssociatedTokenAddressSync(
    WSOL_MINT,
    relayer.publicKey,
    false,
  );
  if (!sellerTokenAccount.equals(expectedAta)) {
    throw new Error('relayer wSOL ATA mismatch');
  }

  // 5. Build transaction:
  //    - create_order (only if order PDA doesn't exist)
  //    - take_order
  const ixs: TransactionInstruction[] = [];

  const orderAccountInfo = await connection.getAccountInfo(orderPDA, 'confirmed');
  if (!orderAccountInfo) {
    ixs.push(
      buildCreateOrderIx({
        maker,
        nonce: orderNonce,
        orderType: 'sell',
        cryptoAmount,
        fiatAmount: BigInt(entry.fiatAmountCents),
        fiatCurrency: entry.fiatCurrency,
        paymentMethods: entry.paymentMethods,
        expiresIn: 3600,
        configPDA,
        orderPDA,
        configAuthority,
        tokenMint: WSOL_MINT,
      }),
    );
  }

  ixs.push(
    buildTakeOrderIx({
      taker: takerKp.publicKey,
      seller: relayer.publicKey,
      sellerTokenAccount,
      orderPDA,
      escrowPDA,
      vaultPDA,
      configPDA,
      configAuthority,
      tokenMint: WSOL_MINT,
      stealthRecipient: null,
      paymentMethod: entry.paymentMethods,
    }),
  );

  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = relayer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(relayer, takerKp);

  const txSignature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(txSignature, 'confirmed');

  return {
    escrowPDA: escrowPDA.toBase58(),
    vaultPDA: vaultPDA.toBase58(),
    orderPDA: orderPDA.toBase58(),
    txSignature,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Fallback — init_reputation receipt (pre-existing path)
// ───────────────────────────────────────────────────────────────────────────

async function tryReputationReceipt(
  entry: EncryptedOrderEntry,
  validated: ClaimMatchBody,
): Promise<{ reputationPDA: string; txSignature?: string; onChain: boolean; error?: string }> {
  const commitment = createHash('sha256')
    .update('mugen:match:v1|')
    .update(entry.makerNoncePubkey)
    .update('|')
    .update(validated.takerNoncePubkey)
    .update('|')
    .update(String(entry.cryptoAmountLamports))
    .update('|')
    .update(String(entry.fiatAmountCents))
    .update('|')
    .update(entry.fiatCurrency)
    .digest();

  const [reputationPDA] = PublicKey.findProgramAddressSync(
    [REPUTATION_SEED, commitment],
    P01_MUGEN_PROGRAM_ID,
  );

  let onChain = false;
  let txSignature: string | undefined;
  let error: string | undefined;

  try {
    const relayer = getRelayerKeypair();
    const connection = new Connection(DEVNET_RPC, 'confirmed');

    const disc = anchorDisc('init_reputation');
    const data = Buffer.concat([disc, commitment]);
    const ix = new TransactionInstruction({
      programId: P01_MUGEN_PROGRAM_ID,
      keys: [
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: reputationPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = relayer.publicKey;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.sign(relayer);

    txSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction(txSignature, 'confirmed');
    onChain = true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already in use')) {
      onChain = true;
      error = 'idempotent: commitment PDA already existed';
    } else {
      error = message;
    }
  }

  return {
    reputationPDA: reputationPDA.toBase58(),
    txSignature,
    onChain,
    error,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// POST /api/trade/claim-match
// ───────────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    let body: Partial<ClaimMatchBody>;
    try {
      body = (await request.json()) as Partial<ClaimMatchBody>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const invalid = validate(body);
    if (invalid) {
      console.warn('[api/trade/claim-match] validation failed:', invalid);
      return NextResponse.json({ error: invalid }, { status: 400 });
    }
    const validated = body as ClaimMatchBody;

    const entry = await getByMakerNonce(validated.matchedMakerNonce);
    if (!entry) {
      console.warn(
        '[api/trade/claim-match] no registry entry for maker nonce',
        validated.matchedMakerNonce,
      );
      return NextResponse.json(
        { error: 'Match no longer available' },
        { status: 404 },
      );
    }

    const matchedTerms: MatchedTerms = {
      cryptoAmountLamports: entry.cryptoAmountLamports,
      fiatAmountCents: entry.fiatAmountCents,
      fiatCurrency: entry.fiatCurrency,
      paymentMethods: entry.paymentMethods,
      makerNoncePubkey: entry.makerNoncePubkey,
      takerNoncePubkey: validated.takerNoncePubkey,
      takerWallet: validated.takerWallet,
    };

    // ── Primary path: real token escrow ───────────────────────────────────
    let escrowResult: TokenEscrowResult | null = null;
    let escrowFallbackReason: string | undefined;
    try {
      escrowResult = await tryCreateTokenEscrow(entry, validated);
    } catch (err) {
      escrowFallbackReason = err instanceof Error ? err.message : String(err);
      console.warn(
        '[api/trade/claim-match] token escrow failed, falling back to reputation receipt:',
        escrowFallbackReason,
      );
    }

    if (escrowResult) {
      await removeByMakerNonce(entry.makerNoncePubkey);
      const response: ClaimMatchResponse = {
        ok: true,
        simulated: false,
        tokenEscrow: true,
        escrowPDA: escrowResult.escrowPDA,
        vaultPDA: escrowResult.vaultPDA,
        orderPDA: escrowResult.orderPDA,
        txSignature: escrowResult.txSignature,
        matchedTerms,
        note:
          'Real on-chain escrow: wSOL locked in MugenEscrow PDA, ' +
          'settlement via p01_mugen confirm_payment + release_escrow.',
      };
      console.info('[api/trade/claim-match] token escrow created', {
        makerNoncePubkey: entry.makerNoncePubkey.slice(0, 8),
        takerNoncePubkey: validated.takerNoncePubkey.slice(0, 8),
        escrowPDA: escrowResult.escrowPDA,
        vaultPDA: escrowResult.vaultPDA,
        orderPDA: escrowResult.orderPDA,
        txSignature: escrowResult.txSignature,
      });
      return NextResponse.json(response);
    }

    // ── Fallback: reputation receipt ──────────────────────────────────────
    const reputation = await tryReputationReceipt(entry, validated);
    await removeByMakerNonce(entry.makerNoncePubkey);

    const response: ClaimMatchResponse = {
      ok: true,
      simulated: !reputation.onChain,
      tokenEscrow: false,
      escrowPDA: reputation.reputationPDA,
      reputationPDA: reputation.reputationPDA,
      txSignature: reputation.txSignature,
      matchedTerms,
      fallbackReason: escrowFallbackReason,
      note: reputation.onChain
        ? 'Fallback: MugenReputation PDA seeded by sha256(match terms). ' +
          'Token escrow unavailable (see fallbackReason).'
        : `Simulated (on-chain submission failed: ${reputation.error ?? 'unknown'}).`,
    };

    console.info('[api/trade/claim-match] reputation fallback', {
      makerNoncePubkey: entry.makerNoncePubkey.slice(0, 8),
      takerNoncePubkey: validated.takerNoncePubkey.slice(0, 8),
      reputationPDA: reputation.reputationPDA,
      txSignature: reputation.txSignature,
      onChain: reputation.onChain,
      escrowFallbackReason,
    });

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/trade/claim-match] unexpected error:', message);
    return NextResponse.json(
      { error: 'Internal error', detail: message },
      { status: 500 },
    );
  }
}
