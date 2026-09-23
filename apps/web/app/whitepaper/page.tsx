import type { Metadata } from "next";
import { findUnfilledPlaceholders } from "@/lib/whitepaper/markdown";
import {
  loadWhitepaperSource,
  pdfMatchesSource,
  PDF_PUBLIC_PATH,
  whitepaperSha256,
} from "@/lib/whitepaper/source";
import WhitepaperView from "./WhitepaperView";

/**
 * https://styx.cash/whitepaper — docs/WHITEPAPER.md, rendered at build time.
 *
 * Static on purpose: the page always shows the paper as committed at the
 * deployed commit, and never reads the file at request time. How the file gets
 * here, and why a missing file fails the build, is explained in
 * lib/whitepaper/source.ts.
 */
export const dynamic = "force-static";
export const revalidate = false;

const TITLE = "Styx white paper";
const DESCRIPTION =
  "How Styx makes private 1 SOL payments on Solana, checked on chain by a hash-based proof: what v1 hides and from whom, its known limits including a critical flaw, the internal audit, measured performance and what v2 is designed to fix. Devnet only, no external audit yet.";
const CANONICAL = "https://styx.cash/whitepaper";

export function generateMetadata(): Metadata {
  const pending = findUnfilledPlaceholders(loadWhitepaperSource()).length > 0;
  return {
    // The root layout's metadataBase is protocol-01.dev; this page is shared
    // as a styx.cash link, so its share images resolve there too.
    metadataBase: new URL("https://styx.cash"),
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: CANONICAL },
    // An unfinished paper renders only a notice: keep that out of search.
    ...(pending ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      title: TITLE,
      description: DESCRIPTION,
      url: CANONICAL,
      siteName: "Styx Protocol",
      type: "article",
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title: TITLE,
      description: DESCRIPTION,
      site: "@Styx_PQ",
    },
  };
}

export default function WhitepaperPage() {
  const source = loadWhitepaperSource();
  return (
    <WhitepaperView
      source={source}
      pdfAvailable={pdfMatchesSource(source)}
      pdfHref={PDF_PUBLIC_PATH}
      sourceSha256={whitepaperSha256(source)}
    />
  );
}
