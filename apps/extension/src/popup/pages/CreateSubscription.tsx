import { useState, useEffect } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Shield,
  Loader2,
  EyeOff,
  Lock,
  Zap,
  Check,
  PlusCircle,
  Copy,
  KeyRound,
} from 'lucide-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { cn } from '@/shared/utils';
import { useSubscriptionsStore } from '@/shared/store/subscriptions';
import { useWalletStore } from '@/shared/store/wallet';
import { useShieldedStore } from '@/shared/store/shielded';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { useSubscriptionVaultStore } from '@/shared/store/subscriptionVault';
import { SubscriptionInterval, type PaymentSigner } from '@/shared/services/stream';
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
import { useLicenseStore, type LicenseEntry } from '@/shared/store/license';

/**
 * Resolve a service subscription's PAYMENT recipient: the merchant's on-chain
 * `retailer` from the Protocol 01 service registry. Services in the picker carry
 * only a branding id (e.g. "netflix"); the actual payee lives on-chain. Returns
 * null if the service isn't attested on-chain (so we can fail honestly instead
 * of paying a bogus address).
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

// ─── Types ──────────────────────────────────────────────────────────────────

type PrivacyMode = 'standard' | 'zk';

const PRIVACY_MODES = [
  {
    id: 'standard' as PrivacyMode,
    name: 'Standard',
    desc: 'Direct payment, fully visible on-chain (0% privacy)',
    icon: Zap,
    color: '#39c5bb',
    features: ['Fast execution', 'Lowest fees'],
    disabled: false,
    disabledReason: undefined,
  },
  {
    id: 'zk' as PrivacyMode,
    name: 'ZK Private',
    desc: 'Pay from a shielded denominated note, no wallet link (100% privacy)',
    icon: Shield,
    color: '#39c5bb',
    features: ['STARK proof (C1)', 'No wallet link', 'Goldilocks pool'],
    disabled: false,
    disabledReason: undefined,
  },
];

// ---------------------------------------------------------------------------
// Interval → slots mapping (Solana ~400ms/slot = 2.5 slots/sec)
// Mirrors how the mobile subscription vaults are structured:
//   daily   = 7200 * 1  =  7 200 slots (~24h)
//   weekly  = 7200 * 7  = 50 400 slots (~7d)
//   monthly = 7200 * 30 = 216 000 slots (~30d)
//   yearly  = 7200 * 365 = 2 628 000 slots (~1yr)
// SLOTS_PER_EPOCH = 7200 (matches denominatedPool.ts constant).
// ---------------------------------------------------------------------------

const SLOTS_PER_DAY = 7200n;

function intervalToSlots(interval: SubscriptionInterval): bigint {
  switch (interval) {
    case 'daily':   return SLOTS_PER_DAY;
    case 'weekly':  return SLOTS_PER_DAY * 7n;
    case 'monthly': return SLOTS_PER_DAY * 30n;
    case 'yearly':  return SLOTS_PER_DAY * 365n;
    default:        return SLOTS_PER_DAY * 30n;
  }
}

// ── Personal-stream form options (mirror mobile CreateStreamForm) ────────────
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

// Note-maturity countdown is shared with the shielded-wallet funds list.
// See shared/services/maturity.ts (noteMaturity + constants).

// ═══════════════════════════════════════════════════════════════════════════

export default function CreateSubscription() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { addSubscription, processPayment } = useSubscriptionsStore();
  const { _keypair, network, isUnlocked } = useWalletStore();
  const { shieldedBalance } = useShieldedStore();
  const { getSpendableNote, getNotes, removeNote } = useDenominatedPoolStore();
  const { createPrivateVault, addVault } = useSubscriptionVaultStore();
  const { saveLicense } = useLicenseStore();

  // The recipient is already determined by how the user arrived here:
  //   - picked a service in Subscriptions  -> service data in location.state
  //   - dApp approval / personal prefill    -> query params
  // So we never re-ask "who are you paying" — the flow starts at the privacy
  // step. We also don't surface any payment-classification jargon to the user.
  const svc = (location.state ?? null) as
    | { serviceId?: string; serviceName?: string; price?: number; frequency?: SubscriptionInterval }
    | null;

  const prefillName = svc?.serviceName || searchParams.get('name') || '';
  const prefillRecipient = svc?.serviceId || searchParams.get('recipient') || '';
  const prefillAmount = svc?.price != null ? String(svc.price) : (searchParams.get('amount') || '');

  // Personal stream = no merchant service. Then we render the full
  // info-completion form (recipient / name / amount / duration / frequency),
  // matching the mobile CreateStreamForm, instead of a fixed merchant summary.
  const isPersonal = !svc;

  const [step, setStep] = useState<'mode' | 'confirm'>('mode');
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>('standard');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  // Set when a subscription succeeds — drives the license-key success panel.
  const [createdLicense, setCreatedLicense] = useState<LicenseEntry | null>(null);
  const [copied, setCopied] = useState(false);

  // ── Personal-stream form fields (prefilled from query params if a dApp
  // handed them in; otherwise blank for a from-scratch payment stream). ──
  const [personalRecipient, setPersonalRecipient] = useState(prefillRecipient);
  const [personalName, setPersonalName] = useState(prefillName);
  const [personalAmount, setPersonalAmount] = useState(prefillAmount);
  const [selectedDurationDays, setSelectedDurationDays] = useState<number>(30);
  const [customDuration, setCustomDuration] = useState('');
  const [frequency, setFrequency] = useState<SubscriptionInterval>('monthly');

  // ZK note picker state — index into getNotes() array.
  const [selectedNoteIndex, setSelectedNoteIndex] = useState<number | null>(null);

  // Live slot tracking for the note-maturity countdown. A note can only fund a
  // private subscription once it has aged up to `dynamic_delay` epochs (max 2,
  // per get_dynamic_delay). We fetch the slot periodically and tick every second
  // so the "Matures in …" label counts down in real time.
  const [slotInfo, setSlotInfo] = useState<{ slot: number; at: number } | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    let cancelled = false;
    const fetchSlot = async () => {
      try {
        const slot = await getConnection(network).getSlot('confirmed');
        if (!cancelled) setSlotInfo({ slot, at: Date.now() });
      } catch { /* leave null — don't block the picker on RPC hiccups */ }
    };
    fetchSlot();
    const refetch = setInterval(fetchSlot, 30_000);
    const tick = setInterval(() => setNowTs(Date.now()), 1000);
    return () => { cancelled = true; clearInterval(refetch); clearInterval(tick); };
  }, [network]);

  // Spent-note scan: a denominated note is single-use (one note = one
  // subscription/withdrawal). After it's spent, its on-chain NullifierRecord
  // PDA exists. The local picker can go stale (e.g. spent on another device, or
  // a tx that landed despite a client-side RPC timeout), so on mount we batch
  // getMultipleAccountsInfo over every note's nullifier PDA and drop any that
  // are already spent — otherwise they'd show "✓ Ready" and fail ~2min in.
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

  // Resolved duration (days) — custom box overrides the chips.
  const durationDays = selectedDurationDays === -1 ? (Number(customDuration) || 0) : selectedDurationDays;

  const activeInterval: SubscriptionInterval = isPersonal ? frequency : (svc?.frequency || 'monthly');

  // For a personal stream the user enters a TOTAL amount over `durationDays`;
  // the recurring per-payment rate is total ÷ number of billing periods (matches
  // mobile CreateStreamForm's "Per payment" preview). `maxPayments` caps the
  // stream at that period count. A merchant service keeps its fixed price.
  const personalPeriods = periodsForDuration(durationDays, activeInterval);
  const personalTotal = parseFloat(personalAmount) || 0;
  const personalPerPayment = personalPeriods > 0 ? personalTotal / personalPeriods : 0;

  const activeName = isPersonal ? personalName : prefillName;
  const activeRecipient = isPersonal ? personalRecipient : prefillRecipient;
  const activeAmount = isPersonal ? personalPerPayment : (parseFloat(prefillAmount) || 0);

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
      // license panel and fall back to navigating away.
      console.warn('[Subscription] license mint failed:', e);
      navigate('/subscriptions', { replace: true });
    }
  };

  const handleCreate = async () => {
    setError(null);

    if (!isUnlocked) {
      setError('Please unlock your wallet first.');
      return;
    }

    // Personal-stream field validation (the merchant flow has these prefilled).
    if (isPersonal) {
      if (!personalRecipient.trim()) {
        setError('Enter a recipient wallet address.');
        return;
      }
      try {
        new PublicKey(personalRecipient.trim());
      } catch {
        setError('Recipient is not a valid Solana address.');
        return;
      }
      if (durationDays <= 0) {
        setError('Choose a duration (or enter a custom number of days).');
        return;
      }
      if (!(personalTotal > 0)) {
        setError('Enter a total amount greater than 0.');
        return;
      }
    }

    // Build the payment signer from the local keypair (the only signing path).
    let signer: PaymentSigner;
    if (_keypair) {
      const kp = _keypair;
      signer = {
        publicKey: kp.publicKey,
        keypair: kp,
        signTransaction: async (tx: Transaction) => { tx.sign(kp); return tx; },
      };
    } else {
      setError('Wallet not ready — unlock and try again.');
      return;
    }

    // ── ZK Private mode ──────────────────────────────────────────────────────
    if (privacyMode === 'zk') {
      const notes = getNotes();

      // No notes at all → send to shield screen.
      if (notes.length === 0) {
        navigate('/denominated-shield');
        return;
      }

      // Notes exist but none selected → prompt user.
      if (selectedNoteIndex === null) {
        setError('Select a shielded note to fund this subscription.');
        return;
      }

      const note = notes[selectedNoteIndex];
      if (!note) {
        setError('Selected note no longer exists. Please select another.');
        return;
      }

      // Anti-correlation maturity gate: a note must age before it can fund a
      // private subscription (on-chain EpochDelayNotMet). Block early instead of
      // failing after a 60s proof generation.
      const mat = noteMaturity(note.depositEpoch, slotInfo, nowTs);
      if (!mat.ready) {
        setError(
          `This note is too young — ${mat.label.toLowerCase()}. A shielded note must age ~2 epochs ` +
          'before it can fund a private subscription (anti-correlation). Pick an older note or wait.',
        );
        return;
      }

      setIsCreating(true);
      setProgressMsg(null);

      try {
        // Resolve the merchant retailer — same as standard flow.
        let recipient = activeRecipient;
        if (svc) {
          setProgressMsg('Resolving merchant address...');
          const resolved = await resolveServiceRecipient(svc, network);
          if (!resolved) {
            setError(`${activeName || 'This service'} isn't registered on-chain yet — there's no merchant address to pay.`);
            setIsCreating(false);
            setProgressMsg(null);
            return;
          }
          recipient = resolved;
        }

        try {
          new PublicKey(recipient);
        } catch {
          setError('Invalid recipient address.');
          setIsCreating(false);
          setProgressMsg(null);
          return;
        }

        // receipt.merkleRoot must be present (set at shield time in shieldV3).
        if (!note.merkleRoot) {
          setError(
            'This note is missing a Merkle root. Re-shield a new note before subscribing privately.',
          );
          setIsCreating(false);
          setProgressMsg(null);
          return;
        }

        // Find the pool config for this note so we get treePDA.
        const poolConfig = findPoolV3(note.token, note.denominationHuman);
        if (!poolConfig) {
          setError(`No pool registered for ${note.token} ${note.denominationHuman}. Reshield with a current denomination.`);
          setIsCreating(false);
          setProgressMsg(null);
          return;
        }

        // Rate in atomic units. Private subscribe requires rate <= denomination.
        const rateAtomic = BigInt(Math.round(activeAmount * 1e9));
        if (rateAtomic > poolConfig.denominationAtomic) {
          setError(
            `Subscription rate (${activeAmount} ${note.token}) exceeds the note denomination ` +
            `(${note.denominationHuman} ${note.token}). Choose a smaller amount or shield a larger note.`,
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
        // seed and stored on-chain for pause/resume/cancel verification.
        //
        // Derivation mirrors mobile subscribe-private.tsx lines 177-178:
        //   ownershipResult = await starkGenerate(subscriberSecret.toString())
        //   subscriberOwnershipCommitment = BigInt(ownershipResult.commitment)
        //   vkHashSubscriber = sha256(Buffer.from(ownershipResult.commitment, 'hex'))
        //
        // NOTE: starkProver.generateProof returns { commitment: string } where
        // commitment is the decimal bigint string from WASM (same as what
        // BigInt(proofResult.commitment) uses in pausePrivate). The mobile's
        // sha256(Buffer.from(commitment, 'hex')) would fail on a decimal string,
        // so we use zeros for vkHashSubscriber here (acceptable: vkHashSubscriber
        // is informational — the on-chain ix only checks subscriber_commitment for
        // pause/resume/cancel, not vkHashSubscriber).
        setProgressMsg('Starting STARK prover...');
        await starkProver.start();

        setProgressMsg('Computing subscriber ownership commitment (circuit 0)...');
        const subscriberSecret = note.secret; // Goldilocks bigint
        const ownershipResult = await starkProver.generateProof(subscriberSecret.toString());
        const subscriberOwnershipCommitment = BigInt(ownershipResult.commitment);

        // vkHashSubscriber: 32 bytes stored on-chain as metadata.
        // Use zeros — pause/resume/cancel validate circuit-0 proof against
        // subscriber_commitment, not vkHashSubscriber. Matches extension pattern
        // (createNormalVault also passes new Uint8Array(32) by default).
        const vkHashSubscriber = new Uint8Array(32);

        // Service tag for the license-key commitment (HKDF info). ONE rule,
        // pinned across clients — see licenseServiceTag. MUST match the value
        // subscribePrivate hashes into license_commitment AND the value any
        // display path re-derives from, or the key verifies nowhere.
        const licenseServiceId = licenseServiceTag(svc?.serviceId, recipient);

        // ── Create private vault ───────────────────────────────────────────
        setProgressMsg('Creating private vault (C1 proof + on-chain)...');
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
        const { goldilocksU64To32 } = await import('@/shared/services/subscriptionVault');
        const subscriberCommitmentBytes = goldilocksU64To32(subscriberOwnershipCommitment);
        const vaultPDA = deriveVaultPDA(
          new PublicKey(recipient),
          subscriberCommitmentBytes,
          poolConfig.tokenMint, // SOL = SystemProgram.programId
        );

        // Record the ZK vault LOCALLY (mirrors mobile subscriptionVaultStore).
        // A private vault is keyed on-chain by an anonymous commitment, so it is
        // NOT discoverable by scanning the chain with our wallet — the creating
        // client must keep its own record. fetchVault reads the known PDA
        // directly (the chain still validates state: balance, claimed periods,
        // active/paused). Without this the subscription is invisible in the UI.
        try {
          const { fetchVault } = await import('@/shared/services/subscriptionVault');
          const vaultInfo = await fetchVault(vaultPDA.toBase58());
          if (vaultInfo) addVault(vaultInfo);
        } catch (e) {
          console.warn('[Subscription/ZK] addVault after subscribe failed (non-fatal):', e);
        }

        // Note is now spent (one note funds exactly one subscription). Drop it
        // from the local picker so it can't be re-selected (would collide on the
        // nullifier record on-chain).
        removeNote(note.commitment.toString());

        // Display the license key under the commitment scheme: derive it from
        // the SAME (master note secret, serviceId) that produced the on-chain
        // license_commitment = blake3(deriveLicenseSecret(note.secret, serviceId)).
        // The merchant's verifyLicenseKey recomputes blake3(decode(key)) and
        // matches — no shared secret, no wallet link.
        mintLicense({
          licenseKey: licenseKeyForPrivate(note.secret, licenseServiceId),
          retailer: recipient,
          mode: 'zk',
        });
      } catch (err) {
        console.error('[Subscription/ZK] Create error:', err);
        // If the note was already spent on-chain (stale local picker entry),
        // drop it so the user doesn't keep hitting the same dead note.
        if ((err as Error)?.name === 'NoteAlreadySpentError') {
          removeNote(note.commitment.toString());
        }
        setError((err as Error)?.message || 'Failed to start ZK subscription.');
      } finally {
        setIsCreating(false);
        setProgressMsg(null);
      }
      return;
    }
    // ── End ZK Private mode ───────────────────────────────────────────────────

    if (!(activeAmount > 0)) {
      setError('Amount must be greater than 0.');
      return;
    }

    setIsCreating(true);

    try {
      // Resolve the payment recipient:
      //  - service subscription -> the merchant's on-chain `retailer` (service registry)
      //  - personal / dApp prefill -> the address that was provided
      let recipient = activeRecipient;
      if (svc) {
        const resolved = await resolveServiceRecipient(svc, network);
        if (!resolved) {
          setError(`${activeName || 'This service'} isn't registered on-chain yet — there's no merchant address to pay.`);
          setIsCreating(false);
          return;
        }
        recipient = resolved;
      }

      // Recipient must be a real wallet address before we charge.
      try {
        new PublicKey(recipient);
      } catch {
        setError('Invalid recipient address.');
        setIsCreating(false);
        return;
      }

      // Standard = no privacy features (explicitly zero — createSubscription
      // otherwise auto-applies random noise, which would falsely inflate the
      // privacy score for a fully on-chain-visible subscription).
      const subscription = addSubscription({
        name: activeName || `Payment to ${recipient.slice(0, 8)}…`,
        recipient,
        amount: activeAmount,
        interval: activeInterval,
        // Personal stream: cap at the chosen duration's period count.
        // Merchant subscription: unlimited.
        maxPayments: isPersonal ? personalPeriods : 0,
        amountNoise: 0,
        timingNoise: 0,
      });

      // Execute first payment (local keypair or Privy embedded wallet).
      await processPayment(subscription.id, signer, network);

      // CLASSIC license key is DEFERRED under the commitment scheme (mobile does
      // the same): it needs a deterministic ed25519 signer to derive the
      // licenseSecret, which our wallet/signMessage path does not yet guarantee.
      // The standard subscribe_normal ix posts license_commitment = None (arg
      // #6), so there is no on-chain commitment to verify a classic key against.
      // Skip minting a key here rather than show one that wouldn't verify.
      navigate('/subscriptions', { replace: true });
    } catch (err) {
      console.error('[Subscription] Create error:', err);
      setError((err as Error)?.message || 'Failed to start subscription.');
    } finally {
      setIsCreating(false);
    }
  };

  // ── Note picker data ───────────────────────────────────────────────────────
  // Re-computed on each render (store subscription ensures React sees updates).
  const allNotes = getNotes();

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
        <button
          onClick={() => step === 'mode' ? navigate(-1) : setStep('mode')}
          className="p-2 text-p01-chrome hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 text-center">
          <h1 className="text-white font-display font-bold tracking-wide text-sm">
            {step === 'mode' ? (isPersonal ? 'PAYMENT STREAM' : 'NEW SUBSCRIPTION') : 'CONFIRM'}
          </h1>
          <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
            STREAM SECURE
          </p>
        </div>
        <div className="w-9" />
      </header>

      <div className="flex-1 overflow-y-auto p-4">

        {/* ═══ SUCCESS: License key ═══ */}
        {createdLicense && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            <div className="flex flex-col items-center text-center pt-2">
              <div className="w-12 h-12 rounded-full bg-p01-cyan/15 flex items-center justify-center mb-3">
                <Check className="w-6 h-6 text-p01-cyan" />
              </div>
              <h2 className="text-white font-display font-bold text-base">Subscription active</h2>
              <p className="text-p01-chrome text-[11px] font-mono mt-1">
                {createdLicense.mode === 'zk'
                  ? 'Paid privately from your shielded note.'
                  : 'First payment sent.'}
              </p>
            </div>

            {/* License key */}
            <div className="p-4 rounded-2xl bg-p01-gradient-card border border-p01-cyan/20">
              <div className="flex items-center gap-2 mb-2">
                <KeyRound className="w-3.5 h-3.5 text-p01-cyan" />
                <p className="text-p01-chrome text-[10px] font-mono tracking-wider">MERCHANT LICENSE KEY</p>
              </div>
              <p className="text-white text-[10px] font-mono break-all bg-p01-void/60 border border-p01-border rounded-lg p-2.5 leading-relaxed">
                {createdLicense.licenseKey}
              </p>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(createdLicense.licenseKey);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="mt-2 w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-p01-cyan/10 border border-p01-cyan/30 text-p01-cyan text-[11px] font-mono hover:bg-p01-cyan/15 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy license key'}
              </button>
            </div>

            {/* What it is */}
            <div className="p-3 rounded-lg bg-p01-dark border border-p01-border">
              <p className="text-p01-chrome/70 text-[10px] font-mono leading-relaxed">
                Paste this key into {createdLicense.serviceName || 'the merchant'} to activate. They re-derive it
                from your on-chain subscription and grant access
                {createdLicense.mode === 'zk' ? ' — no wallet, no email, no trace.' : '.'}
              </p>
            </div>

            <button
              onClick={() => navigate('/subscriptions', { replace: true })}
              className="w-full py-3 rounded-xl bg-p01-cyan text-p01-void font-bold font-display text-sm tracking-wider hover:bg-p01-cyan/90 transition-colors"
            >
              Done
            </button>
          </motion.div>
        )}

        {/* ═══ STEP 1: Privacy Mode ═══ */}
        {!createdLicense && step === 'mode' && (
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-3">
            <p className="text-p01-chrome text-xs font-mono mb-4 text-center">
              How should payments be made?
            </p>

            {PRIVACY_MODES.map((mode) => (
              <button
                key={mode.id}
                onClick={() => !mode.disabled && setPrivacyMode(mode.id)}
                disabled={mode.disabled}
                title={mode.disabled ? mode.disabledReason : undefined}
                className={cn(
                  'w-full p-4 rounded-xl border text-left transition-all',
                  mode.disabled
                    ? 'bg-p01-surface/50 border-p01-border/50 opacity-60 cursor-not-allowed'
                    : privacyMode === mode.id
                    ? 'border-opacity-50'
                    : 'bg-p01-surface border-p01-border hover:border-opacity-30',
                )}
                style={{
                  borderColor: !mode.disabled && privacyMode === mode.id ? mode.color : undefined,
                  background: !mode.disabled && privacyMode === mode.id ? `${mode.color}08` : undefined,
                }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center mt-0.5"
                    style={{ background: `${mode.color}15` }}
                  >
                    <mode.icon className="w-5 h-5" style={{ color: mode.color }} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className={cn('font-medium text-sm', mode.disabled ? 'text-p01-chrome/60' : 'text-white')}>
                        {mode.name}
                      </p>
                      {!mode.disabled && privacyMode === mode.id && (
                        <Check className="w-3.5 h-3.5" style={{ color: mode.color }} />
                      )}
                      {mode.disabled && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-p01-border text-p01-chrome/60">
                          Mobile only
                        </span>
                      )}
                    </div>
                    <p className="text-p01-chrome text-[11px] mt-0.5">{mode.desc}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {mode.features.map((f) => (
                        <span
                          key={f}
                          className="text-[9px] font-mono px-1.5 py-0.5 rounded-full"
                          style={{ background: `${mode.color}12`, color: mode.color, border: `1px solid ${mode.color}25` }}
                        >
                          {f}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </button>
            ))}

            {/* ZK mode: note availability info */}
            {privacyMode === 'zk' && (
              <div className="p-3 rounded-lg bg-p01-cyan/5 border border-p01-cyan/20 flex items-center gap-2">
                <Lock className="w-4 h-4 text-p01-cyan shrink-0" />
                <p className="text-p01-chrome text-[10px] font-mono">
                  ZK Private needs a denominated pool note. If you have one shielded,
                  continuing will use it. If not, you will be taken to the shield screen first.
                </p>
              </div>
            )}

            <button
              onClick={() => setStep('confirm')}
              className="w-full mt-4 py-3 rounded-xl bg-p01-cyan text-p01-void font-bold font-display text-sm tracking-wider hover:bg-p01-cyan/90 transition-colors"
            >
              Continue
            </button>
          </motion.div>
        )}

        {/* ═══ STEP 2: Confirm ═══ */}
        {!createdLicense && step === 'confirm' && (
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-4">
            {/* ── Personal stream: full info-completion form (mobile parity) ── */}
            {isPersonal ? (
              <div className="space-y-4">
                {/* Recipient */}
                <div>
                  <label className="text-[10px] text-p01-chrome mb-1.5 block font-mono tracking-wider">
                    RECIPIENT ADDRESS
                  </label>
                  <input
                    type="text"
                    value={personalRecipient}
                    onChange={(e) => { setPersonalRecipient(e.target.value); setError(null); }}
                    placeholder="Enter a Solana wallet address"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full bg-p01-surface border border-p01-border focus:border-p01-cyan px-3 py-2.5 text-xs font-mono text-white placeholder-p01-text-dim focus:outline-none transition-colors rounded-lg"
                  />
                </div>

                {/* Name (optional) */}
                <div>
                  <label className="text-[10px] text-p01-chrome mb-1.5 block font-mono tracking-wider">
                    PAYMENT NAME <span className="text-p01-chrome/50">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={personalName}
                    onChange={(e) => setPersonalName(e.target.value)}
                    placeholder="Salary, allowance, rent…"
                    className="w-full bg-p01-surface border border-p01-border focus:border-p01-cyan px-3 py-2.5 text-xs font-mono text-white placeholder-p01-text-dim focus:outline-none transition-colors rounded-lg"
                  />
                </div>

                {/* Total amount */}
                <div>
                  <label className="text-[10px] text-p01-chrome mb-1.5 block font-mono tracking-wider">
                    TOTAL AMOUNT (SOL)
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={personalAmount}
                    onChange={(e) => { setPersonalAmount(e.target.value); setError(null); }}
                    placeholder="0.00"
                    step="0.0001"
                    min="0"
                    className="w-full bg-p01-surface border border-p01-border focus:border-p01-cyan px-3 py-2.5 text-sm font-mono font-bold text-white placeholder-p01-text-dim focus:outline-none transition-colors rounded-lg"
                  />
                </div>

                {/* Duration */}
                <div>
                  <label className="text-[10px] text-p01-chrome mb-1.5 block font-mono tracking-wider">
                    DURATION
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {DURATION_OPTIONS.map((d) => {
                      const sel = selectedDurationDays === d.days;
                      return (
                        <button
                          key={d.label}
                          onClick={() => setSelectedDurationDays(d.days)}
                          className={cn(
                            'py-2 rounded-lg border text-[11px] font-mono font-semibold transition-all',
                            sel
                              ? 'border-p01-cyan bg-p01-cyan/10 text-p01-cyan'
                              : 'border-p01-border bg-p01-surface text-p01-chrome hover:border-p01-cyan/40',
                          )}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                  {selectedDurationDays === -1 && (
                    <input
                      type="number"
                      inputMode="numeric"
                      value={customDuration}
                      onChange={(e) => setCustomDuration(e.target.value)}
                      placeholder="Number of days"
                      min="1"
                      className="mt-2 w-full bg-p01-surface border border-p01-border focus:border-p01-cyan px-3 py-2.5 text-xs font-mono text-white placeholder-p01-text-dim focus:outline-none transition-colors rounded-lg"
                    />
                  )}
                </div>

                {/* Frequency */}
                <div>
                  <label className="text-[10px] text-p01-chrome mb-1.5 block font-mono tracking-wider">
                    PAYMENT FREQUENCY
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {FREQUENCY_OPTIONS.map((f) => {
                      const sel = frequency === f.value;
                      return (
                        <button
                          key={f.value}
                          onClick={() => setFrequency(f.value)}
                          className={cn(
                            'py-2 rounded-lg border text-[11px] font-mono font-semibold transition-all',
                            sel
                              ? 'border-p01-cyan bg-p01-cyan/10 text-p01-cyan'
                              : 'border-p01-border bg-p01-surface text-p01-chrome hover:border-p01-cyan/40',
                          )}
                        >
                          {f.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Live preview */}
                {personalTotal > 0 && durationDays > 0 && (
                  <div className="p-4 rounded-2xl bg-p01-gradient-card border border-p01-cyan/20">
                    <p className="text-p01-chrome text-[10px] font-mono tracking-wider mb-3">STREAM SUMMARY</p>
                    <div className="space-y-3">
                      <div className="flex justify-between">
                        <span className="text-p01-chrome text-xs">Per payment</span>
                        <span className="text-p01-cyan text-xs font-mono font-bold">
                          {personalPerPayment.toFixed(4)} SOL / {activeInterval}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-p01-chrome text-xs">Payments</span>
                        <span className="text-white text-xs font-mono">{personalPeriods} over {durationDays}d</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-p01-chrome text-xs">Privacy</span>
                        <span className="text-xs font-mono" style={{ color: PRIVACY_MODES.find(m => m.id === privacyMode)?.color }}>
                          {PRIVACY_MODES.find(m => m.id === privacyMode)?.name}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-p01-chrome text-xs">Start</span>
                        <span className="text-white text-xs font-mono">Immediately</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Merchant service summary (recipient + price are fixed). */
              <div className="p-4 rounded-2xl bg-p01-gradient-card border border-p01-cyan/20">
                <p className="text-p01-chrome text-[10px] font-mono tracking-wider mb-3">SUBSCRIPTION SUMMARY</p>

                <div className="space-y-3">
                  {activeName && (
                    <div className="flex justify-between">
                      <span className="text-p01-chrome text-xs">Name</span>
                      <span className="text-white text-xs font-mono">{activeName}</span>
                    </div>
                  )}
                  {activeAmount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-p01-chrome text-xs">Amount</span>
                      <span className="text-p01-cyan text-xs font-mono font-bold">{activeAmount} SOL / {activeInterval}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-p01-chrome text-xs">Privacy</span>
                    <span className="text-xs font-mono" style={{ color: PRIVACY_MODES.find(m => m.id === privacyMode)?.color }}>
                      {PRIVACY_MODES.find(m => m.id === privacyMode)?.name}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-p01-chrome text-xs">Duration</span>
                    <span className="text-white text-xs font-mono">Unlimited</span>
                  </div>
                </div>
              </div>
            )}

            {/* ── ZK Note Picker ─────────────────────────────────────────── */}
            {privacyMode === 'zk' && (
              <div className="space-y-2">
                <p className="text-p01-chrome text-[10px] font-mono tracking-wider">
                  SELECT FUNDING NOTE
                </p>

                {allNotes.length === 0 ? (
                  <div className="p-3 rounded-lg bg-p01-surface border border-p01-border text-center space-y-2">
                    <p className="text-p01-chrome text-xs">No shielded notes found.</p>
                    <button
                      onClick={() => navigate('/denominated-shield')}
                      className="flex items-center justify-center gap-1.5 text-p01-cyan text-[11px] font-mono mx-auto hover:text-p01-cyan/80 transition-colors"
                    >
                      <PlusCircle className="w-3.5 h-3.5" />
                      Shield a note first
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {allNotes.map((note, idx) => {
                      const isSelected = selectedNoteIndex === idx;
                      // Short commitment display: last 8 hex chars of commitment bigint.
                      const commitHex = note.commitment.toString(16).padStart(16, '0');
                      const shortCommit = commitHex.slice(-8);
                      const mat = noteMaturity(note.depositEpoch, slotInfo, nowTs);
                      return (
                        <button
                          key={`${note.pool}-${note.leafIndex}`}
                          onClick={() => mat.ready && setSelectedNoteIndex(idx)}
                          disabled={!mat.ready}
                          className={cn(
                            'w-full p-3 rounded-xl border text-left transition-all',
                            !mat.ready
                              ? 'border-p01-border bg-p01-surface/50 opacity-50 cursor-not-allowed'
                              : isSelected
                              ? 'border-p01-cyan bg-p01-cyan/8'
                              : 'border-p01-border bg-p01-surface hover:border-p01-cyan/40',
                          )}
                          style={isSelected && mat.ready ? { borderColor: '#39c5bb', background: '#39c5bb0d' } : undefined}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Shield
                                className="w-4 h-4 shrink-0"
                                style={{ color: isSelected && mat.ready ? '#39c5bb' : '#6b7280' }}
                              />
                              <div>
                                <p className="text-white text-xs font-mono font-semibold">
                                  {note.denominationHuman} {note.token}
                                </p>
                                <p className="text-p01-chrome text-[9px] font-mono">
                                  leaf #{note.leafIndex} · …{shortCommit}
                                </p>
                              </div>
                            </div>
                            {mat.label && (
                              <span
                                className={cn(
                                  'text-[9px] font-mono px-1.5 py-0.5 rounded-full',
                                  mat.ready
                                    ? 'bg-p01-cyan/15 text-p01-cyan'
                                    : 'bg-p01-border text-p01-chrome/60',
                                )}
                              >
                                {mat.ready && isSelected ? '✓ Ready' : mat.label}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}

                    {/* Shield more notes link */}
                    <button
                      onClick={() => navigate('/denominated-shield')}
                      className="flex items-center gap-1.5 text-p01-chrome text-[10px] font-mono hover:text-p01-cyan transition-colors pt-1 pl-1"
                    >
                      <PlusCircle className="w-3 h-3" />
                      Shield a new note
                    </button>
                  </div>
                )}
              </div>
            )}
            {/* ── End ZK Note Picker ──────────────────────────────────────── */}

            {/* Privacy badge */}
            <div className="p-3 rounded-lg bg-p01-dark border border-p01-border flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-p01-cyan shrink-0" />
              <p className="text-p01-chrome text-[10px] font-mono">
                {privacyMode === 'standard'
                  ? 'Payments visible on-chain. Fast and minimal fees.'
                  : 'Fully untraceable. Each payment from shielded pool with ZK proof.'}
              </p>
            </div>

            {/* Progress message (ZK proving) */}
            {isCreating && progressMsg && (
              <div className="p-3 rounded-lg bg-p01-cyan/5 border border-p01-cyan/20 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 text-p01-cyan animate-spin shrink-0" />
                <p className="text-p01-cyan text-[10px] font-mono">{progressMsg}</p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="p-3 rounded-lg bg-p01-red/10 border border-p01-red/30" role="alert" aria-live="polite">
                <p className="text-p01-red text-[11px] font-mono">{error}</p>
              </div>
            )}

            {/* Actions */}
            <button
              onClick={handleCreate}
              disabled={isCreating || !isUnlocked}
              className={cn(
                'w-full py-3 rounded-xl font-bold font-display text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
                isCreating
                  ? 'bg-p01-cyan/30 text-p01-void cursor-wait'
                  : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90',
              )}
            >
              {isCreating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4" />
                  {isPersonal ? 'Create Stream' : 'Start Subscription'}
                </>
              )}
            </button>

            <p className="text-p01-chrome/40 text-[9px] font-mono text-center">
              First payment sent immediately. Cancel anytime.
            </p>
          </motion.div>
        )}
      </div>
    </div>
  );
}
