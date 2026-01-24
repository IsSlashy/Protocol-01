/**
 * Debug script that mimics EXACTLY what the mobile app does
 * to identify where the mismatch occurs
 */
const snarkjs = require('snarkjs');
const path = require('path');
const fs = require('fs');

// Mimic poseidon-lite (mobile uses this)
const { poseidon1, poseidon2, poseidon3, poseidon4 } = require('poseidon-lite');

function poseidonHash(...inputs) {
    switch (inputs.length) {
        case 1: return poseidon1(inputs);
        case 2: return poseidon2(inputs);
        case 3: return poseidon3(inputs);
        case 4: return poseidon4(inputs);
        default: throw new Error(`Unsupported input count ${inputs.length}`);
    }
}

// Constants from mobile
const MERKLE_TREE_DEPTH = 20;
const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

// Zero value from mobile (keccak256("specter") mod p)
function getZeroValue() {
    const ZERO_VALUE_BYTES = [
        0x6c, 0xaf, 0x99, 0x48, 0xed, 0x85, 0x96, 0x24,
        0xe2, 0x41, 0xe7, 0x76, 0x0f, 0x34, 0x1b, 0x82,
        0xb4, 0x5d, 0xa1, 0xeb, 0xb6, 0x35, 0x3a, 0x34,
        0xf3, 0xab, 0xac, 0xd3, 0x60, 0x4c, 0xe5, 0x2f,
    ];
    let baseZero = BigInt(0);
    for (let i = ZERO_VALUE_BYTES.length - 1; i >= 0; i--) {
        baseZero = (baseZero << BigInt(8)) | BigInt(ZERO_VALUE_BYTES[i]);
    }
    return baseZero;
}

// Merkle Tree class (copy from mobile)
class MerkleTree {
    constructor(depth = MERKLE_TREE_DEPTH) {
        this.depth = depth;
        this.leaves = [];
        this.nodes = new Map();
        this._root = null;
        this._zeroValues = null;
    }

    get root() {
        if (this._root === null) {
            this._root = this.getZeroValue(this.depth);
        }
        return this._root;
    }

    get leafCount() {
        return this.leaves.length;
    }

    getZeroValue(level) {
        if (!this._zeroValues) {
            const baseZero = getZeroValue();
            this._zeroValues = [baseZero];
            for (let i = 1; i <= this.depth; i++) {
                const prev = this._zeroValues[i - 1];
                this._zeroValues.push(poseidonHash(prev, prev));
            }
        }
        return this._zeroValues[level];
    }

    insert(leaf) {
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
                ? poseidonHash(sibling, currentHash)
                : poseidonHash(currentHash, sibling);
            currentIndex = Math.floor(currentIndex / 2);
        }

        this._root = currentHash;
        return this._root;
    }

    getNode(level, index) {
        const key = `${level}-${index}`;
        return this.nodes.get(key) ?? this.getZeroValue(level);
    }

    setNode(level, index, value) {
        const key = `${level}-${index}`;
        this.nodes.set(key, value);
    }

    generateProof(leafIndex) {
        const pathElements = [];
        const pathIndices = [];

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
    console.log('=== Mobile App Input Simulation ===\n');

    // Simulate mobile app behavior
    const spendingKey = BigInt('12345678901234567890');
    const ownerPubkey = poseidonHash(spendingKey);
    const spendingKeyHash = poseidonHash(spendingKey);
    const tokenMint = BigInt(0); // SOL

    console.log('1. Key derivation (using poseidon-lite):');
    console.log('   spendingKey:', spendingKey.toString());
    console.log('   ownerPubkey = Poseidon(spendingKey):', ownerPubkey.toString());
    console.log('');

    // Create and shield a note
    const amount = BigInt(100000); // 0.0001 SOL
    const randomness = BigInt('7777777777');

    // Compute commitment (mobile way)
    const commitment = poseidonHash(amount, ownerPubkey, randomness, tokenMint);
    console.log('2. Note creation:');
    console.log('   amount:', amount.toString());
    console.log('   ownerPubkey:', ownerPubkey.toString());
    console.log('   randomness:', randomness.toString());
    console.log('   tokenMint:', tokenMint.toString());
    console.log('   commitment = Poseidon(amount, ownerPubkey, randomness, tokenMint):');
    console.log('              ', commitment.toString());
    console.log('');

    // Create merkle tree and insert note
    const merkleTree = new MerkleTree(MERKLE_TREE_DEPTH);
    const leafIndex = merkleTree.leafCount;
    const newRoot = merkleTree.insert(commitment);

    console.log('3. Merkle tree:');
    console.log('   Zero value (level 0):', merkleTree.getZeroValue(0).toString().slice(0, 30) + '...');
    console.log('   Leaf index:', leafIndex);
    console.log('   Root after insert:', newRoot.toString());
    console.log('');

    // Generate merkle proof
    const proof = merkleTree.generateProof(leafIndex);

    console.log('4. Merkle proof (first 5 levels):');
    for (let i = 0; i < 5; i++) {
        console.log(`   Level ${i}: index=${proof.pathIndices[i]}, sibling=${proof.pathElements[i].toString().slice(0, 20)}...`);
    }
    console.log('');

    // Verify proof locally
    let computedRoot = commitment;
    for (let i = 0; i < MERKLE_TREE_DEPTH; i++) {
        const sibling = proof.pathElements[i];
        const isRight = proof.pathIndices[i] === 1;
        computedRoot = isRight
            ? poseidonHash(sibling, computedRoot)
            : poseidonHash(computedRoot, sibling);
    }
    console.log('5. Local proof verification:');
    console.log('   Expected root:', newRoot.toString());
    console.log('   Computed root:', computedRoot.toString());
    console.log('   Match:', computedRoot === newRoot);
    console.log('');

    // Now prepare inputs for unshield (like mobile does)
    // Dummy note 2 (amount=0)
    const dummyCommitment = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMint);
    const dummyNullifier = poseidonHash(dummyCommitment, spendingKeyHash);

    // Nullifier for real note
    const nullifier1 = poseidonHash(commitment, spendingKeyHash);

    // Output: unshield all funds
    const publicAmount = FIELD_MODULUS - amount; // Negative amount in field

    // Dummy output notes
    const outCommitment1 = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMint);
    const outCommitment2 = poseidonHash(BigInt(0), BigInt(0), BigInt(0), tokenMint);

    console.log('6. Unshield inputs:');
    console.log('   merkle_root:', newRoot.toString());
    console.log('   nullifier_1:', nullifier1.toString());
    console.log('   nullifier_2:', dummyNullifier.toString());
    console.log('   public_amount:', publicAmount.toString());
    console.log('');

    // Prepare circuit inputs (exactly like mobile)
    const circuitInputs = {
        merkle_root: newRoot.toString(),
        nullifier_1: nullifier1.toString(),
        nullifier_2: dummyNullifier.toString(),
        output_commitment_1: outCommitment1.toString(),
        output_commitment_2: outCommitment2.toString(),
        public_amount: publicAmount.toString(),
        token_mint: tokenMint.toString(),

        // Input 1 (real note)
        in_amount_1: amount.toString(),
        in_owner_pubkey_1: ownerPubkey.toString(),
        in_randomness_1: randomness.toString(),
        in_path_indices_1: proof.pathIndices.map(i => i.toString()),
        in_path_elements_1: proof.pathElements.map(e => e.toString()),

        // Input 2 (dummy)
        in_amount_2: '0',
        in_owner_pubkey_2: '0',
        in_randomness_2: '0',
        in_path_indices_2: Array(MERKLE_TREE_DEPTH).fill('0'),
        in_path_elements_2: Array(MERKLE_TREE_DEPTH).fill('0'),

        // Output 1
        out_amount_1: '0',
        out_recipient_1: '0',
        out_randomness_1: '0',

        // Output 2
        out_amount_2: '0',
        out_recipient_2: '0',
        out_randomness_2: '0',

        spending_key: spendingKey.toString()
    };

    console.log('7. Testing proof generation with snarkjs...');

    const wasmPath = path.join(__dirname, '../packages/zk-sdk/wasm/transfer.wasm');
    const zkeyPath = path.join(__dirname, '../packages/zk-sdk/wasm/transfer_final.zkey');

    try {
        const { proof: zkProof, publicSignals } = await snarkjs.groth16.fullProve(
            circuitInputs,
            wasmPath,
            zkeyPath
        );
        console.log('   PROOF GENERATED SUCCESSFULLY!\n');
        console.log('   Public signals:', publicSignals.slice(0, 5).map(s => s.toString().slice(0, 20) + '...'));
        console.log('');
        console.log('=== CONCLUSION ===');
        console.log('The circuit works with poseidon-lite hashes.');
        console.log('If mobile fails, check:');
        console.log('  1. Is the merkle tree synced correctly from blockchain?');
        console.log('  2. Are commitments extracted correctly from tx logs?');
        console.log('  3. Is there a race condition in note storage?');
    } catch (err) {
        console.log('   PROOF GENERATION FAILED:', err.message);
        console.log('');
        console.log('=== ERROR ANALYSIS ===');
        if (err.message.includes('MerkleTreeChecker')) {
            console.log('Merkle proof verification failed.');
            console.log('This means the computed root != expected root.');
        }
    }
}

main().catch(console.error);
