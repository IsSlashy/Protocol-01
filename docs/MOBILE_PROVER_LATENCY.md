# Mobile prover latency — where the seconds go, and what to do about it

**Date:** 2026-07-27 · **Scope:** `apps/mobile` shield / unshield / emergency unshield / ZK subscription pause / ZK subscription cancel
**Status:** analysis only. No code was changed. Nothing here has been shipped.

---

## TL;DR

**The 75-second shield is not the prover. It is `setTimeout`.**
Per uploaded proof the pipeline sleeps **32.9 s** in `sendTxsInWaves` wave stagger (exact arithmetic on the
constants, not an estimate) plus **~14.6 s** of per-RPC-call privacy jitter plus **≥13.5 s** of confirmation-poll
granularity. That is **~61 s of timer-driven idle per proof**, before a single field multiplication or a single
byte of network traffic is accounted for. A shield uploads one proof. An unshield uploads two.

**The input lag is not the prover either.** The WASM prover runs in the Android WebView's own renderer process,
so it cannot block the RN JS thread. The freezes come from **20 ed25519 signatures executed back-to-back with no
yield** inside `Promise.all` at `apps/mobile/services/stark/index.ts:658-675`, eight times per proof — plus a
second ed25519 *verify* per transaction that `tx.serialize()` performs by default at `:467`.

**Separately: shield and unshield show the user nothing during their longest phase.** The store's `isLoading`
only flips *after* proof generation completes, and every progress element on both screens is gated on
`isLoading`. That is not lag, it is a dead screen, and it is the cheapest large win in this document.

---

## 0. What I verified personally

Everything below this line I opened and read myself. Claims I did **not** verify are marked as such inline.

| Claim | File:line | Verdict |
|---|---|---|
| `MAX_CHUNK_SIZE = 1000`, `UNIFORM_PROOF_SIZE = 145_000` → 145 chunks/proof | `services/stark/index.ts:40`, `:73` | **CONFIRMED** |
| `sendTxsInWaves(waveSize = 3, waveDelayMs = 700)`, both call sites use defaults | `services/stark/index.ts:456-483`, called at `:601` and `:676` | **CONFIRMED** |
| The "PIPELINED" docstring is false — the batch loop is strictly sequential with an awaited confirm | `services/stark/index.ts:616-618` vs the `for` at `:636` and `await confirmAllBatchedSoft` at `:681` | **CONFIRMED — the comment lies** |
| `sleep(30 + random*90)` before *every* RPC fetch | `services/solana/connection.ts:56` | **CONFIRMED** |
| 20 signatures per batch with no yield inside `Promise.all` | `services/stark/index.ts:658-675` | **CONFIRMED** |
| `tx.serialize()` called with no args on the send path (→ `verifySignatures: true`) | `services/stark/index.ts:467` | **CONFIRMED** |
| `signSendConfirm` defaults to `skipPreflight: false`; no caller overrides | `services/stark/index.ts:430-431` | **CONFIRMED** |
| `conn.confirmTransaction(sig, 'confirmed')` is WebSocket-only, 60 s timeout, no HTTP fallback | `services/stark/index.ts:433` → `node_modules/@solana/web3.js/lib/index.cjs.js:6834-6876` (v1.98.4), `services/solana/connection.ts:279` | **CONFIRMED** (but see §5 — it is *not* currently firing) |
| `_emergency` is accepted and never referenced in the V3 unshield body | `stores/denominatedPoolStore.ts:1478` (grep of lines 1478-1720 returns only the signature); `services/denominatedPool/index.ts:1829` `void emergency;` | **CONFIRMED — emergency is not a fast path** |
| C1 proof is generated *before* the merkle-root check that can abort the flow | `app/(main)/(privacy)/denominated-unshield.tsx:157` (C1) vs `:188-219` (root check) | **CONFIRMED** |
| Shield/unshield progress UI is gated on store `isLoading`, which flips only after proving | shield: `denominated-shield.tsx:240` (proof) vs `:266` (`shieldNoteV3`), UI at `:457`; unshield: `:157`/`:231` (proofs) vs `:248` (store call), UI at `:333` and `:565` | **CONFIRMED** |
| zustand v4 persist writes on **every** `set()` with no diff | `node_modules/zustand/middleware.js:385-389`; encrypting storage at `stores/denominatedPoolStore.ts:371-375`; persist config at `:2453-2461` | **CONFIRMED** |
| WebView CSP has no `worker-src`/`child-src` → workers fall back to `default-src 'none'` | `services/stark/StarkProver.tsx:72` | **CONFIRMED** |
| Prover WebView is positioned at `left:-9999, top:-9999` | `services/stark/StarkProver.tsx:576` + `styles.hidden` at `:599-609` | **CONFIRMED (geometry). Renderer-demotion consequence NOT verified — see §4.T1** |
| `evaluate_poly` does 2 muls/coefficient, not Horner's 1 | `stark/src/compact.rs:1135-1143` | **CONFIRMED** |
| Naive O(n·m) LDE evaluation with a `lde_g.exp(i)` modexp per point | `stark/src/compact.rs:3428-3436` (`compute_lde_generic`), `:534-543` (final-Q, comment admits "naive Horner") | **CONFIRMED** |
| 16-bit grinding = 65,536 serial SHA-256 compressions | `stark/src/compact.rs:37`, `:3813-3826` | **CONFIRMED** |
| `durationMs` is measured for every proof and never logged by any caller | measured at `StarkProver.tsx:245/281/305/338/373/403/439`, carried through `StarkProverProvider.tsx:168/192/208/230/259/278/300`; only `__DEV__` consumers are `subscribe-private.tsx:194/215/264` and `privacy-test.tsx:345` | **CONFIRMED** |
| **Privacy-test screen already prints on-device C0 proof time and size, zero code change** | `app/(main)/(settings)/privacy-test.tsx:345-346` | **CONFIRMED — this is your free instrument** |
| Pause/resume/cancel **do** show a status line (unlike shield/unshield) | `vault-detail.tsx:53`, `:287-290` | **CONFIRMED — correction to the "no feedback anywhere" narrative** |
| Pause/Resume buttons have no re-tap guard (`disabled={isLoading}` only, and `isLoading` flips after the proof) | `vault-detail.tsx:85-114`, `:116-145`, buttons at `:299`, `:313` | **CONFIRMED** |
| C0 (pause/cancel) uses the **legacy** pipeline at actual proof size and skips DEEP-ALI phase 2 | `services/stark/index.ts:937-998` | **CONFIRMED** |

**Claims from the investigation I could NOT verify and am therefore not ranking on:**
- The exact C0 proof size (79,993 B was derived from a wire-size formula, not measured). Measure it — see §1.
- Per-signature ed25519 cost under Hermes. The 6.9 ms/tx figure is desktop Node V8.
- On-device C1/C3/C6 proof generation time. **Nobody has ever measured this.** It is the single largest hole in the budget.
- Whether the offscreen WebView is actually demoted to a background cpuset by Android.

---

## 1. Instrumentation first — the budget below is mostly arithmetic, not measurement

The only genuinely measured numbers anyone has are: the proof byte sizes, two desktop-browser proof timings
(C1 ≈ 207 ms, C6 ≈ 1571 ms), and one 75-second devnet shield round trip. Everything else is derived. **Do this
before writing any optimisation code.** It is ~90 minutes of work and it will re-rank the list below.

### 1.0 — Free, right now, zero code change (do this first)

The app already ships an on-device prover benchmark.

1. Open the app → **Settings → Privacy Test → Test 5: STARK Proof**.
2. Read the two lines it prints on screen:
   `Proof generated in <durationMs>ms (wall: <elapsed>ms)` and `Proof size: <N> bytes`.
3. Run it **five times in the same app session** and record all five.

This gives you, with no build: on-device **C0 proof time** (which is 100% of the proving cost of pause, resume
and cancel), the real **C0 proof size** (which fixes the pause/cancel chunk count in §2), and — because you ran
it five times — whether **run 1 is materially slower than runs 2-5**, which tells you if V8 wasm tier-up is
costing you a one-time penalty per app launch.

`durationMs` is the WASM's own clock; `wall` includes the WebView bridge crossing. **The gap between them is the
bridge cost**, measured, for free.

### 1.1 — Three one-line logs (the only code you should write before optimising)

| # | File:line | Add | Buys you |
|---|---|---|---|
| I1 | `providers/StarkProverProvider.tsx` onMessage handler (~`:98-108`) | `console.log('[P01PERF] circuit', msg.circuitId, 'durationMs', msg.durationMs, 'proofSize', msg.proofSize)` | On-device C1/C3/C6 proof time for the first time ever. The value is already on the wire; it is simply discarded. |
| I2 | `services/stark/StarkProver.tsx` `post()` (~`:90-92`) stamp `t_post: Date.now()`; log `Date.now() - msg.t_post` in `handleMessage` (`:475-499`) | `console.log('[P01PERF] bridge', delta, 'ms', event.nativeEvent.data.length, 'chars')` | Real WebView→RN marshalling cost for a ~280 KB hex payload. |
| I3 | `app/_layout.tsx`, module scope | `let l=Date.now(); setInterval(()=>{const d=Date.now()-l-100; if(d>50) console.log('[P01JANK]',d); l=Date.now();},100)` | A JS-thread stall probe. Every log line is a frame-budget overrun with its duration. This is the input-lag instrument. |

All three are `console.log` only. None can alter a proof byte.

### 1.2 — The adb runbook (main thread runs this; I did not touch adb)

```powershell
# --- baseline capture, one flow at a time ---
adb logcat -c
adb shell dumpsys gfxinfo com.protocol01.app reset
# start capture in one terminal:
adb logcat -v time ReactNativeJS:V *:S > shield.log
# ... perform ONE shield on the device, wait for the success alert, then Ctrl-C ...
adb shell dumpsys gfxinfo com.protocol01.app > shield.gfx.txt
```

Repeat, changing the filename, for: `unshield`, `emergency-unshield`, `pause`, `cancel`.

**What to extract from each `*.log`** (all of these log lines already exist — no code needed):

```powershell
# per-stage wall clock: subtract the -v time timestamps between consecutive hits
Select-String -Path shield.log -Pattern 'Uploading \d+B in \d+ chunks'      # services/stark/index.ts:632  -> upload start
Select-String -Path shield.log -Pattern 'Batch \d+/\d+ attempt \d+: \d+ TXs sent'  # :677  -> batch send done
Select-String -Path shield.log -Pattern 'Batch \d+/\d+ confirmed'           # :687  -> batch confirm barrier
Select-String -Path shield.log -Pattern 'All \d+ chunks confirmed'          # :699  -> upload end
Select-String -Path shield.log -Pattern 'Resizing proof buffer .* in \d+ steps'    # :576
Select-String -Path shield.log -Pattern 'All \d+ resize TXs sent'           # :602
Select-String -Path shield.log -Pattern 'Resize complete'                   # :604

# is the current rate limiting even necessary?  If these are 0, the pacing is free money.
(Select-String -Path shield.log -Pattern 'HTTP 429|JSON-RPC -32429').Count   # connection.ts:108, :125

# with I1/I3 added:
Select-String -Path shield.log -Pattern '\[P01PERF\]'
Select-String -Path shield.log -Pattern '\[P01JANK\]'
```

**From `*.gfx.txt`:** record `Janky frames` (count and %), `50th/90th/95th/99th percentile` frame times, and
`Number of Slow UI thread`. That is the input-lag metric. Seconds are not.

**One decisive extra test — is the offscreen WebView being CPU-throttled?** (see §4.T1)

```bash
adb shell ps -A | grep -i 'protocol01\|sandboxed_process'      # find the renderer pid (child of the app)
# start a shield, and WHILE the proof is generating:
adb shell cat /proc/<renderer_pid>/cgroup                       # look at the cpuset line
adb shell top -H -p <renderer_pid> -n 3 -b                      # which core, what %
```
`cpuset:/background` or `/restricted` = confirmed throttling, and T1 jumps to the top of the latency list.
`cpuset:/top-app` or `/foreground` = hypothesis dead, close it.

### 1.3 — Fill in this table and the guessing stops

| Flow | proof gen (I1) | bridge (I2) | resize | chunk upload | verify+singletons | store sleeps | leaf scan | **total** |
|---|---|---|---|---|---|---|---|---|
| shield | | | | | | n/a | n/a | |
| unshield | ×2 | ×2 | ×2 | ×2 | ×2 | | | |
| emergency unshield | ×2 | ×2 | ×2 | ×2 | ×2 | | | |
| pause | | | | | | n/a | n/a | |
| cancel | | | | | | n/a | n/a | |

---

## 2. The wall-clock budget

### 2.1 The arithmetic that is not an estimate

These follow deterministically from constants I read. They are floors, not guesses.

**Per uniform proof (145,000 B → 145 chunks → 8 batches of 20/20/20/20/20/20/20/5):**

| Term | Derivation | Value |
|---|---|---|
| Chunk wave stagger | 7 batches × 6 delays + 1 batch × 1 delay = 43 delays × 700 ms | **30.10 s** |
| Resize wave stagger | `ceil((145083−10240)/10240)` = 14 tx → 4 delays × 700 ms | **2.80 s** |
| **Wave sleep subtotal** | | **32.90 s** |
| Per-call privacy jitter | ~194 HTTP calls (145 chunk sends + 14 resize sends + ~4 singleton sends + ~13 blockhash + ~18 status polls) × mean 75 ms | **~14.55 s** (range 5.8–23.3 s) |
| Confirm-poll granularity | 9 confirm barriers (8 chunk + 1 resize) × `pollMs = 1500`, ≥1 sleep each | **≥13.50 s** |
| **Deterministic idle per proof** | | **~61 s** |

`waveDelayMs = 700` with `waveSize = 3` throttles to **4.3 tx/s**. The comment at `services/stark/index.ts:450`
says it was "tuned for Helius free tier (~10 RPS)" — so it is throttling to **less than half** the tier it was
tuned for, and per project memory Helius is now a mandatory paid key. `resilientFetch` already retries `-32429`
transparently up to 10 times (`connection.ts:76-129`), so this fixed pacing is a second, redundant rate-limit
defence stacked on a working adaptive one.

### 2.2 SHIELD — measured total 75 s

| Stage | Seconds | Confidence |
|---|---|---|
| Tree read + `findSafeShieldCounter` + keypair (3 sequential RPC reads) | ~1.0–1.5 | **estimated** (arithmetic on jitter + RTT) |
| **C6 proof generation in WebView** | **UNKNOWN** | **not measured by anyone, ever.** Desktop worker reference is 1571 ms; phone is worse by an unknown factor |
| Bridge: 279,530-char hex → `JSON.parse` → `Buffer.from(hex)` | ~0.2–0.6 | **estimated** |
| Init buffer (1 tx, preflighted, WS confirm) | ~1.5–3 | **estimated** |
| Resize (14 tx) | ~4–6 | 2.8 s of it is **arithmetic** |
| **Chunk upload (145 tx)** | **~50–64** | 30.1 s wave sleep is **arithmetic**; rest estimated |
| verify_uniform + verify_deep_ali_phase2 (2 × 1.4M CU, **both preflight-simulated**) | ~3–8 | **estimated** |
| shield_denominated_v3 + close_buffer | ~3–5 | **estimated** |
| **Total** | **75 s measured** | |

**Transactions: 164** (1 init + 14 resize + 145 chunks + 1 verify + 1 deep-ali + 1 close + 1 shield).
**163 of them — 99.4% — exist solely to move proof bytes on-chain.** 164 local signatures, **0 biometric prompts,
0 user approvals**.

Honest reading: **~47.5 s of the 75 s is provably `setTimeout`** (wave stagger + jitter), and the confirm-poll
floor pushes the timer-driven share toward 61 s. That leaves ~14 s for the C6 proof, 164 signatures, two
preflight simulations and all real network I/O — which is tight enough that either C6 is fast on this device or
the confirm polls are landing at their floor. **Instrumentation resolves this; I will not fabricate the split.**

### 2.3 UNSHIELD — no end-to-end measurement exists

The repo's own comments state **"~7 min of upload"** twice (`services/denominatedPool/index.ts:3281`,
`denominated-unshield.tsx:185`). Treat that as the team's prior measurement.

| Stage | Seconds | Confidence |
|---|---|---|
| Biometric prompt | user-paced | — |
| Pre-fund block: 4 **sequential** independent RPC reads (`denominatedPoolStore.ts:1559/1569/1578/1580`) | ~1.0–1.5 | estimated |
| **C1 proof generation** | UNKNOWN | not measured |
| **Leaf scan**: up to 5,000 signatures, then one `getTransaction` per signature in sequential waves of 25 (`services/denominatedPool/index.ts:650-658`) — 200 sequential HTTP round trips, each preceded by 30-120 ms jitter | **~15 s of pure jitter alone**, total unknown, likely tens of seconds | estimated; **jitter share is arithmetic** |
| Root check (`getAccountInfo`), + optional **8 s sleep + full 10,000-signature rescan** on mismatch | 0 or 8 s + second scan | code-verified branch |
| **C3 proof generation** | UNKNOWN | not measured |
| Timing-privacy jitter `1000 + rand*2000` (`denominatedPoolStore.ts:1617-1619`) | 1–3 | **exact, deliberate** |
| **C1 pipeline: 163 tx** | ~60–82 | 32.9 s **arithmetic** |
| **C3 pipeline: 163 tx** | ~60–82 | 32.9 s **arithmetic** |
| unshield ix + close buffers | ~5–8 | estimated |
| Sweep delay `3000 + rand*4000` (`:1644-1646`) **awaited before the promise resolves** | 3–7 | **exact, deliberate** |
| Sweep + ephemeral drain, 2 tx, awaited | ~4–6 | estimated |
| **Total** | **~3–7 min** | |

**Transactions: ~330**, of which **290 are chunk uploads**. 1 biometric, ~328 signatures by the ephemeral
stealth keypair. **~65.8 s of wave stagger alone** (2 × 32.9). Plus **8–16 s spent after the user's funds have
already landed** (the note is marked spent at `denominatedPoolStore.ts:1633-1640`, then the sweep sleep runs
before the promise resolves).

### 2.4 EMERGENCY UNSHIELD — identical, plus one modal

Byte-for-byte the same code path. See §5.

### 2.5 SUBSCRIPTION PAUSE (and RESUME)

C0 uses the **legacy** pipeline at actual proof size, and **skips DEEP-ALI phase 2** (`services/stark/index.ts:993`).

| Stage | Seconds | Confidence |
|---|---|---|
| `loadSecret()` from SecureStore | <0.3 | estimated |
| **C0 proof generation** | **measurable today via privacy-test, §1.0** | not yet measured on device |
| Init + stale-buffer probe | ~2–4 | estimated |
| Resize (~7 tx assuming ~80 KB proof) | ~2–3 | 1.4 s **arithmetic** |
| **Chunk upload (~80 tx, 4 batches)** | **~26–34** | 16.8 s wave stagger is **arithmetic** |
| verify phase 1 only (preflighted) | ~2–4 | estimated |
| pause ix + close | ~3–5 | estimated |
| **Total** | **~40–50 s** | |

`GRINDING_BITS = 16` means C0 spends ~65,536 serial SHA-256 compressions in `grind_nonce`
(`stark/src/compact.rs:3813-3826`) — on a static op-count basis that is the overwhelming majority of C0's
proving work. Because the nonce search is geometric, **p95 ≈ 3× the mean**, which is the most likely explanation
for "pause is sometimes randomly slower". §1.0 run five times will show you the spread directly.

Note the chunk count above assumes ~80 KB. **Measure the real C0 `proofSize` in §1.0 and correct it.**

### 2.6 SUBSCRIPTION CANCEL

Same 91-transaction C0 pipeline as pause, cancel ix in place of pause ix, **plus two redundant RPC reads**:
`fetchVault` (`subscriptionVaultStore.ts:745`) and `getSlot` (`:765`) were both already fetched by the screen
(`vault-detail.tsx:70`, `:163`) seconds earlier. ~0.3–0.5 s of avoidable round trips. Total ~40–50 s.

**And: the C0 proof for cancel is byte-identical to the C0 proof for pause.** Same witness
(`subscriberSecret`), and the prover has no entropy source — grep of `stark/src/` for `rand::` / `OsRng` /
`getrandom` / `SystemTime` / `Instant::now` returns nothing outside witness field *names*; all challenges are
Fiat-Shamir over the trace. Same input in, same bytes out.

---

## 3. RANKING A — LATENCY (seconds removed from the operation)

| # | Item | Safety | Effort | Expected saving | Basis |
|---|---|---|---|---|---|
| **L1** | **Retune the wave stagger.** `sendTxsInWaves` defaults `waveSize = 3, waveDelayMs = 700` → 4.3 tx/s. Both call sites (`:601`, `:676`) use defaults. Parameterise them and pass a fast profile for chunk/resize uploads (start `waveSize = 12, waveDelayMs = 150`), with an adaptive back-off that halves `waveSize` and doubles the delay on any thrown `-32429`. | **SAFE** | 3 h | **~29 s / proof** → 29 s shield, **58 s unshield**, ~15 s pause/cancel | Arithmetic on `services/stark/index.ts:456-483` |
| **L2** | **Actually pipeline the chunk upload** — or better, collapse it. Today `uploadChunksParallel` (`:636-697`) is a plain sequential `for` with an awaited `confirmAllBatchedSoft` at `:681`, despite the docstring at `:616-618` claiming pipelining. Restructure to: one blockhash → sign and send all 145 chunks → **one** `getSignatureStatuses` sweep (145 sigs fits; the RPC limit is 256) → retry only unconfirmed indices. Also deletes 7 of 8 `getLatestBlockhash` calls. | **SAFE** | 4 h | **~10–20 s / proof** (8 confirm barriers × 1.5–3 s) → 20–40 s unshield | Arithmetic on `pollMs = 1500` at `:534` |
| **L3** | **Scope the per-call privacy jitter out of the bulk upload.** `sleep(30 + rand*90)` runs before every fetch (`connection.ts:56`). ~194 calls/proof. Inside a burst of 145 sequential `write_proof_chunk` sends to the same PDA at monotonically increasing offsets, per-call jitter buys no unlinkability the burst boundary does not already leak — and the wave sender already staggers them. Add a `beginBulkRpc()/endBulkRpc()` counter and bracket `uploadChunksParallel` + `resizeToTarget`. **Keep the jitter everywhere else.** | **SAFE** (privacy call is the founder's — my read is the burst is already correlated) | 2 h | **~14.5 s / proof** → 14.5 s shield, **29 s unshield**, ~8 s pause/cancel | Arithmetic; mean 75 ms × ~194 |
| **L4** | **Interleave the two unshield proof uploads.** `services/denominatedPool/index.ts:3236-3248` awaits the full C1 pipeline, then `:3252-3264` the full C3 pipeline. The two buffers are independent PDAs keyed on separate random nonces (`services/stark/index.ts:1035-1044`); the only ordering constraint is that both are verified before the unshield ix is built. `Promise.all` them. **Must be paired with L1's rate budget** and with fixing the orphan-buffer bug (L9) first, since a failure in one leg would otherwise strand the other. | **SAFE** | 6 h | **~half the unshield upload**, ~60–80 s today, ~10–15 s after L1-L3 | Code structure |
| **L5** | **Cache and delta-scan the pool leaves.** The unshield/subscribe leaf scan pulls up to 5,000 signatures and issues one `getTransaction` per signature in 200 sequential waves of 25 (`services/denominatedPool/index.ts:636-696`), with no cache anywhere. (a) Memoise `leavesByIndex` per pool keyed on the on-chain `nextLeafIndex` — if unchanged, skip the scan entirely. (b) Persist it and fetch only the delta via `getSignaturesForAddress({until})`. (c) Batch `getTransaction` 25-30 per HTTP call (Helius accepts JSON-RPC arrays). | **SAFE** | 8 h | **tens of seconds on unshield**, near-total on repeat operations. Unquantified — measure in §1.3 first | Code structure; no caching layer exists |
| **L6** | **Cache the C0 proof for pause / resume / cancel.** Provably identical bytes every time (§2.6). Generate once at subscribe time, store `{proofHex, commitment, proofSize}` keyed by vault PDA. **Do not use SecureStore** — its ~2 KB item cap is already flagged at `subscriptionVaultStore.ts:487` and an ~80 KB hex string will not fit; use the existing `vaultEncrypt`/`vaultDecrypt` + AsyncStorage path. | **SAFE** (caching a provably identical value is explicitly in the SAFE class) | 4 h | **one full C0 proof per pause/resume/cancel** — magnitude from §1.0 | Determinism verified by grep of `stark/src/` |
| **L7** | **Reorder unshield: root check *before* C1.** C1's witness (`nullifierPreimage`, `secret`, `depositEpoch`, `tokenMint`) has zero dependency on tree state, yet it is generated at `denominated-unshield.tsx:157`, before the root check at `:188-219` that can throw. On the abort path a completed proof is discarded and the user learns ~30-60 s later than necessary. | **SAFE** — ordering only, identical inputs → identical bytes | 2 h | 0 s happy path; one C1 proof + ~30-60 s on the abort path | Code structure, verified |
| **L8** | **Get the sweep off the critical path.** `denominatedPoolStore.ts:1642-1689` sleeps 3-7 s and then runs two awaited sweep transactions **after** the note is already marked spent at `:1633-1640`. Resolve the store action at confirmation; run the delayed sweep detached, reporting via the existing `scheduleLocalNotification` at `:1696`. **Keep the delay exactly as it is** — the privacy property is the delay, not the spinner. | **SAFE** | 3 h | **~8–16 s** off the user's perceived unshield | Exact sleep constants read |
| **L9** | **`skipPreflight: true` on init and close.** `signSendConfirm` defaults to `false` (`:430-431`) and no caller overrides, so every singleton is simulated server-side first. **Keep preflight on the two 1.4M-CU verify transactions** — that is how `InvalidProof` gets diagnosed and it is worth the latency. Separately, gate the third explicit simulation at `services/denominatedPool/index.ts:1959-1965` behind a debug flag. | **SAFE** | 1 h | ~2–4 s / proof, estimated | Code verified; RPC-side cost unmeasured |
| **L10** | **`Promise.all` the independent pre-flight reads.** Unshield: `denominatedPoolStore.ts:1559/1569/1578/1580` are 4 sequential awaits with no data dependency. Shield: `denominated-shield.tsx:156/168/192`. | **SAFE** | 2 h | ~1.0–1.5 s per flow | Code structure |
| **L11** | **Batch-unshield pipelining.** `denominated-unshield-batch.tsx:149` is a plain sequential `for`, so every cost above multiplies by N with zero overlap. Generate note *i+1*'s proofs while note *i* uploads — different resources, never both busy today. Do **not** parallelise the uploads themselves (shared RPC budget, and ~2.02 SOL of transient rent per concurrent buffer pair). | **SAFE** | 4 h | Hides the whole proof-gen window for notes 2..N | Code structure |
| **L12** | **Fix the send-failure path.** A rejected send throws out of `sendTxsInWaves` (`:470-476`), escapes the batch retry loop at `:650`, and aborts the entire upload — the retry loop only ever sees *unconfirmed* chunks, never *unsent* ones. Return failed indices instead and merge them into `remaining` at `:690`. | **SAFE** | 2 h | Avoids a full 60-165 s restart each time it fires. Frequency unknown — count 429s in §1.2 | Code verified |
| **L13** | **Add a read-back gate before verify.** `bytes_written` is a **high-water mark** (`programs/p01_stark_verifier/src/lib.rs:91`, `.max(new_written)`) while the verify gate is `bytes_written >= proof_size` (`:119`, `:184`, `:392`). A hole at chunk 3 therefore passes the length check and detonates as `InvalidProof` deep in FRI — after the entire upload, pointing the reader at the prover instead of the transport. One `getAccountInfo` + byte compare before verify catches it deterministically. | **SAFE** (read-only RPC) | 3 h | +1–2 s cost; eliminates a 60-165 s tail loss and a whole class of misdiagnosis | Verified against the on-chain source |
| **L14** | **Fix orphaned proof buffers.** `services/denominatedPool/index.ts:3092-3104` pushes onto `createdBuffers` *after* the await, and the 16-byte nonce that derives the PDA is generated *inside* `submitAndVerifyStarkProofUniform` (`services/stark/index.ts:1035-1044`) and only returned on success. A mid-upload failure therefore strands ~1.01 SOL of rent at an address the client can no longer compute. Pass the nonce in, or add an `onBufferCreated(pda)` callback. | **SAFE** | 6 h | 0 s; recovers real SOL and enables resume-from-offset | Code verified |
| ~~L15~~ | ~~Raise `MAX_CHUNK_SIZE` 1000 → 1100.~~ **Do not do this.** The measured ceiling for this exact instruction shape is **1012 bytes** (1013 serialises to 1233 > 1232). The saving is **1 transaction out of 145**. And on mainnet you will want a ComputeBudget ix on chunk txs (~36 bytes), which pushes the chunk *down* to ~976 and the count *up* to 149. | SAFE but pointless | — | ~0.3 s | Measured against the repo's own web3.js 1.98.4 serializer |

### 3.1 Deferred to a gated prover pass (RISKY — see §6)

| # | Item | Effort | Expected saving |
|---|---|---|---|
| **R1** | Replace the naive O(n·m) LDE evaluation with an NTT | 16 h | Est. 5-6× on C3/C5/C6 proof generation. **Only worth doing after §1.3 shows proof generation is a material share of the flow.** |
| **R2** | Fix `evaluate_poly` to real Horner (1 mul/coeff, not 2) | 2 h | Est. ~2× on the same term. **Strictly dominated by R1 — do one or the other, not both.** |
| **R3** | Parallel grinding across workers | 10 h + R4 | Est. ~4× on the C0 term, and truncates the p95 tail. **This is the lever for pause/cancel; R1 does almost nothing for them.** |
| **R4** | Add `worker-src blob:;` to the WebView CSP | 1 h | 0 s directly. **Blocking prerequisite for R3 and any parallelism.** Classified SAFE on its own (it widens what the page may instantiate and touches no arithmetic) but pointless without R3. |

---

## 4. RANKING B — PERCEIVED LAG (frames unblocked, responsiveness restored)

These remove **zero seconds** from the operation and are, for the founder's actual complaint, probably worth
more than half of Ranking A.

| # | Item | Safety | Effort | Effect |
|---|---|---|---|---|
| **P1** | **Yield between signatures.** `services/stark/index.ts:658-675` — `Promise.all(remaining.map(async ...))` where every callback body is synchronous CPU work with no awaited yield. All 20 `tx.sign(keypair)` calls therefore run in **one uninterrupted macrotask**, 8 times per proof, ~163 signatures per shield and ~330 per unshield, on the RN JS thread under Hermes with pure-JS `@noble/curves` (`polyfills/noble-ed25519-shim.js` re-exports the real module). **This is the input lag.** Fix: sign in slices of 4 with `await new Promise(r => setTimeout(r, 0))` between slices — or better, sign lazily inside `sendTxsInWaves` so each wave signs only its 3 transactions immediately before sending, which also shortens blockhash exposure. Same treatment for the 14-transaction resize map at `:581-600`. | **SAFE** — signature bytes are a deterministic function of (message, key) | 3 h | Converts 8 freezes of ~0.4–1.4 s each into interleaved work. **The single biggest janky-frame source.** |
| **P2** | **`tx.serialize({verifySignatures: false, requireAllSignatures: false})`.** `services/stark/index.ts:467` (and `:430`) call `tx.serialize()` bare, and web3.js 1.98.4 defaults `verifySignatures: true` — so every one of ~163 (shield) / ~330 (unshield) transactions pays a **pure-JS ed25519 verify** on top of its sign, for a signature it produced itself one line earlier. `_serialize` is unaffected by these flags; **the wire bytes are byte-identical**. | **SAFE** | 1 h | Removes roughly 60% of the remaining ed25519 work on the JS thread |
| **P3** | **Stop the dead screen on shield and unshield.** Shield: the C6 proof runs at `denominated-shield.tsx:240` but the store's `isLoading` only flips inside `shieldNoteV3` at `:266`, and the processing card is gated on `isLoading` at `:457`. Unshield is worse: biometric, C1, a 5,000-signature scan, a root check and C3 all run before `isLoading` flips at `:248`, while the sticky bar (`:333`) and `OperationProgressBar` (`:565`) stay hidden and the confirm button keeps rendering its **static "Withdraw" label** (`:545-563`) because only the local `submitting` flag is set. Fix: a screen-local `localPhase` state set immediately before each awaited step; gate the sticky bar on `(isLoading \|\| submitting)`; import `OperationProgressBar` into `denominated-shield.tsx` (it currently does not import it at all); thread `fetchPoolCommitments`' existing `onProgress` (`services/denominatedPool/index.ts:622`, `:695`) through the scan. **Note: `vault-detail.tsx` already does this correctly** via `starkStatus` (`:53`, `:287-290`) — copy that pattern. | **SAFE** | 4 h | Eliminates a multi-minute window in which the app looks broken. **Cheapest large win in the document.** |
| **P4** | **Get transient operation state out of the persisted store.** zustand v4's persist middleware wraps `api.setState` and calls `void setItem()` **unconditionally on every `set()`**, with no diff against the partialized slice (`node_modules/zustand/middleware.js:385-389`). `denominatedPoolStore`'s storage is `encryptedStorage` — `nacl.secretbox` over a `JSON.stringify` of the **entire note vault**, plus base64, plus an AsyncStorage write (`stores/denominatedPoolStore.ts:371-375`, config at `:2453-2461`). Every progress tick (`:1102` shield, `:1627` unshield — ~28 and ~51 per flow) therefore re-encrypts and rewrites the whole vault. Fix: move `{progress, isProving, isLoading}` into a separate **non-persisted** store. `subscriptionVaultStore.ts:1120-1126` has the same shape (unencrypted, but still a full `JSON.stringify` per tick). | **SAFE** | 3 h | Removes 28-51 synchronous encrypt+serialize+write cycles landing exactly when the UI is trying to repaint |
| **P5** | **Narrow the store subscriptions.** `denominated-unshield.tsx:43-46` and `denominated-shield.tsx:69-76` destructure from a bare `useDenominatedPoolStore()` with no selector, so they re-render on *any* store mutation — including every progress tick. On the unshield screen each such render also re-runs four un-memoised `.filter()` calls over all notes (`:63-66`) and rebuilds the whole note list. Fix: per-field selectors, move the progress read into a leaf component, `useMemo` the filters. Also memoise `contextValue` in `StarkProverProvider.tsx:390-401` — it is a fresh object literal every render and it wraps the entire app at `app/_layout.tsx:89`. | **SAFE** | 4 h | ~50 full-screen reconciliations per unshield → ~1 |
| **P6** | **Make the progress bar honest.** Two separate lies. (a) `onProgress` for resize is called **inside the signing map** at `services/stark/index.ts:583`, so all 14 "Resizing (n/14)" ticks fire in one synchronous block *before any transaction is sent* — `OperationProgressBar` (`components/ui/OperationProgressBar.tsx:25`, `:36-39`) paints 14/14 within milliseconds and then sits motionless for the real duration. Same shape for the batch label at `:651-655`. (b) 145 chunks report as 8 updates, so the bar freezes for 6-8 s at a stretch. Fix: emit progress from the *send/confirm* path, and thread a cumulative `chunksConfirmed/totalChunks` out of `confirmAllBatchedSoft` (it already tracks `confirmed.size` at `:546-556`). Also pass the `step={{current,total}}` prop the component already supports (`:44-46`) so an unshield bar spans C1+C3 as two halves instead of filling, resetting to zero, and filling again — which currently reads as a failure. | **SAFE** | 3 h | Turns "frozen" into "working". Pairs with P3 |
| **P7** | **Re-tap guard on Pause and Resume.** `vault-detail.tsx:85-114` / `:116-145` — `loadSecret()` and `starkGenerate()` both run before `isLoading` flips, and the buttons' only guard is `disabled={isLoading}` (`:299`, `:313`). A second tap starts a second full C0 proof, which serialises behind the first in the single-threaded WebView and uploads a second full proof buffer. `denominatedPoolStore` already has a module-scope `_starkOpInFlight` guard (`:316`); `subscriptionVaultStore` has no equivalent. Leave **cancel** alone — it is implicitly guarded because `setCancelPhase('processing')` unmounts the confirm button (`vault-detail.tsx:178`, `CancelConfirmModal.tsx:84-96`). | **SAFE** | 2 h | Prevents a user-triggered 2-3× multiplication of an already long wait, and wasted rent |
| **P8** | **Kill the double-JSON-encoded WASM injection at launch.** `services/stark/StarkProver.tsx:483-489` builds `JSON.stringify({type:'initWasm', wasmBase64})` and then wraps it in a **second** `JSON.stringify` inside an `injectJavaScript` source string — ~257 KB of base64 becomes a ~257 KB JS source string evaluated on the **Android UI thread** at every launch, and the page then `atob`s it and rebuilds 192,732 bytes with a per-character `charCodeAt` loop (`:204-208`). Fix: inline the base64 into `STARK_HTML` so the page initialises itself, and replace the loop with `Uint8Array.from(atob(b64), c => c.charCodeAt(0))`. Also hoist `source={{html: STARK_HTML}}` (`:579`) to module scope. **Bonus: the code comments are stale by ~5×** — `StarkProver.tsx:9` and `StarkProverProvider.tsx:7` both say "50KB"; the real blob is 192,732 B / 256,976 base64 chars. | **SAFE** | 3 h | Removes a launch-time UI-thread stall and shortens time-to-`starkReady` — the gate every complained-about screen blocks on |
| **P9** | **Decode the proof off the critical instant.** The proof crosses as a ~280 KB hex string, is `JSON.parse`d whole (`StarkProver.tsx:478`), then `Buffer.from(hex,'hex')`-decoded on the JS thread (`denominated-shield.tsx:247`, `denominated-unshield.tsx:243`/`:245`) by the **pure-JS feross/buffer polyfill** (`index.js:32-33`) — a per-byte `parseInt` loop over 145,000 iterations under Hermes. It lands exactly when the user expects the UI to come back. Fix (client-side only, no WASM change): a nibble-lookup decoder into a preallocated `Uint8Array`, yielding every ~16 KB. Also use `subarray` instead of `slice` at `services/stark/index.ts:646` to skip 145 per-chunk copies. **Do not** change the WASM to emit base64 — that is proof serialisation output and falls under §6. | **SAFE** | 4 h | Removes one contiguous 150-600 ms stall per proof (I2 in §1.1 measures the real number first) |
| **P10** | **Re-enable `transform-remove-console` for release builds.** `babel.config.js:44-51` and `index.js:20-29` both have the console-stripping guards commented out with a TEMP note dated 2026-05-08. `denominatedPoolStore.ts` alone has 87 call sites; the hot paths add per-batch, per-wave, per-retry and per-WebView-message lines. Every call crosses into the native logging bridge. Route the handful of genuinely operational `[Sub:*]` lines through a flag-gated logger first so the diagnostic value survives. **Do this last** — it will blind the instrumentation in §1. | **SAFE** | 2 h | A few hundred ms to low seconds of JS-thread and bridge work per flow, plus logcat backpressure |

### 4.T1 — One hypothesis to test, not to implement

The prover WebView is positioned at `left: -9999, top: -9999` (`StarkProver.tsx:576` + `styles.hidden` at
`:599-609`) — **confirmed by reading**. The *consequence* — that Android therefore reports an empty visible rect,
marks the Chromium renderer hidden, and schedules it into a background cpuset confined to LITTLE cores — is
**unverified**, and I could not verify it because adb is not mine to drive. If true it would be a 3-8× multiplier
on every proof and would jump to the top of Ranking A. If false, close it.

**Run the cgroup check in §1.2. It is one command and it settles the question.** If confirmed, the fix is to keep
the WebView genuinely visible at 1×1 / `opacity: 0.01` / no negative offsets (never `display:none`, never
`left:-9999`, never unmounted), and if geometry alone is insufficient, a native
`setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, false)` — which the installed `react-native-webview`
never calls (grep of `node_modules/react-native-webview/android/src` for `RendererPriority` returns zero hits).
Geometry and renderer priority feed no proof input, so the change itself is **SAFE**.

### 4.T2 — A latency cliff that is not currently firing

`signSendConfirm` uses `conn.confirmTransaction(sig, 'confirmed')` (`services/stark/index.ts:433`). In web3.js
1.98.4 a bare signature routes to `confirmTransactionUsingLegacyTimeoutStrategy`
(`node_modules/@solana/web3.js/lib/index.cjs.js:6834-6876`), which races an `onSignature` **WebSocket**
subscription against a timeout — `confirmTransactionInitialTimeout: 60000` per `services/solana/connection.ts:279`
— with **no `getSignatureStatuses` HTTP fallback**. All verified by reading.

**But note what happens on timeout: it `throw`s `TransactionExpiredTimeoutError`.** It does not silently wait and
then succeed. Since shields currently *complete* in 75 s, **the WebSocket is alive and this is not contributing
to today's slowness.** It is a robustness cliff — if the Helius devnet WS becomes unreachable from the device
(and per project memory the Helius quota has died before), 4-5 transactions per proof each fail after 60 s and
the flow dies. Fix by swapping to the HTTP poller that already exists in the same file
(`confirmAllBatched`, `:490-521`). **SAFE**, 2 h, 0 s saved today. Do it for reliability, not for the stopwatch.

---

## 5. The emergency-unshield question, answered directly

**No. Emergency unshield is not a fast path. It is the normal path plus one confirmation modal, and it is
therefore measurably *slower* than a normal unshield.**

Verified:
- `stores/denominatedPoolStore.ts:1478` — the parameter is declared `_emergency` and is **never referenced** anywhere in the V3 handler body.
- `services/denominatedPool/index.ts:1829` — the v2 path does `void emergency;` explicitly.
- The store's own doc comment at `:230-232` says it plainly: *"`emergency` flag is accepted for symmetry but currently unused: min_epoch is always UNSHIELD_MIN_EPOCH (0) and the V3 handler ignores it."*
- `denominated-unshield.tsx:266-270` agrees in a comment: *"`emergency` no longer changes any instruction byte… It only relaxes the client-side maturity gate."*

The only real effects are that the note picker widens to include immature notes (`:66`) and the user is shown an
extra confirmation dialog (`:298-306`). Same two proofs, same ~330 transactions, same ~65.8 s of wave stagger,
same ~3-7 minutes.

**Pick one of two honest resolutions:**

**(a) Make it real.** An emergency path can legitimately skip the 8-second-plus leaf-rescan retry
(`denominated-unshield.tsx:204-218`), skip the 1-3 s timing jitter (`denominatedPoolStore.ts:1617-1619`), and
resolve as soon as the unshield transaction confirms rather than waiting out the 3-7 s sweep delay and its two
transactions (`:1642-1689`). That is **~15-25 s of genuinely emergency-only saving** with no proof byte touched
— at a stated, documented privacy cost, which the user is explicitly accepting by pressing the emergency button.

**(b) Rename it.** Call it *"Withdraw immature note"* and delete every speed implication from the copy. That is
exactly what the flag does today.

What you must not do is leave a button labelled "emergency" that is one modal slower than the normal one.

---

## 6. SAFE / RISKY — the split, enforced

**SAFE** = provably cannot change proof bytes. Transport, threading, scheduling, caching of a provably identical
value, upload pacing, UI, progress reporting, avoiding recomputation. Ships behind normal review.

Every item in Ranking A **except R1-R3**, and every item in Ranking B, is **SAFE**. Specifically safe because:
- Send pacing, wave size, jitter, batching and confirm strategy change *when* byte-identical transactions are sent, never their contents.
- `tx.serialize({verifySignatures:false})` — `_serialize(signData)` is unaffected by that flag; the wire bytes are identical. Verified in `node_modules/@solana/web3.js/lib/index.cjs.js:1834-1856`.
- Yielding between signatures — an ed25519 signature is a deterministic function of (message, key). Scheduling cannot alter it.
- Reordering the unshield root check before C1 — C1's witness has no dependency on tree state.
- Caching the C0 proof — the value is provably identical (no entropy anywhere in `stark/src/`, all challenges Fiat-Shamir).
- CSP `worker-src` — widens what the page may instantiate; touches no arithmetic.
- All UI, progress, selector, persistence and logging changes.

**RISKY** = could alter a proof byte or on-chain behaviour. **A one-bit difference is `InvalidProof` on-chain, and
there is no device-side regression gate today.**

| Item | Why risky | **Byte-identity proof required before it ships** |
|---|---|---|
| **R1** NTT replaces naive LDE evaluation | Rewrites the arithmetic that produces the LDE, the quotient LDE and the boundary fold | (1) A golden-vector harness that pins the **full serialized proof byte string** for **all 7 circuits** on fixed inputs, committed to the repo, asserting exact byte equality pre/post. (2) One successful **devnet verify per circuit** on the real deployed verifier. (3) Land the `final_q` site (`compact.rs:534-543`) alone first — it is ~46% of C6 and ~53% of C3 on the op-count model and it is a ~10-line change, so it is the smallest bite that proves the harness works. |
| **R2** Horner fix in `evaluate_poly` | Changes the multiplication sequence inside the hottest function | Same harness. Mathematically identical by distributivity in a finite field (exact arithmetic, no rounding) — but "mathematically identical" is an argument, not a gate. **Do R1 or R2, not both.** |
| **R3** Parallel grinding | Changes how the nonce is found | `grind_nonce` returns the first satisfying nonce scanning upward from 0. Workers must partition the nonce space into **complete disjoint residues** and the caller must take the **minimum** nonce any worker returns. Prove: same nonce, same `query_seed`, same proof bytes, over ≥1,000 random seeds, plus the full 7-circuit golden-vector harness. |
| **Shrinking `UNIFORM_PROOF_SIZE` padding** | Two independent problems, both real | **Recommendation: decline.** (i) Skipping the zero chunks relies on the padding region already being zero on-chain, but the resize instruction declares `realloc::zero = false` (`programs/p01_stark_verifier/src/lib.rs:496-500`) — you would be depending on an unstated runtime guarantee, and if it does not hold you get garbage where the verifier expects zeros. (ii) The padding exists to close privacy leak L14 (`services/stark/index.ts:60-72`); keeping the *account* uniform while letting the *transaction count* vary by circuit (122/140/141) re-leaks the same bit through a different channel. And after L1-L3 land, the 24 wasted C1 chunks cost under 2 s. Not worth the argument. |

**Do not touch, in any pass:** `D:/Protocol-01/stark/**` and `D:/Protocol-01/programs/**` are owned by another
workflow right now. R1-R3 are report-only until that clears **and** the golden-vector harness exists.

---

## 7. Ordered execution list

### Phase 0 — Measure (do not skip; ~2 h)

| Step | Effort | Output |
|---|---|---|
| Run privacy-test → Test 5 five times, record `durationMs`, `wall`, `proofSize` | 10 min | On-device C0 time, real C0 size, wasm tier-up penalty |
| Add I1/I2/I3 logs (§1.1) | 1 h | Per-circuit proof time, bridge cost, JS-thread stall histogram |
| Run the §1.2 runbook for all five flows | 45 min | The real §1.3 table |
| Run the cgroup check (§4.T1) during a shield | 5 min | Kills or promotes the renderer-throttling hypothesis |
| Count `429` / `-32429` lines in the captures | 2 min | If zero, L1 and L3 are free money — proceed with confidence |

**Gate:** if the §1.3 table shows proof generation is a small share of each flow, R1-R3 stay parked indefinitely
and the whole effort goes into transport and UI. If it shows proof generation dominating pause/cancel (likely,
given grinding) or shield (less likely), re-rank accordingly.

### Phase 1 — Free seconds and unblocked frames (~14 h, ship together)

| Order | Item | Safety | Hours | Expected saving |
|---|---|---|---|---|
| 1 | **P3** Stop the dead screen (shield + unshield) | SAFE | 4 | 0 s; removes the worst symptom |
| 2 | **L1** Retune wave stagger (12/150 + adaptive back-off) | SAFE | 3 | ~29 s shield, ~58 s unshield, ~15 s pause/cancel |
| 3 | **L3** Scope jitter out of bulk upload | SAFE | 2 | ~14.5 s shield, ~29 s unshield, ~8 s pause/cancel |
| 4 | **P2** `verifySignatures: false` on serialize | SAFE | 1 | 0 s; ~60% of JS-thread ed25519 work gone |
| 5 | **P1** Yield between signatures | SAFE | 3 | 0 s; **the input-lag fix** |
| 6 | **L9** `skipPreflight` on init/close; gate the third simulate | SAFE | 1 | ~2-4 s per proof |

**Phase 1 expected: shield ~75 s → ~30 s. Unshield: ~90 s off, plus the dead screen gone and the freezes broken up.**

### Phase 2 — Structural transport (~19 h)

| Order | Item | Safety | Hours | Expected saving |
|---|---|---|---|---|
| 7 | **L2** Real pipelining / single-sweep confirm | SAFE | 4 | ~10-20 s per proof |
| 8 | **L13** Read-back gate before verify | SAFE | 3 | Eliminates a tail-loss + misdiagnosis class |
| 9 | **L14** Fix orphaned buffers (prerequisite for L4) | SAFE | 6 | 0 s; recovers real SOL |
| 10 | **L4** Interleave C1 and C3 uploads | SAFE | 6 | ~half the remaining unshield upload |

### Phase 3 — Perceived quality and the long tail (~23 h)

| Order | Item | Safety | Hours | Effect |
|---|---|---|---|---|
| 11 | **P4** Transient state out of the persisted store | SAFE | 3 | 28-51 encrypt+write cycles removed |
| 12 | **P6** Honest progress (per-chunk + step spans) | SAFE | 3 | "Frozen" → "working" |
| 13 | **P5** Narrow store subscriptions | SAFE | 4 | ~50 reconciliations → ~1 |
| 14 | **L8** Sweep off the critical path | SAFE | 3 | ~8-16 s off perceived unshield |
| 15 | **L6** Cache the C0 proof | SAFE | 4 | One full C0 proof per pause/resume/cancel |
| 16 | **P7** Pause/Resume re-tap guard | SAFE | 2 | Prevents self-inflicted 2-3× waits |
| 17 | **L7** Root check before C1 | SAFE | 2 | One C1 proof + ~30-60 s on the abort path |
| 18 | **L10** `Promise.all` the pre-flight reads | SAFE | 2 | ~1-1.5 s per flow |

### Phase 4 — Bigger swings (~30 h)

| Order | Item | Safety | Hours | Effect |
|---|---|---|---|---|
| 19 | **L5** Leaf-scan cache + delta + batched `getTransaction` | SAFE | 8 | Tens of seconds on unshield; near-total on repeats |
| 20 | **P8** Fix the launch-time WASM injection | SAFE | 3 | Shorter time-to-`starkReady`, no UI-thread stall |
| 21 | **P9** Fast hex decode + `subarray` | SAFE | 4 | One 150-600 ms stall per proof |
| 22 | **L11** Batch-unshield pipelining | SAFE | 4 | Hides proof gen for notes 2..N |
| 23 | **L12** Send-failure recovery | SAFE | 2 | Avoids full restarts |
| 24 | **4.T2** HTTP confirm instead of WS-only | SAFE | 2 | 0 s today; removes a 60 s × 4 cliff |
| 25 | **4.T1** WebView geometry — **only if the cgroup check confirmed it** | SAFE | 1.5 | Potentially 3-8× on every proof |
| 26 | **P10** Re-enable `transform-remove-console` — **last, it blinds Phase 0** | SAFE | 2 | Few hundred ms to low seconds per flow |

### Phase 5 — Gated prover pass (RISKY, blocked on the golden-vector harness)

Do not start until: Phase 0 proves proof generation is worth the risk, `stark/**` is released by the other
workflow, and a committed 7-circuit golden-vector byte-equality harness exists and passes on the unmodified code.

| Order | Item | Safety | Hours | Effect |
|---|---|---|---|---|
| G0 | Build the golden-vector harness (7 circuits, pinned inputs, byte equality) | prerequisite | 8 | The gate itself |
| G1 | **R4** CSP `worker-src blob:;` | SAFE | 1 | Unblocks all parallelism |
| G2 | **R3** Parallel grinding | RISKY | 10 | Est. ~4× on the pause/cancel proving term; truncates the p95 tail |
| G3 | **R1** NTT for the LDE evaluation (`final_q` site first) | RISKY | 16 | Est. 5-6× on shield/unshield proving |

---

## Appendix — stale comments and docstrings found while verifying

These actively mislead the next reader. Fix them in whatever pass touches the file.

| File:line | Says | Reality |
|---|---|---|
| `services/stark/index.ts:616-618` | "PIPELINED: batch N+1 prepares + sends WHILE batch N is still confirming" | The loop at `:636` is strictly sequential with an awaited confirm at `:681`. **Nothing overlaps.** |
| `services/stark/index.ts:450-451` | "Tuned for Helius free tier (~10 RPS)" | 3 sends / 700 ms = **4.3 tx/s**, less than half. And Helius is now a paid key. |
| `services/stark/index.ts:707` | "Upload proof in chunks (900 bytes per tx)" | `MAX_CHUNK_SIZE = 1000` (`:40`). |
| `services/stark/StarkProver.tsx:9`, `providers/StarkProverProvider.tsx:7` | "base64 (50KB)" / "only 50KB" | 192,732 B wasm → **256,976 base64 chars**. Stale by ~5×. |
| `babel.config.js:44-51`, `index.js:20-29` | "TEMP" console-stripping disable, dated 2026-05-08 | Still disabled 80 days later, in whatever ships next. |
| `app/(main)/(settings)/privacy-test.tsx:352` | "~9KB compact proof" | Screen prints the real `proofSize` two lines above; the copy is stale. |
