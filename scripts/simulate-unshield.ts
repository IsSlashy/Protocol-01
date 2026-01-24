/**
 * Simulate the exact unshield flow to debug the circuit error
 * This reproduces what the mobile app does, step by step
 */
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { poseidon1, poseidon2, poseidon4 } from 'poseidon-lite';
import * as crypto from 'crypto';
import * as snarkjs from 'snarkjs';
import * as fs from 'fs';
import * as path from 'path';

const ZK_PROGRAM_ID = new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY');
const TOKEN_MINT = SystemProgram.programId;
const DEPTH = 20;
const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

// Utilities
function leBytesToBigint(bytes: Uint8Array | Buffer): bigint {
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
  for (let i = 1; i <= DEPTH; i++) {
    ZEROS.push(poseidon2([ZEROS[i-1], ZEROS[i-1]]));
  }
}

// Merkle Tree
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

async function main() {
  console.log('=== Simulating Unshield Flow ===\n');

  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

  // 1. Fetch on-chain state
  const [poolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('shielded_pool'), TOKEN_MINT.toBytes()],
    ZK_PROGRAM_ID
  );
  const [merkleTreePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree'), poolPDA.toBytes()],
    ZK_PROGRAM_ID
  );

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
  console.log('On-chain root:', onChainRoot.toString());

  if (leafCount === 0) {
    console.log('Pool is empty');
    return;
  }

  // 2. Fetch commitment from shield transaction
  const signatures = await connection.getSignaturesForAddress(merkleTreePDA, { limit: 20 });
  let onChainCommitment: bigint | null = null;
  let shieldAmount: bigint | null = null;

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
            shieldAmount = BigInt(Buffer.from(ix.data.slice(8, 16)).readBigUInt64LE());
            onChainCommitment = leBytesToBigint(Buffer.from(ix.data.slice(16, 48)));
            break;
          }
        }
      }
    }
  }

  if (!onChainCommitment || !shieldAmount) {
    console.log('Could not find shield transaction');
    return;
  }

  console.log('\nOn-chain commitment:', onChainCommitment.toString());
  console.log('Shield amount:', shieldAmount.toString(), 'lamports');

  // 3. Build merkle tree
  const tree = new MerkleTree();
  tree.insert(onChainCommitment);

  console.log('\nLocal root:', tree.root.toString());
  console.log('Roots match:', tree.root === onChainRoot);

  // 4. Generate merkle proof
  const proof = tree.generateProof(0);
  console.log('\nMerkle proof generated');
  console.log('pathIndices:', proof.pathIndices);

  // 5. Verify proof locally
  let computedRoot = onChainCommitment;
  for (let i = 0; i < DEPTH; i++) {
    const sibling = proof.pathElements[i];
    const isRight = proof.pathIndices[i] === 1;
    computedRoot = isRight
      ? poseidon2([sibling, computedRoot])
      : poseidon2([computedRoot, sibling]);
  }
  console.log('Proof verification:', computedRoot === onChainRoot ? '✓ VALID' : '✗ INVALID');

  // 6. Now we need the note details (ownerPubkey, randomness)
  // These are stored locally in the app. We don't have them here.
  // But we can TEST with dummy values to see if the circuit works.

  console.log('\n=== Testing Circuit with Synthetic Data ===');
  console.log('(Using dummy spending key since we don\'t have the real one)');

  // Generate a test spending key
  const testSpendingKey = BigInt('12345678901234567890123456789012345678901234567890') % FIELD_MODULUS;
  const testOwnerPubkey = poseidon1([testSpendingKey]);
  const testRandomness = BigInt('98765432109876543210987654321098765432109876543210') % FIELD_MODULUS;
  const tokenMintField = BigInt(0); // Native SOL

  // Compute what the commitment WOULD be with these test values
  const testCommitment = poseidon4([shieldAmount, testOwnerPubkey, testRandomness, tokenMintField]);
  console.log('\nTest commitment:', testCommitment.toString());
  console.log('On-chain commitment:', onChainCommitment.toString());
  console.log('These will NOT match (different keys)');

  // 7. The KEY INSIGHT:
  console.log('\n========================================');
  console.log('KEY INSIGHT:');
  console.log('========================================');
  console.log('The circuit computes: commitment = Poseidon(amount, ownerPubkey, randomness, tokenMint)');
  console.log('Then it uses this commitment as the LEAF for the merkle proof.');
  console.log('');
  console.log('If the app\'s stored note has:');
  console.log('  - The SAME commitment as on-chain (stored at shield time)');
  console.log('  - But DIFFERENT ownerPubkey/randomness (e.g., due to key derivation change)');
  console.log('');
  console.log('Then the circuit will RECOMPUTE a DIFFERENT commitment,');
  console.log('and the merkle proof will fail because the leaf is wrong.');
  console.log('');
  console.log('SOLUTION: Ensure the note stored in SecureStore has the EXACT');
  console.log('same ownerPubkey and randomness that were used to create the');
  console.log('on-chain commitment.');

  // 8. Check if circuit files exist
  const wasmPath = 'P:/Protocol 01/packages/zk-sdk/wasm/transfer.wasm';
  const zkeyPath = 'P:/Protocol 01/packages/zk-sdk/wasm/transfer_final.zkey';

  console.log('\n=== Checking Circuit Files ===');
  console.log('WASM exists:', fs.existsSync(wasmPath));
  console.log('ZKEY exists:', fs.existsSync(zkeyPath));

  if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
    console.log('\nCircuit files not found. Cannot test proof generation.');
    console.log('Expected paths:');
    console.log('  WASM:', wasmPath);
    console.log('  ZKEY:', zkeyPath);
    return;
  }

  // 9. Try generating a proof with valid synthetic data
  // We create a NEW commitment that we control
  console.log('\n=== Testing Proof Generation with Controlled Data ===');

  const syntheticAmount = BigInt(100000000); // 0.1 SOL
  const syntheticOwnerPubkey = testOwnerPubkey;
  const syntheticRandomness = testRandomness;
  const syntheticCommitment = poseidon4([syntheticAmount, syntheticOwnerPubkey, syntheticRandomness, tokenMintField]);

  console.log('Synthetic commitment:', syntheticCommitment.toString());

  // Build a fresh tree with this commitment
  const testTree = new MerkleTree();
  testTree.insert(syntheticCommitment);
  const testMerkleRoot = testTree.root;
  const testProof = testTree.generateProof(0);

  console.log('Test merkle root:', testMerkleRoot.toString());

  // Compute nullifiers
  const spendingKeyHash = poseidon1([testSpendingKey]);
  const nullifier1 = poseidon2([syntheticCommitment, spendingKeyHash]);

  // Dummy note 2 (amount=0)
  const dummyCommitment = poseidon4([BigInt(0), BigInt(0), BigInt(0), tokenMintField]);
  const nullifier2 = poseidon2([dummyCommitment, spendingKeyHash]);

  // Output: change note (amount = input - unshield)
  const unshieldAmount = BigInt(50000000); // 0.05 SOL
  const changeAmount = syntheticAmount - unshieldAmount;
  const changeRandomness = BigInt('11111111111111111111111111111111') % FIELD_MODULUS;
  const changeCommitment = poseidon4([changeAmount, syntheticOwnerPubkey, changeRandomness, tokenMintField]);

  // Dummy output 2
  const dummyOutput2 = poseidon4([BigInt(0), BigInt(0), BigInt(0), tokenMintField]);

  // Public amount (negative for unshield)
  const publicAmount = FIELD_MODULUS - unshieldAmount;

  const circuitInputs = {
    // Public
    merkle_root: testMerkleRoot.toString(),
    nullifier_1: nullifier1.toString(),
    nullifier_2: nullifier2.toString(),
    output_commitment_1: changeCommitment.toString(),
    output_commitment_2: dummyOutput2.toString(),
    public_amount: publicAmount.toString(),
    token_mint: tokenMintField.toString(),
    // Private - Input 1
    in_amount_1: syntheticAmount.toString(),
    in_owner_pubkey_1: syntheticOwnerPubkey.toString(),
    in_randomness_1: syntheticRandomness.toString(),
    in_path_indices_1: testProof.pathIndices.map(i => i.toString()),
    in_path_elements_1: testProof.pathElements.map(e => e.toString()),
    // Private - Input 2 (dummy)
    in_amount_2: '0',
    in_owner_pubkey_2: '0',
    in_randomness_2: '0',
    in_path_indices_2: Array(DEPTH).fill('0'),
    in_path_elements_2: Array(DEPTH).fill('0'),
    // Private - Output 1 (change)
    out_amount_1: changeAmount.toString(),
    out_recipient_1: syntheticOwnerPubkey.toString(),
    out_randomness_1: changeRandomness.toString(),
    // Private - Output 2 (dummy)
    out_amount_2: '0',
    out_recipient_2: '0',
    out_randomness_2: '0',
    // Spending key
    spending_key: testSpendingKey.toString(),
  };

  console.log('\nCircuit inputs prepared. Generating proof...');
  console.log('(This may take a while)');

  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInputs,
      wasmPath,
      zkeyPath
    );
    console.log('\n✓ PROOF GENERATED SUCCESSFULLY!');
    console.log('This proves the circuit and poseidon-lite are compatible.');
    console.log('\nThe problem in the app is likely that the stored note');
    console.log('has different ownerPubkey/randomness than what was used');
    console.log('when the commitment was created.');
  } catch (error: any) {
    console.error('\n✗ Proof generation failed:', error.message);
    if (error.message.includes('MerkleTreeChecker')) {
      console.log('\nThe circuit constraints are not satisfied.');
      console.log('This indicates a bug in the input preparation.');
    }
  }
}

main().catch(console.error);
