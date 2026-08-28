#!/usr/bin/env node
// Retire a relayer node and recover its stake.
//
// `deactivate_relayer` flips is_active off and stamps deactivated_at_slot;
// `unstake_relayer` then closes the RelayerNode PDA with `close = operator`,
// which returns stake + rent in one move. The program requires
// `deactivated_at_slot + config.cooldown_slots` to have elapsed in between —
// 100 slots on devnet, so roughly 40 seconds. This script does both halves and
// waits out the cooldown, because doing them in two sessions is how the
// second half gets forgotten.
//
// Written 2026-08-28 to retire the two hosted nodes (Railway `DEjW41JA…`, Fly
// `F54eUL69…`): 10 relay jobs in 45 days between them, and their own /health
// reported lastPollCount 0 throughout.
//
// 🚨 Each node can only be unstaked by ITS operator — `has_one = operator` plus
// a PDA seeded on the operator pubkey. The Railway operator happens to be the
// default Solana CLI key; the Fly operator is not on any disk in this repo and
// lives only in the Fly secret store, so recover it from the running machine
// (`fly ssh console -C 'printenv OPERATOR_KEYPAIR_JSON'`) BEFORE destroying the
// app. Destroying it first loses the stake permanently.
//
// Usage:
//   OPERATOR_KEYPAIR=~/.config/solana/id.json node scripts/retire-relayer.mjs
//   OPERATOR_KEYPAIR_JSON='[12,34,…]'          node scripts/retire-relayer.mjs
//
//   --dry-run   report what would happen, send nothing

import anchor from '@coral-xyz/anchor';
import * as web3 from '@solana/web3.js';
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const { Program, AnchorProvider, Wallet } = anchor.default ?? anchor;

const PROGRAM_ID = new web3.PublicKey('2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW');
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const DRY_RUN = process.argv.includes('--dry-run');

if (RPC.includes('mainnet')) {
  console.error('REFUSING mainnet RPC.');
  process.exit(2);
}

const SEEDS = {
  CONFIG: Buffer.from('relayer_config'),
  NODE: Buffer.from('relayer_node'),
};

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = nodePath.resolve(__dirname, '..');
const SOL = (lamports) => (Number(lamports) / web3.LAMPORTS_PER_SOL).toFixed(9);

function loadOperator() {
  const inline = process.env.OPERATOR_KEYPAIR_JSON;
  if (inline) return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(inline)));
  const p = process.env.OPERATOR_KEYPAIR;
  if (!p || !fs.existsSync(p)) {
    console.error('Set OPERATOR_KEYPAIR (path) or OPERATOR_KEYPAIR_JSON (inline array).');
    process.exit(2);
  }
  return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const operator = loadOperator();
  const conn = new web3.Connection(RPC, 'confirmed');
  const provider = new AnchorProvider(conn, new Wallet(operator), { commitment: 'confirmed' });

  const idl = JSON.parse(
    fs.readFileSync(nodePath.join(REPO_ROOT, 'target', 'idl', 'p01_relayer.json'), 'utf8'),
  );
  if (idl.address !== PROGRAM_ID.toBase58()) idl.address = PROGRAM_ID.toBase58();
  const program = new Program(idl, provider);

  const [configPda] = web3.PublicKey.findProgramAddressSync([SEEDS.CONFIG], PROGRAM_ID);
  const [nodePda] = web3.PublicKey.findProgramAddressSync(
    [SEEDS.NODE, operator.publicKey.toBuffer()],
    PROGRAM_ID,
  );

  const config = await program.account.relayerConfig.fetch(configPda);
  const node = await program.account.relayerNode.fetch(nodePda);
  const nodeLamports = (await conn.getAccountInfo(nodePda))?.lamports ?? 0;
  const before = await conn.getBalance(operator.publicKey);

  console.log('Operator      :', operator.publicKey.toBase58());
  console.log('Node PDA      :', nodePda.toBase58());
  console.log('isActive      :', node.isActive);
  console.log('stake         :', SOL(node.stake), 'SOL');
  console.log('PDA holds     :', SOL(nodeLamports), 'SOL  (stake + rent, all of it returns)');
  console.log('cooldown      :', Number(config.cooldownSlots), 'slots');
  console.log('activeRelayers:', config.activeRelayerCount);

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing sent.');
    return;
  }

  if (node.isActive) {
    const sig = await program.methods
      .deactivateRelayer()
      .accountsPartial({ operator: operator.publicKey, config: configPda, relayerNode: nodePda })
      .rpc();
    console.log('\ndeactivate_relayer:', sig);
  } else {
    console.log('\nAlready inactive — straight to unstake.');
  }

  // can_unstake() compares the CURRENT slot against deactivated_at_slot +
  // cooldown_slots, so poll the slot rather than guessing at 400 ms/slot.
  const fresh = await program.account.relayerNode.fetch(nodePda);
  const readyAt = Number(fresh.deactivatedAtSlot) + Number(config.cooldownSlots);
  for (;;) {
    const slot = await conn.getSlot();
    if (slot >= readyAt) break;
    console.log(`  cooldown: slot ${slot} / ${readyAt} …`);
    await sleep(5000);
  }

  const sig = await program.methods
    .unstakeRelayer()
    .accountsPartial({
      operator: operator.publicKey,
      config: configPda,
      relayerNode: nodePda,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc();
  console.log('unstake_relayer   :', sig);

  const after = await conn.getBalance(operator.publicKey);
  console.log('\nOperator balance  :', SOL(before), '→', SOL(after), 'SOL');
  console.log('Recovered         :', SOL(after - before), 'SOL (net of tx fees)');
  const stillThere = await conn.getAccountInfo(nodePda);
  console.log('Node PDA closed   :', stillThere === null);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
