/// Compact STARK proof generator for on-chain verification.
///
/// Converts a winterfell STARK proof into the compact format
/// understood by the p01_stark_verifier on-chain program.

use winterfell::math::fields::f64::BaseElement;
use winterfell::math::FieldElement;

/// Trace parameters matching the on-chain verifier.
const TRACE_WIDTH: usize = 3;
const TRACE_LENGTH: usize = 32;
const BLOWUP: usize = 8;
const LDE_SIZE: usize = TRACE_LENGTH * BLOWUP;
const NUM_QUERIES: usize = 16;
const MERKLE_DEPTH: usize = 8;
const NUM_ROUNDS: usize = 30;

/// Generate a compact proof for subscriber_ownership.
///
/// This builds the trace, creates a Merkle commitment, derives
/// query positions via Fiat-Shamir, and returns the serialized compact proof.
pub fn generate_compact_proof(subscriber_secret: u64) -> CompactProofData {
    let secret = BaseElement::new(subscriber_secret);

    // 1. Build execution trace (32 rows × 3 columns)
    let trace = crate::air::subscriber_ownership::build_trace(secret);
    let commitment = trace[0][NUM_ROUNDS].as_int();

    // 2. Compute LDE: evaluate trace polynomial at 256 points
    let lde = compute_lde(&trace);

    // 3. Build Merkle tree over LDE rows
    let (root, tree) = build_merkle_tree(&lde);

    // 4. Derive query positions from Fiat-Shamir
    let commitment_bytes = commitment.to_le_bytes();
    let positions = derive_query_positions(&root, &commitment_bytes);

    // 5. Build query proofs with Merkle paths
    let mut queries = Vec::new();
    for &pos in &positions {
        let next_pos = (pos + BLOWUP) % LDE_SIZE;

        let trace_values = [
            lde[0][pos], lde[1][pos], lde[2][pos],
        ];
        let next_trace_values = [
            lde[0][next_pos], lde[1][next_pos], lde[2][next_pos],
        ];

        let merkle_path = get_merkle_proof(&tree, pos);
        let next_merkle_path = get_merkle_proof(&tree, next_pos);

        queries.push(CompactQuery {
            position: pos as u32,
            trace_values: [
                trace_values[0].as_int(),
                trace_values[1].as_int(),
                trace_values[2].as_int(),
            ],
            next_trace_values: [
                next_trace_values[0].as_int(),
                next_trace_values[1].as_int(),
                next_trace_values[2].as_int(),
            ],
            merkle_path,
            next_merkle_path,
        });
    }

    // 6. OOD evaluations (simplified: use trace values at index 1 as representative)
    let ood_z = 0x123456789ABCDEF0_u64; // deterministic OOD point
    let ood_current = [lde[0][1].as_int(), lde[1][1].as_int(), lde[2][1].as_int()];
    let ood_next = [lde[0][1 + TRACE_LENGTH].as_int(), lde[1][1 + TRACE_LENGTH].as_int(), lde[2][1 + TRACE_LENGTH].as_int()];

    // 7. Quotient values (placeholder — real verifier checks constraint polynomial)
    let quotient_values: Vec<u64> = positions.iter().map(|_| 0u64).collect();

    // 8. Serialize
    let bytes = serialize_compact_proof(
        &root,
        &ood_current,
        &ood_next,
        ood_z,
        &queries,
        &quotient_values,
    );

    CompactProofData {
        proof_bytes: bytes,
        commitment,
        root,
    }
}

pub struct CompactProofData {
    pub proof_bytes: Vec<u8>,
    pub commitment: u64,
    pub root: [u8; 32],
}

struct CompactQuery {
    position: u32,
    trace_values: [u64; 3],
    next_trace_values: [u64; 3],
    merkle_path: [[u8; 32]; MERKLE_DEPTH],
    next_merkle_path: [[u8; 32]; MERKLE_DEPTH],
}

/// Compute LDE by evaluating trace polynomials at BLOWUP * TRACE_LENGTH points.
/// Uses FFT interpolation + evaluation.
fn compute_lde(trace: &[Vec<BaseElement>]) -> Vec<Vec<BaseElement>> {
    let mut lde = vec![vec![BaseElement::ZERO; LDE_SIZE]; TRACE_WIDTH];

    for col in 0..TRACE_WIDTH {
        // Simple approach: the trace defines values at positions 0, BLOWUP, 2*BLOWUP, ...
        // For a proper LDE, we'd do polynomial interpolation then evaluation.
        // Simplified: copy trace values to their LDE positions and interpolate linearly.
        for row in 0..TRACE_LENGTH {
            lde[col][row * BLOWUP] = trace[col][row];
        }

        // Interpolate intermediate positions using Lagrange
        // For simplicity and correctness on-chain, use the trace polynomial approach:
        // The trace polynomial T(x) passes through all 32 trace points.
        // Evaluate T at all 256 LDE domain points.
        let poly = interpolate_poly(&trace[col]);
        for i in 0..LDE_SIZE {
            // LDE domain point: generator^i where generator is a 256th root of unity
            let g = get_lde_domain_generator();
            let x = g.exp(i as u64);
            lde[col][i] = evaluate_poly(&poly, x);
        }
    }

    lde
}

/// Get a primitive 256th root of unity in the Goldilocks field.
fn get_lde_domain_generator() -> BaseElement {
    // The Goldilocks field has a multiplicative group of order 2^64 - 2^32.
    // A 2^k-th root of unity exists for k up to 32.
    // g_256 = g_{2^32}^{2^32 / 256} = g_{2^32}^{2^24}
    // where g_{2^32} is a primitive 2^32-th root of unity.
    //
    // A known generator of the multiplicative group: 7
    // g_{2^32} = 7^((p-1)/2^32)
    let p_minus_1 = BaseElement::new(0xFFFFFFFF00000000_u64); // p - 1
    let exp = p_minus_1.as_int() / (1u64 << 32); // (p-1) / 2^32
    let g_2_32 = BaseElement::new(7).exp_vartime(exp.into());
    // g_256 = g_2_32^(2^24)
    let mut g = g_2_32;
    for _ in 0..24 {
        g = g * g;
    }
    g
}

/// Lagrange interpolation to get polynomial coefficients from trace values.
/// Input: values at positions g^0, g^1, ..., g^(n-1) where g is n-th root of unity.
fn interpolate_poly(values: &[BaseElement]) -> Vec<BaseElement> {
    let n = values.len();
    // Use inverse FFT (NTT) for interpolation over roots of unity
    // For n=32, this is efficient.
    let g = get_trace_domain_generator();
    inverse_ntt(values, g)
}

fn get_trace_domain_generator() -> BaseElement {
    // 32nd root of unity
    let lde_g = get_lde_domain_generator();
    // trace generator = lde_generator^BLOWUP
    let mut g = lde_g;
    for _ in 0..3 { // BLOWUP = 8 = 2^3
        g = g * g;
    }
    g
}

/// Evaluate polynomial at point x.
fn evaluate_poly(coeffs: &[BaseElement], x: BaseElement) -> BaseElement {
    let mut result = BaseElement::ZERO;
    let mut power = BaseElement::ONE;
    for &c in coeffs {
        result = result + c * power;
        power = power * x;
    }
    result
}

/// Inverse NTT for interpolation.
fn inverse_ntt(values: &[BaseElement], omega: BaseElement) -> Vec<BaseElement> {
    let n = values.len();
    let omega_inv = omega.exp(((0xFFFFFFFF00000001_u64 - 2) as u64).into()); // omega^(-1)
    let n_inv = BaseElement::new(n as u64).exp(((0xFFFFFFFF00000001_u64 - 2) as u64).into()); // n^(-1)

    // Forward NTT with inverse omega
    let mut result = ntt(values, omega_inv);

    // Scale by 1/n
    for v in &mut result {
        *v = *v * n_inv;
    }

    result
}

/// Forward NTT (Number Theoretic Transform).
fn ntt(values: &[BaseElement], omega: BaseElement) -> Vec<BaseElement> {
    let n = values.len();
    if n == 1 {
        return values.to_vec();
    }

    let half = n / 2;
    let omega_sq = omega * omega;

    let even: Vec<_> = (0..half).map(|i| values[2 * i]).collect();
    let odd: Vec<_> = (0..half).map(|i| values[2 * i + 1]).collect();

    let even_ntt = ntt(&even, omega_sq);
    let odd_ntt = ntt(&odd, omega_sq);

    let mut result = vec![BaseElement::ZERO; n];
    let mut w = BaseElement::ONE;

    for i in 0..half {
        let t = w * odd_ntt[i];
        result[i] = even_ntt[i] + t;
        result[i + half] = even_ntt[i] - t;
        w = w * omega;
    }

    result
}

/// Build a Blake3 Merkle tree from LDE columns.
/// Returns (root, tree_layers).
fn build_merkle_tree(lde: &[Vec<BaseElement>]) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    // Compute leaf hashes (one per LDE row)
    let leaves: Vec<[u8; 32]> = (0..LDE_SIZE)
        .map(|i| {
            let mut data = [0u8; TRACE_WIDTH * 8];
            for col in 0..TRACE_WIDTH {
                data[col * 8..(col + 1) * 8].copy_from_slice(&lde[col][i].as_int().to_le_bytes());
            }
            *blake3::hash(&data).as_bytes()
        })
        .collect();

    let mut layers = vec![leaves];

    while layers.last().unwrap().len() > 1 {
        let prev = layers.last().unwrap();
        let next: Vec<[u8; 32]> = prev
            .chunks(2)
            .map(|pair| {
                let mut data = [0u8; 64];
                data[..32].copy_from_slice(&pair[0]);
                data[32..].copy_from_slice(if pair.len() > 1 { &pair[1] } else { &pair[0] });
                *blake3::hash(&data).as_bytes()
            })
            .collect();
        layers.push(next);
    }

    let root = layers.last().unwrap()[0];
    (root, layers)
}

/// Get Merkle proof (siblings) for a leaf at the given index.
fn get_merkle_proof(tree: &[Vec<[u8; 32]>], index: usize) -> [[u8; 32]; MERKLE_DEPTH] {
    let mut proof = [[0u8; 32]; MERKLE_DEPTH];
    let mut idx = index;

    for (level, layer) in tree.iter().enumerate() {
        if level >= MERKLE_DEPTH {
            break;
        }
        let sibling_idx = idx ^ 1;
        if sibling_idx < layer.len() {
            proof[level] = layer[sibling_idx];
        }
        idx >>= 1;
    }

    proof
}

fn derive_query_positions(root: &[u8; 32], commitment_bytes: &[u8; 8]) -> Vec<usize> {
    let mut seed = [0u8; 40];
    seed[..32].copy_from_slice(root);
    seed[32..40].copy_from_slice(commitment_bytes);

    let mut positions = Vec::new();
    let mut counter = 0u32;

    while positions.len() < NUM_QUERIES {
        let mut input = [0u8; 44];
        input[..40].copy_from_slice(&seed);
        input[40..44].copy_from_slice(&counter.to_le_bytes());

        let hash = blake3::hash(&input);
        let bytes = hash.as_bytes();

        for chunk in bytes.chunks(4) {
            if positions.len() >= NUM_QUERIES {
                break;
            }
            let val = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            let pos = (val as usize) % LDE_SIZE;
            if !positions.contains(&pos) {
                positions.push(pos);
            }
        }
        counter += 1;
    }

    positions.sort();
    positions
}

fn serialize_compact_proof(
    root: &[u8; 32],
    ood_current: &[u64; 3],
    ood_next: &[u64; 3],
    ood_z: u64,
    queries: &[CompactQuery],
    quotient_values: &[u64],
) -> Vec<u8> {
    let mut bytes = Vec::new();

    // trace_root: 32 bytes
    bytes.extend_from_slice(root);

    // ood_current: 3 * 8 = 24 bytes
    for v in ood_current {
        bytes.extend_from_slice(&v.to_le_bytes());
    }

    // ood_next: 3 * 8 = 24 bytes
    for v in ood_next {
        bytes.extend_from_slice(&v.to_le_bytes());
    }

    // ood_z: 8 bytes
    bytes.extend_from_slice(&ood_z.to_le_bytes());

    // num_queries: 2 bytes
    bytes.extend_from_slice(&(queries.len() as u16).to_le_bytes());

    // queries
    for q in queries {
        bytes.extend_from_slice(&q.position.to_le_bytes());
        for v in &q.trace_values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        for v in &q.next_trace_values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        for path in &q.merkle_path {
            bytes.extend_from_slice(path);
        }
        for path in &q.next_merkle_path {
            bytes.extend_from_slice(path);
        }
    }

    // quotient_values
    for v in quotient_values {
        bytes.extend_from_slice(&v.to_le_bytes());
    }

    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_compact_proof() {
        let proof_data = generate_compact_proof(42);

        println!("Compact proof size: {} bytes", proof_data.proof_bytes.len());
        println!("Commitment: {}", proof_data.commitment);
        println!("Root: {:?}", hex::encode(proof_data.root));

        assert!(!proof_data.proof_bytes.is_empty());
        assert!(proof_data.commitment != 0);
        assert!(proof_data.proof_bytes.len() < 20_000, "Proof too large");
    }

    #[test]
    fn test_lde_domain_generator() {
        let g = get_lde_domain_generator();
        // g^256 should equal 1 (256th root of unity)
        let g_256 = g.exp(256u64.into());
        assert_eq!(g_256, BaseElement::ONE, "g^256 should be 1");
        // g^128 should not be 1 (primitive)
        let g_128 = g.exp(128u64.into());
        assert_ne!(g_128, BaseElement::ONE, "g should be primitive 256th root");
    }

    #[test]
    fn test_trace_domain_generator() {
        let g = get_trace_domain_generator();
        // g^32 should equal 1
        let g_32 = g.exp(32u64.into());
        assert_eq!(g_32, BaseElement::ONE, "trace generator^32 should be 1");
    }

    #[test]
    fn test_ntt_roundtrip() {
        let g = get_trace_domain_generator();
        let values: Vec<BaseElement> = (0..32).map(|i| BaseElement::new(i + 1)).collect();

        let coeffs = interpolate_poly(&values);
        // Evaluate at the domain points to verify roundtrip
        for (i, &v) in values.iter().enumerate() {
            let x = g.exp(i as u64);
            let eval = evaluate_poly(&coeffs, x);
            assert_eq!(eval, v, "NTT roundtrip failed at index {}", i);
        }
    }

    #[test]
    fn test_merkle_proof_verification() {
        let trace = crate::air::subscriber_ownership::build_trace(BaseElement::new(42));
        let lde = compute_lde(&trace);
        let (root, tree) = build_merkle_tree(&lde);

        // Verify a leaf
        let idx = 10;
        let proof = get_merkle_proof(&tree, idx);

        // Recompute leaf hash
        let mut leaf_data = [0u8; 24];
        for col in 0..3 {
            leaf_data[col * 8..(col + 1) * 8]
                .copy_from_slice(&lde[col][idx].as_int().to_le_bytes());
        }
        let leaf_hash = *blake3::hash(&leaf_data).as_bytes();

        // Walk the proof
        let mut current = leaf_hash;
        let mut i = idx;
        for sibling in &proof {
            let mut pair = [0u8; 64];
            if i & 1 == 0 {
                pair[..32].copy_from_slice(&current);
                pair[32..].copy_from_slice(sibling);
            } else {
                pair[..32].copy_from_slice(sibling);
                pair[32..].copy_from_slice(&current);
            }
            current = *blake3::hash(&pair).as_bytes();
            i >>= 1;
        }

        assert_eq!(current, root, "Merkle proof should verify to root");
    }

    #[test]
    fn test_different_secrets_different_proofs() {
        let p1 = generate_compact_proof(42);
        let p2 = generate_compact_proof(43);

        assert_ne!(p1.commitment, p2.commitment);
        assert_ne!(p1.root, p2.root);
    }

    #[test]
    fn test_generic_domain_generators() {
        // 256th root
        let g256 = get_domain_generator_generic(256);
        assert_eq!(g256.exp(256u64.into()), BaseElement::ONE);
        assert_ne!(g256.exp(128u64.into()), BaseElement::ONE);

        // 1024th root
        let g1024 = get_domain_generator_generic(1024);
        assert_eq!(g1024.exp(1024u64.into()), BaseElement::ONE);
        assert_ne!(g1024.exp(512u64.into()), BaseElement::ONE);

        // 4096th root
        let g4096 = get_domain_generator_generic(4096);
        assert_eq!(g4096.exp(4096u64.into()), BaseElement::ONE);
        assert_ne!(g4096.exp(2048u64.into()), BaseElement::ONE);
    }

    #[test]
    fn test_pool_commitment_compact_proof() {
        let proof = generate_pool_commitment_proof(111, 222, 333, 444);
        assert!(!proof.proof_bytes.is_empty());
        assert!(proof.proof_bytes.len() < 30_000, "Pool proof too large: {}", proof.proof_bytes.len());
        println!("Pool commitment proof size: {} bytes", proof.proof_bytes.len());
        println!("Public inputs: {:?}", proof.public_inputs);
    }

    #[test]
    fn test_balance_compact_proof() {
        let proof = generate_balance_compact_proof(42, 1000, 777, 999);
        assert!(!proof.proof_bytes.is_empty());
        assert!(proof.proof_bytes.len() < 30_000, "Balance proof too large: {}", proof.proof_bytes.len());
        println!("Balance proof size: {} bytes", proof.proof_bytes.len());
    }

    #[test]
    fn test_merkle_path_compact_proof() {
        let leaf = 42u64;
        let path_elements: Vec<u64> = (0..3).map(|i| 100 + i).collect();
        let path_indices = vec![0u8, 1, 0];
        let proof = generate_merkle_path_compact_proof(leaf, &path_elements, &path_indices);
        assert!(!proof.proof_bytes.is_empty());
        assert!(proof.proof_bytes.len() < 30_000, "Merkle proof too large: {}", proof.proof_bytes.len());
        println!("Merkle path (depth 3) proof size: {} bytes", proof.proof_bytes.len());
    }
}

// ============================================================================
// Generic compact proof infrastructure
// ============================================================================

/// Circuit IDs matching the on-chain verifier.
pub const CIRCUIT_SUBSCRIBER_OWNERSHIP: u8 = 0;
pub const CIRCUIT_POOL_COMMITMENT: u8 = 1;
pub const CIRCUIT_BALANCE_PROOF: u8 = 2;
pub const CIRCUIT_MERKLE_PATH: u8 = 3;

/// Generic compact proof data for any circuit.
#[derive(Clone, Debug)]
pub struct GenericCompactProofData {
    pub proof_bytes: Vec<u8>,
    pub circuit_id: u8,
    pub public_inputs: Vec<u64>,
    pub root: [u8; 32],
}

/// Get a primitive Nth root of unity in the Goldilocks field.
/// N must be a power of 2 and <= 2^32.
fn get_domain_generator_generic(domain_size: usize) -> BaseElement {
    assert!(domain_size.is_power_of_two());
    let k = domain_size.trailing_zeros(); // log2(domain_size)
    assert!(k <= 32);

    // g_{2^32} = 7^((p-1)/2^32) where 7 is a generator of the multiplicative group
    let p_minus_1 = 0xFFFFFFFF00000000_u64; // p - 1
    let exp_32 = p_minus_1 / (1u64 << 32);
    let g_2_32 = BaseElement::new(7).exp_vartime(exp_32.into());

    // g_{2^k} = g_{2^32}^{2^(32-k)}
    let mut g = g_2_32;
    for _ in 0..(32 - k) {
        g = g * g;
    }
    g
}

/// Compute LDE for any trace dimensions.
fn compute_lde_generic(
    trace: &[Vec<BaseElement>],
    blowup: usize,
) -> Vec<Vec<BaseElement>> {
    let trace_width = trace.len();
    let trace_length = trace[0].len();
    let lde_size = trace_length * blowup;

    let trace_g = get_domain_generator_generic(trace_length);
    let lde_g = get_domain_generator_generic(lde_size);

    let mut lde = vec![vec![BaseElement::ZERO; lde_size]; trace_width];

    for col in 0..trace_width {
        // Interpolate: get polynomial coefficients from trace values
        let poly = inverse_ntt(&trace[col], trace_g);
        // Evaluate at all LDE domain points
        for i in 0..lde_size {
            let x = lde_g.exp(i as u64);
            lde[col][i] = evaluate_poly(&poly, x);
        }
    }

    lde
}

/// Build a Blake3 Merkle tree from LDE columns (any width).
fn build_merkle_tree_generic(
    lde: &[Vec<BaseElement>],
    trace_width: usize,
) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    let lde_size = lde[0].len();

    let leaves: Vec<[u8; 32]> = (0..lde_size)
        .map(|i| {
            let mut data = vec![0u8; trace_width * 8];
            for col in 0..trace_width {
                data[col * 8..(col + 1) * 8]
                    .copy_from_slice(&lde[col][i].as_int().to_le_bytes());
            }
            *blake3::hash(&data).as_bytes()
        })
        .collect();

    let mut layers = vec![leaves];

    while layers.last().unwrap().len() > 1 {
        let prev = layers.last().unwrap();
        let next: Vec<[u8; 32]> = prev
            .chunks(2)
            .map(|pair| {
                let mut data = [0u8; 64];
                data[..32].copy_from_slice(&pair[0]);
                data[32..].copy_from_slice(if pair.len() > 1 { &pair[1] } else { &pair[0] });
                *blake3::hash(&data).as_bytes()
            })
            .collect();
        layers.push(next);
    }

    let root = layers.last().unwrap()[0];
    (root, layers)
}

/// Get Merkle proof (siblings) for a leaf at the given index (generic depth).
fn get_merkle_proof_generic(
    tree: &[Vec<[u8; 32]>],
    index: usize,
    depth: usize,
) -> Vec<[u8; 32]> {
    let mut proof = vec![[0u8; 32]; depth];
    let mut idx = index;

    for (level, layer) in tree.iter().enumerate() {
        if level >= depth {
            break;
        }
        let sibling_idx = idx ^ 1;
        if sibling_idx < layer.len() {
            proof[level] = layer[sibling_idx];
        }
        idx >>= 1;
    }

    proof
}

/// Derive query positions using Fiat-Shamir (generic LDE size).
fn derive_query_positions_generic(
    root: &[u8; 32],
    pub_input_bytes: &[u8],
    lde_size: usize,
    num_queries: usize,
) -> Vec<usize> {
    let mut seed = Vec::with_capacity(32 + pub_input_bytes.len());
    seed.extend_from_slice(root);
    seed.extend_from_slice(pub_input_bytes);

    let mut positions = Vec::new();
    let mut counter = 0u32;

    while positions.len() < num_queries {
        let mut input = Vec::with_capacity(seed.len() + 4);
        input.extend_from_slice(&seed);
        input.extend_from_slice(&counter.to_le_bytes());

        let hash = blake3::hash(&input);
        let bytes = hash.as_bytes();

        for chunk in bytes.chunks(4) {
            if positions.len() >= num_queries {
                break;
            }
            let val = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            let pos = (val as usize) % lde_size;
            if !positions.contains(&pos) {
                positions.push(pos);
            }
        }
        counter += 1;
    }

    positions.sort();
    positions
}

/// Generate a compact proof from an already-built trace.
fn generate_compact_proof_from_trace(
    trace: &[Vec<BaseElement>],
    pub_input_bytes: &[u8],
    blowup: usize,
    num_queries: usize,
) -> (Vec<u8>, [u8; 32]) {
    let trace_width = trace.len();
    let trace_length = trace[0].len();
    let lde_size = trace_length * blowup;
    let merkle_depth = (lde_size as f64).log2() as usize;

    // 1. Compute LDE
    let lde = compute_lde_generic(trace, blowup);

    // 2. Build Merkle tree
    let (root, tree) = build_merkle_tree_generic(&lde, trace_width);

    // 3. Derive query positions
    let positions = derive_query_positions_generic(&root, pub_input_bytes, lde_size, num_queries);

    // 4. Build query proofs
    let mut bytes = Vec::new();

    // Header: trace_root
    bytes.extend_from_slice(&root);

    // OOD evaluations (simplified)
    let ood_z = 0x123456789ABCDEF0_u64;
    for col in 0..trace_width {
        bytes.extend_from_slice(&lde[col][1].as_int().to_le_bytes());
    }
    let next_ood_idx = 1 + trace_length;
    for col in 0..trace_width {
        let idx = if next_ood_idx < lde_size { next_ood_idx } else { next_ood_idx % lde_size };
        bytes.extend_from_slice(&lde[col][idx].as_int().to_le_bytes());
    }
    bytes.extend_from_slice(&ood_z.to_le_bytes());

    // Num queries
    bytes.extend_from_slice(&(num_queries as u16).to_le_bytes());

    // Queries
    for &pos in &positions {
        let next_pos = (pos + blowup) % lde_size;

        bytes.extend_from_slice(&(pos as u32).to_le_bytes());

        // trace_values at pos
        for col in 0..trace_width {
            bytes.extend_from_slice(&lde[col][pos].as_int().to_le_bytes());
        }
        // next_trace_values at next_pos
        for col in 0..trace_width {
            bytes.extend_from_slice(&lde[col][next_pos].as_int().to_le_bytes());
        }

        // Merkle paths
        let path = get_merkle_proof_generic(&tree, pos, merkle_depth);
        for node in &path {
            bytes.extend_from_slice(node);
        }
        let next_path = get_merkle_proof_generic(&tree, next_pos, merkle_depth);
        for node in &next_path {
            bytes.extend_from_slice(node);
        }
    }

    // Quotient values (placeholder)
    for _ in 0..num_queries {
        bytes.extend_from_slice(&0u64.to_le_bytes());
    }

    (bytes, root)
}

// ============================================================================
// Circuit-specific compact proof generators
// ============================================================================

const GENERIC_BLOWUP: usize = 8;
const GENERIC_NUM_QUERIES: usize = 16;

/// Generate compact proof for denominated pool commitment.
///
/// Proves: nullifier = Poseidon(np, secret), commitment = Poseidon(nullifier, Poseidon(epoch, mint))
/// Public inputs: nullifier, commitment
pub fn generate_pool_commitment_proof(
    nullifier_preimage: u64,
    secret: u64,
    deposit_epoch: u64,
    token_mint: u64,
) -> GenericCompactProofData {
    let np = BaseElement::new(nullifier_preimage);
    let s = BaseElement::new(secret);
    let epoch = BaseElement::new(deposit_epoch);
    let mint = BaseElement::new(token_mint);

    let (trace, nullifier, commitment) =
        crate::air::denominated_pool::build_pool_commitment_trace(np, s, epoch, mint);

    // Public inputs: nullifier, commitment
    let null_u64 = nullifier.as_int();
    let commit_u64 = commitment.as_int();
    let mut pub_bytes = Vec::new();
    pub_bytes.extend_from_slice(&null_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&commit_u64.to_le_bytes());

    let (proof_bytes, root) = generate_compact_proof_from_trace(
        &trace, &pub_bytes, GENERIC_BLOWUP, GENERIC_NUM_QUERIES,
    );

    GenericCompactProofData {
        proof_bytes,
        circuit_id: CIRCUIT_POOL_COMMITMENT,
        public_inputs: vec![null_u64, commit_u64],
        root,
    }
}

/// Generate compact proof for balance commitment.
///
/// Proves: commitment = Poseidon(Poseidon(balance, salt), Poseidon(Poseidon(sk, 0), mint))
/// Public inputs: commitment, token_mint
pub fn generate_balance_compact_proof(
    spending_key: u64,
    balance: u64,
    salt: u64,
    token_mint: u64,
) -> GenericCompactProofData {
    let sk = BaseElement::new(spending_key);
    let bal = BaseElement::new(balance);
    let s = BaseElement::new(salt);
    let mint = BaseElement::new(token_mint);

    let (trace, commitment) =
        crate::air::balance_proof::build_balance_proof_trace(sk, bal, s, mint);

    let commit_u64 = commitment.as_int();
    let mint_u64 = token_mint;
    let mut pub_bytes = Vec::new();
    pub_bytes.extend_from_slice(&commit_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&mint_u64.to_le_bytes());

    let (proof_bytes, root) = generate_compact_proof_from_trace(
        &trace, &pub_bytes, GENERIC_BLOWUP, GENERIC_NUM_QUERIES,
    );

    GenericCompactProofData {
        proof_bytes,
        circuit_id: CIRCUIT_BALANCE_PROOF,
        public_inputs: vec![commit_u64, mint_u64],
        root,
    }
}

/// Generate compact proof for Merkle path inclusion.
///
/// Proves: leaf is in a Merkle tree with root `root` at the given path.
/// Public inputs: leaf, root
pub fn generate_merkle_path_compact_proof(
    leaf: u64,
    path_elements: &[u64],
    path_indices: &[u8],
) -> GenericCompactProofData {
    let leaf_felt = BaseElement::new(leaf);
    let elems: Vec<BaseElement> = path_elements.iter().map(|&v| BaseElement::new(v)).collect();

    let trace = crate::air::merkle_path::build_merkle_trace(leaf_felt, &elems, path_indices);
    let root = crate::air::merkle_path::compute_merkle_root(leaf_felt, &elems, path_indices);

    let root_u64 = root.as_int();
    let mut pub_bytes = Vec::new();
    pub_bytes.extend_from_slice(&leaf.to_le_bytes());
    pub_bytes.extend_from_slice(&root_u64.to_le_bytes());

    let (proof_bytes, merkle_root) = generate_compact_proof_from_trace(
        &trace, &pub_bytes, GENERIC_BLOWUP, GENERIC_NUM_QUERIES,
    );

    GenericCompactProofData {
        proof_bytes,
        circuit_id: CIRCUIT_MERKLE_PATH,
        public_inputs: vec![leaf, root_u64],
        root: merkle_root,
    }
}
