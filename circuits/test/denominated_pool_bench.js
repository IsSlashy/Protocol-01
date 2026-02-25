const snarkjs = require('snarkjs');
const path = require('path');
const fs = require('fs');

let poseidon;

async function initPoseidon() {
    const { buildPoseidon } = require('circomlibjs');
    poseidon = await buildPoseidon();
}

function poseidonHash(inputs) {
    const hash = poseidon(inputs.map(x => BigInt(x)));
    return poseidon.F.toObject(hash);
}

const MERKLE_DEPTH = 15;
const ZERO_VALUE = BigInt('21663839004416932945382355908790599225266501822907911457504978515578255421292');

function computeZeroHashes(depth) {
    const zeros = [ZERO_VALUE];
    for (let i = 1; i <= depth; i++) {
        zeros.push(poseidonHash([zeros[i - 1], zeros[i - 1]]));
    }
    return zeros;
}

// Sparse Merkle tree — only stores filled leaves, uses zero hashes for empty positions
class SparseMerkleTree {
    constructor(depth) {
        this.depth = depth;
        this.zeroHashes = computeZeroHashes(depth);
        this.leaves = new Map(); // index → value
        this.nextIndex = 0;
    }

    insert(leaf) {
        const idx = this.nextIndex++;
        this.leaves.set(idx, leaf);
        return idx;
    }

    _getLeaf(idx) {
        return this.leaves.get(idx) ?? this.zeroHashes[0];
    }

    _hashLevel(level, idx) {
        if (level === 0) return this._getLeaf(idx);
        const left = this._hashLevel(level - 1, idx * 2);
        const right = this._hashLevel(level - 1, idx * 2 + 1);
        return poseidonHash([left, right]);
    }

    // Optimized: only compute the path we need, not the whole tree
    get root() {
        return this._computeRoot(0, this.depth);
    }

    _computeRoot(nodeIdx, level) {
        if (level === 0) return this._getLeaf(nodeIdx);
        // If no leaves in this subtree, return precomputed zero
        const rangeStart = nodeIdx * (1 << level);
        const rangeEnd = rangeStart + (1 << level);
        let hasLeaf = false;
        for (const [k] of this.leaves) {
            if (k >= rangeStart && k < rangeEnd) { hasLeaf = true; break; }
        }
        if (!hasLeaf) return this.zeroHashes[level];
        const left = this._computeRoot(nodeIdx * 2, level - 1);
        const right = this._computeRoot(nodeIdx * 2 + 1, level - 1);
        return poseidonHash([left, right]);
    }

    getPath(leafIndex) {
        const pathElements = [];
        const pathIndices = [];
        let idx = leafIndex;
        for (let d = 0; d < this.depth; d++) {
            const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
            pathElements.push(this._computeRoot(siblingIdx, d));
            pathIndices.push(idx % 2);
            idx = Math.floor(idx / 2);
        }
        return { pathElements, pathIndices };
    }
}

function createCommitment(np, secret, epoch, mint) {
    return poseidonHash([np, secret, epoch, mint]);
}
function createNullifier(np, secret) {
    return poseidonHash([np, secret]);
}

const WASM_PATH = path.join(__dirname, '../build/denominated_pool_js/denominated_pool.wasm');
const ZKEY_PATH = path.join(__dirname, '../build/denominated_pool_final.zkey');
const VK_PATH = path.join(__dirname, '../build/denominated_pool_vk.json');

async function bench() {
    console.log('Denominated Pool — Proof Timing Benchmark\n');
    await initPoseidon();

    const secret = BigInt('98765432109876543210');
    const nullifierPreimage = BigInt('11111111111111111111');
    const depositEpoch = BigInt(1000);
    const tokenMint = BigInt(0);

    const commitment = createCommitment(nullifierPreimage, secret, depositEpoch, tokenMint);
    const nullifier = createNullifier(nullifierPreimage, secret);

    console.log(`Building sparse Merkle tree (depth ${MERKLE_DEPTH})...`);
    const tTree0 = performance.now();
    const tree = new SparseMerkleTree(MERKLE_DEPTH);

    // Insert 10 other notes
    for (let i = 0; i < 10; i++) {
        tree.insert(createCommitment(BigInt(i * 1000 + 999), BigInt(i * 7777 + 42), BigInt(990 + i), tokenMint));
    }
    const ourIndex = tree.insert(commitment);
    const tTree1 = performance.now();
    console.log(`Tree built: ${tree.nextIndex} notes in ${(tTree1 - tTree0).toFixed(0)}ms`);

    console.log('Computing root and Merkle path...');
    const tPath0 = performance.now();
    const merkleRoot = tree.root;
    const { pathElements, pathIndices } = tree.getPath(ourIndex);
    const tPath1 = performance.now();
    console.log(`Root + path computed in ${(tPath1 - tPath0).toFixed(0)}ms\n`);

    const inputs = {
        merkle_root: merkleRoot.toString(),
        nullifier: nullifier.toString(),
        min_epoch: '1005',
        token_mint: tokenMint.toString(),
        secret: secret.toString(),
        nullifier_preimage: nullifierPreimage.toString(),
        deposit_epoch: depositEpoch.toString(),
        path_elements: pathElements.map(x => x.toString()),
        path_indices: pathIndices.map(x => x.toString()),
    };

    const vk = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
    const RUNS = 3;

    console.log(`Running ${RUNS} proof iterations...\n`);

    for (let r = 0; r < RUNS; r++) {
        // Prove (witness + proof generation)
        const tProveStart = performance.now();
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, WASM_PATH, ZKEY_PATH);
        const tProveEnd = performance.now();

        // Verify
        const tVerifyStart = performance.now();
        const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
        const tVerifyEnd = performance.now();

        const proveMs = tProveEnd - tProveStart;
        const verifyMs = tVerifyEnd - tVerifyStart;

        console.log(`  Run ${r + 1}:`);
        console.log(`    Prove (witness+proof): ${proveMs.toFixed(0)}ms`);
        console.log(`    Verify:               ${verifyMs.toFixed(0)}ms`);
        console.log(`    Total:                ${(proveMs + verifyMs).toFixed(0)}ms`);
        console.log(`    Valid:                ${valid}`);
    }

    console.log('\n── Circuit Stats ───────────────────────');
    console.log(`  Non-linear constraints: 4,273`);
    console.log(`  Tree depth:             ${MERKLE_DEPTH} (max ${(1 << MERKLE_DEPTH).toLocaleString()} notes)`);
    console.log(`  Public inputs:          4`);
    console.log(`  Private inputs:         33`);
}

bench().catch(console.error);
