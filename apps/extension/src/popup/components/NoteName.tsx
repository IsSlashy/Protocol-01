/**
 * The name a note row carries on screen: a colour dot and the note's tag.
 *
 * It replaces the leaf number (DenominatedUnshield, DenominatedTransfer) and the
 * note index with a commitment prefix (ShieldedWallet). The tag is computed from
 * the note's secrets by `shared/services/noteLabel.ts`; a note it cannot name
 * (a legacy `zk:` note) renders nothing, and the row keeps its amount only.
 *
 * Pinned by the render tests of the screens that use it
 * (`DenominatedUnshield.test.tsx`, `DenominatedTransfer.test.tsx`; the third,
 * `ShieldedWallet.test.tsx`, was deleted with its screen on 2026-09-23: the tag is
 * present, the leaf and the commitment are not, and two notes that differ only
 * in leaf, commitment and shield time render the same text).
 */

import { noteLabel, type TaggableNote } from '@/shared/services/noteLabel';
import { cn } from '@/shared/utils';

export function NoteName({ note, className }: { note: TaggableNote; className?: string }) {
  const label = noteLabel(note);
  if (!label) return null;
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono', className)}>
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: label.color }}
      />
      {label.text}
    </span>
  );
}
