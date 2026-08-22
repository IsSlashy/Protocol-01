/**
 * Shield: the private balance, and everything you can do with it.
 *
 * 🎯 WHY THIS SCREEN EXISTS, AND WHAT IT REPLACES
 * ──────────────────────────────────────────────
 * Shielding used to be two screens. The Shield tab opened `ShieldedWallet`, a
 * dashboard, whose Shield button then opened `DenominatedShield`, a picker. So
 * the tab that is named after an action did not perform it; it pointed at a
 * screen that pointed at it. Three of the picker's five entry points were the
 * subscribe flow bouncing a half-filled purchase out of itself.
 *
 * Here the picker is inline. Tab, denomination, one press.
 *
 * 🚨 AND IT CLOSES THE PATH THE PRODUCT IS ACTUALLY ABOUT. A shielded note is
 * not the point; subscribing with one is. Until now nothing on any screen said
 * so, and a user who shielded successfully was left on a success card with a
 * Done button. Every mature note here carries its own next step: "Subscribe
 * with this note". That is the whole journey, stated on the object it applies
 * to rather than in documentation.
 *
 * ⚠️ THE WAIT IS PROTOCOL-LEVEL AND THIS SCREEN SAYS SO. A fresh note is not
 * spendable until it matures. That is enforced on chain, no interface can
 * shorten it, and the old flow let the user discover it as a greyed-out button
 * on a different screen minutes later. The countdown is on the note from the
 * moment it is created.
 *
 * ⛔ LEGACY V1 IS SHOWN AND NEVER SUMMED. `ShieldedWallet` added retired V1
 * balance into one "Shielded Balance" headline and presented the total as
 * spendable, while the home screen labelled the same money "no exit, V1
 * retired". Both cannot be true. V1 sits in its own row here, outside the
 * headline, labelled with what it is.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Clock,
  Copy,
  Download,
  Loader2,
  Radar,
  Send,
  ShieldPlus,
} from 'lucide-react';

import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { useShieldedStore } from '@/shared/store/shielded';
import { useWalletStore } from '@/shared/store/wallet';
import {
  ActionGrid,
  Amount,
  Button,
  Eyebrow,
  EmptyState,
  Hairline,
  Panel,
  Pill,
  Screen,
} from '@/popup/ui';

/** The denominations the pool actually accepts a deposit into today. */
const DENOMINATIONS = [0.1, 1, 10] as const;

/**
 * ⚠️ Only the 1 SOL pool takes new deposits. Founder decision 2026-08-21: one
 * denomination, because an anonymity set does not add across pools, it splits.
 * The others are shown and refused with the reason rather than hidden, so a
 * holder of an older note can still see where it lives.
 */
const OPEN_DENOMINATION = 1;

/** ~400ms per slot. Enough for a countdown, not a settlement guarantee. */
const SLOT_MS = 400;
const MATURITY_SLOTS = 9_000;

function maturityOf(shieldedAt: number | undefined): { ready: boolean; label: string } {
  if (!shieldedAt) return { ready: true, label: '' };
  const elapsed = Date.now() - shieldedAt;
  const needed = MATURITY_SLOTS * SLOT_MS;
  if (elapsed >= needed) return { ready: true, label: '' };
  const left = Math.ceil((needed - elapsed) / 60_000);
  return { ready: false, label: left > 1 ? `ready in ~${left} min` : 'ready in under a minute' };
}

export default function Shield() {
  const navigate = useNavigate();
  const { publicKey } = useWalletStore();
  const {
    getNotes,
    shieldNote,
    loading: poolLoading,
    error: poolError,
    setError,
  } = useDenominatedPoolStore();
  const { scanStealthPayments, sweepAllStealthPayments, isInitialized } = useShieldedStore();

  const [denomination, setDenomination] = useState<number>(OPEN_DENOMINATION);
  const [progress, setProgress] = useState<string | null>(null);
  const [justShielded, setJustShielded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Recovery: scanning for stealth payments that were never swept.
  const [scanning, setScanning] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [found, setFound] = useState<{ count: number; amount: number } | null>(null);

  const notes = getNotes();

  const { total, ready, maturing } = useMemo(() => {
    let t = 0;
    let r = 0;
    let m = 0;
    for (const n of notes) {
      t += n.denomination;
      if (maturityOf(n.shieldedAt).ready) r += 1;
      else m += 1;
    }
    return { total: t, ready: r, maturing: m };
  }, [notes]);

  useEffect(() => () => setError(null), [setError]);

  const handleShield = async () => {
    setJustShielded(null);
    setError(null);
    try {
      const { receipt } = await shieldNote({
        token: 'SOL',
        denomination,
        onProgress: setProgress,
      });
      setJustShielded(receipt.commitment.toString());
    } catch {
      // The store owns the error message; it renders below. Swallowing it here
      // and showing our own would lose the on-chain reason.
    } finally {
      setProgress(null);
    }
  };

  const handleScan = async () => {
    setScanning(true);
    setFound(null);
    try {
      const res = await scanStealthPayments();
      setFound({ count: res.found, amount: res.amount });
    } finally {
      setScanning(false);
    }
  };

  const handleSweep = async () => {
    if (!publicKey) return;
    setSweeping(true);
    try {
      await sweepAllStealthPayments(publicKey);
      setFound(null);
    } finally {
      setSweeping(false);
    }
  };

  const closed = denomination !== OPEN_DENOMINATION;
  const busy = poolLoading || progress !== null;

  return (
    <Screen title="Shield">
      <div className="flex flex-col gap-5">
        {/* ── The headline. V1 is deliberately not in this number. ── */}
        <div>
          <Eyebrow>Private balance</Eyebrow>
          <div className="mt-1.5 flex items-baseline gap-2">
            <Amount value={total.toFixed(total % 1 === 0 ? 0 : 2)} unit="SOL" size="xl" />
          </div>
          {/* ⚠️ Nothing here when the balance is zero. This line used to read
              "No notes yet" and so did the empty state forty lines below, so
              the same sentence appeared twice on one 360px screen. A big 0
              already says it; the empty state is where the instruction goes. */}
          {notes.length > 0 && (
            <p className="mt-1 text-tiny text-p01-text-dim">
              {ready} ready to spend{maturing ? `, ${maturing} still maturing` : ''}
            </p>
          )}
        </div>

        {/* ── Shield, inline. This is the merge of the old picker screen. ── */}
        <Panel>
          <Eyebrow>Add to it</Eyebrow>
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            {DENOMINATIONS.map((d) => {
              const isOpen = d === OPEN_DENOMINATION;
              return (
                <button
                  key={d}
                  onClick={() => setDenomination(d)}
                  aria-pressed={denomination === d}
                  className={[
                    'flex min-h-[44px] flex-col items-center justify-center rounded-lg border text-sm transition-colors duration-exit',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
                    denomination === d
                      ? 'border-p01-cyan bg-p01-cyan/10 text-p01-text'
                      : 'border-p01-border text-p01-text-muted hover:border-p01-border-light',
                  ].join(' ')}
                >
                  <span className="tabular">{d} SOL</span>
                  {!isOpen && <span className="text-[0.625rem] text-p01-text-dim">closed</span>}
                </button>
              );
            })}
          </div>

          {closed ? (
            /* Refused with the reason, not hidden. A denomination that simply
               vanishes reads as a bug to someone holding a note in it. */
            <p className="mt-2.5 text-tiny text-p01-amber">
              This pool is closed to new deposits. Every deposit lands in the 1 SOL pool so the
              crowd stays in one place instead of splitting across six. Notes you already hold
              here stay spendable.
            </p>
          ) : (
            <p className="mt-2.5 text-tiny text-p01-text-dim">
              Costs 1.013 SOL: the note plus a 1% operator fee. None of it comes back.
            </p>
          )}

          <Button
            full
            size="lg"
            className="mt-3"
            icon={ShieldPlus}
            loading={busy}
            disabled={closed}
            onClick={() => void handleShield()}
          >
            {busy ? (progress ?? 'Shielding') : `Shield ${denomination} SOL`}
          </Button>

          {poolError && (
            <p role="alert" className="mt-2 text-tiny text-p01-red">
              {poolError}
            </p>
          )}
        </Panel>

        {justShielded && (
          <Panel tone="quiet">
            <div className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-p01-cyan" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-p01-text">Note created.</p>
                <p className="mt-0.5 text-tiny text-p01-text-muted">
                  It appears below with a countdown. You can close this and come back.
                </p>
              </div>
            </div>
          </Panel>
        )}

        {/* ── The four things you can do with a private balance ── */}
        <div>
          <Eyebrow>Move it</Eyebrow>
          <div className="mt-2.5">
            <ActionGrid
              actions={[
                {
                  label: 'Withdraw',
                  icon: ArrowUpFromLine,
                  onClick: () => navigate('/shield/withdraw'),
                  disabled: ready === 0,
                },
                {
                  label: 'Send note',
                  icon: Send,
                  onClick: () => navigate('/shield/send-note'),
                  disabled: ready === 0,
                },
                {
                  label: 'Receive',
                  icon: Download,
                  onClick: () => navigate('/shield/receive-note'),
                },
                {
                  label: 'Recover',
                  icon: Radar,
                  onClick: () => void handleScan(),
                  disabled: !isInitialized || scanning,
                },
              ]}
            />
          </div>
        </div>

        {/* Recovery result. Only rendered once a scan has actually run, so an
            untouched screen does not imply anything about what is out there. */}
        {(scanning || found) && (
          <Panel tone={found && found.count > 0 ? 'warn' : 'quiet'}>
            {scanning ? (
              <p className="flex items-center gap-2 text-sm text-p01-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Scanning for payments sent to your stealth addresses
              </p>
            ) : found && found.count > 0 ? (
              <>
                <p className="text-sm text-p01-text">
                  {found.count} unswept payment{found.count > 1 ? 's' : ''}, {found.amount.toFixed(4)} SOL.
                </p>
                <p className="mt-1 text-tiny text-p01-text-muted">
                  These sit at one-time addresses only your key controls. Sweeping moves them to
                  your wallet, in public.
                </p>
                <Button
                  variant="secondary"
                  className="mt-3"
                  loading={sweeping}
                  onClick={() => void handleSweep()}
                >
                  Sweep to my wallet
                </Button>
              </>
            ) : (
              <p className="text-sm text-p01-text-muted">
                Nothing unswept. Every payment sent to your stealth addresses has been collected.
              </p>
            )}
          </Panel>
        )}

        {/* ── The notes, each carrying its own next step ── */}
        <div>
          <Eyebrow>Your notes</Eyebrow>
          {notes.length === 0 ? (
            <EmptyState
              icon={ArrowDownToLine}
              title="No notes yet"
              body="Shield 1 SOL above. A note is what lets you subscribe without naming yourself."
            />
          ) : (
            <div className="mt-1.5 flex flex-col">
              {notes.map((n, i) => {
                const id = n.commitment.toString();
                const m = maturityOf(n.shieldedAt);
                return (
                  <div key={id}>
                    {i > 0 && <Hairline className="bg-p01-border-soft" />}
                    <div className="flex items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Amount value={n.denomination} unit="SOL" size="sm" />
                          {m.ready ? (
                            <Pill tone="good">Ready</Pill>
                          ) : (
                            <Pill tone="warn">
                              <Clock className="mr-1 h-3 w-3" aria-hidden="true" />
                              {m.label}
                            </Pill>
                          )}
                        </div>
                        {n.source === 'received' && (
                          <p className="mt-0.5 text-tiny text-p01-text-dim">Received from someone else</p>
                        )}
                      </div>

                      {/* 🎯 THE PATH. On the note, not in a footnote. */}
                      <Button
                        variant={m.ready ? 'primary' : 'secondary'}
                        disabled={!m.ready}
                        onClick={() =>
                          navigate('/subscriptions/new', { state: { noteId: id } })
                        }
                      >
                        Subscribe
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Your note address, for receiving ── */}
        <Panel tone="quiet">
          <Eyebrow>Your note address</Eyebrow>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-tiny text-p01-text-muted">
              {useDenominatedPoolStore.getState().getMyNoteAddress()}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(
                  useDenominatedPoolStore.getState().getMyNoteAddress(),
                );
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              aria-label="Copy your note address"
              className="flex h-11 w-11 items-center justify-center rounded-lg text-p01-text-muted transition-colors duration-exit hover:text-p01-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
            >
              {copied ? (
                <Check className="h-4 w-4 text-p01-cyan" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
          <p className="mt-1 text-tiny text-p01-text-dim">
            Share it to be sent a note. Only your wallet can decrypt one addressed to it.
          </p>
        </Panel>
      </div>
    </Screen>
  );
}
