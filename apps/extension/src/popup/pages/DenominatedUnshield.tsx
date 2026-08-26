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
 *   1. The note commitment goes on-chain again ON THE v3 ROUTE ONLY, AS OF
 *      2026-08-26. It is `stark_commitment`, ix data byte 80
 *      (buildUnshieldDenominatedStarkV3Ix), the same value the deposit
 *      published, so anyone can match the two — anonymity set ONE. Confirmed on
 *      devnet: leaf 16, commitment 8901821612542787864, in both transactions.
 *      `unshield_denominated_stark_v4` (circuit 7) HAS NO SUCH FIELD, and the
 *      store now routes to it whenever the note's blinding allows. Which route
 *      a given note takes is decided by `whyCircuit7Cannot` in
 *      shared/store/denominatedPool.ts, synchronously and before any proving —
 *      which is why this screen can say it up front instead of afterwards.
 *   2. The user's own wallet signs, ON BOTH ROUTES. `createWalletSigner` hands
 *      the same wallet to `submitAndVerifyStarkProof` as the proof-buffer
 *      authority AND to the instruction as the unshield payer. 🚨 THIS IS THE
 *      SENTENCE THAT MUST NOT BE SOFTENED WHEN v4 RUNS: circuit 7 removes the
 *      commitment from the wire, it does NOT remove the depositor's signature
 *      from the withdrawal, so an observer who saw that wallet deposit into
 *      this pool still has it. The repository already recorded this shape as
 *      "v4 seul = FAUX VERT" (2026-08-16). Nothing here may imply the
 *      withdrawal is anonymous.
 *   3. The recipient field is REQUIRED now, and the wallet is refused as the
 *      payee (store, refusal 1). Blank used to mean "my own wallet", i.e. the
 *      value the store now rejects, so the hint had to move with it.
 *   4. The relayer, when it is on, hides the submission IP and the outer fee
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
import { useDenominatedPoolStore, whyCircuit7Cannot } from '@/shared/store/denominatedPool';
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

  /**
   * Which circuit this note will actually be spent on, asked BEFORE anything is
   * submitted. `whyCircuit7Cannot` is pure and synchronous — the note's
   * blinding is already in the picker — so the disclosure below is a statement
   * about what will happen, not a guess.
   */
  const c7Refusal = selectedNote ? whyCircuit7Cannot(selectedNote) : null;
  const routesToC7 = selectedNote !== undefined && c7Refusal === null;

  // Recipient is REQUIRED, and the connected wallet is not an acceptable answer:
  // the store refuses it (paying the note back to the address that funded the
  // withdrawal re-links the two by balance). Blank used to mean exactly that
  // refused value, so it cannot stay valid here — the button would enable and
  // the refusal would arrive 0 seconds later as a red error instead.
  const recipientTrimmed = recipientInput.trim();
  const recipientParses = useMemo(() => {
    if (!recipientTrimmed) return false;
    try {
      new PublicKey(recipientTrimmed);
      return true;
    } catch {
      return false;
    }
  }, [recipientTrimmed]);
  const recipientIsSelf = recipientParses && recipientTrimmed === publicKey;
  const recipientValid = recipientParses && !recipientIsSelf;

  const recipientError = !recipientTrimmed
    ? undefined // the hint already says it is required; do not shout before they type
    : !recipientParses
      ? 'Not a Solana address.'
      : recipientIsSelf
        ? 'That is the wallet paying for this withdrawal. Sending the note back to it lands the funds at the address that made the deposit.'
        : undefined;

  const busy = loading || progress !== null;
  const canSubmit = selectedNoteId !== null && recipientValid && !busy;

  const handleUnshield = async () => {
    if (!selectedNoteId || !selectedNote) return;
    setError(null);
    setProgress('Starting...');
    try {
      await unshieldNote({
        // Always sent. `undefined` still means "my own wallet" in the store, and
        // the store refuses that — the button above is what keeps it from being
        // reachable, and this line is what keeps it from being sent by accident.
        noteId: selectedNoteId,
        recipient: recipientTrimmed,
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
          error={recipientError}
          hint="Required. It cannot be this wallet: this wallet signs and pays for the withdrawal, so paying the note back to it lands the money where the deposit came from."
        />

        {/* ── What this withdrawal publishes. Two circuits, two answers, and
            the note in hand decides which — so say the true one. ── */}
        <Panel tone="warn">
          {routesToC7 ? (
            <>
              <p className="text-sm text-p01-text">
                Your wallet still signs this withdrawal.
              </p>
              <p className="mt-1 text-tiny text-p01-text-muted">
                Circuit 7 keeps the note&apos;s commitment off-chain, so this withdrawal does not
                name the deposit the way the older one did. It is not anonymous: your wallet signs
                the transaction and rents the proof buffer, so anyone who saw that wallet deposit
                into this pool still has it.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-p01-text">This withdrawal points back at your deposit.</p>
              <p className="mt-1 text-tiny text-p01-text-muted">
                This note predates commitment blinding, so it is spent on the older circuit pair,
                which writes the note&apos;s commitment on-chain again — the same value the deposit
                wrote, so anyone can match the two. Paying out to another address moves where the
                funds land, not what is published. Your wallet signs and pays.
              </p>
            </>
          )}
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
          {/* MEASURED wire sizes, not a guess: circuit 7 is 77,965 bytes against
              147,038 for the C1 + C3 pair, and the rent is rent-exemption on
              83 + proof bytes — so one buffer costs a bit over half of two. */}
          {routesToC7
            ? 'Proof rent, about 1 SOL, is held while the transaction is built and returned once it confirms — circuit 7 rents one proof buffer where the older pair rents two.'
            : 'Proof rent, about 2 SOL, is held while the transaction is built and returned once it confirms.'}
        </p>
      </div>
    </Screen>
  );
}
