import { renderWhitepaperCard } from "./_og/card";

/* The X card for /whitepaper: the same image as opengraph-image.tsx, declared
   separately so X gets an explicit twitter:image instead of relying on its
   og:image fallback. */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt =
  "Styx white paper: private 1 SOL payments on Solana, checked on chain by a hash-based proof. Devnet only, no external audit yet.";

export default function Image() {
  return renderWhitepaperCard();
}
