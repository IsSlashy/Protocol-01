//! Fails-closed gate: every zkSPL proof consumer must refuse a proof buffer
//! that only passed **phase 1** of STARK verification.
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
//! Phase 1 alone is not an AIR check — `verify_quotient_at_query` had its body
//! removed on 2026-07-27 and enforces nothing, and boundary constraints (the
//! only place a public input meets the trace in phase 1) fire only on a query
//! that is both trace-aligned and on an assertion row. A phase-1-only buffer
//! therefore lets an attacker declare arbitrary public inputs.
//!
//! `withdraw` turns that into a vault drain: declare
//! `[real balance_commitment, any new_commitment, ZERO_AMOUNT_HASH, mint]`,
//! pass any `amount`, and the vault PDA signs the transfer out.
//!
//! # One helper, five instructions
//!
//! `deposit`, `withdraw`, `confidential_transfer`, `apply_pending` (circuit 4)
//! and `prove_balance` (circuit 2) all route through
//! `stark_proof::verify_stark_proof`. The gate lives in that one function, so
//! the tests below cover both circuit ids that reach it: `withdraw` for the
//! money-moving circuit-4 path, `prove_balance` for circuit 2.
//!
//! # Why litesvm and not a unit test
//!
//! The thing under test is a `require!` inside an SBF program. litesvm runs the
//! real SBF bytecode — built from this crate by the harness itself, see
//! "Artifact provenance" — under the validator's account and compute
//! accounting, so an accept/reject here is the validator's decision.
//!
//! # Running it
//!
//! ```text
//! cargo test -p p01_zkspl --test deep_ali_gate -- --nocapture
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
//! `*_accepts_fully_verified_*` are the anti-vacuity controls: same
//! transaction, byte 82 set to 1, required to succeed and (for withdraw) to
//! actually move the vault balance.

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

use p01_zkspl::state::{ConfidentialAccount, MintConfig};

// ---------------------------------------------------------------------------
// Constants mirrored from the programs under test
// ---------------------------------------------------------------------------

/// `programs/p01_stark_verifier/src/lib.rs:37`. Also the hard-coded
/// `STARK_VERIFIER_PROGRAM_ID` in `stark_proof.rs:14-19`.
const VERIFIER_ID: &str = "DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs";

const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";

/// Anchor discriminator of `p01_stark_verifier::ProofBuffer`.
const PROOF_BUFFER_DISC: [u8; 8] = [71, 133, 225, 94, 9, 130, 40, 161];

/// `ProofBuffer` byte layout (`p01_stark_verifier/src/lib.rs:537-572`):
/// 0..8 disc | 8..40 authority | 40 circuit_id | 41..45 proof_size |
/// 45..49 bytes_written | 49 verified | 50..82 public_inputs_hash |
/// 82 deep_ali_verified | 83 = PROOF_DATA_OFFSET.
const PB_LEN: usize = 83;

/// `stark_proof.rs:32` / `:35`.
const CIRCUIT_CONFIDENTIAL_BALANCE: u8 = 4;
const CIRCUIT_BALANCE_PROOF: u8 = 2;

/// Poseidon(0, 0), LE bytes — copied from `withdraw.rs:78-83`, where it is a
/// private const.
const ZERO_AMOUNT_HASH: [u8; 32] = [
    100, 72, 182, 70, 132, 238, 57, 168, 35, 213, 254, 95, 213, 36, 49, 220, 129, 228, 129, 123,
    242, 195, 234, 60, 171, 158, 35, 158, 251, 245, 152, 32,
];

const VAULT_LAMPORTS: u64 = 5_000_000_000;
const WITHDRAW_AMOUNT: u64 = 1_000_000_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CRATE_NAME: &str = "p01_zkspl";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/programs/p01_zkspl
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
    Address::new_from_array(p01_zkspl::ID.to_bytes())
}

fn u64_le_head(bytes: &[u8; 32]) -> u64 {
    u64::from_le_bytes(bytes[..8].try_into().unwrap())
}

/// The `public_inputs_hash` `verify_stark_proof_v2` stores, rebuilt exactly the
/// way `stark_proof.rs:101-105` rebuilds it.
fn packed_inputs_hash(inputs: &[u64]) -> [u8; 32] {
    let mut packed = Vec::with_capacity(inputs.len() * 8);
    for v in inputs {
        packed.extend_from_slice(&v.to_le_bytes());
    }
    sha256(&packed)
}

/// Build a `ProofBuffer` account image by hand. The attack this models never
/// runs `verify_deep_ali_phase2`, so no honest code path produces this state.
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
    d[49] = u8::from(verified);
    d[50..82].copy_from_slice(&public_inputs_hash);
    d[82] = u8::from(deep_ali_verified);
    d
}

fn tail(v: &[String], n: usize) -> Vec<String> {
    let start = v.len().saturating_sub(n);
    v[start..].to_vec()
}

// ---------------------------------------------------------------------------
// Artifact provenance — the bytes under test come from THIS source tree
// ---------------------------------------------------------------------------
//
// `cargo test --test deep_ali_gate` builds a HOST binary. It does not build SBF
// bytecode. An earlier revision of this file simply read
// `target/deploy/p01_zkspl.so`, which made every assertion below a statement
// about whatever bytes happened to be sitting in that directory rather than
// about the source tree. Review demonstrated the consequence: delete the
// `require!(deep_ali_verified, ..)` from `stark_proof.rs`, copy the old `.so`
// back over `target/deploy/` without rebuilding, run the suite — 5 passed,
// against source with no gate in it.
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
    user: Keypair,
    user_pk: Address,
    mint_config: Address,
    confidential_account: Address,
    vault: Address,
    proof_buffer: Address,
    balance_commitment: [u8; 32],
}

struct Outcome {
    accepted: bool,
    err: String,
    logs: Vec<String>,
    vault_before: u64,
    vault_after: u64,
}

impl Rig {
    /// `token_mint = system_program::ID` selects `withdraw`'s native-SOL branch
    /// (`withdraw.rs:119`), which is the shortest path to a real vault payout.
    fn token_mint() -> Address {
        Address::from_str(SYSTEM_PROGRAM_ID).unwrap()
    }

    fn new() -> Self {
        let bytes = program_bytes();

        let pid = program_id();
        let verifier = Address::from_str(VERIFIER_ID).unwrap();
        let token_mint = Self::token_mint();

        let mut svm = LiteSVM::new().with_transaction_history(0);
        svm.add_program(pid, bytes).expect("add_program");

        let user = Keypair::new();
        let user_pk = user.pubkey();
        svm.airdrop(&user_pk, 5_000_000_000).expect("airdrop");

        // --- mint config ---
        let (mint_config, mc_bump) =
            Address::find_program_address(&[MintConfig::SEED_PREFIX, token_mint.as_ref()], &pid);
        let mc = MintConfig {
            authority: anchor_lang::prelude::Pubkey::new_from_array(user_pk.to_bytes()),
            token_mint: anchor_lang::prelude::Pubkey::new_from_array(token_mint.to_bytes()),
            balance_vk_hash: [0u8; 32],
            proof_vk_hash: [0u8; 32],
            is_active: true,
            account_count: 1,
            created_at: 0,
            bump: mc_bump,
        };
        let mut mc_data = Vec::new();
        mc.try_serialize(&mut mc_data).expect("serialize MintConfig");
        mc_data.resize(MintConfig::LEN, 0);
        svm.set_account(
            mint_config,
            Account {
                lamports: 2_000_000,
                data: mc_data,
                owner: pid,
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("set mint_config");

        // --- confidential account ---
        let balance_commitment = {
            let mut c = [0u8; 32];
            c[..8].copy_from_slice(&0x0123_4567_89AB_CDEFu64.to_le_bytes());
            c
        };
        let (confidential_account, ca_bump) = Address::find_program_address(
            &[
                ConfidentialAccount::SEED_PREFIX,
                user_pk.as_ref(),
                token_mint.as_ref(),
            ],
            &pid,
        );
        let ca = ConfidentialAccount {
            owner: anchor_lang::prelude::Pubkey::new_from_array(user_pk.to_bytes()),
            mint: anchor_lang::prelude::Pubkey::new_from_array(token_mint.to_bytes()),
            balance_commitment,
            nonce: 0,
            pending_credits: vec![],
            viewer_keys: vec![],
            is_initialized: true,
            created_at: 0,
            last_tx_at: 0,
            bump: ca_bump,
        };
        let mut ca_data = Vec::new();
        ca.try_serialize(&mut ca_data)
            .expect("serialize ConfidentialAccount");
        ca_data.resize(ConfidentialAccount::LEN, 0);
        svm.set_account(
            confidential_account,
            Account {
                lamports: 5_000_000,
                data: ca_data,
                owner: pid,
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("set confidential_account");

        // --- vault: system-owned, zero data, so the CPI transfer is legal ---
        let (vault, _) =
            Address::find_program_address(&[b"zkspl_vault", token_mint.as_ref()], &pid);
        svm.airdrop(&vault, VAULT_LAMPORTS).expect("fund vault");

        // --- proof buffer, owned by the verifier ---
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
            user,
            user_pk,
            mint_config,
            confidential_account,
            vault,
            proof_buffer,
            balance_commitment,
        }
    }

    /// Overwrite the proof buffer with a chosen `(verified, deep_ali_verified)`
    /// pair. Discriminator, owner, authority, circuit id and public-inputs hash
    /// stay exactly as an honest phase-1 run leaves them, so the only variable
    /// between the negative and positive tests is byte 82.
    fn plant_buffer(
        &mut self,
        circuit_id: u8,
        inputs: &[u64],
        verified: bool,
        deep_ali_verified: bool,
    ) {
        let data = proof_buffer_data(
            &self.user_pk,
            circuit_id,
            verified,
            deep_ali_verified,
            packed_inputs_hash(inputs),
        );
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

    fn withdraw_inputs(&self, new_commitment: &[u8; 32]) -> [u64; 4] {
        [
            u64_le_head(&self.balance_commitment),
            u64_le_head(new_commitment),
            u64_le_head(&ZERO_AMOUNT_HASH),
            u64_le_head(&Self::token_mint().to_bytes()),
        ]
    }

    fn withdraw_ix(&self, new_commitment: &[u8; 32]) -> Instruction {
        let mut data = Vec::with_capacity(8 + 8 + 32);
        data.extend_from_slice(&anchor_ix_disc("withdraw"));
        data.extend_from_slice(&WITHDRAW_AMOUNT.to_le_bytes());
        data.extend_from_slice(new_commitment);

        let pid = program_id();
        Instruction {
            program_id: pid,
            accounts: vec![
                AccountMeta::new(self.user_pk, true),
                AccountMeta::new_readonly(self.mint_config, false),
                AccountMeta::new(self.confidential_account, false),
                AccountMeta::new_readonly(self.proof_buffer, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new_readonly(Address::from_str(SYSTEM_PROGRAM_ID).unwrap(), false),
                // Anchor signals an absent `Option<..>` account by passing the
                // program's own id — same convention the shipped client uses
                // (`packages/zkspl-sdk/src/client.ts:944`).
                AccountMeta::new_readonly(pid, false),
                AccountMeta::new_readonly(pid, false),
                AccountMeta::new_readonly(pid, false),
            ],
            data,
        }
    }

    fn prove_balance_ix(&self) -> Instruction {
        let mut data = Vec::with_capacity(8 + 8);
        data.extend_from_slice(&anchor_ix_disc("prove_balance"));
        data.extend_from_slice(&1u64.to_le_bytes()); // threshold

        Instruction {
            program_id: program_id(),
            accounts: vec![
                AccountMeta::new(self.user_pk, true),
                AccountMeta::new_readonly(self.mint_config, false),
                AccountMeta::new_readonly(self.confidential_account, false),
                AccountMeta::new_readonly(self.proof_buffer, false),
            ],
            data,
        }
    }

    fn send(&mut self, ix: Instruction) -> Outcome {
        let vault_before = self.svm.get_account(&self.vault).map(|a| a.lamports).unwrap_or(0);
        let msg = Message::new(&[ix], Some(&self.user_pk));
        let tx = Transaction::new(&[&self.user], msg, self.svm.latest_blockhash());
        let (accepted, err, logs) = match self.svm.send_transaction(tx) {
            Ok(meta) => (true, String::new(), meta.logs),
            Err(f) => (false, format!("{:?}", f.err), f.meta.logs),
        };
        Outcome {
            accepted,
            err,
            logs,
            vault_before,
            vault_after: self.svm.get_account(&self.vault).map(|a| a.lamports).unwrap_or(0),
        }
    }
}

// ---------------------------------------------------------------------------
// The gate — circuit 4 (withdraw): a vault drain
// ---------------------------------------------------------------------------

/// **The negative test.** verified = 1, deep_ali_verified = 0 — exactly the
/// state a caller reaches by sending `verify_stark_proof_v2` and simply not
/// sending `verify_deep_ali_phase2`.
///
/// Before the gate landed this test FAILED: the vault paid out.
#[test]
fn withdraw_rejects_phase1_only_buffer() {
    let mut rig = Rig::new();
    let new_commitment = [0x77u8; 32];
    let inputs = rig.withdraw_inputs(&new_commitment);
    rig.plant_buffer(
        CIRCUIT_CONFIDENTIAL_BALANCE,
        &inputs,
        /* verified */ true,
        /* deep_ali_verified */ false,
    );
    let ix = rig.withdraw_ix(&new_commitment);
    let out = rig.send(ix);

    if out.accepted {
        panic!(
            "HOLE OPEN: withdraw ACCEPTED a phase-1-only proof buffer \
             (data[49]=1, data[82]=0).\n  \
             vault lamports {} -> {} (drained {})\n  \
             logs: {:?}",
            out.vault_before,
            out.vault_after,
            out.vault_before.saturating_sub(out.vault_after),
            tail(&out.logs, 6),
        );
    }

    assert_eq!(
        out.vault_before, out.vault_after,
        "withdraw was rejected but the vault balance still moved"
    );
    eprintln!("[deep_ali_gate] withdraw rejected phase-1-only buffer: {}", out.err);
}

/// **The anti-vacuity control.** Same accounts, same instruction data, same
/// public-inputs hash — only byte 82 differs.
#[test]
fn withdraw_accepts_fully_verified_buffer() {
    let mut rig = Rig::new();
    let new_commitment = [0x77u8; 32];
    let inputs = rig.withdraw_inputs(&new_commitment);
    rig.plant_buffer(
        CIRCUIT_CONFIDENTIAL_BALANCE,
        &inputs,
        /* verified */ true,
        /* deep_ali_verified */ true,
    );
    let ix = rig.withdraw_ix(&new_commitment);
    let out = rig.send(ix);

    assert!(
        out.accepted,
        "an honest, fully-verified buffer (data[49]=1, data[82]=1) must still be accepted.\n  \
         err: {}\n  logs: {:?}",
        out.err,
        tail(&out.logs, 8),
    );
    assert_eq!(
        out.vault_before - out.vault_after,
        WITHDRAW_AMOUNT,
        "accepted withdraw did not move the expected lamports"
    );
    eprintln!(
        "[deep_ali_gate] withdraw accepted fully-verified buffer, moved {} lamports",
        WITHDRAW_AMOUNT
    );
}

// ---------------------------------------------------------------------------
// The gate — circuit 2 (prove_balance): the other id through the same helper
// ---------------------------------------------------------------------------

/// `prove_balance` moves no funds, but it emits a `BalanceProofEvent` that
/// other programs are invited to treat as an attestation. On a phase-1-only
/// buffer that attestation is forgeable.
#[test]
fn prove_balance_rejects_phase1_only_buffer() {
    let mut rig = Rig::new();
    let inputs = [
        u64_le_head(&rig.balance_commitment),
        u64_le_head(&Rig::token_mint().to_bytes()),
    ];
    rig.plant_buffer(
        CIRCUIT_BALANCE_PROOF,
        &inputs,
        /* verified */ true,
        /* deep_ali_verified */ false,
    );
    let ix = rig.prove_balance_ix();
    let out = rig.send(ix);

    assert!(
        !out.accepted,
        "HOLE OPEN: prove_balance ACCEPTED a phase-1-only proof buffer \
         (data[49]=1, data[82]=0) and emitted an attestation. logs: {:?}",
        tail(&out.logs, 6),
    );
    eprintln!(
        "[deep_ali_gate] prove_balance rejected phase-1-only buffer: {}",
        out.err
    );
}

/// Anti-vacuity control for the circuit-2 path.
#[test]
fn prove_balance_accepts_fully_verified_buffer() {
    let mut rig = Rig::new();
    let inputs = [
        u64_le_head(&rig.balance_commitment),
        u64_le_head(&Rig::token_mint().to_bytes()),
    ];
    rig.plant_buffer(
        CIRCUIT_BALANCE_PROOF,
        &inputs,
        /* verified */ true,
        /* deep_ali_verified */ true,
    );
    let ix = rig.prove_balance_ix();
    let out = rig.send(ix);

    assert!(
        out.accepted,
        "an honest, fully-verified circuit-2 buffer must still be accepted.\n  \
         err: {}\n  logs: {:?}",
        out.err,
        tail(&out.logs, 8),
    );
}

/// A buffer truncated to the pre-fix `PROOF_BUF_MIN_LEN` of 82 has no byte 82
/// at all. Every buffer `p01_stark_verifier` can create is
/// `PROOF_DATA_OFFSET = 83` bytes or longer (`lib.rs:556`), so rejecting this
/// costs no honest caller anything.
#[test]
fn withdraw_rejects_buffer_too_short_to_hold_the_flag() {
    let mut rig = Rig::new();
    let new_commitment = [0x77u8; 32];
    let inputs = rig.withdraw_inputs(&new_commitment);
    rig.plant_buffer(
        CIRCUIT_CONFIDENTIAL_BALANCE,
        &inputs,
        /* verified */ true,
        /* deep_ali_verified */ true,
    );
    // Truncate below the flag.
    let verifier = Address::from_str(VERIFIER_ID).unwrap();
    let mut short = rig
        .svm
        .get_account(&rig.proof_buffer)
        .expect("buffer exists")
        .data;
    short.truncate(82);
    rig.svm
        .set_account(
            rig.proof_buffer,
            Account {
                lamports: 2_000_000,
                data: short,
                owner: verifier,
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("set proof buffer");

    let ix = rig.withdraw_ix(&new_commitment);
    let out = rig.send(ix);
    assert!(
        !out.accepted,
        "withdraw ACCEPTED an 82-byte buffer that cannot carry deep_ali_verified"
    );
    assert_eq!(out.vault_before, out.vault_after, "vault balance moved");
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
