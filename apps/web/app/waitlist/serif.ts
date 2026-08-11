import type { CSSProperties } from "react";

/**
 * The Styx serif voice, restored one element at a time. Delete this file the day
 * app/_styx/styx.css is fixed.
 *
 * WHY IT EXISTS, and it is not a preference. styx.css:69 opts every heading out
 * of the root stylesheet's display face with
 * `.styx :is(h1, h2, h3, h4, h5, h6) { font-family: inherit; font-weight:
 * inherit; letter-spacing: normal }`. That selector scores (0,1,1); `.styx-h1`
 * (styx.css:190), `.styx-h2` (202) and `.styx-h3` (212) score (0,1,0). So on a
 * real heading ELEMENT the reset wins and only size and line-height survive: the
 * heading renders in Inter at the inherited weight, which is the one typeface the
 * direction rules out. The identical class on a span renders Newsreader, which is
 * why app/styx-kit looks right and a page built from real headings does not.
 *
 * An inline style outranks both selectors, so the class keeps every other
 * declaration and these three come back. Nothing new is introduced: the values
 * are the ones styx.css already gives the three classes, read from the same
 * tokens. The elements stay <h1>/<h2>/<h3>, so the document outline is untouched.
 *
 * The three sibling routes in this directory each reached the same conclusion and
 * inlined their own copy of it (confirmed/page.tsx:78-88, removed/page.tsx:56,
 * invalid/InvalidResult.tsx:63-65), and app/_home/SerifHeading.tsx does the same
 * job with a span wrapper. This file is that workaround named once for the routes
 * under app/waitlist/ instead of a fifth transcription of it.
 *
 * The real fix is one edit in styx.css, narrowing the reset to the headings that
 * carry no styx- class, `.styx :is(h1,h2,h3,h4,h5,h6):not([class*="styx-"])`.
 * styx.css is shared, so it is reported upward rather than forked here.
 */
export const SERIF_DISPLAY: CSSProperties = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-display)",
  letterSpacing: "-0.022em",
};

export const SERIF_TITLE: CSSProperties = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-title)",
  letterSpacing: "-0.01em",
};

export const SERIF_SMALL: CSSProperties = {
  fontFamily: "var(--styx-serif)",
  fontWeight: "var(--styx-serif-small)",
  letterSpacing: "-0.005em",
};
