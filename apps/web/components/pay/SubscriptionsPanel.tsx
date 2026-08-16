"use client";

/**
 * SubscriptionsPanel: the subscriptions this browser knows about, and the
 * detail of each one. Read-only by design: nothing here signs or sends a
 * transaction, and the chain stays the source of truth for every amount.
 *
 * ## Shape: horizontal master-detail
 *
 * From lg the list is the left column and the selected subscription's detail
 * is the right one, so clicking a merchant shows its key and remaining time
 * without navigation or context loss. Below lg the list stands alone and a
 * selection replaces it with the detail plus a back button, the same shape as
 * mobile's subscription-vaults -> vault-detail pair. Long strings (key, vault
 * address) are truncated with copy buttons; the page never scrolls
 * horizontally.
 *
 * ## How the list is populated
 *
 * A private vault's address is a PDA seeded on `subscriber_commitment`, which
 * derives from the note secret inside the pool Worker. The main thread cannot
 * enumerate them on chain. So the list draws from three sources:
 *
 *   1. `recordSubscription`, written at subscribe time (public fields only,
 *      same contract as `recordPayout` for withdrawals);
 *   2. "Track a vault" below, for subscriptions made before the record
 *      existed or on another device: paste the vault address, and the account
 *      is validated (owner + discriminator + decode) before it is remembered;
 *   3. "Recover from the chain" (#11): the Worker matches this wallet's note
 *      secrets against a program-wide vault enumeration and re-records what it
 *      finds. One pool-wide read, never a per-note probe — the leak analysis
 *      lives on `lib/privacy/pool/subscriptionRecovery.ts`.
 *
 * ## The license key is re-derived, never stored
 *
 * "Reveal key" asks the Worker to re-derive it from the note secret on demand
 * (`deriveSubscriptionLicenseKey`), which is what lets the screen say
 * truthfully that the key is stored nowhere. It only works when this browser
 * holds the paying note's blob; a vault tracked by address alone says so
 * instead of pretending.
 */

import { useCallback, useEffect, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import clsx from "clsx";
import {
  ArrowLeft,
  Check,
  Copy,
  CreditCard,
  Loader2,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Store,
  TriangleAlert,
} from "lucide-react";

import {
  NATIVE_SOL_MINT_BASE58,
  NotASubscriptionVaultError,
  ZK_SHIELDED_PROGRAM_ID_BASE58,
  bytesToHex,
  decimalsForVaultMint,
  decodeSubscriptionVault,
  forgetSubscription,
  formatApproxDuration,
  formatAtomic,
  isBase58Address,
  loadSubscriptions,
  SUBSCRIPTIONS_CHANGED_EVENT,
  recordSubscription,
  recoverSubscriptions,
  summarizeSubscription,
  symbolForVaultMint,
  toPeriodState,
  type DecodedSubscriptionVault,
  type EntitlementStatus,
  type StoredSubscription,
  type SubscriptionSummary,
} from "@/lib/pay/subscriptions";
import { deriveSubscriptionLicenseKey, loadEncryptedNotes } from "@/lib/privacy/shieldClient";
import { licenseServiceTag } from "@/lib/privacy/license";
import {
  NATIVE_SOL_SENTINEL_MINT,
  formatInterval,
  loadServiceRegistry,
  type ServiceEntry,
} from "@/lib/privacy/serviceRegistry";
import StaleWorkerNotice from "./StaleWorkerNotice";
import { truncate } from "./util";

// ---------------------------------------------------------------------------

type VaultLive =
  | { kind: "loading" }
  | { kind: "closed" }
  | { kind: "error"; message: string }
  | { kind: "open"; decoded: DecodedSubscriptionVault };

const STATUS_LABEL: Record<EntitlementStatus, string> = {
  current: "Active",
  paused: "Paused",
  unknown: "Checking",
  ended: "Ended",
  inactive: "Inactive",
};

const STATUS_CLASS: Record<EntitlementStatus, string> = {
  current: "border-p01-cyan/50 text-p01-cyan",
  paused: "border-p01-yellow/50 text-p01-yellow",
  unknown: "border-p01-border text-p01-text-muted",
  ended: "border-p01-red/50 text-p01-red",
  inactive: "border-p01-border text-p01-text-muted",
};

function StatusBadge({ status }: { status: EntitlementStatus }) {
  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function ClosedBadge() {
  return (
    <span className="shrink-0 rounded border border-p01-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-p01-text-muted">
      Closed
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => setCopied(false));
      }}
      className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** The one-line, plain-words answer to "where does this subscription stand?". */
function plainStanding(summary: SubscriptionSummary): string {
  const total = summary.totalPeriods.toString();
  const left = summary.periodsRemaining.toString();
  switch (summary.status) {
    case "current":
      return summary.secondsRemaining !== null
        ? `${left} of ${total} periods left, ${formatApproxDuration(summary.secondsRemaining)}`
        : `${left} of ${total} periods left`;
    case "ended":
      return `All ${total} paid periods are used up`;
    case "paused":
      return `Paused with ${left} of ${total} periods left`;
    case "unknown":
      return "Checking the chain clock...";
    case "inactive":
      return "Inactive";
  }
}

function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

/** Registry entry for a vault: joined on (retailer, mint), not retailer alone. */
function serviceForVault(
  services: ServiceEntry[],
  decoded: DecodedSubscriptionVault,
): ServiceEntry | null {
  const wantSol = decoded.tokenMint === NATIVE_SOL_MINT_BASE58;
  return (
    services.find((s) => {
      if (s.retailer.toBase58() !== decoded.retailer) return false;
      const isNative = s.tokenMint.toBase58() === NATIVE_SOL_SENTINEL_MINT;
      return wantSol ? isNative : s.tokenMint.toBase58() === decoded.tokenMint;
    }) ?? null
  );
}

// ---------------------------------------------------------------------------

export default function SubscriptionsPanel({
  meta,
  owner,
  connection,
}: {
  meta: string;
  owner: PublicKey;
  connection: Connection;
}) {
  const walletKey = owner.toBase58();

  const [records, setRecords] = useState<StoredSubscription[]>([]);
  const [live, setLive] = useState<Record<string, VaultLive>>({});
  const [currentSlot, setCurrentSlot] = useState<bigint | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // A version-skewed worker could not open the sealed records (see
  // StaleWorkerNotice). While true, `records` is missing every sealed row and
  // the panel must say "reload", NOT paint the ordinary "nothing tracked yet"
  // empty state — to a user that reads as their subscriptions being gone.
  const [staleWorker, setStaleWorker] = useState(false);
  // Same missing rows, different cure: the worker RESTARTED and lost the
  // seeds mid-session, healed by signing again — the reload line would send
  // the user to a step that does not fix it. Assigned per refresh, like
  // `staleWorker`.
  const [lostSession, setLostSession] = useState(false);

  // Vendor roster, best effort and cached: it only decorates the list with
  // merchant names and lets an imported vault pick up its service tag. A
  // failed read must not block the list, so errors land in nothing.
  const [services, setServices] = useState<ServiceEntry[]>([]);
  useEffect(() => {
    let dead = false;
    loadServiceRegistry(connection)
      .then((snap) => {
        if (!dead) setServices(snap.services);
      })
      .catch(() => {
        // The list still renders from records; names just stay short.
      });
    return () => {
      dead = true;
    };
  }, [connection]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    // Async since L5b: the records are sealed and the worker opens them. With
    // no session yet the loader serves the v1 cleartext view, so the list
    // still paints.
    const {
      records: recs,
      staleWorker: stale,
      lostSession: lost,
    } = await loadSubscriptions(meta, walletKey);
    setRecords(recs);
    setStaleWorker(stale);
    setLostSession(lost);
    setLive((prev) => {
      const next: Record<string, VaultLive> = {};
      for (const r of recs) next[r.vaultPDA] = prev[r.vaultPDA] ?? { kind: "loading" };
      return next;
    });
    try {
      const slot = await connection.getSlot("confirmed");
      setCurrentSlot(BigInt(slot));
    } catch {
      // A null slot renders "Checking", never an optimistic "Active".
      setCurrentSlot(null);
    }
    await Promise.all(
      recs.map(async (r) => {
        let state: VaultLive;
        try {
          const info = await connection.getAccountInfo(new PublicKey(r.vaultPDA));
          if (!info) {
            state = { kind: "closed" };
          } else if (info.owner.toBase58() !== ZK_SHIELDED_PROGRAM_ID_BASE58) {
            state = { kind: "error", message: "Account is not owned by the subscription program." };
          } else {
            state = { kind: "open", decoded: decodeSubscriptionVault(info.data) };
          }
        } catch (e) {
          state = { kind: "error", message: (e as Error).message || "Read failed." };
        }
        setLive((prev) => ({ ...prev, [r.vaultPDA]: state }));
      }),
    );
    setRefreshing(false);
  }, [connection, meta, walletKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Catch up when a subscription is opened elsewhere in the app.
  //
  // This panel used to be remounted on every visit, so reading once on mount
  // was the same as reading on every visit. Visited panels now stay mounted and
  // are only hidden with CSS, which is what lets a progress bar survive a tab
  // switch, so "once on mount" became "once per session" and a subscription
  // opened on the Subscribe tab never appeared here. `storage` alone would not
  // fix it: the browser fires that in OTHER documents, never the one that
  // wrote. Both listeners, so a second tab is covered too.
  useEffect(() => {
    const catchUp = () => void refresh();
    window.addEventListener(SUBSCRIPTIONS_CHANGED_EVENT, catchUp);
    window.addEventListener('storage', catchUp);
    return () => {
      window.removeEventListener(SUBSCRIPTIONS_CHANGED_EVENT, catchUp);
      window.removeEventListener('storage', catchUp);
    };
  }, [refresh]);

  // ── License key reveal (re-derived in the Worker, never stored) ──────────
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  // The key belongs to ONE subscription; switching selection drops it.
  useEffect(() => {
    setRevealedKey(null);
    setRevealBusy(false);
    setRevealError(null);
  }, [selected]);

  async function handleReveal(rec: StoredSubscription) {
    if (rec.pool === undefined || rec.leafIndex === undefined) return;
    setRevealBusy(true);
    setRevealError(null);
    try {
      const key = await deriveSubscriptionLicenseKey({
        meta,
        walletPubkey: walletKey,
        pool: rec.pool,
        leafIndex: rec.leafIndex,
        serviceTag: rec.serviceTag,
      });
      setRevealedKey(key);
    } catch (e) {
      setRevealError((e as Error).message || "Could not re-derive the key.");
    } finally {
      setRevealBusy(false);
    }
  }

  // ── Track a vault by address ─────────────────────────────────────────────
  const [trackAddr, setTrackAddr] = useState("");
  const [tracking, setTracking] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);

  async function handleTrack() {
    const addr = trackAddr.trim();
    setTrackError(null);
    if (!isBase58Address(addr)) {
      setTrackError("That is not a Solana address.");
      return;
    }
    setTracking(true);
    try {
      const info = await connection.getAccountInfo(new PublicKey(addr));
      if (!info) {
        setTrackError(
          "No account lives at this address on this RPC. If this was a subscription vault, " +
            "the merchant's final claim has closed it and everything in it went to the merchant.",
        );
        return;
      }
      if (info.owner.toBase58() !== ZK_SHIELDED_PROGRAM_ID_BASE58) {
        setTrackError("This account is not owned by the subscription program.");
        return;
      }
      const decoded = decodeSubscriptionVault(info.data);
      const svc = serviceForVault(services, decoded);
      const decimals = decimalsForVaultMint(decoded.tokenMint);
      await recordSubscription(meta, walletKey, {
        vaultPDA: addr,
        retailer: decoded.retailer,
        serviceTag: licenseServiceTag(svc?.slug ?? null, decoded.retailer),
        serviceName: svc?.name,
        token: symbolForVaultMint(decoded.tokenMint),
        denomination: Number(decoded.totalDeposited) / 10 ** decimals,
        rate: decoded.rate.toString(),
        intervalSlots: decoded.intervalSlots.toString(),
        openedAt: Date.now(),
      });
      setTrackAddr("");
      setSelected(addr);
      await refresh();
    } catch (e) {
      setTrackError(
        e instanceof NotASubscriptionVaultError
          ? "This account is not a subscription vault."
          : (e as Error).message || "Read failed.",
      );
    } finally {
      setTracking(false);
    }
  }

  async function handleForget(vaultPDA: string) {
    await forgetSubscription(meta, walletKey, vaultPDA);
    setSelected(null);
    void refresh();
  }

  // ── Recover from the chain (#11) ─────────────────────────────────────────
  const [recovering, setRecovering] = useState(false);
  const [recoverNote, setRecoverNote] = useState<string | null>(null);
  const [recoverError, setRecoverError] = useState<string | null>(null);

  async function handleRecover() {
    setRecovering(true);
    setRecoverNote(null);
    setRecoverError(null);
    try {
      const res = await recoverSubscriptions(meta, walletKey, {
        // Blobs let the Worker recover a subscription paid with a RECEIVED
        // note, whose secrets no seed of ours derives.
        blobs: await loadEncryptedNotes(meta, walletKey),
        services: services.map((s) => ({
          slug: s.slug,
          name: s.name,
          retailer: s.retailer.toBase58(),
          tokenMint: s.tokenMint.toBase58(),
        })),
      });
      if (res.recovered.length > 0) {
        setRecoverNote(
          `Recovered ${res.recovered.length} subscription${res.recovered.length === 1 ? "" : "s"}.`,
        );
        await refresh();
      } else if (res.alreadyTracked > 0) {
        setRecoverNote(
          `Nothing new to recover — this wallet's ${res.alreadyTracked} vault${
            res.alreadyTracked === 1 ? " is" : "s are"
          } already tracked here.`,
        );
      } else {
        setRecoverNote("No open subscription vault on chain belongs to this wallet's notes.");
      }
    } catch (e) {
      setRecoverError((e as Error).message || "Recovery failed.");
    } finally {
      setRecovering(false);
    }
  }

  function merchantName(rec: StoredSubscription): string {
    const dec = live[rec.vaultPDA];
    if (dec?.kind === "open") {
      const svc = serviceForVault(services, dec.decoded);
      if (svc) return svc.name;
    }
    return rec.serviceName ?? truncate(rec.retailer, 6, 4);
  }

  const selectedRec = selected ? (records.find((r) => r.vaultPDA === selected) ?? null) : null;

  // ── Detail pane ──────────────────────────────────────────────────────────
  function renderDetail(rec: StoredSubscription) {
    const state = live[rec.vaultPDA] ?? { kind: "loading" as const };
    const decoded = state.kind === "open" ? state.decoded : null;
    const summary = decoded
      ? summarizeSubscription(toPeriodState(decoded), currentSlot ?? 0n)
      : null;
    const decimals = decoded
      ? decimalsForVaultMint(decoded.tokenMint)
      : rec.token === "SOL"
        ? 9
        : 6;
    const symbol = decoded ? symbolForVaultMint(decoded.tokenMint) : rec.token;
    const canReveal = rec.pool !== undefined && rec.leafIndex !== undefined;

    return (
      <div className="space-y-4">
        {/* Back exists only below lg; on lg the list stays on screen. */}
        <button
          onClick={() => setSelected(null)}
          className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan lg:hidden"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All subscriptions
        </button>

        {/* Who and where it stands */}
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Store className="h-4 w-4 shrink-0 text-p01-cyan" />
              <p className="truncate font-display text-p01-text">{merchantName(rec)}</p>
            </div>
            {state.kind === "closed" ? (
              <ClosedBadge />
            ) : summary ? (
              <StatusBadge status={summary.status} />
            ) : null}
          </div>

          {state.kind === "loading" && (
            <p className="mt-3 text-sm text-p01-text-muted">Reading the vault…</p>
          )}

          {state.kind === "error" && (
            <p className="mt-3 flex items-start gap-1.5 text-sm text-p01-red">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {state.message}
            </p>
          )}

          {state.kind === "closed" && (
            <p className="mt-3 text-sm text-p01-text-muted">
              This vault no longer exists on chain. The merchant claimed its last funded period,
              which closed the account and sent the remaining balance, any dust and the rent to the
              merchant. That is the only way a vault ends.
            </p>
          )}

          {decoded && summary && (
            <>
              <p className="mt-3 text-lg text-p01-text">{plainStanding(summary)}</p>
              <p className="mt-1 text-sm text-p01-text-muted">
                {formatAtomic(decoded.totalDeposited, decimals)} {symbol} escrowed,{" "}
                {formatAtomic(decoded.rate, decimals)} {symbol} per period,{" "}
                {formatInterval(decoded.intervalSlots)}.
              </p>
              <p className="mt-1 text-xs text-p01-text-muted">
                The merchant has collected {summary.claimedPeriods.toString()} of{" "}
                {summary.totalPeriods.toString()} paid periods so far. Collection runs on its own
                clock and does not change how long your access lasts.
              </p>
            </>
          )}
        </div>

        {/* The license key: re-derived on demand, stored nowhere */}
        <div className="card p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-p01-cyan" />
            <p className="font-display text-sm text-p01-text">License key</p>
          </div>
          <p className="mt-2 text-xs text-p01-text-muted">
            The key is stored nowhere: it re-derives from the secret of the note that paid for
            this vault, so any device holding that note secret can recompute the same key.
          </p>
          <p className="mt-2 text-xs text-p01-text-muted">
            It is a bearer credential. Anyone who holds the key can present it to the merchant as
            you, so share it like you would share cash.
          </p>

          {canReveal ? (
            revealedKey ? (
              <div className="mt-3">
                <p className="break-all font-mono text-xl leading-relaxed text-p01-cyan">
                  {revealedKey}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <CopyButton text={revealedKey} label="Copy key" />
                  <button
                    onClick={() => setRevealedKey(null)}
                    className="text-xs text-p01-text-muted underline hover:text-p01-cyan"
                  >
                    Hide
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => void handleReveal(rec)}
                disabled={revealBusy}
                className="btn-secondary mt-3 inline-flex items-center gap-2 px-4 py-2 text-xs disabled:opacity-50"
              >
                {revealBusy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Re-deriving…
                  </>
                ) : (
                  <>
                    <KeyRound className="h-3.5 w-3.5" /> Reveal key
                  </>
                )}
              </button>
            )
          ) : (
            <p className="mt-3 text-xs text-p01-text-dim">
              This vault was tracked by its address, so this browser does not know which note paid
              for it and cannot re-derive the key here. Reveal it on the device that holds the
              note secret.
            </p>
          )}
          {revealError && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-p01-red">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {revealError}
            </p>
          )}

          <p className="mt-3 font-mono text-xs text-p01-text-dim">scoped to: {rec.serviceTag}</p>
          {decoded?.licenseCommitment && (
            <p className="mt-1 text-xs text-p01-text-dim">
              The vault stores a blake3 fingerprint of the key, never the key itself; a merchant
              checks a presented key against it off chain.
            </p>
          )}
        </div>

        {/* Irreversibility, on the detail page and not only before purchase */}
        <div className="rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
          <p className="font-medium">No cancel, no refund</p>
          <p className="mt-1 text-p01-red/90">
            claim_period is the only instruction that can close this vault. On the final claim the
            remaining balance, any dust and the vault&apos;s own rent all go to the merchant.
            Nothing in this vault can ever return to you.
          </p>
        </div>

        <p className="text-xs text-p01-text-muted">
          This subscription is unlinkable to your wallet only to the extent the pool is. The
          deposit published the note commitment in the clear, so treat this spend as matchable to
          it.
        </p>

        {/* Links out */}
        <div className="card space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={explorerAddressUrl(rec.vaultPDA)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-p01-cyan hover:underline"
            >
              vault {truncate(rec.vaultPDA, 8, 6)} ↗
            </a>
            <CopyButton text={rec.vaultPDA} label="Copy address" />
          </div>
          {rec.openTxSig && (
            <a
              href={explorerTxUrl(rec.openTxSig)}
              target="_blank"
              rel="noreferrer"
              className="block font-mono text-xs text-p01-cyan hover:underline"
            >
              opening tx {truncate(rec.openTxSig, 8, 6)} ↗
            </a>
          )}
        </div>

        {/* Technical detail, second plane on purpose */}
        <details className="card p-4 text-xs text-p01-text-muted">
          <summary className="cursor-pointer font-display text-sm text-p01-text">
            Technical detail
          </summary>
          <dl className="mt-3 space-y-1.5 font-mono">
            <div className="flex justify-between gap-3">
              <dt>vault PDA</dt>
              <dd className="break-all text-right">{rec.vaultPDA}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>merchant</dt>
              <dd className="break-all text-right">{rec.retailer}</dd>
            </div>
            {decoded && summary && (
              <>
                <div className="flex justify-between gap-3">
                  <dt>account size</dt>
                  <dd>{decoded.accountLen} bytes</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>interval_slots</dt>
                  <dd>{decoded.intervalSlots.toString()}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>start_slot</dt>
                  <dd>{decoded.startSlot.toString()}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>claimed_periods</dt>
                  <dd>
                    {summary.claimedPeriods.toString()} / {summary.totalPeriods.toString()}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>claimable by merchant now</dt>
                  <dd>{summary.merchantClaimableNow.toString()}</dd>
                </div>
                {decoded.subscriberCommitment && (
                  <div className="flex justify-between gap-3">
                    <dt>subscriber commitment</dt>
                    <dd>{truncate(bytesToHex(decoded.subscriberCommitment), 10, 6)}</dd>
                  </div>
                )}
                {decoded.licenseCommitment && (
                  <div className="flex justify-between gap-3">
                    <dt>license fingerprint</dt>
                    <dd>{truncate(bytesToHex(decoded.licenseCommitment), 10, 6)}</dd>
                  </div>
                )}
              </>
            )}
          </dl>
          <p className="mt-3 font-sans">
            Pause and resume exist in the protocol behind a proof of the note secret; they are not
            wired on the web yet.
          </p>
          <button
            onClick={() => handleForget(rec.vaultPDA)}
            className="mt-3 font-sans text-p01-text-muted underline hover:text-p01-red"
          >
            Untrack this vault (forgets the local record only; the vault itself is untouched)
          </button>
        </details>
      </div>
    );
  }

  // ── Master-detail frame ──────────────────────────────────────────────────
  return (
    <div className="lg:grid lg:grid-cols-5 lg:items-start lg:gap-4">
      {/* Left: the list. Below lg it yields the screen to the detail. */}
      <div className={clsx("space-y-4 lg:col-span-2", selectedRec && "hidden lg:block")}>
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-p01-cyan" />
              <p className="font-display text-sm text-p01-text">Your subscriptions</p>
            </div>
            <button
              onClick={() => void refresh()}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
            >
              <RefreshCw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {refreshing ? "Reading…" : "Refresh"}
            </button>
          </div>

          {/* The notice REPLACES the empty line, and outranks it: after
              migration a skewed OR restarted worker reads the store as empty,
              and "No subscriptions tracked yet" over records that exist is
              the exact false alarm tasks #12 and #16 exist to prevent — each
              cause gets its own cure line. A genuinely empty store never sets
              either flag (the loader asks the worker nothing), so the
              ordinary empty state below is untouched. */}
          {(staleWorker || lostSession) && (
            <div className="mt-3">
              <StaleWorkerNotice lostSession={lostSession && !staleWorker} />
            </div>
          )}

          {records.length === 0 && !staleWorker && !lostSession && (
            <p className="mt-3 text-xs text-p01-text-muted">
              No subscriptions tracked in this browser yet. Subscribe from the Subscribe tab, or
              track an existing vault by its address below. Subscriptions made here before this
              list existed are found the second way.
            </p>
          )}

          {records.length > 0 && (
            <ul className="mt-3 space-y-2">
              {records.map((rec) => {
                const state = live[rec.vaultPDA] ?? { kind: "loading" as const };
                const summary =
                  state.kind === "open"
                    ? summarizeSubscription(toPeriodState(state.decoded), currentSlot ?? 0n)
                    : null;
                const active = rec.vaultPDA === selected;
                return (
                  <li key={rec.vaultPDA}>
                    <button
                      onClick={() => setSelected(rec.vaultPDA)}
                      className={
                        active
                          ? "flex w-full items-center justify-between gap-3 rounded-lg border border-p01-cyan bg-p01-cyan/10 p-3 text-left"
                          : "flex w-full items-center justify-between gap-3 rounded-lg border border-p01-border bg-p01-void p-3 text-left hover:border-p01-border-hover"
                      }
                    >
                      <div className="min-w-0">
                        <p
                          className={clsx(
                            "truncate font-display text-sm",
                            active ? "text-p01-cyan" : "text-p01-text",
                          )}
                        >
                          {merchantName(rec)}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-p01-text-muted">
                          {state.kind === "loading" && "Reading the vault…"}
                          {state.kind === "closed" && "Closed, fully paid out to the merchant"}
                          {state.kind === "error" && "Could not read the vault"}
                          {summary && plainStanding(summary)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {state.kind === "closed" ? (
                          <ClosedBadge />
                        ) : summary ? (
                          <StatusBadge status={summary.status} />
                        ) : null}
                        <span className="font-mono text-xs text-p01-text-muted">
                          {rec.denomination} {rec.token}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Track an existing vault */}
        <div className="card p-4">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-p01-cyan" />
            <p className="font-display text-sm text-p01-text">Track a vault</p>
          </div>
          <p className="mt-2 text-xs text-p01-text-muted">
            Paste a subscription vault address to add it to this list, for subscriptions opened
            before this page existed or from another browser.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={trackAddr}
              onChange={(e) => setTrackAddr(e.target.value)}
              placeholder="Vault address"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-p01-border bg-p01-void px-3 py-2 font-mono text-xs text-p01-text placeholder:text-p01-text-dim focus:border-p01-cyan focus:outline-none"
            />
            <button
              onClick={() => void handleTrack()}
              disabled={tracking || trackAddr.trim().length === 0}
              className="btn-secondary inline-flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-50"
            >
              {tracking ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Track
            </button>
          </div>
          {trackError && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-p01-red">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {trackError}
            </p>
          )}
        </div>

        {/* Recover from the chain: the list above is a cache since #11 */}
        <div className="card p-4">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-p01-cyan" />
            <p className="font-display text-sm text-p01-text">Recover from the chain</p>
          </div>
          <p className="mt-2 text-xs text-p01-text-muted">
            Lost this list? The private worker matches the notes this wallet owns against the
            subscription program&apos;s vaults and re-records yours: vault, merchant, price,
            period and license key all come back. It asks the network one pool-wide question —
            nothing derived from your notes leaves this device. Only merchant display names and
            opening-transaction links cannot be restored.
          </p>
          <button
            onClick={() => void handleRecover()}
            disabled={recovering}
            className="btn-secondary mt-3 inline-flex items-center gap-1.5 px-3 py-2 text-xs disabled:opacity-50"
          >
            {recovering ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            {recovering ? "Scanning…" : "Recover subscriptions"}
          </button>
          {recoverNote && <p className="mt-2 text-xs text-p01-text-muted">{recoverNote}</p>}
          {recoverError && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-p01-red">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {recoverError}
            </p>
          )}
        </div>

        <p className="text-xs text-p01-text-muted">
          A subscription is a one-way prepaid envelope: no cancel, no refund, and the
          merchant&apos;s final claim closes the vault with everything left inside going to the
          merchant.
        </p>
      </div>

      {/* Right: the detail of the selected merchant. Below lg it only exists
          while something is selected; on lg it is always on screen. */}
      <div className={clsx("mt-4 lg:col-span-3 lg:mt-0", !selectedRec && "hidden lg:block")}>
        {selectedRec ? (
          renderDetail(selectedRec)
        ) : (
          <div className="card p-6 text-center text-sm text-p01-text-muted">
            Select a subscription to see its standing, its license key and its detail.
          </div>
        )}
      </div>
    </div>
  );
}
