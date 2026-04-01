import * as anchor from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';

const PROGRAM_ID = new PublicKey('FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT');

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = await anchor.workspace.P01Arcium;

  const circuits = ['sealed_bid_auction', 'finalize_auction'];

  for (const circuit of circuits) {
    const methodName = `init${circuit
      .split('_')
      .map((w: string) => w[0].toUpperCase() + w.slice(1))
      .join('')}CompDef`;

    console.log(`Initializing comp_def: ${circuit} (${methodName})...`);

    try {
      const sig = await (program.methods as any)[methodName]()
        .accountsPartial({})
        .rpc({ commitment: 'confirmed' });
      console.log(`  ✓ ${circuit}: ${sig}`);
    } catch (e: any) {
      if (e.message?.includes('already in use')) {
        console.log(`  ✓ ${circuit}: already initialized`);
      } else {
        console.error(`  ✗ ${circuit}: ${e.message}`);
      }
    }
  }

  console.log('\nDone. Auction comp defs initialized.');
}

main().catch(console.error);
