/**
 * DenominatedUnshield — withdraw a shielded denominated note. Route: /shield/withdraw.
 *
 * Reached from the Shield tab's "Withdraw" action, so it opens as a screen with a
 * way back to that tab. Picks a note, takes a recipient (blank = own wallet),
 * then orchestrates C1 + C3 STARK proofs + the on-chain
 * unshield_denominated_stark_v3 instruction.
 *
 * 🎯 THE SUCCESS PAGE IS GONE. It used to be a full-screen card with a tick, a
 * headline and a Done button whose only effect was `navigate(-1)` — a screen
 * that existed to be dismissed. The withdrawal now returns the user to Shield,
 * where the note has left the list and the balance has dropped. That is the
 * confirmation, and it is where they were going anyway.
 *
 * WHAT THIS WITHDRAWAL PUBLISHES — the copy on this screen must respect it:
 *   1. The note commitment goes on-chain again. It is `stark_commitment`, ix
 *      data byte 80 (shared/services/denominatedPool.ts
 *      buildUnshieldDenominatedStarkV3Ix), and it is the same value the deposit
 *      published. Anyone can match this withdrawal to that deposit — the
 *      anonymity set is ONE. Confirmed on devnet: leaf 16, commitment
 *      8901821612542787864, present in both transactions. Only the C7 spend
 *      circuit changes this (docs/C7_SPEND_CIRCUIT_PLAN.md). Nothing on this
 *      screen may imply it is fixed.
 *   2. The user's own wallet signs. unshieldDenominatedStarkV3 passes
 *      `signer.publicKey` as the unshield payer AND as the proof-buffer
 *      authority (shared/services/denominatedPool.ts). The recipient field
 *      defaults to the user's own wallet, so the default is deposit and
 *      withdrawal from the same address.
 *   3. The relayer, when it is on, hides the submission IP and the outer fee
 *      payer only (signSendV3). The inner unshield is still signed by the
 *      user's key, so the inner signer stays visible on-chain.
 *
 * ⚠️ THE MODE TOGGLE IS KEPT BECAUSE IT IS AN ARGUMENT, NOT BECAUSE IT DOES
 * ANYTHING. `emergency` is passed to unshieldNote, so removing the control
 * would change a store call. On-chain both paths are byte-identical: min_epoch
 * is pinned to 0 and the V3 handler ignores it anyway
 * (unshield_denominated_stark_v3.rs:387). The screen now says that once, in one
 * line, instead of in a disclosure panel plus a second amber warning that
 * repeated it.
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpFromLine, Lock } from 'lucide-react';
import { PublicKey } from '@solana/web3.js';
import { cn } from '@/shared/utils';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { useWalletStore } from '@/shared/store/wallet';
import { Amount, Button, EmptyState, Field, Panel, Pill, Screen } from '@/popup/ui';

type Mode = 'regular' | 'emergency';

const MODES: { id: Mode; label: string }[] = [
  { id: 'regular', label: 'Regular' },
  { id: 'emergency', label: 'Emergency' },
];

export default function DenominatedUnshield() {
  const navigate = useNavigate();
  const { publicKey } = useWalletStore();

  const { getNotes, unshieldNote, loading } = useDenominatedPoolStore();
  const notes = useMemo(() => getNotes(), [getNotes]);

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(
    notes.length === 1 ? notes[0].commitment.toString() : null,
  );
  const [recipientInput, setRecipientInput] = useState('');
  const [mode, setMode] = useState<Mode>('regular');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedNote = notes.find((n) => n.commitment.toString() === selectedNoteId);

  // Validate recipient — empty = own wallet (shown as hint).
  const recipientValid = useMemo(() => {
    if (!recipientInput.trim()) return true; // default = own wallet
    try {
      new PublicKey(recipientInput.trim());
      return true;
    } catch {
      return false;
    }
  }, [recipientInput]);

  const busy = loading || progress !== null;
  const canSubmit = selectedNoteId !== null && recipientValid && !busy;

  const handleUnshield = async () => {
    if (!selectedNoteId || !selectedNote) return;
    setError(null);
    setProgress('Starting...');
    try {
      await unshieldNote({
        noteId: selectedNoteId,
        recipient: recipientInput.trim() || undefined, // undefined = own wallet
        emergency: mode === 'emergency',
        onProgress: (step) => setProgress(step),
      });
      setProgress(null);
      // Back to Shield: the note is gone from the list, the balance has moved.
      navigate(-1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    }
  };

  /* ── Nothing to withdraw ──────────────────────────────────────────────── */

  if (notes.length === 0) {
    return (
      <Screen title="Withdraw" onBack={() => navigate(-1)}>
        <EmptyState
          icon={Lock}
          title="Nothing to withdraw"
          body="Shield 1 SOL first. A note has to exist before it can leave the pool."
          action={
            <Button variant="secondary" onClick={() => navigate(-1)}>
              Back to Shield
            </Button>
          }
        />
      </Screen>
    );
  }

  return (
    <Screen
      title="Withdraw"
      onBack={() => navigate(-1)}
      footer={
        <>
          {/* The submit error sits with the control that produced it, not in a
              banner at the top of a screen the user has already scrolled past. */}
          {error && (
            <p role="alert" className="mb-2 break-words text-tiny text-p01-red">
              {error}
            </p>
          )}
          <Button
            full
            size="lg"
            icon={ArrowUpFromLine}
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void handleUnshield()}
          >
            {busy
              ? (progress ?? 'Withdrawing')
              : selectedNote
                ? `Withdraw ${selectedNote.denominationHuman} ${selectedNote.token}`
                : 'Withdraw'}
          </Button>
          <p className="mt-2 text-center text-tiny text-p01-text-dim">
            Proving takes 2 to 3 minutes. Keep this popup open.
          </p>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* ── Which note ── */}
        {notes.length === 1 && selectedNote ? (
          <Panel tone="quiet">
            <div className="flex items-center justify-between gap-3">
              <Amount value={selectedNote.denominationHuman} unit={selectedNote.token} size="sm" />
              <span className="font-mono text-tiny text-p01-text-dim">
                leaf {selectedNote.leafIndex}
              </span>
            </div>
          </Panel>
        ) : (
          <div>
            <p className="text-tiny text-p01-text-muted">Note</p>
            <div role="radiogroup" aria-label="Note to withdraw" className="mt-1.5 flex flex-col gap-2">
              {notes.map((note) => {
                const id = note.commitment.toString();
                const selected = id === selectedNoteId;
                return (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setSelectedNoteId(id)}
                    className={cn(
                      'flex min-h-[52px] w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left',
                      'transition-colors duration-exit',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
                      selected
                        ? 'border-p01-cyan bg-p01-cyan/10'
                        : 'border-p01-border hover:border-p01-border-light',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Amount value={note.denominationHuman} unit={note.token} size="sm" />
                      {note.source === 'received' && <Pill>Received</Pill>}
                    </span>
                    <span className="shrink-0 font-mono text-tiny text-p01-text-dim">
                      leaf {note.leafIndex}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Where it lands ── */}
        <Field
          label="Send to"
          value={recipientInput}
          onChange={(e) => setRecipientInput(e.target.value)}
          placeholder={publicKey ? `${publicKey.slice(0, 8)}… (your wallet)` : 'Solana address'}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          error={!recipientValid && recipientInput ? 'Not a Solana address.' : undefined}
          hint="Leave blank to send to your own wallet — the wallet that signs this and made the deposit."
        />

        {/* ── The one thing a withdrawal cannot hide ── */}
        <Panel tone="warn">
          <p className="text-sm text-p01-text">This withdrawal points back at your deposit.</p>
          <p className="mt-1 text-tiny text-p01-text-muted">
            It writes the note&apos;s commitment on-chain again — the same value the deposit wrote —
            so anyone can match the two. Paying out to another address moves where the funds land,
            not what is published. Your wallet signs and pays.
          </p>
        </Panel>

        {/* ── Mode. An argument, and the screen says what it is worth. ── */}
        <div>
          <p className="text-tiny text-p01-text-muted">Mode</p>
          <div role="radiogroup" aria-label="Withdrawal mode" className="mt-1.5 grid grid-cols-2 gap-2">
            {MODES.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={mode === m.id}
                onClick={() => setMode(m.id)}
                className={cn(
                  'min-h-[44px] rounded-lg border text-sm transition-colors duration-exit',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
                  mode === m.id
                    ? 'border-p01-cyan bg-p01-cyan/10 text-p01-text'
                    : 'border-p01-border text-p01-text-muted hover:border-p01-border-light',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-tiny text-p01-text-dim">
            Both send the same transaction, byte for byte. Emergency is a label for your own
            records; nothing on-chain reads it, and neither mode waits for the note to age.
          </p>
        </div>

        <p className="text-tiny text-p01-text-dim">
          Proof rent, about 2 SOL, is held while the transaction is built and returned once it
          confirms.
        </p>
      </div>
    </Screen>
  );
}
