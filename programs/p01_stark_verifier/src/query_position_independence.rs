//! The independence of the FRI query positions, MEASURED.
//!
//! # Why this file exists
//!
//! Every soundness figure this project has ever published multiplies a
//! per-query bit count by `num_queries`. That multiplication is only legal if
//! the queries are *independent* draws from the LDE domain. Before this file,
//! `derive_positions_from_seed` — the function that makes them — had **no test
//! of any kind**, on either side of the language boundary. `git grep` finds it
//! at exactly three call sites and zero assertions.
//!
//! What the tree did have was byte-identity: the seven `cross_language_fixture_
//! digests` pins hash the whole proof, and query positions travel on the wire,
//! so *any* change to the derivation turns those digests red. That catches a
//! change; it does not test a property. The moment a wire format legitimately
//! moves — B4 moved it, B1 moved it, B2 moved it three weeks later — the
//! digests are re-pinned by hand and whatever the derivation now does becomes
//! the new truth, unexamined. A derivation that returned 27 positions all
//! congruent to 0 mod 16 would survive that re-pin in complete silence, and
//! every query would land in terminal fold bucket 0, and 22 queries would be
//! worth one.
//!
//! So these tests assert the properties directly, on the shipped function, with
//! a deterministic seed stream. They cannot flake: the seeds are derived by
//! chained SHA-256 from a fixed start, so a passing run passes forever and a
//! failing run fails forever.
//!
//! # What is asserted, and what each one kills
//!
//! * `lde_size` is a power of two, on all seven configs — otherwise
//!   `val % lde_size` on a uniform `u32` is *biased* toward low positions and
//!   the uniformity argument underneath every bit count is simply false.
//! * Every position bit is balanced. Kills any derivation that pins low bits
//!   (`pos & !15`, `pos * blowup`) or high bits (`pos % (lde/16)`).
//! * The terminal fold index `pos & (fri_final_poly_size - 1)` — the index the
//!   FRI terminal check actually uses — occupies every bucket, aggregated, and
//!   spreads within a single proof. This is the bucket that decides whether
//!   `num_queries` queries test `num_queries` things or one thing.
//! * Flipping any single bit of the 32-byte seed resamples the whole set.
//!   Kills any derivation that reads only part of the seed.
//! * No two query slots sit at a fixed offset from each other. Kills strided,
//!   arithmetic-progression and "base + i" derivations, which pass every
//!   marginal test above and are worth exactly one query.
//!
//! # What is NOT established here
//!
//! This tests the *derivation*, not the transcript that feeds it. That the
//! seed is unpredictable to the prover before he commits is the grinding and
//! Fiat-Shamir story, and lives in `tests/b1_deep_binding.rs`. And no finite
//! test can prove independence; these are necessary conditions chosen because
//! each one is the exact thing a plausible refactor breaks.

use super::*;
use crate::compact_proof::{
    CircuitConfig, CONFIG_BALANCE_PROOF, CONFIG_CONFIDENTIAL_BALANCE, CONFIG_MERKLE_PATH,
    CONFIG_MERKLE_UPDATE, CONFIG_POOL_COMMITMENT, CONFIG_SUBSCRIBER_OWNERSHIP, CONFIG_TRANSFER,
};

const CONFIGS: [(&str, &CircuitConfig); 7] = [
    ("C0", &CONFIG_SUBSCRIBER_OWNERSHIP),
    ("C1", &CONFIG_POOL_COMMITMENT),
    ("C2", &CONFIG_BALANCE_PROOF),
    ("C3", &CONFIG_MERKLE_PATH),
    ("C4", &CONFIG_CONFIDENTIAL_BALANCE),
    ("C5", &CONFIG_TRANSFER),
    ("C6", &CONFIG_MERKLE_UPDATE),
];

/// Number of independent query seeds sampled per circuit.
const SAMPLES: usize = 256;

/// A deterministic seed stream. Chained SHA-256 from a fixed start, so the
/// whole sample — and therefore every assertion below — is reproducible.
fn seed_stream(n: usize) -> Vec<[u8; 32]> {
    let mut out = Vec::with_capacity(n);
    let mut s = [0u8; 32];
    for i in 0..n {
        s = hashv(&[&s, b"p01/query-position-independence", &(i as u64).to_le_bytes()]).to_bytes();
        out.push(s);
    }
    out
}

/// `derive_positions_from_seed` for every seed in the stream.
fn sample(config: &CircuitConfig) -> Vec<Vec<u32>> {
    seed_stream(SAMPLES)
        .iter()
        .map(|s| derive_positions_from_seed(s, config.lde_size, config.num_queries))
        .collect()
}

/// The uniformity of `val % lde_size` on a uniform `u32` is exact iff
/// `lde_size` divides `2^32` — i.e. iff it is a power of two. If it ever is
/// not, positions are biased toward the low end of the domain and every
/// per-query bit count in this repo is an over-claim.
#[test]
fn lde_size_is_a_power_of_two_so_the_modulo_is_unbiased() {
    for (name, c) in CONFIGS {
        assert!(
            c.lde_size.is_power_of_two(),
            "{name}: lde_size {} is not a power of two, so `val % lde_size` in \
             derive_positions_from_seed is BIASED toward low positions and the \
             uniform-query assumption behind every soundness figure is false",
            c.lde_size,
        );
        assert!(
            c.lde_size <= u32::MAX as usize,
            "{name}: lde_size {} exceeds the u32 the derivation reduces",
            c.lde_size,
        );
        assert!(
            c.fri_final_poly_size.is_power_of_two(),
            "{name}: fri_final_poly_size {} is not a power of two, so the terminal \
             index `pos & (size - 1)` is not `pos mod size`",
            c.fri_final_poly_size,
        );
        assert!(
            c.num_queries < c.lde_size,
            "{name}: num_queries {} >= lde_size {} — the distinctness loop cannot \
             terminate",
            c.num_queries, c.lde_size,
        );
    }
}

/// Shape: exactly `num_queries` positions, all distinct, all in range, sorted.
/// Distinctness is what makes the queries a sample WITHOUT replacement; a
/// derivation that allowed repeats would quietly ship duplicate queries that
/// test the same point twice and count twice.
#[test]
fn every_derivation_yields_distinct_in_range_sorted_positions() {
    for (name, c) in CONFIGS {
        for (si, positions) in sample(c).iter().enumerate() {
            assert_eq!(
                positions.len(),
                c.num_queries,
                "{name} seed {si}: got {} positions, config says {}",
                positions.len(),
                c.num_queries,
            );
            for w in positions.windows(2) {
                assert!(
                    w[0] < w[1],
                    "{name} seed {si}: positions must be strictly increasing \
                     (sorted AND distinct); saw {} then {}",
                    w[0], w[1],
                );
            }
            for &p in positions.iter() {
                assert!(
                    (p as usize) < c.lde_size,
                    "{name} seed {si}: position {p} outside the LDE domain of {}",
                    c.lde_size,
                );
            }
        }
    }
}

/// Every bit of the position must move. A derivation that pins the low four
/// bits (`pos & !15`, `pos = i * blowup`) or the high bits (`pos % (lde/16)`)
/// still returns distinct sorted in-range positions and still passes every
/// other structural check in this repo.
///
/// The sample is `SAMPLES * num_queries` positions — 6,912 at worst — so the
/// standard deviation of the per-bit proportion is ~0.006. The 0.40/0.60 band
/// is roughly sixteen sigma wide: it cannot flake, and it cannot miss a pinned
/// bit either.
#[test]
fn every_position_bit_is_balanced() {
    for (name, c) in CONFIGS {
        let bits = c.lde_size.trailing_zeros();
        let all = sample(c);
        let total: usize = all.iter().map(|p| p.len()).sum();
        for b in 0..bits {
            let ones = all
                .iter()
                .flat_map(|p| p.iter())
                .filter(|&&p| (p >> b) & 1 == 1)
                .count();
            let frac = ones as f64 / total as f64;
            assert!(
                (0.40..=0.60).contains(&frac),
                "{name}: bit {b} of the query position is set in {:.1}% of {total} \
                 samples. A pinned position bit means the queries are not uniform \
                 over the LDE domain, so per-query bits do not add and the \
                 `num_queries * log2(1/rho)` term is an OVER-CLAIM.",
                frac * 100.0,
            );
        }
    }
}

/// The terminal fold index is `pos & (fri_final_poly_size - 1)`; see the final
/// branch of `verify_fri_generic`, where `j = pos & (half_i - 1)` and the last
/// layer has `half_i == fri_final_poly_size`. That index is the ONLY thing the
/// terminal degree-bound check discriminates on, so it is where the 4.000
/// bits/query the B2 measurement reports are actually spent.
///
/// Two assertions, because they fail to different mutations: bucket occupancy
/// over the whole sample kills a derivation that never reaches some buckets,
/// and per-proof spread kills one where a SINGLE proof's queries collapse into
/// one bucket while the aggregate still looks fine.
#[test]
fn the_terminal_fold_index_is_not_collapsed() {
    for (name, c) in CONFIGS {
        let mask = (c.fri_final_poly_size - 1) as u32;
        let all = sample(c);
        let total: usize = all.iter().map(|p| p.len()).sum();
        let expected = total as f64 / c.fri_final_poly_size as f64;

        let mut buckets = vec![0usize; c.fri_final_poly_size];
        for p in all.iter().flat_map(|p| p.iter()) {
            buckets[(p & mask) as usize] += 1;
        }
        for (b, &n) in buckets.iter().enumerate() {
            assert!(
                (n as f64) >= 0.5 * expected && (n as f64) <= 2.0 * expected,
                "{name}: terminal fold bucket {b} holds {n} of {total} positions, \
                 expected ~{expected:.0}. Buckets: {buckets:?}. If the queries \
                 concentrate in the terminal domain they are testing the same \
                 coefficient repeatedly and num_queries * 4.000 bits is fiction.",
            );
        }

        // Per proof. E[distinct] = m * (1 - (1 - 1/m)^nq) is 13.2 at nq=27 and
        // 12.1 at nq=22, both against m=16. The floors below are far under
        // those and far over total collapse (which is 1).
        let mut sum_distinct = 0usize;
        let mut min_distinct = usize::MAX;
        for positions in all.iter() {
            let mut seen = vec![false; c.fri_final_poly_size];
            for &p in positions.iter() {
                seen[(p & mask) as usize] = true;
            }
            let d = seen.iter().filter(|&&x| x).count();
            sum_distinct += d;
            min_distinct = min_distinct.min(d);
        }
        let mean = sum_distinct as f64 / all.len() as f64;
        assert!(
            mean >= 9.0,
            "{name}: a proof's {} queries touch only {mean:.2} distinct terminal \
             buckets on average, of {}",
            c.num_queries, c.fri_final_poly_size,
        );
        assert!(
            min_distinct >= 5,
            "{name}: some proof's {} queries collapse into {min_distinct} terminal \
             bucket(s)",
            c.num_queries,
        );
    }
}

/// Flipping ONE bit of the query seed must resample the entire position set.
///
/// This is the test that kills a derivation reading only part of the seed —
/// `hashv(&[&query_seed[..16], ..])`, or a counter that stops advancing, or a
/// seed truncated to a u64. Expected overlap between two independent draws of
/// `nq` distinct positions from `lde_size` is `nq^2 / lde_size`: 1.4 at worst
/// (C0) and 0.06 at best (C3/C5/C6). The bound is `num_queries / 2`, which the
/// honest derivation clears by orders of magnitude and a partial-seed read
/// fails outright at `num_queries`.
#[test]
fn one_seed_bit_resamples_the_whole_position_set() {
    for (name, c) in CONFIGS {
        let base_seed = seed_stream(1)[0];
        let base = derive_positions_from_seed(&base_seed, c.lde_size, c.num_queries);
        let limit = c.num_queries / 2;
        let mut worst = 0usize;
        let mut worst_bit = 0usize;
        for bit in 0..256usize {
            let mut s = base_seed;
            s[bit / 8] ^= 1u8 << (bit % 8);
            let other = derive_positions_from_seed(&s, c.lde_size, c.num_queries);
            let overlap = other.iter().filter(|p| base.contains(p)).count();
            if overlap > worst {
                worst = overlap;
                worst_bit = bit;
            }
        }
        assert!(
            worst <= limit,
            "{name}: flipping seed bit {worst_bit} left {worst} of {} query \
             positions unchanged (limit {limit}). The derivation is not reading \
             the whole seed, so a prover controls part of the query set.",
            c.num_queries,
        );
    }
}

/// No two query slots may sit at a fixed offset from each other.
///
/// A strided derivation — `pos_i = base + i * stride`, an
/// arithmetic progression, anything where one draw determines another — passes
/// bit balance, passes bucket occupancy, passes distinctness, and is worth
/// exactly ONE query. The only thing that catches it is looking at the joint
/// distribution, which nothing in this repo did.
///
/// Positions come back sorted, so slot `i` is the i-th order statistic and the
/// differences are gaps; under independence each gap takes many values across
/// the seed stream. A constant gap is a single value.
#[test]
fn no_two_query_slots_sit_at_a_fixed_offset() {
    /// Distinct differences required across `SAMPLES` seeds. Independence gives
    /// dozens to hundreds; a locked pair gives exactly one.
    const MIN_DISTINCT: usize = 16;

    for (name, c) in CONFIGS {
        let all = sample(c);
        for i in 0..c.num_queries {
            for j in (i + 1)..c.num_queries {
                let mut diffs: Vec<i64> = all
                    .iter()
                    .map(|p| p[j] as i64 - p[i] as i64)
                    .collect();
                diffs.sort_unstable();
                diffs.dedup();
                assert!(
                    diffs.len() >= MIN_DISTINCT,
                    "{name}: query slots {i} and {j} take only {} distinct offsets \
                     across {SAMPLES} seeds (need >= {MIN_DISTINCT}). They are \
                     correlated, so they are not two independent queries and the \
                     per-query bits do not add.",
                    diffs.len(),
                );
            }
        }
    }
}
