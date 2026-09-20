//! Compute-unit micro-benchmarks on litesvm (WP0f, protocol v2 groundwork,
//! 2026-09-19).
//!
//! # Why this file exists
//!
//! DESIGN-V2 §2.2 prices the v2 verifier from a fit over the eight `cu_budget`
//! pins plus three primitives that had never been measured on SBF: a Goldilocks
//! multiply, a cubic-extension multiply and a SHA-256 Merkle node. The one
//! per-multiply figure in the tree, "~216 CU/mul" in the inv_gen comment of
//! `src/verify.rs`, had no measurement behind it, and DESIGN-V2 guessed ~45.
//! This harness measures all three, plus the Merkle path walk and `Felt::inv`,
//! and pins the per-multiply prose in `verify.rs` to the measurement.
//!
//! # How
//!
//! `tests/cu_microbench_probe/` is a throwaway SBF program that runs one
//! primitive n times on operands read from instruction data, with the
//! verifier's own `goldilocks.rs` and `merkle.rs` included by `#[path]`. The
//! cost of one operation is the SLOPE of the program's `consumed … compute
//! units` line against n, so the entry, the parse and the return-data syscall
//! cancel out.
//!
//! # It must never pass without measuring
//!
//! * The probe `.so` is built by this harness with the `cargo-build-sbf` that
//!   `Anchor.toml` pins, cached on a fingerprint of its sources, the verifier
//!   sources it includes, `.cargo/config.toml` and the compiler identity. Or it
//!   is supplied with `P01_CU_MICROBENCH_SO` (the sbf-litesvm build stage does
//!   that), and then provenance is the caller's claim.
//! * A probe that cannot be loaded panics with `add_program failed`. There is
//!   no skip path.
//! * Every value the program returns is compared with an independent reference
//!   (u128 `%` arithmetic, host `sha2`), so a chain that was optimised away,
//!   shortened, or computed wrongly fails here.
//! * Every cost is read over three chain lengths: the two partial slopes must
//!   agree, and a repeated run must reproduce its CU exactly.
//! * Each per-operation cost is pinned two-sided (`PIN_TOLERANCE`). A cheaper
//!   primitive is good news, but it also means the numbers a CU model was built
//!   from have moved, so both directions go red.
//!
//! # Regime (what the numbers are a property of)
//!
//! litesvm 0.15.1 executes the real SBF bytecode with the validator's compute
//! meter: one CU per executed instruction plus the syscall charges of
//! solana-program-runtime 4.1.2 (`sol_sha256`: 85 + Σ max(10, len/2) per call;
//! `sol_set_return_data`: 100 + len/250). The bytecode is what cargo-build-sbf
//! 3.1.9 / platform-tools v1.52 emits for sbpf v0 (ELF `e_flags` 0, the same as
//! the verifier's) with the workspace release profile, overflow checks
//! included. sbpf v0 has no 64×64→128 multiply, so every `Felt::mul` calls
//! `__multi3`; an sbpf version with a high-multiply instruction, another
//! compiler or another profile gives other numbers. The host machine does not
//! enter: CU counts instructions, not time.
//!
//! # Running it
//!
//! ```text
//! cargo test --release -p p01_stark_verifier --test cu_microbench \
//!     -- --nocapture --test-threads=1
//! ```
//!
//! The first run builds the probe (about a second after the platform tools are
//! installed). `P01_CARGO_BUILD_SBF` overrides the build tool, and
//! `P01_CU_MICROBENCH_SO` skips the build and loads the given file.

use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

use p01_stark_verifier::goldilocks::MODULUS;
use p01_stark_verifier::merkle;

use std::path::{Path, PathBuf};
use std::str::FromStr;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// `ComputeBudget111111111111111111111111111111`.
const COMPUTE_BUDGET_ID: &str = "ComputeBudget111111111111111111111111111111";

/// The per-instruction ceiling. Every sweep below stays well under it.
const MAX_CU_PER_IX: u32 = 1_400_000;

/// The Goldilocks prime, written out here rather than imported, so the
/// reference arithmetic does not lean on the code under measurement.
const P: u64 = 0xFFFF_FFFF_0000_0001;

// Variant ids. Mirror of `cu_microbench_probe/src/lib.rs`; a mismatch makes the
// program compute something else, which the reference checks catch.
const V_BASELINE: u8 = 0;
const V_MUL: u8 = 1;
const V_ADD: u8 = 2;
const V_INV: u8 = 3;
const V_E3_MUL_KARATSUBA: u8 = 4;
const V_E3_MUL_SCHOOLBOOK: u8 = 5;
const V_E3_MUL_BASE: u8 = 6;
const V_SHA_NODE: u8 = 7;
const V_MERKLE_PATH: u8 = 8;

const ERR_UNKNOWN_VARIANT: u32 = 3;
const ERR_N_NOT_MULTIPLE_OF_8: u32 = 4;

// ---------------------------------------------------------------------------
// Recorded measurements (the pins)
// ---------------------------------------------------------------------------
//
// MEASURED 2026-09-19 by this file: cargo-build-sbf 3.1.9, platform-tools v1.52,
// sbpf v0, litesvm 0.15.1. CU per ONE operation, read as the slope between the
// two longest chains of each sweep. Every test prints its figures on `RESULT`
// lines under `--nocapture`.

/// Two-sided band around each recorded figure. CU is deterministic for fixed
/// bytecode and operands (the sweeps re-run a point and require the same CU),
/// so the band only absorbs trivial codegen shifts. MEASURED against it by the
/// WP0f sabotage runs, which feed mutated probes through P01_CU_MICROBENCH_SO:
/// a redundant second `reduce128` in `Felt::mul` moves the multiply by +5.1%,
/// which a 10% band let through and this one does not; the April 2026
/// `reduce128` (c26a6e07) moves it by +135%.
const PIN_TOLERANCE: f64 = 0.03;

/// `Felt::mul`, dependent chain, 8 per loop iteration: a `__multi3` call
/// (44 instructions on sbpf v0) plus the inlined `reduce128`.
const PIN_MUL_CU: f64 = 76.933;
/// `Felt::add`, dependent chain, 8 per loop iteration.
const PIN_ADD_CU: f64 = 12.180;
/// `Felt::inv` plus one `Felt::add` (the chain is `acc = (acc + b)^-1`).
const PIN_INV_CU: f64 = 10_556.917;
/// Cubic-extension multiply, Karatsuba (6 base multiplies).
const PIN_E3_KARATSUBA_CU: f64 = 663.171;
/// Cubic-extension multiply, schoolbook (9 base multiplies).
const PIN_E3_SCHOOLBOOK_CU: f64 = 845.103;
/// Cubic-extension element times a base-field scalar (3 base multiplies).
const PIN_E3_BASE_CU: f64 = 227.139;
/// `merkle::hash_pair`, the tagged node hash, chained: 127 CU of `sol_sha256`
/// charge plus 34 CU of program.
const PIN_SHA_NODE_CU: f64 = 161.000;
/// One level of `merkle::verify_merkle_path`, mixed left/right index.
const PIN_MERKLE_LEVEL_CU: f64 = 168.417;

// ---------------------------------------------------------------------------
// The probe artifact
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/programs/p01_stark_verifier
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("manifest dir has two ancestors")
        .to_path_buf()
}

fn probe_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cu_microbench_probe")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let h = solana_sha256_hasher::hashv(&[bytes]).to_bytes();
    h.iter().map(|b| format!("{b:02x}")).collect()
}

/// The `cargo-build-sbf` this repo pins (`Anchor.toml` `solana_version`), not
/// the one on `PATH` (see `cu_budget.rs::cargo_build_sbf` for why).
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
            ".local/share/solana/install/releases/{solana_version}/solana-release/bin/{exe}"
        ));
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("cargo-build-sbf")
}

/// `cargo-build-sbf --version`, whitespace-normalised. Part of the cache key:
/// CU is a property of bytecode, and two compilers make two bytecodes.
fn compiler_identity(tool: &Path) -> String {
    let out = std::process::Command::new(tool)
        .arg("--version")
        .output()
        .unwrap_or_else(|e| {
            panic!(
                "could not run `{} --version`: {e}. Set P01_CARGO_BUILD_SBF to a working \
                 cargo-build-sbf, or P01_CU_MICROBENCH_SO to a prebuilt probe.",
                tool.display()
            )
        });
    assert!(
        out.status.success(),
        "`{} --version` exited {:?}",
        tool.display(),
        out.status.code()
    );
    let mut raw = String::from_utf8_lossy(&out.stdout).into_owned();
    raw.push(' ');
    raw.push_str(&String::from_utf8_lossy(&out.stderr));
    let id = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        id.contains("cargo-build-sbf"),
        "`{} --version` printed {id:?}, which does not name cargo-build-sbf; an empty or \
         foreign identity would reduce the cache key to the sources alone",
        tool.display()
    );
    id
}

/// sha256 over everything that decides the probe's bytecode, path-tagged and
/// length-delimited: the probe's manifest and sources, the two verifier sources
/// it includes, `.cargo/config.toml` (profile and flags) and the compiler.
fn build_fingerprint(compiler_id: &str) -> String {
    fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_rs(&p, out);
            } else if p.extension().and_then(|s| s.to_str()) == Some("rs") {
                out.push(p);
            }
        }
    }
    let mut files = Vec::new();
    collect_rs(&probe_dir().join("src"), &mut files);
    assert!(
        !files.is_empty(),
        "no .rs under {}; the fingerprint would not cover the probe",
        probe_dir().display()
    );
    files.sort();
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    files.push(probe_dir().join("Cargo.toml"));
    files.push(crate_dir.join("src/goldilocks.rs"));
    files.push(crate_dir.join("src/merkle.rs"));
    let config = repo_root().join(".cargo/config.toml");
    if config.exists() {
        files.push(config);
    }

    let mut blob: Vec<u8> = Vec::new();
    for f in &files {
        let rel = f.strip_prefix(repo_root()).unwrap_or(f);
        blob.extend_from_slice(rel.to_string_lossy().replace('\\', "/").as_bytes());
        blob.push(0);
        let bytes = std::fs::read(f).unwrap_or_else(|e| panic!("read {}: {e}", f.display()));
        blob.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        blob.extend_from_slice(&bytes);
    }
    blob.extend_from_slice(b"sbf-compiler");
    blob.push(0);
    blob.extend_from_slice(&(compiler_id.len() as u64).to_le_bytes());
    blob.extend_from_slice(compiler_id.as_bytes());
    sha256_hex(&blob)
}

#[derive(Clone)]
struct ProbeSo {
    path: PathBuf,
    provenance: String,
}

/// Built at most once per test binary. Every `cargo-build-sbf` spawn happens
/// inside this one `get_or_init`, so two tests can never race the tool (see
/// `cu_budget.rs::SBF_TOOL_LOCK` for what that race does).
fn probe_so() -> ProbeSo {
    static BUILT: std::sync::OnceLock<ProbeSo> = std::sync::OnceLock::new();
    BUILT.get_or_init(probe_so_uncached).clone()
}

fn probe_so_uncached() -> ProbeSo {
    if let Ok(p) = std::env::var("P01_CU_MICROBENCH_SO") {
        return ProbeSo {
            path: PathBuf::from(p),
            provenance: "SUPPLIED via P01_CU_MICROBENCH_SO; provenance is the caller's claim"
                .to_string(),
        };
    }
    let tool = cargo_build_sbf();
    let compiler = compiler_identity(&tool);
    let fp = build_fingerprint(&compiler);
    // Integration tests may write under CARGO_TARGET_TMPDIR; the repo tree is
    // not touched beyond the lockfile cargo writes next to the probe manifest
    // (gitignored there).
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("cu-microbench");
    let so = out_dir.join("cu_microbench_probe.so");
    let fp_file = out_dir.join("cu_microbench_probe.buildfp");
    let cached = so.exists()
        && std::fs::read_to_string(&fp_file)
            .map(|s| s.trim() == fp)
            .unwrap_or(false);
    if !cached {
        std::fs::create_dir_all(&out_dir).expect("create the probe out dir");
        // The fingerprint must never outlive the artifact it describes.
        let _ = std::fs::remove_file(&fp_file);
        let _ = std::fs::remove_file(&so);
        eprintln!(
            "[cu_microbench] build fingerprint {} — building the probe with {} (`{compiler}`)",
            &fp[..16],
            tool.display()
        );
        let out = std::process::Command::new(&tool)
            .arg("--manifest-path")
            .arg(probe_dir().join("Cargo.toml"))
            .arg("--sbf-out-dir")
            .arg(&out_dir)
            .env("CARGO_TARGET_DIR", out_dir.join("sbf-target"))
            .output()
            .unwrap_or_else(|e| panic!("could not run {}: {e}", tool.display()));
        if !out.status.success() || !so.exists() {
            panic!(
                "cargo-build-sbf failed for the probe (status {:?}, artifact present: {})\n\
                 --- stderr ---\n{}\n--- stdout ---\n{}",
                out.status.code(),
                so.exists(),
                String::from_utf8_lossy(&out.stderr),
                String::from_utf8_lossy(&out.stdout),
            );
        }
        std::fs::write(&fp_file, &fp).expect("write the probe fingerprint");
    }
    ProbeSo {
        path: so,
        provenance: format!(
            "SELF-BUILT from tests/cu_microbench_probe by `{compiler}` (build fp {}, {})",
            &fp[..16],
            if cached { "cache hit" } else { "rebuilt" }
        ),
    }
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

fn probe_id() -> Address {
    let mut b = [0xF0u8; 32];
    b[0] = 0xCB;
    Address::new_from_array(b)
}

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

/// The program's own consumption: `Program <id> consumed N of M compute units`.
/// The compute-budget instruction belongs to another program id and is ignored.
fn program_cu(logs: &[String], program_id: &Address) -> Option<u64> {
    let needle = format!("Program {program_id} consumed ");
    logs.iter().find_map(|l| {
        l.strip_prefix(&needle)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|n| n.parse().ok())
    })
}

struct Rig {
    svm: LiteSVM,
    payer: Keypair,
    program: Address,
}

/// One executed instruction: the program's CU and its return data.
struct Run {
    cu: u64,
    out: Vec<u8>,
}

impl Rig {
    /// Loads the probe. A file that is not a loadable program panics with
    /// `add_program failed`, the marker `scripts/ci/sbf-litesvm.sh` reads in its
    /// negative control.
    fn new() -> Self {
        let so = probe_so();
        let bytes = std::fs::read(&so.path).unwrap_or_else(|e| {
            panic!(
                "add_program failed: cannot read the probe at {}: {e}\n{}",
                so.path.display(),
                so.provenance
            )
        });
        // `with_transaction_history(0)`: the determinism checks send
        // byte-identical transactions under one blockhash.
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 1_000_000_000)
            .expect("airdrop");
        let program = probe_id();
        svm.add_program(program, &bytes).unwrap_or_else(|e| {
            panic!(
                "add_program failed: {e:?}\n  probe: {} ({} bytes, sha256 {})\n  {}",
                so.path.display(),
                bytes.len(),
                sha256_hex(&bytes),
                so.provenance
            )
        });
        Rig {
            svm,
            payer,
            program,
        }
    }

    fn describe(&self) -> String {
        let so = probe_so();
        let bytes = std::fs::read(&so.path).expect("probe readable");
        format!(
            "probe    : {}\nsize     : {} bytes, sha256 {}\norigin   : {}",
            so.path.display(),
            bytes.len(),
            sha256_hex(&bytes),
            so.provenance
        )
    }

    fn try_call(&mut self, data: Vec<u8>) -> Result<Run, (TransactionError, Vec<String>)> {
        let ix = Instruction {
            program_id: self.program,
            accounts: vec![],
            data,
        };
        let msg = Message::new(
            &[set_cu_limit_ix(MAX_CU_PER_IX), ix],
            Some(&self.payer.pubkey()),
        );
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        match self.svm.send_transaction(tx) {
            Ok(meta) => {
                let cu = program_cu(&meta.logs, &self.program).unwrap_or_else(|| {
                    panic!(
                        "no `Program {} consumed …` line; refusing to attribute the \
                         transaction total to the probe. logs: {:?}",
                        self.program, meta.logs
                    )
                });
                Ok(Run {
                    cu,
                    out: meta.return_data.data,
                })
            }
            Err(f) => Err((f.err, f.meta.logs)),
        }
    }

    fn call(&mut self, data: Vec<u8>) -> Run {
        self.try_call(data)
            .unwrap_or_else(|(err, logs)| panic!("probe call failed: {err:?}\nlogs: {logs:?}"))
    }
}

fn ix_data(variant: u8, n: u32, operands: &[u8]) -> Vec<u8> {
    let mut d = vec![variant];
    d.extend_from_slice(&n.to_le_bytes());
    d.extend_from_slice(operands);
    d
}

fn le_words(words: &[u64]) -> Vec<u8> {
    words.iter().flat_map(|w| w.to_le_bytes()).collect()
}

/// Deterministic operands (xorshift64*), so a failure is reproducible.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn bytes32(&mut self) -> [u8; 32] {
        let mut b = [0u8; 32];
        for c in b.chunks_exact_mut(8) {
            c.copy_from_slice(&self.next().to_le_bytes());
        }
        b
    }
}

// ---------------------------------------------------------------------------
// Reference arithmetic, independent of `goldilocks.rs`: u128 `%` throughout.
// ---------------------------------------------------------------------------

fn rmul(a: u64, b: u64) -> u64 {
    ((a as u128 * b as u128) % P as u128) as u64
}

fn radd(a: u64, b: u64) -> u64 {
    ((a as u128 + b as u128) % P as u128) as u64
}

fn rpow(mut a: u64, mut e: u64) -> u64 {
    let mut r = 1u64;
    while e > 0 {
        if e & 1 == 1 {
            r = rmul(r, a);
        }
        a = rmul(a, a);
        e >>= 1;
    }
    r
}

fn rinv(a: u64) -> u64 {
    rpow(a, P - 2)
}

/// Multiply in F_p[x]/(x^3 - x - 1): schoolbook, then x^3 = x + 1 and
/// x^4 = x^2 + x.
fn r3mul(a: [u64; 3], b: [u64; 3]) -> [u64; 3] {
    let mut c = [0u64; 5];
    for i in 0..3 {
        for j in 0..3 {
            c[i + j] = radd(c[i + j], rmul(a[i], b[j]));
        }
    }
    [
        radd(c[0], c[3]),
        radd(radd(c[1], c[3]), c[4]),
        radd(c[2], c[4]),
    ]
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/// One chain length and what it cost.
struct Point {
    n: u32,
    cu: u64,
    out: Vec<u8>,
}

/// Run `variant` at each n, check every result with `reference`, and re-run
/// the middle point to require a byte- and CU-identical repeat.
fn sweep(
    rig: &mut Rig,
    variant: u8,
    ns: &[u32],
    operands: &[u8],
    reference: impl Fn(u32) -> Vec<u8>,
) -> Vec<Point> {
    assert!(
        ns.len() == 3 && ns[0] < ns[1] && ns[1] < ns[2],
        "a sweep is three increasing lengths"
    );
    let mut points = Vec::new();
    for &n in ns {
        let run = rig.call(ix_data(variant, n, operands));
        let want = reference(n);
        assert_eq!(
            run.out, want,
            "variant {variant} at n = {n}: the program returned {:02x?}, the reference says \
             {:02x?}. The chain was shortened, optimised away or computed wrongly, so its CU \
             describes something else.",
            run.out, want
        );
        points.push(Point {
            n,
            cu: run.cu,
            out: run.out,
        });
    }
    let again = rig.call(ix_data(variant, ns[1], operands));
    assert_eq!(
        (again.cu, &again.out),
        (points[1].cu, &points[1].out),
        "variant {variant} at n = {}: a repeated run did not reproduce its CU and output",
        ns[1]
    );
    points
}

fn slope(a: &Point, b: &Point) -> f64 {
    (b.cu as f64 - a.cu as f64) / (b.n as f64 - a.n as f64)
}

/// The per-operation cost: the slope between the two longest chains, after
/// requiring the shorter partial slope to agree with it. A chain the compiler
/// restructured (a loop run a fixed number of times, an exponentiation instead
/// of a chain) is not linear in n.
fn per_op(what: &str, pts: &[Point]) -> f64 {
    let s_lo = slope(&pts[0], &pts[1]);
    let s_hi = slope(&pts[1], &pts[2]);
    assert!(
        s_hi > 0.0,
        "{what}: the cost does not grow with n (slope {s_hi:.3})"
    );
    let tol = (0.02 * s_hi).max(1.0);
    assert!(
        (s_lo - s_hi).abs() <= tol,
        "{what}: the cost is not linear in n: {s_lo:.3} CU/op over n = {}..{} against {s_hi:.3} \
         over n = {}..{} (tolerance {tol:.3})",
        pts[0].n,
        pts[1].n,
        pts[1].n,
        pts[2].n
    );
    s_hi
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

fn print_sweep(title: &str, pts: &[Point], per: f64) {
    println!("\n{title}");
    for p in pts {
        println!("  n = {:>5}   {:>10} CU", p.n, thousands(p.cu));
    }
    println!(
        "  intercept (n = {}) {} CU; per operation {per:.3} CU (slope n = {}..{})",
        pts[0].n,
        thousands(pts[0].cu),
        pts[1].n,
        pts[2].n
    );
}

/// Two-sided pin: see `PIN_TOLERANCE`.
fn assert_pinned(what: &str, measured: f64, recorded: f64) {
    assert!(recorded > 0.0, "{what}: no recorded figure to pin against");
    let dev = (measured - recorded) / recorded;
    assert!(
        dev.abs() <= PIN_TOLERANCE,
        "{what}: measured {measured:.3} CU/op, recorded {recorded:.3} CU/op ({:+.1}%, band \
         ±{:.0}%). The bytecode behind a CU-model input moved. If the change is intended, \
         re-derive the model figures that use it (DESIGN-V2 §2.2) and update the pin.",
        dev * 100.0,
        PIN_TOLERANCE * 100.0
    );
}

// ---------------------------------------------------------------------------
// Measurements shared by several tests
// ---------------------------------------------------------------------------

fn measure_mul(rig: &mut Rig) -> (Vec<Point>, f64) {
    let mut rng = Rng(0x0123_4567_89AB_CDEF);
    let (a, b) = (rng.next(), rng.next());
    let pts = sweep(rig, V_MUL, &[0, 512, 4096], &le_words(&[a, b]), |n| {
        let mut acc = a % P;
        for _ in 0..n {
            acc = rmul(acc, b % P);
        }
        acc.to_le_bytes().to_vec()
    });
    let per = per_op("Felt::mul", &pts);
    (pts, per)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The harness reads the probe's own answers, not some other program's: the
/// baseline echoes n, and the two refusal codes come back as themselves.
#[test]
fn the_loaded_program_is_the_probe() {
    let mut rig = Rig::new();
    println!("\n{}", rig.describe());
    let run = rig.call(ix_data(V_BASELINE, 0x0102_0304, &[]));
    assert_eq!(
        run.out,
        0x0102_0304u64.to_le_bytes().to_vec(),
        "the baseline must echo n"
    );
    println!(
        "baseline (entry + parse + return data): {} CU",
        thousands(run.cu)
    );

    for (data, code, why) in [
        (
            ix_data(0xEE, 8, &[0u8; 16]),
            ERR_UNKNOWN_VARIANT,
            "unknown variant",
        ),
        (
            ix_data(V_MUL, 7, &[0u8; 16]),
            ERR_N_NOT_MULTIPLE_OF_8,
            "n not a multiple of 8",
        ),
    ] {
        match rig.try_call(data) {
            Err((TransactionError::InstructionError(1, InstructionError::Custom(c)), _)) => {
                assert_eq!(c, code, "{why}: wrong refusal code")
            }
            Err((other, logs)) => panic!("{why}: expected Custom({code}), got {other:?} {logs:?}"),
            Ok(_) => panic!("{why}: the program accepted it, so it is not the probe"),
        }
    }
}

/// The reference arithmetic is itself right: it agrees with the shipped `Felt`
/// on the edges `goldilocks.rs` pins, and its extension ring satisfies
/// x^3 = x + 1. Loads no program.
#[test]
fn the_reference_arithmetic_is_right() {
    use p01_stark_verifier::goldilocks::Felt;
    assert_eq!(
        P, MODULUS,
        "the reference prime is not the verifier's modulus"
    );
    let edges = [
        0u64,
        1,
        2,
        0xFFFF_FFFF,
        1 << 32,
        P - 1,
        P - 2,
        4_294_967_300,
    ];
    for &a in &edges {
        for &b in &edges {
            assert_eq!(
                rmul(a, b),
                Felt::new(a).mul(Felt::new(b)).as_u64(),
                "mul({a}, {b})"
            );
            assert_eq!(
                radd(a, b),
                Felt::new(a).add(Felt::new(b)).as_u64(),
                "add({a}, {b})"
            );
        }
    }
    for a in [1u64, 2, 7, P - 1, 0x1234_5678_9ABC] {
        assert_eq!(rmul(a, rinv(a)), 1, "inv({a})");
    }
    let x = [0u64, 1, 0];
    let x3 = r3mul(r3mul(x, x), x);
    assert_eq!(x3, [1, 1, 0], "x^3 must be x + 1 in F_p[x]/(x^3 - x - 1)");
    let mut rng = Rng(42);
    for _ in 0..50 {
        let a = [rng.next() % P, rng.next() % P, rng.next() % P];
        let b = [rng.next() % P, rng.next() % P, rng.next() % P];
        let c = [rng.next() % P, rng.next() % P, rng.next() % P];
        assert_eq!(
            r3mul(a, b),
            r3mul(b, a),
            "the extension multiply must commute"
        );
        assert_eq!(
            r3mul(r3mul(a, b), c),
            r3mul(a, r3mul(b, c)),
            "and associate"
        );
    }
}

#[test]
fn goldilocks_mul_cu() {
    let mut rig = Rig::new();
    let (pts, per) = measure_mul(&mut rig);
    print_sweep("Felt::mul — acc = acc · b, 8 per iteration", &pts, per);
    println!("RESULT Felt::mul = {per:.3} CU/op");
    assert_pinned("Felt::mul", per, PIN_MUL_CU);
}

#[test]
fn goldilocks_add_cu() {
    let mut rig = Rig::new();
    let mut rng = Rng(0x0BAD_5EED_1234_5678);
    let (a, b) = (rng.next(), rng.next());
    let pts = sweep(&mut rig, V_ADD, &[0, 512, 4096], &le_words(&[a, b]), |n| {
        let mut acc = a % P;
        for _ in 0..n {
            acc = radd(acc, b % P);
        }
        acc.to_le_bytes().to_vec()
    });
    let per = per_op("Felt::add", &pts);
    print_sweep("Felt::add — acc = acc + b, 8 per iteration", &pts, per);
    println!("RESULT Felt::add = {per:.3} CU/op");
    assert_pinned("Felt::add", per, PIN_ADD_CU);
}

#[test]
fn goldilocks_inv_cu() {
    let mut rig = Rig::new();
    let mut rng = Rng(0x1357_9BDF_2468_ACE0);
    let (a, b) = (rng.next(), rng.next());
    let pts = sweep(&mut rig, V_INV, &[0, 4, 16], &le_words(&[a, b]), |n| {
        let mut acc = a % P;
        for _ in 0..n {
            acc = rinv(radd(acc, b % P));
        }
        acc.to_le_bytes().to_vec()
    });
    let per = per_op("Felt::inv", &pts);
    print_sweep(
        "Felt::inv — acc = (acc + b)^-1 (Fermat, exponent p - 2)",
        &pts,
        per,
    );
    // p - 2 has 64 bits, 63 of them set: 64 squarings and 63 multiplies.
    let (_, mul) = measure_mul(&mut rig);
    println!(
        "  = {:.1} Felt::mul at {mul:.3} CU (Fermat does 127 multiplies: 64 squarings, 63 \
         multiplies)",
        per / mul
    );
    println!("RESULT Felt::inv (+1 add) = {per:.3} CU/op");
    assert_pinned("Felt::inv", per, PIN_INV_CU);
}

#[test]
fn cubic_extension_mul_cu() {
    let mut rig = Rig::new();
    let mut rng = Rng(0x00C0_FFEE_0000_0003);
    let a = [rng.next(), rng.next(), rng.next()];
    let b = [rng.next(), rng.next(), rng.next()];
    let s = rng.next();
    let reduce = |v: [u64; 3]| [v[0] % P, v[1] % P, v[2] % P];
    let e3_ref = |n: u32| {
        let mut acc = reduce(a);
        for _ in 0..n {
            acc = r3mul(acc, reduce(b));
        }
        le_words(&acc)
    };
    let ab = le_words(&[a[0], a[1], a[2], b[0], b[1], b[2]]);

    let kara = sweep(&mut rig, V_E3_MUL_KARATSUBA, &[0, 128, 1024], &ab, e3_ref);
    let per_k = per_op("E3 mul (Karatsuba)", &kara);
    print_sweep("cubic-extension mul, Karatsuba (6 base muls)", &kara, per_k);

    let school = sweep(&mut rig, V_E3_MUL_SCHOOLBOOK, &[0, 128, 1024], &ab, e3_ref);
    let per_s = per_op("E3 mul (schoolbook)", &school);
    print_sweep(
        "cubic-extension mul, schoolbook (9 base muls)",
        &school,
        per_s,
    );

    let base = sweep(
        &mut rig,
        V_E3_MUL_BASE,
        &[0, 256, 2048],
        &le_words(&[a[0], a[1], a[2], s]),
        |n| {
            let mut acc = reduce(a);
            for _ in 0..n {
                acc = [
                    rmul(acc[0], s % P),
                    rmul(acc[1], s % P),
                    rmul(acc[2], s % P),
                ];
            }
            le_words(&acc)
        },
    );
    let per_b = per_op("E3 x base", &base);
    print_sweep(
        "cubic-extension element x base-field scalar (3 base muls)",
        &base,
        per_b,
    );

    let (_, mul) = measure_mul(&mut rig);
    println!(
        "\n  in Felt::mul units ({mul:.3} CU): Karatsuba {:.2}, schoolbook {:.2}, x base {:.2}",
        per_k / mul,
        per_s / mul,
        per_b / mul
    );
    println!("RESULT E3 mul Karatsuba = {per_k:.3} CU/op");
    println!("RESULT E3 mul schoolbook = {per_s:.3} CU/op");
    println!("RESULT E3 x base = {per_b:.3} CU/op");
    assert_pinned("E3 mul (Karatsuba)", per_k, PIN_E3_KARATSUBA_CU);
    assert_pinned("E3 mul (schoolbook)", per_s, PIN_E3_SCHOOLBOOK_CU);
    assert_pinned("E3 x base", per_b, PIN_E3_BASE_CU);
}

/// The syscall charge for one tagged node, from the cost table: base 85, then
/// max(10, len/2) for each of the three slices 0x01 (1 B), left (32 B) and
/// right (32 B).
const SHA_NODE_SYSCALL_CU: f64 = 85.0 + 10.0 + 16.0 + 16.0;

#[test]
fn sha256_merkle_node_cu() {
    let mut rig = Rig::new();
    let mut rng = Rng(0x5A5A_1234_DEAD_BEEF);
    let (cur, sib) = (rng.bytes32(), rng.bytes32());
    let mut ops = cur.to_vec();
    ops.extend_from_slice(&sib);
    let pts = sweep(&mut rig, V_SHA_NODE, &[0, 64, 512], &ops, |n| {
        let mut c = cur;
        for _ in 0..n {
            c = merkle::hash_pair(&c, &sib);
        }
        c.to_vec()
    });
    let per = per_op("merkle::hash_pair", &pts);
    print_sweep("merkle::hash_pair — H(0x01 ‖ l ‖ r), chained", &pts, per);
    assert!(
        per >= SHA_NODE_SYSCALL_CU,
        "a tagged node measured {per:.3} CU, below the {SHA_NODE_SYSCALL_CU} CU the sol_sha256 \
         cost table charges for its three slices; the program is not hashing what merkle.rs \
         hashes"
    );
    println!(
        "  syscall charge {SHA_NODE_SYSCALL_CU} CU (85 + 10 + 16 + 16) + program-side {:.3} CU",
        per - SHA_NODE_SYSCALL_CU
    );
    println!("RESULT SHA-256 node (hash_pair) = {per:.3} CU/op");
    assert_pinned("merkle::hash_pair", per, PIN_SHA_NODE_CU);
}

/// Build a depth-`depth` path for `leaf` at `index` and its root, on the host.
fn merkle_case(rng: &mut Rng, leaf: &[u8], index: u32, depth: u32) -> ([u8; 32], Vec<u8>) {
    let mut path = Vec::new();
    let mut cur = merkle::hash_leaf(leaf);
    let mut idx = index;
    for _ in 0..depth {
        let sib = rng.bytes32();
        path.extend_from_slice(&sib);
        cur = if idx & 1 == 0 {
            merkle::hash_pair(&cur, &sib)
        } else {
            merkle::hash_pair(&sib, &cur)
        };
        idx >>= 1;
    }
    assert!(
        merkle::verify_merkle_path(&cur, leaf, index as usize, &path),
        "host: the constructed path must verify"
    );
    (cur, path)
}

fn path_operands(root: &[u8; 32], index: u32, leaf: &[u8], path: &[u8]) -> Vec<u8> {
    let mut ops = root.to_vec();
    ops.extend_from_slice(&index.to_le_bytes());
    ops.extend_from_slice(&(leaf.len() as u32).to_le_bytes());
    ops.extend_from_slice(leaf);
    ops.extend_from_slice(path);
    ops
}

/// The walk the verifier runs per query per tree, level by level, plus the leaf
/// hash's per-byte term and a refused path.
#[test]
fn merkle_path_walk_cu() {
    let mut rig = Rig::new();
    let mut rng = Rng(0x7777_0000_1111_2222);
    // 96 bytes = 12 felts, one row of a width-12 trace (C6, C7).
    let leaf: Vec<u8> = (0..96u32).map(|i| (i * 37 + 11) as u8).collect();
    const MIXED: u32 = 0b1011_0010_1101_0110;

    let mut pts = Vec::new();
    for depth in [0u32, 4, 16] {
        let index = MIXED & ((1u32 << depth) - 1);
        let (root, path) = merkle_case(&mut rng, &leaf, index, depth);
        let data = ix_data(
            V_MERKLE_PATH,
            depth,
            &path_operands(&root, index, &leaf, &path),
        );
        let run = rig.call(data.clone());
        assert_eq!(
            run.out,
            vec![1],
            "depth {depth}: the probe refused a valid path"
        );
        let again = rig.call(data);
        assert_eq!(
            again.cu, run.cu,
            "depth {depth}: a repeated walk changed its CU"
        );
        pts.push(Point {
            n: depth,
            cu: run.cu,
            out: run.out,
        });
    }
    let per_level = per_op("verify_merkle_path level", &pts);
    print_sweep(
        "merkle::verify_merkle_path — 96-byte leaf, mixed index",
        &pts,
        per_level,
    );

    // All-left and all-right walks bound the left/right branch difference.
    let mut sides = Vec::new();
    for index in [0u32, 0xFFFF] {
        let (root, path) = merkle_case(&mut rng, &leaf, index, 16);
        let run = rig.call(ix_data(
            V_MERKLE_PATH,
            16,
            &path_operands(&root, index, &leaf, &path),
        ));
        assert_eq!(
            run.out,
            vec![1],
            "index {index:#x}: the probe refused a valid path"
        );
        sides.push(run.cu);
    }
    println!(
        "  depth 16: all-left {} CU, all-right {} CU",
        thousands(sides[0]),
        thousands(sides[1])
    );

    // A wrong root must be refused: the walk is compared, not just run.
    let (mut root, path) = merkle_case(&mut rng, &leaf, MIXED, 16);
    root[7] ^= 0x20;
    let refused = rig.call(ix_data(
        V_MERKLE_PATH,
        16,
        &path_operands(&root, MIXED, &leaf, &path),
    ));
    assert_eq!(
        refused.out,
        vec![0],
        "the probe accepted a path against a wrong root"
    );
    println!(
        "  depth 16, wrong root: refused, {} CU",
        thousands(refused.cu)
    );

    // The leaf hash's per-byte term: at depth 0 the program is identical for
    // both leaves and only the syscall charge moves, by (288 - 96) / 2.
    let wide: Vec<u8> = (0..288u32).map(|i| (i * 53 + 5) as u8).collect();
    let mut leaf_cu = Vec::new();
    for l in [&leaf, &wide] {
        let (root, path) = merkle_case(&mut rng, l, 0, 0);
        let run = rig.call(ix_data(
            V_MERKLE_PATH,
            0,
            &path_operands(&root, 0, l, &path),
        ));
        assert_eq!(run.out, vec![1]);
        leaf_cu.push(run.cu);
    }
    let per_byte_total = leaf_cu[1] as i64 - leaf_cu[0] as i64;
    println!(
        "  depth 0: 96-byte leaf {} CU, 288-byte leaf {} CU (+{per_byte_total}; the cost table \
         says +{})",
        thousands(leaf_cu[0]),
        thousands(leaf_cu[1]),
        (288 - 96) / 2
    );
    assert_eq!(
        per_byte_total,
        (288 - 96) / 2,
        "growing the leaf by 192 bytes must cost exactly the sol_sha256 per-byte term \
         (1 CU per 2 bytes); anything else means the leaf is copied or hashed twice"
    );
    println!("RESULT Merkle path level = {per_level:.3} CU/level");
    println!("RESULT leaf hash = 0.5 CU/byte (4 CU per 8-byte column)");
    assert_pinned("verify_merkle_path level", per_level, PIN_MERKLE_LEVEL_CU);
}

// ---------------------------------------------------------------------------
// The per-multiply prose in verify.rs
// ---------------------------------------------------------------------------

/// `src/verify.rs`, embedded, so an edit rebuilds this test.
const VERIFY_SRC: &str = include_str!("../src/verify.rs");

/// Every per-multiply CU figure in `text`, as (line number, value): the shapes
/// `~N CU/mul` and `× ~N CU` (the second is how the inv_gen comment prices a
/// count of multiplies).
fn per_mul_figures(text: &str) -> Vec<(usize, u64)> {
    fn digits_before(s: &str) -> Option<u64> {
        let s = s.trim_end();
        let start = s
            .char_indices()
            .rev()
            .take_while(|(_, c)| c.is_ascii_digit() || *c == ',')
            .last()
            .map(|(i, _)| i)?;
        s[start..].replace(',', "").parse().ok()
    }
    fn digits_after(s: &str) -> Option<(u64, &str)> {
        let end = s
            .find(|c: char| !(c.is_ascii_digit() || c == ','))
            .unwrap_or(s.len());
        let v = s[..end].replace(',', "").parse().ok()?;
        Some((v, &s[end..]))
    }
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let mut rest = line;
        while let Some(at) = rest.find("CU/mul") {
            if let Some(v) = digits_before(&rest[..at]) {
                out.push((i + 1, v));
            }
            rest = &rest[at + "CU/mul".len()..];
        }
        let mut rest = line;
        while let Some(at) = rest.find("× ~") {
            rest = &rest[at + "× ~".len()..];
            if let Some((v, tail)) = digits_after(rest) {
                if tail.starts_with(" CU") && !tail.starts_with(" CU/") {
                    out.push((i + 1, v));
                }
            }
        }
    }
    out
}

/// The scanner, against planted lines it must read and lines it must not.
/// Loads no program.
#[test]
fn per_multiply_figure_scanner_reads_both_shapes() {
    let planted = "a ~442K CU (~216 CU/mul) b\n\
                   22 × 9 × ~216 CU ≈ 42K CU.\n\
                   ~85 CU/call\n\
                   instead of N × ~63 muls for Fermat\n\
                   1,234 CU/mul and × ~1,500 CU\n\
                   nothing here";
    assert_eq!(
        per_mul_figures(planted),
        vec![(1, 216), (2, 216), (5, 1234), (5, 1500)],
        "the per-multiply scanner misread the planted lines"
    );
    assert!(
        !per_mul_figures(VERIFY_SRC).is_empty(),
        "the scanner finds no per-multiply figure in verify.rs; the inv_gen comment prices its \
         multiplies, so the scanner or the path is wrong and the prose check would pass empty"
    );
}

/// Every per-multiply figure in `verify.rs` must be within 25% of the measured
/// `Felt::mul`. The figures are written with `~`, so 25% is generous; the
/// comment this was written against said ~216.
#[test]
fn verify_rs_per_multiply_figures_match_the_measured_felt_mul() {
    let mut rig = Rig::new();
    let (_, mul) = measure_mul(&mut rig);
    let figs = per_mul_figures(VERIFY_SRC);
    assert!(
        !figs.is_empty(),
        "no per-multiply figure found in verify.rs"
    );
    let wrong: Vec<String> = figs
        .iter()
        .filter(|(_, v)| ((*v as f64 - mul) / mul).abs() > 0.25)
        .map(|(line, v)| format!("verify.rs:{line} prices a Goldilocks multiply at ~{v} CU"))
        .collect();
    assert!(
        wrong.is_empty(),
        "\n{}\nbut tests/cu_microbench.rs MEASURES Felt::mul at {mul:.3} CU/op on SBF \
         (cargo-build-sbf 3.1.9, sbpf v0, litesvm). Re-price the comment from the measurement.",
        wrong.join("\n")
    );
    println!("verify.rs per-multiply figures {figs:?} agree with the measured {mul:.3} CU/op");
}
