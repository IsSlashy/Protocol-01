# /pay Private Payments — Handoff

> **UPDATE 2026-07-25 (Opus 5 session).** Step 1 is no longer "in progress" — the
> denominated pool is wired into /pay and **proven end-to-end on devnet**: shield,
> storage-free note recovery, and unshield all land on-chain. Read §10 at the
> bottom FIRST; it supersedes §4 and parts of §5/§9.
>
> **Correction to §3's premise:** routing through the pool does NOT deliver
> funding↔claim unlinkability. The V3 unshield publishes the note commitment in
> cleartext, so deposits and withdrawals are publicly matchable — see §10.


Session date: 2026-07-24. Author: Fable 5. Everything below is committed to `origin/master`
(IsSlashy/Protocol-01, **public repo**) unless explicitly marked otherwise. Read this whole file
before touching /pay.

---

## 0. THE ONE RULE THAT OVERRIDES EVERYTHING — claims vs reality

This is a **privacy product where users move funds based on privacy promises.** Never let the site,
docs, or copy claim more privacy than is actually shipped and proven on-chain. The founder's own
2026-07-23 audit found 46 false claims; do not add a 47th. Specifically:

- **Do NOT market "full privacy" or "quantum encryption, delivered."** It is false today (see §2).
- The **only** honestly-claimable privacy today: *"post-quantum recipient discovery (ML-KEM-768),
  proven end-to-end."* That is real and already more than competitors ship.
- Claims grow **in lockstep** with shipped + on-chain-verified features, never ahead. When a layer
  lands and verifies on devnet, then and only then does the page earn the corresponding claim.
- The founder explicitly asked to "promise full privacy already delivered." I refused and explained
  why; they accepted the build-first approach. Hold that line.

---

## 1. WHAT /pay IS AND WHERE IT LIVES

Live at **https://protocol-01.dev/pay** (Vercel, auto-deploys on push to master). Landing hero
"Initialize Protocol" → `/pay`; the waitlist button is kept alongside.

It is an Umbra-style private send/receive UI ("Shield & send" / "Unshield") over a chain-pluggable
core. Three ways to connect, chain-aware:
- **Solana** (SOL, USDC): `@solana/wallet-adapter` (Phantom etc.) OR the **P01 mobile wallet** via
  the existing `p01conn1` QR pairing (relay sees only ciphertext).
- **Starknet** (ETH, STRK): ArgentX / Braavos via `get-starknet-core`, SNIP-12 signature derives the
  **same chain-agnostic meta-address**.

### Key files
- `packages/specter-sdk/src/core.ts` — browser-safe SDK entrypoint (stealth/quantum/registry/
  transfer/utils/wallet, NO prover). apps/web imports **only** `@protocol-01/specter-sdk/core`
  (→ `dist/core.*`). **Never** import the specter-sdk root from web (pulls the Node-only STARK
  prover and breaks the browser build).
- `packages/pay-core/` — framework-agnostic private-payment core (shared web + extension later):
  - `src/chains/solana.ts` — secret-free adapter; injects a worker client + signer runtime.
  - `src/worker/workerCore.ts` — **the secret holder**: deriveMeta (HKDF from wallet sig), buildSend
    (SOL + USDC, funds tx LAST), scan (+ USDC ATA detection), claim (wallet-bound), clearSessions.
  - `src/worker/messages.ts` — typed worker RPC protocol.
  - `src/chains/starknet.ts` + `src/chains/starknetStealth.ts` — Starknet adapter: hybrid stealth
    ground onto the stark curve → counterfactual OZ account; send = ERC-20 transfer + pq_announcer
    announce multicall; claim = deploy_account + sweep. `clearStarknetSessions()`,
    `isStarknetConfigured()`, `setStarknetSignerRuntime()`.
  - `src/transport/starknetTransport.ts` — felt-packed announcement chunks against pq_announcer.
- `apps/web/lib/privacy/`:
  - `worker/stealth.worker.ts` (+ `bufferPolyfill.ts` FIRST import) — the Solana secret worker.
  - `workerClient.ts` — main-thread postMessage bridge (crash recovery, request timeouts).
  - `chains/` — thin re-export barrels of pay-core.
  - `pair/` — `pairCrypto.ts`, `connectPair.ts` (byte-identical to extension/mobile), `deriveWallet.ts`.
  - `pool/` — **NEW, Step-1 extraction (see §4)**: the denominated shielded pool.
- `apps/web/components/pay/` — PayApp (tri-wallet, chain-aware gates), SendForm, ReceivePanel,
  ChainCoinSelector, HonestyBadge (chain-aware), FeeRow, P01ConnectModal, Stepper, TokenLogo, util.
- `apps/web/app/(pay)/pay/page.tsx` — the page (devnet banner, hero).
- `contracts/starknet/` — Cairo `PqAnnouncer` (chunked ML-KEM announcement events); snforge 2/2.

### Deploy build chain (do not break)
`apps/web` `build` = `pnpm --filter @protocol-01/rpc-config build && pnpm --filter
@protocol-01/specter-sdk build:core && next build`. It MUST use `build:core` (builds only
`src/core.ts`), NOT the full specter-sdk `build` (the full build's `--dts` compiles the `proving`
entry which imports `@protocol-01/stark-prover`, absent on a fresh Vercel clone → deploy ERROR).
`next.config.mjs` has `serverExternalPackages: ['get-starknet-core']`, and get-starknet-core is
lazy-imported in `connectStarknetWallet` (its pre-minified dist collides in the client bundle).

---

## 2. HONEST STATE — the six privacy properties

/pay hides **the recipient only**, and even that is bearer-like. Proven by a grounded 5-agent
investigation of the actual code + on-chain probes.

| Property | State | Notes |
|---|---|---|
| Recipient anonymity | HAVE* | one-time stealth address, PQ discovery proven e2e. *view/spend coupled — sender can race-reclaim until dual-key redesign; bearer-like, not sound. |
| Funding↔claim unlinkable | MISSING everywhere | **Corrected 2026-07-25.** The `zk_shielded` pool (`GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`) does NOT deliver it: the v3 unshield passes the note commitment as a public instruction argument (bytes 80..88) and the deposit emitted the same value, so the two are publicly matchable — effective anonymity set ONE. Needs the C7 spend circuit (`docs/C7_SPEND_CIRCUIT_PLAN.md`). |
| Amount confidential | PARTIAL | The /pay **Pool tab** shields/withdraws denominated notes on devnet, so amounts there are quantised to a bucket. A /pay **send** does not route through the pool — those amounts are fully public. |
| Sender anonymity | PARTIAL | `p01_relayer` (`2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW`, ~9 nodes) live but pay-core doesn't call it (Step 2). |
| Timing / metadata | PARTIAL | event-scrub deployed; cover traffic parked. |
| Token-type hiding | MISSING | commitments bake in the mint; universal pool = parked V4. |

"Quantum" today = ML-KEM-768 on **recipient discovery** only. The **signer is Ed25519 → Shor-breakable**;
`p01_quantum_wallet` (PQ custody) is unbuilt. So "quantum-safe custody" is FALSE.

---

## 3. THE ROADMAP TO FULLY-UNREADABLE TXS (founder wants all of it)

Founder chose **denomination buckets (option A)** = real amount privacy, amounts snap to
denominations / split across pools (cannot send arbitrary amounts privately). Ordered by
privacy-gained-per-effort:

**Solana (where the real primitives live):**
1. **Route /pay through the denominated shielded pool** — flips **amount only**. It does NOT flip
   funding↔claim-unlink: see §10, the v3 unshield publishes the note commitment. Pool deployed +
   audited (C1/C2/C3/C6) + device-proven. **← STEP 1, DONE for the Pool tab (§10); sends still
   bypass the pool. Unlinkability is a separate build — `docs/C7_SPEND_CIRCUIT_PLAN.md`.**
2. **Relayer for sender anonymity** — needs Step 1 first (ephemeral funded from shielded funds) +
   a reliable in-repo worker (currently gitignored/degraded).
3. **extDataHash recipient-in-proof** (~2-4h) — removes recipient from tx accounts.
4. **Dual-key stealth redesign `a + H(s)`** (`docs/stealth-viewonly-redesign.md`) — makes recipient
   privacy SOUND, kills the bearer-reclaim. Prioritize: fixes a currently-false safety property.
5. L2 recipient-bound commitment for denominated transfer.
6. Cover traffic + uniform proof upload (timing).
7. `p01_quantum_wallet` PQ signer custody (~2-3 months) — the real "quantum custody."

**Starknet:**
- A) pq_announcer Sepolia deploy = **DONE** (address in §6).
- B) STRK20 native pool = **GATED-EXTERNAL** (StarkWare Privacy SDK v0.10.3 access; every value
  method throws until granted). Founder is emailing StarkWare. Not on the critical path.

Full detail + evidence: memory `pay-full-opacity-roadmap-2026-07-24.md`.

---

## 4. STEP 1 STATUS — denominated pool into /pay (amount privacy)

### DONE this session (committed)
- **Gate PASSED**: the STARK prover instantiates + generates real proofs inside a Next 16 turbopack
  Web Worker (WASM instantiate 37ms; C1 pool-commitment 120KB/207ms; C6 merkle-update 140KB/1.6s).
  This was the hardest risk; it's cleared. The pool is **STARK-only** (no Groth16, no 13MB assets);
  the STARK WASM is a **252KB base64 blob** loaded via `WebAssembly.instantiate` (fully portable).
- **Extraction DONE**: the proven extension pool code copied **verbatim** into
  `apps/web/lib/privacy/pool/` (8 files: `denominatedPool.ts` 2209 LOC, `noteCrypto.ts` ML-KEM PQ
  note, `goldilocks-poseidon.ts`, `stark.ts`, `starkProver.ts` + `starkProver.worker.ts` +
  `starkWasmData.ts`, `relayEphemeralRecovery.ts`). Only edits: import paths, `chrome.storage`→web
  store shim, `signSendV3` submits directly (relayer = Step 2; transport-only change, no math
  touched). apps/web typecheck CLEAN. **We extract, never re-port** — the source warns a single-bit
  change = on-chain InvalidProof.
- **Byte-faithfulness PROVEN**: ported the extension's 33 pool tests → **33/33 pass** against the web
  copy, including the hard gate (createCommitmentV3 low-u64 == WASM circuit output). Wired as CI gate
  `pnpm test:pool` (`apps/web/vitest.pool.config.mts`, node env, real web3 — separate from the main
  jsdom suite that mocks web3). Main suite still 52/52.

### REMAINING (the actual wiring — fund code, stage carefully, verify on devnet before real value)
1. **Worker/adapter shield path**: `prepareShieldInsert(poolConfig, walletSeed, counter, connection)`
   [reads tree, derives note, computes commitment/root, generates C6 proof in worker ~30-60s]
   → `shieldV3(poolConfig, c6Proof, insertParams, signer, connection)` [submits C6 upload +
   `shield_denominated_v3`]. Pool configs from `getPoolsForTokenV3('SOL'|'USDC')`. `prepareShieldInsert`
   flags a **root-reconstruction fragility** (tries both `direct` and `sliced` filled-subtree layouts
   and refuses to burn proof rent unless one reproduces the on-chain root) — expect care there.
2. **Receive/unshield**: `fetchPoolCommitments` scan + `unshieldDenominatedStarkV3` to the stealth/
   wallet destination.
3. **Denomination UX** in SendForm: amounts snap to supported pool denominations or split across the
   13 live V4 pools. Cannot send arbitrary amounts.
4. **PQ note**: the value note must be ML-KEM PQ-encrypted to the recipient — use `noteCrypto.ts`
   (already extracted). Do NOT ship a plaintext note.
5. **Browser e2e** (playwright, funded key in §6) proving a real shield lands + commitment on-chain
   against `GbVM5y…` before wiring real value. Node e2e cannot fully catch worker-only bugs (see §5).
6. **AVOID arbitrary-amount paths** for real value: `zkspl` confidential balance is undeployed;
   base-pool circuit-5 hardcodes `public_amount=0` (counterfeit-mint risk) until conservation
   range-checks land.

---

## 5. KNOWN BUGS / GOTCHAS (all hit this session)

- **Browser Buffer polyfill lacks 64-bit accessors** (`write/readBig[U]Int64LE/BE`). Node's Buffer
  HAS them, so **Node e2e never catches these** — they only throw in the browser worker. Bit /pay
  three times (scan `readBig`, registry `readBig`, send `writeBig`). Fixed at source (DataView) AND
  patched onto `Buffer.prototype` in `apps/web/lib/privacy/worker/bufferPolyfill.ts`. **Rule: any new
  /pay worker code must use DataView for u64/i64, never trust Node Buffer big-int methods.** Memory:
  `buffer-polyfill-gap-web-worker-2026-07-24.md`.
- **register_v2 is unusable on-chain**: the 1184-byte ML-KEM key exceeds Solana's 1232-byte packet
  limit; the instruction can never fit in one tx. On-chain "publish your address" needs a chunked
  registry (v3). `/pay` shows meta/QR sharing instead; the `registerSelf` adapter throws honestly.
- **Starknet secrets are on the MAIN thread** (`sessionSecrets`/`claimCache` in `chains/starknet.ts`),
  unlike Solana's worker isolation. `clearStarknetSessions()` exists + is called on reset. Longer-term,
  move Starknet secret handling into a worker.
- **Starknet is bearer-like + amounts public** on the current ERC-20 plan-B path (STRK20 pool gated).
  The chain-aware HonestyBadge states this. Keep it.
- **get-starknet-core@3.3.5** is deprecated with a `starknet ^5` peer dep vs the installed v10; the
  ArgentX/Braavos path has only been exercised with a raw v10 Account in e2e, never a real wallet.
- Solana/Starknet e2e use public devnet/Sepolia RPC which rate-limits (429) — tests have small
  backoff; re-run once on a flaky 429.

---

## 6. KEY CONSTANTS / ADDRESSES / ENV

- **Solana devnet programs**: specter stealth `FgKhXakZGsd4PdiGgACYy8gwj1JLMYA691yQr2PhUNfL`;
  zk_shielded pool `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`; registry
  `QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB`; relayer
  `2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW`. Devnet USDC mint
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
- **Funded devnet keypair** (for e2e): `C:\Users\Slashy\.config\solana\id.json` (pubkey
  `7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU`, ~12 SOL). Solana e2e gate `SOLANA_E2E=1`.
- **Starknet Sepolia**: PqAnnouncer deployed at
  `0x061f2e6ae9951c106836b11b50712419d8b17007bfd63327144a8bb6abaa9d48`
  (class hash `0x1949aba655414cf323eb7ec94b847abbf2f98efbf058685634f8a01ffa75d61`, OZ account class
  `0x5b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564`). Test account
  `0x28f49dc0514d3a3e9704e31cb79e69330d583f93ddbd38cd873b78fcad80603` (funded 100 STRK via
  faucet.starknet.io). Local devnet: `starknet-devnet --seed 42 --port 5050` (WSL), sncast account
  `devnet0`, local announcer `0x04caeeea34729eae3f6ad58cafd21fad5f65d6e33d1375a62a187a95c00f3534`.
  Starknet e2e gate `PQ_E2E=1` (+ env overrides for Sepolia; `SKIP_ETH_LEG=1`).
- **Vercel prod env** (set): `NEXT_PUBLIC_STARKNET_RPC_URL`, `NEXT_PUBLIC_PQ_ANNOUNCER_ADDRESS`,
  `NEXT_PUBLIC_STARKNET_ACCOUNT_CLASS_HASH`. Project `prj_uU5cevNNssusy1VS8ViviUau1zMm`, team
  `team_JoO6zF63SjIyrWKcYxF7hKqh`.
- **Toolchain**: scarb 2.20.0 + snforge 0.62.1 + starknet-devnet 0.9.1 live in **WSL**
  (`/home/slashy/.local/bin`), NOT on Windows PATH. pnpm 9.15.9; do full `pnpm install` at repo root
  (`--filter` installs prune sibling node_modules and break React). starknet.js pinned `^10.0.2`.

---

## 7. WHAT'S PROVEN vs UNPROVEN

- **PROVEN on-chain**: Solana SOL + USDC full loop (`solana.e2e.test.ts` 2/2, real devnet txs,
  derive→send→scan→claim); Starknet STRK full loop on Sepolia AND local devnet
  (`starknet.e2e.test.ts`); Starknet ETH loop on local devnet. Cairo snforge 2/2. Pool math parity
  33/33. STARK prover in Next worker (gate). Prod deploy green, /pay live, 0 console errors.
- **HUMAN-PENDING** (needs a real wallet/phone; automation structurally can't do these): the Phantom
  browser send/claim (founder is testing — a send-path Buffer bug was just fixed from their report,
  awaiting retry), P01 phone pairing on https, real ArgentX/Braavos connect.

---

## 8. COMMITS THIS SESSION (origin/master, after 6e22ebd6)

```
9e24a7cb fix(pay): patch the 64-bit Buffer accessors onto the worker polyfill
9c58e8f6 fix(pay): DataView for the send-amount u64, not Buffer.writeBigUInt64LE
a76d2546 test(pay): parity gate proving the pool extraction is byte-faithful
ac49a0b6 feat(pay): extract the denominated shielded pool into /pay (Step 1 foundation)
64c36afb refactor(pay): tighten the Solana honesty badge to one line
3aa2eb9f fix(pay): lazy-load get-starknet-core to stop a production client crash
3da5f77b fix(web): production build — build only specter-sdk /core, not the full package
a4374e0a fix(pay): browser scan crash, transparent selector, dead directory chip
f916bdcb test(pay-core): Starknet e2e runs against Sepolia via env overrides
e5806d71 docs: manifesto, economic charter refresh, STRK20 X sequence
feb3ee60 feat(web): campaign source tracking on the waitlist form
4c8163e9 feat(web): /pay private payments - multichain PQ stealth with tri-wallet connect
86656869 feat(contracts): Starknet PqAnnouncer for post-quantum recipient discovery
31157108 feat(pay-core): chain-pluggable post-quantum stealth payment core
8714172e feat(specter-sdk): browser-safe /core entrypoint for web + worker bundles
```

---

## 9. IMMEDIATE NEXT ACTIONS (for Opus 5)

1. **Wait on the founder's Phantom retry** of the Solana send (a `writeBigUInt64LE` fix just shipped).
   If a new error comes back, it's the next worker-only bug — fix with DataView, not Buffer.
2. **Step 1 wiring** (the real work): build a pool client in the web worker/adapter that runs
   `prepareShieldInsert → shieldV3` for a SOL denomination, add denomination-snapping to SendForm,
   then a browser e2e proving a shield lands on `GbVM5y…`. Then receive/unshield. PQ-encrypt the note.
   Verify each proof against on-chain verification on devnet before touching real value.
3. Only after Step 1 verifies on-chain: update the honesty copy to "amount + funding-graph hidden."
   Not before.
4. Then Step 2 (relayer / sender anonymity), Step 4 (dual-key stealth — prioritize, fixes false
   safety claim), etc. per §3.

Relevant memory files: `pay-full-opacity-roadmap-2026-07-24`, `session-2026-07-24-pay-page-build`,
`buffer-polyfill-gap-web-worker-2026-07-24`, `audit-claims-vs-reality-2026-07-23`,
`stealth-view-spend-coupling`, `starknet-buildathon-paris-2026-07-22`.

---

## 10. STEP 1 IS DONE — pool wired into /pay, proven on devnet (2026-07-25)

### What shipped
A **Pool tab** in /pay (Solana only): shielded balance, denomination selector,
shield, and per-note withdraw. New files:

- `apps/web/lib/privacy/pool/shieldEphemeral.ts` — prepare (prove) / execute (spend).
- `apps/web/lib/privacy/pool/unshieldEphemeral.ts` — same shape for withdrawal.
- `apps/web/lib/privacy/pool/poolNotes.ts` — note discovery + recovery.
- `apps/web/lib/privacy/worker/poolHandlers.ts` — pool RPC inside the stealth worker.
- `apps/web/lib/privacy/worker/pacedFetch.ts`, `pollingConfirm.ts` — transport fixes.
- `apps/web/lib/privacy/shieldClient.ts` — main-thread driver.
- `apps/web/components/pay/PoolPanel.tsx` — the UI.

### The design constraint that shaped everything
`shield_denominated_v3.rs:80` requires `proof_buffer.authority == depositor`, and
a C6 proof is ~140KB uploaded in 1000-byte chunks → **~150 signatures**. Free for
the extension (local keypair), unusable with Phantom. So both shield and unshield
use the **ephemeral-depositor** pattern `transferDenominatedStarkV3` already
shipped: the wallet signs ONE pre-fund, a deterministic ephemeral signs the rest,
residual swept back. Hence the two-phase worker API (prepare → wallet funds →
execute).

**The shield and unshield ephemerals are domain-separated on purpose.** If one key
did both, deposit and withdrawal would share a signer and the pool would hide
nothing.

### PROVEN ON DEVNET (real transactions, this session)
- **Shield** `34kkaMxk…` → `ShieldDenominatedV3`, log "V3 commitment added at index: 27", tree 27→28.
- **Recovery** — a scan found that note from the wallet signature alone, with **no local
  state** (the run that created it crashed before returning anything).
- **Unshield** `5Gt7ey5F…` → `UnshieldDenominatedStarkV3`.
- **Clean round trip** after the fixes: shield `nB9gVPXs…` (leaf 28, **75 seconds**) →
  withdraw `2FhzBLHc…` (~3 min). Deltas: 0.1 SOL out of the vault, 0.0995 to the
  wallet, 0.0005 protocol fee. Ephemerals swept to 0 every time.
- Pool parity 33/33, main suite 52/52, production build green.

### Four bugs this found — two were fund-loss
1. **Stark worker specifier.** The extraction kept `../workers/starkProver.worker.ts`;
   in apps/web the prover is a sibling. Runtime-only failure — typecheck and the
   33/33 parity tests both pass with it broken.
2. **Buffer polyfill, 4th instance of the class.** `parseFilledSubtrees` calls
   `treeData.readBigUInt64LE`. The polyfill patched only the prototype of the
   `buffer` package copy it imports; a bare `Buffer` inside a bundled module
   resolves to a **different copy reachable by no name**. Now patched on
   `Uint8Array.prototype`, which every Buffer copy inherits from. **Rule stands and
   is now enforced one level up.**
3. **Counter allocation was a fund-loss bug.** Picking the next counter by scanning
   past notes fails because insert events live in transaction history and public
   devnet RPC prunes it — the 0.1 SOL pool's tree reports 27 leaves while the RPC
   serves **1 signature**. The scan misses notes, reuses a counter, and since the
   nullifier is `poseidon(np, secret)` with no epoch input, spending one strands
   the other. **The counter is now the tree's leaf index** (authoritative, never
   pruned, unique by construction) with a re-read guard if the pool advances
   mid-prepare.
4. **Confirmation was broken in the Worker.** web3.js `confirmTransaction`
   subscribes over a WebSocket whose client throws `window is not defined` there,
   so every confirmation waited out the blockhash — a uniform ~58s, ~14 per shield
   (~13 min wasted), **and it reported a LANDED shield as "block height exceeded."**
   Replaced with status polling on the Connection instance, leaving the extracted
   proof code untouched.

### RPC is now a hard requirement, not a nicety
Public devnet RPC cannot do this at all: it 429s the chunk uploads and serves too
little history to rebuild a Merkle proof. Helius devnet works (46 signatures back
to 2026-05 for the 0.1 pool). Key is in `apps/web/.env.local` as
`NEXT_PUBLIC_HELIUS_API_KEY` (gitignored). **Note it is `NEXT_PUBLIC_`, so it ships
to the browser** — fine for devnet, do not reuse for a paid mainnet quota.

### Honest state after Step 1 — claims did NOT change
The site's privacy copy is **unchanged**, deliberately. What is true now:
- The **Pool tab** can shield and withdraw a denominated note on devnet, so **amount
  quantisation** exists there. That is the only privacy property it adds.
- **The pool does NOT make a withdrawal unlinkable to its deposit.** The V3 unshield
  instruction takes the note commitment as a public argument (instruction bytes
  80..88) and the deposit emitted that same value in `LeafInserted`, so a public
  scan matches them. Verified on devnet: unshield `2FhzBLHc…` carries
  1126946528953530644, the commitment the shield logged for leaf 28. **The
  effective anonymity set is ONE.** Fixing it needs a program change — the C3
  proof already proves membership, so publishing the leaf defeats the point.
- **The send flow still does not route through the pool.** A /pay send is the same
  stealth-address path as before, amounts public.
- The anonymity set is tiny and stated in the UI from tree leaf count (28 in the
  0.1 SOL pool). A pool that small hides very little.
- The user's wallet funds the ephemeral and receives the withdrawal, so an
  observer watching that wallet still correlates both sides. **Breaking that needs
  the relayer (Step 2).**
So: do NOT upgrade the marketing copy to "amount + funding-graph hidden" yet. The
honest upgrade is available only once sends route through the pool AND the
funding link is broken.

### Known gaps / next
- ~1 SOL of proof-buffer rent is needed transiently per shield. Fine on devnet,
  a real UX problem for mainnet.
- USDC pools are wired in config but `prepareShield` refuses non-SOL: the SPL leg
  would need funding onto the ephemeral's ATA.
- Notes are found by enumerating candidate deposit epochs (6000-epoch window). If
  history is unavailable the local encrypted blob is the fallback; both paths exist.
- Next: Step 2 (relayer), then dual-key stealth (§3 item 4) which fixes a
  currently-false safety property.

---

## 11. WHERE THIS STANDS AT END OF SESSION (2026-07-25)

Nine commits on `master`, **not pushed** (push auto-deploys, and Vercel has no
`NEXT_PUBLIC_HELIUS_API_KEY` — the Pool tab would ship broken on public RPC).

Shipped and proven on devnet this session:
1. Pool shield + withdraw wired into /pay (Pool tab), full round trip on-chain.
2. Storage-free note recovery from the wallet signature alone.
3. `recoverFloat.ts` — recovered 1.81 + 5.58 SOL of really-stranded rent.
4. Withdrawal from a stored Merkle path — no transaction-history dependency.
5. **Commitment blinding** (`fc6591ee`) — half the unlinkability fix.

Read next, in this order:
- `docs/C7_SPEND_CIRCUIT_PLAN.md` — the other half. **Start at Step 0** (the CU
  probe); it is cheap and it gates the whole design.
- §10 above — the four build bugs and the linkability evidence.

Do NOT claim the pool is unlinkable. A withdrawal still passes the note
commitment as a public instruction argument; blinding only closed the
nullifier-enumeration path. Both are required.

Operational notes: Helius devnet is mandatory (public RPC 429s the ~150-tx proof
upload); the key lives in `apps/web/.env.local`, is gitignored, and is
`NEXT_PUBLIC_`, so it reaches the browser — do not reuse it for a paid mainnet
quota. The local test harness under `app/(pay)/pay/devshield/` is deleted at the
end of every run on purpose: it takes a pasted private key and must never ship.
