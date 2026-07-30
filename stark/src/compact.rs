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

/// Domain-separation tag prefixed to every Merkle LEAF preimage.
///
/// Must match `p01_stark_verifier::merkle::MERKLE_LEAF_TAG` byte for byte. If
/// prover and verifier ever disagree here, EVERY honest proof fails the Merkle
/// check — the safe direction, and one the harness catches immediately, but it
/// is still a hard break, so the two constants are a paired edit.
///
/// Rationale lives in the verifier's `merkle.rs`: untagged,
/// `leaf = SHA256(preimage)` and `node = SHA256(l ‖ r)` are the same function,
/// so a genuine internal node can be replayed as a leaf whose preimage is that
/// node's own two children.
pub const MERKLE_LEAF_TAG: u8 = 0x00;

/// Domain-separation tag prefixed to every Merkle INTERNAL-NODE preimage.
/// Must match `p01_stark_verifier::merkle::MERKLE_NODE_TAG`.
///
/// `pub` only so the verifier's integration tests can assert the two crates
/// still agree; nothing outside this module builds trees.
pub const MERKLE_NODE_TAG: u8 = 0x01;

/// Hash a Merkle leaf preimage: `SHA256(0x00 ‖ data)`.
///
/// Every leaf of every tree this prover builds goes through here. A partially
/// tagged tree is worse than an untagged one, because it looks done.
#[inline]
fn sha256_leaf(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([MERKLE_LEAF_TAG]);
    h.update(data);
    h.finalize().into()
}

/// Hash a Merkle internal node: `SHA256(0x01 ‖ left ‖ right)`.
#[inline]
fn sha256_node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([MERKLE_NODE_TAG]);
    h.update(left);
    h.update(right);
    h.finalize().into()
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
    generate_compact_proof_with_pair_indexing(subscriber_secret, PairIndexing::Canonical)
}

/// [B4 fails-closed probe] `generate_compact_proof` with the pair-leaf layout
/// selectable. Only `PairIndexing::Canonical` matches the on-chain verifier;
/// the other variants produce a complete, internally consistent proof under a
/// *different* pair indexing, which the verifier must reject. Test-only —
/// nothing in production calls this with a non-canonical mode.
#[doc(hidden)]
pub fn generate_compact_proof_with_pair_indexing(
    subscriber_secret: u64,
    pair_indexing: PairIndexing,
) -> CompactProofData {
    generate_compact_proof_with_layout(subscriber_secret, pair_indexing, TraceLeaf::Canonical)
}

/// [ROUTE C fails-closed probe] `generate_compact_proof` with the TRACE
/// commitment layout selectable.
///
/// This is the C0 half of the version-skew seam, and it is the highest-
/// consequence half: C0 has its own parser (`CompactStarkProof`), its own
/// verifier entry point (`verify_subscriber_ownership`), and four SHIPPED
/// instructions hard-require `circuit_id == 0`
/// (`zk_shielded::{pause,resume,cancel_private_stark}` and
/// `p01_quantum_wallet/src/stark.rs:42`). `TraceLeaf::LegacyRowLeaf` builds a
/// complete, internally consistent PRE-Route-C C0 proof — row-leaf tree, two
/// rows per query, two depth-`MERKLE_DEPTH` paths — so a test can assert the
/// Route C verifier rejects it rather than mis-verifying it.
///
/// Test-only. Every production entry point passes `TraceLeaf::Canonical`.
#[doc(hidden)]
pub fn generate_compact_proof_with_trace_leaf(
    subscriber_secret: u64,
    trace_leaf: TraceLeaf,
) -> CompactProofData {
    generate_compact_proof_with_layout(subscriber_secret, PairIndexing::Canonical, trace_leaf)
}

fn generate_compact_proof_with_layout(
    subscriber_secret: u64,
    pair_indexing: PairIndexing,
    trace_leaf: TraceLeaf,
) -> CompactProofData {
    let secret = BaseElement::new(subscriber_secret);

    // 1. Build execution trace (32 rows × 3 columns)
    let trace = crate::air::subscriber_ownership::build_trace(secret);
    let commitment = trace[0][NUM_ROUNDS].as_int();

    // 2. Compute LDE: evaluate trace polynomial at LDE_SIZE points
    let lde = compute_lde(&trace);

    // 3. [ROUTE C] Build the Merkle tree over PAIR leaves of LDE rows
    //    (`leaf[j] = H(row[j] ‖ row[j + LDE_SIZE/2])`, LDE_SIZE/2 leaves).
    //    The legacy C0 path keeps its own generator — four shipped instructions
    //    hard-require `circuit_id == 0` and the generic path cannot verify C0
    //    proofs — but the trace COMMITMENT is now the same shape on both paths.
    //    `LegacyRowLeaf` rebuilds the pre-Route-C row-leaf tree; test-only.
    let (root, tree) = match trace_leaf {
        TraceLeaf::Canonical => build_trace_pair_merkle_tree(&lde, TRACE_WIDTH),
        TraceLeaf::LegacyRowLeaf => build_merkle_tree_generic(&lde, TRACE_WIDTH),
    };

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
    let mut q_poly = divide_by_vanishing(&c_poly_scaled, TRACE_LENGTH);

    // [C2] Fold the boundary quotient into the committed quotient so the
    // public-input binding (commitment at row 30, capacity zeros at row 0) is
    // enforced at the OOD point on EVERY proof — not just when a query lands on
    // a trace-aligned row. The verifier recomputes the matching boundary term
    // at z via `verify_boundary_at_ood_circuit_0`. Trace interpolants are
    // reused below for the OOD evaluation.
    let trace_polys: Vec<Vec<BaseElement>> =
        (0..TRACE_WIDTH).map(|col| interpolate_poly(&trace[col])).collect();
    let boundary_assertions =
        boundary_assertions_for_circuit(CIRCUIT_SUBSCRIBER_OWNERSHIP, &[commitment]);
    let alpha_bnd =
        derive_rlc_alpha_with_tag(&root, &commitment.to_le_bytes(), b"bnd-c0\0\0");
    fold_boundary_quotient(&mut q_poly, &trace_polys, &boundary_assertions, trace_g, alpha_bnd);

    let all_quotient_values: Vec<u64> = (0..LDE_SIZE).map(|pos| {
        let x = lde_g.exp(pos as u64);
        evaluate_poly(&q_poly, x).as_int()
    }).collect();
    let (quotient_root, quotient_tree) =
        build_pair_merkle_tree(&all_quotient_values, pair_indexing.quotient());

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
    let fri = fri_commit_phase(
        &quotient_felts,
        lde_g,
        &initial_fri_transcript,
        FRI_FINAL_POLY_SIZE,
        pair_indexing,
    );

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

        // [ROUTE C] Pair-leaf trace tree: ONE depth-(MERKLE_DEPTH-1) opening at
        // pair index `pos mod (LDE_SIZE/2)` authenticates both `row(pos)` and
        // `row(pos ^ LDE_SIZE/2)`; likewise for `next_pos`.
        let t_half = LDE_SIZE / 2;
        let mirror_pos = pos ^ t_half;
        let next_mirror_pos = next_pos ^ t_half;

        let trace_values = [
            lde[0][pos], lde[1][pos], lde[2][pos],
        ];
        let trace_mirror_values = [
            lde[0][mirror_pos], lde[1][mirror_pos], lde[2][mirror_pos],
        ];
        let next_trace_values = [
            lde[0][next_pos], lde[1][next_pos], lde[2][next_pos],
        ];
        let next_trace_mirror_values = [
            lde[0][next_mirror_pos], lde[1][next_mirror_pos], lde[2][next_mirror_pos],
        ];

        // [ROUTE C] Canonical: pair index `pos mod half` into the pair tree,
        // depth `MERKLE_DEPTH - 1`. LegacyRowLeaf: row index `pos` into the row
        // tree, depth `MERKLE_DEPTH`.
        let (trace_index, next_trace_index, trace_path_depth) = match trace_leaf {
            TraceLeaf::Canonical => {
                (pos & (t_half - 1), next_pos & (t_half - 1), MERKLE_DEPTH - 1)
            }
            TraceLeaf::LegacyRowLeaf => (pos, next_pos, MERKLE_DEPTH),
        };
        let merkle_path = get_merkle_proof_generic(&tree, trace_index, trace_path_depth);
        let next_merkle_path =
            get_merkle_proof_generic(&tree, next_trace_index, trace_path_depth);

        // [B4] Quotient pair opening. `pos` and its mirror `pos ^ (LDE_SIZE/2)`
        // live in the SAME pair leaf `j = pos mod (LDE_SIZE/2)`, so ONE
        // depth-(MERKLE_DEPTH-1) path authenticates both `f_0(y)` and `f_0(-y)`.
        // The mirror value still travels on the wire (the verifier needs the
        // second field element; only the redundant path is gone).
        let quotient_mirror_pos = pos ^ (LDE_SIZE / 2);
        let quotient_mirror_value = all_quotient_values[quotient_mirror_pos];
        let quotient_pair_j = pos & (LDE_SIZE / 2 - 1);
        let quotient_pair_path = get_merkle_proof_pair(
            &quotient_tree,
            pair_slot(quotient_pair_j, LDE_SIZE / 2, pair_indexing.quotient()),
        );

        // [B4] One pair opening per committed FRI layer.
        let fri_openings = extract_fri_query_openings(&fri, pos, LDE_SIZE, pair_indexing);

        queries.push(CompactQuery {
            position: pos as u32,
            trace_values: [
                trace_values[0].as_int(),
                trace_values[1].as_int(),
                trace_values[2].as_int(),
            ],
            trace_mirror_values: [
                trace_mirror_values[0].as_int(),
                trace_mirror_values[1].as_int(),
                trace_mirror_values[2].as_int(),
            ],
            next_trace_values: [
                next_trace_values[0].as_int(),
                next_trace_values[1].as_int(),
                next_trace_values[2].as_int(),
            ],
            next_trace_mirror_values: [
                next_trace_mirror_values[0].as_int(),
                next_trace_mirror_values[1].as_int(),
                next_trace_mirror_values[2].as_int(),
            ],
            merkle_path,
            next_merkle_path,
            quotient_mirror_value,
            quotient_pair_path,
            fri_lo_values: fri_openings.lo_values,
            fri_hi_values: fri_openings.hi_values,
            fri_pair_paths: fri_openings.pair_paths,
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
        trace_leaf,
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
    /// [ROUTE C] Trace row at `position ^ (LDE_SIZE/2)` — the second half of the
    /// pair leaf that `merkle_path` already authenticates. Unread by the current
    /// verifier; it is the `T_i(-x)` a later DEEP composition needs.
    trace_mirror_values: [u64; 3],
    next_trace_values: [u64; 3],
    /// [ROUTE C] Trace row at `next_pos ^ (LDE_SIZE/2)`.
    next_trace_mirror_values: [u64; 3],
    /// [ROUTE C] Path into the trace PAIR tree, depth `MERKLE_DEPTH - 1`.
    ///
    /// `Vec` rather than `[[u8; 32]; MERKLE_DEPTH - 1]` because
    /// `TraceLeaf::LegacyRowLeaf` needs the pre-Route-C depth `MERKLE_DEPTH`.
    /// Only a test ever asks for that; the length is asserted per variant in
    /// `serialize_compact_proof` so a wrong-depth path cannot reach the wire.
    merkle_path: Vec<[u8; 32]>,
    next_merkle_path: Vec<[u8; 32]>,
    /// [P1.1 PR 3] Mirror opening of the quotient LDE at `position XOR (lde_size/2)`.
    /// Needed so the verifier can recompute the first fold `f_1(y²)` from
    /// `(f_0(y), f_0(-y))`, with `f_0 = quotient LDE`.
    quotient_mirror_value: u64,
    /// [B4] ONE path into the quotient pair tree, depth `MERKLE_DEPTH - 1`.
    /// Authenticates the leaf `H(q[j] ‖ q[j + LDE_SIZE/2])`, i.e. both the
    /// value at `position` and the value at its mirror. Replaces the pre-B4
    /// `quotient_merkle_path` + `quotient_mirror_path` pair.
    quotient_pair_path: [[u8; 32]; MERKLE_DEPTH - 1],
    /// [B4] Per-FRI-layer pair openings. Each entry corresponds to one
    /// committed layer (layer 1..L-1); the final layer is verified via
    /// `final_poly` polynomial evaluation. `fri_lo_values[i]` is `f_{i+1}[j]`,
    /// `fri_hi_values[i]` is `f_{i+1}[j + size_{i+1}/2]`, with
    /// `j = pos mod (size_{i+1}/2)`, and `fri_pair_paths[i]` authenticates both.
    fri_lo_values: Vec<u64>,
    fri_hi_values: Vec<u64>,
    fri_pair_paths: Vec<Vec<[u8; 32]>>,
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

/// [P2.2a] Compute the DEEP-ALI quotient LDE for circuit 6 (merkle_update).
///
/// Produces a length-`lde_size` vector of Q(x) values where
///     Q(x) = [C(x) · (x − g^(n−1))] / (x^n − 1)
/// and C(x) = Σ_i α^i · C_i(x) is the RLC of all 19 circuit-6 transition
/// constraints evaluated via periodic columns. The `(x − g^(n−1))` factor
/// kills the wrap-around row so synthetic division by the full vanishing
/// polynomial `x^n − 1` is exact (equivalent to dividing C by the
/// transition-vanishing Z_T(x) = (x^n − 1)/(x − g^(n−1))).
///
/// The verifier recovers α from `trace_root || pub_inputs` via
/// `derive_rlc_alpha` and recomputes C(z) at the OOD point with the same
/// RLC, then checks C(z) == Q(z) · Z_T(z) using Q(z) from the proof.
///
/// `periodic` layout matches `build_merkle_update_periodic_columns`:
/// `[rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]`.
fn compute_quotient_lde_circuit_6(
    trace_lde: &[Vec<BaseElement>],
    blowup: usize,
    trace_length: usize,
    depth: usize,
    alpha: BaseElement,
) -> Vec<u64> {
    use crate::air::merkle_update::{
        build_merkle_update_periodic_columns, evaluate_merkle_update_transition,
        MERKLE_UPDATE_NUM_CONSTRAINTS, MERKLE_UPDATE_NUM_PERIODIC,
    };

    let trace_width = trace_lde.len();
    assert_eq!(trace_width, 10, "circuit 6 trace width is 10");
    let lde_size = trace_length * blowup;
    assert_eq!(trace_lde[0].len(), lde_size);

    let trace_g = get_domain_generator_generic(trace_length);
    let lde_g = get_domain_generator_generic(lde_size);

    // 1. Periodic columns are length-n; interpolate each to a polynomial via
    //    inverse NTT on the trace domain, then evaluate on the LDE domain so
    //    per-position constraint eval can use a single scalar per column.
    let periodic_trace = build_merkle_update_periodic_columns(depth, trace_length);
    assert_eq!(periodic_trace.len(), MERKLE_UPDATE_NUM_PERIODIC);

    let mut periodic_lde: Vec<Vec<BaseElement>> =
        vec![vec![BaseElement::ZERO; lde_size]; MERKLE_UPDATE_NUM_PERIODIC];
    for (k, col) in periodic_trace.iter().enumerate() {
        let poly = inverse_ntt(col, trace_g);
        for i in 0..lde_size {
            let x = lde_g.exp(i as u64);
            periodic_lde[k][i] = evaluate_poly(&poly, x);
        }
    }

    // 2. Evaluate the 19 constraints at every LDE position and combine via
    //    the RLC challenge α. `next_pos = pos + blowup (mod lde_size)`
    //    reflects the row-wise transition in the LDE domain — if x = lde_g^p
    //    then x · trace_g = lde_g^p · lde_g^blowup = lde_g^(p+blowup).
    let mut c_lde = vec![BaseElement::ZERO; lde_size];
    let mut constraints = vec![BaseElement::ZERO; MERKLE_UPDATE_NUM_CONSTRAINTS];
    let mut current = vec![BaseElement::ZERO; trace_width];
    let mut next = vec![BaseElement::ZERO; trace_width];
    let mut periodic_row = vec![BaseElement::ZERO; MERKLE_UPDATE_NUM_PERIODIC];

    for pos in 0..lde_size {
        let next_pos = (pos + blowup) % lde_size;
        for col in 0..trace_width {
            current[col] = trace_lde[col][pos];
            next[col] = trace_lde[col][next_pos];
        }
        for k in 0..MERKLE_UPDATE_NUM_PERIODIC {
            periodic_row[k] = periodic_lde[k][pos];
        }
        evaluate_merkle_update_transition(&current, &next, &periodic_row, &mut constraints);
        c_lde[pos] = rlc_combine(&constraints, alpha);
    }

    // 3. INTT → coefficients on the LDE domain.
    let c_poly = inverse_ntt(&c_lde, lde_g);

    // 4. Multiply by (x − g^(n−1)) so the product vanishes on the full trace
    //    domain (the base constraint vanishes on rows 0..n−2 only).
    let g_nm1 = trace_g.exp((trace_length - 1) as u64);
    let c_poly_ext = multiply_by_x_minus_a(&c_poly, g_nm1);

    // 5. Synthetic division by Z_D(x) = x^n − 1 (exact, no remainder).
    //    divide_by_vanishing panics if deg < n, which happens only if C ≡ 0
    //    — impossible for a non-trivial proof but worth the assert.
    assert!(c_poly_ext.len() > trace_length);
    let q_poly = divide_by_vanishing(&c_poly_ext, trace_length);

    // 6. Pad Q_poly to lde_size coefficients and evaluate on the LDE via
    //    naive Horner (matches the pattern used by `compute_lde_generic`).
    let mut q_poly_padded = vec![BaseElement::ZERO; lde_size];
    let copy_len = q_poly.len().min(lde_size);
    q_poly_padded[..copy_len].copy_from_slice(&q_poly[..copy_len]);

    let mut q_lde = vec![0u64; lde_size];
    for i in 0..lde_size {
        let x = lde_g.exp(i as u64);
        q_lde[i] = evaluate_poly(&q_poly_padded, x).as_int();
    }
    q_lde
}

/// [P2.2d-C1] Compute the DEEP-ALI quotient LDE for circuit 1 (pool_commitment).
///
/// Same shape as `compute_quotient_lde_circuit_6`: interpolate periodic columns
/// onto the LDE, evaluate all 4 transition constraints at every LDE point,
/// RLC-combine them with α, INTT to coefficients, multiply by (x − g^{n−1}) to
/// kill the wrap row, then synthetic-divide by Z_D(x) = x^n − 1. Equivalent to
/// Q(x) = C(x) / Z_T(x) where Z_T(x) = (x^n − 1) / (x − g^{n−1}) is the
/// transition-vanishing polynomial.
///
/// Closes the P2.2d-C1 soundness gap:
///   1. The single-cycle flag in `evaluate_transition_constraint` meant the
///      legacy generic quotient only enforced Poseidon on cycle 0 (rows 0-30).
///      This function uses `evaluate_pool_commitment_transition` which gates
///      Poseidon with the real 3-cycle `round_flag`.
///   2. The chain constraint `next[1]@row64 = current[0]@row63` was never
///      enforced anywhere on-chain. This function's RLC includes it via
///      `chain_flag[63] = 1`, binding epoch_hash from cycle 1 into cycle 2's
///      right input at the OOD DEEP-ALI check.
///
/// `periodic` layout matches `build_pool_commitment_periodic_columns`:
/// `[rc0, rc1, rc2, round_flag, chain_flag, is_boundary]`.
fn compute_quotient_lde_circuit_1(
    trace_lde: &[Vec<BaseElement>],
    blowup: usize,
    trace_length: usize,
    alpha: BaseElement,
) -> Vec<u64> {
    use crate::air::denominated_pool::{
        build_pool_commitment_periodic_columns, evaluate_pool_commitment_transition,
        POOL_COMMITMENT_NUM_CONSTRAINTS, POOL_COMMITMENT_NUM_PERIODIC, TRACE_WIDTH,
    };

    let trace_width = trace_lde.len();
    assert_eq!(trace_width, TRACE_WIDTH, "circuit 1 trace width is 3");
    let lde_size = trace_length * blowup;
    assert_eq!(trace_lde[0].len(), lde_size);

    let trace_g = get_domain_generator_generic(trace_length);
    let lde_g = get_domain_generator_generic(lde_size);

    // 1. Interpolate periodic columns (length-n) and evaluate on the LDE domain.
    let periodic_trace = build_pool_commitment_periodic_columns(trace_length);
    assert_eq!(periodic_trace.len(), POOL_COMMITMENT_NUM_PERIODIC);

    let mut periodic_lde: Vec<Vec<BaseElement>> =
        vec![vec![BaseElement::ZERO; lde_size]; POOL_COMMITMENT_NUM_PERIODIC];
    for (k, col) in periodic_trace.iter().enumerate() {
        let poly = inverse_ntt(col, trace_g);
        for i in 0..lde_size {
            let x = lde_g.exp(i as u64);
            periodic_lde[k][i] = evaluate_poly(&poly, x);
        }
    }

    // 2. Evaluate the 4 constraints at every LDE position and RLC-combine with α.
    let mut c_lde = vec![BaseElement::ZERO; lde_size];
    let mut constraints = vec![BaseElement::ZERO; POOL_COMMITMENT_NUM_CONSTRAINTS];
    let mut current = vec![BaseElement::ZERO; trace_width];
    let mut next = vec![BaseElement::ZERO; trace_width];
    let mut periodic_row = vec![BaseElement::ZERO; POOL_COMMITMENT_NUM_PERIODIC];

    for pos in 0..lde_size {
        let next_pos = (pos + blowup) % lde_size;
        for col in 0..trace_width {
            current[col] = trace_lde[col][pos];
            next[col] = trace_lde[col][next_pos];
        }
        for k in 0..POOL_COMMITMENT_NUM_PERIODIC {
            periodic_row[k] = periodic_lde[k][pos];
        }
        evaluate_pool_commitment_transition(&current, &next, &periodic_row, &mut constraints);
        c_lde[pos] = rlc_combine(&constraints, alpha);
    }

    // 3. INTT → coefficients on the LDE domain.
    let c_poly = inverse_ntt(&c_lde, lde_g);

    // 4. Multiply by (x − g^{n−1}) to kill the wrap row.
    let g_nm1 = trace_g.exp((trace_length - 1) as u64);
    let c_poly_ext = multiply_by_x_minus_a(&c_poly, g_nm1);

    // 5. Synthetic-divide by x^n − 1 (exact, no remainder).
    assert!(c_poly_ext.len() > trace_length);
    let q_poly = divide_by_vanishing(&c_poly_ext, trace_length);

    // 6. Pad to lde_size and evaluate on LDE.
    let mut q_poly_padded = vec![BaseElement::ZERO; lde_size];
    let copy_len = q_poly.len().min(lde_size);
    q_poly_padded[..copy_len].copy_from_slice(&q_poly[..copy_len]);

    let mut q_lde = vec![0u64; lde_size];
    for i in 0..lde_size {
        let x = lde_g.exp(i as u64);
        q_lde[i] = evaluate_poly(&q_poly_padded, x).as_int();
    }
    q_lde
}

/// [P2.2d-C2] Compute the RLC-combined quotient LDE for circuit 2 (balance_proof).
///
/// Mirrors `compute_quotient_lde_circuit_1` byte-for-byte except it pulls in
/// the 8 periodic columns and 7 transition constraints from
/// `crate::air::balance_proof`. Divides by `Z_T(x) = (x^n - 1)/(x - g^{n-1})`
/// via `multiply_by_x_minus_a + divide_by_vanishing` so the wrap row is
/// exempted from the transition-vanishing polynomial.
///
/// Closes the P2.2d-C2 soundness gaps:
///   1. **Multi-cycle Poseidon.** Legacy `evaluate_transition_constraint` had a
///      single-cycle flag (cycle 0 only); cycles 1-3 were unconstrained. This
///      path uses `build_balance_proof_periodic_columns` with the real 4-cycle
///      `round_flag`.
///   2. **chain_01 @ row 31.** `next[0]@32 = current[0]@31` (= owner) was never
///      checked on-chain; a malicious prover could rewrite the cycle 1 left
///      input. Now bound in the RLC.
///   3. **carry_capture @ row 63.** `next[3]@64 = current[0]@63` (= owner_mint)
///      was not checked either — attacker could pick an arbitrary owner_mint'.
///      Now bound.
///   4. **carry_continuity.** col[3] must be constant except at row 63. Was
///      partially checked per-query but not at non-trace-aligned positions.
///   5. **chain_carry @ row 95.** `next[1]@96 = current[3]@95` (cycle 3 right
///      input = owner_mint) was never checked. Now bound.
///
/// `periodic` layout matches `build_balance_proof_periodic_columns`:
/// `[rc0, rc1, rc2, round_flag, chain_01, carry_capture, chain_carry, is_boundary]`.
fn compute_quotient_lde_circuit_2(
    trace_lde: &[Vec<BaseElement>],
    blowup: usize,
    trace_length: usize,
    alpha: BaseElement,
) -> Vec<u64> {
    use crate::air::balance_proof::{
        build_balance_proof_periodic_columns, evaluate_balance_proof_transition,
        BALANCE_PROOF_NUM_CONSTRAINTS, BALANCE_PROOF_NUM_PERIODIC, TRACE_WIDTH,
    };

    let trace_width = trace_lde.len();
    assert_eq!(trace_width, TRACE_WIDTH, "circuit 2 trace width is 4");
    let lde_size = trace_length * blowup;
    assert_eq!(trace_lde[0].len(), lde_size);

    let trace_g = get_domain_generator_generic(trace_length);
    let lde_g = get_domain_generator_generic(lde_size);

    // 1. Interpolate periodic columns (length-n) and evaluate on the LDE domain.
    let periodic_trace = build_balance_proof_periodic_columns(trace_length);
    assert_eq!(periodic_trace.len(), BALANCE_PROOF_NUM_PERIODIC);

    let mut periodic_lde: Vec<Vec<BaseElement>> =
        vec![vec![BaseElement::ZERO; lde_size]; BALANCE_PROOF_NUM_PERIODIC];
    for (k, col) in periodic_trace.iter().enumerate() {
        let poly = inverse_ntt(col, trace_g);
        for i in 0..lde_size {
            let x = lde_g.exp(i as u64);
            periodic_lde[k][i] = evaluate_poly(&poly, x);
        }
    }

    // 2. Evaluate the 7 constraints at every LDE position and RLC-combine with α.
    let mut c_lde = vec![BaseElement::ZERO; lde_size];
    let mut constraints = vec![BaseElement::ZERO; BALANCE_PROOF_NUM_CONSTRAINTS];
    let mut current = vec![BaseElement::ZERO; trace_width];
    let mut next = vec![BaseElement::ZERO; trace_width];
    let mut periodic_row = vec![BaseElement::ZERO; BALANCE_PROOF_NUM_PERIODIC];

    for pos in 0..lde_size {
        let next_pos = (pos + blowup) % lde_size;
        for col in 0..trace_width {
            current[col] = trace_lde[col][pos];
            next[col] = trace_lde[col][next_pos];
        }
        for k in 0..BALANCE_PROOF_NUM_PERIODIC {
            periodic_row[k] = periodic_lde[k][pos];
        }
        evaluate_balance_proof_transition(&current, &next, &periodic_row, &mut constraints);
        c_lde[pos] = rlc_combine(&constraints, alpha);
    }

    // 3. INTT → coefficients on the LDE domain.
    let c_poly = inverse_ntt(&c_lde, lde_g);

    // 4. Multiply by (x − g^{n−1}) to kill the wrap row.
    let g_nm1 = trace_g.exp((trace_length - 1) as u64);
    let c_poly_ext = multiply_by_x_minus_a(&c_poly, g_nm1);

    // 5. Synthetic-divide by x^n − 1 (exact, no remainder).
    assert!(c_poly_ext.len() > trace_length);
    let q_poly = divide_by_vanishing(&c_poly_ext, trace_length);

    // 6. Pad to lde_size and evaluate on LDE.
    let mut q_poly_padded = vec![BaseElement::ZERO; lde_size];
    let copy_len = q_poly.len().min(lde_size);
    q_poly_padded[..copy_len].copy_from_slice(&q_poly[..copy_len]);

    let mut q_lde = vec![0u64; lde_size];
    for i in 0..lde_size {
        let x = lde_g.exp(i as u64);
        q_lde[i] = evaluate_poly(&q_poly_padded, x).as_int();
    }
    q_lde
}

/// [P2.2d-C3] Compute the RLC-combined quotient LDE for circuit 3 (merkle_path).
///
/// Same shape as `compute_quotient_lde_circuit_6`: variable-depth periodic columns,
/// interpolated onto the LDE, 11 transition constraints evaluated at every LDE
/// position, RLC-combined with α, INTT → coefficients, multiply by
/// (x − g^{n−1}) to kill the wrap row, synthetic-divide by Z_D(x) = x^n − 1.
///
/// Closes the P2.2d-C3 soundness gaps:
///   1. **Multi-cycle Poseidon.** Legacy `evaluate_transition_constraint` had a
///      single-cycle flag (cycle 0 only); cycles 1-14 (depth 15) were
///      unconstrained. This path uses `build_merkle_path_periodic_columns`
///      with the real 15-cycle `round_active` flag spanning all hash cycles.
///   2. **Hash-start mux.** `s0 = carry + direction * (sibling - carry)` and
///      `s1 = sibling - direction * (sibling - carry)` at every cycle start
///      (rows 0, 32, 64, ...) were never checked on-chain. A malicious prover
///      could load arbitrary left/right inputs per level. Now bound.
///   3. **Capacity at hash start.** `s2 = 0` at every cycle start was not
///      enforced outside row 0 — prover could inject state. Now bound.
///   4. **Carry update at boundary.** `next[5] = current[0]` at row 31 (end of
///      cycle 0) — propagates hash output as next level's carry. Never
///      enforced. Now bound by `is_boundary` flag.
///   5. **Carry continuity between boundaries.** `next[5] = current[5]` except
///      at cycle boundaries — prover could rewrite carry mid-cycle. Now bound.
///   6. **Sibling/direction continuity.** `next[3] = current[3]` and
///      `next[4] = current[4]` inside a cycle (rows 1-31). Prover could
///      change the path element mid-hash. Now bound by `is_interior` flag.
///   7. **Direction binary.** `direction * (1 - direction) = 0` at every
///      hash start. Legacy form only checked at row 0. Now bound at every
///      cycle start.
///
/// `periodic` layout matches `build_merkle_path_periodic_columns`:
/// `[rc0, rc1, rc2, round_active, hash_start, is_boundary, is_interior]`.
fn compute_quotient_lde_circuit_3(
    trace_lde: &[Vec<BaseElement>],
    blowup: usize,
    trace_length: usize,
    depth: usize,
    alpha: BaseElement,
) -> Vec<u64> {
    use crate::air::merkle_path::{
        build_merkle_path_periodic_columns, evaluate_merkle_path_transition,
        MERKLE_PATH_NUM_CONSTRAINTS, MERKLE_PATH_NUM_PERIODIC, TRACE_WIDTH,
    };

    let trace_width = trace_lde.len();
    assert_eq!(trace_width, TRACE_WIDTH, "circuit 3 trace width is 6");
    let lde_size = trace_length * blowup;
    assert_eq!(trace_lde[0].len(), lde_size);

    let trace_g = get_domain_generator_generic(trace_length);
    let lde_g = get_domain_generator_generic(lde_size);

    // 1. Interpolate periodic columns (length-n) and evaluate on the LDE domain.
    let periodic_trace = build_merkle_path_periodic_columns(depth, trace_length);
    assert_eq!(periodic_trace.len(), MERKLE_PATH_NUM_PERIODIC);

    let mut periodic_lde: Vec<Vec<BaseElement>> =
        vec![vec![BaseElement::ZERO; lde_size]; MERKLE_PATH_NUM_PERIODIC];
    for (k, col) in periodic_trace.iter().enumerate() {
        let poly = inverse_ntt(col, trace_g);
        for i in 0..lde_size {
            let x = lde_g.exp(i as u64);
            periodic_lde[k][i] = evaluate_poly(&poly, x);
        }
    }

    // 2. Evaluate the 11 constraints at every LDE position and RLC-combine with α.
    let mut c_lde = vec![BaseElement::ZERO; lde_size];
    let mut constraints = vec![BaseElement::ZERO; MERKLE_PATH_NUM_CONSTRAINTS];
    let mut current = vec![BaseElement::ZERO; trace_width];
    let mut next = vec![BaseElement::ZERO; trace_width];
    let mut periodic_row = vec![BaseElement::ZERO; MERKLE_PATH_NUM_PERIODIC];

    for pos in 0..lde_size {
        let next_pos = (pos + blowup) % lde_size;
        for col in 0..trace_width {
            current[col] = trace_lde[col][pos];
            next[col] = trace_lde[col][next_pos];
        }
        for k in 0..MERKLE_PATH_NUM_PERIODIC {
            periodic_row[k] = periodic_lde[k][pos];
        }
        evaluate_merkle_path_transition(&current, &next, &periodic_row, &mut constraints);
        c_lde[pos] = rlc_combine(&constraints, alpha);
    }

    // 3. INTT → coefficients on the LDE domain.
    let c_poly = inverse_ntt(&c_lde, lde_g);

    // 4. Multiply by (x − g^{n−1}) to kill the wrap row.
    let g_nm1 = trace_g.exp((trace_length - 1) as u64);
    let c_poly_ext = multiply_by_x_minus_a(&c_poly, g_nm1);

    // 5. Synthetic-divide by x^n − 1 (exact, no remainder).
    assert!(c_poly_ext.len() > trace_length);
    let q_poly = divide_by_vanishing(&c_poly_ext, trace_length);

    // 6. Pad to lde_size and evaluate on LDE.
    let mut q_poly_padded = vec![BaseElement::ZERO; lde_size];
    let copy_len = q_poly.len().min(lde_size);
    q_poly_padded[..copy_len].copy_from_slice(&q_poly[..copy_len]);

    let mut q_lde = vec![0u64; lde_size];
    for i in 0..lde_size {
        let x = lde_g.exp(i as u64);
        q_lde[i] = evaluate_poly(&q_poly_padded, x).as_int();
    }
    q_lde
}

/// [P2.2d-C4] Compute the RLC-combined quotient LDE for circuit 4
/// (confidential_balance). Same shape as circuit 1/2: fixed trace_length=256,
/// interpolate the 11 periodic columns onto the LDE, evaluate the 10
/// transition constraints at every LDE position, RLC-combine with α, INTT →
/// coefficients, multiply by (x − g^{n−1}) to kill the wrap row, synthetic-
/// divide by Z_D(x) = x^n − 1.
///
/// Closes the P2.2d-C4 soundness gaps:
///   1. **Multi-cycle Poseidon.** Legacy `evaluate_transition_constraint` used
///      a single-cycle flag (cycle 0 only); cycles 1-7 were unconstrained.
///      This path uses `build_confidential_balance_periodic_columns` with the
///      real 8-cycle `round_flag` spanning every hash cycle (period 32, but
///      materialised across full length 256 so one polynomial suffices).
///   2. **chain_01 @ row 31.** `next[0]@32 = current[0]@31` (= owner) was never
///      checked on-chain. Without it, a malicious prover could rewrite the
///      cycle 1 left input → forge a different `owner_mint`. Now bound.
///   3. **carry_capture @ row 63.** `next[3]@64 = current[0]@63` (= owner_mint)
///      was not checked — attacker could pick arbitrary `owner_mint'`. Bound.
///   4. **carry_continuity.** col[3] must be constant except at row 63.
///      Partially checked per-query (legacy); now bound at all LDE positions.
///   5. **chain_34 @ row 127.** `next[0]@128 = current[0]@127` (= old_bal_salt)
///      was never checked. Prover could forge old_commitment.
///   6. **chain_carry_4 @ row 127.** `next[1]@128 = current[3]@127`
///      (owner_mint → cycle 4 right) never checked.
///   7. **chain_56 @ row 191.** `next[0]@192 = current[0]@191`
///      (= new_bal_salt) never checked. Prover could forge new_commitment.
///   8. **chain_carry_6 @ row 191.** `next[1]@192 = current[3]@191`
///      (owner_mint → cycle 6 right) never checked.
///
/// `periodic` layout matches `build_confidential_balance_periodic_columns`:
/// `[rc0, rc1, rc2, round_flag, is_boundary, chain_01, chain_34, chain_56,
///   carry_capture, chain_carry_4, chain_carry_6]`.
fn compute_quotient_lde_circuit_4(
    trace_lde: &[Vec<BaseElement>],
    blowup: usize,
    trace_length: usize,
    alpha: BaseElement,
) -> Vec<u64> {
    use crate::air::confidential_balance::{
        build_confidential_balance_periodic_columns, evaluate_confidential_balance_transition,
        CONFIDENTIAL_BALANCE_NUM_CONSTRAINTS, CONFIDENTIAL_BALANCE_NUM_PERIODIC, TRACE_WIDTH,
    };

    let trace_width = trace_lde.len();
    assert_eq!(trace_width, TRACE_WIDTH, "circuit 4 trace width is 4");
    let lde_size = trace_length * blowup;
    assert_eq!(trace_lde[0].len(), lde_size);

    let trace_g = get_domain_generator_generic(trace_length);
    let lde_g = get_domain_generator_generic(lde_size);

    // 1. Interpolate periodic columns (length-n) and evaluate on the LDE domain.
    let periodic_trace = build_confidential_balance_periodic_columns();
    assert_eq!(periodic_trace.len(), CONFIDENTIAL_BALANCE_NUM_PERIODIC);

    let mut periodic_lde: Vec<Vec<BaseElement>> =
        vec![vec![BaseElement::ZERO; lde_size]; CONFIDENTIAL_BALANCE_NUM_PERIODIC];
    for (k, col) in periodic_trace.iter().enumerate() {
        let poly = inverse_ntt(col, trace_g);
        for i in 0..lde_size {
            let x = lde_g.exp(i as u64);
            periodic_lde[k][i] = evaluate_poly(&poly, x);
        }
    }

    // 2. Evaluate the 10 constraints at every LDE position and RLC-combine with α.
    let mut c_lde = vec![BaseElement::ZERO; lde_size];
    let mut constraints = vec![BaseElement::ZERO; CONFIDENTIAL_BALANCE_NUM_CONSTRAINTS];
    let mut current = vec![BaseElement::ZERO; trace_width];
    let mut next = vec![BaseElement::ZERO; trace_width];
    let mut periodic_row = vec![BaseElement::ZERO; CONFIDENTIAL_BALANCE_NUM_PERIODIC];

    for pos in 0..lde_size {
        let next_pos = (pos + blowup) % lde_size;
        for col in 0..trace_width {
            current[col] = trace_lde[col][pos];
            next[col] = trace_lde[col][next_pos];
        }
        for k in 0..CONFIDENTIAL_BALANCE_NUM_PERIODIC {
            periodic_row[k] = periodic_lde[k][pos];
        }
        evaluate_confidential_balance_transition(&current, &next, &periodic_row, &mut constraints);
        c_lde[pos] = rlc_combine(&constraints, alpha);
    }

    // 3. INTT → coefficients on the LDE domain.
    let c_poly = inverse_ntt(&c_lde, lde_g);

    // 4. Multiply by (x − g^{n−1}) to kill the wrap row.
    let g_nm1 = trace_g.exp((trace_length - 1) as u64);
    let c_poly_ext = multiply_by_x_minus_a(&c_poly, g_nm1);

    // 5. Synthetic-divide by x^n − 1 (exact, no remainder).
    assert!(c_poly_ext.len() > trace_length);
    let q_poly = divide_by_vanishing(&c_poly_ext, trace_length);

    // 6. Pad to lde_size and evaluate on LDE.
    let mut q_poly_padded = vec![BaseElement::ZERO; lde_size];
    let copy_len = q_poly.len().min(lde_size);
    q_poly_padded[..copy_len].copy_from_slice(&q_poly[..copy_len]);

    let mut q_lde = vec![0u64; lde_size];
    for i in 0..lde_size {
        let x = lde_g.exp(i as u64);
        q_lde[i] = evaluate_poly(&q_poly_padded, x).as_int();
    }
    q_lde
}

/// [P2.2d-C5] Compute the RLC-combined quotient LDE for circuit 5 (transfer).
/// Fixed trace_length=512, width=6, 23 transition constraints, 23 periodic
/// columns. Interpolates each periodic column onto the LDE, evaluates the
/// 23 constraints at every LDE position, RLC-combines with α, INTT →
/// coefficients, multiplies by (x − g^{n−1}) to kill the wrap row, and
/// synthetic-divides by Z_D(x) = x^n − 1.
///
/// Closes the P2.2d-C5 soundness gaps:
///   1. **Multi-cycle Poseidon.** Legacy `evaluate_transition_constraint` used
///      a single-cycle flag; cycles 1-15 were unconstrained. This path uses
///      `build_transfer_periodic_columns` with `round_flag` active across all
///      14 active hash cycles + 2 padding cycles.
///   2. **Direct chain edges (7 constraints).** None of owner→cycle 1,
///      in1_left→cycle 3, in_commit_1→cycle 4, in2_left→cycle 6,
///      in_commit_2→cycle 7, out1_left→cycle 10, out2_left→cycle 13 was
///      bound on-chain. Attacker could forge any intermediate hash.
///   3. **Carry captures (4 constraints).** owner (row 30), owner_mint
///      (row 62), out1_rm (row 286), out2_rm (row 382) capture-into-carry
///      edges unbound → attacker could substitute rogue carried values.
///   4. **Carry continuity (3 constraints).** col 3 (owner), col 4
///      (owner_mint), col 5 (out_rm) continuity unbound at non-capture rows.
///   5. **Carry → right input (6 constraints).** owner_mint→cycles 3/6,
///      owner→cycles 4/7, out1_rm→cycle 10, out2_rm→cycle 13 routing
///      unbound. Attacker could nullify a different note / output.
fn compute_quotient_lde_circuit_5(
    trace_lde: &[Vec<BaseElement>],
    blowup: usize,
    trace_length: usize,
    alpha: BaseElement,
) -> Vec<u64> {
    use crate::air::transfer::{
        build_transfer_periodic_columns, evaluate_transfer_transition,
        TRACE_WIDTH, TRANSFER_NUM_CONSTRAINTS, TRANSFER_NUM_PERIODIC,
    };

    let trace_width = trace_lde.len();
    assert_eq!(trace_width, TRACE_WIDTH, "circuit 5 trace width is 7");
    let lde_size = trace_length * blowup;
    assert_eq!(trace_lde[0].len(), lde_size);

    let trace_g = get_domain_generator_generic(trace_length);
    let lde_g = get_domain_generator_generic(lde_size);

    // 1. Interpolate periodic columns and evaluate on the LDE domain. Winterfell
    // handles period-32 vs period-512 internally for the AIR path; for the
    // compact-proof LDE we materialise every column on the full trace domain
    // first so one polynomial suffices per column.
    let periodic_trace_raw = build_transfer_periodic_columns();
    assert_eq!(periodic_trace_raw.len(), TRANSFER_NUM_PERIODIC);

    let materialise = |col: &Vec<BaseElement>| -> Vec<BaseElement> {
        if col.len() == trace_length {
            col.clone()
        } else {
            // Period-32 columns get tiled across the full trace length.
            let mut full = vec![BaseElement::ZERO; trace_length];
            for i in 0..trace_length {
                full[i] = col[i % col.len()];
            }
            full
        }
    };

    let periodic_trace: Vec<Vec<BaseElement>> =
        periodic_trace_raw.iter().map(materialise).collect();

    let mut periodic_lde: Vec<Vec<BaseElement>> =
        vec![vec![BaseElement::ZERO; lde_size]; TRANSFER_NUM_PERIODIC];
    for (k, col) in periodic_trace.iter().enumerate() {
        let poly = inverse_ntt(col, trace_g);
        for i in 0..lde_size {
            let x = lde_g.exp(i as u64);
            periodic_lde[k][i] = evaluate_poly(&poly, x);
        }
    }

    // 2. Evaluate the 23 constraints at every LDE position and RLC-combine with α.
    let mut c_lde = vec![BaseElement::ZERO; lde_size];
    let mut constraints = vec![BaseElement::ZERO; TRANSFER_NUM_CONSTRAINTS];
    let mut current = vec![BaseElement::ZERO; trace_width];
    let mut next = vec![BaseElement::ZERO; trace_width];
    let mut periodic_row = vec![BaseElement::ZERO; TRANSFER_NUM_PERIODIC];

    for pos in 0..lde_size {
        let next_pos = (pos + blowup) % lde_size;
        for col in 0..trace_width {
            current[col] = trace_lde[col][pos];
            next[col] = trace_lde[col][next_pos];
        }
        for k in 0..TRANSFER_NUM_PERIODIC {
            periodic_row[k] = periodic_lde[k][pos];
        }
        evaluate_transfer_transition(&current, &next, &periodic_row, &mut constraints);
        c_lde[pos] = rlc_combine(&constraints, alpha);
    }

    // 3. INTT → coefficients on the LDE domain.
    let c_poly = inverse_ntt(&c_lde, lde_g);

    // 4. Multiply by (x − g^{n−1}) to kill the wrap row.
    let g_nm1 = trace_g.exp((trace_length - 1) as u64);
    let c_poly_ext = multiply_by_x_minus_a(&c_poly, g_nm1);

    // 5. Synthetic-divide by x^n − 1 (exact, no remainder).
    assert!(c_poly_ext.len() > trace_length);
    let q_poly = divide_by_vanishing(&c_poly_ext, trace_length);

    // 6. Pad to lde_size and evaluate on LDE.
    let mut q_poly_padded = vec![BaseElement::ZERO; lde_size];
    let copy_len = q_poly.len().min(lde_size);
    q_poly_padded[..copy_len].copy_from_slice(&q_poly[..copy_len]);

    let mut q_lde = vec![0u64; lde_size];
    for i in 0..lde_size {
        let x = lde_g.exp(i as u64);
        q_lde[i] = evaluate_poly(&q_poly_padded, x).as_int();
    }
    q_lde
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

/// [C2] Divide polynomial `poly` (coefficients low-to-high) by the linear
/// factor `(x - a)`, assuming `poly(a) == 0` so the division is exact.
///
/// Synthetic (Ruffini) division: for `poly = Σ c_i x^i` of degree L-1, the
/// quotient `q = poly / (x - a)` has degree L-2 and is computed by the
/// recurrence walking from the high coefficient down:
///   q_{L-2} = c_{L-1}
///   q_{i-1} = c_i + a · q_i        (i = L-2 .. 1)
/// The remainder `c_0 + a · q_0` is dropped (zero when `poly(a)=0`).
///
/// Used for the boundary quotient `(T_col(x) - v) / (x - g^r)`, which is an
/// exact polynomial because `T_col(g^r) = v` for an honest trace.
fn divide_by_x_minus_a(poly: &[BaseElement], a: BaseElement) -> Vec<BaseElement> {
    let l = poly.len();
    if l == 0 {
        return Vec::new();
    }
    let mut q = vec![BaseElement::ZERO; l - 1];
    let mut carry = BaseElement::ZERO;
    // Walk from the highest coefficient downward.
    for i in (1..l).rev() {
        let coeff = poly[i] + carry;
        q[i - 1] = coeff;
        carry = coeff * a;
    }
    q
}

/// [C2] Boundary assertions for a circuit, mirroring the on-chain verifier's
/// `get_boundary_assertions` in `programs/p01_stark_verifier/src/verify.rs`.
/// Each tuple is `(col, row, value)`: the trace cell `trace[col]` at trace-row
/// `row` must equal `value`. These bind the public inputs to the trace.
///
/// The prover folds the matching boundary quotient
///   Σ_j alpha_bnd^j · (T_col_j(x) - v_j) / (x - g^{r_j})
/// into the committed quotient (see `fold_boundary_quotient`), and the verifier
/// checks the same sum at the OOD point z. The ordering here is byte-identical
/// to the verifier so the `alpha_bnd^j` powers line up exactly.
fn boundary_assertions_for_circuit(
    circuit_id: u8,
    public_inputs: &[u64],
) -> Vec<(usize, usize, BaseElement)> {
    const HASH_CYCLE_LEN: usize = 32;
    const NUM_ROUNDS_B: usize = 30;
    let pi = |i: usize| -> BaseElement {
        if i < public_inputs.len() { BaseElement::new(public_inputs[i]) } else { BaseElement::ZERO }
    };
    match circuit_id {
        0 => vec![
            (1, 0, BaseElement::ZERO),
            (2, 0, BaseElement::ZERO),
            (0, NUM_ROUNDS_B, pi(0)),
        ],
        1 => vec![
            (0, NUM_ROUNDS_B, pi(0)),
            (0, 2 * HASH_CYCLE_LEN + NUM_ROUNDS_B, pi(1)),
            (2, 0, BaseElement::ZERO),
            (2, HASH_CYCLE_LEN, BaseElement::ZERO),
            (2, 2 * HASH_CYCLE_LEN, BaseElement::ZERO),
            (0, 2 * HASH_CYCLE_LEN, pi(0)),
        ],
        3 => {
            let leaf = pi(0);
            let root = pi(1);
            let depth = if public_inputs.len() > 2 { public_inputs[2] as usize } else { 0 };
            if depth > 0 && depth <= 32 {
                let output_row = (depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS_B;
                vec![(5, 0, leaf), (0, output_row, root)]
            } else {
                vec![(5, 0, leaf)]
            }
        }
        5 => {
            let mut a: Vec<(usize, usize, BaseElement)> = Vec::new();
            for cycle in 0..16usize {
                a.push((2, cycle * HASH_CYCLE_LEN, BaseElement::ZERO));
            }
            a.push((1, 0, BaseElement::ZERO));
            a.push((1, HASH_CYCLE_LEN, pi(5)));
            a.push((1, 8 * HASH_CYCLE_LEN, pi(5)));
            a.push((1, 11 * HASH_CYCLE_LEN, pi(5)));
            a.push((0, 4 * HASH_CYCLE_LEN + NUM_ROUNDS_B, pi(0)));
            a.push((0, 7 * HASH_CYCLE_LEN + NUM_ROUNDS_B, pi(1)));
            a.push((0, 10 * HASH_CYCLE_LEN + NUM_ROUNDS_B, pi(2)));
            a.push((0, 13 * HASH_CYCLE_LEN + NUM_ROUNDS_B, pi(3)));
            // [#2 voie A] Value-conservation accumulator (col 6) boundary.
            // MUST match the AIR's `get_assertions` AND the on-chain verifier's
            // `get_boundary_assertions(5, …)` order exactly (acc@row0 = 0, then
            // acc@row385 = public_amount = pi(4)) so the boundary quotient folded
            // here is the same polynomial the verifier reconstructs at the OOD
            // point. Without these two terms the compact quotient would not bind
            // col 6 at all and the conservation relation would be unenforced
            // on-chain (24 → 26 boundary assertions for circuit 5).
            a.push((6, 0, BaseElement::ZERO));
            a.push((6, 12 * HASH_CYCLE_LEN + 1, pi(4))); // row 385
            a
        }
        6 => {
            let old_leaf = pi(0);
            let new_leaf = pi(1);
            let old_root = pi(2);
            let new_root = pi(3);
            let depth = if public_inputs.len() > 4 { public_inputs[4] as usize } else { 0 };
            if depth > 0 && depth <= 16 {
                let output_row = (depth - 1) * HASH_CYCLE_LEN + NUM_ROUNDS_B;
                vec![
                    (8, 0, old_leaf),
                    (9, 0, new_leaf),
                    (0, output_row, old_root),
                    (3, output_row, new_root),
                ]
            } else {
                vec![(8, 0, old_leaf), (9, 0, new_leaf)]
            }
        }
        _ => Vec::new(),
    }
}

/// [C2] Fold the boundary quotient into `q_poly` (coefficients low-to-high).
///
/// For each boundary assertion `(col, row, v)` with trace-domain generator `g`,
/// compute the boundary quotient polynomial
///   Qb(x) = (T_col(x) - v) / (x - g^{row})
/// (an exact polynomial because `T_col(g^{row}) = v` for an honest trace) and
/// add `alpha_bnd^j · Qb(x)` to `q_poly`. `trace_polys[col]` are the per-column
/// trace interpolants (coefficients low-to-high, length = trace_length).
///
/// The verifier recomputes the same sum at the OOD point z via
/// `C_bnd(z) = Z_T(z) · Σ_j alpha_bnd^j · (ood_current[col_j] - v_j) / (z - g^{r_j})`,
/// so the committed quotient must include exactly this boundary contribution.
fn fold_boundary_quotient(
    q_poly: &mut Vec<BaseElement>,
    trace_polys: &[Vec<BaseElement>],
    assertions: &[(usize, usize, BaseElement)],
    trace_g: BaseElement,
    alpha_bnd: BaseElement,
) {
    let mut alpha_pow = BaseElement::ONE;
    for &(col, row, v) in assertions {
        // numerator = T_col(x) - v
        let mut num = trace_polys[col].clone();
        if num.is_empty() {
            num.push(BaseElement::ZERO);
        }
        num[0] = num[0] - v;
        let g_r = trace_g.exp(row as u64);
        let qb = divide_by_x_minus_a(&num, g_r);
        // q_poly += alpha_pow * qb
        if q_poly.len() < qb.len() {
            q_poly.resize(qb.len(), BaseElement::ZERO);
        }
        for (i, &c) in qb.iter().enumerate() {
            q_poly[i] = q_poly[i] + alpha_pow * c;
        }
        alpha_pow = alpha_pow * alpha_bnd;
    }
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

/// Build a SHA-256 Merkle tree from LDE columns, ONE leaf per row.
/// Returns (root, tree_layers).
///
/// [ROUTE C] No longer on the shipping C0 path — the legacy generator commits
/// `build_trace_pair_merkle_tree` now. Kept `#[cfg(test)]` because the row-leaf
/// walk it exercises (`test_merkle_proof_verification`) is still the clearest
/// unit check that `sha256_leaf` / `sha256_node` compose into a valid tree, and
/// because deleting it would make this file's history harder to read against the
/// pre-Route-C wire format.
#[cfg(test)]
fn build_merkle_tree(lde: &[Vec<BaseElement>]) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    // Compute leaf hashes (one per LDE row)
    let leaves: Vec<[u8; 32]> = (0..LDE_SIZE)
        .map(|i| {
            let mut data = [0u8; TRACE_WIDTH * 8];
            for col in 0..TRACE_WIDTH {
                data[col * 8..(col + 1) * 8].copy_from_slice(&lde[col][i].as_int().to_le_bytes());
            }
            sha256_leaf(&data)
        })
        .collect();

    let mut layers = vec![leaves];

    while layers.last().unwrap().len() > 1 {
        let prev = layers.last().unwrap();
        let next: Vec<[u8; 32]> = prev
            .chunks(2)
            .map(|pair| {
                let right = if pair.len() > 1 { &pair[1] } else { &pair[0] };
                sha256_node(&pair[0], right)
            })
            .collect();
        layers.push(next);
    }

    let root = layers.last().unwrap()[0];
    (root, layers)
}

/// [B4] Get a Merkle proof for a leaf of a **pair** tree (circuit 0 / legacy).
/// The pair tree has `LDE_SIZE / 2` leaves, so its depth is `MERKLE_DEPTH - 1`.
fn get_merkle_proof_pair(
    tree: &[Vec<[u8; 32]>],
    index: usize,
) -> [[u8; 32]; MERKLE_DEPTH - 1] {
    let mut proof = [[0u8; 32]; MERKLE_DEPTH - 1];
    let mut idx = index;

    for (level, layer) in tree.iter().enumerate() {
        if level >= MERKLE_DEPTH - 1 {
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

/// Get Merkle proof (siblings) for a leaf at the given index, full `MERKLE_DEPTH`.
///
/// [ROUTE C] Superseded on the shipping path by `get_merkle_proof_pair`
/// (depth `MERKLE_DEPTH - 1`). See `build_merkle_tree` for why it stays.
#[cfg(test)]
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
    trace_leaf: TraceLeaf,
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

    // [ROUTE C] Trace path depth is a function of the commitment layout, and it
    // never travels on the wire — the verifier infers it from `merkle_depth`.
    // Assert it here so a caller that built the tree one way and the paths the
    // other cannot silently emit a buffer the parser will misread.
    let expected_trace_depth = match trace_leaf {
        TraceLeaf::Canonical => MERKLE_DEPTH - 1,
        TraceLeaf::LegacyRowLeaf => MERKLE_DEPTH,
    };

    // queries
    for q in queries {
        assert_eq!(
            (q.merkle_path.len(), q.next_merkle_path.len()),
            (expected_trace_depth, expected_trace_depth),
            "trace path depth does not match the {trace_leaf:?} commitment layout",
        );
        bytes.extend_from_slice(&q.position.to_le_bytes());
        // [ROUTE C] row(pos) | row(pos^half) | row(next) | row(next^half).
        // `LegacyRowLeaf` omits both mirror rows: pre-Route-C they did not exist
        // on the wire, and an old-format proof has to be byte-exact for the
        // fails-closed test to mean anything.
        for v in &q.trace_values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        if trace_leaf == TraceLeaf::Canonical {
            for v in &q.trace_mirror_values {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
        }
        for v in &q.next_trace_values {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        if trace_leaf == TraceLeaf::Canonical {
            for v in &q.next_trace_mirror_values {
                bytes.extend_from_slice(&v.to_le_bytes());
            }
        }
        // [ROUTE C] two depth-(MERKLE_DEPTH-1) trace pair-tree paths
        for path in &q.merkle_path {
            bytes.extend_from_slice(path);
        }
        for path in &q.next_merkle_path {
            bytes.extend_from_slice(path);
        }
        // [B4] quotient pair opening: mirror value(8) + ONE path((md-1) * 32).
        // The value at `position` itself travels in the tail `quotient_values`
        // array; the verifier orders the two into (lo, hi) and rehashes the leaf.
        bytes.extend_from_slice(&q.quotient_mirror_value.to_le_bytes());
        for node in &q.quotient_pair_path {
            bytes.extend_from_slice(node);
        }
        // [B4] per-FRI-layer pair openings.
        // Committed layer i (0-indexed) has size lde_size / 2^(i+1), so its
        // pair tree depth is (log2(lde_size) - i - 2).
        for i in 0..q.fri_lo_values.len() {
            bytes.extend_from_slice(&q.fri_lo_values[i].to_le_bytes());
            bytes.extend_from_slice(&q.fri_hi_values[i].to_le_bytes());
            for node in &q.fri_pair_paths[i] {
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
    ///     merkle_path(md*32) | next_merkle_path(md*32) |
    ///     quotient_mirror_value(8) | quotient_pair_path((md-1)*32) |
    ///     for each committed FRI layer i:
    ///       fri_lo(8) | fri_hi(8) | fri_pair_path((md-i-2)*32)
    ///   ] |
    ///   quotient_values(num_queries*8)
    ///
    /// PR 3: `L_commit = L - 1` where `L = log2(lde_size/fri_final_poly_size)`;
    /// the final fold lands on `final_poly` (coefficients), not a Merkle commit.
    /// PR 4: 8 extra bytes for `ood_quotient` (Q(z)) right after `ood_z`.
    ///
    /// [B4] Layer i (0-indexed) has size `lde_size / 2^(i+1)`, hence a value
    /// tree of depth `md - i - 1` and a **pair** tree of depth `md - i - 2`.
    /// Both the quotient LDE and every FRI layer now carry ONE pair opening
    /// instead of two single openings.
    ///
    /// [P2.2] `fri_final_poly_size` is a parameter so circuit 6 (which uses 64
    /// instead of 16) can assert its own wire size.
    fn expected_wire_size(
        tw: usize,
        md: usize,
        num_queries: usize,
        lde_size: usize,
        fri_final_poly_size: usize,
    ) -> usize {
        let num_folds = (lde_size / fri_final_poly_size).trailing_zeros() as usize;
        let num_fri_commits = num_folds - 1;
        // [B4] Per-query FRI footprint: lo(8) + hi(8) + pair_path((md-i-2)*32).
        let fri_per_query: usize = (0..num_fri_commits)
            .map(|i| 16 + (md - i - 2) * 32)
            .sum();
        32 + 32
            + tw * 8 + tw * 8 + 8 + 8  // PR 4: +8 for ood_quotient
            + 1 + num_fri_commits * 32
            + 2 + fri_final_poly_size * 8
            + 8 + 2
            + num_queries * (
                // [ROUTE C] FOUR trace rows (pos, pos^half, next, next^half)
                // + TWO depth-(md-1) trace PAIR paths (were two depth-md paths).
                // Net vs pre-Route-C: num_queries * (16*tw - 64) bytes.
                4 + 4 * (tw * 8)
                + (md - 1) * 32 + (md - 1) * 32
                + 8 + (md - 1) * 32
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
        let fri = fri_commit_phase(&values, domain_gen, &transcript, FRI_FINAL_POLY_SIZE, PairIndexing::Canonical);

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

        let a = fri_commit_phase(&values, gen, &transcript, FRI_FINAL_POLY_SIZE, PairIndexing::Canonical);
        let b = fri_commit_phase(&values, gen, &transcript, FRI_FINAL_POLY_SIZE, PairIndexing::Canonical);

        assert_eq!(a.layer_roots, b.layer_roots);
        assert_eq!(a.final_poly, b.final_poly);
    }

    #[test]
    fn test_wire_size_legacy_circuit_0() {
        // Circuit 0: tw=3, md=9 (LDE=512), num_queries=27
        let proof = generate_compact_proof(42);
        assert_eq!(
            proof.proof_bytes.len(),
            expected_wire_size(3, 9, 27, 512, FRI_FINAL_POLY_SIZE),
            "legacy wire size drift",
        );
    }

    #[test]
    fn test_wire_size_pool_commitment_circuit_1() {
        // Circuit 1: tw=3, trace=128, blowup=16, md=11 (LDE=2048), num_queries=27
        let proof = generate_pool_commitment_proof(111, 222, 333, 444);
        assert_eq!(
            proof.proof_bytes.len(),
            expected_wire_size(3, 11, 27, 2048, FRI_FINAL_POLY_SIZE),
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
            expected_wire_size(4, 12, 27, 4096, FRI_FINAL_POLY_SIZE),
            "confidential_balance wire size drift",
        );
    }

    #[test]
    fn test_wire_size_transfer_circuit_5() {
        // Circuit 5: tw=7, trace=512, blowup=16, md=13 (LDE=8192), num_queries=22
        // [P2.2g] num_queries dropped from 27→22 to fit phase-1 FRI under 1.4M CU.
        // [#2 voie A] trace width 6→7: added the value-conservation accumulator
        // column (col 6), which widens each OOD frame and per-query trace
        // opening — hence the larger wire size.
        let proof = generate_transfer_compact_proof(
            42, 999, 100, 111, 50, 222, 80, 555, 333, 70, 666, 444, 0,
        );
        assert_eq!(
            proof.proof_bytes.len(),
            expected_wire_size(7, 13, 22, 8192, FRI_FINAL_POLY_SIZE),
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
        let leaf_hash = sha256_leaf(&leaf_data);

        // Walk the proof. Leaf and node hashing are domain-separated, so this
        // walk deliberately mirrors the two DIFFERENT functions the tree uses.
        let mut current = leaf_hash;
        let mut i = idx;
        for sibling in &proof {
            current = if i & 1 == 0 {
                sha256_node(&current, sibling)
            } else {
                sha256_node(sibling, &current)
            };
            i >>= 1;
        }

        assert_eq!(current, root, "Merkle proof should verify to root");
    }

    /// [ROUTE C] The pair-leaf trace tree has half the leaves, one level less
    /// depth, and an opening at pair index `j` that reproduces the root from BOTH
    /// `row[j]` and `row[j + N/2]`.
    ///
    /// The negative half matters more than the positive: perturbing the HIGH row
    /// must break the root too. If it did not, the mirror row would be riding
    /// along unauthenticated and the whole route would buy nothing.
    #[test]
    fn route_c_trace_pair_tree_binds_both_halves() {
        let trace = crate::air::subscriber_ownership::build_trace(BaseElement::new(42));
        let lde = compute_lde(&trace);
        let (root, tree) = build_trace_pair_merkle_tree(&lde, TRACE_WIDTH);

        let half = LDE_SIZE / 2;
        assert_eq!(tree[0].len(), half, "pair tree must have LDE_SIZE/2 leaves");
        assert_eq!(
            tree.len(),
            MERKLE_DEPTH,
            "layers = depth + 1; depth must be MERKLE_DEPTH - 1"
        );

        // Both a low-half and a high-half query position, so the `pos & (half-1)`
        // indexing is exercised on both sides of the mirror.
        for pos in [10usize, 10 + half, 0, half - 1] {
            let j = pos & (half - 1);
            let proof = get_merkle_proof_pair(&tree, j);
            assert_eq!(proof.len(), MERKLE_DEPTH - 1);

            let mut preimage = vec![0u8; TRACE_WIDTH * 16];
            let hi_off = TRACE_WIDTH * 8;
            for col in 0..TRACE_WIDTH {
                preimage[col * 8..(col + 1) * 8]
                    .copy_from_slice(&lde[col][j].as_int().to_le_bytes());
                preimage[hi_off + col * 8..hi_off + (col + 1) * 8]
                    .copy_from_slice(&lde[col][j + half].as_int().to_le_bytes());
            }

            let walk = |leaf: [u8; 32]| {
                let mut current = leaf;
                let mut i = j;
                for sibling in &proof {
                    current = if i & 1 == 0 {
                        sha256_node(&current, sibling)
                    } else {
                        sha256_node(sibling, &current)
                    };
                    i >>= 1;
                }
                current
            };

            assert_eq!(walk(sha256_leaf(&preimage)), root, "pair opening at pos={pos}");

            // Perturb the LOW row -> must break.
            let mut lo_bad = preimage.clone();
            lo_bad[0] ^= 0x01;
            assert_ne!(walk(sha256_leaf(&lo_bad)), root, "low row unbound at pos={pos}");

            // Perturb the HIGH (mirror) row -> must break. This is the claim.
            let mut hi_bad = preimage.clone();
            hi_bad[hi_off] ^= 0x01;
            assert_ne!(walk(sha256_leaf(&hi_bad)), root, "MIRROR row unbound at pos={pos}");

            // Swap the halves -> must break (unless degenerate).
            let lo = preimage[..hi_off].to_vec();
            let hi = preimage[hi_off..].to_vec();
            if lo != hi {
                let mut swapped = vec![0u8; TRACE_WIDTH * 16];
                swapped[..hi_off].copy_from_slice(&hi);
                swapped[hi_off..].copy_from_slice(&lo);
                assert_ne!(
                    walk(sha256_leaf(&swapped)),
                    root,
                    "half order not bound at pos={pos}"
                );
            }
        }
    }

    /// [DOMAIN SEP] The prover's leaf and node hashes must be different
    /// functions on the same bytes. If this goes green with the tags removed,
    /// it is not testing anything.
    #[test]
    fn leaf_and_node_hash_are_domain_separated() {
        let left = [0x11u8; 32];
        let right = [0x22u8; 32];
        let mut concat = [0u8; 64];
        concat[..32].copy_from_slice(&left);
        concat[32..].copy_from_slice(&right);

        assert_ne!(
            sha256_leaf(&concat),
            sha256_node(&left, &right),
            "prover hashes a 64-byte leaf preimage and an internal node \
             identically — a genuine node can be replayed as a leaf"
        );
    }

    // The prover↔verifier tag agreement is NOT asserted here: the on-chain
    // crate is not a dependency of this one (the dependency runs the other
    // way), so anything written here could only compare a constant to a
    // restated copy of itself. The real cross-crate checks live in
    // `programs/p01_stark_verifier/tests/merkle_domain_sep.rs`
    // (`prover_and_verifier_agree_on_tags`, and the prover-built-tree opening).

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
    fn test_merkle_update_compact_proof() {
        let old_leaf = 42u64;
        let new_leaf = 1337u64;
        let path_elements: Vec<u64> = (0..3).map(|i| 100 + i).collect();
        let path_indices = vec![0u8, 1, 0];
        let proof = generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices,
        );
        assert_eq!(proof.circuit_id, CIRCUIT_MERKLE_UPDATE);
        assert_eq!(proof.public_inputs.len(), 5);
        assert_eq!(proof.public_inputs[0], old_leaf);
        assert_eq!(proof.public_inputs[1], new_leaf);
        assert_ne!(proof.public_inputs[2], proof.public_inputs[3], "old/new roots should differ");
        assert_eq!(proof.public_inputs[4], path_elements.len() as u64);
        assert!(!proof.proof_bytes.is_empty());
        assert!(
            proof.proof_bytes.len() < 1_500_000,
            "Merkle update proof too large: {}",
            proof.proof_bytes.len()
        );
        println!("Merkle update (depth 3) proof size: {} bytes", proof.proof_bytes.len());
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

    /// [P2.2c] Circuit 6 parity: re-emitting depth-15 periodic coefficients via
    /// inverse_ntt must match the `C6_*_COEFFS` arrays baked into
    /// `p01_stark_verifier/src/periodic_consts.rs`. If this fails, the on-chain
    /// DEEP-ALI check rejects honest proofs (or — worse — accepts malicious
    /// ones if the divergence happens to line up with an attacker's forgery).
    #[test]
    fn circuit_6_periodic_coeffs_match_verifier_constants_depth15() {
        use crate::air::merkle_update::build_merkle_update_periodic_columns;

        let depth = 15usize;
        let trace_length = 512usize;
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_merkle_update_periodic_columns(depth, trace_length);

        // Verifier's periodic_consts.rs bakes these specific coefficients. Any
        // drift in either lib rewrites these pin values.
        let rc0: Vec<u64> = inverse_ntt(&periodic[0], trace_g).iter().map(|f| f.as_int()).collect();
        let rc1: Vec<u64> = inverse_ntt(&periodic[1], trace_g).iter().map(|f| f.as_int()).collect();
        let rc2: Vec<u64> = inverse_ntt(&periodic[2], trace_g).iter().map(|f| f.as_int()).collect();
        let round_active: Vec<u64> = inverse_ntt(&periodic[3], trace_g).iter().map(|f| f.as_int()).collect();
        let hash_start: Vec<u64> = inverse_ntt(&periodic[4], trace_g).iter().map(|f| f.as_int()).collect();
        let is_boundary: Vec<u64> = inverse_ntt(&periodic[5], trace_g).iter().map(|f| f.as_int()).collect();
        let is_interior: Vec<u64> = inverse_ntt(&periodic[6], trace_g).iter().map(|f| f.as_int()).collect();

        assert_eq!(rc0[0], 0x558F5C5694E81D40);
        assert_eq!(rc0[511], 0x0AB02BE02E19C660);
        assert_eq!(rc1[0], 0x1230EF570AB0C5A3);
        assert_eq!(rc2[0], 0x0197B1AA9C1A574D);
        assert_eq!(round_active[0], 0x1EFFFFFFE1000001);
        assert_eq!(round_active[511], 0xAC5B6AFDF33F4359);
        assert_eq!(hash_start[0], 0xF87FFFFF07800001);
        assert_eq!(hash_start[511], 0xFFFFFFFEF8000001);
        assert_eq!(is_boundary[0], 0xF87FFFFF07800001);
        assert_eq!(is_boundary[511], 0x39E10F3192185B4B);
        assert_eq!(is_interior[0], 0x1EFFFFFFE1000001);
        assert_eq!(is_interior[511], 0x044CB98D1B6CF0E1);
    }

    /// [P2.2d-C1] Circuit 1 parity: re-emitting periodic coefficients via
    /// inverse_ntt on the circuit-1 periodic columns must match the
    /// `C1_*_COEFFS` arrays baked into `p01_stark_verifier/src/periodic_consts.rs`.
    /// Drift here breaks the on-chain DEEP-ALI check (either rejects honest
    /// proofs or — worse — mis-accepts malicious ones).
    #[test]
    fn circuit_1_periodic_coeffs_match_verifier_constants() {
        use crate::air::denominated_pool::{
            build_pool_commitment_periodic_columns, TRACE_LENGTH as POOL_TRACE_LENGTH,
        };

        let trace_length = POOL_TRACE_LENGTH;
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_pool_commitment_periodic_columns(trace_length);

        let rc0: Vec<u64> = inverse_ntt(&periodic[0], trace_g).iter().map(|f| f.as_int()).collect();
        let rc1: Vec<u64> = inverse_ntt(&periodic[1], trace_g).iter().map(|f| f.as_int()).collect();
        let rc2: Vec<u64> = inverse_ntt(&periodic[2], trace_g).iter().map(|f| f.as_int()).collect();
        let round_flag: Vec<u64> = inverse_ntt(&periodic[3], trace_g).iter().map(|f| f.as_int()).collect();
        let chain_flag: Vec<u64> = inverse_ntt(&periodic[4], trace_g).iter().map(|f| f.as_int()).collect();
        let is_boundary: Vec<u64> = inverse_ntt(&periodic[5], trace_g).iter().map(|f| f.as_int()).collect();

        assert_eq!(rc0[0], 0x113F7D1243ECE433);
        assert_eq!(rc0[127], 0x9F44812C1341A9B3);
        assert_eq!(rc1[0], 0xA82725DEA2270483);
        assert_eq!(rc1[127], 0x276708ABFC60C355);
        assert_eq!(rc2[0], 0x014627BBB01512A4);
        assert_eq!(rc2[127], 0x185F12D8475200CE);
        assert_eq!(round_flag[0], 0x4BFFFFFFB4000001);
        assert_eq!(round_flag[127], 0x3324DD568D8154A0);
        assert_eq!(chain_flag[0], 0xFDFFFFFF02000001);
        assert_eq!(chain_flag[127], 0x20001FFFE0000000);
        assert_eq!(is_boundary[0], 0xF9FFFFFF06000001);
        assert_eq!(is_boundary[127], 0x20001FFFE0000000);
    }

    /// [P2.2d-C2] Circuit 2 parity: re-emitting periodic coefficients via
    /// inverse_ntt on the circuit-2 (balance_proof) periodic columns must
    /// match the `C2_*_COEFFS` arrays baked into
    /// `p01_stark_verifier/src/periodic_consts.rs`. Circuit 2 has 4 Poseidon
    /// cycles with chained state cycle0→cycle1 (chain_01), carry capture
    /// cycle1→carry column (carry_capture), and carry→cycle3 (chain_carry).
    /// Drift here breaks the on-chain DEEP-ALI check for balance_proof.
    #[test]
    fn circuit_2_periodic_coeffs_match_verifier_constants() {
        use crate::air::balance_proof::{
            build_balance_proof_periodic_columns, TRACE_LENGTH as BAL_TRACE_LENGTH,
        };

        let trace_length = BAL_TRACE_LENGTH;
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_balance_proof_periodic_columns(trace_length);

        let rc0: Vec<u64> = inverse_ntt(&periodic[0], trace_g).iter().map(|f| f.as_int()).collect();
        let rc1: Vec<u64> = inverse_ntt(&periodic[1], trace_g).iter().map(|f| f.as_int()).collect();
        let rc2: Vec<u64> = inverse_ntt(&periodic[2], trace_g).iter().map(|f| f.as_int()).collect();
        let round_flag: Vec<u64> = inverse_ntt(&periodic[3], trace_g).iter().map(|f| f.as_int()).collect();
        let chain_01: Vec<u64> = inverse_ntt(&periodic[4], trace_g).iter().map(|f| f.as_int()).collect();
        let carry_capture: Vec<u64> = inverse_ntt(&periodic[5], trace_g).iter().map(|f| f.as_int()).collect();
        let chain_carry: Vec<u64> = inverse_ntt(&periodic[6], trace_g).iter().map(|f| f.as_int()).collect();
        let is_boundary: Vec<u64> = inverse_ntt(&periodic[7], trace_g).iter().map(|f| f.as_int()).collect();

        assert_eq!(rc0[0], 0xC1A9FC17AFE6859A);
        assert_eq!(rc0[127], 0x0000000000000000);
        assert_eq!(rc1[0], 0x8ADEDD292D895B59);
        assert_eq!(rc1[127], 0x0000000000000000);
        assert_eq!(rc2[0], 0xAC5D8A4EEAC6C386);
        assert_eq!(rc2[127], 0x0000000000000000);
        assert_eq!(round_flag[0], 0x0FFFFFFFF0000001);
        assert_eq!(round_flag[127], 0x0000000000000000);
        assert_eq!(chain_01[0], 0xFDFFFFFF02000001);
        assert_eq!(chain_01[127], 0xE0001FFF20000001);
        assert_eq!(carry_capture[0], 0xFDFFFFFF02000001);
        assert_eq!(carry_capture[127], 0x20001FFFE0000000);
        assert_eq!(chain_carry[0], 0xFDFFFFFF02000001);
        assert_eq!(chain_carry[127], 0x1FFFDFFFE0000000);
        assert_eq!(is_boundary[0], 0xF9FFFFFF06000001);
        assert_eq!(is_boundary[127], 0x20001FFFE0000000);
    }

    /// [P2.2d-C3] Parity check for circuit 3 (merkle_path) periodic columns.
    /// The 7 coefficient arrays baked into `periodic_consts.rs` must exactly
    /// match what `inverse_ntt(build_merkle_path_periodic_columns(...))`
    /// produces, otherwise the on-chain verifier rejects honest proofs.
    #[test]
    fn circuit_3_periodic_coeffs_match_verifier_constants() {
        use crate::air::merkle_path::{
            build_merkle_path_periodic_columns, CANONICAL_DEPTH, TRACE_LENGTH as MP_TRACE_LENGTH,
        };

        let trace_length = MP_TRACE_LENGTH; // 512
        let depth = CANONICAL_DEPTH; // 15
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_merkle_path_periodic_columns(depth, trace_length);

        let rc0: Vec<u64> = inverse_ntt(&periodic[0], trace_g).iter().map(|f| f.as_int()).collect();
        let rc1: Vec<u64> = inverse_ntt(&periodic[1], trace_g).iter().map(|f| f.as_int()).collect();
        let rc2: Vec<u64> = inverse_ntt(&periodic[2], trace_g).iter().map(|f| f.as_int()).collect();
        let round_active: Vec<u64> = inverse_ntt(&periodic[3], trace_g).iter().map(|f| f.as_int()).collect();
        let hash_start: Vec<u64> = inverse_ntt(&periodic[4], trace_g).iter().map(|f| f.as_int()).collect();
        let is_boundary: Vec<u64> = inverse_ntt(&periodic[5], trace_g).iter().map(|f| f.as_int()).collect();
        let is_interior: Vec<u64> = inverse_ntt(&periodic[6], trace_g).iter().map(|f| f.as_int()).collect();

        assert_eq!(rc0[0], 0x558F5C5694E81D40);
        assert_eq!(rc0[511], 0x0AB02BE02E19C660);
        assert_eq!(rc1[0], 0x1230EF570AB0C5A3);
        assert_eq!(rc1[511], 0x6C569A22D587E645);
        assert_eq!(rc2[0], 0x0197B1AA9C1A574D);
        assert_eq!(rc2[511], 0x0DD93E6880FF9479);
        assert_eq!(round_active[0], 0x1EFFFFFFE1000001);
        assert_eq!(round_active[511], 0xAC5B6AFDF33F4359);
        assert_eq!(hash_start[0], 0xF87FFFFF07800001);
        assert_eq!(hash_start[511], 0xFFFFFFFEF8000001);
        assert_eq!(is_boundary[0], 0xF87FFFFF07800001);
        assert_eq!(is_boundary[511], 0x39E10F3192185B4B);
        assert_eq!(is_interior[0], 0x1EFFFFFFE1000001);
        assert_eq!(is_interior[511], 0x044CB98D1B6CF0E1);
    }

    /// [P2.2d-C4] Circuit 4 parity: re-emitting periodic coefficients via
    /// inverse_ntt on the circuit-4 (confidential_balance) periodic columns
    /// must match the `C4_*_COEFFS` arrays baked into
    /// `p01_stark_verifier/src/periodic_consts.rs`. Drift breaks the on-chain
    /// DEEP-ALI check.
    #[test]
    fn circuit_4_periodic_coeffs_match_verifier_constants() {
        use crate::air::confidential_balance::{
            build_confidential_balance_periodic_columns, TRACE_LENGTH as CB_TRACE_LENGTH,
        };

        let trace_length = CB_TRACE_LENGTH; // 256
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_confidential_balance_periodic_columns();

        let rc0: Vec<u64> = inverse_ntt(&periodic[0], trace_g).iter().map(|f| f.as_int()).collect();
        let rc1: Vec<u64> = inverse_ntt(&periodic[1], trace_g).iter().map(|f| f.as_int()).collect();
        let rc2: Vec<u64> = inverse_ntt(&periodic[2], trace_g).iter().map(|f| f.as_int()).collect();
        let round_flag: Vec<u64> = inverse_ntt(&periodic[3], trace_g).iter().map(|f| f.as_int()).collect();
        let is_boundary: Vec<u64> = inverse_ntt(&periodic[4], trace_g).iter().map(|f| f.as_int()).collect();
        let chain_01: Vec<u64> = inverse_ntt(&periodic[5], trace_g).iter().map(|f| f.as_int()).collect();
        let chain_34: Vec<u64> = inverse_ntt(&periodic[6], trace_g).iter().map(|f| f.as_int()).collect();
        let chain_56: Vec<u64> = inverse_ntt(&periodic[7], trace_g).iter().map(|f| f.as_int()).collect();
        let carry_capture: Vec<u64> = inverse_ntt(&periodic[8], trace_g).iter().map(|f| f.as_int()).collect();
        let chain_carry_4: Vec<u64> = inverse_ntt(&periodic[9], trace_g).iter().map(|f| f.as_int()).collect();
        let chain_carry_6: Vec<u64> = inverse_ntt(&periodic[10], trace_g).iter().map(|f| f.as_int()).collect();

        assert_eq!(rc0[0], 0xC1A9FC17AFE6859A);
        assert_eq!(rc0[255], 0x0000000000000000);
        assert_eq!(rc1[0], 0x8ADEDD292D895B59);
        assert_eq!(rc1[255], 0x0000000000000000);
        assert_eq!(rc2[0], 0xAC5D8A4EEAC6C386);
        assert_eq!(rc2[255], 0x0000000000000000);
        assert_eq!(round_flag[0], 0x0FFFFFFFF0000001);
        assert_eq!(round_flag[255], 0x0000000000000000);
        assert_eq!(is_boundary[0], 0xF8FFFFFF07000001);
        assert_eq!(is_boundary[255], 0xAFE29D1C405B5B12);
        assert_eq!(chain_01[0], 0xFEFFFFFF01000001);
        assert_eq!(chain_01[255], 0x1CF03DF811501D63);
        assert_eq!(chain_34[0], 0xFEFFFFFF01000001);
        assert_eq!(chain_34[255], 0xAFE29D1C405B5B12);
        assert_eq!(chain_56[0], 0xFEFFFFFF01000001);
        assert_eq!(chain_56[255], 0xF82E405A62E30FC3);
        assert_eq!(carry_capture[0], 0xFEFFFFFF01000001);
        assert_eq!(carry_capture[255], 0x07D1BFA49D1CF03E);
        assert_eq!(chain_carry_4[0], 0xFEFFFFFF01000001);
        assert_eq!(chain_carry_4[255], 0xAFE29D1C405B5B12);
        assert_eq!(chain_carry_6[0], 0xFEFFFFFF01000001);
        assert_eq!(chain_carry_6[255], 0xF82E405A62E30FC3);
    }

    /// [P2.2d-C5] Circuit 5 parity: re-emitting periodic coefficients via
    /// inverse_ntt on the circuit-5 (transfer) periodic columns — after tiling
    /// period-32 columns to the full trace length — must match the
    /// `C5_*_COEFFS` arrays baked into
    /// `p01_stark_verifier/src/periodic_consts.rs`. Drift breaks the on-chain
    /// DEEP-ALI check for transfers.
    #[test]
    fn circuit_5_periodic_coeffs_match_verifier_constants() {
        use crate::air::transfer::{
            build_transfer_periodic_columns, TRACE_LENGTH as TR_TRACE_LENGTH,
        };

        let trace_length = TR_TRACE_LENGTH; // 512
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_transfer_periodic_columns();

        let materialise = |col: &Vec<BaseElement>| -> Vec<BaseElement> {
            if col.len() == trace_length {
                col.clone()
            } else {
                let mut full = vec![BaseElement::ZERO; trace_length];
                for i in 0..trace_length {
                    full[i] = col[i % col.len()];
                }
                full
            }
        };

        let c: Vec<Vec<u64>> = periodic
            .iter()
            .map(|col| {
                inverse_ntt(&materialise(col), trace_g)
                    .iter()
                    .map(|f| f.as_int())
                    .collect()
            })
            .collect();

        // Column order must match emit_circuit_5_periodic_coeffs: rc0, rc1, rc2,
        // round_flag, is_boundary, chain_0_1, chain_2_3, chain_3_4, chain_5_6,
        // chain_6_7, chain_9_10, chain_12_13, capture_owner, capture_om,
        // capture_out1_rm, capture_out2_rm, om_to_3, om_to_6, owner_to_4,
        // owner_to_7, out1_rm_to_10, out2_rm_to_13, out_rm_capture_any.
        assert_eq!(c[0][0], 0xC1A9FC17AFE6859A);
        assert_eq!(c[0][511], 0x0000000000000000);
        assert_eq!(c[1][0], 0x8ADEDD292D895B59);
        assert_eq!(c[1][511], 0x0000000000000000);
        assert_eq!(c[2][0], 0xAC5D8A4EEAC6C386);
        assert_eq!(c[2][511], 0x0000000000000000);
        assert_eq!(c[3][0], 0x0FFFFFFFF0000001);
        assert_eq!(c[3][511], 0x0000000000000000);
        assert_eq!(c[4][0], 0xF87FFFFF07800001);
        assert_eq!(c[4][511], 0x39E10F3192185B4B);
        assert_eq!(c[5][0], 0xFF7FFFFF00800001);
        assert_eq!(c[5][511], 0xC92185B3E3406959);
        assert_eq!(c[6][0], 0xFF7FFFFF00800001);
        assert_eq!(c[6][511], 0x4B539E10A7C92186);
        assert_eq!(c[7][0], 0xFF7FFFFF00800001);
        assert_eq!(c[7][511], 0x95836DE70F31CBFA);
        assert_eq!(c[8][0], 0xFF7FFFFF00800001);
        assert_eq!(c[8][511], 0x185B4AC60695836E);
        assert_eq!(c[9][0], 0xFF7FFFFF00800001);
        assert_eq!(c[9][511], 0xBF96A7C861EF0CE4);
        assert_eq!(c[10][0], 0xFF7FFFFF00800001);
        assert_eq!(c[10][511], 0xCE340694B539E110);
        assert_eq!(c[11][0], 0xFF7FFFFF00800001);
        assert_eq!(c[11][511], 0x10F31CBF85B4AC62);
        assert_eq!(c[12][0], 0xFF7FFFFF00800001);
        assert_eq!(c[12][511], 0x7202DAD8187E103F);
        assert_eq!(c[13][0], 0xFF7FFFFF00800001);
        assert_eq!(c[13][511], 0x8E781EFB88A80EB2);
        assert_eq!(c[14][0], 0xFF7FFFFF00800001);
        assert_eq!(c[14][511], 0x8DFD2526E781EFC2);
        assert_eq!(c[15][0], 0xFF7FFFFF00800001);
        assert_eq!(c[15][511], 0xFC17202CB17187E2);
        assert_eq!(c[16][0], 0xFF7FFFFF00800001);
        assert_eq!(c[16][511], 0x4B539E10A7C92186);
        assert_eq!(c[17][0], 0xFF7FFFFF00800001);
        assert_eq!(c[17][511], 0x185B4AC60695836E);
        assert_eq!(c[18][0], 0xFF7FFFFF00800001);
        assert_eq!(c[18][511], 0x95836DE70F31CBFA);
        assert_eq!(c[19][0], 0xFF7FFFFF00800001);
        assert_eq!(c[19][511], 0xBF96A7C861EF0CE4);
        assert_eq!(c[20][0], 0xFF7FFFFF00800001);
        assert_eq!(c[20][511], 0xCE340694B539E110);
        assert_eq!(c[21][0], 0xFF7FFFFF00800001);
        assert_eq!(c[21][511], 0x10F31CBF85B4AC62);
        assert_eq!(c[22][0], 0xFEFFFFFF01000001);
        assert_eq!(c[22][511], 0x8A14455498F377A3);

        // [#2 voie A] Value-conservation columns (indices 23-27): add_in1,
        // add_in2, sub_out1, sub_out2 (single-hot at rows 64/160/288/384) and
        // acc_continuity (508-hot). Must match the `C5_ADD_IN1_COEFFS` …
        // `C5_ACC_CONTINUITY_COEFFS` arrays appended to
        // `p01_stark_verifier/src/periodic_consts.rs`. All four single-hots
        // share constant term 1/N = 0xFF7FFFFF00800001; acc_continuity's is
        // 1 - 4/N = 0x01FFFFFFFE000001.
        assert_eq!(c[23][0], 0xFF7FFFFF00800001); // C5_ADD_IN1
        assert_eq!(c[23][511], 0xFFFFFFFEFFFF8001);
        assert_eq!(c[24][0], 0xFF7FFFFF00800001); // C5_ADD_IN2
        assert_eq!(c[24][511], 0x0000000000000008);
        assert_eq!(c[25][0], 0xFF7FFFFF00800001); // C5_SUB_OUT1
        assert_eq!(c[25][511], 0x0008000000000000);
        assert_eq!(c[26][0], 0xFF7FFFFF00800001); // C5_SUB_OUT2
        assert_eq!(c[26][511], 0xFFFFFF7F00000001);
        assert_eq!(c[27][0], 0x01FFFFFFFE000001); // C5_ACC_CONTINUITY
        assert_eq!(c[27][511], 0xFFF8007F00007FF9);
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

    /// [P2.2a] DEEP-ALI identity holds at OOD for an honest circuit-6 proof.
    ///
    /// Evaluates all 19 transition constraints at LDE points via the shared
    /// `evaluate_merkle_update_transition` function, RLC-combines them with a
    /// fixed α, divides by Z_T, then checks C(z) == Q(z) · Z_T(z) at a random z.
    ///
    /// This is the foundation for the generic-path DEEP-ALI: if the identity
    /// holds here for the full AIR, the on-chain verifier can enforce it at
    /// OOD and bind all 19 constraints — fixing the soundness hole where the
    /// old `compute_quotient_at_position_generic` only evaluated cols 0-2.
    #[test]
    fn deep_ali_identity_holds_at_ood_circuit_6() {
        use crate::air::merkle_update::{
            build_merkle_update_periodic_columns, build_merkle_update_trace,
            evaluate_merkle_update_transition, MERKLE_UPDATE_NUM_CONSTRAINTS,
            MERKLE_UPDATE_NUM_PERIODIC,
        };

        // Small depth for fast test — same math applies to depth 13.
        let depth = 3usize;
        let old_leaf = BaseElement::new(111);
        let new_leaf = BaseElement::new(222);
        let path_elements: Vec<BaseElement> =
            (0..depth).map(|i| BaseElement::new(1000 + i as u64)).collect();
        let path_indices: Vec<u8> = vec![0, 1, 0];

        // Build trace + LDE.
        let trace =
            build_merkle_update_trace(old_leaf, new_leaf, &path_elements, &path_indices);
        assert_eq!(trace.len(), 10);
        let trace_length = trace[0].len();
        let blowup = 16;
        let lde_size = trace_length * blowup;
        let lde = compute_lde_generic(&trace, blowup);
        let lde_g = get_domain_generator_generic(lde_size);
        let trace_g = get_domain_generator_generic(trace_length);

        // Interpolate periodic columns (they live on the trace domain).
        let periodic_values = build_merkle_update_periodic_columns(depth, trace_length);
        assert_eq!(periodic_values.len(), MERKLE_UPDATE_NUM_PERIODIC);
        let periodic_polys: Vec<Vec<BaseElement>> = periodic_values
            .iter()
            .map(|col| inverse_ntt(col, trace_g))
            .collect();

        // Fixed RLC α for this test. In production α is Fiat-Shamir from trace_root.
        let alpha = BaseElement::new(0xA1B2_C3D4_E5F6_0708);

        // Compute C(x) on LDE domain via the full 19-constraint RLC.
        let c_lde: Vec<BaseElement> = (0..lde_size)
            .map(|pos| {
                let next_pos = (pos + blowup) % lde_size;
                let current: Vec<BaseElement> =
                    (0..10).map(|col| lde[col][pos]).collect();
                let next: Vec<BaseElement> =
                    (0..10).map(|col| lde[col][next_pos]).collect();
                let x = lde_g.exp(pos as u64);
                let periodic_at_x: Vec<BaseElement> = periodic_polys
                    .iter()
                    .map(|p| evaluate_poly(p, x))
                    .collect();
                let mut constraints = [BaseElement::ZERO; MERKLE_UPDATE_NUM_CONSTRAINTS];
                evaluate_merkle_update_transition(
                    &current,
                    &next,
                    &periodic_at_x,
                    &mut constraints,
                );
                rlc_combine(&constraints, alpha)
            })
            .collect();

        // Standard quotient pipeline: C(x) * (x - g^(n-1)) / (x^n - 1) = Q(x).
        let c_poly = inverse_ntt(&c_lde, lde_g);
        let last_row_x = trace_g.exp((trace_length - 1) as u64);
        let c_poly_scaled = multiply_by_x_minus_a(&c_poly, last_row_x);
        let q_poly = divide_by_vanishing(&c_poly_scaled, trace_length);

        // Pick OOD z away from domain roots.
        let z = BaseElement::new(0x0BAD_BEEF_1337_CAFEu64);
        let z_next = z * trace_g;

        // Evaluate trace polys at z and z*g to get OOD current/next for all 10 cols.
        let ood_current: Vec<BaseElement> = (0..10)
            .map(|col| evaluate_poly(&inverse_ntt(&trace[col], trace_g), z))
            .collect();
        let ood_next: Vec<BaseElement> = (0..10)
            .map(|col| evaluate_poly(&inverse_ntt(&trace[col], trace_g), z_next))
            .collect();
        let periodic_at_z: Vec<BaseElement> =
            periodic_polys.iter().map(|p| evaluate_poly(p, z)).collect();

        // C(z) via the same RLC + AIR evaluator.
        let mut constraints = [BaseElement::ZERO; MERKLE_UPDATE_NUM_CONSTRAINTS];
        evaluate_merkle_update_transition(
            &ood_current,
            &ood_next,
            &periodic_at_z,
            &mut constraints,
        );
        let c_at_z = rlc_combine(&constraints, alpha);

        // Q(z) via direct poly eval.
        let q_at_z = evaluate_poly(&q_poly, z);

        // Z_T(z) = (z^n - 1) / (z - g^(n-1)).
        let z_d = z.exp(trace_length as u64) - BaseElement::ONE;
        let z_t = z_d * (z - last_row_x).inv();

        assert_eq!(
            c_at_z,
            q_at_z * z_t,
            "circuit-6 DEEP-ALI identity failed at OOD"
        );
    }

    /// [P2.2a] One-off generator: prints the 7 periodic-column polynomial
    /// coefficient arrays for the on-chain circuit 6 config (depth=13,
    /// trace_length=512) in the exact format used by
    /// `programs/p01_stark_verifier/src/periodic_consts.rs`.
    ///
    /// Run with:
    /// `cargo test -p p01-stark --lib emit_circuit_6_periodic_coeffs -- --ignored --nocapture`
    ///
    /// Paste output into the verifier crate under `C6_*_COEFFS`.
    #[test]
    #[ignore]
    fn emit_circuit_6_periodic_coeffs() {
        use crate::air::merkle_update::build_merkle_update_periodic_columns;

        // Depth 15 is the canonical production depth (see test comment in
        // tests/p01-stark-verifier.test.ts: "depth 15 is what the production
        // mobile app uses"). Periodic columns are depth-dependent because
        // active_rows = depth * 32 masks off rows.
        let depth = 15usize;
        let trace_length = 512usize;
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_merkle_update_periodic_columns(depth, trace_length);
        let names = [
            "C6_RC0_COEFFS",
            "C6_RC1_COEFFS",
            "C6_RC2_COEFFS",
            "C6_ROUND_ACTIVE_COEFFS",
            "C6_HASH_START_COEFFS",
            "C6_IS_BOUNDARY_COEFFS",
            "C6_IS_INTERIOR_COEFFS",
        ];
        for (i, col) in periodic.iter().enumerate() {
            let poly = inverse_ntt(col, trace_g);
            println!("pub const {}: [u64; {}] = [", names[i], trace_length);
            for c in &poly {
                println!("    0x{:016X},", c.as_int());
            }
            println!("];");
            println!();
        }
    }

    /// [P2.2d-C1] One-off generator: prints the 6 periodic-column polynomial
    /// coefficient arrays for the on-chain circuit 1 config (trace_length=128)
    /// in the format used by `programs/p01_stark_verifier/src/periodic_consts.rs`.
    ///
    /// Run with:
    /// `cargo test -p p01-stark --lib emit_circuit_1_periodic_coeffs -- --ignored --nocapture`
    ///
    /// Paste output into the verifier crate under `C1_*_COEFFS`.
    #[test]
    #[ignore]
    fn emit_circuit_1_periodic_coeffs() {
        use crate::air::denominated_pool::{
            build_pool_commitment_periodic_columns, TRACE_LENGTH as POOL_TRACE_LENGTH,
        };

        let trace_length = POOL_TRACE_LENGTH; // 128
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_pool_commitment_periodic_columns(trace_length);
        let names = [
            "C1_RC0_COEFFS",
            "C1_RC1_COEFFS",
            "C1_RC2_COEFFS",
            "C1_ROUND_FLAG_COEFFS",
            "C1_CHAIN_FLAG_COEFFS",
            "C1_IS_BOUNDARY_COEFFS",
        ];
        for (i, col) in periodic.iter().enumerate() {
            let poly = inverse_ntt(col, trace_g);
            println!("pub const {}: [u64; {}] = [", names[i], trace_length);
            for c in &poly {
                println!("    0x{:016X},", c.as_int());
            }
            println!("];");
            println!();
        }
    }

    /// [P2.2d-C2] One-off generator: prints the 8 periodic-column polynomial
    /// coefficient arrays for the on-chain circuit 2 config (balance_proof,
    /// trace_length=128, 4 hash cycles) in the format used by
    /// `programs/p01_stark_verifier/src/periodic_consts.rs`.
    ///
    /// Run with:
    /// `cargo test -p p01-stark --lib emit_circuit_2_periodic_coeffs -- --ignored --nocapture`
    ///
    /// Paste output into the verifier crate under `C2_*_COEFFS`.
    #[test]
    #[ignore]
    fn emit_circuit_2_periodic_coeffs() {
        use crate::air::balance_proof::{
            build_balance_proof_periodic_columns, TRACE_LENGTH as BAL_TRACE_LENGTH,
        };

        let trace_length = BAL_TRACE_LENGTH; // 128
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_balance_proof_periodic_columns(trace_length);
        let names = [
            "C2_RC0_COEFFS",
            "C2_RC1_COEFFS",
            "C2_RC2_COEFFS",
            "C2_ROUND_FLAG_COEFFS",
            "C2_CHAIN_01_COEFFS",
            "C2_CARRY_CAPTURE_COEFFS",
            "C2_CHAIN_CARRY_COEFFS",
            "C2_IS_BOUNDARY_COEFFS",
        ];
        for (i, col) in periodic.iter().enumerate() {
            let poly = inverse_ntt(col, trace_g);
            println!("pub const {}: [u64; {}] = [", names[i], trace_length);
            for c in &poly {
                println!("    0x{:016X},", c.as_int());
            }
            println!("];");
            println!();
        }
    }

    /// [P2.2d-C3] Emit periodic column coefficients for circuit 3 (merkle_path),
    /// canonical depth=15 → trace_length=512. Run with:
    ///
    /// `cargo test -p p01-stark --lib emit_circuit_3_periodic_coeffs -- --ignored --nocapture`
    ///
    /// Paste output into the verifier crate under `C3_*_COEFFS`.
    #[test]
    #[ignore]
    fn emit_circuit_3_periodic_coeffs() {
        use crate::air::merkle_path::{
            build_merkle_path_periodic_columns, CANONICAL_DEPTH, TRACE_LENGTH as MP_TRACE_LENGTH,
        };

        let trace_length = MP_TRACE_LENGTH; // 512
        let depth = CANONICAL_DEPTH; // 15
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_merkle_path_periodic_columns(depth, trace_length);
        let names = [
            "C3_RC0_COEFFS",
            "C3_RC1_COEFFS",
            "C3_RC2_COEFFS",
            "C3_ROUND_ACTIVE_COEFFS",
            "C3_HASH_START_COEFFS",
            "C3_IS_BOUNDARY_COEFFS",
            "C3_IS_INTERIOR_COEFFS",
        ];
        for (i, col) in periodic.iter().enumerate() {
            let poly = inverse_ntt(col, trace_g);
            println!("pub const {}: [u64; {}] = [", names[i], trace_length);
            for c in &poly {
                println!("    0x{:016X},", c.as_int());
            }
            println!("];");
            println!();
        }
    }

    /// [P2.2d-C4] Emit periodic column coefficients for circuit 4
    /// [P2.2d-C5] Emit `C5_*_COEFFS` arrays for circuit 5 (transfer), fixed
    /// trace_length=512. Run with:
    ///
    /// `cargo test -p p01-stark --lib emit_circuit_5_periodic_coeffs -- --ignored --nocapture`
    ///
    /// Paste output into the verifier crate under `C5_*_COEFFS`.
    #[test]
    #[ignore]
    fn emit_circuit_5_periodic_coeffs() {
        use crate::air::transfer::{build_transfer_periodic_columns, TRACE_LENGTH as TR_TRACE_LENGTH};

        let trace_length = TR_TRACE_LENGTH; // 512
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic_raw = build_transfer_periodic_columns();
        let names = [
            "C5_RC0_COEFFS",
            "C5_RC1_COEFFS",
            "C5_RC2_COEFFS",
            "C5_ROUND_FLAG_COEFFS",
            "C5_IS_BOUNDARY_COEFFS",
            "C5_CHAIN_0_1_COEFFS",
            "C5_CHAIN_2_3_COEFFS",
            "C5_CHAIN_3_4_COEFFS",
            "C5_CHAIN_5_6_COEFFS",
            "C5_CHAIN_6_7_COEFFS",
            "C5_CHAIN_9_10_COEFFS",
            "C5_CHAIN_12_13_COEFFS",
            "C5_CAPTURE_OWNER_COEFFS",
            "C5_CAPTURE_OM_COEFFS",
            "C5_CAPTURE_OUT1_RM_COEFFS",
            "C5_CAPTURE_OUT2_RM_COEFFS",
            "C5_OM_TO_3_COEFFS",
            "C5_OM_TO_6_COEFFS",
            "C5_OWNER_TO_4_COEFFS",
            "C5_OWNER_TO_7_COEFFS",
            "C5_OUT1_RM_TO_10_COEFFS",
            "C5_OUT2_RM_TO_13_COEFFS",
            "C5_OUT_RM_CAPTURE_ANY_COEFFS",
            // [#2 voie A] Value-conservation columns (indices 23-27).
            "C5_ADD_IN1_COEFFS",
            "C5_ADD_IN2_COEFFS",
            "C5_SUB_OUT1_COEFFS",
            "C5_SUB_OUT2_COEFFS",
            "C5_ACC_CONTINUITY_COEFFS",
        ];

        // Period-32 columns get tiled to full trace length before inverse NTT so
        // one polynomial suffices per column on-chain.
        let materialise = |col: &Vec<BaseElement>| -> Vec<BaseElement> {
            if col.len() == trace_length {
                col.clone()
            } else {
                let mut full = vec![BaseElement::ZERO; trace_length];
                for i in 0..trace_length {
                    full[i] = col[i % col.len()];
                }
                full
            }
        };

        for (i, col_raw) in periodic_raw.iter().enumerate() {
            let col = materialise(col_raw);
            let poly = inverse_ntt(&col, trace_g);
            println!("pub const {}: [u64; {}] = [", names[i], trace_length);
            for c in &poly {
                println!("    0x{:016X},", c.as_int());
            }
            println!("];");
            println!();
        }
    }

    /// (confidential_balance), fixed trace_length=256. Run with:
    ///
    /// `cargo test -p p01-stark --lib emit_circuit_4_periodic_coeffs -- --ignored --nocapture`
    ///
    /// Paste output into the verifier crate under `C4_*_COEFFS`.
    #[test]
    #[ignore]
    fn emit_circuit_4_periodic_coeffs() {
        use crate::air::confidential_balance::{
            build_confidential_balance_periodic_columns, TRACE_LENGTH as CB_TRACE_LENGTH,
        };

        let trace_length = CB_TRACE_LENGTH; // 256
        let trace_g = get_domain_generator_generic(trace_length);
        let periodic = build_confidential_balance_periodic_columns();
        let names = [
            "C4_RC0_COEFFS",
            "C4_RC1_COEFFS",
            "C4_RC2_COEFFS",
            "C4_ROUND_FLAG_COEFFS",
            "C4_IS_BOUNDARY_COEFFS",
            "C4_CHAIN_01_COEFFS",
            "C4_CHAIN_34_COEFFS",
            "C4_CHAIN_56_COEFFS",
            "C4_CARRY_CAPTURE_COEFFS",
            "C4_CHAIN_CARRY_4_COEFFS",
            "C4_CHAIN_CARRY_6_COEFFS",
        ];
        for (i, col) in periodic.iter().enumerate() {
            let poly = inverse_ntt(col, trace_g);
            println!("pub const {}: [u64; {}] = [", names[i], trace_length);
            for c in &poly {
                println!("    0x{:016X},", c.as_int());
            }
            println!("];");
            println!();
        }
    }

    /// [P2.2a] End-to-end: a proof produced by `generate_merkle_update_compact_proof`
    /// satisfies DEEP-ALI (C(z) == Q(z)·Z_T(z)) when C is the full 19-constraint
    /// RLC with α = `derive_rlc_alpha(trace_root, pub_inputs)`.
    ///
    /// This is the pipeline test: it proves α, quotient computation, periodic
    /// evaluation, and OOD point derivation are all mutually consistent
    /// between prover and a reconstructed verifier.
    #[test]
    fn merkle_update_proof_satisfies_deep_ali_end_to_end() {
        use crate::air::merkle_update::{
            build_merkle_update_periodic_columns, evaluate_merkle_update_transition,
            MERKLE_UPDATE_NUM_CONSTRAINTS, MERKLE_UPDATE_NUM_PERIODIC,
        };

        let depth = 3usize;
        let path_elements: Vec<u64> = (0..depth).map(|i| 1000 + i as u64).collect();
        let path_indices: Vec<u8> = vec![0, 1, 0];
        let old_leaf = 111u64;
        let new_leaf = 222u64;

        let proof = generate_merkle_update_compact_proof(
            old_leaf, new_leaf, &path_elements, &path_indices,
        );
        assert_eq!(proof.circuit_id, CIRCUIT_MERKLE_UPDATE);
        assert_eq!(proof.public_inputs.len(), 5);

        // Parse header fields deterministically from the wire format.
        let bytes = &proof.proof_bytes;
        let mut off = 0usize;

        let mut trace_root = [0u8; 32];
        trace_root.copy_from_slice(&bytes[off..off + 32]);
        off += 32;
        let _quotient_root = &bytes[off..off + 32];
        off += 32;

        // Trace width for circuit 6 is 10.
        let trace_width = 10usize;
        let mut ood_current = Vec::with_capacity(trace_width);
        for _ in 0..trace_width {
            ood_current.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let mut ood_next = Vec::with_capacity(trace_width);
        for _ in 0..trace_width {
            ood_next.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let ood_z = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
        off += 8;
        let ood_quotient = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());

        // Reconstruct public input bytes exactly as the prover built them.
        let (old_root_u64, new_root_u64) = {
            let (old_root, new_root) = crate::air::merkle_update::compute_update_roots(
                BaseElement::new(old_leaf),
                BaseElement::new(new_leaf),
                &path_elements
                    .iter()
                    .map(|&v| BaseElement::new(v))
                    .collect::<Vec<_>>(),
                &path_indices,
            );
            (old_root.as_int(), new_root.as_int())
        };
        let mut pub_bytes = Vec::new();
        pub_bytes.extend_from_slice(&old_leaf.to_le_bytes());
        pub_bytes.extend_from_slice(&new_leaf.to_le_bytes());
        pub_bytes.extend_from_slice(&old_root_u64.to_le_bytes());
        pub_bytes.extend_from_slice(&new_root_u64.to_le_bytes());
        pub_bytes.extend_from_slice(&(depth as u64).to_le_bytes());

        // Derive α exactly like the prover.
        let alpha = derive_rlc_alpha(&trace_root, &pub_bytes);

        // Evaluate periodic columns at z.
        let trace_length = crate::air::merkle_update::trace_length_for_depth(depth);
        let trace_g = get_domain_generator_generic(trace_length);
        let z = BaseElement::new(ood_z);
        let periodic = build_merkle_update_periodic_columns(depth, trace_length);
        assert_eq!(periodic.len(), MERKLE_UPDATE_NUM_PERIODIC);
        let periodic_at_z: Vec<BaseElement> = periodic
            .iter()
            .map(|col| {
                let poly = inverse_ntt(col, trace_g);
                evaluate_poly(&poly, z)
            })
            .collect();

        // RLC of the 19 constraints at z.
        let current: Vec<BaseElement> = ood_current.iter().map(|&v| BaseElement::new(v)).collect();
        let next: Vec<BaseElement> = ood_next.iter().map(|&v| BaseElement::new(v)).collect();
        let mut constraints = [BaseElement::ZERO; MERKLE_UPDATE_NUM_CONSTRAINTS];
        evaluate_merkle_update_transition(&current, &next, &periodic_at_z, &mut constraints);
        let c_at_z = rlc_combine(&constraints, alpha);

        // Z_T(z) = (z^n - 1) / (z - g^(n-1))
        let last_row_x = trace_g.exp((trace_length - 1) as u64);
        let z_d = z.exp(trace_length as u64) - BaseElement::ONE;
        let z_t = z_d * (z - last_row_x).inv();

        // [C2] Add the boundary contribution that the prover folded into Q.
        let c_bnd = boundary_c_at_ood(
            CIRCUIT_MERKLE_UPDATE, &proof.public_inputs, &trace_root, &pub_bytes,
            b"bnd-c6\0\0", &ood_current, z, z_t, trace_g,
        );
        let c_total = c_at_z + c_bnd;

        let q_at_z = BaseElement::new(ood_quotient);
        assert_eq!(
            c_total,
            q_at_z * z_t,
            "end-to-end DEEP-ALI on generated circuit-6 proof failed"
        );
    }

    /// [P2.2d-C1] End-to-end: a proof produced by `generate_pool_commitment_proof`
    /// satisfies DEEP-ALI (C(z) == Q(z)·Z_T(z)) when C is the full 4-constraint
    /// RLC with α = `derive_rlc_alpha_with_tag(trace_root, pub_inputs, "rlc-c1")`.
    ///
    /// Closes the soundness gap identified in P2.2d:
    ///   - The single-cycle `evaluate_transition_constraint` only bound Poseidon
    ///     on cycle 0. The full 3-cycle `round_flag` in `build_pool_commitment_periodic_columns`
    ///     extends that to all 3 cycles.
    ///   - The chain constraint `next[1]@row64 = current[0]@row63` was not
    ///     enforced on-chain. The `chain_flag[63] = 1` periodic column now binds
    ///     epoch_hash from cycle 1 into cycle 2's right input at OOD DEEP-ALI.
    #[test]
    fn pool_commitment_proof_satisfies_deep_ali_end_to_end() {
        use crate::air::denominated_pool::{
            build_pool_commitment_periodic_columns, evaluate_pool_commitment_transition,
            POOL_COMMITMENT_NUM_CONSTRAINTS, POOL_COMMITMENT_NUM_PERIODIC,
            TRACE_LENGTH as POOL_TRACE_LENGTH, TRACE_WIDTH as POOL_TRACE_WIDTH,
        };

        let proof = generate_pool_commitment_proof(111, 222, 333, 444);
        assert_eq!(proof.circuit_id, CIRCUIT_POOL_COMMITMENT);
        assert_eq!(proof.public_inputs.len(), 2);

        // Parse header fields deterministically from the wire format.
        let bytes = &proof.proof_bytes;
        let mut off = 0usize;

        let mut trace_root = [0u8; 32];
        trace_root.copy_from_slice(&bytes[off..off + 32]);
        off += 32;
        let _quotient_root = &bytes[off..off + 32];
        off += 32;

        let mut ood_current = Vec::with_capacity(POOL_TRACE_WIDTH);
        for _ in 0..POOL_TRACE_WIDTH {
            ood_current.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let mut ood_next = Vec::with_capacity(POOL_TRACE_WIDTH);
        for _ in 0..POOL_TRACE_WIDTH {
            ood_next.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let ood_z = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
        off += 8;
        let ood_quotient = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());

        // Reconstruct public input bytes exactly as the prover built them.
        let null_u64 = proof.public_inputs[0];
        let commit_u64 = proof.public_inputs[1];
        let mut pub_bytes = Vec::new();
        pub_bytes.extend_from_slice(&null_u64.to_le_bytes());
        pub_bytes.extend_from_slice(&commit_u64.to_le_bytes());

        // Derive α with circuit-1 domain tag.
        let alpha = derive_rlc_alpha_with_tag(&trace_root, &pub_bytes, b"rlc-c1\0\0");

        // Evaluate the 6 periodic columns at z.
        let trace_length = POOL_TRACE_LENGTH;
        let trace_g = get_domain_generator_generic(trace_length);
        let z = BaseElement::new(ood_z);
        let periodic = build_pool_commitment_periodic_columns(trace_length);
        assert_eq!(periodic.len(), POOL_COMMITMENT_NUM_PERIODIC);
        let periodic_at_z: Vec<BaseElement> = periodic
            .iter()
            .map(|col| {
                let poly = inverse_ntt(col, trace_g);
                evaluate_poly(&poly, z)
            })
            .collect();

        // RLC of the 4 constraints at z.
        let current: Vec<BaseElement> = ood_current.iter().map(|&v| BaseElement::new(v)).collect();
        let next: Vec<BaseElement> = ood_next.iter().map(|&v| BaseElement::new(v)).collect();
        let mut constraints = [BaseElement::ZERO; POOL_COMMITMENT_NUM_CONSTRAINTS];
        evaluate_pool_commitment_transition(&current, &next, &periodic_at_z, &mut constraints);
        let c_at_z = rlc_combine(&constraints, alpha);

        // Z_T(z) = (z^n - 1) / (z - g^(n-1))
        let last_row_x = trace_g.exp((trace_length - 1) as u64);
        let z_d = z.exp(trace_length as u64) - BaseElement::ONE;
        let z_t = z_d * (z - last_row_x).inv();

        // [C2] Add the boundary contribution that the prover folded into Q.
        let c_bnd = boundary_c_at_ood(
            CIRCUIT_POOL_COMMITMENT, &proof.public_inputs, &trace_root, &pub_bytes,
            b"bnd-c1\0\0", &ood_current, z, z_t, trace_g,
        );
        let c_total = c_at_z + c_bnd;

        let q_at_z = BaseElement::new(ood_quotient);
        assert_eq!(
            c_total,
            q_at_z * z_t,
            "end-to-end DEEP-ALI on generated circuit-1 proof failed"
        );
    }

    /// [C2] Test-side mirror of the verifier's `boundary_fold_at_ood`:
    /// returns `z_t · Σ_j alpha_bnd^j (ood_current[col_j] − v_j)/(z − g^{r_j})`.
    fn boundary_c_at_ood(
        circuit_id: u8,
        public_inputs: &[u64],
        trace_root: &[u8; 32],
        pub_bytes: &[u8],
        tag: &[u8; 8],
        ood_current: &[u64],
        z: BaseElement,
        z_t: BaseElement,
        trace_g: BaseElement,
    ) -> BaseElement {
        let assertions = boundary_assertions_for_circuit(circuit_id, public_inputs);
        if assertions.is_empty() {
            return BaseElement::ZERO;
        }
        let alpha_bnd = derive_rlc_alpha_with_tag(trace_root, pub_bytes, tag);
        let mut acc = BaseElement::ZERO;
        let mut alpha_pow = BaseElement::ONE;
        for (col, row, v) in assertions {
            let g_r = trace_g.exp(row as u64);
            let denom = z - g_r;
            let num = BaseElement::new(ood_current[col]) - v;
            acc = acc + alpha_pow * (num * denom.inv());
            alpha_pow = alpha_pow * alpha_bnd;
        }
        acc * z_t
    }

    /// [P2.2d-C2] End-to-end: a proof produced by `generate_balance_compact_proof`
    /// satisfies DEEP-ALI (C(z) == Q(z)·Z_T(z)) when C is the full 7-constraint
    /// RLC with α = `derive_rlc_alpha_with_tag(trace_root, pub_inputs, "rlc-c2")`.
    ///
    /// Closes the soundness gap in circuit 2 (balance_proof):
    ///   - Poseidon on all 4 cycles (not just cycle 0).
    ///   - chain_01 @ row 31: cycle 0 output (current[0]) flows into cycle 1 left input (next[0]).
    ///   - carry_capture @ row 63: cycle 1 output (current[0]) flows into carry column next[3].
    ///   - carry_continuity: carry column holds value across rows [64..95] until chain_carry.
    ///   - chain_carry @ row 95: carry value (current[3]) flows into cycle 3 right input next[1].
    #[test]
    fn balance_proof_satisfies_deep_ali_end_to_end() {
        use crate::air::balance_proof::{
            build_balance_proof_periodic_columns, evaluate_balance_proof_transition,
            BALANCE_PROOF_NUM_CONSTRAINTS, BALANCE_PROOF_NUM_PERIODIC,
            TRACE_LENGTH as BAL_TRACE_LENGTH, TRACE_WIDTH as BAL_TRACE_WIDTH,
        };

        let proof = generate_balance_compact_proof(42, 1000, 777, 999);
        assert_eq!(proof.circuit_id, CIRCUIT_BALANCE_PROOF);
        assert_eq!(proof.public_inputs.len(), 2);

        // Parse header fields deterministically from the wire format.
        let bytes = &proof.proof_bytes;
        let mut off = 0usize;

        let mut trace_root = [0u8; 32];
        trace_root.copy_from_slice(&bytes[off..off + 32]);
        off += 32;
        let _quotient_root = &bytes[off..off + 32];
        off += 32;

        let mut ood_current = Vec::with_capacity(BAL_TRACE_WIDTH);
        for _ in 0..BAL_TRACE_WIDTH {
            ood_current.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let mut ood_next = Vec::with_capacity(BAL_TRACE_WIDTH);
        for _ in 0..BAL_TRACE_WIDTH {
            ood_next.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let ood_z = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
        off += 8;
        let ood_quotient = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());

        // Reconstruct public input bytes exactly as the prover built them.
        let commit_u64 = proof.public_inputs[0];
        let mint_u64 = proof.public_inputs[1];
        let mut pub_bytes = Vec::new();
        pub_bytes.extend_from_slice(&commit_u64.to_le_bytes());
        pub_bytes.extend_from_slice(&mint_u64.to_le_bytes());

        // Derive α with circuit-2 domain tag.
        let alpha = derive_rlc_alpha_with_tag(&trace_root, &pub_bytes, b"rlc-c2\0\0");

        // Evaluate the 8 periodic columns at z.
        let trace_length = BAL_TRACE_LENGTH;
        let trace_g = get_domain_generator_generic(trace_length);
        let z = BaseElement::new(ood_z);
        let periodic = build_balance_proof_periodic_columns(trace_length);
        assert_eq!(periodic.len(), BALANCE_PROOF_NUM_PERIODIC);
        let periodic_at_z: Vec<BaseElement> = periodic
            .iter()
            .map(|col| {
                let poly = inverse_ntt(col, trace_g);
                evaluate_poly(&poly, z)
            })
            .collect();

        // RLC of the 7 constraints at z.
        let current: Vec<BaseElement> = ood_current.iter().map(|&v| BaseElement::new(v)).collect();
        let next: Vec<BaseElement> = ood_next.iter().map(|&v| BaseElement::new(v)).collect();
        let mut constraints = [BaseElement::ZERO; BALANCE_PROOF_NUM_CONSTRAINTS];
        evaluate_balance_proof_transition(&current, &next, &periodic_at_z, &mut constraints);
        let c_at_z = rlc_combine(&constraints, alpha);

        // Z_T(z) = (z^n - 1) / (z - g^(n-1))
        let last_row_x = trace_g.exp((trace_length - 1) as u64);
        let z_d = z.exp(trace_length as u64) - BaseElement::ONE;
        let z_t = z_d * (z - last_row_x).inv();

        let q_at_z = BaseElement::new(ood_quotient);
        assert_eq!(
            c_at_z,
            q_at_z * z_t,
            "end-to-end DEEP-ALI on generated circuit-2 proof failed"
        );
    }

    /// [P2.2d-C3] End-to-end: a proof produced by `generate_merkle_path_compact_proof`
    /// satisfies DEEP-ALI (C(z) == Q(z)·Z_T(z)) when C is the full 11-constraint
    /// RLC with α derived from the `b"rlc-c3\0\0"`-tagged transcript.
    ///
    /// This is the pipeline test: it proves α, periodic evaluation, quotient
    /// computation, and OOD point derivation are mutually consistent between
    /// prover and a reconstructed verifier for circuit 3 at canonical depth=15.
    #[test]
    fn merkle_path_proof_satisfies_deep_ali_end_to_end() {
        use crate::air::merkle_path::{
            build_merkle_path_periodic_columns, evaluate_merkle_path_transition,
            CANONICAL_DEPTH, MERKLE_PATH_NUM_CONSTRAINTS, MERKLE_PATH_NUM_PERIODIC,
            TRACE_LENGTH as MP_TRACE_LENGTH, TRACE_WIDTH as MP_TRACE_WIDTH,
        };

        // Build a depth-15 path so the trace_length matches what the verifier
        // bakes into CONFIG_MERKLE_PATH (trace_length=512).
        let depth = CANONICAL_DEPTH; // 15
        let leaf = 7u64;
        let path_elements: Vec<u64> = (0..depth).map(|i| 1000 + i as u64).collect();
        let path_indices: Vec<u8> =
            (0..depth).map(|i| (i % 2) as u8).collect();

        let proof =
            generate_merkle_path_compact_proof(leaf, &path_elements, &path_indices);
        assert_eq!(proof.circuit_id, CIRCUIT_MERKLE_PATH);
        assert_eq!(proof.public_inputs.len(), 3);

        // Parse header fields deterministically from the wire format.
        let bytes = &proof.proof_bytes;
        let mut off = 0usize;

        let mut trace_root = [0u8; 32];
        trace_root.copy_from_slice(&bytes[off..off + 32]);
        off += 32;
        let _quotient_root = &bytes[off..off + 32];
        off += 32;

        let mut ood_current = Vec::with_capacity(MP_TRACE_WIDTH);
        for _ in 0..MP_TRACE_WIDTH {
            ood_current.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let mut ood_next = Vec::with_capacity(MP_TRACE_WIDTH);
        for _ in 0..MP_TRACE_WIDTH {
            ood_next.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let ood_z = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
        off += 8;
        let ood_quotient = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());

        // Reconstruct public input bytes exactly as the prover built them.
        let leaf_u64 = proof.public_inputs[0];
        let root_u64 = proof.public_inputs[1];
        let depth_u64 = proof.public_inputs[2];
        let mut pub_bytes = Vec::new();
        pub_bytes.extend_from_slice(&leaf_u64.to_le_bytes());
        pub_bytes.extend_from_slice(&root_u64.to_le_bytes());
        pub_bytes.extend_from_slice(&depth_u64.to_le_bytes());

        // Derive α with circuit-3 domain tag.
        let alpha = derive_rlc_alpha_with_tag(&trace_root, &pub_bytes, b"rlc-c3\0\0");

        // Evaluate the 7 periodic columns at z.
        let trace_length = MP_TRACE_LENGTH;
        let trace_g = get_domain_generator_generic(trace_length);
        let z = BaseElement::new(ood_z);
        let periodic = build_merkle_path_periodic_columns(depth, trace_length);
        assert_eq!(periodic.len(), MERKLE_PATH_NUM_PERIODIC);
        let periodic_at_z: Vec<BaseElement> = periodic
            .iter()
            .map(|col| {
                let poly = inverse_ntt(col, trace_g);
                evaluate_poly(&poly, z)
            })
            .collect();

        // RLC of the 11 constraints at z.
        let current: Vec<BaseElement> = ood_current.iter().map(|&v| BaseElement::new(v)).collect();
        let next: Vec<BaseElement> = ood_next.iter().map(|&v| BaseElement::new(v)).collect();
        let mut constraints = [BaseElement::ZERO; MERKLE_PATH_NUM_CONSTRAINTS];
        evaluate_merkle_path_transition(&current, &next, &periodic_at_z, &mut constraints);
        let c_at_z = rlc_combine(&constraints, alpha);

        // Z_T(z) = (z^n - 1) / (z - g^(n-1))
        let last_row_x = trace_g.exp((trace_length - 1) as u64);
        let z_d = z.exp(trace_length as u64) - BaseElement::ONE;
        let z_t = z_d * (z - last_row_x).inv();

        // [C2] Add the boundary contribution that the prover folded into Q.
        let c_bnd = boundary_c_at_ood(
            CIRCUIT_MERKLE_PATH, &proof.public_inputs, &trace_root, &pub_bytes,
            b"bnd-c3\0\0", &ood_current, z, z_t, trace_g,
        );
        let c_total = c_at_z + c_bnd;

        let q_at_z = BaseElement::new(ood_quotient);
        assert_eq!(
            c_total,
            q_at_z * z_t,
            "end-to-end DEEP-ALI on generated circuit-3 proof failed"
        );
    }

    /// [P2.2d-C4] End-to-end: a proof produced by
    /// `generate_confidential_balance_compact_proof` satisfies DEEP-ALI
    /// (C(z) == Q(z)·Z_T(z)) when C is the full 10-constraint RLC with α
    /// derived from the `b"rlc-c4\0\0"`-tagged transcript.
    #[test]
    fn confidential_balance_proof_satisfies_deep_ali_end_to_end() {
        use crate::air::confidential_balance::{
            build_confidential_balance_periodic_columns, evaluate_confidential_balance_transition,
            CONFIDENTIAL_BALANCE_NUM_CONSTRAINTS, CONFIDENTIAL_BALANCE_NUM_PERIODIC,
            TRACE_LENGTH as CB_TRACE_LENGTH, TRACE_WIDTH as CB_TRACE_WIDTH,
        };

        let proof = generate_confidential_balance_compact_proof(
            42, 1000, 111, 800, 222, 200, 333, 999,
        );
        assert_eq!(proof.circuit_id, CIRCUIT_CONFIDENTIAL_BALANCE);
        assert_eq!(proof.public_inputs.len(), 4);

        // Parse header fields deterministically from the wire format.
        let bytes = &proof.proof_bytes;
        let mut off = 0usize;

        let mut trace_root = [0u8; 32];
        trace_root.copy_from_slice(&bytes[off..off + 32]);
        off += 32;
        let _quotient_root = &bytes[off..off + 32];
        off += 32;

        let mut ood_current = Vec::with_capacity(CB_TRACE_WIDTH);
        for _ in 0..CB_TRACE_WIDTH {
            ood_current.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let mut ood_next = Vec::with_capacity(CB_TRACE_WIDTH);
        for _ in 0..CB_TRACE_WIDTH {
            ood_next.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let ood_z = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
        off += 8;
        let ood_quotient = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());

        // Reconstruct public input bytes exactly as the prover built them:
        // [old_commit, new_commit, amount_hash, token_mint].
        let mut pub_bytes = Vec::new();
        for v in &proof.public_inputs {
            pub_bytes.extend_from_slice(&v.to_le_bytes());
        }

        // Derive α with circuit-4 domain tag.
        let alpha = derive_rlc_alpha_with_tag(&trace_root, &pub_bytes, b"rlc-c4\0\0");

        // Evaluate the 11 periodic columns at z.
        let trace_length = CB_TRACE_LENGTH;
        let trace_g = get_domain_generator_generic(trace_length);
        let z = BaseElement::new(ood_z);
        let periodic = build_confidential_balance_periodic_columns();
        assert_eq!(periodic.len(), CONFIDENTIAL_BALANCE_NUM_PERIODIC);
        let periodic_at_z: Vec<BaseElement> = periodic
            .iter()
            .map(|col| {
                let poly = inverse_ntt(col, trace_g);
                evaluate_poly(&poly, z)
            })
            .collect();

        // RLC of the 10 constraints at z.
        let current: Vec<BaseElement> = ood_current.iter().map(|&v| BaseElement::new(v)).collect();
        let next: Vec<BaseElement> = ood_next.iter().map(|&v| BaseElement::new(v)).collect();
        let mut constraints = [BaseElement::ZERO; CONFIDENTIAL_BALANCE_NUM_CONSTRAINTS];
        evaluate_confidential_balance_transition(&current, &next, &periodic_at_z, &mut constraints);
        let c_at_z = rlc_combine(&constraints, alpha);

        // Z_T(z) = (z^n - 1) / (z - g^(n-1))
        let last_row_x = trace_g.exp((trace_length - 1) as u64);
        let z_d = z.exp(trace_length as u64) - BaseElement::ONE;
        let z_t = z_d * (z - last_row_x).inv();

        let q_at_z = BaseElement::new(ood_quotient);
        assert_eq!(
            c_at_z,
            q_at_z * z_t,
            "end-to-end DEEP-ALI on generated circuit-4 proof failed"
        );
    }

    /// [P2.2d-C5] End-to-end: a proof produced by
    /// `generate_transfer_compact_proof` satisfies DEEP-ALI
    /// (C(z) == Q(z)·Z_T(z)) when C is the full 23-constraint RLC with α
    /// derived from the `b"rlc-c5\0\0"`-tagged transcript. This closes the
    /// soundness gap on transfers: a prover cannot produce a valid wire
    /// format without the transition polynomial actually vanishing on the
    /// trace domain.
    #[test]
    fn transfer_proof_satisfies_deep_ali_end_to_end() {
        use crate::air::transfer::{
            build_transfer_periodic_columns, evaluate_transfer_transition,
            TRACE_LENGTH as TR_TRACE_LENGTH, TRACE_WIDTH as TR_TRACE_WIDTH,
            TRANSFER_NUM_CONSTRAINTS, TRANSFER_NUM_PERIODIC,
        };

        let proof = generate_transfer_compact_proof(
            42, 999, 100, 111, 50, 222, 80, 555, 333, 70, 666, 444, 0,
        );
        assert_eq!(proof.circuit_id, CIRCUIT_TRANSFER);
        assert_eq!(proof.public_inputs.len(), 6);

        // Parse header fields deterministically from the wire format.
        let bytes = &proof.proof_bytes;
        let mut off = 0usize;

        let mut trace_root = [0u8; 32];
        trace_root.copy_from_slice(&bytes[off..off + 32]);
        off += 32;
        let _quotient_root = &bytes[off..off + 32];
        off += 32;

        let mut ood_current = Vec::with_capacity(TR_TRACE_WIDTH);
        for _ in 0..TR_TRACE_WIDTH {
            ood_current.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let mut ood_next = Vec::with_capacity(TR_TRACE_WIDTH);
        for _ in 0..TR_TRACE_WIDTH {
            ood_next.push(u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap()));
            off += 8;
        }
        let ood_z = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());
        off += 8;
        let ood_quotient = u64::from_le_bytes(bytes[off..off + 8].try_into().unwrap());

        // Reconstruct public input bytes exactly as the prover built them:
        // [null_1, null_2, out_commit_1, out_commit_2, public_amount, token_mint].
        let mut pub_bytes = Vec::new();
        for v in &proof.public_inputs {
            pub_bytes.extend_from_slice(&v.to_le_bytes());
        }

        // Derive α with circuit-5 domain tag.
        let alpha = derive_rlc_alpha_with_tag(&trace_root, &pub_bytes, b"rlc-c5\0\0");

        // Evaluate the 23 periodic columns at z. Period-32 columns must first be
        // tiled to the full trace length so their IFT coefficient vector matches
        // what the on-chain verifier uses.
        let trace_length = TR_TRACE_LENGTH;
        let trace_g = get_domain_generator_generic(trace_length);
        let z = BaseElement::new(ood_z);
        let periodic_raw = build_transfer_periodic_columns();
        assert_eq!(periodic_raw.len(), TRANSFER_NUM_PERIODIC);

        let materialise = |col: &Vec<BaseElement>| -> Vec<BaseElement> {
            if col.len() == trace_length {
                col.clone()
            } else {
                let mut full = vec![BaseElement::ZERO; trace_length];
                for i in 0..trace_length {
                    full[i] = col[i % col.len()];
                }
                full
            }
        };

        let periodic_at_z: Vec<BaseElement> = periodic_raw
            .iter()
            .map(|col| {
                let poly = inverse_ntt(&materialise(col), trace_g);
                evaluate_poly(&poly, z)
            })
            .collect();

        // RLC of the 23 constraints at z.
        let current: Vec<BaseElement> = ood_current.iter().map(|&v| BaseElement::new(v)).collect();
        let next: Vec<BaseElement> = ood_next.iter().map(|&v| BaseElement::new(v)).collect();
        let mut constraints = [BaseElement::ZERO; TRANSFER_NUM_CONSTRAINTS];
        evaluate_transfer_transition(&current, &next, &periodic_at_z, &mut constraints);
        let c_at_z = rlc_combine(&constraints, alpha);

        // Z_T(z) = (z^n - 1) / (z - g^(n-1))
        let last_row_x = trace_g.exp((trace_length - 1) as u64);
        let z_d = z.exp(trace_length as u64) - BaseElement::ONE;
        let z_t = z_d * (z - last_row_x).inv();

        // [C2] Add the boundary contribution that the prover folded into Q.
        let c_bnd = boundary_c_at_ood(
            CIRCUIT_TRANSFER, &proof.public_inputs, &trace_root, &pub_bytes,
            b"bnd-c5\0\0", &ood_current, z, z_t, trace_g,
        );
        let c_total = c_at_z + c_bnd;

        let q_at_z = BaseElement::new(ood_quotient);
        assert_eq!(
            c_total,
            q_at_z * z_t,
            "end-to-end DEEP-ALI on generated circuit-5 proof failed"
        );
    }
}

/// RLC-combine constraint values: Σ α^i · c_i.
///
/// Used by the circuit-6 DEEP-ALI pipeline: a single α challenge fresh after
/// the trace commitment randomises the weighted sum so malicious constraint
/// violations cannot cancel deterministically. Prover and verifier derive
/// the same α from the trace root via Fiat-Shamir.
fn rlc_combine(constraints: &[BaseElement], alpha: BaseElement) -> BaseElement {
    let mut acc = BaseElement::ZERO;
    let mut alpha_power = BaseElement::ONE;
    for &c in constraints {
        acc = acc + alpha_power * c;
        alpha_power = alpha_power * alpha;
    }
    acc
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
pub const CIRCUIT_MERKLE_UPDATE: u8 = 6;

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
            sha256_leaf(&data)
        })
        .collect();

    let mut layers = vec![leaves];

    while layers.last().unwrap().len() > 1 {
        let prev = layers.last().unwrap();
        let next: Vec<[u8; 32]> = prev
            .chunks(2)
            .map(|pair| {
                let right = if pair.len() > 1 { &pair[1] } else { &pair[0] };
                sha256_node(&pair[0], right)
            })
            .collect();
        layers.push(next);
    }

    let root = layers.last().unwrap()[0];
    (root, layers)
}

/// [ROUTE C] Trace-commitment layout knob.
///
/// `Canonical` is the only variant a shipping prover ever uses; it is what the
/// on-chain verifier reconstructs. `LegacyRowLeaf` reproduces the PRE-Route-C
/// commitment *and* the pre-Route-C wire layout, so a test can build a
/// complete, internally consistent proof of the old format and assert the new
/// verifier rejects it. That is the version-skew seam: an old proof meeting a
/// new verifier must fail closed, never verify by accident.
///
/// Test-only; the public `generate_*` entry points all pass `Canonical`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TraceLeaf {
    /// [ROUTE C] `leaf[j] = H(0x00 ‖ row[j] ‖ row[j + N/2])` over `N/2` leaves,
    /// tree depth `log2(N) - 1`. Per query the wire carries FOUR rows
    /// (`pos`, `pos ^ N/2`, `next_pos`, `next_pos ^ N/2`) and two
    /// depth-`(log2(N) - 1)` paths.
    Canonical,
    /// Pre-Route-C: `leaf[t] = H(0x00 ‖ row[t])` over `N` leaves, tree depth
    /// `log2(N)`. Per query the wire carries TWO rows and two depth-`log2(N)`
    /// paths.
    LegacyRowLeaf,
}

/// [ROUTE C] Build a SHA-256 Merkle tree over **pair leaves of trace ROWS**.
///
/// Same shape as [`build_pair_merkle_tree`] (which pairs single field elements
/// for the quotient tree and the FRI layers), except each half of the leaf is a
/// whole `trace_width`-wide row:
///
/// ```text
///   leaf[j] = SHA256( 0x00 ‖ row[j][0..tw] ‖ row[j + N/2][0..tw] )   j in 0..N/2
/// ```
///
/// The tree has `N/2` leaves and depth `log2(N) - 1`, so ONE opening yields
/// both `T_i(x)` and `T_i(-x)`. Pre-Route-C the trace tree was
/// [`build_merkle_tree_generic`]: one leaf per row, `N` leaves, depth `log2(N)`,
/// and an opening bound one row only.
///
/// Byte order inside the leaf is `row_lo` then `row_hi`, each row being its
/// columns in ascending order as LE `u64`s, behind the leaf domain-separation
/// tag. The verifier reproduces this without a copy via
/// `merkle::hash_leaf_2seg(lo_row_bytes, hi_row_bytes)`, which is bit-identical
/// because `hashv` concatenates its segments.
///
/// This changes NO soundness property. It changes what one opening *makes
/// available* to a future check (`T_i(-x)`); nothing in this revision consumes
/// the mirror row.
///
/// # Cost, MEASURED
///
/// Per query the wire gains two rows (`+2 * trace_width * 8`) and loses two
/// Merkle levels (`-2 * 32`), i.e. `num_queries * (16 * trace_width - 64)` bytes.
/// Measured with the `cu_budget` harness (litesvm, real SBF bytecode) against the
/// pre-Route-C tagged baseline (`.so` sha256 `b5c7e01d…`→`e879bf30…` tagged,
/// 637,968→638,088 B) and the Route C build (`5eabc141…`, 638,248 B):
///
/// ```text
///   circuit   proof B before -> after    delta   closed form   phase-1 CU before -> after
///   C0            45,433 ->  45,001       -432       -432          480,335 ->  474,030
///   C1            66,233 ->  65,801       -432       -432          617,570 ->  612,719
///   C2            66,681 ->  66,681          0          0          618,739 ->  615,727
///   C3            74,933 ->  75,637       +704       +704          659,366 ->  655,666
///   C4            78,377 ->  78,377          0          0          704,685 ->  702,940
///   C5            75,301 ->  76,357     +1,056     +1,056          658,596 ->  659,304
///   C6            76,405 ->  78,517     +2,112     +2,112          661,697 ->  656,742
/// ```
///
/// 7/7 exact on the closed form. Phase-1 CU falls on six of seven (two fewer SHA
/// calls per query on the trace tree, minus the wider leaf preimage); C5 is the
/// one circuit that rises, by 708 CU. Worst phase 1 is still C4, 702,940 CU =
/// 50.2% of the 1,400,000 cap.
fn build_trace_pair_merkle_tree(
    lde: &[Vec<BaseElement>],
    trace_width: usize,
) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    let lde_size = lde[0].len();
    assert!(
        lde_size >= 2 && lde_size % 2 == 0,
        "pair-leaf trace tree needs an even, non-empty LDE"
    );
    let half = lde_size / 2;

    let leaves: Vec<[u8; 32]> = (0..half)
        .map(|j| {
            let mut data = vec![0u8; trace_width * 16];
            let hi_off = trace_width * 8;
            for col in 0..trace_width {
                data[col * 8..(col + 1) * 8]
                    .copy_from_slice(&lde[col][j].as_int().to_le_bytes());
                data[hi_off + col * 8..hi_off + (col + 1) * 8]
                    .copy_from_slice(&lde[col][j + half].as_int().to_le_bytes());
            }
            sha256_leaf(&data)
        })
        .collect();

    let mut layers = vec![leaves];

    while layers.last().unwrap().len() > 1 {
        let prev = layers.last().unwrap();
        let next: Vec<[u8; 32]> = prev
            .chunks(2)
            .map(|pair| {
                let right = if pair.len() > 1 { &pair[1] } else { &pair[0] };
                sha256_node(&pair[0], right)
            })
            .collect();
        layers.push(next);
    }

    let root = layers.last().unwrap()[0];
    (root, layers)
}

/// [B4] Pair-leaf layout knob.
///
/// `Canonical` is the only variant a shipping prover ever uses; it is what the
/// on-chain verifier reconstructs. The other two exist so tests can build a
/// **complete, internally consistent** prover that disagrees with the verifier
/// about pair indexing and assert that honest-looking proofs are rejected.
/// They are never reachable from the public `generate_*` entry points except
/// through the `#[doc(hidden)]` `*_with_pair_indexing` probes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PairIndexing {
    /// `leaf[j] = H(v[j] ‖ v[j + N/2])` — the shipping layout.
    Canonical,
    /// `leaf[j] = H(v[j + N/2] ‖ v[j])` — halves swapped inside the leaf.
    SwappedHalves,
    /// `leaf[(j+1) mod N/2] = H(v[j] ‖ v[j + N/2])` — pair one slot over.
    RotatedSlot,
    /// `SwappedHalves` on the FRI layers only; the quotient tree stays
    /// canonical. Lets a test reach the FRI-layer pair check, which the
    /// quotient check would otherwise short-circuit.
    SwappedHalvesFriOnly,
    /// `RotatedSlot` on the FRI layers only; quotient tree canonical.
    RotatedSlotFriOnly,
}

impl PairIndexing {
    /// Layout applied to the quotient (layer-0) tree.
    #[inline]
    fn quotient(self) -> Self {
        match self {
            PairIndexing::SwappedHalvesFriOnly | PairIndexing::RotatedSlotFriOnly => {
                PairIndexing::Canonical
            }
            other => other,
        }
    }

    /// Layout applied to every committed FRI layer.
    #[inline]
    fn fri(self) -> Self {
        match self {
            PairIndexing::SwappedHalvesFriOnly => PairIndexing::SwappedHalves,
            PairIndexing::RotatedSlotFriOnly => PairIndexing::RotatedSlot,
            other => other,
        }
    }
}

/// [B4] Tree slot that holds the pair `{v[j], v[j + half]}`.
#[inline]
fn pair_slot(j: usize, half: usize, mode: PairIndexing) -> usize {
    match mode {
        PairIndexing::RotatedSlot => (j + 1) % half,
        _ => j,
    }
}

/// [B4] 16-byte leaf preimage for the pair `{v[j], v[j + half]}`.
#[inline]
fn pair_leaf_preimage(values: &[u64], j: usize, half: usize, mode: PairIndexing) -> [u8; 16] {
    let (a, b) = match mode {
        PairIndexing::SwappedHalves => (values[j + half], values[j]),
        _ => (values[j], values[j + half]),
    };
    let mut buf = [0u8; 16];
    buf[..8].copy_from_slice(&a.to_le_bytes());
    buf[8..].copy_from_slice(&b.to_le_bytes());
    buf
}

/// [B4] Build a SHA-256 Merkle tree over **pair leaves** of a single-column
/// evaluation vector.
///
/// Leaf `j` (for `j` in `0..N/2`) commits BOTH halves of the FRI coset that a
/// fold consumes: `sha256(v[j].to_le_bytes() ‖ v[j+N/2].to_le_bytes())`.
/// The tree therefore has `N/2` leaves and depth `log2(N) - 1`; one opening
/// yields both values every fold identity needs, replacing the two
/// depth-`log2(N)` openings the pre-B4 format carried.
///
/// This replaces the former `build_quotient_merkle_tree` (one leaf per value)
/// and is used for the quotient LDE *and* for every committed FRI layer, so
/// prover and verifier can never drift apart between the two.
///
/// Precondition: `values.len()` is even and >= 2.
fn build_pair_merkle_tree(
    values: &[u64],
    mode: PairIndexing,
) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    let n = values.len();
    assert!(n >= 2 && n % 2 == 0, "pair-leaf tree needs an even, non-empty vector");
    let half = n / 2;

    let mut leaves: Vec<[u8; 32]> = vec![[0u8; 32]; half];
    for j in 0..half {
        leaves[pair_slot(j, half, mode)] = sha256_leaf(&pair_leaf_preimage(values, j, half, mode));
    }

    let mut layers = vec![leaves];

    while layers.last().unwrap().len() > 1 {
        let prev = layers.last().unwrap();
        let next: Vec<[u8; 32]> = prev
            .chunks(2)
            .map(|pair| {
                let right = if pair.len() > 1 { &pair[1] } else { &pair[0] };
                sha256_node(&pair[0], right)
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

/// [P2.2] Circuit 6 (merkle_update) target size. Uses the default 16 (matching
/// circuits 0-5). Earlier attempt set this to 256 to reduce FRI layer count,
/// but the ~1.1M CU Horner evaluation cost on-chain (256 × 22 queries × ~200 CU
/// per Goldilocks mul on BPF) swamped the 4 saved layers' ~175K merkle cost.
/// Must stay in sync with `CONFIG_MERKLE_UPDATE.fri_final_poly_size`.
pub(crate) const MERKLE_UPDATE_FRI_FINAL_POLY_SIZE: usize = 16;

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

/// [P2.2f] Derive the RLC challenge α for a DEEP-ALI circuit as
/// α = H(trace_root || pub_inputs || tag) reduced mod Goldilocks.
///
/// Fiat-Shamir ordering: α is sampled AFTER the prover commits to the trace
/// (so the prover cannot pick trace values to make a malicious constraint
/// violation cancel) and BEFORE the quotient LDE is built (so the quotient
/// root binds α). The verifier re-derives the same α from `trace_root` and
/// the public inputs and uses it to recombine the per-constraint evaluations
/// at the OOD point into C(z) for the DEEP-ALI identity C(z) = Q(z) · Z_T(z).
///
/// The 8-byte `tag` is a per-circuit domain separator (distinct from the
/// FRI fold challenges `derive_fri_alpha` and the OOD point
/// `derive_ood_point`). Canonical tags: `b"rlc-v1\0\0"` (circuit 6),
/// `b"rlc-c0\0\0"`..`b"rlc-c5\0\0"` (circuits 0..5). A separate tag per
/// circuit prevents a proof for one circuit from being repurposed as a
/// DEEP-ALI witness for another circuit with a colliding trace structure.
fn derive_rlc_alpha_with_tag(
    trace_root: &[u8; 32],
    pub_input_bytes: &[u8],
    tag: &[u8; 8],
) -> BaseElement {
    let mut transcript = Vec::with_capacity(32 + pub_input_bytes.len() + 8);
    transcript.extend_from_slice(trace_root);
    transcript.extend_from_slice(pub_input_bytes);
    transcript.extend_from_slice(tag);
    let h = sha256(&transcript);
    let mut alpha = u64::from_le_bytes(h[0..8].try_into().unwrap()) % GOLDILOCKS_PRIME;
    if alpha == 0 { alpha = 1; }
    BaseElement::new(alpha)
}

/// Circuit-6 RLC challenge (legacy tag `rlc-v1`, retained for backward
/// compatibility with the deployed on-chain verifier).
fn derive_rlc_alpha(trace_root: &[u8; 32], pub_input_bytes: &[u8]) -> BaseElement {
    derive_rlc_alpha_with_tag(trace_root, pub_input_bytes, b"rlc-v1\0\0")
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
/// domain shrinks to `fri_final_poly_size`, committing each intermediate layer
/// with Blake3 and extending the transcript after each commitment so that
/// subsequent fold challenges depend on prior roots.
///
/// Layer 0 is assumed pre-committed (via `quotient_root` in our case); this
/// function starts by deriving α_0 from `initial_transcript`.
///
/// [P2.2] `fri_final_poly_size` is now a parameter (was the global
/// `FRI_FINAL_POLY_SIZE`) — lets circuit 6 use a larger target (256) so the
/// on-chain verifier hits fewer FRI merkle rounds. Must match the verifier's
/// `CircuitConfig.fri_final_poly_size`.
///
/// [B4] Every committed layer is committed with `build_pair_merkle_tree`, so a
/// layer of size `N` has `N/2` leaves and depth `log2(N) - 1`. The smallest
/// committed layer is `2 * fri_final_poly_size` (= 32 for every shipping
/// circuit), i.e. 16 pair leaves — the pairing never degenerates. The final
/// layer is not committed at all (it is sent as `final_poly` coefficients), so
/// it is unaffected.
pub(crate) fn fri_commit_phase(
    initial_values: &[BaseElement],
    initial_domain_gen: BaseElement,
    initial_transcript: &[u8; 32],
    fri_final_poly_size: usize,
    pair_indexing: PairIndexing,
) -> FriCommitData {
    let mut current = initial_values.to_vec();
    let mut current_gen = initial_domain_gen;
    let mut transcript = *initial_transcript;

    let mut layer_roots: Vec<[u8; 32]> = Vec::new();
    let mut layer_trees: Vec<Vec<Vec<[u8; 32]>>> = Vec::new();
    let mut layer_values: Vec<Vec<BaseElement>> = Vec::new();
    let mut alphas: Vec<BaseElement> = Vec::new();

    while current.len() > fri_final_poly_size {
        // α_i derived from current transcript BEFORE the fold happens.
        let alpha = derive_fri_alpha(&transcript);
        alphas.push(alpha);

        // Fold: domain halves, new generator is gen².
        let folded = fri_fold_layer(&current, current_gen, alpha);
        let folded_gen = current_gen * current_gen;

        // Only commit if this is NOT the final fold — the final folded layer
        // reaches fri_final_poly_size and is transmitted as polynomial
        // coefficients (`final_poly`), so PR 3 verifies the last fold by
        // polynomial evaluation rather than Merkle opening.
        if folded.len() > fri_final_poly_size {
            let folded_u64: Vec<u64> = folded.iter().map(|f| f.as_int()).collect();
            let (root, tree) = build_pair_merkle_tree(&folded_u64, pair_indexing.fri());
            layer_roots.push(root);
            layer_trees.push(tree);
            layer_values.push(folded.clone());

            // Extend transcript with the new layer root; next α depends on it.
            transcript = extend_transcript(&transcript, &root);
        }

        current = folded;
        current_gen = folded_gen;
    }

    // Remaining `current` has exactly fri_final_poly_size evaluations.
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

/// [B4] Per-query FRI opening data. Contains, for each committed FRI layer,
/// **one** Merkle opening: the pair leaf holding both halves of the coset the
/// fold consumes. The fold identity
/// `f_{i+1}(y²) = (f_i(y)+f_i(-y))/2 + α_i · (f_i(y)-f_i(-y))/(2y)`
/// needs exactly `v[j]` and `v[j + N/2]`, which is exactly what one pair leaf
/// holds — so the pre-B4 two-openings-per-layer layout was carrying a whole
/// redundant path plus a redundant leaf hash.
///
/// `lo_values[i]` is `v[j]`, `hi_values[i]` is `v[j + N/2]`, with
/// `j = pos mod (size_{i+1}/2)`. Note the ordering is **canonical**, not
/// (at-pos, at-mirror): the leaf hash must not depend on which side of the
/// mirror the query landed on, or the tree would not be well defined.
pub(crate) struct FriQueryOpenings {
    pub lo_values: Vec<u64>,
    pub hi_values: Vec<u64>,
    pub pair_paths: Vec<Vec<[u8; 32]>>,
}

/// [B4] Extract per-query FRI pair openings from the commit phase data.
///
/// For each committed layer `i` (0-indexed; `layer_roots[i]` commits `f_{i+1}`
/// of size `N = lde_size / 2^(i+1)`), open the single pair leaf
/// `j = pos mod (N/2)` with a depth-`(log2(N) - 1)` path. Both `pos mod N` and
/// its mirror `(pos mod N) XOR (N/2)` reduce to the same `j`, which is why one
/// opening suffices.
pub(crate) fn extract_fri_query_openings(
    fri: &FriCommitData,
    query_pos: usize,
    lde_size: usize,
    mode: PairIndexing,
) -> FriQueryOpenings {
    let mut lo_values = Vec::with_capacity(fri.layer_roots.len());
    let mut hi_values = Vec::with_capacity(fri.layer_roots.len());
    let mut pair_paths = Vec::with_capacity(fri.layer_roots.len());

    for (i, layer) in fri.layer_values.iter().enumerate() {
        let size = layer.len();
        debug_assert_eq!(size, lde_size / (1 << (i + 1)));
        let half = size / 2;
        // pos mod N and (pos mod N) XOR N/2 both reduce to this pair index.
        let j = query_pos & (half - 1);
        // Pair tree has N/2 leaves => depth is one less than the value tree's.
        let pair_depth = (size as f64).log2() as usize - 1;

        lo_values.push(layer[j].as_int());
        hi_values.push(layer[j + half].as_int());
        pair_paths.push(get_merkle_proof_generic(
            &fri.layer_trees[i],
            pair_slot(j, half, mode.fri()),
            pair_depth,
        ));
    }

    FriQueryOpenings { lo_values, hi_values, pair_paths }
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

/// [P2.2d] Per-circuit quotient construction strategy.
///
/// `LegacyGeneric` is the pre-P2.2d broken path — single-cycle Poseidon flag,
/// cols 0-2 only, Q = C / Z_D without the wrap-row factor. Retained while
/// circuits 0, 2-5 are being rewritten; will be deleted once all are migrated.
/// Every new circuit must use the `CircuitN` variant with its dedicated
/// `compute_quotient_lde_circuit_N` pipeline mirroring `Circuit6`.
#[derive(Clone, Copy, Debug)]
pub(crate) enum QuotientSpec {
    LegacyGeneric,
    /// Circuit 1 (denominated pool commitment), trace width 3, length 128.
    Circuit1,
    /// Circuit 2 (balance proof), trace width 4, length 128.
    Circuit2,
    /// Circuit 3 (merkle path), trace width 6, variable depth.
    Circuit3 { depth: usize },
    /// Circuit 4 (confidential balance), trace width 4, length 256.
    Circuit4,
    /// Circuit 5 (transfer), trace width 6, length 512.
    Circuit5,
    /// Circuit 6 (merkle update), trace width 10, variable depth.
    Circuit6 { depth: usize },
}

/// [C2] Map a `QuotientSpec` to its boundary-fold parameters
/// `(circuit_id, alpha_tag)`, or `None` for circuits whose boundary fold is not
/// yet wired. The `alpha_tag` MUST match the verifier's
/// `derive_rlc_alpha_with_tag` tag used in `verify_deep_ali_circuit_N`'s
/// boundary section, so the per-assertion `alpha_bnd^j` powers are identical.
fn boundary_spec_for_quotient(spec: &QuotientSpec) -> Option<(u8, [u8; 8])> {
    match spec {
        QuotientSpec::Circuit1 => Some((1, *b"bnd-c1\0\0")),
        QuotientSpec::Circuit3 { .. } => Some((3, *b"bnd-c3\0\0")),
        QuotientSpec::Circuit5 => Some((5, *b"bnd-c5\0\0")),
        QuotientSpec::Circuit6 { .. } => Some((6, *b"bnd-c6\0\0")),
        // Circuits 2 and 4 boundary folds are deferred (no live exploit + extra
        // CU budget review needed). LegacyGeneric (C0) folds in the dedicated
        // legacy path, not here.
        _ => None,
    }
}

/// Generate a compact proof from an already-built trace.
///
/// [P2.2] `fri_final_poly_size` threads through to `fri_commit_phase`; see
/// the constants `FRI_FINAL_POLY_SIZE` (16 — circuits 0–5) and
/// `MERKLE_UPDATE_FRI_FINAL_POLY_SIZE` (256 — circuit 6). Must match the
/// on-chain verifier's `CircuitConfig.fri_final_poly_size`. `num_queries` is
/// also per-circuit (27 for circuits 0–5, 22 for circuit 6 — see
/// `MERKLE_UPDATE_NUM_QUERIES`).
fn generate_compact_proof_from_trace(
    trace: &[Vec<BaseElement>],
    pub_input_bytes: &[u8],
    blowup: usize,
    num_queries: usize,
    fri_final_poly_size: usize,
    quotient_spec: QuotientSpec,
) -> (Vec<u8>, [u8; 32]) {
    generate_compact_proof_from_trace_with_pair_indexing(
        trace,
        pub_input_bytes,
        blowup,
        num_queries,
        fri_final_poly_size,
        quotient_spec,
        PairIndexing::Canonical,
        TraceLeaf::Canonical,
    )
}

/// [B4 / ROUTE C fails-closed probe] `generate_compact_proof_from_trace` with
/// the quotient/FRI pair-leaf layout AND the trace-commitment layout selectable.
/// See `PairIndexing` and `TraceLeaf`.
fn generate_compact_proof_from_trace_with_pair_indexing(
    trace: &[Vec<BaseElement>],
    pub_input_bytes: &[u8],
    blowup: usize,
    num_queries: usize,
    fri_final_poly_size: usize,
    quotient_spec: QuotientSpec,
    pair_indexing: PairIndexing,
    trace_leaf: TraceLeaf,
) -> (Vec<u8>, [u8; 32]) {
    let trace_width = trace.len();
    let trace_length = trace[0].len();
    let lde_size = trace_length * blowup;
    let merkle_depth = (lde_size as f64).log2() as usize;

    // 1. Compute LDE
    let lde = compute_lde_generic(trace, blowup);

    // 2. [ROUTE C] Build the trace Merkle tree over PAIR leaves
    //    (`leaf[j] = H(row[j] ‖ row[j + lde_size/2])`, `lde_size/2` leaves,
    //    depth `merkle_depth - 1`). `LegacyRowLeaf` is the pre-Route-C tree and
    //    exists only so a test can build an old-format proof.
    let (root, tree) = match trace_leaf {
        TraceLeaf::Canonical => build_trace_pair_merkle_tree(&lde, trace_width),
        TraceLeaf::LegacyRowLeaf => build_merkle_tree_generic(&lde, trace_width),
    };

    // 3. [P1.1 / P2.2a / P2.2d-C1] Compute quotient values at ALL LDE positions
    // + commit. quotient_root is folded into the Fiat-Shamir transcript BEFORE
    // OOD/query derivation so the prover cannot choose values after seeing
    // challenges. DEEP-ALI circuits derive α from trace_root first, so
    // quotient_root also binds α implicitly.
    let lde_g = get_domain_generator_generic(lde_size);
    let mut all_quotient_values: Vec<u64> = match quotient_spec {
        QuotientSpec::Circuit6 { depth } => {
            let alpha = derive_rlc_alpha(&root, pub_input_bytes);
            compute_quotient_lde_circuit_6(&lde, blowup, trace_length, depth, alpha)
        }
        QuotientSpec::Circuit1 => {
            let alpha = derive_rlc_alpha_with_tag(&root, pub_input_bytes, b"rlc-c1\0\0");
            compute_quotient_lde_circuit_1(&lde, blowup, trace_length, alpha)
        }
        QuotientSpec::Circuit2 => {
            let alpha = derive_rlc_alpha_with_tag(&root, pub_input_bytes, b"rlc-c2\0\0");
            compute_quotient_lde_circuit_2(&lde, blowup, trace_length, alpha)
        }
        QuotientSpec::Circuit3 { depth } => {
            let alpha = derive_rlc_alpha_with_tag(&root, pub_input_bytes, b"rlc-c3\0\0");
            compute_quotient_lde_circuit_3(&lde, blowup, trace_length, depth, alpha)
        }
        QuotientSpec::Circuit4 => {
            let alpha = derive_rlc_alpha_with_tag(&root, pub_input_bytes, b"rlc-c4\0\0");
            compute_quotient_lde_circuit_4(&lde, blowup, trace_length, alpha)
        }
        QuotientSpec::Circuit5 => {
            let alpha = derive_rlc_alpha_with_tag(&root, pub_input_bytes, b"rlc-c5\0\0");
            compute_quotient_lde_circuit_5(&lde, blowup, trace_length, alpha)
        }
        QuotientSpec::LegacyGeneric => (0..lde_size)
            .map(|pos| {
                compute_quotient_at_position_generic(
                    &lde, pos, blowup, trace_length, trace_width, NUM_ROUNDS, &lde_g,
                )
            })
            .collect(),
    };

    // [C2] Fold the boundary public-input binding into the committed quotient.
    //
    // For circuits with a defined boundary-assertion set, build the boundary
    // quotient polynomial Q_bnd(x) = Σ_j alpha_bnd^j (T_col_j(x) − v_j)/(x − g^{r_j})
    // (each term an exact polynomial), evaluate it on the LDE domain, and add to
    // the committed quotient values. The verifier recomputes the matching term
    // at the OOD point z. Public-input binding is then enforced at z on every
    // proof instead of only at trace-aligned query positions.
    if let Some((circuit_id, alpha_tag)) = boundary_spec_for_quotient(&quotient_spec) {
        let public_inputs: Vec<u64> = pub_input_bytes
            .chunks_exact(8)
            .map(|c| u64::from_le_bytes(c.try_into().unwrap()))
            .collect();
        let assertions = boundary_assertions_for_circuit(circuit_id, &public_inputs);
        if !assertions.is_empty() {
            let trace_g_b = get_domain_generator_generic(trace_length);
            let trace_polys: Vec<Vec<BaseElement>> =
                (0..trace_width).map(|col| inverse_ntt(&trace[col], trace_g_b)).collect();
            let alpha_bnd = derive_rlc_alpha_with_tag(&root, pub_input_bytes, &alpha_tag);
            let mut qb_poly: Vec<BaseElement> = Vec::new();
            fold_boundary_quotient(&mut qb_poly, &trace_polys, &assertions, trace_g_b, alpha_bnd);
            // Evaluate Q_bnd on the LDE domain and add to the committed quotient.
            for (pos, qv) in all_quotient_values.iter_mut().enumerate() {
                let x = lde_g.exp(pos as u64);
                let add = evaluate_poly(&qb_poly, x);
                *qv = (BaseElement::new(*qv) + add).as_int();
            }
        }
    }

    let (quotient_root, quotient_tree) =
        build_pair_merkle_tree(&all_quotient_values, pair_indexing.quotient());

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
    let fri = fri_commit_phase(
        &quotient_felts,
        lde_g,
        &initial_fri_transcript,
        fri_final_poly_size,
        pair_indexing,
    );

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

        // [ROUTE C] Four trace rows travel per query instead of two:
        //   row(pos) | row(pos ^ half) | row(next_pos) | row(next_pos ^ half)
        // Each mirror row is the OTHER half of a pair leaf that had to be opened
        // anyway, so it costs `trace_width * 8` bytes on the wire and removes one
        // Merkle level from each of the two trace paths. Net per query:
        // `16 * trace_width - 64` bytes.
        //
        // Nothing in THIS revision reads the mirror rows. They are the input a
        // later DEEP-composition recomputation needs; shipping them changes no
        // soundness property today.
        let t_half = lde_size / 2;
        let mirror_pos = pos ^ t_half;
        let next_mirror_pos = next_pos ^ t_half;

        // trace_values at pos
        for col in 0..trace_width {
            bytes.extend_from_slice(&lde[col][pos].as_int().to_le_bytes());
        }
        if trace_leaf == TraceLeaf::Canonical {
            // trace_mirror_values at pos ^ half
            for col in 0..trace_width {
                bytes.extend_from_slice(&lde[col][mirror_pos].as_int().to_le_bytes());
            }
        }
        // next_trace_values at next_pos
        for col in 0..trace_width {
            bytes.extend_from_slice(&lde[col][next_pos].as_int().to_le_bytes());
        }
        if trace_leaf == TraceLeaf::Canonical {
            // next_trace_mirror_values at next_pos ^ half
            for col in 0..trace_width {
                bytes.extend_from_slice(&lde[col][next_mirror_pos].as_int().to_le_bytes());
            }
        }

        // [ROUTE C] Trace openings. Canonical: pair index `pos mod half` into
        // the pair tree, depth `merkle_depth - 1`. LegacyRowLeaf: row index
        // `pos` into the row tree, depth `merkle_depth`.
        let (trace_index, next_trace_index, trace_path_depth) = match trace_leaf {
            TraceLeaf::Canonical => (pos & (t_half - 1), next_pos & (t_half - 1), merkle_depth - 1),
            TraceLeaf::LegacyRowLeaf => (pos, next_pos, merkle_depth),
        };
        let path = get_merkle_proof_generic(&tree, trace_index, trace_path_depth);
        for node in &path {
            bytes.extend_from_slice(node);
        }
        let next_path = get_merkle_proof_generic(&tree, next_trace_index, trace_path_depth);
        for node in &next_path {
            bytes.extend_from_slice(node);
        }
        // [B4] quotient pair opening: mirror value(8) + ONE path((md-1)*32).
        // `pos` and `pos ^ (lde_size/2)` share the pair leaf
        // `j = pos mod (lde_size/2)`, so one path authenticates both `f_0(y)`
        // and `f_0(-y)`. The value at `pos` itself is in the tail
        // `quotient_values` array (the constraint / DEEP-ALI code reads it
        // from there), so only the mirror value is written here.
        let quotient_mirror_pos = pos ^ (lde_size / 2);
        bytes.extend_from_slice(&all_quotient_values[quotient_mirror_pos].to_le_bytes());
        let q_half = lde_size / 2;
        let q_pair_path = get_merkle_proof_generic(
            &quotient_tree,
            pair_slot(pos & (q_half - 1), q_half, pair_indexing.quotient()),
            merkle_depth - 1,
        );
        for node in &q_pair_path {
            bytes.extend_from_slice(node);
        }
        // [B4] FRI layer openings: one pair (lo, hi) + one path per committed layer.
        let fri_openings = extract_fri_query_openings(&fri, pos, lde_size, pair_indexing);
        for i in 0..fri_openings.lo_values.len() {
            bytes.extend_from_slice(&fri_openings.lo_values[i].to_le_bytes());
            bytes.extend_from_slice(&fri_openings.hi_values[i].to_le_bytes());
            for node in &fri_openings.pair_paths[i] {
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
/// [P2.2] Circuit 6 uses fewer queries (22 vs 27) to fit its 10-col trace
/// under the 1.4M Solana BPF CU cap. Soundness: 22×4 + 16 = 104 bits,
/// still well above the 100-bit classical floor.
const MERKLE_UPDATE_NUM_QUERIES: usize = 22;
/// [P2.2g] Circuits 3 and 5 (width=6, trace=512, lde=8192) also drop to 22
/// queries so phase-1 FRI + per-query checks fits within 1.4M CU. DEEP-ALI
/// still runs, but in phase 2 (`verify_deep_ali_phase2`). Soundness identical
/// to C6: 22×4 + 16 = 104 bits.
const HEAVY_GENERIC_NUM_QUERIES: usize = 22;

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
    generate_pool_commitment_proof_with_pair_indexing(
        nullifier_preimage,
        secret,
        deposit_epoch,
        token_mint,
        PairIndexing::Canonical,
    )
}

/// [B4 fails-closed probe] `generate_pool_commitment_proof` with the pair-leaf
/// layout selectable. Only `PairIndexing::Canonical` matches the on-chain
/// verifier; the other variants build a complete, internally consistent proof
/// under a different pair indexing, which the verifier must reject. Test-only.
#[doc(hidden)]
pub fn generate_pool_commitment_proof_with_pair_indexing(
    nullifier_preimage: u64,
    secret: u64,
    deposit_epoch: u64,
    token_mint: u64,
    pair_indexing: PairIndexing,
) -> GenericCompactProofData {
    generate_pool_commitment_proof_with_layout(
        nullifier_preimage,
        secret,
        deposit_epoch,
        token_mint,
        pair_indexing,
        TraceLeaf::Canonical,
    )
}

/// [ROUTE C fails-closed probe] `generate_pool_commitment_proof` with the
/// TRACE-commitment layout selectable. `TraceLeaf::LegacyRowLeaf` builds a
/// complete, internally consistent proof in the PRE-Route-C format (row-leaf
/// trace tree, two rows and two full-depth paths per query); the Route C
/// verifier must reject it. Test-only.
///
/// C1 has `trace_width = 3`, so the two layouts have DIFFERENT per-query strides
/// (`16*3 - 64 = -16` bytes). See
/// `generate_confidential_balance_compact_proof_with_trace_leaf` for the
/// `trace_width = 4` case, where the strides are byte-for-byte identical and the
/// Merkle check is therefore the only thing standing between an old proof and
/// acceptance.
#[doc(hidden)]
pub fn generate_pool_commitment_proof_with_trace_leaf(
    nullifier_preimage: u64,
    secret: u64,
    deposit_epoch: u64,
    token_mint: u64,
    trace_leaf: TraceLeaf,
) -> GenericCompactProofData {
    generate_pool_commitment_proof_with_layout(
        nullifier_preimage,
        secret,
        deposit_epoch,
        token_mint,
        PairIndexing::Canonical,
        trace_leaf,
    )
}

fn generate_pool_commitment_proof_with_layout(
    nullifier_preimage: u64,
    secret: u64,
    deposit_epoch: u64,
    token_mint: u64,
    pair_indexing: PairIndexing,
    trace_leaf: TraceLeaf,
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

    let (proof_bytes, root) = generate_compact_proof_from_trace_with_pair_indexing(
        &trace,
        &pub_bytes,
        GENERIC_BLOWUP,
        GENERIC_NUM_QUERIES,
        FRI_FINAL_POLY_SIZE,
        QuotientSpec::Circuit1,
        pair_indexing,
        trace_leaf,
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
        &trace,
        &pub_bytes,
        GENERIC_BLOWUP,
        GENERIC_NUM_QUERIES,
        FRI_FINAL_POLY_SIZE,
        QuotientSpec::Circuit2,
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
    // [C3 depth binding] depth is the 3rd public input. It MUST be folded into
    // the Fiat-Shamir transcript (pub_bytes) so the on-chain verifier — which
    // recomputes the transcript from its `public_inputs` — stays byte-for-byte
    // consistent and can reject any depth != CANONICAL_DEPTH. Mirrors C6.
    let depth = path_elements.len() as u64;
    let mut pub_bytes = Vec::new();
    pub_bytes.extend_from_slice(&leaf.to_le_bytes());
    pub_bytes.extend_from_slice(&root_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&depth.to_le_bytes());

    let (proof_bytes, merkle_root) = generate_compact_proof_from_trace(
        &trace,
        &pub_bytes,
        GENERIC_BLOWUP,
        HEAVY_GENERIC_NUM_QUERIES,
        FRI_FINAL_POLY_SIZE,
        QuotientSpec::Circuit3 { depth: path_elements.len() },
    );

    GenericCompactProofData {
        proof_bytes,
        circuit_id: CIRCUIT_MERKLE_PATH,
        public_inputs: vec![leaf, root_u64, depth],
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
    generate_confidential_balance_compact_proof_with_trace_leaf(
        spending_key, old_balance, old_salt, new_balance, new_salt, amount, amount_salt,
        token_mint, TraceLeaf::Canonical,
    )
}

/// [ROUTE C fails-closed probe] `generate_confidential_balance_compact_proof`
/// with the trace-commitment layout selectable.
///
/// C4 is the sharp version-skew case: `trace_width == 4`, so
/// `16 * trace_width - 64 == 0` and an old-format proof is EXACTLY the same
/// number of bytes as a new-format one. Every length check in the parser passes,
/// every field boundary lines up, the transcript is self-consistent — the only
/// thing left to reject it is the pair-leaf Merkle check itself. Test-only.
#[doc(hidden)]
#[allow(clippy::too_many_arguments)]
pub fn generate_confidential_balance_compact_proof_with_trace_leaf(
    spending_key: u64,
    old_balance: u64,
    old_salt: u64,
    new_balance: u64,
    new_salt: u64,
    amount: u64,
    amount_salt: u64,
    token_mint: u64,
    trace_leaf: TraceLeaf,
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

    let (proof_bytes, root) = generate_compact_proof_from_trace_with_pair_indexing(
        &trace,
        &pub_bytes,
        GENERIC_BLOWUP,
        GENERIC_NUM_QUERIES,
        FRI_FINAL_POLY_SIZE,
        QuotientSpec::Circuit4,
        PairIndexing::Canonical,
        trace_leaf,
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
        &trace,
        &pub_bytes,
        GENERIC_BLOWUP,
        HEAVY_GENERIC_NUM_QUERIES,
        FRI_FINAL_POLY_SIZE,
        QuotientSpec::Circuit5,
    );

    GenericCompactProofData {
        proof_bytes,
        circuit_id: CIRCUIT_TRANSFER,
        public_inputs: vec![n1_u64, n2_u64, oc1_u64, oc2_u64, public_amount, token_mint],
        root,
    }
}

/// Generate compact proof for Merkle update (leaf replacement).
///
/// Proves: replacing `old_leaf` by `new_leaf` at the position defined by
/// `path_indices` with siblings `path_elements` transforms `old_root` into
/// `new_root`.
///
/// Public inputs: old_leaf, new_leaf, old_root, new_root, depth
///
/// Soundness note: the compact proof framework's quotient only binds the OLD
/// Poseidon chain (cols 0-2). The NEW chain (cols 3-5) and the shared path
/// witnesses (cols 6-9) are bound by the Merkle commitment of the full trace
/// plus the on-chain verifier's per-query constraint re-evaluation (see
/// `verify_constraints_merkle_update`). This matches the soundness model used
/// by circuits 3-5 (wider traces with carry columns).
pub fn generate_merkle_update_compact_proof(
    old_leaf: u64,
    new_leaf: u64,
    path_elements: &[u64],
    path_indices: &[u8],
) -> GenericCompactProofData {
    let old_leaf_felt = BaseElement::new(old_leaf);
    let new_leaf_felt = BaseElement::new(new_leaf);
    let elems: Vec<BaseElement> = path_elements.iter().map(|&v| BaseElement::new(v)).collect();

    let trace = crate::air::merkle_update::build_merkle_update_trace(
        old_leaf_felt, new_leaf_felt, &elems, path_indices,
    );
    let (old_root, new_root) = crate::air::merkle_update::compute_update_roots(
        old_leaf_felt, new_leaf_felt, &elems, path_indices,
    );

    let old_root_u64 = old_root.as_int();
    let new_root_u64 = new_root.as_int();
    let depth = path_elements.len() as u64;

    let mut pub_bytes = Vec::new();
    pub_bytes.extend_from_slice(&old_leaf.to_le_bytes());
    pub_bytes.extend_from_slice(&new_leaf.to_le_bytes());
    pub_bytes.extend_from_slice(&old_root_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&new_root_u64.to_le_bytes());
    pub_bytes.extend_from_slice(&depth.to_le_bytes());

    let (proof_bytes, merkle_root) = generate_compact_proof_from_trace(
        &trace,
        &pub_bytes,
        GENERIC_BLOWUP,
        MERKLE_UPDATE_NUM_QUERIES,
        MERKLE_UPDATE_FRI_FINAL_POLY_SIZE,
        QuotientSpec::Circuit6 { depth: path_elements.len() },
    );

    GenericCompactProofData {
        proof_bytes,
        circuit_id: CIRCUIT_MERKLE_UPDATE,
        public_inputs: vec![old_leaf, new_leaf, old_root_u64, new_root_u64, depth],
        root: merkle_root,
    }
}
