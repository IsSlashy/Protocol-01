# Bringing this repo up on a second machine

What `git clone && pnpm install` gives you, what it does not, and what still will
not work afterwards. Written 2026-08-23 by sweeping the actual code, not from
memory. Ordered by what blocks first.

> ⛔ Nothing in this file is a secret. It names paths and variables; the values
> live on the machine you are copying from.

---

## 0. The two things a clone silently loses

🚨 **`services/*` is a pnpm workspace member AND is gitignored.**
`pnpm-workspace.yaml` declares `services/*`; `.gitignore:68` excludes
`/services/`. So `services/relayer` (`@protocol-01/relayer-node`, 26 tests) and
`services/frost-signer` (`@protocol-01/frost-signer`, 14 tests) do not exist in
a fresh clone. `turbo run test` then reports **18 packages instead of 20** and
**40 tests vanish without a single failure**. A suite is not green, it is
absent, and nothing distinguishes the two from a passing summary line. Same for
`p01/` (`.gitignore:243`) and most of `scripts/` (5 of ~60 files tracked).

🚨 **Claude's project memory is not in the repo.** `.gitignore:169` excludes
`.claude/`, and the 256 notes live outside the repo entirely, at
`~/.claude/projects/<encoded-path>/memory/`. See §4.

---

## 1. What the clone already gives you

- All app, package and program source; every test that lives under `apps/`,
  `packages/` and `programs/`.
- `packages/stark-prover/wasm/p01_stark_bg.wasm`, the **shipped** prover blob
  (229,640 bytes, sha `51a947e3…`). ⛔ Do not rebuild it: `stark/wasm-out/` is
  gitignored precisely because a rebuild on `master` emits the 192,732-byte
  pre-coset blob the deployed verifier **rejects**, and the rejection only
  surfaces at the end of a ~150-transaction upload.
- Both `.vercel/project.json` files, so the project is already linked.
- Every `.env.example`. ⚠️ Incomplete: `CRON_SECRET`, `REPORT_EMAIL_TO`,
  `HELIUS_API_KEY` and `NEXT_PUBLIC_HELIUS_API_KEY` are read by the code and
  have no key line in `apps/web/.env.example`.

## 2. Tools, and what each one unblocks

| Tool | Version | Unblocks |
|---|---|---|
| git, on a **SHORT** checkout path | any | The clone itself. A long path hits Windows MAX_PATH and kills the checkout. Use `C:\p01`, not a nested Documents folder. |
| Node.js | 22+ (24 works) | Everything JS. |
| pnpm | 9.15.9 (`corepack enable`) | Install and every task. `.npmrc` uses `node-linker=hoisted`. |
| Rust (rustup, cargo) | stable | `cargo check --workspace`, the verifier and `zk_shielded` tests. |
| Solana CLI (Agave) | 2.2.14 | `solana`, `solana-keygen`, deploys. |
| Solana CLI (Agave) | **3.1.9**, second install | Building `target/deploy/zk_shielded.so`, which the litesvm harnesses load. |
| Anchor via avm | 0.32.1 | `anchor build` / `test` / `deploy`. Not needed for `cargo check`. |
| Vercel CLI | 58.9.0 | `vercel env`, `vercel deploy`. Not needed to build. |
| JDK 17 + Android SDK/NDK 28 | pinned | The release APK only. ⚠️ An older NDK builds and then crashes at runtime. |
| jq, Python 3, yarn, wasm-pack | any | CI reproduction, the APK re-injection loop, `anchor test`, regenerating the prover. All optional. |

⚠️ Add a Windows Defender exclusion for the checkout before `pnpm install`.

## 3. Logins — none of these require carrying a secret

`gh auth login`, `vercel login`, and (only if publishing) `npm login` are all
browser flows. GitHub Actions secrets stay server-side: the laptop needs
nothing for `settle-till.yml` to keep running hourly.

⚠️ **`vercel env pull` will NOT rebuild a working `.env.local`.** 19 of the 28
Production variables are marked Sensitive and return `[SENSITIVE]`. The file in
§4 is the only copy.

## 4. Files to copy by hand

Move these on a USB stick or through a password manager. ⛔ Never by email or
chat.

| Path | Why |
|---|---|
| `apps/web/.env.local` | 13 vars including the funder key, the treasury seed and the Helius key. Nothing server-side in the web app runs without it. |
| `apps/mobile/.env`, `apps/mobile/.env.local`, `apps/extension/.env` | RPC keys. Without the Helius key the ~150-transaction proof upload is rate-limited into failure. |
| `~/.config/solana/` (the whole directory) | Every live devnet test; the fallback for `P01_LIVE_KEYPAIR`. |
| `<HQ>/Tech/Security-Private/` | `till-R.json` is the **only** retrievable copy of the till's spending key. Lose it and every buyer payment sitting at the till is stranded for good. |
| `services/`, `p01/`, `scripts/` | See §0. Workspace packages and operational scripts that git does not carry. |
| `*.zkey` (Groth16 proving keys, ~22 MB) | All Groth16 proving in the extension and mobile app. Untracked, and there is no `.ptau` on the machine to regenerate them from. |
| Android signing keystore | Producing an APK that upgrades over the installed one. Locate it before the old machine is wiped. |
| `~/.claude/projects/D--Protocol-01/memory/` | 256 notes, 3.1 MB. This is the agent's entire knowledge of the project. |

🚨 **The memory folder is named after the checkout path**, with `:` and `\`
replaced by `-`. `D:\Protocol-01` becomes `D--Protocol-01`. If you clone to
`C:\p01` on the laptop, rename the copied folder to `C--p01` or the notes will
not load.

## 5. What still will not work, with all of the above

- **Settlement has never run locally and still will not.**
  `P01_TILL_SECRET_KEY` and `P01_SETTLE_TRIGGER_SECRET` are in Vercel and in the
  key vault, not in `.env.local`. Production is unaffected: the hourly GitHub
  workflow calls the deployed route.
- **The waitlist answers 503 `not_configured` under `next start`.** No KV
  credentials in `.env.local`, deliberately, after test signups leaked into the
  production list. Set `P01_LOCAL_FILE_KV=1` locally, or use `next dev`.
- **The Rust CI job is red by design**, not broken by your setup. `ci.yml` exits
  1 with `Soundness pin absent` because `periodic_stride` and `b4_pair_leaf`
  live on `b7-drop-aligned-checks` along with the code they guard.
- **`turbo run test` does not cover two of the three web suites.** Also run
  `pnpm --filter @protocol-01/web test:pool` and `test:ui`.
- **`anchor build` fails on `p01_arcium`** unless the `Anchor.toml` workspace
  exclusion is respected: it needs an Arcium toolchain.
- **iOS is unreachable on Windows.** EAS cloud builds are additionally blocked
  until someone identifies the Expo account owning the project id.
- **`apps/mobile` has 35 pre-existing typecheck errors** (missing
  `serviceRegistry` exports). Compare against 35, never against 0.

## 6. Landmines worth knowing before the first edit

- `apps/extension/vite.config.ts:52` sets `define: { 'process.env': {} }`. Any
  `process.env.X` you add in extension code compiles to `undefined`.
- `NEXT_PUBLIC_`, `EXPO_PUBLIC_` and `VITE_` variables are inlined at **build**
  time. Changing one without redeploying ships a bundle that never reads it.
- `npm run build` inside `apps/extension` does not build its dependencies and
  fails on `specter-sdk`. Use `npx turbo run build --filter=@protocol-01/extension`.
- `vercel deploy --prod` must run from the repo root; from `apps/web` the
  install step fails.
- Running `npx vitest run` from the repo root picks up a config that reports
  ~2,400 tests and dozens of phantom failures. Run inside the package, or use
  `turbo`.
