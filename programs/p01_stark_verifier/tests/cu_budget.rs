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
//! #    --test-threads=1 is now COSMETIC: it keeps the tables from interleaving.
//! cargo test --release -p p01_stark_verifier --test cu_budget \
//!     -- --nocapture --test-threads=1
//! ```
//!
//! It was not always cosmetic. Until 2026-08-02 this harness was NOT parallel-safe
//! and every caller had to remember that flag: `cargo-build-sbf` reconciles the
//! `solana` rustup toolchain before it does anything — `--version` included — so
//! `build_fingerprint_changes_when_the_compiler_changes` asking for the version
//! could uninstall the toolchain underneath a `cu_*` test's build, which then died
//! with `0xc0000135 STATUS_DLL_NOT_FOUND` and looked like a broken install rather
//! than a race. A guarantee that lives in a comment is not a guarantee, so the
//! harness serialises its own builds now: see `SBF_TOOL_LOCK` and the `OnceLock`
//! in `verifier_so_path`. Steps 1 and 2 above are still worth running by hand —
//! step 1 only saves time, but step 2 is REQUIRED, because the c7 probe `.so` is
//! gitignored and nothing builds it for you. A fresh worktree fails that test
//! closed, correctly.
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
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

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

/// The mobile client's fixed-size proof envelope, `apps/mobile/services/stark/
/// index.ts:73`.
///
/// Phase C pads EVERY proof to this length before upload so the on-chain buffer
/// size leaks nothing about which circuit ran. A proof larger than the envelope
/// cannot be padded to it, and until this constant existed the only thing in the
/// repo that noticed was a runtime `throw` in `padProofToUniform`
/// (`index.ts:347-349`) — on a user's phone, at upload time, after the proof had
/// already been generated. `145_000` appears in no `.rs` file before this one.
///
/// Read the value out of the TypeScript rather than copying it, so the two
/// cannot drift; see `uniform_proof_size_from_the_mobile_client`.
const UNIFORM_PROOF_SIZE: usize = 145_000;

/// The mobile prover client, embedded at COMPILE time so that moving or renaming
/// it is a build failure here rather than a silently skipped check.
const MOBILE_STARK_TS: &str = include_str!("../../../apps/mobile/services/stark/index.ts");

/// Parse `export const UNIFORM_PROOF_SIZE = 145_000;` out of the mobile client.
///
/// Panics rather than defaulting: a check that silently falls back to its own
/// copy of the number is not a binding, it is a second copy.
fn uniform_proof_size_from_the_mobile_client() -> usize {
    const NEEDLE: &str = "export const UNIFORM_PROOF_SIZE = ";
    let at = MOBILE_STARK_TS.find(NEEDLE).unwrap_or_else(|| {
        panic!(
            "`{NEEDLE}` not found in apps/mobile/services/stark/index.ts — the Rust side of \
             the proof-size envelope has nothing left to bind to. Either the client moved the \
             constant (re-point this parser) or the envelope was deleted (delete this check \
             and the assertion it feeds)."
        )
    });
    let digits: String = MOBILE_STARK_TS[at + NEEDLE.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '_')
        .collect();
    assert!(
        !digits.is_empty(),
        "found `{NEEDLE}` but no numeric literal after it"
    );
    digits
        .replace('_', "")
        .parse()
        .unwrap_or_else(|e| panic!("could not parse UNIFORM_PROOF_SIZE literal {digits:?}: {e}"))
}

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

/// The `.so` under test, and whether the harness produced it itself.
///
/// # Why this is not just `target/deploy/`
///
/// Until this revision the harness read `target/deploy/p01_stark_verifier.so`
/// and merely *printed* a warning when `src/` was newer. MEASURED: a green run
/// on bytes that predate the change under test was therefore possible, and it
/// happened — the first `cu_budget` run of the Route C work measured a `.so`
/// dated 04:29 and reported pre-Route-C numbers as if they were post-Route-C.
/// A warning is not a gate.
///
/// So by default the harness now BUILDS the artifact it measures, with the
/// toolchain `Anchor.toml` pins, through a private `--sbf-out-dir` and a private
/// `CARGO_TARGET_DIR` (so it never contends for the target lock held by the
/// `cargo test` that invoked it, and never reads or writes anchor's
/// `target/deploy/`), cached on a content fingerprint of `src/` AND of the
/// compiler that will consume it. Same mechanism as
/// `p01_liquidity`/`p01_zkspl`'s `deep_ali_gate` harnesses, plus the compiler
/// term — see `build_fingerprint`.
///
/// `P01_VERIFIER_SO` still points the harness at a prebuilt artifact — that is
/// the "measure exactly what is on devnet" use case and it is legitimate — but
/// in that mode `assert_artifact_is_current` requires the artifact to be at
/// least as new as `src/`, so the stale-bytes trap is closed on both paths.
#[derive(Clone)]
enum SoUnderTest {
    /// Built by this harness from the `src/` tree next to it.
    SelfBuilt {
        path: PathBuf,
        fingerprint: String,
        cached: bool,
        /// The SBF compiler that produced these bytes, as it identifies itself.
        compiler: String,
    },
    /// Supplied by the caller via `P01_VERIFIER_SO`.
    Supplied { path: PathBuf },
}

impl SoUnderTest {
    fn path(&self) -> &Path {
        match self {
            SoUnderTest::SelfBuilt { path, .. } | SoUnderTest::Supplied { path } => path,
        }
    }

    /// One line describing provenance, printed above every table.
    fn provenance(&self) -> String {
        match self {
            SoUnderTest::SelfBuilt { fingerprint, cached, compiler, .. } => format!(
                "SELF-BUILT by this harness from programs/p01_stark_verifier/src \
                 by `{}` (build fp {}, {})",
                compiler,
                &fingerprint[..16],
                if *cached { "cache hit" } else { "rebuilt" },
            ),
            SoUnderTest::Supplied { .. } => {
                "SUPPLIED via P01_VERIFIER_SO — provenance is the caller's claim, not this \
                 harness's"
                    .to_string()
            }
        }
    }
}

/// Serialises EVERY `cargo-build-sbf` invocation this test binary makes.
///
/// `cargo-build-sbf` is not reentrant against itself. It reconciles the `solana`
/// rustup toolchain before it does anything else — including for `--version` —
/// and reconciling means it can UNINSTALL and reinstall the sbpf toolchain
/// underneath a sibling process. MEASURED: with the default test harness
/// (`--test-threads` = core count) `build_fingerprint_changes_when_the_compiler_changes`
/// runs `--version` while `cu_*` is mid-build and the build dies with
/// `0xc0000135 STATUS_DLL_NOT_FOUND`, because its toolchain was removed out from
/// under it.
///
/// This used to be a caller's problem: every invocation of this file was expected
/// to remember `--test-threads=1`, and it was documented in the module header and
/// in the founder's notes. That is a guarantee held by a convention, which is the
/// same shape of defect as a gate that checks a constant instead of the
/// enforcement — the first caller who forgets gets a build failure that looks
/// like a broken toolchain rather than a race. The harness serialises itself now.
/// `--test-threads=1` is no longer required; it is also no longer harmful.
///
/// The lock is held for the DURATION OF ONE SPAWN and never across a call that
/// could take it again, so it cannot deadlock: `verifier_so_path` calls
/// `compiler_identity` (takes and releases) and only afterwards runs the build
/// (takes and releases). Poisoning is recovered from rather than propagated — a
/// panic in another test's build says nothing about whether this one may run the
/// tool, and turning that into a second panic would bury the first report.
static SBF_TOOL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// How many `cargo-build-sbf` processes this binary has ever spawned, and the
/// most that were ever in flight at once. Instrumentation, not bookkeeping:
/// `harness_serialises_its_own_sbf_builds` asserts on both, because a lock that
/// is merely present is the same kind of claim as a gate that reads a constant.
static SBF_SPAWNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static SBF_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static SBF_MAX_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Run `cargo-build-sbf` with the process-wide lock held. See `SBF_TOOL_LOCK`.
fn run_sbf_tool(
    tool: &Path,
    configure: impl FnOnce(&mut std::process::Command),
) -> std::io::Result<std::process::Output> {
    use std::sync::atomic::Ordering::SeqCst;
    let _guard = SBF_TOOL_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    SBF_SPAWNS.fetch_add(1, SeqCst);
    let live = SBF_IN_FLIGHT.fetch_add(1, SeqCst) + 1;
    SBF_MAX_IN_FLIGHT.fetch_max(live, SeqCst);
    let mut cmd = std::process::Command::new(tool);
    configure(&mut cmd);
    let out = cmd.output();
    SBF_IN_FLIGHT.fetch_sub(1, SeqCst);
    out
}

/// The serialisation is a property, so it is asserted rather than commented.
///
/// Eight threads ask for the artifact and the compiler identity at once. Whatever
/// the caller passed for `--test-threads`, that is real concurrency through the
/// two entry points that spawn `cargo-build-sbf`, and two things must hold:
///
///   * exactly one child-process spawn site exists in this file and it is the
///     locked helper. [ADVERSARY 2026-08-03] This replaces
///     `assert!(SBF_MAX_IN_FLIGHT <= 1)`, which could not fail: the counter is
///     incremented inside the very critical section it was supposed to be
///     evidence about. The race it named — one `cargo-build-sbf` reconciling the
///     rustup toolchain under another and killing it with `0xc0000135
///     STATUS_DLL_NOT_FOUND` — can only be reintroduced by a spawn that skips
///     the lock, and a skipped spawn increments nothing, so only a source-level
///     check can see it;
///   * eight concurrent callers cause ZERO additional spawns, because both entry
///     points are memoised. This half bites even when the artifact is already
///     cached and no build would have run anyway, which is the common case and
///     the one a weaker test would sleep through.
///
/// All eight must also agree about which artifact is under test. Disagreement
/// would mean two builds raced into one output path and the CU numbers below
/// describe whichever won.
#[test]
fn harness_serialises_its_own_sbf_builds() {
    use std::sync::atomic::Ordering::SeqCst;

    // Warm both memos first, so the count below measures the CONCURRENT calls
    // and not the one-off work they may or may not have been first to trigger.
    let expected = verifier_so_path().path().to_path_buf();
    let compiler = compiler_identity();
    let spawns_before = SBF_SPAWNS.load(SeqCst);

    let paths: Vec<(PathBuf, String)> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..8)
            .map(|_| s.spawn(|| (verifier_so_path().path().to_path_buf(), compiler_identity())))
            .collect();
        handles.into_iter().map(|h| h.join().expect("worker panicked")).collect()
    });

    for (i, (path, id)) in paths.iter().enumerate() {
        assert_eq!(
            path, &expected,
            "thread {i} got a different .so than the main thread — two builds raced into one \
             output path and the CU tables describe whichever finished last"
        );
        assert_eq!(&compiler, id, "thread {i} disagreed about the compiler identity");
    }

    assert_eq!(
        SBF_SPAWNS.load(SeqCst),
        spawns_before,
        "eight concurrent callers spawned {} extra cargo-build-sbf process(es). Both entry points \
         are supposed to be memoised; without that, N tests asking for the artifact is N builds \
         writing one path.",
        SBF_SPAWNS.load(SeqCst) - spawns_before
    );

    // [ADVERSARY 2026-08-03] `assert!(SBF_MAX_IN_FLIGHT.load(SeqCst) <= 1, ..)`
    // stood here and was a TAUTOLOGY. `SBF_IN_FLIGHT` is incremented and
    // decremented entirely INSIDE the `SBF_TOOL_LOCK` critical section
    // (`run_sbf_tool`), so the high-water mark cannot exceed 1 whatever the lock
    // does — the instrumentation lives inside the thing it claims to measure.
    // Its own doc block said "a lock that is merely present is the same kind of
    // claim as a gate that reads a constant", and then read a constant. There is
    // no mutation of the lock that turns it red, which is the definition of a
    // guard worth nothing.
    //
    // The real hazard it was reaching for is a spawn that never takes the lock
    // at all — and such a spawn is not counted either, so the runtime check
    // could not have seen it. That IS checkable, at the source level, and this
    // is what replaces it. `SBF_MAX_IN_FLIGHT` is kept as instrumentation and
    // printed, not asserted on.
    let needle = concat!("Command", "::new(");
    let src: Vec<&str> = THIS_FILE.lines().collect();
    let mut spawn_sites: Vec<(usize, String)> = Vec::new();
    for (i, l) in src.iter().enumerate() {
        let code = l.split("//").next().unwrap_or("");
        if !code.contains(needle) {
            continue;
        }
        let owner = src[..i]
            .iter()
            .rev()
            .find_map(|p| {
                p.trim_start()
                    .strip_prefix("fn ")
                    .and_then(|s| s.split('(').next())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "<top level>".to_string());
        spawn_sites.push((i + 1, owner));
    }
    assert_eq!(
        spawn_sites.len(),
        1,
        "this file spawns a child process from {} places: {spawn_sites:?}. Exactly one may \
         exist and it must be the locked helper — a second spawn site is how a sibling \
         cargo-build-sbf reconciles the `solana` rustup toolchain out from under a build in \
         progress and kills it with 0xc0000135 STATUS_DLL_NOT_FOUND. Route it through \
         `run_sbf_tool` instead of adding an entry here.",
        spawn_sites.len()
    );
    assert_eq!(
        spawn_sites[0].1, "run_sbf_tool",
        "the only child-process spawn in this file is inside `{}` (line {}), not inside the \
         locked helper `run_sbf_tool`. It bypasses SBF_TOOL_LOCK entirely, and no runtime \
         counter can see a spawn that never took the lock.",
        spawn_sites[0].1, spawn_sites[0].0
    );
    println!(
        "[sbf-lock] {} spawn(s) this run, max {} in flight, 1 locked spawn site at line {}",
        SBF_SPAWNS.load(SeqCst),
        SBF_MAX_IN_FLIGHT.load(SeqCst),
        spawn_sites[0].0
    );
}

/// The SBF compiler's identity, as it reports it, whitespace-normalised.
///
/// Memoised, because it spawns the tool: two tests asking the same question
/// should not be two chances to collide with a build. The lock alone would make
/// it correct; the `OnceLock` makes it happen once.
///
/// `cargo-build-sbf --version` prints its own version and the platform-tools
/// version it will invoke, and those two lines are what decide the bytecode:
///
/// ```text
///   solana-cargo-build-sbf 3.1.9      solana-cargo-build-sbf 2.2.14
///   platform-tools v1.52              platform-tools v1.47
/// ```
///
/// Running this is not optional and a failure is not tolerated. A build
/// fingerprint that silently omits the compiler is the exact defect this
/// function exists to close, so a tool that cannot report its version panics
/// here rather than degrading to a source-only key.
fn compiler_identity() -> String {
    static CACHED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHED.get_or_init(compiler_identity_uncached).clone()
}

fn compiler_identity_uncached() -> String {
    let tool = cargo_build_sbf();
    let out = run_sbf_tool(&tool, |cmd| {
        cmd.arg("--version");
    })
    .unwrap_or_else(|e| {
        panic!(
            "could not run `{} --version`: {}\n\n\
             The compiler's identity is part of the build fingerprint this harness caches\n\
             on, because CU is a property of BYTECODE and the same src/ compiled by two\n\
             different platform-tools is not the same bytecode. Falling back to a\n\
             source-only key here would let a toolchain switch report a cache hit and\n\
             re-print the previous compiler's numbers as if freshly measured, which is the\n\
             failure this check exists to prevent. Set P01_CARGO_BUILD_SBF to a working\n\
             cargo-build-sbf, or point the harness at a prebuilt artifact with\n\
             P01_VERIFIER_SO.\n",
            tool.display(),
            e
        )
    });
    if !out.status.success() {
        panic!(
            "`{} --version` exited {:?}\n--- stderr ---\n{}\n--- stdout ---\n{}",
            tool.display(),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr),
            String::from_utf8_lossy(&out.stdout),
        );
    }
    let mut raw = String::from_utf8_lossy(&out.stdout).into_owned();
    raw.push(' ');
    raw.push_str(&String::from_utf8_lossy(&out.stderr));
    // Collapse the line breaks so CRLF/LF and trailing-newline differences
    // between platforms cannot masquerade as a different compiler.
    let id = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        !id.is_empty(),
        "`{} --version` printed nothing — an empty compiler identity would silently \
         reduce the build fingerprint to a source-only key",
        tool.display(),
    );
    id
}

/// sha256 over every `.rs` under `src/`, plus `Cargo.toml`, the workspace
/// `Cargo.lock` and the COMPILER IDENTITY, path-sorted and length-delimited.
/// Any edit to the verifier — including deleting a `verify_merkle_path_2seg`
/// call — changes it.
///
/// # Why the compiler is in here
///
/// It used to hash source only, and that made the cache a trap. A CU number is a
/// property of a binary; the source is only half of what produces one. This box
/// carries two SBF toolchains — `~/.local/share/solana/install/active_release`
/// points at agave 2.2.14 (platform-tools v1.47) while `Anchor.toml:3` pins
/// 3.1.9 (v1.52) — and `P01_CARGO_BUILD_SBF` picks between them, so a run on the
/// wrong toolchain is one environment variable away. `ci.yml` used to export the
/// 2.2.14 one; it now installs 3.1.9 and asserts the version before this runs.
///
/// MEASURED on the source-only key: with `target/cu-budget` holding a 3.1.9
/// build, re-running the harness with `P01_CARGO_BUILD_SBF` set to the 2.2.14
/// binary printed `(source fp 716225449ed00a96, cache hit)` and re-reported the
/// 3.1.9 numbers, byte-identical `.so` sha256 included. The 2.2.14 compiler was
/// never invoked and nothing in the output said so. That is a measurement
/// attributed to the wrong compiler, which is worse than no measurement.
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
    let src = crate_dir.join("src");
    let mut files = Vec::new();
    collect(&src, &mut files);
    assert!(
        !files.is_empty(),
        "no .rs files under {} — the fingerprint would be vacuous and the staleness \
         check meaningless",
        src.display()
    );
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

    // Same shape as a file entry — a tagged, length-delimited field — so the
    // compiler cannot be confused with the tail of the last source file.
    blob.extend_from_slice(b"sbf-compiler");
    blob.push(0);
    blob.extend_from_slice(&(compiler_id.len() as u64).to_le_bytes());
    blob.extend_from_slice(compiler_id.as_bytes());

    sha256_hex(&blob)
}

/// The `cargo-build-sbf` this repo pins (`Anchor.toml` `solana_version`).
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

/// Memoised so the `.so` is built AT MOST ONCE per test binary.
///
/// `OnceLock::get_or_init` blocks every other caller until the first one
/// finishes, which is what makes this harness parallel-safe rather than merely
/// parallel-tolerant: without it two `cu_*` tests could each see `cached ==
/// false`, each delete the artifact and the fingerprint, and each start a
/// `cargo-build-sbf` — two builds writing one output path, plus the rustup
/// toolchain race `SBF_TOOL_LOCK` describes.
///
/// It also makes the reported provenance honest. `cached` is now "this binary
/// had already built it", one `rebuilt` line per run at most, instead of
/// whichever of N racing threads happened to print last.
fn verifier_so_path() -> SoUnderTest {
    static BUILT: std::sync::OnceLock<SoUnderTest> = std::sync::OnceLock::new();
    BUILT.get_or_init(verifier_so_path_uncached).clone()
}

fn verifier_so_path_uncached() -> SoUnderTest {
    if let Ok(p) = std::env::var("P01_VERIFIER_SO") {
        return SoUnderTest::Supplied { path: PathBuf::from(p) };
    }

    let compiler = compiler_identity();
    let fp = build_fingerprint(&compiler);
    let out_dir = repo_root().join("target/cu-budget");
    let so = out_dir.join("p01_stark_verifier.so");
    let fp_file = out_dir.join("p01_stark_verifier.buildfp");
    // Pre-compiler-aware records were written to `.srcfp`. The name is a lie
    // about what the hash covers, so it is not read and not left behind.
    let legacy_fp_file = out_dir.join("p01_stark_verifier.srcfp");

    let cached = so.exists()
        && std::fs::read_to_string(&fp_file)
            .map(|s| s.trim() == fp)
            .unwrap_or(false);

    if !cached {
        std::fs::create_dir_all(&out_dir).expect("create cu-budget out dir");
        // Drop the pair first: a fingerprint file must never outlive the
        // artifact it describes, or a failed build leaves a stale artifact
        // looking current.
        let _ = std::fs::remove_file(&fp_file);
        let _ = std::fs::remove_file(&legacy_fp_file);
        let _ = std::fs::remove_file(&so);

        let tool = cargo_build_sbf();
        eprintln!(
            "[cu_budget] build fingerprint {} — rebuilding p01_stark_verifier with {} (`{}`)",
            &fp[..16],
            tool.display(),
            compiler,
        );
        let out = run_sbf_tool(&tool, |cmd| {
            cmd.arg("--manifest-path")
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
                .arg("--sbf-out-dir")
                .arg(&out_dir)
                .env("CARGO_TARGET_DIR", out_dir.join("sbf-target"));
        })
        .unwrap_or_else(|e| {
            panic!(
                "could not run {}: {}\n\n\
                 This harness measures compute units of bytecode it builds itself, so a\n\
                 missing build tool is a broken measurement, not a passing one. Set\n\
                 P01_CARGO_BUILD_SBF to a working cargo-build-sbf, or point the harness at\n\
                 a prebuilt artifact with P01_VERIFIER_SO.\n",
                tool.display(),
                e
            )
        });
        if !out.status.success() || !so.exists() {
            panic!(
                "cargo-build-sbf failed for p01_stark_verifier (status {:?}, artifact present: \
                 {})\n--- stderr ---\n{}\n--- stdout ---\n{}",
                out.status.code(),
                so.exists(),
                String::from_utf8_lossy(&out.stderr),
                String::from_utf8_lossy(&out.stdout),
            );
        }
        std::fs::write(&fp_file, &fp).expect("write fingerprint");
    }

    SoUnderTest::SelfBuilt { path: so, fingerprint: fp, cached, compiler }
}

/// The build fingerprint must MOVE when the compiler moves.
///
/// Without this the guarantee is a comment. `build_fingerprint` takes the
/// compiler identity as an argument precisely so the property can be asserted
/// without installing a second toolchain: feed it the two strings this box
/// actually reports and require the two hashes to differ.
#[test]
fn build_fingerprint_changes_when_the_compiler_changes() {
    // Verbatim `cargo-build-sbf --version` output from the two SBF toolchains
    // installed on the founder's box, whitespace-normalised the way
    // `compiler_identity` normalises it.
    let v3 = "solana-cargo-build-sbf 3.1.9 platform-tools v1.52";
    let v2 = "solana-cargo-build-sbf 2.2.14 platform-tools v1.47";

    let fp3 = build_fingerprint(v3);
    let fp2 = build_fingerprint(v2);
    assert_ne!(
        fp3, fp2,
        "the build fingerprint is identical for {v3:?} and {v2:?} — the compiler is not part \
         of the cache key, so switching toolchain reports a cache hit and re-prints the \
         previous compiler's CU as if freshly measured"
    );

    // Positive control: the same compiler on the same tree must still hash the
    // same, or the cache would never hit and this would be a rebuild-always
    // gate rather than a correct one.
    assert_eq!(
        fp3,
        build_fingerprint(v3),
        "the build fingerprint is not stable for a fixed (source, compiler) pair"
    );

    // And the live one must be a real, non-empty identity, not a silent default.
    let live = compiler_identity();
    assert!(
        live.contains("cargo-build-sbf"),
        "compiler identity {live:?} does not look like cargo-build-sbf output"
    );
}

fn probe_so_path() -> PathBuf {
    match std::env::var("P01_C7_PROBE_SO") {
        Ok(p) => PathBuf::from(p),
        Err(_) => Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/c7_probe/out/c7_phase2_probe.so"),
    }
}

/// FAIL if the `.so` under test predates the crate sources.
///
/// A CU number is a property of a binary, not of a source tree. This used to
/// `println!` a warning and carry on, which meant a green run on stale bytes was
/// possible — and it happened. `assert_artifact_is_current` below turns it into a
/// failure.
///
/// Only reachable on the `P01_VERIFIER_SO` path now: a self-built artifact is
/// keyed on a content fingerprint of `src/` plus the compiler identity, which is
/// strictly stronger than an mtime comparison (an mtime check passes if someone
/// edits a source and then rebuilds a *different* crate, because the `.so` ends
/// up newer than the source it does not correspond to, and it passes on a
/// toolchain switch that touches no source at all).
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
             if you want the current source measured, or unset P01_VERIFIER_SO to let this\n\
             harness build the artifact itself.",
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

    /// Send one instruction and hand back the STRUCTURED outcome.
    ///
    /// `run` flattens every failure into a `String`, which is fine when the only
    /// question is "what did this cost". It is not fine when the question is
    /// "did the program REJECT this or did it CRASH on it", because those two
    /// differ only in the `InstructionError` variant and a string comparison
    /// would be checking the Debug formatter rather than the error.
    fn try_run(
        &mut self,
        ix: Instruction,
    ) -> std::result::Result<Vec<String>, (TransactionError, Vec<String>)> {
        let msg = Message::new(
            &[set_cu_limit_ix(MAX_CU_PER_IX as u32), ix],
            Some(&self.payer_pk),
        );
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta.logs),
            Err(f) => Err((f.err, f.meta.logs)),
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
fn load_verifier_or_fail(rig: &mut Rig, program: &Address) -> (SoUnderTest, usize, String) {
    let so = verifier_so_path();
    assert_artifact_is_current(&so);
    match rig.load_program(program, so.path()) {
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
            so.path().display(),
            e
        ),
    }
}

/// A caller-supplied artifact must not predate `src/`. FAILS, does not warn.
///
/// The self-built path needs no check: it is keyed on a content fingerprint of
/// `src/` and of the compiler, so a mismatch in either triggers a rebuild before
/// this is reached.
fn assert_artifact_is_current(so: &SoUnderTest) {
    let SoUnderTest::Supplied { path } = so else {
        return;
    };
    if let Some(note) = staleness_note(path) {
        panic!(
            "\n\
             ============================================================\n\
             STALE BINARY — refusing to report CU for bytes that predate src/.\n\
             ============================================================\n\
             path : {}\n\n\
             {}\n\
             ============================================================\n",
            path.display(),
            note,
        );
    }
}

// ---------------------------------------------------------------------------
// Per-circuit CU ceilings — the actual regression gate
// ---------------------------------------------------------------------------

/// Phase-1 / phase-2 CU ceilings per circuit, as a RATCHET.
///
/// # Why a ceiling and not an equality pin
///
/// CU is deterministic for a given (binary, witness) pair, so an equality pin
/// would be exact — and red on every legitimate edit, which means it would be
/// deleted. A ceiling catches the thing that actually matters (drift toward the
/// 1,400,000 cap) and stays green when a change makes the verifier cheaper.
///
/// Before this existed the only asserts in this file were "the measurement
/// happened" and "there are seven rows". Nothing bounded CU from above except
/// the 1,400,000 cap, so C0's 599,059 could become 1,399,000 and stay green —
/// the number would just change in a table nobody diffs.
///
/// # The numbers
///
/// Every `*_measured` below is a real `compute_units_consumed` from THIS
/// harness. The artifact and the toolchain that produced them are named ONCE, on
/// `CU_CEILINGS` directly below, and nowhere else. That is deliberate: this doc
/// used to name a Route C `.so` (`e13073c6…`, 638,248 B), the block on the array
/// named a B1 `.so` (`47a9b2a2…`) and then a third build (`f27876a4…`), all for
/// one array of seven numbers. At most one of three could be true, and the
/// numbers in the array matched none of them.
///
/// Every `*_max` is `ceil(measured * 1.02)` rounded up to the next 1,000 — a
/// uniform 2% band, narrow enough that the "it quietly became 1,399,000" failure
/// mode is red. It is COMPUTED from the measurement, not measured.
///
/// That band used to be the only thing absorbing a compiler difference. The pin
/// below was taken with the 3.1.9 toolchain `Anchor.toml:3` names, while
/// `ci.yml` installed agave 2.2.14 and exported
/// `P01_CARGO_BUILD_SBF=…/active_release/bin/cargo-build-sbf`, so CI gated these
/// numbers against bytecode from a different platform-tools and a red run there
/// meant either a regression or a compiler difference with nothing saying which.
/// Nobody has measured what 2.2.14 costs; on the founder's box it cannot build
/// at all (`os error 183`), so the difference cannot be measured here either.
///
/// `ci.yml` now installs the 3.1.9 `Anchor.toml:3` pins and asserts
/// `cargo-build-sbf --version` before this harness runs, so the gate compares
/// like with like. `CU_MEASURED_WITH` and `toolchain_caveat` are the backstop
/// for the day someone changes that pin without re-measuring: the harness then
/// prints the gap above its own table and repeats it inside every violation, so
/// the red still has two meanings but no longer hides that it does.
///
/// Still UNMEASURED: the host. These numbers were taken on Windows x86_64 and
/// CI runs ubuntu x86_64. Same SBF target and same platform-tools, but nobody
/// has compared the two `.so` files, so that residual is real and the 2% band
/// is the only thing absorbing it.
///
/// If you legitimately raise CU, raise the ceiling in the same commit and say
/// why in the commit message. Do not widen the band to make a red run green.
///
/// C0 has no phase-2 instruction (`lib.rs:259-262` rejects circuit 0), so its
/// phase-2 ceiling is `None` rather than a number that could never be exceeded.
struct CuCeiling {
    circuit_id: u8,
    /// MEASURED phase-1 CU. Provenance for all seven is on `CU_CEILINGS`.
    phase1_measured: u64,
    /// COMPUTED ceiling asserted against: `measured * 1.02`, rounded up to 1,000.
    phase1_max: u64,
    /// MEASURED phase-2 CU, `None` where the instruction does not exist.
    phase2_measured: Option<u64>,
    phase2_max: Option<u64>,
}

/// MEASURED by `cu_budget_real_circuits` on this tree, 2026-08-01, RE-ANCHORED
/// for [B2] and RE-MEASURED at the [B2-INT] integration head.
///
/// Artifact: `target/cu-budget/p01_stark_verifier.so`, 687,736 B, sha256
/// `8729ac97979e9b7cc464e010f06141062c575c035d97872d709c015c5a9b091b`, built by
/// `solana-cargo-build-sbf 3.1.9 platform-tools v1.52`, build fp
/// `d0a21acd521d6e83`, from a `CARGO_TARGET_DIR` that did not exist.
///
/// # [LIVENESS 2026-08-01] The artifact moved because the PROGRAM moved
///
/// Every previous entry in the history below is a line-number shift: same size,
/// same thirteen CU numbers, different hash. This one is not. The liveness fix
/// rewrote two live phase-1 arms in `verify.rs` —
/// `verify_constraints_merkle_update` gained an `active_rows` bound (the twin of
/// the 2026-05-29 C3 fix) and `verify_constraints_transfer` gained the
/// carry-capture edge check — so the `.so` grew 687,440 → 687,736 B (+296) and
/// two CU pins moved for a reason:
///
/// * C5 phase 1  793,372 → 793,355  (−17). The capture rows now take a
///   `next[carry] == current[0]` compare instead of the `next == current` one
///   they took before; the branch is the same shape and one comparand changed.
/// * C6 phase 1  809,654 → 809,658  (+4). One extra `trace_row < active_rows`
///   compare per trace-aligned query.
///
/// Both are re-recorded below. NEITHER CEILING WAS TOUCHED: C5 sits at 810,000
/// and C6 at 826,000, and the new numbers are 16,645 and 16,342 under them. The
/// remaining eleven pins print `+0`.
///
/// # [B2-AUDIT] The build fp moved and the artifact hash did NOT — on purpose
///
/// The fp recorded here was `1aaddf07001a1cc0` at the integration head
/// `58e5c77a`. `f62ce46f` then added `mod grinding_enforcement` to `verify.rs`,
/// and `build_fingerprint` hashes the BYTES of every `.rs` under `src/`, so it
/// moved to `488086644ca36a77`. The `.so` did not: the module is behind
/// `#[cfg(test)]` and sits at the very END of the file, below every panicking
/// statement, so no relative panic location shifted. Two independent cold
/// measurements of the artifact — one at `58e5c77a`, one after `f62ce46f` with
/// `target/cu-budget` deleted first — both give `df4b325f…` at 687,440 B, and
/// all thirteen CU pins print `+0` against the recorded numbers in both.
///
/// That is the useful shape of the two records: the fp is the CACHE key and must
/// move on any source edit, the sha256 is the ARTIFACT and only moves when the
/// bytes do. A change that moves the fp and not the sha256 is a source edit the
/// binary did not notice. A change that moves the sha256 is a change to what
/// runs on chain.
///
/// # That artifact hash goes stale on a doc-comment edit, and has now done it twice
///
/// This block first recorded sha256 `45bee650…` / build fp `267355fc…`. Both are
/// real and both were measured — at `bd07e934`, the commit that re-anchored the
/// pins. `567232bb` then rewrote soundness doc comments in `compact_proof.rs`
/// (+25 lines) and `verify.rs` (+9, inside `mod merkle_update_e2e`), and the
/// build embeds RELATIVE panic locations, so the line numbers inside them moved
/// and the bytes moved with them. Same size, same thirteen CU numbers, different
/// hash — so the record described a binary HEAD no longer produces, and nothing
/// in this file asserts the hash, so the suite stayed green while it drifted.
///
/// It was then re-measured at `6de57685` as `42b8387a…`: four cold SBF builds,
/// three at HEAD into three different output paths (`target/cu-budget` twice and
/// a path outside the repo) all giving `42b8387a…`, and a fourth with `src/`
/// checked out from `bd07e934` reproducing `45bee650…` exactly.
///
/// [B2-INT] It went stale AGAIN, in exactly the predicted way, the moment the six
/// B2 branches were merged. Two of them edit `src/`: the bits-and-claims pass
/// rewrote two soundness doc comments in `verify.rs` (the "~2^64" prose at the
/// `verify_deep_ali_circuit_6` preamble and at `evaluate_transition_at_ood_circuit_4`,
/// +8/-2 between them) and the claims-audit pass rewrote a doc comment in
/// `compact_proof.rs` (+18/-5). Those edits sit ABOVE panicking code, so the
/// relative panic locations below them shifted and the bytes shifted with them.
/// Size is byte-identical at 687,440 and all thirteen CU numbers are byte-identical
/// too, which is the signature of a pure line-number move. `src/query_position_independence.rs`
/// (+331) contributes nothing to the binary: it is behind `#[cfg(test)]` and is
/// declared at the very END of `verify.rs`, so it shifts no line number either.
///
/// RE-MEASURED at the integration head: two cold SBF builds, into
/// `target/cu-budget` and into `target-sbf-b/out` with `CARGO_TARGET_DIR`
/// `target-sbf-b/tgt`, three paths that had never existed, run SEQUENTIALLY —
/// both give `df4b325f…` at 687,440 B. So the build is still bit-reproducible and
/// output-path independent — `grep -a Protocol-01` on the `.so` finds no absolute
/// path — and the hash is a function of `src/` alone.
/// Re-record it whenever `src/` changes at all, comments included, or delete it;
/// what must never happen is leaving a hash here that HEAD does not build.
///
/// Every one of the 13 numbers below is a `compute_units_consumed` from that
/// run, and a second run against the same artifact reproduces all 13: the
/// `vs recorded` column prints `+0` on all 13 pins.
///
/// # Why they moved, and why the band was NOT widened
///
/// B2 splits the composition polynomial into `quotient_segments` columns, so the
/// per-query DEEP arithmetic gains `k-1` extra `(Q_j(x) - Q_j(z))` terms at BOTH
/// halves of the coset, the quotient pair-leaf preimage goes from 16 to 16k
/// bytes, and `k(2nq+1)` more field elements are parsed and canonicity-checked.
/// MEASURED cost, phase 1: +54,946 (C3) to +72,685 (C1), i.e. +7.5% to +10.7%.
/// Phase 2 moved +1,953 to +2,773 (+1.1% to +2.5%), which is the parse widening
/// alone — `verify_deep_ali_circuit_*` gained only the k-term recombination of
/// `Q(z)`, which is `k-1` muls and `k-1` adds.
///
/// Two predictions were made before the run and BOTH were wrong, in opposite
/// directions: a single-DEEP-point model said ~+45,000 on phase 1 and a
/// two-point model said ~+90,000. The measurement is ~+60,000. It is recorded
/// here because the models are not, and the number that governs is the one that
/// was run.
///
/// This is a RE-ANCHOR to a new measured baseline after an intentional format
/// change, in the same commit as the change, with the artifact and toolchain
/// named — which is what the ratchet is for. The 2% band is UNCHANGED at
/// `CU_BAND_NUMERATOR = 102`. Widening the band to absorb the drift would have
/// been the other option and it is the wrong one: it would have left every
/// future regression up to 10% invisible.
///
/// Worst absolute is C4 at 920,897 of 1,400,000 (66%); worst phase1+phase2 is
/// C4 at 1,128,502, still inside one instruction, leaving ~271,000 CU of margin.
/// Worst phase 2 alone is C4 at 207,605. The smallest phase-1 pin is C0 at
/// 633,547. CU was never the binding constraint and it still is not.
///
/// [B7 2026-08-04] All thirteen pins moved with the LDE coset. The price is
/// +34,874 to +79,303 CU per circuit, +6% to +9%, and it buys the end of the
/// witness leak: an aligned query no longer returns a raw trace row. C4 goes
/// from 60% to 66% of the cap. Superseded figures, kept so the sentence that
/// records the move stays writeable: worst absolute was 843,918, worst total
/// 1,051,138 with ~349,000 of margin, worst phase 2 alone 207,220, smallest
/// phase-1 pin 599,059.
///
/// [BIND-C2C4 2026-08-03] The last three of those figures moved with the C2/C4
/// boundary fold: the worst total was C4 at 1,023,556 with ~376,000 of margin,
/// and the worst phase 2 alone was C5 at 201,422 — C4 has now overtaken it. The
/// fold is what binds those two circuits' public inputs to the proof, so this is
/// the cost of a soundness fix and it was accepted as such; see the note on the
/// C2 row of `CU_CEILINGS`.
///
/// That sentence used to say "all seven rows", because only phase 1 HAD a
/// `vs measured` column — the six phase-2 pins were asserted against their
/// ceiling and printed nowhere, so six of the thirteen numbers this block claims
/// were reproduced could not be seen to have been. Both phases are tabulated
/// now, and every number in this doc comment that also exists as a constant is
/// checked against it by `cu_ceiling_prose_matches_the_constants`.
///
/// # There is no historical column here, on purpose
///
/// This block used to carry two more tables: a `was pinned / measured / delta`
/// column from the re-pin in `0757b105`, and a `before -> after B1` column
/// copied out of `d4b6ea12`'s commit message. Neither is reproducible by running
/// this harness — `d4b6ea12` measured a tree that still contained
/// `verify_quotient_at_query` and its eight call sites, which no longer exist —
/// and the `after B1` column contradicted the array twenty lines under it on all
/// seven circuits: it said C0 538,720 where the array of the day said 538,666,
/// and so on down to C6 749,673 against 749,469. Both of those arrays are now
/// history twice over — B2 re-anchored all thirteen pins — which is exactly why
/// the columns are gone rather than re-labelled.
///
/// That is the second time a stale column in this doc drifted from the constants
/// below it, so the columns are deleted rather than re-labelled. Nothing is
/// lost: `git show 0757b105` and `git show d4b6ea12` carry both tables in their
/// commit messages, attached to the diffs that moved the constants.
///
/// # Where phase 1 got its cost
///
/// B1 — folding the DEEP composition into FRI — is what moved it, by +10.0% to
/// +14.1% on phase 1 across the seven circuits (measured in `d4b6ea12`). That is
/// the DEEP composition: ~`num_queries * (2w + 12) + 3w + 3` muls plus one
/// 127-mul batched inversion. C6 pays the most because its irreducible term is
/// `2w` muls per query at w = 10 and no rearrangement removes it.
///
/// Phase 2 moved by at most +98 CU (+0.05%) across B1 and has needed no re-pin
/// since. It is NOT a phase-2 code change: `verify_deep_ali_circuit_*` reads no
/// query data and its inputs (both roots, z, ood_current, ood_next,
/// ood_quotient) are bit-identical pre/post B1, since B1 changes neither Merkle
/// tree nor the OOD derivation. The phase-2 INSTRUCTION also calls
/// `GenericCompactProof::from_bytes`, which B1 gave a 16-iteration final-poly
/// canonicity loop, and codegen shifting inside that parse function is the
/// attributed cause. That attribution is INFERENCE from the source, not a
/// separate measurement.
///
const CU_CEILINGS: [CuCeiling; 7] = [
    CuCeiling { circuit_id: 0, phase1_measured: 633_547, phase1_max: 647_000, phase2_measured: None,           phase2_max: None },
    CuCeiling { circuit_id: 1, phase1_measured: 810_012, phase1_max: 827_000, phase2_measured: Some(124_932), phase2_max: Some(128_000) },
    // [BIND-C2C4 2026-08-03] C2 and C4 phase-2 re-pinned UPWARD. The cause is the
    // public-input boundary fold: `verify_deep_ali_circuit_2` and `_4` now
    // reconstruct the boundary term of `Q` at `z` and fold it into the DEEP
    // check, which is what binds those two circuits' public inputs to the proof.
    // Before it, the OOD quotient was bound to nothing on C2/C4 and a forged
    // public input was accepted; that is closed and mutation-proven.
    //
    // The price is MEASURED, not budgeted, and it lands entirely on phase 2. The
    // end-to-end totals and the remaining margin are DERIVED from these pins and
    // stated once, in the doc block above — deliberately not restated here, since
    // two copies of a derived figure is how the stale columns this file already
    // deleted got written. The band is untouched: every `*_max` here is still
    // `measured * 1.02` rounded up to 1,000, so nothing was loosened beyond what
    // was measured, and `cu_ceilings_are_the_documented_band` still proves it.
    //
    // THIS IS A RECORDED ACCEPTANCE OF A KNOWN COST, decided 2026-08-03, and not
    // a step taken to make CI green. If a future change moves these again, the
    // question to answer first is what moved and why — never what number would
    // pass.
    CuCeiling { circuit_id: 2, phase1_measured: 815_286, phase1_max: 832_000, phase2_measured: Some(112_043), phase2_max: Some(115_000) },
    CuCeiling { circuit_id: 3, phase1_measured: 864_400, phase1_max: 882_000, phase2_measured: Some(115_905), phase2_max: Some(119_000) },
    // [BIND-C2C4 2026-08-03] see the note on C2 above — same cause, same band,
    // same recorded acceptance. C4 is the circuit that pays the most.
    CuCeiling { circuit_id: 4, phase1_measured: 920_897, phase1_max: 940_000, phase2_measured: Some(207_605), phase2_max: Some(212_000) },
    // [LIVENESS 2026-08-01] phase1_measured re-recorded: C5 793_372 -> 793_355
    // (-17, the capture-edge compare) and C6 809_654 -> 809_658 (+4, the
    // active_rows bound). The CEILINGS are unchanged and neither was approached.
    CuCeiling { circuit_id: 5, phase1_measured: 870_591, phase1_max: 889_000, phase2_measured: Some(201_325), phase2_max: Some(206_000) },
    CuCeiling { circuit_id: 6, phase1_measured: 888_220, phase1_max: 906_000, phase2_measured: Some(122_739), phase2_max: Some(126_000) },
];

/// The band every `*_max` is computed with, as a percentage numerator over 100.
///
/// Held as constants rather than spelled inline so the prose check below can
/// treat `1,000` in a doc comment as derived rather than as a figure someone
/// typed.
const CU_BAND_NUMERATOR: u64 = 102;
/// `*_max` is rounded UP to the next multiple of this.
const CU_BAND_ROUNDING: u64 = 1_000;

/// `ceil(measured * 1.02)` rounded up to the next 1,000. COMPUTED, never typed.
fn cu_band(measured: u64) -> u64 {
    let raw = (measured * CU_BAND_NUMERATOR).div_ceil(100);
    raw.div_ceil(CU_BAND_ROUNDING) * CU_BAND_ROUNDING
}

/// The compiler that produced `CU_CEILINGS`, verbatim as `compiler_identity`
/// reports it.
///
/// It is the string in the provenance paragraph above, held as a constant so the
/// harness can compare it to the compiler it is actually running rather than
/// leaving a reader to notice.
const CU_MEASURED_WITH: &str = "solana-cargo-build-sbf 3.1.9 platform-tools v1.52";

/// The toolchain gap between `CU_CEILINGS` and this run, or `None` when there is
/// none.
///
/// A CU ceiling failure has two possible causes — a real regression, or bytecode
/// from a different platform-tools — and until `ci.yml` was pinned to 3.1.9 the
/// only thing separating them was the 2% band. It now installs the same 3.1.9
/// these numbers were measured with, so the expected result here is `None` on
/// both CI and a default local run.
///
/// This exists for the day that pin is changed without re-measuring. The gate
/// cannot resolve the ambiguity, so it names it: the line is printed above the
/// ceiling table on every run and appended to every violation, which is the
/// difference between a red with two meanings and a red with two meanings that
/// says so.
fn toolchain_caveat(so: &SoUnderTest) -> Option<String> {
    match so {
        SoUnderTest::SelfBuilt { compiler, .. } if compiler == CU_MEASURED_WITH => None,
        SoUnderTest::SelfBuilt { compiler, .. } => Some(format!(
            "AMBIGUOUS GATE: CU_CEILINGS was measured with `{CU_MEASURED_WITH}`, this run built \
             with `{compiler}`. CU is a property of bytecode, so a ceiling failure below is a \
             toolchain finding as readily as a regression, and the difference between these two \
             compilers has never been measured."
        )),
        SoUnderTest::Supplied { .. } => Some(format!(
            "AMBIGUOUS GATE: the artifact came from P01_VERIFIER_SO, so the compiler that \
             produced it is the caller's claim and this harness cannot check it. CU_CEILINGS was \
             measured with `{CU_MEASURED_WITH}`; a ceiling failure below may be a toolchain \
             difference."
        )),
    }
}

/// `CU_MEASURED_WITH` must be an identity `compiler_identity` could actually
/// produce, and the caveat must fire on a mismatch and stay silent on a match.
///
/// Without the negative control the caveat could be a function that returns
/// `None` unconditionally, which reads exactly like a clean toolchain.
#[test]
fn toolchain_caveat_fires_only_when_the_compiler_differs() {
    let matching = SoUnderTest::SelfBuilt {
        path: PathBuf::from("/dev/null"),
        fingerprint: "0".repeat(64),
        cached: false,
        compiler: CU_MEASURED_WITH.to_string(),
    };
    assert!(
        toolchain_caveat(&matching).is_none(),
        "the compiler CU_CEILINGS was measured with must not raise a caveat against itself"
    );

    let other = SoUnderTest::SelfBuilt {
        path: PathBuf::from("/dev/null"),
        fingerprint: "0".repeat(64),
        cached: false,
        compiler: "solana-cargo-build-sbf 2.2.14 platform-tools v1.47".to_string(),
    };
    let note = toolchain_caveat(&other).expect("a different platform-tools must raise a caveat");
    assert!(note.contains("2.2.14"), "the caveat must name the compiler in use: {note}");
    assert!(note.contains("3.1.9"), "the caveat must name the compiler measured: {note}");

    let supplied = SoUnderTest::Supplied { path: PathBuf::from("/dev/null") };
    let note = toolchain_caveat(&supplied)
        .expect("an artifact of unknown provenance must raise a caveat");
    assert!(note.contains("P01_VERIFIER_SO"), "unexpected message: {note}");

    // And the recorded string must be shaped like real `--version` output, or the
    // comparison above would never match anything and the caveat would be stuck on.
    assert!(
        CU_MEASURED_WITH.starts_with("solana-cargo-build-sbf ")
            && CU_MEASURED_WITH.contains("platform-tools "),
        "CU_MEASURED_WITH {CU_MEASURED_WITH:?} is not shaped like `cargo-build-sbf --version`"
    );
}

/// The band is COMPUTED, so assert the arithmetic rather than trusting a typo.
///
/// Without this, a fat-fingered `phase1_max: 6_250_000` would silently disable the
/// gate for that circuit and every table above would still print `ok`.
#[test]
fn cu_ceilings_are_two_percent_over_the_recorded_measurement() {
    let band = cu_band;
    for c in CU_CEILINGS.iter() {
        assert_eq!(
            c.phase1_max,
            band(c.phase1_measured),
            "C{} phase-1 ceiling {} is not ceil(measured {} * 1.02) rounded to 1,000 = {} \
             — either the measurement or the band was edited without the other",
            c.circuit_id,
            c.phase1_max,
            c.phase1_measured,
            band(c.phase1_measured),
        );
        match (c.phase2_measured, c.phase2_max) {
            (Some(m), Some(max)) => assert_eq!(
                max,
                band(m),
                "C{} phase-2 ceiling {} is not ceil({} * 1.02) rounded to 1,000 = {}",
                c.circuit_id,
                max,
                m,
                band(m),
            ),
            (None, None) => {}
            _ => panic!(
                "C{} declares a phase-2 measurement without a ceiling or vice versa",
                c.circuit_id
            ),
        }
        assert!(
            c.phase1_max < MAX_CU_PER_IX,
            "C{} phase-1 ceiling {} is at or over the {} cap — the ceiling would never fire",
            c.circuit_id,
            c.phase1_max,
            MAX_CU_PER_IX,
        );
    }
    assert_eq!(CU_CEILINGS.len(), 7, "one ceiling per shipping circuit C0..C6");
}

/// The ceiling check must be capable of failing. Prove it on synthetic rows.
///
/// `check_cu_ceilings` is the only thing standing between a CU regression and a
/// green run, and it is fed by measurements that are always in-band on a healthy
/// tree — so on a healthy tree its reject path is never exercised. This test
/// exercises it directly:
///
///   * in-band rows          -> zero violations (the gate is not "reject always")
///   * one row over ceiling  -> exactly one violation, naming that circuit
///   * a phase-2 where the table says there is none -> a violation
fn synthetic_row(circuit_id: u8, phase1: Measured, phase2: Measured) -> CircuitRow {
    CircuitRow {
        circuit_id,
        label: "synthetic",
        proof_bytes: 0,
        num_chunks: 0,
        init_cu: Measured::NotApplicable("synthetic"),
        chunk_cu: Measured::NotApplicable("synthetic"),
        phase1,
        phase2,
        prove_ms: 0,
    }
}

#[test]
fn cu_ceiling_check_rejects_a_regression_and_accepts_the_recorded_numbers() {
    // Positive control: exactly the recorded measurements must be clean. Without
    // this, "reject everything" would look like a working gate.
    let clean: Vec<CircuitRow> = CU_CEILINGS
        .iter()
        .map(|c| {
            synthetic_row(
                c.circuit_id,
                Measured::Ok(c.phase1_measured),
                match c.phase2_measured {
                    Some(cu) => Measured::Ok(cu),
                    None => Measured::NotApplicable("C0 has no phase-2 ix"),
                },
            )
        })
        .collect();
    assert!(
        check_cu_ceilings(&clean, None).is_empty(),
        "the recorded measurements must sit inside their own ceilings",
    );

    // Negative control 1: one CU over the C4 phase-1 ceiling.
    let c4 = ceiling_for(4);
    let over = vec![synthetic_row(
        4,
        Measured::Ok(c4.phase1_max + 1),
        Measured::Ok(c4.phase2_measured.unwrap()),
    )];
    let v = check_cu_ceilings(&over, None);
    assert_eq!(v.len(), 1, "expected exactly one violation, got {v:?}");
    assert!(v[0].contains("C4 phase 1"), "violation should name the circuit and phase: {}", v[0]);

    // Negative control 2: the same regression one CU BELOW the ceiling is clean,
    // so the boundary is where it is documented to be and not off by a rounding.
    let at = vec![synthetic_row(
        4,
        Measured::Ok(c4.phase1_max),
        Measured::Ok(c4.phase2_measured.unwrap()),
    )];
    assert!(check_cu_ceilings(&at, None).is_empty(), "the ceiling itself must be inclusive");

    // Negative control 3: phase 2 over its ceiling.
    let ph2 = vec![synthetic_row(
        5,
        Measured::Ok(ceiling_for(5).phase1_measured),
        Measured::Ok(ceiling_for(5).phase2_max.unwrap() + 1),
    )];
    let v = check_cu_ceilings(&ph2, None);
    assert_eq!(v.len(), 1, "expected exactly one violation, got {v:?}");
    assert!(v[0].contains("C5 phase 2"), "violation should name the circuit and phase: {}", v[0]);

    // Negative control 4: C0 growing a phase-2 instruction is a dispatch change.
    let c0ph2 = vec![synthetic_row(
        0,
        Measured::Ok(ceiling_for(0).phase1_measured),
        Measured::Ok(1),
    )];
    let v = check_cu_ceilings(&c0ph2, None);
    assert_eq!(v.len(), 1, "expected exactly one violation, got {v:?}");
    assert!(v[0].contains("structurally absent"), "unexpected message: {}", v[0]);

    // Negative control 5: a violation raised while the toolchain is ambiguous
    // must carry that ambiguity in its own text. Printing it in a header the
    // reader has scrolled past is not the same as saying it.
    let v = check_cu_ceilings(&over, Some("AMBIGUOUS GATE: some other platform-tools"));
    assert_eq!(v.len(), 1, "expected exactly one violation, got {v:?}");
    assert!(
        v[0].contains("AMBIGUOUS GATE"),
        "a violation raised under a toolchain caveat must repeat it: {}",
        v[0]
    );
}

/// Every verdict this file can print, exercised. A verdict function that can
/// only say `ok` and `OVER` is what the phase-1 table shipped with while its own
/// doc claimed it printed `IMPROVED`.
///
/// Named with the `cu_ceiling` prefix so `ci.yml`'s test-name filter picks it up
/// without editing the workflow.
#[test]
fn cu_ceiling_verdict_separates_a_movement_from_a_breach() {
    let (rec, max) = (100_000u64, 102_000u64);
    assert_eq!(pin_verdict(rec, rec, max), "ok", "reproducing the pin is not drift");
    assert_eq!(pin_verdict(rec - 1, rec, max), "IMPROVED");
    assert_eq!(pin_verdict(rec + 1, rec, max), "DRIFT", "up but under the ceiling is drift");
    assert_eq!(
        pin_verdict(max, rec, max),
        "DRIFT",
        "the ceiling is inclusive — at the ceiling is still not a violation"
    );
    assert_eq!(pin_verdict(max + 1, rec, max), "OVER");
}

/// A phase-2 movement must be VISIBLE, not merely under the ceiling.
///
/// This is the defect this commit exists for. `check_cu_ceilings` asserts phase
/// 2 against a 2% ratchet and printed no phase-2 table at all, so any movement
/// inside the band produced no output whatsoever: nothing to diff, nothing to
/// notice. The assertion below is on the RENDERED table, because "the number is
/// in a struct field somewhere" is not observability.
#[test]
fn cu_ceiling_phase2_movement_shows_up_in_the_printed_table() {
    // The recorded numbers, with C5's phase 2 moved +37 CU — well inside its 2%
    // ceiling, so the gate stays green and only the drift column can show it.
    let rows: Vec<CircuitRow> = CU_CEILINGS
        .iter()
        .map(|c| {
            let ph2 = match c.phase2_measured {
                Some(cu) if c.circuit_id == 5 => Measured::Ok(cu + 37),
                Some(cu) => Measured::Ok(cu),
                None => Measured::NotApplicable("C0 has no phase-2 ix"),
            };
            synthetic_row(c.circuit_id, Measured::Ok(c.phase1_measured), ph2)
        })
        .collect();

    let report = ceiling_report(&rows, None);
    assert!(
        report.violations.is_empty(),
        "+37 CU is inside the 2% band, so the ceiling must stay green — that is the \
         whole point: {:?}",
        report.violations
    );
    let out = report.lines.join("\n");

    assert!(out.contains("PHASE 2"), "there must be a phase-2 table at all:\n{out}");
    assert!(
        out.contains("ph2 recorded") && out.contains("vs recorded"),
        "the phase-2 table must carry a recorded baseline and a drift column:\n{out}"
    );
    assert!(out.contains("+37"), "the phase-2 movement must be printed:\n{out}");
    assert!(out.contains("DRIFT"), "a movement up under the ceiling reads DRIFT:\n{out}");
    assert_eq!(report.drifted, 1, "exactly one pin moved:\n{out}");
    assert_eq!(
        report.measured, 13,
        "seven phase-1 pins plus six phase-2 pins are what this gate covers:\n{out}"
    );
    assert!(
        out.contains("1 of 13 pins moved"),
        "the drift count must be legible without reading the tables:\n{out}"
    );

    // C0's phase-2 cell is structurally absent — not a zero, not a blank.
    let c0: Vec<&str> = out.lines().filter(|l| l.contains("(id 0)")).collect();
    assert_eq!(c0.len(), 2, "C0 appears once per phase table: {c0:?}");
    assert!(c0[1].contains("n/a"), "C0 phase 2 must read n/a, not 0: {}", c0[1]);

    // The same instrument on phase 1, in the other direction.
    let mut improved = rows;
    improved[0] = synthetic_row(
        0,
        Measured::Ok(ceiling_for(0).phase1_measured - 12),
        Measured::NotApplicable("C0 has no phase-2 ix"),
    );
    let out2 = ceiling_report(&improved, None).lines.join("\n");
    assert!(out2.contains("-12"), "a phase-1 improvement must be printed:\n{out2}");
    assert!(out2.contains("IMPROVED"), "a movement down reads IMPROVED:\n{out2}");
}

/// This file's own source, so prose that quotes a constant can be checked
/// against the constant.
const THIS_FILE: &str = include_str!("cu_budget.rs");

/// Comma-grouped figures in this file's PROSE that no constant here produces.
///
/// Each one needs a reason. An unexplained number in a comment is precisely how
/// commit `4b1347c3`, titled "re-pin CU after the dead ALI seam was deleted",
/// shipped a diff that touched only this doc block and moved no constant at all
/// — eight lines added, three removed, zero pins changed.
///
/// Adding an entry here is cheap and honest; leaving a figure out is a red run
/// with the number quoted back at you. Entries are checked in BOTH directions:
/// an entry that no longer appears in the prose is itself a failure, so this
/// cannot rot into a list of numbers nobody wrote.
const PROSE_FIGURES: [(u64, &str); 35] = [
    (1_399_000, "illustrative: what C0 could have become before a ceiling existed"),
    (638_248, "byte size of the historical Route C .so this doc used to name"),
    (687_736, "byte size of the .so CU_CEILINGS is measured from TODAY — provenance, not a pin"),
    (687_440, "byte size of the PRE-liveness-fix .so, quoted to show the +296 B the fix cost"),
    // [LIVENESS 2026-08-01] The two phase-1 pins the fix moved. Both are quoted
    // in the provenance block as the BEFORE value; the AFTER value is the
    // constant in CU_CEILINGS, so only the before-value needs registering.
    (793_372, "the PRE-liveness-fix C5 phase-1 pin, quoted beside the 793,355 that replaced it"),
    (809_654, "the PRE-liveness-fix C6 phase-1 pin, quoted beside the 809,658 that replaced it"),
    (16_645, "C5 phase-1 headroom under its unchanged ceiling — derived from pins"),
    (16_342, "C6 phase-1 headroom under its unchanged ceiling — derived from pins"),
    (54_946, "smallest measured B2 phase-1 CU delta (C3) — provenance, not a pin"),
    (72_685, "largest measured B2 phase-1 CU delta (C1) — provenance, not a pin"),
    (1_953, "smallest measured B2 phase-2 CU delta (C4) — provenance, not a pin"),
    (2_773, "largest measured B2 phase-2 CU delta (C5) — provenance, not a pin"),
    (81_457, "measured C4 proof bytes, the largest post-B2 — printed each run, not pinned"),
    (538_720, "the stale `after B1` column's C0, quoted to show it contradicted the array"),
    (749_673, "the same stale column's C6"),
    (538_666, "the pre-B2 C0 phase-1 pin, quoted where the stale column contradicted it"),
    (749_469, "the pre-B2 C6 phase-1 pin, same sentence"),
    (45_000, "a pre-measurement PREDICTION of B2's phase-1 CU delta, recorded as wrong"),
    (90_000, "the other pre-measurement prediction, also wrong"),
    (60_000, "the MEASURED B2 phase-1 delta, rounded — the exact per-circuit figures are pins"),
    // [BIND-C2C4 2026-08-03] The margin figure moved with the fold. Both are
    // registered: the new one because prose quotes it, the old one because prose
    // still quotes it AS the superseded value — deleting it would make the
    // sentence that records the move unwriteable.
    (349_000, "cap minus the worst phase1+phase2 total — derived from pins, rounded"),
    (376_000, "the SUPERSEDED margin, pre-C2/C4-fold, quoted beside the 349,000 that replaced it"),
    (1_023_556, "the SUPERSEDED worst phase1+phase2 total (C4), same sentence"),
    // [B7 2026-08-04] All thirteen pins moved with the LDE coset. The
    // superseded values stay registered because the prose quotes them AS
    // superseded — deleting them would make the sentence that records the
    // move unwriteable, which is how a re-pin ends up moving only prose.
    (599_059, "the PRE-B7 C0 phase-1 pin, quoted beside the 633,547 that replaced it"),
    (793_355, "the PRE-B7 C5 phase-1 pin"),
    (809_658, "the PRE-B7 C6 phase-1 pin"),
    (810_000, "the PRE-B7 C5 phase-1 ceiling"),
    (826_000, "the PRE-B7 C6 phase-1 ceiling"),
    (843_918, "the PRE-B7 C4 phase-1 pin, the old worst absolute"),
    (1_051_138, "the PRE-B7 worst phase1+phase2 total (C4)"),
    (207_220, "the PRE-B7 C4 phase-2 pin"),
    (201_422, "the PRE-B7 C5 phase-2 pin"),
    (271_000, "cap minus the worst phase1+phase2 total — derived from pins, rounded"),
    (34_874, "smallest per-circuit CU delta the coset cost (C0) — provenance, not a pin"),
    (79_303, "largest per-circuit CU delta the coset cost (C3) — provenance, not a pin"),
];

/// Every figure the constants in this file produce, in every form prose quotes
/// them in: the pins, the computed ceilings, the per-circuit totals, the two
/// caps and the band.
fn allowed_figures() -> Vec<u64> {
    let mut allowed: Vec<u64> = vec![
        MAX_CU_PER_IX,
        UNIFORM_PROOF_SIZE as u64,
        CU_BAND_ROUNDING,
        CU_BAND_NUMERATOR,
    ];
    for c in CU_CEILINGS.iter() {
        allowed.push(c.phase1_measured);
        allowed.push(c.phase1_max);
        if let Some(m) = c.phase2_measured {
            allowed.push(m);
            allowed.push(c.phase1_measured + m);
        }
        if let Some(m) = c.phase2_max {
            allowed.push(m);
        }
    }
    for (_, _, cu, _) in INFERRED.iter() {
        allowed.push(*cu);
    }
    allowed
}

/// Every comment line in this file, marker stripped and whitespace collapsed, so
/// a sentence wrapped across three `///` lines matches as one string.
fn comment_prose() -> String {
    let mut words: Vec<&str> = Vec::new();
    for line in THIS_FILE.lines() {
        let t = line.trim_start();
        let body = t
            .strip_prefix("//!")
            .or_else(|| t.strip_prefix("///"))
            .or_else(|| t.strip_prefix("//"));
        if let Some(b) = body {
            words.extend(b.split_whitespace());
        }
    }
    words.join(" ")
}

/// Every comma-grouped integer in `s`, as (token, value).
///
/// Comma-grouped on purpose: that is how this file writes CU figures in prose,
/// while the constants themselves are underscore-grouped Rust literals. So this
/// reads the prose and never the code it is checking the prose against.
fn comma_grouped_numbers(s: &str) -> Vec<(String, u64)> {
    let c: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        if !c[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < c.len() {
            if c[i].is_ascii_digit() {
                i += 1;
            } else if c[i] == ','
                && i + 3 < c.len()
                && c[i + 1].is_ascii_digit()
                && c[i + 2].is_ascii_digit()
                && c[i + 3].is_ascii_digit()
            {
                i += 4;
            } else {
                break;
            }
        }
        let tok: String = c[start..i].iter().collect();
        if tok.contains(',') {
            if let Ok(v) = tok.replace(',', "").parse::<u64>() {
                out.push((tok, v));
            }
        }
    }
    out
}

/// Prose in this file may not quote a CU figure the constants do not produce.
///
/// Two checks, because a doc comment can go stale in two ways:
///
///   1. A figure appears in prose that matches no constant and no declared
///      historical figure. That is a number someone typed, and once the
///      constants move it is a number that used to be true.
///   2. The three summary sentences are DERIVED here and matched verbatim, so
///      "worst is C4 at 843,918" cannot survive C4 becoming C5, or 843,918
///      becoming anything else.
///
/// Between them, the `4b1347c3` failure mode — prose and constant disagreeing
/// with nothing red — is not reachable by editing either side alone.
#[test]
fn cu_ceiling_prose_matches_the_constants() {
    let prose = comment_prose();

    // --- derived, matched verbatim -----------------------------------------
    let worst1 = CU_CEILINGS
        .iter()
        .max_by_key(|c| c.phase1_measured)
        .expect("CU_CEILINGS is non-empty");
    let pct = (worst1.phase1_measured as f64 / MAX_CU_PER_IX as f64 * 100.0).round() as u64;
    let sentences = [
        format!(
            "Worst absolute is C{} at {} of {} ({}%)",
            worst1.circuit_id,
            thousands(worst1.phase1_measured),
            thousands(MAX_CU_PER_IX),
            pct,
        ),
        {
            let w = CU_CEILINGS
                .iter()
                .max_by_key(|c| c.phase1_measured + c.phase2_measured.unwrap_or(0))
                .unwrap();
            format!(
                "worst phase1+phase2 is C{} at {}",
                w.circuit_id,
                thousands(w.phase1_measured + w.phase2_measured.unwrap_or(0)),
            )
        },
        {
            let w = CU_CEILINGS
                .iter()
                .filter(|c| c.phase2_measured.is_some())
                .max_by_key(|c| c.phase2_measured.unwrap())
                .unwrap();
            format!(
                "Worst phase 2 alone is C{} at {}",
                w.circuit_id,
                thousands(w.phase2_measured.unwrap()),
            )
        },
        {
            let pins = CU_CEILINGS.len()
                + CU_CEILINGS.iter().filter(|c| c.phase2_measured.is_some()).count();
            format!("Every one of the {pins} numbers below")
        },
        {
            let pins = CU_CEILINGS.len()
                + CU_CEILINGS.iter().filter(|c| c.phase2_measured.is_some()).count();
            format!("prints `+0` on all {pins} pins")
        },
    ];
    for want in sentences.iter() {
        assert!(
            prose.contains(want.as_str()),
            "the doc comments in this file must contain, verbatim:\n    {want}\n\
             It is DERIVED from CU_CEILINGS / MAX_CU_PER_IX, so this is red because the \
             constants moved and the prose did not. Paste the line above into the \
             CU_CEILINGS doc block, replacing the stale one."
        );
    }

    // --- no unexplained figure anywhere in the prose ------------------------
    let allowed = allowed_figures();

    for (figure, why) in PROSE_FIGURES.iter() {
        assert!(
            !allowed.contains(figure),
            "PROSE_FIGURES lists {} ({why}) but a constant now produces it — drop the \
             allowlist entry so the prose is checked against the constant instead",
            thousands(*figure),
        );
        assert!(
            prose.contains(&thousands(*figure)),
            "PROSE_FIGURES lists {} ({why}) but no comment in this file contains it any \
             more. Delete the entry — an allowlist of numbers nobody wrote is how the \
             next stale figure gets waved through.",
            thousands(*figure),
        );
    }

    let unexplained: Vec<String> = comma_grouped_numbers(&prose)
        .into_iter()
        .filter(|(_, v)| !allowed.contains(v) && !PROSE_FIGURES.iter().any(|(f, _)| f == v))
        .map(|(tok, _)| tok)
        .collect();
    assert!(
        unexplained.is_empty(),
        "these figures appear in this file's comments but match no constant and no \
         PROSE_FIGURES entry: {unexplained:?}\n\
         A number in a comment that no constant produces is how commit 4b1347c3 shipped a \
         re-pin that moved only prose. Either it is a real pin — put it in CU_CEILINGS and \
         let the prose quote it — or it is historical/illustrative, in which case add it to \
         PROSE_FIGURES with the reason it is there."
    );
}

/// The workflow that runs this gate, embedded at COMPILE time — same reasoning
/// as `MOBILE_STARK_TS`: moving or renaming it must be a build failure here, not
/// a check that silently stops checking.
const CI_WORKFLOW: &str = include_str!("../../../.github/workflows/ci.yml");

/// Comma-grouped figures in `ci.yml` that sit inside the CU range but are not CU
/// pins. Same contract as `PROSE_FIGURES`: a reason each, checked both ways.
///
/// Deliberately SEPARATE from `PROSE_FIGURES` rather than layered on top of it.
/// MEASURED while building this: with `PROSE_FIGURES` also accepted here,
/// rewriting ci.yml's `538,666` to the stale `538,720` that this file quotes as
/// a historical mistake passed green — one file's list of known-wrong numbers
/// had become another file's permission to print them.
const CI_FIGURES: [(u64, &str); 3] = [
    (328_344, "p01_liquidity .so byte size, deep_ali_gate step — a size, not a CU pin"),
    (344_552, "p01_zkspl .so byte size, same step"),
    (1_399_000, "illustrative: what C0 could have become before a ceiling existed"),
];

/// `ci.yml` holds the only OTHER copy of a CU pin in this repo, and it is prose.
///
/// The `[CU]` block in the workflow explains the gate by quoting C0's phase-1
/// figure. That copy is exactly as capable of going stale as the one this file
/// used to carry, and further from anyone who would notice — so it is checked
/// against the same constants.
///
/// Scope: figures between the smallest recorded pin and the per-instruction cap,
/// which is the range a CU pin can occupy. Both bounds are DERIVED from
/// `CU_CEILINGS` and `MAX_CU_PER_IX`, not chosen. Byte sizes, chunk counts and
/// warning counts fall outside it and are none of this test's business.
#[test]
fn cu_ceiling_ci_workflow_cannot_hold_a_stale_copy_of_a_pin() {
    let floor = CU_CEILINGS
        .iter()
        .flat_map(|c| [Some(c.phase1_measured), c.phase2_measured])
        .flatten()
        .min()
        .expect("CU_CEILINGS is non-empty");
    let allowed = allowed_figures();

    let found = comma_grouped_numbers(CI_WORKFLOW);
    assert!(
        !found.is_empty(),
        "no comma-grouped figure found in ci.yml at all — this check is reading the wrong \
         file, or the workflow moved, and it is now vacuous"
    );
    assert!(
        found.iter().any(|(_, v)| *v == MAX_CU_PER_IX),
        "ci.yml no longer names the {} CU cap; this check is probably pointed at the wrong \
         block and would pass vacuously",
        thousands(MAX_CU_PER_IX),
    );

    for (figure, why) in CI_FIGURES.iter() {
        assert!(
            !allowed.contains(figure),
            "CI_FIGURES lists {} ({why}) but a constant now produces it — drop the entry",
            thousands(*figure),
        );
        assert!(
            found.iter().any(|(_, v)| v == figure),
            "CI_FIGURES lists {} ({why}) but ci.yml does not contain it any more. Delete \
             the entry rather than leave an allowlist of numbers nobody wrote.",
            thousands(*figure),
        );
    }

    let stale: Vec<String> = found
        .into_iter()
        .filter(|(_, v)| *v >= floor && *v <= MAX_CU_PER_IX)
        .filter(|(_, v)| !allowed.contains(v) && !CI_FIGURES.iter().any(|(f, _)| f == v))
        .map(|(tok, _)| tok)
        .collect();
    assert!(
        stale.is_empty(),
        ".github/workflows/ci.yml quotes these CU-range figures, and no constant in \
         CU_CEILINGS produces them: {stale:?}\n\
         The workflow comment is a second copy of the pins. If a pin moved, move it there \
         too; if the figure is not a CU pin at all, add it to CI_FIGURES with the reason."
    );
}

/// Integration-test targets under `tests/` that `ci.yml` deliberately does NOT
/// run, with the reason for each.
///
/// Empty is the correct state, and the entry cost is deliberately a written
/// reason: this list is a place to record a coverage hole, not a place to make
/// one quiet.
const CI_UNRUN_TEST_TARGETS: [(&str, &str); 0] = [];

/// `--test <name>` appears in `ci.yml` as a whole word.
///
/// A bare `contains` would let `--test cu_budget` be satisfied by a hypothetical
/// `--test cu_budget_extra`, which is the direction that produces a false green.
fn ci_names_test_target(name: &str) -> bool {
    let needle = format!("--test {name}");
    CI_WORKFLOW
        .match_indices(&needle)
        .any(|(i, _)| {
            CI_WORKFLOW[i + needle.len()..]
                .chars()
                .next()
                .is_none_or(char::is_whitespace)
        })
}

/// Every integration test in `tests/` is named in `ci.yml`, or excluded on purpose.
///
/// # Why this exists
///
/// `ci.yml` runs the verifier's integration tests by naming them one `--test` at a
/// time, and states the consequence itself: "this list IS the coverage, so a test
/// file that is not named above executes nowhere". That makes the workflow a
/// hand-maintained second copy of this directory, with the same standing to go
/// stale as the CU pins the test above guards — and it had.
///
/// MEASURED 2026-08-02, before this test existed: `tests/` held 15 targets,
/// `ci.yml` named 8. The seven that ran nowhere were `b2_bits_measured`,
/// `b2_segment_binding`, `c5_conservation_probe`, `c6_padding_rows`,
/// `honest_liveness`, `liveness_fix_attack` and `liveness_generator_semantics`.
/// Every one of them was green when finally run, which is the point: nothing was
/// broken, so nothing complained, and the coverage was absent anyway.
///
/// The directory is the enforcement and the workflow is the copy, so the
/// directory is read off disk here rather than mirrored into a list in this file.
#[test]
fn every_verifier_integration_test_target_is_named_in_ci() {
    let tests_dir = repo_root().join("programs/p01_stark_verifier/tests");
    let mut targets: Vec<String> = std::fs::read_dir(&tests_dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", tests_dir.display()))
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("rs"))
        .filter_map(|e| {
            e.path()
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })
        .collect();
    targets.sort();

    // Negative controls. Each of these failing silently would leave the loop
    // below iterating over nothing and reporting a clean directory.
    assert!(
        targets.len() >= 10,
        "only {} integration target(s) discovered in {} — this check is pointed at the \
         wrong directory and would pass vacuously: {targets:?}",
        targets.len(),
        tests_dir.display(),
    );
    assert!(
        targets.iter().any(|t| t == "cu_budget"),
        "the directory scan did not find this very file; it is reading the wrong path"
    );
    assert!(
        ci_names_test_target("cu_budget"),
        "ci.yml does not name `--test cu_budget`, yet this test only runs because CI runs \
         that target. The needle format is wrong, or the workflow moved, and every target \
         would now look unrun."
    );

    for (name, why) in CI_UNRUN_TEST_TARGETS.iter() {
        assert!(
            targets.iter().any(|t| t == name),
            "CI_UNRUN_TEST_TARGETS excuses `{name}` ({why}) but tests/{name}.rs does not \
             exist — delete the entry rather than carry an allowlist of absent files"
        );
        assert!(
            !ci_names_test_target(name),
            "CI_UNRUN_TEST_TARGETS excuses `{name}` ({why}) but ci.yml runs it now — drop \
             the entry"
        );
    }

    let unrun: Vec<&str> = targets
        .iter()
        .map(String::as_str)
        .filter(|t| !ci_names_test_target(t))
        .filter(|t| !CI_UNRUN_TEST_TARGETS.iter().any(|(n, _)| n == t))
        .collect();
    assert!(
        unrun.is_empty(),
        "\n\n  >>> CI COVERAGE DRIFT <<<\n  These integration tests exist in {} and no CI \
         step runs them, so they execute nowhere:\n\n    {unrun:?}\n\n  ci.yml runs the \
         verifier suite by naming each target, so an unnamed file is not covered by \
         anything — it only reads that way. Add\n    cargo test -p p01_stark_verifier \
         --release --test <name>\n  to the verifier step in .github/workflows/ci.yml, or \
         record the exclusion in CI_UNRUN_TEST_TARGETS with a reason.\n",
        tests_dir.display(),
    );
}

/// Tests in THIS file that `ci.yml`'s CU-budget step deliberately does not run.
///
/// Same contract as `CI_UNRUN_TEST_TARGETS`: the entry cost is a written reason,
/// each entry is checked both ways, and empty would be the ideal state.
const CI_UNRUN_CU_BUDGET_TESTS: [(&str, &str); 1] = [(
    "cu_budget_c7_phase2_probe",
    "its throwaway probe program's .so is gitignored, so a fresh checkout has no artifact \
     and the harness panics by design rather than measuring stale or absent bytecode",
)];

/// Every `#[test]` function name in this file, read out of this file.
///
/// The attribute is matched as a whole trimmed line, so the string literal that
/// spells it here is not itself a hit.
///
/// # [ADVERSARY 2026-08-03] Why this walks forward instead of reading line i+1
///
/// It used to require the `fn` to be on the line immediately after `#[test]`.
/// MEASURED, not argued: two genuine `#[test]`s were appended to this file, both
/// named so that `ci.yml`'s `--skip cu_budget_c7_phase2_probe` excludes them, so
/// both executed nowhere —
///
/// ```text
/// #[test]                                     #[test]
/// fn ..._adversary_plain() { .. }             #[should_panic(expected = "probe")]
///                                             fn ..._adversary_attrgap() { .. }
/// ```
///
/// `every_cu_budget_test_is_reachable_from_the_ci_filter` named the LEFT one and
/// reported the RIGHT one as covered. `#[should_panic]`, `#[ignore]` and
/// `#[cfg_attr(..)]` are the commonest attributes in Rust test code, and a guard
/// whose entire subject is "no test in this file executes nowhere" was blind to
/// every one of them. Neither of the scan's own negative controls can see this:
/// `names.len() >= 12` and "the scan found this very test" are both satisfied by
/// a scanner that silently under-counts.
///
/// So: skip attribute / comment / blank lines to reach the signature, and
/// **panic** if a `#[test]` yields no name at all. Under-reporting is the
/// failure mode that makes the gate above vacuous, so this fails closed.
fn cu_budget_test_names() -> Vec<String> {
    let attr = "#[test]";
    let lines: Vec<&str> = THIS_FILE.lines().collect();
    let mut names = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if l.trim() != attr {
            continue;
        }
        // Walk to the signature. Anything between the attribute and `fn` that is
        // an attribute, a comment, or blank is skipped; `#[cfg_attr(` spanning
        // several lines is covered because its continuation lines are neither a
        // `fn` nor a new `#[test]`.
        let mut found: Option<String> = None;
        for l2 in lines.iter().skip(i + 1).take(24) {
            let t = l2.trim_start();
            if t.trim() == attr {
                break; // ran into the next test without ever seeing a `fn`
            }
            // Strip the qualifiers a test fn is allowed to carry.
            let mut sig = t;
            for kw in ["pub(crate) ", "pub ", "async ", "unsafe ", "extern \"C\" "] {
                sig = sig.strip_prefix(kw).unwrap_or(sig);
            }
            if let Some(rest) = sig.strip_prefix("fn ") {
                found = rest.split('(').next().map(|n| n.trim().to_string());
                break;
            }
        }
        let name = found.unwrap_or_else(|| {
            panic!(
                "cu_budget.rs line {}: a `#[test]` attribute with no reachable `fn` signature \
                 within 24 lines. The scanner would silently drop this test and \
                 `every_cu_budget_test_is_reachable_from_the_ci_filter` would report it as \
                 covered — which is exactly the hole that made an attribute between `#[test]` \
                 and `fn` invisible. Teach the walk about this form rather than letting it \
                 under-count.",
                i + 1
            )
        });
        names.push(name);
    }
    names.sort();
    names
}

/// Every `--test cu_budget` invocation in `ci.yml`, with `\` continuations joined.
fn ci_cu_budget_invocations() -> Vec<String> {
    let needle = "cargo test -p p01_stark_verifier --release --test cu_budget";
    let lines: Vec<&str> = CI_WORKFLOW.lines().collect();
    let mut out = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim();
        let Some(rest) = t.strip_prefix(needle) else { continue };
        // Whole word: `--test cu_budget_extra` must not be read as this target.
        if !(rest.is_empty() || rest.starts_with(char::is_whitespace)) {
            continue;
        }
        let mut joined = String::new();
        let mut j = i;
        loop {
            let cur = lines[j].trim();
            let continues = cur.ends_with('\\');
            joined.push_str(cur.trim_end_matches('\\').trim_end());
            joined.push(' ');
            if !continues || j + 1 >= lines.len() {
                break;
            }
            j += 1;
        }
        out.push(joined);
    }
    out
}

/// libtest's selection arguments, as they appear after the `--` separator.
struct LibtestSelection {
    filters: Vec<String>,
    skips: Vec<String>,
    exact: bool,
}

impl LibtestSelection {
    /// libtest's own rule: `--skip` excludes, positional filters are an OR, and
    /// no positional filter at all selects everything. `--exact` turns both from
    /// substring into equality.
    fn would_run(&self, test_name: &str) -> bool {
        let hit = |pat: &String| {
            if self.exact {
                test_name == pat.as_str()
            } else {
                test_name.contains(pat.as_str())
            }
        };
        if self.skips.iter().any(hit) {
            return false;
        }
        self.filters.is_empty() || self.filters.iter().any(hit)
    }
}

/// Parse the harness arguments of one shell invocation. Fails closed: an option
/// this parser has never seen could take a value, and guessing would silently
/// turn that value into a positional filter and change the answer.
fn parse_libtest_selection(cmd: &str) -> LibtestSelection {
    const FLAGS: [&str; 12] = [
        "--nocapture",
        "--exact",
        "--ignored",
        "--include-ignored",
        "--show-output",
        "--quiet",
        "-q",
        "--list",
        "--force-run-in-process",
        "--report-time",
        "--exclude-should-panic",
        "--bench",
    ];
    const TAKES_VALUE: [&str; 6] =
        ["--skip", "--test-threads", "--format", "--logfile", "--color", "--shuffle-seed"];

    let mut sel = LibtestSelection { filters: Vec::new(), skips: Vec::new(), exact: false };
    let mut toks = cmd.split_whitespace().skip_while(|t| *t != "--").skip(1);
    while let Some(tok) = toks.next() {
        let (name, inline) = match tok.split_once('=') {
            Some((n, v)) if n.starts_with('-') => (n, Some(v.to_string())),
            _ => (tok, None),
        };
        if !name.starts_with('-') {
            sel.filters.push(tok.to_string());
            continue;
        }
        if FLAGS.contains(&name) {
            if name == "--exact" {
                sel.exact = true;
            }
            continue;
        }
        assert!(
            TAKES_VALUE.contains(&name),
            "ci.yml passes `{name}` to the cu_budget harness and this parser does not know \
             whether it takes a value. Teach it, rather than letting an unrecognised option \
             turn its value into a positional filter and quietly change which tests run."
        );
        let value = inline.or_else(|| toks.next().map(str::to_string));
        if name == "--skip" {
            sel.skips.push(value.expect("--skip with no value"));
        }
    }
    sel
}

/// Every test in this file is executed by `ci.yml`, or excluded on purpose.
///
/// # Why this exists, and what it is a second copy of
///
/// `every_verifier_integration_test_target_is_named_in_ci` closes drift between
/// `tests/` and the `--test` lines in `ci.yml`. It does not — and cannot — close
/// the SAME hazard one level down: `ci.yml` runs this target with a hand-written
/// list of positional name filters, and libtest silently ignores a test that
/// matches none of them. A name list guarding a name list.
///
/// MEASURED on the merge of the two STARK lineages, 2026-08-03, before this test
/// existed. The step passed six filters — `cu_budget_real_circuits`,
/// `cu_budget_verify_uniform_path`, `cu_ceiling`, `build_fingerprint`,
/// `proof_size_envelope`, `toolchain_caveat`. Two tests matched no filter and so
/// executed nowhere:
///
///   * `every_verifier_integration_test_target_is_named_in_ci` — the drift gate
///     itself. The guard whose entire subject is "a test named nowhere in ci.yml
///     runs nowhere" was named nowhere in ci.yml.
///   * `harness_serialises_its_own_sbf_builds` — the assertion that the SBF tool
///     lock is real, added in the same window for the same reason.
///
/// Both were green when finally run, which is the point: nothing was broken, so
/// nothing complained, and the coverage was absent anyway.
///
/// The fix is the shape of the argument, not two more names. `ci.yml` now passes
/// `--skip cu_budget_c7_phase2_probe` and NO positional filter, so a new test is
/// run by default and has to be excluded on purpose to be missed. This test is
/// what makes that hold: it works against whatever form the arguments take, so
/// reintroducing an inclusion list is allowed but cannot omit anything quietly.
#[test]
fn every_cu_budget_test_is_reachable_from_the_ci_filter() {
    let names = cu_budget_test_names();

    // Negative controls. Each of these failing silently leaves the loop below
    // iterating over nothing and reporting a clean workflow.
    assert!(
        names.len() >= 12,
        "only {} `#[test]` fn(s) parsed out of this file — the scanner is broken and this \
         check is vacuous: {names:?}",
        names.len()
    );
    assert!(
        names.iter().any(|n| n == "every_cu_budget_test_is_reachable_from_the_ci_filter"),
        "the scan did not find this very test; it is reading the wrong file or the wrong shape"
    );
    assert!(
        names.iter().any(|n| n == "cu_budget_real_circuits"),
        "the scan did not find the headline measurement test; the parser is wrong"
    );
    // [ADVERSARY 2026-08-03] The control that closes the hole the two controls
    // above cannot see. `names.len() >= 12` and "it found itself" are both
    // satisfied by a scanner that silently drops tests, and one did: a `#[test]`
    // with `#[should_panic]` between it and the `fn` was invisible, so this gate
    // reported an unrun test as covered. This is an EQUALITY against an
    // independent count of the attribute itself, so any under-count — including
    // a revert of `cu_budget_test_names` to its read-the-next-line form — is a
    // red here rather than a quieter gate.
    let attr_lines = THIS_FILE.lines().filter(|l| l.trim() == "#[test]").count();
    assert_eq!(
        names.len(),
        attr_lines,
        "the scan produced {} names from {attr_lines} `#[test]` attributes in this file. \
         Every missing name is a test this gate then reports as covered without looking at \
         it. Fix `cu_budget_test_names`, do not relax this count.",
        names.len()
    );

    let invocations = ci_cu_budget_invocations();
    assert_eq!(
        invocations.len(),
        1,
        "expected exactly one `--test cu_budget` invocation in ci.yml, found {}. If the step \
         was split, this check must consider a test covered when ANY invocation runs it — \
         it currently reads one. {invocations:?}",
        invocations.len()
    );
    let sel = parse_libtest_selection(&invocations[0]);
    assert!(
        sel.would_run("cu_budget_real_circuits"),
        "the parsed selection would not run the headline measurement test, which ci.yml \
         demonstrably does run. The argument parser is wrong, and every verdict below is \
         noise. Parsed from: {}",
        invocations[0]
    );

    for (name, why) in CI_UNRUN_CU_BUDGET_TESTS.iter() {
        assert!(
            names.iter().any(|n| n == name),
            "CI_UNRUN_CU_BUDGET_TESTS excuses `{name}` ({why}) but this file has no such \
             test — delete the entry rather than carry an allowlist of absent tests"
        );
        assert!(
            !sel.would_run(name),
            "CI_UNRUN_CU_BUDGET_TESTS excuses `{name}` ({why}) but ci.yml runs it now — \
             drop the entry"
        );
    }

    let unrun: Vec<&str> = names
        .iter()
        .map(String::as_str)
        .filter(|n| !sel.would_run(n))
        .filter(|n| !CI_UNRUN_CU_BUDGET_TESTS.iter().any(|(e, _)| e == n))
        .collect();
    assert!(
        unrun.is_empty(),
        "\n\n  >>> CI FILTER DRIFT <<<\n  These tests live in tests/cu_budget.rs and ci.yml's \
         CU-budget step selects none of them, so they execute nowhere:\n\n    {unrun:?}\n\n  \
         The step's harness arguments are the coverage. Prefer removing the positional \
         filters entirely (`--skip <name>` for the one genuine exclusion) over appending \
         names, or record the exclusion in CI_UNRUN_CU_BUDGET_TESTS with a reason.\n  \
         Parsed from: {}\n",
        invocations[0]
    );
}

/// `.gitignore`, embedded at COMPILE time for the same reason as `CI_WORKFLOW`.
const GITIGNORE: &str = include_str!("../../../.gitignore");

/// Every `scripts/*` file `ci.yml` invokes is on disk AND is not gitignored.
///
/// # Why this exists, and what it caught
///
/// `.gitignore` excludes the WHOLE `scripts/` directory (`/scripts/*`) and adds
/// the handful of committed files back one negation at a time. Its own comment
/// records that this has already burned this repo once: `package.json` declared
/// `sync-program-ids` against a path `git ls-files` never had a match for, for
/// months.
///
/// MEASURED 2026-08-03, while writing the step this test guards: exactly the
/// same thing happened again. `scripts/dead-code-set.mjs` was written, `git
/// status` reported a CLEAN tree because the file was ignored, and a BLOCKING
/// ci.yml step already invoked it. Committing that would have pushed a workflow
/// whose gate fails on `MODULE_NOT_FOUND` — and the local tree would have looked
/// perfect. `git status` is not a coverage check when a directory is ignored
/// wholesale; a missing negation is invisible to every other gate here.
///
/// This reads `.gitignore` rather than shelling out to `git`, so it needs no
/// repository and gives the same answer in a source tarball.
#[test]
fn every_script_ci_invokes_is_on_disk_and_not_gitignored() {
    // Every repo-relative script path ci.yml runs. `packages/stark-prover/
    // scripts/deployed-verifier-check.mjs` counts as much as `scripts/x.mjs`,
    // so the whole path is taken, not the tail after the last `scripts/` —
    // MEASURED while writing this: the tail-only form reported
    // `deployed-verifier-check.mjs` as a ROOT script and failed on a file that
    // is present and tracked exactly where ci.yml says it is.
    fn path_ch(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '/'
    }
    let bytes = CI_WORKFLOW.as_bytes();
    let mut invoked: Vec<String> = Vec::new();
    for (i, _) in CI_WORKFLOW.match_indices("scripts/") {
        // Walk left to the start of the path token, so a nested `scripts/`
        // keeps its package prefix instead of masquerading as a root one.
        let mut start = i;
        while start > 0 && path_ch(bytes[start - 1] as char) {
            start -= 1;
        }
        let rest = &CI_WORKFLOW[i + "scripts/".len()..];
        let end = rest.find(|c: char| !path_ch(c)).unwrap_or(rest.len());
        let path = &CI_WORKFLOW[start..i + "scripts/".len() + end];
        // Files only — a bare directory prefix is not something CI runs.
        if path.ends_with(".mjs") || path.ends_with(".js") || path.ends_with(".sh") {
            let owned = path.to_string();
            if !invoked.contains(&owned) {
                invoked.push(owned);
            }
        }
    }
    invoked.sort();

    // Negative controls. Without these, a scanner that found nothing would
    // report a clean workflow.
    assert!(
        !invoked.is_empty(),
        "no `scripts/<file>` invocation was parsed out of ci.yml at all — the scanner is \
         broken and this check is vacuous"
    );
    assert!(
        invoked.iter().any(|s| s == "scripts/sync-program-ids.mjs"),
        "the scan did not find `scripts/sync-program-ids.mjs`, which ci.yml demonstrably \
         runs. The needle shape is wrong and every verdict below is noise. Found: {invoked:?}"
    );
    assert!(
        invoked
            .iter()
            .any(|s| s == "packages/stark-prover/scripts/deployed-verifier-check.mjs"),
        "the scan did not find the deployed-verifier interlock script at its FULL path, so \
         it is truncating nested paths and would judge them against the wrong directory. \
         Found: {invoked:?}"
    );
    assert!(
        GITIGNORE.lines().any(|l| l.trim() == "/scripts/*"),
        "`.gitignore` no longer excludes `/scripts/*`, so the negation reasoning below does \
         not apply. Either the exclusion moved — re-point this check — or scripts/ is \
         tracked normally now and this check can go."
    );

    let negated: Vec<&str> = GITIGNORE
        .lines()
        .map(str::trim)
        .filter_map(|l| l.strip_prefix("!/scripts/"))
        .collect();
    assert!(
        !negated.is_empty(),
        "`.gitignore` excludes `/scripts/*` and negates nothing, yet ci.yml runs \
         {invoked:?}. Either the negation syntax changed — re-point this check — or every \
         root script CI runs is uncommitted."
    );

    for path in &invoked {
        let on_disk = repo_root().join(path);
        assert!(
            on_disk.exists(),
            "ci.yml invokes `{path}` and {} does not exist. The step would fail on a \
             missing file, not on the thing it checks.",
            on_disk.display()
        );
        // Only the repo-root `scripts/` directory is excluded wholesale, so
        // only those need a negation. A package's own scripts/ is tracked
        // normally and asserting a negation for one would be wrong.
        if let Some(name) = path.strip_prefix("scripts/") {
            assert!(
                negated.contains(&name),
                "\n\n  >>> A CI SCRIPT IS GITIGNORED <<<\n  ci.yml runs `{path}`, the file \
                 exists locally, and `.gitignore` excludes `/scripts/*` without a \
                 `!/scripts/{name}` negation.\n\n  So it is NOT committed, `git status` \
                 shows a clean tree, and the workflow step that runs it fails on a file \
                 nobody can see is absent.\n  Add `!/scripts/{name}` to .gitignore.\n  \
                 Negations present: {negated:?}\n"
            );
        }
    }
}

/// The prose check must be capable of failing, on a file where it never does.
///
/// Same reasoning as every other negative control here: `comma_grouped_numbers`
/// returning an empty vec, or `comment_prose` returning an empty string, would
/// make the test above pass unconditionally and read exactly like a clean file.
#[test]
fn cu_ceiling_prose_scanner_actually_finds_numbers() {
    let prose = comment_prose();
    assert!(
        prose.len() > 10_000,
        "comment_prose() returned {} chars — it is not reading this file's comments, so \
         cu_ceiling_prose_matches_the_constants is vacuous",
        prose.len()
    );
    let found = comma_grouped_numbers(&prose);
    assert!(
        found.len() >= 10,
        "only {} comma-grouped figures found in the prose; the scanner is broken and the \
         prose gate is vacuous: {found:?}",
        found.len()
    );
    assert!(
        found.iter().any(|(_, v)| *v == CU_CEILINGS[0].phase1_measured),
        "the scanner did not find C0's pinned phase-1 figure in the prose that quotes it"
    );

    // Shape: grouping, boundaries, and the things that must NOT parse as figures.
    let probe = comma_grouped_numbers(
        "1,400,000 cap; at 950,461, still; v1.52 and 2026-07-30 and 145,000 B and 12,34",
    );
    let values: Vec<u64> = probe.iter().map(|(_, v)| *v).collect();
    assert_eq!(
        values,
        vec![1_400_000, 950_461, 145_000],
        "unexpected parse: {probe:?} — a version, a date and a mis-grouped number must not \
         be read as CU figures, and a trailing comma must not swallow the next word"
    );
}

fn ceiling_for(circuit_id: u8) -> &'static CuCeiling {
    CU_CEILINGS
        .iter()
        .find(|c| c.circuit_id == circuit_id)
        .unwrap_or_else(|| panic!("no CU ceiling declared for circuit {circuit_id} — add one"))
}

/// The Rust copy of the envelope must equal the client's definition of it.
///
/// Two constants in two languages with no link between them drift, and the
/// direction that hurts is the client SHRINKING the envelope while Rust keeps
/// gating on the old, larger number: the gate stays green and the phone still
/// throws. So the value is parsed out of the TypeScript at test time and the
/// literal is only ever a cross-check.
#[test]
fn proof_size_envelope_matches_the_mobile_client_constant() {
    let from_client = uniform_proof_size_from_the_mobile_client();
    assert_eq!(
        UNIFORM_PROOF_SIZE, from_client,
        "UNIFORM_PROOF_SIZE is {UNIFORM_PROOF_SIZE} here and {from_client} in \
         apps/mobile/services/stark/index.ts. The client is the source of truth — it is what \
         pads and what throws — so update this constant, not that one."
    );
}

/// The envelope check must be capable of failing, on a tree where it never does.
///
/// Same reasoning as `cu_ceiling_check_rejects_a_regression_...`: on a healthy
/// repo the largest proof is C4 at 81,457 B against a 145,000 B envelope, so the
/// reject path of `check_proof_size_envelope` is never taken by a real row and
/// "return no violations, always" would look exactly like a working gate.
#[test]
fn proof_size_envelope_check_rejects_an_oversized_proof() {
    fn sized(circuit_id: u8, proof_bytes: usize) -> CircuitRow {
        CircuitRow {
            proof_bytes,
            ..synthetic_row(
                circuit_id,
                Measured::NotApplicable("synthetic"),
                Measured::NotApplicable("synthetic"),
            )
        }
    }

    // Positive control: at the envelope exactly, and one byte under it.
    let fits = vec![sized(0, UNIFORM_PROOF_SIZE), sized(1, UNIFORM_PROOF_SIZE - 1)];
    assert!(
        check_proof_size_envelope(&fits).is_empty(),
        "the envelope is inclusive — a proof of exactly UNIFORM_PROOF_SIZE pads to itself"
    );

    // Negative control: one byte over.
    let over = vec![sized(4, UNIFORM_PROOF_SIZE + 1)];
    let v = check_proof_size_envelope(&over);
    assert_eq!(v.len(), 1, "expected exactly one violation, got {v:?}");
    assert!(v[0].contains("C4"), "violation should name the circuit: {}", v[0]);
    assert!(
        v[0].contains("1 B over"),
        "violation should quote the measured overshoot: {}",
        v[0]
    );

    // The C7 projection, so the number in the plan is exercised rather than
    // merely cited: docs/C7_SPEND_CIRCUIT_PLAN.md:15 estimates ~160 KB.
    let c7 = vec![sized(7, 160_000)];
    let v = check_proof_size_envelope(&c7);
    assert_eq!(v.len(), 1, "the projected C7 proof must not fit the current envelope: {v:?}");
    assert!(v[0].contains("15,000 B over"), "unexpected message: {}", v[0]);
}

/// One pin: a recorded baseline, the ceiling computed from it, and what this run
/// measured. Phase 1 and phase 2 are the same shape, so they render identically.
///
/// They did not. Phase 1 had a `vs measured` drift column; phase 2 had no table
/// at all, only an assertion. Since the assertion is a 2% RATCHET and not an
/// equality (see `CU_CEILINGS`, which explains why an equality pin would be
/// deleted), a phase-2 movement of up to +2% was both unasserted AND invisible:
/// C5 phase 2 could go 201,422 -> 206,000 and every line of output would still
/// read `ok`. B2 raises the FRI blowup and moves both phases at once, so
/// without this column B2's cost on phase 2 would be a number nobody printed.
struct Pin {
    circuit_id: u8,
    label: String,
    /// The baseline in `CU_CEILINGS`; `None` where the instruction is
    /// structurally absent (C0 has no phase-2 ix).
    recorded: Option<u64>,
    ceiling: Option<u64>,
    /// This run's clean measurement, `None` if it did not measure cleanly.
    now: Option<u64>,
}

/// What a measurement did, relative to its baseline and its ceiling.
///
/// Four states, not two. `OVER` is the only one that fails; `DRIFT` and
/// `IMPROVED` are reporting. The doc on `check_cu_ceilings` has claimed since it
/// was written that a circuit coming in under its baseline "is printed as
/// `IMPROVED`" — it was not, the verdict cell only ever held `OVER` or `ok`.
fn pin_verdict(now: u64, recorded: u64, ceiling: u64) -> &'static str {
    if now > ceiling {
        "OVER"
    } else if now > recorded {
        "DRIFT"
    } else if now < recorded {
        "IMPROVED"
    } else {
        "ok"
    }
}

/// Render one phase's pin table. Returns (lines, pins measured, pins drifted).
fn pin_table(header: &str, phase: &str, pins: &[Pin]) -> (Vec<String>, usize, usize) {
    let mut lines = Vec::new();
    let mut measured = 0usize;
    let mut drifted = 0usize;

    lines.push(rule(104));
    lines.push(header.to_string());
    lines.push(rule(104));
    lines.push(format!(
        "{:<26} {:>13} {:>13} {:>13} {:>10} {:>12}",
        "circuit",
        format!("{phase} recorded"),
        format!("{phase} now"),
        format!("{phase} ceiling"),
        "verdict",
        "vs recorded",
    ));
    lines.push(rule(104));
    for p in pins {
        let (now, verdict, drift) = match (p.now, p.recorded, p.ceiling) {
            (Some(cu), Some(rec), Some(max)) => {
                measured += 1;
                if cu != rec {
                    drifted += 1;
                }
                (
                    thousands(cu),
                    pin_verdict(cu, rec, max),
                    format!("{:+}", cu as i64 - rec as i64),
                )
            }
            // A baseline with no ceiling is already rejected by
            // `cu_ceilings_are_two_percent_over_the_recorded_measurement`. If one
            // ever reaches here, name it rather than render a blank cell.
            (Some(cu), Some(rec), None) => (
                thousands(cu),
                "NO CEILING",
                format!("{:+}", cu as i64 - rec as i64),
            ),
            // Measured where the table says there is no instruction at all.
            (Some(cu), None, _) => (thousands(cu), "STRUCTURAL", "-".to_string()),
            (None, None, _) => ("n/a".to_string(), "n/a", "-".to_string()),
            (None, Some(_), _) => ("-".to_string(), "NOT MEASURED", "-".to_string()),
        };
        lines.push(format!(
            "{:<26} {:>13} {:>13} {:>13} {:>10} {:>12}",
            p.label,
            p.recorded.map(thousands).unwrap_or_else(|| "n/a".into()),
            now,
            p.ceiling.map(thousands).unwrap_or_else(|| "n/a".into()),
            verdict,
            drift,
        ));
    }
    lines.push(rule(104));
    (lines, measured, drifted)
}

/// Everything the ceiling gate produces: what to print, and what to fail on.
struct CeilingReport {
    lines: Vec<String>,
    violations: Vec<String>,
    /// Pins that produced a clean number against a recorded baseline.
    measured: usize,
    /// Of those, how many differ from the baseline in either direction.
    drifted: usize,
}

/// Build the pin tables and collect every violation.
///
/// Two-sided reporting, one-sided assertion: a circuit that came in under its
/// recorded measurement is printed as `IMPROVED` (the ceiling is not there to
/// stop that), one that came in over it but under the ceiling is printed as
/// `DRIFT`, and only `OVER` is a violation.
///
/// # Why drift is reported and not asserted
///
/// The band is deliberately a ratchet — the reasoning is on `CU_CEILINGS` and
/// it is a founder decision, not this function's to overturn. Sizing a tighter
/// hard band from measurement does not work either: CU is deterministic for a
/// given (bytecode, witness) pair, and these thirteen pins have reproduced at
/// exactly `+0` on every run that has measured them, so the measured
/// run-to-run variance is 0. A band of 0 IS the equality pin that was rejected;
/// any other number would be one nobody measured. So the honest instrument is
/// the one below: make the movement legible, keep the 2% ratchet as the
/// assertion, and let whoever owns the trade-off see the drift and decide.
fn ceiling_report(rows: &[CircuitRow], caveat: Option<&str>) -> CeilingReport {
    let mut violations: Vec<String> = Vec::new();
    let mut lines: Vec<String> = vec![
        String::new(),
        rule(104),
        "CU CEILINGS — the regression gate (upper bound; ratchet, not an equality pin)".into(),
        rule(104),
    ];
    match caveat {
        Some(note) => lines.push(format!("!! {note}")),
        None => lines.push(format!(
            "toolchain: built with `{CU_MEASURED_WITH}`, the compiler CU_CEILINGS was measured \
             with — a failure below is a regression, not a compiler difference"
        )),
    }

    let mut phase1: Vec<Pin> = Vec::new();
    let mut phase2: Vec<Pin> = Vec::new();
    for r in rows {
        let c = ceiling_for(r.circuit_id);
        let label = format!("{} (id {})", r.label, r.circuit_id);
        phase1.push(Pin {
            circuit_id: r.circuit_id,
            label: label.clone(),
            recorded: Some(c.phase1_measured),
            ceiling: Some(c.phase1_max),
            now: r.phase1.cu_if_ok(),
        });
        phase2.push(Pin {
            circuit_id: r.circuit_id,
            label,
            recorded: c.phase2_measured,
            ceiling: c.phase2_max,
            now: r.phase2.cu_if_ok(),
        });
    }

    let (t1, m1, d1) = pin_table("PHASE 1", "ph1", &phase1);
    lines.extend(t1);
    let (t2, m2, d2) = pin_table(
        "PHASE 2  (C0 has no phase-2 ix — structurally absent, not unmeasured)",
        "ph2",
        &phase2,
    );
    lines.push(String::new());
    lines.extend(t2);

    for (phase, p) in phase1
        .iter()
        .map(|p| (1, p))
        .chain(phase2.iter().map(|p| (2, p)))
    {
        match (p.now, p.ceiling) {
            (Some(cu), Some(max)) if cu > max => violations.push(format!(
                "C{} phase {}: {} CU > ceiling {} (recorded measurement {})",
                p.circuit_id,
                phase,
                thousands(cu),
                thousands(max),
                p.recorded.map(thousands).unwrap_or_else(|| "-".into()),
            )),
            // A circuit that grew an instruction the table says is absent is a
            // structural change, not a CU regression — but it must not slip
            // through unremarked either.
            (Some(cu), None) => violations.push(format!(
                "C{} phase {} measured at {} CU but CU_CEILINGS declares it structurally absent \
                 — the dispatch changed; add a ceiling",
                p.circuit_id,
                phase,
                thousands(cu),
            )),
            _ => {}
        }
    }

    let measured = m1 + m2;
    let drifted = d1 + d2;
    lines.push(format!(
        "        {} of {} pins moved from their recorded measurement ({} on phase 1, {} on \
         phase 2).",
        drifted, measured, d1, d2,
    ));
    lines.push(
        "        Drift is REPORTED, not asserted — the assertion is the 2% ceiling, and the\n        \
         reasoning for a ratchet rather than an equality pin is on CU_CEILINGS. These pins\n        \
         have reproduced at +0 on every run that measured them, so a tighter hard band would\n        \
         either be 0 (the equality pin that was rejected) or a number nobody measured.\n        \
         A number over its CEILING fails this test. Raise the ceiling in the same commit\n        \
         that raises the cost, and say why — do not widen the band to clear a red run."
            .to_string(),
    );

    // A violation is read on its own, in a CI log, by someone who did not see the
    // header. If the red is ambiguous, it has to say so where it is read.
    if let Some(note) = caveat {
        for v in violations.iter_mut() {
            v.push_str("\n      ");
            v.push_str(note);
        }
    }

    CeilingReport { lines, violations, measured, drifted }
}

/// Print the pin tables and return every violation.
fn check_cu_ceilings(rows: &[CircuitRow], caveat: Option<&str>) -> Vec<String> {
    let report = ceiling_report(rows, caveat);
    for line in &report.lines {
        println!("{line}");
    }
    report.violations
}

// ---------------------------------------------------------------------------
// Proof-size envelope — the client-side ceiling nothing in Rust was checking
// ---------------------------------------------------------------------------

/// Print the proof-size table and return every circuit that does not fit the
/// client's fixed-size envelope.
///
/// Both ceilings in this file are now checked here: `MAX_CU_PER_IX` bounds what
/// the chain will execute, `UNIFORM_PROOF_SIZE` bounds what the client can
/// upload. The second one had no assertion anywhere in the repo — `cu_budget`
/// carried `proof_bytes` on every row and only PRINTED it, and the largest
/// shipping proof (C4, 81,457 B) is comfortable enough that the gap was easy to
/// miss. `docs/C7_SPEND_CIRCUIT_PLAN.md:15` already projects ~160 KB for C7,
/// which is over the envelope, so this is the check that turns that from a
/// sentence in a plan into a red run.
fn check_proof_size_envelope(rows: &[CircuitRow]) -> Vec<String> {
    let mut violations: Vec<String> = Vec::new();

    println!("\n{}", rule(104));
    println!(
        "PROOF SIZE vs the client envelope — UNIFORM_PROOF_SIZE = {} B \
         (apps/mobile/services/stark/index.ts:73)",
        thousands(UNIFORM_PROOF_SIZE as u64)
    );
    println!("{}", rule(104));
    println!(
        "{:<26} {:>13} {:>13} {:>13} {:>10}",
        "circuit", "proof B", "envelope B", "headroom B", "verdict"
    );
    println!("{}", rule(104));
    for r in rows {
        let fits = r.proof_bytes <= UNIFORM_PROOF_SIZE;
        println!(
            "{:<26} {:>13} {:>13} {:>13} {:>10}",
            format!("{} (id {})", r.label, r.circuit_id),
            thousands(r.proof_bytes as u64),
            thousands(UNIFORM_PROOF_SIZE as u64),
            if fits {
                thousands((UNIFORM_PROOF_SIZE - r.proof_bytes) as u64)
            } else {
                format!("-{}", thousands((r.proof_bytes - UNIFORM_PROOF_SIZE) as u64))
            },
            if fits { "ok" } else { "OVER" },
        );
        if !fits {
            violations.push(format!(
                "C{} ({}): proof is {} B, {} B over the {} B client envelope — \
                 `padProofToUniform` (apps/mobile/services/stark/index.ts:347) throws on it, \
                 so this circuit cannot be uploaded from the mobile client at all",
                r.circuit_id,
                r.label,
                thousands(r.proof_bytes as u64),
                thousands((r.proof_bytes - UNIFORM_PROOF_SIZE) as u64),
                thousands(UNIFORM_PROOF_SIZE as u64),
            ));
        }
    }
    println!("{}", rule(104));
    println!(
        "        Every proof is padded to the envelope before upload so the buffer length\n        \
         leaks nothing about which circuit ran. A proof OVER it cannot be padded and\n        \
         fails on the user's phone, after proving. Growing the envelope is a client and\n        \
         rent change, not a constant edit here — this number is read out of the client."
    );

    violations
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
    println!("binary   : {}", so.path().display());
    println!("size     : {} bytes", thousands(so_len as u64));
    println!("sha256   : {}", so_hash);
    println!("origin   : {}", so.provenance());
    println!("program  : {}", VERIFIER_ID);
    println!("cap      : {} CU per instruction", thousands(MAX_CU_PER_IX));

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

    let caveat = toolchain_caveat(&so);
    let ceiling_violations = check_cu_ceilings(&rows, caveat.as_deref());
    let size_violations = check_proof_size_envelope(&rows);

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
        so.path().display(),
        bad.join(", ")
    );
    assert_eq!(rows.len(), 7, "expected one row per circuit C0..C6");
    assert!(
        ceiling_violations.is_empty(),
        "CU CEILING EXCEEDED — this is the regression gate, not a formality:\n  {}",
        ceiling_violations.join("\n  "),
    );
    assert!(
        size_violations.is_empty(),
        "PROOF LARGER THAN THE CLIENT ENVELOPE — the proof cannot be padded to \
         UNIFORM_PROOF_SIZE and `padProofToUniform` throws on the user's phone:\n  {}",
        size_violations.join("\n  "),
    );
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
    println!(
        "binary   : {}  ({} bytes, sha256 {})",
        so.path().display(),
        thousands(so_len as u64),
        &so_hash[..16]
    );
    println!("origin   : {}", so.provenance());
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

// ===========================================================================
// L13 — the circuit-identity leak through PUBLIC transaction metadata
// ===========================================================================

/// Send one instruction and return BOTH its CU and the transaction's full log
/// vector.
///
/// `Rig::run` throws the logs away after scraping the `consumed` line. For L13
/// the logs ARE the measurement: a Solana transaction's log vector is public
/// metadata, served by every RPC to anyone who asks and retained by every
/// indexer. Reading the source to decide what a program discloses is exactly
/// the mistake this file exists to stop, so this helper reads the wire.
fn run_with_logs(rig: &mut Rig, ix: Instruction, program_id: &Address) -> (Measured, Vec<String>) {
    let msg = Message::new(
        &[set_cu_limit_ix(MAX_CU_PER_IX as u32), ix],
        Some(&rig.payer_pk),
    );
    let tx = Transaction::new(&[&rig.payer], msg, rig.svm.latest_blockhash());
    match rig.svm.send_transaction(tx) {
        Ok(meta) => {
            let logs = meta.logs.clone();
            let m = match program_cu(&meta.logs, program_id) {
                Some(cu) => Measured::Ok(cu),
                None => Measured::Failed {
                    cu: meta.compute_units_consumed,
                    err: "no `consumed` line for this program".into(),
                },
            };
            (m, logs)
        }
        Err(f) => {
            let logs = f.meta.logs.clone();
            (
                Measured::Failed {
                    cu: program_cu(&f.meta.logs, program_id)
                        .unwrap_or(f.meta.compute_units_consumed),
                    err: format!("{:?}", f.err),
                },
                logs,
            )
        }
    }
}

/// What one circuit's trip through the uniform path discloses.
struct UniformLeak {
    /// `verify_uniform`'s own CU, scraped from the runtime's `consumed` line.
    cu: Measured,
    /// Every log line of the `verify_uniform` transaction.
    logs: Vec<String>,
    /// Every log line of the `verify_deep_ali_phase2` transaction that follows
    /// it. The uniform flow is two transactions, so a log sweep that stops at
    /// the first one is a sweep that misses half the surface.
    phase2_logs: Vec<String>,
    /// `ProofBuffer::circuit_id` read off the raw account after the fact.
    circuit_id_in_account: u8,
    /// Chunks the padded proof took to upload.
    chunks: usize,
}

/// Drive the uniform path for one circuit and collect everything it discloses.
///
/// The proof is padded to `UNIFORM_PROOF_SIZE` exactly as the mobile client
/// pads it (`apps/mobile/services/stark/index.ts`), because the padding is half
/// of what L13 claims to close: without it the account length and the chunk
/// count identify the circuit before a single log line is read.
fn uniform_leak_probe(
    rig: &mut Rig,
    program: &Address,
    nonce_byte: u8,
    proof: &p01_stark::compact::GenericCompactProofData,
) -> UniformLeak {
    let authority = rig.payer_pk;
    let nonce = [nonce_byte; 16];
    let (buffer, _bump) =
        Address::find_program_address(&[b"stark_proof_v2", authority.as_ref(), &nonce], program);

    // Pad to the real client envelope. `from_bytes` ignores the tail, which is
    // measured in
    // `tests/wire_parity.rs::the_parser_does_not_check_length_this_test_does`.
    let mut padded = proof.proof_bytes.clone();
    assert!(
        padded.len() <= UNIFORM_PROOF_SIZE,
        "proof is {} B, over the {} B client envelope, so it cannot be padded and this probe \
         would be measuring a shape the client cannot send",
        padded.len(),
        UNIFORM_PROOF_SIZE
    );
    padded.resize(UNIFORM_PROOF_SIZE, 0u8);
    let proof_size = padded.len();

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
    let mut chunks = 0usize;
    while offset < proof_size {
        let end = (offset + CHUNK).min(proof_size);
        rig.must(
            ix_write_chunk(program, &buffer, &authority, offset as u32, &padded[offset..end]),
            "write_proof_chunk (v2)",
        );
        offset = end;
        chunks += 1;
    }

    let (cu, logs) = run_with_logs(
        rig,
        ix_with_public_inputs(
            program,
            &buffer,
            &authority,
            "verify_uniform",
            &proof.public_inputs,
        ),
        program,
    );

    // `ProofBuffer` layout: 8-byte anchor discriminator, then `authority`
    // (32 B), then `circuit_id` (1 B). Read the byte off the raw account the
    // way any RPC client would, not through the program's own types.
    let circuit_id_in_account = rig
        .svm
        .get_account(&buffer)
        .map(|a| a.data[8 + 32])
        .unwrap_or(u8::MAX);

    let phase2_logs = if cu.is_ok() {
        run_with_logs(
            rig,
            ix_with_public_inputs(
                program,
                &buffer,
                &authority,
                "verify_deep_ali_phase2",
                &proof.public_inputs,
            ),
            program,
        )
        .1
    } else {
        Vec::new()
    };

    UniformLeak { cu, logs, phase2_logs, circuit_id_in_account, chunks }
}

/// The four circuits `PROBE_ORDER` can resolve. C0/C2/C4 cannot reach this
/// instruction at all (measured in `tests/wire_parity.rs`), so they are not in
/// the anonymity set and including them would flatter the result.
fn uniform_leak_cases() -> Vec<(&'static str, u8, p01_stark::compact::GenericCompactProofData)> {
    let path_elements: Vec<u64> = (0..15u64).map(|i| 1000 + i).collect();
    let path_indices: Vec<u8> = (0..15u8).map(|i| i % 2).collect();
    let pe: Vec<u64> = (0..15).map(|i| 100u64 + i * 13).collect();
    let pi: Vec<u8> = (0..15).map(|i| (i % 2) as u8).collect();
    vec![
        (
            "C1 pool_commitment",
            1,
            p01_stark::compact::generate_pool_commitment_proof(42, 17, 7, 11),
        ),
        (
            "C3 merkle_path",
            3,
            p01_stark::compact::generate_merkle_path_compact_proof(
                777,
                &path_elements,
                &path_indices,
            ),
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
    ]
}

/// Keep only the lines the PROGRAM wrote. The runtime's own framing
/// (`Program <id> invoke [1]`, `... consumed N of M`, `... success`) is a
/// different channel with a different fix and is measured separately below.
fn program_log_lines(logs: &[String]) -> Vec<String> {
    logs.iter()
        .filter(|l| l.starts_with("Program log:") || l.starts_with("Program data:"))
        .cloned()
        .collect()
}

/// **L13.** `verify_uniform` exists so an observer cannot tell which circuit a
/// user proved. `init_proof_buffer_v2` removes `circuit_id` from the PDA seeds,
/// `UNIFORM_PROOF_SIZE` padding removes it from the account length and the
/// chunk count, and the probe loop removes it from the instruction data. This
/// test checks the one public channel the design never covered: **the
/// transaction log vector**.
///
/// The assertion is deliberately not "no line contains the digit 5". It is that
/// the four circuits' program-emitted transcripts are **byte-identical**. That
/// is what indistinguishability means, and it is the only form of the check
/// that a `msg!` added later cannot walk past.
#[test]
fn l13_uniform_path_program_logs_are_identical_across_circuits() {
    let mut rig = Rig::new();
    let program = Address::from_str(VERIFIER_ID).unwrap();
    let (_so, _len, _hash) = load_verifier_or_fail(&mut rig, &program);

    let mut seen: Vec<(String, Vec<String>)> = Vec::new();
    let mut seen_p2: Vec<(String, Vec<String>)> = Vec::new();
    println!("\n{}", rule(104));
    println!("L13 - program-emitted log lines on the verify_uniform path");
    println!("{}", rule(104));
    for (label, nonce, proof) in uniform_leak_cases() {
        let leak = uniform_leak_probe(&mut rig, &program, nonce, &proof);
        assert!(
            leak.cu.is_ok(),
            "{label}: verify_uniform did not succeed, so its logs are not the honest-path logs"
        );
        let lines = program_log_lines(&leak.logs);
        let p2 = program_log_lines(&leak.phase2_logs);
        println!("{label}: {} line(s) on verify_uniform", lines.len());
        for l in &lines {
            println!("    {l}");
        }
        println!("{label}: {} line(s) on verify_deep_ali_phase2", p2.len());
        for l in &p2 {
            println!("    {l}");
        }
        seen.push((label.to_string(), lines));
        seen_p2.push((label.to_string(), p2));
    }
    println!("{}", rule(104));

    // Negative control. `program_log_lines` filtering everything away would
    // make the comparison below trivially true on four empty vectors — the
    // hollow-green shape this repo keeps finding.
    assert!(
        seen.iter().all(|(_, l)| l.len() >= 5),
        "fewer than 5 program log lines captured — the filter or the probe is broken and the \
         identity check below would be vacuous: {seen:?}"
    );
    assert!(
        seen_p2.iter().all(|(_, l)| !l.is_empty()),
        "no phase-2 program log lines captured; the phase-2 half of this check is vacuous: \
         {seen_p2:?}"
    );

    let mut diverging: Vec<String> = Vec::new();
    for (what, group) in [("verify_uniform", &seen), ("verify_deep_ali_phase2", &seen_p2)] {
        let (base_label, base) = group[0].clone();
        for (label, lines) in group.iter().skip(1) {
            if *lines != base {
                diverging.push(format!(
                    "{what}: {label} differs from {base_label}:\n      {base_label}: {base:?}\n      {label}: {lines:?}"
                ));
            }
        }
    }
    assert!(
        diverging.is_empty(),
        "L13 IS OPEN - the uniform flow's log transcript identifies the circuit.\n\
         Transaction logs are public metadata: every RPC serves them and every indexer keeps \
         them, so a `msg!` here defeats the nonce-seeded PDA and the 145,000-byte padding that \
         exist to hide exactly this. Both transactions of the flow are checked, because fixing \
         only the first one re-publishes the id one transaction later.\n  {}",
        diverging.join("\n  ")
    );
}

/// **L13 residual.** Deleting the `msg!`s is necessary and not sufficient, and
/// this test exists so nobody can read the sibling test's green as "L13 is
/// closed". Two public channels survive an empty log transcript:
///
/// 1. **Compute units.** `Program <id> consumed N of 1400000 compute units` is
///    written by the runtime, not by the program, and N is a deterministic
///    function of the circuit. No `msg!` edit touches it.
/// 2. **Account data.** `verify_uniform` writes the circuit it discovered back
///    into `ProofBuffer::circuit_id` (`lib.rs`, `buffer.circuit_id = circuit_id`)
///    because `verify_deep_ali_phase2` reads it. Account data is public, so the
///    id is readable off chain state for as long as the buffer lives.
///
/// If this test ever goes RED that is a WIN, not a regression: it means someone
/// made the CU uniform or stopped persisting the id. Read the printed table,
/// confirm which channel closed, and retire the corresponding half - do not
/// relax the assertion.
#[test]
fn l13_is_not_closed_by_deleting_logs_two_public_channels_survive() {
    let mut rig = Rig::new();
    let program = Address::from_str(VERIFIER_ID).unwrap();
    let (_so, _len, _hash) = load_verifier_or_fail(&mut rig, &program);

    let mut rows: Vec<(String, u64, u8, usize)> = Vec::new();
    for (label, nonce, proof) in uniform_leak_cases() {
        let leak = uniform_leak_probe(&mut rig, &program, nonce, &proof);
        let cu = leak
            .cu
            .cu_if_ok()
            .unwrap_or_else(|| panic!("{label}: verify_uniform must succeed"));
        rows.push((label.to_string(), cu, leak.circuit_id_in_account, leak.chunks));
    }

    println!("\n{}", rule(104));
    println!("L13 RESIDUAL - what still identifies the circuit once every `msg!` is gone");
    println!("{}", rule(104));
    println!(
        "{:<26} {:>13} {:>18} {:>10}",
        "circuit", "uniform CU", "buffer.circuit_id", "chunks"
    );
    println!("{}", rule(104));
    for (label, cu, cid, chunks) in &rows {
        println!("{:<26} {:>13} {:>18} {:>10}", label, thousands(*cu), cid, chunks);
    }
    println!("{}", rule(104));
    println!(
        "        chunks are UNIFORM by construction (every proof padded to {} B) - that half of\n\
         \x20       the design works. CU and the persisted circuit_id are not covered by it.",
        thousands(UNIFORM_PROOF_SIZE as u64)
    );

    let uniform_chunks: std::collections::BTreeSet<usize> = rows.iter().map(|r| r.3).collect();
    assert_eq!(
        uniform_chunks.len(),
        1,
        "the padding half of L13 is broken: chunk counts differ across circuits: {:?}",
        rows.iter().map(|r| (&r.0, r.3)).collect::<Vec<_>>()
    );

    let distinct_cu: std::collections::BTreeSet<u64> = rows.iter().map(|r| r.1).collect();
    assert_eq!(
        distinct_cu.len(),
        rows.len(),
        "CU no longer separates all four circuits. If that is deliberate, L13's CU channel is \
         (partly) closed and this assertion should be RETIRED, not relaxed. rows: {:?}",
        rows.iter().map(|r| (&r.0, r.1)).collect::<Vec<_>>()
    );

    let persisted = rows.iter().filter(|r| r.2 != u8::MAX).count();
    assert_eq!(
        persisted,
        rows.len(),
        "verify_uniform no longer persists the discovered circuit id for every circuit. If that \
         is deliberate, check `verify_deep_ali_phase2` still has a source for it, then retire \
         this half. rows: {:?}",
        rows.iter().map(|r| (&r.0, r.2)).collect::<Vec<_>>()
    );
}

// ---------------------------------------------------------------------------
// `write_proof_chunk` — the account-length bound
// ---------------------------------------------------------------------------

/// What the program did with one `write_proof_chunk`, as a value rather than a
/// formatted string.
///
/// The distinction this enum exists to carry is the whole point of the test
/// below: a program that REJECTS a bad chunk and a program that CRASHES on it
/// both produce a failed transaction, and telling them apart by grepping a
/// Debug string is the same shape of check that has already let a hollow gate
/// through in this tree.
#[derive(Debug, PartialEq, Eq)]
enum ChunkOutcome {
    /// The write landed.
    Accepted,
    /// The program returned an error of its own — a `require!` fired. Carries
    /// the Anchor error number.
    Rejected(u32),
    /// The instruction did not complete on its own terms. An unhandled Rust
    /// panic inside SBF bytecode arrives here as `ProgramFailedToComplete`,
    /// and that is precisely the pre-fix behaviour.
    Crashed(String),
}

type SendResult = std::result::Result<Vec<String>, (TransactionError, Vec<String>)>;

fn chunk_outcome(r: SendResult) -> (ChunkOutcome, Vec<String>) {
    match r {
        Ok(logs) => (ChunkOutcome::Accepted, logs),
        Err((TransactionError::InstructionError(_, InstructionError::Custom(c)), logs)) => {
            (ChunkOutcome::Rejected(c), logs)
        }
        Err((e, logs)) => (ChunkOutcome::Crashed(format!("{e:?}")), logs),
    }
}

fn outcome_cell(o: &ChunkOutcome) -> String {
    match o {
        ChunkOutcome::Accepted => "accepted".to_string(),
        ChunkOutcome::Rejected(n) => format!("rejected {n}"),
        ChunkOutcome::Crashed(_) => "CRASHED".to_string(),
    }
}

/// One chunk write to attempt against the undersized buffer.
struct ChunkCase {
    label: &'static str,
    offset: u32,
    len: usize,
    want: ChunkOutcome,
    why: &'static str,
}

/// `write_proof_chunk` must bound the write against the account it is writing
/// into, not against the size the caller DECLARED at init.
///
/// # The defect
///
/// `ProofBuffer::init_space` caps the allocation at `MAX_INIT_SIZE` whatever
/// `proof_size` says, because `create_account` cannot exceed that many bytes.
/// Anything larger is meant to be grown afterwards by `resize_proof_buffer`.
/// Until that has happened the account is SHORTER than the declared
/// `proof_size`, and the only bound the chunk writer used to have was
/// `offset + data.len() <= proof_size`. A chunk that satisfies it and still
/// points past the end of the account indexed a slice out of range — an
/// unhandled panic, not an error.
///
/// # There are two defects here and only one of them was fixed
///
/// * `init_proof_buffer` accepting a `proof_size` its own allocation cannot
///   hold is SILENTLY ACCEPTED, before and after. Case A below measures it. It
///   is the enabling condition, it is still open, and it is not what the fix
///   changed.
/// * Writing past the end of the account PANICKED, and now returns
///   `ChunkOutOfBounds`. Cases B1/B2 are that one.
///
/// # Why the shape of the assertion matters
///
/// `Rejected` and `Crashed` are both failed transactions. A test that only
/// asserted "this chunk does not succeed" would have been green against the
/// pre-fix binary, which is the liveness trap this repo has paid for twice. The
/// assertion is on the OUTCOME VARIANT and on an error number derived from
/// `StarkVerifierError` itself, so renumbering the enum cannot make it lie
/// either.
///
/// Cases 0, C and E are the other half: an over-broad "fix" that refused
/// legitimate writes would pass B1/B2 and fail these.
#[test]
fn write_proof_chunk_is_bounded_by_the_real_account_length_not_the_declared_proof_size() {
    use p01_stark_verifier::{ProofBuffer, StarkVerifierError};

    let mut rig = Rig::new();
    let program = Address::from_str(VERIFIER_ID).unwrap();
    let (so, _len, _hash) = load_verifier_or_fail(&mut rig, &program);
    println!("\n{}", rule(104));
    println!("write_proof_chunk BOUNDS — real SBF bytecode, litesvm");
    println!("{}", rule(104));
    println!("  artifact: {}", so.provenance());

    // This file keeps its own copy of the layout constant so the harness can be
    // read without the program. Pin it to the real one rather than trusting the
    // comment next to it.
    assert_eq!(
        PROOF_DATA_OFFSET,
        ProofBuffer::PROOF_DATA_OFFSET,
        "this file's PROOF_DATA_OFFSET mirror has drifted from the program's"
    );
    let max_init = ProofBuffer::MAX_INIT_SIZE;
    let want_code = u32::from(StarkVerifierError::ChunkOutOfBounds);

    let authority = rig.payer_pk;

    // A declared size the init allocation provably cannot hold.
    const DECLARED: u32 = 20_000;
    assert!(
        PROOF_DATA_OFFSET + DECLARED as usize > max_init,
        "DECLARED must exceed what init_proof_buffer can allocate, or there is no gap to test"
    );

    // --- case A: init accepts a proof_size larger than the account ----------
    let circuit_id: u8 = 1;
    let (buffer, _bump) = Address::find_program_address(
        &[b"stark_proof", authority.as_ref(), &[circuit_id]],
        &program,
    );
    rig.must(
        ix_init_proof_buffer(&program, &buffer, &authority, DECLARED, circuit_id),
        "init_proof_buffer (undersized allocation, oversized declaration)",
    );
    let acct = rig
        .svm
        .get_account(&buffer)
        .expect("buffer must exist after init");
    let acct_len = acct.data.len();
    // Layout: 8 disc | 32 authority | 1 circuit_id | 4 proof_size | …
    let size_at = 8 + 32 + 1;
    let stored_proof_size =
        u32::from_le_bytes(acct.data[size_at..size_at + 4].try_into().unwrap());
    assert_eq!(
        acct_len, max_init,
        "init_space is expected to cap the allocation at MAX_INIT_SIZE"
    );
    assert_eq!(
        stored_proof_size, DECLARED,
        "the program stored the declared size verbatim"
    );
    assert!(
        PROOF_DATA_OFFSET + stored_proof_size as usize > acct_len,
        "CASE A NO LONGER HOLDS: init_proof_buffer now refuses (or allocates for) a proof_size \
         larger than its own allocation. That is an IMPROVEMENT and it closes the second, still-\
         open defect this test documents — but it also removes the gap cases B1/B2 exercise, so \
         rewrite them against whatever the new enabling condition is rather than deleting them."
    );
    let usable = acct_len - PROOF_DATA_OFFSET;

    // --- the cases ----------------------------------------------------------
    let cases = vec![
        ChunkCase {
            label: "0  well inside both bounds",
            offset: 0,
            len: 64,
            want: ChunkOutcome::Accepted,
            why: "positive control: the fix must not have made the writer refuse honest chunks",
        },
        ChunkCase {
            label: "B1 straddles the account end",
            offset: (usable - 32) as u32,
            len: 64,
            want: ChunkOutcome::Rejected(want_code),
            why: "inside the DECLARED proof_size, past the REAL account end — PANICKED pre-fix",
        },
        ChunkCase {
            label: "B2 far past the account end",
            offset: 15_000,
            len: 64,
            want: ChunkOutcome::Rejected(want_code),
            why: "same defect with no boundary arithmetic to hide behind — PANICKED pre-fix",
        },
        ChunkCase {
            label: "D  past the declared size",
            offset: DECLARED - 32,
            len: 64,
            want: ChunkOutcome::Rejected(want_code),
            why: "control: the PRE-EXISTING proof_size guard, rejected before and after the fix",
        },
        ChunkCase {
            label: "C  ends exactly at the account end",
            offset: (usable - 64) as u32,
            len: 64,
            want: ChunkOutcome::Accepted,
            why: "off-by-one guard: `end == len` is in bounds and must still be written",
        },
    ];

    println!(
        "  account {} B  |  declared proof_size {} B  |  writable region {} B",
        thousands(acct_len as u64),
        thousands(DECLARED as u64),
        thousands(usable as u64),
    );
    println!("{}", rule(104));
    println!(
        "{:<34} {:>8} {:>6} {:>10} {:>13}  {}",
        "case", "offset", "len", "end", "outcome", "vs account"
    );
    println!("{}", rule(104));

    let mut wrong: Vec<String> = Vec::new();
    for c in &cases {
        let fill = vec![0xC3u8 ^ (c.offset as u8); c.len];
        let end = PROOF_DATA_OFFSET + c.offset as usize + c.len;
        let (got, logs) = chunk_outcome(rig.try_run(ix_write_chunk(
            &program,
            &buffer,
            &authority,
            c.offset,
            &fill,
        )));
        println!(
            "{:<34} {:>8} {:>6} {:>10} {:>13}  {}",
            c.label,
            c.offset,
            c.len,
            end,
            outcome_cell(&got),
            if end <= acct_len { "in bounds" } else { "PAST END" },
        );
        if got != c.want {
            wrong.push(format!(
                "{}: want {:?}, got {:?}\n      why this case exists: {}\n      last logs: {:?}",
                c.label,
                c.want,
                got,
                c.why,
                tail(&logs, 4),
            ));
        }
        // An accepted write must actually have landed. An "accepted" that wrote
        // nothing is the same false green in the other direction.
        if matches!(c.want, ChunkOutcome::Accepted) && got == ChunkOutcome::Accepted {
            let data = rig.svm.get_account(&buffer).expect("buffer").data;
            let start = PROOF_DATA_OFFSET + c.offset as usize;
            assert_eq!(
                &data[start..start + c.len],
                &fill[..],
                "{}: the transaction succeeded but the bytes are not in the account",
                c.label
            );
        }
    }
    println!("{}", rule(104));

    // --- case E: the same far write, on a buffer that was actually grown ----
    //
    // The bound is against the account, so growing the account must make the
    // write legal. Without this the test could be satisfied by a program that
    // simply refuses every large proof, which would break every circuit whose
    // proof exceeds the init cap — i.e. all of them.
    let circuit_id_big: u8 = 3;
    let (big, _b) = Address::find_program_address(
        &[b"stark_proof", authority.as_ref(), &[circuit_id_big]],
        &program,
    );
    rig.must(
        ix_init_proof_buffer(&program, &big, &authority, DECLARED, circuit_id_big),
        "init_proof_buffer (to be grown)",
    );
    let target_len = PROOF_DATA_OFFSET + DECLARED as usize;
    let mut resizes = 0usize;
    while rig
        .svm
        .get_account(&big)
        .map(|a| a.data.len())
        .unwrap_or(0)
        < target_len
    {
        rig.must(
            ix_resize_proof_buffer(&program, &big, &authority),
            "resize_proof_buffer",
        );
        resizes += 1;
        assert!(
            resizes < 64,
            "resize_proof_buffer stopped growing the account before it reached {target_len} B"
        );
    }
    let grown_len = rig.svm.get_account(&big).expect("grown buffer").data.len();
    assert_eq!(grown_len, target_len, "the grown account is the declared size");

    let far_offset = DECLARED - 64;
    let fill = vec![0x5Au8; 64];
    let (got, logs) = chunk_outcome(rig.try_run(ix_write_chunk(
        &program,
        &big,
        &authority,
        far_offset,
        &fill,
    )));
    println!(
        "  E  same far write after {} resize(s): account {} B, offset {} -> {}",
        resizes,
        thousands(grown_len as u64),
        far_offset,
        outcome_cell(&got),
    );
    if got != ChunkOutcome::Accepted {
        wrong.push(format!(
            "E  grown buffer, last chunk: want Accepted, got {got:?}\n      \
             the account is exactly the declared size, so this write is in bounds by both \
             rules; refusing it breaks every proof larger than the init cap.\n      \
             last logs: {:?}",
            tail(&logs, 4),
        ));
    } else {
        let data = rig.svm.get_account(&big).expect("grown buffer").data;
        let start = PROOF_DATA_OFFSET + far_offset as usize;
        assert_eq!(
            &data[start..start + 64],
            &fill[..],
            "E: accepted but the bytes are not in the account"
        );
        assert_eq!(start + 64, grown_len, "E must end exactly at the account end");
    }
    println!("{}", rule(104));

    assert!(
        wrong.is_empty(),
        "write_proof_chunk does not bound the write the way it claims to.\n  {}\n\n\
         `Rejected` means a `require!` fired and the caller got a diagnosable error.\n\
         `Crashed` means the instruction did not complete — an out-of-range slice index \
         inside SBF bytecode surfaces as ProgramFailedToComplete, and that is the pre-fix \
         behaviour this test exists to keep out. They are not interchangeable and neither \
         one may be swapped for the other to make this green.",
        wrong.join("\n  "),
    );
}

