//! Every STARK-backed spend must bound the nullifier's VALUE, not just its width.
//!
//! # The defect
//!
//! p = 2^64 - 2^32 + 1, so 2^64 - p = 2^32 - 1: every nullifier whose value is
//! below 2^32 - 1 has a second 64-bit encoding, `n + p`. Three layers then
//! disagree, and each looks correct on its own:
//!
//!   * `Felt::new(v) = Felt(v % MODULUS)` (goldilocks.rs), and the verifier
//!     builds its boundary assertion from `Felt::new(public_inputs[0])`
//!     (verify.rs) — so `n` and `n + p` produce the SAME assertion and satisfy
//!     the SAME trace. Both proofs verify.
//!   * `hash_public_inputs` extends the buffer with `v.to_le_bytes()` — the RAW
//!     u64, unreduced. So the two get DIFFERENT `public_inputs_hash` values and
//!     are two separate, individually legitimate proof buffers.
//!   * every one of these handlers seeds its nullifier PDA on the raw 32 bytes.
//!     So the two are TWO DISTINCT RECORDS.
//!
//! One witness, two honest proofs, two nullifier records, the note paid twice.
//!
//! The attacker pays at DEPOSIT, not at withdrawal: grind secrets until the
//! Poseidon nullifier lands below 2^32 - 1. That is ~2^-32, about 4.3 billion
//! hashes — an hour on one core.
//!
//! # Why `nullifier[8..] == [0u8; 24]` was not enough
//!
//! That guard bounds the ENCODING to eight bytes. It says nothing about whether
//! those eight bytes are a canonical field element, which is the property the
//! PDA seed actually needs.
//!
//! # The check already existed, one file away
//!
//! `spend_root.rs` applies exactly this bound to the subtree root and to the
//! caller's siblings, with the reasoning written beside it: *"A non-canonical
//! u64 is a distinct value mod p, so accepting one would let two different byte
//! strings name the same root."* It was never carried to public input 0.
//!
//! # ⛔ WHY THIS FILE MATCHES THE `require!` AND NOT A NAME
//!
//! `ZkShieldedError::SpendNonCanonicalFelt` is an Anchor error VARIANT. It is
//! present in the binary and greppable in the source whether or not any
//! handler uses it — it was defined months before any spend checked it, and it
//! is still mapped from `SpendRootError` for a different purpose. A guard that
//! searched for the name would have been GREEN throughout the entire window
//! this defect was live. This repository has shipped exactly that mistake twice
//! (the deep-ALI guard that matched a destructuring tuple; the domain-tag guard
//! that matched a constant's own definition), so the needle here is the
//! comparison itself.

use std::fs;
use std::path::PathBuf;

/// Every instruction that verifies a Goldilocks STARK proof and seeds a
/// nullifier PDA from it.
///
const SPENDS: &[&str] = &[
    "split_note_stark",
    "subscribe_private_stark",
    "subscribe_private_stark_v4",
    "transfer_denominated_stark_v3",
    "unshield_denominated_stark_v3",
    "unshield_denominated_stark_v4",
];

/// The pre-v3 denominated pair, held OUT of `SPENDS` on a measurement rather
/// than on a guess — and pinned below so reviving them cannot be quiet.
///
/// They look alive: they take `Account<'info, DenominatedPool>`, the V1 type,
/// and 46 such accounts held 50.499 SOL on devnet on 2026-08-26;
/// `unshield_denominated_stark` moves lamports. That is why they were checked
/// at all.
///
/// They are not. Both files are wrapped in a single block comment — the module
/// from line 6 to 478 and 6 to 273 respectively, handler included — and
/// `lib.rs` wraps their #[program] registrations the same way, above the line
/// "superseded by unshield_denominated_stark_v3". Nothing in the deployed
/// binary can reach them.
///
/// ⛔ THE VALUE BOUND WAS STILL ADDED TO BOTH, inside the dead block. If either
/// is ever uncommented it comes back correct instead of coming back with the
/// double-spend, and the assertion below is what forces whoever revives it to
/// move it into `SPENDS` and prove the guard is live.
const COMMENTED_OUT: &[&str] = &["transfer_denominated_stark", "unshield_denominated_stark"];

/// The escrow trio is EXCLUDED for cause, not overlooked. `escrow_shield` is
/// Groth16-backed (see the comment above its registration in lib.rs), a
/// different curve and a different public-input encoding, so the `n + p`
/// aliasing argument does not apply to it; `escrow_release` and
/// `write_escrow_outcome` seed on the value it already stored.
const EXCLUDED_FOR_CAUSE: &[&str] = &["escrow_shield", "escrow_release", "write_escrow_outcome"];

fn instructions_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/instructions")
}

fn source_of(name: &str) -> String {
    let p = instructions_dir().join(format!("{name}.rs"));
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("cannot read {}: {e}", p.display()))
}

/// Strip `//` and `/* */` so a mention in prose can never satisfy an assertion.
fn code_only(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut in_block = false;
    for line in src.lines() {
        let mut l = line;
        if in_block {
            match l.find("*/") {
                Some(i) => {
                    l = &l[i + 2..];
                    in_block = false;
                }
                None => continue,
            }
        }
        if let Some(i) = l.find("/*") {
            in_block = !l[i..].contains("*/");
            l = &l[..i];
        }
        let l = match l.find("//") {
            Some(i) => &l[..i],
            None => l,
        };
        out.push_str(l);
        out.push('\n');
    }
    out
}

#[test]
fn every_stark_spend_bounds_the_nullifier_value_not_only_its_width() {
    for name in SPENDS {
        let code = code_only(&source_of(name));

        // The comparison itself, in CODE. Not the error name — see the ⛔ note
        // in the header for why that distinction is the whole point of the file.
        assert!(
            code.contains(
                "u64::from_le_bytes(nullifier[..8].try_into().unwrap()) < crate::state::poseidon_gl::MODULUS"
            ),
            "{name}: no canonical VALUE bound on the nullifier. The proof's public \
             input 0 is reduced mod p by the verifier but hashed raw, and this \
             handler seeds a nullifier PDA on the raw bytes — so n and n + p are \
             two records for one note and it pays twice."
        );

        // And the width bound stays. They are not alternatives: the first says
        // the value is a u64 at all, the second says that u64 is a field
        // element. Dropping either reopens a different half of the hole.
        assert!(
            code.contains("nullifier[8..] == [0u8; 24]"),
            "{name}: lost the ENCODING bound while keeping the value bound"
        );
    }
}

/// ANTI-VACUITY. If the needle above were wrong — renamed constant, moved
/// module, reformatted call — every assertion in this file would still run and
/// measure nothing. This proves the needle names something real.
#[test]
fn the_needle_this_file_greps_for_is_a_real_path_that_compiles() {
    // The constant exists where the needle says it does.
    let poseidon = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/state/poseidon_gl.rs"),
    )
    .expect("src/state/poseidon_gl.rs");
    assert!(
        poseidon.contains("MODULUS"),
        "poseidon_gl::MODULUS no longer exists, so every assertion above is vacuous"
    );

    // And it is the Goldilocks prime, not some other constant that happens to
    // share the name. 2^64 - 2^32 + 1.
    assert_eq!(
        zk_shielded::state::poseidon_gl::MODULUS,
        0xFFFF_FFFF_0000_0001u64,
        "MODULUS is not the Goldilocks prime"
    );

    // The alias the bound exists to reject really is representable: the whole
    // defect turns on 2^64 - p being non-zero.
    let p = zk_shielded::state::poseidon_gl::MODULUS as u128;
    let aliasable = (1u128 << 64) - p;
    assert_eq!(aliasable, (1u128 << 32) - 1, "the aliasable window moved");
    assert!(
        aliasable > 0,
        "if no value aliased, this bound would be dead weight"
    );
}

/// If either pre-v3 file is revived, this goes red and names what to do.
#[test]
fn the_pre_v3_pair_is_still_dead_code_and_still_carries_the_bound() {
    for name in COMMENTED_OUT {
        let src = source_of(name);
        assert!(
            code_only(&src).trim().lines().all(|l| !l.contains("pub fn handler")),
            "{name} has been UNCOMMENTED. It seeds a nullifier PDA on raw bytes, so              move it into SPENDS and let the value-bound assertion cover it."
        );
        // Present in the file even though it is inert, so a revival is correct
        // by default rather than correct only if someone remembers.
        assert!(
            src.contains(
                "u64::from_le_bytes(nullifier[..8].try_into().unwrap()) < crate::state::poseidon_gl::MODULUS"
            ),
            "{name}: the value bound was removed from the dead block, so reviving it              would reopen the double-spend"
        );
    }
}

#[test]
fn the_escrow_trio_is_excluded_on_the_record_and_still_exists() {
    // Excluding by silence is how a gap survives a review. If one of these is
    // ever ported to the Goldilocks verifier, this test keeps compiling and the
    // reader has to come back here and decide again.
    for name in EXCLUDED_FOR_CAUSE {
        let src = source_of(name);
        assert!(
            !src.is_empty(),
            "{name} vanished — re-check whether the exclusion above still holds"
        );
    }
}
