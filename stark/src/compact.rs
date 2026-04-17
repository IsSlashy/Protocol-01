/// Compact STARK proof generator for on-chain verification.
///
/// Converts a winterfell STARK proof into the compact format
/// understood by the p01_stark_verifier on-chain program.
///
/// Hash choice: SHA-256 for Merkle commitments and Fiat-Shamir. The on-chain
/// verifier uses `sol_sha256` (always-active syscall, ~85 CU/call). The
/// alternative `sol_blake3` syscall is behind an inactive feature on
/// devnet/mainnet, which forced software Blake3 (~15k CU/hash) and blew
/// the 1.4M CU cap. `sha2::Sha256` on host matches the syscall output.

use sha2::{Digest, Sha256};
use winterfell::math::fields::f64::BaseElement;
use winterfell::math::FieldElement;

/// Compute SHA-256 of `data`, returning raw 32 bytes — mirrors the output
/// shape of `solana_sha256_hasher::hashv(&[data]).to_bytes()` used on-chain.
#[inline]
fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Goldilocks prime: p = 2^64 - 2^32 + 1
const GOLDILOCKS_PRIME: u64 = 0xFFFFFFFF00000001;

/// Trace parameters matching the on-chain verifier.
const TRACE_WIDTH: usize = 3;
const TRACE_LENGTH: usize = 32;
const BLOWUP: usize = 16;
const LDE_SIZE: usize = TRACE_LENGTH * BLOWUP;
// Soundness: NUM_QUERIES × log2(BLOWUP) + grinding ≈ bits of security.
// 27 × 4 + 16 = 124 bits > 100-bit target. Classical soundness.
// For PQ-96 move to 40 queries + 32-bit grinding.
const NUM_QUERIES: usize = 27;
/// Grinding factor in bits — proof-of-work over Fiat-Shamir seed adds
/// `GRINDING_BITS` to classical soundness without additional queries.
const GRINDING_BITS: u32 = 16;
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

    // 4. [P1.1 PR 4 DEEP-ALI] Compute the quotient LDE via polynomial division.
    //
    // C(x) is the combined transition constraint polynomial. It vanishes on
    // rows 0..n-2 (active + padding except wrap-around), but NOT at row n-1
    // (the wrap `trace[0] - trace[n-1]` does not vanish in general). Hence C
    // is divisible by the *transition* vanishing polynomial
    //   Z_T(x) = (x^n - 1) / (x - trace_g^(n-1))
    // but NOT by Z_D(x) = x^n - 1. Standard STARKs handle this by using Z_T
    // as the divisor for transition constraints.
    //
    // To get Q = C / Z_T we compute (C * (x - trace_g^(n-1))) / (x^n - 1):
    //   (a) evaluate C at all LDE points (C_LDE)
    //   (b) interpolate C_LDE → C_poly via inverse NTT
    //   (c) multiply C_poly by (x - trace_g^(n-1))
    //   (d) polynomial-divide the product by (x^n - 1) → Q_poly
    //   (e) evaluate Q_poly at all LDE points → all_quotient_values
    // Q is a true polynomial of degree ≤ deg(C) - (n-1), so the committed LDE
    // interpolates to Q — required by DEEP-ALI's OOD check.
    let lde_g = get_lde_domain_generator();
    let trace_g = get_trace_domain_generator();
    let last_row_x = trace_g.exp((TRACE_LENGTH - 1) as u64);
    let c_lde: Vec<BaseElement> = (0..LDE_SIZE).map(|pos| {
        let next_pos = (pos + BLOWUP) % LDE_SIZE;
        let current: Vec<BaseElement> = (0..TRACE_WIDTH).map(|col| lde[col][pos]).collect();
        let next: Vec<BaseElement> = (0..TRACE_WIDTH).map(|col| lde[col][next_pos]).collect();
        let x = lde_g.exp(pos as u64);
        evaluate_transition_constraint(&current, &next, x, trace_g, TRACE_LENGTH, NUM_ROUNDS)
    }).collect();
    let c_poly = inverse_ntt(&c_lde, lde_g);
    let c_poly_scaled = multiply_by_x_minus_a(&c_poly, last_row_x);
    let q_poly = divide_by_vanishing(&c_poly_scaled, TRACE_LENGTH);
    let all_quotient_values: Vec<u64> = (0..LDE_SIZE).map(|pos| {
        let x = lde_g.exp(pos as u64);
        evaluate_poly(&q_poly, x).as_int()
    }).collect();
    let (quotient_root, quotient_tree) = build_quotient_merkle_tree(&all_quotient_values);

    // 5. [H10] Derive OOD point from Fiat-Shamir transcript (trace_root || quotient_root || pub_bytes)
    let commitment_bytes = commitment.to_le_bytes();
    let ood_z = derive_ood_point(&root, &quotient_root, &commitment_bytes);

    // 6. Compute OOD evaluations by evaluating trace polynomials at ood_z
    let ood_z_felt = BaseElement::new(ood_z);
    let ood_z_next = ood_z_felt * trace_g; // z * g (next row in trace domain)
    let mut ood_current = [0u64; 3];
    let mut ood_next = [0u64; 3];
    for col in 0..TRACE_WIDTH {
        let poly = interpolate_poly(&trace[col]);
        ood_current[col] = evaluate_poly(&poly, ood_z_felt).as_int();
        ood_next[col] = evaluate_poly(&poly, ood_z_next).as_int();
    }

    // 6b. [P1.1 PR 4 DEEP-ALI] Q(z) = evaluate_poly(q_poly, z). Absorbed into
    // the transcript so Q(z) is fixed before FRI challenges.
    let quotient_felts: Vec<BaseElement> =
        all_quotient_values.iter().map(|&v| BaseElement::new(v)).collect();
    let ood_quotient = evaluate_poly(&q_poly, ood_z_felt).as_int();

    // 7. [P1.1 PR 2] FRI commit phase. Starting transcript contains all prior
    // commitments + OOD evals; fold quotient LDE down to FRI_FINAL_POLY_SIZE,
    // committing Blake3 Merkle roots per intermediate layer. Subsequent
    // challenges (grinding, query positions) depend on these roots so the
    // prover cannot adaptively choose layer values.
    let initial_fri_transcript = build_base_seed(
        &root, &quotient_root, &commitment_bytes, &ood_current, &ood_next, ood_quotient,
    );
    let fri = fri_commit_phase(&quotient_felts, lde_g, &initial_fri_transcript);

    // 8. [H9] Grinding seed extends the FRI transcript with all layer roots
    // and the final poly so grinding binds the entire commitment phase.
    let mut grinding_transcript = initial_fri_transcript;
    for layer_root in &fri.layer_roots {
        grinding_transcript = extend_transcript(&grinding_transcript, layer_root);
    }
    grinding_transcript = extend_transcript_with_final_poly(&grinding_transcript, &fri.final_poly);
    let (grinding_nonce, query_seed) = grind_nonce(&grinding_transcript, GRINDING_BITS);
    let positions = derive_positions_from_seed(&query_seed, LDE_SIZE, NUM_QUERIES);

    // 8. Build query proofs with trace + quotient + FRI Merkle paths
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
        let quotient_merkle_path = get_merkle_proof(&quotient_tree, pos);

        // [P1.1 PR 3] Quotient mirror opening (first FRI fold input `f_0(-y)`).
        let quotient_mirror_pos = pos ^ (LDE_SIZE / 2);
        let quotient_mirror_value = all_quotient_values[quotient_mirror_pos];
        let quotient_mirror_path = get_merkle_proof(&quotient_tree, quotient_mirror_pos);

        // [P1.1 PR 3] Per-FRI-layer openings at (pos, mirror) in each committed layer.
        let fri_openings = extract_fri_query_openings(&fri, pos, LDE_SIZE);

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
            quotient_merkle_path,
            quotient_mirror_value,
            quotient_mirror_path,
            fri_values: fri_openings.values,
            fri_paths: fri_openings.paths,
            fri_mirror_values: fri_openings.mirror_values,
            fri_mirror_paths: fri_openings.mirror_paths,
        });
    }

    // 9. Per-query quotient values (subset of all_quotient_values at query positions)
    let quotient_values: Vec<u64> = positions.iter().map(|&pos| all_quotient_values[pos]).collect();

    // 10. Serialize with new wire format (trace_root || quotient_root || ood || FRI || ...)
    let bytes = serialize_compact_proof(
        &root,
        &quotient_root,
        &ood_current,
        &ood_next,
        ood_z,
        ood_quotient,
        &fri.layer_roots,
        &fri.final_poly,
        grinding_nonce,
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
    /// [P1.1] Merkle path against the quotient LDE commitment.
    quotient_merkle_path: [[u8; 32]; MERKLE_DEPTH],
    /// [P1.1 PR 3] Mirror opening of the quotient LDE at `position XOR (lde_size/2)`.
    /// Needed so the verifier can recompute the first fold `f_1(y²)` from
    /// `(f_0(y), f_0(-y))`, with `f_0 = quotient LDE`.
    quotient_mirror_value: u64,
    quotient_mirror_path: [[u8; 32]; MERKLE_DEPTH],
    /// [P1.1 PR 3] Per-FRI-layer openings. Each entry corresponds to one
    /// committed layer (layer 1..L-1); the final layer is verified via
    /// `final_poly` polynomial evaluation. `fri_values[i]` is f_{i+1} at
    /// `pos mod size_{i+1}`, `fri_mirror_values[i]` at the mirror
    /// `(pos mod size_{i+1}) XOR (size_{i+1}/2)`.
    fri_values: Vec<u64>,
    fri_paths: Vec<Vec<[u8; 32]>>,
    fri_mirror_values: Vec<u64>,
    fri_mirror_paths: Vec<Vec<[u8; 32]>>,
}

/// [H10] Derive OOD evaluation point from Fiat-Shamir transcript.
/// Post-P1.1: binds `quotient_root` alongside `trace_root` so the OOD
/// challenge depends on the quotient commitment — the prover cannot choose
/// quotient values after seeing the challenge.
fn derive_ood_point(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    commitment_bytes: &[u8],
) -> u64 {
    let mut data = Vec::with_capacity(64 + commitment_bytes.len());
    data.extend_from_slice(trace_root);
    data.extend_from_slice(quotient_root);
    data.extend_from_slice(commitment_bytes);
    let hash = sha256(&data);
    let mut ood_z = u64::from_le_bytes(hash[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;
    // Ensure ood_z is not zero (not in any trace domain)
    if ood_z == 0 { ood_z = 1; }
    ood_z
}

/// [H10] Derive OOD evaluation point from Fiat-Shamir transcript (generic version).
fn derive_ood_point_generic(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    pub_input_bytes: &[u8],
) -> u64 {
    derive_ood_point(trace_root, quotient_root, pub_input_bytes)
}

// derive_query_positions_with_ood removed in PR 2 — query positions now derived
// after FRI commit phase folds all layer roots + final_poly into the transcript.

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

/// Multiply `poly` (coefficients low-to-high) by `(x - a)`.
/// Output length = input length + 1.
fn multiply_by_x_minus_a(poly: &[BaseElement], a: BaseElement) -> Vec<BaseElement> {
    let l = poly.len();
    let mut result = vec![BaseElement::ZERO; l + 1];
    for (i, &c) in poly.iter().enumerate() {
        // x * c_i  → coefficient at x^(i+1)
        result[i + 1] = result[i + 1] + c;
        // -a * c_i → coefficient at x^i
        result[i] = result[i] - c * a;
    }
    result
}

/// Divide polynomial `poly` by the vanishing polynomial Z_D(x) = x^n - 1,
/// assuming Z_D divides poly exactly (i.e., poly vanishes on the trace domain).
///
/// Given poly = sum_i c_i x^i of degree L-1, we compute q = poly / (x^n - 1)
/// which has degree L-1-n. Synthetic-division recurrence:
///   q_{L-1-n} = c_{L-1}
///   q_{i-n} = c_i + q_{i}   for i in (n..L-1)
/// When poly is an exact multiple of (x^n - 1), the residual low-degree
/// coefficients are zero; we drop them.
fn divide_by_vanishing(poly: &[BaseElement], n: usize) -> Vec<BaseElement> {
    let l = poly.len();
    assert!(l >= n, "polynomial must have at least degree n for division by x^n - 1");
    let mut c = poly.to_vec();
    let mut q = vec![BaseElement::ZERO; l - n];
    for i in (n..l).rev() {
        q[i - n] = c[i];
        c[i - n] = c[i - n] + c[i];
    }
    q
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

/// Build a SHA-256 Merkle tree from LDE columns.
/// Returns (root, tree_layers).
fn build_merkle_tree(lde: &[Vec<BaseElement>]) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    // Compute leaf hashes (one per LDE row)
    let leaves: Vec<[u8; 32]> = (0..LDE_SIZE)
        .map(|i| {
            let mut data = [0u8; TRACE_WIDTH * 8];
            for col in 0..TRACE_WIDTH {
                data[col * 8..(col + 1) * 8].copy_from_slice(&lde[col][i].as_int().to_le_bytes());
            }
            sha256(&data)
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
                sha256(&data)
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
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    ood_current: &[u64; 3],
    ood_next: &[u64; 3],
    ood_z: u64,
    ood_quotient: u64,
    fri_layer_roots: &[[u8; 32]],
    fri_final_poly: &[u64],
    grinding_nonce: u64,
    queries: &[CompactQuery],
    quotient_values: &[u64],
) -> Vec<u8> {
    let mut bytes = Vec::new();

    // trace_root: 32 bytes
    bytes.extend_from_slice(trace_root);

    // [P1.1] quotient_root: 32 bytes
    bytes.extend_from_slice(quotient_root);

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

    // [P1.1 PR 4 DEEP-ALI] ood_quotient: 8 bytes
    bytes.extend_from_slice(&ood_quotient.to_le_bytes());

    // [P1.1 PR 2] num_fri_layers: 1 byte
    bytes.push(fri_layer_roots.len() as u8);

    // [P1.1 PR 2] fri_layer_roots: num_fri_layers * 32 bytes
    for root in fri_layer_roots {
        bytes.extend_from_slice(root);
    }

    // [P1.1 PR 2] fri_final_poly_size: 2 bytes
    bytes.extend_from_slice(&(fri_final_poly.len() as u16).to_le_bytes());

    // [P1.1 PR 2] fri_final_poly coefficients: fri_final_poly_size * 8 bytes
    for coeff in fri_final_poly {
        bytes.extend_from_slice(&coeff.to_le_bytes());
    }

    // grinding_nonce: 8 bytes — proves PoW for GRINDING_BITS leading zeros
    bytes.extend_from_slice(&grinding_nonce.to_le_bytes());

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
        // [P1.1] quotient_merkle_path: md * 32 bytes
        for path in &q.quotient_merkle_path {
            bytes.extend_from_slice(path);
        }
        // [P1.1 PR 3] quotient mirror opening: value(8) + path(md * 32)
        bytes.extend_from_slice(&q.quotient_mirror_value.to_le_bytes());
        for node in &q.quotient_mirror_path {
            bytes.extend_from_slice(node);
        }
        // [P1.1 PR 3] per-FRI-layer openings.
        // For each committed layer i (0-indexed in fri_values), layer depth is
        // (log2(lde_size) - i - 1). Paths are written with that depth.
        for i in 0..q.fri_values.len() {
            bytes.extend_from_slice(&q.fri_values[i].to_le_bytes());
            for node in &q.fri_paths[i] {
                bytes.extend_from_slice(node);
            }
            bytes.extend_from_slice(&q.fri_mirror_values[i].to_le_bytes());
            for node in &q.fri_mirror_paths[i] {
                bytes.extend_from_slice(node);
            }
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

    /// [P1.1] Verify prover byte layout matches the on-chain verifier's
    /// `GenericCompactProof::from_bytes` parser for each circuit.
    ///
    /// Layout: trace_root(32) | quotient_root(32) | ood_current(tw*8) |
    ///   ood_next(tw*8) | ood_z(8) | ood_quotient(8) |
    ///   num_fri_layers(1) | fri_layer_roots(L_commit*32) |
    ///   fri_final_poly_size(2) | fri_final_poly(FINAL*8) |
    ///   grinding_nonce(8) | num_queries(2) |
    ///   per query [ position(4) | trace_values(tw*8) | next_trace_values(tw*8) |
    ///     merkle_path(md*32) | next_merkle_path(md*32) | quotient_merkle_path(md*32) |
    ///     quotient_mirror_value(8) | quotient_mirror_path(md*32) |
    ///     for each committed FRI layer i:
    ///       fri_value(8) | fri_path(depth_i*32) |
    ///       fri_mirror_value(8) | fri_mirror_path(depth_i*32)
    ///   ] |
    ///   quotient_values(num_queries*8)
    ///
    /// PR 3: `L_commit = L - 1` where `L = log2(lde_size/FRI_FINAL_POLY_SIZE)`;
    /// the final fold lands on `final_poly` (coefficients), not a Merkle commit.
    /// Layer i (0-indexed) has depth `md - i - 1` (size `lde_size / 2^(i+1)`).
    /// PR 4: 8 extra bytes for `ood_quotient` (Q(z)) right after `ood_z`.
    fn expected_wire_size(tw: usize, md: usize, num_queries: usize, lde_size: usize) -> usize {
        let num_folds = (lde_size / FRI_FINAL_POLY_SIZE).trailing_zeros() as usize;
        let num_fri_commits = num_folds - 1;
        // Per-query FRI layer byte footprint: 2 * (value + depth_i * 32) summed over committed layers.
        let fri_per_query: usize = (0..num_fri_commits)
            .map(|i| 2 * (8 + (md - i - 1) * 32))
            .sum();
        32 + 32
            + tw * 8 + tw * 8 + 8 + 8  // PR 4: +8 for ood_quotient
            + 1 + num_fri_commits * 32
            + 2 + FRI_FINAL_POLY_SIZE * 8
            + 8 + 2
            + num_queries * (
                4 + tw * 8 + tw * 8
                + md * 32 + md * 32 + md * 32
                + 8 + md * 32
                + fri_per_query
            )
            + num_queries * 8
    }

    /// [P1.1 PR 2] Fold a known low-degree polynomial and verify the result is
    /// also the LDE of a low-degree polynomial. Specifically, if `f(x) = a + b·x`
    /// then `fold(f)(y²) = a + α·b` — a constant polynomial. So after one fold
    /// of a degree-1 poly, all folded values should be equal.
    #[test]
    fn test_fri_fold_degree_1_becomes_constant() {
        let n = 32_usize;
        let domain_gen = get_domain_generator_generic(n);
        let a = BaseElement::new(7);
        let b = BaseElement::new(13);

        // Evaluate f(x) = a + b*x on the domain
        let mut values = Vec::with_capacity(n);
        let mut x = BaseElement::ONE;
        for _ in 0..n {
            values.push(a + b * x);
            x = x * domain_gen;
        }

        let alpha = BaseElement::new(42);
        let folded = fri_fold_layer(&values, domain_gen, alpha);

        assert_eq!(folded.len(), n / 2);
        // All folded values must equal: (a + α·b)
        let expected = a + alpha * b;
        for (i, &v) in folded.iter().enumerate() {
            assert_eq!(v, expected, "fold mismatch at i={}", i);
        }
    }

    /// [P1.1 PR 2/3] Verify `fri_commit_phase` produces the expected number of
    /// layers/alphas given LDE_SIZE and FRI_FINAL_POLY_SIZE. PR 3 drops the
    /// last fold's Merkle commit: `layer_roots` has L-1 entries while `alphas`
    /// has L entries (one per fold).
    #[test]
    fn test_fri_commit_layer_count_matches_domain_shrink() {
        let n = 512_usize;
        let domain_gen = get_domain_generator_generic(n);
        let values: Vec<BaseElement> = (0..n).map(|i| BaseElement::new(i as u64 + 1)).collect();

        let transcript = [7u8; 32];
        let fri = fri_commit_phase(&values, domain_gen, &transcript);

        // Starting at 512, folding to 16: 512→256→128→64→32→16 → 5 folds.
        let expected_folds = (n / FRI_FINAL_POLY_SIZE).trailing_zeros() as usize;
        let expected_commits = expected_folds - 1;
        assert_eq!(fri.layer_roots.len(), expected_commits);
        assert_eq!(fri.layer_trees.len(), expected_commits);
        assert_eq!(fri.layer_values.len(), expected_commits);
        assert_eq!(fri.alphas.len(), expected_folds);
        assert_eq!(fri.final_poly.len(), FRI_FINAL_POLY_SIZE);
    }

    /// [P1.1 PR 2] `fri_commit_phase` must be deterministic for identical
    /// inputs — fold challenges come from the transcript, which is a pure
    /// function of prior state.
    #[test]
    fn test_fri_commit_deterministic() {
        let n = 64_usize;
        let gen = get_domain_generator_generic(n);
        let values: Vec<BaseElement> = (0..n).map(|i| BaseElement::new((i * 3 + 1) as u64)).collect();
        let transcript = [1u8; 32];

        let a = fri_commit_phase(&values, gen, &transcript);
        let b = fri_commit_phase(&values, gen, &transcript);

        assert_eq!(a.layer_roots, b.layer_roots);
        assert_eq!(a.final_poly, b.final_poly);
    }

    #[test]
    fn test_wire_size_legacy_circuit_0() {
        // Circuit 0: tw=3, md=9 (LDE=512), num_queries=27
        let proof = generate_compact_proof(42);
        assert_eq!(
            proof.proof_bytes.len(),
            expected_wire_size(3, 9, 27, 512),
            "legacy wire size drift",
        );
    }

    #[test]
    fn test_wire_size_pool_commitment_circuit_1() {
        // Circuit 1: tw=3, trace=128, blowup=16, md=11 (LDE=2048), num_queries=27
        let proof = generate_pool_commitment_proof(111, 222, 333, 444);
        assert_eq!(
            proof.proof_bytes.len(),
            expected_wire_size(3, 11, 27, 2048),
            "pool_commitment wire size drift",
        );
    }

    #[test]
    fn test_wire_size_confidential_balance_circuit_4() {
        // Circuit 4: tw=4, trace=256, blowup=16, md=12 (LDE=4096), num_queries=27
        let proof = generate_confidential_balance_compact_proof(
            42, 1000, 111, 800, 222, 200, 333, 999,
        );
        assert_eq!(
            proof.proof_bytes.len(),
            expected_wire_size(4, 12, 27, 4096),
            "confidential_balance wire size drift",
        );
    }

    #[test]
    fn test_wire_size_transfer_circuit_5() {
        // Circuit 5: tw=6, trace=512, blowup=16, md=13 (LDE=8192), num_queries=27
        let proof = generate_transfer_compact_proof(
            42, 999, 100, 111, 50, 222, 80, 555, 333, 70, 666, 444, 0,
        );
        assert_eq!(
            proof.proof_bytes.len(),
            expected_wire_size(6, 13, 27, 8192),
            "transfer wire size drift",
        );
    }

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
        let leaf_hash = sha256(&leaf_data);

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
            current = sha256(&pair);
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

    /// [P1.1 PR 4] Sanity check: re-emitting coefficients via inverse_ntt matches
    /// the coefficients hardcoded in `p01_stark_verifier/src/periodic_consts.rs`.
    /// If this test ever fails, the on-chain verifier will reject honest proofs.
    #[test]
    fn circuit_0_periodic_coeffs_match_verifier_constants() {
        let rc = &crate::poseidon::constants::ROUND_CONSTANTS_T3;
        let mut rc0_vals = vec![BaseElement::ZERO; TRACE_LENGTH];
        let mut rc1_vals = vec![BaseElement::ZERO; TRACE_LENGTH];
        let mut rc2_vals = vec![BaseElement::ZERO; TRACE_LENGTH];
        let mut flag_vals = vec![BaseElement::ZERO; TRACE_LENGTH];
        for round in 0..NUM_ROUNDS {
            rc0_vals[round] = rc[round * 3];
            rc1_vals[round] = rc[round * 3 + 1];
            rc2_vals[round] = rc[round * 3 + 2];
            flag_vals[round] = BaseElement::ONE;
        }
        let g = get_trace_domain_generator();
        let rc0_poly: Vec<u64> = inverse_ntt(&rc0_vals, g).iter().map(|f| f.as_int()).collect();
        let rc1_poly: Vec<u64> = inverse_ntt(&rc1_vals, g).iter().map(|f| f.as_int()).collect();
        let rc2_poly: Vec<u64> = inverse_ntt(&rc2_vals, g).iter().map(|f| f.as_int()).collect();
        let flag_poly: Vec<u64> = inverse_ntt(&flag_vals, g).iter().map(|f| f.as_int()).collect();

        // These must match `programs/p01_stark_verifier/src/periodic_consts.rs`.
        assert_eq!(rc0_poly[0], 0xC1A9FC17AFE6859A);
        assert_eq!(rc0_poly[31], 0x76E166B8B72665A8);
        assert_eq!(rc1_poly[0], 0x8ADEDD292D895B59);
        assert_eq!(rc2_poly[0], 0xAC5D8A4EEAC6C386);
        assert_eq!(flag_poly[0], 0x0FFFFFFFF0000001);
        assert_eq!(flag_poly[31], 0xFFFFFFFE80002001);
    }

    /// [P1.1 PR 4] Sanity test: when running the same transition constraint
    /// evaluation at an OOD point `z`, the result must equal `Q(z) * Z_T(z)`
    /// where `Q` is the interpolated quotient polynomial and
    /// `Z_T(x) = (x^n - 1) / (x - trace_g^(n-1))` is the transition vanishing
    /// polynomial (omitting the last row so the wrap `trace[0]-trace[n-1]`
    /// isn't required to vanish). This confirms the verifier's DEEP-ALI
    /// identity holds on the prover's own math.
    ///
    /// Quotient LDE is built via (C_LDE → inverse NTT → multiply by
    /// (x - trace_g^(n-1)) → divide_by_vanishing → evaluate), matching
    /// `generate_compact_proof`.
    #[test]
    fn deep_ali_identity_holds_at_ood_circuit_0() {
        let secret = BaseElement::new(42);
        let trace = crate::air::subscriber_ownership::build_trace(secret);
        let lde = compute_lde(&trace);
        let lde_g = get_lde_domain_generator();
        let trace_g = get_trace_domain_generator();
        let last_row_x = trace_g.exp((TRACE_LENGTH - 1) as u64);

        // Build C_LDE, interpolate, multiply by (x - trace_g^(n-1)), divide by
        // (x^n - 1) to get Q_poly = C / Z_T, then evaluate on the LDE.
        let c_lde: Vec<BaseElement> = (0..LDE_SIZE).map(|pos| {
            let next_pos = (pos + BLOWUP) % LDE_SIZE;
            let current: Vec<BaseElement> = (0..TRACE_WIDTH).map(|col| lde[col][pos]).collect();
            let next: Vec<BaseElement> = (0..TRACE_WIDTH).map(|col| lde[col][next_pos]).collect();
            let x = lde_g.exp(pos as u64);
            evaluate_transition_constraint(&current, &next, x, trace_g, TRACE_LENGTH, NUM_ROUNDS)
        }).collect();
        let c_poly = inverse_ntt(&c_lde, lde_g);
        let c_poly_scaled = multiply_by_x_minus_a(&c_poly, last_row_x);
        let q_poly_ref = divide_by_vanishing(&c_poly_scaled, TRACE_LENGTH);
        let all_q: Vec<u64> = (0..LDE_SIZE).map(|pos| {
            let x = lde_g.exp(pos as u64);
            evaluate_poly(&q_poly_ref, x).as_int()
        }).collect();

        // Pick an OOD point (avoid 0 and domain roots).
        let z = BaseElement::new(0xDEADBEEF_CAFEBABEu64);
        let z_next = z * trace_g;

        // OOD trace evaluations via inverse NTT + evaluate.
        let ood_current: Vec<BaseElement> = (0..TRACE_WIDTH)
            .map(|col| evaluate_poly(&interpolate_poly(&trace[col]), z))
            .collect();
        let ood_next: Vec<BaseElement> = (0..TRACE_WIDTH)
            .map(|col| evaluate_poly(&interpolate_poly(&trace[col]), z_next))
            .collect();

        let c_at_z = evaluate_transition_constraint(
            &ood_current, &ood_next, z, trace_g, TRACE_LENGTH, NUM_ROUNDS,
        );

        // Q(z) via inverse NTT of LDE quotient.
        let q_felts: Vec<BaseElement> = all_q.iter().map(|&v| BaseElement::new(v)).collect();
        let q_poly = inverse_ntt(&q_felts, lde_g);
        let q_at_z = evaluate_poly(&q_poly, z);
        // Z_T(z) = (z^n - 1) / (z - trace_g^(n-1))
        let z_d = z.exp(TRACE_LENGTH as u64) - BaseElement::ONE;
        let z_t = z_d * (z - last_row_x).inv();

        assert_eq!(c_at_z, q_at_z * z_t, "DEEP-ALI identity failed at OOD");
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

/// Build a SHA-256 Merkle tree from LDE columns (any width).
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
            sha256(&data)
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
                sha256(&data)
            })
            .collect();
        layers.push(next);
    }

    let root = layers.last().unwrap()[0];
    (root, layers)
}

/// [P1.1] Build a single-column SHA-256 Merkle tree over quotient values.
/// Leaf at position `i` = `sha256(quotient_values[i].to_le_bytes())`.
/// This matches the verifier's merkle::verify_merkle_path which takes raw
/// leaf_bytes and applies SHA-256 internally.
fn build_quotient_merkle_tree(quotient_values: &[u64]) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    let leaves: Vec<[u8; 32]> = quotient_values
        .iter()
        .map(|v| sha256(&v.to_le_bytes()))
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
                sha256(&data)
            })
            .collect();
        layers.push(next);
    }

    let root = layers.last().unwrap()[0];
    (root, layers)
}

// ============================================================================
// [P1.1 PR 2] FRI commit phase
// ============================================================================

/// Target size of the FRI final polynomial (coefficients). Lower = tighter
/// degree bound but more folding layers. 16 is standard for STARK soundness.
pub(crate) const FRI_FINAL_POLY_SIZE: usize = 16;

pub(crate) struct FriCommitData {
    /// Merkle roots for layers 1..=L-1 (layer 0 is committed via `quotient_root`;
    /// the final layer L is sent as `final_poly` coefficients so its fold check
    /// uses polynomial evaluation in place of a Merkle open).
    pub layer_roots: Vec<[u8; 32]>,
    /// Merkle trees for layers 1..=L-1 (used to extract per-query paths).
    pub layer_trees: Vec<Vec<Vec<[u8; 32]>>>,
    /// Evaluations for layers 1..=L-1 (used to extract values at query positions).
    pub layer_values: Vec<Vec<BaseElement>>,
    /// Fold challenges α_0..α_{L-1} derived from the transcript.
    pub alphas: Vec<BaseElement>,
    /// Final polynomial as coefficients (degree < FRI_FINAL_POLY_SIZE).
    pub final_poly: Vec<u64>,
}

/// Derive a single Goldilocks fold challenge from a 32-byte transcript state.
fn derive_fri_alpha(transcript: &[u8; 32]) -> BaseElement {
    let hash = sha256(transcript);
    let mut alpha = u64::from_le_bytes(hash[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;
    if alpha == 0 { alpha = 1; }
    BaseElement::new(alpha)
}

/// Extend a transcript state by absorbing one additional 32-byte blob.
fn extend_transcript(state: &[u8; 32], blob: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(32 + blob.len());
    buf.extend_from_slice(state);
    buf.extend_from_slice(blob);
    sha256(&buf)
}

/// Extend transcript with the raw bytes of a u64 final-poly coefficient vector.
fn extend_transcript_with_final_poly(state: &[u8; 32], final_poly: &[u64]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(32 + final_poly.len() * 8);
    buf.extend_from_slice(state);
    for coeff in final_poly {
        buf.extend_from_slice(&coeff.to_le_bytes());
    }
    sha256(&buf)
}

/// One FRI fold step over a radix-2 layer.
/// For y = domain_gen^i and -y = domain_gen^(i + N/2):
///   f_{i+1}(y²) = (f(y) + f(-y))/2 + α · (f(y) - f(-y))/(2y)
///
/// Precondition: `values.len()` is even. Returns folded values of half length.
fn fri_fold_layer(
    values: &[BaseElement],
    domain_gen: BaseElement,
    alpha: BaseElement,
) -> Vec<BaseElement> {
    let n = values.len();
    let half = n / 2;
    let two_inv = BaseElement::new(2).exp(((GOLDILOCKS_PRIME - 2) as u64).into());
    let inv_gen = domain_gen.exp(((GOLDILOCKS_PRIME - 2) as u64).into());

    let mut result = Vec::with_capacity(half);
    let mut inv_y = BaseElement::ONE; // y⁻¹ at i=0 is 1 (since y = gen⁰ = 1)
    for i in 0..half {
        let f_y = values[i];
        let f_neg_y = values[i + half];

        let even = (f_y + f_neg_y) * two_inv;
        let odd = (f_y - f_neg_y) * two_inv * inv_y;

        result.push(even + alpha * odd);

        inv_y = inv_y * inv_gen;
    }
    result
}

/// [P1.1 PR 2] Run the FRI commit phase starting from `initial_values` which
/// evaluate over a domain generated by `initial_domain_gen`. Folds until the
/// domain shrinks to `FRI_FINAL_POLY_SIZE`, committing each intermediate layer
/// with Blake3 and extending the transcript after each commitment so that
/// subsequent fold challenges depend on prior roots.
///
/// Layer 0 is assumed pre-committed (via `quotient_root` in our case); this
/// function starts by deriving α_0 from `initial_transcript`.
pub(crate) fn fri_commit_phase(
    initial_values: &[BaseElement],
    initial_domain_gen: BaseElement,
    initial_transcript: &[u8; 32],
) -> FriCommitData {
    let mut current = initial_values.to_vec();
    let mut current_gen = initial_domain_gen;
    let mut transcript = *initial_transcript;

    let mut layer_roots: Vec<[u8; 32]> = Vec::new();
    let mut layer_trees: Vec<Vec<Vec<[u8; 32]>>> = Vec::new();
    let mut layer_values: Vec<Vec<BaseElement>> = Vec::new();
    let mut alphas: Vec<BaseElement> = Vec::new();

    while current.len() > FRI_FINAL_POLY_SIZE {
        // α_i derived from current transcript BEFORE the fold happens.
        let alpha = derive_fri_alpha(&transcript);
        alphas.push(alpha);

        // Fold: domain halves, new generator is gen².
        let folded = fri_fold_layer(&current, current_gen, alpha);
        let folded_gen = current_gen * current_gen;

        // Only commit if this is NOT the final fold — the final folded layer
        // reaches FRI_FINAL_POLY_SIZE and is transmitted as polynomial
        // coefficients (`final_poly`), so PR 3 verifies the last fold by
        // polynomial evaluation rather than Merkle opening.
        if folded.len() > FRI_FINAL_POLY_SIZE {
            let folded_u64: Vec<u64> = folded.iter().map(|f| f.as_int()).collect();
            let (root, tree) = build_quotient_merkle_tree(&folded_u64);
            layer_roots.push(root);
            layer_trees.push(tree);
            layer_values.push(folded.clone());

            // Extend transcript with the new layer root; next α depends on it.
            transcript = extend_transcript(&transcript, &root);
        }

        current = folded;
        current_gen = folded_gen;
    }

    // Remaining `current` has exactly FRI_FINAL_POLY_SIZE evaluations.
    // Interpolate back to coefficients so the verifier can evaluate at
    // arbitrary points when checking the last fold's consistency.
    let final_poly_felts = inverse_ntt(&current, current_gen);
    let final_poly: Vec<u64> = final_poly_felts.iter().map(|f| f.as_int()).collect();

    FriCommitData {
        layer_roots,
        layer_trees,
        layer_values,
        alphas,
        final_poly,
    }
}

/// [P1.1 PR 3] Per-query FRI opening data. Contains, for each committed FRI
/// layer, two Merkle openings: one at the position reached by reducing the
/// original LDE query position into that layer's domain, and one at its
/// mirror (`pos XOR size/2`). The fold identity
/// `f_{i+1}(y²) = (f_i(y)+f_i(-y))/2 + α_i · (f_i(y)-f_i(-y))/(2y)`
/// lets the verifier recompute each fold step from these openings.
pub(crate) struct FriQueryOpenings {
    pub values: Vec<u64>,
    pub paths: Vec<Vec<[u8; 32]>>,
    pub mirror_values: Vec<u64>,
    pub mirror_paths: Vec<Vec<[u8; 32]>>,
}

/// [P1.1 PR 3] Extract per-query FRI openings from the commit phase data.
///
/// For each committed layer `i` (0-indexed; layer_roots[i] commits f_{i+1}
/// of size `lde_size / 2^(i+1)`), open the value at `pos mod size_{i+1}` and
/// its mirror `(pos mod size_{i+1}) XOR (size_{i+1}/2)` with the appropriate
/// depth Merkle path.
pub(crate) fn extract_fri_query_openings(
    fri: &FriCommitData,
    query_pos: usize,
    lde_size: usize,
) -> FriQueryOpenings {
    let mut values = Vec::with_capacity(fri.layer_roots.len());
    let mut paths = Vec::with_capacity(fri.layer_roots.len());
    let mut mirror_values = Vec::with_capacity(fri.layer_roots.len());
    let mut mirror_paths = Vec::with_capacity(fri.layer_roots.len());

    for (i, layer) in fri.layer_values.iter().enumerate() {
        let size = layer.len();
        debug_assert_eq!(size, lde_size / (1 << (i + 1)));
        let pos_in_layer = query_pos & (size - 1);
        let mirror = pos_in_layer ^ (size / 2);
        let depth = (size as f64).log2() as usize;

        values.push(layer[pos_in_layer].as_int());
        paths.push(get_merkle_proof_generic(&fri.layer_trees[i], pos_in_layer, depth));
        mirror_values.push(layer[mirror].as_int());
        mirror_paths.push(get_merkle_proof_generic(&fri.layer_trees[i], mirror, depth));
    }

    FriQueryOpenings { values, paths, mirror_values, mirror_paths }
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

/// Build the Fiat-Shamir base seed from trace_root + quotient_root + public
/// inputs + OOD evaluations. Post-P1.1: `quotient_root` must precede OOD and
/// query-position derivation so the prover commits the quotient LDE BEFORE
/// receiving challenges. Post-PR 4: absorbs `ood_quotient` (Q(z)) so the
/// prover's claim at the OOD point is fixed before FRI commitments.
fn build_base_seed(
    trace_root: &[u8; 32],
    quotient_root: &[u8; 32],
    pub_input_bytes: &[u8],
    ood_current: &[u64],
    ood_next: &[u64],
    ood_quotient: u64,
) -> [u8; 32] {
    let mut transcript = Vec::new();
    transcript.extend_from_slice(trace_root);
    transcript.extend_from_slice(quotient_root);
    transcript.extend_from_slice(pub_input_bytes);
    for val in ood_current {
        transcript.extend_from_slice(&val.to_le_bytes());
    }
    for val in ood_next {
        transcript.extend_from_slice(&val.to_le_bytes());
    }
    transcript.extend_from_slice(&ood_quotient.to_le_bytes());
    sha256(&transcript)
}

/// Count leading zero bits of a 32-byte hash (big-endian interpretation).
fn leading_zero_bits(bytes: &[u8; 32]) -> u32 {
    let mut count = 0u32;
    for &b in bytes.iter() {
        if b == 0 {
            count += 8;
        } else {
            count += b.leading_zeros();
            break;
        }
    }
    count
}

/// Grind a PoW nonce so `sha256(base_seed || nonce_le)` has `grinding_bits` leading zero bits.
/// Returns (nonce, query_seed).
fn grind_nonce(base_seed: &[u8; 32], grinding_bits: u32) -> (u64, [u8; 32]) {
    let mut nonce: u64 = 0;
    loop {
        let mut input = [0u8; 32 + 8];
        input[..32].copy_from_slice(base_seed);
        input[32..].copy_from_slice(&nonce.to_le_bytes());
        let h = sha256(&input);
        if leading_zero_bits(&h) >= grinding_bits {
            return (nonce, h);
        }
        nonce = nonce.wrapping_add(1);
    }
}

/// Derive query positions deterministically from a seed.
fn derive_positions_from_seed(
    query_seed: &[u8; 32],
    lde_size: usize,
    num_queries: usize,
) -> Vec<usize> {
    let mut positions = Vec::new();
    let mut counter = 0u32;

    while positions.len() < num_queries {
        let mut input = Vec::with_capacity(32 + 4);
        input.extend_from_slice(query_seed);
        input.extend_from_slice(&counter.to_le_bytes());

        let hash = sha256(&input);
        let bytes = &hash[..];

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

// derive_query_positions_generic removed in PR 2 — grinding seed now extends
// build_base_seed with FRI layer_roots + final_poly so query positions bind the
// full FRI commit phase.

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

    // 2. Build trace Merkle tree
    let (root, tree) = build_merkle_tree_generic(&lde, trace_width);

    // 3. [P1.1] Compute quotient values at ALL LDE positions + commit.
    // quotient_root is folded into the Fiat-Shamir transcript BEFORE OOD/query
    // derivation so the prover cannot choose values after seeing challenges.
    let lde_g = get_domain_generator_generic(lde_size);
    let all_quotient_values: Vec<u64> = (0..lde_size).map(|pos| {
        compute_quotient_at_position_generic(
            &lde, pos, blowup, trace_length, trace_width, NUM_ROUNDS, &lde_g,
        )
    }).collect();
    let (quotient_root, quotient_tree) = build_quotient_merkle_tree(&all_quotient_values);

    // 4. [H10] Derive OOD point from transcript (trace_root || quotient_root || pub_bytes)
    let ood_z = derive_ood_point_generic(&root, &quotient_root, pub_input_bytes);

    // 5. Compute OOD evaluations by evaluating trace polynomials at ood_z
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

    // 5b. [P1.1 PR 4 DEEP-ALI] Evaluate Q(z) by interpolating the quotient LDE
    // and evaluating at the OOD point. Absorbed into the transcript so Q(z)
    // is fixed before FRI commitments.
    let quotient_felts: Vec<BaseElement> =
        all_quotient_values.iter().map(|&v| BaseElement::new(v)).collect();
    let ood_quotient = {
        let q_poly = inverse_ntt(&quotient_felts, lde_g);
        evaluate_poly(&q_poly, ood_z_felt).as_int()
    };

    // 6. [P1.1 PR 2] FRI commit phase over the quotient LDE.
    let initial_fri_transcript = build_base_seed(
        &root, &quotient_root, pub_input_bytes, &ood_current_vals, &ood_next_vals, ood_quotient,
    );
    let fri = fri_commit_phase(&quotient_felts, lde_g, &initial_fri_transcript);

    // 7. [H9] Grinding seed binds trace + quotient + OOD + all FRI layers + final poly
    let mut grinding_transcript = initial_fri_transcript;
    for layer_root in &fri.layer_roots {
        grinding_transcript = extend_transcript(&grinding_transcript, layer_root);
    }
    grinding_transcript = extend_transcript_with_final_poly(&grinding_transcript, &fri.final_poly);
    let (grinding_nonce, query_seed) = grind_nonce(&grinding_transcript, GRINDING_BITS);
    let positions = derive_positions_from_seed(&query_seed, lde_size, num_queries);

    // 8. Serialize with new wire format (trace_root || quotient_root || ood || FRI commit || ...)
    let mut bytes = Vec::new();

    // Header: trace_root || quotient_root
    bytes.extend_from_slice(&root);
    bytes.extend_from_slice(&quotient_root);

    // OOD evaluations
    for val in &ood_current_vals {
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    for val in &ood_next_vals {
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    bytes.extend_from_slice(&ood_z.to_le_bytes());

    // [P1.1 PR 4 DEEP-ALI] ood_quotient (Q(z)): 8 bytes
    bytes.extend_from_slice(&ood_quotient.to_le_bytes());

    // [P1.1 PR 2] FRI commit phase serialization
    bytes.push(fri.layer_roots.len() as u8);
    for layer_root in &fri.layer_roots {
        bytes.extend_from_slice(layer_root);
    }
    bytes.extend_from_slice(&(fri.final_poly.len() as u16).to_le_bytes());
    for coeff in &fri.final_poly {
        bytes.extend_from_slice(&coeff.to_le_bytes());
    }

    // Grinding nonce (8 bytes) — proves PoW work for GRINDING_BITS.
    bytes.extend_from_slice(&grinding_nonce.to_le_bytes());

    // Num queries
    bytes.extend_from_slice(&(num_queries as u16).to_le_bytes());

    // Queries — include trace, next_trace, quotient, and FRI Merkle paths
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

        // trace Merkle path at pos
        let path = get_merkle_proof_generic(&tree, pos, merkle_depth);
        for node in &path {
            bytes.extend_from_slice(node);
        }
        // trace Merkle path at next_pos
        let next_path = get_merkle_proof_generic(&tree, next_pos, merkle_depth);
        for node in &next_path {
            bytes.extend_from_slice(node);
        }
        // [P1.1] quotient Merkle path at pos
        let q_path = get_merkle_proof_generic(&quotient_tree, pos, merkle_depth);
        for node in &q_path {
            bytes.extend_from_slice(node);
        }
        // [P1.1 PR 3] quotient mirror opening (value + path)
        let quotient_mirror_pos = pos ^ (lde_size / 2);
        bytes.extend_from_slice(&all_quotient_values[quotient_mirror_pos].to_le_bytes());
        let q_mirror_path = get_merkle_proof_generic(&quotient_tree, quotient_mirror_pos, merkle_depth);
        for node in &q_mirror_path {
            bytes.extend_from_slice(node);
        }
        // [P1.1 PR 3] FRI layer openings (value + path for pos and mirror at each committed layer)
        let fri_openings = extract_fri_query_openings(&fri, pos, lde_size);
        for i in 0..fri_openings.values.len() {
            bytes.extend_from_slice(&fri_openings.values[i].to_le_bytes());
            for node in &fri_openings.paths[i] {
                bytes.extend_from_slice(node);
            }
            bytes.extend_from_slice(&fri_openings.mirror_values[i].to_le_bytes());
            for node in &fri_openings.mirror_paths[i] {
                bytes.extend_from_slice(node);
            }
        }
    }

    // Per-query quotient values (subset of all_quotient_values at query positions)
    for &pos in &positions {
        bytes.extend_from_slice(&all_quotient_values[pos].to_le_bytes());
    }

    (bytes, root)
}

// ============================================================================
// Circuit-specific compact proof generators
// ============================================================================

const GENERIC_BLOWUP: usize = 16;
const GENERIC_NUM_QUERIES: usize = 27;

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
