//! Neither base-pool C5 instruction — `unshield` or `transfer` — may be
//! reachable without a membership proof of the notes it spends.
//!
//! # The defect these guards pin
//!
//! `unshield_stark.rs` and `transfer_stark.rs` each accepted a C5 proof and
//! nothing else. C5 proves a well-formed 2-in-2-out transfer; its six public
//! inputs are `[nullifier_1, nullifier_2, output_commitment_1,
//! output_commitment_2, public_amount, token_mint]` and there is no root among
//! them. Both handlers took `_merkle_root` and never read it. So the proof said
//! "these two nullifiers and these two output commitments are consistent" and
//! never "the notes I am spending were deposited". Nullifier PDAs stop REUSE;
//! the attacker picks their own nullifiers, so there was nothing to reuse.
//!
//! What each one then grants differs, and the difference is why `transfer`
//! survived the first pass:
//!
//! * `unshield` paid out. Four invented witnesses through the honest prover
//!   drained up to `pool.total_shielded`.
//! * `transfer` pays nobody — it inserts leaves. Two invented input notes become
//!   two unbacked commitments whose membership is thereafter GENUINE, and Merkle
//!   leaves are permanent. A correctly-fixed `unshield` would honour them. The
//!   exploit is planted now and collected later, past the audit that re-enables
//!   withdrawals.
//!
//! Both are now unregistered in `lib.rs`. Neither can be fixed the way
//! `unshield_denominated_stark_v3` / `subscribe_private_stark` /
//! `split_note_stark` were, because that pattern pivots C1 and C3 off a
//! commitment C1 PUBLISHES, and C5 publishes no input commitment at all —
//! `in_commitment_1` / `in_commitment_2` live inside the trace and are never
//! boundary-asserted. `c5_publishes_no_input_commitment_to_pivot_a_c3_proof_on`
//! below is the guard on that fact; it is the whole reason both are off instead
//! of gated.
//!
//! # Why most of these are source scans
//!
//! What has to be held is an IMPLICATION — routable only if it proves membership
//! — and that is a property of the source, not of any one execution. Those
//! guards need no `.so` and no runtime.
//!
//! The two `the_built_program_cannot_dispatch_*` guards are the exception: they
//! execute the real SBF artifact, because "unregistered in lib.rs" and "absent
//! from the deployable binary" are not the same claim, and only the second one
//! is what protects the pool. They need a FRESH `target/deploy/zk_shielded.so`,
//! and both have been observed failing against a stale one — the `transfer`
//! guard on 2026-08-18, against an artifact whose logs answered
//! `Program log: Instruction: Transfer` before dying at account validation.
//!
//! Run with:
//!   cargo test -p zk_shielded --test unshield_c5_membership

const LIB_SRC: &str = include_str!("../src/lib.rs");
const UNSHIELD_SRC: &str = include_str!("../src/instructions/unshield_stark.rs");
/// The other C5 consumer. It never moved a lamport, which is why it outlived the
/// first pass — but it inserts leaves, and a leaf is permanent. Two invented
/// input notes become two unbacked commitments with genuine membership, which a
/// correctly-fixed `unshield` would later honour.
const TRANSFER_SRC: &str = include_str!("../src/instructions/transfer_stark.rs");
/// The circuit itself. Read-only — `stark/` is under a hard freeze until
/// 2026-09-04 and this file must never be the reason someone edits it.
const C5_AIR_SRC: &str = include_str!("../../../stark/src/air/transfer.rs");

/// Strip `//` line comments and `/* */` blocks so a sentence ABOUT a constraint
/// can never be mistaken for the constraint, and so the commented-out `unshield`
/// registration does not read as a live one. Transposed from
/// `landed_invariants.rs`; same caveat — not a Rust parser, it does not
/// understand string literals containing `//`, and its failure mode is to remove
/// too much, i.e. to fail closed.
fn strip_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let b = src.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
        } else {
            out.push(b[i] as char);
            i += 1;
        }
    }
    out
}

/// Production code of `lib.rs`. The `#[program]` module is the only thing that
/// makes an instruction reachable, so this is where "is `unshield` live?" is
/// decided.
fn lib_code() -> String {
    strip_comments(LIB_SRC)
}

/// Production code of a handler file, cut before any in-file `#[cfg(test)]`.
fn handler_code(src: &str) -> String {
    let stripped = strip_comments(src);
    match stripped.find("#[cfg(test)]") {
        Some(i) => stripped[..i].to_string(),
        None => stripped,
    }
}

fn unshield_code() -> String {
    handler_code(UNSHIELD_SRC)
}

fn transfer_code() -> String {
    handler_code(TRANSFER_SRC)
}

/// `true` when `sha256("global:{name}")[..8]` resolves to something, i.e. the
/// entrypoint is in the `#[program]` module and in the IDL.
///
/// The trailing `(` matters: `pub fn unshield_denominated_stark_v3(` and
/// `pub fn transfer_denominated_stark_v3(` are live, correctly-gated
/// instructions whose names start with the ones being asked about here.
fn is_registered(name: &str) -> bool {
    lib_code().contains(&format!("pub fn {name}("))
}

/// A handler's argument list, where an ignored `_merkle_root` is visible.
fn handler_signature(code: &str) -> String {
    let start = code.find("pub fn handler(").expect("handler signature");
    let end = code[start..].find(") -> Result<").expect("end of signature") + start;
    code[start..end].to_string()
}

/// The two C5 consumers, and what each one costs if it comes back ungated.
///
/// They are NOT the same stake and the messages must not pretend they are. One
/// pays an attacker immediately; the other plants leaves that a future, honest
/// withdrawal path pays out later. The second is the easier one to wave through
/// in review, which is exactly why it gets its own sentence.
struct C5Consumer {
    /// The `#[program]` function name, i.e. what the discriminator is derived from.
    ix: &'static str,
    /// Source of the handler it dispatches to.
    code: fn() -> String,
    /// Why re-registering it ungated is not acceptable.
    stakes: &'static str,
}

const UNSHIELD: C5Consumer = C5Consumer {
    ix: "unshield",
    code: unshield_code,
    stakes:
        "`unshield` was the only instruction that moves value OUT of the base\n\
         ShieldedPool. Re-registering it without closing the gap re-opens a\n\
         drain of the full pool balance to anyone who can run the HONEST prover\n\
         on four witnesses of their own choosing.",
};

const TRANSFER: C5Consumer = C5Consumer {
    ix: "transfer",
    code: transfer_code,
    stakes:
        "`transfer` moves no lamports, and that is the trap: it INSERTS LEAVES.\n\
         Two invented input notes become two unbacked commitments whose tree\n\
         membership is thereafter genuine, and Merkle leaves are permanent. A\n\
         correctly-fixed `unshield` would honour them. The exploit is planted\n\
         now and paid out later, past the audit that re-enables withdrawals.",
};

fn explain(c: &C5Consumer, property: &str, why: &str) -> String {
    let ix = c.ix;
    let stakes = c.stakes;
    format!(
        "\n\
         ============================================================\n\
         BASE-POOL `{ix}` LOST A SAFETY PROPERTY: {property}\n\
         ============================================================\n\
         {why}\n\n\
         {stakes}\n\n\
         It is unregistered because circuit 5 proves no tree membership and,\n\
         unlike C1, publishes nothing a C3 membership proof can be tied to.\n\n\
         Read the DISABLED block above `pub fn {ix}` in lib.rs before changing\n\
         anything here.\n\
         ============================================================\n",
    )
}

#[test]
fn the_comment_stripper_actually_strips() {
    // Every guard below is worth exactly what the stripper is worth: the
    // disablement IS a comment, so a stripper that leaks would report the
    // disabled registration as live, and one that over-eats would report a live
    // registration as disabled.
    let s = strip_comments("a // b\nc /* d\ne */ f");
    assert!(!s.contains('b'), "line comment survived: {s:?}");
    assert!(!s.contains('d') && !s.contains('e'), "block comment survived: {s:?}");
    assert!(s.contains('a') && s.contains('c') && s.contains('f'), "code was eaten: {s:?}");

    // And it is being pointed at real files, not empty strings.
    assert!(lib_code().contains("pub mod zk_shielded"), "lib.rs did not parse as expected");
    for c in [&UNSHIELD, &TRANSFER] {
        let code = (c.code)();
        assert!(
            code.contains("pub fn handler("),
            "the handler source for `{}` did not parse",
            c.ix,
        );
        // `handler_signature` indexes into this; a file that no longer contains
        // the marker would make the guards below silently vacuous rather than
        // loud.
        assert!(
            code.contains(") -> Result<"),
            "the handler signature for `{}` is unparseable",
            c.ix,
        );
    }
}

/// The load-bearing implication, applied to one C5 consumer.
///
/// FAILS against the pre-fix tree, where the entrypoint is live and its handler
/// gates on `circuit_id == 5` alone.
fn assert_routable_only_with_membership(c: &C5Consumer) {
    if !is_registered(c.ix) {
        // Disabled: closed by unreachability. Nothing further to require of the
        // handler.
        return;
    }

    let code = (c.code)();

    assert!(
        code.contains("circuit_id == 3"),
        "{}",
        explain(
            c,
            "it is registered again with no circuit-3 (merkle_path) proof",
            "A C5 proof alone attests knowledge of two nullifiers, two output\n\
             commitments, an amount and a mint. It does NOT attest that the spent\n\
             notes were ever deposited. Membership comes only from C3.",
        )
    );

    assert!(
        code.contains("is_valid_root(&merkle_root)"),
        "{}",
        explain(
            c,
            "the membership root is not pinned to the pool's valid-root ring",
            "A C3 proof against an attacker-chosen root proves membership in an\n\
             attacker-chosen tree. `is_valid_root` is what makes the root one the\n\
             pool actually vouched for.",
        )
    );

    assert!(
        !handler_signature(&code).contains("_merkle_root"),
        "{}",
        explain(
            c,
            "the handler still ignores its merkle_root argument",
            "The leading underscore was the original tell. A handler that never\n\
             reads the root cannot be reconstructing a public-inputs hash that\n\
             binds it, whatever else it checks.",
        )
    );

    // Two input nullifiers are two independent membership statements. One
    // (leaf, root) proof says nothing about the other leaf, so one C3 buffer
    // cannot cover both inputs.
    assert!(
        code.matches("circuit_id == 3").count() >= 2,
        "{}",
        explain(
            c,
            "only one membership proof for two input notes",
            "C5 spends nullifier_1 AND nullifier_2. A single C3 proof binds a\n\
             single leaf, so the second input note would be unproven — and one\n\
             invented note per transaction is still the same defect, only slower.",
        )
    );
}

/// The second, independent tripwire, taken from the proof side rather than the
/// registration side. Also FAILS against the pre-fix tree.
fn assert_six_value_hash_implies_unregistered(c: &C5Consumer) {
    // 6 × u64 = 48 bytes, and the six are the C5 public inputs. If this is still
    // what the handler hashes, no root is bound, and the instruction must not be
    // reachable.
    if !(c.code)().contains("let mut pub_buf = [0u8; 48];") {
        return;
    }

    assert!(
        !is_registered(c.ix),
        "{}",
        explain(
            c,
            "it is registered while its proof check still binds only six values",
            "The reconstructed hash covers [nullifier_1, nullifier_2,\n\
             output_commitment_1, output_commitment_2, public_amount,\n\
             token_mint]. No root, therefore no membership, therefore anyone who\n\
             can run the prover can spend notes that were never deposited.",
        )
    );
}

#[test]
fn unshield_is_routable_only_if_it_proves_membership() {
    assert_routable_only_with_membership(&UNSHIELD);
}

#[test]
fn transfer_is_routable_only_if_it_proves_membership() {
    assert_routable_only_with_membership(&TRANSFER);
}

#[test]
fn the_c5_public_inputs_hash_binds_no_root_so_unshield_stays_off() {
    assert_six_value_hash_implies_unregistered(&UNSHIELD);
}

#[test]
fn the_c5_public_inputs_hash_binds_no_root_so_transfer_stays_off() {
    assert_six_value_hash_implies_unregistered(&TRANSFER);
}

/// Why the C1+C3 pattern cannot be transplanted here — the fact that decided
/// "disable" over "gate".
///
/// The fixed instructions (`unshield_denominated_stark_v3`,
/// `subscribe_private_stark`, `split_note_stark`) tie C1 to C3 through the
/// `stark_commitment` argument, which works because C1 PUBLISHES the note
/// commitment. C5 publishes no input commitment, so a C3 leaf here could be any
/// leaf already in the tree while the C5 proof spends notes of the attacker's
/// invention — both checks green, drain unchanged.
///
/// If this test fails because C5's public inputs GREW an input commitment, that
/// is good news, not a regression: the sound fix has become implementable. Wire
/// one C3 proof per input note with `c3_i.leaf == in_commitment_i`, re-register
/// `unshield` and `transfer`, and let the two
/// `*_is_routable_only_if_it_proves_membership` guards above take over.
#[test]
fn c5_publishes_no_input_commitment_to_pivot_a_c3_proof_on() {
    let src = strip_comments(C5_AIR_SRC);
    let start = src
        .find("pub struct TransferPublicInputs {")
        .expect("TransferPublicInputs moved or was renamed — re-read stark/src/air/transfer.rs");
    let body_start = src[start..].find('{').unwrap() + start + 1;
    let body_end = src[body_start..].find('}').unwrap() + body_start;

    let fields: Vec<String> = src[body_start..body_end]
        .split(',')
        .filter_map(|f| {
            let f = f.trim();
            let f = f.strip_prefix("pub ")?;
            Some(f.split(':').next()?.trim().to_string())
        })
        .collect();

    assert_eq!(
        fields,
        vec![
            "nullifier_1",
            "nullifier_2",
            "output_commitment_1",
            "output_commitment_2",
            "public_amount",
            "token_mint",
        ],
        "\n\
         ============================================================\n\
         CIRCUIT 5's PUBLIC INPUTS CHANGED\n\
         ============================================================\n\
         `unshield` and `transfer` are disabled because none of these six values\n\
         identifies the notes being SPENT. in_commitment_1 / in_commitment_2 are computed at\n\
         cycles 3 and 6 of the transfer trace and never boundary-asserted, so\n\
         there is nothing on chain to tie a C3 membership proof to.\n\n\
         If an input commitment now appears above, the sound fix is unblocked:\n\
         require one C3 proof per input note, bind c3_i.leaf to in_commitment_i\n\
         the way split_note_stark binds c3.leaf to stark_commitment, pin c3_i.root\n\
         with is_valid_root, and re-register the instruction.\n\n\
         If the list merely got REORDERED, the on-chain public-inputs hash in\n\
         unshield_stark.rs and transfer_stark.rs is now wrong too — those two\n\
         rebuild it positionally.\n\
         ============================================================\n",
    );
}

/// Disabling `unshield` only closes the drain while it is the base pool's sole
/// exit. If a second one appears, this guard is what says so.
///
/// `shield_stark` also calls `token::transfer`, but with the DEPOSITOR as
/// authority — money in, not out. The two markers below are the outbound ones:
/// debiting the pool's lamports, and making the pool PDA sign a token transfer.
#[test]
fn unshield_is_the_only_way_value_leaves_the_base_pool() {
    use std::fs;
    use std::path::PathBuf;

    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/instructions");
    let mut exits: Vec<String> = Vec::new();

    for entry in fs::read_dir(&dir).expect("src/instructions is readable") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let name = path.file_name().unwrap().to_str().unwrap().to_string();
        let src = fs::read_to_string(&path).expect("instruction file is readable");
        let code = strip_comments(&src);

        // Only the BASE pool. DenominatedPool / DenominatedPoolV3 are separate
        // pools with their own (C1+C3-gated) exits.
        let touches_base_pool = code.contains("ShieldedPool")
            && !code.contains("DenominatedPool");
        if !touches_base_pool {
            continue;
        }

        let debits_pool_lamports =
            code.contains("pool.to_account_info().try_borrow_mut_lamports()? -=");
        let pool_signs_a_token_transfer = code.contains("authority: pool.to_account_info()");

        if debits_pool_lamports || pool_signs_a_token_transfer {
            exits.push(name);
        }
    }
    exits.sort();

    assert_eq!(
        exits,
        vec!["unshield_stark.rs".to_string()],
        "\n\
         ============================================================\n\
         THE BASE SHIELDED POOL GREW A SECOND EXIT\n\
         ============================================================\n\
         Disabling `unshield` closes the C5 undeposited-withdrawal drain only\n\
         because it was the pool's only way out. Any other instruction that\n\
         debits the pool's lamports or makes the pool PDA sign a token transfer\n\
         needs the same membership question asked of it before it ships.\n\n\
         Found: {exits:?}\n\
         ============================================================\n",
    );
}

// ---------------------------------------------------------------------------
// The guards that execute bytecode.
//
// Everything above reads source. Source is where the decision lives, but the
// pool is protected by the BINARY, and "commented out in lib.rs" only becomes
// "cannot be called" after a rebuild. These run the real artifact.
//
// They come in a matched pair, and the pair is the point:
//
//   * the NEGATIVE guards say the two C5 entrypoints are gone;
//   * the POSITIVE control says every OTHER entrypoint is still there.
//
// A file that only ever asserts absence cannot tell a surgical removal from a
// broken build — an artifact that dispatches nothing at all would satisfy every
// absence claim in this file and pass. The positive control is what makes
// "exactly two instructions were removed, and no neighbours" a measurement.
//
// MEASURED SHAPE (2026-08-18, litesvm, junk accounts, zeroed arguments):
//   disabled -> no `Program log: Instruction: ...` line, then Custom(101)
//               InstructionFallbackNotFound
//   live     -> `Program log: Instruction: SubscribePrivateStark`, then
//               Custom(102) InstructionDidNotDeserialize
// Anchor announces the instruction name only AFTER the discriminator matches,
// so that log line is direct evidence a route exists rather than an inference
// from an error number.
//
// DO NOT try to answer this question by searching the artifact for
// discriminator byte patterns. That was attempted on 2026-08-18 and reports
// ABSENT for `subscribe_private_stark`, which is in production and demonstrably
// works — the bytes are not stored contiguously in SBF. The method produces
// confident false negatives about live instructions.
// ---------------------------------------------------------------------------

use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::path::PathBuf;

/// `programs/zk_shielded/src/lib.rs` — the deployed devnet id.
const PROGRAM_ID: &str = "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c";

/// `anchor_lang::error::ErrorCode::InstructionFallbackNotFound`. Read from the
/// crate rather than typed as 101, so an Anchor renumbering cannot make these
/// tests assert about the wrong thing.
fn fallback_not_found() -> u32 {
    anchor_lang::error::ErrorCode::InstructionFallbackNotFound.into()
}

/// Anchor's own rule: the discriminator is `sha256("global:<fn name>")[..8]`,
/// derived from the FUNCTION name in the `#[program]` module.
///
/// Computed here rather than transcribed, because a transcribed constant only
/// proves that two humans typed the same bytes. Cross-checked against
/// `target/idl/zk_shielded.json` for all five denominated instructions and for
/// both disabled ones.
///
/// This is also the rule the shipped clients get wrong: they build
/// `global:unshield_stark` / `global:transfer_stark` / `global:shield_stark`
/// from the FILE names, which spell entirely different discriminators. That
/// mismatch predates this work and is why disabling the two C5 entrypoints cost
/// no working flow.
fn discriminator(name: &str) -> [u8; 8] {
    let h = solana_sha256_hasher::hashv(&[format!("global:{name}").as_bytes()]).to_bytes();
    let mut d = [0u8; 8];
    d.copy_from_slice(&h[..8]);
    d
}

/// Every instruction the `#[program]` module currently registers, in source
/// order — the complete set, not a sample. Comments are already stripped, so the
/// two disabled registrations do not appear here.
fn registered_instructions() -> Vec<String> {
    let code = lib_code();
    let start = code.find("pub mod zk_shielded").expect("#[program] module");
    code[start..]
        .match_indices("pub fn ")
        .map(|(at, marker)| {
            let rest = &code[start + at + marker.len()..];
            let end = rest.find('(').expect("a fn name is followed by `(`");
            rest[..end].trim().to_string()
        })
        .collect()
}

fn so_path() -> PathBuf {
    if let Ok(p) = std::env::var("P01_ZK_SHIELDED_SO") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/zk_shielded.so")
}

/// The artifact under test. `P01_ZK_SHIELDED_SO` overrides the path, which is
/// how a program DUMPED FROM THE CHAIN gets measured by this file instead of
/// whatever happens to be in the build directory. That seam is what let the
/// pre-upgrade devnet binary be tested at all.
fn artifact_bytes() -> Vec<u8> {
    let so = so_path();
    std::fs::read(&so).unwrap_or_else(|e| {
        panic!(
            "\n\
             ============================================================\n\
             CANNOT EXECUTE — the program artifact is not readable.\n\
             ============================================================\n\
             path  : {}\n\
             error : {}\n\n\
             These guards execute real SBF bytecode. Without the binary there is\n\
             nothing to execute, so they FAIL rather than passing on an empty\n\
             result. There is deliberately no skip.\n\n\
             Build it (the cargo-build-sbf on PATH is too old):\n  \
             ~/.local/share/solana/install/releases/3.1.9/solana-release/bin/cargo-build-sbf.exe \\\n    \
             --manifest-path programs/zk_shielded/Cargo.toml\n\n\
             A STALE .so is the likelier failure: one built before the two C5\n\
             entrypoints were unregistered still dispatches them, and these tests\n\
             will say so.\n\
             ============================================================\n",
            so.display(),
            e,
        )
    })
}

/// What the program did when called.
struct Outcome {
    /// The Anchor error number, if the failure carried one.
    code: Option<u32>,
    /// `true` when Anchor announced an instruction name, i.e. the discriminator
    /// matched and dispatch happened.
    dispatched: bool,
    /// Raw debug string, for failure messages. Deliberately not pre-parsed: a
    /// runtime error carries no Anchor code at all, and flattening the two kinds
    /// together hides which one occurred.
    raw: String,
}

/// Call one instruction on the artifact with junk accounts and zeroed arguments.
///
/// The account count and argument length do not have to be right for any
/// assertion here to be sound: Anchor matches the discriminator BEFORE it
/// deserializes arguments and before it validates accounts. A live route
/// therefore dies at 102 (arguments) or in account validation, and a missing
/// route dies at 101 having announced nothing. 16 accounts covers the widest
/// instruction in the program (`split_note_stark`, 13); Anchor treats any
/// surplus as `remaining_accounts`.
fn call(bytes: &[u8], name: &str, n_arg_bytes: usize) -> Outcome {
    let program = Address::try_from(PROGRAM_ID).expect("program id must parse");
    let mut svm = LiteSVM::new();
    svm.add_program(program, bytes).expect("add_program");

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).expect("airdrop");

    let mut accounts = vec![AccountMeta::new(payer.pubkey(), true)];
    for _ in 1..16 {
        accounts.push(AccountMeta::new(Address::new_from_array([7u8; 32]), false));
    }

    let mut data = discriminator(name).to_vec();
    data.extend(std::iter::repeat(0u8).take(n_arg_bytes));

    let instruction = Instruction { program_id: program, accounts, data };
    let msg = Message::new(&[instruction], Some(&payer.pubkey()));
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(&[&payer], msg, blockhash);

    let (logs, raw) = match svm.send_transaction(tx) {
        Ok(m) => (m.logs, "Ok(())".to_string()),
        Err(e) => (e.meta.logs.clone(), format!("{:?}", e)),
    };

    Outcome {
        code: raw
            .split("Custom(")
            .nth(1)
            .and_then(|t| t.split(')').next())
            .and_then(|n| n.trim().parse::<u32>().ok()),
        dispatched: logs.iter().any(|l| l.contains("Program log: Instruction: ")),
        raw,
    }
}

// ---------------------------------------------------------------------------
// Negative: the two C5 entrypoints are gone from the artifact.
// ---------------------------------------------------------------------------

fn assert_unroutable(c: &C5Consumer, n_arg_bytes: usize) {
    let bytes = artifact_bytes();
    let ix = c.ix;
    let o = call(&bytes, ix, n_arg_bytes);

    assert_eq!(
        o.code,
        Some(fallback_not_found()),
        "\n\
         ============================================================\n\
         THE BUILT PROGRAM STILL ROUTES `{}`\n\
         ============================================================\n\
         Expected Anchor {} (InstructionFallbackNotFound): the discriminator\n\
         sha256(\"global:{}\")[..8] matches no instruction in the binary.\n\n\
         Got instead:\n{}\n\n\
         Any other error means dispatch SUCCEEDED and the call died later, in\n\
         argument deserialization or account validation — i.e. the entrypoint is\n\
         present, and a caller who brings well-formed accounts and an\n\
         honestly-proved C5 statement about notes of their own invention gets\n\
         what it grants:\n\n{}\n\n\
         If the source is correct and this still fires, the .so is stale. Rebuild:\n  \
         ~/.local/share/solana/install/releases/3.1.9/solana-release/bin/cargo-build-sbf.exe \\\n    \
         --manifest-path programs/zk_shielded/Cargo.toml\n\
         ============================================================\n",
        ix,
        fallback_not_found(),
        ix,
        o.raw,
        c.stakes,
    );

    // The error number says a route was not found. This says Anchor never got
    // as far as naming one — the same fact from the other side, and the half
    // that cannot be produced by an unrelated failure that happens to be 101.
    assert!(
        !o.dispatched,
        "\n\
         ============================================================\n\
         `{ix}` ANSWERED 101 BUT ANCHOR STILL ANNOUNCED IT\n\
         ============================================================\n\
         A `Program log: Instruction: ...` line means the discriminator matched.\n\
         Anchor emits it only after dispatch, so this combination should be\n\
         impossible and the error code is not measuring what it appears to.\n\n\
         Raw:\n{}\n\
         ============================================================\n",
        o.raw,
    );
}

/// `unshield`: 5 x [u8; 32] + u64 + [u8; 32] = 200 bytes of arguments.
#[test]
fn the_built_program_cannot_dispatch_unshield_at_all() {
    assert_unroutable(&UNSHIELD, 200);
}

/// `transfer`: 6 x [u8; 32] = 192 bytes of arguments.
#[test]
fn the_built_program_cannot_dispatch_transfer_at_all() {
    assert_unroutable(&TRANSFER, 192);
}

// ---------------------------------------------------------------------------
// Positive control: every OTHER entrypoint survived.
// ---------------------------------------------------------------------------

/// The disable took exactly two instructions and no neighbours.
///
/// Every instruction still registered in `#[program]` is called on the artifact
/// and must dispatch. With junk accounts they all fail — that is expected and
/// required — but they must fail having been FOUND. `InstructionFallbackNotFound`
/// from any of these means the commenting-out took a live instruction with it,
/// or the artifact is not the program we think it is.
///
/// This is the whole set rather than a chosen five, because a sample cannot
/// distinguish "we removed two" from "we removed two and something else we did
/// not check".
#[test]
fn every_still_registered_instruction_still_dispatches() {
    let names = registered_instructions();

    // Anti-vacuity. A parse that returned nothing would make the loop below
    // assert about an empty set and pass silently, which is the exact failure
    // mode this file exists to prevent elsewhere.
    assert!(
        names.len() >= 20,
        "\n\
         only {} instructions parsed out of lib.rs — the scan is broken, not the\n\
         program. `registered_instructions` looks for `pub fn NAME(` inside\n\
         `pub mod zk_shielded`; check that marker still exists.\n\
         Parsed: {:?}",
        names.len(),
        names,
    );

    // The two under disable must not be in the live set at all. This is what
    // ties the source-level claim to the binary-level one: the same list that
    // drives the positive control is the list the negative guards deny.
    for c in [&UNSHIELD, &TRANSFER] {
        assert!(
            !names.iter().any(|n| n == c.ix),
            "\n\
             `{}` is registered again in lib.rs. Read the DISABLED block above\n\
             `pub fn {}` before going further — re-registering it ungated is:\n\n{}\n",
            c.ix,
            c.ix,
            c.stakes,
        );
    }

    // The production path, named explicitly so a rename cannot quietly shrink
    // what this test covers.
    for must in [
        "subscribe_private_stark",
        "unshield_denominated_stark_v3",
        "transfer_denominated_stark_v3",
        "shield_denominated_v3",
        "split_note_stark",
    ] {
        assert!(
            names.iter().any(|n| n == must),
            "`{must}` is no longer registered — the denominated v3 path IS \
             production, and this test is supposed to be watching it",
        );
    }

    let bytes = artifact_bytes();

    // The criterion is `dispatched`, NOT "the error was something other than
    // 101", and the difference was measured rather than reasoned about. Pointed
    // at an unrelated artifact (`p01_stark_verifier.so` loaded under this
    // program id), the weaker version PASSED for all 24: that program answers
    // Custom(4100) DeclaredProgramIdMismatch, which is not 101, so a control
    // built on "not 101" green-lit a binary that implements none of these
    // instructions. Requiring Anchor to NAME the instruction is the only form
    // of this check that fails against a wrong or broken artifact.
    let mut not_dispatched: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();
    let mut first_raw = String::new();

    for name in &names {
        let o = call(&bytes, name, 0);
        if o.dispatched {
            continue;
        }
        if o.code == Some(fallback_not_found()) {
            removed.push(format!("{name}  ->  no route in the artifact (101)"));
        } else {
            // Compact: when the artifact is wrong, all 24 fail identically and
            // 24 full debug dumps bury the one line that identifies the cause.
            // The first raw failure is printed in full below the list.
            not_dispatched.push(match o.code {
                Some(c) => format!("{name}  ->  Custom({c})"),
                None => format!("{name}  ->  runtime error, no Anchor code"),
            });
            if not_dispatched.len() == 1 {
                first_raw = o.raw;
            }
        }
    }

    assert!(
        removed.is_empty(),
        "\n\
         ============================================================\n\
         PRODUCTION IS DOWN — LIVE INSTRUCTIONS WERE REMOVED TOO\n\
         ============================================================\n\
         These are registered in `#[program]`, and the artifact answers\n\
         InstructionFallbackNotFound for them. Disabling `unshield` and\n\
         `transfer` was supposed to take those two and nothing else:\n\n  {}\n\n\
         {} of {} instructions dispatched.\n\n\
         If the source is right, the artifact is stale — rebuild it. If the\n\
         artifact is right, a registration was commented out that should not\n\
         have been.\n\
         ============================================================\n",
        removed.join("\n  "),
        names.len() - removed.len() - not_dispatched.len(),
        names.len(),
    );

    assert!(
        not_dispatched.is_empty(),
        "\n\
         ============================================================\n\
         THE ARTIFACT NEVER DISPATCHED THESE — IT MAY NOT BE THIS PROGRAM\n\
         ============================================================\n\
         Anchor announces `Program log: Instruction: <Name>` the moment a\n\
         discriminator matches. These produced no such line and did not answer\n\
         101 either, so the call did not reach dispatch at all:\n\n  {}\n\n\
         First failure in full:\n{}\n\n\
         Most likely causes, in order:\n\
           1. `P01_ZK_SHIELDED_SO` points at a different program. A foreign\n\
              Anchor binary loaded under this program id answers Custom(4100)\n\
              DeclaredProgramIdMismatch before it looks at the discriminator.\n\
           2. The crate was built with the `no-log-ix-name` feature, which\n\
              compiles the announcement out. Then NONE of the {} would appear\n\
              here, and this file cannot measure dispatch at all — it would need\n\
              a different signal.\n\
           3. The artifact is corrupt.\n\
         ============================================================\n",
        not_dispatched.join("\n  "),
        first_raw,
        names.len(),
    );
}
