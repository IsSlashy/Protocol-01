//! OOD column probe — is a trace column's out-of-domain opening a PUBLIC LABEL?
//!
//! # The question this answers, and why a digest could not answer it
//!
//! DEEP-ALI makes the prover publish an opening of EVERY trace column at the
//! out-of-domain point `z` (`verify.rs`, the `gamma_pows.iter().take(width)`
//! loop over `proof.ood_current(c)` / `ood_next(c)`). There is NO
//! zero-knowledge masking anywhere in `stark/src` — searched for
//! `zero-knowledge`, `blinding_row`, `randomiz`, `OsRng`, `thread_rng`: zero
//! hits — so those openings are published verbatim.
//!
//! `z` is derived by Fiat-Shamir from the trace root, so it is DIFFERENT for
//! every witness. That is what makes this measurable rather than arguable:
//!
//!   * a column carrying witness data interpolates to a non-constant polynomial
//!     `T_c`, so `T_c(z)` moves when `z` moves — the opening VARIES;
//!   * a column that is constant down the whole trace interpolates to the
//!     CONSTANT polynomial `T_c ≡ k`, so `T_c(z) = k` for every `z` and every
//!     witness — the opening is INVARIANT.
//!
//! So an opening that is identical across genuinely different witnesses is a
//! proof that the column is constant, i.e. a function of the PROGRAM alone.
//! Anyone holding the proof bytes reads it. That is a public label.
//!
//! # Why it decides a design question and not just a curiosity
//!
//! Two proposals turn on this and neither can be budgeted until it is measured:
//!
//!   1. A UNIFIED AIR (one arithmetisation, circuit chosen by selector columns).
//!      Selector columns are binary and constant per cycle by construction, so
//!      if constant columns open invariantly, the selector opening names the
//!      active circuit in cleartext, in the first few hundred bytes of every
//!      proof, on 100% of proofs. The unification would buy nothing.
//!   2. The JOIN-SPLIT COLLAPSE, where an absent leg is filled with a
//!      zero-value dummy note. The claim made for it is that a dummy note is a
//!      VALUE in a few cells of a column that also carries real ones, so its
//!      interpolant is not the zero polynomial and its opening is not a label.
//!      That claim is the same shape as the one this probe tests, and it was
//!      recorded as ESTIMATED. If constant columns already exist here, the
//!      join-split must be re-tested on the same ground before it is trusted.
//!
//! # What this file does NOT claim
//!
//! It measures SEVEN circuits, C1 through C7, as they exist. It does not build a
//! unified AIR and it does not build a dummy leg, so it cannot prove what those
//! would do. It establishes whether the MECHANISM is live in this prover. A
//! negative result here weakens both worries; a positive result kills proposal 1
//! outright and puts proposal 2 on notice.
//!
//! ✅ C7 IS NOW MEASURED. `CASES` is seven wide. The spend circuit used to be
//! absent with no reason written anywhere, recorded as a hole in
//! `c7_pin_coverage.rs` with the note that the entry was "meant to be deleted,
//! not kept" — this is that deletion. It matters more than the other six: its
//! 128 mask rows and the underdetermination argument built on them are exactly
//! what a constant-column probe bears on, and an invariant opening there would
//! mean a column the mask does not actually move.
//!
//! C0 is absent on purpose: it runs the legacy `CompactStarkProof` path with no
//! `ood_current` accessor, so it is a different measurement, not a skipped one.
//!
//! Run:
//!   cargo test -p p01_stark_verifier --test ood_column_probe -- --nocapture

use p01_stark_verifier::compact_proof::{get_circuit_config, GenericCompactProof};
use p01_stark_verifier::goldilocks::Felt;

/// How many genuinely different witnesses each circuit is probed on. Four, not
/// two: with two, a column that happens to collide once reads as invariant.
const WITNESSES: usize = 4;

struct Case {
    label: &'static str,
    circuit_id: u8,
    /// `WITNESSES` proofs of the SAME circuit on DIFFERENT witnesses. Where a
    /// circuit constrains its inputs (C4's `old = new + amount`, C5's
    /// `in1 + in2 + public = out1 + out2`) every tuple below satisfies it —
    /// an unsatisfiable witness would make the generator produce a proof of
    /// something else, or panic, and either way measure nothing.
    build: fn() -> Vec<Vec<u8>>,
}

fn c1() -> Vec<Vec<u8>> {
    [(42u64, 17u64, 7u64, 11u64), (99, 23, 3, 11), (7, 5, 9, 11), (123_456, 789, 1, 11)]
        .iter()
        .map(|(n, s, e, t)| {
            p01_stark::compact::generate_pool_commitment_proof(*n, *s, *e, *t).proof_bytes
        })
        .collect()
}

fn c2() -> Vec<Vec<u8>> {
    [(42u64, 1000u64, 777u64, 999u64), (7, 55, 3, 999), (999, 1, 1, 999), (31_337, 424_242, 13, 999)]
        .iter()
        .map(|(k, b, s, t)| {
            p01_stark::compact::generate_balance_compact_proof(*k, *b, *s, *t).proof_bytes
        })
        .collect()
}

fn c3() -> Vec<Vec<u8>> {
    (0..WITNESSES)
        .map(|w| {
            let pe: Vec<u64> = (0..15u64).map(|i| 1000 + i + (w as u64) * 97).collect();
            let pi: Vec<u8> = (0..15u8).map(|i| ((i as usize + w) % 2) as u8).collect();
            p01_stark::compact::generate_merkle_path_compact_proof(
                777 + (w as u64) * 31,
                &pe,
                &pi,
            )
            .proof_bytes
        })
        .collect()
}

fn c4() -> Vec<Vec<u8>> {
    // old_balance = new_balance + amount holds in all four.
    [
        (42u64, 1000u64, 111u64, 800u64, 222u64, 200u64, 333u64, 999u64),
        (7, 500, 1, 300, 2, 200, 3, 999),
        (99, 60, 5, 20, 6, 40, 7, 999),
        (5, 2000, 9, 1999, 10, 1, 11, 999),
    ]
    .iter()
    .map(|(k, ob, os, nb, ns, a, as_, t)| {
        p01_stark::compact::generate_confidential_balance_compact_proof(
            *k, *ob, *os, *nb, *ns, *a, *as_, *t,
        )
        .proof_bytes
    })
    .collect()
}

fn c5() -> Vec<Vec<u8>> {
    // in_1 + in_2 + public = out_1 + out_2 holds in all four.
    [
        (13u64, 500u64, 77u64, 400u64, 88u64, 100u64, 150u64, 1234u64, 555u64, 65u64, 2222u64, 333u64, 50u64),
        (7, 500, 100, 1, 200, 2, 250, 999, 3, 100, 888, 4, 50),
        (99, 500, 10, 11, 20, 12, 30, 777, 13, 10, 666, 14, 10),
        (5, 500, 1000, 7, 2000, 8, 1500, 111, 9, 1500, 222, 10, 0),
    ]
    .iter()
    .map(|t| {
        p01_stark::compact::generate_transfer_compact_proof(
            t.0, t.1, t.2, t.3, t.4, t.5, t.6, t.7, t.8, t.9, t.10, t.11, t.12,
        )
        .proof_bytes
    })
    .collect()
}

fn c6() -> Vec<Vec<u8>> {
    (0..WITNESSES)
        .map(|w| {
            let pe: Vec<u64> = (0..12u64).map(|i| 100 + i * 13 + (w as u64) * 71).collect();
            let pi: Vec<u8> = (0..12u8).map(|i| ((i as usize + w) % 2) as u8).collect();
            p01_stark::compact::generate_merkle_update_compact_proof(
                111 + (w as u64) * 17,
                222 + (w as u64) * 19,
                &pe,
                &pi, &p01_stark::compact::c6_deterministic_probe_mask(pe.len()))
            .proof_bytes
        })
        .collect()
}

/// C7, the spend circuit — the one the header used to record as an unexplained
/// hole. It takes a mask argument no other circuit has, so its builder differs
/// from the five above in exactly one way: each witness also gets its own mask.
///
/// 🚨 THE MASK MUST VARY WITH THE WITNESS, or this case measures nothing. A
/// column held constant by a SHARED mask would read as witness-invariant and be
/// reported as a public label, which is the opposite of the truth. Four
/// witnesses, four masks.
///
/// ⚠️ The mask here is a deterministic xorshift, like `wire_parity.rs:82-105`.
/// That is right for THIS probe — it asks whether an opening is invariant across
/// witnesses, which does not depend on how the values were drawn — and it is not
/// a secrecy claim. Real proofs draw from `draw_spend_mask` (`stark/src/lib.rs:357`),
/// which rejection-samples `getrandom` and refuses to build without it.
fn c7() -> Vec<Vec<u8>> {
    (0..WITNESSES)
        .map(|w| {
            let mut z = 0xC7_5EED_0000u64 ^ (w as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15);
            let mut next = || {
                z ^= z << 13;
                z ^= z >> 7;
                z ^= z << 17;
                z % 0xFFFF_FFFF_0000_0001
            };
            // 128 mask rows x 10 columns, per `air::spend::{MASK_ROWS, TRACE_WIDTH}`.
            let mask: Vec<u64> = (0..128 * 10).map(|_| next()).collect();
            let pe: Vec<u64> = (0..12u64).map(|i| 0x51A7 + i * 7919 + (w as u64) * 131).collect();
            let pi: Vec<u8> = (0..12u8).map(|i| ((i as usize + w) % 2) as u8).collect();
            let rh = [
                0x1111_1111 + w as u64,
                0x2222_2222,
                0x3333_3333,
                0x4444_4444,
            ];
            p01_stark::compact::generate_spend_compact_proof(
                0x0BAD_C0FF_EE00_1234 + (w as u64) * 37,
                0x1DEA_D0D0_CAFE_5678 + (w as u64) * 41,
                0x0000_0000_0001_E240 + (w as u64) * 43,
                0x0000_0000_0000_002A,
                &pe,
                &pi,
                &rh,
                &mask,
            )
            .proof_bytes
        })
        .collect()
}

const CASES: [Case; 7] = [
    Case { label: "C1 pool_commitment", circuit_id: 1, build: c1 },
    Case { label: "C2 balance_proof", circuit_id: 2, build: c2 },
    Case { label: "C3 merkle_path", circuit_id: 3, build: c3 },
    Case { label: "C4 confidential_balance", circuit_id: 4, build: c4 },
    Case { label: "C5 transfer", circuit_id: 5, build: c5 },
    Case { label: "C6 merkle_update", circuit_id: 6, build: c6 },
    Case { label: "C7 spend", circuit_id: 7, build: c7 },
];

/// One circuit's measurement.
struct Measured {
    label: &'static str,
    circuit_id: u8,
    width: usize,
    /// `(column, value)` for every column whose CURRENT opening never moved.
    invariant_current: Vec<(usize, u64)>,
    /// Same for the NEXT opening.
    invariant_next: Vec<(usize, u64)>,
    /// Quotient segments whose opening never moved.
    invariant_quotient: Vec<(usize, u64)>,
    quotient_len: usize,
}

fn measure(case: &Case) -> Measured {
    let blobs = (case.build)();
    assert_eq!(blobs.len(), WITNESSES, "{}: probe must build {WITNESSES} proofs", case.label);

    // A probe over four IDENTICAL proofs would report every column invariant and
    // would be measuring nothing at all. Pin that the witnesses really differ.
    for i in 0..blobs.len() {
        for j in (i + 1)..blobs.len() {
            assert_ne!(
                blobs[i], blobs[j],
                "{}: witnesses {i} and {j} produced byte-identical proofs, so this \
                 probe would report every column invariant while measuring nothing",
                case.label,
            );
        }
    }

    let config = get_circuit_config(case.circuit_id)
        .unwrap_or_else(|| panic!("{}: no circuit config", case.label));
    let parsed: Vec<GenericCompactProof> = blobs
        .iter()
        .map(|b| {
            GenericCompactProof::from_bytes(b, config)
                .unwrap_or_else(|| panic!("{}: honest proof failed to parse", case.label))
        })
        .collect();

    // The width comes from the CONFIG, not the proof: `GenericCompactProof` has
    // no `trace_width()` of its own (that accessor belongs to `QueryProof`), and
    // the config is what the on-chain verifier reads the openings against.
    let width = config.trace_width;

    let same = |vals: &[Felt]| vals.iter().all(|v| *v == vals[0]);

    let mut invariant_current = Vec::new();
    let mut invariant_next = Vec::new();
    for c in 0..width {
        let cur: Vec<Felt> = parsed.iter().map(|p| p.ood_current(c)).collect();
        let nxt: Vec<Felt> = parsed.iter().map(|p| p.ood_next(c)).collect();
        if same(&cur) {
            invariant_current.push((c, cur[0].as_u64()));
        }
        if same(&nxt) {
            invariant_next.push((c, nxt[0].as_u64()));
        }
    }

    let quotient_len = parsed[0].ood_quotient_len();
    let mut invariant_quotient = Vec::new();
    for s in 0..quotient_len {
        let q: Vec<Felt> = parsed.iter().map(|p| p.ood_quotient(s)).collect();
        if same(&q) {
            invariant_quotient.push((s, q[0].as_u64()));
        }
    }

    Measured {
        label: case.label,
        circuit_id: case.circuit_id,
        width,
        invariant_current,
        invariant_next,
        invariant_quotient,
        quotient_len,
    }
}

fn render(v: &[(usize, u64)]) -> String {
    if v.is_empty() {
        return "none".to_string();
    }
    v.iter()
        .map(|(c, k)| format!("col{c}={k}"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn ood_openings_are_measured_for_witness_invariance() {
    let all: Vec<Measured> = CASES.iter().map(measure).collect();

    println!("\n{}", "=".repeat(104));
    println!("OOD COLUMN PROBE — {WITNESSES} different witnesses per circuit");
    println!("{}", "=".repeat(104));
    println!(
        "An INVARIANT opening across different witnesses proves the column is a CONSTANT\n\
         polynomial, because z is Fiat-Shamir-derived and therefore differs per witness.\n\
         A constant column is a function of the PROGRAM, so its opening is a public label.\n"
    );
    println!(
        "{:<26} {:>5} {:>10} {:>8}  {}",
        "circuit", "width", "invariant", "of", "which columns (current)"
    );
    println!("{}", "-".repeat(104));

    let mut total_invariant = 0usize;
    for m in all.iter() {
        total_invariant += m.invariant_current.len() + m.invariant_next.len();
        println!(
            "{:<26} {:>5} {:>10} {:>8}  {}",
            m.label,
            m.width,
            m.invariant_current.len(),
            m.width,
            render(&m.invariant_current),
        );
        if !m.invariant_next.is_empty() {
            println!("{:<26} {:>5} {:>10} {:>8}  {}", "  (next-row openings)", "", m.invariant_next.len(), m.width, render(&m.invariant_next));
        }
        if !m.invariant_quotient.is_empty() {
            println!(
                "{:<26} {:>5} {:>10} {:>8}  {}",
                "  (quotient segments)",
                "",
                m.invariant_quotient.len(),
                m.quotient_len,
                render(&m.invariant_quotient),
            );
        }
    }

    println!("{}", "-".repeat(104));

    // The pair that matters for classification: C2 and C4 share trace width 4,
    // so width alone cannot separate them and an observer parsing under either
    // config gets a well-formed read. If their invariant signatures differ, the
    // OOD openings separate them on their own.
    let c2 = all.iter().find(|m| m.circuit_id == 2).unwrap();
    let c4 = all.iter().find(|m| m.circuit_id == 4).unwrap();
    println!("\nSAME-WIDTH PAIR (width {} both) — can OOD openings alone separate them?", c2.width);
    println!("  C2 invariant current: {}", render(&c2.invariant_current));
    println!("  C4 invariant current: {}", render(&c4.invariant_current));
    let separable = c2.invariant_current != c4.invariant_current
        || c2.invariant_next != c4.invariant_next;
    println!(
        "  verdict: {}",
        if c2.invariant_current.is_empty() && c4.invariant_current.is_empty() {
            "NEITHER has a constant column — OOD openings carry no label for this pair"
        } else if separable {
            "SEPARABLE — the invariant signatures differ, so the openings label the circuit"
        } else {
            "identical signatures — openings do not separate this pair"
        },
    );

    println!("\n{}", "=".repeat(104));
    if total_invariant == 0 {
        println!(
            "RESULT: NO witness-invariant OOD opening on any of the seven circuits.\n\
             The label mechanism is NOT live in this prover as it stands. That does not\n\
             license a unified AIR: a selector column added by such a design would be\n\
             constant BY CONSTRUCTION, which is exactly the case not represented here.\n\
             It does remove the measured objection to the join-split dummy leg."
        );
    } else {
        println!(
            "RESULT: {total_invariant} witness-invariant OOD opening(s) MEASURED.\n\
             Constant trace columns do open to a fixed value that anyone reading the proof\n\
             bytes recovers. Any design that encodes circuit identity in a constant column\n\
             — a unified AIR's selectors above all — publishes that identity in cleartext."
        );
    }
    println!("{}", "=".repeat(104));
}
