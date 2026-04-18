/**
 * Seed additional test orders on devnet.
 *
 * Run: ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
 *      ANCHOR_WALLET=~/.config/solana/id.json \
 *      npx ts-mocha -p tsconfig.test.json tests/mugen-seed-orders.ts --timeout 120000
 */

import { describe, it } from 'mocha';
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Connection,
  Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const MUGEN_PROGRAM_ID = new PublicKey('EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN');
const CONFIG_SEED = Buffer.from('mugen_config');
const ORDER_SEED = Buffer.from('mugen_order');
const NATIVE_SOL = new PublicKey('So11111111111111111111111111111111111111112');
const DEVNET_USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

function anchorDisc(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`)).slice(0, 8));
}

function loadKeypair(): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, 'utf-8'))));
}

interface OrderDef {
  label: string;
  orderType: number; // 0=buy, 1=sell
  mint: PublicKey;
  cryptoAmount: bigint;
  fiatAmount: bigint; // cents
  fiatCurrency: string;
  paymentMethods: number; // bitfield
}

const orders: OrderDef[] = [
  { label: 'Sell 10 SOL for $1,480', orderType: 1, mint: NATIVE_SOL, cryptoAmount: 10_000_000_000n, fiatAmount: 148000n, fiatCurrency: 'USD', paymentMethods: 1 | 2 | 4 }, // bank+revolut+wise
  { label: 'Sell 5 SOL for €680', orderType: 1, mint: NATIVE_SOL, cryptoAmount: 5_000_000_000n, fiatAmount: 68000n, fiatCurrency: 'EUR', paymentMethods: 1 | 16 }, // bank+sepa
  { label: 'Sell 50 SOL for $7,350', orderType: 1, mint: NATIVE_SOL, cryptoAmount: 50_000_000_000n, fiatAmount: 735000n, fiatCurrency: 'USD', paymentMethods: 2 | 32 }, // revolut+zelle
  { label: 'Sell 500 USDC for €460', orderType: 1, mint: DEVNET_USDC, cryptoAmount: 500_000_000n, fiatAmount: 46000n, fiatCurrency: 'EUR', paymentMethods: 1 | 16 }, // bank+sepa
  { label: 'Buy 25 SOL for $3,700', orderType: 0, mint: NATIVE_SOL, cryptoAmount: 25_000_000_000n, fiatAmount: 370000n, fiatCurrency: 'USD', paymentMethods: 2 | 4 }, // revolut+wise
];

describe('Mugen — Seed Orders', () => {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const wallet = loadKeypair();
  const [configPDA] = PublicKey.findProgramAddressSync([CONFIG_SEED], MUGEN_PROGRAM_ID);

  for (const orderDef of orders) {
    it(`Create: ${orderDef.label}`, async () => {
      const nonce = Keypair.generate().publicKey.toBytes().slice(0, 16);
      const [orderPDA] = PublicKey.findProgramAddressSync(
        [ORDER_SEED, wallet.publicKey.toBuffer(), Buffer.from(nonce)],
        MUGEN_PROGRAM_ID,
      );

      const repCommitment = Buffer.alloc(32);
      repCommitment.writeUInt32LE(Math.floor(Math.random() * 100000), 0);

      const disc = anchorDisc('create_order');
      const data = Buffer.alloc(8 + 1 + 8 + 8 + 3 + 2 + 8 + 8 + 32 + 16 + 8);
      let offset = 0;
      disc.copy(data, offset); offset += 8;
      data.writeUInt8(orderDef.orderType, offset); offset += 1;
      data.writeBigUInt64LE(orderDef.cryptoAmount, offset); offset += 8;
      data.writeBigUInt64LE(orderDef.fiatAmount, offset); offset += 8;
      Buffer.from(orderDef.fiatCurrency.padEnd(3, '\0')).copy(data, offset); offset += 3;
      data.writeUInt16LE(orderDef.paymentMethods, offset); offset += 2;
      data.writeBigUInt64LE(0n, offset); offset += 8; // min
      data.writeBigUInt64LE(0n, offset); offset += 8; // max
      repCommitment.copy(data, offset); offset += 32;
      Buffer.from(nonce).copy(data, offset); offset += 16;
      data.writeBigInt64LE(86400n, offset); // 24h expiry

      const ix = new TransactionInstruction({
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: configPDA, isSigner: false, isWritable: false },
          { pubkey: orderPDA, isSigner: false, isWritable: true },
          { pubkey: wallet.publicKey, isSigner: false, isWritable: false }, // authority bypass
          { pubkey: orderDef.mint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: MUGEN_PROGRAM_ID,
        data,
      });

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
      tx.add(ix);

      const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
      console.log(`  ✓ ${orderDef.label}`);
      console.log(`    Order: ${orderPDA.toBase58()}`);
      console.log(`    Tx: ${sig.slice(0, 20)}...`);
    });
  }

  it('List all orders on-chain', async () => {
    const accounts = await connection.getProgramAccounts(MUGEN_PROGRAM_ID, {
      filters: [{ dataSize: 208 }],
    });

    console.log(`\n  === ${accounts.length} orders on-chain ===\n`);

    for (const { pubkey, account } of accounts) {
      const data = Buffer.from(account.data);
      let offset = 8;
      offset += 32; // maker
      const typeU8 = data.readUInt8(offset); offset += 1;
      const mint = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
      const amount = Number(data.readBigUInt64LE(offset)); offset += 8;
      const fiat = Number(data.readBigUInt64LE(offset)); offset += 8;
      const currency = data.subarray(offset, offset + 3).toString('ascii').replace(/\0/g, '');

      const tokenName = mint === NATIVE_SOL.toBase58() ? 'SOL' : mint === DEVNET_USDC.toBase58() ? 'USDC' : 'Unknown';
      const typeStr = typeU8 === 0 ? 'BUY' : 'SELL';
      const amountFormatted = tokenName === 'SOL' ? amount / 1e9 : amount / 1e6;

      console.log(`  ${typeStr} ${amountFormatted} ${tokenName} for $${(fiat / 100).toFixed(2)} ${currency} — ${pubkey.toBase58().slice(0, 12)}...`);
    }
  });
});
