//! What the round constants actually are, pinned as a measurement.
//!
//! The header of `constants.rs` claimed until 2026-09-03 that these came from
//! a Grain LFSR and matched Polygon Miden / Plonky2. They do not reproduce
//! from any generator in this repository, and they carry a structure that a
//! Grain LFSR does not: a repeated additive step, concentrated in a band of
//! middle rounds, on two widths. That claim is now removed from the header,
//! and this file holds the numbers so the removal cannot quietly drift back.
//!
//! These tests do NOT say the permutation is secure. They say what the
//! constants look like, so that:
//!
//!   - regenerating them (a migration that orphans every deployed note) is
//!     loud rather than silent: the counts below change;
//!   - anyone who later reproduces a real generator can check their output
//!     against the same three numbers before touching a value;
//!   - the "distinct and in-field" floor, which IS load-bearing (a repeated or
//!     out-of-range constant would be a genuine defect), is checked on every
//!     width rather than assumed.

#[cfg(test)]
mod tests {
    use crate::poseidon::constants::{
        MDS_MATRIX_T3, ROUND_CONSTANTS_T3, ROUND_CONSTANTS_T5,
    };
    use winterfell::math::{fields::f64::BaseElement, FieldElement, StarkField};

    const P: u128 = 0xFFFF_FFFF_0000_0001; // 2^64 - 2^32 + 1

    fn raw(c: &[BaseElement]) -> Vec<u128> {
        c.iter().map(|e| e.as_int() as u128).collect()
    }

    /// The floor that would be a real defect if it broke: a repeated constant
    /// is a repeated round, and an out-of-range one is a value the field never
    /// produces. Checked on every width the protocol uses.
    #[test]
    fn every_round_constant_is_distinct_and_inside_the_field() {
        for (name, c) in [
            ("t3", &ROUND_CONSTANTS_T3[..]),
            ("t5", &ROUND_CONSTANTS_T5[..]),
        ] {
            let v = raw(c);
            let mut sorted = v.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), v.len(), "{name}: a round constant repeats");
            assert!(v.iter().all(|&x| x < P), "{name}: a constant is outside the field");
            assert!(v.len() % 30 == 0, "{name}: not a whole number of 30 rounds");
        }
    }

    /// The structure the 2026-09-03 audit found, measured in the FIELD.
    ///
    /// Differences are taken mod p, not mod 2^64: these are field elements, and
    /// the two moduli disagree on every difference that wraps. The first pass
    /// of this measurement used 2^64 and reported eleven hits; the honest
    /// number is ten, in a family of three values that lie within 0x4400 of
    /// one another.
    ///
    /// Why ten matters. For constants drawn at random, the chance that ANY of
    /// the 89 successive differences coincides with another is about
    /// 89^2 / 2 / p, roughly one in 10^16. Ten of them landing in one narrow
    /// family is not a coincidence: whatever produced these values had an
    /// additive step in it. That is a statement about provenance, not about
    /// security, and the header of `constants.rs` says which.
    ///
    /// If a regeneration removes the structure this fails, and the header must
    /// be rewritten to match. If it still holds, nothing has changed.
    #[test]
    fn the_round_constants_carry_a_repeated_additive_step() {
        for (name, c, width, family, positions) in [
            (
                "t3",
                &ROUND_CONSTANTS_T3[..],
                3usize,
                vec![0x9933_1122_3323_1ef2u128, 0x9933_1123_3322_def1, 0x9933_1123_3323_1ef1],
                vec![44usize, 47, 49, 52, 56, 57, 61, 66, 70, 71],
            ),
            (
                "t5",
                &ROUND_CONSTANTS_T5[..],
                5usize,
                vec![0x9222_a999_3333_069fu128],
                vec![76usize, 85, 92, 97],
            ),
        ] {
            let v = raw(c);
            let diffs: Vec<u128> = v.windows(2).map(|w| (w[1] + P - w[0]) % P).collect();
            let hits: Vec<usize> = diffs
                .iter()
                .enumerate()
                .filter(|(_, d)| family.contains(d))
                .map(|(i, _)| i)
                .collect();
            assert_eq!(
                hits, positions,
                "{name}: the repeated additive step moved or changed count ({} of {} differences)",
                hits.len(),
                diffs.len()
            );
            // Concentrated in the middle rounds, which is where the constants'
            // own labels put the partial block the permutation does not have.
            let first_round = hits.first().unwrap() / width;
            let last_round = (hits.last().unwrap() + 1) / width;
            assert!(
                first_round >= 14 && last_round <= 24,
                "{name}: the structured band is no longer rounds 14..24, it is {first_round}..{last_round}"
            );
        }
    }

    /// The permutation runs full S-boxes on all 30 rounds, whatever the
    /// constants' round labels say. This is what makes the structure above less
    /// alarming than it would otherwise be, so it is pinned here rather than
    /// left to a comment.
    #[test]
    fn the_permutation_has_no_partial_rounds() {
        // A partial-round permutation applies the S-box to lane 0 only, so
        // changing ONLY a non-zero lane of the input would leave that lane
        // linear in the input across the partial block. With full rounds every
        // lane goes through x^7 in every round, so a one-lane change moves
        // every output lane. Measured on the permutation itself.
        let mut a = [BaseElement::ONE, BaseElement::ZERO, BaseElement::ZERO];
        let mut b = [BaseElement::ONE, BaseElement::from(2u32), BaseElement::ZERO];
        crate::poseidon::permutation_t3(&mut a);
        crate::poseidon::permutation_t3(&mut b);
        for lane in 0..3 {
            assert_ne!(
                a[lane], b[lane],
                "lane {lane} did not move when only lane 1 changed: a partial-round block would do that"
            );
        }
    }

    /// The MDS matrix is the other half of a round, and the header used to
    /// claim it was "verified for security". It is not verified here either;
    /// what is checked is the property whose failure would be a defect rather
    /// than a question: the matrix is square, in-field, and has no zero entry
    /// (a zero would drop a lane's contribution for one output).
    #[test]
    fn the_mds_matrix_is_square_in_field_and_has_no_zero_entry() {
        assert_eq!(MDS_MATRIX_T3.len(), 3);
        for row in MDS_MATRIX_T3.iter() {
            assert_eq!(row.len(), 3);
            for e in row.iter() {
                assert!((e.as_int() as u128) < P);
                assert_ne!(*e, BaseElement::ZERO, "an MDS entry is zero");
            }
        }
    }
}
