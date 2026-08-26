//! Properties of `claim_period.rs` that a merge must not silently undo.
//!
//! # Why this file exists, and why it is NOT in `claim_period.rs`
//!
//! The no-cancel lot added `mod plumbing_guards` INSIDE
//! `src/instructions/claim_period.rs`. Those guards are good, and they are
//! unreachable in the one scenario that matters: a merge that resolves that file
//! to the pre-landing version deletes the guards along with the behaviour they
//! guard. The suite then drops from 30 tests to fewer, every remaining one
//! passes, and nothing is red. A guard living inside its own subject cannot
//! survive that subject's deletion.
//!
//! MEASURED 2026-08-04. `git merge-base HEAD e900b78c` = `fc6591ee`, 23 files
//! conflict, and `b81755b9` is NOT an ancestor of `e900b78c` — the STARK/B7 line
//! does not carry the subscription lot. The pre-landing `claim_period.rs` on that
//! side contains **zero** occurrences of `plumbing_guards`, `is_exhausted` or
//! `UncheckedAccount`. An earlier audit said that conflict was "entirely CRLF,
//! resolve take-ours both sides"; that was true before the lot rewrote the file
//! and is now false. Taking the STARK side compiles cleanly and reverts the whole
//! revenue leg.
//!
//! This file does not exist on the other branch either, so a merge keeps it: an
//! addition on one side with nothing opposing it is not a conflict. That is the
//! whole trick — the guard arrives from the side being protected.
//!
//! It reads source text, so it needs no `.so` and no runtime. Wire it into CI
//! next to `--lib`:
//!   cargo test -p zk_shielded --test landed_invariants

const CLAIM_PERIOD_SRC: &str = include_str!("../src/instructions/claim_period.rs");

/// Strip `//` line comments and `/* */` blocks so a sentence ABOUT a constraint
/// can never be mistaken for the constraint. Not a Rust parser — it does not
/// understand string literals containing `//` — which is fine here: every
/// property below is a code construct, and the failure mode of the naive
/// stripper is to remove too much, i.e. to fail closed.
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

/// Production code only: everything before the file's own `#[cfg(test)]` module.
///
/// Without this cut the scan reads the in-file guards' string literals as if they
/// were declarations. `plumbing_guards` asserts on the text
/// `"pub retailer: Signer<'info>"`, so a naive whole-file scan finds that exact
/// sequence and concludes the retailer is a signer again — a false alarm on a
/// correct file, caught the first time this gate ran. It cuts the other way too:
/// every property below would otherwise be satisfiable by a string inside a test
/// rather than by the constraint it is supposed to pin.
fn code() -> String {
    let stripped = strip_comments(CLAIM_PERIOD_SRC);
    match stripped.find("#[cfg(test)]") {
        Some(i) => stripped[..i].to_string(),
        None => stripped,
    }
}

/// One message, so a failure explains itself to whoever is mid-merge.
fn explain(property: &str, why: &str) -> String {
    format!(
        "\n\
         ============================================================\n\
         claim_period.rs LOST A LANDED PROPERTY: {property}\n\
         ============================================================\n\
         {why}\n\n\
         If you are mid-merge with the STARK/B7 line, this is almost certainly a\n\
         resolution mistake, not a code change. That branch predates the\n\
         subscription lot, its version of this file is the pre-landing one, and\n\
         taking it COMPILES — which is why nothing else goes red.\n\n\
         Resolve claim_period.rs by taking the version that carries these\n\
         properties (ours, post-landing), then re-run:\n  \
         cargo test -p zk_shielded --lib\n  \
         cargo test -p zk_shielded --test landed_invariants\n  \
         cargo test -p zk_shielded --test subscription_lifecycle   (needs the .so)\n\
         ============================================================\n",
    )
}

#[test]
fn the_comment_stripper_actually_strips() {
    // The scan is only worth what the stripper is worth, and this project has
    // twice had a byte-scan fire on an honest artifact.
    let s = strip_comments("a // b\nc /* d\ne */ f");
    assert!(!s.contains('b'), "line comment survived: {s:?}");
    assert!(!s.contains('d') && !s.contains('e'), "block comment survived: {s:?}");
    assert!(s.contains('a') && s.contains('c') && s.contains('f'), "code was eaten: {s:?}");
}

#[test]
fn the_claim_stays_permissionless() {
    let c = code();
    assert!(
        c.contains("pub retailer: UncheckedAccount<'info>"),
        "{}",
        explain(
            "the retailer is a Signer again",
            "A permissionless claim is what rescues a merchant whose retailer key is gone —\n\
             devnet holds ~5.5 SOL that nobody can currently collect for exactly that reason.\n\
             Reverting to `Signer` re-strands all of it.",
        )
    );
    assert!(
        !c.contains("pub retailer: Signer<'info>"),
        "{}",
        explain("the retailer is declared as Signer", "See above.")
    );
}

#[test]
fn the_payout_destination_stays_pinned_to_the_vault() {
    // Permissionless must never mean redirectable. The constraint below is the
    // only thing standing between "anyone may trigger the payment" and "anyone
    // may choose who gets paid".
    let c = code();
    assert!(
        c.contains("retailer.key() == vault.retailer"),
        "{}",
        explain(
            "the retailer is no longer pinned to vault.retailer",
            "Without this, dropping the signer requirement lets any caller name any\n\
             destination and drain every vault in the program.",
        )
    );
}

#[test]
fn an_exhausted_vault_can_still_be_claimed_while_paused() {
    let c = code();
    assert!(
        c.contains("!vault.is_paused || vault.is_exhausted()"),
        "{}",
        explain(
            "the paused-vault exit is gone",
            "A bare `!vault.is_paused` makes a paused vault unclaimable AND unclosable, so\n\
             its money is stuck for good. Two live devnet vaults are in that state today\n\
             (BsrqCLsXV14biW9RDXaAa7d3zQoPymez7Wuu1w3E4H3Z and\n\
             E1nvLwmLb8J7QxnudJVXF4bdmth4tTZVLPUavVYMrwoP).",
        )
    );
}

#[test]
fn the_final_claim_still_closes_the_vault() {
    let c = code();
    assert!(
        c.contains(".close("),
        "{}",
        explain(
            "close-on-exhaustion is gone",
            "Without it a drained vault sits at its rent forever with is_active = true and\n\
             NO instruction able to close it — cancellation was deleted, so there is no other\n\
             exit. MEASURED: 3,403,440 lamports stranded per subscription, and\n\
             CzVbxcSs... on devnet is already in that state under the deployed binary.",
        )
    );
}

#[test]
fn the_spl_payout_cannot_be_redirected() {
    let c = code();
    assert!(
        c.contains("vault_token_account.owner == vault.key()"),
        "{}",
        explain(
            "the SPL vault-token-account owner check is gone",
            "The vault PDA signs the transfer with its own seeds; without this constraint a\n\
             caller supplies a token account it controls.",
        )
    );
    assert!(
        c.contains("retailer_token_account.owner == vault.retailer"),
        "{}",
        explain(
            "the SPL retailer-token-account owner check is gone",
            "Combined with a permissionless claim, this is what stops whoever sends the\n\
             transaction from pointing the SPL payout at themselves.",
        )
    );
}

#[test]
fn the_instruction_still_declares_the_six_accounts_clients_send() {
    // The shipped mobile and extension builders emit exactly six accounts, and
    // both apps pin that number by parsing THIS struct. If the struct shrinks
    // back to three, those guards follow it and stop meaning anything — so the
    // count is pinned here too, from outside.
    let c = code();
    let start = c.find("pub struct ClaimPeriod<'info>").expect(
        "ClaimPeriod<'info> not found — this gate is broken, or the instruction was renamed",
    );
    let body = &c[start..];
    let end = body.find("\n}").unwrap_or(body.len());
    let n = body[..end]
        .lines()
        .filter(|l| l.trim_start().starts_with("pub ") && l.contains(':'))
        .count();
    assert_eq!(
        n,
        6,
        "{}",
        explain(
            &format!("the account count changed from 6 to {n}"),
            "Six is what apps/mobile, apps/extension and packages/merchant-sdk all send.\n\
             Anchor 0.32 rejects a short list with AccountNotEnoughKeys (3005) inside the\n\
             resolver, before the handler runs, naming neither the vault nor the money.\n\
             If you ADDED an account on purpose, update the three builders and their guards\n\
             in the same commit, then change this number.",
        )
    );
}


// ===========================================================================
// The vault address is f(note secret), and that is a linkage waiting for a
// client change.
// ===========================================================================

/// The invariant, pinned as TEXT so a merge that resolves
/// `subscription_vault.rs` to an older side fails loudly instead of silently
/// deleting the only place it is written down. Same trick, same reason, as the
/// rest of this file: a guard that lives inside its subject dies with it.
#[test]
fn the_note_secret_reuse_invariant_is_still_written_down() {
    let src = include_str!("../src/state/subscription_vault.rs");
    for needle in [
        "A NOTE SECRET MUST NEVER SERVE TWO OPERATIONS",
        "must derive a FRESH secret",
        "HOLDS BY USAGE, NOT BY CONSTRUCTION",
    ] {
        assert!(
            src.contains(needle),
            "{}",
            explain(
                "the note-secret reuse invariant was deleted from subscription_vault.rs",
                "The vault PDA seed is [SEED_PREFIX, retailer, subscriber_id_bytes(), mint] and in\n\
                 private mode subscriber_id_bytes() is Poseidon(note secret). Two operations that\n\
                 share a secret therefore land on correlated vault addresses, in accountKeys, in the\n\
                 clear. Nothing in the program refuses a reused secret — the property holds only\n\
                 because the client mints one secret per note. The comment IS the control.",
            )
        );
    }
}

/// The seed this invariant is about must still be the one the program uses --
/// in EVERY instruction that can open a vault.
///
/// The comment above is only true while the vault PDA is derived from
/// `subscriber_id_bytes()`. If a future change seeds the vault on something
/// else - the nullifier is the tempting one - the warning becomes wrong in a
/// way that reads as reassuring.
///
/// This read ONE file BY PATH until 2026-08-26, when `subscribe_private_stark_v4`
/// was added beside it. A second opener is invisible to a hardcoded
/// `include_str!`, so this invariant would have gone on passing while the new
/// path - the one clients are being moved to - sat unguarded. Both are listed
/// below.
///
/// The ORDER of the seed triple is pinned too. `sharing_a_note_secret_collides_
/// the_vault_address` below hardcodes [prefix, retailer, commitment, mint] as a
/// pure function, so a file that reordered its own seeds would leave that test
/// describing an address the program never derives - and claim_period, pause and
/// resume all re-derive the live order with `bump = vault.bump`, so a reorder
/// bricks every vault the instruction creates.
#[test]
fn the_vault_is_still_seeded_on_the_subscriber_id() {
    const OPENERS: [(&str, &str); 2] = [
        (
            "subscribe_private_stark",
            include_str!("../src/instructions/subscribe_private_stark.rs"),
        ),
        (
            "subscribe_private_stark_v4",
            include_str!("../src/instructions/subscribe_private_stark_v4.rs"),
        ),
    ];

    for (name, src) in OPENERS {
        let c = strip_comments(&src[..src.find("#[cfg(test)]").unwrap_or(src.len())]);
        assert!(
            c.contains("subscriber_commitment.as_ref()"),
            "{}",
            explain(
                &format!("{name}: the vault PDA is no longer seeded on the subscriber commitment"),
                "Re-derive the invariant on subscriber_id_bytes() before changing this. In\n\
                 particular the nullifier is NOT a safe substitute: it is also f(secret), so it\n\
                 buys nothing against leaf enumeration, and in v3 it is PUBLISHED in\n\
                 SubscribePrivateStarkEvent - which would make the vault address computable\n\
                 from a public log.",
            )
        );

        let prefix = c
            .find("SubscriptionVault::SEED_PREFIX,")
            .unwrap_or_else(|| panic!("{name}: the vault seeds no longer start at SEED_PREFIX"));
        let tail = &c[prefix..];
        let mut at = 0usize;
        for seed in [
            "retailer.key().as_ref()",
            "subscriber_commitment.as_ref()",
            "token_mint.as_ref()",
        ] {
            let found = tail
                .find(seed)
                .unwrap_or_else(|| panic!("{name}: `{seed}` is no longer a vault seed"));
            assert!(
                found > at,
                "{}",
                explain(
                    &format!("{name}: the vault seed order changed at `{seed}`"),
                    "The seed order IS the address. The derivation test below hardcodes\n\
                     [prefix, retailer, commitment, mint] and would go on passing against an\n\
                     address this program never derives; and claim_period, pause and resume all\n\
                     re-derive the live order with bump = vault.bump, so a reorder bricks every\n\
                     vault this instruction creates.",
                )
            );
            at = found;
        }
    }
}

/// The mechanism itself, executed rather than described.
///
/// Two subscriptions that share a note secret land on the SAME vault address;
/// two that do not, land on different ones. That is the whole linkage, in four
/// derivations. It needs no runtime and no `.so` — `find_program_address` is a
/// pure function, which is exactly why an observer can run it too.
///
/// ⚠️ What this test canNOT check is the invariant itself. Nothing on chain
/// refuses a reused secret, so there is no red state to assert. It pins the
/// CONSEQUENCE, so that anyone who reads it understands what reuse costs.
#[test]
fn sharing_a_note_secret_collides_the_vault_address() {
    use solana_address::Address;
    use std::str::FromStr;

    // zk_shielded on devnet. The property is independent of the program id;
    // the real one is used so the test describes the real deployment.
    let program = Address::from_str("GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c").unwrap();
    let prefix = b"subscription_vault";
    let retailer = [7u8; 32];
    let mint = [0u8; 32]; // native SOL

    // Stand-ins for Poseidon(secret). Their VALUES do not matter; what matters
    // is that one is reused and the other is not.
    let commitment_a = [0xAAu8; 32];
    let commitment_b = [0xBBu8; 32];

    let derive = |c: &[u8; 32]| {
        Address::find_program_address(&[prefix, &retailer, c, &mint], &program).0
    };

    assert_eq!(
        derive(&commitment_a),
        derive(&commitment_a),
        "the derivation is not deterministic; the rest of this test means nothing"
    );
    assert_ne!(
        derive(&commitment_a),
        derive(&commitment_b),
        "two different secrets must not collide, or the seed carries no identity at all"
    );

    // The statement the invariant makes, made concrete: a second operation
    // reusing the first one's secret is not merely similar, it is the SAME
    // public address, and anyone reading accountKeys sees both.
    let renewal_reusing_the_secret = derive(&commitment_a);
    let first_subscription = derive(&commitment_a);
    assert_eq!(
        renewal_reusing_the_secret, first_subscription,
        "reuse produces one address for two operations - that is the linkage"
    );
}

// ---------------------------------------------------------------------------
// 🚨 THE NULLIFIER IS THE DOUBLE-SPEND KEY, AND NOTHING BOUNDED ITS VALUE.
//
// Every STARK spend checks `nullifier[8..] == [0u8; 24]` and has since the
// beginning. That bounds the ENCODING of the high 24 bytes. It says nothing
// about the low 8, and the low 8 are a Goldilocks felt.
//
// MEASURED 2026-08-26 against the deployed verifier: the boundary assertion is
// `Felt::new(public_inputs[0])`, `Felt::new(v) = Felt(v % p)`, and both
// `public_inputs_to_bytes` and `hash_public_inputs` hash the u64 RAW with no
// range check anywhere. 2^64 - p = 2^32 - 1 exactly, so every nullifier below
// 2^32 - 1 has a second in-range encoding `n + p`: ONE field element, TWO
// `NullifierRecord` addresses, both `init`-able, and two fully honest proofs off
// one witness. Executed end to end in
// `tests/subscribe_v4_adversarial.rs::one_field_element_cannot_be_spent_under_two_nullifier_encodings`:
// with the require removed the alias spend LANDS and the pool pays a second
// denomination for one note.
//
// The fix is one require per spend, and the failure mode of a fix repeated six
// times is that the seventh site forgets it. So this guard reads the DIRECTORY
// rather than a hand-written list: a new spend instruction is covered the day it
// lands, not the day someone remembers this file.
// ---------------------------------------------------------------------------

/// Files whose LIVE code seeds a `NullifierRecord` but which are not
/// single-nullifier STARK spends, with the reason each is out of scope. Named
/// rather than skipped silently, so a new file cannot join this set without an
/// edit here.
///
/// Both entries below are live CODE that no live REGISTRATION reaches: MEASURED
/// 2026-08-26 by stripping comments from `lib.rs`, `pub fn transfer(` and
/// `pub fn unshield(` are inside a block comment, and only 24 of the 35 `pub fn`
/// matches in that file survive the strip. They are excused for their SHAPE --
/// two nullifiers, not one -- and not for being unroutable, so that re-enabling
/// them does not silently re-enable an unchecked nullifier.
///
/// ⛔ `escrow_shield.rs`, `transfer_denominated_stark.rs` and
/// `unshield_denominated_stark.rs` are deliberately ABSENT from this list. All
/// three bodies are wholly inside a block comment, and so are their `lib.rs`
/// registrations, so nothing in them can execute and the scan below -- which
/// reads CODE, comments stripped -- cannot see them. If any is ever uncommented
/// it becomes a live record seeder, the count assertion goes red, and the require
/// has to be added. That is the behaviour we want, and it is why excusal is
/// decided by the code scan rather than by membership of this list.
const NOT_SINGLE_NULLIFIER_STARK_SPENDS: [(&str, &str); 2] = [
    ("transfer_stark.rs", "C5: takes nullifier_1/nullifier_2, and is unroutable since 2026-08-18"),
    ("unshield_stark.rs", "C5: takes nullifier_1/nullifier_2, and is unroutable since 2026-08-18"),
];

#[test]
fn every_stark_spend_canonicalises_the_nullifier_it_seeds_a_record_on() {
    const ENCODING: &str = "require!(nullifier[8..] == [0u8; 24], ZkShieldedError::InvalidProof);";
    const VALUE: &str = "u64::from_le_bytes(nullifier[..8].try_into().unwrap()) \
                         < crate::state::poseidon_gl::MODULUS,";

    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/instructions");
    let mut checked: Vec<String> = Vec::new();
    let mut excused: Vec<String> = Vec::new();

    for entry in std::fs::read_dir(&dir).expect("src/instructions must be readable") {
        let path = entry.expect("directory entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let src = std::fs::read_to_string(&path).expect("read instruction file");
        // Production code only, comments stripped: a sentence about a check must
        // never be what satisfies an assertion about the check.
        let cut = match src.find("#[cfg(test)]") {
            Some(i) => &src[..i],
            None => &src[..],
        };
        let code = strip_comments(cut);
        if !code.contains("NullifierRecord::SEED_PREFIX") {
            continue;
        }
        if NOT_SINGLE_NULLIFIER_STARK_SPENDS.iter().any(|(f, _)| *f == name) {
            excused.push(name);
            continue;
        }

        assert!(
            code.contains(ENCODING),
            "{name} seeds a NullifierRecord on a `nullifier` argument and does not \
             canonicalise its ENCODING. Two byte strings, two record addresses, one note.",
        );
        assert!(
            code.contains(VALUE),
            "{name} seeds a NullifierRecord on a `nullifier` argument and does not bound \
             its VALUE against the Goldilocks modulus. `n` and `n + p` are ONE field \
             element and TWO record addresses, so one deposit pays out twice off two \
             fully honest proofs. The require to add, immediately after the encoding \
             check, is written out at the same place in unshield_denominated_stark_v4.rs.",
        );
        checked.push(name);
    }

    checked.sort();
    excused.sort();
    assert_eq!(
        checked.len(),
        6,
        "expected the six LIVE single-nullifier STARK spends, found {}: {checked:?}. A new \
         spend is covered automatically and moves this number -- add the require, then move \
         it. One VANISHING means the scan stopped looking at a path that still routes.",
        checked.len(),
    );
    assert_eq!(
        excused.len(),
        NOT_SINGLE_NULLIFIER_STARK_SPENDS.len(),
        "an excused file was renamed or deleted, so it is no longer being excused for the \
         reason recorded above -- it is simply not being scanned: {excused:?}",
    );
}
