"use client";

/**
 * NoteTag: the name a note is shown by on every pay screen (UI-1, ledger row
 * D14). A colour dot and `XXXX-XXXX`, computed in the worker from the note's
 * SECRETS (`lib/privacy/pool/noteTag.ts`, pinned by `noteTag.test.ts`), so it
 * names the note to its holder and to nobody reading the chain.
 *
 * It replaced `leaf #N · <commitment prefix>` on the Shield, Send, Receive and
 * Subscribe screens. Both of those are published by the deposit that created
 * the leaf, so a screenshot, a screen share or a support ticket handed the
 * reader the row of the chain that names who deposited and when
 * (`__tests__/components/PoolPanel.test.tsx` and its siblings render the
 * panels with a canary leaf and commitment and assert neither appears).
 *
 * It renders NOTHING for a value that is not a tag. A regression that fed a
 * leaf number, a commitment prefix or any other string into `tag.text` must not
 * reach the screen through the component that exists to replace them
 * ("shows nothing for a value that is not a tag", PoolPanel.test.tsx). A note
 * from a worker older than the tag (no `tag` field) shows its amount alone.
 */

import type { NoteTag as NoteTagValue } from "@/lib/privacy/pool/noteTag";

/** Crockford base32, grouped as the scheme writes it. */
const TAG_TEXT = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const TAG_COLOR = /^#[0-9a-f]{6}$/i;

export default function NoteTag({
  tag,
  className,
}: {
  tag?: NoteTagValue | null;
  className?: string;
}) {
  if (!tag || !TAG_TEXT.test(tag.text) || !TAG_COLOR.test(tag.color)) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-xs text-p01-text-dim${
        className ? ` ${className}` : ""
      }`}
    >
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: tag.color }}
      />
      {tag.text}
    </span>
  );
}
