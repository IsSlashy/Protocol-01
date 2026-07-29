//! Local compute-unit measurement harness — `C7_SPEND_CIRCUIT_PLAN.md` Step 0.
//!
//! # Why this file exists
//!
//! Before this harness there was **no local CU measurement anywhere in the
//! repo**, so every compute-unit figure in `docs/` was read off a devnet
//! transaction log or extrapolated from a three-point fit. That made the one
//! number that gates the entire C7 design — the cost of its phase-2 DEEP-ALI
//! instruction — unknowable without first building the AIR.
//!
//! `litesvm` runs the real SBF bytecode in an in-process VM, so
//! `compute_units_consumed` here is the same counter the validator increments.
//! No validator, no devnet, no SOL spent.
//!
//! # It must never pass without measuring
//!
//! An earlier revision of this file returned early — a green test — whenever
//! the `.so` under test was missing. A green run therefore proved nothing.
//! Every entry point below now **panics** with a build command when it cannot
//! measure, and each individual table cell carries an explicit status:
//!
//! ```text
//!   MEASURED     a real compute_units_consumed from the SBF VM
//!   FAILED       the instruction ran and errored — the number is real but the
//!                proof did not verify, so the row is not a valid budget
//!   N/A          structurally absent (e.g. C0 has no phase-2 instruction)
//! ```
//!
//! There is no state in which this test prints a number it did not measure.
//!
//! # What it measures
//!
//! 1. Real phase-1 and phase-2 CU for **all seven circuits C0..C6**, against
//!    proofs generated on the spot by the in-repo prover (`p01-stark` is a
//!    dev-dependency). There are **no committed proof fixtures in this
//!    repository** — searched for `*.bin` / `*proof*.json` / `*fixture*` and
//!    found only unrelated circom artefacts — so generating them is the only
//!    option, and it is also the more honest one: the numbers track the
//!    current prover.
//! 2. The `verify_uniform` probe-order path (mobile / padded envelope).
//! 3. The **C7 phase-2 shape probe** from the throwaway SBF program in
//!    `tests/c7_probe/`.
//!
//! # Phase shapes, and why C0 has no phase 2
//!
//! * C0 (`subscriber_ownership`) runs the legacy single-instruction path
//!   `verify_stark_proof(commitment: u64)` (`lib.rs:107-167`, dispatch at
//!   `:131`), which parses `CompactStarkProof`, not `GenericCompactProof`.
//!   Its DEEP-ALI check runs *inside* phase 1. `verify_deep_ali_phase2`
//!   explicitly rejects circuit 0 (`lib.rs:259-262`). So C0's phase-2 cell is
//!   `N/A`, not an unmeasured blank.
//! * C1..C6 run `verify_stark_proof_v2` then `verify_deep_ali_phase2`.
//!
//! # The gate (`C7_SPEND_CIRCUIT_PLAN.md:71`)
//!
//! ```text
//!   <= 900K CU        proceed
//!   900K .. 1.2M CU   proceed, but freeze the constraint count
//!   >  1.2M CU        stop and redesign before spending 40 h on an AIR
//! ```
//!
//! # Running it
//!
//! ```text
//! # 1. The verifier .so under test.
//! cargo-build-sbf --manifest-path programs/p01_stark_verifier/Cargo.toml
//!
//! # 2. The C7 probe program (only `cu_budget_c7_phase2_probe` needs it):
//! cargo-build-sbf --manifest-path programs/p01_stark_verifier/tests/c7_probe/Cargo.toml \
//!                 --sbf-out-dir programs/p01_stark_verifier/tests/c7_probe/out
//!
//! # 3. The harness. --release is not optional: the STARK prover generates
//! #    eleven proofs here and is orders of magnitude slower unoptimised.
//! #    --test-threads=1 only keeps the tables from interleaving.
//! cargo test --release -p p01_stark_verifier --test cu_budget \
//!     -- --nocapture --test-threads=1
//! ```
//!
//! Override the binaries with `P01_VERIFIER_SO` / `P01_C7_PROBE_SO` if needed.
//!
//! ## If `cargo-build-sbf` dies with `Failed to install platform-tools`
//!
//! On this Windows box the `cargo-build-sbf` first on `PATH` is agave 2.2.14
//! (`~/.local/share/solana/install/active_release/bin` and `~/.cargo/bin`,
//! both platform-tools v1.47). Its 2.2.14 SDK directory
//! `…/releases/2.2.14/solana-release/bin/platform-tools-sdk/sbf/dependencies/platform-tools`
//! is a **real directory**, not a symlink, so `install_if_missing` sees an
//! invalid link, tries to create one on top of it, and aborts with
//! `os error 183` (ERROR_ALREADY_EXISTS). Nothing is wrong with the crate.
//!
//! The 3.1.9 install — the version `Anchor.toml:3` pins — already has that
//! path as a proper symlink into `~/.cache/solana/v1.52/platform-tools`, so
//! invoke it by absolute path:
//!
//! ```text
//! ~/.local/share/solana/install/releases/3.1.9/solana-release/bin/cargo-build-sbf.exe \
//!     --manifest-path programs/p01_stark_verifier/Cargo.toml
//! ```
//!
//! Both `.so` artifacts measured here were produced that way.
//!
//! # Reading the numbers honestly
//!
//! * Every figure printed here is measured, or labelled FAILED / N/A.
//! * The harness prints the size and SHA-256 of the `.so` it loaded. A CU
//!   number is a property of a binary, not of a source tree.
//! * litesvm executes the same SBF program with the same compute-budget
//!   accounting as the validator, but the surrounding transaction (account
//!   loading, fee payer) is simulated. The per-instruction
//!   `Program … consumed N of M compute units` line this harness parses is
//!   the program's own consumption and is the number to compare against the
//!   1.4M per-instruction cap.

use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

use std::path::{Path, PathBuf};
use std::str::FromStr;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// `programs/p01_stark_verifier/src/lib.rs:36`.
const VERIFIER_ID: &str = "DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs";

/// Arbitrary id for the throwaway probe. Never deployed, so it is built from
/// raw bytes rather than a base58 literal.
fn probe_program_id() -> Address {
    let mut b = [7u8; 32];
    b[0] = 0xC7;
    Address::new_from_array(b)
}

/// `ComputeBudget111111111111111111111111111111`.
const COMPUTE_BUDGET_ID: &str = "ComputeBudget111111111111111111111111111111";

/// `11111111111111111111111111111111`.
const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";

/// The per-instruction ceiling every one of these numbers is judged against.
const MAX_CU_PER_IX: u64 = 1_400_000;

/// `apps/web/lib/privacy/pool/stark.ts:41` uses 1000; 900 leaves headroom for
/// the 3-account message inside the 1232-byte packet limit.
const CHUNK: usize = 900;

/// `programs/p01_stark_verifier/src/lib.rs:556`.
const PROOF_DATA_OFFSET: usize = 83;
/// `programs/p01_stark_verifier/src/lib.rs:558-560`.
const MAX_REALLOC_STEP: usize = 10_240;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/programs/p01_stark_verifier
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("manifest dir has two ancestors")
        .to_path_buf()
}

fn verifier_so_path() -> PathBuf {
    match std::env::var("P01_VERIFIER_SO") {
        Ok(p) => PathBuf::from(p),
        Err(_) => repo_root().join("target/deploy/p01_stark_verifier.so"),
    }
}

fn probe_so_path() -> PathBuf {
    match std::env::var("P01_C7_PROBE_SO") {
        Ok(p) => PathBuf::from(p),
        Err(_) => Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/c7_probe/out/c7_phase2_probe.so"),
    }
}

/// Warn loudly if the `.so` under test predates the crate sources.
///
/// A CU number is a property of a binary, not of a source tree. This harness
/// deliberately defaults to `target/deploy/p01_stark_verifier.so` because that
/// is the artifact that matches devnet — but if someone edits `verify.rs` and
/// re-runs without rebuilding, the table below describes the OLD code. Say so
/// rather than silently reporting a stale number.
fn staleness_note(so: &Path) -> Option<String> {
    let so_mtime = std::fs::metadata(so).ok()?.modified().ok()?;
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut newest: Option<(std::time::SystemTime, String)> = None;
    for entry in std::fs::read_dir(&src).ok()? {
        let entry = entry.ok()?;
        let m = entry.metadata().ok()?.modified().ok()?;
        if newest.as_ref().map(|(t, _)| m > *t).unwrap_or(true) {
            newest = Some((m, entry.file_name().to_string_lossy().into_owned()));
        }
    }
    let (t, name) = newest?;
    if t > so_mtime {
        Some(format!(
            "src/{} is NEWER than the .so under test — the numbers below describe the\n\
             OLD binary. Rebuild with `cargo-build-sbf --manifest-path \
             programs/p01_stark_verifier/Cargo.toml`\n\
             if you want the current source measured, or keep this artifact if you want\n\
             the deployed one.",
            name
        ))
    } else {
        None
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let h = solana_sha256_hasher::hashv(&[bytes]).to_bytes();
    h.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Anchor's instruction discriminator: `sha256("global:<name>")[..8]`.
fn anchor_disc(name: &str) -> [u8; 8] {
    let preimage = format!("global:{}", name);
    let h = solana_sha256_hasher::hashv(&[preimage.as_bytes()]).to_bytes();
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

/// `ComputeBudgetInstruction::SetComputeUnitLimit` = variant tag 2 + u32 LE.
fn set_cu_limit_ix(limit: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&limit.to_le_bytes());
    Instruction {
        program_id: Address::from_str(COMPUTE_BUDGET_ID).unwrap(),
        accounts: vec![],
        data,
    }
}

/// Extract the program's own CU consumption from the transaction log.
///
/// The runtime emits `Program <id> consumed <n> of <m> compute units` once per
/// invocation. Anything else in the log (compute-budget instructions, the
/// system program) belongs to a different program id and is ignored, so this
/// isolates the instruction under test from transaction overhead without
/// needing a baseline subtraction.
fn program_cu(logs: &[String], program_id: &Address) -> Option<u64> {
    let needle = format!("Program {} consumed ", program_id);
    for line in logs {
        if let Some(rest) = line.strip_prefix(&needle) {
            if let Some(n) = rest.split_whitespace().next() {
                if let Ok(v) = n.parse::<u64>() {
                    return Some(v);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// The bench rig
// ---------------------------------------------------------------------------

struct Rig {
    svm: LiteSVM,
    payer: Keypair,
    payer_pk: Address,
}

/// Outcome of one measured instruction.
///
/// Deliberately a three-state enum. The previous `{ cu, ok, err }` struct could
/// not distinguish "this instruction does not exist for this circuit" from
/// "this instruction cost 0 CU", and a blank cell in a budget table is how a
/// missing measurement gets mistaken for a cheap one.
enum Measured {
    /// A real `compute_units_consumed` from the SBF VM.
    Ok(u64),
    /// The instruction executed and consumed `cu`, then returned an error. The
    /// CU figure is real but does not describe a successful verification.
    Failed { cu: u64, err: String },
    /// Structurally absent — no instruction exists to measure.
    NotApplicable(&'static str),
}

impl Measured {
    fn cu_if_ok(&self) -> Option<u64> {
        match self {
            Measured::Ok(cu) => Some(*cu),
            _ => None,
        }
    }
    fn is_ok(&self) -> bool {
        matches!(self, Measured::Ok(_))
    }
    /// A row is acceptable if it measured cleanly or is structurally absent.
    fn is_acceptable(&self) -> bool {
        !matches!(self, Measured::Failed { .. })
    }
    fn status(&self) -> &'static str {
        match self {
            Measured::Ok(_) => "MEASURED",
            Measured::Failed { .. } => "FAILED",
            Measured::NotApplicable(_) => "N/A",
        }
    }
}

impl Rig {
    fn new() -> Self {
        // `with_transaction_history(0)` disables litesvm's duplicate-signature
        // check (`litesvm-0.15.1/src/lib.rs:1615-1620`). The harness sends
        // byte-identical instructions repeatedly — e.g. `resize_proof_buffer`
        // has no arguments at all — under one blockhash, which the default
        // history would reject as `AlreadyProcessed`. Nothing about compute
        // accounting depends on it.
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let payer = Keypair::new();
        let payer_pk = payer.pubkey();
        svm.airdrop(&payer_pk, 1_000_000_000_000)
            .expect("airdrop must succeed");
        Rig { svm, payer, payer_pk }
    }

    fn load_program(&mut self, id: &Address, path: &Path) -> Result<(usize, String), String> {
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        let digest = sha256_hex(&bytes);
        let len = bytes.len();
        self.svm
            .add_program(*id, &bytes)
            .map_err(|e| format!("add_program failed: {:?}", e))?;
        Ok((len, digest))
    }

    /// Send exactly one program instruction, preceded by a compute-budget
    /// instruction so the ceiling is the real 1.4M rather than the 200K
    /// default. Returns the program's own CU consumption.
    fn run(&mut self, ix: Instruction, program_id: &Address) -> Measured {
        let msg = Message::new(
            &[set_cu_limit_ix(MAX_CU_PER_IX as u32), ix],
            Some(&self.payer_pk),
        );
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        match self.svm.send_transaction(tx) {
            Ok(meta) => {
                // If the runtime did not emit the `consumed` line for this
                // program id, we are reading transaction-level CU for a
                // different program. Refuse to report it as the instruction's
                // cost.
                match program_cu(&meta.logs, program_id) {
                    Some(cu) => Measured::Ok(cu),
                    None => Measured::Failed {
                        cu: meta.compute_units_consumed,
                        err: format!(
                            "no `Program {} consumed …` line in the log; refusing to \
                             attribute the transaction total to this instruction. logs: {:?}",
                            program_id,
                            tail(&meta.logs, 6)
                        ),
                    },
                }
            }
            Err(f) => Measured::Failed {
                cu: program_cu(&f.meta.logs, program_id).unwrap_or(f.meta.compute_units_consumed),
                err: format!("{:?} | last logs: {:?}", f.err, tail(&f.meta.logs, 4)),
            },
        }
    }

    /// Fire-and-check helper for the many uninteresting setup transactions.
    fn must(&mut self, ix: Instruction, what: &str) {
        let msg = Message::new(
            &[set_cu_limit_ix(MAX_CU_PER_IX as u32), ix],
            Some(&self.payer_pk),
        );
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        if let Err(f) = self.svm.send_transaction(tx) {
            panic!("{} failed: {:?}\nlogs: {:?}", what, f.err, tail(&f.meta.logs, 8));
        }
    }
}

fn tail(v: &[String], n: usize) -> Vec<String> {
    let start = v.len().saturating_sub(n);
    v[start..].to_vec()
}

// ---------------------------------------------------------------------------
// Loud failure instead of a silent green
// ---------------------------------------------------------------------------

/// Load the verifier `.so` or abort the test with a build command.
///
/// This is the whole point of the rewrite: a missing binary is a broken
/// measurement, and a broken measurement must not report success. There is no
/// environment variable that turns this into a skip — an opt-out would just
/// reintroduce the silent green through a different door.
fn load_verifier_or_fail(rig: &mut Rig, program: &Address) -> (PathBuf, usize, String) {
    let so = verifier_so_path();
    match rig.load_program(program, &so) {
        Ok((len, hash)) => (so, len, hash),
        Err(e) => panic!(
            "\n\
             ============================================================\n\
             CANNOT MEASURE — the verifier .so is not loadable.\n\
             ============================================================\n\
             path  : {}\n\
             error : {}\n\n\
             This test measures compute units by executing real SBF\n\
             bytecode. Without the binary there is nothing to measure, so\n\
             it fails rather than passing with an empty table.\n\n\
             Build it:\n  \
             cargo-build-sbf --manifest-path programs/p01_stark_verifier/Cargo.toml\n\n\
             Or point at an existing artifact:\n  \
             P01_VERIFIER_SO=/path/to/p01_stark_verifier.so cargo test ...\n\
             ============================================================\n",
            so.display(),
            e
        ),
    }
}

// ---------------------------------------------------------------------------
// Instruction builders for the verifier program
// ---------------------------------------------------------------------------

fn ix_init_proof_buffer(
    program: &Address,
    buffer: &Address,
    authority: &Address,
    proof_size: u32,
    circuit_id: u8,
) -> Instruction {
    let mut data = anchor_disc("init_proof_buffer").to_vec();
    data.extend_from_slice(&proof_size.to_le_bytes());
    data.push(circuit_id);
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(Address::from_str(SYSTEM_PROGRAM_ID).unwrap(), false),
        ],
        data,
    }
}

fn ix_init_proof_buffer_v2(
    program: &Address,
    buffer: &Address,
    authority: &Address,
    proof_size: u32,
    nonce: &[u8; 16],
) -> Instruction {
    let mut data = anchor_disc("init_proof_buffer_v2").to_vec();
    data.extend_from_slice(&proof_size.to_le_bytes());
    data.extend_from_slice(nonce);
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(Address::from_str(SYSTEM_PROGRAM_ID).unwrap(), false),
        ],
        data,
    }
}

fn ix_resize_proof_buffer(program: &Address, buffer: &Address, authority: &Address) -> Instruction {
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(Address::from_str(SYSTEM_PROGRAM_ID).unwrap(), false),
        ],
        data: anchor_disc("resize_proof_buffer").to_vec(),
    }
}

fn ix_write_chunk(
    program: &Address,
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
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

fn ix_with_public_inputs(
    program: &Address,
    buffer: &Address,
    authority: &Address,
    name: &str,
    public_inputs: &[u64],
) -> Instruction {
    let mut data = anchor_disc(name).to_vec();
    data.extend_from_slice(&(public_inputs.len() as u32).to_le_bytes());
    for v in public_inputs {
        data.extend_from_slice(&v.to_le_bytes());
    }
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// C0's legacy single-instruction path: `verify_stark_proof(commitment: u64)`
/// (`lib.rs:107`). Takes a bare u64, not a `Vec<u64>`.
fn ix_verify_stark_proof_legacy(
    program: &Address,
    buffer: &Address,
    authority: &Address,
    commitment: u64,
) -> Instruction {
    let mut data = anchor_disc("verify_stark_proof").to_vec();
    data.extend_from_slice(&commitment.to_le_bytes());
    Instruction {
        program_id: *program,
        accounts: vec![
            AccountMeta::new(*buffer, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

// ---------------------------------------------------------------------------
// Per-circuit measurement
// ---------------------------------------------------------------------------

/// Which phase-1 entry point a circuit uses, and whether phase 2 exists.
enum Shape {
    /// C1..C6: `verify_stark_proof_v2` + `verify_deep_ali_phase2`.
    TwoPhase,
    /// C0: `verify_stark_proof(commitment)`, DEEP-ALI folded into phase 1.
    LegacySinglePhase { commitment: u64 },
}

/// A proof to measure, normalised across the two prover return types
/// (`CompactProofData` for C0, `GenericCompactProofData` for C1..C6).
struct ProofCase {
    circuit_id: u8,
    label: &'static str,
    proof_bytes: Vec<u8>,
    public_inputs: Vec<u64>,
    shape: Shape,
    prove_ms: u128,
}

struct CircuitRow {
    circuit_id: u8,
    label: &'static str,
    proof_bytes: usize,
    num_chunks: usize,
    init_cu: Measured,
    chunk_cu: Measured,
    phase1: Measured,
    phase2: Measured,
    prove_ms: u128,
}

fn measure_circuit(rig: &mut Rig, program: &Address, case: ProofCase) -> CircuitRow {
    let ProofCase {
        circuit_id,
        label,
        proof_bytes,
        public_inputs,
        shape,
        prove_ms,
    } = case;

    let authority = rig.payer_pk;
    let (buffer, _bump) = Address::find_program_address(
        &[b"stark_proof", authority.as_ref(), &[circuit_id]],
        program,
    );

    let proof_size = proof_bytes.len();

    // --- init ---------------------------------------------------------------
    let init = rig.run(
        ix_init_proof_buffer(program, &buffer, &authority, proof_size as u32, circuit_id),
        program,
    );
    if let Measured::Failed { err, .. } = &init {
        panic!(
            "circuit {} init_proof_buffer failed — cannot measure this circuit at all: {}",
            circuit_id, err
        );
    }

    // --- grow to full size --------------------------------------------------
    let target_len = PROOF_DATA_OFFSET + proof_size;
    let mut guard = 0;
    while rig
        .svm
        .get_account(&buffer)
        .map(|a| a.data.len())
        .unwrap_or(0)
        < target_len
    {
        rig.must(
            ix_resize_proof_buffer(program, &buffer, &authority),
            "resize_proof_buffer",
        );
        guard += 1;
        assert!(
            guard < (target_len / MAX_REALLOC_STEP) + 8,
            "resize loop did not converge for circuit {}",
            circuit_id
        );
    }

    // --- upload -------------------------------------------------------------
    let mut chunk_cu = Measured::NotApplicable("proof fits in zero chunks");
    let mut num_chunks = 0usize;
    let mut offset = 0usize;
    while offset < proof_size {
        let end = (offset + CHUNK).min(proof_size);
        let m = rig.run(
            ix_write_chunk(
                program,
                &buffer,
                &authority,
                offset as u32,
                &proof_bytes[offset..end],
            ),
            program,
        );
        if let Measured::Failed { err, .. } = &m {
            panic!(
                "circuit {} write_proof_chunk @{} failed — the proof never reached \
                 the buffer, so any phase-1 number would be meaningless: {}",
                circuit_id, offset, err
            );
        }
        if num_chunks == 0 {
            chunk_cu = m;
        }
        num_chunks += 1;
        offset = end;
    }

    // --- phase 1 ------------------------------------------------------------
    let phase1 = match &shape {
        Shape::TwoPhase => rig.run(
            ix_with_public_inputs(
                program,
                &buffer,
                &authority,
                "verify_stark_proof_v2",
                &public_inputs,
            ),
            program,
        ),
        Shape::LegacySinglePhase { commitment } => rig.run(
            ix_verify_stark_proof_legacy(program, &buffer, &authority, *commitment),
            program,
        ),
    };

    // --- phase 2 ------------------------------------------------------------
    let phase2 = match &shape {
        // `verify_deep_ali_phase2` requires circuit_id in 1..=6 (lib.rs:259-262);
        // C0's DEEP-ALI is inside phase 1 (lib.rs:253-257). Not a gap in the
        // measurement — a structural absence.
        Shape::LegacySinglePhase { .. } => {
            Measured::NotApplicable("C0 has no phase-2 ix; DEEP-ALI is inside phase 1")
        }
        Shape::TwoPhase => {
            if phase1.is_ok() {
                rig.run(
                    ix_with_public_inputs(
                        program,
                        &buffer,
                        &authority,
                        "verify_deep_ali_phase2",
                        &public_inputs,
                    ),
                    program,
                )
            } else {
                Measured::Failed {
                    cu: 0,
                    err: "not attempted: phase 1 did not succeed, and \
                          verify_deep_ali_phase2 requires buffer.verified"
                        .into(),
                }
            }
        }
    };

    CircuitRow {
        circuit_id,
        label,
        proof_bytes: proof_size,
        num_chunks,
        init_cu: init,
        chunk_cu,
        phase1,
        phase2,
        prove_ms,
    }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

fn cu_cell(m: &Measured) -> String {
    match m {
        Measured::Ok(cu) => thousands(*cu),
        Measured::Failed { cu, .. } => format!("FAILED@{}", thousands(*cu)),
        Measured::NotApplicable(_) => "n/a".into(),
    }
}

fn thousands(v: u64) -> String {
    let s = v.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn headroom(cu: u64) -> String {
    if cu >= MAX_CU_PER_IX {
        format!("OVER by {}", thousands(cu - MAX_CU_PER_IX))
    } else {
        thousands(MAX_CU_PER_IX - cu)
    }
}

fn rule(n: usize) -> String {
    "-".repeat(n)
}

// ---------------------------------------------------------------------------
// The proof set — one generator call per circuit, C0..C6
// ---------------------------------------------------------------------------

/// Time a prover call. Prover time is a *client-side* cost (phone / browser),
/// entirely unrelated to the on-chain CU numbers; it is reported separately so
/// the two are never confused.
fn timed<T>(f: impl FnOnce() -> T) -> (T, u128) {
    let t = std::time::Instant::now();
    let v = f();
    (v, t.elapsed().as_millis())
}

fn generic_case(
    circuit_id: u8,
    label: &'static str,
    p: p01_stark::compact::GenericCompactProofData,
    prove_ms: u128,
) -> ProofCase {
    assert_eq!(
        p.circuit_id, circuit_id,
        "prover returned circuit_id {} for the {} row — the table would be mislabelled",
        p.circuit_id, label
    );
    ProofCase {
        circuit_id,
        label,
        proof_bytes: p.proof_bytes,
        public_inputs: p.public_inputs,
        shape: Shape::TwoPhase,
        prove_ms,
    }
}

/// All seven circuits, with the argument sets already used by the in-crate
/// positive tests so the proofs are known-honest.
fn all_cases() -> Vec<ProofCase> {
    let mut cases = Vec::new();

    // --- C0 subscriber_ownership --------------------------------------------
    // Args from `verify.rs:4890` (`c0_tampered_ood_current_rejected` uses 42).
    let (p0, ms) = timed(|| p01_stark::compact::generate_compact_proof(42));
    cases.push(ProofCase {
        circuit_id: 0,
        label: "C0 subscriber_ownership",
        public_inputs: vec![p0.commitment],
        shape: Shape::LegacySinglePhase { commitment: p0.commitment },
        proof_bytes: p0.proof_bytes,
        prove_ms: ms,
    });

    // --- C1 pool_commitment -------------------------------------------------
    // Args from `verify.rs::pool_commitment_verify_generic_accepts_honest_proof`.
    let (p1, ms) = timed(|| p01_stark::compact::generate_pool_commitment_proof(42, 17, 7, 11));
    cases.push(generic_case(1, "C1 pool_commitment", p1, ms));

    // --- C2 balance_proof ---------------------------------------------------
    // Args from `verify.rs:4165`
    // (`balance_proof_verify_generic_accepts_honest_proof`).
    let (p2, ms) = timed(|| p01_stark::compact::generate_balance_compact_proof(42, 1000, 777, 999));
    cases.push(generic_case(2, "C2 balance_proof", p2, ms));

    // --- C3 merkle_path -----------------------------------------------------
    // Args from `verify.rs::c3_sample_proof` (canonical depth 15).
    let path_elements: Vec<u64> = (0..15u64).map(|i| 1000 + i).collect();
    let path_indices: Vec<u8> = (0..15u8).map(|i| i % 2).collect();
    let (p3, ms) = timed(|| {
        p01_stark::compact::generate_merkle_path_compact_proof(777, &path_elements, &path_indices)
    });
    cases.push(generic_case(3, "C3 merkle_path", p3, ms));

    // --- C4 confidential_balance --------------------------------------------
    // Args from `verify.rs::c4_sample_proof` (verify.rs:4455).
    let (p4, ms) = timed(|| {
        p01_stark::compact::generate_confidential_balance_compact_proof(
            42, 1000, 111, 800, 222, 200, 333, 999,
        )
    });
    cases.push(generic_case(4, "C4 confidential_balance", p4, ms));

    // --- C5 transfer --------------------------------------------------------
    // Args from `verify.rs::transfer_verify_deep_ali_accepts_honest_proof`
    // (value-conserving: 150+65 - 77-88 = 50 = public_amount).
    let (p5, ms) = timed(|| {
        p01_stark::compact::generate_transfer_compact_proof(
            13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50,
        )
    });
    cases.push(generic_case(5, "C5 transfer", p5, ms));

    // --- C6 merkle_update ---------------------------------------------------
    // Args from `verify.rs::merkle_update_depth15_verify_generic`.
    let pe: Vec<u64> = (0..15).map(|i| 100u64 + i * 13).collect();
    let pi: Vec<u8> = (0..15).map(|i| (i % 2) as u8).collect();
    let (p6, ms) =
        timed(|| p01_stark::compact::generate_merkle_update_compact_proof(111, 222, &pe, &pi));
    cases.push(generic_case(6, "C6 merkle_update", p6, ms));

    cases
}

// ---------------------------------------------------------------------------
// The three inferred figures this harness exists to check
// ---------------------------------------------------------------------------

/// Devnet-log inferences quoted in `docs/C7_SPEND_CIRCUIT_PLAN.md`. They are
/// printed next to the measurement and never asserted: a devnet log carries
/// whatever binary was deployed that day, which need not be the `.so` on disk.
/// A large delta is a finding about the doc, not a failure of the harness.
const INFERRED: [(u8, &str, u64, &str); 3] = [
    (6, "phase 1", 1_316_491, "devnet log, quoted C7_SPEND_CIRCUIT_PLAN.md:18"),
    (3, "phase 2", 766_988, "devnet log inference"),
    (5, "phase 2", 274_239, "devnet log inference"),
];

fn print_inferred_comparison(rows: &[CircuitRow]) {
    println!("\n{}", rule(104));
    println!("MEASURED vs INFERRED  (the inferred column is a devnet-log reading, NOT a measurement)");
    println!("{}", rule(104));
    println!(
        "{:<10} {:<9} {:>13} {:>13} {:>13}   {}",
        "circuit", "phase", "inferred CU", "measured CU", "delta", "source of the inferred number"
    );
    println!("{}", rule(104));
    for (cid, phase, inferred, src) in INFERRED.iter() {
        let row = rows.iter().find(|r| r.circuit_id == *cid);
        let measured = row.and_then(|r| {
            if *phase == "phase 1" {
                r.phase1.cu_if_ok()
            } else {
                r.phase2.cu_if_ok()
            }
        });
        match measured {
            Some(m) => {
                let delta = m as i64 - *inferred as i64;
                println!(
                    "{:<10} {:<9} {:>13} {:>13} {:>13}   {}",
                    format!("C{}", cid),
                    phase,
                    thousands(*inferred),
                    thousands(m),
                    format!(
                        "{}{} ({:+.1}%)",
                        if delta >= 0 { "+" } else { "-" },
                        thousands(delta.unsigned_abs()),
                        100.0 * delta as f64 / *inferred as f64
                    ),
                    src
                );
            }
            None => println!(
                "{:<10} {:<9} {:>13} {:>13} {:>13}   {}",
                format!("C{}", cid),
                phase,
                thousands(*inferred),
                "NOT MEASURED",
                "-",
                src
            ),
        }
    }
    println!("{}", rule(104));
}

// ---------------------------------------------------------------------------
// TEST 1 — real per-circuit CU, C0..C6
// ---------------------------------------------------------------------------

#[test]
fn cu_budget_real_circuits() {
    let mut rig = Rig::new();
    let program = Address::from_str(VERIFIER_ID).unwrap();
    let (so, so_len, so_hash) = load_verifier_or_fail(&mut rig, &program);

    println!("\n{}", rule(104));
    println!("P01 STARK VERIFIER — MEASURED COMPUTE UNITS (litesvm, in-process SBF VM)");
    println!("{}", rule(104));
    println!("binary   : {}", so.display());
    println!("size     : {} bytes", thousands(so_len as u64));
    println!("sha256   : {}", so_hash);
    println!("program  : {}", VERIFIER_ID);
    println!("cap      : {} CU per instruction", thousands(MAX_CU_PER_IX));
    if let Some(note) = staleness_note(&so) {
        println!("\n!! STALE-BINARY WARNING\n!! {}", note.replace('\n', "\n!! "));
    }

    let cases = all_cases();
    let mut rows: Vec<CircuitRow> = Vec::new();
    for case in cases {
        rows.push(measure_circuit(&mut rig, &program, case));
    }

    // --- table --------------------------------------------------------------
    println!("\n{}", rule(104));
    println!(
        "{:<26} {:>8} {:>7} {:>13} {:>10} {:>13} {:>10} {:>12}",
        "circuit", "proof B", "chunks", "phase 1 CU", "status", "phase 2 CU", "status", "ph1 headroom"
    );
    println!("{}", rule(104));
    for r in &rows {
        println!(
            "{:<26} {:>8} {:>7} {:>13} {:>10} {:>13} {:>10} {:>12}",
            format!("{} (id {})", r.label, r.circuit_id),
            thousands(r.proof_bytes as u64),
            r.num_chunks,
            cu_cell(&r.phase1),
            r.phase1.status(),
            cu_cell(&r.phase2),
            r.phase2.status(),
            match r.phase1.cu_if_ok() {
                Some(cu) => headroom(cu),
                None => "-".into(),
            },
        );
    }
    println!("{}", rule(104));
    println!("legend  MEASURED = real compute_units_consumed from the SBF VM");
    println!("        FAILED@n = the instruction ran, consumed n CU, then errored");
    println!("        n/a      = no such instruction for this circuit (see note below)");

    // --- combined per-withdrawal / per-proof total --------------------------
    println!("\n{}", rule(104));
    println!(
        "{:<26} {:>13} {:>13} {:>13}",
        "circuit", "phase1+phase2", "vs 1.4M x2", "single-ix?"
    );
    println!("{}", rule(104));
    for r in &rows {
        match (r.phase1.cu_if_ok(), r.phase2.cu_if_ok()) {
            (Some(a), Some(b)) => println!(
                "{:<26} {:>13} {:>13} {:>13}",
                format!("{} (id {})", r.label, r.circuit_id),
                thousands(a + b),
                if a + b <= MAX_CU_PER_IX { "fits in 1 ix" } else { "needs 2 ix" },
                if a + b <= MAX_CU_PER_IX { "YES" } else { "no" }
            ),
            (Some(a), None) if matches!(r.phase2, Measured::NotApplicable(_)) => println!(
                "{:<26} {:>13} {:>13} {:>13}",
                format!("{} (id {})", r.label, r.circuit_id),
                thousands(a),
                "single-phase",
                "YES"
            ),
            _ => println!(
                "{:<26} {:>13} {:>13} {:>13}",
                format!("{} (id {})", r.label, r.circuit_id),
                "incomplete",
                "-",
                "-"
            ),
        }
    }
    println!("{}", rule(104));

    // --- setup + prover -----------------------------------------------------
    println!("\n{}", rule(104));
    println!(
        "{:<26} {:>13} {:>13} {:>14}",
        "(setup + prover)", "init CU", "1st chunk CU", "prover ms*"
    );
    println!("{}", rule(104));
    for r in &rows {
        println!(
            "{:<26} {:>13} {:>13} {:>14}",
            format!("{} (id {})", r.label, r.circuit_id),
            cu_cell(&r.init_cu),
            cu_cell(&r.chunk_cu),
            r.prove_ms
        );
    }
    println!("{}", rule(104));
    println!(
        "* prover ms is CLIENT-side (this x86 host, --release), not on-chain. It is\n  \
         the phone/browser latency axis and has nothing to do with the CU cap.\n\
         init CU varies run to run: `init_proof_buffer`'s PDA bump search costs\n  \
         ~1,500 CU per rejected bump and the authority is a fresh random key."
    );

    // --- notes on the n/a cells --------------------------------------------
    for r in &rows {
        if let Measured::NotApplicable(why) = &r.phase2 {
            println!("note  C{} phase 2 = n/a: {}", r.circuit_id, why);
        }
        if let Measured::Failed { err, .. } = &r.phase1 {
            println!("!! C{} phase 1 did NOT succeed: {}", r.circuit_id, err);
        }
        if let Measured::Failed { err, .. } = &r.phase2 {
            println!("!! C{} phase 2 did NOT succeed: {}", r.circuit_id, err);
        }
    }

    print_inferred_comparison(&rows);

    // A phase that fails outright means the numbers above are not what they
    // claim to be, and that must not pass silently.
    let bad: Vec<String> = rows
        .iter()
        .filter(|r| !r.phase1.is_acceptable() || !r.phase2.is_acceptable())
        .map(|r| format!("C{} ({})", r.circuit_id, r.label))
        .collect();
    assert!(
        bad.is_empty(),
        "these circuits did not verify against {} — the CU table above is incomplete: {}",
        so.display(),
        bad.join(", ")
    );
    assert_eq!(rows.len(), 7, "expected one row per circuit C0..C6");
}

// ---------------------------------------------------------------------------
// TEST 2 — `verify_uniform`, the mobile / uniform-padding phase-1 path
// ---------------------------------------------------------------------------

/// `verify_uniform` (`lib.rs:384-449`) probes `PROBE_ORDER = [1, 6, 3, 5]` and
/// runs `verify_generic` against the first config that parses. Its cost is
/// therefore phase 1 **plus** the failed parses ahead of the match — which is
/// exactly the quantity `C7_SPEND_CIRCUIT_PLAN.md:168` needs when deciding
/// whether circuit 7 joins the probe order.
fn measure_uniform(
    rig: &mut Rig,
    program: &Address,
    nonce_byte: u8,
    proof: &p01_stark::compact::GenericCompactProofData,
) -> (Measured, Measured) {
    let authority = rig.payer_pk;
    let nonce = [nonce_byte; 16];
    let (buffer, _bump) =
        Address::find_program_address(&[b"stark_proof_v2", authority.as_ref(), &nonce], program);
    let proof_size = proof.proof_bytes.len();

    rig.must(
        ix_init_proof_buffer_v2(program, &buffer, &authority, proof_size as u32, &nonce),
        "init_proof_buffer_v2",
    );

    let target_len = PROOF_DATA_OFFSET + proof_size;
    while rig.svm.get_account(&buffer).map(|a| a.data.len()).unwrap_or(0) < target_len {
        rig.must(
            ix_resize_proof_buffer(program, &buffer, &authority),
            "resize_proof_buffer (v2)",
        );
    }

    let mut offset = 0usize;
    while offset < proof_size {
        let end = (offset + CHUNK).min(proof_size);
        rig.must(
            ix_write_chunk(
                program,
                &buffer,
                &authority,
                offset as u32,
                &proof.proof_bytes[offset..end],
            ),
            "write_proof_chunk (v2)",
        );
        offset = end;
    }

    let uniform = rig.run(
        ix_with_public_inputs(
            program,
            &buffer,
            &authority,
            "verify_uniform",
            &proof.public_inputs,
        ),
        program,
    );
    let phase2 = if uniform.is_ok() {
        rig.run(
            ix_with_public_inputs(
                program,
                &buffer,
                &authority,
                "verify_deep_ali_phase2",
                &proof.public_inputs,
            ),
            program,
        )
    } else {
        Measured::Failed {
            cu: 0,
            err: "not attempted: verify_uniform did not succeed".into(),
        }
    };
    (uniform, phase2)
}

#[test]
fn cu_budget_verify_uniform_path() {
    let mut rig = Rig::new();
    let program = Address::from_str(VERIFIER_ID).unwrap();
    let (so, so_len, so_hash) = load_verifier_or_fail(&mut rig, &program);

    let path_elements: Vec<u64> = (0..15u64).map(|i| 1000 + i).collect();
    let path_indices: Vec<u8> = (0..15u8).map(|i| i % 2).collect();
    let pe: Vec<u64> = (0..15).map(|i| 100u64 + i * 13).collect();
    let pi: Vec<u8> = (0..15).map(|i| (i % 2) as u8).collect();

    // Only the four circuits in PROBE_ORDER can go through this path.
    let cases: Vec<(&str, u8, p01_stark::compact::GenericCompactProofData)> = vec![
        ("C1 pool_commitment", 1, p01_stark::compact::generate_pool_commitment_proof(42, 17, 7, 11)),
        (
            "C3 merkle_path",
            3,
            p01_stark::compact::generate_merkle_path_compact_proof(777, &path_elements, &path_indices),
        ),
        (
            "C5 transfer",
            5,
            p01_stark::compact::generate_transfer_compact_proof(
                13, 500, 77, 400, 88, 100, 150, 1234, 555, 65, 2222, 333, 50,
            ),
        ),
        (
            "C6 merkle_update",
            6,
            p01_stark::compact::generate_merkle_update_compact_proof(111, 222, &pe, &pi),
        ),
    ];

    println!("\n{}", rule(104));
    println!("verify_uniform PATH (PROBE_ORDER = [1, 6, 3, 5], lib.rs:413)");
    println!("{}", rule(104));
    println!("binary   : {}  ({} bytes, sha256 {})", so.display(), thousands(so_len as u64), &so_hash[..16]);
    println!(
        "{:<26} {:>13} {:>10} {:>13} {:>10} {:>13}",
        "circuit", "uniform CU", "status", "phase 2 CU", "status", "vs 1.4M cap"
    );
    println!("{}", rule(104));

    let mut failures: Vec<String> = Vec::new();
    for (label, nonce_byte, proof) in &cases {
        let (u, p2) = measure_uniform(&mut rig, &program, *nonce_byte, proof);
        println!(
            "{:<26} {:>13} {:>10} {:>13} {:>10} {:>13}",
            label,
            cu_cell(&u),
            u.status(),
            cu_cell(&p2),
            p2.status(),
            match u.cu_if_ok() {
                Some(cu) => headroom(cu),
                None => "-".into(),
            }
        );
        if let Measured::Failed { err, .. } = &u {
            println!("   !! {}", err);
            failures.push(format!("{} verify_uniform", label));
        }
        if let Measured::Failed { err, .. } = &p2 {
            println!("   !! {}", err);
            failures.push(format!("{} phase 2", label));
        }
    }
    println!("{}", rule(104));
    assert!(
        failures.is_empty(),
        "verify_uniform path measurement is incomplete: {}",
        failures.join(", ")
    );
}

// ---------------------------------------------------------------------------
// TEST 3 — the C7 phase-2 shape probe
// ---------------------------------------------------------------------------

const V_BASELINE: u8 = 0;
const V_C7_FULL: u8 = 1;
const V_STRIDE16_X5: u8 = 2;
const V_DENSE_X1: u8 = 3;
const V_LAGRANGE_BLOCK: u8 = 4;
const V_CONSTRAINTS_18: u8 = 5;
const V_BOUNDARY_FOLD_6: u8 = 6;
const V_ZT_AND_INV: u8 = 7;
const V_ONE_INV: u8 = 8;
const V_C7_FULL_PLUS_TRANSCRIPT: u8 = 9;

fn probe_ix(program: &Address, variant: u8, seed: u64) -> Instruction {
    let mut data = vec![variant];
    data.extend_from_slice(&seed.to_le_bytes());
    Instruction {
        program_id: *program,
        accounts: vec![], // zero accounts: the probe's input parse depends on it
        data,
    }
}

#[test]
fn cu_budget_c7_phase2_probe() {
    let so = probe_so_path();
    let mut rig = Rig::new();
    let program = probe_program_id();

    let (so_len, so_hash) = match rig.load_program(&program, &so) {
        Ok(v) => v,
        Err(e) => panic!(
            "\n\
             ============================================================\n\
             CANNOT MEASURE — the C7 probe .so is not loadable.\n\
             ============================================================\n\
             path  : {}\n\
             error : {}\n\n\
             The probe artifact is gitignored on purpose (it is a\n\
             throwaway program), but a missing binary means this test\n\
             measured nothing, so it fails rather than passing silently.\n\n\
             Build it:\n  \
             cargo-build-sbf \\\n    \
               --manifest-path programs/p01_stark_verifier/tests/c7_probe/Cargo.toml \\\n    \
               --sbf-out-dir programs/p01_stark_verifier/tests/c7_probe/out\n\
             ============================================================\n",
            so.display(),
            e
        ),
    };

    // A fixed non-trivial seed. It is read at run time, so nothing the probe
    // computes can be constant-folded away at compile time.
    const SEED: u64 = 0x0123_4567_89AB_CDEF;

    let variants: [(u8, &str); 10] = [
        (V_BASELINE, "baseline (entry + parse + log)"),
        (V_ONE_INV, "1x Felt::inv()  [Fermat exp]"),
        (V_STRIDE16_X5, "5x eval_periodic_stride16_at_z"),
        (V_DENSE_X1, "1x eval_periodic_at_z  [dense 512]"),
        (V_LAGRANGE_BLOCK, "batch_inverse(5) + 5x Lagrange"),
        (V_CONSTRAINTS_18, "18 constraints + RLC  [6x pow7]"),
        (V_BOUNDARY_FOLD_6, "boundary_fold_at_ood x6"),
        (V_ZT_AND_INV, "Z_T(z) + final inverse"),
        (V_C7_FULL, "** C7 PHASE-2 FULL SHAPE **"),
        (V_C7_FULL_PLUS_TRANSCRIPT, "** C7 FULL + 2x FS transcript **"),
    ];

    println!("\n{}", rule(104));
    println!("C7 PHASE-2 DEEP-ALI — COMPUTE-UNIT SHAPE PROBE");
    println!("{}", rule(104));
    println!("binary   : {}", so.display());
    println!("size     : {} bytes", thousands(so_len as u64));
    println!("sha256   : {}", so_hash);
    println!("seed     : 0x{:016X} (read from instruction data at run time)", SEED);
    println!("\nNOTE: this program is NOT the C7 verifier. It reproduces the arithmetic");
    println!("      SHAPE of the proposed phase-2 check using the REAL Felt arithmetic");
    println!("      and REAL 512-coefficient periodic tables, with verbatim copies of");
    println!("      the private helpers in verify.rs. See tests/c7_probe/src/lib.rs for");
    println!("      the itemised list of what it over- and under-counts.");

    let mut baseline = 0u64;
    let mut results: Vec<(u8, &str, Measured)> = Vec::new();
    for (v, label) in variants.iter() {
        let m = rig.run(probe_ix(&program, *v, SEED), &program);
        if *v == V_BASELINE {
            baseline = m.cu_if_ok().unwrap_or(0);
        }
        results.push((*v, label, m));
    }

    println!("\n{}", rule(104));
    println!(
        "{:<40} {:>13} {:>15} {:>11}",
        "variant", "total CU", "minus baseline", "status"
    );
    println!("{}", rule(104));
    for (_v, label, m) in &results {
        let net = match m.cu_if_ok() {
            Some(cu) if cu >= baseline => thousands(cu - baseline),
            _ => "-".into(),
        };
        println!(
            "{:<40} {:>13} {:>15} {:>11}",
            label,
            cu_cell(m),
            net,
            m.status()
        );
    }
    println!("{}", rule(104));

    let mut probe_failures: Vec<&str> = Vec::new();
    for (_v, label, m) in &results {
        if let Measured::Failed { err, .. } = m {
            println!("!! {} -> {}", label, err);
            probe_failures.push(label);
        }
    }

    let full_cu = results
        .iter()
        .find(|(v, _, _)| *v == V_C7_FULL)
        .and_then(|(_, _, m)| m.cu_if_ok());
    let full_tx_cu = results
        .iter()
        .find(|(v, _, _)| *v == V_C7_FULL_PLUS_TRANSCRIPT)
        .and_then(|(_, _, m)| m.cu_if_ok());

    let cu = match full_cu {
        Some(cu) => cu,
        None => panic!(
            "the C7 full-shape probe did not execute — there is no measurement to gate on. \
             Failed variants: {:?}",
            probe_failures
        ),
    };
    let cu_tx = full_tx_cu.unwrap_or(cu);

    println!("\n{}", rule(104));
    println!("GATE  (C7_SPEND_CIRCUIT_PLAN.md:71)");
    println!("{}", rule(104));
    println!("measured C7 phase-2 shape        : {:>13} CU", thousands(cu));
    println!(
        "  + Fiat-Shamir transcript       : {:>13} CU{}",
        thousands(cu_tx),
        if full_tx_cu.is_none() { "   (NOT MEASURED — variant failed)" } else { "" }
    );
    println!("headroom vs 1.4M per-ix cap      : {:>13} CU", headroom(cu_tx));
    let verdict = if cu_tx <= 900_000 {
        "PROCEED  (<= 900K)"
    } else if cu_tx <= 1_200_000 {
        "PROCEED BUT FREEZE THE CONSTRAINT COUNT  (900K - 1.2M)"
    } else {
        "STOP AND REDESIGN  (> 1.2M)"
    };
    println!("verdict                          : {}", verdict);
    println!("{}", rule(104));

    // The plan's single largest open question after this measurement is
    // "whether the all-16-cycles trick actually makes every C7 periodic column
    // stride-16 or one-hot eligible" (C7_SPEND_CIRCUIT_PLAN.md:273, :327), with
    // an *estimated* +110K CU per column that falls back to dense Horner.
    // Both terms below are measured, so the worst case is measured too: swap
    // all five stride-16 evaluations for five dense ones.
    let cu_of = |v: u8| -> Option<u64> {
        results
            .iter()
            .find(|(x, _, _)| *x == v)
            .and_then(|(_, _, m)| m.cu_if_ok())
    };
    if let (Some(base), Some(s16x5), Some(dense1)) =
        (cu_of(V_BASELINE), cu_of(V_STRIDE16_X5), cu_of(V_DENSE_X1))
    {
        let s16_net = s16x5 - base;
        let dense_net = dense1 - base;
        let worst = cu + 5 * dense_net - s16_net;
        println!("WORST CASE  (all-16-cycles trick fails, every periodic column dense)");
        println!("{}", rule(104));
        println!("measured cost of one dense 512-coeff column : {:>13} CU", thousands(dense_net));
        println!("  (the plan estimates ~110,000 CU for this)");
        println!("C7 phase 2 with 5 dense instead of 5 stride : {:>13} CU", thousands(worst));
        println!(
            "verdict in that worst case                  : {}",
            if worst <= 900_000 {
                "STILL PROCEED (<= 900K)"
            } else if worst <= 1_200_000 {
                "PROCEED BUT FREEZE CONSTRAINT COUNT"
            } else {
                "REDESIGN"
            }
        );
        println!("{}", rule(104));
    } else {
        println!("WORST CASE  : NOT MEASURED — one of baseline / stride16x5 / dense1 failed.");
    }

    println!(
        "Reminder: this prices the SHAPE, not the circuit. The plan's own\n\
         caveat stands — only the real `verify_deep_ali_circuit_7` measured\n\
         on-chain settles it. Re-run this harness against the real function\n\
         at Step 6 and compare."
    );

    assert!(
        probe_failures.is_empty(),
        "probe variants failed, so the breakdown above has holes: {:?}",
        probe_failures
    );
}
