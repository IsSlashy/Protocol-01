<!--
  Generated 2026-08-18 from a multi-agent trace of the live subscribe path.
  Every file:line was re-checked against the source by a second verification
  pass. Regenerate rather than hand-edit: its whole value is that it matches
  the code.
-->

# What actually happens when you subscribe

Scope: `/pay` → Subscribe tab, SOL pool, devnet. Everything below is anchored to `D:\Protocol-01\apps\web` unless a path says otherwise. Phase table is `lib/pay/flowProgress.ts` (**not** `components/pay/`). Percentages are `SUBSCRIBE_PHASES` (flowProgress.ts:78-91), weights `locate .10 / path .07 / prove .28 / buffer .05 / upload .40 / open .10`, midpoint rule + monotonic floor (`progressFor` :112-132, floor fed back by `FlowProgress.tsx:39,48`).

Read the two structural facts first, because most "it's stuck" reports are one of them:

- **An unmatched worker sentence does not move the bar and does not change the label.** It holds at `floor`. Several of the longest stretches in this flow emit only unmatched sentences.
- **The bar is monotonic.** A sentence that computes a *lower* percent than the floor is discarded silently. This is why the label can be right and the number frozen at the same time.

---

## 1. Ordered walkthrough

### Stage A — the click (nothing signed, nothing on chain)

**1. Button gate** — `components/pay/SubscribePanel.tsx:1210-1214`, `blockedReason` computed :534-547, `busy = submitting` :839
- emits: nothing · label: none
- fails: button greys to 50% opacity, reason renders centred above it (:1206-1208). No handler runs.
- 🚨 **Hole**: with ZERO notes held, arm 5 (`!note && unspent.length > 0`) is false and `periods` is `null` (:531-532), so `blockedReason` is `null` and the button is **enabled with no note selected**. That is the entry to the issuance path, and the reason affordability is re-checked inside the handler (step 6).
- `busy` deliberately excludes `scanning` (comment :834-838).

**2. Handler re-guard** — `:549-550`, `if (!signOne || !service) return;`
- Silent return. **No `setError`, no `setSubmitting`, no state change.** A click with zero feedback. Only reachable if wallet/vendor changed between render and click.

**3. Note in scope** — `:571 let spending = note`, `:585 let issuedThisClick = false`
- `note` = `unspent.find(...)` from render scope (:527); `unspent` (:518-524) filters `spent`/`spentHere`/`handedOver` — but those filters are *short* when the worker skewed or lost its session (`staleWorker` :477, `lostSession` :481), so a spent-or-promised note can reach here.
- `issuedThisClick` exists because of a measured double-redeem: "the claim counter reached 2 on a single click, twice in one evening" (comment :572-584).

### Stage B — issuance sub-flow (`if (!spending)`, :586) — skip to step 12 if a note was held

**4. Ask the deployment what it issues** — `:590` → `lib/privacy/shieldClient.ts:732-742` (`GET /api/issue-note`, server `app/api/issue-note/route.ts:151-176`)
- 1 HTTP GET, no Solana RPC. Every failure collapses to `null` (`catch` :739-741 + the `!res.ok || !body.ok || !body.configured || !body.denomination` test :737). **A network failure and a deployment that issues nothing are indistinguishable.**

**5. Refusal** — `:591-598`
- `setError('You hold no note and this deployment does not issue them, so there is nothing to subscribe with. Nothing was spent. …')`, then `return`. `setSubmitting` was never raised → **no spinner ever appears, no FlowProgress mounts, the click looks instant.**

**6. Affordability, before redemption** — `:599-617`, `periodsFunded` :155-159
- `BigInt(Math.round(denom * 10**decimals)) / priceAtomic`; `0n` → red line + return. Ordered before the POST on purpose so the single-use claim survives.

**7. `setError(null)` → `setSubmitting(true)`** — `:618-619` (exact order)
- First time `submitting` rises. Knock-ons: `onBusyChange(true)` (:392-396), button becomes spinner + `Subscribing…` (:1216-1218), FlowProgress mounts (:1232-1242), all vendor/note/refresh buttons disable.
- label: **"Starting", 0%** · **No `setResult(null)` here** — a previous success card (license key, vault, explorer link) stays on screen through the whole issuance. It is cleared only at :680.

**8. Funder ticket precheck** — `shieldClient.ts:785-786` (entered from `:621-628`)
- `funderTicket()` reads the **build-time** `NEXT_PUBLIC_P01_FUNDER_TICKET` (`pool/ephemeralFunder.ts:80-83`); step 4 asked the **server**, which checks `P01_FUNDER_TICKET`. Build-vs-server skew makes `throw new Error('This deployment does not issue notes.')` reachable in a live deployment.

**9. Worker crossing #1 — note receive address** — `shieldClient.ts:790-791 → :846-848` (`poolRequest({kind:'poolNoteAddress'})`)
- emits: `Asking for a note (your wallet does not deposit one)...`
- label: **none — matches no `SUBSCRIBE_PHASES` regex.** Header still reads "Starting" at 0%, raw sentence under the bar (:1240).
- Not memoised. First worker call on the no-note path.

**10. Claim-code redemption** — `shieldClient.ts:793-817`; server `app/api/issue-note/route.ts:178-296`
- Silent between the previous string and `Opening the note...`. Bar still 0%.
- Server order: ticket 401 (:179-185) → JSON 400 (:187-192) → `p01pq:` recipient 400 (:194-197) → token/denomination 400 (:198-213, *before* the claim is consumed) → KV 503 (:218-219) → per-IP 429 (:220-228) → **devnet genesis 403 (:230-245), also before the claim** → format 402 (:263-268) → **`kv.incr('p01:note:claim:<code>')` at :274 = the irreversible consumption** → `claimed !== 1` 409 (:278-282) → minted 402 (:292-296) → inventory leaves claimed with a second `incr` each (:324-338), idempotent only for the same recipient.
- Server-side cost: `getGenesisHash` + `fetchPoolCommitments` (:307) — a **full pool-history read**. Slowest step of the segment.

**11. Worker crossing #2 — open and verify the note; state writes; `finally`** — `shieldClient.ts:824-829 → :592-611`; panel `:629-633`; `finally :637-640`
- emits: `Opening the note...` — **also unmatched.** `/verif|opening the subscription|closing/i` is the `open` regex (flowProgress.ts:90); "Opening the note" is not it. Still "Starting", 0%.
- The worker recomputes the commitment from the secrets and refuses a mismatch (comment :819-823); the blob is written to the encrypted store **before** success is reported (:607-609) — the blob *is* the note's existence on this device.
- State, exact order: `setIssuedDisclosure` :629, `setNotes(prev => [...prev, note])` :630, `setSelectedNote` :631, then locals `spending` :632 / `issuedThisClick = true` :633.
- `finally`: `setSubmitting(false)` :638 then `setStep(null)` :639 — **runs on the success path too**. Safe only because there is no `await` between it and `setSubmitting(true)` at :681, so React 19 batches the false→true pair. Insert one `await` in :643-681 and the button is enabled, `blockedReason` is `null` (a note is now selected and funds ≥ 1 period), and a second click runs a second subscribe.

### Stage C — handler proper

**12. `note_` handle + wiring guard** — `:643-644`, `:645`, `:672-678`
- `if (!call)` → `setError('subscribeFromPool has not been wired into lib/privacy/shieldClient.ts yet, so nothing was sent. No funds moved.')`. Dead in practice (`shieldClient.ts:330` exports it), but the wording is **false after step 10**: the claim code is already burned.

**13. `setError(null)` → `setResult(null)` → `setSubmitting(true)`** — `:679-681` · FlowProgress remounts, "Starting", 0%.

**14. Argument evaluation** — `:705 encryptedNotes: await shieldClient.loadEncryptedNotes(...)` → `shieldClient.ts:1057-1072` → `sealedStore.ts:51-64`
- Evaluated as an argument, so it runs **before** `call` at :695. `storeSession(meta)` = `Promise.all([poolStoreLabel, poolNoteAddress])`, memoised per meta in a module Map → **on a user who held a note, this is the first worker crossing of the click.**
- Failures degrade to the v1 view rather than throwing (`catch` :1067-1071), so a missing worker session surfaces one step later, inside the worker.
- Also fixed here: `serviceId: licenseServiceTag(service.slug, retailer)` (:703, `lib/privacy/license.ts:105-109` — must match what mobile posts), `onProgress: setStep` (:708), `neverExposeWallet: NEVER_EXPOSE_WALLET` = hard-coded `true as const` (:420) — **no setting turns it off on this screen**.

### Stage D — worker: find the note (`locateOwnedNote`, `lib/privacy/worker/poolHandlers.ts:1478-1663`)

Read-only end to end: `getSignaturesForAddress`, `getTransaction`, `getProgramAccounts`, `getAccountInfo`, `getSlot`. Nothing is built, signed or sent.

**15. Preconditions** — `:1492-1494`
- Throws `No pool keys for this identity. Reconnect and sign to derive.` (:1139) or `` No ${token} pool for ${denomination}. Supported: ${available}. `` (:1162).

**16. First phase message** — `:1514` emits `Locating your note on-chain...` → label **"Finding your note", 5%**.
- Re-arms the main thread's silence watchdog. The watchdog was armed when the request was posted (`workerClient.ts:126`, `POOL_SILENCE_TIMEOUT_MS = 180_000` :45); every progress message resets it (:78-81 → :130-133).

**17. Heartbeat** — `:1527-1531`, cleared `:1658-1662`
- emits every 10 s: `` Still looking — ${seconds}s so far. Keep this tab open. `` — elapsed seconds only; nothing here can measure its own progress.
- label: **"Finding your note"** on subscribe (matched at flowProgress.ts:85). 🚨 On **withdraw** this string matches nothing (WITHDRAW_PHASES :70 lacks `still looking` and `checking notes you already hold`) — the exact stale-label bug the SUBSCRIBE comment (:79-84) says was fixed here but not there. `__tests__/lib/flowProgress-labels.test.ts:141-146` only asserts *some* table matches, so the gap is uncovered.
- A throttled (hidden-tab) interval can let the 180 s watchdog kill a healthy job — hence the sentence's own "Keep this tab open."

**18. Pool history walk — the bottleneck** — `:1546` → `pool/denominatedPool.ts:1366-1449`
- **Silent.** `fetchPoolCommitments` accepts `onProgress(scanned, total)` (:1372, fired per batch :1445) and `locateOwnedNote` calls it **with no options object** — the one honest `x of N` number on this path is discarded.
- 1 `getSignaturesForAddress` (cap `maxSignatures = 1000`, PAGE 1000, :1375-1392) + one `getTransaction` per signature. The `batchSize = 25` `Promise.all` (:1396-1404) buys **zero** concurrency: the pool's Connection uses `createPacedFetch` (poolHandlers.ts:1099-1104), one request in flight on a single promise chain, 120 ms sleep after each (`pacedFetch.ts:20,27-30,67-72`).
- Measured 2026-08-18 vs `api.devnet.solana.com`: `getSignaturesForAddress` 390 ms; `getTransaction` 397 ms avg (337-534). 0.1 SOL pool N=60 → ~31 s. 1 SOL pool N=48 → ~25 s. At the 1000-sig cap → ~8.6 min.
- Rate-limit backoff `sleep(300 * 2**(attempt-1))`, `MAX_ATTEMPTS = 6` (pacedFetch.ts:23,36) → up to ~9.3 s extra per request. Helius devnet returns **HTTP 200 with a JSON-RPC `-32429` body**, so a throttle does not look like one (:43-52).
- Side effect that matters later: `depositPayer = feePayerOf(tx)` = `staticAccountKeys[0] ?? accountKeys[0]` (:369-378), stored per commitment at :1441. **The entire deposit-origin database is this Map, built for free.**

**19. Spent set** — `:1549` → `denominatedPool.ts:692-706`
- Silent. **1** pool-wide `getProgramAccounts` on `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`, `dataSize 41` + `memcmp(offset 8)`, `dataSlice {0,0}`. Measured: 26 records in 66 ms.
- Deliberately pool-wide and identical for every user — the per-note `getAccountInfo(nullifierPDA)` it replaced was a full deanonymisation channel (header :674-688).
- **Not** wrapped in try/catch, on purpose: `RecoveredNote.spent` is a plain boolean with no unknown state (poolNotes.ts:138-143). Any RPC failure rejects the prepare.

**20. Blob-first probe** — `:1584-1595 → :1733-1786`
- emits `Checking notes you already hold...` → "Finding your note" (subscribe); unmatched on withdraw.
- Tries each stored blob × each seed candidate, revalidates via `shareableNoteToReceipt`, cross-checks the chain map **conditionally** (`if (onChain && onChain.leafIndex !== leafIndex) continue`, :1769-1770) so a commitment this RPC no longer serves is not refused.
- "Blob first" is first among *matching* strategies only — it needs `commitments`, so it runs after steps 18-19 and saves **none** of the ~31 s walk. What it saves is the derivation search, which can never find received/issued notes.
- Cost: a full ML-KEM-768 keygen + decapsulate + X25519 + secretbox open per (blob × seed), **no key cache** (`noteCrypto.ts:151-177` → `:71-83`).
- 0 or 1 RPC: `isNullifierSpent` → `getAccountInfo(nullifierPDA)`, only on a match — the sanctioned single-note leak (the note is about to be spent anyway, :1772-1776).

**21. Derivation search** — `:1597-1615` → `pool/poolNotes.ts:108-227`
- emits `Reading pool history...` (poolNotes.ts:116 — **emitted unconditionally although nothing is fetched**, and unmatched by SUBSCRIBE/WITHDRAW) then `Matching notes...` (:150) → **"Finding your note"**. `Reading spent markers...` never fires (set hoisted).
- Two loops: `blindedOnly ∈ [true,false]` × seed candidates. `onlyLeaf: req.leafIndex` intersected with the leaves the RPC actually served (:160-165).
- Pass 1: 3 HKDF (2 in `deriveNoteMaterial`, denominatedPool.ts:429-430; 1 in `deriveNoteBlinding`, noteBlinding.ts:61-78) + 1 `createCommitmentV3`. 0 RPC.
- Pass 2 (legacy epochs): up to 6001 `createCommitmentV3` (`DEFAULT_EPOCH_WINDOW` 6000, :53) ≈ 0.7 s per derivation at the recorded 0.1158 ms/hash; 1 `getSlot('confirmed')` per call. **Never skip it** — there is a known unspent legacy note at leaf 30 of the 0.1 SOL pool (:181-186).
- Without `onlyLeaf` this same search ran on every foreign leaf: measured ~41 s per derivation on the 59-leaf pools (poolHandlers.ts:1551-1558).

**22. Fallback blob probe — dead code** — `:1626-1639`
- Byte-identical arguments to step 20 (compare :1586-1593 with :1627-1634), reached only when step 20 returned null, deterministic over unchanged inputs → **can never return non-null**. Repeats the whole ML-KEM sweep, silent, for nothing. Header comment :1617-1625 describes the pre-:1584 ordering.

**23. Resolve or refuse** — `:1641-1648`
- `No note of yours found at leaf #N in the D SOL pool. If it was just shielded, wait for the RPC to index it.` or `This note has already been withdrawn.`

**24. `extractStoredPath` + return** — `:1650-1657 → :1691-1714`
- Decrypts blobs once more under the winning seed only, looking for a `merklePath` with array `pathElements`/`pathIndices` and a `root`. Cannot fail (every parse error skipped, :1709-1711) — a miss downgrades to a full rebuild: slower, never wrong. Returns `commitments` so callers never re-walk (:1487-1490).

### Stage E — deposit origin and the self-deposit refusal

**25. Origin lookup** — `poolHandlers.ts:2261`
- `commitments.get(note.receipt.commitment.toString())`. **No chain access.** Keyed by the value the spend republishes in cleartext (:2257-2260) — one hop for a stranger.
- `null` = **unknown**, not safe (type comment :930-933): the leaf's insert fell outside the 1000-sig window, or the tx had no readable header.

**26. `resolveFunderOfPayer`** — `:2285-2288` (call), `:2176` (def)
- emits `Checking who deposited this note...` → label **"Rebuilding its history", 13.5%** (`/checking who deposited/`, flowProgress.ts:86).
- `getSignaturesForAddress(payer, {limit: 1000})` (`FUNDER_SIGNATURE_LIMIT` :2166), reverse, oldest 5 (`FUNDER_OLDEST_SAMPLE` :2168) — a key is created by being funded. Per candidate: `getParsedTransaction`, `gained = post-pre` for the payer must be > 0, then the *other* account whose loss best matches `gained` within `FUNDER_AMOUNT_TOLERANCE_LAMPORTS = 1_000_000` (:2174, :2230-2240).
- Two recorded fixes: limit was 50 — never reached a shield ephemeral's first tx past its ~150 chunk uploads, so **every** note returned null and the refusal read as "you deposited this yourself" (measured 2026-08-18, :2182-2195); and the source rule was "first account that lost lamports", which always returned `accountKeys[0]` = the fee payer, right only by luck (:2219-2229).
- 🚨 **Fails closed to `null`, silently** — the whole body is in a comment-only `try/catch` (:2242-2244). RPC error, bad pubkey, >1000-sig address: all indistinguishable.
- ~1 s for a payer with 102 signatures (:2283-2284).

**27. `selfDeposited`** — `shieldClient.ts:384-388` — a 4-term OR, **two of which are just "unknown"**:
`depositPayer === null || depositFunder === null || depositPayer === owner || depositFunder === owner`.
Term (c) is effectively dead for notes this client deposits — a deposit is signed by a fresh ephemeral (measured: wallet `BRop…TjNN`, deposit payer `8Eq1jsbB…`, comment :373-380). Term (d) is the one that fires.

**28. The throw** — `shieldClient.ts:389-394`
- `if (params.neverExposeWallet && selfDeposited) throw new SelfDepositedNoteError(prep.depositFunder ?? prep.depositPayer, prep.depositSignature)`. The panel hard-codes the flag `true` (:420, passed :709/:786), so **on this screen the guard is always armed**.
- Fires **before** `fundEphemeralForJob` (:404): nothing signed, nothing funded.
- 🚨 **Message/guard mismatch, confirmed.** Constructor at `:255-274` branches on one argument. When `depositPayer` is known and `depositFunder` is `null` — the common `resolveFunderOfPayer` failure — `depositFunder ?? depositPayer` is non-null, so Branch B runs and asserts *"this note was deposited by your own wallet (8Eq1…)"* while naming an ephemeral that was never compared to the wallet. The honest "could not be found" wording is unreachable unless **both** are null.

**29. Panel catch: swap once** — `SubscribePanel.tsx:731-756`
- emits `This note traces back to you — fetching one that does not...` → **unmatched, bar and label freeze**.
- If `issuedThisClick`: throws `The deployment issued you a note, and then refused it — it could not establish who deposited it, and an unknown depositor is treated as you. Your note is safe and is in your notes list; your claim code is spent and was not wasted on a second copy. This is a fault in the deposit lookup, not in your note.` (:737-744).
- Else `swapForIssuedNote()` **once** (:746, def :656-671, re-sends `claimCode.trim()`), retry at :758; if nothing issuable, the `The only note you hold was deposited by your own wallet … Nothing was spent. ` message (:747-754).

### Stage F — prepare (`pool/subscribeEphemeral.ts:106`); still nothing signed

**30. Delegate to `prepareUnshieldJob`** — `subscribeEphemeral.ts:114-121`, no try/catch
- Withdrawal errors surface verbatim during a subscribe, including `This note has already been withdrawn.` (`unshieldEphemeral.ts:155`).
- Header :8-11 claims a C3-free path; the deployed program disagrees — `programs/zk_shielded/src/instructions/subscribe_private_stark.rs:233` requires `c1_circuit_id == 1` and `:285` requires `c3_circuit_id == 3`.

**31. Nullifier pre-check** — `unshieldEphemeral.ts:147-156` → `denominatedPool.ts:760-771`
- emits `Checking the note is unspent...` → **"Rebuilding its history", 13.5%** (`/checking the note/`).
- 1 `getAccountInfo` (default commitment — no commitment argument at :769). Documented as **⚠️ leaking the nullifier PDA to the RPC** (:751-758), kept only here because the nullifier is about to be published anyway. Protects a ~2-minute proof + buffer rent.

**32a. Stored-path route** — `unshieldEphemeral.ts:162-164` → `unshieldFromPath.ts:97-102`
- emits `Checking the stored Merkle root is still accepted...` → 13.5%.
- `isRootAccepted` (:63-82) compares against pool data `88..120` and the ring at `178..182` + entries from `182`. Ring is `MAX_HISTORICAL_ROOTS = 100` (`state/pool_v3.rs:185`).
- Returns **null, not a throw**, on: missing pool account (:69), data < 182 bytes (:71), `ringLen > 100` (:77), truncated ring (:77). All four are indistinguishable from "aged out" — layout drift silently downgrades to the full history walk.

**32b. Stored-path proofs** — `unshieldFromPath.ts:113-157`
- emits `Generating C1 (pool_commitment) STARK proof...` (:123) then `Generating C3 (merkle_path) STARK proof from the stored path...` (:135) → **"Proving you own it", 31%**, with a 10 s heartbeat `` ${stage} (${seconds}s)... `` (:115-118) whose own strings are unmatched and hold the bar.
- Mismatch → `Stored Merkle path does not reproduce its root (X vs Y). Falling back to a full history rebuild is required for this note.` 🚨 **The message lies**: this throws out of `prepareUnshieldJob` (no try/catch at unshieldEphemeral.ts:162-164) and the fallback at :165-170 only triggers on a `null` return. Nothing performs the promised rebuild.

**33. History route** — `unshieldEphemeral.ts:169` → `denominatedPool.ts:1695-1710`
- emits `Fetching pool leaves from on-chain events...` → **"Finding your note"** (a *backwards* label from "Rebuilding its history"), then `Scanning events S/T...` which matches **nothing** (:85 wants "scanning the"; `parseChunk` wants the word "chunk") — the whole multi-hundred-call walk is silent to the bar. The number does not drop, though: the floor holds it at 13.5%.
- Missing leaves are only `console.warn`ed (:1702-1704, :1483-1487) and become `ZERO_VALUE_V3` — a wrong root, which step 34 exists to catch. `unshieldFromPath.ts:9-11` records public devnet serving **one** signature for a 30-leaf pool.
- `buildMerkleProofFromLeavesV3` (:1511-1563) replays 15 levels of Goldilocks Poseidon; throws `buildMerkleProofFromLeavesV3: target leafIndex N not found among M non-empty leaves. Try increasing maxSignatures…` — advice the caller cannot take, `maxSignatures` is hardcoded 1000 at :1699.

**34. Pre-flight root check** — `denominatedPool.ts:1712-1753`
- emits `Pre-flight root verification...` → 13.5%; on a miss `Root not in ring — retrying event scan with extended limit...`, **unmatched** — a second walk of up to 3000 signatures runs with the UI frozen.
- 🚨 The re-check at :1733-1734 reuses the **same `parsed` snapshot** read before the retry; the pool account is never re-read, despite the abort message telling the user to wait for RPC indexing.
- 🚨 **Fails OPEN**: pool account not found (:1751-1753) and `parsePoolV3Account` returning null (:1748-1750) are `console.warn` only — the run proceeds to prove, fund and upload against a root the program will reject.
- Abort text: `PRE-FLIGHT FAIL: Rebuilt Merkle root 0x… is not in pool's known roots (current + N historical). This would burn STARK proof rent (~2 SOL). Aborting. Wait ~10s for RPC to index recent transactions, then retry.`

**35. History-route proofs** — `denominatedPool.ts:1766-1815`
- emits `Proving you own the note...` (:1774) and `Proving the note is in the pool...` (:1787). 🚨 **Neither matches** `/generating c1|generating c3|stark proof/i`, or anything else. On the history route the longest silence in the flow (~60 s per proof, flowProgress.ts:5) leaves the bar at the pre-flight's 13.5% and the label never reaches "Proving you own it". The stored-path route (32b) does match. **This is a real, per-route UI divergence.**

**36. Price the buffers** — `unshieldEphemeral.ts:172-186`
- emits `Pricing the withdrawal...` → **"Reserving space on Solana", 47.5%** (`/pricing/`).
- 2 parallel `getMinimumBalanceForRentExemption(83 + proofSize)`. Both buffers are open simultaneously because the handler reads both in one tx (:177-178).
- `rawRequiredLamports = r1 + r3 + NULLIFIER_RENT(2_000_000, :82) + E_TX_FEE_BUDGET(4_000_000, :85)`. Line :186's `jitterPrefund` result is **dead on the subscribe path** — overwritten at subscribeEphemeral.ts:138.

**37. Ephemeral derivation** — `unshieldEphemeral.ts:188 → :98-107`
- `Keypair.fromSeed(hkdf(sha256, walletSeed, undefined, info, 32))`, `info = 'p01:web:unshield-ephemeral:v1' ‖ poolPDA(32) ‖ leafIndex(u32 LE)` (:79, :103-105). **Three inputs, no randomness, nothing about the subscription.** Fully deterministic, which is the only reason Recover works.
- Subscribe deliberately reuses the *unshield* separator so stranded rent stays inside the one recovery path (subscribeEphemeral.ts:17-26; the real citation is `recoverFloat.ts:193-196` + `:209-211`, **not** the `:83-87` the comment gives).
- Failure mode is later and silent: a subscribe and an unshield of the same leaf race on the same key. The header's "a note is spent once" argument (:25-26) covers shield/unshield, not that race.

**38. Vault rent + jitter** — `subscribeEphemeral.ts:123-139`
- emits `Pricing the subscription vault...` → 47.5%.
- 1 `getMinimumBalanceForRentExemption(SUBSCRIPTION_VAULT_LEN = 361, :74)`. 361 is a hand-mirrored Rust struct (`state/subscription_vault.rs:135-153`); the vault is `init, payer = payer` (`subscribe_private_stark.rs:85-96`) and the payer is the ephemeral. **This rent does not come back** (:70-73). Under-price it and you find out after ~150 chunk uploads (:67-69).
- `requiredLamports = jitterPrefund(base.rawRequiredLamports + vaultRent)` (:132,:138) — applied to the **complete raw sum**, never to the already-jittered base. `jitterPrefund` (prefundAmount.ts:79-83) rounds up to `STEP_LAMPORTS = 10_000_000` and adds 0-4 more, drawn by rejection sampling from `crypto.getRandomValues` (:63-71).
- `jobId` overridden to `` subscribe:${poolPDA}:${leafIndex} `` (:136) so a subscribe can never be handed to the withdrawal executor.

### Stage G — who pays (`pool/ephemeralFunder.ts:337-443` + `app/api/fund-ephemeral/route.ts:261-396`)

**39. Guard 1 — ephemeral must be empty** — `ephemeralFunder.ts:355-356`
- 1 `getBalance('confirmed')`. `> 0` → `DirtyEphemeralError` (:289-298): `This job's signing key already holds ${balance} lamports from an earlier attempt. Run Recover first — funding on top of it would mix two parties' money on a key that can only be swept to one of them.`
- This replaced a bug where the server's 409 was caught and fell back to the wallet with `sweepTo = owner`, handing a treasury grant to the user (:345-349).

**40. Pessimistic defaults** — `:361-364`: `fundedBy = 'wallet'`, `sweepTo = owner`. Everything after can only upgrade them.

**41. Value guard** — `:373-376`. `valueLamports > 0` → funder **not asked**, `funderConfigured()` never evaluated. Subscribe passes `valueLamports: 0` (shieldClient.ts:404-413) because the value comes from the pool; the shield leg passes real value and always pays from the wallet.

**42. `funderConfigured()`** — `:377`, `:80-87`. Reads the **build-inlined** `NEXT_PUBLIC_P01_FUNDER_TICKET`. False → the entire funder branch is skipped, `funderFallbackReason` stays `undefined`, **nothing is emitted and nothing errors**. The server's GET names this as its own `blindSpot` (route.ts:252-256): no server can see what a past build inlined.

**43. POST `/api/fund-ephemeral`** — emits `Asking the funder to cover this job (your wallet stays off chain)...` (:379) — **unmatched, bar holds**. Request carries `x-p01-funder-ticket` + `{ephemeralPubkey, lamports}` and nothing else: no proof, no secret, no signature request (:44-51, :330-335).
Server refusals, in order: 503 no `P01_FUNDER_SECRET_KEY` (:268) · 503 no server ticket (:269) · 401 mismatch (:271-273, plain `!==`, and the ticket ships in the browser bundle so this is not authentication, :48-56) · 400 bad JSON (:275-280) · 400 bad pubkey (:282-287) · 400 lamports (:289-292) · 400 cap `2_000_000_000` (:293-295, :72) · 429 instance ceiling `20_000_000_000` on a module-scope `let` that resets every cold start (:296-298, :79-87) · 503 **no durable rate limiter — fail closed** (:313-316) · 429 12/IP/hour (:317-322, salt `p01:fund-ephemeral:v1`) · 503 limiter errored (:323-328) · 403 **devnet genesis checked against the chain**, `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (:330-339 — `getGenesisHash()` at :336 is **not** in a try, so an RPC outage becomes a Next 500) · 503 bad base58 key (:341-346) · 400 funding the funder (:347) · 409 target non-empty (:353-358).
Then `getLatestBlockhash` → one `SystemProgram.transfer` → `sign` → `sendRawTransaction` (:360-373) → `confirmTransaction` (:375-378, **also not in a try**) → 200 with **`sweepTo` = the funder's own pubkey** (:386-395).

**44. Client response handling** — `:112-128`. Body parsed **before** status so the reason survives. Three throws: `The funder replied with a non-JSON ${status}.` / `The funder refused: ${error}` / `The funder replied without a signature or a sweep address.`
Success → `fundedBy='funder'`, `sweepTo=grant.sweepTo` set **together** (:381-383) — `sweepTo` is non-optional on `JobFundingDecision` (:271-280) precisely so a leg cannot fund through the treasury and sweep home.

**45. Failure → one string** — `:384-387` emits `The funder could not cover this job — falling back to your wallet.` **Unmatched by every phase table** — bar holds. This is the line `docs/DEMO-untraceable-subscription.md:47,243-246` tells the operator to stop on.

**46. `neverExposeWallet` refusal** — `:394-398`, covering *both* "funder failed" and "funder never asked":
`Stopped before spending anything: the funder could not cover this job, and paying for it from your own wallet would put your address on chain — which you asked to avoid. The funder said: ${reason}` (`WalletExposureRefusedError` :308-317). Nothing spent, nothing stranded.

**47. Wallet fallback** (only if the flag is off) — `:400-440`. emits `Approve the funding transaction in your wallet...` — unmatched for the pool legs (the `/approve/i` match at flowProgress.ts:161 belongs to `STEALTH_SEND_PHASES`). Uses `getLatestBlockhash('finalized')`, **not** `'confirmed'`, because wallets simulate against their own node and a seconds-old blockhash produces "Blockhash not found" across the human's approval delay (:402-419).

### Stage H — execute (`poolHandlers.ts:2344-2400` → `subscribeEphemeral.ts:203-291` → `subscribePrivateStark.ts:219-308`)

> The supplied execute map is **truncated after C1 `init_proof_buffer`**. Steps 50-56 below I read from source myself; its fixture-derived timeline (frozen devnet run `4v6RLndU…`, ephemeral `L1FNpmAwMypucVNhkyG3vyZBSYpPhJWZ6juaUGJEyHv`, 172 txs) is reproduced as given.

**48. Job lookup** — `poolHandlers.ts:2347-2351`. `preparedSubscribes.get(req.jobId)` → `Unknown subscription job — prepare it again (the worker was restarted).` **Silent, and above the `try`** → no sweep. See §3.

**49. License key + signer + guards** — `poolHandlers.ts:2354-2371`; `subscribeEphemeral.ts:209-242`
- `deriveLicenseSecret(receipt.secret, serviceTag)` (HKDF, license.ts:119-127) → `encodeLicenseKey` → blake3 `licenseCommitment`. The secret never leaves the function; it is re-derivable forever via `handlePoolLicenseKey` (:2662).
- `intervalSlots <= 0n` → `The billing interval must be at least one slot.` and `getBalance` underfund → `The subscription signer is underfunded (N of M lamports). The pre-fund transaction may not have confirmed yet — retry in a moment.` — **both inside the `try`** (:224) so the `finally` sweep runs (:225-228).

**50. C1 upload+verify** — `subscribePrivateStark.ts:232-244` → `stark.ts:672-742`
- ⚠️ **Citation correction**: the subscribe path calls `submitAndVerifyStarkProof` at **stark.ts:672**, not the `:636-654` range the map gives (that is `getProofBufferStatus`/`submitGenericStarkProof`). Stale-close `:683-698`, init `:700-704`, resize `:711-719`, upload `:722`, verify `:724`/`:734`, retained message `:741`.
- Strings, in order: `Uploading the ownership proof...` → **"Uploading the proofs", 70%** (midpoint, no `i/N`) · conditionally `Closing stale proof buffer...` → matches `/closing/` in `open` → 🚨 **pins the floor at 95% for the rest of the run** · `Initializing proof buffer...` (47.5%, clamped) · `Resizing proof buffer (r/6)...` · `Uploading proof chunk k/69...` → `50 + 40·k/69`, only clears 70% at k=35 · `Confirming chunk uploads...` / `Confirming chunk uploads (N pending)...` (stark.ts:371,518) · `Checking uploaded proof against the local bytes...` · `Verifying STARK proof phase 1...` · `Verifying STARK proof phase 2 (DEEP-ALI)...` · `STARK proof verified (buffer retained for cross-program read)`.
- 🚨 **The three verify strings contain the substring "STARK proof", which matches `/stark proof/i` in the `prove` phase at index 2 — before `open` at index 5 — and `progressFor` takes the first match (flowProgress.ts:119).** So every verify sentence reports the label **"Proving you own it"** and computes **31%**, which the monotonic floor discards. The bar is frozen at 90% from C1's readback until `Opening the subscription vault...`: measured **125 slots, ~50 s of an 88 s run.**
- Chunk mechanics that explain hangs: `skipPreflight: true` on chunk sends (stark.ts:502); the readback gate exists because on-chain `bytes_written` is a **high-water mark** (lib.rs:89-90), so a hole of zeros passes the program's own completeness test (:455-473). Errors: `Chunk upload failed: N chunk(s) unconfirmed after M resend round(s). No verify fee was spent.` and `Proof buffer is torn on-chain: chunk(s) [...] still differ from the local proof after a repair pass. Aborting before spending verify CU.`
- Stale-buffer error: `Stale STARK proof buffer exists and cannot be closed. Please wait a few seconds and try again, or use a different wallet.` (stark.ts:693-696).

**51. C3 upload+verify** — `subscribePrivateStark.ts:246-258`, same code path
- `Uploading the membership proof...` → 70% computed, **discarded** (floor is 90). Then init/7 resizes/`Uploading proof chunk k/79` whose own band is `50 + 40·k/79` — never above 90 — so **the entire second proof is invisible.** This is the single worst UI stretch in the flow.

**52. The subscribe instruction** — `subscribePrivateStark.ts:270-296`
- emits `Opening the subscription vault...` → **"Opening your subscription", 95%** (`/opening the subscription/`). First bar movement in ~50 s.
- Derives `nullifierPDA` and `vaultPDA = f(retailer, subscriberCommitment, tokenMint)`, builds one tx, signs with the **ephemeral**, sends, confirms `'confirmed'`. Fixture: slot +203, discriminator `bba5f2d3d1131aa2`.
- Both proofs are uploaded and verified **before** this is built, on purpose: a proof that fails verification costs recoverable buffer rent rather than a half-created vault (:215-218).

**53. Close both buffers** — `subscribePrivateStark.ts:296-306` `finally`
- `closeStarkProofBuffer` per buffer, each failure only `console.warn`ed (`buffer close failed, rent recoverable later`). Runs on the failure path too. Fixture: slots +208 and +214.

**54. Sweep** — `subscribeEphemeral.ts:260-291` `finally`
- emits `Returning recovered rent to your wallet...` **or** `Returning recovered rent to the funder...` depending on `sweepTo.equals(ownerPubkey)` (:266-270). 🚨 **Neither string matches any phase** — the bar sits at "Opening your subscription · 95%" while the last money movement of the run happens.
- `sweepable = balance - SWEEP_FEE(5_000)`. Failure is swallowed with `[pool/subscribe] ephemeral sweep failed; the key is re-derivable, funds recoverable:` (:285-289).

**55. Worker response** — `poolHandlers.ts:2389-2396` returns `{txSig, vaultPDA, licenseKey, serviceTag, denomination}`; `finally` deletes the job from `preparedSubscribes` (:2398). `shieldClient.ts:431-443` adds `fundedBy`, `funderSignature`, `funderFallbackReason`, `depositPayer: prep.depositFunder ?? prep.depositPayer` (**the field named `depositPayer` usually holds the funder**) and `reachableViaDeposit`.

**56. Result banner** — `SubscribePanel.tsx:1311-1328`. Renders whenever `result.reachableViaDeposit !== false` (absent reads as reachable, :1308-1310) and picks its headline off `result.depositPayer`: non-null → `This note was deposited by your own wallet.`, null → `This note's deposit could not be found.` — **the same Branch-B mislabel as step 28.**

---

## 2. Stuck at X means Y

| On screen | Code actually running | First thing to check |
|---|---|---|
| **"Starting" 0%**, spinner, sentence `Asking for a note (your wallet does not deposit one)...` | `shieldClient.ts:846-848` worker `poolNoteAddress`, then `POST /api/issue-note` (route.ts:178-296) | Server-side: is it past `kv.incr` at route.ts:274? If yes the claim code is **already spent**. `fetchPoolCommitments` at route.ts:307 walks the whole pool — expect tens of seconds. |
| **"Starting" 0%**, sentence `Opening the note...` | `shieldClient.ts:592-611` worker `poolImportNote` + `storeEncryptedNote` | localStorage quota; commitment mismatch. Claim already burned — a retry gives 409. |
| **"Starting" 0%**, no sentence, no spinner, instant | step 2 (`:549-550`) or step 5/6 red line | `signOne`/`service` went null between render and click, or `/api/issue-note` returned null (network vs unconfigured are indistinguishable). |
| **"Finding your note" 5%**, `Still looking — Ns so far…` climbing | `poolHandlers.ts:1546` → `fetchPoolCommitments` | `N × ~517 ms` serialized by `pacedFetch`. 0.1 SOL pool ≈ 31 s, 1000-sig cap ≈ 8.6 min. Check the RPC for HTTP 200 bodies carrying `-32429` (pacedFetch.ts:43-52). |
| **"Finding your note"**, `Matching notes...` for >2 s | `poolNotes.ts:150-196`, legacy epoch pass | ≤6001 `createCommitmentV3` per derivation ≈ 0.7 s; 2 seeds (passphrase wallet) ≈ 1.4 s. Longer than that means `onlyLeaf` did not intersect — check `req.leafIndex` against the served leaves (:160-165). |
| Label frozen, sentence `Scanning events S/T...` | `denominatedPool.ts:1699`, history rebuild | Unmatched string, expected. Watch S/T in the sentence, not the bar. |
| Label frozen, sentence `Root not in ring — retrying event scan with extended limit...` | `denominatedPool.ts:1724-1727` | Second walk, up to 3000 sigs. Also: the re-check reuses the stale `parsed` pool snapshot (:1733-1734) — a genuinely-just-indexed root will still fail. |
| **"Rebuilding its history" 13.5%**, `Checking who deposited this note...` | `poolHandlers.ts:2176-2244` | 1 `getSignaturesForAddress(limit 1000)` + ≤5 `getParsedTransaction`, ~1 s. If it returns null the run dies at step 28 claiming your wallet deposited the note. |
| **13.5%** and no sentence change for ~2 min | 🚨 **history-route proving** — `denominatedPool.ts:1774/:1787` emits `Proving you own the note...` / `Proving the note is in the pool...`, which match **no** phase | This is the known table gap. Confirm via the raw sentence under the bar. ~60 s per proof. |
| **"Proving you own it" 31%**, `Generating C1/C3 … STARK proof...` | stored-path route, `unshieldFromPath.ts:123/:135` | Healthy. Heartbeat `${stage} (${seconds}s)...` every 10 s. |
| **"Reserving space on Solana" 47.5%** | `Pricing the withdrawal...` / `Pricing the subscription vault...` — `unshieldEphemeral.ts:172`, `subscribeEphemeral.ts:123` | 2-3 `getMinimumBalanceForRentExemption`. Should be sub-second; if not, it is the RPC. |
| **47.5%**, sentence `Asking the funder to cover this job…` then `The funder could not cover this job — falling back to your wallet.` | `ephemeralFunder.ts:384-387` | 🚨 **Stop.** On the subscribe screen `neverExposeWallet` is hard-coded true (SubscribePanel.tsx:420), so the next thing is a refusal — read the reason string, it is the server's verbatim error. |
| **47.5%** forever, no funder sentence at all | `funderConfigured()` false (`ephemeralFunder.ts:80-87`) — a build without `NEXT_PUBLIC_P01_FUNDER_TICKET` | Rebuild + redeploy. Setting the env var alone changes nothing; the value was inlined at build time. |
| **"Uploading the proofs" 70% → 90%**, `Uploading proof chunk k/69...` | C1 chunks, `stark.ts:495` | Real progress. 69 chunks for C1, 79 for C3. |
| 🚨 **Frozen at 90%** for up to a minute | C1 verify (both phases), then **all of C3**: init, 7 resizes, 79 chunks, readback, 2 verifies | Expected, not a hang. The raw sentence still moves — `Uploading proof chunk k/79`, `Verifying STARK proof phase 2 (DEEP-ALI)...`. Cause: verify strings hit `/stark proof/i` in `prove` (index 2) before `open` (index 5), compute 31%, and get floored away. |
| **90%**, sentence `Confirming chunk uploads (N pending)...` not decreasing | `stark.ts:371`, `confirmSignatures` | Chunks were sent `skipPreflight: true` (:502). Next it resends only the unconfirmed ones; `MAX_RESEND_ROUNDS` bounds it. |
| **95% "Opening your subscription"** reached almost immediately | `Closing stale proof buffer...` fired (`stark.ts:677`) — matches `/closing/` in `open` | A buffer survived a previous crashed run. The bar is now useless for the rest of the run; read sentences only. |
| **95%**, sentence `Returning recovered rent to your wallet...` / `…to the funder...` | `subscribeEphemeral.ts:266-283`, the sweep | Success already happened — the vault exists. `…to the funder` means the treasury paid; `…to your wallet` means it did not. |
| Error `Unknown subscription job — prepare it again (the worker was restarted).` | `poolHandlers.ts:2350` | 🚨 The pre-fund is stranded on the ephemeral (this throw is above the sweep's `try`). Run Recover. |
| Error `The private-payment worker timed out. Please retry.` | `workerClient.ts:121`, 180 s without any progress message | Which silent stretch: `fetchPoolCommitments` (heartbeat should prevent it — check the tab was visible), or a throttled `setInterval` in a background tab. |

---

## 3. Money at risk, by stage

### Unrecoverable

| What | Where it becomes unrecoverable | Amount (fixture, 1 SOL pool) |
|---|---|---|
| **Claim code** | `app/api/issue-note/route.ts:274`, `kv.incr('p01:note:claim:<code>')` | one note. Held in React state only (SubscribePanel.tsx:626), never on disk. A tab that dies after :274, or a 402 "never issued against a payment" (:292-296), burns it. A retry gives 409. |
| **NullifierRecord rent** | the `subscribe_private_stark` tx | 1,176,240 lamports (41 bytes) |
| **SubscriptionVault rent** | same tx; `init, payer = payer` (`subscribe_private_stark.rs:85-96`) | 3,403,440 lamports (361 bytes). Comes back only when the merchant's final `claim_period` closes the vault (subscribeEphemeral.ts:70-73). |
| **Transaction fees** | 171 ephemeral-signed txs | 855,000 lamports |
| **The note's value** | locked into the vault | the pool denomination |

Fixture net burn: **5,434,680 lamports**, and it reconciles exactly: 855,000 + 3,403,440 + 1,176,240.

### Refundable, swept automatically

- **Proof-buffer rent** — C1 480,880,320 + C3 545,441,280 ≈ **1.026 SOL**, released by `close_proof_buffer` in `subscribePrivateStark.ts:296-306`, which runs in a `finally` **on the failure path too**.
- **Everything left on the ephemeral** — swept in `subscribeEphemeral.ts:260-291`, also a `finally`, minus `SWEEP_FEE = 5_000`. Destination is `params.sweepTo ?? ownerPubkey`; on a funder-paid run that is the **funder's** address (route.ts:386-395), which is the point.

### Stranded, recoverable out of band

Two throws sit **above** the sweep's `try` (`subscribeEphemeral.ts:224`) and strand the entire pre-fund:

1. `Unknown subscription job — prepare it again (the worker was restarted).` (`poolHandlers.ts:2350`)
2. `new PublicKey(req.retailer)` on a malformed retailer (`poolHandlers.ts:2354`) — inside `handlePoolSubscribeExecute`'s own `try`, but that `finally` only does `preparedSubscribes.delete`.

Recovery works because the key is deterministic: `deriveUnshieldEphemeral(walletSeed, poolPDA, leafIndex)` with domain `p01:web:unshield-ephemeral:v1` (`unshieldEphemeral.ts:79,98-107`). `handlePoolRecover` → `recoverStuckFloat` imports exactly `deriveShieldEphemeral` and `deriveUnshieldEphemeral` (`recoverFloat.ts:73-74`) and enumerates `{leafIndex,'shield'}` / `{leafIndex,'unshield'}` per leaf (`:193-196`, `:209-211`). This is why subscribe deliberately reuses the *unshield* separator instead of minting its own (subscribeEphemeral.ts:17-26).

A stale proof buffer from a crashed run holds up to ~0.55 SOL that **only that ephemeral** can reclaim; it is either closed by the next run's stale-close (stark.ts:683-698) or by Recover.

### The dangerous shapes

- **Server paid, client did not hear it** — `route.ts:360-384`: `getGenesisHash` (:336) and `confirmTransaction` (:375) are not wrapped, so an RPC fault becomes a Next 500 → client sees `The funder replied with a non-JSON 500.` → `fundedBy` stays `'wallet'`. With `neverExposeWallet` off, the wallet then funds the *same* key and `sweepTo = owner` — **treasury lamports get swept to the user's wallet.** Client Guard 1 already ran at :355 and is never re-checked. On the subscribe screen the flag is on, so this is a shield-leg hazard, not a subscribe one.
- **200 with a missing `sweepTo`** — `ephemeralFunder.ts:124-126`: the grant may have landed while the client discards it.
- **Pre-flight fail-open** — `denominatedPool.ts:1748-1753`: a missing or unparseable pool account lets the run pre-fund and upload ~1 SOL of buffer rent against a root the program rejects. Recoverable via the `finally`s, but a wasted ~90 s and two proofs.

### Disagreeing cost figures in the code (all three verified, none authoritative)

`~2 SOL` (denominatedPool.ts:1740) · `~1 SOL of proof-buffer rent` (subscribeEphemeral.ts:22) · `~1.03 SOL` (subscribeEphemeral.ts:153). Measured on the fixture: **1,026,321,600 lamports of buffer rent**, total pre-fund 1,035,725,040.

---

## 4. What a chain observer sees

One subscription, from the fixture (`verify/fixtures/v3-subscribe/rpc.json`, spend `4v6RLndU…`, ephemeral `L1FNpmAwMypucVNhkyG3vyZBSYpPhJWZ6juaUGJEyHv`, 172 txs on that key, 220 slots ≈ 88 s):

```
+0    inbound SystemProgram.transfer  → fresh key, 1,035,725,040 lamports
+4    init_proof_buffer(size=68881, circuit=1)
+10..+39   6 × resize_proof_buffer
+46..+78   69 × write_proof_chunk
+87   verify_stark_proof_v2      +92  verify_deep_ali_phase2
+98   init_proof_buffer(size=78157, circuit=3)
+105..+140 7 × resize      +145..+180  79 × write_proof_chunk
+190  verify_stark_proof_v2      +196 verify_deep_ali_phase2
+203  subscribe_private_stark    (discriminator bba5f2d3d1131aa2)
+208, +214  2 × close_proof_buffer
+220  outbound transfer 1,030,290,360 → sweepTo
```

What that leaks:

- **Shape.** ~1 SOL into a brand-new key that emits ~171 transactions in ninety seconds and drains itself. Unmistakable regardless of amounts (`prefundAmount.ts:15-23` says so).
- **Amount, historically.** `1,035,725,040` was byte-identical on 4 of 4 subscriptions, and the shield leg's `1,573,486,080` differed enough to disclose *which operation was coming* (prefundAmount.ts:8-13). `jitterPrefund` now rounds up to 0.01 SOL and adds 0-4 steps, so today's subscribe sends **1.04-1.08 SOL**. 🚨 **The fixture's exact figure is the raw pre-jitter floor and today's code cannot produce it** (480,880,320 + 545,441,280 + 2,000,000 + 4,000,000 + 3,403,440). Any map describing it as "raw + 22,320 of jitter" is arithmetic no code performs. Jitter kills exact-match enumeration only.
- **Who funded the ephemeral.** The first inbound transfer is the linkage. Funder-paid → the treasury; fallback → `accountKeys[0]` is the buyer's wallet, bracketing the whole operation in public. This is what probe P6 measures.
- **The commitment, in cleartext.** `subscribe_private_stark` republishes the note's commitment, which is the exact key `commitments.get(...)` uses at `poolHandlers.ts:2261` — so anyone can run the same one-hop lookup to the deposit's fee payer, and then `resolveFunderOfPayer`'s walk to whoever funded *that*. That is the whole reason for the refusal at `shieldClient.ts:389-394`.
- **Published in the vault tx:** nullifier, Merkle root, `subscriberCommitment`, `licenseCommitment` (blake3), `rate`, `intervalSlots`, retailer, and a `vaultPDA` derived from `(retailer, subscriberCommitment, tokenMint)`. The license *secret* never leaves the worker (`poolHandlers.ts:2362`).
- **What the RPC provider additionally sees:** one `getAccountInfo` on the note's nullifier PDA before it exists on chain (`denominatedPool.ts:760-771`, flagged `⚠️ LEAKS THE NULLIFIER PDA TO THE RPC` at :751-758) — accepted because the nullifier is about to be published anyway. The spent-set read is deliberately pool-wide and identical for every user (`:674-688`).

---

## Known gaps and contradictions (do not paper over these)

1. **The execute segment map is truncated** after C1 `init_proof_buffer`. Steps 50-56 above come from my own read of `subscribePrivateStark.ts:219-308`, `stark.ts:455-560/672-742` and `subscribeEphemeral.ts:203-291`.
2. **`stark.ts:636-654` is the wrong citation** for the subscribe path's stale-buffer close — that range is `getProofBufferStatus`/`submitGenericStarkProof`. The subscribe path is `submitAndVerifyStarkProof`, `stark.ts:672-742`.
3. **The 95%-jump claim for C1 verify is false.** Verify strings match `prove` (31%), not `open`; the floor discards them. The real defect is a 90% freeze across all of C3.
4. **Vault rent**: 3,403,440 (361 bytes), not 3,381,120. `SUBSCRIPTION_VAULT_LEN` is a hand-mirrored copy of `state/subscription_vault.rs:135-153`; a new field in the struct without a bump here under-prices the pre-fund and fails after ~150 chunk uploads.
5. **`unshieldFromPath.ts:151-157` promises a fallback nobody performs.**
6. **`SelfDepositedNoteError`'s Branch B and the result banner both name an ephemeral as "your own wallet"** when `depositFunder` is null. The guard has four arms; the message has two.
7. **`WITHDRAW_PHASES` (flowProgress.ts:70) is missing `still looking` and `checking notes you already hold`** — the same bug SUBSCRIBE_PHASES fixed. The label test only asserts *some* table matches.
8. **`poolHandlers.ts:1626-1639` is dead code** — byte-identical to :1584-1595, reachable only when that returned null, deterministic. It repeats the full ML-KEM sweep.
9. **`SubscribePanel.tsx:637-640`'s no-double-submit invariant is timing-dependent, not structural.** One `await` inserted into :643-681 re-opens it.
10. **The wiring guard's "No funds moved." (`:672-678`) is false** once the claim code has been redeemed at `route.ts:274`.
11. The map's `recoverFloat.ts:83-87` citation (in `subscribeEphemeral.ts:17-26`) is stale — the behaviour is at `:193-196` and `:209-211`.