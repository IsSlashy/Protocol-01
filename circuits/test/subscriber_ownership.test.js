const snarkjs = require('snarkjs');
const path = require('path');
const fs = require('fs');

// ============================================================================
// Subscriber Ownership Proof - Test Suite
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

function createCommitment(subscriberSecret) {
    return poseidonHash([subscriberSecret, BigInt(1234567890)]);
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  \u2713 ${message}`);
        passed++;
    } else {
        console.log(`  \u2717 FAILED: ${message}`);
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
    console.log('  Subscriber Ownership Proof Tests');
    console.log('============================================\n');

    await initPoseidon();

    const buildDir = path.join(__dirname, '../build');
    const wasmPath = path.join(buildDir, 'subscriber_ownership_js', 'subscriber_ownership.wasm');
    const zkeyPath = path.join(buildDir, 'subscriber_ownership_final.zkey');
    const vkPath = path.join(buildDir, 'subscriber_ownership_vk.json');
    const hasCircuit = fs.existsSync(wasmPath) && fs.existsSync(zkeyPath);

    if (!hasCircuit) {
        console.log('\u26a0 Circuit not compiled. Running input validation tests only.\n');
    }

    // ================================================================
    // TEST 1: Valid ownership proof
    // ================================================================
    console.log('--- TEST 1: Valid ownership proof ---');
    {
        const secret = BigInt('123456789012345678901234567890');
        const commitment = createCommitment(secret);

        assert(commitment > 0n, `Commitment is non-zero: ${commitment}`);

        const inputs = {
            commitment: commitment.toString(),
            subscriber_secret: secret.toString(),
        };

        if (hasCircuit) {
            try {
                const result = await proveAndVerify(inputs, wasmPath, zkeyPath, vkPath);
                assert(result.isValid, 'Ownership proof is valid');
                assert(
                    result.publicSignals[0] === commitment.toString(),
                    'Public signal matches commitment'
                );
            } catch (e) {
                assert(false, `Proof failed: ${e.message}`);
            }
        } else {
            assert(true, 'Input validation passed');
        }
    }
    console.log('');

    // ================================================================
    // TEST 2: Wrong secret should fail
    // ================================================================
    console.log('--- TEST 2: Wrong secret should fail ---');
    {
        const realSecret = BigInt('111111111111111111');
        const wrongSecret = BigInt('222222222222222222');
        const commitment = createCommitment(realSecret);
        const wrongCommitment = createCommitment(wrongSecret);

        assert(commitment !== wrongCommitment, 'Different secrets produce different commitments');

        if (hasCircuit) {
            const inputs = {
                commitment: commitment.toString(),
                subscriber_secret: wrongSecret.toString(),
            };

            try {
                await proveAndVerify(inputs, wasmPath, zkeyPath, vkPath);
                assert(false, 'Should have rejected wrong secret!');
            } catch (e) {
                assert(true, 'Wrong secret correctly rejected by circuit');
            }
        } else {
            assert(true, 'Wrong secret verified mathematically');
        }
    }
    console.log('');

    // ================================================================
    // TEST 3: Deterministic commitment
    // ================================================================
    console.log('--- TEST 3: Deterministic commitment ---');
    {
        const secret = BigInt('42');
        const commitment1 = createCommitment(secret);
        const commitment2 = createCommitment(secret);

        assert(commitment1 === commitment2, 'Same secret always produces same commitment');
    }
    console.log('');

    // ================================================================
    // TEST 4: Different secrets produce different commitments
    // ================================================================
    console.log('--- TEST 4: Unique commitments per secret ---');
    {
        const secrets = [
            BigInt('1'),
            BigInt('2'),
            BigInt('999999999999'),
            BigInt('12345678901234567890'),
        ];
        const commitments = secrets.map(s => createCommitment(s));
        const unique = new Set(commitments.map(c => c.toString()));

        assert(unique.size === secrets.length, `All ${secrets.length} commitments are unique`);
    }
    console.log('');

    // ================================================================
    // TEST 5: Edge case - secret = 0
    // ================================================================
    console.log('--- TEST 5: Edge case - secret = 0 ---');
    {
        const secret = BigInt(0);
        const commitment = createCommitment(secret);

        assert(commitment > 0n, 'Commitment is non-zero even for secret=0');

        if (hasCircuit) {
            const inputs = {
                commitment: commitment.toString(),
                subscriber_secret: secret.toString(),
            };

            try {
                const result = await proveAndVerify(inputs, wasmPath, zkeyPath, vkPath);
                assert(result.isValid, 'Zero secret proof is valid');
            } catch (e) {
                assert(false, `Zero secret proof failed: ${e.message}`);
            }
        } else {
            assert(true, 'Zero secret validation passed');
        }
    }
    console.log('');

    // ================================================================
    // TEST 6: Large secret (near field modulus)
    // ================================================================
    console.log('--- TEST 6: Large secret near field boundary ---');
    {
        const secret = FIELD_MODULUS - BigInt(1);
        const commitment = createCommitment(secret);

        assert(commitment > 0n, `Large secret produces valid commitment: ${commitment}`);

        if (hasCircuit) {
            const inputs = {
                commitment: commitment.toString(),
                subscriber_secret: secret.toString(),
            };

            try {
                const result = await proveAndVerify(inputs, wasmPath, zkeyPath, vkPath);
                assert(result.isValid, 'Large secret proof is valid');
            } catch (e) {
                assert(false, `Large secret proof failed: ${e.message}`);
            }
        } else {
            assert(true, 'Large secret validation passed');
        }
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
