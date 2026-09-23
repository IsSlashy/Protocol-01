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
 * the mobile subscription-vaults -> vault-detail pair had (both screens were
 * deleted on 2026-09-23). Long strings (key, vault
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

import { useCallback, useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
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
  KEY_NOT_RECOVERABLE,
  licenseSchemeOf,
  licenseTagCandidates,
  loadSubscriptions,
  SUBSCRIPTIONS_CHANGED_EVENT,
  recordSubscription,
  recoverSubscriptions,
  SUBSCRIPTION_VAULT_DISCRIMINATOR,
  summarizeSubscription,
  symbolForVaultMint,
  toPeriodState,
  type DecodedSubscriptionVault,
  type EntitlementStatus,
  type LicenseTagListing,
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
import { clearBearerNow, copyBearerAndScheduleClear } from "@/lib/pay/bearerClipboard";
import { truncate } from "./util";
import { useT } from "@/i18n";
import { translateInterval } from "@/lib/pay/intervalLabel";

// ---------------------------------------------------------------------------

/**
 * How long a burst of `storage` / `SUBSCRIPTIONS_CHANGED_EVENT` events is
 * collected before one catch-up read runs. Short enough that a change made in
 * another tab still lands while the user is looking at the list.
 */
const CATCH_UP_MS = 50;

/**
 * The discriminator-filtered account selector for SubscriptionVault, the same
 * one `lib/privacy/pool/subscriptionRecovery.ts` builds in
 * `subscriptionVaultFilter()`. It is rebuilt here rather than imported because
 * that module is the Worker's and pulls the whole pool table with it; the
 * value it filters on is the re-exported discriminator constant, so the two
 * cannot drift on anything but the shape.
 *
 * Offset 0 and the discriminator only — never a memcmp on
 * `subscriber_commitment`, which would put a secret-derived value in the
 * request and be the very leak this read replaced. base64 because web3.js
 * accepts it and it needs no base58 dependency.
 */
function subscriptionVaultFilter(): {
  memcmp: { offset: number; bytes: string; encoding: "base64" };
} {
  return {
    memcmp: {
      offset: 0,
      bytes: Buffer.from(SUBSCRIPTION_VAULT_DISCRIMINATOR).toString("base64"),
      encoding: "base64",
    },
  };
}

type VaultLive =
  | { kind: "loading" }
  | { kind: "closed" }
  | { kind: "error"; message: string }
  | { kind: "open"; decoded: DecodedSubscriptionVault };

const STATUS_LABEL_KEY: Record<EntitlementStatus, string> = {
  current: "pay.subs.badgeActive",
  paused: "pay.subs.badgePaused",
  unknown: "pay.subs.badgeChecking",
  ended: "pay.subs.badgeEnded",
  inactive: "pay.subs.badgeInactive",
};

const STATUS_CLASS: Record<EntitlementStatus, string> = {
  current: "border-p01-cyan/50 text-p01-cyan",
  paused: "border-p01-yellow/50 text-p01-yellow",
  unknown: "border-p01-border text-p01-text-muted",
  ended: "border-p01-red/50 text-p01-red",
  inactive: "border-p01-border text-p01-text-muted",
};

function StatusBadge({ status }: { status: EntitlementStatus }) {
  const t = useT();
  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STATUS_CLASS[status]}`}
    >
      {t(STATUS_LABEL_KEY[status])}
    </span>
  );
}

function ClosedBadge() {
  const t = useT();
  return (
    <span className="shrink-0 rounded border border-p01-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-p01-text-muted">
      {t("pay.subs.badgeClosed")}
    </span>
  );
}

/**
 * Copy one string, and — when it is a CREDENTIAL — take it back off the
 * clipboard.
 *
 * Web sweep 4 round 1, item 24 (ledger row D8), the third sink. `SendForm` and
 * `SubscribePanel` were closed in round 1; this button still did a bare
 * `navigator.clipboard.writeText` and line 767 hands it the license key. That
 * key is a bearer credential AND it locates the vault — the vault's on-chain
 * `license_commitment` is a hash of the key's secret, which is how the merchant
 * SDK finds the vault from the key alone, and the vault's opening transaction is
 * the spend of the note that paid. Windows keeps a clipboard history on disk and
 * phones sync it between devices, so a key copied and never taken back outlives
 * the tab.
 *
 * ⚠️ `bearer` IS OPT-IN, AND THE VAULT ADDRESS DOES NOT SET IT. That address is
 * public, and a user copies it to paste into an explorer; emptying the clipboard
 * under them there would be a bug, not a fix. Only material that is money or a
 * password is taken back.
 *
 * The clear happens only after reading the clipboard and finding this exact
 * string still on it (`lib/pay/bearerClipboard.ts`): a blind overwrite would
 * delete whatever the person copied from another application in between. The
 * button beside Copy does it from a click, which is what a browser that refuses
 * the read accepts. Pinned by `__tests__/components/SubscriptionsPanel.test.tsx`,
 * "takes the license key back off the clipboard" and "offers a Clear the
 * clipboard button beside Copy key".
 *
 * ⚠️ THE TIMER IS NOT THIS BUTTON'S TO HOLD (sweep round 1 of logs8, fix lane
 * 2). This button is on screen only while the key is, and it used to own the
 * take-back and cancel it on unmount — so Reveal, Copy, then HIDE, the most
 * careful sequence there is, left the key on the clipboard for good, and so did
 * "All subscriptions" and picking another row. The panel owns the copy and the
 * clear now and hands them in as `bearer`; see `copyKey` there.
 */
function CopyButton({
  text,
  label,
  bearer,
}: {
  text: string;
  label: string;
  bearer?: { copy: (text: string) => void; clearNow: () => void };
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  function copy() {
    if (bearer) {
      bearer.copy(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }

  function clearNow() {
    bearer?.clearNow();
    setCopied(false);
  }

  return (
    <>
      <button
        onClick={copy}
        className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : label}
      </button>
      {bearer ? (
        <button
          type="button"
          onClick={clearNow}
          className="text-xs text-p01-text-muted underline hover:text-p01-cyan"
        >
          {t("pay.shared.clipboardClear")}
        </button>
      ) : null}
    </>
  );
}

/** The one-line, plain-words answer to "where does this subscription stand?". */
/**
 * The one-line standing, in the reader's language.
 *
 * Module-level and therefore outside the hook, so the translator is passed in
 * rather than reached for. `formatApproxDuration` still returns English ("about
 * 3 days"): it lives in lib/pay/subscriptions.ts with its own tests and takes
 * no locale, so translating it is a separate change and is NOT quietly faked
 * here.
 */
function plainStanding(
  summary: SubscriptionSummary,
  t: (key: string) => string,
): string {
  const total = summary.totalPeriods.toString();
  const left = summary.periodsRemaining.toString();
  switch (summary.status) {
    case "current":
      return summary.secondsRemaining !== null
        ? t("pay.subs.standingCurrent")
            .replace("{left}", left)
            .replace("{total}", total)
            .replace("{duration}", formatApproxDuration(summary.secondsRemaining))
        : t("pay.subs.standingCurrentNoClock")
            .replace("{left}", left)
            .replace("{total}", total);
    case "ended":
      return t("pay.subs.standingEnded").replace("{total}", total);
    case "paused":
      return t("pay.subs.standingPaused")
        .replace("{left}", left)
        .replace("{total}", total);
    case "unknown":
      return t("pay.subs.standingUnknown");
    case "inactive":
      return t("pay.subs.standingInactive");
  }
}

function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

/** Registry entry for a vault: joined on (retailer, mint), not retailer alone.
 *  A LABEL, never a key scope: one retailer may list several slugs on one
 *  mint, and only the chain check in `licenseTagCandidates` /
 *  `deriveSubscriptionLicenseKey` says which one a vault was bought under. */
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

/** The roster reduced to the strings the tag-candidate rule reads. The SOL
 *  sentinel the registry stores is the same string a SOL vault carries. */
function registryListings(services: ServiceEntry[]): LicenseTagListing[] {
  return services.map((s) => ({
    slug: s.slug,
    retailer: s.retailer.toBase58(),
    tokenMint: s.tokenMint.toBase58(),
  }));
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
  /* Every sentence in this panel used to be English written into the JSX,
     on a site that serves French by country. They are `pay.subs.*` now; see
     the block header in i18n/en.ts for why. */
  const t = useT();
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

  // Vendor roster, best effort and cached: it decorates the list with merchant
  // names and supplies the candidate slugs the Reveal path checks against the
  // vault's on-chain license fingerprint. Paused listings included: a
  // subscription bought under a slug the merchant has since paused is still
  // scoped to that slug, and a roster that dropped it would make its key
  // unrecoverable. A failed read must not block the list, so errors land in
  // nothing; Reveal then tries the stored tag and the retailer address only.
  const [services, setServices] = useState<ServiceEntry[]>([]);
  useEffect(() => {
    let dead = false;
    loadServiceRegistry(connection, { activeOnly: false })
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

  /**
   * Every live SubscriptionVault of the program, by address: THE ONLY ACCOUNT
   * READ THIS PANEL MAKES.
   *
   * One discriminator-filtered `getProgramAccounts`, the same question for
   * every user, with the lookup done here. The list took this route in sweep 1
   * (record 33, the long comment in `refresh` below); Reveal key and Track
   * still made one `getAccountInfo(vault)` each, and they take it now (sweep
   * round 1 of logs8, fix lane 2). A vault PDA is seeded on the paying note's
   * secret, so naming one says "this IP holds the key to vault V" from Reveal —
   * new to the provider for a vault recovered from another device or revealed
   * from another network — and "this IP is interested in vault V" from Track.
   * Each press still reads NOW rather than trusting the list's snapshot; it
   * just asks the uniform question. Pinned by `SubscriptionsPanel.test.tsx`,
   * "Reveal key reads the vault from a fresh enumeration, never by its address"
   * and "Track looks the pasted address up in the enumeration, never by its
   * address".
   *
   * Throws when the read fails; an address that is simply absent is not a live
   * vault of this program (closed by the final claim, owned by something else,
   * or not an account at all — one answer, which is the cost of not asking
   * about the address).
   */
  const readLiveVaults = useCallback(async (): Promise<Map<string, Uint8Array>> => {
    const accounts = await connection.getProgramAccounts(
      new PublicKey(ZK_SHIELDED_PROGRAM_ID_BASE58),
      { filters: [subscriptionVaultFilter()] },
    );
    const byPda = new Map<string, Uint8Array>();
    for (const acc of accounts) byPda.set(acc.pubkey.toBase58(), acc.account.data);
    return byPda;
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
    // ⛔ NO ROWS, NO REQUESTS (gate r1, RED 7d).
    //
    // The read below moved from one `getAccountInfo` per row to one
    // program-wide enumeration, which is right — but the per-row shape made
    // ZERO requests when there were zero rows, and the enumeration fired
    // unconditionally: on mount, and again on every coalesced storage burst.
    // This is the tab a first-time user opens, so that was a request from their
    // IP, to this deployment's provider, about the subscription program, made
    // by somebody who has no subscriptions — for an answer that cannot change
    // what is rendered. The slot read goes with it: nothing needs a clock when
    // there is nothing to date. Pinned by `SubscriptionsPanel.test.tsx`, "asks
    // the RPC nothing at all when this browser tracks no subscription", with
    // "still asks once as soon as there IS a row" beside it.
    if (recs.length === 0) {
      setLive({});
      setRefreshing(false);
      return;
    }
    try {
      const slot = await connection.getSlot("confirmed");
      setCurrentSlot(BigInt(slot));
    } catch {
      // A null slot renders "Checking", never an optimistic "Active".
      setCurrentSlot(null);
    }
    // 🚨 ONE QUESTION, AND IT IS THE SAME QUESTION FOR EVERY USER.
    //
    // This used to be `getAccountInfo(vaultPDA)` per record, on mount, on
    // every `storage` event in any tab, and again right after the recovery
    // that exists to avoid exactly this. A private vault's PDA is seeded on
    // `subscriber_commitment`, the circuit-0 commitment over the paying note's
    // secret, so that list of addresses IS this identity's subscriptions —
    // merchant, rate and interval — named together from one IP, including
    // vaults opened on another device and another network.
    //
    // `subscriptionRecovery.ts` names the pattern in its own header: "derive
    // each note's vault PDA and probe it ... is leak L4 in a new costume", and
    // it answers with a discriminator-filtered `getProgramAccounts` over every
    // SubscriptionVault of the program instead — an answer identical for every
    // user, bounded by the program's live vault count (14 on devnet), with the
    // membership decided here. The list takes the same route now
    // (`SubscriptionsPanel.test.tsx`, "names no vault PDA to the RPC").
    //
    // Cost: one request for the whole list instead of one per row, so a list of
    // two or more rows got FASTER, not slower. At one row it is a wash, and at
    // ZERO rows this function has already returned above without asking
    // anything — which the sentence here used to get wrong.
    let byPda = new Map<string, Uint8Array>();
    let enumerationError: string | null = null;
    try {
      byPda = await readLiveVaults();
    } catch (e) {
      enumerationError = (e as Error).message || "Read failed.";
    }
    const next: Record<string, VaultLive> = {};
    for (const r of recs) {
      if (enumerationError) {
        next[r.vaultPDA] = { kind: "error", message: enumerationError };
        continue;
      }
      const data = byPda.get(r.vaultPDA);
      if (!data) {
        // Not among the program's live vaults: the merchant's final claim
        // closed it. The old per-PDA read reached the same verdict through a
        // null account.
        next[r.vaultPDA] = { kind: "closed" };
        continue;
      }
      try {
        next[r.vaultPDA] = { kind: "open", decoded: decodeSubscriptionVault(data) };
      } catch (e) {
        // The discriminator matched and the body did not decode: a layout the
        // sequential decoder does not know. Said, not swallowed — a silent
        // "closed" here would read as money gone.
        next[r.vaultPDA] = { kind: "error", message: (e as Error).message || t("pay.subs.errNotProgram") };
      }
    }
    setLive(next);
    setRefreshing(false);
    // `t` is read above and deliberately absent here, as it was before this
    // change: the dictionary is picked once per session and a new identity for
    // it on every render would re-run the mount effect forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, meta, walletKey, readLiveVaults]);

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
  //
  // ⚠️ AND ONE CATCH-UP PER BURST, NOT ONE PER EVENT. `storage` fires for
  // every localStorage write in every other tab, and the app writes several in
  // a row (a subscribe records the vault, then the note, then the spent mark).
  // Each one used to become its own chain read from this IP. They are
  // collapsed into a single refresh on a short trailing timer, which is the
  // only latency this adds: at most `CATCH_UP_MS` before the list catches up
  // with a change made in another tab, and nothing at all on mount, on the
  // Refresh button, or after a recovery, which call `refresh` directly.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const catchUp = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, CATCH_UP_MS);
    };
    window.addEventListener(SUBSCRIPTIONS_CHANGED_EVENT, catchUp);
    window.addEventListener('storage', catchUp);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener(SUBSCRIPTIONS_CHANGED_EVENT, catchUp);
      window.removeEventListener('storage', catchUp);
    };
  }, [refresh]);

  // ── License key reveal (re-derived in the Worker, never stored) ──────────
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  /**
   * The vault address, the opening transaction and the vault's own fields
   * (start slot, license fingerprint) point straight at this subscription on
   * chain, so they stay off the screen until the user asks: a screenshot of the
   * detail page carries none of them (UI-1, `SubscriptionsPanel.test.tsx`,
   * "keeps the vault address and opening transaction off the screen until
   * asked"). The subscriber commitment the vault is seeded on is not shown at
   * all ("renders no subscriber commitment").
   */
  const [showIds, setShowIds] = useState(false);

  /**
   * The key on the CLIPBOARD, which outlives the key on the screen.
   *
   * Sweep round 1 of logs8, fix lane 2. The 90 s take-back used to live in the
   * copy button and die with it, and that button is on screen only while the
   * key is: Hide, "All subscriptions" and picking another row each cancelled
   * the timer and removed the Clear button in one move. Both belong to the
   * panel now.
   *
   *  - NOTHING CANCELS THE TIMER EXCEPT A NEWER COPY OR THE CLEAR BUTTON. Not
   *    Hide, not a selection change, not this panel unmounting (disconnect,
   *    wallet switch). `clearBearerIfUnchanged` compares before it writes, so a
   *    timer that outlives its screen cannot erase anything but this key.
   *  - HIDE DOES NOT CLEAR AT ONCE. The key was copied to be pasted, and hiding
   *    it before switching to the merchant's page is the careful order, not a
   *    request to lose the copy. The promise is a minute and a half.
   *  - THE CLEAR BUTTON STAYS WITHIN REACH while the copy may still be out: a
   *    browser that refuses the clipboard read (Firefox, always) ends the timer
   *    `unreadable`, and then the button is the only take-back there is.
   *
   * What none of this reaches: a clipboard HISTORY (Win+V) or a synced
   * clipboard records the value at copy time, and writing "" later does not
   * remove that entry. Pinned by `SubscriptionsPanel.test.tsx`, "still takes the
   * key back after Hide" / "after going back to the list" / "after the whole
   * panel unmounts", and "keeps Clear the clipboard within reach after Hide".
   */
  const cancelKeyClear = useRef<(() => void) | null>(null);
  const [keyOnClipboard, setKeyOnClipboard] = useState(false);

  function copyKey(text: string) {
    cancelKeyClear.current?.();
    cancelKeyClear.current = copyBearerAndScheduleClear(text, (outcome) => {
      // `unreadable` = the browser refused the read and nothing was cleared:
      // the key may still be out, so the button stays.
      if (outcome !== "unreadable") setKeyOnClipboard(false);
    });
    setKeyOnClipboard(true);
  }

  function clearKeyNow() {
    cancelKeyClear.current?.();
    cancelKeyClear.current = null;
    void clearBearerNow();
    setKeyOnClipboard(false);
  }

  // The key belongs to ONE subscription; switching selection drops it.
  useEffect(() => {
    setRevealedKey(null);
    setRevealBusy(false);
    setRevealError(null);
    setShowIds(false);
  }, [selected]);

  async function handleReveal(rec: StoredSubscription) {
    if (rec.pool === undefined || rec.leafIndex === undefined) return;
    setRevealBusy(true);
    setRevealError(null);
    try {
      // The key is checked against the vault's on-chain license fingerprint
      // before it is shown, so read the account now rather than trust the
      // list's snapshot. A record rebuilt from a registry join (recovery,
      // track) can carry the wrong tag, and a key derived under a wrong tag
      // is one no merchant accepts; the Worker tries the stored tag, every
      // registry slug on this (retailer, mint), then the retailer address,
      // and answers only with the one that reproduces the fingerprint.
      //
      // "Now" is a fresh enumeration, not a read of this vault by its address:
      // see `readLiveVaults`. A vault the final claim closed is simply absent.
      const data = (await readLiveVaults()).get(rec.vaultPDA);
      if (!data) {
        throw new Error(
          `${KEY_NOT_RECOVERABLE}: the vault no longer exists on chain, so there is no ` +
            "license fingerprint left to check a key against.",
        );
      }
      const decoded = decodeSubscriptionVault(data);
      const res = await deriveSubscriptionLicenseKey({
        meta,
        walletPubkey: walletKey,
        pool: rec.pool,
        leafIndex: rec.leafIndex,
        serviceTag: rec.serviceTag,
        candidateTags: licenseTagCandidates({
          storedTag: rec.serviceTag,
          services: registryListings(services),
          retailer: decoded.retailer,
          tokenMint: decoded.tokenMint,
        }),
        licenseCommitment: decoded.licenseCommitment
          ? bytesToHex(decoded.licenseCommitment)
          : null,
        // The scheme the record names, as a hint only: with the fingerprint
        // above the Worker tries v2 then v1 and answers with the one that
        // verified. A record from before v2 names none and is v1.
        ...(rec.licenseScheme !== undefined ? { licenseScheme: rec.licenseScheme } : {}),
      });
      setRevealedKey(res.licenseKey);
      const scheme = res.licenseScheme ?? "v1";
      if (res.serviceTag !== rec.serviceTag || scheme !== licenseSchemeOf(rec)) {
        // The stored tag or scheme was a guess and the chain disagreed. Keep
        // the pair that verified, so the row labels itself right from now on.
        await recordSubscription(meta, walletKey, {
          ...rec,
          serviceTag: res.serviceTag,
          licenseScheme: scheme,
        });
        void refresh();
      }
    } catch (e) {
      setRevealError((e as Error).message || t("pay.subs.errRederive"));
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
      setTrackError(t("pay.subs.errNotSolanaAddress"));
      return;
    }
    setTracking(true);
    try {
      // The pasted address is looked up HERE, in the program-wide enumeration,
      // and never sent: see `readLiveVaults`. The enumeration is scoped to the
      // program and to the vault discriminator, so it is also the owner check
      // the pointed read used to make. What it cannot do is tell "no account"
      // from "another program's account" from "a vault the final claim closed",
      // so the three old messages are one: the sentence that is true of all
      // three.
      const data = (await readLiveVaults()).get(addr);
      if (!data) {
        setTrackError(t("pay.subs.errNotVault"));
        return;
      }
      const decoded = decodeSubscriptionVault(data);
      // Already tracked: keep the record we have. It may know the paying note
      // and a tag verified against the chain; a record rebuilt from the
      // account alone knows neither, and `recordSubscription` replaces.
      if (records.some((r) => r.vaultPDA === addr)) {
        setTrackAddr("");
        setSelected(addr);
        return;
      }
      const svc = serviceForVault(services, decoded);
      const decimals = decimalsForVaultMint(decoded.tokenMint);
      await recordSubscription(meta, walletKey, {
        vaultPDA: addr,
        retailer: decoded.retailer,
        // A label only: this browser holds no note for the vault, so no key
        // is ever derived from this record and nothing can verify the tag.
        // First registry slug on (retailer, mint), else the retailer address.
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
          ? t("pay.subs.errNotVault")
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
        setRecoverNote(t("pay.subs.recoverNone"));
      }
    } catch (e) {
      setRecoverError((e as Error).message || "Recovery failed.");
    } finally {
      setRecovering(false);
    }
  }

  function merchantName(rec: StoredSubscription): string {
    // The listing the record is scoped to, when the roster has it: with two
    // slugs on one retailer, the (retailer, mint) join below can name the
    // other one.
    const scoped = services.find(
      (s) => s.slug === rec.serviceTag && s.retailer.toBase58() === rec.retailer,
    );
    if (scoped) return scoped.name;
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
              {t("pay.subs.closedBody")}
            </p>
          )}

          {decoded && summary && (
            <>
              <p className="mt-3 text-lg text-p01-text">{plainStanding(summary, t)}</p>
              {/* `formatInterval` answers in English ("monthly") — it is a pure
                  helper with its own tests and no locale — so its answer is
                  mapped onto a dictionary key at the point of display. See
                  lib/pay/intervalLabel.ts for why the map lives here rather
                  than inside the helper. */}
              <p className="mt-1 text-sm text-p01-text-muted">
                {t("pay.subs.escrowLine")
                  .replace("{total}", formatAtomic(decoded.totalDeposited, decimals))
                  .replace("{rate}", formatAtomic(decoded.rate, decimals))
                  .replaceAll("{symbol}", symbol)
                  .replace(
                    "{interval}",
                    translateInterval(formatInterval(decoded.intervalSlots), t),
                  )}
              </p>
              <p className="mt-1 text-xs text-p01-text-muted">
                {t("pay.subs.collected")
                  .replace("{claimed}", summary.claimedPeriods.toString())
                  .replace("{total}", summary.totalPeriods.toString())}
              </p>
            </>
          )}
        </div>

        {/* The license key: re-derived on demand, stored nowhere */}
        <div className="card p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-p01-cyan" />
            <p className="font-display text-sm text-p01-text">{t("pay.subs.keyTitle")}</p>
          </div>
          <p className="mt-2 text-xs text-p01-text-muted">{t("pay.subs.keyNowhere")}</p>
          <p className="mt-2 text-xs text-p01-text-muted">{t("pay.subs.keyBearer")}</p>

          {canReveal ? (
            revealedKey ? (
              <div className="mt-3">
                <p className="break-all font-mono text-xl leading-relaxed text-p01-cyan">
                  {revealedKey}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <CopyButton
                    text={revealedKey}
                    label={t("pay.subs.keyCopy")}
                    bearer={{ copy: copyKey, clearNow: clearKeyNow }}
                  />
                  <button
                    onClick={() => setRevealedKey(null)}
                    className="text-xs text-p01-text-muted underline hover:text-p01-cyan"
                  >
                    {t("pay.subs.keyHide")}
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
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("pay.subs.keyRederiving")}
                  </>
                ) : (
                  <>
                    <KeyRound className="h-3.5 w-3.5" /> {t("pay.subs.keyReveal")}
                  </>
                )}
              </button>
            )
          ) : (
            <p className="mt-3 text-xs text-p01-text-dim">{t("pay.subs.keyNotHere")}</p>
          )}
          {revealError && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-p01-red">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {revealError}
            </p>
          )}

          <p className="mt-3 font-mono text-xs text-p01-text-dim">
            {t("pay.subs.keyScoped")} {rec.serviceTag}
          </p>
          {decoded?.licenseCommitment && (
            <p className="mt-1 text-xs text-p01-text-dim">{t("pay.subs.keyFingerprint")}</p>
          )}
        </div>

        {/* Irreversibility, on the detail page and not only before purchase */}
        <div className="rounded-lg border border-p01-red/30 bg-p01-red/5 p-3 text-xs text-p01-red">
          <p className="font-medium">{t("pay.subs.noCancelTitle")}</p>
          <p className="mt-1 text-p01-red/90">{t("pay.subs.noCancelBody")}</p>
        </div>

        <p className="text-xs text-p01-text-muted">{t("pay.subs.poolCaveat")}</p>

        {/* Links out, behind a click: see `showIds`. */}
        <div className="card space-y-2 p-4">
          {showIds ? (
            <>
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
              <button
                onClick={() => setShowIds(false)}
                className="text-xs text-p01-text-muted underline hover:text-p01-cyan"
              >
                {t("pay.subs.idsHide")}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-p01-text-muted">{t("pay.subs.idsHidden")}</p>
              <button
                onClick={() => setShowIds(true)}
                className="text-xs text-p01-cyan underline hover:text-p01-text"
              >
                {t("pay.subs.idsShow")}
              </button>
            </>
          )}
        </div>

        {/* Technical detail, second plane on purpose */}
        <details className="card p-4 text-xs text-p01-text-muted">
          <summary className="cursor-pointer font-display text-sm text-p01-text">
            {t("pay.subs.technical")}
          </summary>
          <dl className="mt-3 space-y-1.5 font-mono">
            {showIds && (
              <div className="flex justify-between gap-3">
                <dt>vault PDA</dt>
                <dd className="break-all text-right">{rec.vaultPDA}</dd>
              </div>
            )}
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
                {showIds && (
                  <div className="flex justify-between gap-3">
                    <dt>start_slot</dt>
                    <dd>{decoded.startSlot.toString()}</dd>
                  </div>
                )}
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
                {showIds && decoded.licenseCommitment && (
                  <div className="flex justify-between gap-3">
                    <dt>license fingerprint</dt>
                    <dd>{truncate(bytesToHex(decoded.licenseCommitment), 10, 6)}</dd>
                  </div>
                )}
              </>
            )}
          </dl>
          <p className="mt-3 font-sans">
            {t("pay.subs.pauseNote")}
          </p>
          <button
            onClick={() => handleForget(rec.vaultPDA)}
            className="mt-3 font-sans text-p01-text-muted underline hover:text-p01-red"
          >
            {t("pay.subs.untrack")}
          </button>
        </details>
      </div>
    );
  }

  // ── Master-detail frame ──────────────────────────────────────────────────
  return (
    <div className="lg:grid lg:grid-cols-5 lg:items-start lg:gap-4">
      {/* A copied key may still be on the clipboard after it left the screen.
          While the key is shown, the button beside Copy key does this; once it
          is hidden this row is the only way left, on the list and on the
          detail alike. See `copyKey`. */}
      {keyOnClipboard && !revealedKey ? (
        <div className="card mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-xs text-p01-text-muted lg:col-span-5 lg:mb-0">
          <span>{t("pay.shared.clipboardNote")}</span>
          <button
            type="button"
            onClick={clearKeyNow}
            className="underline hover:text-p01-cyan"
          >
            {t("pay.shared.clipboardClear")}
          </button>
        </div>
      ) : null}
      {/* Left: the list. Below lg it yields the screen to the detail. */}
      <div className={clsx("space-y-4 lg:col-span-2", selectedRec && "hidden lg:block")}>
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-p01-cyan" />
              <p className="font-display text-sm text-p01-text">{t("pay.subs.listTitle")}</p>
            </div>
            <button
              onClick={() => void refresh()}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-xs text-p01-text-muted hover:text-p01-cyan disabled:opacity-50"
            >
              <RefreshCw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {refreshing ? t("pay.subs.reading") : t("pay.subs.refresh")}
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
              {t("pay.subs.empty")}
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
                          {state.kind === "loading" && t("pay.subs.rowLoading")}
                          {state.kind === "closed" && t("pay.subs.rowClosed")}
                          {state.kind === "error" && t("pay.subs.rowError")}
                          {summary && plainStanding(summary, t)}
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

        {/* ⚠️ TWO RECOVERY TOOLS, FOLDED UNDER ONE LINE.
            "Track a vault" and "Recover from the chain" are both answers to
            "my list is missing something". Open, they are two cards and two
            paragraphs — one of them five sentences — and together they took
            more of the screen than the subscriptions themselves, which is the
            thing the tab is named after. Neither is used on a normal visit and
            both are exactly what a reader hunts for when they are.

            Nothing is removed: the fold contains both cards verbatim, and the
            summary names the situation that sends someone looking for them. */}
        <details className="styx-subs-tools">
          <summary>{t("pay.subs.toolsSummary")}</summary>
          <div className="styx-subs-tools-body">
          {/* Track an existing vault */}
          <div className="card p-4">
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-p01-cyan" />
              <p className="font-display text-sm text-p01-text">{t("pay.subs.trackTitle")}</p>
            </div>
            <p className="mt-2 text-xs text-p01-text-muted">
              {t("pay.subs.trackLede")}
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={trackAddr}
                onChange={(e) => setTrackAddr(e.target.value)}
                placeholder={t("pay.subs.trackPlaceholder")}
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
                {t("pay.subs.trackButton")}
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
              <p className="font-display text-sm text-p01-text">{t("pay.subs.recoverTitle")}</p>
            </div>
            <p className="mt-2 text-xs text-p01-text-muted">
              {t("pay.subs.recoverLede")}
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
              {recovering ? t("pay.subs.recoverScanning") : t("pay.subs.recoverButton")}
            </button>
            {recoverNote && <p className="mt-2 text-xs text-p01-text-muted">{recoverNote}</p>}
            {recoverError && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-p01-red">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {recoverError}
              </p>
            )}
          </div>
          </div>
        </details>

      </div>

      {/* Right: the detail of the selected merchant. Below lg it only exists
          while something is selected; on lg it is always on screen. */}
      <div className={clsx("mt-4 lg:col-span-3 lg:mt-0", !selectedRec && "hidden lg:block")}>
        {selectedRec ? (
          renderDetail(selectedRec)
        ) : (
          <div className="card p-6 text-center text-sm text-p01-text-muted">
            {t("pay.subs.placeholder")}
          </div>
        )}
      </div>
    </div>
  );
}
