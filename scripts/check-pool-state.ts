/**
 * Check the current state of the ZK shielded pool
 */
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { poseidon2 } from 'poseidon-lite';

const ZK_PROGRAM_ID = new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY');
const TOKEN_MINT = SystemProgram.programId; // Native SOL

// Convert LE bytes to bigint
function leBytesToBigint(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << BigInt(8)) | BigInt(bytes[i]);
  }
  return result;
}

// On-chain ZEROS
const ZEROS: bigint[] = [];
{
  const ZERO_BYTES = [
    0x6c, 0xaf, 0x99, 0x48, 0xed, 0x85, 0x96, 0x24,
    0xe2, 0x41, 0xe7, 0x76, 0x0f, 0x34, 0x1b, 0x82,
    0xb4, 0x5d, 0xa1, 0xeb, 0xb6, 0x35, 0x3a, 0x34,
    0xf3, 0xab, 0xac, 0xd3, 0x60, 0x4c, 0xe5, 0x2f,
  ];
  let baseZero = BigInt(0);
  for (let i = ZERO_BYTES.length - 1; i >= 0; i--) {
    baseZero = (baseZero << BigInt(8)) | BigInt(ZERO_BYTES[i]);
  }
  ZEROS.push(baseZero);
  for (let i = 1; i <= 20; i++) {
    ZEROS.push(poseidon2([ZEROS[i-1], ZEROS[i-1]]));
  }
}

async function main() {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

  // Derive PDAs
  const [poolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('shielded_pool'), TOKEN_MINT.toBytes()],
    ZK_PROGRAM_ID
  );
  const [merkleTreePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree'), poolPDA.toBytes()],
    ZK_PROGRAM_ID
  );

  console.log('=== Pool State ===');
  console.log('Pool PDA:', poolPDA.toBase58());
  console.log('Merkle Tree PDA:', merkleTreePDA.toBase58());

  // Fetch merkle tree
  const merkleAccount = await connection.getAccountInfo(merkleTreePDA);
  if (!merkleAccount) {
    console.log('Merkle tree account not found!');
    return;
  }

  // Parse: 8 (disc) + 32 (pool) + 32 (root) + 8 (leaf_count) + 1 (depth) + ...
  const data = merkleAccount.data;
  const rootBytes = data.slice(8 + 32, 8 + 32 + 32);
  const leafCount = Number(data.readBigUInt64LE(8 + 32 + 32));
  const depth = data[8 + 32 + 32 + 8];

  const onChainRoot = leBytesToBigint(rootBytes);

  console.log('\nLeaf count:', leafCount);
  console.log('Depth:', depth);
  console.log('On-chain root:', onChainRoot.toString().slice(0, 30) + '...');
  console.log('On-chain root hex:', onChainRoot.toString(16));

  // If empty pool, root should be ZEROS[20]
  console.log('\nExpected empty root (ZEROS[20]):', ZEROS[20].toString().slice(0, 30) + '...');
  console.log('Roots match (if empty):', onChainRoot === ZEROS[20]);

  if (leafCount === 0) {
    console.log('\nPool is empty - no commitments to verify');
    return;
  }

  // Fetch commitments from transactions
  console.log('\n=== Fetching Commitments ===');
  const signatures = await connection.getSignaturesForAddress(merkleTreePDA, { limit: 50 });
  console.log('Found', signatures.length, 'transactions');

  const commitments: { index: number; commitment: bigint }[] = [];

  for (const sig of signatures.reverse()) {
    if (sig.err) continue;

    const tx = await connection.getTransaction(sig.signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx?.meta?.logMessages) continue;

    let isShield = false;
    let leafIndex: number | null = null;

    for (const log of tx.meta.logMessages) {
      if (log.includes('Instruction: Shield')) isShield = true;
      const match = log.match(/Commitment added at index: (\d+)/);
      if (match) leafIndex = parseInt(match[1]);
    }

    if (isShield && leafIndex !== null) {
      // Extract commitment from instruction data
      const txData = tx.transaction.message;

      if ('compiledInstructions' in txData) {
        const programIndex = txData.staticAccountKeys.findIndex(
          (k: PublicKey) => k.equals(ZK_PROGRAM_ID)
        );

        for (const ix of txData.compiledInstructions) {
          if (ix.programIdIndex === programIndex && ix.data.length >= 80) {
            const commitmentBytes = Buffer.from(ix.data.slice(16, 48));
            const commitment = leBytesToBigint(commitmentBytes);
            commitments.push({ index: leafIndex, commitment });
            console.log(`Leaf ${leafIndex}: ${commitment.toString().slice(0, 25)}...`);
            break;
          }
        }
      }
    }
  }

  console.log('\nTotal commitments found:', commitments.length);

  // Rebuild merkle tree
  console.log('\n=== Rebuilding Merkle Tree ===');

  // Sort by index
  commitments.sort((a, b) => a.index - b.index);

  // Build tree
  const nodes = new Map<string, bigint>();
  const getNode = (level: number, index: number): bigint => {
    const key = `${level}-${index}`;
    return nodes.get(key) ?? ZEROS[level];
  };
  const setNode = (level: number, index: number, value: bigint) => {
    nodes.set(`${level}-${index}`, value);
  };

  let localRoot = ZEROS[20];

  for (let i = 0; i < leafCount; i++) {
    const leaf = commitments.find(c => c.index === i)?.commitment ?? BigInt(0);
    if (!commitments.find(c => c.index === i)) {
      console.log(`WARNING: Missing commitment at index ${i}`);
    }

    let currentHash = leaf;
    let currentIndex = i;

    for (let level = 0; level < 20; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling = getNode(level, siblingIndex);

      setNode(level, currentIndex, currentHash);

      currentHash = isRight
        ? poseidon2([sibling, currentHash])
        : poseidon2([currentHash, sibling]);
      currentIndex = Math.floor(currentIndex / 2);
    }

    localRoot = currentHash;
  }

  console.log('\nLocal computed root:', localRoot.toString().slice(0, 30) + '...');
  console.log('On-chain root:      ', onChainRoot.toString().slice(0, 30) + '...');
  console.log('\nROOTS MATCH:', localRoot === onChainRoot);

  if (localRoot !== onChainRoot) {
    console.log('\n!!! ROOT MISMATCH !!!');
    console.log('This means the commitment parsing or tree construction is wrong.');
  }
}

main().catch(console.error);
