/**
 * Subscribe: what you are paying, what pays for it, one button.
 *
 * 🎯 THE STEP THAT ASKED THE WRONG QUESTION FIRST IS GONE
 * ──────────────────────────────────────────────────────
 * This screen used to open on a privacy-mode chooser: two cards, six feature
 * chips, a Continue button, and only THEN the name and the price. It asked how
 * you wanted to pay before it told you what you were paying for, and the
 * default it landed on was `standard` — the fully public path — on the privacy
 * wallet's own subscribe screen.
 *
 * There is one mode now. A subscription here is funded by a shielded note,
 * because that is the only path the product has ever proven end to end and the
 * only one worth the extra transaction. Nothing to choose, so nothing to ask.
 *
 * ⛔ THE NOTE PICKER IS GONE TOO. It listed every note with a leaf index and
 * eight hex characters of its commitment and made the user pick one, which is
 * a question with no wrong answer and therefore not a question. The store
 * already has `getSpendableNote`; the screen now states which note is paying
 * in one line and moves on.
 *
 * 🚨 IT HONOURS WHERE YOU CAME FROM. Shield's "Subscribe" button sends
 * `state.noteId` and Discover's merchant rows send `state.service` (a registry
 * account address). Both were ignored: `state` was cast straight to a service
 * object, so arriving from Shield produced a merchant summary with no merchant
 * and a resolve step that could only fail. A note id now selects that note, and
 * a registry address is read from chain for the name, the price, the interval
 * and — the part that was fuzzy-matched by name before — the retailer to pay.
 *
 * ⚠️ `SLOTS_PER_DAY` and `intervalToSlots` are exported and pinned by
 * CreateSubscription.intervals.test.ts. The no-refund sentence is pinned by
 * shared/services/no-refund-warning.test.ts and must stay above `handleCreate`.
 */

import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, Copy, KeyRound, ShieldPlus } from 'lucide-react';
import { PublicKey } from '@solana/web3.js';

import { cn } from '@/shared/utils';
import { useWalletStore } from '@/shared/store/wallet';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { useSubscriptionVaultStore } from '@/shared/store/subscriptionVault';
import { type SubscriptionInterval } from '@/shared/services/stream';
import { getConnection, type NetworkType } from '@/shared/services/wallet';
import {
  findPoolV3,
  createNullifierV3,
  goldilocksU64To32,
  deriveNullifierPDA,
} from '@/shared/services/denominatedPool';
import { deriveVaultPDA } from '@/shared/services/subscriptionVault';
import { starkProver } from '@/shared/services/starkProver';
import { licenseKeyForPrivate, licenseServiceTag } from '@/shared/services/license';
import { noteMaturity } from '@/shared/services/maturity';
import {
  fetchServiceRegistry,
  NATIVE_MINT,
  type OnchainServiceEntry,
} from '@/shared/services/onchainServiceRegistry';
import { useLicenseStore, type LicenseEntry } from '@/shared/store/license';
import { Amount, Button, Eyebrow, Field, Panel, Pill, Screen } from '@/popup/ui';

/**
 * THE ONE-WAY RULE, IN ONE PLACE.
 *
 * It is a constant rather than inline JSX so the sentence exists exactly once
 * and sits at the top of the file — above `handleCreate`, which is what
 * shared/services/no-refund-warning.test.ts requires and what a subscriber
 * needs: the rule is on the paying screen, above the button that moves the
 * money, not in a settings page or a tooltip.
 */
const NO_REFUND =
  'The note is deposited in full and can only ever be paid out to the merchant. ' +
  'There is no cancellation and no refund — not from the merchant, not from Protocol 01.';

const PAUSE_AND_RESUME =
  'You can pause whenever you like and resume later. Pausing freezes the clock and cuts ' +
  'access; prepaid days are not lost while paused.';

/**
 * Resolve a service subscription's PAYMENT recipient: the merchant's on-chain
 * `retailer` from the Protocol 01 service registry. Services handed over from
 * the subscriptions list carry only a branding id (e.g. "netflix"); the actual
 * payee lives on-chain. Returns null if the service isn't attested on-chain (so
 * we can fail honestly instead of paying a bogus address).
 *
 * ⚠️ Arrivals from Discover skip this entirely: they carry the registry account
 * address, so `fetchServiceRegistry` reads the retailer exactly rather than
 * guessing at it from a name.
 */
async function resolveServiceRecipient(
  svc: { serviceId?: string; serviceName?: string },
  network: NetworkType,
): Promise<string | null> {
  try {
    const { fetchAllServices } = await import('@protocol-01/specter-sdk');
    const services = await fetchAllServices(getConnection(network), { activeOnly: true });
    const key = (svc.serviceId || svc.serviceName || '').toLowerCase().trim();
    if (!key) return null;
    const base = key.split(/[\s-]/)[0]; // "netflix" from "netflix" / "Netflix Standard"
    const match = services.find((s: { slug?: string; name?: string }) => {
      const slug = (s.slug || '').toLowerCase();
      const nm = (s.name || '').toLowerCase();
      return slug.includes(base) || nm.includes(base);
    });
    return (match as { retailer?: { toBase58?: () => string } } | undefined)?.retailer?.toBase58?.() ?? null;
  } catch (e) {
    console.error('[Subscription] resolveServiceRecipient failed:', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Interval → slots mapping.
//
// 🚨 THIS CONSTANT WAS 7200 AND THAT IS AN EPOCH, NOT A DAY.
//
// At the canonical 400 ms/slot a day is 86_400 / 0.4 = 216_000 slots. 7200 is
// SLOTS_PER_EPOCH — roughly 48 minutes — and the old comment block said so in
// its own last line while claiming `7200 * 1 (~24h)` two lines above it. Both
// cannot be true, and the arithmetic in the same comment ("~400ms/slot") is the
// half that was right.
//
// MEASURED CONSEQUENCE, on chain 2026-08-20: every private subscription this
// screen ever created carried an interval 30x too short. What the user picked
// as "monthly" billed every DAY; "daily" billed every 48 minutes. The vault
// stores raw slots and `claim_period` is permissionless, so a merchant could
// have drained a year of periods out of a vault in twelve days.
//
// Two other definitions in this repository already had it right and disagreed
// with this one in silence:
//   scripts/seed-services/seed-demo-services.ts:54  216_000n
//   apps/mobile/services/solana/streams.ts:645      (24*60*60*1000)/400
// and the live registry service measured on devnet carries 6_480_000 slots for
// its 30-day period — which is 216_000 * 30, not 7200 * 30.
//
// ⚠️ SLOTS_PER_EPOCH = 7200 is CORRECT where it means an epoch
// (denominatedPool.ts). It is a different quantity. Do not reunify them.
//
//   daily   = 216_000 * 1   =    216 000 slots  =  86 400 s
//   weekly  = 216_000 * 7   =  1 512 000 slots  = 604 800 s
//   monthly = 216_000 * 30  =  6 480 000 slots  = 2 592 000 s
//   yearly  = 216_000 * 365 = 78 840 000 slots  = 31 536 000 s
// ---------------------------------------------------------------------------

export const SLOTS_PER_DAY = 216_000n;

export function intervalToSlots(interval: SubscriptionInterval): bigint {
  switch (interval) {
    case 'daily':   return SLOTS_PER_DAY;
    case 'weekly':  return SLOTS_PER_DAY * 7n;
    case 'monthly': return SLOTS_PER_DAY * 30n;
    case 'yearly':  return SLOTS_PER_DAY * 365n;
    default:        return SLOTS_PER_DAY * 30n;
  }
}

/** The inverse, for a registry entry that stores raw slots. Buckets, because a
 *  merchant's period is whatever they set and need only READ as a period. */
function intervalFromSlots(slots: number): SubscriptionInterval {
  const days = (slots * 0.4) / 86_400;
  if (days >= 300) return 'yearly';
  if (days >= 20) return 'monthly';
  if (days >= 5) return 'weekly';
  return 'daily';
}

/** How a period reads in a sentence. `formatInterval` gives "Monthly"; a price
 *  needs "a month". */
const PER_INTERVAL: Record<SubscriptionInterval, string> = {
  daily: 'a day',
  weekly: 'a week',
  monthly: 'a month',
  yearly: 'a year',
};

const DURATION_OPTIONS: { label: string; days: number }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'Custom', days: -1 },
];

const FREQUENCY_OPTIONS: { label: string; value: SubscriptionInterval }[] = [
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Yearly', value: 'yearly' },
];

/** Calendar days in one billing interval (matches INTERVAL_SECONDS in stream.ts). */
function intervalDays(interval: SubscriptionInterval): number {
  switch (interval) {
    case 'daily':   return 1;
    case 'weekly':  return 7;
    case 'monthly': return 30;
    case 'yearly':  return 365;
    default:        return 30;
  }
}

/** Number of billing periods covered by `durationDays` at `interval` (min 1). */
function periodsForDuration(durationDays: number, interval: SubscriptionInterval): number {
  if (!(durationDays > 0)) return 1;
  return Math.max(1, Math.ceil(durationDays / intervalDays(interval)));
}

/** A row of choices. Four of these were hand-rolled at 32px tall; targets in a
 *  wallet are 44. */
function Choices<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <p className="text-tiny text-p01-text-muted">{label}</p>
      <div className="mt-1.5 grid grid-cols-4 gap-2">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            className={cn(
              'min-h-[44px] rounded-lg border text-sm transition-colors duration-exit',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
              value === o.value
                ? 'border-p01-cyan bg-p01-cyan/10 text-p01-text'
                : 'border-p01-border text-p01-text-muted hover:border-p01-border-light',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Which input an error belongs under. `null` means the operation itself failed
 *  and the message belongs next to the button that started it. */
type ErrorField = 'recipient' | 'amount' | 'duration' | null;

// ═══════════════════════════════════════════════════════════════════════════

export default function CreateSubscription() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { _keypair, network, isUnlocked } = useWalletStore();
  const { getSpendableNote, getNotes, removeNote } = useDenominatedPoolStore();
  const { createPrivateVault, addVault } = useSubscriptionVaultStore();
  const { saveLicense } = useLicenseStore();

  /**
   * Everything this screen can be handed. Four callers, three shapes:
   *   Subscriptions  → { serviceId, serviceName, price, frequency }
   *   Discover       → { service }   the registry account address
   *   Shield         → { noteId }    the note the user pressed Subscribe on
   *   a dApp prefill → query params
   */
  const state = (location.state ?? null) as
    | {
        serviceId?: string;
        serviceName?: string;
        price?: number;
        frequency?: SubscriptionInterval;
        service?: string;
        noteId?: string;
      }
    | null;

  const registryAddress = state?.service ?? null;
  const preselectedNoteId = state?.noteId ?? null;
  const svc = state?.serviceId || state?.serviceName ? state : null;

  const prefillName = svc?.serviceName || searchParams.get('name') || '';
  const prefillRecipient = svc?.serviceId || searchParams.get('recipient') || '';
  const prefillAmount = svc?.price != null ? String(svc.price) : (searchParams.get('amount') || '');

  // No merchant on either side → this is a payment the user is describing
  // themselves, so the screen asks for the parts it does not know.
  const isPersonal = !svc && !registryAddress;

  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<{ field: ErrorField; message: string } | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  const [createdLicense, setCreatedLicense] = useState<LicenseEntry | null>(null);
  const [copied, setCopied] = useState(false);

  const fail = (message: string, field: ErrorField = null) => setError({ field, message });
  const errorFor = (field: ErrorField) =>
    error && error.field === field ? error.message : undefined;

  // ── Personal fields ──────────────────────────────────────────────────────
  const [personalRecipient, setPersonalRecipient] = useState(prefillRecipient);
  const [personalName, setPersonalName] = useState(prefillName);
  const [personalAmount, setPersonalAmount] = useState(prefillAmount);
  const [selectedDurationDays, setSelectedDurationDays] = useState<number>(30);
  const [customDuration, setCustomDuration] = useState('');
  const [frequency, setFrequency] = useState<SubscriptionInterval>('monthly');

  // ── The merchant, read from chain when we were handed a registry address ──
  const [registryService, setRegistryService] = useState<OnchainServiceEntry | null>(null);
  const [registryLoading, setRegistryLoading] = useState(!!registryAddress);
  useEffect(() => {
    if (!registryAddress) return;
    let cancelled = false;
    (async () => {
      try {
        const entry = await fetchServiceRegistry(registryAddress, network);
        if (cancelled) return;
        if (entry) setRegistryService(entry);
        else fail('This merchant is no longer listed in the registry.');
      } catch (e) {
        if (!cancelled) fail((e as Error)?.message || 'The registry could not be read.');
      } finally {
        if (!cancelled) setRegistryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [registryAddress, network]);

  // Live slot tracking for the note-maturity countdown. A note can only fund a
  // private subscription once it has aged up to `dynamic_delay` epochs (max 2,
  // per get_dynamic_delay). We fetch the slot periodically and tick every second
  // so the countdown is real time rather than a stale snapshot.
  const [slotInfo, setSlotInfo] = useState<{ slot: number; at: number } | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    let cancelled = false;
    const fetchSlot = async () => {
      try {
        const slot = await getConnection(network).getSlot('confirmed');
        if (!cancelled) setSlotInfo({ slot, at: Date.now() });
      } catch { /* leave null — don't block the screen on RPC hiccups */ }
    };
    fetchSlot();
    const refetch = setInterval(fetchSlot, 30_000);
    const tick = setInterval(() => setNowTs(Date.now()), 1000);
    return () => { cancelled = true; clearInterval(refetch); clearInterval(tick); };
  }, [network]);

  // Spent-note scan: a denominated note is single-use (one note = one
  // subscription/withdrawal). After it's spent, its on-chain NullifierRecord
  // PDA exists. The local store can go stale (e.g. spent on another device, or
  // a tx that landed despite a client-side RPC timeout), so on mount we batch
  // getMultipleAccountsInfo over every note's nullifier PDA and drop any that
  // are already spent — otherwise one of them funds this screen and fails ~2min
  // into the proof.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const notes = getNotes();
        if (notes.length === 0) return;
        const conn = getConnection(network);
        const entries = notes
          .map((n) => {
            const pool = findPoolV3(n.token, n.denominationHuman);
            if (!pool) return null;
            const nul = createNullifierV3(n.nullifierPreimage, n.secret);
            const [pda] = deriveNullifierPDA(pool.poolPDA, goldilocksU64To32(nul));
            return { noteId: n.commitment.toString(), pda };
          })
          .filter((e): e is { noteId: string; pda: PublicKey } => e !== null);
        if (entries.length === 0) return;
        const infos = await conn.getMultipleAccountsInfo(entries.map((e) => e.pda));
        if (cancelled) return;
        infos.forEach((info, i) => {
          if (info !== null) removeNote(entries[i].noteId);
        });
      } catch { /* best-effort — fail-fast in subscribePrivate still guards */ }
    })();
    return () => { cancelled = true; };
  }, [network]);

  /**
   * The note that pays. Nobody is asked to choose: an arrival from Shield names
   * the note the user pressed Subscribe on, and otherwise the store hands back
   * a spendable one from the only pool open to deposits.
   */
  const allNotes = getNotes();
  const namedNote = preselectedNoteId
    ? allNotes.find((n) => n.commitment.toString() === preselectedNoteId)
    : undefined;
  const note = namedNote ?? getSpendableNote('SOL', 1) ?? allNotes[0] ?? null;

  const maturity = note
    ? noteMaturity(note.depositEpoch, slotInfo, nowTs)
    : { ready: false, label: '' };

  // Resolved duration (days) — the custom box overrides the chips.
  const durationDays = selectedDurationDays === -1 ? (Number(customDuration) || 0) : selectedDurationDays;

  const activeInterval: SubscriptionInterval = isPersonal
    ? frequency
    : registryService
      ? intervalFromSlots(registryService.intervalSlots)
      : (svc?.frequency || 'monthly');

  // For a personal payment the user enters a TOTAL over `durationDays`; the
  // recurring rate is total ÷ number of billing periods. A merchant keeps its
  // registered price.
  const personalPeriods = periodsForDuration(durationDays, activeInterval);
  const personalTotal = parseFloat(personalAmount) || 0;
  const personalPerPayment = personalPeriods > 0 ? personalTotal / personalPeriods : 0;

  const registryPrice =
    registryService && registryService.tokenMint === NATIVE_MINT
      ? registryService.priceAtomic / 1e9
      : null;

  const activeName = isPersonal ? personalName : (registryService?.name || prefillName);
  const activeRecipient = isPersonal
    ? personalRecipient
    : (registryService?.retailer || prefillRecipient);
  const activeAmount = isPersonal
    ? personalPerPayment
    : (registryPrice ?? parseFloat(prefillAmount)) || 0;

  /**
   * Persist + surface a pre-computed license key for a completed subscription.
   * Under the COMMITMENT scheme the key is `encodeLicenseKey(deriveLicenseSecret(
   * masterNoteSecret, serviceId))` and the on-chain `license_commitment =
   * blake3(licenseSecret)` was posted as the trailing subscribe arg #10 — so a
   * merchant verifies `blake3(decode(presentedKey)) == vault.license_commitment`
   * with NO shared secret. The caller derives the key from the SAME
   * (noteSecret, serviceId) it handed to the subscribe builder.
   */
  const mintLicense = (params: {
    licenseKey: string;
    retailer: string;
    mode: 'standard' | 'zk';
  }) => {
    try {
      const entry: LicenseEntry = {
        licenseKey: params.licenseKey,
        retailer: params.retailer,
        mode: params.mode,
        serviceName: activeName || undefined,
        createdAt: Date.now(),
      };
      saveLicense(entry);
      setCreatedLicense(entry);
    } catch (e) {
      // Non-fatal: the subscription already succeeded on-chain. Just skip the
      // key panel and fall back to navigating away.
      console.warn('[Subscription] license mint failed:', e);
      navigate('/subscriptions', { replace: true });
    }
  };

  const handleCreate = async () => {
    setError(null);

    if (!isUnlocked) {
      fail('Unlock your wallet first.');
      return;
    }

    // Personal field validation (a merchant flow has these from the registry).
    if (isPersonal) {
      if (!personalRecipient.trim()) {
        fail('Enter a recipient wallet address.', 'recipient');
        return;
      }
      try {
        new PublicKey(personalRecipient.trim());
      } catch {
        fail('That is not a valid Solana address.', 'recipient');
        return;
      }
      if (durationDays <= 0) {
        fail('Choose how long this runs for.', 'duration');
        return;
      }
      if (!(personalTotal > 0)) {
        fail('Enter a total greater than 0.', 'amount');
        return;
      }
    }

    // ⚠️ The local keypair is the only signing path, and `subscribePrivate`
    // reaches for it itself. Checked here so an unusable wallet stops the flow
    // before a 60-second proof rather than after it.
    if (!_keypair) {
      fail('Wallet not ready — unlock and try again.');
      return;
    }

    // No note → the shield screen is the next step, not an error.
    if (!note) {
      navigate('/shield');
      return;
    }

    // Anti-correlation maturity gate: a note must age before it can fund a
    // private subscription (on-chain EpochDelayNotMet). Block early instead of
    // failing after a 60s proof generation.
    const mat = noteMaturity(note.depositEpoch, slotInfo, nowTs);
    if (!mat.ready) {
      fail(
        `This note is too young — ${mat.label.toLowerCase()}. A shielded note ages about two ` +
        'epochs before it can fund a subscription, so nobody can line the deposit up with the payment.',
      );
      return;
    }

    setIsCreating(true);
    setProgressMsg(null);

    try {
      // Resolve the merchant. A registry arrival already carries the exact
      // retailer; a branding id has to be looked up.
      let recipient = activeRecipient;
      if (!registryService && svc) {
        setProgressMsg('Looking up the merchant');
        const resolved = await resolveServiceRecipient(svc, network);
        if (!resolved) {
          fail(`${activeName || 'This service'} isn't registered on-chain yet — there's no merchant address to pay.`);
          setIsCreating(false);
          setProgressMsg(null);
          return;
        }
        recipient = resolved;
      }

      try {
        new PublicKey(recipient);
      } catch {
        fail('Invalid recipient address.', isPersonal ? 'recipient' : null);
        setIsCreating(false);
        setProgressMsg(null);
        return;
      }

      // receipt.merkleRoot must be present (set at shield time in shieldV3).
      if (!note.merkleRoot) {
        fail('This note is missing its Merkle root. Shield a new note before subscribing.');
        setIsCreating(false);
        setProgressMsg(null);
        return;
      }

      // Find the pool config for this note so we get treePDA.
      const poolConfig = findPoolV3(note.token, note.denominationHuman);
      if (!poolConfig) {
        fail(`No pool registered for ${note.token} ${note.denominationHuman}. Shield a note in a current denomination.`);
        setIsCreating(false);
        setProgressMsg(null);
        return;
      }

      // Rate in atomic units. Private subscribe requires rate <= denomination.
      const rateAtomic = BigInt(Math.round(activeAmount * 1e9));
      if (rateAtomic > poolConfig.denominationAtomic) {
        fail(
          `${activeAmount} ${note.token} per period is more than the note holds ` +
          `(${note.denominationHuman} ${note.token}). Lower the amount or shield a larger note.`,
          isPersonal ? 'amount' : null,
        );
        setIsCreating(false);
        setProgressMsg(null);
        return;
      }

      const intervalSlots = intervalToSlots(activeInterval);

      // ── Subscriber-ownership commitment ───────────────────────────────
      // The subscriber secret IS the note's own Goldilocks secret
      // (mirrors mobile subscribe-private.tsx line 174: `subscriberSecret = receipt.secret`).
      // Circuit-0 (subscriber_ownership) takes the secret bigint and returns a
      // Goldilocks u64 commitment. The commitment is then used as the vault PDA
      // seed and stored on-chain for pause/resume verification.
      //
      // NOTE: starkProver.generateProof returns { commitment: string } where
      // commitment is the decimal bigint string from WASM (same as what
      // BigInt(proofResult.commitment) uses in pausePrivate). The mobile's
      // sha256(Buffer.from(commitment, 'hex')) would fail on a decimal string,
      // so we use zeros for vkHashSubscriber here (acceptable: vkHashSubscriber
      // is informational — the on-chain ix only checks subscriber_commitment for
      // pause/resume, not vkHashSubscriber).
      setProgressMsg('Starting the prover');
      await starkProver.start();

      setProgressMsg('Proving you own the note');
      const subscriberSecret = note.secret; // Goldilocks bigint
      const ownershipResult = await starkProver.generateProof(subscriberSecret.toString());
      const subscriberOwnershipCommitment = BigInt(ownershipResult.commitment);

      // vkHashSubscriber: 32 bytes stored on-chain as metadata.
      const vkHashSubscriber = new Uint8Array(32);

      // Service tag for the license-key commitment (HKDF info). ONE rule,
      // pinned across clients — see licenseServiceTag. MUST match the value
      // subscribePrivate hashes into license_commitment AND the value any
      // display path re-derives from, or the key verifies nowhere.
      const licenseServiceId = licenseServiceTag(
        registryService?.slug || svc?.serviceId,
        recipient,
      );

      // ── Create private vault ───────────────────────────────────────────
      setProgressMsg('Opening the private vault');
      await createPrivateVault({
        receipt: note,
        poolPDA: poolConfig.poolPDA.toBase58(),
        treePDA: poolConfig.treePDA.toBase58(),
        retailer: recipient,
        rate: rateAtomic,
        intervalSlots,
        subscriberOwnershipCommitment,
        vkHashSubscriber,
        serviceId: licenseServiceId,
        onProgress: (step) => setProgressMsg(step),
      });

      // Subscriber secret is already persisted (encrypted, BEFORE creation)
      // inside subscribePrivate → store.saveSecret, keyed by this same vault
      // PDA. We only re-derive the PDA here to fetch + locally record the
      // vault. Vault PDA is keyed by [retailer, subscriberCommitmentBytes,
      // tokenMint]; for SOL the mint == SystemProgram.programId, identical to
      // the value subscribePrivate uses for the persistence key.
      const { goldilocksU64To32: toBytes32 } = await import('@/shared/services/subscriptionVault');
      const subscriberCommitmentBytes = toBytes32(subscriberOwnershipCommitment);
      const vaultPDA = deriveVaultPDA(
        new PublicKey(recipient),
        subscriberCommitmentBytes,
        poolConfig.tokenMint, // SOL = SystemProgram.programId
      );

      // Record the vault LOCALLY. A private vault is keyed on-chain by an
      // anonymous commitment, so it is NOT discoverable by scanning the chain
      // with our wallet — the creating client must keep its own record.
      try {
        const { fetchVault } = await import('@/shared/services/subscriptionVault');
        const vaultInfo = await fetchVault(vaultPDA.toBase58());
        if (vaultInfo) addVault(vaultInfo);
      } catch (e) {
        console.warn('[Subscription/ZK] addVault after subscribe failed (non-fatal):', e);
      }

      // Note is now spent (one note funds exactly one subscription). Drop it
      // from the local store so it can't be reused (it would collide on the
      // nullifier record on-chain).
      removeNote(note.commitment.toString());

      // Display the license key under the commitment scheme: derive it from
      // the SAME (master note secret, serviceId) that produced the on-chain
      // license_commitment = blake3(deriveLicenseSecret(note.secret, serviceId)).
      mintLicense({
        licenseKey: licenseKeyForPrivate(note.secret, licenseServiceId),
        retailer: recipient,
        mode: 'zk',
      });
    } catch (err) {
      console.error('[Subscription/ZK] Create error:', err);
      // If the note was already spent on-chain (stale local entry), drop it so
      // the user doesn't keep hitting the same dead note.
      if ((err as Error)?.name === 'NoteAlreadySpentError') {
        removeNote(note.commitment.toString());
      }
      fail((err as Error)?.message || 'The subscription could not be started.');
    } finally {
      setIsCreating(false);
      setProgressMsg(null);
    }
  };

  const blocked = !isUnlocked || !maturity.ready || registryLoading;

  /* ── The footer. One action, full width, at the bottom. ─────────────── */
  const footer = createdLicense ? (
    <Button full size="lg" onClick={() => navigate('/subscriptions', { replace: true })}>
      Done
    </Button>
  ) : (
    <>
      {progressMsg && (
        <p className="mb-2 text-tiny text-p01-text-muted" aria-live="polite">
          {progressMsg}
        </p>
      )}
      {/* An operation that failed has no field of its own, so it sits with the
          control that started it — never as a summary at the top. */}
      {error && error.field === null && (
        <p role="alert" className="mb-2 text-tiny text-p01-red">
          {error.message}
        </p>
      )}
      {note ? (
        <Button
          full
          size="lg"
          loading={isCreating}
          disabled={blocked}
          onClick={handleCreate}
        >
          {isPersonal ? 'Start paying' : 'Subscribe'}
        </Button>
      ) : (
        <Button full size="lg" icon={ShieldPlus} onClick={() => navigate('/shield')}>
          Shield a note first
        </Button>
      )}
    </>
  );

  return (
    <Screen
      title={createdLicense ? 'Subscribed' : isPersonal ? 'New payment' : 'Subscribe'}
      onBack={() => navigate(-1)}
      footer={footer}
    >
      {createdLicense ? (
        /* ── The key, once. ──────────────────────────────────────────────
           This is not a celebration screen; it is the only moment the
           entitlement is shown in full, so it is a screen and not a toast.
           SubscriptionDetails reads the same stored entry afterwards. */
        <div className="flex flex-col gap-4">
          <div>
            <Eyebrow>Funded from your note</Eyebrow>
            <p className="mt-1.5 text-sm text-p01-text-muted">
              Keep this key. It is what proves the subscription is yours, and it is the only
              thing {createdLicense.serviceName || 'the merchant'} needs to let you in.
            </p>
          </div>

          <Panel>
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-p01-cyan" aria-hidden="true" />
              <Eyebrow>License key</Eyebrow>
            </div>
            <p className="mt-2 break-all rounded-lg border border-p01-border bg-p01-void px-3 py-2.5 font-mono text-tiny leading-relaxed text-p01-text">
              {createdLicense.licenseKey}
            </p>
            <Button
              variant="secondary"
              full
              className="mt-2.5"
              icon={copied ? Check : Copy}
              onClick={() => {
                void navigator.clipboard?.writeText(createdLicense.licenseKey);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied' : 'Copy license key'}
            </Button>
          </Panel>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* ── What is being paid. First, because it is the question. ── */}
          {isPersonal ? (
            <div className="flex flex-col gap-4">
              <Field
                label="Pay to"
                value={personalRecipient}
                onChange={(e) => { setPersonalRecipient(e.target.value); setError(null); }}
                placeholder="Solana address"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono"
                error={errorFor('recipient')}
              />

              <Field
                label="What is it for"
                value={personalName}
                onChange={(e) => setPersonalName(e.target.value)}
                placeholder="Rent, allowance, dues"
                hint="Optional, and stored on this device only."
              />

              <Field
                label="Total"
                type="number"
                inputMode="decimal"
                step="0.0001"
                min="0"
                value={personalAmount}
                onChange={(e) => { setPersonalAmount(e.target.value); setError(null); }}
                placeholder="0.00"
                suffix="SOL"
                className="font-mono"
                error={errorFor('amount')}
              />

              <Choices
                label="Over"
                options={DURATION_OPTIONS.map((d) => ({ label: d.label, value: d.days }))}
                value={selectedDurationDays}
                onChange={(v) => { setSelectedDurationDays(v); setError(null); }}
              />
              {selectedDurationDays === -1 && (
                <Field
                  label="Days"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={customDuration}
                  onChange={(e) => { setCustomDuration(e.target.value); setError(null); }}
                  placeholder="45"
                  className="font-mono"
                  error={errorFor('duration')}
                />
              )}

              <Choices
                label="Paid"
                options={FREQUENCY_OPTIONS}
                value={frequency}
                onChange={setFrequency}
              />

              {personalTotal > 0 && durationDays > 0 && (
                <Panel tone="quiet">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-p01-text-muted">Each payment</span>
                    <span className="text-sm text-p01-text tabular">
                      {personalPerPayment.toFixed(4)} SOL {PER_INTERVAL[activeInterval]}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-sm text-p01-text-muted">Payments</span>
                    <span className="text-sm text-p01-text tabular">
                      {personalPeriods} over {durationDays} days
                    </span>
                  </div>
                </Panel>
              )}
            </div>
          ) : (
            <div>
              <Eyebrow>You are subscribing to</Eyebrow>
              <p className="mt-1.5 font-display text-xl font-light tracking-tight">
                {registryLoading ? 'Reading the registry' : activeName || 'This merchant'}
              </p>
              {activeAmount > 0 && (
                <div className="mt-1.5 flex items-baseline gap-1.5">
                  <Amount value={activeAmount} unit="SOL" size="lg" />
                  <span className="text-sm text-p01-text-muted">{PER_INTERVAL[activeInterval]}</span>
                </div>
              )}
              {/* ⚠️ Only a real payee is shown. The subscriptions list hands
                  over a branding id ("netflix"), and printing that in mono
                  under the price would read as an address it is not. */}
              {registryService && (
                <p className="mt-2 truncate font-mono text-tiny text-p01-text-dim">
                  {registryService.retailer}
                </p>
              )}
            </div>
          )}

          {/* ── What pays for it. One line, no picker. ── */}
          <Panel tone="quiet">
            <Eyebrow>Funded by</Eyebrow>
            {note ? (
              <>
                <p className="mt-1.5 text-sm text-p01-text">
                  Paying from a {note.denominationHuman} {note.token} shielded note.
                </p>
                {maturity.ready ? (
                  <p className="mt-0.5 text-tiny text-p01-text-dim">
                    The note is spent in full and the merchant is paid from the vault on
                    schedule, so nothing links these payments to your wallet.
                  </p>
                ) : (
                  <div className="mt-2 flex items-center gap-2">
                    <Pill tone="warn">{maturity.label}</Pill>
                    <span className="text-tiny text-p01-text-dim">
                      A note ages before it can be spent.
                    </span>
                  </div>
                )}
              </>
            ) : (
              <p className="mt-1.5 text-sm text-p01-text-muted">
                You have no shielded note. Shielding 1 SOL is what lets this be paid without
                your wallet appearing anywhere in it.
              </p>
            )}
          </Panel>

          {/* ── The rule, above the button that moves the money. ── */}
          <Panel tone="warn">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-p01-amber" aria-hidden="true" />
              <div>
                <p className="text-sm text-p01-text">{NO_REFUND}</p>
                <p className="mt-1.5 text-tiny text-p01-text-muted">{PAUSE_AND_RESUME}</p>
              </div>
            </div>
          </Panel>
        </div>
      )}
    </Screen>
  );
}
