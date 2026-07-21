# Waitlist backend

Double opt-in email waitlist for the Protocol 01 marketing site. Signups are
stored in Vercel KV (Upstash Redis) and confirmed through a link sent by Resend.
We persist only the SHA-256 of each confirmation token, never the raw token, so
a dump of KV cannot be replayed into working confirm or unsubscribe links.

## Flow

1. `POST /api/waitlist` stores a `pending` record and emails a confirmation link.
2. The user clicks the link, `GET /api/waitlist/confirm` marks the record
   `confirmed` and redirects to `/waitlist/confirmed`.
3. Every email also carries an unsubscribe link. `GET /api/waitlist/unsubscribe`
   hard-deletes the record and redirects to `/waitlist/removed`.
4. `GET /api/waitlist/stats` and `GET /api/waitlist/export` are admin-only.
5. `GET /api/waitlist/remind` runs daily (Vercel Cron, 10:00 UTC): sends the
   single reminder to signups pending for more than 24h (max one reminder ever
   per address, only within the first 7 days, 50 per run), and hard-deletes
   pending signups older than 30 days (counted as unsubscribed so the derived
   pending total stays honest). Auth: `Bearer CRON_SECRET` (what Vercel Cron
   sends) or the admin credentials. `?dryRun=1` lists what it would do without
   sending or deleting anything.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `KV_REST_API_URL` | prod | Upstash REST URL. Without a KV backend, prod returns 503 on signup; dev falls back to a non-durable in-memory store. |
| `KV_REST_API_TOKEN` | prod | Upstash REST token. |
| `UPSTASH_REDIS_REST_URL` | alt | Accepted in place of `KV_REST_API_URL`. |
| `UPSTASH_REDIS_REST_TOKEN` | alt | Accepted in place of `KV_REST_API_TOKEN`. |
| `RESEND_API_KEY` | yes | Resend API key. If missing or failing, signups are still stored and `wl:cnt:mailfail` is incremented. |
| `EMAIL_FROM` | no | From address. Defaults to `Protocol 01 <onboarding@resend.dev>`. |
| `SITE_URL` | no | Absolute base for links in emails. Defaults to `https://protocol-01.dev`. |
| `WAITLIST_STATS_TOKEN` | yes | Bearer token for `/stats` and `/export`. Also the salt for per-IP rate-limit hashing. |
| `ADMIN_PASSWORD` | alt | Existing admin secret; accepted via `x-admin-password` on `/stats` and `/export`. |
| `CRON_SECRET` | prod | Auth for the daily `/remind` cron. Vercel sends it automatically as a bearer token when set. |
| `WAITLIST_REMINDER_DELAY_HOURS` | no | Hours a signup must stay pending before the single reminder goes out. Defaults to 24. |

Stats and export need at least one of `WAITLIST_STATS_TOKEN` or `ADMIN_PASSWORD`
set server-side, otherwise they return 503.

## Country attribution

Each signup stores the ISO 3166-1 alpha-2 country code taken from Vercel's
`x-vercel-ip-country` header at the edge. The IP address itself is never
stored. Exposed in `/stats` under `breakdown.country`, in the export (CSV and
JSON) and as a dashboard column.

## Rate limiting

Per IP, 20 signups per rolling hour. The IP is taken from `x-real-ip` or the
first hop of `x-forwarded-for`, hashed with `WAITLIST_STATS_TOKEN` (or the
literal `salt` when unset), and bucketed by UTC hour. Over the limit returns
`429 { ok: false, error: "rate_limited" }`.

## Admin endpoints

```bash
# Stats (JSON). Bearer token:
curl -s https://protocol-01.dev/api/waitlist/stats \
  -H "Authorization: Bearer $WAITLIST_STATS_TOKEN" | jq

# Stats with the admin password header instead:
curl -s https://protocol-01.dev/api/waitlist/stats \
  -H "x-admin-password: $ADMIN_PASSWORD" | jq

# Export all current records to CSV:
curl -s https://protocol-01.dev/api/waitlist/export \
  -H "Authorization: Bearer $WAITLIST_STATS_TOKEN" \
  -o waitlist-export.csv
```

`stats` reports totals (signups, confirmed, pending, unsubscribed, mail
failures), the confirmation rate, 7- and 30-day windows, a 30-day daily series,
and breakdowns by interest, locale, and source.

## Redis key map

| Key | Type | Holds |
| --- | --- | --- |
| `wl:sub:<emailLower>` | JSON | The record: status, tokenHash, interest, locale, source, timestamps, resendCount. |
| `wl:tok:<tokenHashHex>` | string | The lowercased email a token belongs to (index for confirm and unsubscribe). |
| `wl:emails` | set | Every active email. `SADD` on signup, `SREM` on unsubscribe. Source of truth for export. |
| `wl:sources` | set | Sanitized attribution sources seen, capped at 50 entries. |
| `wl:cnt:total` | counter | New signups (never decremented on unsubscribe). |
| `wl:cnt:confirmed` | counter | Confirmations. |
| `wl:cnt:unsub` | counter | Unsubscribes. |
| `wl:cnt:mailfail` | counter | Confirmation emails that failed to send. |
| `wl:day:<YYYY-MM-DD>:signups` | counter | Daily signups (UTC). |
| `wl:day:<YYYY-MM-DD>:confirmed` | counter | Daily confirmations (UTC). |
| `wl:int:<interest>` | counter | Signups per interest tag. |
| `wl:loc:<locale>` | counter | Signups per locale. |
| `wl:src:<source>` | counter | Signups per attribution source. |
| `wl:rl:<hash12>:<YYYY-MM-DDTHH>` | counter | Per-IP hourly rate-limit bucket, expires after 3600s. |

## Manual operations (redis-cli / Upstash console)

Inspect a record:

```bash
redis-cli GET "wl:sub:user@example.com"
```

Allow another confirmation email to be sent. We store only the token hash, so we
cannot mint a working link by hand; instead clear the cooldown and cap, then have
the user resubmit the form (a `POST` re-sends when `lastSentAt` is older than 10
minutes and `resendCount` is under 5). Edit the record JSON to set
`"resendCount": 0` and an old `"lastSentAt"`, then write it back:

```bash
redis-cli SET "wl:sub:user@example.com" '<edited-json>'
```

For a clean re-signup, delete the record instead and let the user sign up again.

Hard-delete a record (mirrors the unsubscribe path). Read its `tokenHash` first
so you can also drop the token index:

```bash
# 1. find the token hash inside the record JSON
redis-cli GET "wl:sub:user@example.com"
# 2. remove the record, its token index, and the set membership
redis-cli DEL "wl:sub:user@example.com"
redis-cli DEL "wl:tok:<tokenHashFromStep1>"
redis-cli SREM "wl:emails" "user@example.com"
```

Counters (`wl:cnt:*`) are historical and are intentionally not rewound by manual
deletes. Adjust them by hand only if a stats figure needs correcting.
