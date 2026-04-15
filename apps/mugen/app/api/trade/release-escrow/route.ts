import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { createHash } from 'crypto';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { getRelayerKeypair } from '@/lib/arcium';
import {
  ESCROW_PAYMENT_CONFIRMED,
  P01_MUGEN_PROGRAM_ID,
  buildInitReputationIx,
  buildReleaseEscrowIx,
  deriveConfigPDA,
  deriveReputationPDA,
  getTakerKeypair,
  readMugenConfig,
  readMugenEscrow,
} from '@/lib/mugen-escrow';

/**
 * POST /api/trade/release-escrow
 *
 * Body: { escrowPDA: string }
 *
 * Orchestrates the full release sequence:
 *   1. Validate escrow is PAYMENT_CONFIRMED.
 *   2. Read MugenConfig for the 4 fee-wallet pubkeys + fee_bps.
 *   3. Bootstrap (batched into prelude tx if any work is needed):
 *        - buyer (taker) wSOL ATA
 *        - 4 fee-wallet wSOL ATAs (p01, mugen, treasury, noise)
 *        - maker_reputation PDA (init_reputation)
 *        - taker_reputation PDA (init_reputation)
 *      All rent paid by the relayer.
 *   4. Call release_escrow signed by the relayer (seller).
 *   5. Return the final tx + the projected fee split for UI display.
 */

const DEVNET_RPC =
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// Fee-share constants — must mirror programs/p01_mugen/src/instructions/
// initialize.rs / release_escrow.rs. We intentionally don't read them from
// config (they aren't individually exposed by readMugenConfig's small shape
// and the on-chain defaults are public knowledge).
//   p01: 20% (2000bps of total_fee)
//   mugen: 55% (5500)
//   noise: 15% (1500)
//   treasury: remainder
const P01_SHARE_BPS = 2000;
const MUGEN_SHARE_BPS = 5500;
const NOISE_SHARE_BPS = 1500;

interface ReleaseBody {
  escrowPDA: string;
}

interface FeeSplit {
  p01: string;
  mugen: string;
  treasury: string;
  noise: string;
  buyerAmount: string;
  totalFee: string;
  feeBps: number;
}

function validate(body: Partial<ReleaseBody>): string | null {
  if (typeof body.escrowPDA !== 'string' || body.escrowPDA.length < 32) {
    return 'escrowPDA must be a base58-encoded pubkey string';
  }
  try {
    new PublicKey(body.escrowPDA);
  } catch {
    return 'escrowPDA is not a valid base58 Solana pubkey';
  }
  return null;
}

function computeFeeSplit(cryptoAmount: bigint, feeBps: number): FeeSplit {
  const totalFee = (cryptoAmount * BigInt(feeBps)) / 10_000n;
  const p01 = (totalFee * BigInt(P01_SHARE_BPS)) / 10_000n;
  const mugen = (totalFee * BigInt(MUGEN_SHARE_BPS)) / 10_000n;
  const noise = (totalFee * BigInt(NOISE_SHARE_BPS)) / 10_000n;
  const treasury = totalFee - p01 - mugen - noise;
  const buyerAmount = cryptoAmount - totalFee;
  return {
    p01: p01.toString(),
    mugen: mugen.toString(),
    treasury: treasury.toString(),
    noise: noise.toString(),
    buyerAmount: buyerAmount.toString(),
    totalFee: totalFee.toString(),
    feeBps,
  };
}

/** Reputation commitment = sha256("mugen:<role>-rep|" + signer.pubkey.base58) */
function reputationCommitment(role: 'maker' | 'taker', signer: PublicKey): Uint8Array {
  return createHash('sha256')
    .update(`mugen:${role}-rep|`)
    .update(signer.toBase58())
    .digest();
}

export async function POST(request: NextRequest) {
  let body: Partial<ReleaseBody>;
  try {
    body = (await request.json()) as Partial<ReleaseBody>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const invalid = validate(body);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 });
  }
  const validated = body as ReleaseBody;

  try {
    const connection = new Connection(DEVNET_RPC, 'confirmed');
    const escrowPDA = new PublicKey(validated.escrowPDA);

    // 1. Read escrow + config.
    const escrow = await readMugenEscrow(connection, escrowPDA);
    if (!escrow) {
      return NextResponse.json(
        { error: 'Escrow account not found' },
        { status: 404 },
      );
    }

    if (escrow.status !== ESCROW_PAYMENT_CONFIRMED) {
      return NextResponse.json(
        {
          error:
            `Escrow not in PAYMENT_CONFIRMED state (status=${escrow.status})`,
        },
        { status: 409 },
      );
    }

    const config = await readMugenConfig(connection);
    if (!config) {
      return NextResponse.json(
        { error: 'MugenConfig not initialized on devnet' },
        { status: 500 },
      );
    }

    const relayer = getRelayerKeypair();
    const taker = getTakerKeypair();
    const [configPDA] = deriveConfigPDA();

    // 2. Derive all ATAs + reputation PDAs.
    const tokenMint = escrow.tokenMint;

    const buyerATA = getAssociatedTokenAddressSync(
      tokenMint,
      escrow.taker,
      false,
    );
    const p01ATA = getAssociatedTokenAddressSync(
      tokenMint,
      config.p01FeeWallet,
      true, // allowOwnerOffCurve — fee wallets may be PDAs
    );
    const mugenATA = getAssociatedTokenAddressSync(
      tokenMint,
      config.mugenFeeWallet,
      true,
    );
    const treasuryATA = getAssociatedTokenAddressSync(
      tokenMint,
      config.treasuryWallet,
      true,
    );
    const noiseATA = getAssociatedTokenAddressSync(
      tokenMint,
      config.noiseFundWallet,
      true,
    );

    const makerCommitment = reputationCommitment('maker', escrow.maker);
    const takerCommitment = reputationCommitment('taker', escrow.taker);
    const [makerReputationPDA] = deriveReputationPDA(makerCommitment);
    const [takerReputationPDA] = deriveReputationPDA(takerCommitment);

    // 3. Bootstrap: check which accounts are missing, batch create them.
    const probes = await connection.getMultipleAccountsInfo(
      [
        buyerATA,
        p01ATA,
        mugenATA,
        treasuryATA,
        noiseATA,
        makerReputationPDA,
        takerReputationPDA,
      ],
      'confirmed',
    );

    const [
      buyerATAInfo,
      p01ATAInfo,
      mugenATAInfo,
      treasuryATAInfo,
      noiseATAInfo,
      makerRepInfo,
      takerRepInfo,
    ] = probes;

    const preludeIxs: TransactionInstruction[] = [];

    const ensureATA = (
      missing: boolean,
      ata: PublicKey,
      owner: PublicKey,
    ) => {
      if (!missing) return;
      preludeIxs.push(
        createAssociatedTokenAccountInstruction(
          relayer.publicKey, // payer
          ata,
          owner,
          tokenMint,
        ),
      );
    };

    ensureATA(!buyerATAInfo, buyerATA, escrow.taker);
    ensureATA(!p01ATAInfo, p01ATA, config.p01FeeWallet);
    ensureATA(!mugenATAInfo, mugenATA, config.mugenFeeWallet);
    ensureATA(!treasuryATAInfo, treasuryATA, config.treasuryWallet);
    ensureATA(!noiseATAInfo, noiseATA, config.noiseFundWallet);

    if (!makerRepInfo) {
      preludeIxs.push(
        buildInitReputationIx({
          payer: relayer.publicKey,
          reputationPDA: makerReputationPDA,
          commitment: makerCommitment,
        }),
      );
    }
    if (!takerRepInfo) {
      preludeIxs.push(
        buildInitReputationIx({
          payer: relayer.publicKey,
          reputationPDA: takerReputationPDA,
          commitment: takerCommitment,
        }),
      );
    }

    if (preludeIxs.length > 0) {
      const preludeTx = new Transaction();
      for (const ix of preludeIxs) preludeTx.add(ix);
      preludeTx.feePayer = relayer.publicKey;
      const { blockhash: preBh } =
        await connection.getLatestBlockhash('confirmed');
      preludeTx.recentBlockhash = preBh;
      preludeTx.sign(relayer);

      try {
        const preludeSig = await connection.sendRawTransaction(
          preludeTx.serialize(),
          {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          },
        );
        await connection.confirmTransaction(preludeSig, 'confirmed');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          '[api/trade/release-escrow] prelude bootstrap failed:',
          message,
        );
        return NextResponse.json(
          {
            error:
              'Failed to bootstrap required accounts (fee-wallet ATAs / reputation PDAs) — release aborted.',
            detail: message,
          },
          { status: 500 },
        );
      }
    }

    // 4. Release transaction — signed by relayer (acting as seller/maker).
    const releaseIx = buildReleaseEscrowIx({
      seller: relayer.publicKey,
      configPDA,
      escrowPDA,
      vaultPDA: escrow.vault,
      buyerTokenAccount: buyerATA,
      p01FeeAccount: p01ATA,
      mugenFeeAccount: mugenATA,
      treasuryFeeAccount: treasuryATA,
      noiseFundAccount: noiseATA,
      makerReputationPDA,
      takerReputationPDA,
    });

    // Sanity: the on-chain program requires signer == escrow.maker || taker.
    if (
      !relayer.publicKey.equals(escrow.maker) &&
      !relayer.publicKey.equals(escrow.taker)
    ) {
      return NextResponse.json(
        {
          error:
            `Relayer (${relayer.publicKey.toBase58()}) is not a participant in this escrow ` +
            `(maker=${escrow.maker.toBase58()}, taker=${escrow.taker.toBase58()}).`,
        },
        { status: 403 },
      );
    }

    const tx = new Transaction().add(releaseIx);
    tx.feePayer = relayer.publicKey;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.sign(relayer);

    const txSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction(txSignature, 'confirmed');

    const feeSplit = computeFeeSplit(escrow.cryptoAmount, config.feeBps);

    // Report which reputation PDAs / ATAs we bootstrapped for debugging.
    void P01_MUGEN_PROGRAM_ID; // re-export anchor

    return NextResponse.json({
      ok: true,
      txSignature,
      feeSplit,
      bootstrapped: {
        buyerATA: !buyerATAInfo,
        p01ATA: !p01ATAInfo,
        mugenATA: !mugenATAInfo,
        treasuryATA: !treasuryATAInfo,
        noiseATA: !noiseATAInfo,
        makerReputation: !makerRepInfo,
        takerReputation: !takerRepInfo,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/trade/release-escrow] error:', message);
    return NextResponse.json(
      { error: 'Internal error', detail: message },
      { status: 500 },
    );
  }
}
