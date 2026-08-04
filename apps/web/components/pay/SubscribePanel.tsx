"use client";

/**
 * SubscribePanel — pick a vendor, pick a note, subscribe, show the key.
 *
 * Same two-phase shape as every other pool operation: nothing here proves,
 * signs or sends. `subscribeFromPool` (in `lib/privacy/shieldClient.ts`) drives
 * the worker for the proving half and asks the wallet for the ONE pre-fund
 * signature; this file only chooses the inputs and renders the outcome.
 *
 * The two facts this panel exists to make un-missable, because both surprise
 * people and both are true:
 *
 *   1. Subscribing escrows the WHOLE note denomination, not `rate × periods`.
 *      `subscribe_private_stark.rs:185` sets `let amount = pool.denomination;`.
 *   2. There is no way back. `claim_period` is the only instruction that can
 *      close a vault, and on the final claim Anchor's `close` moves every
 *      remaining lamport — leftover balance, dust and the vault's own rent — to
 *      the retailer (`claim_period.rs:309-315`).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  BadgeCheck,
  Check,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  Store,
  TriangleAlert,
} from "lucide-react";

import * as shieldClient from "@/lib/privacy/shieldClient";
import { licenseServiceTag } from "@/lib/privacy/license";
import type { PoolToken } from "@/lib/privacy/pool/denominatedPool";
import type { PoolNoteView } from "@/lib/privacy/worker/poolHandlers";
import {
  NATIVE_SOL_SENTINEL_MINT,
  formatInterval,
  formatServicePrice,
  loadServiceRegistry,
  type RegistrySnapshot,
  type ServiceEntry,
} from "@/lib/privacy/serviceRegistry";
import { truncate } from "./util";

// ---------------------------------------------------------------------------
// The contract with `subscribeFromPool`
//
// That function is being written in `lib/privacy/shieldClient.ts` by another
// agent. Rather than guess at import time, the panel states the shape it was
// promised and resolves the export at call time.
//
// The `Partial<SubscribeModule>` assignment below is the point of this: while
// the export is absent it type-checks trivially, and the moment it lands with a
// signature that is not this one, `tsc` fails HERE instead of the panel
// silently calling something with the wrong arguments.
// ---------------------------------------------------------------------------

export interface SubscribeFromPoolParams {
  meta: string;
  token: PoolToken;
  denomination: number;
  leafIndex: number;
  retailer: PublicKey;
  rate: bigint;
  intervalSlots: bigint;
  serviceId: string;
  owner: PublicKey;
  connection: Connection;
  signOne: (tx: Transaction) => Promise<Transaction>;
  onProgress?: (step: string) => void;
}

export interface SubscribeFromPoolResult {
  txSig: string;
  /** Typed loosely on purpose: the brief named the field, not its type. */
  vaultPDA: PublicKey | string;
  licenseKey: string;
}

interface SubscribeModule {
  subscribeFromPool: (p: SubscribeFromPoolParams) => Promise<SubscribeFromPoolResult>;
}

const subscribeModule: Partial<SubscribeModule> = shieldClient;

// ---------------------------------------------------------------------------

/** Atomic units per whole token, by pool. Mirrors `PoolConfig.decimals`. */
function decimalsForPoolToken(token: PoolToken): number {
  return token === "SOL" ? 9 : 6;
}

/** A service is payable from this pool only if it prices in the same mint. */
function pricedInPoolToken(service: ServiceEntry, token: PoolToken): boolean {
  const isNative = service.tokenMint.toBase58() === NATIVE_SOL_SENTINEL_MINT;
  return token === "SOL" ? isNative : !isNative;
}

/**
 * Periods the escrow buys: `floor(denomination / rate)`.
 *
 * This is a display of the on-chain arithmetic, not a promise: `claim_period`
 * settles `floor(elapsed / interval_slots)` periods at `rate` each until the
 * balance cannot cover another one.
 */
function periodsFunded(
  denomination: number,
  decimals: number,
  priceAtomic: bigint,
): bigint {
  if (priceAtomic <= 0n) return 0n;
  const atomic = BigInt(Math.round(denomination * 10 ** decimals));
  return atomic / priceAtomic;
}

function noteKey(n: PoolNoteView): string {
  return `${n.pool}:${n.leafIndex}`;
}

export default function SubscribePanel({
  meta,
  owner,
  connection,
  signOne,
  token,
}: {
  meta: string;
  owner: PublicKey;
  connection: Connection;
  signOne: ((tx: Transaction) => Promise<Transaction>) | null;
  token: PoolToken;
}) {
  // ── Vendors ──────────────────────────────────────────────────────────────
  const [registry, setRegistry] = useState<RegistrySnapshot | null>(null);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [selectedPda, setSelectedPda] = useState<string | null>(null);

  const loadVendors = useCallback(
    async (force: boolean) => {
      setRegistryLoading(true);
      setRegistryError(null);
      try {
        const snap = await loadServiceRegistry(connection, { force });
        setRegistry(snap);
      } catch (e) {
        // Deliberately does NOT fall back to an empty roster: "no vendors" and
        // "we could not read the registry" are different sentences and the user
        // is entitled to the true one.
        setRegistry(null);
        setRegistryError((e as Error).message || "Could not read the service registry.");
      } finally {
        setRegistryLoading(false);
      }
    },
    [connection],
  );

  useEffect(() => {
    void loadVendors(false);
  }, [loadVendors]);

  // ── Notes ────────────────────────────────────────────────────────────────
  const [notes, setNotes] = useState<PoolNoteView[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanStep, setScanStep] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<string | null>(null);

  const rescan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      // "SOL" is not a shortcut: `scanPool` in shieldClient.ts:191-197 is typed
      // to that one literal, so the SOL pools are the only notes this path can
      // enumerate today. The USDC notice below says so rather than pretending.
      // FIRST PAINT, no network. Notes shielded from this browser are already in
      // local storage, encrypted under the pool seed, and carry pool, leaf index,
      // denomination and commitment. Drawing them costs milliseconds; the chain
      // walk below costs tens of seconds on the public devnet RPC and the user
      // was watching "Scanning the 0.1 SOL pool..." the whole time.
      //
      // These arrive with `spentKnown: false` — nothing here has seen a nullifier
      // PDA — so they are provisional until the scan below replaces them.
      try {
        const local = await shieldClient.scanPoolLocal(meta, owner.toBase58());
        if (local.notes.length > 0) setNotes(local.notes);
      } catch {
        // A missing or unreadable blob store is not an error worth showing:
        // the authoritative scan runs next regardless.
      }
      const res = await shieldClient.scanPool(meta, "SOL", setScanStep);
      setNotes(res.notes);
    } catch (e) {
      setScanError((e as Error).message || "Pool scan failed.");
    } finally {
      setScanning(false);
      setScanStep(null);
    }
  }, [meta]);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  // ── Subscribe ────────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubscribeFromPoolResult | null>(null);
  const [copied, setCopied] = useState(false);

  const unspent = useMemo(() => notes.filter((n) => !n.spent), [notes]);
  const services = registry?.services ?? [];
  const service = services.find((s) => s.pda.toBase58() === selectedPda) ?? null;
  const note = unspent.find((n) => noteKey(n) === selectedNote) ?? null;

  const decimals = decimalsForPoolToken(token);
  const tokenMismatch = service ? !pricedInPoolToken(service, token) : false;
  const periods =
    service && note ? periodsFunded(note.denomination, decimals, service.priceAtomic) : null;

  const usdcUnsupported = token !== "SOL";
  const blockedReason = usdcUnsupported
    ? `The note scanner only enumerates SOL pool notes today, so a ${token} subscription cannot be funded from this panel.`
    : !signOne
      ? "This wallet cannot sign transactions."
      : !service
        ? "Choose a vendor."
        : tokenMismatch
          ? `${service.name} prices in a different mint than the ${token} pool, so a ${token} note cannot fund it.`
          : !note
            ? "Choose a note to escrow."
            : periods !== null && periods === 0n
              ? "This note is smaller than one billing period, so it would fund nothing."
              : null;

  async function handleSubscribe() {
    if (!signOne || !service || !note) return;
    const call = subscribeModule.subscribeFromPool;
    if (!call) {
      setError(
        "subscribeFromPool has not been wired into lib/privacy/shieldClient.ts yet, so nothing " +
          "was sent. No funds moved.",
      );
      return;
    }
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const out = await call({
        meta,
        token,
        denomination: note.denomination,
        leafIndex: note.leafIndex,
        retailer: service.retailer,
        rate: service.priceAtomic,
        intervalSlots: service.intervalSlots,
        // The tag the key is scoped to. `licenseServiceTag(slug, retailer)`
        // reproduces exactly what mobile posts — its subscribe screen passes
        // `serviceId: svc.slug` (streams/index.tsx:334) into the same helper
        // (streams/subscribe.tsx:405). Sending anything else here mints a key
        // no merchant will accept.
        serviceId: licenseServiceTag(service.slug, service.retailer.toBase58()),
        owner,
        connection,
        signOne,
        onProgress: setStep,
      });
      setResult(out);
      void rescan();
    } catch (e) {
      setError((e as Error).message || "Subscription failed.");
    } finally {
      setSubmitting(false);
      setStep(null);
    }
  }

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const busy = submitting || scanning;

  return (
    <div className="space-y-5">
      {/* Vendors */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Store className="h-4 w-4 text-p01-cyan" />
            <p className="font-display text-sm text-p01-text">Vendors</p>
          </div>
          <button
            onClick={() => void loadVendors(true)}
            disabled={registryLoading || submitting}
            className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
          >
            <RefreshCw className={registryLoading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {registryLoading ? "Reading…" : "Refresh"}
          </button>
        </div>

        {registryError && (
          <div className="mt-3 rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
            <p className="font-medium">Could not read the vendor registry</p>
            <p className="mt-1 text-p01-red/90">{registryError}</p>
            <p className="mt-1 text-p01-red/90">
              This is a failed read, not an empty roster — vendors are registered on chain and this
              client could not see them.
            </p>
          </div>
        )}

        {!registryError && registry && registry.matchedAccounts === 0 && (
          <p className="mt-3 text-xs text-p01-text-muted">
            The registry program answered and holds no service accounts on this endpoint. Six
            vendors are registered on devnet, so this usually means the RPC is pointed elsewhere.
          </p>
        )}

        {!registryError && registry && registry.decodeFailures > 0 && (
          <p className="mt-3 text-xs text-p01-yellow">
            {registry.decodeFailures} of {registry.matchedAccounts} registry entries could not be
            decoded and are not listed. The on-chain layout may have changed.
          </p>
        )}

        {registryLoading && !registry && (
          <p className="mt-3 text-xs text-p01-text-dim">Reading the registry…</p>
        )}

        {services.length > 0 && (
          <ul className="mt-3 space-y-2">
            {services.map((s) => {
              const payable = pricedInPoolToken(s, token);
              const active = s.pda.toBase58() === selectedPda;
              return (
                <li key={s.pda.toBase58()}>
                  <button
                    onClick={() => setSelectedPda(s.pda.toBase58())}
                    disabled={submitting || !payable}
                    className={
                      active
                        ? "flex w-full items-center justify-between gap-3 rounded-lg border border-p01-cyan bg-p01-cyan/10 p-3 text-left"
                        : "flex w-full items-center justify-between gap-3 rounded-lg border border-p01-border bg-p01-void p-3 text-left hover:border-p01-border-hover disabled:opacity-50"
                    }
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p
                          className={
                            active
                              ? "truncate font-display text-sm text-p01-cyan"
                              : "truncate font-display text-sm text-p01-text"
                          }
                        >
                          {s.name}
                        </p>
                        {s.verified ? (
                          <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-p01-cyan" />
                        ) : (
                          <span className="shrink-0 rounded border border-p01-yellow/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-p01-yellow">
                            Unverified
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-p01-text-muted">
                        {s.category || "uncategorised"} · {s.slug}
                      </p>
                      {!payable && (
                        <p className="mt-0.5 text-xs text-p01-text-dim">
                          Priced in another mint — not payable from a {token} note.
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-sm text-p01-text">{formatServicePrice(s)}</p>
                      <p className="text-xs text-p01-text-muted">
                        {formatInterval(s.intervalSlots)}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Notes */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-p01-cyan" />
            <p className="font-display text-sm text-p01-text">Note to escrow</p>
          </div>
          <button
            onClick={rescan}
            disabled={scanning || submitting}
            className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
          >
            <RefreshCw className={scanning ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>

        {scanStep && <p className="mt-2 text-xs text-p01-text-dim">{scanStep}</p>}
        {scanError && <p className="mt-2 text-sm text-p01-red">{scanError}</p>}

        {usdcUnsupported && (
          <p className="mt-2 text-xs text-p01-yellow">
            Only SOL pool notes are listed. The scan path is typed to the SOL pools
            (shieldClient.ts:191), so a {token} note cannot be found or spent from here yet.
          </p>
        )}

        {!scanning && unspent.length === 0 && !scanError && (
          <p className="mt-2 text-xs text-p01-text-muted">
            No unspent notes. Shield one in the Pool tab first — the note you shield is the whole
            budget of the subscription.
          </p>
        )}

        {unspent.length > 0 && (
          <ul className="mt-3 space-y-2">
            {unspent.map((n) => {
              // Key on `k`, NOT on `n.counter`: local-storage notes all carry 0,
              // so those keys collide and React may omit or duplicate rows —
              // which is how a shielded note failed to appear in this selector.
              const k = noteKey(n);
              const active = k === selectedNote;
              return (
                <li key={k}>
                  <button
                    onClick={() => setSelectedNote(k)}
                    disabled={submitting}
                    className={
                      active
                        ? "flex w-full items-center justify-between gap-3 rounded-lg border border-p01-cyan bg-p01-cyan/10 p-3 text-left"
                        : "flex w-full items-center justify-between gap-3 rounded-lg border border-p01-border bg-p01-void p-3 text-left hover:border-p01-border-hover disabled:opacity-50"
                    }
                  >
                    <div className="min-w-0">
                      <p
                        className={
                          active
                            ? "font-mono text-sm text-p01-cyan"
                            : "font-mono text-sm text-p01-text"
                        }
                      >
                        {n.denomination} {n.token}
                      </p>
                      <p className="truncate font-mono text-xs text-p01-text-muted">
                        leaf #{n.leafIndex} · {truncate(n.commitment, 6, 4)}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* What subscribing costs. Everything in this box is a statement about
          the deployed program, cited, because every line of it is a surprise. */}
      <div className="rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
        <p className="font-medium">Devnet. The whole note is escrowed, and none of it comes back</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-p01-red/90">
          <li>
            <strong>The vault is funded with the entire note denomination</strong>, not with rate ×
            the number of periods you want. `subscribe_private_stark.rs:185` sets{" "}
            <code className="font-mono">amount = pool.denomination</code>. A 10 SOL note buys a
            10 SOL subscription.
            {service && note && periods !== null && !tokenMismatch && (
              <>
                {" "}
                This pairing escrows {note.denomination} {note.token} and funds{" "}
                {periods.toString()} {formatInterval(service.intervalSlots)} period
                {periods === 1n ? "" : "s"} at {formatServicePrice(service)} each.
              </>
            )}
          </li>
          <li>
            <strong>There is no cancel and no refund.</strong> `claim_period` is the only
            instruction that can close a vault, and on the final claim every remaining lamport —
            leftover balance, dust, and the vault&apos;s own rent — is moved to the merchant
            (`claim_period.rs:309-315`).
          </li>
          <li>
            On top of the denomination the wallet signs one pre-fund of roughly 1 SOL: rent for the
            two proof buffers (returned when they close) plus about 0.006 SOL of nullifier rent and
            transaction fees that is not returned. Same float as a withdrawal — this instruction
            requires the same C1 and C3 proofs.
          </li>
          <li>
            The subscription is unlinkable to your wallet only to the extent the pool is. Read the
            Pool tab&apos;s disclosure: the note commitment is published in the clear by the
            deposit, so treat the spend as matchable to it.
          </li>
        </ul>
      </div>

      {error && (
        <p className="flex items-start gap-1.5 text-sm text-p01-red">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}

      {blockedReason && !result && (
        <p className="text-center text-xs text-p01-text-muted">{blockedReason}</p>
      )}

      <button
        type="button"
        onClick={handleSubscribe}
        disabled={busy || !!blockedReason}
        className="btn-primary flex w-full items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Subscribing…
          </>
        ) : service && note ? (
          <>
            Escrow {note.denomination} {note.token} with {service.name}
          </>
        ) : (
          <>Subscribe</>
        )}
      </button>

      {step && (
        <p className="text-center text-xs text-p01-text-dim">
          {step}
          <br />
          <span className="text-p01-text-muted">
            Two proofs are uploaded in ~140 KB chunks. This takes a few minutes. Keep this tab open.
          </span>
        </p>
      )}

      {/* Outcome — the license key is the product of this whole flow. */}
      {result && (
        <div className="card p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-p01-cyan" />
            <p className="font-display text-sm text-p01-text">Your license key</p>
          </div>

          <p className="mt-3 break-all font-mono text-xl leading-relaxed text-p01-cyan">
            {result.licenseKey}
          </p>

          <button
            onClick={() => void copyKey(result.licenseKey)}
            className="btn-secondary mt-3 inline-flex items-center gap-2 px-4 py-2 text-xs"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy key"}
          </button>

          <p className="mt-3 text-xs text-p01-text-muted">
            This key is derived from the note secret you just spent, scoped to this service — so any
            device holding that note secret re-derives the same key, and you never have to store it.
            It is still a bearer credential: anyone you show it to can present it to the merchant as
            you.
          </p>

          <p className="mt-2 font-mono text-xs text-p01-text-dim">
            vault{" "}
            {truncate(
              typeof result.vaultPDA === "string" ? result.vaultPDA : result.vaultPDA.toBase58(),
              6,
              4,
            )}
          </p>

          <a
            href={`https://explorer.solana.com/tx/${result.txSig}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block font-mono text-xs text-p01-cyan hover:underline"
          >
            {truncate(result.txSig, 10, 8)} ↗
          </a>
        </div>
      )}
    </div>
  );
}
