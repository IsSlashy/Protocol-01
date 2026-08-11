import type { ReactNode } from "react";
import { styxSerif } from "./fonts";
import StyxHeader from "./StyxHeader";
import StyxFooter from "./StyxFooter";
import "./styx.css";

/**
 * StyxShell — wrap a page in this and it is a Styx page.
 *
 * Applies the `.styx` scope (which carries every token and opts headings out of
 * the root stylesheet's Orbitron), loads the serif exactly once, and renders the
 * shared header and footer.
 *
 * Usage, and this is the whole contract for a page author:
 *
 *   import StyxShell from "../_styx/StyxShell";
 *
 *   export default function Page() {
 *     return (
 *       <StyxShell>
 *         <section className="styx-container styx-hero">…</section>
 *       </StyxShell>
 *     );
 *   }
 *
 * `chrome={false}` drops the header and footer for pages that supply their own
 * frame (the admin dashboards, the standalone demo screens). The scope, tokens
 * and fonts still apply.
 */
export default function StyxShell({
  children,
  chrome = true,
  className,
}: {
  children: ReactNode;
  chrome?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`styx ${styxSerif.variable}${
        chrome ? " styx-has-chrome" : ""
      }${className ? ` ${className}` : ""}`}
    >
      <a href="#styx-content" className="styx-skip-link">
        Skip to content
      </a>
      {chrome ? <StyxHeader /> : null}
      {/* The root layout already provides the <main> landmark, so this is only a
          skip-link target, not a second landmark. */}
      <div id="styx-content">{children}</div>
      {chrome ? <StyxFooter /> : null}
    </div>
  );
}
