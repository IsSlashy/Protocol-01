/**
 * run-devnet-trade.mjs — exercise a FULL p01_mugen escrow lifecycle on devnet
 * and print the real transaction signatures.
 *
 *   setup (buyer ATA + reputation PDAs)
 *     → create_order + take_order (atomic, wSOL locked)
 *     → confirm_payment
 *     → release_escrow (wSOL → buyer, 4-way fee split)
 *
 * Self-contained: account lists mirror the DEPLOYED program source
 * (programs/p01_mugen/src/instructions/*.rs), NOT the stale lib/mugen-escrow.ts
 * builders. Roles:
 *   - relayer/maker = seller (sells wSOL for fiat)   ~/.config/solana/id.json
 *   - taker          = buyer  (pays fiat, gets wSOL)  .secrets/taker-keypair.json
 *
 * Usage:  node scripts/run-devnet-trade.mjs   (run from apps/mugen)
 */

import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  getAccount,
} from '@solana/spl-token';

const PROGRAM_ID = new PublicKey('EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN');
const WSOL = NATIVE_MINT;
const CONFIG_SEED = Buffer.from('mugen_config');
const ORDER_SEED = Buffer.from('mugen_order');
const ESCROW_SEED = Buffer.from('mugen_escrow');
const VAULT_SEED = Buffer.from('mugen_vault');
const REP_SEED = Buffer.from('mugen_rep');
const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const EXPLORER = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const disc = (name) =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const loadKp = (p) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
const repCommitment = (role, signer) =>
  createHash('sha256').update(`mugen:${role}-rep|`).update(signer.toBase58()).digest();
const k = (pk, s = false, w = false) => ({ pubkey: pk, isSigner: s, isWritable: w });

async function send(conn, ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, preflightCommitment: 'confirmed',
  });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`  ✅ ${label}\n     ${EXPLORER(sig)}`);
  return sig;
}

function initRepIx(payer, rep, commit) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([disc('init_reputation'), commit]),
    keys: [k(payer, true, true), k(rep, false, true), k(SystemProgram.programId)],
  });
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const relayer = loadKp(path.join(os.homedir(), '.config', 'solana', 'id.json'));
  const taker = loadKp(path.resolve(process.cwd(), '.secrets', 'taker-keypair.json'));
  const sigs = {};

  console.log('Mugen p01_mugen escrow lifecycle — devnet');
  console.log('  relayer/maker/seller:', relayer.publicKey.toBase58());
  console.log('  taker/buyer:         ', taker.publicKey.toBase58(), '\n');

  // 1. Read config.
  const [configPDA] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
  const cfg = await conn.getAccountInfo(configPDA, 'confirmed');
  if (!cfg) throw new Error(`MugenConfig not initialized at ${configPDA.toBase58()}`);
  const d = Buffer.from(cfg.data);
  const configAuthority = new PublicKey(d.subarray(8, 40));
  const feeBps = d.readUInt16LE(40);
  const p01Wallet = new PublicKey(d.subarray(42, 74));
  const mugenWallet = new PublicKey(d.subarray(74, 106));
  const treasuryWallet = new PublicKey(d.subarray(106, 138));
  const noiseWallet = new PublicKey(d.subarray(142, 174));
  const minTrade = d.readBigUInt64LE(176);
  const maxTrade = d.readBigUInt64LE(184);
  console.log('Config OK. feeBps:', feeBps, '| min:', minTrade.toString(), '| max:', maxTrade.toString());

  let cryptoAmount = 10_000_000n;
  if (cryptoAmount < minTrade) cryptoAmount = minTrade;
  if (maxTrade > 0n && cryptoAmount > maxTrade) cryptoAmount = maxTrade;
  console.log('Trade size:', cryptoAmount.toString(), 'lamports wSOL\n');

  // 2. Token accounts + reputation PDAs.
  const sellerATA = getAssociatedTokenAddressSync(WSOL, relayer.publicKey, false);
  const buyerATA = getAssociatedTokenAddressSync(WSOL, taker.publicKey, false);
  const makerC = repCommitment('maker', relayer.publicKey);
  const takerC = repCommitment('taker', taker.publicKey);
  const [makerRep] = PublicKey.findProgramAddressSync([REP_SEED, makerC], PROGRAM_ID);
  const [takerRep] = PublicKey.findProgramAddressSync([REP_SEED, takerC], PROGRAM_ID);

  // ── SETUP: buyer wSOL ATA + reputation PDAs (idempotent) ──────────────────
  {
    const probe = await conn.getMultipleAccountsInfo([buyerATA, makerRep, takerRep], 'confirmed');
    const ixs = [];
    if (!probe[0]) ixs.push(createAssociatedTokenAccountInstruction(relayer.publicKey, buyerATA, taker.publicKey, WSOL));
    if (!probe[1]) ixs.push(initRepIx(relayer.publicKey, makerRep, makerC));
    if (!probe[2]) ixs.push(initRepIx(relayer.publicKey, takerRep, takerC));
    if (ixs.length) sigs.setup = await send(conn, ixs, [relayer], `setup: buyer ATA + reputation PDAs (${ixs.length} ix)`);
    else console.log('  • setup accounts already exist, skipping');
  }

  // ── Fund seller wSOL ATA up to cryptoAmount (idempotent top-up) ───────────
  {
    const ixs = [];
    let bal = 0n;
    try { bal = (await getAccount(conn, sellerATA, 'confirmed')).amount; }
    catch { ixs.push(createAssociatedTokenAccountInstruction(relayer.publicKey, sellerATA, relayer.publicKey, WSOL)); }
    if (bal < cryptoAmount) {
      ixs.push(SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: sellerATA, lamports: Number(cryptoAmount - bal) }));
      ixs.push(createSyncNativeInstruction(sellerATA));
    }
    if (ixs.length) sigs.wrap = await send(conn, ixs, [relayer], 'wrap SOL → wSOL (seller funded)');
    else console.log('  • seller wSOL already funded, skipping');
  }

  // ── create_order + take_order (atomic) ────────────────────────────────────
  const nonce = randomBytes(16);
  const [orderPDA] = PublicKey.findProgramAddressSync(
    [ORDER_SEED, relayer.publicKey.toBuffer(), nonce], PROGRAM_ID);
  const [escrowPDA] = PublicKey.findProgramAddressSync(
    [ESCROW_SEED, orderPDA.toBuffer(), taker.publicKey.toBuffer()], PROGRAM_ID);
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, escrowPDA.toBuffer()], PROGRAM_ID);

  const createIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([
      disc('create_order'), Buffer.from([1]), u64(cryptoAmount), u64(100n),
      Buffer.from('USD', 'ascii'), u16(1), u64(0n), u64(0n), Buffer.alloc(32),
      Buffer.from(nonce), i64(3600n),
    ]),
    keys: [
      k(relayer.publicKey, true, true), k(configPDA), k(orderPDA, false, true),
      k(configAuthority), k(WSOL), k(SystemProgram.programId),
    ],
  });
  // TakeOrder<'info> — mirrors take_order.rs (15 accounts).
  const takeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([disc('take_order'), Buffer.from([0]), u16(1)]),
    keys: [
      k(taker.publicKey, true, true),      // taker
      k(configPDA),                         // config
      k(orderPDA, false, true),             // order
      k(escrowPDA, false, true),            // escrow (init)
      k(vaultPDA, false, true),             // escrow_vault (init)
      k(sellerATA, false, true),            // seller_token_account
      k(buyerATA),                          // buyer_token_account
      k(relayer.publicKey, true, false),    // seller (signer)
      k(WSOL),                              // token_mint
      k(configAuthority),                   // taker_attestation (bypass)
      k(makerRep),                          // maker_reputation
      k(takerRep),                          // taker_reputation
      k(TOKEN_PROGRAM_ID),                  // token_program
      k(SystemProgram.programId),           // system_program
      k(SYSVAR_RENT_PUBKEY),                // rent
    ],
  });
  sigs.escrow = await send(conn, [createIx, takeIx], [relayer, taker],
    'create_order + take_order (wSOL locked in vault PDA)');
  console.log('     escrow:', escrowPDA.toBase58(), '| vault:', vaultPDA.toBase58());

  // ── confirm_payment (buyer = taker) ───────────────────────────────────────
  const confirmIx = new TransactionInstruction({
    programId: PROGRAM_ID, data: disc('confirm_payment'),
    keys: [k(taker.publicKey, true, false), k(escrowPDA, false, true)],
  });
  sigs.confirm = await send(conn, [confirmIx], [taker], 'confirm_payment (buyer marks fiat sent)');

  // ── release_escrow — prelude (fee ATAs), then release by seller ───────────
  const p01ATA = getAssociatedTokenAddressSync(WSOL, p01Wallet, true);
  const mugenATA = getAssociatedTokenAddressSync(WSOL, mugenWallet, true);
  const treasuryATA = getAssociatedTokenAddressSync(WSOL, treasuryWallet, true);
  const noiseATA = getAssociatedTokenAddressSync(WSOL, noiseWallet, true);
  const feeAccts = [
    [p01ATA, p01Wallet], [mugenATA, mugenWallet],
    [treasuryATA, treasuryWallet], [noiseATA, noiseWallet],
  ];
  {
    const probe = await conn.getMultipleAccountsInfo(feeAccts.map(([a]) => a), 'confirmed');
    const seen = new Set();
    const ixs = [];
    feeAccts.forEach(([ata, owner], i) => {
      if (!probe[i] && !seen.has(ata.toBase58())) {
        seen.add(ata.toBase58());
        ixs.push(createAssociatedTokenAccountInstruction(relayer.publicKey, ata, owner, WSOL));
      }
    });
    if (ixs.length) sigs.prelude = await send(conn, ixs, [relayer], `prelude: ${ixs.length} fee-wallet ATA(s)`);
  }

  // ReleaseEscrow<'info> — mirrors release_escrow.rs (13 accounts incl. order).
  const releaseIx = new TransactionInstruction({
    programId: PROGRAM_ID, data: disc('release_escrow'),
    keys: [
      k(relayer.publicKey, true, false),   // seller
      k(configPDA, false, true),            // config
      k(escrowPDA, false, true),            // escrow
      k(orderPDA),                          // order
      k(vaultPDA, false, true),             // escrow_vault
      k(buyerATA, false, true),             // buyer_token_account
      k(p01ATA, false, true),               // p01_fee_account
      k(mugenATA, false, true),             // mugen_fee_account
      k(treasuryATA, false, true),          // treasury_fee_account
      k(noiseATA, false, true),             // noise_fund_account
      k(makerRep, false, true),             // maker_reputation
      k(takerRep, false, true),             // taker_reputation
      k(TOKEN_PROGRAM_ID),                  // token_program
    ],
  });
  sigs.release = await send(conn, [releaseIx], [relayer],
    'release_escrow (wSOL → buyer, fee split p01/mugen/treasury/noise)');

  const totalFee = (cryptoAmount * BigInt(feeBps)) / 10_000n;
  console.log('\n──────────────────────────────────────────────');
  console.log('FULL ESCROW LIFECYCLE COMPLETE ✅ — all real devnet transactions');
  console.log('  trade:', cryptoAmount.toString(), 'lamports | fee:', totalFee.toString(),
    `(${feeBps}bps) | buyer received:`, (cryptoAmount - totalFee).toString());
  console.log('  escrow PDA:', escrowPDA.toBase58());
  console.log('\nSignatures (for /demo + grant dossier):');
  for (const [step, sig] of Object.entries(sigs)) console.log(`  ${step.padEnd(8)} ${sig}`);
}

main().catch((e) => { console.error('\n❌ FAILED:', e.message); process.exit(1); });
