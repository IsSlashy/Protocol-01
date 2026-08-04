//! Lot 3 — the subscription revenue leg, actually executed.
//!
//! `claim_period` is the only instruction that moves money toward a merchant,
//! and until this file existed **no automated test in this repository executed
//! it**. This crate had no `[dev-dependencies]` and no `tests/` directory; CI ran
//! `cargo check --all-targets`, which COMPILES the state-machine tests in
//! `src/state/subscription_vault.rs` and never runs them. Changing what
//! `claimable_periods` returns stayed green.
//!
//! # Why litesvm and not devnet
//!
//! The question this file exists to answer is whether the escrow drains **one
//! interval at a time**. That cannot be measured on chain: all 16 live devnet
//! vaults are time-saturated (`claimable == funded` on every one), so every
//! possible claim there sweeps the whole remaining balance in one transaction.
//! Warping slots is the only way to watch a period accrue, and litesvm executes
//! the real `target/deploy/zk_shielded.so` with the validator's own compute
//! accounting.
//!
//! # What this file does NOT prove
//!
//! * The vault is seeded with `set_account`, so `subscribe_private_stark` and
//!   its STARK proof buffers are out of scope. Nothing here says the C1/C3
//!   binding holds.
//! * Transaction packing and the 1232-byte limit are out of scope.
//! * No harness can say who holds a retailer key.
//!
//! # Building the artifact under test
//!
//! ```text
//! ~/.local/share/solana/install/releases/3.1.9/solana-release/bin/cargo-build-sbf.exe \
//!     --manifest-path programs/zk_shielded/Cargo.toml
//! ```
//! The `cargo-build-sbf` first on PATH is agave 2.2.14 here and dies with
//! "os error 183"; use the absolute 3.1.9 path above.

use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

use std::path::PathBuf;

use zk_shielded::state::SubscriptionVault;

// ---------------------------------------------------------------------------
// Constants taken from the program, not retyped by hand where it matters
// ---------------------------------------------------------------------------

/// `programs/zk_shielded/src/lib.rs` — the deployed devnet id.
const PROGRAM_ID: &str = "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c";

/// `sha256("global:claim_period")[..8]`, cross-checked against
/// `packages/merchant-sdk/src/claim.ts` and against a settled devnet
/// transaction (`649EaoTP…`, 2026-08-04).
const CLAIM_PERIOD_DISC: [u8; 8] = [72, 126, 164, 101, 190, 210, 66, 82];

/// Anchor error codes, read off `target/idl/zk_shielded.json` rather than
/// counted by hand: removing an earlier variant renumbers everything after it.
const E_UNAUTHORIZED: u32 = 6004;
const E_NO_CLAIMABLE_PERIODS: u32 = 6029;

/// Rent-exempt minimum for a zero-data system account. MEASURED on devnet
/// 2026-08-01: a payout leaving the retailer non-zero but under this is refused
/// by the runtime AFTER the program has already succeeded.
const SYSTEM_RENT_EXEMPT: u64 = 890_880;

fn program_id() -> Address {
    Address::try_from(PROGRAM_ID).expect("program id must parse")
}

fn so_path() -> PathBuf {
    if let Ok(p) = std::env::var("P01_ZK_SHIELDED_SO") {
        return PathBuf::from(p);
    }
    // tests/ -> programs/zk_shielded -> programs -> repo root
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/deploy/zk_shielded.so")
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

struct Rig {
    svm: LiteSVM,
    program: Address,
}

impl Rig {
    fn new() -> Self {
        // `with_transaction_history(0)` disables the duplicate-signature check:
        // this harness sends byte-identical `claim_period` instructions (the
        // instruction has NO arguments) repeatedly, which the default history
        // would reject as AlreadyProcessed before the program ever ran.
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let program = program_id();
        let so = so_path();
        let bytes = std::fs::read(&so).unwrap_or_else(|e| {
            panic!(
                "\n\
                 ============================================================\n\
                 CANNOT EXECUTE — target/deploy/zk_shielded.so is not readable.\n\
                 ============================================================\n\
                 path  : {}\n\
                 error : {}\n\n\
                 This test executes real SBF bytecode. Without the binary there\n\
                 is nothing to execute, so it FAILS rather than passing with an\n\
                 empty result. There is deliberately no skip.\n\n\
                 Build it (the cargo-build-sbf on PATH is too old):\n  \
                 ~/.local/share/solana/install/releases/3.1.9/solana-release/bin/cargo-build-sbf.exe \\\n    \
                 --manifest-path programs/zk_shielded/Cargo.toml\n\n\
                 A STALE .so is the likelier failure: one dated before the last\n\
                 source change will disagree with this file for reasons that look\n\
                 like logic bugs. Check its mtime against git log.\n\
                 ============================================================\n",
                so.display(),
                e
            )
        });
        svm.add_program(program, &bytes).expect("add_program");
        Rig { svm, program }
    }

    fn rent_exempt(&self, len: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    fn lamports(&self, a: &Address) -> u64 {
        self.svm.get_account(a).map(|x| x.lamports).unwrap_or(0)
    }

    fn vault_account(&self, a: &Address) -> Option<Account> {
        self.svm.get_account(a)
    }

    /// Decode a live vault the way any client would: skip the discriminator and
    /// let Anchor's own deserializer read it back.
    fn read_vault(&self, a: &Address) -> SubscriptionVault {
        let acc = self.vault_account(a).expect("vault must exist");
        let mut slice: &[u8] = &acc.data[8..];
        <SubscriptionVault as AnchorDeserialize>::deserialize(&mut slice).expect("vault must decode")
    }
}

/// Seed a funded vault straight into the SVM. Built from the REAL
/// `SubscriptionVault` type so a field added to the struct cannot silently
/// desynchronise the fixture — the alternative, retyping the byte layout here,
/// is exactly how `claim.spl.test.ts` once pinned a constant to itself.
struct VaultSpec {
    retailer: Address,
    rate: u64,
    interval_slots: u64,
    start_slot: i64,
    total_deposited: u64,
    claimed_periods: u64,
    is_paused: bool,
}

impl Default for VaultSpec {
    fn default() -> Self {
        VaultSpec {
            retailer: Address::new_unique(),
            rate: 50_000_000,
            interval_slots: 100,
            start_slot: 1_000,
            total_deposited: 200_000_000, // 4 funded periods
            claimed_periods: 0,
            is_paused: false,
        }
    }
}

fn seed_vault(rig: &mut Rig, spec: &VaultSpec) -> Address {
    let commitment = [7u8; 32];
    let native_mint = Address::from([0u8; 32]); // system program == native SOL
    let (pda, bump) = Address::find_program_address(
        &[
            SubscriptionVault::SEED_PREFIX,
            spec.retailer.as_ref(),
            commitment.as_ref(),
            native_mint.as_ref(),
        ],
        &rig.program,
    );

    let vault = SubscriptionVault {
        subscriber_pubkey: None,
        subscriber_commitment: Some(commitment),
        retailer: anchor_lang::prelude::Pubkey::from(spec.retailer.to_bytes()),
        token_mint: anchor_lang::prelude::Pubkey::from(native_mint.to_bytes()),
        total_deposited: spec.total_deposited,
        rate: spec.rate,
        interval_slots: spec.interval_slots,
        start_slot: spec.start_slot,
        claimed_periods: spec.claimed_periods,
        is_active: true,
        is_paused: spec.is_paused,
        pause_slot: None,
        total_paused_slots: 0,
        vk_hash_subscriber: [0u8; 32],
        source_pool: None,
        bump,
        client_stealth_meta: None,
        license_commitment: None,
    };

    let mut data = SubscriptionVault::DISCRIMINATOR.to_vec();
    vault.serialize(&mut data).expect("serialize vault");
    // Trailing Options serialize as a single zero tag, so the written length is
    // shorter than LEN; zero-padding to LEN is exactly how the live devnet
    // accounts decode their appended fields as None.
    data.resize(SubscriptionVault::LEN, 0);

    // The escrow sits ON TOP of the account's own rent. Getting this wrong makes
    // `claim_period.rs:88-91` return 6030 InsufficientVaultBalance, which reads
    // like a logic bug rather than a fixture bug.
    let lamports = rig.rent_exempt(data.len()) + spec.total_deposited;
    rig.svm
        .set_account(
            pda,
            Account { lamports, data, owner: rig.program, executable: false, rent_epoch: 0 },
        )
        .expect("set_account");
    pda
}

fn claim_ix(program: &Address, vault: &Address, retailer: &Address) -> Instruction {
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*retailer, true),
            AccountMeta::new(*vault, false),
            AccountMeta::new_readonly(Address::from([0u8; 32]), false), // system_program
            // The three Option<..> accounts. Anchor 0.32 rejects a short list
            // with AccountNotEnoughKeys (3005) before the handler runs; an absent
            // optional is the program's own id.
            AccountMeta::new_readonly(*program, false),
            AccountMeta::new_readonly(*program, false),
            AccountMeta::new_readonly(*program, false),
        ],
        data: CLAIM_PERIOD_DISC.to_vec(),
    }
}

/// Send a claim. `retailer` always signs — the program accepts no other signer —
/// but the FEE PAYER is separable, because the two failure modes this file cares
/// about are told apart by exactly that: a merchant with an empty payout wallet
/// still needs someone to pay for the transaction.
///
/// Returns Ok(cu) or the raw debug string of the failure. Deliberately not
/// pre-parsed: the rent failure is a RUNTIME error with no Anchor code at all,
/// and flattening the two kinds together is what makes "the program succeeded
/// and the transaction still died" impossible to see.
fn claim_raw(
    rig: &mut Rig,
    vault: &Address,
    retailer: &Keypair,
    payer: Option<&Keypair>,
) -> Result<u64, String> {
    let fee_payer = payer.unwrap_or(retailer);
    let ix = claim_ix(&rig.program, vault, &retailer.pubkey());
    let msg = Message::new(&[ix], Some(&fee_payer.pubkey()));
    let blockhash = rig.svm.latest_blockhash();
    let tx = match payer {
        Some(p) => Transaction::new(&[p, retailer], msg, blockhash),
        None => Transaction::new(&[retailer], msg, blockhash),
    };
    match rig.svm.send_transaction(tx) {
        Ok(meta) => Ok(meta.compute_units_consumed),
        Err(e) => Err(format!("{:?}", e)),
    }
}

/// The Anchor-error form: the retailer both signs and pays, as every claim this
/// SDK builds does. Panics if the failure carried no Anchor code, because every
/// caller of this form is asserting about program logic.
fn claim(rig: &mut Rig, vault: &Address, signer: &Keypair) -> Result<u64, u32> {
    claim_raw(rig, vault, signer, None).map_err(|s| {
        s.split("Custom(")
            .nth(1)
            .and_then(|t| t.split(')').next())
            .and_then(|n| n.trim().parse::<u32>().ok())
            .unwrap_or_else(|| panic!("expected an anchor error, got a runtime one: {}", s))
    })
}

// ---------------------------------------------------------------------------
// Tier A — the revenue leg
// ---------------------------------------------------------------------------

#[test]
fn nothing_is_claimable_before_the_first_interval_elapses() {
    let mut rig = Rig::new();
    let spec = VaultSpec::default();
    let vault = seed_vault(&mut rig, &spec);
    let retailer = Keypair::new();

    // Seed a vault whose retailer is a key we hold, then stand one slot short of
    // the first interval boundary.
    let spec = VaultSpec { retailer: retailer.pubkey(), ..spec };
    let vault2 = seed_vault(&mut rig, &spec);
    let _ = vault;
    rig.svm.airdrop(&retailer.pubkey(), 1_000_000_000).unwrap();
    rig.svm
        .warp_to_slot((spec.start_slot + spec.interval_slots as i64 - 1) as u64);

    assert_eq!(
        claim(&mut rig, &vault2, &retailer),
        Err(E_NO_CLAIMABLE_PERIODS),
        "one slot before the boundary the merchant is owed nothing",
    );
}

#[test]
fn the_escrow_drains_one_interval_at_a_time() {
    // THE POINT OF THIS FILE. Not "the merchant can be paid" — that was proven
    // on devnet — but that the payout is metered by elapsed time, one period per
    // interval, and never runs ahead of the clock. No live vault can show this:
    // they are all time-saturated.
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let spec = VaultSpec { retailer: retailer.pubkey(), ..VaultSpec::default() };
    let vault = seed_vault(&mut rig, &spec);
    rig.svm.airdrop(&retailer.pubkey(), 1_000_000_000).unwrap();

    let vault_rent = rig.rent_exempt(SubscriptionVault::LEN);

    // Periods 1..3: one interval, one rate, vault stays open.
    for period in 1..=3u64 {
        rig.svm
            .warp_to_slot((spec.start_slot + (spec.interval_slots * period) as i64) as u64);

        let before_retailer = rig.lamports(&retailer.pubkey());
        let before_vault = rig.lamports(&vault);
        let cu = claim(&mut rig, &vault, &retailer)
            .unwrap_or_else(|c| panic!("period {} should be claimable, got error {}", period, c));

        assert_eq!(
            rig.read_vault(&vault).claimed_periods,
            period,
            "period {}: exactly ONE period should have been claimed, not a sweep",
            period
        );
        assert_eq!(
            before_vault - rig.lamports(&vault),
            spec.rate,
            "period {}: the vault should have released exactly one rate",
            period
        );
        // The retailer signs and therefore pays the fee out of the same balance.
        let gained = rig.lamports(&retailer.pubkey()) + 5_000 - before_retailer;
        assert_eq!(gained, spec.rate, "period {}: merchant credited exactly one rate", period);
        assert!(cu > 0, "period {}: the program must actually have run", period);
    }

    // The FOURTH and final period behaves differently, and this is the single
    // biggest money-path change the no-cancel lot made. Before it, the vault sat
    // at its own rent forever with `is_active == true` and no instruction could
    // close it — 3,403,440 lamports stranded per subscription. Now the closing
    // claim settles the vault and pays that rent to the RETAILER, so the merchant's
    // last payment is one rate PLUS the rent.
    rig.svm
        .warp_to_slot((spec.start_slot + (spec.interval_slots * 4) as i64) as u64);
    let before_retailer = rig.lamports(&retailer.pubkey());
    claim(&mut rig, &vault, &retailer).expect("the final period is claimable");

    let final_gain = rig.lamports(&retailer.pubkey()) + 5_000 - before_retailer;
    assert_eq!(
        final_gain,
        spec.rate + vault_rent,
        "the closing claim pays the last rate AND releases the vault's rent to the merchant",
    );
    assert!(
        rig.vault_account(&vault).is_none(),
        "close-on-exhaustion: the account is gone, so nothing is stranded",
    );

    // Over the whole life the merchant received the deposit and the rent, and the
    // subscriber received nothing back. That is the one-way prepaid envelope,
    // stated as an arithmetic identity.
    assert_eq!(
        rig.lamports(&retailer.pubkey()) + 4 * 5_000 - 1_000_000_000,
        spec.total_deposited + vault_rent,
    );
}

#[test]
fn time_beyond_the_funding_pays_the_funding_and_not_a_lamport_more() {
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let spec = VaultSpec { retailer: retailer.pubkey(), ..VaultSpec::default() };
    let vault = seed_vault(&mut rig, &spec);
    rig.svm.airdrop(&retailer.pubkey(), 1_000_000_000).unwrap();

    // Forty periods of wall clock against four funded ones.
    rig.svm
        .warp_to_slot((spec.start_slot + (spec.interval_slots * 40) as i64) as u64);

    let vault_rent = rig.rent_exempt(SubscriptionVault::LEN);
    let before = rig.lamports(&retailer.pubkey());
    claim(&mut rig, &vault, &retailer).expect("the funded periods are claimable");
    let paid = rig.lamports(&retailer.pubkey()) + 5_000 - before;

    // The ESCROW is clamped to the deposit no matter how much wall clock elapsed —
    // that is the invariant. What the merchant actually receives is that plus the
    // vault's rent, because this single claim is also the closing one.
    assert_eq!(
        paid,
        spec.total_deposited + vault_rent,
        "40 elapsed periods against 4 funded ones still pays 4 rates, plus the released rent",
    );
    assert_eq!(
        paid - vault_rent,
        spec.total_deposited,
        "the escrow half is exactly the deposit: elapsed time never creates money",
    );
    assert!(
        rig.vault_account(&vault).is_none(),
        "a fully drawn-down vault is closed, not left behind",
    );
    // Claiming again is no longer NoClaimablePeriods (6029): there is no account
    // left to deserialize, so Anchor's own account validation refuses it with
    // 3012 AccountNotInitialized before the handler runs. Worth pinning, because a
    // merchant re-running a claim against a settled vault sees THIS error, and it
    // reads like a setup mistake rather than "you have already been paid in full".
    let err = claim_raw(&mut rig, &vault, &retailer, None)
        .expect_err("nothing left to claim from an account that no longer exists");
    assert!(
        err.contains("Custom(3012)"),
        "expected 3012 AccountNotInitialized on a closed vault, got: {}",
        err
    );
}

#[test]
fn an_exhausted_vault_is_closed_and_its_rent_goes_to_the_merchant() {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the inversion is the record of
    // what the no-cancel lot changed.
    //
    // Before it: after a full drawdown the account was still there, `is_active`
    // still `true` (written at subscribe, written `false` nowhere), and its
    // 3,403,440 lamports of rent were stranded — no instruction in the binary
    // could close it, and the two deleted cancels would have returned that rent
    // to the SUBSCRIBER, never to the merchant. MEASURED on devnet 2026-08-04
    // against the old program: `CzVbxcSs…` is still sitting there, drained to
    // exactly its rent floor, `is_active: true`, unclosable.
    //
    // After it: the closing claim settles and closes the vault, and the rent is
    // paid to the retailer. Nothing is left for the subscriber, which is the
    // one-way prepaid envelope working as ruled.
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let spec = VaultSpec { retailer: retailer.pubkey(), ..VaultSpec::default() };
    let vault = seed_vault(&mut rig, &spec);
    rig.svm.airdrop(&retailer.pubkey(), 1_000_000_000).unwrap();
    let vault_rent = rig.rent_exempt(SubscriptionVault::LEN);
    rig.svm
        .warp_to_slot((spec.start_slot + (spec.interval_slots * 40) as i64) as u64);

    let before = rig.lamports(&retailer.pubkey());
    claim(&mut rig, &vault, &retailer).expect("drain it");

    assert!(rig.vault_account(&vault).is_none(), "the vault is CLOSED, not merely emptied");
    assert_eq!(
        rig.lamports(&retailer.pubkey()) + 5_000 - before,
        spec.total_deposited + vault_rent,
        "the merchant received the whole deposit AND the released rent",
    );
}

#[test]
fn only_the_named_retailer_can_claim() {
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let impostor = Keypair::new();
    let spec = VaultSpec { retailer: retailer.pubkey(), ..VaultSpec::default() };
    let vault = seed_vault(&mut rig, &spec);
    rig.svm.airdrop(&retailer.pubkey(), 1_000_000_000).unwrap();
    rig.svm.airdrop(&impostor.pubkey(), 1_000_000_000).unwrap();
    rig.svm
        .warp_to_slot((spec.start_slot + spec.interval_slots as i64) as u64);

    assert_eq!(
        claim(&mut rig, &vault, &impostor),
        Err(E_UNAUTHORIZED),
        "a signer who is not vault.retailer is refused",
    );
    assert!(claim(&mut rig, &vault, &retailer).is_ok(), "and the real retailer still can");
}

#[test]
fn a_paused_vault_cannot_be_claimed_and_cannot_be_exited() {
    // `claim_period.rs:33` carries `constraint = !vault.is_paused` with no
    // exception for exhaustion, and nothing in this binary closes a vault. Two
    // live devnet vaults are in exactly this state. The unmerged `459da665`
    // relaxes it to `!is_paused || is_exhausted()`; when that lands, this test
    // is where the change becomes visible.
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let spec = VaultSpec { retailer: retailer.pubkey(), is_paused: true, ..VaultSpec::default() };
    let vault = seed_vault(&mut rig, &spec);
    rig.svm.airdrop(&retailer.pubkey(), 1_000_000_000).unwrap();
    rig.svm
        .warp_to_slot((spec.start_slot + (spec.interval_slots * 10) as i64) as u64);

    let code = claim(&mut rig, &vault, &retailer).expect_err("a paused vault pays nothing");
    assert!(
        code == 6026 || code == E_NO_CLAIMABLE_PERIODS,
        "expected the paused constraint (6026) or NoClaimablePeriods, got {}",
        code
    );
    assert!(rig.vault_account(&vault).is_some(), "and the money is still locked in it");
}

// ---------------------------------------------------------------------------
// Tier A2 — the rent floor that broke the first real claim
// ---------------------------------------------------------------------------

#[test]
fn a_payout_under_the_rent_floor_strands_an_empty_merchant_wallet() {
    // MEASURED on devnet 2026-08-01: the program SUCCEEDED (7,261 CU, event
    // emitted) and the RUNTIME then threw the whole transaction out with
    // "insufficient funds for rent", naming the RETAILER — an error that reads
    // as though the vault were empty. litesvm runs the same post-execution rent
    // check, so the failure is reproducible in-process.
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let spec = VaultSpec {
        retailer: retailer.pubkey(),
        rate: 300_000, // one period is well under the 890,880 floor
        total_deposited: 1_200_000,
        ..VaultSpec::default()
    };
    let vault = seed_vault(&mut rig, &spec);
    assert!(spec.rate < SYSTEM_RENT_EXEMPT);

    // The merchant's payout wallet does not exist yet — 0 lamports, exactly the
    // devnet state. Someone else pays the fee, which is why the claim gets far
    // enough to fail on rent instead of on funding.
    //
    // NOTE, and it is the finding of this test: an AIRDROP of 100,000 lamports to
    // a fresh account is itself refused with InsufficientFundsForRent. There is no
    // way to *put* a system account under the floor; the only way to be under it
    // is to be at zero. So "fund the merchant a little" is not a workaround a
    // merchant can take — it is the floor or nothing.
    let payer = Keypair::new();
    rig.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    assert_eq!(rig.lamports(&retailer.pubkey()), 0, "merchant wallet does not exist yet");
    rig.svm
        .warp_to_slot((spec.start_slot + spec.interval_slots as i64) as u64);

    let err = claim_raw(&mut rig, &vault, &retailer, Some(&payer))
        .expect_err("a 300,000-lamport payout cannot create a rent-exempt account");
    assert!(
        err.contains("InsufficientFundsForRent"),
        "expected the RUNTIME rent rejection, got: {}",
        err
    );
    // The half that makes this defect so confusing in the field: the PROGRAM ran
    // and succeeded, and the transaction was unwound afterwards.
    assert_eq!(rig.lamports(&retailer.pubkey()), 0, "nothing moved");
    assert_eq!(rig.read_vault(&vault).claimed_periods, 0, "the period was NOT consumed");

    // Fund it to exactly the floor once — the documented remedy — and the
    // identical claim settles.
    rig.svm.airdrop(&retailer.pubkey(), SYSTEM_RENT_EXEMPT).unwrap();
    claim_raw(&mut rig, &vault, &retailer, Some(&payer)).expect("clears the floor now");
    assert_eq!(rig.read_vault(&vault).claimed_periods, 1);
    assert_eq!(rig.lamports(&retailer.pubkey()), SYSTEM_RENT_EXEMPT + spec.rate);
}
