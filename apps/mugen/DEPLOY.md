# Mugen — Vercel deploy runbook

Target: production-ready deploy of `apps/mugen` to Vercel with a working
trade flow (encrypted orders → blind take → escrow → release), not just a
UI vitrine.

## Prerequisites

- Node 22+ locally, pnpm 8.15+
- Vercel CLI installed: `npm i -g vercel`
- An Upstash Redis database (free tier) OR a Vercel KV store (Marketplace)
- Local `.secrets/` folder populated with 7 keypair JSON files (already
  present: taker, treasury-buffer, noise-wallet-{0..4})
- Your relayer keypair at `~/.config/solana/id.json`

## Step 1 — Export keypairs to base64

From repo root:

```
pnpm -F @protocol-01/mugen env:export-keypairs
```

Copy the printed `MUGEN_*_B64` values (and `MUGEN_RELAYER_KEYPAIR`) — you'll
paste them into Vercel env vars in step 4.

## Step 2 — Provision Upstash Redis

Fastest path: Vercel Dashboard → Storage → Create → Upstash Redis. This auto-
sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` in the linked project, no
copying needed.

Alternative: sign up at upstash.com, create a Redis DB (free tier, global),
copy `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.

The storage backend is used by:
- Encrypted order registry (maker listings)
- Auth sessions (QR-code sign-in flow)
- Treasury buffer queue (incoming payment router)
- Noise engine queue (decoy submissions)

Without it, trades fail on Vercel because maker and taker land on different
serverless instances.

## Step 3 — Link the Vercel project

```
cd apps/mugen
vercel link
```

When prompted:
- Scope: your personal account (or Volta Team if set up)
- Link to existing project? No (first time) → create new, name: `mugen`
- Root directory: current (`apps/mugen`). **Important** — Vercel must check
  out the full monorepo; the `cd ../..` in `vercel.json` handles pnpm install
  + turbo-filtered build.

## Step 4 — Set environment variables

In the Vercel dashboard → Project → Settings → Environment Variables, add
every non-empty value from `.env.example`. Scope all of them to Production +
Preview + Development (except `NEXT_PUBLIC_MUGEN_API` which should differ
per-env if you deploy previews).

Required for trades to work:
- `SOLANA_RPC_URL` — Helius devnet recommended
- `NEXT_PUBLIC_SOLANA_RPC` — same or a public endpoint
- `MUGEN_RELAYER_KEYPAIR` — base64
- `MUGEN_TAKER_KEYPAIR_B64`
- `MUGEN_TREASURY_BUFFER_KEYPAIR_B64`
- `MUGEN_NOISE_WALLETS_B64` — JSON array
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` (auto-set if you used Vercel KV)

Optional:
- `CRON_SECRET` — random 32-byte string if you want to curl the tick routes
- `FROST_HOST_{0,1,2}` — only if you deploy FROST signers externally
- `NOISE_ENGINE_DISABLED=1` — to mute decoy traffic

## Step 5 — Deploy

Preview first:

```
vercel deploy
```

Smoke test the preview URL:
- `/` and `/how-it-works` render
- `/exchange` loads price ticker (`/api/prices`)
- `/api/ephemeral/ping` returns 200
- Vercel Logs show no keypair-loading errors

Then promote to prod:

```
vercel deploy --prod
```

## Step 6 — Verify cron schedules

Dashboard → Project → Crons should show two entries at `* * * * *`:
- `/api/cron/treasury-buffer-tick`
- `/api/cron/noise-tick`

Both are gated on the `x-vercel-cron` header (set automatically by Vercel)
or `Authorization: Bearer $CRON_SECRET`. Manual probe:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-deploy>/api/cron/noise-tick -X POST
```

Should return `{ ok: true, ... }`.

## Post-deploy: FROST signers (only if running threshold release flow)

FROST coordinator hosts are not deployable to Vercel (long-running stateful
processes). For the demo, either:
- Leave them unreachable (trade release falls back to single-sig) — fine for
  Colosseum Frontier video demo
- Deploy the 3 signer processes to Railway / Fly.io and set
  `FROST_HOST_{0,1,2}` to their public URLs

Railway quickstart (not automated here): create a new service from the
`services/frost-signer-*` directories (if present in repo), expose the
configured port, set env vars for each signer's keypair.

## Rollback

```
vercel rollback
```

Or promote an older deployment from the Deployments tab.

## Known limitations

- The MPC matching path relies on a server-side registry (`encrypted-order-
  registry`) as an MVP bridge until the arcium-anchor 0.9.2 callback output
  wrapper ABI is public. Once that lands, the registry can be deleted in
  favor of on-chain callback parsing.
- Public Solana devnet RPC rate-limits heavily — Helius recommended.
- `/api/debug/*` routes are gated on `NODE_ENV !== 'production'`. They're
  inert in prod but consider deleting them entirely before a public launch.
