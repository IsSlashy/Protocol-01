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
import { fetchFunderPubkey, funderConfigured } from '@/lib/privacy/pool/ephemeralFunder';
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
import StaleWorkerNotice from './StaleWorkerNotice';
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
   * Who paid for the job, and therefore whether this wallet is on chain.
   *
   * Optional so an older caller still typechecks, and the panel treats a missing
   * value as `'wallet'` — the pessimistic reading. Assuming the private outcome
   * from an absent field is how a page ends up telling someone their wallet is
   * off chain when it is not.
   */
  fundedBy?: 'wallet' | 'funder';
  /**
   * True when the note spent was deposited by THIS wallet, or when its deposit
   * could not be found. Either way the subscription is reachable from the buyer
   * in one hop through the deposit, whoever paid for the subscription itself.
   *
   * Optional, and absent is treated as TRUE — the pessimistic reading. Assuming
   * the good case from a missing field is how a page ends up telling someone
   * they are unreachable when they are one `getTransaction` away.
   */
  reachableViaDeposit?: boolean;
  /** Who paid for that deposit, base58; `null` = not found in the scanned window. */
  depositPayer?: string | null;
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
      const msg = (e as Error).message || 'Pool scan failed.';
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
   * ⛔ THERE IS NO SETTING. Subscribing here either keeps the buyer off chain or
   * does not happen.
   *
   * This used to be a checkbox, on by default, that a user could untick. That
   * was wrong and the founder was right to call it: a property the user can
   * turn off is not a property of the system, it is a preference — and this
   * application exists for exactly one thing, which is that a subscription
   * cannot be walked back to whoever bought it. Offering to sell the same thing
   * without it makes the guarantee unstatable, because no observer of a
   * finished subscription can tell which mode produced it.
   *
   * It also put the decision in the worst possible place: in front of someone
   * mid-purchase, phrased in terms of rotated tickets and drained treasuries,
   * choosing between two outcomes they cannot evaluate.
   *
   * The cost is real and accepted: when the funder cannot serve, or the only
   * note available is one this wallet deposited, the subscription STOPS. It
   * does not quietly become the public kind. Nothing is spent when it stops.
   */
  const NEVER_EXPOSE_WALLET = true as const;

/**
 * Whether this screen offers the deployment's pre-deposited inventory.
 *
 * `false` since 2026-08-18. A claim code buys one note out of that inventory,
 * and it made sense while a buyer arrived holding nothing and had no way to
 * deposit for themselves. The flow now is: connect the extension, shield a
 * note, subscribe. A buyer who has done that never touches issuance, and one
 * who has not is better told to shield than handed a field for a code they
 * have no way to obtain.
 *
 * Everything behind it is intact — `/api/issue-note`, `requestIssuedNote`,
 * the `claimCode` state and the self-deposit swap path — because a stocked
 * deployment serving a buyer who holds nothing is still a real configuration.
 * Turning it back on is this one boolean.
 */
const ISSUANCE_UI = false;
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
    ? `The note scanner only lists SOL pool notes today, so a ${token} subscription cannot be funded from this panel.`
    : !signOne
      ? 'This wallet cannot sign transactions.'
      : !service
        ? 'Choose a vendor first.'
        : tokenMismatch
          ? `${service.name} prices in a different token than the ${token} pool, so a ${token} note cannot fund it.`
          : !note && unspent.length > 0
            ? 'Now choose a note to lock.'
            : periods !== null && periods === 0n
              ? 'This note is smaller than one billing period, so it would fund nothing.'
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
          'You hold no note and this deployment does not issue them, so there is nothing to ' +
            'subscribe with. Nothing was spent. Shield a note in the Pool tab first — and note ' +
            'that a note you deposit yourself keeps every subscription reachable from your ' +
            'wallet.',
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

    /**
     * Swap in a note this deployment deposited, and say so.
     *
     * Reached when the note the user holds turns out to trace back to their own
     * wallet — which cannot be known before `prepare` walks the deposit. The
     * alternative is to stop and tell them to go and get a different note,
     * which is a correct refusal and a useless product: they came to subscribe,
     * not to learn why a note they own is the wrong kind of note.
     */
    async function swapForIssuedNote(): Promise<PoolNoteView | null> {
      const issuable = await shieldClient.fetchIssuableNote();
      if (!issuable) return null;
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
      return issued.note;
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
            'The deployment issued you a note, and then refused it — it could not establish who ' +
              'deposited it, and an unknown depositor is treated as you. Your note is safe and is ' +
              'in your notes list; your claim code is spent and was not wasted on a second copy. ' +
              'This is a fault in the deposit lookup, not in your note.',
          );
        }
        setStep('This note traces back to you — fetching one that does not...');
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
          // The issuer refused (402 without a claim, 409 on a spent one, rate
          // limit, whatever it was). Its reason is kept verbatim at the end
          // because a 3am debugger needs it, but it is attributed to the issuer
          // rather than phrased as the buyer's next step: the buyer never asked
          // to be issued anything, they asked to spend the note they hold.
          throw new Error(
            'The only note you hold was deposited by your own wallet, so spending it would let ' +
              'anyone reading the subscription reach you through that deposit. This deployment ' +
              'could not hand you a different one, so nothing was spent and no subscription was ' +
              'opened. Only a note somebody else deposited can buy this privately. The issuer ' +
              'gave this reason: ' +
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
      // catches up, which takes minutes: another ~1 SOL of buffer rent and
      // ~150 uploads to reach a nullifier collision.
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
                          {/* 🚨 THIS BADGE IS SELF-ISSUED AND MUST SAY SO.
                              Measured on devnet 2026-08-13: the registry holds
                              six listings and all six carry the SAME owner —
                              ours. The attestation is minted by the same key
                              that registers the listing, so a bare checkmark
                              reads as third-party vetting that nobody
                              performed. The tooltip carries the truth so the
                              badge cannot be quoted as more than it is; when a
                              listing is registered by someone we did not
                              control, this comment and that wording are what
                              need revisiting. */}
                          {s.verified ? (
                            <span
                              title="Listed by Styx Protocol. This badge is issued by the same key that registered the listing — it is not an independent audit or a vetting of the merchant."
                              className="inline-flex shrink-0 items-center gap-1 text-p01-cyan"
                            >
                              <BadgeCheck className="h-3.5 w-3.5 shrink-0" />
                              <span className="text-[10px] uppercase tracking-wider">
                                Self-listed
                              </span>
                            </span>
                          ) : (
                            <span
                              title="Registered by a third party, with no attestation from Styx Protocol."
                              className="shrink-0 rounded border border-p01-yellow/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-p01-yellow"
                            >
                              Third-party
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

          {checkingOlderNotes && (
            <p className="mt-2 text-xs text-p01-text-dim">
              Still checking for older notes — anything found will be added here.
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

        {/* Rendered while the answer is unknown as well as when it is yes,
            because the guard is ON in both of those states and a protection
            that is acting must be visible. It disappears only once the server
            has confirmed there is no funder — at which point the line below
            says so instead. */}
        {!result && funderFromServer === false && !funderConfigured() && (
          <p className="flex items-start gap-2 rounded-lg border border-p01-border p-3 text-xs text-p01-text-muted">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
            <span>
              <strong className="text-p01-text">This deployment has no funder.</strong> Your wallet
              is the only thing that can pay for this subscription, so it will sign a public
              transfer and anyone reading the subscription reaches it in three steps. There is no
              setting that changes that here.
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

            What replaces it is not a quieter default. It is that the private
            outcome is the only one on offer: when it cannot be delivered the
            subscription stops, and nothing is spent. */}
        {!result && (funderAvailable || funderFromServer === null) && (
          <p className="flex items-start gap-2 rounded-lg border border-p01-border p-3 text-xs text-p01-text-muted">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-cyan" />
            <span>
              <strong className="text-p01-text">Your wallet will not pay for this.</strong> That is
              how subscriptions work here, not a setting: the funder covers the rent and fees, and
              the note is one this deployment deposited rather than one that names you. If either
              cannot be delivered — funder unreachable, rate limited, switched off, or the only
              note you hold is one you deposited yourself — this{' '}
              <strong className="text-p01-text">stops without subscribing</strong>. Nothing is
              spent when it stops.
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
              <strong className="text-p01-text">You hold no note, so one will be issued to you.</strong>{' '}
              It was deposited by this deployment, not by you — which is what keeps anyone reading
              the subscription from reaching your wallet through the deposit. It does{' '}
              <strong className="text-p01-text">not</strong> hide you from this deployment: the note
              comes from a seed we hold, so we can recognise every subscription bought with it, and
              we could spend it ourselves until you do. Deposit your own note instead if you would
              rather that trade went the other way.
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
        {ISSUANCE_UI && !result && !holdsNote && !!issuableNote && (
          <div className="space-y-1">
            <input
              value={claimCode}
              onChange={(e) => setClaimCode(e.target.value)}
              placeholder="Claim code"
              spellCheck={false}
              className="w-full rounded-lg border border-p01-border bg-p01-void px-3 py-2 font-mono text-xs text-p01-text placeholder:text-p01-text-dim"
            />
            <p className="text-xs text-p01-text-dim">
              A note is real money, so one is issued per claim and a claim is created when a
              payment settles. It is consumed the first time it is redeemed — if something fails
              after that, recover the note rather than redeeming again.
            </p>
          </div>
        )}
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
              {/* The third fact, and the one nothing else on this screen tells
                them: whether their wallet is in the transaction history.

                🚨 THIS USED TO SAY "your address is in none of these
                transactions" ON THE FUNDER BRANCH, AND THAT WAS FALSE. It is
                true only of the subscription's own transactions. The note being
                spent here was created by a DEPOSIT that the wallet signed and
                paid for — `shieldToPool` has no funder path at all — and this
                subscription republishes, in cleartext, the same commitment that
                deposit published. So the walk is: this transaction → the
                commitment → the deposit that emitted it → the wallet that paid
                for the deposit. Funding the spend leg does not touch a single
                step of that.

                It also used to credit probe P6. P6 fails on ANY named
                counterparty (`verify/p01-verify.mjs:1219-1237`), so the funder
                changes the name in the edge and leaves the edge, the measure,
                and the red verdict exactly where they were. */}
              {/* The deposit half, which decides whether the payment half
                  matters at all. Rendered FIRST and unconditionally when it is
                  bad: a reader who sees "your wallet did not pay" and stops
                  there has been told the smaller true thing and missed the
                  larger one. Absent field reads as reachable — the pessimistic
                  default, because the alternative is claiming safety from a
                  value that was never sent. */}
              {result.reachableViaDeposit !== false && (
                <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
                  <span>
                    <strong className="text-p01-text">
                      {result.depositPayer
                        ? 'This note was deposited by your own wallet.'
                        : 'This note’s deposit could not be found.'}
                    </strong>{' '}
                    Spending it republished that deposit’s identifier in the clear, so anyone
                    reading this subscription reaches{' '}
                    {result.depositPayer ? 'your wallet' : 'whoever made that deposit'} in one hop
                    through the deposit —{' '}
                    <strong className="text-p01-text">whoever paid for the subscription</strong>.
                    To avoid it, spend a note somebody else deposited.
                  </span>
                </p>
              )}
              {result.fundedBy === 'funder' ? (
                <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-cyan" />
                  <span>
                    <strong className="text-p01-text">
                      Your wallet did not sign or pay for this subscription.
                    </strong>{' '}
                    The funder covered the rent and fees and the leftover went back to it, not to
                    you.{' '}
                    {/* This half USED to be written flat, asserting a self-deposit as a fact of
                        the product. It was, back when every note in the pool was one the buyer
                        had shielded themselves. It stopped being true the day a third party
                        could deposit the note — and MEASURED: run `4zWERbE1NPaR…`, whose
                        guard had already set `reachableViaDeposit: false`, still read this
                        sentence and told a clean subscription it reached the buyer's wallet.
                        A false RED on the one screen whose job is to be believed. Same field
                        the paragraph above reads, so the two can no longer disagree. */}
                    {result.reachableViaDeposit !== false ? (
                      <>
                        Two things that does not do: the deposit that created this note was signed
                        and paid for by your wallet, and this subscription publishes the same note
                        identifier that deposit did — so anyone can still walk from here to that
                        deposit and reach your wallet. And the funder saw the request, its timing
                        and where it came from, so the link moved off the chain rather than away.
                      </>
                    ) : (
                      <>
                        Somebody else deposited this note, so the walk this subscription still
                        opens — it publishes that deposit's identifier in the clear — ends at
                        their payer and not at you. What is left is off the chain, not on it: the
                        funder saw the request, its timing and where it came from, and whoever
                        deposited the note knows which note they handed you. The link moved off
                        the chain rather than away.
                      </>
                    )}
                  </span>
                </p>
              ) : (
                <p className="flex items-start gap-2 text-xs text-p01-text-muted">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-p01-yellow" />
                  <span>
                    <strong className="text-p01-text">Your wallet paid for this, in public.</strong>{' '}
                    It signed a transfer to the signing key before, and got the leftover back after.
                    Both are ordinary transfers naming your address, so anyone reading this
                    subscription reaches your wallet in three steps.
                  </span>
                </p>
              )}
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
