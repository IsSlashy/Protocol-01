const snarkjs = require('snarkjs');
const { poseidon } = require('circomlib');
const path = require('path');
const fs = require('fs');

// Test constants
const MERKLE_DEPTH = 20;
const ZERO_VALUE = BigInt('21663839004416932945382355908790599225266501822907911457504978515578255421292');

// Helper function to compute Poseidon hash
function poseidonHash(inputs) {
    return poseidon(inputs);
}

// Generate empty Merkle tree
function generateEmptyTree(depth) {
    const nodes = [ZERO_VALUE];
    for (let i = 0; i < depth; i++) {
        nodes.push(poseidonHash([nodes[i], nodes[i]]));
    }
    return nodes;
}

// Generate Merkle path for a leaf
function generateMerklePath(tree, leafIndex, depth) {
    const pathElements = [];
    const pathIndices = [];

    let index = leafIndex;
    for (let i = 0; i < depth; i++) {
        pathIndices.push(index % 2);
        pathElements.push(tree[i]); // Sibling
        index = Math.floor(index / 2);
    }

    return { pathElements, pathIndices };
}

// Create a note
function createNote(amount, ownerPubkey, randomness, tokenMint) {
    const commitment = poseidonHash([amount, ownerPubkey, randomness, tokenMint]);
    return { amount, ownerPubkey, randomness, tokenMint, commitment };
}

// Create nullifier
function createNullifier(commitment, spendingKeyHash) {
    return poseidonHash([commitment, spendingKeyHash]);
}

// Derive owner pubkey from spending key
function deriveOwnerPubkey(spendingKey) {
    return poseidonHash([spendingKey]);
}

// Main test
async function runTest() {
    console.log('Testing Specter ZK Transfer Circuit...\n');

    // Generate test keys
    const spendingKey = BigInt('12345678901234567890');
    const ownerPubkey = deriveOwnerPubkey(spendingKey);
    const spendingKeyHash = poseidonHash([spendingKey]);

    console.log('Spending Key:', spendingKey.toString());
    console.log('Owner Pubkey:', ownerPubkey.toString());

    // Token mint (SOL = 0 for simplicity)
    const tokenMint = BigInt(0);

    // Create input notes
    const randomness1 = BigInt('111111111111');
    const randomness2 = BigInt('222222222222');
    const note1 = createNote(BigInt(1000), ownerPubkey, randomness1, tokenMint);
    const note2 = createNote(BigInt(500), ownerPubkey, randomness2, tokenMint);

    console.log('\nInput Note 1:');
    console.log('  Amount:', note1.amount.toString());
    console.log('  Commitment:', note1.commitment.toString());

    console.log('\nInput Note 2:');
    console.log('  Amount:', note2.amount.toString());
    console.log('  Commitment:', note2.commitment.toString());

    // Build simple Merkle tree with just these two notes
    const emptyTree = generateEmptyTree(MERKLE_DEPTH);
    // For testing, we use the empty tree and pretend both notes are at index 0 and 1

    // Generate Merkle paths (simplified for testing)
    const path1 = generateMerklePath(emptyTree, 0, MERKLE_DEPTH);
    const path2 = generateMerklePath(emptyTree, 1, MERKLE_DEPTH);

    // Compute merkle root (simplified - in reality would need to insert notes)
    // For now, we use a mock root
    const merkle_root = emptyTree[MERKLE_DEPTH];

    // Create nullifiers
    const nullifier1 = createNullifier(note1.commitment, spendingKeyHash);
    const nullifier2 = createNullifier(note2.commitment, spendingKeyHash);

    console.log('\nNullifier 1:', nullifier1.toString());
    console.log('Nullifier 2:', nullifier2.toString());

    // Create output notes (transfer 800 to recipient, 700 back to self)
    const recipientPubkey = BigInt('9999999999999');
    const outRandomness1 = BigInt('333333333333');
    const outRandomness2 = BigInt('444444444444');
    const outNote1 = createNote(BigInt(800), recipientPubkey, outRandomness1, tokenMint);
    const outNote2 = createNote(BigInt(700), ownerPubkey, outRandomness2, tokenMint);

    console.log('\nOutput Note 1 (to recipient):');
    console.log('  Amount:', outNote1.amount.toString());
    console.log('  Commitment:', outNote1.commitment.toString());

    console.log('\nOutput Note 2 (change):');
    console.log('  Amount:', outNote2.amount.toString());
    console.log('  Commitment:', outNote2.commitment.toString());

    // Value conservation check
    const totalIn = note1.amount + note2.amount;
    const totalOut = outNote1.amount + outNote2.amount;
    console.log('\nValue Conservation:');
    console.log('  Total In:', totalIn.toString());
    console.log('  Total Out:', totalOut.toString());
    console.log('  Balance:', (totalIn === totalOut) ? 'VALID' : 'INVALID');

    // Prepare circuit inputs
    const circuitInputs = {
        // Public inputs
        merkle_root: merkle_root.toString(),
        nullifier_1: nullifier1.toString(),
        nullifier_2: nullifier2.toString(),
        output_commitment_1: outNote1.commitment.toString(),
        output_commitment_2: outNote2.commitment.toString(),
        public_amount: '0', // Private transfer
        token_mint: tokenMint.toString(),

        // Private inputs - Note 1
        in_amount_1: note1.amount.toString(),
        in_owner_pubkey_1: ownerPubkey.toString(),
        in_randomness_1: randomness1.toString(),
        in_path_indices_1: path1.pathIndices.map(x => x.toString()),
        in_path_elements_1: path1.pathElements.map(x => x.toString()),

        // Private inputs - Note 2
        in_amount_2: note2.amount.toString(),
        in_owner_pubkey_2: ownerPubkey.toString(),
        in_randomness_2: randomness2.toString(),
        in_path_indices_2: path2.pathIndices.map(x => x.toString()),
        in_path_elements_2: path2.pathElements.map(x => x.toString()),

        // Output notes
        out_amount_1: outNote1.amount.toString(),
        out_recipient_1: recipientPubkey.toString(),
        out_randomness_1: outRandomness1.toString(),

        out_amount_2: outNote2.amount.toString(),
        out_recipient_2: ownerPubkey.toString(),
        out_randomness_2: outRandomness2.toString(),

        // Spending key
        spending_key: spendingKey.toString()
    };

    console.log('\nCircuit Inputs prepared. Ready for proof generation.');
    console.log('Input structure:', JSON.stringify(circuitInputs, null, 2));

    // Save inputs for later use
    const buildDir = path.join(__dirname, '../build');
    if (!fs.existsSync(buildDir)) {
        fs.mkdirSync(buildDir, { recursive: true });
    }
    fs.writeFileSync(
        path.join(buildDir, 'test_input.json'),
        JSON.stringify(circuitInputs, null, 2)
    );
    console.log('\nTest inputs saved to build/test_input.json');

    console.log('\n--- Test Complete ---');
}

runTest().catch(console.error);
