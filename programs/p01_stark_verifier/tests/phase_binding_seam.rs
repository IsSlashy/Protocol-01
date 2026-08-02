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
//!
//! # How far those two holes reach — measured, not assumed
//!
//! Neither is a live fund bug today, and this file does not claim one. What
//! stops them is INCIDENTAL, and that is the point:
//!
//!  * Both are inside the transcript. `verify_generic` derives the OOD point
//!    and the query positions from `public_inputs_to_bytes(public_inputs)`, so
//!    a short input list or an out-of-range `depth` cannot be spliced onto an
//!    honest proof — Fiat-Shamir refuses first. Reaching them needs a proof
//!    GENERATED against the degraded statement, i.e. a bespoke prover. The
//!    in-tree prover cannot emit one: `depth` is `path_elements.len()` and both
//!    C3 and C6 have 512-row traces at 32 rows per level, capping it at 16.
//!    A malicious prover is inside the threat model, so this bounds the demo,
//!    not the hole.
//!
//!  * Such a proof would still die at the CONSUMER, because every consumer
//!    rebuilds `sha256` over a FIXED number of `u64`s and compares. A one-input
//!    C1 buffer stores `sha256(8 bytes)`; `subscribe_private_stark` rebuilds
//!    `sha256(16 bytes)`. They do not match.
//!
//! So the phase-1 contract — "`verified = true` means these public inputs were
//! proven" — was false, and the only thing keeping that from being a fund bug
//! was that no consumer happens to rebuild a short hash.
//! `the_verifier_arity_equals_what_every_consumer_rebuilds` and
//! `the_legacy_single_input_entry_point_cannot_satisfy_any_generic_circuit`
//! turn red the day one does. `p01_quantum_wallet::validate_wallet_proof` was
//! already the shape that becomes one: it takes `expected_circuit_id` as a
//! parameter and its callers pass a constant.
//!
//! # What this file does NOT cover
//!
//! **The proof buffer is a reusable capability, not a one-shot ticket.**
//! Nothing marks a verified buffer consumed — not the verifier, not any
//! consumer. A C1 buffer verified for `[nullifier, commitment]` satisfies
//! `subscribe_private_stark`, `split_note_stark`,
//! `unshield_denominated_stark_v3` and `transfer_denominated_stark_v3` alike,
//! because all four rebuild the same two-element hash, and it keeps satisfying
//! them in transaction after transaction until `close_proof_buffer` runs.
//! Replay is prevented ENTIRELY by each consumer's own nullifier record. That
//! is a property of the subscription lineage, not of this program, and it is
//! stated here so it is not mistaken for something this seam enforces.

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
///
/// [ADVERSARY 2026-08-03] The first version of this test asserted
/// `PROOF_DATA_OFFSET == 83` and stopped. That is a constant compared with a
/// constant: it catches somebody editing the `8 + 32 + 1 + 4 + 4 + 1 + 32 + 1`
/// expression and NOTHING ELSE. The offsets thirteen consumer files hard-code
/// are properties of the `#[account] struct ProofBuffer` SERIALIZATION, not of
/// that expression, and the two are joined only by hand. Add a field, reorder
/// two, widen `proof_size` to `u64` — every consumer's `data[82]` starts reading
/// a different field, `write_proof_chunk` starts writing proof bytes over the
/// struct's own tail, and the arithmetic pin stays green through all of it.
///
/// So the layout is now MEASURED by serialising a real `ProofBuffer` with a
/// distinct sentinel in every field and reading the bytes back at the offsets
/// the consumers use. `PROOF_DATA_OFFSET` is then required to equal the length
/// that serialisation actually produced.
#[test]
fn the_phase_two_flag_is_the_last_byte_before_the_proof_data() {
    use anchor_lang::AccountSerialize;

    // 8 disc + 32 authority + 1 circuit_id + 4 proof_size + 4 bytes_written
    // + 1 verified + 32 public_inputs_hash + 1 deep_ali_verified
    assert_eq!(ProofBuffer::PROOF_DATA_OFFSET, 83);
    // A consumer whose minimum length is 82 cannot observe byte 82 at all — no
    // gate it writes against phase 2 could ever fire. `p01_zkspl` and
    // `p01_liquidity` were both moved off 82 for this reason.
    assert_eq!(ProofBuffer::PROOF_DATA_OFFSET - 1, 82);

    // Every field gets a value no other field could produce, so a swap is
    // visible and not just a length change.
    let authority = anchor_lang::prelude::Pubkey::new_from_array([0xA7u8; 32]);
    let buffer = ProofBuffer {
        authority,
        circuit_id: 0xC1,
        proof_size: 0x1122_3344,
        bytes_written: 0x5566_7788,
        verified: true,
        public_inputs_hash: [0x9Eu8; 32],
        deep_ali_verified: true,
    };
    let mut bytes: Vec<u8> = Vec::new();
    buffer.try_serialize(&mut bytes).expect("ProofBuffer must serialise");

    assert_eq!(
        bytes.len(),
        ProofBuffer::PROOF_DATA_OFFSET,
        "the serialised ProofBuffer header is {} bytes but PROOF_DATA_OFFSET says {}. \
         `write_proof_chunk` writes proof bytes at PROOF_DATA_OFFSET and the struct \
         writes itself at 0, so these overlapping by even one byte corrupts both.",
        bytes.len(),
        ProofBuffer::PROOF_DATA_OFFSET
    );

    // The offsets every consumer hard-codes, checked against the real bytes.
    assert_eq!(&bytes[..8], &PROOF_BUFFER_DISCRIMINATOR[..], "discriminator @0..8");
    assert_eq!(&bytes[8..40], authority.as_ref(), "authority @8..40");
    assert_eq!(bytes[40], 0xC1, "circuit_id @40");
    assert_eq!(&bytes[41..45], &0x1122_3344u32.to_le_bytes(), "proof_size @41..45");
    assert_eq!(&bytes[45..49], &0x5566_7788u32.to_le_bytes(), "bytes_written @45..49");
    assert_eq!(bytes[49], 1, "verified @49");
    assert_eq!(&bytes[50..82], &[0x9Eu8; 32], "public_inputs_hash @50..82");
    assert_eq!(
        bytes[82], 1,
        "deep_ali_verified is not at byte 82. Thirteen consumer files read it there; \
         every phase-2 gate in the tree is now reading some other field."
    );

    // …and the false half, so the sentinels above cannot be what makes it pass.
    let mut off: Vec<u8> = Vec::new();
    ProofBuffer {
        authority,
        circuit_id: 0,
        proof_size: 0,
        bytes_written: 0,
        verified: false,
        public_inputs_hash: [0u8; 32],
        deep_ali_verified: false,
    }
    .try_serialize(&mut off)
    .expect("serialise");
    assert_eq!(off[49], 0, "verified @49 must be 0 when false");
    assert_eq!(off[82], 0, "deep_ali_verified @82 must be 0 when false");
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
/// [ADVERSARY 2026-08-03] That last sentence was FALSE and is now true. The
/// trigger was the whitespace-exact substring `"71, 133, 225, 94, 9, 130, 40,
/// 161"`. MEASURED by planting a real-shaped consumer under
/// `programs/p01_zkspl/src/` that reads the buffer, `require!`s `verified` and
/// has no phase-2 gate at all:
///
///   * `[71,133,225,94,9,130,40,161]`                       -> scan GREEN (invisible)
///   * `[0x47, 0x85, 0xe1, 0x5e, 0x09, 0x82, 0x28, 0xa1]`    -> scan GREEN (invisible)
///   * `[71, 133, 225, 94, 9, 130, 40, 161]`                 -> scan RED (control)
///
/// The `checked.len() >= 13` floor does not help: it catches a consumer
/// vanishing, never one arriving. A gate whose reach is decided by whether a
/// future author's rustfmt put spaces after the commas is a gate that reads a
/// source string, which is the failure class this repo keeps producing.
///
/// The trigger is now `contains_discriminator`, which parses integer literals
/// out of the whitespace-stripped source and looks for eight consecutive values
/// equal to the discriminator — decimal or hex, suffixed or not, on one line or
/// eight. `b"account:ProofBuffer"` also triggers, for a consumer that derives
/// the discriminator instead of pasting it (which is the better style, and was
/// invisible before too).
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
    let mut dormant = Vec::new();
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
        if !contains_discriminator(&text) {
            continue;
        }

        // Comments first, then WHOLE `require!(..)` statements — a `require!`
        // whose condition wraps onto the next line is the normal shape once the
        // condition is a disjunction, and a line-based scan sees an empty
        // condition and scores it zero in BOTH directions. That is a false
        // green, and this scan produced one on its first run.
        let code = strip_comments(&text);

        // A file whose discriminator survives only inside a comment is not a
        // consumer — `transfer_denominated_stark.rs` and
        // `unshield_denominated_stark.rs` are the deprecated v2 handlers,
        // commented out WHOLESALE (module, handler, and the `#[program]`
        // registration in `zk_shielded/src/lib.rs`). They are recorded rather
        // than skipped silently, and the assertion below is what keeps
        // "comment the file out" from becoming a way to pass this gate: a
        // dormant file must expose no handler at all.
        if !contains_discriminator(&code) {
            assert!(
                !code.contains("fn handler"),
                "{rel}: the ProofBuffer discriminator is commented out but a live \
                 `fn handler` remains — half-deleted consumer"
            );
            dormant.push(rel);
            continue;
        }

        let mut phase1 = 0usize;
        let mut phase2 = 0usize;
        let mut pins_circuit_zero = false;

        for stmt in require_statements(&code) {
            // The C0 exemption must be a STANDALONE pin, not `circuit_id == 0`
            // appearing anywhere in the file. `p01_quantum_wallet` contains that
            // very text inside its phase-2 disjunction
            // (`circuit_id == WALLET_AUTH_CIRCUIT_ID || deep_ali_verified`), and
            // a substring test exempted the file wholesale — turning the one
            // consumer whose circuit id is a PARAMETER, not a constant, into the
            // one file this scan refused to look at.
            let compact: String = stmt.chars().filter(|c| !c.is_whitespace()).collect();
            if compact.starts_with("require!(circuit_id==0,")
                || compact.starts_with("require!(circuit_id==CIRCUIT_SUBSCRIBER_OWNERSHIP,")
            {
                pins_circuit_zero = true;
            }
            if stmt.contains("deep_ali") || stmt.contains("_deep") {
                phase2 += 1;
            } else if stmt.contains("verified") {
                phase1 += 1;
            }
        }

        checked.push(rel.clone());
        if pins_circuit_zero {
            // Circuit-0-only consumer: phase 2 does not exist for it.
            continue;
        }
        if phase1 == 0 {
            let stmts: Vec<String> = require_statements(&code)
                .into_iter()
                .map(|s| s.chars().take(90).collect::<String>())
                .collect();
            failures.push(format!(
                "{rel}: reads a ProofBuffer but never `require!`s `verified` \
                 (phase1={phase1} phase2={phase2}); statements seen: {stmts:#?}"
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

    // 15 files hard-code the discriminator; 2 of them are the commented-out v2
    // handlers, leaving 13 live consumers across 4 programs. The floor is what
    // stops a trigger or layout change from turning this into a green that
    // scans nothing.
    assert!(
        checked.len() >= 13,
        "expected at least 13 live ProofBuffer consumers under programs/*/src, found {}: \
         {checked:#?} (dormant: {dormant:#?}). The scan found too few files — the trigger \
         or the tree layout changed and this guard has stopped guarding.",
        checked.len()
    );
    assert!(failures.is_empty(), "unguarded proof-buffer consumers:\n{}", failures.join("\n"));
}

/// [SEAM] The scan above is only worth what its parser reads, so the parser is
/// tested on the shapes that actually broke it.
///
/// The first run of `no_consumer_requires_phase_one_without_phase_two` scored
/// `p01_quantum_wallet/src/stark.rs` at "1 phase-1, 0 phase-2" — while the
/// phase-2 `require!` was sitting right there. It wraps onto a second line
/// (the condition is a disjunction), and the scan was line-based, so it read an
/// empty condition and scored it zero. It happened to fail LOUD there. On a
/// file whose phase-1 require wrapped instead, it would have scored 0 phase-1
/// and passed the file silently. Both directions are covered here.
#[test]
fn the_scanner_reads_statements_and_ignores_prose() {
    // Multi-line condition — the shape that produced the false score.
    let src = r#"
        require!(
            parsed.circuit_id == WALLET_AUTH_CIRCUIT_ID || parsed.deep_ali_verified,
            QWalletError::ProofNotVerified
        );
        require!(parsed.verified, QWalletError::ProofNotVerified);
    "#;
    let stmts = require_statements(&strip_comments(src));
    assert_eq!(stmts.len(), 2, "wrapped require! must be one statement: {stmts:#?}");
    assert!(stmts[0].contains("deep_ali_verified"), "{:?}", stmts[0]);
    assert!(!stmts[1].contains("deep_ali"), "{:?}", stmts[1]);

    // Nested parens must not terminate the statement early.
    let nested = "require!(data[..8] == DISC && (a || (b && c)), E::X);";
    let s = require_statements(nested);
    assert_eq!(s.len(), 1);
    assert!(s[0].ends_with("E::X)"), "{:?}", s[0]);

    // Prose must not score. Every consumer documents its gate in a doc comment
    // that names both `require!` and `deep_ali_verified`; a scan that counted
    // those would be grading a file on its own docstring.
    let prose = r#"
        /// `require!(deep_ali_verified, ..)` in `verify_stark_proof` is still there.
        // require!(deep_ali_verified, E::X);
        /* require!(deep_ali_verified, E::X); */
        require!(verified, E::X);
    "#;
    let only_real = require_statements(&strip_comments(prose));
    assert_eq!(
        only_real.len(),
        1,
        "comments were counted as gates: {only_real:#?}"
    );
    assert!(only_real[0].contains("verified") && !only_real[0].contains("deep_ali"));

    // A file that documents a gate it does not have must be caught, which is
    // the whole point of stripping comments before counting.
    let liar = r#"
        /// This handler requires deep_ali_verified. Honest.
        require!(verified, E::X);
    "#;
    let stmts = require_statements(&strip_comments(liar));
    let p2 = stmts.iter().filter(|s| s.contains("deep_ali") || s.contains("_deep")).count();
    let p1 = stmts.iter().filter(|s| !s.contains("deep") && s.contains("verified")).count();
    assert_eq!((p1, p2), (1, 0), "the docstring was counted as the gate");

    // The C0 exemption must be a STANDALONE pin. `p01_quantum_wallet` mentions
    // `circuit_id == WALLET_AUTH_CIRCUIT_ID` inside its phase-2 disjunction, and
    // a substring test over the whole file exempted it — the one consumer whose
    // circuit id is a parameter rather than a constant became the one file the
    // scan refused to look at.
    let pinned = "require!(circuit_id == 0, E::X);";
    let not_pinned =
        "require!(parsed.circuit_id == WALLET_AUTH_CIRCUIT_ID || parsed.deep_ali_verified, E::X);";
    let is_pin = |src: &str| {
        require_statements(src).iter().any(|s| {
            let c: String = s.chars().filter(|ch| !ch.is_whitespace()).collect();
            c.starts_with("require!(circuit_id==0,")
                || c.starts_with("require!(circuit_id==CIRCUIT_SUBSCRIBER_OWNERSHIP,")
        })
    };
    assert!(is_pin(pinned), "a standalone C0 pin must exempt");
    assert!(
        !is_pin(not_pinned),
        "a disjunction that MENTIONS circuit 0 must not exempt the file"
    );
}

/// [ADVERSARY] The scan's TRIGGER decides which files it looks at, so a file it
/// never opens is a file it grades as compliant. This tests the trigger on the
/// spellings that actually made it blind.
///
/// The three cases below are transcriptions of a probe consumer planted under
/// `programs/p01_zkspl/src/` during this pass: it read the buffer, `require!`d
/// `verified`, and had no phase-2 gate. Under the old substring trigger the
/// first two passed `no_consumer_requires_phase_one_without_phase_two`
/// unnoticed and the third failed it.
#[test]
fn the_scan_trigger_does_not_depend_on_how_the_discriminator_is_spelled() {
    let variants = [
        ("canonical", "const D: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];"),
        ("no spaces", "const D: [u8; 8] = [71,133,225,94,9,130,40,161];"),
        (
            "hex lower",
            "const D: [u8; 8] = [0x47, 0x85, 0xe1, 0x5e, 0x09, 0x82, 0x28, 0xa1];",
        ),
        (
            "hex upper, no leading zero",
            "const D: [u8; 8] = [0X47,0X85,0XE1,0X5E,0X9,0X82,0X28,0XA1];",
        ),
        (
            "suffixed",
            "const D = [71u8, 133u8, 225u8, 94u8, 9u8, 130u8, 40u8, 161u8];",
        ),
        (
            "rustfmt one per line",
            "const D: [u8; 8] = [\n 71,\n 133,\n 225,\n 94,\n 9,\n 130,\n 40,\n 161,\n];",
        ),
        ("slice borrow", "if &data[..8] != &[71, 133, 225, 94, 9, 130, 40, 161] { }"),
        ("derived", "let d = &hashv(&[b\"account:ProofBuffer\"]).to_bytes()[..8];"),
    ];
    for (label, src) in variants {
        assert!(
            contains_discriminator(src),
            "the scan would not open a consumer written as `{label}`: {src}"
        );
    }

    // …and it must not fire on things that are not the discriminator, or the
    // scan grades unrelated files and someone deletes it.
    let negatives = [
        "const D: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 160];", // last byte off
        "const D: [u8; 8] = [133, 225, 94, 9, 130, 40, 161, 71];", // rotated
        "const D: [u8; 7] = [71, 133, 225, 94, 9, 130, 40];",      // short
        "let x = 7133225949130401610u64;",                          // one long number
        "const D = [710, 1330, 2250, 940, 90, 1300, 400, 1610];",   // ten-fold
        "const OTHER: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8];",
    ];
    for src in negatives {
        assert!(!contains_discriminator(src), "false trigger on: {src}");
    }

    // A run must be CONSECUTIVE: an interruption resets it.
    assert!(!contains_discriminator(
        "[71, 133, 225, 94] and separately [9, 130, 40, 161]"
    ));
}

// ---------------------------------------------------------------------------

/// Does `src` carry the `ProofBuffer` discriminator in ANY spelling a Rust
/// author could plausibly write?
///
/// Whitespace is stripped, then every integer literal in the file is parsed —
/// decimal (`71`), hex (`0x47`, `0X47`, `0x9`), with or without a `u8`/`_u8`
/// suffix — and the resulting value sequence is searched for eight consecutive
/// entries equal to the discriminator. Non-numeric tokens break the run, so an
/// unrelated array cannot bridge two halves.
///
/// A consumer that DERIVES the discriminator instead of pasting it must name
/// the seed, so `account:ProofBuffer` triggers as well.
fn contains_discriminator(src: &str) -> bool {
    if src.contains("account:ProofBuffer") {
        return true;
    }
    let flat: String = src.chars().filter(|c| !c.is_whitespace()).collect();
    let b = flat.as_bytes();
    let mut run: Vec<u8> = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        // A literal must start a token: not preceded by an identifier char, and
        // not part of a longer number (`1710` must not read as `171`, `0`).
        let prev_is_word = i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
        if !b[i].is_ascii_digit() || prev_is_word {
            if b[i] != b',' {
                run.clear();
            }
            i += 1;
            continue;
        }
        let start = i;
        let (radix, digits_at) = if b[i] == b'0'
            && i + 1 < b.len()
            && (b[i + 1] == b'x' || b[i + 1] == b'X')
        {
            (16u32, i + 2)
        } else {
            (10u32, i)
        };
        let mut j = digits_at;
        while j < b.len() && (b[j] as char).is_digit(radix) {
            j += 1;
        }
        let text = &flat[digits_at..j];
        // Skip an optional integer suffix so `71u8` is one token, not two.
        let mut k = j;
        for suffix in ["_u8", "u8", "_usize", "usize", "_u32", "u32", "_u64", "u64"] {
            if flat[k..].starts_with(suffix) {
                k += suffix.len();
                break;
            }
        }
        // Anything else glued to the number (an identifier, a decimal point)
        // means this was not a standalone byte literal.
        let glued = k < b.len() && (b[k].is_ascii_alphanumeric() || b[k] == b'_' || b[k] == b'.');
        match (glued, u16::from_str_radix(text, radix)) {
            (false, Ok(v)) if v <= u8::MAX as u16 => {
                run.push(v as u8);
                if run.len() > 8 {
                    run.remove(0);
                }
                if run.as_slice() == PROOF_BUFFER_DISCRIMINATOR {
                    return true;
                }
            }
            _ => run.clear(),
        }
        i = if k > start { k } else { start + 1 };
    }
    false
}

/// Drop `//` line comments and `/* */` blocks. Every consumer file documents
/// its gate in prose that names `require!` and `deep_ali_verified`, so a scan
/// that reads comments scores a file on its own docstring — which is precisely
/// the "gate that reads a comment instead of the behaviour" failure this repo
/// keeps producing.
fn strip_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let b: Vec<char> = src.chars().collect();
    let mut i = 0usize;
    let mut in_str = false;
    let mut in_block = 0usize;
    while i < b.len() {
        if in_block > 0 {
            if b[i] == '/' && i + 1 < b.len() && b[i + 1] == '*' {
                in_block += 1;
                i += 2;
                continue;
            }
            if b[i] == '*' && i + 1 < b.len() && b[i + 1] == '/' {
                in_block -= 1;
                i += 2;
                continue;
            }
            if b[i] == '\n' {
                out.push('\n');
            }
            i += 1;
            continue;
        }
        if in_str {
            if b[i] == '\\' {
                i += 2;
                continue;
            }
            if b[i] == '"' {
                in_str = false;
            }
            out.push(b[i]);
            i += 1;
            continue;
        }
        if b[i] == '"' {
            in_str = true;
            out.push(b[i]);
            i += 1;
            continue;
        }
        if b[i] == '/' && i + 1 < b.len() && b[i + 1] == '/' {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if b[i] == '/' && i + 1 < b.len() && b[i + 1] == '*' {
            in_block = 1;
            i += 2;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// Every `require!(..)` invocation as a WHOLE statement, paren-balanced, so a
/// condition that wraps across lines is read in full.
fn require_statements(code: &str) -> Vec<String> {
    const NEEDLE: &str = "require!(";
    let mut out = Vec::new();
    let mut search_from = 0usize;
    while let Some(rel) = code[search_from..].find(NEEDLE) {
        let start = search_from + rel;
        // The call must start a token — do not match `try_require!` etc.
        let ok_boundary = !code[..start]
            .chars()
            .next_back()
            .map(|c| c.is_alphanumeric() || c == '_')
            .unwrap_or(false);
        let body_start = start + NEEDLE.len();
        let mut depth = 1usize;
        let mut end = code.len();
        for (off, ch) in code[body_start..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = body_start + off + ch.len_utf8();
                        break;
                    }
                }
                _ => {}
            }
        }
        if ok_boundary {
            out.push(code[start..end].to_string());
        }
        search_from = body_start;
    }
    out
}

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
