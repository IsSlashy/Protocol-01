"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether this build found public/styx-whitepaper.pdf printed from the exact
 * docs/WHITEPAPER.md it was built with (pdfMatchesSource in ./source.ts).
 *
 * /docs is a client page and cannot read the file system, so its server layout
 * (app/docs/layout.tsx) works the answer out at build time and hands it down
 * through this context. The /docs button then says "Web page and PDF" only when
 * the white paper page itself offers the PDF; otherwise it says "Web page".
 *
 * The default is false: rendered without the layout (in a test, or if the
 * check ever fails), /docs makes no PDF claim.
 */
const WhitepaperPdfContext = createContext(false);

export function WhitepaperPdfFlag({
  available,
  children,
}: {
  available: boolean;
  children: ReactNode;
}) {
  return (
    <WhitepaperPdfContext.Provider value={available}>{children}</WhitepaperPdfContext.Provider>
  );
}

export function useWhitepaperPdfAvailable(): boolean {
  return useContext(WhitepaperPdfContext);
}
