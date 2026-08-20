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
fn the_instruction_still_declares_the_seven_accounts_clients_send() {
    // The shipped mobile and extension builders emit exactly this many accounts,
    // and both apps pin the number by parsing THIS struct. If the struct shrinks
    // back to three, those guards follow it and stop meaning anything — so the
    // count is pinned here too, from outside.
    //
    // WAS SIX until 2026-08-20, deliberately raised to SEVEN by the vault-rent
    // redirect (C1), which appended `rent_beneficiary`. This number is not a
    // formality: Anchor 0.32 rejects a short account list with
    // AccountNotEnoughKeys (3005) inside the resolver, before the handler runs,
    // naming neither the vault nor the money — and `programs/zk_shielded/
    // Cargo.toml` enables only `init-if-needed`, NOT `allow-missing-optionals`,
    // so an optional account still has to occupy its slot (the program's own id
    // is the absent sentinel). Every claim client is therefore broken until it
    // ships the seventh meta.
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
        7,
        "{}",
        explain(
            &format!("the account count changed from 7 to {n}"),
            "Seven is what apps/mobile, apps/extension and packages/merchant-sdk must all\n\
             send: retailer, vault, system_program, token_program?, vault_token_account?,\n\
             retailer_token_account?, rent_beneficiary?.\n\
             Anchor 0.32 rejects a short list with AccountNotEnoughKeys (3005) inside the\n\
             resolver, before the handler runs, naming neither the vault nor the money.\n\
             If you dropped back to six you have reverted the vault-rent redirect and every\n\
             closing claim pays the merchant 3,403,440 lamports of the FUNDER's rent again.\n\
             If you ADDED an account on purpose, update these three builders in the same\n\
             commit — packages/merchant-sdk/src/claim.ts, apps/mobile and apps/extension —\n\
             then change this number.",
        )
    );
    assert!(
        body[..end].contains("pub rent_beneficiary:"),
        "{}",
        explain(
            "the rent_beneficiary account is gone",
            "Without it the closing claim has nowhere to send the vault's rent but the\n\
             merchant, which is the transfer C1 exists to stop: 3,403,440 lamports per\n\
             subscription, paid by the funder, landing on the retailer as a side effect of\n\
             account cleanup.",
        )
    );
}

#[test]
fn the_rent_destination_is_never_the_callers_to_choose() {
    // `claim_period` has no Signer at all. A writable lamport destination that
    // the caller names, without a derivation to pin it against, is 3,403,440
    // lamports per vault handed to whoever sends the transaction first. This is
    // pinned from outside `claim_period.rs` for the same reason everything else
    // in this file is: a merge that reverts that file takes its in-file guards
    // with it.
    let c = code();
    assert!(
        c.contains("derive_fee_escrow(&pool)"),
        "{}",
        explain(
            "the rent destination is no longer derived",
            "The beneficiary must be the source pool's fee_escrow PDA, computed by the\n\
             program from vault.source_pool. Reading it off ctx.accounts instead makes the\n\
             instruction a free-for-all.",
        )
    );
    assert!(
        c.contains("beneficiary.key() == expected_escrow"),
        "{}",
        explain(
            "the derived escrow is no longer compared to the supplied account",
            "Deriving an address and then not checking the caller supplied THAT address is\n\
             exactly as safe as not deriving one.",
        )
    );
}
