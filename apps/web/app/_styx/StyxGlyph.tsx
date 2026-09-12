/**
 * StyxGlyph — one hairline drawing per module card.
 *
 * WHY. The six module cards on the landing page were a numeral, a title and a
 * paragraph of 150 to 250 characters each: six identical blocks of grey text a
 * reader scans past. A glyph gives each card a shape to recognise before the
 * sentence is read, which is the job the numerals were pretending to do.
 *
 * WHY DRAWN AND NOT AN ICON SET. Every icon library on the shelf is a rounded
 * 2px stroke with a friendly radius, and this page is hairlines, right angles
 * and one serif. Six paths cost less than a dependency and are the only way the
 * marks sit inside the same drawing as the rules around them.
 *
 * EACH GLYPH IS THE MECHANISM, not a mascot for it:
 *  pool      identical notes stacked in one set — the denomination is the point
 *  proof     a sealed square with its diagonal struck and a witness dot
 *  stealth   one origin fanning into three one-time endpoints
 *  vault     a period ring with its four ticks and one hand
 *  split     one note becoming three smaller ones
 *  registry  ledger rows, one of them marked
 *
 * The stroke is `currentColor` at 1, so a card sets the colour once and the
 * mark follows the text through hover and through both themes. aria-hidden
 * everywhere: the card's title says what the module is, and a duplicate label
 * on the drawing would make a screen reader read it twice.
 */

export type GlyphName =
  | "pool"
  | "proof"
  | "stealth"
  | "vault"
  | "split"
  | "registry";

const PATHS: Record<GlyphName, React.ReactNode> = {
  pool: (
    <>
      <rect x="6" y="21" width="28" height="13" />
      <path d="M9 21v-4h28v13h-3" />
      <path d="M12 17v-4h28v13h-3" />
      <path d="M13 27.5h14" />
    </>
  ),
  proof: (
    <>
      <rect x="8" y="8" width="24" height="24" />
      <path d="M8 32 32 8" />
      <circle cx="20" cy="20" r="3.5" />
    </>
  ),
  stealth: (
    <>
      <circle cx="8" cy="20" r="3" />
      <path d="M11 20h7l6-9h8" />
      <path d="M18 20h14" />
      <path d="M11 20h7l6 9h8" />
      <path d="M32 11h4M32 20h4M32 29h4" />
    </>
  ),
  vault: (
    <>
      <circle cx="20" cy="20" r="12" />
      <path d="M20 8v3M32 20h-3M20 32v-3M8 20h3" />
      <path d="M20 20V13" />
      <path d="M20 20l6 4" />
    </>
  ),
  split: (
    <>
      <rect x="5" y="15" width="11" height="10" />
      <path d="M16 20h5" />
      <path d="M21 20v-9h4M21 20v9h4M21 20h4" />
      <rect x="25" y="7" width="9" height="8" />
      <rect x="25" y="16" width="9" height="8" />
      <rect x="25" y="25" width="9" height="8" />
    </>
  ),
  registry: (
    <>
      <rect x="7" y="8" width="26" height="24" />
      <path d="M7 15h26" />
      <path d="M12 21h16M12 26h10" />
      <circle cx="30" cy="26" r="2.5" />
    </>
  ),
};

export default function StyxGlyph({ name }: { name: GlyphName }) {
  return (
    <svg
      className="styx-glyph"
      viewBox="0 0 40 40"
      width="40"
      height="40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
