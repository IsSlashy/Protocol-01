/**
 * Denominated Pool — Client-Side Proving E2E Test
 *
 * Tests the full flow:
 *   1. Create commitment with Poseidon
 *   2. Build Merkle tree from scratch
 *   3. Build circuit inputs
 *   4. Generate Groth16 proof client-side (snarkjs)
 *   5. Verify proof against VK
 *
 * This runs in Node.js (vitest) using snarkjs directly, not the Web Worker.
 * The Web Worker uses the same snarkjs.groth16.fullProve() under the hood.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as snarkjs from 'snarkjs';
import { poseidon2, poseidon4 } from 'poseidon-lite';
import * as fs from 'fs';
import * as path from 'path';
import {
  createCommitment,
  createNullifier,
  computeNewRootFromSubtrees,
  buildDenominatedPoolInputs,
  receiptToJSON,
  receiptFromJSON,
  slotToEpoch,
  type ShieldReceipt,
  type DenominatedPoolProofInputs,
} from './denominatedPool';

// ---------------------------------------------------------------------------
// Circuit file paths (relative to project root)
// ---------------------------------------------------------------------------

// Try multiple path resolutions (vitest may resolve __dirname differently)
function findCircuitDir(): string {
  const candidates = [
    path.resolve(__dirname, '../../../../circuits/build'),
    path.resolve(process.cwd(), '../../circuits/build'),
    path.resolve(process.cwd(), 'circuits/build'),
    'P:\\p01\\circuits\\build',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'denominated_pool_final.zkey'))) return dir;
  }
  return candidates[0]; // fallback, will trigger skip
}

const CIRCUITS_DIR = findCircuitDir();
const WASM_PATH = path.join(CIRCUITS_DIR, 'denominated_pool_js', 'denominated_pool.wasm');
const ZKEY_PATH = path.join(CIRCUITS_DIR, 'denominated_pool_final.zkey');
const VK_PATH = path.join(CIRCUITS_DIR, 'denominated_pool_vk.json');

const FIELD_ORDER = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

const MERKLE_DEPTH = 15;

const ZERO_VALUE = BigInt(
  '21663839004416932945382355908790599225266501822907911457504978515578255421292'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomField(): bigint {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  let n = BigInt(0);
  for (let i = 0; i < 32; i++) n = (n << BigInt(8)) | BigInt(bytes[i]);
  return n % FIELD_ORDER;
}

function computeZeroHashes(): bigint[] {
  const zeros = [ZERO_VALUE];
  for (let i = 1; i <= MERKLE_DEPTH; i++) {
    zeros.push(poseidon2([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}

function emptySubtrees(): bigint[] {
  const zeros = computeZeroHashes();
  return zeros.slice(0, MERKLE_DEPTH);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Denominated Pool — Crypto Helpers', () => {
  it('creates a valid commitment', () => {
    const np = randomField();
    const secret = randomField();
    const epoch = BigInt(100);
    const mint = BigInt(0);

    const commitment = createCommitment(np, secret, epoch, mint);
    expect(commitment).toBeTypeOf('bigint');
    expect(commitment).toBeGreaterThan(BigInt(0));
    expect(commitment).toBeLessThan(FIELD_ORDER);

    // Deterministic
    const commitment2 = createCommitment(np, secret, epoch, mint);
    expect(commitment2).toBe(commitment);
  });

  it('creates a valid nullifier', () => {
    const np = randomField();
    const secret = randomField();

    const nullifier = createNullifier(np, secret);
    expect(nullifier).toBeTypeOf('bigint');
    expect(nullifier).toBeGreaterThan(BigInt(0));

    // Nullifier is independent of deposit_epoch and token_mint
    const nullifier2 = createNullifier(np, secret);
    expect(nullifier2).toBe(nullifier);
  });

  it('commitment and nullifier are different', () => {
    const np = randomField();
    const secret = randomField();
    const epoch = BigInt(100);
    const mint = BigInt(0);

    const commitment = createCommitment(np, secret, epoch, mint);
    const nullifier = createNullifier(np, secret);
    expect(commitment).not.toBe(nullifier);
  });

  it('computes Merkle root from empty subtrees', () => {
    const subtrees = emptySubtrees();
    const leaf = randomField();

    const { newRoot, pathElements, pathIndices } = computeNewRootFromSubtrees(
      leaf,
      0,
      subtrees
    );

    expect(newRoot).toBeTypeOf('bigint');
    expect(pathElements).toHaveLength(MERKLE_DEPTH);
    expect(pathIndices).toHaveLength(MERKLE_DEPTH);

    // First insertion: all path indices should be 0 (left child)
    expect(pathIndices.every((i) => i === 0)).toBe(true);
  });

  it('computes different roots for different leaves', () => {
    const subtrees = emptySubtrees();
    const leaf1 = randomField();
    const leaf2 = randomField();

    const { newRoot: root1 } = computeNewRootFromSubtrees(leaf1, 0, subtrees);
    const { newRoot: root2 } = computeNewRootFromSubtrees(leaf2, 0, subtrees);

    expect(root1).not.toBe(root2);
  });

  it('second insertion has correct path indices', () => {
    const subtrees = emptySubtrees();
    const leaf1 = randomField();

    const { updatedSubtrees } = computeNewRootFromSubtrees(leaf1, 0, subtrees);

    const leaf2 = randomField();
    const { pathIndices } = computeNewRootFromSubtrees(leaf2, 1, updatedSubtrees);

    // Leaf index 1 = binary 0...01, so first pathIndex should be 1 (right child)
    expect(pathIndices[0]).toBe(1);
  });

  it('slotToEpoch computes correctly', () => {
    expect(slotToEpoch(0)).toBe(BigInt(0));
    expect(slotToEpoch(7200)).toBe(BigInt(1));
    expect(slotToEpoch(7199)).toBe(BigInt(0));
    expect(slotToEpoch(14400)).toBe(BigInt(2));
  });
});

describe('Denominated Pool — Receipt Serialization', () => {
  it('round-trips receipt through JSON', () => {
    const receipt: ShieldReceipt = {
      secret: randomField(),
      nullifierPreimage: randomField(),
      depositEpoch: BigInt(42),
      tokenMint: BigInt(0),
      commitment: randomField(),
      leafIndex: 7,
      denomination: BigInt(1_000_000_000),
      pool: 'DummyPoolAddress11111111111111111111111111111',
      merklePathElements: Array.from({ length: 15 }, () => randomField()),
      merklePathIndices: Array.from({ length: 15 }, (_, i) => i % 2),
      merkleRoot: randomField(),
    };

    const json = receiptToJSON(receipt);
    const restored = receiptFromJSON(json);

    expect(restored.secret).toBe(receipt.secret);
    expect(restored.nullifierPreimage).toBe(receipt.nullifierPreimage);
    expect(restored.depositEpoch).toBe(receipt.depositEpoch);
    expect(restored.tokenMint).toBe(receipt.tokenMint);
    expect(restored.commitment).toBe(receipt.commitment);
    expect(restored.leafIndex).toBe(receipt.leafIndex);
    expect(restored.denomination).toBe(receipt.denomination);
    expect(restored.pool).toBe(receipt.pool);
    expect(restored.merkleRoot).toBe(receipt.merkleRoot);
    expect(restored.merklePathElements).toHaveLength(15);
    expect(restored.merklePathElements![0]).toBe(receipt.merklePathElements![0]);
    expect(restored.merklePathIndices).toEqual(receipt.merklePathIndices);
  });
});

describe('Denominated Pool — Client-Side Proof Generation', () => {
  // Skip if circuit files not found (CI without build artifacts)
  const circuitFilesExist =
    fs.existsSync(WASM_PATH) && fs.existsSync(ZKEY_PATH) && fs.existsSync(VK_PATH);

  // Force single-threaded mode — snarkjs/ffjavascript tries to spawn Worker
  // threads via the web-worker polyfill, which fails in vitest's Node env.
  // Pre-cache the BN128 curve in single-threaded mode so that snarkjs reuses it
  // instead of attempting to build a multi-threaded version.
  beforeAll(async () => {
    const curve = await snarkjs.curves.getCurveFromName('bn128', { singleThread: true });
    (globalThis as any).curve_bn128 = curve;
  }, 30000);

  afterAll(async () => {
    if ((globalThis as any).curve_bn128) {
      await (globalThis as any).curve_bn128.terminate();
      (globalThis as any).curve_bn128 = null;
    }
  });

  it.skipIf(!circuitFilesExist)(
    'generates and verifies a valid Groth16 proof (full E2E)',
    async () => {
      // 1. Create note parameters
      const secret = randomField();
      const nullifierPreimage = randomField();
      const depositEpoch = BigInt(100);
      const tokenMint = BigInt(0); // SOL

      // 2. Compute commitment
      const commitment = createCommitment(
        nullifierPreimage,
        secret,
        depositEpoch,
        tokenMint
      );

      // 3. Build Merkle tree — insert a few dummy notes + our note
      let subtrees = emptySubtrees();
      let leafIndex = 0;

      // Insert 5 dummy notes
      for (let i = 0; i < 5; i++) {
        const dummyCommitment = createCommitment(
          randomField(),
          randomField(),
          BigInt(90 + i),
          tokenMint
        );
        const result = computeNewRootFromSubtrees(dummyCommitment, leafIndex, subtrees);
        subtrees = result.updatedSubtrees;
        leafIndex++;
      }

      // Insert our note
      const {
        newRoot: merkleRoot,
        updatedSubtrees,
        pathElements,
        pathIndices,
      } = computeNewRootFromSubtrees(commitment, leafIndex, subtrees);

      // 4. Build circuit inputs
      const currentEpoch = BigInt(110); // well past deposit
      const epochDelay = BigInt(1);
      const nullifier = createNullifier(nullifierPreimage, secret);
      const minEpoch = currentEpoch - epochDelay;

      const receipt: ShieldReceipt = {
        secret,
        nullifierPreimage,
        depositEpoch,
        tokenMint,
        commitment,
        leafIndex,
        denomination: BigInt(1_000_000_000),
        pool: 'test',
        merklePathElements: pathElements,
        merklePathIndices: pathIndices,
        merkleRoot,
      };

      const inputs = buildDenominatedPoolInputs(
        receipt,
        merkleRoot,
        pathElements,
        pathIndices,
        currentEpoch,
        epochDelay
      );

      // Verify inputs are well-formed
      expect(inputs.merkle_root).toBe(merkleRoot.toString());
      expect(inputs.nullifier).toBe(nullifier.toString());
      expect(inputs.min_epoch).toBe(minEpoch.toString());
      expect(inputs.token_mint).toBe(tokenMint.toString());
      expect(inputs.path_elements).toHaveLength(MERKLE_DEPTH);
      expect(inputs.path_indices).toHaveLength(MERKLE_DEPTH);

      // 5. Generate proof with snarkjs (same as Web Worker does)
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        inputs,
        WASM_PATH,
        ZKEY_PATH
      );

      expect(proof).toBeDefined();
      expect(proof.pi_a).toBeDefined();
      expect(proof.pi_b).toBeDefined();
      expect(proof.pi_c).toBeDefined();
      expect(publicSignals).toHaveLength(5); // merkle_root, nullifier, min_epoch, token_mint, enforce_maturity

      // 6. Verify proof
      const vk = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
      const isValid = await snarkjs.groth16.verify(vk, publicSignals, proof);
      expect(isValid).toBe(true);

      // 7. Verify public signals match our inputs
      expect(publicSignals[0]).toBe(inputs.merkle_root);
      expect(publicSignals[1]).toBe(inputs.nullifier);
      expect(publicSignals[2]).toBe(inputs.min_epoch);
      expect(publicSignals[3]).toBe(inputs.token_mint);
    },
    60000 // 60s timeout for proof generation
  );

  it.skipIf(!circuitFilesExist)(
    'rejects proof with wrong secret',
    async () => {
      const secret = randomField();
      const nullifierPreimage = randomField();
      const depositEpoch = BigInt(100);
      const tokenMint = BigInt(0);

      const commitment = createCommitment(
        nullifierPreimage,
        secret,
        depositEpoch,
        tokenMint
      );

      let subtrees = emptySubtrees();
      const { newRoot, pathElements, pathIndices } = computeNewRootFromSubtrees(
        commitment,
        0,
        subtrees
      );

      const nullifier = createNullifier(nullifierPreimage, secret);

      // Use a WRONG secret — the computed commitment won't match the tree
      const wrongSecret = randomField();

      const inputs: DenominatedPoolProofInputs = {
        merkle_root: newRoot.toString(),
        nullifier: nullifier.toString(),
        min_epoch: BigInt(105).toString(),
        token_mint: tokenMint.toString(),
        secret: wrongSecret.toString(), // WRONG
        nullifier_preimage: nullifierPreimage.toString(),
        deposit_epoch: depositEpoch.toString(),
        path_elements: pathElements.map((e) => e.toString()),
        path_indices: pathIndices.map((i) => i.toString()),
      };

      // snarkjs should fail — the witness is inconsistent
      await expect(
        snarkjs.groth16.fullProve(inputs, WASM_PATH, ZKEY_PATH)
      ).rejects.toThrow();
    },
    30000
  );

  it.skipIf(!circuitFilesExist)(
    'rejects proof when note is not mature (deposit_epoch > min_epoch)',
    async () => {
      const secret = randomField();
      const nullifierPreimage = randomField();
      const depositEpoch = BigInt(200); // deposited at epoch 200
      const tokenMint = BigInt(0);

      const commitment = createCommitment(
        nullifierPreimage,
        secret,
        depositEpoch,
        tokenMint
      );

      let subtrees = emptySubtrees();
      const { newRoot, pathElements, pathIndices } = computeNewRootFromSubtrees(
        commitment,
        0,
        subtrees
      );

      const nullifier = createNullifier(nullifierPreimage, secret);

      // min_epoch = 100, but deposit was at 200 → 200 > 100 → not mature
      const inputs: DenominatedPoolProofInputs = {
        merkle_root: newRoot.toString(),
        nullifier: nullifier.toString(),
        min_epoch: BigInt(100).toString(), // deposit_epoch (200) > min_epoch (100)
        token_mint: tokenMint.toString(),
        secret: secret.toString(),
        nullifier_preimage: nullifierPreimage.toString(),
        deposit_epoch: depositEpoch.toString(),
        path_elements: pathElements.map((e) => e.toString()),
        path_indices: pathIndices.map((i) => i.toString()),
      };

      // Should fail — epoch_diff would be negative (underflow in field)
      await expect(
        snarkjs.groth16.fullProve(inputs, WASM_PATH, ZKEY_PATH)
      ).rejects.toThrow();
    },
    30000
  );
});
