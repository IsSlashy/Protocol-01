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
    /// [P2.2] Number of FRI queries. Soundness = num_queries × log2(blowup)
    /// + grinding_bits. All circuits target ≥ 100-bit classical soundness:
    /// circuits 0, 1, 2, 4 use 27 (124 bits); circuits 3, 5, 6 use 22
    /// (104 bits) to fit their LDE=8192 / 10-col trace under the 1.4M CU
    /// cap. All variants stay well above the 100-bit classical floor.
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
    num_queries: NUM_QUERIES,
};

/// merkle_path: 6 cols, variable length (512 for depth 15)
///
/// [P2.2g] num_queries dropped 27→22 so phase-1 FRI (LDE=8192, 13 merkle
/// layers per query) fits under the 1.4M Solana BPF CU cap. DEEP-ALI is
/// split off to `verify_deep_ali_phase2` (same as circuit 6). Soundness:
/// 22×4 + 16 = 104 bits, comfortably above the 100-bit classical floor.
pub const CONFIG_MERKLE_PATH: CircuitConfig = CircuitConfig {
    trace_width: 6,
    trace_length: 512, // depth 15: 15 * 32 = 480, next_pow2 = 512
    blowup: 16,
    lde_size: 8192,
    merkle_depth: 13,  // log2(8192) = 13
    num_rounds: 30,
    fri_final_poly_size: 16,
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
    num_queries: NUM_QUERIES,
};

/// transfer: 6 cols, 512 rows (14 hash cycles of 32 + 2 padding cycles)
///
/// [P2.2g] num_queries dropped 27→22 for the same reason as merkle_path:
/// LDE=8192 with 23-constraint transition polynomial pushes phase-1 FRI
/// above 1.4M CU at 27 queries. Soundness: 104 bits via 22×4 + 16 grinding.
pub const CONFIG_TRANSFER: CircuitConfig = CircuitConfig {
    trace_width: 6,
    trace_length: 512,
    blowup: 16,
    lde_size: 8192,
    merkle_depth: 13,  // log2(8192) = 13
    num_rounds: 30,
    fri_final_poly_size: 16,
    num_queries: 22,
};

/// merkle_update: 10 cols (OLD Poseidon 0-2, NEW Poseidon 3-5, sibling 6, dir 7,
/// old_carry 8, new_carry 9), 512 rows (max depth 16 ≤ 16 * 32 = 512).
///
/// The 10-col trace inflates per-query merkle + constraint-eval CU relative
/// to every other circuit (3–6 cols). Two knobs were tuned to fit the 1.4M
/// BPF CU cap:
///
/// - `fri_final_poly_size = 256`: 4 committed FRI layers instead of 8 —
///   saves ~150k CU in FRI merkle hashing, costs ~104k CU in extra Horner
///   (256-coeff final poly). Net ~46k CU saved.
/// - `num_queries = 22` (vs 27 for circuits 0-5): 18.5% fewer per-query
///   merkle paths, constraint evaluations, and Horner calls. Saves ~200k CU.
///   Soundness drops from 27×4+16 = 124 bits to 22×4+16 = 104 bits, still
///   comfortably above the 100-bit industry floor.
pub const CONFIG_MERKLE_UPDATE: CircuitConfig = CircuitConfig {
    trace_width: 10,
    trace_length: 512,
    blowup: 16,
    lde_size: 8192,
    merkle_depth: 13,  // log2(8192) = 13
    num_rounds: 30,
    fri_final_poly_size: 16,
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
// Soundness: NUM_QUERIES × log2(BLOWUP) + GRINDING_BITS.
// 27 × 4 + 16 = 124 bits classical, > 100-bit target.
// For PQ-96 move to 40 queries + 32-bit grinding.
pub const NUM_QUERIES: usize = 27;
pub const GRINDING_BITS: u32 = 16;
pub const MERKLE_DEPTH: usize = 9; // log2(512) = 9
pub const NUM_ROUNDS: usize = 30;

/// [P1.1 PR 2] Target size of the FRI final polynomial (coefficients).
/// Prover folds the quotient LDE down to this size; remaining polynomial is
/// sent in the clear so the verifier can evaluate at any domain point.
pub const FRI_FINAL_POLY_SIZE: usize = 16;

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

/// Size of one FRI layer's Merkle path in bytes, given circuit depth and layer index.
/// Layer 0 is the quotient LDE (depth = merkle_depth); committed FRI layer `i`
/// (1-indexed here as `layer=i` in `fri_layer_roots[i-1]`) has depth
/// `merkle_depth - i - 1` (the final fold targets `fri_final_poly` instead of
/// a Merkle commit, so depths decrement by 1 per layer from the LDE).
#[inline]
fn fri_layer_path_bytes(merkle_depth: usize, layer: usize) -> usize {
    merkle_depth.saturating_sub(layer + 1) * 32
}

// (Previously `fri_paths_offset` lived here for a "flat paths buffer" layout —
// removed in favor of the interleaved `fri_block` layout the wire format
// already uses, see `fri_block_*` helpers on QueryProof / LegacyQueryProof.)

// ============================================================================
// Query proof (variable-size, borrowed)
// ============================================================================

/// A single query proof with variable trace width and Merkle depth.
/// All `*_bytes` fields are borrowed slices into the caller-provided proof
/// buffer — no heap copies. FRI paths across all layers are stored flat in
/// `fri_paths_bytes` / `fri_mirror_paths_bytes`; use `fri_path(i)` to slice
/// the path for layer `i`.
#[derive(Clone, Debug)]
pub struct QueryProof<'a> {
    pub position: u32,
    pub quotient_mirror_value: Felt,

    trace_values_bytes: &'a [u8],           // trace_width * 8
    next_trace_values_bytes: &'a [u8],      // trace_width * 8
    merkle_path_bytes: &'a [u8],            // merkle_depth * 32
    next_merkle_path_bytes: &'a [u8],       // merkle_depth * 32
    quotient_merkle_path_bytes: &'a [u8],   // merkle_depth * 32
    quotient_mirror_path_bytes: &'a [u8],   // merkle_depth * 32
    /// Interleaved per-layer FRI block:
    /// `value(8) | path(md-i-1)*32 | mirror_value(8) | mirror_path(md-i-1)*32`
    /// for each layer `i` in `0..num_fri_layers`.
    fri_block_bytes: &'a [u8],

    merkle_depth: u16,
    num_fri_layers: u16,
}

impl<'a> QueryProof<'a> {
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

    /// Number of trace columns (derived from the buffer length).
    #[inline]
    pub fn trace_width(&self) -> usize { self.trace_values_bytes.len() / 8 }

    /// Trace Merkle path bytes (len = merkle_depth * 32).
    #[inline]
    pub fn merkle_path(&self) -> &'a [u8] { self.merkle_path_bytes }

    /// Next-row trace Merkle path bytes.
    #[inline]
    pub fn next_merkle_path(&self) -> &'a [u8] { self.next_merkle_path_bytes }

    /// Quotient LDE Merkle path bytes.
    #[inline]
    pub fn quotient_merkle_path(&self) -> &'a [u8] { self.quotient_merkle_path_bytes }

    /// Quotient LDE mirror opening Merkle path bytes.
    #[inline]
    pub fn quotient_mirror_path(&self) -> &'a [u8] { self.quotient_mirror_path_bytes }

    /// Number of committed FRI layers (excludes the final-poly layer).
    #[inline]
    pub fn num_fri_layers(&self) -> usize { self.num_fri_layers as usize }

    /// FRI value at committed layer `i`. Underlying storage is an interleaved
    /// block of `value | path | mirror_value | mirror_path` per layer, so we
    /// must hop over earlier layers' (value+path+mirror_value+mirror_path).
    #[inline]
    pub fn fri_value(&self, i: usize) -> Felt {
        self.fri_block_value(i)
    }

    /// FRI mirror value at committed layer `i`.
    #[inline]
    pub fn fri_mirror_value(&self, i: usize) -> Felt {
        self.fri_block_mirror_value(i)
    }

    /// Merkle path into `fri_layer_roots[i]` for the opened FRI value.
    pub fn fri_path(&self, i: usize) -> &'a [u8] {
        self.fri_block_path(i)
    }

    /// Merkle path into `fri_layer_roots[i]` for the opened FRI mirror value.
    pub fn fri_mirror_path(&self, i: usize) -> &'a [u8] {
        self.fri_block_mirror_path(i)
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
    /// [P1.1 PR 4 DEEP-ALI] Prover's claimed Q(z).
    pub ood_quotient: Felt,
    /// PoW grinding nonce.
    pub grinding_nonce: u64,

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

    /// Opened quotient LDE value at query index `idx` (0..num_queries).
    #[inline]
    pub fn quotient_value(&self, idx: usize) -> Felt {
        felt_at(self.quotient_values_bytes, idx)
    }

    /// Number of opened quotient LDE values (one per query).
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

        // [P1.1 PR 4 DEEP-ALI] ood_quotient: 8 bytes.
        if data.len() < cursor + 8 { return None; }
        let ood_quotient = felt_from_slice(&data[cursor..cursor + 8]);
        cursor += 8;

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

            // trace_values: tw * 8 bytes
            if data.len() < cursor + tw * 8 { return None; }
            let trace_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            // next_trace_values: tw * 8 bytes
            if data.len() < cursor + tw * 8 { return None; }
            let next_trace_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            // merkle_path: md * 32 bytes
            if data.len() < cursor + md * 32 { return None; }
            let merkle_path_bytes = &data[cursor..cursor + md * 32];
            cursor += md * 32;

            // next_merkle_path: md * 32 bytes
            if data.len() < cursor + md * 32 { return None; }
            let next_merkle_path_bytes = &data[cursor..cursor + md * 32];
            cursor += md * 32;

            // quotient_merkle_path: md * 32 bytes (P1.1)
            if data.len() < cursor + md * 32 { return None; }
            let quotient_merkle_path_bytes = &data[cursor..cursor + md * 32];
            cursor += md * 32;

            // quotient_mirror_value: 8 bytes, then quotient_mirror_path: md * 32 bytes
            if data.len() < cursor + 8 { return None; }
            let quotient_mirror_value = felt_from_slice(&data[cursor..cursor + 8]);
            cursor += 8;
            if data.len() < cursor + md * 32 { return None; }
            let quotient_mirror_path_bytes = &data[cursor..cursor + md * 32];
            cursor += md * 32;

            // Per-FRI-layer openings: the wire format interleaves
            // `value(8) | path(depth*32) | mirror_value(8) | mirror_path(depth*32)`
            // per layer. We keep the whole interleaved block as one borrowed
            // slice and translate in the accessors (`fri_value`, `fri_path`,
            // …) — no per-query owned allocations.
            let fri_block_start = cursor;
            for i in 0..num_fri_layers {
                let depth_bytes = fri_layer_path_bytes(md, i);
                if data.len() < cursor + 8 + depth_bytes + 8 + depth_bytes { return None; }
                cursor += 8 + depth_bytes + 8 + depth_bytes;
            }
            let fri_block_bytes = &data[fri_block_start..cursor];

            queries.push(QueryProof {
                position,
                quotient_mirror_value,
                trace_values_bytes,
                next_trace_values_bytes,
                merkle_path_bytes,
                next_merkle_path_bytes,
                quotient_merkle_path_bytes,
                quotient_mirror_path_bytes,
                fri_block_bytes,
                merkle_depth: md as u16,
                num_fri_layers: num_fri_layers as u16,
            });
        }

        // quotient_values: num_queries * 8 bytes (slice view)
        if data.len() < cursor + num_queries * 8 { return None; }
        let quotient_values_bytes = &data[cursor..cursor + num_queries * 8];
        // cursor += num_queries * 8; // final, not used

        Some(GenericCompactProof {
            trace_root,
            quotient_root,
            ood_z,
            ood_quotient,
            grinding_nonce,
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
    /// [P1.1 PR 4 DEEP-ALI] Q(z) at the OOD point.
    pub ood_quotient: Felt,
    pub grinding_nonce: u64,

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

    pub fn quotient_value(&self, idx: usize) -> Felt {
        felt_at(self.quotient_values_bytes, idx)
    }

    #[inline]
    pub fn quotient_values_len(&self) -> usize {
        self.quotient_values_bytes.len() / 8
    }
}

/// Legacy query proof — circuit 0 has fixed TRACE_WIDTH=3 and MERKLE_DEPTH=9
/// so per-field sizes are known, but the storage model mirrors the generic
/// slice-view path so heap usage stays bounded.
#[derive(Clone, Debug)]
pub struct LegacyQueryProof<'a> {
    pub position: u32,
    pub quotient_mirror_value: Felt,

    trace_values_bytes: &'a [u8],           // TRACE_WIDTH * 8 = 24
    next_trace_values_bytes: &'a [u8],      // 24
    merkle_path_bytes: &'a [u8],            // MERKLE_DEPTH * 32 = 288
    next_merkle_path_bytes: &'a [u8],
    quotient_merkle_path_bytes: &'a [u8],
    quotient_mirror_path_bytes: &'a [u8],
    fri_block_bytes: &'a [u8],              // interleaved value|path|mirror_value|mirror_path per layer

    merkle_depth: u16,
    num_fri_layers: u16,
}

impl<'a> LegacyQueryProof<'a> {
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

    pub fn merkle_path(&self) -> &'a [u8] { self.merkle_path_bytes }
    pub fn next_merkle_path(&self) -> &'a [u8] { self.next_merkle_path_bytes }
    pub fn quotient_merkle_path(&self) -> &'a [u8] { self.quotient_merkle_path_bytes }
    pub fn quotient_mirror_path(&self) -> &'a [u8] { self.quotient_mirror_path_bytes }
    pub fn num_fri_layers(&self) -> usize { self.num_fri_layers as usize }

    pub fn fri_value(&self, i: usize) -> Felt {
        let md = self.merkle_depth as usize;
        // Offset to layer i's value: sum of prior layers' (8 + path + 8 + path) + 0.
        let mut off = 0;
        for j in 0..i {
            let dp = fri_layer_path_bytes(md, j);
            off += 8 + dp + 8 + dp;
        }
        felt_from_slice(&self.fri_block_bytes[off..off + 8])
    }

    pub fn fri_mirror_value(&self, i: usize) -> Felt {
        let md = self.merkle_depth as usize;
        let dp_i = fri_layer_path_bytes(md, i);
        let mut off = 0;
        for j in 0..i {
            let dp = fri_layer_path_bytes(md, j);
            off += 8 + dp + 8 + dp;
        }
        off += 8 + dp_i;
        felt_from_slice(&self.fri_block_bytes[off..off + 8])
    }

    pub fn fri_path(&self, i: usize) -> &'a [u8] {
        let md = self.merkle_depth as usize;
        let dp_i = fri_layer_path_bytes(md, i);
        let mut off = 0;
        for j in 0..i {
            let dp = fri_layer_path_bytes(md, j);
            off += 8 + dp + 8 + dp;
        }
        off += 8; // skip value
        &self.fri_block_bytes[off..off + dp_i]
    }

    pub fn fri_mirror_path(&self, i: usize) -> &'a [u8] {
        let md = self.merkle_depth as usize;
        let dp_i = fri_layer_path_bytes(md, i);
        let mut off = 0;
        for j in 0..i {
            let dp = fri_layer_path_bytes(md, j);
            off += 8 + dp + 8 + dp;
        }
        off += 8 + dp_i + 8; // skip value, path, mirror_value
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

// Interleaved FRI block accessors for QueryProof. Wire layout per layer `i`:
//   value(8) | path(depth_i*32) | mirror_value(8) | mirror_path(depth_i*32)
// where depth_i = merkle_depth - i - 1. Accessors walk the prefix once per
// call; call sites iterate i in order so this stays O(L) over a query,
// matching the old Vec<Vec<…>> layout's work.
impl<'a> QueryProof<'a> {
    #[inline]
    fn fri_block_value(&self, i: usize) -> Felt {
        let md = self.merkle_depth as usize;
        let mut off = 0;
        for j in 0..i {
            let dp = fri_layer_path_bytes(md, j);
            off += 8 + dp + 8 + dp;
        }
        felt_from_slice(&self.fri_block_bytes[off..off + 8])
    }

    #[inline]
    fn fri_block_mirror_value(&self, i: usize) -> Felt {
        let md = self.merkle_depth as usize;
        let dp_i = fri_layer_path_bytes(md, i);
        let mut off = 0;
        for j in 0..i {
            let dp = fri_layer_path_bytes(md, j);
            off += 8 + dp + 8 + dp;
        }
        off += 8 + dp_i;
        felt_from_slice(&self.fri_block_bytes[off..off + 8])
    }

    #[inline]
    fn fri_block_path(&self, i: usize) -> &'a [u8] {
        let md = self.merkle_depth as usize;
        let dp_i = fri_layer_path_bytes(md, i);
        let mut off = 0;
        for j in 0..i {
            let dp = fri_layer_path_bytes(md, j);
            off += 8 + dp + 8 + dp;
        }
        off += 8;
        &self.fri_block_bytes[off..off + dp_i]
    }

    #[inline]
    fn fri_block_mirror_path(&self, i: usize) -> &'a [u8] {
        let md = self.merkle_depth as usize;
        let dp_i = fri_layer_path_bytes(md, i);
        let mut off = 0;
        for j in 0..i {
            let dp = fri_layer_path_bytes(md, j);
            off += 8 + dp + 8 + dp;
        }
        off += 8 + dp_i + 8;
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

/// Iterator yielding `(value, path, mirror_value, mirror_path)` for each FRI
/// layer in order. O(1) per step via cursor. See `QueryProof::fri_block_iter`.
pub struct FriBlockIter<'a> {
    bytes: &'a [u8],
    merkle_depth: usize,
    layer: usize,
    num_layers: usize,
    cursor: usize,
}

impl<'a> Iterator for FriBlockIter<'a> {
    type Item = (Felt, &'a [u8], Felt, &'a [u8]);

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if self.layer >= self.num_layers {
            return None;
        }
        let dp = fri_layer_path_bytes(self.merkle_depth, self.layer);
        let c = self.cursor;
        let value = felt_from_slice(&self.bytes[c..c + 8]);
        let path = &self.bytes[c + 8..c + 8 + dp];
        let mirror_value = felt_from_slice(&self.bytes[c + 8 + dp..c + 16 + dp]);
        let mirror_path = &self.bytes[c + 16 + dp..c + 16 + 2 * dp];
        self.cursor = c + 16 + 2 * dp;
        self.layer += 1;
        Some((value, path, mirror_value, mirror_path))
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

        if data.len() < cursor + 8 { return None; }
        let ood_quotient = felt_from_slice(&data[cursor..cursor + 8]);
        cursor += 8;

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

            if data.len() < cursor + tw * 8 { return None; }
            let trace_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            if data.len() < cursor + tw * 8 { return None; }
            let next_trace_values_bytes = &data[cursor..cursor + tw * 8];
            cursor += tw * 8;

            if data.len() < cursor + md * 32 { return None; }
            let merkle_path_bytes = &data[cursor..cursor + md * 32];
            cursor += md * 32;

            if data.len() < cursor + md * 32 { return None; }
            let next_merkle_path_bytes = &data[cursor..cursor + md * 32];
            cursor += md * 32;

            if data.len() < cursor + md * 32 { return None; }
            let quotient_merkle_path_bytes = &data[cursor..cursor + md * 32];
            cursor += md * 32;

            if data.len() < cursor + 8 { return None; }
            let quotient_mirror_value = felt_from_slice(&data[cursor..cursor + 8]);
            cursor += 8;
            if data.len() < cursor + md * 32 { return None; }
            let quotient_mirror_path_bytes = &data[cursor..cursor + md * 32];
            cursor += md * 32;

            // FRI block: interleaved per-layer value|path|mirror_value|mirror_path.
            let fri_block_start = cursor;
            for i in 0..num_fri_layers {
                let dp = fri_layer_path_bytes(md, i);
                if data.len() < cursor + 8 + dp + 8 + dp { return None; }
                cursor += 8 + dp + 8 + dp;
            }
            let fri_block_bytes = &data[fri_block_start..cursor];

            queries.push(LegacyQueryProof {
                position,
                quotient_mirror_value,
                trace_values_bytes,
                next_trace_values_bytes,
                merkle_path_bytes,
                next_merkle_path_bytes,
                quotient_merkle_path_bytes,
                quotient_mirror_path_bytes,
                fri_block_bytes,
                merkle_depth: md as u16,
                num_fri_layers: num_fri_layers as u16,
            });
        }

        if data.len() < cursor + num_queries * 8 { return None; }
        let quotient_values_bytes = &data[cursor..cursor + num_queries * 8];

        Some(CompactStarkProof {
            trace_root,
            quotient_root,
            ood_current,
            ood_next,
            ood_z,
            ood_quotient,
            grinding_nonce,
            fri_layer_roots_bytes,
            fri_final_poly_bytes,
            quotient_values_bytes,
            queries,
            num_fri_layers: num_fri_layers as u16,
        })
    }
}
