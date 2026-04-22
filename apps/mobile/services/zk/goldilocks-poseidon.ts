/**
 * Goldilocks-Poseidon (pure TS port for the mobile client).
 *
 * This file is the JavaScript twin of the Rust permutation in
 * `stark/src/poseidon/mod.rs` + `stark/src/poseidon/constants.rs`. The mobile
 * client must reproduce the exact same hash byte-for-byte so the Merkle-tree
 * it feeds into the WASM STARK prover (circuit 6 = merkle_update) agrees with
 * the on-chain verifier.
 *
 * Field:    Goldilocks  p = 2^64 - 2^32 + 1
 * S-box:    x^7 (full S-box on every round — no partial rounds; matches AIR)
 * Rounds:   30 (identical constants layout as Rust, including padding rows)
 * MDS(t=3): circulant [[3,1,1],[1,3,1],[1,1,3]]
 * MDS(t=5): circulant [[5,1,1,1,1],[1,5,1,1,1], …]
 *
 * WARNING: do not reorder, truncate, or reformat the constants. Any drift
 * (even a single bit) = immediate on-chain verification failure. Parity
 * tests in `goldilocks-poseidon.test.ts` cross-check the Rust reference
 * vectors (hash2(0,0), hash2(1,2), hash4(1,2,3,4), and a merkle_update
 * root produced by `cargo run --bin gen_proof merkle-update ...`).
 */

// =============================================================================
// Field arithmetic (Goldilocks, p = 2^64 - 2^32 + 1, via bigint)
// =============================================================================

export const GOLDILOCKS_MODULUS = 0xFFFFFFFF00000001n; // 2^64 - 2^32 + 1
const P = GOLDILOCKS_MODULUS;

/** Canonical reduce: returns v mod p in [0, p). Handles any positive bigint. */
function mod(v: bigint): bigint {
  const r = v % P;
  return r < 0n ? r + P : r;
}

function gadd(a: bigint, b: bigint): bigint {
  return mod(a + b);
}

function gmul(a: bigint, b: bigint): bigint {
  // a, b already in [0, p); bigint handles arbitrary precision so a single
  // mod is sufficient for correctness.
  return mod(a * b);
}

/** x^7 S-box (x * x^2 * x^4), matching Rust `sbox` and on-chain `pow7`. */
function sbox(x: bigint): bigint {
  const x2 = gmul(x, x);
  const x4 = gmul(x2, x2);
  const x3 = gmul(x2, x);
  return gmul(x4, x3);
}

// =============================================================================
// Round constants (verbatim port from stark/src/poseidon/constants.rs)
// =============================================================================

// t = 3: 30 rounds × 3 = 90 constants (includes padding rounds at tail,
// which are unused in runtime but match the Rust array length exactly).
export const ROUND_CONSTANTS_T3: readonly bigint[] = [
  0xa98e4673f9036e0bn, 0x3db4a488e825c32an, 0x60de653e0ed43e20n,
  0x8b4f0d2b6ea19313n, 0x2f97e83e60e2c4ddn, 0xacea6e9af6c2c725n,
  0xd5604eef12e3cabcn, 0x1eb9db12a1e71b79n, 0x7ad5966d3a790d0dn,
  0xbfae604e2c72e1d9n, 0x5fa21f2143c2f72an, 0xc3ae00cf4d83d5b8n,
  0x9e8d1423cd728e2fn, 0x45d8e40e789c13abn, 0x6b9e0d183d0b0e71n,
  0x8a15b14c28d50c0an, 0xd1eef5afe2c45c82n, 0x3c914bfff61cc9d3n,
  0xf7d2a1f9ab51e8c4n, 0x2e4d3b16c89f0a55n, 0xb8f0e1d7a3c24b96n,
  0x5169e0d4f3812c47n, 0x0af31e8bc2d57698n, 0x94b6e123d8f40c49n,
  0xe2c9f5670ab18d3an, 0x7b30e894f1d26c0bn, 0x14a3d7c6e810fb5cn,
  0xad76e0b1f934ca0dn, 0x46d9e3825c01a9ben, 0xe01c67da3f24586fn,
  0x799fe120d347b680n, 0x12028bcda6f0e531n, 0xab45c7feb9132482n,
  0x4468e041dc360373n, 0xdd8bf16e0f590264n, 0x76aee291325c0155n,
  0x0fd1d3b465bf0046n, 0xa804e4c798020f37n, 0x4127f5ea0b256e28n,
  0xda4ae60d3e480d19n, 0x736dd73071bb4c0an, 0x0c90c8439ede8afbn,
  0xa5c3d966d2019becn, 0x3ef6ea89050490ddn, 0xd829fb0c382b5fcen,
  0x715d0c2f6b4e7ebfn, 0x0a801d528a719db0n, 0xa3b32e75bdb4bca1n,
  0x3ce63f98f0d7db92n, 0xd6194abd2400fa83n, 0x6f4c5be057241974n,
  0x087f6ce38a473865n, 0xa1a27e06bd6a5756n, 0x3ad58f29f08d7647n,
  0xd408a04d239067b8n, 0x6d3bb170568340a9n, 0x066ed293899c5f9an,
  0x9fa1e3b6bcbf7e8bn, 0x38d4f4d9efe29d7cn, 0xd20805fd13057c6dn,
  0x6b3b17202a282b5en, 0x046e2843540b4a4fn, 0x9da13966872e6940n,
  0x36d44a89ba516831n, 0xcf075bacfd745722n, 0x683a6cd020574613n,
  0x016d7df353ba3504n, 0x9aa08f1686dd13f5n, 0x33d3a039b90032e6n,
  0xcd06b15cec6351d7n, 0x6639c28019a670c8n, 0xff6cd3a34cc94fb9n,
  0x989fe4c67fec6eaan, 0x31d2f5e9b30f4d9bn, 0xcb060d0ce6326c8cn,
  0x6439180fe231ab7dn, 0xfd6c29261546ca6en, 0x969f3a84487be95fn,
  0x2fd24ac7b8c50850n, 0xc90555eaeb981741n, 0x62386b17de5c3632n,
  0xfb5b7448e86c4523n, 0x94ae8524217f3414n, 0x2dd19647549a2305n,
  0xc6f4a76a879d01f6n, 0x5f17b18dbac0e0e7n, 0xf83acbb0ede3bfd8n,
  0x915ddc43210c9ec9n, 0x2a80ed66544fbdban, 0xc3a3fe8987b2bcabn,
];

// t = 5: 30 rounds × 5 = 150 constants.
export const ROUND_CONSTANTS_T5: readonly bigint[] = [
  0xb7e151628aed2a6an, 0xbf7158809cf4f3c7n, 0x62e7160f38b4da56n,
  0xa784d9045190cfefn, 0x324e7738926cfbe5n,
  0xf4bf8d8d8c31d763n, 0xda06c80abb1185ebn, 0x4f7c7b5757f59584n,
  0x90cfb3cd64e4e3a3n, 0x2dbfeb4d9c0fcde5n,
  0xc9a4f775d2a2e2f0n, 0x5b8e3f48db1fda22n, 0x1c62e34b64a057a5n,
  0xab59e0bcc5c40e5cn, 0x6de2fa50f6b2ca19n,
  0x8c3a7b40e72a9bf7n, 0x3e0c6df83c1b85dcn, 0xf1d5e88bf6e8e56cn,
  0x72be5d74f27b896an, 0x0a0761de51c31eben,
  0xd0e15823a72bed58n, 0x6234c0f42a3e7af1n, 0x0b879cf7e16a8c90n,
  0xa1bd72c0f43e5132n, 0x338d1c12a5f04ad1n,
  0xc57db38fe26b5a70n, 0x67a97831c14d410fn, 0x09c53c8af26291aen,
  0xabe7fa032b24584dn, 0x3e0ab45c0cd5feecn,
  0xd02d6e84ef08a58bn, 0x624f187718db4c2an, 0x0471c2a94fae12c9n,
  0xa6946cf28120d968n, 0x38b71e5bb243a007n,
  0xcad9c88ce366e6a6n, 0x5cfc7215f489cd45n, 0xef1f1b9e25ac93e4n,
  0x81424067570f5a83n, 0x1364ea90885f2122n,
  0xa5879439b9821fc1n, 0x37aa3de2eaa50660n, 0xc9ccf78c1bc7ccffn,
  0x5bef6105455e939en, 0xee11fabe7795ba3dn,
  0x8034a367a8d860dcn, 0x12574d00da1b277bn, 0xa479f6d90c3dee1an,
  0x369cb0721f6094b9n, 0xc8bed50b50835b58n,
  0x5ae17ea481a621f7n, 0xed048eddced8e896n, 0x7f27390e000f6f35n,
  0x1149e2970632f5d4n, 0xa36c8c2037561c73n,
  0x358f3549689d4312n, 0xc7b1dec29abfe9b1n, 0x59d488dccce2b050n,
  0xebf7321c0005b6efn, 0x7e19db5533289d8en,
  0x103c84ae6644642dn, 0xa25f2e0799674accn, 0x3481d7c0cc8a116bn,
  0xc6a4817affad180an, 0x58c72af43300bea9n,
  0xeae9d42d6623c548n, 0x7d0c7e66994694e7n, 0x0f2f289fcc696b86n,
  0xa151d2d8ff8c3225n, 0x33747c11329eacc4n,
  0xc597260e65b17363n, 0x57b9cfa798c43a02n, 0xe9dc78e0cbf700a1n,
  0x7bff228ffeea0740n, 0x0e21cc09325d0ddfn,
  0xa04475825b90147en, 0x32671efb8ec31b1dn, 0xc489c894c1f621bcn,
  0x56ac722df509285bn, 0xe8cf1b672e1c2efan,
  0x7af1c4a06152f599n, 0x0d146ed994859c38n, 0x9f371902c7b862d7n,
  0x3159c33bfaeb2976n, 0xc37c6d752e1ef015n,
  0x559f170061521ab4n, 0xe7c1c09994852153n, 0x79e46a32c7b827f2n,
  0x0c0714cbd3eb2e91n, 0x9e29be04070e3530n,
  0x304c683c3a5113cfn, 0xc26f1275639f3a6en, 0x5491bc0e9cd2410dn,
  0xe6b465a7d00547acn, 0x78d70f410338ce4bn,
  0x0af9b8da367be4ean, 0x9d1c6213699ed389n, 0x2f3f0c4c9cd1da28n,
  0xc161b5e5d004e0c7n, 0x53845f1f0337e766n,
  0xe5a70858366af605n, 0x77c9b1916a0e0ca4n, 0x09ec5acabd513343n,
  0x9c0f0403f09459e2n, 0x2e31ad3d23c77081n,
  0xc054564643ea5620n, 0x5276ff7d760b2cbfn, 0xe499a8b6a93e135en,
  0x76bc5230dc70f9fdn, 0x08defbc90fa3c09cn,
  0x9b01a5824fc6873bn, 0x2d244ebb82e94ddan, 0xbf46f894b60c3479n,
  0x5169a20de92f1b18n, 0xe38c4b671c520ab7n,
  0x75af05a03e752856n, 0x07d19e3f715a0ef5n, 0x99f438789f3cd594n,
  0x2c16e2b1c2ffbc33n, 0xbe398c0af62282d2n,
  0x505c5e441b3e6971n, 0xe27f38f44e4e2910n, 0x7462e21f77a149afn,
  0x0685cb58aa3e064en, 0x98a874f1dd610bedn,
  0x2acb1e862016d08cn, 0xbcedc8214339f72bn, 0x4f0f718476bcbdcan,
  0xe1321b4da9bfa469n, 0x7354c4e6dc628b08n,
  0x05776e7f094971a7n, 0x979a38186f4c3846n, 0x299ce1a1a25afee5n,
  0xbbbeab5ac67d8584n, 0x4de1551ffa3e0c23n,
  0xe003fe932d804cc2n, 0x7226a82c60a37361n, 0x0449525574c63a00n,
  0x966bfbee079e019fn, 0x288ea577a7c1c83en,
  0xbab14f10dae49eddn, 0x4cd3f85a0e07657cn, 0xdef6a1933f2a3c1bn,
  0x71197f6c72ad02ban, 0x033c289ba5cfc959n,
  0x955ed2de01f2b0f8n, 0x27817c013225a897n, 0xb9a4264465480036n,
  0x4bc6cfe798eaf7d5n, 0xdde978eacb8def74n,
];

// MDS matrix t=3: circulant [[3,1,1],[1,3,1],[1,1,3]]
export const MDS_MATRIX_T3: readonly (readonly bigint[])[] = [
  [3n, 1n, 1n],
  [1n, 3n, 1n],
  [1n, 1n, 3n],
];

// MDS matrix t=5: circulant [[5,1,1,1,1], …]
export const MDS_MATRIX_T5: readonly (readonly bigint[])[] = [
  [5n, 1n, 1n, 1n, 1n],
  [1n, 5n, 1n, 1n, 1n],
  [1n, 1n, 5n, 1n, 1n],
  [1n, 1n, 1n, 5n, 1n],
  [1n, 1n, 1n, 1n, 5n],
];

const NUM_ROUNDS = 30;

// =============================================================================
// Permutations (mirror stark/src/poseidon/mod.rs exactly)
// =============================================================================

function mdsMultiplyT3(state: [bigint, bigint, bigint]): void {
  const [s0, s1, s2] = state;
  const r0 = gadd(gadd(gmul(MDS_MATRIX_T3[0][0], s0), gmul(MDS_MATRIX_T3[0][1], s1)), gmul(MDS_MATRIX_T3[0][2], s2));
  const r1 = gadd(gadd(gmul(MDS_MATRIX_T3[1][0], s0), gmul(MDS_MATRIX_T3[1][1], s1)), gmul(MDS_MATRIX_T3[1][2], s2));
  const r2 = gadd(gadd(gmul(MDS_MATRIX_T3[2][0], s0), gmul(MDS_MATRIX_T3[2][1], s1)), gmul(MDS_MATRIX_T3[2][2], s2));
  state[0] = r0;
  state[1] = r1;
  state[2] = r2;
}

function mdsMultiplyT5(state: bigint[]): void {
  const result: bigint[] = [0n, 0n, 0n, 0n, 0n];
  for (let i = 0; i < 5; i++) {
    let acc = 0n;
    for (let j = 0; j < 5; j++) {
      acc = gadd(acc, gmul(MDS_MATRIX_T5[i][j], state[j]));
    }
    result[i] = acc;
  }
  for (let i = 0; i < 5; i++) state[i] = result[i];
}

/**
 * Width-3 Poseidon permutation (2-to-1 hash). Mutates `state` in-place
 * and also returns it for convenience. All inputs are assumed to be already
 * reduced modulo Goldilocks, but we reduce on every add/mul regardless.
 *
 * Mirrors Rust `permutation_t3` in `stark/src/poseidon/mod.rs`.
 */
export function poseidonPermutationT3(
  state: [bigint, bigint, bigint],
): [bigint, bigint, bigint] {
  // Normalize inputs.
  state[0] = mod(state[0]);
  state[1] = mod(state[1]);
  state[2] = mod(state[2]);

  for (let round = 0; round < NUM_ROUNDS; round++) {
    // Add round constants.
    state[0] = gadd(state[0], ROUND_CONSTANTS_T3[round * 3 + 0]);
    state[1] = gadd(state[1], ROUND_CONSTANTS_T3[round * 3 + 1]);
    state[2] = gadd(state[2], ROUND_CONSTANTS_T3[round * 3 + 2]);
    // Full S-box on all lanes.
    state[0] = sbox(state[0]);
    state[1] = sbox(state[1]);
    state[2] = sbox(state[2]);
    // MDS.
    mdsMultiplyT3(state);
  }
  return state;
}

/**
 * Width-5 Poseidon permutation (4-to-1 hash).
 * Returns a fresh 5-element array (the input may be shorter; missing lanes
 * are treated as 0). Mirrors Rust `permutation_t5`.
 */
export function poseidonPermutationT5(stateIn: bigint[]): bigint[] {
  const state: bigint[] = [
    mod(stateIn[0] ?? 0n),
    mod(stateIn[1] ?? 0n),
    mod(stateIn[2] ?? 0n),
    mod(stateIn[3] ?? 0n),
    mod(stateIn[4] ?? 0n),
  ];
  for (let round = 0; round < NUM_ROUNDS; round++) {
    for (let i = 0; i < 5; i++) {
      state[i] = gadd(state[i], ROUND_CONSTANTS_T5[round * 5 + i]);
    }
    for (let i = 0; i < 5; i++) {
      state[i] = sbox(state[i]);
    }
    mdsMultiplyT5(state);
  }
  return state;
}

// =============================================================================
// High-level hash helpers
// =============================================================================

/**
 * 2-to-1 compression using the width-3 permutation with capacity = 0.
 * Matches Rust `poseidon::hash2(a, b)` — used by `compute_update_roots`
 * for Merkle path verification (circuit 6).
 */
export function goldilocksHash2to1(a: bigint, b: bigint): bigint {
  const state: [bigint, bigint, bigint] = [mod(a), mod(b), 0n];
  poseidonPermutationT3(state);
  return state[0];
}

/**
 * 1-element hash — matches Rust `poseidon::hash1(x)`.
 * Useful for leaves that already encode everything in one field element.
 */
export function goldilocksHash1(x: bigint): bigint {
  const state: [bigint, bigint, bigint] = [mod(x), 0n, 0n];
  poseidonPermutationT3(state);
  return state[0];
}

/**
 * 4-to-1 compression using the width-5 permutation with capacity = 0.
 * Matches Rust `poseidon::hash4(a, b, c, d)`.
 */
export function goldilocksHash4to1(a: bigint, b: bigint, c: bigint, d: bigint): bigint {
  const state = [mod(a), mod(b), mod(c), mod(d), 0n];
  const out = poseidonPermutationT5(state);
  return out[0];
}

/**
 * Compute a commitment hash matching the pool_commitment / confidential_balance
 * circuit convention:
 *
 *   1 element:          Poseidon(x)           — hash1
 *   2 elements:         Poseidon(a, b)        — hash2
 *   3 elements:         Poseidon(hash2(a,b), c)
 *   4 elements:         Poseidon(hash2(a,b), hash2(c,d))
 *   >=5 elements:       4-to-1 sponge with width-5 Poseidon, tree-reduced pair-wise
 *
 * For circuit 1 (pool_commitment), the Rust prover computes:
 *     nullifier   = Poseidon(nullifier_preimage, secret)
 *     epoch_hash  = Poseidon(deposit_epoch, token_mint)
 *     commitment  = Poseidon(nullifier, epoch_hash)
 * which is exactly the 4-input branch. For Merkle-tree callers that already
 * have a single leaf value, prefer `goldilocksHash2to1` directly.
 */
export function computeCommitmentHash(inputs: bigint[]): bigint {
  if (inputs.length === 0) {
    throw new Error('computeCommitmentHash: empty input');
  }
  if (inputs.length === 1) {
    return goldilocksHash1(inputs[0]);
  }
  if (inputs.length === 2) {
    return goldilocksHash2to1(inputs[0], inputs[1]);
  }
  if (inputs.length === 3) {
    return goldilocksHash2to1(goldilocksHash2to1(inputs[0], inputs[1]), inputs[2]);
  }
  if (inputs.length === 4) {
    // Matches pool_commitment layout: hash(hash(a,b), hash(c,d)).
    const h1 = goldilocksHash2to1(inputs[0], inputs[1]);
    const h2 = goldilocksHash2to1(inputs[2], inputs[3]);
    return goldilocksHash2to1(h1, h2);
  }
  // >4 inputs: tree-reduce pair-wise using width-3 Poseidon. Odd tails are
  // absorbed with a zero partner so every internal node is a clean 2-to-1 hash.
  let layer = inputs.map(mod);
  while (layer.length > 1) {
    const next: bigint[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const right = i + 1 < layer.length ? layer[i + 1] : 0n;
      next.push(goldilocksHash2to1(layer[i], right));
    }
    layer = next;
  }
  return layer[0];
}

/**
 * Precompute the "empty subtree" zero-hash cascade for a Merkle tree of
 * `depth` levels. `zero[0] = 0n`; `zero[L] = hash(zero[L-1], zero[L-1])`.
 *
 * Required by the mobile Merkle tree to synthesize empty-slot sibling hashes
 * without materializing the full tree. Matches the cascade produced by
 * `compute_update_roots` when every `path_element` is zero.
 */
export function computeGoldilocksZeroCascade(depth: number): bigint[] {
  if (depth < 0 || !Number.isInteger(depth)) {
    throw new Error(`computeGoldilocksZeroCascade: invalid depth ${depth}`);
  }
  const out: bigint[] = new Array(depth + 1);
  out[0] = 0n;
  for (let i = 1; i <= depth; i++) {
    out[i] = goldilocksHash2to1(out[i - 1], out[i - 1]);
  }
  return out;
}

// =============================================================================
// Pool-commitment nullifier helper (pure JS mirror of WASM circuit 1)
// =============================================================================

const U64_MASK = (1n << 64n) - 1n;

/**
 * Compute the Goldilocks nullifier for a denominated-pool note WITHOUT running
 * the STARK prover.
 *
 * Mirrors the first hash cycle of `stark/src/air/denominated_pool.rs`:
 *   nullifier = Poseidon(nullifier_preimage, secret)  // Goldilocks, t=3, cap=0
 *
 * WASM boundary: `wasm_bindgen` casts JS `BigInt` → `u64` via low-64-bit
 * truncation. Receipts store BN254 field elements (254-bit), so we reproduce
 * that exact truncation here before hashing — otherwise the nullifier the
 * scanner derives would not match what the WASM prover embedded in the proof.
 *
 * The on-chain `unshield_denominated_stark` / `subscribe_private_stark`
 * handlers read the nullifier as `u64::from_le_bytes(nullifier[0..8])` and
 * hash it for the PDA seed, so callers should also pass the 32-byte form
 * returned by {@link goldilocksNullifierToBytes} to `deriveNullifierPDA`.
 */
export function computeGoldilocksPoolNullifier(
  nullifierPreimage: bigint,
  secret: bigint,
): bigint {
  const np = nullifierPreimage & U64_MASK;
  const sec = secret & U64_MASK;
  return goldilocksHash2to1(np, sec);
}

/**
 * Pack a Goldilocks u64 nullifier into the 32-byte little-endian form
 * expected by on-chain instructions: bytes 0..8 = u64 LE, bytes 8..32 = 0.
 */
export function goldilocksNullifierToBytes(nullifier: bigint): number[] {
  const bytes: number[] = new Array(32).fill(0);
  let v = nullifier & U64_MASK;
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(v & 0xFFn);
    v >>= 8n;
  }
  return bytes;
}
