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
//! # Added 2026-08-20 — where the vault's rent goes
//!
//! `claim_period` used to close the vault to the RETAILER, which moved
//! 3,403,440 lamports of rent from whoever funded the subscription to the
//! merchant on every closing claim. It now closes to the source pool's
//! `fee_escrow` PDA. Four tests here asserted the old behaviour by name and by
//! arithmetic and were inverted; three new ones cover the parts that are only
//! observable by execution — that a WRONG beneficiary is refused, that a legacy
//! vault with no `source_pool` still closes to the retailer, and that a closing
//! claim to an EMPTY merchant wallet still lands because the retailer is topped
//! up to its rent floor out of the rent first.
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

/// `programs/zk_shielded/src/fee.rs` — the per-pool fee escrow seed. Since
/// 2026-08-20 this PDA is also where a closing `claim_period` sends the vault's
/// rent, so the harness has to be able to build it.
const FEE_ESCROW_SEED_PREFIX: &[u8] = b"fee_escrow";

fn program_id() -> Address {
    Address::try_from(PROGRAM_ID).expect("program id must parse")
}

/// Mirror of `zk_shielded::fee::derive_fee_escrow`. Deliberately re-derived here
/// rather than imported: if the program's seed ever changes, a harness that
/// imported the helper would follow it silently and keep passing, while this one
/// goes red with Unauthorized — which is the answer a client would get.
fn fee_escrow(program: &Address, pool: &Address) -> Address {
    Address::find_program_address(&[FEE_ESCROW_SEED_PREFIX, pool.as_ref()], program).0
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
    /// The pool the note came from. `subscribe_private_stark` ALWAYS writes
    /// `Some(pool)`, so `Some` is the default here too — it is the only shape a
    /// vault on chain can have. It decides where the closing claim sends the
    /// rent, so a fixture that left it `None` (as this one did until
    /// 2026-08-20) would silently test the legacy fallback and never the path
    /// every real vault takes.
    source_pool: Option<Address>,
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
            source_pool: Some(Address::new_unique()),
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
        source_pool: spec
            .source_pool
            .map(|p| anchor_lang::prelude::Pubkey::from(p.to_bytes())),
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

    // Seed the pool's fee escrow at its floor. A pool that has ever been
    // shielded into has one (shield_denominated_v3 tops it to rent-exempt on
    // first use), so this is the real state, and it makes "the beneficiary
    // GAINED the rent" a subtraction rather than an account springing into
    // existence mid-assertion.
    if let Some(pool) = spec.source_pool {
        let escrow = fee_escrow(&rig.program, &pool);
        if rig.svm.get_account(&escrow).map(|a| a.lamports).unwrap_or(0) == 0 {
            rig.svm
                .set_account(
                    escrow,
                    Account {
                        lamports: SYSTEM_RENT_EXEMPT,
                        data: vec![],
                        owner: Address::from([0u8; 32]), // system program
                        executable: false,
                        rent_epoch: 0,
                    },
                )
                .expect("set_account fee_escrow");
        }
    }
    pda
}

/// The escrow a closing claim must be pointed at for this vault, read back out
/// of the account exactly as a client would. `None` once the vault is closed.
fn beneficiary_of(rig: &Rig, vault: &Address) -> Option<Address> {
    let acc = rig.vault_account(vault)?;
    let mut slice: &[u8] = &acc.data[8..];
    let v = <SubscriptionVault as AnchorDeserialize>::deserialize(&mut slice).ok()?;
    v.source_pool
        .map(|p| fee_escrow(&rig.program, &Address::from(p.to_bytes())))
}

fn claim_ix(
    program: &Address,
    vault: &Address,
    retailer: &Address,
    rent_beneficiary: Option<Address>,
) -> Instruction {
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*retailer, true),
            AccountMeta::new(*vault, false),
            AccountMeta::new_readonly(Address::from([0u8; 32]), false), // system_program
            // The four Option<..> accounts. Anchor 0.32 rejects a short list
            // with AccountNotEnoughKeys (3005) before the handler runs; an absent
            // optional is the program's own id.
            //
            // WAS THREE, and the list WAS six long, until 2026-08-20. The vault
            // rent redirect appended `rent_beneficiary`, so every claim client
            // — packages/merchant-sdk/src/claim.ts, apps/mobile,
            // apps/extension — has to grow a seventh meta before the redeployed
            // program will accept a single claim from it.
            AccountMeta::new_readonly(*program, false),
            AccountMeta::new_readonly(*program, false),
            AccountMeta::new_readonly(*program, false),
            // The sentinel must stay READONLY: the program account is
            // executable, and the runtime refuses a transaction that marks an
            // executable account writable. The real beneficiary is writable
            // because the close credits it.
            match rent_beneficiary {
                Some(b) => AccountMeta::new(b, false),
                None => AccountMeta::new_readonly(*program, false),
            },
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
    // What a correct client does: read the vault, derive the escrow from its
    // own `source_pool`. The program derives the same address and refuses
    // anything else, so this is not a convenience — it is the only value that
    // works.
    let beneficiary = beneficiary_of(rig, vault);
    claim_raw_to(rig, vault, retailer, payer, beneficiary)
}

/// `claim_raw` with the rent destination supplied by hand. The only reason this
/// exists is to prove the pin holds against a WRONG one.
fn claim_raw_to(
    rig: &mut Rig,
    vault: &Address,
    retailer: &Keypair,
    payer: Option<&Keypair>,
    rent_beneficiary: Option<Address>,
) -> Result<u64, String> {
    let fee_payer = payer.unwrap_or(retailer);
    let ix = claim_ix(&rig.program, vault, &retailer.pubkey(), rent_beneficiary);
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

    // The FOURTH and final period behaves differently. Two changes are stacked
    // here and it is worth keeping them apart:
    //
    //   1. The no-cancel lot made the closing claim CLOSE the vault. Before it,
    //      a drained vault sat at its own rent forever with `is_active == true`
    //      and no instruction could close it — 3,403,440 lamports stranded per
    //      subscription.
    //   2. C1 (2026-08-20) changed WHERE that released rent goes. It went to the
    //      retailer, and this test asserted `spec.rate + vault_rent`. The rent
    //      was never the merchant's: it was charged to `subscribe_private_stark`'s
    //      ephemeral payer, funded by whoever bought the note. The merchant's
    //      last payment is now exactly one rate, and the rent lands in the source
    //      pool's fee escrow.
    let escrow = fee_escrow(&rig.program, &spec.source_pool.unwrap());
    let before_escrow = rig.lamports(&escrow);
    rig.svm
        .warp_to_slot((spec.start_slot + (spec.interval_slots * 4) as i64) as u64);
    let before_retailer = rig.lamports(&retailer.pubkey());
    claim(&mut rig, &vault, &retailer).expect("the final period is claimable");

    let final_gain = rig.lamports(&retailer.pubkey()) + 5_000 - before_retailer;
    assert_eq!(
        final_gain, spec.rate,
        "the closing claim pays the last rate and NOT the vault's rent",
    );
    // And the rent LANDED, rather than merely leaving the merchant. Asserting
    // only the merchant side would pass just as happily if the lamports had been
    // burned.
    assert_eq!(
        rig.lamports(&escrow) - before_escrow,
        vault_rent,
        "the released rent reached the source pool's fee escrow in full",
    );
    assert!(
        rig.vault_account(&vault).is_none(),
        "close-on-exhaustion: the account is gone, so nothing is stranded",
    );

    // Over the whole life the merchant received the deposit and NOT A LAMPORT
    // more, and the subscriber received nothing back. That is the one-way
    // prepaid envelope, stated as an arithmetic identity — and it is now a
    // cleaner one, because the rent is no longer smuggled into the merchant's
    // side of it.
    assert_eq!(
        rig.lamports(&retailer.pubkey()) + 4 * 5_000 - 1_000_000_000,
        spec.total_deposited,
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
    let escrow = fee_escrow(&rig.program, &spec.source_pool.unwrap());
    let before_escrow = rig.lamports(&escrow);
    let before = rig.lamports(&retailer.pubkey());
    claim(&mut rig, &vault, &retailer).expect("the funded periods are claimable");
    let paid = rig.lamports(&retailer.pubkey()) + 5_000 - before;

    // The ESCROW is clamped to the deposit no matter how much wall clock elapsed —
    // that is the invariant. This used to assert `total_deposited + vault_rent`
    // and then subtract the rent back out to state the invariant; since C1
    // (2026-08-20) the rent does not reach the merchant at all, so the two
    // assertions collapse into one and the rent is checked on the other side.
    assert_eq!(
        paid, spec.total_deposited,
        "40 elapsed periods against 4 funded ones still pays exactly 4 rates: \
         elapsed time never creates money, and the rent is not the merchant's",
    );
    assert_eq!(
        rig.lamports(&escrow) - before_escrow,
        vault_rent,
        "and the released rent is accounted for — it went to the pool's fee escrow",
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
fn an_exhausted_vault_is_closed_and_its_rent_goes_back_to_the_funder() {
    // THIS TEST HAS NOW BEEN INVERTED TWICE, and both inversions are the record
    // of what changed. Keeping the history in the comment is this file's
    // convention precisely because a test name alone cannot carry it.
    //
    // (1) Originally: after a full drawdown the account was still there,
    // `is_active` still `true` (written at subscribe, written `false` nowhere),
    // and its 3,403,440 lamports of rent were stranded — no instruction in the
    // binary could close it, and the two deleted cancels would have returned
    // that rent to the SUBSCRIBER. MEASURED on devnet 2026-08-04 against the old
    // program: `CzVbxcSs…` is still sitting there, drained to exactly its rent
    // floor, `is_active: true`, unclosable.
    //
    // (2) The no-cancel lot: the closing claim settles and closes the vault, and
    // the rent went to the RETAILER. This test was named
    // `..._its_rent_goes_to_the_merchant` and asserted
    // `total_deposited + vault_rent`.
    //
    // (3) C1, 2026-08-20: the rent goes to the source pool's fee escrow. "Not
    // the subscriber's" was never the same claim as "the merchant's" — the rent
    // was paid by `subscribe_private_stark`'s ephemeral payer, out of whoever
    // funded the note. The merchant receives the deposit, exactly, and nothing
    // returns to the subscriber. The one-way prepaid envelope is unchanged; what
    // changed is that the envelope no longer has 3,403,440 lamports of somebody
    // else's rent stapled to the outside of it.
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let spec = VaultSpec { retailer: retailer.pubkey(), ..VaultSpec::default() };
    let vault = seed_vault(&mut rig, &spec);
    rig.svm.airdrop(&retailer.pubkey(), 1_000_000_000).unwrap();
    let vault_rent = rig.rent_exempt(SubscriptionVault::LEN);
    let escrow = fee_escrow(&rig.program, &spec.source_pool.unwrap());
    let before_escrow = rig.lamports(&escrow);
    rig.svm
        .warp_to_slot((spec.start_slot + (spec.interval_slots * 40) as i64) as u64);

    let before = rig.lamports(&retailer.pubkey());
    claim(&mut rig, &vault, &retailer).expect("drain it");

    assert!(rig.vault_account(&vault).is_none(), "the vault is CLOSED, not merely emptied");
    assert_eq!(
        rig.lamports(&retailer.pubkey()) + 5_000 - before,
        spec.total_deposited,
        "the merchant received the whole deposit and NOT the released rent",
    );
    assert_eq!(
        rig.lamports(&escrow) - before_escrow,
        vault_rent,
        "and the rent landed in the source pool's fee escrow, where the treasury \
         that funded the ephemeral can sweep it",
    );
}

#[test]
fn a_claim_that_names_the_wrong_rent_beneficiary_is_refused() {
    // THE ONLY EXECUTION-LEVEL PROOF THAT THE PIN HOLDS, and the reason it
    // matters: `claim_period` has no Signer of any kind. If the beneficiary were
    // taken on trust, whoever sent the transaction first would take 3,403,440
    // lamports out of every vault that closes.
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let spec = VaultSpec { retailer: retailer.pubkey(), ..VaultSpec::default() };
    let vault = seed_vault(&mut rig, &spec);
    rig.svm.airdrop(&retailer.pubkey(), 1_000_000_000).unwrap();
    rig.svm
        .warp_to_slot((spec.start_slot + (spec.interval_slots * 40) as i64) as u64);

    // A wallet the caller controls, in the beneficiary slot.
    let thief = Keypair::new();
    rig.svm.airdrop(&thief.pubkey(), SYSTEM_RENT_EXEMPT).unwrap();
    let err = claim_raw_to(&mut rig, &vault, &retailer, None, Some(thief.pubkey()))
        .expect_err("an unpinned destination must be refused");
    assert!(
        err.contains(&format!("Custom({})", E_UNAUTHORIZED)),
        "expected Unauthorized ({}) for a beneficiary that is not the derived \
         fee escrow, got: {}",
        E_UNAUTHORIZED,
        err
    );
    assert!(rig.vault_account(&vault).is_some(), "and the vault was NOT closed");

    // The escrow of a DIFFERENT pool is refused too — the derivation is per
    // pool, so "some escrow of ours" is not the same as "this vault's escrow".
    let other_escrow = fee_escrow(&rig.program, &Address::new_unique());
    let err = claim_raw_to(&mut rig, &vault, &retailer, None, Some(other_escrow))
        .expect_err("another pool's escrow must be refused");
    assert!(err.contains(&format!("Custom({})", E_UNAUTHORIZED)), "got: {}", err);

    // Omitting it entirely fails closed rather than falling back to the
    // retailer. A silent fallback would have made this whole change a no-op for
    // every client that had not shipped the seventh account yet, while the
    // guards all stayed green.
    let err = claim_raw_to(&mut rig, &vault, &retailer, None, None)
        .expect_err("an absent beneficiary must not fall back to the merchant");
    assert!(err.contains(&format!("Custom({})", E_UNAUTHORIZED)), "got: {}", err);
    assert!(rig.vault_account(&vault).is_some(), "still not closed");

    // And the correct one settles.
    claim(&mut rig, &vault, &retailer).expect("the derived escrow is accepted");
    assert!(rig.vault_account(&vault).is_none());
}

#[test]
fn a_legacy_vault_with_no_source_pool_still_closes_to_the_retailer() {
    // The compatibility path, pinned so it cannot rot. `source_pool: None` is
    // not reachable through any instruction that still exists —
    // `subscribe_private_stark` always writes `Some(pool)` — but the field is a
    // deprecated `Option` kept for layout reasons and an account written before
    // it existed decodes as `None`. Such a vault has no pool to derive an escrow
    // from, so the only alternative to the old behaviour is refusing to close it
    // at all, which would strand it forever.
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let spec = VaultSpec {
        retailer: retailer.pubkey(),
        source_pool: None,
        ..VaultSpec::default()
    };
    let vault = seed_vault(&mut rig, &spec);
    rig.svm.airdrop(&retailer.pubkey(), 1_000_000_000).unwrap();
    let vault_rent = rig.rent_exempt(SubscriptionVault::LEN);
    rig.svm
        .warp_to_slot((spec.start_slot + (spec.interval_slots * 40) as i64) as u64);

    let before = rig.lamports(&retailer.pubkey());
    claim(&mut rig, &vault, &retailer).expect("a legacy vault must still be closable");
    assert!(rig.vault_account(&vault).is_none());
    assert_eq!(
        rig.lamports(&retailer.pubkey()) + 5_000 - before,
        spec.total_deposited + vault_rent,
        "with no source_pool there is no escrow to route to, so the pre-C1 \
         behaviour is kept rather than stranding the account",
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

#[test]
fn the_closing_claim_tops_an_empty_merchant_to_the_rent_floor_out_of_the_rent() {
    // THE REGRESSION C1 WOULD HAVE SHIPPED WITHOUT A MITIGATION, pinned so the
    // mitigation cannot be quietly removed as "dead code".
    //
    // The test above measures the floor blocking an INTERMEDIATE claim. Until
    // 2026-08-20 it could never block the CLOSING one, for an accidental
    // reason: the close carried the vault's 3,403,440 lamports of rent to the
    // retailer, which is 3.82x the 890,880 floor, so the last claim landed
    // however small the payout was. Route that rent to the fee escrow and a
    // closing payout under the floor to a zero-lamport merchant becomes a
    // transaction that can NEVER execute — the vault can never close, and the
    // rent it was holding is stranded forever. That is strictly worse than the
    // merchant keeping it, which is why the redirect had to bring its own
    // remedy rather than a follow-up ticket.
    //
    // The remedy: pay the retailer up to its own floor out of the rent first,
    // then route the remainder. It is always affordable — 3,403,440 - 890,880 =
    // 2,512,560 still reaches the escrow.
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let spec = VaultSpec {
        retailer: retailer.pubkey(),
        rate: 300_000,
        total_deposited: 300_000, // exactly ONE funded period, so claim #1 closes it
        ..VaultSpec::default()
    };
    let vault = seed_vault(&mut rig, &spec);
    let vault_rent = rig.rent_exempt(SubscriptionVault::LEN);
    let escrow = fee_escrow(&rig.program, &spec.source_pool.unwrap());
    let before_escrow = rig.lamports(&escrow);

    // The merchant's payout wallet does not exist. Someone else pays the fee.
    let payer = Keypair::new();
    rig.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    assert_eq!(rig.lamports(&retailer.pubkey()), 0, "merchant wallet does not exist yet");
    assert!(spec.rate < SYSTEM_RENT_EXEMPT, "the payout alone cannot clear the floor");
    rig.svm
        .warp_to_slot((spec.start_slot + spec.interval_slots as i64) as u64);

    claim_raw(&mut rig, &vault, &retailer, Some(&payer))
        .expect("the CLOSING claim must still land on an empty merchant wallet");

    assert!(rig.vault_account(&vault).is_none(), "the vault closed");
    assert_eq!(
        rig.lamports(&retailer.pubkey()),
        SYSTEM_RENT_EXEMPT,
        "the merchant is left at exactly its rent floor: the {} payout plus a \
         {} top-up out of the rent, and not one lamport of rent more",
        spec.rate,
        SYSTEM_RENT_EXEMPT - spec.rate,
    );
    assert_eq!(
        rig.lamports(&escrow) - before_escrow,
        vault_rent - (SYSTEM_RENT_EXEMPT - spec.rate),
        "the funder gets the rest of the rent — {} of {}",
        vault_rent - (SYSTEM_RENT_EXEMPT - spec.rate),
        vault_rent,
    );
}

#[test]
fn a_merchant_already_above_the_floor_is_topped_up_by_nothing() {
    // The other side of the mitigation, and the case that is true of every
    // merchant that has ever been paid once: no top-up at all, the whole rent
    // routes. Without this the mitigation could silently widen into "the
    // merchant keeps a slice of every rent" and the test above would not notice.
    let mut rig = Rig::new();
    let retailer = Keypair::new();
    let spec = VaultSpec {
        retailer: retailer.pubkey(),
        rate: 300_000,
        total_deposited: 300_000,
        ..VaultSpec::default()
    };
    let vault = seed_vault(&mut rig, &spec);
    let vault_rent = rig.rent_exempt(SubscriptionVault::LEN);
    let escrow = fee_escrow(&rig.program, &spec.source_pool.unwrap());
    let before_escrow = rig.lamports(&escrow);
    rig.svm.airdrop(&retailer.pubkey(), 1_000_000_000).unwrap();
    let before_retailer = rig.lamports(&retailer.pubkey());
    rig.svm
        .warp_to_slot((spec.start_slot + spec.interval_slots as i64) as u64);

    claim(&mut rig, &vault, &retailer).expect("closes");
    assert_eq!(
        rig.lamports(&retailer.pubkey()) + 5_000 - before_retailer,
        spec.rate,
        "a merchant already above its floor receives the payout and nothing else",
    );
    assert_eq!(
        rig.lamports(&escrow) - before_escrow,
        vault_rent,
        "and the whole rent routes to the funder's escrow",
    );
}
