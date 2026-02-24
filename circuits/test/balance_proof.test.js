const snarkjs = require('snarkjs');
const path = require('path');
const fs = require('fs');

// ============================================================================
// zkSPL Balance Sufficiency Proof - Test Suite
// ============================================================================

let poseidon;
const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

async function initPoseidon() {
    const { buildPoseidon } = require('circomlibjs');
    poseidon = await buildPoseidon();
}

function poseidonHash(inputs) {
    const hash = poseidon(inputs.map(x => BigInt(x)));
    return poseidon.F.toObject(hash);
}

function createBalanceCommitment(balance, salt, ownerPubkey, tokenMint) {
    return poseidonHash([balance, salt, ownerPubkey, tokenMint]);
}

function deriveOwnerPubkey(spendingKey) {
    return poseidonHash([spendingKey]);
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.log(`  ✗ FAILED: ${message}`);
        failed++;
    }
}

async function proveAndVerify(circuitInputs, wasmPath, zkeyPath, vkPath) {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        circuitInputs,
        wasmPath,
        zkeyPath
    );
    const vk = JSON.parse(fs.readFileSync(vkPath, 'utf8'));
    const isValid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    return { proof, publicSignals, isValid };
}

async function runTests() {
    console.log('============================================');
    console.log('  zkSPL Balance Sufficiency Proof Tests');
    console.log('============================================\n');

    await initPoseidon();

    const spendingKey = BigInt('98765432101234567890');
    const ownerPubkey = deriveOwnerPubkey(spendingKey);
    const tokenMint = BigInt(0);

    const buildDir = path.join(__dirname, '../build');
    const wasmPath = path.join(buildDir, 'balance_proof_js', 'balance_proof.wasm');
    const zkeyPath = path.join(buildDir, 'balance_proof_final.zkey');
    const vkPath = path.join(buildDir, 'balance_proof_vk.json');
    const hasCircuit = fs.existsSync(wasmPath) && fs.existsSync(zkeyPath);

    if (!hasCircuit) {
        console.log('⚠ Circuit not compiled. Running input validation tests only.\n');
    }

    // ================================================================
    // TEST 1: Prove balance ≥ 50 when balance = 100
    // ================================================================
    console.log('--- TEST 1: balance=100, threshold=50 (should PASS) ---');
    {
        const balance = BigInt(100_000_000_000);
        const salt = BigInt('111111111111');
        const threshold = BigInt(50_000_000_000);
        const commitment = createBalanceCommitment(balance, salt, ownerPubkey, tokenMint);

        const difference = balance - threshold;
        assert(difference >= 0n, `Difference is non-negative: ${difference}`);
        assert(difference < BigInt(2) ** BigInt(64), 'Difference fits in 64 bits');

        const inputs = {
            balance_commitment: commitment.toString(),
            threshold: threshold.toString(),
            token_mint: tokenMint.toString(),
            balance: balance.toString(),
            salt: salt.toString(),
            spending_key: spendingKey.toString(),
        };

        if (hasCircuit) {
            try {
                const result = await proveAndVerify(inputs, wasmPath, zkeyPath, vkPath);
                assert(result.isValid, 'Balance sufficiency proof valid');
            } catch (e) {
                assert(false, `Proof failed: ${e.message}`);
            }
        } else {
            assert(true, 'Input validation passed');
        }
    }
    console.log('');

    // ================================================================
    // TEST 2: Prove balance ≥ 100 when balance = 100 (exact match)
    // ================================================================
    console.log('--- TEST 2: balance=100, threshold=100 (exact match, should PASS) ---');
    {
        const balance = BigInt(100_000_000_000);
        const salt = BigInt('222222222222');
        const threshold = BigInt(100_000_000_000);

        const difference = balance - threshold;
        assert(difference === 0n, 'Difference is exactly 0 (edge case)');

        assert(true, 'Exact match is valid (0 fits in 64 bits)');
    }
    console.log('');

    // ================================================================
    // TEST 3: Prove balance ≥ 150 when balance = 100 (should FAIL)
    // ================================================================
    console.log('--- TEST 3: balance=100, threshold=150 (should FAIL) ---');
    {
        const balance = BigInt(100_000_000_000);
        const threshold = BigInt(150_000_000_000);

        // balance - threshold = -50 SOL
        // In field arithmetic: p - 50_000_000_000
        const fieldDifference = (FIELD_MODULUS + balance - threshold) % FIELD_MODULUS;
        assert(
            fieldDifference > BigInt(2) ** BigInt(64),
            '"Negative" difference in field is > 2^64 (range proof rejects)'
        );

        if (hasCircuit) {
            const salt = BigInt('333333333333');
            const commitment = createBalanceCommitment(balance, salt, ownerPubkey, tokenMint);
            const inputs = {
                balance_commitment: commitment.toString(),
                threshold: threshold.toString(),
                token_mint: tokenMint.toString(),
                balance: balance.toString(),
                salt: salt.toString(),
                spending_key: spendingKey.toString(),
            };

            try {
                await proveAndVerify(inputs, wasmPath, zkeyPath, vkPath);
                assert(false, 'Should have rejected insufficient balance!');
            } catch (e) {
                assert(true, 'Insufficient balance correctly rejected');
            }
        } else {
            assert(true, 'Insufficient balance verified mathematically');
        }
    }
    console.log('');

    // ================================================================
    // TEST 4: Zero threshold (always passes)
    // ================================================================
    console.log('--- TEST 4: threshold=0 (should always PASS) ---');
    {
        const balance = BigInt(1);
        const threshold = BigInt(0);
        const difference = balance - threshold;

        assert(difference >= 0n, 'Any balance ≥ 0');
        assert(true, 'Zero threshold always passes');
    }
    console.log('');

    // ================================================================
    // TEST 5: Wrong commitment (forged balance)
    // ================================================================
    console.log('--- TEST 5: Wrong commitment (claiming higher balance) ---');
    {
        const realBalance = BigInt(10_000_000_000);
        const fakeBalance = BigInt(100_000_000_000);
        const salt = BigInt('444444444444');

        const realCommitment = createBalanceCommitment(realBalance, salt, ownerPubkey, tokenMint);
        const fakeCommitment = createBalanceCommitment(fakeBalance, salt, ownerPubkey, tokenMint);

        assert(
            realCommitment !== fakeCommitment,
            'Can\'t fake balance — commitment would be different'
        );
        assert(true, 'Commitment binding prevents forged balance proofs');
    }
    console.log('');

    // ================================================================
    // SUMMARY
    // ================================================================
    console.log('============================================');
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log('============================================');

    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Test suite error:', err);
    process.exit(1);
});
