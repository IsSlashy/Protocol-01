# Benchmark, 2026-09-13 — the STARK pipeline, live on devnet

Every figure below was produced by a command run on this date and carries the
signature of the transaction that produced it. Nothing is quoted from a README.
Where a row is a single run it says so; a single run is not a number, it is
one sample of a public network.

Harness: `packages/stark-prover/scripts/live-timing.ts` (this commit). Prover:
the SHIPPED wasm blob (`packages/stark-prover/wasm/p01_stark_bg.wasm`), in
Node 26 on the session machine. Verifier: the DEPLOYED program
`DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs` (2026-09-06 build), so only C6
and C7 — the circuits that build did not change — are measured. Authority: the
project's devnet key (the faucet refused a throwaway key three times). Rent is
recovered on every run (buffers closed); cost per run 0.000855 SOL of fees.
Raw logs: `live_timing_*.log` in the session scratchpad.

## 1. What is timed

`prove` = the wasm generator. `allocate` = the buffer transaction(s).
`upload` = every `write_proof_chunk` (80 chunks for C7, 83 for C6) to the
last confirmation. `verify` = phase 1 (FRI / Merkle) and phase 2 (DEEP-ALI),
in ONE transaction on the `[L2-CLIENT]` path. `close` = `close_proof_buffer`.
**The pool instruction that consumes the verified buffer is one more
transaction and is NOT in these rows.** Nor is any UI.

## 2. The fast path (`[L2-CLIENT]`): keypair buffer in one transaction, merged phases

| endpoint | chunk pacing | flow | prove | allocate | upload | verify | close | pipeline | prove + pipeline | verify signature (slot) |
|---|---|---|---|---|---|---|---|---|---|---|
| Helius devnet (the web app's RPC) | 16 / 50 ms / one batch | C7 spend — unshield v4, subscription | 1,639 | 3,011 | 9,676 | 1,105 | 621 | 14,412 | **16,051 ms** | `4gWvv8Hq…LPRMAh` (497194120) |
| Helius devnet | same | C6 merkle update — shield | 1,213 | 1,171 | 10,403 | 997 | 718 | 13,289 | **14,502 ms** | `61NcnR7Y…31aLQ5` (497194204) |
| public `api.devnet.solana.com` | 3 / 700 ms / batches of 20 (default) | C7 | 1,278 | 426 | 62,893 | 618 | 400 | 64,338 | 65,616 ms | `TYURVrd3…GXGchr` (497191156) |
| public | same | C6 | 1,327 | 482 | 59,933 | 961 | 401 | 61,777 | 63,104 ms | `4YDUuLKJ…2wcAvQvC` (497191536) |
| public | 3 / 800 ms / one batch | C7 | 1,939 | — | — | — | — | 146,529 | 148,468 ms | 112 HTTP 429s, one soft-timeout retry round |
| public | same | C6 | 1,639 | 546 | 158,600 | 512 | 400 | 160,059 | 161,698 ms | `RW9Z6snK…e4nFft8` (497193956) |
| public | 8 / 150 ms / one batch | C7 | — | 426 | FAILED | — | — | — | — | `sendRawTransaction failed for tx[19]: 429 Too many requests for a specific RPC call` |

All single runs. Every landed verify transaction carries
`Program DGY37k3J… success`; the merged transaction's first program invocation
consumed 885,381–899,805 CU.

What the rows say:

- **Allocation and verification are no longer where the time goes.** One
  `createAccount` + `init_proof_buffer_v3` transaction: 0.4–3.0 s. Phase 1 +
  phase 2 in one transaction: 0.5–1.1 s. Together under 4 s where the old
  path spent nine sequential confirmations.
- **The upload is the wall clock, and the RPC's rate limit is the upload.**
  On the app's Helius endpoint, 80 chunks land in ~10 s. On the public
  endpoint the same chunks take 60 s at the default pacing (72 HTTP 429s
  absorbed by web3.js's retry), 2.5 minutes at a pacing that confirms once at
  the end (112 429s), and an aggressive pacing is refused outright. The
  public endpoint's per-method limit is tighter than "40 per 10 s" in
  practice and it is not a target worth tuning for.
- **Against the founder's goal (shield, unshield, subscription < 60 s):** on
  the endpoint the product uses, the STARK half is 14.5 s (shield) and 16.1 s
  (unshield / subscription), leaving a pool transaction of a few seconds. On
  the public endpoint it is 63–66 s, over the line by the width of the rate
  limit.
- **Against "under 10 s":** not with 1,232-byte transactions. Proving is
  1.2–1.6 s and the three non-upload transactions ~3–5 s, so the upload had
  to fall to ~3 s — which §2b reaches with 4,096-byte transaction-v1 chunks.

## 2b. Transaction v1 chunks (SIMD-0385, 4,096-byte transactions) — `--v1`

The feature gate `txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL` is ACTIVE on
devnet (Feature account read 2026-09-13: activated at slot 492,480,000;
current slot 497,198,199); mainnet activation is announced for epoch 1035,
~2026-09-15. A v1 transaction carries up to 4,096 bytes, so the proof goes up
in chunks of 3,840 bytes: **21 transactions for C7, 22 for C6, instead of 80
and 83**. Built with `@solana/kit` 8.3.0 (`scripts/v1-chunks.ts`, harness
only; `@solana/web3.js` 1.x cannot build v1), everything else on the same
web3.js path as §2. The verifier program needed NO change: `write_proof_chunk`
bounds the write by `proof_size` only.

| endpoint | v1 pacing | flow | prove | allocate | upload (send + confirm) | verify | close | pipeline | prove + pipeline | verify signature (slot) |
|---|---|---|---|---|---|---|---|---|---|---|
| Helius devnet | 8 / 100 ms | C7 unshield v4 / subscription | 1,470 | 2,946 | 1,879 (640 + 1,209) | 741 | 720 | 6,285 | **7,755 ms** | `2bY5xZvd…BLJr5yt` (497199830) |
| Helius devnet | same | C6 shield | 3,786 | 948 | 2,064 (781 + 1,182) | 736 | 649 | 4,397 | **8,183 ms** | `2AXriFRY…ryYEE7oG` (497199859) |
| public | 3 / 700 ms | C7 | 3,430 | 603 | 13,017 (11,960 + 1,041) | 601 | 1,802 | 16,023 | 19,453 ms | `SoRK3gGv…StZPBK3` (497199989) |
| public | same | C6 | 1,448 | 386 | 8,706 (7,647 + 1,045) | 409 | 401 | 9,902 | 11,350 ms | `3MYrwuta…nztna6d` (497200059) |

Single runs; 0 HTTP 429s and 0 resent chunks on both endpoints; largest wire
transaction 4,080 bytes. Every verify transaction logs `success`.

Five consecutive runs on Helius (`--v1 --runs 5`, same key, `live_timing_v1_helius_5runs.log`),
prove + pipeline in ms:

| flow | run 1 | run 2 | run 3 | run 4 | run 5 | min / median / max |
|---|---|---|---|---|---|---|
| C7 unshield v4 / subscription | 96,292 | 6,591 | 7,154 | 4,736 | 4,670 | 4,670 / **6,591** / 96,292 |
| C6 shield | 5,567 | 6,978 | 7,402 | 5,398 | 10,354 | 5,398 / **6,978** / 10,354 |

The C7 outlier is one chunk that never confirmed: the client waited the whole
90 s confirmation window before resending it (upload 92,668 ms, everything
else normal). With 21 chunks a lost one is cheap to resend; the window is the
cost, and it is the next thing to shorten for v1 (resend after ~15 s, an
offset-addressed write is idempotent).

- The upload falls from ~10 s to ~2 s on Helius and from ~60 s to 9–13 s on
  the public endpoint (the public sends are still paced at 3 per 700 ms; 21
  sends fit under the limit where 80 did not).
- **The STARK half of a shield or an unshield / subscription is now 7.8–8.2 s
  on the app's RPC**, against the founder's "under 10 s"; the pool
  instruction adds one transaction.
- One pitfall, measured: a v1 transaction runs with ZERO resources unless it
  declares them, and "loaded accounts data" includes the verifier program's
  ~780 KB of bytecode. At 128 KiB all 21 chunks landed and failed with
  `MaxLoadedAccountsDataSizeExceeded`; 4 MiB passes. `priorityFeeLamports` is
  a total in lamports, not micro-lamports per CU.
- Not yet in any client: the web, extension, mobile and SDK uploaders still
  build 1,000-byte legacy transactions with web3.js 1.x. Moving them to v1
  means `@solana/kit` (or web3.js 3.x) for the chunk sends, with a runtime
  check of the feature gate and the legacy split as the fallback.

## 3. The pre-L2 path, same harness, same key, same day (`--legacy --no-merge`)

PDA buffer, `init_proof_buffer`, eight `resize_proof_buffer` transactions
sent in waves and confirmed as a batch, phase 1 and phase 2 as two
transactions.

| endpoint | flow | prove | allocate (init + 8 resizes) | upload | verify (2 tx) | close | prove + pipeline | verify signatures (slot) |
|---|---|---|---|---|---|---|---|---|
| Helius devnet | C7 | 2,001 | 4,101 | 27,096 | 1,399 | 535 | **35,133 ms** | `2QLSQUK8…GoGSfD`, `65crQsz6…9RSFao` (497194607) |
| Helius devnet | C6 | 1,750 | 8,168 | 28,742 | 1,456 | 551 | **40,667 ms** | `4MDhd1Am…KfuzVt`, `3UL7WVqw…X8yYE6` (497194840) |
| public | C7 | 1,691 | 3,466 | 66,289 | 991 | 601 | 73,038 ms | `2PRWPLk2…5uU83X`, `2aTDziL2…e4v4zcm` (497195313) |
| public | C6 | 3,009 | 3,427 | 75,933 | 1,860 | 501 | 84,730 ms | `3NuzJRnk…7eUYRsd`, `kHyjRC66…dY8tK1` (497195820) |

Single runs; 0 HTTP 429s on Helius, 91 on the public endpoint.

Before / after, same day, same key, same harness, same endpoint:

| endpoint | flow | pre-L2 path | `[L2-CLIENT]` fast path | ratio |
|---|---|---|---|---|
| Helius devnet | C6 shield | 40.7 s | 14.5 s | 2.8× |
| Helius devnet | C7 unshield v4 / subscription | 35.1 s | 16.1 s | 2.2× |
| public devnet | C6 shield | 84.7 s | 63.1 s | 1.3× |
| public devnet | C7 unshield v4 / subscription | 73.0 s | 65.6 s | 1.1× |

⚠️ This "pre-L2 path" is the SDK's (`packages/stark-prover`), which already
sent its eight resizes in waves and confirmed them as one batch, and paced its
chunks the same way as the fast path. It is therefore a CONSERVATIVE "before".
The web client's pre-L2 path (`apps/web/lib/privacy/pool/stark.ts` before
today) confirmed each of its nine buffer transactions one after the other and
sent its chunks one at a time: that is the path behind the founder's "6
minutes" and the 2026-09-02 benchmark (deposits at 63–554 s end to end on the
public endpoint). It was not re-run today; the web client now shares the fast
path measured in §2.

## 5. Full flows, the app's own code, live on devnet (`P01_LIVE_DEVNET=1`)

The three live harnesses in `apps/web/lib/privacy/pool/liveDevnet*.test.ts`
drive the worker handlers the app runs (`poolShieldPrepare` → fund the
ephemeral → `poolShieldExecute`, and the v4 subscription / withdrawal), with the
real wasm prover in-process. RPC: the app's Helius devnet endpoint. The web
client had the `[L2-CLIENT]` fast path AND transaction-v1 chunks at this point
(the logs show `Uploading proof chunk (tx v1) n/22` and `phase 1 + DEEP-ALI,
one transaction`). Single runs; vitest's per-test wall clock.

| flow | wall clock | what it contains | signature |
|---|---|---|---|
| **Shield 1 SOL** (`liveDevnetShield`, test 1) | **21.9 s** | tree read, C6 proof, pricing, funding the ephemeral (1 tx), buffer (1 tx), 22 v1 chunks, verify (1 tx), `shield_denominated_v3`, close, rent return | `4b5XBfdA…AEQwgP`, leaf 105 |
| Subscription with that note, C1 + C3 pair (`liveDevnetShield`, test 2) | 145.6 s | **"Locating your note" 90+ s** (history walk), C1 + C3 proofs, two buffers, four verify transactions, `subscribe_private_stark` | `6o28FNye…VWeaeQE` |
| **Subscription v4**, one C7 proof (`liveDevnetSubscribeV4`) | 436.8 s for the whole test | pool scan (history walk), a fresh shield, note location (history walk again), C7 proof, one buffer, `subscribe_private_stark_v4`; "no commitment in 238 instruction byte-windows" | shield `CWCjEPZd…35tMp` leaf 106, subscription `3H9hPjBB…URw3km` |
| **Unshield v4**, one C7 proof (`liveDevnetUnshieldV4`, fresh unnamed key funded from the project key) | 357.9 s for the whole test | pool scan (history walk), a fresh shield, note location (history walk again), C7 proof, one buffer, `unshield_denominated_stark_v4`; payee received 0.995 SOL | shield `5WNd7EXP…drusU6dT` leaf 107, withdrawal `3uAzC3tT…Dxb8zR1` |

What the rows say: the STARK half is no longer where a flow's time goes; the
**pool-history walk** is (`fetchPoolCommitments`: `getSignaturesForAddress`
over the pool's history plus one `getTransaction` per signature, repeated on
every scan and every note location, nothing kept between calls). The fix
landed after these runs: `poolHistoryCache.ts` keeps the decoded leaves per
(RPC, pool) and the next walk fetches only signatures `until` the newest one
seen (91/91 pool unit tests). Its effect is measured in §5b below.

## 5b. The subscription v4 flow with the history cache, cold and warm

`liveDevnetSubscribeV4` (pool scan → fresh 1 SOL shield → locate the note →
one C7 proof → `subscribe_private_stark_v4`), unnamed key, Helius,
`P01_LIVE_HISTORY_CACHE` pointing at a JSON file, `P01_LIVE_TIMESTAMPS=1` for
the timeline. Single runs.

| run | whole test | notes |
|---|---|---|
| before the cache (§5) | 436.8 s | two full history walks |
| cold (cache file empty; the scan's walk fills it and the note location reuses it in-process) | 195.3 s | one full walk, one incremental |
| warm (cache file from the cold run) | 118.4 s | two incremental walks |
| warm, timestamped (`live_flow_subscribeV4_warm3.log`) | 125.4 s | see the timeline |
| warm, epoch search narrowed (`[SCAN-EPOCH]`, `warm4.log`) | **69.7 s** | scan 2.2 s (was 53.2), shield 24.4 s, registry 16.6 s (harness), subscribe prepare 6.2 s + execute 19.4 s |

The v4 withdrawal, re-measured the same way after both fixes plus the 20 s /
1 s v1 confirmation window (`live_flow_unshieldV4_warm.log`): whole test
**67.1 s** (was 357.9): scan 2.4 s, shield 24.2 s, 17.0 s between the shield
landing and the prepare (harness-side payee derivation and the spent-set
read), prepare 5.0 s, execute 17.7 s; withdrawal `4HjEbnoN…ekaWJ`, payee
received 0.995 SOL, "NO DEPOSIT FIELD APPEARS IN THE WITHDRAWAL".

With the buffer close and the rent sweep merged into ONE transaction
(`[CLOSE-SWEEP]`, `closeStarkProofBuffer(.., { sweepTo })`; `live_flow_*_closesweep.log`):
**shield 19.5 s** end to end (`liveDevnetShield` alone, `4XzBPHcV…`-family run:
shield leg 20.1 s inside the subscription test), **subscription v4 22.1 s**
(prepare 5.6 s + execute 16.5 s; subscription `ZQsnEwBL…jiPgN1i`, vault
`4HkL1uLu…hWno`, no commitment in the instruction bytes), **unshield v4 25.5 s
for the WHOLE test** when it reuses an unspent note (scan 2.2 s, prepare 5.3 s,
execute 15.7 s; withdrawal `4QtdEn9V…Zk2T`, payee received 0.995 SOL, "NO
DEPOSIT FIELD APPEARS IN THE WITHDRAWAL").

Before that step, from the app's own handlers on its own RPC, after the cache
and the narrowed search: shield 24.4 s; subscription v4 25.6 s (prepare +
execute); unshield v4 22.7 s (prepare + execute),
against 437 s for the same test on the same day before. Signatures: shield
`4BnXov8c…LTbSjv` (leaf 111), subscription `2DPgS3uj…f5X4h`, vault
`3ucAuRGa…u5Kzz`, no commitment in the landed instruction bytes.

Timeline of the warm run (seconds since the harness loaded):

| from → to | stage | seconds | what it is |
|---|---|---|---|
| 0.3 → 53.5 | pool scan | **53.2** | history walk now incremental (~1 s); the rest is the **legacy-note epoch search**: 6,000 Poseidon hashes per leaf the wallet does not own, ~110 leaves |
| 53.5 → 77.8 | shield | 24.3 | proof 3.5, pricing/funding 1.4, buffer 0.4, 22 v1 chunks + confirm 7, readback 1, verify 2, `shield_denominated_v3` 2, close 2.2, rent return 2.1 |
| 77.8 → 94.4 | service registry | 16.6 | `loadServiceRegistry(force: true)` — the harness reloads it; the app caches it |
| 94.4 → 101.4 | subscribe prepare | 7.0 | note location (incremental walk), C7 proof, pricing |
| 101.4 → 125.0 | subscribe execute | 23.6 | fund the ephemeral, buffer, 21 v1 chunks, verify (one transaction), `subscribe_private_stark_v4`, close |

Two conclusions the timeline forces:

- With the history cached, a **shield is 24 s and a subscription is 31 s
  (prepare + execute)** on the app's RPC, both from the app's own handlers.
  The 20 s target for the subscription needs the execute stage's rent
  return / close (~4 s) and the funding hop (~1.4 s) trimmed, or run
  concurrently with the upload; the STARK half is ~10 s of it.
- The scan's remaining 53 s is CPU, not RPC: the legacy epoch search. Fixed
  after this run (`[SCAN-EPOCH]`, `poolNotes.ts`): a leaf whose deposit slot
  the walk carried is probed at epochs `[E-2, E+1]` of that slot instead of
  6,000 (a legacy note's epoch is the epoch of the slot the depositor read,
  and its transaction landed a few slots later); a leaf without a deposit
  slot keeps the full window. 3 unit tests on real commitments, 64/64 pool
  tests. Measured in the `warm4` row above.

## 4. Not measured

The pool instruction; the web / extension / mobile UI paths (their clients
were ported to the same fast path today and type-check, the web one has 27
unit tests; none has been driven against devnet); the masked C0/C2/C4/C5
(verifier not redeployed); anything on mainnet.

Off-chain only, 2026-09-12: the STAGED wasm blob (265,324 B, `0ad6d7f1…`) proved
all eight circuits in Node and every proof verified under the current Rust
verifier, phase 1 and 2 (`wasm_blob_parity` 8/8; HANDOFF §6 has the prove
times and lengths), and then through the STAGED .so on litesvm by the real
instruction path (v3 buffer, 3,840-byte chunks, both verify phases, close) —
8/8 accepted, CU per circuit in HANDOFF §6. That is a program verdict on a
local SVM, not a devnet one: no network wall clock for C0/C2/C4/C5 yet.

## 6. 2026-09-12 — the verifier redeployed with the uniform masks, all eight circuits live

Founder's go-ahead given in session ("tu a mon feu vert"). `solana program deploy
-u devnet --program-id DGY37k3J… --use-rpc` from the staged artifact (HANDOFF
§6): signature `3gt9vfoQ1NtwVZ9sjmuTKZXuxtD2njcM1CeZg2SUsFXGQsBhdDfjwsJrxf2RMZ8oKmjgFbMQ5BP3no8Y8zyjYS2F`,
slot 497235406, ELF 801,457 B (`6cf414a6…`, the built 801,472 B `e27317fa…` minus
the loader's trailing zero padding), programdata unchanged at 840,168 B, buffer
rent 4.072 SOL returned (authority 4.638 → 4.634 SOL). Blob 0ad6d7f1 shipped,
four twins rewritten, record re-measured (`deployed-measure.log`); acceptance
`2H5p3dqE7XPbDDfT5n263bbMnWnRV9neqxLBnib6WEi2WywR7qtfLMkQNB9GvAYj5DZ9q125YYD3T88U5fopzx6C`
slot 497236376 (C7, both phases in one transaction, 889,570 CU,
`c7-live-proof-2026-09-12.log`).

STARK half, `live-timing.ts --v1`, Helius devnet, unnamed key, single runs,
`live_timing_v1_masked_all.log`. prove is Node on the shipped blob; the pipeline
is allocate + upload + verify + close on chain.

| circuit | bytes | v1 chunks | prove ms | pipeline ms | prove + pipeline | verify CU | verify tx |
|---|---|---|---|---|---|---|---|
| C0 subscriber_ownership (masked, one instruction) | 74,365 | 20 | 1,303 | 9,614 | **10,917** | 991,981 | `5akV5gg4…` slot 497239840 |
| C2 balance_proof | 95,777 | 25 | 823 | 4,634 | **5,457** | 312,010 (phase 2; two txs) | `54eYpLMN…`, `pNsmu8MZ…` slot 497239885 |
| C4 confidential_balance | 75,085 | 20 | 1,542 | 6,508 | **8,050** | 855,968 (merged) | `3nUWbSpA…` slot 497239924 |
| C5 transfer | 91,261 | 24 | 9,709 | 6,173 | **15,882** | 438,682 (phase 2; two txs) | `4cWVoLE3…`, `56oKxabV…` slot 497239964 |
| C6 merkle_update (shield) | 82,477 | 22 | 2,725 | 5,468 | **8,193** | 901,023 (merged) | `v33DWvYz…` slot 497239996 |
| C7 spend (unshield v4, subscription) | 79,405 | 21 | 1,514 | 6,452 | **7,966** | 890,643 (merged) | `2HDWWHpq…` slot 497240023 |

Every verify transaction logged `Program DGY37k3J… success` on the redeployed
program; no chunk was resent. The C0 pipeline carries a 3.4 s close (one slow
confirmation) and a 4.2 s chunk confirm; C2 and C5 run phase 1 and phase 2 in
two transactions because their sum exceeds the single-transaction budget
(`SINGLE_TX_VERIFY_CU`). C5's 9.7 s is proving, not the chain. C1 and C3 are in
§6b below.

## 6b. C1 and C3 on the redeployed verifier (same harness, `live_timing_v1_c1_c3.log`)

| circuit | bytes | v1 chunks | prove ms | pipeline ms | prove + pipeline | verify CU | verify tx |
|---|---|---|---|---|---|---|---|
| C1 pool_commitment (v3 shield pair) | 94,897 | 25 | 827 | 4,923 | **5,750** | 391,977 (phase 2; two txs) | `oXEP33RZ…`, `421h2jRy…` slot 497242648 |
| C3 merkle_path (v3 unshield pair) | 79,597 | 21 | 1,342 | 3,967 | **5,309** | 878,411 (merged) | `4y1vdXKu…` slot 497242674 |

With §6, every one of the eight circuits has been proved by the shipped blob
and accepted by the redeployed program on devnet, prove + pipeline between
5.3 s (C3) and 15.9 s (C5), single runs, zero chunks resent.

## 6c. The three flows, end to end, on the redeployed verifier (2026-09-12)

The app's own worker handlers (`liveDevnet*.test.ts`), Helius devnet, unnamed
key, history cache warm (`history-cache.json`, 119 entries), `[+Ns]` timestamps,
logs `live_flow_*_masked_verifier.log`. Same code as §5b; what changed
underneath is the program (uniform masks + OOD resampling) and the blob.

| flow | product time | inside | whole test | landed |
|---|---|---|---|---|
| **Shield 1 SOL** (`liveDevnetShield` test 1) | **18.6 s** | tree read, C6 proof, fund, buffer, 22 v1 chunks, merged verify, `shield_denominated_v3`, close + sweep | 18.6 s | `5Hcgq2W2…` leaf 116 |
| **Subscription v4** (`liveDevnetSubscribeV4`) | **23.0 s** (prepare 5.7 + execute 17.3) after a 23.2 s shield leg | note located from the cache, C7 proof, one buffer, 21 chunks, merged verify, `subscribe_private_stark_v4`, close + sweep | 63.4 s (16.8 s of it the harness reloading the registry) | `2y916CDP…`, vault `DASBhCZA…`, no commitment in 238 instruction byte-windows |
| **Unshield v4** (`liveDevnetUnshieldV4`) | **20.8 s** (prepare 3.9 + execute 16.9) after a 28.7 s shield leg (one 5 s verify confirmation) | same STARK half, `unshield_denominated_v4` | 66.3 s (16.6 s harness gap) | `nYdypYKi…`, payee received 0.995 SOL, "NO DEPOSIT FIELD APPEARS IN THE WITHDRAWAL" |

All three under the 60 s target and under the 20–30 s the founder asked for
next, on the masked program, first run after the deploy, no retries.

Also measured, not a target flow: the shield test's second case, the LEGACY
C1 + C3 pair subscription (`then subscribes with the note it just deposited`,
118.0 s), spent 70+ s in `locateOwnedNote`'s "Still looking" heartbeat WITH the
history cache warm, then proved and landed (`jgXQHARn…`, vault `D14CgePa…`).
The v4 path located the same kind of note in 3.9–5.7 s, so the time is in
something `locateOwnedNote` does after the walk (`fetchSpentNullifierSet`, the
blob check, the two-pass derivation search) — not measured apart yet. It is
legacy item 1 of HANDOFF §4 and stays open.
