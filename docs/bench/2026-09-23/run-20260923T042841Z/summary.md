# Benchmark run 2026-09-23T04:28:41.993Z

Protocol measured: pre-v2 (pre-WP10) baseline: v1 as deployed (verifier DGY37k3J…, blob 241caaab, v3 deposit pool, v4 spend routes). v2 is not deployed.

Method: docs/BENCHMARK-METHOD.md. Commit 33b7888fec4040c6d8e7e3806e708504ffcf21dd. N 30, cold N 30. Node v24.21.0.

**Verdict: publishable.** Every flow of this run passed the checks of docs/BENCHMARK-METHOD.md §5 (`publishable: true` in each flow's JSON).

| flow | circuit | measure | statistics (ms) | note | publishable |
|---|---|---|---|---|---|
| withdrawal | — | product time | n 30  min 28,892  median 32,282  p90 36,205  max 38,582  spread 9,691 ms  (max/min 1.34) | 0 failed | yes |
