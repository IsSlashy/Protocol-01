#!/usr/bin/env node
/**
 * One-time setup for the Layer 3 Distributed Noise wallet pool.
 *
 *   - Generates (if needed) 5 noise keypairs at
 *     apps/mugen/.secrets/noise-wallet-{0..4}.keypair.json
 *   - Attempts a devnet airdrop of 0.02 SOL to each (best-effort; skip on
 *     rate-limit)
 *   - Falls back to a relayer → noise transfer of 0.02 SOL for any wallet
 *     still at 0 after the airdrop pass
 *   - Prints final balances + pubkeys
 *
 * Idempotent and safe to re-run. Each step logs "skipped: <reason>" on
 * failure rather than aborting.
 *
 * Run:  node apps/mugen/scripts/setup-noise-wallets.mjs
 *
 * Env:
 *   SOLANA_RPC_URL          — defaults to https://api.devnet.solana.com
 *   MUGEN_RELAYER_KEYPAIR   — path to relayer keypair (for fallback funding)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MUGEN_ROOT = path.resolve(__dirname, '..');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const WALLET_COUNT = 5;
const TARGET_LAMPORTS = Math.floor(0.02 * LAMPORTS_PER_SOL);
const MIN_OK_LAMPORTS = Math.floor(0.005 * LAMPORTS_PER_SOL);

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

function saveKeypair(filePath, kp) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)), 'utf-8');
}

async function main() {
  const connection = new Connection(RPC, 'confirmed');

  // ── Relayer (for fallback funding) ────────────────────────────────────
  const relayerPath =
    process.env.MUGEN_RELAYER_KEYPAIR ||
    path.join(os.homedir(), '.config', 'solana', 'id.json');
  let relayer = null;
  try {
    relayer = loadKeypairFromFile(relayerPath);
    const bal = await connection.getBalance(relayer.publicKey);
    log('relayer', `${relayer.publicKey.toBase58()} (${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  } catch (e) {
    skip('relayer', `no keypair at ${relayerPath}: ${e.message} — fallback transfers disabled`);
  }

  // ── Generate / load noise wallets ─────────────────────────────────────
  const wallets = [];
  for (let i = 0; i < WALLET_COUNT; i++) {
    const kpPath = path.join(MUGEN_ROOT, '.secrets', `noise-wallet-${i}.keypair.json`);
    let kp;
    if (fs.existsSync(kpPath)) {
      kp = loadKeypairFromFile(kpPath);
      log('wallet', `#${i} loaded ${kp.publicKey.toBase58()}`);
    } else {
      kp = Keypair.generate();
      try {
        saveKeypair(kpPath, kp);
        log('wallet', `#${i} generated ${kp.publicKey.toBase58()} → ${kpPath}`);
      } catch (e) {
        const tmp = path.join(os.tmpdir(), `mugen-noise-wallet-${i}.keypair.json`);
        saveKeypair(tmp, kp);
        log('wallet', `#${i} generated ${kp.publicKey.toBase58()} → ${tmp} (project path not writable)`);
      }
    }
    wallets.push({ index: i, keypair: kp });
  }

  // ── Airdrop pass ───────────────────────────────────────────────────────
  for (const w of wallets) {
    try {
      const before = await connection.getBalance(w.keypair.publicKey);
      if (before >= TARGET_LAMPORTS) {
        log('airdrop', `#${w.index} already funded (${(before / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
        continue;
      }
      const sig = await connection.requestAirdrop(w.keypair.publicKey, TARGET_LAMPORTS);
      await connection.confirmTransaction(sig, 'confirmed');
      const after = await connection.getBalance(w.keypair.publicKey);
      log('airdrop', `#${w.index} → ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL (sig ${sig})`);
    } catch (e) {
      skip('airdrop', `#${w.index} ${e.message}`);
    }
  }

  // ── Relayer → noise transfer fallback for any wallet still underfunded ─
  if (relayer) {
    for (const w of wallets) {
      try {
        const bal = await connection.getBalance(w.keypair.publicKey);
        if (bal >= MIN_OK_LAMPORTS) continue;
        const needed = TARGET_LAMPORTS - bal;
        const relayerBal = await connection.getBalance(relayer.publicKey);
        if (relayerBal < needed + 10_000) {
          skip('transfer', `#${w.index} relayer too poor (${(relayerBal / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
          continue;
        }
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: relayer.publicKey,
            toPubkey: w.keypair.publicKey,
            lamports: needed,
          }),
        );
        tx.feePayer = relayer.publicKey;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.sign(relayer);
        const sig = await connection.sendRawTransaction(tx.serialize(), {
          preflightCommitment: 'confirmed',
        });
        await connection.confirmTransaction(sig, 'confirmed');
        const after = await connection.getBalance(w.keypair.publicKey);
        log('transfer', `#${w.index} → ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL (sig ${sig})`);
      } catch (e) {
        skip('transfer', `#${w.index} ${e.message}`);
      }
    }
  }

  // ── Final summary ──────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('Mugen Layer 3 noise-wallet pool ready');
  console.log('════════════════════════════════════════════════════════════');
  for (const w of wallets) {
    const bal = await connection.getBalance(w.keypair.publicKey);
    const ok = bal >= MIN_OK_LAMPORTS ? '✓' : '✗';
    console.log(
      `  ${ok} #${w.index}  ${w.keypair.publicKey.toBase58()}  ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
    );
  }
  console.log(`  RPC: ${RPC}`);
  console.log('════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
