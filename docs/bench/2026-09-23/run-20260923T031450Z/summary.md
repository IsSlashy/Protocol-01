# Benchmark run 2026-09-23T03:14:50.978Z

Protocol measured: pre-v2 (pre-WP10) baseline: v1 as deployed (verifier DGY37k3J…, blob 241caaab, v3 deposit pool, v4 spend routes). v2 is not deployed.

Method: docs/BENCHMARK-METHOD.md. Commit 46a8e2b053556829a42919e22614c834956b51d4. N 30, cold N 30. Node v24.21.0.

**Verdict: publishable.** Every flow of this run passed the checks of docs/BENCHMARK-METHOD.md §5 (`publishable: true` in each flow's JSON).

| flow | circuit | measure | statistics (ms) | note | publishable |
|---|---|---|---|---|---|
| native | C0 | prove | n 30  min 20  median 161  p90 467  max 720  spread 700 ms  (max/min 35.94) | 74365 B | yes |
| native | C1 | prove | n 30  min 14  median 95  p90 328  max 402  spread 387 ms  (max/min 27.77) | 94897 B | yes |
| native | C3 | prove | n 30  min 18  median 130  p90 379  max 615  spread 597 ms  (max/min 34.86) | 79597 B | yes |
| native | C6 | prove | n 30  min 13  median 120  p90 267  max 432  spread 419 ms  (max/min 33.36) | 82477 B | yes |
| native | C7 | prove | n 30  min 27  median 70  p90 277  max 719  spread 692 ms  (max/min 26.58) | 79405 B | yes |
| wasm-node | C0 | warm prove | n 30  min 29  median 307  p90 1,050  max 2,903  spread 2,874 ms  (max/min 98.46) | 74365 B | yes |
| wasm-node | C0 | cold init+prove | n 30  min 37  median 405  p90 1,812  max 5,631  spread 5,594 ms  (max/min 152.95) | | yes |
| wasm-node | C1 | warm prove | n 30  min 28  median 434  p90 956  max 2,588  spread 2,560 ms  (max/min 91.79) | 94897 B | yes |
| wasm-node | C1 | cold init+prove | n 30  min 120  median 423  p90 1,867  max 2,485  spread 2,365 ms  (max/min 20.76) | | yes |
| wasm-node | C3 | warm prove | n 30  min 34  median 383  p90 793  max 1,942  spread 1,908 ms  (max/min 57.13) | 79597 B | yes |
| wasm-node | C3 | cold init+prove | n 30  min 50  median 650  p90 1,576  max 1,989  spread 1,939 ms  (max/min 39.95) | | yes |
| wasm-node | C6 | warm prove | n 30  min 30  median 578  p90 1,210  max 1,494  spread 1,463 ms  (max/min 49.25) | 82477 B | yes |
| wasm-node | C6 | cold init+prove | n 30  min 49  median 495  p90 1,266  max 2,225  spread 2,176 ms  (max/min 45.78) | | yes |
| wasm-node | C7 | warm prove | n 30  min 32  median 727  p90 2,199  max 2,813  spread 2,781 ms  (max/min 87.64) | 79405 B | yes |
| wasm-node | C7 | cold init+prove | n 30  min 72  median 343  p90 930  max 1,441  spread 1,369 ms  (max/min 19.95) | | yes |
| wasm-browser | C0 | warm prove | n 30  min 40  median 335  p90 915  max 1,570  spread 1,529 ms  (max/min 38.95) | 74365 B | yes |
| wasm-browser | C0 | cold init+prove | n 30  min 49  median 625  p90 1,096  max 2,239  spread 2,190 ms  (max/min 45.61) | | yes |
| wasm-browser | C1 | warm prove | n 30  min 34  median 324  p90 968  max 1,092  spread 1,059 ms  (max/min 32.51) | 94897 B | yes |
| wasm-browser | C1 | cold init+prove | n 30  min 32  median 318  p90 1,135  max 2,087  spread 2,056 ms  (max/min 66.25) | | yes |
| wasm-browser | C3 | warm prove | n 30  min 25  median 310  p90 1,388  max 2,337  spread 2,312 ms  (max/min 92.75) | 79597 B | yes |
| wasm-browser | C3 | cold init+prove | n 30  min 56  median 405  p90 952  max 1,745  spread 1,689 ms  (max/min 31.27) | | yes |
| wasm-browser | C6 | warm prove | n 30  min 37  median 292  p90 845  max 1,666  spread 1,629 ms  (max/min 45.02) | 82477 B | yes |
| wasm-browser | C6 | cold init+prove | n 30  min 39  median 478  p90 1,095  max 1,785  spread 1,746 ms  (max/min 45.42) | | yes |
| wasm-browser | C7 | warm prove | n 30  min 40  median 488  p90 1,297  max 1,700  spread 1,661 ms  (max/min 42.72) | 79405 B | yes |
| wasm-browser | C7 | cold init+prove | n 30  min 50  median 457  p90 1,765  max 2,595  spread 2,545 ms  (max/min 51.70) | | yes |
