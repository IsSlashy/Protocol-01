'use client';

/**
 * SubscribePanel: pick a vendor, pick a note, subscribe, show the key.
 *
 * Same two-phase shape as every other pool operation: nothing here proves,
 * signs or sends. `subscribeFromPool` (in `lib/privacy/shieldClient.ts`) drives
 * the worker for the proving half and asks the wallet for the ONE pre-fund
 * signature; this file only chooses the inputs and renders the outcome.
 *
 * The two facts this panel exists to make un-missable, because both surprise
 * people and both are true:
 *
 *   1. Subscribing locks the WHOLE note, not `rate x periods`.
 *      `subscribe_private_stark.rs:185` sets `let amount = pool.denomination;`.
 *   2. There is no way back. `claim_period` is the only instruction that can
 *      close a vault, and on the final claim Anchor's `close` moves every
 *      remaining lamport (leftover balance, dust and the vault's own rent) to
 *      the retailer (`claim_period.rs:309-315`).
 *
 * Simplifying the vocabulary never means softening either sentence.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  BadgeCheck,
  Check,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Store,
  TriangleAlert,
} from 'lucide-react';

import * as shieldClient from '@/lib/privacy/shieldClient';
import { licenseServiceTag } from '@/lib/privacy/license';
import type { PoolToken } from '@/lib/privacy/pool/denominatedPool';
import type { PoolNoteView } from '@/lib/privacy/worker/poolHandlers';
import {
  NATIVE_SOL_SENTINEL_MINT,
  formatInterval,
  formatServicePrice,
  loadServiceRegistry,
  type RegistrySnapshot,
  type ServiceEntry,
} from '@/lib/privacy/serviceRegistry';
import { SUBSCRIBE_PHASES } from '@/lib/pay/flowProgress';
import { HANDOFFS_CHANGED_EVENT, handoffKeys } from '@/lib/pay/handoffs';
import { recordSubscription } from '@/lib/pay/subscriptions';
import FlowProgress from './FlowProgress';
import SuccessBurst from './SuccessBurst';
import { truncate } from './util';

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
  /** Note blobs from the local store. The worker uses the matching one's
   *  Merkle path, and for a RECEIVED note (secrets from the sender's seed,
   *  invisible to the seed scan) the blob is what identifies the note at all. */
  encryptedNotes?: string[];
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
  return token === 'SOL' ? 9 : 6;
}

/** A service is payable from this pool only if it prices in the same mint. */
function pricedInPoolToken(service: ServiceEntry, token: PoolToken): boolean {
  const isNative = service.tokenMint.toBase58() === NATIVE_SOL_SENTINEL_MINT;
  return token === 'SOL' ? isNative : !isNative;
}

/**
 * Periods the locked note buys: `floor(denomination / rate)`.
 *
 * This is a display of the on-chain arithmetic, not a promise: `claim_period`
 * settles `floor(elapsed / interval_slots)` periods at `rate` each until the
 * balance cannot cover another one.
 */
function periodsFunded(denomination: number, decimals: number, priceAtomic: bigint): bigint {
  if (priceAtomic <= 0n) return 0n;
  const atomic = BigInt(Math.round(denomination * 10 ** decimals));
  return atomic / priceAtomic;
}

function noteKey(n: PoolNoteView): string {
  return `${n.pool}:${n.leafIndex}`;
}

/** The numbered badge that makes the two-step journey read as one. */
function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-p01-cyan/60 font-mono text-[11px] text-p01-cyan">
      {n}
    </span>
  );
}

/**
 * What subscribing costs. Everything in this box is a statement about the
 * deployed program, cited, because every line of it is a surprise.
 *
 * Rendered twice on purpose: in the left column on wide screens so the terms
 * sit beside the action, and after the action on narrow ones so the stack
 * stays vendor, note, summary, button. The founder ruled redundancy over
 * elegance for exactly this content, and the compact reminder above the
 * button repeats the two hard sentences a third time at the moment of click.
 */
function CostDisclosure() {
  // Collapsed by default. Four paragraphs of red text is a wall the user scrolls
  // past, which is the same as not reading it, and it pushed the action out of
  // sight. The summary line stays visible at all times and carries the whole
  // point in one sentence; the detail is one click away and unchanged, word for
  // word. Nothing here is softened, only folded.
  //
  // Safe to collapse precisely because it is NOT the last word on the subject:
  // a compact red reminder of the same two facts sits directly above the Lock
  // button at every width, so the two sentences that matter are unavoidable at
  // the moment of the click.
  return (
    <details className="group rounded-lg border border-p01-red/30 bg-p01-red/5 text-xs text-p01-red">
      <summary className="cursor-pointer list-none p-3 font-medium marker:content-none">
        <span className="flex items-start justify-between gap-2">
          <span>Devnet. The whole note is locked, and none of it comes back</span>
          <span className="shrink-0 font-mono text-[10px] text-p01-red/60 group-open:hidden">
            read
          </span>
        </span>
      </summary>
      <ul className="list-disc space-y-1 px-3 pb-3 pl-7 text-p01-red/90">
        <li>
          <strong>Your entire note funds the subscription</strong>, not just rate times the number
          of periods you want. A 10 SOL note buys a 10 SOL subscription.{' '}
          <span className="font-mono text-p01-red/70">
            subscribe_private_stark.rs:185 sets amount = pool.denomination.
          </span>
        </li>
        <li>
          <strong>There is no cancel and no refund.</strong> Only the vendor collecting its periods
          can close the vault, and the final collection sweeps everything left in it (leftover
          balance, dust, and the vault&apos;s own rent) to the vendor.{' '}
          <span className="font-mono text-p01-red/70">claim_period.rs:309-315.</span>
        </li>
        <li>
          On top of the note, your wallet signs one deposit of roughly 1 SOL to hold space for the
          two proofs. It comes back when they close, minus about 0.006 SOL of fees that does not.
          Same deposit as a withdrawal: this operation needs the same two proofs.
        </li>
        <li>
          The subscription hides your wallet only as well as the pool does, which today is not at
          all: the note commitment is published in the clear by the deposit, so treat this spend as
          matchable to it. The Pool tab&apos;s disclosure has the details.
        </li>
      </ul>
    </details>
  );
}

export default function SubscribePanel({
  meta,
  owner,
  connection,
  signOne,
  token,
  onBusyChange,
}: {
  meta: string;
  owner: PublicKey;
  connection: Connection;
  signOne: ((tx: Transaction) => Promise<Transaction>) | null;
  token: PoolToken;
  /**
   * Raised while this panel is running something that locks funds or must not
   * be perceived as vanished. PayApp badges the tab with it, so a user who
   * navigates away mid-operation can find their way back instead of assuming it
   * died and starting a second one, which would lock a second proof buffer.
   */
  onBusyChange?: (busy: boolean) => void;
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
        setRegistryError((e as Error).message || 'Could not read the service registry.');
      } finally {
        setRegistryLoading(false);
      }
    },
    [connection]
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
      // These arrive with `spentKnown: false` (nothing here has seen a nullifier
      // PDA) so they are provisional until the scan below replaces them.
      let localNotes: PoolNoteView[] = [];
      try {
        const local = await shieldClient.scanPoolLocal(meta, owner.toBase58());
        if (local.notes.length > 0) {
          localNotes = local.notes;
          setNotes(local.notes);
        }
      } catch {
        // A missing or unreadable blob store is not an error worth showing:
        // the authoritative scan runs next regardless.
      }

      // Ask the chain which of these are already spent. The full pool walk would
      // answer eventually and does not finish in any time a user waits, while
      // this is one getAccountInfo per locally known note, so a note spent in an
      // earlier session or on another device drops out within seconds. It only
      // ever confirms spent, never un-spends, so a failed read leaves the note
      // exactly where it was. Fire and forget: the filter below does the rest.
      void shieldClient
        .resolveSpentNotes(meta, owner.toBase58())
        .then(() => setSpentHere(shieldClient.knownSpentNoteKeys(owner.toBase58())))
        .catch(() => {});
      const res = await shieldClient.scanPool(meta, 'SOL', setScanStep);
      // MERGE, not replace: a RECEIVED note's secrets came from the sender's
      // seed, so the seed-deriving chain scan can never return it; replacing
      // wholesale dropped it from this picker the moment the slow scan landed.
      setNotes(shieldClient.mergeScanWithLocal(res.notes, localNotes));
    } catch (e) {
      setScanError((e as Error).message || 'Pool scan failed.');
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

  // One boolean for the whole panel, derived rather than raised by hand in every
  // try/finally: a single missed exit path would leave the tab badged forever.
  // The cleanup also clears it when the panel unmounts, which is exactly the
  // case that motivated the badge, a user switching tabs mid-operation.
  const panelBusy = submitting;
  useEffect(() => {
    onBusyChange?.(panelBusy);
    return () => onBusyChange?.(false);
  }, [panelBusy, onBusyChange]);

  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubscribeFromPoolResult | null>(null);
  const [copied, setCopied] = useState(false);

  // `spent` on a locally-painted note is a default, not a reading, so also drop
  // what this browser has already withdrawn: locking a spent note into a
  // subscription vault would fail after ~150 chunk uploads.
  // State, not a memo: subscribing adds to it, and a memo keyed on `owner`
  // would not recompute after that write. The note just locked would stay
  // in the picker until a reload.
  const [spentHere, setSpentHere] = useState<ReadonlySet<string>>(new Set());
  /** Notes handed to someone and not yet claimed. Locking one into a vault
   *  would escrow a coin the recipient can still take first, and a subscription
   *  can never be cancelled or refunded once opened. */
  const [handedOver, setHandedOver] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setSpentHere(shieldClient.knownSpentNoteKeys(owner.toBase58()));
    setHandedOver(handoffKeys(owner.toBase58()));
    const catchUp = () => setHandedOver(handoffKeys(owner.toBase58()));
    window.addEventListener(HANDOFFS_CHANGED_EVENT, catchUp);
    return () => window.removeEventListener(HANDOFFS_CHANGED_EVENT, catchUp);
  }, [owner]);
  const unspent = useMemo(
    () =>
      notes.filter(
        (n) => !n.spent && !spentHere.has(noteKey(n)) && !handedOver.has(noteKey(n))
      ),
    [notes, spentHere, handedOver]
  );
  const services = registry?.services ?? [];
  const service = services.find((s) => s.pda.toBase58() === selectedPda) ?? null;
  const note = unspent.find((n) => noteKey(n) === selectedNote) ?? null;

  const decimals = decimalsForPoolToken(token);
  const tokenMismatch = service ? !pricedInPoolToken(service, token) : false;
  const periods =
    service && note ? periodsFunded(note.denomination, decimals, service.priceAtomic) : null;

  const usdcUnsupported = token !== 'SOL';
  const blockedReason = usdcUnsupported
    ? `The note scanner only lists SOL pool notes today, so a ${token} subscription cannot be funded from this panel.`
    : !signOne
      ? 'This wallet cannot sign transactions.'
      : !service
        ? 'Choose a vendor first.'
        : tokenMismatch
          ? `${service.name} prices in a different token than the ${token} pool, so a ${token} note cannot fund it.`
          : !note
            ? 'Now choose a note to lock.'
            : periods !== null && periods === 0n
              ? 'This note is smaller than one billing period, so it would fund nothing.'
              : null;

  async function handleSubscribe() {
    if (!signOne || !service || !note) return;
    const call = subscribeModule.subscribeFromPool;
    if (!call) {
      setError(
        'subscribeFromPool has not been wired into lib/privacy/shieldClient.ts yet, so nothing ' +
          'was sent. No funds moved.'
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
        // reproduces exactly what mobile posts: its subscribe screen passes
        // `serviceId: svc.slug` (streams/index.tsx:334) into the same helper
        // (streams/subscribe.tsx:405). Sending anything else here mints a key
        // no merchant will accept.
        serviceId: licenseServiceTag(service.slug, service.retailer.toBase58()),
        owner,
        // Lets the worker skip the Merkle-history rebuild for a shielded note,
        // and is the ONLY way it can find a received one.
        encryptedNotes: shieldClient.loadEncryptedNotes(owner.toBase58()),
        connection,
        signOne,
        onProgress: setStep,
      });
      setResult(out);
      // Subscribing SPENDS the note: its nullifier is now on chain and the
      // whole denomination is locked in the vault. Record it exactly as a
      // withdrawal does, or every list keeps offering it until the pool scan
      // catches up, which takes minutes: another ~1 SOL of buffer rent and
      // ~150 uploads to reach a nullifier collision.
      shieldClient.recordSpentNote(owner.toBase58(), noteKey(note));
      setSpentHere((prev) => new Set(prev).add(noteKey(note)));
      // Remember the vault locally so the Subscriptions view can list it
      // without an on-chain sweep, the same convenience `recordPayout` gives
      // withdrawals. Public fields only: the license key is re-derivable from
      // the note secret, is never stored, and `recordSubscription` would drop
      // it anyway.
      recordSubscription(owner.toBase58(), {
        vaultPDA: typeof out.vaultPDA === 'string' ? out.vaultPDA : out.vaultPDA.toBase58(),
        retailer: service.retailer.toBase58(),
        serviceTag: licenseServiceTag(service.slug, service.retailer.toBase58()),
        serviceName: service.name,
        token: note.token,
        denomination: note.denomination,
        rate: service.priceAtomic.toString(),
        intervalSlots: service.intervalSlots.toString(),
        openTxSig: out.txSig,
        pool: note.pool,
        leafIndex: note.leafIndex,
        openedAt: Date.now(),
      });
      void rescan();
    } catch (e) {
      setError((e as Error).message || 'Subscription failed.');
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

  // NOT `|| scanning`. The chain walk enumerates candidate epochs per note per
  // denomination and does not finish in any time a user will wait, so gating the
  // action on it left the button greyed out forever with a note selected and no
  // reason shown. The note list is already usable from local storage, and notes
  // this browser has spent are filtered out above; the scan only refreshes it.
  const busy = submitting;

  return (
    // Two columns from lg so the choice and its consequence sit side by side
    // and the action stays above the fold on a 1080p screen. One column below
    // lg: vendor, then note, then summary, then the button. Never a horizontal
    // scrollbar at any width.
    <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
      {/* Left column on lg: pick the vendor, full terms underneath. */}
      <div className="space-y-5">
        {/* Step 1: vendor */}
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StepBadge n={1} />
              <Store className="h-4 w-4 text-p01-cyan" />
              <p className="font-display text-sm text-p01-text">Choose a vendor</p>
            </div>
            <button
              onClick={() => void loadVendors(true)}
              disabled={registryLoading || submitting}
              className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
            >
              <RefreshCw className={registryLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              {registryLoading ? 'Reading…' : 'Refresh'}
            </button>
          </div>

          {registryError && (
            <div className="mt-3 rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
              <p className="font-medium">Could not read the vendor registry</p>
              <p className="mt-1 text-p01-red/90">{registryError}</p>
              <p className="mt-1 text-p01-red/90">
                This is a failed read, not an empty roster. Vendors are registered on chain and this
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
                          ? 'flex w-full items-center justify-between gap-3 rounded-lg border border-p01-cyan bg-p01-cyan/10 p-3 text-left'
                          : 'flex w-full items-center justify-between gap-3 rounded-lg border border-p01-border bg-p01-void p-3 text-left hover:border-p01-border-hover disabled:opacity-50'
                      }
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p
                            className={
                              active
                                ? 'truncate font-display text-sm text-p01-cyan'
                                : 'truncate font-display text-sm text-p01-text'
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
                          {s.category || 'uncategorised'} · {s.slug}
                        </p>
                        {!payable && (
                          <p className="mt-0.5 text-xs text-p01-text-dim">
                            Priced in another token, so a {token} note cannot pay for it.
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

        {/* The full terms live beside the action on lg. Below lg they render at
          the end of the stack instead (the `lg:hidden` copy), so the order
          stays vendor, note, summary, button. */}
        <div className="hidden lg:block">
          <CostDisclosure />
        </div>
      </div>

      {/* Right column on lg: pick the note, see the consequence, act. */}
      <div className="space-y-5">
        {/* Step 2: note */}
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StepBadge n={2} />
              <KeyRound className="h-4 w-4 text-p01-cyan" />
              <p className="font-display text-sm text-p01-text">Choose a note to lock</p>
            </div>
            <button
              onClick={rescan}
              disabled={scanning || submitting}
              className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
            >
              <RefreshCw className={scanning ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              {scanning ? 'Scanning…' : 'Rescan'}
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
              No unspent notes. Shield one in the Pool tab first. The note you shield is the whole
              budget of the subscription.
            </p>
          )}

          {unspent.length > 0 && (
            <ul className="mt-3 space-y-2">
              {unspent.map((n) => {
                // Key on `k`, NOT on `n.counter`: local-storage notes all carry 0,
                // so those keys collide and React may omit or duplicate rows,
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
                          ? 'flex w-full items-center justify-between gap-3 rounded-lg border border-p01-cyan bg-p01-cyan/10 p-3 text-left'
                          : 'flex w-full items-center justify-between gap-3 rounded-lg border border-p01-border bg-p01-void p-3 text-left hover:border-p01-border-hover disabled:opacity-50'
                      }
                    >
                      <div className="min-w-0">
                        <p
                          className={
                            active
                              ? 'font-mono text-sm text-p01-cyan'
                              : 'font-mono text-sm text-p01-text'
                          }
                        >
                          {n.denomination} {n.token} note
                        </p>
                        {/* Protocol detail stays available, in the second plane. */}
                        <p className="truncate font-mono text-[11px] text-p01-text-dim">
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

        {/* The plain sentence of the deal, once both halves are picked. */}
        {service && note && !tokenMismatch && periods !== null && periods > 0n && (
          <div className="rounded-lg border border-p01-cyan/40 bg-p01-cyan/5 p-3 text-sm text-p01-text">
            You lock{' '}
            <span className="font-mono text-p01-cyan">
              {note.denomination} {note.token}
            </span>
            . {service.name} charges{' '}
            <span className="font-mono text-p01-cyan">{formatServicePrice(service)}</span>{' '}
            {formatInterval(service.intervalSlots)}, so that pays for{' '}
            <span className="font-mono text-p01-cyan">{periods.toString()}</span> billing period
            {periods === 1n ? '' : 's'}. Then the subscription ends and anything left over goes to
            the vendor.
          </div>
        )}

        {/* The two hard sentences, in the field of vision at the moment of
          click no matter where the full terms box has scrolled to. This is a
          deliberate repetition of CostDisclosure, ruled by the founder:
          redundancy over elegance, and never softened. */}
        <div className="rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
          <p>
            <strong>The whole note is locked</strong>
            {note ? (
              <>
                , all {note.denomination} {note.token} of it
              </>
            ) : (
              <>, not just the periods you want</>
            )}
            , and <strong>there is no cancel and no refund</strong>: whatever is left when the
            subscription ends goes to the vendor, rent included.
          </p>
        </div>

        {error && (
          <p className="flex items-start gap-1.5 text-sm text-p01-red">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        )}

        {/* A disabled button always says why, right next to itself. */}
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
              Lock {note.denomination} {note.token} with {service.name}
            </>
          ) : (
            <>Subscribe</>
          )}
        </button>

        {/* The longest flow in the product: two proofs, two uploads, ~150
          transactions. The bar moves on the worker's real steps; the raw step
          string stays visible underneath as the second-plane detail. */}
        {submitting && (
          <>
            <FlowProgress
              phases={SUBSCRIBE_PHASES}
              step={step}
              running={submitting}
              note="About 1 SOL sits in a refundable deposit while this runs; it is returned when the proof buffers close."
            />
            {step && <p className="text-center font-mono text-[11px] text-p01-text-dim">{step}</p>}
          </>
        )}

        {/* Outcome. The license key is the product of this whole flow. */}
        {result && (
          <div className="card p-4">
            <SuccessBurst label="Subscription open" />

            <div className="mt-3 rounded-lg border border-p01-cyan/40 bg-p01-void p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-xs uppercase tracking-wider text-p01-text-muted">
                  <KeyRound className="h-3.5 w-3.5 text-p01-cyan" /> License key
                </p>
                <button
                  onClick={() => void copyKey(result.licenseKey)}
                  className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="mt-2 break-all font-mono text-xl leading-relaxed text-p01-cyan">
                {result.licenseKey}
              </p>
            </div>

            {/* The two facts about this key, each on its own line so neither
              hides the other: it is never stored, and it is a bearer credential. */}
            <div className="mt-3 space-y-2">
              <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-cyan" />
                <span>
                  <strong className="text-p01-text">Never stored, never lost.</strong> The key is
                  recomputed from the secret of the note you just spent, so any device holding that
                  note shows the same key. Nothing to back up.
                </span>
              </p>
              <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
                <span>
                  <strong className="text-p01-text">It works for whoever holds it.</strong> Anyone
                  with this key can present it to the vendor as you. Show it to the vendor and no
                  one else.
                </span>
              </p>
            </div>

            {/* Protocol detail, second plane. */}
            <div className="mt-3 border-t border-p01-border pt-3">
              <p className="font-mono text-xs text-p01-text-dim">
                vault{' '}
                {truncate(
                  typeof result.vaultPDA === 'string'
                    ? result.vaultPDA
                    : result.vaultPDA.toBase58(),
                  6,
                  4
                )}
              </p>
              <a
                href={`https://explorer.solana.com/tx/${result.txSig}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block font-mono text-xs text-p01-cyan hover:underline"
              >
                {truncate(result.txSig, 10, 8)} ↗
              </a>
            </div>
          </div>
        )}

        {/* Full terms on narrow screens, at the end of the stack (see the note
          on CostDisclosure for why the box exists twice). */}
        <div className="lg:hidden">
          <CostDisclosure />
        </div>
      </div>
    </div>
  );
}
