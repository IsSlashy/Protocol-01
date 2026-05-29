# Mobile Polish Audit — 2026-05-29 (v1.0.1)

Method: 8 parallel domain auditors (UI/UX, privacy-logic, wallet/payments, subs/streams,
on-device LLM agent, auth/security, code-health, web/extension+stack-novelty) over the
full `apps/mobile` codebase, each finding adversarially verified before being marked
"safe to auto-apply". Read-only audit; all edits below were applied + verified by me
afterward. Guardrail throughout: **never** touch crypto/proof/tx/signing/balance logic;
don't disturb the fragile pnpm-10 build config.

## Smoke-test baseline & final state
| Check | Baseline | After edits |
|---|---|---|
| `tsc --noEmit` (mobile) | 1 error | **0 errors ✅** |
| `vitest run` (mobile) | 208/208 | **208/208 ✅** |
| Metro JS bundle (`expo export`) | — | ⚠️ blocked by pnpm-10 sparse link (dev-tooling, not code) |

Note: `expo`/`@expo/cli` is not materialized in resolvable `node_modules` under pnpm 10
(`pnpm exec expo` → "Cannot find module .../expo/bin/cli"). `tsc` passing proves the JS
import graph resolves; the real injection path is the gradle native build. Revert path if
the CLI is needed: pin `packageManager` to `pnpm@9.15.9`.

---

## FIXED this session (8 — all verified, runtime-safe)
| # | File | Change | Severity | Notes |
|---|---|---|---|---|
| 1 | `app/(main)/(streams)/create.tsx` | Widen `frequency` to `StreamFrequency` (was narrowed to the form's 4-value `PaymentFrequency`, making `=== 'yearly'` a dead/typed-error branch) | (tsc blocker) | Runtime-identical: memo bytes unchanged for all 4 reachable cadences |
| 2 | `app/(main)/(privacy)/denominated-import.tsx` | Fire `refreshNoteStatuses()` after import so the note's true status shows on arrival | low | Read-only, idempotent, established pattern |
| 3 | `services/ai/llamaService.ts` | `MODEL_INFO.contextLength` 2048 → 4096 (matches `initLlama` n_ctx) | low | Dead metadata, zero consumers |
| 4 | `app/(main)/(settings)/index.tsx` | Advanced toggle label: both ternary branches were identical `'Danger Zone'` → now `Close`/`Danger Zone` | low | Reuses existing `common.close` (all 3 locales) |
| 5 | `app/(main)/(settings)/index.tsx` + `i18n/en.ts` | Two consecutive sections both titled `PRIVACY` → 2nd is now `Privacy Features` | low | New `settings.privacyFeatures` key (en only; fr/ja fall back — see backlog) |
| 6 | `app/(main)/(settings)/backup.tsx` | Seed-phrase copy button mislabeled `Paste` → `Copy All` | low | The proposed `common.copy` did NOT exist (would render `[missing translation]`); used existing `onboarding.copyAll` |
| 7 | `app/(main)/(privacy)/subscribe-private.tsx` | **V4-pool regression**: `findPool()` (V2-only) → `findPoolByPDA()` | **HIGH** | Private subscriptions failed "Pool Unavailable" for *every* note since the 2026-05-07 V4 bump. Mirrors working `(streams)/subscribe.tsx` |
| 8 | `app/(main)/(privacy)/vault-detail.tsx` | **V4-pool regression**: cancel preview `ALL_POOLS.find` → `findPoolByPDA` + missing-pool guard | medium | V4 vaults showed misleading "all dust" refund preview. `confirmCancel` does NOT use the pool, so the cancel tx is untouched. Mirrors `(streams)/[id].tsx` |

---

## DECISIONS NEEDED (flagged, deliberately NOT touched)
These need your call — they involve product intent or were intentional.

- **A. Screenshot blocking is OFF on purpose (demo recording).** `useSecuritySettings.ts:155-159` + `security.tsx:357-369` have `TEMP: demo recording` code that unconditionally calls `allowScreenCaptureAsync()`, so the global "Block screenshots" toggle is a **no-op app-wide** (contradicts SECURITY.md). Seed/view-keys screens still self-protect. → Re-enable now, or keep off for recording? (HIGH if shipping.)
- **B. View Keys are random mocks.** `view-keys.tsx` generates 32 random bytes (`generateMockKey`, `setTimeout` "simulate"), then offers QR/Copy/**Share** as if real FVK/IVK/OVK. An auditor/user who shares one shares a non-functional key. → Gate behind "Preview / not active" + disable Share, or wire real derivation? (HIGH — relevant to "let people audit the app".)
- **C. Extension Shield tab is on a dead Groth16 path** (`apps/extension`): fake no-tx shield that navigates as success; `unshieldNote` always throws; seed v1 vs mobile v4. Working pool is `/shielded`. → Repoint Shield to `/shielded` or gate `/denominated`. (Extension is ~6mo behind mobile.)
- **D. "-10%" discount is advertised but never applied** (`subscribe.tsx` duration badges + summary row). Trust issue on a payments screen. → Remove the badge/row, or implement a real prepay discount (larger change)?
- **E. `send-confirm.tsx` is orphaned dead code** with a fabricated "Privacy Fee" + fake `setTimeout` auth/signing delays. No code path navigates to it. → Delete after confirming no deep link targets `/send-confirm`.
- **F. Weak PINs accepted** (`000000`/`123456`) and seed-verify is skippable. SECURITY.md references a `utils/validation/pin.ts` that doesn't exist. → Add a small weak-PIN denylist?

---

## BACKLOG (prioritized, by feature) — NOT applied
All flagged `autoApplySafe=false`: they touch tx-adjacent flows, span many files, or are
product-facing. Listed highest-leverage first within each area.

### Privacy core
- `denominated-transfer.tsx`: "Send" + paper-plane mints a **bearer claim-link** (no recipient field) — correct by design but mislabeled; add an explainer before the ~60s proof. (medium)
- `denominated-unshield.tsx`: received notes still maturing stay status `imported`, so they're excluded from the unshield list **and** the "X notes still maturing" hint — looks like "no notes". Surface them read-only with the countdown. (medium)
- `denominated-notes.tsx`: re-sharing a transferred note's claim link offers only OS Share, no Copy. (low)
- `denominated-shield.tsx`: USDC deposits skip the insufficient-balance preflight (SOL is guarded) → fail late after minutes of proof. (low)
- `denominated-transfer.tsx`: V3 transfer has no pre-proof root check/retry, unlike unshield (`denominated-unshield.tsx:190-220`) — can burn full proof time then fail on indexer lag. (low)

### Wallet & payments
- `token/[id].tsx` → `send.tsx`: tapping Send on an SPL token routes to the **SOL-only** send screen (token param dropped). Gate the button or show "use Swap". (medium)
- `walletStore.ts`: post-send balance refresh is gated behind a fixed 2s `setTimeout`; home looks stale on return. (low)
- `receive.tsx`: toggling Public↔Private regenerates a fresh stealth address each time. (low)
- `send.tsx`: MAX reserves a flat 0.001 SOL but the UI advertises ~0.000005 fee. (low)
- `send.tsx`: no self-send warning. `scan.tsx`: tappable "example" address is a valid-looking burn address that routes to send. (low)

### Subscriptions & streams
- `streams.ts` + `(streams)/index.tsx`: ZK/vault streams **never auto-renew** (proof needs foreground WebView); they just sit at "Due now". Surface "Action needed — tap Pay Now". (medium)
- `(streams)/subscribe.tsx`: dust-forfeiture on single-note vault cancel is under-explained at subscribe time. (low)
- `subscribe-private.tsx`: P2P handoff drops the user into a raw pubkey/rate form (retailer already known). (low)
- `subscribe.tsx`: services with non-standard cadence (e.g. every 3 days) are recorded/recovered as "monthly". (low)

### On-device LLM agent
- `agent.ts`: 40+ tools are **dead in cloud chat** — the streaming path never parses `​```tool` blocks (only the on-device non-streaming path does). Either stop injecting tool prompts for streaming, or run the tool loop after streaming. (medium)
- `aiStore.ts`: raw `​```tool` JSON can render in the assistant bubble (streaming path doesn't strip it). (medium)
- `index.tsx`: no Stop button for in-progress generation (`LlamaService.stopCompletion()` exists, unwired). (medium)
- `llamaService.ts`: loaded model holds ~800MB forever — never released on blur/background (only manual unload). (medium)
- `aiStore.ts`: every streamed token re-maps the whole messages array (long-chat jank). (low)
- `ActionPreview`/`ExecutionProgress` built + exported but rendered nowhere; `gemma.ts` orphaned. (low)

### Auth & security
- `lock.tsx`: no-method branch can dead-end on "Loading…" if the device-auth prompt is cancelled (no retry button). (medium)
- Unshield/withdraw always prompt for auth, ignoring the "Require auth for sends" toggle (safe direction, but inconsistent). (low)
- `(onboarding)/backup.tsx`: seed clipboard auto-clear timer isn't cancelled / cleared on early screen exit. (low)

### Code health
- **Progress `setInterval` leaks on error** in `shielded.tsx`/`confidential.tsx`/`shielded-transfer.tsx`: `clearInterval` sits inside the `try`, so a throwing tx leaks the timer (setState after unmount). Move to `finally`. (medium)
- 18 `if (1) { console.log }` debug gates across 4 files (one sha256-hashes the subscriber secret to format a debug string on every subscribe). Replace with `if (__DEV__)`. (low)
- Stale `TODO fill after devnet v3 deploy` header above populated pool config; deprecated `fitsInRelayerEnvelope` export unused; contradictory screenshot-default comments. (low)

### Design system (consistency debt — visual review needed)
- **`#8B8BFF` periwinkle/purple** used as accent + primary CTA across 6+ privacy screens, violating theme.ts "NO purple anywhere"; `buy.tsx`/`ServiceSelector.tsx` add `#7c3aed`/`#8b5cf6`. Decide: sanction a token or replace with `Colors.blue`. (medium)
- i18n (en/fr/ja) wired into only ~6 screens; adopting screens still mix `t()` with hardcoded English → half-translated UI; the Settings language switcher under-delivers. (medium)
- `components/ui` (Button/Card/Input/BottomSheet/Toast/AlertModal) is well-built but bypassed — most screens re-roll primitives (root cause of radius/color drift); `Input.tsx` even uses an off-palette cyan `#06b6d4`. (medium)
- Local `const P01`/`COLORS` objects duplicated per screen instead of importing `P01Colors`. (low)
- Native `Alert.alert` in `quantum.tsx`/`subscription-vaults.tsx` despite the themed `p01Alert`. (low)
- `KeyboardAvoidingView behavior='height'` on Android (janky) on 6 screens; chat screen deliberately avoids it. (low)
- `PinInput.tsx`: `useSharedValue`/`useAnimatedStyle` called inside `.map()` (Rules-of-Hooks latent fragility; works because length is constant). (low)
- Follow-up to fix #5: add `settings.privacyFeatures` to `i18n/fr.ts` ("Options de confidentialité") and `ja.ts` ("プライバシー機能").

---

## DEVICE-TEST CHECKLIST (when injecting v1.0.x)
Priority order — the first two validate the regressions fixed this session:

1. **Private subscription** (`subscribe-private`): from a mature **V4** note, create a private subscription. Must NOT show "Pool Unavailable". (Was broken since 2026-05-07.)
2. **Vault cancel preview** (`vault-detail`): open Cancel on a **V4** vault. Refund preview must show the real amount, not "all dust" / "—". A truly-unknown pool shows "Pool config missing" (no 60s proof-then-fail).
3. **Import note**: import a received note → notes list reflects correct status on arrival.
4. **Settings**: no duplicate "PRIVACY" header (2nd reads "Privacy Features"); Advanced toggle reads "Close" when expanded; Backup seed copy button reads "Copy All".
5. **Streams create**: still creates a stream + first payment (the frequency type fix).
6. **Regression sweep** (must be unchanged): shield, unshield, transfer, send SOL, swap.
