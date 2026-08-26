/**
 * DenominatedTransfer — note-to-note transfer of a denominated note.
 * Route: /shield/send-note, reached from the Shield tab's "Send note" action.
 *
 * Spends a MATURE denominated note (C1 + C3 ownership/membership) and mints a
 * brand-new note for the recipient (C6 insertion), then hands the recipient an
 * encoded "shareable note" string out-of-band. Funds never leave the pool.
 *
 * 🚨 THE HANDOFF IS THE SCREEN, NOT A SUCCESS PAGE. This flow produces the ONLY
 * copy of the recipient's note. The recipient's note secrets are RANDOM, not
 * seed-derived: if the encoded blob is lost, the funds are unrecoverable by
 * anyone, including us. The old screen showed that blob under a tick and a
 * "Note Transferred!" headline with a Done button of equal weight to a 10px
 * "Copy" link — so the one action that had to happen was the smallest thing on
 * a page that congratulated the user for finishing. Now:
 *   - the copy action IS the primary button, full width, at the bottom;
 *   - "Done" does not exist until the blob has been copied;
 *   - going back before copying is intercepted and says what is lost.
 * Warning before leaving is a confirmation step that carries information, which
 * is the only kind this rework keeps.
 *
 * WHAT IS AND IS NOT HIDDEN — the copy on this screen must respect it:
 *   - No recipient IDENTITY is written on-chain. The transaction names an
 *     ephemeral payer and two commitments; the recipient is never an account
 *     in it, and the handoff blob travels off-chain. That part is real.
 *   - The transaction is NOT unlinkable from the sender. It republishes the
 *     spent note's commitment as `stark_commitment` (ix data byte 80,
 *     transfer_denominated_stark_v3.rs:205-211 binds it into C1), which is the
 *     same value the sender's deposit published. And it publishes the new
 *     commitment (bytes 88-120), which the recipient's eventual withdrawal will
 *     republish in turn. So deposit -> transfer -> withdrawal is a chain any
 *     observer can follow. Only the C7 spend circuit breaks it
 *     (docs/C7_SPEND_CIRCUIT_PLAN.md). ⚠️ C7 IS BUILT AND DEPLOYED as of
 *     2026-08-25 and a real v4 withdrawal landed carrying no commitment — but
 *     this surface still calls the v3 spend, so the chain above is unbroken
 *     here. The reason changed; the warning did not.
 *   - The ephemeral payer is funded by the user's wallet in a plain SystemProgram
 *     transfer immediately beforehand (shared/services/denominatedPool.ts
 *     transferDenominatedStarkV3), so the payer is one public hop from the
 *     wallet. Not signing is real; it is not anonymity.
 *
 * Proof generation (C1 + C3 + C6) takes roughly 90-180s in the browser WASM.
 * Keep the popup open throughout. The note must be matured: the on-chain
 * handler checks `current_epoch >= min_epoch + dynamic_delay`
 * (transfer_denominated_stark_v3.rs:165-173), but this client pins min_epoch to
 * 0 (TRANSFER_MIN_EPOCH) and refuses immature notes in the store pre-flight
 * instead, so the deposit epoch is never published here.
 */

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, Lock, Send } from 'lucide-react';
import { cn, copyToClipboard } from '@/shared/utils';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { isNoteEncryptionAddress } from '@/shared/services/noteCrypto';
import { Amount, Button, EmptyState, Panel, Pill, Screen } from '@/popup/ui';

export default function DenominatedTransfer() {
  const navigate = useNavigate();

  const { getNotes, transferNote, loading } = useDenominatedPoolStore();
  const notes = useMemo(() => getNotes(), [getNotes]);

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(
    notes.length === 1 ? notes[0].commitment.toString() : null,
  );
  const [recipientAddr, setRecipientAddr] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [encodedNote, setEncodedNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const selectedNote = notes.find((n) => n.commitment.toString() === selectedNoteId);
  const recipientValid = useMemo(
    () => isNoteEncryptionAddress(recipientAddr.trim()),
    [recipientAddr],
  );
  const busy = loading || progress !== null;
  const canSubmit = selectedNoteId !== null && recipientValid && !busy;

  /** What the blob is worth, for the sentence that says what is lost. */
  const sentAmount = selectedNote
    ? `${selectedNote.denominationHuman} ${selectedNote.token}`
    : 'the note';

  const handleTransfer = async () => {
    if (!selectedNoteId || !selectedNote || !recipientValid) return;
    setError(null);
    setProgress('Starting...');
    try {
      const result = await transferNote({
        noteId: selectedNoteId,
        recipientAddress: recipientAddr.trim(),
        onProgress: (step) => setProgress(step),
      });
      setEncodedNote(result.encryptedNote);
      setProgress(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    }
  };

  // ⚠️ `copied` is STICKY. Everywhere else in this extension the copied tick
  // resets after two seconds; here it also gates the Done button, and a Done
  // that disappears again on a timer would be a trap.
  const handleCopy = async () => {
    if (!encodedNote) return;
    await copyToClipboard(encodedNote);
    setCopied(true);
    setConfirmLeave(false);
  };

  /* ── The handoff. The blob exists here and nowhere else. ──────────────── */

  if (encodedNote) {
    const leave = () => navigate(-1);

    return (
      <Screen
        title="Send this to them"
        onBack={() => (copied ? leave() : setConfirmLeave(true))}
        footer={
          copied ? (
            <>
              <Button full size="lg" onClick={leave}>
                Done
              </Button>
              <Button full variant="ghost" className="mt-1" icon={Copy} onClick={() => void handleCopy()}>
                Copy again
              </Button>
            </>
          ) : (
            <Button full size="lg" icon={Copy} onClick={() => void handleCopy()}>
              Copy the encrypted note
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-4">
          {/* Interception. Only ever seen by someone about to lose the note. */}
          {confirmLeave && (
            <Panel tone="warn">
              <p role="alert" className="text-sm text-p01-text">
                You have not copied it yet. Leave now and {sentAmount} is gone — no one can
                rebuild this note, and the recipient never receives it.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <Button full icon={Copy} onClick={() => void handleCopy()}>
                  Copy it
                </Button>
                <Button variant="ghost" onClick={leave}>
                  Leave anyway
                </Button>
              </div>
            </Panel>
          )}

          <p className="text-sm text-p01-text-muted">
            {sentAmount} now sits in a note only the recipient can open. This blob is the only copy
            of it: keep it or send it, but do not close this without one of the two.
          </p>

          <div>
            <div className="flex items-center justify-between">
              <p className="text-tiny text-p01-text-muted">Encrypted note</p>
              {copied && (
                <span className="inline-flex items-center gap-1 text-tiny text-p01-cyan">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  Copied
                </span>
              )}
            </div>
            <div className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-p01-border bg-p01-dark p-3">
              <p className="break-all font-mono text-tiny leading-relaxed text-p01-text-muted">
                {encodedNote}
              </p>
            </div>
          </div>

          <p className="text-tiny text-p01-text-dim">
            Encrypted to the recipient with X25519 and ML-KEM-768, so any channel is safe to send
            it over. Their withdrawal republishes this note&apos;s commitment, which links it back
            to this transfer.
          </p>
        </div>
      </Screen>
    );
  }

  /* ── Nothing to send ──────────────────────────────────────────────────── */

  if (notes.length === 0) {
    return (
      <Screen title="Send a note" onBack={() => navigate(-1)}>
        <EmptyState
          icon={Lock}
          title="No notes to send"
          body="Shield 1 SOL first. A note has to exist before it can be handed to someone."
          action={
            <Button variant="secondary" onClick={() => navigate(-1)}>
              Back to Shield
            </Button>
          }
        />
      </Screen>
    );
  }

  /* ── The form ─────────────────────────────────────────────────────────── */

  const addrInvalid = recipientAddr.trim().length > 0 && !recipientValid;

  return (
    <Screen
      title="Send a note"
      onBack={() => navigate(-1)}
      footer={
        <>
          {error && (
            <p role="alert" className="mb-2 break-words text-tiny text-p01-red">
              {error}
            </p>
          )}
          <Button
            full
            size="lg"
            icon={Send}
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void handleTransfer()}
          >
            {busy ? (progress ?? 'Sending') : 'Send note'}
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
              <span className="flex items-center gap-2">
                <Amount value={selectedNote.denominationHuman} unit={selectedNote.token} size="sm" />
                {selectedNote.source === 'received' && <Pill>Received</Pill>}
              </span>
              <span className="font-mono text-tiny text-p01-text-dim">
                leaf {selectedNote.leafIndex}
              </span>
            </div>
          </Panel>
        ) : (
          <div>
            <p className="text-tiny text-p01-text-muted">Note</p>
            <div role="radiogroup" aria-label="Note to send" className="mt-1.5 flex flex-col gap-2">
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

        {/* ── Who gets it. Their note address, not a wallet address. ── */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="recipient-note-address" className="text-tiny text-p01-text-muted">
            Their note address
          </label>
          <textarea
            id="recipient-note-address"
            value={recipientAddr}
            onChange={(e) => {
              setRecipientAddr(e.target.value);
              setError(null);
            }}
            placeholder="p01pq:…"
            rows={3}
            spellCheck={false}
            aria-invalid={addrInvalid || undefined}
            aria-describedby={addrInvalid ? 'recipient-note-address-err' : undefined}
            className={cn(
              'w-full resize-none break-all rounded-lg border bg-p01-dark p-3 font-mono text-tiny text-p01-text',
              'outline-none transition-colors duration-exit placeholder:text-p01-text-dim',
              'focus:border-p01-cyan focus-visible:outline-none',
              addrInvalid ? 'border-p01-red' : 'border-p01-border',
            )}
          />
          {addrInvalid ? (
            <p id="recipient-note-address-err" role="alert" className="text-tiny text-p01-red">
              Not a note address. It starts with p01pq: and comes from their Receive screen.
            </p>
          ) : (
            <p className="text-tiny text-p01-text-dim">
              Ask them for it from their Receive screen. A wallet address will not work.
            </p>
          )}
        </div>

        {/* ── What lands on-chain, and what you will be holding afterwards ── */}
        <Panel tone="warn">
          <p className="text-sm text-p01-text">You will end up holding the only copy.</p>
          <p className="mt-1 text-tiny text-p01-text-muted">
            This produces one encrypted blob for the recipient. Lose it before they have it and
            nobody can rebuild it. The transfer also republishes the commitment of the note you are
            spending — the same value your deposit wrote — so it stays matchable to that deposit,
            and the ephemeral payer is funded by your wallet moments earlier, in the clear.
          </p>
        </Panel>
      </div>
    </Screen>
  );
}
