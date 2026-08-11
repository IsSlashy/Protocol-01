import { Newsreader } from "next/font/google";

/**
 * The one serif voice of Styx Protocol, loaded exactly once for the whole site.
 *
 * Newsreader is a variable face and the weight axis is the point of it: display
 * lines run light (300), section titles sit at 400, and small serif goes 500 so
 * it does not turn spindly at 1.4rem. Direction A originally shipped Instrument
 * Serif, which offers a single 400 and could do none of that.
 *
 * Body copy stays on Inter and evidence on JetBrains Mono; both are already
 * loaded by the root layout, so this module adds one font to the page, not four.
 */
export const styxSerif = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--styx-serif-font",
});
