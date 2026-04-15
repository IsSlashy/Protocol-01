#!/usr/bin/env node
/**
 * One-time setup script for the Mugen token-escrow flow.
 *
 *   - Generates (if needed) the taker keypair at apps/mugen/.secrets/taker-keypair.json
 *   - Airdrops 0.2 SOL to the taker on devnet
 *   - Ensures the relayer has a wSOL ATA with 0.1 SOL wrapped inside
 *   - Initializes MugenConfig if absent
 *   - Prints every pubkey / PDA at the end
 *
 * Each step is best-effort and logs "skipped: <reason>" on failure so the
 * script is idempotent and safe to re-run.
 *
 * Run:  node apps/mugen/scripts/setup-mugen-token-escrow.mjs
 *
 * Env:
 *   SOLANA_RPC_URL            — defaults to https://api.devnet.solana.com
 *   MUGEN_RELAYER_KEYPAIR     — path to relayer keypair (defaults to ~/.config/solana/id.json)
 *   MUGEN_TAKER_KEYPAIR       — path to taker keypair (defaults to apps/mugen/.secrets/taker-keypair.json)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MUGEN_ROOT = path.resolve(__dirname, '..');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey('EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN');
const CONFIG_SEED = Buffer.from('mugen_config');

function log(section, msg) {
  console.log(`[${section}] ${msg}`);
}

function skip(section, reason) {
  console.log(`[${section}] skipped: ${reason}`);
}

function loadKeypairFromFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function anchorDisc(name) {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}

function u16LE(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u64LE(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
function i64LE(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
}

async function main() {
  const connection = new Connection(RPC, 'confirmed');

  // ── Relayer keypair ────────────────────────────────────────────────────
  const relayerPath =
    process.env.MUGEN_RELAYER_KEYPAIR ||
    path.join(os.homedir(), '.config', 'solana', 'id.json');
  let relayer;
  try {
    relayer = loadKeypairFromFile(relayerPath);
    log('relayer', `loaded ${relayer.publicKey.toBase58()} from ${relayerPath}`);
  } catch (e) {
    console.error(`[relayer] FAILED to load keypair at ${relayerPath}: ${e.message}`);
    process.exit(1);
  }

  const relayerLamports = await connection.getBalance(relayer.publicKey);
  log('relayer', `balance: ${(relayerLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // ── Taker keypair ──────────────────────────────────────────────────────
  const takerPath =
    process.env.MUGEN_TAKER_KEYPAIR ||
    path.join(MUGEN_ROOT, '.secrets', 'taker-keypair.json');
  let taker;
  if (fs.existsSync(takerPath)) {
    taker = loadKeypairFromFile(takerPath);
    log('taker', `loaded ${taker.publicKey.toBase58()} from ${takerPath}`);
  } else {
    taker = Keypair.generate();
    try {
      fs.mkdirSync(path.dirname(takerPath), { recursive: true });
      fs.writeFileSync(
        takerPath,
        JSON.stringify(Array.from(taker.secretKey)),
        'utf-8',
      );
      log('taker', `generated ${taker.publicKey.toBase58()} → ${takerPath}`);
    } catch (e) {
      const tmp = path.join(os.tmpdir(), 'mugen-taker-keypair.json');
      fs.writeFileSync(tmp, JSON.stringify(Array.from(taker.secretKey)), 'utf-8');
      log('taker', `generated ${taker.publicKey.toBase58()} → ${tmp} (project path not writable)`);
    }
  }

  // ── Airdrop taker ──────────────────────────────────────────────────────
  try {
    const before = await connection.getBalance(taker.publicKey);
    if (before >= 0.15 * LAMPORTS_PER_SOL) {
      log('airdrop', `taker already funded (${(before / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
    } else {
      const sig = await connection.requestAirdrop(
        taker.publicKey,
        0.2 * LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(sig, 'confirmed');
      const after = await connection.getBalance(taker.publicKey);
      log('airdrop', `taker funded → ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL (sig ${sig})`);
    }
  } catch (e) {
    skip('airdrop', e.message);
  }

  // ── Wrapped SOL ATA ────────────────────────────────────────────────────
  const relayerWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    relayer.publicKey,
    false,
  );
  try {
    const ixs = [];
    let currentAmount = 0n;
    try {
      const acc = await getAccount(connection, relayerWsolAta, 'confirmed');
      currentAmount = acc.amount;
      log('wsol', `relayer wSOL ATA exists: ${relayerWsolAta.toBase58()} (${currentAmount} lamports)`);
    } catch {
      ixs.push(
        createAssociatedTokenAccountInstruction(
          relayer.publicKey,
          relayerWsolAta,
          relayer.publicKey,
          NATIVE_MINT,
        ),
      );
      log('wsol', `creating relayer wSOL ATA: ${relayerWsolAta.toBase58()}`);
    }

    const target = BigInt(0.1 * LAMPORTS_PER_SOL);
    if (currentAmount < target) {
      const diff = target - currentAmount;
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: relayer.publicKey,
          toPubkey: relayerWsolAta,
          lamports: Number(diff),
        }),
      );
      ixs.push(createSyncNativeInstruction(relayerWsolAta));
    }

    if (ixs.length > 0) {
      const tx = new Transaction();
      for (const ix of ixs) tx.add(ix);
      tx.feePayer = relayer.publicKey;
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        preflightCommitment: 'confirmed',
      });
      await connection.confirmTransaction(sig, 'confirmed');
      log('wsol', `wrapped 0.1 SOL into ATA (sig ${sig})`);
    } else {
      log('wsol', 'ATA already has >= 0.1 SOL wrapped');
    }
  } catch (e) {
    skip('wsol', e.message);
  }

  // ── MugenConfig init ───────────────────────────────────────────────────
  const [configPDA] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    PROGRAM_ID,
  );
  let configExisted = false;
  try {
    const info = await connection.getAccountInfo(configPDA, 'confirmed');
    if (info && info.data.length > 0) {
      configExisted = true;
      log('config', `MugenConfig already initialized at ${configPDA.toBase58()}`);
    } else {
      log('config', 'MugenConfig missing — initializing…');

      // InitConfigParams Borsh:
      //   fee_bps: u16
      //   p01_fee_wallet: Pubkey
      //   mugen_fee_wallet: Pubkey
      //   treasury_wallet: Pubkey
      //   p01_fee_share: u16
      //   mugen_fee_share: u16
      //   noise_fund_wallet: Pubkey
      //   noise_fee_share: u16
      //   min_trade_amount: u64
      //   max_trade_amount: u64
      //   escrow_timeout: i64
      //   dispute_timeout: i64
      const feeBps = 150; // 1.5%
      const p01Share = 2000; // 20%
      const mugenShare = 6500; // 65%
      const noiseShare = 1500; // 15% — treasury gets 0
      const params = Buffer.concat([
        u16LE(feeBps),
        relayer.publicKey.toBuffer(), // p01 wallet
        relayer.publicKey.toBuffer(), // mugen wallet
        relayer.publicKey.toBuffer(), // treasury
        u16LE(p01Share),
        u16LE(mugenShare),
        relayer.publicKey.toBuffer(), // noise_fund
        u16LE(noiseShare),
        u64LE(1_000_000), // min 0.001 SOL
        u64LE(1_000_000_000_000), // max 1000 SOL (generous for devnet)
        i64LE(3600),
        i64LE(86400),
      ]);
      const data = Buffer.concat([anchorDisc('initialize_config'), params]);

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
          { pubkey: configPDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      const tx = new Transaction().add(ix);
      tx.feePayer = relayer.publicKey;
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        preflightCommitment: 'confirmed',
      });
      await connection.confirmTransaction(sig, 'confirmed');
      log('config', `initialized MugenConfig at ${configPDA.toBase58()} (sig ${sig})`);
    }
  } catch (e) {
    skip('config', e.message);
  }

  // ── Final summary ──────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('Mugen token-escrow setup complete');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Program:           ${PROGRAM_ID.toBase58()}`);
  console.log(`  MugenConfig PDA:   ${configPDA.toBase58()} (existed=${configExisted})`);
  console.log(`  Relayer:           ${relayer.publicKey.toBase58()}`);
  console.log(`  Relayer wSOL ATA:  ${relayerWsolAta.toBase58()}`);
  console.log(`  Taker:             ${taker.publicKey.toBase58()}`);
  console.log(`  Taker keypair at:  ${takerPath}`);
  console.log(`  RPC:               ${RPC}`);
  console.log('════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
