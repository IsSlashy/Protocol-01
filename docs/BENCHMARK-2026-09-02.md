# Benchmark, 2026-09-02

Every figure below was produced by a command run on this date; the raw logs
are named next to each table. Nothing is quoted from a README or a comment.
Where a figure is a single run it says so. The on-chain and product figures
come from the live runs of the same day, which are recorded with their
signatures. The parts that were NOT measured are listed at the end.

Machine: Intel i7-10750H (6 cores / 12 threads), 15.8 GB RAM, Windows 11,
rustc 1.95.0, node v25.8.0, HEAD e6d2c135 at the time of the runs. Each
prover measurement ran alone on the machine, sequentially.

## 1. Prover, native Rust, release build

Fresh blinding mask on every run, n = 5 per circuit. Prove = the generator
call; verify = parse + phase 1 + phase 2 on the host, the same code the
on-chain verifier runs. Raw: `bench_prove_verify.log`, `gen_proof-wall-2026-09-02.log`.

| circuit | role | prove ms min / median / max | verify ms median | wire bytes |
|---|---|---|---|---|
| C1 | denominated pool spend (v3 pair, part 1) | 733 / 1,246 / 2,456 | 1.8 | 94,897 |
| C3 | Merkle path (v3 pair, part 2) | 678 / 1,483 / 2,211 | 1.5 | 79,597 |
| C6 | Merkle update (deposit) | 688 / 1,737 / 4,403 | 1.5 | 82,477 |
| C7 | spend with lift column (v4: withdraw, subscribe) | 1,380 / 1,877 / 3,160 | 1.4 | 79,405 |

The wire lengths match the verifier's closed form for all eight circuits
(`wire_parity`, C0 47,641 to C7 79,405). The spread between min and max on
the same witness is a factor of 3 to 6 on this laptop; a single run is not a
number.

## 2. Prover, shipped wasm blob, in Node

Blob `packages/stark-prover/wasm/p01_stark_bg.wasm`, 274,224 bytes, sha256
`36c1fd4e…`, the one the deployed verifier accepts. Instantiate + glue import
4.2 ms. Raw: `bench-glue-run.json`, `bench-all8.json`, `bench-dist-run.log`.

| circuit | prove ms min / median / max (n = 5) | chunks uploaded on chain |
|---|---|---|
| C7 spend | 2,216 / 2,656 / 6,628 | 80 |
| C6 merkle update | 1,634 / 2,150 / 2,781 | 83 |
| C1 pool spend | 1,219 / 1,705 / 6,556 | 95 |

All eight circuits at n = 3 (median ms): C0 1,384; C1 1,777; C2 5,539; C3
1,369; C4 907; C5 9,655; C6 2,449; C7 2,348. Through the published `dist`
entry, C7 median 2,865 (n = 5). The `c7-live-proof.ts --dry-run` path, which
is what a real spend runs: 2,739 / 3,793 / 4,353 ms (n = 5).

## 3. On chain, devnet, read back from the transactions

Fetched on 2026-09-03 with `apps/web/scripts/txCostReport.mts`, which reads
`meta.fee` and the runtime's own `consumed N of M compute units` lines. Raw:
`bench-io.json`, `bench-io-flows.json`.

Programs, from `solana program show`: pool `GbVM5yve…` 1,354,072 bytes of
program data, last deployed in slot 490,938,987, 9.426 SOL of rent; verifier
`DGY37k3J…` 840,168 bytes, slot 491,973,056, 5.322 SOL. Both are owned by the
upgradeable loader and share one upgrade authority, `7gWpzSZA…`, which is a
single CLI key.

Per transaction, all measured, none quoted:

| transaction | what it is | fee (lamports) | instructions | keys | compute units |
|---|---|---|---|---|---|
| `zgNJbiyr…` | shield, circuit 6, leaf 102 | 5,700 | 3 | 8 | 302,672 |
| `mVTjvNzs…` | subscribe v4, self-shielded note | 5,500 | 3 | 10 | 176,404 |
| `5FoVus1E…` | subscribe v4, treasury-issued note | 5,500 | 3 | 10 | 173,756 |
| `4RbeXpo3…` | plain 1 SOL transfer to the till | 5,000 | 1 | 3 | 0 |
| `5hdDAz6X…` | verify phase 2, deployment evidence | 5,000 | 2 | 4 | 193,200 |
| `2ZJQt6cy…` | black box, honest proof, ACCEPTED | 5,000 | 2 | 4 | 193,026 |
| `2j5H83Fi…` | tampered public input, REJECTED (6003) | 5,000 | 2 | 4 | 18,110 |
| `2PKrAzsv…` | forged Merkle byte, REJECTED (6003) | 5,000 | 2 | 4 | 26,423 |
| `33nRCCYi…` | forged FRI byte, REJECTED (6003) | 5,000 | 2 | 4 | 277,171 |

Two things the table says that a single quoted figure would not. The
subscribe instruction that everyone quotes costs about 175,000 CU, but that
is phase 2 only: phase 1 (878,756 CU, from the deployment evidence) runs in
its own transaction. And a forged FRI byte costs the verifier MORE than an
honest proof (277,171 against 193,026) because the forgery is caught at step
3.5, after the work; only the two cheap rejections short-circuit.

### What a whole circuit-7 flow costs, counted transaction by transaction

Every transaction the two subscribe ephemerals of the day ever signed --
buffer initialise, resizes, the chunk uploads, both verify phases, the
subscribe, the sweep -- not just the instruction:

| ephemeral | flow | transactions | fees (lamports) | compute units | slots spanned |
|---|---|---|---|---|---|
| `He5gifXH…` | subscribe v4, self-shielded note | 94 | 470,500 | 1,462,646 | 311 |
| `GY79Rpua…` | subscribe v4, issued note | 94 | 470,500 | 1,455,848 | 324 |

So the transaction fees of a complete private subscription are 0.00047 SOL,
and the float that carries it (520 to 550 million lamports) is rent that
comes back on the sweep, minus the nullifier rent. The 94 transactions are
what makes the flow take minutes rather than seconds: 311 and 324 slots is
about 2 minutes of chain time, and the wall clock in section 4 is longer
because the prover runs first and devnet rate-limits the uploads.

Proof upload sizes on the same runs: 80 chunks (C7), 83 (C6), 95 (C1).
Shield signer funding for a 1 SOL note: 1,580,000,000 lamports.

## 4. Product, end to end, live on 2026-09-02

| flow | wall clock | evidence |
|---|---|---|
| shield 1 SOL (C6) then subscribe circuit 7, self-shielded note | 775 s for both, under devnet rate limits | mVTjvNzs… |
| pay the till, collect an older note, subscribe circuit 7 | about 4 min from payment to vault | 4RbeXpo3… then 5FoVus1E… |
| withdraw v4 (earlier the same day) | 630 s under devnet 429s | 2ax5rcoH… |
| note-in exchange (2026-09-03): shield, withdraw to the till, claim, collect an older note | 522 s for the three chain steps, then 13 s to collect | 27DYPdwM… → 3FnRiSvL… → leaf 44 |
| merchant SDK, key only, first grant after landing | 0.75 s (self-shielded) and 1.35 s (issued note) | records/live-license-*.json |
| merchant SDK, one `verifyMerchantLicense` call | 709 ms and 1,078 ms | same |

## 5. Test suites, counted on the day

| package | count | note |
|---|---|---|
| apps/web, default config | 995 passed (53 files) | after the exchange landed |
| apps/web, pool config | 814 passed, 10 skipped (57 files) | live harnesses inert |
| packages/merchant-sdk | 357 passed | 12 files |
| apps/mobile | 477 passed | 35 files |
| apps/extension | 447 passed | plus 1 local failure under Node 25 (`localStorage.clear`), green on CI's Node 24 |
| packages/stark-prover | 67 passed | 63.9 s |
| stark (Rust, release) | 181 unit + 29 integration, 12 ignored | 237 s unit |
| p01_stark_verifier lib | 93 passed | 148 s |
| p01_stark_verifier fast pins (17 binaries) | 159 passed, 1 ignored | 657 s of test time |
| zk_shielded | 106 lib + 11 landed invariants | debug build |

CI on GitHub, last three green runs: TS job under 5 minutes, the two slow
soundness pins about 30 minutes, programs cargo check about 60 minutes.

## What was not measured, and should be next

- The verifier's two slow soundness pins were not re-timed locally (they run
  in CI, about 30 minutes).
- Numbers on a phone: the last on-device figure is C3 at 1,482 ms (2026-08-03);
  nothing newer.
- Nothing here is a mainnet figure. Devnet rate-limits the uploads, and the
  wall clocks in section 4 include waiting on 429s.
