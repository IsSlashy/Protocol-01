//! Fails-closed gate: `prefund` must refuse a proof buffer that only passed
//! **phase 1** of STARK verification.
//!
//! # What this test is defending
//!
//! `p01_stark_verifier` verifies circuits 1–6 in two instructions:
//!
//! ```text
//!   verify_stark_proof_v2   -> sets ProofBuffer.verified          (byte 49)
//!   verify_deep_ali_phase2  -> sets ProofBuffer.deep_ali_verified (byte 82)
//! ```
//!
//! Phase 1 alone is **not** an AIR check. `verify_quotient_at_query` had its
//! body removed on 2026-07-27 and now enforces nothing, and the only place a
//! public input meets the trace in phase 1 is `verify_boundary_constraints`
//! (`verify.rs:1348-1364`), which skips every query that is not trace-aligned
//! *and* not on an assertion row. So a phase-1-only buffer is a forgery
//! primitive: the attacker declares arbitrary public inputs, uploads an
//! honest-format circuit-1 proof under an ephemeral keypair, skips phase 2,
//! and calls `prefund`.
//!
//! `zk_shielded` has always required both bytes (canonical pattern at
//! `programs/zk_shielded/src/instructions/unshield_stark.rs:196`). This
//! program did not — it parsed the buffer with `PROOF_BUF_MIN_LEN = 82`, so
//! byte 82 was not merely unchecked, it was structurally outside the slice.
//!
//! # Why litesvm and not a unit test
//!
//! The thing under test is a `require!` inside an SBF program. A host-side
//! unit test would exercise a different compilation of a different code path.
//! litesvm loads `target/deploy/p01_liquidity.so` — the artifact that would be
//! deployed — and runs it under the same account and compute accounting the
//! validator uses. An accept/reject decision here is the validator's decision.
//!
//! # Running it
//!
//! ```text
//! cargo test -p p01_liquidity --test deep_ali_gate -- --nocapture
//! ```
//!
//! That is the whole command — the harness builds its own SBF artifact from
//! this crate's sources (see "Artifact provenance" below). Point
//! `P01_CARGO_BUILD_SBF` at a `cargo-build-sbf` if the pinned one is not where
//! this file looks for it.
//!
//! # It cannot pass without measuring
//!
//! A build failure panics with the compiler output; it never skips-and-passes.
//! `prefund_accepts_fully_verified_buffer` is the anti-vacuity control: it
//! sends the *same* transaction with byte 82 set to 1 and requires it to
//! succeed and to actually move lamports, so "reject everything" cannot make
//! this file green.

use anchor_lang::AccountSerialize;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::OnceLock;

use p01_liquidity::state::{LiquidityPool, PrefundRecord};

// ---------------------------------------------------------------------------
// Constants mirrored from the programs under test
// ---------------------------------------------------------------------------

/// `programs/p01_stark_verifier/src/lib.rs:37`. Also the hard-coded
/// `STARK_VERIFIER_PROGRAM_ID` in `prefund.rs:13-18`.
const VERIFIER_ID: &str = "DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs";

const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";

/// Anchor discriminator of `p01_stark_verifier::ProofBuffer`.
const PROOF_BUFFER_DISC: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

/// `ProofBuffer` byte layout (`p01_stark_verifier/src/lib.rs:537-572`):
/// 0..8 disc | 8..40 authority | 40 circuit_id | 41..45 proof_size |
/// 45..49 bytes_written | 49 verified | 50..82 public_inputs_hash |
/// 82 deep_ali_verified | 83 = PROOF_DATA_OFFSET.
const PB_LEN: usize = 83;

/// `prefund.rs:28` — `CIRCUIT_POOL_COMMITMENT`.
const CIRCUIT_POOL_COMMITMENT: u8 = 1;

/// zk_shielded program ID — owner of a real `DenominatedPool`.
/// `settle.rs:14-19` / `prefund.rs`'s `ZK_SHIELDED_PROGRAM_ID`.
const ZK_SHIELDED_ID: &str = "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c";

/// `sha256("account:DenominatedPool")[..8]`.
const DENOMINATED_POOL_DISC: [u8; 8] = [16, 21, 198, 35, 177, 92, 68, 140];

const DENOMINATION: u64 = 1_000_000_000; // 1 SOL
const POOL_RESERVE: u64 = 10_000_000_000; // 10 SOL
const POOL_RENT: u64 = 2_000_000;
const PREFUND_FEE_BPS: u16 = 80;
const SETTLER_REWARD_BPS: u16 = 30;

// ---------------------------------------------------------------------------
// `LiquidityError` codes. Anchor numbers `#[error_code]` variants from 6000 in
// declaration order (`src/errors.rs`). Asserted explicitly so two checks cannot
// silently swap: a test that only asserts "rejected" passes when the reject
// comes from an unrelated guard, which is how the previous revision of
// `prefund_rejects_denominated_pool_not_owned_by_zk_shielded` stayed green with
// the owner check deleted.
// ---------------------------------------------------------------------------
const ERR_POOL_INACTIVE: u32 = 6000;
const ERR_PROOF_NOT_VERIFIED: u32 = 6010;
const ERR_AMOUNT_MISMATCH: u32 = 6013;
const ERR_INVALID_DENOMINATED_POOL: u32 = 6020;
const ERR_UNSUPPORTED_DENOMINATED_POOL: u32 = 6021;

/// `LiquidityPool` byte offsets (`src/state/liquidity_pool.rs`):
/// 0..8 disc | 8..40 admin | 40..56 total_shares(u128) | 56..64 reserve_lamports
/// | 64..66 prefund_fee_bps | 66..68 settler_reward_bps | 68 is_active | 69 bump.
const LP_RESERVE_LAMPORTS: usize = 56;
const LP_IS_ACTIVE: usize = 68;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CRATE_NAME: &str = "p01_liquidity";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/programs/p01_liquidity
    crate_dir()
        .parent()
        .and_then(|p| p.parent())
        .expect("manifest dir has two ancestors")
        .to_path_buf()
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[bytes]).to_bytes()
}

fn sha256_hex(bytes: &[u8]) -> String {
    sha256(bytes).iter().map(|b| format!("{:02x}", b)).collect()
}

/// Anchor's instruction discriminator: `sha256("global:<name>")[..8]`.
fn anchor_ix_disc(name: &str) -> [u8; 8] {
    let h = sha256(format!("global:{}", name).as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

fn program_id() -> Address {
    Address::new_from_array(p01_liquidity::ID.to_bytes())
}

/// Build a `ProofBuffer` account image by hand.
///
/// Hand-rolling it is the point: the attack this test models never runs
/// `verify_deep_ali_phase2`, so no honest code path can produce this state and
/// no honest code path can be borrowed to produce it here.
fn proof_buffer_data(
    authority: &Address,
    circuit_id: u8,
    verified: bool,
    deep_ali_verified: bool,
    public_inputs_hash: [u8; 32],
) -> Vec<u8> {
    let mut d = vec![0u8; PB_LEN];
    d[..8].copy_from_slice(&PROOF_BUFFER_DISC);
    d[8..40].copy_from_slice(authority.as_ref());
    d[40] = circuit_id;
    // 41..45 proof_size, 45..49 bytes_written — no consumer reads them.
    d[49] = u8::from(verified);
    d[50..82].copy_from_slice(&public_inputs_hash);
    d[82] = u8::from(deep_ali_verified);
    d
}

/// A `zk_shielded::state::DenominatedPool` account image, only as far as the
/// fields `prefund` reads: `0..8 disc | 8..40 authority | 40..72 token_mint |
/// 72..80 denomination` (`zk_shielded/src/state/pool.rs:172-180`). The tail is
/// left off — `prefund` requires `>= 80` bytes and reads nothing past 80.
///
/// `authority` is what `zk_shielded::init_denominated_pool` copies from its
/// `Signer` (`init_denominated_pool.rs:70`), so it names the wallet that
/// created the pool. Pool creation is permissionless — arbitrary `token_mint`,
/// arbitrary `denomination`, no admin check — so this parameter is the
/// difference between "a pool we support" and "a pool the attacker minted with
/// a denomination of their choosing".
fn denominated_pool_data(disc: [u8; 8], authority: &Address, denomination: u64) -> Vec<u8> {
    let mut d = vec![0u8; 80];
    d[..8].copy_from_slice(&disc);
    d[8..40].copy_from_slice(authority.as_ref());
    d[72..80].copy_from_slice(&denomination.to_le_bytes());
    d
}

/// The `public_inputs_hash` `verify_stark_proof_v2` stores for circuit 1,
/// rebuilt exactly the way `prefund.rs:130-137` rebuilds it.
fn expected_inputs_hash(nullifier: &[u8; 32], stark_commitment: u64) -> [u8; 32] {
    let nullifier_u64 = u64::from_le_bytes(nullifier[..8].try_into().unwrap());
    let mut buf = [0u8; 16];
    buf[..8].copy_from_slice(&nullifier_u64.to_le_bytes());
    buf[8..].copy_from_slice(&stark_commitment.to_le_bytes());
    sha256(&buf)
}

fn tail(v: &[String], n: usize) -> Vec<String> {
    let start = v.len().saturating_sub(n);
    v[start..].to_vec()
}

/// `PrefundRecord` PDA as the program derives it AFTER the replay fix:
/// `[b"prefund", denominated_pool, nullifier[..8]]`. The prefix is exactly what
/// the circuit-1 public-inputs hash commits to.
fn prefund_record_pda(pid: &Address, denominated_pool: &Address, nullifier: &[u8; 32]) -> Address {
    Address::find_program_address(
        &[
            PrefundRecord::SEED_PREFIX,
            denominated_pool.as_ref(),
            &nullifier[..8],
        ],
        pid,
    )
    .0
}

/// `PrefundRecord` PDA as the program derived it BEFORE the fix, over all 32
/// nullifier bytes. Kept so the replay test can offer the program both
/// candidates and count payouts without knowing which rule is compiled in —
/// see `prefund_cannot_be_replayed_by_varying_the_unproven_nullifier_tail`.
fn prefund_record_pda_full_nullifier(
    pid: &Address,
    denominated_pool: &Address,
    nullifier: &[u8; 32],
) -> Address {
    Address::find_program_address(
        &[
            PrefundRecord::SEED_PREFIX,
            denominated_pool.as_ref(),
            nullifier.as_ref(),
        ],
        pid,
    )
    .0
}

// ---------------------------------------------------------------------------
// Artifact provenance — the bytes under test come from THIS source tree
// ---------------------------------------------------------------------------
//
// `cargo test --test deep_ali_gate` builds a HOST binary. It does not build SBF
// bytecode. An earlier revision of this file simply read
// `target/deploy/p01_liquidity.so`, which made every assertion below a
// statement about whatever bytes happened to be sitting in that directory
// rather than about the source tree. Review demonstrated the consequence:
// delete the `require!(deep_ali_verified, ..)` from `prefund.rs`, copy the old
// `.so` back over `target/deploy/` without rebuilding, run the suite — 3
// passed, against source with no gate in it.
//
// An mtime comparison does not close that. In the demonstrated sequence the
// `.so` was written AFTER the source edit, so it is *newer* than the source it
// does not correspond to, and any "is the artifact older than src?" check
// passes.
//
// So the harness builds the artifact itself, with the toolchain Anchor.toml
// pins, and caches on a content fingerprint of the crate's sources. Cache miss
// => rebuild; build failure => panic with the compiler output. There is no
// path by which these tests run against bytecode that was not produced from
// the `src/` tree next to them.
//
// It builds through a private `--sbf-out-dir` and a private `CARGO_TARGET_DIR`
// so it can never contend for the target-directory lock held by the
// `cargo test` that invoked it, and so anchor's `target/deploy/` is neither
// read nor written. The cost is one cold SBF build the first time it runs in a
// given checkout; after that the fingerprint hits and it is a file read.

/// sha256 over every `.rs` under `src/`, plus `Cargo.toml` and the workspace
/// `Cargo.lock`, path-sorted and length-delimited. Any edit to the program —
/// including deleting the `require!` this file exists to police — changes it.
fn source_fingerprint() -> String {
    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect(&p, out);
            } else if p.extension().and_then(|s| s.to_str()) == Some("rs") {
                out.push(p);
            }
        }
    }

    let src = crate_dir().join("src");
    let mut files = Vec::new();
    collect(&src, &mut files);
    assert!(
        !files.is_empty(),
        "no .rs files under {} — the fingerprint would be vacuous and the \
         staleness check meaningless",
        src.display()
    );
    files.sort();
    files.push(crate_dir().join("Cargo.toml"));
    files.push(repo_root().join("Cargo.lock"));

    let mut blob: Vec<u8> = Vec::new();
    for f in &files {
        let rel = f.strip_prefix(repo_root()).unwrap_or(f);
        blob.extend_from_slice(rel.to_string_lossy().replace('\\', "/").as_bytes());
        blob.push(0);
        let bytes = std::fs::read(f).unwrap_or_else(|e| panic!("read {}: {}", f.display(), e));
        blob.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        blob.extend_from_slice(&bytes);
    }
    sha256_hex(&blob)
}

/// The `cargo-build-sbf` this repo pins, `Anchor.toml` `solana_version`.
///
/// Not the one on `PATH`: on the founder's machine that is agave 2.2.14 and it
/// dies with `Failed to install platform-tools: os error 183`. Set
/// `P01_CARGO_BUILD_SBF` to override.
fn cargo_build_sbf() -> PathBuf {
    if let Ok(p) = std::env::var("P01_CARGO_BUILD_SBF") {
        return PathBuf::from(p);
    }
    let solana_version = std::fs::read_to_string(repo_root().join("Anchor.toml"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.trim_start().starts_with("solana_version"))
                .and_then(|l| l.split('"').nth(1).map(str::to_string))
        })
        .unwrap_or_else(|| "3.1.9".to_string());
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    for exe in ["cargo-build-sbf.exe", "cargo-build-sbf"] {
        let p = Path::new(&home).join(format!(
            ".local/share/solana/install/releases/{}/solana-release/bin/{}",
            solana_version, exe
        ));
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("cargo-build-sbf")
}

/// SBF bytecode built from the crate this test lives in. Built once per test
/// process; cached across processes on `source_fingerprint()`.
fn program_bytes() -> &'static [u8] {
    static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
    BYTES.get_or_init(|| {
        let fp = source_fingerprint();
        let out_dir = repo_root().join("target/deep-ali-gate");
        let so = out_dir.join(format!("{}.so", CRATE_NAME));
        let fp_file = out_dir.join(format!("{}.srcfp", CRATE_NAME));

        let cached = so.exists()
            && std::fs::read_to_string(&fp_file)
                .map(|s| s.trim() == fp)
                .unwrap_or(false);

        if !cached {
            std::fs::create_dir_all(&out_dir).expect("create out dir");
            // Drop the old pair first: a fingerprint file must never outlive
            // the artifact it describes, or a failed build leaves a stale
            // artifact looking current.
            let _ = std::fs::remove_file(&fp_file);
            let _ = std::fs::remove_file(&so);

            let tool = cargo_build_sbf();
            eprintln!(
                "[deep_ali_gate] source fingerprint {} — rebuilding {} with {}",
                &fp[..16],
                CRATE_NAME,
                tool.display()
            );
            let out = std::process::Command::new(&tool)
                .arg("--manifest-path")
                .arg(crate_dir().join("Cargo.toml"))
                .arg("--sbf-out-dir")
                .arg(&out_dir)
                .env("CARGO_TARGET_DIR", out_dir.join("sbf-target"))
                .output()
                .unwrap_or_else(|e| {
                    panic!(
                        "could not run {}: {}\n\n\
                         This test builds the bytecode it asserts about, so a missing build tool\n\
                         is a broken test, not a passing one. Set P01_CARGO_BUILD_SBF to a\n\
                         working cargo-build-sbf.\n",
                        tool.display(),
                        e
                    )
                });
            if !out.status.success() || !so.exists() {
                panic!(
                    "cargo-build-sbf failed for {} (status {:?}, artifact present: {})\n\
                     --- stderr ---\n{}\n--- stdout ---\n{}",
                    CRATE_NAME,
                    out.status.code(),
                    so.exists(),
                    String::from_utf8_lossy(&out.stderr),
                    String::from_utf8_lossy(&out.stdout),
                );
            }
            std::fs::write(&fp_file, &fp).expect("write fingerprint");
        }

        let bytes = std::fs::read(&so).unwrap_or_else(|e| panic!("read {}: {}", so.display(), e));
        eprintln!(
            "[deep_ali_gate] {}.so  {} bytes  sha256 {}  <- source fp {} ({})",
            CRATE_NAME,
            bytes.len(),
            &sha256_hex(&bytes)[..16],
            &fp[..16],
            if cached { "cache hit" } else { "rebuilt" }
        );
        bytes
    })
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

struct Rig {
    svm: LiteSVM,
    ephemeral: Keypair,
    ephemeral_pk: Address,
    /// The `LiquidityPool.admin`, and the `authority` on the planted
    /// `DenominatedPool`. Deliberately NOT the ephemeral signer: if the two
    /// were the same key, `denominated_pool.authority == pool.admin` would be
    /// satisfied by accident in every test and the allowlist would be untested.
    admin_pk: Address,
    recipient: Address,
    pool: Address,
    proof_buffer: Address,
    denominated_pool: Address,
    prefund_record: Address,
    nullifier: [u8; 32],
    stark_commitment: u64,
}

/// The outcome of one `prefund` attempt, plus the pool balance before/after so
/// a "rejected" claim can be checked against the money actually moving.
struct Outcome {
    accepted: bool,
    err: String,
    logs: Vec<String>,
    pool_lamports_before: u64,
    pool_lamports_after: u64,
    recipient_lamports_after: u64,
}

impl Outcome {
    fn paid(&self) -> u64 {
        self.pool_lamports_before
            .saturating_sub(self.pool_lamports_after)
    }

    /// Require the reject AND the specific `LiquidityError` behind it. Without
    /// the code, a test passes when an unrelated guard fires first — which is
    /// exactly how the old owner-check test survived deleting the owner check.
    fn expect_rejected_with(&self, code: u32, what: &str) {
        assert!(
            !self.accepted,
            "{what}: prefund ACCEPTED and moved {} lamports\n  logs: {:?}",
            self.paid(),
            tail(&self.logs, 8),
        );
        let needle = format!("Custom({})", code);
        assert!(
            self.err.contains(&needle),
            "{what}: rejected, but not by the check under test.\n  \
             expected error {needle}, got {}\n  logs: {:?}",
            self.err,
            tail(&self.logs, 8),
        );
        assert_eq!(
            self.pool_lamports_before, self.pool_lamports_after,
            "{what}: prefund was rejected but the pool balance still moved"
        );
    }
}

/// Free-standing `prefund` instruction builder so tests can vary the nullifier
/// and the `prefund_record` account independently of the rig.
#[allow(clippy::too_many_arguments)]
fn prefund_ix(
    ephemeral_pk: Address,
    recipient: Address,
    pool: Address,
    proof_buffer: Address,
    denominated_pool: Address,
    prefund_record: Address,
    nullifier: [u8; 32],
    stark_commitment: u64,
    amount: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 32 + 32 + 8 + 8 + 8);
    data.extend_from_slice(&anchor_ix_disc("prefund"));
    data.extend_from_slice(&nullifier);
    data.extend_from_slice(&[0u8; 32]); // merkle_root — stored, never checked here
    data.extend_from_slice(&0u64.to_le_bytes()); // min_epoch
    data.extend_from_slice(&stark_commitment.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(ephemeral_pk, true),
            AccountMeta::new(recipient, false),
            AccountMeta::new(pool, false),
            AccountMeta::new_readonly(proof_buffer, false),
            AccountMeta::new_readonly(denominated_pool, false),
            AccountMeta::new(prefund_record, false),
            AccountMeta::new_readonly(Address::from_str(SYSTEM_PROGRAM_ID).unwrap(), false),
        ],
        data,
    }
}

/// How the `LiquidityPool` account gets into the ledger.
#[derive(PartialEq, Eq)]
enum PoolSetup {
    /// Planted with `is_active = true` — the state after an admin has
    /// explicitly enabled prefunds. Everything except the kill-switch test
    /// wants this, because a pool that rejects everything makes every other
    /// gate vacuous.
    PlantedActive,
    /// Created by actually running `init_pool`, so whatever that instruction
    /// writes is what the test sees. Nothing is planted or patched.
    ViaInitPool,
}

impl Rig {
    fn new() -> Self {
        Self::with_pool_denomination(DENOMINATION)
    }

    fn with_pool_denomination(denomination: u64) -> Self {
        Self::build(denomination, PoolSetup::PlantedActive)
    }

    /// Rig whose pool is whatever `init_pool` produces — used to prove the
    /// shipped default is prefund-off.
    fn with_pool_created_by_init_pool() -> Self {
        Self::build(DENOMINATION, PoolSetup::ViaInitPool)
    }

    fn build(denomination: u64, setup: PoolSetup) -> Self {
        let bytes = program_bytes();

        let pid = program_id();
        let verifier = Address::from_str(VERIFIER_ID).unwrap();

        let mut svm = LiteSVM::new().with_transaction_history(0);
        svm.add_program(pid, bytes).expect("add_program");

        let ephemeral = Keypair::new();
        let ephemeral_pk = ephemeral.pubkey();
        svm.airdrop(&ephemeral_pk, 5_000_000_000).expect("airdrop");

        let recipient = Keypair::new().pubkey();
        svm.airdrop(&recipient, 1_000_000_000).expect("airdrop");

        let admin = Keypair::new();
        let admin_pk = admin.pubkey();
        svm.airdrop(&admin_pk, 5_000_000_000).expect("airdrop");

        let (pool, pool_bump) = Address::find_program_address(&[LiquidityPool::SEED_PREFIX], &pid);

        match setup {
            // Planted directly: `init_pool` is not what most of these tests are
            // about, and `is_active: true` is the ENABLED state. `init_pool`
            // creates the pool with `is_active = false`, so every test on this
            // rig asserts behaviour for a pool an admin has explicitly switched
            // on — which is the state in which the payout gates have to hold.
            PoolSetup::PlantedActive => {
                let pool_state = LiquidityPool {
                    admin: anchor_lang::prelude::Pubkey::new_from_array(admin_pk.to_bytes()),
                    total_shares: POOL_RESERVE as u128,
                    reserve_lamports: POOL_RESERVE,
                    prefund_fee_bps: PREFUND_FEE_BPS,
                    settler_reward_bps: SETTLER_REWARD_BPS,
                    is_active: true,
                    bump: pool_bump,
                };
                let mut pool_data = Vec::new();
                pool_state
                    .try_serialize(&mut pool_data)
                    .expect("serialize LiquidityPool");
                pool_data.resize(LiquidityPool::LEN, 0);
                svm.set_account(
                    pool,
                    Account {
                        lamports: POOL_RESERVE + POOL_RENT,
                        data: pool_data,
                        owner: pid,
                        executable: false,
                        rent_epoch: 0,
                    },
                )
                .expect("set pool account");
            }
            // Real `init_pool` transaction. Nothing about the resulting account
            // is patched here — the test reads back what the instruction wrote.
            PoolSetup::ViaInitPool => {
                let mut data = Vec::with_capacity(8 + 2 + 2);
                data.extend_from_slice(&anchor_ix_disc("init_pool"));
                data.extend_from_slice(&PREFUND_FEE_BPS.to_le_bytes());
                data.extend_from_slice(&SETTLER_REWARD_BPS.to_le_bytes());
                let ix = Instruction {
                    program_id: pid,
                    accounts: vec![
                        AccountMeta::new(admin_pk, true),
                        AccountMeta::new(pool, false),
                        AccountMeta::new_readonly(
                            Address::from_str(SYSTEM_PROGRAM_ID).unwrap(),
                            false,
                        ),
                    ],
                    data,
                };
                let msg = Message::new(&[ix], Some(&admin_pk));
                let tx = Transaction::new(&[&admin], msg, svm.latest_blockhash());
                svm.send_transaction(tx)
                    .unwrap_or_else(|f| panic!("init_pool failed: {:?}\n{:?}", f.err, f.meta.logs));
            }
        }

        // --- the denominated pool: a real zk_shielded DenominatedPool ---
        //
        // Planted rather than CPI-created: zk_shielded is not loaded here, and
        // `prefund` only reads the account (owner, discriminator, denomination).
        // Its key is also a `PrefundRecord` PDA seed, which is why it cannot be
        // an arbitrary address any more.
        let denominated_pool = Address::new_from_array([9u8; 32]);
        svm.set_account(
            denominated_pool,
            Account {
                lamports: 2_000_000,
                data: denominated_pool_data(DENOMINATED_POOL_DISC, &admin_pk, denomination),
                owner: Address::from_str(ZK_SHIELDED_ID).unwrap(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("set denominated_pool");

        let nullifier = [0x5Au8; 32];
        let stark_commitment: u64 = 0xDEAD_BEEF_CAFE_1234;

        let prefund_record = prefund_record_pda(&pid, &denominated_pool, &nullifier);

        // --- proof buffer, owned by the verifier, contents planted below ---
        let proof_buffer = Keypair::new().pubkey();
        svm.set_account(
            proof_buffer,
            Account {
                lamports: 2_000_000,
                data: vec![0u8; PB_LEN],
                owner: verifier,
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("set proof buffer");

        Rig {
            svm,
            ephemeral,
            ephemeral_pk,
            admin_pk,
            recipient,
            pool,
            proof_buffer,
            denominated_pool,
            prefund_record,
            nullifier,
            stark_commitment,
        }
    }

    /// Overwrite the proof buffer with a chosen `(verified, deep_ali_verified)`
    /// pair. Everything else — discriminator, owner, authority, circuit id,
    /// public-inputs hash — is left exactly as an honest phase-1 run leaves it,
    /// so the only variable between the two tests is byte 82.
    fn plant_buffer(&mut self, verified: bool, deep_ali_verified: bool, len: usize) {
        let hash = expected_inputs_hash(&self.nullifier, self.stark_commitment);
        let mut data = proof_buffer_data(
            &self.ephemeral_pk,
            CIRCUIT_POOL_COMMITMENT,
            verified,
            deep_ali_verified,
            hash,
        );
        data.truncate(len);
        let verifier = Address::from_str(VERIFIER_ID).unwrap();
        self.svm
            .set_account(
                self.proof_buffer,
                Account {
                    lamports: 2_000_000,
                    data,
                    owner: verifier,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("set proof buffer");
    }

    /// Replace the `denominated_pool` account image. Used to show that a
    /// non-zk_shielded account in that slot is rejected — the slot is a
    /// `PrefundRecord` PDA seed, so leaving it unvalidated made every fresh
    /// dummy key a fresh uninitialised PDA and therefore an unlimited replay.
    fn plant_denominated_pool(&mut self, data: Vec<u8>, owner: Address) {
        self.svm
            .set_account(
                self.denominated_pool,
                Account {
                    lamports: 2_000_000,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("set denominated_pool");
    }

    fn prefund_ix(&self) -> Instruction {
        self.prefund_ix_with_amount(DENOMINATION)
    }

    fn prefund_ix_with_amount(&self, amount: u64) -> Instruction {
        prefund_ix(
            self.ephemeral_pk,
            self.recipient,
            self.pool,
            self.proof_buffer,
            self.denominated_pool,
            self.prefund_record,
            self.nullifier,
            self.stark_commitment,
            amount,
        )
    }

    fn send_prefund(&mut self) -> Outcome {
        self.send_prefund_ix(self.prefund_ix())
    }

    fn send_prefund_amount(&mut self, amount: u64) -> Outcome {
        self.send_prefund_ix(self.prefund_ix_with_amount(amount))
    }

    fn pool_account_data(&self) -> Vec<u8> {
        self.svm
            .get_account(&self.pool)
            .expect("pool account exists")
            .data
    }

    /// Flip ONLY the kill-switch byte and give the reserve something to pay
    /// from. Nothing else about the account `init_pool` wrote is touched, so a
    /// prefund that succeeds afterwards isolates `is_active` as the single
    /// reason the earlier attempt failed.
    fn enable_prefunds_and_fund_reserve(&mut self) {
        let mut acct = self.svm.get_account(&self.pool).expect("pool account exists");
        assert_eq!(acct.data[LP_IS_ACTIVE], 0, "expected a disabled pool");
        acct.data[LP_IS_ACTIVE] = 1;
        acct.data[LP_RESERVE_LAMPORTS..LP_RESERVE_LAMPORTS + 8]
            .copy_from_slice(&POOL_RESERVE.to_le_bytes());
        acct.lamports = POOL_RESERVE + POOL_RENT;
        self.svm.set_account(self.pool, acct).expect("set pool account");
    }

    fn send_prefund_ix(&mut self, ix: Instruction) -> Outcome {
        let pool_before = self.svm.get_account(&self.pool).map(|a| a.lamports).unwrap_or(0);
        let msg = Message::new(&[ix], Some(&self.ephemeral_pk));
        let tx = Transaction::new(&[&self.ephemeral], msg, self.svm.latest_blockhash());
        let (accepted, err, logs) = match self.svm.send_transaction(tx) {
            Ok(meta) => (true, String::new(), meta.logs),
            Err(f) => (false, format!("{:?}", f.err), f.meta.logs),
        };
        Outcome {
            accepted,
            err,
            logs,
            pool_lamports_before: pool_before,
            pool_lamports_after: self.svm.get_account(&self.pool).map(|a| a.lamports).unwrap_or(0),
            recipient_lamports_after: self
                .svm
                .get_account(&self.recipient)
                .map(|a| a.lamports)
                .unwrap_or(0),
        }
    }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// **The negative test.** verified = 1, deep_ali_verified = 0 — exactly the
/// state a caller reaches by sending `verify_stark_proof_v2` and simply not
/// sending `verify_deep_ali_phase2`.
///
/// Before the gate landed this test FAILED: the transaction succeeded and the
/// pool paid out. That is the whole point — an assertion that cannot go red is
/// not a gate.
#[test]
fn prefund_rejects_phase1_only_buffer() {
    let mut rig = Rig::new();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ false, PB_LEN);
    let out = rig.send_prefund();

    if out.accepted {
        panic!(
            "HOLE OPEN: prefund ACCEPTED a phase-1-only proof buffer \
             (data[49]=1, data[82]=0).\n  \
             pool lamports {} -> {} (paid out {})\n  \
             recipient now holds {}\n  \
             logs: {:?}",
            out.pool_lamports_before,
            out.pool_lamports_after,
            out.pool_lamports_before.saturating_sub(out.pool_lamports_after),
            out.recipient_lamports_after,
            tail(&out.logs, 6),
        );
    }

    out.expect_rejected_with(ERR_PROOF_NOT_VERIFIED, "phase-1-only proof buffer");
    eprintln!("[deep_ali_gate] prefund rejected phase-1-only buffer: {}", out.err);
}

/// **The anti-vacuity control.** Same accounts, same instruction data, same
/// public-inputs hash — only byte 82 differs. If the gate were implemented as
/// "reject everything", this goes red.
#[test]
fn prefund_accepts_fully_verified_buffer() {
    let mut rig = Rig::new();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);
    let out = rig.send_prefund();

    assert!(
        out.accepted,
        "an honest, fully-verified buffer (data[49]=1, data[82]=1) must still be accepted.\n  \
         err: {}\n  logs: {:?}",
        out.err,
        tail(&out.logs, 8),
    );

    // A gate that accepts but silently no-ops would also pass an `is_ok`
    // check, so require the payout that makes the accept meaningful.
    let paid = out.pool_lamports_before - out.pool_lamports_after;
    let expected = DENOMINATION
        - DENOMINATION * PREFUND_FEE_BPS as u64 / 10_000
        - DENOMINATION * SETTLER_REWARD_BPS as u64 / 10_000;
    assert_eq!(
        paid, expected,
        "accepted prefund did not move the expected lamports"
    );
    eprintln!("[deep_ali_gate] prefund accepted fully-verified buffer, paid {} lamports", paid);
}

/// A buffer truncated to the pre-fix `PROOF_BUF_MIN_LEN` of 82 has no byte 82
/// at all. Every buffer `p01_stark_verifier` can create is
/// `PROOF_DATA_OFFSET = 83` bytes or longer (`lib.rs:556`), so rejecting this
/// costs no honest caller anything — but if the length check were left at 82
/// the gate could be read off the end of a short account.
#[test]
fn prefund_rejects_buffer_too_short_to_hold_the_flag() {
    let mut rig = Rig::new();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, 82);
    // 6008 = InvalidProofBuffer, i.e. the length guard in `parse_proof_buffer`.
    rig.send_prefund()
        .expect_rejected_with(6008, "82-byte buffer that cannot carry deep_ali_verified");
}

// ---------------------------------------------------------------------------
// The payout binding — a fully honest proof must not authorise an arbitrary
// amount, and the pool slot must be a real pool
// ---------------------------------------------------------------------------

/// **Negative.** The buffer here is completely honest: verified = 1,
/// deep_ali_verified = 1, hash matching. The only thing wrong is `amount`, and
/// the circuit-1 proof does not cover `amount` — it binds only
/// `sha256(nullifier_u64 || stark_commitment)`.
///
/// Before the binding landed this test FAILED: the pool paid out five
/// denominations against a one-denomination note, and would have paid out the
/// whole reserve on a big enough argument.
#[test]
fn prefund_rejects_amount_that_is_not_the_pool_denomination() {
    let mut rig = Rig::new();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);

    let greedy = DENOMINATION * 5;
    let out = rig.send_prefund_amount(greedy);

    if out.accepted {
        panic!(
            "DRAIN OPEN: prefund paid out {} lamports against a pool whose denomination is {}.\n  \
             pool lamports {} -> {}\n  logs: {:?}",
            greedy,
            DENOMINATION,
            out.pool_lamports_before,
            out.pool_lamports_after,
            tail(&out.logs, 6),
        );
    }
    out.expect_rejected_with(ERR_AMOUNT_MISMATCH, "amount above the pool denomination");
    eprintln!(
        "[deep_ali_gate] prefund rejected amount {} != denomination {}: {}",
        greedy, DENOMINATION, out.err
    );
}

/// **Negative — the length guard.** A zero-length account in the
/// `denominated_pool` slot. This is what the rig used to plant: a plain funded
/// address owned by the system program with no account data at all.
///
/// It is named for the check it actually exercises. Its previous name claimed
/// to test the OWNER binding, but `parse_denominated_pool` checks owner first
/// and length second, so with empty data the length guard rejects whether or
/// not the owner check exists — and the whole file stayed green with the owner
/// `require!` replaced by `let _ = owner;` (measured: 8 passed, artifact
/// rebuilt, sha256 e535325fef841742). The real owner test is
/// `prefund_rejects_wellformed_pool_image_under_foreign_owner`.
#[test]
fn prefund_rejects_denominated_pool_too_short_to_be_a_pool() {
    let mut rig = Rig::new();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);
    rig.plant_denominated_pool(Vec::new(), Address::from_str(SYSTEM_PROGRAM_ID).unwrap());

    rig.send_prefund()
        .expect_rejected_with(ERR_INVALID_DENOMINATED_POOL, "zero-length denominated_pool");
}

/// **Negative — the OWNER binding.** A byte-perfect `DenominatedPool` image
/// (correct discriminator, our own admin as `authority`, a real denomination)
/// sitting under an owner that is not zk_shielded.
///
/// That is the account an attacker-controlled program can write at will: 80
/// bytes it chooses, in a slot that feeds both the payout amount and a
/// `PrefundRecord` PDA seed. Nothing but the owner comparison distinguishes it
/// from the genuine article, so nothing but this test covers that comparison.
/// Verified RED by deleting only
/// `require!(*owner == ZK_SHIELDED_PROGRAM_ID, ..)`.
#[test]
fn prefund_rejects_wellformed_pool_image_under_foreign_owner() {
    let mut rig = Rig::new();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);
    let admin = rig.admin_pk;
    // Everything about these bytes is correct except who owns the account.
    rig.plant_denominated_pool(
        denominated_pool_data(DENOMINATED_POOL_DISC, &admin, DENOMINATION),
        Address::new_unique(),
    );

    rig.send_prefund().expect_rejected_with(
        ERR_INVALID_DENOMINATED_POOL,
        "well-formed pool image under a foreign owner",
    );
    eprintln!("[deep_ali_gate] prefund rejected a well-formed pool image owned by a foreign program");
}

/// **Negative.** Right owner, wrong account type — a zk_shielded account that
/// is not a denominated pool. Catches an owner-only check.
#[test]
fn prefund_rejects_zk_shielded_account_that_is_not_a_pool() {
    let mut rig = Rig::new();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);
    let admin = rig.admin_pk;
    rig.plant_denominated_pool(
        denominated_pool_data([0xAAu8; 8], &admin, DENOMINATION),
        Address::from_str(ZK_SHIELDED_ID).unwrap(),
    );

    rig.send_prefund().expect_rejected_with(
        ERR_INVALID_DENOMINATED_POOL,
        "zk_shielded-owned account with the wrong discriminator",
    );
}

// ---------------------------------------------------------------------------
// The pool allowlist — `amount == denomination` is worthless while the
// attacker can mint the pool that declares the denomination
// ---------------------------------------------------------------------------

/// **Negative — the drain.** `zk_shielded::init_denominated_pool` is
/// permissionless: `authority` is a bare `Signer`, `token_mint` is an
/// unvalidated `Pubkey` instruction argument, and `denomination` is a free
/// `u64` gated only by `> 0` (`init_denominated_pool.rs:63`). The PDA seeds are
/// `[b"denominated_pool", token_mint, denomination.to_le_bytes()]`, so any
/// (arbitrary 32 bytes, arbitrary denomination) pair is a fresh uninitialised
/// PDA anyone can create for rent.
///
/// So the account planted here is not a forgery. It is exactly what an attacker
/// gets by paying rent: owned by zk_shielded, genuine `DenominatedPool`
/// discriminator, and a `denomination` set to the entire liquidity reserve.
/// Every structural check in `parse_denominated_pool` passes. Only
/// `authority == pool.admin` stands between it and the reserve.
///
/// Measured against the previous revision, which had the DEEP-ALI gate and
/// `amount == denomination` but no authority binding: ACCEPTED, pool
/// 10,002,000,000 -> 112,000,000, paid 9,890,000,000.
#[test]
fn prefund_rejects_a_pool_minted_by_someone_other_than_the_admin() {
    let mut rig = Rig::with_pool_denomination(DENOMINATION);
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);

    // The attacker mints a pool whose declared note value is the whole reserve.
    let attacker = Address::new_unique();
    let greedy_denomination = POOL_RESERVE;
    rig.plant_denominated_pool(
        denominated_pool_data(DENOMINATED_POOL_DISC, &attacker, greedy_denomination),
        Address::from_str(ZK_SHIELDED_ID).unwrap(),
    );

    let out = rig.send_prefund_amount(greedy_denomination);
    if out.accepted {
        panic!(
            "DRAIN OPEN: prefund paid {} lamports against an ATTACKER-MINTED pool whose \
             `denomination` field the attacker chose.\n  \
             pool lamports {} -> {}\n  logs: {:?}",
            out.paid(),
            out.pool_lamports_before,
            out.pool_lamports_after,
            tail(&out.logs, 8),
        );
    }
    out.expect_rejected_with(
        ERR_UNSUPPORTED_DENOMINATED_POOL,
        "attacker-minted denominated pool",
    );
    eprintln!(
        "[deep_ali_gate] prefund rejected an attacker-minted pool declaring denomination {}",
        greedy_denomination
    );
}

/// **Anti-vacuity control for the allowlist.** Same shape as the drain test —
/// a pool the rig did not create, at a denomination the happy path never uses —
/// but with `authority` set to the liquidity pool's admin. It must be accepted
/// and must pay that denomination, so the binding is "authority == our admin",
/// not "reject any pool image the rig did not plant itself".
#[test]
fn prefund_accepts_a_freshly_planted_pool_whose_authority_is_the_admin() {
    let mut rig = Rig::new();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);

    let other: u64 = 750_000_000; // 0.75 SOL — not DENOMINATION
    assert_ne!(other, DENOMINATION);
    let admin = rig.admin_pk;
    rig.plant_denominated_pool(
        denominated_pool_data(DENOMINATED_POOL_DISC, &admin, other),
        Address::from_str(ZK_SHIELDED_ID).unwrap(),
    );

    let out = rig.send_prefund_amount(other);
    assert!(
        out.accepted,
        "an admin-created pool must still be accepted.\n  err: {}\n  logs: {:?}",
        out.err,
        tail(&out.logs, 8),
    );
    let expected =
        other - other * PREFUND_FEE_BPS as u64 / 10_000 - other * SETTLER_REWARD_BPS as u64 / 10_000;
    assert_eq!(out.paid(), expected, "payout did not follow the pool's denomination");
    eprintln!(
        "[deep_ali_gate] prefund accepted an admin-authored pool at denomination {} and paid {}",
        other,
        out.paid()
    );
}

/// **Anti-vacuity control for the payout binding.** A pool with a *different*
/// denomination, and an `amount` argument that matches it, must still be
/// accepted and must pay out that denomination — so the binding is
/// "amount == this pool's denomination", not "amount == one hardcoded number"
/// and not "reject everything but the happy-path constant".
#[test]
fn prefund_accepts_a_pool_with_a_different_denomination() {
    let other: u64 = 250_000_000; // 0.25 SOL
    assert_ne!(other, DENOMINATION);

    let mut rig = Rig::with_pool_denomination(other);
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);
    let out = rig.send_prefund_amount(other);

    assert!(
        out.accepted,
        "a prefund matching the pool's own denomination must be accepted.\n  \
         err: {}\n  logs: {:?}",
        out.err,
        tail(&out.logs, 8),
    );
    let paid = out.pool_lamports_before - out.pool_lamports_after;
    let expected =
        other - other * PREFUND_FEE_BPS as u64 / 10_000 - other * SETTLER_REWARD_BPS as u64 / 10_000;
    assert_eq!(paid, expected, "payout did not follow the pool's denomination");
    eprintln!("[deep_ali_gate] prefund accepted denomination {} and paid {}", other, paid);
}

// ---------------------------------------------------------------------------
// Replay — one verified buffer must buy at most one payout
// ---------------------------------------------------------------------------

/// **Negative — unbounded replay on ONE real pool.** No pool-minting needed.
///
/// `prefund` binds the proof to `sha256(u64::from_le_bytes(nullifier[..8]) ||
/// stark_commitment)`. Bytes 8..32 of the nullifier are constrained by nothing
/// whatsoever. The `PrefundRecord` PDA — whose `init` is the ONLY anti-replay
/// constraint in the handler — used to be seeded on all 32, so one verified
/// buffer had 2^192 distinct anti-replay slots. Same proof, same proven prefix,
/// bump an unproven tail byte, get paid again.
///
/// The test is written so it does not need to know which seed rule is compiled
/// in: for every nullifier it offers the program BOTH candidate record PDAs and
/// counts how many attempts the program actually accepted. The invariant is the
/// count, not the error.
///
///   - all-32 seeds  (before): one accept per tail value — measured 4 accepts,
///     3,956,000,000 lamports out of the reserve.
///   - `[..8]` seeds (after):  the first accept, then `init` fails because it
///     is the same PDA every time.
#[test]
fn prefund_cannot_be_replayed_by_varying_the_unproven_nullifier_tail() {
    let mut rig = Rig::new();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);

    let pid = program_id();
    let dp = rig.denominated_pool;
    let base = rig.nullifier;
    let commitment = rig.stark_commitment;

    let mut accepted = 0usize;
    let mut paid_total: u64 = 0;

    for tag in 0u8..4 {
        // Vary ONLY bytes the proof does not cover. nullifier[..8] — and hence
        // the public-inputs hash the buffer carries — is byte-identical across
        // every iteration.
        let mut nullifier = base;
        nullifier[31] = tag;
        assert_eq!(nullifier[..8], base[..8]);

        for record in [
            prefund_record_pda(&pid, &dp, &nullifier),
            prefund_record_pda_full_nullifier(&pid, &dp, &nullifier),
        ] {
            let ix = prefund_ix(
                rig.ephemeral_pk,
                rig.recipient,
                rig.pool,
                rig.proof_buffer,
                dp,
                record,
                nullifier,
                commitment,
                DENOMINATION,
            );
            let out = rig.send_prefund_ix(ix);
            if out.accepted {
                accepted += 1;
                paid_total += out.paid();
                eprintln!("[deep_ali_gate] replay probe: tail {} ACCEPTED, paid {}", tag, out.paid());
            }
        }
    }

    assert_eq!(
        accepted, 1,
        "REPLAY OPEN on ONE real pool: a single verified buffer opened {} prefunds \
         totalling {} lamports by varying only nullifier[8..32], which nothing constrains. \
         The PrefundRecord PDA must be keyed on the proven prefix.",
        accepted, paid_total,
    );
    eprintln!(
        "[deep_ali_gate] one buffer, 4 nullifier tails, 8 attempts -> {} accepted ({} lamports)",
        accepted, paid_total
    );
}

/// **The other half of the replay fix.** `prefund` creates the record and
/// `settle` has to be able to address it. Both derive
/// `[b"prefund", denominated_pool, nullifier[..8]]`, and if they ever disagree
/// the record is unreachable: the money is out of the reserve and the only
/// instruction that could bring it back cannot name the account. Nothing else
/// in the repo compares the two derivations — they live in separate
/// `#[derive(Accounts)]` blocks in separate files.
///
/// So: run a real prefund, then send a real `settle` with the record PDA
/// `prefund` actually created, and require that Anchor's seeds check is NOT
/// what rejects it. `ConstraintSeeds` is 2006.
///
/// It still fails — settle CPIs `zk_shielded::unshield_denominated_stark`,
/// which is not loaded here and, more to the point, is no longer registered in
/// zk_shielded at all. Reaching the CPI is the whole assertion: account
/// validation, including the seeds, passed.
#[test]
fn settle_can_address_the_record_prefund_created() {
    let mut rig = Rig::new();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);
    let out = rig.send_prefund();
    assert!(out.accepted, "setup prefund must succeed: {}", out.err);

    let settler = Keypair::new();
    let settler_pk = settler.pubkey();
    rig.svm.airdrop(&settler_pk, 1_000_000_000).expect("airdrop");

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(settler_pk, true),
            AccountMeta::new(rig.pool, false),
            AccountMeta::new(rig.prefund_record, false),
            AccountMeta::new(rig.denominated_pool, false),
            AccountMeta::new_readonly(Address::new_unique(), false), // merkle_tree
            AccountMeta::new(Address::new_unique(), false),          // nullifier_record
            AccountMeta::new_readonly(rig.proof_buffer, false),
            AccountMeta::new(Address::new_unique(), false),          // protocol_fee_wallet
            AccountMeta::new_readonly(Address::from_str(ZK_SHIELDED_ID).unwrap(), false),
            AccountMeta::new_readonly(Address::from_str(SYSTEM_PROGRAM_ID).unwrap(), false),
        ],
        data: anchor_ix_disc("settle").to_vec(),
    };
    let msg = Message::new(&[ix], Some(&settler_pk));
    let tx = Transaction::new(&[&settler], msg, rig.svm.latest_blockhash());
    let err = match rig.svm.send_transaction(tx) {
        Ok(_) => String::new(),
        Err(f) => format!("{:?}", f.err),
    };

    assert!(
        !err.contains("Custom(2006)") && !err.contains("ConstraintSeeds"),
        "settle cannot derive the PrefundRecord that prefund created — the seeds have \
         drifted between prefund.rs and settle.rs, so a prefund is unsettleable by \
         construction.\n  error: {}",
        err
    );
    eprintln!(
        "[deep_ali_gate] settle passed account validation on prefund's record; \
         it then fails at the CPI, as expected: {}",
        if err.is_empty() { "<succeeded>".to_string() } else { err }
    );
}

// ---------------------------------------------------------------------------
// The kill switch — prefund must be off in the state `init_pool` ships
// ---------------------------------------------------------------------------

/// **Negative — the disable itself is gated.**
///
/// `settle` CPIs `sha256("global:unshield_denominated_stark")[..8]` into
/// zk_shielded, and that instruction's `#[program]` registration is commented
/// out (`zk_shielded/src/lib.rs:152-172`) in favour of
/// `unshield_denominated_stark_v3`. zk_shielded will not dispatch it, so a
/// prefund opened today can never be settled and its payout is a permanent loss
/// from the LP reserve — a fully valid STARK proof does not change that.
///
/// So `init_pool` writes `is_active = false` and `prefund` requires
/// `is_active`. This test runs the real `init_pool` instruction, reads the byte
/// back, and then sends a prefund that is correct in every other respect —
/// honest buffer, admin-created pool, matching amount — and requires the
/// reject.
///
/// The second half is the anti-vacuity control: flip that one byte, and the
/// identical transaction is accepted and pays out. So the test is measuring the
/// kill switch and not some unrelated failure.
#[test]
fn prefund_is_unreachable_on_a_pool_as_init_pool_creates_it() {
    let mut rig = Rig::with_pool_created_by_init_pool();
    rig.plant_buffer(/* verified */ true, /* deep_ali_verified */ true, PB_LEN);

    let data = rig.pool_account_data();
    assert_eq!(
        data[LP_IS_ACTIVE], 0,
        "init_pool created the pool with is_active = 1. Prefund is reachable by \
         default and every prefund is an unrecoverable loss until settle has a \
         v3 path."
    );

    rig.send_prefund().expect_rejected_with(
        ERR_POOL_INACTIVE,
        "prefund against a pool exactly as init_pool created it",
    );
    eprintln!("[deep_ali_gate] init_pool ships is_active = 0; prefund rejected with PoolInactive");

    // Control: the ONLY change is the kill-switch byte (plus reserve funding,
    // which init_pool leaves at zero and which no gate reads).
    rig.enable_prefunds_and_fund_reserve();
    let out = rig.send_prefund();
    assert!(
        out.accepted,
        "with is_active flipped to 1 the same transaction must succeed, otherwise \
         this test is not measuring the kill switch.\n  err: {}\n  logs: {:?}",
        out.err,
        tail(&out.logs, 8),
    );
    let expected = DENOMINATION
        - DENOMINATION * PREFUND_FEE_BPS as u64 / 10_000
        - DENOMINATION * SETTLER_REWARD_BPS as u64 / 10_000;
    assert_eq!(out.paid(), expected);
    eprintln!(
        "[deep_ali_gate] admin-enabled pool: same tx accepted, paid {} lamports",
        out.paid()
    );
}

/// **Anti-vacuity control for the provenance machinery.** If `program_bytes()`
/// ever silently produced an empty or absent artifact, every "rejects" test
/// above would still pass (the transaction would fail for the wrong reason).
/// Assert the artifact is real bytecode and that the fingerprint file the
/// cache keys on actually exists next to it.
#[test]
fn artifact_is_real_bytecode_built_from_this_tree() {
    let bytes = program_bytes();
    assert!(
        bytes.len() > 10_000,
        "artifact is {} bytes — that is not a compiled Solana program",
        bytes.len()
    );
    assert_eq!(&bytes[..4], b"\x7fELF", "artifact is not an ELF object");

    let fp_file = repo_root().join(format!("target/deep-ali-gate/{}.srcfp", CRATE_NAME));
    let recorded = std::fs::read_to_string(&fp_file)
        .unwrap_or_else(|e| panic!("no fingerprint at {}: {}", fp_file.display(), e));
    assert_eq!(
        recorded.trim(),
        source_fingerprint(),
        "the cached artifact does not correspond to the current sources"
    );
}
