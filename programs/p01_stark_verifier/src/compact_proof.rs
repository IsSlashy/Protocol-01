/// Compact STARK proof format for on-chain verification.
///
/// Supports multiple circuits with different trace dimensions.
/// The circuit_id (stored in ProofBuffer) determines the trace width
/// and Merkle depth used for deserialization.
///
/// **Memory model (P1.6).** All path/value arrays are borrowed slices (`&'a [u8]`)
/// into the caller-provided proof buffer — there are no owned `Vec<[u8;32]>`
/// path copies. FRI proofs for the largest circuits (~120KB) used to parse into
/// ~200KB of owned `Vec<Vec<[u8;32]>>` under Solana's bump allocator (no reclaim),
/// immediately OOM-ing the default 32KB BPF heap. The slice-view refactor keeps
/// parse-time heap usage at ~6–8KB (small `Vec<QueryProof>` plus a few field
/// arrays) so the default allocator is enough.
///
/// Field access goes through typed accessors (`trace_value(col)`, `fri_path(i)`,
/// `quotient_value(idx)`, …) which slice the underlying bytes on demand and
/// decode `Felt`s one at a time. This keeps verify.rs unchanged structurally —
/// what used to be `query.merkle_path` (a `&[[u8;32]]`) is now
/// `query.merkle_path()` (a `&[u8]`), which the Merkle verifier iterates in
/// 32-byte chunks.
use crate::goldilocks::Felt;

// ============================================================================
// Circuit configurations
// ============================================================================

/// Circuit parameters for deserialization and verification.
pub struct CircuitConfig {
    pub trace_width: usize,
    pub trace_length: usize,
    pub blowup: usize,
    pub lde_size: usize,
    pub merkle_depth: usize,
    pub num_rounds: usize,
    /// [P2.2] Target size of the FRI final polynomial (coefficients).
    /// Prover folds the quotient LDE down to this size; remaining polynomial
    /// is sent in the clear so the verifier can evaluate at any domain point.
    /// Larger values trade off Horner eval CU (linear in size) against fewer
    /// FRI merkle layers. Tuned per-circuit to fit in the 1.4M CU cap.
    pub fri_final_poly_size: usize,
    /// [B1] Number of final-poly coefficients the verifier ALLOWS to be non-zero.
    /// MEASURED per circuit; see `VerifyError::FriFinalPolyDegreeTooHigh` for why
    /// it exists, and `quotient_segmentation_is_measured_not_assumed` in
    /// `tests/b1_deep_binding.rs` for where the number comes from.
    ///
    /// `fri_final_poly_size` stays 16 on the wire (a smaller field would mean one
    /// more fold, one more committed layer and one more pair opening per query —
    /// larger proofs to save 64 bytes). The extra slots must be provable zeros.
    ///
    /// The rate is invariant under folding, so `bound / fri_final_poly_size` IS
    /// the FRI rate rho. [B2] That is 1/16 on all seven circuits now; it was 8/16
    /// before segmentation. Read it off this field — never assume `1/blowup`, and
    /// never quote `log2(blowup)` without checking that the bound really is 1.
    pub fri_final_poly_degree_bound: usize,
    /// [B2] Number of degree-`< trace_length` columns the committed quotient is
    /// split into, `k = ceil((deg(Q) + 1) / trace_length)`.
    ///
    /// This is the field that makes `fri_final_poly_degree_bound` 1. The DEEP
    /// composition gives each segment its own gamma power, so
    /// `deg(D) = trace_length - 2` regardless of the AIR's constraint degree, and
    /// `rho = 1/blowup` becomes an invariant of the construction rather than an
    /// accident of the AIR.
    ///
    /// It is also a WIRE parameter and never travels on the wire: `ood_quotient`
    /// is `k` felts, each query carries `k` mirror felts, and the tail carries `k`
    /// felts per query. A prover that disagrees with this constant produces a
    /// buffer the parser rejects on length — it cannot renegotiate the split.
    pub quotient_segments: usize,
    /// [P2.2] Number of FRI queries.
    ///
    /// [B2] The query term is `num_queries * log2(1/rho) + grinding_bits` at the
    /// MEASURED rho = `fri_final_poly_degree_bound / fri_final_poly_size`, which
    /// post-segmentation is 1/16 — 4.000 bits per query, where pre-B2 it was
    /// 1.000. It was NEVER `num_queries * log2(blowup)` by assumption.
    ///
    /// The query term is not the answer. Every Fiat-Shamir challenge here is a
    /// single base-field Goldilocks element, so the argument has a hard field
    /// floor of `64 - log2(8n + w + k + 1 + folds*lde_size)` that grinding cannot
    /// lift (the nonce is absorbed after z, gamma and every alpha). On all seven
    /// circuits the query term OVERSHOOTS that floor, so the honest figure is the
    /// floor: 47-52 bits conjectured, 42-46 unconditional. Both columns are
    /// derived from this struct and asserted in `tests/b1_deep_binding.rs`.
    pub num_queries: usize,
}

/// subscriber_ownership: 3 cols, 32 rows
pub const CONFIG_SUBSCRIBER_OWNERSHIP: CircuitConfig = CircuitConfig {
    trace_width: 3,
    trace_length: 32,
    blowup: 16,
    lde_size: 512,
    merkle_depth: 9,   // log2(512) = 9
    num_rounds: 30,
    fri_final_poly_size: 16,
    fri_final_poly_degree_bound: 1, // [B2] MEASURED post-segmentation
    quotient_segments: 7,           // [B2] ceil(218 / 32), MEASURED
    num_queries: NUM_QUERIES,
};

/// pool_commitment: 3 cols, 128 rows
pub const CONFIG_POOL_COMMITMENT: CircuitConfig = CircuitConfig {
    trace_width: 3,
    trace_length: 128,
    blowup: 16,
    lde_size: 2048,
    merkle_depth: 11,  // log2(2048) = 11
    num_rounds: 30,
    fri_final_poly_size: 16,
    fri_final_poly_degree_bound: 1, // [B2] MEASURED post-segmentation
    quotient_segments: 8,           // [B2] ceil((8n-7)/n), MEASURED
    num_queries: NUM_QUERIES,
};

/// balance_proof: 4 cols, 128 rows
pub const CONFIG_BALANCE_PROOF: CircuitConfig = CircuitConfig {
    trace_width: 4,
    trace_length: 128,
    blowup: 16,
    lde_size: 2048,
    merkle_depth: 11,  // log2(2048) = 11
    num_rounds: 30,
    fri_final_poly_size: 16,
    fri_final_poly_degree_bound: 1, // [B2] MEASURED post-segmentation
    quotient_segments: 8,           // [B2] ceil((8n-7)/n), MEASURED
    num_queries: NUM_QUERIES,
};

/// merkle_path: 6 cols, variable length (512 for depth 15)
///
/// [P2.2g] num_queries dropped 27→22 so phase-1 FRI (LDE=8192, 13 merkle
/// layers per query) fits under the 1.4M Solana BPF CU cap. DEEP-ALI is
/// split off to `verify_deep_ali_phase2` (same as circuit 6).
///
/// [B1] Soundness is 22 * 1.000 + 16 = ~38 bits at the MEASURED rate, not the
/// 22*4 + 16 = 104 this comment used to claim. See `num_queries` on
/// `CircuitConfig`.
pub const CONFIG_MERKLE_PATH: CircuitConfig = CircuitConfig {
    trace_width: 6,
    trace_length: 512, // depth 15: 15 * 32 = 480, next_pow2 = 512
    blowup: 16,
    lde_size: 8192,
    merkle_depth: 13,  // log2(8192) = 13
    num_rounds: 30,
    fri_final_poly_size: 16,
    fri_final_poly_degree_bound: 1, // [B2] MEASURED post-segmentation
    quotient_segments: 8,           // [B2] ceil((8n-7)/n), MEASURED
    num_queries: 22,
};

/// confidential_balance: 4 cols, 256 rows (7 hash cycles of 32 + 1 padding cycle)
pub const CONFIG_CONFIDENTIAL_BALANCE: CircuitConfig = CircuitConfig {
    trace_width: 4,
    trace_length: 256,
    blowup: 16,
    lde_size: 4096,
    merkle_depth: 12,  // log2(4096) = 12
    num_rounds: 30,
    fri_final_poly_size: 16,
    fri_final_poly_degree_bound: 1, // [B2] MEASURED post-segmentation
    quotient_segments: 8,           // [B2] ceil((8n-7)/n), MEASURED
    num_queries: NUM_QUERIES,
};

/// transfer: 7 cols, 512 rows (14 hash cycles of 32 + 2 padding cycles)
///
/// [P2.2g] num_queries dropped 27→22 for the same reason as merkle_path:
/// LDE=8192 with the transition polynomial pushes phase-1 FRI above 1.4M CU
/// at 27 queries.
///
/// [B1] Soundness is ~38 bits (22 * 1.000 + 16), not the 104 this comment used
/// to claim.
///
/// [#2 voie A — REBAKE DONE] The prover/AIR side in
/// `stark/src/air/transfer.rs` enforces value conservation: trace width is
/// now **7** (col 6 = signed amount accumulator), transition constraints
/// **28** (was 23: +4 amount captures +1 acc continuity), periodic columns
/// **28** (was 23: +`add_in1`, `add_in2`, `sub_out1`, `sub_out2`,
/// `acc_continuity`), and there are **26** boundary assertions (was 24:
/// +`acc@row0 = 0`, +`acc@row385 = public_amount`). This `CONFIG_TRANSFER`
/// and the C5 verifier routines (`evaluate_transition_at_ood_circuit_5`, the
/// `[Felt; 28]` periodic array, the `[Felt; 7]` OOD arrays,
/// `get_boundary_assertions(5, …)`, `verify_constraints_transfer`, and the
/// baked `C5_*_COEFFS` set in `periodic_consts.rs`) were rebaked to the
/// width-7 / 28-constraint format and re-validated under the 1.4M-CU SBF cap.
pub const CONFIG_TRANSFER: CircuitConfig = CircuitConfig {
    trace_width: 7,
    trace_length: 512,
    blowup: 16,
    lde_size: 8192,
    merkle_depth: 13,  // log2(8192) = 13
    num_rounds: 30,
    fri_final_poly_size: 16,
    fri_final_poly_degree_bound: 1, // [B2] MEASURED post-segmentation
    quotient_segments: 8,           // [B2] ceil((8n-7)/n), MEASURED
    num_queries: 22,
};

/// merkle_update: 10 cols (OLD Poseidon 0-2, NEW Poseidon 3-5, sibling 6, dir 7,
/// old_carry 8, new_carry 9), 512 rows (max depth 16 ≤ 16 * 32 = 512).
///
/// The 10-col trace inflates per-query merkle + constraint-eval CU relative
/// to every other circuit (3–6 cols). Two knobs were tuned to fit the 1.4M
/// BPF CU cap:
///
/// - `num_queries = 22` (vs 27 for circuits 0-5): 18.5% fewer per-query
///   merkle paths, constraint evaluations, and Horner calls. Saves ~200k CU.
///
/// [B1] This block used to say `fri_final_poly_size = 256`, which was never true
/// against the constant below (16), and to quote 124 -> 104 bits from
/// `num_queries * log2(blowup)`, which is the wrong formula. The real figures are
/// ~43 bits at 27 queries and ~38 at 22, at the MEASURED rate of 1.000 bits per
/// query. verify.rs used to carry a THIRD number for the same 16 ("circuit 6
/// uses 64"); that is gone too.
pub const CONFIG_MERKLE_UPDATE: CircuitConfig = CircuitConfig {
    trace_width: 10,
    trace_length: 512,
    blowup: 16,
    lde_size: 8192,
    merkle_depth: 13,  // log2(8192) = 13
    num_rounds: 30,
    fri_final_poly_size: 16,
    fri_final_poly_degree_bound: 1, // [B2] MEASURED post-segmentation
    quotient_segments: 8,           // [B2] ceil((8n-7)/n), MEASURED
    num_queries: 22,
};

pub fn get_circuit_config(circuit_id: u8) -> Option<&'static CircuitConfig> {
    match circuit_id {
        0 => Some(&CONFIG_SUBSCRIBER_OWNERSHIP),
        1 => Some(&CONFIG_POOL_COMMITMENT),
        2 => Some(&CONFIG_BALANCE_PROOF),
        3 => Some(&CONFIG_MERKLE_PATH),
        4 => Some(&CONFIG_CONFIDENTIAL_BALANCE),
        5 => Some(&CONFIG_TRANSFER),
        6 => Some(&CONFIG_MERKLE_UPDATE),
        _ => None,
    }
}

// ============================================================================
// Legacy constants (backward compatibility for circuit 0)
// ============================================================================

pub const TRACE_WIDTH: usize = 3;
pub const TRACE_LENGTH: usize = 32;
pub const BLOWUP: usize = 16;
pub const LDE_SIZE: usize = TRACE_LENGTH * BLOWUP;
// [B2] SOUNDNESS, HONESTLY, IN TWO COLUMNS.
//
// The query term is `num_queries * log2(1/rho) + grinding_bits` at the MEASURED
// rho = `fri_final_poly_degree_bound / fri_final_poly_size`. Pre-B2 that bound
// was 8 of 16, rho = 1/2, and a query was worth 1.000 bit; `log2(blowup)` was
// wrong by 4x and quoting it is the specific error this project shipped. Post-B2
// the quotient is split into `quotient_segments` degree-<n columns, deg(D) = n-2,
// the bound is 1 of 16, rho = 1/16, and a query is worth 4.000 bits.
//
// The query term is NOT the answer, and B2 does not change that. Every
// Fiat-Shamir challenge here — `derive_ood_point`, `derive_fri_alpha`,
// `derive_deep_coeff` — is a SINGLE base-field Goldilocks element, so the whole
// argument sits under a field floor of
//
//     field_bits = 64 - log2( 8n + (w + k + 1) + folds * lde_size )
//
// = 47.8 bits on C3/C5/C6 and 52.5 on C0. Grinding cannot lift it: the nonce is
// absorbed AFTER z, gamma and every alpha, so an adversary who wins the OOD or
// proximity lottery wins with zero grinding. Post-B2 the query term OVERSHOOTS
// the floor on all seven circuits, so the honest conjectured figure IS the floor:
//
//     conjectured  52 / 50 / 50 / 47 / 48 / 47 / 47   (C0..C6)
//     unconditional 46 / 46 / 46 / 42 / 46 / 42 / 42
//
// The unconditional column is unique-decoding (`log2(2/(1+rho))` = 0.913 bits per
// query, a theorem); the conjectured column is list-decoding to capacity
// (ethSTARK Conjecture 8.4). Both are derived from `CircuitConfig` and asserted
// in `tests/b1_deep_binding.rs`, which cannot publish one without the other.
//
// 42-47 bits is SHORT for a product holding real funds — about 20 GPU-minutes to
// 8 GPU-hours on one consumer card, and roughly half that many bits under Grover.
// Lifting the floor needs the challenges drawn from an extension field, which is
// a separate change and another wire break. No README, CV, pitch or tweet number
// above the unconditional column.
pub const NUM_QUERIES: usize = 27;
/// [B2] 16 -> 22. Post-segmentation the conjectured column is floor-bound, so
/// grinding buys nothing there; its whole value is +6 bits in the unconditional
/// column. Must equal the prover's `GRINDING_BITS`.
pub const GRINDING_BITS: u32 = 22;
pub const MERKLE_DEPTH: usize = 9; // log2(512) = 9
pub const NUM_ROUNDS: usize = 30;

/// [P1.1 PR 2] Target size of the FRI final polynomial (coefficients).
/// Prover folds the quotient LDE down to this size; remaining polynomial is
/// sent in the clear so the verifier can evaluate at any domain point.
pub const FRI_FINAL_POLY_SIZE: usize = 16;

/// [B2] Legacy circuit-0 twin of `CircuitConfig.fri_final_poly_degree_bound`.
///
/// Pre-B2 this was 7 where C1..C6 were 8, and that difference was the proof the
/// bound had to be per-circuit: `subscriber_ownership`'s AIR declares ONE
/// periodic factor (`with_cycles(7, vec![TRACE_LENGTH])`) where C1..C6 carry two,
/// so deg(C) = 8*31 = 248, deg(Q) = 248 + 1 - 32 = 217, and ceil(218 / 2^5) = 7.
///
/// Post-segmentation the AIR's constraint degree no longer reaches the bound at
/// all — it sets `LEGACY_QUOTIENT_SEGMENTS` instead — so C0 lands on 1 like
/// everything else. MEASURED, top non-zero terminal coefficient index 0.
pub const LEGACY_FRI_FINAL_POLY_DEGREE_BOUND: usize = 1;

/// [B2] Legacy circuit-0 twin of `CircuitConfig.quotient_segments`.
///
/// `ceil((deg(Q) + 1) / n) = ceil(218 / 32) = 7`. Must equal the prover's
/// `LEGACY_QUOTIENT_SEGMENTS` and `CONFIG_SUBSCRIBER_OWNERSHIP.quotient_segments`.
pub const LEGACY_QUOTIENT_SEGMENTS: usize = 7;

/// [B1] Is `raw` a canonical Goldilocks encoding?
///
/// `MODULUS` itself is a perfectly legal `u64` that REDUCES to zero, so "the
/// coefficient bytes are non-zero" and "the coefficient felt is non-zero" are
/// DIFFERENT predicates. The final-poly tail check compares reduced felts, so
/// the parser has to reject non-canonical encodings or an adversary could park
/// `MODULUS` in a slot the tail check reads as zero while the transcript (which
/// absorbs the RAW bytes, verify.rs) sees something else.
#[inline]
fn is_canonical(raw: u64) -> bool {
    raw < crate::goldilocks::MODULUS
}

// ============================================================================
// Byte-decode helpers
// ============================================================================

#[inline]
fn felt_from_slice(b: &[u8]) -> Felt {
    // Safe: caller has already checked b.len() == 8 via cursor arithmetic.
    let arr: [u8; 8] = b.try_into().unwrap();
    Felt::from_le_bytes(arr)
}

/// Decode the i-th felt from a flat little-endian u64 buffer.
#[inline]
fn felt_at(bytes: &[u8], i: usize) -> Felt {
    felt_from_slice(&bytes[i * 8..(i + 1) * 8])
}

/// [B4] Size of one FRI layer's **pair-tree** Merkle path in bytes.
///
/// Committed FRI layer `i` holds `lde_size / 2^(i+1)` evaluations, i.e. a value
/// tree of depth `merkle_depth - i - 1`. B4 commits pairs
/// `H(v[j] ‖ v[j + N/2])`, halving the leaf count, so the tree the verifier
/// walks is one level shallower: `merkle_depth - i - 2`.
///
/// The smallest committed layer is `2 * fri_final_poly_size` (32 for every
/// shipping circuit) → 16 pair leaves → depth 4. Never degenerates to 0.
#[inline]
fn fri_layer_pair_path_bytes(merkle_depth: usize, layer: usize) -> usize {
    merkle_depth.saturating_sub(layer + 2) * 32
}

// (Previously `fri_paths_offset` lived here for a "flat paths buffer" layout —
// removed in favor of the interleaved `fri_block` layout the wire format
// already uses, see `fri_block_*` helpers on QueryProof / LegacyQueryProof.)

// ============================================================================
// Query proof (variable-size, borrowed)
// ============================================================================

/// A single query proof with variable trace width and Merkle depth.
/// All `*_bytes` fields are borrowed slices into the caller-provided proof
/// buffer — no heap copies.
///
/// [B4] The quotient LDE and every FRI layer are committed as **pair leaves**
/// `H(v[j] ‖ v[j + N/2])`, so each carries ONE opening (of depth one less than
/// the old value tree) instead of two: `quotient_pair_path_bytes` replaces the
/// old `quotient_merkle_path_bytes` + `quotient_mirror_path_bytes`, and the
/// FRI block carries `lo | hi | one path` per layer.
#[derive(Clone, Debug)]
pub struct QueryProof<'a> {
    pub position: u32,
    /// [B2] Quotient SEGMENT values at `position XOR (lde_size/2)` —
    /// `quotient_segments * 8` raw LE bytes, segment-major. Together with the
    /// tail block `quotient_values(query_idx)` (the segment values at
    /// `position`) this is the pair `quotient_pair_path_bytes` authenticates,
    /// and the two blocks are hashed as contiguous halves of one leaf.
    quotient_mirror_bytes: &'a [u8],

    trace_values_bytes: &'a [u8],           // trace_width * 8  — row at `position`
    /// [ROUTE C] Trace row at `position ^ (lde_size/2)`. Shares the pair leaf
    /// `j = position mod (lde_size/2)` with `trace_values_bytes`, so
    /// `merkle_path_bytes` authenticates both rows in one opening.
    trace_mirror_values_bytes: &'a [u8],    // trace_width * 8
    next_trace_values_bytes: &'a [u8],      // trace_width * 8  — row at `next_pos`
    /// [ROUTE C] Trace row at `next_pos ^ (lde_size/2)`.
    next_trace_mirror_values_bytes: &'a [u8], // trace_width * 8
    /// [ROUTE C] Path into the trace **pair** tree: (merkle_depth - 1) * 32.
    /// Was a full `merkle_depth * 32` value-tree path pre-Route-C.
    merkle_path_bytes: &'a [u8],            // (merkle_depth - 1) * 32
    next_merkle_path_bytes: &'a [u8],       // (merkle_depth - 1) * 32
    /// [B4] Path into the quotient **pair** tree: (merkle_depth - 1) * 32.
    quotient_pair_path_bytes: &'a [u8],
    /// [B4] Interleaved per-layer FRI block:
    /// `lo(8) | hi(8) | pair_path((md-i-2)*32)` for each layer `i` in
    /// `0..num_fri_layers`, where `lo = f_{i+1}[j]`,
    /// `hi = f_{i+1}[j + size/2]`, `j = position mod (size/2)`.
    fri_block_bytes: &'a [u8],

    merkle_depth: u16,
    num_fri_layers: u16,
}

impl<'a> QueryProof<'a> {
    /// [B2] Mirror value of quotient segment `seg`.
    #[inline]
    pub fn quotient_mirror_value(&self, seg: usize) -> Felt {
        felt_at(self.quotient_mirror_bytes, seg)
    }

    /// [B2] Raw LE bytes of all mirror segment values (`quotient_segments * 8`).
    /// This is the second half of the quotient pair-leaf preimage, already in
    /// wire order, so it is hashed without a copy.
    #[inline]
    pub fn quotient_mirror_bytes(&self) -> &'a [u8] { self.quotient_mirror_bytes }

    /// Trace column value at `col` (0..trace_width).
    #[inline]
    pub fn trace_value(&self, col: usize) -> Felt {
        felt_at(self.trace_values_bytes, col)
    }

    /// Trace column value at `col` at the next row (for transition constraints).
    #[inline]
    pub fn next_trace_value(&self, col: usize) -> Felt {
        felt_at(self.next_trace_values_bytes, col)
    }

    /// Iterate all trace values for this query row.
    pub fn trace_values_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.trace_values_bytes.chunks_exact(8).map(felt_from_slice)
    }

    /// Iterate next-row trace values.
    pub fn next_trace_values_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.next_trace_values_bytes.chunks_exact(8).map(felt_from_slice)
    }

    /// Raw LE bytes of the trace row (len = trace_width * 8). Use this as
    /// the Merkle leaf data — trace values are stored in the proof exactly
    /// as Blake3 will hash them, so no copy is needed.
    #[inline]
    pub fn trace_values_bytes(&self) -> &'a [u8] { self.trace_values_bytes }

    /// Raw LE bytes of the next-row trace.
    #[inline]
    pub fn next_trace_values_bytes(&self) -> &'a [u8] { self.next_trace_values_bytes }

    /// [ROUTE C] Raw LE bytes of the trace row at `position ^ (lde_size/2)`.
    ///
    /// This is the `T_i(x_mirror)` half of the pair leaf. Nothing in this
    /// revision *consumes* it — it is authenticated and then unused. It exists so
    /// a later DEEP-composition recomputation has both halves of the coset from
    /// ONE opening.
    #[inline]
    pub fn trace_mirror_values_bytes(&self) -> &'a [u8] { self.trace_mirror_values_bytes }

    /// [ROUTE C] Raw LE bytes of the trace row at `next_pos ^ (lde_size/2)`.
    ///
    /// Because `next_pos = pos + blowup` and `blowup` divides `lde_size/2`, this
    /// row is simultaneously the mirror of `next_pos` AND the *next* row of the
    /// mirror of `pos` — so the four rows a query carries are two complete
    /// transition frames, at `pos` and at `pos ^ (lde_size/2)`.
    #[inline]
    pub fn next_trace_mirror_values_bytes(&self) -> &'a [u8] { self.next_trace_mirror_values_bytes }

    /// [ROUTE C] Mirror-row trace value at `col`.
    #[inline]
    pub fn trace_mirror_value(&self, col: usize) -> Felt {
        felt_at(self.trace_mirror_values_bytes, col)
    }

    /// [ROUTE C] Mirror next-row trace value at `col`.
    #[inline]
    pub fn next_trace_mirror_value(&self, col: usize) -> Felt {
        felt_at(self.next_trace_mirror_values_bytes, col)
    }

    /// [ROUTE C] Iterate mirror-row trace values.
    pub fn trace_mirror_values_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.trace_mirror_values_bytes.chunks_exact(8).map(felt_from_slice)
    }

    /// Number of trace columns (derived from the buffer length).
    #[inline]
    pub fn trace_width(&self) -> usize { self.trace_values_bytes.len() / 8 }

    /// [ROUTE C] Path into the trace pair tree (len = (merkle_depth - 1) * 32).
    /// Authenticates the leaf `H(row[j] ‖ row[j + lde_size/2])` — i.e. the row at
    /// `position` AND the row at its mirror.
    #[inline]
    pub fn merkle_path(&self) -> &'a [u8] { self.merkle_path_bytes }

    /// [ROUTE C] Path into the trace pair tree for `next_pos`.
    #[inline]
    pub fn next_merkle_path(&self) -> &'a [u8] { self.next_merkle_path_bytes }

    /// [B4] Path into the quotient pair tree ((merkle_depth - 1) * 32 bytes).
    /// Authenticates BOTH the value at `position` and the value at its mirror.
    #[inline]
    pub fn quotient_pair_path(&self) -> &'a [u8] { self.quotient_pair_path_bytes }

    /// Number of committed FRI layers (excludes the final-poly layer).
    #[inline]
    pub fn num_fri_layers(&self) -> usize { self.num_fri_layers as usize }

    /// [B4] Low half of the pair at committed layer `i` (`f_{i+1}[j]`).
    #[inline]
    pub fn fri_lo_value(&self, i: usize) -> Felt {
        self.fri_block_lo_value(i)
    }

    /// [B4] High half of the pair at committed layer `i` (`f_{i+1}[j + N/2]`).
    #[inline]
    pub fn fri_hi_value(&self, i: usize) -> Felt {
        self.fri_block_hi_value(i)
    }

    /// [B4] Pair-tree Merkle path into `fri_layer_roots[i]`.
    pub fn fri_pair_path(&self, i: usize) -> &'a [u8] {
        self.fri_block_pair_path(i)
    }
}

// ============================================================================
// Generic compact proof
// ============================================================================

/// Compact STARK proof supporting any circuit.
#[derive(Clone, Debug)]
pub struct GenericCompactProof<'a> {
    pub trace_root: [u8; 32],
    /// Commitment to the quotient LDE (P1.1 FRI step 1).
    pub quotient_root: [u8; 32],
    pub ood_z: Felt,
    /// PoW grinding nonce.
    pub grinding_nonce: u64,

    /// [B2] Prover's claimed `Q_j(z)` for every quotient segment —
    /// `quotient_segments * 8` raw LE bytes, segment-major. Pre-B2 this was one
    /// felt. `ood_quotient_recombined` reassembles `Q(z)` for the phase-2
    /// identity; the DEEP composition consumes the segments individually.
    ood_quotient_bytes: &'a [u8],
    ood_current_bytes: &'a [u8],          // trace_width * 8
    ood_next_bytes: &'a [u8],             // trace_width * 8
    fri_layer_roots_bytes: &'a [u8],      // num_fri_layers * 32
    fri_final_poly_bytes: &'a [u8],       // FRI_FINAL_POLY_SIZE * 8
    quotient_values_bytes: &'a [u8],      // num_queries * 8

    pub queries: Vec<QueryProof<'a>>,

    num_fri_layers: u16,
}

impl<'a> GenericCompactProof<'a> {
    pub fn num_fri_layers(&self) -> usize { self.num_fri_layers as usize }

    /// [B2] Claimed `Q_j(z)` for segment `seg`.
    #[inline]
    pub fn ood_quotient(&self, seg: usize) -> Felt {
        felt_at(self.ood_quotient_bytes, seg)
    }

    /// [B2] Number of quotient segments actually parsed. Always equals
    /// `config.quotient_segments` — the parser has no other source for it.
    #[inline]
    pub fn ood_quotient_len(&self) -> usize { self.ood_quotient_bytes.len() / 8 }

    /// [B2] Raw LE bytes of all `Q_j(z)` claims, for the Fiat-Shamir transcript.
    #[inline]
    pub fn ood_quotient_bytes(&self) -> &'a [u8] { self.ood_quotient_bytes }

    pub fn ood_quotient_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.ood_quotient_bytes.chunks_exact(8).map(felt_from_slice)
    }

    /// [B2] `Q(z) = SUM_j z^(j*n) * Q_j(z)` — the un-split claim the phase-2
    /// DEEP-ALI identity `C(z) == Q(z) * Z_T(z)` is written against.
    ///
    /// Recombining here rather than shipping `Q(z)` is what keeps the segments
    /// bound: a prover who could publish `Q(z)` directly would be free to choose
    /// any split consistent with it AFTER seeing gamma, and the DEEP composition
    /// would stop binding the individual columns.
    pub fn ood_quotient_recombined(&self, trace_length: usize) -> Felt {
        let zn = self.ood_z.exp(trace_length as u64);
        let mut acc = Felt::ZERO;
        let mut zp = Felt::ONE;
        for chunk in self.ood_quotient_bytes.chunks_exact(8) {
            let arr: [u8; 8] = chunk.try_into().unwrap();
            acc = acc.add(zp.mul(Felt::from_le_bytes(arr)));
            zp = zp.mul(zn);
        }
        acc
    }

    /// OOD trace value at column `col`.
    #[inline]
    pub fn ood_current(&self, col: usize) -> Felt {
        felt_at(self.ood_current_bytes, col)
    }

    /// OOD next-row trace value at column `col`.
    #[inline]
    pub fn ood_next(&self, col: usize) -> Felt {
        felt_at(self.ood_next_bytes, col)
    }

    pub fn ood_current_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.ood_current_bytes.chunks_exact(8).map(felt_from_slice)
    }

    pub fn ood_next_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.ood_next_bytes.chunks_exact(8).map(felt_from_slice)
    }

    /// FRI layer root at index `i` (0-indexed, 0..num_fri_layers).
    pub fn fri_layer_root(&self, i: usize) -> &'a [u8; 32] {
        let s = &self.fri_layer_roots_bytes[i * 32..(i + 1) * 32];
        s.try_into().unwrap()
    }

    /// Iterate all FRI layer roots as 32-byte arrays.
    pub fn fri_layer_roots_iter(&self) -> impl Iterator<Item = &[u8; 32]> + '_ {
        self.fri_layer_roots_bytes
            .chunks_exact(32)
            .map(|s| s.try_into().unwrap())
    }

    /// Raw flat bytes of all FRI layer roots (len = num_fri_layers * 32).
    pub fn fri_layer_roots_bytes(&self) -> &'a [u8] { self.fri_layer_roots_bytes }

    /// Final FRI polynomial coefficient at index `i` (0..FRI_FINAL_POLY_SIZE).
    #[inline]
    pub fn fri_final_poly_coeff(&self, i: usize) -> Felt {
        felt_at(self.fri_final_poly_bytes, i)
    }

    pub fn fri_final_poly_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.fri_final_poly_bytes.chunks_exact(8).map(felt_from_slice)
    }

    /// Raw flat bytes of the final FRI polynomial (len = FRI_FINAL_POLY_SIZE * 8).
    pub fn fri_final_poly_bytes(&self) -> &'a [u8] { self.fri_final_poly_bytes }

    /// [B2] Opened quotient SEGMENT value: segment `seg` at query `idx`.
    #[inline]
    pub fn quotient_value(&self, idx: usize, seg: usize, segments: usize) -> Felt {
        felt_at(self.quotient_values_bytes, idx * segments + seg)
    }

    /// [B2] The `segments * 8` raw LE bytes for query `idx`. This is the FIRST
    /// half of the quotient pair-leaf preimage when `pos < lde_size/2`, already
    /// in wire order, so it is hashed without a copy.
    #[inline]
    pub fn quotient_values_block(&self, idx: usize, segments: usize) -> &'a [u8] {
        &self.quotient_values_bytes[idx * segments * 8..(idx + 1) * segments * 8]
    }

    /// [B2] Number of opened quotient values, `num_queries * quotient_segments`.
    #[inline]
    pub fn quotient_values_len(&self) -> usize {
        self.quotient_values_bytes.len() / 8
    }

    /// Deserialize from bytes using circuit-specific dimensions.
    pub fn from_bytes(data: &'a [u8], config: &CircuitConfig) -> Option<Self> {
        let tw = config.trace_width;
        let md = config.merkle_depth;
        let mut cursor = 0;

        // trace_root: 32 bytes
        if data.len() < cursor + 32 { return None; }
        let mut trace_root = [0u8; 32];
        trace_root.copy_from_slice(&data[cursor..cursor + 32]);
        cursor += 32;

        // quotient_root: 32 bytes (P1.1)
        if data.len() < cursor + 32 { return None; }
        let mut quotient_root = [0u8; 32];
        quotient_root.copy_from_slice(&data[cursor..cursor + 32]);
        cursor += 32;

        // ood_current: tw * 8 bytes (slice view)
        if data.len() < cursor + tw * 8 { return None; }
        let ood_current_bytes = &data[cursor..cursor + tw * 8];
        cursor += tw * 8;

        // ood_next: tw * 8 bytes (slice view)
        if data.len() < cursor + tw * 8 { return None; }
        let ood_next_bytes = &data[cursor..cursor + tw * 8];
        cursor += tw * 8;

        // ood_z: 8 bytes
        if data.len() < cursor + 8 { return None; }
        let ood_z = felt_from_slice(&data[cursor..cursor + 8]);
        cursor += 8;

        // [P1.1 PR 4 DEEP-ALI / B2] ood_quotient: `quotient_segments * 8` bytes,
        // one Q_j(z) per committed segment column. The count comes from the
        // CONFIG, never from the wire, so a prover cannot renegotiate the split;
        // a buffer built for a different k fails the length arithmetic here or
        // in the per-query block below.
        let k = config.quotient_segments;
        if k == 0 { return None; }
        if data.len() < cursor + k * 8 { return None; }
        let ood_quotient_bytes = &data[cursor..cursor + k * 8];
        cursor += k * 8;
        // [B1] Canonicity on every OOD quotient claim. `MODULUS` is a legal u64
        // that reduces to zero, and the transcript absorbs the RAW bytes, so a
        // non-canonical encoding would make the transcript and the arithmetic
        // disagree about the same slot.
        for chunk in ood_quotient_bytes.chunks_exact(8) {
            let raw = u64::from_le_bytes(chunk.try_into().unwrap());
            if !is_canonical(raw) { return None; }
        }

        // [P1.1 PR 2] num_fri_layers: 1 byte
        if data.len() < cursor + 1 { return None; }
        let num_fri_layers = data[cursor] as usize;
        cursor += 1;
        if num_fri_layers > 16 { return None; }

        // [P1.1 PR 2] fri_layer_roots: num_fri_layers * 32 bytes (slice view)
        if data.len() < cursor + num_fri_layers * 32 { return None; }
        let fri_layer_roots_bytes = &data[cursor..cursor + num_fri_layers * 32];
        cursor += num_fri_layers * 32;

        // fri_final_poly_size: 2 bytes
        if data.len() < cursor + 2 { return None; }
        let fri_final_poly_size = u16::from_le_bytes([data[cursor], data[cursor + 1]]) as usize;
        cursor += 2;
        // [P2.2] Per-circuit size; must match the circuit's config exactly.
        if fri_final_poly_size != config.fri_final_poly_size { return None; }

        // fri_final_poly: fri_final_poly_size * 8 bytes (slice view)
        if data.len() < cursor + fri_final_poly_size * 8 { return None; }
        let fri_final_poly_bytes = &data[cursor..cursor + fri_final_poly_size * 8];
        cursor += fri_final_poly_size * 8;
        // [B1] Canonicity on EVERY published coefficient, not just the ones the
        // degree bound reads. See `is_canonical`.
        for chunk in fri_final_poly_bytes.chunks_exact(8) {
            let raw = u64::from_le_bytes(chunk.try_into().unwrap());
            if !is_canonical(raw) { return None; }
        }

        // Consistency: num_fri_layers = num_folds - 1.
        let num_folds = (config.lde_size / config.fri_final_poly_size).trailing_zeros() as usize;
        if num_fri_layers != num_folds.saturating_sub(1) { return None; }

        // grinding_nonce: 8 bytes
        if data.len() < cursor + 8 { return None; }
        let grinding_nonce = u64::from_le_bytes([
            data[cursor],     data[cursor + 1], data[cursor + 2], data[cursor + 3],
            data[cursor + 4], data[cursor + 5], data[cursor + 6], data[cursor + 7],
        ]);
        cursor += 8;

        // num_queries: 2 bytes
        if data.len() < cursor + 2 { return None; }
        let num_queries = u16::from_le_bytes([data[cursor], data[cursor + 1]]) as usize;
        cursor += 2;
        if num_queries > 256 { return None; }

        let mut queries = Vec::with_capacity(num_queries);
        for _ in 0..num_queries {
            // position: 4 bytes
            if data.len() < cursor + 4 { return None; }
            let position = u32::from_le_bytes([
                data[cursor], data[cursor + 1], data[cursor + 2], data[cursor + 3],
            ]);
            cursor += 4;

            // [ROUTE C] trace_values(pos) | trace_mirror_values(pos ^ half) |
            //   next_trace_values(next_pos) | next_trace_mirror_values(next ^ half)
            // then TWO depth-(md - 1) trace PAIR paths. Pre-Route-C this was two
            // rows and two full depth-md value-tree paths.
            if md == 0 { return None; }

            if data.len() < cursor + tw * 8 { return None; }
            let trace_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            if data.len() < cursor + tw * 8 { return None; }
            let trace_mirror_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            if data.len() < cursor + tw * 8 { return None; }
            let next_trace_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            if data.len() < cursor + tw * 8 { return None; }
            let next_trace_mirror_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            // trace pair path: (md - 1) * 32 bytes
            if data.len() < cursor + (md - 1) * 32 { return None; }
            let merkle_path_bytes = &data[cursor..cursor + (md - 1) * 32];
            cursor += (md - 1) * 32;

            // next-row trace pair path: (md - 1) * 32 bytes
            if data.len() < cursor + (md - 1) * 32 { return None; }
            let next_merkle_path_bytes = &data[cursor..cursor + (md - 1) * 32];
            cursor += (md - 1) * 32;

            // [B4/B2] quotient mirror block: `k * 8` bytes (one felt per
            // segment), then ONE pair path of (md - 1) * 32 bytes. Pre-B4 this
            // was two full md*32 paths; pre-B2 the block was a single felt.
            // Widening the leaf preimage costs no Merkle depth, which is why the
            // segmentation is 8k bytes per query and not k paths.
            if data.len() < cursor + k * 8 { return None; }
            let quotient_mirror_bytes = &data[cursor..cursor + k * 8];
            cursor += k * 8;
            if data.len() < cursor + (md - 1) * 32 { return None; }
            let quotient_pair_path_bytes = &data[cursor..cursor + (md - 1) * 32];
            cursor += (md - 1) * 32;

            // [B4] Per-FRI-layer pair openings: the wire format interleaves
            // `lo(8) | hi(8) | pair_path((md-i-2)*32)` per layer. We keep the
            // whole interleaved block as one borrowed slice and translate in
            // the accessors — no per-query owned allocations.
            let fri_block_start = cursor;
            for i in 0..num_fri_layers {
                let depth_bytes = fri_layer_pair_path_bytes(md, i);
                if data.len() < cursor + 16 + depth_bytes { return None; }
                cursor += 16 + depth_bytes;
            }
            let fri_block_bytes = &data[fri_block_start..cursor];

            queries.push(QueryProof {
                position,
                quotient_mirror_bytes,
                trace_values_bytes,
                trace_mirror_values_bytes,
                next_trace_values_bytes,
                next_trace_mirror_values_bytes,
                merkle_path_bytes,
                next_merkle_path_bytes,
                quotient_pair_path_bytes,
                fri_block_bytes,
                merkle_depth: md as u16,
                num_fri_layers: num_fri_layers as u16,
            });
        }

        // [B2] quotient_values: num_queries * k * 8 bytes (slice view),
        // segment-major within a query.
        if data.len() < cursor + num_queries * k * 8 { return None; }
        let quotient_values_bytes = &data[cursor..cursor + num_queries * k * 8];
        // cursor += num_queries * k * 8; // final, not used

        Some(GenericCompactProof {
            trace_root,
            quotient_root,
            ood_z,
            grinding_nonce,
            ood_quotient_bytes,
            ood_current_bytes,
            ood_next_bytes,
            fri_layer_roots_bytes,
            fri_final_poly_bytes,
            quotient_values_bytes,
            queries,
            num_fri_layers: num_fri_layers as u16,
        })
    }
}

// ============================================================================
// Legacy CompactStarkProof (backward compat for circuit 0)
// ============================================================================

#[derive(Clone, Debug)]
pub struct CompactStarkProof<'a> {
    pub trace_root: [u8; 32],
    pub quotient_root: [u8; 32],
    pub ood_current: [Felt; TRACE_WIDTH],
    pub ood_next: [Felt; TRACE_WIDTH],
    pub ood_z: Felt,
    pub grinding_nonce: u64,

    /// [B2] `LEGACY_QUOTIENT_SEGMENTS * 8` raw LE bytes of `Q_j(z)`.
    ood_quotient_bytes: &'a [u8],
    fri_layer_roots_bytes: &'a [u8],      // num_fri_layers * 32
    fri_final_poly_bytes: &'a [u8],       // FRI_FINAL_POLY_SIZE * 8
    quotient_values_bytes: &'a [u8],      // num_queries * 8

    pub queries: Vec<LegacyQueryProof<'a>>,

    num_fri_layers: u16,
}

impl<'a> CompactStarkProof<'a> {
    pub fn num_fri_layers(&self) -> usize { self.num_fri_layers as usize }

    pub fn fri_layer_root(&self, i: usize) -> &'a [u8; 32] {
        let s = &self.fri_layer_roots_bytes[i * 32..(i + 1) * 32];
        s.try_into().unwrap()
    }

    pub fn fri_layer_roots_iter(&self) -> impl Iterator<Item = &[u8; 32]> + '_ {
        self.fri_layer_roots_bytes
            .chunks_exact(32)
            .map(|s| s.try_into().unwrap())
    }

    /// Raw flat bytes of all FRI layer roots (len = num_fri_layers * 32).
    pub fn fri_layer_roots_bytes(&self) -> &'a [u8] { self.fri_layer_roots_bytes }

    pub fn fri_final_poly_coeff(&self, i: usize) -> Felt {
        felt_at(self.fri_final_poly_bytes, i)
    }

    pub fn fri_final_poly_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.fri_final_poly_bytes.chunks_exact(8).map(felt_from_slice)
    }

    /// Raw flat bytes of the final FRI polynomial (len = FRI_FINAL_POLY_SIZE * 8).
    pub fn fri_final_poly_bytes(&self) -> &'a [u8] { self.fri_final_poly_bytes }

    /// [B2] Segment `seg` at query `idx`.
    pub fn quotient_value(&self, idx: usize, seg: usize) -> Felt {
        felt_at(self.quotient_values_bytes, idx * LEGACY_QUOTIENT_SEGMENTS + seg)
    }

    /// [B2] The `LEGACY_QUOTIENT_SEGMENTS * 8` raw LE bytes for query `idx`.
    #[inline]
    pub fn quotient_values_block(&self, idx: usize) -> &'a [u8] {
        let w = LEGACY_QUOTIENT_SEGMENTS * 8;
        &self.quotient_values_bytes[idx * w..(idx + 1) * w]
    }

    #[inline]
    pub fn quotient_values_len(&self) -> usize {
        self.quotient_values_bytes.len() / 8
    }

    /// [B2] `Q(z) = SUM_j z^(j*32) * Q_j(z)`. Twin of the generic accessor.
    pub fn ood_quotient_recombined(&self) -> Felt {
        let zn = self.ood_z.exp(TRACE_LENGTH as u64);
        let mut acc = Felt::ZERO;
        let mut zp = Felt::ONE;
        for chunk in self.ood_quotient_bytes.chunks_exact(8) {
            let arr: [u8; 8] = chunk.try_into().unwrap();
            acc = acc.add(zp.mul(Felt::from_le_bytes(arr)));
            zp = zp.mul(zn);
        }
        acc
    }

    /// [B2] Claimed `Q_j(z)` for segment `seg`.
    #[inline]
    pub fn ood_quotient(&self, seg: usize) -> Felt {
        felt_at(self.ood_quotient_bytes, seg)
    }

    /// [B2] Raw LE bytes of all `Q_j(z)` claims, for the transcript.
    #[inline]
    pub fn ood_quotient_bytes(&self) -> &'a [u8] { self.ood_quotient_bytes }

    pub fn ood_quotient_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.ood_quotient_bytes.chunks_exact(8).map(felt_from_slice)
    }
}

/// Legacy query proof — circuit 0 has fixed TRACE_WIDTH=3 and MERKLE_DEPTH=9
/// so per-field sizes are known, but the storage model mirrors the generic
/// slice-view path so heap usage stays bounded.
#[derive(Clone, Debug)]
pub struct LegacyQueryProof<'a> {
    pub position: u32,
    /// [B2] `LEGACY_QUOTIENT_SEGMENTS * 8` raw LE bytes, segment-major.
    quotient_mirror_bytes: &'a [u8],

    trace_values_bytes: &'a [u8],           // TRACE_WIDTH * 8 = 24
    /// [ROUTE C] Trace row at `position ^ (LDE_SIZE/2)`.
    trace_mirror_values_bytes: &'a [u8],    // 24
    next_trace_values_bytes: &'a [u8],      // 24
    /// [ROUTE C] Trace row at `next_pos ^ (LDE_SIZE/2)`.
    next_trace_mirror_values_bytes: &'a [u8], // 24
    /// [ROUTE C] Path into the trace PAIR tree,
    /// (MERKLE_DEPTH - 1) * 32 = 256. Was MERKLE_DEPTH * 32 = 288.
    merkle_path_bytes: &'a [u8],
    next_merkle_path_bytes: &'a [u8],
    /// [B4] (MERKLE_DEPTH - 1) * 32 = 256
    quotient_pair_path_bytes: &'a [u8],
    fri_block_bytes: &'a [u8],              // [B4] interleaved lo|hi|pair_path per layer

    merkle_depth: u16,
    num_fri_layers: u16,
}

impl<'a> LegacyQueryProof<'a> {
    /// [B2] Mirror value of quotient segment `seg`.
    #[inline]
    pub fn quotient_mirror_value(&self, seg: usize) -> Felt {
        felt_at(self.quotient_mirror_bytes, seg)
    }
    /// [B2] Raw LE bytes of all mirror segment values.
    #[inline]
    pub fn quotient_mirror_bytes(&self) -> &'a [u8] { self.quotient_mirror_bytes }

    pub fn trace_value(&self, col: usize) -> Felt { felt_at(self.trace_values_bytes, col) }
    pub fn next_trace_value(&self, col: usize) -> Felt { felt_at(self.next_trace_values_bytes, col) }

    pub fn trace_values_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.trace_values_bytes.chunks_exact(8).map(felt_from_slice)
    }
    pub fn next_trace_values_iter(&self) -> impl Iterator<Item = Felt> + '_ {
        self.next_trace_values_bytes.chunks_exact(8).map(felt_from_slice)
    }

    /// Raw LE bytes of the trace row (TRACE_WIDTH * 8 = 24 bytes for circuit 0).
    #[inline]
    pub fn trace_values_bytes(&self) -> &'a [u8] { self.trace_values_bytes }
    #[inline]
    pub fn next_trace_values_bytes(&self) -> &'a [u8] { self.next_trace_values_bytes }

    /// [ROUTE C] Trace row at the mirror position (`position ^ LDE_SIZE/2`).
    /// Authenticated by `merkle_path`, unread by this revision.
    #[inline]
    pub fn trace_mirror_values_bytes(&self) -> &'a [u8] { self.trace_mirror_values_bytes }
    /// [ROUTE C] Trace row at the mirror of `next_pos`.
    #[inline]
    pub fn next_trace_mirror_values_bytes(&self) -> &'a [u8] {
        self.next_trace_mirror_values_bytes
    }
    /// [ROUTE C] Mirror-row trace value at `col`.
    #[inline]
    pub fn trace_mirror_value(&self, col: usize) -> Felt {
        felt_at(self.trace_mirror_values_bytes, col)
    }
    /// [ROUTE C] Mirror next-row trace value at `col`.
    #[inline]
    pub fn next_trace_mirror_value(&self, col: usize) -> Felt {
        felt_at(self.next_trace_mirror_values_bytes, col)
    }

    /// [ROUTE C] Path into the trace pair tree ((MERKLE_DEPTH - 1) * 32 bytes).
    pub fn merkle_path(&self) -> &'a [u8] { self.merkle_path_bytes }
    /// [ROUTE C] Path into the trace pair tree for `next_pos`.
    pub fn next_merkle_path(&self) -> &'a [u8] { self.next_merkle_path_bytes }
    /// [B4] Path into the quotient pair tree ((MERKLE_DEPTH - 1) * 32 bytes).
    pub fn quotient_pair_path(&self) -> &'a [u8] { self.quotient_pair_path_bytes }
    pub fn num_fri_layers(&self) -> usize { self.num_fri_layers as usize }

    /// [B4] Low half of the pair at committed layer `i`.
    pub fn fri_lo_value(&self, i: usize) -> Felt {
        let md = self.merkle_depth as usize;
        let mut off = 0;
        for j in 0..i {
            off += 16 + fri_layer_pair_path_bytes(md, j);
        }
        felt_from_slice(&self.fri_block_bytes[off..off + 8])
    }

    /// [B4] High half of the pair at committed layer `i`.
    pub fn fri_hi_value(&self, i: usize) -> Felt {
        let md = self.merkle_depth as usize;
        let mut off = 0;
        for j in 0..i {
            off += 16 + fri_layer_pair_path_bytes(md, j);
        }
        felt_from_slice(&self.fri_block_bytes[off + 8..off + 16])
    }

    /// [B4] Pair-tree Merkle path for committed layer `i`.
    pub fn fri_pair_path(&self, i: usize) -> &'a [u8] {
        let md = self.merkle_depth as usize;
        let dp_i = fri_layer_pair_path_bytes(md, i);
        let mut off = 0;
        for j in 0..i {
            off += 16 + fri_layer_pair_path_bytes(md, j);
        }
        off += 16; // skip lo, hi
        &self.fri_block_bytes[off..off + dp_i]
    }

    /// **[P1.6 CU fix]** O(1) per-layer iterator; see `QueryProof::fri_block_iter`.
    pub fn fri_block_iter(&self) -> FriBlockIter<'a> {
        FriBlockIter {
            bytes: self.fri_block_bytes,
            merkle_depth: self.merkle_depth as usize,
            layer: 0,
            num_layers: self.num_fri_layers as usize,
            cursor: 0,
        }
    }
}

// [B4] Interleaved FRI block accessors for QueryProof. Wire layout per layer `i`:
//   lo(8) | hi(8) | pair_path(dp_i*32)
// where dp_i = merkle_depth - i - 2 (pair tree, one level shallower than the
// value tree). Accessors walk the prefix once per call; call sites iterate i
// in order so this stays O(L) over a query.
impl<'a> QueryProof<'a> {
    #[inline]
    fn fri_block_lo_value(&self, i: usize) -> Felt {
        let md = self.merkle_depth as usize;
        let mut off = 0;
        for j in 0..i {
            off += 16 + fri_layer_pair_path_bytes(md, j);
        }
        felt_from_slice(&self.fri_block_bytes[off..off + 8])
    }

    #[inline]
    fn fri_block_hi_value(&self, i: usize) -> Felt {
        let md = self.merkle_depth as usize;
        let mut off = 0;
        for j in 0..i {
            off += 16 + fri_layer_pair_path_bytes(md, j);
        }
        felt_from_slice(&self.fri_block_bytes[off + 8..off + 16])
    }

    #[inline]
    fn fri_block_pair_path(&self, i: usize) -> &'a [u8] {
        let md = self.merkle_depth as usize;
        let dp_i = fri_layer_pair_path_bytes(md, i);
        let mut off = 0;
        for j in 0..i {
            off += 16 + fri_layer_pair_path_bytes(md, j);
        }
        off += 16;
        &self.fri_block_bytes[off..off + dp_i]
    }

    /// **[P1.6 CU fix]** O(1) per-layer iterator over the interleaved FRI block.
    /// Call sites that walk all layers in order should use this instead of the
    /// O(layer) random-access accessors above — each call hops one layer via a
    /// local cursor, so total work for a query is O(L) not O(L²).
    pub fn fri_block_iter(&self) -> FriBlockIter<'a> {
        FriBlockIter {
            bytes: self.fri_block_bytes,
            merkle_depth: self.merkle_depth as usize,
            layer: 0,
            num_layers: self.num_fri_layers as usize,
            cursor: 0,
        }
    }
}

/// [B4] Iterator yielding `(lo, hi, pair_path)` for each committed FRI layer in
/// order. O(1) per step via cursor. See `QueryProof::fri_block_iter`.
pub struct FriBlockIter<'a> {
    bytes: &'a [u8],
    merkle_depth: usize,
    layer: usize,
    num_layers: usize,
    cursor: usize,
}

impl<'a> Iterator for FriBlockIter<'a> {
    type Item = (Felt, Felt, &'a [u8]);

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if self.layer >= self.num_layers {
            return None;
        }
        let dp = fri_layer_pair_path_bytes(self.merkle_depth, self.layer);
        let c = self.cursor;
        let lo = felt_from_slice(&self.bytes[c..c + 8]);
        let hi = felt_from_slice(&self.bytes[c + 8..c + 16]);
        let path = &self.bytes[c + 16..c + 16 + dp];
        self.cursor = c + 16 + dp;
        self.layer += 1;
        Some((lo, hi, path))
    }
}

impl<'a> CompactStarkProof<'a> {
    pub fn from_bytes(data: &'a [u8]) -> Option<Self> {
        let mut cursor = 0;
        let md = MERKLE_DEPTH;
        let tw = TRACE_WIDTH;

        if data.len() < cursor + 32 { return None; }
        let mut trace_root = [0u8; 32];
        trace_root.copy_from_slice(&data[cursor..cursor + 32]);
        cursor += 32;

        if data.len() < cursor + 32 { return None; }
        let mut quotient_root = [0u8; 32];
        quotient_root.copy_from_slice(&data[cursor..cursor + 32]);
        cursor += 32;

        // ood_current: 3 * 8 = 24 bytes, copy into owned array
        if data.len() < cursor + 24 { return None; }
        let mut ood_current = [Felt::ZERO; TRACE_WIDTH];
        for i in 0..TRACE_WIDTH {
            ood_current[i] = felt_from_slice(&data[cursor..cursor + 8]);
            cursor += 8;
        }

        if data.len() < cursor + 24 { return None; }
        let mut ood_next = [Felt::ZERO; TRACE_WIDTH];
        for i in 0..TRACE_WIDTH {
            ood_next[i] = felt_from_slice(&data[cursor..cursor + 8]);
            cursor += 8;
        }

        if data.len() < cursor + 8 { return None; }
        let ood_z = felt_from_slice(&data[cursor..cursor + 8]);
        cursor += 8;

        // [B2] LEGACY_QUOTIENT_SEGMENTS felts, canonicity-checked.
        const K: usize = LEGACY_QUOTIENT_SEGMENTS;
        if data.len() < cursor + K * 8 { return None; }
        let ood_quotient_bytes = &data[cursor..cursor + K * 8];
        for chunk in ood_quotient_bytes.chunks_exact(8) {
            let raw = u64::from_le_bytes(chunk.try_into().unwrap());
            if !is_canonical(raw) { return None; }
        }
        cursor += K * 8;

        if data.len() < cursor + 1 { return None; }
        let num_fri_layers = data[cursor] as usize;
        cursor += 1;
        if num_fri_layers != 4 { return None; }

        if data.len() < cursor + num_fri_layers * 32 { return None; }
        let fri_layer_roots_bytes = &data[cursor..cursor + num_fri_layers * 32];
        cursor += num_fri_layers * 32;

        if data.len() < cursor + 2 { return None; }
        let fri_final_poly_size = u16::from_le_bytes([data[cursor], data[cursor + 1]]) as usize;
        cursor += 2;
        if fri_final_poly_size != FRI_FINAL_POLY_SIZE { return None; }

        if data.len() < cursor + fri_final_poly_size * 8 { return None; }
        let fri_final_poly_bytes = &data[cursor..cursor + fri_final_poly_size * 8];
        cursor += fri_final_poly_size * 8;
        // [B1] Same canonicity check as the generic parser.
        for chunk in fri_final_poly_bytes.chunks_exact(8) {
            let raw = u64::from_le_bytes(chunk.try_into().unwrap());
            if !is_canonical(raw) { return None; }
        }

        if data.len() < cursor + 8 { return None; }
        let grinding_nonce = u64::from_le_bytes([
            data[cursor],     data[cursor + 1], data[cursor + 2], data[cursor + 3],
            data[cursor + 4], data[cursor + 5], data[cursor + 6], data[cursor + 7],
        ]);
        cursor += 8;

        if data.len() < cursor + 2 { return None; }
        let num_queries = u16::from_le_bytes([data[cursor], data[cursor + 1]]) as usize;
        cursor += 2;
        if num_queries > 256 { return None; }

        let mut queries = Vec::with_capacity(num_queries);
        for _ in 0..num_queries {
            if data.len() < cursor + 4 { return None; }
            let position = u32::from_le_bytes([
                data[cursor], data[cursor + 1], data[cursor + 2], data[cursor + 3],
            ]);
            cursor += 4;

            // [ROUTE C] four trace rows + two depth-(md - 1) trace pair paths.
            if data.len() < cursor + tw * 8 { return None; }
            let trace_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            if data.len() < cursor + tw * 8 { return None; }
            let trace_mirror_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            if data.len() < cursor + tw * 8 { return None; }
            let next_trace_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            if data.len() < cursor + tw * 8 { return None; }
            let next_trace_mirror_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            if data.len() < cursor + (md - 1) * 32 { return None; }
            let merkle_path_bytes = &data[cursor..cursor + (md - 1) * 32];
            cursor += (md - 1) * 32;

            if data.len() < cursor + (md - 1) * 32 { return None; }
            let next_merkle_path_bytes = &data[cursor..cursor + (md - 1) * 32];
            cursor += (md - 1) * 32;

            // [B4/B2] quotient mirror block (K*8) + ONE pair path ((md-1)*32).
            if data.len() < cursor + K * 8 { return None; }
            let quotient_mirror_bytes = &data[cursor..cursor + K * 8];
            cursor += K * 8;
            if data.len() < cursor + (md - 1) * 32 { return None; }
            let quotient_pair_path_bytes = &data[cursor..cursor + (md - 1) * 32];
            cursor += (md - 1) * 32;

            // [B4] FRI block: interleaved per-layer lo|hi|pair_path.
            let fri_block_start = cursor;
            for i in 0..num_fri_layers {
                let dp = fri_layer_pair_path_bytes(md, i);
                if data.len() < cursor + 16 + dp { return None; }
                cursor += 16 + dp;
            }
            let fri_block_bytes = &data[fri_block_start..cursor];

            queries.push(LegacyQueryProof {
                position,
                quotient_mirror_bytes,
                trace_values_bytes,
                trace_mirror_values_bytes,
                next_trace_values_bytes,
                next_trace_mirror_values_bytes,
                merkle_path_bytes,
                next_merkle_path_bytes,
                quotient_pair_path_bytes,
                fri_block_bytes,
                merkle_depth: md as u16,
                num_fri_layers: num_fri_layers as u16,
            });
        }

        // [B2] num_queries * K felts, segment-major within a query.
        if data.len() < cursor + num_queries * K * 8 { return None; }
        let quotient_values_bytes = &data[cursor..cursor + num_queries * K * 8];

        Some(CompactStarkProof {
            trace_root,
            quotient_root,
            ood_current,
            ood_next,
            ood_z,
            grinding_nonce,
            ood_quotient_bytes,
            fri_layer_roots_bytes,
            fri_final_poly_bytes,
            quotient_values_bytes,
            queries,
            num_fri_layers: num_fri_layers as u16,
        })
    }
}
