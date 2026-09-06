//! [L2 2026-09-06] Pre-sized and reusable proof buffers, driven through the
//! real SBF binary on litesvm.
//!
//! # What this file proves
//!
//! `docs/PERF-AND-CAPACITY-PLAN-2026-09-06.md` §L2: an 80 KB proof used to cost
//! one `init_proof_buffer` plus EIGHT `resize_proof_buffer` transactions, each
//! confirmed before the next, because a PDA allocated through CPI is capped at
//! 10,240 bytes. Two instructions remove that chain:
//!
//!   * `init_proof_buffer_v3` initialises a buffer the client allocated at full
//!     size with a top-level `SystemProgram::CreateAccount` in the SAME
//!     transaction: one transaction instead of nine.
//!   * `reset_proof_buffer` rearms a live buffer for the next proof: zero
//!     init, zero resize for a wallet or relayer that keeps one buffer alive.
//!
//! Every assertion below runs against bytecode this harness builds itself with
//! the toolchain `Anchor.toml` pins, cached on the SAME fingerprint scheme as
//! `cu_budget.rs` (same out dir, same key), so the two harnesses share one
//! artifact and neither can measure stale bytes.
//!
//! Also pinned here, because the plan's §L3 depends on it: phase 1 and phase 2
//! of a circuit-7 verification land in ONE transaction under the 1.4M CU cap.
//!
//! # Running it
//!
//! ```text
//! cargo test --release -p p01_stark_verifier --test l2_presized_buffers -- --nocapture
//! ```
//!
//! `--release` matters: two circuit-7 proofs are generated here. The first run
//! also builds the `.so` (minutes); later runs hit the fingerprint cache. See
//! `cu_budget.rs` for the `cargo-build-sbf` notes (3.1.9 by absolute path on
//! this Windows box; `P01_CARGO_BUILD_SBF` / `P01_VERIFIER_SO` override).

use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

use std::path::{Path, PathBuf};
use std::str::FromStr;

const VERIFIER_ID: &str = "DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs";
const COMPUTE_BUDGET_ID: &str = "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";
const MAX_CU_PER_TX: u32 = 1_400_000;

/// Same chunk the on-chain clients use (`apps/web/lib/privacy/pool/stark.ts`
/// `MAX_CHUNK_SIZE = 1000`); `cu_budget.rs` uses 900. Either fits a packet.
const CHUNK: usize = 1000;

/// `ProofBuffer` layout, `lib.rs`: 8 disc | 32 authority | 1 circuit_id |
/// 4 proof_size | 4 bytes_written | 1 verified | 32 hash | 1 deep_ali = 83.
const PROOF_DATA_OFFSET: usize = 83;
const OFF_AUTHORITY: usize = 8;
const OFF_CIRCUIT_ID: usize = 40;
const OFF_PROOF_SIZE: usize = 41;
const OFF_BYTES_WRITTEN: usize = 45;
const OFF_VERIFIED: usize = 49;
const OFF_HASH: usize = 50;
const OFF_DEEP_ALI: usize = 82;
const MAX_REALLOC_STEP: usize = 10_240;

/// Anchor error numbers, `lib.rs` `StarkVerifierError` in declaration order.
const ERR_ALREADY_VERIFIED: u32 = 6000;
const ERR_CHUNK_OUT_OF_BOUNDS: u32 = 6001;
const ERR_UNSUPPORTED_CIRCUIT: u32 = 6005;
const ERR_NOT_YET_VERIFIED: u32 = 6006;
const ERR_BUFFER_TOO_SMALL: u32 = 6008;
/// anchor-lang 0.32.1 `ErrorCode`: `ConstraintMut = 2000`, `ConstraintHasOne`
/// next; `AccountDiscriminatorAlreadySet = 3000`, `AccountOwnedByWrongProgram`
/// seven later. Pinned by the log text as well, so a renumbering shows up as a
/// readable failure rather than a wrong-code coincidence.
const ERR_CONSTRAINT_HAS_ONE: u32 = 2001;

// ---------------------------------------------------------------------------
// Build the .so under test (fingerprint-cached, shared with cu_budget.rs)
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("manifest dir has two ancestors")
        .to_path_buf()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let h = solana_sha256_hasher::hashv(&[bytes]).to_bytes();
    h.iter().map(|b| format!("{:02x}", b)).collect()
}

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

fn compiler_identity() -> String {
    let tool = cargo_build_sbf();
    let out = std::process::Command::new(&tool)
        .arg("--version")
        .output()
        .unwrap_or_else(|e| panic!("could not run `{} --version`: {}", tool.display(), e));
    let mut raw = String::from_utf8_lossy(&out.stdout).into_owned();
    raw.push(' ');
    raw.push_str(&String::from_utf8_lossy(&out.stderr));
    let id = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(!id.is_empty(), "`{} --version` printed nothing", tool.display());
    id
}

/// Byte-identical to `cu_budget.rs::build_fingerprint` so the two harnesses
/// share `target/cu-budget/p01_stark_verifier.so`.
fn build_fingerprint(compiler_id: &str) -> String {
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
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    collect(&crate_dir.join("src"), &mut files);
    assert!(!files.is_empty(), "no .rs files under src/");
    files.sort();
    files.push(crate_dir.join("Cargo.toml"));
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
    blob.extend_from_slice(b"sbf-compiler");
    blob.push(0);
    blob.extend_from_slice(&(compiler_id.len() as u64).to_le_bytes());
    blob.extend_from_slice(compiler_id.as_bytes());
    sha256_hex(&blob)
}

fn verifier_so_path() -> PathBuf {
    static BUILT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    BUILT.get_or_init(verifier_so_path_uncached).clone()
}

fn verifier_so_path_uncached() -> PathBuf {
    if let Ok(p) = std::env::var("P01_VERIFIER_SO") {
        return PathBuf::from(p);
    }
    let compiler = compiler_identity();
    let fp = build_fingerprint(&compiler);
    let out_dir = repo_root().join("target/cu-budget");
    let so = out_dir.join("p01_stark_verifier.so");
    let fp_file = out_dir.join("p01_stark_verifier.buildfp");

    let cached = so.exists()
        && std::fs::read_to_string(&fp_file)
            .map(|s| s.trim() == fp)
            .unwrap_or(false);
    if !cached {
        std::fs::create_dir_all(&out_dir).expect("create cu-budget out dir");
        let _ = std::fs::remove_file(&fp_file);
        let _ = std::fs::remove_file(&so);
        let tool = cargo_build_sbf();
        eprintln!(
            "[l2_presized_buffers] build fingerprint {} — building p01_stark_verifier with {} (`{}`)",
            &fp[..16],
            tool.display(),
            compiler
        );
        let out = std::process::Command::new(&tool)
            .arg("--manifest-path")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
            .arg("--sbf-out-dir")
            .arg(&out_dir)
            .env("CARGO_TARGET_DIR", out_dir.join("sbf-target"))
            .output()
            .unwrap_or_else(|e| panic!("could not run {}: {}", tool.display(), e));
        if !out.status.success() || !so.exists() {
            panic!(
                "cargo-build-sbf failed (status {:?}, artifact present: {})\n--- stderr ---\n{}\n--- stdout ---\n{}",
                out.status.code(),
                so.exists(),
                String::from_utf8_lossy(&out.stderr),
                String::from_utf8_lossy(&out.stdout),
            );
        }
        std::fs::write(&fp_file, &fp).expect("write fingerprint");
    }
    so
}

// ---------------------------------------------------------------------------
// Instruction builders (Anchor wire format, hand-rolled like cu_budget.rs)
// ---------------------------------------------------------------------------

fn anchor_disc(name: &str) -> [u8; 8] {
    let h = solana_sha256_hasher::hashv(&[format!("global:{}", name).as_bytes()]).to_bytes();
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

fn program() -> Address {
    Address::from_str(VERIFIER_ID).unwrap()
}

fn system_program() -> Address {
    Address::from_str(SYSTEM_PROGRAM_ID).unwrap()
}

fn set_cu_limit_ix(limit: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&limit.to_le_bytes());
    Instruction {
        program_id: Address::from_str(COMPUTE_BUDGET_ID).unwrap(),
        accounts: vec![],
        data,
    }
}

/// `SystemInstruction::CreateAccount { lamports, space, owner }` = tag 0 (u32 LE).
fn ix_create_account(from: &Address, new: &Address, lamports: u64, space: u64, owner: &Address) -> Instruction {
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: system_program(),
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*new, true)],
        data,
    }
}

fn ix_init_proof_buffer_v3(buffer: &Address, authority: &Address, proof_size: u32, circuit_id: u8) -> Instruction {
    let mut data = anchor_disc("init_proof_buffer_v3").to_vec();
    data.extend_from_slice(&proof_size.to_le_bytes());
    data.push(circuit_id);
    Instruction {
        program_id: program(),
        accounts: vec![AccountMeta::new(*buffer, false), AccountMeta::new_readonly(*authority, true)],
        data,
    }
}

fn ix_reset_proof_buffer(buffer: &Address, authority: &Address, proof_size: u32, circuit_id: u8) -> Instruction {
    let mut data = anchor_disc("reset_proof_buffer").to_vec();
    data.extend_from_slice(&proof_size.to_le_bytes());
    data.push(circuit_id);
    Instruction {
        program_id: program(),
        accounts: vec![AccountMeta::new(*buffer, false), AccountMeta::new_readonly(*authority, true)],
        data,
    }
}

fn ix_init_proof_buffer(buffer: &Address, authority: &Address, proof_size: u32, circuit_id: u8) -> Instruction {
    let mut data = anchor_disc("init_proof_buffer").to_vec();
    data.extend_from_slice(&proof_size.to_le_bytes());
    data.push(circuit_id);
    Instruction {
        program_id: program(),
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(system_program(), false),
        ],
        data,
    }
}

fn ix_resize_proof_buffer(buffer: &Address, authority: &Address) -> Instruction {
    Instruction {
        program_id: program(),
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(system_program(), false),
        ],
        data: anchor_disc("resize_proof_buffer").to_vec(),
    }
}

fn ix_write_chunk(buffer: &Address, authority: &Address, offset: u32, chunk: &[u8]) -> Instruction {
    let mut data = anchor_disc("write_proof_chunk").to_vec();
    data.extend_from_slice(&offset.to_le_bytes());
    data.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
    data.extend_from_slice(chunk);
    Instruction {
        program_id: program(),
        accounts: vec![AccountMeta::new(*buffer, false), AccountMeta::new_readonly(*authority, true)],
        data,
    }
}

fn ix_with_public_inputs(buffer: &Address, authority: &Address, name: &str, public_inputs: &[u64]) -> Instruction {
    let mut data = anchor_disc(name).to_vec();
    data.extend_from_slice(&(public_inputs.len() as u32).to_le_bytes());
    for v in public_inputs {
        data.extend_from_slice(&v.to_le_bytes());
    }
    Instruction {
        program_id: program(),
        accounts: vec![AccountMeta::new(*buffer, false), AccountMeta::new_readonly(*authority, true)],
        data,
    }
}

fn ix_close_proof_buffer(buffer: &Address, authority: &Address) -> Instruction {
    Instruction {
        program_id: program(),
        accounts: vec![AccountMeta::new(*buffer, false), AccountMeta::new(*authority, true)],
        data: anchor_disc("close_proof_buffer").to_vec(),
    }
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

struct Rig {
    svm: LiteSVM,
    payer: Keypair,
}

type Sent = std::result::Result<(u64, Vec<String>), (TransactionError, Vec<String>)>;

impl Rig {
    fn new() -> Self {
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let so = verifier_so_path();
        let bytes = std::fs::read(&so).unwrap_or_else(|e| panic!("{}: {}", so.display(), e));
        svm.add_program(program(), &bytes).expect("load verifier");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000_000).expect("airdrop");
        eprintln!(
            "[l2_presized_buffers] verifier .so {} ({} bytes, sha256 {})",
            so.display(),
            bytes.len(),
            &sha256_hex(&bytes)[..16]
        );
        Rig { svm, payer }
    }

    fn payer_pk(&self) -> Address {
        self.payer.pubkey()
    }

    /// One transaction: compute budget + the given instructions, signed by
    /// the payer plus any extra keypairs. Returns the program's CU and logs.
    fn send(&mut self, ixs: &[Instruction], extra_signers: &[&Keypair]) -> Sent {
        let mut all = vec![set_cu_limit_ix(MAX_CU_PER_TX)];
        all.extend_from_slice(ixs);
        let payer_pk = self.payer_pk();
        let msg = Message::new(&all, Some(&payer_pk));
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra_signers);
        let tx = Transaction::new(&signers, msg, self.svm.latest_blockhash());
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok((meta.compute_units_consumed, meta.logs)),
            Err(f) => Err((f.err, f.meta.logs)),
        }
    }

    fn must(&mut self, ixs: &[Instruction], extra_signers: &[&Keypair], what: &str) -> (u64, Vec<String>) {
        match self.send(ixs, extra_signers) {
            Ok(v) => v,
            Err((e, logs)) => panic!("{} failed: {:?}\nlogs: {:#?}", what, e, tail(&logs, 10)),
        }
    }

    fn data(&self, buffer: &Address) -> Vec<u8> {
        self.svm.get_account(buffer).expect("buffer account exists").data
    }

    fn rent_for(&self, space: usize) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(space)
    }

    /// `create_account` + `init_proof_buffer_v3` in ONE transaction. Returns
    /// the buffer address.
    fn create_v3(&mut self, proof_size: usize, circuit_id: u8) -> (Keypair, Address) {
        let kp = Keypair::new();
        let addr = kp.pubkey();
        let space = PROOF_DATA_OFFSET + proof_size;
        let lamports = self.rent_for(space);
        let payer = self.payer_pk();
        let ixs = [
            ix_create_account(&payer, &addr, lamports, space as u64, &program()),
            ix_init_proof_buffer_v3(&addr, &payer, proof_size as u32, circuit_id),
        ];
        self.must(&ixs, &[&kp], "create_account + init_proof_buffer_v3");
        (kp, addr)
    }

    /// Upload every chunk, one transaction each, and return the count.
    fn upload(&mut self, buffer: &Address, proof: &[u8]) -> usize {
        let payer = self.payer_pk();
        let mut n = 0;
        let mut off = 0;
        while off < proof.len() {
            let end = (off + CHUNK).min(proof.len());
            self.must(
                &[ix_write_chunk(buffer, &payer, off as u32, &proof[off..end])],
                &[],
                &format!("write_proof_chunk @{}", off),
            );
            n += 1;
            off = end;
        }
        n
    }
}

fn tail(v: &[String], n: usize) -> Vec<String> {
    v[v.len().saturating_sub(n)..].to_vec()
}

fn custom_code(err: &TransactionError) -> Option<u32> {
    match err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

fn expect_custom(sent: Sent, code: u32, what: &str) -> Vec<String> {
    match sent {
        Ok((cu, logs)) => panic!(
            "{} was ACCEPTED ({} CU) but must be refused with custom error {}\nlogs: {:#?}",
            what,
            cu,
            code,
            tail(&logs, 8)
        ),
        Err((e, logs)) => {
            assert_eq!(
                custom_code(&e),
                Some(code),
                "{}: expected custom error {}, got {:?}\nlogs: {:#?}",
                what,
                code,
                e,
                tail(&logs, 8)
            );
            logs
        }
    }
}

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

/// Two honest circuit-7 proofs over DIFFERENT witnesses. The mask is a
/// deterministic xorshift, as in `cu_budget.rs`: reproducibility over
/// blinding, which is right for a harness and wrong for production.
fn c7_proofs() -> &'static (p01_stark::compact::GenericCompactProofData, p01_stark::compact::GenericCompactProofData) {
    static PROOFS: std::sync::OnceLock<(
        p01_stark::compact::GenericCompactProofData,
        p01_stark::compact::GenericCompactProofData,
    )> = std::sync::OnceLock::new();
    PROOFS.get_or_init(|| {
        use p01_stark::air::spend::{CANONICAL_DEPTH, MASK_LEN};
        const GOLDILOCKS: u64 = 0xFFFF_FFFF_0000_0001;
        let pe: Vec<u64> = (0..CANONICAL_DEPTH as u64).map(|i| 1000 + i * 37).collect();
        let pi: Vec<u8> = (0..CANONICAL_DEPTH).map(|i| (i % 2) as u8).collect();
        let mask = |seed: u64| {
            let mut st = seed;
            let mut m = Vec::with_capacity(MASK_LEN);
            for _ in 0..MASK_LEN {
                st ^= st >> 12;
                st ^= st << 25;
                st ^= st >> 27;
                m.push(st.wrapping_mul(0x2545_F491_4F6C_DD1D) % GOLDILOCKS);
            }
            m
        };
        let t = std::time::Instant::now();
        let a = p01_stark::compact::generate_spend_compact_proof(
            42, 999, 7, 555, &pe, &pi, &[11, 22, 33, 44], &mask(0x9E37_79B9_7F4A_7C15),
        );
        let b = p01_stark::compact::generate_spend_compact_proof(
            43, 1001, 7, 555, &pe, &pi, &[55, 66, 77, 88], &mask(0x1234_5678_9ABC_DEF1),
        );
        eprintln!(
            "[l2_presized_buffers] two C7 proofs in {} ms: {} and {} bytes",
            t.elapsed().as_millis(),
            a.proof_bytes.len(),
            b.proof_bytes.len()
        );
        assert_eq!(a.circuit_id, 7);
        assert_eq!(b.circuit_id, 7);
        assert_ne!(a.public_inputs[0], b.public_inputs[0], "the two proofs must name different nullifiers");
        (a, b)
    })
}

fn assert_flags(data: &[u8], verified: bool, deep_ali: bool, what: &str) {
    assert_eq!(data[OFF_VERIFIED], verified as u8, "{}: verified flag", what);
    assert_eq!(data[OFF_DEEP_ALI], deep_ali as u8, "{}: deep_ali_verified flag", what);
}

fn u32_at(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(data[off..off + 4].try_into().unwrap())
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

/// The headline: one transaction allocates AND initialises an 80 KB buffer,
/// and a real circuit-7 proof then verifies through it, both phases.
#[test]
fn one_transaction_replaces_init_and_eight_resizes() {
    let (p, _) = c7_proofs();
    let mut rig = Rig::new();
    let payer = rig.payer_pk();
    let proof_size = p.proof_bytes.len();

    let (_kp, buf) = rig.create_v3(proof_size, 7);

    let data = rig.data(&buf);
    assert_eq!(data.len(), PROOF_DATA_OFFSET + proof_size, "allocated at full size in one transaction");
    assert_eq!(&data[OFF_AUTHORITY..OFF_AUTHORITY + 32], payer.as_ref(), "authority is the signer");
    assert_eq!(data[OFF_CIRCUIT_ID], 7);
    assert_eq!(u32_at(&data, OFF_PROOF_SIZE) as usize, proof_size);
    assert_eq!(u32_at(&data, OFF_BYTES_WRITTEN), 0);
    assert_flags(&data, false, false, "fresh v3 buffer");
    // Anchor wrote the real discriminator on exit: consumers key on it.
    let disc = solana_sha256_hasher::hashv(&[b"account:ProofBuffer"]).to_bytes();
    assert_eq!(&data[..8], &disc[..8], "ProofBuffer discriminator");

    let chunks = rig.upload(&buf, &p.proof_bytes);
    let old_resizes = (PROOF_DATA_OFFSET + proof_size).saturating_sub(MAX_REALLOC_STEP).div_ceil(MAX_REALLOC_STEP);
    eprintln!(
        "[l2_presized_buffers] {} chunk txs; allocation cost 1 tx (was 1 init + {} resizes)",
        chunks, old_resizes
    );
    assert!(old_resizes >= 7, "an 80 KB proof must have needed several resizes for this to matter");

    let (cu1, _) = rig.must(
        &[ix_with_public_inputs(&buf, &payer, "verify_stark_proof_v2", &p.public_inputs)],
        &[],
        "verify_stark_proof_v2 through a v3 buffer",
    );
    assert_flags(&rig.data(&buf), true, false, "after phase 1");
    let (cu2, _) = rig.must(
        &[ix_with_public_inputs(&buf, &payer, "verify_deep_ali_phase2", &p.public_inputs)],
        &[],
        "verify_deep_ali_phase2 through a v3 buffer",
    );
    let data = rig.data(&buf);
    assert_flags(&data, true, true, "after phase 2");
    let expected_hash = {
        let mut bytes = Vec::with_capacity(p.public_inputs.len() * 8);
        for v in &p.public_inputs {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        solana_sha256_hasher::hashv(&[&bytes]).to_bytes()
    };
    assert_eq!(&data[OFF_HASH..OFF_HASH + 32], &expected_hash, "public-inputs hash consumers compare");
    eprintln!("[l2_presized_buffers] C7 phase 1 {} CU, phase 2 {} CU (transaction totals)", cu1, cu2);

    // Close a keypair-owned buffer: rent comes back, account is gone.
    let before = rig.svm.get_balance(&payer).unwrap();
    let rent = rig.rent_for(PROOF_DATA_OFFSET + proof_size);
    rig.must(&[ix_close_proof_buffer(&buf, &payer)], &[], "close_proof_buffer on a v3 buffer");
    assert!(rig.svm.get_account(&buf).map(|a| a.data.is_empty() && a.lamports == 0).unwrap_or(true), "buffer closed");
    let after = rig.svm.get_balance(&payer).unwrap();
    assert!(after > before + rent - 10_000, "rent returned to the authority (before {}, after {}, rent {})", before, after, rent);
}

/// §L3 of the plan rests on this: phase 1 + phase 2 in ONE transaction.
#[test]
fn both_verification_phases_land_in_one_transaction() {
    let (p, _) = c7_proofs();
    let mut rig = Rig::new();
    let payer = rig.payer_pk();
    let (_kp, buf) = rig.create_v3(p.proof_bytes.len(), 7);
    rig.upload(&buf, &p.proof_bytes);

    let (cu, _) = rig.must(
        &[
            ix_with_public_inputs(&buf, &payer, "verify_stark_proof_v2", &p.public_inputs),
            ix_with_public_inputs(&buf, &payer, "verify_deep_ali_phase2", &p.public_inputs),
        ],
        &[],
        "phase 1 + phase 2 in one transaction",
    );
    assert_flags(&rig.data(&buf), true, true, "one-transaction verification");
    eprintln!("[l2_presized_buffers] C7 phase 1 + phase 2 in one tx: {} CU of {}", cu, MAX_CU_PER_TX);
    assert!(cu < MAX_CU_PER_TX as u64, "must fit the per-transaction cap");
}

/// A live buffer is rearmed for a second, different proof: the flags and the
/// hash are cleared in one instruction, the new proof verifies, and its hash
/// replaces the old one. Also exercised on a v1 PDA buffer (init + resizes),
/// the shape a long-lived wallet already holds.
#[test]
fn reset_rearms_a_buffer_for_a_second_proof() {
    let (a, b) = c7_proofs();
    let mut rig = Rig::new();
    let payer = rig.payer_pk();
    let size = a.proof_bytes.len().max(b.proof_bytes.len());

    // --- v3 keypair buffer -------------------------------------------------
    let (_kp, buf) = rig.create_v3(size, 7);
    rig.upload(&buf, &a.proof_bytes);
    rig.must(&[ix_with_public_inputs(&buf, &payer, "verify_stark_proof_v2", &a.public_inputs)], &[], "phase 1 (a)");
    rig.must(&[ix_with_public_inputs(&buf, &payer, "verify_deep_ali_phase2", &a.public_inputs)], &[], "phase 2 (a)");
    let hash_a = rig.data(&buf)[OFF_HASH..OFF_HASH + 32].to_vec();
    assert_ne!(hash_a, vec![0u8; 32]);

    // A verified buffer refuses new chunks until it is reset.
    expect_custom(
        rig.send(&[ix_write_chunk(&buf, &payer, 0, &b.proof_bytes[..CHUNK])], &[]),
        ERR_ALREADY_VERIFIED,
        "write_proof_chunk on a verified buffer",
    );

    rig.must(&[ix_reset_proof_buffer(&buf, &payer, b.proof_bytes.len() as u32, 7)], &[], "reset_proof_buffer");
    let data = rig.data(&buf);
    assert_flags(&data, false, false, "after reset");
    assert_eq!(&data[OFF_HASH..OFF_HASH + 32], &[0u8; 32], "hash cleared by reset");
    assert_eq!(u32_at(&data, OFF_BYTES_WRITTEN), 0, "bytes_written cleared by reset");
    assert_eq!(u32_at(&data, OFF_PROOF_SIZE) as usize, b.proof_bytes.len());
    assert_eq!(data.len(), PROOF_DATA_OFFSET + size, "reset does not reallocate");

    // Consumers see `verified == false`: phase 2 is refused until phase 1
    // has run again on the NEW bytes.
    expect_custom(
        rig.send(&[ix_with_public_inputs(&buf, &payer, "verify_deep_ali_phase2", &a.public_inputs)], &[]),
        ERR_NOT_YET_VERIFIED,
        "phase 2 right after a reset",
    );

    rig.upload(&buf, &b.proof_bytes);
    // Old public inputs against the new bytes must be refused (the transcript
    // is bound to them), the new ones accepted.
    let refused = rig.send(&[ix_with_public_inputs(&buf, &payer, "verify_stark_proof_v2", &a.public_inputs)], &[]);
    assert!(refused.is_err(), "proof b must not verify under proof a's public inputs");
    rig.must(&[ix_with_public_inputs(&buf, &payer, "verify_stark_proof_v2", &b.public_inputs)], &[], "phase 1 (b)");
    rig.must(&[ix_with_public_inputs(&buf, &payer, "verify_deep_ali_phase2", &b.public_inputs)], &[], "phase 2 (b)");
    let data = rig.data(&buf);
    assert_flags(&data, true, true, "second proof verified in the same buffer");
    assert_ne!(&data[OFF_HASH..OFF_HASH + 32], &hash_a[..], "the hash now names proof b's inputs");

    // --- v1 PDA buffer (init + resizes), then reset ------------------------
    let (pda, _) = Address::find_program_address(&[b"stark_proof", payer.as_ref(), &[7u8]], &program());
    rig.must(&[ix_init_proof_buffer(&pda, &payer, size as u32, 7)], &[], "init_proof_buffer (v1)");
    let target = PROOF_DATA_OFFSET + size;
    let mut resizes = 0;
    while rig.data(&pda).len() < target {
        rig.must(&[ix_resize_proof_buffer(&pda, &payer)], &[], "resize_proof_buffer");
        resizes += 1;
        assert!(resizes < 20, "resize loop did not converge");
    }
    eprintln!("[l2_presized_buffers] v1 PDA needed {} resizes; a v3 buffer needs 0", resizes);
    rig.upload(&pda, &a.proof_bytes);
    rig.must(&[ix_with_public_inputs(&pda, &payer, "verify_stark_proof_v2", &a.public_inputs)], &[], "phase 1 (pda)");
    rig.must(&[ix_with_public_inputs(&pda, &payer, "verify_deep_ali_phase2", &a.public_inputs)], &[], "phase 2 (pda)");
    rig.must(&[ix_reset_proof_buffer(&pda, &payer, b.proof_bytes.len() as u32, 7)], &[], "reset on a v1 PDA");
    assert_flags(&rig.data(&pda), false, false, "pda after reset");
    rig.upload(&pda, &b.proof_bytes);
    rig.must(&[ix_with_public_inputs(&pda, &payer, "verify_stark_proof_v2", &b.public_inputs)], &[], "phase 1 (pda, b)");
    rig.must(&[ix_with_public_inputs(&pda, &payer, "verify_deep_ali_phase2", &b.public_inputs)], &[], "phase 2 (pda, b)");
    assert_flags(&rig.data(&pda), true, true, "pda reused for a second proof");
}

/// Everything the two instructions must refuse.
#[test]
fn refusals_fail_closed() {
    let (a, _) = c7_proofs();
    let mut rig = Rig::new();
    let payer = rig.payer_pk();
    let size = a.proof_bytes.len();

    // init v3: undersized allocation.
    {
        let kp = Keypair::new();
        let addr = kp.pubkey();
        let space = PROOF_DATA_OFFSET + size - 1;
        let lamports = rig.rent_for(space);
        let logs = expect_custom(
            rig.send(
                &[
                    ix_create_account(&payer, &addr, lamports, space as u64, &program()),
                    ix_init_proof_buffer_v3(&addr, &payer, size as u32, 7),
                ],
                &[&kp],
            ),
            ERR_BUFFER_TOO_SMALL,
            "init_proof_buffer_v3 on an account one byte short",
        );
        assert!(logs.iter().any(|l| l.contains("BufferTooSmall")), "named error in the log: {:#?}", tail(&logs, 6));
    }

    // init v3: unsupported circuit.
    {
        let kp = Keypair::new();
        let addr = kp.pubkey();
        let space = PROOF_DATA_OFFSET + size;
        let lamports = rig.rent_for(space);
        expect_custom(
            rig.send(
                &[
                    ix_create_account(&payer, &addr, lamports, space as u64, &program()),
                    ix_init_proof_buffer_v3(&addr, &payer, size as u32, 200),
                ],
                &[&kp],
            ),
            ERR_UNSUPPORTED_CIRCUIT,
            "init_proof_buffer_v3 with circuit 200",
        );
    }

    // init v3: account not owned by the verifier (created under the system program).
    {
        let kp = Keypair::new();
        let addr = kp.pubkey();
        let space = PROOF_DATA_OFFSET + size;
        let lamports = rig.rent_for(space);
        let r = rig.send(
            &[
                ix_create_account(&payer, &addr, lamports, space as u64, &system_program()),
                ix_init_proof_buffer_v3(&addr, &payer, size as u32, 7),
            ],
            &[&kp],
        );
        let (e, logs) = r.expect_err("a system-owned account must be refused");
        assert!(
            logs.iter().any(|l| l.contains("AccountOwnedByWrongProgram")),
            "expected AccountOwnedByWrongProgram, got {:?}\n{:#?}",
            e,
            tail(&logs, 6)
        );
    }

    // init v3 twice: the live buffer's discriminator is set, `zero` refuses.
    let (_kp, buf) = rig.create_v3(size, 7);
    {
        let r = rig.send(&[ix_init_proof_buffer_v3(&buf, &payer, size as u32, 7)], &[]);
        let (e, logs) = r.expect_err("re-initialising a live buffer must be refused");
        assert!(
            logs.iter().any(|l| l.contains("ConstraintZero")),
            "expected ConstraintZero, got {:?}\n{:#?}",
            e,
            tail(&logs, 6)
        );
    }

    // write past the declared proof_size on a v3 buffer: same bound as v1.
    expect_custom(
        rig.send(&[ix_write_chunk(&buf, &payer, (size - 10) as u32, &[0u8; 20])], &[]),
        ERR_CHUNK_OUT_OF_BOUNDS,
        "write_proof_chunk past proof_size",
    );

    // reset: not the authority.
    let stranger = Keypair::new();
    rig.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    {
        let mut ix = ix_reset_proof_buffer(&buf, &stranger.pubkey(), size as u32, 7);
        ix.accounts[1] = AccountMeta::new_readonly(stranger.pubkey(), true);
        let logs = expect_custom(rig.send(&[ix], &[&stranger]), ERR_CONSTRAINT_HAS_ONE, "reset by a stranger");
        assert!(logs.iter().any(|l| l.contains("ConstraintHasOne")), "named constraint in the log: {:#?}", tail(&logs, 6));
    }

    // reset: growing past the allocation.
    expect_custom(
        rig.send(&[ix_reset_proof_buffer(&buf, &payer, (size + 1) as u32, 7)], &[]),
        ERR_BUFFER_TOO_SMALL,
        "reset to a proof_size larger than the account",
    );

    // reset: unsupported circuit (the u8::MAX sentinel is the one exception).
    expect_custom(
        rig.send(&[ix_reset_proof_buffer(&buf, &payer, size as u32, 200)], &[]),
        ERR_UNSUPPORTED_CIRCUIT,
        "reset to circuit 200",
    );
    rig.must(&[ix_reset_proof_buffer(&buf, &payer, size as u32, u8::MAX)], &[], "reset to the verify_uniform sentinel");
    assert_eq!(rig.data(&buf)[OFF_CIRCUIT_ID], u8::MAX);

    // Shrinking is allowed: a smaller proof in the same allocation.
    rig.must(&[ix_reset_proof_buffer(&buf, &payer, (size / 2) as u32, 6)], &[], "reset to a smaller proof");
    let data = rig.data(&buf);
    assert_eq!(u32_at(&data, OFF_PROOF_SIZE) as usize, size / 2);
    assert_eq!(data.len(), PROOF_DATA_OFFSET + size, "no reallocation on shrink");
}

/// The wire format the three TypeScript builders pin
/// (`proofBufferV3.ts` in web, extension, mobile).
#[test]
fn discriminators_and_layouts_for_the_client_builders() {
    let v3 = anchor_disc("init_proof_buffer_v3");
    let reset = anchor_disc("reset_proof_buffer");
    eprintln!(
        "init_proof_buffer_v3 = {:?}\nreset_proof_buffer   = {:?}",
        v3, reset
    );
    // Both carry `proof_size: u32 LE` then `circuit_id: u8` after the 8-byte
    // discriminator: 13 bytes of data.
    let ix = ix_init_proof_buffer_v3(&Address::new_from_array([9u8; 32]), &Address::new_from_array([9u8; 32]), 79_405, 7);
    assert_eq!(ix.data.len(), 13);
    assert_eq!(&ix.data[..8], &v3);
    assert_eq!(&ix.data[8..12], &79_405u32.to_le_bytes());
    assert_eq!(ix.data[12], 7);
    assert_eq!(ix.accounts.len(), 2);
    assert!(ix.accounts[0].is_writable && !ix.accounts[0].is_signer);
    assert!(!ix.accounts[1].is_writable && ix.accounts[1].is_signer);
    let ix = ix_reset_proof_buffer(&Address::new_from_array([9u8; 32]), &Address::new_from_array([9u8; 32]), 1, 6);
    assert_eq!(ix.data.len(), 13);
    assert_eq!(&ix.data[..8], &reset);
    assert_eq!(ix.accounts.len(), 2);
}
