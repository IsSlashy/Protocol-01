# Session handoff — 2026-04-29 (Superteam IE last day)

This doc captures everything done during the long Colosseum-submission +
on-device debugging session. Pull this on the fixed PC to resume exactly
where the laptop was left off.

## TL;DR

Submitted Protocol 01 to **Colosseum Frontier — Superteam IE / Quantum
Ireland track** on 2026-04-29 at master `aa2d642`. Then spent the rest
of the session instrumenting the mobile app, building it locally as a
signed release APK, installing on two phones (Nothing Phone + Galaxy Note 9),
running the recovery + spend + BLE share flows live, and fixing bugs
captured by the structured logs.

Last commit pushed to `origin/master` from the laptop : `2d1338e` (instrumentation).
After that commit we wrote 7 more files of bug fixes locally that **were
not yet committed at session end** — those have to be committed and
pushed before the fixed PC pulls. See section **What to do first** below.

## What to do first on the fixed PC

```bash
cd Protocol-01
git pull --rebase origin master
pnpm install
```

The laptop's working directory was committed as `feat(mobile): apply
on-device debugging session fixes (build config + UI + ring check + BLE
ghost-error)` after this handoff doc was written. The corresponding
commit hash is the one immediately following this file's introduction
into the repo. After pulling, the fixed PC has the full state.

You also need to recreate two local files that are gitignored :

1. `apps/mobile/.env.local` :

   ```
   # Privy Auth
   EXPO_PUBLIC_PRIVY_APP_ID=cmkunrdg605ouie0blb3kq1fm
   EXPO_PUBLIC_PRIVY_CLIENT_ID=client-WY6VAkfDmcFDEpJKtgxwSkJ7CBe8pFbTJhCi4hXBPFN1X

   # Solana network
   EXPO_PUBLIC_SOLANA_NETWORK=devnet

   # Helius RPC — mandatory for spend flow to find leaves reliably
   EXPO_PUBLIC_HELIUS_API_KEY=ad0d91ac-dda3-4906-81ef-37338de04caa
   ```

2. The release keystore file at `apps/mobile/android/app/release.keystore`
   if you don't already have it (PKCS12, alias `protocol01`, password
   `Protocol01Frost2026`). Without it, you can build debug only, not
   signed release.

To build the release APK exactly the way it was built on the laptop :

```bash
cd apps/mobile/android
P01_RELEASE_STORE_PASSWORD='Protocol01Frost2026' \
P01_RELEASE_KEY_PASSWORD='Protocol01Frost2026' \
./gradlew assembleRelease
```

Output lands at `apps/mobile/android/app/build2/outputs/apk/release/app-release.apk` (~96 MB).

To install on a connected phone :

```bash
adb install -r apps/mobile/android/app/build2/outputs/apk/release/app-release.apk
```

## What was submitted to Colosseum

Filed on 2026-04-29 to Superteam Earn / Frontier IE, repo state
`aa2d642`. Winners announcement scheduled 2026-05-27. Items left open
in the submission package :

- **Pitch HUD video URL** : the user has it rendered on another machine
  but the URL was never pasted into `docs/colosseum-frontier-submission.md`
  or `docs/HACKATHON.md`. Search those files for `[link]` placeholders
  and replace once the URL is available.
- **Superteam IE Discord disclosure of prior work** : the project
  preexists the hackathon window. Confirm admissibility with Superteam
  IE Discord moderators.

## Commit timeline of the day

```
2d1338e debug(payments): instrument all payment modes with [P01_PAY] tagged logs
76e0fe8 debug(sharing): instrument BLE flow with structured ghost-error detection
1bcf0eb debug(denominatedPool): instrument unshield path with structured diagnostics
aa2d642 build(scripts): add publish-wave.sh for the Round 3 npm release   ← submission filed at this commit
7b3bf69 build(scripts): track render-docs-pdf.mjs for marketing PDF regeneration
822009e docs(pdf): regenerate marketing PDFs from updated HTML + add render script
fa9052d docs(html): correct SDK count from 17 to 14 in pitch deck and design doc
077c546 docs(html): fix stale APK size and localnet IDs in marketing assets
69df66d chore(privacy-sdk): fix MIT badge link to point at root LICENSE
79cb4c5 feat(submission): align Colosseum Frontier IE submission + close STARK migration
```

## APK build saga — what got fixed in mobile config

The first four `gradlew assembleRelease` attempts failed in sequence,
each exposing a different blocker. The fixes are now persisted :

1. **Failure** : `Unable to resolve module @protocol-01/stark-prover from
   specter-sdk dist`. **Fix** : added `@protocol-01/stark-prover:
   workspace:*` to `apps/mobile/package.json` and ran `pnpm install`.
2. **Failure** : `import.meta is not supported in Hermes` from
   stark-prover dist. **Fix** : added `unstable_transformImportMeta:
   true` to the `babel-preset-expo` options in
   `apps/mobile/babel.config.js`.
3. **Failure** : `Unable to resolve fs/promises` from stark-prover
   dist (Node-only loader). **Fix** : added a `resolveRequest` shim in
   `apps/mobile/metro.config.js` that maps `fs/promises`, `node:fs`,
   `node:fs/promises`, `node:path` to the existing
   `polyfills/empty.js` stub.
4. **Failure** : `SigningConfig "release" missing storePassword`.
   **Fix** : pass `P01_RELEASE_STORE_PASSWORD` and
   `P01_RELEASE_KEY_PASSWORD` env vars to `gradlew` (credentials
   stored in the project memory keystore note).

After the fourth fix : `BUILD SUCCESSFUL`, signed APK at 96 MB,
installed on both phones successfully.

## Diagnostic instrumentation deployed

Three structured-log channels added so future bugs surface in `adb
logcat -s ReactNativeJS | grep -E 'P01_DIAG|P01_BLE|P01_PAY'` :

- **`[P01_DIAG]`** : `apps/mobile/services/denominatedPool/{errorCatalog,parsePool,diagnoseSpend}.ts`.
  Auto-triggers a full report on any `unshieldStark` simulation
  failure, decodes Anchor error codes, parses the on-chain Pool
  account for current root and historical ring, computes verdict
  among `{OK, NEEDS_MATURITY, STALE_ROOT, DIVERGENT_REBUILD,
  NULLIFIER_USED, POOL_INACTIVE, CORRUPT_RECEIPT, INCONCLUSIVE}`.
- **`[P01_BLE]` + `[P01_BLE_GHOST_ERROR]`** :
  `apps/mobile/services/sharing/diagnostics.ts`. Tags every BLE state
  transition, every transport callback, and surfaces the
  ghost-error pattern (error within 10 s of share-complete).
- **`[P01_PAY]` + `[P01_PAY_GHOST_ERROR]`** :
  `apps/mobile/services/payments/diagnostics.ts`. Wraps every
  payment mode in `subscriptionVault/index.ts` and `solana/streams.ts`
  (classic-recurring-p2p / classic-recurring-p2b / zk-recurring /
  zk-oneshot / vault-claim / vault-cancel / stream-create /
  stream-process).

## Bugs identified and fixed during live testing

These five fixes were written in the same files as the instrumentation
and committed alongside this handoff doc :

### 1. UI loader race during STARK op
`apps/mobile/stores/denominatedPoolStore.ts:refreshAllPools` toggled
`isLoading=false` on completion of its periodic refresh, even when an
unshieldStark was in flight. Result : the UI loader disappeared
mid-batch, looking like the operation had stopped while
`_starkOpInFlight` remained true and the proof submission continued
silently. **Fix** : guard the `isLoading` toggle with
`_starkOpInFlight` check ; emit a `[P01_UI]
refreshAllPools-during-stark` log when skipped. Confirmed live in
logs after rebuild.

### 2. BLE ghost-error during programmatic teardown
Observed live : 880 ms of `state="error"` flash after a successful
share, before the native write completed and the state transitioned
to success. Cause : when `sendEncryptedNote` calls
`cancelDeviceConnection` to free the GATT handle for the native
write, ble-plx synchronously fires `"Operation was cancelled"` on
every active monitor subscription, which the existing string filter
(searching only for `Disconnected`) didn't catch. **Fix** :
introduced `_expectingProgrammaticDisconnect` instance flag set to
true before the cancellation and false after the native write
completes. The monitor callback squelches all errors while the flag
is true. Backup string filter also extended to include `cancelled`.
File : `apps/mobile/services/sharing/transport/ble.ts`.

### 3. Recovery scan unreliable on api.devnet.solana.com
The default Solana devnet RPC drops signatures from
`getSignaturesForAddress` after a few seconds of activity, which
broke the recovery rescan and the merkle rebuild. **Fix** : added
`EXPO_PUBLIC_HELIUS_API_KEY` to `.env.local`. The existing
`apps/mobile/services/solana/connection.ts` already had Helius
fallback logic, so once the key is present the app uses
`devnet.helius-rpc.com`. **Note** : the `.env.local` is gitignored,
the key has to be re-added on the fixed PC.

### 4. ensureMerkleProof happy-path 2 + fail-loud abort
`apps/mobile/services/denominatedPool/index.ts:ensureMerkleProof`
was the choke point for spending recovered notes. Two changes :

- **Happy-path 2** : if the receipt has full path data and its
  stored merkle root is in the on-chain `historical_roots` ring,
  skip the rebuild entirely. The on-chain `is_valid_root` check
  accepts any root in the ring, so the receipt's path is
  cryptographically valid without re-scanning.

- **Fail-loud abort** : if the rebuild is required and produces a
  root that is **not** in the on-chain ring, throw before
  submitting the proof transaction. Saves ~0.85 SOL of proof-buffer
  rent on a guaranteed-failed tx.

The rebuild itself now also exports `MERKLE_DEPTH` and `ZERO_VALUE`
for the diagnostic helpers to reuse.

### 5. Pool config issue exposed by the diagnostic
The `[P01_DIAG]` reports revealed that **every devnet pool was
deployed with `max_historical_roots = 0`**. The on-chain
`update_root` skips the historical ring push when `max == 0`, so the
ring stays empty forever and only the exact current root is
accepted. This makes recovered-note spends practically unrecoverable
unless no other user shields during the 2-3 min proof generation
window.

This is **not** fixed in code yet. The fix requires either :

- a new `update_max_historical_roots(authority, new_max: u8)`
  instruction in `programs/zk_shielded`, callable on existing pools, or
- redeploying fresh pools with `max_historical_roots = 100` from init.

Tracked in the LaserStream indexer plan memory.

## Test results from the live phones session

- **Recovery from seed** : 7 notes recovered consistently across
  multiple wipes and re-recoveries (2 SOL 0.1 + 5 SOL 1). Recovery
  itself works.
- **Spend of fresh shield** : 1 SOL note shielded at 16:46:36,
  spent successfully at 16:50:04 (Simulation OK, 21 491 CU). Used
  happy-path 1 because receipt was just-shielded and root matched
  current. **This is the reliable spend pattern with the current
  on-chain config**.
- **Spend of recovered note** : every attempt failed with
  `InvalidMerkleRoot` (Anchor 6002) due to `max_historical_roots = 0`.
  Fix #5 (fail-loud abort) prevented further rent waste after one
  failed attempt.
- **BLE share** : ghost-error captured live with the exact 880 ms
  flash, fix written and committed in this handoff.

## Outstanding TODOs

Roughly in priority order :

1. **Pitch HUD video URL** — paste into the two submission docs.
2. **Superteam IE Discord prior-work disclosure** — confirm admissibility.
3. **npm publish wave Round 3** — `bash scripts/publish-wave.sh`,
   8 packages need OTP per package.
4. **expo-dev-menu / expo-dev-launcher in release** — they are
   compiled into the signed APK and shouldn't be there. Audit
   `app.config.js` and the autolinking config to exclude them in
   release variants.
5. **Pool `max_historical_roots = 0` fix** — on-chain change. Either
   add an authority-callable update instruction, or redeploy fresh
   pools.
6. **LaserStream indexer prototype** — separate work item, plan in
   memory `project_laserstream_indexer.md`. Solves the recovered-note
   spend bug definitively.
7. **Relayer wiring for 100 % unshield masking** — wire `p01_relayer`
   into the `unshieldStark` path so the user's wallet never appears
   on chain.

## Files that exist on the laptop but are not in git

These need to be recreated on the fixed PC. They are gitignored on
purpose :

- `apps/mobile/.env.local` (Helius + Privy)
- `apps/mobile/android/app/release.keystore` (signing key)
- `apps/mobile/android/local.properties` (`sdk.dir=C:\Android`)
- `~/.gradle/gradle.properties` (none was set, but the env-var
  passing approach above replaces this)
- `apps/mobile/android/app/build2/` (build output, regenerate via
  `gradlew assembleRelease`)
- `node_modules/` and `**/node_modules/` (regenerate via
  `pnpm install`)
- `pnpm patches actually applied at runtime` — the
  `patches/brace-expansion-codegen.js` etc. are committed but the
  in-memory `node_modules/.../brace-expansion/index.js` patch needs
  to be re-applied if `pnpm install` resets it (the patch is a
  loose backup, never wired into `pnpm.patchedDependencies`). See
  memory `project_balanced_match_patch.md` for the procedure.

## End-of-session repo state

Branch : `master`
Last commit on `origin/master` before this handoff : `2d1338e`
After this handoff is committed : the next commit will include all 7
modified files plus this doc. Pull from fixed PC to resume.
