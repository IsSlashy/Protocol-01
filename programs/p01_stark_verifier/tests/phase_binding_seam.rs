//! [SEAM] The phase-1 / phase-2 binding, attacked rather than read.
//!
//! `verify_stark_proof_v2` (phase 1) stores `sha256(public_inputs)` in the
//! buffer; `verify_deep_ali_phase2` (phase 2) recomputes it and refuses to set
//! `deep_ali_verified` unless the two agree. Every consumer in the tree then
//! rebuilds the same hash a third time from its own instruction arguments.
//!
//! Four things have to hold for that to mean anything, and each has its own
//! section below:
//!
//!   1. the encoding is injective, including over LENGTH;
//!   2. phase 1 and phase 2 use the SAME encoding;
//!   3. the number of public inputs the verifier CHECKS equals the number it
//!      HASHES — otherwise a caller can move an unchecked element under a fixed
//!      hash, or (worse) omit elements and have them defaulted to zero;
//!   4. every consumer that reads `verified` also reads `deep_ali_verified`,
//!      unless it is a circuit-0 consumer, for which phase 2 does not exist.
//!
//! (3) is where the defect was: `get_boundary_assertions` defaulted missing
//! public inputs to `Felt::ZERO`, and for C3/C6 an out-of-range `depth` — a
//! CALLER-SUPPLIED public input — selected a shorter assertion list that
//! dropped the root bindings. See `verify::PublicInputCountMismatch`.

use p01_stark_verifier::{hash_public_inputs, verify::expected_public_input_count, ProofBuffer};

// ===========================================================================
// 1 + 2. The public-inputs hash
// ===========================================================================

/// Fixed-width 8-byte little-endian elements mean `Vec<u64> -> Vec<u8>` is
/// injective with no length framing. This is the property the whole phase
/// binding rests on, so it is pinned rather than argued.
///
/// The dangerous shape would be a variable-width encoding (varint, trimmed
/// leading zeros, a textual join): then `[0x0100, 0x02]` and `[0x01, 0x0002]`
/// could share a byte string and phase 2 would accept public inputs phase 1
/// never saw. Any such change turns this red.
#[test]
fn public_inputs_hash_is_injective_over_length() {
    // A shorter list is never a valid encoding of a longer one.
    assert_ne!(hash_public_inputs(&[1]), hash_public_inputs(&[1, 0]));
    assert_ne!(hash_public_inputs(&[1, 0]), hash_public_inputs(&[1, 0, 0]));
    assert_ne!(hash_public_inputs(&[]), hash_public_inputs(&[0]));

    // Order matters.
    assert_ne!(hash_public_inputs(&[1, 2]), hash_public_inputs(&[2, 1]));

    // Nothing collides across a dense sample of short lists.
    let mut seen: Vec<([u8; 32], Vec<u64>)> = Vec::new();
    let push = |v: Vec<u64>, seen: &mut Vec<([u8; 32], Vec<u64>)>| {
        let h = hash_public_inputs(&v);
        for (prev_h, prev_v) in seen.iter() {
            assert!(
                *prev_h != h || *prev_v == v,
                "collision: {prev_v:?} and {v:?} hash the same"
            );
        }
        seen.push((h, v));
    };
    push(vec![], &mut seen);
    for a in [0u64, 1, 0xFF, 0x100, u32::MAX as u64, u64::MAX] {
        push(vec![a], &mut seen);
        for b in [0u64, 1, 0xFF, u64::MAX] {
            push(vec![a, b], &mut seen);
            push(vec![a, b, 0], &mut seen);
        }
    }
}

/// The 32-byte value a freshly initialised buffer carries is `[0u8; 32]`, and
/// `init_proof_buffer*` sets it before `verified` can be true. If the empty
/// input list ever hashed to the all-zero sentinel, a caller could match a
/// never-verified buffer's stored hash by passing no public inputs. It does
/// not, and `verify_deep_ali_phase2`'s `require!(buffer.verified)` is the
/// primary defence, but the coincidence is worth refusing outright.
#[test]
fn the_init_sentinel_is_not_the_hash_of_any_input_list() {
    assert_ne!(hash_public_inputs(&[]), [0u8; 32]);
    for n in 0..8usize {
        let v: Vec<u64> = vec![0; n];
        assert_ne!(hash_public_inputs(&v), [0u8; 32]);
    }
}

/// [SEAM] Phase 1 and phase 2 must hash the SAME bytes.
///
/// They used to be two hand-copied loops (three, counting `verify_uniform`),
/// with nothing pinning them together — a one-character drift in either would
/// have made phase 2 unreachable for every honest proof, or, if the drift went
/// the other way, made it reachable for inputs phase 1 never checked. They are
/// now one function, `hash_public_inputs`. This test states the property that
/// justifies the refactor so a future split is caught.
#[test]
fn every_write_site_and_the_phase_two_recompute_agree() {
    // The exact encoding, spelled out independently of the implementation.
    fn reference(inputs: &[u64]) -> [u8; 32] {
        let mut bytes = Vec::new();
        for v in inputs {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        solana_sha256_hasher::hashv(&[&bytes]).to_bytes()
    }
    for case in [
        vec![],
        vec![42],
        vec![1, 2],
        vec![1, 2, 15],
        vec![1, 2, 3, 4],
        vec![1, 2, 3, 4, 15],
        vec![1, 2, 3, 4, 5, 6],
        vec![u64::MAX; 6],
    ] {
        assert_eq!(hash_public_inputs(&case), reference(&case), "case {case:?}");
    }

    // `verify_stark_proof` (the legacy single-u64 entry point) stores
    // `hash_public_inputs(&[commitment])`, which must be indistinguishable from
    // what `verify_stark_proof_v2` stores for a one-element list. It is — the
    // legacy path used a separate `commitment.to_le_bytes()` expression before
    // and this pins that they never diverge.
    let commitment = 0xDEAD_BEEF_CAFE_1234u64;
    assert_eq!(
        hash_public_inputs(&[commitment]),
        solana_sha256_hasher::hashv(&[&commitment.to_le_bytes()]).to_bytes()
    );
}

// ===========================================================================
// 3. Checked arity == hashed arity
// ===========================================================================

/// The verifier hashes EVERY element the caller supplies but only CHECKS the
/// ones its boundary assertions read. If those two counts can differ, the hash
/// stops being a statement about the proof.
///
/// The second list here is an independent transcription of what the CONSUMERS
/// rebuild — every one of them packs a fixed number of `u64`s and compares to
/// `ProofBuffer.public_inputs_hash`. Both sides are written out so a change to
/// either turns this red instead of silently desynchronising.
#[test]
fn the_verifier_arity_equals_what_every_consumer_rebuilds() {
    // (circuit_id, arity, who rebuilds it)
    let consumers: [(u8, usize, &str); 7] = [
        (0, 1, "p01_quantum_wallet::state::commitment_public_input_bytes \
                (8 bytes = 1 u64); zk_shielded pause/resume/cancel_private_stark"),
        (1, 2, "zk_shielded::{subscribe,split_note,unshield_denominated_v3,\
                transfer_denominated_v3}_stark -> [nullifier, commitment]"),
        (2, 2, "p01_zkspl::prove_balance -> [balance_commitment, token_mint]"),
        (3, 3, "zk_shielded::{subscribe,split_note,unshield_denominated_v3,\
                transfer_denominated_v3}_stark -> [leaf, root, depth=15]"),
        (4, 4, "p01_zkspl::{deposit,withdraw,apply_pending,confidential_transfer} \
                -> [old_commitment, new_commitment, amount_hash, token_mint]"),
        (5, 6, "zk_shielded::{transfer,unshield}_stark -> [n1, n2, oc1, oc2, \
                public_amount, token_mint]"),
        (6, 5, "zk_shielded::{shield_denominated_v3,transfer_denominated_v3}, \
                p01_liquidity::prefund -> [old_leaf, new_leaf, old_root, new_root, depth=15]"),
    ];
    for (circuit_id, arity, who) in consumers {
        assert_eq!(
            expected_public_input_count(circuit_id).unwrap(),
            arity,
            "C{circuit_id} arity drifted from what rebuilds the hash: {who}"
        );
    }
    for unknown in [7u8, 8, 42, u8::MAX] {
        assert!(
            expected_public_input_count(unknown).is_err(),
            "circuit {unknown} must have no arity"
        );
    }
}

/// Every live circuit needs at least two public inputs, which is what makes the
/// legacy `verify_stark_proof` entry point harmless for circuits 1..=6.
///
/// That instruction has no gate against generic circuits — the mirror of
/// `verify_stark_proof_v2`'s `[C0 GATE]` does not exist — and it calls
/// `verify_generic` with `vec![commitment]`, exactly ONE public input. Before
/// the arity check, the missing inputs were defaulted to `Felt::ZERO` and the
/// call could SUCCEED, marking a C1..C6 buffer `verified = true` on a statement
/// whose other public inputs were never supplied. Now every generic circuit
/// refuses a one-element list on arity alone.
///
/// If a circuit with arity 1 is ever added, this goes red and the missing gate
/// has to be written.
#[test]
fn the_legacy_single_input_entry_point_cannot_satisfy_any_generic_circuit() {
    for circuit_id in 1u8..=6 {
        assert!(
            expected_public_input_count(circuit_id).unwrap() > 1,
            "C{circuit_id} has arity 1: `verify_stark_proof`'s vec![commitment] \
             would now be a valid input list for it, and that path has no [C0 GATE]"
        );
    }
    // C0 is the arity-1 circuit, and the legacy path is its ONLY verifier.
    assert_eq!(expected_public_input_count(0).unwrap(), 1);
}

// ===========================================================================
// 4. The consumer contract
// ===========================================================================

/// Anchor account discriminator = `sha256("account:<Name>")[..8]`.
///
/// Fifteen source files across four programs hard-code this value rather than
/// depend on this crate. Pinning it here means the scan below keys on something
/// that cannot be got wrong by accident: a consumer that does not carry these
/// bytes cannot read a `ProofBuffer` at all.
const PROOF_BUFFER_DISCRIMINATOR: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

#[test]
fn the_hardcoded_discriminator_is_the_real_one() {
    let h = solana_sha256_hasher::hashv(&[b"account:ProofBuffer"]).to_bytes();
    assert_eq!(
        &h[..8],
        &PROOF_BUFFER_DISCRIMINATOR[..],
        "every consumer's hard-coded discriminator is wrong, or the account was renamed"
    );
}

/// The byte offsets a consumer must reach to see the phase-2 flag.
#[test]
fn the_phase_two_flag_is_the_last_byte_before_the_proof_data() {
    // 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written
    // + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified
    assert_eq!(ProofBuffer::PROOF_DATA_OFFSET, 83);
    // A consumer whose minimum length is 82 cannot observe byte 82 at all — no
    // gate it writes against phase 2 could ever fire. `p01_zkspl` and
    // `p01_liquidity` were both moved off 82 for this reason.
    assert_eq!(ProofBuffer::PROOF_DATA_OFFSET - 1, 82);
}

/// [SEAM] The enforcement the measurement never had.
///
/// **This is a SOURCE scan, and it is worth exactly what it reads.** It cannot
/// tell whether a `require!` is on a reachable path, whether it guards the
/// right buffer when an instruction reads several, or whether the bytecode
/// deployed to devnet matches this tree. The instruction-level gates live in
/// `p01_zkspl/tests/deep_ali_gate.rs` and `p01_liquidity/tests/deep_ali_gate.rs`
/// (litesvm, real `.so`); this one exists because those cover two programs and
/// a new consumer can be added to any of the four.
///
/// What it does buy: the trigger is the hard-coded `ProofBuffer` discriminator,
/// which a new consumer CANNOT omit — reading the account requires it. So the
/// scan sees every consumer that exists, including one added tomorrow.
///
/// The rule, stated as a counting argument rather than a keyword:
///
///   a file may not `require!` phase 1 more times than it `require!`s phase 2.
///
/// An instruction that validates three buffers has three phase-1 requires and
/// must have three phase-2 requires. The exemption is a file that pins
/// `circuit_id == 0`: circuit 0 runs DEEP-ALI inside phase 1 and
/// `verify_deep_ali_phase2` gates `circuit_id` to 1..=6, so `deep_ali_verified`
/// stays false forever for C0 and requiring it would reject every honest proof.
#[test]
fn no_consumer_requires_phase_one_without_phase_two() {
    let root = repo_root();
    let mut checked = Vec::new();
    let mut failures = Vec::new();

    for path in rust_sources_under(&root.join("programs")) {
        // Only `src/` — a test file may legitimately plant a half-verified
        // buffer, that is what a negative test IS.
        let rel = path
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if !rel.contains("/src/") {
            continue;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !text.contains("71, 133, 225, 94, 9, 130, 40, 161") {
            continue;
        }

        let mut phase1 = 0usize;
        let mut phase2 = 0usize;
        let mut pins_circuit_zero = false;
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with("//") {
                continue;
            }
            let compact: String = t.chars().filter(|c| !c.is_whitespace()).collect();
            if compact.contains("circuit_id==0") || compact.contains("circuit_id==CIRCUIT_SUBSCRIBER_OWNERSHIP") {
                pins_circuit_zero = true;
            }
            if !t.contains("require!(") {
                continue;
            }
            if t.contains("deep_ali") || t.contains("_deep,") || t.contains("_deep ") {
                phase2 += 1;
            } else if t.contains("verified") {
                phase1 += 1;
            }
        }

        checked.push(rel.clone());
        if pins_circuit_zero {
            // Circuit-0-only consumer: phase 2 does not exist for it.
            continue;
        }
        if phase1 == 0 {
            failures.push(format!(
                "{rel}: reads a ProofBuffer but never `require!`s `verified`"
            ));
            continue;
        }
        if phase2 < phase1 {
            failures.push(format!(
                "{rel}: {phase1} phase-1 require!(..verified..) but only {phase2} \
                 phase-2 require!(..deep_ali..). Phase 1 alone is not an AIR check \
                 (measured: it accepts 31 of 32 mint-from-nothing C5 proofs). Either \
                 gate the phase-2 flag at byte 82, or pin `circuit_id == 0`."
            ));
        }
    }

    assert!(
        checked.len() >= 15,
        "expected at least 15 ProofBuffer consumers under programs/*/src, found {}: {checked:#?}. \
         The scan found too few files — the trigger or the tree layout changed and this \
         guard has stopped guarding.",
        checked.len()
    );
    assert!(failures.is_empty(), "unguarded proof-buffer consumers:\n{}", failures.join("\n"));
}

// ---------------------------------------------------------------------------

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("programs/p01_stark_verifier -> repo root")
        .to_path_buf()
}

fn rust_sources_under(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match std::fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                if name == "target" || name == "node_modules" || name == ".git" {
                    continue;
                }
                stack.push(p);
            } else if p.extension().map(|e| e == "rs").unwrap_or(false) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}
