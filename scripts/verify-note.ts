/**
 * Verify the merkle proof for the shielded note
 */
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { poseidon2 } from 'poseidon-lite';

const ZK_PROGRAM_ID = new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY');
const TOKEN_MINT = SystemProgram.programId;

// Convert LE bytes to bigint
function leBytesToBigint(bytes: Uint8Array): bigint {
  let result = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << BigInt(8)) | BigInt(bytes[i]);
  }
  return result;
}

// ZEROS
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

class MerkleTree {
  private depth = 20;
  private leaves: bigint[] = [];
  private nodes = new Map<string, bigint>();

  get root(): bigint {
    if (this.leaves.length === 0) return ZEROS[this.depth];
    return this._root;
  }
  private _root: bigint = ZEROS[20];

  insert(leaf: bigint): bigint {
    const index = this.leaves.length;
    this.leaves.push(leaf);

    let currentHash = leaf;
    let currentIndex = index;

    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling = this.getNode(level, siblingIndex);

      this.setNode(level, currentIndex, currentHash);

      currentHash = isRight
        ? poseidon2([sibling, currentHash])
        : poseidon2([currentHash, sibling]);
      currentIndex = Math.floor(currentIndex / 2);
    }

    this._root = currentHash;
    return this._root;
  }

  private getNode(level: number, index: number): bigint {
    return this.nodes.get(`${level}-${index}`) ?? ZEROS[level];
  }

  private setNode(level: number, index: number, value: bigint): void {
    this.nodes.set(`${level}-${index}`, value);
  }

  generateProof(leafIndex: number): { pathElements: bigint[]; pathIndices: number[] } {
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentIndex = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;

      pathElements.push(this.getNode(level, siblingIndex));
      pathIndices.push(isRight ? 1 : 0);

      currentIndex = Math.floor(currentIndex / 2);
    }

    return { pathElements, pathIndices };
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

  // Fetch merkle tree state
  const merkleAccount = await connection.getAccountInfo(merkleTreePDA);
  if (!merkleAccount) {
    console.log('No merkle tree found');
    return;
  }

  const data = merkleAccount.data;
  const rootBytes = data.slice(8 + 32, 8 + 32 + 32);
  const leafCount = Number(data.readBigUInt64LE(8 + 32 + 32));
  const onChainRoot = leBytesToBigint(rootBytes);

  console.log('=== On-chain State ===');
  console.log('Leaf count:', leafCount);
  console.log('On-chain root:', onChainRoot.toString().slice(0, 30) + '...');

  if (leafCount === 0) {
    console.log('Pool is empty');
    return;
  }

  // Fetch the commitment from transaction
  const signatures = await connection.getSignaturesForAddress(merkleTreePDA, { limit: 10 });
  let commitment: bigint | null = null;

  for (const sig of signatures.reverse()) {
    if (sig.err) continue;
    const tx = await connection.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta?.logMessages) continue;

    let isShield = false;
    let leafIdx: number | null = null;

    for (const log of tx.meta.logMessages) {
      if (log.includes('Instruction: Shield')) isShield = true;
      const m = log.match(/Commitment added at index: (\d+)/);
      if (m) leafIdx = parseInt(m[1]);
    }

    if (isShield && leafIdx === 0) {
      const txData = tx.transaction.message;
      if ('compiledInstructions' in txData) {
        const programIndex = txData.staticAccountKeys.findIndex(k => k.equals(ZK_PROGRAM_ID));
        for (const ix of txData.compiledInstructions) {
          if (ix.programIdIndex === programIndex && ix.data.length >= 80) {
            commitment = leBytesToBigint(Buffer.from(ix.data.slice(16, 48)));
            break;
          }
        }
      }
    }
  }

  if (!commitment) {
    console.log('Could not find commitment from transactions');
    return;
  }

  console.log('\n=== Commitment ===');
  console.log('Commitment:', commitment.toString().slice(0, 30) + '...');

  // Build tree and generate proof
  const tree = new MerkleTree();
  tree.insert(commitment);

  console.log('\n=== Local Tree ===');
  console.log('Local root:', tree.root.toString().slice(0, 30) + '...');
  console.log('Roots match:', tree.root === onChainRoot);

  // Generate proof for leaf 0
  const proof = tree.generateProof(0);
  console.log('\n=== Merkle Proof for Leaf 0 ===');
  console.log('Path indices (first 5):', proof.pathIndices.slice(0, 5));
  console.log('Path elements (first 3):');
  proof.pathElements.slice(0, 3).forEach((e, i) => {
    console.log(`  Level ${i}: ${e.toString().slice(0, 25)}...`);
  });

  // Verify the proof
  console.log('\n=== Verifying Proof ===');
  let computedRoot = commitment;
  for (let i = 0; i < 20; i++) {
    const sibling = proof.pathElements[i];
    const isRight = proof.pathIndices[i] === 1;
    computedRoot = isRight
      ? poseidon2([sibling, computedRoot])
      : poseidon2([computedRoot, sibling]);
  }

  console.log('Computed root from proof:', computedRoot.toString().slice(0, 30) + '...');
  console.log('Expected root:           ', onChainRoot.toString().slice(0, 30) + '...');
  console.log('PROOF VALID:', computedRoot === onChainRoot);

  if (computedRoot !== onChainRoot) {
    console.log('\n!!! PROOF VERIFICATION FAILED !!!');
  } else {
    console.log('\n✓ Proof is valid - the circuit should accept this');
    console.log('\nIf the circuit still fails, the issue is in how the app');
    console.log('constructs the circuit inputs, not in the merkle tree logic.');
  }
}

main().catch(console.error);
