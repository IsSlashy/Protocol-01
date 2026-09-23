# Benchmark method

This file says how Styx is measured, and it was written **before** the
measurement it describes. The results go in `docs/bench/<date>/<run id>/` (one directory per run: a run refuses a directory that already holds files), next to the
raw logs that produced them. If a result and this method disagree, the result
is wrong, not the method: change the method in its own commit, then measure
again.

Everything here runs on Solana **devnet**. Nothing here is a mainnet figure.

**What this benchmark measures: v1 as deployed today. It is a pre-v2
(pre-WP10) baseline.** The verifier is the deployed program `DGY37k3J…`, the
prover is the shipped blob `d5583d41…`, deposits go through the current v3
deposit pool, and spends take the v4 routes. The v2 protocol (a new verifier
program and v5 pools, work package WP10 of the plan) is not deployed. When it
is, it gets its own run and its own manifest; no figure from this baseline
describes v2. Section 1 lists the exact programs and routes, and every run
records them in its `manifest.json`.

The harness is `scripts/bench/run.mts`. Section 9 shows how to replay it with one
command.

## 1. What is measured

| flow | where it runs | what one sample is |
|---|---|---|
| `native` | this machine, no network | one proof from the Rust prover (release build), per circuit C0–C7 |
| `wasm-node` | this machine, no network | one proof from the shipped wasm blob in Node, per circuit |
| `wasm-browser` | this machine, no network | one proof from the shipped wasm blob in a browser Web Worker, per circuit |
| `stark-pipeline` | devnet | one fresh proof, then upload, on-chain verification and buffer close, per circuit |
| `deposit` | devnet | one 1 SOL deposit (shield), end to end, through the app's own code |
| `withdrawal` | devnet | one withdrawal of a 1 SOL note on circuit 7, end to end |
| `subscription` | devnet | one subscription paid with a 1 SOL note on circuit 7, end to end |
| `purchase` | devnet + a deployment's API | one note-in exchange: withdraw a note to the till, claim, receive an older note |

The prover under test is the blob shipped in the repository,
`packages/stark-prover/wasm/p01_stark_bg.wasm`: 262,363 bytes, SHA-256
`d5583d41c3780a1234b619231963679edc15df247fdc7c56dcc1f85c856365aa`
(read with `sha256sum` on 2026-09-22).

**Which protocol.** Read from the source tree by `scripts/bench/protocol.mts`
at the start of every run and written to `manifest.json` under `protocol`
(`scripts/bench/protocol.test.mts` pins the values below against the tree):

| | value | read from |
|---|---|---|
| STARK verifier program | `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs` | `packages/stark-prover/src/types.ts` |
| pool program (`zk_shielded`) | `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c` | `apps/web/lib/privacy/pool/denominatedPool.ts` |
| pool | 1 SOL, SOL, pool `6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS`, tree `GGJQwEigkoSk3pzg6eiLtt1cu2kYfCtV5JewNJsMkNdi`, pool version **v3** | same file |
| `deposit` route | `shield_denominated_v3` (v3) | same file |
| `withdrawal` route | `unshield_denominated_stark_v4` (v4) | same file |
| `subscription` route | `subscribe_private_stark_v4` (v4) | `apps/web/lib/privacy/pool/subscribePrivateStarkV4.ts` |
| `purchase` route | `unshield_denominated_stark_v4` (v4, paid to the till) | `denominatedPool.ts` |

A live run also reads, without sending anything, the last deploy slot of the
verifier and of the pool program (their ProgramData accounts), and records
them under `protocol.deploy_slots`. A manifest therefore names the deployment
that was measured, not only its address.

The native and wasm flows prove the same statements. The witnesses are the
ones in `programs/p01_stark_verifier/tests/bench_all_circuits.rs`, copied into
`scripts/bench/witnesses.mts`.

## 2. The machine

Read from the system on 2026-09-22 with `Get-CimInstance` (WMI), the registry
and `powercfg`. Every run reads these values again and writes them to its
`manifest.json`. If they differ from this table, the manifest is right.

| | |
|---|---|
| CPU | Intel Core i9-14900K: 24 cores, 32 threads. WMI's `MaxClockSpeed` field reads 3,200 MHz; it does not report boost clocks. |
| RAM | 2 × 24 GiB DDR5 (G.Skill F5-7200J3646F24G), configured at 7,200 MT/s. Windows sees 51,288,678,400 bytes in total. |
| Motherboard | Gigabyte Z790 AORUS ELITE AX |
| OS | Windows 11 Pro 25H2, build 26200.9457, x64 |
| OS changes | The AtlasOS playbook v0.5.0 is applied (read from the OEM information in the registry). Its power plan, "Atlas Power Scheme", is the active one. |
| Rust | rustc 1.98.1, cargo 1.98.1 |
| Browser | Google Chrome 153.0.8010.53 (read from `chrome.exe` version info) |
| Node | **v26.7.0 is the only version installed.** See the founder fields below. |

The CPU mixes two kinds of cores, and the AtlasOS changes and the power plan
affect scheduling and clocks. That is one reason a figure from this machine is
a figure for this machine only.

**Node 24.** The plan says Node 24, the current LTS line, and this machine has
only Node 26.7.0. On 2026-09-22 the newest 24.x in the npm registry was
24.21.0 (`npm view node@24 version`). There are two ways to run the benchmark
on Node 24:

- install it from <https://nodejs.org/dist/latest-v24.x/> (or with a version
  manager such as `nvm-windows`: `nvm install 24` then `nvm use 24`), then run
  the command in section 9;
- or, without installing it: `npx -y -p node@24 node --import tsx scripts/bench/run.mts ...`.

The harness starts every child process with the same Node binary as the
parent, so a run uses one Node version throughout. `manifest.json` records
which one, and `summary.md` names it. Results from two different Node versions
go in two different tables.

### Founder fields

Two facts only the founder can supply. Until they are filled in, the harness
still runs, but it marks every result **not publishable** and says why: in
each flow's JSON, and in `summary.md`, whose heading then reads
"NOT PUBLISHABLE" with the reason and whose every row is marked `no` (§7).

| field | value | how a run records it |
|---|---|---|
| Node version of the published run | **to be filled in by the founder**: Node 24 as planned, or another version accepted in its place | a run on Node 24 needs nothing; a run on another major needs `--node-accepted <major>` (for example `--node-accepted 26`) |
| RPC provider and plan tier | **to be filled in by the founder** (Helius devnet; which plan) | `--rpc-plan "<provider and tier>"`, required for every live flow |

Both go into `manifest.json` under `founder_fields`.

## 3. Network, RPC and the measurement key

- **Cluster.** Devnet only. Every live flow refuses to run without
  `--cluster devnet`. Before it sends anything, the harness checks that the
  RPC endpoint's genesis hash is devnet's.
- **RPC.** The app's own endpoint, Helius devnet, plan tier in the founder
  fields above. The URL is read from an environment variable (`--rpc-env`), so
  the API key never appears on a command line that is logged or in a file.
  The harness records the host name only, and it redacts `api-key=` and the
  full URL from every log it saves. The public endpoint
  `api.devnet.solana.com` is not used for headline figures. On 2026-09-13 its
  rate limit alone turned a 10 s upload into 60 s and failed faster pacings
  (`docs/BENCHMARK-2026-09-13.md` §2). Measuring it again would measure the
  rate limit.
- **Measurement key.** Every live flow refuses to run without
  `--key <path>`. The key must be:
  - dedicated to this benchmark;
  - a devnet key only;
  - an address this repository has never published;
  - kept outside the repository.

  The harness refuses:
  - the Solana CLI default key (`~/.config/solana/id.json`), which on this
    project is the operator's key;
  - any address listed in `apps/web/lib/privacy/pool/publicPayer.ts`;
  - any key file inside the working tree.

  Every fee payer is public on chain, so the key's address will appear in the
  published signatures. That is why it must not be linked to anything else.
- **Purchase flow.** It calls a deployment's `/api/claim-for-payment` and
  `/api/issue-note`. The harness refuses `protocol-01.dev` and `styx.cash`
  unless `--allow-production-api` is also given. Pass that flag only with the
  founder's go-ahead. The deployment's funder ticket is passed through the
  `P01_FUNDER_TICKET` environment variable and redacted from the logs. Each
  purchase sample takes one note from that deployment's stock, so the stock
  must hold at least N + 1 notes (N samples and the warm-up).

### Funding: how much devnet SOL a run needs

Computed, not measured, by `scripts/bench/funding.mts` from the constants the
app and its harnesses use. `scripts/bench/funding.test.mts` re-reads every one
of those constants from the file it comes from, so a figure here cannot drift
away from the code without a test failing. The harness does not request
airdrops.

What the model rests on, read in the harness sources:

- Each harness derives **its own pool identity** (`live-devnet-shield`,
  `live-devnet-unshield-v4`, `live-devnet-subscribe-v4`,
  `live-note-in-exchange`). The withdrawal and subscription flows therefore do
  not spend the deposit flow's notes: each of their samples deposits a note of
  its own first, unless that identity still holds an unspent one. That deposit
  is timed apart (`shield_leg`) and is not inside the product time.
- A deposit costs the wallet 1,003,475,300 lamports for good (a measured
  devnet deposit: 1,573,486,080 pre-funded, 570,010,780 returned;
  `shieldEphemeral.ts`). It needs the full pre-fund, plus up to 0.04 SOL of
  jitter (`prefundAmount.ts`), free when it starts.
- A spend loses the nullifier record's rent and the fee budget (0.002 +
  0.004 SOL, `subscribeFloat.ts`, counted in full as an upper bound); the proof
  buffer's rent comes back when the buffer is closed.
- A withdrawal pays 0.995 SOL to a payee derived from the key. That SOL can be
  swept back by hand; the table counts it apart, as "sweepable".
- A subscription also leaves the vault's rent (361 bytes, about 0.0034 SOL);
  the note's value goes to the retailer.
- A purchase gives the note to the deployment's till and receives an older
  note. Whether the next sample reuses the received note is not established,
  so the table takes the worst case: every sample deposits.
- The withdrawal harness asserts a balance above 1.8 SOL before it starts.
- `stark-pipeline` costs 0.000855 SOL of fees per run and circuit
  (`docs/BENCHMARK-2026-09-13.md`, rent recovered), and needs one proof
  buffer's rent free while it runs.

For N = 30 per flow, history cache warm (one uncounted warm-up for each of the
three spend flows, none for the deposit flow), all eight circuits on
`stark-pipeline`, purchase in the worst case:

| flow | samples (warm-up included) | SOL spent | minimum starting balance, this flow alone | sweepable by hand |
|---|---|---|---|---|
| `stark-pipeline` | 240 (30 × 8 circuits) | 0.205 | 0.869 | 0 |
| `deposit` | 30 | 30.104 | 30.714 | 0 |
| `withdrawal` | 31 | 31.294 | 32.085 | 30.845 |
| `subscription` | 31 | 31.400 | 32.000 | 0 |
| `purchase` | 31 | 31.294 | 31.898 | 0 |
| **all five flows in one run** | 363 | 124.297 | **124.901** | 30.845 |

The minimum starting balance of a run is the largest value, over its samples,
of (SOL spent by every sample before it) + (SOL that sample needs free when it
starts). It depends on the order the flows run in (section 9).

To see what a given balance allows, which is how N is chosen:

```sh
npx tsx scripts/bench/funding.mts --balance <SOL on the key>
npx tsx scripts/bench/funding.mts --balance <SOL> --n 30 --flows deposit,withdrawal --cache cold
```

It prints the largest N each flow allows on its own, and the largest N all
flows allow together in one run. A dry run (section 9) prints the same table
for the flows it would run, and `--balance` works there too. N below 30 is not
publishable (section 5); with less SOL, the flows run one at a time with the
key refilled in between, each with its own N ≥ 30.

## 4. Cold and warm

| flow | cold | warm |
|---|---|---|
| `native` | **Not separated.** | **Not separated.** The harness runs ⌈N/5⌉ processes. Each process proves C0, then C1, and so on to C7, 5 samples per circuit, and discards no warm-up proof. So C0's 5 samples in every process include that process's very first proof; the other circuits run in a process that has already proved. `bench_all_circuits.rs` writes each process's samples sorted, so the first-in-process sample cannot be picked out afterwards. Read the native C0 row with that in mind. |
| `wasm-node` | a **new Node process** per sample. Timed: compile and instantiate the blob (`initStarkWasm`), plus the process's opening proof | one process. Per circuit, one proof is discarded as warm-up, then N proofs are timed |
| `wasm-browser` | a **new Web Worker** per sample. Timed: `new WebAssembly.Module` + `initSync` + the worker's opening proof. The blob download from the local server is recorded as `fetch_ms` and not counted | one worker. One proof is discarded as warm-up, then N proofs are timed |
| `stark-pipeline` | not measured | **warm prover.** One Node process. Before anything is timed, one proof per circuit is made and discarded (`live-timing.ts --warmup-proofs 1`); its time is written apart, as `warmup_prove_ms`, and never enters the samples. Every timed sample then proves a fresh proof and uploads it to a new buffer. The network side has no cache to be cold or warm; the first sample is also the first use of the RPC connection by that process. |
| `deposit` | **Not applicable.** The history cache is read only through `liveWorkerShim.ts`, which the deposit harness does not use, so `--cache` has no effect here and the deposit flow runs no warm-up. | same |
| `withdrawal`, `subscription`, `purchase` | `--cache cold`: an empty pool-history cache for every sample, like a new browser. Guaranteed, not assumed: every run gets a new private directory (never an earlier run's, §7), each cold sample has its own cache file there, and that file is removed before the sample starts (`scripts/bench/guards.mts` `prepareSampleFiles`, pinned by `guards.test.mts`) | `--cache warm` (the default): the history cache left by the previous sample of the same run, like a returning user. It starts empty in the run's new private directory; one warm-up run fills it and is not counted |

On every live product flow, each sample is a new process: the wasm is compiled
again every time. A live flow therefore never benefits from a prover that is
already warm. It is slightly pessimistic for a user who does two things in
the same tab.

Why the cold rows time the opening proof and not only the instantiation: V8
compiles wasm functions lazily, when they are called. Part of the compile cost
is therefore paid inside the opening proof, not inside `initStarkWasm`, and an
`init_ms` on its own would understate what a new user waits for. The same
effect is why `stark-pipeline` discards its warm-up proofs: without them, the
first timed sample of the first circuit would carry compile time that no other
sample carries.

## 5. Sample size and statistics

- **N ≥ 30 per flow, per circuit, per cold/warm mode.** The harness defaults
  to N = 30 (and `--cold-n` to N). It refuses to write under `docs/bench/` a
  run in which any row would have fewer than 30 samples: `--n`, and
  `--cold-n` whenever `wasm-node` or `wasm-browser` runs, since their cold rows
  have `--cold-n` samples (`--n 30 --cold-n 5` with a wasm flow is refused).
  A dry run never writes there at all (`scripts/bench/guards.mts`, pinned by
  `guards.test.mts`): smoke runs go to a scratch directory. Every result file
  carries `publishable: false` and the reasons, and `summary.md` repeats them
  in its heading and marks the flow's rows `no` (`scripts/bench/summary.mts`,
  pinned by `summary.test.mts`), when:
  - fewer than 30 good samples in any of the flow's rows (a failed sample is
    not counted);
  - the run was a dry run;
  - the machine was busy (below);
  - Node is not version 24 and no other version was accepted (`--node-accepted`);
  - on a live flow, the RPC plan tier was not recorded (`--rpc-plan`).
- **Machine load.** Before measuring, the harness samples CPU use across all
  logical CPUs for 3 s, and then every 2 s for as long as it runs. If the use
  was above 15 % before the run, or above 15 % on average during a flow, that
  flow's file is marked not publishable and records the load. The harness's
  own prover uses one thread, about 3 % of 32 logical CPUs. Runs are
  sequential: one flow, one circuit, one sample at a time, nothing else
  running.
- **Reported for every row:**
  - n;
  - min;
  - median;
  - p90;
  - max;
  - spread (max − min);
  - max/min.

  The mean is in the JSON, not in the tables.
  - *Median:* for an even n, the mean of the two middle values.
  - *p90:* nearest rank, meaning the ⌈0.9·n⌉-th smallest sample. It is always
    a value that was observed.

  `scripts/bench/stats.test.mts` pins both on known arrays, with even n and
  ties.
- **Failures are counted, not dropped.** A run whose harness did not reach its
  stop marker, or whose test failed, is kept in the JSON and excluded from the
  statistics. The result file says how many there were. Three failures in a
  row stop that flow.

## 6. Exactly what is timed

All clocks are `performance.now()` in the process that does the work. Live
flows use an epoch timestamp with sub-millisecond resolution, printed on every
log line the harness writes (`scripts/bench/flows/stamp.setup.ts`). A time is
always the difference of two stamps from the same process.

**Proving (`native`, `wasm-node`, `wasm-browser`).**
- *Timed:* one call to the prover. In Rust, that is
  `generate_*_compact_proof(..., fresh CSPRNG mask)`. In wasm, it is the
  `generate_*_stark_proof(...)` export returning its JSON string, which is what
  the app's `starkProver.worker.ts` reports as `durationMs`.
- *Not timed:* parsing that JSON, hex decoding, anything on chain.
- *Recorded but kept apart:* `native` also times host verification (parse,
  phase 1, phase 2 on the host, the code the program runs, but not a CU
  figure).

Every sample is a new proof. The mask is drawn from the CSPRNG on every call,
and the harness records a digest of each proof to show the samples differ.

**STARK pipeline (`stark-pipeline`, `live-timing.ts --v1 --warmup-proofs 1`).**
- *Timed:* prove (wasm, Node), then allocate the proof buffer, upload the
  4,096-byte transaction-v1 chunks, verify (phase 1 and 2, merged where the CU
  budget allows) and close the buffer. Each step is sent and waited for at
  `confirmed` commitment.
- *Not timed:* the discarded warm-up proofs (recorded apart), the pool
  instruction that consumes the verified buffer, and any UI.
- Rent is recovered on every run.

**Live product flows.** These drive the web app's own worker handlers through
the harnesses in `apps/web/lib/privacy/pool/live*.test.ts`. The harnesses are
unchanged; `run.mts` only arms them, points them at the key and the RPC, and
reads their log. Every transaction is waited for at `confirmed` commitment,
the level the app's client code waits for.

| flow | start | stop | phases reported | measured, not counted |
|---|---|---|---|---|
| `deposit` | `wallet … SOL` (the balance has been read) | `SHIELD LANDED: <sig>` (the pool instruction confirmed) | identity + prepare, fund the ephemeral, execute | — |
| `withdrawal` | `payee …` (the harness has derived the payee) | `V4 WITHDRAWAL LANDED: <sig>` | prepare, fund the ephemeral, execute | pool scan; a deposit made because no unspent note was found |
| `subscription` | `retailer …` (the vendor has been read from the registry) | `V4 SUBSCRIPTION LANDED: <sig>` | prepare, fund the ephemeral, execute | a deposit made because no unspent note was found |
| `purchase` | the withdrawal's opening progress message (`unshield-prepare:`) | `issue-note -> 200` (the older note has been received) | prepare, fund the ephemeral, withdraw to the till, claim, issue | a deposit made because no unspent note was found |

**The time to fund the ephemeral key is inside every product time.** Of the
2026-09-12 figures (`docs/BENCHMARK-2026-09-13.md` §6c, measured 2026-09-12),
the 18.6 s shield already included it: that row lists "tree read, C6 proof,
fund, buffer, …". The 23.0 s subscription and 20.8 s withdrawal were
"prepare + execute" and left out the funding transaction between the two. That
funding transaction is real, and a user waits for it.

The harnesses fund the ephemeral key **from the wallet directly**. The app can
also fund it through the deployment's relay, which needs the Next server and is
not measured here (see §11).

### 6b. After the live flows: the probes

Once the live flows are done, `run.mts` runs the repository's own on-chain
checkers on every spend the run landed (withdrawal, subscription, and the
purchase's withdrawal to the till):

```sh
node verify/p01-verify.mjs --spend <sig> --wallet <measurement key address> \
  --max-root-age 0 --since-slot <first slot of the run> --rpc <url>
node verify/p01-crowd.mjs --spend <sig> --rpc <url>
```

and once `node verify/p01-crowd.mjs --pool <the 1 SOL pool> --rpc <url>` for
the crowd at the end of the run. The first slot of the run is read (read-only)
right after the genesis check and recorded as `live.first_slot` in
`manifest.json`; `--since-slot` then fails unless a v4 spend after that slot
was read. Logs go to `raw/probe-verify-<flow>-<run>.log.txt`,
`raw/probe-crowd-<flow>-<run>.log.txt` and `raw/probe-crowd-pool.log.txt`;
exit codes (0 every probe passed, 1 a linkage survived or a channel could not
be read, 2 the tool failed) go to `probes.json`. `--probes off` skips them and
the manifest says so; `--probe-max <k>` probes the first k spends only.

The verdicts are recorded as the tools print them. They are not a privacy
claim of this benchmark, for one known reason: the harnesses fund each
ephemeral from the measurement wallet, so the probes that trace who funded a
fee payer, or look for the named wallet (P6, P8, P9 and P11 in
`verify/p01-verify.mjs`), are expected to find the measurement key. That is what this benchmark's funding path looks like on
chain. The relay path, which exists to avoid it, is not measured here (§11).
The two tools read no environment variable, so the RPC URL is passed on their
command line; it is never written to a log, and it is redacted from their
output.

## 7. Where results are stored

`docs/bench/<YYYY-MM-DD>/run-<start time>/`:

| file | content |
|---|---|
| `manifest.json` | machine (WMI), OS build, power plan, Node / rustc / cargo versions, commit, branch, count of modified tracked files, blob size and SHA-256, the `protocol` block of §1 (programs, pool, routes, deploy slots, the pre-v2 baseline label), the founder fields, CPU load before the run, arguments, RPC **host**, key fingerprint (4 + 4 characters), first slot of the run, start and end times, probe summary, errors |
| `<flow>.json` | every sample in run order, its phases, the summary statistics, the cold/warm mode, `publishable` and the reasons if not |
| `probes.json` | §6b: every spend probed, the tools' exit codes, the log paths |
| `raw/` | every log as printed, scrubbed as described below (saved as `*.log.txt`, because the repository ignores `*.log`); the Rust bench's own JSON; the browser page's result; the probe logs |
| `signatures.txt` | every transaction signature, in full, by flow and run |
| `summary.md` | the tables, generated from the JSON, headed by the protocol measured, the Node version and the **verdict**: "publishable" only when the run was not a dry run, no flow failed and every flow's JSON says `publishable: true`; otherwise "NOT PUBLISHABLE" and every reason, flow by flow, exactly as the JSON records it. Every row has a `publishable` column (`yes` / `no`). A dry run writes no `summary.md` |

Committed with the results: the directory above and the commit it was measured
on. The published tables quote `summary.md` and nothing else, and only a
`summary.md` whose verdict reads "publishable".

**What every saved log loses first** (`scripts/bench/flows/scrub.mts`, pinned
by `scrub.test.mts` on lines built with the harnesses' own print statements):

- secrets: the RPC URL, `api-key=` values, the funder and relay tickets;
- the claim code, in both lines the purchase harness prints it: the
  `claim-for-payment -> 200 {…"claimCode":"…"…}` response (cut at 200
  characters by the harness, possibly inside the code) and the
  `CLAIM <prefix>...` line. A claim code is a bearer credential for
  `/api/issue-note`;
- the exact claim code, claim proof and sealed note held in the run's private
  record, wherever they appear;
- the `record written to <path>` path, every path inside the private
  directory, and the home directory, whose name is the OS user name;
- every leaf number, in every form the harnesses print one, including the two
  values a failed leaf assertion compares. A leaf given up next to the leaf
  received would link a deposit to the note that came back
  (`apps/web/__tests__/lib/docsNoLeafJoin.test.ts`).

The scrub keeps the timestamps, every marker the parser reads, full
signatures and lamport amounts.

Kept out of `docs/bench/` on purpose, in a private directory outside the
repository. Every run makes a **new** one,
`<base>/run-<start time>-<6 random characters>`, where `<base>` is
`--private-dir` or `<system temp>/styx-bench-private`; no run reads another
run's private files, and a run that kept nothing private removes its empty
directory at the end. It holds:

- the live flows' pool-history cache, which is wallet-side state;
- the purchase flow's working record, one per sample. While an exchange runs,
  that record holds the leaf given up, the leaf received, the claim code and
  the claim proof. The harness resumes from `<record>.progress.json` when it
  exists, so a purchase sample whose record or progress file is already there
  is refused rather than resumed, and the file is left in place, never deleted
  (it may hold an unredeemed claim code). A failed sample's record stays in
  the run's private directory for recovery by hand;
- for debugging a failed run, a copy of each log that the scrub changed, with
  secrets removed but nothing else (`raw-unscrubbed/`).

Before a result directory is committed, the leaf-join guard runs over `docs/`:
`npx vitest run __tests__/lib/docsNoLeafJoin.test.ts`, from `apps/web`.

**The benchmark's own records are not private.** `signatures.txt` lists, run
by run, the deposit a flow made and the spend that followed, and the
measurement key funds every ephemeral directly. Anyone can therefore link the
benchmark's own deposits to its own spends. That is test traffic from a key
used for nothing else, published on purpose: a timing claim needs its
signatures. It says nothing about a user's deposits.

One limit of the Rust bench, kept rather than hidden: `bench_all_circuits.rs`
runs 5 samples per process and writes them **sorted**. The harness therefore
runs ⌈N/5⌉ processes and records which process each sample came from. It
cannot tell which sample within a process ran earliest (see §4 for what that
means for C0).

## 8. Reading the results

- A figure is quoted with its n, and at least its median and p90.
- A single run is not a figure.
- A figure from this machine is labelled with this machine.
- A proving time is labelled with where it ran: native, Node or browser.
- A live figure is labelled with its RPC host and its cold/warm mode.
- A figure from this benchmark is labelled a pre-v2 baseline of v1 as
  deployed.

## 9. Replay it

From a clean checkout at the tagged commit (`pnpm install` done):

```sh
# Everything that runs on the machine alone: no key, no network.
npx tsx scripts/bench/run.mts --only local --node-accepted <major, if not Node 24>

# Check the arguments and every gate, print the plan and the SOL it needs,
# send nothing. A dry run writes to <temp>/styx-bench-dry/<date>/ (or --out
# <scratch dir>) and refuses any --out under docs/bench.
export P01_BENCH_RPC='<your devnet RPC URL>'
npx tsx scripts/bench/run.mts --only all --dry-run \
  --key <path to a dedicated devnet keypair, outside the repo> \
  --cluster devnet --rpc-env P01_BENCH_RPC --api-base <deployment URL> \
  --balance <SOL on the key>

# Everything, the live devnet flows and the probes included.
export P01_FUNDER_TICKET='<the deployment funder ticket, purchase flow only>'
npx tsx scripts/bench/run.mts --only all \
  --key <path to a dedicated devnet keypair, outside the repo> \
  --cluster devnet --rpc-env P01_BENCH_RPC --api-base <deployment URL> \
  --rpc-plan '<provider and plan tier>' --node-accepted <major, if not Node 24>
```

Live flows run in this order: `stark-pipeline`, `deposit`, `withdrawal`,
`subscription`, `purchase`, then the probes.

Other options:
- `--only <flows>`: a comma list, or `local`, `live`, `all`.
- `--n`: samples, default 30.
- `--cold-n`: samples per wasm cold row, default N. Below 30 with a wasm flow,
  the run cannot write under `docs/bench/` (§5).
- `--circuits 0,…,7`.
- `--cache warm|cold` (withdrawal, subscription and purchase only).
- `--browser <path>|manual`, `--headed`.
- `--out <dir>`: default `docs/bench/<today>/run-<start time>/` (a run refuses a directory that already holds files), or the temp directory for a
  dry run.
- `--private-dir <dir>`: where each run makes its new private directory,
  default `<system temp>/styx-bench-private` (§7).
- `--probes on|off`, `--probe-max <k>`.
- `--balance <SOL>`, `--purchase-reuses-note`: funding table options for a dry
  run.

`--browser manual` prints a local URL to open in any browser on the same
machine, for browsers other than Chrome or Edge.

The unit tests of the harness (no network, no key):

```sh
node --test scripts/bench/stats.test.mts scripts/bench/guards.test.mts \
  scripts/bench/funding.test.mts scripts/bench/protocol.test.mts \
  scripts/bench/summary.test.mts \
  scripts/bench/flows/markers.test.mts scripts/bench/flows/scrub.test.mts
```

**Licence terms for a replay.** Read `LICENSE` at the commit you replay. Work
from the commit that replaced the MIT License with the PolyForm Strict License
1.0.0 onward, which includes this harness, is source-available under that
licence: reading, building, running and verifying it for noncommercial
purposes is permitted, while commercial use, changes to it and redistribution
need a separate licence from Volta Team. Every commit before that one, and
every npm version that was published under the MIT License before 2026-09-22,
stays under the MIT License (`LICENSE-MIT-BEFORE-POLYFORM`). Whether a given
replay is noncommercial is decided by the licence text, not by this document.

## 10. What earlier benchmarks got wrong or left out

From `docs/BENCHMARK-2026-09-02.md`, `docs/BENCHMARK-2026-09-13.md` and the
harness code at commit `beaa87ba`:

1. **Most rows were a single run.** The 09-13 document says so itself. The
   largest sample was n = 5.
2. **`live-timing.ts --runs 5` timed one proof five times.** It proved once
   before the loop and uploaded the same bytes on every run. The "prove"
   component of the five-run table in 09-13 §2b is one measurement repeated.
   Fixed: every run now proves a fresh proof.
3. **The median was the upper middle value.** For an even n, both
   `live-timing.ts` and `bench_all_circuits.rs` printed `sorted[n/2]`. Fixed
   in `live-timing.ts`. The harness computes its own statistics from the raw
   samples.
4. **The funding transaction was left out of two of the three product
   times.** In 09-13 §6c (measured 2026-09-12) the 23.0 s subscription and the
   20.8 s withdrawal were prepare + execute only; the 18.6 s shield did include
   its funding transaction. Harness start-up gaps were left out, correctly,
   but by reading timestamps by hand, not by a written rule.
5. **No raw logs in the repository.** Logs lived in a session scratchpad.
   Signatures were published shortened (`4gWvv8Hq…`).
6. **The machine was a different one and was not always named.** 09-02
   says a laptop (i7-10750H, Node v25.8.0). 09-13 says "Node 26 on the
   session machine". Machine load was never recorded.
7. **Timestamps were 0.1 s resolution, and not in every harness.** The
   deposit harness had none.
8. **Cold and warm were not defined.** The history-cache state changed from
   row to row, and the first proof of a process, which carries wasm compile
   time, was timed like any other.
9. **Mixed keys.** Some 09-13 runs were signed by "the project's devnet key",
   not by a key kept for measurement only.
10. **Never measured in a browser.** Every wasm figure so far is from Node.
    The app's worker comments still say "~100–500 ms" for in-browser proving,
    a figure nobody measured.
11. **Nothing measured the current blob.** The NTT prover (d5583d41, shipped
    in commit `f2189991`) has an accepted devnet proof recorded in
    `packages/stark-prover/deployed-verifier.json`, and no benchmark.
12. **The protocol measured was not named.** No earlier result recorded the
    pool program, the pool or the route version it ran against.

## 11. What this benchmark does not show

- **v2.** This is a baseline of v1 as deployed. The v2 verifier and the v5
  pools (WP10) are not deployed, and nothing here predicts their times.
- **Mainnet.** Devnet has other validators, other load and other fees. No
  figure here predicts a mainnet latency.
- **Other machines.** Every figure comes from one desktop CPU with 32 threads.
  Phones and laptops are slower. The last phone figure is from 2026-08-03
  (`docs/BENCHMARK-2026-09-02.md`) and is out of date.
- **The relay path.** Deposits and spends are funded from the wallet
  directly. The deployment relay, which keeps the wallet out of the
  transaction, needs the Next server and is not in these flows. For the same
  reason the probes of §6b are recorded, not claimed.
- **The UI.** Rendering, wallet prompts and the user's own clicks are not
  timed.
- **The postMessage boundary.** In the live product flows, the handlers run
  in-process, not across a Web Worker.
- **Where proving time goes inside the prover.** Only a total is timed per
  proof. The split between trace, low-degree extension, commitment and
  grinding is not measured.
- **Cost in SOL.** Fees can be read back from the signatures
  (`apps/web/scripts/txCostReport.mts`), but no figure here reports them. The
  funding table of §3 is computed from constants, not measured.
- **Privacy or soundness.** Timing says nothing about what is hidden or how
  hard a proof is to forge. Security figures come only from
  `docs/SECURITY-LEVELS.md`, each with its regime.
- **Other systems.** The harness measures Styx only. How a comparison with
  other systems is made is section 12.

## 12. Comparing with other systems

The plan compares Styx with Umbra/Arcium (MPC), Zcash, MagicBlock (a TEE) and
NEAR Confidential Intents, on **two axes: time and trust model**. A time
without the trust model it buys is not compared, and no system is ranked on
time alone. These rules apply to every comparison table built from this
benchmark, whatever systems it names.

**Mapping flows.** A competitor figure is set against one of our flows only
when it covers the same span:

| our flow | the competitor step it may be set against | start | stop |
|---|---|---|---|
| `deposit` | moving public funds into the private system (shield, deposit, wrap into a confidential balance) | the client has what it needs and starts the operation | the transaction or step after which the private balance is spendable, at the commitment level the vendor's own client waits for |
| `withdrawal` | moving private funds to a public address (unshield, withdraw) | same | the recipient's public balance is credited |
| `subscription`, `purchase` | a private payment to a merchant, if the system has one | same | the merchant side is credited |
| `native`, `wasm-node`, `wasm-browser` | a proof-generation time alone | the prover call | the proof returned |

- Every off-chain step the competitor needs (an MPC computation, a TEE
  execution, a relayer, an attestation) is inside the span, as our funding
  transaction and proof upload are inside ours.
- A figure that covers less than the span (a proving time, a single
  transaction's confirmation, a network's block time) is compared only with
  our figure for the same part, never with our product time.
- Figures from different networks (devnet, testnet, mainnet) or different
  commitment levels go in separate columns and are not compared directly.
- A figure without its hardware, network or sample count is shown with
  "hardware not stated", "network not stated" or "single figure".

**The trust-model axis.** Every system, Styx included, answers the same six
questions, each answer with a source:

1. **What is hidden, and from whom:** amounts, sender, receiver, the link
   between a deposit and a spend; hidden from the public, from the operator,
   from the vendor.
2. **Whose failure breaks privacy:** for example a threshold of MPC nodes,
   the TEE's hardware vendor or a physical attacker of it, the participants
   of a trusted setup, or no party beyond the chain and the stated
   cryptographic assumptions.
3. **Whose failure breaks funds:** who could forge a spend or finalise an
   unproved state change.
4. **Which cryptographic assumptions, and which of them a quantum computer
   breaks:** discrete log and pairings (for example BN254, Curve25519, P-256)
   against hash-based constructions.
5. **Where the proof or attestation is checked:** inside the chain's own
   program, by an off-chain quorum, or by a vendor attestation service. When a
   source does not say, the answer is "not stated", not a guess.
6. **Whether the enforcing code can be read, and under what terms:** open
   source, source-available, or not published; audited or not.

Styx's own row is held to the same standard: it names the deployed
primitives (v1, not the v2 design) and carries its open findings from
`docs/SECURITY-LEVELS.md`.

**Citation rule.** Every competitor figure or statement carries:

- the URL;
- the date of the page, or "undated" with the date it was read;
- the exact words quoted, re-read on the page before publication;
- one label:
  - "published by the vendor": the vendor, its documentation, its press
    releases, and partners or integrators that ship the product (they are not
    independent);
  - "third-party": an independent source (a paper, an independent
    measurement, an audit), named;
  - "measured by us": only with a harness, raw logs and N ≥ 30, under this
    method;
- and, when a statement is our reading rather than the source's words,
  "inference, not stated by the source".

Measuring a competitor ourselves means sending transactions on its network.
That is a separate decision of the founder and is not part of this harness.
Until it is taken, every competitor time is a cited figure or "not published".
