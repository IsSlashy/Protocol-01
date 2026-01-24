/**
 * Full diagnostic for unshield operation
 * This simulates exactly what the app does to find the mismatch
 */
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { poseidon1, poseidon2, poseidon4 } from 'poseidon-lite';
import * as crypto from 'crypto';

const ZK_PROGRAM_ID = new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY');
const TOKEN_MINT = SystemProgram.programId;
const DEPTH = 20;

// Field modulus
const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

// Convert LE bytes to bigint
function leBytesToBigint(bytes: Uint8Array | Buffer): bigint {
  let result = BigInt(0);
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << BigInt(8)) | BigInt(bytes[i]);
  }
  return result;
}

// Convert bigint to LE bytes
function bigintToLeBytes(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let temp = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(temp & BigInt(0xff));
    temp = temp >> BigInt(8);
  }
  return bytes;
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
  for (let i = 1; i <= DEPTH; i++) {
    ZEROS.push(poseidon2([ZEROS[i-1], ZEROS[i-1]]));
  }
}

// Merkle Tree class
class MerkleTree {
  private leaves: bigint[] = [];
  private nodes = new Map<string, bigint>();
  private _root: bigint = ZEROS[DEPTH];

  get root(): bigint { return this._root; }
  get leafCount(): number { return this.leaves.length; }

  insert(leaf: bigint): bigint {
    const index = this.leaves.length;
    this.leaves.push(leaf);

    let currentHash = leaf;
    let currentIndex = index;

    for (let level = 0; level < DEPTH; level++) {
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
    for (let level = 0; level < DEPTH; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;

      pathElements.push(this.getNode(level, siblingIndex));
      pathIndices.push(isRight ? 1 : 0);

      currentIndex = Math.floor(currentIndex / 2);
    }

    return { pathElements, pathIndices };
  }
}

// Derive spending key (same as app)
async function deriveSpendingKey(seedPhrase: string): Promise<{
  spendingKey: bigint;
  ownerPubkey: bigint;
}> {
  const seed = Buffer.from(seedPhrase + ':spending_key', 'utf-8');
  const hash = crypto.createHash('sha256').update(seed.toString('hex')).digest('hex');

  const spendingKey = BigInt('0x' + hash) % FIELD_MODULUS;
  const ownerPubkey = poseidon1([spendingKey]);

  return { spendingKey, ownerPubkey };
}

async function main() {
  // This is a TEST seed phrase - in real app, user's seed phrase is used
  const TEST_SEED = 'test seed phrase for diagnostic purposes only';

  console.log('=== Full Diagnostic ===\n');

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

  // Fetch on-chain state
  const merkleAccount = await connection.getAccountInfo(merkleTreePDA);
  if (!merkleAccount) {
    console.log('Merkle tree not found');
    return;
  }

  const data = merkleAccount.data;
  const rootBytes = data.slice(8 + 32, 8 + 32 + 32);
  const leafCount = Number(data.readBigUInt64LE(8 + 32 + 32));
  const onChainRoot = leBytesToBigint(rootBytes);

  console.log('On-chain leaf count:', leafCount);
  console.log('On-chain root:', onChainRoot.toString().slice(0, 30) + '...');

  if (leafCount === 0) {
    console.log('\nPool is empty - do a shield first');
    return;
  }

  // Fetch commitment from transaction
  const signatures = await connection.getSignaturesForAddress(merkleTreePDA, { limit: 20 });
  let commitment: bigint | null = null;
  let amount: bigint | null = null;

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
            // Parse: discriminator(8) + amount(8) + commitment(32) + root(32)
            amount = BigInt(Buffer.from(ix.data.slice(8, 16)).readBigUInt64LE());
            commitment = leBytesToBigint(Buffer.from(ix.data.slice(16, 48)));
            break;
          }
        }
      }
    }
  }

  if (!commitment || !amount) {
    console.log('Could not find shield transaction');
    return;
  }

  console.log('\n=== Shield Transaction Data ===');
  console.log('Amount:', amount.toString(), 'lamports');
  console.log('Commitment from tx:', commitment.toString().slice(0, 30) + '...');

  // Build merkle tree
  const tree = new MerkleTree();
  tree.insert(commitment);

  console.log('\n=== Merkle Tree Rebuilt ===');
  console.log('Local root:', tree.root.toString().slice(0, 30) + '...');
  console.log('Roots match:', tree.root === onChainRoot);

  // Generate proof
  const proof = tree.generateProof(0);
  console.log('\n=== Merkle Proof ===');
  console.log('PathIndices[0-4]:', proof.pathIndices.slice(0, 5));

  // Verify proof
  let computedRoot = commitment;
  for (let i = 0; i < DEPTH; i++) {
    const sibling = proof.pathElements[i];
    const isRight = proof.pathIndices[i] === 1;
    computedRoot = isRight
      ? poseidon2([sibling, computedRoot])
      : poseidon2([computedRoot, sibling]);
  }
  console.log('Proof verification:', computedRoot === onChainRoot ? '✓ VALID' : '✗ INVALID');

  // Now simulate what the app would pass to the circuit
  console.log('\n=== Simulating Circuit Inputs ===');

  // Derive keys (using test seed - won't match real user's keys)
  const keys = await deriveSpendingKey(TEST_SEED);
  console.log('Test ownerPubkey:', keys.ownerPubkey.toString().slice(0, 20) + '...');

  // TokenMint
  const tokenMintField = BigInt('0x' + Buffer.from(TOKEN_MINT.toBytes()).toString('hex'));
  console.log('TokenMint (should be 0):', tokenMintField.toString());

  // The issue might be: the commitment stored in the note has a DIFFERENT ownerPubkey
  // than what the circuit expects.
  //
  // Let's check: if we had the correct randomness and ownerPubkey, we could recompute
  // the commitment and verify it matches.

  console.log('\n=== Key Insight ===');
  console.log('The commitment in the shield tx was computed with:');
  console.log('  amount, ownerPubkey, randomness, tokenMint');
  console.log('');
  console.log('For the circuit to accept, we need to provide inputs such that:');
  console.log('  1. Poseidon(amount, ownerPubkey, randomness, tokenMint) = commitment');
  console.log('  2. Poseidon(spending_key) = ownerPubkey');
  console.log('  3. Merkle proof is valid');
  console.log('');
  console.log('If the app stored a note with a DIFFERENT ownerPubkey or randomness,');
  console.log('the computed commitment will not match the on-chain commitment,');
  console.log('and the merkle proof will fail.');

  console.log('\n=== Checking Circuit Math ===');
  // The commitment from on-chain is known
  // We need to verify that the circuit can recreate it

  // For input note verification, the circuit does:
  // 1. inCommitment1.commitment = Poseidon(in_amount_1, in_owner_pubkey_1, in_randomness_1, token_mint)
  // 2. merkleChecker1.leaf = inCommitment1.commitment
  // 3. merkleChecker1 computes root from leaf + path
  // 4. If in_amount_1 > 0: verify computed_root == merkle_root

  // So if the note's commitment doesn't match the on-chain commitment,
  // the merkle proof will be for the WRONG leaf, and the computed root
  // will not match.

  console.log('\nTo debug in the app, check these values:');
  console.log('1. note.commitment should equal:', commitment.toString().slice(0, 30) + '...');
  console.log('2. merkle_root should equal:', tree.root.toString().slice(0, 30) + '...');
  console.log('3. The proof pathElements[0] should be:', proof.pathElements[0].toString().slice(0, 25) + '...');
  console.log('   (This is ZEROS[0] since it is the sibling of leaf 0)');
}

main().catch(console.error);
