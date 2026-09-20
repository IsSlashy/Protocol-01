//! The STARK parameters every figure is computed from.
//!
//! v1 is read from the deployed verifier's source (`compact_proof.rs`, compiled
//! into this crate). v2 is defined HERE, and this file is meant to stay the one
//! place the v2 numbers live: the v2 prover, the v2 verifier and the documents
//! should take them from this module rather than restate them.

use crate::compact_proof::{self, CircuitConfig};

/// How the verifier turns a transcript hash into a field challenge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Sampler {
    /// Every challenge uniform over the challenge field. The v2 design draws
    /// them by rejection sampling, which gives exactly this. It is also the
    /// model behind the v1 figures pinned in `b1_deep_binding.rs`.
    Uniform,
    /// v1 as shipped (`verify.rs`): `u64::from_le_bytes(sha256(..)[0..8]) % p`,
    /// with 0 mapped to 1 for the RLC, DEEP and FRI-fold challenges. Because
    /// `2^64 = p + 2^32 - 1`, the residues `0..2^32-1` have two preimages each,
    /// so a challenge value can carry up to `2 / 2^64`, and the value 1 carries
    /// `4 / 2^64` (preimages 0, 1, p and p + 1).
    U64ModP,
}

impl Sampler {
    pub fn slug(self) -> &'static str {
        match self {
            Sampler::Uniform => "uniform",
            Sampler::U64ModP => "u64-mod-p",
        }
    }
}

/// Deployed, or a candidate still behind the decision gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Generation {
    V1Deployed,
    V2Candidate,
}

/// One STARK instance, with everything the calculator reads.
#[derive(Clone, Debug, PartialEq)]
pub struct StarkParams {
    /// "C7", or "R" for a v2 profile.
    pub label: String,
    /// "spend", or the v2 shape it describes.
    pub name: String,
    pub generation: Generation,
    /// Degree of the field the Fiat-Shamir challenges are drawn from, over
    /// Goldilocks. 1 = the base field.
    pub ext_degree: u32,
    /// n, the trace length (= |H|).
    pub trace_length: usize,
    /// w, the number of committed trace columns.
    pub trace_width: usize,
    /// k, the number of quotient segments. It bounds the AIR degree the DEEP
    /// step has to cover: `deg(Z_H * sum_j X^{jn} Q_j) <= (k + 1) n`.
    pub quotient_segments: usize,
    /// |D0|, the size of the low-degree-extension domain.
    pub lde_size: usize,
    pub fri_final_poly_size: usize,
    /// Number of final-polynomial coefficients allowed to be non-zero. The FRI
    /// code rate is `fri_final_poly_degree_bound / fri_final_poly_size`.
    pub fri_final_poly_degree_bound: usize,
    pub fri_folding_arity: usize,
    pub num_queries: usize,
    pub grinding_bits: u32,
    /// Upper bound on the AIR constraints combined with random powers
    /// (transition plus boundary). ASSUMED, not read: see `CONSTRAINT_BOUND`.
    pub constraint_bound: usize,
    /// Output size of the Merkle and transcript hash (SHA-256 in v1 and v2).
    pub merkle_hash_bits: u32,
    /// Width of the in-circuit Poseidon digest that names a leaf or a node,
    /// in Goldilocks elements.
    pub digest_felts: u32,
    pub sampler: Sampler,
}

impl StarkParams {
    /// The FRI code rate rho, as the verifier enforces it.
    pub fn rho(&self) -> f64 {
        self.fri_final_poly_degree_bound as f64 / self.fri_final_poly_size as f64
    }

    /// rho+ = (n + 2) / |D0|: the rate the DEEP quotients' numerators live at
    /// (Haböck 2022/1216, eq. (20)).
    pub fn rho_plus(&self) -> f64 {
        (self.trace_length + 2) as f64 / self.lde_size as f64
    }

    pub fn blowup(&self) -> usize {
        self.lde_size / self.trace_length
    }

    /// Number of FRI folding rounds, r.
    pub fn folds(&self) -> u32 {
        let ratio = self.lde_size / self.fri_final_poly_size;
        let arity_log = self.fri_folding_arity.trailing_zeros();
        ratio.trailing_zeros() / arity_log
    }

    /// L, the number of functions batched into the DEEP composition with
    /// powers of one challenge gamma: every trace column (a two-point quotient
    /// at z and gz) and every quotient segment.
    pub fn batched_functions(&self) -> usize {
        self.trace_width + self.quotient_segments
    }

    /// log2 of the challenge field size, e * log2(p).
    pub fn log2_field(&self) -> f64 {
        self.ext_degree as f64 * log2_p()
    }
}

/// log2 of the Goldilocks prime, from the verifier's own `MODULUS`.
pub fn log2_p() -> f64 {
    (crate::goldilocks::MODULUS as f64).log2()
}

/// ASSUMED upper bound on the constraints an AIR combines with random powers.
///
/// Not read from the AIRs: the transition counts live in `stark/src/air/*`
/// (`TRANSFER_NUM_CONSTRAINTS = 29` is the largest) and most boundary counts
/// only in `verify.rs`. The term it feeds is `L+ * C / |F|`, which sits tens of
/// bits away from every binding term; `tests/v1_reproduction.rs` checks that
/// raising it to 1024 moves no figure by 0.01.
pub const CONSTRAINT_BOUND: usize = 64;

/// Nominal output size of SHA-256, the Merkle and transcript hash of v1 and v2.
pub const SHA256_BITS: u32 = 256;

/// Display name of a v1 circuit id. No parameter depends on it; the prose
/// check reads it as the circuit's name (`prose::circuits_in`).
pub fn v1_name(id: u8) -> String {
    match id {
        0 => "subscriber_ownership",
        1 => "pool_commitment",
        2 => "balance_proof",
        3 => "merkle_path",
        4 => "confidential_balance",
        5 => "transfer",
        6 => "merkle_update",
        7 => "spend",
        _ => "unnamed",
    }
    .to_string()
}

fn from_v1_config(id: u8, c: &CircuitConfig) -> StarkParams {
    StarkParams {
        label: format!("C{id}"),
        name: v1_name(id),
        generation: Generation::V1Deployed,
        // Every v1 challenge is one base-field element (`verify.rs`:
        // `derive_ood_point_generic`, `derive_deep_coeff`, `derive_fri_alpha`,
        // `derive_rlc_alpha_with_tag`). `tests/v1_reproduction.rs` holds this.
        ext_degree: 1,
        trace_length: c.trace_length,
        trace_width: c.trace_width,
        quotient_segments: c.quotient_segments,
        lde_size: c.lde_size,
        fri_final_poly_size: c.fri_final_poly_size,
        fri_final_poly_degree_bound: c.fri_final_poly_degree_bound,
        // `verify.rs` folds by two: one alpha per layer, pair leaves.
        fri_folding_arity: 2,
        num_queries: c.num_queries,
        grinding_bits: compact_proof::GRINDING_BITS,
        constraint_bound: CONSTRAINT_BOUND,
        merkle_hash_bits: SHA256_BITS,
        // One felt: lane 0 of a t=3, capacity-1 Poseidon sponge (F2).
        digest_felts: 1,
        sampler: Sampler::U64ModP,
    }
}

/// Every circuit the deployed verifier accepts, read from `compact_proof.rs`
/// through `get_circuit_config`. A circuit added there appears here.
pub fn v1_circuits() -> Vec<StarkParams> {
    (0u8..=u8::MAX)
        .filter_map(|id| compact_proof::get_circuit_config(id).map(|c| from_v1_config(id, c)))
        .collect()
}

/// A v2 candidate profile, from the v2 design (DESIGN-V2 §1, "Profiles").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct V2Profile {
    pub label: &'static str,
    /// Extension degree of the challenge field over Goldilocks.
    pub ext_degree: u32,
    pub blowup: usize,
    pub num_queries: usize,
    pub grinding_bits: u32,
}

/// Profile Q: quadratic extension, blowup 16.
pub const PROFILE_Q: V2Profile =
    V2Profile { label: "Q", ext_degree: 2, blowup: 16, num_queries: 36, grinding_bits: 16 };
/// Profile R, the design's recommendation: cubic extension, blowup 32.
pub const PROFILE_R: V2Profile =
    V2Profile { label: "R", ext_degree: 3, blowup: 32, num_queries: 36, grinding_bits: 16 };
/// Profile R-128: profile R with 47 queries.
pub const PROFILE_R128: V2Profile =
    V2Profile { label: "R-128", ext_degree: 3, blowup: 32, num_queries: 47, grinding_bits: 16 };

pub const V2_PROFILES: [V2Profile; 3] = [PROFILE_Q, PROFILE_R, PROFILE_R128];

/// The shared C6v2 / C7v2 shape (DESIGN-V2 §3): 31 constrained columns, 2 lift
/// columns and 3 randomizer columns.
pub const V2_TRACE_WIDTH: usize = 36;
/// n for C6v2 / C7v2, with the full depth-22 path in the circuit. DESIGN-V2 §2
/// sizes profile R at |D0| = 32768 with blowup 32.
pub const V2_TRACE_LENGTH: usize = 1024;
/// [E] ASSUMED until the v2 AIR exists: 8 segments, as every v1 circuit has
/// (a degree-7 S-box times a periodic selector).
pub const V2_QUOTIENT_SEGMENTS: usize = 8;
/// [E] ASSUMED: C7's terminal shape. The bound is set so that the FRI rate is
/// exactly 1 / blowup.
pub const V2_FRI_FINAL_POLY_SIZE: usize = 32;
/// Poseidon2 digest of the v2 design: 4 Goldilocks elements.
pub const V2_DIGEST_FELTS: u32 = 4;

impl V2Profile {
    pub fn params(&self) -> StarkParams {
        StarkParams {
            label: self.label.to_string(),
            name: "C6v2 / C7v2 shape".to_string(),
            generation: Generation::V2Candidate,
            ext_degree: self.ext_degree,
            trace_length: V2_TRACE_LENGTH,
            trace_width: V2_TRACE_WIDTH,
            quotient_segments: V2_QUOTIENT_SEGMENTS,
            lde_size: V2_TRACE_LENGTH * self.blowup,
            fri_final_poly_size: V2_FRI_FINAL_POLY_SIZE,
            fri_final_poly_degree_bound: V2_FRI_FINAL_POLY_SIZE / self.blowup,
            fri_folding_arity: 2,
            num_queries: self.num_queries,
            grinding_bits: self.grinding_bits,
            constraint_bound: CONSTRAINT_BOUND,
            merkle_hash_bits: SHA256_BITS,
            digest_felts: V2_DIGEST_FELTS,
            // The v2 design draws every challenge by rejection sampling.
            sampler: Sampler::Uniform,
        }
    }
}

pub fn v2_profiles() -> Vec<StarkParams> {
    V2_PROFILES.iter().map(|p| p.params()).collect()
}
