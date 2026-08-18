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

/// `sha256("global:unshield")[..8]` and `sha256("global:transfer")[..8]`.
///
/// NOT `unshield_stark` / `transfer_stark`. Those names spell different
/// discriminators — [189, 84, 110, 154, 217, 120, 183, 239] and
/// [162, 42, 22, 116, 244, 79, 60, 190] — and every base-pool call site in this
/// repo sends the `_stark` form while Anchor derives the program's from the
/// FUNCTION names. That mismatch is a separate, older defect: the base-pool
/// STARK path was already unreachable from every shipped client. It is also why
/// disabling these two costs nothing today.
const UNSHIELD_DISC: [u8; 8] = [21, 228, 55, 24, 194, 10, 21, 22];
const TRANSFER_DISC: [u8; 8] = [163, 52, 200, 231, 140, 3, 69, 186];

/// `anchor_lang::error::ErrorCode::InstructionFallbackNotFound`. Read from the
/// crate rather than typed as 101, so an Anchor renumbering cannot make this
/// test assert about the wrong thing.
fn fallback_not_found() -> u32 {
    anchor_lang::error::ErrorCode::InstructionFallbackNotFound.into()
}

fn so_path() -> PathBuf {
    if let Ok(p) = std::env::var("P01_ZK_SHIELDED_SO") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/zk_shielded.so")
}

/// Call `ix` on the real artifact with junk accounts and zeroed arguments, and
/// require that the program has no route for it at all.
///
/// `n_accounts` and `n_arg_bytes` are the shapes `target/idl/zk_shielded.json`
/// recorded while the instruction was still live. They do not have to be
/// correct for the assertion to be sound — Anchor dispatches on the
/// discriminator BEFORE it validates accounts, so a binary that still carries
/// the entrypoint reaches account validation and reports a constraint error,
/// while one that does not has nothing to reach. They are right anyway, so that
/// a failure message shows a realistic call rather than an obviously malformed
/// one.
fn assert_unroutable(ix: &str, disc: [u8; 8], n_accounts: usize, n_arg_bytes: usize) {
    let program = Address::try_from(PROGRAM_ID).expect("program id must parse");
    let so = so_path();
    let bytes = std::fs::read(&so).unwrap_or_else(|e| {
        panic!(
            "\n\
             ============================================================\n\
             CANNOT EXECUTE — target/deploy/zk_shielded.so is not readable.\n\
             ============================================================\n\
             path  : {}\n\
             error : {}\n\n\
             This guard executes real SBF bytecode to show the drain entrypoint\n\
             is gone from the artifact. Without the binary there is nothing to\n\
             execute, so it FAILS rather than passing on an empty result. There\n\
             is deliberately no skip.\n\n\
             Build it (the cargo-build-sbf on PATH is too old):\n  \
             ~/.local/share/solana/install/releases/3.1.9/solana-release/bin/cargo-build-sbf.exe \\\n    \
             --manifest-path programs/zk_shielded/Cargo.toml\n\n\
             A STALE .so is the likelier failure: one built before `{}` was\n\
             unregistered still dispatches it, and this test will say so.\n\
             ============================================================\n",
            so.display(),
            e,
            ix,
        )
    });

    let mut svm = LiteSVM::new();
    svm.add_program(program, &bytes).expect("add_program");

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).expect("airdrop");

    let mut accounts = vec![AccountMeta::new(payer.pubkey(), true)];
    for _ in 1..n_accounts {
        accounts.push(AccountMeta::new(Address::new_from_array([7u8; 32]), false));
    }

    let mut data = disc.to_vec();
    data.extend(std::iter::repeat(0u8).take(n_arg_bytes));

    let instruction = Instruction { program_id: program, accounts, data };
    let msg = Message::new(&[instruction], Some(&payer.pubkey()));
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new(&[&payer], msg, blockhash);

    let err = match svm.send_transaction(tx) {
        Ok(_) => panic!(
            "\n\
             ============================================================\n\
             `{ix}` EXECUTED SUCCESSFULLY IN THE BUILT PROGRAM\n\
             ============================================================\n\
             It was called with {n_arg_bytes} zero bytes of arguments and\n\
             {n_accounts} junk accounts, and the program accepted it. Whatever\n\
             else is true, the entrypoint is live in the artifact and the base\n\
             pool is open.\n\
             ============================================================\n"
        ),
        Err(e) => format!("{:?}", e),
    };

    let code = err
        .split("Custom(")
        .nth(1)
        .and_then(|t| t.split(')').next())
        .and_then(|n| n.trim().parse::<u32>().ok());

    assert_eq!(
        code,
        Some(fallback_not_found()),
        "\n\
         ============================================================\n\
         THE BUILT PROGRAM STILL ROUTES `{}`\n\
         ============================================================\n\
         Expected Anchor {} (InstructionFallbackNotFound): the discriminator\n\
         sha256(\"global:{}\")[..8] matches no instruction in the binary.\n\n\
         Got instead:\n{}\n\n\
         Any other error means dispatch SUCCEEDED and the call died later, in\n\
         account validation or in the handler — i.e. the entrypoint is present,\n\
         and a caller who brings well-formed accounts and an honestly-proved C5\n\
         statement about notes of their own invention gets what it grants:\n\
         real funds out of the pool for `unshield`, permanent unbacked leaves in\n\
         the tree for `transfer`.\n\n\
         If the source is correct and this still fires, the .so is stale. Rebuild:\n  \
         ~/.local/share/solana/install/releases/3.1.9/solana-release/bin/cargo-build-sbf.exe \\\n    \
         --manifest-path programs/zk_shielded/Cargo.toml\n\
         ============================================================\n",
        ix,
        fallback_not_found(),
        ix,
        err,
    );
}

/// 11 accounts, 5 × [u8; 32] + u64 + [u8; 32] = 200 bytes of arguments.
#[test]
fn the_built_program_cannot_dispatch_unshield_at_all() {
    assert_unroutable("unshield", UNSHIELD_DISC, 11, 200);
}

/// 7 accounts, 6 × [u8; 32] = 192 bytes of arguments.
#[test]
fn the_built_program_cannot_dispatch_transfer_at_all() {
    assert_unroutable("transfer", TRANSFER_DISC, 7, 192);
}
