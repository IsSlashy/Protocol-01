/**
 * Debug script to verify merkle tree and circuit inputs match
 */
const snarkjs = require('snarkjs');
const path = require('path');
const fs = require('fs');

// Use circomlib's buildPoseidon for hash function
let poseidon;

async function initPoseidon() {
    const { buildPoseidon } = require('circomlibjs');
    poseidon = await buildPoseidon();
}

function poseidonHash(inputs) {
    const hash = poseidon(inputs.map(x => BigInt(x)));
    return poseidon.F.toObject(hash);
}

// Convert zero value bytes (from mobile) to bigint
function getZeroValueFromBytes() {
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

async function main() {
    await initPoseidon();

    console.log('=== ZK Merkle Tree Debugging ===\n');

    // 1. Compare zero values
    const zeroFromBytes = getZeroValueFromBytes();
    const zeroFromTest = BigInt('21663839004416932945382355908790599225266501822907911457504978515578255421292');

    console.log('1. Zero Value Comparison:');
    console.log('   From mobile bytes:', zeroFromBytes.toString());
    console.log('   From test script:', zeroFromTest.toString());
    console.log('   Match:', zeroFromBytes === zeroFromTest);
    console.log('');

    // 2. Build empty tree with mobile's zero value
    console.log('2. Empty Tree Construction:');
    const MERKLE_DEPTH = 20;
    let currentHash = zeroFromBytes;
    console.log('   Level 0 (leaf):', currentHash.toString().slice(0, 30) + '...');

    for (let i = 0; i < 3; i++) {
        currentHash = poseidonHash([currentHash, currentHash]);
        console.log(`   Level ${i+1}:`, currentHash.toString().slice(0, 30) + '...');
    }
    console.log('   ...');

    // Compute full tree root
    let root = zeroFromBytes;
    for (let i = 0; i < MERKLE_DEPTH; i++) {
        root = poseidonHash([root, root]);
    }
    console.log('   Root (level 20):', root.toString());
    console.log('');

    // 3. Test commitment computation
    console.log('3. Commitment Computation Test:');
    const testSpendingKey = BigInt('12345678901234567890');
    const testOwnerPubkey = poseidonHash([testSpendingKey]);
    const testAmount = BigInt(100000);
    const testRandomness = BigInt('7777777777');
    const testTokenMint = BigInt(0); // SOL

    const commitment = poseidonHash([testAmount, testOwnerPubkey, testRandomness, testTokenMint]);
    console.log('   Spending Key:', testSpendingKey.toString());
    console.log('   Owner Pubkey:', testOwnerPubkey.toString());
    console.log('   Amount:', testAmount.toString());
    console.log('   Randomness:', testRandomness.toString());
    console.log('   Token Mint:', testTokenMint.toString());
    console.log('   Commitment:', commitment.toString());
    console.log('');

    // 4. Test with single commitment in tree
    console.log('4. Merkle Proof for Single Commitment:');

    // Insert commitment at index 0 (replace first zero value)
    // Compute siblings for index 0: all zeros at each level
    let zeroValues = [zeroFromBytes];
    for (let i = 1; i <= MERKLE_DEPTH; i++) {
        zeroValues.push(poseidonHash([zeroValues[i-1], zeroValues[i-1]]));
    }

    // Path for index 0: all left (pathIndices = all 0), siblings = zero values
    let computedPath = [commitment];
    for (let i = 0; i < MERKLE_DEPTH; i++) {
        const left = computedPath[i];
        const right = zeroValues[i];  // sibling is zero value at this level
        computedPath.push(poseidonHash([left, right]));
    }

    const computedRoot = computedPath[MERKLE_DEPTH];
    console.log('   Computed Root:', computedRoot.toString());
    console.log('');

    // 5. Test proof generation with snarkjs
    console.log('5. Testing Circuit Proof Generation:');
    const wasmPath = path.join(__dirname, '../packages/zk-sdk/wasm/transfer.wasm');
    const zkeyPath = path.join(__dirname, '../packages/zk-sdk/wasm/transfer_final.zkey');

    if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
        console.log('   ERROR: Circuit files not found');
        return;
    }

    // Create dummy note 2 (amount=0) to test conditional merkle skip
    const dummyCommitment = poseidonHash([BigInt(0), BigInt(0), BigInt(0), testTokenMint]);
    const dummyNullifier = poseidonHash([dummyCommitment, poseidonHash([testSpendingKey])]);

    // Nullifiers
    const spendingKeyHash = poseidonHash([testSpendingKey]);
    const nullifier1 = poseidonHash([commitment, spendingKeyHash]);

    // Output: unshield all (amount goes to public_amount negative)
    const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
    const publicAmount = FIELD_MODULUS - testAmount; // Negative for unshield

    // Output notes: change=0, second output=0
    const outCommitment1 = poseidonHash([BigInt(0), BigInt(0), BigInt(0), testTokenMint]);
    const outCommitment2 = poseidonHash([BigInt(0), BigInt(0), BigInt(0), testTokenMint]);

    const circuitInputs = {
        // Public inputs
        merkle_root: computedRoot.toString(),
        nullifier_1: nullifier1.toString(),
        nullifier_2: dummyNullifier.toString(),
        output_commitment_1: outCommitment1.toString(),
        output_commitment_2: outCommitment2.toString(),
        public_amount: publicAmount.toString(),
        token_mint: testTokenMint.toString(),

        // Input 1 (real note)
        in_amount_1: testAmount.toString(),
        in_owner_pubkey_1: testOwnerPubkey.toString(),
        in_randomness_1: testRandomness.toString(),
        in_path_indices_1: Array(MERKLE_DEPTH).fill('0'),  // All left
        in_path_elements_1: zeroValues.slice(0, MERKLE_DEPTH).map(v => v.toString()),

        // Input 2 (dummy note - amount=0 should skip merkle check)
        in_amount_2: '0',
        in_owner_pubkey_2: '0',
        in_randomness_2: '0',
        in_path_indices_2: Array(MERKLE_DEPTH).fill('0'),
        in_path_elements_2: Array(MERKLE_DEPTH).fill('0'),

        // Output 1 (dummy)
        out_amount_1: '0',
        out_recipient_1: '0',
        out_randomness_1: '0',

        // Output 2 (dummy)
        out_amount_2: '0',
        out_recipient_2: '0',
        out_randomness_2: '0',

        spending_key: testSpendingKey.toString()
    };

    console.log('   Merkle Root:', circuitInputs.merkle_root.slice(0, 30) + '...');
    console.log('   Public Amount:', circuitInputs.public_amount.slice(0, 30) + '...');
    console.log('   Input Amount 1:', circuitInputs.in_amount_1);
    console.log('   Input Amount 2:', circuitInputs.in_amount_2);
    console.log('');

    try {
        console.log('   Generating proof...');
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            circuitInputs,
            wasmPath,
            zkeyPath
        );
        console.log('   PROOF GENERATED SUCCESSFULLY!');
        console.log('');
        console.log('   This confirms the circuit works with:');
        console.log('   - Real input note (amount > 0) with valid merkle proof');
        console.log('   - Dummy input note (amount = 0) with zeroed merkle path');
        console.log('');
    } catch (err) {
        console.error('   PROOF GENERATION FAILED:', err.message);
        console.log('');
        console.log('   The circuit is rejecting the inputs. Possible causes:');
        console.log('   1. Zero value mismatch between circuit and client');
        console.log('   2. Commitment computation mismatch');
        console.log('   3. Merkle path elements incorrect');
    }
}

main().catch(console.error);
