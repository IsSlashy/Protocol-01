"use client";

/**
 * SubscriptionsPanel: the subscriptions this browser knows about, and the
 * detail of each one. Read-only by design: nothing here signs or sends a
 * transaction, and the chain stays the source of truth for every amount.
 *
 * ## How the list is populated
 *
 * A private vault's address is a PDA seeded on `subscriber_commitment`, which
 * derives from the note secret inside the pool Worker. The main thread cannot
 * enumerate them on chain. So the list draws from two sources:
 *
 *   1. `recordSubscription`, written at subscribe time (public fields only,
 *      same contract as `recordPayout` for withdrawals);
 *   2. "Track a vault" below, for subscriptions made before the record
 *      existed or on another device: paste the vault address, and the account
 *      is validated (owner + discriminator + decode) before it is remembered.
 *
 * ## What is deliberately NOT shown
 *
 * The license key. It derives from the note secret, which never leaves the
 * Worker, and no store anywhere holds the derived key. The detail card says
 * where the key came from and what it is (a bearer credential) instead of
 * pretending this page could reprint it.
 */

import { useCallback, useEffect, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  ArrowLeft,
  CreditCard,
  Loader2,
  KeyRound,
  Plus,
  RefreshCw,
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
  recordSubscription,
  summarizeSubscription,
  symbolForVaultMint,
  toPeriodState,
  type DecodedSubscriptionVault,
  type EntitlementStatus,
  type StoredSubscription,
  type SubscriptionSummary,
} from "@/lib/pay/subscriptions";
import { licenseServiceTag } from "@/lib/privacy/license";
import {
  NATIVE_SOL_SENTINEL_MINT,
  formatInterval,
  loadServiceRegistry,
  type ServiceEntry,
} from "@/lib/privacy/serviceRegistry";
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
  owner,
  connection,
}: {
  owner: PublicKey;
  connection: Connection;
}) {
  const walletKey = owner.toBase58();

  const [records, setRecords] = useState<StoredSubscription[]>([]);
  const [live, setLive] = useState<Record<string, VaultLive>>({});
  const [currentSlot, setCurrentSlot] = useState<bigint | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

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
    const recs = loadSubscriptions(walletKey);
    setRecords(recs);
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
  }, [connection, walletKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      recordSubscription(walletKey, {
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

  function handleForget(vaultPDA: string) {
    forgetSubscription(walletKey, vaultPDA);
    setSelected(null);
    void refresh();
  }

  function merchantName(rec: StoredSubscription): string {
    const dec = live[rec.vaultPDA];
    if (dec?.kind === "open") {
      const svc = serviceForVault(services, dec.decoded);
      if (svc) return svc.name;
    }
    return rec.serviceName ?? truncate(rec.retailer, 6, 4);
  }

  // ── Detail view ──────────────────────────────────────────────────────────
  const selectedRec = selected ? (records.find((r) => r.vaultPDA === selected) ?? null) : null;
  if (selectedRec) {
    const state = live[selectedRec.vaultPDA] ?? { kind: "loading" as const };
    const decoded = state.kind === "open" ? state.decoded : null;
    const summary = decoded
      ? summarizeSubscription(toPeriodState(decoded), currentSlot ?? 0n)
      : null;
    const decimals = decoded
      ? decimalsForVaultMint(decoded.tokenMint)
      : selectedRec.token === "SOL"
        ? 9
        : 6;
    const symbol = decoded ? symbolForVaultMint(decoded.tokenMint) : selectedRec.token;

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setSelected(null)}
            className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All subscriptions
          </button>
          <button
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
          >
            <RefreshCw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {refreshing ? "Reading…" : "Refresh"}
          </button>
        </div>

        {/* Who and where it stands */}
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Store className="h-4 w-4 shrink-0 text-p01-cyan" />
              <p className="truncate font-display text-p01-text">{merchantName(selectedRec)}</p>
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

        {/* The license key: what it is and where it lives */}
        <div className="card p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-p01-cyan" />
            <p className="font-display text-sm text-p01-text">License key</p>
          </div>
          <p className="mt-2 text-xs text-p01-text-muted">
            Your key was shown once, right after subscribing. It is stored nowhere: it re-derives
            from the secret of the note that paid for this vault, so any device holding that note
            secret can recompute the same key.
          </p>
          <p className="mt-2 text-xs text-p01-text-muted">
            It is a bearer credential. Anyone who holds the key can present it to the merchant as
            you, so share it like you would share cash.
          </p>
          <p className="mt-2 font-mono text-xs text-p01-text-dim">
            scoped to: {selectedRec.serviceTag}
          </p>
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
        <div className="card space-y-1.5 p-4">
          <a
            href={explorerAddressUrl(selectedRec.vaultPDA)}
            target="_blank"
            rel="noreferrer"
            className="block font-mono text-xs text-p01-cyan hover:underline"
          >
            vault {truncate(selectedRec.vaultPDA, 8, 6)} ↗
          </a>
          {selectedRec.openTxSig && (
            <a
              href={explorerTxUrl(selectedRec.openTxSig)}
              target="_blank"
              rel="noreferrer"
              className="block font-mono text-xs text-p01-cyan hover:underline"
            >
              opening tx {truncate(selectedRec.openTxSig, 8, 6)} ↗
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
              <dd className="break-all text-right">{selectedRec.vaultPDA}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>merchant</dt>
              <dd className="break-all text-right">{selectedRec.retailer}</dd>
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
            onClick={() => handleForget(selectedRec.vaultPDA)}
            className="mt-3 font-sans text-p01-text-muted underline hover:text-p01-red"
          >
            Untrack this vault (forgets the local record only; the vault itself is untouched)
          </button>
        </details>
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
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

        {records.length === 0 && (
          <p className="mt-3 text-xs text-p01-text-muted">
            No subscriptions tracked in this browser yet. Subscribe from the Subscribe tab, or
            track an existing vault by its address below. Subscriptions made here before this list
            existed are found the second way.
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
              return (
                <li key={rec.vaultPDA}>
                  <button
                    onClick={() => setSelected(rec.vaultPDA)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-p01-border bg-p01-void p-3 text-left hover:border-p01-border-hover"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-display text-sm text-p01-text">
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
            {tracking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Track
          </button>
        </div>
        {trackError && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-p01-red">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {trackError}
          </p>
        )}
      </div>

      <p className="text-xs text-p01-text-muted">
        A subscription is a one-way prepaid envelope: no cancel, no refund, and the merchant&apos;s
        final claim closes the vault with everything left inside going to the merchant.
      </p>
    </div>
  );
}
