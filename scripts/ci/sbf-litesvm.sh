#!/usr/bin/env bash
# Build the SBF programs with the cargo-build-sbf that Anchor.toml pins, then run
# every litesvm suite against the bytes this run just built.
#
# Run by .github/workflows/sbf-litesvm.yml, and runnable as it is on a dev box
# (Linux, or Git Bash on Windows):
#
#   bash scripts/ci/sbf-litesvm.sh                  # selftest, build, zk, cu
#   bash scripts/ci/sbf-litesvm.sh build zk         # chosen stages, in order
#
# Stages (the toolchain check runs first, except for a selftest-only run):
#   selftest  the log reader below, against planted libtest logs it must accept
#             or reject; needs no toolchain and runs no cargo
#   build     cargo-build-sbf zk_shielded, p01_stark_verifier, the C7 probe and the
#             CU micro-benchmark probe into the out dir, and print the size and
#             sha256 of each .so
#   zk        every programs/zk_shielded/tests/*.rs that loads a program
#   cu        the verifier suites that load a program (cu_budget, l2_presized_buffers,
#             cu_microbench)
#
# Environment (all optional):
#   P01_SBF_OUT_DIR     where the .so files land   (default target/sbf-litesvm/deploy)
#   P01_SBF_TARGET_DIR  cargo target dir of the SBF builds (default target/sbf-litesvm/sbf)
#   P01_SBF_LOG_DIR     per-suite logs             (default target/sbf-litesvm/logs)
#   P01_SBF_BIN         a directory holding cargo-build-sbf, used instead of the
#                       install Anchor.toml pins (its --version is still checked)
#   CARGO_TARGET_DIR    cargo target dir of the host test builds
#
# Nothing here skips. A missing tool, a missing artifact, a suite that runs no
# test, a suite with an #[ignore]d test, and a suite that stays green when its
# artifact path points at a file that is not a program are all failures.
#
# WHY THE NEGATIVE CONTROL. Until WP0g (2026-09-18), two of the four
# zk_shielded suites read ONLY `target/deploy/zk_shielded.so`, whatever the
# caller had built, and `subscribe_v4_adversarial.rs` records what that cost: it
# "kept passing only because target/deploy/zk_shielded.so had not been rebuilt
# since 2026-08-19". So each suite first runs with its artifact path pointing at
# a file that is not a program. It must fail, and every test that fails must
# fail while loading the program. A suite that passes there, or fails for some
# other reason, is not executing the bytes this run built, and its green would
# prove nothing.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"

OUT="${P01_SBF_OUT_DIR:-$repo/target/sbf-litesvm/deploy}"
SBF_TARGET="${P01_SBF_TARGET_DIR:-$repo/target/sbf-litesvm/sbf}"
LOGDIR="${P01_SBF_LOG_DIR:-$repo/target/sbf-litesvm/logs}"

# Suites that must be found, so a broken discovery cannot run an empty set.
ZK_FLOOR="eras_and_depth subscribe_v4_adversarial subscription_lifecycle unshield_c5_membership"
# Verifier suites that load a program. Each one found on disk must be run here
# or excused below with its reason.
CU_SUITES="cu_budget l2_presized_buffers cu_microbench"
CU_EXCUSED="wasm_blob_parity"
CU_EXCUSED_WHY="its one test is #[ignore] and reads proof files only a staged wasm prover blob can write (cu_budget.rs CI_UNRUN_TEST_TARGETS)"
# How a failure at program load reads in each harness: `.expect("add_program")`
# in the zk_shielded rigs, `.expect("load verifier")` in l2_presized_buffers,
# `add_program failed:` in cu_budget's load_program.
LOAD_MARKER='add_program|load verifier'

failures=0
QUIET=""

in_ci() { [ -n "${GITHUB_ACTIONS:-}" ]; }
err() {
  if [ -n "$QUIET" ]; then
    echo "  (planted) $*"
  elif in_ci; then
    echo "::error title=sbf-litesvm::$*" >&2
  else
    echo "ERROR: $*" >&2
  fi
}
die() { err "$*"; exit 1; }
group() { if in_ci; then echo "::group::$*"; else echo "=== $*"; fi; }
endgroup() { if in_ci; then echo "::endgroup::"; fi; }

# A path a native (non-MSYS) program can open. Git Bash converts arguments it
# recognises as paths, but not the value of an arbitrary environment variable.
native() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) cygpath -m "$1" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
size_of() { wc -c < "$1" | tr -d ' '; }

# ---------------------------------------------------------------------------
# toolchain
# ---------------------------------------------------------------------------

stage_toolchain() {
  group "toolchain"
  # No `head` here or below: under pipefail, a reader that exits early kills its
  # writer with SIGPIPE and the pipeline reports 141 (see the selftest).
  SOLANA_VERSION="$(tr -d '\r' < Anchor.toml \
    | sed -n 's/^[[:space:]]*solana_version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
    | awk 'NR == 1')"
  [ -n "$SOLANA_VERSION" ] || die "Anchor.toml has no solana_version, so there is no pinned SBF toolchain"

  local bin="${P01_SBF_BIN:-}"
  if [ -z "$bin" ]; then
    bin="$HOME/.local/share/solana/install/releases/$SOLANA_VERSION/solana-release/bin"
    [ -d "$bin" ] || bin="$HOME/.local/share/solana/install/active_release/bin"
  fi
  [ -d "$bin" ] || die "no Solana install at $bin (Anchor.toml pins $SOLANA_VERSION). Install it with: sh -c \"\$(curl -sSfL https://release.anza.xyz/v$SOLANA_VERSION/install)\""
  export PATH="$bin:$PATH"

  # The pinned bin dir is FIRST on PATH, so the tool that answers must live in
  # it. On the founder's box an older agave (2.2.14) sits on PATH and dies with
  # "os error 183"; resolving to it would be a silent toolchain switch.
  local found
  found="$(command -v cargo-build-sbf || true)"
  [ -n "$found" ] || die "cargo-build-sbf is not in $bin"
  case "$found" in
    "$bin"/*) ;;
    *) die "cargo-build-sbf resolves to $found, not to $bin" ;;
  esac

  local version
  version="$(cargo-build-sbf --version 2>&1 | tr -d '\r')"
  local first_line="${version%%$'\n'*}"
  case "$first_line" in
    "solana-cargo-build-sbf $SOLANA_VERSION") ;;
    *) die "cargo-build-sbf reports '$first_line', Anchor.toml pins $SOLANA_VERSION" ;;
  esac
  SBF_TOOL_ID="$(printf '%s' "$version" | tr '\n' ' ' | sed 's/ *$//')"

  # cu_budget.rs and l2_presized_buffers.rs read this variable for the compiler
  # identity they print, so they name the tool checked here.
  if [ -f "$found.exe" ]; then found="$found.exe"; fi
  P01_CARGO_BUILD_SBF="$(native "$found")"
  export P01_CARGO_BUILD_SBF

  echo "Anchor.toml solana_version : $SOLANA_VERSION"
  echo "cargo-build-sbf            : $found"
  echo "version                    : $SBF_TOOL_ID"
  echo "host rustc                 : $(rustc --version 2>&1 | tr -d '\r')"
  endgroup
}

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

# build_one <manifest> <artifact name> [-- <cargo args>]
build_one() {
  local manifest="$1" name="$2"
  shift 2
  local so="$OUT/$name.so"
  # Removed first, so a failed build cannot leave an older .so looking current.
  rm -f "$so"
  local start=$SECONDS
  CARGO_TARGET_DIR="$(native "$SBF_TARGET")" cargo-build-sbf \
    --manifest-path "$manifest" --sbf-out-dir "$(native "$OUT")" "$@" \
    || die "cargo-build-sbf failed for $manifest"
  [ -s "$so" ] || die "cargo-build-sbf exited 0 for $manifest but $so is missing or empty"
  [ "$(head -c 4 "$so" | od -An -tx1 | tr -d ' \n')" = "7f454c46" ] \
    || die "$so is not an ELF file"
  printf '%s  %s  %s bytes  (%ss)\n' "$(sha256_of "$so")" "$name.so" "$(size_of "$so")" "$((SECONDS - start))" \
    | tee -a "$OUT/MANIFEST"
}

stage_build() {
  group "build (cargo-build-sbf $SOLANA_VERSION)"
  mkdir -p "$OUT"
  {
    echo "commit    $(git rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "toolchain $SBF_TOOL_ID"
    echo "host      $(uname -s) $(uname -m)"
  } > "$OUT/MANIFEST"
  # --locked: the programs are built from the committed Cargo.lock, never from a
  # re-resolved one.
  build_one programs/zk_shielded/Cargo.toml zk_shielded -- --locked
  build_one programs/p01_stark_verifier/Cargo.toml p01_stark_verifier -- --locked
  # The C7 probe is its own workspace with no dependencies, and its lockfile is
  # gitignored (tests/c7_probe/.gitignore), so --locked has nothing to hold.
  build_one programs/p01_stark_verifier/tests/c7_probe/Cargo.toml c7_phase2_probe
  # WP0f's CU micro-benchmark probe: the same shape (its own workspace, no
  # dependencies, lockfile gitignored), read by cu_microbench.rs.
  build_one programs/p01_stark_verifier/tests/cu_microbench_probe/Cargo.toml cu_microbench_probe
  endgroup
  echo "--- MANIFEST"
  cat "$OUT/MANIFEST"
}

require_artifact() {
  [ -s "$OUT/$1.so" ] || die "$OUT/$1.so is missing: run the build stage first"
}

# ---------------------------------------------------------------------------
# reading a libtest log
# ---------------------------------------------------------------------------

# result_count <log> <passed|failed|ignored>: from the last "test result:" line
result_count() {
  { grep -E '^test result: ' "$1" || true; } | tail -n 1 | tr -d '\r' \
    | sed -n "s/.* \([0-9][0-9]*\) $2;.*/\1/p"
}

# The captured output of one failed test. awk reads the file itself: a writer
# upstream of it would die of SIGPIPE when awk exits at the next section.
failure_section() {
  awk -v name="$2" '
    { sub(/\r$/, "") }
    $0 == "---- " name " stdout ----" { on = 1; next }
    on && ($0 ~ /^---- .* stdout ----$/ || $0 == "failures:") { exit }
    on { print }
  ' "$1"
}

listed_count() { # <package> <test target>
  cargo test --locked --release -p "$1" --test "$2" -- --list 2>/dev/null | tr -d '\r' | grep -c ': test$' || true
}

# check_control_log <suite> <log> <exit code> <what the artifact path named>
# Accepts only: a non-zero exit, a test result, and every failed test failing
# while loading the program.
check_control_log() {
  local t="$1" log="$2" rc="$3" what="$4"
  local failed passed
  failed="$(result_count "$log" failed)"
  passed="$(result_count "$log" passed)"
  if [ "$rc" -eq 0 ]; then
    err "CONTROL $t: the suite PASSED although its program path named a file that is not a program ($what). It is not executing the artifact this run built, so its green proves nothing. Make it read the path from that variable."
    return 1
  fi
  if [ -z "$failed" ]; then
    err "CONTROL $t: exit $rc with no test result (a build error or a crash), which is not a control"
    return 1
  fi
  local names n sec bad="" sections=0
  names="$(tr -d '\r' < "$log" | sed -n 's/^---- \(.*\) stdout ----$/\1/p')"
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    sections=$((sections + 1))
    # A here-string, not a pipe: `grep -q` exits on the match, and a piped
    # writer would then die of SIGPIPE and fail this check under pipefail.
    sec="$(failure_section "$log" "$n")"
    grep -Eq "$LOAD_MARKER" <<< "$sec" || bad="$bad $n"
  done <<< "$names"
  if [ "$sections" -ne "$failed" ]; then
    err "CONTROL $t: $failed failed but $sections failure sections were found in $log; the log reader is wrong"
    return 1
  fi
  if [ -n "$bad" ]; then
    err "CONTROL $t: these tests failed for a reason other than loading the program:$bad. So the control cannot show that they execute the artifact named by $what"
    return 1
  fi
  echo "control ok  $t: $failed test(s) failed while loading the non-program, ${passed:-0} test(s) load no program"
}

# check_run_log <suite> <log> <exit code> <number of tests --list names>
check_run_log() {
  local t="$1" log="$2" rc="$3" listed="$4"
  local passed failed ignored
  passed="$(result_count "$log" passed)"
  failed="$(result_count "$log" failed)"
  ignored="$(result_count "$log" ignored)"
  if [ "$rc" -ne 0 ] || [ "${failed:-x}" != "0" ]; then
    err "$t: exit $rc, ${failed:-no test result,} failed"
    return 1
  fi
  if [ -z "$passed" ] || [ "$passed" -lt 1 ]; then
    err "$t: no test ran"
    return 1
  fi
  if [ "${ignored:-0}" != "0" ]; then
    err "$t: $ignored test(s) are #[ignore]d, so they run nowhere"
    return 1
  fi
  if [ "$passed" != "$listed" ]; then
    err "$t: $passed passed but --list names $listed test(s)"
    return 1
  fi
  echo "run ok      $t: $passed/$listed passed"
}

# control <package> <test target> <ENV=path ...>
control() {
  local pkg="$1" t="$2"
  shift 2
  local log="$LOGDIR/control-$t.log" rc=0
  env "$@" cargo test --locked --release -p "$pkg" --test "$t" > "$log" 2>&1 || rc=$?
  if ! check_control_log "$t" "$log" "$rc" "$*"; then
    tail -n 40 "$log" >&2
    return 1
  fi
}

# run_suite <package> <test target> <ENV=path ...> -- <libtest args>
run_suite() {
  local pkg="$1" t="$2"
  shift 2
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "$#" -gt 0 ] && shift
  local log="$LOGDIR/run-$t.log" rc=0 start=$SECONDS listed
  listed="$(listed_count "$pkg" "$t")"
  # pipefail is on, so a failing cargo is this pipeline's status.
  env "${envs[@]}" cargo test --locked --release -p "$pkg" --test "$t" -- "$@" 2>&1 | tee "$log" || rc=$?
  check_run_log "$t" "$log" "$rc" "$listed" || return 1
  echo "            ($((SECONDS - start))s)"
}

# ---------------------------------------------------------------------------
# selftest: the reader above against planted logs, both ways
# ---------------------------------------------------------------------------

stage_selftest() {
  group "selftest (planted libtest logs)"
  local d wrong=0
  d="$(mktemp -d)"
  QUIET=1

  local ok_line='test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s'
  local load_fail="---- a stdout ----

thread 'a' panicked at tests/x.rs:9:14:
add_program: ElfError(\"invalid magic\")
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace
"
  local logic_fail="---- b stdout ----

thread 'b' panicked at tests/x.rs:40:5:
assertion \`left == right\` failed
  left: 6029
 right: 6004
"
  printf 'running 3 tests\ntest a ... FAILED\ntest c ... ok\n\nfailures:\n\n%s\n\nfailures:\n    a\n\ntest result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n' \
    "$load_fail" > "$d/load-only.log"
  printf 'running 3 tests\ntest a ... FAILED\ntest b ... FAILED\n\nfailures:\n\n%s\n%s\n\nfailures:\n    a\n    b\n\ntest result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n' \
    "$load_fail" "$logic_fail" > "$d/load-and-logic.log"
  printf 'running 3 tests\n\nfailures:\n\n%s\n\nfailures:\n    a\n    b\n\ntest result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n' \
    "$load_fail" > "$d/lost-section.log"
  printf 'running 3 tests\n%s\n' "$ok_line" > "$d/green.log"
  printf 'error[E0425]: cannot find value `x` in this scope\nerror: could not compile `zk_shielded` (test "eras_and_depth")\n' > "$d/compile-error.log"
  printf '%s\n' 'test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s' > "$d/ignored.log"
  printf '%s\n' 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s' > "$d/none.log"
  # A failure section with the marker near its top and 200,000 lines after
  # it. A reader that pipes the section into `grep -q` under `pipefail` loses
  # this one: grep exits on the match, the writer dies of SIGPIPE, the pipeline
  # reports 141, and a clean load failure is refused. MEASURED on Linux
  # (WSL Ubuntu 24.04), where two real controls were refused that way.
  {
    printf 'running 1 test\ntest a ... FAILED\n\nfailures:\n\n---- a stdout ----\n\n'
    printf "thread 'a' panicked at tests/x.rs:9:14:\nadd_program: ElfError(\"invalid magic\")\n"
    seq 1 200000 | sed 's/^/captured output line /'
    printf '\n\nfailures:\n    a\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n'
  } > "$d/long-section.log"

  # planted <accept|reject> <label> <command...>
  local total=0
  planted() {
    local want="$1" label="$2" got
    shift 2
    total=$((total + 1))
    if "$@" > /dev/null; then got=accept; else got=reject; fi
    if [ "$got" = "$want" ]; then
      echo "  ok   $label: $got"
    else
      echo "  FAIL $label: expected $want, got $got"
      wrong=$((wrong + 1))
    fi
  }
  # Every check has a reject case below that no other check refuses, so deleting
  # any one check turns at least one case red (WP0g report, sabotage runs).
  planted accept "control: every failure is at program load"   check_control_log s "$d/load-only.log" 101 X
  planted reject "control: suite green on a non-program"       check_control_log s "$d/green.log" 0 X
  planted reject "control: one failure is not at program load" check_control_log s "$d/load-and-logic.log" 101 X
  planted reject "control: a failure section is missing"       check_control_log s "$d/lost-section.log" 101 X
  planted reject "control: a build error is not a control"     check_control_log s "$d/compile-error.log" 101 X
  planted accept "control: a long failure section at load"     check_control_log s "$d/long-section.log" 101 X
  planted accept "run: all listed tests passed"                check_run_log s "$d/green.log" 0 3
  planted reject "run: fewer passed than --list names"         check_run_log s "$d/green.log" 0 4
  # --list names ignored tests too, so a real run is also caught by the count;
  # a count of 2 here leaves the ignored check alone to refuse it.
  planted reject "run: an #[ignore]d test"                     check_run_log s "$d/ignored.log" 0 2
  planted reject "run: no test ran"                            check_run_log s "$d/none.log" 0 0
  planted reject "run: non-zero exit"                          check_run_log s "$d/green.log" 101 3
  planted reject "run: a failed test, even with exit 0"        check_run_log s "$d/load-only.log" 0 2
  planted reject "run: a build error"                          check_run_log s "$d/compile-error.log" 101 3

  QUIET=""
  rm -rf "$d"
  endgroup
  [ "$wrong" -eq 0 ] || die "selftest: $wrong of $total planted verdict(s) wrong; the log reader cannot be trusted"
  echo "selftest ok: $total planted verdicts"
}

# ---------------------------------------------------------------------------
# zk: every zk_shielded suite that loads a program
# ---------------------------------------------------------------------------

stage_zk() {
  require_artifact zk_shielded
  require_artifact p01_stark_verifier
  mkdir -p "$LOGDIR"
  local so verifier bogus
  so="$(native "$OUT/zk_shielded.so")"
  # None of today's zk_shielded suites loads the verifier. One that does (a
  # C0-replay test, say) gets the verifier this run built, not whatever sits
  # in target/deploy, and the control still names zk_shielded as the non-program.
  verifier="$(native "$OUT/p01_stark_verifier.so")"
  bogus="$OUT/not-a-program.so"
  printf 'not an SBF program: sbf-litesvm.sh negative control\n' > "$bogus"
  bogus="$(native "$bogus")"

  # A suite that ignored P01_ZK_SHIELDED_SO would read this path. In CI it must
  # not exist, so such a suite fails its control instead of passing on old
  # bytes. On a dev box it usually exists and is shown for comparison.
  local legacy="target/deploy/zk_shielded.so"
  if [ -e "$legacy" ]; then
    if in_ci; then
      die "$legacy exists before any suite ran; a suite that ignores P01_ZK_SHIELDED_SO would pass on it"
    fi
    echo "note: $legacy exists, $(size_of "$legacy") bytes, sha256 $(sha256_of "$legacy")"
    echo "      artifact under test: $(size_of "$OUT/zk_shielded.so") bytes, sha256 $(sha256_of "$OUT/zk_shielded.so")"
  fi

  local suites s
  suites="$(grep -l 'add_program(' programs/zk_shielded/tests/*.rs | sed 's#.*/##; s#\.rs$##' | sort)"
  for s in $ZK_FLOOR; do
    grep -qx "$s" <<< "$suites" \
      || die "discovery did not find $s among the zk_shielded suites that load a program: [$(echo $suites)]"
  done
  echo "zk_shielded suites that load a program: $(echo $suites)"

  for s in $suites; do
    group "zk control: $s"
    control zk_shielded "$s" "P01_ZK_SHIELDED_SO=$bogus" "P01_VERIFIER_SO=$verifier" \
      || failures=$((failures + 1))
    endgroup
  done
  for s in $suites; do
    group "zk run: $s"
    run_suite zk_shielded "$s" "P01_ZK_SHIELDED_SO=$so" "P01_VERIFIER_SO=$verifier" -- \
      || failures=$((failures + 1))
    endgroup
  done
}

# ---------------------------------------------------------------------------
# cu: the verifier suites that load a program
# ---------------------------------------------------------------------------

stage_cu() {
  require_artifact p01_stark_verifier
  require_artifact c7_phase2_probe
  require_artifact cu_microbench_probe
  mkdir -p "$LOGDIR"
  local verifier probe microbench bogus
  verifier="$(native "$OUT/p01_stark_verifier.so")"
  probe="$(native "$OUT/c7_phase2_probe.so")"
  microbench="$(native "$OUT/cu_microbench_probe.so")"
  bogus="$OUT/not-a-program.so"
  printf 'not an SBF program: sbf-litesvm.sh negative control\n' > "$bogus"
  bogus="$(native "$bogus")"

  local found s
  found="$(grep -l 'add_program(' programs/p01_stark_verifier/tests/*.rs | sed 's#.*/##; s#\.rs$##' | sort)"
  for s in $CU_SUITES; do
    grep -qx "$s" <<< "$found" || die "$s is no longer a verifier suite that loads a program; update CU_SUITES"
  done
  for s in $found; do
    case " $CU_SUITES $CU_EXCUSED " in
      *" $s "*) ;;
      *) die "programs/p01_stark_verifier/tests/$s.rs loads a program and is neither run here nor excused. Add it to CU_SUITES, or to CU_EXCUSED with its reason." ;;
    esac
  done
  echo "verifier suites run: $CU_SUITES"
  echo "excused: $CU_EXCUSED ($CU_EXCUSED_WHY)"

  for s in $CU_SUITES; do
    group "cu control: $s"
    control p01_stark_verifier "$s" "P01_VERIFIER_SO=$bogus" "P01_C7_PROBE_SO=$bogus" \
      "P01_CU_MICROBENCH_SO=$bogus" || failures=$((failures + 1))
    endgroup
  done
  for s in $CU_SUITES; do
    group "cu run: $s"
    run_suite p01_stark_verifier "$s" "P01_VERIFIER_SO=$verifier" "P01_C7_PROBE_SO=$probe" \
      "P01_CU_MICROBENCH_SO=$microbench" -- --nocapture --test-threads=1 \
      || failures=$((failures + 1))
    endgroup
  done
}

# ---------------------------------------------------------------------------

stages=("$@")
[ "${#stages[@]}" -gt 0 ] || stages=(selftest build zk cu)

case " ${stages[*]} " in
  " selftest ") ;;
  *) stage_toolchain ;;
esac
for st in "${stages[@]}"; do
  case "$st" in
    toolchain) ;;
    selftest) stage_selftest ;;
    build) stage_build ;;
    zk) stage_zk ;;
    cu) stage_cu ;;
    *) die "unknown stage '$st' (selftest, toolchain, build, zk, cu)" ;;
  esac
done

if [ "$failures" -ne 0 ]; then
  die "$failures suite check(s) failed; the logs are in $LOGDIR"
fi
echo "sbf-litesvm: all stages passed (${stages[*]})"
