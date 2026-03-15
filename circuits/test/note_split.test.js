const snarkjs = require('snarkjs');
const path = require('path');
const fs = require('fs');

// ============================================================
// Protocol 01 — Note Split Circuit Tests
// ============================================================
//
// Tests for cross-pool note splitting:
//   1. Valid split: 1 source note → 5 target notes
//   2. Valid split: 1 source note → 20 target notes (max)
//   3. Valid split: 1 source note → 1 target note (min)
//   4. Wrong source secret → proof fails
//   5. Wrong nullifier → proof fails
//   6. Dummy outputs must be zero
//   7. Active output mismatch → proof fails
//   8. Emergency mode (enforce_maturity=0) works
//   9. Immature note with enforce_maturity=1 → proof fails
// ============================================================

let poseidon;

async function initPoseidon() {
    const { buildPoseidon } = require('circomlibjs');
    poseidon = await buildPoseidon();
}

function poseidonHash(inputs) {
    const hash = poseidon(inputs.map(x => BigInt(x)));
    return poseidon.F.toObject(hash);
}

// ── Merkle tree helpers ──────────────────────────────────────

const MERKLE_DEPTH = 15;
const ZERO_VALUE = BigInt('21663839004416932945382355908790599225266501822907911457504978515578255421292');

function computeZeroHashes(depth) {
    const zeros = [ZERO_VALUE];
    for (let i = 1; i <= depth; i++) {
        zeros.push(poseidonHash([zeros[i - 1], zeros[i - 1]]));
    }
    return zeros;
}

class MerkleTree {
    constructor(depth) {
        this.depth = depth;
        this.zeroHashes = computeZeroHashes(depth);
        this.leaves = [];
        this.layers = [];
    }

    insert(leaf) {
        this.leaves.push(leaf);
        this._rebuild();
    }

    _rebuild() {
        const n = this.leaves.length;
        const totalLeaves = 1 << this.depth;
        let layer = [];
        for (let i = 0; i < totalLeaves; i++) {
            layer.push(i < n ? this.leaves[i] : this.zeroHashes[0]);
        }
        this.layers = [layer];
        for (let d = 0; d < this.depth; d++) {
            const prev = this.layers[d];
            const next = [];
            for (let i = 0; i < prev.length; i += 2) {
                next.push(poseidonHash([prev[i], prev[i + 1]]));
            }
            this.layers.push(next);
        }
    }

    get root() {
        if (this.layers.length === 0) return this.zeroHashes[this.depth];
        return this.layers[this.depth][0];
    }

    getPath(leafIndex) {
        const pathElements = [];
        const pathIndices = [];
        let idx = leafIndex;
        for (let d = 0; d < this.depth; d++) {
            const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
            pathElements.push(this.layers[d][siblingIdx]);
            pathIndices.push(idx % 2);
            idx = Math.floor(idx / 2);
        }
        return { pathElements, pathIndices };
    }
}

// ── Note helpers ─────────────────────────────────────────────

function createCommitment(nullifierPreimage, secret, depositEpoch, tokenMint) {
    return poseidonHash([nullifierPreimage, secret, depositEpoch, tokenMint]);
}

function createNullifier(nullifierPreimage, secret) {
    return poseidonHash([nullifierPreimage, secret]);
}

// ── Test runner ──────────────────────────────────────────────

const MAX_OUTPUTS = 20;
const WASM_PATH = path.join(__dirname, '../build/note_split/note_split_js/note_split.wasm');
const ZKEY_PATH = path.join(__dirname, '../build/note_split/note_split_final.zkey');
const VK_PATH = path.join(__dirname, '../build/note_split/note_split_vk.json');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        console.log(`  \u2713 ${msg}`);
        passed++;
    } else {
        console.log(`  \u2717 FAILED: ${msg}`);
        failed++;
    }
}

async function generateAndVerify(inputs, expectValid = true) {
    try {
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            inputs, WASM_PATH, ZKEY_PATH
        );
        const vk = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
        const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
        return { success: true, valid, proof, publicSignals };
    } catch (err) {
        return { success: false, valid: false, error: err.message };
    }
}

function buildSplitInputs({
    secret,
    nullifierPreimage,
    depositEpoch,
    tokenMint,
    minEpoch,
    enforceMaturity,
    numActiveOutputs,
    outputSecrets,
    outputNullifierPreimages,
    outputDepositEpoch,
    tree,
    leafIndex,
}) {
    const commitment = createCommitment(nullifierPreimage, secret, depositEpoch, tokenMint);
    const nullifier = createNullifier(nullifierPreimage, secret);
    const { pathElements, pathIndices } = tree.getPath(leafIndex);

    // Build output commitments
    const outputCommitments = [];
    for (let i = 0; i < MAX_OUTPUTS; i++) {
        if (i < numActiveOutputs) {
            outputCommitments.push(
                createCommitment(outputNullifierPreimages[i], outputSecrets[i], outputDepositEpoch, tokenMint)
            );
        } else {
            outputCommitments.push(BigInt(0));
        }
    }

    // Pad arrays to MAX_OUTPUTS
    const paddedOutputSecrets = [];
    const paddedOutputNullPreimages = [];
    for (let i = 0; i < MAX_OUTPUTS; i++) {
        paddedOutputSecrets.push(i < numActiveOutputs ? outputSecrets[i] : BigInt(0));
        paddedOutputNullPreimages.push(i < numActiveOutputs ? outputNullifierPreimages[i] : BigInt(0));
    }

    return {
        // Public inputs
        source_merkle_root: tree.root.toString(),
        nullifier: nullifier.toString(),
        min_epoch: minEpoch.toString(),
        token_mint: tokenMint.toString(),
        enforce_maturity: enforceMaturity.toString(),
        num_active_outputs: numActiveOutputs.toString(),
        output_commitments: outputCommitments.map(c => c.toString()),
        // Private inputs
        secret: secret.toString(),
        nullifier_preimage: nullifierPreimage.toString(),
        deposit_epoch: depositEpoch.toString(),
        path_elements: pathElements.map(e => e.toString()),
        path_indices: pathIndices.map(i => i.toString()),
        output_secrets: paddedOutputSecrets.map(s => s.toString()),
        output_nullifier_preimages: paddedOutputNullPreimages.map(n => n.toString()),
        output_deposit_epoch: outputDepositEpoch.toString(),
    };
}

async function runTests() {
    console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
    console.log('\u2551  Protocol 01 \u2014 Note Split Circuit Tests             \u2551');
    console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n');

    if (!fs.existsSync(WASM_PATH) || !fs.existsSync(ZKEY_PATH) || !fs.existsSync(VK_PATH)) {
        console.error('ERROR: Build artifacts not found. Compile note_split first.');
        process.exit(1);
    }

    await initPoseidon();
    console.log('Poseidon initialized.\n');

    // ── Setup ────────────────────────────────────────────────
    const secret = BigInt('98765432109876543210');
    const nullifierPreimage = BigInt('11111111111111111111');
    const depositEpoch = BigInt(1000);
    const tokenMint = BigInt(0); // SOL
    const outputDepositEpoch = BigInt(1100);

    const commitment = createCommitment(nullifierPreimage, secret, depositEpoch, tokenMint);
    const nullifier = createNullifier(nullifierPreimage, secret);

    console.log('Source note:');
    console.log(`  commitment: ${commitment}`);
    console.log(`  nullifier:  ${nullifier}`);
    console.log(`  epoch:      ${depositEpoch}\n`);

    // Build source tree with some other notes
    const tree = new MerkleTree(MERKLE_DEPTH);
    for (let i = 0; i < 5; i++) {
        tree.insert(poseidonHash([BigInt(i + 100), BigInt(i + 200), BigInt(500), BigInt(0)]));
    }
    tree.insert(commitment); // index 5
    const leafIndex = 5;

    // Generate output secrets
    function makeOutputs(count) {
        const secrets = [];
        const nullPreimages = [];
        for (let i = 0; i < count; i++) {
            secrets.push(BigInt(5000 + i * 111));
            nullPreimages.push(BigInt(6000 + i * 222));
        }
        return { secrets, nullPreimages };
    }

    // ── TEST 1: Valid split → 5 outputs ──────────────────────
    console.log('Test 1: Valid split — 1 note → 5 outputs');
    {
        const { secrets: outSec, nullPreimages: outNull } = makeOutputs(5);
        const inputs = buildSplitInputs({
            secret, nullifierPreimage, depositEpoch, tokenMint,
            minEpoch: BigInt(1200), enforceMaturity: BigInt(1),
            numActiveOutputs: 5,
            outputSecrets: outSec, outputNullifierPreimages: outNull,
            outputDepositEpoch, tree, leafIndex,
        });
        const result = await generateAndVerify(inputs);
        assert(result.success && result.valid, 'Valid 5-output split generates valid proof');
    }

    // ── TEST 2: Valid split → 20 outputs (max) ──────────────
    console.log('\nTest 2: Valid split — 1 note → 20 outputs (maximum)');
    {
        const { secrets: outSec, nullPreimages: outNull } = makeOutputs(20);
        const inputs = buildSplitInputs({
            secret, nullifierPreimage, depositEpoch, tokenMint,
            minEpoch: BigInt(1200), enforceMaturity: BigInt(1),
            numActiveOutputs: 20,
            outputSecrets: outSec, outputNullifierPreimages: outNull,
            outputDepositEpoch, tree, leafIndex,
        });
        const result = await generateAndVerify(inputs);
        assert(result.success && result.valid, 'Valid 20-output split generates valid proof');
    }

    // ── TEST 3: Valid split → 1 output (minimum) ────────────
    console.log('\nTest 3: Valid split — 1 note → 1 output (minimum)');
    {
        const { secrets: outSec, nullPreimages: outNull } = makeOutputs(1);
        const inputs = buildSplitInputs({
            secret, nullifierPreimage, depositEpoch, tokenMint,
            minEpoch: BigInt(1200), enforceMaturity: BigInt(1),
            numActiveOutputs: 1,
            outputSecrets: outSec, outputNullifierPreimages: outNull,
            outputDepositEpoch, tree, leafIndex,
        });
        const result = await generateAndVerify(inputs);
        assert(result.success && result.valid, 'Valid 1-output split generates valid proof');
    }

    // ── TEST 4: Wrong secret → fails ────────────────────────
    console.log('\nTest 4: Wrong source secret — must fail');
    {
        const { secrets: outSec, nullPreimages: outNull } = makeOutputs(5);
        const inputs = buildSplitInputs({
            secret: BigInt(999999), // WRONG
            nullifierPreimage, depositEpoch, tokenMint,
            minEpoch: BigInt(1200), enforceMaturity: BigInt(1),
            numActiveOutputs: 5,
            outputSecrets: outSec, outputNullifierPreimages: outNull,
            outputDepositEpoch, tree, leafIndex,
        });
        // Override nullifier to match the public input (force a Merkle mismatch instead)
        inputs.nullifier = createNullifier(nullifierPreimage, BigInt(999999)).toString();
        const result = await generateAndVerify(inputs);
        assert(!result.valid, 'Wrong secret: proof rejected');
    }

    // ── TEST 5: Wrong nullifier_preimage → fails ────────────
    console.log('\nTest 5: Wrong nullifier preimage — must fail');
    {
        const { secrets: outSec, nullPreimages: outNull } = makeOutputs(5);
        const inputs = buildSplitInputs({
            secret, nullifierPreimage: BigInt(888888), // WRONG
            depositEpoch, tokenMint,
            minEpoch: BigInt(1200), enforceMaturity: BigInt(1),
            numActiveOutputs: 5,
            outputSecrets: outSec, outputNullifierPreimages: outNull,
            outputDepositEpoch, tree, leafIndex,
        });
        const result = await generateAndVerify(inputs);
        assert(!result.success || !result.valid, 'Wrong nullifier preimage: proof rejected');
    }

    // ── TEST 6: Non-zero dummy output → fails ───────────────
    console.log('\nTest 6: Non-zero dummy output — must fail');
    {
        const { secrets: outSec, nullPreimages: outNull } = makeOutputs(3);
        const inputs = buildSplitInputs({
            secret, nullifierPreimage, depositEpoch, tokenMint,
            minEpoch: BigInt(1200), enforceMaturity: BigInt(1),
            numActiveOutputs: 3,
            outputSecrets: outSec, outputNullifierPreimages: outNull,
            outputDepositEpoch, tree, leafIndex,
        });
        // Tamper: set a dummy slot to non-zero
        inputs.output_commitments[5] = '12345';
        const result = await generateAndVerify(inputs);
        assert(!result.success || !result.valid, 'Non-zero dummy output: proof rejected');
    }

    // ── TEST 7: Wrong output commitment → fails ─────────────
    console.log('\nTest 7: Tampered output commitment — must fail');
    {
        const { secrets: outSec, nullPreimages: outNull } = makeOutputs(5);
        const inputs = buildSplitInputs({
            secret, nullifierPreimage, depositEpoch, tokenMint,
            minEpoch: BigInt(1200), enforceMaturity: BigInt(1),
            numActiveOutputs: 5,
            outputSecrets: outSec, outputNullifierPreimages: outNull,
            outputDepositEpoch, tree, leafIndex,
        });
        // Tamper: change an active output commitment
        inputs.output_commitments[2] = '99999';
        const result = await generateAndVerify(inputs);
        assert(!result.success || !result.valid, 'Tampered output commitment: proof rejected');
    }

    // ── TEST 8: Emergency mode (enforce_maturity=0) ─────────
    console.log('\nTest 8: Emergency mode (enforce_maturity=0) — should pass');
    {
        const { secrets: outSec, nullPreimages: outNull } = makeOutputs(5);
        const inputs = buildSplitInputs({
            secret, nullifierPreimage, depositEpoch, tokenMint,
            minEpoch: BigInt(500), // min_epoch BEFORE deposit_epoch
            enforceMaturity: BigInt(0), // emergency mode
            numActiveOutputs: 5,
            outputSecrets: outSec, outputNullifierPreimages: outNull,
            outputDepositEpoch, tree, leafIndex,
        });
        const result = await generateAndVerify(inputs);
        assert(result.success && result.valid, 'Emergency mode bypasses maturity check');
    }

    // ── TEST 9: Immature note with enforce_maturity=1 → fails
    console.log('\nTest 9: Immature note with maturity enforced — must fail');
    {
        const { secrets: outSec, nullPreimages: outNull } = makeOutputs(5);
        const inputs = buildSplitInputs({
            secret, nullifierPreimage, depositEpoch, tokenMint,
            minEpoch: BigInt(500), // min_epoch BEFORE deposit_epoch → immature
            enforceMaturity: BigInt(1), // enforce
            numActiveOutputs: 5,
            outputSecrets: outSec, outputNullifierPreimages: outNull,
            outputDepositEpoch, tree, leafIndex,
        });
        const result = await generateAndVerify(inputs);
        assert(!result.success || !result.valid, 'Immature note: proof rejected');
    }

    // ── Summary ──────────────────────────────────────────────
    console.log('\n' + '='.repeat(55));
    console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
    console.log('='.repeat(55));

    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
