# Benchmark run 2026-09-23T03:26:35.740Z

Protocol measured: pre-v2 (pre-WP10) baseline: v1 as deployed (verifier DGY37k3J…, blob 241caaab, v3 deposit pool, v4 spend routes). v2 is not deployed.

Method: docs/BENCHMARK-METHOD.md. Commit 46a8e2b053556829a42919e22614c834956b51d4. N 30, cold N 30. Node v24.21.0.

**Verdict: publishable.** Every flow of this run passed the checks of docs/BENCHMARK-METHOD.md §5 (`publishable: true` in each flow's JSON).

| flow | circuit | measure | statistics (ms) | note | publishable |
|---|---|---|---|---|---|
| stark-pipeline | C0 | prove + pipeline | n 30  min 14,539  median 22,165  p90 24,535  max 50,406  spread 35,867 ms  (max/min 3.47) | 0 failed | yes |
| stark-pipeline | C1 | prove + pipeline | n 30  min 20,698  median 28,241  p90 29,249  max 32,432  spread 11,734 ms  (max/min 1.57) | 0 failed | yes |
| stark-pipeline | C3 | prove + pipeline | n 30  min 17,497  median 22,262  p90 26,026  max 27,321  spread 9,824 ms  (max/min 1.56) | 0 failed | yes |
| stark-pipeline | C6 | prove + pipeline | n 30  min 22,056  median 26,817  p90 28,524  max 50,540  spread 28,484 ms  (max/min 2.29) | 0 failed | yes |
| stark-pipeline | C7 | prove + pipeline | n 30  min 16,725  median 22,062  p90 27,266  max 30,996  spread 14,271 ms  (max/min 1.85) | 0 failed | yes |
