import type { CSSProperties, ReactNode } from "react";

/**
 * A semantic heading that actually renders in the Styx serif.
 *
 * WHY THIS EXISTS, and it is not a preference. Measured in the browser on
 * 2026-08-11 at 1440x900: styx.css line 69 resets
 * `.styx :is(h1, h2, h3, h4, h5, h6)` to `font-family: inherit; font-weight:
 * inherit; letter-spacing: normal` so the root stylesheet's Orbitron cannot
 * reach a Styx page. That selector scores (0,1,1) and therefore outranks
 * `.styx-h1` / `.styx-h2` / `.styx-h3` at (0,1,0), so a real
 * `<h1 className="styx-h1">` renders Inter 400 at letter-spacing normal — the
 * exact typeface the brief rules out. The identical class on a non-heading
 * element renders Newsreader at the intended weight, which is why the kit page
 * looks right and a page using real headings does not.
 *
 * styx.css is off limits from a page, so the heading keeps its semantics and the
 * serif voice moves one element inward: the class sits on a block-level span
 * inside the heading. app/waitlist/removed/page.tsx reached the same conclusion
 * independently and inlines the same wrapper; this file is that wrapper, named,
 * because this page has seventeen headings.
 *
 * The two inline rules are layout only. No colour, no font stack, no spacing
 * value of our own — every type decision still comes from styx.css. Reported
 * upward for a shared fix: raise the specificity of the three type classes (or
 * scope the Orbitron escape to bare `h1, h2, …` without the class), then delete
 * this component and put the class back on the heading.
 */
export default function SerifHeading({
  level,
  children,
  innerStyle,
}: {
  level: 1 | 2 | 3;
  children: ReactNode;
  /** Layout only, applied to the span that carries the styx-h* class. */
  innerStyle?: CSSProperties;
}) {
  const Tag = `h${level}` as "h1" | "h2" | "h3";
  return (
    <Tag style={{ margin: 0 }}>
      <span
        className={`styx-h${level}`}
        style={{ display: "block", ...innerStyle }}
      >
        {children}
      </span>
    </Tag>
  );
}
