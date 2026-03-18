/**
 * Initialize private_vote_binary + finalize_tally_binary comp_defs on devnet.
 * Account layout extracted from existing InitThresholdDecryptCompDef transaction.
 */
import * as anchor from '@coral-xyz/anchor';
import {
  PublicKey,
  TransactionInstruction,
  Transaction,
  SystemProgram,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getCompDefAccOffset,
  getCompDefAccAddress,
  getMXEAccAddress,
} from '@arcium-hq/client';
import * as crypto from 'crypto';

const PROGRAM_ID = new PublicKey('FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT');
const ARCIUM_PROGRAM_ID = new PublicKey('Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ');
const LUT_ADDRESS = new PublicKey('E9xn8e1LN33Npx5oJfph5Ac8thEsyEnPHHAWHwmxW4Fc');

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const mxeAddress = getMXEAccAddress(PROGRAM_ID);
  const circuits = ['private_vote_binary', 'finalize_tally_binary'];

  for (const circuit of circuits) {
    console.log(`\nInitializing comp_def: ${circuit}...`);

    const offset = Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE();
    const compDefAddress = getCompDefAccAddress(PROGRAM_ID, offset);
    console.log(`  CompDef: ${compDefAddress.toBase58()}`);

    // Check if already initialized
    const existing = await provider.connection.getAccountInfo(compDefAddress);
    if (existing) {
      console.log(`  Already initialized!`);
      continue;
    }

    // Discriminator: sha256("global:init_<circuit>_comp_def")[0..8]
    const methodName = `init_${circuit}_comp_def`;
    const discriminator = crypto
      .createHash('sha256')
      .update(`global:${methodName}`)
      .digest()
      .subarray(0, 8);

    // Account order from working InitThresholdDecryptCompDef tx:
    // 0: payer (signer, mut)
    // 1: mxe_account (mut)
    // 2: address_lookup_table (mut)
    // 3: comp_def_account (mut)
    // 4: system_program
    // 5: lut_program
    // 6: arcium_program
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        // Matching Rust struct field order in InitPrivateVoteBinaryCompDef:
        // payer, mxe_account, comp_def_account, address_lookup_table, lut_program, arcium_program, system_program
        { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: mxeAddress, isSigner: false, isWritable: true },
        { pubkey: compDefAddress, isSigner: false, isWritable: true },
        { pubkey: LUT_ADDRESS, isSigner: false, isWritable: true },
        { pubkey: AddressLookupTableProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ARCIUM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(discriminator),
    });

    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(ix);

    try {
      const sig = await provider.sendAndConfirm(tx, [], { commitment: 'confirmed' });
      console.log(`  Initialized! Sig: ${sig}`);
    } catch (e: any) {
      if (e.message?.includes('already in use')) {
        console.log(`  Already initialized (caught)`);
      } else {
        const logs = e.logs || [];
        console.error(`  Error: ${e.message?.slice(0, 300)}`);
        if (logs.length > 0) {
          console.error('  Logs:', logs.slice(-5).join('\n  '));
        }
      }
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
