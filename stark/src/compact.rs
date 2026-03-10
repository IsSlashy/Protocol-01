/// Compact STARK proof generator for on-chain verification.
///
/// Converts a winterfell STARK proof into the compact format
/// understood by the p01_stark_verifier on-chain program.

use winterfell::math::fields::f64::BaseElement;
use winterfell::math::FieldElement;

/// Goldilocks prime: p = 2^64 - 2^32 + 1
const GOLDILOCKS_PRIME: u64 = 0xFFFFFFFF00000001;

/// Trace parameters matching the on-chain verifier.
const TRACE_WIDTH: usize = 3;
const TRACE_LENGTH: usize = 32;
const BLOWUP: usize = 16;
const LDE_SIZE: usize = TRACE_LENGTH * BLOWUP;
const NUM_QUERIES: usize = 128;
const MERKLE_DEPTH: usize = 9; // log2(512) = 9
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

    // 2. Compute LDE: evaluate trace polynomial at LDE_SIZE points
    let lde = compute_lde(&trace);

    // 3. Build Merkle tree over LDE rows
    let (root, tree) = build_merkle_tree(&lde);

    // 4. [H10] Derive OOD point from Fiat-Shamir transcript
    let commitment_bytes = commitment.to_le_bytes();
    let ood_z = derive_ood_point(&root, &commitment_bytes);

    // 5. Compute OOD evaluations by evaluating trace polynomials at ood_z
    let ood_z_felt = BaseElement::new(ood_z);
    let trace_g = get_trace_domain_generator();
    let ood_z_next = ood_z_felt * trace_g; // z * g (next row in trace domain)
    let mut ood_current = [0u64; 3];
    let mut ood_next = [0u64; 3];
    for col in 0..TRACE_WIDTH {
        let poly = interpolate_poly(&trace[col]);
        ood_current[col] = evaluate_poly(&poly, ood_z_felt).as_int();
        ood_next[col] = evaluate_poly(&poly, ood_z_next).as_int();
    }

    // 6. [H9] Include OOD evaluations in Fiat-Shamir transcript before deriving queries
    let positions = derive_query_positions_with_ood(&root, &commitment_bytes, &ood_current, &ood_next);

    // 7. Build query proofs with Merkle paths
    let lde_g = get_lde_domain_generator();
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

    // 8. [H11] Compute actual quotient polynomial values
    let quotient_values: Vec<u64> = positions.iter().map(|&pos| {
        compute_quotient_at_position(
            &lde, pos, BLOWUP, TRACE_LENGTH, TRACE_WIDTH, NUM_ROUNDS, &lde_g,
        )
    }).collect();

    // 9. Serialize
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

/// [H10] Derive OOD evaluation point from Fiat-Shamir transcript.
/// Uses blake3(trace_root || commitment_bytes) to derive a field element.
fn derive_ood_point(root: &[u8; 32], commitment_bytes: &[u8]) -> u64 {
    let mut data = Vec::with_capacity(32 + commitment_bytes.len());
    data.extend_from_slice(root);
    data.extend_from_slice(commitment_bytes);
    let hash = blake3::hash(&data);
    let mut ood_z = u64::from_le_bytes(hash.as_bytes()[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;
    // Ensure ood_z is not zero (not in any trace domain)
    if ood_z == 0 { ood_z = 1; }
    ood_z
}

/// [H10] Derive OOD evaluation point from Fiat-Shamir transcript (generic version).
fn derive_ood_point_generic(root: &[u8; 32], pub_input_bytes: &[u8]) -> u64 {
    derive_ood_point(root, pub_input_bytes)
}

/// [H9] Derive query positions with OOD evaluations included in the transcript.
fn derive_query_positions_with_ood(
    root: &[u8; 32],
    commitment_bytes: &[u8],
    ood_current: &[u64],
    ood_next: &[u64],
) -> Vec<usize> {
    // Build full transcript: trace_root || commitment || ood_current || ood_next
    let mut transcript = Vec::new();
    transcript.extend_from_slice(root);
    transcript.extend_from_slice(commitment_bytes);
    for val in ood_current {
        transcript.extend_from_slice(&val.to_le_bytes());
    }
    for val in ood_next {
        transcript.extend_from_slice(&val.to_le_bytes());
    }
    let query_seed = blake3::hash(&transcript);

    let mut positions = Vec::new();
    let mut counter = 0u32;

    while positions.len() < NUM_QUERIES {
        let mut input = Vec::with_capacity(32 + 4);
        input.extend_from_slice(query_seed.as_bytes());
        input.extend_from_slice(&counter.to_le_bytes());

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

/// [H11] Compute the quotient polynomial value Q(x) = C(x) / Z_D(x) at an LDE position.
///
/// For subscriber_ownership (circuit 0), the transition constraint is:
///   For active rounds (row < NUM_ROUNDS): next = MDS * sbox(current + RC)
///   For padding rows: next = current
///
/// The constraint polynomial C(x) evaluates to 0 on the trace domain when constraints hold.
/// The vanishing polynomial Z_D(x) = x^n - 1 where n = trace_length.
/// Q(x) = C(x) / Z_D(x) is well-defined when C vanishes on the trace domain.
fn compute_quotient_at_position(
    lde: &[Vec<BaseElement>],
    pos: usize,
    blowup: usize,
    trace_length: usize,
    trace_width: usize,
    num_rounds: usize,
    lde_g: &BaseElement,
) -> u64 {
    let lde_size = trace_length * blowup;
    let next_pos = (pos + blowup) % lde_size;

    // Get trace values at this LDE position and the next
    let current: Vec<BaseElement> = (0..trace_width).map(|col| lde[col][pos]).collect();
    let next: Vec<BaseElement> = (0..trace_width).map(|col| lde[col][next_pos]).collect();

    // The LDE domain point: omega^pos
    let domain_point = lde_g.exp(pos as u64);

    // Compute the constraint evaluation
    // We need to evaluate the combined constraint that uses periodic columns.
    // The trace domain generator omega_trace = omega_lde^blowup
    let trace_g = lde_g.exp(blowup as u64);

    // Compute the round position in the trace by figuring out which trace row
    // this LDE position corresponds to (approximately).
    // For a proper STARK, we evaluate the constraint polynomial over the LDE,
    // which requires evaluating periodic columns at the LDE point.
    //
    // The periodic column for round flag at LDE point x:
    //   flag(x) = sum over active trace rows of L_i(x)
    // where L_i is the Lagrange basis. For simplicity, we use the constraint
    // polynomial evaluated via the trace polynomial approach.

    // Evaluate constraint: for each column, compute next_col - expected_col
    // where expected comes from the Poseidon round or identity
    let constraint_eval = evaluate_transition_constraint(
        &current, &next, domain_point, trace_g, trace_length, num_rounds,
    );

    // Vanishing polynomial: Z_D(x) = x^trace_length - 1
    let x_n = domain_point.exp(trace_length as u64);
    let vanishing = x_n - BaseElement::ONE;

    // Q(x) = C(x) / Z_D(x)
    if vanishing == BaseElement::ZERO {
        0u64
    } else {
        let quotient = constraint_eval * vanishing.inv();
        quotient.as_int()
    }
}

/// Evaluate the combined transition constraint polynomial at an LDE point.
///
/// The constraint uses a flag polynomial that equals 1 on active round rows and 0 on padding.
/// Combined: result = next - current - flag(x) * (round_output(x) - current)
///
/// For the Poseidon round, we need round constants at this evaluation point.
/// The periodic columns are polynomials that interpolate the round constants over the trace domain.
fn evaluate_transition_constraint(
    current: &[BaseElement],
    next: &[BaseElement],
    x: BaseElement, // LDE domain point
    trace_g: BaseElement, // trace domain generator
    trace_length: usize,
    num_rounds: usize,
) -> BaseElement {
    let rc = &crate::poseidon::constants::ROUND_CONSTANTS_T3;

    // Build periodic column values at point x by evaluating the interpolated polynomial
    // Periodic columns are defined by their values at trace domain points
    let mut rc0_vals = vec![BaseElement::ZERO; trace_length];
    let mut rc1_vals = vec![BaseElement::ZERO; trace_length];
    let mut rc2_vals = vec![BaseElement::ZERO; trace_length];
    let mut flag_vals = vec![BaseElement::ZERO; trace_length];

    for round in 0..num_rounds {
        rc0_vals[round] = rc[round * 3];
        rc1_vals[round] = rc[round * 3 + 1];
        rc2_vals[round] = rc[round * 3 + 2];
        flag_vals[round] = BaseElement::ONE;
    }

    // Interpolate and evaluate periodic columns at x
    let rc0_poly = inverse_ntt(&rc0_vals, trace_g);
    let rc1_poly = inverse_ntt(&rc1_vals, trace_g);
    let rc2_poly = inverse_ntt(&rc2_vals, trace_g);
    let flag_poly = inverse_ntt(&flag_vals, trace_g);

    let rc0_x = evaluate_poly(&rc0_poly, x);
    let rc1_x = evaluate_poly(&rc1_poly, x);
    let rc2_x = evaluate_poly(&rc2_poly, x);
    let flag_x = evaluate_poly(&flag_poly, x);

    // Add round constants
    let s0 = current[0] + rc0_x;
    let s1 = current[1] + rc1_x;
    let s2 = current[2] + rc2_x;

    // S-box: x^7
    let sb0 = {
        let x2 = s0 * s0;
        let x4 = x2 * x2;
        x4 * x2 * s0
    };
    let sb1 = {
        let x2 = s1 * s1;
        let x4 = x2 * x2;
        x4 * x2 * s1
    };
    let sb2 = {
        let x2 = s2 * s2;
        let x4 = x2 * x2;
        x4 * x2 * s2
    };

    // MDS multiplication: [[3,1,1],[1,3,1],[1,1,3]]
    let three = BaseElement::new(3);
    let round_out_0 = three * sb0 + sb1 + sb2;
    let round_out_1 = sb0 + three * sb1 + sb2;
    let round_out_2 = sb0 + sb1 + three * sb2;

    // Combined constraint: next[i] - current[i] - flag * (round_output[i] - current[i])
    let c0 = next[0] - current[0] - flag_x * (round_out_0 - current[0]);
    let c1 = next[1] - current[1] - flag_x * (round_out_1 - current[1]);
    let c2 = next[2] - current[2] - flag_x * (round_out_2 - current[2]);

    // Sum constraints (they should all be close to zero on trace domain,
    // but we combine them into a single quotient)
    c0 + c1 + c2
}

/// [H11] Compute quotient value for generic circuits.
/// Uses the Poseidon transition constraint evaluation.
fn compute_quotient_at_position_generic(
    lde: &[Vec<BaseElement>],
    pos: usize,
    blowup: usize,
    trace_length: usize,
    trace_width: usize,
    num_rounds: usize,
    lde_g: &BaseElement,
) -> u64 {
    // For generic circuits, we compute the Poseidon transition constraint
    // over the first 3 columns (all circuits use cols 0-2 for Poseidon state).
    // This is the same structure across all circuits.
    compute_quotient_at_position(lde, pos, blowup, trace_length, trace_width.min(3), num_rounds, lde_g)
}

/// Compute LDE by evaluating trace polynomials at BLOWUP * TRACE_LENGTH points.
/// Uses FFT interpolation + evaluation.
fn compute_lde(trace: &[Vec<BaseElement>]) -> Vec<Vec<BaseElement>> {
    let mut lde = vec![vec![BaseElement::ZERO; LDE_SIZE]; TRACE_WIDTH];

    for col in 0..TRACE_WIDTH {
        // Interpolate: get polynomial coefficients from trace values.
        // Then evaluate at all LDE domain points.
        let poly = interpolate_poly(&trace[col]);
        let g = get_lde_domain_generator();
        for i in 0..LDE_SIZE {
            let x = g.exp(i as u64);
            lde[col][i] = evaluate_poly(&poly, x);
        }
    }

    lde
}

/// Get a primitive LDE_SIZE-th root of unity in the Goldilocks field.
fn get_lde_domain_generator() -> BaseElement {
    // Use the generic domain generator for consistency
    get_domain_generator_generic(LDE_SIZE)
}

/// Lagrange interpolation to get polynomial coefficients from trace values.
/// Input: values at positions g^0, g^1, ..., g^(n-1) where g is n-th root of unity.
fn interpolate_poly(values: &[BaseElement]) -> Vec<BaseElement> {
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
    let blowup_log2 = BLOWUP.trailing_zeros(); // BLOWUP = 16 = 2^4
    for _ in 0..blowup_log2 {
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

// Legacy derive_query_positions removed — replaced by derive_query_positions_with_ood (H9)

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
        assert!(proof_data.proof_bytes.len() < 200_000, "Proof too large");
    }

    #[test]
    fn test_lde_domain_generator() {
        let g = get_lde_domain_generator();
        // g^LDE_SIZE should equal 1 (LDE_SIZE-th root of unity)
        let g_n = g.exp(LDE_SIZE as u64);
        assert_eq!(g_n, BaseElement::ONE, "g^LDE_SIZE should be 1");
        // g^(LDE_SIZE/2) should not be 1 (primitive)
        let g_half = g.exp((LDE_SIZE / 2) as u64);
        assert_ne!(g_half, BaseElement::ONE, "g should be primitive LDE_SIZE-th root");
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
        assert!(proof.proof_bytes.len() < 500_000, "Pool proof too large: {}", proof.proof_bytes.len());
        println!("Pool commitment proof size: {} bytes", proof.proof_bytes.len());
        println!("Public inputs: {:?}", proof.public_inputs);
    }

    #[test]
    fn test_balance_compact_proof() {
        let proof = generate_balance_compact_proof(42, 1000, 777, 999);
        assert!(!proof.proof_bytes.is_empty());
        assert!(proof.proof_bytes.len() < 500_000, "Balance proof too large: {}", proof.proof_bytes.len());
        println!("Balance proof size: {} bytes", proof.proof_bytes.len());
    }

    #[test]
    fn test_merkle_path_compact_proof() {
        let leaf = 42u64;
        let path_elements: Vec<u64> = (0..3).map(|i| 100 + i).collect();
        let path_indices = vec![0u8, 1, 0];
        let proof = generate_merkle_path_compact_proof(leaf, &path_elements, &path_indices);
        assert!(!proof.proof_bytes.is_empty());
        assert!(proof.proof_bytes.len() < 500_000, "Merkle proof too large: {}", proof.proof_bytes.len());
        println!("Merkle path (depth 3) proof size: {} bytes", proof.proof_bytes.len());
    }

    #[test]
    fn test_confidential_balance_compact_proof() {
        let proof = generate_confidential_balance_compact_proof(
            42, 1000, 111, 800, 222, 200, 333, 999,
        );
        assert_eq!(proof.circuit_id, CIRCUIT_CONFIDENTIAL_BALANCE);
        assert_eq!(proof.public_inputs.len(), 4);
        assert!(!proof.proof_bytes.is_empty());
        assert!(proof.proof_bytes.len() < 800_000, "Confidential balance proof too large: {}", proof.proof_bytes.len());
        println!("Confidential balance proof size: {} bytes", proof.proof_bytes.len());
    }

    #[test]
    fn test_transfer_compact_proof() {
        let proof = generate_transfer_compact_proof(
            42,   // spending_key
            999,  // token_mint
            100,  // in_amount_1
            111,  // in_rand_1
            50,   // in_amount_2
            222,  // in_rand_2
            80,   // out_amount_1
            555,  // out_recipient_1
            333,  // out_rand_1
            70,   // out_amount_2
            666,  // out_recipient_2
            444,  // out_rand_2
            0,    // public_amount (balanced: 100+50 = 80+70)
        );
        assert_eq!(proof.circuit_id, CIRCUIT_TRANSFER);
        assert_eq!(proof.public_inputs.len(), 6);
        assert!(!proof.proof_bytes.is_empty());
        assert!(proof.proof_bytes.len() < 1_500_000, "Transfer proof too large: {}", proof.proof_bytes.len());
        println!("Transfer proof size: {} bytes", proof.proof_bytes.len());
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
pub const CIRCUIT_CONFIDENTIAL_BALANCE: u8 = 4;
pub const CIRCUIT_TRANSFER: u8 = 5;

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

/// [H9] Derive query positions using Fiat-Shamir with OOD evaluations in transcript (generic).
fn derive_query_positions_generic(
    root: &[u8; 32],
    pub_input_bytes: &[u8],
    ood_current: &[u64],
    ood_next: &[u64],
    lde_size: usize,
    num_queries: usize,
) -> Vec<usize> {
    // Build full transcript: trace_root || pub_inputs || ood_current || ood_next
    let mut transcript = Vec::new();
    transcript.extend_from_slice(root);
    transcript.extend_from_slice(pub_input_bytes);
    for val in ood_current {
        transcript.extend_from_slice(&val.to_le_bytes());
    }
    for val in ood_next {
        transcript.extend_from_slice(&val.to_le_bytes());
    }
    let query_seed = blake3::hash(&transcript);

    let mut positions = Vec::new();
    let mut counter = 0u32;

    while positions.len() < num_queries {
        let mut input = Vec::with_capacity(32 + 4);
        input.extend_from_slice(query_seed.as_bytes());
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

    // 3. [H10] Derive OOD point from Fiat-Shamir transcript
    let ood_z = derive_ood_point_generic(&root, pub_input_bytes);

    // 4. Compute OOD evaluations by evaluating trace polynomials at ood_z
    let ood_z_felt = BaseElement::new(ood_z);
    let trace_g = get_domain_generator_generic(trace_length);
    let ood_z_next = ood_z_felt * trace_g; // z * g (next row in trace domain)
    let mut ood_current_vals: Vec<u64> = Vec::with_capacity(trace_width);
    let mut ood_next_vals: Vec<u64> = Vec::with_capacity(trace_width);
    for col in 0..trace_width {
        let poly = inverse_ntt(&trace[col], trace_g);
        ood_current_vals.push(evaluate_poly(&poly, ood_z_felt).as_int());
        ood_next_vals.push(evaluate_poly(&poly, ood_z_next).as_int());
    }

    // 5. [H9] Derive query positions with OOD in transcript
    let positions = derive_query_positions_generic(
        &root, pub_input_bytes, &ood_current_vals, &ood_next_vals,
        lde_size, num_queries,
    );

    // 6. Build query proofs
    let mut bytes = Vec::new();

    // Header: trace_root
    bytes.extend_from_slice(&root);

    // OOD evaluations
    for val in &ood_current_vals {
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    for val in &ood_next_vals {
        bytes.extend_from_slice(&val.to_le_bytes());
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

    // 7. [H11] Compute actual quotient polynomial values
    let lde_g = get_domain_generator_generic(lde_size);
    for &pos in &positions {
        let qv = compute_quotient_at_position_generic(
            &lde, pos, blowup, trace_length, trace_width, NUM_ROUNDS, &lde_g,
        );
        bytes.extend_from_slice(&qv.to_le_bytes());
    }

    (bytes, root)
}

// ============================================================================
// Circuit-specific compact proof generators
// ============================================================================

const GENERIC_BLOWUP: usize = 16;
const GENERIC_NUM_QUERIES: usize = 128;

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

/// Generate compact proof for confidential balance update.
///
/// Proves: commitments are correctly formed from private balances, salts, and spending key.
/// Public inputs: old_commitment, new_commitment, amount_hash, token_mint
pub fn generate_confidential_balance_compact_proof(
    spending_key: u64,
    old_balance: u64,
    old_salt: u64,
    new_balance: u64,
    new_salt: u64,
    amount: u64,
    amount_salt: u64,
    token_mint: u64,
) -> GenericCompactProofData {
    let sk = BaseElement::new(spending_key);
    let ob = BaseElement::new(old_balance);
    let os = BaseElement::new(old_salt);
    let nb = BaseElement::new(new_balance);
    let ns = BaseElement::new(new_salt);
    let a = BaseElement::new(amount);
    let as_ = BaseElement::new(amount_salt);
    let mint = BaseElement::new(token_mint);

    let (trace, oc, nc, ah) =
        crate::air::confidential_balance::build_confidential_balance_trace(
            sk, ob, os, nb, ns, a, as_, mint,
        );

    let oc_u64 = oc.as_int();
    let nc_u64 = nc.as_int();
    let ah_u64 = ah.as_int();

    let mut pub_bytes = Vec::new();
    pub_bytes.extend_from_slice(&oc_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&nc_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&ah_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&token_mint.to_le_bytes());

    let (proof_bytes, root) = generate_compact_proof_from_trace(
        &trace, &pub_bytes, GENERIC_BLOWUP, GENERIC_NUM_QUERIES,
    );

    GenericCompactProofData {
        proof_bytes,
        circuit_id: CIRCUIT_CONFIDENTIAL_BALANCE,
        public_inputs: vec![oc_u64, nc_u64, ah_u64, token_mint],
        root,
    }
}

/// Generate compact proof for a 2-in-2-out shielded transfer.
///
/// Proves: nullifiers and output commitments are correctly derived from the spending key,
/// input notes, and output notes.
/// Public inputs: nullifier_1, nullifier_2, output_commitment_1, output_commitment_2, public_amount, token_mint
pub fn generate_transfer_compact_proof(
    spending_key: u64,
    token_mint: u64,
    in_amount_1: u64,
    in_rand_1: u64,
    in_amount_2: u64,
    in_rand_2: u64,
    out_amount_1: u64,
    out_recipient_1: u64,
    out_rand_1: u64,
    out_amount_2: u64,
    out_recipient_2: u64,
    out_rand_2: u64,
    public_amount: u64,
) -> GenericCompactProofData {
    use crate::air::transfer::{TransferInput, TransferOutput, build_transfer_trace};

    let sk = BaseElement::new(spending_key);
    let mint = BaseElement::new(token_mint);
    let input_1 = TransferInput { amount: BaseElement::new(in_amount_1), randomness: BaseElement::new(in_rand_1) };
    let input_2 = TransferInput { amount: BaseElement::new(in_amount_2), randomness: BaseElement::new(in_rand_2) };
    let output_1 = TransferOutput {
        amount: BaseElement::new(out_amount_1),
        recipient: BaseElement::new(out_recipient_1),
        randomness: BaseElement::new(out_rand_1),
    };
    let output_2 = TransferOutput {
        amount: BaseElement::new(out_amount_2),
        recipient: BaseElement::new(out_recipient_2),
        randomness: BaseElement::new(out_rand_2),
    };

    let (trace, n1, n2, _, _, oc1, oc2) =
        build_transfer_trace(sk, mint, &input_1, &input_2, &output_1, &output_2);

    let n1_u64 = n1.as_int();
    let n2_u64 = n2.as_int();
    let oc1_u64 = oc1.as_int();
    let oc2_u64 = oc2.as_int();

    let mut pub_bytes = Vec::new();
    pub_bytes.extend_from_slice(&n1_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&n2_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&oc1_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&oc2_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&public_amount.to_le_bytes());
    pub_bytes.extend_from_slice(&token_mint.to_le_bytes());

    let (proof_bytes, root) = generate_compact_proof_from_trace(
        &trace, &pub_bytes, GENERIC_BLOWUP, GENERIC_NUM_QUERIES,
    );

    GenericCompactProofData {
        proof_bytes,
        circuit_id: CIRCUIT_TRANSFER,
        public_inputs: vec![n1_u64, n2_u64, oc1_u64, oc2_u64, public_amount, token_mint],
        root,
    }
}
