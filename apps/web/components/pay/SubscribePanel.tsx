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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
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
import { fetchFunderPubkey, funderConfigured } from '@/lib/privacy/pool/ephemeralFunder';
import type { PoolToken } from '@/lib/privacy/pool/denominatedPool';
import { SUBSCRIBE_FLOAT_SOL } from '@/lib/privacy/pool/subscribeFloat';
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
import { clearBearerNow, copyBearerAndScheduleClear } from '@/lib/pay/bearerClipboard';
import { recordSubscription } from '@/lib/pay/subscriptions';
import FlowProgress from './FlowProgress';
import StaleWorkerNotice from './StaleWorkerNotice';
import SuccessBurst from './SuccessBurst';
import NoteTag from './NoteTag';
import ChainIdsReveal from './ChainIdsReveal';
import { truncate } from './util';
import { useT } from '@/i18n';
import { translateInterval } from "@/lib/pay/intervalLabel";

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
  /**
   * Refuse the subscription rather than pay for it from this wallet.
   *
   * The fallback it disables is the only remaining way a buyer lands on chain
   * once the notes are deposited by someone else and the funder pays: every
   * reason the funder does not serve arrives as one `catch`, and the fallback
   * then SUCCEEDS. The subscription exists, nothing errors, and the wallet is
   * `accountKeys[0]` of a public transfer that brackets the whole operation.
   */
  neverExposeWallet?: boolean;
}

export interface SubscribeFromPoolResult {
  txSig: string;
  /** Typed loosely on purpose: the brief named the field, not its type. */
  vaultPDA: PublicKey | string;
  licenseKey: string;
  /**
   * The derivation `licenseKey` was minted under. Optional so an older caller
   * still typechecks; a missing value is read as 'v1', which is what a worker
   * that does not report one minted.
   */
  licenseScheme?: 'v1' | 'v2';
  /**
   * Who paid for the job, and therefore whether this wallet is on chain.
   *
   * Optional so an older caller still typechecks, and the panel treats a missing
   * value as `'wallet'` — the pessimistic reading. Assuming the private outcome
   * from an absent field is how a page ends up telling someone their wallet is
   * off chain when it is not.
   */
  fundedBy?: 'wallet' | 'funder';
  /**
   * True unless the note spent is known to be RECEIVED (filed by an import on
   * this device). An own deposit, or a note of unknown origin, keeps the
   * subscription reachable from the buyer through the deposit, whoever paid for
   * the subscription itself. Decided with no RPC (`selfDepositedNote.test.ts`,
   * "deposit verdict local and pessimistic").
   *
   * Optional, and absent is treated as TRUE — the pessimistic reading. Assuming
   * the good case from a missing field is how a page ends up telling someone
   * they are unreachable when they are one `getTransaction` away.
   */
  reachableViaDeposit?: boolean;
  /**
   * True when the address that PAID for this subscription is co-named with this
   * wallet on chain, or when that could not be established.
   *
   * The other half of the same walk. A run can be clean on the deposit leg and
   * reachable on this one — the shape measured on 2026-08-18 — so a screen that
   * renders only the deposit half tells the buyer a true sentence that reads as
   * the opposite of the truth.
   *
   * Optional, and absent is treated as TRUE, for the same reason as above.
   */
  reachableViaSpendFunder?: boolean;
  /** Where the spent note came from, decided on this device; see `reachableViaDeposit`. */
  noteProvenance?: 'own-deposit' | 'received' | 'unknown';
  /**
   * The circuit the subscription opened on, as `subscribeFromPool` reports it
   * (`shieldClient.ts`, `version: prep.version`). `'v3'` is the C1 + C3 pair a
   * pre-blinding note is confirmed onto; its opening transaction republishes
   * the note's commitment.
   *
   * Optional so an older caller still typechecks, and ABSENT IS NEVER READ AS
   * `'v4'`: the card's test is positive, as in PoolPanel, so a result that
   * names no circuit cannot earn the sentence that says no commitment was
   * published (`SubscribePanel.test.tsx`, "a result that reports no circuit is
   * never read as circuit 7").
   */
  version?: 'v3' | 'v4';
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

// The denomination of an issued note used to be a constant here, 0.1 SOL.
// It is now ASKED of the deployment (`fetchIssuableNote`), because leaf indices
// only mean something inside one pool: a treasury that deposited into the 1 SOL
// pool was simply unreachable, and the symptom was "the configured inventory
// does not match the chain" — correct, and indistinguishable from a derivation
// bug.

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
  const t = useT();
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
          <span>{t('pay.subscribe.costSummary')}</span>
          <span className="shrink-0 font-mono text-[10px] text-p01-red/60 group-open:hidden">
            {t('pay.subscribe.costRead')}
          </span>
        </span>
      </summary>
      <ul className="list-disc space-y-1 px-3 pb-3 pl-7 text-p01-red/90">
        <li>
          <strong>{t('pay.subscribe.costWholeNoteLead')}</strong>
          {t('pay.subscribe.costWholeNote')}{' '}
          <span className="font-mono text-p01-red/70">
            {t('pay.subscribe.costWholeNoteCite')}
          </span>
        </li>
        <li>
          <strong>{t('pay.subscribe.costNoRefundLead')}</strong>
          {t('pay.subscribe.costNoRefund')}{' '}
          <span className="font-mono text-p01-red/70">{t('pay.subscribe.costNoRefundCite')}</span>
        </li>
        {/* 🚨 THIS SAID "your wallet signs one deposit of roughly 1 SOL to hold
            space for the two proofs" UNCONDITIONALLY, and the result screen at
            the bottom of this same file says "Your wallet did not sign or pay
            for this subscription" when the funder serves — which it does:
            /api/fund-ephemeral answers ready:true in production.

            ⛔ THE FALSE ONE WAS THE ONE READ BEFORE SIGNING. This component is
            static by design (see CostDisclosure's header), so it cannot branch
            on an outcome that does not exist yet — the honest fix is to state
            BOTH shapes and say which decides, not to pick the scarier one and
            call that caution. A disclosure that overstates the cost is not
            "safe": it teaches the reader that this panel's numbers are
            approximate, and the two sentences above it are not. */}
        {/* 🚨 THE FIGURE IS NOT TYPED HERE, AND THAT IS THE FIX.

            This said "roughly 1 SOL is locked to hold space for the two proofs
            — the same pair a withdrawal needs", and both halves were wrong on
            the route this app takes. Circuit 7 rents ONE buffer, so the float
            is a little over half what the sentence promised, and the pair it
            named stopped being what a withdrawal uses on
            2026-08-26. A literal in JSX has nothing to disagree with, which is
            why it went stale silently while `subscribeEphemeral.ts` priced the
            real thing correctly all along.

            ⛔ Overstating a cost is NOT the safe direction. It teaches the
            reader that this panel's numbers are approximate, and the two
            sentences above it — the whole note is spent, there is no refund —
            are not.

            `SUBSCRIBE_FLOAT_SOL` is `subscribeFloorLamports(...)`, the same
            function `prepareSubscribeJobV4` prices its transfer with. Pinned by
            `lib/privacy/pool/subscribeFloat.test.ts` (the arithmetic against the
            job's own execution) and `__tests__/pages/PayAppCopy.test.tsx` (that
            this paragraph interpolates it instead of carrying digits). */}
        {/* The two figures are still INTERPOLATED, not typed: `SUBSCRIBE_FLOAT_SOL`
            is `subscribeFloorLamports(...)`, the same function
            `prepareSubscribeJobV4` prices its transfer with, and a literal in
            the dictionary would go stale silently exactly as the one in this
            JSX did. The sentence is split into three keys around them for the
            same reason. */}
        <li>
          {t('pay.subscribe.costRentPart1')}
          {SUBSCRIBE_FLOAT_SOL.c7}
          {t('pay.subscribe.costRentPart2')}
          {SUBSCRIBE_FLOAT_SOL.pair}
          {t('pay.subscribe.costRentPart3')}
        </li>
        <li>{t('pay.subscribe.costCommitment')}</li>
      </ul>
    </details>
  );
}

/**
 * The license key of a just-opened subscription, behind one click.
 *
 * Web sweep 4, round 1, item 1. Two things travel with this string, and only
 * one of them is obvious:
 *
 *   1. it is a bearer credential — whoever holds it presents it as you;
 *   2. it NAMES the vault. The vault's on-chain `license_commitment` is a hash
 *      of the key's secret, so the vault is found from the key alone (a memcmp,
 *      `packages/merchant-sdk/src/merchant-license.ts`), and the vault's opening
 *      transaction is the spend of the note that paid: the nullifier, the fee
 *      payer, and on the C1 + C3 path the note's commitment.
 *
 * Printed by default, a screenshot, a screen share or a support ticket carried
 * that whole walk — the same one `ChainIdsReveal` hides two blocks below, on the
 * same card. So it is rendered the way `SubscriptionsPanel` already renders a
 * re-derived key: after a click. Closed means NOT IN THE DOM, so a copy of the
 * page has no window of it (`__tests__/components/SubscribePanel.test.tsx`,
 * "keeps the license key off the card until asked", "copies the key without ever
 * printing it").
 */
function LicenseKeyReveal({ licenseKey }: { licenseKey: string }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return shown ? (
    <>
      <p className="mt-2 break-all font-mono text-xl leading-relaxed text-p01-cyan">
        {licenseKey}
      </p>
      <button
        type="button"
        onClick={() => setShown(false)}
        className="mt-2 text-xs text-p01-text-muted underline hover:text-p01-cyan"
      >
        {t('pay.subs.keyHide')}
      </button>
    </>
  ) : (
    <>
      <p className="mt-2 text-xs text-p01-text-dim">{t('pay.subscribe.keyHidden')}</p>
      <button
        type="button"
        onClick={() => setShown(true)}
        className="mt-1 text-xs text-p01-cyan underline hover:text-p01-text"
      >
        {t('pay.subs.keyReveal')}
      </button>
    </>
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
  /* Every sentence in this panel used to be English written into the JSX,
     on a site that serves French by country. They are `pay.subscribe.*`
     now; see the block header in i18n/en.ts for why. */
  const t = useT();
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
        setRegistryError((e as Error).message || t('pay.subscribe.errRegistry'));
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
  /** True from the first partial scan result until the scan settles: the list
   *  came from the fast blinded pass while the legacy epoch search — the only
   *  pass that can find pre-2026-07-25 notes — is still running. The picker
   *  must say so rather than present the list as complete. */
  const [checkingOlderNotes, setCheckingOlderNotes] = useState(false);
  const [selectedNote, setSelectedNote] = useState<string | null>(null);

  const rescan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    // Whether the scan's fast pass painted anything before a failure — decides
    // what the error message below must admit about the list on screen.
    let paintedFromPartialScan = false;
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
      // MERGED, not assigned: the read is async now (encrypted store, worker
      // opens it), and a plain set could race the subscribe handler's write.
      void shieldClient
        .resolveSpentNotes(meta, owner.toBase58())
        .then(() => shieldClient.knownSpentNoteKeys(meta, owner.toBase58()))
        .then((res) => {
          setSpentHere((prev) => new Set([...prev, ...res.keys]));
          setStaleWorker((prev) => prev || res.staleWorker);
          setLostSession((prev) => prev || res.lostSession);
        })
        .catch(() => {});
      // SECOND PAINT, chain-read: the scan streams the blinded pass's results
      // while the legacy epoch search (~41 s of CPU per derivation) still
      // runs — same pattern as PoolPanel. `checkingOlderNotes` keeps the
      // early paint honest.
      const res = await shieldClient.scanPool(meta, 'SOL', setScanStep, (partial) => {
        paintedFromPartialScan = true;
        setCheckingOlderNotes(true);
        setNotes(shieldClient.mergeScanWithLocal(partial.notes, localNotes));
      });
      // MERGE, not replace: a RECEIVED note's secrets came from the sender's
      // seed, so the seed-deriving chain scan can never return it; replacing
      // wholesale dropped it from this picker the moment the slow scan landed.
      setNotes(shieldClient.mergeScanWithLocal(res.notes, localNotes));
    } catch (e) {
      const msg = (e as Error).message || t('pay.subscribe.errScan');
      // A partial paint followed by a failure leaves a real but possibly
      // incomplete list on screen — the error must say so, not less.
      setScanError(
        paintedFromPartialScan
          ? msg +
              ' The notes shown are from an unfinished scan and older notes may be missing — rescan to finish the check.'
          : msg,
      );
    } finally {
      setScanning(false);
      setScanStep(null);
      setCheckingOlderNotes(false);
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
  /**
   * The swap's spend when it failed after its withdrawal landed: under the
   * error line behind the reveal, and only while the line still shows that
   * error (SubscribePanel.test.tsx, "the swap that spent but did not collect
   * says so without quoting the spend").
   */
  const [errorSpend, setErrorSpend] = useState<{ message: string; sig: string } | null>(null);
  /**
   * Whether a reachable buyer REFUSES the purchase, or completes it and says so.
   *
   * `false` since 2026-08-19, founder's call, and the reasoning is not the one
   * this comment used to argue against.
   *
   * The paragraph below is kept because it is still right about the thing it
   * was written for: a per-user checkbox mid-purchase was a bad idea, and a
   * property a user unticks is a preference, not a property. That is not what
   * this constant is any more. It is a deployment-level decision about what to
   * do when the walk succeeds, and there are only two honest answers — refuse,
   * or complete and disclose. It never was, and is not now, a switch that makes
   * the linkage go away.
   *
   * 🚨 WHY REFUSING TURNED OUT TO BE THE WORSE ANSWER, MEASURED.
   *
   * Refusing bought no privacy. The walk it refuses on — deposit → ephemeral
   * → funder → wallet — is a few chain reads for anyone, and it stays that
   * whether or not this screen sells anything. What refusing actually
   * did was close the product: the one flow the connect screen documents
   * (connect, shield a note, subscribe) makes the buyer the depositor, so the
   * guard fires on it every time, and `ISSUANCE_UI` had closed the only other
   * door. Both paths shut, and the disclosure that would have told the truth
   * never rendered because nothing ever completed.
   *
   * ✅ SO THE GUARD STAYS AND ONLY ITS VERDICT CHANGES. Both legs are still
   * answered and ride back on the result as `reachableViaDeposit` and
   * `reachableViaSpendFunder`: the deposit leg from where this device says the
   * note came from, with no RPC, and the spend leg by a check that starts in
   * the click beside the prepare (`selfDepositedNote.test.ts`). The panel renders them
   * with an absent field reading as REACHABLE — pessimistic — so a run that
   * could not establish an origin says the buyer is reachable rather than
   * staying quiet. That is the shape a false green would need to defeat, and it
   * is why flipping this is not the same as switching the check off.
   *
   * ⚠️ What this costs, stated plainly: a subscription bought from a note the
   * buyer deposited themselves IS walkable back to them. The screen says so at
   * the end. Unlinkability is a property of the note's origin, and the only
   * thing that gives it is a note somebody else deposited — pre-deposited
   * inventory, which is why `ISSUANCE_UI` is back on directly below.
   */
  const NEVER_EXPOSE_WALLET = false as const;

/**
 * Whether this screen offers the deployment's pre-deposited inventory.
 *
 * `true` again since 2026-08-19. It was turned off on 2026-08-18 with the
 * reasoning that a buyer now shields their own note, so nobody needs a claim
 * code — which was true about mechanics and wrong about the property. A note
 * you deposit yourself is exactly the note that keeps the subscription walkable
 * back to you; see NEVER_EXPOSE_WALLET above. Pre-deposited inventory is not a
 * fallback for buyers who arrived empty-handed, it is THE path that makes the
 * purchase unlinkable, and closing it left the product with no unlinkable path
 * at all.
 *
 * Nothing behind it had to be rebuilt — `/api/issue-note`, `requestIssuedNote`,
 * the `claimCode` state and the self-deposit swap path were all left intact on
 * purpose. Turning it back on is this one boolean.
 */
const ISSUANCE_UI = true;
  /**
   * Whether a funder exists, ASKED OF THE SERVER rather than of the bundle.
   *
   * `NEXT_PUBLIC_P01_FUNDER_TICKET` is inlined at BUILD time, so a deployment
   * that switched its funder on without rebuilding reports `false` from the
   * bundle while the server says yes. Nothing gates on the answer arriving —
   * the guarantee is unconditional — but the screen can say what is going on.
   */
  const [funderFromServer, setFunderFromServer] = useState<boolean | null>(null);
  /**
   * The issuer's own statement about what an issued note does and does not hide.
   *
   * Held and rendered verbatim rather than summarised: the endpoint says it can
   * regenerate every value the note will publish and can spend the note itself
   * until the recipient does. Paraphrasing that is how it becomes "it's private".
   */
  const [issuedDisclosure, setIssuedDisclosure] = useState<string | null>(null);
  /** The claim redeemed for a note. Held here, never persisted: it is worth one
   *  note and consumed on first redemption, so storing it would keep a spent
   *  bearer value around and invite a retry that cannot work. */
  const [claimCode, setClaimCode] = useState('');
  /**
   * What this deployment issues, ASKED ON MOUNT rather than only at click time.
   *
   * `undefined` = the server has not answered yet, `null` = it stocks nothing.
   * Never load-bearing for money: `handleSubscribe` asks again at click time,
   * because the answer is the server's and can change in between. This copy
   * exists so the screen can stop putting the issuance path in front of a buyer
   * it does not apply to.
   */
  const [issuableNote, setIssuableNote] = useState<
    { denomination: number; token: PoolToken } | null | undefined
  >(undefined);
  useEffect(() => {
    let live = true;
    void shieldClient
      .fetchIssuableNote()
      .then((iss) => {
        if (live) setIssuableNote(iss);
      })
      .catch(() => {
        // Pessimistic on purpose: a deployment we could not ask is treated as
        // one that issues nothing, so the screen points at the Pool tab instead
        // of showing a claim-code field whose every redemption would 402.
        if (live) setIssuableNote(null);
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    void fetchFunderPubkey().then((pk) => {
      if (live) setFunderFromServer(pk !== null);
    });
    return () => {
      live = false;
    };
  }, []);
  const funderAvailable = useMemo(
    () => funderConfigured() || funderFromServer === true,
    [funderFromServer],
  );
  // No stand-down path. A deployment with no funder cannot sell a private
  // subscription, so it does not sell one — it says so, and the button is
  // blocked, rather than quietly serving the public kind under the same name.
  const [result, setResult] = useState<SubscribeFromPoolResult | null>(null);
  const [copied, setCopied] = useState(false);
  /** Cancels the pending clipboard clear (see `copyKey`). */
  const cancelClipboardClear = useRef<null | (() => void)>(null);
  useEffect(() => () => cancelClipboardClear.current?.(), []);

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
  // A version-skewed worker left `spentHere` or `handedOver` SHORT (see
  // StaleWorkerNotice): the picker may then offer a note already spent or
  // already promised away — and a subscription can never be cancelled, so
  // locking such a note in is the costliest place to be wrong. Latched with
  // `|| next` since several async reads feed it; reset on a wallet switch.
  const [staleWorker, setStaleWorker] = useState(false);
  // Same symptom, different cure: the worker RESTARTED and lost the seeds
  // mid-session — healed by signing again, not by a reload, so the reload
  // line must never claim it. Latched and reset exactly like `staleWorker`.
  const [lostSession, setLostSession] = useState(false);
  useEffect(() => {
    // Async read (encrypted store), with a stale guard so a slow answer never
    // paints one wallet's spends onto another after a switch.
    setSpentHere(new Set());
    setStaleWorker(false);
    setLostSession(false);
    let stale = false;
    void shieldClient
      .knownSpentNoteKeys(meta, owner.toBase58())
      .then((res) => {
        if (!stale) {
          setSpentHere(res.keys);
          setStaleWorker((prev) => prev || res.staleWorker);
          setLostSession((prev) => prev || res.lostSession);
        }
      })
      .catch(() => {});
    setHandedOver(new Set());
    const readHandoffs = () => {
      void handoffKeys(meta, owner.toBase58())
        .then((res) => {
          if (!stale) {
            setHandedOver(res.keys);
            setStaleWorker((prev) => prev || res.staleWorker);
            setLostSession((prev) => prev || res.lostSession);
          }
        })
        .catch(() => {});
    };
    readHandoffs();
    window.addEventListener(HANDOFFS_CHANGED_EVENT, readHandoffs);
    return () => {
      stale = true;
      window.removeEventListener(HANDOFFS_CHANGED_EVENT, readHandoffs);
    };
  }, [meta, owner]);
  const unspent = useMemo(
    () =>
      notes.filter(
        (n) => !n.spent && !spentHere.has(noteKey(n)) && !handedOver.has(noteKey(n))
      ),
    [notes, spentHere, handedOver]
  );
  /**
   * Does this identity already hold something spendable?
   *
   * 🚨 THE CLAIM CODE IS ABOUT THE OTHER CASE, AND ONLY THE OTHER CASE.
   * `/api/issue-note` hands out the deployment's PRE-DEPOSITED inventory and a
   * claim is what pays for one — none of which concerns a buyer who already
   * shielded a note of their own. Reported 2026-08-18, one wallet: "la page
   * subscribe demande toujours un code claim alors que tout se déroulera
   * automatiquement avec un seul wallet". They were right; the issuance path was
   * standing in front of a buyer who did not need it.
   *
   * Derived from `unspent` — the very list the picker renders — so the field
   * and the picker can never disagree about whether a note is held.
   */
  const holdsNote = unspent.length > 0;
  const services = registry?.services ?? [];
  const service = services.find((s) => s.pda.toBase58() === selectedPda) ?? null;
  const note = unspent.find((n) => noteKey(n) === selectedNote) ?? null;

  const decimals = decimalsForPoolToken(token);
  const tokenMismatch = service ? !pricedInPoolToken(service, token) : false;
  const periods =
    service && note ? periodsFunded(note.denomination, decimals, service.priceAtomic) : null;

  const usdcUnsupported = token !== 'SOL';
  const blockedReason = usdcUnsupported
    ? t('pay.subscribe.errUsdcUnsupported').replaceAll('{token}', token)
    : !signOne
      ? t('pay.subscribe.errCannotSign')
      : !service
        ? t('pay.subscribe.errPickService')
        : tokenMismatch
          ? t('pay.subscribe.errTokenMismatch')
              .replace('{vendor}', service.name)
              .replaceAll('{token}', token)
          : !note && unspent.length > 0
            ? t('pay.subscribe.errPickNote')
            : periods !== null && periods === 0n
              ? t('pay.subscribe.errTooSmall')
              : null;

  async function handleSubscribe() {
    if (!signOne || !service) return;

    // ── The note, fetched rather than demanded ────────────────────────────
    //
    // A note the buyer deposited themselves links every subscription bought
    // with it back to them in one hop through the deposit, whoever pays for the
    // subscription. So the buyer has to spend one somebody ELSE deposited — and
    // the honest way to get there used to be a two-wallet ritual: shield from
    // A, seal to B, import into B, subscribe from B.
    //
    // Nobody opens a second Phantom to buy a subscription. They click once, and
    // if the click does not work they leave. So when this identity holds no
    // note, the deployment issues one and the user never sees a step: the part
    // that has to be true — the depositor is not the buyer — becomes true by
    // construction instead of by them having followed instructions.
    //
    // ⛔ NO FALLBACK. If the issuer cannot serve, this stops. Quietly reverting
    // to "subscribe with whatever note you have" would deliver the linked
    // outcome the whole mechanism exists to avoid, and the user would have no
    // way to tell — which is precisely the mistake already made once with the
    // funder's fallback.
    let spending = note;
    /**
     * Did THIS click already redeem the claim code?
     *
     * 🚨 A claim is worth one note and is consumed on first redemption whether
     * or not a note is delivered. The recovery path below re-sends the same code
     * to fetch a "different" note, which is doubly wrong once this branch has
     * run: the code is already spent, so the request comes back 409 and the
     * user is told "No note was issued: this claim code has already been used"
     * — about a note that WAS issued and is sitting in their store.
     *
     * MEASURED 2026-08-18: the claim counter reached 2 on a single click, twice
     * in one evening, and the 409 masked a successful issuance both times.
     */
    let issuedThisClick = false;
    if (!spending) {
      // Ask the deployment what it issues rather than assuming: leaf indices
      // only mean something inside one pool, so a hard-coded denomination makes
      // every treasury that chose another one unreachable.
      const issuable = await shieldClient.fetchIssuableNote();
      if (!issuable) {
        // The instruction has to be an instruction. This used to end on "Deposit
        // a note", which reads as the same dead end the screen had just put the
        // user in — and the field above it was asking for a claim code, so the
        // only actionable-looking thing on screen was a bearer value no buyer
        // can mint for themselves. The route that exists from here is the Pool
        // tab, and the caveat about a self-deposited note stays word for word:
        // it is the difference between subscribing and subscribing privately.
        setIssuableNote(null);
        setError(
          t('pay.subscribe.errNoIssuance'),
        );
        return;
      }
      // Check affordability BEFORE redeeming, because a claim is consumed on
      // first redemption whether or not the subscription follows. The rendered
      // `blockedReason` cannot cover this: it computes periods from the selected
      // note, and there is no note yet — so with none held the button is
      // enabled and nothing else stands between a click and a note spent on a
      // subscription that funds zero periods.
      const issuedPeriods = periodsFunded(
        issuable.denomination,
        decimalsForPoolToken(issuable.token),
        service.priceAtomic,
      );
      if (issuedPeriods === 0n) {
        setError(
          `${service.name} costs more per period than the ${issuable.denomination} ` +
            `${issuable.token} note this deployment issues, so it would fund nothing. Nothing was ` +
            `spent. Choose a vendor priced under ${issuable.denomination} ${issuable.token}.`,
        );
        return;
      }
      setError(null);
      setSubmitting(true);
      try {
        const issued = await shieldClient.requestIssuedNote({
          meta,
          walletPubkey: owner.toBase58(),
          token: issuable.token,
          denomination: issuable.denomination,
          claimCode: claimCode.trim(),
          onProgress: setStep,
        });
        setIssuedDisclosure(issued.disclosure);
        setNotes((prev) => [...prev, issued.note]);
        setSelectedNote(noteKey(issued.note));
        spending = issued.note;
        issuedThisClick = true;
      } catch (e) {
        setError((e as Error).message || 'No note could be issued.');
        return;
      } finally {
        setSubmitting(false);
        setStep(null);
      }
    }

    let note_ = spending;
    if (!note_) return;
    const call = subscribeModule.subscribeFromPool;
    /** The note the refusal below is about, captured for the swap's closure:
     *  the narrowing on `note_` does not survive into a nested function. */
    const heldNote: PoolNoteView = note_;
    const signOneForSwap = signOne;

    /**
     * Exchange the held note for one this deployment deposited, and say so.
     *
     * Reached when the note the user holds turns out to trace back to their own
     * wallet — which cannot be known before `prepare` walks the deposit. The
     * alternative is to stop and tell them to go and get a different note,
     * which is a correct refusal and a useless product: they came to subscribe,
     * not to learn why a note they own is the wrong kind of note.
     *
     * Since 2026-09-02 this is the NOTE-IN EXCHANGE, not a claim-code redeem:
     * `exchangeNoteForIssued` spends the held note to the deployment's till on
     * circuit 7 (the pool's 0.5 percent withdrawal fee is the cost), the
     * withdrawal itself is the payment, and the claim it buys is redeemed for
     * an older note the treasury deposited. The old path sent an empty claim
     * code and got 402 every time (measured 2026-08-28).
     *
     * Returns null on exactly one condition, unchanged: the deployment stocks
     * nothing, checked BEFORE anything is spent.
     */
    async function swapForIssuedNote(): Promise<PoolNoteView | null> {
      const issuable = await shieldClient.fetchIssuableNote();
      if (!issuable) return null;
      const exchanged = await shieldClient.exchangeNoteForIssued({
        meta,
        token: heldNote.token,
        denomination: heldNote.denomination,
        leafIndex: heldNote.leafIndex,
        pool: heldNote.pool,
        owner,
        encryptedNotes: await shieldClient.loadEncryptedNotes(meta, owner.toBase58()),
        connection,
        signOne: signOneForSwap,
        onProgress: setStep,
      });
      // The held note is spent: it paid the till. Off every picker now, or the
      // list keeps offering it until the pool scan catches up.
      setSpentHere((prev) => new Set(prev).add(noteKey(heldNote)));
      setIssuedDisclosure(exchanged.issued.disclosure);
      setNotes((prev) => [...prev, exchanged.issued.note]);
      setSelectedNote(noteKey(exchanged.issued.note));
      return exchanged.issued.note;
    }
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
      // 🚨 THE NOTE THE USER HOLDS MAY BE THE WRONG KIND, AND ONLY `prepare`
      // CAN SAY SO. Spending a note whose deposit traces back to this wallet
      // republishes that deposit's identifier, so the subscription is walkable
      // to the buyer no matter who pays the fees — and nothing in the picker
      // distinguishes such a note from any other.
      //
      // Refusing there would be correct and useless: the user came to
      // subscribe, not to learn why a note they own is the wrong kind. So the
      // note is swapped for one this deployment deposited, ONCE, and the
      // attempt continues. If that cannot be done the error explains which of
      // the two things was missing rather than repeating the refusal.
      try {
        const probe = await call({
          meta,
          token,
          denomination: note_.denomination,
          leafIndex: note_.leafIndex,
          retailer: service.retailer,
          rate: service.priceAtomic,
          intervalSlots: service.intervalSlots,
          serviceId: licenseServiceTag(service.slug, service.retailer.toBase58()),
          owner,
          encryptedNotes: await shieldClient.loadEncryptedNotes(meta, owner.toBase58()),
          connection,
          signOne,
          onProgress: setStep,
          neverExposeWallet: NEVER_EXPOSE_WALLET,
        });
        // It went through on the held note: that note was not this wallet's.
        setResult(probe);
        await shieldClient.recordSpentNote(meta, owner.toBase58(), noteKey(note_));
        setSpentHere((prev) => new Set(prev).add(noteKey(note_)));
        await recordSubscription(meta, owner.toBase58(), {
          vaultPDA: typeof probe.vaultPDA === 'string' ? probe.vaultPDA : probe.vaultPDA.toBase58(),
          retailer: service.retailer.toBase58(),
          serviceTag: licenseServiceTag(service.slug, service.retailer.toBase58()),
          serviceName: service.name,
          token: note_.token,
          denomination: note_.denomination,
          rate: service.priceAtomic.toString(),
          intervalSlots: service.intervalSlots.toString(),
          openTxSig: probe.txSig,
          pool: note_.pool,
          leafIndex: note_.leafIndex,
          openedAt: Date.now(),
          licenseScheme: probe.licenseScheme ?? 'v1',
        });
        void rescan();
        return;
      } catch (e) {
        if ((e as Error).name !== 'SelfDepositedNoteError') throw e;
        // ⛔ NOTHING TO SWAP TO. The note that was just refused IS the one this
        // deployment issued seconds ago, so asking for another cannot change the
        // answer — and the claim that would pay for it is already spent. Say what
        // actually happened instead of burning the code to rediscover it.
        if (issuedThisClick) {
          throw new Error(
            'The deployment issued you a note, and then refused it — this device did not file it ' +
              'as received, and a note not filed as received is treated as your own deposit. Your ' +
              'note is safe and is in your notes list; your claim code is spent and was not wasted ' +
              'on a second copy. This is a fault in how the note was filed, not in your note.',
          );
        }
        setStep(t('pay.subscribe.stepSwapping'));
        // 🚨 EVERY REFUSAL BELOW REACHES A BUYER WHO HOLDS A NOTE, so none of
        // them may end on "get a claim code". The swap is OUR attempt to rescue
        // THEIR note; its failures are ours to report, not chores to hand back.
        //
        // The old tail was worse than untimely, it was false: `swapForIssuedNote`
        // returns null on exactly one condition — `fetchIssuableNote()` said this
        // deployment stocks nothing — and no claim code opens a deployment with
        // no inventory. It told the user the one thing that could not help.
        let swapped: PoolNoteView | null;
        try {
          swapped = await swapForIssuedNote();
        } catch (swapErr) {
          // Two very different situations, and the message must say which.
          // Before the withdrawal landed nothing moved. After it, the held
          // note is spent and the till is paid: the receipt is on this device
          // and the Pool tab's next Shield click resumes collecting the note.
          // The deployment's reason is kept verbatim at the end because a 3am
          // debugger needs it, attributed to the deployment rather than
          // phrased as the buyer's next step.
          // The spend's signature is not quoted, even where the deployment's
          // reason quotes it: it leads back to the note it spent, and a support
          // ticket is where this sentence goes. It rides on the error to the
          // reveal under the error line (SubscribePanel.test.tsx, "the swap that
          // spent but did not collect says so without quoting the spend").
          const spendSig = (swapErr as { spendSig?: string }).spendSig;
          if (spendSig) {
            setSpentHere((prev) => new Set(prev).add(noteKey(heldNote)));
            throw Object.assign(
              new Error(
                'The only note you hold was deposited by your own wallet, so it was exchanged: ' +
                  'the withdrawal paid the deployment and the note it bought has not been ' +
                  'collected yet. No subscription was opened. The receipt is kept on this device; ' +
                  'open the Shield tab and click Shield to finish collecting the note, then ' +
                  'subscribe with it. The deployment said: ' +
                  ((swapErr as Error).message || 'nothing.').split(spendSig).join('(signature hidden)'),
              ),
              { spendSig },
            );
          }
          throw new Error(
            'The only note you hold was deposited by your own wallet, so spending it would let ' +
              'anyone reading the subscription reach you through that deposit. This deployment ' +
              'could not exchange it for a different one, so nothing was spent and no ' +
              'subscription was opened. Only a note somebody else deposited can buy this ' +
              'privately. The deployment gave this reason: ' +
              ((swapErr as Error).message || 'none.'),
          );
        }
        if (!swapped) {
          throw new Error(
            'The only note you hold was deposited by your own wallet, so spending it would let ' +
              'anyone reading the subscription reach you through that deposit — and this ' +
              'deployment issues no notes at all, so there is nothing to swap it for. Nothing ' +
              'was spent. Only a note somebody else deposited can buy this privately.',
          );
        }
        note_ = swapped;
      }

      const out = await call({
        meta,
        token,
        denomination: note_.denomination,
        leafIndex: note_.leafIndex,
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
        encryptedNotes: await shieldClient.loadEncryptedNotes(meta, owner.toBase58()),
        connection,
        signOne,
        onProgress: setStep,
        // Default ON wherever a funder exists. Configuring one is a statement
        // that this deployment does not want buyers on chain, and honouring it
        // only when it happens to be reachable is honouring it not at all —
        // the failure is invisible to the buyer and permanent on the chain.
        // Where there is no funder there is no choice, so the flag is off and
        // the result paragraph says plainly that the wallet paid.
        // Not a setting. See NEVER_EXPOSE_WALLET.
        neverExposeWallet: NEVER_EXPOSE_WALLET,
      });
      setResult(out);
      // Subscribing SPENDS the note: its nullifier is now on chain and the
      // whole denomination is locked in the vault. Record it exactly as a
      // withdrawal does, or every list keeps offering it until the pool scan
      // catches up, which takes minutes: a second float of buffer rent and a
      // second upload to reach a nullifier collision.
      await shieldClient.recordSpentNote(meta, owner.toBase58(), noteKey(note_));
      setSpentHere((prev) => new Set(prev).add(noteKey(note_)));
      // Remember the vault locally so the Subscriptions view can list it
      // without an on-chain sweep, the same convenience `recordPayout` gives
      // withdrawals. Public fields only: the license key is re-derivable from
      // the note secret, is never stored, and `recordSubscription` would drop
      // it anyway.
      await recordSubscription(meta, owner.toBase58(), {
        vaultPDA: typeof out.vaultPDA === 'string' ? out.vaultPDA : out.vaultPDA.toBase58(),
        retailer: service.retailer.toBase58(),
        serviceTag: licenseServiceTag(service.slug, service.retailer.toBase58()),
        serviceName: service.name,
        token: note_.token,
        denomination: note_.denomination,
        rate: service.priceAtomic.toString(),
        intervalSlots: service.intervalSlots.toString(),
        openTxSig: out.txSig,
        pool: note_.pool,
        leafIndex: note_.leafIndex,
        openedAt: Date.now(),
        // Which derivation the key above came from, so Reveal starts from the
        // right hint. The chain check re-verifies it either way.
        licenseScheme: out.licenseScheme ?? 'v1',
      });
      void rescan();
    } catch (e) {
      const message = (e as Error).message || 'Subscription failed.';
      setError(message);
      // Only the swap's after-spend error carries one (see `errorSpend`).
      const spendSig = (e as { spendSig?: string }).spendSig;
      setErrorSpend(spendSig ? { message, sig: spendSig } : null);
    } finally {
      setSubmitting(false);
      setStep(null);
    }
  }

  /**
   * The clipboard holds a credential, so it does not hold it for long.
   *
   * Web sweep 4 round 1, item 24 (ledger row D8). Windows keeps a clipboard
   * history on disk and phones sync it between devices, so a license key copied
   * and never taken back outlives the tab — and this key both works as the
   * buyer and names the vault. `copyBearerAndScheduleClear` empties it after
   * BEARER_CLIPBOARD_CLEAR_MS, and only after reading the clipboard and finding
   * this exact string still on it, never blindly. The button beside Copy does it
   * from a click, which is what a browser that refuses the read accepts.
   */
  function copyKey(key: string) {
    cancelClipboardClear.current?.();
    cancelClipboardClear.current = copyBearerAndScheduleClear(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function clearClipboardNow() {
    cancelClipboardClear.current?.();
    cancelClipboardClear.current = null;
    void clearBearerNow();
    setCopied(false);
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
              <p className="font-display text-sm text-p01-text">
                {t('pay.subscribe.vendorTitle')}
              </p>
            </div>
            <button
              onClick={() => void loadVendors(true)}
              disabled={registryLoading || submitting}
              className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
            >
              <RefreshCw className={registryLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
              {registryLoading ? t('pay.subscribe.reading') : t('pay.subscribe.refresh')}
            </button>
          </div>

          {registryError && (
            <div className="mt-3 rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
              <p className="font-medium">{t('pay.subscribe.registryErrorTitle')}</p>
              <p className="mt-1 text-p01-red/90">{registryError}</p>
              <p className="mt-1 text-p01-red/90">{t('pay.subscribe.registryErrorBody')}</p>
            </div>
          )}

          {!registryError && registry && registry.matchedAccounts === 0 && (
            <p className="mt-3 text-xs text-p01-text-muted">
              {t('pay.subscribe.registryEmpty')}
            </p>
          )}

          {!registryError && registry && registry.decodeFailures > 0 && (
            <p className="mt-3 text-xs text-p01-yellow">
              {t('pay.subscribe.registryUndecoded')
                .replace('{failed}', String(registry.decodeFailures))
                .replace('{total}', String(registry.matchedAccounts))}
            </p>
          )}

          {registryLoading && !registry && (
            <p className="mt-3 text-xs text-p01-text-dim">
              {t('pay.subscribe.registryLoading')}
            </p>
          )}

          {/* ⚠️ A GRID OF CARDS, NOT A LIST OF ROWS, AND FOUR THINGS LESS.
              Each row printed five things: name, a badge with an icon, the
              category, the on-chain SLUG, the price and the interval. The slug
              (`bitwarden-testloop`) is a machine identifier nobody chooses a
              subscription by; the badge, drawn on all six because all six carry
              the same owner, read as decoration rather than as the caveat it
              is. What a person picks by is the name and the price, so those are
              the card, and the price is set in the serif at the size of a
              headline rather than as an eighth line of small mono.

              🚨 THE SELF-LISTED CAVEAT IS NOT DROPPED, IT IS PUT WHERE IT CAN
              BE READ. The comment this replaces is explicit that a bare
              checkmark "reads as third-party vetting that nobody performed",
              and that the tooltip is what stops it. It stays a word with the
              same tooltip, in mono under the category, at the weight of a
              footnote — visible on every card, quotable as nothing more. */}
          {services.length > 0 && (
            <ul className="styx-vendor-grid">
              {services.map((s) => {
                const payable = pricedInPoolToken(s, token);
                const active = s.pda.toBase58() === selectedPda;
                return (
                  <li key={s.pda.toBase58()}>
                    <button
                      onClick={() => setSelectedPda(s.pda.toBase58())}
                      disabled={submitting || !payable}
                      className="styx-vendor"
                      data-active={active}
                    >
                      <span className="styx-vendor-name">{s.name}</span>
                      <span className="styx-vendor-price">
                        {formatServicePrice(s)}
                        <i>{translateInterval(formatInterval(s.intervalSlots), t)}</i>
                      </span>
                      <span className="styx-vendor-meta">
                        {s.category || t('pay.subscribe.uncategorised')}
                        {s.verified ? (
                          <em title={t('pay.subscribe.badgeSelfListedTitle')}>
                            {t('pay.subscribe.badgeSelfListed')}
                          </em>
                        ) : (
                          <em
                            data-third-party="true"
                            title={t('pay.subscribe.badgeThirdPartyTitle')}
                          >
                            {t('pay.subscribe.badgeThirdParty')}
                          </em>
                        )}
                      </span>
                      {!payable && (
                        <span className="styx-vendor-blocked">
                          {t('pay.subscribe.notPayable').replace('{token}', token)}
                        </span>
                      )}
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
              <p className="font-display text-sm text-p01-text">
                {t('pay.subscribe.noteTitle')}
              </p>
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

          {checkingOlderNotes && (
            <p className="mt-2 text-xs text-p01-text-dim">
              {t('pay.subscribe.checkingOlder')}
            </p>
          )}
          {scanStep && <p className="mt-2 text-xs text-p01-text-dim">{scanStep}</p>}
          {scanError && <p className="mt-2 text-sm text-p01-red">{scanError}</p>}

          {/* Skew or a lost session blunts the spent/handed-over FILTERS, so
              a note below may already be gone or promised away — the worst
              place to find out is after locking it into an uncancellable
              vault. Say the right cure here; skew wins when both latched
              (the reload forces the signing gate anyway). */}
          {(staleWorker || lostSession) && (
            <div className="mt-2">
              <StaleWorkerNotice lostSession={lostSession && !staleWorker} />
            </div>
          )}

          {usdcUnsupported && (
            <p className="mt-2 text-xs text-p01-yellow">
              {t('pay.subscribe.solOnly').replace('{token}', token)}
            </p>
          )}

          {!scanning && unspent.length === 0 && !scanError && (
            <p className="mt-2 text-xs text-p01-text-muted">
              {t('pay.subscribe.empty')}
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
                        {/* Second plane: the note's own name, its tag. Not its
                            leaf and commitment, which the deposit published
                            (UI-1, noteIdentifierTripwire.test.ts; SubscribePanel.test.tsx,
                            "the picker renders the same rows when only the leaves
                            and commitments differ"). */}
                        <p className="mt-0.5">
                          <NoteTag tag={n.tag} />
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
            {/* `formatInterval` answers in English ("monthly"); its answer is
                mapped onto a dictionary key at the point of display. See
                lib/pay/intervalLabel.ts. */}
            {t('pay.subscribe.dealLock')}{' '}
            <span className="font-mono text-p01-cyan">
              {note.denomination} {note.token}
            </span>
            {t('pay.subscribe.dealCharges').replace('{vendor}', service.name)}{' '}
            <span className="font-mono text-p01-cyan">{formatServicePrice(service)}</span>{' '}
            {translateInterval(formatInterval(service.intervalSlots), t)}
            {t('pay.subscribe.dealSoPays')}{' '}
            <span className="font-mono text-p01-cyan">{periods.toString()}</span>{' '}
            {periods === 1n
              ? t('pay.subscribe.dealPeriods')
              : t('pay.subscribe.dealPeriodsPlural')}
            {t('pay.subscribe.dealEnds')}
          </div>
        )}

        {/* The two hard sentences, in the field of vision at the moment of
          click no matter where the full terms box has scrolled to. This is a
          deliberate repetition of CostDisclosure, ruled by the founder:
          redundancy over elegance, and never softened. */}
        <div className="rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
          <p>
            <strong>{t('pay.subscribe.hardWholeNote')}</strong>
            {note
              ? t('pay.subscribe.hardAllOfIt').replace(
                  '{amount}',
                  `${note.denomination} ${note.token}`,
                )
              : t('pay.subscribe.hardNotJust')}
            , <strong>{t('pay.subscribe.hardNoRefund')}</strong>
            {t('pay.subscribe.hardTail')}
          </p>
        </div>

        {/* Rendered while the answer is unknown as well as when it is yes,
            because the guard is ON in both of those states and a protection
            that is acting must be visible. It disappears only once the server
            has confirmed there is no funder — at which point the line below
            says so instead. */}
        {!result && funderFromServer === false && !funderConfigured() && (
          <p className="flex items-start gap-2 rounded-lg border border-p01-border p-3 text-xs text-p01-text-muted">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
            <span>
              <strong className="text-p01-text">{t('pay.subscribe.noFunderLead')}</strong>
              {t('pay.subscribe.noFunderBody')}
            </span>
          </p>
        )}
        {/* There was a checkbox here — "Never pay for this from my wallet",
            on by default, unticked at will. It is gone.

            A property the user can turn off is not a property of the system.
            It also made the guarantee unstatable: no observer of a finished
            subscription can tell which mode produced it, so "subscriptions here
            cannot be walked back to the buyer" stopped being a sentence anybody
            could say. And it put the decision in front of someone mid-purchase,
            phrased in terms of rotated tickets and drained treasuries, choosing
            between two outcomes they had no way to evaluate.

            🚨 AND THEN THIS PARAGRAPH OUTLIVED THE BEHAVIOUR IT DESCRIBED.
            It promised, in the present tense, that the wallet does not pay and
            that the purchase STOPS when the private outcome cannot be
            delivered. Both stopped being true on 2026-08-19, when
            `NEVER_EXPOSE_WALLET` went false: `fundEphemeralForJob` now falls
            back to the wallet instead of throwing, and a self-deposited note is
            spent instead of refused. The screen kept saying "stops without
            subscribing" over code that subscribes.
            ⛔ A promise the code does not keep is worse than no promise: it is
            the false green this repository keeps auditing out of its own docs,
            restated in the product. So the copy now describes the mechanism —
            who pays, and what happens when the funder cannot — and claims
            nothing about stopping. */}
        {!result && (funderAvailable || funderFromServer === null) && (
          <p className="flex items-start gap-2 rounded-lg border border-p01-border p-3 text-xs text-p01-text-muted">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-cyan" />
            <span>
              <strong className="text-p01-text">{t('pay.subscribe.funderLead')}</strong>
              {t('pay.subscribe.funderBody')}
            </span>
          </p>
        )}

        {/* When this identity holds no note, one is issued and the user never
            sees a step. That is the point — and it is exactly why the trade has
            to be stated rather than left implicit. Verbatim from the issuer, so
            what the server says it can do is what the screen says it can do. */}
        {/* Not `unspent.length === 0` any more, because that was also true of a
            deployment that issues nothing — and then this paragraph promised a
            note nobody was going to hand over. Kept on screen while the server
            has not answered yet: the sentence is a WARNING about what an issued
            note fails to hide, so the pessimistic reading is to show it. It goes
            away only once the deployment has said it stocks nothing, at which
            point the picker's "Shield one in the Pool tab first" is the true
            instruction and this one would be a lie. */}
        {ISSUANCE_UI && !result && !holdsNote && issuableNote !== null && (
          <p className="flex items-start gap-2 rounded-lg border border-p01-border p-3 text-xs text-p01-text-muted">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-cyan" />
            <span>
              <strong className="text-p01-text">{t('pay.subscribe.issuedLead')}</strong>
              {t('pay.subscribe.issuedBody1')}
              <strong className="text-p01-text">{t('pay.subscribe.issuedNot')}</strong>
              {t('pay.subscribe.issuedBody2')}
            </span>
          </p>
        )}
        {/* 🚨 THIS FIELD BELONGS TO THE ISSUANCE PATH AND NOWHERE ELSE.
            A claim buys ONE note out of this deployment's pre-deposited
            inventory; a buyer who already shielded a note never touches
            /api/issue-note, so showing them this asks for a bearer value they
            have no way to mint, to buy something they do not need. That is the
            2026-08-18 report, one wallet, note already shielded. Gated on
            `holdsNote` — the picker's own list — and on the deployment having
            answered that it actually stocks something, since a code redeemed
            against empty inventory is a 402 either way.

            Nothing here is removed: the plumbing, the endpoint and the
            `claimCode` state are untouched, and a buyer who holds nothing on a
            stocked deployment gets exactly the field they got before. */}
        {/* ⛔ THE CLAIM-CODE FIELD IS NOT ON THIS SCREEN ANY MORE.
            It bought one note out of the deployment's pre-deposited inventory,
            and it made sense while a buyer arrived holding nothing and could
            not deposit for themselves. The flow now is: connect the extension,
            shield a note, subscribe — a buyer who has done that never touches
            issuance, and one who has not is better told to shield than handed
            a field for a code they have no way to obtain.
            `/api/issue-note`, `requestIssuedNote`, `claimCode` and the swap
            path are all untouched behind this: a stocked deployment can still
            serve a buyer who holds nothing, and re-showing this input is one
            boolean. */}
        {/* The same warning for the buyer who ALREADY holds a note and is
            swapping it. Their trade is different from the one above and the
            sentence has to say so: they are giving up a note whose deposit is
            joined to their own payment, and taking one that is joined to
            nobody — at the price of the deployment knowing both halves. */}
        {ISSUANCE_UI && !result && holdsNote && !!issuableNote && (
          <p className="flex items-start gap-2 rounded-lg border border-p01-border p-3 text-xs text-p01-text-muted">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-cyan" />
            <span>
              <strong className="text-p01-text">{t('pay.subscribe.swapLead')}</strong>{' '}
              Your own deposit is joined to the moment you paid — measured at under a minute, and
              permanent. The note you get back was deposited long before you arrived, so nothing
              on chain ties it to you. It does{' '}
              <strong className="text-p01-text">not</strong> hide you from this deployment: we
              hold the seed, so we can recognise every subscription bought with it.
            </span>
          </p>
        )}
        {/* 🚨 `!holdsNote` WAS HERE AND IT KILLED THE SWAP PATH.
            MEASURED 2026-08-28: `swapForIssuedNote` sends `claimCode.trim()`,
            but this input only rendered for a buyer holding NOTHING — so on
            the swap the field never existed, the code was always the empty
            string, and the issuer answered 402 'a paid claim code is
            required'. The whole point of the swap is that a buyer who HOLDS a
            note exchanges it for a mature one, so gating the field on holding
            none made the feature unreachable by construction.
            ⚠️ The gate that belongs here is inventory, not possession. */}
        {/* ⛔ THE CLAIM-CODE FIELD IS GONE, AND NOTHING REPLACES IT.
            It asked a buyer to paste a bearer value they had no way to obtain,
            to buy something the shield now hands them automatically. Since the
            contribution flow landed, a shield funds a leaf the treasury owns and
            collects a DIFFERENT note in the same click — and if the worker goes
            quiet partway, `resumeContribution` finishes it on the next click
            WITHOUT charging again. By the time anyone reaches this screen they
            already hold the note they will spend.

            The plumbing behind it is untouched: `/api/issue-note`,
            `requestIssuedNote` and the `claimCode` state all still work, and a
            deployment that wants to sell a note to someone holding nothing can
            re-show one input. What is removed is the ASK. */}
        {issuedDisclosure && !result && (
          <p className="rounded-lg border border-p01-border p-3 font-mono text-[11px] text-p01-text-dim">
            {issuedDisclosure}
          </p>
        )}

        {error && (
          <p className="flex items-start gap-1.5 text-sm text-p01-red">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        )}
        {/* The swap's spend, for support, behind a click (see `errorSpend`). */}
        {error && errorSpend && errorSpend.message === error && (
          <ChainIdsReveal key={errorSpend.sig}>
            <a
              href={`https://explorer.solana.com/tx/${errorSpend.sig}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              className="inline-block font-mono text-xs text-p01-cyan hover:underline"
            >
              {truncate(errorSpend.sig, 10, 8)} ↗
            </a>
          </ChainIdsReveal>
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
              {t('pay.subscribe.lockButton')
                .replace('{amount}', `${note.denomination} ${note.token}`)
                .replace('{vendor}', service.name)}
            </>
          ) : (
            <>{t('pay.subscribe.subscribeButton')}</>
          )}
        </button>

        {/* The longest flow in the product: ~78 chunk uploads on circuit 7, and
          ~150 across two proofs when the note falls back to the C1 + C3 pair.
          The bar moves on the worker's real steps; the raw step string stays
          visible underneath as the second-plane detail.

          🚨 The `note` below said "About 1 SOL" as a literal — the same stale
          figure as the disclosure above, in a second place, which is how one
          correction leaves the other wrong. It reads from the same constant. */}
        {submitting && (
          <>
            <FlowProgress
              phases={SUBSCRIBE_PHASES}
              step={step}
              running={submitting}
              note={
                `About ${SUBSCRIBE_FLOAT_SOL.c7} SOL sits in a refundable deposit while this ` +
                `runs, or about ${SUBSCRIBE_FLOAT_SOL.pair} if this note falls back to the ` +
                `C1 + C3 pair; it is returned when the proof buffers close.`
              }
            />
            {step && <p className="text-center font-mono text-[11px] text-p01-text-dim">{step}</p>}
          </>
        )}

        {/* Outcome. The license key is the product of this whole flow. */}
        {result && (
          <div className="card p-4">
            <SuccessBurst label={t('pay.subscribe.openLabel')} />

            <div className="mt-3 rounded-lg border border-p01-cyan/40 bg-p01-void p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-xs uppercase tracking-wider text-p01-text-muted">
                  <KeyRound className="h-3.5 w-3.5 text-p01-cyan" />{' '}
                  {t('pay.subscribe.keyLabel')}
                </p>
                <button
                  onClick={() => copyKey(result.licenseKey)}
                  className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? t('pay.subscribe.copied') : t('pay.subscribe.copy')}
                </button>
                {/* The clipboard is a place this key should not stay: see
                  `copyKey`. This is the version that needs no permission. */}
                <button
                  type="button"
                  onClick={clearClipboardNow}
                  className="text-xs text-p01-text-muted underline hover:text-p01-cyan"
                >
                  {t('pay.shared.clipboardClear')}
                </button>
              </div>
              {/* The key itself, behind one click (web sweep 4 round 1, item 1;
                SubscribePanel.test.tsx, "keeps the license key off the card
                until asked"). It is a bearer credential, and it also LOCATES
                the vault: the vault's on-chain license_commitment is a hash of
                the key's secret, which is how the merchant SDK finds the vault
                from the key alone. From the vault, its opening transaction is
                the spend of the note that paid — the very walk the reveal below
                exists to keep off a screenshot. Keyed on the result so a second
                subscription starts hidden again, and Copy works from state
                without ever rendering it. */}
              <LicenseKeyReveal key={result.txSig} licenseKey={result.licenseKey} />
            </div>

            {/* The two facts about this key, each on its own line so neither
              hides the other: it is never stored, and it is a bearer credential. */}
            <div className="mt-3 space-y-2">
              <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-cyan" />
                <span>
                  <strong className="text-p01-text">
                    {t('pay.subscribe.keyNeverStoredLead')}
                  </strong>
                  {t('pay.subscribe.keyNeverStoredBody')}
                </span>
              </p>
              <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
                <span>
                  <strong className="text-p01-text">{t('pay.subscribe.keyBearerLead')}</strong>
                  {t('pay.subscribe.keyBearerBody')}
                </span>
              </p>
              {result.fundedBy === 'funder' ? (
                <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-cyan" />
                  <span>
                    <strong className="text-p01-text">
                      {t('pay.subscribe.paidFunderLead')}
                    </strong>
                    {t('pay.subscribe.paidFunderBody')}
                  </span>
                </p>
              ) : (
                <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
                  <span>
                    <strong className="text-p01-text">{t('pay.subscribe.paidWalletLead')}</strong>
                    {t('pay.subscribe.paidWalletBody')}
                  </span>
                </p>
              )}
              {/* Which circuit ran. The cost box on this page promises that
                this screen names it (`pay.subscribe.costCommitment`), and the
                C1 + C3 pair republishes the note's commitment, so a card that
                read the same either way left a screenshot saying nothing about
                the one fact that lets a chain reader walk from the vault to
                the deposit. Positive test: only `'v4'` earns the circuit-7
                sentence (SubscribePanel.test.tsx, "a C1 + C3 subscription does
                not read like a circuit-7 one"). */}
              {result.version === 'v4' ? (
                <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-cyan" />
                  <span>
                    <strong className="text-p01-text">{t('pay.subscribe.ranC7Lead')}</strong>
                    {t('pay.subscribe.ranC7Body')}
                  </span>
                </p>
              ) : (
                <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
                  <span>
                    <strong className="text-p01-text">
                      {t(
                        result.version === 'v3'
                          ? 'pay.subscribe.ranPairLead'
                          : 'pay.subscribe.ranUnknownLead',
                      )}
                    </strong>
                    {t(
                      result.version === 'v3'
                        ? 'pay.subscribe.ranPairBody'
                        : 'pay.subscribe.ranUnknownBody',
                    )}
                  </span>
                </p>
              )}
            </div>

            {/* Protocol detail, second plane, and behind a click: the vault and
              the opening transaction are the spend of the note that paid, so a
              screenshot of this card must not carry them
              (SubscribePanel.test.tsx, "keeps the vault and the opening
              transaction off the card until asked"). */}
            <div className="mt-3 border-t border-p01-border pt-3">
              <ChainIdsReveal key={result.txSig}>
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
              </ChainIdsReveal>
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
